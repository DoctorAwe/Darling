import type { Snapshot, RtcSignal } from '../../../packages/protocol/src/index';
import type { Session } from './session';
import { RtcProcessHost, type DeviceAudio } from './rtc-process';

// Diagnostic opt-in only. It does not change Session's invite/accept gate.
export class RtcNegotiation {
  private host?: RtcProcessHost;
  private timer?: ReturnType<typeof setTimeout>;
  private attempted?: string;
  private levelTimer?: ReturnType<typeof setTimeout>;
  constructor(private session: Session, private executable: string, private iceMode: 'disabled' | 'direct' | 'relay' = 'disabled', private devices?: () => DeviceAudio | undefined, private createHost = (...args: ConstructorParameters<typeof RtcProcessHost>) => new RtcProcessHost(...args), private aec3Experimental = false) {
    session.on('state', this.state);
    session.on('rtc.signal', this.signal);
    session.on('rtc.closed', this.closed);
    this.state(session.state);
  }
  private state = (state: Snapshot) => {
    const call = state.call;
    if (state.status !== 'online' || !state.user || !call || !['connecting', 'active'].includes(call.phase) || (call.phase !== 'active' && call.deadline <= Date.now())) { this.stop(); return; }
    if (this.host?.scope.callId === call.callId) {
      clearTimeout(this.timer); const host = this.host;
      this.timer = call.phase === 'active' ? undefined : setTimeout(() => this.failed(host), Math.max(1, call.deadline - Date.now())); return;
    }
    if (this.attempted === call.callId) return;
    this.stop(); this.attempted = call.callId;
    const audio = this.devices?.();
    if (this.devices && !audio) { this.session.callAction('end', call.callId); return; }
    const host = this.host = this.createHost(this.executable, { callId: call.callId, generation: 1 }, state.user === call.caller ? 'caller' : 'callee', audio ? ['--wasapi-audio', ...(this.aec3Experimental ? ['--aec3-experimental'] : [])] : [], 15000, this.iceMode, this.iceMode === 'relay' ? this.session.getIceConfig() : undefined, audio, audio ? 0 : 60000);
    let outgoing = Promise.resolve();
    let readySent = false;
    const sample = async () => {
      if (this.host !== host) return;
      let level: number | null = null;
      try {
        const stats = await host.diagnosticStats();
        const inbound = stats.find(s => s.type === 'inbound-rtp' && s.codec === 'audio/opus');
        if (typeof inbound?.audioLevel === 'number' && Number.isFinite(inbound.audioLevel)) level = Math.max(0, Math.min(1, inbound.audioLevel));
      } catch { /* Meter failure does not end a call. */ }
      if (this.host === host) { this.session.remoteLevel(level); this.levelTimer = setTimeout(() => void sample(), 250); }
    };
    host.on('connection', (connection: string) => {
      if (this.host !== host || !audio) return;
      if (connection === 'connected' && !readySent) {
        readySent = true;
        void sample();
        void outgoing.then(() => { if (this.host === host) { this.session.mediaReady(call.callId); this.session.voiceStatus('TURN 中继音频已连接 · 测试版'); } }).catch(() => this.failed(host));
      }
      if (connection === 'failed' || connection === 'disconnected') this.failed(host);
    });
    host.on('signal', (signal: RtcSignal) => {
      if (this.host !== host) return;
      outgoing = outgoing.then(async () => { if (this.host === host) await this.session.sendRtcSignal(signal); }).catch(() => this.failed(host));
    });
    host.on('fault', () => this.failed(host));
    if (call.phase !== 'active') this.timer = setTimeout(() => this.failed(host), Math.max(1, call.deadline - Date.now()));
    void this.cleanup.then(() => { if (this.host === host) return host.start(); }).catch(() => this.failed(host));
  };
  private signal = (signal: RtcSignal) => {
    const host = this.host;
    if (!host || host.scope.callId !== signal.callId) return;
    void host.apply(signal).catch(() => this.failed(host));
  };
  private closed = (scope: { callId: string }) => { if (this.host?.scope.callId === scope.callId) this.stop(); };
  private failed(host: RtcProcessHost) {
    if (this.host !== host) return;
    this.stop(); this.session.callAction('end', host.scope.callId);
    if (this.devices) this.session.voiceStatus('音频连接失败或设备异常，已停止；请检查设备和网络');
  }
  private cleanup: Promise<unknown> = Promise.resolve();
  async setAudio(callId: string, micMuted: boolean, speakerMuted: boolean) {
    const host = this.host;
    if (!host || host.scope.callId !== callId || this.session.state.call?.phase !== 'active') throw new Error('通话已结束');
    await host.setAudio(micMuted, speakerMuted);
    if (this.host !== host) throw new Error('通话已结束');
  }
  stop() {
    clearTimeout(this.levelTimer); this.levelTimer = undefined;
    clearTimeout(this.timer); this.timer = undefined;
    const host = this.host; this.host = undefined;
    if (host) this.cleanup = Promise.all([this.cleanup, host.stop()]);
    return this.cleanup;
  }
  dispose() {
    const stopped = this.stop();
    this.session.off('state', this.state); this.session.off('rtc.signal', this.signal); this.session.off('rtc.closed', this.closed);
    return stopped;
  }
}
