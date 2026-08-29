#!/usr/bin/env python3
"""Serve the conversation search index over HTTP.

  GET /api/health            -> service status
  GET /api/search?q=...      -> FTS5 search with facets
  GET /api/conversation/:id  -> indexed conversation timeline
  GET /api/stats             -> aggregate index statistics
  GET /api/facets            -> available filter values

Stdlib only. Reads search.db built by indexer.py.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

DEFAULT_DB = os.path.expanduser("~/.openhands/agent-canvas/search.db")
DEFAULT_PORT = 8765

# characters that must be escaped for FTS5 MATCH
_FTS_SPECIAL = re.compile(r'(["\*\(\)\s])')


def _sanitize_fts(q: str) -> str:
    """Turn a free-text query into a safe FTS5 MATCH expression.

    Bare words get a prefix-* wildcard so partial matches work; quoted phrases
    are preserved. Operators the user didn't intend are stripped.
    """
    q = (q or "").strip()
    if not q:
        return ""
    # respect explicit quotes, split the rest into terms
    parts = []
    for token in re.findall(r'"[^"]*"|\S+', q):
        if token.startswith('"'):
            parts.append(token)
        else:
            clean = _FTS_SPECIAL.sub(" ", token).strip()
            if clean:
                parts.append(f"{clean}*")
    return " ".join(parts)


def _row_to_conv(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "title": r["title"],
        "model": r["model"],
        "status": r["status"],
        "created_at": r["created_at"],
        "updated_at": r["updated_at"],
        "workspace_dir": r["workspace_dir"],
        "tags": json.loads(r["tags_json"]) if r["tags_json"] else {},
        "n_events": r["n_events"],
        "n_user_msgs": r["n_user_msgs"],
        "n_assistant_msgs": r["n_assistant_msgs"],
        "n_actions": r["n_actions"],
        "n_observations": r["n_observations"],
        "prompt_tokens": r["prompt_tokens"],
        "completion_tokens": r["completion_tokens"],
        "cost": r["cost"],
    }


class SearchAPI:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._local = threading.local()

    @property
    def conn(self) -> sqlite3.Connection:
        c = getattr(self._local, "conn", None)
        if c is None:
            c = sqlite3.connect(self.db_path, check_same_thread=False)
            c.row_factory = sqlite3.Row
            self._local.conn = c
        return c

    # -- endpoints -------------------------------------------------------

    def stats(self) -> dict:
        c = self.conn
        n_convs = c.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
        n_events = c.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        toks = c.execute(
            "SELECT COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), "
            "COALESCE(SUM(cost),0) FROM conversations"
        ).fetchone()
        models = [dict(r) for r in c.execute(
            "SELECT model as key, COUNT(*) as count FROM conversations "
            "GROUP BY model ORDER BY count DESC")]
        statuses = [dict(r) for r in c.execute(
            "SELECT status as key, COUNT(*) as count FROM conversations "
            "GROUP BY status ORDER BY count DESC")]
        tools = [dict(r) for r in c.execute(
            "SELECT tool_name as key, COUNT(*) as count FROM events "
            "WHERE tool_name IS NOT NULL GROUP BY tool_name ORDER BY count DESC")]
        date_range = c.execute(
            "SELECT MIN(created_at), MAX(created_at) FROM conversations"
        ).fetchone()
        return {
            "conversations": n_convs,
            "events": n_events,
            "prompt_tokens": toks[0],
            "completion_tokens": toks[1],
            "cost": toks[2],
            "models": models,
            "statuses": statuses,
            "tools": tools,
            "date_range": {"min": date_range[0], "max": date_range[1]},
        }

    def facets(self) -> dict:
        c = self.conn
        models = [r["model"] for r in c.execute(
            "SELECT DISTINCT model FROM conversations WHERE model IS NOT NULL ORDER BY model")]
        statuses = [r["status"] for r in c.execute(
            "SELECT DISTINCT status FROM conversations WHERE status IS NOT NULL ORDER BY status")]
        tools = [r["tool_name"] for r in c.execute(
            "SELECT DISTINCT tool_name FROM events WHERE tool_name IS NOT NULL ORDER BY tool_name")]
        kinds = [r["kind"] for r in c.execute(
            "SELECT DISTINCT kind FROM events WHERE kind IS NOT NULL ORDER BY kind")]
        tags = set()
        for (tj,) in c.execute("SELECT tags_json FROM conversations WHERE tags_json IS NOT NULL"):
            try:
                for k in json.loads(tj):
                    tags.add(k)
            except Exception:
                pass
        return {
            "models": models,
            "statuses": statuses,
            "tools": sorted(tools),
            "kinds": kinds,
            "tags": sorted(tags),
        }

    def search(self, params: dict) -> dict:
        q = (params.get("q", [""])[0] or "").strip()
        model = (params.get("model", [None])[0] or "").strip() or None
        status = (params.get("status", [None])[0] or "").strip() or None
        tool = (params.get("tool", [None])[0] or "").strip() or None
        kind = (params.get("kind", [None])[0] or "").strip() or None
        role = (params.get("role", [None])[0] or "").strip() or None
        after = (params.get("after", [None])[0] or "").strip() or None
        before = (params.get("before", [None])[0] or "").strip() or None
        try:
            limit = min(int(params.get("limit", ["50"])[0]), 500)
        except ValueError:
            limit = 50
        try:
            offset = max(int(params.get("offset", ["0"])[0]), 0)
        except ValueError:
            offset = 0

        c = self.conn
        fts_expr = _sanitize_fts(q)

        conv_wheres = []
        conv_args: list = []
        if model:
            conv_wheres.append("c.model = ?")
            conv_args.append(model)
        if status:
            conv_wheres.append("c.status = ?")
            conv_args.append(status)
        if after:
            conv_wheres.append("c.updated_at >= ?")
            conv_args.append(after)
        if before:
            conv_wheres.append("c.updated_at <= ?")
            conv_args.append(before)

        # If no FTS query, list conversations directly (faceted browse).
        # Event facets use EXISTS so each conversation appears only once.
        if not fts_expr:
            browse_wheres = list(conv_wheres)
            browse_args = list(conv_args)
            event_wheres = []
            if tool:
                event_wheres.append("e.tool_name = ?")
                browse_args.append(tool)
            if kind:
                event_wheres.append("e.kind = ?")
                browse_args.append(kind)
            if role:
                event_wheres.append("e.role = ?")
                browse_args.append(role)
            if event_wheres:
                browse_wheres.append(
                    "EXISTS (SELECT 1 FROM events e WHERE e.conversation_id = c.id AND "
                    + " AND ".join(event_wheres) + ")"
                )

            where_sql = " WHERE " + " AND ".join(browse_wheres) if browse_wheres else ""
            total = c.execute(
                f"SELECT COUNT(*) FROM conversations c{where_sql}", browse_args
            ).fetchone()[0]
            rows = c.execute(
                f"SELECT c.* FROM conversations c{where_sql} "
                "ORDER BY c.updated_at DESC, c.created_at DESC LIMIT ? OFFSET ?",
                browse_args + [limit, offset]
            ).fetchall()
            return {
                "query": q, "total": total, "limit": limit, "offset": offset,
                "mode": "browse", "sort": "updated_at", "order": "desc",
                "conversations": [_row_to_conv(r) for r in rows],
            }

        # FTS path: join events_fts -> events -> conversations
        sql = (
            "SELECT e.rowid, e.conversation_id, e.seq, e.kind, e.source, e.timestamp, "
            "e.role, e.tool_name, e.text, bm25(events_fts) as rank, "
            "c.title, c.model, c.status, c.created_at, c.updated_at, "
            "c.n_events, c.n_user_msgs, c.n_assistant_msgs, c.cost "
            "FROM events_fts JOIN events e ON e.rowid = events_fts.rowid "
            "JOIN conversations c ON c.id = e.conversation_id"
        )
        where_sql = " WHERE events_fts MATCH ?"
        where_args: list = [fts_expr]
        if tool:
            where_sql += " AND e.tool_name = ?"; where_args.append(tool)
        if kind:
            where_sql += " AND e.kind = ?"; where_args.append(kind)
        if role:
            where_sql += " AND e.role = ?"; where_args.append(role)
        if conv_wheres:
            where_sql += " AND " + " AND ".join(conv_wheres)
            where_args += conv_args

        total = c.execute(
            "SELECT COUNT(*) FROM events_fts JOIN events e ON e.rowid = events_fts.rowid "
            "JOIN conversations c ON c.id = e.conversation_id" + where_sql,
            where_args
        ).fetchone()[0]

        rows = c.execute(
            sql + where_sql + " ORDER BY rank LIMIT ? OFFSET ?",
            where_args + [limit, offset]
        ).fetchall()

        # build snippets with highlight() around the matched terms
        snip_sql = (
            "SELECT highlight(events_fts, 0, '⟦', '⟧') "
            "FROM events_fts WHERE rowid = ?"
        )
        hits = []
        for r in rows:
            snippet = c.execute(snip_sql, (r["rowid"],)).fetchone()[0]
            # trim long snippets around the first highlight
            if "⟦" in snippet:
                idx = snippet.index("⟦")
                start = max(0, idx - 120)
                end = min(len(snippet), idx + 240)
                snippet = ("…" if start > 0 else "") + snippet[start:end] + ("…" if end < len(snippet) else "")
            hits.append({
                "conversation_id": r["conversation_id"],
                "seq": r["seq"],
                "kind": r["kind"],
                "role": r["role"],
                "tool_name": r["tool_name"],
                "timestamp": r["timestamp"],
                "snippet": snippet,
                "rank": r["rank"],
                "title": r["title"],
                "model": r["model"],
                "status": r["status"],
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
                "n_events": r["n_events"],
                "n_user_msgs": r["n_user_msgs"],
                "n_assistant_msgs": r["n_assistant_msgs"],
                "cost": r["cost"],
            })
        return {
            "query": q, "total": total, "limit": limit, "offset": offset,
            "mode": "search", "hits": hits,
        }

    def conversation(self, cid: str) -> dict:
        c = self.conn
        r = c.execute("SELECT * FROM conversations WHERE id = ?", (cid,)).fetchone()
        if not r:
            return None
        conv = _row_to_conv(r)
        events = []
        for e in c.execute(
            "SELECT seq, event_id, kind, source, timestamp, role, tool_name, text "
            "FROM events WHERE conversation_id = ? ORDER BY seq", (cid,)
        ):
            text = e["text"] or ""
            events.append({
                "seq": e["seq"], "kind": e["kind"], "source": e["source"],
                "timestamp": e["timestamp"], "role": e["role"],
                "tool_name": e["tool_name"],
                "text": text[:5000],  # cap for the detail panel
                "truncated": len(text) > 5000,
            })
        conv["events"] = events
        return conv


class Handler(BaseHTTPRequestHandler):
    api: SearchAPI = None  # set by main()

    def log_message(self, *a):
        pass  # quiet

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        params = parse_qs(parsed.query)

        if path == "/" or path == "/api/health":
            self._json({"status": "ok", "service": "agent-canvas-conversation-search"})
        elif path == "/api/stats":
            self._json(self.api.stats())
        elif path == "/api/facets":
            self._json(self.api.facets())
        elif path == "/api/search":
            self._json(self.api.search(params))
        elif path.startswith("/api/conversation/"):
            cid = unquote(path[len("/api/conversation/"):])
            conv = self.api.conversation(cid)
            if conv is None:
                self._json({"error": "not found"}, 404)
            else:
                self._json(conv)
        else:
            self.send_error(404)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    if not Path(args.db).exists():
        print(f"database not found: {args.db}\nRun indexer.py first.", file=sys.stderr)
        sys.exit(1)

    Handler.api = SearchAPI(args.db)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Conversation search on http://localhost:{args.port}")
    print(f"  db: {args.db}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
