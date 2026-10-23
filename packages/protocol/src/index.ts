import { z } from 'zod';
import type { MediaState } from './media';

export const User = z.enum(['dva', 'mercy']);
export type User = z.infer<typeof User>;
export const IceConfig = z.object({
  iceServers: z.array(z.object({ urls: z.array(z.string().max(512)).min(1).max(4), username: z.string().max(256).optional(), credential: z.string().max(256).optional() }).strict()).max(8),
  expiresAt: z.number().int().nonnegative().nullable(),
}).strict();
export type IceConfig = z.infer<typeof IceConfig>;
export const otherUser = (user: User): User => user === 'dva' ? 'mercy' : 'dva';
export const Text = z.string().trim().min(1).max(8000);
const base = { version: z.literal(1), requestId: z.string().uuid() };
export const CallState = z.object({
  callId: z.string().uuid(), caller: User, callee: User,
  phase: z.enum(['ringing', 'connecting', 'active', 'ended']),
  reason: z.enum(['cancelled', 'rejected', 'hangup', 'timeout', 'disconnected', 'replaced', 'server-shutdown']).optional(),
  deadline: z.number().int().nonnegative(),
});
export type CallState = z.infer<typeof CallState>;
// Initial negotiation only; ICE restart requires a server-assigned next generation.
export const RtcSignal = z.discriminatedUnion('kind', [
  z.object({ callId: z.string().uuid(), generation: z.literal(1), kind: z.enum(['offer', 'answer']), sdp: z.string().min(1).max(24000) }).strict(),
  z.object({ callId: z.string().uuid(), generation: z.literal(1), kind: z.literal('ice'), candidate: z.string().max(2048), sdpMid: z.string().max(256).nullable(), sdpMLineIndex: z.number().int().min(0).max(255).nullable() }).strict(),
]);
export type RtcSignal = z.infer<typeof RtcSignal>;
export const RemoteSessionState = z.object({
  sessionId: z.string().uuid(), controller: User, controlled: User,
  phase: z.enum(['ringing', 'connecting', 'active', 'ended']),
  permissions: z.object({ control: z.boolean(), audio: z.boolean() }).strict(),
  reason: z.enum(['cancelled', 'rejected', 'hangup', 'timeout', 'disconnected', 'replaced', 'server-shutdown']).optional(),
  deadline: z.number().int().nonnegative(), startedAt: z.number().int().nonnegative().optional(),
}).strict();
export type RemoteSessionState = z.infer<typeof RemoteSessionState>;
export const RemoteSignal = z.discriminatedUnion('kind', [
  z.object({ sessionId: z.string().uuid(), generation: z.literal(1), kind: z.enum(['offer', 'answer']), sdp: z.string().min(1).max(64000) }).strict(),
  z.object({ sessionId: z.string().uuid(), generation: z.literal(1), kind: z.literal('ice'), candidate: z.string().max(2048), sdpMid: z.string().max(256).nullable(), sdpMLineIndex: z.number().int().min(0).max(255).nullable() }).strict(),
]);
export type RemoteSignal = z.infer<typeof RemoteSignal>;
export const RemoteInputEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pointer.move'), x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
  z.object({ type: z.literal('pointer.button'), button: z.enum(['left', 'middle', 'right']), down: z.boolean() }).strict(),
  z.object({ type: z.literal('pointer.wheel'), deltaX: z.number().int().min(-1200).max(1200), deltaY: z.number().int().min(-1200).max(1200) }).strict(),
  z.object({ type: z.literal('key'), code: z.string().regex(/^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Arrow(?:Up|Down|Left|Right)|(?:Backspace|Tab|Enter|Escape|Space|Insert|Delete|Home|End|PageUp|PageDown)|(?:Shift|Control|Alt|Meta)(?:Left|Right)|(?:CapsLock|NumLock|ScrollLock)|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter))$/).max(24), down: z.boolean() }).strict(),
  z.object({ type: z.literal('release') }).strict(),
]);
export type RemoteInputEvent = z.infer<typeof RemoteInputEvent>;
export const ClientPacket = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('call.ready'), payload: z.object({ callId: z.string().uuid() }) }),
  z.object({ ...base, type: z.literal('rtc.config'), payload: z.object({}) }),
  z.object({ ...base, type: z.literal('rtc.signal'), payload: RtcSignal }),
  z.object({ ...base, type: z.literal('call.invite'), payload: z.object({}) }),
  z.object({ ...base, type: z.literal('call.accept'), payload: z.object({ callId: z.string().uuid() }) }),
  z.object({ ...base, type: z.literal('call.end'), payload: z.object({ callId: z.string().uuid() }) }),
  z.object({ ...base, type: z.literal('call.sync'), payload: z.object({}) }),
  z.object({ ...base, type: z.literal('remote.invite'), payload: z.object({}) }),
  z.object({ ...base, type: z.literal('remote.accept'), payload: z.object({ sessionId: z.string().uuid(), permissions: z.object({ control: z.boolean(), audio: z.boolean() }).strict() }) }),
  z.object({ ...base, type: z.literal('remote.permissions'), payload: z.object({ sessionId: z.string().uuid(), permissions: z.object({ control: z.boolean(), audio: z.boolean() }).strict() }) }),
  z.object({ ...base, type: z.literal('remote.ready'), payload: z.object({ sessionId: z.string().uuid() }) }),
  z.object({ ...base, type: z.literal('remote.end'), payload: z.object({ sessionId: z.string().uuid() }) }),
  z.object({ ...base, type: z.literal('remote.sync'), payload: z.object({}) }),
  z.object({ ...base, type: z.literal('remote.signal'), payload: RemoteSignal }),
  z.object({ ...base, type: z.literal('auth.login'), payload: z.object({ username: User, password: z.string().min(1).max(512) }) }),
  z.object({ ...base, type: z.literal('message.send'), payload: z.object({ clientId: z.string().uuid(), text: Text }) }),
  z.object({ ...base, type: z.literal('message.sync'), payload: z.object({ after: z.number().int().min(0) }) }),
]);
export type ClientPacket = z.infer<typeof ClientPacket>;
export const Attachment = z.object({ id: z.string().uuid(), name: z.string().min(1).max(255), mime: z.string().min(1).max(128), size: z.number().int().nonnegative().max(128 * 1024 * 1024) }).strict();
export type Attachment = z.infer<typeof Attachment>;
export const Message = z.object({ id: z.string(), clientId: z.string(), sender: User, text: z.string(), attachment: Attachment.optional(), seq: z.number().int(), createdAt: z.string() });
export type Message = z.infer<typeof Message>;
export const ServerPacket = z.discriminatedUnion('type', [
  z.object({ version: z.literal(1), type: z.literal('rtc.config'), requestId: z.string(), payload: IceConfig }),
  z.object({ version: z.literal(1), type: z.literal('rtc.signal'), payload: z.object({ sender: User, signal: RtcSignal }) }),
  z.object({ version: z.literal(1), type: z.literal('rtc.ack'), requestId: z.string(), payload: z.object({ callId: z.string().uuid(), generation: z.literal(1) }) }),
  z.object({ version: z.literal(1), type: z.literal('call.state'), requestId: z.string().optional(), payload: z.object({ call: CallState.nullable() }) }),
  z.object({ version: z.literal(1), type: z.literal('remote.state'), requestId: z.string().optional(), payload: z.object({ session: RemoteSessionState.nullable() }) }),
  z.object({ version: z.literal(1), type: z.literal('remote.signal'), payload: z.object({ sender: User, signal: RemoteSignal }) }),
  z.object({ version: z.literal(1), type: z.literal('remote.ack'), requestId: z.string(), payload: z.object({ sessionId: z.string().uuid(), generation: z.literal(1) }) }),
  z.object({ version: z.literal(1), type: z.literal('auth.ok'), requestId: z.string(), payload: z.object({ user: User, ice: IceConfig.optional() }) }),
  z.object({ version: z.literal(1), type: z.literal('presence.changed'), payload: z.object({ online: z.array(User) }) }),
  z.object({ version: z.literal(1), type: z.literal('session.replaced'), payload: z.object({}) }),
  z.object({ version: z.literal(1), type: z.literal('message.stored'), requestId: z.string().optional(), payload: Message }),
  z.object({ version: z.literal(1), type: z.literal('message.page'), requestId: z.string(), payload: z.object({ messages: z.array(Message), hasMore: z.boolean(), next: z.number().int() }) }),
  z.object({ version: z.literal(1), type: z.literal('error'), requestId: z.string().optional(), payload: z.object({ code: z.string(), message: z.string() }) }),
]);
export type ServerPacket = z.infer<typeof ServerPacket>;
export const ClientConfig = z.object({
  schemaVersion: z.literal(1),
  server: z.object({ url: z.url().refine(v => /^wss?:\/\//.test(v), '需要 ws:// 或 wss:// 地址') }),
  auth: z.object({ username: User, password: z.string().min(1).max(512) }),
  audio: z.object({ inputDeviceId: z.string(), outputDeviceId: z.string(), profile: z.enum(['natural', 'balanced', 'strong']) }).optional(),
});
export type ClientConfig = z.infer<typeof ClientConfig>;
export type PendingMessage = { clientId: string; sender: User; text: string; createdAt: string };
export type Snapshot = {
  status: 'connecting' | 'online' | 'offline' | 'error' | 'replaced';
  user?: User; online: User[]; messages: Message[]; pending: PendingMessage[];
  detail: string; configPath: string; mediaAvailable: boolean;
  voiceBeta?: boolean; voiceConfigured?: boolean; voiceDetail?: string;
  remoteAudio?: { level: number | null; sampledAt: number };
  call?: CallState | null; callError?: string; callPending?: boolean;
  remote?: RemoteSessionState | null; remoteError?: string; remotePending?: boolean;
};
export type RtcInputMetrics = {
  sampledAt: number; sentPackets: number | null; receivedPackets: number | null;
  receivedSamples: number | null; concealedSamples: number | null;
  decodedRms: number | null; decodedPeak: number | null; maximumPeak: number | null;
};
export type RtcDeviceTestState = { available: boolean; status: 'idle' | 'starting' | 'running' | 'stopping'; detail: string; inputMetrics?: RtcInputMetrics };
export interface DesktopApi {
  callAudio(callId: string, micMuted: boolean, speakerMuted: boolean): Promise<void>;
  voiceConfigure(value: { confirmed: true; inputDeviceId: string; outputDeviceId: string; outputProfile: 'headphones' | 'speakers'; noiseSuppression: boolean }): Promise<void>;
  rtcDeviceSnapshot(): Promise<RtcDeviceTestState>;
  rtcDeviceStart(value: { confirmed: true; inputDeviceId: string; outputDeviceId: string; outputProfile: 'headphones' | 'speakers'; noiseSuppression: boolean }): Promise<void>;
  rtcDeviceStop(): Promise<void>;
  snapshot(): Promise<Snapshot>;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
  send(text: string): Promise<{ ok: boolean; error?: string }>;
  attachmentPick(): Promise<Array<{ token: string; name: string; mime: string; size: number; image: boolean }>>;
  attachmentScreenshot(): Promise<{ token: string; name: string; mime: string; size: number; image: boolean } | null>;
  subscribeScreenshot(listener: (jpeg: Uint8Array) => void): () => void;
  screenshotReady(): void;
  screenshotComplete(selection?: { x: number; y: number; width: number; height: number }): void;
  attachmentDiscard(token: string): Promise<void>;
  attachmentSend(token: string): Promise<{ ok: boolean; error?: string }>;
  attachmentRead(id: string): Promise<{ data: ArrayBuffer; mime: string }>;
  attachmentSave(id: string, suggestedName: string): Promise<{ ok: boolean; cancelled?: boolean; error?: string }>;
  reload(): Promise<void>;
  callAction(action: 'invite' | 'accept' | 'end', callId?: string): Promise<{ ok: boolean; error?: string }>;
  remoteAction(action: 'invite' | 'accept' | 'end', sessionId?: string, permissions?: { control: boolean; audio: boolean }): Promise<{ ok: boolean; error?: string }>;
  remotePermissions(sessionId: string, permissions: { control: boolean; audio: boolean }): Promise<{ ok: boolean; error?: string }>;
  remoteIceConfig(): Promise<IceConfig>;
  remoteCaptureSource(): Promise<string>;
  remoteSignal(signal: RemoteSignal): Promise<void>;
  remoteReady(sessionId: string): Promise<void>;
  remoteDrainSignals(sessionId: string): Promise<RemoteSignal[]>;
  subscribeRemoteSignal(listener: (signal: RemoteSignal) => void): () => void;
  remoteInput(sessionId: string, event: RemoteInputEvent): Promise<void>;
  remoteDiagnostic(sessionId: string, stage: string, detail: string): Promise<void>;
  mediaSnapshot(): Promise<MediaState>;
  mediaInspect(): Promise<MediaState>;
  audioPreferenceGet(pair: { inputId: string; outputId: string }): Promise<{ aecEnabled: boolean; saved: boolean }>;
  audioPreferenceSet(pair: { inputId: string; outputId: string }, aecEnabled: boolean): Promise<{ aecEnabled: boolean; saved: boolean }>;
  captureStart(deviceId: string, aecEnabled?: boolean): Promise<MediaState>;
  captureStop(): Promise<MediaState>;
  playbackStart(deviceId: string): Promise<MediaState>;
  playbackStop(): Promise<MediaState>;
  subscribeMedia(listener: (snapshot: MediaState) => void): () => void;
  window(action: 'minimize' | 'maximize' | 'close'): void;
}
