import { SampleStore, SAMPLE_BUDGET } from './sample_store.js';
import { summarizeProfile } from './profiling.js';
import { summarizeDataCost } from './data_cost.js';
export const WINDOW_MS = 60000;

function latency(samples, key, prefix) {
  if (!samples.length) return { [`${prefix}Mean`]: null, [`${prefix}P95`]: null, [`${prefix}P99`]: null };
  const values = samples.map(sample => sample[key]).sort((a, b) => a - b);
  const p = q => values[Math.ceil(q * values.length) - 1];
  return { [`${prefix}Mean`]: values.reduce((sum, value) => sum + value, 0) / values.length,
    [`${prefix}P95`]: p(.95), [`${prefix}P99`]: p(.99) };
}

export class LongRunStats {
  constructor(engine, { mode, width = 0, height = 0 } = {}) {
    this.engine = engine;
    this.start = null;
    this.mode = mode || (String(engine).includes('worker') ? 'worker' : 'main');
    this.width = width;
    this.height = height;
    this.buckets = new Map();
    this.samples = new SampleStore();
    this.gapCount = 0;
    this.lastCallback = null;
  }
  begin(start) {
    this.start = start;
  }
  bucket(index) {
    let bucket = this.buckets.get(index);
    if (!bucket) {
      bucket = { start: this.samples.length, end: this.samples.length, callbackGaps: [] };
      this.buckets.set(index, bucket);
    }
    return bucket;
  }
  callback(now) {
    if (++this.gapCount > SAMPLE_BUDGET.maxCallbackGaps) { this.budgetError = Object.assign(new Error('Callback sample budget exceeded'), { code: 'SAMPLE_BUDGET_EXCEEDED' }); return; }
    if (this.lastCallback != null) this.bucket(Math.floor((now - this.start) / WINDOW_MS)).callbackGaps.push(now - this.lastCallback);
    this.lastCallback = now;
  }
  complete(sample, receivedAt) {
    // Processing stage profiles use only completedWithinWindow outcomes.
    const bucket = this.bucket(Math.floor((receivedAt - this.start) / WINDOW_MS));
    this.samples.push(sample); bucket.end = this.samples.length;
  }
  result(end, visibilityObservedAt = null) {
    const windows = [];
    const duration = this.start == null || end == null ? 0 : Math.max(0, end - this.start);
    for (let index = 0; index * WINDOW_MS < duration; index++) {
      const startMs = index * WINDOW_MS, endMs = Math.min(startMs + WINDOW_MS, duration);
      const bucket = this.buckets.get(index), samples = bucket ? this.samples.view(bucket.start, bucket.end) : [];
      // A hidden event that truncates the final window belongs to the nominal
      // minute containing it; exact minute boundaries never create zero-length windows.
      const hiddenIndex = visibilityObservedAt == null ? -1 : Math.floor((visibilityObservedAt - this.start) / WINDOW_MS);
      const interrupted = visibilityObservedAt != null && visibilityObservedAt >= this.start && visibilityObservedAt <= end && hiddenIndex === index;
      windows.push({ engine: this.engine, index, startMs, endMs, durationMs: endMs - startMs,
        partial: endMs - startMs < WINDOW_MS, completedWithinWindow: samples.length,
        completedFps: samples.length * 1000 / (endMs - startMs), ...latency(samples, 'core', 'core'), ...latency(samples, 'e2e', 'e2e'),
        ...summarizeDataCost({ samples, mode: this.mode, width: this.width, height: this.height, elapsedMs: endMs - startMs }),
        visibilityInterrupted: interrupted, profile: summarizeProfile(samples, bucket?.callbackGaps || []) });
    }
    const buckets = [...this.buckets.values()];
    const allSamples = this.samples;
    return { windows, summary: {
      ...summarizeDataCost({ samples: allSamples, mode: this.mode, width: this.width, height: this.height, elapsedMs: duration }),
      profile: summarizeProfile(allSamples, buckets.flatMap(bucket => bucket.callbackGaps)) } };
  }
}
