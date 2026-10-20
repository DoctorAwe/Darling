// Explicit remote test: logs in once (may replace that account's desktop session).
// Credentials stay in memory. Optional synthetic PCM; no microphone or chat messages.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { ClientConfig, IceConfig, ServerPacket, type RtcSignal } from '../packages/protocol/src/index';
import { RtcProcessHost } from '../apps/desktop/src/rtc-process';

const config = ClientConfig.parse(JSON.parse(readFileSync(process.argv[2], 'utf8')));
const ice = await new Promise<IceConfig>((resolve, reject) => {
  const socket = new WebSocket(config.server.url, { handshakeTimeout: 10000, maxPayload: 65536 });
  const timer = setTimeout(() => { socket.terminate(); reject(new Error('Login timed out')); }, 10000);
  let finished = false;
  const finish = (value?: IceConfig) => {
    if (finished) return; finished = true; clearTimeout(timer); socket.close();
    if (value) resolve(value); else reject(new Error('Could not obtain TURN configuration'));
  };
  socket.on('error', () => finish());
  socket.on('close', () => finish());
  socket.on('open', () => socket.send(JSON.stringify({ version: 1, requestId: randomUUID(), type: 'auth.login', payload: config.auth })));
  socket.on('message', raw => {
    try {
      const packet = ServerPacket.parse(JSON.parse(raw.toString()));
      if (packet.type === 'auth.ok') finish(packet.payload.ice);
      else if (packet.type === 'error') finish();
    } catch { finish(); }
  });
});
const executable = resolve('.local/webrtc/src/out/DarlingRelease/darling_rtc_process.exe');
const synthetic = process.argv.includes('--synthetic-audio');
const args = synthetic ? ['--synthetic-audio'] : [];
for (const transport of ['udp', 'tcp']) {
  const scopedIce: IceConfig = { expiresAt: ice.expiresAt, iceServers: ice.iceServers.map(server => ({ ...server, urls: server.urls.filter(url => url.startsWith('turn:') && url.endsWith(`transport=${transport}`)) })).filter(server => server.urls.length > 0) };
  const scope = { callId: randomUUID(), generation: 1 as const };
  const a = new RtcProcessHost(executable, scope, 'caller', args, 15000, 'relay', scopedIce);
  const b = new RtcProcessHost(executable, scope, 'callee', args, 15000, 'relay', scopedIce);
  let aState = '', bState = '', candidates = 0;
  const errors: string[] = [];
  a.on('connection', state => { aState = state; }); b.on('connection', state => { bState = state; });
  for (const [from, to] of [[a, b], [b, a]]) {
    from.on('fault', () => errors.push('native process failure'));
    from.on('signal', (signal: RtcSignal) => {
      if (signal.kind === 'ice') {
        ++candidates;
        if (!signal.candidate.includes(' typ relay ')) errors.push('non-relay candidate');
      }
      void to.apply(signal).catch(() => errors.push('signal apply failure'));
    });
  }
  try {
    await b.start(); await a.start();
    const deadline = Date.now() + 30000;
    while (!errors.length && Date.now() < deadline && (aState !== 'connected' || bState !== 'connected')) await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(errors, []);
    assert.equal(aState, 'connected', `caller via TURN ${transport}, candidates=${candidates}`);
    assert.equal(bState, 'connected', `callee via TURN ${transport}`);
    if (synthetic) await new Promise(r => setTimeout(r, 5000));
    assert.deepEqual(errors, []);
    for (const host of [a, b]) {
      const stats = await host.diagnosticStats();
      assert.ok(stats.some(s => s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated === true && s.localCandidateType === 'relay' && s.remoteCandidateType === 'relay'));
      assert.ok(stats.some(s => s.type === 'transport' && s.dtlsState === 'connected'));
      if (synthetic) {
        const pcm = stats.find(s => s.type === 'synthetic-audio');
        assert.ok(pcm && pcm.errors === 0 && Number(pcm.matchedBlocks) >= 100, JSON.stringify(stats));
        assert.ok(stats.some(s => s.type === 'inbound-rtp' && s.codec === 'audio/opus' && Number(s.packetsReceived) >= 30));
        assert.ok(stats.some(s => s.type === 'outbound-rtp' && s.codec === 'audio/opus' && Number(s.packetsSent) >= 30));
        console.log(`PASS TURN ${transport}: ${pcm.matchedBlocks} decoded 10ms blocks match remote tone.`);
      }
    }
    console.log(`PASS: forced TURN ${transport}, two native peers connected, nominated relay/relay pair and DTLS connected; synthetic=${synthetic}, no physical devices.`);
  } finally { a.close(); b.close(); }
}
