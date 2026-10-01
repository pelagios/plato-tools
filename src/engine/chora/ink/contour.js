// The outline of a filled region: d3-contour (ISC) on the region's 0/1 grid at the threshold 0.5.
//
// Coordinates: d3-contour 4 gives the value of grid cell (i, j) to the square [i, i+1] × [j, j+1], so its
// coordinates are pixel CORNERS: a lone pixel at (2, 1) comes out as a diamond about (2.5, 1.5). IIIF
// regions are corner-based too, so a contour's coordinates are taken as they are, with no half-pixel
// added (skeleton pixels are another matter: follow.js's pixels are taken at their centres, +0.5).
import { contours } from 'd3-contour';

const ringArea = (r) => { let s = 0; for (let k = 0; k < r.length - 1; k++) s += r[k][0] * r[k + 1][1] - r[k + 1][0] * r[k][1]; return s / 2; };
function inRing([x, y], r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export { ringArea, inRing };

/** A mask (any values: set when not 0) grown by r pixels each way, square (Chebyshev), as a new mask. */
function grow(m, w, h, r) {
  // Running counts of the set pixels within r, across and then down.
  const a = new Uint8Array(w * h), b = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let k = 0;
    for (let x = 0; x < Math.min(r, w); x++) if (m[o + x]) k++;
    for (let x = 0; x < w; x++) {
      if (x + r < w && m[o + x + r]) k++;
      if (x - r - 1 >= 0 && m[o + x - r - 1]) k--;
      a[o + x] = k ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let k = 0;
    for (let y = 0; y < Math.min(r, h); y++) if (a[y * w + x]) k++;
    for (let y = 0; y < h; y++) {
      if (y + r < h && a[(y + r) * w + x]) k++;
      if (y - r - 1 >= 0 && a[(y - r - 1) * w + x]) k--;
      b[y * w + x] = k ? 1 : 0;
    }
  }
  return b;
}

/**
 * The outline of region (1 = filled) within bbox [x0, y0, x1, y1] (inclusive) of a w-wide grid, as the
 * polygon holding the point `at` (else the largest): { outer, holes } in window corner coordinates,
 * each ring closed. `cover`, when given, places it within the pixels (see below).
 */
export function outline(region, w, bbox, at, cover = null) {
  const [x0, y0, x1, y1] = bbox;
  // One empty pixel all round, so that a region touching the box is closed.
  // Float32 (d3-contour reads any array of numbers): half the bytes (a fill the size of a 2048² window,
  // 16 MB rather than 32; ink_memory.mjs's area, its box about 600², 1.8 MB less at the peak).
  const cw = x1 - x0 + 3, ch = y1 - y0 + 3, grid = new Float32Array(cw * ch);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[(y - y0 + 1) * cw + (x - x0 + 1)] = region[y * w + x];
  // With `cover(x, y)` (each pixel's share covered by the region's colour, 0..1), the outline is put where
  // the cover crosses one half, between the pixels on either side of it, so that it moves smoothly as the
  // pixels' colours do (a pixel of the region less than half covered falls just outside it, one beside it
  // more than half covered just inside). A pixel farther from the region is never taken above a half:
  // like-coloured ink beyond a line stays out. A hard edge (cover 1 against 0) stays on the pixels' edge.
  if (cover) {
    // Which pixels are near the edge, by masks over the grid (a pixel's 25 neighbours read one by one cost
    // more than the rest of the trace): the edge, where a pixel and its neighbour right or below differ;
    // `near`, within two pixels of it (an edge blurred by a scan or by resampling spans that many); and
    // `beside`, within one pixel of the region.
    const n = cw * ch, edge = new Uint8Array(n);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = y * cw + x, v = grid[i];
      if (x + 1 < cw && grid[i + 1] !== v) { edge[i] = 1; edge[i + 1] = 1; }
      if (y + 1 < ch && grid[i + cw] !== v) { edge[i] = 1; edge[i + cw] = 1; }
    }
    const near = grow(edge, cw, ch, 2), beside = grow(grid, cw, ch, 1);
    for (let gy = 0; gy < ch; gy++) for (let gx = 0; gx < cw; gx++) {
      const gi = gy * cw + gx;
      if (!near[gi]) continue;   // within the region 1, away from it 0, as already set
      const x = gx + x0 - 1, y = gy + y0 - 1;
      if (x < 0 || y < 0 || x >= w || y >= region.length / w) continue;
      const c = Math.max(0, Math.min(1, cover(x, y)));
      grid[gi] = beside[gi] ? c : Math.min(0.5 - 1e-6, c);
    }
  }
  const [mp] = contours().size([cw, ch]).thresholds([0.5])(grid).map((c) => c.coordinates);
  const shift = (r) => r.map(([x, y]) => [x + x0 - 1, y + y0 - 1]);
  const polys = (mp || []).map((p) => p.map(shift));
  if (!polys.length) return null;
  const hit = at && polys.find((p) => inRing(at, p[0]) && !p.slice(1).some((h) => inRing(at, h)));
  const best = hit || polys.reduce((a, b) => (Math.abs(ringArea(b[0])) > Math.abs(ringArea(a[0])) ? b : a));
  return { outer: best[0], holes: best.slice(1) };
}

/** Holes kept: those of at least `minArea` square pixels (all of them when minArea is 0). */
export const keepHoles = (holes, minArea) => holes.filter((h) => Math.abs(ringArea(h)) >= minArea);
