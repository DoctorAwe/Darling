import type { RemoteInputEvent as InputEvent, RemoteSignal, Snapshot } from '../../../packages/protocol/src/index';
import { RemoteInputEvent } from '../../../packages/protocol/src/index';
import type { Session } from './session';
import { RtcProcessHost, type DeviceAudio } from './rtc-process';

type VideoWindow = { parent: bigint; x: number; y: number; width: number; height: number };

export class RemoteRtcNegotiation {
  private host?: RtcProcessHost;
  private attempted?: string;
  private starting = false;
  private pending: RemoteSignal[] = [];
  private cleanup: Promise<unknown> = Promise.resolve();
  private videoWindow?: VideoWindow;
  private videoAttached = false;
  private nativeStatus = { connected: false, controlReady: false, videoWidth: 0, videoHeight: 0 };
  constructor(private session: Session, private executable: string, private input: (event: InputEvent) => Promise<void>, private devices: () => DeviceAudio | undefined, private aec3 = true, private diagnostic?: (value: object) => void) {
    session.on('state', this.state);
    session.on('remote.signal', this.signal);
    this.state(session.state);
  }
  private state = (state: Snapshot) => {
    const remote = state.remote;
    if (state.status !== 'online' || !state.user || !remote || !['connecting', 'active'].includes(remote.phase)) {
      this.stop();
      if (!remote || remote.phase === 'ended') this.attempted = undefined;
      return;
    }
    if (this.host?.scope.callId === remote.sessionId) { void this.host.setAudio(!remote.permissions.audio, !remote.permissions.audio).catch(() => {}); return; }
    if (this.starting || this.attempted === remote.sessionId) return;
    this.attempted = remote.sessionId;
    this.starting = true;
    void this.begin(state, remote.sessionId).finally(() => { this.starting = false; });
  };
  private async begin(state: Snapshot, sessionId: string) {
    try {
      await this.cleanup;
      if (!this.session.getIceConfig()) await this.session.refreshIce();
      const current = this.session.state.remote;
      if (!current || current.sessionId !== sessionId || !state.user || !['connecting', 'active'].includes(current.phase)) return;
      const controller = current.controller === state.user;
      const audio = this.devices(); if (!audio) throw new Error('Remote audio devices unavailable');
      const args = ['--control-data', '--wasapi-audio', ...(this.aec3 ? ['--aec3-experimental'] : []), ...(controller ? [] : ['--desktop-video'])];
      const host = this.host = new RtcProcessHost(this.executable, { callId: sessionId, generation: 1 }, controller ? 'caller' : 'callee', args, 15000, 'all', this.session.getIceConfig(), audio, 0);
      let outgoing = Promise.resolve();
      let ready = false;
      host.on('signal', value => {
        if (this.host !== host) return;
        const signal = value.kind === 'ice'
          ? { sessionId, generation: 1 as const, kind: 'ice' as const, candidate: value.candidate, sdpMid: value.sdpMid, sdpMLineIndex: value.sdpMLineIndex }
          : { sessionId, generation: 1 as const, kind: value.kind, sdp: value.sdp };
        outgoing = outgoing.then(() => { if (this.host === host) this.session.sendRemoteSignal(signal); }).catch(() => this.failed(host, 'signal'));
      });
      host.on('connection', value => {
        if (this.host !== host) return;
        this.updateStatus({ connected: value === 'connected' });
        if (value === 'connected' && !ready) {
          ready = true;
          void host.setAudio(!current.permissions.audio, !current.permissions.audio).catch(() => this.failed(host, 'audio-policy'));
          this.session.remoteReady(sessionId);
          if (controller) void this.attachVideo(host);
        }
        if (value === 'failed' || value === 'disconnected') this.failed(host, value);
      });
      host.on('data-state', value => { if (this.host === host) this.updateStatus({ controlReady: value === 'open' }); });
      host.on('data', message => {
        if (this.host !== host || controller) return;
        try { void this.input(RemoteInputEvent.parse(JSON.parse(message))).catch(() => this.failed(host, 'input')); }
        catch { this.failed(host, 'invalid-input'); }
      });
      host.on('video-stats', value => {
        if (this.host === host && value.width > 0 && value.height > 0) this.updateStatus({ videoWidth: value.width, videoHeight: value.height });
        this.diagnostic?.({ at: new Date().toISOString(), sessionId, role: controller ? 'controller' : 'controlled', videoFrames: value.frames, videoAttached: value.attached });
        if (controller && value.frames > 0 && !this.videoAttached) void this.attachVideo(host).catch(() => this.failed(host, 'video-attach'));
      });
      host.on('fault', reason => this.failed(host, String(reason)));
      await host.start();
      for (const signal of this.pending.splice(0).filter(value => value.sessionId === sessionId)) await this.apply(host, signal);
    } catch { if (this.host) this.failed(this.host, 'startup'); else this.session.remoteAction('end', sessionId); }
  }
  private signal = (signal: RemoteSignal) => {
    const host = this.host;
    if (!host || host.scope.callId !== signal.sessionId) { this.pending.push(signal); if (this.pending.length > 128) this.pending.shift(); return; }
    void this.apply(host, signal).catch(() => this.failed(host, 'description'));
  };
  private apply(host: RtcProcessHost, signal: RemoteSignal) {
    return host.apply(signal.kind === 'ice'
      ? { callId: signal.sessionId, generation: 1 as const, kind: 'ice' as const, candidate: signal.candidate, sdpMid: signal.sdpMid ?? '0', sdpMLineIndex: signal.sdpMLineIndex ?? 0 }
      : { callId: signal.sessionId, generation: 1 as const, kind: signal.kind, sdp: signal.sdp });
  }
  async sendControl(sessionId: string, event: InputEvent) {
    const host = this.host;
    const remote = this.session.state.remote;
    if (!host || host.scope.callId !== sessionId || remote?.sessionId !== sessionId || remote.controller !== this.session.state.user || !remote.permissions.control || !['connecting', 'active'].includes(remote.phase)) throw new Error('当前未授权远程操作');
    await host.sendData(JSON.stringify(RemoteInputEvent.parse(event)));
  }
  async setAudio(sessionId: string, micMuted: boolean, speakerMuted: boolean) {
    const host = this.host;
    if (!host || host.scope.callId !== sessionId || this.session.state.remote?.sessionId !== sessionId) throw new Error('远程语音不可用');
    await host.setAudio(micMuted, speakerMuted);
  }
  async setVideoWindow(sessionId: string, window: VideoWindow) {
    const remote = this.session.state.remote;
    if (remote?.sessionId !== sessionId || remote.controller !== this.session.state.user || !['connecting', 'active'].includes(remote.phase)) throw new Error('远程画面不可用');
    this.videoWindow = window;
    const host = this.host;
    if (host?.scope.callId === sessionId && this.videoAttached) await this.attachVideo(host);
  }
  private async attachVideo(host: RtcProcessHost) {
    const value = this.videoWindow;
    if (!value || this.host !== host) return;
    const bounds = { x: value.x, y: value.y, width: value.width, height: value.height };
    if (this.videoAttached) await host.resizeVideo(value.parent, bounds);
    else { await host.attachVideo(value.parent, bounds); this.videoAttached = true; }
  }
  private failed(host: RtcProcessHost, reason: string) {
    if (this.host !== host) return;
    this.diagnostic?.({ at: new Date().toISOString(), sessionId: host.scope.callId, stage: 'native-failed', detail: reason });
    this.stop();
    this.session.remoteAction('end', host.scope.callId);
  }
  private updateStatus(value: Partial<typeof this.nativeStatus>) {
    const next = { ...this.nativeStatus, ...value };
    if (JSON.stringify(next) === JSON.stringify(this.nativeStatus)) return;
    this.nativeStatus = next;
    this.session.remoteNativeStatus(next);
  }
  stop() {
    const host = this.host; this.host = undefined; this.pending = []; this.videoAttached = false;
    this.nativeStatus = { connected: false, controlReady: false, videoWidth: 0, videoHeight: 0 };
    if (this.session.state.remoteNative) this.session.remoteNativeStatus(undefined);
    if (host) this.cleanup = Promise.all([this.cleanup, host.stop()]);
    return this.cleanup;
  }
  dispose() {
    const stopped = this.stop();
    this.session.off('state', this.state); this.session.off('remote.signal', this.signal);
    return stopped;
  }
}
