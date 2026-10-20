// Explicit operator-run integration check: replaces both logins, uses synthetic audio only.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Session } from '../apps/desktop/src/session';
import { RtcNegotiation } from '../apps/desktop/src/rtc-negotiation';
import { RtcProcessHost } from '../apps/desktop/src/rtc-process';
const folder = mkdtempSync(join(tmpdir(), 'darling-remote-beta-'));
const sessions = ['dva', 'mercy'].map(user => new Session(resolve(`.local/${user}.config.json`), join(folder, user)));
const hosts: RtcProcessHost[] = [];
const adapters = sessions.map(session => new RtcNegotiation(session, resolve('.local/webrtc/src/out/DarlingRelease/darling_rtc_process.exe'), 'relay',
  () => ({ confirmed: true, inputDeviceId: 'unused', outputDeviceId: 'unused', outputProfile: 'headphones', noiseSuppression: false }),
  (exe, scope, role, _args, timeout, mode, ice) => { const host = new RtcProcessHost(exe, scope, role, ['--synthetic-audio'], timeout, mode, ice); hosts.push(host); return host; }));
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 100)); }
  assert.ok(check(), 'Remote state transition timed out');
}
try {
  sessions.forEach(s => { s.configureVoice(true, true); s.start(); });
  await until(() => sessions.every(s => s.state.status === 'online' && !s.state.callPending));
  await Promise.all(sessions.map(s => s.refreshIce()));
  assert.ok(sessions[0].callAction('invite').ok);
  await until(() => sessions[1].state.call?.phase === 'ringing');
  assert.equal(hosts.length, 0);
  assert.ok(sessions[1].callAction('accept', sessions[1].state.call!.callId).ok);
  await until(() => sessions.every(s => s.state.call?.phase === 'active'));
  console.log('Both peers active through public TURN; checking sustained media for 35 seconds.');
  await new Promise(r => setTimeout(r, 35000));
  assert.ok(sessions.every(s => s.state.call?.phase === 'active'));
  for (const host of hosts) {
    const stats = await host.diagnosticStats();
    assert.ok(stats.some(s => s.type === 'inbound-rtp' && Number(s.packetsReceived) > 100));
    console.log(JSON.stringify(stats.filter(s => ['inbound-rtp', 'candidate-pair', 'local-candidate', 'remote-candidate', 'synthetic-audio'].includes(String(s.type)))));
  }
  assert.ok(sessions[0].callAction('end', sessions[0].state.call!.callId).ok);
  await until(() => sessions.every(s => s.state.call?.phase === 'ended'));
  console.log('PASS: public server invite/accept/active, sustained bidirectional synthetic RTP, hangup. No microphone or speakers opened.');
} finally { await Promise.all(adapters.map(a => a.dispose())); sessions.forEach(s => s.stop()); }
