// The engine in Node, as src/engine/worker.js is the engine in the browser: the same pipeline,
// given a triple store in a file on disk, outputs written straight to disk, and PLATO's vendored
// files read from public/plato/. Also how command-line arguments become inputs.
import { openAsBlob, mkdirSync, mkdtempSync, openSync, writeSync, closeSync, rmSync, rmdirSync, existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadResources } from '../engine/resources.js';
import { prepare } from '../engine/pipeline.js';
import { openNodeSqlite } from './sqlite.js';

const PLATO_FILES = new URL('../../public/plato/', import.meta.url);
export async function nodeResources() {
  return prepare(await loadResources((f) => readFile(new URL(f, PLATO_FILES), 'utf8')));
}

/**
 * Which inputs the arguments name, in the order given. Each file is one input, except:
 * - a directory is one set of spreadsheet tables, made of the CSV files in it;
 * - CSV files named one by one are the sheets of one set of tables per directory, so
 *   `a/*.csv b/*.csv` is two sets.
 * Returns [{ label, paths, name? }], or { label, failure } for an argument that cannot be read.
 */
export async function gatherInputs(args) {
  const inputs = [], csvSets = new Map();
  for (const arg of args) {
    let st;
    try { st = await stat(arg); } catch (e) { inputs.push({ label: arg, paths: [arg], failure: e.code === 'ENOENT' ? 'There is no such file or directory.' : e.message }); continue; }
    if (st.isDirectory()) {
      const csvs = (await readdir(arg)).filter((f) => /\.csv$/i.test(f)).sort().map((f) => join(arg, f));
      const label = arg.endsWith('/') ? arg : arg + '/';
      if (!csvs.length) inputs.push({ label, paths: [arg], failure: 'A directory is read as one set of spreadsheet tables, but this one holds no CSV files.' });
      else inputs.push({ label, paths: csvs, name: basename(resolve(arg)) });
    } else if (/\.csv$/i.test(arg)) {
      const dir = dirname(resolve(arg));
      let set = csvSets.get(dir);
      if (!set) { set = { label: '', paths: [], name: basename(dir) }; csvSets.set(dir, set); inputs.push(set); }
      set.paths.push(arg);
      set.label = set.paths.length === 1 ? arg : `${join(dirname(arg), '*.csv')} (${set.paths.length} files)`;
    } else inputs.push({ label: arg, paths: [arg] });
  }
  return inputs;
}

/** Files as the engine expects them (name, size, slice, stream, text), read from disk lazily. */
export async function openFiles(paths) {
  return Promise.all(paths.map(async (p) => {
    const blob = await openAsBlob(p);
    Object.defineProperty(blob, 'name', { value: basename(p) });
    return blob;
  }));
}

/** A system error (a file that cannot be read or written) rather than a problem in the data. */
export const isSystemError = (e) => !!(e && typeof e.code === 'string' && /^E[A-Z]+$/.test(e.code));

/**
 * Take back what a failed run wrote: its files; the roots of trees it began, whole; then every
 * folder it made that is now empty, deepest first. A folder that was there before the run is never
 * removed, even when --overwrite emptied it, and one that still holds something is kept.
 */
function undo(run) {
  for (const p of run.created) rmSync(p, { force: true });
  for (const r of run.roots) rmSync(r, { recursive: true, force: true });
  for (const d of [...run.dirs].sort((a, b) => b.length - a.length)) {
    try { rmdirSync(d); } catch { /* gone already, or not empty */ }
  }
}

/**
 * One host per invocation. The working databases live in one temporary directory under
 * `workDir`, made when first needed and removed by cleanup(); SQLite's own temporary files (for
 * sorting while it builds indexes) go there too.
 */
export class NodeHost {
  constructor({ workDir = tmpdir(), outDir = '.', overwrite = false } = {}) {
    this.workDir = workDir; this.outDir = outDir; this.overwrite = overwrite; this.dir = null; this.runs = 0; this.open = new Set(); this.running = null;
  }
  _work() {
    if (!this.dir) {
      mkdirSync(this.workDir, { recursive: true });
      this.dir = mkdtempSync(join(this.workDir, 'plato-tools-'));
      // Read once, when SQLite first starts, so it is set before the first database is opened.
      if (!process.env.SQLITE_TMPDIR) process.env.SQLITE_TMPDIR = this.dir;
    }
    return this.dir;
  }
  /** The environment for one run: its store, its outputs, and what it left behind. */
  env(resources, { progress, xlsx } = {}) {
    const host = this;
    // What this run made, so that a run that fails can take it all back: its files, the folders
    // made to hold them, and the roots of the trees it began (env.folder) where there was none.
    const run = { db: null, created: [], dirs: new Set(), roots: [] };
    this.running = run;
    const env = {
      resources, csvMeta: resources.csvMeta, xlsx, progress,
      openDb: async () => {
        run.db = openNodeSqlite(join(host._work(), `run-${++host.runs}.sqlite3`));
        host.open.add(run.db);
        return run.db;
      },
      output: async (name) => create(join(host.outDir, name), name),
      // A folder of files with paths of their own (Agora's site and w3id folder); in the browser the
      // same tree is one zip (engine/agora/tree.js). Each file is made as output() makes one.
      folder: async (name) => {
        // One name, never a path: the tree's own folder is all that --overwrite may clear.
        if (!name || /[/\\]/.test(name) || name === '.' || name === '..') throw new Error(`not a name for a folder: ${name}`);
        const root = join(host.outDir, name);
        if (!existsSync(root)) run.roots.push(root);
        else if (host.overwrite) {
          // Replaced, not written over: a file the last run wrote and this one does not (a place
          // since left out) must not stay behind to be served. It is made again at once, so that it
          // counts as the folder that was there, which a failure empties but never removes.
          rmSync(root, { recursive: true, force: true });
          mkdirSync(root);
        }
        return {
          path: root,
          file: async (rel) => {
            if (rel.split('/').some((p) => p === '..' || p === '.' || p === '')) throw new Error(`not a path inside the folder: ${rel}`);
            return create(join(root, rel), rel);
          },
        };
      },
    };
    function create(path, name) {
      const made = mkdirSync(dirname(path), { recursive: true });
      // mkdirSync gives the first folder it had to make: that one and those below it are this run's.
      if (made) for (let d = dirname(path); d.length >= made.length; d = dirname(d)) run.dirs.add(d);
      const fd = openSync(path, host.overwrite ? 'w' : 'wx');   // wx: never replace a file unasked
      run.created.push(path);
      let size = 0;
      const put = (buf) => { let at = 0; while (at < buf.length) at += writeSync(fd, buf, at, buf.length - at); size += buf.length; };
      return {
        write: (s) => put(Buffer.from(s, 'utf8')),
        writeBytes: (b) => put(b),
        close: async () => { closeSync(fd); return { name, size, path }; },
      };
    }
    return {
      env,
      /** After the run: close and delete its database; on failure, delete its partial outputs. */
      finish(failed) {
        host.running = null;
        const storeBytes = run.db ? (run.db.close(), host.open.delete(run.db), run.db.bytes) : null;
        if (failed) undo(run);
        return { storeBytes, removed: failed ? run.created : [] };
      },
    };
  }
  /** Stopped part-way (interrupted): the output being written is incomplete, so remove it. */
  abandon() {
    const removed = this.running ? this.running.created : [];
    if (this.running) undo(this.running);
    this.running = null;
    this.cleanup();
    return removed;
  }
  cleanup() {
    for (const db of this.open) { try { db.close(); } catch {} }
    this.open.clear();
    if (this.dir) { rmSync(this.dir, { recursive: true, force: true }); this.dir = null; }
  }
}
