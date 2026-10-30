const MB = 1e6;
const GB = 1e9;
const CORE_BYTES_PER_PIXEL = 13; // rgba(4) + previous(1) + current(1) + blurred(1) + temp_u16(2) + output_rgba(4)

export const DATA_COST_COLUMNS = Object.freeze([
  'nonCoreMean', 'nonCoreSharePct', 'bottleneckRegime',
  'nonCoreTrafficMBPerFrame', 'totalNonCoreTrafficGB', 'wasmCopyBandwidthGBps',
]);

export const DATA_COST_LABELS = Object.freeze({
  nonCoreMean: 'Non-core Δ mean (ms)',
  nonCoreP50: 'Non-core Δ P50 (ms)',
  nonCoreP95: 'Non-core Δ P95 (ms)',
  nonCoreP99: 'Non-core Δ P99 (ms)',
  nonCoreSharePct: 'Non-core share (%)',
  bottleneckRegime: 'Bottleneck regime',
  frameRgbaBytes: 'Frame RGBA (bytes)',
  frameRgbaMB: 'Frame RGBA (MB)',
  bridgeCopyBytesPerFrame: 'Bridge copy / frame (bytes)',
  bridgeCopyMBPerFrame: 'Bridge copy / frame (MB)',
  nonCoreTrafficBytesPerFrame: 'Non-core traffic / frame (bytes)',
  nonCoreTrafficMBPerFrame: 'Non-core traffic / frame (MB)',
  coreWorkingSetBytes: 'Core working set (bytes)',
  coreWorkingSetMB: 'Core working set (MB)',
  totalReadbackBytes: 'Total readback (bytes)',
  totalReadbackGB: 'Total readback (GB)',
  totalWasmCopyBytes: 'Total WASM copy (bytes)',
  totalWasmCopyGB: 'Total WASM copy (GB)',
  totalBridgeCopyBytes: 'Total bridge copy (bytes)',
  totalBridgeCopyGB: 'Total bridge copy (GB)',
  totalNonCoreTrafficBytes: 'Total non-core traffic (bytes)',
  totalNonCoreTrafficGB: 'Total non-core traffic (GB)',
  readbackBandwidthGBps: 'Readback bandwidth (GB/s)',
  wasmCopyBandwidthGBps: 'WASM copy bandwidth (GB/s)',
  bridgeThroughputMBps: 'Bridge throughput (MB/s)',
  nonCoreThroughputMBps: 'Non-core throughput (MB/s)',
});

export const DATA_COST_METADATA = Object.freeze({
  version: 1,
  unitMB: '1e6 bytes (decimal MB)',
  unitGB: '1e9 bytes (decimal GB)',
  unitBandwidthGBps: 'bytes / (stageMs * 1e6) = GB/s',
  unitThroughputMBps: 'totalBytes / (elapsedMs * 1e3) = MB/s',
  bridgeCopyDefinition: 'getImageData readback (4N bytes) + HEAPU8.set copy into WASM (4N bytes) = 8N bytes per frame',
  nonCoreTrafficDefinition: 'Main: drawImage + getImageData + HEAPU8.set (3 * 4N bytes); Worker: createImageBitmap + OffscreenCanvas.drawImage + OffscreenCanvas.getImageData + HEAPU8.set (4 * 4N bytes)',
  coreWorkingSetDefinition: 'Modeled buffer payload only, not DRAM traffic, RSS, allocator capacity or observed memory: input RGBA (4N) + previous (1N) + current (1N) + blurred (1N) + temp uint16 (2N) + output RGBA (4N) = 13N bytes',
  crossoverRule: 'bottleneckRegime is "non-core" when nonCoreSharePct = ((e2eMean - coreMean) / e2eMean) * 100 >= 50%, otherwise "core"',
});

function positiveInt(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function frameDataFootprint({ width = 0, height = 0, mode = 'main', frameRgbaBytes = null } = {}) {
  const validW = positiveInt(width), validH = positiveInt(height);
  const explicitBytes = positiveInt(frameRgbaBytes);
  const pixels = validW && validH ? validW * validH : (explicitBytes ? Math.floor(explicitBytes / 4) : null);
  const rgbaBytes = explicitBytes ?? (pixels != null ? pixels * 4 : null);
  if (rgbaBytes == null) {
    return {
      frameRgbaBytes: null, frameRgbaMB: null,
      bridgeCopyBytesPerFrame: null, bridgeCopyMBPerFrame: null,
      nonCoreTrafficBytesPerFrame: null, nonCoreTrafficMBPerFrame: null,
      coreWorkingSetBytes: null, coreWorkingSetMB: null,
    };
  }
  const stages = mode === 'worker' || String(mode).includes('worker') ? 4 : 3;
  const bridgeBytes = rgbaBytes * 2;
  const nonCoreBytes = rgbaBytes * stages;
  const coreBytes = (pixels ?? Math.floor(rgbaBytes / 4)) * CORE_BYTES_PER_PIXEL;
  return {
    frameRgbaBytes: rgbaBytes,
    frameRgbaMB: rgbaBytes / MB,
    bridgeCopyBytesPerFrame: bridgeBytes,
    bridgeCopyMBPerFrame: bridgeBytes / MB,
    nonCoreTrafficBytesPerFrame: nonCoreBytes,
    nonCoreTrafficMBPerFrame: nonCoreBytes / MB,
    coreWorkingSetBytes: coreBytes,
    coreWorkingSetMB: coreBytes / MB,
  };
}

function summarizeNonCoreDelta(samples) {
  if (!samples.length) {
    return { nonCoreMean: null, nonCoreP50: null, nonCoreP95: null, nonCoreP99: null, nonCoreSharePct: null, bottleneckRegime: null };
  }
  const deltas = samples
    .map(s => Number.isFinite(s.profile?.nonCoreMs) ? s.profile.nonCoreMs : Math.max(0, (s.e2e ?? 0) - (s.core ?? 0)))
    .sort((a, b) => a - b);
  const pick = q => deltas[Math.max(0, Math.ceil(q * deltas.length) - 1)];
  const nonCoreMean = deltas.reduce((sum, x) => sum + x, 0) / deltas.length;
  const coreMean = samples.reduce((sum, s) => sum + (s.core ?? 0), 0) / samples.length;
  const e2eMean = samples.reduce((sum, s) => sum + (s.e2e ?? 0), 0) / samples.length;
  const rawShare = e2eMean > 0 ? Math.max(0, Math.min(100, ((e2eMean - coreMean) / e2eMean) * 100)) : null;
  return {
    nonCoreMean,
    nonCoreP50: pick(0.5),
    nonCoreP95: pick(0.95),
    nonCoreP99: pick(0.99),
    nonCoreSharePct: rawShare,
    bottleneckRegime: rawShare == null ? null : (rawShare >= 50 ? 'non-core' : 'core'),
  };
}

export function summarizeDataCost({ samples = [], mode = 'main', width = 0, height = 0, elapsedMs = null } = {}) {
  const sampleBytes = samples.find(s => positiveInt(s.frameRgbaBytes))?.frameRgbaBytes ?? null;
  const footprint = frameDataFootprint({ width, height, mode, frameRgbaBytes: sampleBytes });
  const delta = summarizeNonCoreDelta(samples);
  const stages = mode === 'worker' || String(mode).includes('worker') ? 4 : 3;
  const fallbackFrameBytes = footprint.frameRgbaBytes ?? 0;

  let totalReadbackBytes = 0, totalWasmCopyBytes = 0, totalNonCoreTrafficBytes = 0;
  let readbackTimedBytes = 0, readbackTimedMs = 0, wasmCopyTimedBytes = 0, wasmCopyTimedMs = 0;

  for (const sample of samples) {
    const frameBytes = positiveInt(sample.frameRgbaBytes) ?? fallbackFrameBytes;
    const rbBytes = positiveInt(sample.readbackBytes) ?? frameBytes;
    const wcBytes = positiveInt(sample.wasmCopyBytes) ?? frameBytes;
    totalReadbackBytes += rbBytes;
    totalWasmCopyBytes += wcBytes;
    totalNonCoreTrafficBytes += frameBytes * stages;
    if (Number.isFinite(sample.profile?.readbackMs) && sample.profile.readbackMs > 0) {
      readbackTimedBytes += rbBytes;
      readbackTimedMs += sample.profile.readbackMs;
    }
    if (Number.isFinite(sample.profile?.wasmCopyMs) && sample.profile.wasmCopyMs > 0) {
      wasmCopyTimedBytes += wcBytes;
      wasmCopyTimedMs += sample.profile.wasmCopyMs;
    }
  }

  const totalBridgeCopyBytes = totalReadbackBytes + totalWasmCopyBytes;
  const validElapsed = Number.isFinite(elapsedMs) && elapsedMs > 0;
  return {
    ...delta,
    ...footprint,
    totalReadbackBytes,
    totalReadbackGB: totalReadbackBytes / GB,
    totalWasmCopyBytes,
    totalWasmCopyGB: totalWasmCopyBytes / GB,
    totalBridgeCopyBytes,
    totalBridgeCopyGB: totalBridgeCopyBytes / GB,
    totalNonCoreTrafficBytes,
    totalNonCoreTrafficGB: totalNonCoreTrafficBytes / GB,
    readbackBandwidthGBps: readbackTimedMs > 0 ? readbackTimedBytes / (readbackTimedMs * MB) : null,
    wasmCopyBandwidthGBps: wasmCopyTimedMs > 0 ? wasmCopyTimedBytes / (wasmCopyTimedMs * MB) : null,
    bridgeThroughputMBps: validElapsed ? totalBridgeCopyBytes / (elapsedMs * 1e3) : null,
    nonCoreThroughputMBps: validElapsed ? totalNonCoreTrafficBytes / (elapsedMs * 1e3) : null,
  };
}
