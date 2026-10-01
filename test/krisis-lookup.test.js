// Krisis, gazetteer lookup (src/engine/krisis/lookup.js): places looked up in a reconciliation service
// (WHG), with a fake fetch standing in for it, so nothing here goes on the network. The shared gazetteer
// module is used as it is, and the service answers as whg.js says WHG does.
//
// Each absence has a presence beside it: a candidate left out is shown kept when the one reason for
// leaving it out is taken away; a token not found in the outputs is first found where it must be (the
// Authorization header), by the same search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, textFile } from './engine.js';
import { detect } from '../src/engine/input.js';
import { createLookup, memoryLedger, WHG_ENDPOINT, WHG_PLACE_TYPE as MODULE_PLACE_TYPE } from '../src/engine/gazetteer/index.js';
import { match, gather, distanceKm as matchDistance } from '../src/engine/krisis/match.js';
import { readWork, serialiseWork, decide, WORK_VERSION } from '../src/engine/krisis/work.js';
import { attestationsFrom, gazetteerSource } from '../src/engine/krisis/identity.js';
import { apply } from '../src/engine/krisis/apply.js';
import {
  planQueries, planLookup, rankGazetteer, runLookup, selectPlaces, mergeAnswers, startLookup, newWork, serviceOf, licenceOf, upstreamLicence, lookupCandidatesOf,
  distanceKm, WHG_SERVICE, PREVIEW_QUERIES, LOOKUP_ALGORITHM, authorityIris, typeFromManifest, iriFromTemplate, manifestSettings, iriVia, WHG_PLACE_TYPE,
} from '../src/engine/krisis/lookup.js';
import { LOOKUP_WORDS, krisisLookupNote, lookupPage } from '../src/engine/words.js';
import { currentIdentities, createIdentityCollector, linkState } from '../src/engine/krisis/identities.js';

const X = 'https://example.org/';
const W3ID = 'https://w3id.org/whg/id/';
const src = { '@id': X + 'source/s', title: 'S', authorityType: 'source' };
const at = (lon, lat) => ({ geometries: [{ geojson: { type: 'Point', coordinates: [lon, lat] } }], sources: [src] });
const named = (...names) => ({ names: names.map((toponym) => ({ toponym })), sources: [src] });
const A = (id) => `${X}a/${id}`;
const REVIEWER = { name: 'A. Reviewer' };
const NOW = '2026-09-30T12:00:00Z';

// ---- a fake WHG ---------------------------------------------------------------------------------------
const NEWCASTLES = [
  // WHG's order puts Australia first, and gives all three 100: the score is relative within one answer.
  { id: 'place:gn:2155472', name: 'Newcastle', score: 100, match: true, description: 'Country: AU', ccodes: ['AU'], repr_point: [151.7765, -32.9272], namespace: 'gn', alt_names: [] },
  { id: 'place:gn:3354071', name: 'Newcastle', score: 100, match: true, description: 'Country: NA', ccodes: ['NA'], repr_point: [17.0833, -22.5667], namespace: 'gn', alt_names: [] },
  { id: 'place:gn:2641673', name: 'Newcastle upon Tyne', score: 100, match: false, description: 'Country: GB', ccodes: ['GB'], repr_point: [-1.6132, 54.9733], namespace: 'gn', alt_names: ['Newcastle'], confidence: 92 },
];
const ATTRIBUTION = { whg: { license: 'CC-BY-4.0' }, sources: { gn: { license: { spdx_id: 'CC-BY-4.0', permits_commercial: true, no_derivatives: false }, redistributable: true }, un: { license: { spdx_id: null, permits_commercial: null, no_derivatives: null } } } };
/**
 * A fetch that answers as WHG would: `answer(query)` gives a query's object ({result} or {result,
 * gateway}), or a Response to answer the whole request with. Every call is kept, headers included.
 */
function fakeWhg(answer = () => ({ result: [] }), { attribution = ATTRIBUTION } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const out = { attribution };
    for (const [k, q] of Object.entries(body.queries)) {
      const a = answer(q, calls.length);
      if (a instanceof Response) return a;
      if (a instanceof Error) throw a;
      out[k] = a;
    }
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { fetch, calls };
}
const byName = (table) => (q) => ({ result: table[q.query] ?? [] });
// Each test's lookup is its own (shared: false), takes no Web Lock (locks: null; Node 24 has
// navigator.locks) and counts in a ledger of its own: createLookup otherwise gives every caller of this
// process one lookup per endpoint, with the first caller's fetch, so a test would be answered by an
// earlier test's fake. A getter, so that no two lookups share a ledger.
const PRIVATE = { get shared() { return false; }, get locks() { return null; }, get ledger() { return memoryLedger(); } };
const lookupWith = (fake, more = {}) => createLookup({ endpoint: WHG_ENDPOINT, token: 'test-token', fetch: fake.fetch, sleep: () => Promise.resolve(), queryRate: null, ...PRIVATE, ...more });

// ---- datasets ------------------------------------------------------------------------------------------
const doc = (places) => ({ profile: 'place-centric', gazetteer: { '@id': X + 'a', title: 'Dataset A' }, spatialEntities: places });
const place = (id, label, attestations, more = {}) => ({ '@id': A(id), label, attestations, ...more });
const tyne = () => place('newcastle', 'Newcastle', [named('Newcastle upon Tyne'), at(-1.61, 54.97)], { ccodes: ['GB'] });
async function gathered(places) {
  const input = await detect([textFile(JSON.stringify(doc(places)), 'a.json')]);
  return gather({ subjects: input, options: {} }, env());
}
const clock = () => { let n = 0; return () => new Date(Date.parse(NOW) + 1000 * n++).toISOString(); };

// ---- planning --------------------------------------------------------------------------------------------
test('planQueries sends the label only, without filters, unless asked; the preview gives the cost and the queries exactly', async () => {
  const g = await gathered([tyne(), place('york', 'York', [named('Eboracum', 'Jorvik'), at(-1.08, 53.96)], { ccodes: ['GB'] }), place('nowhere', 'Nowhere', [named('Nowhere')])]);
  const label = planQueries(g.places);
  assert.deepEqual(label.queries.map((q) => q.query), ['Newcastle', 'York', 'Nowhere']);
  assert.ok(label.queries.every((q) => !q.params), 'no filters by default');
  assert.deepEqual({ ...label.preview, first: undefined, service: undefined }, { places: 3, queries: 3, requests: 1, allNames: false, limit: 10, filters: [], sendsCoordinates: false, nearKm: null, withoutCountries: 0, withoutPoint: 0, withoutName: 0, first: undefined, service: undefined });
  // The type in the form the gazetteer module sends WHG (it writes every form of Place as "Place"), so
  // that the preview below is what WHG receives.
  assert.ok(label.queries.every((q) => q.type === 'Place'), 'WHG is always sent its type');
  const all = planQueries(g.places, { allNames: true, countries: true, nearKm: 10, batchSize: 2 });
  assert.deepEqual(all.queries.map((q) => q.query), ['Newcastle', 'Newcastle upon Tyne', 'York', 'Eboracum', 'Jorvik', 'Nowhere']);
  assert.deepEqual(all.queries[0].params.countries, ['GB'], 'control: countries sent when asked');
  assert.deepEqual([all.queries[0].params.lat, all.queries[0].params.lng, all.queries[0].params.radius], [54.97, -1.61, 10], 'control: a point and radius sent when asked');
  assert.equal(all.queries[0].params.bounds, undefined, 'not a box');
  assert.deepEqual(all.preview.filters, ['countries', 'near']);
  assert.equal(all.preview.sendsCoordinates, true);
  assert.deepEqual([all.preview.withoutCountries, all.preview.withoutPoint], [1, 1]);
  // A place's queries are kept together: York's three make a chunk of their own, and two requests.
  assert.deepEqual(all.chunks.map((c) => c.places.map((p) => p.label)), [['Newcastle'], ['York'], ['Nowhere']]);
  assert.equal(all.preview.requests, 4);
  // The preview's queries are what the service receives.
  const fake = fakeWhg();
  await runLookup({ lookup: lookupWith(fake), subjects: g.subjects, places: g.places, options: { places: 'all' } });
  assert.deepEqual(Object.values(fake.calls[0].body.queries), label.preview.first);
});
test('countries are sent as a JSON list of ISO 3166-1 alpha-2 codes, in capitals', async () => {
  const p = (ccodes) => ({ iri: A('c'), label: 'C', names: ['C'], point: null, ccodes });
  assert.deepEqual(planQueries([p(['gb', 'IE', ' fr '])], { countries: true }).queries[0].params.countries, ['GB', 'IE', 'FR']);
  assert.deepEqual(planQueries([p(['GBR', 'G', 'gb', 'GB', 7])], { countries: true }).queries[0].params.countries, ['GB'], 'only two-letter codes, once each');
  const none = planQueries([p(['GBR'])], { countries: true });
  assert.equal(none.queries[0].params, undefined, 'no code of two letters: no filter');
  assert.equal(none.preview.withoutCountries, 1);
  // On the wire, a list, exactly as planned.
  const g = await gathered([tyne()]);
  const fake = fakeWhg();
  await runLookup({ lookup: lookupWith(fake), subjects: g.subjects, places: g.places, options: { places: 'all', countries: true } });
  assert.deepEqual(fake.calls[0].body.queries.q0.countries, ['GB']);
});
test('the preview shows at most the first twenty queries', () => {
  const places = Array.from({ length: 30 }, (_, i) => ({ iri: A('p' + i), label: 'Place ' + i, names: ['Place ' + i], point: null }));
  const p = planQueries(places).preview;
  assert.equal(p.first.length, PREVIEW_QUERIES);
  assert.equal(p.queries, 30);
  assert.equal(p.requests, 2);
  assert.equal(p.first[19].query, 'Place 19');
});

// ---- ranking ------------------------------------------------------------------------------------------------
test('three Newcastles, all scored 100 by WHG, are ranked by distance, the far ones kept and marked', () => {
  const p = { iri: A('newcastle'), label: 'Newcastle', names: ['Newcastle', 'Newcastle upon Tyne'], point: [-1.61, 54.97], ccodes: ['GB'] };
  const cands = NEWCASTLES.map((c, i) => ({ id: c.id, iri: W3ID + c.id, name: c.name, altNames: c.alt_names, score: c.score, coords: c.repr_point, ccodes: c.ccodes, answer_rank: i + 1 }));
  const r = rankGazetteer(p, cands);
  assert.deepEqual(r.map((x) => x.candidate.ccodes[0]), ['GB', 'NA', 'AU'], 'WHG gave AU, NA, GB');
  assert.deepEqual(r.map((x) => x.far), [false, true, true]);
  assert.equal(r.length, 3, 'nothing dropped');
  assert.ok(r[0].distance_km < 1);
  assert.deepEqual(r.map((x) => x.ccodes_agree), [true, false, false]);
  // Krisis's own similarity, not WHG's 100.
  assert.ok(r.every((x) => x.similarity_score === 1), 'every one is named Newcastle');
  assert.ok(r.every((x) => x.candidate.score === 100));
});
test('without distances, candidates are ranked by country, then name similarity, then the service order', () => {
  const p = { iri: A('x'), label: 'Newcastle', names: ['Newcastle'], point: null, ccodes: ['GB'] };
  const c = (id, name, ccodes, answer_rank) => ({ id, iri: W3ID + id, name, altNames: [], ccodes, coords: null, answer_rank });
  const r = rankGazetteer(p, [c('place:a:1', 'Newcastle', ['AU'], 1), c('place:a:2', 'Newcastel', null, 2), c('place:a:3', 'Newcastle', null, 3), c('place:a:4', 'Newcastle', ['GB'], 4)]);
  assert.deepEqual(r.map((x) => x.candidate.id), ['place:a:4', 'place:a:3', 'place:a:2', 'place:a:1']);
  const same = rankGazetteer(p, [c('place:a:5', 'Newcastle', null, 2), c('place:a:6', 'Newcastle', null, 1)]);
  assert.deepEqual(same.map((x) => x.candidate.id), ['place:a:6', 'place:a:5'], 'all else equal, the service order');
});
test('the distance is match.js\'s', () => {
  assert.equal(distanceKm([-1.61, 54.97], [151.7765, -32.9272]), matchDistance([-1.61, 54.97], [151.7765, -32.9272]));
});

// ---- a lookup, end to end ---------------------------------------------------------------------------------
test('a lookup without a local match makes a version 2 work file, which reads back; candidates carry the lookup and WHG\'s figures', async () => {
  const g = await gathered([tyne(), place('york', 'York', [at(-1.08, 53.96)])]);
  const fake = fakeWhg(byName({ Newcastle: NEWCASTLES, York: [] }));
  const batches = [];
  const { work, record, stopped } = await runLookup({ lookup: lookupWith(fake), subjects: g.subjects, places: g.places, onBatch: (b) => batches.push(b.done), now: clock() });
  assert.equal(stopped, null);
  assert.equal(work.krisis, WORK_VERSION);
  assert.equal(work.others, null);
  assert.deepEqual(readWork(serialiseWork(work)), work, 'reads back as written');
  assert.deepEqual(Object.keys(work.places), [A('newcastle'), A('york')], 'a place not found is listed too');
  assert.equal(record.queries[A('york')].state, 'answered');
  assert.equal(record.queries[A('york')].found, 0);
  assert.equal(LOOKUP_WORDS.notFound(record.queries[A('york')]), 'No candidates (label only).');
  assert.deepEqual(batches, [2]);
  const cands = lookupCandidatesOf(work, A('newcastle'));
  assert.deepEqual(cands.map((c) => c.candidate_candidate), [W3ID + 'place:gn:2641673', W3ID + 'place:gn:3354071', W3ID + 'place:gn:2155472']);
  const top = cands[0];
  assert.equal(top.lookup, record.id);
  assert.equal(top.algorithm_version, LOOKUP_ALGORITHM);
  assert.deepEqual(top.gazetteer, { service: WHG_ENDPOINT, id: 'place:gn:2641673', score: 100, confidence: 92, match: false, answer_rank: 3, description: 'Country: GB', namespace: 'gn', query: 'Newcastle' });
  assert.deepEqual(top.other.source, { title: 'World Historical Gazetteer', uri: 'https://whgazetteer.org/' });
  assert.equal(cands[2].far, true);
  assert.equal(top.far, undefined);
  assert.equal(top.candidate_status, 'suggested', 'nothing accepted');
  assert.ok(work.candidates.every((c) => c.decision === null));
  // The attribution as it came, the nulls left null.
  assert.deepEqual(record.attribution, ATTRIBUTION);
  assert.deepEqual(record.counts, { places: 2, withoutName: 0, queries: 2, requests: 1, answered: 2, notFound: 1, unanswered: 0, stopped: 0, found: 3, added: 3, far: 2, skipped: { noIri: 0, linked: 0, denied: 0, decided: 0, duplicate: 0 } });
  assert.match(LOOKUP_WORDS.summary(record.counts, 'World Historical Gazetteer').problems, /^3 possible matches to review, 2 of them far away\.$/);
});
test('an unanswered query means "try again", never "no match"; a lookup of the pending places asks for it again', async () => {
  const g = await gathered([tyne(), place('york', 'York', [at(-1.08, 53.96)])]);
  let gateway = true;
  const fake = fakeWhg((q) => (q.query === 'York' && gateway ? { result: [], gateway: { answered: false } } : byName({ Newcastle: NEWCASTLES })(q)));
  const first = await runLookup({ lookup: lookupWith(fake), subjects: g.subjects, places: g.places, now: clock() });
  const y = first.record.queries[A('york')];
  assert.equal(y.state, 'unanswered');
  assert.equal(first.record.counts.notFound, 0, 'not counted as found nothing');
  assert.equal(first.record.queries[A('newcastle')].state, 'answered', 'control: an answered place beside it');
  gateway = false;
  const again = await runLookup({ lookup: lookupWith(fake), work: first.work, places: g.places, now: clock() });
  assert.equal(again.record.parameters.places, 'pending', 'after a lookup, the default is the places not yet answered');
  assert.deepEqual(Object.keys(again.record.queries), [A('york')]);
  assert.equal(again.record.queries[A('york')].state, 'answered');
  assert.equal(Object.values(fake.calls.at(-1).body.queries).length, 1);
});
test('candidates without an address, already linked, said to be different or already decided are not suggested, and are counted', async () => {
  const cands = [
    { id: 'no-address', name: 'Newcastle', score: 100 },                 // not a WHG id: no IRI
    { id: 'place:gn:1', name: 'Newcastle', score: 90, repr_point: [-1.6, 54.9] },
    { id: 'place:gn:2', name: 'Newcastle', score: 80, repr_point: [-1.6, 54.9] },
    { id: 'place:gn:3', name: 'Newcastle', score: 70, repr_point: [-1.6, 54.9] },
    { id: 'place:gn:4', name: 'Newcastle', score: 60, repr_point: [-1.6, 54.9] },
  ];
  const linked = (links) => place('newcastle', 'Newcastle', [at(-1.61, 54.97), ...links]);
  const identities = (object, negated) => ({ identities: [{ subject: A('newcastle'), object, identityType: 'exactMatch' }], ...(negated ? { negated: true } : {}), sources: [src] });
  const g = await gathered([linked([identities('https://whgazetteer.org/entity/place:gn:1/api', false), identities(W3ID + 'place:gn:2', true)])]);
  const fake = fakeWhg(byName({ Newcastle: cands }));
  const first = await runLookup({ lookup: lookupWith(fake), subjects: g.subjects, places: g.places, now: clock() });
  assert.deepEqual(first.work.candidates.map((c) => c.gazetteer.id), ['place:gn:3', 'place:gn:4']);
  assert.deepEqual(first.record.counts.skipped, { noIri: 1, linked: 1, denied: 1, decided: 0, duplicate: 0 });
  // Decide one, look again: the decided one is kept and not suggested twice; the undecided is replaced.
  decide(first.work, first.work.candidates[0].id, 'not-this', { at: NOW });
  const again = await runLookup({ lookup: lookupWith(fake), work: first.work, places: g.places, options: { places: 'all' }, now: clock() });
  assert.equal(again.record.counts.skipped.decided, 1);
  assert.deepEqual(again.work.candidates.map((c) => [c.gazetteer.id, c.lookup, c.candidate_status]), [['place:gn:3', 'l1', 'rejected'], ['place:gn:4', 'l2', 'suggested']]);
  // Control: without the links, the same answer suggests all four with addresses.
  const plain = await gathered([linked([])]);
  const r = await runLookup({ lookup: lookupWith(fakeWhg(byName({ Newcastle: cands }))), subjects: plain.subjects, places: plain.places, now: clock() });
  assert.deepEqual(r.work.candidates.map((c) => c.gazetteer.id), ['place:gn:1', 'place:gn:2', 'place:gn:3', 'place:gn:4']);
});
test('a legacy WHG address is compared as found: not a link to the w3id candidate, but a link to WHG for "unlinked"', async () => {
  const legacy = 'https://whgazetteer.org/places/12345678/portal/';
  const g = await gathered([place('newcastle', 'Newcastle', [at(-1.61, 54.97), { identities: [{ subject: A('newcastle'), object: legacy, identityType: 'exactMatch' }], sources: [src] }]), place('york', 'York', [at(-1.08, 53.96)])]);
  const r = await runLookup({ lookup: lookupWith(fakeWhg(byName({ Newcastle: NEWCASTLES.slice(2) }))), subjects: g.subjects, places: g.places, now: clock() });
  assert.equal(r.work.candidates.length, 1, 'the legacy address is not the w3id one');
  assert.deepEqual(selectPlaces({ places: g.places, which: 'unlinked', service: WHG_SERVICE }).map((p) => p.iri), [A('york')]);
  assert.deepEqual(selectPlaces({ places: g.places, which: 'all', service: WHG_SERVICE }).length, 2, 'control');
});
test('after a local match, the places it found nothing for are looked up; a place with local and WHG matches makes one attestation per source', async () => {
  const subjects = await detect([textFile(JSON.stringify(doc([tyne(), place('york', 'York', [at(-1.08, 53.96)])])), 'a.json')]);
  const others = await detect([textFile(JSON.stringify({ profile: 'place-centric', gazetteer: { '@id': X + 'b', title: 'Dataset B' }, spatialEntities: [{ '@id': X + 'b/newcastle', label: 'Newcastle', attestations: [at(-1.6, 54.97)] }] }), 'b.json')]);
  const m = await match({ subjects, others, options: { now: NOW } }, env());
  assert.equal(m.work.candidates.length, 1);
  const g = await gather({ subjects, options: {} }, env());
  const fake = fakeWhg(byName({ York: [{ id: 'place:gn:2633352', name: 'York', score: 100, repr_point: [-1.08, 53.96], ccodes: ['GB'] }], Newcastle: NEWCASTLES }));
  const first = await runLookup({ lookup: lookupWith(fake), work: m.work, places: g.places, now: clock() });
  assert.equal(first.record.parameters.places, 'unmatched');
  assert.deepEqual(Object.keys(first.record.queries), [A('york')], 'Newcastle had a local candidate');
  const all = await runLookup({ lookup: lookupWith(fake), work: first.work, places: g.places, options: { places: 'all', only: [A('newcastle')] }, now: clock() });
  const w = all.work;
  assert.deepEqual(readWork(serialiseWork(w)), w);
  decide(w, w.candidates.find((c) => !c.lookup).id, 'match', { at: '2026-09-30T13:00:00Z' });
  decide(w, w.candidates.find((c) => c.gazetteer?.id === 'place:gn:2641673').id, 'match', { at: '2026-09-30T13:01:00Z' });
  const made = attestationsFrom(w, { reviewer: REVIEWER, date: '2026-09-30T14:00:00Z' });
  assert.equal(made.length, 2, 'one per source');
  const [local, whg] = made.map((x) => x.attestation);
  assert.deepEqual([local.contributor, local.created], [whg.contributor, whg.created], 'same reviewer and date');
  assert.deepEqual(local.citations, [{ source: { title: 'Dataset B', authorityType: 'dataset', '@id': X + 'b' } }]);
  assert.deepEqual(whg.citations, [{ source: { title: 'World Historical Gazetteer', authorityType: 'dataset', '@id': 'https://whgazetteer.org/' } }]);
  assert.deepEqual(whg.identities.map((i) => i.object), [W3ID + 'place:gn:2641673'], 'the w3id IRI');
  assert.deepEqual(local.identities.map((i) => i.object), [X + 'b/newcastle'], 'the local=WHG link is not stated');
  assert.equal(whg.notes, krisisLookupNote('match', 'World Historical Gazetteer', LOOKUP_ALGORITHM));
  // Valid PLATO, by the schema and by the attestations-only output's own check.
  const V = env().resources.validators['place-centric'].entity;
  for (const { subject, attestation } of made) assert.ok(V({ '@id': subject, label: 'x', attestations: [attestation] }), JSON.stringify(V.errors));
  const e = env();
  const done = await apply({ subjects, work: serialiseWork(w), options: { output: 'attestations', reviewer: REVIEWER } }, e);
  assert.equal(done.report.errors, 0, JSON.stringify(done.report.items));
  assert.equal(done.attestations.length, 2);
  // No licence in an attestation; the work file has it.
  const written = e.outs['a.krisis-attestations.json'].join('');
  assert.ok(serialiseWork(w).includes('CC-BY-4.0'), 'control: the licence is in the work file');
  assert.ok(!/licen[cs]e|CC-BY/i.test(written), 'and in no attestation');
  // A denial of a WHG candidate cites WHG too.
  decide(w, w.candidates.find((c) => c.gazetteer?.id === 'place:gn:2155472').id, 'distinct', { basis: 'Another continent.', at: NOW });
  const denial = attestationsFrom(w, { reviewer: REVIEWER }).find((x) => x.attestation.negated).attestation;
  assert.deepEqual(denial.citations, [{ source: gazetteerSource(WHG_SERVICE) }]);
});
test('a lookup that stops keeps what was answered and marks the rest stopped; a spent allowance is told apart', async () => {
  const places = ['Alpha', 'Beta', 'Gamma'].map((n) => place(n.toLowerCase(), n, [at(0, 50)]));
  const g = await gathered(places);
  const fake = fakeWhg((q, call) => (call === 1 ? { result: [{ id: 'place:gn:9', name: q.query, score: 100 }] }
    : new Response(JSON.stringify({ detail: 'Daily API limit (5000 calls) exceeded' }), { status: 401 })));
  const r = await runLookup({ lookup: lookupWith(fake, { batchSize: 1 }), subjects: g.subjects, places: g.places, now: clock() });
  assert.equal(r.stopped.kind, 'quota');
  assert.deepEqual(Object.values(r.record.queries).map((q) => q.state), ['answered', 'stopped', 'stopped']);
  assert.equal(r.record.counts.stopped, 2);
  assert.equal(r.work.candidates.length, 1, 'the answer before it is kept');
  assert.ok(r.record.finished_at);
  assert.deepEqual(readWork(serialiseWork(r.work)), r.work, 'a stopped lookup can be saved');
  assert.match(LOOKUP_WORDS.stopped(r.stopped), /allowance of requests for today is spent/);
  const refused = await runLookup({ lookup: lookupWith(fakeWhg(() => new Response('{"detail":"Invalid token."}', { status: 401 }))), subjects: g.subjects, places: g.places, now: clock() });
  assert.equal(refused.stopped.kind, 'auth', 'control: a refused token is not a spent allowance');
});
test('the reviewer can stop a lookup between batches', async () => {
  const g = await gathered(['Alpha', 'Beta', 'Gamma'].map((n) => place(n.toLowerCase(), n, [at(0, 50)])));
  const ctl = new AbortController();
  const r = await runLookup({ lookup: lookupWith(fakeWhg(), { batchSize: 1 }), subjects: g.subjects, places: g.places, signal: ctl.signal, onBatch: () => ctl.abort(), now: clock() });
  assert.equal(r.stopped.kind, 'stopped');
  assert.deepEqual(Object.values(r.record.queries).map((q) => q.state), ['answered', 'stopped', 'stopped']);
});

// ---- the token -------------------------------------------------------------------------------------------------
test('the token never reaches the work file, the stop message or the summary (with a control that the search finds it)', async () => {
  const TOKEN = 'tok-SECRET-9f3a7c';
  const leaks = (s) => String(s).includes(TOKEN);
  assert.ok(leaks(JSON.stringify({ a: `Bearer ${TOKEN}` })), 'control: the search finds the token where it is');
  const g = await gathered([tyne(), place('york', 'York', [at(-1.08, 53.96)])]);
  const refusing = () => ({ result: [], error: `bad query from ${TOKEN}` });
  for (const answer of [
    byName({ Newcastle: NEWCASTLES }),
    () => new Response(JSON.stringify({ detail: `Token ${TOKEN} is not valid` }), { status: 403 }),
    () => new Error(`connect failed for ${TOKEN}`),
    refusing,
  ]) {
    const fake = fakeWhg(answer);
    const r = await runLookup({ lookup: createLookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: fake.fetch, sleep: () => Promise.resolve(), queryRate: null, maxRetries: 0, ...PRIVATE }), subjects: g.subjects, places: g.places, now: clock() });
    assert.ok(leaks(fake.calls[0].headers.Authorization), 'control: the token was in play, in the header');
    assert.ok(!leaks(serialiseWork(r.work)), 'not in the work file');
    if (answer === refusing) assert.ok(Object.values(r.record.queries).some((q) => q.error === 'bad query from [token]'), 'control: the query\'s words are kept, cleaned');
    assert.ok(!leaks(JSON.stringify(r.stopped)) && !leaks(r.stopped ? LOOKUP_WORDS.stopped(r.stopped) : ''), 'not in the stop');
    assert.ok(!leaks(JSON.stringify(r.plan)) && !leaks(JSON.stringify(LOOKUP_WORDS.summary(r.record.counts, 'x'))), 'not in the plan or summary');
    assert.ok(!fake.calls.some((c) => leaks(c.url) || leaks(JSON.stringify(c.body))), 'not in an address or a body');
  }
});

// ---- the work file -------------------------------------------------------------------------------------------------
test('a version 1 work file is read as version 2; what version 2 adds is checked', async () => {
  const subjects = await detect([textFile(JSON.stringify(doc([tyne()])), 'a.json')]);
  const others = await detect([textFile(JSON.stringify({ profile: 'place-centric', gazetteer: { title: 'B' }, spatialEntities: [{ '@id': X + 'b/n', label: 'Newcastle', attestations: [at(-1.6, 54.97)] }] }), 'b.json')]);
  const { work } = await match({ subjects, others, options: { now: NOW } }, env());
  const v1 = { ...work, krisis: 1 }; delete v1.lookups;
  const read = readWork(JSON.stringify(v1));
  assert.equal(read.krisis, 2);
  assert.deepEqual(read.lookups, []);
  assert.deepEqual(read, work, 'the same as the version 2 match() writes');
  assert.throws(() => readWork(JSON.stringify({ ...v1, others: null })), /others/, 'version 1 must name the other dataset');
  const refused = (w, re) => assert.throws(() => readWork(JSON.stringify(w)), (e) => e.name === 'DataError' && re.test(e.message), re);
  const g = await gathered([tyne()]);
  const r = await runLookup({ lookup: lookupWith(fakeWhg(byName({ Newcastle: NEWCASTLES }))), subjects: g.subjects, places: g.places, now: clock() });
  const ok = JSON.parse(serialiseWork(r.work));
  assert.ok(readWork(JSON.stringify(ok)), 'control: the file as written reads');
  const tamper = (f) => { const w = JSON.parse(JSON.stringify(ok)); f(w); return w; };
  refused(tamper((w) => { w.candidates[0].lookup = 'l9'; }), /names a lookup the file does not have/);
  refused(tamper((w) => { delete w.candidates[0].gazetteer; }), /no gazetteer figures/);
  refused(tamper((w) => { w.lookups[0].queries[X + 'elsewhere'] = { state: 'answered', sent: [] }; }), /looked up a place the file does not list/);
  refused(tamper((w) => { w.lookups[0].queries[A('newcastle')].state = 'done'; }), /not pending, answered, unanswered or stopped/);
  refused(tamper((w) => { delete w.candidates[0].lookup; }), /comes from a local match, but the file names no other dataset/);
  refused(tamper((w) => { w.lookups.push({ ...w.lookups[0] }); }), /two lookups have the id l1/);
  refused(tamper((w) => { w.krisis = 1; w.others = { title: 'B', files: [] }; }), /version 1, which has no lookups/);
});
test('gather reads the subject places alone, with the links their dataset states', async () => {
  const g = await gathered([place('a', 'Alpha', [at(0, 50), { identities: [{ subject: A('a'), object: X + 'z', identityType: 'exactMatch' }], negated: true, sources: [src] }]), place('b', 'Beta', [at(1, 50)])]);
  assert.deepEqual(g.places.map((p) => [p.iri, p.label, p.identities]), [[A('a'), 'Alpha', { linked: [], denied: [X + 'z'] }], [A('b'), 'Beta', { linked: [], denied: [] }]]);
  assert.equal(g.subjects.title, 'Dataset A');
  assert.equal(g.subjects.files[0].name, 'a.json');
});

// ---- licences and services -------------------------------------------------------------------------------------------
test('licences are read from the answer, never assumed: unknown stays unknown', () => {
  assert.equal(LOOKUP_WORDS.licence(licenceOf(ATTRIBUTION, 'un')), 'licence not named, terms partly unknown');
  assert.equal(LOOKUP_WORDS.licence(licenceOf(ATTRIBUTION, 'osm')), 'licence unknown');
  assert.equal(LOOKUP_WORDS.licence(licenceOf(null, 'gn')), 'licence unknown');
  assert.equal(LOOKUP_WORDS.licence(licenceOf(ATTRIBUTION, 'gn')), 'CC-BY-4.0');
  const other = { sources: { x: { license: { spdx_id: 'X-TEST-1.0', permits_commercial: false, no_derivatives: true }, redistributable: false } } };
  assert.equal(LOOKUP_WORDS.licence(licenceOf(other, 'x')), 'X-TEST-1.0, non-commercial, no derivatives, not to be passed on', 'whatever the answer says');
  assert.deepEqual(licenceOf(ATTRIBUTION, 'un'), { spdx: null, commercial: null, derivatives: null, redistributable: null });
});
test('a source is not redistributable only when it says false; missing or null is not known, never true', () => {
  const lic = { spdx_id: 'CC-BY-4.0', permits_commercial: true, no_derivatives: false };
  const said = (redistributable) => ({ sources: { gn: { license: lic, ...(redistributable === undefined ? {} : { redistributable }) } } });
  assert.equal(licenceOf(said(false), 'gn').redistributable, false);
  assert.equal(LOOKUP_WORDS.licence(licenceOf(said(false), 'gn')), 'CC-BY-4.0, not to be passed on');
  assert.equal(licenceOf(said(true), 'gn').redistributable, true, 'control: true is read as true');
  assert.equal(LOOKUP_WORDS.licence(licenceOf(said(true), 'gn')), 'CC-BY-4.0');
  for (const v of [undefined, null, 'no', 0]) {
    assert.equal(licenceOf(said(v), 'gn').redistributable, null, `${JSON.stringify(v)} is not known`);
    assert.equal(LOOKUP_WORDS.licence(licenceOf(said(v), 'gn')), 'CC-BY-4.0, terms partly unknown', `${JSON.stringify(v)} is not taken for true`);
  }
  // Not redistributable without a licence is still said, not lost as "licence unknown".
  assert.equal(LOOKUP_WORDS.licence(licenceOf({ sources: { gn: { redistributable: false } } }, 'gn')), 'licence not named, not to be passed on, terms partly unknown');
  assert.equal(licenceOf({ sources: { gn: { redistributable: null } } }, 'gn'), null, 'control: nothing said is licence unknown');
});
test('another reconciliation service is cited by its address; mergeAnswers and startLookup work on a work file directly', () => {
  const s = serviceOf('https://recon.example.net/api');
  assert.deepEqual(s, { endpoint: 'https://recon.example.net/api', title: 'recon.example.net', uri: 'https://recon.example.net/' });
  assert.deepEqual(serviceOf(WHG_ENDPOINT), WHG_SERVICE);
  assert.deepEqual(gazetteerSource(s), { title: 'recon.example.net', authorityType: 'dataset', '@id': 'https://recon.example.net/' });
  const work = newWork({ title: 'A', files: [] }, { now: NOW });
  const p = { iri: A('p'), label: 'P', names: ['P'], point: null };
  const plan = planQueries([p], { service: s });
  assert.ok(plan.queries.every((q) => !q.type), 'no WHG type for another service');
  const rec = startLookup(work, { service: s, parameters: {}, plan, now: NOW });
  const list = [{ id: 'https://recon.example.net/p/1', iri: 'https://recon.example.net/p/1', name: 'P', altNames: [], coords: null, ccodes: null, score: 3 }];
  list.key = [p.iri, 'P'];
  mergeAnswers(work, rec, p, [list], { now: NOW });
  assert.equal(work.candidates.length, 1);
  assert.deepEqual(attestationsFrom((decide(work, work.candidates[0].id, 'match', { at: NOW }), work), { reviewer: REVIEWER })[0].attestation.citations, [{ source: gazetteerSource(s) }]);
});
test('a query the service refuses inside a good answer is unanswered and marked refused, with the service\'s words as the module cleaned them', async () => {
  const g = await gathered([tyne(), place('york', 'York', [at(-1.08, 53.96)])]);
  const r = await runLookup({ lookup: lookupWith(fakeWhg((q) => (q.query === 'York' ? { result: [], error: 'start after end' } : { result: [] }))), subjects: g.subjects, places: g.places, now: clock() });
  assert.deepEqual(r.record.queries[A('york')], { state: 'unanswered', sent: ['York'], refused: true, error: 'start after end', found: 0, added: 0 });
  assert.deepEqual(r.record.queries[A('newcastle')], { state: 'answered', sent: ['Newcastle'], found: 0, added: 0 }, 'control');
  // The words carry the token (lookupWith's 'test-token'): the gazetteer module cleans them, and Krisis keeps them as cleaned.
  const fake = fakeWhg((q) => (q.query === 'York' ? { result: [], error: 'bad scope for test-token' } : { result: [] }));
  const kept = await runLookup({ lookup: lookupWith(fake), subjects: g.subjects, places: g.places, now: clock() });
  assert.equal(fake.calls[0].headers.Authorization, 'Bearer test-token', 'control: that token was in play');
  assert.equal(kept.record.queries[A('york')].error, 'bad scope for [token]');
  assert.ok(!serialiseWork(kept.work).includes('test-token'), 'not in the work file');
  assert.equal(kept.record.queries[A('york')].state, 'unanswered', 'still not "no match"');
});

test('a first batch empty for every query is suspect: its places are not answered, and the lookup stops', async () => {
  const g = await gathered([tyne(), place('york', 'York', [at(-1.08, 53.96)], { ccodes: ['GB'] }), place('ely', 'Ely', [at(0.26, 52.4)], { ccodes: ['GB'] })]);
  const r = await runLookup({ lookup: lookupWith(fakeWhg(), { batchSize: 2 }), subjects: g.subjects, places: g.places, options: { countries: true }, now: clock() });
  assert.equal(r.stopped.kind, 'suspect');
  assert.deepEqual(Object.values(r.record.queries).map((q) => [q.state, !!q.suspect]), [['unanswered', true], ['unanswered', true], ['stopped', false]]);
  assert.equal(r.record.counts.notFound, 0, 'not counted as found nothing');
  assert.match(LOOKUP_WORDS.stopped(r.stopped), /answered nothing at all/);
  const ok = await runLookup({ lookup: lookupWith(fakeWhg(byName({ York: NEWCASTLES.slice(0, 1) })), { batchSize: 2 }), subjects: g.subjects, places: g.places, options: { countries: true }, now: clock() });
  assert.equal(ok.stopped, null, 'control: one candidate in the batch, and it is trusted');
  assert.equal(ok.record.counts.notFound, 2);
});
test('the review lists a lookup\'s candidates in the order ranked: the nearest Newcastle first, though its name is less alike', async () => {
  const { candidatesOf } = await import('../src/engine/krisis/work.js');
  const g = await gathered([place('newcastle', 'Newcastle', [at(-1.61, 54.97)])]);
  const tyneOnly = { ...NEWCASTLES[2], alt_names: [] };   // named "Newcastle upon Tyne" only
  const r = await runLookup({ lookup: lookupWith(fakeWhg(byName({ Newcastle: [NEWCASTLES[1], NEWCASTLES[0], tyneOnly] }))), subjects: g.subjects, places: g.places, now: clock() });
  const listed = candidatesOf(r.work, A('newcastle'));
  assert.ok(listed[0].similarity_score < listed[1].similarity_score, 'control: the nearest is the less alike by name');
  assert.deepEqual(listed.map((c) => c.other.ccodes[0]), ['GB', 'NA', 'AU']);
});
test('"pending" is the places a lookup of this service has not answered; a place never looked up is not among them', async () => {
  const g = await gathered([tyne(), place('york', 'York', [at(-1.08, 53.96)]), place('ely', 'Ely', [at(0.26, 52.4)])]);
  const fake = fakeWhg((q) => (q.query === 'York' ? { result: [], gateway: { answered: false } } : byName({ Newcastle: NEWCASTLES })(q)));
  const first = await runLookup({ lookup: lookupWith(fake), subjects: g.subjects, places: g.places, options: { only: [A('newcastle'), A('york')] }, now: clock() });
  const pending = selectPlaces({ work: first.work, places: g.places, which: 'pending', service: WHG_SERVICE }).map((p) => p.iri);
  assert.deepEqual(pending, [A('york')], 'Ely, never looked up, is not pending');
  assert.deepEqual(selectPlaces({ work: first.work, places: g.places, which: 'all', service: WHG_SERVICE }).length, 3, 'control');
  assert.deepEqual(selectPlaces({ work: first.work, places: g.places, which: 'pending', service: serviceOf('https://other.example.org/r') }), [], 'another service has answered nothing, and has nothing pending');
});
test('a dataset\'s link to the authority\'s own address counts as a link to the WHG candidate (never as the target)', async () => {
  const cands = [NEWCASTLES[2], { id: 'place:wd:Q1425428', name: 'Newcastle', score: 90, repr_point: [-1.6, 54.97] }, { id: 'place:osm:r65606', name: 'Newcastle', score: 80, repr_point: [-1.6, 54.97] }];
  const link = (object, negated) => ({ identities: [{ subject: A('newcastle'), object, identityType: 'exactMatch' }], ...(negated ? { negated: true } : {}), sources: [src] });
  const g = await gathered([place('newcastle', 'Newcastle', [at(-1.61, 54.97), link('http://sws.geonames.org/2641673', false), link('https://www.wikidata.org/entity/Q1425428', true)])]);
  const r = await runLookup({ lookup: lookupWith(fakeWhg(byName({ Newcastle: cands }))), subjects: g.subjects, places: g.places, now: clock() });
  assert.deepEqual(r.work.candidates.map((c) => c.candidate_candidate), [W3ID + 'place:osm:r65606'], 'the w3id address, when suggested');
  assert.deepEqual([r.record.counts.skipped.linked, r.record.counts.skipped.denied], [1, 1]);
  const plain = await gathered([place('newcastle', 'Newcastle', [at(-1.61, 54.97)])]);
  const all = await runLookup({ lookup: lookupWith(fakeWhg(byName({ Newcastle: cands }))), subjects: plain.subjects, places: plain.places, now: clock() });
  assert.equal(all.work.candidates.length, 3, 'control: without the links, all three');
  assert.ok(authorityIris('place:gn:2641673').includes('https://sws.geonames.org/2641673/'));
  assert.ok(authorityIris('place:osm:r65606').includes('https://www.openstreetmap.org/relation/65606'));
  assert.deepEqual(authorityIris('place:whg:1'), []);
});
test('licences of WHG\'s own records fall back to their dataset, then to WHG\'s', () => {
  const a = { whg: { license: 'CC-BY-4.0' }, datasets: { 42: { license: { spdx_id: 'CC-BY-NC-4.0', permits_commercial: false, no_derivatives: false } } }, sources: {} };
  // The dataset's entry says nothing of redistribution, which is not known, never taken for allowed.
  assert.equal(LOOKUP_WORDS.licence(licenceOf(a, null, 42)), 'CC-BY-NC-4.0, non-commercial, terms partly unknown');
  assert.equal(LOOKUP_WORDS.licence(licenceOf({ ...a, datasets: { 42: { ...a.datasets[42], redistributable: true } } }, null, 42)), 'CC-BY-NC-4.0, non-commercial', 'control: said of the dataset');
  assert.equal(LOOKUP_WORDS.licence(licenceOf(a, 'whg', 7)), 'CC-BY-4.0, terms partly unknown', 'no dataset entry: WHG\'s own');
  assert.equal(licenceOf(a, 'gn', 42), null, 'an authority\'s record does not take WHG\'s licence');
  assert.equal(licenceOf({ sources: {} }, null), null);
});
test('another service: its ids made into addresses by a template, and its type from its manifest', async () => {
  const s = serviceOf('https://wd.example.org/reconcile');
  const g = await gathered([place('newcastle', 'Newcastle', [at(-1.61, 54.97)])]);
  const answer = () => ({ result: [{ id: 'Q1425428', name: 'Newcastle upon Tyne', score: 30 }] });
  const without = await runLookup({ lookup: createLookup({ endpoint: s.endpoint, fetch: fakeWhg(answer).fetch, queryRate: null, ...PRIVATE }), subjects: g.subjects, places: g.places, options: { service: s }, now: clock() });
  assert.equal(without.record.counts.skipped.noIri, 1, 'an id that is not an address is not suggested');
  const fake = fakeWhg(answer);
  const type = typeFromManifest({ name: 'x', defaultTypes: [{ id: 'Q486972', name: 'human settlement' }] });
  const withIt = await runLookup({ lookup: createLookup({ endpoint: s.endpoint, fetch: fake.fetch, queryRate: null, iri: iriFromTemplate('https://www.wikidata.org/entity/{{id}}'), ...PRIVATE }), subjects: g.subjects, places: g.places, options: { service: s, type }, now: clock() });
  assert.deepEqual(withIt.work.candidates.map((c) => c.candidate_candidate), ['https://www.wikidata.org/entity/Q1425428']);
  assert.equal(Object.values(fake.calls[0].body.queries)[0].type, 'Q486972');
  assert.equal(typeFromManifest({}), null);
  assert.throws(() => iriFromTemplate('https://example.org/'), /\{\{id\}\}/);
});
test('manifestSettings reads another service\'s type and view.url through the lookup, without the token; iriVia follows a template learnt later', async () => {
  const calls = [];
  const serve = (manifest) => async (url, init) => {
    calls.push({ method: init.method, headers: init.headers });
    if (init.method === 'GET') return manifest instanceof Response ? manifest : new Response(JSON.stringify(manifest), { status: 200 });
    const out = {};
    for (const k of Object.keys(JSON.parse(init.body).queries)) out[k] = { result: [{ id: 'Q1425428', name: 'Newcastle upon Tyne', score: 30 }] };
    return new Response(JSON.stringify(out), { status: 200 });
  };
  const endpoint = 'https://wd.example.org/reconcile';
  const holder = { template: null };
  const lookup = createLookup({ endpoint, token: 'other-token', fetch: serve({ name: 'x', defaultTypes: [{ id: 'Q486972', name: 'human settlement' }], view: { url: 'https://www.wikidata.org/entity/{{id}}' } }), queryRate: null, iri: iriVia(holder), ...PRIVATE });
  const m = await manifestSettings(lookup);
  assert.deepEqual(m, { read: true, type: 'Q486972', template: 'https://www.wikidata.org/entity/{{id}}' });
  assert.equal(calls[0].headers.Authorization, undefined, 'the manifest is asked for without the token');
  const s = serviceOf(endpoint);
  const g = await gathered([place('newcastle', 'Newcastle', [at(-1.61, 54.97)])]);
  const before = await runLookup({ lookup, subjects: g.subjects, places: g.places, options: { service: s, type: m.type }, now: clock() });
  assert.equal(calls[1].headers.Authorization, 'Bearer other-token', 'control: a query carries it');
  assert.equal(before.record.counts.skipped.noIri, 1, 'no template yet: the id is not an address');
  holder.template = m.template;
  const after = await runLookup({ lookup, subjects: g.subjects, places: g.places, options: { service: s, type: m.type }, now: clock() });
  assert.deepEqual(after.work.candidates.map((c) => c.candidate_candidate), ['https://www.wikidata.org/entity/Q1425428'], 'the template learnt later is used');
  assert.equal(iriVia({ template: null })('https://x.example.org/1'), 'https://x.example.org/1', 'an id that is an address is its own');
  // Unread, or with a view.url that is not a template: nothing taken from it, and no throw.
  const refused = createLookup({ endpoint, fetch: serve(new Response('{}', { status: 500 })), queryRate: null, maxRetries: 0, ...PRIVATE });
  assert.deepEqual(await manifestSettings(refused), { read: false, type: null, template: null });
  const odd = createLookup({ endpoint, fetch: serve({ name: 'x', view: { url: 'https://example.org/' } }), queryRate: null, ...PRIVATE });
  assert.deepEqual(await manifestSettings(odd), { read: true, type: null, template: null });
});
test('WHG\'s type is the gazetteer module\'s own, and every WHG query carries it', async () => {
  assert.equal(WHG_PLACE_TYPE, MODULE_PLACE_TYPE);
  assert.equal(WHG_PLACE_TYPE, 'Place');
  const g = await gathered([tyne()]);
  const fake = fakeWhg();
  await runLookup({ lookup: lookupWith(fake), subjects: g.subjects, places: g.places, now: clock() });
  assert.deepEqual(Object.values(fake.calls[0].body.queries).map((q) => q.type), ['Place']);
});
test('--near sends a point and radius; an answer that says the filter was not applied is warned of', async () => {
  const g = await gathered([tyne(), place('york', 'York', [at(-1.08, 53.96)])]);
  const fake = fakeWhg((q) => ({ result: NEWCASTLES.slice(2), ...(q.query === 'York' ? { scope: { applied: false } } : { scope: { applied: true } }) }));
  const r = await runLookup({ lookup: lookupWith(fake), subjects: g.subjects, places: g.places, options: { nearKm: 25 }, now: clock() });
  const q0 = Object.values(fake.calls[0].body.queries)[0];
  assert.deepEqual([q0.lat, q0.lng, q0.radius], [54.97, -1.61, 25]);
  assert.equal(r.record.queries[A('york')].scopeNotApplied, true);
  assert.equal(r.record.queries[A('newcastle')].scopeNotApplied, undefined, 'control: applied');
  assert.match(LOOKUP_WORDS.summary(r.record.counts, 'WHG').counted, /for 1 place the gazetteer did not apply the distance filter/);
});
test('a fault while the answers are added leaves the places not added stopped, and the lookup finished', async () => {
  const g = await gathered([tyne(), place('york', 'York', [at(-1.08, 53.96)])]);
  const bad = { batchSize: 25, reconcile: async (qs) => Object.assign(qs.map((q) => Object.assign(q.query === 'York' ? [{ id: 'place:gn:1', iri: W3ID + 'place:gn:1', name: 'York', altNames: 5 }] : [], { key: q.key })), { attribution: null }) };
  let thrown = null;
  const work = newWork(g.subjects, { now: NOW });
  try { await runLookup({ lookup: bad, work, places: g.places, now: clock() }); } catch (e) { thrown = e; }
  assert.ok(thrown instanceof TypeError, 'the fault is thrown on');
  const rec = work.lookups[0];
  assert.deepEqual(Object.values(rec.queries).map((q) => q.state), ['answered', 'stopped']);
  assert.ok(rec.finished_at);
  assert.equal(rec.stopped.kind, 'fault');
});
test('a WHG match cites WHG however the caller gives the other dataset\'s source, and a review without another dataset finishes', async () => {
  const g = await gathered([tyne()]);
  const r = await runLookup({ lookup: lookupWith(fakeWhg(byName({ Newcastle: NEWCASTLES }))), subjects: g.subjects, places: g.places, now: clock() });
  decide(r.work, r.work.candidates[0].id, 'match', { at: NOW });
  const made = attestationsFrom(r.work, { reviewer: REVIEWER, source: { title: 'Dataset B', authorityType: 'dataset' } });
  assert.deepEqual(made[0].attestation.citations, [{ source: gazetteerSource(WHG_SERVICE) }]);
  const subjects = await detect([textFile(JSON.stringify(doc([tyne()])), 'a.json')]);
  const e = env();
  const done = await apply({ subjects, work: serialiseWork(r.work), options: { output: 'attestations', reviewer: REVIEWER } }, e);
  assert.equal(done.report.errors, 0, JSON.stringify(done.report.items));
  assert.deepEqual(done.attestations[0].attestation.citations, [{ source: gazetteerSource(WHG_SERVICE) }]);
});

test('currentIdentities: identities from every attestation and the record, denials, withdrawals honoured, WHG addresses normalised', () => {
  const P = A('p'), Q = A('q');
  const records = [
    { '@id': P, label: 'P', identityRelations: [{ object: X + 'nested', identityType: 'exactMatch' }], attestations: [
      { '@id': P + '#a1', identities: [{ subject: P, object: X + 'kept', identityType: 'exactMatch' }, { subject: P, object: 'https://whgazetteer.org/entity/place:gn:1/api', identityType: 'closeMatch' }], sources: [src] },
      { '@id': P + '#a2', identities: [{ subject: P, object: X + 'retracted', identityType: 'exactMatch' }], sources: [src] },
      { '@id': P + '#a3', meta: [{ metaType: 'plato:Retracts', targetAttestation: P + '#a2' }], sources: [src] },
      { '@id': P + '#a4', negated: true, identities: [{ subject: P, object: 'https://whgazetteer.org/places/12345678/portal/', identityType: 'exactMatch' }], sources: [src] },
    ] },
    { '@id': Q, label: 'Q', attestations: [{ identities: [{ subject: Q, object: P, identityType: 'exactMatch' }], sources: [src] }] },
  ];
  const m = currentIdentities(records);
  assert.deepEqual([...m.get(P).linked].sort(), [X + 'kept', X + 'nested', Q, W3ID + 'place:gn:1'].sort());
  assert.deepEqual([...m.get(P).denied], ['https://whgazetteer.org/places/12345678/portal/'], 'a legacy address kept as found');
  assert.ok(![...m.get(P).linked].includes(X + 'retracted'), 'withdrawn');
  // Control: without the retraction, the relation holds.
  const unretracted = currentIdentities([{ ...records[0], attestations: records[0].attestations.filter((a) => a['@id'] !== P + '#a3') }]);
  assert.ok(unretracted.get(P).linked.has(X + 'retracted'));
  assert.equal(linkState(m.get(P), { id: 'place:gn:1', iri: W3ID + 'place:gn:1' }), 'linked');
  assert.equal(linkState(m.get(P), { id: 'place:gn:2', iri: W3ID + 'place:gn:2' }), null, 'control');
  assert.equal(linkState({ linked: ['https://sws.geonames.org/2/'], denied: [] }, { id: 'place:gn:2', iri: W3ID + 'place:gn:2' }), 'linked', 'the authority\'s address');
});

test('currentIdentities: exactMatch links kept apart in exact; linked keeps every type; linkState { exact } reads exact', () => {
  const P = A('p');
  const records = [{ '@id': P, label: 'P',
    identityRelations: [{ object: X + 'nested-exact', identityType: 'exactMatch' }, { object: X + 'nested-close', identityType: 'closeMatch' }, { object: X + 'nested-untyped' }],
    attestations: [
      { '@id': P + '#a1', identities: [{ subject: P, object: X + 'close', identityType: 'closeMatch' }, { subject: P, object: X + 'exact', identityType: 'exactMatch' }, { subject: P, object: 'https://sws.geonames.org/2641673/', identityType: 'exactMatch' }], sources: [src] },
      { '@id': P + '#a2', negated: true, identities: [{ subject: P, object: X + 'denied', identityType: 'exactMatch' }], sources: [src] },
      { '@id': P + '#a3', identities: { subject: P, object: X + 'withdrawn', identityType: 'exactMatch' }, sources: [src] },
      { '@id': P + '#a4', meta: [{ metaType: 'plato:Retracts', targetAttestation: P + '#a3' }], sources: [src] },
    ] }];
  const e = currentIdentities(records).get(P);
  assert.ok(e.linked.has(X + 'close') && !e.exact.has(X + 'close'), 'closeMatch: linked, not exact');
  assert.ok(e.linked.has(X + 'exact') && e.exact.has(X + 'exact'), 'exactMatch: both');
  assert.ok(e.denied.has(X + 'denied') && !e.linked.has(X + 'denied') && !e.exact.has(X + 'denied'), 'a negated exactMatch: denied only');
  assert.ok(!e.linked.has(X + 'withdrawn') && !e.exact.has(X + 'withdrawn') && !e.denied.has(X + 'withdrawn'), 'a withdrawn exactMatch: neither');
  const kept = currentIdentities([{ ...records[0], attestations: records[0].attestations.filter((a) => a['@id'] !== P + '#a4') }]).get(P);
  assert.ok(kept.exact.has(X + 'withdrawn'), 'control: without the retraction, it is exact');
  assert.ok(e.exact.has(X + 'nested-exact') && e.linked.has(X + 'nested-close') && !e.exact.has(X + 'nested-close'), 'nested identityRelations carry their type');
  assert.ok(e.linked.has(X + 'nested-untyped') && !e.exact.has(X + 'nested-untyped'), 'a missing type is not exact');
  assert.deepEqual([...e.exact].sort(), [X + 'exact', 'https://sws.geonames.org/2641673/', X + 'nested-exact'].sort());
  // Symmetric, and normalised as linked is.
  const q = currentIdentities([{ '@id': P, attestations: [{ identities: [{ subject: P, object: 'https://whgazetteer.org/entity/place:gn:1/api', identityType: 'exactMatch' }] }] }]);
  assert.ok(q.get(P).exact.has(W3ID + 'place:gn:1') && q.get('https://whgazetteer.org/entity/place:gn:1/api').exact.has(P));
  // Top-level relations, through the collector.
  const c = createIdentityCollector();
  c.addRelation(P, X + 'top-exact', false, null, 'exactMatch');
  c.addRelation(P, X + 'top-close', false, null, 'closeMatch');
  c.addRelation(P, X + 'top-untyped');
  const t = c.result().get(P);
  assert.deepEqual([[...t.linked].length, [...t.exact]], [3, [X + 'top-exact']]);
  // linkState: the default reads linked, { exact: true } reads exact, and authority addresses count.
  const gn = { id: 'place:gn:2641673', iri: W3ID + 'place:gn:2641673' };
  assert.equal(linkState(e, gn, { exact: true }), 'linked', 'the authority\'s address, found among the exact');
  assert.equal(linkState(e, { id: 'place:gn:9', iri: W3ID + 'place:gn:9' }, { exact: true }), null, 'control: another authority record');
  const close = { id: 'x', iri: X + 'close' };
  assert.equal(linkState(e, close), 'linked', 'default: any type links');
  assert.equal(linkState(e, close, { exact: true }), null, 'exact: a closeMatch does not');
  assert.equal(linkState(e, { id: 'x', iri: X + 'denied' }, { exact: true }), 'denied');
  // Array entries are still accepted.
  const arr = { linked: [X + 'close', 'https://sws.geonames.org/2641673/'], exact: ['https://sws.geonames.org/2641673/'], denied: [] };
  assert.equal(linkState(arr, gn, { exact: true }), 'linked');
  assert.equal(linkState(arr, close, { exact: true }), null);
  assert.equal(linkState(arr, close), 'linked', 'control: the same array entry, by default');
});
test('upstreamLicence: licenceOf without WHG\'s own licence, for copied data', () => {
  const d = { license: { spdx_id: 'CC-BY-NC-4.0', permits_commercial: false, no_derivatives: false } };
  const a = { ...ATTRIBUTION, datasets: { 42: d } };
  // A WHG-native record (place:whg:42:…, or no namespace) whose dataset gives a licence: that licence.
  for (const ns of ['whg', null]) {
    assert.equal(upstreamLicence(a, ns, 42).spdx, 'CC-BY-NC-4.0', `${ns}: the contributed dataset's`);
    assert.deepEqual(upstreamLicence(a, ns, 42), licenceOf(a, ns, 42), `${ns}: as licenceOf`);
    // Without a dataset licence: null; licenceOf gives WHG's own.
    assert.equal(upstreamLicence(a, ns, 7), null, `${ns}: no dataset licence, unknown`);
    assert.equal(upstreamLicence(ATTRIBUTION, ns, 42), null, `${ns}: no datasets at all, unknown`);
    assert.equal(licenceOf(a, ns, 7).spdx, 'CC-BY-4.0', `${ns}: control, licenceOf takes WHG's`);
    assert.equal(licenceOf(ATTRIBUTION, ns, 42).spdx, 'CC-BY-4.0');
  }
  assert.equal(upstreamLicence({ sources: { whg: { license: 'CC-BY-4.0' } } }, 'whg'), null, 'nor WHG\'s entry among the sources');
  assert.equal(licenceOf({ sources: { whg: { license: 'CC-BY-4.0' } } }, 'whg').spdx, 'CC-BY-4.0', 'control');
  // A GeoNames record: both give its source's.
  assert.equal(upstreamLicence(a, 'gn', 42).spdx, 'CC-BY-4.0');
  assert.equal(licenceOf(a, 'gn', 42).spdx, 'CC-BY-4.0');
  assert.deepEqual(upstreamLicence(a, 'gn'), licenceOf(a, 'gn'));
  assert.equal(upstreamLicence(a, 'osm', 42), null, 'a source with no licence, as licenceOf');
  assert.equal(upstreamLicence({ sources: { gn: { redistributable: false } } }, 'gn').redistributable, false, 'not to be passed on is kept');
});
test('a WHG-native record whose dataset says not redistributable, with no licence, still warns', () => {
  const a = { ...ATTRIBUTION, datasets: { 42: { redistributable: false } } };
  for (const ns of ['whg', null]) for (const [name, f] of [['upstreamLicence', upstreamLicence], ['licenceOf', licenceOf]]) {
    const l = f(a, ns, 42);
    assert.notEqual(l, null, `${name} ${ns}: not merely "licence unknown"`);
    assert.equal(l.redistributable, false, `${name} ${ns}: the dataset's word is kept`);
    assert.equal(l.spdx, null, `${name} ${ns}: and not WHG's own licence in its place`);
    assert.equal(lookupPage.licenceWarns(l), true, `${name} ${ns}: warns`);
  }
  // Control: a dataset entry that says nothing is still passed over.
  const quiet = { ...ATTRIBUTION, datasets: { 42: { redistributable: null } } };
  for (const ns of ['whg', null]) {
    assert.equal(upstreamLicence(quiet, ns, 42), null, `${ns}: control, nothing said is unknown`);
    assert.equal(licenceOf(quiet, ns, 42).spdx, 'CC-BY-4.0', `${ns}: control, licenceOf falls back to WHG's`);
  }
});

// ---- found by the pre-push review of change 2 ---------------------------------------------------------------
// 25 obscure places, then one WHG knows, at 26th: the first batch is all empty.
const obscure = () => {
  const out = [...Array(25)].map((_, i) => ({ iri: A(`p${i}`), label: `Obscure field ${i}`, names: [`Obscure field ${i}`], point: null, ccodes: ['GB'], identities: { linked: [], denied: [] } }));
  out.push({ iri: A('known'), label: 'Known', names: ['Known'], point: null, ccodes: ['GB'], identities: { linked: [], denied: [] } });
  return out;
};
const knowsOnlyKnown = () => fakeWhg(byName({ Known: [{ id: 'place:gn:1', name: 'Known', score: 100 }] }));
test('a suspect first batch is passed by sending it again asked the same way: its empty answers are then accepted', async () => {
  const fake = knowsOnlyKnown(), lookup = lookupWith(fake), places = obscure();
  const first = await runLookup({ lookup, subjects: { title: 'T', files: [] }, places, options: { countries: true }, now: clock() });
  assert.equal(first.stopped?.kind, 'suspect', 'control: with a filter, the first batch is suspect');
  assert.equal(fake.calls.length, 1);
  const before = JSON.parse(JSON.stringify(first.work));   // runLookup changes the work file in place
  const again = await runLookup({ lookup, work: first.work, places, options: { countries: true, places: 'pending' }, now: clock() });
  assert.equal(again.stopped, null, 'sent again, unchanged: accepted');
  assert.equal(fake.calls.length, 3, 'the batch once more, and then the 26th place');
  assert.deepEqual(again.work.candidates.map((c) => c.candidate_candidate), [W3ID + 'place:gn:1'], 'Known is looked up and found');
  assert.equal(again.record.counts.notFound, 25, 'the 25 are now answered, with nothing found');
  assert.match(LOOKUP_WORDS.stopped(first.stopped), /send the same places again with the same settings[^.]*: their empty answers are then accepted as genuine/);
  // Asked another way (another limit), the batch is not the one the reviewer saw: suspect again.
  const changed = await runLookup({ lookup: lookupWith(knowsOnlyKnown()), work: before, places, options: { countries: true, places: 'pending', limit: 5 }, now: clock() });
  assert.equal(changed.stopped?.kind, 'suspect');
});
test('WHG asked without a filter is never suspect (nothing sent could be wrong); a filter or another service\'s type can be', async () => {
  const fake = knowsOnlyKnown();
  const plain = await runLookup({ lookup: lookupWith(fake), subjects: { title: 'T', files: [] }, places: obscure(), now: clock() });
  assert.equal(plain.stopped, null);
  assert.equal(plain.work.candidates.length, 1, 'Known found at the first sending');
  const near = await runLookup({ lookup: lookupWith(knowsOnlyKnown()), subjects: { title: 'T', files: [] }, places: obscure().map((p) => ({ ...p, point: [0, 51] })), options: { nearKm: 10 }, now: clock() });
  assert.equal(near.stopped?.kind, 'suspect', 'control: a distance filter');
  const other = createLookup({ endpoint: 'https://gaz.example.org/reconcile', fetch: knowsOnlyKnown().fetch, sleep: () => Promise.resolve(), queryRate: null, iri: (id) => 'https://gaz.example.org/' + id, ...PRIVATE });
  const typed = await runLookup({ lookup: other, subjects: { title: 'T', files: [] }, places: obscure(), options: { service: serviceOf('https://gaz.example.org/reconcile'), type: 'settlement' }, now: clock() });
  assert.equal(typed.stopped?.kind, 'suspect', 'control: another service\'s type');
});
test('a name typed for one place adds what it finds beside the candidates already there; a re-lookup of the place replaces them', async () => {
  const g = await gathered([tyne()]);
  const zennor = { id: 'place:gn:9', name: 'Newcastle upon Tyne', score: 100 };
  const fake = fakeWhg(byName({ Newcastle: NEWCASTLES, 'Newcastle upon Tyne': [zennor, NEWCASTLES[2]] }));
  const first = await runLookup({ lookup: lookupWith(fake), subjects: g.subjects, places: g.places, now: clock() });
  assert.equal(first.work.candidates.length, 3);
  const typed = await runLookup({ lookup: lookupWith(fake), work: first.work, places: g.places, options: { places: 'all', only: [A('newcastle')], query: 'Newcastle upon Tyne' }, now: clock() });
  assert.deepEqual(Object.values(fake.calls.at(-1).body.queries).map((q) => q.query), ['Newcastle upon Tyne'], 'only the name typed is sent');
  assert.deepEqual(typed.work.candidates.map((c) => c.candidate_candidate).sort(), [...NEWCASTLES.map((c) => W3ID + c.id), W3ID + 'place:gn:9'].sort(), 'the three kept, the new one added');
  assert.equal(typed.record.counts.skipped.duplicate, 1, 'one already a candidate: not added twice');
  assert.equal(typed.record.parameters.query, 'Newcastle upon Tyne');
  // Control: looked up again without a name typed, the undecided ones of WHG are replaced by what it answers now.
  const only = fakeWhg(byName({ Newcastle: [NEWCASTLES[0]] }));
  const again = await runLookup({ lookup: lookupWith(only), work: typed.work, places: g.places, options: { places: 'all', only: [A('newcastle')] }, now: clock() });
  assert.deepEqual(again.work.candidates.map((c) => c.candidate_candidate), [W3ID + NEWCASTLES[0].id]);
  assert.match(lookupPage.findLabel, /added to the candidates already here, which it does not replace/, 'the find form says so');
  await assert.rejects(runLookup({ lookup: lookupWith(fake), work: typed.work, places: g.places, options: { query: 'Anything' } }), /for one place/);
});
test('a place with no name is not looked up, and is counted: its address is never sent as a query', async () => {
  const g = await gathered([tyne(), { '@id': A('blank'), attestations: [at(0, 51)] }, { '@id': A('toponym'), attestations: [named('Senara')] }]);
  assert.equal(g.places.find((p) => p.iri === A('blank')).label, A('blank'), 'gather gives a place without a label its address as label');
  const plan = planQueries(g.places);
  assert.deepEqual(plan.queries.map((q) => q.query), ['Newcastle', 'Senara'], 'a toponym is a name, and is sent');
  assert.deepEqual([plan.preview.places, plan.preview.withoutName], [2, 1]);
  assert.match(LOOKUP_WORDS.preview(plan.preview).join(' '), /1 place has no name \(only a web address\), and is not looked up/);
  const fake = fakeWhg();
  const r = await runLookup({ lookup: lookupWith(fake), subjects: g.subjects, places: g.places, options: { places: 'all' }, now: clock() });
  const sent = fake.calls.flatMap((c) => Object.values(c.body.queries).map((q) => q.query));
  assert.ok(sent.includes('Newcastle'), 'control: the search finds what was sent');
  assert.ok(!sent.some((q) => q.includes(A('blank'))), 'the address was not sent');
  assert.equal(r.record.counts.withoutName, 1);
  assert.equal(r.record.queries[A('blank')], undefined, 'not among the places looked up');
  assert.match(LOOKUP_WORDS.summary(r.record.counts, 'WHG').counted, /1 place was not looked up, having no name/);
});
test('WHG is one service however its address is written: www and a trailing slash are recorded, compared and read as WHG_ENDPOINT', async () => {
  const www = 'https://www.whgazetteer.org/reconcile/';
  assert.equal(serviceOf(www).endpoint, WHG_ENDPOINT);
  assert.equal(serviceOf('https://gaz.example.org/reconcile/').endpoint, 'https://gaz.example.org/reconcile/', 'control: another service as given');
  const g = await gathered([tyne(), place('york', 'York', [at(-1.08, 53.96)])]);
  const fake = fakeWhg((q) => (q.query === 'York' ? { result: [], gateway: { answered: false } } : byName({ Newcastle: NEWCASTLES })(q)));
  // A caller that gives the service as it was typed.
  const first = await runLookup({ lookup: lookupWith(fake), subjects: g.subjects, places: g.places, options: { service: { ...WHG_SERVICE, endpoint: www } }, now: clock() });
  assert.equal(first.record.service.endpoint, WHG_ENDPOINT);
  assert.deepEqual(selectPlaces({ work: first.work, places: g.places, which: 'pending', service: WHG_SERVICE }).map((p) => p.iri), [A('york')], 'its unanswered place is pending for WHG');
  // A work file that wrote another of WHG's addresses (an earlier tool) is read with WHG's one.
  const file = JSON.parse(serialiseWork(first.work));
  file.lookups[0].service.endpoint = www;
  for (const c of file.candidates) c.gazetteer.service = www;
  const read = readWork(JSON.stringify(file));
  assert.equal(read.lookups[0].service.endpoint, WHG_ENDPOINT);
  assert.ok(read.candidates.every((c) => c.gazetteer.service === WHG_ENDPOINT));
  assert.equal(file.lookups[0].service.endpoint, www, 'what was given is not changed in place');
  // Looked up again by the canonical address, the undecided candidates of the www lookup are replaced, as of the same service.
  const again = await runLookup({ lookup: lookupWith(fakeWhg(byName({ Newcastle: [NEWCASTLES[0]] }))), work: read, places: g.places, options: { places: 'all', only: [A('newcastle')] }, now: clock() });
  assert.deepEqual(again.work.candidates.map((c) => c.candidate_candidate), [W3ID + NEWCASTLES[0].id]);
});
test('the preview is planned in requests of the lookup\'s own size, as many as are sent', async () => {
  const places = Array.from({ length: 30 }, (_, i) => ({ iri: A('p' + i), label: 'Place ' + i, names: ['Place ' + i], point: null }));
  const fake = fakeWhg(byName({ 'Place 0': NEWCASTLES.slice(0, 1) }));
  const lookup = lookupWith(fake, { batchSize: 10 });
  const plan = planLookup({ lookup, places, options: { places: 'all' } });
  assert.equal(plan.preview.requests, 3);
  await runLookup({ lookup, subjects: { title: 'T', files: [] }, places, options: { places: 'all' }, now: clock() });
  assert.equal(fake.calls.length, plan.preview.requests, 'as many requests sent as the preview said');
  assert.equal(planLookup({ lookup: lookupWith(fakeWhg()), places, options: { places: 'all' } }).preview.requests, 2, 'control: the default size, 25');
});
test('a work file is read by its own keys only: "constructor" is not a place it lists', async () => {
  const g = await gathered([tyne()]);
  const r = await runLookup({ lookup: lookupWith(fakeWhg(byName({ Newcastle: NEWCASTLES }))), subjects: g.subjects, places: g.places, now: clock() });
  const ok = JSON.parse(serialiseWork(r.work));
  assert.ok(readWork(JSON.stringify(ok)), 'control: the file as written reads');
  const tamper = (f) => { const w = JSON.parse(JSON.stringify(ok)); f(w); return JSON.stringify(w); };
  assert.throws(() => readWork(tamper((w) => { w.candidates[0].candidate_source = 'constructor'; })), /is for a place the file does not list \(constructor\)/);
  assert.throws(() => readWork(tamper((w) => { w.lookups[0].queries.constructor = { state: 'answered', sent: ['x'] }; })), /looked up a place the file does not list \(constructor\)/);
  assert.throws(() => readWork(tamper((w) => { delete w.krisis; w.__proto__ = undefined; })), /no "krisis" version/);
});

// ---- change 2 on change 1: where the two meet ----------------------------------------------------------
// Each of these failed, or would fail, on a rebase that kept one side only: change 1 finishing a review
// that has no other dataset, change 1's stand-in titles and change 2's tap in one reading, change 1's
// ranking of local candidates and change 2's order for a lookup's.
const { candidatesOf } = await import('../src/engine/krisis/work.js');
const { ALGORITHM } = await import('../src/engine/krisis/match.js');
const { krisisNote, KRISIS_TEXT } = await import('../src/engine/words.js');
const WHG_CITED = [{ source: gazetteerSource(WHG_SERVICE) }];

test('a review of lookups alone (no other dataset) finishes with either output, the title options ignored, every attestation citing WHG', async () => {
  const g = await gathered([tyne()]);
  const r = await runLookup({ lookup: lookupWith(fakeWhg(byName({ Newcastle: NEWCASTLES }))), subjects: g.subjects, places: g.places, now: clock() });
  assert.equal(r.work.others, null, 'control: the review has no other dataset');
  decide(r.work, r.work.candidates.find((c) => c.gazetteer.id === 'place:gn:2641673').id, 'match', { at: NOW });
  decide(r.work, r.work.candidates.find((c) => c.gazetteer.id === 'place:gn:2155472').id, 'distinct', { at: NOW, basis: 'Another continent' });
  const subjects = await detect([textFile(JSON.stringify(doc([tyne()])), 'a.json')]);
  for (const output of ['attestations', 'dataset']) {
    for (const othersTitle of [undefined, 'A title for no dataset']) {
      const done = await apply({ subjects, work: serialiseWork(r.work), options: { output, reviewer: REVIEWER, othersTitle } }, env());
      const what = `${output}, othersTitle ${othersTitle}`;
      assert.equal(done.report.errors, 0, `${what}: ${JSON.stringify(done.report.items)}`);
      assert.equal(done.attestations.length, 2, what);
      for (const { attestation } of done.attestations) assert.deepEqual(attestation.citations, WHG_CITED, what);
      assert.ok(!done.report.items.some((i) => i.kind === 'others-title-is-file-name'), `${what}: no other dataset, so no warning of its title`);
      assert.equal(done.outputs.length, 1, what);
    }
  }
});

test('finishing a review with local and WHG matches: the other dataset\'s title, given or warned of, is cited for its own candidates only', async () => {
  const subjects = await detect([textFile(JSON.stringify(doc([tyne()])), 'a.json')]);
  // The other dataset gives no title: its file's name stands in, and finishing warns of it.
  const others = await detect([textFile(JSON.stringify({ profile: 'place-centric', spatialEntities: [{ '@id': X + 'b/newcastle', label: 'Newcastle', attestations: [at(-1.6, 54.97)] }] }), 'b.json')]);
  const m = await match({ subjects, others, options: { now: NOW } }, env());
  assert.equal(m.work.others.titleFrom, 'file-name', 'control: the other dataset gives no title');
  const g = await gather({ subjects, options: {} }, env());
  const r = await runLookup({ lookup: lookupWith(fakeWhg(byName({ Newcastle: NEWCASTLES }))), work: m.work, places: g.places, options: { places: 'all' }, now: clock() });
  decide(r.work, r.work.candidates.find((c) => !c.lookup).id, 'match', { at: NOW });
  decide(r.work, r.work.candidates.find((c) => c.gazetteer?.id === 'place:gn:2641673').id, 'match', { at: NOW });
  const finish = (othersTitle) => apply({ subjects, work: serialiseWork(r.work), options: { output: 'attestations', reviewer: REVIEWER, othersTitle } }, env());
  const given = await finish('Dataset B');
  assert.equal(given.report.errors, 0, JSON.stringify(given.report.items));
  const cites = (done) => done.attestations.map((a) => a.attestation.citations[0].source.title);
  assert.deepEqual(cites(given), ['Dataset B', 'World Historical Gazetteer']);
  assert.ok(!given.report.items.some((i) => i.kind === 'others-title-is-file-name'), 'a title given: no warning');
  const untitled = await finish(undefined);
  assert.deepEqual(cites(untitled), ['b.json', 'World Historical Gazetteer'], 'control: the file\'s name, for the local candidate only');
  assert.ok(untitled.report.items.some((i) => i.kind === 'others-title-is-file-name' && i.message === KRISIS_TEXT.othersTitleIsFileName('b.json')), 'control: warned of');
});

test('gather reads a dataset as match does: its own title or its file\'s name as a stand-in, and the links it states', async () => {
  const linked = place('newcastle', 'Newcastle', [at(-1.61, 54.97), { identities: [{ subject: A('newcastle'), object: X + 'b/newcastle', identityType: 'exactMatch' }], sources: [src] }]);
  const titled = await gathered([linked]);
  assert.deepEqual([titled.subjects.title, titled.subjects.titleFrom], ['Dataset A', 'gazetteer']);
  assert.deepEqual(titled.places[0].identities.linked, [X + 'b/newcastle'], 'the tap saw the identity relation');
  // LPF with no title: its reader gives the dataset its file's name, which is a stand-in, not a title.
  const { go, outText } = await import('./engine.js');
  const c = await go([textFile(JSON.stringify({ profile: 'place-centric', gazetteer: { '@id': X + 'a' }, spatialEntities: [linked] }), 'a.json')], 'convert', 'lpf');
  const text = outText(c.e, 'a.geojson');
  assert.equal(JSON.parse(text).title, undefined, 'control: the LPF file gives no title of its own');
  const untitled = await gather({ subjects: await detect([textFile(text, 'untitled.geojson')]), options: {} }, env());
  assert.deepEqual([untitled.subjects.title, untitled.subjects.titleFrom], ['untitled.geojson', 'file-name'], 'the reader\'s stand-in is not taken for a title');
  assert.equal(untitled.places.length, 1, 'control: the place was read');
});

test('the other dataset\'s candidates are listed by change 1\'s ranking, a lookup\'s after them in the order the lookup ranked them', async () => {
  const subjects = await detect([textFile(JSON.stringify(doc([place('newcastle', 'Newcastle', [at(-1.61, 54.97)])])), 'a.json')]);
  // b/1 is the nearer and the less alike by name: change 1 lists by score first, b/2 before it.
  const others = await detect([textFile(JSON.stringify({ profile: 'place-centric', gazetteer: { title: 'Dataset B' }, spatialEntities: [
    { '@id': X + 'b/1', label: 'Newcastel', attestations: [at(-1.6, 54.97)] },
    { '@id': X + 'b/2', label: 'Newcastle', attestations: [at(-1.62, 54.96)] },
  ] }), 'b.json')]);
  const m = await match({ subjects, others, options: { now: NOW } }, env());
  assert.equal(m.work.candidates.length, 2);
  const local = (id) => m.work.candidates.find((c) => c.candidate_candidate === X + id);
  assert.ok(local('b/1').similarity_score < local('b/2').similarity_score && local('b/1').distance_km < local('b/2').distance_km, 'control: score and distance disagree');
  m.work.candidates.sort((a, b) => a.similarity_score - b.similarity_score);   // worst first in the file
  const g = await gather({ subjects, options: {} }, env());
  const tyneOnly = { ...NEWCASTLES[2], alt_names: [] };
  const r = await runLookup({ lookup: lookupWith(fakeWhg(byName({ Newcastle: [NEWCASTLES[1], NEWCASTLES[0], tyneOnly] }))), work: m.work, places: g.places, options: { places: 'all' }, now: clock() });
  const listed = candidatesOf(r.work, A('newcastle'));
  assert.deepEqual(listed.map((c) => c.candidate_candidate).slice(0, 2), [X + 'b/2', X + 'b/1'], 'local: best score first');
  const looked = listed.slice(2);
  assert.deepEqual(looked.map((c) => c.other.ccodes[0]), ['GB', 'NA', 'AU'], 'lookup: nearest first');
  assert.ok(looked[0].similarity_score < looked[1].similarity_score, 'control: by score alone the nearest would not be first');
});

test('a lookup\'s candidates are not cut to the best few, nor do located and unlocated take turns: all are kept, the located first', async () => {
  const g = await gathered([place('newcastle', 'Newcastle', [at(-1.61, 54.97)])]);
  const located = [1, 2, 3, 4].map((i) => ({ id: `place:gn:${i}`, name: `Newcastle ${'x'.repeat(i)}`, score: 100, repr_point: [-1.61 + i / 10, 54.97], ccodes: ['GB'] }));
  const unlocated = [5, 6, 7].map((i) => ({ id: `place:gn:${i}`, name: 'Newcastle', score: 100, ccodes: ['GB'] }));
  const r = await runLookup({ lookup: lookupWith(fakeWhg(byName({ Newcastle: [...unlocated, ...located] }))), subjects: g.subjects, places: g.places, now: clock() });
  const listed = candidatesOf(r.work, A('newcastle'));
  assert.equal(listed.length, 7, 'more than topK (5)');
  assert.deepEqual(listed.map((c) => c.distance_km !== null), [true, true, true, true, false, false, false], 'located first, no turns');
  assert.ok(listed[4].similarity_score > listed[0].similarity_score, 'control: the unlocated are the more alike by name, so turns would put one second');
});

test('local candidates keep change 1\'s algorithm (krisis-names 5), a lookup\'s its own, in the work file and in each attestation\'s note', async () => {
  const subjects = await detect([textFile(JSON.stringify(doc([tyne()])), 'a.json')]);
  const others = await detect([textFile(JSON.stringify({ profile: 'place-centric', gazetteer: { title: 'Dataset B' }, spatialEntities: [{ '@id': X + 'b/newcastle', label: 'Newcastle', attestations: [at(-1.6, 54.97)] }] }), 'b.json')]);
  const m = await match({ subjects, others, options: { now: NOW } }, env());
  const g = await gather({ subjects, options: {} }, env());
  const r = await runLookup({ lookup: lookupWith(fakeWhg(byName({ Newcastle: NEWCASTLES }))), work: m.work, places: g.places, options: { places: 'all' }, now: clock() });
  const w = readWork(serialiseWork(r.work));
  assert.equal(ALGORITHM, 'krisis-names 5');
  assert.equal(w.algorithm_version, ALGORITHM, 'the file\'s, for its local candidates');
  assert.ok(w.candidates.filter((c) => c.lookup).every((c) => c.algorithm_version === LOOKUP_ALGORITHM));
  decide(w, w.candidates.find((c) => !c.lookup).id, 'match', { at: NOW });
  decide(w, w.candidates.find((c) => c.gazetteer?.id === 'place:gn:2641673').id, 'match', { at: NOW });
  const notes = attestationsFrom(w, { reviewer: REVIEWER }).map((x) => x.attestation.notes);
  assert.deepEqual(notes, [krisisNote('match', 'krisis-names 5'), krisisLookupNote('match', 'World Historical Gazetteer', LOOKUP_ALGORITHM)]);
});
