// The 3×3 median, exactly, at a few operations a pixel: each column's three values are sorted once, and
// the median of the nine is the median of (the largest of the three smallest, the median of the three
// middles, the smallest of the three largest). Edges repeat the nearest row or column.
//
// On integers, and without a branch: a map's pixels are noisy, and a comparison on noise is a branch the
// processor cannot predict (about a hundred nanoseconds a pixel, measured; a few, so). L* (Float32) is
// taken at 1/64 of a unit, far finer than any tolerance offered, and given back as Float32.

export const SCALE = 64;

// min and max of two integers whose difference fits in 32 bits, by arithmetic alone.
const mn = (a, b) => { const d = a - b; return b + (d & (d >> 31)); };
const mx = (a, b) => { const d = a - b; return a - (d & (d >> 31)); };
const med = (a, b, c) => mx(mn(a, b), mn(mx(a, b), c));

function medianInt(src, w, h, out) {
  const lo = new Int32Array(w), mi = new Int32Array(w), hi = new Int32Array(w);
  const last = w - 1;
  for (let y = 0; y < h; y++) {
    const ra = (y > 0 ? y - 1 : 0) * w, rb = y * w, rc = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const a = src[ra + x], b = src[rb + x], c = src[rc + x];
      const s1 = mn(a, b), s2 = mx(a, b);
      lo[x] = mn(s1, c); const t = mx(s1, c); mi[x] = mn(s2, t); hi[x] = mx(s2, t);
    }
    for (let x = 0; x < w; x++) {
      const xa = x > 0 ? x - 1 : 0, xc = x < last ? x + 1 : last;
      out[rb + x] = med(mx(lo[xa], mx(lo[x], lo[xc])), med(mi[xa], mi[x], mi[xc]), mn(hi[xa], mn(hi[x], hi[xc])));
    }
  }
  return out;
}

/** L* held as integers (Int16Array, at 1/SCALE of a unit) made Float32 again. */
export function unquantise(q) {
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = q[i] / SCALE;
  return out;
}

/** The 3×3 median of one channel (an integer typed array, or Float32Array), as a new array of the same type. */
export function median3(src, w, h) {
  if (src instanceof Float32Array || src instanceof Float64Array) {
    const q = new Int32Array(src.length);
    for (let i = 0; i < src.length; i++) q[i] = Math.round(src[i] * SCALE);
    const m = medianInt(q, w, h, new Int32Array(src.length));
    const out = new src.constructor(src.length);
    for (let i = 0; i < src.length; i++) out[i] = m[i] / SCALE;
    return out;
  }
  return medianInt(src, w, h, new src.constructor(src.length));
}
