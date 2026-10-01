// Assisted ink tracing: each rule of the engine (src/engine/chora/ink/) pinned by a case where the rule
// changes the answer, beside a control where it does not, so that the rule changed (a constant moved, a
// guard taken out) fails a test. The numbers each rule is pinned between are said with it. Synthetic
// maps from test/ink-synth.js, as test/chora-ink.test.js has them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Image } from '@allmaps/iiif-parser';
import { Raster, PAPER, INK, distToPolyline, area, densify } from './ink-synth.js';
import { prepare, traceArea, traceLine, InkError } from '../src/engine/chora/ink/index.js';
import { outline } from '../src/engine/chora/ink/contour.js';
import { frameAround, grow } from '../src/engine/chora/ink/window.js';
import { snapPixels, binPoints, nearestInk } from '../src/engine/chora/ink/snap.js';
import { runTrace } from '../src/engine/chora/ink/job.js';
import { localSteps, traceStep, createPrepCache } from '../src/engine/chora/ink/step.js';

const W = 640, H = 480, ONE = { x0: 0, y0: 0, s: 1 };
const win = (r) => ({ w: r.w, h: r.h, rgba: r.rgba });
const WASH = [182, 72, 48];
const xs = (res) => res.points.map((p) => p[0]);

// ---- Filling: the leak guard ---------------------------------------------------------------------

test('leak: a fill covering more than 60% of the window is refused as escaped; one covering 55% is not (LEAK_SHARE between them)', () => {
  // A square wash, closed, well inside the window (not touching its edge), of a chosen share of it.
  const share = (s) => { const side = Math.sqrt(s * W * H), x0 = (W - side) / 2, y0 = (H - side) / 2; return new Raster(W, H).paint((x, y) => x >= x0 && x < x0 + side && y >= y0 && y < y0 + side, WASH); };
  const ok = traceArea(prepare(win(share(0.55))), [320, 240], ONE);
  assert.ok(ok.share > 0.53 && ok.share < 0.57, `share ${ok.share}`);
  assert.throws(() => traceArea(prepare(win(share(0.65))), [320, 240], ONE), (e) => e instanceof InkError && e.kind === 'leak' && e.reason === 'share');
});

test('leak: a fill with gaps bridged that reaches the window\'s edge is refused as escaped; the same fill clear of the edge is not', () => {
  // A wash 30% of the window, against its left edge (an area the window cuts), and the same moved in.
  const at = (x0) => new Raster(W, H).paint((x, y) => x >= x0 && x < x0 + 200 && y >= 100 && y < 330, WASH);
  const clear = traceArea(prepare(win(at(40))), [140, 200], ONE, { bridge: 4 });
  assert.ok(clear.rings.length >= 1 && clear.share < 0.6);
  assert.throws(() => traceArea(prepare(win(at(0))), [100, 200], ONE, { bridge: 4 }), (e) => e instanceof InkError && e.kind === 'leak' && e.reason === 'edge');
});

// ---- Following a line: turns and jumps -------------------------------------------------------------

test('follow: at a junction a branch turning 40° is taken, and the line stops where every branch turns 90° (MAX_TURN, 60°, between)', () => {
  // A stem from the left into a junction at (320, 240); a Y (branches ±40°), and a T (branches ±90°).
  const stem = [[80, 240.5], [320, 240.5]];
  const branch = (deg, sign, len = 200) => [[320, 240.5], [320 + len * Math.cos((deg * Math.PI) / 180), 240.5 + sign * len * Math.sin((deg * Math.PI) / 180)]];
  const y = new Raster(W, H).stroke(stem, 4, INK).stroke(branch(40, 1), 4, INK).stroke(branch(40, -1), 4, INK);
  const ry = traceLine(prepare(win(y), { colour: false }), [150, 240], ONE);
  assert.ok(Math.max(...xs(ry)) > 450, `the Y: ran to x ${Math.max(...xs(ry))}`);
  const t = new Raster(W, H).stroke(stem, 4, INK).stroke([[320.5, 60], [320.5, 420]], 4, INK);
  const rt = traceLine(prepare(win(t), { colour: false }), [150, 240], ONE);
  assert.ok(Math.max(...xs(rt)) <= 330 && Math.max(...rt.points.map((p) => Math.abs(p[1] - 240.5))) <= 6, `the T: ran to x ${Math.max(...xs(rt))}, ${Math.max(...rt.points.map((p) => Math.abs(p[1] - 240.5)))} off the stem`);
  assert.equal(rt.ends.filter((e) => e === 'turn').length, 1, `ends ${rt.ends}`);
});

test('jumps: a gap of 1.2 widths in a line is jumped and one of 2.8 is not (JUMP_REACH, 3 widths from the skeleton\'s end, between); with jumps off neither is', () => {
  const w = 4, line = (gap) => new Raster(W, H).stroke([[60, 240.5], [300, 240.5]], w, INK, { cap: 'flat' }).stroke([[300 + gap * w, 240.5], [580, 240.5]], w, INK, { cap: 'flat' });
  const near = traceLine(prepare(win(line(1.2)), { colour: false }), [150, 240], ONE);
  assert.ok(near.gaps.length === 1 && Math.max(...xs(near)) > 570, `1.2 widths: gaps ${near.gaps.length}, to x ${Math.max(...xs(near))}`);
  const far = traceLine(prepare(win(line(2.8)), { colour: false }), [150, 240], ONE);
  assert.ok(far.gaps.length === 0 && Math.max(...xs(far)) < 305, `2.8 widths: gaps ${far.gaps.length}, to x ${Math.max(...xs(far))}`);
  const off = traceLine(prepare(win(line(1.2)), { colour: false }), [150, 240], ONE, { jumps: false });
  assert.ok(off.gaps.length === 0 && Math.max(...xs(off)) < 305);
});

test('jumps: a line ahead 5° off the way the line runs is jumped to; one 40° off it, as near, is not (JUMP_CONE, ±20°, between)', () => {
  // The second line runs on from 3 px past the first's end (its skeleton's end within reach), along a ray from
  // that end at the angle given.
  const w = 4, end = [300, 240.5];
  const scene = (deg) => {
    const a = (deg * Math.PI) / 180, from = [end[0] + 3 * Math.cos(a), end[1] - 3 * Math.sin(a)], to = [from[0] + 260 * Math.cos(a), from[1] - 260 * Math.sin(a)];
    return new Raster(W, H).stroke([[60, 240.5], end], w, INK, { cap: 'flat' }).stroke([from, to], w, INK, { cap: 'flat' });
  };
  const inside = traceLine(prepare(win(scene(5)), { colour: false }), [150, 240], ONE);
  assert.ok(inside.gaps.length === 1 && Math.max(...xs(inside)) > 500, `5°: gaps ${inside.gaps.length}, to x ${Math.max(...xs(inside))}`);
  const outside = traceLine(prepare(win(scene(40)), { colour: false }), [150, 240], ONE);
  assert.ok(outside.gaps.length === 0 && Math.max(...xs(outside)) < 305, `40°: gaps ${outside.gaps.length}, to x ${Math.max(...xs(outside))}`);
});

test('the thickness band: a road four times as thick across the line is not followed into, and cuts the line there; one as thick is crossed', () => {
  const stem = [[60, 240.5], [580, 240.5]];
  const thick = new Raster(W, H).stroke(stem, 3, INK).stroke([[320.5, 40], [320.5, 440]], 12, INK);
  const rt = traceLine(prepare(win(thick), { colour: false }), [150, 240], ONE);
  // The road (12 px wide about x 320.5) begins at x 314: the line ends there, and no point of it lies beyond its end.
  const last = rt.points.reduce((a, p) => (p[0] > a[0] ? p : a));
  const end = [rt.points[0], rt.points.at(-1)].reduce((a, p) => (p[0] > a[0] ? p : a));
  assert.ok(Math.abs(end[0] - 314) <= 0.5 && last === end, `ends at x ${end[0]}, its farthest point at x ${last[0]} (the road's edge is at 314)`);
  assert.ok(rt.points.every((p) => Math.abs(p[1] - 240.5) <= 2), 'went into the road');
  // The control: a crossing line as thick as it is crossed, straight on.
  const thin = new Raster(W, H).stroke(stem, 3, INK).stroke([[320.5, 40], [320.5, 440]], 3, INK);
  const rn = traceLine(prepare(win(thin), { colour: false }), [150, 240], ONE);
  assert.ok(Math.max(...xs(rn)) > 570, `the thin crossing: ran to x ${Math.max(...xs(rn))}`);
});

test('spurs: a line bending 50° where a burr a width or so long carries straight on is followed round the bend (the burr pruned), not into the burr', () => {
  const a = (50 * Math.PI) / 180, bend = [320, 240.5], end = [320 + 220 * Math.cos(a), 240.5 + 220 * Math.sin(a)];
  for (const stub of [1, 1.5]) {
    const w = 6, r = new Raster(W, H).stroke([[60, 240.5], bend, end], w, INK).stroke([bend, [320 + stub * w + w / 2, 240.5]], w, INK);
    const res = traceLine(prepare(win(r), { colour: false }), [150, 240], ONE);
    assert.ok(Math.max(...xs(res)) > 455 && res.points.every((p) => distToPolyline(p, [[60, 240.5], bend, end]) <= 2.5), `burr ${stub} widths: ran to x ${Math.max(...xs(res))}`);
  }
});

test('junctions: where a branch leaves the line at 25° to 35°, the line is not drawn aside towards the branch\'s ink (no refinement near a junction), to 0.25 px', () => {
  // Simplified within 0.1 px, so that a point drawn aside is kept; the traced line densified, so that a
  // stretch with no vertex in it is measured too.
  for (const [deg, w] of [[25, 4], [30, 3], [30, 4], [35, 3]]) {
    const a = (deg * Math.PI) / 180, c = [320, 240.5], line = [[60, 240.5], [580, 240.5]];
    const r = new Raster(W, H).stroke(line, w, INK).stroke([c, [c[0] + 260 * Math.cos(a), c[1] - 260 * Math.sin(a)]], w, INK);
    const res = traceLine(prepare(win(r), { colour: false }), [130, 240], ONE, { detail: 0.1 });
    const near = densify(res.points).filter((p) => p[0] >= 300 && p[0] <= 360);
    assert.ok(near.length > 50, `the fork's stretch measured: ${near.length} points`);
    const worst = Math.max(...near.map((p) => distToPolyline(p, line)));
    assert.ok(worst <= 0.25 && Math.max(...xs(res)) > 575, `${deg}°, width ${w}: ${worst.toFixed(2)} px aside at the fork, to x ${Math.max(...xs(res))}`);
  }
});

test('the cache of windows made ready keeps none whose tiles have no address (it could not tell one map\'s from another\'s)', () => {
  const frame = { x0: 0, y0: 0, s: 1, w: 64, h: 48 }, data = new Uint8ClampedArray(64 * 48 * 4).fill(230);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const tile = { region: { x: 0, y: 0, width: 64, height: 48 }, width: 64, height: 48, data };
  const cache = createPrepCache(), made = (tiles) => { try { return traceStep({ frame, tiles, seed: [30, 20], mode: 'area', params: {} }, cache).timing.made; } catch (e) { return e.timing.made; } };
  assert.equal(made([tile]), true); assert.equal(made([tile]), true, 'kept with no address');
  // The control: with an address, the second is not made again.
  const addressed = { ...tile, url: 'https://iiif.example.org/iiif/a/0,0,64,48/64,/0/default.jpg' };
  assert.equal(made([addressed]), true); assert.equal(made([addressed]), false);
});

// ---- Outlines --------------------------------------------------------------------------------------

test('outline: of two pieces, the one under the click is outlined, not the larger', () => {
  const w = 60, h = 40, region = new Uint8Array(w * h);
  for (let y = 5; y < 35; y++) for (let x = 5; x < 35; x++) region[y * w + x] = 1;   // the larger
  for (let y = 10; y < 20; y++) for (let x = 45; x < 55; x++) region[y * w + x] = 1;  // the smaller
  const small = outline(region, w, [0, 0, w - 1, h - 1], [50.5, 15.5]);
  // (Marching squares cuts each corner by an eighth of a pixel.)
  assert.ok(Math.abs(Math.abs(area(small.outer)) - 100) <= 1, `the smaller: ${area(small.outer)}`);
  const big = outline(region, w, [0, 0, w - 1, h - 1], [20.5, 20.5]);
  assert.ok(Math.abs(Math.abs(area(big.outer)) - 900) <= 1, `the larger: ${area(big.outer)}`);
});

test('holes: one of 16 × 16 px in a wash whose linework is 3 px is kept, one of 10 × 10 is dropped as lettering ((4 × the stroke)², 144 px², between)', () => {
  const r = new Raster(W, H).disc(300.5, 240.5, 160, WASH);
  r.paint((x, y) => x >= 240 && x < 256 && y >= 200 && y < 216, PAPER);   // 16 × 16
  r.paint((x, y) => x >= 340 && x < 350 && y >= 260 && y < 270, PAPER);   // 10 × 10
  r.stroke([[20, 20], [620, 30]], 3, INK).stroke([[20, 460], [620, 450]], 3, INK).stroke([[620, 50], [630, 430]], 3, INK);
  const res = traceArea(prepare(win(r)), [300, 300], ONE);
  assert.ok(res.stroke >= 2.5 && res.stroke <= 3.5, `stroke ${res.stroke}`);
  assert.deepEqual(res.holes, { kept: 1, dropped: 1 });
  assert.ok(Math.abs(Math.abs(area(res.rings[1])) - 256) <= 16, `the hole kept: ${area(res.rings[1])}`);
});

// ---- Simplifying: ε in pixels of the image read ----------------------------------------------------

test('ε: "simplify within" is in pixels of the image read, so a window read at 1/4 is simplified within 4 image pixels, giving the same shape as at 1/1 (area and line)', () => {
  const r = new Raster(W, H).polygon([[402.3, 118.6], [471.8, 160.1], [468.2, 251.7], [395.4, 286.9], [338.9, 233.2], [347.1, 152.4]], WASH)
    .stroke(Array.from({ length: 300 }, (_, k) => [60 + k, 380 + 30 * Math.sin(k / 40)]), 3, INK);
  const prep = prepare(win(r)), prepL = prepare(win(r), { colour: false });
  for (const detail of [0.75, 2]) {
    const a1 = traceArea(prep, [420, 200], ONE, { detail }), a4 = traceArea(prep, [420, 200], { x0: 0, y0: 0, s: 4 }, { detail });
    assert.equal(a4.epsilon, 4 * a1.epsilon, `area ε at 1/4 ${a4.epsilon}, at 1/1 ${a1.epsilon}`);
    assert.equal(a4.rings[0].length, a1.rings[0].length, `area vertices at 1/4 ${a4.rings[0].length}, at 1/1 ${a1.rings[0].length}`);
    const l1 = traceLine(prepL, [200, 380 + 30 * Math.sin(140 / 40)], ONE, { detail }), l4 = traceLine(prepL, [200, 380 + 30 * Math.sin(140 / 40)], { x0: 0, y0: 0, s: 4 }, { detail });
    assert.equal(l4.epsilon, 4 * l1.epsilon);
    assert.equal(l4.points.length, l1.points.length, `line vertices at 1/4 ${l4.points.length}, at 1/1 ${l1.points.length}`);
  }
});

// ---- The window and the click --------------------------------------------------------------------

test('the window grows about its centre (the click), not its corner', () => {
  const image = Image.parse({ '@context': 'http://iiif.io/api/image/3/context.json', id: 'https://iiif.example.org/iiif/big', type: 'ImageService3', protocol: 'http://iiif.io/api/image', profile: 'level1', width: 20001, height: 15001, tiles: [{ width: 512, scaleFactors: [1, 2, 4] }] });
  const f = frameAround(image, [9000, 7000], 2), g = grow(image, f);
  const centre = (q) => [q.x0 + (q.w * q.s) / 2, q.y0 + (q.h * q.s) / 2];
  assert.deepEqual([g.w, g.h], [2 * f.w, 2 * f.h]);
  const [a, b] = [centre(f), centre(g)];
  assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) <= f.s, `centre moved from ${a} to ${b}`);
});

test('a line\'s click reaches the ink within six screen pixels, however many image pixels those are: 20 image px off at 4 per screen pixel finds the line, 34 does not', async () => {
  const info = { '@context': 'http://iiif.io/api/image/3/context.json', id: 'https://iiif.example.org/iiif/reach', type: 'ImageService3', protocol: 'http://iiif.io/api/image', profile: 'level1', width: 1001, height: 701, tiles: [{ width: 256, scaleFactors: [1, 2, 4] }] };
  const img = new Raster(1001, 701).stroke([[100, 350.5], [900, 350.5]], 6, INK);
  const serve = ({ region, size }) => {
    const data = new Uint8ClampedArray(size.width * size.height * 4), kx = region.width / size.width, ky = region.height / size.height;
    for (let v = 0; v < size.height; v++) for (let u = 0; u < size.width; u++) { const x = Math.min(1000, Math.floor(region.x + (u + 0.5) * kx)), y = Math.min(700, Math.floor(region.y + (v + 0.5) * ky)); data.set(img.rgba.subarray((y * 1001 + x) * 4, (y * 1001 + x) * 4 + 4), (v * size.width + u) * 4); }
    return { region, width: size.width, height: size.height, data };
  };
  const step = localSteps(async (ts) => ts.map(serve)).trace;
  // Four image pixels to a screen pixel: read at 1/2, so six screen pixels are 24 image pixels, 12 working.
  // The line's ink, read at 1/2, is working rows 173 to 176; 20 image px above its centre is row 165 (8 rows
  // from the ink: within 12, not within 6), and 34 is row 158 (15 rows: beyond 12).
  const res = await runTrace({ info, seedImg: [500, 350.5 - 20], mode: 'line', pxPerScreen: 4, step });
  assert.equal(res.scale, 2);
  assert.ok(Math.max(...res.points.map((p) => distToPolyline(p, [[100, 350.5], [900, 350.5]]))) <= 2 && Math.max(...xs(res)) > 850);
  await assert.rejects(runTrace({ info, seedImg: [500, 350.5 - 34], mode: 'line', pxPerScreen: 4, step }), (e) => e instanceof InkError && e.kind === 'empty');
});

// ---- Snapping: edges, and a ridge before an edge ---------------------------------------------------

test('snapping: a point near the edge of a wash (no line there) snaps onto the edge, to 0.5 px; near a line beside a wash, onto the line\'s centre though the edge is nearer', () => {
  // A wash with no outline, from x 300 on; a road 3 px wide along y 100.5, 4 px above a wash whose top edge is at y 106.
  const r = new Raster(W, H).paint((x, y) => x >= 300 && y >= 106, [150, 60, 40]).stroke([[20, 100.5], [620, 100.5]], 3, INK);
  const { ridges, edges } = snapPixels(prepare(win(r), { colour: false }), ONE);
  const index = { ridges: binPoints(ridges, ridges), edges: binPoints(edges, edges) };
  // At (200, 300): 100 px left of the wash's left edge (x 300) is out of reach; at (295, 300), 5 px from it.
  assert.equal(nearestInk(index, 200, 300), null);
  // 2 px and 5 px outside it: onto the edge. (A dark wash is darker than the paper about it, so Sauvola's
  // threshold marks a band of it along its edge as ink; that band is not a line, and has no ridge to win.)
  for (const x of [298, 295]) {
    const e = nearestInk(index, x, 300);
    assert.ok(e && Math.abs(e.lngLat[0] - 300) <= 0.5 && Math.abs(e.lngLat[1] - 300) <= 1, `the edge, from ${x}: ${e && e.lngLat}`);
  }
  // Inside the wash, 4 px from its edge: onto the edge too.
  const inside = nearestInk(index, 304, 300);
  assert.ok(inside && Math.abs(inside.lngLat[0] - 300) <= 0.5, `the edge, from inside: ${inside && inside.lngLat}`);
  // At (400, 106.5): the wash's top edge 0.5 px away, the road's centre 6 away: the road.
  const both = nearestInk(index, 400, 106.5);
  assert.ok(both && Math.abs(both.lngLat[1] - 100.5) <= 0.5, `ridge before edge: ${both && both.lngLat}`);
  // The control: the edges alone would have given the edge.
  const edgeOnly = nearestInk({ ridges: binPoints(new Float64Array(0), new Float64Array(0)), edges: index.edges }, 400, 106.5);
  assert.ok(edgeOnly && Math.abs(edgeOnly.lngLat[1] - 106) <= 1, `edges alone: ${edgeOnly && edgeOnly.lngLat}`);
});
