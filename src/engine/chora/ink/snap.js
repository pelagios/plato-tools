// Snapping a vertex drawn by hand to the map's ink. Terra Draw asks for the snapped position
// synchronously, on every move, so nothing can be computed then: when the view settles, the ink's
// sparse pixels (the ridges of its lines, at pixel centres, and the edges of its areas) are found once
// (snapPixels, in the worker), carried into the world through the georeference by the page (a
// MultiPoint through georef's toWorld: exact, no local fit), and binned by screen pixel (binPoints). A
// move then looks up the nearest within the radius (nearest): a few hundred cells at most.
import { sauvolaMask } from './mask.js';
import { zhangSuen } from './thin.js';
import { insideDistance } from './edt.js';
import { crossCentre, darkness } from './refine.js';

export const SNAP_RADIUS = 10;      // screen pixels
export const MAX_SNAP_POINTS = 200000;
/**
 * A ridge is a line's when both its sides are lighter than it by LINE_CONTRAST units of L* at least, and the
 * darker side by at least LINE_SIDES of the lighter's difference (a road along a wash: the wash is lighter
 * than the road by most of what the paper is).
 */
export const LINE_CONTRAST = 3, LINE_SIDES = 0.35;
// A screen pixel's cell: rows of SPAN, offset so that a point a little off the map's container has one too.
const SPAN = 1 << 20, OFF = 1 << 19;
const cell = (x, y) => (Math.floor(x) + OFF) * SPAN + Math.floor(y) + OFF;

/**
 * The window's ink as sparse points in image pixels: { ridges: Float64Array [x, y, …] (skeleton pixels
 * of the dark ink, at their centres, each moved across its line to the ink's centre), edges: Float64Array (pixels where L* changes most steeply across
 * its edge, at their centres) }. At most `max` of each (evenly thinned beyond that).
 */
export function snapPixels(prep, frame, { max = MAX_SNAP_POINTS, edgeStep = 8 } = {}) {
  const { w, h, L } = prep;
  const mask = sauvolaMask(L, w, h), sk = zhangSuen(mask, w, h), dt = insideDistance(mask, w, h);
  const ridges = [], edges = [];
  // Each ridge pixel moved across its line to the ink's centre (refine.js): the line's direction from
  // the skeleton within two pixels (its principal axis).
  const ink = darkness(L, w, h);
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    if (!sk[y * w + x]) continue;
    let n = 0, mx = 0, my = 0, sxx = 0, syy = 0, sxy = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (sk[(y + dy) * w + x + dx]) { n++; mx += dx; my += dy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    let px = x + 0.5, py = y + 0.5;
    if (n >= 3) {
      mx /= n; my /= n; sxx = sxx / n - mx * mx; syy = syy / n - my * my; sxy = sxy / n - mx * my;
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), nx = -Math.sin(th), ny = Math.cos(th);
      // A line is lighter on both sides of it. A dark wash is darker than the paper about it, so Sauvola's
      // threshold marks a band of it along its edge as ink, whose skeleton is no line: on its inner side the
      // wash is as dark as it is. Such a ridge would win over the wash's edge (nearestInk), so it is not kept.
      const r = Math.sqrt(dt[y * w + x]) + 1.5, c = L[y * w + x];
      const side = (k) => { const sx = Math.floor(px + k * r * nx), sy = Math.floor(py + k * r * ny); return sx >= 0 && sy >= 0 && sx < w && sy < h ? L[sy * w + sx] : c; };
      const a = side(1), b = side(-1);
      if (Math.min(a, b) - c < Math.max(LINE_CONTRAST, LINE_SIDES * (Math.max(a, b) - c))) continue;
      const d = crossCentre(ink, px, py, nx, ny, Math.sqrt(dt[y * w + x]) + 2);
      if (d !== null && Math.abs(d) <= 1) { px += d * nx; py += d * ny; }
    }
    ridges.push(px, py);
  }
  // Edges: the gradient's magnitude a local maximum across the edge (two of eight directions).
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = (L[i + 1] - L[i - 1]) / 2, gy = (L[i + w] - L[i - w]) / 2, m = Math.hypot(gx, gy);
    if (m < edgeStep) continue;
    const [dx, dy] = Math.abs(gx) > Math.abs(gy) ? [1, 0] : [0, 1];
    const mag = (j) => Math.hypot((L[j + 1] - L[j - 1]) / 2, (L[j + w] - L[j - w]) / 2);
    const a = i - dx - dy * w, b = i + dx + dy * w;
    if (a % w === 0 || b % w === w - 1 || a < w || b >= (h - 1) * w) continue;
    if (m >= mag(a) && m > mag(b)) edges.push(x + 0.5, y + 0.5);
  }
  const toImage = (list) => {
    const n = list.length / 2, step = Math.max(1, Math.ceil(n / max)), out = new Float64Array(Math.ceil(n / step) * 2);
    for (let k = 0, o = 0; k < n; k += step, o += 2) { out[o] = frame.x0 + list[2 * k] * frame.s; out[o + 1] = frame.y0 + list[2 * k + 1] * frame.s; }
    return out;
  };
  return { ridges: toImage(ridges), edges: toImage(edges) };
}

/**
 * Points binned by screen pixel: `screen` [x, y, …] (container pixels), `world` the same points'
 * [lng, lat, …]. Returns { bins: Map(cell -> [k]), screen, world }.
 */
export function binPoints(screen, world) {
  const bins = new Map();
  for (let k = 0; k < screen.length / 2; k++) {
    const x = screen[2 * k], y = screen[2 * k + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const key = cell(x, y);
    let b = bins.get(key); if (!b) bins.set(key, (b = [])); b.push(k);
  }
  return { bins, screen, world };
}

/** The nearest binned point to (x, y) within `radius` screen pixels: { k, d, lngLat, screen } or null. */
export function nearest(index, x, y, radius = SNAP_RADIUS) {
  if (!index) return null;
  let best = null, bd = radius * radius;
  const cx = Math.floor(x), cy = Math.floor(y), R = Math.ceil(radius);
  for (let i = cx - R; i <= cx + R; i++) for (let j = cy - R; j <= cy + R; j++) {
    const b = index.bins.get((i + OFF) * SPAN + j + OFF); if (!b) continue;
    for (const k of b) {
      const d = (index.screen[2 * k] - x) ** 2 + (index.screen[2 * k + 1] - y) ** 2;
      if (d <= bd) { bd = d; best = k; }
    }
  }
  return best === null ? null : { k: best, d: Math.sqrt(bd), lngLat: [index.world[2 * best], index.world[2 * best + 1]], screen: [index.screen[2 * best], index.screen[2 * best + 1]] };
}

/**
 * Where a vertex at (x, y) snaps among the ink's two sets ({ ridges, edges }, each binPoints'): a ridge (a
 * line's centre) within the radius wins over an edge (an area's edge), however much nearer the edge is, so
 * that a vertex drawn near a line goes onto its middle, not onto its side. As nearest, or null.
 */
export const nearestInk = (index, x, y, radius = SNAP_RADIUS) => (index ? nearest(index.ridges, x, y, radius) || nearest(index.edges, x, y, radius) : null);
