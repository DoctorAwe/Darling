import type { RtcInputMetrics } from '../../../packages/protocol/src/index';
type Stats = Record<string, string | number | boolean>[];
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const level = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
// Select only microphone outbound RTP and the synthetic peer's received audio.
// Never expose full candidate, device, credential or SDP records to the renderer.
export function rtcInputMetrics(sender: Stats, receiver: Stats): RtcInputMetrics {
  const sent = sender.find(s => s.type === 'outbound-rtp' && s.codec === 'audio/opus');
  const received = receiver.find(s => s.type === 'inbound-rtp' && s.codec === 'audio/opus');
  const pcm = receiver.find(s => s.type === 'synthetic-audio');
  return {
    sampledAt: Date.now(), sentPackets: count(sent?.packetsSent), receivedPackets: count(received?.packetsReceived),
    receivedSamples: count(received?.totalSamplesReceived), concealedSamples: count(received?.concealedSamples),
    decodedRms: level(pcm?.decodedRms), decodedPeak: level(pcm?.decodedPeak), maximumPeak: level(pcm?.maximumPeak),
  };
}
