import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { otherUser, type DesktopApi, type Snapshot, type User } from '../../../packages/protocol/src/index';
import dvaAvatar from '../../../resource/dva_avatar.png';
import mercyAvatar from '../../../resource/mercy_avatar.png';
import dvaIcon from '../../../resource/dva.png';
import mercyIcon from '../../../resource/mercy.png';
import './style.css';
import './call.css';
import { AudioPanel } from './AudioPanel';
import { CallPanel } from './CallPanel';
declare global { interface Window { darling: DesktopApi } }
const avatars = { dva: dvaAvatar, mercy: mercyAvatar };
const icons = { dva: dvaIcon, mercy: mercyIcon };
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
    <header className="titlebar"><div className="brand"><span className="brand-mark">✧</span> DARLING <span className="version">PRIVATE SPACE</span></div><div className="window-buttons"><button aria-label="最小化" onClick={() => window.darling.window('minimize')}>−</button><button aria-label="最大化或还原" onClick={() => window.darling.window('maximize')}>□</button><button aria-label="关闭" onClick={() => window.darling.window('close')}>×</button></div></header>
    <div className="body"><aside><div className="section-label">YOUR CONNECTION</div><div className="contact selected"><Avatar user={peer}/><div><strong>{names[peer]}</strong><p><i className={online ? 'dot online' : 'dot'}/>{online ? '在线 · 就在这里' : '当前离线'}</p></div><span className="spark">✦</span></div>
      <div className="space-note"><span>02</span><p>两个人的空间<br/>每一句，都留在这里。</p></div><div className="self"><Avatar user={self} small/><div><strong>{state.user ? names[self] : '等待配置'}</strong><p>{state.status === 'online' ? '已自动登录' : '连接待就绪'}</p></div><img className="user-icon" src={icons[self]} alt=""/></div></aside>
    <main><div className="conversation-header"><div><div className="eyebrow">DIRECT MESSAGE</div><h1>{names[peer]} <span>✧</span></h1></div><div className="header-actions"><button className="device-button" onClick={() => setAudioOpen(!audioOpen)}>音频设备</button><button className="call" disabled={!state.mediaAvailable || state.status !== 'online' || !online || state.callPending || (!!state.call && state.call.phase !== 'ended')} title={!online ? '等待对方上线' : '系统默认设备；耳机禁用 AEC，降噪开启；点击将开启麦克风'} onClick={() => callAction('invite')}>◉ <span>{state.voiceBeta ? '发起语音 · 测试版' : '语音 · 开发中'}</span></button></div></div>
    {audioOpen && <AudioPanel voiceBeta={state.voiceBeta} close={() => setAudioOpen(false)}/>}
    <CallPanel state={state} end={() => callAction('end')} accept={() => callAction('accept')}/>
    <div className={`connection ${state.status}`}><i className={state.status === 'online' ? 'dot online' : 'dot'}/><span>{state.detail}</span>{state.status !== 'online' && <button onClick={() => void window.darling.reload()}>重新加载</button>}</div>
    {(state.status === 'error' || state.status === 'replaced') && <div className="config-path">配置文件：{state.configPath}</div>}
    <div className="messages" aria-live="polite">{state.messages.length === 0 && state.pending.length === 0 && <div className="empty"><div className="avatar-halo"><Avatar user={peer}/></div><h2>从一句你好开始。</h2><p>这里是你和 {names[peer]} 的专属对话。</p><span>文字已准备好，声音即将到来</span></div>}
    {state.messages.map(m => <article className={`message ${m.sender === self ? 'mine' : ''}`} key={m.id}><Avatar user={m.sender} small/><div className="message-content"><div className="message-meta">{names[m.sender]}<time>{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div><div className="bubble">{m.text}</div>{m.sender === self && <div className="delivery">已存储</div>}</div></article>)}
    {state.pending.map(m => <article className="message mine" key={m.clientId}><Avatar user={self} small/><div className="message-content"><div className="bubble pending">{m.text}</div><div className="delivery">{state.status === 'online' ? '发送中…' : '等待重连'}</div></div></article>)}<div ref={bottom}/></div>
    <div className="composer"><div className="compose-box"><textarea aria-label="聊天消息" placeholder={`发送消息给 ${names[peer]}…`} value={draft} maxLength={8000} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}/><button className="send" disabled={!draft.trim() || !state.user || ['error', 'replaced'].includes(state.status)} onClick={() => void send()} aria-label="发送">↑</button></div><div className="compose-footer"><span>{error || 'Enter 发送 · Shift + Enter 换行'}</span><span>只属于你们的频道 <b>✦</b></span></div></div></main></div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
