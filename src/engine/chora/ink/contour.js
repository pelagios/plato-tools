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

/**
 * The outline of region (1 = filled) within bbox [x0, y0, x1, y1] (inclusive) of a w-wide grid, as the
 * polygon holding the point `at` (else the largest): { outer, holes } in window corner coordinates,
 * each ring closed. `cover`, when given, places it within the pixels (see below).
 */
export function outline(region, w, bbox, at, cover = null) {
  const [x0, y0, x1, y1] = bbox;
  // One empty pixel all round, so that a region touching the box is closed.
  const cw = x1 - x0 + 3, ch = y1 - y0 + 3, grid = new Float64Array(cw * ch);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[(y - y0 + 1) * cw + (x - x0 + 1)] = region[y * w + x];
  // With `cover(x, y)` (each pixel's share covered by the region's colour, 0..1), the outline is put where
  // the cover crosses one half, between the pixels on either side of it, so that it moves smoothly as the
  // pixels' colours do (a pixel of the region less than half covered falls just outside it, one beside it
  // more than half covered just inside). A pixel farther from the region is never taken above a half:
  // like-coloured ink beyond a line stays out. A hard edge (cover 1 against 0) stays on the pixels' edge.
  if (cover) {
    for (let y = Math.max(0, y0 - 1); y <= y1 + 1; y++) for (let x = Math.max(0, x0 - 1); x <= x1 + 1; x++) {
      if (x >= w || y >= region.length / w) continue;
      const gi = (y - y0 + 1) * cw + (x - x0 + 1);
      if (gi < 0 || gi >= grid.length || x - x0 + 1 >= cw) continue;
      const inR = (xx, yy) => xx >= x0 && xx <= x1 && yy >= y0 && yy <= y1 && region[yy * w + xx] === 1;
      // Only pixels near the region's edge are placed by their cover (within two pixels: an edge blurred by
      // a scan or by resampling spans that many); within the region they are 1, away from it 0.
      const self = inR(x, y);
      let near = self, beside = self, all = self;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (!dx && !dy) continue;
        const v = inR(x + dx, y + dy);
        near ||= v; all &&= v;
        if (dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1) beside ||= v;
      }
      const c = all ? 1 : near ? Math.max(0, Math.min(1, cover(x, y))) : 0;
      grid[gi] = beside ? c : Math.min(0.5 - 1e-6, c);
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
