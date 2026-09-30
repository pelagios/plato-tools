// A drawing made into a new attestation (src/engine/chora/draw.js), checked against the pinned PLATO
// JSON Schema by the validators the engine prepares, and a geometry PLATO refuses (a
// GeometryCollection) stopped before it can reach the dataset: at the drawing, and again at the save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, res, textFile } from './engine.js';
import { detect } from '../src/engine/input.js';
import { newGeometryAttestation, checkGeoJSON, roleIri, DrawError, wrapLongitudes } from '../src/engine/chora/draw.js';
import { save, checkAddition } from '../src/engine/chora/save.js';
import { choraDrawingNote } from '../src/engine/words.js';

const P = 'https://w3id.org/plato#';
const who = { name: 'Ada Surveyor', orcid: '0000-0002-1825-0097' };
const when = '2026-09-30T10:00:00.000Z';
const notes = choraDrawingNote({ basemap: 'Natural Earth', zoom: 9 });
// The schema's own verdict: an attestation nested under a place, as a place-centric document holds it.
const valid = (a) => { const v = res.validators['place-centric'].entity; const ok = v({ label: 'x', attestations: [a] }); return ok || v.errors; };
const GEOMETRIES = {
  Point: [1.123456789, 52.5],
  MultiPoint: [[0, 0], [2, 4]],
  LineString: [[0, 0], [2, 0], [2, 2]],
  MultiLineString: [[[0, 0], [1, 0]], [[5, 5], [5, 9]]],
  Polygon: [[[0, 50], [2, 50], [2, 51], [0, 51], [0, 50]]],
  MultiPolygon: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[3, 3], [4, 3], [4, 4], [3, 3]]]],
};

test('a drawing of each geometry type becomes one attestation the pinned schema accepts', () => {
  assert.equal(notes, 'Drawn by hand on the Natural Earth basemap at zoom 9 in PLATO tools (Chora)');
  for (const [type, coordinates] of Object.entries(GEOMETRIES)) {
    const a = newGeometryAttestation({ geojson: { type, coordinates }, role: 'Extent', precision: 'approximate', contributor: who, created: when, notes, source: 'https://example.org/source/map' });
    assert.equal(valid(a), true, `${type}: ${JSON.stringify(valid(a))}`);
    assert.equal(a['@id'], undefined, 'no address: the publisher gives one');
    assert.deepEqual(Object.keys(a), ['geometries', 'contributor', 'created', 'citations', 'notes']);
    assert.deepEqual(a.citations, [{ source: 'https://example.org/source/map' }], 'a source known by its address is cited');
    assert.equal(a.geometries.length, 1);
    const g = a.geometries[0];
    assert.equal(g.role, P + 'Extent');
    assert.deepEqual(g.spatialPrecision, ['approximate']);
    assert.equal(g.reprPoint.length, 2);
    assert.equal(g.bbox === undefined, type === 'Point');
    assert.deepEqual(a.contributor, { name: 'Ada Surveyor', orcid: 'https://orcid.org/0000-0002-1825-0097' });
  }
  const p = newGeometryAttestation({ geojson: { type: 'Point', coordinates: GEOMETRIES.Point }, contributor: who, created: new Date(when), notes });
  assert.deepEqual(p.geometries[0], { geojson: { type: 'Point', coordinates: [1.1234568, 52.5] }, reprPoint: [1.1234568, 52.5] }, 'rounded to seven places');
  assert.equal(p.created, when);
  const sourced = newGeometryAttestation({ geojson: { type: 'Point', coordinates: [0, 0] }, contributor: who, created: when, source: { title: 'Map of 1850' }, citation: { source: 'https://example.org/s', locator: 'sheet 4' } });
  assert.equal(valid(sourced), true);
  assert.deepEqual([sourced.sources, sourced.citations], [[{ title: 'Map of 1850' }], [{ source: 'https://example.org/s', locator: 'sheet 4' }]]);
  const line = newGeometryAttestation({ geojson: { type: 'LineString', coordinates: GEOMETRIES.LineString }, contributor: who, created: when });
  assert.deepEqual(line.geometries[0].reprPoint, [2, 0], 'half way along the line');
  const area = newGeometryAttestation({ geojson: { type: 'Polygon', coordinates: GEOMETRIES.Polygon }, contributor: who, created: when });
  assert.deepEqual(area.geometries[0].reprPoint, [1, 50.5], 'the centroid of the area');
  assert.deepEqual(area.geometries[0].bbox, [0, 50, 2, 51]);
});

test('the schema check can fail: it refuses a GeometryCollection, and so does the drawing', () => {
  const gc = { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [0, 0] }] };
  // The schema's own verdict, without draw.js: refused.
  assert.notEqual(valid({ geometries: [{ geojson: gc }], contributor: who, created: when }), true);
  // And a key PLATO does not define is refused too, so the check is not merely of geometry types.
  assert.notEqual(valid({ geometries: [{ geojson: { type: 'Point', coordinates: [0, 0] } }], drawnWith: 'terra-draw' }), true);
  assert.throws(() => newGeometryAttestation({ geojson: gc, contributor: who, created: when }), (e) => e instanceof DrawError && /GeometryCollection is not accepted/.test(e.message));
  assert.match(checkAddition({ geometries: [{ geojson: gc }] }, res.validators), /GeometryCollection is not accepted/);
  assert.equal(checkAddition(newGeometryAttestation({ geojson: { type: 'Point', coordinates: [0, 0] }, contributor: who, created: when }), res.validators), null);
});

test('what PLATO would not accept is refused at the drawing, in words', () => {
  const draw = (geojson, more = {}) => () => newGeometryAttestation({ geojson, contributor: who, created: when, ...more });
  assert.throws(draw({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }), /does not close/);
  assert.throws(draw({ type: 'LineString', coordinates: [[0, 0]] }), /at least 2/);
  assert.throws(draw({ type: 'Point', coordinates: [200, 0] }), /off the map/);
  assert.throws(draw({ type: 'Point', coordinates: [0, 0] }, { contributor: undefined }), /give a name/);
  assert.throws(draw({ type: 'Point', coordinates: [0, 0] }, { contributor: { name: 'A', orcid: '1234' } }), /ORCID/);
  assert.throws(draw({ type: 'Point', coordinates: [0, 0] }, { created: 'yesterday' }), /date and time/);
  assert.throws(draw({ type: 'Point', coordinates: [0, 0] }, { precision: 'roughly' }), /not a precision/);
  assert.throws(() => roleIri('Centre'), /not a geometry role/);
  assert.equal(roleIri('plato:FeaturePoint'), P + 'FeaturePoint');
  assert.equal(roleIri(P + 'Itinerary'), P + 'Itinerary');
  assert.deepEqual(checkGeoJSON({ type: 'Point', coordinates: [1, 2] }), { type: 'Point', coordinates: [1, 2] });
});

test('a GeometryCollection given to save() directly never reaches the dataset: nothing is written', async () => {
  const doc = { profile: 'place-centric', gazetteer: { title: 't' }, spatialEntities: [{ '@id': 'https://example.org/place/a', label: 'A', attestations: [{ names: [{ toponym: 'A' }] }] }] };
  const input = await detect([textFile(JSON.stringify(doc), 'a.json')]);
  const e = env();
  const bad = { geometries: [{ geojson: { type: 'GeometryCollection', geometries: [] } }], contributor: who, created: when };
  const r = await save(input, [{ placeId: 'https://example.org/place/a', attestation: bad }], e, { reopen: () => assert.fail('nothing should be read back') });
  assert.equal(r.report.errors, 1);
  assert.equal(r.report.items[0].kind, 'chora-addition-invalid');
  assert.match(r.report.items[0].examples[0], /GeometryCollection/);
  assert.deepEqual(r.outputs, []);
  assert.deepEqual(Object.keys(e.outs), [], 'no file was opened');
  assert.equal(r.mneme, null);
  // The presence beside it: the same save with a point is written.
  const good = newGeometryAttestation({ geojson: { type: 'Point', coordinates: [0, 0] }, contributor: who, created: when });
  const ok = await save(input, [{ placeId: 'https://example.org/place/a', attestation: good }], e, { reopen: (o) => new File(e.outs[o.name], o.name) });
  assert.deepEqual(ok.outputs.map((o) => o.name), ['a.chora.json']);
});

// The review of 30 September 2026: it failed before its fix.
test('a drawing on a copy of the world is brought back to it, whole; one across the antimeridian is refused, in words', () => {
  assert.deepEqual(wrapLongitudes({ type: 'Point', coordinates: [370.5, 10] }), { type: 'Point', coordinates: [10.5, 10] });
  assert.deepEqual(wrapLongitudes({ type: 'Point', coordinates: [-530, 1] }), { type: 'Point', coordinates: [-170, 1] });
  // Moved as one, by whole turns: an area drawn two copies east keeps its shape.
  assert.deepEqual(wrapLongitudes({ type: 'Polygon', coordinates: [[[540, 0], [542, 0], [542, 2], [540, 0]]] }), { type: 'Polygon', coordinates: [[[-180, 0], [-178, 0], [-178, 2], [-180, 0]]] });
  const plain = { type: 'LineString', coordinates: [[1, 2], [3, 4]] };
  assert.deepEqual(wrapLongitudes(plain), plain, 'a drawing on the world itself is as drawn');
  const across = wrapLongitudes({ type: 'LineString', coordinates: [[539, 0], [541, 1]] });
  assert.deepEqual(across.coordinates, [[-181, 0], [-179, 1]]);
  assert.throws(() => checkGeoJSON(across), (e) => e instanceof DrawError && /off the map: longitude must be between -180 and 180/.test(e.message));
  assert.doesNotThrow(() => checkGeoJSON(wrapLongitudes({ type: 'Point', coordinates: [370.5, 10] })));
});
