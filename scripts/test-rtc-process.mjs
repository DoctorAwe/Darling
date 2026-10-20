// Explicit opt-in native process test. No microphone, TURN, or remote server.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const executable = resolve('.local/webrtc/src/out/DarlingRelease/darling_rtc_process.exe');
const synthetic = process.argv.includes('--synthetic-audio');
function start(args = synthetic ? ['--synthetic-audio'] : []) {
  const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const fail = error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); };
  child.on('error', fail);
  child.on('exit', () => fail(new Error('native process exited')));
  child.stdin.on('error', fail);
  child.stderr.on('data', () => {});
  child.stdout.on('data', chunk => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > 65536) { fail(new Error('oversized response')); child.kill(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const response = JSON.parse(line);
        assert.equal(response.protocolVersion, 1);
        const entry = pending.get(response.requestId);
        if (!entry) throw new Error('unexpected response id');
        pending.delete(response.requestId); clearTimeout(entry.timer); entry.resolve(response);
      } catch (error) { fail(error); child.kill(); }
    }
  });
  return {
    child,
    request(type, payload = {}) {
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`timeout: ${type}`)); child.kill(); }, 20000);
        pending.set(requestId, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ protocolVersion: 1, requestId, type, payload }) + '\n');
      });
    },
  };
}
const a = start(), b = start();
try {
  // Only invalid requests: these must be rejected BEFORE creating an ADM.
  const gated = start(['--wasapi-audio']);
  try {
    assert.equal((await gated.request('engine.hello')).payload.wasapiAudio, true);
    const scope = { callId: randomUUID(), generation: 1, role: 'caller', iceMode: 'direct' };
    for (const deviceAudio of [undefined, {}, { confirmed: false, inputDeviceId: 'x', outputDeviceId: 'y', outputProfile: 'speakers', noiseSuppression: true }]) {
      const response = await gated.request('rtc.open', { ...scope, ...(deviceAudio ? { deviceAudio } : {}) });
      assert.equal(response.payload.code, 'DEVICE_AUDIO_CONFIRMATION_REQUIRED');
    }
    const exited = once(gated.child, 'exit');
    await gated.request('engine.shutdown'); assert.equal((await exited)[0], 0);
  } finally { if (gated.child.exitCode === null) gated.child.kill(); }
  console.log('PASS: WASAPI unconfirmed requests rejected before device initialization.');
  const scope = { callId: randomUUID(), generation: 1 };
  assert.equal((await a.request('rtc.open', { ...scope, role: 'caller' })).payload.code, 'HANDSHAKE_REQUIRED');
  for (const host of [a, b]) {
    const hello = await host.request('engine.hello');
    assert.equal(hello.type, 'engine.ready');
    assert.equal(hello.payload.negotiationOnly, !synthetic);
    assert.equal(hello.payload.syntheticAudio, synthetic);
    assert.equal(hello.payload.rtc, false); assert.equal(hello.payload.capture, false);
  }
  assert.equal((await a.request('rtc.open', { ...scope, generation: 2, role: 'caller' })).payload.code, 'INVALID_SCOPE');
  assert.equal((await a.request('rtc.open', { ...scope, role: 'caller' })).type, 'rtc.ok');
  assert.equal((await b.request('rtc.open', { ...scope, role: 'callee' })).type, 'rtc.ok');
  assert.equal((await a.request('rtc.close', { ...scope, callId: randomUUID() })).payload.code, 'STALE_CALL');
  const offer = await a.request('rtc.offer', scope);
  assert.equal(offer.type, 'rtc.description'); assert.equal(offer.payload.kind, 'offer');
  assert.match(offer.payload.sdp, /opus\/48000\/2/);
  assert.equal((await a.request('rtc.offer', scope)).type, 'engine.error');
  const answer = await b.request('rtc.apply', offer.payload);
  assert.equal(answer.type, 'rtc.description'); assert.equal(answer.payload.kind, 'answer');
  assert.equal((await a.request('rtc.apply', answer.payload)).type, 'rtc.ok');
  assert.equal((await a.request('rtc.apply', answer.payload)).payload.code, 'UNEXPECTED_DESCRIPTION');
  for (const host of [a, b]) assert.equal((await host.request('rtc.close', scope)).type, 'rtc.ok');
  assert.equal((await a.request('rtc.apply', answer.payload)).payload.code, 'STALE_CALL');
  const next = { callId: randomUUID(), generation: 1, role: 'callee' };
  assert.equal((await a.request('rtc.open', next)).type, 'rtc.ok');
  assert.equal((await a.request('rtc.apply', { ...next, kind: 'offer', sdp: 'invalid SDP' })).payload.code, 'DESCRIPTION_FAILED');
  assert.equal((await a.request('rtc.close', next)).payload.code, 'STALE_CALL');
  for (const host of [a, b]) {
    const exited = once(host.child, 'exit');
    await host.request('engine.shutdown');
    const [code] = await exited; assert.equal(code, 0);
  }
  console.log(`PASS: two native processes, scoped JSON offer/answer, handshake/generation/stale/replay/malformed rejection, clean shutdown. Synthetic=${synthetic}.`);
  for (const [input, expectedCode] of [['', 0], ['not-json\n', 4], ['x'.repeat(65537) + '\n', 3]]) {
    const host = start();
    const exited = once(host.child, 'exit');
    const timeout = setTimeout(() => host.child.kill(), 5000);
    try {
      host.child.stdin.end(input);
      assert.equal((await exited)[0], expectedCode);
    } finally { clearTimeout(timeout); if (host.child.exitCode === null) host.child.kill(); }
  }
  console.log('PASS: EOF cleanup and malformed/oversized input fail-closed.');
} finally {
  for (const host of [a, b]) if (host.child.exitCode === null) host.child.kill();
}
