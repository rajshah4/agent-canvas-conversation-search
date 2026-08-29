#!/usr/bin/env python3
"""Query the local Agent Canvas conversation search service."""

from __future__ import annotations

import argparse
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import urlopen

DEFAULT_API = os.environ.get("CONVERSATION_SEARCH_API", "http://127.0.0.1:8765")


def request(api: str, path: str, params: dict | None = None) -> dict:
    url = f"{api.rstrip('/')}{path}"
    if params:
        url = f"{url}?{urlencode({key: value for key, value in params.items() if value is not None})}"
    try:
        with urlopen(url, timeout=10) as response:
            return json.load(response)
    except HTTPError as error:
        try:
            detail = json.load(error).get("error", error.reason)
        except (json.JSONDecodeError, AttributeError):
            detail = error.reason
        raise SystemExit(f"Conversation search failed ({error.code}): {detail}") from error
    except URLError as error:
        raise SystemExit(
            f"Conversation search is unavailable at {api}. Start service/scripts/start.sh first: {error.reason}"
        ) from error


def add_common_filters(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--model")
    parser.add_argument("--status")
    parser.add_argument("--role", choices=("user", "assistant"))
    parser.add_argument("--kind")
    parser.add_argument("--tool")
    parser.add_argument("--after", help="Minimum conversation updated_at timestamp")
    parser.add_argument("--before", help="Maximum conversation updated_at timestamp")
    parser.add_argument("--api", default=DEFAULT_API)
    parser.add_argument("--json", action="store_true", dest="as_json")


def common_params(args: argparse.Namespace) -> dict:
    return {
        "limit": args.limit,
        "model": args.model,
        "status": args.status,
        "role": args.role,
        "kind": args.kind,
        "tool": args.tool,
        "after": args.after,
        "before": args.before,
    }


def one_line(value) -> str:
    return " ".join(str(value or "").split())


def markdown_context(data: dict) -> str:
    lines = [
        "# Conversation history evidence",
        "",
        f"Query: {data['query']}",
        f"Returned {data['returned_matches']} of {data['total_matches']} matching events.",
    ]
    if not data["conversations"]:
        lines.extend(["", "No matches found."])
        return "\n".join(lines)

    for conversation in data["conversations"]:
        lines.extend([
            "",
            f"## {one_line(conversation['title']) or 'Untitled conversation'}",
            f"Conversation ID: `{conversation['id']}`",
            f"Model: {conversation['model'] or 'unknown'} | Status: {conversation['status'] or 'unknown'} | Updated: {conversation['updated_at'] or 'unknown'}",
        ])
        for event in conversation["events"]:
            marker = "MATCH" if event["matched"] else "context"
            attributes = [
                f"seq={event['seq']}",
                f"event={event['event_id'] or 'unknown'}",
                f"kind={event['kind'] or 'unknown'}",
                f"role={event['role'] or event['source'] or 'unknown'}",
            ]
            if event["tool_name"]:
                attributes.append(f"tool={event['tool_name']}")
            lines.extend(["", f"### {marker}: " + " | ".join(attributes)])
            text = event["text"] or "(no text)"
            lines.extend(f"> {line}" if line else ">" for line in text.splitlines())
            if event["truncated"]:
                lines.append("> …[event truncated]")
    return "\n".join(lines)


def markdown_recent(data: dict) -> str:
    lines = [
        "# Recent conversations",
        "",
        f"Showing {len(data['conversations'])} of {data['total']} conversations, newest first.",
        "",
        "| Updated | Status | Model | Title | Conversation ID |",
        "| --- | --- | --- | --- | --- |",
    ]
    for conversation in data["conversations"]:
        cells = [
            conversation["updated_at"],
            conversation["status"],
            conversation["model"],
            conversation["title"],
            conversation["id"],
        ]
        escaped = [one_line(cell).replace("|", "\\|") or "—" for cell in cells]
        lines.append("| " + " | ".join(escaped) + " |")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    search = subparsers.add_parser("search", help="Find compact evidence windows")
    search.add_argument("query")
    search.add_argument("--context", type=int, default=1, help="Neighboring events on each side")
    search.add_argument("--max-chars", type=int, default=1200, help="Maximum text per event")
    add_common_filters(search)

    recent = subparsers.add_parser("recent", help="List conversations newest first")
    add_common_filters(recent)

    health = subparsers.add_parser("health", help="Check service availability")
    health.add_argument("--api", default=DEFAULT_API)
    health.add_argument("--json", action="store_true", dest="as_json")

    args = parser.parse_args()
    if args.command == "search":
        params = common_params(args) | {
            "q": args.query,
            "context": args.context,
            "max_chars": args.max_chars,
        }
        data = request(args.api, "/api/context", params)
        output = json.dumps(data, indent=2, ensure_ascii=False) if args.as_json else markdown_context(data)
    elif args.command == "recent":
        data = request(args.api, "/api/search", common_params(args))
        output = json.dumps(data, indent=2, ensure_ascii=False) if args.as_json else markdown_recent(data)
    else:
        data = request(args.api, "/api/health")
        output = json.dumps(data, indent=2) if args.as_json else f"{data['service']}: {data['status']}"

    print(output)


if __name__ == "__main__":
    main()
