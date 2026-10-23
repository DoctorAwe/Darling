import React, { useEffect, useRef, useState } from 'react';
import { RemoteInputEvent, type RemoteInputEvent as InputEvent, type RemoteSessionState, type RemoteSignal, type Snapshot } from '../../../packages/protocol/src/index';
import { Icon } from './Icon';

const names = { dva: 'D.Va', mercy: 'Mercy' } as const;
const elapsed = (startedAt?: number) => {
  const seconds = Math.max(0, Math.floor((Date.now() - (startedAt ?? Date.now())) / 1000));
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
type Telemetry = { route: 'checking' | 'direct' | 'relay'; quality: '检测中' | '优秀' | '良好' | '较差'; rttMs?: number; loss?: number; encoder?: string; hardwareEncoder?: boolean };
const errorText = (error: unknown) => error instanceof DOMException ? `${error.name}: ${error.message}` : error instanceof Error ? error.message : String(error);

function useRemoteMedia(remote: RemoteSessionState | null | undefined, role: 'controller' | 'controlled') {
  const streamRef = useRef<MediaStream | undefined>(undefined); const [stream, setStream] = useState<MediaStream | undefined>(undefined);
  const controlRef = useRef<RTCDataChannel | undefined>(undefined); const [controlReady, setControlReady] = useState(false);
  const [detail, setDetail] = useState('正在建立媒体通道'); const [telemetry, setTelemetry] = useState<Telemetry>({ route: 'checking', quality: '检测中' });
  useEffect(() => {
    if (!remote || !['connecting', 'active'].includes(remote.phase)) return;
    let disposed = false; let chain = Promise.resolve(); let unsubscribe: (() => void) | undefined; let statsTimer: ReturnType<typeof setInterval> | undefined;
    const earlyIce: RTCIceCandidateInit[] = []; const signalKeys = new Set<string>(); let readySent = false; let lastEncoder = '';
    const send = (value: RemoteSignal) => window.darling.remoteSignal(value);
    const report = (stage: string, value: string) => void window.darling.remoteDiagnostic(remote.sessionId, stage, value);
    const start = async () => {
      const ice = await window.darling.remoteIceConfig(); if (disposed) return;
      report('ice-config', `${ice.iceServers.length} servers`);
      const pc = new RTCPeerConnection({ iceServers: ice.iceServers, iceTransportPolicy: 'all', bundlePolicy: 'max-bundle', iceCandidatePoolSize: 4 });
      const applySignal = async (value: RemoteSignal) => {
        if (disposed || value.sessionId !== remote.sessionId) return;
        const key = JSON.stringify(value); if (signalKeys.has(key)) return; signalKeys.add(key);
        if (value.kind === 'ice') {
          const candidate = { candidate: value.candidate, sdpMid: value.sdpMid, sdpMLineIndex: value.sdpMLineIndex };
          if (!pc.remoteDescription) earlyIce.push(candidate); else await pc.addIceCandidate(candidate); return;
        }
        await pc.setRemoteDescription({ type: value.kind, sdp: value.sdp });
        if (value.kind === 'offer') {
          // Chromium's getDisplayMedia path marks a selected Windows screen as
          // cursor-always. Selecting the validated desktop source explicitly
          // uses the non-embedded cursor path, leaving only the controller's
          // immediate local system cursor visible.
          const sourceId = await window.darling.remoteCaptureSource();
          const desktopVideo = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60 } };
          const desktopAudio = { mandatory: { chromeMediaSource: 'desktop' } };
          let capture: MediaStream;
          try { capture = await navigator.mediaDevices.getUserMedia({ video: desktopVideo, audio: remote.permissions.audio ? desktopAudio : false } as unknown as MediaStreamConstraints); }
          catch (error) {
            report('capture', errorText(error));
            if (!remote.permissions.audio) throw error;
            setDetail('系统声音不可用，正在仅共享画面');
            capture = await navigator.mediaDevices.getUserMedia({ video: desktopVideo, audio: false } as unknown as MediaStreamConstraints);
          }
          if (disposed) { capture.getTracks().forEach(track => track.stop()); return; }
          report('capture-ready', capture.getTracks().map(track => track.kind).join(','));
          let videoSender: RTCRtpSender | undefined;
          streamRef.current = capture;
          for (const track of capture.getTracks()) {
            if (track.kind === 'video') track.contentHint = 'detail';
            const sender = pc.addTrack(track, capture);
            if (track.kind === 'video') videoSender = sender;
          }
          capture.getVideoTracks()[0]?.addEventListener('ended', () => { if (!disposed) void window.darling.remoteAction('end', remote.sessionId); });
          const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
          if (videoSender) {
            const parameters = videoSender.getParameters();
            if (parameters.encodings?.length) { parameters.encodings[0].maxBitrate = 16_000_000; parameters.encodings[0].maxFramerate = 60; await videoSender.setParameters(parameters); }
          }
          await send({ sessionId: remote.sessionId, generation: 1, kind: 'answer', sdp: answer.sdp! });
        }
        for (const candidate of earlyIce.splice(0)) await pc.addIceCandidate(candidate);
      };
      const enqueue = (value: RemoteSignal) => { chain = chain.then(() => applySignal(value)).catch(error => { const detail = errorText(error); report('signal', detail); setDetail(`媒体协商失败 · ${detail}`); }); };
      pc.onicecandidate = event => { if (event.candidate) void send({ sessionId: remote.sessionId, generation: 1, kind: 'ice', candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid, sdpMLineIndex: event.candidate.sdpMLineIndex }); };
      pc.onicecandidateerror = event => report('ice-candidate', `${event.errorCode} ${event.errorText}`);
      pc.oniceconnectionstatechange = () => { report('ice-state', pc.iceConnectionState); if (pc.iceConnectionState === 'checking') setDetail('正在验证直连与中继路径'); };
      pc.ontrack = event => { const received = event.streams[0] ?? new MediaStream([event.track]); streamRef.current = received; setStream(received); };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') { setDetail('远程画面已连接'); if (!readySent) { readySent = true; void window.darling.remoteReady(remote.sessionId); } }
        else if (pc.connectionState === 'failed') { setDetail('连接失败，请检查两端网络或查看远程诊断日志'); report('connection', 'failed'); }
        else if (pc.connectionState === 'disconnected') setDetail('网络中断，正在恢复');
      };
      if (role === 'controller') {
        const video = pc.addTransceiver('video', { direction: 'recvonly' }); pc.addTransceiver('audio', { direction: 'recvonly' });
        const capabilities = RTCRtpReceiver.getCapabilities('video');
        if (capabilities) video.setCodecPreferences([...capabilities.codecs].sort((a, b) => Number(b.mimeType.toLowerCase() === 'video/h264') - Number(a.mimeType.toLowerCase() === 'video/h264')));
        const control = pc.createDataChannel('control', { ordered: true }); controlRef.current = control;
        control.onopen = () => setControlReady(true); control.onclose = () => setControlReady(false);
        const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
        await send({ sessionId: remote.sessionId, generation: 1, kind: 'offer', sdp: offer.sdp! });
      } else pc.ondatachannel = event => { if (event.channel.label === 'control') event.channel.onmessage = message => {
        try { void window.darling.remoteInput(remote.sessionId, RemoteInputEvent.parse(JSON.parse(String(message.data)))); } catch { /* malformed peer input is ignored */ }
      }; };
      unsubscribe = window.darling.subscribeRemoteSignal(enqueue);
      for (const value of await window.darling.remoteDrainSignals(remote.sessionId)) enqueue(value);
      statsTimer = setInterval(async () => {
        if (pc.connectionState !== 'connected') return;
        const stats = await pc.getStats(); let pair: Record<string, any> | undefined; let inbound: Record<string, any> | undefined; let outbound: Record<string, any> | undefined; const byId = new Map<string, Record<string, any>>();
        stats.forEach(report => { const value = report as unknown as Record<string, any>; byId.set(String(value.id), value); if (value.type === 'candidate-pair' && value.state === 'succeeded' && (value.selected || value.nominated)) pair = value; if (value.type === 'inbound-rtp' && value.kind === 'video') inbound = value; if (value.type === 'outbound-rtp' && value.kind === 'video') outbound = value; });
        let route: Telemetry['route'] = 'checking'; let rttMs: number | undefined;
        if (pair) { const local = byId.get(pair.localCandidateId); const peer = byId.get(pair.remoteCandidateId); route = local?.candidateType === 'relay' || peer?.candidateType === 'relay' ? 'relay' : 'direct'; rttMs = Number.isFinite(pair.currentRoundTripTime) ? Math.round(pair.currentRoundTripTime * 1000) : undefined; }
        const lost = inbound?.packetsLost ?? 0; const received = inbound?.packetsReceived ?? 0; const loss = lost + received > 0 ? lost / (lost + received) : 0;
        const quality: Telemetry['quality'] = (rttMs ?? 0) > 180 || loss > .04 ? '较差' : (rttMs ?? 0) > 80 || loss > .015 ? '良好' : '优秀';
        const encoder = typeof outbound?.encoderImplementation === 'string' ? outbound.encoderImplementation : undefined;
        const hardwareEncoder = typeof outbound?.powerEfficientEncoder === 'boolean' ? outbound.powerEfficientEncoder : undefined;
        setTelemetry({ route, quality, rttMs, loss, encoder, hardwareEncoder });
        if (role === 'controlled' && encoder && encoder !== lastEncoder) { lastEncoder = encoder; report('video-encoder', `${encoder}; powerEfficient=${String(hardwareEncoder)}`); }
        if (role === 'controlled') for (const sender of pc.getSenders()) if (sender.track?.kind === 'video') {
          const parameters = sender.getParameters(); if (parameters.encodings?.length) { parameters.encodings[0].maxBitrate = route === 'direct' ? 28_000_000 : 16_000_000; await sender.setParameters(parameters).catch(() => {}); }
        }
      }, 2000);
      return pc;
    };
    let pc: RTCPeerConnection | undefined; void start().then(value => { pc = value; }).catch(error => { const detail = errorText(error); report('startup', detail); setDetail(`无法启动远程媒体 · ${detail}`); });
    return () => { disposed = true; unsubscribe?.(); clearInterval(statsTimer); controlRef.current = undefined; setControlReady(false); pc?.close(); streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = undefined; setStream(undefined); };
  }, [remote?.sessionId, role]);
  useEffect(() => { for (const track of streamRef.current?.getAudioTracks() ?? []) track.enabled = !!remote?.permissions.audio; }, [remote?.permissions.audio]);
  const sendControl = (event: InputEvent) => { if (controlRef.current?.readyState === 'open') controlRef.current.send(JSON.stringify(event)); };
  return { stream, detail, telemetry, controlReady, sendControl };
}

export function RemoteDesktopSurface({ surface, state }: { surface: 'remote-control' | 'remote-status'; state: Snapshot }) {
  const [, tick] = useState(0); const video = useRef<HTMLVideoElement>(null); const remote = state.remote; const media = useRemoteMedia(remote, surface === 'remote-control' ? 'controller' : 'controlled');
  useEffect(() => { const id = setInterval(() => tick(value => value + 1), 1000); return () => clearInterval(id); }, []);
  useEffect(() => { if (video.current && media.stream) video.current.srcObject = media.stream; }, [media.stream]);
  const normalizedPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = video.current; if (!element?.videoWidth || !element.videoHeight) return;
    const rect = element.getBoundingClientRect(); const scale = Math.min(rect.width / element.videoWidth, rect.height / element.videoHeight);
    const width = element.videoWidth * scale, height = element.videoHeight * scale; const left = rect.left + (rect.width - width) / 2, top = rect.top + (rect.height - height) / 2;
    const x = (event.clientX - left) / width, y = (event.clientY - top) / height; if (x < 0 || x > 1 || y < 0 || y > 1) return;
    return { x, y };
  };
  const canControl = !!remote?.permissions.control && media.controlReady;
  const sendPointer = (event: React.PointerEvent<HTMLDivElement>, down?: boolean) => {
    if (!canControl) return; const point = normalizedPointer(event); if (!point) return;
    media.sendControl({ type: 'pointer.move', ...point });
    if (down !== undefined && [0, 1, 2].includes(event.button)) media.sendControl({ type: 'pointer.button', button: (['left', 'middle', 'right'] as const)[event.button], down });
  };
  if (!remote || !['connecting', 'active'].includes(remote.phase)) return <div className={`remote-surface ${surface} remote-ended`}><Icon name="desktop"/><h1>远程桌面未能建立</h1><p>{remote?.reason === 'timeout' ? '连接协商超时。请保留此窗口并检查两台电脑的 remote-desktop.log。' : '远程桌面会话已结束。'}</p>{surface === 'remote-control' && <button onClick={() => window.darling.window('close')}>关闭窗口</button>}</div>;
  const end = () => void window.darling.remoteAction('end', remote.sessionId); const route = media.telemetry.route === 'direct' ? '直连' : media.telemetry.route === 'relay' ? '服务器中继' : '检测中';
  if (surface === 'remote-status') return <div className="remote-surface remote-status"><span className="remote-live-dot"/><strong>正在被 {names[remote.controller]} 远程连接</strong><time>{elapsed(remote.startedAt)}</time><span className="quality">网络 · {media.telemetry.quality}</span><button aria-pressed={remote.permissions.control} onClick={() => void window.darling.remotePermissions(remote.sessionId, { ...remote.permissions, control: !remote.permissions.control })}>{remote.permissions.control ? '允许操作' : '仅观看'}</button><button aria-pressed={remote.permissions.audio} onClick={() => void window.darling.remotePermissions(remote.sessionId, { ...remote.permissions, audio: !remote.permissions.audio })}>{remote.permissions.audio ? '声音已开' : '声音关闭'}</button><button className="remote-end" onClick={end}>断开</button></div>;
  return <div className="remote-surface remote-control"><header><div><strong>{names[remote.controlled]} 的桌面</strong><span>{remote.phase === 'active' ? elapsed(remote.startedAt) : media.detail}</span></div><div><span>连接路径 · {route}</span><span>网络 · {media.telemetry.quality}{media.telemetry.rttMs === undefined ? '' : ` · ${media.telemetry.rttMs}ms`}</span><span>{canControl ? '可操作' : '仅观看'}</span><span>{remote.permissions.audio ? '声音开启' : '声音关闭'}</span><button className="remote-end" onClick={end}>断开连接</button></div></header><div className={`remote-stage ${canControl ? 'interactive' : ''}`} tabIndex={canControl ? 0 : -1} onPointerMove={event => sendPointer(event)} onPointerDown={event => { event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); sendPointer(event, true); }} onPointerUp={event => { sendPointer(event, false); event.currentTarget.releasePointerCapture(event.pointerId); }} onWheel={event => { if (canControl) { event.preventDefault(); media.sendControl({ type: 'pointer.wheel', deltaX: Math.max(-1200, Math.min(1200, Math.round(event.deltaX))), deltaY: Math.max(-1200, Math.min(1200, Math.round(event.deltaY))) }); } }} onKeyDown={event => { if (canControl && !event.repeat && RemoteInputEvent.safeParse({ type: 'key', code: event.code, down: true }).success) { event.preventDefault(); media.sendControl({ type: 'key', code: event.code, down: true }); } }} onKeyUp={event => { if (canControl && RemoteInputEvent.safeParse({ type: 'key', code: event.code, down: false }).success) { event.preventDefault(); media.sendControl({ type: 'key', code: event.code, down: false }); } }} onBlur={() => media.sendControl({ type: 'release' })} onContextMenu={event => { if (canControl) event.preventDefault(); }}>{media.stream ? <video ref={video} autoPlay playsInline/> : <><Icon name="desktop"/><h1>正在准备远程画面</h1><p>{media.detail}</p></>}</div></div>;
}
