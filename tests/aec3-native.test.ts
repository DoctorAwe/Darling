import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MediaPacket } from '../packages/protocol/src/media';
const executable = resolve('native/media-engine/build/aec3-evaluation/Release/darling-media-aec3.exe');
test('experimental AEC identifies itself and rejects playback without fresh capture (no devices opened)', { skip: !existsSync(executable) && 'Build native:aec3-evaluate first' }, () => {
  const commands = ['engine.hello', 'capture.status', 'playback.start', 'engine.shutdown'];
  const input = commands.map((type, i) => JSON.stringify({ protocolVersion: 1, requestId: String(i), type, payload: {} })).join('\n') + '\n';
  const child = spawnSync(executable, [], { input, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
  const packets = child.stdout.trim().split('\n').map(line => MediaPacket.parse(JSON.parse(line)));
  assert.equal(packets.length, 4);
  assert.equal(packets[0].type, 'engine.ready');
  if (packets[0].type === 'engine.ready') { assert.equal(packets[0].payload.capabilities.aec, true); assert.match(packets[0].payload.engineVersion, /experimental/); }
  assert.equal(packets[1].type, 'capture.state');
  if (packets[1].type === 'capture.state') { assert.equal(packets[1].payload.running, false); assert.equal(packets[1].payload.processing?.mode, 'bypass'); }
  assert.equal(packets[2].type, 'engine.error');
  assert.equal(packets[3].type, 'engine.stopped');
});

test('experimental AEC explicit on/off and invalid values (no audio devices)', { skip: !existsSync(executable) }, () => {
  const requests = [
    { type: 'engine.hello', payload: {} },
    { type: 'processing.set', payload: { aecEnabled: true } },
    { type: 'processing.set', payload: { aecEnabled: false } },
    { type: 'processing.set', payload: { aecEnabled: 'false' } },
    { type: 'capture.status', payload: {} },
    { type: 'engine.shutdown', payload: {} },
  ];
  const input=requests.map((r,i)=>JSON.stringify({protocolVersion:1,requestId:String(i),...r})).join('\n')+'\n';
  const child=spawnSync(executable,[],{input,encoding:'utf8',windowsHide:true,timeout:10000});
  assert.ifError(child.error); assert.equal(child.status,0,child.stderr);
  const p=child.stdout.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(p[0].payload.capabilities.aecControl,true);
  assert.equal(p[1].payload.processing.mode,'aec3-experimental');
  assert.equal(p[2].payload.processing.mode,'bypass');
  assert.equal(p[3].type,'engine.error');
  assert.equal(p[4].payload.processing.mode,'bypass');
  assert.equal(p[4].payload.processing.captureBlocks,0);
});
