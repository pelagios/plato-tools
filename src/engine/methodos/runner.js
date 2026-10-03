// Methodos: the runner. Pure: no page, no storage, no engine call. A workflow's state is plain JSON;
// each function below is a transition, takes a state and returns a new one (the old is not changed),
// and throws, in words, when it does not apply. The transitions are the only way a state changes.
//
// The workflow's status:
//   idle       between steps: nothing is running, and next() takes the next step;
//   running    an automatic step is running;
//   waiting    waiting for the user: an interactive step, or a permission not yet given;
//   stopped    a data problem: the step's report says what to put right, and which step to run again;
//   failed     an execution failure: a fault in the tools, kept so that the step can be tried again;
//   cancelled  the user stopped the step that was running or waiting;
//   completed  every step is done or skipped.
// The three ways of stopping (waiting, stopped, failed) are kept apart, in the status and in the step.
import { OPERATIONS } from './operations.js';
import { checkHandoff, isRef } from './handoffs.js';
import { alternatives, applies, check, digest } from './recipe.js';

export const FORMAT = 1;
export const STATUSES = ['idle', 'running', 'waiting', 'stopped', 'failed', 'cancelled', 'completed'];
export const STEP_STATES = ['pending', 'skipped', 'running', 'waiting', 'stopped', 'failed', 'cancelled', 'done'];

export class TransitionError extends Error {
  constructor(message) { super(message); this.name = 'TransitionError'; }
}
const no = (s) => { throw new TransitionError(s); };

const clone = (state) => JSON.parse(JSON.stringify(state));
const stepOf = (state, id) => state.steps.find((s) => s.id === id) || no(`The workflow has no step "${id}".`);
const titleOf = (s) => `"${s.title}"`;

/**
 * Begin a workflow: the recipe, the answers to its questions, and the files chosen, as references
 * ({ files: [{ type, name, size, sha256 }] }). Refuses, before anything runs, answers it does not
 * ask or that are missing, files of the wrong type, and a step that would run an operation that is
 * not available yet.
 */
export function start(recipe, answers = {}, files = {}) {
  check(recipe);
  const asks = recipe.asks || {};
  for (const k of Object.keys(answers)) if (!Object.hasOwn(asks, k)) no(`"${recipe.title}" does not ask "${k}".`);
  for (const [k, q] of Object.entries(asks)) {
    const a = answers[k];
    if (a === undefined) { if (!q.optional) no(`"${recipe.title}" needs an answer to: ${q.question}`); continue; }
    const fits = q.kind === 'yes-no' ? typeof a === 'boolean' : q.kind === 'list' ? Array.isArray(a) && a.every((x) => typeof x === 'string')
      : q.kind === 'choice' ? q.choices.includes(a) : typeof a === 'string';
    if (!fits) no(`The answer to "${q.question}" is not ${q.kind === 'yes-no' ? 'yes or no' : q.kind === 'list' ? 'a list of words' : q.kind === 'choice' ? `one of ${q.choices.join(', ')}` : 'words'}.`);
  }
  const chosen = {};
  for (const [k, f] of Object.entries(recipe.files || {})) {
    if (files[k] === undefined) { if (!f.optional) no(`"${recipe.title}" needs ${f.words.toLowerCase()}.`); continue; }
    chosen[k] = checkHandoff(files[k], f.types, `"${recipe.title}" (${f.words.toLowerCase()})`).map((r) => ({ ...r }));
  }
  for (const k of Object.keys(files)) if (!Object.hasOwn(recipe.files || {}, k)) no(`"${recipe.title}" does not take files called "${k}".`);
  const steps = recipe.steps.map((s) => {
    const runs = applies(s, answers);
    const op = OPERATIONS[s.op];
    if (runs && op.available !== true) no(`The step "${s.title || op.title}" is not available yet. ${op.available}`);
    const options = {};
    for (const [k, v] of Object.entries(s.options || {})) {
      const val = typeof v === 'string' && v.startsWith('$') ? answers[v.slice(1)] : v;
      if (val !== undefined) options[k] = val;
    }
    return { id: s.id, op: s.op, title: s.title || op.title, from: { ...(s.from || {}) }, options, state: runs ? 'pending' : 'skipped' };
  });
  return { methodos: FORMAT, recipe: { key: recipe.key, version: recipe.version, digest: digest(recipe) }, answers: clone(answers), files: chosen, status: 'idle', current: null, steps };
}

/** The references each input of a step resolves to, from the files chosen and the steps done; an input from a skipped step is left out. */
export function inputsOf(state, stepId) {
  const s = stepOf(state, stepId);
  const op = OPERATIONS[s.op];
  const inputs = {};
  for (const [slot, ref] of Object.entries(s.from)) {
    let got;
    for (const a of alternatives(ref)) {
      if (a.startsWith('$')) { got = state.files[a.slice(1)]; if (got) break; continue; }
      const [id, out] = a.split('.');
      const p = stepOf(state, id);
      if (p.state === 'done') { got = p.outputs[out]; break; }
      if (p.state !== 'skipped') no(`The step ${titleOf(s)} takes "${slot}" from ${titleOf(p)}, which is not done.`);
    }
    if (got === undefined) { if (!op.takes[slot].optional) no(`The step ${titleOf(s)} has nothing for "${slot}": every step it could take it from was skipped.`); continue; }
    inputs[slot] = checkHandoff(got, op.takes[slot].types, `"${slot}" of the step ${titleOf(s)}`);
  }
  return inputs;
}

/**
 * Take the next step: the first one pending, its inputs checked. An automatic step is then running;
 * an interactive one is waiting for the user, saying for what. With no step left, the workflow is
 * completed.
 */
export function next(state) {
  if (state.status !== 'idle') no(`The next step is taken only between steps, and the workflow is ${state.status}.`);
  const out = clone(state);
  const s = out.steps.find((x) => x.state === 'pending');
  if (!s) { out.status = 'completed'; return out; }
  inputsOf(out, s.id);
  const op = OPERATIONS[s.op];
  out.current = s.id;
  if (op.kind === 'interactive') { s.state = 'waiting'; s.why = `Waiting for ${op.waitsFor}.`; out.status = 'waiting'; }
  else { s.state = 'running'; out.status = 'running'; }
  return out;
}

/** The step the workflow is at, which must be `stepId` and in one of `states`. */
function current(out, stepId, states, doing) {
  const s = stepOf(out, stepId);
  if (out.current !== stepId || !states.includes(s.state)) no(`The step ${titleOf(s)} cannot be ${doing}: it is ${s.state}${out.current && out.current !== stepId ? `, and the workflow is at ${titleOf(stepOf(out, out.current))}` : ''}.`);
  return s;
}
const clean = (s) => { for (const k of ['why', 'problem', 'error', 'partial', 'discarded', 'progress']) delete s[k]; };

/** The outputs given exactly as the operation declares them: each one, of its type. */
function checkOutputs(s, outputs) {
  const op = OPERATIONS[s.op];
  const given = outputs || {};
  for (const k of Object.keys(given)) if (!Object.hasOwn(op.gives, k)) no(`${op.title} gives no "${k}", so the step ${titleOf(s)} cannot be done with it.`);
  const kept = {};
  for (const [k, type] of Object.entries(op.gives)) kept[k] = checkHandoff(given[k], [type], `the output "${k}" of the step ${titleOf(s)}`).map((r) => ({ ...r }));
  return kept;
}

/** The step is done, with its outputs (references, of the types its operation gives). */
export function complete(state, stepId, outputs) {
  const out = clone(state);
  const s = current(out, stepId, ['running', 'waiting'], 'done');
  if (s.state === 'waiting' && OPERATIONS[s.op].kind !== 'interactive') no(`The step ${titleOf(s)} is waiting to run, not done: it is resumed, and it is done when it has run.`);
  s.outputs = checkOutputs(s, outputs);
  clean(s);
  s.state = 'done';
  out.current = null; out.status = 'idle';
  return out;
}

/** The running step waits for the user (a permission not yet given), saying for what. */
export function waiting(state, stepId, why) {
  const out = clone(state);
  const s = current(out, stepId, ['running'], 'made to wait');
  if (typeof why !== 'string' || !why.trim()) no(`The step ${titleOf(s)} cannot wait without saying for what.`);
  s.state = 'waiting'; s.why = why; out.status = 'waiting';
  return out;
}

/** An automatic step that was waiting (for a permission) runs again. */
export function resume(state, stepId) {
  const out = clone(state);
  const s = current(out, stepId, ['waiting'], 'resumed');
  if (OPERATIONS[s.op].kind === 'interactive') no(`The step ${titleOf(s)} is done by you, not run: it is finished when its result is given.`);
  delete s.why;
  s.state = 'running'; out.status = 'running';
  return out;
}

/**
 * A data problem: the step found something in the data to put right. `problem` is { words, errors? }:
 * what to put right, in a line or two, and how many errors the report counts. The report itself is
 * not kept in the state. Which step to run again is said: this one.
 */
export function stop(state, stepId, problem) {
  const out = clone(state);
  const s = current(out, stepId, ['running'], 'stopped for a problem in the data');
  if (!problem || typeof problem.words !== 'string' || !problem.words.trim()) no(`The step ${titleOf(s)} cannot stop without saying what to put right.`);
  s.state = 'stopped';
  s.problem = { words: problem.words, ...(Number.isSafeInteger(problem.errors) ? { errors: problem.errors } : {}), rerun: s.id };
  out.current = null; out.status = 'stopped';
  return out;
}

/** An execution failure: a fault in the tools, not in the data. The workflow is kept, to try again. */
export function fail(state, stepId, error) {
  const out = clone(state);
  const s = current(out, stepId, ['running', 'waiting'], 'failed');
  s.state = 'failed';
  s.error = String(error && (error.message || error) || 'The step failed.').split('\n')[0];
  delete s.why;
  out.current = null; out.status = 'failed';
  return out;
}

/**
 * The user stops the step that is running or waiting. What it had done (`partial`, references of the
 * types it gives) is kept only if its operation keeps partial results; otherwise their names are
 * listed in `discarded`, for the page to remove, as a stopped conversion's half-written file is.
 */
export function cancel(state, stepId, partial) {
  const out = clone(state);
  const s = current(out, stepId, ['running', 'waiting'], 'cancelled');
  const op = OPERATIONS[s.op];
  delete s.why;
  s.state = 'cancelled';
  if (partial && Object.keys(partial).length) {
    if (op.cancel === 'keeps-partial') s.partial = checkOutputs(s, partial);
    else s.discarded = Object.values(partial).flat().filter(isRef).map((r) => r.name);
  }
  out.current = null; out.status = 'cancelled';
  return out;
}

/** The engine's own counts for the step under way ({ reviewed: 124, total: 310 }); never a percentage it did not measure. */
export function progress(state, stepId, counts) {
  const out = clone(state);
  const s = current(out, stepId, ['running', 'waiting'], 'given progress');
  if (!counts || !Object.values(counts).every(Number.isSafeInteger)) no(`Progress is counted in whole numbers the tools measured.`);
  s.progress = { ...counts };
  return out;
}

/**
 * Do a step again: it, and every step that took its outputs (and so on, down), go back to pending,
 * as WHG resets the levels below a changed parent; so does a step that stopped, failed or was
 * cancelled, which has to be done again in any case. What a cancelled step kept is kept for the page
 * to begin from only when that step is the one done again: below it, it was made from what is now
 * reset. Not while a step is running, nor while another is waiting.
 */
export function invalidate(state, stepId) {
  const out = clone(state);
  const s = stepOf(out, stepId);
  if (s.state === 'pending' || s.state === 'skipped') no(`The step ${titleOf(s)} is ${s.state}: there is nothing to do again.`);
  const cur = out.current ? stepOf(out, out.current) : null;
  if (cur && (cur.state === 'running' || cur.id !== stepId)) no(`The step ${titleOf(s)} cannot be done again while ${titleOf(cur)} is ${cur.state}.`);
  const reset = new Set([stepId]);
  for (const x of out.steps) {
    if (['stopped', 'failed', 'cancelled'].includes(x.state)) reset.add(x.id);
    if (Object.values(x.from).some((ref) => alternatives(ref).some((a) => reset.has(a.split('.')[0])))) reset.add(x.id);
  }
  for (const x of out.steps) {
    if (!reset.has(x.id) || x.state === 'skipped') continue;
    const partial = x.id === stepId && x.state === 'cancelled' ? x.partial : undefined;
    clean(x); delete x.outputs;
    if (partial) x.partial = partial;
    x.state = 'pending';
  }
  out.current = null; out.status = 'idle';
  return out;
}

/** The state as text, to keep or to download. */
export const serialise = (state) => JSON.stringify(state);

/** A state from text, refused in words if it is not one. */
export function deserialise(text) {
  let s;
  try { s = JSON.parse(text); } catch { no('This is not a workflow record: it is not JSON.'); }
  if (!s || s.methodos !== FORMAT) no(`This is not a workflow record of a version these tools read (${FORMAT}).`);
  if (!STATUSES.includes(s.status) || !Array.isArray(s.steps) || !s.recipe || typeof s.recipe.digest !== 'string') no('This workflow record is damaged: it has no status, steps or recipe.');
  const refsOk = (refs) => Array.isArray(refs) && refs.every(isRef);
  for (const x of s.steps) {
    if (!x || !STEP_STATES.includes(x.state) || !OPERATIONS[x.op] || !x.from || typeof x.from !== 'object') no(`This workflow record is damaged: the step "${x?.id}" is not one the tools know.`);
    for (const refs of Object.values({ ...x.outputs, ...x.partial })) if (!refsOk(refs)) no(`This workflow record is damaged: an output of the step "${x.id}" is not a reference to a file.`);
  }
  for (const refs of Object.values(s.files || {})) if (!refsOk(refs)) no('This workflow record is damaged: a file chosen is not a reference to a file.');
  const cur = s.current === null ? null : s.steps.find((x) => x.id === s.current);
  if (s.current !== null && !(cur && ['running', 'waiting'].includes(cur.state))) no('This workflow record is damaged: the step it is at is not running or waiting.');
  return s;
}
