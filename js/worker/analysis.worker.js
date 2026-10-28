import { MESSAGE } from './protocol.js';
let wasm = null, canvas = null, context = null, inputPointer = 0, capacity = 0, stopped = false;
async function init() {
  if (!wasm) {
    const factory = (await import('../../build/motion_engine.js')).default;
    wasm = await factory({ locateFile: path => new URL(`../../build/${path}`, import.meta.url).href });
    wasm._setThreadCount(4);
  }
}
function cleanup() {
  try { if (inputPointer && wasm) wasm._free(inputPointer); }
  finally { inputPointer = 0; capacity = 0; wasm?.terminatePthreadPool?.(); canvas = context = null; }
}
async function handle(data) {
  try {
    if (data.type === MESSAGE.STOP) {
      cleanup(); stopped = true;
      self.postMessage({ type: MESSAGE.STOPPED, requestId: data.requestId }); self.close(); return;
    }
    if (stopped) throw new Error('Worker already stopped');
    if (data.type === MESSAGE.INIT) { await init(); self.postMessage({ type: MESSAGE.READY, requestId: data.requestId, wasmMemoryBytes: wasm.HEAPU8.buffer.byteLength }); return; }
    if (data.type !== MESSAGE.FRAME || !wasm) throw new Error('Expected INIT before FRAME');
    const processingStart = performance.now();
    if (!canvas || canvas.width !== data.width || canvas.height !== data.height) {
      canvas = new OffscreenCanvas(data.width, data.height); context = canvas.getContext('2d', { willReadFrequently: true });
    }
    const drawStart = performance.now();
    context.drawImage(data.bitmap, 0, 0, data.width, data.height);
    const drawMs = performance.now() - drawStart;
    const readbackStart = performance.now();
    const image = context.getImageData(0, 0, data.width, data.height);
    const readbackMs = performance.now() - readbackStart;
    if (image.data.length > capacity) {
      if (inputPointer) wasm._free(inputPointer);
      inputPointer = 0;
      inputPointer = wasm._malloc(image.data.length); capacity = image.data.length;
    }
    const copyStart = performance.now();
    wasm.HEAPU8.set(image.data, inputPointer);
    const wasmCopyMs = performance.now() - copyStart;
    const start = performance.now(); wasm._processMotion(inputPointer, data.width, data.height, data.threshold ?? 30);
    const coreMs = performance.now() - start;
    const result = { type: MESSAGE.RESULT, requestId: data.requestId, frameId: data.frameId, mediaTime: data.mediaTime,
      presentedFrames: data.presentedFrames, coreMs, changedPixels: wasm._getChangedPixelCount(), wasmMemoryBytes: wasm.HEAPU8.buffer.byteLength,
      profile: { drawMs, readbackMs, wasmCopyMs, coreMs } };
    result.profile.workerProcessingMs = performance.now() - processingStart;
    self.postMessage(result);
  } catch (error) {
    self.postMessage({ type: MESSAGE.ERROR, requestId: data.requestId, message: String(error) });
  } finally { data.bitmap?.close(); }
}
// Serialize asynchronous initialization and stop, including STOP received during INIT.
let queue = Promise.resolve();
self.onmessage = ({ data }) => { queue = queue.then(() => handle(data)); };
