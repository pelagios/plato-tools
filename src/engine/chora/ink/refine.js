// A line's points to within a fraction of a pixel: each moved across the line to the centre of the ink
// there, the weighted centre of the ink's cross-section along the line's normal. A skeleton pixel is a
// whole pixel; the ink's own centre is not, and two readings of the same map (from its tiles, or from one
// image of the whole) agree on it where they may not agree on a pixel.
//
// Positions here are in the centre convention (a pixel's value sits at its centre, i + 0.5), the
// convention of the points refined.

/** The value of `V` (w × h) at (x, y), bilinearly, a pixel's value at its centre; null off the window. */
function at(V, w, h, x, y) {
  const u = x - 0.5, v = y - 0.5;
  if (u < 0 || v < 0 || u > w - 1 || v > h - 1) return null;
  const i = Math.min(w - 2, Math.floor(u)), j = Math.min(h - 2, Math.floor(v)), fx = u - i, fy = v - j;
  const o = j * w + i;
  return (V[o] * (1 - fx) + V[o + 1] * fx) * (1 - fy) + (V[o + w] * (1 - fx) + V[o + w + 1] * fx) * fy;
}

/**
 * How far along the normal (nx, ny) from (x, y) the centre of the ink is, or null when there is no
 * cross-section to measure: `ink(x, y)` the inkiness there (0 none, larger more), sampled every `step`
 * out to `half` either way; the run of ink that holds the point (or the nearest sample) alone is weighed.
 */
export function crossCentre(ink, x, y, nx, ny, half, step = 0.25, out = null) {
  const n = Math.ceil(half / step), vals = [];
  for (let k = -n; k <= n; k++) vals.push(ink(x + k * step * nx, y + k * step * ny));
  if (vals.some((v) => v === null)) return null;
  // Measured above the faintest along the profile (the paper, beside a line).
  const floor = Math.min(...vals);
  for (let k = 0; k < vals.length; k++) vals[k] -= floor;
  const peak = Math.max(...vals);
  if (!(peak > 0)) return null;
  // The run around the centre: from the middle sample (or the strongest near it) out to where ink stops.
  const cut = peak / 2, mid = n;
  let c = mid;
  if (vals[c] < cut) { let best = -1; for (let d = 1; d <= n; d++) { if (vals[mid - d] >= cut) { best = mid - d; break; } if (vals[mid + d] >= cut) { best = mid + d; break; } } if (best < 0) return null; c = best; }
  let a = c, b = c;
  while (a > 0 && vals[a - 1] >= cut) a--;
  while (b < vals.length - 1 && vals[b + 1] >= cut) b++;
  // A run reaching the end of the profile is not a cross-section of a line.
  if (a === 0 || b === vals.length - 1) return null;
  let sw = 0, s = 0;
  for (let k = a - 1; k <= b + 1; k++) { sw += vals[k]; s += vals[k] * (k - n) * step; }
  if (out) out.run = (b - a + 1) * step;
  return sw ? s / sw : null;
}

/** Inkiness from darkness: 100 − L* (crossCentre measures it above the paper beside the line). */
export const darkness = (L, w, h) => (x, y) => { const v = at(L, w, h, x, y); return v === null ? null : 100 - v; };
/** Inkiness from a mask (0/1), bilinearly. */
export const maskInk = (M, w, h) => (x, y) => at(M, w, h, x, y);

/**
 * Points [[x, y]] of a path (centre convention), each moved across the path to the ink's centre, except
 * those `skip(p)` says to leave (near a junction). The normal is the path's own, over `span` points
 * either way. Moves of more than `limit` are not made. With `wide`, a point whose cross-section of ink is
 * wider than the line about it (the median over `span` × 6 points either way) by more than `wide` pixels, or
 * with none to measure, is let go: a burr or a blot on one side, which would draw it aside. Not the path's first or last point.
 */
export function refinePath(pts, ink, { half, span = 2, limit = 1, skip = () => false, wide = Infinity } = {}) {
  const runs = new Float64Array(pts.length).fill(NaN);
  const moved = pts.map((p, k) => {
    if (skip(p)) return p;
    const a = pts[Math.max(0, k - span)], b = pts[Math.min(pts.length - 1, k + span)];
    const tx = b[0] - a[0], ty = b[1] - a[1], L = Math.hypot(tx, ty);
    if (!L) return p;
    const nx = -ty / L, ny = tx / L, out = {};
    const d = crossCentre(ink, p[0], p[1], nx, ny, half, 0.25, out);
    // No cross-section to measure, or one too far off, counts as too wide.
    runs[k] = d === null || Math.abs(d) > limit ? Infinity : out.run;
    return d === null || Math.abs(d) > limit ? p : [p[0] + d * nx, p[1] + d * ny];
  });
  if (!Number.isFinite(wide)) return moved;
  const M = 6 * span, keep = [];
  for (let k = 0; k < moved.length; k++) {
    // Only where most of the points about it were measured (their median a width): a line whose cross-sections
    // are mostly not measured keeps its points.
    if (k > 0 && k < moved.length - 1 && !Number.isNaN(runs[k])) {
      const near = [];
      for (let j = Math.max(0, k - M); j <= Math.min(moved.length - 1, k + M); j++) if (!Number.isNaN(runs[j])) near.push(runs[j]);
      near.sort((p, q) => p - q);
      if (runs[k] > near[near.length >> 1] + wide) continue;
    }
    keep.push(moved[k]);
  }
  // And a point off the chord of the points `span` either side of it by more than `wide` more than the points
  // about it are (a kink where a burr too short to branch bent the line, and its ink is not wide enough to tell):
  // let go. A curve's points are all off their chords alike, and kept.
  const n = keep.length, dev = new Float64Array(n).fill(NaN);
  for (let k = span; k < n - span; k++) {
    const a = keep[k - span], b = keep[k + span], tx = b[0] - a[0], ty = b[1] - a[1], L = Math.hypot(tx, ty);
    if (L) dev[k] = ((keep[k][0] - a[0]) * ty - (keep[k][1] - a[1]) * tx) / L;
  }
  const out = [];
  for (let k = 0; k < n; k++) {
    if (!Number.isNaN(dev[k])) {
      const near = [];
      for (let j = Math.max(0, k - M); j <= Math.min(n - 1, k + M); j++) if (!Number.isNaN(dev[j])) near.push(dev[j]);
      near.sort((p, q) => p - q);
      if (Math.abs(dev[k] - near[near.length >> 1]) > wide) continue;
    }
    out.push(keep[k]);
  }
  return out;
}
