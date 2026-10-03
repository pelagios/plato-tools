// Methodos's interview (src/engine/methodos/interview.js): which recipe each pair of answers gives,
// the questions it then asks, and the workflow it plans. The browser checks (e2e/app_test.py) answer
// the page's interview and expect what PREDICTED says here: the two are held to the same table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HAVE, WANT, choose, questionsFor, answersFor, answered, plan, feedbackUrl } from '../src/engine/methodos/interview.js';
import { RECIPES, runner } from '../src/engine/methodos/index.js';

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

test('an answer that brings in a step not yet available does not refuse the workflow: the step is planned with its reason, skipped, and noted at the end', () => {
  const c = choose('table', 'map');
  const a = answersFor(c, { 'has-regions': true, 'will-draw': false, 'will-publish': false });
  const pl = plan(c.recipe, a);
  const regions = pl.steps.find((s) => s.id === 'regions');
  assert.ok(regions, 'the regions step is in the plan');
  assert.match(regions.available, /Regions cannot be identified yet/);
  assert.equal(pl.blocked, undefined, 'nothing blocks the workflow');
  assert.deepEqual(pl.unavailable, ['regions']);
  assert.ok(pl.steps.filter((s) => s.id !== 'regions').every((s) => s.available === true));
  assert.equal(pl.notes.length, 1);
  assert.match(pl.notes[0], /regions were not identified/);
  assert.ok(pl.left.some((s) => s.id === 'place'), 'the drawing step is left out when not wanted');
  // The same with the answer No: nothing unavailable, nothing noted.
  const no = plan(c.recipe, answersFor(c, { 'has-regions': false, 'will-draw': false, 'will-publish': false }));
  assert.deepEqual([no.unavailable, no.notes], [[], []]);
  assert.ok(!no.steps.some((s) => s.id === 'regions'));
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
