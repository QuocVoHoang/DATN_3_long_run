// All timestamps use the main thread's performance.now() clock.
export class Measurement {
  constructor(callbackSource) {
    this.callbackSource = callbackSource;
    this.start = this.deadline = this.end = this.settled = this.cleanupStart = this.cleanupEnd = null;
    this.counts = { callbackFrames: 0, submittedFrames: 0, completedWithinWindow: 0,
      completedAfterDeadline: 0, failedFrames: 0, unconfirmedFrames: 0, notSubmittedFrames: 0 };
    this.reasons = { deadline: 0, cancelled: 0, captureError: 0, sendError: 0 };
    this.first = this.last = this.firstAt = this.lastAt = null;
    this.missed = 0;
    this.compositorStatus = callbackSource === 'requestVideoFrameCallback' ? 'no-callbacks' : 'unavailable';
  }
  begin(now, duration) { this.start = now; this.deadline = now + duration; }
  close(now) {
    if (this.start != null && this.end == null) this.end = Math.max(this.start, Math.min(this.deadline, now));
  }
  observe(metadata, now) {
    if (this.start == null || now >= (this.end ?? this.deadline)) return null;
    this.counts.callbackFrames++;
    this.firstAt ??= now; this.lastAt = now;
    if (this.callbackSource === 'requestVideoFrameCallback' && this.compositorStatus !== 'invalid') {
      const value = metadata.presentedFrames;
      if (!Number.isSafeInteger(value) || value < 0 || (this.last != null && value < this.last)) this.compositorStatus = 'invalid';
      else {
        if (this.last != null) this.missed += Math.max(0, value - this.last - 1);
        this.first ??= value; this.last = value; this.compositorStatus = 'valid';
      }
    }
    return { state: 'observed', receivedAt: now, stage: 'capture' };
  }
  submit(frame) {
    if (!frame || frame.state !== 'observed') return;
    frame.state = 'submitted'; this.counts.submittedFrames++;
  }
  discard(frame, reason) {
    if (!frame || frame.state !== 'observed') return;
    frame.state = 'notSubmitted'; this.counts.notSubmittedFrames++; this.reasons[reason]++;
  }
  complete(frame, now) {
    if (!frame || frame.state !== 'submitted') return false;
    const within = now < (this.end ?? this.deadline);
    frame.state = within ? 'within' : 'late';
    this.counts[within ? 'completedWithinWindow' : 'completedAfterDeadline']++;
    return within;
  }
  fail(frame, confirmed) {
    if (!frame || frame.state !== 'submitted') return;
    frame.state = confirmed ? 'failed' : 'unconfirmed';
    this.counts[confirmed ? 'failedFrames' : 'unconfirmedFrames']++;
  }
  result() {
    const elapsed = this.start == null || this.end == null ? null : this.end - this.start;
    const valid = this.compositorStatus === 'valid';
    const relative = value => this.start == null || value == null ? null : value - this.start;
    return { ...this.counts, notSubmittedReasons: { ...this.reasons }, droppedWhileBusy: null,
      callbackSource: this.callbackSource, compositorStatus: this.compositorStatus,
      firstPresentedFrame: valid ? this.first : null, lastPresentedFrame: valid ? this.last : null,
      presentedFramesDelta: valid ? this.last - this.first : null, missedCallbackFrames: valid ? this.missed : null,
      firstCallbackMs: relative(this.firstAt), lastCallbackMs: relative(this.lastAt),
      measurementElapsedMs: elapsed,
      settleElapsedMs: this.end == null || this.settled == null ? null : Math.max(0, this.settled - this.end),
      cleanupElapsedMs: this.cleanupEnd == null || this.cleanupStart == null ? null : this.cleanupEnd - this.cleanupStart,
      completedFps: elapsed > 0 ? this.counts.completedWithinWindow * 1000 / elapsed : null,
      measurementStartMs: this.start == null ? null : 0, measurementEndMs: relative(this.end),
      processingSettledMs: relative(this.settled), cleanupFinishedMs: relative(this.cleanupEnd),
      latencySampleCount: this.counts.completedWithinWindow, latencySampleScope: 'completedWithinWindow' };
  }
}
