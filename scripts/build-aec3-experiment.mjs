// Build only. Never launches Electron, audio devices, or an evaluation.
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import './apply-aec3-diagnostics.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '.local/webrtc/src');
const output = join(root, '.local/aec3-experiment');
const result = spawnSync(join(source, 'third_party/ninja/ninja.exe'),
  ['-C', 'out/DarlingRelease', '-j', '4', 'darling_rtc_process'],
  { cwd: source, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('Native experiment build failed');
mkdirSync(join(output, 'native'), { recursive: true });
cpSync(join(source, 'out/DarlingRelease/darling_rtc_process.exe'), join(output, 'native/darling_rtc_aec3_experimental.exe'));
for (const file of readdirSync(join(root, 'apps/desktop/dist/native')).filter(file => file.endsWith('.dll')))
  cpSync(join(root, 'apps/desktop/dist/native', file), join(output, 'native', file));
cpSync(join(root, '.local/rnnoise-build/Release/darling_rnnoise.dll'), join(output, 'native/darling_rnnoise.dll'));
cpSync(join(root, 'apps/desktop/dist/native/darling-media.exe'), join(output, 'native/darling-media.exe'));
for (const name of ['main', 'preload']) await build({
  absWorkingDir: root, entryPoints: [`apps/desktop/src/${name}.ts`], bundle: true,
  platform: 'node', format: 'cjs', external: ['electron'], target: 'node22',
  outfile: join(output, `${name}.cjs`),
});
await viteBuild({ root: join(root, 'apps/desktop'), base: './',
  build: { outDir: join(output, 'renderer'), emptyOutDir: true } });
console.log(`Experiment built: ${output}\nStable desktop/dist and release packages were not replaced. No audio was started.`);
