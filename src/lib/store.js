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

/**
 * The spreadsheet tables in a working database, so that a set of tables of any size is checked and
 * converted without being held in memory: each sheet's rows, one row of cells (as JSON) to a row
 * of `r`, in the order they were read; the keys the validator has seen, in `keys`. Each row carries
 * `k`, the key it is looked up by (its place_id; a source's source_id), or null. A sheet's rows are
 * loaded together, so they are one run of rowids, which a scan of the sheet reads in order.
 *
 * Sheets are numbered by `sheets` (the tables' order), and `rows()` and `joined()` give rows of
 * cells, which the caller makes into objects. Synchronous, over the SQLite calls the triple store
 * uses, in the browser (oo1) and in Node (src/node/sqlite.js).
 */
export class TableStore {
  constructor(db) {
    this.db = db;
    db.exec('CREATE TABLE r(sheet INTEGER NOT NULL, n INTEGER NOT NULL, k TEXT, cells TEXT NOT NULL);' +
      'CREATE TABLE keys(t TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(t, key)) WITHOUT ROWID');
    this.ins = db.prepare('INSERT INTO r(sheet, n, k, cells) VALUES (?,?,?,?)');
    this.qMax = db.prepare('SELECT max(rowid) FROM r');
    this.pending = 0;
    this.closed = false;
    db.exec('BEGIN');
  }
  /** Add one row of a sheet. Committed in batches. */
  add(sheet, n, k, cells) {
    this.ins.bind([sheet, n, k === undefined ? null : k, JSON.stringify(cells)]).stepReset();
    if (++this.pending >= 50000) { this.db.exec('COMMIT'); this.db.exec('BEGIN'); this.pending = 0; }
  }
  /** The last rowid given (0 for none): a sheet's rows are the rowids after the mark before it, to the mark after. */
  mark() { const q = this.qMax; q.step(); const m = q.get(0) ?? 0; q.reset(); return m; }
  /** Take back the rows after the mark `after` (a sheet that stopped part-way). */
  drop(after) { const q = this.db.prepare('DELETE FROM r WHERE rowid > ?'); q.bind([after]).stepReset(); q.finalize(); }
  /** The rows of cells with rowids from `first` to `last`, in order. */
  *rows(first, last) {
    if (first > last) return;
    const q = this.db.prepare('SELECT cells FROM r WHERE rowid BETWEEN ? AND ? ORDER BY rowid');
    try { q.bind([first, last]); while (q.step()) yield JSON.parse(q.get(0)); } finally { q.finalize(); }
  }
  /** Add a key to table t's set: false if it was there already. Bound as strings, so that '1' and '01' stay two keys. */
  keyAdd(t, key) {
    const q = this.qAdd ||= this.db.prepare('INSERT OR IGNORE INTO keys(t, key) VALUES (?,?) RETURNING 1');
    q.bind([String(t), String(key)]);
    const fresh = q.step();
    q.reset();
    return fresh;
  }
  keyHas(t, key) {
    const q = this.qHas ||= this.db.prepare('SELECT 1 FROM keys WHERE t=? AND key=?');
    q.bind([String(t), String(key)]);
    const found = q.step();
    q.reset();
    return found;
  }
  /** Loading is over: index the rows by key, for joined() and lookup(). */
  index() {
    for (const q of [this.ins, this.qMax, this.qAdd, this.qHas]) q?.finalize();
    this.ins = this.qMax = this.qAdd = this.qHas = null;
    this.db.exec('COMMIT');
    this.db.exec('CREATE INDEX r_k ON r(k, sheet, n)');
    this.qLast = this.db.prepare('SELECT cells FROM r WHERE k=? AND sheet=? ORDER BY n DESC LIMIT 1');
    this.qLastNull = this.db.prepare('SELECT cells FROM r WHERE k IS NULL AND sheet=? ORDER BY n DESC LIMIT 1');
    this.db.exec('BEGIN');
  }
  /** The cells of the last row of `sheet` whose key is `k` (undefined: the rows with none), or null. */
  lookup(sheet, k) {
    const q = k === undefined ? this.qLastNull.bind([sheet]) : this.qLast.bind([String(k), sheet]);
    const cells = q.step() ? JSON.parse(q.get(0)) : null;
    q.reset();
    return cells;
  }
  /**
   * Each row from `first` to `last` (one sheet) with the rows of sheets numbered `from` or more that
   * share its key, in one streaming join: [rowid, cells, sheet, cells] per pair, and [rowid, cells,
   * null, null] for a row none shares. In rowid order, then sheet, then row: SQLite walks the rows in
   * rowid order and finds the others through r_k, already in order, so nothing is sorted, and the
   * first row comes at once (EXPLAIN QUERY PLAN shows no temporary B-tree; test/tables-stream.test.js).
   */
  *joined(first, last, from) {
    if (first > last) return;
    const q = this.db.prepare(TableStore.JOIN);
    try {
      q.bind([from, first, last]);
      while (q.step()) yield [q.get(0), JSON.parse(q.get(1)), q.get(2), q.get(3) === null ? null : JSON.parse(q.get(3))];
    } finally { q.finalize(); }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const q of [this.ins, this.qMax, this.qAdd, this.qHas, this.qLast, this.qLastNull]) { try { q?.finalize(); } catch {} }
    try { this.db.exec('COMMIT'); } catch {}
    this.db.close();
  }
}
TableStore.JOIN = 'SELECT p.rowid, p.cells, a.sheet, a.cells FROM r AS p LEFT JOIN r AS a ON a.k = p.k AND a.sheet >= ? ' +
  'WHERE p.rowid BETWEEN ? AND ? ORDER BY p.rowid, a.sheet, a.n';
