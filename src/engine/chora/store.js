// Chora's working database for the session: every place of one dataset, indexed for the map and the
// search box, with its whole record kept to show when it is chosen. The dataset is read by the
// engine that checks and converts (run() with options.sink), so every input format arrives as
// place-centric records, and each record goes straight to SQLite: nothing but the record in hand,
// and what the dataset withdraws, is held in memory, so a dataset of any size can be looked at.
//
// A place's geometries on the map, and the names the search box finds it by, are its current ones:
// not denied, and not retracted or superseded. A retraction may come anywhere in the file, even
// under another place, so what is withdrawn is known only when the whole dataset has been read; the
// boxes and points are worked out then, and the withdrawn names taken out.
import { run } from '../pipeline.js';
import { genericProfile } from '../hermes/generic.js';
import { collectWithdrawn, resolveWithdrawn, isDenial } from '../../formats/shared.js';
import { viewPlace, currentGeometries } from './view.js';
import { unionBbox } from './geo.js';
import { fold } from './fold.js';
import { createIdentityCollector } from '../krisis/identities.js';
import { adoptScope } from './adopt.js';

/** The key a place goes by in Chora: its @id, or its position in the dataset when it has none. */
export const placeKey = (rec, n) => (rec && typeof rec['@id'] === 'string' ? rec['@id'] : `#${n}`);
/**
 * The key of each record in turn, by the one rule the store and the save both count by: every record
 * counts towards the position, and one that is not a place (null, say) has no key.
 */
export function keyer() {
  let n = 0;
  return (rec) => { n++; return rec && typeof rec === 'object' && !Array.isArray(rec) ? placeKey(rec, n) : null; };
}
export { fold } from './fold.js';
/** How many places the overview map is given at most. */
export const OVERVIEW_CAP = 50000;
const BATCH = 5000, ROWS = 64;

export class ChoraStore {
  constructor(db) {
    this.db = db;
    // p: one row per place, in dataset order. g: the current geometries' boxes and points while the
    // dataset is read (denied ones never go in; withdrawn ones are taken out at the end). sx: each
    // place's label, folded (k = 0, name null), and then its names, toponym and romanized, in
    // attestation order (k = 1, 2, ...; denied ones never go in, withdrawn ones are taken out at the
    // end). sxa: the names of sx each attestation with an @id gave, as one row per attestation (its
    // names are numbered one after another, so they are the range kLo..kHi of its place), kept only
    // until the withdrawn names are taken out, and dropped then, its pages used again by what is made
    // after it. Keyed by (n, kLo), the order it is written in, so the taking out finds a name's
    // attestation by the place and k it has. sf: what the search box looks in, made from sx at the end: one row per place, its folded
    // label and names joined by U+0001 (which no folded text holds, so a match never spans two), kept
    // apart from the records so that a search reads little; sft, a trigram index of it (FTS5, its text
    // not copied), for queries of three letters or more; shorter ones scan sf. wd: what the whole
    // dataset withdraws.
    db.exec(`CREATE TABLE p(n INTEGER PRIMARY KEY, id TEXT NOT NULL, label TEXT, ccodes TEXT, rel TEXT, rec TEXT NOT NULL,
      w REAL, s REAL, e REAL, nn REAL, rx REAL, ry REAL)`);
    db.exec('CREATE TABLE sx(n INTEGER NOT NULL, k INTEGER NOT NULL, fold TEXT NOT NULL, name TEXT, PRIMARY KEY(n, k)) WITHOUT ROWID');
    db.exec('CREATE TABLE sxa(n INTEGER NOT NULL, kLo INTEGER NOT NULL, kHi INTEGER NOT NULL, att TEXT NOT NULL, PRIMARY KEY(n, kLo)) WITHOUT ROWID');
    db.exec('CREATE TABLE sf(n INTEGER PRIMARY KEY, f TEXT NOT NULL)');
    db.exec("CREATE VIRTUAL TABLE sft USING fts5(f, content='sf', content_rowid='n', tokenize='trigram')");
    db.exec('CREATE TABLE g(n INTEGER NOT NULL, att TEXT, w REAL, s REAL, e REAL, nn REAL, rx REAL, ry REAL)');
    db.exec('CREATE TABLE wd(id TEXT PRIMARY KEY, kind TEXT NOT NULL) WITHOUT ROWID');
    this.loaded = null;
  }

  /** The sink run() writes the dataset to. */
  sink() {
    const db = this.db;
    const insP = db.prepare('INSERT INTO p(n,id,label,ccodes,rel,rec) VALUES (?,?,?,?,?,?)');
    // The names go in ROWS at a time, by one statement of that many rows: far fewer calls into SQLite.
    const insS = db.prepare('INSERT INTO sx(n,k,fold,name) VALUES (?,?,?,?)');
    const insSn = db.prepare('INSERT INTO sx(n,k,fold,name) VALUES ' + Array(ROWS).fill('(?,?,?,?)').join(','));
    let buf = [];
    const name = (...row) => { buf.push(...row); if (buf.length === ROWS * 4) { insSn.bind(buf).stepReset(); buf = []; } };
    const flush = () => { for (let i = 0; i < buf.length; i += 4) insS.bind(buf.slice(i, i + 4)).stepReset(); buf = []; };
    const insA = db.prepare('INSERT INTO sxa(n,kLo,kHi,att) VALUES (?,?,?,?)');
    const insG = db.prepare('INSERT INTO g(n,att,w,s,e,nn,rx,ry) VALUES (?,?,?,?,?,?,?,?)');
    const edges = new Map(), keyOf = keyer();
    // Which places the dataset says are, and are not, the same, as Krisis reads it (identities.js): for
    // adopting a gazetteer record (adopt.js). Only the relations are kept, not the records.
    const ids = createIdentityCollector();
    let n = 0, open = false, closed = false;
    const self = this;
    return {
      header(h) { self.header = h || {}; },
      event(ev) {
        // Identity matches are not shown on the map, and are kept for adopting; everything else reaches here as place-centric records.
        if (ev.type === 'idr' && ev.value) { ids.addRelation(ev.value.subject, ev.value.object, false, null, ev.value.identityType); return; }
        if (ev.type !== 'record') return;
        const rec = ev.value, key = keyOf(rec);
        if (key === null) return;
        if (!open) { db.exec('BEGIN'); open = true; }
        n++;
        // Attestations that are not a list (the schema refuses them, and the place is still shown) are none.
        const atts = Array.isArray(rec.attestations) ? rec.attestations : [];
        collectWithdrawn(atts, edges);
        // The guarded list: Krisis's collector expects attestations as a list, and a record whose are not would throw there.
        ids.add({ ...rec, attestations: atts });
        const related = [...new Set(atts.flatMap((a) => (a && Array.isArray(a.relations) ? a.relations : [])).map((r) => r && r.relatesTo).filter((x) => typeof x === 'string'))];
        const label = typeof rec.label === 'string' ? rec.label : key;
        insP.bind([n, key, label, JSON.stringify(Array.isArray(rec.ccodes) ? rec.ccodes : []), JSON.stringify(related), JSON.stringify(rec)]).stepReset();
        const folded = fold(label);
        name(n, 0, folded, null);
        // Its names. One the label already holds adds nothing; a name repeated within an attestation
        // is one. The same name from another attestation is kept: that one may be withdrawn, this not.
        let k = 0;
        for (const a of atts) {
          if (!a || typeof a !== 'object' || !Array.isArray(a.names) || isDenial(a)) continue;
          const aid = typeof a['@id'] === 'string' ? a['@id'] : null, seen = new Set([folded]), kLo = k + 1;
          for (const nm of a.names) {
            if (!nm || typeof nm !== 'object') continue;
            for (const t of [nm.toponym, nm.romanized]) {
              if (typeof t !== 'string' || !t.trim()) continue;
              const f = fold(t);
              if (seen.has(f)) continue;
              seen.add(f);
              name(n, ++k, f, t);
            }
          }
          if (aid !== null && k >= kLo) insA.bind([n, kLo, k, aid]).stepReset();
        }
        // Withdrawn geometries are removed once the whole dataset is known; denied ones never enter.
        for (const g of currentGeometries(rec, null)) {
          if (!g.bbox) continue;
          insG.bind([n, g.attestationId, ...g.bbox, g.reprPoint ? g.reprPoint[0] : null, g.reprPoint ? g.reprPoint[1] : null]).stepReset();
        }
        if (n % BATCH === 0) { flush(); db.exec('COMMIT'); open = false; }
      },
      // Called by run() at the end, and again by load(), since a file that stops part-way ends the
      // run without it: what was read before the problem is still shown.
      async close() {
        if (closed) return;
        closed = true;
        if (open) { flush(); db.exec('COMMIT'); }
        insP.finalize(); insG.finalize(); insS.finalize(); insSn.finalize(); insA.finalize();
        self.edges = edges;
        self.identities = ids.result();
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
    this.counts = new Map();
    db.exec('DELETE FROM g WHERE att IN (SELECT id FROM wd)');
    // A name is withdrawn when the attestation whose range holds it is: found by sxa's key (n, kLo).
    db.exec(`DELETE FROM sx WHERE EXISTS (SELECT 1 FROM sxa WHERE sxa.n = sx.n AND sx.k BETWEEN sxa.kLo AND sxa.kHi
      AND sxa.att IN (SELECT id FROM wd))`);
    // Made after sxa is dropped, so that they go in the pages it held.
    db.exec('DROP TABLE sxa');
    db.exec('CREATE INDEX pid ON p(id)');
    db.exec('CREATE INDEX gn ON g(n)');
    db.exec("INSERT INTO sf(n, f) SELECT n, group_concat(fold, char(1)) FROM sx GROUP BY n ORDER BY n");
    db.exec("INSERT INTO sft(sft) VALUES ('rebuild')");
    const first = (col) => `(SELECT ${col} FROM g WHERE g.n=p.n AND g.rx IS NOT NULL ORDER BY g.rowid LIMIT 1)`;
    db.exec(`UPDATE p SET w=(SELECT MIN(w) FROM g WHERE g.n=p.n), s=(SELECT MIN(s) FROM g WHERE g.n=p.n),
      e=(SELECT MAX(e) FROM g WHERE g.n=p.n), nn=(SELECT MAX(nn) FROM g WHERE g.n=p.n), rx=${first('rx')}, ry=${first('ry')}`);
    // A place across the antimeridian, by one geometry (west > east) or by several either side of it
    // (a box wider than half the world): its boxes joined the short way round, not by MIN and MAX.
    const across = [];
    for (const q of this.rows('SELECT DISTINCT n FROM g WHERE w > e UNION SELECT n FROM p WHERE e - w > 180')) across.push(q.get(0));
    const upd = db.prepare('UPDATE p SET w=?, s=?, e=?, nn=? WHERE n=?');
    for (const n of across) {
      const boxes = [];
      for (const q of this.rows('SELECT w, s, e, nn FROM g WHERE n=? ORDER BY rowid', [n])) boxes.push([q.get(0), q.get(1), q.get(2), q.get(3)]);
      upd.bind([...unionBbox(boxes), n]).stepReset();
    }
    upd.finalize();
    // The overview reads this, not the records: every place with a point, in dataset order.
    db.exec('CREATE INDEX pov ON p(n, id, label, rx, ry) WHERE rx IS NOT NULL');
    db.exec('COMMIT');
  }

  *rows(sql, params = []) {
    const q = this.db.prepare(sql);
    try { if (params.length) q.bind(params); while (q.step()) yield q; } finally { q.finalize(); }
  }
  one(sql, params = []) { for (const q of this.rows(sql, params)) return q.get(0); return null; }

  /** Whether the dataset has a place under this key (placeKey). */
  has(id) { return this.one('SELECT 1 FROM p WHERE id=? LIMIT 1', [id]) !== null; }

  /**
   * Places whose label or a current name (toponym or romanized) holds `q`, case and accents aside, in
   * dataset order, each once; an empty q gives them all. A page is `limit` places after the place
   * numbered `after` (0: from the start): `next` is what to pass as `after` for the page after this
   * one, or null when there is none. Going on from a place, not counting past an offset, costs the
   * same on the last page as the first. `total` is counted once per query (folded), then remembered.
   * A place found by a name and not by its label has `matched`: the first such name, in the order of
   * its attestations.
   */
  search(q = '', { after = 0, limit = 50 } = {}) {
    const f = fold(q), from = Math.max(0, Number(after) || 0), max = Math.max(0, limit | 0);
    const like = '%' + f.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    // Three letters or more: the trigram index, asked for q as one phrase (every " doubled), which
    // finds each row holding q as it is, in rowid (dataset) order. Fewer: a scan of sf.
    const indexed = [...f].length >= 3, phrase = '"' + f.replace(/"/g, '""') + '"';
    const counts = this.counts || (this.counts = new Map());
    if (!counts.has(f)) {
      counts.set(f, !f ? this.one('SELECT COUNT(*) FROM p')
        : indexed ? this.one('SELECT COUNT(*) FROM sft WHERE sft MATCH ?', [phrase])
          : this.one("SELECT COUNT(*) FROM sf WHERE f LIKE ? ESCAPE '\\'", [like]));
    }
    const rows = [];
    // One more than the page, to know whether there is a page after it.
    const hits = indexed ? 'SELECT rowid AS n FROM sft WHERE rowid > ? AND sft MATCH ? ORDER BY rowid LIMIT ?'
      : "SELECT n FROM sf WHERE n > ? AND f LIKE ? ESCAPE '\\' ORDER BY n LIMIT ?";
    const sql = f
      ? `SELECT p.id, p.label, p.ccodes, p.w IS NOT NULL, p.n FROM (${hits}) h JOIN p ON p.n = h.n ORDER BY h.n`
      : 'SELECT id, label, ccodes, w IS NOT NULL, n FROM p WHERE n > ? ORDER BY n LIMIT ?';
    for (const r of this.rows(sql, f ? [from, indexed ? phrase : like, max + 1] : [from, max + 1])) {
      rows.push({ id: r.get(0), label: r.get(1), ccodes: JSON.parse(r.get(2)), hasGeometry: !!r.get(3), n: r.get(4) });
    }
    const more = rows.length > max;
    if (more) rows.pop();
    const items = [];
    // The name shown is the first that holds q, the label (k = 0, name null) before any.
    const which = f ? this.db.prepare("SELECT name FROM sx WHERE n = ? AND fold LIKE ? ESCAPE '\\' ORDER BY k LIMIT 1") : null;
    try {
      for (const { n, ...it } of rows) {
        if (which) {
          which.bind([n, like]);
          const name = which.step() ? which.get(0) : null;
          which.reset();
          if (name !== null) it.matched = name;
        }
        items.push(it);
      }
    } finally { which?.finalize(); }
    return { q, total: counts.get(f), items, next: more && rows.length ? rows[rows.length - 1].n : null };
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
    // Under the key it goes by here (placeKey), so that a place without an @id finds its drawings.
    const view = { ...viewPlace(rec, { withdrawn: this.withdrawnOf(rec), lookup: (other) => this.brief(other), ccodeBbox }), id, identities: this.identitiesOf(id) };
    // Where a search for its gazetteer record looks (#32): its nearest regions the dataset identifies, and its countries.
    view.scope = adoptScope(view, (r) => this.regionOf(r));
    return view;
  }
  /** What the whole dataset withdraws of a record's attestations: the retraction may be under another record. */
  withdrawnOf(rec) {
    const withdrawn = new Map();
    for (const a of Array.isArray(rec?.attestations) ? rec.attestations : []) {
      if (!a || typeof a['@id'] !== 'string') continue;
      const kind = this.one('SELECT kind FROM wd WHERE id=?', [a['@id']]);
      if (kind) withdrawn.set(a['@id'], kind);
    }
    return withdrawn;
  }
  /** A region of the dataset, for adoptScope: its label, relations and countries (as viewPlace reads them, withdrawals honoured), and identities. */
  regionOf(id) {
    const rec = this.record(id);
    if (!rec) return null;
    const v = viewPlace(rec, { withdrawn: this.withdrawnOf(rec) });
    return { label: v.label, relations: v.relations, ccodes: v.ccodes, identities: this.identitiesOf(id) };
  }
  /**
   * What the dataset currently says of a place's identities (Krisis's currentIdentities, read over the
   * whole dataset, withdrawals honoured): { linked, exact, denied } as lists of addresses, or null.
   */
  identitiesOf(id) {
    const e = this.identities?.get(id);
    return e ? { linked: [...e.linked], exact: [...e.exact], denied: [...e.denied] } : null;
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
  // With a place across the antimeridian, MIN and MAX are no box at all: the places' boxes are joined.
  if (withGeometry && store.one('SELECT 1 FROM p WHERE w > e LIMIT 1')) {
    bbox = unionBbox((function* () { for (const q of store.rows('SELECT w, s, e, nn FROM p WHERE w IS NOT NULL ORDER BY n')) yield [q.get(0), q.get(1), q.get(2), q.get(3)]; })());
  }
  store.loaded = {
    // A CSV or plain GeoJSON has no profile of its own: the one its column matching gave the run, so
    // that the storage a save needs counts a triple store only where it was read through one.
    input: { format: input.format, profile: input.profile || (input.format === 'csv' || input.format === 'geojson' ? await genericProfile(input) : null), name: name || input.name || input.files?.[0]?.name || null },
    header, places, bbox, withGeometry, withdrawn: store.one('SELECT COUNT(*) FROM wd'), report: r.report, incomplete: !!r.incomplete,
  };
  return store;
}
