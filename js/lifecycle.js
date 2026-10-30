export const LIMITS = Object.freeze({ init: 30000, media: 10000, frame: 10000, cleanup: 2000 });
export const fault = (code, message) => Object.assign(new Error(message), { code, observedAt: performance.now() });
export const aborted = () => fault('ABORTED', 'Stopped by user');
export function check(signal) { if (signal?.aborted) throw signal.reason || aborted(); }

// A bounded wait owns every listener/timer it installs. Late resources remain owned
// by their producer and are released through onLate.
export function waitFor(promise, { signal, timeout, code = 'TIMEOUT', onLate } = {}) {
  return new Promise((resolve, reject) => {
    let done = false, timer;
    const finish = (error, value) => {
      if (done) return false;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      error ? reject(error) : resolve(value); return true;
    };
    const cancel = () => finish(signal.reason || aborted());
    Promise.resolve(promise).then(value => { if (!finish(null, value)) onLate?.(value); }, error => finish(error));
    if (signal?.aborted) cancel();
    else { signal?.addEventListener('abort', cancel, { once: true }); if (timeout != null) timer = setTimeout(() => finish(fault(code, `${code} after ${timeout} ms`)), timeout); }
  });
}
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
    const cancel = () => { cleanup(); reject(signal.reason || aborted()); };
    if (signal?.aborted) return cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => { cleanup(); resolve(); }, ms);
  });
}
export function seekStart(video, signal, timeout = LIMITS.media) {
  check(signal);
  if (video.currentTime === 0 && !video.seeking && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer, sought = false;
    const cleanup = () => { clearTimeout(timer); for (const [name, fn] of events) video.removeEventListener(name, fn); signal?.removeEventListener('abort', cancel); };
    const finish = error => { cleanup(); error ? reject(error) : resolve(); };
    const ready = () => { if (sought && !video.seeking && video.readyState >= 2) finish(); };
    const seeked = () => { sought = true; ready(); };
    const cancel = () => finish(signal.reason || aborted());
    const events = [['seeked', seeked], ['loadeddata', ready], ['canplay', ready], ['error', () => finish(fault('MEDIA_ERROR', 'Video failed during seek'))]];
    for (const [name, fn] of events) video.addEventListener(name, fn);
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => finish(fault('SEEK_TIMEOUT', 'Video seek timed out')), timeout);
    try { video.currentTime = 0; } catch (error) { finish(error); }
  });
}
export function nextFrame(video, signal, deadline, timeout = LIMITS.frame, onObserved) {
  return new Promise((resolve, reject) => {
    let handle, timer, done = false;
    const rvfc = typeof video.requestVideoFrameCallback === 'function';
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer);
      if (handle != null) { if (rvfc) video.cancelVideoFrameCallback(handle); else cancelAnimationFrame(handle); }
      signal?.removeEventListener('abort', cancel); video.removeEventListener('ended', ended); video.removeEventListener('error', failed);
      error ? reject(error) : resolve(value);
    };
    const cancel = () => finish(signal.reason || aborted());
    const ended = () => finish(fault('VIDEO_ENDED', 'Video ended before measurement completed'));
    const failed = () => finish(fault('MEDIA_ERROR', 'Video playback failed'));
    if (signal?.aborted) return cancel();
    const remaining = deadline - performance.now();
    if (remaining <= 0) return finish(null, null);
    if (video.error) return failed();
    if (video.ended) return ended();
    signal?.addEventListener('abort', cancel, { once: true }); video.addEventListener('ended', ended); video.addEventListener('error', failed);
    const timeoutAt = performance.now() + timeout;
    const armTimer = () => {
      const now = performance.now();
      if (now >= deadline) return finish(null, null);
      if (now >= timeoutAt) return finish(fault('FRAME_TIMEOUT', 'No video frame received'));
      timer = setTimeout(armTimer, Math.max(1, Math.min(deadline, timeoutAt) - now));
    };
    armTimer();
    if (done) return;
    try {
      const received = metadata => {
        if (done) return;
        metadata ??= {};
        const observedAt = performance.now();
        if (observedAt >= deadline) return finish(null, null);
        onObserved?.(metadata, observedAt);
        finish(null, metadata);
      };
      handle = rvfc ? video.requestVideoFrameCallback((_, metadata) => received(metadata))
        : requestAnimationFrame(timestamp => received({ presentedFrames: null, timestamp }));
    } catch (error) { finish(error); }
  });
}

let mainPending = false;
let mainCleanup = { cleanupStatus: 'ok' };
export function mainInitializationPending() { return mainPending; }
export function mainInitializationCleanup() { return mainCleanup; }
export async function initializeMain(factory, signal, timeout = LIMITS.init) {
  check(signal);
  if (mainPending) throw fault('INIT_PENDING', 'Previous WASM initialization is still pending; reload to recover');
  mainPending = true;
  mainCleanup = { cleanupStatus: 'pending' };
  const pending = Promise.resolve().then(factory).catch(error => {
    mainPending = false; mainCleanup.cleanupStatus = 'ok'; throw error;
  });
  try {
    const engine = await waitFor(pending, {
      signal, timeout, code: 'INIT_TIMEOUT',
      onLate: engine => {
        try { engine.dispose(); mainCleanup.cleanupStatus = 'ok'; }
        catch (error) { mainCleanup.cleanupStatus = 'forced'; mainCleanup.cleanupError = error.message; }
        finally { mainPending = false; }
      },
    });
    mainPending = false; mainCleanup.cleanupStatus = 'ok'; return engine;
  } catch (error) {
    // An aborted factory still owns its pthread pool until it settles.
    throw error;
  }
}

export class WorkerClient {
  constructor(worker, limits = LIMITS) {
    this.worker = worker; this.limits = limits; this.pending = new Map(); this.id = 0; this.failure = null;
    worker.onmessage = ({ data }) => {
      const item = this.pending.get(data?.requestId);
      if (!item) return;
      if (data.type === 'error') { const error = fault(data.code || 'WORKER_ERROR', data.message || 'Worker error'); error.workerConfirmed = true; this.fail(error); }
      else if (data.type === item.expected) item.finish(null, { ...data, receivedAt: performance.now() });
      else this.fail(fault('WORKER_PROTOCOL', `Unexpected worker response: ${data.type}`));
    };
    worker.onerror = event => { event.preventDefault?.(); this.fail(fault('WORKER_CRASH', event.message || 'Worker crashed')); };
    worker.onmessageerror = () => this.fail(fault('WORKER_MESSAGE_ERROR', 'Unable to deserialize worker message'));
  }
  fail(error) { this.failure ||= error; for (const item of [...this.pending.values()]) item.finish(error); }
  request(type, expected, payload = {}, transfer = [], signal, timeout = this.limits.frame, onSubmitted) {
    if (this.failure && type !== 'stop') return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(signal.reason || aborted());
    return new Promise((resolve, reject) => {
      const requestId = ++this.id; let timer;
      const cancel = () => finish(signal.reason || aborted());
      const finish = (error, value) => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId); clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        error ? reject(error) : resolve(value);
      };
      this.pending.set(requestId, { expected, finish });
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => this.fail(fault('WORKER_TIMEOUT', `${type} timed out`)), timeout);
      try {
        const sentAt = performance.now();
        this.worker.postMessage({ ...payload, type, requestId }, transfer); onSubmitted?.(sentAt);
      }
      catch (error) { this.fail(fault('WORKER_POST_ERROR', error.message)); }
    });
  }
  init(signal) { return this.request('init', 'ready', {}, [], signal, this.limits.init); }
  async frame(video, metadata, signal, deadline, bitmapFactory = createImageBitmap, hooks = {}) {
    check(signal);
    const bitmapStart = performance.now();
    const bitmap = await waitFor(Promise.resolve().then(() => bitmapFactory(video)), {
      signal, timeout: this.limits.frame, code: 'BITMAP_TIMEOUT', onLate: bitmap => bitmap.close(),
    });
    const bitmapMs = performance.now() - bitmapStart;
    let transferred = false, sentAt = null;
    try {
      check(signal);
      if (performance.now() >= deadline) return null;
      hooks.onSending?.();
      const result = this.request('frame', 'result', { frameId: this.id + 1, mediaTime: metadata.mediaTime,
        presentedFrames: metadata.presentedFrames, width: video.videoWidth, height: video.videoHeight, bitmap, ...hooks.telemetry }, [bitmap], signal, this.limits.frame, timestamp => { sentAt = timestamp; transferred = true; hooks.onSubmitted?.(); });
      const out = await result;
      const workerRoundTripMs = out.receivedAt - sentAt;
      const workerProcessingMs = out.profile?.workerProcessingMs;
      return { ...out, profile: { ...out.profile, bitmapMs, workerRoundTripMs,
        workerTransportAndSchedulingMs: Number.isFinite(workerProcessingMs) ? workerRoundTripMs - workerProcessingMs : null } };
    } finally { if (!transferred) bitmap.close(); }
  }
  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      let result = { cleanupStatus: 'ok' };
      try { await this.request('stop', 'stopped', {}, [], undefined, this.limits.cleanup); }
      catch (error) { result = { cleanupStatus: 'forced', cleanupError: error.message }; }
      finally {
        this.fail(fault('WORKER_CLOSED', 'Worker closed')); this.worker.terminate();
        this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
      }
      return result;
    })();
    return this.closing;
  }
}
