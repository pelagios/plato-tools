// The triple store's database in Node: a file on disk through Node's built-in SQLite (node:sqlite),
// presented with the small part of the SQLite WebAssembly "oo1" interface that src/lib/store.js and
// src/engine/pipeline.js use, so the engine runs unchanged: db.exec, db.prepare, db.close, and on
// a statement bind, step, get, reset, stepReset and finalize. Rows are read one at a time through
// an iterator, so a query that yields every place never holds them all in memory.
import { DatabaseSync } from 'node:sqlite';
import { statSync, rmSync } from 'node:fs';
import { pragmas } from '../lib/store.js';

class Statement {
  constructor(st) { this.st = st; st.setReturnArrays(true); this.params = []; this.it = null; this.row = null; }
  bind(params) { this.reset(); this.params = params; return this; }
  step() {
    if (!this.it) this.it = this.st.iterate(...this.params);
    const n = this.it.next();
    if (n.done) { this.it = null; this.row = null; return false; }
    this.row = n.value;
    return true;
  }
  get(i) { return this.row[i]; }
  reset() { if (this.it) { this.it.return?.(); this.it = null; } this.row = null; return this; }
  stepReset() { this.st.run(...this.params); return this; }
  finalize() { this.reset(); }
}

/**
 * Open a new database file at `path` (it must not be in use), with the same settings as the
 * browser's. close() closes it, notes its size in `bytes`, and deletes it.
 */
export function openNodeSqlite(path, { cacheMB = 64 } = {}) {
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec(pragmas(cacheMB));
  const handle = {
    path, bytes: 0, closed: false,
    exec(sql) { db.exec(sql); return handle; },
    prepare(sql) { return new Statement(db.prepare(sql)); },
    close() {
      if (handle.closed) return;
      handle.closed = true;
      try { handle.bytes = statSync(path).size; } catch {}
      db.close();
      rmSync(path, { force: true });
    },
  };
  return handle;
}
