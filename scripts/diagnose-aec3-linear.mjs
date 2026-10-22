// Reuse exact normalized input bytes; no devices, playback, or parameter search.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const input=resolve(process.argv[2]??'.local/aec-comparison-1792564180176');
const output=resolve('.local',`aec3-linear-${Date.now()}`);mkdirSync(output,{recursive:true});
const load=p=>{const b=readFileSync(p);return new Float32Array(b.buffer,b.byteOffset,b.length/4);};
const results=[];
function score(x,y,start,end) {
  let best=-Infinity,lag=0;
  for(let l=-640;l<=640;l++) {
    let xx=0,yy=0,xy=0;
    for(let i=start;i<end;i+=16){xx+=x[i]*x[i];yy+=y[i+l]*y[i+l];xy+=x[i]*y[i+l];}
    const c=xy/Math.sqrt(Math.max(xx*yy,1e-30));if(c>best){best=c;lag=l;}
  }
  let xx=0,yy=0,xy=0,ee=0;
  for(let i=start;i<end;i++){xx+=x[i]*x[i];yy+=y[i+lag]*y[i+lag];xy+=x[i]*y[i+lag];ee+=(x[i]-y[i+lag])**2;}
  return {lagSamples16k:lag,correlation:xy/Math.sqrt(xx*yy),gainDb:20*Math.log10(Math.max(Math.abs(xy/xx),1e-15)),snrDb:10*Math.log10(xx/Math.max(ee,1e-30))};
}
for(const mode of ['aec3','aec3-nearend-mask']) {
  let baseline;
  for(const name of ['near-only','headphones','double-talk','weak-double-talk']) {
    const out=join(output,`${mode}-${name}.f32`);
    const ref=join(input,name==='near-only'?'near-only-reference.f32':'reference.f32');
    const mic=join(input,`${name}-capture.f32`);
    const r=spawnSync(resolve('.local/webrtc/src/out/DarlingRelease/darling_aec_chain_test.exe'),['--compare',mode,'0',ref,mic,out,'--trace-linear'],{encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(r.status,0,r.stderr);
    // Exporting diagnostics must not change the full-band output.
    assert.equal(createHash('sha256').update(readFileSync(out)).digest('hex'),createHash('sha256').update(readFileSync(join(input,`${name}-${mode}-false.f32`))).digest('hex'));
    const linear=load(out+'.linear16.f32'),final=load(out+'.final16.f32');
    assert.equal(linear.length,480000);assert.equal(final.length,480000);
    if(!baseline)baseline=linear.slice();
    const target=name==='weak-double-talk'?Float32Array.from(baseline,v=>v*.5):baseline;
    const start=(name.includes('double')?15:5)*16000,end=28*16000;
    const row={mode,case:name,linear:score(target,linear,start,end),final:score(target,final,start,end),...JSON.parse(r.stdout)};
    results.push(row);console.log(JSON.stringify(row));
  }
}
writeFileSync(join(output,'report.json'),JSON.stringify({input,reference:'per-mode near-only linear output; final output split to 16k low band; delay aligned; no RNNoise; not full-band fidelity',results},null,2));
console.log(output);
