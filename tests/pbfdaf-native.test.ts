import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const exe = resolve('.local/webrtc/src/out/DarlingRelease/darling_rtc_process.exe');
const skip = process.env.DARLING_TEST_RTC_NATIVE !== '1';
// Hello/shutdown only: WASAPI mode must not enumerate/open/start any device here.
test('PBFDAF mode selection preserves no-device startup and enables all WASAPI profiles', { skip }, () => {
  for (const [args, enabled] of [
    [[], false],
    [['--wasapi-audio'], true],
    [['--wasapi-audio', '--no-aec'], false],
    [['--synthetic-audio'], false],
    [['--synthetic-audio', '--aec', '--rnnoise'], true],
  ] as const) {
    const input = ['engine.hello', 'engine.shutdown'].map((type, i) =>
      JSON.stringify({ protocolVersion: 1, requestId: `${i}`, type, payload: {} })).join('\n') + '\n';
    const result = spawnSync(exe, [...args], { input, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const hello = JSON.parse(result.stdout.split('\n')[0]);
    assert.equal(hello.type, 'engine.ready');
    assert.equal(hello.payload.aec, enabled);
    assert.equal(hello.payload.capture, false);
    assert.equal(hello.payload.playback, false);
  }
});
test('PBFDAF rejects conflicting and duplicate CLI modes', { skip }, () => {
  for (const args of [
    ['--synthetic-audio', '--wasapi-audio'],
    ['--synthetic-audio', '--aec', '--no-aec'],
    ['--aec'], ['--rnnoise'], ['--wasapi-audio', '--wasapi-audio'],
  ]) {
    const result = spawnSync(exe, args, { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 6);
  }
});
