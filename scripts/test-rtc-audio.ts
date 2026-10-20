// Explicit two-process test. Generated tones only; no microphone or speaker.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { RtcProcessHost } from '../apps/desktop/src/rtc-process';
import type { RtcSignal } from '../packages/protocol/src/index';

const executable = resolve('.local/webrtc/src/out/DarlingRelease/darling_rtc_process.exe');
const scope = { callId: randomUUID(), generation: 1 as const };
const a = new RtcProcessHost(executable, scope, 'caller', ['--synthetic-audio'], 15000, 'direct');
const b = new RtcProcessHost(executable, scope, 'callee', ['--synthetic-audio'], 15000, 'direct');
const errors: string[] = [];
for (const [from, to] of [[a, b], [b, a]]) {
  from.on('fault', () => errors.push('native process failure'));
  from.on('signal', (signal: RtcSignal) => { void to.apply(signal).catch(() => errors.push('signal apply failure')); });
}
try {
  await b.start(); await a.start();
  await new Promise(r => setTimeout(r, 5000));
  assert.deepEqual(errors, []);
  for (const [role, host] of [['caller', a], ['callee', b]] as const) {
    const stats = await host.diagnosticStats();
    const pcm = stats.find(s => s.type === 'synthetic-audio');
    assert.ok(pcm, `${role}: missing PCM diagnostics`);
    assert.equal(pcm.errors, 0);
    assert.ok(Number(pcm.decodedRms) > 0.01 && Number(pcm.decodedRms) < 0.3, JSON.stringify(pcm));
    assert.ok(Number(pcm.decodedPeak) > 0.02 && Number(pcm.decodedPeak) <= 1, JSON.stringify(pcm));
    assert.ok(Number(pcm.maximumPeak) >= Number(pcm.decodedPeak) && Number(pcm.maximumPeak) <= 1, JSON.stringify(pcm));
    assert.ok(Number(pcm.sentBlocks) >= 100, JSON.stringify(pcm));
    assert.ok(Number(pcm.matchedBlocks) >= 100, `${role}: remote frequency not decoded: ${JSON.stringify(stats)}`);
    assert.ok(stats.some(s => s.type === 'outbound-rtp' && s.codec === 'audio/opus' && Number(s.packetsSent) >= 30), JSON.stringify(stats));
    assert.ok(stats.some(s => s.type === 'inbound-rtp' && s.codec === 'audio/opus' && Number(s.packetsReceived) >= 30), JSON.stringify(stats));
    assert.ok(stats.some(s => s.type === 'transport' && s.dtlsState === 'connected'));
    console.log(`PASS ${role}: Opus RTP sent/received; ${pcm.matchedBlocks} decoded 10ms blocks match remote tone; no physical devices.`);
  }
  const stopped = await Promise.all([a.stop(), b.stop()]);
  assert.deepEqual(stopped, ['graceful', 'graceful']);
  console.log('PASS: both active synthetic audio peers stop gracefully through EOF.');
} finally { a.close(); b.close(); }
