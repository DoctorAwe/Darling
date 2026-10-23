import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, Snapshot } from '../../../packages/protocol/src/index';
import type { MediaState } from '../../../packages/protocol/src/media';
const api: DesktopApi = {
  callAudio: (callId, micMuted, speakerMuted) => ipcRenderer.invoke('voice:audio', callId, micMuted, speakerMuted),
  remoteAction: (action, sessionId, permissions) => ipcRenderer.invoke('remote:action', action, sessionId, permissions),
  remotePermissions: (sessionId, permissions) => ipcRenderer.invoke('remote:permissions', sessionId, permissions),
  remoteIceConfig: () => ipcRenderer.invoke('remote:ice'),
  remoteCaptureSource: () => ipcRenderer.invoke('remote:capture-source'),
  remoteSignal: signal => ipcRenderer.invoke('remote:signal', signal),
  remoteReady: sessionId => ipcRenderer.invoke('remote:ready', sessionId),
  remoteDrainSignals: sessionId => ipcRenderer.invoke('remote:drain-signals', sessionId),
  subscribeRemoteSignal: listener => {
    const handler = (_event: Electron.IpcRendererEvent, signal: Parameters<typeof listener>[0]) => listener(signal);
    ipcRenderer.on('remote:signal', handler);
    return () => ipcRenderer.removeListener('remote:signal', handler);
  },
  remoteInput: (sessionId, event) => ipcRenderer.invoke('remote:input', sessionId, event),
  remoteDiagnostic: (sessionId, stage, detail) => ipcRenderer.invoke('remote:diagnostic', sessionId, stage, detail),
  voiceConfigure: value => ipcRenderer.invoke('voice:configure', value),
  rtcDeviceSnapshot: () => ipcRenderer.invoke('rtc-device:snapshot'),
  rtcDeviceStart: value => ipcRenderer.invoke('rtc-device:start', value),
  rtcDeviceStop: () => ipcRenderer.invoke('rtc-device:stop'),
  snapshot: () => ipcRenderer.invoke('session:snapshot'),
  send: text => ipcRenderer.invoke('session:send', text),
  attachmentPick: () => ipcRenderer.invoke('attachment:pick'),
  attachmentScreenshot: () => ipcRenderer.invoke('attachment:screenshot'),
  subscribeScreenshot: listener => {
    const handler = (_event: Electron.IpcRendererEvent, jpeg: Uint8Array) => listener(jpeg);
    ipcRenderer.on('screenshot:image', handler);
    return () => ipcRenderer.removeListener('screenshot:image', handler);
  },
  screenshotReady: () => ipcRenderer.send('screenshot:ready'),
  screenshotComplete: selection => ipcRenderer.send('screenshot:complete', selection),
  attachmentDiscard: token => ipcRenderer.invoke('attachment:discard', token),
  attachmentSend: token => ipcRenderer.invoke('attachment:send', token),
  attachmentRead: id => ipcRenderer.invoke('attachment:read', id),
  attachmentSave: (id, suggestedName) => ipcRenderer.invoke('attachment:save', id, suggestedName),
  reload: () => ipcRenderer.invoke('session:reload'),
  callAction: (action, callId) => ipcRenderer.invoke('session:call-action', action, callId),
  mediaSnapshot: () => ipcRenderer.invoke('media:snapshot'),
  mediaInspect: () => ipcRenderer.invoke('media:inspect'),
  audioPreferenceGet: pair => ipcRenderer.invoke('media:preference-get',pair),
  audioPreferenceSet: (pair,enabled) => ipcRenderer.invoke('media:preference-set',pair,enabled),
  captureStart: (deviceId, aecEnabled = false) => ipcRenderer.invoke('media:capture-start', deviceId, aecEnabled),
  captureStop: () => ipcRenderer.invoke('media:capture-stop'),
  playbackStart: deviceId => ipcRenderer.invoke('media:playback-start', deviceId),
  playbackStop: () => ipcRenderer.invoke('media:playback-stop'),
  subscribeMedia: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: MediaState) => listener(state);
    ipcRenderer.on('media:state', handler);
    return () => ipcRenderer.removeListener('media:state', handler);
  },
  window: action => ipcRenderer.send('window:action', action),
  subscribe: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: Snapshot) => listener(state);
    ipcRenderer.on('session:state', handler);
    return () => ipcRenderer.removeListener('session:state', handler);
  },
};
contextBridge.exposeInMainWorld('darling', api);
