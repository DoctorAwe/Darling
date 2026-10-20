// Local-only comparison. Does not record, play, upload, or alter source WAVs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const directory = resolve('.local', `denoise-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const exe = resolve('.local/webrtc/src/out/DarlingRelease/darling_rnnoise_evaluate.exe');
const count = 48000 * 20;
const rms = a => Math.sqrt(a.reduce((sum,v)=>sum+v*v,0)/a.length);
const noise = new Float32Array(count);
let seed = 123456789, low = 0;
for (let i=0;i<count;i++) {
  seed = (Math.imul(seed,1664525)+1013904223)>>>0;
  low = .97*low + .03*(seed/4294967296*2-1);
  noise[i] = low + .015*Math.sin(i*2*Math.PI*120/48000);
}
const noiseScale = .01/rms(noise);
for(let i=0;i<count;i++) noise[i]*=noiseScale;
const cases = [{name:'silence',data:new Float32Array(count)},{name:'synthetic-fan-noise',data:noise}];
let sourceInfo;
if(process.argv[2]) {
  const bytes=readFileSync(process.argv[2]);
  assert.equal(bytes.toString('ascii',0,4),'RIFF'); assert.equal(bytes.toString('ascii',8,12),'WAVE');
  assert.equal(bytes.readUInt32LE(4)+8,bytes.length);
  let fmt,data;
  for(let p=12;p+8<=bytes.length;) {
    const n=bytes.readUInt32LE(p+4), end=p+8+n; assert.ok(end<=bytes.length);
    const tag=bytes.toString('ascii',p,p+4);
    if(tag==='fmt ')fmt=bytes.subarray(p+8,end);
    if(tag==='data')data=bytes.subarray(p+8,end);
    p=end+(n%2);
  }
  assert.ok(fmt && data); assert.equal(fmt.readUInt16LE(0),1); assert.equal(fmt.readUInt32LE(4),48000); assert.equal(fmt.readUInt16LE(14),16);
  const channels=fmt.readUInt16LE(2); assert.ok(channels===1||channels===2); assert.ok(data.length>=count*channels*2);
  const clean=new Float32Array(count);
  for(let i=0;i<count;i++) {
    const value=data.readInt16LE(i*channels*2);
    if(channels===2)assert.equal(value,data.readInt16LE(i*4+2),'Stereo must be bit-identical dual mono');
    clean[i]=value/32768;
  }
  sourceInfo={sha256:createHash('sha256').update(bytes).digest('hex'),originalRmsDb:20*Math.log10(rms(clean)),operation:'first 20 seconds, lossless channel selection'};
  cases.push({name:'original-level-speech',data:clean});
  // Separate labeled gain diagnostic; never used as evidence for original level.
  const peak=clean.reduce((maximum,v)=>Math.max(maximum,Math.abs(v)),0);
  const gain=Math.min(.05/rms(clean),.8/peak), normalized=Float32Array.from(clean,v=>v*gain);
  assert.ok(normalized.every(v=>Math.abs(v)<.95),'Gain diagnostic would clip');
  sourceInfo.diagnosticGainDb=20*Math.log10(gain);
  cases.push({name:'gain-diagnostic-clean',data:normalized},{name:'gain-diagnostic-noisy',data:Float32Array.from(normalized,(v,i)=>v+noise[i])});
}
const results=[];
for (const rate of [16000,32000]) {
  const input=join(directory,`format-${rate}.f32`),output=join(directory,`format-${rate}-out.f32`);
  const samples=Float32Array.from({length:rate*2},(_,i)=>.02*Math.sin(i*2*Math.PI*440/rate));
  writeFileSync(input,Buffer.from(samples.buffer));
  const run=spawnSync(exe,['rnnoise',input,output,String(rate)],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(run.status,0,`RNNoise ${rate} Hz: ${run.stderr}`);
  assert.equal(readFileSync(output).length,samples.byteLength);
  results.push({case:`format-${rate}`, ...JSON.parse(run.stdout.trim())});
}
for(const test of cases) {
  const input=join(directory,`${test.name}.f32`); writeFileSync(input,Buffer.from(test.data.buffer));
  for(const mode of ['webrtc','rnnoise']) {
    const output=join(directory,`${test.name}-${mode}.f32`);
    const run=spawnSync(exe,[mode,input,output],{encoding:'utf8',windowsHide:true,timeout:120000});
    assert.equal(run.status,0,`${mode} ${test.name}: ${run.stderr}`);
    const bytes=readFileSync(output); assert.equal(bytes.length,test.data.byteLength);
    const samples=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    assert.ok(samples.every(v=>Number.isFinite(v)&&Math.abs(v)<=1));
    const inputRms=rms(test.data.subarray(48000)),outputRms=rms(samples.subarray(48000));
    if(test.name==='silence')assert.ok(outputRms<1e-6,'Silence remains quiet');
    const result={case:test.name,...JSON.parse(run.stdout.trim()),inputRms,outputRms,
      attenuationDb:inputRms>0&&outputRms>0?20*Math.log10(inputRms/outputRms):null};
    results.push(result); console.log(JSON.stringify(result));
  }
}
writeFileSync(join(directory,'report.json'),JSON.stringify({sourceInfo,results,limitations:'Not a perceptual quality pass. Synthetic noise, one speaker. Gain diagnostics separate from original level. No AEC, room acoustics or hardware CPU test.'},null,2));
console.log(`Report: ${join(directory,'report.json')}`);
