import React, { useEffect, useRef, useState } from 'react';
import { RemoteInputEvent, type RemoteInputEvent as InputEvent, type Snapshot } from '../../../packages/protocol/src/index';
import { Icon } from './Icon';

const names = { dva: 'D.Va', mercy: 'Mercy' } as const;
const elapsed = (startedAt?: number) => {
  const seconds = Math.max(0, Math.floor((Date.now() - (startedAt ?? Date.now())) / 1000));
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

export function RemoteDesktopSurface({ surface, state }: { surface: 'remote-control' | 'remote-status'; state: Snapshot }) {
  const [, tick] = useState(0); const stage = useRef<HTMLDivElement>(null); const remote = state.remote; const native = state.remoteNative;
  const [micMuted, setMicMuted] = useState(false); const [speakerMuted, setSpeakerMuted] = useState(false);
  useEffect(() => { const id = setInterval(() => tick(value => value + 1), 1000); return () => clearInterval(id); }, []);
  useEffect(() => {
    if (surface !== 'remote-control' || !remote || !['connecting', 'active'].includes(remote.phase)) return;
    const element = stage.current; if (!element) return; let scheduled = 0;
    const report = () => { cancelAnimationFrame(scheduled); scheduled = requestAnimationFrame(() => {
      const rect = element.getBoundingClientRect(); const scale = window.devicePixelRatio || 1;
      void window.darling.remoteVideoBounds(remote.sessionId, { x: Math.round(rect.left * scale), y: Math.round(rect.top * scale), width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)) }).catch(() => {});
    }); };
    const observer = new ResizeObserver(report); observer.observe(element); window.addEventListener('resize', report); report();
    return () => { cancelAnimationFrame(scheduled); observer.disconnect(); window.removeEventListener('resize', report); };
  }, [remote?.sessionId, surface]);
  if (!remote || !['connecting', 'active'].includes(remote.phase)) return <div className={`remote-surface ${surface} remote-ended`}><Icon name="desktop"/><h1>远程桌面未能建立</h1><p>{remote?.reason === 'timeout' ? '连接协商超时，请检查两台电脑的远程诊断日志。' : '远程桌面会话已结束。'}</p>{surface === 'remote-control' && <button onClick={() => window.darling.window('close')}>关闭窗口</button>}</div>;
  const end = () => void window.darling.remoteAction('end', remote.sessionId);
  const setAudio = (nextMic: boolean, nextSpeaker: boolean) => void window.darling.remoteAudio(remote.sessionId, nextMic, nextSpeaker).then(() => { setMicMuted(nextMic); setSpeakerMuted(nextSpeaker); }).catch(() => {});
  if (surface === 'remote-status') return <div className="remote-surface remote-status"><span className="remote-live-dot"/><strong>正在被 {names[remote.controller]} 远程连接</strong><time>{elapsed(remote.startedAt)}</time><span className="quality">原生桌面通道</span><button aria-pressed={micMuted} onClick={() => setAudio(!micMuted, speakerMuted)}>{micMuted ? '麦克风已静音' : '麦克风开启'}</button><button aria-pressed={speakerMuted} onClick={() => setAudio(micMuted, !speakerMuted)}>{speakerMuted ? '对方已静音' : '对方声音开启'}</button><button aria-pressed={remote.permissions.control} onClick={() => void window.darling.remotePermissions(remote.sessionId, { ...remote.permissions, control: !remote.permissions.control })}>{remote.permissions.control ? '允许操作' : '仅观看'}</button><button aria-pressed={remote.permissions.audio} onClick={() => void window.darling.remotePermissions(remote.sessionId, { ...remote.permissions, audio: !remote.permissions.audio })}>{remote.permissions.audio ? '远程语音开启' : '远程语音关闭'}</button><button className="remote-end" onClick={end}>断开</button></div>;
  const canControl = !!remote.permissions.control && !!native?.controlReady;
  const sendControl = (event: InputEvent) => { if (canControl) void window.darling.remoteInput(remote.sessionId, event).catch(() => {}); };
  const normalizedPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = stage.current; if (!element) return; const rect = element.getBoundingClientRect();
    const sourceWidth = native?.videoWidth || rect.width, sourceHeight = native?.videoHeight || rect.height;
    const scale = Math.min(rect.width / sourceWidth, rect.height / sourceHeight); const width = sourceWidth * scale, height = sourceHeight * scale;
    const left = rect.left + (rect.width - width) / 2, top = rect.top + (rect.height - height) / 2;
    const x = (event.clientX - left) / width, y = (event.clientY - top) / height; if (x < 0 || x > 1 || y < 0 || y > 1) return; return { x, y };
  };
  const sendPointer = (event: React.PointerEvent<HTMLDivElement>, down?: boolean) => {
    if (!canControl) return; const point = normalizedPointer(event); if (!point) return; sendControl({ type: 'pointer.move', ...point });
    if (down !== undefined && [0, 1, 2].includes(event.button)) sendControl({ type: 'pointer.button', button: (['left', 'middle', 'right'] as const)[event.button], down });
  };
  const detail = native?.connected ? native.videoWidth > 0 ? '原生无光标画面已连接' : '连接成功，正在等待画面' : '正在验证直连与服务器中继';
  return <div className="remote-surface remote-control"><header><div><strong>{names[remote.controlled]} 的桌面</strong><span>{remote.phase === 'active' ? elapsed(remote.startedAt) : detail}</span></div><div><span>连接路径 · 原生 WebRTC</span><span>{native?.connected ? '网络 · 已连接' : '网络 · 检测中'}</span><span>{canControl ? '可操作' : '仅观看'}</span><button aria-pressed={micMuted} onClick={() => setAudio(!micMuted, speakerMuted)}>{micMuted ? '麦克风已静音' : '麦克风开启'}</button><button aria-pressed={speakerMuted} onClick={() => setAudio(micMuted, !speakerMuted)}>{speakerMuted ? '对方已静音' : '对方声音开启'}</button><button className="remote-end" onClick={end}>断开连接</button></div></header><div ref={stage} className={`remote-stage ${canControl ? 'interactive' : ''}`} tabIndex={canControl ? 0 : -1} onPointerMove={event => sendPointer(event)} onPointerDown={event => { event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); sendPointer(event, true); }} onPointerUp={event => { sendPointer(event, false); event.currentTarget.releasePointerCapture(event.pointerId); }} onWheel={event => { if (canControl) { event.preventDefault(); sendControl({ type: 'pointer.wheel', deltaX: Math.max(-1200, Math.min(1200, Math.round(event.deltaX))), deltaY: Math.max(-1200, Math.min(1200, Math.round(event.deltaY))) }); } }} onKeyDown={event => { const value = { type: 'key' as const, code: event.code, down: true }; if (canControl && !event.repeat && RemoteInputEvent.safeParse(value).success) { event.preventDefault(); sendControl(value); } }} onKeyUp={event => { const value = { type: 'key' as const, code: event.code, down: false }; if (canControl && RemoteInputEvent.safeParse(value).success) { event.preventDefault(); sendControl(value); } }} onBlur={() => sendControl({ type: 'release' })} onContextMenu={event => { if (canControl) event.preventDefault(); }}>{!native?.connected && <><Icon name="desktop"/><h1>正在准备原生远程画面</h1><p>{detail}</p></>}</div></div>;
}
