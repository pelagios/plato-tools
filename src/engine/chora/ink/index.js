// Assisted ink tracing: a shape proposed from a historical map's own pixels, for the user to accept,
// edit or discard. Pure: no DOM, nothing fetched (the page fetches the tiles, src/chora/ink.worker.js
// runs this on them), so every step is tested in Node on synthetic maps (test/chora-ink.test.js).
//
// The window: the part of the map read, as one grid of "working" pixels at one scale factor s of the
// image (window.js composes it from the IIIF tiles, each scaled by its own region and its bitmap's
// actual size). A working pixel (x, y) covers image pixels [x0 + x·s, x0 + (x+1)·s) across, and so on.
//
// HALF-PIXEL CONVENTIONS (the design's amendment 1), which the tests pin:
// - a filled area's outline comes from d3-contour, whose coordinates are pixel CORNERS (IIIF's
//   convention too): taken as they are, with NO half pixel added;
// - a line's points are skeleton pixels, and the distance transform's values are about pixels: each is
//   taken at the pixel's CENTRE, +0.5.
//
// The steps, and what each is:
// - colour.js: L*, or CIELAB, kept compactly (L* as Float32, a* b* as Int8); median.js: the 3×3 median;
// - mask.js: ink by ΔE76 from the seed's colour, or by Sauvola's adaptive threshold on L*;
// - fill.js: the scanline flood fill, gaps bridged by growing the boundary, and the leak test;
// - contour.js: the outline (d3-contour) and its holes; edt.js: the exact distance transform;
// - thin.js: Zhang–Suen; graph.js: the skeleton as nodes and chains, spurs pruned; follow.js: the line
//   followed from the click; simplify.js: Douglas–Peucker in IMAGE pixels, halved while it crosses itself.
import { lab, lightness, lightnessWriter, labWriter } from './colour.js';
import { composeEach } from './window.js';
import { median3, unquantise, SCALE as RAW_SCALE } from './median.js';
import { seedColour, deltaEMask, sauvolaMask, darkest } from './mask.js';
import { floodFill, fillInto, bridgedFill, leak } from './fill.js';
import { outline, keepHoles, ringArea } from './contour.js';
import { insideDistance } from './edt.js';
import { zhangSuen } from './thin.js';
import { skeletonGraph, pruneSpurs, live } from './graph.js';
import { refinePath, darkness, maskInk } from './refine.js';
import { follow, DIRECTION_SPAN, JUMP_REACH, JUMP_CONE } from './follow.js';
import { simplifyAll } from './simplify.js';

import { DEFAULTS, InkError } from './params.js';

export { EPSILON } from './simplify.js';
export { DEFAULTS, InkError } from './params.js';
/** How far round an area its map's pen stroke is measured, in working pixels. */
export const STROKE_MARGIN = 128;
/** The most components of ink a line is followed through (each a gap jumped, at most). */
export const MAX_COMPONENTS = 2000;
/**
 * A line's end is taken as flat when its ink fills at least this share of its full width over its last
 * half width (a round cap fills π/4 ≈ 0.79 of it). Measured on drawn ends, from six pixels wide (5.5 as the width is measured, on a slant) flat ones
 * fill 0.86 or more and round ones 0.80 or less; narrower (below 5 measured), on a slant, the two overlap (0.59 to 0.92 each),
 * so there only an end at its full width to its last pixel (an end square to the pixels) is taken as flat,
 * and any other is placed as a round one, as it always was.
 */
export const FLAT_END = 0.84, FLAT_END_NARROW = 0.97, NARROW_END = 5;

/**
 * The window's pixels made ready for one kind of tracing, cached by the caller while the window stands
 * (a slider re-runs only what follows): the 3×3 median of CIELAB (an area, or a line by its colour), or
 * of L* alone (a line by its darkness). `rgba` is not kept: the caller may let it go.
 */
export function prepare(win, { colour = true } = {}) {
  const { w, h } = win;
  // The RGBA is let go as soon as it is converted (taken off `win` too), and each channel's unfiltered
  // copy as soon as it is filtered: at 2048² the RGBA alone is 16 MB.
  let rgba = win.rgba; win.rgba = null;
  if (colour) {
    const c = lab(rgba, w, h); rgba = null;
    const L = median3(c.L, w, h); c.L = null;
    const a = median3(c.a, w, h); c.a = null;
    return { w, h, L, a, b: median3(c.b, w, h) };
  }
  const L0 = lightness(rgba, w, h); rgba = null;
  const raw = new Int16Array(w * h);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.round(L0[i] * RAW_SCALE);
  return { w, h, L: median3(L0, w, h), raw };
}

/**
 * The same as prepare, made straight from the tiles (window.js's composeEach): no RGBA of the window is
 * ever made. What the worker does.
 */
export function prepareTiles(frame, tiles, { colour = true } = {}) {
  const { w, h } = frame, n = w * h;
  // L* is written as integers (at 1/64 of a unit), filtered as such (median3 without a branch), and only
  // then made Float32: the same numbers as prepare(), at a third of the time and no more memory.
  const L16 = (q) => { let m = median3(q, w, h); q = null; const L = unquantise(m); m = null; return L; };
  if (colour) {
    const c = { L: new Int16Array(n), a: new Int8Array(n), b: new Int8Array(n) };
    composeEach(frame, tiles, labWriter(c.L, c.a, c.b));
    const a = median3(c.a, w, h); c.a = null;
    const b = median3(c.b, w, h); c.b = null;
    const q = c.L; c.L = null;
    return { w, h, L: L16(q), a, b };
  }
  const q = new Int16Array(n);
  composeEach(frame, tiles, lightnessWriter(q));
  // The unfiltered L* is kept (at 1/64, 2 bytes a pixel) for where a line's ink ends (traceLine).
  return { w, h, L: L16(q), raw: q };
}

const toImage = (frame) => ([x, y]) => [frame.x0 + x * frame.s, frame.y0 + y * frame.s];

/**
 * The usual width of the window's dark ink (its pen stroke), in working pixels: for each piece of ink
 * (Sauvola's mask, within `bbox` when given) that is a line (four times as long as it is wide, so not a
 * blot or a letter), its area over the length of its centreline; the median of those, weighted by
 * length. 2 when there is none to measure. `area`, a w × h mask of an area's pixels, is left out.
 */
export function strokeWidth(prep, bbox = null, area = null) {
  const { w, L } = prep;
  const [x0, y0, x1, y1] = bbox || [0, 0, prep.w - 1, prep.h - 1];
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, sub = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) sub[y * cw + x] = L[(y + y0) * w + x + x0];
  const ink = sauvolaMask(sub, cw, ch);
  // Not the area itself: a dark wash is darker than the paper about it, so Sauvola's threshold marks a band
  // of it along its edges (round a hole, too) as ink, which would be measured as a line many pixels wide.
  if (area) for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (area[(y + y0) * w + x + x0]) ink[y * cw + x] = 0;
  const sk = zhangSuen(ink, cw, ch);
  const labels = new Uint16Array(cw * ch);
  const pieces = [];
  for (let i = 0; i < ink.length && pieces.length < 65000; i++) {
    if (!ink[i] || labels[i]) continue;
    const id = pieces.length + 1, c = fillInto(ink, labels, id, cw, ch, i % cw, (i / cw) | 0, { eight: true });
    pieces.push({ area: c.count, length: 0 });
  }
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const i = y * cw + x;
    if (!sk[i]) continue;
    let len = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if ((dx || dy) && xx >= 0 && yy >= 0 && xx < cw && yy < ch && sk[yy * cw + xx]) len += (dx && dy ? Math.SQRT2 : 1) / 2;
    }
    pieces[labels[i] - 1].length += len;
  }
  // Lines, not blots: pieces at least four times as long as they are wide.
  const lines = pieces.filter((q) => q.length >= 4 && q.length * q.length >= 4 * q.area).map((q) => ({ width: q.area / q.length, length: q.length })).sort((a, b) => a.width - b.width);
  const total = lines.reduce((t, q) => t + q.length, 0);
  if (!total) return 2;
  let acc = 0;
  for (const q of lines) { acc += q.length; if (acc >= total / 2) return Math.max(1, q.width); }
  return 2;
}

/**
 * An area: the pixels like the seed's colour (ΔE76 within `tolerance`) connected to it, gaps of up to
 * `bridge` pixels in its boundary bridged, outlined; holes smaller than (4 × the stroke)² dropped when
 * `dropSmallHoles`; simplified within `detail` image pixels. `seed` [x, y] a working pixel; `frame`
 * { x0, y0, s } places the window in the image. Returns { kind: 'area', rings (image px, corner
 * convention: outer first), holes: { kept, dropped }, epsilon, stroke, share } or throws InkError
 * (kind 'leak' when the fill escaped: { reason }).
 */
export function traceArea(prep, seed, frame, params = {}) {
  const p = { ...DEFAULTS.area, ...params };
  const { w, h } = prep;
  const [sx, sy] = seed.map(Math.floor);
  const colour = seedColour(prep, w, h, sx, sy, 2);
  const passable = deltaEMask(prep, w, h, colour, p.tolerance);
  const fill = p.bridge > 0 ? bridgedFill(passable, w, h, sx, sy, p.bridge / 2) : floodFill(passable, w, h, sx, sy);
  if (!fill.count) throw new InkError('Nothing like the colour clicked was found there.', 'empty');
  const why = leak(fill, w, h);
  if (why) throw Object.assign(new InkError(why.reason === 'edge' ? 'The fill ran out to the edge of the part of the map read: the area is not closed there (try bridging gaps), or is too large at this zoom.' : 'The fill covered most of the part of the map read: the area is not closed (try bridging gaps, or a lower tolerance).', 'leak'), { reason: why.reason, share: why.share, fill });
  // Each pixel's cover by the colour clicked, for placing the outline within the pixels: 1 − ΔE over
  // the local contrast (the largest ΔE within two pixels), so that a pixel half covered at an edge
  // blurred by the scan, or by the tiles' resampling, counts as half.
  const dE = (i) => { const l = prep.L[i] - colour[0], a = prep.a[i] - colour[1], b = prep.b[i] - colour[2]; return Math.sqrt(l * l + a * a + b * b); };
  const cover = (x, y) => {
    let c = 0;
    for (let j = Math.max(0, y - 2); j <= Math.min(h - 1, y + 2); j++) for (let i = Math.max(0, x - 2); i <= Math.min(w - 1, x + 2); i++) c = Math.max(c, dE(j * w + i));
    return c > p.tolerance ? 1 - dE(y * w + x) / c : 1;
  };
  const o = outline(fill.region, w, fill.bbox, [sx + 0.5, sy + 0.5], cover);
  if (!o) throw new InkError('The fill has no outline.', 'empty');
  let holes = o.holes, stroke = null;
  if (p.dropSmallHoles && holes.length) {
    // The map's linework about the area (its box, and STROKE_MARGIN working pixels round it, the area itself
    // left out), kept with the window for that fill: a slider that does not change the fill does not measure it again.
    const [bx0, by0, bx1, by1] = fill.bbox, m = STROKE_MARGIN;
    const box = [Math.max(0, bx0 - m), Math.max(0, by0 - m), Math.min(w - 1, bx1 + m), Math.min(h - 1, by1 + m)];
    const key = `${box.join(',')} ${fill.count} ${fill.seed ?? [sx, sy]}`;
    if (prep.strokeKey !== key) { prep.stroke = strokeWidth(prep, box, fill.region); prep.strokeKey = key; }
    stroke = prep.stroke;
    holes = keepHoles(holes, (4 * stroke) ** 2);
  }
  const img = toImage(frame);
  const paths = [o.outer, ...holes].map((r) => ({ pts: r.map(img), closed: true }));
  const { paths: out, epsilon } = simplifyAll(paths, p.detail * frame.s, undefined, frame.s);
  return { kind: 'area', rings: out.map((q) => q.pts), holes: { kept: holes.length, dropped: o.holes.length - holes.length }, epsilon, stroke, share: fill.count / (w * h), areaPx: Math.abs(ringArea(o.outer)) - holes.reduce((s, r) => s + Math.abs(ringArea(r)), 0) };
}

/**
 * A line: in darkness mode the seed snaps to the darkest pixel within `seedRadius` working pixels, and
 * ink is Sauvola's; in colour mode, ink is like the seed's colour (ΔE76 within `tolerance`). The ink
 * component under the seed is thinned (its distance transform and skeleton cropped to its box), the
 * skeleton kept within the thickness `band` (times the width at the seed), and followed both ways
 * (follow.js), jumping gaps when `jumps`; simplified within `detail` image pixels. Returns { kind:
 * 'line', points (image px, pixel centres), gaps [[from, to]] (image px), width (working px), ends,
 * reachedEdge, epsilon, seed } or throws InkError.
 */
export function traceLine(prep, seed, frame, params = {}) {
  const p = { ...DEFAULTS.line, ...params };
  const { w, h } = prep;
  let [sx, sy] = seed.map(Math.floor);
  let ink;
  if (p.colour) {
    if (!prep.a) throw new InkError('Matching a colour needs the colours of the map (prepare with colour).', 'prepare');
    // The ink's colour: the darkest pixel near the click is taken as on the line.
    [sx, sy] = darkest(prep.L, w, h, sx, sy, p.seedRadius);
    ink = deltaEMask(prep, w, h, seedColour(prep, w, h, sx, sy, 1), p.tolerance);
  } else {
    [sx, sy] = darkest(prep.L, w, h, sx, sy, p.seedRadius);
    ink = sauvolaMask(prep.L, w, h);
  }
  // Components of ink, labelled as they are taken in (the one under the seed first), each thinned within
  // its own box: the skeleton's pixels and their widths are kept for the window.
  const labels = new Uint16Array(w * h), skel = new Uint8Array(w * h), widths = new Map();
  const comps = [];
  const DX = [0, 1, 1, 1, 0, -1, -1, -1], DY = [-1, -1, 0, 1, 1, 1, 0, -1];
  function take(x, y) {
    const id = comps.length + 1;
    const c = fillInto(ink, labels, id, w, h, x, y, { eight: true });
    if (!c.bbox) return null;
    const [bx0, by0, bx1, by1] = c.bbox;
    const ox = Math.max(0, bx0 - 1), oy = Math.max(0, by0 - 1), cw = Math.min(w - 1, bx1 + 1) - ox + 1, ch = Math.min(h - 1, by1 + 1) - oy + 1;
    const crop = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) crop[y * cw + x] = labels[(y + oy) * w + x + ox] === id ? 1 : 0;
    const dt = insideDistance(crop, cw, ch), sk = zhangSuen(crop, cw, ch);
    const ends = [];
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      if (!sk[y * cw + x]) continue;
      const i = (y + oy) * w + x + ox;
      skel[i] = 1; widths.set(i, Math.max(1, 2 * Math.sqrt(dt[y * cw + x]) - 1));
      let n = 0;
      for (let k = 0; k < 8; k++) { const xx = x + DX[k], yy = y + DY[k]; if (xx >= 0 && yy >= 0 && xx < cw && yy < ch && sk[yy * cw + xx]) n++; }
      if (n <= 1) ends.push(i);
    }
    const comp = { id, count: c.count, bbox: c.bbox, ends };
    comps.push(comp);
    return comp;
  }
  const first = take(sx, sy);
  if (!first) throw new InkError('No line was found under the click.', 'empty');
  let s0 = -1;
  {
    let bd = Infinity;
    const [bx0, by0, bx1, by1] = first.bbox;
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) { const i = y * w + x; if (skel[i] && labels[i] === first.id) { const d = (x - sx) ** 2 + (y - sy) ** 2; if (d < bd) { bd = d; s0 = i; } } }
  }
  if (s0 < 0) throw new InkError('No line was found under the click.', 'empty');
  const xy = (i) => [i % w, (i / w) | 0];
  // The width at the click: the ink's area near it over the length of its centreline there (one
  // pixel's distance transform is coarse on a thin line, and smaller on a diagonal than across it).
  const width = (() => {
    const [s0x, s0y] = xy(s0), R = 8;
    let area = 0, len = 0;
    for (let y = Math.max(0, s0y - R); y <= Math.min(h - 1, s0y + R); y++) for (let x = Math.max(0, s0x - R); x <= Math.min(w - 1, s0x + R); x++) {
      if ((x - s0x) ** 2 + (y - s0y) ** 2 > R * R) continue;
      const i = y * w + x;
      if (labels[i] !== first.id) continue;
      area++;
      // A skeleton pixel's share of length: half of each step to its skeleton neighbours (√2 diagonally).
      if (skel[i]) for (let k = 0; k < 8; k++) { const xx = x + DX[k], yy = y + DY[k]; if (xx >= 0 && yy >= 0 && xx < w && yy < h && skel[yy * w + xx]) len += (DX[k] && DY[k] ? Math.SQRT2 : 1) / 2; }
    }
    return len ? Math.max(1, area / len) : widths.get(s0);
  })();
  const widthAt = (i) => widths.get(i) ?? width;
  // Ink across a gap: from each end of the skeleton, the components ahead within the jump's reach and
  // cone are taken in too (and from their ends, in turn), so that follow() can jump to them.
  if (p.jumps) {
    const K = Math.max(3, Math.round(DIRECTION_SPAN * width)), reach = JUMP_REACH * width;
    const queue = [...first.ends];
    while (queue.length && comps.length < MAX_COMPONENTS) {
      const e = queue.shift();
      // The way ahead at the end: back along the skeleton K steps.
      let cur = e, prev = -1;
      for (let k = 0; k < K; k++) {
        const [x, y] = xy(cur);
        let next = -1;
        for (let d = 0; d < 8 && next < 0; d++) { const xx = x + DX[d], yy = y + DY[d]; const j = yy * w + xx; if (xx >= 0 && yy >= 0 && xx < w && yy < h && skel[j] && j !== prev && labels[j] === labels[e]) next = j; }
        if (next < 0) break;
        prev = cur; cur = next;
      }
      const [ex, ey] = xy(e), [bx, by] = xy(cur), dx = ex - bx, dy = ey - by, dl = Math.hypot(dx, dy);
      if (!dl) continue;
      const R = Math.ceil(reach);
      for (let y = Math.max(0, ey - R); y <= Math.min(h - 1, ey + R); y++) for (let x = Math.max(0, ex - R); x <= Math.min(w - 1, ex + R); x++) {
        const i = y * w + x;
        if (!ink[i] || labels[i]) continue;
        const vx = x - ex, vy = y - ey, d = Math.hypot(vx, vy);
        if (d > reach || ((vx * dx + vy * dy) / (d * dl)) < Math.cos((JUMP_CONE * Math.PI) / 180)) continue;
        const c = take(x, y);
        if (c) queue.push(...c.ends);
      }
    }
  }
  // The mask is not needed again (a colour's centre is found from the labels): let go.
  if (!p.colour) ink = null;
  // The thickness band, with a pixel's slack either way for the coarseness of a pixel's width: the
  // skeleton's pixels outside it are taken out of it, in place.
  for (const [i, wd] of widths) if (!(wd >= p.band[0] * width - 1 && wd <= p.band[1] * width + 1)) skel[i] = 0;
  skel[s0] = 1;
  const band = skel;
  const g = skeletonGraph(band, w, h);
  pruneSpurs(g, 2 * width, s0);
  const isEdge = (i) => { const [x, y] = xy(i); return x === 0 || y === 0 || x === w - 1 || y === h - 1; };
  const f = follow(g, s0, { width, widthAt, jumps: p.jumps, isEdge });
  const centre = (i) => [(i % w) + 0.5, ((i / w) | 0) + 0.5];
  const img = toImage(frame);
  // Each point moved across the line to the ink's centre there (refine.js), but not near a junction,
  // where the ink of the other line would draw it aside.
  const junctions = g.nodes.filter((n) => live(g, n.id).length >= 3).map((n) => [n.x + 0.5, n.y + 0.5]);
  const nearJunction = (q) => junctions.some(([x, y]) => (q[0] - x) ** 2 + (q[1] - y) ** 2 <= (2 * width + 1) ** 2);
  const inkOf = p.colour ? maskInk(ink, w, h) : darkness(prep.L, w, h);
  const work = refinePath(f.px.map(centre), inkOf, { half: width / 2 + 2, span: Math.max(2, Math.round(width)), limit: 1, skip: nearJunction });
  // Thinning wears a line's ends away by about half its width: an end that is the ink's end is carried on,
  // the way the line runs, to half a width short of where the ink stops.
  if (!f.closed && work.length > 1) {
    const K = Math.max(3, Math.round(2 * width));
    const extendEnd = (at, from, px) => {
      const [ax, ay] = work[from], [bx, by] = work[at], L = Math.hypot(bx - ax, by - ay);
      if (!L) return;
      const ux = (bx - ax) / L, uy = (by - ay) / L, id = labels[px];
      // The ink about the end, as it was before the 3×3 median (which wears a flat end's corners away and
      // takes a round end's tip off, so that, a few pixels wide, the two look alike): the pixels darker than
      // halfway from the line's lightness to the paper's, in the component or touching it. Without the
      // unfiltered lightness (a colour), the component's own pixels.
      const R = Math.ceil(4 * width + 6), x0 = Math.floor(bx), y0 = Math.floor(by);
      const X0 = Math.max(0, x0 - R), X1 = Math.min(w - 1, x0 + R), Y0 = Math.max(0, y0 - R), Y1 = Math.min(h - 1, y0 + R);
      let isInk = (i) => labels[i] === id;
      if (prep.raw) {
        const inkL = [], paperL = [];
        for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) { const i = y * w + x; (labels[i] === id ? inkL : labels[i] ? null : paperL)?.push(prep.L[i]); }
        const mid = (v) => v.sort((a, b) => a - b)[v.length >> 1];
        if (inkL.length && paperL.length) {
          const thr = ((mid(inkL) + mid(paperL)) / 2) * RAW_SCALE, raw = prep.raw;
          const touches = (x, y) => { for (let j = Math.max(0, y - 1); j <= Math.min(h - 1, y + 1); j++) for (let k = Math.max(0, x - 1); k <= Math.min(w - 1, x + 1); k++) if (labels[j * w + k] === id) return true; return false; };
          isInk = (i) => raw[i] <= thr && touches(i % w, (i / w) | 0);
        }
      }
      // Each ink pixel within half a width (and a pixel) of the line carried on: how far along, and across.
      // t, the farthest ink ahead; tMed, the same in the component (after the median: where a round end has
      // always been placed from, its tip pixel worn away).
      // tWide: where ink wider than the line begins about the end (a thicker road across it, which the thickness
      // band cut the line at): the line ends at that ink's edge, not carried into it (and drawn back to it when
      // the skeleton ran a little way in).
      let t = 0, tMed = 0, tWide = Infinity;
      const along_ = [];
      for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
        const i = y * w + x, mine = labels[i] === id, ink = isInk(i);
        if (!mine && !ink) continue;
        const dx = x + 0.5 - bx, dy = y + 0.5 - by, along = dx * ux + dy * uy, across = Math.abs(dx * uy - dy * ux);
        if (mine && along > -2 * width && along <= 2 * width + 1 && across > width + 1) tWide = Math.min(tWide, along - 0.5);
        if (across > width / 2 + 1) continue;
        if (mine && along > 0) tMed = Math.max(tMed, along + 0.5);
        if (!ink) continue;
        along_.push(along);
        if (along > 0) t = Math.max(t, along + 0.5);
      }
      const share = (a, b) => { let n = 0; for (const v of along_) n += Math.max(0, Math.min(b, v + 0.5) - Math.max(a, v - 0.5)); return n; };
      const aRef = t - (1.5 * width + 1), Lr = Math.max(4, 2 * width);
      const wRef = share(aRef - Lr, aRef) / Lr, T = aRef + share(aRef, Infinity) / wRef, r = wRef / 2;
      // The end's shape: a flat (butt) end is at its full width over the last half width; a round one tapers
      // there (to π/4 of the full width, ideally). Flat, the line runs to where the ink stops; round, to the
      // centre of its cap, half a width short of it.
      const flat = wRef > 0 && share(t - r, t) / (r * wRef) >= (width < NARROW_END ? FLAT_END_NARROW : FLAT_END);
      const go = Number.isFinite(tWide) ? tWide : flat ? T : tMed - width / 2;
      if (!(go > 0 || Number.isFinite(tWide))) return;
      const e = [bx + go * ux, by + go * uy];
      work[at] = e;
      // Drawn back, the points beyond the new end are let go (the line does not fold back on itself).
      const beyond = (q) => (q[0] - e[0]) * ux + (q[1] - e[1]) * uy > 0;
      if (at > 0) while (work.length > 2 && beyond(work[work.length - 2])) work.splice(work.length - 2, 1);
      else while (work.length > 2 && beyond(work[1])) work.splice(1, 1);
    };
    if (f.ends[1] === 'end') extendEnd(work.length - 1, Math.max(0, work.length - 1 - K), f.px.at(-1));
    if (f.ends[0] === 'end') extendEnd(0, Math.min(work.length - 1, K), f.px[0]);
  }
  const pts = work.map(img);
  const { paths: [line], epsilon } = simplifyAll([{ pts, closed: f.closed }], p.detail * frame.s, undefined, frame.s);
  return {
    kind: 'line', points: line.pts, closed: f.closed, gaps: f.gaps.map(([a, b]) => [img(centre(a)), img(centre(b))]), width, ends: f.ends,
    reachedEdge: f.ends.includes('edge'), epsilon, seed: img([sx + 0.5, sy + 0.5]), pathPx: f.px.length, components: comps.length,
  };
}
