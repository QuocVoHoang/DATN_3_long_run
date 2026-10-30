import { serializeJson, serializeCsv, SCHEMA_VERSION } from './serialization.js';
import { sessionMetadata, acquireWakeLock } from './preflight.js';
import { PROFILE_STAGES, PROFILE_STATISTICS, PROFILE_LABELS, PROFILING_METADATA, profileField } from './profiling.js';
import { DATA_COST_COLUMNS, DATA_COST_LABELS, DATA_COST_METADATA } from './data_cost.js';
import { runMode } from './benchmark.js';
import { delay, aborted, fault, mainInitializationPending, mainInitializationCleanup } from './lifecycle.js';
const FRAME_COLUMNS = ['engine','status','callbackFrames','completedWithinWindow','missedCallbackFrames','completedFps'];
const SHORT_COLUMNS = [...FRAME_COLUMNS,'coreMean','endToEndMean','coreP50','coreP95','coreP99'];
const LONG_COLUMNS = [...FRAME_COLUMNS,'coreMean','coreP95','coreP99','e2eMean','e2eP95','e2eP99',...DATA_COST_COLUMNS];
const WINDOW_DISPLAY = ['index','startMs','endMs','durationMs','completedWithinWindow','completedFps','coreMean','coreP95','e2eMean','e2eP95',...DATA_COST_COLUMNS];
const DETAIL_COLUMNS = ['submittedFrames','completedAfterDeadline','failedFrames','unconfirmedFrames','notSubmittedFrames',
  'callbackSource','compositorStatus','presentedFramesDelta','measurementElapsedMs',
  'frameRgbaMB','bridgeCopyMBPerFrame','coreWorkingSetMB','readbackBandwidthGBps','nonCoreThroughputMBps'];
const LABELS = { engine: 'Engine', status: 'Status', callbackFrames: 'Callbacks', submittedFrames: 'Submitted',
  completedWithinWindow: 'Completed in window', completedAfterDeadline: 'Completed after deadline',
  missedCallbackFrames: 'Missed callbacks', failedFrames: 'Failed',
  unconfirmedFrames: 'Unconfirmed', completedFps: 'Completed FPS', coreMean: 'Core mean (ms)', coreP50: 'Core P50 (ms)',
  coreP95: 'Core P95 (ms)', coreP99: 'Core P99 (ms)', endToEndMean: 'e2e mean (ms)', e2eMean: 'e2e mean (ms)',
  e2eP95: 'e2e P95 (ms)', e2eP99: 'e2e P99 (ms)',
  index: 'Window index', startMs: 'Start (ms)', endMs: 'End (ms)', durationMs: 'Duration (ms)', ...DATA_COST_LABELS };
export function formatCsvValue(value) {
  if (value == null || Number.isNaN(value)) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3);
  return String(value);
}
function field(result, key) {
  if (key.startsWith('profile.')) return profileField(result, key);
  const reasons = { notSubmittedDeadline: 'deadline', notSubmittedCancelled: 'cancelled', notSubmittedCaptureError: 'captureError', notSubmittedSendError: 'sendError' };
  return key === 'engine' ? result.engine || result.mode : key === 'previousErrorCode' ? result.previousError?.code : key === 'previousErrorMessage' ? result.previousError?.message : reasons[key] ? result.notSubmittedReasons?.[reasons[key]] : result[key];
}
export function setupPage({ longRun = false, diagnostic = false } = {}) {
  const $ = selector => document.querySelector(selector);
  const file = $(diagnostic ? '#file' : '#videoFile'), run = $('#run'), stop = $('#stop'), video = $('#video'), canvas = $('#canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true }), status = $('#status');
  const json = $(diagnostic ? '#json' : '#downloadJson'), csv = $(diagnostic ? '#csv' : '#downloadCsv');
  const windowsCsv = document.createElement('button'); windowsCsv.textContent = 'Download Windows CSV'; windowsCsv.disabled = true; csv.after(windowsCsv);
  const body = $(diagnostic ? '#result' : '#metrics'), warmup = $('#warmup'), measure = $(diagnostic ? '#measure' : '#duration'), rest = $('#rest'), mode = $('#mode');
  const controls = [file, warmup, measure, rest, mode].filter(Boolean);
  const extended = longRun, columns = extended ? LONG_COLUMNS : SHORT_COLUMNS;
  const table = body.closest('table'), header = table.querySelector('thead tr');
  header.replaceChildren();
  for (const key of columns) {
    const cell = document.createElement('th'); cell.textContent = LABELS[key] || key; header.append(cell);
  }
  const detailContainer = document.createElement('div'); table.parentElement.append(detailContainer);
  let url, active = false, controller, session = null, ready = false;
  const format = value => value == null ? '—' : typeof value === 'number' ? (Number.isInteger(value) ? String(value) : value.toFixed(3)) : String(value);
  const render = () => {
    body.replaceChildren(); detailContainer.replaceChildren();
    for (const result of session?.results || []) {
      const row = document.createElement('tr');
      for (const key of columns) {
        const cell = document.createElement('td'); cell.textContent = format(field(result, key)); row.append(cell);
      }
      row.title = [result.phase, result.errorMessage, result.cleanupError].filter(Boolean).join(' | '); body.append(row);
      const details = document.createElement('details'), summary = document.createElement('summary'), description = document.createElement('p'), values = document.createElement('dl');
      summary.textContent = `${field(result, 'engine')} — measurement details`;
      description.textContent = 'Compositor counts cover only the observed callback span, not all source frames. Busy drops are not measured by this sequential scheduler. requestAnimationFrame may process the same video frame repeatedly. Latency uses only completions inside the measurement window.';
      description.textContent += ' Visibility timestamps record when main handled the event and may be delayed by synchronous WASM.';
      details.append(summary, description);
      for (const key of DETAIL_COLUMNS) {
        const term = document.createElement('dt'), value = document.createElement('dd');
        term.textContent = LABELS[key] || key; value.textContent = format(field(result, key)); values.append(term, value);
      }
      details.append(values); detailContainer.append(details);
      const profiling = document.createElement('details'), profileTitle = document.createElement('summary'), note = document.createElement('p');
      profileTitle.textContent = `${field(result, 'engine')} — step timings (ms)`;
      note.textContent = 'Processing stages use only results completed inside the measurement window; callback gaps use consecutive observed callbacks. Round trip includes worker processing. The residual includes transport, queueing and scheduling; it is not pure message cost. Worker-only stages are unavailable on main. Instrumentation adds overhead.';
      const profileTable = document.createElement('table'), profileHead = document.createElement('thead'), profileHeading = document.createElement('tr'), profileRows = document.createElement('tbody');
      for (const label of ['Stage', 'Samples', 'Mean (ms)', 'P50 (ms)', 'P95 (ms)', 'P99 (ms)']) {
        const cell = document.createElement('th'); cell.textContent = label; profileHeading.append(cell);
      }
      profileHead.append(profileHeading);
      for (const stage of PROFILE_STAGES) {
        const row = document.createElement('tr'), name = document.createElement('td'); name.textContent = PROFILE_LABELS[stage]; row.append(name);
        for (const stat of PROFILE_STATISTICS) { const cell = document.createElement('td'); cell.textContent = format(result.profile?.[stage]?.[stat]); row.append(cell); }
        profileRows.append(row);
      }
      profileTable.append(profileHead, profileRows); profiling.append(profileTitle, note, profileTable); detailContainer.append(profiling);
      const modeWindows = session.windows.filter(window => window.engine === field(result, 'engine'));
      if (modeWindows.length) {
        const section = document.createElement('details'), title = document.createElement('summary'), scroll = document.createElement('div');
        title.textContent = `${field(result, 'engine')} — ${modeWindows.length} minute windows`;
        const windowTable = document.createElement('table'), head = document.createElement('thead'), heading = document.createElement('tr'), rows = document.createElement('tbody');
        for (const key of WINDOW_DISPLAY) { const cell = document.createElement('th'); cell.textContent = LABELS[key] || key; heading.append(cell); }
        head.append(heading);
        for (const window of modeWindows) {
          const row = document.createElement('tr');
          row.title = window.visibilityInterrupted ? 'Interrupted because the page was hidden' : window.partial ? 'Partial final window' : 'Full minute';
          for (const key of WINDOW_DISPLAY) { const cell = document.createElement('td'); cell.textContent = format(window[key]); row.append(cell); }
          rows.append(row);
        }
        windowTable.append(head, rows); scroll.style.overflowX = 'auto'; scroll.append(windowTable); section.append(title, scroll);
        const rawDetails = document.createElement('details'), rawTitle = document.createElement('summary'), raw = document.createElement('pre');
        rawTitle.textContent = 'All window fields'; raw.textContent = JSON.stringify(modeWindows, null, 2); rawDetails.append(rawTitle, raw); section.append(rawDetails);
        detailContainer.append(section);
      }
    }
  };
  const refreshRun = () => { run.disabled = active || !ready || mainInitializationPending(); };
  file.onchange = () => {
    ready = false; refreshRun(); json.disabled = csv.disabled = windowsCsv.disabled = true; session = null; body.replaceChildren(); detailContainer.replaceChildren();
    if (url) URL.revokeObjectURL(url);
    const selected = file.files?.[0]; if (!selected) return;
    video.loop = longRun; url = URL.createObjectURL(selected); video.src = url;
  };
  video.onloadedmetadata = () => {
    ready = Number.isFinite(video.duration) && video.duration > 0 && video.videoWidth > 0 && video.videoHeight > 0;
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    if ($('#meta')) $('#meta').textContent = `${video.videoWidth}×${video.videoHeight}, ${video.duration.toFixed(1)} s`;
    status.textContent = ready ? 'Ready' : 'Invalid video metadata'; refreshRun();
  };
  video.addEventListener('error', () => { if (!active) { ready = false; status.textContent = 'Video could not be loaded'; refreshRun(); } });
  stop.onclick = () => { controller?.abort(aborted()); stop.disabled = true; status.textContent = 'Stopping…'; };
  run.onclick = async () => {
    if (active || mainInitializationPending()) return;
    json.disabled = csv.disabled = windowsCsv.disabled = true; session = null; body.replaceChildren(); detailContainer.replaceChildren();
    const warm = Number(warmup.value), duration = Number(measure.value), cool = rest ? Number(rest.value) : 0, unit = longRun ? 60000 : 1000;
    const config = { warmupMs: warm * unit, measureMs: duration * unit, cooldownMs: cool * unit,
      telemetryEnabled: true, telemetryCadenceMs: 1000, threads: 4, threshold: 30, blurRadius: 3 };
    try {
      if (!ready || video.error || !Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) throw fault('INVALID_VIDEO', 'Choose a valid video first');
      if (!warmup.value.trim() || !measure.value.trim() || (rest && !rest.value.trim()) || ![config.warmupMs, config.measureMs, config.cooldownMs].every(Number.isFinite) || warm < 0 || duration <= 0 || config.measureMs > 86400000 || cool < 0) throw fault('INVALID_CONFIG', 'Warm-up/rest must be nonnegative and measure must be positive');
    } catch (error) { status.textContent = error.message; return; }
    controller = new AbortController(); active = true; controls.forEach(control => { control.disabled = true; }); refreshRun(); stop.disabled = false;
    session = { schemaVersion: SCHEMA_VERSION, createdAt: new Date().toISOString(), status: 'running', phase: 'initializing',
      video: { name: file.files?.[0]?.name || '', width: video.videoWidth, height: video.videoHeight, duration: video.duration },
      config: { ...config, ...(longRun ? { warmupMinutes: warm, measureMinutes: duration, cooldownMinutes: cool } : { warmupSeconds: warm, measureSeconds: duration, restSeconds: cool }), ...(diagnostic ? { mode: mode.value } : {}) }, profiling: PROFILING_METADATA, dataCost: DATA_COST_METADATA, results: [], windows: [], windowDurationMs: 60000, visibilityInterrupted: false, visibilityObservedAtMs: null,
      visibilityTimestampScope: 'main-thread-event-observation-relative-to-session-start', visibilityNote: 'Event handling may be delayed while main executes synchronous WASM.' };
    let wakeLock;
    const sessionStartedAt = performance.now();
    const visibility = { interrupted: false, observedAt: null, phase: null };
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden' || visibility.interrupted) return;
      const error = fault('PAGE_HIDDEN', 'Page hidden; session stopped without automatic resume');
      visibility.interrupted = true; visibility.observedAt = error.observedAt; visibility.phase = session.phase;
      session.visibilityInterrupted = true; session.visibilityObservedAtMs = error.observedAt - sessionStartedAt;
      controller.abort(error); stop.disabled = true;
    };
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility(); // Reject an already-hidden page before creating either engine.
    try {
      const metadata = await sessionMetadata(video, config);
      metadata.video.name = session.video.name; Object.assign(session, metadata);
      wakeLock = await acquireWakeLock(session);
      const modes = diagnostic ? [session.config.mode] : ['main', 'worker'];
      session.modeOrder = modes;
      for (let index = 0; index < modes.length; index++) {
        if (controller.signal.aborted) throw controller.signal.reason || aborted();
        const result = await runMode({ mode: modes[index], video, canvas, context, config, signal: controller.signal, extended, diagnostic, windows: session.windows, visibility,
          onPhase: phase => { session.phase = phase; status.textContent = `${modes[index]} — ${phase}`; } });
        session.results.push(result); render();
        if (result.status !== 'ok') { session.status = result.status; session.phase = result.phase; session.errorCode = result.errorCode; session.errorMessage = result.errorMessage; break; }
        if (index + 1 < modes.length) { session.phase = 'cooldown'; status.textContent = 'Cooldown'; await delay(config.cooldownMs, controller.signal); }
      }
      if (session.status === 'running') { session.status = controller.signal.aborted ? 'stopped' : 'ok'; session.phase = 'complete'; }
    } catch (error) { session.status = error.code === 'ABORTED' ? 'stopped' : 'failed'; session.errorCode = error.code || 'RUN_ERROR'; session.errorMessage = error.message; }
    finally {
      try { await wakeLock?.release(); } catch (error) { session.wakeLock.releaseError = String(error); }
      document.removeEventListener('visibilitychange', onVisibility);
      if (visibility.interrupted) {
        if (session.errorCode && session.errorCode !== 'PAGE_HIDDEN') session.previousError = { code: session.errorCode, message: session.errorMessage };
        session.status = 'failed'; session.phase = visibility.phase;
        session.errorCode = 'PAGE_HIDDEN'; session.errorMessage = 'Page hidden; session stopped without automatic resume';
      }
      active = false; stop.disabled = true; controls.forEach(control => { control.disabled = false; }); refreshRun();
      json.disabled = csv.disabled = windowsCsv.disabled = false;
      const cleanupErrors = session.results.map(result => result.cleanupError).filter(Boolean);
      status.textContent = [session.status, session.errorMessage, ...cleanupErrors.map(error => `Cleanup: ${error}`)].filter(Boolean).join(' — ');
      if (mainInitializationPending()) {
        status.textContent += ' — WASM initialization still pending; Run is locked until it settles (reload if necessary).';
        const pendingSession = session;
        const poll = setInterval(() => {
          if (!mainInitializationPending()) {
            clearInterval(poll);
            const cleanup = mainInitializationCleanup();
            for (const result of pendingSession.results) if (result.cleanupStatus === 'pending') Object.assign(result, cleanup);
            if (session === pendingSession) {
              render();
              status.textContent = [session.status, session.errorMessage, cleanup.cleanupError ? `Cleanup: ${cleanup.cleanupError}` : 'WASM initialization settled'].filter(Boolean).join(' — ');
            }
            refreshRun();
          }
        }, 250);
      }
    }
  };
  function save(text, type, extension, suffix = '') {
    const link = document.createElement('a'), objectUrl = URL.createObjectURL(new Blob([text], { type })); link.href = objectUrl;
    link.download = `${diagnostic ? 'diagnostic' : longRun ? 'long-run' : 'strongest-engine'}${suffix}-${Date.now()}.${extension}`; link.click(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
  json.onclick = () => { if(session && !active) save(serializeJson(session), 'application/json', 'json'); };
  csv.onclick = () => { if(session && !active) save(serializeCsv(session), 'text/csv', 'csv', '-overall'); };
  windowsCsv.onclick = () => { if(session && !active) save(serializeCsv(session, 'windows'), 'text/csv', 'csv', '-windows'); };
}
