// Methodos: Stephen's decisions of 4 October 2026 for Map your data (src/engine/methodos/interview.js
// baseAsked, answered, answersFor; containment.js writesItself, baseDiffers). Each refusal or absence is
// paired with the presence it is told from, so that a check that always says yes (or no) fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choose, answersFor, answered, baseAsked, baseAnswer, plan } from '../src/engine/methodos/interview.js';
import { RECIPES, runner, writesItself, baseDiffers, digest, recordOf, reconcile } from '../src/engine/methodos/index.js';

const BASE = 'https://example.org/parishes/';

test('the base address is asked only for a workflow that mints addresses: Map your data with regions (needed), Publish a dataset (optional)', () => {
  const map = choose('table', 'map'), pub = choose('plato', 'publish'), mapPub = choose('table', 'publish');
  const yes = { 'has-regions': true, 'will-draw': false, 'will-publish': false }, no = { ...yes, 'has-regions': false };
  assert.deepEqual(baseAsked(map, yes), { needed: true, question: RECIPES['map-your-data'].asks.base.question });
  assert.equal(baseAsked(map, no), null, 'no regions: nothing is minted, so it is not asked');
  assert.equal(baseAsked(map, {}), null, 'not before the regions question is answered');
  assert.equal(baseAsked(mapPub, { 'has-regions': true, 'will-draw': false }).needed, true);
  assert.deepEqual(baseAsked(pub, {}), { needed: false, question: RECIPES['publish-a-dataset'].asks.base.question });
  // Not asked by a choice that leads to no recipe, nor to the grid.
  assert.equal(baseAsked(choose('text', 'convert'), {}), null);
  assert.equal(baseAsked(choose('table', 'unsure'), {}), null);
});

test('with regions, the interview is answered only once a base address is given, and the address goes into the answers, and so to the steps that mint', () => {
  const map = choose('table', 'map');
  const yes = { 'has-regions': true, 'will-draw': false, 'will-publish': false };
  assert.equal(answered(map, yes), false);
  assert.equal(answered(map, yes, { base: 'not an address' }), false);
  assert.equal(answered(map, yes, { base: ` ${BASE} ` }), true);
  assert.equal(answersFor(map, yes, { base: ` ${BASE} ` }).base, BASE);
  // Without regions: answered without one, and none put in the answers even if typed.
  assert.equal(answered(map, { ...yes, 'has-regions': false }), true);
  assert.equal(Object.hasOwn(answersFor(map, { ...yes, 'has-regions': false }, { base: BASE }), 'base'), false);
  // Publish: optional, so answered without one; given, it reaches the minting step's options.
  const pub = choose('plato', 'publish');
  assert.equal(answered(pub, {}), true);
  const files = { files: [{ type: 'files', name: 'd.json', size: 1, sha256: 'a'.repeat(64) }] };
  const mint = (a) => runner.start(RECIPES['publish-a-dataset'], a, files).steps.find((s) => s.id === 'mint').options;
  assert.equal(mint(answersFor(pub, {}, { base: BASE })).base, BASE);
  assert.equal(Object.hasOwn(mint(answersFor(pub, {})), 'base'), false);
  // Map your data's conversion takes it too.
  const conv = runner.start(RECIPES['map-your-data'], answersFor(map, yes, { base: BASE }), files).steps.find((s) => s.id === 'dataset').options;
  assert.deepEqual(conv, { target: 'plato-json', base: BASE });
  assert.equal(baseAnswer('https://x.org/'), 'https://x.org/');
  assert.equal(baseAnswer('x.org'), null);
  assert.ok(plan('map-your-data', answersFor(map, yes, { base: BASE })).steps.length);
});

test('"Write it out" in the format the dataset already has is a download, not a conversion; another format still converts', () => {
  const out = RECIPES['map-your-data'].steps.find((s) => s.id === 'out');
  const step = { ...out, options: { target: 'plato-json' } };
  assert.equal(writesItself(step, 'plato-json'), true);
  assert.equal(writesItself(step, 'plato-jsonl'), false, 'a dataset in another format is converted');
  assert.equal(writesItself({ ...step, options: { target: 'lpf' } }, 'plato-json'), false, 'another format chosen: converted');
  assert.equal(writesItself(step, null), false, 'a file not recognised is not offered');
  assert.equal(writesItself({ ...RECIPES['map-your-data'].steps.find((s) => s.id === 'again'), options: {} }, 'plato-json'), false, 'only a conversion');
  assert.equal(writesItself({ op: 'convert', options: {} }, 'plato-json'), false, 'a conversion with no format given');
});

test('at Finish, a base address in Options other than the review\'s saved address is said; the same one, or none, says nothing', () => {
  const work = { subjects: { uri: BASE, uriFrom: 'base' } };
  const said = baseDiffers(work, 'https://example.org/other/');
  assert.match(said, /The base address in Options \(https:\/\/example\.org\/other\/\) is not the one this review was saved with \(https:\/\/example\.org\/parishes\/\)/);
  assert.equal(baseDiffers(work, BASE), null);
  assert.equal(baseDiffers(work, 'https://example.org/parishes'), null, 'the same address without its slash');
  assert.equal(baseDiffers(work, ''), null, 'no base address in Options');
  assert.equal(baseDiffers({ subjects: {} }, 'https://example.org/other/'), null, 'a review with no saved address');
  // A dataset with an address of its own (its gazetteer's @id) is never compared with a base address.
  assert.equal(baseDiffers({ subjects: { uri: BASE + 'release/v1' } }, BASE), null);
});

// ---- Stephen's decision of 12 October 2026: every workflow that publishes asks the base address, in one shared field ----
test('every workflow that publishes asks the base address, in the same words (one shared question), optional where nothing is minted under it before publishing', () => {
  const words = new Set(Object.values(RECIPES).map((r) => r.asks.base?.question));
  assert.equal(words.size, 1, [...words].join(' | '));
  assert.ok([...words][0]);
  // Map your data without regions, publishing: asked, optional; given, it goes into the answers and so to the conversion.
  const map = choose('table', 'map');
  const pub = { 'has-regions': false, 'will-draw': false, 'will-publish': true };
  assert.deepEqual(baseAsked(map, pub), { needed: false, question: RECIPES['map-your-data'].asks.base.question });
  assert.equal(answered(map, pub), true, 'optional: answered without it');
  assert.equal(answersFor(map, pub, { base: BASE }).base, BASE);
  const files = { files: [{ type: 'files', name: 'd.csv', size: 1, sha256: 'a'.repeat(64) }] };
  assert.equal(runner.start(RECIPES['map-your-data'], answersFor(map, pub, { base: BASE }), files).steps.find((s) => s.id === 'dataset').options.base, BASE);
  // "A citable, published dataset" settles publishing: asked at once. Not publishing and no regions: not asked (the absence beside the presences).
  assert.deepEqual(baseAsked(choose('table', 'publish'), { 'has-regions': false, 'will-draw': false }), { needed: false, question: RECIPES['map-your-data'].asks.base.question });
  assert.equal(baseAsked(map, { ...pub, 'will-publish': false }), null);
  // With regions it is still needed, publishing or not.
  assert.equal(baseAsked(map, { ...pub, 'has-regions': true }).needed, true);
  assert.equal(baseAsked(map, { ...pub, 'has-regions': true, 'will-publish': false }).needed, true);
});

test('a Map your data or Publish a dataset workflow kept from before the shared question is resumed: only the recipe\'s words changed, so it carries on, at its step', () => {
  const OLD = {
    'map-your-data': 'Under what base address will your places and regions have web addresses of their own (for example https://example.org/places/)?',
    'publish-a-dataset': 'Under what base address will your places have web addresses of their own (for example https://example.org/places/)?',
  };
  const files = { files: [{ type: 'files', name: 'd.csv', size: 1, sha256: 'a'.repeat(64) }] };
  const cases = [
    ['map-your-data', { 'has-regions': true, 'will-draw': false, 'will-publish': true, target: 'plato-json', base: BASE }],
    ['map-your-data', { 'has-regions': false, 'will-draw': true, 'will-publish': false, target: 'plato-json' }],
    ['publish-a-dataset', { base: BASE }],
  ];
  for (const [key, answers] of cases) {
    const now = RECIPES[key];
    const { digest: _, ...plain } = now;
    const before = { ...plain, asks: { ...plain.asks, base: { ...plain.asks.base, question: OLD[key] } } };
    const was = digest(before);
    assert.notEqual(was, now.digest, 'the digest did change');
    // A record saved under the recipe as it was, two steps done.
    let s = runner.start(before, answers, files);
    s = runner.complete(runner.next(s), s.steps.find((x) => x.state === 'pending').id, key === 'map-your-data' ? { mapping: [{ type: 'mapping', name: 'columns.json', size: 2, sha256: 'b'.repeat(64) }] } : {});
    const record = { ...recordOf(s, { name: 'd.csv' }) };
    assert.equal(record.recipe.digest, was);
    const v = reconcile(record, now);
    assert.equal(v.action, 'continue', `${key}: ${v.words}`);
    assert.match(v.words, /words of .* have changed since this workflow was saved; its steps have not, so it carries on/);
    assert.equal(v.state.recipe.digest, now.digest);
    assert.deepEqual(v.state.steps.map((x) => x.state), record.steps.map((x) => x.state), 'at the same step');
    // The control: a recipe whose steps changed is not carried on blindly.
    const changed = { ...plain, steps: plain.steps.map((x, i) => (i === plain.steps.length - 1 ? { ...x, options: { ...(x.options || {}), extra: 'x' } } : x)) };
    assert.equal(reconcile(record, changed).action, 'changed');
  }
});
