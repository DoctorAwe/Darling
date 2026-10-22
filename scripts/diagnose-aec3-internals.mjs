// Reads existing normalized PCM only. No devices, playback, upload or tuning.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const inputs=process.argv.slice(2).map(value=>resolve(value));
assert.equal(inputs.length,2,'Pass first-half and held-out normalized comparison directories');
const out=resolve('.local',`aec3-internals-${Date.now()}`);mkdirSync(out,{recursive:true});
const cases=[['headphones',500,2800],['far-only',1500,2800],['double-talk',1500,2800],['weak-double-talk',1500,2800],['path-change',2200,2800]];
const rows=[];
for(const input of inputs) {
  assert.ok(existsSync(join(input,'results.json')));
  for(const mode of ['aec3','aec3-sensitive-mask']) for(const [name,start,end] of cases) {
    const reference=join(input,name==='headphones'?'reference.f32':'reference.f32');
    const capture=join(input,`${name}-capture.f32`),output=join(out,`${rows.length}.f32`);
    const run=spawnSync(resolve('.local/webrtc/src/out/DarlingRelease/darling_aec_chain_test.exe'),
      ['--compare',mode,'0',reference,capture,output,'--trace-internals',String(start),String(end)],
      {encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(run.status,0,run.stderr);
    const row={input,mode,case:name,...JSON.parse(run.stdout.trim())};rows.push(row);console.log(JSON.stringify(row));
  }
}
writeFileSync(join(out,'report.json'),JSON.stringify({inputs,windows:'10ms frames; headphones 5-28s, far/double 15-28s, path-change 22-28s',bands:'bins 1-15 of AEC3 16k low band',ratios:'arithmetic block mean, residual power / nearend power; can be dominated by low-nearend blocks',rows},null,2));
console.log(`Report: ${join(out,'report.json')}`);
