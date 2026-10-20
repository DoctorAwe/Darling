import { z } from 'zod';
export const MediaCapabilities = z.object({ devices: z.boolean(), capture: z.boolean(), playback: z.boolean(), aec: z.boolean(), aecControl: z.boolean().optional(), noiseSuppression: z.boolean(), rtc: z.boolean() });
export const AudioDevice = z.object({
  id: z.string(), name: z.string(), direction: z.enum(['input', 'output']),
  formFactor: z.enum(['headphones', 'headset', 'speakers', 'handset', 'microphone', 'line-level', 'digital', 'display', 'unknown']).default('unknown'),
  isDefault: z.boolean(), isCommunicationsDefault: z.boolean(), rawSupport: z.enum(['unknown', 'supported', 'unsupported']),
  mixFormat: z.object({ sampleRate: z.number().int().positive(), channels: z.number().int().positive(), containerBits: z.number().int().positive() }).nullable(),
});
export type AudioDevice = z.infer<typeof AudioDevice>;
export const CaptureState = z.object({
  running: z.boolean(), deviceId: z.string(),
  format: z.object({ sampleRate: z.number(), channels: z.number(), containerBits: z.number(), validBits: z.number(), encoding: z.enum(['float', 'pcm']) }).nullable(),
  peak: z.number().nonnegative(), rms: z.number().nonnegative(), frames: z.number().nonnegative(), clippedSamples: z.number().nonnegative(),
  discontinuities: z.number().nonnegative(), timestampErrors: z.number().nonnegative(), reason: z.string(), error: z.string(), rawMode: z.literal('not-requested'),
  processing: z.object({ sampleRate: z.literal(48000), blockSamples: z.literal(480), channels: z.literal(1), mode: z.enum(['bypass', 'aec3-experimental']), processedRms: z.number().nonnegative().optional(), captureBlocks: z.number(), referenceBlocks: z.number(), droppedReferences: z.number(), staleReferences: z.number() }).optional(),
});
export type CaptureState = z.infer<typeof CaptureState>;
export const PlaybackState = z.object({ running: z.boolean(), deviceId: z.string(), frames: z.number(), paddingFrames: z.number(), streamLatencyMs: z.number(), reason: z.string(), error: z.string(), referenceBlocks: z.number(), droppedReferences: z.number(), sampleRate: z.literal(48000), channels: z.literal(1) });
const base = { protocolVersion: z.literal(1), requestId: z.string() };
export const MediaPacket = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('engine.ready'), payload: z.object({ engineVersion: z.string(), capabilities: MediaCapabilities, dependencies: z.record(z.string(), z.union([z.string(), z.number(), z.null()])) }) }),
  z.object({ ...base, type: z.literal('devices.listed'), payload: z.object({ devices: z.array(AudioDevice).max(256) }) }),
  z.object({ ...base, type: z.literal('capture.state'), payload: CaptureState }),
  z.object({ ...base, type: z.literal('playback.state'), payload: PlaybackState }),
  z.object({ ...base, type: z.literal('engine.stopped'), payload: z.object({}) }),
  z.object({ ...base, type: z.literal('engine.error'), payload: z.object({ code: z.string(), message: z.string() }) }),
]);
export type MediaPacket = z.infer<typeof MediaPacket>;
export type MediaState = {
  status: 'stopped' | 'starting' | 'ready' | 'unavailable' | 'error';
  detail: string; engineVersion?: string; devices: AudioDevice[];
  capabilities: z.infer<typeof MediaCapabilities>;
  capture?: CaptureState;
  playback?: z.infer<typeof PlaybackState>;
};
export const emptyMediaState = (): MediaState => ({ status: 'stopped', detail: '媒体进程尚未启动', devices: [], capabilities: { devices: false, capture: false, playback: false, aec: false, noiseSuppression: false, rtc: false } });
