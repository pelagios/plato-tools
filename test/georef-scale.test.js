// metresPerPixel: the ground scale of a georeferenced map at one pixel. Checked against a
// computation of its own (Allmaps' GcpTransformer fitted here, a Mercator and a great-circle
// distance written out here), and in canvas space against image space. Every refusal has a
// control beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GcpTransformer } from '@allmaps/transform';
import { DataError } from '../src/engine/input.js';
import { readGeoreference, metresPerPixel } from '../src/engine/georef/index.js';

const fixture = (f) => JSON.parse(readFileSync('test/fixtures/georef/' + f, 'utf8'));
const ROCQUE = fixture('bpl-rocque-annotation.json'), ROCQUE_M = fixture('bpl-rocque-manifest.json');
const rocque = () => readGeoreference(ROCQUE, { manifest: ROCQUE_M });
const relClose = (a, b, tol) => Math.abs(a - b) <= tol * Math.abs(b);
const assertRel = (a, b, tol, what) => assert.ok(relClose(a, b, tol), `${what}: ${a} is not ${b} (to ${tol})`);

/** Independent: TPS fitted in spherical Web Mercator, central difference of ±1 px, haversine on 6371008.8 m. */
function reference(g, [x, y]) {
  const R = 6378137, rad = Math.PI / 180;
  const merc = ([lon, lat]) => [R * lon * rad, R * Math.log(Math.tan(Math.PI / 4 + (lat * rad) / 2))];
  const unmerc = ([mx, my]) => [mx / R / rad, (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) / rad];
  const t = new GcpTransformer(g.controlPoints.map((p) => ({ resource: p.resource, geo: merc(p.geo) })), 'thinPlateSpline');
  const at = (p) => unmerc(t.transformToGeo(p));
  const metres = ([l1, p1], [l2, p2]) => {
    const a = Math.sin(((p2 - p1) * rad) / 2) ** 2 + Math.cos(p1 * rad) * Math.cos(p2 * rad) * Math.sin(((l2 - l1) * rad) / 2) ** 2;
    return 2 * 6371008.8 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };
  const mx = metres(at([x - 1, y]), at([x + 1, y])) / 2, my = metres(at([x, y - 1]), at([x, y + 1])) / 2;
  return { x: mx, y: my, mean: Math.sqrt(mx * my) };
}

test('metresPerPixel on the Rocque map (thin plate spline) agrees with an independent computation; another pixel would be caught', async () => {
  const g = await rocque();
  assert.equal(g.transformation, 'thinPlateSpline');
  const px = [5000, 4000]; // inside the mask (284,942 226,6060 10776,6112 10752,976)
  const got = await metresPerPixel(g, px, { space: 'image' });
  const want = reference(g, px);
  for (const k of ['x', 'y', 'mean']) assertRel(got[k], want[k], 1e-4, k);
  assertRel(got.mean, Math.sqrt(got.x * got.y), 1e-12, 'mean is the geometric mean');
  // A continental map of 11436 pixels: hundreds of metres per pixel.
  assert.ok(got.mean > 100 && got.mean < 2000, `${got.mean} m/px`);
  // Control: the scale differs across the map enough that the comparison above catches a wrong pixel.
  const elsewhere = reference(g, [1000, 1500]);
  assert.ok(!relClose(got.x, elsewhere.x, 1e-4) || !relClose(got.y, elsewhere.y, 1e-4));
  // And the transformation option is honoured: polynomial order 1 gives another scale.
  const poly = await metresPerPixel(g, px, { space: 'image', transformation: 'polynomial' });
  assert.ok(!relClose(poly.x, got.x, 1e-4), 'polynomial differs from thin plate spline');
});

test('canvas space: a canvas at half the image size gives exactly double the metres per pixel; unscaled it would not', async () => {
  const g = await rocque();
  const m = structuredClone(ROCQUE_M);
  Object.assign(m.sequences[0].canvases[0], { width: 11436 / 2, height: 6268 / 2 });
  const half = await readGeoreference(ROCQUE, { manifest: m });
  assert.deepEqual(half.canvas, { width: 5718, height: 3134 });
  const image = await metresPerPixel(g, [5000, 4000], { space: 'image' });
  const canvas = await metresPerPixel(half, [2500, 2000], { space: 'canvas' });
  for (const k of ['x', 'y', 'mean']) assertRel(canvas[k], 2 * image[k], 1e-6, k);
  // Control: canvas pixels read as image pixels (the scaling not applied) are not double.
  const unscaled = await metresPerPixel(half, [2500, 2000], { space: 'image' });
  assert.ok(!relClose(unscaled.mean, 2 * image.mean, 1e-6));
});

test('metresPerPixel refuses as toWorld refuses: a bad or missing space, an unknown canvas size, too few points, a bad pixel', async () => {
  const g = await rocque();
  await assert.rejects(metresPerPixel(g, [5000, 4000]), TypeError);
  await assert.rejects(metresPerPixel(g, [5000, 4000], { space: 'screen' }), TypeError);
  const noCanvas = await readGeoreference(ROCQUE);
  await assert.rejects(metresPerPixel(noCanvas, [5000, 4000], { space: 'canvas' }), (e) => e instanceof DataError && /size of the canvas/.test(e.message));
  await assert.rejects(metresPerPixel(g, [5000, 'x'], { space: 'image' }), DataError);
  const few = { ...g, gcps: 2, controlPoints: g.controlPoints.slice(0, 2) };
  await assert.rejects(metresPerPixel(few, [5000, 4000], { space: 'image' }), DataError);
  // Control: the same setups with what was missing give a scale.
  for (const r of [await metresPerPixel(g, [5000, 4000], { space: 'image' }), await metresPerPixel(noCanvas, [5000, 4000], { space: 'image' })]) {
    assert.ok(Number.isFinite(r.mean) && r.mean > 0);
  }
});
