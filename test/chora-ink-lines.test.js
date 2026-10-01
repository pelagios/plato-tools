// Assisted ink tracing: a line's ends, burrs off it and narrow forks in it, on lines at seeded slants in a
// window that is not square (700 × 460), off-centre, each case asymmetric (a burr on one side, a branch to one
// side), so that the answer is not one a pixel grid's symmetry gives for free. Synthetic maps from
// test/ink-synth.js, as test/chora-ink.test.js has them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Raster, INK, distToPolyline, densify, slantedLines, unit, lerp } from './ink-synth.js';
import { prepare, traceLine } from '../src/engine/chora/ink/index.js';

const W = 700, H = 460, ONE = { x0: 0, y0: 0, s: 1 };
const SLANTS = slantedLines(31, 6, W, H);
const trace = (r, seed, params = {}) => traceLine(prepare({ w: W, h: H, rgba: r.rgba }, { colour: false }), seed, ONE, params);
const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
// The trace's ends matched to the line's two end points (either way round).
const endErrors = (res, [a, b]) => {
  const g = [res.points[0], res.points.at(-1)], [p, q] = d(g[0], a) <= d(g[0], b) ? g : [g[1], g[0]];
  return [d(p, a), d(q, b)];
};
// A short stroke off one side of a line at point p (a burr, a serif): `len` widths out from the centreline.
const burr = (r, p, u, side, width, len) => {
  const n = [-u[1] * side, u[0] * side];
  return r.stroke([p, [p[0] + n[0] * width * len + u[0] * 1.3, p[1] + n[1] * width * len + u[1] * 1.3]], Math.max(2, 0.6 * width), INK);
};

test('a line\'s ends on a slant: round ends at widths 3 to 14 to 0.5 px, flat ends at widths 8 to 14 to 0.5 px (six seeded slants); a round end along pixels\' edges is not taken for flat', () => {
  for (const [cap, widths] of [['round', [3, 4, 5, 6, 8, 10, 14]], ['flat', [8, 10, 14]]]) for (const width of widths) {
    for (const [line, seed] of SLANTS) {
      const e = Math.max(...endErrors(trace(new Raster(W, H).stroke(line, width, INK, { cap }), seed), line));
      assert.ok(e <= 0.5, `${cap}, width ${width}, from (${line[0].map((v) => v.toFixed(1))}): an end off by ${e.toFixed(2)} px`);
    }
  }
  // A round end on a line along pixels' edges (its cap drawn square to the pixels, filling the end's full width
  // as a flat end does) is still placed as round: the flat cap fits its pixels worse.
  for (const width of [6, 10]) for (const line of [[[110, 200], [530.3, 200]], [[250, 40.2], [250, 401]]]) {
    const e = Math.max(...endErrors(trace(new Raster(W, H).stroke(line, width, INK), lerp(line[0], line[1], 0.45)), line));
    assert.ok(e <= 0.5, `round, width ${width}, along pixels' edges from (${line[0]}): an end off by ${e.toFixed(2)} px`);
  }
});

test('a burr near a line\'s end (0.5 to 1.5 widths from it, on either side) is not followed: the end stays on the line, to 1 px, and within 1.25 px of where the ink ends', () => {
  for (const width of [3, 5, 6]) for (const [[a, b], seed] of SLANTS.slice(0, 4)) for (const at of [0.5, 1, 1.5]) for (const side of [1, -1]) {
    const u = unit(a, b), p = [b[0] - u[0] * at * width, b[1] - u[1] * at * width];
    const res = trace(burr(new Raster(W, H).stroke([a, b], width, INK), p, u, side, width, 1.3), seed);
    const e = [res.points[0], res.points.at(-1)].reduce((x, q) => (d(q, b) < d(x, b) ? q : x));
    const where = `width ${width}, ${at} widths from the end, side ${side}, line from (${a.map((v) => v.toFixed(1))})`;
    assert.ok(distToPolyline(e, [a, b]) <= 1, `${where}: the end ${distToPolyline(e, [a, b]).toFixed(2)} px off the line`);
    assert.ok(d(e, b) <= 1.25, `${where}: the end ${d(e, b).toFixed(2)} px from where the ink ends`);
    assert.ok(res.points.every((q) => distToPolyline(q, [a, b]) <= 1), `${where}: a point went into the burr`);
  }
});

test('burrs along a line (pruned, or too short to branch) leave no kink: across the pixels to 0.25 px (a line on a pixel\'s centre and on its edge), on seeded slants to 0.5 px (as the same lines with none are)', () => {
  const BURRS = [[0.3, 1, 1.0], [0.55, -1, 1.4], [0.8, 1, 1.2]];
  const worstAtBurrs = (a, b, width, seed) => {
    const u = unit(a, b), r = new Raster(W, H).stroke([a, b], width, INK), at = [];
    for (const [f, side, len] of BURRS) { const p = lerp(a, b, f); burr(r, p, u, side, width, len); at.push(p); }
    const res = trace(r, seed, { detail: 0.1 });
    const near = densify(res.points).filter((q) => at.some((p) => d(p, q) <= 3 * width));
    assert.ok(near.length > 20 * BURRS.length, `the burrs' stretches measured: ${near.length} points`);
    return Math.max(...near.map((q) => distToPolyline(q, [a, b])));
  };
  for (const width of [3, 5, 6]) {
    for (const [a, b] of [[[60, 240.5], [640, 240.5]], [[60, 200], [640, 200]], [[330.5, 30], [330.5, 430]], [[300, 30], [300, 430]]]) {
      const e = worstAtBurrs(a, b, width, [lerp(a, b, 0.42)[0] + 0.3, lerp(a, b, 0.42)[1] + 0.2]);
      assert.ok(e <= 0.25, `width ${width}, the line from (${a}) to (${b}): ${e.toFixed(2)} px aside at a burr`);
    }
    for (const [[a, b], seed] of SLANTS.slice(0, 4)) {
      const e = worstAtBurrs(a, b, width, seed);
      assert.ok(e <= 0.5, `width ${width}, the line from (${a.map((v) => v.toFixed(1))}): ${e.toFixed(2)} px aside at a burr`);
    }
  }
});

test('a narrow fork (a branch 10° to 15° off a line, either side, widths 3 and 4): the line is followed on, the straighter way judged over a longer baseline, to 1 px; where the two ways are alike (a symmetric Y), the line stops at the fork', () => {
  for (const deg of [10, 12, 15]) for (const width of [3, 4]) for (const [[a, b], seed] of SLANTS.slice(0, 4)) for (const side of [1, -1]) {
    const u = unit(a, b), c = lerp(a, b, 0.6), t = ((deg * Math.PI) / 180) * side, len = 0.8 * d(c, b);
    const v = [u[0] * Math.cos(t) - u[1] * Math.sin(t), u[0] * Math.sin(t) + u[1] * Math.cos(t)];
    const res = trace(new Raster(W, H).stroke([a, b], width, INK).stroke([c, [c[0] + v[0] * len, c[1] + v[1] * len]], width, INK), seed);
    const where = `${deg}°, width ${width}, side ${side}, line from (${a.map((v) => v.toFixed(1))})`;
    const off = Math.max(...densify(res.points).map((q) => distToPolyline(q, [a, b])));
    assert.ok(off <= 1, `${where}: ${off.toFixed(2)} px off the line (into the branch)`);
    assert.ok(Math.min(...endErrors(res, [a, b])) <= 1 && Math.max(...endErrors(res, [a, b])) <= 1, `${where}: ends ${endErrors(res, [a, b]).map((e) => e.toFixed(2))} px from the line's`);
  }
  // A symmetric Y: a stem, and two branches each half the angle off its way. Neither is the line: it stops at the
  // fork, said so ('fork'), and no point of it is more than 12 px past where the branches part.
  for (const deg of [10, 15]) for (const width of [3, 4]) for (const [[a, b], seed] of SLANTS.slice(0, 4)) {
    const u = unit(a, b), c = lerp(a, b, 0.6), r = new Raster(W, H).stroke([a, c], width, INK);
    for (const sg of [1, -1]) {
      const t = ((deg / 2) * Math.PI / 180) * sg, v = [u[0] * Math.cos(t) - u[1] * Math.sin(t), u[0] * Math.sin(t) + u[1] * Math.cos(t)];
      r.stroke([c, [c[0] + v[0] * 150, c[1] + v[1] * 150]], width, INK);
    }
    const res = trace(r, lerp(a, c, 0.5));
    const past = Math.max(...res.points.map((q) => (q[0] - c[0]) * u[0] + (q[1] - c[1]) * u[1]));
    assert.ok(res.ends.includes('fork') && past <= 12, `a Y of ${deg}°, width ${width}, from (${a.map((v) => v.toFixed(1))}): ends ${res.ends}, ${past.toFixed(1)} px past the fork`);
  }
});
