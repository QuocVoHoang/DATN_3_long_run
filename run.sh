#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$ROOT/build/motion_engine.wasm" ]] || { echo 'Missing artifact: run ./build_wasm.sh first' >&2; exit 1; }
exec python3 "$ROOT/server.py" "$@"
