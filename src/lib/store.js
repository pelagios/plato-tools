// An on-disk triple store for conversions that need the whole dataset at once (RDF to JSON,
// grouping rows by place, checking references). SQLite compiled to WebAssembly, on the browser's
// origin private file system through the pool-based VFS, which needs none of the cross-origin
// isolation headers GitHub Pages cannot send. Memory stays bounded by SQLite's page cache; the
// disk grows with the data. The settings are the ones the spike measured (see spike/README.md).
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

export async function openSqlite(sqlite3InitModule, { memory = false, name = '/plato-tools.sqlite3', cacheMB = 64 } = {}) {
  const sqlite3 = await sqlite3InitModule();
  let db;
  if (memory) db = new sqlite3.oo1.DB(':memory:');
  else {
    const pool = await sqlite3.installOpfsSAHPoolVfs({ clearOnInit: true, initialCapacity: 8 });
    db = new pool.OpfsSAHPoolDb(name);
  }
  db.exec(pragmas(cacheMB));
  return db;
}
/**
 * The settings every store opens with, in the browser and in Node. One process owns the database:
 * exclusive locking stops SQLite re-validating its page cache at every implicit read transaction,
 * which on OPFS made lookups four times slower in the spike. There is no journal and no syncing,
 * because a working database that is lost is simply rebuilt from the input.
 */
export function pragmas(cacheMB = 64) {
  return ['PRAGMA locking_mode=EXCLUSIVE', 'PRAGMA journal_mode=OFF', 'PRAGMA synchronous=OFF',
    `PRAGMA cache_size=-${cacheMB * 1024}`, 'PRAGMA temp_store=FILE'].join(';');
}

// Literals are stored behind one fixed character. SQLite WebAssembly decodes each text value with
// a TextDecoder that strips a leading U+FEFF, so a literal that began with one (a byte-order mark
// copied into a name, as in Pleiades place 585129) came back without it. With the prefix no
// stored value starts with U+FEFF, whatever SQLite build reads it. Only literals carry it; IRIs
// and blank nodes, which the queries match on, are stored as they are.
const LIT = "'";

export class TripleStore {
  constructor(db) {
    this.db = db;
    db.exec('CREATE TABLE IF NOT EXISTS t(s TEXT NOT NULL, p INTEGER NOT NULL, o TEXT NOT NULL, k INTEGER NOT NULL, dt INTEGER, lang TEXT)');
    this.pid = new Map(); this.pname = []; this.did = new Map(); this.dname = [];
    this.count = 0;
  }
  _intern(m, names, v) { let i = m.get(v); if (i === undefined) { i = names.length; names.push(v); m.set(v, i); } return i; }
  beginBatch() { if (!this.ins) this.ins = this.db.prepare('INSERT INTO t(s,p,o,k,dt,lang) VALUES (?,?,?,?,?,?)'); this.db.exec('BEGIN'); }
  add(s, p, o) {
    const sk = s.termType === 'BlankNode' ? '_:' + s.value : s.value;
    let ov, k, dt = null, lang = null;
    if (o.termType === 'NamedNode') { ov = o.value; k = 0; }
    else if (o.termType === 'BlankNode') { ov = '_:' + o.value; k = 1; }
    else { ov = LIT + o.value; k = 2; lang = o.language || null; const d = o.datatype && (o.datatype.value || o.datatype); if (!lang && d && d !== XSD_STRING) dt = this._intern(this.did, this.dname, d); }
    this.ins.bind([sk, this._intern(this.pid, this.pname, p.value), ov, k, dt, lang]).stepReset();
    this.count++;
  }
  endBatch() { this.db.exec('COMMIT'); }
  /** Build the indexes and switch to reading; all reads then run in one transaction. */
  index(progress = () => {}) {
    if (this.ins) { this.ins.finalize(); this.ins = null; }
    progress('subjects');
    this.db.exec('CREATE INDEX IF NOT EXISTS ts ON t(s)');
    progress('references');
    this.db.exec('CREATE INDEX IF NOT EXISTS tpo ON t(p,o) WHERE k<2');
    this.qOut = this.db.prepare('SELECT p,o,k,dt,lang FROM t WHERE s=?');
    this.qIn = this.db.prepare('SELECT s FROM t WHERE p=? AND o=? AND k<2');
    this.db.exec('BEGIN');
  }
  out(id) {
    const r = []; const q = this.qOut; q.bind([id]);
    while (q.step()) {
      const k = q.get(2), v = q.get(1);
      const o = k === 0 ? { termType: 'NamedNode', value: v } : k === 1 ? { termType: 'BlankNode', value: v.slice(2) }
        : { termType: 'Literal', value: v.slice(LIT.length), datatype: q.get(3) === null ? (q.get(4) ? null : XSD_STRING) : this.dname[q.get(3)], language: q.get(4) };
      r.push({ p: this.pname[q.get(0)], o });
    }
    q.reset();
    return r;
  }
  in(p, id) {
    const i = this.pid.get(p); if (i === undefined) return [];
    const r = []; const q = this.qIn; q.bind([i, id]);
    while (q.step()) r.push(q.get(0));
    q.reset();
    return r;
  }
  /** Subjects of (?, p, o), streamed. */
  *subjects(p, o) {
    const i = this.pid.get(p); if (i === undefined) return;
    const q = this.db.prepare('SELECT s FROM t WHERE p=? AND o=? AND k<2');
    try { q.bind([i, o]); while (q.step()) yield q.get(0); } finally { q.finalize(); }
  }
  /** Objects of (s, p, ?), for one subject. */
  objects(s, p) { return this.out(s).filter((t) => t.p === p).map((t) => t.o); }
  typed(cls) { return this.subjects(RDF_TYPE, cls); }
  close() { try { this.db.exec('COMMIT'); } catch {} this.qOut?.finalize(); this.qIn?.finalize(); this.db.close(); }
}
