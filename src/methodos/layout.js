// The words and marks of the page's layout for a workflow (src/methodos/page.js, src/app.js): pure,
// so that they are tested in Node (test/methodos-layout.test.js), with no page.
import { fmtBytes } from '../engine/words.js';

/** A step's state in words, for a screen reader beside its checkbox (and read by the browser checks). */
export const STATE_WORDS = { done: 'Done', current: 'Now', todo: 'To come', unavailable: 'Not yet available' };

/**
 * A step's checkbox, disabled, in the tracker's list: ticked only when the step is done; the step at
 * hand is marked as current (a mark of its own, never a tick); a step to come is unticked and greyed,
 * as is one not yet available, whose box is drawn dashed (its reason is said beside it).
 */
export function stepMark(state) {
  if (!(state in STATE_WORDS)) throw new Error(`A step's state is done, current, todo or unavailable, not “${state}”.`);
  return { checked: state === 'done', current: state === 'current', greyed: state === 'todo' || state === 'unavailable', words: STATE_WORDS[state] };
}

/** A title within a sentence: its first letter in lower case, unless the first word is all capitals (FAIR, PLATO). */
export const lower = (t) => (/^[A-Z]{2,}\b/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1));

/**
 * Where a workflow is, as the tracker says it, the centre's title and the strip at a phone's width show it:
 * "Step 2 of 10: Elenchos, check the table" (`n` counts from 0; no tool, no tool's name).
 */
export function whereWords(n, of, tool, title) {
  return `Step ${n + 1} of ${of}: ${tool ? `${tool}, ` : ''}${lower(title)}`;
}

/** The files chosen in step 1, in the one line it folds to: their names (or how many) and size. */
export function chosenWords(files) {
  const list = [...(files || [])];
  if (!list.length) return '';
  const bytes = fmtBytes(list.reduce((n, f) => n + (f.size || 0), 0));
  if (list.length === 1) return `${list[0].name} (${bytes})`;
  return list.length <= 3 ? `${list.map((f) => f.name).join(', ')} (${bytes} in all)` : `${list.length} files (${bytes} in all)`;
}

/**
 * Whether the workflow has gone on from the step `was` to the step `now` (each { id, n } or null): the
 * result of the run shown is then put away, so that it does not stand over the next step. Going back a
 * step, or staying at one, is not going on.
 */
export const wentOn = (was, now) => !!was && !!now && was.id !== now.id && now.n > was.n;
