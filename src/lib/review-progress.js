// Krisis: a review's progress, kept in this browser as it is made, so that a tab closed or a page
// reloaded before "Save the review" (or a workflow's "This step is done") loses no decision. What is
// kept is the review as "Save the review" would write it (the work file's own text, serialiseWork():
// the work file's format is not changed, and nothing here is written to a dataset), under a key of the
// review itself (reviewKey: when its suggestions were made, and the files they were made from), with
// when it was last changed and under what name. It is put back when the same review is opened here
// again (onOpen, below), and the page says so in one line, with a way to clear it.
//
// Kept where a workflow's record is, and by the same rule (src/methodos/store.js): in IndexedDB, in a
// database of its own ('plato-tools-krisis-progress', store 'reviews', keyed by the review's key), the
// latest MOST reviews; with "Keep my working data between visits" off (keepWorkingData() in
// src/lib/permissions.js), for the tab only (sessionStorage, 'plato-tools.krisis-progress.<key>', which
// the browser lets go when the tab closes), and what IndexedDB held is let go the next time the store
// is used. A browser that refuses both keeps it for the page alone, and the page says it is not kept.
// Nothing is sent anywhere: there is no request in this file. What the browser holds can be read, and
// written, by any page of the site's origin (DEVELOPERS.md, "The shared origin"), so a record read back
// is checked by the work file's own reader (readWork) and must be of the review it is kept under.
//
// A large review, and the page held. Measured in Chromium (e2e/review_autosave_scale.py, November 2026), a review of
// 50,000 decisions is 108 MB as "Save the review" writes it: making that text at once held the page for 1.1 s, and
// one put of it into IndexedDB for another 0.4 s (0.2 s and 0.2 s at 10,000), at every keeping. So a large review is
// written out in pieces, the page answering between them (recordSlowly: the same review, as JSON without the
// indentation, in parts of about PART characters; given up, never kept half-made, if the review changes meanwhile),
// and a record longer than PART is kept as rows of its own (the store 'parts', keyed [key, n]), each put a task of
// its own within the one transaction, so that the record is replaced whole or not at all. A review of ordinary size
// is made and kept as before, its text in its one row. sessionStorage holds about five million characters for the
// whole origin (2,183 decisions of that shape, measured): a record that cannot fit is not tried there.
import { keepWorkingData } from './permissions.js';
import { sha256 } from './sha256.js';
import { readWork, serialiseWork, reviewProgress } from '../engine/krisis/work.js';

export const DB = 'plato-tools-krisis-progress', STORE = 'reviews', PARTS = 'parts', TAB = 'plato-tools.krisis-progress.';
/** The database's version: 2 since the store of a long record's parts was added (a version 1 database is upgraded as it is, its records kept). */
export const DB_VERSION = 2;
/** About how many characters a part of a long record holds; a record's text longer than this is kept in parts. */
export const PART = 1_000_000;
/** From how many candidates a review is written out in pieces (recordSlowly) and not at once (recordOf): at once, 2,000 hold the page some 60 ms. */
export const SLOWLY_FROM = 2000;
/** More characters than any browser's sessionStorage holds for an origin (about 5.2 million in Chromium, measured): a longer record is not tried there. */
export const TAB_MOST = 11_000_000;
/** How many reviews' progress is kept between visits: the latest changed; an older one is let go. */
export const MOST = 20;
const KEY = /^[0-9a-f]{64}$/;

const filesOf = (side) => (side && Array.isArray(side.files) ? side.files.map((f) => [f.sha256, f.size]) : null);
/**
 * A review's key: the same for a work file however far its review has gone (its decisions, its
 * lookups, its cursor and its reviewer are not in it), another for another match or lookup, even of
 * the same files (when its suggestions were made is in it).
 */
export function reviewKey(work) {
  return sha256(JSON.stringify([work.generated_at, work.algorithm_version, filesOf(work.subjects), filesOf(work.others)]));
}

/**
 * When the latest thing a work file records was done, in milliseconds: its suggestions made, a
 * decision, a lookup begun or ended, a batch of the bulk accept, a Finish. (A flag, a note and a row's
 * state record no time.)
 */
export function latestIn(work) {
  const times = [work.generated_at];
  for (const c of work.candidates || []) if (c.decision) times.push(c.decision.decided_at);
  for (const l of work.lookups || []) times.push(l.started_at, l.finished_at);
  for (const b of work.batches || []) times.push(b.at);
  for (const f of work.finished || []) times.push(f.at);
  let latest = 0;
  for (const t of times) { const ms = typeof t === 'string' ? Date.parse(t) : NaN; if (ms > latest) latest = ms; }
  return latest;
}

/** Whether two reviews hold the same, whichever place each is at. */
export const sameWork = (a, b) => JSON.stringify({ ...a, cursor: 0 }) === JSON.stringify({ ...b, cursor: 0 });

/** How many candidates are decided otherwise in `a` than in `b` (one there in only one of them counts if it is decided). */
export function decidedOtherwise(a, b) {
  const of = (w) => new Map(w.candidates.map((c) => [c.id, c.decision ? JSON.stringify(c.decision) : null]));
  const x = of(a), y = of(b);
  let n = 0;
  for (const id of new Set([...x.keys(), ...y.keys()])) if ((x.get(id) ?? null) !== (y.get(id) ?? null)) n++;
  return n;
}

/**
 * The record kept of `work` as it stands: at `cursor`, under `name`, last changed at `at` (a Date). `unsaved`: it holds
 * what no file has (something was decided since the review was begun, opened or last saved); `workflow`: it is a
 * workflow's review, which the workflow itself brings back. A review that is unsaved and no workflow's is the one
 * offered when the page next opens (offerable, below).
 */
export function recordOf(work, { name = 'review.krisis.json', cursor = work.cursor, at = new Date(), unsaved = false, workflow = false } = {}) {
  return { krisisProgress: 1, key: reviewKey(work), name: String(name).slice(0, 255), at: at.toISOString(), reviewed: reviewProgress(work).reviewed,
    ...(unsaved ? { unsaved: true } : {}), ...(workflow ? { workflow: true } : {}),
    text: serialiseWork({ ...work, cursor: Number.isInteger(cursor) && cursor >= 0 ? cursor : 0 }) };
}
/**
 * Whether a record as kept (not yet checked) is one to offer when the page opens with no review on it: a match review
 * begun outside a workflow, holding what was never saved to a file. A record kept before this was recorded says
 * neither, and is not offered (it is still put back when its own file is opened).
 */
export const offerable = (v) => !!v && typeof v === 'object' && v.krisisProgress === 1 && v.unsaved === true && v.workflow !== true;

// ---- a large review, written out in pieces ------------------------------------------------------------------
const BIG = 200;
const isObject = (v) => v !== null && typeof v === 'object';
const sizeOf = (v) => (Array.isArray(v) ? v.length : Object.keys(v).length);
const left_out = (x) => x === undefined || typeof x === 'function' || typeof x === 'symbol';
/**
 * `value` as JSON, in pieces which joined are what JSON.stringify(value) gives (for what a work file holds: plain
 * objects, arrays, strings, numbers, true, false and null). The top two levels are always taken apart (the work
 * file, then each of its fields: the candidates one by one, the places one by one), and below them whatever is
 * large or holds something large (a lookup, for its queries, one for each place); the rest is written whole, so
 * that no piece is long and none is so short that the pieces cost more than the writing.
 */
export function* jsonPieces(value, depth = 0) {
  if (!isObject(value) || typeof value.toJSON === 'function') { yield JSON.stringify(value) ?? 'null'; return; }
  if (!(depth < 2 || sizeOf(value) > BIG || Object.values(value).some((x) => isObject(x) && sizeOf(x) > BIG))) { yield JSON.stringify(value); return; }
  if (Array.isArray(value)) {
    yield '[';
    for (let i = 0; i < value.length; i++) { if (i) yield ','; if (left_out(value[i])) yield 'null'; else yield* jsonPieces(value[i], depth + 1); }
    yield ']';
    return;
  }
  yield '{';
  let first = true;
  for (const k of Object.keys(value)) {
    if (left_out(value[k])) continue;
    yield `${first ? '' : ','}${JSON.stringify(k)}:`; first = false;
    yield* jsonPieces(value[k], depth + 1);
  }
  yield '}';
}
const breathe = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const clock = () => (globalThis.performance ? globalThis.performance.now() : Date.now());
/**
 * The record of `work` as recordOf makes it, made without holding the page: written out in pieces, for `budget`
 * milliseconds at a time, the page given a turn between (`pause`), its text in `parts` (which joined are the work
 * file, as JSON without the indentation). `changed` is asked after every turn given whether the review has changed
 * since the writing began: if it has, what was written is of two states of the review, and null is returned (the
 * caller begins again). Without a `changed` nothing is known to change it: only for a review nothing else touches.
 */
export async function recordSlowly(work, { name = 'review.krisis.json', cursor = work.cursor, at, changed = () => false, budget = 8, pause = breathe, unsaved = false, workflow = false } = {}) {
  const head = { krisisProgress: 1, key: reviewKey(work), name: String(name).slice(0, 255), reviewed: reviewProgress(work).reviewed, ...(unsaved ? { unsaved: true } : {}), ...(workflow ? { workflow: true } : {}) };
  const parts = [];
  let part = '', since = clock(), n = 0;
  for (const piece of jsonPieces({ ...work, cursor: Number.isInteger(cursor) && cursor >= 0 ? cursor : 0 })) {
    part += piece;
    if (part.length >= PART) { parts.push(part); part = ''; }
    if (++n % 16 === 0 && clock() - since >= budget) {
      await pause();
      if (changed()) return null;
      since = clock();
    }
  }
  parts.push(`${part}\n`);
  return { ...head, at: (at || new Date()).toISOString(), parts };
}
/** A record's text: its own, or its parts joined; null if it has neither. */
export function textOf(v) {
  if (typeof v?.text === 'string') return v.text;
  return Array.isArray(v?.parts) && v.parts.length && v.parts.every((p) => typeof p === 'string') ? v.parts.join('') : null;
}
const charsOf = (v) => (typeof v.text === 'string' ? v.text.length : v.parts.reduce((n, p) => n + p.length, 0));

/**
 * A record read back, checked: { key, name, at, reviewed, work }, or null if it is not one (not a
 * record, a review the work file's reader refuses, or one kept under another review's key).
 */
export function readRecord(v, key) {
  if (!v || typeof v !== 'object' || v.krisisProgress !== 1 || !KEY.test(v.key || '') || (key !== undefined && v.key !== key)) return null;
  const text = textOf(v);
  if (typeof v.at !== 'string' || Number.isNaN(Date.parse(v.at)) || text === null) return null;
  let work;
  try { work = readWork(text); } catch { return null; }
  if (reviewKey(work) !== v.key) return null;
  const p = reviewProgress(work);
  return { key: v.key, name: typeof v.name === 'string' && v.name ? v.name.slice(0, 255) : 'review.krisis.json', at: v.at, reviewed: p.reviewed, total: p.total, unsaved: v.unsaved === true, workflow: v.workflow === true, work };
}

/**
 * What to do with the progress kept (`record`, from readRecord, or null) when `work` is opened from a
 * file: 'none' (nothing is kept of it, or what is kept is what the file holds); 'restore' (what is
 * kept was changed after everything the file records: it is put back, and the page says so); or
 * 'offer' (the file is shown, and what is kept is offered, never taken unasked): when the file
 * records something later than what is kept, and when the review was `open` on the page as the file
 * was chosen (what is kept is then the page's own, which the user chose the file over: to go back to
 * it as saved, say). `use`: the user asked for what is kept. With 'restore' and 'offer' come the
 * record, how many places the file has reviewed, and how many candidates are decided otherwise in
 * what is kept.
 */
export function onOpen(work, record, { use = false, open = false } = {}) {
  if (!record || record.key !== reviewKey(work) || sameWork(work, record.work)) return { action: 'none', record: record && record.key === reviewKey(work) ? record : null };
  const later = Date.parse(record.at) > latestIn(work);
  return { action: use || (later && !open) ? 'restore' : 'offer', record, fileReviewed: reviewProgress(work).reviewed, differing: decidedOtherwise(work, record.work) };
}

/**
 * The store. Everything it is given can be replaced, for the tests: `indexedDB`, `session` (a Storage)
 * and `keep` (whether working data is kept between visits).
 */
export function progressStore({ indexedDB, session, keep = keepWorkingData } = {}) {
  let idb = indexedDB, ss = session;
  if (idb === undefined) { try { idb = globalThis.indexedDB; } catch { idb = null; } }
  if (ss === undefined) { try { ss = globalThis.sessionStorage; } catch { ss = null; } }
  const memory = new Map();          // for the page, when sessionStorage is refused too, or has not the room
  const keeping = () => { try { return keep() !== false; } catch { return true; } };
  const tab = {
    get: (key) => { try { const t = ss?.getItem(TAB + key); if (t) return JSON.parse(t); } catch { /* refused, or not JSON */ } return memory.get(key) ?? null; },
    // 'tab' where the tab keeps it (it is there after a reload), 'page' where only this page does.
    // A record longer than any sessionStorage holds is not tried there (writing 120 MB out to be refused held the page 0.8 s).
    put: (key, v) => {
      try {
        if (ss && charsOf(v) <= TAB_MOST) { const { parts, ...head } = v; ss.setItem(TAB + key, JSON.stringify(parts ? { ...head, text: parts.join('') } : v)); memory.delete(key); return 'tab'; }
        ss?.removeItem(TAB + key);
      } catch { try { ss.removeItem(TAB + key); } catch { /* refused */ } }
      memory.set(key, v); return 'page';
    },
    drop: (key) => { try { ss?.removeItem(TAB + key); } catch { /* refused */ } memory.delete(key); },
    dropAll: () => {
      memory.clear();
      try { if (ss) for (let i = ss.length - 1; i >= 0; i--) { const k = ss.key(i); if (k?.startsWith(TAB)) ss.removeItem(k); } } catch { /* refused */ }
    },
  };
  const open = () => new Promise((resolve, reject) => {
    if (!idb) { reject(new Error('IndexedDB is not available')); return; }
    const req = idb.open(DB, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('at', 'at');
      if (!db.objectStoreNames.contains(PARTS)) db.createObjectStore(PARTS);   // a long record's text, in rows keyed [key, n]
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('the database is blocked'));
  });
  // One transaction over both stores: `fn` is given them and a box, and what it leaves in box.out is the answer once
  // the transaction is complete (so that nothing is answered of a transaction that then failed).
  const tx = async (mode, fn) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction([STORE, PARTS], mode), box = {};
        t.oncomplete = () => resolve(box.out);
        t.onerror = t.onabort = () => reject(t.error);
        fn(t.objectStore(STORE), t.objectStore(PARTS), box);
      });
    } finally { db.close(); }
  };
  const partsOf = (head) => (Number.isInteger(head?.parts) && head.parts > 0 ? head.parts : 0);
  /** The parts of the record whose row is `head` let go (the row itself is the caller's). */
  const dropParts = (p, head) => { for (let i = 0; i < partsOf(head); i++) p.delete([head.key, i]); };
  /** The record's text as the rows it is kept in, or null where it is kept in its own row. */
  const rowsOf = (record) => {
    if (Array.isArray(record.parts)) return record.parts;
    if (record.text.length <= PART) return null;
    const rows = [];
    for (let i = 0; i < record.text.length; i += PART) rows.push(record.text.slice(i, i + PART));
    return rows;
  };
  /**
   * `record` in place of what was kept of its review, in the one transaction: what was kept is read (for its
   * parts, let go), the new parts are put, then its row, and then the oldest reviews over MOST are let go, parts
   * and all. Each part is put when the one before it is in (a task each: the page answers between them), or, with
   * `atOnce`, all are put now (the page is leaving: nothing later would be done).
   */
  const keepRecord = (s, p, record, atOnce) => {
    const rows = rowsOf(record);
    const { parts, text, ...head } = record;
    const finish = () => {
      s.put(rows ? { ...head, parts: rows.length } : { ...head, text });
      // The latest MOST are kept (a review is a row of this store; its parts are in the other): the ones changed longest ago are let go.
      const n = s.count();
      n.onsuccess = () => {
        let over = n.result - MOST;
        if (over > 0) s.index('at').openCursor().onsuccess = (e) => { const c = e.target.result; if (c && over-- > 0) { dropParts(p, c.value); s.delete(c.primaryKey); c.continue(); } };
      };
    };
    s.get(record.key).onsuccess = (e) => {
      dropParts(p, e.target.result);
      if (!rows) { finish(); return; }
      if (atOnce) { rows.forEach((row, i) => p.put(row, [record.key, i])); finish(); return; }
      let i = 0;
      const next = () => { if (i === rows.length) finish(); else { p.put(rows[i], [record.key, i]).onsuccess = next; i++; } };
      next();
    };
  };
  /** The record kept under `key`, its parts joined (box.out): as it was put, or undefined; a record with a part missing is none. */
  const read = (s, p, box, key) => {
    s.get(key).onsuccess = (e) => {
      const head = e.target.result, n = partsOf(head);
      if (!n) { box.out = head; return; }
      const texts = new Array(n);
      let got = 0;
      for (let i = 0; i < n; i++) p.get([key, i]).onsuccess = (g) => { texts[i] = g.target.result; if (++got === n) box.out = texts.every((x) => typeof x === 'string') ? { ...head, parts: texts } : undefined; };
    };
  };
  // With working data not kept, nothing stays in IndexedDB: not a record, nor the database.
  const forgetKept = () => new Promise((resolve) => {
    try {
      const req = idb.deleteDatabase(DB);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch { resolve(); }
  });
  // One write at a time, in the order asked: an earlier state never lands on a later one.
  let queue = Promise.resolve();
  const serial = (fn) => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };

  return {
    /**
     * Keep `record` (recordOf, or recordSlowly) in place of what was kept of its review; `atOnce` when the page is
     * leaving (a long record's parts are then all put now, not one after another). Returns where: 'browser'
     * (IndexedDB, between visits), 'tab' (working data not kept, or IndexedDB refused: until the tab
     * closes), or 'page' (the browser kept it nowhere: it does not outlive this page).
     */
    put(record, { atOnce = false } = {}) {
      return serial(async () => {
        if (keeping()) {
          try {
            await tx('readwrite', (s, p) => keepRecord(s, p, record, atOnce));
            tab.drop(record.key);
            return 'browser';
          } catch { /* the tab's, then */ }
        } else await forgetKept();
        return tab.put(record.key, record);
      });
    },
    /**
     * What is kept of the review `key`, checked (readRecord), or null: the tab's, or the browser's,
     * whichever was changed later. Read after any keeping still under way, so that it is the latest.
     */
    get(key) {
      return serial(async () => {
        const here = readRecord(tab.get(key), key);
        if (!keeping()) { await forgetKept(); return here; }
        let there = null;
        try { there = readRecord(await tx('readonly', (s, p, box) => read(s, p, box, key)), key); } catch { /* the tab's only */ }
        if (here && there) return Date.parse(here.at) >= Date.parse(there.at) ? here : there;
        return here || there;
      });
    },
    /**
     * The review to offer as the page opens with none on it, checked (readRecord), or null: of those kept that were
     * never saved and are no workflow's (offerable), the one changed last, the browser's or (where IndexedDB refused
     * it) the tab's. With "keep working data" off there is none: nothing is kept between visits, and nothing offered.
     */
    latestOffer() {
      return serial(async () => {
        if (!keeping()) { await forgetKept(); return null; }
        let here = null;
        try {
          if (ss) for (let i = 0; i < ss.length; i++) {
            const k = ss.key(i);
            if (!k?.startsWith(TAB)) continue;
            const v = tab.get(k.slice(TAB.length)), r = offerable(v) ? readRecord(v, k.slice(TAB.length)) : null;
            if (r && (!here || Date.parse(r.at) > Date.parse(here.at))) here = r;
          }
        } catch { /* refused: the browser's only */ }
        let there = null;
        try {
          // From the one changed last: the rows that may be offered (a row says so itself; a long record's text is in its parts)…
          const keys = await tx('readonly', (st, _p, box) => {
            box.out = [];
            st.index('at').openCursor(null, 'prev').onsuccess = (e) => { const c = e.target.result; if (!c) return; if (offerable(c.value)) box.out.push(c.value.key); c.continue(); };
          });
          // …and of those, the first that reads back whole.
          for (const key of keys) {
            there = readRecord(await tx('readonly', (st, pt, box) => read(st, pt, box, key)), key);
            if (there) break;
          }
        } catch { /* the tab's only */ }
        if (here && there) return Date.parse(here.at) >= Date.parse(there.at) ? here : there;
        return here || there;
      });
    },
    /** Let what is kept of the review `key` go, wherever it is, after any keeping of it still under way. */
    forget(key) {
      return serial(async () => {
        tab.drop(key);
        if (!keeping()) { await forgetKept(); return; }
        try { await tx('readwrite', (s, p) => { s.get(key).onsuccess = (e) => { dropParts(p, e.target.result); s.delete(key); }; }); } catch { /* none kept */ }
      });
    },
    /** Let everything kept between visits go, the database too ("keep working data" turned off), after any keeping still under way. */
    forgetKept: () => serial(forgetKept),
    /** Let everything go, the tab's too. */
    forgetAll: () => serial(async () => { tab.dropAll(); await forgetKept(); }),
  };
}
