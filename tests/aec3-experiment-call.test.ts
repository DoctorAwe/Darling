import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { RtcProcessHost } from '../apps/desktop/src/rtc-process';

const skip = process.env.DARLING_TEST_AEC3_CALL !== '1';
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
for (const noise of [false, true]) test(`official AEC3 synthetic call, RNNoise=${noise}`, { skip, timeout: 30000 }, async () => {
  const scope = { callId: randomUUID(), generation: 1 as const };
  const hosts = (['caller', 'callee'] as const).map(role => new RtcProcessHost(
    resolve('.local/aec3-experiment/native/darling_rtc_aec3_experimental.exe'), scope, role,
    ['--synthetic-audio', '--aec3-experimental', ...(noise ? ['--rnnoise'] : [])], 10000, 'direct'));
  const connected = new Set<number>();
  const faults: string[] = [];
  hosts.forEach((host, i) => {
    host.on('signal', value => void hosts[1-i].apply(value).catch(error => faults.push(String(error))));
    host.on('connection', value => { if (value === 'connected') connected.add(i); });
    host.on('fault', value => faults.push(String(value)));
  });
  const level = async (i: number, silent: boolean) => {
    for (let attempt = 0; attempt < 60; ++attempt) {
      assert.deepEqual(faults, []);
      const stats = await hosts[i].diagnosticStats();
      const rms = Number(stats.find(s => s.type === 'synthetic-audio')?.decodedRms);
      if (Number.isFinite(rms) && (silent ? rms < .0001 : rms > .001)) return;
      await delay(100);
    }
    assert.fail(`peer ${i} did not become ${silent ? 'silent' : 'audible'}`);
  };
  try {
    await hosts[1].start(); await hosts[0].start();
    for (let i=0;i<100 && connected.size<2;++i) { assert.deepEqual(faults, []); await delay(100); }
    assert.equal(connected.size, 2);
    await delay(2000);
    for (const host of hosts) {
      const stats = await host.diagnosticStats();
      const aec = stats.find(s => s.type === 'aec');
      assert.equal(aec?.algorithm, 'webrtc-aec3');
      assert.equal(aec?.enabled, true); assert.equal(aec?.webrtcNs, false);
      assert.equal(aec?.agc1, false); assert.equal(aec?.agc2, false); assert.equal(aec?.highpass, false);
      assert.ok(Number(aec?.postFrames) > 100); assert.equal(aec?.outputProtection, 0);
      const ns = stats.find(s => s.type === 'noise-suppression');
      if (noise) assert.ok(Number(ns?.frames) > 100); else assert.equal(ns, undefined);
      assert.ok(stats.some(s => s.type === 'inbound-rtp' && Number(s.packetsReceived) > 20));
      console.log(JSON.stringify({ noise, aec, ns }));
    }
    // SyntheticAudio emits steady tones, not speech. RNNoise may legitimately
    // reject them; do not use tone survival as a denoised speech quality gate.
    if (!noise) {
    await level(0, false); await level(1, false);
    await hosts[0].setAudio(true, false); await level(1, true); await level(0, false);
    await hosts[0].setAudio(false, false); await level(1, false);
    await hosts[0].setAudio(false, true); await level(0, true); await level(1, false);
    await hosts[0].setAudio(false, false); await level(0, false);
    }
    assert.deepEqual(faults, []);
  } finally { await Promise.all(hosts.map(host => host.stop())); }
});
