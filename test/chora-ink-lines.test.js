// Assisted ink tracing: a line's ends, burrs off it and narrow forks in it, on lines at seeded slants in a
// window that is not square (700 × 460), off-centre, each case asymmetric (a burr on one side, a branch to one
// side), so that the answer is not one a pixel grid's symmetry gives for free. Synthetic maps from
// test/ink-synth.js, as test/chora-ink.test.js has them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Raster, INK, distToPolyline, densify, slantedLines, unit, lerp } from './ink-synth.js';
import { prepare, traceLine } from '../src/engine/chora/ink/index.js';
import { refinePath, windowMedians, maskInk } from '../src/engine/chora/ink/refine.js';
import { rng } from './ink-synth.js';

const W = 700, H = 460, ONE = { x0: 0, y0: 0, s: 1 };
const SLANTS = slantedLines(31, 6, W, H);
const trace = (r, seed, params = {}) => traceLine(prepare({ w: W, h: H, rgba: r.rgba }, { colour: false }), seed, ONE, params);
const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
// The trace's ends matched to the line's two end points (either way round).
const endErrors = (res, [a, b]) => {
  const g = [res.points[0], res.points.at(-1)], [p, q] = d(g[0], a) <= d(g[0], b) ? g : [g[1], g[0]];
  return [d(p, a), d(q, b)];
};
const rot = (u, deg) => { const t = (deg * Math.PI) / 180; return [u[0] * Math.cos(t) - u[1] * Math.sin(t), u[0] * Math.sin(t) + u[1] * Math.cos(t)]; };
// The farthest any point of the trace lies beyond its end point E, the way the line runs there (u, outwards): the
// line does not fold back on itself past its own end.
const beyondEnd = (pts, E, u) => Math.max(...pts.map((q) => (q[0] - E[0]) * u[0] + (q[1] - E[1]) * u[1]));
const endAt = (res, b) => [res.points[0], res.points.at(-1)].reduce((x, q) => (d(q, b) < d(x, b) ? q : x));
// A short stroke off one side of a line at point p (a burr, a serif): `len` widths out from the centreline.
const burr = (r, p, u, side, width, len) => {
  const n = [-u[1] * side, u[0] * side];
  return r.stroke([p, [p[0] + n[0] * width * len + u[0] * 1.3, p[1] + n[1] * width * len + u[1] * 1.3]], Math.max(2, 0.6 * width), INK);
};

test('a line\'s ends on a slant: round ends at widths 3 to 14 to 0.5 px, flat ends at widths 8 to 14 to 0.5 px (six seeded slants); a round end along pixels\' edges is not taken for flat', () => {
  for (const [cap, widths] of [['round', [3, 4, 5, 6, 8, 10, 14]], ['flat', [8, 10, 14]]]) for (const width of widths) {
    for (const [line, seed] of SLANTS) {
      const res = trace(new Raster(W, H).stroke(line, width, INK, { cap }), seed), e = Math.max(...endErrors(res, line));
      assert.ok(e <= 0.5, `${cap}, width ${width}, from (${line[0].map((v) => v.toFixed(1))}): an end off by ${e.toFixed(2)} px`);
      // No point beyond either end, the way the line runs there.
      const [a, b] = line, u = unit(a, b), over = Math.max(beyondEnd(res.points, endAt(res, b), u), beyondEnd(res.points, endAt(res, a), [-u[0], -u[1]]));
      assert.ok(over <= 0.01, `${cap}, width ${width}, from (${a.map((v) => v.toFixed(1))}): a point ${over.toFixed(2)} px beyond an end`);
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
    assert.ok(beyondEnd(res.points, e, u) <= 0.01, `${where}: a point ${beyondEnd(res.points, e, u).toFixed(2)} px beyond the end`);
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
      // The control: an L (a right-angle corner at 0.6 of the way) with the same burrs on its first leg. The burrs are
      // let go and the corner is not: what lets a burr's kink go must not take a corner's points too.
      const u = unit(a, b), c = lerp(a, b, 0.6), v = rot(u, 90), q = [c[0] + v[0] * 120, c[1] + v[1] * 120];
      if (q[0] < 20 || q[1] < 20 || q[0] > W - 20 || q[1] > H - 20) continue;
      const r = new Raster(W, H).stroke([a, c, q], width, INK), at = [0.2, 0.35].map((f) => lerp(a, b, f));
      for (const [k, p] of at.entries()) burr(r, p, u, k ? -1 : 1, width, 1.2);
      const res = trace(r, lerp(a, c, 0.5), { detail: 0.1 });
      const atBurr = densify(res.points).filter((p) => at.some((s) => d(s, p) <= 3 * width));
      assert.ok(atBurr.length > 20, `the L's burrs measured: ${atBurr.length} points`);
      const kink = Math.max(...atBurr.map((p) => distToPolyline(p, [a, c, q]))), cut = distToPolyline(c, res.points);
      assert.ok(kink <= 0.5 && cut <= Math.max(2, 0.5 * width), `width ${width}, an L from (${a.map((v) => v.toFixed(1))}): ${kink.toFixed(2)} px aside at a burr, the corner ${cut.toFixed(2)} px from the trace`);
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

// The review of round 3 (corners cut, an end misplaced past a bend, forks at the boundary, a T, a short dash).

test('a corner mid-line (90°, 60° and 30° turns, widths 3, 6 and 10) is not cut: the corner within half a width (and 2 px) of the trace at 60° and more, a fifth of a width (and 1 px) at 30°', () => {
  let cases = 0;
  for (const deg of [90, 60, 30]) for (const width of [3, 6, 10]) for (const [[a, b]] of SLANTS.slice(0, 4)) {
    const u = unit(a, b), c = lerp(a, b, 0.6), v = rot(u, deg), e = [c[0] + v[0] * 120, c[1] + v[1] * 120];
    if (e[0] < 20 || e[1] < 20 || e[0] > W - 20 || e[1] > H - 20) continue;
    cases++;
    const res = trace(new Raster(W, H).stroke([a, c, e], width, INK), lerp(a, c, 0.5), { detail: 0.1 });
    const near = densify(res.points).filter((q) => d(q, c) <= 4 * width);
    assert.ok(near.length > 8 * width, `the corner's stretch measured: ${near.length} points`);
    const cut = distToPolyline(c, res.points), off = Math.max(...near.map((q) => distToPolyline(q, [a, c, e])));
    const tol = deg >= 60 ? Math.max(2, 0.5 * width) : Math.max(1, 0.2 * width);
    const where = `${deg}°, width ${width}, line from (${a.map((v) => v.toFixed(1))})`;
    assert.ok(cut <= tol && off <= tol, `${where}: the corner ${cut.toFixed(2)} px from the trace, the trace ${off.toFixed(2)} px off the line there (at most ${tol})`);
  }
  assert.ok(cases >= 20, `${cases} corners drawn`);
});

test('a line that bends (20° or 45°) 1.5 to 5 widths from its end: the end placed to 2.5 px (as at 104a9f9, whose worst is 2.3), and no point of the trace beyond it', () => {
  for (const deg of [20, 45]) for (const k of [1.5, 3, 5]) for (const width of [3, 6]) for (const [[a, b], seed] of SLANTS.slice(0, 4)) {
    const u = unit(a, b), c = [b[0] - u[0] * k * width, b[1] - u[1] * k * width], v = rot(u, deg), e = [c[0] + v[0] * k * width, c[1] + v[1] * k * width];
    const res = trace(new Raster(W, H).stroke([a, c, e], width, INK), seed, { detail: 0.1 });
    const E = endAt(res, e), where = `${deg}° at ${k} widths from the end, width ${width}, line from (${a.map((v) => v.toFixed(1))})`;
    assert.ok(d(E, e) <= 2.5, `${where}: the end ${d(E, e).toFixed(2)} px from where it is`);
    assert.ok(beyondEnd(res.points, E, v) <= 0.01, `${where}: a point ${beyondEnd(res.points, E, v).toFixed(2)} px beyond the end`);
  }
});

// A bar twice as wide is not tested here: the thickness band cuts the T's widest pixels out of the skeleton, and the
// stem's chain can run on round into one half of the bar with no junction to stop at (a limit, as at 104a9f9).
test('a line ending on a bar across it as wide (a T): the line stops at the bar, not carried along it by a jump (a jump is for a break in the ink)', () => {
  for (const mult of [1]) for (const width of [3, 6]) for (const [[a, b], seed] of SLANTS.slice(0, 4)) {
    const u = unit(a, b), n = [-u[1], u[0]], bar = [[b[0] - n[0] * 80, b[1] - n[1] * 80], [b[0] + n[0] * 80, b[1] + n[1] * 80]];
    const res = trace(new Raster(W, H).stroke([a, b], width, INK).stroke(bar, width * mult, INK), seed);
    const where = `bar ×${mult}, width ${width}, line from (${a.map((v) => v.toFixed(1))})`;
    const E = endAt(res, b), off = Math.max(...densify(res.points).map((q) => distToPolyline(q, [a, b])));
    assert.ok(d(E, a) > 100, `${where}: the trace reaches the bar's side of the line`);
    assert.ok(off <= 1.5 && d(E, b) <= (mult * width) / 2 + width + 2, `${where}: ${off.toFixed(2)} px off the line, the end ${d(E, b).toFixed(2)} px from the bar's centreline (ends ${res.ends}, ${res.gaps.length} gaps)`);
  }
});

test('a dashed line (dashes six widths, gaps one and a half) whose last dash is short: the far end is not carried past that dash\'s ink', () => {
  let short = 0;
  for (const width of [3, 5]) for (const [[a, b], seed] of SLANTS.slice(0, 4)) {
    const u = unit(a, b), L = d(a, b), r = new Raster(W, H), segs = [];
    for (let s = 0; s < L; s += 7.5 * width) { const e = Math.min(L, s + 6 * width); segs.push([lerp(a, b, s / L), lerp(a, b, e / L)]); r.stroke(segs.at(-1), width, INK); }
    const last = segs.at(-1), len = d(last[0], last[1]);
    if (len > 3 * width) continue;
    short++;
    const res = trace(r, seed), E = endAt(res, b), where = `width ${width}, last dash ${len.toFixed(1)} px, line from (${a.map((v) => v.toFixed(1))})`;
    const aside = Math.max(...densify(res.points).map((q) => Math.abs((q[0] - a[0]) * u[1] - (q[1] - a[1]) * u[0])));
    assert.ok(aside <= 1, `${where}: the trace ${aside.toFixed(2)} px aside of the line`);
    assert.ok(beyondEnd([E], b, u) <= width / 2 + 0.5, `${where}: the end ${beyondEnd([E], b, u).toFixed(2)} px beyond where the ink ends`);
  }
  assert.ok(short >= 2, `${short} lines whose last dash is short`);
});

test('forks at the boundary of narrow (FORK_SPLIT 30°): a branch 26° or 28° off is judged as a narrow fork, and the line followed on, to 1 px; at 32° the ways are judged at the junction, as before (either line, to 2 px, not stopped)', () => {
  // The split is measured between the two ways' own directions, clear of the junction: measured from the junction node
  // (which thinning sets back towards the stem) a drawn 28° fork was 31° to 32°, and not narrow.
  for (const deg of [26, 28, 32]) for (const width of [3, 4, 5]) for (const [[a, b], seed] of SLANTS.slice(0, 4)) for (const side of [1, -1]) {
    const u = unit(a, b), c = lerp(a, b, 0.6), v = rot(u, deg * side), q = [c[0] + v[0] * 0.8 * d(c, b), c[1] + v[1] * 0.8 * d(c, b)];
    const res = trace(new Raster(W, H).stroke([a, b], width, INK).stroke([c, q], width, INK), seed);
    const where = `${deg}°, width ${width}, side ${side}, line from (${a.map((v) => v.toFixed(1))})`, pts = densify(res.points);
    assert.ok(pts.length > 400, `${where}: traced (${pts.length} points)`);
    if (deg < 30) {
      const off = Math.max(...pts.map((p) => distToPolyline(p, [a, b])));
      assert.ok(off <= 1, `${where}: ${off.toFixed(2)} px off the line (into the branch)`);
    } else {
      const off = Math.max(...pts.map((p) => Math.min(distToPolyline(p, [a, b]), distToPolyline(p, [a, c, q]))));
      assert.ok(off <= 2 && !res.ends.includes('fork'), `${where}: ${off.toFixed(2)} px off both lines, ends ${res.ends}`);
    }
  }
});

test('refinePath: a point `skip` names is left where it is and kept (a junction\'s, whose other line\'s ink would draw it aside); the others about it are moved to the ink\'s centre', () => {
  // A horizontal bar 5 px wide whose centre is at y = 20.5, and a path along it a pixel off, at y = 21.5.
  const w = 80, h = 40, M = new Float32Array(w * h);
  for (let y = 18; y <= 22; y++) for (let x = 0; x < w; x++) M[y * w + x] = 1;
  const pts = Array.from({ length: 50 }, (_, k) => [15.5 + k, 21.5]);
  const skipped = (p) => p[0] >= 38 && p[0] <= 43;
  for (const wide of [Infinity, 0.5]) {
    const out = refinePath(pts, maskInk(M, w, h), { half: 4.5, span: 3, limit: 1.5, skip: skipped, wide });
    const left = out.filter(skipped), moved = out.filter((p) => !skipped(p));
    assert.equal(left.length, 5, `wide ${wide}: the five points skipped are kept`);
    assert.ok(left.every((p) => p[1] === 21.5), `wide ${wide}: the points skipped are not moved`);
    assert.ok(moved.length >= 40 && moved.slice(2, -2).every((p) => Math.abs(p[1] - 20.5) < 0.05), `wide ${wide}: the others moved onto the centre`);
  }
});

test('windowMedians: the median of each window (NaN left out) is the sorted window\'s, at every window size', () => {
  const g = rng(7), v = Array.from({ length: 300 }, () => (g() < 0.1 ? NaN : g() < 0.05 ? Infinity : Math.round(g() * 20) / 4));
  for (const M of [0, 1, 3, 12, 400]) {
    const got = windowMedians(v, M);
    let checked = 0;
    for (let k = 0; k < v.length; k++) {
      const near = v.slice(Math.max(0, k - M), k + M + 1).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
      const want = near.length ? near[near.length >> 1] : NaN;
      assert.ok(Object.is(got[k], want), `M ${M}, at ${k}: ${got[k]}, not ${want}`);
      checked += near.length > 0;
    }
    assert.ok(checked > 250, `M ${M}: ${checked} windows with values`);
  }
});
