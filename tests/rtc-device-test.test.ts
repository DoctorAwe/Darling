import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RtcDeviceTest } from '../apps/desktop/src/rtc-device-test';
const audio = { confirmed: true, inputDeviceId: 'input', outputDeviceId: 'output', outputProfile: 'headphones', noiseSuppression: false };
class Fake extends EventEmitter {
  starts = 0; stops = 0; release?: () => void;
  async start() { ++this.starts; }
  async apply() {}
  async diagnosticStats(): Promise<Record<string, string | number | boolean>[]> { return []; }
  async stop() { ++this.stops; return 'graceful' as const; }
}
function setup() {
  const hosts: Fake[] = [];
  const control = new RtcDeviceTest('fake', () => { const host = new Fake(); hosts.push(host); return host; });
  return { control, hosts };
}
test('device controller refuses unavailable or unconfirmed starts without creating hosts', async () => {
  await assert.rejects(new RtcDeviceTest().start(audio));
  const { control, hosts } = setup();
  await assert.rejects(control.start({ ...audio, confirmed: false })); assert.equal(hosts.length, 0);
});
test('device controller prevents overlap, stops both peers and ignores late state', async () => {
  const { control, hosts } = setup();
  await control.start(audio); await assert.rejects(control.start(audio));
  hosts[0].emit('connection', 'connected'); assert.equal(control.state.status, 'running');
  await control.stop(); assert.equal(control.active, false);
  assert.deepEqual(hosts.map(h => h.stops), [1, 1]);
  hosts[0].emit('connection', 'connected'); assert.equal(control.state.status, 'idle');
});
test('device controller faults close both peers and permit a fresh attempt', async () => {
  const { control, hosts } = setup(); await control.start(audio);
  hosts[1].emit('fault', 'failure'); await control.stop();
  assert.match(control.state.detail, /异常/); assert.deepEqual(hosts.map(h => h.stops), [1, 1]);
  await control.start(audio); await control.stop(); assert.equal(hosts.length, 4);
});
test('device controller automatically stops at the 15 second deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { control, hosts } = setup(); await control.start(audio);
  t.mock.timers.tick(15000); await control.stop();
  assert.match(control.state.detail, /15 秒/); assert.deepEqual(hosts.map(h => h.stops), [1, 1]);
});
test('cancelling during synthetic startup never starts the physical peer', async () => {
  const hosts: Fake[] = []; let release!: () => void;
  const control = new RtcDeviceTest('fake', () => {
    const host = new Fake(); hosts.push(host);
    if (hosts.length === 2) host.start = () => new Promise<void>(resolve => { release = resolve; });
    return host;
  });
  const starting = control.start(audio);
  await control.stop(); release(); await starting;
  assert.equal(hosts[0].starts, 0); assert.equal(control.active, false);
});
test('statistics survive connection updates and stop, but clear on the next test', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { control, hosts } = setup(); await control.start(audio);
  hosts[0].diagnosticStats = async () => [{ type: 'outbound-rtp', codec: 'audio/opus', packetsSent: 10 }];
  hosts[1].diagnosticStats = async (): Promise<Record<string, string | number | boolean>[]> => [{ type: 'inbound-rtp', codec: 'audio/opus', packetsReceived: 9 }, { type: 'synthetic-audio', decodedRms: 0.1 }];
  t.mock.timers.tick(1000);
  for (let i = 0; i < 8; ++i) await Promise.resolve();
  assert.equal(control.state.inputMetrics?.sentPackets, 10);
  hosts[0].emit('connection', 'connected');
  assert.equal(control.state.inputMetrics?.receivedPackets, 9);
  await control.stop(); assert.equal(control.state.inputMetrics?.decodedRms, 0.1);
  await control.start(audio); assert.equal(control.state.inputMetrics, undefined); await control.stop();
});
test('in-flight stats are serialized and cannot overwrite a stopped test', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { control, hosts } = setup(); await control.start(audio);
  let release!: (value: Record<string, string | number | boolean>[]) => void; let calls = 0;
  hosts[0].diagnosticStats = () => { ++calls; return new Promise(resolve => { release = resolve; }); };
  t.mock.timers.tick(3000); assert.equal(calls, 1);
  await control.stop(); release([{ type: 'outbound-rtp', codec: 'audio/opus', packetsSent: 50 }]);
  for (let i = 0; i < 8; ++i) await Promise.resolve();
  assert.equal(control.state.inputMetrics, undefined);
  t.mock.timers.tick(3000); assert.equal(calls, 1);
});
