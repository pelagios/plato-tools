import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// The OPFS "SAHPool" storage mode of SQLite needs no cross-origin isolation headers,
// which GitHub Pages cannot send, so no server headers are configured here.
export default defineConfig({
  base: './',
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
    },
  },
});
