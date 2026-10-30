#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMCC="${EMCC:-$(command -v emcc || true)}"
[[ -n "$EMCC" ]] || { echo 'emcc not found; source emsdk_env.sh' >&2; exit 1; }
mkdir -p "$ROOT/build"
rm -f "$ROOT"/build/motion_engine.* "$ROOT/build/build-manifest.json"
FLAGS=(-O3 -msimd128 -pthread -s PTHREAD_POOL_SIZE=4 -s WASM=1 -s ALLOW_MEMORY_GROWTH=1 -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web,worker -s INITIAL_MEMORY=268435456 -s MAXIMUM_MEMORY=536870912 -s ABORTING_MALLOC=0 -fexceptions -s EXPORTED_FUNCTIONS='["_malloc","_free","_processMotion","_resetMotionDetector","_getChangedPixelCount","_getOutput","_setThreadCount","_getThreadCount"]' -s EXPORTED_RUNTIME_METHODS='["HEAPU8"]')
"$EMCC" "$ROOT/cpp/motion_detection.cpp" "${FLAGS[@]}" --post-js "$ROOT/pthread_cleanup.js" -s EXPORT_NAME=createMotionEngine -o "$ROOT/build/motion_engine.js"
python3 - "$ROOT" "$EMCC" "${FLAGS[@]}" <<'PYMANIFEST'
import hashlib, json, pathlib, subprocess, sys
root=pathlib.Path(sys.argv[1])
files=['cpp/motion_detection.cpp','pthread_cleanup.js','build_wasm.sh','build/motion_engine.js','build/motion_engine.wasm']
hashes={p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in files}
manifest={'schemaVersion':1,'compiler':subprocess.check_output([sys.argv[2],'--version'],text=True).strip(),
 'flags':sys.argv[3:]+['--post-js','pthread_cleanup.js','-s','EXPORT_NAME=createMotionEngine'], 'sha256':hashes,
 'initialMemoryBytes':268435456,'maximumMemoryBytes':536870912,'threads':4}
manifest['buildId']=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest()
(root/'build/build-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
PYMANIFEST
echo 'Built build/motion_engine.js and build/motion_engine.wasm'
