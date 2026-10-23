import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteWindowPolicy } from '../apps/desktop/src/remote-window-policy';
import type { RemoteSessionState } from '../packages/protocol/src/index';

const session = (phase: RemoteSessionState['phase']): RemoteSessionState => ({
  sessionId: '00000000-0000-4000-8000-000000000001', controller: 'dva', controlled: 'mercy', phase,
  deadline: Date.now() + 1000, permissions: { control: true, audio: true }, ...(phase === 'ended' ? { reason: 'hangup' as const } : {}),
});

test('ended remote desktop may retain its existing result window but never recreates it', () => {
  assert.deepEqual(remoteWindowPolicy(session('ended'), 'dva', false), { createController: false, keepController: false, controlled: false });
  assert.deepEqual(remoteWindowPolicy(session('ended'), 'dva', true), { createController: false, keepController: true, controlled: false });
  assert.deepEqual(remoteWindowPolicy(session('connecting'), 'dva', false), { createController: true, keepController: true, controlled: false });
  assert.deepEqual(remoteWindowPolicy(session('active'), 'mercy', false), { createController: false, keepController: false, controlled: true });
});
