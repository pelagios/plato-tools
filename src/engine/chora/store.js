// Chora's working database for the session: every place of one dataset, indexed for the map and the
// search box, with its whole record kept to show when it is chosen. The dataset is read by the
// engine that checks and converts (run() with options.sink), so every input format arrives as
// place-centric records, and each record goes straight to SQLite: nothing but the record in hand,
// and what the dataset withdraws, is held in memory, so a dataset of any size can be looked at.
//
// A place's geometries on the map are its current ones: not denied, and not retracted or superseded.
// A retraction may come anywhere in the file, even under another place, so what is withdrawn is
// known only when the whole dataset has been read; the boxes and points are worked out then.
import { run } from '../pipeline.js';
import { collectWithdrawn, resolveWithdrawn } from '../../formats/shared.js';
import { viewPlace, currentGeometries } from './view.js';

/** The key a place goes by in Chora: its @id, or its position in the dataset when it has none. */
export const placeKey = (rec, n) => (rec && typeof rec['@id'] === 'string' ? rec['@id'] : `#${n}`);
/** A label as the search box compares it: lower case, without accents (Ἑρμῆς finds ερμης, İstanbul finds istanbul). */
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** How many places the overview map is given at most. */
export const OVERVIEW_CAP = 50000;
const BATCH = 5000;

export class ChoraStore {
  constructor(db) {
    this.db = db;
    // p: one row per place, in dataset order. g: the current geometries' boxes and points while the
    // dataset is read (denied ones never go in; withdrawn ones are taken out at the end). wd: what
    // the whole dataset withdraws.
    db.exec(`CREATE TABLE p(n INTEGER PRIMARY KEY, id TEXT NOT NULL, label TEXT, fold TEXT, ccodes TEXT, rel TEXT, rec TEXT NOT NULL,
      w REAL, s REAL, e REAL, nn REAL, rx REAL, ry REAL)`);
    db.exec('CREATE TABLE g(n INTEGER NOT NULL, att TEXT, w REAL, s REAL, e REAL, nn REAL, rx REAL, ry REAL)');
    db.exec('CREATE TABLE wd(id TEXT PRIMARY KEY, kind TEXT NOT NULL) WITHOUT ROWID');
    this.loaded = null;
  }

  /** The sink run() writes the dataset to. */
  sink() {
    const db = this.db;
    const insP = db.prepare('INSERT INTO p(n,id,label,fold,ccodes,rel,rec) VALUES (?,?,?,?,?,?,?)');
    const insG = db.prepare('INSERT INTO g(n,att,w,s,e,nn,rx,ry) VALUES (?,?,?,?,?,?,?,?)');
    const edges = new Map();
    let n = 0, open = false, closed = false;
    const self = this;
    return {
      header(h) { self.header = h || {}; },
      event(ev) {
        // Identity matches are not shown on the map; everything reaches here as place-centric records.
        if (ev.type !== 'record' || !ev.value || typeof ev.value !== 'object') return;
        if (!open) { db.exec('BEGIN'); open = true; }
        const rec = ev.value;
        n++;
        collectWithdrawn(rec.attestations, edges);
        const related = [...new Set((rec.attestations || []).flatMap((a) => (a && Array.isArray(a.relations) ? a.relations : [])).map((r) => r && r.relatesTo).filter((x) => typeof x === 'string'))];
        const label = typeof rec.label === 'string' ? rec.label : placeKey(rec, n);
        insP.bind([n, placeKey(rec, n), label, fold(label), JSON.stringify(Array.isArray(rec.ccodes) ? rec.ccodes : []), JSON.stringify(related), JSON.stringify(rec)]).stepReset();
        // Withdrawn geometries are removed once the whole dataset is known; denied ones never enter.
        for (const g of currentGeometries(rec, null)) {
          if (!g.bbox) continue;
          insG.bind([n, g.attestationId, ...g.bbox, g.reprPoint ? g.reprPoint[0] : null, g.reprPoint ? g.reprPoint[1] : null]).stepReset();
        }
        if (n % BATCH === 0) { db.exec('COMMIT'); open = false; }
      },
      // Called by run() at the end, and again by load(), since a file that stops part-way ends the
      // run without it: what was read before the problem is still shown.
      async close() {
        if (closed) return;
        closed = true;
        if (open) db.exec('COMMIT');
        insP.finalize(); insG.finalize();
        self.edges = edges;
      },
    };
  }

  /** After the dataset is read: resolve what it withdraws, and give each place its box and point. */
  finish() {
    const db = this.db;
    const { status } = resolveWithdrawn(this.edges || new Map());
    this.edges = null;
    db.exec('BEGIN');
    const ins = db.prepare('INSERT OR REPLACE INTO wd(id,kind) VALUES (?,?)');
    for (const [id, kind] of status) ins.bind([id, kind]).stepReset();
    ins.finalize();
    db.exec('CREATE INDEX pid ON p(id)');
    db.exec('CREATE INDEX gn ON g(n)');
    db.exec('DELETE FROM g WHERE att IN (SELECT id FROM wd)');
    const first = (col) => `(SELECT ${col} FROM g WHERE g.n=p.n AND g.rx IS NOT NULL ORDER BY g.rowid LIMIT 1)`;
    db.exec(`UPDATE p SET w=(SELECT MIN(w) FROM g WHERE g.n=p.n), s=(SELECT MIN(s) FROM g WHERE g.n=p.n),
      e=(SELECT MAX(e) FROM g WHERE g.n=p.n), nn=(SELECT MAX(nn) FROM g WHERE g.n=p.n), rx=${first('rx')}, ry=${first('ry')}`);
    db.exec('COMMIT');
  }

  *rows(sql, params = []) {
    const q = this.db.prepare(sql);
    try { if (params.length) q.bind(params); while (q.step()) yield q; } finally { q.finalize(); }
  }
  one(sql, params = []) { for (const q of this.rows(sql, params)) return q.get(0); return null; }

  /** Whether the dataset has a place under this key (placeKey). */
  has(id) { return this.one('SELECT 1 FROM p WHERE id=? LIMIT 1', [id]) !== null; }

  /** Places whose label holds `q` (case and accents aside), in dataset order; an empty q gives them all. */
  search(q = '', offset = 0, limit = 50) {
    const like = '%' + fold(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const total = this.one("SELECT COUNT(*) FROM p WHERE fold LIKE ? ESCAPE '\\'", [like]);
    const items = [];
    for (const r of this.rows("SELECT id, label, ccodes, w IS NOT NULL FROM p WHERE fold LIKE ? ESCAPE '\\' ORDER BY n LIMIT ? OFFSET ?", [like, Math.max(0, limit | 0), Math.max(0, offset | 0)])) {
      items.push({ id: r.get(0), label: r.get(1), ccodes: JSON.parse(r.get(2)), hasGeometry: !!r.get(3) });
    }
    return { q, total, items };
  }

  /** Every place with a current geometry, as a point, for the map of the whole dataset: at most `cap`. */
  overview(cap = OVERVIEW_CAP) {
    const features = [];
    let capped = false;
    for (const r of this.rows('SELECT id, label, rx, ry FROM p WHERE rx IS NOT NULL ORDER BY n LIMIT ?', [cap + 1])) {
      if (features.length === cap) { capped = true; break; }
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.get(2), r.get(3)] }, properties: { id: r.get(0), label: r.get(1) } });
    }
    const geojson = { type: 'FeatureCollection', features };
    if (capped) geojson.capped = true;
    return geojson;
  }

  /** A place in brief, for another place's view: its label, point and box. */
  brief(id) {
    for (const r of this.rows('SELECT id, label, rx, ry, w, s, e, nn FROM p WHERE id=? ORDER BY n LIMIT 1', [id])) {
      return { id: r.get(0), label: r.get(1), reprPoint: r.get(2) === null ? null : [r.get(2), r.get(3)], bbox: r.get(4) === null ? null : [r.get(4), r.get(5), r.get(6), r.get(7)] };
    }
    return null;
  }
  /** The record of a place, as the dataset gives it, or null. */
  record(id) { const s = this.one('SELECT rec FROM p WHERE id=? ORDER BY n LIMIT 1', [id]); return s === null ? null : JSON.parse(s); }

  /**
   * The view of one place (viewPlace), or null when there is no such place. `ccodeBbox(code)` gives
   * a country's box, for a place known only by its countries.
   */
  getPlace(id, { ccodeBbox } = {}) {
    const rec = this.record(id);
    if (!rec) return null;
    // What the whole dataset withdraws of this place's attestations: the retraction may be elsewhere.
    const withdrawn = new Map();
    for (const a of rec.attestations || []) {
      if (!a || typeof a['@id'] !== 'string') continue;
      const kind = this.one('SELECT kind FROM wd WHERE id=?', [a['@id']]);
      if (kind) withdrawn.set(a['@id'], kind);
    }
    return viewPlace(rec, { withdrawn, lookup: (other) => this.brief(other), ccodeBbox });
  }

  close() { try { this.db.close(); } catch { /* closed already */ } }
}

/**
 * Read a dataset into a new working database `db` (opened by the caller, and empty). Returns the
 * store, with `loaded`: what the page shows of the dataset (see chora-loaded in the worker).
 */
export async function load(input, env, db, { name } = {}) {
  const store = new ChoraStore(db);
  const sink = store.sink();
  const r = await run({ input, action: 'check', options: { sink } }, env);
  await sink.close();
  store.finish();
  const g = (store.header && typeof store.header.gazetteer === 'object' && store.header.gazetteer) || {};
  const header = {};
  for (const k of ['@id', 'title', 'status', 'version', 'licence', 'isVersionOf', 'previousVersion']) if (typeof g[k] === 'string') header[k] = g[k];
  const places = store.one('SELECT COUNT(*) FROM p');
  const withGeometry = store.one('SELECT COUNT(*) FROM p WHERE w IS NOT NULL');
  let bbox = null;
  if (withGeometry) for (const q of store.rows('SELECT MIN(w), MIN(s), MAX(e), MAX(nn) FROM p')) bbox = [q.get(0), q.get(1), q.get(2), q.get(3)];
  store.loaded = {
    input: { format: input.format, profile: input.profile || null, name: name || input.name || input.files?.[0]?.name || null },
    header, places, bbox, withGeometry, withdrawn: store.one('SELECT COUNT(*) FROM wd'), report: r.report, incomplete: !!r.incomplete,
  };
  return store;
}
