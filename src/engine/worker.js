// The engine in the browser: the pipeline, given SQLite on the origin private file system, output
// files there too, and PLATO's vendored files fetched from the site.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import * as XLSX from 'xlsx';
import { loadResources } from './resources.js';
import { prepare, run, TARGETS } from './pipeline.js';
import { compare } from './compare.js';
import { pragmas } from '../lib/store.js';
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

/**
 * What one run is given: its working databases, its outputs, and where progress goes. A run may
 * open several databases, one after another (the version check reads two inputs, and keeps a ledger
 * of its own): each has its own file, and a finished one is removed before the next is opened, so
 * that they do not pile up on disk. tidy() closes and removes what is left, however the run ended.
 */
async function runEnv() {
  const dir = await outputsDir(true);
  const { vfs } = await sqlitePool();
  const opened = [];
  const unlinkClosed = () => { for (const d of opened) if (!d.gone && !d.db.isOpen()) { try { vfs.unlink(d.name); } catch {} d.gone = true; } };
  const env = {
    resources, csvMeta: resources.csvMeta, xlsx: XLSX,
    openDb: async () => {
      unlinkClosed();
      const name = `/run-${++runs}.sqlite3`;
      const db = new vfs.OpfsSAHPoolDb(name);
      db.exec(pragmas());
      opened.push({ name, db });
      return db;
    },
    output: (name) => output(dir, name),
    progress: (p) => postMessage({ type: 'progress', ...p }),
  };
  return { env, tidy: () => { for (const d of opened) if (!d.gone) { try { d.db.close(); } catch {} } unlinkClosed(); } };
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
      const { env, tidy } = await runEnv();
      let result;
      try { result = await run({ input, action: data.action, target: data.target, options: data.options || {} }, env); } finally { tidy(); }
      postMessage({ type: 'done', ...result });
    } else if (data.cmd === 'compare') {
      // The version check: two inputs, the earlier version and the later one (src/engine/compare.js).
      const earlier = await detect(data.earlier), later = await detect(data.later);
      // A file that is not recognised is a finding about the file, reported as one, not a failure of the tools.
      const unknown = [['earlier', earlier], ['later', later]].find(([, input]) => !input.format);
      if (unknown) {
        postMessage({ type: 'done', incomplete: true, outputs: [], report: { counts: {}, errors: 1, items: [{ severity: 'error', kind: 'not-recognised', count: 1,
          message: `The ${unknown[0]} version was not recognised as data these tools read, so the two versions were not compared`, examples: [unknown[1].reason] }] } });
        return;
      }
      const { env, tidy } = await runEnv();
      let result;
      try { result = await compare({ earlier, later, options: data.options || {} }, env); } finally { tidy(); }
      postMessage({ type: 'done', ...result });
    }
  } catch (e) {
    postMessage({ type: 'error', message: String(e && e.message || e), stack: String(e && e.stack || '') });
  }
};
