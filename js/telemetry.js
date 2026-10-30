// Low cadence observations, deliberately outside processFrame. No RSS claim.
export function observeTelemetry(video, engine, config = {}) {
 const enabled=config.telemetryEnabled !== false, cadenceMs=Math.max(250,config.telemetryCadenceMs ?? 1000);
 const result={ enabled,cadenceMs, timestampScope:'performance.now in owning main context; includes warmup and measurement', decoder:{source:typeof video.getVideoPlaybackQuality==='function'?'getVideoPlaybackQuality':null,status:'unavailable',windows:[]},
 wasmLinearMemory:{source:'owning WASM context HEAPU8.buffer.byteLength',status:'unavailable',latestBytes:null,peakBytes:null},
 browserMemory:{source:globalThis.performance?.memory?'performance.memory.usedJSHeapSize':null,status:'unavailable',latestBytes:null},
 mainRaf:{source:'independent requestAnimationFrame',count:0,sumGapMs:0,maxGapMs:null} };
 let previous=null, previousAt=null, rafId=null, rafAt=null, timer=null, ticks=0;
 function memory(bytes){if(!Number.isFinite(bytes))return;Object.assign(result.wasmLinearMemory,{status:'observed',latestBytes:bytes,peakBytes:Math.max(bytes,result.wasmLinearMemory.peakBytes ?? 0)});}
 function sample(){
  const now=performance.now();
  if(typeof video.getVideoPlaybackQuality==='function')try{
   const q=video.getVideoPlaybackQuality(), current={total:q.totalVideoFrames,dropped:q.droppedVideoFrames,corrupted:q.corruptedVideoFrames ?? null};
   if(previous){const delta={};for(const k of Object.keys(current))delta[k]=Number.isFinite(current[k])&&Number.isFinite(previous[k])&&current[k]>=previous[k]?current[k]-previous[k]:null;
    result.decoder.windows.push({startMs:previousAt,endMs:now,...delta});}
   previous=current;previousAt=now;result.decoder.status='observed';
  }catch{result.decoder.status='error';}
  memory(engine?.memoryBytes?.());
  if(performance.memory){result.browserMemory.status='observed';result.browserMemory.latestBytes=performance.memory.usedJSHeapSize ?? null;}
  if(++ticks>=10000){clearInterval(timer);result.truncated=true;}
 }
 function raf(now){if(rafAt!=null){const gap=now-rafAt;result.mainRaf.count++;result.mainRaf.sumGapMs+=gap;result.mainRaf.maxGapMs=Math.max(gap,result.mainRaf.maxGapMs ?? 0);}rafAt=now;rafId=requestAnimationFrame(raf);}
 if(enabled){sample();timer=setInterval(sample,cadenceMs);if(typeof requestAnimationFrame==='function')rafId=requestAnimationFrame(raf);}
 return {result,memory,stop(){if(timer)clearInterval(timer);if(rafId!=null)cancelAnimationFrame(rafId);if(enabled && !result.truncated)sample();}};
}
