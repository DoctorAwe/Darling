// Protocol test double only. Never shipped as the actual audio engine.
import { createInterface } from 'node:readline';
const mode = process.argv[2];
const caps = { devices: true, capture: false, playback: false, aec: false, noiseSuppression: false, rtc: false };
if (mode === 'capture') caps.capture = true;
if (mode === 'aec-control' || mode === 'aec-mismatch' || mode === 'aec-legacy') { caps.capture = true; caps.aec = true; }
if (mode === 'aec-control' || mode === 'aec-mismatch') caps.aecControl = true;
if (mode === 'playback') caps.playback = true;
if (mode?.startsWith('device-')) { caps.capture=true; caps.playback=true; }
let lists=0;
let responseQueue = Promise.resolve();
const makeDevice=(id,direction,isDefault=false)=>({id,name:'测试设备',direction,isDefault,isCommunicationsDefault:false,rawSupport:'unknown',mixFormat:{sampleRate:48000,channels:1,containerBits:32}});
const playback = { running: false, deviceId: '', frames: 0, paddingFrames: 0, streamLatencyMs: 10, reason: 'idle', error: '', referenceBlocks: 0, droppedReferences: 0, sampleRate: 48000, channels: 1 };
const capture = { running: false, deviceId: '', format: null, peak: 0, rms: 0, frames: 0, clippedSamples: 0, discontinuities: 0, timestampErrors: 0, reason: 'idle', error: '', rawMode: 'not-requested' };
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (mode === 'timeout') return;
  if (mode === 'oversized') { process.stdout.write('x'.repeat(65537)); return; }
  if (mode === 'malformed') { process.stdout.write('{nope}\n'); return; }
  if (mode === 'exit') { process.exit(7); }
  const packet = { protocolVersion: mode === 'version' ? 2 : 1, requestId: request.requestId };
  if (request.type === 'engine.hello') Object.assign(packet, { type: 'engine.ready', payload: { engineVersion: 'test-only', capabilities: caps, dependencies: {} } });
  if (request.type === 'devices.list') Object.assign(packet, { type: 'devices.listed', payload: { devices: [{ id: 'test', name: '测试麦克风', direction: 'input', isDefault: true, isCommunicationsDefault: true, rawSupport: 'unknown', mixFormat: { sampleRate: 48000, channels: 1, containerBits: 32 } }] } });
  if(request.type==='devices.list' && (caps.capture || caps.playback)) {
    ++lists;
    let devices=[makeDevice('test','input',true),makeDevice('test-input','input'),makeDevice('other-input','input'),makeDevice('output-one','output',true),makeDevice('output-two','output')];
    if(mode==='device-missing-start' && lists>=2) devices=devices.filter(d=>d.id!=='test');
    if(mode==='device-remove' && lists>=4) devices=devices.filter(d=>d.id!=='test');
    if(mode==='device-format' && lists>=4) devices=devices.map(d=>d.id==='test'?{...d,mixFormat:{...d.mixFormat,sampleRate:44100}}:d);
    if(mode==='device-default' && lists>=3) devices=devices.map(d=>({...d,isDefault:d.id==='other-input'||d.id==='output-two'}));
    packet.payload={devices};
  }
  if (request.type === 'engine.shutdown') Object.assign(packet, { type: 'engine.stopped', payload: {} });
  if (request.type === 'processing.set') {
    capture.processing = { sampleRate: 48000, blockSamples: 480, channels: 1, mode: mode === 'aec-mismatch' || request.payload.aecEnabled ? 'aec3-experimental' : 'bypass', captureBlocks: 0, referenceBlocks: 0, droppedReferences: 0, staleReferences: 0 };
    Object.assign(packet, {type:'capture.state',payload:capture});
  }
  if (request.type.startsWith('capture.')) {
    if (request.type === 'capture.start') { capture.running = true; capture.deviceId = request.payload.deviceId; capture.reason = 'running'; capture.frames = 0; }
    if (request.type === 'capture.status' && capture.running) { capture.frames += 4800; capture.peak = 0.25; capture.rms = 0.1; }
    if (request.type === 'capture.stop') { capture.running = false; capture.peak = 0; capture.rms = 0; capture.reason = 'stopped'; }
    Object.assign(packet, { type: 'capture.state', payload: capture });
  }
  if (request.type.startsWith('playback.')) {
    if (request.type === 'playback.start') { playback.running = true; playback.deviceId = request.payload.deviceId; playback.reason = 'running'; playback.frames = 0; }
    if (request.type === 'playback.status' && playback.running) { playback.frames += 24000; playback.referenceBlocks += 50; if (playback.frames >= 48000 && !mode?.startsWith('device-')) { playback.running = false; playback.reason = 'complete'; } }
    if (request.type === 'playback.stop') { playback.running = false; playback.reason = 'stopped'; }
    Object.assign(packet, { type: 'playback.state', payload: playback });
  }
  if (mode === 'device-capture-error' && request.type === 'capture.status') Object.assign(capture, { running: false, reason: 'error', error: 'fixture capture failure' });
  if (mode === 'device-playback-error' && request.type === 'playback.status') Object.assign(playback, { running: false, reason: 'error', error: 'fixture playback failure' });
  const bytes = Buffer.from(JSON.stringify(packet) + '\n');
  // Deliberately split UTF-8 within a multibyte character and split NDJSON across writes.
  const marker = bytes.indexOf(Buffer.from('测'));
  const split = marker > 0 ? marker + 1 : 9;
  // Split transport chunks, never interleave two distinct NDJSON records.
  const send = () => { responseQueue = responseQueue.then(() => new Promise(resolve => {
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => { process.stdout.write(bytes.subarray(split)); resolve(); if (request.type === 'engine.shutdown') process.exit(0); }, 5);
  })); };
  if (mode === 'device-late-stop' && ['capture.stop','playback.stop'].includes(request.type)) setTimeout(send, 80);
  else send();
});
