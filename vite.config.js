import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { cspPlugin } from './scripts/vite-csp.mjs';

// The OPFS "SAHPool" storage mode of SQLite needs no cross-origin isolation headers,
// which GitHub Pages cannot send, so no server headers are configured here.
export default defineConfig({
  base: './',
  // The hard block: each page's Content Security Policy, written from the permissions allowed by the
  // first script in its <head> (scripts/vite-csp.mjs).
  plugins: [cspPlugin()],
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        // Chora, the map, is a page of its own, so that the map libraries load only there.
        chora: fileURLToPath(new URL('chora.html', import.meta.url)),
        spike: fileURLToPath(new URL('spike/index.html', import.meta.url)),
      },
      // The code both pages load (styles.css, words.js, src/chora/handoff.js) goes in one chunk
      // named for what it is, shared-[hash].js and shared-[hash].css. Left to itself the bundler
      // names such a chunk after the first module in it, which is an accident of imports. Only this
      // repository's src/ is grouped, so that Vite's module-preload polyfill, which the spike page
      // shares too, stays a chunk of its own and the spike page loads nothing of the tools.
      output: {
        codeSplitting: { groups: [{ name: 'shared', test: /[\\/]src[\\/]/, minShareCount: 2 }] },
      },
    },
  },
});
