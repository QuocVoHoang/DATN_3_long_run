export async function createWasmEngine() {
  const factory = (await import('../../build/motion_engine.js')).default;
  const module = await factory({ locateFile: path => new URL(`../../build/${path}`, import.meta.url).href });
  try { module._setThreadCount(4); }
  catch (error) { module.terminatePthreadPool?.(); throw error; }
  let pointer = 0, capacity = 0, disposed = false;
  return {
    getMemoryCapacity() { return disposed ? null : module.HEAPU8.buffer.byteLength; },
    process(image, threshold = 30) {
      if (disposed) throw new Error('WASM engine already disposed');
      if (image.data.length > capacity) {
        if (pointer) module._free(pointer);
        pointer = 0;
        pointer = module._malloc(image.data.length);
        capacity = image.data.length;
      }
      const copyStart = performance.now();
      module.HEAPU8.set(image.data, pointer);
      const wasmCopyMs = performance.now() - copyStart;
      const start = performance.now();
      module._processMotion(pointer, image.width, image.height, threshold);
      const coreMs = performance.now() - start;
      return { coreMs, profile: { wasmCopyMs, coreMs }, changedPixels: module._getChangedPixelCount(), wasmMemoryBytes: module.HEAPU8.buffer.byteLength };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { if (pointer) module._free(pointer); }
      finally { pointer = 0; capacity = 0; module.terminatePthreadPool?.(); }
    },
  };
}
