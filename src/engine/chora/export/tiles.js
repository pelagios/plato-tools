// The pictures under a map made from Chora's view (#37): which tiles of a raster background (CAWM, DARE,
// OpenStreetMap, the shaded relief) to fetch, and where each goes, in the map's own pixels. Over-zoom (Stephen's
// decision of 14 October 2026): the tiles are fetched as fine as the map's size asks, up to the provider's own
// greatest zoom, within a stated budget of tiles (TILE_BUDGET, about 400): where the finest would be more, a
// coarser zoom is taken, and the map says so. And the remap of a Web Mercator picture to the equirectangular
// projection, row by row: both have longitude in proportion across the same width, so only rows move. Pure.
import { mercX, mercY } from './project.js';

/** The most tiles fetched for one picture. */
export const TILE_BUDGET = 400;

/**
 * The tiles to fetch for a picture of Web Mercator projection `merc` (project.js mercator, at the map's size):
 * { z, ideal (the zoom whose tiles are drawn at their own size), coarser (true when the budget lowered it),
 * tiles: [{ z, x (to fetch, brought into the world), y, left, top, size (in the map's pixels) }], tooMany (the
 * coarsest allowed is still over the budget: nothing to fetch) }. `tileSize`: the tiles' own pixels (256).
 * A tile wholly outside the world's rows is not asked for.
 */
export function tilePlan(merc, { minzoom = 0, maxzoom = 19, tileSize = 256, budget = TILE_BUDGET } = {}) {
  const ideal = Math.log2(merc.world / tileSize);
  let z = Math.max(minzoom, Math.min(maxzoom, Math.ceil(ideal - 1e-9)));
  const want = z;
  const [west, south, east, north] = merc.bounds;
  const range = (zz) => {
    const n = 2 ** zz;
    const x0 = Math.floor(mercX(west) * n), x1 = Math.floor(mercX(east) * n - 1e-9);
    const y0 = Math.max(0, Math.floor(mercY(north) * n)), y1 = Math.min(n - 1, Math.floor(mercY(south) * n - 1e-9));
    return { n, x0, x1, y0, y1, count: Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1) };
  };
  let r = range(z);
  while (r.count > budget && z > minzoom) { z--; r = range(z); }
  if (r.count > budget) return { z, ideal, coarser: z < want, tiles: [], tooMany: true, count: r.count };
  const size = merc.world / r.n;
  // The world's top left corner in the map's pixels (of the copy of the world the view's centre is on): a tile's
  // place is that and its index times its size. An index west of the world (a view across 180°) is fetched as the
  // tile it is, and placed where it is drawn.
  const left0 = merc.width / 2 - mercX(merc.center[0]) * merc.world, top0 = merc.height / 2 - mercY(merc.center[1]) * merc.world;
  const tiles = [];
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
    tiles.push({ z, x: ((x % r.n) + r.n) % r.n, y, left: left0 + x * size, top: top0 + y * size, size });
  }
  return { z, ideal, coarser: z < want, tiles, tooMany: false, count: r.count };
}

/** A tile address from a template with {z}, {x} and {y}. */
export const tileUrl = (template, { z, x, y }) => template.replace('{z}', z).replace('{x}', x).replace('{y}', y);

/**
 * For each row of an equirectangular picture `equi` (project.js equirectangular), the row of the Web Mercator
 * picture `merc` over the same bounds and width that it is taken from (its middle, as a number of pixels):
 * a Float64Array of equi.height. The two have the same width and longitudes, so a row is copied whole.
 */
export function rowSources(merc, equi) {
  const [, south, , north] = equi.bounds, out = new Float64Array(equi.height);
  for (let y = 0; y < equi.height; y++) {
    const lat = north - ((y + 0.5) / equi.height) * (north - south);
    out[y] = merc.project([merc.center[0], lat])[1];
  }
  return out;
}
