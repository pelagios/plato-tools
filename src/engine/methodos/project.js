// Methodos: the project file, a whole workflow in one file (plan #34, item A2; Stephen, 12 October
// 2026: "PLATO Tools should have its own proj files and not handle WHG's"). It moves a workflow to
// another browser or computer, or to a colleague, and is what WHG's Workbench will store for sharing
// (item A1, its `plato` doc_type), so its format is a contract: DEVELOPERS.md, "The project file", and
// docs/project-file.md. It never reads WHG's own .whgproj files or synced projects.
//
// A zip (extension .platoproj), every entry deflated, whose FIRST entry is manifest.json:
//   { format: 'plato-tools-project', version: 1,
//     tools: { version, commit },                       the PLATO tools that wrote it (commit null when unknown)
//     created,                                          ISO 8601
//     workflow: { id, name, recipe: { key, version }, at },   at: the step it is at, or null when completed
//     parts: [{ path, role, size, sha256, … }],         every other entry, each once, in the zip's order
//     left?: [{ name, size, sha256, why }] }            files the workflow names that are not in it
// and the parts, by role:
//   record    workflow.json         the workflow's record, exactly its .workflow.json (record.js), the
//                                   Scope in it; one, always
//   review    review.krisis.json    the Krisis review open on the page (decisions, candidates, regions),
//                                   a work file; at most one; `name` is the name it is saved under
//   handback  chora-handback.json   Chora's hand-back for this workflow, references only; at most one
//   file      files/<sha256>        a file the record names: the user's own (`own`: true) or one a step
//                                   made; `name` is the record's name for it
// Each part's size and SHA-256 are in the manifest before its bytes, so a reader checks each as it
// streams past. Anything else (a key, a role, a path, an entry the manifest does not list, a version
// newer than VERSION) is refused, in words: a writer that adds anything raises the version.
//
// Both ways stream: a part is read from its Blob a chunk at a time, hashed and deflated as it goes,
// and the zip is handed on a chunk at a time (`write`, awaited); reading, each part is inflated, hashed
// and handed to its sink as it arrives. Nothing large is held twice. Pure: no page and no storage, so
// that the command line (plato-tools project info) and the tests read a project as the page does.
import { Zip, ZipDeflate, Unzip, UnzipInflate } from 'fflate';
import { Sha256 } from '../krisis/digest.js';
import { readWork } from '../krisis/work.js';
import { isRef } from './handoffs.js';
import { exportRecord, importRecord } from './record.js';

export const FORMAT = 'plato-tools-project';
/** The newest version of the format these tools write and read. */
export const VERSION = 1;
export const EXTENSION = '.platoproj';
export const MEDIA_TYPE = 'application/zip';
export const MANIFEST = 'manifest.json', RECORD = 'workflow.json', REVIEW = 'review.krisis.json', HANDBACK = 'chora-handback.json';
/** The most each part may hold, in bytes: what is read into memory is bounded, whatever a manifest says. */
export const LIMITS = { manifest: 1 << 20, record: 4 << 20, review: 256 << 20, handback: 64 << 10, parts: 1000 };

export class ProjectError extends Error {
  constructor(message) { super(message); this.name = 'ProjectError'; }
}
const no = (m) => { throw new ProjectError(m); };

const HEX64 = /^[0-9a-f]{64}$/, SHA1 = /^[0-9a-f]{40}$/;
const FILE_PATH = /^files\/([0-9a-f]{64})$/;
const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;   // as src/chora/handback.js isWorkflowId: safe in an address and in the page
// A name the page can show as it is (as src/lib/kept-file.js): no path, no control or invisible characters, at most 255.
const NAME = /^[^/\\\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]{1,255}$/;
const nameOk = (n) => typeof n === 'string' && NAME.test(n) && /\S/.test(n) && n !== '.' && n !== '..';
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const keysAre = (v, required, optional = []) => isObject(v) && required.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => required.includes(k) || optional.includes(k));
const size = (n) => Number.isSafeInteger(n) && n >= 0;
const enc = new TextEncoder();
const hex = (bytes) => new Sha256().update(bytes).hex();
const MB = (n) => `${Math.round(n / 1048576)} MB`;

/** Every file a record names: the files it began with, and every step's outputs and partial results. */
export const refsIn = (record) => [...Object.values(record?.files || {}).flat(), ...(record?.steps || []).flatMap((s) => [...Object.values(s.outputs || {}), ...Object.values(s.partial || {})].flat())];
/** The files the workflow began with: the user's own. */
export const ownIn = (record) => Object.values(record?.files || {}).flat();
/** The step a record is at (as src/methodos/seams.js stepAt): running or waiting, else stopped, failed or cancelled, else the next to do; null when completed. */
export function stepAt(record) {
  if (!record || record.status === 'completed') return null;
  if (record.current) return record.steps.find((s) => s.id === record.current) || null;
  return record.steps.find((s) => ['stopped', 'failed', 'cancelled'].includes(s.state)) || record.steps.find((s) => s.state === 'pending') || null;
}
/** The project's file name: the record's name, made safe, and .platoproj. */
export function projectName(record) {
  const base = String(record?.name || 'workflow').normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'workflow';
  return base + EXTENSION;
}

// ---- The manifest ------------------------------------------------------------------------------------
const ROLES = {
  record: { path: (p) => p === RECORD, keys: ['path', 'role', 'size', 'sha256'], limit: LIMITS.record },
  review: { path: (p) => p === REVIEW, keys: ['path', 'role', 'size', 'sha256', 'name'], limit: LIMITS.review },
  handback: { path: (p) => p === HANDBACK, keys: ['path', 'role', 'size', 'sha256'], limit: LIMITS.handback },
  file: { path: (p) => FILE_PATH.test(p), keys: ['path', 'role', 'size', 'sha256', 'name', 'own'], limit: Number.MAX_SAFE_INTEGER },
};
const LEFT_WHY = ['left-out', 'not-kept'];

/**
 * The manifest `m`, checked: returned as it is, or refused in words. The format and the version are
 * judged first, so that a newer project is said to be newer, not to have keys these tools do not know.
 */
export function checkManifest(m) {
  if (!isObject(m) || m.format !== FORMAT) no('This is not a PLATO tools project: its manifest does not name the format "plato-tools-project".');
  if (!Number.isSafeInteger(m.version) || m.version < 1) no('This project is damaged: its manifest gives no version of the format.');
  if (m.version > VERSION) {
    const by = isObject(m.tools) && typeof m.tools.version === 'string' && m.tools.version.length <= 64 ? ` (PLATO tools ${m.tools.version})` : '';
    no(`This project was saved by newer PLATO tools${by}, in version ${m.version} of the project format; these tools read version ${VERSION} and earlier, so it is not opened. Open it with the PLATO tools that saved it, or a later version.`);
  }
  const bad = (what) => no(`This project is damaged: ${what}`);
  if (!keysAre(m, ['format', 'version', 'tools', 'created', 'workflow', 'parts'], ['left'])) bad(`its manifest has keys these tools do not know (${Object.keys(m).filter((k) => !['format', 'version', 'tools', 'created', 'workflow', 'parts', 'left'].includes(k)).join(', ') || 'or lacks some'}).`);
  if (!keysAre(m.tools, ['version', 'commit']) || typeof m.tools.version !== 'string' || !m.tools.version || m.tools.version.length > 64 || !(m.tools.commit === null || SHA1.test(m.tools.commit)))
    bad('its manifest does not say which PLATO tools wrote it (tools: a version, and a commit or null).');
  if (typeof m.created !== 'string' || Number.isNaN(Date.parse(m.created))) bad('its manifest does not say when it was made (created).');
  const w = m.workflow;
  if (!keysAre(w, ['id', 'name', 'recipe', 'at']) || typeof w.id !== 'string' || !WORKFLOW_ID.test(w.id) || typeof w.name !== 'string' || w.name.length > 255
    || !keysAre(w.recipe, ['key', 'version']) || typeof w.recipe.key !== 'string' || !w.recipe.key || !Number.isSafeInteger(w.recipe.version)
    || !(w.at === null || (typeof w.at === 'string' && w.at.length <= 64))) bad('its manifest does not describe its workflow (an id, a name, its recipe and the step it is at).');
  if (!Array.isArray(m.parts) || !m.parts.length || m.parts.length > LIMITS.parts) bad(`its manifest lists no parts, or more than ${LIMITS.parts}.`);
  const paths = new Set(), count = { record: 0, review: 0, handback: 0, file: 0 };
  for (const p of m.parts) {
    const role = isObject(p) && Object.hasOwn(ROLES, p.role) ? ROLES[p.role] : null;
    if (!role) bad(`its manifest lists a part these tools do not know${isObject(p) && typeof p.role === 'string' ? ` (a "${p.role.slice(0, 40)}")` : ''}.`);
    if (!keysAre(p, role.keys) || typeof p.path !== 'string' || !role.path(p.path)) bad(`its manifest lists the part ${JSON.stringify(String(p.path).slice(0, 80))} in a way these tools do not know.`);
    if (paths.has(p.path)) bad(`its manifest lists ${p.path} twice.`);
    paths.add(p.path); count[p.role]++;
    if (!size(p.size) || p.size > role.limit) bad(`its manifest gives ${p.path} a size that is not one, or is over ${MB(role.limit)}.`);
    if (typeof p.sha256 !== 'string' || !HEX64.test(p.sha256)) bad(`its manifest gives ${p.path} no SHA-256.`);
    if (p.role === 'file' && (FILE_PATH.exec(p.path)[1] !== p.sha256 || !nameOk(p.name) || typeof p.own !== 'boolean')) bad(`its manifest does not name ${p.path} by its SHA-256, or gives it no name a page can show.`);
    if (p.role === 'review' && !nameOk(p.name)) bad('its manifest gives the review no name a page can show.');
  }
  if (count.record !== 1 || count.review > 1 || count.handback > 1) bad('its manifest does not list one workflow record, with at most one review and one hand-back from Chora.');
  if (m.parts[0].role !== 'record') bad(`its manifest does not list the workflow record (${RECORD}) first.`);
  if (m.left !== undefined && !(Array.isArray(m.left) && m.left.length <= LIMITS.parts && m.left.every((x) => keysAre(x, ['name', 'size', 'sha256', 'why']) && nameOk(x.name) && size(x.size) && HEX64.test(x.sha256) && LEFT_WHY.includes(x.why))))
    bad('its manifest lists the files left out of it in a way these tools do not know.');
  return m;
}

/** What `hb` is, if it is a hand-back from Chora for workflow `id` (src/chora/handback.js, format 1), else null. */
function handbackOf(hb, id) {
  if (!keysAre(hb, ['handback', 'workflow', 'files', 'at']) || hb.handback !== 1 || hb.workflow !== id || !Number.isSafeInteger(hb.at)) return null;
  if (!Array.isArray(hb.files) || hb.files.length !== 1) return null;
  const [r] = hb.files;
  if (!isRef(r) || r.type !== 'dataset' || Object.keys(r).length !== 4 || !nameOk(r.name)) return null;
  return { handback: 1, workflow: id, files: [{ type: r.type, name: r.name, size: r.size, sha256: r.sha256 }], at: hb.at };
}

// ---- Writing ------------------------------------------------------------------------------------------
/**
 * Write the project of `record` (a workflow's record, as the store keeps it, its Scope in it) to
 * `write(chunk)` (awaited, a chunk of the zip at a time). `files`: [{ ref, blob }], each a file the
 * record names, read as a stream and checked to be the bytes `ref` names (a file changed in storage is
 * refused, never saved under another's hash); `left`: the files the record names that are not given,
 * each { ref, why: 'left-out' | 'not-kept' }; `review`: { name, text } of the review open, or null;
 * `handback`: Chora's hand-back for this workflow, or null; `tools`: { version, commit }; `refuse`: the
 * secrets that must not be in it (the WHG token): a JSON part holding one is refused, and nothing is
 * written. Returns { manifest, size } (the zip's size in bytes).
 */
export async function writeProject({ record, files = [], left = [], review = null, handback = null, tools, now = new Date(), refuse = [] }, write) {
  if (!record || !Array.isArray(record.steps)) no('There is no workflow to save.');
  const text = exportRecord(record);
  const named = refsIn(record), own = new Set(ownIn(record).map((r) => r.sha256));
  const secrets = refuse.filter((s) => typeof s === 'string' && s.length >= 8);
  const small = [{ path: RECORD, role: 'record', bytes: enc.encode(text), words: 'the workflow\'s record' }];
  if (review) {
    if (!nameOk(review.name)) no(`The review open is called "${review.name}", which is not a name a project can keep.`);
    small.push({ path: REVIEW, role: 'review', name: review.name, bytes: enc.encode(review.text), words: `the review ${review.name}` });
  }
  if (handback) {
    const hb = handbackOf(handback, record.id);
    if (hb) small.push({ path: HANDBACK, role: 'handback', bytes: enc.encode(JSON.stringify(hb)), words: 'Chora\'s hand-back' });
  }
  for (const s of small) {
    const t = new TextDecoder().decode(s.bytes);
    if (secrets.some((x) => t.includes(x))) no(`${s.words[0].toUpperCase()}${s.words.slice(1)} holds your WHG token, which a project never does, so nothing was saved.`);
  }
  const seen = new Set();
  const big = [];
  for (const { ref, blob } of files) {
    if (!isRef(ref) || !named.some((r) => r.sha256 === ref.sha256 && r.size === ref.size)) no(`${ref?.name ?? 'A file'} is not one the workflow names, so it is not put in its project.`);
    if (seen.has(ref.sha256)) continue;
    seen.add(ref.sha256);
    big.push({ path: `files/${ref.sha256}`, role: 'file', name: nameOk(ref.name) ? ref.name : 'file', own: own.has(ref.sha256), size: ref.size, sha256: ref.sha256, blob });
  }
  const parts = [
    ...small.map((s) => ({ path: s.path, role: s.role, size: s.bytes.length, sha256: hex(s.bytes), ...(s.role === 'review' ? { name: s.name } : {}) })),
    ...big.map((b) => ({ path: b.path, role: 'file', size: b.size, sha256: b.sha256, name: b.name, own: b.own })),
  ];
  const leftOut = left.filter((x) => isRef(x.ref) && !seen.has(x.ref.sha256)).map((x) => ({ name: nameOk(x.ref.name) ? x.ref.name : 'file', size: x.ref.size, sha256: x.ref.sha256, why: LEFT_WHY.includes(x.why) ? x.why : 'not-kept' }));
  const at = stepAt(record);
  const manifest = checkManifest({
    format: FORMAT, version: VERSION,
    tools: { version: String(tools?.version || 'unknown'), commit: SHA1.test(tools?.commit || '') ? tools.commit : null },
    created: new Date(now).toISOString(),
    workflow: { id: record.id, name: String(record.name || '').slice(0, 255), recipe: { key: record.recipe.key, version: record.recipe.version }, at: at ? at.id : null },
    parts, ...(leftOut.length ? { left: leftOut } : {}),
  });

  // The zip, handed on a chunk at a time: fflate's callback is synchronous, so its chunks are queued
  // and written (awaited) after each piece pushed, so that a slow disk holds the reading back.
  const queue = [];
  let failure = null, total = 0;
  const zip = new Zip((err, chunk) => { if (err) failure = err; else queue.push(chunk); });
  const drain = async () => {
    if (failure) throw failure;
    while (queue.length) { const c = queue.shift(); total += c.length; await write(c); }
  };
  const entry = (path, big) => { const f = new ZipDeflate(path, { level: big ? 1 : 6 }); zip.add(f); return f; };
  const m = entry(MANIFEST); m.push(enc.encode(JSON.stringify(manifest, null, 2) + '\n'), true); await drain();
  for (const s of small) { const f = entry(s.path); f.push(s.bytes, true); await drain(); }
  for (const b of big) {
    const f = entry(b.path, b.size > (16 << 20));
    const h = new Sha256(), reader = b.blob.stream().getReader();
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length; h.update(value);
      f.push(value); await drain();
    }
    if (n !== b.size || h.hex() !== b.sha256) no(`${b.name}, as this browser keeps it, is not the file the workflow recorded (its size or SHA-256 differs), so the project was not saved. Choose the file again, or clear the workflow's files and run its step again.`);
    f.push(new Uint8Array(0), true); await drain();
  }
  zip.end(); await drain();
  return { manifest, size: total };
}

// ---- Reading ------------------------------------------------------------------------------------------
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/**
 * Read a project from `chunks` (an async iterable of Uint8Array: a File's stream, or Node's), checking
 * the manifest before anything else and every part's size and SHA-256 as it streams past. `sink(part)`
 * is asked for each file part (role 'file'), and may give { write(chunk), close() -> result, abort() }
 * (write and close awaited); without one, its bytes are only checked. A part that fails its check is
 * aborted before it is closed. `name` (the file's name) only shapes the words of a refusal.
 * Returns { manifest, record, recordText, review: { name, text, work } | null, handback | null,
 * files: [{ part, result }] }; refused, in words, with a ProjectError: a file that is not a zip, a zip
 * that is not a project, a newer format, anything unknown, a part missing, cut short, too long, or not
 * the bytes its hash names. On a refusal, every sink already closed is listed in the error (`closed`),
 * for the caller to let go.
 */
export async function readProject(chunks, { sink = null, name = '' } = {}) {
  let manifest = null, byPath = null, failure = null, first = true, head = null;
  const got = new Map(), small = new Map(), closed = [];
  let pending = Promise.resolve();
  const later = (fn) => { pending = pending.then(fn).catch((e) => { failure ||= e; }); };
  const fail = (e) => { failure ||= (e instanceof ProjectError ? e : new ProjectError(`This project is damaged: ${e?.message || e}.`)); };

  const unzip = new Unzip((file) => {
    if (failure) { try { file.terminate(); } catch { /* stopped */ } return; }
    const path = file.name;
    if (first) {
      first = false;
      if (path !== MANIFEST) { fail(new ProjectError(`This is not a PLATO tools project: it is a zip whose first file is ${JSON.stringify(String(path).slice(0, 80))}, not ${MANIFEST}.`)); file.terminate(); return; }
    } else if (!manifest) { fail(new ProjectError(`This project is damaged: its ${MANIFEST} could not be read before the files after it.`)); file.terminate(); return; }
    let part = null;
    if (path !== MANIFEST) {
      part = byPath.get(path);
      if (!part) { fail(new ProjectError(`This project holds a file its manifest does not list (${JSON.stringify(String(path).slice(0, 80))}), so it is not opened: a project holds nothing it does not declare.`)); file.terminate(); return; }
      if (got.has(path)) { fail(new ProjectError(`This project is damaged: it holds ${path} twice.`)); file.terminate(); return; }
    } else if (manifest) { fail(new ProjectError(`This project is damaged: it holds ${MANIFEST} twice.`)); file.terminate(); return; }
    const limit = part ? part.size : LIMITS.manifest;
    const h = new Sha256();
    const keep = !part || part.role !== 'file';          // the manifest and the JSON parts are read into memory
    const bytes = [];
    let n = 0, out = null;
    if (part) got.set(path, true);
    if (part && part.role === 'file' && sink) later(async () => { out = await sink(part); });
    file.ondata = (err, data, final) => {
      if (failure) return;
      if (err) { fail(err); return; }
      n += data.length;
      if (n > limit) {
        fail(new ProjectError(part ? `This project is damaged: ${label(part)} is longer than its manifest says (${part.size} bytes).` : `This project is damaged, or not one: its ${MANIFEST} is over ${MB(LIMITS.manifest)}.`));
        try { file.terminate(); } catch { /* stopped */ }
        return;
      }
      if (data.length) {
        h.update(data);
        if (keep) bytes.push(data); else if (sink) later(async () => { if (out) await out.write(data); });
      }
      if (!final) return;
      if (!part) {
        try {
          let m;
          try { m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concat(bytes))); } catch { no(`This project is damaged: its ${MANIFEST} is not JSON.`); }
          manifest = checkManifest(m);
          byPath = new Map(manifest.parts.map((p) => [p.path, p]));
        } catch (e) { fail(e); }
        return;
      }
      if (n !== part.size || h.hex() !== part.sha256) {
        fail(new ProjectError(`This project is damaged: ${label(part)} is not the file its manifest names (its ${n !== part.size ? 'size' : 'SHA-256'} differs), so nothing of it was opened. It may have been changed after it was saved, or not copied whole.`));
        later(async () => { if (out) await out.abort?.(); out = null; });
        return;
      }
      if (keep) small.set(path, concat(bytes));
      else later(async () => { if (out) { const result = await out.close(); closed.push({ part, result }); } else closed.push({ part, result: null }); });
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  try {
    for await (const chunk of chunks) {
      const c = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (!c.length) continue;
      if (!head || head.length < 4) {
        // Its first four bytes, however the chunks fall: a zip begins with a local file header.
        head = concat([head || new Uint8Array(0), c.subarray(0, 4 - (head?.length || 0))]).slice();
        if (!ZIP_MAGIC.slice(0, head.length).every((b, i) => head[i] === b)) {
          const whg = /\.whgproj$/i.test(name);
          no(whg ? 'This is a WHG project (.whgproj). PLATO tools do not open WHG\'s projects: open it in WHG\'s Map your Data. A PLATO tools project ends .platoproj.'
            : `This is not a PLATO tools project (${EXTENSION}): it is not a zip file.`);
        }
      }
      try { unzip.push(c); } catch (e) { fail(e); }
      await pending;
      if (failure) throw failure;
    }
    try { unzip.push(new Uint8Array(0), true); } catch (e) { fail(e); }
    await pending;
    if (failure) throw failure;
    if (!head) no('This file is empty: it is not a PLATO tools project.');
    if (!manifest) no(`This is not a PLATO tools project: it has no ${MANIFEST}.`);
    const missing = manifest.parts.filter((p) => !got.has(p.path) || (p.role !== 'file' && !small.has(p.path)) || (p.role === 'file' && !closed.some((c) => c.part === p)));
    if (missing.length) no(`This project is damaged: ${missing.map(label).join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing from it, or cut short.`);
    return { manifest, ...checkParts(manifest, small), files: closed };
  } catch (e) {
    const err = e instanceof ProjectError ? e : new ProjectError(`This project is damaged: ${e?.message || e}.`);
    err.closed = closed;
    throw err;
  }
}
const label = (p) => (p.role === 'file' ? `${p.name} (${p.path})` : p.role === 'review' ? `the review ${p.name}` : p.role === 'handback' ? 'Chora\'s hand-back' : 'the workflow\'s record');
function concat(list) {
  if (list.length === 1) return list[0];
  const out = new Uint8Array(list.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of list) { out.set(c, at); at += c.length; }
  return out;
}

/** The JSON parts, read and checked against the manifest and each other. */
function checkParts(manifest, small) {
  const text = (path) => new TextDecoder('utf-8', { fatal: true }).decode(small.get(path));
  let recordText, record;
  try { recordText = text(RECORD); record = importRecord(recordText); } catch (e) { no(`This project's workflow cannot be opened: ${e.message}`); }
  const w = manifest.workflow;
  if (record.id !== w.id || record.recipe.key !== w.recipe.key || record.recipe.version !== w.recipe.version)
    no('This project is damaged: its manifest and its workflow\'s record do not describe the same workflow.');
  const named = refsIn(record), own = new Set(ownIn(record).map((r) => r.sha256));
  for (const p of manifest.parts.filter((x) => x.role === 'file')) {
    if (!named.some((r) => r.sha256 === p.sha256 && r.size === p.size)) no(`This project holds ${p.name}, which its workflow does not name, so it is not opened.`);
    if (p.own && !own.has(p.sha256)) no(`This project is damaged: it calls ${p.name} the file the workflow began with, which the workflow does not.`);
  }
  for (const x of manifest.left || []) if (!named.some((r) => r.sha256 === x.sha256)) no(`This project is damaged: it lists ${x.name} as left out, which its workflow does not name.`);
  let review = null, handback = null;
  const rp = manifest.parts.find((p) => p.role === 'review');
  if (rp) {
    let t, work;
    try { t = text(REVIEW); work = readWork(t); } catch (e) { no(`The review in this project cannot be opened: ${e.message}`); }
    review = { name: rp.name, text: t, work };
  }
  if (manifest.parts.some((p) => p.role === 'handback')) {
    let v = null;
    try { v = JSON.parse(text(HANDBACK)); } catch { /* refused below */ }
    handback = handbackOf(v, record.id);
    if (!handback) no('This project is damaged: Chora\'s hand-back in it is not one for its workflow.');
  }
  return { record, recordText, review, handback };
}

/** The lines `plato-tools project info` prints of a project read: what it is, what it holds, and what it left out. */
export function describe(read) {
  const { manifest: m, record } = read;
  const at = m.workflow.at ? record.steps.find((s) => s.id === m.workflow.at) : null;
  const done = record.steps.filter((s) => s.state === 'done').length, followed = record.steps.filter((s) => s.state !== 'skipped').length;
  const lines = [
    `A PLATO tools project, format version ${m.version}, saved ${m.created} by PLATO tools ${m.tools.version}${m.tools.commit ? ` (${m.tools.commit.slice(0, 12)})` : ''}.`,
    `Workflow: "${m.workflow.name}", following ${m.workflow.recipe.key} (version ${m.workflow.recipe.version}); ${done} of ${followed} steps done${at ? `, at "${at.title}"` : ', every step done'}.`,
    `Scope: ${record.scope ? 'kept with the workflow' : 'none'}.`,
    'Parts (each size and SHA-256 checked):',
    ...m.parts.map((p) => `  ${p.path.padEnd(72)} ${String(p.size).padStart(12)} bytes  ${p.role}${p.role === 'file' ? `: ${p.name}${p.own ? ' (the file the workflow began with)' : ''}` : p.role === 'review' ? `: ${p.name}` : ''}`),
  ];
  if (m.left?.length) lines.push('Named by the workflow but not in the project:', ...m.left.map((x) => `  ${x.name} (${x.size} bytes): ${x.why === 'left-out' ? 'left out when it was saved' : 'not kept in the browser it was saved from'}`));
  return lines;
}
