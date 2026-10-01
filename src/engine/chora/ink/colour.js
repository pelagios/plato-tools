// Colour for ink tracing: CIELAB (D65) from 8-bit sRGB, as compactly as the memory plan allows.
//
// Memory (the design's amendment 6): L* is kept as Float32, a* and b* as Int8 (sRGB's a* and b* lie
// within about -108..98, so a unit of rounding is all that is lost, well under any tolerance offered);
// the RGBA the pixels came in is not kept by these functions, so the caller can let it go as soon as
// it has been converted. Lab is computed only to fill an area (or to match a colour); a line needs
// L* alone.

const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
const E = (6 / 29) ** 3, K = 1 / (3 * (6 / 29) ** 2), O = 4 / 29;
const fExact = (t) => (t > E ? Math.cbrt(t) : t * K + O);
// f by a table over [0, 1] (what sRGB gives, to within its rounding), read between its entries: within
// 1e-7 of the cube root, at a fraction of its cost (a map's every pixel, three times over).
const N = 1 << 16, F = new Float64Array(N + 2);
for (let i = 0; i <= N + 1; i++) F[i] = fExact(i / N);
const f = (t) => {
  if (!(t >= 0 && t < 1)) return fExact(t);
  const u = t * N, i = u | 0;
  return F[i] + (F[i + 1] - F[i]) * (u - i);
};
// D65 white.
const XN = 0.95047, ZN = 1.08883;

/** L* (0..100) of each pixel of RGBA (Uint8ClampedArray or Uint8Array), as Float32. */
export function lightness(rgba, w, h) {
  const n = w * h, L = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const y = 0.2126729 * LINEAR[rgba[j]] + 0.7151522 * LINEAR[rgba[j + 1]] + 0.072175 * LINEAR[rgba[j + 2]];
    L[i] = 116 * f(y) - 16;
  }
  return L;
}

/** CIELAB of each pixel: { L: Float32Array, a: Int8Array, b: Int8Array }. */
export function lab(rgba, w, h) {
  const n = w * h, L = new Float32Array(n), A = new Int8Array(n), B = new Int8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = LINEAR[rgba[j]], g = LINEAR[rgba[j + 1]], bl = LINEAR[rgba[j + 2]];
    const fx = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * bl) / XN);
    const fy = f(0.2126729 * r + 0.7151522 * g + 0.072175 * bl);
    const fz = f((0.0193339 * r + 0.119192 * g + 0.9503041 * bl) / ZN);
    L[i] = 116 * fy - 16;
    A[i] = Math.max(-128, Math.min(127, Math.round(500 * (fx - fy))));
    B[i] = Math.max(-128, Math.min(127, Math.round(200 * (fy - fz))));
  }
  return { L, a: A, b: B };
}

/** CIELAB of one sRGB colour [r, g, b] (0..255), unrounded: for tests and for describing a colour. */
export function labOf([r, g, b]) {
  const x = LINEAR[r], y = LINEAR[g], z = LINEAR[b];
  const fx = fExact((0.4124564 * x + 0.3575761 * y + 0.1804375 * z) / XN);
  const fy = fExact(0.2126729 * x + 0.7151522 * y + 0.072175 * z);
  const fz = fExact((0.0193339 * x + 0.119192 * y + 0.9503041 * z) / ZN);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * Writers for window.js's composeEach: each pixel's colour written as L* (into `L`), or as CIELAB (into
 * `L`, `a`, `b`), with no RGBA kept between.
 */
export function lightnessWriter(L) {
  // Into an Int16Array, L* at 1/64 of a unit (median.js's SCALE), as lightness() then median3 would take it.
  if (L instanceof Int16Array) return (i, r, g, b) => { L[i] = Math.round(Math.fround(116 * f(0.2126729 * LINEAR[r] + 0.7151522 * LINEAR[g] + 0.072175 * LINEAR[b]) - 16) * 64); };
  return (i, r, g, b) => { L[i] = 116 * f(0.2126729 * LINEAR[r] + 0.7151522 * LINEAR[g] + 0.072175 * LINEAR[b]) - 16; };
}
export function labWriter(L, A, B) {
  const q = L instanceof Int16Array;
  return (i, r0, g0, b0) => {
    const r = LINEAR[r0], g = LINEAR[g0], bl = LINEAR[b0];
    const fx = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * bl) / XN);
    const fy = f(0.2126729 * r + 0.7151522 * g + 0.072175 * bl);
    const fz = f((0.0193339 * r + 0.119192 * g + 0.9503041 * bl) / ZN);
    L[i] = q ? Math.round(Math.fround(116 * fy - 16) * 64) : 116 * fy - 16;
    A[i] = Math.max(-128, Math.min(127, Math.round(500 * (fx - fy))));
    B[i] = Math.max(-128, Math.min(127, Math.round(200 * (fy - fz))));
  };
}
