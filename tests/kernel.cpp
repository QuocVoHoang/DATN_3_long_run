#include <cassert>
#include <random>
#include <iostream>
#include "../cpp/motion_detection.cpp"
// Deliberately direct 49-tap oracle: no separable/sliding implementation shared.
std::vector<uint8_t> oracle(const std::vector<uint8_t>& rgba,int w,int h){
 std::vector<uint8_t> g(w*h), b(w*h);
 for(int i=0;i<w*h;i++)g[i]=(77*rgba[4*i]+150*rgba[4*i+1]+29*rgba[4*i+2])>>8;
 for(int y=3;y<h-3;y++)for(int x=3;x<w-3;x++){int sum=0;for(int dy=-3;dy<=3;dy++)for(int dx=-3;dx<=3;dx++)sum+=g[(y+dy)*w+x+dx];b[y*w+x]=sum/49;}return b;
}
int main(){std::mt19937 rng(0x12345678);
 for(int threads:{1,2,4})for(auto wh:{std::pair<int,int>{1,1},{5,9},{7,7},{8,11},{17,19},{33,31},{19,17}}){
  int w=wh.first,h=wh.second;setThreadCount(threads);resetMotionDetector();std::vector<uint8_t> prev;
  for(int f=0;f<12;f++){std::vector<uint8_t> input(w*h*4);for(auto& v:input)v=rng()%256;
   if(f>=7)std::fill(input.begin(),input.end(),(f-7)*31);
   if(f==5){resetMotionDetector();prev.clear();}
   int threshold=std::vector<int>{-1,0,1,29,30,127,254,255,256}[f%9];auto b=oracle(input,w,h);int expected=0;
   int count=processMotion(input.data(),w,h,threshold);auto out=getOutput();
   for(int i=0;i<w*h;i++){int value=!prev.empty()&&std::abs(int(b[i])-int(prev[i]))>threshold?255:0;expected+=value!=0;for(int c=0;c<4;c++)assert(out[4*i+c]==(c==3?255:value));}assert(count==expected);prev=b;
  }
 }
 // Equal-area resize must reset, too.
 std::vector<uint8_t> a(17*19*4,255);processMotion(a.data(),17,19,0);std::fill(a.begin(),a.end(),0);assert(processMotion(a.data(),19,17,0)==0);
 std::cout<<"kernel golden oracle passed (seed 0x12345678, partitions 1/2/4)\n";
}
