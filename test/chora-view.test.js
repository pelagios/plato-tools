// Chora's view of a place (src/engine/chora/view.js) and its working database (store.js): what is
// shown of each attestation, what is left out as withdrawn, and where the map looks for a place
// with no geometry of its own. Each absence asserted here has its presence beside it: a withdrawn
// geometry is shown when the retraction is not seen, a fallback is taken only when the one before
// it is missing, so that none of these checks could pass by showing nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, file, textFile, go, outText } from './engine.js';
import { detect } from '../src/engine/input.js';
import { load, fold } from '../src/engine/chora/store.js';
import { viewPlace, statusOf, tail } from '../src/engine/chora/view.js';
import { reprPointOf, unionBbox, bboxOf } from '../src/engine/chora/geo.js';

const X = 'https://example.org/', P = 'https://w3id.org/plato#';
const id = (s) => `${X}place/${s}`, att = (s) => `${X}attestation/${s}`;
const src = { '@id': X + 'source/s', title: 'A survey' };
const pt = (x, y) => ({ geojson: { type: 'Point', coordinates: [x, y] } });
const square = { geojson: { type: 'Polygon', coordinates: [[[0, 50], [2, 50], [2, 51], [0, 51], [0, 50]]] } };
/** Seven places. Ashford's first geometry is retracted by an attestation under ANOTHER place, Bexley. */
const dataset = () => ({
  profile: 'place-centric',
  gazetteer: { '@id': X + 'g', title: 'Chora test', status: 'published', version: '1' },
  spatialEntities: [
    { '@id': id('ashford'), label: 'Ashford', ccodes: ['GB'], attestations: [
      { '@id': att('a1'), geometries: [pt(1, 52)], sources: [src] },
      { '@id': att('a2'), names: [{ toponym: 'Ashford' }], geometries: [square], timespans: [{ startEarliest: '1086', endLatest: '1086' }], citations: [{ source: src, locator: 'f. 2' }], created: '2026-01-01T00:00:00Z' },
      { '@id': att('a3'), negated: true, geometries: [pt(10, 10)], sources: [src] },
      { '@id': att('a4'), types: [{ label: 'market' }], sourceStance: P + 'StanceDoubted', timespans: [{ startEarliest: '1250' }], sources: [src] },
      { '@id': att('a5'), types: [{ label: 'fair' }], sourceStance: 'plato:StanceReported', sources: [src] },
      { '@id': att('a6'), names: [{ toponym: 'Ashforde' }], sourceStance: P + 'StanceTentative', sources: [src] },
    ] },
    { '@id': id('bexley'), label: 'Bexley', attestations: [
      { '@id': att('b1'), geometries: [pt(5, 50)], sources: [src] },
      { '@id': att('b2'), meta: { targetAttestation: att('a1'), metaType: P + 'Retracts' }, sources: [src], notes: 'Ashford is not there.' },
    ] },
    { '@id': id('cray'), label: 'Cray', attestations: [{ relations: [{ relatesTo: id('bexley'), relationType: P + 'ContainedIn' }], sources: [src] }] },
    { '@id': id('dene'), label: 'Dene', ccodes: ['GB'], attestations: [{ names: [{ toponym: 'Dene' }], sources: [src] }] },
    { '@id': id('eyot'), label: 'Eyot', attestations: [{ names: [{ toponym: 'Eyot' }], sources: [src] }] },
    { '@id': id('fenny'), label: 'Fenny', ccodes: ['GB'], attestations: [{ negated: true, geometries: [pt(3, 3)], sources: [src] }] },
    { '@id': id('catal'), label: 'Çatalhöyük', ccodes: ['TR'], attestations: [{ names: [{ toponym: 'Çatalhöyük' }], sources: [src] }] },
  ],
});
const GB = [-8.65, 49.86, 1.77, 60.86];
const boxes = { GB };
const ccodeBbox = (c) => boxes[c] || null;
async function open(files, name) {
  const e = env();
  return load(await detect([].concat(files)), e, await e.openDb(), { name });
}
const json = () => textFile(JSON.stringify(dataset()), 'chora.json');

test('a geometry retracted under another place is left out and counted; seen alone, the place still shows it', async () => {
  const s = await open(json());
  assert.equal(s.loaded.places, 7);
  assert.equal(s.loaded.withdrawn, 1);
  const v = s.getPlace(id('ashford'));
  assert.deepEqual(v.geometries.map((g) => g.attestationId), [att('a2'), att('a3')]);
  assert.equal(v.withdrawn, 1);
  // The control: the record alone does not hold the retraction, so the geometry is shown.
  const alone = viewPlace(s.record(id('ashford')));
  assert.deepEqual(alone.geometries.map((g) => g.attestationId), [att('a1'), att('a2'), att('a3')]);
  assert.equal(alone.withdrawn, 0);
  // Nor is the retracted point part of the place on the map: its box and point are the square's.
  assert.deepEqual(s.brief(id('ashford')), { id: id('ashford'), label: 'Ashford', reprPoint: [1, 50.5], bbox: [0, 50, 2, 51] });
  assert.equal(s.getPlace(id('bexley')).withdrawn, 0);
});

test('denied, doubted, reported and tentative attestations are shown, each with its status', async () => {
  const s = await open(json());
  const v = s.getPlace(id('ashford'));
  assert.deepEqual(v.geometries.map((g) => g.status), ['asserted', 'denied']);
  assert.deepEqual(v.types.map((t) => [t.label, t.status]), [['market', 'doubted'], ['fair', 'reported']]);
  assert.deepEqual(v.names.map((n) => [n.toponym, n.status]), [['Ashford', 'asserted'], ['Ashforde', 'tentative']]);
  assert.deepEqual(v.timeline.map((t) => [t.facet, t.text, t.start, t.end, t.status]), [['name', 'Ashford', '1086', '1086', 'asserted'], ['type', 'market', '1250', null, 'doubted']]);
  assert.deepEqual(v.geometries[0].sources, [{ id: src['@id'], title: 'A survey', locator: 'f. 2' }]);
  assert.equal(v.geometries[0].created, '2026-01-01T00:00:00Z');
  assert.deepEqual(v.sources, [{ id: src['@id'], title: 'A survey' }]);
  // A denial outranks a stance, and a malformed flag errs towards denial.
  assert.equal(statusOf({ negated: true, sourceStance: P + 'StanceReported' }), 'denied');
  assert.equal(statusOf({ negated: 'yes' }), 'denied');
  assert.equal(statusOf({ sourceStance: P + 'StanceAsserted' }), 'asserted');
});

test('where the map looks: own geometry, else related places, else countries, else nowhere', async () => {
  const s = await open(json());
  const fb = (p, ctx = { ccodeBbox }) => s.getPlace(id(p), ctx).fallback;
  assert.deepEqual(fb('ashford'), { kind: 'geometry', bbox: [0, 50, 2, 51] }, 'the denied point at (10, 10) is not where Ashford is');
  const cray = s.getPlace(id('cray'), { ccodeBbox });
  assert.deepEqual(cray.fallback, { kind: 'related', bbox: [5, 50, 5, 50] });
  assert.deepEqual(cray.relations.map((r) => [r.typeLabel, r.label, r.related && r.related.geometry]), [['ContainedIn', 'Bexley', [5, 50]]]);
  assert.deepEqual(fb('dene'), { kind: 'ccodes', bbox: GB });
  assert.deepEqual(fb('dene', {}), { kind: 'none', bbox: null }, 'no country boxes given, none used');
  assert.deepEqual(fb('fenny'), { kind: 'ccodes', bbox: GB }, 'a denied geometry does not place it');
  assert.deepEqual(fb('eyot'), { kind: 'none', bbox: null });
  assert.equal(s.getPlace(id('nowhere')), null);
});

test('search ignores case and accents and keeps dataset order; the overview holds each current point, capped', async () => {
  const s = await open(json());
  assert.equal(fold('İstanbul'), 'istanbul');
  assert.deepEqual(s.search('catalhoyuk').items.map((i) => i.label), ['Çatalhöyük']);
  assert.deepEqual(s.search('ÇATALHÖYÜK').items.map((i) => i.label), ['Çatalhöyük'], 'the query is folded as the labels are');
  assert.deepEqual(s.search('ASH').items, [{ id: id('ashford'), label: 'Ashford', ccodes: ['GB'], hasGeometry: true }]);
  const all = s.search('');
  assert.equal(all.total, 7);
  assert.deepEqual(all.items.map((i) => i.label), ['Ashford', 'Bexley', 'Cray', 'Dene', 'Eyot', 'Fenny', 'Çatalhöyük']);
  assert.deepEqual(s.search('', { after: s.search('', { limit: 2 }).next, limit: 2 }).items.map((i) => i.label), ['Cray', 'Dene']);
  assert.equal(s.search('%').total, 0, 'a wildcard is searched for as itself');
  const o = s.overview();
  assert.deepEqual(o.features.map((f) => f.properties.label), ['Ashford', 'Bexley'], 'Fenny has only a denied geometry');
  assert.equal(o.capped, undefined);
  const c = s.overview(1);
  assert.equal(c.features.length, 1);
  assert.equal(c.capped, true);
  assert.equal(s.loaded.withGeometry, 2);
  assert.deepEqual(s.loaded.bbox, [0, 50, 5, 51]);
  assert.deepEqual(s.loaded.header, { '@id': X + 'g', title: 'Chora test', status: 'published', version: '1' });
});

test('every input format reaches the store as places: the same dataset as N-Triples and as JSON Lines', async () => {
  for (const target of ['ntriples', 'plato-jsonl']) {
    const r = await go([json()], 'convert', target);
    const name = r.outputs[0].name;
    const s = await open(textFile(outText(r.e, name), name));
    assert.equal(s.loaded.places, 7, target);
    const v = s.getPlace(id('ashford'));
    assert.equal(v.withdrawn, 1, target);
    assert.deepEqual(v.geometries.map((g) => g.status).sort(), ['asserted', 'denied'], target);
  }
  const t = await open(['about', 'places', 'sources', 'names', 'locations', 'types', 'relations', 'connections', 'properties', 'identities'].map((n) => file(`test/fixtures/tables-routes/${n}.csv`)), 'tables-routes');
  assert.equal(t.loaded.input.format, 'tables');
  assert.equal(t.loaded.input.name, 'tables-routes');
  assert.ok(t.loaded.places > 3, `${t.loaded.places} places`);
  assert.ok(t.search('cambridge').total >= 1);
});

test("PLATO's judgements example: the bad import is retracted, the market denied, reported and doubted", async () => {
  const s = await open(file('test/fixtures/chora/place-centric-judgements.json'));
  const lw = s.getPlace('https://whgazetteer.org/example/entity/littleworth');
  assert.equal(lw.withdrawn, 1);
  assert.equal(lw.geometries.length, 0);
  assert.deepEqual(lw.types.map((t) => t.status), ['denied']);
  const kb = s.getPlace('https://whgazetteer.org/example/entity/kingsbury');
  assert.deepEqual(kb.types.map((t) => t.status), ['reported', 'doubted']);
});

test('representative points and boxes', () => {
  assert.deepEqual(reprPointOf({ type: 'LineString', coordinates: [[0, 0], [2, 0], [2, 2]] }), [2, 0]);
  assert.deepEqual(reprPointOf({ type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] }), [7 / 3, 7 / 3]);
  assert.deepEqual(reprPointOf({ type: 'MultiPoint', coordinates: [[0, 0], [2, 4]] }), [1, 2]);
  // A country across the antimeridian (west > east) joined with its neighbour stays across it.
  assert.deepEqual(unionBbox([[170, -20, -170, -10], [-175, -25, -172, -22]]), [170, -25, -170, -10]);
  assert.deepEqual(unionBbox([[0, 0, 1, 1], [2, 2, 3, 3]]), [0, 0, 3, 3]);
});

// ---- The review of 30 September 2026: each test below failed before its fix. ----------------------
test("a place without an @id is shown under the key its drawings are kept by", async () => {
  const s = await open(textFile(JSON.stringify({ ...dataset(), spatialEntities: [...dataset().spatialEntities, { label: 'Unnamed', attestations: [{ names: [{ toponym: 'Unnamed' }], sources: [src] }] }] }), 'unnamed.json'));
  const key = s.search('unnamed').items[0].id;
  assert.equal(key, '#8');
  assert.equal(s.getPlace(key).id, key);
  assert.equal(s.getPlace(id('ashford')).id, id('ashford'), 'and a place with one, under its @id');
});

test('an address with a stray % is shown as it is written, and its place still opens', async () => {
  assert.equal(tail('https://example.org/rel/near%'), 'near%');
  assert.equal(tail('https://example.org/p/100%zz'), '100%zz');
  assert.equal(tail('https://example.org/p/St%20Ives'), 'St Ives', 'an encoded address is still decoded');
  const v = viewPlace({ label: 'x', attestations: [{ relations: [{ relatesTo: 'https://example.org/p/50%', relationType: 'https://example.org/rel/near%' }], types: [{ identifier: 'https://example.org/t/%E2' }] }] });
  assert.deepEqual(v.relations.map((r) => [r.typeLabel, r.label]), [['near%', '50%']]);
  assert.deepEqual(v.types.map((t) => t.label), ['%E2']);
});

test('a geometry across the antimeridian: its box goes the short way round, and its point is on it', async () => {
  const line = { type: 'LineString', coordinates: [[179, -17], [-179, -16]] };
  const square = { type: 'Polygon', coordinates: [[[178, -18], [-178, -18], [-178, -16], [178, -16], [178, -18]]] };
  assert.deepEqual(bboxOf(line), [179, -17, -179, -16]);
  assert.deepEqual(bboxOf(square), [178, -18, -178, -16]);
  const near180 = (p) => Math.abs(Math.abs(p[0]) - 180) < 1e-9 && p[0] >= -180 && p[0] <= 180;
  const [lp, sp] = [reprPointOf(line), reprPointOf(square)];
  assert.ok(near180(lp) && Math.abs(lp[1] + 16.5) < 1e-9, `the line's middle: ${lp}`);
  assert.ok(near180(sp) && Math.abs(sp[1] + 17) < 1e-9, `the square's centroid: ${sp}`);
  // The controls: a geometry that does not cross is as it was.
  assert.deepEqual(bboxOf({ type: 'LineString', coordinates: [[-10, 0], [10, 1]] }), [-10, 0, 10, 1]);
  assert.deepEqual(reprPointOf({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] }), [1, 1]);
  // In the store: a place of one such square, and one of two points either side of the line.
  const s = await open(textFile(JSON.stringify({ ...dataset(), spatialEntities: [
    { '@id': id('fiji'), label: 'Fiji', attestations: [{ geometries: [{ geojson: square }], sources: [src] }] },
    { '@id': id('taveuni'), label: 'Taveuni', attestations: [{ geometries: [pt(179.5, -16.8)], sources: [src] }, { geometries: [pt(-179.8, -16.9)], sources: [src] }] },
    { '@id': id('bexley'), label: 'Bexley', attestations: [{ geometries: [pt(5, 50)], sources: [src] }] },
  ] }), 'fiji.json'));
  const f = s.brief(id('fiji'));
  assert.deepEqual(f.bbox, [178, -18, -178, -16]);
  assert.ok(near180(f.reprPoint), `Fiji's point: ${f.reprPoint}`);
  assert.deepEqual(s.brief(id('taveuni')).bbox, [179.5, -16.9, -179.8, -16.8]);
  assert.deepEqual(s.brief(id('bexley')).bbox, [5, 50, 5, 50]);
  assert.deepEqual(s.getPlace(id('fiji')).fallback, { kind: 'geometry', bbox: [178, -18, -178, -16] });
});

// ---- The pre-push review of 30 September 2026: each test below failed before its fix. -------------
test("a location's uncertainty radius is shown only when it is a number: anything else, markup included, is dropped", () => {
  const km = (v) => viewPlace({ label: 'x', attestations: [{ geometries: [{ ...pt(1, 1), precisionKm: v }] }] }).geometries[0].precisionKm;
  assert.equal(km([12.5]), 12.5, 'the control: a number is kept');
  assert.equal(km([0]), 0, 'and nought is a number');
  for (const bad of [['<img src=x onerror=alert(1)>'], '<img src=x onerror=alert(1)>', ['5'], [null], [NaN], [Infinity], [{}], {}, 7]) {
    assert.equal(km(bad), null, `dropped: ${JSON.stringify(bad)}`);
  }
  assert.equal(km(undefined), null);
});

test("a location's precision and role are kept only as text: anything else, which the schema refuses, is dropped rather than breaking the card", () => {
  const g = (extra) => viewPlace({ label: 'x', attestations: [{ geometries: [{ ...pt(1, 1), ...extra }] }] }).geometries[0];
  for (const bad of [[5], [{}], [['exact']], [null], 'exact']) assert.equal(g({ spatialPrecision: bad }).precision, null, JSON.stringify(bad));
  for (const bad of [5, {}, ['x']]) assert.equal(g({ role: bad }).role, null, JSON.stringify(bad));
  // The controls: what the schema allows is kept.
  assert.equal(g({ spatialPrecision: ['historical_approximate'] }).precision, 'historical_approximate');
  assert.equal(g({ role: P + 'Extent' }).role, P + 'Extent');
});

// ---- PLATO's rulings of 1 October 2026 on testing against Trismegistos (#18, #20). Each test below
// failed before Chora followed them. ---------------------------------------------------------------
test('#18: a relation naming its target only (relatedLabel, no relatesTo) is shown by name, linked to nothing, and places nothing', async () => {
  const delta = { relationType: P + 'ContainedIn', relatedLabel: 'the Delta', relationLabel: 'in the Delta' };
  const v = viewPlace({ '@id': id('agathos'), label: 'Agathos Daimon', ccodes: ['EG'], attestations: [
    { relations: [delta], sources: [src] },
    { relations: [{ relationType: P + 'ContainedIn', relatesTo: id('bexley') }], sources: [src] },
  ] }, { lookup: (x) => (x === id('bexley') ? { id: x, label: 'Bexley', reprPoint: [5, 50], bbox: [5, 50, 5, 50] } : null), ccodeBbox: () => GB });
  assert.deepEqual(v.relations.map((r) => [r.typeLabel, r.label, r.relatesTo, r.related && r.related.id, r.status]),
    [['ContainedIn', 'the Delta', null, null, 'asserted'], ['ContainedIn', 'Bexley', id('bexley'), id('bexley'), 'asserted']]);
  // The control beside it is what places it: the related place's point, not the name.
  assert.deepEqual(v.fallback, { kind: 'related', bbox: [5, 50, 5, 50] });
  // Alone, the name places nothing: the map goes on to the country.
  const alone = viewPlace({ label: 'Agathos Daimon', ccodes: ['EG'], attestations: [{ relations: [delta], sources: [src] }] }, { lookup: () => { throw new Error('a name alone is never looked up'); }, ccodeBbox: () => GB });
  assert.deepEqual(alone.relations.map((r) => [r.label, r.related]), [['the Delta', null]]);
  assert.deepEqual(alone.fallback, { kind: 'ccodes', bbox: GB });
  // A relation with neither a target nor a name is still left out, and its denial is still a denial.
  const odd = viewPlace({ label: 'x', attestations: [{ relations: [{ relationType: P + 'ContainedIn' }, { relationType: P + 'ContainedIn', relatedLabel: '' }] }, { negated: true, relations: [delta] }] });
  assert.deepEqual(odd.relations.map((r) => [r.label, r.status]), [['the Delta', 'denied']]);
});

test('#18: the store indexes only addresses as related places, and opens a place whose relation is a name alone', async () => {
  const s = await open(textFile(JSON.stringify({ ...dataset(), spatialEntities: [...dataset().spatialEntities,
    { '@id': id('agathos'), label: 'Agathos Daimon', attestations: [{ relations: [{ relationType: P + 'ContainedIn', relatedLabel: 'the Delta' }, { relationType: P + 'ContainedIn', relatesTo: id('bexley'), relatedLabel: 'Bexley' }], sources: [src] }] }] }), 'delta.json'));
  assert.equal(s.db.selectValue('SELECT rel FROM p WHERE id = ?', [id('agathos')]), JSON.stringify([id('bexley')]));
  assert.deepEqual(s.getPlace(id('agathos')).relations.map((r) => [r.label, r.related && r.related.id]), [['the Delta', null], ['Bexley', id('bexley')]]);
});

test('#20: a timespan an attestation gives as EvidenceSpan is the span of the texts, marked evidence, never a claim\'s date', () => {
  const EV = P + 'EvidenceSpan';
  const v = viewPlace({ label: 'Agathos Daimon', attestations: [
    { '@id': att('window'), timespans: [{ startEarliest: '0015', endLatest: '0540', sourceLabel: 'AD 15 - AD 540' }], timespanRole: EV, sources: [src], notes: 'The span of the texts.' },
    { names: [{ toponym: 'Agathos Daimon' }], timespans: [{ startEarliest: '0100', endLatest: '0200' }], sources: [src] },
    { names: [{ toponym: 'Agathou Daimonos' }], timespans: [{ startEarliest: '0050' }], timespanRole: P + 'WhenTrue', sources: [src] },
    // Against PLATO's advice (the window is an attestation of its own), a location with an evidence span:
    { geometries: [pt(30, 30)], timespans: [{ startEarliest: '0015', endLatest: '0540' }], timespanRole: 'plato:EvidenceSpan', sources: [src] },
    { geometries: [pt(31, 31)], timespans: [{ startEarliest: '0300', endLatest: '0400' }], sources: [src] },
  ] });
  assert.deepEqual(v.timeline.map((t) => [t.facet, t.text, t.start, t.end, t.label, t.evidence]), [
    ['evidence', '', '0015', '0540', 'AD 15 - AD 540', true],
    ['name', 'Agathos Daimon', '0100', '0200', null, false],
    ['name', 'Agathou Daimonos', '0050', null, null, false],
    ['geometry', 'Point', '0015', '0540', null, true],
    ['geometry', 'Point', '0300', '0400', null, false],
  ]);
  // A location's own date is its claim's: not the span of the texts. The control beside it keeps its own.
  assert.deepEqual(v.geometries.map((g) => g.timespan), [null, { start: '0300', end: '0400', label: null }]);
  // A role PLATO does not define is shown as the ordinary date of the claim.
  const u = viewPlace({ label: 'x', attestations: [{ timespans: [{ startEarliest: '1000' }], timespanRole: 'https://example.org/role/Other' }] });
  assert.deepEqual(u.timeline.map((t) => t.evidence), [false]);
});
