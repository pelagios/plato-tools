// The file chosen on the main page, kept in this browser for as long as the user wants it (Stephen,
// 12 October 2026: "Users would find it useful to have their data kept indefinitely"). While "Keep my
// working data" is on, the latest file (or files) the user chose in "Choose your data", dropped,
// picked, pasted or saved in Chora, outside a workflow (a workflow keeps its own copy, and hands it here when it is let
// go: one copy at a time), is copied into this browser's private file storage (OPFS). Each choice is
// written into a folder of its own, 'kept-file-<stamp>': the files as '0', '1', … and, written last so
// that a half-written copy is never taken for one, 'about.json' ({ kept: 1, chosen, files: [{ name,
// size, type }] }); only once it is whole are the folders of earlier choices removed, so that the last
// choice stays kept while the next is being written (a reload meanwhile loses neither), and
// any folder left over (a removal that failed, a write never finished) is swept when the store is read.
// It stays until the user forgets it ("Forget it", under "Choose your data" or in the Permissions
// panel), clears the workflow's files ("Clear them"), turns the setting off, or
// chooses another file, which replaces it. Nothing leaves the computer; what OPFS holds can be read by
// any page of the site's origin on this computer (DEVELOPERS.md, "The shared origin"), so what is read
// back is checked (aboutOf) and only offered, never acted on otherwise.
//
// Every write and removal, from any store in the page, goes through one queue, so that a "Forget it" or
// the setting turned off is never overtaken by a keep still in flight; and a keep looks at the setting
// again (`keep()`) once its files are written, before it makes them the kept file. Other tabs are told
// of a change through localStorage ('plato-tools.kept-file', a time stamp: nothing else), so that their
// line under "Choose your data" is redrawn.
import { fmtBytes } from '../engine/words.js';

export const PREFIX = 'kept-file-', ABOUT = 'about.json', PING = 'plato-tools.kept-file';
// A name the page can show as it is: no path, no control or invisible characters, at most 255.
const NAME = /^[^/\\\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]{1,255}$/;
const nameOk = (n) => typeof n === 'string' && NAME.test(n) && /\S/.test(n) && n !== '.' && n !== '..';
// A media type of the plain shape type/subtype, at most 100 characters, or none.
const TYPE = /^[\w.+-]+\/[\w.+-]+$/;
const typeOk = (t) => t === undefined || t === '' || (typeof t === 'string' && t.length <= 100 && TYPE.test(t));
const FOLDER = /^kept-file-[0-9a-z]{1,16}-[0-9a-z]{1,16}$/;

const listeners = new Set();
let pinged = false;
/** Be told when the kept file changes (kept, replaced or forgotten), in this page or another tab. Returns the way to stop. */
export function onChange(fn) {
  listeners.add(fn);
  if (!pinged && typeof window !== 'undefined') {
    pinged = true;
    window.addEventListener('storage', (e) => { if (e.key === PING) tell(); });
  }
  return () => listeners.delete(fn);
}
const tell = () => { for (const fn of listeners) { try { fn(); } catch { /* a listener's own */ } } };
const changed = () => {
  tell();
  try { globalThis.localStorage?.setItem(PING, String(Date.now())); } catch { /* refused: other tabs see it when they next look */ }
};

// One queue for every write and removal in the page (a failure does not stop the ones after it).
let queue = Promise.resolve();
const serial = (fn) => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };

/** What `about.json` says, checked: { chosen, files: [{ name, size, type }] }, or null if it is not one. */
export function aboutOf(v) {
  if (!v || typeof v !== 'object' || v.kept !== 1 || typeof v.chosen !== 'string' || Number.isNaN(Date.parse(v.chosen))) return null;
  if (!Array.isArray(v.files) || !v.files.length || v.files.length > 100) return null;
  if (!v.files.every((f) => f && nameOk(f.name) && Number.isSafeInteger(f.size) && f.size >= 0 && typeOk(f.type))) return null;
  return { chosen: v.chosen, files: v.files.map((f) => ({ name: f.name, size: f.size, type: f.type || '' })) };
}
/** The line the page shows of it: "parishes.csv (313 bytes), chosen 12 Oct". */
export function keptLine(about) {
  const what = about.files.map((f) => `${f.name} (${fmtBytes(f.size)})`).join(', ');
  return `${what}, chosen ${new Date(about.chosen).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}
/** Whether two accounts of the kept file are of the same choice (the same files, chosen at the same time). */
export const sameAbout = (a, b) => !!a && !!b && a.chosen === b.chosen && a.files.length === b.files.length
  && a.files.every((f, i) => f.name === b.files[i].name && f.size === b.files[i].size);

/**
 * The kept file's store. `root()` (OPFS's root directory), `estimate()` (the browser's account of its
 * storage) and `keep()` (whether working data is kept; asked again before a copy is made the kept one)
 * can be replaced, for the tests.
 */
export function keptFileStore({ root = () => navigator.storage.getDirectory(), estimate = () => navigator.storage.estimate(), keep = () => true } = {}) {
  const keeping = () => { try { return keep() !== false; } catch { return true; } };
  const folders = async () => {
    const out = [];
    try { for await (const [name, h] of (await root()).entries()) if (h.kind === 'directory' && name.startsWith(PREFIX)) out.push(name); } catch { /* none */ }
    return out;
  };
  const removeFolder = async (name) => { try { await (await root()).removeEntry(name, { recursive: true }); } catch { /* gone, or left: swept on the next read */ } };
  // The folder of the kept choice, whole and checked, newest first; any other is let go.
  const current = async () => {
    const found = [];
    for (const name of await folders()) {
      let a = null, finished = true;   // finished: its about.json is there (whether or not it is right)
      try {
        const d = await (await root()).getDirectoryHandle(name);
        let text = null;
        try { text = await (await (await d.getFileHandle(ABOUT)).getFile()).text(); } catch { finished = false; }
        a = FOLDER.test(name) && text !== null ? aboutOf(JSON.parse(text)) : null;
        if (a) for (const [i, f] of a.files.entries()) if ((await (await d.getFileHandle(String(i))).getFile()).size !== f.size) a = null;
      } catch { a = null; }
      found.push({ name, about: a, finished });
    }
    const whole = found.filter((x) => x.about).sort((x, y) => (x.name < y.name ? 1 : -1));
    // Let go: older whole choices, damaged ones, and folders never finished once they are older than a
    // write could be still under way in another tab (ten minutes), so that one being written is not taken
    // from under it.
    const young = (n) => { const t = parseInt(n.slice(PREFIX.length).split('-')[0], 36); return Number.isFinite(t) && Date.now() - t < 10 * 60 * 1000; };
    return { kept: whole[0] || null, others: found.filter((x) => x !== whole[0] && (x.finished || !FOLDER.test(x.name) || !young(x.name))) };
  };
  const ours = new WeakSet();   // the Files this store gave the page: choosing them again keeps nothing anew
  let made = 0;
  const store = {
    /**
     * Keep `files` (the user's latest choice) in place of what was kept: 'kept', or 'same' (they are the
     * kept files themselves), 'short' (the browser says it has not room enough, with a margin), 'failed'
     * (it would not keep them), or 'off' (working data was no longer kept by the time they were
     * written). Only 'kept' and 'same' leave a kept file; the others leave none, the old choice included
     * (it is not the latest).
     */
    keep(files, now = new Date()) {
      files = [...files];
      return serial(async () => {
        if (!files.length) return 'failed';
        if (files.every((f) => ours.has(f))) return 'same';
        const old = await folders();
        const dropOld = async () => { for (const n of old) await removeFolder(n); changed(); };
        if (!keeping()) { await dropOld(); return 'off'; }
        if (!files.every((f) => nameOk(f.name))) { await dropOld(); return 'failed'; }
        const bytes = files.reduce((n, f) => n + f.size, 0);
        let e = null;
        try { e = await estimate(); } catch { /* not said: tried */ }
        if (e && typeof e.quota === 'number' && e.quota - (e.usage || 0) < bytes * 1.1 + 1e6) { await dropOld(); return 'short'; }
        // A name that sorts after every earlier one: the time it is written, and a count for two in the same millisecond.
        const name = `${PREFIX}${Date.now().toString(36).padStart(9, '0')}-${(++made).toString(36).padStart(4, '0')}`;
        try {
          const d = await (await root()).getDirectoryHandle(name, { create: true });
          for (const [i, f] of files.entries()) {
            const h = await d.getFileHandle(String(i), { create: true });
            await f.stream().pipeTo(await h.createWritable());   // closes the stream
            if ((await h.getFile()).size !== f.size) throw new Error('not kept whole');
          }
          // The setting turned off while the files were written: nothing is kept.
          if (!keeping()) { await removeFolder(name); await dropOld(); return 'off'; }
          const about = { kept: 1, chosen: now.toISOString(), files: files.map((f) => ({ name: f.name, size: f.size, type: typeOk(f.type) ? f.type || '' : '' })) };
          await new Blob([JSON.stringify(about)]).stream().pipeTo(await (await d.getFileHandle(ABOUT, { create: true })).createWritable());
          await dropOld();   // only now: the new choice is whole
          return 'kept';
        } catch { await removeFolder(name); await dropOld(); return 'failed'; }
      });
    },
    /** What is kept, checked against the files there: { chosen, files: [{ name, size, type }] }, or null. Folders that are not it (left over, damaged, older) are let go. */
    async about() {
      const { kept, others } = await current();
      if (!others.length) return kept ? kept.about : null;
      // Swept in the queue, judged again there (a keep in flight may have finished meanwhile).
      return serial(async () => { const again = await current(); for (const o of again.others) await removeFolder(o.name); return again.kept ? again.kept.about : null; });
    },
    /** The kept files, as Files under their own names (read from OPFS, not copied into memory), with what is kept; or null. */
    async files() {
      const { kept } = await current();
      if (!kept) return null;
      try {
        const d = await (await root()).getDirectoryHandle(kept.name), out = [];
        for (const [i, f] of kept.about.files.entries()) {
          const file = new File([await (await d.getFileHandle(String(i))).getFile()], f.name, { type: f.type });
          ours.add(file); out.push(file);
        }
        out.about = kept.about;
        return out;
      } catch { return null; }
    },
    /** Whether `file` is one this store gave the page. */
    isKept: (file) => ours.has(file),
    /** Let it go (the user's "Forget it", "Clear them", or working data turned off), after any keep in flight. */
    forget() { return serial(async () => { for (const n of await folders()) await removeFolder(n); changed(); }); },
  };
  return store;
}
