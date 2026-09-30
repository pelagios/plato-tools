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
import { viewPlace, statusOf } from '../src/engine/chora/view.js';
import { reprPointOf, unionBbox } from '../src/engine/chora/geo.js';

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
  assert.deepEqual(s.search('', 2, 2).items.map((i) => i.label), ['Cray', 'Dene']);
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
