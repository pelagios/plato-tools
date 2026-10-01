// Tracing from a historical map (src/engine/chora/trace.js): which map a drawing was traced from, its
// place on that map in pixels, the guard that the georeference takes it back to where it was drawn,
// and the attestation it becomes, citing the map and the georeference as PLATO's pattern does
// (PLATO 3acab8e, schemas/examples/place-centric-georeference.json, read from the pinned PLATO).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { res } from './engine.js';
import * as georef from '../src/engine/georef/index.js';
import { DataError } from '../src/engine/input.js';
import * as trace from '../src/engine/chora/trace.js';
import { newGeometryAttestation, DrawError } from '../src/engine/chora/draw.js';
import { checkAddition } from '../src/engine/chora/save.js';
import { choraTracingNote } from '../src/engine/words.js';
import { PLATO_REPO } from './paths.js';

const fx = (f) => JSON.parse(readFileSync(f, 'utf8'));
const GRID = fx('test/fixtures/chora-iiif/annotation.json'), MANIFEST = fx('test/fixtures/chora-iiif/manifest-rumsey-shaped.json');
const grid = await georef.readGeoreference(GRID, { manifest: MANIFEST });
const gridNoManifest = await georef.readGeoreference(GRID);
const order2 = await georef.readGeoreference(fx('test/fixtures/chora-iiif/annotation-order2.json'));
const rocque = await georef.readGeoreference(fx('test/fixtures/georef/bpl-rocque-annotation.json'), { manifest: fx('test/fixtures/georef/bpl-rocque-manifest.json') });
const dominions = await georef.readGeoreference(fx('test/fixtures/georef/bpl-british-dominions-annotation.json'), { manifest: fx('test/fixtures/georef/bpl-british-dominions-manifest.json') });
/** A place given in pixels of a map, as the world has it. */
const at = async (g, x, y) => (await georef.toWorld(g, { type: 'Point', coordinates: [x, y] }, { space: 'image', precision: 12 })).geojson.coordinates;
const P = 'https://w3id.org/plato#';
const who = { name: 'Ada Surveyor' };
/** PLATO's worked example of a geometry traced from a georeferenced map, at the pinned commit. */
const GEOREF_EXAMPLE = `${PLATO_REPO}/schemas/examples/place-centric-georeference.json`;

test('pickOverlay: the map the drawing lies on; none when it lies on none; the topmost that holds it whole, else the topmost that holds part, with a warning', async () => {
  const inside = { type: 'Point', coordinates: await at(grid, 200, 200) };
  const outside = { type: 'Point', coordinates: await at(grid, 505, 505) };   // on the image, outside the mask (inset 16)
  const one = [{ key: 'grid', g: grid }];
  const p1 = await trace.pickOverlay(one, inside);
  assert.equal(p1.chosen.key, 'grid'); assert.equal(p1.chosen.partial, false);
  assert.deepEqual(p1.candidates, ['grid']);
  const p2 = await trace.pickOverlay(one, outside);
  assert.equal(p2.chosen, null); assert.deepEqual(p2.candidates, []);
  // A line from inside to outside: held in part.
  const line = { type: 'LineString', coordinates: [inside.coordinates, outside.coordinates] };
  const p3 = await trace.pickOverlay(one, line);
  assert.equal(p3.chosen.key, 'grid'); assert.equal(p3.chosen.partial, true);
  // Two maps, topmost first. The topmost holding it whole is chosen over one lower down...
  const both = [{ key: 'top', g: order2 }, { key: 'under', g: grid }];
  assert.equal((await trace.pickOverlay(both, inside)).chosen.key, 'top');
  // ...and a lower map holding it whole is chosen over a topmost holding only part of it.
  const small = { ...GRID, id: 'https://annotations.allmaps.org/maps/small', target: { ...GRID.target, selector: { type: 'SvgSelector', value: '<svg width="512" height="512"><polygon points="16,16 250,16 250,250 16,250 16,16" /></svg>' } } };
  const gSmall = await georef.readGeoreference(small);
  const across = { type: 'LineString', coordinates: [await at(grid, 100, 100), await at(grid, 400, 400)] };
  const p4 = await trace.pickOverlay([{ key: 'small', g: gSmall }, { key: 'grid', g: grid }], across);
  assert.equal(p4.chosen.key, 'grid'); assert.equal(p4.chosen.partial, false); assert.deepEqual(p4.candidates, ['small', 'grid']);
  // Only part on each: the topmost, marked partial.
  const p5 = await trace.pickOverlay([{ key: 'small', g: gSmall }, { key: 'small2', g: gSmall }], across);
  assert.equal(p5.chosen.key, 'small'); assert.equal(p5.chosen.partial, true);
  // A map that is hidden does not count (one at opacity 0 does: only "shown" is asked).
  assert.equal((await trace.pickOverlay([{ key: 'top', g: order2, visible: false }, { key: 'under', g: grid }], inside)).chosen.key, 'under');
  assert.equal((await trace.pickOverlay([{ key: 'top', g: order2, visible: true, opacity: 0 }, { key: 'under', g: grid }], inside)).chosen.key, 'top');
});

test('afterReshape: a traced drawing moved stays with its map while that map holds any of it; moved off onto another, it is traced from that one; onto none, from none', async () => {
  const part = (id, pts) => ({ ...GRID, id: `https://annotations.allmaps.org/maps/${id}`, target: { ...GRID.target, selector: { type: 'SvgSelector', value: `<svg width="512" height="512"><polygon points="${pts}" /></svg>` } } });
  const X = await georef.readGeoreference(part('x', '16,16 250,16 250,250 16,250 16,16'));
  const Y = await georef.readGeoreference(part('y', '260,260 496,260 496,496 260,496 260,260'));
  const maps = [{ key: 'X', g: X }, { key: 'Y', g: Y }];
  const pt = async (x, y) => ({ type: 'Point', coordinates: await at(grid, x, y) });
  // Still on X: X, though Y is above it in another case.
  const onX = await trace.pickOverlay(maps, await pt(100, 100));
  assert.deepEqual(onX.candidates, ['X']);
  assert.equal(trace.afterReshape(onX, 'X'), 'X');
  // Moved from X onto Y: Y is offered, and chosen.
  const onY = await trace.pickOverlay(maps, await pt(400, 400));
  assert.deepEqual(onY.candidates, ['Y'], 'the options offered are those it lies on now');
  assert.equal(trace.afterReshape(onY, 'X'), 'Y');
  // Moved onto neither: none (the drawing no longer cites X).
  const onNone = await trace.pickOverlay(maps, await pt(255, 100));
  assert.deepEqual(onNone.candidates, []);
  assert.equal(trace.afterReshape(onNone, 'X'), null);
  // Reshaped across both, X still holding part: it stays with X, though Y holds as much.
  const across = await trace.pickOverlay([{ key: 'Y', g: Y }, { key: 'X', g: X }], { type: 'LineString', coordinates: [(await pt(100, 100)).coordinates, (await pt(400, 400)).coordinates] });
  assert.deepEqual(across.candidates, ['Y', 'X']);
  assert.equal(across.chosen.key, 'Y', 'the control: left to pickOverlay, Y would be chosen');
  assert.equal(trace.afterReshape(across, 'X'), 'X');
});

test('pickOverlay: a map whose georeference cannot place the drawing (a fold) is passed over, and why is kept', async () => {
  const inside = { type: 'Point', coordinates: await at(grid, 200, 200) };
  const folding = async (g, gj, o) => { if (g === order2) throw new DataError('The position has more than one position on the map, because the transformation folds the map over there.'); return georef.toPixels(g, gj, o); };
  const p = await trace.pickOverlay([{ key: 'fold', g: order2 }, { key: 'grid', g: grid }], inside, { toPixels: folding });
  assert.equal(p.chosen.key, 'grid');
  assert.equal(p.skipped.length, 1); assert.equal(p.skipped[0].key, 'fold'); assert.match(p.skipped[0].reason, /folds/);
  // Any other error is not passed over.
  const broken = async () => { throw new TypeError('a bug'); };
  await assert.rejects(trace.pickOverlay([{ key: 'grid', g: grid }], inside, { toPixels: broken }), TypeError);
});

test('the region traced is its box of image pixels, at least 1 pixel each way; a point gets context around it, a line or area none', async () => {
  const pt = await trace.traceFor(grid, { type: 'Point', coordinates: await at(grid, 200.25, 300.75) }, { key: 'grid' });
  assert.equal(pt.region.length, 4);
  assert.ok(Math.abs(pt.region[0] - 199.75) < 1e-6 && Math.abs(pt.region[1] - 300.25) < 1e-6, JSON.stringify(pt.region));
  assert.deepEqual(pt.region.slice(2), [1, 1]);
  assert.equal(pt.pad, trace.POINT_CONTEXT_PX);
  assert.equal(pt.record.space, 'image');
  const flat = await trace.traceFor(grid, { type: 'LineString', coordinates: [await at(grid, 100, 250), await at(grid, 300, 250)] }, { key: 'grid' });
  assert.ok(Math.abs(flat.region[2] - 200) < 1e-6, JSON.stringify(flat.region));
  assert.equal(flat.region[3], 1, 'a level line is 1 pixel high, not 0');
  assert.equal(flat.pad, 0);
});

test('a traced point is cited with its context: a box at least twice POINT_CONTEXT_PX of the canvas each way, in canvas units however the canvas is scaled, and kept on the canvas; a line or area gets none', async () => {
  const C = trace.POINT_CONTEXT_PX;
  const box = (locator) => { const m = /#xywh=(\d+),(\d+),(\d+),(\d+)$/.exec(locator); assert.ok(m, locator); return m.slice(1).map(Number); };
  // A canvas half the image's size, and one twice it: the context is in CANVAS pixels either way.
  const scaled = (k) => { const m = structuredClone(MANIFEST); const c = m.sequences[0].canvases[0]; c.width = 512 * k; c.height = 512 * k; return m; };
  for (const [name, g, k] of [['canvas = image', grid, 1], ['canvas half the image', await georef.readGeoreference(GRID, { manifest: scaled(0.5) }), 0.5], ['canvas twice the image', await georef.readGeoreference(GRID, { manifest: scaled(2) }), 2]]) {
    const t = await trace.traceFor(g, { type: 'Point', coordinates: await at(g, 256, 256) }, { key: 'grid' });
    const [x, y, w, h] = box(trace.tracedParts(t, { zoom: 12 }).citations[0].locator);
    assert.ok(w >= 2 * C && h >= 2 * C, `${name}: ${[x, y, w, h]} is not ${2 * C} canvas px each way`);
    // ...and not much more: the point, its context, and georef's rounding outwards to whole pixels.
    assert.ok(w <= 2 * C + 8 && h <= 2 * C + 8, `${name}: ${[x, y, w, h]}`);
    const mid = 256 * k;
    assert.ok(x <= mid - C && x + w >= mid + C && y <= mid - C && y + h >= mid + C, `${name}: ${[x, y, w, h]} is not centred on ${mid}`);
  }
  // Near the corner of the image: the context is kept on the canvas, not cut off the citation.
  const corner = await trace.traceFor(grid, { type: 'Point', coordinates: await at(grid, 20, 20) }, { key: 'grid' });
  const [cx, cy, cw, ch] = box(trace.tracedParts(corner, { zoom: 12 }).citations[0].locator);
  assert.ok(cx === 0 && cy === 0 && cw >= 20 + C && ch >= 20 + C && cw < 2 * C + 20, String([cx, cy, cw, ch]));
  // A line or area: its own box, not the point's context (georef pads nothing unless asked).
  const flat = await trace.traceFor(grid, { type: 'LineString', coordinates: [await at(grid, 100, 250), await at(grid, 300, 250)] }, { key: 'grid' });
  const [, , lw, lh] = box(trace.tracedParts(flat, { zoom: 12 }).citations[0].locator);
  assert.ok(lw >= 200 && lw <= 202, `line width ${lw}`);
  assert.ok(lh < 2 * C, `line height ${lh}: given a point's context`);
});

test('the round-trip guard: a drawing comes back through the georeference to where it was drawn, to a small share of a pixel, on a thin plate spline, polynomials of order 1 and 2', async () => {
  for (const [name, g, pts] of [['rocque (thin plate spline)', rocque, [[3000, 2000], [8000, 3000], [5000, 5000]]], ['british dominions (polynomial)', dominions, [[2000, 2000], [5000, 2500], [3500, 4500]]], ['order 2', order2, [[100, 100], [400, 150], [250, 420]]]]) {
    const ring = [];
    for (const [x, y] of pts) ring.push(await at(g, x, y));
    ring.push(ring[0]);
    const area = { type: 'Polygon', coordinates: [ring] };
    const { geometry } = await georef.toPixels(g, area, { space: 'image' });
    const r = await trace.roundTrip(g, area, geometry);
    assert.ok(r.ok, `${name}: ${JSON.stringify(r)}`);
    assert.ok(r.worstPx < 0.01, `${name}: ${r.worstPx} px`);
    // The control: a return that is off by a third of a pixel is caught.
    // A third of a pixel east, in degrees of longitude at that latitude (the sphere metresPerPixel measures on).
    const east = (lat) => (r.metresPerPx * 0.33) / (6371008.8 * Math.cos((lat * Math.PI) / 180)) * (180 / Math.PI);
    const shifted = async (gg, px, o) => { const w = await georef.toWorld(gg, px, o); return { ...w, geojson: { ...w.geojson, coordinates: w.geojson.coordinates.map((rr) => rr.map(([lon, lat]) => [lon + east(lat), lat])) } }; };
    const bad = await trace.roundTrip(g, area, geometry, { toWorld: shifted });
    assert.ok(!bad.ok, `${name}: the shifted return was not caught (${bad.worstPx} px)`);
    assert.ok(bad.worstPx > trace.ROUND_TRIP_PX, `${name}: ${bad.worstPx}`);
  }
});

test('a traced drawing becomes an attestation citing the map as evidence, on the canvas, and the georeference as the method, as PLATO\'s example does', async () => {
  const drawn = { type: 'Point', coordinates: await at(grid, 256, 256) };
  const t = await trace.traceFor(grid, drawn, { key: 'grid', fetchedAt: '2026-09-30T13:55:00.000Z', licence: 'https://creativecommons.org/licenses/by-nc-sa/3.0/' });
  const parts = trace.tracedParts(t, { zoom: 14.2 });
  const a = newGeometryAttestation({ geojson: drawn, ...trace.TRACED_POINT_DEFAULTS, contributor: who, created: '2026-09-30T14:00:00Z', ...parts });
  assert.equal(checkAddition(a, res.validators), null);
  // The shape of PLATO's worked example.
  const example = fx(GEOREF_EXAMPLE);
  const want = example.spatialEntities[0].attestations[0];
  // The traced point's role and precision are the example's (a representative point, approximate).
  assert.equal(a.geometries[0].role, want.geometries[0].role);
  assert.deepEqual(a.geometries[0].spatialPrecision, want.geometries[0].spatialPrecision);
  assert.deepEqual(a.citations.map((c) => Object.keys(c).sort()), want.citations.map((c) => Object.keys(c).sort()));
  assert.deepEqual(a.citations.map((c) => c.citationFunction), want.citations.map((c) => c.citationFunction));
  assert.deepEqual(Object.keys(a.citations[1].source).sort(), Object.keys(want.citations[1].source).sort());
  const [map, method] = a.citations;
  assert.equal(map.source['@id'], MANIFEST['@id']);
  assert.equal(map.source.licence, 'https://creativecommons.org/licenses/by-nc-sa/3.0/', 'the licence is linked in the citation');
  assert.equal(method.source['@id'], GRID.id);
  assert.equal(method.source.derivedFrom, MANIFEST['@id']);
  // The locator: the canvas, and a box on it that holds the point traced.
  const m = /^(.+)#xywh=(\d+),(\d+),(\d+),(\d+)$/.exec(map.locator);
  assert.ok(m, map.locator);
  assert.equal(m[1], 'https://iiif.example.org/manifests/grid/canvas/c1');
  const [x, y, w, h] = m.slice(2).map(Number);
  assert.ok(x <= 255.5 && y <= 255.5 && x + w >= 256.5 && y + h >= 256.5, map.locator);
  assert.ok(x + w <= 512 && y + h <= 512 && x >= 0 && y >= 0, 'within the canvas');
  // The notes: how it was drawn, then the georeference's fixed sentences, with when it was fetched.
  assert.ok(a.notes.startsWith(choraTracingNote({ zoom: 14.2 })), a.notes);
  assert.ok(a.notes.includes(`Georeferenced through ${GRID.id} (polynomial order 1, 4 control points), retrieved 2026-09-30T13:55:00.000Z.`), a.notes);
  assert.ok(a.notes.includes('On canvas https://iiif.example.org/manifests/grid/canvas/c1 of manifest https://iiif.example.org/manifests/grid/manifest.'), a.notes);
  assert.ok(!a.notes.includes('where the map writes the name'));
  // Not "computed": the geometry is evidence of what the map shows (PLATO 3acab8e).
  assert.ok(!('computed' in a) && !('computed' in a.geometries[0]));
});

test('a label anchor says so; a map pasted says its retrieval date is not recorded; with no manifest the region is cited on the image', async () => {
  const drawn = { type: 'Point', coordinates: await at(gridNoManifest, 100, 400) };
  const t = await trace.traceFor(gridNoManifest, drawn, { key: 'grid' });
  const parts = trace.tracedParts(t, { zoom: 12, role: 'LabelAnchor' });
  const a = newGeometryAttestation({ geojson: drawn, role: 'LabelAnchor', contributor: who, created: '2026-09-30T14:00:00Z', ...parts });
  assert.equal(checkAddition(a, res.validators), null);
  assert.equal(a.geometries[0].role, `${P}LabelAnchor`);
  // Said, wherever georef puts it among its sentences (their order is georef's, and not pinned here).
  assert.ok(a.notes.includes('The position is where the map writes the name, not necessarily where the place is.'), a.notes);
  assert.ok(a.notes.includes('retrieval date not recorded'), a.notes);
  // No canvas size: the region is on the image service, in image pixels (knowingly: amendment 8).
  assert.match(a.citations[0].locator, /^https:\/\/iiif\.example\.org\/iiif\/grid#xywh=\d+,\d+,\d+,\d+$/);
  assert.equal(a.citations[0].source['@id'], 'https://iiif.example.org/manifests/grid/manifest', 'the manifest named in the annotation is still the source');
});

test('newGeometryAttestation takes a list of citations, and refuses one that is not a citation', () => {
  const base = { geojson: { type: 'Point', coordinates: [0.1, 52.2] }, contributor: who, created: '2026-09-30T14:00:00Z' };
  const two = [{ source: 'https://example.org/map', citationFunction: 'http://purl.org/spar/cito/citesAsEvidence' }, { source: { '@id': 'https://example.org/georef', title: 'Georeference', derivedFrom: 'https://example.org/map' } }];
  const a = newGeometryAttestation({ ...base, citations: two });
  assert.deepEqual(a.citations, two);
  assert.equal(checkAddition(a, res.validators), null);
  // With the single citation too: that one first, then the list.
  assert.equal(newGeometryAttestation({ ...base, citation: { source: 'https://example.org/c' }, citations: two }).citations.length, 3);
  assert.equal(newGeometryAttestation({ ...base, citations: [] }).citations, undefined);
  for (const bad of ['a string', [null], [{}], [{ source: 42 }], [{ locator: 'p. 1' }]]) assert.throws(() => newGeometryAttestation({ ...base, citations: bad }), DrawError, JSON.stringify(bad));
  // And the save's check catches a citation the schema refuses (a source's derivedFrom that is a number).
  const wrong = { ...a, citations: [{ source: { '@id': 'https://example.org/georef', title: 'G', derivedFrom: 42 } }] };
  assert.notEqual(checkAddition(wrong, res.validators), null);
});

test('the context of a traced point is georef\'s pad, in canvas pixels: the same box as padding the region by hand, and none without it', async () => {
  const t = await trace.traceFor(grid, { type: 'Point', coordinates: await at(grid, 256, 256) }, { key: 'grid' });
  const cited = trace.tracedParts(t, { zoom: 12 }).citations[0].locator;
  // The control: georef given the same box with the pad (the decided padding), and without it.
  assert.equal(cited, georef.georefCitation(t.record, { region: t.region, pad: trace.POINT_CONTEXT_PX }).locator);
  assert.notEqual(cited, georef.georefCitation(t.record, { region: t.region }).locator);
});

test('a point traced from a historical map is, by default, a representative point whose position is approximate (a map symbol is not the feature)', () => {
  assert.deepEqual(trace.TRACED_POINT_DEFAULTS, { role: 'RepresentativePoint', precision: 'approximate' });
  const a = newGeometryAttestation({ geojson: { type: 'Point', coordinates: [0.12, 52.2] }, contributor: who, created: '2026-10-01T10:00:00Z', ...trace.TRACED_POINT_DEFAULTS });
  assert.equal(a.geometries[0].role, `${P}RepresentativePoint`);
  assert.deepEqual(a.geometries[0].spatialPrecision, ['approximate']);
  assert.equal(checkAddition(a, res.validators), null);
});

// The pinned PLATO's georeference example, checked by the save's own check against the pinned schema:
// the citations it uses (citesAsEvidence on the map, usesMethodIn and derivedFrom on the georeference).
test('PLATO\'s georeference example passes the save\'s check under the pinned schema', () => {
  const example = fx(GEOREF_EXAMPLE);
  const want = example.spatialEntities[0].attestations[0];
  assert.ok(want.citations.some((c) => c.source?.derivedFrom), 'the example has the georeference citation');
  assert.equal(checkAddition(want, res.validators), null);
  // The control: the same attestation with its georeference's derivedFrom made a number is refused.
  const bad = structuredClone(want); bad.citations.find((c) => c.source?.derivedFrom).source.derivedFrom = 42;
  assert.notEqual(checkAddition(bad, res.validators), null);
});
