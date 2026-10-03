// Bundle e2e/methodos-hook.js into one script for e2e/app_test.py to serve (never part of the site),
// with Vite (a declared dependency), not its own configuration: node e2e/methodos-hook.mjs <out.js>
import { build } from 'vite';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.argv[2];
if (!out) { console.error('usage: node e2e/methodos-hook.mjs <out.js>'); process.exit(2); }
await build({
  configFile: false, logLevel: 'error', root: fileURLToPath(new URL('..', import.meta.url)),
  build: {
    outDir: dirname(resolve(out)), emptyOutDir: false, copyPublicDir: false, minify: false,
    lib: { entry: fileURLToPath(new URL('./methodos-hook.js', import.meta.url)), formats: ['iife'], name: 'methodosHook', fileName: () => basename(out) },
  },
});
