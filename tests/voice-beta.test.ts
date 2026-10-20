import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../apps/server/src/app';
import { Session } from '../apps/desktop/src/session';
import { RtcNegotiation } from '../apps/desktop/src/rtc-negotiation';
import { RtcProcessHost } from '../apps/desktop/src/rtc-process';
async function until(check: () => boolean) {
  for (let i = 0; i < 500; ++i) { if (check()) return; await new Promise(r => setTimeout(r, 20)); }
  assert.ok(check(), 'state transition timed out');
}
test('beta calls use real business signaling and native synthetic media, reach active and hang up', { skip: process.env.DARLING_TEST_RTC_NATIVE !== '1', timeout: 25000 }, async () => {
  const app = await createServer({ database: ':memory:', users: { dva: 'test-dva', mercy: 'test-mercy' } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const folder = mkdtempSync(join(tmpdir(), 'darling-voice-'));
  const sessions = (['dva', 'mercy'] as const).map(user => {
    const path = join(folder, `${user}.json`);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, server: { url: `ws://127.0.0.1:${port}/ws` }, auth: { username: user, password: `test-${user}` } }));
    return new Session(path, join(folder, user));
  });
  const hosts: RtcProcessHost[] = [];
  const adapters = sessions.map(session => new RtcNegotiation(session, resolve('.local/webrtc/src/out/DarlingRelease/darling_rtc_process.exe'), 'direct',
    () => ({ confirmed: true, inputDeviceId: 'not-used', outputDeviceId: 'not-used', outputProfile: 'headphones', noiseSuppression: false }),
    (exe, scope, role) => { const host = new RtcProcessHost(exe, scope, role, ['--synthetic-audio'], 10000, 'direct'); hosts.push(host); return host; }));
  try {
    sessions.forEach(s => { s.configureVoice(true, true); s.start(); });
    await until(() => sessions.every(s => s.state.status === 'online' && !s.state.callPending));
    assert.equal(sessions[0].callAction('invite').ok, true);
    await until(() => sessions[1].state.call?.phase === 'ringing');
    assert.equal(hosts.length, 0, 'ringing does not open devices');
    assert.equal(sessions[1].callAction('accept', sessions[1].state.call!.callId).ok, true);
    await until(() => sessions.every(s => s.state.call?.phase === 'active'));
    await new Promise(r => setTimeout(r, 1500));
    for (const host of hosts) {
      const stats = await host.diagnosticStats();
      assert.ok(stats.some(s => s.type === 'inbound-rtp' && Number(s.packetsReceived) > 10));
      assert.ok(stats.some(s => s.type === 'inbound-rtp' && typeof s.audioLevel === 'number' && s.audioLevel > 0), 'native decoded receive audio level is available');
    }
    assert.equal(sessions[0].callAction('end', sessions[0].state.call!.callId).ok, true);
    await until(() => sessions.every(s => s.state.call?.phase === 'ended'));
  } finally { await Promise.all(adapters.map(a => a.dispose())); sessions.forEach(s => s.stop()); await app.close(); }
});
