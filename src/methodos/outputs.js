// Methodos: the files a workflow's steps made, kept for the steps after them (Stephen, 4 October 2026,
// overriding decision 3 for these files only). A step's output (a dataset, a work file, a matching of
// columns) is kept as working data in this browser's private file storage (OPFS), in a folder of its
// own, 'methodos-outputs', each file under its SHA-256, so that after a reload the next step takes it
// without its being chosen again. The workflow's record still holds only references (name, size,
// SHA-256); the user's own files are never copied here.
//
// "Keep working data" (keepWorkingData() in src/lib/permissions.js) applies: with it off, the files
// last for the tab only (in memory), and turning it off clears the folder at once (forget()), after
// the files the tab still needs are taken into memory. A browser that refuses the storage (a private
// window, say) keeps them for the tab.
import { keepWorkingData } from '../lib/permissions.js';

export const DIR = 'methodos-outputs';
const HEX64 = /^[0-9a-f]{64}$/;

/** The kept outputs. `root()` (OPFS's root directory) and `keep` can be replaced, for the tests. */
export function outputStore({ root = () => navigator.storage.getDirectory(), keep = keepWorkingData } = {}) {
  const tab = new Map();   // SHA-256 -> File, for the tab: a copy in memory, or the kept file
  const own = new Set();   // the SHA-256 of the user's own files held (never copied)
  const keeping = () => { try { return keep() !== false; } catch { return true; } };
  const dir = async (create) => (await root()).getDirectoryHandle(DIR, { create });
  const named = (f, ref) => new File([f], ref.name, { type: f.type });   // the kept file under its own name (no copy: a Blob of it)
  const remove = async () => { try { await (await root()).removeEntry(DIR, { recursive: true }); } catch { /* none kept */ } };

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
          tab.set(ref.sha256, kept);
          return { file: kept, kept: 'browser' };
        } catch { /* the tab's, then */ }
      } else await remove();
      const copy = new File([await file.arrayBuffer()], ref.name, { type: file.type });
      tab.set(ref.sha256, copy);
      return { file: copy, kept: 'tab' };
    },
    /** Hold `file` for the tab only, as it is (the user's own file: never copied, never kept). */
    hold(ref, file) { tab.set(ref.sha256, file); own.add(ref.sha256); },
    /** The file held for `ref` in this tab, or undefined. */
    held: (ref) => tab.get(ref.sha256),
    /** The file kept for `ref`, from the tab or from OPFS (after a reload), or null; one of another size is not it. */
    async get(ref) {
      if (tab.has(ref.sha256)) return tab.get(ref.sha256);
      if (!keeping() || !HEX64.test(ref.sha256)) return null;
      try {
        const f = await (await (await dir(false)).getFileHandle(ref.sha256)).getFile();
        if (f.size !== ref.size) return null;
        const kept = named(f, ref);
        tab.set(ref.sha256, kept);
        return kept;
      } catch { return null; }
    },
    /** What is kept in OPFS: { count, bytes }. */
    async kept() {
      let count = 0, bytes = 0;
      if (!keeping()) return { count, bytes };
      try { for await (const [name, h] of (await dir(false)).entries()) if (h.kind === 'file' && HEX64.test(name)) { count++; bytes += (await h.getFile()).size; } } catch { /* none */ }
      return { count, bytes };
    },
    /** Let the kept files named by `refs` go (a workflow left), from OPFS and the tab. */
    async drop(refs) {
      for (const r of refs) {
        tab.delete(r.sha256); own.delete(r.sha256);
        try { await (await dir(false)).removeEntry(r.sha256); } catch { /* not kept */ }
      }
    },
    /** Let every kept file go, from OPFS and the tab (the user's "Clear them"). */
    async clear() { for (const sha of [...tab.keys()]) if (!own.has(sha)) tab.delete(sha); await remove(); },
    /** Working data turned off: what the tab holds is taken into memory, and OPFS's folder is let go at once. */
    async forget() {
      for (const [sha, f] of tab) { if (own.has(sha)) continue; try { tab.set(sha, new File([await f.arrayBuffer()], f.name, { type: f.type })); } catch { tab.delete(sha); } }
      await remove();
    },
  };
}
