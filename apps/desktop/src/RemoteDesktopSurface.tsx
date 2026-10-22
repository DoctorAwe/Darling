import React, { useEffect, useRef, useState } from 'react';
import type { RemoteSessionState, RemoteSignal, Snapshot } from '../../../packages/protocol/src/index';
import { Icon } from './Icon';

const names = { dva: 'D.Va', mercy: 'Mercy' } as const;
const elapsed = (startedAt?: number) => {
  const seconds = Math.max(0, Math.floor((Date.now() - (startedAt ?? Date.now())) / 1000));
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
type Telemetry = { route: 'checking' | 'direct' | 'relay'; quality: '检测中' | '优秀' | '良好' | '较差'; rttMs?: number; loss?: number };

function useRemoteMedia(remote: RemoteSessionState | null | undefined, role: 'controller' | 'controlled') {
  const streamRef = useRef<MediaStream | undefined>(undefined); const [stream, setStream] = useState<MediaStream | undefined>(undefined);
  const [detail, setDetail] = useState('正在建立媒体通道'); const [telemetry, setTelemetry] = useState<Telemetry>({ route: 'checking', quality: '检测中' });
  useEffect(() => {
    if (!remote || !['connecting', 'active'].includes(remote.phase)) return;
    let disposed = false; let chain = Promise.resolve(); let unsubscribe: (() => void) | undefined; let statsTimer: ReturnType<typeof setInterval> | undefined;
    const earlyIce: RTCIceCandidateInit[] = []; const signalKeys = new Set<string>(); let readySent = false;
    const send = (value: RemoteSignal) => window.darling.remoteSignal(value);
    const start = async () => {
      const ice = await window.darling.remoteIceConfig(); if (disposed) return;
      const pc = new RTCPeerConnection({ iceServers: ice.iceServers, iceTransportPolicy: 'all', bundlePolicy: 'max-bundle' });
      const applySignal = async (value: RemoteSignal) => {
        if (disposed || value.sessionId !== remote.sessionId) return;
        const key = JSON.stringify(value); if (signalKeys.has(key)) return; signalKeys.add(key);
        if (value.kind === 'ice') {
          const candidate = { candidate: value.candidate, sdpMid: value.sdpMid, sdpMLineIndex: value.sdpMLineIndex };
          if (!pc.remoteDescription) earlyIce.push(candidate); else await pc.addIceCandidate(candidate); return;
        }
        await pc.setRemoteDescription({ type: value.kind, sdp: value.sdp });
        if (value.kind === 'offer') {
          const capture = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 60, max: 60 } }, audio: remote.permissions.audio });
          if (disposed) { capture.getTracks().forEach(track => track.stop()); return; }
          streamRef.current = capture;
          for (const track of capture.getTracks()) {
            if (track.kind === 'video') track.contentHint = 'detail';
            const sender = pc.addTrack(track, capture);
            if (track.kind === 'video') {
              const parameters = sender.getParameters(); parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
              parameters.encodings[0].maxBitrate = 16_000_000; parameters.encodings[0].maxFramerate = 60; await sender.setParameters(parameters);
            }
          }
          capture.getVideoTracks()[0]?.addEventListener('ended', () => { if (!disposed) void window.darling.remoteAction('end', remote.sessionId); });
          const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
          await send({ sessionId: remote.sessionId, generation: 1, kind: 'answer', sdp: answer.sdp! });
        }
        for (const candidate of earlyIce.splice(0)) await pc.addIceCandidate(candidate);
      };
      const enqueue = (value: RemoteSignal) => { chain = chain.then(() => applySignal(value)).catch(() => setDetail('媒体协商失败')); };
      pc.onicecandidate = event => { if (event.candidate) void send({ sessionId: remote.sessionId, generation: 1, kind: 'ice', candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid, sdpMLineIndex: event.candidate.sdpMLineIndex }); };
      pc.ontrack = event => { const received = event.streams[0] ?? new MediaStream([event.track]); streamRef.current = received; setStream(received); };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') { setDetail('远程画面已连接'); if (!readySent) { readySent = true; void window.darling.remoteReady(remote.sessionId); } }
        else if (pc.connectionState === 'failed') { setDetail('连接失败'); void window.darling.remoteAction('end', remote.sessionId); }
        else if (pc.connectionState === 'disconnected') setDetail('网络中断，正在恢复');
      };
      if (role === 'controller') {
        const video = pc.addTransceiver('video', { direction: 'recvonly' }); pc.addTransceiver('audio', { direction: 'recvonly' });
        const capabilities = RTCRtpReceiver.getCapabilities('video');
        if (capabilities) video.setCodecPreferences([...capabilities.codecs].sort((a, b) => Number(b.mimeType.toLowerCase() === 'video/h264') - Number(a.mimeType.toLowerCase() === 'video/h264')));
        pc.createDataChannel('control', { ordered: true }); const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
        await send({ sessionId: remote.sessionId, generation: 1, kind: 'offer', sdp: offer.sdp! });
      } else pc.ondatachannel = event => { if (event.channel.label === 'control') event.channel.onmessage = () => {}; };
      unsubscribe = window.darling.subscribeRemoteSignal(enqueue);
      for (const value of await window.darling.remoteDrainSignals(remote.sessionId)) enqueue(value);
      statsTimer = setInterval(async () => {
        if (pc.connectionState !== 'connected') return;
        const stats = await pc.getStats(); let pair: Record<string, any> | undefined; let inbound: Record<string, any> | undefined; const byId = new Map<string, Record<string, any>>();
        stats.forEach(report => { const value = report as unknown as Record<string, any>; byId.set(String(value.id), value); if (value.type === 'candidate-pair' && value.state === 'succeeded' && (value.selected || value.nominated)) pair = value; if (value.type === 'inbound-rtp' && value.kind === 'video') inbound = value; });
        let route: Telemetry['route'] = 'checking'; let rttMs: number | undefined;
        if (pair) { const local = byId.get(pair.localCandidateId); const peer = byId.get(pair.remoteCandidateId); route = local?.candidateType === 'relay' || peer?.candidateType === 'relay' ? 'relay' : 'direct'; rttMs = Number.isFinite(pair.currentRoundTripTime) ? Math.round(pair.currentRoundTripTime * 1000) : undefined; }
        const lost = inbound?.packetsLost ?? 0; const received = inbound?.packetsReceived ?? 0; const loss = lost + received > 0 ? lost / (lost + received) : 0;
        const quality: Telemetry['quality'] = (rttMs ?? 0) > 180 || loss > .04 ? '较差' : (rttMs ?? 0) > 80 || loss > .015 ? '良好' : '优秀';
        setTelemetry({ route, quality, rttMs, loss });
        if (role === 'controlled') for (const sender of pc.getSenders()) if (sender.track?.kind === 'video') {
          const parameters = sender.getParameters(); parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}]; parameters.encodings[0].maxBitrate = route === 'direct' ? 28_000_000 : 16_000_000; await sender.setParameters(parameters).catch(() => {});
        }
      }, 2000);
      return pc;
    };
    let pc: RTCPeerConnection | undefined; void start().then(value => { pc = value; }).catch(() => setDetail('无法启动远程媒体'));
    return () => { disposed = true; unsubscribe?.(); clearInterval(statsTimer); pc?.close(); streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = undefined; setStream(undefined); };
  }, [remote?.sessionId, role]);
  useEffect(() => { for (const track of streamRef.current?.getAudioTracks() ?? []) track.enabled = !!remote?.permissions.audio; }, [remote?.permissions.audio]);
  return { stream, detail, telemetry };
}

export function RemoteDesktopSurface({ surface, state }: { surface: 'remote-control' | 'remote-status'; state: Snapshot }) {
  const [, tick] = useState(0); const video = useRef<HTMLVideoElement>(null); const remote = state.remote; const media = useRemoteMedia(remote, surface === 'remote-control' ? 'controller' : 'controlled');
  useEffect(() => { const id = setInterval(() => tick(value => value + 1), 1000); return () => clearInterval(id); }, []);
  useEffect(() => { if (video.current && media.stream) video.current.srcObject = media.stream; }, [media.stream]);
  if (!remote || !['connecting', 'active'].includes(remote.phase)) return <div className={`remote-surface ${surface}`}><span>远程桌面会话已结束</span></div>;
  const end = () => void window.darling.remoteAction('end', remote.sessionId); const route = media.telemetry.route === 'direct' ? '直连' : media.telemetry.route === 'relay' ? '服务器中继' : '检测中';
  if (surface === 'remote-status') return <div className="remote-surface remote-status"><span className="remote-live-dot"/><strong>正在被 {names[remote.controller]} 远程连接</strong><time>{elapsed(remote.startedAt)}</time><span className="quality">网络 · {media.telemetry.quality}</span><button aria-pressed={remote.permissions.control} onClick={() => void window.darling.remotePermissions(remote.sessionId, { ...remote.permissions, control: !remote.permissions.control })}>{remote.permissions.control ? '允许操作' : '仅观看'}</button><button aria-pressed={remote.permissions.audio} onClick={() => void window.darling.remotePermissions(remote.sessionId, { ...remote.permissions, audio: !remote.permissions.audio })}>{remote.permissions.audio ? '声音已开' : '声音关闭'}</button><button className="remote-end" onClick={end}>断开</button></div>;
  return <div className="remote-surface remote-control"><header><div><strong>{names[remote.controlled]} 的桌面</strong><span>{remote.phase === 'active' ? elapsed(remote.startedAt) : media.detail}</span></div><div><span>连接路径 · {route}</span><span>网络 · {media.telemetry.quality}{media.telemetry.rttMs === undefined ? '' : ` · ${media.telemetry.rttMs}ms`}</span><span>{remote.permissions.control ? '可操作' : '仅观看'}</span><span>{remote.permissions.audio ? '声音开启' : '声音关闭'}</span><button className="remote-end" onClick={end}>断开连接</button></div></header><div className="remote-stage">{media.stream ? <video ref={video} autoPlay playsInline/> : <><Icon name="desktop"/><h1>正在准备远程画面</h1><p>{media.detail}</p></>}</div></div>;
}
