// Methodos: the project file, a whole workflow in one file (plan #34, item A2; Stephen, 12 October
// 2026: "PLATO Tools should have its own proj files and not handle WHG's"). It moves a workflow to
// another browser or computer, or to a colleague, and is what WHG's Workbench will store for sharing
// (item A1, its `plato` doc_type), so its format is a contract: docs/project-file.md, and
// DEVELOPERS.md, "The project file". It never reads WHG's own .whgproj files or synced projects.
//
// A zip (extension .platoproj) whose first entry is manifest.json:
//   { format: 'plato-tools-project', version: 1, minor: 1,
//     tools: { version, commit },                       the PLATO tools that wrote it (commit null when unknown)
//     created,                                          ISO 8601
//     workflow: { id, name, recipe: { key, version }, at },   at: the step it is at, or null when completed
//     parts: [{ path, role, size, sha256, optional?, … }],   every other entry, each once
//     left?: [{ name, size, sha256, why }] }            files the workflow names that are not in it; why:
//                                                       'left-out' (the user's choice), 'not-kept' (no longer
//                                                       kept in the browser), or, from 1.1, 'too-large' (left
//                                                       out to fit WHG's Workbench: src/engine/workbench.js)
// and the parts, by role:
//   record    workflow.json         the workflow's record, exactly its .workflow.json (record.js), the
//                                   Scope in it; one, always
//   review    review.krisis.json    the Krisis review open on the page (decisions, candidates, regions),
//                                   a work file; at most one; `name` is the name it is saved under
//   handback  chora-handback.json   Chora's hand-back for this workflow, references only; at most one. The page
//                                   wrote one until 13 October 2026, when Chora came into it and its save
//                                   began to complete the workflow's step itself: still read, so that a
//                                   project saved before opens, and written if a caller gives one
//   file      files/<sha256>        a file the record names: the user's own (`own`: true) or one a step
//                                   made; `name` is the record's name for it
//
// Versions. `version` is the major: a reader refuses a greater one. `minor` (default 0) is what a
// writer may add without breaking a reader of the same major: a reader opens a greater minor, says so,
// and ignores the keys it does not know; at its own minor or below, a key it does not know is damage.
// 1.1 (14 October 2026) added the why 'too-large'; a 1.0 reader opens a 1.1 project as of a later minor,
// and takes a why it does not know as it takes any other later minor's value (checkManifest, `left`).
// A role or an entry it does not know is never ignored, unless the manifest marks the part `optional`.
//
// The zip's CENTRAL DIRECTORY is authoritative (as for every other reader of zips, Python's and WHG's
// among them): the reader finds it, checks that each local header agrees with it and that no two
// entries overlap, and reads each entry by its offset and compressed size. Nothing is scanned for
// signatures, so a part that holds a zip of its own (a workbook) is read as it is. Both ways stream: a
// part is read a chunk at a time, hashed, searched for the secrets it must not hold, and deflated as it
// goes, the zip handed on a chunk at a time (`write`, awaited); reading, each entry is read from the file
// a slice at a time, inflated, hashed and handed to its sink. Nothing large is held twice. Pure: no page
// and no storage, so that the command line (plato-tools project info) and the tests read a project as
// the page does.
import { Zip, ZipDeflate, Inflate } from 'fflate';
import { Sha256 } from '../krisis/digest.js';
import { readWork } from '../krisis/work.js';
import { isRef } from './handoffs.js';
import { exportRecord, importRecord } from './record.js';

export const FORMAT = 'plato-tools-project';
/** The major version of the format these tools write and read, and the minor they write. */
export const VERSION = 1, MINOR = 1;
export const EXTENSION = '.platoproj';
export const MEDIA_TYPE = 'application/zip';
export const MANIFEST = 'manifest.json', RECORD = 'workflow.json', REVIEW = 'review.krisis.json', HANDBACK = 'chora-handback.json';
/** The most each part may hold, in bytes: what is read into memory is bounded, whatever a manifest says. A zip without ZIP64 holds at most 4 GiB. */
export const ZIP_MAX = 0xffffffff;
export const LIMITS = { manifest: 1 << 20, record: 4 << 20, review: 64 << 20, handback: 64 << 10, parts: 1000, file: ZIP_MAX };

export class ProjectError extends Error {
  constructor(message) { super(message); this.name = 'ProjectError'; }
}
const no = (m) => { throw new ProjectError(m); };

const HEX64 = /^[0-9a-f]{64}$/, SHA1 = /^[0-9a-f]{40}$/;
const FILE_PATH = /^files\/([0-9a-f]{64})$/;
// A path an optional part of a later minor may have: relative, plain segments, no '..'.
const SAFE_PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;   // a workflow's id: safe in an address and in the page
// A name the page can show as it is (as src/lib/kept-file.js): no path, no control or invisible characters, at most 255.
const NAME = /^[^/\\\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]{1,255}$/;
const nameOk = (n) => typeof n === 'string' && NAME.test(n) && /\S/.test(n) && n !== '.' && n !== '..';
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** `v` has the `required` keys, and (unless `lenient`, a later minor's) no key but those and `optional`. */
const keysAre = (v, required, optional = [], lenient = false) => isObject(v) && required.every((k) => Object.hasOwn(v, k)) && (lenient || Object.keys(v).every((k) => required.includes(k) || optional.includes(k)));
const size = (n) => Number.isSafeInteger(n) && n >= 0;
const enc = new TextEncoder();
const hex = (bytes) => new Sha256().update(bytes).hex();
const MB = (n) => (n >= 1 << 30 ? `${Math.round(n / (1 << 30))} GiB` : `${Math.round(n / 1048576)} MB`);

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
const nameIn = (record) => String(record?.name || '').slice(0, 255);

// ---- Secrets: what no part may hold ------------------------------------------------------------------
/**
 * A search for `secrets` (strings of 8 characters or more) in bytes streamed a chunk at a time: the last
 * bytes of each chunk are kept, so that a secret split across two chunks is found. `push(chunk)` is true
 * once one is found.
 */
export function secretSearch(secrets) {
  const needles = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 8))].map((s) => enc.encode(s));
  const keep = needles.reduce((n, x) => Math.max(n, x.length), 0) - 1;
  let tail = new Uint8Array(0), found = false;
  const within = (hay, x) => {
    for (let i = hay.indexOf(x[0]); i >= 0 && i + x.length <= hay.length; i = hay.indexOf(x[0], i + 1)) {
      let j = 1;
      while (j < x.length && hay[i + j] === x[j]) j++;
      if (j === x.length) return true;
    }
    return false;
  };
  return {
    push(chunk) {
      if (found || !needles.length || !chunk.length) return found;
      const hay = tail.length ? concat([tail, chunk]) : chunk;
      found = needles.some((x) => within(hay, x));
      tail = hay.slice(Math.max(0, hay.length - keep));
      return found;
    },
    text: (t) => (found ||= needles.length > 0 && secrets.some((s) => typeof s === 'string' && s.length >= 8 && t.includes(s))),
  };
}

// ---- The manifest ------------------------------------------------------------------------------------
const ROLES = {
  record: { path: (p) => p === RECORD, keys: ['path', 'role', 'size', 'sha256'], limit: LIMITS.record },
  review: { path: (p) => p === REVIEW, keys: ['path', 'role', 'size', 'sha256', 'name'], limit: LIMITS.review },
  handback: { path: (p) => p === HANDBACK, keys: ['path', 'role', 'size', 'sha256'], limit: LIMITS.handback },
  file: { path: (p) => FILE_PATH.test(p), keys: ['path', 'role', 'size', 'sha256', 'name', 'own'], limit: LIMITS.file },
};
const TOP = ['format', 'version', 'tools', 'created', 'workflow', 'parts'], TOP_OPTIONAL = ['minor', 'left'];
const LEFT_WHY = ['left-out', 'not-kept', 'too-large'];

/**
 * The manifest `m`, checked: returns { manifest, newer } (newer: it is of a later minor of this major, so
 * that keys these tools do not know were ignored), or refuses in words. The format and the major are
 * judged first, so that a newer project is said to be newer, not to have keys these tools do not know.
 * The parts these tools can read are in `manifest.parts`; optional parts of roles they do not know are
 * in `manifest.skipped`.
 */
export function checkManifest(m) {
  if (!isObject(m) || m.format !== FORMAT) no('This is not a PLATO tools project: its manifest does not name the format "plato-tools-project".');
  if (!Number.isSafeInteger(m.version) || m.version < 1) no('This project is damaged: its manifest gives no version of the format.');
  const by = isObject(m.tools) && typeof m.tools.version === 'string' && m.tools.version.length <= 64 ? ` (PLATO tools ${m.tools.version})` : '';
  if (m.version > VERSION) no(`This project was saved by newer PLATO tools${by}, in version ${m.version} of the project format; these tools read version ${VERSION}, so it is not opened. Open it with the PLATO tools that saved it, or a later version.`);
  const minor = m.minor ?? 0;
  if (!Number.isSafeInteger(minor) || minor < 0) no('This project is damaged: its manifest gives a minor version that is not a whole number.');
  const newer = minor > MINOR;
  const bad = (what) => no(`This project is damaged: ${what}`);
  if (!keysAre(m, TOP, TOP_OPTIONAL, newer)) bad(`its manifest has keys these tools do not know (${Object.keys(m).filter((k) => ![...TOP, ...TOP_OPTIONAL].includes(k)).join(', ') || 'or lacks some'}).`);
  if (!keysAre(m.tools, ['version', 'commit'], [], newer) || typeof m.tools.version !== 'string' || !m.tools.version || m.tools.version.length > 64 || !(m.tools.commit === null || SHA1.test(m.tools.commit)))
    bad('its manifest does not say which PLATO tools wrote it (tools: a version, and a commit or null).');
  if (typeof m.created !== 'string' || Number.isNaN(Date.parse(m.created))) bad('its manifest does not say when it was made (created).');
  const w = m.workflow;
  if (!keysAre(w, ['id', 'name', 'recipe', 'at'], [], newer) || typeof w.id !== 'string' || !WORKFLOW_ID.test(w.id) || typeof w.name !== 'string' || w.name.length > 255
    || !keysAre(w.recipe, ['key', 'version'], [], newer) || typeof w.recipe.key !== 'string' || !w.recipe.key || !Number.isSafeInteger(w.recipe.version)
    || !(w.at === null || (typeof w.at === 'string' && w.at.length <= 64))) bad('its manifest does not describe its workflow (an id, a name, its recipe and the step it is at).');
  if (!Array.isArray(m.parts) || !m.parts.length || m.parts.length > LIMITS.parts) bad(`its manifest lists no parts, or more than ${LIMITS.parts}.`);
  const paths = new Set(), count = { record: 0, review: 0, handback: 0, file: 0 }, parts = [], skipped = [];
  for (const p of m.parts) {
    if (!isObject(p) || typeof p.path !== 'string') bad('its manifest lists a part with no path.');
    if (paths.has(p.path)) bad(`its manifest lists ${p.path.slice(0, 80)} twice.`);
    paths.add(p.path);
    if (p.optional !== undefined && typeof p.optional !== 'boolean') bad(`its manifest marks ${p.path.slice(0, 80)} optional in a way these tools do not know.`);
    const role = Object.hasOwn(ROLES, p.role) ? ROLES[p.role] : null;
    if (!role) {
      // A part of a role these tools do not know: never ignored, unless it is marked optional.
      if (p.optional === true && SAFE_PATH.test(p.path) && p.path !== MANIFEST && size(p.size) && p.size <= ZIP_MAX && HEX64.test(p.sha256 || '')) { skipped.push(p); continue; }
      bad(`its manifest lists a part these tools do not know${typeof p.role === 'string' ? ` (a "${p.role.slice(0, 40)}")` : ''}.`);
    }
    if (!keysAre(p, role.keys, ['optional'], newer) || !role.path(p.path)) bad(`its manifest lists the part ${JSON.stringify(String(p.path).slice(0, 80))} in a way these tools do not know.`);
    count[p.role]++;
    if (!size(p.size) || p.size > role.limit) bad(`its manifest gives ${p.path} a size that is not one, or is over ${MB(role.limit)}.`);
    if (typeof p.sha256 !== 'string' || !HEX64.test(p.sha256)) bad(`its manifest gives ${p.path} no SHA-256.`);
    if (p.role === 'file' && (FILE_PATH.exec(p.path)[1] !== p.sha256 || !nameOk(p.name) || typeof p.own !== 'boolean')) bad(`its manifest does not name ${p.path} by its SHA-256, or gives it no name a page can show.`);
    if (p.role === 'review' && !nameOk(p.name)) bad('its manifest gives the review no name a page can show.');
    parts.push(p);
  }
  if (count.record !== 1 || count.review > 1 || count.handback > 1) bad('its manifest does not list one workflow record, with at most one review and one hand-back from Chora.');
  if (m.parts[0].role !== 'record') bad(`its manifest does not list the workflow record (${RECORD}) first.`);
  if (m.left !== undefined && !(Array.isArray(m.left) && m.left.length <= LIMITS.parts && m.left.every((x) => keysAre(x, ['name', 'size', 'sha256', 'why'], [], newer) && nameOk(x.name) && size(x.size) && HEX64.test(x.sha256) && (LEFT_WHY.includes(x.why) || (newer && typeof x.why === 'string')))))
    bad('its manifest lists the files left out of it in a way these tools do not know.');
  return { manifest: { ...m, minor, parts, ...(skipped.length ? { skipped } : {}) }, newer };
}

/** What `hb` is, if it is a hand-back from Chora for workflow `id` (format 1, as Chora's page of before wrote it), else null. */
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
 * each { ref, why: 'left-out' | 'not-kept' | 'too-large' }; `review`: { name, text } of the review open, or null;
 * `handback`: Chora's hand-back for this workflow, or null; `tools`: { version, commit }; `refuse`: the
 * secrets that must not be in it (the WHG token, keys): a part that holds one, the user's own file
 * included, is refused, and the project is not saved (the caller aborts what `write` was given). A part
 * or a project over 4 GiB is refused, as a zip without ZIP64 cannot hold it. Returns { manifest, size }.
 */
export async function writeProject({ record, files = [], left = [], review = null, handback = null, tools, now = new Date(), refuse = [] }, write) {
  if (!record || !Array.isArray(record.steps)) no('There is no workflow to save.');
  const named = refsIn(record), own = new Set(ownIn(record).map((r) => r.sha256));
  const holds = (what) => no(`${what} holds your WHG token or another key, which a project never does, so the project was not saved.`);
  // The JSON parts: each searched as text before it is encoded, so that it is not held again to be searched.
  const small = [];
  const text = exportRecord(record);
  if (secretSearch(refuse).text(text)) holds('The workflow\'s record');
  small.push({ path: RECORD, role: 'record', bytes: enc.encode(text) });
  if (review) {
    if (!nameOk(review.name)) no(`The review open is called "${review.name}", which is not a name a project can keep.`);
    if (review.text.length * 3 > LIMITS.review && enc.encode(review.text).length > LIMITS.review) no(`The review open (${review.name}) is over ${MB(LIMITS.review)}, more than a project holds: save it on its own ("Save the review") and leave the project without it.`);
    if (secretSearch(refuse).text(review.text)) holds(`The review ${review.name}`);
    small.push({ path: REVIEW, role: 'review', name: review.name, bytes: enc.encode(review.text) });
  }
  if (handback) {
    const hb = handbackOf(handback, record.id);
    if (hb) small.push({ path: HANDBACK, role: 'handback', bytes: enc.encode(JSON.stringify(hb)) });
  }
  const seen = new Set();
  const big = [];
  for (const { ref, blob } of files) {
    if (!isRef(ref) || !named.some((r) => r.sha256 === ref.sha256 && r.size === ref.size)) no(`${ref?.name ?? 'A file'} is not one the workflow names, so it is not put in its project.`);
    if (seen.has(ref.sha256)) continue;
    seen.add(ref.sha256);
    if (ref.size > LIMITS.file) no(`${ref.name} is over 4 GiB, more than a project can hold: leave it out, and choose it again where a step needs it.`);
    big.push({ path: `files/${ref.sha256}`, role: 'file', name: nameOk(ref.name) ? ref.name : 'file', own: own.has(ref.sha256), size: ref.size, sha256: ref.sha256, blob });
  }
  const total = small.reduce((n, s) => n + s.bytes.length, 0) + big.reduce((n, b) => n + b.size, 0);
  if (total > ZIP_MAX) no(`The project would be over 4 GiB (${MB(total)}), more than a project can hold: leave your own file out, or clear the files the steps made that are no longer needed.`);
  const parts = [
    ...small.map((s) => ({ path: s.path, role: s.role, size: s.bytes.length, sha256: hex(s.bytes), ...(s.role === 'review' ? { name: s.name } : {}) })),
    ...big.map((b) => ({ path: b.path, role: 'file', size: b.size, sha256: b.sha256, name: b.name, own: b.own })),
  ];
  const leftOut = left.filter((x) => isRef(x.ref) && !seen.has(x.ref.sha256)).map((x) => ({ name: nameOk(x.ref.name) ? x.ref.name : 'file', size: x.ref.size, sha256: x.ref.sha256, why: LEFT_WHY.includes(x.why) ? x.why : 'not-kept' }));
  const at = stepAt(record);
  const { manifest } = checkManifest({
    format: FORMAT, version: VERSION, minor: MINOR,
    tools: { version: String(tools?.version || 'unknown'), commit: SHA1.test(tools?.commit || '') ? tools.commit : null },
    created: new Date(now).toISOString(),
    workflow: { id: record.id, name: nameIn(record), recipe: { key: record.recipe.key, version: record.recipe.version }, at: at ? at.id : null },
    parts, ...(leftOut.length ? { left: leftOut } : {}),
  });

  // The zip, handed on a chunk at a time: fflate's callback is synchronous, so its chunks are queued
  // and written (awaited) after each piece pushed, so that a slow disk holds the reading back.
  const queue = [];
  let failure = null, written = 0;
  const zip = new Zip((err, chunk) => { if (err) failure = err; else queue.push(chunk); });
  const drain = async () => {
    if (failure) throw failure;
    while (queue.length) {
      const c = queue.shift();
      written += c.length;
      if (written > ZIP_MAX) no('The project would be over 4 GiB, more than a project can hold: leave your own file out, and save it again.');
      await write(c);
    }
  };
  const entry = (path, large) => { const f = new ZipDeflate(path, { level: large ? 1 : 6 }); zip.add(f); return f; };
  const { skipped, ...plain } = manifest;
  const m = entry(MANIFEST); m.push(enc.encode(JSON.stringify(plain, null, 2) + '\n'), true); await drain();
  for (const s of small) { const f = entry(s.path); f.push(s.bytes, true); await drain(); }
  for (const b of big) {
    const f = entry(b.path, b.size > (16 << 20));
    const h = new Sha256(), reader = b.blob.stream().getReader(), search = secretSearch(refuse);
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length; h.update(value);
      if (search.push(value)) { try { await reader.cancel(); } catch { /* stopped */ } holds(b.name); }
      f.push(value); await drain();
    }
    if (n !== b.size || h.hex() !== b.sha256) no(`${b.name}, as this browser keeps it, is not the file the workflow recorded (its size or SHA-256 differs), so the project was not saved. Choose the file again, or clear the workflow's files and run its step again.`);
    f.push(new Uint8Array(0), true); await drain();
  }
  zip.end(); await drain();
  return { manifest: plain, size: written };
}

// ---- Reading the zip, by its central directory -------------------------------------------------------
/** A source of bytes read by offset: a File or Blob (the browser), or a Uint8Array (the tests). Node's own is the command line's. */
export function blobSource(blob) {
  if (blob instanceof Uint8Array) return { size: blob.length, read: async (a, b) => blob.subarray(a, b) };
  return { size: blob.size, read: async (a, b) => new Uint8Array(await blob.slice(a, b).arrayBuffer()) };
}
const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const SIG = { local: 0x04034b50, central: 0x02014b50, end: 0x06054b50, end64: 0x06064b50 };
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The entries of the zip in `src`, read from its central directory, each checked against its local
 * header: [{ name, method, csize, size, start }], `start` where its data begins. Refused in words: a
 * file that is not a zip, a zip with no central directory (cut short, or not one), ZIP64, a directory
 * that disagrees with a local header, entries that overlap, encrypted entries, a method other than
 * stored or DEFLATE, and a name that is not UTF-8 or comes twice.
 */
async function entriesOf(src, name) {
  if (!src.size) no('This file is empty: it is not a PLATO tools project.');
  const head = await src.read(0, Math.min(4, src.size));
  if (head.length < 4 || u32(head, 0) !== SIG.local) {
    no(/\.whgproj$/i.test(name) ? 'This is a WHG project (.whgproj). PLATO tools do not open WHG\'s projects: open it in WHG\'s Map your Data. A PLATO tools project ends .platoproj.'
      : `This is not a PLATO tools project (${EXTENSION}): it is not a zip file.`);
  }
  // The end of the central directory: 22 bytes, and a comment of at most 65,535 after it.
  const from = Math.max(0, src.size - 22 - 0xffff), tail = await src.read(from, src.size);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === SIG.end && i + 22 + u16(tail, i + 20) === tail.length) { end = i; break; }
  if (end < 0) no('This project is damaged: it has no central directory (it was cut short, or not written whole), so it is not opened.');
  if (end >= 20 && u32(tail, end - 20) === 0x07064b50) no('This project uses ZIP64 (it is over 4 GiB, or was written so), which PLATO tools projects never do, so it is not opened.');
  const disk = u16(tail, end + 4), cdDisk = u16(tail, end + 6), here = u16(tail, end + 8), count = u16(tail, end + 10);
  const cdSize = u32(tail, end + 12), cdAt = u32(tail, end + 16), endAt = from + end;
  if (disk || cdDisk || here !== count) no('This project is damaged: its zip is split over several files.');
  if (count === 0xffff || cdSize === ZIP_MAX || cdAt === ZIP_MAX) no('This project uses ZIP64, which PLATO tools projects never do, so it is not opened.');
  if (!count) no('This is not a PLATO tools project: its zip holds nothing.');
  if (count > LIMITS.parts + 1) no(`This project is damaged: it holds more than ${LIMITS.parts} parts.`);
  if (cdAt + cdSize !== endAt) no('This project is damaged: its central directory is not where its end says.');
  const cd = await src.read(cdAt, endAt);
  const out = [], names = new Set();
  for (let i = 0, k = 0; k < count; k++) {
    if (i + 46 > cd.length || u32(cd, i) !== SIG.central) no('This project is damaged: its central directory is cut short.');
    const flags = u16(cd, i + 8), method = u16(cd, i + 10), crc = u32(cd, i + 16), csize = u32(cd, i + 20), usize = u32(cd, i + 24);
    const nlen = u16(cd, i + 28), xlen = u16(cd, i + 30), clen = u16(cd, i + 32), local = u32(cd, i + 42);
    if (i + 46 + nlen > cd.length) no('This project is damaged: its central directory is cut short.');
    let entry;
    try { entry = UTF8.decode(cd.subarray(i + 46, i + 46 + nlen)); } catch { no('This project is damaged: a name in it is not UTF-8.'); }
    if (flags & 1) no(`This project is damaged: ${entry.slice(0, 80)} is encrypted.`);
    if (method !== 0 && method !== 8) no(`This project is damaged: ${entry.slice(0, 80)} is compressed in a way these tools do not read (method ${method}).`);
    if (csize === ZIP_MAX || usize === ZIP_MAX || local === ZIP_MAX) no('This project uses ZIP64, which PLATO tools projects never do, so it is not opened.');
    if (names.has(entry)) no(`This project is damaged: it holds ${entry.slice(0, 80)} twice.`);
    names.add(entry);
    out.push({ name: entry, method, flags, crc, csize, size: usize, local });
    i += 46 + nlen + xlen + clen;
  }
  // Each local header agrees with the directory; each entry's data lies before the next, and before the directory.
  const byOffset = [...out].sort((a, b) => a.local - b.local);
  for (const [j, e] of byOffset.entries()) {
    const h = await src.read(e.local, Math.min(e.local + 30, src.size));
    if (h.length < 30 || u32(h, 0) !== SIG.local) no(`This project is damaged: its central directory points ${e.name.slice(0, 80)} at no entry.`);
    const nlen = u16(h, 26), xlen = u16(h, 28), lname = await src.read(e.local + 30, e.local + 30 + nlen);
    let same = false;
    try { same = UTF8.decode(lname) === e.name; } catch { same = false; }
    const lflags = u16(h, 6), lmethod = u16(h, 8);
    const sizesAgree = (lflags & 8) ? true : (u32(h, 14) === e.crc && u32(h, 18) === e.csize && u32(h, 22) === e.size);
    if (!same || lmethod !== e.method || !sizesAgree)
      no(`This project is damaged: its central directory and its entries disagree about ${e.name.slice(0, 80)}, so it is not opened (another program could read it as another project).`);
    e.start = e.local + 30 + nlen + xlen;
    const limit = j + 1 < byOffset.length ? byOffset[j + 1].local : cdAt;
    if (e.start + e.csize > limit) no(`This project is damaged: ${e.name.slice(0, 80)} runs into the entry after it.`);
  }
  if (byOffset[0].local !== 0 || byOffset[0].name !== MANIFEST || out[0].name !== MANIFEST) no(`This is not a PLATO tools project: its first entry is ${JSON.stringify(byOffset[0].name.slice(0, 80))}, not ${MANIFEST}.`);
  return out;
}

/**
 * Stream entry `e` of `src`: its compressed bytes read a slice at a time, inflated, and handed to
 * `onData(chunk)` (awaited); refused when it holds more than `max` bytes. Returns the number of bytes.
 */
async function streamEntry(src, e, max, onData, label) {
  const STEP = 1 << 20;
  let n = 0, failure = null;
  const pending = [];
  const take = (c) => {
    n += c.length;
    if (n > max) failure ||= new ProjectError(`This project is damaged: ${label} is longer than its manifest says.`);
    else if (c.length) pending.push(c);
  };
  const inflate = e.method === 8 ? new Inflate((c) => take(c)) : null;
  for (let at = e.start, stop = e.start + e.csize; at < stop || (at === stop && at === e.start); at += STEP) {
    const c = at < stop ? await src.read(at, Math.min(at + STEP, stop)) : new Uint8Array(0);
    const last = at + STEP >= stop;
    try { if (inflate) inflate.push(c, last); else take(c); } catch (x) { failure ||= new ProjectError(`This project is damaged: ${label} cannot be read (${x?.message || x}).`); }
    if (failure) throw failure;
    while (pending.length) await onData(pending.shift());
    if (last) break;
  }
  return n;
}

/**
 * Read a project from `src` (blobSource(file), or the command line's), checking the manifest before
 * anything else and every part's size and SHA-256 as it streams. `room(bytes)` (awaited) is told the
 * sum of the file parts' sizes before any is written, and may refuse; `sink(part)` is asked for each file
 * part (role 'file'), and may give { write(chunk), close() -> result, abort() } (write and close
 * awaited); without one, its bytes are only checked. A part that fails its check, or a sink that fails,
 * is aborted, never closed. `name` (the file's name) only shapes the words of a refusal.
 * Returns { manifest, newer, record, recordText, review: { name, text, work } | null, handback | null,
 * files: [{ part, result }] }; refused, in words, with a ProjectError, which lists (`fileParts`) every
 * file part the manifest named, for the caller to let go of what it wrote.
 */
export async function readProject(src, { sink = null, room = null, name = '' } = {}) {
  let manifest = null, newer = false, current = null;
  const closed = [];
  try {
    const entries = await entriesOf(src, name);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const me = byName.get(MANIFEST);
    if (me.size > LIMITS.manifest) no(`This project is damaged, or not one: its ${MANIFEST} is over ${MB(LIMITS.manifest)}.`);
    const mbytes = [];
    await streamEntry(src, me, LIMITS.manifest, (c) => { mbytes.push(c); }, MANIFEST);
    let m;
    try { m = JSON.parse(UTF8.decode(concat(mbytes))); } catch { no(`This project is damaged: its ${MANIFEST} is not JSON.`); }
    ({ manifest, newer } = checkManifest(m));
    // The directory and the manifest list the same entries: none left out, none added, each of its size.
    const listed = [...manifest.parts, ...(manifest.skipped || [])];
    for (const e of entries) if (e.name !== MANIFEST && !listed.some((p) => p.path === e.name)) no(`This project holds a file its manifest does not list (${JSON.stringify(e.name.slice(0, 80))}), so it is not opened: a project holds nothing it does not declare.`);
    const missing = listed.filter((p) => !byName.has(p.path));
    if (missing.length) no(`This project is damaged: ${missing.map(label).join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing from it.`);
    for (const p of manifest.parts) if (byName.get(p.path).size !== p.size) no(`This project is damaged: ${label(p)} is not the size its manifest says.`);
    const files = manifest.parts.filter((p) => p.role === 'file');
    if (room) await room(files.reduce((n, p) => n + p.size, 0));
    const small = new Map();
    for (const p of manifest.parts) {
      const h = new Sha256(), keep = p.role !== 'file', bytes = [];
      current = p.role === 'file' && sink ? await sink(p) : null;
      const n = await streamEntry(src, byName.get(p.path), p.size, async (c) => { h.update(c); if (keep) bytes.push(c); else if (current) await current.write(c); }, label(p));
      if (n !== p.size || h.hex() !== p.sha256)
        no(`This project is damaged: ${label(p)} is not the file its manifest names (its ${n !== p.size ? 'size' : 'SHA-256'} differs), so nothing of it was opened. It may have been changed after it was saved, or not copied whole.`);
      if (keep) small.set(p.path, concat(bytes));
      else { const result = current ? await current.close() : null; current = null; closed.push({ part: p, result }); }
    }
    return { manifest, newer, ...checkParts(manifest, small), files: closed };
  } catch (e) {
    if (current) { try { await current.abort?.(); } catch { /* gone */ } current = null; }
    const err = e instanceof ProjectError ? e : new ProjectError(`This project is damaged: ${e?.message || e}.`);
    err.closed = closed;
    err.fileParts = manifest ? manifest.parts.filter((p) => p.role === 'file') : [];
    throw err;
  }
}
const label = (p) => (p.role === 'file' ? `${p.name} (${p.path})` : p.role === 'review' ? `the review ${p.name}` : p.role === 'handback' ? 'Chora\'s hand-back' : p.role === 'record' ? 'the workflow\'s record' : String(p.path).slice(0, 80));
function concat(list) {
  if (list.length === 1) return list[0];
  const out = new Uint8Array(list.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of list) { out.set(c, at); at += c.length; }
  return out;
}

/** The JSON parts, read and checked against the manifest and each other. */
function checkParts(manifest, small) {
  const text = (path) => UTF8.decode(small.get(path));
  let recordText, record;
  try { recordText = text(RECORD); record = importRecord(recordText); } catch (e) { no(`This project's workflow cannot be opened: ${e.message}`); }
  const w = manifest.workflow, at = stepAt(record);
  if (record.id !== w.id || record.recipe.key !== w.recipe.key || record.recipe.version !== w.recipe.version || w.name !== nameIn(record) || w.at !== (at ? at.id : null))
    no('This project is damaged: its manifest and its workflow\'s record do not describe the same workflow (its id, name, recipe or the step it is at differ).');
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

/** What is said of a project of a later minor: opened, and what newer tools added is not read. */
export const newerWords = (m) => `It was saved by newer PLATO tools (PLATO tools ${m.tools.version}, project format ${m.version}.${m.minor}); what they added is not read${m.skipped?.length ? ` (${m.skipped.map((p) => p.path).join(', ')})` : ''}, and is not kept if the project is saved again here.`;

/** The lines `plato-tools project info` prints of a project read: what it is, what it holds, and what it left out. */
export function describe(read) {
  const { manifest: m, record } = read;
  const at = m.workflow.at ? record.steps.find((s) => s.id === m.workflow.at) : null;
  const done = record.steps.filter((s) => s.state === 'done').length, followed = record.steps.filter((s) => s.state !== 'skipped').length;
  const lines = [
    `A PLATO tools project, format version ${m.version}.${m.minor}, saved ${m.created} by PLATO tools ${m.tools.version}${m.tools.commit ? ` (${m.tools.commit.slice(0, 12)})` : ''}.`,
    ...(read.newer ? [newerWords(m)] : []),
    `Workflow: "${m.workflow.name}", following ${m.workflow.recipe.key} (version ${m.workflow.recipe.version}); ${done} of ${followed} steps done${at ? `, at "${at.title}"` : ', every step done'}.`,
    `Scope: ${record.scope ? 'kept with the workflow' : 'none'}.`,
    'Parts (each size and SHA-256 checked):',
    ...m.parts.map((p) => `  ${p.path.padEnd(72)} ${String(p.size).padStart(12)} bytes  ${p.role}${p.role === 'file' ? `: ${p.name}${p.own ? ' (the file the workflow began with)' : ''}` : p.role === 'review' ? `: ${p.name}` : ''}`),
  ];
  if (m.skipped?.length) lines.push('Optional parts these tools do not read:', ...m.skipped.map((p) => `  ${p.path} (${p.role})`));
  if (m.left?.length) lines.push('Named by the workflow but not in the project:', ...m.left.map((x) => `  ${x.name} (${x.size} bytes): ${x.why === 'left-out' ? 'left out when it was saved' : x.why === 'not-kept' ? 'not kept in the browser it was saved from' : x.why === 'too-large' ? 'left out to fit WHG\'s Workbench' : x.why}`));
  return lines;
}
