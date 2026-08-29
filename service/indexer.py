#!/usr/bin/env python3
"""Build a SQLite + FTS5 search index over Agent Canvas conversations.

Reads the on-disk persistence directory written by Agent Canvas:
  ~/.openhands/agent-canvas/dev_conversations/<id>/
    meta.json
    events/event-NNNNN-<uuid>.json

Produces search.db with:
  conversations(id, title, model, status, created_at, updated_at,
                workspace_dir, tags_json, n_events, n_user_msgs, n_assistant_msgs,
                n_actions, n_observations, prompt_tokens, completion_tokens,
                cost, first_text, last_text, indexed_at)
  events(rowid, conversation_id, seq, event_id, kind, source, timestamp,
         role, tool_name, text)
  events_fts(FTS5 virtual table over text, content=events)
  index_state(path, mtime, size, indexed_at)

Incremental: only (re)reads conversation dirs whose meta.json mtime changed.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

DEFAULT_PERSIST = os.path.expanduser(
    "~/.openhands/agent-canvas/dev_conversations"
)
DEFAULT_DB = os.path.expanduser("~/.openhands/agent-canvas/search.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    model TEXT,
    status TEXT,
    created_at TEXT,
    updated_at TEXT,
    workspace_dir TEXT,
    tags_json TEXT,
    n_events INTEGER,
    n_user_msgs INTEGER,
    n_assistant_msgs INTEGER,
    n_actions INTEGER,
    n_observations INTEGER,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    cost REAL,
    first_text TEXT,
    last_text TEXT,
    dir_mtime REAL,
    indexed_at REAL
);

CREATE TABLE IF NOT EXISTS events (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT,
    seq INTEGER,
    event_id TEXT,
    kind TEXT,
    source TEXT,
    timestamp TEXT,
    role TEXT,
    tool_name TEXT,
    text TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_conv ON events(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_tool ON events(tool_name) WHERE tool_name IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    text,
    content='events',
    content_rowid='rowid',
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, text) VALUES('delete', old.rowid, old.text);
    INSERT INTO events_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS index_state (
    path TEXT PRIMARY KEY,
    mtime REAL,
    size INTEGER,
    indexed_at REAL
);
"""


def _text_from_content(content) -> str:
    """Join the text parts of an llm_message content array."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts = []
    for block in content:
        if isinstance(block, dict):
            t = block.get("text")
            if t:
                parts.append(t)
            for k in ("input", "arguments", "content"):
                v = block.get(k)
                if isinstance(v, str) and v:
                    parts.append(v)
                elif isinstance(v, (dict, list)):
                    s = json.dumps(v, ensure_ascii=False)
                    if s and s != "null":
                        parts.append(s)
        elif isinstance(block, str):
            parts.append(block)
    return "\n".join(parts)


def _extract_event_text(d: dict) -> tuple[str, str, str]:
    """Return (role, tool_name, text) for an event dict."""
    kind = d.get("kind", "")
    tool_name = None
    text_parts: list[str] = []

    if kind == "MessageEvent":
        lm = d.get("llm_message") or {}
        role = lm.get("role") or d.get("source") or ""
        text_parts.append(_text_from_content(lm.get("content")))
        return role, None, "\n".join(p for p in text_parts if p)

    if kind == "ActionEvent":
        role = "assistant"
        for t in (d.get("thought") or []):
            text_parts.append(_text_from_content([t]) if isinstance(t, dict) else str(t))
        if d.get("reasoning_content"):
            text_parts.append(d["reasoning_content"])
        action = d.get("action")
        if isinstance(action, dict):
            tool_name = action.get("name") or action.get("action") or action.get("tool")
            args = action.get("args") or action.get("arguments") or {}
            if isinstance(args, dict):
                for k in ("command", "path", "content", "query", "url", "text", "old_str", "new_str"):
                    v = args.get(k)
                    if v:
                        text_parts.append(f"{k}: {v}" if not str(v).startswith(k) else str(v))
                text_parts.append(json.dumps(args, ensure_ascii=False))
        return role, tool_name, "\n".join(p for p in text_parts if p)

    if kind == "ObservationEvent":
        role = "tool"
        tool_name = d.get("tool_name")
        obs = d.get("observation") or {}
        text_parts.append(_text_from_content(obs.get("content")))
        extras = obs.get("extras") or {}
        if isinstance(extras, dict):
            for k in ("exit_code", "command", "path", "error", "success"):
                v = extras.get(k)
                if v is not None and str(v):
                    text_parts.append(f"{k}: {v}")
        return role, tool_name, "\n".join(p for p in text_parts if p)

    if kind == "SystemPromptEvent":
        sp = d.get("system_prompt") or {}
        return "system", None, (sp.get("text") or "")

    if kind == "ConversationStateUpdateEvent":
        return "state", None, ""

    return d.get("source") or "", None, ""


def _conv_stats(d: dict):
    """Pull status + token stats from ConversationStateUpdateEvent on disk.

    On-disk shape: {kind: ConversationStateUpdateEvent, key: "stats"|"execution_status", value: ...}
    - key="execution_status" -> value is a string
    - key="stats" -> value.usage_to_metrics.default.accumulated_token_usage / accumulated_cost
    """
    key = d.get("key")
    val = d.get("value")
    if key == "execution_status":
        return (val if isinstance(val, str) else None), None, None, None
    if key == "stats" and isinstance(val, dict):
        default = (val.get("usage_to_metrics") or {}).get("default") or {}
        acc = default.get("accumulated_token_usage") or {}
        return None, acc.get("prompt_tokens"), acc.get("completion_tokens"), default.get("accumulated_cost")
    return None, None, None, None


def _read_meta(conv_dir: Path) -> dict | None:
    p = conv_dir / "meta.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception as e:
        print(f"  ! bad meta {p}: {e}", file=sys.stderr)
        return None


def _hyphenate_uuid(raw: str) -> str:
    """Normalize a 32-char hex id to 8-4-4-4-12 hyphenated UUID form.

    Agent Canvas URLs use the hyphenated form, while meta.json may store the
    same UUID without hyphens. Normalizing at index time makes deep-links work.
    """
    s = (raw or "").replace("-", "")
    if len(s) == 32 and all(c in "0123456789abcdefABCDEF" for c in s):
        return f"{s[0:8]}-{s[8:12]}-{s[12:16]}-{s[16:20]}-{s[20:32]}"
    return raw


def _iter_events(conv_dir: Path):
    for ef in sorted(glob.glob(str(conv_dir / "events" / "event-*.json"))):
        try:
            yield json.loads(Path(ef).read_text())
        except Exception as e:
            print(f"  ! bad event {ef}: {e}", file=sys.stderr)


def index_conversation(conn: sqlite3.Connection, conv_dir: Path, meta: dict):
    raw_id = meta.get("id") or meta.get("conversation_id") or conv_dir.name
    cid = _hyphenate_uuid(raw_id)
    conn.execute("DELETE FROM events WHERE conversation_id = ?", (cid,))
    conn.execute("DELETE FROM conversations WHERE id = ?", (cid,))

    counts = dict(n_events=0, n_user_msgs=0, n_assistant_msgs=0,
                  n_actions=0, n_observations=0)
    first_text = None
    last_text = None
    status = None
    prompt_tokens = completion_tokens = None
    cost = None
    seq = 0

    for d in _iter_events(conv_dir):
        seq += 1
        counts["n_events"] += 1
        kind = d.get("kind", "")
        role, tool_name, text = _extract_event_text(d)
        if kind == "MessageEvent":
            if role == "user":
                counts["n_user_msgs"] += 1
            else:
                counts["n_assistant_msgs"] += 1
        elif kind == "ActionEvent":
            counts["n_actions"] += 1
        elif kind == "ObservationEvent":
            counts["n_observations"] += 1
        elif kind == "ConversationStateUpdateEvent":
            s, pt, ct, c = _conv_stats(d)
            if s is not None:
                status = s
            if pt is not None:
                prompt_tokens, completion_tokens, cost = pt, ct, c
            continue

        if text:
            if first_text is None:
                first_text = text[:200]
            last_text = text[-200:]
            conn.execute(
                "INSERT INTO events (conversation_id, seq, event_id, kind, source, "
                "timestamp, role, tool_name, text) VALUES (?,?,?,?,?,?,?,?,?)",
                (cid, seq, d.get("id"), kind, d.get("source"),
                 d.get("timestamp"), role, tool_name, text),
            )

    agent = meta.get("agent") or {}
    llm = agent.get("llm") or {}
    workspace = meta.get("workspace") or {}
    conn.execute(
        "INSERT OR REPLACE INTO conversations (id, title, model, status, created_at, "
        "updated_at, workspace_dir, tags_json, n_events, n_user_msgs, n_assistant_msgs, "
        "n_actions, n_observations, prompt_tokens, completion_tokens, cost, first_text, "
        "last_text, dir_mtime, indexed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (cid, meta.get("title"), llm.get("model"), status,
         meta.get("created_at"), meta.get("updated_at"),
         workspace.get("working_dir"),
         json.dumps(meta.get("tags") or {}, ensure_ascii=False),
         counts["n_events"], counts["n_user_msgs"], counts["n_assistant_msgs"],
         counts["n_actions"], counts["n_observations"],
         prompt_tokens, completion_tokens, cost, first_text, last_text,
         (conv_dir / "meta.json").stat().st_mtime, time.time()),
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--persist", default=DEFAULT_PERSIST,
                    help=f"conversations dir (default {DEFAULT_PERSIST})")
    ap.add_argument("--db", default=DEFAULT_DB,
                    help=f"output sqlite db (default {DEFAULT_DB})")
    ap.add_argument("--full", action="store_true",
                    help="ignore mtime cache, re-index everything")
    ap.add_argument("--conv", help="index only one conversation id")
    args = ap.parse_args()

    persist = Path(args.persist).expanduser()
    if not persist.exists():
        print(f"persist dir not found: {persist}", file=sys.stderr)
        sys.exit(1)
    db = Path(args.db).expanduser()
    db.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(db))
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")

    cache = {}
    if not args.full:
        for path, mtime in conn.execute("SELECT path, mtime FROM index_state"):
            cache[path] = mtime

    conv_dirs = sorted([d for d in persist.iterdir() if d.is_dir()])
    if args.conv:
        conv_dirs = [d for d in conv_dirs if d.name == args.conv or
                     d.name.replace("-", "") == args.conv.replace("-", "")]

    changed = 0
    skipped = 0
    t0 = time.time()
    for conv_dir in conv_dirs:
        meta = _read_meta(conv_dir)
        if not meta:
            continue
        mp = str(conv_dir / "meta.json")
        try:
            mt = os.path.getmtime(mp)
        except OSError:
            continue
        if not args.full and cache.get(mp) == mt and not args.conv:
            skipped += 1
            continue
        index_conversation(conn, conv_dir, meta)
        conn.execute(
            "INSERT OR REPLACE INTO index_state (path, mtime, size, indexed_at) "
            "VALUES (?,?,?,?)",
            (mp, mt, os.path.getsize(mp), time.time()),
        )
        changed += 1
        if changed % 50 == 0:
            conn.commit()
            print(f"  ...{changed} indexed ({time.time()-t0:.1f}s)")

    conn.commit()

    valid = {str(d / "meta.json") for d in conv_dirs}
    stale = [p for (p,) in conn.execute("SELECT path FROM index_state") if p not in valid]
    if stale:
        conn.executemany("DELETE FROM index_state WHERE path = ?", [(p,) for p in stale])
        conn.commit()

    total = conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
    total_events = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    conn.close()
    print(f"\nIndexed {changed} conversations ({skipped} unchanged) in {time.time()-t0:.1f}s")
    print(f"Database: {db}")
    print(f"  conversations: {total}")
    print(f"  events:        {total_events}")
    if stale:
        print(f"  pruned stale:  {len(stale)}")


if __name__ == "__main__":
    main()
