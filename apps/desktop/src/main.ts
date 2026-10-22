import { app, BrowserWindow, desktopCapturer, ipcMain, screen, session as electronSession, webContents } from 'electron';
import { join, resolve } from 'node:path';
import { release } from 'node:os';
import { Session } from './session';
import { MediaHost } from './media';
import { AudioPair, AudioPreferences } from './audio-preferences';
import { resolveAudioPair, defaultCallAudio, isHeadphoneOutput } from './audio-pair';
import { RtcNegotiation } from './rtc-negotiation';
import { RtcDeviceTest } from './rtc-device-test';
import { DeviceAudio } from './rtc-process';
import { appendFileSync, existsSync } from 'node:fs';
import { resolveAec3Enabled } from './aec-mode';
import { RemoteSignal } from '../../../packages/protocol/src/index';
import { RemoteInputGate, RemoteInputHost } from './remote-input';

if (process.env.DARLING_USER_DATA) app.setPath('userData', resolve(process.env.DARLING_USER_DATA));
let session: Session;
let window: BrowserWindow;
let remoteControlWindow: BrowserWindow | undefined;
let remoteStatusWindow: BrowserWindow | undefined;
let remoteInput: RemoteInputHost;
const remoteInputGate = new RemoteInputGate();
const pendingRemoteSignals: Array<ReturnType<typeof RemoteSignal.parse>> = [];
let media: MediaHost;
let rtcNegotiation: RtcNegotiation | undefined;
let rtcDeviceTest: RtcDeviceTest;
let quitting = false;
let mediaStarting = false;
let voiceDevices: DeviceAudio | undefined;
let callPreparation = 0;
const voiceBeta = process.env.DARLING_VOICE_BETA === '1' || existsSync(join(__dirname, 'voice-beta.flag'));
const aec3PackageMarker = existsSync(join(__dirname, 'aec3-experiment.flag'));
const requestedAec = process.env.DARLING_AEC_EXPERIMENT;
// AEC3 is the mainline voice path. PBFDAF remains an explicit developer fallback.
const aec3Enabled = resolveAec3Enabled(voiceBeta, requestedAec);
const packagedRtc = aec3PackageMarker ? 'darling_rtc_aec3_experimental.exe' : 'darling_rtc_process.exe';
const rtcExecutable = resolve(process.env.DARLING_RTC_DEVICE_EXE ?? join(__dirname, 'native', packagedRtc));
const voiceDescription = `系统默认设备 · ${aec3Enabled ? 'WebRTC AEC3' : 'PBFDAF 回退模式'} · RNNoise 降噪`;
void app.whenReady().then(() => {
  const configPath = resolve(process.env.DARLING_CONFIG ?? (voiceBeta ? join(app.getAppPath(), 'config.json') : join(app.getPath('userData'), 'config.json')));
  session = new Session(configPath, app.getPath('userData'));
  remoteInput = new RemoteInputHost(resolve(join(__dirname, 'native/darling-remote-input.exe')));
  // Explicit diagnostic opt-in; never enables invite/accept or real audio.
  if (!voiceBeta && process.env.DARLING_RTC_NEGOTIATION_EXE)
    rtcNegotiation = new RtcNegotiation(session, resolve(process.env.DARLING_RTC_NEGOTIATION_EXE));
  media = new MediaHost(resolve(process.env.DARLING_MEDIA_ENGINE ?? join(__dirname, 'native/darling-media.exe')));
  if (voiceBeta) {
    session.configureVoice(true, true);
    session.voiceStatus(voiceDescription);
    rtcNegotiation = new RtcNegotiation(session, rtcExecutable, 'relay', () => voiceDevices, undefined, aec3Enabled);
  }
  rtcDeviceTest = new RtcDeviceTest(voiceBeta ? rtcExecutable : undefined, undefined, aec3Enabled);
  const preferences=new AudioPreferences(join(app.getPath('userData'),'audio-preferences.json'));
  const validatePair=(value:unknown)=>{
    const pair=AudioPair.parse(value);
    if (media.state.status!=='ready' || !resolveAudioPair(media.state.devices,pair.inputId,pair.outputId)) throw new Error('请重新检测音频设备');
    return pair;
  };
  const acrylic = process.platform === 'win32' && Number(release().split('.')[2]) >= 22621;
  window = new BrowserWindow({
    width: 1120, height: 780, minWidth: 780, minHeight: 580, frame: false,
    roundedCorners: true, backgroundColor: acrylic ? '#00000000' : '#10121c',
    ...(acrylic ? { backgroundMaterial: 'acrylic' as const } : {}),
    title: 'Darling', show: false,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
  });
  ipcMain.handle('session:snapshot', () => structuredClone(session.state));
  ipcMain.handle('remote:action', (_event, action: unknown, sessionId: unknown, permissions: unknown) => session.remoteAction(action, sessionId, permissions));
  ipcMain.handle('remote:permissions', (_event, sessionId: unknown, permissions: unknown) => session.remotePermissions(sessionId, permissions));
  ipcMain.handle('remote:ice', async () => { await session.refreshIce(); const ice = session.getIceConfig(); if (!ice) throw new Error('中继配置不可用'); return ice; });
  ipcMain.handle('remote:signal', (_event, value: unknown) => session.sendRemoteSignal(RemoteSignal.parse(value)));
  ipcMain.handle('remote:ready', (_event, sessionId: unknown) => { if (typeof sessionId !== 'string' || session.state.remote?.sessionId !== sessionId) throw new Error('远程桌面会话已变化'); session.remoteReady(sessionId); });
  ipcMain.handle('remote:drain-signals', (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || session.state.remote?.sessionId !== sessionId) return [];
    return pendingRemoteSignals.splice(0).filter(signal => signal.sessionId === sessionId);
  });
  ipcMain.handle('remote:input', async (event, sessionId: unknown, value: unknown) => {
    const remote = session.state.remote;
    if (typeof sessionId !== 'string' || !remote || remote.sessionId !== sessionId || remote.controlled !== session.state.user || !remote.permissions.control || !['connecting', 'active'].includes(remote.phase) || !remoteStatusWindow || remoteStatusWindow.isDestroyed() || event.sender.id !== remoteStatusWindow.webContents.id) throw new Error('当前未授权远程操作');
    await remoteInput.send(remoteInputGate.parse(value));
  });
  ipcMain.handle('remote:diagnostic', (event, sessionId: unknown, stage: unknown, detail: unknown) => {
    const remote = session.state.remote;
    const allowedSender = [remoteControlWindow, remoteStatusWindow].some(target => target && !target.isDestroyed() && target.webContents.id === event.sender.id);
    if (typeof sessionId !== 'string' || remote?.sessionId !== sessionId || typeof stage !== 'string' || typeof detail !== 'string' || stage.length > 64 || detail.length > 500 || !allowedSender) return;
    appendFileSync(join(app.getPath('userData'), 'remote-desktop.log'), `${JSON.stringify({ at: new Date().toISOString(), sessionId, role: remote.controller === session.state.user ? 'controller' : 'controlled', stage, detail })}\n`, 'utf8');
  });
  ipcMain.handle('voice:audio', async (_event, callId: unknown, micMuted: unknown, speakerMuted: unknown) => {
    if (typeof callId !== 'string' || typeof micMuted !== 'boolean' || typeof speakerMuted !== 'boolean' ||
        session.state.call?.callId !== callId || session.state.call.phase !== 'active' || !rtcNegotiation) throw new Error('当前无法调整通话');
    await rtcNegotiation.setAudio(callId, micMuted, speakerMuted);
  });
  ipcMain.handle('session:send', (_event, text: unknown) => typeof text === 'string' ? session.send(text) : { ok: false, error: '无效消息' });
  ipcMain.handle('session:reload', () => session.start());
  ipcMain.handle('voice:configure', (_event, value: unknown) => {
    if (!voiceBeta || (session.state.call && session.state.call.phase !== 'ended') || rtcDeviceTest.active || mediaStarting || media.state.capture?.running || media.state.playback?.running) throw new Error('当前不能配置通话设备');
    const audio = DeviceAudio.parse(value); validatePair({ inputId: audio.inputDeviceId, outputId: audio.outputDeviceId });
    if (isHeadphoneOutput(media.state.devices, audio.outputDeviceId)) audio.outputProfile = 'headphones';
    voiceDevices = audio; session.configureVoice(true, true); session.voiceStatus('设备已确认 · 点击发起或接听才开启麦克风');
  });
  ipcMain.handle('session:call-action', async (_event, action: unknown, callId: unknown) => {
    if (action === 'end') { ++callPreparation; void rtcNegotiation?.stop(); return session.callAction(action, callId); }
    if (!voiceBeta) return { ok: false, error: '当前版本未启用语音' };
    if (action !== 'invite' && action !== 'accept') return { ok: false, error: '无效通话操作' };
    if (session.state.call && ['connecting', 'active'].includes(session.state.call.phase)) return { ok: false, error: '通话已在进行' };
    if (rtcDeviceTest.active || mediaStarting || media.state.capture?.running || media.state.playback?.running) return { ok: false, error: '请先停止设备测试' };
    const preparation = ++callPreparation;
    mediaStarting = true;
    try {
      await media.inspect();
      voiceDevices = DeviceAudio.parse(defaultCallAudio(media.state.devices));
      session.voiceStatus(voiceDescription);
      await session.refreshIce();
      if (preparation !== callPreparation || quitting) return { ok: false, error: '通话操作已取消' };
      validatePair({ inputId: voiceDevices.inputDeviceId, outputId: voiceDevices.outputDeviceId });
      return session.callAction(action, callId);
    } catch { return { ok: false, error: '无法准备系统默认音频设备或中继，请检查 Windows 默认输入/输出和网络' }; }
    finally { mediaStarting = false; }
  });
  ipcMain.handle('media:snapshot', () => structuredClone(media.state));
  ipcMain.handle('rtc-device:snapshot', () => structuredClone(rtcDeviceTest.state));
  ipcMain.handle('rtc-device:stop', () => rtcDeviceTest.stop());
  ipcMain.handle('rtc-device:start', async (_event, value: unknown) => {
    const audio = DeviceAudio.parse(value);
    if (mediaStarting || media.state.capture?.running || media.state.playback?.running || (session.state.call && session.state.call.phase !== 'ended')) throw new Error('请先停止其他音频测试或通话');
    validatePair({ inputId: audio.inputDeviceId, outputId: audio.outputDeviceId });
    if (isHeadphoneOutput(media.state.devices, audio.outputDeviceId)) audio.outputProfile = 'headphones';
    await rtcDeviceTest.start(audio);
  });
  ipcMain.handle('media:inspect', async () => { await media.inspect(); return structuredClone(media.state); });
  ipcMain.handle('media:preference-get',(_event,pair:unknown)=>preferences.get(validatePair(pair)));
  ipcMain.handle('media:preference-set',(_event,value:unknown,enabled:unknown)=>{
    const pair=validatePair(value);
    if (typeof enabled!=='boolean') throw new Error('无效回声设置');
    if (media.state.capture?.running || media.state.playback?.running) throw new Error('请先停止音频测试');
    if (enabled && (!media.state.capabilities.aec || !media.state.capabilities.aecControl)) throw new Error('当前引擎无法启用 AEC');
    return preferences.set(pair,enabled);
  });
  ipcMain.handle('media:capture-start', async (_event, deviceId: unknown, aecEnabled: unknown = false) => {
    if (rtcDeviceTest.active || mediaStarting || (session.state.call && session.state.call.phase !== 'ended')) throw new Error('请先停止 RTC 测试或通话');
    if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 4096) throw new Error('无效音频设备');
    if (typeof aecEnabled !== 'boolean') throw new Error('无效回声处理设置');
    mediaStarting = true;
    try { await media.startCapture(deviceId, aecEnabled); return structuredClone(media.state); }
    finally { mediaStarting = false; }
  });
  ipcMain.handle('media:capture-stop', async () => { await media.stopCapture(); return structuredClone(media.state); });
  ipcMain.handle('media:playback-start', async (_event, deviceId: unknown) => {
    if (rtcDeviceTest.active || mediaStarting || (session.state.call && session.state.call.phase !== 'ended')) throw new Error('请先停止 RTC 测试或通话');
    if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 4096) throw new Error('无效输出设备');
    mediaStarting = true;
    try { await media.startPlayback(deviceId); return structuredClone(media.state); }
    finally { mediaStarting = false; }
  });
  ipcMain.handle('media:playback-stop', async () => { await media.stopPlayback(); return structuredClone(media.state); });
  window.webContents.on('render-process-gone', () => { void rtcNegotiation?.stop(); if (session.state.call && session.state.call.phase !== 'ended') session.callAction('end', session.state.call.callId); void rtcDeviceTest.stop(); void media.stop(); });
  window.webContents.on('did-start-loading', () => { void rtcDeviceTest.stop(); if (session.state.call && session.state.call.phase !== 'ended') { void rtcNegotiation?.stop(); session.callAction('end', session.state.call.callId); } });
  media.on('state', state => { if (!window.isDestroyed()) window.webContents.send('media:state', state); });
  ipcMain.on('window:action', (event, action: unknown) => {
    const target = BrowserWindow.fromWebContents(event.sender); if (!target) return;
    if (action === 'close') target.close();
    else if (action === 'minimize') target.minimize();
    else if (action === 'maximize' && target.isMaximizable()) target.isMaximized() ? target.unmaximize() : target.maximize();
  });
  const openRemoteSurface = (surface: 'remote-control' | 'remote-status') => {
    const controlled = surface === 'remote-status';
    const remoteWindow = new BrowserWindow({
      width: controlled ? 620 : 1280, height: controlled ? 78 : 800,
      minWidth: controlled ? 620 : 900, minHeight: controlled ? 78 : 600,
      frame: !controlled, resizable: !controlled, maximizable: !controlled,
      autoHideMenuBar: true,
      alwaysOnTop: controlled, skipTaskbar: controlled, backgroundColor: '#10131b',
      title: controlled ? 'Darling 远程控制状态' : 'Darling 远程桌面', show: false,
      webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
    });
    remoteWindow.setMenu(null);
    remoteWindow.setMenuBarVisibility(false);
    remoteWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    remoteWindow.webContents.on('will-navigate', event => event.preventDefault());
    remoteWindow.webContents.on('render-process-gone', (_event, details) => {
      const remote = session.state.remote;
      if (remote) appendFileSync(join(app.getPath('userData'), 'remote-desktop.log'), `${JSON.stringify({ at: new Date().toISOString(), sessionId: remote.sessionId, role: surface, stage: 'renderer-gone', detail: `${details.reason}:${details.exitCode}` })}\n`, 'utf8');
    });
    remoteWindow.once('ready-to-show', () => {
      if (controlled) {
        const { x, y, width } = screen.getPrimaryDisplay().workArea;
        remoteWindow.setPosition(Math.round(x + (width - remoteWindow.getBounds().width) / 2), y, false);
      } else remoteWindow.maximize();
      remoteWindow.show();
    });
    void remoteWindow.loadFile(join(__dirname, 'renderer/index.html'), { query: { surface } });
    remoteWindow.on('closed', () => { if (surface === 'remote-control') remoteControlWindow = undefined; else remoteStatusWindow = undefined; });
    return remoteWindow;
  };
  electronSession.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const remote = session.state.remote;
    const requester = request.frame ? webContents.fromFrame(request.frame) : undefined;
    if (!remote || remote.controlled !== session.state.user || !['connecting', 'active'].includes(remote.phase) || !remoteStatusWindow || remoteStatusWindow.isDestroyed() || requester?.id !== remoteStatusWindow.webContents.id) return callback({});
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    const primaryId = String(screen.getPrimaryDisplay().id);
    const primary = sources.find(source => source.display_id === primaryId) ?? sources[0]; if (!primary) return callback({});
    callback({ video: primary, ...(request.audioRequested && remote.permissions.audio ? { audio: 'loopback' as const } : {}) });
  });
  const syncRemoteWindows = (state: typeof session.state) => {
    const remote = state.remote; const live = remote && ['connecting', 'active'].includes(remote.phase);
    const controller = !!remote && remote.controller === state.user && (live || remote.phase === 'ended');
    const controlled = live && remote.controlled === state.user;
    if (controller && !remoteControlWindow) remoteControlWindow = openRemoteSurface('remote-control');
    if (controlled && !remoteStatusWindow) remoteStatusWindow = openRemoteSurface('remote-status');
    if (!controller && remoteControlWindow) { remoteControlWindow.destroy(); remoteControlWindow = undefined; }
    if (!controlled && remoteStatusWindow) { remoteStatusWindow.destroy(); remoteStatusWindow = undefined; }
    if (!controlled || !remote?.permissions.control) void remoteInput.stop();
  };
  session.on('state', state => {
    for (const target of [window, remoteControlWindow, remoteStatusWindow]) if (target && !target.isDestroyed()) target.webContents.send('session:state', state);
    syncRemoteWindows(state);
  });
  session.on('remote.signal', value => {
    const signal = RemoteSignal.parse(value); pendingRemoteSignals.push(signal); if (pendingRemoteSignals.length > 128) pendingRemoteSignals.shift();
    for (const target of [remoteControlWindow, remoteStatusWindow]) if (target && !target.isDestroyed()) target.webContents.send('remote:signal', signal);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  const showWindow = () => { if (!window.isDestroyed() && !window.isVisible()) window.show(); };
  window.once('ready-to-show', showWindow);
  // Do not leave a loaded page invisible if Windows suppresses the initial paint.
  window.webContents.once('did-finish-load', showWindow);
  void window.loadFile(join(__dirname, 'renderer/index.html')).catch(() => {
    console.error('Darling renderer failed to load'); showWindow();
  });
  session.start();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  const rtcStopped = rtcNegotiation?.dispose();
  session?.stop();
  if (!quitting && media) { event.preventDefault(); quitting = true; void Promise.all([rtcStopped, rtcDeviceTest?.stop(), media.stop(), remoteInput?.stop()]).finally(() => app.quit()); }
});
