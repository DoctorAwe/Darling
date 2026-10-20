import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RtcSignaling } from '../apps/desktop/src/rtc-signaling';
import type { CallState, ClientPacket } from '../packages/protocol/src/index';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type RawData } from 'ws';
import { Session } from '../apps/desktop/src/session';

const call = (): CallState => ({ callId: '00000000-0000-4000-8000-000000000001', caller: 'dva', callee: 'mercy', phase: 'connecting', deadline: Date.now() + 30000 });
const offer = (callId = call().callId) => ({ callId, generation: 1, kind: 'offer', sdp: 'v=0\r\n' });

test('RTC relay ACK must match request, call and generation; ACK is not media state', async () => {
  const sent: ClientPacket[] = [];
  const rtc = new RtcSignaling(packet => sent.push(packet));
  rtc.bind(call(), 'dva', true);
  let done = false;
  const pending = rtc.send(offer()).then(() => { done = true; });
  const request = sent[0];
  rtc.acknowledge(request.requestId, 'wrong', 1);
  rtc.acknowledge(request.requestId, call().callId, 2);
  await Promise.resolve(); assert.equal(done, false);
  rtc.acknowledge(request.requestId, call().callId, 1);
  await pending; assert.equal(done, true); rtc.clear();
});

test('RTC rejects offline, ringing, expired, wrong role, generation and oversized descriptions', async () => {
  const rtc = new RtcSignaling(() => assert.fail('must not transmit'));
  await assert.rejects(rtc.send(offer()));
  rtc.bind({ ...call(), phase: 'ringing' }, 'dva', true); await assert.rejects(rtc.send(offer()));
  rtc.bind({ ...call(), deadline: 0 }, 'dva', true); await assert.rejects(rtc.send(offer()));
  rtc.bind(call(), 'mercy', true); await assert.rejects(rtc.send(offer()));
  rtc.bind(call(), 'dva', true);
  await assert.rejects(rtc.send({ ...offer(), generation: 2 }));
  await assert.rejects(rtc.send({ ...offer(), sdp: 'x'.repeat(24001) }));
  rtc.bind(call(), 'dva', false); await assert.rejects(rtc.send(offer()));
});

test('incoming RTC signals only reach internal listeners for current peer and call', () => {
  const rtc = new RtcSignaling(() => {});
  const received: unknown[] = [];
  rtc.on('signal', value => received.push(value));
  rtc.bind(call(), 'mercy', true);
  rtc.receive('dva', offer());
  rtc.receive('mercy', offer());
  rtc.receive('dva', { ...offer(), kind: 'answer' });
  rtc.receive('dva', { ...offer(), generation: 2 });
  rtc.receive('dva', offer('00000000-0000-4000-8000-000000000002'));
  assert.equal(received.length, 1);
  rtc.clear(); rtc.receive('dva', offer()); assert.equal(received.length, 1);
});

test('call switch or disconnect rejects pending signals and emits exactly one close per scope', async () => {
  const rtc = new RtcSignaling(() => {});
  const closed: unknown[] = []; rtc.on('closed', value => closed.push(value));
  rtc.bind(call(), 'dva', true);
  const pending = assert.rejects(rtc.send(offer()), /scope ended/);
  rtc.bind(call(), 'dva', true); assert.equal(closed.length, 0);
  rtc.bind({ ...call(), callId: '00000000-0000-4000-8000-000000000002' }, 'dva', true);
  await pending; assert.equal(closed.length, 1);
  rtc.clear(); rtc.clear(); assert.equal(closed.length, 2);
});

test('RTC errors and timeouts reject, queue is bounded and transport failures clear pending', async () => {
  const sent: ClientPacket[] = [];
  const rtc = new RtcSignaling(packet => sent.push(packet), 20);
  rtc.bind(call(), 'dva', true);
  const pending = assert.rejects(rtc.send(offer()), /server rejected/);
  assert.equal(rtc.reject(sent[0].requestId, 'server rejected'), true); await pending;
  assert.equal(rtc.reject(sent[0].requestId, 'duplicate'), false);
  await assert.rejects(rtc.send(offer()), /timed out/);
  const queue = Array.from({ length: 16 }, () => assert.rejects(rtc.send(offer()), /scope ended/));
  await assert.rejects(rtc.send(offer()), /queue full/);
  rtc.clear(); await Promise.all(queue);
  const broken = new RtcSignaling(() => { throw new Error('closed'); });
  broken.bind(call(), 'dva', true);
  await assert.rejects(broken.send(offer()), /transport unavailable/); broken.clear();
});

test('Session routes RTC over WebSocket internally without changing text state or opening call controls', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const dir = mkdtempSync(join(tmpdir(), 'darling-rtc-session-'));
  const config = join(dir, 'config.json');
  const address = server.address() as { port: number };
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, server: { url: `ws://127.0.0.1:${address.port}` }, auth: { username: 'dva', password: 'test-only' } }));
  const session = new Session(config, dir);
  const connected = once(server, 'connection');
  session.start();
  const [socket] = await connected;
  let observed: unknown;
  socket.on('message', (raw: RawData) => {
    const packet = JSON.parse(raw.toString());
    const reply = (type: string, payload: unknown) => socket.send(JSON.stringify({ version: 1, requestId: packet.requestId, type, payload }));
    if (packet.type === 'auth.login') reply('auth.ok', { user: 'dva' });
    if (packet.type === 'message.sync') reply('message.page', { messages: [], hasMore: false, next: 0 });
    if (packet.type === 'call.sync') reply('call.state', { call: call() });
    if (packet.type === 'rtc.signal') {
      observed = packet.payload;
      reply('rtc.ack', { callId: call().callId, generation: 1 });
    }
  });
  try {
    for (let i = 0; i < 200 && session.state.call?.phase !== 'connecting'; ++i)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(session.state.call?.phase, 'connecting');
    assert.equal(session.callAction('invite').ok, false);
    await session.sendRtcSignal(offer()); assert.deepEqual(observed, offer());
    const received = once(session, 'rtc.signal');
    const answer = { ...offer(), kind: 'answer' };
    socket.send(JSON.stringify({ version: 1, type: 'rtc.signal', payload: { sender: 'mercy', signal: answer } }));
    assert.deepEqual((await received)[0], answer);
    assert.equal(JSON.stringify(session.state).includes('v=0'), false);
    assert.equal(session.state.mediaAvailable, false);
    const closed = once(session, 'rtc.closed');
    socket.send(JSON.stringify({ version: 1, type: 'call.state', payload: { call: { ...call(), phase: 'ended' } } }));
    assert.equal((await closed)[0].callId, call().callId);
    await assert.rejects(session.sendRtcSignal(offer()), /stale/);
  } finally {
    session.stop(); socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
