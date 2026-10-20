// Does not start audio. Device testing still requires an explicit UI confirmation.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some(arg => !['--check', '--user=dva', '--user=mercy'].includes(arg)) || args.filter(arg => arg.startsWith('--user=')).length > 1)
  throw new Error('Usage: node scripts/start-device-diagnostic.mjs [--check] [--user=dva|--user=mercy]');
const user = args.includes('--user=mercy') ? 'mercy' : 'dva';
const require = createRequire(import.meta.url);
const electron = require('electron');
const rtc = join(root, '.local/webrtc/src/out/DarlingRelease/darling_rtc_process.exe');
const media = join(root, 'apps/desktop/dist/native/darling-media.exe');
const config = join(root, `.local/${user}.config.json`);
for (const [label, path] of Object.entries({ electron, rtc, media, config, main: join(root, 'apps/desktop/dist/main.cjs'), preload: join(root, 'apps/desktop/dist/preload.cjs'), renderer: join(root, 'apps/desktop/dist/renderer/index.html') })) {
  if (!existsSync(path)) throw new Error(`Missing ${label}; rebuild or configure the diagnostic client first.`);
}
console.log(`Ready: ${user}; RTC diagnostic entry enabled; no audio starts automatically.`);
if (!args.includes('--check')) {
  const env = { ...process.env, DARLING_CONFIG: config, DARLING_MEDIA_ENGINE: media, DARLING_RTC_DEVICE_EXE: rtc,
    DARLING_USER_DATA: join(root, `.local/device-diagnostic-${user}`) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DARLING_RTC_NEGOTIATION_EXE;
  console.log('Starting client. Login may replace this account’s existing session. Lower output volume before explicitly starting the 15-second test.');
  // This is the user-facing application, not a hidden native audio helper.
  const child = spawn(electron, [join(root, 'apps/desktop')], { cwd: root, env, windowsHide: false, stdio: 'inherit' });
  child.on('error', () => { console.error('Could not start diagnostic client'); process.exitCode = 1; });
  child.on('exit', (code, signal) => { console.log(`Client exited: ${signal ?? code}`); process.exitCode = code ?? 1; });
}
