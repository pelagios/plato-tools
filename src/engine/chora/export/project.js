// The projections of a map made from Chora's view (#37, "Make an open map"; Stephen's decisions of 14
// October 2026): Web Mercator, exactly as MapLibre draws the view on the screen, and an equirectangular
// projection, so that the file can serve as a Wikipedia location map's base (Module:Location map places a
// point by its latitude and longitude, both in proportion). No equal-area projection.
//
// A view is what Chora's map shows: { center: [lon, lat], zoom, width, height } in CSS pixels, north up,
// with no tilt (MapLibre's own: its world is TILE pixels wide at zoom 0, 2^zoom times that at a zoom). The
// map made from it covers the same ground at `width` pixels of its own (exportView): the zoom is raised by
// the ratio, so nothing moves. Pure: nothing here draws or fetches.

/** MapLibre's world at zoom 0, in pixels: 512 (its tiles are drawn 512 pixels wide at their own zoom). */
export const TILE = 512;
/** Web Mercator's limit of latitude, as MapLibre clamps it. */
export const MAX_LAT = 85.051129;
/** The radius Web Mercator is drawn on, in metres (WGS 84's semi-major axis). */
export const EARTH_M = 6378137;
const RAD = Math.PI / 180;
const clampLat = (lat) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));

/** A longitude as a share of Web Mercator's world, from 0 (180° W) to 1 (180° E): MapLibre's mercatorXfromLng. */
export const mercX = (lon) => (180 + lon) / 360;
/** A latitude as a share of Web Mercator's world, from 0 (the top) to 1 (the bottom): MapLibre's mercatorYfromLat. */
export const mercY = (lat) => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (clampLat(lat) * RAD) / 2))) / 360;
const lonOfX = (x) => x * 360 - 180;
const latOfY = (y) => (360 / Math.PI) * Math.atan(Math.exp(((180 - y * 360) * Math.PI) / 180)) - 90;
/** The view's centre, its longitude brought between -180 and 180 (a map panned round the world says 190 for -170). */
const centreOf = (view) => [((((view.center[0] + 180) % 360) + 360) % 360) - 180, clampLat(view.center[1])];

/**
 * The view as the map made from it at `width` pixels (a whole number, at least 1): the same ground, its
 * height in proportion (rounded), its zoom raised by log2 of the ratio. `width` defaults to the view's own.
 */
export function exportView(view, width = view.width) {
  const w = Math.max(1, Math.round(width)), k = w / view.width;
  return { center: centreOf(view), zoom: view.zoom + Math.log2(k), width: w, height: Math.max(1, Math.round(view.height * k)) };
}

/**
 * Web Mercator, as MapLibre draws the view: { kind, width, height, zoom, project([lon, lat]) -> [x, y] in
 * pixels from the top left, unproject([x, y]) -> [lon, lat], bounds: [west, south, east, north] of the
 * view, metresPerPixel(lat): the scale along a parallel and a meridian alike at that latitude (Mercator
 * is conformal) }. A longitude is projected onto the copy of the world nearest the view's centre, as
 * MapLibre draws a place near the antimeridian on the side the view is on.
 */
export function mercator(view) {
  const [clon, clat] = centreOf(view);
  const world = TILE * 2 ** view.zoom, cx = mercX(clon) * world, cy = mercY(clat) * world;
  const { width, height } = view;
  const project = ([lon, lat]) => {
    let x = mercX(lon) * world - cx;
    x -= Math.round(x / world) * world;   // the copy of the world nearest the centre
    return [x + width / 2, mercY(lat) * world - cy + height / 2];
  };
  const unproject = ([x, y]) => [lonOfX((x - width / 2 + cx) / world), latOfY((y - height / 2 + cy) / world)];
  const [west, north] = unproject([0, 0]), [east, south] = unproject([width, height]);
  return {
    kind: 'mercator', width, height, zoom: view.zoom, center: [clon, clat], world, project, unproject, bounds: [west, south, east, north],
    metresPerPixel: (lat) => (2 * Math.PI * EARTH_M * Math.cos(clampLat(lat) * RAD)) / world,
  };
}

/**
 * Equirectangular over the same bounds as the Mercator view (so the same places are on it): longitude and
 * latitude each in proportion across the map, true to scale along the parallel through the middle of the
 * view (its standard parallel), so that the map is not stretched there. Its width is the view's; its
 * height follows from the bounds and the standard parallel. { kind, width, height, bounds, standard,
 * project, unproject, metresPerPixel(lat): along a parallel at that latitude; metresPerPixelY: along a
 * meridian, the same everywhere }.
 */
export function equirectangular(view) {
  const m = mercator(view);
  const [west, south, east, north] = m.bounds;
  const standard = (south + north) / 2, cos0 = Math.cos(standard * RAD);
  const span = east - west, width = view.width;
  const height = Math.max(1, Math.round((width * (north - south)) / (span * cos0)));
  const project = ([lon, lat]) => {
    let l = lon - west;
    l -= Math.floor(l / 360) * 360;                 // east of the west edge, round the world once at most
    if (l > span + (360 - span) / 2) l -= 360;      // nearer the west edge from the west side
    return [(l / span) * width, ((north - lat) / (north - south)) * height];
  };
  const unproject = ([x, y]) => [west + (x / width) * span, north - (y / height) * (north - south)];
  const perDegree = (2 * Math.PI * EARTH_M) / 360;
  return {
    kind: 'equirectangular', width, height, center: m.center, zoom: view.zoom, standard, project, unproject, bounds: [west, south, east, north],
    metresPerPixel: (lat) => (perDegree * span * Math.cos(clampLat(lat) * RAD)) / width,
    metresPerPixelY: (perDegree * (north - south)) / height,
  };
}

/** The projection called `kind` ('mercator' or 'equirectangular') of a view; a TypeError for any other. */
export function projectionOf(kind, view) {
  if (kind === 'mercator') return mercator(view);
  if (kind === 'equirectangular') return equirectangular(view);
  throw new TypeError(`"${kind}" is not a projection these tools make maps in (mercator, equirectangular).`);
}

/** The projections in words, for the panel and the Commons description. */
export const PROJECTION_WORDS = {
  mercator: 'Web Mercator (as the map is shown on screen)',
  equirectangular: 'equirectangular (latitude and longitude in proportion: a base for a Wikipedia location map)',
};
/** Each projection's name as Commons' {{Map}} template takes it. */
export const PROJECTION_NAMES = { mercator: 'Web Mercator (EPSG:3857)', equirectangular: 'Equirectangular' };
