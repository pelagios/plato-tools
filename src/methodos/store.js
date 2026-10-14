// Methodos: keeping a workflow's record in this browser (docs/plans/methodos.md, section 7; decision
// 3). One small record per workflow (src/engine/methodos/record.js): references to the user's files by
// name, size and SHA-256, never the files, and nothing in OPFS. Kept as its .workflow.json text in
// IndexedDB, database 'plato-tools-methodos', store 'workflows', keyed by the record's id, with
// a best-effort pattern, as Chora's own stores have (src/chora/resume.js): a browser that refuses storage (a
// private window, say) gets a workflow that lives for the tab.
//
// "Keep working data" (keepWorkingData() in src/lib/permissions.js) applies: with it off, a record is
// kept for the tab only, in sessionStorage under 'plato-tools.methodos.<id>', which the browser lets
// go when the tab closes, and every record kept in IndexedDB is let go the next time the store is
// used. What IndexedDB holds can be read by any page of the site's origin (DEVELOPERS.md, "The shared
// origin"), as the permissions panel says of the page's other working data.
import { keepWorkingData } from '../lib/permissions.js';
import { deserialise } from '../engine/methodos/runner.js';
import { exportRecord, recordOf } from '../engine/methodos/record.js';

// A FileSystemFileHandle to the file a workflow began with, where the browser can keep one (Chromium
// lets a handle be stored in IndexedDB; Firefox and Safari give none), is kept beside the records, in a
// database of its own, keyed by the record's id, so that resuming is one click (section 7). A handle is
// not the file, and not text: it is let go with the record, and with the records when working data is
// not kept.
export const DB = 'plato-tools-methodos', STORE = 'workflows', TAB = 'plato-tools.methodos.';
export const HANDLES = 'plato-tools-methodos-handles';
const PENDING = 'pending:';
// The link of a workflow to its project in WHG's Workbench (plan #34, item A1; src/methodos/whg.js):
// { projectId, version, sha256, shared, savedAt, base, title, state } as last saved to WHG or opened from it
// (`state`: the digest of the workflow and its review then, to say whether it has changed since), or,
// for a copy made from a share link, only { origin: { projectId, version } }. Kept beside the record, in a
// database of its own keyed by the record's id, and let go with it; with working data not kept, for the tab
// (sessionStorage, 'plato-tools.methodos-link.<id>'). Never in a project file, and never a token: a share
// link's token is not kept at all, only that the project is shared.
export const LINKS = 'plato-tools-methodos-links';
const LINK_TAB = 'plato-tools.methodos-link.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A link as kept, cleaned: only its known keys, each of its kind; null if it is none. */
export function cleanLink(v) {
  if (!v || typeof v !== 'object') return null;
  const out = {};
  if (UUID.test(v.projectId || '')) {
    out.projectId = v.projectId;
    if (Number.isSafeInteger(v.version) && v.version > 0) out.version = v.version;
    if (/^[0-9a-f]{64}$/.test(v.sha256 || '')) out.sha256 = v.sha256;
    out.shared = v.shared === true;
    if (typeof v.savedAt === 'string' && !Number.isNaN(Date.parse(v.savedAt))) out.savedAt = v.savedAt;
    if (typeof v.base === 'string' && /^https:\/\/[^\s?#]+\/$/.test(v.base)) out.base = v.base;
    if (typeof v.title === 'string') out.title = v.title.slice(0, 300);
    if (/^[0-9a-f]{64}$/.test(v.state || '')) out.state = v.state;
  }
  const o = v.origin;
  if (o && typeof o === 'object' && UUID.test(o.projectId || '') && Number.isSafeInteger(o.version)) out.origin = { projectId: o.projectId, version: o.version };
  return Object.keys(out).length ? out : null;
}

/**
 * A store of workflow records. Everything it is given can be replaced, for the tests: `indexedDB`,
 * `session` (a Storage) and `keep` (whether working data is kept between visits).
 */
export function workflowStore({ indexedDB, session, keep = keepWorkingData } = {}) {
  let idb = indexedDB, ss = session;
  if (idb === undefined) { try { idb = globalThis.indexedDB; } catch { idb = null; } }
  if (ss === undefined) { try { ss = globalThis.sessionStorage; } catch { ss = null; } }
  const memory = new Map();          // for the tab, when sessionStorage is refused too
  const tab = {
    get: (id) => { try { if (ss) return ss.getItem(TAB + id); } catch { /* refused */ } return memory.get(id) ?? null; },
    put: (id, text) => { try { if (ss) { ss.setItem(TAB + id, text); return; } } catch { /* refused */ } memory.set(id, text); },
    drop: (id) => { try { ss?.removeItem(TAB + id); } catch { /* refused */ } memory.delete(id); },
    all: () => {
      const out = new Map(memory);
      try { if (ss) for (let i = 0; i < ss.length; i++) { const k = ss.key(i); if (k?.startsWith(TAB)) out.set(k.slice(TAB.length), ss.getItem(k)); } } catch { /* refused */ }
      return [...out.values()];
    },
  };
  const open = (name = DB) => new Promise((resolve, reject) => {
    if (!idb) { reject(new Error('IndexedDB is not available')); return; }
    const req = idb.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('the workflows database is blocked'));
  });
  const tx = async (mode, fn, name = DB) => {
    const db = await open(name);
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode), req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(req.result);
        t.onerror = t.onabort = () => reject(t.error);
      });
    } finally { db.close(); }
  };
  const keeping = () => { try { return keep() !== false; } catch { return true; } };
  // With working data not kept, nothing stays in IndexedDB: not a record, nor the database. (Its
  // connections are each closed when their transaction ends, so the deletion is not held up by them.)
  const forget = (name) => new Promise((resolve) => {
    try {
      const req = idb.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch { resolve(); }
  });
  const forgetKept = async () => { await forget(DB); await forget(HANDLES); await forget(LINKS); };
  const linkTab = {
    get: (id) => { try { return JSON.parse(ss?.getItem(LINK_TAB + id) ?? 'null'); } catch { return null; } },
    put: (id, v) => { try { ss?.setItem(LINK_TAB + id, JSON.stringify(v)); return !!ss; } catch { return false; } },
    drop: (id) => { try { ss?.removeItem(LINK_TAB + id); } catch { /* refused */ } },
  };
  const read = (text) => { try { return text ? deserialise(text) : null; } catch { return null; } };

  return {
    /**
     * Save `state` (at a step boundary) as a record, and return the record and where it was kept:
     * 'browser' (IndexedDB), or 'tab' (working data not kept, or storage refused).
     */
    async save(state, { name } = {}) {
      const record = recordOf(state, { name });
      const text = exportRecord(record);
      if (keeping()) {
        try { await tx('readwrite', (s) => s.put(text, record.id)); tab.drop(record.id); return { record, kept: 'browser' }; } catch { /* the tab's, then */ }
      } else await forgetKept();
      tab.put(record.id, text);
      return { record, kept: 'tab' };
    },
    /** The record kept under `id`, or null. A damaged one is not returned. */
    async load(id) {
      const here = read(tab.get(id));
      if (!keeping()) { await forgetKept(); return here; }
      if (here) return here;
      try { return read(await tx('readonly', (s) => s.get(id))); } catch { return null; }
    },
    /** Every record kept, newest first. */
    async list() {
      const texts = tab.all();
      if (keeping()) { try { texts.push(...await tx('readonly', (s) => s.getAll())); } catch { /* the tab's only */ } } else await forgetKept();
      const byId = new Map();
      for (const r of texts.map(read).filter(Boolean)) if (!byId.has(r.id) || byId.get(r.id).saved < r.saved) byId.set(r.id, r);
      return [...byId.values()].sort((a, b) => (a.saved < b.saved ? 1 : -1));
    },
    /** Let the record go, wherever it was kept, and the file handle kept with it. */
    async remove(id) {
      tab.drop(id); linkTab.drop(id);
      if (!keeping()) { await forgetKept(); return; }
      try { await tx('readwrite', (s) => s.delete(id)); } catch { /* none kept */ }
      try { await tx('readwrite', (s) => s.delete(id), HANDLES); } catch { /* none kept */ }
      try { await tx('readwrite', (s) => s.delete(id), LINKS); } catch { /* none kept */ }
    },
    /**
     * Keep the link of the record `id` to WHG (cleanLink), or let it go (null): in IndexedDB where working
     * data is kept, else for the tab. Returns where it was kept: 'browser', 'tab', or null (let go).
     */
    async setLink(id, link) {
      const v = cleanLink(link);
      linkTab.drop(id);
      if (!v) { if (keeping()) { try { await tx('readwrite', (s) => s.delete(id), LINKS); } catch { /* none kept */ } } return null; }
      if (keeping()) { try { await tx('readwrite', (s) => s.put(v, id), LINKS); return 'browser'; } catch { /* the tab's, then */ } } else await forgetKept();
      return linkTab.put(id, v) ? 'tab' : null;
    },
    /** The link of the record `id` to WHG, or null. */
    async linkFor(id) {
      const here = cleanLink(linkTab.get(id));
      if (here || !keeping()) return here;
      try { return cleanLink(await tx('readonly', (s) => s.get(id), LINKS)); } catch { return null; }
    },
    /**
     * Keep `handle` (a FileSystemFileHandle) for the record `id`, where working data is kept and the
     * browser can store one: true if it was kept, false if not (it then lives only as long as the page).
     */
    async keepHandle(id, handle) {
      if (!keeping() || !handle) return false;
      try { await tx('readwrite', (s) => s.put(handle, id), HANDLES); return true; } catch { return false; }
    },
    /** The file handle kept for the record `id`, or null. */
    async handleFor(id) {
      if (!keeping()) return null;
      try { return (await tx('readonly', (s) => s.get(id), HANDLES)) || null; } catch { return null; }
    },
    /** Let everything kept in IndexedDB go, the database too (when "keep working data" is turned off). */
    forgetKept,
    // A workflow chosen before any file (Stephen, 4 October 2026): not a runner's state yet, only its
    // recipe and answers, { id, key, answers, saved }, kept beside the records under 'pending:<id>',
    // where list() and load() never take it for a record. It goes when its workflow begins, or is discarded.
    async savePending({ id, key, answers, scope }) {
      const text = JSON.stringify({ methodosPending: 1, id, key, answers, ...(scope ? { scope } : {}), saved: new Date().toISOString() });
      if (keeping()) { try { await tx('readwrite', (st) => st.put(text, PENDING + id)); tab.drop(PENDING + id); return 'browser'; } catch { /* the tab's, then */ } } else await forgetKept();
      tab.put(PENDING + id, text);
      return 'tab';
    },
    /** The workflows chosen before any file, newest first. */
    async pendings() {
      const texts = [];
      try { if (ss) for (let i = 0; i < ss.length; i++) { const k = ss.key(i); if (k?.startsWith(TAB + PENDING)) texts.push(ss.getItem(k)); } } catch { /* refused */ }
      for (const [k, v] of memory) if (k.startsWith(PENDING)) texts.push(v);
      if (keeping()) { try { const keys = await tx('readonly', (st) => st.getAllKeys()); for (const k of keys) if (String(k).startsWith(PENDING)) texts.push(await tx('readonly', (st) => st.get(k))); } catch { /* the tab's only */ } }
      const out = [];
      for (const t of texts) { try { const v = JSON.parse(t); if (v?.methodosPending === 1 && typeof v.id === 'string' && typeof v.key === 'string' && v.answers && typeof v.answers === 'object') out.push(v); } catch { /* not one */ } }
      const byId = new Map();
      for (const v of out) if (!byId.has(v.id) || byId.get(v.id).saved < v.saved) byId.set(v.id, v);
      return [...byId.values()].sort((a, b) => (a.saved < b.saved ? 1 : -1));
    },
    /** Let a workflow chosen before any file go. */
    async dropPending(id) {
      tab.drop(PENDING + id);
      if (!keeping()) return;
      try { await tx('readwrite', (st) => st.delete(PENDING + id)); } catch { /* none kept */ }
    },
  };
}
