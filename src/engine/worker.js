// The engine in the browser: the pipeline, given SQLite on the origin private file system, output
// files there too, and PLATO's vendored files fetched from the site.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import * as XLSX from 'xlsx';
import { loadResources } from './resources.js';
import { prepare, run, TARGETS } from './pipeline.js';
import { detect } from './input.js';

let resources = null, pool = null, runs = 0;
async function sqlitePool() {
  if (pool) return pool;
  const sqlite3 = await sqlite3InitModule();
  pool = { sqlite3, vfs: await sqlite3.installOpfsSAHPoolVfs({ clearOnInit: true, initialCapacity: 8 }) };
  return pool;
}
async function outputsDir(clear) {
  const root = await navigator.storage.getDirectory();
  if (clear) { try { await root.removeEntry('outputs', { recursive: true }); } catch {} }
  return root.getDirectoryHandle('outputs', { create: true });
}
async function output(dir, name) {
  const h = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  h.truncate(0);
  const enc = new TextEncoder();
  let at = 0;
  return {
    write(s) { at += h.write(enc.encode(s), { at }); },
    writeBytes(b) { at += h.write(b, { at }); },
    async close() { h.flush(); h.close(); return { name, size: at }; },
  };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.cmd === 'init') {
      const base = data.base + 'plato/';
      resources = prepare(await loadResources(async (f) => { const r = await fetch(base + f); if (!r.ok) throw new Error(`${f}: ${r.status}`); return r.text(); }));
      postMessage({ type: 'ready', version: resources.version });
    } else if (data.cmd === 'detect') {
      const input = await detect(data.files);
      postMessage({ type: 'detected', input: { ...input, files: undefined }, targets: TARGETS });
    } else if (data.cmd === 'run') {
      const input = await detect(data.files);
      if (!input.format) throw new Error(input.reason);
      const dir = await outputsDir(true);
      const { sqlite3, vfs } = await sqlitePool();
      const dbName = `/run-${++runs}.sqlite3`;
      const env = {
        resources, csvMeta: resources.csvMeta, xlsx: XLSX,
        openDb: async () => {
          const db = new vfs.OpfsSAHPoolDb(dbName);
          db.exec(['PRAGMA locking_mode=EXCLUSIVE', 'PRAGMA journal_mode=OFF', 'PRAGMA synchronous=OFF', 'PRAGMA cache_size=-65536', 'PRAGMA temp_store=FILE'].join(';'));
          return db;
        },
        output: (name) => output(dir, name),
        progress: (p) => postMessage({ type: 'progress', ...p }),
      };
      const result = await run({ input, action: data.action, target: data.target, options: data.options || {} }, env);
      try { vfs.unlink(dbName); } catch {}
      postMessage({ type: 'done', ...result });
    }
  } catch (e) {
    postMessage({ type: 'error', message: String(e && e.message || e), stack: String(e && e.stack || '') });
  }
};
