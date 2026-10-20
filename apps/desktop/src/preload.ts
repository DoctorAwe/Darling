import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, Snapshot } from '../../../packages/protocol/src/index';
import type { MediaState } from '../../../packages/protocol/src/media';
const api: DesktopApi = {
  voiceConfigure: value => ipcRenderer.invoke('voice:configure', value),
  rtcDeviceSnapshot: () => ipcRenderer.invoke('rtc-device:snapshot'),
  rtcDeviceStart: value => ipcRenderer.invoke('rtc-device:start', value),
  rtcDeviceStop: () => ipcRenderer.invoke('rtc-device:stop'),
  snapshot: () => ipcRenderer.invoke('session:snapshot'),
  send: text => ipcRenderer.invoke('session:send', text),
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
