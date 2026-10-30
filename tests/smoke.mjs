import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { serializeCsv } from '../js/serialization.js';
const port=process.env.SMOKE_PORT || '8199';
const server=spawn('python3',['server.py',port],{stdio:['ignore','pipe','inherit']});
let browser;
try{
 await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>reject(Error(`server exit ${code}`)));});
 browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
 const page=await browser.newPage();page.on('pageerror',error=>console.error(error));
 await page.goto(`http://localhost:${port}/`);
 const result=await page.evaluate(async()=>{
  const {verifyWasm}=await import('/tests/wasm_oracle.js');const factory=(await import('/build/motion_engine.js')).default;
  const oracle=await verifyWasm(factory);
  const {runMode}=await import('/js/benchmark.js');
  const video=document.querySelector('video');video.src='/tests/fixtures/smoke.mp4';video.loop=true;video.muted=true;
  await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(Error('Generate smoke fixture first'));});
  const canvas=document.querySelector('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
  const results=[];
  for(const mode of ['main','worker'])results.push(await runMode({mode,video,canvas,context:canvas.getContext('2d',{willReadFrequently:true}),config:{warmupMs:50,measureMs:350},signal:new AbortController().signal,onPhase:()=>{},extended:true,windows:[]}));
  return {oracle,results};
 });
 for(const record of result.results){assert.equal(record.status,'ok',JSON.stringify(record));assert.ok(record.completedWithinWindow>0);assert.equal(record.cleanupStatus,'ok');}
 async function download(button) {
  const pending=page.waitForEvent('download');await button.click();const downloaded=await pending;return readFile(await downloaded.path(),'utf8');
 }
 await page.locator('#videoFile').setInputFiles('tests/fixtures/smoke.mp4');
 await page.locator('#warmup').fill('0');await page.locator('#duration').fill('0.002');await page.locator('#rest').fill('0');await page.locator('#run').click();
 await page.waitForFunction(()=>/^(ok|failed|stopped)/.test(document.querySelector('#status').textContent));
 const session=JSON.parse(await download(page.locator('#downloadJson')));
 assert.equal(session.status,'ok',JSON.stringify(session));assert.equal(session.results.length,2);assert.ok(session.build?.buildId);
 assert.equal(await download(page.locator('#downloadCsv')),serializeCsv(session));
 assert.equal(await download(page.getByRole('button',{name:'Download Windows CSV'})),serializeCsv(session,'windows'));
 await page.goto(`http://localhost:${port}/diagnostic/`);
 await page.locator('#file').setInputFiles('tests/fixtures/smoke.mp4');await page.locator('#mode').selectOption('worker');
 await page.locator('#warmup').fill('0');await page.locator('#measure').fill('1');await page.locator('#run').click();
 await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('measuring'));
 await page.waitForTimeout(120);await page.locator('#stop').click();
 await page.waitForFunction(()=>/^(ok|failed|stopped)/.test(document.querySelector('#status').textContent));
 const partial=JSON.parse(await download(page.locator('#json')));assert.equal(partial.status,'stopped');assert.equal(partial.results[0].cleanupStatus,'ok');
 assert.equal(await download(page.locator('#csv')),serializeCsv(partial));
 assert.equal(await download(page.getByRole('button',{name:'Download Windows CSV'})),serializeCsv(partial,'windows'));
 result.ui={benchmarkStatus:session.status,diagnosticStatus:partial.status,exportsAgree:true};
 result.browserVersion=browser.version();console.log(JSON.stringify(result,null,2));
}finally{await browser?.close();server.kill();}
