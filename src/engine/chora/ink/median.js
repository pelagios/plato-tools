// The 3×3 median, exactly, at a few comparisons a pixel: each column's three values are sorted once,
// and the median of the nine is the median of (the largest of the three smallest, the median of the
// three middles, the smallest of the three largest). Edges repeat the nearest row or column.

// Branch-free: Math.min and Math.max compile to single instructions, where comparisons on a map's pixels
// (noise) would mispredict.
const { min, max } = Math;
const med3 = (a, b, c) => max(min(a, b), min(max(a, b), c));

/** The 3×3 median of one channel (any typed array), as a new array of the same type. */
export function median3(src, w, h) {
  const out = new src.constructor(src.length);
  const lo = new Float64Array(w), mi = new Float64Array(w), hi = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    const ra = (y > 0 ? y - 1 : 0) * w, rb = y * w, rc = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const a = src[ra + x], b = src[rb + x], c = src[rc + x];
      const s1 = min(a, b), s2 = max(a, b), t = max(s1, c);
      lo[x] = min(s1, c); mi[x] = min(s2, t); hi[x] = max(s2, t);
    }
    const last = w - 1;
    for (let x = 0; x < w; x++) {
      const xa = x > 0 ? x - 1 : 0, xc = x < last ? x + 1 : last;
      const mx = max(lo[xa], max(lo[x], lo[xc]));
      const md = med3(mi[xa], mi[x], mi[xc]);
      const mn = min(hi[xa], min(hi[x], hi[xc]));
      out[rb + x] = med3(mx, md, mn);
    }
  }
  return out;
}
