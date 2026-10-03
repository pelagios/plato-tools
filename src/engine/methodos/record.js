// Methodos: the workflow's record, and resuming from it (docs/plans/methodos.md, sections 7 and 12,
// decision 3). A record is the runner's state with a name and its times: { id, name, created, saved,
// ...state }. It holds references to files, by name, size and SHA-256, never the files: the files stay
// the user's, and on resume the ones chosen are checked against the references (Krisis's filesDiffer).
// Pure, as the runner is: keeping a record in the browser is src/methodos/store.js's.
//
// The version rule. A record names the recipe it followed by key, version and digest. On resume:
//   the digest is the same            it continues;
//   only the words changed            (same version, and the recipe now gives the same steps, each with
//                                     the same operation, inputs, options and whether it runs) it
//                                     continues, and says the recipe's words changed;
//   anything else                     it is never continued blindly: it stays at its last finished
//                                     step, says the workflow has changed since, and offers to start
//                                     the remaining steps under the new recipe or to leave it as it is.
// The same rule as Hermes's text work file, which never mixes results of two prompts.
import { canonical, digest } from './recipe.js';
import { refsDiffer } from './handoffs.js';
import { deserialise, fail, serialise, start } from './runner.js';

export class RecordError extends Error {
  constructor(message) { super(message); this.name = 'RecordError'; }
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const newId = () => globalThis.crypto?.randomUUID?.() ?? `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** A record of `state`: its id and name kept if it has them, `name` and a new id if not, and the time saved. */
export function recordOf(state, { name, now = new Date() } = {}) {
  const at = new Date(now).toISOString();
  const title = typeof state.name === 'string' && state.name ? state.name : (name || state.recipe.key);
  return { ...clone(state), id: typeof state.id === 'string' && state.id ? state.id : newId(), name: title, created: state.created || at, saved: at };
}

/** Whether a state is at a step boundary, where it is saved: anything but a step running. */
export const atBoundary = (state) => state.status !== 'running';

/** The record's file name to download: its name, made safe, and .workflow.json. */
export function fileName(record) {
  const base = String(record.name || 'workflow').normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'workflow';
  return `${base}.workflow.json`;
}

/** The record as the text of a .workflow.json. */
export const exportRecord = (record) => serialise(record);

/**
 * A record from the text of a .workflow.json, refused in words if it is not one. One without an id or
 * a name (written by hand, say) is given them.
 */
export function importRecord(text) {
  let s;
  try { s = deserialise(text); } catch (e) { throw new RecordError(e.message); }
  if (s.id !== undefined && (typeof s.id !== 'string' || !s.id)) throw new RecordError('This workflow record is damaged: its id is not text.');
  return recordOf(s, { now: s.saved && !Number.isNaN(Date.parse(s.saved)) ? s.saved : new Date() });
}

// What of a step decides what it does: everything but its words.
const shape = (s) => canonical({ id: s.id, op: s.op, from: s.from, options: s.options, skipped: s.state === 'skipped' });

/** A record found mid-step (the page closed while a step ran) is at a failed step, to run again. */
function settle(state) {
  if (state.status !== 'running') return state;
  return fail(state, state.current, 'The page was closed while this step was running, so it did not finish: run it again.');
}

/**
 * What to do with `record` under `recipe` (the one these tools ship now under its key, or undefined):
 *   { action: 'continue', state, words }        carry on from `state` (words: '' or what changed);
 *   { action: 'changed', lastDone, words }      the recipe has changed: offer restartRemaining() or leave it;
 *   { action: 'refuse', words }                 these tools have no such recipe.
 * The record is not changed.
 */
export function reconcile(record, recipe) {
  const was = record.recipe;
  if (!recipe || recipe.key !== was.key)
    return { action: 'refuse', words: `This workflow followed the recipe "${was.key}", which these tools do not have, so it cannot be resumed here.` };
  const now = digest(recipe);
  if (now === was.digest) return { action: 'continue', state: settle(clone(record)), words: '' };
  let fresh = null;
  if (recipe.version === was.version) { try { fresh = start(recipe, record.answers, record.files); } catch { fresh = null; } }
  if (fresh && fresh.steps.length === record.steps.length && fresh.steps.every((s, i) => shape(s) === shape(record.steps[i]))) {
    const state = clone(record);
    state.recipe = { key: recipe.key, version: recipe.version, digest: now };
    state.steps.forEach((s, i) => { s.title = fresh.steps[i].title; });
    return { action: 'continue', state: settle(state), words: `The words of "${recipe.title}" have changed since this workflow was saved; its steps have not, so it carries on.` };
  }
  const done = record.steps.filter((s) => s.state === 'done');
  const last = done.length ? done[done.length - 1] : null;
  return {
    action: 'changed',
    lastDone: last ? last.id : null,
    words: `"${recipe.title}" has changed since this workflow was saved (version ${was.version} then, ${recipe.version} now), so it is not carried on as it was. `
      + `${last ? `It stays at its last finished step, "${last.title}".` : 'No step of it had finished.'} You can start the remaining steps under the new recipe, or leave the workflow as it is.`,
  };
}

/**
 * The workflow under the new `recipe`: the record's answers and files, and its finished steps kept for
 * as long as the new recipe begins with the same steps (same id, operation, inputs and options) done in
 * the record; from the first that differs, every step is to do. Refused in words if the new recipe
 * cannot take the record's answers or files.
 */
export function restartRemaining(record, recipe) {
  let fresh;
  try { fresh = start(recipe, record.answers, record.files); } catch (e) {
    throw new RecordError(`This workflow's answers or files do not fit the new "${recipe.title}" (${e.message}), so it has to be started afresh.`);
  }
  const old = new Map(record.steps.map((s) => [s.id, s]));
  for (const s of fresh.steps) {
    const o = old.get(s.id);
    if (!o || shape(o) !== shape(s)) break;
    if (s.state === 'skipped') continue;
    if (o.state !== 'done') break;
    s.state = 'done';
    s.outputs = clone(o.outputs);
  }
  return { ...fresh, id: record.id, name: record.name, created: record.created, saved: record.saved };
}

/**
 * Refuse, in words, files that are not the ones `refs` name (by size and SHA-256), with what differs;
 * `what` names them ('the dataset this workflow was begun with').
 */
export async function checkFiles(refs, files, what = 'the files this workflow was begun with') {
  const differ = await refsDiffer(refs, [...(files || [])]);
  if (differ.length) throw new RecordError(`These are not ${what}: ${differ.join(', ')} ${differ.length === 1 ? 'differs' : 'differ'}. Choose ${refs.map((r) => r.name).join(', ')} as they were.`);
  return true;
}

/** Check every file chosen at the start: `files` maps each of the recipe's file keys to the files chosen again. */
export async function checkChosen(record, files) {
  for (const [k, refs] of Object.entries(record.files || {})) await checkFiles(refs, files?.[k], `the files this workflow was begun with ("${k}")`);
  return true;
}
