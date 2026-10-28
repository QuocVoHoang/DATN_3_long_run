export const PROFILE_STAGES = ['bitmapMs', 'drawMs', 'readbackMs', 'wasmCopyMs', 'coreMs',
  'workerProcessingMs', 'workerRoundTripMs', 'workerTransportAndSchedulingMs', 'e2eMs', 'callbackGapMs'];
export const PROFILE_STATISTICS = ['count', 'mean', 'p50', 'p95', 'p99'];
export const PROFILE_COLUMNS = PROFILE_STAGES.flatMap(stage => PROFILE_STATISTICS.map(stat => `profile.${stage}.${stat}`));
export const PROFILE_LABELS = {
  bitmapMs: 'Create ImageBitmap', drawMs: 'Canvas drawImage', readbackMs: 'Canvas getImageData',
  wasmCopyMs: 'Copy pixels into WASM', coreMs: 'WASM core', workerProcessingMs: 'Worker handler processing',
  workerRoundTripMs: 'Worker round trip (includes processing)',
  workerTransportAndSchedulingMs: 'Transport + scheduling residual (estimate)',
  e2eMs: 'Callback to result', callbackGapMs: 'Gap between observed callbacks',
};
export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, mean: null, p50: null, p95: null, p99: null };
  const percentile = q => sorted[Math.ceil(q * sorted.length) - 1];
  return { count: sorted.length, mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) };
}
export function summarizeProfile(samples, callbackGaps = []) {
  return Object.fromEntries(PROFILE_STAGES.map(stage => [stage,
    distribution(stage === 'callbackGapMs' ? callbackGaps : samples.map(sample => sample.profile?.[stage]))]));
}
export function profileField(record, key) {
  const [, stage, statistic] = key.split('.');
  return record.profile?.[stage]?.[statistic];
}
export const PROFILING_METADATA = Object.freeze({
  version: 1, enabled: true, unit: 'milliseconds', processingSampleScope: 'completedWithinWindow',
  callbackGapSampleScope: 'consecutive observed callbacks within measurement; assigned to the later callback window',
  clockPolicy: 'Local durations only; worker round trip and callback timing use the main-thread clock',
  residualDefinition: 'workerRoundTripMs - workerProcessingMs; includes transport, queueing and scheduling, not pure message cost',
  residualPrecision: 'Signed estimate; timer precision can produce small negative values',
  applicability: 'Worker-only stages are null with count 0 on main; unavailable values are never inferred as zero',
  caveat: 'Round trip contains worker processing; stages overlap and must not all be summed. Instrumentation adds overhead.',
  exclusions: 'WASM copy measures HEAPU8.set only, excluding allocation. End-to-end excludes waiting for the callback and full decode/display latency.',
});
