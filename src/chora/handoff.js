// Files chosen on the main page, handed to Chora's page: kept in this browser's IndexedDB under one
// key, 'chora-handoff', as the File objects themselves (they can be stored as they are; the browser
// keeps a reference to the file on disk, or a copy, and nothing leaves the computer). The main page
// puts them there when the way to Chora is taken with files chosen; chora.html takes them at once and
// opens them, and one left longer than FRESH ago (the way taken, and Chora's page closed before it
// started) is let go without being opened, by Chora's page when it next starts and by the main page
// (dropStale) when it starts, is shown again or is left. FRESH is two minutes: the hand-over is a
// navigation and Chora's start, seconds; what is kept here can be read by any page of the site's
// origin (DEVELOPERS.md, "The shared origin"), so nothing lingers.
//
// The same record is the ROUND TRIP (Stephen, 12 October 2026, Issue #33 point 5): outside a
// workflow, and where working data is kept, the main page marks it `ret: { tab, tool }`, so that when it
// is back from Chora (its "Back to PLATO tools", or the browser's Back) it chooses those files again
// rather than losing them. The files are written once, for both roles. When Chora takes a record so
// marked it does not delete it: it writes a small stamp beside it, 'chora-handoff-alive', { id, at },
// which says the record was taken (so it is never opened twice) and that Chora's page is still alive.
// Chora stamps it again, without rewriting the files, every minute, when its page is hidden or shown,
// and when it is left. The round trip lives while Chora's page does and RETURN_FRESH (five minutes)
// after its last stamp; then whichever page looks first (dropStaleReturn, at the main page's start,
// show and leaving, and at Chora's start) lets it go. The main page takes it once, on a return, in the
// tab that wrote it (an id in that tab's sessionStorage, which a navigation in the same tab keeps and
// another tab has not), and only while working data is kept. Inside a workflow it is not marked: the
// workflow keeps its own files (src/methodos/outputs.js), and the main page chooses those again.
const DB = 'plato-tools-chora', STORE = 'kv', KEY = 'chora-handoff', ALIVE = 'chora-handoff-alive';
export const FRESH = 2 * 60 * 1000;
/** Five minutes after Chora's page last said it was alive: the round trip is let go after that. */
export const RETURN_FRESH = 5 * 60 * 1000;
/** How often Chora's page says it is alive while it is open. */
export const STAMP_EVERY = 60 * 1000;
/** Whether what was kept (`{at}`) is recent enough to use. */
export const isFresh = (v, now = Date.now()) => !!v && typeof v.at === 'number' && now - v.at >= 0 && now - v.at < FRESH;
const alive = (a, now) => !!a && typeof a.at === 'number' && now - a.at >= 0 && now - a.at < RETURN_FRESH;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
/** One transaction on the store, its request's result; shared with the hand-back (handback.js), which is kept in the same store. */
export async function tx(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode), req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}
/** Read the record and its stamp, and act on both (`fn(store, record, stamp)`, synchronously), in one read-write transaction. */
const both = (fn) => tx('readwrite', (s) => {
  const g = s.get(KEY);
  g.onsuccess = () => { const h = s.get(ALIVE); h.onsuccess = () => fn(s, g.result, h.result); };
  return g;
});
const taken = (v, a) => !!v && !!a && typeof v.id === 'string' && a.id === v.id;
const rid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// The tab's id, in its sessionStorage: which tab a round trip belongs to.
const TAB_KEY = 'plato-tools.chora-return';
const tabId = (session, make) => {
  try {
    let id = session.getItem(TAB_KEY);
    if (!id && make) { id = rid(); session.setItem(TAB_KEY, id); }
    return id || null;
  } catch { return null; }
};
const sessionOf = () => { try { return globalThis.sessionStorage; } catch { return null; } };

/**
 * Keep `files` for Chora's page; with `forReturn` ({ tool }), marked as the round trip of this tab too.
 * Best effort: a browser that refuses (a private window, say) just hands nothing over. True if kept.
 */
export async function stash(files, { forReturn = null, session = sessionOf() } = {}) {
  const tab = forReturn && session ? tabId(session, true) : null;
  const ret = tab ? { tab, tool: typeof forReturn.tool === 'string' ? forReturn.tool : null } : null;
  try {
    await both((s) => { s.put({ files: [...files], at: Date.now(), id: rid(), ...(ret ? { ret } : {}) }, KEY); s.delete(ALIVE); });
    return true;
  } catch { return false; }
}
/** Let the files go, and the round trip's stamp. */
export async function clear() { try { await both((s) => { s.delete(KEY); s.delete(ALIVE); }); } catch {} }
/**
 * The files kept for Chora's page, or null: if kept in the last few minutes and not taken before. Taken
 * in one transaction: let go, unless they are the round trip and working data is kept (`keep`), when
 * they stay and are stamped as taken and alive.
 */
export async function take({ keep = true, now = Date.now() } = {}) {
  let got = null;
  try {
    await both((s, v, a) => {
      if (!v || taken(v, a)) return;                       // nothing, or the round trip waiting: never opened twice
      if (v.files?.length && isFresh(v, now)) got = v.files;
      if (got && v.ret && keep) s.put({ id: v.id, at: now }, ALIVE);
      else { s.delete(KEY); s.delete(ALIVE); }
    });
  } catch { return null; }
  return got;
}
/** Let a hand-over go that is no longer fresh and was never taken (Chora's page never started); a fresh one, or a round trip, is kept. True if one went. */
export async function dropStale(now = Date.now()) {
  let went = false;
  try { await both((s, v, a) => { if (v && !taken(v, a) && !isFresh(v, now)) { s.delete(KEY); went = true; } }); } catch { return false; }
  return went;
}

/**
 * The round trip, if `v` (the record) and `a` (its stamp) are one for this tab (`tab`) whose Chora page
 * was alive in the last RETURN_FRESH, as { files, tool }: files that are files (each with a name, a size
 * and a stream), and the tool chosen then (a key of letters, or null; the page checks it is one of its
 * tools). Else null.
 */
const TOOL = /^[a-z]{1,32}$/;
export function returnOf(v, a, tab, now = Date.now()) {
  if (!v || typeof v !== 'object' || !v.ret || typeof tab !== 'string' || !tab || v.ret.tab !== tab || !taken(v, a) || !alive(a, now)) return null;
  if (!Array.isArray(v.files) || !v.files.length || !v.files.every((f) => f && typeof f.name === 'string' && typeof f.size === 'number' && typeof f.stream === 'function')) return null;
  return { files: [...v.files], tool: typeof v.ret.tool === 'string' && TOOL.test(v.ret.tool) ? v.ret.tool : null };
}
/** Chora's page: say it is alive, if it holds a round trip (a small write, the stamp alone; the files are not rewritten). */
export async function stamp(now = Date.now()) {
  try { await tx('readwrite', (s) => { const r = s.get(ALIVE); r.onsuccess = () => { if (r.result?.id) s.put({ id: r.result.id, at: now }, ALIVE); }; return r; }); } catch { /* not kept */ }
}
/** The names of the files kept for this tab's return (Chora says so on its way back), without taking them; or null. */
export async function returnKept({ session = sessionOf(), now = Date.now() } = {}) {
  let got = null;
  try { await both((s, v, a) => { got = returnOf(v, a, session && tabId(session, false), now); }); } catch { return null; }
  return got ? got.files.map((f) => f.name) : null;
}
/**
 * For the main page, back from Chora: the round trip kept for this tab, { files, tool }, or null; taken,
 * so that it is used once. Read, judged and deleted in one transaction: this tab's goes, used or not;
 * another tab's is left for it, unless it is stale. With working data no longer kept (`keep` false),
 * nothing is used, and this tab's goes.
 */
export async function takeReturn({ keep = true, session = sessionOf(), now = Date.now() } = {}) {
  const tab = session && tabId(session, false);
  let got = null;
  try {
    await both((s, v, a) => {
      if (!v?.ret || !taken(v, a)) return;
      const mine = v.ret.tab === tab;
      if (keep) got = returnOf(v, a, tab, now);
      if (mine || !alive(a, now)) { s.delete(KEY); s.delete(ALIVE); }
    });
  } catch { return null; }
  return got;
}
/** Let a round trip go whose Chora page has not said it is alive for RETURN_FRESH, and a stamp left with no record. True if one went. */
export async function dropStaleReturn(now = Date.now()) {
  let went = false;
  try {
    await both((s, v, a) => {
      if (taken(v, a) && !alive(a, now)) { s.delete(KEY); s.delete(ALIVE); went = true; }
      else if (a && !taken(v, a)) { s.delete(ALIVE); went = true; }
    });
  } catch { return false; }
  return went;
}
/** Working data turned off: a round trip kept, taken by Chora or not yet, goes at once, files and all; a plain hand-over stays for Chora to take. */
export async function forgetReturn() {
  try { await both((s, v, a) => { if (taken(v, a) || v?.ret) { s.delete(KEY); s.delete(ALIVE); } else if (a) s.delete(ALIVE); }); } catch { /* none */ }
}

// The same store carries Chora's page across its own reload, when the user allows a site (the
// Content Security Policy is written at load, so a site allowed is reachable only from the next one):
// the files open, the place chosen and where the map was. Kept under its own key, 'chora-resume',
// taken once, and not used if older than FRESH.
const RESUME = 'chora-resume';
/** Keep `value` ({files, placeId, camera, …}) for the page after the reload. */
export async function keepForReload(value) {
  try { await tx('readwrite', (s) => s.put({ ...value, files: [...(value.files || [])], at: Date.now() }, RESUME)); return true; } catch { return false; }
}
/** What was kept for this load, or null: taken, so that it is used once. */
export async function takeResume() {
  let v;
  try { v = await tx('readonly', (s) => s.get(RESUME)); await tx('readwrite', (s) => s.delete(RESUME)); } catch { return null; }
  return isFresh(v) ? v : null;
}
