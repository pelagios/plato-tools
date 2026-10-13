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
        spike: fileURLToPath(new URL('spike/index.html', import.meta.url)),
      },
      // The page's own code is its entry's chunk, main-[hash].js and main-[hash].css; what it imports
      // with import() is left to the bundler's own chunks, loaded when imported: Chora (src/chora/app.js,
      // with MapLibre, Terra Draw and Allmaps), when it is first opened (src/app.js, openChora), and
      // Chora's map alone (src/chora/map.js and its basemaps), when Scope's drawn area is
      // (src/scope-page.js). No group gathers code into a chunk the page preloads: a module a group
      // takes brings everything it imports with it, and Chora's would have brought the map libraries
      // into the page's start. The spike page, a page of its own, loads nothing of the tools.
    },
  },
});
