// Files chosen on the main page, handed to Chora's page: kept in this browser's IndexedDB under one
// key, 'chora-handoff', as the File objects themselves (they can be stored as they are; the browser
// keeps a reference to the file on disk, or a copy, and nothing leaves the computer). The main page
// puts them there when the way to Chora is taken with files chosen; chora.html offers to open them,
// and lets them go once opened, so that no copy lingers.
const DB = 'plato-tools-chora', STORE = 'kv', KEY = 'chora-handoff';

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
/** The files kept for Chora's page, or null. */
export async function take() {
  try { const v = await tx('readonly', (s) => s.get(KEY)); return v?.files?.length ? v.files : null; } catch { return null; }
}
