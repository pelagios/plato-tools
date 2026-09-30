// The shared georeference module (src/engine/georef/). The fixtures, and where each comes from,
// are described in test/fixtures/georef/README.md. Every test that asserts a refusal or an absence
// has a control beside it, in the same setup, that succeeds or is present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { addPlatoFormats, strictFormatLogger } from '../src/lib/formats.js';
import { DataError } from '../src/engine/input.js';
import {
  readGeoreference, toWorld, toPixels, georefNote, georefCitation, matchesTarget, matchTarget, containsRegion, SOFTWARE,
  allmapsLookupUrl, LABEL_ANCHOR, TRANSFORMATION_WORDS, georefAnnotationCitation,
} from '../src/engine/georef/index.js';

const DIR = 'test/fixtures/georef/';
const fixture = (f) => JSON.parse(readFileSync(DIR + f, 'utf8'));
const clone = (x) => structuredClone(x);
const ROCQUE = fixture('bpl-rocque-annotation.json'), ROCQUE_M = fixture('bpl-rocque-manifest.json');
const DOMINIONS = fixture('bpl-british-dominions-annotation.json'), DOMINIONS_M = fixture('bpl-british-dominions-manifest.json');
const LYNN = fixture('lynn-atlas-annotationpage.json'), LYNN_M = fixture('lynn-atlas-manifest.json');
const ROCQUE_V3 = fixture('bpl-rocque-manifest-v3-constructed.json');
const LYNN_CANVAS = (id) => `https://ark.digitalcommonwealth.org/ark:/50959/dj530101x/canvas/${id}`;
const LYNN_MANIFEST = 'https://ark.digitalcommonwealth.org/ark:/50959/dj530101x/manifest';
const LOC = fixture('loc-chesapeake-annotationpage.json');
const ROCQUE_CANVAS = 'https://ark.digitalcommonwealth.org/ark:/50959/ks65px29g/canvas/8623qf00m';
const ROCQUE_MANIFEST = 'https://ark.digitalcommonwealth.org/ark:/50959/ks65px29g/manifest';
const ROCQUE_IMAGE = 'https://iiif.digitalcommonwealth.org/iiif/2/commonwealth:8623qf00m';
const ROCQUE_ID = 'https://annotations.allmaps.org/maps/56425c69f9cd4f1b';
const ROCQUE_TITLE = "A general map of North America; in which is express'd the several new roads, forts, engagements, &c. taken from actual surveys and observations made in the army employ'd there, from the year 1754, to 1761";

const rocque = () => readGeoreference(ROCQUE, { manifest: ROCQUE_M });
const pt = (c) => ({ type: 'Point', coordinates: c });
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** Is the error thrown a DataError? (A check of the class, not of the message.) */
const isDataError = (e) => e instanceof DataError;
const area2 = (r) => { let a = 0; for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return a; };
/** A polygon is closed and its outer ring counter-clockwise, its holes clockwise (RFC 7946). */
function assertClosedCcw(poly) {
  poly.forEach((ring, i) => {
    assert.deepEqual(ring[0], ring[ring.length - 1], 'ring is closed');
    assert.ok(ring.length >= 4, 'ring has at least three distinct positions');
    if (i === 0) assert.ok(area2(ring) > 0, 'outer ring is counter-clockwise');
    else assert.ok(area2(ring) < 0, 'hole is clockwise');
  });
}

// ---- The library and the record ----------------------------------------------------------------

test('SOFTWARE names the installed @allmaps/transform, which package.json pins exactly', () => {
  const installed = JSON.parse(readFileSync('node_modules/@allmaps/transform/package.json', 'utf8')).version;
  assert.equal(SOFTWARE, `@allmaps/transform@${installed}`);
  const deps = JSON.parse(readFileSync('package.json', 'utf8')).dependencies;
  assert.equal(`@allmaps/transform@${deps['@allmaps/transform']}`, SOFTWARE);
  assert.match(deps['@allmaps/annotation'], /^\d+\.\d+\.\d+(-[\w.]+)?$/, 'pinned exactly, with no range');
  // Control: the check above would catch a different version.
  assert.notEqual(SOFTWARE, '@allmaps/transform@1.0.0-beta.52');
});

// ---- Reading -----------------------------------------------------------------------------------

test('readGeoreference: a real annotation with its IIIF Presentation 2 manifest', async () => {
  const g = await rocque();
  assert.equal(g.annotationId, ROCQUE_ID);
  assert.equal(g.imageServiceId, ROCQUE_IMAGE);
  assert.equal(g.canvasId, ROCQUE_CANVAS, 'the first of two canvases, matched by its image service');
  assert.equal(g.manifestId, ROCQUE_MANIFEST);
  assert.deepEqual(g.image, { width: 11436, height: 6268 });
  assert.deepEqual(g.canvas, { width: 11436, height: 6268 });
  assert.equal(g.gcps, 22);
  assert.equal(g.transformation, 'thinPlateSpline');
  assert.equal(g.title, ROCQUE_TITLE);
  assert.equal(g.controlPoints.length, 22);
  assert.equal(g.mask.length, 4);
  // The same from JSON text.
  const t = await readGeoreference(JSON.stringify(ROCQUE), { manifest: ROCQUE_M });
  assert.deepEqual(t, g);
});

test('readGeoreference: IIIF Presentation 3 (image services as an array in body.service)', async () => {
  const g = await readGeoreference(ROCQUE, { manifest: ROCQUE_V3 });
  assert.equal(g.canvasId, ROCQUE_CANVAS, 'the first of two canvases, matched by its image service');
  assert.equal(g.manifestId, ROCQUE_MANIFEST);
  assert.deepEqual(g.canvas, { width: 11436, height: 6268 });
  assert.equal(g.title, ROCQUE_TITLE);
  await assert.rejects(readGeoreference(ROCQUE, { manifest: ROCQUE_V3, canvasId: 'https://ark.digitalcommonwealth.org/ark:/50959/ks65px29g/canvas/qr46xn78z' }), isDataError);
});

test('readGeoreference: several annotations in a page, chosen by canvas', async () => {
  const canvasId = LYNN_CANVAS('jd475s53d');
  const g = await readGeoreference(LYNN, { manifest: LYNN_M, canvasId });
  assert.equal(g.annotationId, 'https://annotations.allmaps.org/maps/051d059e8d1111fd');
  assert.equal(g.canvasId, canvasId);
  assert.equal(g.manifestId, LYNN_MANIFEST);
  assert.deepEqual(g.canvas, { width: 10769, height: 7081 });
  assert.equal(g.gcps, 23);
  // By index, the canvas is found from the image service.
  const h = await readGeoreference(LYNN, { manifest: LYNN_M, index: 2 });
  assert.equal(h.canvasId, LYNN_CANVAS('9593xq795'));
  // Three annotations on one plate: the canvas cannot choose.
  await assert.rejects(readGeoreference(LYNN, { manifest: LYNN_M, canvasId: LYNN_CANVAS('bc389b85f') }), (e) => isDataError(e) && /3 georeferences on canvas/.test(e.message));
});

test('readGeoreference: an AnnotationPage of several, none chosen, is a DataError; choosing one is the control', async () => {
  await assert.rejects(readGeoreference(LYNN), (e) => isDataError(e) && /31 georeferences/.test(e.message));
  // Both LoC annotations are on the same canvas, so the canvas cannot choose between them.
  const loc = 'https://tile.loc.gov/image-services/iiif/service:gmd:gmd384:g3842:g3842c:ct008615';
  await assert.rejects(readGeoreference(LOC, { canvasId: loc }), (e) => isDataError(e) && /2 georeferences on canvas/.test(e.message));
  const g = await readGeoreference(LOC, { index: 1 });
  assert.equal(g.annotationId, 'https://annotations.allmaps.org/maps/d1e107975cac64ec');
  // Without a manifest, the canvas and manifest ids come from the annotation's partOf, but not the size.
  assert.equal(g.canvasId, loc);
  assert.equal(g.manifestId, 'https://www.loc.gov/item/88695674/manifest.json');
  assert.equal(g.canvas, null);
  assert.equal(g.title, 'Chesapeake and Ohio Canal, Washington, D.C., Maryland, West Virginia, official map and guide');
});

test('readGeoreference: a Recogito W3C annotation is not a Georeference Annotation (DataError); the real one is the control', async () => {
  const recogito = JSON.parse(readFileSync('test/fixtures/annotations/recogito-v1-islandia-map.jsonld', 'utf8'));
  await assert.rejects(readGeoreference(recogito[0]), (e) => isDataError(e) && /not a Georeference Annotation/.test(e.message));
  await assert.rejects(readGeoreference(recogito), isDataError, 'an array is not an annotation either');
  await assert.rejects(readGeoreference('{"type": "Annotation", '), isDataError, 'JSON that is not well formed');
  // A georeferencing annotation whose body is not a set of control points.
  const broken = clone(ROCQUE); broken.body = { type: 'TextualBody', value: 'no points' };
  await assert.rejects(readGeoreference(broken), isDataError);
  assert.equal((await readGeoreference(ROCQUE)).annotationId, ROCQUE_ID);
});

test('readGeoreference: too few control points for the transformation is a DataError; enough is the control', async () => {
  const two = clone(ROCQUE); two.body.features = two.body.features.slice(0, 2);
  await assert.rejects(readGeoreference(two), (e) => isDataError(e) && /2 control points, too few for a thin plate spline/.test(e.message));
  const three = clone(ROCQUE); three.body.features = three.body.features.slice(0, 3);
  assert.equal((await readGeoreference(three)).gcps, 3);
  // Asking for more than the annotation has points for, at transform time.
  const g = await readGeoreference(LOC, { index: 0 });
  await assert.rejects(toWorld(g, pt([1500, 5000]), { space: 'image', transformation: 'polynomial2' }), (e) => isDataError(e) && /needs at least 6/.test(e.message));
  await toWorld(g, pt([1500, 5000]), { space: 'image', transformation: 'polynomial' });
});

/** ROCQUE with the given control points ([[x, y], [lon, lat]]) and transformation. */
function withGcps(gcps, type = 'polynomial') {
  const a = clone(ROCQUE);
  a.body.transformation = { type };
  a.body.features = gcps.map(([r, geo]) => ({ type: 'Feature', properties: { resourceCoords: r }, geometry: { type: 'Point', coordinates: geo } }));
  return a;
}
const SPREAD = [[[1000, 1000], [-80, 40]], [[9000, 1200], [-70, 40.5]], [[5000, 5000], [-75, 30]]];

test('control points on one line are a DataError (on the map or on the ground); spread ones are the control', async () => {
  const flat = /all on one straight line .*Nothing was changed/;
  // On the ground: the case that gave [0.2, 0.199989] with no error.
  const ground = withGcps([[[0, 0], [0, 0]], [[100, 0], [0.1, 0.1]], [[0, 100], [0.2, 0.2]]]);
  await assert.rejects(readGeoreference(ground), (e) => isDataError(e) && flat.test(e.message) && /on the ground/.test(e.message));
  // On the map.
  const map = withGcps([[[0, 0], [-80, 40]], [[100, 100], [-70, 40.5]], [[200, 200], [-75, 30]]]);
  await assert.rejects(readGeoreference(map), (e) => isDataError(e) && flat.test(e.message) && /on the map/.test(e.message));
  // Nearly on a line, at the scale of the whole world: still refused (the tolerance is relative).
  const nearly = withGcps([[[0, 0], [-80, 40]], [[5000, 5000.0001], [-70, 40.5]], [[10000, 10000], [-75, 30]]]);
  await assert.rejects(readGeoreference(nearly), isDataError);
  // A thin plate spline cannot take points on a line either; Helmert can (two points fix it).
  await assert.rejects(readGeoreference(withGcps(map.body.features.map((f) => [f.properties.resourceCoords, f.geometry.coordinates]), 'thinPlateSpline')), isDataError);
  const helmert = await readGeoreference(withGcps([[[0, 0], [-80, 40]], [[100, 100], [-79, 39]], [[200, 200], [-78, 38]]], 'helmert'));
  assert.ok((await toWorld(helmert, pt([50, 50]), { space: 'image' })).geojson.coordinates.every(Number.isFinite));
  // Control: the same annotation with its points spread out.
  const g = await readGeoreference(withGcps(SPREAD));
  assert.equal(g.gcps, 3);
  const { geojson } = await toWorld(g, pt([5000, 5000]), { space: 'image' });
  assert.ok(dist(geojson.coordinates, [-75, 30]) < 1e-6, 'a control point maps to its own place');
  // Spread points, but asked for with a transformation that needs more of them.
  await assert.rejects(toWorld(g, pt([1, 1]), { space: 'image', transformation: 'projective' }), (e) => isDataError(e) && /needs at least 4/.test(e.message));
});

test('identical control points are a DataError; the same number of distinct ones is the control', async () => {
  const same = withGcps([[[10, 10], [0, 0]], [[10, 10], [0, 0]], [[10, 10], [0, 0]]]);
  await assert.rejects(readGeoreference(same), (e) => isDataError(e) && /only 1 different place/.test(e.message) && /Nothing was changed/.test(e.message));
  // Four points of which only two differ: too few for a polynomial, which needs three.
  const two = withGcps([...SPREAD.slice(0, 2), ...SPREAD.slice(0, 2)]);
  await assert.rejects(readGeoreference(two), (e) => isDataError(e) && /only 2 different places/.test(e.message));
  // A thin plate spline cannot take a repeated point even with enough others (its matrix is singular).
  const repeated = withGcps([...SPREAD, [[3000, 2000], [-77, 38]], SPREAD[0]], 'thinPlateSpline');
  await assert.rejects(readGeoreference(repeated), (e) => isDataError(e) && /same place/.test(e.message));
  // Controls: a repeat is harmless to a least-squares polynomial; and distinct points for the spline.
  assert.equal((await readGeoreference(withGcps([...SPREAD, [[3000, 2000], [-77, 38]], SPREAD[0]]))).gcps, 5);
  const tps = await readGeoreference(withGcps([...SPREAD, [[3000, 2000], [-77, 38]]], 'thinPlateSpline'));
  assert.ok((await toWorld(tps, pt([3000, 2000]), { space: 'image' })).geojson.coordinates.every(Number.isFinite));
});

test('a control point at the pole, off the globe or not a number is a DataError; one at 85° is the control', async () => {
  const at = (geo) => withGcps([...SPREAD.slice(0, 2), [[5000, 5000], geo]]);
  await assert.rejects(readGeoreference(at([-75, 90])), (e) => isDataError(e) && /Control point 3 .* latitude 90, beyond the ±85.0511°.*Nothing was changed/.test(e.message));
  await assert.rejects(readGeoreference(at([-75, -85.06])), (e) => isDataError(e) && /latitude -85.06/.test(e.message));
  await assert.rejects(readGeoreference(at([190, 30])), (e) => isDataError(e) && /longitude 190/.test(e.message));
  const huge = at([-75, 30]); huge.body.features[2].geometry.coordinates = [-75, 1e400];
  await assert.rejects(readGeoreference(huge), isDataError);
  // Control: near the limit, but inside it.
  const g = await readGeoreference(at([-75, 85]));
  const { geojson } = await toWorld(g, pt([5000, 5000]), { space: 'image' });
  assert.ok(Math.abs(geojson.coordinates[1] - 85) < 1e-6);
});

test('toWorld refuses a position that is not a finite number; a finite one is the control', async () => {
  const g = await readGeoreference(withGcps(SPREAD));
  await assert.rejects(toWorld(g, pt([1e308, 3000]), { space: 'image' }), (e) => isDataError(e) && /gives no position in the world/.test(e.message));
  assert.ok((await toWorld(g, pt([5000, 3000]), { space: 'image' })).geojson.coordinates.every(Number.isFinite));
});

test('readGeoreference: a canvas that does not show the image, or a manifest that does not hold it, is a DataError', async () => {
  const second = 'https://ark.digitalcommonwealth.org/ark:/50959/ks65px29g/canvas/qr46xn78z';
  await assert.rejects(readGeoreference(ROCQUE, { manifest: ROCQUE_M, canvasId: second }), (e) => isDataError(e) && /does not show/.test(e.message));
  await assert.rejects(readGeoreference(ROCQUE, { manifest: DOMINIONS_M }), (e) => isDataError(e) && /No canvas of the manifest/.test(e.message));
  await assert.rejects(readGeoreference(ROCQUE, { manifest: ROCQUE_M, canvasId: 'https://example.org/nowhere' }), isDataError);
  // Control: the right canvas, named.
  assert.equal((await readGeoreference(ROCQUE, { manifest: ROCQUE_M, canvasId: ROCQUE_CANVAS })).canvasId, ROCQUE_CANVAS);
});

// ---- Control points ----------------------------------------------------------------------------

test('each control point: thin plate spline takes its pixels exactly to its place (within 1e-6°)', async () => {
  const g = await rocque();
  for (const p of g.controlPoints) {
    const { geojson } = await toWorld(g, pt(p.resource), { space: 'image' });
    assert.ok(dist(geojson.coordinates, p.geo) <= 1e-6, `${p.resource} -> ${geojson.coordinates}, not ${p.geo}`);
  }
});

test('each control point: polynomial order 1 within the stated tolerance (0.001° for a 1905 city plan; exact with 3 points)', async () => {
  // 23 control points on one plate of the 1905 Lynn atlas: least squares, so not exact.
  const g = await readGeoreference(LYNN, { index: 7 });
  assert.equal(g.transformation, 'polynomial');
  let worst = 0;
  for (const p of g.controlPoints) {
    const { geojson } = await toWorld(g, pt(p.resource), { space: 'image', precision: 9 });
    worst = Math.max(worst, dist(geojson.coordinates, p.geo));
  }
  assert.ok(worst < 0.001, `worst residual ${worst}°`);
  assert.ok(worst > 1e-6, 'and not exact, as least squares with more than three points is not');
  // With exactly three control points an affine transformation passes through each.
  const l = await readGeoreference(LOC, { index: 0 });
  for (const p of l.controlPoints) {
    const { geojson } = await toWorld(l, pt(p.resource), { space: 'image' });
    assert.ok(dist(geojson.coordinates, p.geo) <= 1e-6);
  }
});

// ---- Round trips -------------------------------------------------------------------------------

test('round trip: toWorld then toPixels returns the input (within 0.001 px), for warping and affine transformations', async () => {
  const g = await rocque();
  // A ring where none of these transformations folds the map (see the fold tests below).
  const ring = [[4000, 4000], [6000, 4000], [6000, 5000], [4000, 5000], [4000, 4000]];
  for (const transformation of ['thinPlateSpline', 'polynomial', 'polynomial2', 'projective', 'helmert']) {
    const { geojson } = await toWorld(g, { type: 'Polygon', coordinates: [ring] }, { space: 'image', transformation, precision: 12 });
    const { geometry, record } = await toPixels(g, geojson, { space: 'image', transformation });
    assert.equal(record.direction, 'toPixels');
    const back = geometry.coordinates[0];
    // toWorld may have reversed the ring to make it counter-clockwise: compare as sets of corners.
    for (const p of ring) assert.ok(back.some((q) => dist(p, q) < 0.001), `${transformation}: ${p} not returned (${JSON.stringify(back)})`);
  }
  const d = await readGeoreference(DOMINIONS, { manifest: DOMINIONS_M });
  const { geojson } = await toWorld(d, pt([3650, 2970]), { space: 'image', precision: 12 });
  const { geometry } = await toPixels(d, geojson, { space: 'image' });
  assert.ok(dist(geometry.coordinates, [3650, 2970]) < 0.001);
});

// ---- Canvas and image space --------------------------------------------------------------------

/** The Rocque manifest with its first canvas at 1/k of the image's size. */
function scaledManifest(k) {
  const m = clone(ROCQUE_M);
  const c = m.sequences[0].canvases[0];
  c.width = 11436 / k; c.height = 6268 / k;
  return m;
}
const near = (a, b, tol = 1e-6) => assert.ok(dist(a, b) <= tol, `${JSON.stringify(a)} is not ${JSON.stringify(b)}`);

test('canvas space: a canvas at half the image size gives the same place for half the coordinates; a wrong scale would be caught', async () => {
  const g = await rocque();
  const half = await readGeoreference(ROCQUE, { manifest: scaledManifest(2) });
  assert.deepEqual(half.canvas, { width: 5718, height: 3134 });
  const want = (await toWorld(g, pt([5000, 4000]), { space: 'image' })).geojson.coordinates;
  const got = (await toWorld(half, pt([2500, 2000]), { space: 'canvas' })).geojson.coordinates;
  near(got, want);
  // Control: the same half coordinates on a canvas at a third of the size land somewhere else, and
  // the assertion used above catches it.
  const third = await readGeoreference(ROCQUE, { manifest: scaledManifest(3) });
  const wrong = (await toWorld(third, pt([2500, 2000]), { space: 'canvas' })).geojson.coordinates;
  assert.throws(() => near(wrong, want));
  // And if the scale were ignored (canvas read as image pixels), that too would be caught.
  const unscaled = (await toWorld(half, pt([2500, 2000]), { space: 'image' })).geojson.coordinates;
  assert.throws(() => near(unscaled, want));
  // The way back gives canvas pixels.
  const back = (await toPixels(half, pt(want), { space: 'canvas' })).geometry.coordinates;
  near(back, [2500, 2000], 0.001);
});

test("'canvas' without canvas dimensions is a DataError; 'image' in the same setup is the control", async () => {
  const g = await readGeoreference(ROCQUE); // no manifest: canvas id from partOf, size unknown
  assert.equal(g.canvasId, ROCQUE_CANVAS);
  assert.equal(g.canvas, null);
  await assert.rejects(toWorld(g, pt([5000, 4000]), { space: 'canvas' }), (e) => isDataError(e) && /size of the canvas/.test(e.message));
  await assert.rejects(toPixels(g, pt([-80, 45]), { space: 'canvas' }), isDataError);
  const { geojson } = await toWorld(g, pt([5000, 4000]), { space: 'image' });
  assert.equal(geojson.type, 'Point');
});

test('a missing space throws; a given one is the control', async () => {
  const g = await rocque();
  await assert.rejects(toWorld(g, pt([5000, 4000])), (e) => e instanceof TypeError && /space/.test(e.message));
  await assert.rejects(toWorld(g, pt([5000, 4000]), { space: 'pixels' }), TypeError);
  await assert.rejects(toPixels(g, pt([-80, 45])), TypeError);
  assert.throws(() => containsRegion(g, pt([5000, 4000])), TypeError);
  await toWorld(g, pt([5000, 4000]), { space: 'image' });
  await toPixels(g, pt([-80, 45]), { space: 'image' });
});

// ---- Geometries --------------------------------------------------------------------------------

test('a GeometryCollection is a DataError, both ways; a MultiPolygon is the control', async () => {
  const g = await rocque();
  const a = [[3000, 3000], [4000, 3000], [4000, 4000], [3000, 4000], [3000, 3000]];
  const b = [[6000, 4000], [7000, 4000], [7000, 5000], [6000, 5000], [6000, 4000]];
  const gc = { type: 'GeometryCollection', geometries: [{ type: 'Polygon', coordinates: [a] }, pt([5000, 5000])] };
  await assert.rejects(toWorld(g, gc, { space: 'image' }), (e) => isDataError(e) && /GeometryCollection/.test(e.message));
  const { geojson } = await toWorld(g, { type: 'MultiPolygon', coordinates: [[a], [b]] }, { space: 'image' });
  assert.equal(geojson.type, 'MultiPolygon');
  assert.equal(geojson.coordinates.length, 2);
  geojson.coordinates.forEach(assertClosedCcw);
  await assert.rejects(toPixels(g, { type: 'GeometryCollection', geometries: [geojson] }, { space: 'image' }), isDataError);
  const { geometry } = await toPixels(g, geojson, { space: 'image' });
  assert.equal(geometry.type, 'MultiPolygon');
  // Mixed SVG shapes would make a collection too.
  await assert.rejects(toWorld(g, { svg: '<svg><polygon points="0,0 10,0 10,10"/><polyline points="0,0 5,5"/></svg>' }, { space: 'image' }), isDataError);
});

test('every geometry type goes through, both ways', async () => {
  const g = await rocque();
  const geoms = [
    pt([5000, 4000]),
    { type: 'MultiPoint', coordinates: [[5000, 4000], [6000, 4500]] },
    { type: 'LineString', coordinates: [[3000, 3000], [7000, 5000]] },
    { type: 'MultiLineString', coordinates: [[[3000, 3000], [7000, 5000]], [[3000, 5000], [7000, 3000]]] },
    { type: 'Polygon', coordinates: [[[3000, 3000], [7000, 3000], [7000, 5500], [3000, 5500], [3000, 3000]], [[4000, 4000], [4000, 4500], [5000, 4500], [5000, 4000], [4000, 4000]]] },
  ];
  for (const geom of geoms) {
    const { geojson } = await toWorld(g, geom, { space: 'image' });
    assert.equal(geojson.type, geom.type);
    if (geojson.type === 'Polygon') assertClosedCcw(geojson.coordinates);
    const { geometry } = await toPixels(g, { type: 'Feature', properties: {}, geometry: geojson }, { space: 'image' });
    assert.equal(geometry.type, geom.type);
  }
});

test('xywh regions become closed counter-clockwise polygons (pixel:, percent:, and plain)', async () => {
  const g = await rocque();
  const plain = await toWorld(g, { xywh: '3000,3000,2000,1000' }, { space: 'canvas' });
  const pixel = await toWorld(g, { xywh: 'xywh=pixel:3000,3000,2000,1000' }, { space: 'canvas' });
  assert.equal(plain.geojson.type, 'Polygon');
  assertClosedCcw(plain.geojson.coordinates);
  assert.deepEqual(pixel.geojson, plain.geojson);
  assert.equal(plain.record.region, '3000,3000,2000,1000');
  // percent: a share of the canvas; 50% of 11436 is 5718.
  const pc = await toWorld(g, { xywh: 'percent:25,25,50,50' }, { space: 'canvas' });
  const px = await toWorld(g, { xywh: `${11436 / 4},${6268 / 4},${11436 / 2},${6268 / 2}` }, { space: 'canvas' });
  assert.deepEqual(pc.geojson, px.geojson);
  assert.equal(pc.record.region, 'percent:25,25,50,50');
  for (const bad of ['3000,3000,2000', '3000,3000,0,1000', 'a,b,c,d', 'em:1,2,3,4']) {
    await assert.rejects(toWorld(g, { xywh: bad }, { space: 'canvas' }), isDataError, bad);
  }
});

test('svg shapes become closed counter-clockwise polygons; curves are refused, straight paths are the control', async () => {
  const g = await rocque();
  const W = (svg) => toWorld(g, { svg }, { space: 'image' });
  const rect = await W('<svg><rect x="3000" y="3000" width="2000" height="1000"/></svg>');
  const poly = await W('<svg xmlns="http://www.w3.org/2000/svg"><polygon points="3000,3000 5000,3000 5000,4000 3000,4000"></polygon></svg>');
  const path = await W('<svg><path d="M3000,3000 l2000,0 L5000,4000 h-2000 z"/></svg>');
  for (const r of [rect, poly, path]) { assert.equal(r.geojson.type, 'Polygon'); assertClosedCcw(r.geojson.coordinates); }
  // The same rectangle, three ways, is the same polygon (up to where the ring starts).
  const corners = (r) => r.geojson.coordinates[0].slice(0, -1).map(String).sort();
  assert.deepEqual(corners(poly), corners(rect));
  assert.deepEqual(corners(path), corners(rect));
  // Circle and ellipse: polygons of 64 sides.
  const circle = await W("<svg><circle cx='5000' cy='4000' r='300'/></svg>");
  const ellipse = await W('<svg><ellipse cx="5000" cy="4000" rx="600" ry="300"/></svg>');
  for (const r of [circle, ellipse]) { assertClosedCcw(r.geojson.coordinates); assert.equal(r.geojson.coordinates[0].length, 65); }
  // A rect with a rotate transform, as Recogito Studio writes one, is the rotated rectangle.
  const turned = await W('<svg><rect x="4000" y="3500" width="2000" height="1000" transform="rotate(90 5000 4000)"/></svg>');
  const explicit = await W('<svg><polygon points="5500,3000 5500,5000 4500,5000 4500,3000"/></svg>');
  const sorted = (r) => r.geojson.coordinates[0].slice(0, -1).map(([x, y]) => [x.toFixed(5), y.toFixed(5)].join()).sort();
  assert.deepEqual(sorted(turned), sorted(explicit));
  // A path of two closed subpaths, one inside the other: a polygon with a hole.
  const holed = await W('<svg><path d="M3000,3000 L7000,3000 L7000,5500 L3000,5500 Z M4000,4000 L5000,4000 L5000,4500 L4000,4500 Z"/></svg>');
  assert.equal(holed.geojson.type, 'Polygon');
  assert.equal(holed.geojson.coordinates.length, 2);
  assertClosedCcw(holed.geojson.coordinates);
  // Two apart: a MultiPolygon.
  const two = await W('<svg><path d="M3000,3000 L4000,3000 L4000,4000 Z M6000,4000 L7000,4000 L7000,5000 Z"/></svg>');
  assert.equal(two.geojson.type, 'MultiPolygon');
  // Lines stay lines.
  assert.equal((await W('<svg><polyline points="3000,3000 5000,4000 6000,3000"/></svg>')).geojson.type, 'LineString');
  assert.equal((await W('<svg><line x1="3000" y1="3000" x2="6000" y2="5000"/></svg>')).geojson.type, 'LineString');
  // Refused: curves, arcs, a transform on a group, text.
  await assert.rejects(W('<svg><path d="M3000,3000 C4000,2000 5000,2000 6000,3000 Z"/></svg>'), (e) => isDataError(e) && /"C"/.test(e.message));
  await assert.rejects(W('<svg><path d="M3000,3000 A100,100 0 0 1 3200,3000 Z"/></svg>'), isDataError);
  await assert.rejects(W('<svg><g transform="scale(2)"><polygon points="0,0 10,0 10,10"/></g></svg>'), isDataError);
  await assert.rejects(W('<svg><text x="0" y="0">Boston</text></svg>'), isDataError);
  await assert.rejects(W('<svg></svg>'), isDataError);
});

test('svg: a transform on anything but a shape, or an <svg> inside another, is a DataError; the bare shape is the control', async () => {
  const g = await rocque();
  const W = (svg) => toWorld(g, { svg }, { space: 'image' });
  const poly = '<polygon points="3000,3000 5000,3000 5000,4000"/>';
  const refused = [
    `<svg transform="scale(2)">${poly}</svg>`,
    `<svg><svg transform="translate(10,0)">${poly}</svg></svg>`,
    `<svg><a href="#" transform="translate(10,0)">${poly}</a></svg>`,
    `<svg><g><g transform="rotate(5)">${poly}</g></g></svg>`,
    `<svg><svg viewBox="0 0 10 10">${poly}</svg></svg>`,
    `<svg><svg x="100">${poly}</svg></svg>`,
  ];
  for (const svg of refused) await assert.rejects(W(svg), (e) => isDataError(e) && /Nothing was changed/.test(e.message), svg);
  // Controls: the same shape bare, inside a plain group and a plain link, and with its own transform.
  const bare = await W(`<svg>${poly}</svg>`);
  assert.deepEqual((await W(`<svg><a href="#"><g>${poly}</g></a></svg>`)).geojson, bare.geojson);
  assert.deepEqual((await W(`<svg viewBox="0 0 11436 6268">${poly}</svg>`)).geojson, bare.geojson);
  const moved = await W('<svg><polygon points="2990,3000 4990,3000 4990,4000" transform="translate(10,0)"/></svg>');
  assert.deepEqual(moved.geojson, bare.geojson);
});

test('precision rounds the output; the default of 6 decimals is the control', async () => {
  const g = await rocque();
  const decimals = (n) => (String(n).split('.')[1] || '').length;
  const two = await toWorld(g, { xywh: '3000,3000,2000,1000' }, { space: 'image', precision: 2 });
  const all2 = two.geojson.coordinates[0].flat();
  assert.ok(all2.every((n) => decimals(n) <= 2), JSON.stringify(all2));
  const six = await toWorld(g, { xywh: '3000,3000,2000,1000' }, { space: 'image' });
  const all6 = six.geojson.coordinates[0].flat();
  assert.ok(all6.every((n) => decimals(n) <= 6));
  assert.ok(all6.some((n) => decimals(n) > 2), 'the default keeps more than 2 decimals');
  await assert.rejects(toWorld(g, pt([1, 1]), { space: 'image', precision: 2.5 }), TypeError);
});

test('densify adds vertices where the transformation bends lines, both ways; without it there are none', async () => {
  const g = await rocque();
  const line = { type: 'LineString', coordinates: [[1000, 1000], [10000, 5000]] };
  const bare = await toWorld(g, line, { space: 'image' });
  const dense = await toWorld(g, line, { space: 'image', densify: 1 });
  assert.equal(bare.geojson.coordinates.length, 2);
  assert.ok(dense.geojson.coordinates.length > 10, String(dense.geojson.coordinates.length));
  const back = await toPixels(g, bare.geojson, { space: 'image' });
  const backDense = await toPixels(g, bare.geojson, { space: 'image', densify: 1 });
  assert.equal(back.geometry.coordinates.length, 2);
  assert.ok(backDense.geometry.coordinates.length > 10);
  // The ends stay where they were.
  near(backDense.geometry.coordinates[0], [1000, 1000], 0.001);
  near(backDense.geometry.coordinates.at(-1), [10000, 5000], 0.001);
});

test('transformation names: each is used and recorded; an unknown one is a DataError', async () => {
  const g = await rocque();
  for (const t of ['polynomial', 'polynomial1', 'polynomial2', 'polynomial3', 'thinPlateSpline', 'projective', 'helmert']) {
    const { record } = await toWorld(g, pt([5000, 4000]), { space: 'image', transformation: t });
    assert.equal(record.transformation, t === 'polynomial1' ? 'polynomial' : t);
  }
  const a = (await toWorld(g, pt([5000, 4000]), { space: 'image', transformation: 'helmert' })).geojson.coordinates;
  const b = (await toWorld(g, pt([5000, 4000]), { space: 'image', transformation: 'thinPlateSpline' })).geojson.coordinates;
  assert.notDeepEqual(a, b, 'different transformations give different places');
  await assert.rejects(toWorld(g, pt([5000, 4000]), { space: 'image', transformation: 'bilinear' }), isDataError);
  // Default: the annotation's own.
  assert.equal((await toWorld(g, pt([5000, 4000]), { space: 'image' })).record.transformation, 'thinPlateSpline');
});

// ---- Choosing among georeferences --------------------------------------------------------------

test('matchesTarget: the canvas or the image, with /info.json and a trailing slash ignored; anything else is not', async () => {
  const g = await rocque();
  assert.equal(matchesTarget(g, ROCQUE_CANVAS), true);
  assert.equal(matchesTarget(g, ROCQUE_IMAGE), true);
  assert.equal(matchesTarget(g, `${ROCQUE_IMAGE}/info.json`), true);
  assert.equal(matchesTarget(g, `${ROCQUE_IMAGE}/`), true);
  assert.equal(matchesTarget(g, 'https://ark.digitalcommonwealth.org/ark:/50959/ks65px29g/canvas/qr46xn78z'), false);
  assert.equal(matchesTarget(g, ROCQUE_MANIFEST), false);
  assert.equal(matchesTarget(g, undefined), false);
});

test('matchTarget: a IIIF picture URL of the whole image, unrotated, matches the image service', async () => {
  const g = await rocque();
  // Control: the service itself, and the canvas, say how they matched.
  assert.deepEqual(matchTarget(g, ROCQUE_IMAGE), { match: true, via: 'service' });
  assert.deepEqual(matchTarget(g, ROCQUE_CANVAS), { match: true, via: 'canvas' });
  for (const tail of ['full/max/0/default.jpg', 'full/full/0/default.jpg', 'full/max/0.0/gray.webp', 'full/full/0/native.jp2']) {
    const assumed = tail.includes('/max/') ? { assumedFullSize: true } : {};
    assert.deepEqual(matchTarget(g, `${ROCQUE_IMAGE}/${tail}`), { match: true, via: 'image-url', ...assumed }, tail);
    assert.equal(matchesTarget(g, `${ROCQUE_IMAGE}/${tail}`), true, tail);
  }
  // Not Image API grammar: no stripping (control above uses the same service).
  for (const tail of ['full/max/0/default.bmp', 'full/max/0/fancy.jpg', 'whole/max/0/default.jpg', 'full/max/default.jpg']) {
    assert.deepEqual(matchTarget(g, `${ROCQUE_IMAGE}/${tail}`), { match: false, via: null }, tail);
  }
  // Another image's picture URL does not match, and gives no reason.
  assert.deepEqual(matchTarget(g, 'https://iiif.digitalcommonwealth.org/iiif/2/commonwealth:qr46xn78z/full/max/0/default.jpg'), { match: false, via: null });
});

test('matchTarget: a cropped or rotated picture URL does not match, and says why', async () => {
  const g = await rocque();
  assert.deepEqual(matchTarget(g, `${ROCQUE_IMAGE}/full/max/0/default.jpg`), { match: true, via: 'image-url', assumedFullSize: true }); // control
  assert.deepEqual(matchTarget(g, `${ROCQUE_IMAGE}/100,200,3000,4000/max/0/default.jpg`), { match: false, via: null, reason: 'cropped' });
  assert.deepEqual(matchTarget(g, `${ROCQUE_IMAGE}/pct:10,10,50,50/max/0/default.jpg`), { match: false, via: null, reason: 'cropped' });
  assert.deepEqual(matchTarget(g, `${ROCQUE_IMAGE}/square/max/0/default.jpg`), { match: false, via: null, reason: 'cropped' });
  assert.deepEqual(matchTarget(g, `${ROCQUE_IMAGE}/full/max/90/default.jpg`), { match: false, via: null, reason: 'rotated' });
  assert.deepEqual(matchTarget(g, `${ROCQUE_IMAGE}/full/max/!0/default.jpg`), { match: false, via: null, reason: 'rotated' });
  // A scaled picture's pixels are not the image's: it does not match (the whole-size tails above are the control).
  for (const tail of ['full/1000,/0/color.png', 'full/^!800,600/0.0/gray.webp', 'full/pct:50/0/native.jp2', 'full/,500/0/default.jpg'])
    assert.deepEqual(matchTarget(g, `${ROCQUE_IMAGE}/${tail}`), { match: false, via: null, reason: 'resized' }, tail);
  assert.equal(matchesTarget(g, `${ROCQUE_IMAGE}/full/max/90/default.jpg`), false);
});

test('matchTarget: a picture URL never matches the canvas id; http is not https; /info.json and a slash still match', async () => {
  const g = await rocque();
  // A georeference whose canvas id is the only thing the picture URL's prefix could equal.
  const canvasOnly = { ...g, imageServiceId: 'https://example.org/iiif/other' };
  assert.deepEqual(matchTarget(canvasOnly, ROCQUE_CANVAS), { match: true, via: 'canvas' }); // control
  assert.deepEqual(matchTarget(canvasOnly, `${ROCQUE_CANVAS}/full/max/0/default.jpg`), { match: false, via: null });
  assert.deepEqual(matchTarget(g, `${ROCQUE_CANVAS}/full/max/0/default.jpg`), { match: false, via: null });
  // The scheme is kept as given (Allmaps keys by the exact service id).
  const http = ROCQUE_IMAGE.replace(/^https:/, 'http:');
  assert.notEqual(http, ROCQUE_IMAGE);
  assert.deepEqual(matchTarget(g, http), { match: false, via: null });
  assert.deepEqual(matchTarget(g, `${http}/full/max/0/default.jpg`), { match: false, via: null });
  assert.deepEqual(matchTarget(g, `${ROCQUE_IMAGE}/info.json`), { match: true, via: 'service' });
  assert.deepEqual(matchTarget(g, `${ROCQUE_IMAGE}/`), { match: true, via: 'service' });
});

test('allmapsLookupUrl: the image ids Allmaps itself gives the fixtures', async () => {
  // Recorded in the fixtures: bpl-rocque-annotation.json's target.source.id, and README.md for the LoC page.
  assert.equal(await allmapsLookupUrl(ROCQUE_IMAGE), 'https://annotations.allmaps.org/images/125d074cfe08b077');
  assert.equal(JSON.stringify(ROCQUE).includes('https://annotations.allmaps.org/images/125d074cfe08b077'), true);
  assert.equal(await allmapsLookupUrl('https://tile.loc.gov/image-services/iiif/service:gmd:gmd384:g3842:g3842c:ct008615'), 'https://annotations.allmaps.org/images/7f2494dd1ad9ed7a');
  // Control: the exact id matters, as it does for Allmaps.
  assert.notEqual(await allmapsLookupUrl(`${ROCQUE_IMAGE}/`), 'https://annotations.allmaps.org/images/125d074cfe08b077');
  await assert.rejects(allmapsLookupUrl(undefined), TypeError);
});

test('containsRegion: a region inside one map of a sheet is in its mask and not in the other', async () => {
  const left = await readGeoreference(LOC, { index: 0 }), right = await readGeoreference(LOC, { index: 1 });
  const inLeft = { xywh: '1200,4000,800,1500' }, inRight = { xywh: '3000,1000,1500,3000' };
  assert.equal(containsRegion(left, inLeft, { space: 'image' }), true);
  assert.equal(containsRegion(right, inLeft, { space: 'image' }), false);
  assert.equal(containsRegion(right, inRight, { space: 'image' }), true);
  assert.equal(containsRegion(left, inRight, { space: 'image' }), false);
  // Straddling the edge of the left map: its corners are not all inside.
  assert.equal(containsRegion(left, { xywh: '2000,4000,800,500' }, { space: 'image' }), false);
  // An SVG and a point work too.
  assert.equal(containsRegion(left, { svg: '<svg><polygon points="1200,4000 1900,4100 1500,5000"/></svg>' }, { space: 'image' }), true);
  assert.equal(containsRegion(right, pt([4000, 3000]), { space: 'image' }), true);
  // An edge that leaves a concave mask and comes back, with every vertex inside, is caught.
  const g = { ...right, mask: [[0, 0], [100, 0], [100, 100], [60, 100], [60, 40], [40, 40], [40, 100], [0, 100]] };
  assert.equal(containsRegion(g, { type: 'LineString', coordinates: [[20, 80], [80, 80]] }, { space: 'image' }), false);
  assert.equal(containsRegion(g, { type: 'LineString', coordinates: [[20, 20], [80, 20]] }, { space: 'image' }), true);
});

// ---- What is written into PLATO ----------------------------------------------------------------

const load = (f) => JSON.parse(readFileSync(`public/plato/${f}`, 'utf8'));
const ajv = addPlatoFormats(new Ajv2020({ strict: false, allErrors: true, logger: strictFormatLogger }));
ajv.addSchema(load('plato.schema.json'), 'https://w3id.org/plato/schemas/plato.schema.json');
const citationValid = ajv.getSchema('https://w3id.org/plato/schemas/plato.schema.json#/$defs/citation');

test('georefNote: a label anchor adds its sentence; without one, unchanged', async () => {
  const g = await rocque();
  const plain = (await toWorld(g, pt([5000, 4000]), { space: 'image' })).record;
  const anchored = (await toWorld(g, pt([5000, 4000]), { space: 'image', role: 'https://w3id.org/plato#LabelAnchor' })).record;
  assert.equal(LABEL_ANCHOR, 'https://w3id.org/plato#LabelAnchor');
  assert.equal(anchored.role, LABEL_ANCHOR);
  assert.equal('role' in plain, false);
  const note = `Georeferenced through ${ROCQUE_ID} (thin plate spline, 22 control points), retrieval date not recorded. On canvas ${ROCQUE_CANVAS} of manifest ${ROCQUE_MANIFEST}.`;
  assert.equal(georefNote(plain), note);
  assert.equal(georefNote(anchored), `${note} The position is where the map writes the name, not necessarily where the place is.`);
  // Another role: no extra sentence.
  assert.equal(georefNote({ ...plain, role: 'https://w3id.org/plato#Other' }), note);
});

test('the record, and georefNote: the fixed template, pinned exactly', async () => {
  const g = await rocque();
  const { record } = await toWorld(g, pt([5000, 4000]), { space: 'image' });
  assert.deepEqual(record, {
    direction: 'toWorld', transformation: 'thinPlateSpline', gcps: 22, annotationId: ROCQUE_ID,
    manifestId: ROCQUE_MANIFEST, canvasId: ROCQUE_CANVAS, imageServiceId: ROCQUE_IMAGE, space: 'image',
    title: ROCQUE_TITLE, imageSize: { width: 11436, height: 6268 }, canvasSize: { width: 11436, height: 6268 },
    software: '@allmaps/transform@1.0.0-beta.53',
  });
  // Retrieved at a known time, and not.
  assert.equal(georefNote(record, { fetched: '2026-09-30T14:05:00Z' }), `Georeferenced through ${ROCQUE_ID} (thin plate spline, 22 control points), retrieved 2026-09-30T14:05:00Z. On canvas ${ROCQUE_CANVAS} of manifest ${ROCQUE_MANIFEST}.`);
  assert.equal(georefNote(record), `Georeferenced through ${ROCQUE_ID} (thin plate spline, 22 control points), retrieval date not recorded. On canvas ${ROCQUE_CANVAS} of manifest ${ROCQUE_MANIFEST}.`);
  assert.equal(georefNote(record, {}), georefNote(record));
  const h = await readGeoreference(LYNN, { manifest: LYNN_M, index: 7 });
  const r2 = (await toWorld(h, pt([2000, 1000]), { space: 'image' })).record;
  assert.equal(georefNote(r2, { fetched: '2026-09-30T15:00:00.123+01:00' }), `Georeferenced through https://annotations.allmaps.org/maps/051d059e8d1111fd (polynomial order 1, 23 control points), retrieved 2026-09-30T15:00:00.123+01:00. On canvas ${LYNN_CANVAS('jd475s53d')} of manifest ${LYNN_MANIFEST}.`);
  // Each place sentence; one control point: no plural.
  const bare = { ...record, canvasId: null, manifestId: null, gcps: 1, transformation: 'polynomial' };
  assert.equal(georefNote(bare), `Georeferenced through ${ROCQUE_ID} (polynomial order 1, 1 control point), retrieval date not recorded. On image ${ROCQUE_IMAGE}.`);
  assert.equal(georefNote({ ...record, manifestId: null }), `Georeferenced through ${ROCQUE_ID} (thin plate spline, 22 control points), retrieval date not recorded. On canvas ${ROCQUE_CANVAS}.`);
  assert.equal(georefNote({ ...record, canvasId: null }), `Georeferenced through ${ROCQUE_ID} (thin plate spline, 22 control points), retrieval date not recorded. In manifest ${ROCQUE_MANIFEST}.`);
  // The way back uses the same template.
  const back = (await toPixels(g, pt([-80, 45]), { space: 'image' })).record;
  assert.equal(georefNote(back), georefNote(record));
  assert.doesNotMatch(georefNote(record), /allmaps\/transform/, 'the software is not in the note');
  // fetched that is not an ISO date-time with a zone is a TypeError; the valid one above is the control.
  for (const bad of ['2026-09-30', '30/09/2026', '2026-09-30T14:05:00', 'yesterday', 20260930, '2026-13-45T99:99:00Z']) {
    assert.throws(() => georefNote(record, { fetched: bad }), TypeError, String(bad));
  }
});

test('georefNote: the transformation words are a fixed vocabulary, each used as pinned', () => {
  assert.deepEqual({ ...TRANSFORMATION_WORDS }, {
    polynomial: 'polynomial order 1', polynomial2: 'polynomial order 2', polynomial3: 'polynomial order 3',
    thinPlateSpline: 'thin plate spline', projective: 'projective', helmert: 'Helmert', straight: 'straight', linear: 'linear',
  });
  assert.ok(Object.isFrozen(TRANSFORMATION_WORDS));
  const base = { annotationId: 'https://example.org/a', gcps: 5, canvasId: null, manifestId: null, imageServiceId: null };
  for (const [name, words] of Object.entries(TRANSFORMATION_WORDS)) {
    assert.equal(georefNote({ ...base, transformation: name }), `Georeferenced through https://example.org/a (${words}, 5 control points), retrieval date not recorded.`);
  }
  assert.equal(georefNote({ ...base, transformation: 'polynomial1' }), 'Georeferenced through https://example.org/a (polynomial order 1, 5 control points), retrieval date not recorded.');
  assert.throws(() => georefNote({ ...base, transformation: 'wobbly' }), TypeError);
});

test('georefCitation: exact shapes, valid against the pinned PLATO schema (and an invalid one is caught)', async () => {
  const g = await rocque();
  const { record } = await toWorld(g, pt([5000, 4000]), { space: 'image' });
  const c = georefCitation(record);
  assert.deepEqual(c, { source: { '@id': ROCQUE_MANIFEST, title: ROCQUE_TITLE, authorityType: 'source' }, locator: ROCQUE_CANVAS, citationFunction: 'http://purl.org/spar/cito/citesAsEvidence' });
  assert.ok(citationValid(c), JSON.stringify(citationValid.errors));
  // A region in canvas pixels is a fragment of the canvas; in image pixels, of the image.
  const rc = (await toWorld(g, { xywh: 'pixel:3000,3000,2000,1000' }, { space: 'canvas' })).record;
  assert.equal(rc.region, '3000,3000,2000,1000');
  assert.equal(georefCitation(rc).locator, `${ROCQUE_CANVAS}#xywh=3000,3000,2000,1000`);
  // A region in image pixels, with the canvas known, is converted to canvas units and cited on the canvas.
  const ri = (await toWorld(g, { xywh: '3000,3000,2000,1000' }, { space: 'image' })).record;
  assert.equal(ri.region, '3000,3000,2000,1000');
  assert.equal(georefCitation(ri).locator, `${ROCQUE_CANVAS}#xywh=3000,3000,2000,1000`);
  const half = await readGeoreference(ROCQUE, { manifest: scaledManifest(2) });
  const rh = (await toWorld(half, { xywh: '3001,3001,2001,1001' }, { space: 'image' })).record;
  // Rounded outwards to whole canvas pixels: 1500.5 -> 1500; 2501 and 2001 stay; so 1001 by 501.
  assert.equal(rh.canvasRegion, '1500,1500,1001,501');
  assert.equal(georefCitation(rh).locator, `${ROCQUE_CANVAS}#xywh=1500,1500,1001,501`);
  const hp = (await toWorld(half, { xywh: 'percent:10,20,30,40' }, { space: 'image' })).record;
  assert.equal(georefCitation(hp).locator, `${ROCQUE_CANVAS}#xywh=percent:10,20,30,40`);
  // Control: with no canvas at all, the region is cited on the image, in image pixels.
  const noCanvas = await readGeoreference(LOC, { index: 0 });
  const rn = (await toWorld({ ...noCanvas, canvasId: null, manifestId: null }, { xywh: '1200,4000,800,1500' }, { space: 'image' })).record;
  assert.equal(georefCitation(rn).locator, `${rn.imageServiceId}#xywh=1200,4000,800,1500`);
  assert.ok(citationValid(georefCitation(rn)), JSON.stringify(citationValid.errors));
  assert.ok(citationValid(georefCitation(rh)));
  assert.ok(citationValid(georefCitation(rc)));
  // No manifest or title: the image, with an honest title.
  const bare = georefCitation({ ...record, manifestId: null, canvasId: null, title: null });
  assert.deepEqual(bare, { source: { '@id': ROCQUE_IMAGE, title: `The georeferenced map (IIIF image ${ROCQUE_IMAGE})`, authorityType: 'source' }, citationFunction: 'http://purl.org/spar/cito/citesAsEvidence' });
  assert.ok(citationValid(bare), JSON.stringify(citationValid.errors));
  // Control: the validator refuses an inline source without a title, and a source that is not an address.
  assert.equal(citationValid({ source: { '@id': ROCQUE_MANIFEST, authorityType: 'source' } }), false);
  assert.equal(citationValid({ source: 'not an address' }), false);
});

test('georefCitation with a region: padded 2% (at least 1 px), rounded outwards, on the canvas; it overrides canvasRegion', async () => {
  const g = await rocque();
  const img = (await toWorld(g, pt([5000, 4000]), { space: 'image' })).record;
  const cnv = (await toWorld(g, pt([5000, 4000]), { space: 'canvas' })).record;
  // 2% of 2000 = 40 on every side.
  assert.equal(georefCitation(cnv, { region: [3000, 3000, 2000, 1000] }).locator, `${ROCQUE_CANVAS}#xywh=2960,2960,2080,1080`);
  assert.equal(georefCitation(img, { region: [3000, 3000, 2000, 1000] }).locator, `${ROCQUE_CANVAS}#xywh=2960,2960,2080,1080`);
  // Fractional edges are rounded outwards: 2% of 10.5 is 0.21, so 1 px (the minimum): 99.5 -> 98, 110.0+1 -> 111.
  assert.equal(georefCitation(cnv, { region: [99.5, 50, 10.5, 3] }).locator, `${ROCQUE_CANVAS}#xywh=98,49,13,5`);
  // 2% of 100 = 2 exactly, not rounded out further.
  assert.equal(georefCitation(cnv, { region: [10, 10, 100, 50] }).locator, `${ROCQUE_CANVAS}#xywh=8,8,104,54`);
  // Kept within the canvas.
  assert.equal(georefCitation(cnv, { region: [0, 0, 11436, 6268] }).locator, `${ROCQUE_CANVAS}#xywh=0,0,11436,6268`);
  // From image pixels on a canvas at half the size: the box is halved, then padded in canvas units.
  const half = await readGeoreference(ROCQUE, { manifest: scaledManifest(2) });
  const rh = (await toWorld(half, pt([5000, 4000]), { space: 'image' })).record;
  assert.equal(georefCitation(rh, { region: [3001, 3001, 2001, 1001] }).locator, `${ROCQUE_CANVAS}#xywh=1480,1480,1042,542`);
  // It overrides canvasRegion; without it, canvasRegion is the control.
  const withRegion = (await toWorld(g, { xywh: '3000,3000,2000,1000' }, { space: 'canvas' })).record;
  assert.equal(georefCitation(withRegion).locator, `${ROCQUE_CANVAS}#xywh=3000,3000,2000,1000`);
  assert.equal(georefCitation(withRegion, { region: [10, 10, 100, 50] }).locator, `${ROCQUE_CANVAS}#xywh=8,8,104,54`);
  // No canvas: on the image service, in image pixels.
  const noCanvas = { ...img, canvasId: null, manifestId: null, canvasSize: null };
  assert.equal(georefCitation(noCanvas, { region: [3000, 3000, 2000, 1000] }).locator, `${ROCQUE_IMAGE}#xywh=2960,2960,2080,1080`);
  // Canvas size unknown, box in image pixels: on the image service too.
  assert.equal(georefCitation({ ...img, canvasSize: null }, { region: [3000, 3000, 2000, 1000] }).locator, `${ROCQUE_IMAGE}#xywh=2960,2960,2080,1080`);
  for (const c of [georefCitation(cnv, { region: [3000, 3000, 2000, 1000] }), georefCitation(noCanvas, { region: [1, 1, 5, 5] })]) {
    assert.ok(citationValid(c), JSON.stringify(citationValid.errors));
  }
  for (const bad of [[1, 2, 3], [1, 2, 0, 4], [1, 2, 3, -4], ['1', 2, 3, 4], 'x', [1, 2, NaN, 4]]) {
    assert.throws(() => georefCitation(cnv, { region: bad }), TypeError, JSON.stringify(bad));
  }
});

test('georefAnnotationCitation: the annotation, cited for its method; valid against the pinned PLATO schema', async () => {
  const g = await rocque();
  const { record } = await toWorld(g, pt([5000, 4000]), { space: 'image' });
  const c = georefAnnotationCitation(record);
  assert.deepEqual(c, {
    source: { '@id': ROCQUE_ID, title: `Georeference of ${ROCQUE_TITLE}, made in Allmaps`, authorityType: 'source', derivedFrom: ROCQUE_MANIFEST },
    citationFunction: 'http://purl.org/spar/cito/usesMethodIn',
  });
  // As PLATO's worked example (schemas/examples/place-centric-georeference.json) writes it: derived
  // from the map; without a manifest, from the image; "made in Allmaps" only for Allmaps' own server.
  assert.equal(georefAnnotationCitation({ ...record, manifestId: null }).source.derivedFrom, ROCQUE_IMAGE);
  assert.equal(georefAnnotationCitation({ ...record, annotationId: 'https://example.org/georef/1' }).source.title, `Georeference of ${ROCQUE_TITLE}`);
  assert.ok(citationValid(c), JSON.stringify(citationValid.errors));
  const untitled = georefAnnotationCitation({ ...record, title: null });
  assert.equal(untitled.source.title, `Georeference of the map in IIIF manifest ${ROCQUE_MANIFEST}, made in Allmaps`);
  assert.equal(georefAnnotationCitation({ ...record, title: null, manifestId: null }).source.title, `Georeference of the map in IIIF image ${ROCQUE_IMAGE}, made in Allmaps`);
  assert.ok(citationValid(untitled), JSON.stringify(citationValid.errors));
  assert.throws(() => georefAnnotationCitation({ ...record, annotationId: null }), TypeError);
  // Control: the schema refuses a citation function outside CiTO, and the CURIE form of a valid one.
  assert.equal(citationValid({ ...c, citationFunction: 'http://example.org/usesMethodIn' }), false);
  assert.equal(citationValid({ ...c, citationFunction: 'cito:usesMethodIn' }), false);
  assert.equal(citationValid({ ...georefCitation(record), citationFunction: 'cito:citesAsEvidence' }), false);
});

// ---- Folds: one place, several positions on the map -------------------------------------------

/** Take an image point to the world and back with one transformation. */
async function back(g, p, transformation) {
  const { geojson } = await toWorld(g, pt(p), { space: 'image', transformation, precision: 12 });
  return (await toPixels(g, geojson, { space: 'image', transformation })).geometry.coordinates;
}

test('a fold with exactly one position inside the mask: that one is used (the others lie off the map)', async () => {
  const d = await readGeoreference(DOMINIONS, { manifest: DOMINIONS_M });
  // Polynomial order 2 folds: this corner of the map has two more positions, far off the image.
  near(await back(d, [7306, 5949], 'polynomial2'), [7306, 5949], 0.001);
  // Control: move the mask away from the corner and no position is inside it, so it is refused.
  const moved = { ...d, mask: [[100, 100], [200, 100], [200, 200], [100, 200]] };
  await assert.rejects(back(moved, [7306, 5949], 'polynomial2'), (e) => isDataError(e) && /more than one position on the map/.test(e.message) && /none inside/.test(e.message));
});

test('no fold, one position, outside the mask: it is used', async () => {
  const d = await readGeoreference(DOMINIONS, { manifest: DOMINIONS_M });
  const outside = [-500, -400];
  assert.equal(containsRegion(d, pt(outside), { space: 'image' }), false, 'the point is off the map');
  near(await back(d, outside, 'polynomial'), outside, 0.001);
});

test('a fold with two positions inside the mask is a DataError; a point away from the fold is the control', async () => {
  const d = await readGeoreference(DOMINIONS, { manifest: DOMINIONS_M });
  await assert.rejects(back(d, [4383.6, 2379.6], 'thinPlateSpline'), (e) => isDataError(e) && /more than one position on the map/.test(e.message) && /all inside the map/.test(e.message));
  near(await back(d, [3650, 2970], 'thinPlateSpline'), [3650, 2970], 0.001);
});

// ---- Agreement with Allmaps' renderer ----------------------------------------------------------

test("toWorld agrees with Allmaps' renderer to within 1 mm, at control points and inside the map, for every transformation", async () => {
  // Reference values computed by @allmaps/project's ProjectedGcpTransformer, as @allmaps/render
  // builds it (test/fixtures/georef/README.md). Tolerance: 1 mm on the ground.
  const ref = fixture('allmaps-render-reference.json');
  const R = 6371008.8, rad = Math.PI / 180;
  const metres = ([a, b], [c, d]) => 2 * R * Math.asin(Math.sqrt(Math.sin((d - b) * rad / 2) ** 2 + Math.cos(b * rad) * Math.cos(d * rad) * Math.sin((c - a) * rad / 2) ** 2));
  let checked = 0, worst = 0;
  const cache = new Map();
  for (const c of ref.cases) {
    if (!cache.has(c.file)) cache.set(c.file, await readGeoreference(fixture(c.file), { index: c.index }));
    const g = cache.get(c.file);
    assert.equal(g.annotationId, c.annotationId);
    for (const { pixel, lonLat } of c.results) {
      const { geojson } = await toWorld(g, pt(pixel), { space: 'image', transformation: c.type, precision: 12 });
      const m = metres(geojson.coordinates, lonLat);
      worst = Math.max(worst, m);
      assert.ok(m < 0.001, `${c.file} ${c.type} ${pixel}: ${m} m from Allmaps`);
      checked++;
    }
  }
  assert.ok(checked > 700, `${checked} points checked`);
  // Control: fitting in degrees instead of Web Mercator would be caught by the same tolerance.
  const { GcpTransformer } = await import('@allmaps/transform');
  const rocquePoly = ref.cases.find((c) => c.type === 'polynomial' && c.file.startsWith('bpl-rocque'));
  const g = cache.get(rocquePoly.file);
  const degrees = new GcpTransformer(g.controlPoints.map((p) => ({ resource: p.resource, geo: p.geo })), 'polynomial1');
  assert.ok(rocquePoly.results.some(({ pixel, lonLat }) => metres(degrees.transformToGeo(pixel), lonLat) > 0.001));
});

test('an annotation in its own projection (resourceCrs) is refused; one that names Web Mercator is the control', async () => {
  const own = clone(ROCQUE);
  own.body.resourceCrs = { id: 'https://annotations.allmaps.org/projections/6fe5c97c6d3f1ccc', name: 'EPSG:5679 - DHDN / 3-degree Gauss-Kruger zone 5 (E-N)', definition: '+proj=tmerc +lat_0=0 +lon_0=15 +k=1 +x_0=5500000 +y_0=0 +datum=potsdam +units=m +no_defs' };
  await assert.rejects(readGeoreference(own), (e) => isDataError(e) && /in the projection EPSG:5679 - DHDN .* which PLATO tools do not support yet\. Nothing was changed\./.test(e.message));
  const merc = clone(ROCQUE);
  merc.body.resourceCrs = { id: 'https://example.org/projections/3857', name: 'EPSG:3857 - WGS 84 / Pseudo-Mercator', definition: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs' };
  assert.equal((await readGeoreference(merc)).gcps, 22);
});

// ---- Fixes after the pre-push review -----------------------------------------------------------

test('control points on both sides of the 180° meridian are a DataError; a set from 170° to 179.9° is the control', async () => {
  const across = withGcps([[[1000, 1000], [179.5, 10]], [[9000, 1200], [-179.5, 10.5]], [[5000, 5000], [179.8, 5]]]);
  await assert.rejects(readGeoreference(across), (e) => isDataError(e) && /180° meridian are not supported yet\. Nothing was changed\.$/.test(e.message));
  // Also when most points are on the far side.
  const back = withGcps([[[1000, 1000], [-179.5, 10]], [[9000, 1200], [-178, 10.5]], [[5000, 5000], [179.9, 5]]]);
  await assert.rejects(readGeoreference(back), isDataError);
  // Control: the same shape of set, all west of 180°.
  const east = await readGeoreference(withGcps([[[1000, 1000], [170, 10]], [[9000, 1200], [179.9, 10.5]], [[5000, 5000], [175, 5]]]));
  assert.equal(east.gcps, 3);
  near((await toWorld(east, pt([9000, 1200]), { space: 'image' })).geojson.coordinates, [179.9, 10.5]);
  // Control: a world map, its points spread round the world with no gap wider than 180°, fits in
  // Web Mercator and is not refused.
  const world = await readGeoreference(withGcps([[[100, 3000], [-170, 0]], [[3000, 3000], [-100, 10]], [[5700, 3100], [0, 5]], [[8500, 2900], [100, -10]], [[11300, 3000], [170, 0]]]));
  assert.equal(world.gcps, 5);
});

test('a citation region wholly off the canvas is a TypeError; one partly off is clamped to it (the control)', async () => {
  const g = await rocque();
  const cnv = (await toWorld(g, pt([5000, 4000]), { space: 'canvas' })).record;
  const img = (await toWorld(g, pt([5000, 4000]), { space: 'image' })).record;
  // Wholly beyond the right edge (it was 11999,99,-563,52), or above and left of the canvas.
  assert.throws(() => georefCitation(cnv, { region: [12000, 100, 50, 50] }), TypeError);
  assert.throws(() => georefCitation(cnv, { region: [100, 7000, 50, 50] }), TypeError);
  assert.throws(() => georefCitation(cnv, { region: [-500, -500, 100, 100] }), TypeError);
  assert.throws(() => georefCitation({ ...img, canvasId: null, manifestId: null, canvasSize: null }, { region: [12000, 100, 50, 50] }), TypeError);
  // Partly beyond: cut at the edges. 2% of 100 = 2: 11398..11436 and 98..152.
  assert.equal(georefCitation(cnv, { region: [11400, 100, 100, 50] }).locator, `${ROCQUE_CANVAS}#xywh=11398,98,38,54`);
  assert.equal(georefCitation(cnv, { region: [-50, -20, 100, 50] }).locator, `${ROCQUE_CANVAS}#xywh=0,0,52,32`);
  // Control: inside the canvas, as before.
  assert.equal(georefCitation(cnv, { region: [10, 10, 100, 50] }).locator, `${ROCQUE_CANVAS}#xywh=8,8,104,54`);
});

test('matchTarget: a picture at size "max" matches but is marked assumedFullSize; "full" is not marked', async () => {
  const g = await rocque();
  const max = matchTarget(g, `${ROCQUE_IMAGE}/full/max/0/default.jpg`);
  assert.equal(max.match, true);
  assert.equal(max.assumedFullSize, true);
  const full = matchTarget(g, `${ROCQUE_IMAGE}/full/full/0/default.jpg`);
  assert.deepEqual(full, { match: true, via: 'image-url' });
  assert.equal('assumedFullSize' in full, false);
  // Nor are the service or the canvas themselves.
  assert.deepEqual(matchTarget(g, ROCQUE_IMAGE), { match: true, via: 'service' });
});

test("svg: an outer <svg> whose viewBox or size is not the pixel frame is a DataError; one that is, or none, is the control", async () => {
  const g = await rocque();
  const W = (svg) => toWorld(g, { svg }, { space: 'image' });
  const poly = '<polygon points="3000,3000 5000,3000 5000,4000"/>';
  const refused = [
    `<svg viewBox="0 0 100 100" width="11436" height="6268">${poly}</svg>`, // the case that was read as raw pixels
    `<svg viewBox="10 20 11436 6268">${poly}</svg>`,
    `<svg viewBox="10 20 11436 6268" width="11436" height="6268">${poly}</svg>`,
    `<svg viewBox="0 0 11436 6268" width="5718">${poly}</svg>`,
    `<svg width="100%" height="100%">${poly}</svg>`,
    `<svg width="30cm" height="20cm">${poly}</svg>`,
    `<svg viewBox="0 0 100">${poly}</svg>`,
  ];
  for (const svg of refused) await assert.rejects(W(svg), (e) => isDataError(e) && /Nothing was changed/.test(e.message), svg);
  const bare = await W(`<svg>${poly}</svg>`);
  // Controls: a viewBox equal to the image, with and without its size; plain and px sizes.
  for (const svg of [
    `<svg viewBox="0 0 11436 6268">${poly}</svg>`,
    `<svg viewBox="0 0 11436 6268" width="11436" height="6268">${poly}</svg>`,
    `<svg viewBox="0,0,11436,6268" width="11436px" height="6268px">${poly}</svg>`,
    `<svg width="11436" height="6268">${poly}</svg>`,
    `<svg viewBox="0 0 100 100">${poly}</svg>`, // origin 0 0, no size: read as pixels
  ]) assert.deepEqual((await W(svg)).geojson, bare.geojson, svg);
});

test('svg: a <rect> with rounded corners is a DataError; rx="0" or ry="0" is the control', async () => {
  const g = await rocque();
  const W = (svg) => toWorld(g, { svg }, { space: 'image' });
  for (const rounded of ['rx="50"', 'ry="50"', 'rx="50" ry="20"']) {
    await assert.rejects(W(`<svg><rect x="3000" y="3000" width="2000" height="1000" ${rounded}/></svg>`), (e) => isDataError(e) && /rounded corners.*Nothing was changed/.test(e.message), rounded);
  }
  const plain = await W('<svg><rect x="3000" y="3000" width="2000" height="1000"/></svg>');
  for (const square of ['rx="0"', 'ry="0"', 'rx="0" ry="50"', 'rx="50" ry="0"']) {
    assert.deepEqual((await W(`<svg><rect x="3000" y="3000" width="2000" height="1000" ${square}/></svg>`)).geojson, plain.geojson, square);
  }
});

test('svg: a line after Z starts a new subpath from where the last one started; the same with an explicit M is the control', async () => {
  const g = await rocque();
  const W = (svg) => toWorld(g, { svg }, { space: 'image' });
  const implicit = await W('<svg><path d="M3000,3000 L5000,3000 L5000,4000 Z L3000,5000 L2000,5000 Z"/></svg>');
  const explicit = await W('<svg><path d="M3000,3000 L5000,3000 L5000,4000 Z M3000,3000 L3000,5000 L2000,5000 Z"/></svg>');
  assert.equal(explicit.geojson.type, 'MultiPolygon', 'two triangles meeting at a corner, neither a hole in the other');
  assert.deepEqual(implicit.geojson, explicit.geojson);
  // Relative, and H and V, after z: from the start point too.
  const rel = await W('<svg><path d="M3000,3000 L5000,3000 L5000,4000 z l0,2000 h-1000 z"/></svg>');
  assert.deepEqual(rel.geojson, explicit.geojson);
  // Still refused: drawing before any moveto.
  await assert.rejects(W('<svg><path d="L3000,3000 L5000,3000 Z"/></svg>'), isDataError);
});

test('a IIIF Presentation 2 manifest with its sequence as an object, not an array, is read as v2', async () => {
  const m = clone(ROCQUE_M);
  m.sequences = m.sequences[0];
  assert.ok(!Array.isArray(m.sequences));
  const g = await readGeoreference(ROCQUE, { manifest: m });
  assert.equal(g.canvasId, ROCQUE_CANVAS);
  assert.deepEqual(g.canvas, { width: 11436, height: 6268 });
  // Control: the manifest as published, and the v3 one, give the same.
  assert.deepEqual(g, await rocque());
  assert.equal((await readGeoreference(ROCQUE, { manifest: ROCQUE_V3 })).canvasId, ROCQUE_CANVAS);
});

test('motivation given as an array holding "georeferencing" is read; an array without it is a DataError', async () => {
  const a = clone(ROCQUE); a.motivation = ['georeferencing'];
  assert.equal((await readGeoreference(a)).annotationId, ROCQUE_ID);
  const b = clone(ROCQUE); b.motivation = ['commenting', 'georeferencing'];
  assert.equal((await readGeoreference(b)).annotationId, ROCQUE_ID);
  const c = clone(ROCQUE); c.motivation = ['commenting'];
  await assert.rejects(readGeoreference(c), (e) => isDataError(e) && /not a Georeference Annotation/.test(e.message));
  // Control: the string, as Allmaps writes it.
  assert.equal(ROCQUE.motivation, 'georeferencing');
  assert.equal((await readGeoreference(ROCQUE)).annotationId, ROCQUE_ID);
});

test('readGeoreference returns g frozen all the way down, and a clone or a spread of it still works', async () => {
  const g = await rocque();
  for (const o of [g, g.image, g.canvas, g.controlPoints, g.controlPoints[0], g.controlPoints[0].resource, g.mask, g.mask[0]]) assert.ok(Object.isFrozen(o));
  assert.throws(() => { g.mask[0][0] = 0; }, TypeError);
  assert.throws(() => { g.mask = null; }, TypeError);
  const at = (x) => toWorld(x, pt([5000, 4000]), { space: 'image' }).then((r) => r.geojson.coordinates);
  const here = await at(g);
  // Controls: a structured clone (as postMessage makes) is not frozen and gives the same place; so does a spread.
  const copy = structuredClone(g);
  assert.equal(Object.isFrozen(copy), false);
  assert.deepEqual(await at(copy), here);
  assert.deepEqual(await at({ ...g }), here);
});
