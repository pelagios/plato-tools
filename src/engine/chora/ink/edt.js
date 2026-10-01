// The exact Euclidean distance transform (Felzenszwalb and Huttenlocher, "Distance Transforms of
// Sampled Functions", 2012): for each pixel, the squared distance in pixels to the nearest pixel of
// `source`, by the lower envelope of parabolas, a column at a time and then a row at a time. Exact, and
// linear in the number of pixels.

const INF = 1e20;

function line(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
  const cross = (q, p) => ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
  for (let q = 1; q < n; q++) {
    let s = cross(q, v[k]);
    while (s <= z[k]) { k--; s = cross(q, v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
  }
}

/**
 * Squared distance from each pixel to the nearest pixel where `source` is 1 (0 at such pixels; a
 * very large number when there is none). Float32Array.
 */
export function sqDistance(source, w, h) {
  const out = new Float32Array(w * h);
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = source[y * w + x] ? 0 : INF;
    line(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) f[x] = out[o + x];
    line(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[o + x] = d[x];
  }
  return out;
}

/** Squared distance from each pixel of `mask` (1) to the nearest pixel outside it (0); 0 outside. */
export const insideDistance = (mask, w, h) => {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 0 : 1;
  return sqDistance(out, w, h);
};

/** The mask grown by r pixels (every pixel within r of it, Euclidean), as a new mask. */
export function dilate(mask, w, h, r) {
  if (r <= 0) return Uint8Array.from(mask);
  const d = sqDistance(mask, w, h), out = new Uint8Array(mask.length), r2 = r * r;
  for (let i = 0; i < out.length; i++) out[i] = d[i] <= r2 ? 1 : 0;
  return out;
}
