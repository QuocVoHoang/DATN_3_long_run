export async function createWasmEngine() {
  const factory = (await import('../../build/motion_engine.js')).default;
  const module = await factory({ locateFile: path => new URL(`../../build/${path}`, import.meta.url).href });
  try { module._setThreadCount(4); }
  catch (error) { module.terminatePthreadPool?.(); throw error; }
  // Exercise actual SIMD/pthread dispatch, then remove probe state and allocation.
  let probe = 0;
  try { probe = module._malloc(8 * 8 * 4); if (!probe) throw Object.assign(new Error('Probe allocation failed'), {code:'WASM_ALLOCATION_FAILED'});
    module.HEAPU8.fill(0, probe, probe + 256);
    if(module._processMotion(probe,8,8,30)<0) throw new Error('Kernel initialization probe failed');
    module._resetMotionDetector();
  } catch(error) { module.terminatePthreadPool?.(); throw error; } finally { if(probe) module._free(probe); }
  let pointer = 0, capacity = 0, disposed = false;
  return {
    memoryBytes() { return module.HEAPU8.buffer.byteLength; },
    process(image, threshold = 30) {
      if (disposed) throw new Error('WASM engine already disposed');
      if (image.data.length > capacity) {
        if (pointer) module._free(pointer);
        pointer = 0;
        pointer = module._malloc(image.data.length);
        if (!pointer) { capacity = 0; throw Object.assign(new Error('WASM input allocation failed'), { code: 'WASM_ALLOCATION_FAILED' }); }
        capacity = image.data.length;
      }
      const copyStart = performance.now();
      module.HEAPU8.set(image.data, pointer);
      const wasmCopyMs = performance.now() - copyStart;
      const start = performance.now();
      const outcome = module._processMotion(pointer, image.width, image.height, threshold);
      if (outcome < 0) throw Object.assign(new Error(`Kernel failed: ${outcome}`), { code: outcome === -2 ? 'WASM_ALLOCATION_FAILED' : 'INVALID_IMAGE' });
      const coreMs = performance.now() - start;
      const bytes = image.data.byteLength ?? image.data.length;
      return { coreMs, frameRgbaBytes: bytes, wasmCopyBytes: bytes, profile: { wasmCopyMs, coreMs }, changedPixels: module._getChangedPixelCount() };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { if (pointer) module._free(pointer); }
      finally { pointer = 0; capacity = 0; module.terminatePthreadPool?.(); }
    },
  };
}
