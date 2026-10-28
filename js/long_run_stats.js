import { summarizeProfile } from './profiling.js';
export const WINDOW_MS = 60000;
const validCapacity = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const overlap = (start, end, a, b) => Math.max(0, Math.min(end, b) - Math.max(start, a));
function latency(samples, key, prefix) {
  if (!samples.length) return { [`${prefix}Mean`]: null, [`${prefix}P95`]: null, [`${prefix}P99`]: null };
  const values = samples.map(sample => sample[key]).sort((a, b) => a - b);
  const p = q => values[Math.ceil(q * values.length) - 1];
  return { [`${prefix}Mean`]: values.reduce((sum, value) => sum + value, 0) / values.length,
    [`${prefix}P95`]: p(.95), [`${prefix}P99`]: p(.99) };
}
// A task boundary lets the just-finished measurement task become observable.
function nextTask() {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(null);
  });
}
export class LongRunStats {
  constructor(engine) {
    this.engine = engine; this.start = null; this.baseline = null;
    this.buckets = new Map(); this.lastCallback = null; this.tasks = []; this.observer = null;
    this.longTasksSupported = !!globalThis.PerformanceObserver?.supportedEntryTypes?.includes('longtask');
  }
  monitor() {
    if (!this.longTasksSupported) return;
    try {
      this.observer = new PerformanceObserver(list => this.capture(list.getEntries()));
      this.observer.observe({ type: 'longtask' }); this.longTasksSupported = true;
    } catch {
      this.observer?.disconnect(); this.observer = null; this.longTasksSupported = false;
    }
  }
  capture(entries) {
    for (const entry of entries) this.tasks.push({ start: entry.startTime, end: entry.startTime + entry.duration });
  }
  begin(start, baseline) { this.start = start; this.baseline = validCapacity(baseline); }
  bucket(index) {
    let bucket = this.buckets.get(index);
    if (!bucket) { bucket = { samples: [], memory: [], callbackGaps: [] }; this.buckets.set(index, bucket); }
    return bucket;
  }
  callback(now) {
    if (this.lastCallback != null) this.bucket(Math.floor((now - this.start) / WINDOW_MS)).callbackGaps.push(now - this.lastCallback);
    this.lastCallback = now;
  }
  complete(sample, receivedAt, capacity) {
    // Processing stage profiles use only completedWithinWindow outcomes.
    const bucket = this.bucket(Math.floor((receivedAt - this.start) / WINDOW_MS));
    bucket.samples.push(sample);
    const bytes = validCapacity(capacity);
    if (bytes != null) bucket.memory.push(bytes);
  }
  async stop() {
    if (!this.observer) return;
    try {
      await nextTask();
      this.capture(this.observer.takeRecords());
    } finally { this.observer.disconnect(); this.observer = null; }
  }
  taskStats(start, end) {
    if (!this.longTasksSupported) return { longTasksSupported: false, mainThreadLongTasksOverlapping: null,
      mainThreadLongTaskMs: null, mainThreadBlockingMs: null };
    let count = 0, taskMs = 0, blockingMs = 0;
    if (start != null && end != null) for (const task of this.tasks) {
      const duration = overlap(start, end, task.start, task.end);
      if (duration > 0) { count++; taskMs += duration; blockingMs += overlap(start, end, task.start + 50, task.end); }
    }
    return { longTasksSupported: true, mainThreadLongTasksOverlapping: count,
      mainThreadLongTaskMs: taskMs, mainThreadBlockingMs: blockingMs };
  }
  result(end, visibilityObservedAt = null) {
    const windows = [];
    let last = this.baseline, peak = this.baseline;
    const duration = this.start == null || end == null ? 0 : Math.max(0, end - this.start);
    for (let index = 0; index * WINDOW_MS < duration; index++) {
      const startMs = index * WINDOW_MS, endMs = Math.min(startMs + WINDOW_MS, duration);
      const bucket = this.buckets.get(index), samples = bucket?.samples || [];
      let windowPeak = last;
      for (const bytes of bucket?.memory || []) {
        last = bytes; windowPeak = windowPeak == null ? bytes : Math.max(windowPeak, bytes);
        peak = peak == null ? bytes : Math.max(peak, bytes);
      }
      // A hidden event that truncates the final window belongs to the nominal
      // minute containing it; exact minute boundaries never create zero-length windows.
      const hiddenIndex = visibilityObservedAt == null ? -1 : Math.floor((visibilityObservedAt - this.start) / WINDOW_MS);
      const interrupted = visibilityObservedAt != null && visibilityObservedAt >= this.start && visibilityObservedAt <= end && hiddenIndex === index;
      windows.push({ engine: this.engine, index, startMs, endMs, durationMs: endMs - startMs,
        partial: endMs - startMs < WINDOW_MS, completedWithinWindow: samples.length,
        completedFps: samples.length * 1000 / (endMs - startMs), ...latency(samples, 'core', 'core'), ...latency(samples, 'e2e', 'e2e'),
        ...this.taskStats(this.start + startMs, this.start + endMs),
        wasmLinearMemoryLastObservedBytes: last, wasmLinearMemoryObservedPeakBytes: windowPeak,
        visibilityInterrupted: interrupted, profile: summarizeProfile(samples, bucket?.callbackGaps || []) });
    }
    const buckets = [...this.buckets.values()];
    return { windows, summary: { ...this.taskStats(this.start, end),
      profile: summarizeProfile(buckets.flatMap(bucket => bucket.samples), buckets.flatMap(bucket => bucket.callbackGaps)),
      wasmLinearMemoryLastObservedBytes: last, wasmLinearMemoryObservedPeakBytes: peak } };
  }
}
