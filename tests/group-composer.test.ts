import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultGroupDraft, insertEchoMention, isBareEchoMention, mentionQuery, uploadGroupAttachments } from '../apps/desktop/src/group-composer';

test('group composer defaults to Echo and supports mention completion', () => {
  assert.equal(defaultGroupDraft, '@Echo ');
  assert.equal(isBareEchoMention('@echo  '), true);
  assert.deepEqual(mentionQuery('请问 @ec'), { start: 3, end: 6 });
  assert.equal(insertEchoMention('请问 @ec'), '请问 @Echo ');
  assert.equal(mentionQuery('@other'), undefined);
});

test('group attachments finish before the caller can send the Echo question', async () => {
  const events: string[] = []; const items = [{ token: 'image' }, { token: 'document' }];
  const result = await uploadGroupAttachments(items, async token => { events.push(`start:${token}`); await Promise.resolve(); events.push(`done:${token}`); return { ok: true }; });
  events.push('question');
  assert.deepEqual(events, ['start:image', 'done:image', 'start:document', 'done:document', 'question']);
  assert.deepEqual(result.failed, []);
});

test('a failed group attachment blocks the question and remains retryable', async () => {
  const item = { token: 'image' }; const result = await uploadGroupAttachments([item], async () => ({ ok: false, error: 'upload failed' }));
  assert.deepEqual(result.failed, [item]); assert.equal(result.error, 'upload failed');
});
