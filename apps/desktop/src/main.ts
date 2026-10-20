import { app, BrowserWindow, ipcMain } from 'electron';
import { join, resolve } from 'node:path';
import { release } from 'node:os';
import { Session } from './session';
import { MediaHost } from './media';
import { AudioPair, AudioPreferences } from './audio-preferences';
import { resolveAudioPair, defaultCallAudio, isHeadphoneOutput } from './audio-pair';
import { RtcNegotiation } from './rtc-negotiation';
import { RtcDeviceTest } from './rtc-device-test';
import { DeviceAudio } from './rtc-process';
import { existsSync } from 'node:fs';

if (process.env.DARLING_USER_DATA) app.setPath('userData', resolve(process.env.DARLING_USER_DATA));
let session: Session;
let window: BrowserWindow;
let media: MediaHost;
let rtcNegotiation: RtcNegotiation | undefined;
let rtcDeviceTest: RtcDeviceTest;
let quitting = false;
let mediaStarting = false;
let voiceDevices: DeviceAudio | undefined;
let callPreparation = 0;
const voiceBeta = process.env.DARLING_VOICE_BETA === '1' || existsSync(join(__dirname, 'voice-beta.flag'));
void app.whenReady().then(() => {
  const configPath = resolve(process.env.DARLING_CONFIG ?? (voiceBeta ? join(app.getAppPath(), 'config.json') : join(app.getPath('userData'), 'config.json')));
  session = new Session(configPath, app.getPath('userData'));
  // Explicit diagnostic opt-in; never enables invite/accept or real audio.
  if (!voiceBeta && process.env.DARLING_RTC_NEGOTIATION_EXE)
    rtcNegotiation = new RtcNegotiation(session, resolve(process.env.DARLING_RTC_NEGOTIATION_EXE));
  media = new MediaHost(resolve(process.env.DARLING_MEDIA_ENGINE ?? join(__dirname, 'native/darling-media.exe')));
  if (voiceBeta) {
    session.configureVoice(true, true);
    session.voiceStatus('系统默认设备 · 耳机禁用 AEC，其他输出启用 AEC · 降噪开启');
    rtcNegotiation = new RtcNegotiation(session, resolve(process.env.DARLING_RTC_DEVICE_EXE ?? join(__dirname, 'native/darling_rtc_process.exe')), 'relay', () => voiceDevices);
  }
  rtcDeviceTest = new RtcDeviceTest(process.env.DARLING_RTC_DEVICE_EXE ? resolve(process.env.DARLING_RTC_DEVICE_EXE) : undefined);
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
      session.voiceStatus(voiceDevices.outputProfile === 'headphones' ? '系统默认耳机 · AEC 强制关闭 · 降噪开启' : '系统默认输出 · AEC 开启 · 降噪开启');
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
  ipcMain.on('window:action', (_event, action: unknown) => {
    if (action === 'close') window.close();
    else if (action === 'minimize') window.minimize();
    else if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
  });
  session.on('state', state => { if (!window.isDestroyed()) window.webContents.send('session:state', state); });
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
  if (!quitting && media) { event.preventDefault(); quitting = true; void Promise.all([rtcStopped, rtcDeviceTest?.stop(), media.stop()]).finally(() => app.quit()); }
});
