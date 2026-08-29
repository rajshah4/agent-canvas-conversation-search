#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PERSIST_DIR="${PERSIST_DIR:-$HOME/.openhands/agent-canvas/dev_conversations}"
SEARCH_DB="${SEARCH_DB:-$HOME/.openhands/agent-canvas/search.db}"

exec python3 "$DIR/indexer.py" --persist "$PERSIST_DIR" --db "$SEARCH_DB" "$@"
