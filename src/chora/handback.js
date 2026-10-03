// Chora's way back into a Methodos workflow (docs/plans/methodos.md, section 5.3, stage 6). The main
// page opens chora.html#workflow=<id> for a workflow's step "Draw or trace the places on a map"; when
// the user saves the dataset here, this page keeps a HAND-BACK in the same IndexedDB store as the
// hand-off (handoff.js), under its own key, 'chora-handback', and offers a link back to the main page,
// ./#workflow=<id>, where the workflow goes on from that step.
//
// The record is the hand-off's shape, `{ files, at }`, with the workflow's id and a format number:
//   { handback: 1, workflow: '<id>', files: [{ type: 'dataset', name, size, sha256 }], at }
// and `files` holds REFERENCES, never the bytes: a Methodos hand-off, made and checked by Methodos
// itself (refsOf, isRef and checkHandoff in src/engine/methodos/handoffs.js). refsOf hashes the file
// as a stream (Krisis's fileRecords), so a saved dataset of any size is never in memory whole. The
// main page completes the step "place" with runner.complete(state, stepId, { dataset: record.files })
// once the user has chosen the saved file again and refsDiffer(record.files, [file]) is empty
// (DEVELOPERS.md, "Chora's way back").
//
// Any page of the site's origin can write this store (DEVELOPERS.md, "The shared origin"), so what is
// read is checked again (check(): the format, the workflow it is for, the reference's shape, the age),
// a record never acts on its own (the main page offers it, and a click takes it), and it is usable for
// as long as the hand-off is (FRESH, two minutes): it is written when the file is saved and written
// again when the way back is taken, so the two minutes are the navigation's, as the hand-off's are.
import { tx, isFresh } from './handoff.js';
import { isRef, refsOf, checkHandoff } from '../engine/methodos/handoffs.js';

export const KEY = 'chora-handback';
export const FORMAT = 1;
/** The type of the one reference handed back: Methodos's 'dataset', "a file of places the tools wrote". */
export const TYPE = 'dataset';
/** A workflow's id as an address may carry it: letters, digits, '-' and '_', at most 64, so that it is safe in an address and in the page. */
const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Beyond Methodos's own check, a name the main page can show as it is: no path, no control characters,
// none of the invisible characters that make a name read as another (zero-width spaces and marks,
// U+200B-U+200F; bidirectional embeddings and overrides, U+202A-U+202E; isolates, U+2066-U+2069; the
// byte-order mark, U+FEFF), at most 255, something other than white space, and not "." or "..".
const NAME_CHARS = /^[^/\\\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]{1,255}$/;
const nameOk = (n) => typeof n === 'string' && NAME_CHARS.test(n) && /\S/.test(n) && n !== '.' && n !== '..';

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

/** Whether `r` is one reference to a dataset, as Methodos's isRef takes it and with no other key, its name one the page can show. */
export const isDatasetRef = (r) => isRef(r) && r.type === TYPE && Object.keys(r).length === 4 && nameOk(r.name);

/** The reference to `file` (a File, or a Blob with a name), made by Methodos's refsOf: its size, and the SHA-256 of its bytes read as a stream. */
export async function refOf(file) {
  const [ref] = await refsOf([file], TYPE);
  if (!isDatasetRef(ref)) throw new Error(`${file.name} cannot be handed back: its name is not one the main page can show.`);
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
  try { checkHandoff(v.files, [TYPE], 'the step "place"'); } catch { return null; }
  return record(workflow, v.files[0], v.at);
}

/** Keep the hand-back of `ref` for workflow `id`. The record kept, or null if the browser refused to keep it (a private window, say). */
export async function give(id, ref) {
  const r = record(id, ref);
  try { await tx('readwrite', (s) => s.put(r, KEY)); return r; } catch { return null; }
}

/**
 * For the main page: the hand-back for `workflow`, checked, or null; taken, so that it is used once.
 * Whatever is there goes, used or refused. Call it only on the user's click. Read and deleted in one
 * transaction, so that a hand-back written meanwhile is never the one deleted.
 */
export async function take(workflow) {
  let v;
  try {
    v = await tx('readwrite', (s) => {
      const r = s.get(KEY);
      r.onsuccess = () => { if (r.result !== undefined) s.delete(KEY); };
      return r;
    });
  } catch { return null; }
  return check(v, workflow);
}

/** Let a hand-back go that is no longer fresh; a fresh one is kept. True if one went. Read, judged and deleted in one transaction. */
export async function dropStale(now = Date.now()) {
  let went = false;
  try {
    await tx('readwrite', (s) => {
      const r = s.get(KEY);
      r.onsuccess = () => { if (r.result !== undefined && !isFresh(r.result, now)) { s.delete(KEY); went = true; } };
      return r;
    });
  } catch { return false; }
  return went;
}
