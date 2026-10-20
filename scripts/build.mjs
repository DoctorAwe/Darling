import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
await build({ entryPoints: ['apps/server/src/index.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: 'apps/server/dist/index.js', target: 'node24' });
await build({ entryPoints: ['apps/desktop/src/main.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: 'apps/desktop/dist/main.cjs', target: 'node22' });
await build({ entryPoints: ['apps/desktop/src/preload.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: 'apps/desktop/dist/preload.cjs', target: 'node22' });
await viteBuild({ root: 'apps/desktop', base: './', build: { outDir: 'dist/renderer', emptyOutDir: true } });
