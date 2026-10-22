import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some(arg => !['--check', '--user=dva', '--user=mercy'].includes(arg)) || args.filter(arg => arg.startsWith('--user=')).length !== 1)
  throw new Error('Usage: node scripts/start-aec3-experiment.mjs --user=dva|--user=mercy [--check]');
const user = args.includes('--user=dva') ? 'dva' : 'mercy';
const output = join(root, '.local/aec3-experiment');
const paths = {
  main: join(output, 'main.cjs'), preload: join(output, 'preload.cjs'),
  renderer: join(output, 'renderer/index.html'),
  rtc: join(output, 'native/darling_rtc_aec3_experimental.exe'),
  noise: join(output, 'native/darling_rnnoise.dll'),
  media: join(output, 'native/darling-media.exe'),
  config: join(root, `.local/${user}.config.json`),
};
for (const [label, path] of Object.entries(paths))
  if (!existsSync(path)) throw new Error(`Missing ${label}; build the experiment and provide the account config first.`);
console.log(`Ready: ${user}; official AEC3 -> RNNoise. Experimental, not quality-approved.`);
if (!args.includes('--check')) {
  const electron = createRequire(import.meta.url)('electron');
  const env = { ...process.env, DARLING_VOICE_BETA: '1', DARLING_AEC_EXPERIMENT: 'webrtc-aec3',
    DARLING_RTC_DEVICE_EXE: paths.rtc, DARLING_MEDIA_ENGINE: paths.media, DARLING_CONFIG: paths.config,
    DARLING_USER_DATA: join(root, `.local/aec3-experiment-user-${user}`) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DARLING_RTC_NEGOTIATION_EXE;
  console.log('Login may replace the account session. Audio begins only when you initiate or accept a call.');
  const child = spawn(electron, [paths.main], { cwd: root, env, stdio: 'inherit', windowsHide: false });
  child.on('error', () => { console.error('Could not start experimental client'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
