import { SAMPLE_BUDGET } from './sample_store.js';
import { preflight } from './preflight.js';
import { observeTelemetry } from './telemetry.js';
import { LongRunStats } from './long_run_stats.js';
import { Measurement } from './measurement.js';
import { createWasmEngine } from './engine/wasm_engine.js';
import { LIMITS, fault, check, aborted, waitFor, seekStart, nextFrame, initializeMain, mainInitializationPending, mainInitializationCleanup, WorkerClient } from './lifecycle.js';
export const percentile = (a, q) => { const sorted = [...a].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] || 0; };
const mean = a => a.reduce((sum, x) => sum + x, 0) / (a.length || 1);
export function summarize(samples, engine, extended, diagnostic) {
  const coreStats = samples.distribution?.('core'), e2eStats = samples.distribution?.('e2e');
  const cores = coreStats ? [] : samples.map(s => s.core), e2e = e2eStats ? [] : samples.map(s => s.e2e);
  const result = { [diagnostic || extended ? 'engine' : 'mode']: engine,
    coreMean: coreStats?.mean ?? mean(cores), coreP95: coreStats?.p95 ?? percentile(cores, .95), coreP99: coreStats?.p99 ?? percentile(cores, .99) };
  if (extended) Object.assign(result, { e2eMean: e2eStats?.mean ?? mean(e2e), e2eP95: e2eStats?.p95 ?? percentile(e2e, .95), e2eP99: e2eStats?.p99 ?? percentile(e2e, .99) });
  else Object.assign(result, { endToEndMean: e2eStats?.mean ?? mean(e2e), coreP50: coreStats?.p50 ?? percentile(cores, .5) });
  if (!samples.length) for (const key of Object.keys(result)) if (/^(core|e2e|endToEnd)/.test(key)) result[key] = null;
  return result;
}
const videoOwners = new WeakMap();
export async function runMode({ mode, video, canvas, context, config, signal, onPhase, extended, diagnostic, windows = [], visibility = {}, dependencies = {} }) {
  const engineName = mode === 'main' ? 'simd-pthread-4-main' : 'simd-pthread-4-worker-offscreen';
  const width = canvas?.width || video?.videoWidth || 0, height = canvas?.height || video?.videoHeight || 0;
  let engine, client, phase = 'initializing', status = 'ok', error, cleanup = { cleanupStatus: 'ok' };
  let activeFrame = null, telemetry = null, capabilityReport = null;
  const longStats = new LongRunStats(engineName, { mode, width, height });
  const samples = longStats.samples;
  const measurement = new Measurement(typeof video.requestVideoFrameCallback === 'function' ? 'requestVideoFrameCallback' : 'requestAnimationFrame');
  const local = new AbortController();
  videoOwners.set(video, local);
  let measureDeadline = Infinity;
  const abort = () => { measurement.close(signal.reason?.observedAt ?? performance.now()); local.abort(signal.reason || aborted()); };
  const mediaError = () => { measurement.close(performance.now()); local.abort(fault('MEDIA_ERROR', 'Video playback failed')); };
  const ended = () => { if (performance.now() < measureDeadline) { measurement.close(performance.now()); local.abort(fault('VIDEO_ENDED', 'Video ended before measurement completed')); } };
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  video.addEventListener('error', mediaError); video.addEventListener('ended', ended);
  const setPhase = value => { phase = value; onPhase(value); };
  const processFrame = async (metadata, deadline, frame = null) => {
    try {
      check(local.signal);
      if (performance.now() >= deadline) { measurement.discard(frame, 'deadline'); return null; }
      if (client) {
        const out = await client.frame(video, metadata, local.signal, deadline, undefined, {
          telemetry: { telemetryEnabled: config.telemetryEnabled, telemetryCadenceMs: config.telemetryCadenceMs },
          onSending: () => { if (frame) frame.stage = 'send'; },
          onSubmitted: () => measurement.submit(frame),
        });
        telemetry?.memory(out?.wasmLinearMemoryBytes);
        if (!out) measurement.discard(frame, 'deadline');
        return out;
      }
      measurement.submit(frame);
      const drawStart = performance.now();
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const drawMs = performance.now() - drawStart;
      const readbackStart = performance.now();
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const readbackMs = performance.now() - readbackStart;
      const readbackBytes = image?.data?.byteLength ?? image?.data?.length ?? (width * height * 4);
      const out = engine.process(image);
      const frameRgbaBytes = out.frameRgbaBytes ?? readbackBytes;
      const wasmCopyBytes = out.wasmCopyBytes ?? frameRgbaBytes;
      return { ...out, frameRgbaBytes, readbackBytes, wasmCopyBytes, receivedAt: performance.now(), profile: { ...out.profile, drawMs, readbackMs } };
    } catch (caught) {
      measurement.close(caught.observedAt ?? performance.now());
      if (frame?.state === 'observed') {
        measurement.discard(frame, local.signal.aborted ? 'cancelled' : frame.stage === 'send' ? 'sendError' : 'captureError');
      } else measurement.fail(frame, !client || caught.workerConfirmed === true);
      throw caught;
    }
  };
  try {
    setPhase('initializing');
    if (!Number.isFinite(config.measureMs) || config.measureMs <= 0 || config.measureMs > SAMPLE_BUDGET.maxDurationMs) throw fault('INVALID_CONFIG', 'Measurement must be positive and at most 24 hours');
    check(local.signal);
    if (!dependencies.engineFactory && !dependencies.workerFactory) capabilityReport = preflight(mode);
    if (mode === 'main') engine = await initializeMain(dependencies.engineFactory || createWasmEngine, local.signal);
    else {
      client = new WorkerClient(dependencies.workerFactory ? dependencies.workerFactory() : new Worker(new URL('./worker/analysis.worker.js', import.meta.url), { type: 'module' }));
      await client.init(local.signal);
    }
    telemetry = observeTelemetry(video, engine, config);
    check(local.signal); setPhase('seeking'); await seekStart(video, local.signal);
    check(local.signal);
    await waitFor(video.play(), { signal: local.signal, timeout: LIMITS.media, code: 'PLAY_TIMEOUT', onLate: () => { if (videoOwners.get(video) === local) video.pause(); } });
    check(local.signal); setPhase('warmup');
    let deadline = performance.now() + config.warmupMs;
    while (performance.now() < deadline) {
      const metadata = await nextFrame(video, local.signal, deadline); if (!metadata) break;
      await processFrame(metadata, deadline);
    }
    check(local.signal); setPhase('measuring'); check(local.signal);
    const start = performance.now(); measurement.begin(start, config.measureMs); longStats.begin(start);
    deadline = measurement.deadline; measureDeadline = deadline;
    while (performance.now() < deadline) {
      samples.check();
      activeFrame = null;
      const metadata = await nextFrame(video, local.signal, deadline, LIMITS.frame, (metadata, now) => {
        activeFrame = measurement.observe(metadata, now);
        if (activeFrame) longStats.callback(now);
      });
      if (!metadata) break;
      if (longStats.budgetError) throw longStats.budgetError;
      const out = await processFrame(metadata, deadline, activeFrame);
      if (out) {
        telemetry?.memory(out.wasmLinearMemoryBytes);
        if (measurement.complete(activeFrame, out.receivedAt)) {
          const e2e = out.receivedAt - activeFrame.receivedAt;
          const nonCoreMs = Math.max(0, e2e - out.coreMs);
          const frameRgbaBytes = out.frameRgbaBytes ?? (width * height * 4);
          const sample = { core: out.coreMs, e2e, frameRgbaBytes,
            readbackBytes: out.readbackBytes ?? frameRgbaBytes,
            wasmCopyBytes: out.wasmCopyBytes ?? frameRgbaBytes,
            profile: { ...out.profile, coreMs: out.coreMs, nonCoreMs, e2eMs: e2e } };
          longStats.complete(sample, out.receivedAt);
        }
      }
    }
    check(local.signal);
  } catch (caught) {
    measurement.close(caught.observedAt ?? performance.now());
    measurement.discard(activeFrame, local.signal.aborted ? 'cancelled' : 'captureError');
    measurement.fail(activeFrame, false);
    error = caught; status = caught.code === 'ABORTED' ? 'stopped' : 'failed';
  }
  finally {
    telemetry?.stop();
    const settled = performance.now();
    // Normal completion closes at the intended deadline, not when the event loop wakes.
    measurement.close(status === 'ok' ? measurement.deadline : settled);
    measurement.settled = settled;
    measurement.cleanupStart = performance.now();
    video.removeEventListener('error', mediaError); video.removeEventListener('ended', ended); signal.removeEventListener('abort', abort);
    video.pause(); onPhase('cleaning-up');
    try { if (client) cleanup = await client.close(); else if (engine) engine.dispose(); else if (mainInitializationPending() || mode === 'main') cleanup = { ...mainInitializationCleanup() }; }
    catch (caught) { cleanup = { cleanupStatus: 'forced', cleanupError: caught.message }; }
    measurement.cleanupEnd = cleanup.cleanupStatus === 'pending' ? null : performance.now();
  }
  if (cleanup.cleanupStatus === 'forced' && status === 'ok') { status = 'failed'; phase = 'cleaning-up'; error = fault('CLEANUP_FAILED', cleanup.cleanupError); }
  const visibilityInterrupted = visibility.interrupted === true;
  const previousError = visibilityInterrupted && error && error.code !== 'PAGE_HIDDEN'
    ? { code: error.code || 'RUN_ERROR', message: error.message } : null;
  if (visibilityInterrupted) {
    status = 'failed'; phase = visibility.phase || phase;
    error = fault('PAGE_HIDDEN', 'Page hidden during the session');
  }
  const observedAt = visibilityInterrupted ? visibility.observedAt : null;
  // Events exactly at the configured final deadline are recorded only on the run/session.
  const markedAt = observedAt != null && observedAt < measurement.deadline ? observedAt : null;
  const collected = longStats.result(measurement.end, markedAt);
  windows.push(...collected.windows);
  return { ...summarize(samples, engineName, extended, diagnostic), ...collected.summary,
    visibilityTimestampScope: 'main-thread-event-observation-relative-to-measurement-start',
    previousError, visibilityInterrupted, visibilityObservedAtMs: measurement.start == null || observedAt == null ? null : observedAt - measurement.start,
    ...measurement.result(), status, capabilities: capabilityReport, telemetry: telemetry?.result ?? null,
    phase: status === 'ok' ? 'complete' : phase, errorCode: error?.code || (error ? 'RUN_ERROR' : null), errorMessage: error?.message || null, ...cleanup };
}
