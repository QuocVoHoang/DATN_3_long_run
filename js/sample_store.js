import { PROFILE_STAGES } from './profiling.js';
export const SAMPLE_BUDGET = Object.freeze({ maxDurationMs: 86400000, maxSamples: 250000, maxCallbackGaps: 250000, maxBytes: 40 * 1024 * 1024 });
const fields = ['core', 'e2e', 'frameRgbaBytes', 'readbackBytes', 'wasmCopyBytes', ...PROFILE_STAGES];
const CHUNK = 2048;
// Float64 preserves measured values exactly. Missing entries are NaN, never zero.
export class SampleStore {
  constructor(limit = SAMPLE_BUDGET.maxSamples) { this.limit = limit; this.length = 0; this.chunks = []; this.sums = new Float64Array(fields.length); this.counts = new Uint32Array(fields.length); }
  check() { if (this.length >= this.limit) throw Object.assign(new Error('Exact sample budget exhausted; partial results retained'), { code: 'SAMPLE_BUDGET_EXCEEDED' }); }
  push(sample) {
    this.check(); const index = this.length++, block = Math.floor(index / CHUNK);
    this.chunks[block] ??= new Float64Array(CHUNK * fields.length);
    const offset = (index % CHUNK) * fields.length;
    fields.forEach((key, i) => { const value = sample[key] ?? sample.profile?.[key] ?? NaN; this.chunks[block][offset + i] = value; if(Number.isFinite(value)){this.sums[i]+=value;this.counts[i]++;} });
  }
  at(index) {
    const block = this.chunks[Math.floor(index / CHUNK)], offset = (index % CHUNK) * fields.length;
    const sample = { profile: {} };
    fields.forEach((key, i) => { const v = block[offset + i]; (i < 5 ? sample : sample.profile)[key] = Number.isNaN(v) ? undefined : v; }); return sample;
  }
  view(start = 0, end = this.length) { return new SampleView(this, start, end); }
  distribution(key) {
    const column=fields.indexOf(key); if(column<0)throw new Error('Unknown column');
    const count=this.counts[column];if(!count)return { count:0,mean:null,p50:null,p95:null,p99:null };
    const sorted=new Float64Array(count);let j=0;
    for(let i=0;i<this.length;i++){const v=this.chunks[Math.floor(i/CHUNK)][(i%CHUNK)*fields.length+column];if(Number.isFinite(v))sorted[j++]=v;}
    sorted.sort();const p=q=>sorted[Math.ceil(q*count)-1];
    return {count,mean:this.sums[column]/count,p50:p(.5),p95:p(.95),p99:p(.99)};
  }
  map(fn) { return this.view().map(fn); }
  find(fn) { return this.view().find(fn); }
  reduce(fn, initial) { return this.view().reduce(fn, initial); }
  *[Symbol.iterator]() { yield* this.view(); }
}
class SampleView {
  constructor(store, start, end) { this.store = store; this.start = start; this.end = end; this.length = end - start; }
  *[Symbol.iterator]() { for(let i=this.start;i<this.end;i++)yield this.store.at(i); }
  map(fn) { return Array.from(this, fn); }
  find(fn) { for (const value of this) if (fn(value)) return value; }
  reduce(fn, initial) { let result = initial; for(const value of this) result=fn(result,value); return result; }
}
