// Files chosen on the main page, handed to Chora's page: kept in this browser's IndexedDB under one
// key, 'chora-handoff', as the File objects themselves (they can be stored as they are; the browser
// keeps a reference to the file on disk, or a copy, and nothing leaves the computer). The main page
// puts them there when the way to Chora is taken with files chosen; chora.html takes them at once,
// holding them in the page to offer, so that no copy lingers, and one left longer than FRESH ago (the
// way taken, and Chora's page closed before it started) is let go without an offer, by Chora's page
// when it next starts and by the main page (dropStale) when it starts, is shown again or is left.
// FRESH is two minutes: the hand-over is a navigation and Chora's start, seconds; what is kept here can
// be read by any page of the site's origin (DEVELOPERS.md, "The shared origin"), so nothing lingers.
const DB = 'plato-tools-chora', STORE = 'kv', KEY = 'chora-handoff';
export const FRESH = 2 * 60 * 1000;
/** Whether what was kept (`{at}`) is recent enough to use. */
export const isFresh = (v, now = Date.now()) => !!v && typeof v.at === 'number' && now - v.at >= 0 && now - v.at < FRESH;

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

/** Keep `files` for Chora's page. Best effort: a browser that refuses (a private window, say) just gets no offer. */
export async function stash(files) {
  try { await tx('readwrite', (s) => s.put({ files: [...files], at: Date.now() }, KEY)); } catch {}
}
/** Let the files go. */
export async function clear() { try { await tx('readwrite', (s) => s.delete(KEY)); } catch {} }
/** The files kept for Chora's page, or null: taken, so that the browser keeps them no longer, if kept in the last few minutes. */
export async function take() {
  let v;
  try { v = await tx('readonly', (s) => s.get(KEY)); } catch { return null; }
  await clear();
  return v?.files?.length && isFresh(v) ? v.files : null;
}
/** Let a hand-over go that is no longer fresh (Chora's page never took it); a fresh one is kept. True if one went. */
export async function dropStale() {
  let v;
  try { v = await tx('readonly', (s) => s.get(KEY)); } catch { return false; }
  if (!v || isFresh(v)) return false;
  await clear();
  return true;
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

// The way back to the main page from Chora outside a workflow (Stephen, 12 October 2026, Issue #33
// point 5): the files chosen on the main page, kept when the way to Chora is taken, so that the main
// page chooses them again when it is back (Chora's "Back to PLATO tools", or the browser's Back),
// rather than losing them. Kept only for that round trip, in the hand-off's pattern: under its own key,
// 'main-return', as the File objects themselves, only where working data is kept ("Keep my working
// data", the caller's to ask), tied to the tab by an id in its sessionStorage (which a navigation in
// the same tab keeps, and another tab has not), taken once by the main page when it starts or is shown
// again, and let go by it when older than RETURN_FRESH. Inside a workflow it is not written: the
// workflow keeps its own files (src/methodos/outputs.js), and the main page chooses those again.
const RETURN = 'main-return', TAB_KEY = 'plato-tools.chora-return';
/** Twelve hours: a day's work in Chora, not more; a round trip never taken is let go after it. */
export const RETURN_FRESH = 12 * 60 * 60 * 1000;
const TOOL = /^[a-z]{1,32}$/;
const stale = (v, now) => !v || typeof v.at !== 'number' || now - v.at < 0 || now - v.at >= RETURN_FRESH;
/**
 * What was read, if it is a round trip for this tab (`tab`, the id its sessionStorage holds) recent
 * enough to use, as { files, tool }: files that are files (each with a name, a size and a stream), and
 * the tool chosen then (a key of letters, or null; the page checks it is one of its tools). Else null.
 */
export function returnOf(v, tab, now = Date.now()) {
  if (!v || typeof v !== 'object' || typeof tab !== 'string' || !tab || v.tab !== tab || stale(v, now)) return null;
  if (!Array.isArray(v.files) || !v.files.length || !v.files.every((f) => f && typeof f.name === 'string' && typeof f.size === 'number' && typeof f.stream === 'function')) return null;
  return { files: [...v.files], tool: typeof v.tool === 'string' && TOOL.test(v.tool) ? v.tool : null };
}
const tabId = (session, make) => {
  try {
    let id = session.getItem(TAB_KEY);
    if (!id && make) { id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; session.setItem(TAB_KEY, id); }
    return id || null;
  } catch { return null; }
};
const sessionOf = () => { try { return globalThis.sessionStorage; } catch { return null; } };
/** Keep `files` (and the tool chosen, `tool`) for the main page's return. With `keep` false nothing is kept, and one kept before goes. True if kept. */
export async function keepForReturn(files, { tool = null, keep = true, session = sessionOf() } = {}) {
  if (!keep || !files?.length) { try { await tx('readwrite', (s) => s.delete(RETURN)); } catch { /* none */ } return false; }
  const tab = session && tabId(session, true);
  if (!tab) return false;
  try { await tx('readwrite', (s) => s.put({ tab, files: [...files], tool, at: Date.now() }, RETURN)); return true; } catch { return false; }
}
/** The names of the files kept for this tab's return (Chora says so on its way back), without taking them; or null. */
export async function returnKept({ session = sessionOf(), now = Date.now() } = {}) {
  let v;
  try { v = await tx('readonly', (s) => s.get(RETURN)); } catch { return null; }
  const r = returnOf(v, session && tabId(session, false), now);
  return r ? r.files.map((f) => f.name) : null;
}
/**
 * For the main page: the round trip kept for this tab, { files, tool }, or null; taken, so that it is
 * used once. Read, judged and deleted in one transaction: this tab's goes, used or not; another tab's is
 * left for it, unless it is stale, when it goes too.
 */
export async function takeReturn({ session = sessionOf(), now = Date.now() } = {}) {
  const tab = session && tabId(session, false);
  let got = null;
  try {
    await tx('readwrite', (s) => {
      const r = s.get(RETURN);
      r.onsuccess = () => {
        const v = r.result;
        if (v === undefined) return;
        got = returnOf(v, tab, now);
        if (got || v?.tab === tab || stale(v, now)) s.delete(RETURN);
      };
      return r;
    });
  } catch { return null; }
  return got;
}
