import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RtcProcessHost } from '../apps/desktop/src/rtc-process';
import { resolveAec3Enabled } from '../apps/desktop/src/aec-mode';

// CLI and hello/shutdown only. No rtc.open, PCM, devices, network calls or quality experiment.
const exe = resolve('.local/aec3-experiment/native/darling_rtc_aec3_experimental.exe');
const skip = process.env.DARLING_CHECK_AEC3_ENTRY !== '1';
test('mainline voice mode defaults to AEC3 and retains an explicit PBFDAF fallback', () => {
  assert.equal(resolveAec3Enabled(true), true);
  assert.equal(resolveAec3Enabled(true, 'webrtc-aec3'), true);
  assert.equal(resolveAec3Enabled(true, 'pbfdaf'), false);
  assert.equal(resolveAec3Enabled(false), false);
  assert.throws(() => resolveAec3Enabled(false, 'webrtc-aec3'));
  assert.throws(() => resolveAec3Enabled(true, 'unknown'));
});
test('AEC3 explicit selection reports its algorithm without opening devices', { skip }, () => {
  for (const mode of ['--wasapi-audio', '--synthetic-audio']) {
    const input = ['engine.hello', 'engine.shutdown'].map(type => JSON.stringify({
      protocolVersion: 1, requestId: randomUUID(), type, payload: {},
    })).join('\n') + '\n';
    const result = spawnSync(exe, [mode, '--aec3-experimental'], { input, encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const hello = JSON.parse(result.stdout.split('\n')[0]);
    assert.equal(hello.payload.aecAlgorithm, 'webrtc-aec3');
    assert.equal(hello.payload.aec, true);
    assert.equal(hello.payload.capture, false);
    assert.equal(hello.payload.playback, false);
  }
});
test('AEC3 cannot stack with PBFDAF, disable flags, or duplicate mode flags', { skip }, () => {
  for (const args of [
    ['--aec3-experimental'],
    ['--synthetic-audio', '--aec3-experimental', '--aec'],
    ['--wasapi-audio', '--aec3-experimental', '--no-aec'],
    ['--synthetic-audio', '--aec3-experimental', '--aec3-experimental'],
  ]) assert.equal(spawnSync(exe, args, { timeout: 10000, windowsHide: true }).status, 6);
});
test('experimental desktop refuses a legacy handshake instead of silently falling back', async () => {
  const host = new RtcProcessHost(process.execPath, { callId: randomUUID(), generation: 1 }, 'callee',
    [resolve('tests/fixtures/rtc-child.mjs'), '--aec3-experimental']);
  host.on('fault', () => {});
  try { await assert.rejects(host.start(), /Experimental AEC3 engine required/); }
  finally { await host.stop(); }
});
