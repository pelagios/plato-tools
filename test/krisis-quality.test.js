// Krisis, the quality of what a lookup suggests (Issue #34, item 1): each candidate's kind of place and a
// preference for the place's own kind (#20, kinds.js), WHG's placeholder records left out and counted
// (#21, placeholders.js), and WHG's daily cap stopping a lookup in plain words (#22, whg.js A15). A fake
// fetch stands in for WHG, answering as whg.js says WHG does (place_types as probed on 12 October 2026).
//
// Each absence is paired with a presence: a candidate left out is kept when the one reason is taken
// away; a refusal by kind beside the same place accepted when the kinds go together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, textFile } from './engine.js';
import { detect } from '../src/engine/input.js';
import { createLookup, memoryLedger, WHG_ENDPOINT, whgPlaceTypes } from '../src/engine/gazetteer/index.js';
import { gather } from '../src/engine/krisis/match.js';
import { readWork, serialiseWork } from '../src/engine/krisis/work.js';
import { runLookup, rankGazetteer, typesOf, LOOKUP_ALGORITHM } from '../src/engine/krisis/lookup.js';
import { acceptGuarded, planGuarded } from '../src/engine/krisis/guards.js';
import { kindOf, kindFit, placeKinds, isProtocolType, candidateTypes } from '../src/engine/krisis/kinds.js';
import { isPlaceholder, placeholderRecord, PLACEHOLDER_PATTERNS } from '../src/engine/krisis/placeholders.js';
import { LOOKUP_WORDS, lookupPage, guardWords, SCOPE_WORDS } from '../src/engine/words.js';

const X = 'https://example.org/';
const W3ID = 'https://w3id.org/whg/id/';
const A = (id) => `${X}a/${id}`;
const NOW = '2026-10-12T12:00:00Z';
const clock = () => { let n = 0; return () => new Date(Date.parse(NOW) + 1000 * n++).toISOString(); };
const PROTOCOL = [{ id: 'https://whgazetteer.org/static/whg_schema.jsonld#Place', name: 'Place' }];
const PRIVATE = { get shared() { return false; }, get locks() { return null; }, get ledger() { return memoryLedger(); } };
function fakeWhg(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const out = { attribution: { sources: {} } };
    for (const [k, q] of Object.entries(body.queries)) { const a = answer(q, calls.length); if (a instanceof Response) return a; out[k] = a; }
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { fetch, calls };
}
const lookupWith = (fake) => createLookup({ endpoint: WHG_ENDPOINT, token: 'test-token', fetch: fake.fetch, sleep: () => Promise.resolve(), queryRate: null, ...PRIVATE });
/** A WHG candidate as it comes (A7), its kind in place_types and the protocol's Place in type. */
const cand = (id, name, point, placeTypes, more = {}) => ({ id, name, score: 100, match: true, description: 'Country: GB', ccodes: ['GB'], repr_point: point,
  namespace: id.split(':')[1], alt_names: [], type: PROTOCOL, place_types: placeTypes, confidence: 100, ...more });
const gn = (code, cls) => [{ identifier: code, label: cls }];

// ---- the kinds (#20) ------------------------------------------------------------------------------------
test('whgPlaceTypes reads place_types as WHG sends it per namespace (probed 12 October 2026); the protocol type is not a kind', () => {
  assert.deepEqual(whgPlaceTypes({ namespace: 'gn', place_types: gn('PPL', 'P') }), ['gn:P.PPL']);
  assert.deepEqual(whgPlaceTypes({ namespace: 'tgn', place_types: [{ identifier: 'aat:300008347', label: 'tgn' }, { identifier: 'aat:300008372', label: 'tgn' }] }), ['aat:300008347', 'aat:300008372']);
  assert.deepEqual(whgPlaceTypes({ namespace: 'osm', place_types: [{ identifier: 'village', label: 'osm' }] }), ['osm:village']);
  assert.deepEqual(whgPlaceTypes({ namespace: 'wd', place_types: [{ identifier: 'Q3957', label: 'wikidata' }] }), ['wikidata:Q3957']);
  assert.deepEqual(whgPlaceTypes({ namespace: 'kain_par', place_types: [{ identifier: 'ancient-parish', label: 'kain_par' }] }), ['kain_par:ancient-parish']);
  assert.deepEqual(whgPlaceTypes({ namespace: 'whg', place_types: [{ identifier: '', label: 'Village' }, { identifier: 'aat:300008372', label: 'villages' }] }), ['whg:Village', 'aat:300008372']);
  assert.deepEqual(whgPlaceTypes({ namespace: 'wd', place_types: [] }), [], 'none: not known');
  // Every WHG candidate's `type` is the protocol's Place (13,500 of 13,500 in the measurement): never shown as a kind.
  assert.deepEqual(typesOf({ raw: { namespace: 'gn', place_types: gn('LK', 'H'), type: PROTOCOL }, types: [{ id: PROTOCOL[0].id, name: 'Place' }] }), ['gn:H.LK']);
  assert.deepEqual(typesOf({ types: [{ id: PROTOCOL[0].id, name: 'Place' }] }), [], 'the protocol type alone is no kind');
  assert.deepEqual(typesOf({ types: [{ id: 'Q3957', name: 'town' }] }), ['town'], "control: another service's type is kept");
  assert.ok(isProtocolType('Place') && isProtocolType(PROTOCOL[0].id) && !isProtocolType('osm:place'));
});

test('kindOf reads AAT ids, GeoNames codes, source words and Wikidata classes; a code it does not know decides nothing', () => {
  assert.deepEqual(kindOf('gn:P.PPL'), { id: 'gn:P.PPL', aat: 'aat:300008347', facet: 'settlement' });
  assert.deepEqual(kindOf('gn:H.LK'), { id: 'gn:H.LK', aat: 'aat:300008680', facet: 'water' });
  assert.deepEqual(kindOf('gn:S.AIRF'), { id: 'gn:S.AIRF', aat: 'aat:300000679', facet: 'built' });
  assert.deepEqual(kindOf('gn:S.CH'), { id: 'gn:S.CH', aat: null, facet: null }, 'a spot not listed has no facet');
  assert.deepEqual(kindOf('gn:S.FRM'), { id: 'gn:S.FRM', aat: 'aat:300000206', facet: null }, 'a farm has no facet: it never conflicts');
  assert.deepEqual(kindOf('kain_par:parish'), { id: 'kain_par:parish', aat: 'aat:300387092', facet: 'division' });
  assert.deepEqual(kindOf('wikidata:Q532'), { id: 'wikidata:Q532', aat: 'aat:300008372', facet: 'settlement' });
  assert.deepEqual(kindOf('aat:300000681'), { id: 'aat:300000681', aat: 'aat:300000681', facet: 'built' }, 'airports: built, though WHG has them under inhabited places');
  assert.deepEqual(kindOf('aat:300008402'), { id: 'aat:300008402', aat: 'aat:300008402', facet: 'settlement' }, 'a narrower kind of inhabited place takes its facet from the bundled expansion');
  assert.deepEqual(kindOf('trismegistos:place'), { id: 'trismegistos:place', aat: null, facet: null });
  assert.equal(kindOf('Place'), null);
});

test('placeKinds reads the place\'s own types, by address (AAT, Wikidata) and by label, singular or plural', () => {
  const k = placeKinds({ types: ['Parishes'], typeIds: ['http://vocab.getty.edu/page/aat/300008375', 'https://example.org/vocab/thing'] });
  assert.deepEqual(k.map((x) => [x.id, x.aat, x.facet, x.label]), [['aat:300008375', 'aat:300008375', 'settlement', null], ['label:parishes', 'aat:300387092', 'division', 'Parishes']]);
  assert.deepEqual(placeKinds({ types: ['market'] }), [], 'a word not in the tables is no kind');
  assert.deepEqual(placeKinds({}), []);
});

test('kindFit: of the place\'s kind or narrower is a match; a lake for a parish conflicts; a village for a parish goes together; unknown either side decides nothing', () => {
  const parish = { types: ['parish'] }, settlement = { typeIds: ['http://vocab.getty.edu/aat/300008347'] };
  assert.equal(kindFit(parish, ['kain_par:parish']).fit, 'match');
  assert.equal(kindFit(settlement, ['osm:village']).fit, 'match', 'villages are narrower than inhabited places');
  assert.equal(kindFit({ types: ['village'] }, ['aat:300008347']).fit, 'other', 'a broader kind is not a match');
  assert.equal(kindFit(parish, ['gn:P.PPL']).fit, 'other', 'a parish and its village go together');
  assert.equal(kindFit(parish, ['gn:H.LK']).fit, 'conflict');
  assert.equal(kindFit({ types: ['town'] }, ['gn:S.AIRF']).fit, 'conflict', 'Bicester, the town, and its airfield');
  assert.equal(kindFit({ types: ['town'] }, ['gn:S.AIRF', 'osm:town']).fit, 'match', 'one kind of several is enough');
  assert.equal(kindFit({ types: ['town'] }, ['gn:S.AIRF', 'gn:P.PPL']).fit, 'other', 'and one that goes together is enough not to conflict');
  assert.equal(kindFit({ types: ['town'] }, ['gn:S.AIRF', 'trismegistos:place']).fit, 'conflict', 'a code not known adds nothing');
  assert.equal(kindFit({ types: ['farm'] }, ['gn:P.PPL']).fit, 'other', 'a farm never conflicts');
  assert.equal(kindFit({}, ['gn:H.LK']).fit, 'unknown');
  assert.equal(kindFit(parish, []).fit, 'unknown');
  const f = kindFit(parish, ['gn:H.LK']);
  assert.deepEqual([f.place.label, f.candidate.id], ['parish', 'gn:H.LK'], 'it says which kinds decided');
});

test('an airport or another transport facility is never of an inhabited place\'s kind, though WHG has them under ports and inhabited places; a real village is (the review of 12 October 2026)', () => {
  const settlement = { types: ['settlement'] }, inhabited = { typeIds: ['http://vocab.getty.edu/aat/300008347'] };
  assert.equal(kindFit(settlement, ['gn:S.AIRP']).fit, 'conflict');
  assert.equal(kindFit(settlement, ['osm:village']).fit, 'match', 'control: a village');
  assert.equal(kindFit(inhabited, ['aat:300000681']).fit, 'conflict', 'airports');
  assert.equal(kindFit(inhabited, ['aat:300000686']).fit, 'conflict', 'heliports');
  assert.equal(kindFit(inhabited, ['aat:300007917']).fit, 'conflict', 'a transport facility under ports');
  assert.equal(kindFit(inhabited, ['aat:300008372']).fit, 'match', 'control: villages');
  assert.equal(kindFit({ types: ['port'] }, ['aat:300000681']).fit, 'conflict', 'nor of a port\'s kind');
  assert.equal(kindFit({ types: ['port'] }, ['aat:300387511']).fit, 'match', 'control: seaports are ports');
});

test('a GeoNames spot (a church, an estate, a ruin), an island and a bay never conflict with a settlement or a parish; the listed built codes still do', () => {
  assert.equal(kindFit({ types: ['parish'] }, ['gn:S.CH']).fit, 'unknown');
  assert.equal(kindFit({ types: ['parish'] }, ['gn:S.EST']).fit, 'unknown');
  assert.equal(kindFit({ types: ['town'] }, ['gn:S.RUIN']).fit, 'unknown');
  assert.equal(kindFit({ types: ['village'] }, ['gn:T.ISL']).fit, 'other', 'Lindisfarne');
  assert.equal(kindFit({ types: ['village'] }, ['osm:island']).fit, 'other');
  assert.equal(kindFit({ types: ['town'] }, ['osm:bay']).fit, 'unknown', 'Whitley Bay');
  assert.equal(kindFit({ types: ['town'] }, ['gn:H.BAY']).fit, 'unknown');
  assert.equal(kindFit({ types: ['village'] }, ['gn:T.HLL']).fit, 'other', 'a village named after its hill');
  assert.equal(kindFit({ types: ['parish'] }, ['gn:S.CSTL']).fit, 'conflict', 'control: a castle still conflicts');
  assert.equal(kindFit({ types: ['town'] }, ['gn:H.LK']).fit, 'conflict', 'control: a lake still conflicts');
});

test('parishes as religious divisions and parishes are one kind', () => {
  assert.equal(kindFit({ typeIds: ['http://vocab.getty.edu/aat/300000773'] }, ['kain_par:parish']).fit, 'match');
  assert.equal(kindFit({ types: ['parish'] }, ['aat:300000773']).fit, 'match');
  assert.equal(kindFit({ types: ['parish'] }, ['aat:300000792']).fit, 'other', 'control: a township is not a parish');
});

test('distance stays primary: a conflicting kind goes after the rest of its group, and the place\'s own kind only breaks the tie between records within 2 km of each other', () => {
  const p = { iri: A('ashby'), label: 'Ashby', names: ['Ashby'], point: [-1.47, 52.75], types: ['parish'] };
  const c = (id, point, types, rank = 1) => ({ id, iri: W3ID + id, name: 'Ashby', altNames: [], coords: point, ccodes: ['GB'], kinds: types, answer_rank: rank });
  const lake = c('place:gn:1', [-1.471, 52.751], ['gn:H.LK']), village = c('place:gn:2', [-1.48, 52.75], ['gn:P.PPL']);
  const parish = c('place:kain_par:3', [-1.50, 52.76], ['kain_par:parish']), far = c('place:kain_par:4', [-3, 55], ['kain_par:parish']);
  const r = rankGazetteer(p, [lake, village, far, parish]);
  // The parish, 1.5 km from the village record, is the same place held by another source: its kind breaks the tie.
  assert.deepEqual(r.map((x) => [x.candidate.id, x.kind]), [['place:kain_par:3', 'match'], ['place:gn:2', 'other'], ['place:gn:1', 'conflict'], ['place:kain_par:4', 'match']]);
  // The control: the same candidates for a place that says nothing of its kind are ranked by distance, as before.
  const plain = rankGazetteer({ ...p, types: undefined }, [lake, village, far, parish]);
  assert.deepEqual(plain.map((x) => x.candidate.id), ['place:gn:1', 'place:gn:2', 'place:kain_par:3', 'place:kain_par:4']);
  assert.equal(LOOKUP_ALGORITHM, 'krisis-lookup 1', 'a candidate\'s address is unchanged by the kinds');
});

test('a record of the place\'s own kind 45 km off ranks BELOW the records of the right village 1 km off (the review of 12 October 2026: distance stays primary)', () => {
  const p = { iri: A('v'), label: 'Newton', names: ['Newton'], point: [-2.0, 53.0], types: ['village'] };
  const c = (id, point, types, rank) => ({ id, iri: W3ID + id, name: 'Newton', altNames: [], coords: point, ccodes: ['GB'], kinds: types, answer_rank: rank });
  const osmFar = c('place:osm:1', [-2.0, 53.405], ['osm:village'], 1), gn = c('place:gn:2', [-2.0, 53.009], ['gn:P.PPL'], 2), tgn = c('place:tgn:3', [-2.002, 53.01], ['aat:300008347'], 3);
  const r = rankGazetteer(p, [osmFar, gn, tgn]);
  assert.deepEqual(r.map((x) => [x.candidate.id, x.kind]), [['place:gn:2', 'other'], ['place:tgn:3', 'other'], ['place:osm:1', 'match']]);
  assert.ok(r[2].distance_km > 40 && r[2].distance_km < 50 && !r[2].far, 'within the greatest distance, so only distance put it last');
  // The control: an OSM village record beside the GeoNames one (within 2 km) is put first among them by its kind.
  const osmNear = c('place:osm:4', [-2.001, 53.012], ['osm:village'], 4);
  assert.deepEqual(rankGazetteer(p, [osmFar, gn, tgn, osmNear]).map((x) => x.candidate.id), ['place:osm:4', 'place:gn:2', 'place:tgn:3', 'place:osm:1']);
});

test('a place with no types ranks exactly as before the kinds were read, a candidate with no point among them', () => {
  const p = { iri: A('x'), label: 'Newcastle', names: ['Newcastle'], point: [-1.6, 54.97], ccodes: ['GB'] };
  const c = (id, coords, ccodes, rank, kinds) => ({ id, iri: W3ID + id, name: 'Newcastle', altNames: [], coords, ccodes, answer_rank: rank, kinds });
  const list = [c('place:a:1', null, ['GB'], 1, ['gn:H.LK']), c('place:a:2', [17, -22], ['NA'], 2, ['gn:P.PPL']), c('place:a:3', [-1.61, 54.97], ['GB'], 3, ['gn:S.AIRP']), c('place:a:4', null, null, 4, [])];
  // krisis-lookup 1's order: by distance, none last; then countries, letters, the service's order.
  const v1 = [...list].sort((a, b) => {
    const d = (x) => (x.coords ? Math.hypot(x.coords[0] + 1.6, x.coords[1] - 54.97) : Infinity);
    return d(a) - d(b) || (a.ccodes?.includes('GB') ? 0 : a.ccodes ? 2 : 1) - (b.ccodes?.includes('GB') ? 0 : b.ccodes ? 2 : 1) || a.answer_rank - b.answer_rank;
  }).map((x) => x.id);
  assert.deepEqual(rankGazetteer(p, list).map((x) => x.candidate.id), v1);
  assert.deepEqual(v1, ['place:a:3', 'place:a:2', 'place:a:1', 'place:a:4']);
  // The control: for a town, an airport (a conflicting kind) goes after a village further off, both near.
  const two = [c('place:a:3', [-1.61, 54.97], ['GB'], 1, ['gn:S.AIRP']), c('place:a:5', [-1.65, 54.97], ['GB'], 2, ['gn:P.PPL'])];
  assert.deepEqual(rankGazetteer(p, two).map((x) => x.candidate.id), ['place:a:3', 'place:a:5'], 'no types: by distance');
  assert.deepEqual(rankGazetteer({ ...p, types: ['town'] }, two).map((x) => x.candidate.id), ['place:a:5', 'place:a:3'], 'a town: the airport after');
});

// ---- the lookup end to end: kinds kept, placeholders left out, the bulk accept refusing a conflict ----
async function gathered(places) {
  const doc = { profile: 'place-centric', gazetteer: { '@id': X + 'a', title: 'Dataset A' }, spatialEntities: places };
  return gather({ subjects: await detect([textFile(JSON.stringify(doc), 'a.json')]), options: {} }, env());
}
const src = { '@id': X + 'source/s', title: 'S', authorityType: 'source' };
const placeOf = (id, label, lon, lat, type) => ({ '@id': A(id), label, attestations: [{ geometries: [{ geojson: { type: 'Point', coordinates: [lon, lat] } }], sources: [src],
  ...(type ? { types: [type] } : {}) }] });
const PARISH = { identifier: 'http://vocab.getty.edu/aat/300387092', label: 'parish' };
const TOWN = { label: 'town' };

test('gather keeps a place\'s type addresses beside their labels, and the lookup keeps a candidate\'s kinds in the work file, which reads back', async () => {
  const g = await gathered([placeOf('ashby', 'Ashby', -1.47, 52.75, PARISH)]);
  assert.deepEqual([g.places[0].types, g.places[0].typeIds], [['parish'], ['http://vocab.getty.edu/aat/300387092']]);
  const fake = fakeWhg(() => ({ result: [cand('place:kain_par:1', 'Ashby', [-1.471, 52.751], [{ identifier: 'parish', label: 'kain_par' }])] }));
  const { work } = await runLookup({ lookup: lookupWith(fake), subjects: g.subjects, places: g.places, options: { places: 'all' }, now: clock() });
  const back = readWork(serialiseWork(work));
  assert.deepEqual(back.candidates[0].other.types, ['kain_par:parish'], 'the kind, not the protocol\'s Place');
  assert.deepEqual(back.places[A('ashby')].typeIds, ['http://vocab.getty.edu/aat/300387092']);
  assert.equal(kindFit(back.places[A('ashby')], candidateTypes(back.candidates[0])).fit, 'match', 'and the review can judge it again from the file');
});

test('a placeholder record is left out of the candidates and counted, said in the summary and on the place; a real place titled Unknown is kept', async () => {
  const g = await gathered([placeOf('lanach', 'Barony Lanach', -3.5, 55.6), placeOf('halton', 'Halton Holegate', 0.13, 53.17), placeOf('none', 'Nowhere', 0, 51)]);
  const table = {
    'Barony Lanach': [cand('place:gn:9', 'Oknoname 037068 Dam', [-97, 35], gn('DAM', 'S'), { alt_names: ['Oknoname Dam'] }), cand('place:gn:10', 'Lanach', [-3.51, 55.61], gn('PPL', 'P'), { match: false, score: 80 })],
    'Halton Holegate': [cand('place:kain_par:11771', 'Unknown', [0.131, 53.171], [{ identifier: 'parish', label: 'kain_par' }], { alt_names: ['Halton Holegate'] })],
    Nowhere: [cand('place:osm:1', 'Unnamed', [0, 51], [{ identifier: 'water', label: 'osm' }]), cand('place:osm:2', '?', [0, 51.001], [])],
  };
  const fake = fakeWhg((q) => ({ result: table[q.query] ?? [] }));
  const { work, record } = await runLookup({ lookup: lookupWith(fake), subjects: g.subjects, places: g.places, options: { places: 'all' }, now: clock() });
  const ids = work.candidates.map((c) => c.gazetteer.id);
  assert.deepEqual(ids.sort(), ['place:gn:10', 'place:kain_par:11771'], 'Oknoname, Unnamed and ? left out; Lanach and the Unknown known as Halton Holegate kept');
  assert.equal(record.counts.skipped.placeholder, 3);
  assert.deepEqual([record.queries[A('lanach')].placeholders, record.queries[A('halton')].placeholders, record.queries[A('none')].placeholders], [1, undefined, 2]);
  assert.match(LOOKUP_WORDS.summary(record.counts, 'WHG').counted, /Not suggested: 3 records whose only name is a placeholder \(such as "Oknoname 037068 Dam"\)\./);
  assert.equal(lookupPage.state('WHG', record.queries[A('none')]), 'WHG: No candidates (label only). 2 records whose only name is a placeholder (such as "Oknoname 037068 Dam") were left out.');
  assert.equal(lookupPage.state('WHG', record.queries[A('halton')]), 'WHG: No candidates (label only).'.replace('No candidates (label only).', LOOKUP_WORDS.notFound(record.queries[A('halton')])), 'control: no placeholder, nothing said of one');
});

test('isPlaceholder takes WHG\'s exclude list whole and in any case, never its demote list nor a real name that begins like one', () => {
  for (const n of ['Oknoname 037068 Dam', 'OKNONAME DAM', 'Unnamed', 'unnamed shipwreck', 'Unknown', '?', '...', 'X', 'xx', 'FIXME', 'Sin nombre', '名称不明', 'без названия', 'Unamed', 'unkown']) assert.ok(isPlaceholder(n), n);
  for (const n of ['No Name', 'Nil', 'Na', 'Q1', '286', 'Unknown Pond', 'No Name Creek', 'Nimetönlampi', 'Xanten', 'Desconocida Reef', '', '   ']) assert.ok(!isPlaceholder(n), n);
  assert.ok(placeholderRecord({ name: 'Oknoname Dam', altNames: ['Oknoname 02702 Dam', ''] }));
  assert.ok(!placeholderRecord({ name: 'Unknown', altNames: ['Halton Holegate'] }), 'a real name beside it keeps it');
  assert.equal(PLACEHOLDER_PATTERNS.length, 20);
});

test('the bulk accept never takes a candidate of a conflicting kind: the place is left to the reviewer, and the result says why; the same candidate for a place of no stated kind is taken', async () => {
  const run = async (type) => {
    const g = await gathered([placeOf('windermere', 'Windermere', -2.905, 54.38, type), placeOf('kendal', 'Kendal', -2.745, 54.33, TOWN)]);
    const fake = fakeWhg((q) => ({ result: q.query === 'Windermere' ? [cand('place:gn:1', 'Windermere', [-2.94, 54.35], gn('LK', 'H'))] : [cand('place:gn:2', 'Kendal', [-2.746, 54.33], gn('PPL', 'P'))] }));
    const { work } = await runLookup({ lookup: lookupWith(fake), subjects: g.subjects, places: g.places, options: { places: 'all' }, now: clock() });
    return work;
  };
  const town = await run(TOWN);
  const plan = planGuarded(town);
  assert.deepEqual(plan.accept.map((c) => c.gazetteer.id), ['place:gn:2'], 'Kendal, a town for a town');
  assert.deepEqual(plan.leftOut, { far: 0, ccodes: 0, kind: 1, total: 1, examples: [{ id: town.candidates.find((c) => c.gazetteer.id === 'place:gn:1').id, why: 'kind' }] });
  const r = acceptGuarded(town, { at: NOW });
  assert.equal(r.accepted, 1);
  assert.equal(town.candidates.find((c) => c.gazetteer.id === 'place:gn:1').decision, null, 'the lake is left for the reviewer');
  assert.equal(guardWords.leftOut(r.leftOut), "1 left out: 1 of another kind of place than the place's own (a lake for a town, say). Decide on them yourself.");
  // The control: Windermere with no kind of its own: the lake passes the guard and is taken.
  const plain = await run(null);
  assert.equal(acceptGuarded(plain, { at: NOW }).accepted, 2);
  assert.ok(plain.candidates.every((c) => c.decision?.kind === 'match'));
});

test('the review\'s words: the kind line, "type unknown", and why a candidate was ranked up or down', () => {
  assert.equal(lookupPage.kindUnknown, 'type unknown');
  assert.equal(lookupPage.kindMatch('kain_par:parish', 'parish'), 'kain_par:parish is the kind of place yours is (parish), or a narrower kind: it comes first among records of one place (within 2 km of each other).');
  assert.equal(lookupPage.kindConflict('lakes (bodies of water)', 'town'), 'Ranked down: lakes (bodies of water), where yours is town; after the other candidates as near. Never accepted in bulk; decide on it yourself.');
});

// ---- WHG's daily cap (#22; whg.js A15), in WHG's own shapes (live since 12 October 2026) --------------------
test('a lookup that meets WHG\'s daily cap stops in plain words with when it resets, in the reader\'s time, keeps what was answered, and is not a refused token', async () => {
  const g = await gathered(Array.from({ length: 30 }, (_, i) => placeOf(`p${i}`, `Place ${i}`, -2, 52 + i / 100)));
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  for (const [answer, resetsAt, kind] of [
    [() => json(429, { code: 'daily_limit_exceeded', detail: 'Daily API limit (5000 calls) exceeded', limit: 5000, resets_at: '2026-10-13T00:00:00Z' }, { 'Retry-After': '41234' }), '2026-10-13T00:00:00.000Z', 'quota'],
    [() => json(403, { detail: 'Daily API limit (5000 calls) exceeded' }), null, 'quota'],
    [() => json(401, { detail: 'Invalid API token' }, { 'WWW-Authenticate': 'Bearer' }), undefined, 'auth'],
  ]) {
    const fake = fakeWhg((q, n) => (n === 2 ? answer() : { result: [] }));
    const { record, stopped } = await runLookup({ lookup: lookupWith(fake), subjects: g.subjects, places: g.places, options: { places: 'all' }, now: clock() });
    assert.equal(stopped.kind, kind);
    assert.equal(stopped.resetsAt, resetsAt);
    const states = Object.values(record.queries).map((q) => q.state);
    assert.deepEqual([states.filter((s) => s === 'answered').length, states.filter((s) => s === 'stopped').length], [25, 5], 'the first batch kept');
    const said = LOOKUP_WORDS.stopped(stopped);
    if (kind === 'quota') {
      assert.equal(said, LOOKUP_WORDS.dailyLimit(resetsAt));
      assert.equal(fake.calls.length, 2, 'not asked again');
    } else assert.match(said, /refused the token/, 'control: a refused token is still told as one');
  }
  const words = (tz) => LOOKUP_WORDS.dailyLimit('2026-10-13T00:00:00.000Z', tz);
  assert.equal(words('UTC'), "The lookup stopped: WHG's daily limit for this token is reached; it resets at 00:00 UTC on 13 October 2026. What was answered is kept, and your token is kept: resume the lookup then.");
  assert.match(words('Europe/London'), /it resets at 01:00 BST on 13 October 2026\./, "the reader's own time");
  assert.match(LOOKUP_WORDS.dailyLimit(null), /it resets tomorrow\./);
});

// ---- Scope's Sources (WHG's gateway, 12 October 2026: namespaces before the name window) ------------------
test("Scope's words: Sources narrow WHG's search itself; Where, kinds of place and years filter its best 200 or so matches by name", () => {
  const p = (parts) => SCOPE_WORDS.preview({ parts, keys: ['k'], whereYielded: 0 });
  assert.match(SCOPE_WORDS.lede, /Sources narrow WHG's search itself\. Where, kinds of place and years are filters: WHG first takes its best 200 or so matches by name/);
  assert.equal(p(['sources']), "The Scope is sent as k (its sources). Its sources narrow WHG's search itself.", 'sources alone: no word of the window');
  assert.equal(p(['where', 'what']), "The Scope is sent as k (its Where, its kinds of place). Its Where and its kinds of place are filters on WHG's best 200 or so matches by name: a narrow Scope of them can leave a place with nothing, the right answer too.");
  assert.ok(!/sources[^.]*200/.test(p(['where', 'what', 'when', 'sources'])), 'never says the sources filter the window');
});
