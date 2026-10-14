// Methodos's seams with the page (Stephen, 12 October 2026, Issue #33 point 5): what a workflow keeps
// in this browser, and which of its files is the one to choose again when the page starts again (after
// a reload, or a project opened). Pure, so that the tests read it without a page.
import * as runner from '../engine/methodos/runner.js';
import { fmtBytes } from '../engine/words.js';

// The input of each automatic operation that the page's run takes from the files chosen in step 1 (as
// page.js's MAIN, which judges whether a run is the step's): the file to choose again for that step.
const MAIN = { check: 'files', convert: 'files', compare: 'later', 'publish.report': 'dataset', 'publish.mint': 'dataset', 'publish.site': 'dataset',
  'publish.w3id': 'dataset', match: 'subjects', lookup: 'subjects', apply: 'subjects', 'relate.containment': 'subjects' };
// And of the interactive steps whose work is on a file shown in step 1: the table whose columns are
// matched, and the dataset drawn on in Chora (chosen again, so that Chora shows it).
const SHOWN = { 'read.columns': 'files', place: 'dataset' };

/** The step a workflow's state is at: the one running or waiting, else the one that stopped, failed or was cancelled, else the next to do; null when it is completed. */
export function stepAt(state) {
  if (!state || state.status === 'completed' || !Array.isArray(state.steps)) return null;
  if (state.current) return state.steps.find((s) => s.id === state.current) || null;
  return state.steps.find((s) => ['stopped', 'failed', 'cancelled'].includes(s.state)) || state.steps.find((s) => s.state === 'pending') || null;
}

/**
 * The references of the file(s) step `s` works on, to be chosen in step 1 when the page starts again: its
 * main input, or the file an interactive step shows. Null when it has none (a review, whose work file
 * is not chosen in step 1), or when an earlier step it takes from is not done.
 */
export function currentInput(state, s = stepAt(state)) {
  const slot = s && (MAIN[s.op] || SHOWN[s.op]);
  if (!slot) return null;
  try { return runner.inputsOf(state, s.id)[slot] || null; } catch { return null; }
}

/** The files the workflow began with (step 1's, the user's own), as references. */
export const startFiles = (state) => (state?.files ? Object.values(state.files).flat() : []);
/**
 * The notes of the user's own files that could not be kept in this browser (each { name, sha256, why }), once
 * `refs` have been tried again with the results `missed`: theirs replaced, every other file's note kept, so
 * that keeping the other dataset at the match does not clear what was said of the table.
 */
export const notKept = (notes, refs, missed) => [...(notes || []).filter((m) => !refs.some((r) => r.sha256 === m.sha256)), ...missed];
/** Every file the workflow's steps made, as references. */
export const madeBy = (state) => (state?.steps ? state.steps.flatMap((x) => [...Object.values(x.outputs || {}), ...Object.values(x.partial || {})].flat()) : []);
/** Everything a workflow keeps in this browser: the user's own files it began with, and what its steps made. Let go together. */
export const keptBy = (state) => [...startFiles(state), ...madeBy(state)];

/**
 * What the tracker says is kept, from what the outputs folder holds (`files`, each { sha256, size })
 * and the workflow's own files (`own`, references): the user's file(s) and the files the steps made,
 * with their size; or, with working data not kept (`keeping` false), that nothing of theirs is. An
 * empty string when nothing is kept and nothing needs saying.
 */
export function keptWords({ files = [], own = [], keeping = true, workflow = true, missed = [] } = {}) {
  if (!keeping) return workflow ? 'Nothing of yours is kept in this browser: “Keep my working data” is off (Permissions), so after a reload you choose your file again. ' : '';
  const mine = new Set(own.map((r) => r.sha256));
  const ownKept = files.filter((f) => mine.has(f.sha256)), made = files.filter((f) => !mine.has(f.sha256));
  // The user's own files that could not be kept (`missed`, each { name, why: 'short' | 'failed' }), said by name.
  const notKept = missed.length ? `${missed.map((m) => m.name).join(', ')} could not be kept in this browser (${missed.some((m) => m.why === 'short') ? 'it has not room enough' : 'it would not keep it'}): after a reload, choose ${missed.length === 1 ? 'it' : 'them'} again. ` : '';
  if (!files.length) return notKept;
  const bytes = files.reduce((n, f) => n + (f.size || 0), 0);
  const parts = [ownKept.length ? (ownKept.length === 1 ? 'your file' : `your ${ownKept.length} files`) : null,
    made.length ? `${made.length} ${made.length === 1 ? 'file' : 'files'} the steps made` : null].filter(Boolean);
  return `Kept in this browser for the next steps: ${parts.join(' and ')} (${fmtBytes(bytes)}). Nothing leaves this computer. ${notKept}`;
}

const and = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
/** Each file once, by SHA-256. */
export const distinct = (refs) => [...new Map(refs.map((r) => [r.sha256, r])).values()];

/**
 * What the project file holds (src/engine/methodos/project.js), said where "Save the project" is: the
 * user's own data, plainly, and what is never in it. `state` the workflow; `review` the name of the
 * review open, or null; `withOwn` whether the user's own file goes in (the box beside the button).
 */
export function projectWords(state, { review = null, withOwn = true } = {}) {
  const own = distinct(startFiles(state)), mine = new Set(own.map((r) => r.sha256));
  const made = distinct(madeBy(state)).filter((r) => !mine.has(r.sha256));
  const parts = ['the workflow, with your answers and its Scope'];
  if (own.length && withOwn) parts.push(`your file ${and(own.map((r) => r.name))}`);
  if (made.length) parts.push(made.length === 1 ? 'the file its steps made' : `the ${made.length} files its steps made`);
  if (review) parts.push(`the review open (${review}), with its decisions`);
  const left = own.length && !withOwn ? ` Your file ${and(own.map((r) => r.name))} is left out: whoever opens the project chooses it again where a step needs it.` : '';
  return `The project file holds your own data, to carry on in another browser or on another computer, or to give to a colleague: ${and(parts)}.${left} `
    + 'Never in it: your WHG token or any other key, the permissions you gave, and your other workflows; the reviewer\'s name is in it only where the review records who decided.';
}
