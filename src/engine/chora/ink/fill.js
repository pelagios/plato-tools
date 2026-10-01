// Filling: the pixels reached from the seed through pixels that may be passed (a scanline flood fill),
// and the guard against a fill that has escaped (a leak).
import { dilate, sqDistance } from './edt.js';

/**
 * The pixels connected to (sx, sy) through `passable` (1), 4-connected (an area: a diagonal gap in a
 * line does not let it through) or 8-connected (a line's component). Returns { region (Uint8Array),
 * count, bbox [x0, y0, x1, y1] inclusive, touchesEdge }; an empty region when the seed is not passable.
 */
export function floodFill(passable, w, h, sx, sy, { eight = false } = {}) {
  const region = new Uint8Array(w * h);
  return { region, ...fillInto(passable, region, 1, w, h, sx, sy, { eight }) };
}

/**
 * As floodFill, but writing `id` into `labels` (any typed array) for the pixels filled, and passing
 * only pixels not labelled yet: many components labelled in one array. Returns { count, bbox,
 * touchesEdge } (bbox null when the seed is not passable or labelled already).
 */
export function fillInto(passable, region, id, w, h, sx, sy, { eight = false } = {}) {
  const out = { count: 0, bbox: [sx, sy, sx, sy], touchesEdge: false };
  if (sx < 0 || sy < 0 || sx >= w || sy >= h || !passable[sy * w + sx] || region[sy * w + sx]) { out.bbox = null; return out; }
  let x0 = sx, y0 = sy, x1 = sx, y1 = sy, count = 0;
  const stack = [sx, sy];
  const open = (i) => passable[i] && !region[i];
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    const o = y * w;
    if (!open(o + x)) continue;
    let l = x, r = x;
    while (l > 0 && open(o + l - 1)) l--;
    while (r < w - 1 && open(o + r + 1)) r++;
    for (let i = l; i <= r; i++) region[o + i] = id;
    count += r - l + 1;
    if (l < x0) x0 = l; if (r > x1) x1 = r; if (y < y0) y0 = y; if (y > y1) y1 = y;
    // The rows above and below: one seed per run of open pixels.
    const a = eight ? Math.max(0, l - 1) : l, b = eight ? Math.min(w - 1, r + 1) : r;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      const no = ny * w;
      let inRun = false;
      for (let i = a; i <= b; i++) {
        if (open(no + i)) { if (!inRun) { stack.push(i, ny); inRun = true; } } else inRun = false;
      }
    }
  }
  return { count, bbox: [x0, y0, x1, y1], touchesEdge: x0 === 0 || y0 === 0 || x1 === w - 1 || y1 === h - 1 };
}

/**
 * A fill with gaps of up to 2·r pixels in its boundary bridged: the boundary (what may not be passed)
 * is grown by r, the fill made inside that, and the fill grown back by r (within what may be passed).
 * A seed closer than r to the boundary starts from the nearest pixel that is not. Same result as
 * floodFill, with `seed` the pixel actually filled from.
 */
export function bridgedFill(passable, w, h, sx, sy, r) {
  if (!(r > 0)) return { ...floodFill(passable, w, h, sx, sy), seed: [sx, sy] };
  const n = w * h, barrier = new Uint8Array(n);
  for (let i = 0; i < n; i++) barrier[i] = passable[i] ? 0 : 1;
  const grown = dilate(barrier, w, h, r);
  const open = new Uint8Array(n);
  for (let i = 0; i < n; i++) open[i] = grown[i] ? 0 : 1;
  let seed = [sx, sy];
  if (!open[sy * w + sx]) {
    // The nearest pixel that is clear of the grown boundary, within 2r of the seed.
    let best = null, bd = Infinity; const R = Math.ceil(2 * r);
    for (let j = Math.max(0, sy - R); j <= Math.min(h - 1, sy + R); j++) {
      for (let i = Math.max(0, sx - R); i <= Math.min(w - 1, sx + R); i++) {
        const d = (i - sx) ** 2 + (j - sy) ** 2;
        if (open[j * w + i] && d < bd) { bd = d; best = [i, j]; }
      }
    }
    if (!best) return { ...floodFill(open, w, h, -1, -1), seed };
    seed = best;
  }
  const inner = floodFill(open, w, h, seed[0], seed[1]);
  // Grown back by r, within what may be passed.
  const d = sqDistance(inner.region, w, h), r2 = r * r, region = new Uint8Array(n);
  let count = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] <= r2 && passable[i]) {
        region[i] = 1; count++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return { region, count, bbox: count ? [x0, y0, x1, y1] : null, touchesEdge: count > 0 && (x0 === 0 || y0 === 0 || x1 === w - 1 || y1 === h - 1), seed };
}

/** The share of the window above which a fill is taken to have escaped. */
export const LEAK_SHARE = 0.6;
/**
 * Whether a fill has escaped its shape: it touches the edge of the window, or covers more than
 * LEAK_SHARE of it. Returns null, or { reason: 'edge' | 'share', share }.
 */
export function leak(fill, w, h) {
  const share = fill.count / (w * h);
  if (fill.touchesEdge) return { reason: 'edge', share };
  if (share > LEAK_SHARE) return { reason: 'share', share };
  return null;
}
