import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electronDir = dirname(require('electron'));
const experiment = join(root, '.local/aec3-experiment');
const rtc = join(experiment, 'native/darling_rtc_aec3_experimental.exe');
const license = join(root, '.local/rtc-licenses/LICENSE.md');
if (!existsSync(rtc) || !existsSync(join(experiment, 'main.cjs')) || !existsSync(license))
  throw new Error('Build the AEC3 experiment and dependency license inventory first');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const release = join(root, 'release', `aec3-experiment-${stamp}`);
mkdirSync(release, { recursive: true });

for (const user of ['dva', 'mercy']) {
  const name = user === 'dva' ? 'Darling-DVa-AEC3' : 'Darling-Mercy-AEC3';
  const destination = join(release, name);
  cpSync(electronDir, destination, { recursive: true });
  renameSync(join(destination, 'electron.exe'), join(destination, 'Darling.exe'));
  const application = join(destination, 'resources/app');
  const dist = join(application, 'dist');
  mkdirSync(join(dist, 'native'), { recursive: true });
  for (const entry of ['main.cjs', 'preload.cjs', 'renderer']) cpSync(join(experiment, entry), join(dist, entry), { recursive: true });
  cpSync(join(experiment, 'native'), join(dist, 'native'), { recursive: true });
  const crt = process.env.DARLING_CRT_DIR ?? 'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Redist/MSVC/14.44.35112/x64/Microsoft.VC143.CRT';
  for (const dll of readdirSync(crt).filter(file => file.endsWith('.dll'))) cpSync(join(crt, dll), join(dist, 'native', dll));
  writeFileSync(join(dist, 'voice-beta.flag'), 'Private experimental voice client.\n');
  writeFileSync(join(dist, 'aec3-experiment.flag'), 'Official WebRTC AEC3 followed by RNNoise.\n');
  writeFileSync(join(application, 'package.json'), JSON.stringify({ name: `darling-${user}-aec3-experiment`, productName: name, version: '0.5.0-aec3.1', main: 'dist/main.cjs' }, null, 2));
  const config = JSON.parse(readFileSync(join(root, `.local/${user}.config.json`), 'utf8'));
  if (config.auth?.username !== user) throw new Error(`Account config mismatch: ${user}`);
  writeFileSync(join(application, 'config.json'), JSON.stringify(config, null, 2));
  cpSync(join(root, 'docs/voice-beta-guide.md'), join(destination, '使用说明.md'));
  const licenses = join(destination, 'licenses');
  mkdirSync(licenses);
  cpSync(license, join(licenses, 'WebRTC-dependencies.md'));
  cpSync(join(root, '.local/rnnoise/COPYING'), join(licenses, 'RNNoise-COPYING'));
  cpSync(join(root, 'native/rnnoise.lock.json'), join(licenses, 'RNNoise-build.json'));
  for (const file of ['LICENSE', 'PATENTS', 'AUTHORS']) cpSync(join(root, '.local/webrtc/src', file), join(licenses, `WebRTC-${file}`));
  cpSync(join(root, 'apps/desktop/dist/native/licenses/nlohmann-json-LICENSE.MIT'), join(licenses, 'nlohmann-json-LICENSE.MIT'));
  const seen = new Set();
  const collect = path => {
    const real = realpathSync(path);
    if (seen.has(real) || !existsSync(join(real, 'package.json'))) return;
    seen.add(real);
    const pkg = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8'));
    const id = `${pkg.name}@${pkg.version}`.replace(/[^a-zA-Z0-9_.@-]/g, '_');
    const files = readdirSync(real).filter(file => /^(license|copying|notice)(\.|$)/i.test(file) && statSync(join(real, file)).isFile());
    if (files.length) {
      const out = join(licenses, 'javascript', id); mkdirSync(out, { recursive: true });
      for (const file of files) cpSync(join(real, file), join(out, file));
    }
  };
  for (const entry of readdirSync(join(root, 'node_modules/.pnpm'))) {
    const modules = join(root, 'node_modules/.pnpm', entry, 'node_modules');
    if (!existsSync(modules)) continue;
    for (const module of readdirSync(modules)) {
      const path = join(modules, module); if (!statSync(path).isDirectory()) continue;
      if (module.startsWith('@')) for (const child of readdirSync(path)) collect(join(path, child));
      else collect(path);
    }
  }
  console.log(`Packaged ${name}: ${destination}`);
}

writeFileSync(join(release, 'build-info.json'), JSON.stringify({
  builtAt: new Date().toISOString(), version: '0.5.0-aec3.1', experimental: true,
  aec: 'official-webrtc-aec3', residualEchoSuppression: true,
  noiseSuppression: 'rnnoise-v0.2', webrtcNoiseSuppression: false,
  accounts: ['dva', 'mercy'], transport: 'TURN relay', maxCallMinutes: null,
}, null, 2));
console.log(`Release directory: ${release}`);
