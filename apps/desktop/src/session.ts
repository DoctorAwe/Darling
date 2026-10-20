import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import { ClientConfig, ServerPacket, Text, User, type ClientPacket, type Message, type PendingMessage, type Snapshot } from '../../../packages/protocol/src/index';
import type { IceConfig } from '../../../packages/protocol/src/index';
import { RtcSignaling } from './rtc-signaling';

const Outbox = z.array(z.object({ clientId: z.string().uuid(), sender: User, text: Text, createdAt: z.string() })).max(100);
export class Session extends EventEmitter {
  private readonly rtc = new RtcSignaling(packet => {
    if (this.stopped || this.state.status !== 'online' || this.socket?.readyState !== WebSocket.OPEN)
      throw new Error('RTC transport unavailable');
    this.transmit(packet);
  });
  // Internal native-adapter API: deliberately not exposed through preload.
  sendRtcSignal(signal: unknown): Promise<void> { return this.rtc.send(signal); }
  configureVoice(enabled: boolean, configured: boolean) {
    this.state.voiceBeta = enabled; this.state.voiceConfigured = configured; this.state.mediaAvailable = enabled && configured; this.emitState();
  }
  voiceStatus(detail: string) { if (this.state.voiceDetail === detail) return; this.state.voiceDetail = detail; this.emitState(); }
  remoteLevel(level: number | null) { this.state.remoteAudio = { level, sampledAt: Date.now() }; this.emitState(); }
  mediaReady(callId: string) { this.transmit({ version: 1, type: 'call.ready', requestId: randomUUID(), payload: { callId } }); }
  async refreshIce(): Promise<void> {
    if (this.state.status !== 'online') throw new Error('请先连接服务器');
    await new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.off('ice.updated', done); reject(new Error('无法取得中继配置')); }, 10000);
      const done = (requestId: string) => { if (requestId !== id) return; clearTimeout(timer); this.off('ice.updated', done); resolve(); };
      this.on('ice.updated', done);
      this.transmit({ version: 1, type: 'rtc.config', requestId: id, payload: {} });
    });
    if (!this.getIceConfig()) throw new Error('中继配置无效');
  }
  state: Snapshot;
  private config?: ClientConfig;
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private generation = 0;
  private attempts = 0;
  private stopped = false;
  private cursor = 0;
  private syncRequest?: string;
  private inflight = new Map<string, { clientId: string; at: number }>();
  private outboxPath = '';
  private ice?: IceConfig;
  // For the future native RTC adapter only; never included in renderer snapshots.
  getIceConfig(now = Date.now()): IceConfig | undefined {
    if (this.state.status !== 'online' || !this.ice || this.stopped) return undefined;
    if (this.ice.expiresAt !== null && this.ice.expiresAt <= now + 60000) return undefined;
    return structuredClone(this.ice);
  }
  private callRequest?: { id: string; timer: ReturnType<typeof setTimeout> };
  private clearCallRequest() {
    clearTimeout(this.callRequest?.timer); this.callRequest = undefined; this.state.callPending = false;
  }
  constructor(configPath: string, private dataDir: string) {
    super();
    this.rtc.on('signal', signal => this.emit('rtc.signal', signal));
    this.rtc.on('closed', scope => this.emit('rtc.closed', scope));
    this.state = { status: 'connecting', online: [], messages: [], pending: [], detail: '正在读取配置', configPath, mediaAvailable: false };
  }
  private emitState() { this.emit('state', structuredClone(this.state)); }
  private persist() {
    mkdirSync(dirname(this.outboxPath), { recursive: true });
    writeFileSync(this.outboxPath + '.tmp', JSON.stringify(this.state.pending), 'utf8');
    renameSync(this.outboxPath + '.tmp', this.outboxPath);
  }
  start() {
    this.stop(); this.stopped = false; this.attempts = 0; this.cursor = 0;
    this.state.messages = []; this.state.pending = []; this.state.online = []; this.state.user = undefined;
    try {
      this.config = ClientConfig.parse(JSON.parse(readFileSync(this.state.configPath, 'utf8')));
      this.state.user = this.config.auth.username;
      // Namespace queues by server and account so configuration changes never send old messages to another server.
      const namespace = Buffer.from(this.config.server.url).toString('base64url');
      this.outboxPath = join(this.dataDir, `outbox-${namespace}-${this.state.user}.json`);
      if (existsSync(this.outboxPath)) this.state.pending = Outbox.parse(JSON.parse(readFileSync(this.outboxPath, 'utf8'))).filter(m => m.sender === this.state.user);
      this.connect();
    } catch {
      this.stopped = true; this.state.status = 'error';
      this.state.detail = '配置或待发队列无法读取，请检查 JSON 格式、用户名、密码与服务器地址'; this.emitState();
    }
  }
  stop() {
    this.rtc.clear();
    this.ice = undefined;
    this.clearCallRequest(); this.state.call = null; this.state.callError = undefined;
    this.stopped = true; this.generation++;
    clearTimeout(this.timer); clearInterval(this.watchdog);
    this.socket?.removeAllListeners(); this.socket?.on('error', () => {}); this.socket?.terminate();
    this.socket = undefined; this.syncRequest = undefined; this.inflight.clear();
  }
  private connect() {
    if (this.stopped || !this.config) return;
    const generation = ++this.generation;
    this.state.status = 'connecting'; this.state.detail = '正在连接服务器'; this.emitState();
    const socket = this.socket = new WebSocket(this.config.server.url, { handshakeTimeout: 10000, maxPayload: 2 * 1024 * 1024 });
    let lastTraffic = Date.now();
    const loginDeadline = setTimeout(() => socket.terminate(), 15000);
    socket.on('open', () => this.transmit({ version: 1, type: 'auth.login', requestId: randomUUID(), payload: this.config!.auth }));
    socket.on('ping', () => { lastTraffic = Date.now(); });
    socket.on('error', () => {});
    this.watchdog = setInterval(() => {
      if (Date.now() - lastTraffic > 65000 || [...this.inflight.values()].some(v => Date.now() - v.at > 15000)) socket.terminate();
    }, 5000);
    socket.on('message', raw => {
      if (generation !== this.generation) return;
      lastTraffic = Date.now();
      let decoded: unknown;
      try { decoded = JSON.parse(raw.toString()); } catch { return; }
      const parsed = ServerPacket.safeParse(decoded);
      if (!parsed.success) return;
      const packet = parsed.data;
      if (packet.type === 'auth.ok') {
        this.ice = packet.payload.ice;
        clearTimeout(loginDeadline); this.attempts = 0;
        this.state.status = 'online'; this.state.detail = '已连接 · 消息同步中';
        this.requestSync();
        this.requestCall('call.sync', {});
      } else if (packet.type === 'rtc.config') { this.ice = packet.payload; this.emit('ice.updated', packet.requestId); return; }
      else if (packet.type === 'presence.changed') this.state.online = packet.payload.online;
      else if (packet.type === 'session.replaced') {
        this.rtc.clear();
        this.ice = undefined;
        this.clearCallRequest(); this.state.call = null;
        this.stopped = true; this.state.status = 'replaced'; this.state.detail = '此账号已在其他客户端登录，自动重连已停止';
      } else if (packet.type === 'call.state') {
        if (packet.requestId && packet.requestId !== this.callRequest?.id) return;
        if (packet.requestId) this.clearCallRequest();
        if (this.state.call?.callId !== packet.payload.call?.callId || packet.payload.call?.phase === 'ended') this.state.remoteAudio = undefined;
        this.state.call = packet.payload.call; this.state.callError = undefined;
        this.rtc.bind(this.state.call, this.state.user, this.state.status === 'online');
      } else if (packet.type === 'rtc.signal') {
        this.rtc.receive(packet.payload.sender, packet.payload.signal); return;
      } else if (packet.type === 'rtc.ack') {
        this.rtc.acknowledge(packet.requestId, packet.payload.callId, packet.payload.generation); return;
      } else if (packet.type === 'message.stored') {
        if (packet.requestId) this.inflight.delete(packet.requestId);
        this.merge(packet.payload);
      } else if (packet.type === 'message.page') {
        if (packet.requestId !== this.syncRequest) return;
        this.syncRequest = undefined;
        for (const message of packet.payload.messages) this.merge(message);
        // Cursor advances only through server-ordered pages, never through out-of-order live pushes.
        this.cursor = packet.payload.next;
        if (packet.payload.hasMore) this.requestSync();
        else { this.state.detail = '已连接 · 文字聊天就绪'; this.flush(); }
      } else if (packet.type === 'error') {
        if (packet.requestId && this.rtc.reject(packet.requestId, packet.payload.message)) return;
        if (packet.requestId && packet.requestId === this.callRequest?.id) {
          this.clearCallRequest(); this.state.callError = packet.payload.message; this.emitState(); return;
        }
        this.state.detail = packet.payload.message;
        if (packet.payload.code === 'AUTH_FAILED') { this.stopped = true; this.state.status = 'error'; }
        else if (packet.payload.code === 'STORAGE_ERROR') socket.close();
      }
      this.emitState();
    });
    socket.on('close', () => {
      clearTimeout(loginDeadline);
      if (generation !== this.generation) return;
      this.rtc.clear();
      clearInterval(this.watchdog); this.inflight.clear(); this.syncRequest = undefined;
      this.clearCallRequest(); this.state.call = null; this.state.callError = undefined;
      this.state.online = [];
      this.ice = undefined;
      if (!this.stopped) {
        this.state.status = 'offline'; this.state.detail = '连接中断，正在自动重连；待发消息已保留';
        const delay = Math.min(30000, 1000 * 2 ** this.attempts++) + Math.random() * 500;
        this.timer = setTimeout(() => this.connect(), delay);
      }
      this.emitState();
    });
  }
  private transmit(packet: ClientPacket) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(packet)); }
  private requestCall(type: 'call.sync' | 'call.invite' | 'call.accept' | 'call.end', payload: { callId?: string }) {
    const requestId = randomUUID();
    this.clearCallRequest(); this.state.callPending = true; this.state.callError = undefined;
    const timer = setTimeout(() => {
      if (this.callRequest?.id !== requestId) return;
      this.clearCallRequest(); this.state.callError = '通话请求超时，连接将重新同步；不会自动重试呼叫';
      this.socket?.terminate(); this.emitState();
    }, 10000);
    this.callRequest = { id: requestId, timer };
    if (type === 'call.accept' || type === 'call.end') this.transmit({ version: 1, type, requestId, payload: { callId: payload.callId! } });
    else this.transmit({ version: 1, type, requestId, payload: {} });
  }
  callAction(action: unknown, callId?: unknown): { ok: boolean; error?: string } {
    if (!['invite', 'accept', 'end'].includes(action as string)) return { ok: false, error: '无效通话操作' };
    if (this.stopped || this.state.status !== 'online' || this.socket?.readyState !== WebSocket.OPEN) return { ok: false, error: '请先连接服务器' };
    // Keep fail-closed until native RTC and device lifecycle are wired end to end.
    if (action !== 'end' && !this.state.mediaAvailable) return { ok: false, error: '请先确认测试版语音设备' };
    if (this.state.callPending) return { ok: false, error: '正在等待通话请求确认' };
    const call = this.state.call;
    if (action === 'invite') {
      if (call && call.phase !== 'ended') return { ok: false, error: '已有通话' };
      this.requestCall('call.invite', {}); this.emitState(); return { ok: true };
    }
    if (action === 'accept') {
      if (!call || call.callId !== callId || call.phase !== 'ringing' || call.callee !== this.state.user) return { ok: false, error: '邀请已变化' };
      this.requestCall('call.accept', { callId: call.callId }); this.emitState(); return { ok: true };
    }
    if (!call || call.phase === 'ended' || call.callId !== callId) return { ok: false, error: '通话已结束或状态已变化' };
    this.requestCall('call.end', { callId: call.callId }); this.emitState(); return { ok: true };
  }
  private requestSync() {
    this.syncRequest = randomUUID();
    this.transmit({ version: 1, type: 'message.sync', requestId: this.syncRequest, payload: { after: this.cursor } });
  }
  private merge(message: Message) {
    if (!this.state.messages.some(m => m.id === message.id)) {
      this.state.messages.push(message); this.state.messages.sort((a, b) => a.seq - b.seq);
    }
    if (message.sender === this.state.user && this.state.pending.some(m => m.clientId === message.clientId)) {
      this.state.pending = this.state.pending.filter(m => m.clientId !== message.clientId);
      try { this.persist(); } catch { this.state.detail = '消息已存储，但本地待发队列更新失败；重启后会自动去重'; }
    }
  }
  send(text: string): { ok: boolean; error?: string } {
    const parsed = Text.safeParse(text);
    if (!parsed.success) return { ok: false, error: '消息不能为空，最多 8000 字符' };
    if (!this.state.user || this.stopped) return { ok: false, error: '请先修复配置并连接服务器' };
    if (this.state.pending.length >= 100) return { ok: false, error: '待发队列已满，请等待连接恢复' };
    const message: PendingMessage = { clientId: randomUUID(), sender: this.state.user, text: parsed.data, createdAt: new Date().toISOString() };
    this.state.pending.push(message);
    try { this.persist(); } catch { this.state.pending.pop(); return { ok: false, error: '无法保存待发消息，请检查目录权限' }; }
    this.flush(); this.emitState(); return { ok: true };
  }
  private flush() {
    if (this.state.status !== 'online' || this.syncRequest) return;
    for (const message of this.state.pending) {
      if ([...this.inflight.values()].some(v => v.clientId === message.clientId)) continue;
      const requestId = randomUUID(); this.inflight.set(requestId, { clientId: message.clientId, at: Date.now() });
      this.transmit({ version: 1, type: 'message.send', requestId, payload: { clientId: message.clientId, text: message.text } });
    }
  }
}
