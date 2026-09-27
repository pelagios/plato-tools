// The engine in Node the way the tests run it: an in-memory database and outputs collected in
// memory. Shared by the conversion tests and by the command-line tests, which compare what the
// command line writes to disk with what this path produces.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import * as XLSX from 'xlsx';
import { loadResources } from '../src/engine/resources.js';
import { prepare, run } from '../src/engine/pipeline.js';
import { detect } from '../src/engine/input.js';
import { openSqlite } from '../src/lib/store.js';

export const res = prepare(await loadResources(async (f) => readFileSync(`public/plato/${f}`, 'utf8')));
export const file = (path, name) => new File([readFileSync(path)], name || path.split('/').pop());
export const textFile = (text, name) => new File([text], name);
export function env() {
  const outs = {};
  return {
    outs, resources: res, csvMeta: res.csvMeta, xlsx: XLSX,
    openDb: () => openSqlite(sqlite3InitModule, { memory: true }),
    output: async (name) => { const parts = []; return { write: (s) => parts.push(s), writeBytes: (b) => parts.push(b), close: async () => { outs[name] = parts; const size = parts.reduce((n, p) => n + p.length, 0); return { name, size }; } }; },
  };
}
export const outText = (e, name) => e.outs[name].join('');
export async function go(files, action, target, options = {}) {
  const e = env(); const input = await detect(files);
  assert.ok(input.format, `not detected: ${input.reason}`);
  const r = await run({ input, action, target, options }, e);
  return { ...r, e, input };
}
