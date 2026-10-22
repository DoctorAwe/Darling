import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteDesktops } from '../apps/server/src/remote-desktops';
import { RemoteSessionState, RemoteSignal } from '../packages/protocol/src/index';

test('remote desktop requires controlled-side consent and keeps permissions revocable', () => {
  const events: RemoteSessionState[] = [];
  const remote = new RemoteDesktops(value => events.push(RemoteSessionState.parse(value)));
  try {
    assert.throws(() => remote.invite('dva', false), /PEER_OFFLINE/);
    const session = remote.invite('dva', true);
    assert.equal(session.controller, 'dva'); assert.equal(session.controlled, 'mercy');
    assert.deepEqual(session.permissions, { control: false, audio: false });
    assert.throws(() => remote.accept('dva', session.sessionId, { control: true, audio: true }), /NOT_CONTROLLED/);
    assert.deepEqual(remote.accept('mercy', session.sessionId, { control: false, audio: true }).permissions, { control: false, audio: true });
    assert.deepEqual(remote.permissions('mercy', session.sessionId, { control: true, audio: false }).permissions, { control: true, audio: false });
    assert.throws(() => remote.permissions('dva', session.sessionId, { control: false, audio: false }), /NOT_CONTROLLED/);
    assert.equal(remote.end('mercy', session.sessionId).reason, 'hangup');
    assert.equal(remote.snapshot(), null); assert.equal(events.at(-1)?.phase, 'ended');
  } finally { remote.disconnect('server-shutdown'); }
});

test('remote signaling enforces roles, order, candidate bounds and dual readiness', () => {
  const remote = new RemoteDesktops(() => {}); const session = remote.invite('dva', true);
  remote.accept('mercy', session.sessionId, { control: true, audio: true });
  const offer = RemoteSignal.parse({ sessionId: session.sessionId, generation: 1, kind: 'offer', sdp: 'v=0' });
  const answer = RemoteSignal.parse({ sessionId: session.sessionId, generation: 1, kind: 'answer', sdp: 'v=0' });
  const ice = RemoteSignal.parse({ sessionId: session.sessionId, generation: 1, kind: 'ice', candidate: '', sdpMid: '0', sdpMLineIndex: 0 });
  assert.throws(() => remote.signal('mercy', offer), /UNEXPECTED_OFFER/);
  remote.signal('dva', offer); assert.throws(() => remote.signal('mercy', ice), /DESCRIPTION_REQUIRED/);
  remote.signal('mercy', answer); remote.signal('dva', ice); remote.signal('mercy', ice);
  assert.equal(remote.readyUser('dva', session.sessionId).phase, 'connecting');
  const active = remote.readyUser('mercy', session.sessionId);
  assert.equal(active.phase, 'active'); assert.equal(active.deadline, 0); assert.ok(active.startedAt);
  remote.end('dva', session.sessionId);
});

test('ringing and connecting remote sessions time out without granting access', async () => {
  const remote = new RemoteDesktops(() => {}, 20);
  remote.invite('dva', true); await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(remote.snapshot(), null);
  const next = remote.invite('mercy', true); remote.accept('dva', next.sessionId, { control: true, audio: true });
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(remote.snapshot(), null);
});
