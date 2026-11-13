// Whether this browser has what the engine's worker writes through: a synchronous access handle on a file of
// the origin private file system (FileSystemFileHandle.createSyncAccessHandle(), which exists in workers
// only). The engine's working databases (sqlite-wasm's opfs-sahpool) and every output (output-file.js) need
// it. WebKitGTK browsers (GNOME Web) have the page-side storage and not this: "Backend does not support this
// operation", met until November 2026 only at the first Check or Convert, in those words.
// A worker of its own, a few lines long, so that the page can ask as it loads without fetching the engine
// (1.8 MB). It makes one empty file under a name no other tab uses, opens it so, closes and removes it, and
// answers { ok: true } or { ok: false, name, message } with the browser's own error.
onmessage = async () => {
  try {
    const root = await navigator.storage.getDirectory();
    const name = `.plato-tools-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const file = await root.getFileHandle(name, { create: true });
    try { (await file.createSyncAccessHandle()).close(); }
    finally { try { await root.removeEntry(name); } catch { /* none made */ } }
    postMessage({ ok: true });
  } catch (e) {
    postMessage({ ok: false, name: String(e?.name || ''), message: String(e?.message || e) });
  }
};
