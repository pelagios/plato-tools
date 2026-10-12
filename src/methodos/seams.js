// Methodos at its seams with Chora (Stephen, 12 October 2026, Issue #33 point 5): what a workflow
// keeps in this browser, which of its files is the one to choose again when the main page is back
// (from Chora, after a reload), and the few words of it that Chora's page shows. Pure, so that the
// main page (src/methodos/page.js) and Chora's (src/chora/app.js) say the same, and the tests read it
// without a page.
import * as runner from '../engine/methodos/runner.js';
import { OPERATIONS } from '../engine/methodos/operations.js';
import { fmtBytes } from '../engine/words.js';

// The input of each automatic operation that the page's run takes from the files chosen in step 1 (as
// page.js's MAIN, which judges whether a run is the step's): the file to choose again for that step.
const MAIN = { check: 'files', convert: 'files', compare: 'later', 'publish.report': 'dataset', 'publish.mint': 'dataset', 'publish.site': 'dataset',
  'publish.w3id': 'dataset', match: 'subjects', lookup: 'subjects', apply: 'subjects', 'relate.containment': 'subjects' };
// And of the interactive steps whose work is on a file shown in step 1: the table whose columns are
// matched, and the dataset drawn on in Chora (chosen again, so that it is shown on return).
const SHOWN = { 'read.columns': 'files', place: 'dataset' };

/** The step a workflow's state is at: the one running or waiting, else the one that stopped, failed or was cancelled, else the next to do; null when it is completed. */
export function stepAt(state) {
  if (!state || state.status === 'completed' || !Array.isArray(state.steps)) return null;
  if (state.current) return state.steps.find((s) => s.id === state.current) || null;
  return state.steps.find((s) => ['stopped', 'failed', 'cancelled'].includes(s.state)) || state.steps.find((s) => s.state === 'pending') || null;
}

/**
 * The references of the file(s) step `s` works on, to be chosen in step 1 when the page is back: its
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
  if (!keeping) return workflow ? 'Nothing of yours is kept in this browser: “Keep my working data” is off (Permissions), so after a reload, or back from Chora, you choose your file again. ' : '';
  const mine = new Set(own.map((r) => r.sha256));
  const ownKept = files.filter((f) => mine.has(f.sha256)), made = files.filter((f) => !mine.has(f.sha256));
  // The user's own files that could not be kept (`missed`, each { name, why: 'short' | 'failed' }), said by name.
  const notKept = missed.length ? `${missed.map((m) => m.name).join(', ')} could not be kept in this browser (${missed.some((m) => m.why === 'short') ? 'it has not room enough' : 'it would not keep it'}): after a reload, or back from Chora, choose ${missed.length === 1 ? 'it' : 'them'} again. ` : '';
  if (!files.length) return notKept;
  const bytes = files.reduce((n, f) => n + (f.size || 0), 0);
  const parts = [ownKept.length ? (ownKept.length === 1 ? 'your file' : `your ${ownKept.length} files`) : null,
    made.length ? `${made.length} ${made.length === 1 ? 'file' : 'files'} the steps made` : null].filter(Boolean);
  return `Kept in this browser for the next steps: ${parts.join(' and ')} (${fmtBytes(bytes)}). Nothing leaves this computer. ${notKept}`;
}

/** Chora's few words of the workflow it was opened for: its title, "Step n of N", and the step's words; null when there is no step to show. */
export function trackOf(state, recipe) {
  const s = stepAt(state);
  if (!s) return null;
  const followed = state.steps.filter((x) => x.state !== 'skipped');
  const n = followed.findIndex((x) => x.id === s.id);
  if (n < 0) return null;
  return { title: recipe?.title || state.recipe?.key || 'A workflow', step: `Step ${n + 1} of ${followed.length}`, words: s.title, op: s.op,
    tool: OPERATIONS[s.op]?.tool || null };
}
