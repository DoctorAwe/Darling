import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { otherUser, type DesktopApi, type Snapshot, type User } from '../../../packages/protocol/src/index';
import dvaAvatar from '../../../resource/dva_avatar.png';
import mercyAvatar from '../../../resource/mercy_avatar.png';
import echoAvatar from '../../../resource/echo_avatar.png';
import echoIcon from '../../../resource/echo.png';
import './style.css';
import './call.css';
import { AudioPanel } from './AudioPanel';
import { CallPanel } from './CallPanel';
import { Icon } from './Icon';
import { RemoteDesktopSurface } from './RemoteDesktopSurface';
import { AttachmentMessage } from './AttachmentMessage';
import { ScreenshotSurface } from './ScreenshotSurface';
import { defaultGroupDraft, insertEchoMention, isBareEchoMention, mentionQuery, uploadGroupAttachments } from './group-composer';
import { useConversationScroll } from './use-conversation-scroll';
declare global { interface Window { darling: DesktopApi } }
const avatars = { dva: dvaAvatar, mercy: mercyAvatar };
const names = { dva: 'D.Va', mercy: 'Mercy' };
const initial: Snapshot = { status: 'connecting', online: [], messages: [], pending: [], groupMessages: [], historyReady: { direct: false, group: false }, configPath: '', detail: '正在启动', mediaAvailable: false };
function Avatar({ user, small = false }: { user: User; small?: boolean }) {
  return <img className={`avatar ${small ? 'small' : ''}`} src={avatars[user]} alt={names[user]} />;
}
function GroupAvatar({ small = false }: { small?: boolean }) { return <span className={`group-avatar ${small ? 'small' : ''}`}><img src={dvaAvatar}/><img src={mercyAvatar}/><img className="echo" src={echoIcon} alt="Echo"/></span>; }
function EchoAvatar() { return <img className="echo-avatar" src={echoAvatar} alt="Echo"/>; }
function RemoteSurface({ surface }: { surface: 'remote-control' | 'remote-status' }) {
  const [state, setState] = useState(initial);
  useEffect(() => { const off = window.darling.subscribe(setState); void window.darling.snapshot().then(setState); return off; }, []);
  return <RemoteDesktopSurface surface={surface} state={state}/>;
}
function App() {
  const [state, setState] = useState(initial);
  const [directDraft, setDirectDraft] = useState('');
  const [groupDraft, setGroupDraft] = useState(defaultGroupDraft);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [error, setError] = useState('');
  const [audioOpen, setAudioOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [remoteControl, setRemoteControl] = useState(true);
  const [remoteAudio, setRemoteAudio] = useState(true);
  const [attachmentMenu, setAttachmentMenu] = useState(false);
  const [attachments, setAttachments] = useState<Array<{ token: string; name: string; mime: string; size: number; image: boolean }>>([]);
  const [sending, setSending] = useState(false);
  const [conversation, setConversation] = useState<'direct' | 'group'>('direct');
  const attachmentTrigger = useRef<HTMLDivElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const callAction = (action: 'invite' | 'accept' | 'end') => {
    void window.darling.callAction(action, state.call?.callId).then(result => { if (!result.ok) setError(result.error ?? '通话操作失败'); else setError(''); }).catch(() => setError('无法操作通话，请重新连接'));
  };
  const remoteAction = (action: 'invite' | 'accept' | 'end') => {
    void window.darling.remoteAction(action, state.remote?.sessionId, action === 'accept' ? { control: remoteControl, audio: remoteAudio } : undefined)
      .then(result => { if (!result.ok) setError(result.error ?? '远程桌面操作失败'); else setError(''); }).catch(() => setError('无法操作远程桌面，请重新连接'));
  };
  useEffect(() => {
    let received = false;
    const off = window.darling.subscribe(next => { received = true; setState(next); });
    void window.darling.snapshot().then(next => { if (!received) setState(next); });
    return off;
  }, []);
  useEffect(() => {
    if (!attachmentMenu) return;
    const outside = (event: PointerEvent) => { if (!attachmentTrigger.current?.contains(event.target as Node)) setAttachmentMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setAttachmentMenu(false); };
    const blur = () => setAttachmentMenu(false);
    document.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape); window.addEventListener('blur', blur);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape); window.removeEventListener('blur', blur); };
  }, [attachmentMenu]);
  const self = state.user ?? 'dva'; const peer = otherUser(self);
  const draft = conversation === 'group' ? groupDraft : directDraft;
  const setDraft = conversation === 'group' ? setGroupDraft : setDirectDraft;
  const online = state.online.includes(peer);
  const historyReady = conversation === 'direct' ? !!state.historyReady?.direct : !!state.historyReady?.group;
  const directLast = state.messages.at(-1)?.id ?? ''; const groupLast = state.groupMessages?.at(-1)?.id ?? '';
  const contentVersion = conversation === 'direct' ? `${state.messages.length}:${state.pending.length}:${directLast}` : `${state.groupMessages?.length ?? 0}:${groupLast}:${state.groupAi?.status ?? ''}:${state.groupAi?.text?.length ?? 0}`;
  const conversationScroll = useConversationScroll(conversation, historyReady, contentVersion);
  const changeConversation = (next: 'direct' | 'group') => { if (next === conversation) return; conversationScroll.saveCurrent(); setMentionOpen(false); setConversation(next); };
  const send = async () => {
    if ((!draft.trim() && attachments.length === 0) || sending) return; setSending(true); setError('');
    try {
      const failed: typeof attachments = [];
      if (conversation === 'group') {
        const uploaded = await uploadGroupAttachments(attachments, token => window.darling.groupAttachmentSend(token));
        setAttachments(uploaded.failed); if (uploaded.error) setError(uploaded.error);
        if (uploaded.failed.length > 0) return;
        if (draft.trim()) { const result = await window.darling.groupSend(draft); if (!result.ok) { setError(result.error ?? '文字发送失败'); return; } }
        setGroupDraft(defaultGroupDraft);
      } else {
        if (draft.trim()) { const result = await window.darling.send(draft); if (!result.ok) { setError(result.error ?? '文字发送失败'); return; } setDirectDraft(''); }
        for (const attachment of attachments) { const result = await window.darling.attachmentSend(attachment.token); if (!result.ok) { failed.push(attachment); setError(result.error ?? '附件发送失败'); } }
      }
      setAttachments(failed);
    } catch { setError('发送失败，请检查连接后重试'); }
    finally { setSending(false); }
  };
  const chooseEcho = () => {
    setGroupDraft(value => insertEchoMention(value)); setMentionOpen(false);
    requestAnimationFrame(() => { const input = composerInput.current; if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } });
  };
  const appendAttachments = (items: typeof attachments) => setAttachments(current => {
    const available = Math.max(0, 10 - current.length), accepted = items.slice(0, available);
    for (const item of items.slice(available)) void window.darling.attachmentDiscard(item.token);
    return [...current, ...accepted];
  });
  const removeAttachment = (token: string) => { setAttachments(current => current.filter(value => value.token !== token)); void window.darling.attachmentDiscard(token); };
  const pickAttachments = () => { setAttachmentMenu(false); void window.darling.attachmentPick().then(appendAttachments).catch(() => setError('无法选择文件')); };
  const takeScreenshot = () => { setAttachmentMenu(false); void window.darling.attachmentScreenshot().then(item => { if (item) appendAttachments([item]); }).catch(() => setError('截图失败')); };
  return <div className="shell">
    <header className="titlebar"><div className="brand"><span className="brand-mark"/> Darling</div><div className="window-buttons"><button aria-label="最小化" onClick={() => window.darling.window('minimize')}>−</button><button aria-label="最大化或还原" onClick={() => window.darling.window('maximize')}>□</button><button aria-label="关闭" onClick={() => window.darling.window('close')}>×</button></div></header>
    <div className="body"><aside><nav className="module-nav" aria-label="功能"><button className="module-active" aria-current="page"><Icon name="chat"/>消息</button></nav><div className="section-label">会话</div><button className={`contact ${conversation === 'direct' ? 'selected' : ''}`} onClick={() => changeConversation('direct')}><Avatar user={peer}/><div><strong>{names[peer]}</strong><p><i className={online ? 'dot online' : 'dot'}/>{online ? '在线' : '当前离线'}</p></div></button><button className={`contact group-contact ${conversation === 'group' ? 'selected' : ''}`} onClick={() => changeConversation('group')}><GroupAvatar/><div><strong>D.Va、Mercy 与 Echo</strong><p>3 位成员</p></div></button>
      <div className="sidebar-spacer"/><div className="self"><Avatar user={self} small/><div><strong>{state.user ? names[self] : '等待配置'}</strong><p>{state.status === 'online' ? '在线' : '离线'}</p></div></div></aside>
    <main><div className="conversation-header"><div><h1>{conversation === 'group' ? 'D.Va、Mercy 与 Echo' : names[peer]}</h1><p className="peer-status">{conversation === 'group' ? `3 位成员 · ${state.groupAi?.available ? 'Echo 可用' : 'Echo 不可用'}` : online ? '在线' : '离线'}</p></div>{conversation === 'direct' && <div className="header-actions"><button className="device-button" aria-label="设置" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><Icon name="settings"/></button><button className="call remote-button" disabled={state.status !== 'online' || !online || state.remotePending || (!!state.remote && state.remote.phase !== 'ended') || (!!state.call && state.call.phase !== 'ended')} title={!online ? '等待对方上线' : '请求远程桌面'} onClick={() => remoteAction('invite')}><Icon name="desktop"/><span>远程桌面</span></button><button className="call" disabled={!state.mediaAvailable || state.status !== 'online' || !online || state.callPending || (!!state.call && state.call.phase !== 'ended') || (!!state.remote && state.remote.phase !== 'ended')} title={!online ? '等待对方上线' : '发起语音通话'} onClick={() => callAction('invite')}><Icon name="phone"/><span>语音通话</span></button></div>}</div>
    {conversation === 'direct' && settingsOpen && <section className="settings-panel" aria-label="设置"><div><strong>音频</strong><p>使用系统默认麦克风与扬声器</p></div><button onClick={() => { setAudioOpen(!audioOpen); setSettingsOpen(false); }}>音频诊断</button><button aria-label="关闭设置" onClick={() => setSettingsOpen(false)}>×</button></section>}
    {conversation === 'direct' && audioOpen && <AudioPanel voiceBeta={state.voiceBeta} close={() => setAudioOpen(false)}/>}
    {conversation === 'direct' && <CallPanel key={state.call?.callId ?? 'none'} state={state} end={() => callAction('end')} accept={() => callAction('accept')} changeAudio={(mic, speaker) => window.darling.callAudio(state.call!.callId, mic, speaker)}/>}
    {conversation === 'direct' && state.remote && state.remote.phase === 'ringing' && <section className={`remote-invite ${state.remote.controlled === self ? 'incoming' : ''}`}><Icon name="desktop"/><div><strong>{state.remote.controlled === self ? `${names[state.remote.controller]} 请求查看你的桌面` : `等待 ${names[state.remote.controlled]} 接受远程桌面`}</strong><p>接受前不会捕获屏幕、声音或允许键鼠操作。</p>{state.remote.controlled === self && <div className="permission-options"><label><input type="checkbox" checked={remoteControl} onChange={e => setRemoteControl(e.target.checked)}/>允许远程操作</label><label><input type="checkbox" checked={remoteAudio} onChange={e => setRemoteAudio(e.target.checked)}/>启用远程语音</label></div>}</div><div className="remote-invite-actions">{state.remote.controlled === self && <button className="remote-accept" onClick={() => remoteAction('accept')}>接受并共享</button>}<button className="remote-reject" onClick={() => remoteAction('end')}>{state.remote.controlled === self ? '拒绝' : '取消'}</button></div></section>}
    {conversation === 'direct' && state.remote && ['connecting', 'active'].includes(state.remote.phase) && <div className="remote-main-status"><span className="remote-live-dot"/>远程桌面{state.remote.phase === 'active' ? '已连接' : '正在连接'}<button onClick={() => remoteAction('end')}>断开</button></div>}
    {state.status !== 'online' && <div className={`connection ${state.status}`}><i className="dot"/><span>{state.detail}</span><button onClick={() => void window.darling.reload()}>重试</button></div>}
    {(state.status === 'error' || state.status === 'replaced') && <div className="config-path">配置文件：{state.configPath}</div>}
    <div className="workspace" data-module="chat"><div ref={conversationScroll.elementRef} className="messages" aria-live="polite" onScroll={conversationScroll.onScroll}>{conversation === 'direct' && state.messages.length === 0 && state.pending.length === 0 && <div className="empty"><Avatar user={peer}/><h2>{names[peer]}</h2><p>发一条消息，开始聊天</p></div>}{conversation === 'group' && (state.groupMessages?.length ?? 0) === 0 && <div className="empty"><GroupAvatar/><h2>D.Va、Mercy 与 Echo</h2><p>发送第一条群聊消息</p></div>}
    {conversation === 'direct' && state.messages.map(m => <article className={`message ${m.sender === self ? 'mine' : ''}`} key={m.id}><Avatar user={m.sender} small/><div className="message-content"><div className="message-meta">{names[m.sender]}<time>{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>{m.attachment ? <AttachmentMessage attachment={m.attachment}/> : <div className="bubble">{m.text}</div>}</div></article>)}
    {conversation === 'direct' && state.pending.map(m => <article className="message mine" key={m.clientId}><Avatar user={self} small/><div className="message-content"><div className="bubble pending">{m.text}</div><div className="delivery">{state.status === 'online' ? '发送中…' : '等待重连'}</div></div></article>)}{conversation === 'group' && (state.groupMessages ?? []).map(m => <article className={`message ${m.sender === self ? 'mine' : ''} ${m.sender === 'echo' ? 'assistant-message' : ''}`} key={m.id}>{m.sender === 'echo' ? <EchoAvatar/> : <Avatar user={m.sender} small/>}<div className="message-content"><div className="message-meta">{m.sender === 'echo' ? 'Echo · AI' : names[m.sender]}<time>{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>{m.attachment ? <AttachmentMessage attachment={m.attachment} group/> : <div className="bubble">{m.text}</div>}</div></article>)}{conversation === 'group' && state.groupAi?.status && <article className="message assistant-message ai-stream"><EchoAvatar/><div className="message-content"><div className="message-meta">Echo · AI</div><div className={`bubble ${state.groupAi.status === 'streaming' ? 'streaming' : 'failed'}`}>{state.groupAi.status === 'streaming' ? (state.groupAi.text || '正在思考…') : state.groupAi.error}</div>{state.groupAi.status === 'streaming' && state.groupAi.requestId && <button className="stop-ai" onClick={() => void window.darling.groupAiCancel(state.groupAi!.requestId!)}>停止生成</button>}</div></article>}<div/></div></div>
    <div className="composer">{attachments.length > 0 && <div className="pending-attachments">{attachments.map(item => <div key={item.token}><span className="file-type small">{item.image ? 'IMG' : (item.name.split('.').pop()?.slice(0, 4).toUpperCase() || 'FILE')}</span><span>{item.name}</span><button aria-label={`移除 ${item.name}`} onClick={() => removeAttachment(item.token)}>×</button></div>)}</div>}<div className="compose-box"><div className="attachment-trigger" ref={attachmentTrigger}><button className="plus" aria-label="添加附件" aria-expanded={attachmentMenu} onClick={() => setAttachmentMenu(value => !value)}><Icon name="plus"/></button>{attachmentMenu && <div className="attachment-menu"><button onClick={pickAttachments}><Icon name="file"/><span><strong>上传文件</strong><small>图片或其他文件</small></span></button><button onClick={takeScreenshot}><Icon name="camera"/><span><strong>截图</strong><small>框选主显示器区域</small></span></button></div>}</div>{conversation === 'group' && mentionOpen && <div id="echo-mention-menu" className="mention-menu" role="listbox"><button role="option" aria-selected="true" onMouseDown={event => event.preventDefault()} onClick={chooseEcho}><img src={echoAvatar} alt=""/><span><strong>Echo</strong><small>AI 助手 · Enter 选择</small></span></button></div>}<textarea ref={composerInput} aria-label="聊天消息" aria-expanded={conversation === 'group' ? mentionOpen : undefined} aria-controls={conversation === 'group' && mentionOpen ? 'echo-mention-menu' : undefined} placeholder={conversation === 'group' ? '输入消息，使用 @ 可选择 Echo…' : `发送消息给 ${names[peer]}…`} value={draft} maxLength={8000} onChange={e => { const value = e.target.value; setDraft(value); setMentionOpen(conversation === 'group' && !!mentionQuery(value)); }} onKeyDown={e => { if (conversation === 'group' && mentionOpen && (e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) { e.preventDefault(); chooseEcho(); return; } if (e.key === 'Escape' && mentionOpen) { e.preventDefault(); setMentionOpen(false); return; } if (conversation === 'group' && e.key === 'Backspace' && isBareEchoMention(draft)) { e.preventDefault(); setGroupDraft(''); setMentionOpen(false); return; } if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (conversation === 'group' && attachments.length === 0 && isBareEchoMention(draft)) { setGroupDraft(''); setMentionOpen(false); } else void send(); } }}/><button className="send" disabled={(!draft.trim() && attachments.length === 0) || sending || !state.user || ['error', 'replaced'].includes(state.status)} onClick={() => void send()} aria-label="发送"><Icon name="send"/></button></div><div className="compose-footer"><span>{error || (sending ? '正在发送…' : conversation === 'group' ? '@Echo 会在附件上传完成后收到问题 · Enter 发送' : 'Enter 发送 · Shift + Enter 换行')}</span></div></div></main></div>
  </div>;
}
const surface = new URLSearchParams(location.search).get('surface');
createRoot(document.getElementById('root')!).render(surface === 'screenshot' ? <ScreenshotSurface/> : surface === 'remote-control' || surface === 'remote-status' ? <RemoteSurface surface={surface}/> : <App/>);
