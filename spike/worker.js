// Spike worker. Memory must scale with one record, never with the file:
// the input is decompressed and parsed as a stream, stored in SQLite on OPFS
// (the pool-based VFS, which needs no cross-origin isolation), indexed there,
// and read back one SpatialEntity at a time into one JSON line each.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { Parser } from 'n3';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const P = 'https://w3id.org/plato#';
const FACETS = ['attests_name', 'attests_geometry', 'attests_timespan', 'attests_type', 'attests_property', 'has_citation'].map((x) => P + x);

let lastPost = 0;
const progress = (o, force = false) => {
  const now = performance.now();
  if (force || now - lastPost > 250) { lastPost = now; postMessage(o); }
};

async function* chunksOfLines(file) {
  const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const i = buf.lastIndexOf('\n');
    if (i < 0) continue;
    yield buf.slice(0, i + 1);
    buf = buf.slice(i + 1);
  }
  if (buf) yield buf + '\n';
}

async function naive(file) {
  // Control: keep every line. Memory should grow with the input.
  const kept = [];
  for await (const chunk of chunksOfLines(file)) {
    for (const line of chunk.split('\n')) if (line && line[0] !== '#') kept.push(line);
    progress({ phase: 'reading', triples: kept.length });
  }
  return { phase: 'done', triples: kept.length };
}

async function stream(file, opt = {}) {
  const marks = { start: performance.now() };
  const sqlite3 = await sqlite3InitModule();
  let db;
  if (opt.memdb) db = new sqlite3.oo1.DB(':memory:');
  else { const pool = await sqlite3.installOpfsSAHPoolVfs({ clearOnInit: true, initialCapacity: 8 }); db = new pool.OpfsSAHPoolDb('/spike.sqlite3'); }
  if (opt.pageSize) db.exec(`PRAGMA page_size=${opt.pageSize}`);
  // One process owns this database: exclusive locking stops SQLite re-checking the file,
  // and so re-validating its page cache, at the start of every implicit read transaction.
  db.exec(['PRAGMA locking_mode=EXCLUSIVE', 'PRAGMA journal_mode=OFF', 'PRAGMA synchronous=OFF', `PRAGMA cache_size=-${(opt.cacheMB || 64) * 1024}`, 'PRAGMA temp_store=FILE',
           'CREATE TABLE t(s TEXT NOT NULL, p INTEGER NOT NULL, o TEXT NOT NULL, k INTEGER NOT NULL, dt INTEGER, lang TEXT)'].join(';'));
  const pid = new Map(), pname = [], did = new Map(), dname = [];
  const intern = (m, names, v) => { let i = m.get(v); if (i === undefined) { i = names.length; names.push(v); m.set(v, i); } return i; };
  const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
  const ins = db.prepare('INSERT INTO t(s,p,o,k,dt,lang) VALUES (?,?,?,?,?,?)');
  let triples = 0;
  for await (const chunk of chunksOfLines(file)) {
    const quads = new Parser({ format: 'N-Triples', blankNodePrefix: '' }).parse(chunk);
    db.exec('BEGIN');
    for (const q of quads) {
      const s = q.subject.termType === 'BlankNode' ? '_:' + q.subject.value : q.subject.value;
      const o = q.object;
      let ov, k, dt = null, lang = null;
      if (o.termType === 'NamedNode') { ov = o.value; k = 0; }
      else if (o.termType === 'BlankNode') { ov = '_:' + o.value; k = 1; }
      else { ov = o.value; k = 2; lang = o.language || null; if (!lang && o.datatype.value !== XSD_STRING) dt = intern(did, dname, o.datatype.value); }
      ins.bind([s, intern(pid, pname, q.predicate.value), ov, k, dt, lang]).stepReset();
    }
    db.exec('COMMIT');
    triples += quads.length;
    progress({ phase: 'loading', triples });
  }
  ins.finalize();
  marks.loaded = performance.now();
  progress({ phase: 'indexing', triples }, true);
  db.exec('CREATE INDEX ts ON t(s)');
  progress({ phase: 'indexing (object)', triples }, true);
  db.exec('CREATE INDEX tpo ON t(p,o) WHERE k<2');
  marks.indexed = performance.now();
  const storageAfterIndex = (await navigator.storage.estimate()).usage;

  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('spike-out.jsonl'); } catch {}
  const out = await (await root.getFileHandle('spike-out.jsonl', { create: true })).createSyncAccessHandle();
  const enc = new TextEncoder();
  let at = 0;
  const qOut = db.prepare('SELECT p,o,k,dt,lang FROM t WHERE s=?');
  const qIn = db.prepare('SELECT s FROM t WHERE p=? AND o=? AND k<2');
  const qEnt = db.prepare('SELECT s FROM t WHERE p=? AND o=? AND k=0');
  let emitted = 0;
  const rows = (id) => {           // collect first: the same statement is reused while recursing
    const r = []; qOut.bind([id]);
    while (qOut.step()) r.push([pname[qOut.get(0)], qOut.get(1), qOut.get(2), qOut.get(3), qOut.get(4)]);
    qOut.reset(); emitted += r.length; return r;
  };
  const node = (id) => {
    const obj = {};
    for (const [p, o, k, dt, lang] of rows(id)) {
      let v = k === 2 ? (dt === null && lang === null ? o : { '@value': o, ...(dt !== null && { '@type': dname[dt] }), ...(lang && { '@language': lang }) }) : { '@id': o };
      if (k < 2 && FACETS.includes(p)) v = { '@id': o, ...node(o) };
      (obj[p] ||= []).push(v);
    }
    return obj;
  };
  const referrers = (p, o) => { const r = []; qIn.bind([pid.get(p), o]); while (qIn.step()) r.push(qIn.get(0)); qIn.reset(); return r; };
  const entities = []; // ids only: 8 bytes-ish each, not records
  qEnt.bind([pid.get(RDF_TYPE), P + 'SpatialEntity']); while (qEnt.step()) entities.push(qEnt.get(0)); qEnt.finalize();
  let n = 0, atts = 0, maxLine = 0;
  db.exec('BEGIN');                // one read transaction for the whole write phase
  for (const e of entities) {
    const a = referrers(P + 'attests_about', e);
    atts += a.length;
    const rec = { '@id': e, ...node(e), attestations: a.map((id) => ({ '@id': id, ...node(id) })) };
    const bytes = enc.encode(JSON.stringify(rec) + '\n');
    maxLine = Math.max(maxLine, bytes.length);
    at += out.write(bytes, { at });
    n++;
    if ((n & 1023) === 0) progress({ phase: 'writing', triples, entities: n, attestations: atts, outputBytes: at });
  }
  db.exec('COMMIT');
  out.flush(); out.close(); qOut.finalize(); qIn.finalize(); db.close();
  marks.written = performance.now();
  const secs = (a, b) => Math.round((marks[b] - marks[a]) / 100) / 10;
  return { phase: 'done', opt, seconds: { load: secs('start', 'loaded'), index: secs('loaded', 'indexed'), write: secs('indexed', 'written') }, triples, entities: n, attestations: atts, emittedRows: emitted, outputBytes: at, maxLineBytes: maxLine,
           entityIdsHeld: entities.length, storageAfterIndex };
}

self.onmessage = async ({ data }) => {
  try { postMessage(await (data.mode === 'naive' ? naive(data.file) : stream(data.file, data.opt))); }
  catch (e) { postMessage({ phase: 'error', message: String((e && e.stack) || e) }); }
};
