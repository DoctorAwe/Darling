import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AudioDevice } from '../packages/protocol/src/media';
const executable = resolve('apps/desktop/dist/native/darling-media.exe');
const unavailable = !existsSync(executable) && 'Build the real native engine with pnpm native:build first';

test('standard engine confirms bypass and rejects unavailable AEC without opening devices', {skip: unavailable},()=>{
  const requests=[{type:'engine.hello',payload:{}},{type:'processing.set',payload:{aecEnabled:false}},{type:'processing.set',payload:{aecEnabled:true}},{type:'capture.status',payload:{}},{type:'engine.shutdown',payload:{}}];
  const input=requests.map((r,i)=>JSON.stringify({protocolVersion:1,requestId:String(i),...r})).join('\n')+'\n';
  const child=spawnSync(executable,[],{input,encoding:'utf8',windowsHide:true,timeout:10000});
  assert.ifError(child.error); assert.equal(child.status,0,child.stderr);
  const p=child.stdout.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(p[0].payload.capabilities.aecControl,true);
  assert.equal(p[1].payload.processing.mode,'bypass');
  assert.equal(p[2].type,'engine.error');
  assert.equal(p[3].payload.running,false);
  assert.equal(p[3].payload.processing.mode,'bypass');
});
test('real native executable: handshake enforcement, version checks, devices, shutdown', { skip: unavailable }, () => {
  const request = (requestId: string, type: string, protocolVersion = 1) => JSON.stringify({ protocolVersion, requestId, type, payload: {} });
  const input = [request('before', 'devices.list'), request('version', 'engine.hello', 2), '{invalid', request('hello', 'engine.hello'), request('devices', 'devices.list'), request('unsupported', 'call.start'), request('stop', 'engine.shutdown')].join('\n') + '\n';
  const child = spawnSync(executable, [], { input, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
  const packets = child.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(packets.length, 7);
  assert.equal(packets[0].payload.code, 'HANDSHAKE_REQUIRED');
  assert.equal(packets[1].payload.code, 'VERSION_MISMATCH');
  assert.equal(packets[2].payload.code, 'REQUEST_FAILED');
  assert.equal(packets[3].type, 'engine.ready');
  assert.equal(packets[3].payload.capabilities.capture, true);
  assert.equal(packets[4].type, 'devices.listed');
  assert.ok(Array.isArray(packets[4].payload.devices));
  for (const device of packets[4].payload.devices) {
    assert.equal(typeof device.formFactor, 'string');
    assert.ok(AudioDevice.safeParse(device).success);
  }
  assert.equal(packets[5].payload.code, 'UNSUPPORTED_COMMAND');
  assert.equal(packets[6].type, 'engine.stopped');
});
test('real native executable rejects oversized input with bounded failure', { skip: unavailable }, () => {
  const child = spawnSync(executable, [], { input: 'x'.repeat(65537) + '\n', encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.ifError(child.error); assert.equal(child.status, 2);
  assert.match(child.stderr, /exceeds protocol limit/);
});
test('real native capture rejects nonexistent devices and remains stopped', { skip: unavailable }, () => {
  const packets = [
    { type: 'engine.hello', payload: {} },
    { type: 'capture.start', payload: { deviceId: 'darling-device-that-does-not-exist' } },
    { type: 'capture.status', payload: {} },
    { type: 'engine.shutdown', payload: {} },
  ].map((packet, i) => JSON.stringify({ protocolVersion: 1, requestId: String(i), ...packet })).join('\n') + '\n';
  const child = spawnSync(executable, [], { input: packets, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.ifError(child.error); assert.equal(child.status, 0);
  const results = child.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(results[1].type, 'engine.error');
  assert.equal(results[2].payload.running, false);
  assert.equal(results[2].payload.reason, 'error');
  assert.equal(results[2].payload.frames, 0);
});
test('real output rejects nonexistent devices without starting playback', { skip: unavailable }, () => {
  const packets = [
    { type: 'engine.hello', payload: {} },
    { type: 'playback.start', payload: { deviceId: 'darling-output-that-does-not-exist' } },
    { type: 'playback.status', payload: {} },
    { type: 'engine.shutdown', payload: {} },
  ].map((packet, i) => JSON.stringify({ protocolVersion: 1, requestId: String(i), ...packet })).join('\n') + '\n';
  const child = spawnSync(executable, [], { input: packets, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.ifError(child.error); assert.equal(child.status, 0);
  const results = child.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(results[1].type, 'engine.error');
  assert.equal(results[2].payload.running, false);
  assert.equal(results[2].payload.reason, 'error');
  assert.equal(results[2].payload.frames, 0);
});
