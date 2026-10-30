// Test-only golden oracle. Not a benchmark engine.
export async function verifyWasm(factory) {
 const m=await factory({locateFile:p=>new URL('../build/'+p,import.meta.url).href});
 let seed=0x12345678, pointer=0, cases=0;
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;};
 function blur(input,w,h){const g=new Uint8Array(w*h),b=new Uint8Array(w*h);for(let i=0;i<g.length;i++)g[i]=(77*input[i*4]+150*input[i*4+1]+29*input[i*4+2])>>8;
 for(let y=3;y<h-3;y++)for(let x=3;x<w-3;x++){let sum=0;for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++)sum+=g[(y+dy)*w+x+dx];b[y*w+x]=Math.floor(sum/49);}return b;}
 try{pointer=m._malloc(64*64*4);if(!pointer)throw Error('oracle malloc');
 for(const threads of [1,2,4])for(const [w,h] of [[1,1],[5,9],[7,7],[8,11],[17,19],[33,31],[19,17]]){
 m._setThreadCount(threads);m._resetMotionDetector();let previous=null;
 for(let f=0;f<24;f++){
 if(f===12){m._resetMotionDetector();previous=null;}
 const threshold=[-1,0,1,29,30,31,32,127,254,255,256][f%11];const input=Uint8Array.from({length:w*h*4},()=>f>=15?(f%2)*31:random());const b=blur(input,w,h);
 m.HEAPU8.set(input,pointer);const count=m._processMotion(pointer,w,h,threshold);const out=m._getOutput();let expected=0;
 for(let i=0;i<w*h;i++){const value=previous&&Math.abs(b[i]-previous[i])>threshold?255:0;expected+=value!==0;
 for(let c=0;c<4;c++)if(m.HEAPU8[out+i*4+c] !== (c===3?255:value))throw Error(`mask mismatch ${threads} ${w}x${h} frame ${f} pixel ${i}`);}
 if(count!==expected)throw Error('count mismatch');previous=b;cases++;
 }}
 m._resetMotionDetector();m.HEAPU8.fill(255,pointer,pointer+17*19*4);m._processMotion(pointer,17,19,0);m.HEAPU8.fill(0,pointer,pointer+17*19*4);if(m._processMotion(pointer,19,17,0)!==0)throw Error('resize failed');
 return {cases,partitions:[1,2,4],seed:'0x12345678',simdAndPthreads:true};
 }finally{if(pointer)m._free(pointer);m.terminatePthreadPool?.();}
}
