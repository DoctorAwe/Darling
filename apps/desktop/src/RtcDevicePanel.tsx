import { useEffect, useState } from 'react';
import type { RtcDeviceTestState } from '../../../packages/protocol/src/index';
export function RtcDevicePanel({ pair, names, blocked, onActive, voiceBeta = false }: {
  pair: { inputId: string; outputId: string } | null; names: string; blocked: boolean; onActive: (active: boolean) => void; voiceBeta?: boolean;
}) {
  const [state, setState] = useState<RtcDeviceTestState>({ available: false, status: 'idle', detail: '读取测试状态…' });
  const [confirmed, setConfirmed] = useState(false);
  const [profile, setProfile] = useState<'headphones' | 'speakers'>('headphones');
  const [ns, setNs] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = state.status !== 'idle' || busy;
  const metrics = state.inputMetrics;
  const db = (value: number | null) => value === null ? '暂无' : value === 0 ? '静音' : `${(20 * Math.log10(value)).toFixed(1)} dBFS`;
  useEffect(() => { setConfirmed(false); }, [pair?.inputId, pair?.outputId, profile, ns]);
  useEffect(() => { onActive(active); }, [active, onActive]);
  useEffect(() => {
    let live = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await window.darling.rtcDeviceSnapshot(); if (live) setState(value); }
      catch { if (live) setError('无法读取 RTC 测试状态，请停止测试'); }
      if (live) timer = setTimeout(() => void poll(), 500);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); void window.darling.rtcDeviceStop().catch(() => {}); };
  }, []);
  const start = async () => {
    if (!pair || !confirmed) return;
    setBusy(true); setError(''); setConfirmed(false);
    try {
      await window.darling.rtcDeviceStart({ confirmed: true, inputDeviceId: pair.inputId, outputDeviceId: pair.outputId, outputProfile: profile, noiseSuppression: ns });
      setState(await window.darling.rtcDeviceSnapshot());
    } catch { setError('启动失败：请检测设备、停止其他测试，并确认原生引擎配置'); }
    finally { setBusy(false); }
  };
  return <div className="capture-controls">
    <h3>RTC 真实设备测试 · 最多 15 秒</h3>
    <p className="audio-note">{names || '请先检测并选择输入、输出设备。'}<br/>将开启麦克风，并在所选输出播放连续 1200 Hz 测试音。请先调低系统音量。麦克风经本机 Opus 链路送至内存接收端，不回放自己、不保存文件、不上传服务器。此测试不是音质或回声消除验收。</p>
    <label>输出使用方式<select value={profile} disabled={active} onChange={e => setProfile(e.target.value as typeof profile)}><option value="headphones">耳机 · AEC3 开启</option><option value="speakers">扬声器 · AEC3 开启</option></select></label>
    <label><input type="checkbox" checked={ns} disabled={active} onChange={e => setNs(e.target.checked)}/>启用 RNNoise 降噪（效果未验收）</label>
    <label><input type="checkbox" checked={confirmed} disabled={active || blocked || !pair} onChange={e => setConfirmed(e.target.checked)}/>我已确认以上设备，允许本次录音和测试音播放</label>
    <button disabled={!state.available || !confirmed || !pair || blocked || active} onClick={() => void start()}>开始 15 秒 RTC 设备测试</button>
    <button onClick={() => { setConfirmed(false); void window.darling.rtcDeviceStop().catch(() => setError('停止请求失败，请关闭应用')); }}>立即停止 RTC 测试</button>
    {voiceBeta && <p className="audio-note">实际通话自动使用 Windows 系统默认输入和输出，耳机与扬声器均启用 WebRTC AEC3 回声消除和 RNNoise 降噪。无需在此配置；上方选项仅标记独立设备测试的输出类型，不关闭 AEC。</p>}
    <p role="status">{state.detail}</p>{error && <p role="alert">{error}</p>}
    <div className="audio-note" aria-label="RTC 麦克风输入链路统计">
      <strong>{state.status === 'idle' ? '上次测试最后一次采样' : '麦克风输入链路 · 每秒更新'}</strong>
      {metrics ? <>
        <p>麦克风发送：{metrics.sentPackets ?? '暂无'} 包 · 本机对端接收：{metrics.receivedPackets ?? '暂无'} 包<br/>
          接收样本（含补偿）：{metrics.receivedSamples ?? '暂无'} · 补偿样本：{metrics.concealedSamples ?? '暂无'}</p>
        <meter aria-label="对端解码峰值" min={0} max={1} value={metrics.decodedPeak ?? 0}/>
        <p>对端解码 RMS：{db(metrics.decodedRms)} · 峰值：{db(metrics.decodedPeak)}<br/>
          本次最大峰值：{db(metrics.maximumPeak)} · 采样时间：{new Date(metrics.sampledAt).toLocaleTimeString()}</p>
      </> : <p>尚无统计。开始测试后请正常讲话，并观察接收包数与对端解码电平。</p>}
      <p>包数增加只证明有数据，静音也会产生数据包。电平来自本机对端解码输出，不是测试音发送端；底噪、漏音和丢包补偿也可能产生电平，不自动判定人声、AEC 或降噪合格。停止后保留最后一次采样，不再更新。</p>
    </div>
  </div>;
}
