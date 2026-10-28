import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor, seekStart, nextFrame, delay, initializeMain, mainInitializationPending, WorkerClient, aborted } from '../js/lifecycle.js';
import { runMode } from '../js/benchmark.js';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const defer = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
class Video extends EventTarget {
  constructor() { super(); this.time=10; this.seeking=false;this.readyState=2;this.videoWidth=1920;this.videoHeight=1080;this.callbacks=new Map();this.id=0;this.cancelled=0; }
  get currentTime(){return this.time;}
  set currentTime(value){this.time=value;this.seeking=true;}
  sought(){this.seeking=false;this.dispatchEvent(new Event('seeked'));}
  requestVideoFrameCallback(fn){this.callbacks.set(++this.id,fn);return this.id;}
  cancelVideoFrameCallback(id){this.cancelled++;this.callbacks.delete(id);}
  frame(){for(const [id,fn] of [...this.callbacks]){this.callbacks.delete(id);fn(0,{presentedFrames:id});}}
  play(){return Promise.resolve();} pause(){this.paused=true;}
}
class Worker {
  sent=[]; terminated=0;
  postMessage(data){this.sent.push(data);this.onpost?.(data);}
  reply(data,type){this.onmessage?.({data:{type,requestId:data.requestId}});}
  terminate(){this.terminated++;}
}
const limits={init:30,frame:30,cleanup:10};
test('seek waits for seeked, even though currentTime changes immediately',async()=>{
  const v=new Video();let done=false;const p=seekStart(v,undefined,100).then(()=>done=true);await pause(1);assert.equal(done,false);v.sought();await p;assert.equal(done,true);
});
test('seek at ready start needs no event; seek waits for frame readiness',async()=>{
  const v=new Video();v.time=0;await seekStart(v);v.time=2;v.readyState=1;const p=seekStart(v,undefined,100);v.sought();v.readyState=2;v.dispatchEvent(new Event('loadeddata'));await p;
});
test('abort seek and cooldown promptly',async()=>{
  const c=new AbortController(),v=new Video();const p=seekStart(v,c.signal);const d=delay(10000,c.signal);c.abort(aborted());await assert.rejects(p,{code:'ABORTED'});await assert.rejects(d,{code:'ABORTED'});
});
test('frame deadline resolves null and cancels registration',async()=>{
  const v=new Video();assert.equal(await nextFrame(v,undefined,performance.now()+5),null);assert.equal(v.callbacks.size,0);
});
test('stop, ended, media error and timeout settle frame waits',async()=>{
  for(const kind of ['abort','ended','error','timeout']){const v=new Video(),c=new AbortController();const p=nextFrame(v,c.signal,performance.now()+1000,5);if(kind==='abort')c.abort(aborted());else if(kind!=='timeout')v.dispatchEvent(new Event(kind));await assert.rejects(p,{code:{abort:'ABORTED',ended:'VIDEO_ENDED',error:'MEDIA_ERROR',timeout:'FRAME_TIMEOUT'}[kind]});assert.equal(v.callbacks.size,0);}
});
test('bounded wait releases late resources',async()=>{
  const d=defer();let closed=0;const p=waitFor(d.promise,{timeout:2,onLate:v=>v.close()});await assert.rejects(p);d.resolve({close(){closed++;}});await pause(1);assert.equal(closed,1);
});
test('main initialization remains locked until late engine is disposed',async()=>{
  const d=defer(),c=new AbortController();let disposed=0;const p=initializeMain(()=>d.promise,c.signal,100);c.abort(aborted());await assert.rejects(p,{code:'ABORTED'});assert.equal(mainInitializationPending(),true);await assert.rejects(initializeMain(()=>{},undefined),{code:'INIT_PENDING'});d.resolve({dispose(){disposed++;}});await pause(1);assert.equal(disposed,1);assert.equal(mainInitializationPending(),false);
});
test('worker readiness and acknowledged cleanup',async()=>{
  const w=new Worker(),c=new WorkerClient(w,limits);w.onpost=d=>queueMicrotask(()=>w.reply(d,d.type==='init'?'ready':'stopped'));await c.init();assert.equal((await c.close()).cleanupStatus,'ok');await c.close();assert.equal(w.terminated,1);assert.equal(c.pending.size,0);
});
test('worker error/crash/messageerror/post failure reject all pending',async()=>{
  for(const kind of ['error','crash','messageerror','post']){const w=new Worker(),c=new WorkerClient(w,limits);if(kind==='post')w.onpost=()=>{throw Error('post failed');};const p=c.init();if(kind==='error')w.onmessage({data:{type:'error',requestId:1,message:'failure'}});if(kind==='crash')w.onerror({message:'crashed'});if(kind==='messageerror')w.onmessageerror();await assert.rejects(p);assert.equal(c.pending.size,0);assert.equal((await c.close()).cleanupStatus,'forced');}
});
test('worker request timeout and missing STOPPED force cleanup',async()=>{
  const w=new Worker(),c=new WorkerClient(w,{...limits,init:2});await assert.rejects(c.init(),{code:'WORKER_TIMEOUT'});assert.equal((await c.close()).cleanupStatus,'forced');const w2=new Worker(),c2=new WorkerClient(w2,limits);assert.equal((await c2.close()).cleanupStatus,'forced');assert.equal(w2.terminated,1);
});
test('stop during INIT cancels request but still awaits STOPPED',async()=>{
  const w=new Worker(),c=new WorkerClient(w,limits),a=new AbortController();const p=c.init(a.signal);a.abort(aborted());await assert.rejects(p);w.onpost=d=>queueMicrotask(()=>w.reply(d,'stopped'));assert.equal((await c.close()).cleanupStatus,'ok');
});
test('late bitmap is closed after abort, no FRAME sent',async()=>{
  const w=new Worker(),c=new WorkerClient(w,limits),a=new AbortController(),d=defer();let closed=0;const p=c.frame(new Video(),{},a.signal,Infinity,()=>d.promise);a.abort(aborted());await assert.rejects(p);d.resolve({close(){closed++;}});await pause(1);assert.equal(closed,1);assert.equal(w.sent.length,0);await c.close();
});
test('bitmap resolving beyond deadline is closed without FRAME',async()=>{
  const w=new Worker(),c=new WorkerClient(w,limits);let closed=0;assert.equal(await c.frame(new Video(),{},undefined,0,async()=>({close(){closed++;}})),null);assert.equal(closed,1);assert.equal(w.sent.length,0);await c.close();
});
function options(v,controller=new AbortController()) {
  v.time=0;return {mode:'main',video:v,canvas:{width:1920,height:1080},context:{drawImage(){},getImageData(){return {};}},config:{warmupMs:0,measureMs:12},signal:controller.signal,onPhase(){},windows:[],extended:false,diagnostic:false,dependencies:{engineFactory:async()=>({process:()=>({coreMs:1}),dispose(){}})}};
}
test('runner initializes before playback and preserves samples on failure',async()=>{
  const v=new Video(),o=options(v),phases=[];let disposed=0;
  o.onPhase=p=>{phases.push(p);if(p==='measuring')setTimeout(()=>{v.frame();setTimeout(()=>v.dispatchEvent(new Event('error')),1);},1);};
  o.dependencies.engineFactory=async()=>({process:()=>({coreMs:1}),dispose(){disposed++;}});
  const r=await runMode(o);assert.equal(r.status,'failed');assert.equal(r.errorCode,'MEDIA_ERROR');assert.equal(r.completedWithinWindow,1);assert.equal(disposed,1);assert.deepEqual(phases,['initializing','seeking','warmup','measuring','cleaning-up']);
});
test('runner deadline is normal completion and no frame is required',async()=>{
  const v=new Video();const r=await runMode(options(v));assert.equal(r.status,'ok');assert.equal(r.completedFps,0);assert.equal(v.callbacks.size,0);
});
test('runner Stop returns stopped, play rejection returns failed',async()=>{
  const v=new Video(),c=new AbortController(),o=options(v,c);o.onPhase=p=>{if(p==='measuring')c.abort(aborted());};assert.equal((await runMode(o)).status,'stopped');const v2=new Video();v2.play=()=>Promise.reject(Error('NotAllowed'));const r=await runMode(options(v2));assert.equal(r.status,'failed');assert.equal(r.phase,'seeking');
});
test('runner INIT/READY precedes worker playback',async()=>{
  const v=new Video(),o=options(v),w=new Worker();o.mode='worker';o.dependencies={workerFactory:()=>w};let ready=false;
  w.onpost=d=>setTimeout(()=>{if(d.type==='init')ready=true;w.reply(d,d.type==='init'?'ready':'stopped');},1);
  v.play=()=>{assert.equal(ready,true);return Promise.resolve();};assert.equal((await runMode(o)).status,'ok');assert.equal(w.terminated,1);
});
