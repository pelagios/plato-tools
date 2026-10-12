// The words and marks of the main page's layout for a workflow (src/methodos/layout.js): each step's
// checkbox, where the workflow is (the tracker's line, the centre's title and the phone's strip), the
// one line step 1 folds to, and when the result of a run is put away. The browser checks
// (e2e/app_test.py, layout_checks) hold the page to the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATE_WORDS, stepMark, lower, whereWords, chosenWords, wentOn, resultLabel } from '../src/methodos/layout.js';
import { plan } from '../src/engine/methodos/interview.js';
import { OPERATIONS } from '../src/engine/methodos/index.js';

test('a step is ticked only when done; the current step has its own mark, never a tick; steps to come are unticked and greyed', () => {
  assert.deepEqual(stepMark('done'), { checked: true, current: false, greyed: false, words: 'Done' });
  assert.deepEqual(stepMark('current'), { checked: false, current: true, greyed: false, words: 'Now' });
  assert.deepEqual(stepMark('todo'), { checked: false, current: false, greyed: true, words: 'To come' });
  assert.deepEqual(stepMark('unavailable'), { checked: false, current: false, greyed: true, words: 'Not yet available' });
  // Exactly one state is ticked, and exactly one is current: the two marks never coincide.
  const all = Object.keys(STATE_WORDS).map(stepMark);
  assert.equal(all.filter((m) => m.checked).length, 1);
  assert.equal(all.filter((m) => m.current).length, 1);
  assert.ok(all.every((m) => !(m.checked && m.current)));
  assert.throws(() => stepMark('skipped'), /done, current, todo or unavailable/);
});

test('where the workflow is: "Step n of N: Tool, what it does", counted from 1, the step in lower case', () => {
  assert.equal(whereWords(1, 10, 'Elenchos', 'Check the table'), 'Step 2 of 10: Elenchos, check the table');
  assert.equal(whereWords(0, 3, null, 'Choose the file'), 'Step 1 of 3: choose the file');
  assert.equal(lower('FAIR report'), 'FAIR report');
  assert.equal(lower('Make a PLATO dataset'), 'make a PLATO dataset');
  // On a real plan: the first step of Map your data, as the tracker and the centre's title say it.
  const p = plan('map-your-data', { 'has-regions': false, 'will-draw': false, 'will-publish': false });
  const steps = p.steps.filter((s) => s.available === true);
  const first = steps[0];
  assert.equal(whereWords(0, steps.length, OPERATIONS[first.op]?.tool ?? first.tool, first.title), `Step 1 of ${steps.length}: Hermes, ${lower(first.title)}`);
});

test('step 1 folded: the files chosen, by name and size, or how many there are', () => {
  const f = (name, size) => ({ name, size });
  assert.equal(chosenWords([]), '');
  assert.equal(chosenWords(null), '');
  assert.match(chosenWords([f('parishes.csv', 313)]), /^parishes\.csv \(313 bytes\)$/);
  assert.match(chosenWords([f('a.csv', 1), f('b.csv', 2)]), /^a\.csv, b\.csv \(3 bytes in all\)$/);
  assert.match(chosenWords([f('a', 1), f('b', 1), f('c', 1), f('d', 1)]), /^4 files \(4 bytes in all\)$/);
});

test('a run\'s result is put away only when the workflow goes on to a later step, not back, nor at the same step', () => {
  const a = { id: 'columns', n: 0 }, b = { id: 'check', n: 1 };
  assert.equal(wentOn(a, b), true);
  assert.equal(wentOn(b, a), false);    // back a step
  assert.equal(wentOn(b, { ...b }), false);
  assert.equal(wentOn(null, b), false);  // the workflow begins
  assert.equal(wentOn(b, null), false);  // left, or every step done
});

test('a result kept in view as the workflow goes on is labelled with the step it was of', () => {
  assert.equal(resultLabel(whereWords(1, 10, 'Elenchos', 'Check the table')), 'Result of step 2: Elenchos, check the table');
  assert.equal(resultLabel(whereWords(0, 3, null, 'Choose the file')), 'Result of step 1: choose the file');
  assert.equal(resultLabel(''), '');
  assert.equal(resultLabel(undefined), '');
  assert.equal(resultLabel('Every one of the 10 steps is done.'), '');
});
