import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { MediaHost } from '../apps/desktop/src/media';
const fixture = resolve('tests/fixtures/media-child.mjs');

for (const stream of ['capture', 'playback'] as const) test(`${stream} failure stops both streams without restarting`, async () => {
  const host = new MediaHost(process.execPath, [fixture, `device-${stream}-error`], 1500);
  try {
    await host.start(); await host.startCapture('test'); await host.startPlayback('output-one');
    for (let i=0; i<40 && host.state.status==='ready'; ++i) await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(host.state.status, 'error');
    assert.match(host.state.detail, new RegExp(`fixture ${stream} failure`));
    assert.equal(host.state.capture, undefined); assert.equal(host.state.playback, undefined);
    await host.inspect(); assert.equal(host.state.status, 'ready');
    assert.equal(host.state.capture, undefined); assert.equal(host.state.playback, undefined);
  } finally { await host.stop(); }
});

test('shutdown invalidates outstanding stream stop responses', async () => {
  const host = new MediaHost(process.execPath, [fixture, 'device-late-stop'], 1500);
  try {
    await host.start(); await host.startCapture('test'); await host.startPlayback('output-one');
    await Promise.all([host.stopCapture(), host.stopPlayback(), host.stop()]);
    assert.equal(host.state.status, 'stopped');
    assert.equal(host.state.capture, undefined); assert.equal(host.state.playback, undefined);
  } finally { await host.stop(); }
});

for (const stream of ['capture', 'playback'] as const) test(`late ${stream} stop cannot overwrite a newer start`, async () => {
  const host = new MediaHost(process.execPath, [fixture, 'device-late-stop'], 1500);
  const start = () => stream === 'capture' ? host.startCapture('test') : host.startPlayback('output-one');
  const stop = () => stream === 'capture' ? host.stopCapture() : host.stopPlayback();
  try {
    await host.start(); await start();
    const stopping = stop();
    await start();
    await stopping;
    assert.equal(host.state.status, 'ready');
    assert.equal(host.state[stream]?.running, true);
    await stop(); assert.equal(host.state[stream]?.running, false);
  } finally { await host.stop(); }
});

for(const mode of ['device-remove','device-format']) test(`active device guard stops both streams on ${mode}`,async()=>{
  const host=new MediaHost(process.execPath,[fixture,mode],1500,150);
  try {
    await host.start(); await host.startCapture('test'); await host.startPlayback('output-one');
    for(let i=0;i<40 && host.state.status==='ready';++i) await new Promise(r=>setTimeout(r,25));
    assert.equal(host.state.status,'error');
    assert.match(host.state.detail,/移除或格式变化/);
    assert.equal(host.state.capture,undefined); assert.equal(host.state.playback,undefined);
    await new Promise(r=>setTimeout(r,200)); assert.equal(host.state.status,'error');
    await host.inspect(); assert.equal(host.state.status,'ready');
    assert.equal(host.state.capture,undefined); assert.equal(host.state.playback,undefined);
  } finally {await host.stop();}
});
test('device missing between initial enumeration and start never begins capture',async()=>{
  const host=new MediaHost(process.execPath,[fixture,'device-missing-start'],1500,100);
  try {await host.start(); await host.startCapture('test'); assert.equal(host.state.status,'error'); assert.equal(host.state.capture,undefined);}
  finally {await host.stop();}
});
test('default changes do not migrate active endpoints and stop cancels monitoring',async()=>{
  const host=new MediaHost(process.execPath,[fixture,'device-default'],1500,75);
  try {
    await host.start(); await host.startCapture('default'); await host.startPlayback('output-one');
    await new Promise(r=>setTimeout(r,300));
    assert.equal(host.state.status,'ready'); assert.equal(host.state.capture?.deviceId,'test');
    assert.equal(host.state.playback?.deviceId,'output-one');
    assert.equal(host.state.devices.find(d=>d.direction==='input'&&d.isDefault)?.id,'other-input');
    await host.stop(); await new Promise(r=>setTimeout(r,200));
    assert.equal(host.state.status,'stopped'); assert.deepEqual(host.state.devices,[]);
  } finally {await host.stop();}
});

test('AEC selection defaults off and explicit enabling survives start/stop', async () => {
  const host=new MediaHost(process.execPath,[fixture,'aec-control'],1500);
  try {
    await host.start(); await host.startCapture('test');
    assert.equal(host.state.capture?.processing?.mode,'bypass');
    await host.stopCapture(); await host.startCapture('test',true);
    assert.equal(host.state.capture?.processing?.mode,'aec3-experimental');
    await host.stopCapture(); await host.startCapture('test',false);
    assert.equal(host.state.capture?.processing?.mode,'bypass');
  } finally { await host.stop(); }
});
for (const mode of ['aec-mismatch','aec-legacy']) test(`AEC fails closed for ${mode}`,async()=>{
  const host=new MediaHost(process.execPath,[fixture,mode],1500);
  try { await host.start(); await host.startCapture('test',false); assert.equal(host.state.status,'error'); assert.notEqual(host.state.capture?.running,true); }
  finally { await host.stop(); }
});
test('media IPC handshake, split UTF-8, device response and shutdown', async () => {
  const host = new MediaHost(process.execPath, [fixture], 1500);
  try {
    await host.start(); assert.equal(host.state.status, 'ready');
    assert.equal(host.state.devices[0].name, '测试麦克风');
    assert.equal(host.state.capabilities.capture, false);
    await host.refresh(); assert.equal(host.state.devices.length, 1);
  } finally { await host.stop(); }
  assert.equal(host.state.status, 'stopped');
});
for (const mode of ['timeout', 'oversized', 'malformed', 'version', 'exit']) {
  test(`media IPC rejects ${mode} and clears capabilities`, async () => {
    const host = new MediaHost(process.execPath, [fixture, mode], 250);
    try { await host.start(); assert.equal(host.state.status, 'error'); assert.equal(host.state.capabilities.devices, false); }
    finally { await host.stop(); }
  });
}
test('missing native executable is unavailable, never ready', async () => {
  const host = new MediaHost(resolve('native/missing-engine.exe'), [], 500);
  try { await host.start(); assert.equal(host.state.status, 'unavailable'); }
  finally { await host.stop(); }
});
test('capture control polls levels, stops and reopens without stale state', async () => {
  const host = new MediaHost(process.execPath, [fixture, 'capture'], 1500);
  try {
    await host.start(); await host.startCapture('test-input');
    assert.equal(host.state.capture?.running, true);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok((host.state.capture?.frames ?? 0) > 0);
    await host.stopCapture();
    const frames = host.state.capture?.frames;
    assert.equal(host.state.capture?.running, false);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(host.state.capture?.frames, frames);
    await host.startCapture('other-input');
    assert.equal(host.state.capture?.deviceId, 'other-input');
  } finally { await host.stop(); }
  assert.equal(host.state.capture, undefined);
});
test('playback control detects completion and stops an explicit restart', async () => {
  const host = new MediaHost(process.execPath, [fixture, 'playback'], 1500);
  try {
    await host.start(); await host.startPlayback('output-one');
    assert.equal(host.state.playback?.running, true);
    for (let i = 0; i < 30 && host.state.playback?.running; ++i) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(host.state.playback?.reason, 'complete');
    assert.equal(host.state.playback?.frames, 48000);
    await host.startPlayback('output-two');
    assert.equal(host.state.playback?.deviceId, 'output-two');
    await host.stopPlayback(); assert.equal(host.state.playback?.running, false);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(host.state.playback?.reason, 'stopped');
  } finally { await host.stop(); }
});
