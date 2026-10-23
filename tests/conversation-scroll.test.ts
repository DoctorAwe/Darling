import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationScrollMemory } from '../apps/desktop/src/conversation-scroll';

test('conversation scroll memory keeps independent positions', () => {
  const memory = new ConversationScrollMemory<'direct' | 'group'>();
  memory.save('direct', { scrollTop: 240, scrollHeight: 1200, clientHeight: 400 });
  memory.save('group', { scrollTop: 90, scrollHeight: 900, clientHeight: 400 });
  assert.equal(memory.target('direct', { scrollTop: 0, scrollHeight: 1200, clientHeight: 400 }), 240);
  assert.equal(memory.target('group', { scrollTop: 0, scrollHeight: 900, clientHeight: 400 }), 90);
});

test('unseen and bottom-pinned conversations restore to their current bottom', () => {
  const memory = new ConversationScrollMemory<'direct' | 'group'>();
  assert.equal(memory.target('direct', { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }), 600);
  memory.save('group', { scrollTop: 598, scrollHeight: 1000, clientHeight: 400 });
  assert.equal(memory.followsBottom('group'), true);
  assert.equal(memory.target('group', { scrollTop: 0, scrollHeight: 1400, clientHeight: 400 }), 1000);
});

test('reading position is clamped safely when content becomes shorter', () => {
  const memory = new ConversationScrollMemory<'direct'>();
  memory.save('direct', { scrollTop: 700, scrollHeight: 1200, clientHeight: 400 });
  assert.equal(memory.followsBottom('direct'), false);
  assert.equal(memory.target('direct', { scrollTop: 0, scrollHeight: 650, clientHeight: 400 }), 250);
});
