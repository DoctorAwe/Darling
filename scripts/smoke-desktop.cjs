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
      if (new URL(contents.getURL()).searchParams.get('surface') === 'screenshot') {
        await new Promise(resolve => setTimeout(resolve, 150));
        const coverage = await contents.executeJavaScript(`({ width: innerWidth, height: innerHeight, screenWidth: screen.width, screenHeight: screen.height, imageReady: !!document.querySelector('.screenshot-surface > img') })`);
        if (Math.abs(coverage.width - coverage.screenWidth) > 1 || Math.abs(coverage.height - coverage.screenHeight) > 1) throw new Error('Screenshot selector does not cover the full primary display: ' + JSON.stringify(coverage));
        if (!coverage.imageReady) throw new Error('Screenshot selector image was not ready promptly');
        await contents.executeJavaScript(`window.darling.screenshotComplete({ x: 10, y: 10, width: 64, height: 48 })`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
      const actualWindow = BrowserWindow.fromWebContents(contents);
      if (visibleCheck && (!actualWindow || !actualWindow.isVisible() || actualWindow.isMinimized())) throw new Error('Loaded application window is not visible');
      const first = await contents.executeJavaScript(`({ text: document.body.innerText, bridge: typeof window.darling?.mediaInspect, attachmentBridge: typeof window.darling?.attachmentPick })`);
      if (first.bridge !== 'function' || first.attachmentBridge !== 'function' || !first.text.includes('重试')) throw new Error('Main page or preload bridge failed');
      await contents.executeJavaScript(`document.querySelector('button[aria-label="添加附件"]').click()`);
      const attachmentMenu = await contents.executeJavaScript(`document.body.innerText`);
      if (!attachmentMenu.includes('上传文件') || !attachmentMenu.includes('截图')) throw new Error('Attachment menu failed');
      await contents.executeJavaScript(`document.querySelector('h1').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
      await new Promise(resolve => setTimeout(resolve, 50));
      if (await contents.executeJavaScript(`document.body.innerText.includes('上传文件')`)) throw new Error('Attachment menu did not close on outside click');
      await contents.executeJavaScript(`document.querySelector('button[aria-label="添加附件"]').click()`);
      await new Promise(resolve => setTimeout(resolve, 50));
      await contents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await new Promise(resolve => setTimeout(resolve, 50));
      if (await contents.executeJavaScript(`document.body.innerText.includes('上传文件')`)) throw new Error('Attachment menu did not close on Escape');
      await contents.executeJavaScript(`document.querySelector('.group-contact').click()`);
      await new Promise(resolve => setTimeout(resolve, 50));
      const groupComposer = await contents.executeJavaScript(`(() => {
        const input = document.querySelector('textarea');
        return { value: input.value, groupIcon: !!document.querySelector('.group-avatar img.echo')?.getAttribute('src') };
      })()`);
      if (groupComposer.value !== '@Echo ' || !groupComposer.groupIcon) throw new Error('Group composer or Echo group icon failed: ' + JSON.stringify(groupComposer));
      await contents.executeJavaScript(`(() => { const input = document.querySelector('textarea'); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      await new Promise(resolve => setTimeout(resolve, 50));
      if (await contents.executeJavaScript(`document.querySelector('textarea').value`) !== '') throw new Error('Bare @Echo was not cleared by Enter');
      const mention = await contents.executeJavaScript(`(() => { const input = document.querySelector('textarea'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(input, '@'); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await new Promise(resolve => setTimeout(resolve, 50));
      const mentionVisible = await contents.executeJavaScript(`!!document.querySelector('.mention-menu') && document.body.innerText.includes('AI 助手 · Enter 选择')`);
      if (!mention || !mentionVisible) throw new Error('Echo mention menu failed');
      await contents.executeJavaScript(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      await new Promise(resolve => setTimeout(resolve, 50));
      const completedMention = await contents.executeJavaScript(`({ value: document.querySelector('textarea').value, menu: !!document.querySelector('.mention-menu') })`);
      if (completedMention.value !== '@Echo ' || completedMention.menu) throw new Error('Echo mention keyboard selection failed: ' + JSON.stringify(completedMention));
      await new Promise(resolve => setTimeout(resolve, 100));
      const groupScreenshot = (await contents.capturePage()).toPNG();
      await contents.executeJavaScript(`document.querySelector('.contact:not(.group-contact)').click()`);
      const blobImage = await contents.executeJavaScript(`new Promise(resolve => { const image = new Image(); const url = URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'], { type: 'image/svg+xml' })); image.onload = () => { URL.revokeObjectURL(url); resolve(true); }; image.onerror = () => { URL.revokeObjectURL(url); resolve(false); }; image.src = url; document.body.appendChild(image); })`);
      if (!blobImage) throw new Error('Blob attachment preview is blocked by page policy');
      const selectedScreenshot = await contents.executeJavaScript(`window.darling.attachmentScreenshot()`);
      if (!selectedScreenshot?.image || selectedScreenshot.mime !== 'image/png' || selectedScreenshot.size <= 0) throw new Error('Screenshot selection did not create a cropped PNG');
      await contents.executeJavaScript(`window.darling.attachmentDiscard(${JSON.stringify(selectedScreenshot.token)})`);
      await contents.executeJavaScript(`document.querySelector('button[aria-label="设置"]').click()`);
      await new Promise(resolve => setTimeout(resolve, 100));
      await contents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === '音频诊断').click()`);
      await new Promise(resolve => setTimeout(resolve, 100));
      const panel = await contents.executeJavaScript(`document.body.innerText`);
      if (!panel.includes('检测设备不会开启麦克风')) throw new Error('Audio panel failed');
      const rtc = await contents.executeJavaScript(`window.darling.rtcDeviceSnapshot()`);
      if (!['idle', 'unavailable'].includes(rtc.status)) throw new Error('RTC diagnostics entered an unexpected state: ' + JSON.stringify(rtc));
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
      writeFileSync(join(directory, 'group-preview.png'), groupScreenshot);
      writeFileSync(join(directory, 'result.json'), JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), visibleVerified: visibleCheck && actualWindow.isVisible(), nativeVerified: !!nativeResult, deviceCount: nativeResult?.devices.length }, null, 2));
      console.log('PASS: real Electron main/preload/React render, attachment menu, config error state and audio panel; screenshot saved.');
      clearTimeout(timeout); app.quit();
    } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
  });
});
require(process.env.DARLING_SMOKE_MAIN || '../apps/desktop/dist/main.cjs');
