// Methodos: the files a workflow's steps made, kept for the steps after them (Stephen, 4 October 2026,
// overriding decision 3 for these files only). A step's output (a dataset, a work file, a matching of
// columns) is kept as working data in this browser's private file storage (OPFS), in a folder of its
// own, 'methodos-outputs', each file under its SHA-256, so that after a reload the next step takes it
// without its being chosen again. The workflow's record still holds only references (name, size,
// SHA-256). The user's own file, the one the workflow began with, is kept here too, for the workflow's
// lifetime (Stephen, 12 October 2026, Issue #33 point 5): so that the main page, back from Chora or
// after a reload, chooses it again in any browser, not only where Chromium gives a file handle. It is
// let go with the workflow (Leave), or with "Clear them".
//
// "Keep working data" (keepWorkingData() in src/lib/permissions.js) applies: with it off, the files
// last for the tab only (in memory), and turning it off clears the folder at once (forget()), after
// the files the tab still needs are taken into memory. A browser that refuses the storage (a private
// window, say) keeps them for the tab.
import { keepWorkingData } from '../lib/permissions.js';

export const DIR = 'methodos-outputs';
const HEX64 = /^[0-9a-f]{64}$/;

/** The kept outputs. `root()` (OPFS's root directory) and `keep` can be replaced, for the tests. */
export function outputStore({ root = () => navigator.storage.getDirectory(), keep = keepWorkingData, estimate = () => navigator.storage.estimate() } = {}) {
  const tab = new Map();   // SHA-256 -> File, for the tab: a copy in memory, or the kept file
  const own = new Set();   // the SHA-256 of the user's own files held (copied into OPFS only by keepOwn, where working data is kept)
  const backed = new Set();   // the SHA-256 of the files held whose bytes are in OPFS (gone when the folder is)
  const keeping = () => { try { return keep() !== false; } catch { return true; } };
  const dir = async (create) => (await root()).getDirectoryHandle(DIR, { create });
  const named = (f, ref) => new File([f], ref.name, { type: f.type });   // the kept file under its own name (no copy: a Blob of it)
  const remove = async () => { try { await (await root()).removeEntry(DIR, { recursive: true }); } catch { /* none kept */ } };

  // What the tab holds from OPFS, copied into memory before the folder goes: the steps' files. The
  // user's own file is never read into memory whole (it may be of any size): held as they chose it, it
  // needs nothing; read from OPFS (after a reload), it is no longer held, and is chosen again by hand.
  const inMemory = async () => {
    for (const sha of [...backed]) {
      backed.delete(sha);
      if (own.has(sha)) { tab.delete(sha); continue; }
      const f = tab.get(sha);
      try { tab.set(sha, new File([await f.arrayBuffer()], f.name, { type: f.type })); } catch { tab.delete(sha); }
    }
  };

  // With working data not kept, nothing stays in OPFS: a folder from an earlier visit (or a toggle in
  // Chora's panel) goes the first time the store is asked.
  let swept = false;
  const sweep = async () => { if (!keeping() && !swept) { swept = true; await remove(); } else if (keeping()) swept = false; };

  return {
    /**
     * Keep `file` (an output, whose bytes the next run may overwrite) under `ref`: in OPFS when working
     * data is kept, else a copy in memory. Returns the File to use from now on, and where it is kept.
     */
    async put(ref, file) {
      if (keeping()) {
        try {
          const h = await (await dir(true)).getFileHandle(ref.sha256, { create: true });
          const w = await h.createWritable();
          await file.stream().pipeTo(w);   // closes the stream
          const kept = named(await h.getFile(), ref);
          if (kept.size !== ref.size) throw new Error('not kept whole');
          tab.set(ref.sha256, kept); backed.add(ref.sha256);
          return { file: kept, kept: 'browser' };
        } catch { /* the tab's, then */ }
      } else await remove();
      const copy = new File([await file.arrayBuffer()], ref.name, { type: file.type });
      tab.set(ref.sha256, copy); backed.delete(ref.sha256);
      return { file: copy, kept: 'tab' };
    },
    /**
     * The user's own file the workflow began with: held for the tab as it is, and, where working data is
     * kept, a copy written to OPFS for the workflow's lifetime, so that a later page can choose it again.
     * 'browser' if it was kept so; 'tab' if working data is not kept; 'short' if the browser said it had
     * not room enough for it (asked first: navigator.storage.estimate), 'failed' if it would not keep it.
     */
    async keepOwn(ref, file) {
      own.add(ref.sha256);
      if (!tab.has(ref.sha256)) { tab.set(ref.sha256, file); backed.delete(ref.sha256); }
      if (!keeping()) { await remove(); return 'tab'; }
      try {
        const d = await dir(true);
        try { if ((await (await d.getFileHandle(ref.sha256)).getFile()).size === ref.size) return 'browser'; } catch { /* not kept yet */ }
        // Room for it, and a margin (a tenth, and a megabyte), as the browser says: not, and nothing is written.
        let e = null;
        try { e = await estimate(); } catch { /* not said: tried */ }
        if (e && typeof e.quota === 'number' && e.quota - (e.usage || 0) < ref.size * 1.1 + 1e6) return 'short';
        const h = await d.getFileHandle(ref.sha256, { create: true });
        await file.stream().pipeTo(await h.createWritable());
        if ((await h.getFile()).size !== ref.size) throw new Error('not kept whole');
        return 'browser';
      } catch { try { await (await dir(false)).removeEntry(ref.sha256); } catch { /* none */ } return 'failed'; }
    },
    /** Whether working data is kept between visits (the Permissions panel's choice), as the store obeys it. */
    keeping,
    /** Hold `file` for the tab only, as it is (a file the user chose, not copied here). */
    hold(ref, file) { if (tab.get(ref.sha256) !== file) backed.delete(ref.sha256); tab.set(ref.sha256, file); own.add(ref.sha256); },
    /** The file held for `ref` in this tab, or undefined. */
    held: (ref) => tab.get(ref.sha256),
    /** The file kept for `ref`, from the tab or from OPFS (after a reload), or null; one of another size is not it. */
    async get(ref) {
      if (tab.has(ref.sha256)) return tab.get(ref.sha256);
      await sweep();
      if (!keeping() || !HEX64.test(ref.sha256)) return null;
      try {
        const f = await (await (await dir(false)).getFileHandle(ref.sha256)).getFile();
        if (f.size !== ref.size) return null;
        const kept = named(f, ref);
        tab.set(ref.sha256, kept); backed.add(ref.sha256);
        return kept;
      } catch { return null; }
    },
    /** What is kept in OPFS: { count, bytes, files }, `files` each { sha256, size }. */
    async kept() {
      let count = 0, bytes = 0;
      const files = [];
      await sweep();
      if (!keeping()) return { count, bytes, files };
      try { for await (const [name, h] of (await dir(false)).entries()) if (h.kind === 'file' && HEX64.test(name)) { const size = (await h.getFile()).size; count++; bytes += size; files.push({ sha256: name, size }); } } catch { /* none */ }
      return { count, bytes, files };
    },
    /** Let the kept files named by `refs` go (a workflow left), from OPFS and the tab. */
    async drop(refs) {
      for (const r of refs) {
        tab.delete(r.sha256); own.delete(r.sha256); backed.delete(r.sha256);
        try { await (await dir(false)).removeEntry(r.sha256); } catch { /* not kept */ }
      }
    },
    /**
     * Let every kept file go, from OPFS and the tab (the user's "Clear them"): the steps' files go from
     * the tab too; the user's own file stays held if it is the one they chose, and is no longer held if
     * it was read from OPFS (never read into memory whole: it is chosen again by hand).
     */
    async clear() {
      for (const sha of [...tab.keys()]) if (!own.has(sha)) { tab.delete(sha); backed.delete(sha); }
      await inMemory(); await remove();
    },
    /** Working data turned off: what the tab holds is taken into memory, and OPFS's folder is let go at once. */
    async forget() { await inMemory(); await remove(); },
  };
}
