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
      input: { spike: fileURLToPath(new URL('spike/index.html', import.meta.url)) },
    },
  },
});
