import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { RtcSignal, IceConfig } from '../../../packages/protocol/src/index';

const Scope = z.object({ callId: z.string().uuid(), generation: z.literal(1) });
export const DeviceAudio = z.object({
  confirmed: z.literal(true),
  inputDeviceId: z.string().min(1).max(127).refine(value => value !== 'default' && !value.includes('\0')),
  outputDeviceId: z.string().min(1).max(127).refine(value => value !== 'default' && !value.includes('\0')),
  outputProfile: z.enum(['headphones', 'speakers']), noiseSuppression: z.boolean(),
});
export type DeviceAudio = z.infer<typeof DeviceAudio>;
const base = { protocolVersion: z.literal(1), requestId: z.string().uuid() };
const Ice = z.object({ kind: z.literal('ice'), candidate: z.string().max(2048), sdpMid: z.string().max(256), sdpMLineIndex: z.number().int().min(0).max(255) });
const Packet = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('engine.ready'), payload: z.object({ engineVersion: z.string(), aecAlgorithm: z.enum(['none', 'webrtc-aec3', 'darling-pbfdaf-v2']).optional(), negotiationOnly: z.boolean(), syntheticAudio: z.boolean().default(false), wasapiAudio: z.boolean().default(false), desktopVideo: z.boolean().default(false), desktopCursorEmbedded: z.boolean().default(true), controlData: z.boolean().default(false), rtc: z.literal(false), capture: z.literal(false), playback: z.literal(false) }) }),
  z.object({ ...base, type: z.literal('engine.error'), payload: z.object({ code: z.string().max(128) }) }),
  z.object({ ...base, type: z.literal('rtc.ok'), payload: Scope }),
  z.object({ ...base, type: z.literal('rtc.stats'), payload: Scope.extend({ stats: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))).max(32) }) }),
  z.object({ ...base, type: z.literal('rtc.description'), payload: RtcSignal }),
  z.object({ ...base, type: z.literal('rtc.events'), payload: Scope.extend({ candidates: z.array(Ice).max(16), connectionState: z.enum(['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']), iceState: z.string().optional(), dataState: z.enum(['unavailable', 'connecting', 'open', 'closing', 'closed']).default('unavailable'), messages: z.array(z.string().min(1).max(4096)).max(16).default([]), videoFrames: z.number().int().nonnegative().default(0), videoAttached: z.boolean().default(false), videoWidth: z.number().int().nonnegative().default(0), videoHeight: z.number().int().nonnegative().default(0) }) }),
]);
type Packet = z.infer<typeof Packet>;

// One child per call. Closing invalidates all asynchronous work and kills the child.
// Diagnostic host: synthetic audio requires an explicit process argument and handshake.
export class RtcProcessHost extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (p: Packet) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private initialization?: Promise<void>;
  private tail = Promise.resolve();
  private queued = 0;
  private polling = false;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private remoteReady = false;
  private remoteIce: RtcSignal[] = [];
  private receivedIce = 0;
  private sentIce = 0;
  private deviceTimer?: ReturnType<typeof setTimeout>;
  private stopping?: Promise<'graceful' | 'forced' | 'not-running'>;
  constructor(private executable: string, readonly scope: { callId: string; generation: 1 }, private role: 'caller' | 'callee', private args: string[] = [], private timeoutMs = 15000, private iceMode: 'disabled' | 'direct' | 'relay' | 'all' = 'disabled', private iceConfig?: IceConfig, private deviceAudio?: DeviceAudio, private deviceLimitMs = 60000) {
    super(); Scope.parse(scope);
    if (iceConfig) this.iceConfig = IceConfig.parse(iceConfig);
    if (deviceAudio) this.deviceAudio = DeviceAudio.parse(deviceAudio);
  }
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('RTC host closed'));
    if (this.args.includes('--wasapi-audio') !== !!this.deviceAudio || (this.deviceAudio && (this.args.includes('--synthetic-audio') || this.iceMode === 'disabled')))
      return Promise.reject(new Error('Explicit WASAPI device confirmation and active ICE required'));
    if ((this.iceMode === 'relay' || this.iceMode === 'all') && (!this.iceConfig || !this.iceConfig.iceServers.some(server => server.urls.some(url => /^turns?:/.test(url))) || this.iceConfig.expiresAt === null || this.iceConfig.expiresAt <= Date.now() + 60000))
      return Promise.reject(new Error('Fresh TURN credentials required'));
    return this.initialization ??= this.launch();
  }
  private async launch() {
    const child = this.child = spawn(this.executable, this.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (this.deviceAudio && this.deviceLimitMs > 0) this.deviceTimer = setTimeout(() => {
      this.emit('device-timeout'); void this.stop();
    }, this.deviceLimitMs);
    const decoder = new StringDecoder('utf8'); let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.closed) return;
      if (this.closed || this.child !== child) return;
      buffer += decoder.write(chunk);
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > 65536) return this.fail('RTC response too large');
        const decoded = (() => { try { return JSON.parse(line); } catch { return null; } })();
        const parsed = Packet.safeParse(decoded);
        if (!parsed.success) return this.fail('Invalid RTC response');
        const packet = parsed.data;
        const pending = this.pending.get(packet.requestId);
        if (!pending) return this.fail('Unexpected RTC response');
        if ((packet.type === 'rtc.ok' || packet.type === 'rtc.description' || packet.type === 'rtc.events' || packet.type === 'rtc.stats') && packet.payload.callId !== this.scope.callId)
          return this.fail('Mismatched RTC call scope');
        clearTimeout(pending.timer); this.pending.delete(packet.requestId);
        if (packet.type === 'engine.error') pending.reject(new Error(packet.payload.code));
        else pending.resolve(packet);
      }
      if (Buffer.byteLength(buffer) > 65536) this.fail('RTC response too large');
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => this.fail('RTC input closed'));
    child.on('error', () => this.fail('RTC process unavailable'));
    child.on('exit', () => { if (!this.closed) this.fail('RTC process exited'); });
    try {
      const hello = await this.request('engine.hello');
      const synthetic = this.args.includes('--synthetic-audio');
      const wasapi = !!this.deviceAudio;
      if (hello.type !== 'engine.ready' || hello.payload.syntheticAudio !== synthetic || hello.payload.wasapiAudio !== wasapi || hello.payload.negotiationOnly !== !(synthetic || wasapi))
        throw new Error('Invalid RTC handshake');
      if (this.args.includes('--desktop-video') && (!hello.payload.desktopVideo || hello.payload.desktopCursorEmbedded))
        throw new Error('Cursor-free native desktop source required');
      if (this.args.includes('--control-data') !== hello.payload.controlData)
        throw new Error('Native control data channel mismatch');
      if (this.args.includes('--aec3-experimental') && hello.payload.aecAlgorithm !== 'webrtc-aec3')
        throw new Error('Experimental AEC3 engine required');
      if ((await this.request('rtc.open', { ...this.scope, role: this.role, iceMode: this.iceMode, iceServers: this.iceMode === 'relay' || this.iceMode === 'all' ? this.iceConfig!.iceServers : [], ...(this.deviceAudio ? { deviceAudio: this.deviceAudio } : {}) })).type !== 'rtc.ok') throw new Error('RTC open failed');
      if (this.role === 'caller') {
        const offer = await this.request('rtc.offer', this.scope);
        if (offer.type !== 'rtc.description' || offer.payload.kind !== 'offer') throw new Error('Expected RTC offer');
        if (!this.closed) this.emit('signal', offer.payload);
        this.poll();
      }
    } catch (error) { this.fail('RTC initialization failed'); throw error; }
  }
  apply(value: unknown): Promise<void> {
    const parsed = RtcSignal.safeParse(value);
    if (!parsed.success || parsed.data.callId !== this.scope.callId)
      return Promise.reject(new Error('Invalid scope'));
    const signal = parsed.data;
    if (signal.kind !== 'ice' && signal.kind !== (this.role === 'caller' ? 'answer' : 'offer')) return Promise.reject(new Error('Unexpected description role'));
    if (signal.kind === 'ice') {
      if (this.iceMode === 'disabled') return Promise.reject(new Error('ICE is disabled'));
      if (this.closed || ++this.receivedIce > 128) return Promise.reject(new Error('RTC closed or ICE limit exceeded'));
      if (!this.remoteReady) { this.remoteIce.push(signal); return Promise.resolve(); }
    }
    if (this.closed || this.queued >= 128) return Promise.reject(new Error('RTC closed or queue full'));
    ++this.queued;
    const operation = this.tail.then(async () => {
      await this.start();
      if (signal.kind === 'ice') {
        if ((await this.request('rtc.ice', signal)).type !== 'rtc.ok') throw new Error('ICE apply failed');
        return;
      }
      const result = await this.request('rtc.apply', signal);
      if (this.role === 'callee') {
        if (result.type !== 'rtc.description' || result.payload.kind !== 'answer') throw new Error('Expected RTC answer');
        if (!this.closed) this.emit('signal', result.payload);
      } else if (result.type !== 'rtc.ok') throw new Error('Expected RTC applied response');
      this.remoteReady = true;
      for (const ice of this.remoteIce.splice(0)) {
        if ((await this.request('rtc.ice', ice)).type !== 'rtc.ok') throw new Error('Buffered ICE apply failed');
      }
      this.poll();
    }).catch(error => { this.fail('RTC description failed'); throw error; }).finally(() => { --this.queued; });
    this.tail = operation.catch(() => {});
    return operation;
  }
  private poll() {
    if (this.closed || this.polling || this.iceMode === 'disabled') return;
    this.polling = true;
    void this.request('rtc.poll', this.scope).then(packet => {
      if (this.closed) return;
      if (packet.type !== 'rtc.events') throw new Error('Expected RTC events');
      for (const candidate of packet.payload.candidates) {
        if (++this.sentIce > 128) throw new Error('ICE limit exceeded');
        this.emit('signal', { ...this.scope, ...candidate });
      }
      this.emit('connection', packet.payload.connectionState);
      this.emit('ice-state', packet.payload.iceState);
      this.emit('data-state', packet.payload.dataState);
      for (const message of packet.payload.messages) this.emit('data', message);
      this.emit('video-stats', { frames: packet.payload.videoFrames, attached: packet.payload.videoAttached, width: packet.payload.videoWidth, height: packet.payload.videoHeight });
      if (packet.payload.connectionState === 'failed') this.fail('ICE/DTLS connection failed');
    }).catch(() => this.fail('RTC event polling failed')).finally(() => {
      this.polling = false;
      if (!this.closed) this.pollTimer = setTimeout(() => this.poll(), 100);
    });
  }
  async diagnosticStats() {
    const packet = await this.request('rtc.stats', this.scope);
    if (packet.type !== 'rtc.stats') throw new Error('Expected RTC stats');
    return packet.payload.stats;
  }
  async setAudio(micMuted: boolean, speakerMuted: boolean) {
    if (typeof micMuted !== 'boolean' || typeof speakerMuted !== 'boolean') throw new Error('Invalid mute state');
    const packet = await this.request('rtc.audio', { ...this.scope, micMuted, speakerMuted });
    if (packet.type !== 'rtc.ok') throw new Error('Audio control failed');
  }
  async sendData(message: string) {
    if (typeof message !== 'string' || message.length === 0 || Buffer.byteLength(message) > 4096) throw new Error('Invalid data message');
    const packet = await this.request('rtc.data.send', { ...this.scope, message });
    if (packet.type !== 'rtc.ok') throw new Error('Data channel send failed');
  }
  async attachVideo(parentWindow: bigint, bounds: { x: number; y: number; width: number; height: number }) {
    await this.videoWindow('rtc.video.attach', parentWindow, bounds);
  }
  async resizeVideo(parentWindow: bigint, bounds: { x: number; y: number; width: number; height: number }) {
    await this.videoWindow('rtc.video.resize', parentWindow, bounds);
  }
  private async videoWindow(type: 'rtc.video.attach' | 'rtc.video.resize', parentWindow: bigint, bounds: { x: number; y: number; width: number; height: number }) {
    if (parentWindow <= 0n || !Number.isInteger(bounds.x) || !Number.isInteger(bounds.y) || !Number.isInteger(bounds.width) || !Number.isInteger(bounds.height) || bounds.x < -32768 || bounds.x > 32767 || bounds.y < -32768 || bounds.y > 32767 || bounds.width < 1 || bounds.width > 16384 || bounds.height < 1 || bounds.height > 16384)
      throw new Error('Invalid video window');
    const packet = await this.request(type, { ...this.scope, parentWindow: parentWindow.toString(), ...bounds });
    if (packet.type !== 'rtc.ok') throw new Error('Video window operation failed');
  }
  private request(type: string, payload: object = {}): Promise<Packet> {
    if (this.closed || !this.child || this.child.stdin.destroyed) return Promise.reject(new Error('RTC host closed'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('RTC response timed out'), this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ protocolVersion: 1, requestId, type, payload }) + '\n');
    });
  }
  private fail(reason: string) {
    if (this.closed) return;
    this.close(); this.emit('fault', reason);
  }
  close() {
    this.invalidate();
    this.child?.kill(); this.child = undefined;
  }
  private invalidate() {
    this.closed = true;
    this.iceConfig = undefined;
    this.deviceAudio = undefined;
    clearTimeout(this.deviceTimer);
    clearTimeout(this.pollTimer); this.remoteIce = [];
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('RTC host closed')); }
    this.pending.clear();
  }
  // EOF lets native code close PeerConnection/ADM and join audio workers.
  // Failures still use close() for immediate termination; a stalled driver is bounded.
  stop(graceMs = 2000): Promise<'graceful' | 'forced' | 'not-running'> {
    if (this.stopping) return this.stopping;
    if (!Number.isFinite(graceMs) || graceMs < 0 || graceMs > 5000) return Promise.reject(new Error('Invalid stop deadline'));
    const child = this.child;
    this.invalidate();
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve('not-running');
    this.stopping = new Promise(resolve => {
      let forced = false;
      const timer = setTimeout(() => { forced = true; child.kill(); }, graceMs);
      const done = () => {
        clearTimeout(timer);
        if (this.child === child) this.child = undefined;
        resolve(forced || child.exitCode !== 0 ? 'forced' : 'graceful');
      };
      child.once('close', done);
      child.stdin.end();
    });
    return this.stopping;
  }
}
