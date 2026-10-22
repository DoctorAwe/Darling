import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteInputGate } from '../apps/desktop/src/remote-input';
import { RemoteInputEvent } from '../packages/protocol/src/index';

test('remote input accepts only bounded pointer and allowlisted keyboard events', () => {
  assert.deepEqual(RemoteInputEvent.parse({ type: 'pointer.move', x: .5, y: 1 }), { type: 'pointer.move', x: .5, y: 1 });
  assert.equal(RemoteInputEvent.safeParse({ type: 'pointer.move', x: -1, y: 0 }).success, false);
  assert.equal(RemoteInputEvent.safeParse({ type: 'key', code: 'KeyA', down: true }).success, true);
  assert.equal(RemoteInputEvent.safeParse({ type: 'key', code: 'AudioVolumeUp', down: true }).success, false);
  assert.equal(RemoteInputEvent.safeParse({ type: 'pointer.wheel', deltaX: 0, deltaY: 1201 }).success, false);
});

test('remote input gate rate limits every event class', () => {
  const gate = new RemoteInputGate(2);
  gate.parse({ type: 'release' }, 1000); gate.parse({ type: 'release' }, 1000);
  assert.throws(() => gate.parse({ type: 'release' }, 1000), /频率过高/);
  assert.doesNotThrow(() => gate.parse({ type: 'release' }, 2000));
});
