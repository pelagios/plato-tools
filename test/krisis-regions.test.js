// Krisis, region review (Methodos #28, stages 3 and 4; src/engine/krisis/regions.js, lookup.js runLevel
// and runPlaces, identity.js regionClaims): the regions a table's places lie in, read through Hermes,
// looked up level by level from the widest, each constrained by the match of the region above it; then
// the places within them. A fake fetch stands in for WHG, so nothing here goes on the network; the
// shared gazetteer module is used as it is.
//
// Every absence has a presence beside it: a filter not sent is shown sent where it applies, a request
// not overlapping is measured by a fake that does see overlap, a thing not cleared is shown cleared by
// the change that should clear it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { addPlatoFormats, strictFormatLogger } from '../src/lib/formats.js';
import { env, textFile } from './engine.js';
import { PLATO_REPO } from './paths.js';
import { detect } from '../src/engine/input.js';
import { createLookup, memoryLedger, WHG_ENDPOINT } from '../src/engine/gazetteer/index.js';
import { gather, match } from '../src/engine/krisis/match.js';
import { readWork, serialiseWork, decide, WORK_VERSION } from '../src/engine/krisis/work.js';
import { newWork, runLevel, runPlaces, runLookup, failedClosed } from '../src/engine/krisis/lookup.js';
import {
  seedRegions, regionNodes, regionState, placeState, constraintFor, relaxStep, invalidate, undo, decideRegion, settleRegion, areaOf, bareId,
  planLevels, levelsOf, RELAX_NAMES, CERTAINTY_LEVELS, areaIds, relaxAvailable,
} from '../src/engine/krisis/regions.js';
import { attestationsFrom, regionClaims } from '../src/engine/krisis/identity.js';
import { apply } from '../src/engine/krisis/apply.js';
import { containerKey } from '../src/engine/hermes/within.js';
import { regionId } from '../src/engine/hermes/generic.js';
import { REGION_WORDS } from '../src/engine/words.js';

const BASE = 'https://example.org/parishes/';
const W3ID = 'https://w3id.org/whg/id/';
const REVIEWER = { name: 'A. Reviewer' };
const NOW = '2026-10-04T10:00:00Z';
const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const regionIri = (level, value, parents = []) => `${BASE}place/${regionId(containerKey(level, value, parents))}`;

// ---- a small table, read through Hermes ----------------------------------------------------------------
// Two parishes called Newton in two counties (two regions), one Newton named twice (one region), and a
// row with no parish (a gap: the farm lies in its county).
const CSV = 'id,Name,Parish,County,Country\n'
  + '1,Mill,Newton,Lancashire,England\n2,Farm,Newton,Cheshire,England\n3,Barn,Newton,Cheshire,England\n4,Kirk,,Cheshire,England\n';
async function reviewOf(csv = CSV, { base = BASE } = {}) {
  const input = await detect([textFile(csv, 'parishes.csv')]);
  const g = await gather({ subjects: input, options: { ...(base ? { base } : {}) } }, env());
  assert.equal(g.incomplete, undefined);
  const work = seedRegions(newWork(g.subjects, { now: NOW, reviewer: REVIEWER }), g);
  return { g, work, input };
}
const keyOf = (work, label) => { const k = Object.keys(work.regions).find((x) => work.regions[x].label === label); assert.ok(k, `a region labelled ${label}`); return k; };

// ---- a fake WHG -----------------------------------------------------------------------------------------
const C = (id, name, ccodes = ['GB'], more = {}) => ({ id, name, score: 100, match: true, description: `Country: ${ccodes.join(', ')}`, ccodes, repr_point: [-2, 53], namespace: id.split(':')[1], alt_names: [], ...more });
const ANSWERS = {
  England: [C('place:gn:6269131', 'England'), C('place:wd:Q21', 'England')],
  Cheshire: [C('place:gn:2653941', 'Cheshire')],
  Lancashire: [C('place:gn:2644974', 'Lancashire')],
  Newton: [C('place:gn:2641434', 'Newton'), C('place:gn:2641435', 'Newton')],
  Farm: [C('place:gn:9000001', 'Farm')], Barn: [C('place:gn:9000002', 'Barn')], Mill: [C('place:gn:9000003', 'Mill')], Kirk: [C('place:gn:9000004', 'Kirk')],
};
/** An LPF Feature as WHG's entity endpoint gives one: a box-shaped polygon. */
const feature = (w, s, e, n) => ({ type: 'Feature', geometry: { type: 'GeometryCollection', geometries: [{ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }] } });
const FEATURES = { 'place:gn:6269131': feature(-6, 50, 2, 56), 'place:wd:Q21': feature(-5, 49.9, 1.8, 55.8), 'place:gn:2653941': feature(-3.1, 52.9, -1.9, 53.5) };
/**
 * A fetch that answers as WHG would. POST: each query by its name, with `scope` for a filtered one
 * (`scope(q)` gives it; applied by default). GET: an entity, by the id in its address. Every call is
 * kept, with how many were in flight at once (each waits `delay` ms).
 */
function fakeWhg({ answers = ANSWERS, scope = () => ({ applied: true }), delay = 0 } = {}) {
  const calls = [], entities = [];
  let inFlight = 0, maxInFlight = 0;
  const fetch = async (url, init = {}) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (init.method === 'GET') {
        const id = decodeURIComponent(/\/entity\/([^/]+)\/api/.exec(String(url))[1]);
        entities.push(id);
        return FEATURES[id] ? new Response(JSON.stringify(FEATURES[id]), { status: 200 }) : new Response(JSON.stringify({ type: 'Feature', geometry: null }), { status: 200 });
      }
      const body = JSON.parse(init.body);
      calls.push(body);
      const out = { attribution: null };
      for (const [k, q] of Object.entries(body.queries)) {
        const filtered = Array.isArray(q.contained_in) || q.radius !== undefined;
        const s = filtered ? scope(q) : null;
        out[k] = { result: s && s.applied === false && s.empty ? [] : answers[q.query] ?? [], ...(s ? { scope: { applied: s.applied, ...(s.approximate ? { approximate: true } : {}) } } : {}) };
      }
      return new Response(JSON.stringify(out), { status: 200 });
    } finally { inFlight--; }
  };
  return { fetch, calls, entities, get maxInFlight() { return maxInFlight; } };
}
const PRIVATE = { get shared() { return false; }, get locks() { return null; }, get ledger() { return memoryLedger(); } };
const lookupWith = (fake, more = {}) => createLookup({ endpoint: WHG_ENDPOINT, token: 'test-token', fetch: fake.fetch, sleep: () => Promise.resolve(), queryRate: null, entityRate: null, ...PRIVATE, ...more });
const clock = () => { let n = 0; return () => new Date(Date.parse(NOW) + 1000 * n++).toISOString(); };
const candidateFor = (work, key, id) => { const c = work.candidates.find((x) => x.candidate_source === key && x.candidate_candidate === W3ID + id); assert.ok(c, `a candidate ${id} for ${key}`); return c; };
const queriesOf = (body) => Object.values(body.queries);

/** The review taken to: England matched (to `englands`), and level 2 looked up. */
async function englandMatched({ englands = ['place:gn:6269131'], fake = fakeWhg() } = {}) {
  const r = await reviewOf();
  const lookup = lookupWith(fake);
  await runLevel(r.work, 1, { lookup, now: clock() });
  const england = keyOf(r.work, 'England');
  for (const id of englands) decideRegion(r.work, candidateFor(r.work, england, id).id, 'match', { identityType: 'closeMatch', at: NOW });
  return { ...r, lookup, fake, england };
}

// ---- the nodes ---------------------------------------------------------------------------------------------
test('identical containers are one region and namesakes under different parents are two, keyed by the minted address, or the containerKey without a base', async () => {
  const { g, work } = await reviewOf();
  const newtons = Object.entries(work.regions).filter(([, r]) => r.names[0] === 'Newton');
  assert.equal(newtons.length, 2, 'Newton in Lancashire and Newton in Cheshire are two regions');
  const cheshireNewton = work.regions[regionIri(3, 'Newton', ['England', 'Cheshire'])];
  assert.ok(cheshireNewton, 'keyed by the address Hermes minted for it');
  assert.equal(cheshireNewton.count, 2, 'the Newton in Cheshire named twice is one region, counted twice');
  assert.equal(cheshireNewton.container, containerKey(3, 'Newton', ['England', 'Cheshire']));
  assert.equal(cheshireNewton.within, regionIri(2, 'Cheshire', ['England']));
  assert.equal(work.regions[regionIri(2, 'Cheshire', ['England'])].count, 3, 'Cheshire: the Farm, the Barn and the Kirk (whose parish is empty)');
  assert.equal(work.regions[regionIri(1, 'England')].within, null);
  assert.deepEqual(levelsOf(work), [1, 2, 3]);
  assert.equal(Object.keys(work.regions).length, 5);
  // Each place lies in its narrowest region; the Kirk, with no parish, in its county.
  assert.deepEqual(Object.fromEntries(g.places.map((p) => [p.label, [p.within, p.level]])), {
    Mill: [regionIri(3, 'Newton', ['England', 'Lancashire']), 3], Farm: [regionIri(3, 'Newton', ['England', 'Cheshire']), 3],
    Barn: [regionIri(3, 'Newton', ['England', 'Cheshire']), 3], Kirk: [regionIri(2, 'Cheshire', ['England']), 2] });
  assert.ok(!g.places.some((p) => p.iri.includes('/place/region-')), 'the minted regions are not places');
  assert.equal(readWork(serialiseWork(work)).krisis, WORK_VERSION, 'the seeded review reads back');
  // Without a base address: the same regions, keyed by their containerKeys.
  const plain = await reviewOf(CSV, { base: null });
  assert.deepEqual(Object.keys(plain.work.regions).sort(), Object.values(work.regions).map((r) => r.container).sort());
  assert.equal(plain.work.regions[containerKey(3, 'Newton', ['England', 'Cheshire'])].count, 2);
});

test('each region is gated by its own parent: locked, ready, review, settled', async () => {
  const { work, england } = await englandMatched();
  const cheshire = keyOf(work, 'Cheshire (England)'), newton = regionIri(3, 'Newton', ['England', 'Cheshire']);
  assert.equal(regionState(work, england), 'settled');
  assert.equal(regionState(work, cheshire), 'ready');
  assert.equal(regionState(work, newton), 'locked', 'its parent, Cheshire, is not settled');
  assert.equal(regionState(work, keyOf(work, 'Lancashire (England)')), 'ready');
  settleRegion(work, cheshire, 'no-match');
  assert.equal(regionState(work, newton), 'ready', 'Cheshire settled with no match: its Newton is unlocked');
  assert.equal(regionState(work, keyOf(work, 'Newton (Lancashire, England)')), 'locked', 'control: the other Newton waits for Lancashire');
  assert.deepEqual(regionNodes(work).map((n) => n.level), [1, 2, 2, 3, 3]);
});

// ---- the constraint ------------------------------------------------------------------------------------
test('constraintFor: contained_in as a list of bare ids from the nearest matched region, several unioned, with its countries; every relaxation in order', async () => {
  const { work, england } = await englandMatched({ englands: ['place:gn:6269131', 'place:wd:Q21'] });
  const cheshire = keyOf(work, 'Cheshire (England)');
  assert.deepEqual(bareId('place:gn:2635167'), 'gn:2635167');
  // Nothing above England: no constraint (the control for every constraint below).
  assert.deepEqual(constraintFor(work, england), { from: null, kinds: [], params: {}, relaxed: null });
  // Two matches: the union of their ids, the countries of both, and the note that countries are ANDed.
  const full = constraintFor(work, cheshire);
  assert.deepEqual({ ...full }, { from: england, kinds: ['contained_in', 'countries'], params: { contained_in: ['gn:6269131', 'wd:Q21'], countries: ['GB'] }, relaxed: null, uncodedFail: true });
  assert.equal(full.params.lat, undefined, 'one spatial filter: WHG does not combine them');
  // 1. countries dropped.
  assert.deepEqual(constraintFor(work, cheshire, { relax: 'countries' }), { from: england, kinds: ['contained_in'], params: { contained_in: ['gn:6269131', 'wd:Q21'] }, relaxed: 'countries' });
  // 2. the area in place of contained_in: first it must be fetched; then it is sent as lat/lng/radius.
  assert.equal(constraintFor(work, cheshire, { relax: 'contained-in' }).needsArea, england);
  const area = areaOf([FEATURES['place:gn:6269131'], FEATURES['place:wd:Q21']], ['place:gn:6269131', 'place:wd:Q21']);
  assert.deepEqual(area.bbox, [-6, 49.9, 2, 56], 'the union of both boxes');
  work.regions[england].area = area;
  const byArea = constraintFor(work, cheshire, { relax: 'area' });   // "area" is the same step
  assert.deepEqual(byArea, { from: england, kinds: ['area'], params: { lat: area.lat, lng: area.lng, radius: area.radius }, relaxed: 'contained-in' });
  assert.equal(byArea.params.contained_in, undefined);
  assert.ok(area.radius > 300 && area.radius < 600, `a radius reaching the corners: ${area.radius}`);
  // An area made from other matches is not used: it is fetched again.
  work.regions[england].area = { ...area, from: ['place:gn:6269131'] };
  assert.equal(constraintFor(work, cheshire, { relax: 'area' }).needsArea, england);
  // A match with no geometry gives no area, and says so.
  work.regions[england].area = { none: 'no-geometry', from: ['place:gn:6269131', 'place:wd:Q21'] };
  const noArea = constraintFor(work, cheshire, { relax: 'area' });
  assert.deepEqual([noArea.kinds, noArea.noArea], [[], 'no-geometry']);
  assert.ok(REGION_WORDS.noArea[noArea.noArea]);
  work.regions[england].area = area;
  // 3. the next ancestor up: for Newton in Cheshire (Cheshire matched), England's area.
  await runLevel(work, 2, { lookup: lookupWith(fakeWhg()), now: clock() });
  decideRegion(work, candidateFor(work, cheshire, 'place:gn:2653941').id, 'match', { at: NOW });
  const newton = regionIri(3, 'Newton', ['England', 'Cheshire']);
  assert.deepEqual(constraintFor(work, newton).params.contained_in, ['gn:2653941'], 'the nearest: Cheshire');
  // England constrains as it would with nothing relaxed: its ids and its countries, not its area with the countries dropped.
  assert.deepEqual(constraintFor(work, newton, { relax: 'ancestor' }), { from: england, kinds: ['contained_in', 'countries'], params: { contained_in: ['gn:6269131', 'wd:Q21'], countries: ['GB'] }, relaxed: 'ancestor', uncodedFail: true });
  assert.deepEqual(constraintFor(work, cheshire, { relax: 'ancestor' }), { from: null, kinds: [], params: {}, relaxed: 'ancestor' }, 'no ancestor above England');
  // 4. no constraint.
  assert.deepEqual(constraintFor(work, newton, { relax: 'all' }), { from: null, kinds: [], params: {}, relaxed: 'all' });
  // A region settled with no match is passed over: the one above it constrains.
  const lancs = keyOf(work, 'Lancashire (England)');
  settleRegion(work, lancs, 'no-match');
  assert.equal(constraintFor(work, regionIri(3, 'Newton', ['England', 'Lancashire'])).from, england);
  // A place within: by its narrowest matched region.
  const farm = `${BASE}place/2`;
  assert.deepEqual(constraintFor(work, farm).params.contained_in, ['gn:2653941']);
  assert.deepEqual(RELAX_NAMES, ['countries', 'contained-in', 'area', 'ancestor', 'all']);
  assert.throws(() => relaxStep('nearby'), /--relax nearby is not one of/);
  // A match with no country recorded adds no countries, and so no note that a candidate without one cannot pass.
  const uncoded = await englandMatched({ fake: fakeWhg({ answers: { ...ANSWERS, England: [C('place:gn:6269131', 'England', [])] } }) });
  const c = constraintFor(uncoded.work, keyOf(uncoded.work, 'Cheshire (England)'));
  assert.deepEqual([c.kinds, c.uncodedFail], [['contained_in'], undefined]);
});

test('the request for the next level carries contained_in as a list, and the countries, never an area beside it; level 1 carries neither', async () => {
  const { work, fake, lookup } = await englandMatched();
  const first = queriesOf(fake.calls[0]);
  assert.deepEqual(first, [{ query: 'England', type: 'Place', limit: 10 }], 'level 1: nothing to constrain it');
  const r = await runLevel(work, 2, { lookup, now: clock() });
  assert.equal(r.stopped, null);
  const second = queriesOf(fake.calls.at(-1));
  assert.deepEqual(second.map((q) => q.query).sort(), ['Cheshire', 'Lancashire']);
  for (const q of second) {
    assert.deepEqual(q.contained_in, ['gn:6269131']);
    assert.ok(Array.isArray(q.contained_in), 'a list, not a string');
    assert.deepEqual(q.countries, ['GB']);
    assert.equal(q.type, 'Place');
    assert.ok(!('lat' in q) && !('radius' in q) && !('bbox' in q) && !('bounds' in q));
  }
  // The query record keeps the constraint; the answers are the region's, not a place's.
  const cheshire = keyOf(work, 'Cheshire (England)');
  assert.deepEqual(r.record.queries[cheshire].constraint, { from: keyOf(work, 'England'), kinds: ['contained_in', 'countries'], params: { contained_in: ['gn:6269131'], countries: ['GB'] }, relaxed: null });
  assert.deepEqual(r.record.queries[cheshire].scope, { applied: true, approximate: false });
  assert.ok(work.candidates.some((c) => c.candidate_source === cheshire), 'Cheshire has candidates');
  assert.ok(!Object.hasOwn(work.places, cheshire), 'and is not listed as a place');
  assert.equal(regionState(work, cheshire), 'review');
  assert.ok(readWork(serialiseWork(work)));
});

test('the places within (stage 4): only those whose regions are settled, each by its narrowest matched region; a locked place only when asked for unconstrained', async () => {
  const { g, work, lookup, fake } = await englandMatched();
  const cheshire = keyOf(work, 'Cheshire (England)');
  await runLevel(work, 2, { lookup, now: clock() });
  decideRegion(work, candidateFor(work, cheshire, 'place:gn:2653941').id, 'match', { at: NOW });
  // The Kirk lies in Cheshire (no parish): its chain is settled. The rest lie in parishes not yet settled.
  assert.deepEqual(g.places.map((p) => placeState(work, p.iri, p)), ['locked', 'locked', 'locked', 'ready']);
  const r = await runPlaces(work, { lookup, places: g.places, now: clock() });
  assert.deepEqual(r.looked.map((x) => x.key), [`${BASE}place/4`]);
  assert.deepEqual(queriesOf(fake.calls.at(-1)), [{ contained_in: ['gn:2653941'], countries: ['GB'], query: 'Kirk', type: 'Place', limit: 10 }]);
  // Control: asked for unconstrained, the locked places are looked up too, with no constraint, and their records say so.
  const u = await runPlaces(work, { lookup, places: g.places, unconstrained: true, now: clock() });
  assert.deepEqual(u.looked.map((x) => x.key), [`${BASE}place/1`, `${BASE}place/2`, `${BASE}place/3`]);
  assert.ok(queriesOf(fake.calls.at(-1)).every((q) => !q.contained_in && !q.countries));
  assert.equal(u.record.queries[`${BASE}place/1`].constraint.relaxed, 'unconstrained');
  assert.equal(work.places[`${BASE}place/1`].within, regionIri(3, 'Newton', ['England', 'Lancashire']));
  assert.ok(readWork(serialiseWork(work)));
});

// ---- the queue -------------------------------------------------------------------------------------------
test('a level of 60 regions goes in batches of at most 25, one request in flight (and two lookups, measured the same way, do overlap)', async () => {
  const counties = Array.from({ length: 60 }, (_, i) => `County ${i + 1}`);
  const csv = 'id,Name,County,Country\n' + counties.map((c, i) => `${i + 1},Place ${i + 1},${c},England\n`).join('');
  const { work } = await reviewOf(csv);
  const fake = fakeWhg({ delay: 3, answers: { ...ANSWERS, ...Object.fromEntries(counties.map((c, i) => [c, [C(`place:gn:${700 + i}`, c)]])) } });
  const lookup = lookupWith(fake);
  await runLevel(work, 1, { lookup, now: clock() });
  decideRegion(work, candidateFor(work, keyOf(work, 'England'), 'place:gn:6269131').id, 'match', { at: NOW });
  // Two callers at once on the one lookup: still one request in flight.
  await Promise.all([runLevel(work, 2, { lookup, now: clock() }), lookup.reconcile([{ query: 'Elsewhere' }])]);
  const level2 = fake.calls.slice(1).filter((b) => queriesOf(b).some((q) => q.contained_in));
  assert.deepEqual(level2.map((b) => queriesOf(b).length), [25, 25, 10]);
  assert.ok(fake.calls.every((b) => queriesOf(b).length <= 25));
  assert.equal(fake.maxInFlight, 1);
  // The same measure where overlap is allowed (two lookups) must see it, or the 1 above proves nothing.
  const apart = fakeWhg({ delay: 5 });
  await Promise.all([lookupWith(apart).reconcile([{ query: 'England' }]), lookupWith(apart).reconcile([{ query: 'England' }])]);
  assert.equal(apart.maxInFlight, 2);
});

test('an area is fetched once per region whose match it is (entity() of each record), kept, and fetched again only when the match changes', async () => {
  const { work, fake, lookup, england } = await englandMatched({ englands: ['place:gn:6269131', 'place:wd:Q21'] });
  assert.deepEqual(fake.entities, [], 'control: nothing fetched while contained_in will do');
  // Both counties need England's area (relaxed): each of England's two records is fetched once, not once per county.
  const r = await runLevel(work, 2, { lookup, relax: 'area', now: clock() });
  assert.deepEqual(fake.entities.sort(), ['place:gn:6269131', 'place:wd:Q21']);
  assert.equal(r.looked.length, 2);
  assert.deepEqual(work.regions[england].area.bbox, [-6, 49.9, 2, 56]);
  for (const q of queriesOf(fake.calls.at(-1))) assert.deepEqual([q.lat, q.lng, q.radius, q.contained_in], [work.regions[england].area.lat, work.regions[england].area.lng, work.regions[england].area.radius, undefined]);
  // Asked again (one county, still to review): the area kept is used, nothing fetched.
  await runLevel(work, 2, { lookup, relax: 'area', only: [keyOf(work, 'Cheshire (England)')], now: clock() });
  assert.equal(fake.entities.length, 2);
  // England's match changed (one record taken back): the area is of other matches now, and is fetched again.
  decideRegion(work, candidateFor(work, england, 'place:wd:Q21').id, null);
  await runLevel(work, 2, { lookup, relax: 'area', only: [keyOf(work, 'Cheshire (England)')], now: clock() });
  assert.deepEqual(fake.entities.slice(2), ['place:gn:6269131']);
});

test('a filter the gazetteer could not apply that answered nothing is recorded as failed closed, never as "no match"; one applied that found nothing is "no candidates"', async () => {
  const shut = fakeWhg({ scope: () => ({ applied: false, empty: true }) });
  const { work, lookup } = await englandMatched({ fake: shut });
  const r = await runLevel(work, 2, { lookup, now: clock() });
  const cheshire = keyOf(work, 'Cheshire (England)');
  const q = r.record.queries[cheshire];
  assert.deepEqual([q.state, q.failedClosed, q.scope], ['unanswered', true, { applied: false, approximate: false }]);
  assert.equal(r.record.counts.failedClosed, 2);
  assert.equal(r.record.counts.notFound, 0, 'not counted as found nothing');
  assert.equal(r.stopped, null, 'not taken for a suspect batch either');
  assert.equal(regionState(work, cheshire), 'ready', 'still to look up (relaxed)');
  assert.match(REGION_WORDS.failedClosed, /not a finding that there is no match/);
  assert.match(REGION_WORDS.ran(2, 2, 2), /could not apply the filter, which is not "no match"/);
  // Control: applied, and nothing found: answered, no candidates, in review.
  const empty = fakeWhg({ answers: { ...ANSWERS, Cheshire: [], Lancashire: [] } });
  const e = await englandMatched({ fake: empty });
  const r2 = await runLevel(e.work, 2, { lookup: e.lookup, now: clock() });
  const q2 = r2.record.queries[keyOf(e.work, 'Cheshire (England)')];
  assert.deepEqual([q2.state, q2.failedClosed, r2.record.counts.notFound], ['answered', undefined, 2]);
  assert.equal(regionState(e.work, keyOf(e.work, 'Cheshire (England)')), 'review');
  // The rule itself, on a list.
  assert.equal(failedClosed(Object.assign([], { scope: { applied: false } })), true);
  assert.equal(failedClosed(Object.assign([{}], { scope: { applied: false } })), false, 'applied false with candidates: not filtered, not failed closed');
  assert.equal(failedClosed(Object.assign([], { scope: { applied: true } })), false);
});

// ---- the cascade -----------------------------------------------------------------------------------------
test('a changed decision on a settled region clears everything below it, and its snapshot undoes that; a decision that changes nothing, or a first settlement, clears nothing', async () => {
  const { g, work, lookup, england } = await englandMatched();
  const cheshire = keyOf(work, 'Cheshire (England)'), newton = regionIri(3, 'Newton', ['England', 'Cheshire']);
  await runLevel(work, 2, { lookup, now: clock() });
  const first = decideRegion(work, candidateFor(work, cheshire, 'place:gn:2653941').id, 'match', { at: NOW });
  assert.equal(first.snapshot, null, 'settled for the first time: nothing below is cleared');
  await runLevel(work, 3, { lookup, now: clock() });
  decideRegion(work, candidateFor(work, newton, 'place:gn:2641434').id, 'match', { at: NOW });
  await runPlaces(work, { lookup, places: g.places, now: clock() });
  const farm = `${BASE}place/2`;
  decide(work, candidateFor(work, farm, 'place:gn:9000001').id, 'match', { at: NOW });
  // A local candidate for the Farm (from another dataset) stays whatever happens above it.
  work.others = { title: 'Another dataset', files: [] };
  work.candidates.push({ id: 'local-1', candidate_source: farm, candidate_candidate: 'https://example.org/other/farm', similarity_score: 0.9, distance_km: null, candidate_status: 'suggested', other: { label: 'Farm', names: ['Farm'], point: null }, decision: null });
  // Unchanged: the same match decided again, with a basis: nothing cleared.
  const same = decideRegion(work, candidateFor(work, england, 'place:gn:6269131').id, 'match', { identityType: 'closeMatch', basis: 'By name', at: NOW });
  assert.equal(same.snapshot, null);
  assert.equal(work.regions[cheshire].outcome, 'matched', 'control for what follows: Cheshire is settled');
  const before = JSON.parse(JSON.stringify(work));
  const belowKeys = new Set([cheshire, keyOf(work, 'Lancashire (England)'), newton, regionIri(3, 'Newton', ['England', 'Lancashire']), ...g.places.map((p) => p.iri)]);
  const fromLookups = work.candidates.filter((c) => belowKeys.has(c.candidate_source) && c.lookup).length;
  assert.ok(fromLookups > 0);
  // Changed: England matched to another record as well.
  const changed = decideRegion(work, candidateFor(work, england, 'place:wd:Q21').id, 'match', { at: NOW });
  assert.ok(changed.snapshot);
  assert.deepEqual(changed.snapshot.counts, { regions: 4, places: 4, decisions: 3, candidates: fromLookups });
  assert.equal(work.regions[cheshire].outcome, null);
  assert.equal(work.regions[newton].outcome, null);
  assert.ok(!work.candidates.some((c) => c.candidate_source === cheshire || c.candidate_source === newton), 'the lookups\' candidates below are removed');
  assert.ok(!work.candidates.some((c) => c.candidate_source === farm && c.lookup), 'the Farm\'s too');
  assert.ok(work.candidates.some((c) => c.id === 'local-1' && c.decision === null), 'a local candidate stays');
  assert.ok(work.lookups.every((l) => !Object.hasOwn(l.queries, cheshire) || l.queries[cheshire].stale === true), 'their queries are stale');
  assert.ok(work.lookups.some((l) => Object.hasOwn(l.queries, farm) && l.queries[farm].stale === true));
  assert.ok(!work.lookups.some((l) => Object.hasOwn(l.queries, england) && l.queries[england].stale), 'control: England itself is not stale');
  assert.equal(work.regions[england].outcome, 'matched');
  assert.equal(regionState(work, cheshire), 'ready', 'to look up again, under the new constraint');
  assert.ok(readWork(serialiseWork(work)), 'the cleared review is a good file');
  // Undo: everything back as it was, but England's new decision.
  undo(work, changed.snapshot);
  decide(work, candidateFor(work, england, 'place:wd:Q21').id, null);
  work.regions[england].outcome = 'matched';
  assert.deepEqual(JSON.parse(JSON.stringify(work)), before);
  // Taking a settled region's match back opens it again, and clears below; settling with no match likewise.
  const back = decideRegion(work, candidateFor(work, cheshire, 'place:gn:2653941').id, null);
  assert.equal(work.regions[cheshire].outcome, null);
  assert.equal(back.snapshot.counts.regions, 1);
  assert.throws(() => settleRegion(work, england, 'no-match'), /take it back/);
});

// ---- the work file ----------------------------------------------------------------------------------------
test('version 1 and 2 work files are read as version 3 with no regions; what version 3 adds is checked, and a bad file refused in words', async () => {
  const subjects = await detect([textFile(JSON.stringify({ profile: 'place-centric', gazetteer: { title: 'A' }, spatialEntities: [{ '@id': 'https://example.org/a/1', label: 'Newton', attestations: [{ names: [{ toponym: 'Newton' }], sources: [{ title: 'S' }] }] }] }), 'a.json')]);
  const others = await detect([textFile(JSON.stringify({ profile: 'place-centric', gazetteer: { title: 'B' }, spatialEntities: [{ '@id': 'https://example.org/b/1', label: 'Newton', attestations: [{ names: [{ toponym: 'Newton' }], sources: [{ title: 'S' }] }] }] }), 'b.json')]);
  const { work } = await match({ subjects, others, options: { now: NOW } }, env());
  assert.equal(work.krisis, 3);
  assert.deepEqual(work.regions, {});
  const v2 = { ...work, krisis: 2 }; delete v2.regions;
  const v1 = { ...v2, krisis: 1 }; delete v1.lookups;
  for (const old of [v1, v2]) {
    const read = readWork(JSON.stringify(old));
    assert.equal(read.krisis, 3);
    assert.deepEqual(read.regions, {});
    assert.deepEqual(read, work);
  }
  assert.throws(() => readWork(JSON.stringify({ ...v2, regions: {} })), /version 2, which has no regions/);
  // Version 3, with regions: good, and each way of being bad.
  const { work: good } = await englandMatched();
  await runLevel(good, 2, { lookup: lookupWith(fakeWhg()), now: clock() });
  const text = serialiseWork(good);
  assert.ok(readWork(text), 'control: the file as written reads');
  const england = keyOf(good, 'England'), cheshire = keyOf(good, 'Cheshire (England)');
  const refused = (edit, re) => { const w = JSON.parse(text); edit(w); assert.throws(() => readWork(JSON.stringify(w)), (e) => e.name === 'DataError' && re.test(e.message), re); };
  refused((w) => { delete w.regions; }, /no list of regions/);
  refused((w) => { w.regions[cheshire].within = 'https://example.org/nowhere'; }, /lies within "https:\/\/example.org\/nowhere", which is not a region/);
  refused((w) => { w.regions[england].within = cheshire; }, /not at a narrower level|within itself/);
  refused((w) => { w.regions[cheshire].level = 0; }, /a level \(a whole number from 1/);
  refused((w) => { w.regions[cheshire].outcome = 'done'; }, /outcome that is not empty, matched or no-match/);
  refused((w) => { w.regions[cheshire].area = { lat: 1 }; }, /area that is not a box/);
  refused((w) => { w.regions[cheshire].rowState = 'hidden'; }, /not filter or exclude/);
  refused((w) => { delete w.regions[cheshire].container; }, /which container/);
  refused((w) => { w.places[Object.keys(w.places)[0] ?? 'x'] = { label: 'P', names: ['P'], point: null, within: 'nowhere' }; }, /not a region the file lists/);
  refused((w) => { w.lookups[1].queries[cheshire].constraint.kinds = ['bbox']; }, /names a constraint that is not one of/);
  refused((w) => { w.lookups[1].queries[cheshire].constraint.relaxed = 'some'; }, /relaxed in a way that is not one of/);
  refused((w) => { w.lookups[1].queries[cheshire].constraint.from = 'nowhere'; }, /constrained by a region the file does not list/);
  refused((w) => { w.lookups[1].queries[cheshire].scope = { applied: 'yes' }; }, /without saying whether it was applied/);
  refused((w) => { w.candidates.find((c) => c.candidate_source === england && c.decision).decision.certainty = 'sure'; }, /certainty that is not one of/);
  refused((w) => { w.candidates[0].candidate_source = 'constructor'; }, /for a place the file does not list/);
});

test('a place answered by a plain lookup is never locked, even once the region review is begun; one not looked up waits for its regions', async () => {
  const input = await detect([textFile(CSV, 'parishes.csv')]);
  const g = await gather({ subjects: input, options: { base: BASE } }, env());
  // A plain lookup of two places (the Mill and the Farm): no regions seeded.
  const mill = `${BASE}place/1`, farm = `${BASE}place/2`, barn = `${BASE}place/3`;
  const { work } = await runLookup({ lookup: lookupWith(fakeWhg()), work: newWork(g.subjects, { now: NOW }), places: g.places, options: { places: 'all', only: [mill, farm] }, now: clock() });
  assert.deepEqual(work.regions ?? {}, {}, 'a plain lookup seeds no regions');
  assert.deepEqual([placeState(work, mill), placeState(work, farm)], ['review', 'review']);
  // The region review begun: the regions above are not settled, yet what was answered stays answered.
  seedRegions(work, g);
  assert.equal(regionState(work, keyOf(work, 'England')), 'ready');
  assert.deepEqual([placeState(work, mill), placeState(work, farm)], ['review', 'review'], 'answered by a plain lookup: not locked');
  assert.equal(placeState(work, barn), 'locked', 'control: the Barn, not looked up, waits for its regions');
});

test('relaxed to the region further up, the request carries ITS ids as contained_in, and its countries; its area only where it has no ids', async () => {
  const { work, england, lookup, fake } = await englandMatched({ englands: ['place:gn:6269131', 'place:wd:Q21'] });
  const cheshire = keyOf(work, 'Cheshire (England)'), newton = regionIri(3, 'Newton', ['England', 'Cheshire']);
  await runLevel(work, 2, { lookup, now: clock() });
  decideRegion(work, candidateFor(work, cheshire, 'place:gn:2653941').id, 'match', { at: NOW });
  // The control: unrelaxed, Newton is asked within Cheshire.
  await runLevel(work, 3, { lookup, only: [newton], now: clock() });
  assert.deepEqual(queriesOf(fake.calls.at(-1)).map((q) => [q.query, q.contained_in, q.countries]), [['Newton', ['gn:2653941'], ['GB']]]);
  const entities = fake.entities.length;
  await runLevel(work, 3, { lookup, only: [newton], relax: 'ancestor', now: clock() });
  const [q] = queriesOf(fake.calls.at(-1));
  assert.deepEqual([q.query, q.contained_in, q.countries], ['Newton', ['gn:6269131', 'wd:Q21'], ['GB']], "England's own ids, unioned, and its countries");
  assert.equal(q.lat, undefined, 'no area: England has ids');
  assert.equal(fake.entities.length, entities, 'and no record fetched for an area');
  // England matched only to records with no gazetteer id (local matches): its area, with its countries.
  for (const c of work.candidates) if (c.candidate_source === england && c.decision?.kind === 'match') delete c.gazetteer.id;
  const c = constraintFor(work, newton, { relax: 'ancestor' });
  assert.deepEqual([c.from, c.kinds, c.needsArea], [england, ['countries'], england], 'its area is needed first');
  work.regions[england].area = areaOf([FEATURES['place:gn:6269131'], FEATURES['place:wd:Q21']], areaIds(work, england));
  await runLevel(work, 3, { lookup, only: [newton], relax: 'ancestor', now: clock() });
  const [byArea] = queriesOf(fake.calls.at(-1));
  assert.equal(byArea.contained_in, undefined);
  assert.ok(byArea.radius > 0 && typeof byArea.lat === 'number', `England's area: ${JSON.stringify(byArea)}`);
  assert.deepEqual(byArea.countries, ['GB']);
});

// ---- the claim -------------------------------------------------------------------------------------------
const load = (f) => JSON.parse(readFileSync(`public/plato/${f}`, 'utf8'));
const ajv = addPlatoFormats(new Ajv2020({ strict: false, allErrors: true, logger: strictFormatLogger }));
ajv.addSchema(load('plato.schema.json'), 'https://w3id.org/plato/schemas/plato.schema.json');
ajv.addSchema(load('place-centric.schema.json'));
const validPlaceCentric = (doc) => { const v = ajv.getSchema('https://w3id.org/plato/schemas/place-centric.schema.json'); return v(doc) ? null : v.errors.slice(0, 3); };
/** An attestation's shape: its keys in order, and those of its identities and sources; contributor as a URI or an object. */
const shapeOf = (a) => ({ keys: Object.keys(a).filter((k) => k !== '@id'), identities: a.identities.map((r) => Object.keys(r)), sources: a.sources.map((s) => Object.keys(s)), contributor: typeof a.contributor === 'string' ? 'uri' : 'object', certaintyLevel: a.certaintyLevel });
// PLATO a6bc022's england-matched attestation (schemas/examples/place-centric-regions.json), inlined so
// the comparison runs at any pin; the file itself is compared where PLATO_REPO has it (below).
const FIXTURE_CLAIM = {
  '@id': 'https://whgazetteer.org/example/attestation/england-matched',
  identities: [{ subject: 'https://whgazetteer.org/example/entity/region/england', object: 'https://whgazetteer.org/example/whg/place/england', identityType: 'closeMatch', basis: 'Exact name, country code GB', promotedFrom: 'https://whgazetteer.org/example/candidates/regions-2026-10-03#c-f129572e' }],
  certaintyLevel: 'https://w3id.org/plato#Certain',
  sources: [{ '@id': 'https://whgazetteer.org/example/source/region-review-2026-10-03', title: "Review of the parish list's regions, 3 October 2026" }],
  contributor: 'https://whgazetteer.org/example/contributor/editor', created: '2026-10-03T11:00:00Z',
};
test('a matched region is written as PLATO #23 has it: a claim ABOUT the minted region, valid, in the worked example\'s shape; the containment is not rewritten', async () => {
  const { work, england } = await englandMatched();
  decideRegion(work, candidateFor(work, england, 'place:gn:6269131').id, 'match', { identityType: 'closeMatch', basis: 'Exact name, country code GB', certainty: 'certain', at: NOW });
  const { made, unwritten } = regionClaims(work);
  assert.deepEqual(unwritten, []);
  assert.equal(made.length, 1);
  const { subject, attestation } = made[0];
  assert.equal(subject, england);
  assert.equal(attestation.identities[0].subject, england, 'about the region made from the source\'s own data');
  assert.equal(attestation.identities[0].object, W3ID + 'place:gn:6269131', 'to the WHG record\'s w3id');
  assert.equal(attestation.certaintyLevel, CERTAINTY_LEVELS.certain);
  assert.deepEqual(attestation.sources, [{ '@id': 'https://whgazetteer.org/', title: 'World Historical Gazetteer' }]);
  assert.deepEqual(attestation.contributor, REVIEWER);
  assert.equal(attestation.created, NOW);
  assert.ok(!Object.hasOwn(attestation, 'relations'), 'no containment is written: what the source says stays as it is');
  assert.equal(validPlaceCentric({ profile: 'place-centric', gazetteer: { title: 'T' }, spatialEntities: [{ '@id': england, label: 'England', attestations: [attestation] }] }), null);
  // The worked example's shape: the same keys in the same order, but promotedFrom (the hook: the candidate-set export is not on this branch).
  const want = shapeOf(FIXTURE_CLAIM);
  assert.deepEqual({ ...shapeOf(attestation), contributor: 'uri' }, { ...want, identities: [want.identities[0].filter((k) => k !== 'promotedFrom')] });
  assert.equal(shapeOf(attestation).contributor, 'object', 'the reviewer inline (PLATO\'s contributorObject); the example names one by address');
  // With promotedFrom given (the hook), exactly the example's shape.
  const hooked = regionClaims(work, { promotedFrom: (c) => `https://example.org/candidates/set-1#c-${c.id}` }).made[0].attestation;
  assert.deepEqual({ ...shapeOf(hooked), contributor: 'uri' }, want);
  assert.equal(validPlaceCentric({ profile: 'place-centric', gazetteer: { title: 'T' }, spatialEntities: [{ '@id': england, label: 'England', attestations: [hooked] }] }), null);
  // Several matches: one claim bundling both, the least certain certainty, a basis for each (the constraint's words when none is given).
  decideRegion(work, candidateFor(work, england, 'place:wd:Q21').id, 'match', { identityType: 'exactMatch', certainty: 'less-certain', at: NOW });
  const two = regionClaims(work).made[0].attestation;
  assert.deepEqual(two.identities.map((r) => [r.object, r.identityType]), [[W3ID + 'place:gn:6269131', 'closeMatch'], [W3ID + 'place:wd:Q21', 'exactMatch']]);
  assert.equal(two.certaintyLevel, CERTAINTY_LEVELS['less-certain']);
  assert.equal(two.identities[1].basis, "Chosen by the reviewer from the gazetteer's candidates");
  // attestationsFrom includes it; a region with no address of its own (no base) is listed as unwritten instead.
  assert.ok(attestationsFrom(work).some((m) => m.subject === england && m.attestation.certaintyLevel));
  const plain = await reviewOf(CSV, { base: null });
  await runLevel(plain.work, 1, { lookup: lookupWith(fakeWhg()), now: clock() });
  const pe = keyOf(plain.work, 'England');
  decideRegion(plain.work, candidateFor(plain.work, pe, 'place:gn:6269131').id, 'match', { at: NOW });
  assert.deepEqual(regionClaims(plain.work), { made: [], unwritten: [pe] });
});

test('the claim\'s shape equals the worked example file\'s, where the pin has it', async (t) => {
  const path = `${PLATO_REPO}/schemas/examples/place-centric-regions.json`;
  if (!existsSync(path)) { t.skip(`PLATO at ${PLATO_REPO} has no schemas/examples/place-centric-regions.json: the inlined copy is compared above`); return; }
  const example = JSON.parse(readFileSync(path, 'utf8'));
  const claims = example.spatialEntities.flatMap((p) => p.attestations).filter((a) => a.identities);
  assert.equal(claims.length, 2);
  assert.deepEqual(claims.find((a) => a['@id'].endsWith('england-matched')), FIXTURE_CLAIM, 'the inlined copy is the file\'s');
  const { work, england } = await englandMatched();
  decideRegion(work, candidateFor(work, england, 'place:gn:6269131').id, 'match', { identityType: 'closeMatch', basis: 'B', at: NOW });
  const hooked = regionClaims(work, { promotedFrom: (c) => `https://example.org/candidates/set-1#c-${c.id}` }).made[0].attestation;
  for (const c of claims) assert.deepEqual({ ...shapeOf(hooked), contributor: 'uri', certaintyLevel: c.certaintyLevel }, shapeOf(c));
  // The candidate set that example answers names the level's constraint in its matchParameters (the hook's work, later).
  const set = JSON.parse(readFileSync(`${PLATO_REPO}/schemas/examples/candidate-set-regions.json`, 'utf8'));
  assert.match(set.candidates[1].matchParameters, /within/);
});

test('finishing a region review writes the claim onto the minted region in the dataset, next to the containment it leaves as it was', async () => {
  const { work, england, input } = await englandMatched();
  decideRegion(work, candidateFor(work, england, 'place:gn:6269131').id, 'match', { identityType: 'closeMatch', basis: 'Exact name', at: NOW });
  const e = env();
  const r = await apply({ subjects: input, work, options: { base: BASE, reviewer: REVIEWER } }, e);
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  const doc = JSON.parse(e.outs['parishes.krisis-dataset.json'].join(''));
  const region = doc.spatialEntities.find((p) => p['@id'] === england);
  assert.ok(region.attestations.some((a) => a.identities?.[0]?.object === W3ID + 'place:gn:6269131' && a.certaintyLevel), 'the claim is on the region');
  const cheshire = doc.spatialEntities.find((p) => p['@id'] === keyOf(work, 'Cheshire (England)'));
  assert.ok(cheshire.attestations.some((a) => a.relations?.[0]?.relatesTo === england), 'Cheshire is still ContainedIn the region made from the data, not the gazetteer\'s');
  assert.ok(!JSON.stringify(doc).includes(`"relatesTo":"${W3ID}`), 'no containment points at the gazetteer');
  assert.equal(validPlaceCentric(doc), null);
});

// ---- the command line -------------------------------------------------------------------------------------
test('command line: lookup --levels --dry-run shows the plan level by level and sends nothing; its options are checked', () => {
  const d = mkdtempSync(join(tmpdir(), 'plato-tools-regions-'));
  const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, WHG_TOKEN: '' } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  try {
    writeFileSync(join(d, 'parishes.csv'), CSV);
    const r = cli('lookup', '--levels', '--dry-run', '--base', BASE, join(d, 'parishes.csv'));
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /Level 1: 1 region \(1 ready\)\./);
    assert.match(r.out, /England: No constraint/);
    assert.match(r.out, /Level 2: 2 regions \(2 waiting for the level above\)\./);
    assert.match(r.out, /Level 3: 2 regions/);
    assert.match(r.out, /Places within: 0 places ready, 4 places waiting for their regions\./);
    assert.ok(!existsSync(join(d, 'parishes.krisis.json')), 'a dry run writes nothing');
    const j = JSON.parse(cli('lookup', '--levels', '--dry-run', '--json', join(d, 'parishes.csv')).out);
    assert.deepEqual(j.regionPlan.levels.map((l) => l.nodes), [1, 2, 2]);
    assert.equal(j.region.target, 1);
    // Refused, in words.
    assert.match(cli('lookup', '--levels', '--relax', 'nearby', '--dry-run', join(d, 'parishes.csv')).err, /--relax nearby is not one of countries, contained-in, area, ancestor, all/);
    assert.match(cli('lookup', '--relax', 'all', join(d, 'parishes.csv')).err, /go with --levels/);
    assert.match(cli('lookup', '--levels', '--countries', '--dry-run', join(d, 'parishes.csv')).err, /not for --levels/);
    assert.match(cli('lookup', '--levels', '--level', '0', '--dry-run', join(d, 'parishes.csv')).err, /a level is a whole number from 1/);
    assert.match(cli('check', '--levels', join(d, 'parishes.csv')).err, /are for lookup/);
    assert.match(cli('lookup', '--levels', join(d, 'parishes.csv')).err, /needs a token/, 'not a dry run: the token is needed');
    // Control: a table with no regions has nothing to review level by level.
    writeFileSync(join(d, 'flat.csv'), 'id,Name\n1,Mill\n');
    assert.match(cli('lookup', '--levels', '--dry-run', join(d, 'flat.csv')).out, /gives no regions for its places/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('command line: a --relax step that does not apply to the regions to look up is refused, with the steps that do; never looked up unconstrained', async () => {
  const d = mkdtempSync(join(tmpdir(), 'plato-tools-regions-'));
  const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, WHG_TOKEN: '' } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  try {
    writeFileSync(join(d, 'parishes.csv'), CSV);
    const { work, lookup } = await englandMatched();
    writeFileSync(join(d, 'england.krisis.json'), serialiseWork(work));
    const run = (...a) => cli('lookup', '--levels', '--dry-run', '--json', '--base', BASE, '--review', join(d, 'england.krisis.json'), ...a, join(d, 'parishes.csv'));
    // The counties: England is the only matched region above them, so there is no region further up.
    const refused = run('--level', '2', '--relax', 'ancestor');
    assert.equal(refused.code, 2, refused.out + refused.err);
    assert.match(refused.err, /--relax ancestor does not apply to the regions of level 2 .*The steps that apply: countries, contained-in, all\./);
    assert.equal(refused.out, '', 'nothing planned, nothing looked up');
    // Control: a step that applies is taken.
    const taken = run('--level', '2', '--relax', 'countries');
    assert.equal(taken.code, 0, taken.out + taken.err);
    assert.equal(JSON.parse(taken.out).region.relax, 'countries');
    // With Cheshire matched, its parish has England further up: 'ancestor' applies there.
    await runLevel(work, 2, { lookup, now: clock() });
    decideRegion(work, candidateFor(work, keyOf(work, 'Cheshire (England)'), 'place:gn:2653941').id, 'match', { at: NOW });
    writeFileSync(join(d, 'england.krisis.json'), serialiseWork(work));
    const newton = regionIri(3, 'Newton', ['England', 'Cheshire']);
    const up = run('--level', '3', '--only', newton, '--relax', 'ancestor');
    assert.equal(up.code, 0, up.out + up.err);
    assert.deepEqual(JSON.parse(up.out).regionPlan.levels[2].ready.find((x) => x.key === newton).kinds, ['contained_in', 'countries']);
    assert.deepEqual(relaxAvailable(work, [newton]), ['countries', 'contained-in', 'ancestor', 'all']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the plan says, for each ready region, the constraint it would be looked up under', async () => {
  const { work } = await englandMatched();
  const p = planLevels(work);
  assert.deepEqual(p.levels.map((l) => [l.level, l.states]), [[1, { locked: 0, ready: 0, review: 0, settled: 1 }], [2, { locked: 0, ready: 2, review: 0, settled: 0 }], [3, { locked: 2, ready: 0, review: 0, settled: 0 }]]);
  assert.match(p.levels[1].ready[0].constraint, /^Constrained to within the gazetteer's 1 record for England, and in GB \(from the match for England\)\. A filter by country leaves out every candidate with no country recorded/);
  const relaxed = planLevels(work, { relax: 'area' });
  assert.equal(relaxed.levels[1].ready[0].needsArea, keyOf(work, 'England'));
  assert.ok(REGION_WORDS.plan(relaxed.levels, relaxed.places).some((l) => /its area is fetched first/.test(l)));
});
