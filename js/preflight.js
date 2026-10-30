import { fault } from './lifecycle.js';
import { SAMPLE_BUDGET } from './sample_store.js';
// Minimal SIMD module containing i8x16.splat. Validation never creates a worker.
const simd = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,8,1,6,0,65,0,253,15,11]);
export function capabilities(scope = globalThis) {
 return { secureContext: scope.isSecureContext ?? null, crossOriginIsolated: scope.crossOriginIsolated ?? null,
  sharedArrayBuffer: typeof scope.SharedArrayBuffer === 'function', simd: scope.WebAssembly?.validate(simd) ?? false,
  offscreenCanvas: typeof scope.OffscreenCanvas === 'function', createImageBitmap: typeof scope.createImageBitmap === 'function' };
}
export function preflight(mode) {
 const c=capabilities();
 for(const key of ['secureContext','crossOriginIsolated','sharedArrayBuffer','simd']) if(!c[key]) throw fault('PREFLIGHT_FAILED', `${mode}: ${key} required`);
 if(mode==='worker' && (!c.offscreenCanvas || !c.createImageBitmap)) throw fault('PREFLIGHT_FAILED','Worker mode requires OffscreenCanvas and createImageBitmap');
 return c;
}
export async function sessionMetadata(video, config) {
 let build=null; const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),3000);
 try{const r=await fetch(new URL('../build/build-manifest.json',import.meta.url), {signal:controller.signal});if(r.ok)build=await r.json();}catch{}finally{clearTimeout(timer);}
 const n=globalThis.navigator;
 return { build, capabilities: capabilities(), device: { userAgent:n?.userAgent ?? null, platform:n?.userAgentData?.platform ?? n?.platform ?? null,
 hardwareConcurrency:n?.hardwareConcurrency ?? null, deviceMemoryGiB:n?.deviceMemory ?? null },
 instrumentation: { stageTimings:true, telemetryEnabled:config.telemetryEnabled ?? true, telemetryCadenceMs:Math.max(250,config.telemetryCadenceMs ?? 1000), sampleBudget:SAMPLE_BUDGET },
 video: { name: video.currentSrc?.startsWith('blob:') ? null : video.currentSrc ?? null, width:video.videoWidth,height:video.videoHeight,duration:video.duration } };
}
export async function acquireWakeLock(session) {
 session.wakeLock={ status:'unavailable', events:[] }; const state=session.wakeLock;
 if(!globalThis.navigator?.wakeLock?.request)return null;
 try { const lock=await navigator.wakeLock.request('screen'); state.status='acquired';state.events.push({status:'acquired',at:performance.now()});
 lock.addEventListener('release',()=>{state.status='released';state.events.push({status:'released',at:performance.now()});},{once:true});return lock;
 }catch(error){state.status='denied';state.error=String(error);return null;}
}
