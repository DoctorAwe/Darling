import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rtcInputMetrics } from '../apps/desktop/src/rtc-input-metrics';
test('input metrics select microphone outbound and remote inbound, not test tone transmit', () => {
  const data = rtcInputMetrics([
    { type: 'inbound-rtp', codec: 'audio/opus', packetsReceived: 999 },
    { type: 'outbound-rtp', codec: 'audio/opus', packetsSent: 45 },
  ], [
    { type: 'outbound-rtp', codec: 'audio/opus', packetsSent: 999 },
    { type: 'inbound-rtp', codec: 'audio/opus', packetsReceived: 42, totalSamplesReceived: 4800, concealedSamples: 480 },
    { type: 'synthetic-audio', decodedRms: 0.1, decodedPeak: 0.3, maximumPeak: 0.5, secret: 'not-forwarded' },
  ]);
  assert.equal(data.sentPackets, 45); assert.equal(data.receivedPackets, 42);
  assert.equal(data.receivedSamples, 4800); assert.equal(data.concealedSamples, 480);
  assert.equal(data.decodedRms, 0.1); assert.equal(data.maximumPeak, 0.5);
  assert.ok(!JSON.stringify(data).includes('not-forwarded'));
});
test('missing and invalid stats remain unknown instead of claiming zero or silence', () => {
  const data = rtcInputMetrics([{ type: 'outbound-rtp', codec: 'audio/opus', packetsSent: -1 }], [
    { type: 'synthetic-audio', decodedRms: NaN, decodedPeak: 2, maximumPeak: Infinity },
  ]);
  for (const [key, value] of Object.entries(data)) if (key !== 'sampledAt') assert.equal(value, null);
  assert.equal(rtcInputMetrics([], [{ type: 'synthetic-audio', decodedRms: 0 }]).decodedRms, 0);
});
