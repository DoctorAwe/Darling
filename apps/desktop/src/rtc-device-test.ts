import { randomUUID } from 'node:crypto';
import { DeviceAudio, RtcProcessHost } from './rtc-process';
import type { RtcDeviceTestState, RtcSignal } from '../../../packages/protocol/src/index';
import { rtcInputMetrics } from './rtc-input-metrics';
type Host = Pick<RtcProcessHost, 'start' | 'apply' | 'stop' | 'diagnosticStats'> & { on(event: string, listener: (...args: any[]) => void): unknown };

// Local peer only: microphone goes to a synthetic receiver, never back to speakers.
export class RtcDeviceTest {
  state: RtcDeviceTestState;
  private hosts?: Host[];
  private timer?: ReturnType<typeof setTimeout>;
  private stopping?: Promise<void>;
  private statsTimer?: ReturnType<typeof setTimeout>;
  constructor(private executable?: string, private create: (...args: ConstructorParameters<typeof RtcProcessHost>) => Host = (...args) => new RtcProcessHost(...args)) {
    this.state = { available: !!executable, status: 'idle', detail: executable ? '尚未开始' : '未配置 RTC 设备测试引擎' };
  }
  get active() { return !!this.hosts || !!this.stopping; }
  async start(value: unknown) {
    if (!this.executable || this.active) throw new Error('设备测试不可用或尚未停止');
    const audio = DeviceAudio.parse(value);
    const scope = { callId: randomUUID(), generation: 1 as const };
    const real = this.create(this.executable, scope, 'caller', ['--wasapi-audio'], 10000, 'direct', undefined, audio);
    const synthetic = this.create(this.executable, scope, 'callee', ['--synthetic-audio'], 10000, 'direct');
    const hosts = this.hosts = [real, synthetic];
    this.state = { available: true, status: 'starting', detail: '正在打开已确认的设备；最多 15 秒' };
    const fail = () => { if (this.hosts === hosts) void this.stop('设备或连接异常，请重新检测设备'); };
    for (const [from, to] of [[real, synthetic], [synthetic, real]]) {
      from.on('fault', fail); from.on('device-timeout', fail);
      from.on('signal', (signal: RtcSignal) => { if (this.hosts === hosts) void to.apply(signal).catch(fail); });
    }
    real.on('connection', state => {
      if (this.hosts !== hosts) return;
      if (state === 'connected') this.state = { ...this.state, status: 'running', detail: '本机 RTC 已连接；请讲话并观察对端接收量及电平（不代表音质通过）' };
      if (state === 'failed' || state === 'disconnected') fail();
    });
    this.timer = setTimeout(() => { void this.stop('15 秒测试结束'); }, 15000);
    const sample = async () => {
      if (this.hosts !== hosts) return;
      try {
        const [sent, received] = await Promise.all([real.diagnosticStats(), synthetic.diagnosticStats()]);
        if (this.hosts === hosts) this.state = { ...this.state, inputMetrics: rtcInputMetrics(sent, received) };
      } catch { fail(); }
      if (this.hosts === hosts) this.statsTimer = setTimeout(() => void sample(), 1000);
    };
    try {
      await synthetic.start();
      if (this.hosts === hosts) { await real.start(); if (this.hosts === hosts) this.statsTimer = setTimeout(() => void sample(), 1000); }
    }
    catch { fail(); }
  }
  stop(detail = '测试已停止'): Promise<void> {
    if (this.stopping) return this.stopping;
    clearTimeout(this.timer);
    clearTimeout(this.statsTimer);
    const hosts = this.hosts; this.hosts = undefined;
    if (!hosts) return Promise.resolve();
    this.state = { ...this.state, status: 'stopping', detail: '正在关闭设备…' };
    this.stopping = Promise.all(hosts.map(host => host.stop())).then(results => {
      this.state = { ...this.state, status: 'idle', detail: results.includes('forced') ? `${detail}；原生进程被强制终止` : detail };
    }).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
}
