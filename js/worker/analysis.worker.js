import { MESSAGE } from './protocol.js';
import { createWasmEngine } from '../engine/wasm_engine.js';
let engine = null, canvas = null, context = null, stopped = false, lastMemoryAt = -Infinity;
async function init() {
  const probe = new OffscreenCanvas(2,2);
  const ctx = probe.getContext('2d', { willReadFrequently:true });
  if(!ctx || ctx.getImageData(0,0,2,2).data.length!==16) throw new Error('Worker 2D readback unavailable');
  const bitmap = await createImageBitmap(probe); try { ctx.drawImage(bitmap,0,0); } finally { bitmap.close(); }
  engine = await createWasmEngine();
}
function cleanup() { try { engine?.dispose(); } finally { engine = canvas = context = null; } }
async function handle(data) {
  try {
    if (data.type === MESSAGE.STOP) {
      cleanup(); stopped = true;
      self.postMessage({ type: MESSAGE.STOPPED, requestId: data.requestId }); self.close(); return;
    }
    if (stopped) throw new Error('Worker already stopped');
    if (data.type === MESSAGE.INIT) { await init(); self.postMessage({ type: MESSAGE.READY, requestId: data.requestId }); return; }
    if (data.type !== MESSAGE.FRAME || !engine) throw new Error('Expected INIT before FRAME');
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
    const processed = engine.process(image, data.threshold ?? 30);
    const { coreMs } = processed;
    const wasmCopyMs = processed.profile.wasmCopyMs;
    const bytes = image.data.byteLength ?? image.data.length;
    const result = { type: MESSAGE.RESULT, requestId: data.requestId, frameId: data.frameId, mediaTime: data.mediaTime,
      presentedFrames: data.presentedFrames, coreMs, frameRgbaBytes: bytes, readbackBytes: bytes, wasmCopyBytes: bytes,
      changedPixels: processed.changedPixels,
      profile: { drawMs, readbackMs, wasmCopyMs, coreMs } };
    result.profile.workerProcessingMs = performance.now() - processingStart;
    if (data.telemetryEnabled !== false && performance.now()-lastMemoryAt >= Math.max(250, data.telemetryCadenceMs ?? 1000)) {
      result.wasmLinearMemoryBytes = engine.memoryBytes(); lastMemoryAt = performance.now();
    }
    self.postMessage(result);
  } catch (error) {
    self.postMessage({ type: MESSAGE.ERROR, requestId: data.requestId, message: String(error), code: error.code ?? 'WORKER_ERROR' });
  } finally { data.bitmap?.close(); }
}
// Serialize asynchronous initialization and stop, including STOP received during INIT.
let queue = Promise.resolve();
self.onmessage = ({ data }) => { queue = queue.then(() => handle(data)); };
