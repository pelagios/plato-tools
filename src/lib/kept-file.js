// The file chosen on the main page, kept in this browser for as long as the user wants it (Stephen,
// 12 October 2026: "Users would find it useful to have their data kept indefinitely"). While "Keep my
// working data" is on, the latest file (or files) the user chose in "Choose your data", dropped,
// picked or pasted, inside a workflow or not, is copied into this browser's private file storage
// (OPFS), folder 'kept-file': the files as '0', '1', … and, written last so that a half-written copy
// is never taken for one, 'about.json' ({ kept: 1, chosen, files: [{ name, size, type }] }). It stays
// until the user forgets it ("Forget it", under "Choose your data" or in the Permissions panel),
// clears the workflow's files ("Clear them"), turns the setting off (on either page), or chooses
// another file, which replaces it. Nothing leaves the computer; what OPFS holds can be read by any page
// of the site's origin on this computer (DEVELOPERS.md, "The shared origin"), so what is read back is
// checked (about()) and only offered, or chosen on a return from Chora, never acted on otherwise.
//
// This module asks nothing of the permissions: its callers say whether working data is kept. Pure
// apart from the storage it is given, so that the tests run it on a fake one.
import { fmtBytes } from '../engine/words.js';

export const DIR = 'kept-file', ABOUT = 'about.json';
// A name the page can show as it is: no path, no control or invisible characters, at most 255.
const NAME = /^[^/\\\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]{1,255}$/;
const nameOk = (n) => typeof n === 'string' && NAME.test(n) && /\S/.test(n) && n !== '.' && n !== '..';
const listeners = new Set();
/** Be told when the kept file changes (kept, replaced or forgotten) in this page. Returns the way to stop. */
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const changed = () => { for (const fn of listeners) { try { fn(); } catch { /* a listener's own */ } } };

/** What `about.json` says, checked: { chosen, files: [{ name, size, type }] }, or null if it is not one. */
export function aboutOf(v) {
  if (!v || typeof v !== 'object' || v.kept !== 1 || typeof v.chosen !== 'string' || Number.isNaN(Date.parse(v.chosen))) return null;
  if (!Array.isArray(v.files) || !v.files.length || v.files.length > 100) return null;
  if (!v.files.every((f) => f && nameOk(f.name) && Number.isSafeInteger(f.size) && f.size >= 0 && (f.type === undefined || typeof f.type === 'string'))) return null;
  return { chosen: v.chosen, files: v.files.map((f) => ({ name: f.name, size: f.size, type: f.type || '' })) };
}
/** The line the page shows of it: "parishes.csv (313 bytes), chosen 12 Oct". */
export function keptLine(about) {
  const what = about.files.map((f) => `${f.name} (${fmtBytes(f.size)})`).join(', ');
  return `${what}, chosen ${new Date(about.chosen).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

/**
 * The kept file's store. `root()` (OPFS's root directory) and `estimate()` (the browser's account of
 * its storage) can be replaced, for the tests.
 */
export function keptFileStore({ root = () => navigator.storage.getDirectory(), estimate = () => navigator.storage.estimate() } = {}) {
  const dir = async (create) => (await root()).getDirectoryHandle(DIR, { create });
  const remove = async () => { try { await (await root()).removeEntry(DIR, { recursive: true }); } catch { /* none kept */ } };
  const ours = new WeakSet();   // the Files this store gave the page: choosing them again keeps nothing anew
  const store = {
    /**
     * Keep `files` (the user's latest choice) in place of what was kept: 'kept', or 'same' (they are the
     * kept files themselves), 'short' (the browser says it has not room enough, with a margin: nothing
     * written) or 'failed' (it would not keep them). Either way the old choice is no longer kept.
     */
    async keep(files, now = new Date()) {
      files = [...files];
      if (!files.length) return 'failed';
      if (files.every((f) => ours.has(f))) return 'same';
      await remove();
      if (!files.every((f) => nameOk(f.name))) { changed(); return 'failed'; }
      const bytes = files.reduce((n, f) => n + f.size, 0);
      let e = null;
      try { e = await estimate(); } catch { /* not said: tried */ }
      if (e && typeof e.quota === 'number' && e.quota - (e.usage || 0) < bytes * 1.1 + 1e6) { changed(); return 'short'; }
      try {
        const d = await dir(true);
        for (const [i, f] of files.entries()) {
          const h = await d.getFileHandle(String(i), { create: true });
          await f.stream().pipeTo(await h.createWritable());   // closes the stream
          if ((await h.getFile()).size !== f.size) throw new Error('not kept whole');
        }
        const about = { kept: 1, chosen: now.toISOString(), files: files.map((f) => ({ name: f.name, size: f.size, type: f.type || '' })) };
        await new Blob([JSON.stringify(about)]).stream().pipeTo(await (await d.getFileHandle(ABOUT, { create: true })).createWritable());
        changed();
        return 'kept';
      } catch { await remove(); changed(); return 'failed'; }
    },
    /** What is kept, checked against the files there: { chosen, files: [{ name, size, type }] }, or null (and a damaged copy is let go). */
    async about() {
      let d, v;
      try { d = await dir(false); } catch { return null; }
      try { v = JSON.parse(await (await (await d.getFileHandle(ABOUT)).getFile()).text()); } catch { await remove(); return null; }
      const a = aboutOf(v);
      if (!a) { await remove(); return null; }
      try { for (const [i, f] of a.files.entries()) if ((await (await d.getFileHandle(String(i))).getFile()).size !== f.size) throw new Error('not whole'); } catch { await remove(); return null; }
      return a;
    },
    /** The kept files, as Files under their own names (read from OPFS, not copied into memory), or null. */
    async files() {
      const a = await store.about();
      if (!a) return null;
      try {
        const d = await dir(false), out = [];
        for (const [i, f] of a.files.entries()) {
          const file = new File([await (await d.getFileHandle(String(i))).getFile()], f.name, { type: f.type });
          ours.add(file); out.push(file);
        }
        return out;
      } catch { return null; }
    },
    /** Whether `file` is one this store gave the page. */
    isKept: (file) => ours.has(file),
    /** Let it go (the user's "Forget it", "Clear them", or working data turned off). */
    async forget() { await remove(); changed(); },
  };
  return store;
}
