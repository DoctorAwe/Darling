import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RtcProcessHost, DeviceAudio } from '../apps/desktop/src/rtc-process';
import { RtcNegotiation } from '../apps/desktop/src/rtc-negotiation';
import type { Session } from '../apps/desktop/src/session';
import type { Snapshot, RtcSignal } from '../packages/protocol/src/index';

const fixture = resolve('tests/fixtures/rtc-child.mjs');
test('graceful stop falls back when child ignores EOF and rejects further work', async () => {
  const host = new RtcProcessHost(process.execPath, { callId: randomUUID(), generation: 1 }, 'callee', [fixture, 'hang-on-eof']);
  try {
    await host.start();
    await assert.rejects(host.stop(-1), /Invalid stop/);
    const stopping = host.stop(50);
    assert.equal(host.stop(50), stopping);
    await assert.rejects(host.start(), /closed/);
    assert.equal(await stopping, 'forced');
  } finally { host.close(); }
});
test('real native synthetic host cleans up through EOF', { skip: process.env.DARLING_TEST_RTC_NATIVE !== '1', timeout: 10000 }, async () => {
  const host = new RtcProcessHost(resolve('.local/webrtc/src/out/DarlingRelease/darling_rtc_process.exe'),
    { callId: randomUUID(), generation: 1 }, 'callee', ['--synthetic-audio']);
  try { await host.start(); assert.equal(await host.stop(), 'graceful'); }
  finally { host.close(); }
});
test('WASAPI requires explicit endpoints and confirmation before spawning', async () => {
  const audio = { confirmed: true as const, inputDeviceId: 'input-id', outputDeviceId: 'output-id', outputProfile: 'headphones' as const, noiseSuppression: true };
  for (const invalid of [{ ...audio, confirmed: false }, { ...audio, inputDeviceId: 'default' }, { ...audio, outputDeviceId: '' }, { ...audio, outputProfile: 'auto' }, { ...audio, inputDeviceId: 'a\0b' }])
    assert.equal(DeviceAudio.safeParse(invalid).success, false);
  for (const [args, config, mode] of [
    [['--wasapi-audio'], undefined, 'direct'], [[], audio, 'direct'],
    [['--wasapi-audio', '--synthetic-audio'], audio, 'direct'], [['--wasapi-audio'], audio, 'disabled'],
  ] as const) {
    const host = new RtcProcessHost('must-not-launch.exe', { callId: randomUUID(), generation: 1 }, 'caller', [...args], 1000, mode, undefined, config);
    try { await assert.rejects(host.start(), /Explicit WASAPI/); } finally { host.close(); }
  }
});
for (const mode of ['silent', 'garbage', 'oversized', 'exit', 'wrong-scope', 'unexpected-synthetic']) {
  test(`RTC host fails closed on ${mode}`, async () => {
    const host = new RtcProcessHost(process.execPath, { callId: randomUUID(), generation: 1 }, 'callee', [fixture, mode], 500);
    let faults = 0; host.on('fault', () => ++faults);
    try {
      await assert.rejects(host.start());
      assert.equal(faults, 1);
      await assert.rejects(host.start(), /closed/);
    } finally { host.close(); }
  });
}
test('synthetic mode requires an explicit matching native handshake', async () => {
  const host = new RtcProcessHost(process.execPath, { callId: randomUUID(), generation: 1 }, 'callee', [fixture, 'normal', '--synthetic-audio']);
  host.on('fault', () => {});
  try { await assert.rejects(host.start(), /Invalid RTC handshake/); } finally { host.close(); }
});
test('RTC host close invalidates startup and rejects unsupported/stale input', async () => {
  const host = new RtcProcessHost(process.execPath, { callId: randomUUID(), generation: 1 }, 'callee', [fixture, 'silent']);
  const startup = assert.rejects(host.start(), /closed/);
  host.close(); host.close(); await startup;
  await assert.rejects(host.apply({ callId: randomUUID(), generation: 1, kind: 'offer', sdp: 'v=0' }));
});

test('early ICE buffering is bounded and disabled mode rejects candidates', async () => {
  const scope = { callId: randomUUID(), generation: 1 as const };
  const candidate = { ...scope, kind: 'ice', candidate: '', sdpMid: '0', sdpMLineIndex: 0 };
  const disabled = new RtcProcessHost(process.execPath, scope, 'callee');
  await assert.rejects(disabled.apply(candidate), /disabled/); disabled.close();
  const host = new RtcProcessHost(process.execPath, scope, 'callee', [], 1000, 'direct');
  for (let i = 0; i < 128; ++i) await host.apply(candidate);
  await assert.rejects(host.apply(candidate), /limit/); host.close();
  await assert.rejects(host.apply(candidate), /closed/);
});

test('relay host refuses missing, expired or STUN-only configuration before spawning', async () => {
  for (const ice of [undefined, { iceServers: [{ urls: ['turn:127.0.0.1:3478'], username: 'test', credential: 'test' }], expiresAt: Date.now() + 1000 },
    { iceServers: [{ urls: ['stun:127.0.0.1:3478'] }], expiresAt: Date.now() + 120000 }]) {
    const host = new RtcProcessHost('must-not-launch.exe', { callId: randomUUID(), generation: 1 }, 'caller', [], 1000, 'relay', ice);
    try { await assert.rejects(host.start(), /Fresh TURN credentials required/); } finally { host.close(); }
  }
});
test('real native hosts exchange scoped SDP and shut down without devices', { skip: process.env.DARLING_TEST_RTC_NATIVE !== '1', timeout: 30000 }, async () => {
  const executable = resolve('.local/webrtc/src/out/DarlingRelease/darling_rtc_process.exe');
  const scope = { callId: randomUUID(), generation: 1 as const };
  const a = new RtcProcessHost(executable, scope, 'caller');
  const b = new RtcProcessHost(executable, scope, 'callee');
  try {
    const offerReady = once(a, 'signal');
    await Promise.all([a.start(), b.start()]);
    const [offer] = await offerReady;
    const answerReady = once(b, 'signal');
    await b.apply(offer);
    const [answer] = await answerReady;
    await a.apply(answer);
    assert.equal(offer.kind, 'offer'); assert.equal(answer.kind, 'answer');
    await assert.rejects(a.apply({ ...answer, generation: 2 }));
    await assert.rejects(a.apply({ ...answer, callId: randomUUID() }));
    a.close(); await assert.rejects(a.apply(answer), /closed/);
  } finally { a.close(); b.close(); }
});

test('diagnostic coordinator routes native SDP and removes listeners on dispose', { skip: process.env.DARLING_TEST_RTC_NATIVE !== '1', timeout: 30000 }, async () => {
  const callId = randomUUID();
  class FakeSession extends EventEmitter {
    state: Snapshot;
    peer?: FakeSession;
    sent: RtcSignal[] = [];
    ended = 0;
    constructor(user: 'dva' | 'mercy') {
      super();
      this.state = { status: 'online', user, online: [], messages: [], pending: [], detail: '', configPath: '', mediaAvailable: false,
        call: { callId, caller: 'dva', callee: 'mercy', phase: 'connecting', deadline: Date.now() + 20000 } };
    }
    async sendRtcSignal(signal: RtcSignal) { this.sent.push(signal); this.peer!.emit('rtc.signal', signal); }
    callAction() { ++this.ended; return { ok: true }; }
  }
  const a = new FakeSession('dva'), b = new FakeSession('mercy'); a.peer = b; b.peer = a;
  const executable = resolve('.local/webrtc/src/out/DarlingRelease/darling_rtc_process.exe');
  const adapterB = new RtcNegotiation(b as unknown as Session, executable);
  const adapterA = new RtcNegotiation(a as unknown as Session, executable);
  try {
    for (let i = 0; i < 400 && b.sent.length === 0; ++i) await new Promise(r => setTimeout(r, 10));
    assert.equal(a.sent[0]?.kind, 'offer'); assert.equal(b.sent[0]?.kind, 'answer');
    assert.equal(a.ended, 0); assert.equal(b.ended, 0);
    a.emit('rtc.closed', { callId, generation: 1 });
    b.emit('rtc.closed', { callId, generation: 1 });
    a.emit('rtc.signal', b.sent[0]);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(a.sent.length, 1); assert.equal(a.ended, 0);
  } finally { adapterA.dispose(); adapterB.dispose(); }
  for (const session of [a, b]) for (const event of ['state', 'rtc.signal', 'rtc.closed']) assert.equal(session.listenerCount(event), 0);
});

test('native direct ICE/DTLS connects two local dummy-audio peers', { skip: process.env.DARLING_TEST_RTC_DIRECT !== '1', timeout: 30000 }, async () => {
  const executable = resolve('.local/webrtc/src/out/DarlingRelease/darling_rtc_process.exe');
  const scope = { callId: randomUUID(), generation: 1 as const };
  const a = new RtcProcessHost(executable, scope, 'caller', ['--control-data'], 15000, 'direct');
  const b = new RtcProcessHost(executable, scope, 'callee', ['--control-data'], 15000, 'direct');
  let aState = '', bState = '', candidates = 0;
  let aData = '', bData = '';
  let aIce = '', bIce = '';
  const descriptions: string[] = [];
  const candidateKinds: string[] = [];
  a.on('ice-state', value => { aIce = value; }); b.on('ice-state', value => { bIce = value; });
  a.on('data-state', value => { aData = value; }); b.on('data-state', value => { bData = value; });
  const errors: unknown[] = [];
  a.on('connection', value => { aState = value; }); b.on('connection', value => { bState = value; });
  for (const [from, to] of [[a, b], [b, a]]) {
    from.on('fault', error => errors.push(error));
    from.on('signal', (signal: RtcSignal) => {
      if (signal.kind === 'ice') { ++candidates; const parts = signal.candidate.split(' '); candidateKinds.push(`${parts[2]}:${parts[5]}:${parts[7]}`); }
      else descriptions.push(signal.sdp.split(/\r?\n/).filter(line => /^(m=|a=(send|recv|inactive))/.test(line)).join(';'));
      void to.apply(signal).catch(error => errors.push(error));
    });
  }
  try {
    await b.start(); await a.start();
    for (let i = 0; i < 1500 && !errors.length && (aState !== 'connected' || bState !== 'connected'); ++i)
      await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(errors, []);
    assert.ok(candidates > 0);
    let stats = { a: await a.diagnosticStats(), b: await b.diagnosticStats() };
    // Connection notifications and cached stats are not synchronized. Keep the
    // strong nominated/DTLS assertions, but allow the report to catch up.
    const ready = (peer: typeof stats.a) => peer.some(value => value.type === 'candidate-pair' && value.state === 'succeeded' && value.nominated === true)
      && peer.some(value => value.type === 'transport' && value.dtlsState === 'connected');
    for (let retry = 0; retry < 20 && (!ready(stats.a) || !ready(stats.b)); ++retry) {
      await new Promise(r => setTimeout(r, 100));
      stats = { a: await a.diagnosticStats(), b: await b.diagnosticStats() };
    }
    assert.equal(aState, 'connected', JSON.stringify({ aState, bState, aIce, bIce, candidates, candidateKinds, descriptions, stats })); assert.equal(bState, 'connected');
    for (let i = 0; i < 200 && (aData !== 'open' || bData !== 'open'); ++i) await new Promise(r => setTimeout(r, 10));
    assert.equal(aData, 'open'); assert.equal(bData, 'open');
    const received = once(b, 'data');
    await a.sendData('{"type":"release"}');
    assert.equal((await received)[0], '{"type":"release"}');
    assert.ok(candidateKinds.some(value => value.startsWith('udp:')), 'must gather UDP candidates');
    for (const peer of [stats.a, stats.b]) {
      assert.ok(peer.some(value => value.type === 'candidate-pair' && value.state === 'succeeded' && value.nominated === true));
      assert.ok(peer.some(value => value.type === 'transport' && value.dtlsState === 'connected'));
    }
  } finally { a.close(); b.close(); }
});
