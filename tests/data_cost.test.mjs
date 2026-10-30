import test from 'node:test';
import assert from 'node:assert/strict';
import { frameDataFootprint, summarizeDataCost, DATA_COST_COLUMNS, DATA_COST_METADATA } from '../js/data_cost.js';
import { PROFILE_STAGES } from '../js/profiling.js';
import { runMode } from '../js/benchmark.js';
import { formatCsvValue } from '../js/page.js';

class MockVideo extends EventTarget {
  constructor(width = 1920, height = 1080) {
    super();
    this.time = 0;
    this.seeking = false;
    this.readyState = 2;
    this.videoWidth = width;
    this.videoHeight = height;
    this.callbacks = new Map();
    this.id = 0;
  }
  get currentTime() { return this.time; }
  set currentTime(value) { this.time = value; }
  requestVideoFrameCallback(fn) {
    const id = ++this.id;
    this.callbacks.set(id, fn);
    return id;
  }
  cancelVideoFrameCallback(id) {
    this.callbacks.delete(id);
  }
  emitFrame() {
    for (const [id, fn] of [...this.callbacks]) {
      this.callbacks.delete(id);
      fn(0, { presentedFrames: id, mediaTime: id * 0.016 });
    }
  }
  play() { return Promise.resolve(); }
  pause() { this.paused = true; }
}

test('frameDataFootprint computes exact byte and MB costs for 1080p and 4K across main and worker', () => {
  const f1080Main = frameDataFootprint({ width: 1920, height: 1080, mode: 'main' });
  assert.equal(f1080Main.frameRgbaBytes, 8294400);
  assert.equal(f1080Main.frameRgbaMB, 8.2944);
  assert.equal(f1080Main.bridgeCopyBytesPerFrame, 16588800);
  assert.equal(f1080Main.bridgeCopyMBPerFrame, 16.5888);
  assert.equal(f1080Main.nonCoreTrafficBytesPerFrame, 24883200);
  assert.equal(f1080Main.nonCoreTrafficMBPerFrame, 24.8832);
  assert.equal(f1080Main.coreWorkingSetBytes, 26956800);
  assert.equal(f1080Main.coreWorkingSetMB, 26.9568);

  const f4kWorker = frameDataFootprint({ width: 3840, height: 2160, mode: 'worker' });
  assert.equal(f4kWorker.frameRgbaBytes, 33177600);
  assert.equal(f4kWorker.frameRgbaMB, 33.1776);
  assert.equal(f4kWorker.bridgeCopyBytesPerFrame, 66355200);
  assert.equal(f4kWorker.bridgeCopyMBPerFrame, 66.3552);
  assert.equal(f4kWorker.nonCoreTrafficBytesPerFrame, 132710400);
  assert.equal(f4kWorker.nonCoreTrafficMBPerFrame, 132.7104);
  assert.equal(f4kWorker.coreWorkingSetBytes, 107827200);
  assert.equal(f4kWorker.coreWorkingSetMB, 107.8272);
});

test('summarizeDataCost identifies core vs non-core bottleneck regime and computes GB and GB/s metrics', () => {
  // 1080p Core-dominated scenario: core = 4ms, e2e = 6ms -> nonCore = 2ms (33.33%)
  const samples1080 = [
    {
      core: 4,
      e2e: 6,
      frameRgbaBytes: 8294400,
      readbackBytes: 8294400,
      wasmCopyBytes: 8294400,
      profile: { drawMs: 0.5, readbackMs: 1.0, wasmCopyMs: 0.5, coreMs: 4, e2eMs: 6, nonCoreMs: 2 },
    },
    {
      core: 4,
      e2e: 6,
      frameRgbaBytes: 8294400,
      readbackBytes: 8294400,
      wasmCopyBytes: 8294400,
      profile: { drawMs: 0.5, readbackMs: 1.0, wasmCopyMs: 0.5, coreMs: 4, e2eMs: 6, nonCoreMs: 2 },
    },
  ];
  const summary1080 = summarizeDataCost({
    samples: samples1080,
    mode: 'main',
    width: 1920,
    height: 1080,
    elapsedMs: 1000,
  });

  assert.equal(summary1080.bottleneckRegime, 'core');
  assert.equal(summary1080.nonCoreMean, 2);
  assert.ok(Math.abs(summary1080.nonCoreSharePct - (2 / 6) * 100) < 1e-9);
  assert.equal(summary1080.totalReadbackBytes, 16588800);
  assert.equal(summary1080.totalWasmCopyBytes, 16588800);
  assert.equal(summary1080.totalBridgeCopyBytes, 33177600);
  assert.equal(summary1080.totalNonCoreTrafficBytes, 49766400);
  assert.ok(Math.abs(summary1080.totalNonCoreTrafficGB - 0.0497664) < 1e-12);
  // readbackBandwidthGBps = 16,588,800 bytes / (2.0 ms * 1e6) = 8.2944 GB/s
  assert.ok(Math.abs(summary1080.readbackBandwidthGBps - 8.2944) < 1e-9);
  // wasmCopyBandwidthGBps = 16,588,800 bytes / (1.0 ms * 1e6) = 16.5888 GB/s
  assert.ok(Math.abs(summary1080.wasmCopyBandwidthGBps - 16.5888) < 1e-9);

  // 4K Non-Core-dominated scenario: core = 6ms, e2e = 30ms -> nonCore = 24ms (80%)
  const samples4k = [
    {
      core: 6,
      e2e: 30,
      frameRgbaBytes: 33177600,
      readbackBytes: 33177600,
      wasmCopyBytes: 33177600,
      profile: { drawMs: 4, readbackMs: 12, wasmCopyMs: 8, coreMs: 6, e2eMs: 30, nonCoreMs: 24 },
    },
  ];
  const summary4k = summarizeDataCost({
    samples: samples4k,
    mode: 'worker',
    width: 3840,
    height: 2160,
    elapsedMs: 1000,
  });

  assert.equal(summary4k.bottleneckRegime, 'non-core');
  assert.equal(summary4k.nonCoreMean, 24);
  assert.equal(summary4k.nonCoreSharePct, 80);
  assert.equal(summary4k.totalNonCoreTrafficBytes, 132710400);
  assert.ok(Math.abs(summary4k.totalNonCoreTrafficGB - 0.1327104) < 1e-12);
});

test('summarizeDataCost handles empty sample sets cleanly without NaN', () => {
  const empty = summarizeDataCost({ samples: [], mode: 'main', width: 1920, height: 1080, elapsedMs: 1000 });
  assert.equal(empty.frameRgbaBytes, 8294400);
  assert.equal(empty.totalReadbackBytes, 0);
  assert.equal(empty.totalNonCoreTrafficGB, 0);
  assert.equal(empty.nonCoreMean, null);
  assert.equal(empty.nonCoreSharePct, null);
  assert.equal(empty.bottleneckRegime, null);
  assert.equal(empty.readbackBandwidthGBps, null);
  assert.equal(empty.wasmCopyBandwidthGBps, null);
  assert.equal(empty.bridgeThroughputMBps, 0);
  assert.equal(empty.nonCoreThroughputMBps, 0);
});

test('runMode integrates nonCoreMs profile stage and RQ6 data cost metrics into result and windows', async () => {
  assert.ok(PROFILE_STAGES.includes('nonCoreMs'));
  assert.ok(DATA_COST_COLUMNS.length > 0);
  assert.equal(DATA_COST_METADATA.unitMB, '1e6 bytes (decimal MB)');

  const video = new MockVideo(3840, 2160);
  const frameBytes = 3840 * 2160 * 4;
  const windows = [];
  const result = await runMode({
    mode: 'main',
    video,
    canvas: { width: 3840, height: 2160 },
    context: {
      drawImage() {},
      getImageData() {
        return { width: 3840, height: 2160, data: { length: frameBytes, byteLength: frameBytes } };
      },
    },
    config: { warmupMs: 0, measureMs: 25 },
    signal: new AbortController().signal,
    onPhase(phase) {
      if (phase === 'measuring') {
        setTimeout(() => video.emitFrame(), 2);
      }
    },
    windows,
    extended: true,
    diagnostic: false,
    dependencies: {
      engineFactory: async () => ({
        process: image => ({
          coreMs: 1,
          frameRgbaBytes: image.data.byteLength,
          wasmCopyBytes: image.data.byteLength,
          profile: { wasmCopyMs: 0.5, coreMs: 1 },
        }),
        dispose() {},
      }),
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.completedWithinWindow, 1);
  assert.equal(result.frameRgbaBytes, frameBytes);
  assert.equal(result.frameRgbaMB, 33.1776);
  assert.equal(result.totalReadbackBytes, frameBytes);
  assert.equal(result.totalWasmCopyBytes, frameBytes);
  assert.equal(result.totalNonCoreTrafficBytes, frameBytes * 3);
  assert.equal(result.profile.nonCoreMs.count, 1);
  assert.ok(Number.isFinite(result.nonCoreSharePct));
  assert.ok(result.bottleneckRegime === 'core' || result.bottleneckRegime === 'non-core');
  // Group 5 metrics must be completely absent from both result and minute windows
  for (const removedKey of [
    'longTasksSupported',
    'mainThreadLongTasksOverlapping',
    'mainThreadLongTaskMs',
    'mainThreadBlockingMs',
    'wasmLinearMemoryLastObservedBytes',
    'wasmLinearMemoryObservedPeakBytes',
  ]) {
    assert.equal(result[removedKey], undefined, `Expected ${removedKey} to be removed from result`);
    assert.equal(windows[0][removedKey], undefined, `Expected ${removedKey} to be removed from window`);
  }
  assert.equal(windows.length, 1);
  assert.equal(windows[0].totalNonCoreTrafficBytes, frameBytes * 3);
  assert.equal(windows[0].profile.nonCoreMs.count, 1);
});

test('formatCsvValue rounds floating-point values to 3 decimal places and preserves integers', () => {
  assert.equal(formatCsvValue(90), '90');
  assert.equal(formatCsvValue(0), '0');
  assert.equal(formatCsvValue(33.1776), '33.178');
  assert.equal(formatCsvValue(16.6666666667), '16.667');
  assert.equal(formatCsvValue(0.5), '0.500');
  assert.equal(formatCsvValue('simd-pthread-4-main'), 'simd-pthread-4-main');
  assert.equal(formatCsvValue(null), '');
  assert.equal(formatCsvValue(undefined), '');
  assert.equal(formatCsvValue(NaN), '');
});
