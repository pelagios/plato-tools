// Chora across the page's own reload, when the user allows a site (the Content Security Policy is
// written at load, so a site allowed is reachable only from the next one): the files open, the place
// chosen, where the map was, and the historical map waiting, kept in this browser's IndexedDB
// (`plato-tools-chora`, `kv`, under 'chora-resume'), taken once, and not used if older than FRESH. The
// files are the File objects themselves (they can be stored as they are; the browser keeps a reference
// to the file on disk, or a copy, and nothing leaves the computer). FRESH is two minutes: the reload is
// seconds, and what is kept here can be read by any page of the site's origin (DEVELOPERS.md, "The
// shared origin"), so nothing lingers.
const DB = 'plato-tools-chora', STORE = 'kv', KEY = 'chora-resume';
// What the page split of before kept in the same store (the files handed to Chora's own page, the dataset
// handed back from it, and a stamp of a round trip): let go when Chora next starts, as nothing reads them now.
const GONE = ['chora-handoff', 'chora-handback', 'chora-handoff-alive'];
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
/** One transaction on the store, its request's result. */
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

/** Keep `value` ({files, placeId, camera, maps}) for the page after the reload. Best effort: true if kept. */
export async function keepForReload(value) {
  try { await tx('readwrite', (s) => s.put({ ...value, files: [...(value.files || [])], at: Date.now() }, KEY)); return true; } catch { return false; }
}
/**
 * What was kept for this load, or null: taken (read and deleted in one transaction), so that it is used
 * once. What the page split of before left in the store goes in the same transaction.
 */
export async function takeResume(now = Date.now()) {
  let v;
  try {
    v = await tx('readwrite', (s) => {
      const r = s.get(KEY);
      r.onsuccess = () => { if (r.result !== undefined) s.delete(KEY); };
      for (const k of GONE) s.delete(k);
      return r;
    });
  } catch { return null; }
  return isFresh(v, now) ? v : null;
}
