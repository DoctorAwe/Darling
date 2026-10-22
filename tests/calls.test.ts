import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Calls } from '../apps/server/src/calls';
import { CallState, RtcSignal } from '../packages/protocol/src/index';

test('active call survives beyond 30 minutes without an expiration timer', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = new Calls(() => {});
  const call = calls.invite('dva', true);
  calls.accept('mercy', call.callId);
  calls.signal('dva', { callId: call.callId, generation: 1, kind: 'offer', sdp: 'v=0' });
  calls.signal('mercy', { callId: call.callId, generation: 1, kind: 'answer', sdp: 'v=0' });
  calls.ready('dva', call.callId); calls.ready('mercy', call.callId);
  t.mock.timers.tick(4 * 60 * 60 * 1000);
  assert.equal(calls.snapshot()?.phase, 'active');
  assert.equal(calls.snapshot()?.deadline, 0);
  calls.end('dva', call.callId);
});

test('active requires both media-ready reports and survives the negotiation deadline', async () => {
  const calls = new Calls(() => {}, 30);
  try {
    const call = calls.invite('dva', true); calls.accept('mercy', call.callId);
    assert.throws(() => calls.ready('dva', call.callId), /NOT_NEGOTIATED/);
    calls.signal('dva', { callId: call.callId, generation: 1, kind: 'offer', sdp: 'v=0' });
    calls.signal('mercy', { callId: call.callId, generation: 1, kind: 'answer', sdp: 'v=0' });
    assert.equal(calls.ready('dva', call.callId).phase, 'connecting');
    assert.equal(calls.ready('dva', call.callId).phase, 'connecting');
    assert.equal(calls.ready('mercy', call.callId).phase, 'active');
    assert.equal(calls.snapshot()?.deadline, 0, 'active calls have no duration deadline');
    await new Promise(r => setTimeout(r, 60)); assert.equal(calls.snapshot()?.phase, 'active');
    assert.equal(calls.accept('mercy', call.callId).phase, 'active');
    assert.throws(() => calls.ready('mercy', 'stale'), /STALE_CALL/);
    calls.end('dva', call.callId); assert.equal(calls.snapshot(), null);
  } finally { calls.disconnect('server-shutdown'); }
});

test('RTC relay binds role, call, generation, order and bounded ICE to accepted calls', () => {
  const calls = new Calls(() => {});
  try {
    const call = calls.invite('dva', true);
    const offer = { callId: call.callId, generation: 1, kind: 'offer', sdp: 'v=0\r\n' } as const;
    const answer = { ...offer, kind: 'answer' } as const;
    const ice = { callId: call.callId, generation: 1, kind: 'ice', candidate: '', sdpMid: '0', sdpMLineIndex: 0 } as const;
    assert.throws(() => calls.signal('dva', offer), /CALL_NOT_ACCEPTED/);
    calls.accept('mercy', call.callId);
    assert.throws(() => calls.signal('mercy', offer), /UNEXPECTED_OFFER/);
    assert.throws(() => calls.signal('mercy', answer), /UNEXPECTED_ANSWER/);
    assert.throws(() => calls.signal('dva', ice), /DESCRIPTION_REQUIRED/);
    calls.signal('dva', offer);
    assert.throws(() => calls.signal('dva', offer), /UNEXPECTED_OFFER/);
    assert.throws(() => calls.signal('dva', answer), /UNEXPECTED_ANSWER/);
    calls.signal('mercy', answer);
    for (let i=0; i<128; ++i) calls.signal('dva', ice);
    assert.throws(() => calls.signal('dva', ice), /ICE_LIMIT/);
    calls.signal('mercy', ice);
    assert.equal(RtcSignal.safeParse({ ...offer, generation: 2 }).success, false);
    assert.equal(RtcSignal.safeParse({ ...offer, sdp: 'x'.repeat(24001) }).success, false);
    assert.equal(RtcSignal.safeParse({ ...ice, candidate: 'x'.repeat(2049) }).success, false);
    calls.end('dva', call.callId);
    const next = calls.invite('mercy', true); calls.accept('dva', next.callId);
    assert.throws(() => calls.signal('dva', ice), /STALE_CALL/);
    calls.signal('mercy', { ...offer, callId: next.callId });
  } finally { calls.disconnect('server-shutdown'); }
});

test('crossed invites converge, only callee accepts, stale IDs cannot end new calls', () => {
  const events: CallState[] = [];
  const calls = new Calls(call => events.push(CallState.parse(call)));
  try {
    assert.throws(() => calls.invite('dva', false), /PEER_OFFLINE/);
    const first = calls.invite('dva', true);
    assert.equal(calls.invite('mercy', true).callId, first.callId);
    assert.equal(events.length, 1);
    assert.throws(() => calls.accept('dva', first.callId), /NOT_CALLEE/);
    assert.equal(calls.accept('mercy', first.callId).phase, 'connecting');
    calls.accept('mercy', first.callId); assert.equal(events.length, 2);
    assert.equal(calls.end('dva', first.callId).reason, 'hangup');
    const next = calls.invite('mercy', true);
    assert.throws(() => calls.end('dva', first.callId), /STALE_CALL/);
    assert.equal(calls.snapshot()?.callId, next.callId);
    assert.equal(calls.end('dva', next.callId).reason, 'rejected');
    const third = calls.invite('dva', true);
    assert.equal(calls.end('dva', third.callId).reason, 'cancelled');
  } finally { calls.disconnect('server-shutdown'); }
});

test('ringing and connecting time out and release the room', async () => {
  const events: CallState[] = [];
  const calls = new Calls(call => events.push(call), 20);
  try {
    calls.invite('dva', true);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(calls.snapshot(), null); assert.equal(events.at(-1)?.reason, 'timeout');
    const next = calls.invite('mercy', true); calls.accept('dva', next.callId);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(calls.snapshot(), null); assert.equal(events.at(-1)?.reason, 'timeout');
  } finally { calls.disconnect('server-shutdown'); }
});
