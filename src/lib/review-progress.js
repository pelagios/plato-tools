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
import { keepWorkingData } from './permissions.js';
import { sha256 } from './sha256.js';
import { readWork, serialiseWork, reviewProgress } from '../engine/krisis/work.js';

export const DB = 'plato-tools-krisis-progress', STORE = 'reviews', TAB = 'plato-tools.krisis-progress.';
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

/** The record kept of `work` as it stands: at `cursor`, under `name`, last changed at `at` (a Date). */
export function recordOf(work, { name = 'review.krisis.json', cursor = work.cursor, at = new Date() } = {}) {
  return { krisisProgress: 1, key: reviewKey(work), name: String(name).slice(0, 255), at: at.toISOString(), reviewed: reviewProgress(work).reviewed,
    text: serialiseWork({ ...work, cursor: Number.isInteger(cursor) && cursor >= 0 ? cursor : 0 }) };
}

/**
 * A record read back, checked: { key, name, at, reviewed, work }, or null if it is not one (not a
 * record, a review the work file's reader refuses, or one kept under another review's key).
 */
export function readRecord(v, key) {
  if (!v || typeof v !== 'object' || v.krisisProgress !== 1 || !KEY.test(v.key || '') || (key !== undefined && v.key !== key)) return null;
  if (typeof v.at !== 'string' || Number.isNaN(Date.parse(v.at)) || typeof v.text !== 'string') return null;
  let work;
  try { work = readWork(v.text); } catch { return null; }
  if (reviewKey(work) !== v.key) return null;
  return { key: v.key, name: typeof v.name === 'string' && v.name ? v.name.slice(0, 255) : 'review.krisis.json', at: v.at, reviewed: reviewProgress(work).reviewed, work };
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
    put: (key, v) => { try { if (ss) { ss.setItem(TAB + key, JSON.stringify(v)); memory.delete(key); return 'tab'; } } catch { try { ss.removeItem(TAB + key); } catch { /* refused */ } } memory.set(key, v); return 'page'; },
    drop: (key) => { try { ss?.removeItem(TAB + key); } catch { /* refused */ } memory.delete(key); },
    dropAll: () => {
      memory.clear();
      try { if (ss) for (let i = ss.length - 1; i >= 0; i--) { const k = ss.key(i); if (k?.startsWith(TAB)) ss.removeItem(k); } } catch { /* refused */ }
    },
  };
  const open = () => new Promise((resolve, reject) => {
    if (!idb) { reject(new Error('IndexedDB is not available')); return; }
    const req = idb.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' }).createIndex('at', 'at');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('the database is blocked'));
  });
  const tx = async (mode, fn) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode), out = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(out?.result);
        t.onerror = t.onabort = () => reject(t.error);
      });
    } finally { db.close(); }
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
     * Keep `record` (recordOf) in place of what was kept of its review. Returns where: 'browser'
     * (IndexedDB, between visits), 'tab' (working data not kept, or IndexedDB refused: until the tab
     * closes), or 'page' (the browser kept it nowhere: it does not outlive this page).
     */
    put(record) {
      return serial(async () => {
        if (keeping()) {
          try {
            await tx('readwrite', (s) => {
              s.put(record);
              // The latest MOST are kept: the ones changed longest ago are let go.
              const n = s.count();
              n.onsuccess = () => {
                let over = n.result - MOST;
                if (over > 0) s.index('at').openKeyCursor().onsuccess = (e) => { const c = e.target.result; if (c && over-- > 0) { s.delete(c.primaryKey); c.continue(); } };
              };
            });
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
        try { there = readRecord(await tx('readonly', (s) => s.get(key)), key); } catch { /* the tab's only */ }
        if (here && there) return Date.parse(here.at) >= Date.parse(there.at) ? here : there;
        return here || there;
      });
    },
    /** Let what is kept of the review `key` go, wherever it is, after any keeping of it still under way. */
    forget(key) {
      return serial(async () => {
        tab.drop(key);
        if (!keeping()) { await forgetKept(); return; }
        try { await tx('readwrite', (s) => s.delete(key)); } catch { /* none kept */ }
      });
    },
    /** Let everything kept between visits go, the database too ("keep working data" turned off), after any keeping still under way. */
    forgetKept: () => serial(forgetKept),
    /** Let everything go, the tab's too. */
    forgetAll: () => serial(async () => { tab.dropAll(); await forgetKept(); }),
  };
}
