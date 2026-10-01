// Files chosen on the main page, handed to Chora's page: kept in this browser's IndexedDB under one
// key, 'chora-handoff', as the File objects themselves (they can be stored as they are; the browser
// keeps a reference to the file on disk, or a copy, and nothing leaves the computer). The main page
// puts them there when the way to Chora is taken with files chosen; chora.html takes them at once,
// holding them in the page to offer, so that no copy lingers, and one left longer than a few minutes
// ago (the way taken, and Chora's page closed before it started) is let go without an offer.
const DB = 'plato-tools-chora', STORE = 'kv', KEY = 'chora-handoff', FRESH = 5 * 60 * 1000;

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
  return v?.files?.length && Date.now() - (v.at || 0) < FRESH ? v.files : null;
}

// The same store carries Chora's page across its own reload, when the user allows a site (the
// Content Security Policy is written at load, so a site allowed is reachable only from the next one):
// the files open, the place chosen and where the map was. Kept under its own key, 'chora-resume',
// taken once, and not used if older than a few minutes.
const RESUME = 'chora-resume';
/** Keep `value` ({files, placeId, camera, …}) for the page after the reload. */
export async function keepForReload(value) {
  try { await tx('readwrite', (s) => s.put({ ...value, files: [...(value.files || [])], at: Date.now() }, RESUME)); return true; } catch { return false; }
}
/** What was kept for this load, or null: taken, so that it is used once. */
export async function takeResume() {
  let v;
  try { v = await tx('readonly', (s) => s.get(RESUME)); await tx('readwrite', (s) => s.delete(RESUME)); } catch { return null; }
  return v && Date.now() - (v.at || 0) < FRESH ? v : null;
}
