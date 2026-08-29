#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PERSIST_DIR="${PERSIST_DIR:-$HOME/.openhands/agent-canvas/dev_conversations}"
SEARCH_DB="${SEARCH_DB:-$HOME/.openhands/agent-canvas/search.db}"
SEARCH_HOST="${SEARCH_HOST:-127.0.0.1}"
SEARCH_PORT="${SEARCH_PORT:-8765}"

INDEX_ARGS=(--persist "$PERSIST_DIR" --db "$SEARCH_DB")
if [[ "${1:-}" == "--full" ]]; then
  INDEX_ARGS+=(--full)
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--full]" >&2
  exit 2
fi

python3 "$DIR/indexer.py" "${INDEX_ARGS[@]}"
echo "Starting conversation search on http://$SEARCH_HOST:$SEARCH_PORT"
exec python3 "$DIR/server.py" --db "$SEARCH_DB" --host "$SEARCH_HOST" --port "$SEARCH_PORT"
