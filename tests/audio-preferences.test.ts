import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { AudioPreferences } from '../apps/desktop/src/audio-preferences';
import { resolveAudioPair, defaultCallAudio } from '../apps/desktop/src/audio-pair';
import { AudioDevice } from '../packages/protocol/src/media';
const device=(id:string,direction:'input'|'output',isDefault=false)=>AudioDevice.parse({id,name:'同名设备',direction,isDefault,isCommunicationsDefault:false,rawSupport:'unknown',mixFormat:null});
test('calls resolve current system defaults with AEC and noise suppression enabled', () => {
  const settings = defaultCallAudio([device('mic','input',true),device('headphones','output',true)]);
  assert.equal(settings.inputDeviceId,'mic'); assert.equal(settings.outputDeviceId,'headphones');
  assert.equal(settings.outputProfile,'speakers'); assert.equal(settings.noiseSuppression,true);
  assert.throws(()=>defaultCallAudio([]));
  assert.throws(()=>defaultCallAudio([device('a','input',true),device('b','input',true),device('out','output',true)]));
});
test('headphones and headsets retain device metadata and noise suppression (AEC policy is native)', () => {
  for (const formFactor of ['headphones', 'headset'] as const) {
    const input = device('mic','input',true);
    const output = {...device('out','output',true), formFactor};
    const settings = defaultCallAudio([input,output]);
    assert.equal(settings.outputProfile,'headphones'); assert.equal(settings.noiseSuppression,true);
    assert.equal(defaultCallAudio([input,{...output,formFactor:'speakers'}]).outputProfile,'speakers');
  }
});
test('device pairs resolve exact endpoints, not names or ambiguous defaults',()=>{
  const list=[device('mic','input',true),device('headset','output',true),device('speaker','output')];
  assert.deepEqual(resolveAudioPair(list,'default','default'),{inputId:'mic',outputId:'headset'});
  const switched=list.map(d=>({...d,isDefault:d.direction==='input'||d.id==='speaker'}));
  assert.deepEqual(resolveAudioPair(switched,'default','default'),{inputId:'mic',outputId:'speaker'});
  assert.deepEqual(resolveAudioPair(switched,'mic','headset'),{inputId:'mic',outputId:'headset'});
  assert.equal(resolveAudioPair(list,'missing','default'),null);
  assert.equal(resolveAudioPair(list,'headset','mic'),null);
  assert.equal(resolveAudioPair([...list,device('extra','output',true)],'default','default'),null);
});
test('explicit settings persist and corrupt files remain untouched',()=>{
  const dir=mkdtempSync(join(tmpdir(),'darling-preferences-'));
  const path=join(dir,'audio-preferences.json');
  const pair={inputId:'mic',outputId:'headset'};
  try {
    const prefs=new AudioPreferences(path);
    assert.deepEqual(prefs.get(pair),{aecEnabled:false,saved:false});
    prefs.set(pair,true);
    assert.deepEqual(new AudioPreferences(path).get(pair),{aecEnabled:true,saved:true});
    assert.deepEqual(prefs.get({...pair,outputId:'speaker'}),{aecEnabled:false,saved:false});
    assert.deepEqual(prefs.get({inputId:'headset',outputId:'mic'}),{aecEnabled:false,saved:false});
    prefs.set({...pair,outputId:'speaker'},false);
    prefs.set(pair,false);
    assert.equal(JSON.parse(readFileSync(path,'utf8')).entries.length,2);
    assert.deepEqual(prefs.get(pair),{aecEnabled:false,saved:true});
    assert.throws(()=>prefs.set({...pair,inputId:'default'},true));
    assert.throws(()=>prefs.set(pair,'true' as unknown as boolean));
    for (const invalid of ['{broken',JSON.stringify({version:2,entries:[]}),JSON.stringify({version:1,entries:[{...pair,aecEnabled:true},{...pair,aecEnabled:false}]})]) {
      writeFileSync(path,invalid);
      assert.throws(()=>prefs.get(pair)); assert.throws(()=>prefs.set(pair,false));
      assert.equal(readFileSync(path,'utf8'),invalid);
    }
  } finally {
    assert.equal(resolve(dir).startsWith(resolve(tmpdir())+'\\darling-preferences-'),true);
    rmSync(dir,{recursive:true});
  }
});
