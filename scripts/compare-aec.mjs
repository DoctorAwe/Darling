// Offline only: source WAVs remain unchanged; no recording, playback or upload.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const dir=resolve('.local',`aec-comparison-${Date.now()}`); mkdirSync(dir,{recursive:true});
const count=48000*30;
const offsetSeconds=process.argv.includes('--offset25')?25:0;
const gainDb=process.argv.includes('--gain12')?12:0;
const normalize=process.argv.includes('--normalize');
const candidate=process.argv.includes('--candidate');
const diagnosticGrid=process.argv.includes('--diagnostic-grid');
const bestCandidate=process.argv.includes('--best-candidate');
assert.ok(process.argv.slice(2).every(arg=>['--gain12','--normalize','--candidate','--diagnostic-grid','--best-candidate','--offset25'].includes(arg)));
assert.ok(!(diagnosticGrid&&bestCandidate));
assert.ok(!normalize || !gainDb);
const normalization=[];
const sources=[];
function wav(path) {
  const b=readFileSync(path); let fmt,data;
  assert.equal(b.toString('ascii',0,4),'RIFF'); assert.equal(b.toString('ascii',8,12),'WAVE');
  for(let p=12;p+8<=b.length;) {
    const n=b.readUInt32LE(p+4),end=p+8+n; assert.ok(end<=b.length);
    const tag=b.toString('ascii',p,p+4);
    if(tag==='fmt ')fmt=b.subarray(p+8,end); if(tag==='data')data=b.subarray(p+8,end); p=end+n%2;
  }
  assert.ok(fmt&&data); assert.equal(fmt.readUInt16LE(0),1); assert.equal(fmt.readUInt32LE(4),48000); assert.equal(fmt.readUInt16LE(14),16);
  const channels=fmt.readUInt16LE(2); assert.ok(channels===1||channels===2); assert.ok(data.length>=(offsetSeconds*48000+count)*channels*2);
  const x=new Float32Array(count);
  for(let i=0;i<count;i++) {const at=(offsetSeconds*48000+i)*channels*2,v=data.readInt16LE(at); if(channels===2)assert.equal(v,data.readInt16LE(at+2)); x[i]=v/32768;}
  sources.push({path:resolve(path),sha256:createHash('sha256').update(b).digest('hex'),channels,offsetSeconds,secondsUsed:30}); return x;
}
const near=wav('resource/near.wav'),far=wav('resource/far.wav');
if(normalize) for(const [name,x] of [['near',near],['far',far]]) {
  // Energy gate is a reproducible speech-activity approximation, not a VAD label.
  const energy=[];
  for(let p=0;p<x.length;p+=960){let e=0;for(let i=p;i<p+960;i++)e+=x[i]*x[i];energy.push(e/960);}
  const sorted=[...energy].sort((a,b)=>a-b);
  const threshold=Math.max(1e-12,sorted[Math.floor(sorted.length*.95)]*.01);
  const active=energy.filter(e=>e>=threshold);
  assert.ok(active.length>=50,'Insufficient active input');
  const activeRms=Math.sqrt(active.reduce((s,e)=>s+e,0)/active.length);
  const peak=x.reduce((s,v)=>Math.max(s,Math.abs(v)),0);
  const wanted=10**(-23/20)/activeRms,ceiling=10**(-3/20)/peak,gain=Math.min(wanted,ceiling);
  for(let i=0;i<x.length;i++)x[i]*=gain;
  const info={name,gainDb:20*Math.log10(gain),activeRmsBeforeDb:20*Math.log10(activeRms),activeRmsAfterDb:20*Math.log10(activeRms*gain),peakAfterDb:20*Math.log10(peak*gain),peakLimited:ceiling<wanted,activeSeconds:active.length*.02,gateDb:10*Math.log10(threshold)};
  normalization.push(info);console.log(JSON.stringify(info));
  // Float WAV preserves the exact normalized samples consumed by both algorithms.
  const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+x.byteLength,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(3,20);header.writeUInt16LE(1,22);header.writeUInt32LE(48000,24);header.writeUInt32LE(192000,28);header.writeUInt16LE(4,32);header.writeUInt16LE(32,34);header.write('data',36);header.writeUInt32LE(x.byteLength,40);
  writeFileSync(join(dir,`${name}-normalized.wav`),Buffer.concat([header,Buffer.from(x.buffer)]));
}
for(const x of [near,far]) for(let i=0;i<x.length;i++) x[i]*=10**(gainDb/20);
const inputLevels=[near,far].map(x=>({rmsDb:10*Math.log10(x.reduce((s,v)=>s+v*v,0)/x.length),peak:x.reduce((s,v)=>Math.max(s,Math.abs(v)),0)}));
const raw=(name,x)=>{const path=join(dir,name+'.f32');writeFileSync(path,Buffer.from(x.buffer));return path;};
const ref=raw('reference',far),zero=new Float32Array(count);
const echo=Float32Array.from(far,(_,i)=>(i>=4800?.5*far[i-4800]:0)+(i>=5520?.15*far[i-5520]:0));
const cases=[['near-only',zero,near,near,5,28],['headphones',far,near,near,5,28],['far-only',far,echo,null,15,28],
  ['double-talk',far,Float32Array.from(echo,(v,i)=>v+(i>=480000?near[i]:0)),near,15,28],
  ['weak-double-talk',far,Float32Array.from(echo,(v,i)=>v+(i>=480000?.5*near[i]:0)),Float32Array.from(near,v=>v*.5),15,28]];
const changed=Float32Array.from(echo,(v,i)=>i<720000?v:(i>=7680?.35*far[i-7680]:0)+(i>=8400?.1*far[i-8400]:0));
cases.push(['path-change',far,changed,null,22,28]);
function fidelity(target,out,start,end) {
  let best=-Infinity,lag=0;
  for(let l=0;l<=1920;l++) {
    let xy=0,xx=0,yy=0;
    for(let i=start;i<end;i+=48){const x=target[i],y=out[i+l];xy+=x*y;xx+=x*x;yy+=y*y;}
    const corr=xy/Math.sqrt(Math.max(xx*yy,1e-30)); if(corr>best){best=corr;lag=l;}
  }
  let xx=0,yy=0,xy=0,err=0;
  for(let i=start;i<end;i++){const x=target[i],y=out[i+lag];xx+=x*x;yy+=y*y;xy+=x*y;err+=(y-x)**2;}
  return {lagSamples:lag,correlation:xy/Math.sqrt(Math.max(xx*yy,1e-30)),projectionGainDb:20*Math.log10(Math.max(Math.abs(xy/xx),1e-15)),snrDb:10*Math.log10(xx/Math.max(err,1e-30))};
}
const results=[];
for(const [name,reference,mic,target,start,end] of cases) {
  assert.ok(mic.every(v=>Math.abs(v)<1),`clipping input ${name}`);
  const r=reference===far?ref:raw(name+'-reference',reference),c=raw(name+'-capture',mic);
  const algorithms=diagnosticGrid?['aec3','aec3-nearend-mask','aec3-bounded-residual','aec3-sensitive','aec3-sensitive-mask']:(bestCandidate?['aec3','aec3-sensitive-mask']:(candidate?['aec3','aec3-nearend-mask']:['pbfdaf','aec3']));
  for(const noise of (diagnosticGrid?[false]:[false,true])) for(const algorithm of algorithms) {
    const output=join(dir,`${name}-${algorithm}-${noise}.f32`);
    const run=spawnSync(resolve('.local/webrtc/src/out/DarlingRelease/darling_aec_chain_test.exe'),
      ['--compare',algorithm,noise?'1':'0',r,c,output],{encoding:'utf8',timeout:60000,windowsHide:true});
    assert.equal(run.status,0,run.stderr);
    const b=readFileSync(output),out=new Float32Array(b.buffer,b.byteOffset,b.byteLength/4);assert.equal(out.length,count);
    let metrics;
    if(target) metrics=fidelity(target,out,start*48000,end*48000);
    else {let x=0,y=0;for(let i=start*48000;i<end*48000;i++){x+=mic[i]**2;y+=out[i]**2;}metrics={attenuationDb:10*Math.log10(x/Math.max(y,1e-30))};}
    const result={case:name,algorithm,noise,...JSON.parse(run.stdout.trim()),...metrics};results.push(result);console.log(JSON.stringify(result));
    writeFileSync(join(dir,'results.json'),JSON.stringify({sources,inputLevels,normalization,conditions:{sampleRate:48000,seconds:30,offsetSeconds,echo:'100ms * 0.5 + 115ms * 0.15; path-change at 15s to 160ms * 0.35 + 175ms * 0.1',doubleTalkStarts:10,gainDb,levels:normalize?'per-file constant gain targeting active RMS -23 dBFS, sample peak <= -3 dBFS; 20ms energy gate at p95 minus 20dB; not semantic VAD':'same gain on both source files, weak near x0.5; sources unchanged',alignment:'0..1920 samples, step 1, scoring windows fixed; not SI-SDR',limitations:'same speaker recordings; simulated linear room; no physical device, clock drift or listening assessment'},results},null,2));
  }
}
console.log(`Report: ${join(dir,'results.json')}`);
for(const source of sources)assert.equal(createHash('sha256').update(readFileSync(source.path)).digest('hex'),source.sha256,'Original WAV changed');
