// Krisis, the region review on the page (src/krisis/region-page.js, drawn by src/app.js): the levels
// and how far each has come, where a region lies and what it was looked up within, the notes, the ways
// of relaxing and what each sends, what a change to a settled region would clear and how Undo puts it
// back, the places within; and that the page's choices are the command line's (lookup --levels).
// A fake fetch stands in for WHG: nothing here goes on the network.
//
// Every absence has a presence beside it: a note not shown is shown where it applies, a step not
// offered is offered where it changes something, a change that clears nothing beside one that does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, textFile } from './engine.js';
import { detect } from '../src/engine/input.js';
import { createLookup, memoryLedger, WHG_ENDPOINT } from '../src/engine/gazetteer/index.js';
import { gather } from '../src/engine/krisis/match.js';
import { serialiseWork } from '../src/engine/krisis/work.js';
import { newWork, runLevel, runPlaces } from '../src/engine/krisis/lookup.js';
import { seedRegions, decideRegion, settleRegion, undo, selectLevel, constraintFor, RELAX_NAMES, RELAX_ORDER, CERTAINTY_LEVELS } from '../src/engine/krisis/regions.js';
import { regionClaims } from '../src/engine/krisis/identity.js';
import {
  navigator, firstOpen, nextTarget, levelNames, levelLabel, chainOf, constraintLine, notesOf, relaxOptions, costOf, unsettledOf, placesToLook, lockedPlaces,
  wouldClear, priorOf, restorePrior, nameOf, certaintyChoices, CERTAINTY_DEFAULT, regionMatchOptions, regionDomId,
} from '../src/krisis/region-page.js';
import { REGION_PAGE as RP } from '../src/engine/words.js';

const BASE = 'https://example.org/suffolk/';
const W3ID = 'https://w3id.org/whg/id/';
const NOW = '2026-10-04T10:00:00Z';
const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const CSV = 'id,Name,Parish,County,Country\n1,Mill,Hoxne,Suffolk,England\n2,Farm,Eye,Suffolk,England\n3,Barn,Diss,Norfolk,England\n';
const NAMES = levelNames({ Country: 1, County: 2, Parish: 3 });

async function reviewOf() {
  const input = await detect([textFile(CSV, 'suffolk.csv')]);
  const g = await gather({ subjects: input, options: { base: BASE } }, env());
  return { g, work: seedRegions(newWork(g.subjects, { now: NOW }), g) };
}
const keyOf = (work, name) => { const k = Object.keys(work.regions).find((x) => work.regions[x].names[0] === name); assert.ok(k, name); return k; };
const C = (id, name, ccodes = ['GB']) => ({ id, name, score: 100, match: true, description: `Country: ${ccodes.join(', ')}`, ccodes, repr_point: [1, 52], namespace: id.split(':')[1], alt_names: [] });
const ANSWERS = {
  England: [C('place:gn:6269131', 'England'), C('place:wd:Q21', 'England')], Suffolk: [C('place:gn:2636561', 'Suffolk')], Norfolk: [C('place:gn:2641455', 'Norfolk')],
  Hoxne: [C('place:gn:2646340', 'Hoxne')], Eye: [C('place:gn:2649660', 'Eye')], Diss: [C('place:gn:2651188', 'Diss')], Farm: [C('place:gn:9000001', 'Farm')],
};
/** WHG as a fetch: each query answered by its name; `shut(q)` true answers it as a filter WHG could not apply (failed closed). */
function fakeWhg({ shut = () => false } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const out = { attribution: null };
    for (const [k, q] of Object.entries(body.queries)) {
      const filtered = Array.isArray(q.contained_in);
      out[k] = filtered && shut(q) ? { result: [], scope: { applied: false } } : { result: ANSWERS[q.query] ?? [], ...(filtered ? { scope: { applied: true } } : {}) };
    }
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { fetch, calls };
}
const PRIVATE = { get shared() { return false; }, get locks() { return null; }, get ledger() { return memoryLedger(); } };
const lookupWith = (fake) => createLookup({ endpoint: WHG_ENDPOINT, token: 'test-token', fetch: fake.fetch, sleep: () => Promise.resolve(), queryRate: null, entityRate: null, ...PRIVATE });
const cand = (work, key, id) => { const c = work.candidates.find((x) => x.candidate_source === key && x.candidate_candidate === W3ID + id); assert.ok(c, id); return c; };
const clock = () => { let n = 0; return () => new Date(Date.parse(NOW) + 1000 * n++).toISOString(); };

/** England matched, level 2 looked up. */
async function countiesLooked(fake = fakeWhg()) {
  const r = await reviewOf();
  const lookup = lookupWith(fake);
  await runLevel(r.work, 1, { lookup, now: clock() });
  const england = keyOf(r.work, 'England');
  decideRegion(r.work, cand(r.work, england, 'place:gn:6269131').id, 'match', { identityType: 'closeMatch', at: NOW });
  await runLevel(r.work, 2, { lookup, now: clock() });
  return { ...r, lookup, fake, england, suffolk: keyOf(r.work, 'Suffolk'), norfolk: keyOf(r.work, 'Norfolk') };
}

test('the navigator: each level by its column\'s heading, settled, open or locked, then the places; the level shown first, and the command line\'s', async () => {
  const { work } = await reviewOf();
  assert.deepEqual(navigator(work, NAMES).map((n) => n.text), ['Country 0/1', 'County locked', 'Parish locked', 'Places 0/3']);
  assert.equal(firstOpen(work), 1);
  assert.equal(nextTarget(work), 1);
  const r = await countiesLooked();
  assert.deepEqual(navigator(r.work, NAMES).map((n) => n.text), ['Country 1/1 settled', 'County 0/2', 'Parish locked', 'Places 0/3']);
  assert.equal(firstOpen(r.work), 2, 'County is in review: shown first');
  assert.equal(nextTarget(r.work), 'places', 'the command line looks up only what is READY: no county is (both are in review), and no place is either');
  decideRegion(r.work, cand(r.work, r.suffolk, 'place:gn:2636561').id, 'match', { at: NOW });
  assert.deepEqual(navigator(r.work, NAMES).map((n) => n.text), ['Country 1/1 settled', 'County 1/2', 'Parish 0/3', 'Places 0/3']);
  assert.equal(nextTarget(r.work), 3);
  // A level with no heading known is named by its number.
  assert.equal(levelLabel(4, NAMES), 'Level 4');
  assert.deepEqual(levelNames({ 'Place\u00003': 3, Country: 1 }), { 3: 'Place', 1: 'Country' }, 'a split column\'s part is named by its column');
});

test('where a region lies and what it was, or will be, looked up within, in words; the notes where they apply and not elsewhere', async () => {
  const { work, england, suffolk } = await countiesLooked();
  assert.equal(chainOf(work, suffolk), 'in England');
  assert.equal(chainOf(work, england), 'the widest level');
  assert.equal(chainOf(work, keyOf(work, 'Hoxne')), 'in England › Suffolk');
  assert.equal(constraintLine(work, england), 'Looked up with no constraint (no region above it is matched).');
  assert.equal(constraintLine(work, suffolk), 'Looked up within England (gn:6269131) and in GB.');
  assert.equal(constraintLine(work, keyOf(work, 'Hoxne')), 'To be looked up within England (gn:6269131) and in GB.', 'Suffolk not matched yet: England constrains');
  assert.equal(constraintLine(work, keyOf(work, 'Hoxne'), { relax: 'contained-in' }), 'To be looked up within the area around England (its outline is fetched from WHG first). Relaxed: an area in place of the gazetteer\'s region.');
  // The country filter's note: on Suffolk (countries sent), not on England (nothing sent).
  assert.deepEqual(notesOf(work, suffolk).map((n) => n.kind), ['uncoded']);
  assert.equal(notesOf(work, suffolk)[0].text, RP.uncoded);
  assert.deepEqual(notesOf(work, england), []);
  // Matched to two records: the union, said on the region.
  decideRegion(work, cand(work, england, 'place:wd:Q21').id, 'match', { at: NOW });
  assert.deepEqual(notesOf(work, england).map((n) => n.kind), ['union']);
  assert.match(notesOf(work, england)[0].text, /Matched to 2 records: .* the union of their areas/);
});

test('failed closed: the notice in plain words, never "no match", and a relax with no constraint asks again without it', async () => {
  const fake = fakeWhg({ shut: (q) => q.query === 'Hoxne' });
  const { work, lookup, suffolk } = await countiesLooked(fake);
  decideRegion(work, cand(work, suffolk, 'place:gn:2636561').id, 'match', { at: NOW });
  await runLevel(work, 3, { lookup, now: clock() });
  const hoxne = keyOf(work, 'Hoxne'), eye = keyOf(work, 'Eye');
  const n = notesOf(work, hoxne);
  assert.deepEqual(n.map((x) => x.kind), ['failed-closed', 'uncoded']);
  assert.equal(n[0].text, "WHG could not narrow this search to Suffolk, so it returned nothing. That is not 'no match': look it up again with the constraint relaxed.");
  assert.ok(!notesOf(work, eye).some((x) => x.kind === 'failed-closed'), 'control: Eye, answered, has no such notice');
  assert.deepEqual(unsettledOf(work, 3).sort(), [hoxne, eye].sort(), 'Diss waits for Norfolk: not among them');
  // The steps offered for Hoxne: each changes what it would be asked with; England is the region further up.
  const steps = relaxOptions(work, [hoxne]);
  assert.deepEqual(steps.map((s) => s.relax), ['countries', 'contained-in', 'ancestor', 'all']);
  assert.deepEqual(steps.map((s) => s.text), ['Again without the countries', 'Within the area instead', 'Within England instead', 'With no constraint']);
  // The label says what is sent: "Within England" is England's ids, with its countries.
  const up = constraintFor(work, hoxne, { relax: 'ancestor' });
  assert.deepEqual([up.kinds, up.params.contained_in, up.params.countries], [['contained_in', 'countries'], ['gn:6269131'], ['GB']]);
  assert.deepEqual(costOf(work, [hoxne], { relax: 'ancestor' }).fetches, 0, 'no area fetched for it');
  // England matched to a record with no gazetteer id: its area is what is sent, and the button says so.
  const eng = work.candidates.find((c) => c.candidate_source === keyOf(work, 'England') && c.decision?.kind === 'match');
  const id = eng.gazetteer.id;
  delete eng.gazetteer.id;
  assert.deepEqual(constraintFor(work, hoxne, { relax: 'ancestor' }).needsArea, keyOf(work, 'England'));
  assert.equal(relaxOptions(work, [hoxne]).find((s) => s.relax === 'ancestor').text, 'Within the area around England instead');
  eng.gazetteer.id = id;
  // Its cost, as planned, is what runLevel then sends: one query in one request.
  assert.deepEqual(costOf(work, [hoxne], { relax: 'all' }), { queries: 1, requests: 1, fetches: 0 });
  const before = fake.calls.length;
  await runLevel(work, 3, { lookup, relax: 'all', only: [hoxne], now: clock() });
  assert.equal(fake.calls.length, before + 1);
  assert.deepEqual(Object.values(fake.calls.at(-1).queries), [{ query: 'Hoxne', type: 'Place', limit: 10 }], 'asked again without the constraint');
  assert.deepEqual(notesOf(work, hoxne), [], 'the notice is gone');
  assert.equal(constraintLine(work, hoxne), 'Looked up with no constraint. Relaxed: no constraint.');
  // For a county, there is no region further up but England: no "within … instead" step.
  const { work: w2, norfolk } = await countiesLooked();
  assert.deepEqual(relaxOptions(w2, [norfolk]).map((s) => s.relax), ['countries', 'contained-in', 'all']);
  assert.deepEqual(relaxOptions(w2, [keyOf(w2, 'England')]), [], 'nothing to relax where nothing constrains');
  // A level's cost: its regions in requests of the lookup's size.
  assert.deepEqual(costOf(w2, unsettledOf(w2, 2), { relax: 'countries', batchSize: 1 }), { queries: 2, requests: 2, fetches: 0 });
  assert.deepEqual(costOf(w2, unsettledOf(w2, 2), { relax: 'contained-in' }).fetches, 1, 'the area of England\'s one match is fetched first');
});

test('a change to a settled region: what it would clear, tried on a copy; then Undo puts back what was cleared and the change itself', async () => {
  const { work, lookup, england, suffolk, norfolk, g } = await countiesLooked();
  decideRegion(work, cand(work, suffolk, 'place:gn:2636561').id, 'match', { at: NOW });
  settleRegion(work, norfolk, 'no-match');
  await runLevel(work, 3, { lookup, now: clock() });
  decideRegion(work, cand(work, keyOf(work, 'Eye'), 'place:gn:2649660').id, 'match', { at: NOW });
  // A first settlement clears nothing, and is not asked.
  const diss = keyOf(work, 'Diss');
  assert.equal(wouldClear(work, (w) => decideRegion(w, cand(w, diss, 'place:gn:2651188').id, 'match', { at: NOW }).snapshot), null);
  const before = serialiseWork(work);
  const change = (w) => decideRegion(w, cand(w, england, 'place:wd:Q21').id, 'match', { at: NOW }).snapshot;
  const counts = wouldClear(work, change);
  assert.deepEqual(counts, { regions: 5, places: 3, decisions: 2, candidates: 5 });
  assert.equal(serialiseWork(work), before, 'trying it changed nothing');
  assert.equal(RP.confirm(counts.decisions, counts.candidates, nameOf(work, england)), 'This clears 2 decisions and 5 candidates below England.');
  // Made: the same counts; then Undo.
  const prior = priorOf(work, england);
  const snap = change(work);
  assert.deepEqual(snap.counts, counts);
  assert.equal(work.regions[suffolk].outcome, null);
  assert.equal(work.regions[norfolk].outcome, null);
  undo(work, snap); restorePrior(work, england, prior);
  assert.equal(serialiseWork(work), before, 'everything back, England\'s own decision too');
  // Saying a matched region has none is refused, in the engine's words.
  assert.throws(() => wouldClear(work, (w) => settleRegion(w, england, 'no-match')), /take it back/);
  // The places within: those runPlaces would look up, and those waiting, with the region they wait for.
  assert.deepEqual(placesToLook(work, { places: g.places }), [`${BASE}place/2`]);
  const r = await runPlaces(work, { lookup, places: g.places, now: clock() });
  assert.deepEqual(r.looked.map((x) => x.key), [`${BASE}place/2`], 'the page\'s count is runPlaces\'s choice');
  const locked = lockedPlaces(work);
  assert.deepEqual(locked.map((p) => [p.label, nameOf(work, p.region)]), [['Mill', 'Hoxne'], ['Barn', 'Diss']]);
  assert.deepEqual(placesToLook(work, { places: g.places, unconstrained: true, only: locked.map((p) => p.iri) }), locked.map((p) => p.iri));
  assert.equal(RP.lockedReason('Hoxne', levelLabel(3, NAMES)), 'waiting for Hoxne (Parish) to be settled');
});

test('the page\'s choices are the command line\'s: the same level looked up, the same regions and constraints, and every relax step it offers is one the command line takes', async () => {
  const { work } = await countiesLooked();
  const d = mkdtempSync(join(tmpdir(), 'plato-tools-region-page-'));
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, WHG_TOKEN: '' } });
  try {
    writeFileSync(join(d, 'suffolk.csv'), CSV);
    writeFileSync(join(d, 'review.krisis.json'), serialiseWork(work));
    for (const relax of [undefined, 'countries']) {
      const r = cli('lookup', '--levels', '--dry-run', '--json', '--base', BASE, '--review', join(d, 'review.krisis.json'), '--level', '2', ...(relax ? ['--relax', relax] : []), join(d, 'suffolk.csv'));
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const j = JSON.parse(r.stdout);
      const level2 = j.regionPlan.levels.find((l) => l.level === 2);
      // The command line plans only READY regions; the page's level button sends the same (selectLevel), its relax buttons the unsettled.
      assert.deepEqual(level2.ready.map((x) => x.key), selectLevel(work, 2).map((n) => n.key));
      assert.deepEqual(j.regionPlan.levels.map((l) => l.states), [{ locked: 0, ready: 0, review: 0, settled: 1 }, { locked: 0, ready: 0, review: 2, settled: 0 }, { locked: 3, ready: 0, review: 0, settled: 0 }]);
      assert.deepEqual(navigator(work, NAMES).slice(0, 3).map((n) => [n.settled, n.review, n.locked]), [[1, 0, 0], [0, 2, 0], [0, 0, 3]], 'the page counts the levels as the command line does');
    }
    // Before England is looked up, both send level 1 first, with the same (no) constraint.
    const fresh = await reviewOf();
    const r = JSON.parse(cli('lookup', '--levels', '--dry-run', '--json', '--base', BASE, join(d, 'suffolk.csv')).stdout);
    assert.equal(r.region.target, nextTarget(fresh.work));
    assert.equal(r.region.target, firstOpen(fresh.work));
    assert.deepEqual(r.regionPlan.levels[0].ready.map((x) => [x.key, x.kinds]), selectLevel(fresh.work, 1).map((n) => [n.key, []]));
  } finally { rmSync(d, { recursive: true, force: true }); }
  for (const step of RELAX_ORDER) assert.ok(RELAX_NAMES.includes(step), `${step} is a --relax the command line takes`);
  assert.deepEqual(Object.keys(RP.relax), RELAX_ORDER, 'a button for each step, in order');
});

test('certainty: PLATO\'s certainty levels, checked against the vendored ontology, the worked example\'s by default; the claim carries the one chosen', async () => {
  const ttl = readFileSync('public/plato/ontology.ttl', 'utf8');
  const choices = certaintyChoices();
  assert.deepEqual(choices.map((c) => c.value), ['certain', 'less-certain', 'uncertain']);
  for (const c of choices) {
    const local = c.iri.replace('https://w3id.org/plato#', '');
    assert.match(ttl, new RegExp(`^plato:${local}\\s+a plato:CertaintyLevel\\b`, 'm'), `${c.iri} is a CertaintyLevel of the vendored ontology`);
    assert.ok(c.text, `${c.value} has words`);
  }
  assert.doesNotMatch(ttl, /^plato:Doubtful\s+a plato:CertaintyLevel\b/m, 'control: the check can fail');
  assert.equal(CERTAINTY_LEVELS[CERTAINTY_DEFAULT], 'https://w3id.org/plato#Certain', "the default is the level PLATO's worked example gives");
  for (const certainty of ['less-certain', 'uncertain', 'certain']) {
    const { work, england } = await countiesLooked();
    work.reviewer = { name: 'A. Reviewer' };
    decideRegion(work, cand(work, england, 'place:gn:6269131').id, 'match', regionMatchOptions({ identityType: 'closeMatch', certainty }));
    const claim = regionClaims(work).made.find((m) => m.subject === england).attestation;
    assert.equal(claim.certaintyLevel, CERTAINTY_LEVELS[certainty], `the claim is ${certainty}, as chosen`);
    assert.equal(claim.identities[0].identityType, 'closeMatch');
  }
  assert.equal(regionMatchOptions({ identityType: 'exactMatch' }).certainty, CERTAINTY_DEFAULT, 'nothing chosen: the default');
});

test('a region\'s heading id is short and safe for aria-labelledby whatever its key; the key stays in data-rkey', () => {
  const keys = ['1\u0000England', '3\u0000Newton\u0000England\u0000Cheshire', 'Saint "Mary\'s" Church, Ely', 'https://example.org/suffolk/place/region-abc', ''];
  const ids = keys.map(regionDomId);
  for (const id of ids) assert.match(id, /^rh-[0-9a-z]{1,7}$/, `${id}: no spaces, quotes or other characters an id reference cannot carry`);
  assert.equal(new Set(ids).size, keys.length, 'distinct keys, distinct ids');
  assert.equal(regionDomId(keys[2]), ids[2], 'stable');
  assert.doesNotMatch(`rh-${keys[2]}`, /^rh-[0-9a-z]{1,7}$/, 'control: the key itself fails the check');
});
