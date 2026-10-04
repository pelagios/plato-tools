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
import { load } from '../src/engine/chora/store.js';
import { newGeometryAttestation } from '../src/engine/chora/draw.js';
import { createLookup, GazetteerError, WHG_ENDPOINT, normaliseWhgIri } from '../src/engine/gazetteer/index.js';
import * as adopt from '../src/engine/chora/adopt.js';
import { currentIdentities } from '../src/engine/krisis/lookup.js';
import { gazetteerSource } from '../src/engine/krisis/identity.js';
import { WHG_SERVICE, upstreamLicence } from '../src/engine/krisis/lookup.js';

const F = 'test/fixtures/chora/adopt/';
const json = (name) => JSON.parse(readFileSync(F + name, 'utf8'));
const DATASET = F + 'dataset.json';
const P = 'https://example.org/place/';
const W3ID = 'https://w3id.org/whg/id/';
const EVIDENCE = 'http://purl.org/spar/cito/citesAsEvidence';
const PLATO = 'https://w3id.org/plato#';
// What Krisis's gazetteerSource(WHG_SERVICE) gives: WHG as a dataset, cited by its site. Pinned here as a
// literal, so that a change on Krisis's side shows as a failure here rather than passing through.
const WHG = { title: 'World Historical Gazetteer', authorityType: 'dataset', '@id': 'https://whgazetteer.org/' };
const who = { name: 'Ada Surveyor', orcid: '0000-0002-1825-0097' };
const CREATED = '2026-10-01T10:00:00Z';
const FETCHED = '2026-10-01T09:58:00Z';

/**
 * A stand-in for WHG: for a POST, `post` (a fixture's name, answered 200, or { status, body }); for a GET,
 * an entity fixture (or a 451). Records each request's address and headers.
 */
function whg(entities, { post = 'whg-newcastle-reconcile.json', token = 'tok-fixture' } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: { ...(init.headers || {}) }, body: init.body ?? null });
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if ((init.method || 'GET') === 'POST') return typeof post === 'string' ? reply(200, json(post)) : reply(post.status, typeof post.body === 'function' ? post.body(init) : post.body);
    const id = decodeURIComponent(/\/entity\/([^/]+)\/api/.exec(String(url))[1]);
    const e = entities[id];
    return e === 451 ? reply(451, json('whg-451.json')) : e ? reply(200, json(e)) : reply(404, { detail: 'Not found' });
  };
  return { calls, look: createLookup({ endpoint: WHG_ENDPOINT, token, fetch, shared: false, locks: null, queryRate: null, entityRate: null, maxRetries: 0, sleep: async () => {} }) };
}
/** The four Newcastles, as createLookup gives them, by id, and the root attribution. */
async function setup() {
  const { look } = whg({});
  const lists = await look.reconcile([{ query: 'Newcastle' }]);
  return { byId: Object.fromEntries(lists[0].map((c) => [c.id, c])), attribution: lists.attribution };
}
const place = (slug, label = slug) => ({ '@id': P + slug, label });
// The dataset's identities as Krisis reads them, over the whole fixture dataset (records as JSON).
const IDS = currentIdentities(json('dataset.json').spatialEntities);
const args = (o) => ({ contributor: who, created: CREATED, fetched: FETCHED, identities: IDS.get(o.place?.['@id']) ?? null, ...o });
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
  const cand = byId['place:gn:2641673'];
  // Novocastria: the dataset links it to the record by an exactMatch, written as a legacy entity URL (Krisis's currentIdentities normalises it).
  const base = args({ place: place('novocastria'), candidate: cand, feature: json('lpf-point.json'), geometryIndex: 0, attribution });
  assert.ok(base.identities, 'the fixture dataset gives Novocastria identities');
  assert.equal(adopt.candidateStatus(cand, { identities: base.identities, attribution }).linked, 'exact');
  const linked = adopt.adoptionAttestations(base);
  assert.equal(linked.attestations.length, 1);
  assert.ok(linked.attestations[0].geometries);
  assert.ok(linked.notes.some((n) => n.kind === 'already-linked'));
  assert.match(linked.attestations[0].notes, /already/);
  // Controls: linked only by a closeMatch, and not linked at all (Newcastle, which has no identities).
  const close = currentIdentities([{ '@id': P + 'novocastria', label: 'Novocastria', attestations: [{ identities: [{ subject: P + 'novocastria', object: cand.iri, identityType: 'closeMatch' }] }] }]).get(P + 'novocastria');
  const loose = adopt.adoptionAttestations({ ...base, identities: close });
  assert.equal(loose.attestations.length, 2);
  assert.ok(loose.notes.some((n) => n.kind === 'loosely-linked'));
  assert.equal(adopt.adoptionAttestations({ ...base, place: place('newcastle'), identities: IDS.get(P + 'newcastle') ?? null }).attestations.length, 2);
});

test('a candidate the dataset says is a different place is refused, and nothing is recorded; a link wins over a denial', async () => {
  const { byId, attribution } = await setup();
  const feature = { type: 'Feature', geometry: { type: 'Point', coordinates: [151.77647, -32.92953] } };
  const base = args({ place: place('newcastle-nsw'), candidate: byId['place:gn:2155472'], feature, geometryIndex: 0, attribution });
  assert.equal(adopt.candidateStatus(byId['place:gn:2155472'], { identities: base.identities }).denied, true);
  const r = adopt.adoptionAttestations(base);
  assert.equal(r.refused.kind, 'denied');
  assert.match(r.refused.reason, /Krisis/);
  assert.deepEqual(r.attestations, []);
  // Control: the same place and another record, which it does not deny.
  assert.equal(adopt.adoptionAttestations({ ...base, candidate: byId['place:gn:2641673'] }).attestations.length, 2);
  // A denial withdrawn by a later link (both in the dataset): the link wins, as Krisis's linkState says.
  const both = currentIdentities([...json('dataset.json').spatialEntities, { '@id': P + 'other', label: 'x', attestations: [{ identities: [{ subject: P + 'newcastle-nsw', object: W3ID + 'place:gn:2155472', identityType: 'exactMatch' }] }] }]).get(P + 'newcastle-nsw');
  const won = adopt.adoptionAttestations({ ...base, identities: both });
  assert.equal(won.refused, undefined);
  assert.equal(won.attestations.length, 1, 'linked by an exactMatch: the geometry only');
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
  assert.equal(upstreamLicence(attribution, 'gn').spdx, 'CC-BY-4.0');
  assert.equal(upstreamLicence(noSource, 'tgn'), null);
});

test("WHG's own records are adopted with a warning that their ids can change, and their dataset's licence", () => {
  const cand = { id: 'place:whg:1319:277', iri: W3ID + 'place:whg:1319:277', name: 'Newcastle', namespace: 'whg', coords: [-1.61, 54.97] };
  const attribution = { whg: { license: { spdx_id: 'CC-BY-4.0' } }, datasets: { 1319: { name: 'Tyneside survey', license: { spdx_id: 'CC0-1.0' } } } };
  const r = adopt.adoptionAttestations(args({ place: place('newcastle'), candidate: cand, feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [-1.61, 54.97] } }, geometryIndex: 0, attribution }));
  assert.ok(r.notes.some((n) => n.kind === 'unstable-id'));
  // As the unstable-id line promises: the dataset's name and id are kept in the notes of both.
  for (const a of r.attestations) assert.match(a.notes, /the gazetteer's own record, from dataset "Tyneside survey" \(1319\)/, a.notes);
  assert.equal(r.attestations.at(-1).citations[0].source.licence, 'https://spdx.org/licenses/CC0-1.0');
  const gn = adopt.adoptionAttestations(args({ place: place('newcastle'), candidate: { ...cand, id: 'place:gn:2641673', iri: W3ID + 'place:gn:2641673', namespace: 'gn' }, feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [-1.61, 54.97] } }, geometryIndex: 0, attribution }));
  assert.ok(!gn.notes.some((n) => n.kind === 'unstable-id'), 'control: an authority record has none');
});

test("with no Feature (the record could not be fetched), WHG's representative point only, labelled so; with none, nothing", async () => {
  const { byId, attribution } = await setup();
  const base = args({ place: place('newcastle'), candidate: byId['place:gn:2641673'], feature: null, fetchError: { kind: 'network', status: null }, attribution });
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
  for (const [slug, n] of [['newcastle', 2], ['novocastria', 1]]) {
    const r = adopt.adoptionAttestations(args({ place: place(slug), candidate: cand, feature, geometryIndex: 0, attribution }));
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

test("WHG as cited is Krisis's gazetteerSource(WHG_SERVICE), the same as a Krisis identity's", () => {
  assert.deepEqual(gazetteerSource(WHG_SERVICE), WHG);
  assert.deepEqual(adopt.whgSource(), WHG);
});

test('a dataset that may not be redistributed copies nothing; a redistributable one beside it does (redistributable tested directly, not through licenceWarns)', async () => {
  const { look } = whg({}, { post: 'whg-datasets-reconcile.json' });
  const lists = await look.reconcile([{ query: 'Newcastle' }]);
  const [closed, open] = lists[0];
  const attribution = lists.attribution;
  const feature = { type: 'Feature', geometry: { type: 'Point', coordinates: [-1.61, 54.97] } };
  const base = args({ place: place('newcastle'), feature, geometryIndex: 0, attribution });
  const sc = adopt.candidateStatus(closed, { attribution }), so = adopt.candidateStatus(open, { attribution });
  assert.equal(sc.licence?.redistributable, false, "Krisis's upstreamLicence gives an object for a dataset not redistributable, even with no licence");
  assert.equal(sc.mayCopy, false);
  assert.equal(so.mayCopy, true);
  const r = adopt.adoptionAttestations({ ...base, candidate: closed });
  assert.equal(r.refused?.kind, 'unavailable');
  assert.deepEqual(r.attestations, []);
  const ok = adopt.adoptionAttestations({ ...base, candidate: open });
  assert.equal(ok.attestations.length, 2);
  assert.equal(ok.attestations[1].citations[0].source.licence, 'https://spdx.org/licenses/CC0-1.0');
  // A non-commercial licence warns (licenceWarns) and still may be copied, with the neutral line: warning is not refusing.
  const { byId, attribution: nca } = await setup();
  const tgn = adopt.candidateStatus(byId['place:tgn:7011781'], { attribution: nca });
  assert.equal(tgn.licenceWarns, true);
  assert.equal(tgn.mayCopy, true);
  assert.ok(adopt.licenceNotes(tgn.licence).some((n) => n.kind === 'licence-restricted'));
  assert.deepEqual(adopt.licenceNotes(adopt.candidateStatus(byId['place:gn:2641673'], { attribution: nca }).licence), [], 'control: CC-BY-4.0 gets no line');
});

test('ranking: geography puts the GB Newcastles first (WHG gave Tyne last); with no reference, the gazetteer order stands', async () => {
  const { byId } = await setup();
  const order = ['place:tgn:7011781', 'place:gn:2641591', 'place:gn:2155472', 'place:gn:2641673'];
  const cands = order.map((id) => byId[id]);
  assert.equal(cands.at(-1).id, 'place:gn:2641673', "control: Tyne is last in WHG's own order");
  // A place known only by its country (view.js fallback 'ccodes'): GB's box.
  const gbBox = [-8.65, 49.86, 1.77, 60.86];
  const box = adopt.referenceOf({ geometries: [], fallback: { kind: 'ccodes', bbox: gbBox } });
  assert.deepEqual(box, { kind: 'box', bbox: gbBox, from: 'ccodes' });
  const byBox = adopt.rankCandidates(box, cands);
  assert.deepEqual(byBox.map((r) => r.candidate.id), ['place:gn:2641591', 'place:gn:2641673', 'place:tgn:7011781', 'place:gn:2155472'], 'inside first, each group in WHG order');
  assert.deepEqual(byBox.map((r) => r.inArea), [true, true, false, false]);
  assert.ok(byBox.every((r) => r.distanceKm === null), 'no distance with only a box');
  assert.deepEqual(byBox.map((r) => r.n), [1, 2, 3, 4]);
  // Its own point: by distance, Tyne first, a few hundred metres off ([lng, lat] not swapped: swapped, it would be thousands of km).
  const pt = adopt.referenceOf({ geometries: [{ geojson: { type: 'Point', coordinates: [-1.6178, 54.9783] }, status: 'asserted' }], fallback: { kind: 'geometry' } });
  const byPoint = adopt.rankCandidates(pt, cands);
  assert.equal(byPoint[0].candidate.id, 'place:gn:2641673');
  assert.ok(byPoint[0].distanceKm < 1, String(byPoint[0].distanceKm));
  assert.ok(byPoint.every((r) => r.inArea === null));
  // A denied location is no reference; nor is the dataset's box: the gazetteer's order, unchanged.
  const none = adopt.referenceOf({ geometries: [{ geojson: { type: 'Point', coordinates: [-1.6, 55] }, status: 'denied' }], fallback: { kind: 'none', bbox: null } });
  assert.deepEqual(none, { kind: 'none' });
  assert.deepEqual(adopt.rankCandidates(none, cands).map((r) => r.candidate.id), order);
  assert.deepEqual(adopt.rankCandidates(none, cands).map((r) => r.sameSpelling), [true, true, true, false], "WHG's match: same spelling");
});

test('a candidate without coordinates comes last and says so; a repr_point with a latitude beyond 90 is no coordinate (a swapped pair is caught)', async () => {
  const swapped = { q0: { result: [
    { id: 'place:gn:1', name: 'A', score: 100, match: true, repr_point: [-32.92953, 151.77647], namespace: 'gn' },
    { id: 'place:gn:2', name: 'B', score: 90, match: true, repr_point: [151.77647, -32.92953], namespace: 'gn' }] } };
  const { look } = whg({}, { post: { status: 200, body: swapped } });
  const [list] = await look.reconcile([{ query: 'x' }]);
  assert.equal(list[0].coords, null, '|lat| > 90: refused as a coordinate');
  assert.deepEqual(list[1].coords, [151.77647, -32.92953], 'control: the same pair the right way round is kept');
  const ranked = adopt.rankCandidates({ kind: 'point', points: [[151.7, -32.9]] }, list);
  assert.deepEqual(ranked.map((r) => [r.candidate.id, r.noCoords]), [['place:gn:2', false], ['place:gn:1', true]]);
});

test('what went wrong: a quota 401 keeps the token and says tomorrow; a refused token offers it again; a per-query error or gateway.answered:false is "try again", never "nothing found"', async () => {
  const fail = async (post) => { const { look } = whg({}, { post }); try { await look.reconcile([{ query: 'Newcastle' }]); return null; } catch (e) { return e; } };
  const quota = await fail({ status: 401, body: json('whg-quota-401.json') });
  assert.equal(quota.kind, 'quota');
  assert.deepEqual(adopt.lookupProblem(quota), { kind: 'quota', text: quota && adopt.lookupProblem(quota).text, offer: 'tomorrow' });
  assert.match(adopt.lookupProblem(quota).text, /token is kept: try again tomorrow/);
  const auth = await fail({ status: 401, body: json('whg-auth-401.json') });
  assert.equal(auth.kind, 'auth');
  assert.equal(adopt.lookupProblem(auth).offer, 'token');
  for (const f of ['whg-per-query-error.json', 'whg-gateway-unanswered.json']) {
    const { look } = whg({}, { post: f });
    const lists = await look.reconcile([{ query: 'Newcastle' }]);
    assert.deepEqual([...lists[0]], [], f);
    assert.equal(adopt.lookupProblem(null, lists[0])?.kind, 'unanswered', f);
    assert.equal(adopt.lookupProblem(null, lists[0]).offer, 'retry');
  }
  // Control: an answered query with candidates is no problem.
  const { look } = whg({});
  assert.equal(adopt.lookupProblem(null, (await look.reconcile([{ query: 'Newcastle' }]))[0]), null);
  assert.equal(adopt.lookupProblem({ name: 'PermissionError', kind: 'undecided' }).offer, 'permissions');
});

test('the token is never in a draft, a note or an error, even when the service echoes it back (a planted token is found by the same search)', async () => {
  const TOKEN = 'tok-SECRET-4f2a9c';
  const found = (x) => JSON.stringify(x ?? null).includes(TOKEN) || String(x?.message ?? '').includes(TOKEN);
  assert.equal(found({ planted: `Bearer ${TOKEN}` }), true, 'control: the search finds a token where one is');
  const { look, calls } = whg({}, { token: TOKEN, post: { status: 401, body: (init) => ({ detail: `Invalid token ${String(init.headers?.Authorization || init.headers?.authorization || '').replace('Bearer ', '')}` }) } });
  let err;
  await look.reconcile([{ query: 'Newcastle' }]).catch((e) => { err = e; });
  assert.ok(calls.length >= 1);
  assert.ok(JSON.stringify(calls[0].headers).includes(TOKEN), 'control: the token WAS sent, in the Authorization header');
  assert.ok(!calls[0].url.includes(TOKEN), 'and not in the address');
  assert.equal(err?.kind, 'auth');
  assert.equal(found(err), false, 'the error does not repeat it');
  assert.equal(found(adopt.lookupProblem(err)), false);
  // A draft and its attestations, from an answer fetched with the token.
  const ok = whg({ 'place:gn:2641673': 'lpf-point.json' }, { token: TOKEN });
  const lists = await ok.look.reconcile([{ query: 'Newcastle' }]);
  const cand = lists[0].find((c) => c.id === 'place:gn:2641673');
  const feature = await ok.look.entity(cand.id);
  const d = adopt.adoptionDraft({ id: 'a1', place: place('newcastle'), candidate: cand, feature, geometryIndex: 0, attribution: lists.attribution, identities: null, created: CREATED, fetched: FETCHED });
  const atts = adopt.draftAttestations(d, who);
  assert.equal(atts.attestations.length, 2, 'control: the draft makes its two attestations');
  assert.equal(found(d), false);
  assert.equal(found(atts), false);
});

test('a kept adoption makes, at saving, the same attestations as adopting at once; it holds only the geometry chosen, and survives a JSON round trip', async () => {
  const { byId, attribution } = await setup();
  const cand = byId['place:gn:2641673'];
  const feature = json('lpf-polygon.json');
  const direct = adopt.adoptionAttestations(args({ place: place('newcastle'), candidate: cand, feature, geometryIndex: 0, attribution, basis: 'Same city', role: 'FeaturePoint' }));
  const d = JSON.parse(JSON.stringify(adopt.adoptionDraft({ id: 'a1', place: place('newcastle'), candidate: cand, feature, geometryIndex: 0, attribution, identities: IDS.get(P + 'newcastle') ?? null, basis: 'Same city', role: 'FeaturePoint', created: CREATED, fetched: FETCHED })));
  assert.equal(d.kind, 'adoption');
  assert.equal(d.feature.geometry.type, 'Polygon', 'the one geometry chosen, not the collection');
  assert.ok(d.feature.geometry.when, 'with its when');
  assert.equal(d.candidate.raw, undefined, "WHG's raw answer is not kept");
  assert.deepEqual(adopt.draftAttestations(d, who), direct);
  // An already-linked place's draft keeps its identities, and makes the geometry only.
  const dl = JSON.parse(JSON.stringify(adopt.adoptionDraft({ id: 'a2', place: place('novocastria'), candidate: cand, feature, geometryIndex: 1, attribution, identities: IDS.get(P + 'novocastria'), created: CREATED })));
  assert.equal(adopt.draftAttestations(dl, who).attestations.length, 1);
});

test('a hand-drawing for a record consulted, not copied, cites WHG with the record as locator, no licence, and says nothing was copied', async () => {
  const { byId, attribution } = await setup();
  const c = adopt.consultation(byId['place:tgn:7011781'], attribution);
  const parts = adopt.consultedParts(c, 'Drawn by hand on the Natural Earth basemap at zoom 9 in PLATO tools (Chora)');
  const a = newGeometryAttestation({ geojson: { type: 'Point', coordinates: [17.08, -22.57] }, contributor: who, created: CREATED, ...parts });
  assert.equal(valid(a), null);
  // Cited for information, not as evidence: the user never saw the record's location (Stephen, 4 October 2026).
  assert.deepEqual(a.citations, [{ source: WHG, locator: W3ID + 'place:tgn:7011781', citationFunction: 'http://purl.org/spar/cito/citesForInformation' }]);
  assert.notEqual(a.citations[0].citationFunction, EVIDENCE);
  assert.equal(Object.hasOwn(a.citations[0].source, 'licence'), false);
  assert.match(a.notes, /^Drawn by hand/);
  assert.ok(a.notes.includes(W3ID + 'place:tgn:7011781'));
  assert.match(a.notes, /nothing was copied/);
});

test("Chora's store gives each place its identities as Krisis reads the whole dataset: a relation stated under another place counts, a withdrawn one does not", async () => {
  const doc = json('dataset.json');
  // Under ANOTHER place: Newcastle said to be the same as the NSW record, then that attestation retracted; and Newcastle linked to a TGN record, standing.
  doc.spatialEntities.push({ '@id': P + 'elsewhere', label: 'Elsewhere', attestations: [
    { '@id': P + 'elsewhere#a-1', identities: [{ subject: P + 'newcastle', object: W3ID + 'place:gn:2155472', identityType: 'exactMatch' }], contributor: who, created: CREATED },
    { '@id': P + 'elsewhere#a-2', identities: [{ subject: P + 'newcastle', object: W3ID + 'place:tgn:7011781', identityType: 'closeMatch' }], contributor: who, created: CREATED },
    { '@id': P + 'elsewhere#a-3', meta: { targetAttestation: P + 'elsewhere#a-1', metaType: PLATO + 'Retracts' }, contributor: who, created: CREATED }] });
  const e = env();
  const store = await load(await detect([new File([JSON.stringify(doc)], 'ids.json')]), e, await e.openDb(), { name: 'ids.json' });
  const nc = store.getPlace(P + 'newcastle').identities;
  assert.deepEqual(nc.linked, [W3ID + 'place:tgn:7011781'], 'the standing link stated under another place counts; the retracted one does not');
  assert.deepEqual(nc.exact, []);
  assert.deepEqual(store.getPlace(P + 'novocastria').identities.exact, [W3ID + 'place:gn:2641673'], 'a legacy entity URL normalised');
  assert.deepEqual(store.getPlace(P + 'newcastle-nsw').identities.denied, [W3ID + 'place:gn:2155472']);
  assert.equal(store.getPlace('#4').identities, null, 'a place without an @id has none');
  // The same as currentIdentities over the records, for each place.
  const ref = currentIdentities(doc.spatialEntities);
  for (const k of ['newcastle', 'novocastria', 'newcastle-nsw']) assert.deepEqual(store.getPlace(P + k).identities, Object.fromEntries(Object.entries(ref.get(P + k)).map(([x, v]) => [x, [...v]])));
  store.close();
});

test('the representative point is offered only after a network or rate failure or a 5xx, never after a 403 or 404, nor from a WHG record whose licence is unknown', async () => {
  const { byId, attribution } = await setup();
  const base = args({ place: place('newcastle'), candidate: byId['place:gn:2641673'], feature: null, attribution });
  for (const e of [{ kind: 'network', status: null }, { kind: 'rate', status: 429 }, { kind: 'server', status: 503 }, { kind: 'server', status: 500 }]) {
    assert.equal(adopt.fallbackAllowed(e), true, JSON.stringify(e));
    assert.equal(adopt.adoptionAttestations({ ...base, fetchError: e }).attestations.length, 2, JSON.stringify(e));
  }
  for (const e of [{ kind: 'server', status: 404 }, { kind: 'auth', status: 403 }, null]) {
    assert.equal(adopt.fallbackAllowed(e), false, JSON.stringify(e));
    const r = adopt.adoptionAttestations({ ...base, fetchError: e });
    assert.equal(r.refused?.kind, 'no-geometry', JSON.stringify(e));
    assert.deepEqual(r.attestations, []);
  }
  // A WHG record with no dataset in its id: its licence cannot be known, so its point is not copied; the control, a licensed one, is.
  const bare = { id: 'place:whg:277', iri: W3ID + 'place:whg:277', name: 'Newcastle', namespace: 'whg', coords: [-1.61, 54.97] };
  assert.equal(adopt.candidateStatus(bare, { attribution }).licence, null);
  assert.equal(adopt.adoptionAttestations({ ...base, candidate: bare, fetchError: { kind: 'network' } }).refused?.kind, 'no-geometry');
  const licensed = { ...bare, id: 'place:whg:1319:277', iri: W3ID + 'place:whg:1319:277' };
  const dsAttr = { whg: { license: { spdx_id: 'CC-BY-4.0' } }, datasets: { 1319: { name: 'Tyneside survey', license: { spdx_id: 'CC0-1.0' } } } };
  assert.equal(adopt.adoptionAttestations({ ...base, candidate: licensed, attribution: dsAttr, fetchError: { kind: 'network' } }).attestations.length, 2);
});

test("a place whose @id IS the record's address: the location only, with a note saying so; and nothing an adoption throws escapes safeAdoption", async () => {
  const { byId, attribution } = await setup();
  const cand = byId['place:gn:2641673'];
  const r = adopt.adoptionAttestations(args({ place: { '@id': cand.iri, label: 'Newcastle upon Tyne' }, candidate: cand, feature: json('lpf-point.json'), geometryIndex: 0, attribution }));
  assert.equal(r.refused, undefined);
  assert.equal(r.attestations.length, 1);
  assert.ok(r.attestations[0].geometries);
  assert.ok(r.notes.some((n) => n.kind === 'same-address'));
  assert.equal(valid(r.attestations[0]), null);
  // Control: another place adopting the same record makes both.
  assert.equal(adopt.adoptionAttestations(args({ place: place('newcastle'), candidate: cand, feature: json('lpf-point.json'), geometryIndex: 0, attribution })).attestations.length, 2);
  // A throw (here, a contributor that is no one) becomes a refusal in words.
  const bad = args({ place: place('newcastle'), candidate: cand, feature: json('lpf-point.json'), geometryIndex: 0, attribution, contributor: { name: '' } });
  assert.throws(() => adopt.adoptionAttestations(bad));
  const safe = adopt.safeAdoption(bad);
  assert.equal(safe.refused?.kind, 'error');
  assert.ok(safe.refused.reason.length > 10);
  assert.deepEqual(safe.attestations, []);
  assert.equal(adopt.safeAdoption(args({ place: place('newcastle'), candidate: cand, feature: json('lpf-point.json'), geometryIndex: 0, attribution })).attestations.length, 2, 'control: a good one passes through');
});

test("a line's default role is Itinerary, and Itinerary and Extent are the roles offered for it", () => {
  assert.equal(adopt.defaultRole('LineString'), 'Itinerary');
  assert.equal(adopt.defaultRole('MultiLineString'), 'Itinerary');
  assert.deepEqual(adopt.rolesFor('LineString'), ['Itinerary', 'Extent']);
  assert.deepEqual(adopt.rolesFor('Point'), ['RepresentativePoint', 'FeaturePoint']);
  assert.deepEqual(adopt.rolesFor('Polygon'), ['Extent', 'RepresentativePoint', 'FeaturePoint']);
  const f = { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-1.6, 54.9], [-1.5, 55]] } };
  assert.equal(adopt.featureGeometries(f)[0].role, 'Itinerary');
  const r = adopt.adoptionAttestations(args({ place: place('newcastle'), candidate: { id: 'place:gn:1', iri: W3ID + 'place:gn:1', name: 'Road', namespace: 'gn' }, feature: f, geometryIndex: 0, attribution: { sources: { gn: { license: 'CC-BY-4.0' } } } }));
  assert.equal(r.attestations.at(-1).geometries[0].role, PLATO + 'Itinerary');
  assert.equal(valid(r.attestations.at(-1)), null);
});

test('a link to a legacy WHG cluster page is found and named, not counted as a link to the record', async () => {
  const { byId } = await setup();
  const ids = currentIdentities([{ '@id': P + 'tyne', label: 'Tyne', attestations: [{ identities: [{ subject: P + 'tyne', object: 'https://whgazetteer.org/places/123456/portal/', identityType: 'exactMatch' }] }] }]).get(P + 'tyne');
  assert.deepEqual(adopt.clusterLinks(ids), ['https://whgazetteer.org/places/123456/portal/']);
  assert.equal(adopt.candidateStatus(byId['place:gn:2641673'], { identities: ids }).linked, null, 'not counted as a link to this record');
  assert.deepEqual(adopt.clusterLinks(IDS.get(P + 'novocastria')), [], 'control: a record link is not a cluster link');
  assert.deepEqual(adopt.clusterLinks(null), []);
});

test("a place whose attestations are an object, not a list, stays in Chora's store beside one whose are a list, and the identities of the other are still read", async () => {
  const doc = json('dataset.json');
  doc.spatialEntities.push({ '@id': P + 'odd', label: 'Odd', attestations: { identities: [{ subject: P + 'odd', object: W3ID + 'place:gn:1', identityType: 'exactMatch' }] } });
  const e = env();
  const store = await load(await detect([new File([JSON.stringify(doc)], 'odd.json')]), e, await e.openDb(), { name: 'odd.json' });
  assert.ok(store.getPlace(P + 'odd'), 'the place with an object for attestations is there');
  assert.equal(store.getPlace(P + 'odd').identities, null);
  assert.deepEqual(store.getPlace(P + 'novocastria').identities.exact, [W3ID + 'place:gn:2641673'], 'control: the list-valued place keeps its identities');
  assert.equal(store.loaded.places, 5);
  store.close();
});
