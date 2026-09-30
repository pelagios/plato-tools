// Geometry arithmetic for Chora (src/engine/chora/): bounding boxes and representative points of
// GeoJSON geometries, in longitude and latitude. Pure, and small: nothing here projects, so areas
// and lengths are in degrees, which is enough to choose a point to show and a box to fit the map to.

/** The geometry types PLATO accepts (plato.schema.json, $defs/geometry): no GeometryCollection. */
export const GEOMETRY_TYPES = ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'];

const isPosition = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/** Every position of a geometry, however deeply nested. */
export function* positions(coords) {
  if (isPosition(coords)) { yield coords; return; }
  if (Array.isArray(coords)) for (const c of coords) yield* positions(c);
}

/** [west, south, east, north] of a GeoJSON geometry, or null when it has no position. */
export function bboxOf(geojson) {
  if (!geojson || typeof geojson !== 'object') return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of positions(geojson.coordinates)) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
  return w === Infinity ? null : [w, s, e, n];
}

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
 */
export function reprPointOf(geojson) {
  if (!geojson || typeof geojson !== 'object') return null;
  const c = geojson.coordinates;
  switch (geojson.type) {
    case 'Point': return isPosition(c) ? [c[0], c[1]] : null;
    case 'MultiPoint': return mean([...positions(c)]);
    case 'LineString': return Array.isArray(c) ? midpoint(c.filter(isPosition)) : null;
    case 'MultiLineString': {
      if (!Array.isArray(c) || !c.length) return null;
      const longest = c.reduce((best, l) => (lineLength(l) > lineLength(best) ? l : best), c[0]);
      return midpoint(longest.filter(isPosition));
    }
    case 'Polygon': case 'MultiPolygon': {
      const polys = geojson.type === 'Polygon' ? [c] : c;
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
