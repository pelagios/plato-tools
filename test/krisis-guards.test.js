// Krisis × Methodos (#28): WHG's guards and the undoable bulk accept (src/engine/krisis/guards.js), query
// variants (names.js queryVariants), and flags, notes and row states (work.js, apply.js, compare.js).
// A fake fetch stands in for WHG, so nothing here goes on the network.
//
// Every absence has a presence beside it, found by the same search: a candidate that does not pass is
// shown passing when the one reason is taken away; a place left out of a dataset is first found in it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, textFile, outText } from './engine.js';
import { detect } from '../src/engine/input.js';
import { compare } from '../src/engine/compare.js';
import { createLookup, memoryLedger, WHG_ENDPOINT } from '../src/engine/gazetteer/index.js';
import { gather, match } from '../src/engine/krisis/match.js';
import { readWork, serialiseWork, decide, flag, noteOn, setRowState, excludedPlaces } from '../src/engine/krisis/work.js';
import { attestationsFrom } from '../src/engine/krisis/identity.js';
import { apply } from '../src/engine/krisis/apply.js';
import { runLookup, selectPlaces, planQueries, WHG_SERVICE } from '../src/engine/krisis/lookup.js';
import { queryVariants, MAX_VARIANTS } from '../src/engine/krisis/names.js';
import { guard, guardOf, dice, bestDice, tieOf, withheldOf, acceptGuarded, undoBatch, planGuarded, guardsFirst, GUARD_RULE } from '../src/engine/krisis/guards.js';
import { guardWords } from '../src/engine/words.js';

const X = 'https://example.org/';
const W3ID = 'https://w3id.org/whg/id/';
const src = { '@id': X + 'source/s', title: 'S', authorityType: 'source' };
const at = (lon, lat) => ({ geometries: [{ geojson: { type: 'Point', coordinates: [lon, lat] } }], sources: [src] });
const named = (...names) => ({ names: names.map((toponym) => ({ toponym })), sources: [src] });
const A = (id) => `${X}a/${id}`;
const REVIEWER = { name: 'A. Reviewer' };
const NOW = '2026-10-04T12:00:00Z';
const clock = () => { let n = 0; return () => new Date(Date.parse(NOW) + 1000 * n++).toISOString(); };

function fakeWhg(answer = () => ({ result: [] })) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const out = { attribution: { whg: { license: 'CC-BY-4.0' } } };
    for (const [k, q] of Object.entries(body.queries)) out[k] = answer(q);
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { fetch, calls, sent: () => calls.flatMap((c) => Object.values(c.body.queries).map((q) => q.query)) };
}
const byName = (table) => (q) => ({ result: table[q.query] ?? [] });
const PRIVATE = { get shared() { return false; }, get locks() { return null; }, get ledger() { return memoryLedger(); } };
const lookupWith = (fake) => createLookup({ endpoint: WHG_ENDPOINT, token: 'test-token', fetch: fake.fetch, sleep: () => Promise.resolve(), queryRate: null, ...PRIVATE });

const doc = (places) => ({ profile: 'place-centric', gazetteer: { '@id': X + 'a', title: 'Dataset A' }, spatialEntities: places });
const place = (id, label, lon, lat, more = {}) => ({ '@id': A(id), label, attestations: [named(label), at(lon, lat)], ccodes: ['GB'], ...more });
const datasetFile = (places) => textFile(JSON.stringify(doc(places)), 'a.json');
async function gathered(places) { return gather({ subjects: await detect([datasetFile(places)]), options: {} }, env()); }
async function looked(places, table, options = {}) {
  const g = await gathered(places);
  const fake = fakeWhg(byName(table));
  const r = await runLookup({ lookup: lookupWith(fake), subjects: g.subjects, places: g.places, options: { places: 'all', ...options }, now: clock() });
  return { ...r, fake, g };
}
const cand = (id, name, more = {}) => ({ id: `place:gn:${id}`, name, score: 100, match: true, description: 'Country: GB', ccodes: ['GB'], namespace: 'gn', alt_names: [], ...more });
const candOf = (work, gnId) => work.candidates.find((c) => c.gazetteer?.id === `place:gn:${gnId}`);

// ---- the guard, at every boundary (whg3 whg/webpack/js/reconciliation.js:5857-6000) ------------------------
test('Dice is over SETS of bigrams of names NFD-stripped, lower-cased, non-alphanumerics a space; equal or all words of the shorter in the longer is 1', () => {
  assert.equal(dice('Zürich', 'ZURICH'), 1, 'marks stripped and case folded');
  assert.equal(dice('Long Melford', 'Melford'), 1, 'every word of the shorter in the longer');
  assert.equal(dice('Melford-on-Sea', 'melford on sea'), 1, 'punctuation is a space');
  assert.equal(dice('abc', 'abd'), 0.5, '{ab,bc} and {ab,bd}');
  assert.equal(dice('aaaa', 'aa'), 1, 'sets, not counts: as multisets this would be 0.5');
  assert.equal(dice('', 'x'), 0);
  // 20 bigrams each, 9 shared: exactly 0.45; one bigram more on one side: under it.
  const a = 'abcdefghijklmnopqrstu', b = 'abcdefghijzyxwvutsrqp';
  assert.equal(dice(a, b), 0.45);
  assert.ok(dice(a, b + 'o') < 0.45);
});

test('withheld: a numeric confidence alone decides (under 30), Dice never consulted; without one, Dice under 0.45', () => {
  const a = 'abcdefghijklmnopqrstu', b = 'abcdefghijzyxwvutsrqp';
  const table = [
    [{ name: 'Nothing alike', confidence: 30 }, ['Alton'], false, 'confidence 30 is not under 30, however unlike the names'],
    [{ name: 'Alton', confidence: 29.9 }, ['Alton'], true, 'confidence 29.9: withheld, though the names are equal'],
    [{ name: b }, [a], false, 'no confidence: Dice exactly 0.45 passes'],
    [{ name: b + 'o' }, [a], true, 'no confidence: Dice under 0.45 is withheld'],
    [{ name: 'Москва' }, ['Moscow'], false, 'no pair can be judged (one Latin, one not): not withheld'],
    [{ name: 'Moscow', altNames: ['Санкт'] }, ['Москва'], true, 'control: a Cyrillic pair is judged, and unlike'],
    [{ name: 'Moscow', altNames: ['Москва'] }, ['Москва'], false, 'control: a Cyrillic pair judged alike'],
  ];
  for (const [c, forms, want, why] of table) assert.equal(withheldOf(c, forms).withheld, want, why);
  assert.equal(withheldOf({ name: 'X', confidence: 50 }, ['Alton']).dice, null, 'with a confidence, Dice is not consulted');
  // Only the first 20 other names count.
  const others = (k) => Array.from({ length: 25 }, (_, i) => (i === k ? 'Alton' : `Zzq${i}x`));
  assert.equal(bestDice(['Alton'], { name: 'Qqq', altNames: others(19) }), 1, 'the 20th other name counts');
  assert.ok(bestDice(['Alton'], { name: 'Qqq', altNames: others(20) }) < 0.45, 'the 21st does not');
});

test('the tie: a later candidate scoring at least the top, unless same name and description, or the top exact and it not', () => {
  const t = (top, later) => tieOf([{ name: 'Alton', description: 'Country: GB', match: false, score: 95, ...top }, { name: 'Elsewhere', description: 'Country: GB', match: false, score: 95, ...later }]);
  assert.equal(t({}, {}), true, 'equal scores: a tie');
  assert.equal(t({}, { score: 96 }), true, 'a later one higher: a tie');
  assert.equal(t({}, { score: 94.9 }), false, 'a later one lower: no tie');
  assert.equal(t({}, { name: 'Alton' }), false, 'same name and description: no tie');
  assert.equal(t({}, { name: 'Alton', description: 'Country: US' }), true, 'same name, another description: a tie');
  assert.equal(t({ match: true }, { match: false }), false, 'the top exact and it not: no tie');
  assert.equal(t({ match: true }, { match: true }), true, 'both exact: a tie');
  assert.equal(t({ match: false }, { match: true }), true, 'it exact and the top not: a tie');
});

test('guard(): (exact OR score ≥ 90) AND not withheld AND no tie, the top of its answer only, never by a head word', () => {
  const g = (top, more = {}, rest = []) => guard(top, [top, ...rest], { forms: ['Alton'], ...more });
  const c = (more) => ({ name: 'Alton', description: 'd', match: false, score: 90, confidence: 50, ...more });
  assert.equal(g(c()).pass, true, 'score 90 passes');
  assert.equal(g(c({ score: 89.99 })).reason, 'weak', 'score 89.99 does not');
  assert.equal(g(c({ score: 10, match: true })).pass, true, 'exact passes whatever its score');
  assert.equal(g(c({ confidence: 29 })).reason, 'withheld');
  assert.equal(g(c(), {}, [c({ name: 'Other' })]).reason, 'tie');
  assert.equal(g(c(), {}, [c({ name: 'Other', score: 80 })]).pass, true, 'control: the later one lower');
  assert.equal(g(c(), { headWord: true }).reason, 'head-word', 'a head-word answer never passes');
  const second = c(), answer = [c({ name: 'Top', score: 100 }), second];
  assert.equal(guard(second, answer, { forms: ['Alton'] }).reason, 'not-top');
  assert.equal(guard(answer[0], answer, { forms: ['Top'] }).pass, true, 'control: its top passes');
  assert.equal(guardWords.passes(g(c({ score: 94, confidence: 41 }))), "Passes WHG's guard: score 94, confidence 41");
  assert.equal(guardWords.passes(g(c({ match: true }))), "Passes WHG's guard: exact title");
});

// ---- a lookup stores what the guard needs, and never decides --------------------------------------------------
const PLACES = () => [
  place('alton', 'Alton', -0.97, 51.15), place('barton', 'Barton', -1, 52), place('cotton', 'Cotton', -1, 53),
  place('dalton', 'Dalton', -1, 54), place('elton', 'Elton', -1, 52.5), place('felton', 'Felton', -1.7, 55.3),
];
const TABLE = {
  Alton: [cand(1, 'Alton', { repr_point: [-0.975, 51.149] }), cand(2, 'Alton', { score: 80, match: false, ccodes: ['US'], description: 'Country: US', repr_point: [-90, 38] })],
  Barton: [cand(3, 'Barton', { repr_point: [10, 52] })],                                          // far
  Cotton: [cand(4, 'Cotton', { repr_point: [-1.01, 53], ccodes: ['FR'], description: 'Country: FR' })], // another country
  Dalton: [cand(5, 'Dalton', { match: false, score: 95, confidence: 80, repr_point: [-1, 54] }), cand(6, 'Dalton-in-Furness', { match: false, score: 95, confidence: 70, repr_point: [-3.2, 54.15] })], // tie
  Elton: [cand(7, 'Elton', { repr_point: [-1, 52.5] })],                                          // decided before
  Felton: [cand(8, 'Felton', { match: false, score: 92, confidence: 41, repr_point: [-1.7, 55.3] })],
};

test('a lookup stores each candidate\'s guard figures, and decides nothing, though some pass', async () => {
  const { work } = await looked(PLACES(), TABLE);
  assert.ok(work.candidates.length >= 8, 'control: candidates were added');
  assert.ok(work.candidates.every((c) => c.decision === null && c.candidate_status === 'suggested'), 'nothing decided by the lookup');
  assert.equal(guardOf(candOf(work, 1)).pass, true, 'control: one passes');
  assert.deepEqual([candOf(work, 1).gazetteer.tie, candOf(work, 1).gazetteer.withheld], [false, false]);
  assert.equal(candOf(work, 2).gazetteer.tie, null, 'not the top: no tie judged');
  assert.equal(guardOf(candOf(work, 2)).reason, 'not-top');
  assert.equal(guardOf(candOf(work, 5)).reason, 'tie');
  assert.equal(candOf(work, 5).gazetteer.tie, true);
  assert.equal(guardOf(candOf(work, 8)).pass, true);
  assert.equal(readWork(serialiseWork(work)).candidates.length, work.candidates.length, 'the file with the guard figures reads back');
});

// ---- the bulk accept ------------------------------------------------------------------------------------------
test('acceptGuarded: one passing candidate each, as closeMatch by default, with a basis, the guard and a batch; far and other-country ones left out and counted', async () => {
  const { work } = await looked(PLACES(), TABLE);
  decide(work, candOf(work, 7).id, 'not-this', { at: NOW });
  const before = planGuarded(work);
  assert.equal(before.accept.length, 2, 'planGuarded changes nothing and says how many');
  assert.ok(work.candidates.every((c) => c.decision === null || c.gazetteer.id === 'place:gn:7'), 'planning decided nothing');
  const r = acceptGuarded(work, { reviewer: REVIEWER, at: NOW });
  assert.deepEqual(r, { batch: 'b1', accepted: 2, leftOut: { far: 1, ccodes: 1, total: 2 }, several: 0 });
  const alton = candOf(work, 1), felton = candOf(work, 8);
  for (const c of [alton, felton]) {
    assert.equal(c.decision.kind, 'match');
    assert.equal(c.decision.identityType, 'closeMatch');
    assert.equal(c.decision.batch, 'b1');
    assert.equal(c.decision.guard.rule, GUARD_RULE);
    assert.match(c.decision.basis, /WHG's guard/);
  }
  assert.deepEqual(alton.decision.guard, { rule: GUARD_RULE, threshold: 90, exact: true, score: 100, confidence: null, dice: 1 });
  assert.match(felton.decision.basis, /score 92, confidence 41/);
  for (const id of [3, 4, 5, 6, 2]) assert.equal(candOf(work, id).decision, null, `place:gn:${id} not accepted`);
  assert.equal(candOf(work, 7).decision.kind, 'not-this', 'a place already decided is left alone');
  assert.deepEqual(work.reviewer, REVIEWER);
  // The basis goes with the attestation; the batch is the work file's.
  const made = attestationsFrom(work, { date: NOW }).filter((m) => m.subject === A('alton'));
  assert.equal(made.length, 1);
  assert.match(made[0].attestation.identities[0].basis, /Accepted in bulk by the reviewer as passing WHG's guard \(exact title\)/);
  assert.equal(JSON.stringify(made).includes('"batch"'), false);
  assert.equal(JSON.stringify(work).includes('"batch":"b1"'), true, 'control: the batch is in the work file');
  // Read back, the batch and guard stay.
  const back = readWork(serialiseWork(work));
  assert.equal(candOf(back, 1).decision.batch, 'b1');
  assert.deepEqual(back.batches.map((b) => [b.id, b.accepted, b.identityType]), [['b1', 2, 'closeMatch']]);
  // The reviewer's choice of type is kept.
  const { work: w2 } = await looked(PLACES(), TABLE);
  acceptGuarded(w2, { identityType: 'exactMatch', at: NOW });
  assert.equal(candOf(w2, 1).decision.identityType, 'exactMatch');
  assert.throws(() => acceptGuarded(w2, { identityType: 'sameAs' }), /Not an identity type/);
});

test('undoBatch clears only the decisions of that batch still as it left them; a later batch has a new id', async () => {
  const { work } = await looked(PLACES(), TABLE);
  decide(work, candOf(work, 7).id, 'not-this', { at: NOW });   // Elton decided before
  assert.equal(acceptGuarded(work, { at: NOW }).accepted, 2);
  decide(work, candOf(work, 8).id, 'not-this', { at: NOW });   // changed since
  assert.equal(undoBatch(work, 'b1'), 1);
  assert.equal(candOf(work, 1).decision, null, 'unchanged: taken back');
  assert.equal(candOf(work, 1).candidate_status, 'suggested');
  assert.equal(candOf(work, 8).decision.kind, 'not-this', 'changed since: kept');
  assert.equal(work.batches[0].undone, 1);
  const again = acceptGuarded(work, { at: NOW });
  assert.equal(again.batch, 'b2', 'never a used id again');
  assert.equal(again.accepted, 1, 'Felton is decided, so only Alton');
  assert.equal(undoBatch(work, 'b1'), 0, 'an old batch has nothing left');
  assert.equal(candOf(work, 1).decision.batch, 'b2', 'control: the new batch untouched by undoing the old');
});

test('"WHG\'s guards first" orders the places with a passing candidate first; a place with two passing is left to the reviewer', async () => {
  const { work } = await looked(PLACES(), TABLE);
  const order = guardsFirst(work, Object.keys(work.places));
  const passingPlaces = order.filter((iri) => work.candidates.some((c) => c.candidate_source === iri && guardOf(c).pass));
  assert.deepEqual(passingPlaces, [A('alton'), A('barton'), A('cotton'), A('elton'), A('felton')], 'control: five places pass');
  assert.deepEqual(order, [...passingPlaces, A('dalton')], 'those first, in the file\'s order, then the rest');
  assert.deepEqual(guardsFirst(work, [...Object.keys(work.places)].reverse()).slice(0, 5), [...passingPlaces].reverse(), 'each group keeps the order given');
  assert.ok(order.indexOf(A('dalton')) >= passingPlaces.length, 'a tie is not passing');
  // Two passing for one place (each the top of its own query): neither accepted.
  const two = await looked([place('gorton', 'Gorton', -2.2, 53.47, { attestations: [named('Gorton', 'Gortun'), at(-2.2, 53.47)] })],
    { Gorton: [cand(9, 'Gorton', { repr_point: [-2.2, 53.47] })], Gortun: [cand(10, 'Gortun', { repr_point: [-2.21, 53.47] })] }, { allNames: true });
  assert.equal(two.work.candidates.filter((c) => guardOf(c).pass).length, 2, 'control: both pass');
  assert.deepEqual(acceptGuarded(two.work, { at: NOW }), { batch: null, accepted: 0, leftOut: { far: 0, ccodes: 0, total: 0 }, several: 1 });
});

// ---- query variants -----------------------------------------------------------------------------------------------
test('queryVariants: inversion by a known qualifier only, "X, or Y" and "X or Y", brackets, head word last, at most 10', () => {
  const v = (n) => queryVariants(n).map((x) => [x.text, x.how]);
  assert.deepEqual(v('Melford, Long'), [['Melford, Long', 'given'], ['Long Melford', 'inverted'], ['Melford', 'head-word']]);
  assert.deepEqual(v('Rotherhithe, Surrey'), [['Rotherhithe, Surrey', 'given']], 'Surrey is not a qualifier: not inverted');
  assert.deepEqual(v('Stoke, or Stock'), [['Stoke, or Stock', 'given'], ['Stoke', 'alternative'], ['Stock', 'alternative']]);
  assert.deepEqual(v('Stoke or Stock'), [['Stoke or Stock', 'given'], ['Stoke', 'alternative'], ['Stock', 'alternative']]);
  assert.deepEqual(v('Melford (Long)'), [['Melford (Long)', 'given'], ['Melford', 'brackets']]);
  assert.deepEqual(v('Great Marlow'), [['Great Marlow', 'given'], ['Marlow', 'head-word']]);
  assert.deepEqual(v('Albans, St'), [['Albans, St', 'given'], ['St Albans', 'inverted']], 'Saint inverts, but is no head-word qualifier');
  assert.deepEqual(v('Orford'), [['Orford', 'given']], '"or" inside a word is not an alternative');
  assert.deepEqual(v('Ashby (de la Zouch), or Ashby, Market'), [['Ashby (de la Zouch), or Ashby, Market', 'given'], ['Ashby, or Ashby, Market', 'brackets'],
    ['Ashby', 'alternative'], ['Ashby, Market', 'alternative'], ['Market Ashby', 'inverted']]);
  const many = queryVariants(Array.from({ length: 12 }, (_, i) => `Great Town${i}`).join(' or '));
  assert.equal(many.length, MAX_VARIANTS);
  const heads = queryVariants('Little Snoring or Great Snoring').map((x) => x.how);
  assert.deepEqual(heads, ['given', 'alternative', 'alternative', 'head-word'], 'the head word last (once)');
});

test('variants are opt-in; each is its own query, recorded in sent and on the candidate; one found only by a head word never passes', async () => {
  const melford = place('melford', 'Melford, Long', 0.72, 52.08);
  const head = { 'Melford': [cand(11, 'Melford', { repr_point: [0.72, 52.08] })] };
  const off = await looked([melford], head);
  assert.deepEqual(off.fake.sent(), ['Melford, Long'], 'without variants, the label only');
  const on = await looked([melford], head, { variants: true });
  assert.deepEqual(on.fake.sent(), ['Melford, Long', 'Long Melford', 'Melford']);
  const q = on.record.queries[A('melford')];
  assert.deepEqual(q.sent, ['Melford, Long', 'Long Melford', 'Melford']);
  assert.deepEqual(q.variants.map((x) => x.how), ['given', 'inverted', 'head-word']);
  assert.equal(on.record.parameters.variants, true);
  const c = candOf(on.work, 11);
  assert.deepEqual([c.gazetteer.query, c.gazetteer.how, c.gazetteer.head_word_only], ['Melford', 'head-word', true]);
  assert.equal(guardOf(c).reason, 'head-word', 'an exact top, found only by its head word: never passes');
  assert.equal(acceptGuarded(on.work, { at: NOW }).accepted, 0);
  // Control: the same candidate also found by the inverted form passes, judged in that answer.
  const both = await looked([melford], { ...head, 'Long Melford': [cand(11, 'Melford', { repr_point: [0.72, 52.08] })] }, { variants: true });
  const c2 = candOf(both.work, 11);
  assert.deepEqual([c2.gazetteer.query, c2.gazetteer.how, c2.gazetteer.head_word_only], ['Long Melford', 'inverted', undefined]);
  assert.equal(guardOf(c2).pass, true);
  assert.equal(readWork(serialiseWork(on.work)).lookups[0].queries[A('melford')].variants.length, 3, 'the variants read back');
  const plan = planQueries(on.g.places, { variants: true });
  assert.deepEqual([plan.preview.queries, plan.preview.variants], [3, true], 'the preview counts them');
});

// ---- flags, notes, row states ---------------------------------------------------------------------------------------
const NEWCASTLE = [cand(20, 'Newcastle upon Tyne', { repr_point: [-1.61, 54.97] })];
const YORK = [cand(21, 'York', { repr_point: [-1.08, 53.96] })];
const THREE = () => [place('newcastle', 'Newcastle', -1.61, 54.97), place('york', 'York', -1.08, 53.96), place('leeds', 'Leeds', -1.55, 53.8)];

test('flags and notes: set, taken away, read back; a note stays in the work file, never in what finishing writes', async () => {
  const { work } = await looked(THREE(), { Newcastle: NEWCASTLE, York: YORK });
  const c = candOf(work, 20);
  flag(work, c.id, true); noteOn(work, c.id, '  check the parish  ');
  assert.deepEqual([c.flagged, c.note], [true, 'check the parish']);
  const back = readWork(serialiseWork(work));
  assert.deepEqual([candOf(back, 20).flagged, candOf(back, 20).note], [true, 'check the parish']);
  decide(work, c.id, 'match', { at: NOW });
  const subjects = await detect([datasetFile(THREE())]);
  for (const output of ['dataset', 'attestations']) {
    const e = env();
    const done = await apply({ subjects, work: serialiseWork(work), options: { output, reviewer: REVIEWER } }, e);
    assert.equal(done.report.errors, 0, JSON.stringify(done.report.items));
    const text = outText(e, done.outputs[0].name);
    assert.ok(text.includes(W3ID + 'place:gn:20'), `${output}: control: the match is written`);
    assert.equal(text.includes('check the parish'), false, `${output}: the note is not`);
  }
  assert.ok(serialiseWork(work).includes('check the parish'), 'control: the note is in the work file');
  flag(work, c.id, false); noteOn(work, c.id, '');
  assert.deepEqual([c.flagged, c.note], [undefined, undefined]);
  assert.throws(() => flag(work, 'nope', true), /No candidate/);
});

test('FILTER: never looked up (selectPlaces skips it), still written', async () => {
  const { work } = await looked(THREE(), { Newcastle: NEWCASTLE, York: YORK });
  setRowState(work, A('york'), 'filter');
  const pick = (w) => selectPlaces({ work: w, which: 'all', service: WHG_SERVICE }).map((p) => p.iri);
  assert.deepEqual(pick(work), [A('newcastle'), A('leeds')]);
  setRowState(work, A('york'), null);
  assert.deepEqual(pick(work), [A('newcastle'), A('york'), A('leeds')], 'control: reconciled again, it is chosen');
  setRowState(work, A('york'), 'exclude');
  assert.deepEqual(pick(work), [A('newcastle'), A('leeds')], 'EXCLUDE: left out of the dataset, so not looked up either');
  setRowState(work, A('york'), 'filter');
  const g = await gathered(THREE());
  const fake = fakeWhg(byName({ Newcastle: NEWCASTLE, York: YORK }));
  await runLookup({ lookup: lookupWith(fake), work, places: g.places, options: { places: 'all' }, now: clock() });
  assert.deepEqual(fake.sent(), ['Newcastle', 'Leeds'], 'York is not sent');
  decide(work, candOf(work, 20).id, 'match', { at: NOW });
  const e = env();
  const done = await apply({ subjects: await detect([datasetFile(THREE())]), work: serialiseWork(work), options: { reviewer: REVIEWER } }, e);
  assert.equal(done.report.errors, 0, JSON.stringify(done.report.items));
  const out = JSON.parse(outText(e, done.outputs[0].name));
  assert.deepEqual(out.spatialEntities.map((p) => p['@id']), [A('newcastle'), A('york'), A('leeds')], 'York is still written');
  assert.equal(done.leftOut.length, 0);
  assert.throws(() => setRowState(work, A('york'), 'drop'), /Not a row state/);
});

test('EXCLUDE: finishing leaves the place out, lists it, and the version check expects exactly it missing', async () => {
  const { work } = await looked(THREE(), { Newcastle: NEWCASTLE, York: YORK });
  decide(work, candOf(work, 20).id, 'match', { at: NOW });
  decide(work, candOf(work, 21).id, 'match', { at: NOW });
  const subjects = await detect([datasetFile(THREE())]);
  const finish = async (output) => { const e = env(); const done = await apply({ subjects, work: serialiseWork(work), options: { output, reviewer: REVIEWER } }, e); return { done, text: done.outputs[0] ? outText(e, done.outputs[0].name) : '' }; };
  // Control: York is written, with its attestation, while it is reconciled.
  const kept = await finish('dataset');
  assert.equal(kept.done.report.errors, 0);
  assert.ok(JSON.parse(kept.text).spatialEntities.some((p) => p['@id'] === A('york')));
  assert.equal(kept.done.report.counts.versionCheck.leftOut, undefined, 'nothing told to the version check');
  setRowState(work, A('york'), 'exclude');
  assert.deepEqual(excludedPlaces(work), [A('york')]);
  const { done, text } = await finish('dataset');
  assert.equal(done.report.errors, 0, JSON.stringify(done.report.items));
  assert.deepEqual(JSON.parse(text).spatialEntities.map((p) => p['@id']), [A('newcastle'), A('leeds')], 'York left out');
  assert.deepEqual(done.leftOut, [A('york')]);
  const listed = done.report.items.find((i) => i.kind === 'left-out-by-reviewer');
  assert.deepEqual([listed.count, listed.examples], [1, [A('york')]]);
  assert.equal(done.report.counts.leftOut, 1);
  assert.equal(done.report.counts.versionCheck.leftOut, 2, "York's two attestations were expected missing");
  assert.equal(done.report.counts.versionCheck.lost, 0);
  assert.equal(done.attestations.some((m) => m.subject === A('york')), false, 'no attestation about York');
  assert.equal(kept.done.attestations.some((m) => m.subject === A('york')), true, 'control: there was one');
  const only = await finish('attestations');
  assert.equal(only.done.attestations.length, 1);
  assert.equal(only.text.includes(A('york')), false);
  assert.equal(readWork(serialiseWork(work)).places[A('york')].rowState, 'exclude', 'the row state reads back');
});

test('compare with expectMissing: exactly those places may be missing; any other loss still fails, and one still there is an error', async () => {
  const G = { '@id': X + 'g/1', title: 't', status: 'published' };
  const p = (id) => ({ '@id': `${X}place/${id}`, label: id, attestations: [{ '@id': `${X}att/${id}1`, names: [{ toponym: id }], sources: [src], created: NOW }] });
  const version = (ids, g = G) => textFile(JSON.stringify({ profile: 'place-centric', gazetteer: g, spatialEntities: ids.map(p) }), 'v.json');
  const cmp = async (later, expectMissing) => (await compare({ earlier: await detect([version(['a', 'b', 'c'])]), later: await detect([later]), options: expectMissing ? { expectMissing } : {} }, env())).report;
  const errorsOf = (r) => r.items.filter((i) => i.severity === 'error').map((i) => [i.kind, i.examples]);
  const without = await cmp(version(['c'], { ...G, '@id': X + 'g/2' }));
  assert.deepEqual(errorsOf(without), [['attestation-removed', [`${X}att/a1`, `${X}att/b1`]]], 'control: both losses found without it');
  const told = await cmp(version(['c'], { ...G, '@id': X + 'g/2' }), [`${X}place/a`]);
  assert.deepEqual(errorsOf(told), [['attestation-removed', [`${X}att/b1`]]], 'a expected, b still a loss');
  assert.equal(told.counts.leftOut, 1);
  const still = await cmp(version(['a', 'b', 'c'], { ...G, '@id': X + 'g/2' }), [`${X}place/a`]);
  assert.deepEqual(errorsOf(still), [['expected-missing-present', [`${X}place/a`]]]);
  assert.equal(without.counts.leftOut, undefined, 'the count only when told');
});

// ---- old work files ---------------------------------------------------------------------------------------------------
test('old work files still read; a candidate looked up before the guard was stored never passes; bad new fields are refused', async () => {
  const subjects = await detect([datasetFile(THREE())]);
  const others = await detect([textFile(JSON.stringify({ profile: 'place-centric', gazetteer: { title: 'B' }, spatialEntities: [{ '@id': X + 'b/n', label: 'Newcastle', attestations: [at(-1.6, 54.97)] }] }), 'b.json')]);
  const { work: local } = await match({ subjects, others, options: { now: NOW } }, env());
  const v1 = { ...local, krisis: 1 }; delete v1.lookups;
  const read1 = readWork(JSON.stringify(v1));
  assert.equal(read1.krisis, 2);
  assert.ok(read1.candidates.length > 0, 'control: it has candidates');
  assert.equal(guardOf(read1.candidates[0]).reason, 'not-recorded', 'a local candidate has no guard');
  // A version 2 file from before Methodos: the guard figures taken away.
  const { work } = await looked(PLACES(), TABLE);
  const old = JSON.parse(serialiseWork(work));
  for (const c of old.candidates) { delete c.gazetteer.dice; delete c.gazetteer.withheld; delete c.gazetteer.tie; }
  const back = readWork(JSON.stringify(old));
  assert.equal(guardOf(candOf(back, 1)).reason, 'not-recorded');
  assert.equal(guardOf(candOf(work, 1)).pass, true, 'control: with the figures, it passes');
  assert.deepEqual(acceptGuarded(back, { at: NOW }), { batch: null, accepted: 0, leftOut: { far: 0, ccodes: 0, total: 0 }, several: 0 });
  const refused = (f, re) => { const w = JSON.parse(serialiseWork(work)); f(w); assert.throws(() => readWork(JSON.stringify(w)), (e) => e.name === 'DataError' && re.test(e.message), re); };
  refused((w) => { w.places[A('alton')].rowState = 'drop'; }, /row state/);
  refused((w) => { w.candidates[0].flagged = 'yes'; }, /flag/);
  refused((w) => { w.candidates[0].note = 3; }, /note/);
  refused((w) => { w.candidates[0].gazetteer.tie = 'no'; }, /tied/);
  refused((w) => { w.candidates[0].decision = { kind: 'match', identityType: 'closeMatch', decided_at: NOW, batch: 'x1' }; w.candidates[0].candidate_status = 'confirmed'; }, /batch/);
  refused((w) => { w.lookups[0].queries[A('alton')].variants = [{ text: 'Elsewhere', how: 'given' }]; }, /variants/);
});

// ---- the command line: --variants, and the bulk accept's count on a dry run only ------------------------------------------
const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
test('the command line sends variants with --variants (dry run), and counts what passes WHG\'s guards without accepting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plato-tools-guards-')); dirs.push(dir);
  const { work } = await looked(PLACES(), TABLE);
  decide(work, candOf(work, 7).id, 'not-this', { at: NOW });   // Elton decided before
  const data = join(dir, 'a.json'), review = join(dir, 'a.krisis.json');
  writeFileSync(data, JSON.stringify(doc(PLACES())));
  // The work file as the dataset on disk makes it (its file records), with the lookup's candidates.
  const g = await gathered(PLACES());
  const text = serialiseWork({ ...work, subjects: g.subjects });
  writeFileSync(review, text);
  const env0 = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'WHG_TOKEN'));
  const run = (...args) => spawnSync(process.execPath, [CLI, 'lookup', '--dry-run', '--json', '--places', 'all', '--review', review, ...args, data], { encoding: 'utf8', env: env0 });
  const r = run('--variants');
  const out = JSON.parse(r.stdout.trim().split('\n')[0]);
  assert.equal(out.status, 'ok', r.stdout + r.stderr);
  assert.equal(out.preview.variants, true);
  assert.deepEqual(out.guarded, { pass: 2, leftOut: { far: 1, ccodes: 1, total: 2 }, several: 0 });
  assert.ok(out.warnings.some((w) => /on the page only/.test(w)));
  assert.equal(readFileSync(review, 'utf8'), text, 'the work file is untouched: nothing accepted');
  const plain = JSON.parse(run().stdout.trim().split('\n')[0]);
  assert.equal(plain.preview.variants, false, 'control: without --variants');
  const bad = spawnSync(process.execPath, [CLI, 'check', '--variants', data], { encoding: 'utf8', env: env0 });
  assert.notEqual(bad.status, 0, '--variants is for lookup');
});
