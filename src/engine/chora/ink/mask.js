// What counts as ink, as a mask of 0 and 1 over the window (Uint8Array, row by row).
//
// - deltaEMask: like the seed's colour, within a tolerance of CIE76 ΔE (an area's fill; a line in
//   "match this colour").
// - sauvolaMask: darker than its neighbourhood, by Sauvola's adaptive threshold on L* (a line). A
//   threshold that follows the paper's own shade copes with a vignette, a stain, a fold's shadow,
//   where one threshold for the whole window does not (globalMask, Otsu's, kept as the control the
//   tests show failing).

/** The median L*, a*, b* of the (2r+1)² pixels around (x, y), clipped to the window. */
export function seedColour({ L, a, b }, w, h, x, y, r = 2) {
  const ls = [], as = [], bs = [];
  for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++) {
    for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) { const k = j * w + i; ls.push(L[k]); as.push(a[k]); bs.push(b[k]); }
  }
  const med = (v) => { v.sort((p, q) => p - q); return v[v.length >> 1]; };
  return [med(ls), med(as), med(bs)];
}

/** 1 where the colour is within `tol` (ΔE76) of `colour` [L, a, b]. */
export function deltaEMask({ L, a, b }, w, h, colour, tol) {
  const n = w * h, m = new Uint8Array(n), t2 = tol * tol;
  const [l0, a0, b0] = colour;
  for (let i = 0; i < n; i++) {
    const dl = L[i] - l0, da = a[i] - a0, db = b[i] - b0;
    m[i] = dl * dl + da * da + db * db <= t2 ? 1 : 0;
  }
  return m;
}

/**
 * 1 where L* is below Sauvola's threshold m·(1 + k·(s/R − 1)), m and s the mean and standard deviation
 * of L* over the (2·radius+1)² window around the pixel (clipped to the image). R is the dynamic range of
 * the standard deviation (50 for L*, half its range). Running sums: memory a few rows, not the image.
 */
export function sauvolaMask(L, w, h, { radius = 15, k = 0.1, R = 50 } = {}) {
  const m = new Uint8Array(w * h);
  const colSum = new Float64Array(w), colSq = new Float64Array(w);
  const add = (y, sign) => { const o = y * w; for (let x = 0; x < w; x++) { const v = L[o + x]; colSum[x] += sign * v; colSq[x] += sign * v * v; } };
  for (let y = 0; y <= Math.min(radius, h - 1); y++) add(y, 1);
  for (let y = 0; y < h; y++) {
    if (y > 0) {
      if (y + radius < h) add(y + radius, 1);
      if (y - radius - 1 >= 0) add(y - radius - 1, -1);
    }
    const rows = Math.min(h - 1, y + radius) - Math.max(0, y - radius) + 1;
    let s = 0, q = 0;
    for (let x = 0; x <= Math.min(radius, w - 1); x++) { s += colSum[x]; q += colSq[x]; }
    const o = y * w;
    for (let x = 0; x < w; x++) {
      if (x > 0) {
        if (x + radius < w) { s += colSum[x + radius]; q += colSq[x + radius]; }
        if (x - radius - 1 >= 0) { s -= colSum[x - radius - 1]; q -= colSq[x - radius - 1]; }
      }
      const cnt = rows * (Math.min(w - 1, x + radius) - Math.max(0, x - radius) + 1);
      const mean = s / cnt, sd = Math.sqrt(Math.max(0, q / cnt - mean * mean));
      m[o + x] = L[o + x] < mean * (1 + k * (sd / R - 1)) ? 1 : 0;
    }
  }
  return m;
}

/** Otsu's threshold over the whole window: 1 where L* is below it. The control for sauvolaMask. */
export function globalMask(L, w, h) {
  const bins = new Float64Array(101);
  for (let i = 0; i < w * h; i++) bins[Math.max(0, Math.min(100, Math.round(L[i])))]++;
  const n = w * h; let sum = 0; for (let i = 0; i <= 100; i++) sum += i * bins[i];
  let wb = 0, sb = 0, best = -1, t = 50;
  for (let i = 0; i <= 100; i++) {
    wb += bins[i]; if (!wb) continue;
    const wf = n - wb; if (!wf) break;
    sb += i * bins[i];
    const between = wb * wf * (sb / wb - (sum - sb) / wf) ** 2;
    if (between > best) { best = between; t = i; }
  }
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = L[i] <= t + 0.5 ? 1 : 0;
  return m;
}

/** The darkest pixel within `r` of (x, y) (a disc, clipped to the window): [x, y]. Ties: the nearest. */
export function darkest(L, w, h, x, y, r) {
  let best = [x, y], bl = Infinity, bd = Infinity;
  const ri = Math.ceil(r);
  for (let j = Math.max(0, y - ri); j <= Math.min(h - 1, y + ri); j++) {
    for (let i = Math.max(0, x - ri); i <= Math.min(w - 1, x + ri); i++) {
      const d = (i - x) ** 2 + (j - y) ** 2;
      if (d > r * r) continue;
      const l = L[j * w + i];
      if (l < bl || (l === bl && d < bd)) { bl = l; bd = d; best = [i, j]; }
    }
  }
  return best;
}
