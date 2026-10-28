source ~/emsdk/emsdk_env.sh
emcc --version
./run.sh

## Benchmark lifecycle and measurement (schema v5)

Benchmark and Diagnostic share `js/lifecycle.js`, `js/benchmark.js`,
`js/measurement.js`, `js/long_run_stats.js` and `js/page.js` inside this repository. WASM/worker
initialization finishes before seek and warm-up. Stop cancels frame waits and
cooldown; errors stop the session and preserve partial results. Synchronous
WASM on main cannot be interrupted until it returns to the event loop.

Timeouts: initialization 30 s, seek/play/frame/worker request 10 s, cleanup 2 s.
Worker cleanup uses STOP/STOPPED before termination. A late main initialization
keeps Run locked until its factory settles and its resources are disposed.
Reload if initialization never settles. `cleanupStatus: pending` means that
cleanup has not finished; `forced` means graceful cleanup was not confirmed.
Cleanup timing is null when it could not be finalized before returning the result.

### Counters

Only measurement callbacks/jobs count; warm-up is excluded.

| Field | Meaning |
| --- | --- |
| callbackFrames | Callbacks observed inside the measurement window |
| submittedFrames | Main: immediately before drawImage; worker: successful FRAME postMessage |
| completedWithinWindow | Result observed on main strictly before the window closes |
| completedAfterDeadline | Submitted before the deadline, result observed at/after it |
| failedFrames | Submitted job with a confirmed processing error |
| unconfirmedFrames | Submitted job without a confirmed outcome after cancellation, timeout or crash |
| notSubmittedFrames | Observed callback that did not become a submitted job |
| notSubmittedReasons | Counts for deadline, cancelled, captureError and sendError |
| droppedWhileBusy | null: the sequential scheduler does not observe callbacks while processing |

Every job has one terminal outcome. At the end of a run:

```text
callbackFrames = submittedFrames + notSubmittedFrames
submittedFrames = completedWithinWindow + completedAfterDeadline + failedFrames + unconfirmedFrames
```

A timed-out/terminated worker may have processed its frame; it is unconfirmed,
not a confirmed processing failure. Late responses cannot count a job twice.
A bitmap created beyond the deadline is closed without submitting it.

### Compositor observation

`presentedFramesDelta = lastPresentedFrame - firstPresentedFrame` and
`missedCallbackFrames = sum(max(0, currentPresented - previousPresented - 1))`
cover only the span between observed callbacks, not all source frames in the
measurement window. First/last callback times are relative to measurement start.
One valid callback yields zero delta/missed count and a zero-length observation span.

`compositorStatus` is valid, no-callbacks, invalid (missing/invalid/decreasing
metadata), or unavailable (requestAnimationFrame fallback). Compositor counters
are null unless valid. Fallback still counts callbacks and processing jobs but
may process the same video frame repeatedly. No source-frame drop rate is inferred.

### Timing and exports

All boundary timestamps use main-thread performance.now(); exported timestamps
are milliseconds relative to measurement start. Normal measurement closes at the
configured deadline; Stop/error closes it at the main-thread observation time,
capped at that deadline. Results exactly at the deadline count as late.

`completedFps = completedWithinWindow * 1000 / measurementElapsedMs`.
Settle (waiting after window close) and cleanup durations are exported separately
and never enter the FPS denominator. Before measurement starts, duration/FPS are
null. A positive measurement duration with no completions yields FPS 0; latency
remains null. Latency mean/percentiles use only `completedWithinWindow` samples,
identified by `latencySampleScope` and `latencySampleCount`.

JSON and both CSV exports use schemaVersion 5. Old aggregate totalFrames, processedFrames,
skippedFrames, skippedRate, fps/processedFps fields are removed, not aliased.
Diagnostic metrics stay at the top level of its JSON. JSON keeps reason counts
in notSubmittedReasons; CSV flattens them into notSubmittedDeadline,
notSubmittedCancelled, notSubmittedCaptureError and notSubmittedSendError.
Missing values display as an em dash, export as JSON null / empty CSV fields.

### Minute windows (both Benchmark and Diagnostic)

The same collector handles main and worker. Windows are fixed half-open intervals
[0, 60000), [60000, 120000), etc., relative to each engine's measurement start.
The final window is truncated at measurementEnd. Zero-length windows are omitted;
positive-duration windows with no completions remain, with FPS 0 and null latency.
Window indices are zero-based. A completion exactly at 60000 ms belongs to index 1;
a completion at the full-run deadline belongs only to completedAfterDeadline.

Each window contains engine, index, startMs/endMs/durationMs, partial,
completedWithinWindow, completedFps, core/e2e mean/P95/P99, main-thread long-task
metrics, observed WASM capacity and visibilityInterrupted. Window FPS uses its
actual duration. Overall percentiles still use all within-window samples; they
are never calculated by averaging minute percentiles. Counts and durations across
windows sum to the overall measurement counts and duration.

JSON contains the windows array on both pages. Download CSV exports overall
results; Download Windows CSV exports one row per window. Expand the window table
under each engine to inspect time ranges and all exported fields. The old window,
fps, wasm, longTasks, blockingMs and wasmPeakBytes fields are replaced by the new
explicit fields; the previous legacy-window warning is removed.

### Main-thread long tasks

The observer starts before measurement and stores entries until finalization.
Finalization yields one event-loop task, takes remaining records, then disconnects.
Only overlap with the measurement interval is counted, excluding warm-up, settle
and cleanup portions. Per-window long-task duration is the intersection with the
entry's [startTime, startTime + duration). Blocking duration is the intersection
with [startTime + 50, startTime + duration); the 50 ms allowance is not subtracted
again at each minute boundary.

mainThreadLongTasksOverlapping counts each overlapping entry once per interval.
An entry crossing a minute boundary counts in both windows, so window task counts
must not be summed to obtain the overall task count. Durations can be summed.
These metrics describe the main thread, including in worker mode; they do not
measure worker CPU time. Unsupported observation has longTasksSupported=false
and null task metrics.

### WASM memory

wasmLinearMemoryLastObservedBytes and wasmLinearMemoryObservedPeakBytes represent
HEAPU8.buffer.byteLength: observed linear-memory capacity, not allocated/used heap
or total RAM used by the browser, bitmaps or workers. The baseline is captured
after warm-up (directly from main engine, or READY/latest warm-up result for worker).
Only successful results received during measurement update observations. Last
known capacity carries into the next window, including empty windows. No value is
inferred for a cancelled/timed-out request; missing observations remain null.

### Page visibility

A hidden page is rejected before engine startup. During initialization, warm-up,
measurement, cooldown or cleanup, visibilitychange to hidden stops the entire
session with failed/PAGE_HIDDEN, retains partial results, and skips subsequent
modes. No automatic resume occurs. An existing error is retained as previousError
when the visibility error takes priority.

Session visibilityObservedAtMs is relative to session start; per-engine
visibilityObservedAtMs is relative to measurement start (null before measurement).
Both record main-thread event handling, which can lag the actual visibility change
while main is blocked in synchronous WASM. The event truncating a partial minute
marks that nominal minute; an event exactly on a final minute/full-run boundary
is only recorded on the engine/session, with no zero-length window created.
During cooldown, completed engine results remain unchanged and the interruption
is recorded at session level. Listeners are removed at session end.

C++/SIMD/4 pthreads, sequential admission, schema-v3 frame-counter definitions,
aggregate FPS denominator and per-stage profiling are unchanged.

Existing regression fixtures are available with `npm test` (Node.js, no dependencies).


### Step profiling (schema v5)

Both Benchmark and Diagnostic instrument main and worker pipelines. Expand
"step timings (ms)" under an engine to inspect count, mean, P50, P95 and P99.
The same distributions are exported under profile in each result and minute window;
overall and windows CSV flatten them as profile.<stage>.<statistic> columns.
Session profiling metadata records clock policy, sample scope and limitations.

| Stage | Timing boundaries |
| --- | --- |
| bitmapMs | Main-side createImageBitmap acquisition, including asynchronous wait |
| drawMs | drawImage call on Canvas/OffscreenCanvas |
| readbackMs | getImageData call |
| wasmCopyMs | HEAPU8.set only; allocation is excluded |
| coreMs | processMotion only |
| workerProcessingMs | Worker FRAME handler processing, including canvas setup/allocation and result preparation, before posting result |
| workerRoundTripMs | Main timestamp immediately before postMessage to receipt of RESULT on main; includes worker processing |
| workerTransportAndSchedulingMs | Round trip minus worker handler duration; an estimate of transport, queueing and scheduling |
| e2eMs | Observed video callback to result available on main |
| callbackGapMs | Time between consecutive observed callbacks during measurement |

Processing distributions use only completedWithinWindow results, excluding warm-up,
late completions, failed/unconfirmed jobs and callbacks never submitted. Callback
gaps use all observed measurement callbacks, even if their processing fails; the
first callback has no gap. Each gap is assigned to its later callback's window,
including a gap spanning a minute boundary. Thus callback-gap sample counts may
differ from processing-stage counts. No average of window percentiles is used.

Worker durations use the worker's local clock. Round trip and end-to-end use only
the main clock; timestamps from different contexts are never subtracted. The
transport/scheduling residual is not pure message overhead and can be slightly
negative because of clock precision. It remains signed rather than being clamped.
Round trip includes processing, so all profile stages must not be added together.
Worker handler duration excludes its final bitmap cleanup after posting RESULT.
End-to-end excludes waiting for a callback and full video decode/display latency.

On main, worker-only and bitmap metrics have count 0 and null summary values,
not a fabricated duration of zero. Empty distributions also have null values.
Profiling is enabled for both engines and adds timer/aggregation overhead; compare
runs made with the same instrumentation and settings. Frame-count definitions,
scheduler, C++ and pthread configuration are unchanged.
