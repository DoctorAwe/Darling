import { useEffect, useState } from 'react';
import { emptyMediaState } from '../../../packages/protocol/src/media';
import { describeOutputRoute, formFactorLabel } from './audio-route';
import { resolveAudioPair } from './audio-pair';
import './audio.css';
import './capture.css';
import { RtcDevicePanel } from './RtcDevicePanel';
export function AudioPanel({ close, voiceBeta = false }: { close: () => void; voiceBeta?: boolean }) {
  const [media, setMedia] = useState(emptyMediaState);
  const [busy, setBusy] = useState(false);
  const [deviceId, setDeviceId] = useState('default');
  const [failure, setFailure] = useState('');
  const [outputId, setOutputId] = useState('default');
  const [rtcRunning, setRtcRunning] = useState(false);
  const mediaRunning = !!(media.capture?.running || media.playback?.running);
  const audioRunning = mediaRunning || rtcRunning;
  const [sessionPair,setSessionPair]=useState<{inputId:string;outputId:string}|null>(null);
  const pair=mediaRunning && sessionPair ? sessionPair : resolveAudioPair(media.devices,deviceId,outputId);
  const pairKey=pair ? JSON.stringify([pair.inputId,pair.outputId]) : '';
  const [preference,setPreference]=useState({key:'',enabled:false,saved:false});
  const preferenceReady=!!pairKey && preference.key===pairKey;
  const aecAvailable=!!(media.capabilities.aec && media.capabilities.aecControl);
  const aecEnabled=preferenceReady && preference.enabled && aecAvailable;
  useEffect(() => {
    let live=true;
    setPreference({key:'',enabled:false,saved:false});
    if (pair && media.status==='ready') {
      void window.darling.audioPreferenceGet(pair).then(value=>{
        if(live) setPreference({key:pairKey,enabled:value.aecEnabled,saved:value.saved});
      }).catch(()=>{
        if(live) { setPreference({key:pairKey,enabled:false,saved:false}); setFailure('无法读取音频偏好，保持 AEC 关闭；原文件不会覆盖'); }
      });
    }
    return ()=>{live=false;};
  },[pairKey,media.status,media.engineVersion]);
  const savePreference=async()=>{
    if(!pair || !preferenceReady) return;
    setBusy(true); setFailure('');
    try { const value=await window.darling.audioPreferenceSet(pair,aecEnabled); setPreference({key:pairKey,enabled:value.aecEnabled,saved:true}); }
    catch { setFailure('保存失败，请确认设备可用并停止测试；原有偏好保持不变'); }
    finally { setBusy(false); }
  };
  const route = describeOutputRoute(media.devices, media.playback?.running ? media.playback.deviceId : outputId);
  useEffect(() => {
    let live = true;
    const off = window.darling.subscribeMedia(value => { if (live) setMedia(value); });
    void window.darling.mediaSnapshot().then(value => { if (live) setMedia(value); });
    return () => { live = false; off(); void window.darling.captureStop(); void window.darling.playbackStop(); };
  }, []);
  const inspect = async () => { setBusy(true); try { setMedia(await window.darling.mediaInspect()); } finally { setBusy(false); } };
  const capture = async () => {
    if (rtcRunning) return;
    setBusy(true); setFailure('');
    if(!media.capture?.running && pair) setSessionPair(pair);
    try { setMedia(media.capture?.running ? await window.darling.captureStop() : await window.darling.captureStart(pair?.inputId ?? deviceId, aecEnabled)); }
    catch { setFailure('无法操作麦克风，请重新检测设备'); }
    finally { setBusy(false); }
  };
  const playback = async () => {
    if (rtcRunning) return;
    setBusy(true); setFailure('');
    if(!media.playback?.running && pair) setSessionPair(pair);
    try { setMedia(media.playback?.running ? await window.darling.playbackStop() : await window.darling.playbackStart(pair?.outputId ?? outputId)); }
    catch { setFailure('无法操作输出设备，请重新检测'); }
    finally { setBusy(false); }
  };
  return <section className="audio-panel" aria-label="音频设备检查">
    <div className="audio-heading"><div><span className="eyebrow">NATIVE AUDIO</span><h2>音频设备</h2></div><button onClick={close} aria-label="关闭音频设备面板">×</button></div>
    <p className="audio-detail">{media.detail}</p>
    <button className="inspect-button" disabled={busy || audioRunning} onClick={() => void inspect()}>{busy ? '检测中…' : '检测 / 刷新设备'}</button>
    <p className="audio-note">检测设备不会开启麦克风。点击“开始麦克风测试”后采集电平，最多 60 秒；不保存、不发送音频。关闭面板停止采集。</p>
    {media.capabilities.capture && <div className="capture-controls">
      <label htmlFor="input-device">测试输入设备</label>
      <select id="input-device" value={deviceId} disabled={busy || audioRunning} onChange={e => setDeviceId(e.target.value)}><option value="default">跟随系统默认</option>{media.devices.filter(d => d.direction === 'input').map(d => <option value={d.id} key={d.id}>{d.name}</option>)}</select>
      <label htmlFor="aec-mode">下次麦克风测试的回声处理</label>
      <select id="aec-mode" value={aecEnabled ? 'on' : 'off'} disabled={busy || audioRunning || !preferenceReady} onChange={e => setPreference({key:pairKey,enabled:e.target.value==='on',saved:false})}>
        <option value="off">关闭 AEC · 保真人声（无回声耳机路径）</option>
        <option value="on" disabled={!media.capabilities.aec || !media.capabilities.aecControl}>开启实验 AEC · 尚未完成音质验收</option>
      </select>
      <button className="inspect-button" disabled={busy || audioRunning || !preferenceReady} onClick={()=>void savePreference()}>记住此输入／输出设备对</button>
      <p className="audio-note">{!pair ? '请刷新设备，确认输入和输出均可用。' : !preferenceReady ? '正在读取此设备对的偏好…' : preference.saved ? '已读取或保存此设备对的偏好。' : '本次选择尚未保存；新设备默认关闭。'}{preference.enabled && !aecAvailable ? '当前引擎不支持开启 AEC，实际保持关闭；不会自动覆盖保存值。' : ''}<br/>不是按耳机名称自动判断。外放、漏音和声卡回送可能产生回声。停止两路测试后才能切换。系统默认按最近检测的实际端点匹配，启动测试固定到该端点；系统切换后请刷新。不影响独立降噪设置（尚未接入）。</p>
      <button className="inspect-button" disabled={busy || (!media.capture?.running && (!!media.playback?.running || !preferenceReady))} onClick={() => void capture()}>{media.capture?.running ? '停止麦克风测试' : '开始麦克风测试'}</button>
      <meter aria-label="麦克风峰值电平" min={0} max={1} value={media.capture?.peak ?? 0}/>
      {failure && <p role="alert">{failure}</p>}
      {media.capture?.format && <p className="audio-note">实际采集：{media.capture.format.sampleRate / 1000} kHz · {media.capture.format.channels} 声道 · {media.capture.format.encoding}<br/>已处理 {media.capture.frames} 帧 · 中断标记 {media.capture.discontinuities}<br/>系统共享模式；RAW 和降噪未启用。{media.capture.error}</p>}
    </div>}
    {media.capture?.processing && <p className="audio-note">处理接口：48 kHz 单声道 / 10 ms<br/>采集块 {media.capture.processing.captureBlocks} · 已读播放参考 {media.capture.processing.referenceBlocks}<br/>{media.capture.processing.mode === 'aec3-experimental' ? '实验 AEC3 已接入；实际声学效果未验收，每轮播放需重新开始采集。' : '直通模式，尚未消除回声。'}</p>}
    {media.capabilities.playback && <div className="capture-controls">
      <label htmlFor="output-device">测试输出设备</label>
      <select id="output-device" value={outputId} disabled={busy || audioRunning} onChange={e => setOutputId(e.target.value)}><option value="default">系统默认输出</option>{media.devices.filter(d => d.direction === 'output').map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
      <button className="inspect-button" disabled={busy} onClick={() => void playback()}>{media.playback?.running ? '停止测试音' : '播放 1 秒测试音'}</button>
      <p className="audio-note">播放低幅度 440 Hz 提示音。不会自动开启麦克风；同时开启麦克风测试可检查参考链。</p>
      <p className="audio-note"><strong>{route.title}</strong><br/>{route.detail}</p>
      <p className="audio-note">类型来自 Windows 驱动，可能不准确。尚未识别蓝牙传输模式或输入/输出是否同一硬件；经典蓝牙耳机开启麦克风时可能切换通话模式，48 kHz 处理格式不代表原始收音带宽。</p>
      {media.playback && <p className="audio-note">{media.playback.error || (media.playback.running ? '正在播放' : '播放已停止')} · 已提交 {media.playback.frames} 帧<br/>参考块 {media.playback.referenceBlocks} · 队列丢弃 {media.playback.droppedReferences}</p>}
    </div>}
    {(['input', 'output'] as const).map(direction => <div className="device-group" key={direction}><h3>{direction === 'input' ? '输入 · 麦克风' : '输出 · 扬声器'}</h3>{media.devices.filter(device => device.direction === direction).map(device => <div className="device" key={device.id}><strong>{device.name}</strong>{device.isDefault && <span className="default-tag">默认</span>}<p>{formFactorLabel[device.formFactor]} · {device.mixFormat ? `${device.mixFormat.sampleRate / 1000} kHz · ${device.mixFormat.channels} 声道 · ${device.mixFormat.containerBits} bit 容器` : '格式暂不可用'}</p></div>)}</div>)}
    <RtcDevicePanel voiceBeta={voiceBeta} pair={pair} names={pair ? `输入：${media.devices.find(d => d.id === pair.inputId)?.name ?? pair.inputId}；输出：${media.devices.find(d => d.id === pair.outputId)?.name ?? pair.outputId}` : ''} blocked={busy || mediaRunning || media.status !== 'ready'} onActive={setRtcRunning}/>
    <div className="audio-note">RTC 设备测试独立于上方旧媒体引擎；生产语音通话尚未开放。</div>
  </section>;
}
