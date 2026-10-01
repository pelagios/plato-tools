// Synthetic maps for the ink-tracing tests (test/chora-ink.test.js): RGBA drawn in code, with a seeded
// random number generator, so that every answer is known exactly. Drawing is by pixel centres: a pixel
// (x, y) is painted when its centre (x + 0.5, y + 0.5) lies inside the shape (or within half the width of
// a line), which is the convention the outline's corner coordinates are to agree with.

/** mulberry32: a seeded generator of numbers in [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** A normal deviate from a uniform generator (Box–Muller). */
export const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

export const PAPER = [240, 232, 212], INK = [35, 30, 28];

export class Raster {
  constructor(w, h, bg = PAPER) {
    this.w = w; this.h = h; this.rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) this.rgba.set([...bg, 255], i * 4);
  }
  set(x, y, c) { this.rgba.set(c, (y * this.w + x) * 4); }
  get(x, y) { const o = (y * this.w + x) * 4; return [this.rgba[o], this.rgba[o + 1], this.rgba[o + 2]]; }
  /** Every pixel whose centre satisfies inside(cx, cy), painted c (or c(x, y, old) when a function). */
  paint(inside, c, box = [0, 0, this.w - 1, this.h - 1]) {
    const [x0, y0, x1, y1] = box.map(Math.floor);
    for (let y = Math.max(0, y0); y <= Math.min(this.h - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(this.w - 1, x1); x++) {
      if (inside(x + 0.5, y + 0.5)) this.set(x, y, typeof c === 'function' ? c(x, y, this.get(x, y)) : c);
    }
    return this;
  }
  polygon(pts, c) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return this.paint((x, y) => inPolygon([x, y], pts), c, [Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1]);
  }
  disc(cx, cy, r, c) { return this.paint((x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r, c, [cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1]); }
  /**
   * A line of width `width` along the polyline: round ends, or with { cap: 'flat' } flat (butt) ends, cut
   * square across the line at its first and last points (a pen stroke, or a road ending at a border).
   */
  stroke(pts, width, c, { cap = 'round' } = {}) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), r = width / 2;
    // Beyond an end: ahead of the end point, the way the end segment runs.
    const beyond = ([x, y], [ax, ay], [bx, by]) => (x - bx) * (bx - ax) + (y - by) * (by - ay) > 0;
    const flat = cap === 'flat' && pts.length > 1;
    return this.paint((x, y) => distToPolyline([x, y], pts) <= r && !(flat && (beyond([x, y], pts[1], pts[0]) || beyond([x, y], pts.at(-2), pts.at(-1)))), c,
      [Math.min(...xs) - r - 1, Math.min(...ys) - r - 1, Math.max(...xs) + r + 1, Math.max(...ys) + r + 1]);
  }
  ring(cx, cy, r, width, c, gap = null) {
    return this.paint((x, y) => {
      const d = Math.hypot(x - cx, y - cy);
      if (Math.abs(d - r) > width / 2) return false;
      if (gap) { const a = Math.atan2(y - cy, x - cx), along = Math.abs(((a - gap.at + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) * r; if (along < gap.width / 2) return false; }
      return true;
    }, c, [cx - r - width, cy - r - width, cx + r + width, cy + r + width]);
  }
  /** Each pixel's colour changed by fn(rgb, x, y). */
  each(fn) { for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.set(x, y, fn(this.get(x, y), x, y).map((v) => Math.max(0, Math.min(255, Math.round(v))))); return this; }
  noise(r, sigma) { return this.each((c) => c.map((v) => v + sigma * gauss(r))); }
  /** Specks: single pixels of `c` scattered at `density` (foxing, dust: what a 3×3 median removes). */
  specks(r, density, c = INK) { for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (r() < density) this.set(x, y, c); return this; }
  /** JPEG-like blocks: each 8×8 block's colour offset a little, and the values quantised. */
  blocks(r, amp = 4, q = 4) {
    const off = new Map();
    return this.each((c, x, y) => { const k = (x >> 3) * 4096 + (y >> 3); if (!off.has(k)) off.set(k, (r() * 2 - 1) * amp); return c.map((v) => Math.round((v + off.get(k)) / q) * q); });
  }
}

export function inPolygon([x, y], pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function distToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}
export function distToPolyline(p, pts) { let d = Infinity; for (let k = 0; k < pts.length - 1; k++) d = Math.min(d, distToSegment(p, pts[k], pts[k + 1])); return d; }
/** The nearest point of a polyline to p. */
export function nearestOn(p, pts) {
  let best = null, bd = Infinity;
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
    const q = [a[0] + t * dx, a[1] + t * dy], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}
/** Points along a polyline every `step` pixels (for a Hausdorff distance between curves). */
export function densify(pts, step = 0.25) {
  const out = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let i = 0; i < n; i++) out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  }
  out.push(pts.at(-1));
  return out;
}
/** The Hausdorff distance between two polylines (each densified to a quarter pixel). */
export function hausdorff(A, B) {
  const da = densify(A), db = densify(B);
  let h = 0;
  for (const p of da) h = Math.max(h, distToPolyline(p, B));
  for (const p of db) h = Math.max(h, distToPolyline(p, A));
  return h;
}
const closedRing = (r) => (r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1] ? r : [...r, r[0]]);
export function area(r) { r = closedRing(r); let s = 0; for (let k = 0; k < r.length - 1; k++) s += r[k][0] * r[k + 1][1] - r[k + 1][0] * r[k][1]; return s / 2; }
export function centroid(r) {
  r = closedRing(r); let a = 0, cx = 0, cy = 0;
  for (let k = 0; k < r.length - 1; k++) { const f = r[k][0] * r[k + 1][1] - r[k + 1][0] * r[k][1]; a += f; cx += (r[k][0] + r[k + 1][0]) * f; cy += (r[k][1] + r[k + 1][1]) * f; }
  return [cx / (3 * a), cy / (3 * a)];
}
export { closedRing };
