// Chora's way back into a Methodos workflow (docs/plans/methodos.md, section 5.3, stage 6). The main
// page opens chora.html#workflow=<id> for a workflow's step "Draw or trace the places on a map"; when
// the user saves the dataset here, this page keeps a HAND-BACK in the same IndexedDB store as the
// hand-off (handoff.js), under its own key, 'chora-handback', and offers a link back to the main page,
// ./#workflow=<id>, where the workflow goes on from that step.
//
// The record is the hand-off's shape, `{ files, at }`, with the workflow's id and a format number:
//   { handback: 1, workflow: '<id>', files: [{ type: 'dataset', name, size, sha256 }], at }
// and `files` holds REFERENCES, never the bytes: a Methodos hand-off is a list of references to files
// (src/engine/methodos/handoffs.js, isRef and checkHandoff, on the branch methodos-engine), each
// { type, name, size, sha256 } with sha256 64 lower-case hexadecimal digits over the file's bytes,
// as Krisis's work file records its inputs (fileRecords in src/engine/krisis/work.js). The reference
// here MUST stay that shape: test/chora-handback.test.js pins it, and checks it against the Methodos
// module itself where that module is present. The main page completes the step with
// runner.complete(state, stepId, { dataset: record.files }) once the user has chosen the saved file
// again and refsDiffer(record.files, [file]) is empty (DEVELOPERS.md, "Chora's way back").
//
// Any page of the site's origin can write this store (DEVELOPERS.md, "The shared origin"), so what is
// read is checked again (check(): the format, the workflow it is for, the reference's shape, the age),
// a record never acts on its own (the main page offers it, and a click takes it), and it is usable for
// as long as the hand-off is (FRESH, two minutes): it is written when the file is saved and written
// again when the way back is taken, so the two minutes are the navigation's, as the hand-off's are.
import { tx, isFresh } from './handoff.js';

export const KEY = 'chora-handback';
export const FORMAT = 1;
/** The type of the one reference handed back: Methodos's 'dataset', "a file of places the tools wrote". */
export const TYPE = 'dataset';
/** A workflow's id as an address may carry it: letters, digits, '-' and '_', at most 64, so that it is safe in an address and in the page. */
const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
// A file's name as the page will show it: no path, no control characters, not empty, not absurdly long.
const NAME = /^[^/\\\u0000-\u001f\u007f]{1,255}$/;

export const isWorkflowId = (id) => typeof id === 'string' && WORKFLOW_ID.test(id);

/**
 * The workflow this page was opened for, from its address's fragment ('#workflow=<id>'): `null` when
 * the address names none, `{ id }` when it names one, `{ refused: true }` when what it names is not an
 * id (it is then neither used nor shown).
 */
export function workflowOf(hash) {
  let raw;
  try { raw = new URLSearchParams(String(hash || '').replace(/^#/, '')).get('workflow'); } catch { return { refused: true }; }
  if (raw === null) return null;
  return isWorkflowId(raw) ? { id: raw } : { refused: true };
}

/** The main page's address for the workflow: `./#workflow=<id>` beside this page. */
export function backTo(id, here) {
  if (!isWorkflowId(id)) throw new Error('Not a workflow id.');
  const u = new URL('./', here);
  u.search = ''; u.hash = `workflow=${id}`;
  return u.href;
}

/** The SHA-256 of `bytes` (an ArrayBuffer or a view), by the browser's own SubtleCrypto, in lower-case hexadecimal. */
export async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Whether `r` is one reference to a dataset as Methodos's isRef takes it, its name one the page can show. */
export const isDatasetRef = (r) => !!r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === 4
  && r.type === TYPE && typeof r.name === 'string' && NAME.test(r.name)
  && Number.isSafeInteger(r.size) && r.size >= 0 && typeof r.sha256 === 'string' && HEX64.test(r.sha256);

/** The reference to `file` (a File, or a Blob with a name): its bytes read once, the size and the hash both of those bytes. */
export async function refOf(file, name = file.name) {
  const bytes = await file.arrayBuffer();
  const ref = { type: TYPE, name, size: bytes.byteLength, sha256: await sha256Hex(bytes) };
  if (!isDatasetRef(ref)) throw new Error(`${name} cannot be handed back: its name is not one the main page can show.`);
  return ref;
}

/** The record for workflow `id` handing back `ref`, made at `at`. */
export function record(id, ref, at = Date.now()) {
  if (!isWorkflowId(id)) throw new Error('Not a workflow id.');
  if (!isDatasetRef(ref)) throw new Error('Not a reference to a dataset.');
  return { handback: FORMAT, workflow: id, files: [{ type: ref.type, name: ref.name, size: ref.size, sha256: ref.sha256 }], at };
}

/**
 * What was read, if it is a hand-back for `workflow` recent enough to use, rebuilt from its checked
 * fields alone; otherwise null. Refused: anything not an object of exactly the record's keys, another
 * format (an older or a later page's), another workflow's, one not FRESH (or from the future), one
 * whose `files` is not exactly one reference to a dataset (a hand-off's File objects are not).
 */
export function check(v, workflow, now = Date.now()) {
  if (!isWorkflowId(workflow)) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (Object.keys(v).sort().join() !== 'at,files,handback,workflow') return null;
  if (v.handback !== FORMAT || v.workflow !== workflow || !isFresh(v, now)) return null;
  if (!Array.isArray(v.files) || v.files.length !== 1 || !isDatasetRef(v.files[0])) return null;
  return record(workflow, v.files[0], v.at);
}

/** Keep the hand-back of `ref` for workflow `id`. The record kept, or null if the browser refused to keep it (a private window, say). */
export async function give(id, ref) {
  const r = record(id, ref);
  try { await tx('readwrite', (s) => s.put(r, KEY)); return r; } catch { return null; }
}

/**
 * For the main page: the hand-back for `workflow`, checked, or null; taken, so that it is used once.
 * Whatever is there goes, used or refused. Call it only on the user's click.
 */
export async function take(workflow) {
  let v;
  try { v = await tx('readonly', (s) => s.get(KEY)); } catch { return null; }
  if (v !== undefined) { try { await tx('readwrite', (s) => s.delete(KEY)); } catch {} }
  return check(v, workflow);
}

/** Let a hand-back go that is no longer fresh; a fresh one is kept. True if one went. */
export async function dropStale(now = Date.now()) {
  let v;
  try { v = await tx('readonly', (s) => s.get(KEY)); } catch { return false; }
  if (v === undefined || isFresh(v, now)) return false;
  try { await tx('readwrite', (s) => s.delete(KEY)); } catch { return false; }
  return true;
}
