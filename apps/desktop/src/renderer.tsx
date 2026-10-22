import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { otherUser, type DesktopApi, type Snapshot, type User } from '../../../packages/protocol/src/index';
import dvaAvatar from '../../../resource/dva_avatar.png';
import mercyAvatar from '../../../resource/mercy_avatar.png';
import './style.css';
import './call.css';
import { AudioPanel } from './AudioPanel';
import { CallPanel } from './CallPanel';
import { Icon } from './Icon';
declare global { interface Window { darling: DesktopApi } }
const avatars = { dva: dvaAvatar, mercy: mercyAvatar };
const names = { dva: 'D.Va', mercy: 'Mercy' };
const initial: Snapshot = { status: 'connecting', online: [], messages: [], pending: [], configPath: '', detail: '正在启动', mediaAvailable: false };
function Avatar({ user, small = false }: { user: User; small?: boolean }) {
  return <img className={`avatar ${small ? 'small' : ''}`} src={avatars[user]} alt={names[user]} />;
}
function App() {
  const [state, setState] = useState(initial);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [audioOpen, setAudioOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const callAction = (action: 'invite' | 'accept' | 'end') => {
    void window.darling.callAction(action, state.call?.callId).then(result => { if (!result.ok) setError(result.error ?? '通话操作失败'); else setError(''); }).catch(() => setError('无法操作通话，请重新连接'));
  };
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let received = false;
    const off = window.darling.subscribe(next => { received = true; setState(next); });
    void window.darling.snapshot().then(next => { if (!received) setState(next); });
    return off;
  }, []);
  useEffect(() => bottom.current?.scrollIntoView({ behavior: 'smooth' }), [state.messages.length, state.pending.length]);
  const self = state.user ?? 'dva'; const peer = otherUser(self);
  const online = state.online.includes(peer);
  const send = async () => {
    if (!draft.trim()) return;
    const result = await window.darling.send(draft);
    if (result.ok) { setDraft(''); setError(''); } else setError(result.error ?? '发送失败');
  };
  return <div className="shell">
    <header className="titlebar"><div className="brand"><span className="brand-mark"/> Darling</div><div className="window-buttons"><button aria-label="最小化" onClick={() => window.darling.window('minimize')}>−</button><button aria-label="最大化或还原" onClick={() => window.darling.window('maximize')}>□</button><button aria-label="关闭" onClick={() => window.darling.window('close')}>×</button></div></header>
    <div className="body"><aside><nav className="module-nav" aria-label="功能"><button className="module-active" aria-current="page"><Icon name="chat"/>消息</button></nav><div className="section-label">联系人</div><div className="contact selected"><Avatar user={peer}/><div><strong>{names[peer]}</strong><p><i className={online ? 'dot online' : 'dot'}/>{online ? '在线' : '当前离线'}</p></div></div>
      <div className="sidebar-spacer"/><div className="self"><Avatar user={self} small/><div><strong>{state.user ? names[self] : '等待配置'}</strong><p>{state.status === 'online' ? '在线' : '离线'}</p></div></div></aside>
    <main><div className="conversation-header"><div><h1>{names[peer]}</h1><p className="peer-status">{online ? '在线' : '离线'}</p></div><div className="header-actions"><button className="device-button" aria-label="设置" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><Icon name="settings"/></button><button className="call" disabled={!state.mediaAvailable || state.status !== 'online' || !online || state.callPending || (!!state.call && state.call.phase !== 'ended')} title={!online ? '等待对方上线' : '发起语音通话'} onClick={() => callAction('invite')}><Icon name="phone"/><span>语音通话</span></button></div></div>
    {settingsOpen && <section className="settings-panel" aria-label="设置"><div><strong>音频</strong><p>使用系统默认麦克风与扬声器</p></div><button onClick={() => { setAudioOpen(!audioOpen); setSettingsOpen(false); }}>音频诊断</button><button aria-label="关闭设置" onClick={() => setSettingsOpen(false)}>×</button></section>}
    {audioOpen && <AudioPanel voiceBeta={state.voiceBeta} close={() => setAudioOpen(false)}/>}
    <CallPanel key={state.call?.callId ?? 'none'} state={state} end={() => callAction('end')} accept={() => callAction('accept')} changeAudio={(mic, speaker) => window.darling.callAudio(state.call!.callId, mic, speaker)}/>
    {state.status !== 'online' && <div className={`connection ${state.status}`}><i className="dot"/><span>{state.detail}</span><button onClick={() => void window.darling.reload()}>重试</button></div>}
    {(state.status === 'error' || state.status === 'replaced') && <div className="config-path">配置文件：{state.configPath}</div>}
    <div className="workspace" data-module="chat"><div className="messages" aria-live="polite">{state.messages.length === 0 && state.pending.length === 0 && <div className="empty"><Avatar user={peer}/><h2>{names[peer]}</h2><p>发一条消息，开始聊天</p></div>}
    {state.messages.map(m => <article className={`message ${m.sender === self ? 'mine' : ''}`} key={m.id}><Avatar user={m.sender} small/><div className="message-content"><div className="message-meta">{names[m.sender]}<time>{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div><div className="bubble">{m.text}</div></div></article>)}
    {state.pending.map(m => <article className="message mine" key={m.clientId}><Avatar user={self} small/><div className="message-content"><div className="bubble pending">{m.text}</div><div className="delivery">{state.status === 'online' ? '发送中…' : '等待重连'}</div></div></article>)}<div ref={bottom}/></div></div>
    <div className="composer"><div className="compose-box"><textarea aria-label="聊天消息" placeholder={`发送消息给 ${names[peer]}…`} value={draft} maxLength={8000} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}/><button className="send" disabled={!draft.trim() || !state.user || ['error', 'replaced'].includes(state.status)} onClick={() => void send()} aria-label="发送"><Icon name="send"/></button></div><div className="compose-footer"><span>{error || 'Enter 发送 · Shift + Enter 换行'}</span></div></div></main></div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
