// The engine in the browser: the pipeline, given SQLite on the origin private file system, output
// files there too, and PLATO's vendored files fetched from the site.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import * as XLSX from 'xlsx';
import { loadResources } from './resources.js';
import { prepare, run, TARGETS } from './pipeline.js';
import { compare } from './compare.js';
import { publish } from './agora/index.js';
import { match } from './krisis/match.js';
import { apply } from './krisis/apply.js';
import { review } from './words.js';
import { DataError } from './input.js';
import { pragmas } from '../lib/store.js';
import { detect, readable } from './input.js';
import { columnsOf, mappingOf } from './hermes/generic.js';
import { FIELDS, cellText } from './hermes/columns.js';
import { load as choraLoad } from './chora/store.js';
import { save as choraSave } from './chora/save.js';

let resources = null, pool = null, runs = 0, poolName = null;
async function sqlitePool() {
  if (pool) return pool;
  const sqlite3 = await sqlite3InitModule();
  // A pool is one tab's alone: it holds every file in its directory open, so a second tab using the
  // same one cannot start. A page that may be open beside the main page (Chora's) asks for a pool of
  // its own at init; the main page's is the default, as it always was.
  const own = poolName ? { name: `opfs-sahpool-${poolName}` } : {};
  let vfs;
  try { vfs = await sqlite3.installOpfsSAHPoolVfs({ clearOnInit: true, initialCapacity: 8, forceReinitIfPreviouslyFailed: true, ...own }); }
  catch (e) { throw poolBusy(e) ? Object.assign(new Error(e.message), { kind: 'pool-busy' }) : e; }
  pool = { sqlite3, vfs };
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
  return { env, tidy: () => { for (const d of opened) if (!d.gone) { try { d.db.close(); } catch {} } unlinkClosed(); } };
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
      postMessage({ type: 'ready', version: resources.version });
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
        const { mapping, reasons, problems, gazetteer } = await mappingOf(input, data.saved);
        const fields = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, { single: f.single }]));
        postMessage({ type: 'columns', id: data.id, headers, examples, mapping, reasons, problems, gazetteer, fields, saved: data.saved !== undefined });
      } catch (e) {
        postMessage({ type: 'columns', id: data.id, error: String(e && e.message || e) });
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
      const unknown = [['dataset', input], ['previous release', previous]].find(([, i]) => i && !i.format);
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
      const unknown = [['subjects', subjects], ['others', others]].find(([, input]) => input && !input.format);
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
    if (!readable(input)) { postMessage({ type: 'chora-loaded', failure: input.reason }); return; }
    const { vfs } = await sqlitePool();
    if (session.store) { session.store.close(); session.store = null; session.fingerprint = null; }
    try { vfs.unlink(CHORA_DB); } catch { /* none yet */ }
    const db = new vfs.OpfsSAHPoolDb(CHORA_DB);
    db.exec(pragmas());
    // Opening a dataset leaves the last saved file where it is.
    const { env, tidy } = await runEnv({ clearOutputs: false, outputs: CHORA_OUT });
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
    postMessage({ type: 'chora-results', ...session.store.search(data.q || '', data.offset || 0, data.limit ?? 50) });
  } else if (data.cmd === 'chora-overview') {
    postMessage({ type: 'chora-overview', geojson: session.store.overview() });
  } else if (data.cmd === 'chora-place') {
    const boxes = data.ccodes || await ccodeBoxes();
    postMessage({ type: 'chora-place', id: data.id, view: session.store.getPlace(data.id, { ccodeBbox: (c) => (Array.isArray(boxes[c]) ? boxes[c] : null) }) });
  } else throw new Error(`Unknown command: ${data.cmd}`);
}
