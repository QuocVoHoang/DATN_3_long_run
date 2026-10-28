#include <cstdint>
#include <vector>
#ifdef __EMSCRIPTEN_PTHREADS__
#include <thread>
#endif
#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif
#include <emscripten/emscripten.h>

namespace {
constexpr int MAX_THREADS = 4;
int workers = 1, width_ = 0, height_ = 0, changed_ = 0;
bool has_previous = false;
std::vector<uint8_t> previous, current, blurred, output;
std::vector<uint16_t> temp;

void buffers(int n, int rgba) {
  if ((int)previous.size() != n) { previous.assign(n, 0); has_previous = false; }
  current.resize(n); blurred.assign(n, 0); temp.assign(n, 0); output.resize(rgba);
}
void gray(const uint8_t* in, uint8_t* out, int a, int b) {
  for (int i=a;i<b;i++) { int p=i*4; out[i]=(uint8_t)((77*in[p]+150*in[p+1]+29*in[p+2])>>8); }
}
void blurH(const uint8_t* in,uint16_t* out,int w,int h,int r,int a,int b) {
  int side=2*r+1;
  for(int y=a;y<b;y++) { if(w<=2*r) continue; uint16_t s=0; const uint8_t* row=in+y*w;
    for(int k=0;k<side;k++) s+=row[k]; out[y*w+r]=s;
    for(int x=r+1;x<w-r;x++){s+=row[x+r];s-=row[x-r-1];out[y*w+x]=s;}
  }
}
void blurV(const uint16_t* in,uint8_t* out,int w,int h,int r,int a,int b) {
  int area=(2*r+1)*(2*r+1), side=2*r+1;
  for(int x=a;x<b;x++){if(h<=2*r)continue;uint32_t s=0;for(int k=0;k<side;k++)s+=in[k*w+x];out[r*w+x]=(uint8_t)(s/area);
    for(int y=r+1;y<h-r;y++){s+=in[(y+r)*w+x];s-=in[(y-r-1)*w+x];out[y*w+x]=(uint8_t)(s/area);}}
}
void diff(const uint8_t* current, const uint8_t* previous, uint8_t* out,
           int threshold, int start, int end, int* count) {
  int changed = 0;
#ifdef __wasm_simd128__
  const v128_t threshold_vec = wasm_u8x16_splat((uint8_t)threshold);
  const v128_t alpha_mask = wasm_i8x16_const(
      0, 0, 0, -1, 0, 0, 0, -1, 0, 0, 0, -1, 0, 0, 0, -1);
  const v128_t expand_0 = wasm_i8x16_const(
      0, 0, 0, 0, 1, 1, 1, 0, 2, 2, 2, 0, 3, 3, 3, 0);
  const v128_t expand_1 = wasm_i8x16_const(
      4, 4, 4, 0, 5, 5, 5, 0, 6, 6, 6, 0, 7, 7, 7, 0);
  const v128_t expand_2 = wasm_i8x16_const(
      8, 8, 8, 0, 9, 9, 9, 0, 10, 10, 10, 0, 11, 11, 11, 0);
  const v128_t expand_3 = wasm_i8x16_const(
      12, 12, 12, 0, 13, 13, 13, 0, 14, 14, 14, 0, 15, 15, 15, 0);

  int i = start;
  for (; i + 15 < end; i += 16) {
    const v128_t cur = wasm_v128_load(current + i);
    const v128_t prev = wasm_v128_load(previous + i);
    const v128_t difference = wasm_i8x16_sub(
        wasm_u8x16_max(cur, prev), wasm_u8x16_min(cur, prev));
    const v128_t motion = wasm_u8x16_gt(difference, threshold_vec);
    const int bits = wasm_i8x16_bitmask(motion);
    changed += __builtin_popcount((unsigned)bits);
    uint8_t* dst = out + i * 4;
    wasm_v128_store(dst, wasm_v128_or(wasm_i8x16_swizzle(motion, expand_0), alpha_mask));
    wasm_v128_store(dst + 16, wasm_v128_or(wasm_i8x16_swizzle(motion, expand_1), alpha_mask));
    wasm_v128_store(dst + 32, wasm_v128_or(wasm_i8x16_swizzle(motion, expand_2), alpha_mask));
    wasm_v128_store(dst + 48, wasm_v128_or(wasm_i8x16_swizzle(motion, expand_3), alpha_mask));
  }
  start = i;
#endif
  for (int i = start; i < end; ++i) {
    const int difference = current[i] > previous[i]
        ? current[i] - previous[i] : previous[i] - current[i];
    const uint8_t value = difference > threshold ? 255 : 0;
    changed += value != 0;
    const int offset = i * 4;
    out[offset] = value;
    out[offset + 1] = value;
    out[offset + 2] = value;
    out[offset + 3] = 255;
  }
  *count = changed;
}
template<class F> void parallel(F fn,int total){
#ifdef __EMSCRIPTEN_PTHREADS__
  int n=workers<1?1:workers>4?4:workers;if(n==1){fn(0,total,0);return;}std::vector<std::thread> ts;int chunk=(total+n-1)/n;for(int t=0;t<n;t++){int a=t*chunk,b=a+chunk;if(b>total)b=total;if(a<b)ts.emplace_back(fn,a,b,t);}for(auto& t:ts)t.join();
#else
  fn(0,total,0);
#endif
}
}

extern "C" {
EMSCRIPTEN_KEEPALIVE void setThreadCount(int n){if(n==1||n==2||n==4)workers=n;}
EMSCRIPTEN_KEEPALIVE int getThreadCount(){return workers;}
EMSCRIPTEN_KEEPALIVE void resetMotionDetector(){has_previous=false;changed_=0;}
EMSCRIPTEN_KEEPALIVE int getChangedPixelCount(){return changed_;}
EMSCRIPTEN_KEEPALIVE uint8_t* getOutput(){return output.data();}
EMSCRIPTEN_KEEPALIVE int processMotion(const uint8_t* rgba,int w,int h,int threshold){if(w<=0||h<=0)return 0;int n=w*h;buffers(n,n*4);width_=w;height_=h;
  parallel([&](int a,int b,int){gray(rgba,current.data(),a,b);},n);
  const int r=3; parallel([&](int a,int b,int){blurH(current.data(),temp.data(),w,h,r,a,b);},h);
  parallel([&](int a,int b,int){blurV(temp.data(),blurred.data(),w,h,r,a,b);},w);
  if(!has_previous){std::fill(output.begin(),output.end(),0);for(int i=3;i<n*4;i+=4)output[i]=255;changed_=0;has_previous=true;previous=blurred;return 0;}
  int parts[MAX_THREADS]={};parallel([&](int a,int b,int t){diff(blurred.data(),previous.data(),output.data(),threshold,a,b,&parts[t]);},n);changed_=0;for(int i=0;i<MAX_THREADS;i++)changed_+=parts[i];previous=blurred;return changed_;}
}
