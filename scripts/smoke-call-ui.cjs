const { app, BrowserWindow, ipcMain } = require('electron');
const { join, resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const root = resolve(__dirname, '..');
const directory = join(root, '.local/call-ui-smoke'); mkdirSync(directory, { recursive: true });
process.env.DARLING_CONFIG = join(directory, 'missing.json');
process.env.DARLING_USER_DATA = directory;
BrowserWindow.prototype.show = function () {};
const watchdog = setTimeout(() => app.exit(1), 20000);
app.on('web-contents-created', (_, contents) => {
  contents.setBackgroundThrottling(false);
  contents.once('did-finish-load', async () => {
    try {
      await new Promise(r => setTimeout(r, 400));
      const controls = [];
      ipcMain.removeHandler('voice:audio');
      ipcMain.handle('voice:audio', (_event, id, mic, speaker) => { controls.push({id,mic,speaker}); });
      // Exercise real scheduling and lifecycle while suppressing audible output.
      await contents.executeJavaScript(`window.toneChecks={starts:0,closes:0}; const RealAudioContext=window.AudioContext; window.AudioContext=class extends RealAudioContext { createGain(){const gain=super.createGain(); const nativeConnect=gain.connect.bind(gain); gain.connect=(destination)=>destination===this.destination?destination:nativeConnect(destination); return gain;} createOscillator(){window.toneChecks.starts++; return super.createOscillator();} close(){window.toneChecks.closes++; return super.close();} }; void 0;`);
      const state = { status:'online', user:'dva', online:['dva','mercy'], messages:[], pending:[], detail:'已连接', configPath:'', mediaAvailable:true, voiceBeta:true,
        call:{callId:'00000000-0000-4000-8000-000000000001',caller:'mercy',callee:'dva',phase:'ringing',deadline:Date.now()+30000} };
      contents.send('session:state',state); await new Promise(r=>setTimeout(r,350));
      assert.equal(await contents.executeJavaScript(`!!document.querySelector('.call-accept:not(:disabled)') && !!document.querySelector('.call-reject')`),true);
      writeFileSync(join(directory,'incoming.png'),(await contents.capturePage()).toPNG());
      state.call.phase='active'; state.remoteAudio={level:.1,sampledAt:Date.now()};
      contents.send('session:state',state); await new Promise(r=>setTimeout(r,1200));
      assert.equal(await contents.executeJavaScript(`document.querySelector('[aria-label="通话时长"]').textContent`),'00:01');
      assert.equal(await contents.executeJavaScript(`window.toneChecks.closes`),1);
      writeFileSync(join(directory,'active.png'),(await contents.capturePage()).toPNG());
      await contents.executeJavaScript("document.querySelector('[title=\"静音麦克风\"]').click()");
      await new Promise(r=>setTimeout(r,100));
      assert.equal(controls.at(-1).mic,true);
      assert.equal(await contents.executeJavaScript("document.querySelector('[title=\"开启麦克风\"]').getAttribute('aria-pressed')"),'true');
      await contents.executeJavaScript("document.querySelector('[title=\"静音对方声音\"]').click()");
      await new Promise(r=>setTimeout(r,100));
      assert.equal(controls.at(-1).speaker,true);
      const win=BrowserWindow.fromWebContents(contents);
      win.setSize(780,580); await new Promise(r=>setTimeout(r,150));
      assert.equal(await contents.executeJavaScript("document.documentElement.scrollWidth <= innerWidth"),true);
      writeFileSync(join(directory,'compact-muted.png'),(await contents.capturePage()).toPNG());
      state.call.phase='ended'; contents.send('session:state',state); await new Promise(r=>setTimeout(r,100));
      assert.equal(await contents.executeJavaScript(`document.querySelector('.voice-bars')===null`),true);
      state.call={...state.call,callId:'00000000-0000-4000-8000-000000000002',caller:'dva',callee:'mercy',phase:'ringing'};
      contents.send('session:state',state); await new Promise(r=>setTimeout(r,300));
      assert.equal(await contents.executeJavaScript(`window.toneChecks.starts`),6);
      state.call.phase='ended'; contents.send('session:state',state); await new Promise(r=>setTimeout(r,100));
      assert.equal(await contents.executeJavaScript(`window.toneChecks.closes`),2);
      writeFileSync(join(directory,'result.json'),JSON.stringify({passed:true,checkedAt:new Date().toISOString(),audibleOutput:false}));
      clearTimeout(watchdog); app.quit();
    } catch(error) { console.error(error); clearTimeout(watchdog); app.exit(1); }
  });
});
require('../apps/desktop/dist/main.cjs');
