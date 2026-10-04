// Methodos's interview (src/engine/methodos/interview.js): which recipe each pair of answers gives,
// the questions it then asks, and the workflow it plans. The browser checks (e2e/app_test.py) answer
// the page's interview and expect what PREDICTED says here: the two are held to the same table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HAVE, WANT, choose, questionsFor, answersFor, answered, plan, feedbackUrl } from '../src/engine/methodos/interview.js';
import { RECIPES, OPERATIONS, runner } from '../src/engine/methodos/index.js';

const ref = { type: 'files', name: 'places.csv', size: 10, sha256: 'a'.repeat(64) };

// The predictions, in a file of their own that the browser checks read too (e2e/app_test.py, methodos_page_checks).
const PREDICTED = JSON.parse(readFileSync(new URL('./methodos-predicted.json', import.meta.url), 'utf8'));

test('each pair of answers that names a recipe gives it, with its questions, and plans the predicted steps; the runner starts it', () => {
  for (const p of PREDICTED) {
    const c = choose(p.have, p.want);
    assert.equal(c.kind, 'recipe'); assert.equal(c.recipe, p.recipe);
    assert.deepEqual(questionsFor(c).map((q) => q.key), Object.keys(p.yes));
    for (const q of questionsFor(c)) assert.equal(q.question, RECIPES[p.recipe].asks[q.key].question);
    assert.equal(answered(c, {}), Object.keys(p.yes).length === 0);
    assert.equal(answered(c, p.yes), true);
    const a = answersFor(c, p.yes);
    const pl = plan(c.recipe, a);
    assert.deepEqual(pl.steps.map((s) => s.id), p.steps);
    assert.deepEqual(pl.unavailable, []);
    assert.deepEqual(pl.notes, []);
    assert.equal(pl.digest, RECIPES[p.recipe].digest);
    // The plan is the runner's: the steps it would run are the ones the plan shows.
    const st = runner.start(RECIPES[c.recipe], a, { files: [ref] });
    assert.deepEqual(st.steps.filter((s) => s.state === 'pending').map((s) => s.id), p.steps);
  }
});

test('"not sure" gives the plain grid, whatever is had; nothing is chosen until both are answered', () => {
  for (const h of HAVE) assert.deepEqual(choose(h.key, 'unsure'), { kind: 'grid' });
  assert.equal(choose('table', undefined), null);
  assert.equal(choose(undefined, 'map'), null);
  assert.equal(choose('table', 'somewhere'), null);
  assert.equal(choose('table', 'map').kind, 'recipe');   // the presence beside those absences
});

test('every other pair names no recipe, says why, and names tools that exist', () => {
  const named = new Set(['table|map', 'table|publish', 'plato|publish']);
  const keys = new Set(['read', 'check', 'convert', 'figures', 'versions', 'publish', 'match', 'chora']);
  let none = 0;
  for (const h of HAVE) for (const w of WANT) {
    if (w.key === 'unsure' || named.has(`${h.key}|${w.key}`)) continue;
    const c = choose(h.key, w.key);
    assert.equal(c.kind, 'none', `${h.key} + ${w.key}`);
    assert.ok(c.why.length > 10);
    assert.ok(c.tools.length && c.tools.every((t) => keys.has(t)), `${h.key} + ${w.key}: ${c.tools}`);
    none++;
  }
  assert.equal(none, HAVE.length * (WANT.length - 1) - named.size);
  assert.match(choose('text', 'map').why, /text is not available yet/);
});

test('regions answered Yes: the regions step and the step that records them are planned and available, with nothing noted; a step not available yet would be planned with its reason, skipped, and noted at the end', () => {
  const c = choose('table', 'map');
  const a = answersFor(c, { 'has-regions': true, 'will-draw': false, 'will-publish': false });
  const pl = plan(c.recipe, a);
  const ids = pl.steps.map((s) => s.id);
  assert.deepEqual(ids.slice(0, 7), ['columns', 'check', 'dataset', 'regions', 'lookup', 'review', 'relate']);
  assert.ok(!ids.includes('apply'), 'the plain "Record the decisions" step is left out on this path');
  assert.ok(pl.left.some((s) => s.id === 'apply') && pl.left.some((s) => s.id === 'place'));
  assert.equal(pl.steps.find((s) => s.id === 'regions').kind, 'interactive');
  assert.ok(pl.steps.every((s) => s.available === true));
  assert.deepEqual([pl.unavailable, pl.notes], [[], []]);
  assert.ok(!pl.notes.some((n) => /regions were not identified/.test(n)));
  // The same with the answer No: the plain step records the decisions, and no regions step.
  const no = plan(c.recipe, answersFor(c, { 'has-regions': false, 'will-draw': false, 'will-publish': false }));
  assert.deepEqual([no.unavailable, no.notes], [[], []]);
  assert.ok(!no.steps.some((s) => s.id === 'regions' || s.id === 'relate') && no.steps.some((s) => s.id === 'apply'));
  // Stephen's rule, kept: a recipe naming a step not available yet plans it with its reason, skips it, and says so at the end.
  const R = { ...RECIPES['map-your-data'], steps: [...RECIPES['map-your-data'].steps.slice(0, 3), { id: 'adopt', op: 'adopt', from: { dataset: 'dataset.dataset' } }] };
  const sk = plan('map-your-data', a, { recipes: { 'map-your-data': R } });
  assert.equal(sk.steps.find((s) => s.id === 'adopt').available, OPERATIONS.adopt.available);
  assert.deepEqual(sk.unavailable, ['adopt']);
  assert.equal(sk.blocked, undefined, 'nothing blocks the workflow');
  assert.deepEqual(sk.notes, ['“Take each identified place\'s location from its match” was not done: it is not yet available.']);
});

test('the "no workflow yet" feedback link opens a new issue, labelled Methodos, titled with the two answers in words', () => {
  const u = new URL(feedbackUrl('text', 'convert'));
  assert.equal(u.origin + u.pathname, 'https://github.com/pelagios/plato-tools/issues/new');
  assert.equal(u.searchParams.get('labels'), 'Methodos');
  assert.equal(u.searchParams.get('title'), 'Methodos: a workflow for “A text that names places” to “A file in another format”');
  assert.deepEqual([...u.searchParams.keys()].sort(), ['labels', 'title']);
  assert.equal(feedbackUrl('text', 'nowhere'), null);
});

test('answers not asked are not carried into the recipe', () => {
  const c = choose('plato', 'publish');
  assert.deepEqual(answersFor(c, { 'will-draw': true }), {});
  const m = choose('table', 'publish');
  assert.deepEqual(answersFor(m, { 'will-publish': false, 'has-regions': false }), { target: 'plato-json', 'will-publish': true, 'has-regions': false });
});
