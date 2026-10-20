import type { CallState, Snapshot } from '../../../packages/protocol/src/index';
import { useEffect, useRef, useState } from 'react';
import { useCallTones } from './call-tones';

export function formatCallDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

const reasons: Record<NonNullable<CallState['reason']>, string> = {
  cancelled: '呼叫已取消', rejected: '通话已拒绝', hangup: '通话已结束', timeout: '等待超时',
  disconnected: '连接断开，通话已结束', replaced: '账号已在其他客户端登录', 'server-shutdown': '服务器关闭，通话已结束',
};
export function CallPanel({ state, end, accept }: { state: Snapshot; end: () => void; accept: () => void }) {
  const call = state.call;
  const [now, setNow] = useState(Date.now());
  const started = useRef<number | null>(null);
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
    <div className="call-orb" aria-hidden="true">◉</div>
    <div className="call-info">
      <span className="call-eyebrow">{active ? 'VOICE CONNECTED' : incoming ? 'INCOMING VOICE' : 'VOICE CALL'}</span>
      {call && <strong>{call.phase === 'ended' ? reasons[call.reason ?? 'hangup'] : call.phase === 'active' ? '语音通话中 · TURN 中继测试版' : call.phase === 'connecting' ? '正在连接音频…' : incoming ? '收到语音邀请' : '等待对方接听'}</strong>}
      {call && call.phase !== 'ended' && <p>{state.voiceBeta ? '发起/接听表示允许本次麦克风采集并传给对方。测试版最长 30 分钟；结束连接会停止音频。' : '原生语音传输尚未开放，麦克风未因本次邀请开启。'}</p>}
      {active && <div className="call-live"><time aria-label="通话时长">{formatCallDuration(started.current === null ? 0 : now - started.current)}</time><div className="voice-bars" role="meter" aria-label="对方音量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(strength * 100)} aria-valuetext={level === null ? '暂无电平数据' : strength > 0 ? '收到声音' : '安静'}>{[.5,.8,1,.7,.45].map((weight, i) => <i key={i} style={{ height: `${4 + strength * weight * 24}px`, opacity: strength ? 1 : .3 }}/>)}</div><span>{level === null ? '等待音频电平' : strength > 0 ? '对方声音' : '对方安静'}</span></div>}
      {incoming && call?.phase === 'ringing' && !state.mediaAvailable && <p className="call-warning">当前客户端语音尚未就绪。</p>}
      {!active && state.voiceDetail && <p>{state.voiceDetail}</p>}
      {state.callError && <p role="alert">{state.callError}</p>}
    </div>
    <div className="call-actions">
    {call?.phase === 'ringing' && incoming && <button className="call-accept" disabled={!state.mediaAvailable || state.callPending} onClick={accept}>接听 · 开启麦克风</button>}
    {call && call.phase !== 'ended' && <button className="call-reject" disabled={state.callPending || state.status !== 'online'} onClick={end}>{state.callPending ? '等待确认…' : call.phase === 'ringing' ? incoming ? '拒绝' : '取消呼叫' : '结束连接'}</button>}
    </div>
  </section>;
}
