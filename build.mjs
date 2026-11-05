import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const smoke = process.argv.includes('--smoke');
const storeTest = process.argv.includes('--store-test');

/** Main, preload and the smoke harness run on Node: keep `electron` external. */
const APP_TARGETS = [
  { entryPoints: ['src/main/main.ts'],         outfile: 'dist/main/main.js',         platform: 'node' },
  { entryPoints: ['src/preload/preload.ts'],   outfile: 'dist/preload/preload.js',   platform: 'node' },
  { entryPoints: ['src/renderer/renderer.ts'], outfile: 'dist/renderer/renderer.js', platform: 'browser' },
];

const SMOKE_TARGET = {
  entryPoints: ['scripts/smoke.ts'],
  outfile: 'dist/smoke/smoke.js',
  platform: 'node',
};

/** The store compiled on its own, for the Electron-free migration test. */
const STORE_TARGET = {
  entryPoints: ['src/main/store.ts'],
  outfile: 'dist/test/store.cjs',
  platform: 'node',
};

const targets = smoke ? [SMOKE_TARGET] : storeTest ? [STORE_TARGET] : APP_TARGETS;
// A side build must not wipe the app build the developer is about to launch.
if (!smoke && !storeTest) rmSync('dist', { recursive: true, force: true });

for (const t of targets) {
  const opts = {
    ...t,
    bundle: true,
    sourcemap: true,
    format: t.platform === 'node' ? 'cjs' : 'iife',
    target: t.platform === 'node' ? 'node20' : 'chrome120',
    external: t.platform === 'node' ? ['electron'] : [],
    logLevel: 'warning',
  };
  if (watch) await (await context(opts)).watch();
  else await build(opts);
}

// index.html and styles.css must sit NEXT TO renderer.js: the page is loaded
// over file:// with `script-src 'self'`, which only permits same-directory
// scripts, so a cross-directory ../../dist reference would be blocked.
if (!smoke && !storeTest) {
  mkdirSync('dist/renderer', { recursive: true });
  for (const f of ['index.html', 'styles.css']) {
    copyFileSync(`src/renderer/${f}`, `dist/renderer/${f}`);
  }
}

console.log(watch ? 'watching…' : `build complete${smoke ? ' (smoke)' : storeTest ? ' (store-test)' : ''}`);
