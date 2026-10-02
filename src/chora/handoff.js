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
async function tx(mode, fn) {
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
