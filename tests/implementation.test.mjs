import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { unlinkSync, readFileSync } from 'node:fs';
import { SampleStore, SAMPLE_BUDGET } from '../js/sample_store.js';
import { LongRunStats } from '../js/long_run_stats.js';
import { serializeCsv, serializeJson, SCHEMA_VERSION } from '../js/serialization.js';
import { capabilities, acquireWakeLock } from '../js/preflight.js';
test('native golden oracle, real partitions and resize',()=>{
 const binary=new URL('./.kernel-test',import.meta.url);
 try{execFileSync('clang++',['-std=c++17','-O2','-D__EMSCRIPTEN_PTHREADS__','-Itests/native_include','tests/kernel.cpp','-o',binary.pathname]);assert.match(execFileSync(binary.pathname,{encoding:'utf8'}),/passed/);}finally{try{unlinkSync(binary);}catch{}}
});
test('numeric exact storage, absent stages and hard budget',()=>{
 const samples=new SampleStore(2);samples.push({core:1.123456789,e2e:9,profile:{coreMs:1.123456789}});samples.push({core:8,e2e:10});
 assert.equal(samples.at(0).core,1.123456789);assert.equal(samples.at(1).profile.bitmapMs,undefined);assert.throws(()=>samples.push({}),{code:'SAMPLE_BUDGET_EXCEEDED'});
 assert.ok((Math.ceil(SAMPLE_BUDGET.maxSamples/2048)*2048*16*8 + SAMPLE_BUDGET.maxCallbackGaps*8)<SAMPLE_BUDGET.maxBytes);
});
test('window views and overall exact percentiles do not average windows',()=>{
 const stats=new LongRunStats('main',{width:7,height:7});stats.begin(0);
 for(let i=0;i<100;i++)stats.complete({core:1,e2e:2},i);stats.complete({core:100,e2e:101},60001);
 const result=stats.result(61000);assert.equal(result.windows[1].coreP95,100);assert.equal(result.summary.profile.coreMs.count,0);
 assert.equal(stats.samples.distribution('core').p95,1);assert.equal(stats.samples.view().length,101);assert.equal(result.summary.nonCoreP95,1);
});
test('CSV escaping, Unicode, exact numbers, JSON agreement and failure without results',()=>{
 const s={status:'failed',errorMessage:'lỗi,"x"\nline',config:{measureMs:1.123456789},results:[{engine:'worker',status:'failed',coreMean:1.123456789,errorMessage:'lỗi,"x"\nline',cleanupStatus:'forced',profile:{coreMs:{count:1,mean:1.123456789}}}],windows:[{index:0,partial:true,coreMean:1.123456789}]};
 const json=JSON.parse(serializeJson(s)),csv=serializeCsv(s);assert.equal(json.schemaVersion,SCHEMA_VERSION);assert.ok(csv.includes('"lỗi,""x""\nline"'));assert.ok(csv.includes(String(json.results[0].coreMean)));assert.ok(csv.includes('profile.coreMs.mean'));assert.ok(serializeCsv(s,'windows').includes('"partial"'));
 assert.ok(serializeCsv({...s,results:[]}).includes('failed'));
});
test('SIMD probe validates and unknown secure context remains null',()=>{assert.equal(capabilities().simd,true);assert.equal(capabilities().secureContext,null);});
test('WakeLock unavailable records status',async()=>{const s={};await acquireWakeLock(s);assert.equal(s.wakeLock.status,'unavailable');});

test('checked-in artifact manifest matches source and generated hashes',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../build/build-manifest.json',import.meta.url)));
 for(const [path,expected] of Object.entries(manifest.sha256))assert.equal(createHash('sha256').update(readFileSync(new URL('../'+path,import.meta.url))).digest('hex'),expected,path);
 assert.ok(manifest.flags.includes('ENVIRONMENT=web,worker'));
});

test('budget exhaustion ends runner with consistent counters and partial results',async()=>{
 const {runMode}=await import('../js/benchmark.js');
 const original=SampleStore.prototype.check;
 SampleStore.prototype.check=function(){if(this.length>=2)throw Object.assign(new Error('test budget'),{code:'SAMPLE_BUDGET_EXCEEDED'});return original.call(this);};
 class Video extends EventTarget {
  currentTime=0;readyState=2;videoWidth=8;videoHeight=8;
  play(){return Promise.resolve();}pause(){}
  requestVideoFrameCallback(fn){return setTimeout(()=>fn(0,{presentedFrames:1}),2);}
  cancelVideoFrameCallback(id){clearTimeout(id);}
 }
 const windows=[];
 try {
 const result=await runMode({mode:'main',video:new Video(),canvas:{width:8,height:8},context:{drawImage(){},getImageData(){return {data:new Uint8Array(256),width:8,height:8};}},
 config:{warmupMs:0,measureMs:1000,telemetryEnabled:false},signal:new AbortController().signal,onPhase(){},extended:true,windows,
 dependencies:{engineFactory:async()=>({process(){return {coreMs:1};},dispose(){}})}});
 assert.equal(result.status,'failed');assert.equal(result.errorCode,'SAMPLE_BUDGET_EXCEEDED');assert.equal(result.completedWithinWindow,2);
 assert.equal(result.latencySampleCount,2);assert.equal(windows[0].completedWithinWindow,2);assert.equal(result.cleanupStatus,'ok');
 }finally{SampleStore.prototype.check=original;}
});

test('independent CSV reader roundtrips quoted newlines, Unicode and profile values',()=>{
 const session={status:'failed',config:{threshold:30},results:[{engine:'mẫu,"x"\r\nnext',status:'failed',errorMessage:'é漢字',coreMean:0.123456789123,profile:{coreMs:{count:2,mean:0.123456789123}}}],windows:[]};
 const text=serializeCsv(session),rows=[];let row=[],value='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}
 else if(!quoted&&c===','){row.push(value);value='';}else if(!quoted&&c==='\r'&&text[i+1]==='\n'){row.push(value);rows.push(row);row=[];value='';i++;}else value+=c;}
 const actual=Object.fromEntries(rows[0].map((key,i)=>[key,rows[1][i]]));const json=JSON.parse(serializeJson(session));
 assert.equal(actual.engine,json.results[0].engine);assert.equal(actual.errorMessage,json.results[0].errorMessage);
 assert.equal(Number(actual.coreMean),json.results[0].coreMean);assert.equal(Number(actual['profile.coreMs.mean']),json.results[0].profile.coreMs.mean);
});
