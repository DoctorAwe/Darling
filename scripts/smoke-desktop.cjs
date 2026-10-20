// Run with the Electron binary, against the real compiled main/preload/renderer.
const { app, BrowserWindow } = require('electron');
const { join, resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const root = resolve(__dirname, '..');
process.env.DARLING_USER_DATA = join(root, '.local', 'desktop-smoke');
process.env.DARLING_CONFIG = join(root, '.local', 'desktop-smoke', 'missing-config.json');
process.env.DARLING_RTC_DEVICE_EXE = join(root, '.local', 'webrtc', 'src', 'out', 'DarlingRelease', 'darling_rtc_process.exe');
const errors = [];
const visibleCheck = process.env.DARLING_SMOKE_VISIBLE === '1';
let timeout = setTimeout(() => { console.error('Desktop smoke timed out'); app.exit(1); }, 20000);
// No visible window during this automated check.
if (!visibleCheck) BrowserWindow.prototype.show = function () {};
app.on('web-contents-created', (_event, contents) => {
  if (!visibleCheck) contents.setBackgroundThrottling(false);
  contents.on('preload-error', (_event, _path, error) => errors.push(error.message));
  contents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  contents.once('did-finish-load', async () => {
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      const actualWindow = BrowserWindow.fromWebContents(contents);
      if (visibleCheck && (!actualWindow || !actualWindow.isVisible() || actualWindow.isMinimized())) throw new Error('Loaded application window is not visible');
      const first = await contents.executeJavaScript(`({ text: document.body.innerText, bridge: typeof window.darling?.mediaInspect })`);
      if (first.bridge !== 'function' || !first.text.includes('重新加载')) throw new Error('Main page or preload bridge failed');
      await contents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === '音频设备').click()`);
      await new Promise(resolve => setTimeout(resolve, 100));
      const panel = await contents.executeJavaScript(`document.body.innerText`);
      if (!panel.includes('检测设备不会开启麦克风')) throw new Error('Audio panel failed');
      if (!panel.includes('RTC 真实设备测试') || !panel.includes('1200 Hz')) throw new Error('RTC confirmation panel missing');
      if (!panel.includes('尚无统计') || !panel.includes('对端解码')) throw new Error('RTC input metrics explanation missing');
      const rtc = await contents.executeJavaScript(`window.darling.rtcDeviceSnapshot()`);
      if (!rtc.available || rtc.status !== 'idle') throw new Error('RTC diagnostics must start idle');
      const gated = await contents.executeJavaScript(`(() => {
        const button = Array.from(document.querySelectorAll('button')).find(b => b.textContent === '开始 15 秒 RTC 设备测试');
        return !!button && button.disabled;
      })()`);
      if (!gated) throw new Error('RTC test must be disabled without confirmed devices');
      // Stop only; never click Start or check the recording consent box.
      await contents.executeJavaScript(`window.darling.rtcDeviceStop()`);
      let nativeResult;
      if (process.env.DARLING_SMOKE_NATIVE === '1') {
        nativeResult = await contents.executeJavaScript(`window.darling.mediaInspect()`);
        if (nativeResult.status !== 'ready' || !nativeResult.capabilities.devices) throw new Error('Real native engine did not become ready: ' + nativeResult.detail);
        await new Promise(resolve => setTimeout(resolve, 100));
        const renderedCount = await contents.executeJavaScript(`document.querySelectorAll('.device').length`);
        if (renderedCount !== nativeResult.devices.length) throw new Error('Device panel count differs from native response');
        if (nativeResult.capabilities.playback && !await contents.executeJavaScript(`document.body.innerText.includes('播放 1 秒测试音')`)) throw new Error('Playback control not rendered');
      }
      if (errors.length) throw new Error(errors.join('\n'));
      const directory = join(root, '.local', 'desktop-smoke'); mkdirSync(directory, { recursive: true });
      const screenshot = await contents.capturePage(); writeFileSync(join(directory, 'preview.png'), screenshot.toPNG());
      writeFileSync(join(directory, 'result.json'), JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), visibleVerified: visibleCheck && actualWindow.isVisible(), nativeVerified: !!nativeResult, deviceCount: nativeResult?.devices.length }, null, 2));
      console.log('PASS: real Electron main/preload/React render, config error state, audio panel; screenshot saved.');
      clearTimeout(timeout); app.quit();
    } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
  });
});
require(process.env.DARLING_SMOKE_MAIN || '../apps/desktop/dist/main.cjs');
