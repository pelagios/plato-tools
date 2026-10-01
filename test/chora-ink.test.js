// Assisted ink tracing (src/engine/chora/ink/): known answers on synthetic maps drawn in code
// (test/ink-synth.js, seeded). The windows are not square (640 × 480) and the shapes are off-centre and
// asymmetric, so that axes swapped, or a half pixel added where none belongs (or left out where one does),
// fail. The numbers are the design's (ink-tracing-design.md §10, as amended).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Image } from '@allmaps/iiif-parser';
import { Raster, rng, PAPER, INK, hausdorff, area, centroid, nearestOn, distToPolyline, closedRing } from './ink-synth.js';
import { prepare, traceArea, traceLine, InkError, strokeWidth } from '../src/engine/chora/ink/index.js';
import { median3 } from '../src/engine/chora/ink/median.js';
import { lab, labOf, lightness } from '../src/engine/chora/ink/colour.js';
import { sauvolaMask, globalMask } from '../src/engine/chora/ink/mask.js';
import { floodFill } from '../src/engine/chora/ink/fill.js';
import { sqDistance } from '../src/engine/chora/ink/edt.js';
import { zhangSuen } from '../src/engine/chora/ink/thin.js';
import { skeletonGraph, live, MERGE_PX } from '../src/engine/chora/ink/graph.js';
import { douglasPeucker, simplifyAll, selfIntersects } from '../src/engine/chora/ink/simplify.js';
import { chooseScale, frameAround, grow, tilesFor, compose, WINDOW, MAX_WINDOW } from '../src/engine/chora/ink/window.js';
import { snapPixels, binPoints, nearest } from '../src/engine/chora/ink/snap.js';

const W = 640, H = 480;
const ONE = { x0: 0, y0: 0, s: 1 };
const win = (r) => ({ w: r.w, h: r.h, rgba: r.rgba });

// ---- The pieces --------------------------------------------------------------------------------

test('median3 is the exact 3×3 median (edges repeated), against sorting the nine', () => {
  const r = rng(1), w = 13, h = 7, a = Float32Array.from({ length: w * h }, () => Math.round(r() * 100));
  const m = median3(a, w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = [];
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) v.push(a[Math.min(h - 1, Math.max(0, y + j)) * w + Math.min(w - 1, Math.max(0, x + i))]);
    v.sort((p, q) => p - q);
    assert.equal(m[y * w + x], v[4], `at ${x},${y}`);
  }
});

test('CIELAB: known colours, and a*, b* kept as Int8 within a unit', () => {
  const white = labOf([255, 255, 255]);
  assert.ok(Math.abs(white[0] - 100) < 1e-3 && Math.abs(white[1]) < 1e-3 && Math.abs(white[2]) < 1e-3, String(white));
  const red = labOf([255, 0, 0]);
  assert.ok(Math.abs(red[0] - 53.24) < 0.05 && Math.abs(red[1] - 80.09) < 0.1 && Math.abs(red[2] - 67.2) < 0.1, String(red));
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255, 120, 200, 40, 255]);
  const c = lab(rgba, 3, 1);
  assert.ok(c.a instanceof Int8Array && c.L instanceof Float32Array);
  for (let k = 0; k < 3; k++) {
    const want = labOf([...rgba.slice(k * 4, k * 4 + 3)]);
    assert.ok(Math.abs(c.L[k] - want[0]) < 1e-3 && Math.abs(c.a[k] - want[1]) <= 0.5 && Math.abs(c.b[k] - want[2]) <= 0.5, `${k}: ${[c.L[k], c.a[k], c.b[k]]} vs ${want}`);
  }
  assert.ok(Math.abs(lightness(rgba, 3, 1)[2] - c.L[2]) < 1e-4);
});

test('the exact distance transform agrees with brute force on an asymmetric scatter (not square)', () => {
  const r = rng(7), w = 37, h = 23, src = Uint8Array.from({ length: w * h }, () => (r() < 0.03 ? 1 : 0));
  const d = sqDistance(src, w, h);
  const pts = []; for (let i = 0; i < w * h; i++) if (src[i]) pts.push([i % w, (i / w) | 0]);
  assert.ok(pts.length > 5);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) assert.equal(d[y * w + x], Math.min(...pts.map(([a, b]) => (a - x) ** 2 + (b - y) ** 2)), `at ${x},${y}`);
});

test('the scanline fill is 4-connected for an area (a diagonal gap holds) and 8-connected for a line', () => {
  const w = 9, h = 7, m = new Uint8Array(w * h).fill(1);
  for (let k = 0; k < 7; k++) m[k * w + k + 1] = 0;   // a diagonal wall
  const four = floodFill(m, w, h, 0, 6), eight = floodFill(m, w, h, 0, 6, { eight: true });
  assert.ok(four.count < w * h - 7 && four.region[0 * w + 8] === 0, 'the 4-connected fill crossed a diagonal wall');
  assert.equal(eight.count, w * h - 7);
});

// ---- 1. An area: a hexagon -----------------------------------------------------------------------

const HEX = [[402.3, 118.6], [471.8, 160.1], [468.2, 251.7], [395.4, 286.9], [338.9, 233.2], [347.1, 152.4]];   // irregular, off-centre
function hexagon({ noisy = false } = {}) {
  const r = new Raster(W, H).polygon(HEX, [182, 72, 48]);
  if (noisy) { const g = rng(11); r.specks(g, 0.03, PAPER).specks(g, 0.03, INK).noise(g, 6).blocks(g, 4, 4); }
  return r;
}
function checkHexagon(res, tol) {
  const ring = res.rings[0];
  const hd = hausdorff(closedRing(ring), closedRing(HEX));
  const [cx, cy] = centroid(ring), [tx, ty] = centroid(HEX);
  const da = Math.abs(Math.abs(area(ring)) - Math.abs(area(HEX))) / Math.abs(area(HEX));
  assert.ok(hd <= 1 * tol, `Hausdorff ${hd.toFixed(3)} px`);
  assert.ok(Math.hypot(cx - tx, cy - ty) <= 0.25 * tol, `centroid off by ${Math.hypot(cx - tx, cy - ty).toFixed(3)} px (${(cx - tx).toFixed(3)}, ${(cy - ty).toFixed(3)})`);
  assert.ok(da <= 0.02 * tol, `area off by ${(da * 100).toFixed(2)}%`);
  assert.equal(res.rings.length, 1);
}
test('1. an irregular hexagon, filled: its outline within 1 px, its centroid within 0.25 px (corner convention), its area within 2%', () => {
  checkHexagon(traceArea(prepare(win(hexagon())), [420, 200], ONE), 1);
});
test('1. the same hexagon in a window placed in the image at scale 2: the outline lands in image pixels', () => {
  // A window whose working pixel (x, y) is image pixel (100 + 2x, 40 + 2y): the hexagon in image pixels.
  const res = traceArea(prepare(win(hexagon())), [420, 200], { x0: 100, y0: 40, s: 2 });
  const back = res.rings[0].map(([x, y]) => [(x - 100) / 2, (y - 40) / 2]);
  checkHexagon({ ...res, rings: [back] }, 1);
});

// ---- 2. A wash with a word in it ---------------------------------------------------------------

function wash() {
  const r = new Raster(W, H).disc(231.5, 268.5, 90, [168, 198, 224]);
  // The "word": two touching rings of ink, connected, inside the wash; and the map's linework about it
  // (a road and a border, the pen's stroke 3 px), by which the size of a hole that is only lettering is judged.
  r.ring(244, 252, 3, 3, INK); r.ring(250.5, 252, 3, 3, INK);
  r.stroke([[350, 40], [600, 120], [610, 400]], 3, INK); r.stroke([[20, 20], [300, 60]], 3, INK);
  return r;
}
test('2. a wash disc with a word in it: 0 holes with small holes dropped, 1 without; the area within 1%', () => {
  const prep = prepare(win(wash()));
  const dropped = traceArea(prep, [190, 300], ONE, { dropSmallHoles: true });
  const kept = traceArea(prep, [190, 300], ONE, { dropSmallHoles: false });
  assert.equal(dropped.rings.length, 1, 'holes left in');
  assert.equal(dropped.holes.dropped, 1);
  assert.equal(kept.rings.length, 2, 'the word is one hole');
  const want = Math.PI * 90 * 90, got = Math.abs(area(dropped.rings[0]));
  assert.ok(Math.abs(got - want) / want <= 0.01, `area ${got} against ${want}`);
  assert.ok(dropped.stroke >= 2.6 && dropped.stroke <= 3.4, `stroke ${dropped.stroke}`);
});

// ---- 3. A gap in an outline --------------------------------------------------------------------

test('3. an outline with a gap: the fill leaks and is refused; with gaps bridged it closes', () => {
  const r = new Raster(W, H).ring(372.5, 221.5, 80, 3, INK, { at: 0.7, width: 6 });
  const prep = prepare(win(r));
  assert.throws(() => traceArea(prep, [360, 240], ONE), (e) => e instanceof InkError && e.kind === 'leak');
  const res = traceArea(prep, [360, 240], ONE, { bridge: 8 });
  const want = Math.PI * 78.5 ** 2, got = Math.abs(area(res.rings[0]));
  assert.ok(Math.abs(got - want) / want <= 0.03, `area ${got} against ${want}`);
  const [cx, cy] = centroid(res.rings[0]);
  assert.ok(Math.hypot(cx - 372.5, cy - 221.5) <= 1, `centre ${cx}, ${cy}`);
});

// ---- 4. A line: a sine, crossed by a road, a line and text --------------------------------------

const SINE = Array.from({ length: 521 }, (_, k) => { const x = 60 + k; return [x, 241.5 + 60 * Math.sin((2 * Math.PI * (x - 60)) / 300)]; });
function sine({ noisy = false } = {}) {
  const r = new Raster(W, H);
  r.stroke(SINE, 3, INK);
  // A cased road across it (two thin lines), a thin line crossing it at a slant (an X), and text strokes.
  r.stroke([[300, 30], [342, 450]], 2, INK); r.stroke([[311, 30], [353, 450]], 2, INK);
  r.stroke([[150, 140], [230, 330]], 2.2, INK);
  for (const [x, y] of [[470, 0], [478, 0]]) { const yy = 241.5 + 60 * Math.sin((2 * Math.PI * (x - 60)) / 300); r.stroke([[x, yy - 11], [x + 3, yy + 11]], 2, INK); }
  r.stroke([[466, 160], [488, 160]], 2, INK);
  if (noisy) { const g = rng(5); r.specks(g, 0.03, PAPER).specks(g, 0.03, INK).noise(g, 6).blocks(g, 4, 4); }
  return r;
}
function checkSine(res, tol) {
  const hd = hausdorff(res.points, SINE);
  assert.ok(hd <= 1 * tol, `Hausdorff ${hd.toFixed(3)} px`);
  const [a, b] = [res.points[0], res.points.at(-1)].sort((p, q) => p[0] - q[0]);
  assert.ok(Math.hypot(a[0] - SINE[0][0], a[1] - SINE[0][1]) <= 2.5 && Math.hypot(b[0] - SINE.at(-1)[0], b[1] - SINE.at(-1)[1]) <= 2.5, `ends ${a} and ${b}`);
  // The mean offset (traced point minus its nearest point on the curve): no half pixel lost or added.
  let mx = 0, my = 0;
  for (const p of res.points) { const q = nearestOn(p, SINE); mx += p[0] - q[0]; my += p[1] - q[1]; }
  mx /= res.points.length; my /= res.points.length;
  assert.ok(Math.hypot(mx, my) <= 0.25 * tol, `mean offset (${mx.toFixed(3)}, ${my.toFixed(3)})`);
}
test('4. a sine\'s centreline from a click: within 1 px, both ends reached, the road never entered, straight through an X; mean offset within 0.25 px', () => {
  const res = traceLine(prepare(win(sine()), { colour: false }), [150, 241 + 60 * Math.sin((2 * Math.PI * 90) / 300)], ONE);
  checkSine(res, 1);
  assert.ok(!res.points.some((p) => distToPolyline(p, SINE) > 1.5), 'a point left the sine');
});

// ---- 5. Red and blue ---------------------------------------------------------------------------

test('5. red and blue: by colour the red line clicked is followed and the blue not entered; by darkness alone the two run on together (the control)', () => {
  const RED = [200, 30, 30], BLUE = [30, 60, 200];
  const r = new Raster(W, H);
  r.stroke([[60, 200.5], [320, 200.5]], 3, RED); r.stroke([[320, 200.5], [580, 200.5]], 3, BLUE);
  r.stroke([[207.5, 90], [212.5, 320]], 3, BLUE);   // blue across red
  const prep = prepare(win(r), { colour: true });
  const byColour = traceLine(prep, [120, 200], ONE, { colour: true });
  const xs = byColour.points.map((p) => p[0]);
  assert.ok(Math.min(...xs) <= 62 && Math.max(...xs) >= 316 && Math.max(...xs) <= 324, `red ran ${Math.min(...xs)}..${Math.max(...xs)}`);
  assert.ok(byColour.points.every((p) => Math.abs(p[1] - 201) <= 1.5), 'left the red line');
  assert.ok(byColour.gaps.length >= 1, 'the blue crossing was not jumped');
  const byDark = traceLine(prepare(win(r), { colour: false }), [120, 200], ONE);
  assert.ok(Math.max(...byDark.points.map((p) => p[0])) >= 570, 'by darkness the line should run on into the blue');
});

// ---- 6. Faint ink on a vignette ----------------------------------------------------------------

const DIAG = [[44, 66], [600, 414]];
function vignette() {
  const r = new Raster(W, H, [236, 230, 214]);
  // Darkened towards the corners, to about half at the far ones.
  r.each((c, x, y) => { const d = Math.hypot((x - 300) / 380, (y - 230) / 300); return c.map((v) => v * (1 - 0.48 * Math.min(1, d) ** 2)); });
  // Faint ink: each pixel a little darker than the paper under it.
  r.paint((x, y) => distToPolyline([x, y], DIAG) <= 1.5, (x, y, c) => c.map((v) => v * 0.8));
  return r;
}
test('6. faint ink on a vignette: one threshold for the window fails, Sauvola\'s adaptive threshold traces it', () => {
  const r = vignette(), prep = prepare(win(r), { colour: false });
  const seed = [320, 241];
  // The control: Otsu's global threshold. Under it the line is lost in the dark corners (its component
  // runs far off the line), or does not reach both ends.
  const g = globalMask(prep.L, W, H), comp = floodFill(g, W, H, seed[0], seed[1], { eight: true });
  let off = 0, reach = [Infinity, -Infinity];
  for (let i = 0; i < W * H; i++) if (comp.region[i]) { const p = [(i % W) + 0.5, ((i / W) | 0) + 0.5]; if (distToPolyline(p, DIAG) > 3) off++; else { reach[0] = Math.min(reach[0], p[0]); reach[1] = Math.max(reach[1], p[0]); } }
  assert.ok(off > 2000 || reach[0] > 50 || reach[1] < 594, `the global threshold should fail: ${off} pixels off the line, reaching ${reach}`);
  const res = traceLine(prep, seed, ONE);
  assert.ok(hausdorff(res.points, DIAG) <= 1, `Hausdorff ${hausdorff(res.points, DIAG)}`);
  // Sauvola's mask itself: the line, and little else touching it.
  const s = sauvolaMask(prep.L, W, H);
  assert.equal(s[241 * W + 320] || s[241 * W + 321] || s[240 * W + 320], 1);
});

// ---- 7. Noise and JPEG blocks ------------------------------------------------------------------

test('7. specks, noise and JPEG-like blocks: the hexagon and the sine pass at 1.5× the tolerances', () => {
  checkHexagon(traceArea(prepare(win(hexagon({ noisy: true }))), [420, 200], ONE), 1.5);
  checkSine(traceLine(prepare(win(sine({ noisy: true })), { colour: false }), [150, 241 + 60 * Math.sin((2 * Math.PI * 90) / 300)], ONE), 1.5);
});

// ---- 8. Zhang–Suen and the graph ---------------------------------------------------------------

const maskOf = (r) => { const m = new Uint8Array(r.w * r.h); for (let i = 0; i < m.length; i++) m[i] = r.rgba[i * 4] < 128 ? 1 : 0; return m; };
test('8. thinning: a bar gives one chain between two ends; a plus sign gives one node of degree 4 (its cluster of junction pixels merged)', () => {
  const bar = new Raster(90, 40).paint((x, y) => x > 13 && x < 74 && y > 17 && y < 25, INK);
  const sb = zhangSuen(maskOf(bar), 90, 40), gb = skeletonGraph(sb, 90, 40);
  assert.equal(gb.chains.filter((c) => !c.removed).length, 1);
  assert.deepEqual(gb.nodes.map((n) => n.chains.length).sort(), [1, 1]);
  const plus = new Raster(80, 70).paint((x, y) => (x > 9 && x < 70 && y > 31 && y < 39) || (x > 36 && x < 44 && y > 4 && y < 66), INK);
  const sp = zhangSuen(maskOf(plus), 80, 70), gp = skeletonGraph(sp, 80, 70);
  const degrees = gp.nodes.map((n) => live(gp, n.id).length).sort();
  assert.deepEqual(degrees, [1, 1, 1, 1, 4], `degrees ${degrees}`);
  // Why the merging is needed: Zhang–Suen leaves more than one junction pixel at the crossing.
  const deg = (i) => { const x = i % 80, y = (i / 80) | 0; let n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && sp[(y + dy) * 80 + x + dx]) n++; return n; };
  const junctionPx = [...sp.keys()].filter((i) => sp[i] && deg(i) >= 3);
  assert.ok(junctionPx.length > 1 && MERGE_PX === 2, `junction pixels: ${junctionPx.length}`);
});

// ---- 9. Douglas–Peucker ------------------------------------------------------------------------

test('9. Douglas–Peucker: every point within ε of what is kept; a zigzag that plain Douglas–Peucker makes cross itself does not cross', () => {
  const r = rng(3), pts = [[0, 0]];
  for (let k = 1; k < 400; k++) pts.push([pts[k - 1][0] + 1 + r(), pts[k - 1][1] + (r() - 0.5) * 3]);
  for (const eps of [0.75, 2, 5]) {
    const s = douglasPeucker(pts, eps);
    assert.ok(s.length < pts.length);
    for (const p of pts) assert.ok(distToPolyline(p, s) <= eps + 1e-9, `a point is ${distToPolyline(p, s)} off at ε ${eps}`);
  }
  // A zigzag that crosses itself once simplified at 0.75: found by search, from a seed.
  const g = rng(42);
  let found = null;
  for (let tries = 0; tries < 20000 && !found; tries++) {
    const z = [[0, 0]];
    for (let k = 1; k < 12; k++) z.push([z[k - 1][0] + (g() - 0.5) * 4, z[k - 1][1] + (g() - 0.5) * 4]);
    if (!selfIntersects([{ pts: z, closed: false }]) && selfIntersects([{ pts: douglasPeucker(z, 0.75), closed: false }])) found = z;
  }
  assert.ok(found, 'no zigzag found that plain Douglas–Peucker makes cross itself');
  const out = simplifyAll([{ pts: found, closed: false }], 0.75);
  assert.ok(!selfIntersects(out.paths), 'still crosses itself');
  assert.ok(out.epsilon < 0.75 && out.epsilon >= 0.1, `ε ${out.epsilon}`);
  for (const p of found) assert.ok(distToPolyline(p, out.paths[0].pts) <= out.epsilon + 1e-9);
});

// ---- 10. Tiles at an odd size: the seam --------------------------------------------------------

// A 1001 × 701 image served as a IIIF level-1 server would serve it: each tile its region, averaged down
// to the size asked for (so an edge tile's scale is not exactly its scale factor).
function serve(img, { region, size }) {
  const data = new Uint8ClampedArray(size.width * size.height * 4);
  const kx = region.width / size.width, ky = region.height / size.height;
  for (let v = 0; v < size.height; v++) for (let u = 0; u < size.width; u++) {
    const ax = region.x + u * kx, bx = ax + kx, ay = region.y + v * ky, by = ay + ky;
    const acc = [0, 0, 0, 0]; let wsum = 0;
    for (let y = Math.floor(ay); y < Math.ceil(by); y++) for (let x = Math.floor(ax); x < Math.ceil(bx); x++) {
      const wgt = (Math.min(bx, x + 1) - Math.max(ax, x)) * (Math.min(by, y + 1) - Math.max(ay, y));
      if (wgt <= 0) continue;
      const o = (y * img.w + x) * 4; for (let k = 0; k < 4; k++) acc[k] += img.rgba[o + k] * wgt; wsum += wgt;
    }
    for (let k = 0; k < 4; k++) data[(v * size.width + u) * 4 + k] = acc[k] / wsum;
  }
  return { region, width: size.width, height: size.height, data };
}
const ODD = { '@context': 'http://iiif.io/api/image/3/context.json', id: 'https://iiif.example.org/iiif/odd', type: 'ImageService3', protocol: 'http://iiif.io/api/image', profile: 'level1', width: 1001, height: 701, tiles: [{ width: 256, scaleFactors: [1, 2, 4] }] };
const ODD_LINE = [[611.5, 151.5], [1000, 690]];   // crosses the seam between the edge tiles at scale 2 (x and y 512)
const ODD_SHAPE = [[452, 431], [571, 389], [688, 452], [697, 588], [580, 664], [463, 602]];   // across both seams (512)
function oddImage() { return new Raster(1001, 701).stroke(ODD_LINE, 6, INK).polygon(ODD_SHAPE, [182, 72, 48]); }

test('10. tiles at scale factor 2 of a 1001 × 701 image: each edge tile scaled by its own region and size; traced across the seam, the same as from one image of the whole, to 0.5 px', () => {
  const img = oddImage(), image = Image.parse(ODD);
  const frame = frameAround(image, [700, 500], 2);
  assert.deepEqual([frame.w, frame.h], [501, 351], 'the window is the whole image at 1/2');
  const tiles = tilesFor(image, frame);
  assert.equal(tiles.length, 4);
  const edge = tiles.find((t) => t.region.x === 512 && t.region.y === 512);
  assert.deepEqual([edge.region.width, edge.region.height, edge.size.width, edge.size.height], [489, 189, 245, 95]);
  assert.equal(edge.url, 'https://iiif.example.org/iiif/odd/512,512,489,189/245,95/0/default.jpg');
  const fromTiles = compose(frame, tiles.map((t) => serve(img, t)));
  const whole = compose(frame, [serve(img, { region: { x: 0, y: 0, width: 1001, height: 701 }, size: { width: 501, height: 351 } })]);
  assert.equal(fromTiles.covered, 1); assert.equal(whole.covered, 1);
  const lineA = traceLine(prepare({ w: frame.w, h: frame.h, rgba: fromTiles.rgba }, { colour: false }), [(805 - 0) / 2, (420 - 0) / 2], frame);
  const lineB = traceLine(prepare({ w: frame.w, h: frame.h, rgba: whole.rgba }, { colour: false }), [(805 - 0) / 2, (420 - 0) / 2], frame);
  const hl = hausdorff(lineA.points, lineB.points);
  assert.ok(hl <= 1, `line: ${hl} image px (0.5 working px)`);
  assert.ok(hausdorff(lineA.points, ODD_LINE) <= 2.5, `line against the truth: ${hausdorff(lineA.points, ODD_LINE)}`);
  const areaA = traceArea(prepare({ w: frame.w, h: frame.h, rgba: fromTiles.rgba }), [287, 260], frame);
  const areaB = traceArea(prepare({ w: frame.w, h: frame.h, rgba: whole.rgba }), [287, 260], frame);
  const ha = hausdorff(closedRing(areaA.rings[0]), closedRing(areaB.rings[0]));
  assert.ok(ha <= 1, `area: ${ha} image px (0.5 working px)`);
  assert.ok(hausdorff(closedRing(areaA.rings[0]), closedRing(ODD_SHAPE)) <= 2, 'the area against the truth');
});

test('10. compose: a tile whose bitmap is not its region at scale s is read at its own scale, not at s (the control: read at s, its far edge is off)', () => {
  // A tile of region 0..489 across given as 246 pixels (a server rounding up), with a marker column at
  // image x 480..481. At s = 2 the marker belongs at working x 240.
  const region = { x: 0, y: 0, width: 489, height: 10 };
  const bw = 246, data = new Uint8ClampedArray(bw * 5 * 4).fill(255);
  for (let v = 0; v < 5; v++) { const u = Math.floor((480.5 * bw) / 489); data.set([0, 0, 0, 255], (v * bw + u) * 4); }
  const frame = { x0: 0, y0: 0, s: 2, w: 245, h: 5 };
  const right = compose(frame, [{ region, width: bw, height: 5, data }]).rgba;
  const darkAt = (rgba) => { let best = -1, v = 256; for (let i = 0; i < 245; i++) if (rgba[(2 * 245 + i) * 4] < v) { v = rgba[(2 * 245 + i) * 4]; best = i; } return best; };
  assert.equal(darkAt(right), 240);
  // Read as if the bitmap were at scale 2 exactly (region.width taken as 2 × 246): the marker moves.
  const wrong = compose(frame, [{ region: { ...region, width: 2 * bw }, width: bw, height: 5, data }]).rgba;
  assert.notEqual(darkAt(wrong), 240);
});

test('10. the scale read at, the window and its growth: the smallest offered at least half the image pixels per screen pixel; at most 2048 each way', () => {
  const image = Image.parse({ ...ODD, width: 20001, height: 15001, tiles: [{ width: 512, scaleFactors: [1, 2, 4, 8, 16] }] });
  assert.equal(chooseScale(image, 1), 1); assert.equal(chooseScale(image, 2.5), 2); assert.equal(chooseScale(image, 5), 4); assert.equal(chooseScale(image, 1000), 16);
  let f = frameAround(image, [15000, 3000], 4);
  assert.deepEqual([f.w, f.h, f.s], [WINDOW, WINDOW, 4]);
  assert.ok(f.x0 % 4 === 0 && f.y0 % 4 === 0);
  const sizes = [];
  while (f) { sizes.push(f.w); f = grow(image, f); }
  assert.deepEqual(sizes, [512, 1024, 2048]);
  assert.equal(MAX_WINDOW, 2048);
  // Near the image's edge the window stays on the image.
  const e = frameAround(image, [19990, 14990], 4);
  assert.ok(e.x0 + e.w * 4 <= Math.ceil(20001 / 4) * 4 && e.x0 >= 0);
});

// ---- 11. Snapping ------------------------------------------------------------------------------

test('11. snapping: a point near a line snaps onto its centre, to 0.5 px; nothing beyond the radius', () => {
  const LINE = [[40.5, 300.5], [620.5, 120.5]];
  const r = new Raster(W, H).stroke(LINE, 3, INK);
  const prep = prepare(win(r), { colour: false });
  const { ridges } = snapPixels(prep, ONE);
  assert.ok(ridges.length > 2 * 500);
  // The screen is the image here (one to one); the world is the image too, for the test.
  const index = binPoints(ridges, ridges);
  const at = [300, 300 - (180 * 260) / 580 - 6];   // 6 px above the line
  const hit = nearest(index, at[0], at[1]);
  assert.ok(hit, 'nothing found within the radius');
  assert.ok(distToPolyline(hit.lngLat, LINE) <= 0.5, `snapped ${distToPolyline(hit.lngLat, LINE)} px from the centre`);
  assert.equal(nearest(index, 300, 100), null);
});

test('the stroke width of the dark ink is measured (the hole threshold\'s scale)', () => {
  const r = new Raster(W, H); r.stroke([[100, 100], [500, 380]], 3, INK); r.stroke([[100, 380], [500, 100]], 3, INK); r.disc(320, 120, 30, INK);
  const sw = strokeWidth(prepare(win(r)));
  assert.ok(sw >= 2.6 && sw <= 3.4, `stroke ${sw}`);
});
