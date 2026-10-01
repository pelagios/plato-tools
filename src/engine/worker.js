// The engine in the browser: the pipeline, given SQLite on the origin private file system, output
// files there too, and PLATO's vendored files fetched from the site.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import * as XLSX from 'xlsx';
import { loadResources } from './resources.js';
import { prepare, run, TARGETS } from './pipeline.js';
import { compare } from './compare.js';
import { publish } from './agora/index.js';
import { match, gather } from './krisis/match.js';
import { apply } from './krisis/apply.js';
import { review, choraLoadFailure } from './words.js';
import { DataError } from './input.js';
import { pragmas } from '../lib/store.js';
import { detect, readable } from './input.js';
import { columnsOf, mappingOf } from './hermes/generic.js';
import { FIELDS, cellText } from './hermes/columns.js';
import { teiKeyPrefixes, EDITORIAL_IRI } from './hermes/tei.js';
import { load as choraLoad } from './chora/store.js';
import { save as choraSave } from './chora/save.js';

let resources = null, pool = null, runs = 0, poolName = null;
// A take-up of the main page's pool is under way (unpauseVfs): it is not to be let go meanwhile.
let takingUp = false;
// When this tab's take-up was last refused (letGoNowAndLater), for the wait before trying again.
let refusedAt = -Infinity;
const busyError = (message, kind = 'pool-busy') => Object.assign(new Error(message), { kind });
/**
 * Let go of the main page's pool if it is left half-taken; true if it holds nothing, or is whole.
 *
 * A take-up refused part-way leaves the pool neither paused nor usable: sqlite-wasm asks for every
 * file's access handle at once, gives up at the first refused, and keeps those granted after that,
 * so the pool holds some files (keeping other tabs out) with its VFS unregistered, and does not try
 * again (it is not paused), so that every database opened after says "no such vfs" for the page's
 * life. pauseVfs alone cannot mend that: it unregisters the VFS first, which throws, and lets
 * nothing go. So the VFS is registered again, from where it was installed, and paused, which lets
 * the stray handles go (probed with two tabs of headless Chromium, another holding two of the
 * pool's four files, 1 October 2026). Where that fails, the pool is marked half-taken, and no run
 * is begun on it until a later mend succeeds: a run on some of its files would not be sound.
 */
function letGo() {
  const { capi } = pool.sqlite3, { vfs } = pool;
  const registered = !!capi.sqlite3_vfs_find(vfs.vfsName);
  if (!pool.half && (vfs.isPaused() || registered)) return true;
  try {
    if (!registered) capi.sqlite3_vfs_register(pool.cVfs, 0);
    vfs.pauseVfs();
    pool.half = false;
    return true;
  } catch (e) {
    pool.half = true;
    console.warn('PLATO tools: the working files, half taken up, could not be let go', e);
    return false;
  }
}
/**
 * After a refused take-up, let go of what it was granted, at once and again later: its requests for
 * the other files are still in flight when the refusal comes, and a grant arriving after the first
 * mend would be held until the next run, keeping other tabs out meanwhile. Two tabs refused at once
 * would then each be kept out by the other's strays, every time either tried again. The grants came
 * within 200 ms in the probe; the mends at 0.1, 1 and 5 s cover that with room, and one arriving
 * later still is let go at the next run. None is made while a take-up is under way, which it would
 * cut off.
 */
function letGoNowAndLater() {
  refusedAt = Date.now();
  letGo();
  for (const ms of [100, 1000, 5000]) setTimeout(() => { if (!takingUp) letGo(); }, ms);
}
async function sqlitePool() {
  if (pool) {
    // The main page's pool is let go between runs (tidy, in runEnv), and taken up again here. Another
    // tab of the main page may have taken it meanwhile and be running: that is said as for a pool in
    // use at install, the pool is let go of whatever it was granted, and the next run may try again.
    // No second command reaches the pool while this one awaits: the page sends none while it is busy
    // (src/app.js, start). Chora's pool is never let go (runEnv), so never half taken.
    //
    // A try again soon after a refusal (within the 200 ms its grants take) would ask for files whose
    // old grants are still to come: one could refuse the new request for its own file (a refusal of
    // this tab's own making, gone at the next try), and a grant arriving out of order could be taken
    // for the new take-up's and let go by a mend under it. So a try again waits until 1.2 s after the
    // refusal, past the mends at 0.1 and 1 s; a grant later than that is not ruled out, but was not seen.
    if (!poolName) {
      const wait = refusedAt + 1200 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      // This tab's own mend failed: no other tab is to blame, and only a reload frees the files.
      if (!letGo()) throw busyError('The working files are half taken up and could not be let go.', 'pool-stuck');
    }
    if (pool.vfs.isPaused()) {
      takingUp = true;
      try { await pool.vfs.unpauseVfs(); }
      catch (e) {
        takingUp = false;
        if (!poolName) letGoNowAndLater();
        throw poolBusy(e) ? busyError(e.message) : e;
      } finally { takingUp = false; }
    }
    return pool;
  }
  const sqlite3 = await sqlite3InitModule();
  // A pool is one tab's alone: it holds every file in its directory open, so a second tab using the
  // same one cannot start. A page that may be open beside the main page (Chora's) asks for a pool of
  // its own at init; the main page's is the default, as it always was.
  const own = poolName ? { name: `opfs-sahpool-${poolName}` } : {};
  let vfs;
  try { vfs = await sqlite3.installOpfsSAHPoolVfs({ clearOnInit: true, initialCapacity: 8, forceReinitIfPreviouslyFailed: true, ...own }); }
  catch (e) { throw poolBusy(e) ? busyError(e.message) : e; }
  // Where the VFS lives, kept for registering it again (letGo): sqlite-wasm keeps its own to itself.
  pool = { sqlite3, vfs, cVfs: sqlite3.capi.sqlite3_vfs_find(vfs.vfsName) };
  return pool;
}
// The browser's refusal of a file another tab holds open (createSyncAccessHandle, when an access
// handle to the same file is open elsewhere): the pool is in use in another tab of this browser.
const poolBusy = (e) => !!e && e.name === 'NoModificationAllowedError';
async function outputsDir(clear, name = 'outputs') {
  const root = await navigator.storage.getDirectory();
  if (clear) { try { await root.removeEntry(name, { recursive: true }); } catch {} }
  return root.getDirectoryHandle(name, { create: true });
}
async function output(dir, name) {
  const h = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  h.truncate(0);
  const enc = new TextEncoder();
  let at = 0;
  return {
    write(s) { at += h.write(enc.encode(s), { at }); },
    writeBytes(b) { at += h.write(b, { at }); },
    async close() { h.flush(); h.close(); return { name, size: at }; },
  };
}

/**
 * What one run is given: its working databases, its outputs, and where progress goes. A run may
 * open several databases, one after another (the version check reads two inputs, and keeps a ledger
 * of its own): each has its own file, and a finished one is removed before the next is opened, so
 * that they do not pile up on disk. tidy() closes and removes what is left, however the run ended.
 */
async function runEnv({ clearOutputs = true, outputs = 'outputs' } = {}) {
  const dir = await outputsDir(clearOutputs, outputs);
  const { vfs } = await sqlitePool();
  const opened = [];
  const unlinkClosed = () => { for (const d of opened) if (!d.gone && !d.db.isOpen()) { try { vfs.unlink(d.name); } catch {} d.gone = true; } };
  const env = {
    resources, csvMeta: resources.csvMeta, xlsx: XLSX,
    openDb: async () => {
      unlinkClosed();
      const name = `/run-${++runs}.sqlite3`;
      const db = new vfs.OpfsSAHPoolDb(name);
      db.exec(pragmas());
      opened.push({ name, db });
      return db;
    },
    output: (name) => output(dir, name),
    progress: (p) => postMessage({ type: 'progress', ...p }),
  };
  // Between runs the pool's files are let go (pauseVfs closes their access handles). A removed
  // database is cut to its header at once, on disk, but the browser counts the space a file's
  // access handle took against the page's quota until the handle is closed: with the handles held,
  // after a check of 200,000 places the page's usage stayed at 142 MB with the files empty on disk,
  // and the conversion that followed peaked at 675 MB; let go, usage fell to 0 after the check and
  // the conversion peaked at 401 MB (1 October 2026). At a million places the check's 0.8 GB was
  // still counted when the conversion ended, at 3.6 GB.
  // Only the main page's pool is let go. A pool of its own (Chora's) is held for the page's life: its
  // holding is what tells a second Chora tab that it cannot start, and Chora's session database is
  // opened from it outside any run. pauseVfs throws, changing nothing, while any database in the pool
  // is open, so a database still open is never cut off; the pool is let go at a later run's end.
  const tidy = () => {
    for (const d of opened) if (!d.gone) { try { d.db.close(); } catch {} }
    unlinkClosed();
    if (!poolName) { try { vfs.pauseVfs(); } catch { /* a database still open */ } }
  };
  return { env, tidy };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.cmd === 'init') {
      const base = data.base + 'plato/';
      session.base = data.base;   // Chora's country boxes are fetched from the site too
      if (/^[a-z]+$/.test(data.pool || '')) poolName = data.pool;
      resources = prepare(await loadResources(async (f) => { const r = await fetch(base + f); if (!r.ok) throw new Error(`${f}: ${r.status}`); return r.text(); }));
      // A page with a pool of its own (Chora's) takes it now, so that a second tab of that page is
      // told at once that it cannot start, not when a file is first opened.
      if (poolName) await sqlitePool();
      // Whether the TEI reading options for the editors' words may be offered (while EDITORIAL_IRI is set, as it is).
      postMessage({ type: 'ready', version: resources.version, reading: { editorial: EDITORIAL_IRI !== null } });
    } else if (data.cmd === 'detect') {
      const input = await detect(data.files);
      // File objects stay here; the page is told what was found, and the run detects the files again.
      // A Recogito export chosen with georeferences and manifests (input.js, detectGroup) keeps their
      // names, for the page to say what it will use.
      const names = (list) => (list ? list.map((f) => f.name) : undefined);
      postMessage({ type: 'detected', input: { ...input, files: undefined, georefs: names(input.georefs), manifests: names(input.manifests) }, targets: TARGETS });
    } else if (data.cmd === 'columns') {
      // Hermes: a table of places' columns, three examples of each, and the mapping a run would use
      // (the guess, or `saved`, a matching the page loaded, checked against the columns there are).
      // What stops the file being read is said here, for the page to show beside the table; the run
      // reports it again, in full.
      try {
        const input = await detect(data.files);
        const { headers, sample } = await columnsOf(input);
        const examples = Object.fromEntries(headers.map((h) => [h, sample.map((r) => cellText(r?.[h])).filter(Boolean).slice(0, 3)]));
        const { mapping, patterns, suggested, reasons, problems, gazetteer } = await mappingOf(input, data.saved);
        const fields = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, { single: f.single }]));
        postMessage({ type: 'columns', id: data.id, headers, examples, mapping, patterns, suggested, reasons, problems, gazetteer, fields, saved: data.saved !== undefined });
      } catch (e) {
        postMessage({ type: 'columns', id: data.id, error: String(e && e.message || e) });
      }
    } else if (data.cmd === 'tei-keys') {
      // Hermes: the prefixes of a TEI file's keys on place names with no ref, each with a pattern to
      // suggest (tei.js, teiKeyPrefixes), for the page to offer before the run. `id` is the page's,
      // shared with 'columns', so that an answer about a file no longer chosen is set aside.
      try {
        const input = await detect(data.files);
        postMessage({ type: 'tei-keys', id: data.id, prefixes: await teiKeyPrefixes(input) });
      } catch (e) {
        postMessage({ type: 'tei-keys', id: data.id, error: String(e && e.message || e) });
      }
    } else if (data.cmd === 'run') {
      const input = await detect(data.files);
      if (!readable(input)) throw new Error(input.reason);
      const { env, tidy } = await runEnv();
      let result;
      try { result = await run({ input, action: data.action, target: data.target, options: data.options || {} }, env); } finally { tidy(); }
      // Stopped part-way: what it had begun writing (closed by run()) is not kept.
      if (result.incomplete) await outputsDir(true);
      postMessage({ type: 'done', ...result });
    } else if (data.cmd === 'compare') {
      // The version check: two inputs, the earlier version and the later one (src/engine/compare.js).
      const earlier = await detect(data.earlier), later = await detect(data.later);
      // A file that is not recognised is a finding about the file, reported as one, not a failure of the tools.
      const unknown = [['earlier', earlier], ['later', later]].find(([, input]) => !readable(input));
      if (unknown) {
        postMessage({ type: 'done', incomplete: true, outputs: [], report: { counts: {}, errors: 1, items: [{ severity: 'error', kind: 'not-recognised', count: 1,
          message: `The ${unknown[0]} version was not recognised as data these tools read, so the two versions were not compared`, examples: [unknown[1].reason] }] } });
        return;
      }
      const { env, tidy } = await runEnv();
      let result;
      try { result = await compare({ earlier, later, options: data.options || {} }, env); } finally { tidy(); }
      postMessage({ type: 'done', ...result });
    } else if (data.cmd === 'publish') {
      // Agora (src/engine/agora/): one part of publishing, for the dataset chosen, with the previous
      // release when one is given.
      const input = await detect(data.files);
      const previous = data.previous?.length ? await detect(data.previous) : undefined;
      // Not recognised, or recognised and refused with its reason (a IIIF Georeference Annotation): readable(), as for every other command.
      const unknown = [['dataset', input], ['previous release', previous]].find(([, i]) => i && !readable(i));
      if (unknown) {
        postMessage({ type: 'done', incomplete: true, outputs: [], report: { counts: {}, errors: 1, items: [{ severity: 'error', kind: 'not-recognised', count: 1,
          message: `The ${unknown[0]} was not recognised as data these tools read, so nothing was done`, examples: [unknown[1].reason] }] } });
        return;
      }
      const { env, tidy } = await runEnv();
      let result;
      try { result = await publish({ part: data.part, input, previous, options: data.options || {} }, env); } finally { tidy(); }
      postMessage({ type: 'done', ...result });
    } else if (data.cmd === 'match' || data.cmd === 'apply') {
      // Match review (Krisis, src/engine/krisis/): 'match' finds candidates for the subjects' places in
      // the others, and returns the work file; 'apply' turns the decisions in it into attestations.
      const subjects = await detect(data.subjects), others = data.cmd === 'match' ? await detect(data.others) : null;
      // Not recognised, or recognised and refused with its reason (a IIIF Georeference Annotation): readable(), as for every other command.
      const unknown = [['subjects', subjects], ['others', others]].find(([, input]) => input && !readable(input));
      if (unknown) {
        postMessage({ type: 'done', incomplete: true, outputs: [], report: { counts: {}, errors: 1, items: [{ severity: 'error', kind: 'not-recognised', count: 1,
          message: review.notRecognised(unknown[0]), examples: [unknown[1].reason] }] } });
        return;
      }
      const { env, tidy } = await runEnv();
      let result;
      try {
        result = data.cmd === 'match'
          ? await match({ subjects, others, options: data.options || {} }, env)
          : await apply({ subjects, work: data.work, options: data.options || {} }, env);
      } catch (e) {
        // A mistake in what was asked (an option out of range) is said plainly, as a finding, not as a fault in the tools.
        if (!(e instanceof DataError)) throw e;
        result = { incomplete: true, outputs: [], report: { counts: {}, errors: 1, items: [{ severity: 'error', kind: 'not-possible', count: 1, message: e.message, examples: [] }] } };
      } finally { tidy(); }
      postMessage({ type: 'done', ...result });
    } else if (typeof data.cmd === 'string' && data.cmd.startsWith('chora-')) {
      await choraCommand(data);
    } else if (data.cmd === 'places') {
      // Krisis: gazetteer lookup. The places of the dataset, with the links it states, for a lookup the
      // page runs on its own thread (src/engine/krisis/lookup.js), so that the token never comes here.
      const subjects = await detect(data.subjects);
      // Not recognised, or recognised and refused with its reason (a IIIF Georeference Annotation): readable(), as for every other command.
      if (!readable(subjects)) { postMessage({ type: 'places', subjects: null, places: null, reason: subjects.reason }); return; }
      const { env, tidy } = await runEnv();
      let result;
      try { result = await gather({ subjects, options: data.options || {} }, env); } finally { tidy(); }
      postMessage({ type: 'places', subjects: result.subjects, places: result.incomplete ? null : result.places, report: result.report });
    }
  } catch (e) {
    postMessage({ type: 'error', message: String(e && e.message || e), stack: String(e && e.stack || ''), ...(e && e.kind ? { kind: e.kind } : {}) });
  }
};

// ---- Chora (chora.html): the map viewer and editor --------------------------------------------------
// Chora keeps one working database for the session, /chora.sqlite3 in the same pool as the runs'
// (src/engine/chora/store.js), holding the dataset last opened; a run's own databases come and go
// beside it. Saving goes through runEnv like any conversion, but its file is in chora-outputs/, not
// outputs/: each page clears its own outputs when it runs, and the main page may be open beside this
// one with a file not yet saved.
const CHORA_DB = '/chora.sqlite3', CHORA_OUT = 'chora-outputs';
const session = { store: null, fingerprint: null, ccodes: null, base: null };
const fingerprint = (files) => files.map((f) => `${f.name}|${f.size}|${f.lastModified}`).join('\n');
// What a set of CSV files is called, having no one file name of its own.
const inputName = (input, name) => name || (input.container === 'csv' ? 'tables' : input.files[0].name);
/** Each country's box (public/basemap/ccodes.json), fetched once; none if it cannot be had. */
async function ccodeBoxes() {
  if (session.ccodes) return session.ccodes;
  try { const r = await fetch((session.base || './') + 'basemap/ccodes.json'); session.ccodes = r.ok ? await r.json() : {}; } catch { session.ccodes = {}; }
  return session.ccodes;
}
async function choraCommand(data) {
  if (data.cmd === 'chora-load') {
    session.base = data.base || session.base;
    const input = await detect(data.files);
    // Refused in the readers' words, but a georeference: on Chora it goes under Historical maps (words.js).
    if (!readable(input)) { postMessage({ type: 'chora-loaded', failure: choraLoadFailure(input) }); return; }
    const { vfs } = await sqlitePool();
    if (session.store) { session.store.close(); session.store = null; session.fingerprint = null; }
    try { vfs.unlink(CHORA_DB); } catch { /* none yet */ }
    const db = new vfs.OpfsSAHPoolDb(CHORA_DB);
    db.exec(pragmas());
    // Opening a dataset leaves the last saved file where it is.
    // The session database is open from here: if the run cannot begin (its outputs folder refused),
    // it is closed, not left holding its file until the page is reloaded.
    let env, tidy;
    try { ({ env, tidy } = await runEnv({ clearOutputs: false, outputs: CHORA_OUT })); }
    catch (e) { try { db.close(); } catch {} throw e; }
    let store;
    try { store = await choraLoad(input, env, db, { name: inputName(input, data.name) }); }
    catch (e) { try { db.close(); } catch {} throw e; }
    finally { tidy(); }
    session.store = store; session.fingerprint = fingerprint(data.files);
    postMessage({ type: 'chora-loaded', ...store.loaded });
    return;
  }
  if (data.cmd === 'chora-save') {
    const input = await detect(data.files);
    if (!readable(input)) throw new Error(input.reason);
    const same = session.store && session.fingerprint === fingerprint(data.files);
    const { env, tidy } = await runEnv({ outputs: CHORA_OUT });
    let result;
    try {
      result = await choraSave(input, data.additions || [], env, {
        name: inputName(input, data.name), contributor: data.contributor || undefined,
        hasPlace: same ? (id) => session.store.has(id) : undefined, record: same ? (id) => session.store.record(id) : undefined,
        reopen: async (o) => (await (await outputsDir(false, CHORA_OUT)).getFileHandle(o.name)).getFile(),
      });
    } finally { tidy(); }
    postMessage({ type: 'done', ...result });
    return;
  }
  if (!session.store) throw new Error('Open a dataset first.');
  if (data.cmd === 'chora-search') {
    postMessage({ type: 'chora-results', ...session.store.search(data.q || '', { after: data.after || 0, limit: data.limit ?? 50 }) });
  } else if (data.cmd === 'chora-overview') {
    postMessage({ type: 'chora-overview', geojson: session.store.overview() });
  } else if (data.cmd === 'chora-place') {
    const boxes = data.ccodes || await ccodeBoxes();
    postMessage({ type: 'chora-place', id: data.id, view: session.store.getPlace(data.id, { ccodeBbox: (c) => (Array.isArray(boxes[c]) ? boxes[c] : null) }) });
  } else throw new Error(`Unknown command: ${data.cmd}`);
}
