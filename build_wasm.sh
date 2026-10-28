#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMCC="${EMCC:-$(command -v emcc || true)}"
[[ -n "$EMCC" ]] || { echo 'emcc not found; source emsdk_env.sh' >&2; exit 1; }
mkdir -p "$ROOT/build"
FLAGS=(-O3 -msimd128 -pthread -s PTHREAD_POOL_SIZE=4 -s WASM=1 -s ALLOW_MEMORY_GROWTH=1 -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web -s EXPORTED_FUNCTIONS='["_malloc","_free","_processMotion","_resetMotionDetector","_getChangedPixelCount","_getOutput","_setThreadCount","_getThreadCount"]' -s EXPORTED_RUNTIME_METHODS='["HEAPU8"]')
"$EMCC" "$ROOT/cpp/motion_detection.cpp" "${FLAGS[@]}" --post-js "$ROOT/pthread_cleanup.js" -s EXPORT_NAME=createMotionEngine -o "$ROOT/build/motion_engine.js"
echo 'Built build/motion_engine.js and build/motion_engine.wasm'
