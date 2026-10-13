// Geometry arithmetic for Chora (src/engine/chora/): bounding boxes and representative points of
// GeoJSON geometries, in longitude and latitude. Pure, and small: nothing here projects, so areas
// and lengths are in degrees, which is enough to choose a point to show and a box to fit the map to.
// The one measure on the ground is a circle of uncertainty (circleAround), in kilometres on a sphere.

/** The geometry types PLATO accepts (plato.schema.json, $defs/geometry): no GeometryCollection. */
export const GEOMETRY_TYPES = ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'];

const isPosition = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/** Every position of a geometry, however deeply nested. */
export function* positions(coords) {
  if (isPosition(coords)) { yield coords; return; }
  if (Array.isArray(coords)) for (const c of coords) yield* positions(c);
}

/**
 * [west, south, east, north] of a GeoJSON geometry, or null when it has no position. A geometry across
 * the antimeridian (Fiji, from 178 to -178) is boxed the short way round, with west > east as RFC 7946
 * has it: of its extent as given and its extent with every longitude east of 180 (-178 as 182), the
 * narrower. `plain` gives the extent as given, for a geometry known not to cross (a drawing).
 */
export function bboxOf(geojson, { plain = false } = {}) {
  if (!geojson || typeof geojson !== 'object') return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity, uw = Infinity, ue = -Infinity;
  for (const [x, y] of positions(geojson.coordinates)) {
    if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
    const u = x < 0 ? x + 360 : x;
    if (u < uw) uw = u; if (u > ue) ue = u;
  }
  if (w === Infinity) return null;
  if (!plain && ue - uw < e - w) return [uw > 180 ? uw - 360 : uw, s, ue > 180 ? ue - 360 : ue, n];
  return [w, s, e, n];
}
// Every longitude west of 0 taken east of 180, for arithmetic on a geometry across the antimeridian.
const unwrap = (c) => (isPosition(c) ? [c[0] < 0 ? c[0] + 360 : c[0], ...c.slice(1)] : Array.isArray(c) ? c.map(unwrap) : c);

/**
 * The smallest box holding every box given; null when none is. A box across the antimeridian has
 * west > east (RFC 7946, and public/basemap/ccodes.json for Russia or Fiji): boxes are unwrapped
 * around the first one's centre before they are joined, and the result wrapped back the same way.
 */
export function unionBbox(boxes) {
  let out = null, c0 = null;
  for (const b of boxes) {
    if (!b) continue;
    let [w, s, e, n] = b;
    if (e < w) e += 360;
    if (c0 === null) c0 = (w + e) / 2;
    const shift = Math.round((c0 - (w + e) / 2) / 360) * 360;
    w += shift; e += shift;
    out = out ? [Math.min(out[0], w), Math.min(out[1], s), Math.max(out[2], e), Math.max(out[3], n)] : [w, s, e, n];
  }
  if (!out) return null;
  if (out[2] - out[0] >= 360) return [-180, out[1], 180, out[3]];
  const wrap = (x) => (x > 180 || x < -180 ? ((((x + 180) % 360) + 360) % 360) - 180 : x);
  return [wrap(out[0]), out[1], wrap(out[2]), out[3]];
}

// A ring's signed area and centroid (the shoelace formula).
function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
  }
  a /= 2;
  return a ? { a, x: cx / (6 * a), y: cy / (6 * a) } : { a: 0 };
}
const mean = (pts) => { let x = 0, y = 0; for (const p of pts) { x += p[0]; y += p[1]; } return pts.length ? [x / pts.length, y / pts.length] : null; };
const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
function lineLength(line) { let l = 0; for (let i = 1; i < line.length; i++) l += len(line[i - 1], line[i]); return l; }
/** The point half way along a line, measured along it. */
function midpoint(line) {
  const half = lineLength(line) / 2;
  if (!half) return line.length ? [line[0][0], line[0][1]] : null;
  let at = 0;
  for (let i = 1; i < line.length; i++) {
    const d = len(line[i - 1], line[i]);
    if (at + d >= half) { const t = (half - at) / d; return [line[i - 1][0] + t * (line[i][0] - line[i - 1][0]), line[i - 1][1] + t * (line[i][1] - line[i - 1][1])]; }
    at += d;
  }
  return [line[line.length - 1][0], line[line.length - 1][1]];
}

/**
 * A representative point, [lon, lat]: the point itself; the mean of several points; the point half
 * way along a line (the longest, of several); the centroid of a polygon's area, holes taken out
 * (of all a multipolygon's parts together). A polygon of no area falls back to its vertices' mean.
 * A geometry across the antimeridian (bboxOf) has its point worked out on its longitudes unwrapped,
 * then put back between -180 and 180; `plain` takes it as given, as bboxOf does.
 */
export function reprPointOf(geojson, { plain = false } = {}) {
  if (!geojson || typeof geojson !== 'object') return null;
  const b = plain ? null : bboxOf(geojson);
  if (b && b[0] > b[2]) {
    const p = pointOf(geojson.type, unwrap(geojson.coordinates));
    return p && [p[0] > 180 ? p[0] - 360 : p[0], p[1]];
  }
  return pointOf(geojson.type, geojson.coordinates);
}
function pointOf(type, c) {
  switch (type) {
    case 'Point': return isPosition(c) ? [c[0], c[1]] : null;
    case 'MultiPoint': return mean([...positions(c)]);
    case 'LineString': return Array.isArray(c) ? midpoint(c.filter(isPosition)) : null;
    case 'MultiLineString': {
      if (!Array.isArray(c) || !c.length) return null;
      const longest = c.reduce((best, l) => (lineLength(l) > lineLength(best) ? l : best), c[0]);
      return midpoint(longest.filter(isPosition));
    }
    case 'Polygon': case 'MultiPolygon': {
      const polys = type === 'Polygon' ? [c] : c;
      let a = 0, x = 0, y = 0;
      for (const poly of polys || []) for (const [i, ring] of (poly || []).entries()) {
        const r = ringCentroid(ring.filter(isPosition));
        if (!r.a) continue;
        // The outer ring counts positively and each hole negatively, whatever way each winds.
        const w = i === 0 ? Math.abs(r.a) : -Math.abs(r.a);
        a += w; x += r.x * w; y += r.y * w;
      }
      return a ? [x / a, y / a] : mean([...positions(c)]);
    }
    default: return null;
  }
}

/**
 * A PLATO geometry as GeoJSON to draw: its geojson; else its reprPoint as a point; else a WKT POINT.
 * Null when it has nothing that can be drawn (a WKT polygon, which these tools do not parse here).
 */
export function drawable(g) {
  if (!g || typeof g !== 'object') return null;
  if (g.geojson && GEOMETRY_TYPES.includes(g.geojson.type) && bboxOf(g.geojson)) return g.geojson;
  if (isPosition(g.reprPoint)) return { type: 'Point', coordinates: [g.reprPoint[0], g.reprPoint[1]] };
  const m = typeof g.wkt === 'string' && g.wkt.match(/^\s*POINT\s*Z?\s*\(\s*(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/i);
  if (m && Number.isFinite(+m[1]) && Number.isFinite(+m[2])) return { type: 'Point', coordinates: [+m[1], +m[2]] };
  return null;
}

/** The earth's mean radius, in kilometres (IUGG): a circle of uncertainty is drawn on a sphere of it. */
export const EARTH_KM = 6371.0088;
const RAD = Math.PI / 180;
/**
 * A circle of `km` kilometres around [lon, lat], as a GeoJSON Polygon: `n` points at that great-circle
 * distance, one every 360/n degrees of bearing, from north and anticlockwise (west first), as RFC 7946
 * winds an outer ring. It is drawn on the earth, not on the screen,
 * so the map projects it with everything else: its size is right at any zoom and at any latitude
 * (Web Mercator, being conformal, draws a small one round, and larger toward the poles, as it draws
 * everything there). A fixed radius in pixels would be right at one zoom and one latitude only. A
 * sphere, not the ellipsoid: the difference is at most about 0.5% of the radius, below what an
 * uncertainty given in kilometres says.
 * Longitudes run on unbroken from the centre's, past 180 where the circle crosses the antimeridian, as
 * MapLibre draws them. A circle around a pole (the pole within `km`) goes round it, and is closed
 * through the pole. Null for no centre, or a radius that is not a finite number above 0; null too for
 * a radius that reaches past the equator by more than the centre's own latitude (km / R ≥ π/2 + |lat|):
 * such a circle would hold more of the far hemisphere than of its own, and as a polygon on the map it
 * fills the world outside a small hole (circleTooLarge says which, for the card).
 */
export const circleTooLarge = (centre, km) => isPosition(centre) && Number.isFinite(km) && km / EARTH_KM >= Math.PI / 2 + Math.abs(centre[1]) * RAD;
export function circleAround(centre, km, n = 64) {
  if (!isPosition(centre) || !Number.isFinite(km) || km <= 0 || !(n >= 3) || circleTooLarge(centre, km)) return null;
  const d = km / EARTH_KM;
  const [lon0, lat0] = centre, φ1 = lat0 * RAD, λ1 = lon0 * RAD;
  const ring = [];
  let prev = lon0;
  for (let i = 0; i < n; i++) {
    const θ = (-2 * Math.PI * i) / n;
    const φ2 = Math.asin(Math.min(1, Math.max(-1, Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(θ))));
    let λ2 = (λ1 + Math.atan2(Math.sin(θ) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2))) / RAD;
    // Unbroken from the point before: never a jump of more than half the world.
    λ2 += Math.round((prev - λ2) / 360) * 360;
    ring.push([λ2, φ2 / RAD]); prev = λ2;
  }
  // The first point again, as near as it lies to the last: 360 degrees away when the ring went once
  // round, so that the circle holds a pole. It is then carried on to the first point again through
  // that pole (its latitude, ±90), and the polygon covers the cap around it, as on the ground.
  const again = ring[0][0] + Math.round((prev - ring[0][0]) / 360) * 360;
  if (again !== ring[0][0]) {
    const pole = (90 - lat0) * RAD < d ? 90 : -90;
    ring.push([again, ring[0][1]], [again, pole], [ring[0][0], pole]);
  }
  ring.push([ring[0][0], ring[0][1]]);
  // Anticlockwise on the map's plane, which a ring closed through a pole may not be as made.
  if (ringCentroid(ring).a < 0) ring.reverse();
  return { type: 'Polygon', coordinates: [ring] };
}
