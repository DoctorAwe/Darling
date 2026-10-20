import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CallPanel, formatCallDuration } from '../apps/desktop/src/CallPanel';
import type { Snapshot } from '../packages/protocol/src/index';

test('call panel distinguishes ringing, connecting and ended without claiming connected audio', () => {
  const state: Snapshot = { status: 'online', user: 'dva', online: ['dva','mercy'], messages: [], pending: [], detail: '', configPath: '', mediaAvailable: false,
    call: { callId: '00000000-0000-4000-8000-000000000001', caller: 'mercy', callee: 'dva', phase: 'ringing', deadline: 1 } };
  const render = () => renderToStaticMarkup(createElement(CallPanel, { state, end: () => {}, accept: () => {} }));
  assert.match(render(), /收到语音邀请/); assert.match(render(), /disabled/); assert.match(render(), /拒绝/);
  state.call!.phase = 'connecting'; assert.match(render(), /正在连接音频/);
  state.call!.phase = 'active';
  state.remoteAudio = { level: .1, sampledAt: Date.now() };
  assert.match(render(), /通话时长/); assert.match(render(), /对方声音/);
  state.remoteAudio = { level: 0, sampledAt: Date.now() };
  assert.match(render(), /对方安静/);
  state.remoteAudio = { level: .1, sampledAt: Date.now() - 3000 };
  assert.match(render(), /等待音频电平/);
  state.call!.phase = 'ended'; state.call!.reason = 'timeout';
  assert.match(render(), /等待超时/); assert.doesNotMatch(render(), /<button/);
  state.call = null; assert.equal(render(), '');
});
test('call duration formats elapsed time without negative values', () => {
  assert.equal(formatCallDuration(0), '00:00');
  assert.equal(formatCallDuration(65000), '01:05');
  assert.equal(formatCallDuration(-1000), '00:00');
  assert.equal(formatCallDuration(1800000), '30:00');
});
