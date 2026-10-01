// Adopting a location from a gazetteer match (src/engine/chora/adopt.js): one act that records two
// claims, that this place IS the gazetteer record (an identity, as Krisis records one) and that it is
// located where the record says (a geometry, copied from the record). Nothing here reaches the
// network: WHG is stood in for by a fake fetch serving fixtures shaped as WHG answers (the
// assumptions in src/engine/gazetteer/whg.js): four Newcastles, the root attribution with an NC source, LPF
// Features with dated geometries, and a 451 body. The licences in the fixtures are illustrative.
//
// Every check that something is NOT there has, in the same test, a control where it is: a 451 beside a
// 200, a denied candidate beside one that is not, an unknown licence beside a known one, a place
// without an address beside one with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { env, file, res } from './engine.js';
import { detect } from '../src/engine/input.js';
import { save, checkAddition } from '../src/engine/chora/save.js';
import { createLookup, GazetteerError, WHG_ENDPOINT, normaliseWhgIri } from '../src/engine/gazetteer/index.js';
import * as adopt from '../src/engine/chora/adopt.js';

const F = 'test/fixtures/chora/adopt/';
const json = (name) => JSON.parse(readFileSync(F + name, 'utf8'));
const DATASET = F + 'dataset.json';
const P = 'https://example.org/place/';
const W3ID = 'https://w3id.org/whg/id/';
const EVIDENCE = 'http://purl.org/spar/cito/citesAsEvidence';
const PLATO = 'https://w3id.org/plato#';
// What Krisis's gazetteerSource(WHG_SERVICE) gives (branch krisis-lookup, not yet on main): WHG as a
// dataset, cited by its site. The page passes Krisis's own; the test pins the shape it must have.
const WHG = { title: 'World Historical Gazetteer', authorityType: 'dataset', '@id': 'https://whgazetteer.org/' };
const who = { name: 'Ada Surveyor', orcid: '0000-0002-1825-0097' };
const CREATED = '2026-10-01T10:00:00Z';
const FETCHED = '2026-10-01T09:58:00Z';

/** A stand-in for WHG: the reconcile fixture for a POST, an entity fixture (or a 451) for a GET. */
function whg(entities) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push(String(url));
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if ((init.method || 'GET') === 'POST') return reply(200, json('whg-newcastle-reconcile.json'));
    const id = decodeURIComponent(/\/entity\/([^/]+)\/api/.exec(String(url))[1]);
    const e = entities[id];
    return e === 451 ? reply(451, json('whg-451.json')) : e ? reply(200, json(e)) : reply(404, { detail: 'Not found' });
  };
  return { calls, look: createLookup({ endpoint: WHG_ENDPOINT, token: 'tok-fixture', fetch, shared: false, locks: null, queryRate: null, entityRate: null }) };
}
/** The four Newcastles, as createLookup gives them, by id, and the root attribution. */
async function setup() {
  const { look } = whg({});
  const lists = await look.reconcile([{ query: 'Newcastle' }]);
  return { byId: Object.fromEntries(lists[0].map((c) => [c.id, c])), attribution: lists.attribution };
}
const place = (slug, label = slug) => ({ '@id': P + slug, label });
const none = { linked: new Set(), denied: new Set(), exact: new Set() };
const args = (o) => ({ contributor: who, created: CREATED, fetched: FETCHED, source: WHG, existing: none, ...o });
const valid = (a) => checkAddition(a, res.validators);

test('adopting a point: an identity with the record and a geometry copied from it, both accepted by PLATO', async () => {
  const { byId, attribution } = await setup();
  const cand = byId['place:gn:2641673'];
  assert.equal(cand.iri, W3ID + 'place:gn:2641673');
  const r = adopt.adoptionAttestations(args({ place: place('newcastle', 'Newcastle upon Tyne'), candidate: cand, feature: json('lpf-point.json'), geometryIndex: 0, basis: 'Same city: the castle and the bridge', attribution }));
  assert.equal(r.refused, undefined);
  assert.equal(r.attestations.length, 2);
  const [identity, geometry] = r.attestations;
  for (const a of r.attestations) {
    assert.equal(valid(a), null, 'PLATO accepts it');
    assert.equal(a['@id'], undefined, 'no @id: whoever publishes gives one');
    assert.equal(a.created, CREATED);
    assert.deepEqual(a.contributor, { name: 'Ada Surveyor', orcid: 'https://orcid.org/0000-0002-1825-0097' });
    assert.ok(a.notes.includes(W3ID + 'place:gn:2641673'), 'the record IRI verbatim in both notes, to pair them');
  }
  assert.deepEqual(identity.identities, [{ subject: P + 'newcastle', object: W3ID + 'place:gn:2641673', identityType: 'exactMatch', basis: 'Same city: the castle and the bridge' }]);
  assert.deepEqual(identity.citations, [{ source: WHG }], 'the identity cites the service, with no licence (as Krisis)');
  assert.equal(identity.negated, undefined);

  const g = geometry.geometries[0];
  assert.deepEqual(g.geojson, { type: 'Point', coordinates: [-1.6139601, 54.97328] }, '[lng, lat] as the record gives them, not swapped, rounded to 7 places');
  assert.equal(g.role, PLATO + 'RepresentativePoint');
  assert.equal(g.spatialPrecision, undefined, 'no precision invented');
  assert.deepEqual(geometry.citations, [{ source: { ...WHG, licence: 'https://spdx.org/licenses/CC-BY-4.0' }, locator: W3ID + 'place:gn:2641673', citationFunction: EVIDENCE }],
    "the service is cited, the record is the locator, and the licence is the upstream source's");
  assert.equal(geometry.sources, undefined);
  assert.equal(geometry.identities, undefined);
  assert.deepEqual(geometry.timespans, [{ startEarliest: '1080', startLatest: '1080', endLatest: '2026', label: 'from the castle onwards' }], "the geometry's when, carried");
  assert.match(geometry.notes, /^Copied from World Historical Gazetteer record https:\/\/w3id\.org\/whg\/id\/place:gn:2641673 /);
  assert.match(geometry.notes, /GeoNames \(gn\)/);
  assert.match(geometry.notes, /CC-BY-4\.0/);
  assert.match(geometry.notes, /fetched 2026-10-01/);
  assert.match(geometry.notes, /rounded to 7 decimal places/);
  assert.match(geometry.notes, /separate attestation/);
  assert.match(identity.notes, /Chora/);
  assert.match(identity.notes, /separate attestation/);
});

test("a Feature's geometries are offered one by one: a GeometryCollection's members, never the collection, each with its when and default role", () => {
  const offered = adopt.featureGeometries(json('lpf-polygon.json'));
  assert.deepEqual(offered.map((o) => o.geojson.type), ['Polygon', 'Point', 'Point'], 'members offered, a nested collection flattened');
  assert.deepEqual(offered.map((o) => o.role), ['Extent', 'RepresentativePoint', 'RepresentativePoint']);
  assert.ok(offered[0].when && !offered[1].when);
  assert.ok(offered.every((o) => o.geojson.type !== 'GeometryCollection'));
  // Control: a Feature whose geometry is one Point offers that one.
  assert.deepEqual(adopt.featureGeometries(json('lpf-point.json')).map((o) => o.geojson.type), ['Point']);
  // A collection given as the geometry to adopt is refused; one of its members is not.
  assert.throws(() => adopt.geometryFrom({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [0, 0] }] }), /GeometryCollection/);
  assert.equal(adopt.geometryFrom({ type: 'Point', coordinates: [0, 0] }).geojson.type, 'Point');
});

test('adopting a polygon: Extent by default, its dates and period carried, and the role can be changed', async () => {
  const { byId, attribution } = await setup();
  const base = args({ place: place('newcastle'), candidate: byId['place:gn:2641673'], feature: json('lpf-polygon.json'), attribution });
  const r = adopt.adoptionAttestations({ ...base, geometryIndex: 0 });
  const geometry = r.attestations.at(-1);
  assert.equal(valid(geometry), null);
  assert.equal(geometry.geometries[0].role, PLATO + 'Extent');
  assert.deepEqual(geometry.geometries[0].bbox, [-1.7, 54.95, -1.55, 55.02]);
  assert.deepEqual(geometry.timespans, [
    { startEarliest: '1835', startLatest: '1840', endEarliest: '1974', endLatest: '1974' },
    { label: 'Victorian', periodoUri: 'http://n2t.net/ark:/99152/p0example' },
  ]);
  const point = adopt.adoptionAttestations({ ...base, geometryIndex: 1 }).attestations.at(-1);
  assert.equal(point.timespans, undefined, 'a geometry with no when gets no timespans');
  const asFeature = adopt.adoptionAttestations({ ...base, geometryIndex: 0, role: 'FeaturePoint' }).attestations.at(-1);
  assert.equal(asFeature.geometries[0].role, PLATO + 'FeaturePoint');
  assert.equal(adopt.adoptionAttestations({ ...base, geometryIndex: 9 }).refused.kind, 'no-geometry');
});

test("a geometry whose when PLATO cannot hold is refused with the reason; one it can is not", async () => {
  const { byId, attribution } = await setup();
  const feature = (when) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [-1.61, 54.97], when } });
  const base = args({ place: place('newcastle'), candidate: byId['place:gn:2641673'], geometryIndex: 0, attribution });
  for (const when of [{ timespans: [{ start: { in: 'about 1080' } }] }, { timespans: [{ start: { in: '1080' } }], certainty: 'uncertain' }, { duration: 'a long time' }]) {
    const r = adopt.adoptionAttestations({ ...base, feature: feature(when) });
    assert.equal(r.refused?.kind, 'when', JSON.stringify(when));
    assert.deepEqual(r.attestations, [], 'nothing copied');
    assert.ok(r.refused.reason.length > 10);
    assert.ok(adopt.featureGeometries(feature(when))[0].refused, 'the offer says so before it is chosen');
  }
  const ok = adopt.adoptionAttestations({ ...base, feature: feature({ timespans: [{ start: { in: '-0300' }, end: { earliest: '0410' } }], duration: 'P700Y' }) });
  assert.deepEqual(ok.attestations.at(-1).timespans, [{ startEarliest: '-0300', startLatest: '-0300', endEarliest: '0410', duration: 'P700Y' }]);
  assert.equal(valid(ok.attestations.at(-1)), null);
});

test('a place already linked to the record by an exactMatch gets the geometry only; linked more loosely, or not at all, both', async () => {
  const { byId, attribution } = await setup();
  const base = args({ place: place('novocastria'), candidate: byId['place:gn:2641673'], feature: json('lpf-point.json'), geometryIndex: 0, attribution });
  // As currentIdentities gives it, with the address in the form the dataset wrote it (legacy entity URL).
  const legacy = 'https://whgazetteer.org/entity/place:gn:2641673/api';
  const linked = adopt.adoptionAttestations({ ...base, existing: { linked: new Set([legacy]), denied: new Set(), exact: new Set([legacy]) } });
  assert.equal(linked.attestations.length, 1);
  assert.ok(linked.attestations[0].geometries);
  assert.ok(linked.notes.some((n) => n.kind === 'already-linked'));
  assert.match(linked.attestations[0].notes, /already/);
  // Controls: linked only by a closeMatch, and not linked.
  const loose = adopt.adoptionAttestations({ ...base, existing: { linked: new Set([normaliseWhgIri(legacy)]), denied: new Set(), exact: new Set() } });
  assert.equal(loose.attestations.length, 2);
  assert.ok(loose.notes.some((n) => n.kind === 'loosely-linked'));
  assert.equal(adopt.adoptionAttestations(base).attestations.length, 2);
});

test('a candidate the dataset says is a different place is refused, and nothing is recorded', async () => {
  const { byId, attribution } = await setup();
  const base = args({ place: place('newcastle-nsw'), candidate: byId['place:gn:2155472'], feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [151.77647, -32.92953] } }, geometryIndex: 0, attribution });
  const r = adopt.adoptionAttestations({ ...base, existing: { linked: new Set(), denied: new Set([W3ID + 'place:gn:2155472']), exact: new Set() } });
  assert.equal(r.refused.kind, 'denied');
  assert.match(r.refused.reason, /Krisis/);
  assert.deepEqual(r.attestations, []);
  // Control: a denial of another record.
  assert.equal(adopt.adoptionAttestations({ ...base, existing: { linked: new Set(), denied: new Set([W3ID + 'place:gn:2641673']), exact: new Set() } }).attestations.length, 2);
});

test('a place without an @id cannot be adopted for; one with an @id can', async () => {
  const { byId, attribution } = await setup();
  const base = args({ candidate: byId['place:gn:2641673'], feature: json('lpf-point.json'), geometryIndex: 0, attribution });
  const r = adopt.adoptionAttestations({ ...base, place: { label: 'Newcastle (which?)' } });
  assert.equal(r.refused.kind, 'no-address');
  assert.deepEqual(r.attestations, []);
  assert.equal(adopt.adoptionAttestations({ ...base, place: place('newcastle') }).attestations.length, 2);
});

test('a 451 copies nothing; a 200 beside it does', async () => {
  const { look, calls } = whg({ 'place:tgn:7011781': 451, 'place:gn:2641673': 'lpf-point.json' });
  const { byId, attribution } = await setup();
  const ok = await look.entity('place:gn:2641673');
  let err;
  await look.entity('place:tgn:7011781').catch((e) => { err = e; });
  assert.ok(err instanceof GazetteerError);
  assert.equal(err.kind, 'unavailable');
  assert.equal(calls.length, 2);
  const refused = adopt.adoptionAttestations(args({ place: place('newcastle'), candidate: byId['place:tgn:7011781'], feature: null, fetchError: err, attribution }));
  assert.equal(refused.refused.kind, 'unavailable');
  assert.deepEqual(refused.attestations, [], 'not even the repr_point, and no identity: that is for Krisis');
  assert.match(refused.refused.reason, /consulted/);
  const control = adopt.adoptionAttestations(args({ place: place('newcastle'), candidate: byId['place:gn:2641673'], feature: ok, geometryIndex: 0, attribution }));
  assert.equal(control.attestations.length, 2);
});

test('a source the attribution says is not redistributable copies nothing, even with a Feature in hand', async () => {
  const { byId, attribution } = await setup();
  const base = args({ place: place('newcastle'), candidate: byId['place:gn:2641673'], feature: json('lpf-point.json'), geometryIndex: 0 });
  const closed = structuredClone(attribution);
  closed.sources.gn.redistributable = false;
  const r = adopt.adoptionAttestations({ ...base, attribution: closed });
  assert.equal(r.refused.kind, 'unavailable');
  assert.deepEqual(r.attestations, []);
  assert.equal(adopt.adoptionAttestations({ ...base, attribution }).attestations.length, 2);
});

test("the licence on the copied geometry is the upstream source's, as an SPDX URI; unknown, it is left out; WHG's own is never used for it", async () => {
  const { byId, attribution } = await setup();
  const tgn = byId['place:tgn:7011781'];
  const feature = { type: 'Feature', geometry: { type: 'Point', coordinates: [17.1, -22.6] } };
  const base = args({ place: place('newcastle'), candidate: tgn, feature, geometryIndex: 0 });
  const nc = adopt.adoptionAttestations({ ...base, attribution });
  const cited = nc.attestations.at(-1).citations[0].source;
  assert.equal(cited.licence, 'https://spdx.org/licenses/CC-BY-NC-4.0');
  assert.ok(nc.notes.some((n) => n.kind === 'licence-restricted'), 'an NC licence gets its neutral line');
  assert.match(nc.attestations.at(-1).notes, /CC-BY-NC-4\.0/);
  assert.match(nc.attestations.at(-1).notes, /World Historical Gazetteer's own licence: CC-BY-4\.0/, "WHG's own is given in the notes, beside");
  // The source gone from the attribution: WHG's own licence is there, and still not used.
  const noSource = structuredClone(attribution);
  delete noSource.sources.tgn;
  assert.equal(noSource.whg.license.spdx_id, 'CC-BY-4.0');
  const unknown = adopt.adoptionAttestations({ ...base, attribution: noSource });
  const g = unknown.attestations.at(-1);
  assert.equal(valid(g), null);
  assert.equal(Object.hasOwn(g.citations[0].source, 'licence'), false);
  assert.ok(unknown.notes.some((n) => n.kind === 'licence-unknown'));
  assert.match(g.notes, /licence not stated/);
  assert.equal(adopt.upstreamLicence(attribution, 'gn').spdx, 'CC-BY-4.0');
  assert.equal(adopt.upstreamLicence(noSource, 'tgn'), null);
});

test("WHG's own records are adopted with a warning that their ids can change, and their dataset's licence", () => {
  const cand = { id: 'place:whg:1319:277', iri: W3ID + 'place:whg:1319:277', name: 'Newcastle', namespace: 'whg', coords: [-1.61, 54.97] };
  const attribution = { whg: { license: { spdx_id: 'CC-BY-4.0' } }, datasets: { 1319: { name: 'Tyneside survey', license: { spdx_id: 'CC0-1.0' } } } };
  const r = adopt.adoptionAttestations(args({ place: place('newcastle'), candidate: cand, feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [-1.61, 54.97] } }, geometryIndex: 0, attribution }));
  assert.ok(r.notes.some((n) => n.kind === 'unstable-id'));
  assert.equal(r.attestations.at(-1).citations[0].source.licence, 'https://spdx.org/licenses/CC0-1.0');
  const gn = adopt.adoptionAttestations(args({ place: place('newcastle'), candidate: { ...cand, id: 'place:gn:2641673', iri: W3ID + 'place:gn:2641673', namespace: 'gn' }, feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [-1.61, 54.97] } }, geometryIndex: 0, attribution }));
  assert.ok(!gn.notes.some((n) => n.kind === 'unstable-id'), 'control: an authority record has none');
});

test("with no Feature (the record could not be fetched), WHG's representative point only, labelled so; with none, nothing", async () => {
  const { byId, attribution } = await setup();
  const base = args({ place: place('newcastle'), candidate: byId['place:gn:2641673'], feature: null, attribution });
  const r = adopt.adoptionAttestations(base);
  const g = r.attestations.at(-1);
  assert.equal(valid(g), null);
  assert.deepEqual(g.geometries[0].geojson, { type: 'Point', coordinates: [-1.61396, 54.97328] });
  assert.equal(g.geometries[0].role, PLATO + 'RepresentativePoint');
  assert.match(g.notes, /representative point/);
  assert.ok(r.notes.some((n) => n.kind === 'representative-point-only'));
  const bare = adopt.adoptionAttestations({ ...base, candidate: { ...byId['place:gn:2641673'], coords: null } });
  assert.equal(bare.refused.kind, 'no-geometry');
  assert.deepEqual(bare.attestations, []);
});

test('saving one adoption: Mneme passes with exactly 2 added, or 1 for a place already linked', async () => {
  const { byId, attribution } = await setup();
  const cand = byId['place:gn:2641673'];
  const feature = json('lpf-point.json');
  const linkedAs = 'https://whgazetteer.org/entity/place:gn:2641673/api';
  for (const [slug, existing, n] of [['newcastle', none, 2], ['novocastria', { linked: new Set([linkedAs]), denied: new Set(), exact: new Set([linkedAs]) }, 1]]) {
    const r = adopt.adoptionAttestations(args({ place: place(slug), candidate: cand, feature, geometryIndex: 0, attribution, existing }));
    assert.equal(r.attestations.length, n);
    const e = env();
    const input = await detect([file(DATASET)]);
    const saved = await save(input, r.attestations.map((attestation) => ({ placeId: P + slug, attestation })), e, { reopen: (o) => new File(e.outs[o.name], o.name) });
    assert.equal(saved.report.errors, 0, JSON.stringify(saved.report.items));
    assert.equal(saved.mneme.passed, true, saved.mneme.reasons.join('; '));
    assert.equal(saved.mneme.report.counts.added, n);
    assert.equal(saved.mneme.report.counts.earlier, 3);
    const doc = JSON.parse(e.outs[saved.outputs[0].name].join(''));
    assert.deepEqual(doc.spatialEntities.find((s) => s['@id'] === P + slug).attestations.slice(1), r.attestations);
  }
});
