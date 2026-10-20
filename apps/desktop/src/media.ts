import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { MediaPacket, emptyMediaState, type MediaState } from '../../../packages/protocol/src/media';

const MAX_LINE = 64 * 1024;
export class MediaHost extends EventEmitter {
  state: MediaState = emptyMediaState();
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (packet: MediaPacket) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private operation?: Promise<void>;
  private stopping = false;
  private captureTimer?: ReturnType<typeof setTimeout>;
  private captureGeneration = 0;
  private playbackTimer?: ReturnType<typeof setTimeout>;
  private playbackGeneration = 0;
  private deviceTimer?: ReturnType<typeof setTimeout>;
  private refreshing?: Promise<void>;
  constructor(private executable: string, private args: string[] = [], private timeoutMs = 5000, private deviceCheckMs = 2000) { super(); }
  private publish() { this.emit('state', structuredClone(this.state)); }
  start(): Promise<void> {
    if (this.operation) return this.operation;
    if (this.child) return Promise.resolve();
    this.operation = this.launch().finally(() => { this.operation = undefined; });
    return this.operation;
  }
  private async launch() {
    this.stopping = false;
    this.state = { ...emptyMediaState(), status: 'starting', detail: '正在连接原生媒体进程' }; this.publish();
    const child = this.child = spawn(this.executable, this.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return;
      buffer += decoder.write(chunk);
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_LINE) return this.fail('媒体协议响应超过限制');
        try {
          const packet = MediaPacket.parse(JSON.parse(line));
          const request = this.pending.get(packet.requestId);
          if (!request) continue;
          clearTimeout(request.timer); this.pending.delete(packet.requestId);
          if (packet.type === 'engine.error') request.reject(new Error(packet.payload.message));
          else request.resolve(packet);
        } catch { return this.fail('媒体协议格式或版本不兼容'); }
      }
      if (Buffer.byteLength(buffer) > MAX_LINE) this.fail('媒体协议响应超过限制');
    });
    // Drain diagnostics without forwarding potentially large/untrusted output to renderer.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => { if (this.child === child && !this.stopping) this.fail('媒体进程输入通道断开'); });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      this.fail(error.code === 'ENOENT' ? '未找到原生引擎，请先运行 pnpm native:build' : '无法启动原生媒体进程', error.code === 'ENOENT' ? 'unavailable' : 'error');
    });
    child.on('exit', () => {
      if (this.child !== child) return;
      clearTimeout(this.deviceTimer); this.refreshing = undefined;
      ++this.captureGeneration; clearTimeout(this.captureTimer);
      ++this.playbackGeneration; clearTimeout(this.playbackTimer);
      this.child = undefined;
      this.rejectAll('媒体进程已退出');
      if (!this.stopping) { this.state = { ...emptyMediaState(), status: 'error', detail: '媒体进程意外退出；请重新检测设备' }; this.publish(); }
    });
    try {
      const hello = await this.request('engine.hello');
      if (this.stopping || this.child !== child) return;
      if (hello.type !== 'engine.ready') throw new Error('媒体握手响应不匹配');
      this.state = { status: 'ready', detail: '原生引擎就绪 · 麦克风未开启', engineVersion: hello.payload.engineVersion, capabilities: hello.payload.capabilities, devices: [] };
      await this.refresh(); this.publish();
      if (this.child === child && this.state.status === 'ready') this.watchDevices(child);
    } catch (error) {
      if (!this.stopping && (this.state.status === 'starting' || this.state.status === 'ready')) this.fail(error instanceof Error ? error.message : '媒体启动失败');
    }
  }
  private request(type: string, payload: object = {}): Promise<MediaPacket> {
    const child = this.child;
    if (!child || child.stdin.destroyed) return Promise.reject(new Error('媒体进程未连接'));
    if (this.pending.size >= 16) return Promise.reject(new Error('媒体控制队列繁忙'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('媒体进程响应超时')); }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ protocolVersion: 1, requestId, type, payload }) + '\n');
    });
  }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const pending=this.refreshDevices().finally(()=>{ if(this.refreshing===pending) this.refreshing=undefined; });
    this.refreshing=pending;
    return pending;
  }
  private async refreshDevices() {
    if (this.state.status !== 'ready') return;
    const child=this.child;
    try {
      const result = await this.request('devices.list');
      if (this.child!==child || this.stopping) return;
      if (result.type !== 'devices.listed') throw new Error('设备列表响应不匹配');
      for (const [direction, active] of [['input',this.state.capture],['output',this.state.playback]] as const) {
        if (!active?.running) continue;
        const matches=result.payload.devices.filter(d=>d.direction===direction && d.id===active.deviceId);
        const previous=this.state.devices.find(d=>d.direction===direction && d.id===active.deviceId);
        if (matches.length!==1 || (previous && JSON.stringify(previous.mixFormat)!==JSON.stringify(matches[0].mixFormat))) {
          this.fail('使用中的音频设备已移除或格式变化；两路测试已停止，请重新检测设备'); return;
        }
      }
      this.state.devices = result.payload.devices; this.publish();
    } catch (error) { if(this.child===child && !this.stopping) this.fail(error instanceof Error ? error.message : '设备枚举失败'); }
  }
  private watchDevices(child: ChildProcessWithoutNullStreams) {
    clearTimeout(this.deviceTimer);
    this.deviceTimer=setTimeout(async()=>{
      if(this.child!==child || this.stopping || this.state.status!=='ready') return;
      if(this.state.capture?.running || this.state.playback?.running) await this.refresh();
      if(this.child===child && !this.stopping && this.state.status==='ready') this.watchDevices(child);
    },this.deviceCheckMs);
    this.deviceTimer.unref();
  }
  private endpoint(direction:'input'|'output',id:string) {
    const matches=this.state.devices.filter(d=>d.direction===direction && (id==='default' ? d.isDefault : d.id===id));
    if(matches.length!==1) throw new Error('所选音频设备不可用或默认设备不唯一，请重新检测');
    return matches[0].id;
  }
  async inspect() { if (this.state.status === 'ready') await this.refresh(); else await this.start(); }
  async startCapture(deviceId: string, aecEnabled = false) {
    if (this.state.status !== 'ready' || !this.state.capabilities.capture) return;
    const generation = ++this.captureGeneration;
    clearTimeout(this.captureTimer);
    try {
      await this.refresh();
      if(generation!==this.captureGeneration || this.stopping || this.state.status!=='ready') return;
      deviceId=this.endpoint('input',deviceId);
      if (typeof aecEnabled !== 'boolean') throw new Error('无效回声处理设置');
      if (aecEnabled && !this.state.capabilities.aec) throw new Error('当前引擎未提供 AEC');
      if (this.state.capabilities.aec && !this.state.capabilities.aecControl) throw new Error('旧实验引擎不能确认 AEC 旁路，请重新构建');
      if (this.state.capabilities.aecControl) {
        const configured = await this.request('processing.set', { aecEnabled });
        if (generation !== this.captureGeneration || this.stopping) return;
        if (configured.type !== 'capture.state' || configured.payload.processing?.mode !== (aecEnabled ? 'aec3-experimental' : 'bypass'))
          throw new Error('引擎未确认请求的回声处理模式');
      }
      const packet = await this.request('capture.start', { deviceId });
      if (generation !== this.captureGeneration) return;
      if (packet.type !== 'capture.state') throw new Error('采集启动响应不匹配');
      this.state.capture = packet.payload;
      this.state.detail = '麦克风测试中 · 不保存、不发送音频 · 最多 60 秒'; this.publish();
      this.pollCapture(generation);
    } catch (error) { if(generation===this.captureGeneration && !this.stopping) this.fail(error instanceof Error ? error.message : '采集启动失败'); }
  }
  private pollCapture(generation: number) {
    this.captureTimer = setTimeout(async () => {
      if (generation !== this.captureGeneration || this.stopping) return;
      try {
        const packet = await this.request('capture.status');
        if (generation !== this.captureGeneration) return;
        if (packet.type !== 'capture.state') throw new Error('采集状态响应不匹配');
        if (!packet.payload.running && packet.payload.error) throw new Error('采集设备故障，两路测试已停止：'+packet.payload.error);
        this.state.capture = packet.payload;
        if (!packet.payload.running) this.state.detail = packet.payload.error || (packet.payload.reason === 'time-limit' ? '测试已达到 60 秒，麦克风已关闭' : '麦克风已关闭');
        this.publish();
        if (packet.payload.running) this.pollCapture(generation);
      } catch (error) { if (generation === this.captureGeneration) this.fail(error instanceof Error ? error.message : '采集状态读取失败'); }
    }, 100);
  }
  async stopCapture() {
    const generation = ++this.captureGeneration; clearTimeout(this.captureTimer);
    if (!this.child || this.state.status !== 'ready' || !this.state.capabilities.capture) return;
    try {
      const packet = await this.request('capture.stop');
      if (generation !== this.captureGeneration || this.stopping) return;
      if (packet.type !== 'capture.state') throw new Error('采集停止响应不匹配');
      this.state.capture = packet.payload; this.state.detail = '麦克风已关闭'; this.publish();
    } catch (error) { if (generation === this.captureGeneration && !this.stopping) this.fail(error instanceof Error ? error.message : '无法停止采集'); }
  }
  private rejectAll(message: string) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear();
  }
  async startPlayback(deviceId: string) {
    if (this.state.status !== 'ready' || !this.state.capabilities.playback) return;
    const generation = ++this.playbackGeneration; clearTimeout(this.playbackTimer);
    try {
      await this.refresh();
      if(generation!==this.playbackGeneration || this.stopping || this.state.status!=='ready') return;
      deviceId=this.endpoint('output',deviceId);
      const packet = await this.request('playback.start', { deviceId });
      if (generation !== this.playbackGeneration) return;
      if (packet.type !== 'playback.state') throw new Error('播放响应不匹配');
      this.state.playback = packet.payload; this.publish(); this.pollPlayback(generation);
    } catch (error) { if(generation===this.playbackGeneration && !this.stopping) this.fail(error instanceof Error ? error.message : '播放启动失败'); }
  }
  private pollPlayback(generation: number) {
    this.playbackTimer = setTimeout(async () => {
      if (generation !== this.playbackGeneration || this.stopping) return;
      try {
        const packet = await this.request('playback.status');
        if (generation !== this.playbackGeneration) return;
        if (packet.type !== 'playback.state') throw new Error('播放状态不匹配');
        if (!packet.payload.running && packet.payload.error) throw new Error('播放设备故障，两路测试已停止：'+packet.payload.error);
        this.state.playback = packet.payload; this.publish();
        if (packet.payload.running) this.pollPlayback(generation);
      } catch (error) { if (generation === this.playbackGeneration) this.fail(error instanceof Error ? error.message : '播放状态读取失败'); }
    }, 100);
  }
  async stopPlayback() {
    const generation = ++this.playbackGeneration; clearTimeout(this.playbackTimer);
    if (!this.child || this.state.status !== 'ready' || !this.state.capabilities.playback) return;
    try {
      const packet = await this.request('playback.stop');
      if (generation !== this.playbackGeneration || this.stopping) return;
      if (packet.type !== 'playback.state') throw new Error('播放停止响应不匹配');
      this.state.playback = packet.payload; this.publish();
    } catch (error) { if (generation === this.playbackGeneration && !this.stopping) this.fail(error instanceof Error ? error.message : '播放停止失败'); }
  }
  private fail(detail: string, status: 'error' | 'unavailable' = 'error') {
    clearTimeout(this.deviceTimer); this.refreshing=undefined;
    ++this.playbackGeneration; clearTimeout(this.playbackTimer);
    ++this.captureGeneration; clearTimeout(this.captureTimer);
    const child = this.child; this.child = undefined; child?.kill();
    this.rejectAll(detail); this.state = { ...emptyMediaState(), status, detail }; this.publish();
  }
  async stop() {
    clearTimeout(this.deviceTimer); this.refreshing=undefined;
    ++this.playbackGeneration; clearTimeout(this.playbackTimer);
    ++this.captureGeneration; clearTimeout(this.captureTimer);
    this.stopping = true;
    const child = this.child;
    if (child) {
      try { await this.request('engine.shutdown'); } catch { /* force termination below */ }
      if (this.child === child) { child.kill(); this.child = undefined; }
    }
    this.rejectAll('媒体进程已停止'); this.state = emptyMediaState(); this.publish();
  }
}
