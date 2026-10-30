source ~/emsdk/emsdk_env.sh
emcc --version
./build_wasm.sh
./run.sh 8091

## Benchmark lifecycle and measurement (schema v6)

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

JSON and both CSV exports use schemaVersion 6. Old aggregate totalFrames, processedFrames,
skippedFrames, skippedRate, fps/processedFps fields are removed, not aliased.
Both pages use the same session envelope, with results[] and windows[]. JSON keeps reason counts
in notSubmittedReasons; CSV uses dotted names such as notSubmittedReasons.deadline.
Missing values display as an em dash, export as JSON null / empty CSV fields.

### Minute windows (both Benchmark and Diagnostic)

The same collector handles main and worker. Windows are fixed half-open intervals
[0, 60000), [60000, 120000), etc., relative to each engine's measurement start.
The final window is truncated at measurementEnd. Zero-length windows are omitted;
positive-duration windows with no completions remain, with FPS 0 and null latency.
Window indices are zero-based. A completion exactly at 60000 ms belongs to index 1;
a completion at the full-run deadline belongs only to completedAfterDeadline.

Each window contains engine, index, startMs/endMs/durationMs, partial,
completedWithinWindow, completedFps, core/e2e mean/P95/P99, RQ6 data cost and
bandwidth metrics, and visibilityInterrupted. Window FPS uses its
actual duration. Overall percentiles still use all within-window samples; they
are never calculated by averaging minute percentiles. Counts and durations across
windows sum to the overall measurement counts and duration.

JSON contains the windows array on both pages. Download CSV exports overall
results at full numeric precision. Download Windows CSV exports each minute window separately. UI values alone are rounded to 3 decimals. Expand the window table
under each engine to inspect time ranges and all exported fields.

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

Existing regression fixtures are available with `npm test` (Node.js and clang++ for the native golden oracle).


### Step profiling (schema v6)

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
| nonCoreMs | Non-core overhead Δ (`max(0, e2eMs - coreMs)`), capturing capture, draw, readback, copy and IPC overhead |
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

### Data volume, memory bandwidth & bottleneck crossover (RQ6)

`js/data_cost.js` quantifies per-frame memory footprint (bytes and decimal MB = `1e6` bytes),
modeled cumulative payload volume (bytes and decimal GB = `1e9` bytes), effective stage payload throughput (`GB/s`),
and the latency crossover between WASM Core and Non-Core stages for both overall runs and
each 1-minute window:

| Field | Meaning |
| --- | --- |
| nonCoreMean / nonCoreP50 / nonCoreP95 / nonCoreP99 | Distribution of `Δ = max(0, e2eMs - coreMs)` across `completedWithinWindow` samples |
| nonCoreSharePct | `((e2eMean - coreMean) / e2eMean) * 100` (percentage of end-to-end latency spent outside WASM core) |
| bottleneckRegime | `'non-core'` when `nonCoreSharePct >= 50`, `'core'` when `< 50` (`null` if no completions) |
| frameRgbaBytes / frameRgbaMB | Raw RGBA buffer size per frame (`4 * width * height`, observed from `image.data.byteLength`) |
| bridgeCopyBytesPerFrame / bridgeCopyMBPerFrame | CPU readback + WASM copy per frame (`getImageData` + `HEAPU8.set` = `2 * frameRgbaBytes`) |
| nonCoreTrafficBytesPerFrame / nonCoreTrafficMBPerFrame | Total non-core pixel traffic per frame (`3 * frameRgbaBytes` on main; `4 * frameRgbaBytes` on worker) |
| coreWorkingSetBytes / coreWorkingSetMB | C++ WASM working set (`13 * width * height` bytes across RGBA input/output, grayscale and blur buffers) |
| totalReadbackBytes / totalReadbackGB | Cumulative bytes/GB read via `getImageData` across `completedWithinWindow` frames |
| totalWasmCopyBytes / totalWasmCopyGB | Cumulative bytes/GB copied via `HEAPU8.set` into WASM linear memory |
| totalBridgeCopyBytes / totalBridgeCopyGB | Cumulative bytes/GB across `getImageData` + `HEAPU8.set` |
| totalNonCoreTrafficBytes / totalNonCoreTrafficGB | Cumulative bytes/GB moved across all non-core stages |
| readbackBandwidthGBps | Effective `getImageData` readback bandwidth (`sum(readbackBytes) / (sum(readbackMs) * 1e6)` in `GB/s`) |
| wasmCopyBandwidthGBps | Effective `HEAPU8.set` copy bandwidth (`sum(wasmCopyBytes) / (sum(wasmCopyMs) * 1e6)` in `GB/s`) |
| bridgeThroughputMBps | Sustained bridge copy throughput over the measurement interval (`MB/s`) |
| nonCoreThroughputMBps | Sustained total non-core data throughput over the measurement interval (`MB/s`) |

### Reproducible artifacts and kernel contract

Use the compiler version recorded in `build/build-manifest.json`, run `./build_wasm.sh`,
then `./run.sh 8091`. Serving never rebuilds. The build removes old generated artifacts;
only emcc generates glue. `EMCC=/path/to/emcc` and `EMSDK_PYTHON=/path/to/python3`
can select a toolchain. Emscripten here requires Python >=3.10. The manifest records
compiler, ordered flags, SHA-256 of source/glue/WASM/build script and a content build ID;
there is no build timestamp. Pin that toolchain when reproducing an artifact. A missing
manifest is exported as null, never inferred from an existing binary.

`ENVIRONMENT=web,worker` is explicit. This is not evidence that the former `web`
setting broke pthreads: Emscripten also adds worker support for pthread builds.
Initial linear memory is 256 MiB, maximum 512 MiB, with growth enabled. At UHD
3840×2160, modeled buffer payload is 13N = 107,827,200 bytes (~102.83 MiB):
input 4N, previous/current/blurred 3N, horizontal uint16 2N and RGBA mask 4N.
Add vertical scratch (4×width bytes), pthread stacks, code/runtime/allocator overhead
and resize transients. 256 MiB provides headroom; 512 MiB is a finite ceiling,
not a device availability guarantee. Emscripten warns that pthreads plus growth may
slow non-WASM code. Input malloc returns a structured WASM_ALLOCATION_FAILED;
C++ catches bad_alloc and reports -2, mapped to that same error. Invalid dimensions
report -1. Runtime initialization/abort failures still stop the run with an error.

13N and the data-cost stage volumes model buffer payload, **not measured DRAM
traffic**, RSS, browser total memory or allocator capacity. Renamed/modeled claims
should be used when reporting these legacy `coreWorkingSet*`/`*Traffic*` fields.

Golden oracles use `(77R+150G+29B)>>8`, radius 3, sum/49 integer truncation,
zero borders and strictly `diff > threshold`. First frame after reset or dimension
change produces black RGB and alpha 255. Native tests exercise actual std::thread
partitions; the test-only browser oracle exercises SIMD tails and partitions 1/2/4
against the built WASM (504 frame cases). The production benchmark stays at four
threads and two modes, including full RGBA mask writes. No JS benchmark engine exists.

Blur scratch/border storage is initialized on dimension changes. Interior cells
are overwritten on every frame; previous and blurred buffers swap. Vertical blur
walks contiguous partition columns within each output row using reusable running sums.
The existing SIMD diff/expand mask path remains. Disassembly contains vector loads,
u8 comparisons, bitmask and swizzle. Gray/blur manual SIMD and LTO are deferred until
comparative measurements justify them. The current create/join dispatch remains;
std::thread create/join does not imply a new browser Worker for every dispatch.
No persistent-pool change or speedup claim is justified by this smoke test.

### LAN HTTPS and capabilities

Local development: `./run.sh 8091`, open `http://localhost:8091/`.
A LAN IP over plain HTTP does not get the localhost secure-context exception.
For another device, create a local development CA, install and explicitly trust its
root on that device, and issue a server certificate whose SAN includes the exact
LAN DNS name/IP you will open. For example with mkcert installed:

```sh
mkcert -install
mkcert -cert-file lan-cert.pem -key-file lan-key.pem localhost 192.168.1.20
./run.sh 8091 --cert lan-cert.pem --key lan-key.pem --lan-host 192.168.1.20
```

Transfer only the CA root certificate to test devices, never the CA private key.
iOS requires installing the profile and enabling full trust under Certificate Trust
Settings; managed-device policies may restrict this. Android trust behavior depends
on browser/OS/policy. Verify the certificate chain and SAN in the actual browser.
Bypassing a self-signed certificate warning does **not** guarantee a trustworthy secure
context or cross-origin isolation. Bind/address/firewall must permit LAN access.
`--lan-host` only prints the URL and must match SAN; it does not discover/change IPs.
Keep private key files out of Git. For TLS localhost, SAN must also include localhost.
The concurrent server sends COOP same-origin, COEP require-corp and CORP same-origin
on all responses, including errors and HEAD responses. TLS mode uses its HTTPS port;
start a separate HTTP server/port when HTTP localhost is needed simultaneously.

Preflight fails explicitly per selected mode for secure context, isolation, SAB and
SIMD. Engine initialization exercises a real tiny kernel with four pthreads and resets
its state; worker initialization additionally tests 2D OffscreenCanvas readback and
bitmap draw/close in the worker. There is no silent engine fallback. Session WakeLock
records unavailable/denied/acquired/released and release events, and releases in finally.
PAGE_HIDDEN still aborts; a lock does not make background measurement valid.

### Bounded exact samples, telemetry and schema policy

Completed samples have one chunked Float64 numeric store; minute windows reference
index ranges, not duplicate sample objects. Profile counts/sums accumulate on admission;
exact percentiles sort numeric copies at finalization, with no average of window
percentiles or approximation. Finalization runs after cleanup. Per mode: at most 250,000
completed samples and 250,000 callback observations, <=40 MiB retained numeric payload
(including callback gaps), and at most 24 hours/1,440 minute windows. This is not a bound
on temporary export/sort objects, WASM or whole-browser memory. Reaching the sample
budget stops with SAMPLE_BUDGET_EXCEEDED and exports partial results. Research defaults
remain 5-minute warmup, 30-minute measurement, 5-minute cooldown.

`telemetry` is separate from measurement counters. Decoder observations use
getVideoPlaybackQuality deltas between cadence endpoints; unavailable/reset/decreasing
counters give null, never fabricated zeros. These cadence windows include warmup and
measurement, use main performance.now timestamps, and differ from measurement minutes.
`wasmLinearMemory` observes HEAPU8.buffer.byteLength in the owning context (worker sends
its own observation). Browser memory optionally observes nonstandard performance.memory
with explicit source/status; it is JS heap information, not process RSS. An independent
main requestAnimationFrame observer reports count/sum/max gaps; it is distinct from
video callback timing and may be delayed by main-thread WASM. Telemetry defaults on at
1,000 ms, configurable via runMode config.telemetryEnabled/telemetryCadenceMs (minimum
250 ms); metadata records the settings. Cadence history stops after 10,000 observations
and marks truncated. Timers and rAF are cancelled in finally. No heavy memory snapshot
API runs on the frame path. Stage timing instrumentation remains enabled.

Schema v6 unifies Diagnostic JSON with the benchmark session envelope. JSON records
session/config, build, device (unknown APIs null), video, capabilities, mode order,
instrumentation, results and windows. Pure `js/serialization.js` owns both CSV exports
and JSON. Overall CSV includes all result fields, counters, errors, cleanup, config,
data cost and PROFILE_COLUMNS. Windows CSV has separate records and a separate button
on both pages. CSV uses dotted nested field names, RFC-style quotes/CRLF, full numeric
precision and empty fields for null/unavailable. Breaking field/meaning/shape changes
increment schemaVersion; additive optional fields may remain within a version. Importers
must branch on schemaVersion and tolerate unknown optional columns.

### Verification and device validation

```sh
npm ci
npm test
npm run fixture                  # ffmpeg: deterministic testsrc2, 320x180/30fps, 2 s
npx playwright install chromium  # or use installed Chrome below
npm run smoke
# macOS alternative:
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run smoke
python3 tests/server_test.py
```

Fixture generation removes metadata and uses one encoder thread. Exact compressed bytes
can vary with ffmpeg/libx264 versions; golden kernel inputs use a fixed PRNG seed instead.
Smoke uses short timings explicitly; it does not change page research defaults. It checks
the actual artifact oracle, video pipeline, both modes, counters and acknowledged cleanup.
Automated desktop Chromium smoke is not evidence for Safari/iOS, mobile WakeLock, trusted
LAN TLS, sustained 4K throughput, thermal behavior or browser/device support. Measure those
on the intended devices before reporting support, performance or thread-overhead benefits.
