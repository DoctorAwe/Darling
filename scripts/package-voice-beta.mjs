import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electronDir = dirname(require('electron'));
const release = join(root, 'release', `voice-beta-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const rtc = join(root, '.local/webrtc/src/out/DarlingRelease/darling_rtc_process.exe');
const license = join(root, '.local/rtc-licenses/LICENSE.md');
if (!existsSync(rtc) || !existsSync(license)) throw new Error('RTC binary and dependency license inventory required');
mkdirSync(release, { recursive: true });
for (const user of ['dva', 'mercy']) {
  const name = user === 'dva' ? 'Darling-DVa' : 'Darling-Mercy';
  const destination = join(release, name);
  cpSync(electronDir, destination, { recursive: true });
  renameSync(join(destination, 'electron.exe'), join(destination, 'Darling.exe'));
  const application = join(destination, 'resources/app'); mkdirSync(application, { recursive: true });
  cpSync(join(root, 'apps/desktop/dist'), join(application, 'dist'), { recursive: true });
  cpSync(rtc, join(application, 'dist/native/darling_rtc_process.exe'));
  cpSync(join(root, '.local/rnnoise-build/Release/darling_rnnoise.dll'), join(application, 'dist/native/darling_rnnoise.dll'));
  const crt = process.env.DARLING_CRT_DIR ?? 'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Redist/MSVC/14.44.35112/x64/Microsoft.VC143.CRT';
  for (const dll of readdirSync(crt).filter(file => file.endsWith('.dll'))) cpSync(join(crt, dll), join(application, 'dist/native', dll));
  writeFileSync(join(application, 'dist/voice-beta.flag'), 'Private voice beta; explicit device confirmation required.\n');
  writeFileSync(join(application, 'package.json'), JSON.stringify({ name: `darling-${user}-voice-beta`, productName: name, version: '0.8.0-beta.6', main: 'dist/main.cjs' }, null, 2));
  const config = JSON.parse(readFileSync(join(root, `.local/${user}.config.json`), 'utf8'));
  if (config.auth?.username !== user) throw new Error('Account config mismatch');
  writeFileSync(join(application, 'config.json'), JSON.stringify(config, null, 2));
  cpSync(join(root, 'docs/voice-beta-guide.md'), join(destination, '使用说明.md'));
  const licenses = join(destination, 'licenses'); mkdirSync(licenses);
  cpSync(license, join(licenses, 'WebRTC-dependencies.md'));
  cpSync(join(root, '.local/rnnoise/COPYING'), join(licenses, 'RNNoise-COPYING'));
  cpSync(join(root, 'native/rnnoise.lock.json'), join(licenses, 'RNNoise-build.json'));
  for (const file of ['LICENSE', 'PATENTS', 'AUTHORS']) cpSync(join(root, '.local/webrtc/src', file), join(licenses, `WebRTC-${file}`));
  cpSync(join(root, 'apps/desktop/dist/native/licenses/nlohmann-json-LICENSE.MIT'), join(licenses, 'nlohmann-json-LICENSE.MIT'));
  const seen = new Set();
  const collect = path => {
    const real = realpathSync(path); if (seen.has(real) || !existsSync(join(real, 'package.json'))) return; seen.add(real);
    const pkg = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8'));
    const id = `${pkg.name}@${pkg.version}`.replace(/[^a-zA-Z0-9_.@-]/g, '_');
    const files = readdirSync(real).filter(file => /^(license|copying|notice)(\.|$)/i.test(file) && statSync(join(real, file)).isFile());
    if (files.length) { const out = join(licenses, 'javascript', id); mkdirSync(out, { recursive: true }); for (const file of files) cpSync(join(real, file), join(out, file)); }
  };
  for (const entry of readdirSync(join(root, 'node_modules/.pnpm'))) {
    const modules = join(root, 'node_modules/.pnpm', entry, 'node_modules'); if (!existsSync(modules)) continue;
    for (const module of readdirSync(modules)) {
      const path = join(modules, module); if (!statSync(path).isDirectory()) continue;
      if (module.startsWith('@')) { for (const child of readdirSync(path)) collect(join(path, child)); } else collect(path);
    }
  }
  console.log(`Packaged ${name}: ${destination}`);
}
writeFileSync(join(release, 'build-info.json'), JSON.stringify({ builtAt: new Date().toISOString(), version: '0.8.0-beta.6', aec: 'official-webrtc-aec3', residualEchoSuppression: true, fallbackAec: 'darling-pbfdaf-v2', headphonesAec: true, noiseSuppression: 'rnnoise-v0.2', webrtcNoiseSuppression: false, windowsCommunicationsDucking: false, accounts: ['dva', 'mercy'], voiceTransport: 'TURN relay', remoteDesktop: { video: true, systemAudio: true, input: true, route: 'direct-and-turn-concurrent', preferredCodec: 'h264-hardware', discreteGpuPreferred: true, primaryDisplay: true, negotiationTimeoutSeconds: 30, localCursor: true, capturedCursor: false }, attachments: { maxBytes: 134217728, maxSelection: 10, imagePreview: true, screenshot: 'primary-display-region-selection', hidesMainWindow: true, fullScreenSelector: true }, mediaMutualExclusion: true, voiceTrackResetOnConnect: true, maxCallMinutes: null, audioControls: true }, null, 2));
console.log(`Release directory: ${release}`);
