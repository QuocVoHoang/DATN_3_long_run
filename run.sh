#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; PORT="${1:-8091}"
"$ROOT/build_wasm.sh"
python3 "$ROOT/server.py" "$PORT" & PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT INT TERM
sleep 0.5
URL="http://localhost:${PORT}"; echo "Running at $URL"
command -v open >/dev/null && open "$URL" || true
wait "$PID"
