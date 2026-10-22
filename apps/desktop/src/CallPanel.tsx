import type { CallState, Snapshot } from '../../../packages/protocol/src/index';
import { useEffect, useRef, useState } from 'react';
import { useCallTones } from './call-tones';
import { Icon } from './Icon';

export function formatCallDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

const reasons: Record<NonNullable<CallState['reason']>, string> = {
  cancelled: '呼叫已取消', rejected: '通话已拒绝', hangup: '通话已结束', timeout: '等待超时',
  disconnected: '连接断开，通话已结束', replaced: '账号已在其他客户端登录', 'server-shutdown': '服务器关闭，通话已结束',
};
export function CallPanel({ state, end, accept, changeAudio }: { state: Snapshot; end: () => void; accept: () => void; changeAudio?: (micMuted: boolean, speakerMuted: boolean) => Promise<void> }) {
  const call = state.call;
  const [now, setNow] = useState(Date.now());
  const started = useRef<number | null>(null);
  const [audio, setAudio] = useState({ mic: false, speaker: false, busy: false, error: '' });
  const currentCall = useRef(call?.callId); currentCall.current = call?.callId;
  useEffect(() => { setAudio({ mic: false, speaker: false, busy: false, error: '' }); }, [call?.callId]);
  const toggle = async (kind: 'mic' | 'speaker') => {
    if (audio.busy || !changeAudio) return;
    const id = call?.callId;
    const next = { ...audio, [kind]: !audio[kind] };
    setAudio({ ...audio, busy: true, error: '' });
    try {
      await changeAudio(next.mic, next.speaker);
      if (currentCall.current === id) setAudio({ ...next, busy: false, error: '' });
    } catch {
      if (currentCall.current === id) setAudio({ ...audio, busy: false, error: '操作未成功，请重试' });
    }
  };
  useEffect(() => { started.current = null; setNow(Date.now()); }, [call?.callId]);
  useEffect(() => {
    if (call?.phase !== 'active') return;
    started.current ??= Date.now(); setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [call?.callId, call?.phase]);
  useCallTones(state.status === 'online' && call?.phase === 'ringing' ? call.callee === state.user ? 'incoming' : 'outgoing' : null);
  if (!call && !state.callError) return null;
  const incoming = call?.callee === state.user;
  const active = call?.phase === 'active';
  const level = active && state.remoteAudio && now - state.remoteAudio.sampledAt < 1500 ? state.remoteAudio.level : null;
  const strength = level === null || level <= .001 ? 0 : Math.min(1, Math.max(0, (20 * Math.log10(level) + 60) / 60));
  return <section className={`call-card ${call?.phase ?? ''} ${incoming ? 'incoming' : 'outgoing'}`} aria-label="通话状态">
    <div className="call-symbol"><Icon name="phone"/></div>
    <div className="call-info">
      {call && <strong>{call.phase === 'ended' ? reasons[call.reason ?? 'hangup'] : active ? '语音通话' : call.phase === 'connecting' ? '正在连接音频…' : incoming ? '收到语音邀请' : '等待对方接听'}</strong>}
      {active && <div className="call-live"><time aria-label="通话时长">{formatCallDuration(started.current === null ? 0 : now - started.current)}</time><div className="voice-bars" role="meter" aria-label="对方音量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(strength * 100)} aria-valuetext={level === null ? '暂无电平数据' : strength > 0 ? '收到声音' : '安静'}>{[.5,.8,1,.7,.45].map((weight, i) => <i key={i} style={{ height: `${4 + strength * weight * 24}px`, opacity: strength ? 1 : .3 }}/>)}</div><span>{level === null ? '等待音频电平' : strength > 0 ? '对方声音' : '对方安静'}</span></div>}
      {incoming && call?.phase === 'ringing' && !state.mediaAvailable && <p className="call-warning">当前客户端语音尚未就绪。</p>}
      {audio.error && active && <p role="alert">{audio.error}</p>}
      {state.callError && <p role="alert">{state.callError}</p>}
    </div>
    <div className="call-actions">
    {active && <>
      <button className="call-toggle" aria-pressed={audio.mic} disabled={audio.busy || !changeAudio} onClick={() => void toggle('mic')} title={audio.mic ? '开启麦克风' : '静音麦克风'}><Icon name="mic" muted={audio.mic}/><span>{audio.mic ? '麦克风已静音' : '麦克风'}</span></button>
      <button className="call-toggle" aria-pressed={audio.speaker} disabled={audio.busy || !changeAudio} onClick={() => void toggle('speaker')} title={audio.speaker ? '恢复对方声音' : '静音对方声音'}><Icon name="speaker" muted={audio.speaker}/><span>{audio.speaker ? '对方已静音' : '对方声音'}</span></button>
    </>}
    {call?.phase === 'ringing' && incoming && <button className="call-accept" disabled={!state.mediaAvailable || state.callPending} onClick={accept}>接听</button>}
    {call && call.phase !== 'ended' && <button className="call-reject" disabled={state.callPending || state.status !== 'online'} onClick={end}>{state.callPending ? '请稍候' : call.phase === 'ringing' ? incoming ? '拒绝' : '取消' : '挂断'}</button>}
    </div>
  </section>;
}
