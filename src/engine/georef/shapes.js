// Pixel geometries: a GeoJSON-shaped geometry, a media-fragment region ("xywh=pixel:x,y,w,h"), or
// an SVG selector, all read into one GeoJSON-shaped geometry in pixels. Also the ring utilities
// the transformations share (closing, orientation, point in polygon).
import { DataError } from '../input.js';

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const numbers = (s) => (String(s).match(NUM) || []).map(Number);
/** How many straight sides stand in for a circle or an ellipse. */
export const CIRCLE_SIDES = 64;

const same = (a, b) => a[0] === b[0] && a[1] === b[1];
export function closeRing(ring) {
  if (!ring.length) return ring;
  return same(ring[0], ring[ring.length - 1]) ? ring : [...ring, ring[0]];
}
export function openRing(ring) {
  return ring.length > 1 && same(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring;
}
/** Twice the signed area (shoelace); positive is counter-clockwise when y points up. */
export function signedArea2(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return a;
}
/** Is the point inside the ring (even-odd rule)? Points on the boundary count as inside. */
export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (onSegment([x, y], [xi, yi], [xj, yj])) return true;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function onRing(p, ring) {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) if (onSegment(p, ring[i], ring[j])) return true;
  return false;
}
function onSegment(p, a, b) {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (Math.abs(cross) > 1e-9 * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]))) return false;
  return Math.min(a[0], b[0]) - 1e-9 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-9
    && Math.min(a[1], b[1]) - 1e-9 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-9;
}
/** Do the segments cross properly (each strictly separates the other's ends)? */
export function segmentsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/** Every vertex of a geometry, whatever its type. */
export function vertices(geometry) {
  const c = geometry.coordinates;
  switch (geometry.type) {
    case 'Point': return [c];
    case 'MultiPoint': case 'LineString': return c;
    case 'MultiLineString': case 'Polygon': return c.flat(1);
    case 'MultiPolygon': return c.flat(2);
  }
  return [];
}
/** Every straight edge of a geometry (a ring's closing edge included). */
export function edges(geometry) {
  const c = geometry.coordinates, out = [];
  const line = (l) => { for (let i = 1; i < l.length; i++) out.push([l[i - 1], l[i]]); };
  const ring = (r) => line(closeRing(r));
  switch (geometry.type) {
    case 'LineString': line(c); break;
    case 'MultiLineString': c.forEach(line); break;
    case 'Polygon': c.forEach(ring); break;
    case 'MultiPolygon': c.forEach((p) => p.forEach(ring)); break;
  }
  return out;
}

// ---- GeoJSON-shaped geometries ---------------------------------------------------------------

const TYPES = ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'];
function position(p, what) {
  if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
    throw new DataError(`${what} has a position that is not a pair of numbers (${JSON.stringify(p)}).`);
  }
  return [p[0], p[1]];
}
function line(l, what) {
  if (!Array.isArray(l) || l.length < 2) throw new DataError(`${what} has a line with fewer than two positions.`);
  return l.map((p) => position(p, what));
}
function ring(r, what) {
  if (!Array.isArray(r)) throw new DataError(`${what} has a ring that is not a list of positions.`);
  const open = openRing(r.map((p) => position(p, what)));
  if (open.length < 3) throw new DataError(`${what} has a ring with fewer than three distinct positions.`);
  return closeRing(open);
}
function polygon(rings, what) {
  if (!Array.isArray(rings) || !rings.length) throw new DataError(`${what} has a polygon with no rings.`);
  return rings.map((r) => ring(r, what));
}

/**
 * Check a GeoJSON geometry (or the geometry of a Feature) and return a clean copy: positions
 * cut to two numbers, rings closed. A GeometryCollection, or a mixture, is refused.
 */
export function readGeojson(g, what = 'The geometry') {
  if (g && g.type === 'Feature') g = g.geometry;
  if (!g || typeof g !== 'object') throw new DataError(`${what} is not a GeoJSON geometry.`);
  if (g.type === 'GeometryCollection') {
    throw new DataError(`${what} is a GeometryCollection, which is not transformed: give one geometry, or one Multi- geometry of a single kind.`);
  }
  if (g.type === 'FeatureCollection') throw new DataError(`${what} is a FeatureCollection: give one geometry at a time.`);
  if (!TYPES.includes(g.type)) throw new DataError(`${what} is not a GeoJSON geometry (its type is ${JSON.stringify(g.type)}).`);
  const c = g.coordinates;
  if (!Array.isArray(c)) throw new DataError(`${what} has no coordinates.`);
  switch (g.type) {
    case 'Point': return { type: 'Point', coordinates: position(c, what) };
    case 'MultiPoint': return { type: 'MultiPoint', coordinates: c.map((p) => position(p, what)) };
    case 'LineString': return { type: 'LineString', coordinates: line(c, what) };
    case 'MultiLineString': return { type: 'MultiLineString', coordinates: c.map((l) => line(l, what)) };
    case 'Polygon': return { type: 'Polygon', coordinates: polygon(c, what) };
    case 'MultiPolygon': return { type: 'MultiPolygon', coordinates: c.map((p) => polygon(p, what)) };
  }
}

// ---- Regions (media fragments) ---------------------------------------------------------------

/**
 * A media-fragment region, "x,y,w,h", with an optional "xywh=" and an optional "pixel:" or
 * "percent:" unit. Percent is supported, as a share of the width and height of the space given.
 * Returns { region (as written, without "xywh=" or "pixel:"), percent, x, y, w, h }.
 */
export function parseXywh(text) {
  const m = /^\s*(?:xywh=)?(pixel:|percent:)?\s*([^,]+),([^,]+),([^,]+),([^,]+)\s*$/.exec(String(text));
  const vals = m ? m.slice(2).map((s) => (/^\s*[-+]?(?:\d+\.?\d*|\.\d+)\s*$/.test(s) ? Number(s) : NaN)) : [];
  if (!m || vals.some((v) => !Number.isFinite(v))) {
    throw new DataError(`The region ${JSON.stringify(text)} is not of the form x,y,w,h (optionally "pixel:" or "percent:" before it).`);
  }
  const [x, y, w, h] = vals;
  if (!(w > 0 && h > 0)) throw new DataError(`The region ${JSON.stringify(text)} has no area: its width and height must be more than 0.`);
  const percent = m[1] === 'percent:';
  return { region: `${percent ? 'percent:' : ''}${vals.join(',')}`, percent, x, y, w, h };
}
/** A region as a closed polygon in pixels of a space of the given size (needed only for percent). */
export function xywhPolygon({ percent, x, y, w, h }, size) {
  if (percent) {
    const sx = size.width / 100, sy = size.height / 100;
    [x, w] = [x * sx, w * sx]; [y, h] = [y * sy, h * sy];
  }
  return { type: 'Polygon', coordinates: [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]] };
}

// ---- SVG selectors ---------------------------------------------------------------------------

const SHAPES = ['polygon', 'polyline', 'rect', 'circle', 'ellipse', 'line', 'path'];
const REFUSED = ['use', 'image', 'text', 'textPath', 'symbol', 'foreignObject'];
function attributes(s) {
  const out = {};
  for (const m of s.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = m[2] ?? m[3];
  return out;
}
/** An SVG transform attribute as an affine matrix [a, b, c, d, e, f]. */
function transformMatrix(text) {
  let M = [1, 0, 0, 1, 0, 0];
  const mul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
  const rest = text.replace(/([a-zA-Z]+)\s*\(([^)]*)\)/g, (_, fn, args) => {
    const v = numbers(args);
    const rad = (deg) => (deg * Math.PI) / 180;
    let T;
    if (fn === 'matrix' && v.length === 6) T = v;
    else if (fn === 'translate' && (v.length === 1 || v.length === 2)) T = [1, 0, 0, 1, v[0], v[1] ?? 0];
    else if (fn === 'scale' && (v.length === 1 || v.length === 2)) T = [v[0], 0, 0, v[1] ?? v[0], 0, 0];
    else if (fn === 'rotate' && (v.length === 1 || v.length === 3)) {
      const [a, cx = 0, cy = 0] = v, cos = Math.cos(rad(a)), sin = Math.sin(rad(a));
      T = mul(mul([1, 0, 0, 1, cx, cy], [cos, sin, -sin, cos, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
    } else if (fn === 'skewX' && v.length === 1) T = [1, 0, Math.tan(rad(v[0])), 1, 0, 0];
    else if (fn === 'skewY' && v.length === 1) T = [1, Math.tan(rad(v[0])), 0, 1, 0, 0];
    else throw new DataError(`The SVG transform "${fn}(${args.trim()})" is not understood.`);
    M = mul(M, T);
    return '';
  });
  if (rest.replace(/[\s,]/g, '')) throw new DataError(`The SVG transform ${JSON.stringify(text)} is not understood.`);
  return M;
}
const apply = (M, [x, y]) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
function pairs(text, what) {
  const v = numbers(text);
  if (v.length % 2) throw new DataError(`The SVG ${what} has an odd number of coordinates.`);
  const out = [];
  for (let i = 0; i < v.length; i += 2) out.push([v[i], v[i + 1]]);
  return out;
}
function ellipseRing(cx, cy, rx, ry) {
  const out = [];
  for (let i = 0; i < CIRCLE_SIDES; i++) {
    const t = (2 * Math.PI * i) / CIRCLE_SIDES;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}
/** A path's subpaths: [{ points, closed }]. Only M, L, H, V and Z (absolute or relative). */
function pathSubpaths(d) {
  const tokens = String(d).match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
  const subs = [];
  let cur = null, pt = [0, 0], start = [0, 0], cmd = null, i = 0, closedLast = false;
  const num = () => {
    if (i >= tokens.length || /[a-zA-Z]/.test(tokens[i])) throw new DataError(`The SVG path ${JSON.stringify(d)} stops in the middle of a command.`);
    return Number(tokens[i++]);
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    else if (cmd === null) throw new DataError(`The SVG path ${JSON.stringify(d)} does not start with a command.`);
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case 'M': {
        const x = num(), y = num();
        pt = rel ? [pt[0] + x, pt[1] + y] : [x, y];
        start = pt; cur = { points: [pt], closed: false }; subs.push(cur); closedLast = false;
        cmd = rel ? 'l' : 'L'; // pairs after a moveto are linetos
        break;
      }
      case 'L': case 'H': case 'V': {
        // After Z, the current point is the start of the subpath just closed, and a line from there
        // begins a new subpath at it (SVG 1.1, 8.3.3).
        if (!cur && closedLast) { cur = { points: [start], closed: false }; subs.push(cur); closedLast = false; }
        if (!cur) throw new DataError(`The SVG path ${JSON.stringify(d)} draws before it moves to a starting point.`);
        const c = cmd.toUpperCase();
        if (c === 'L') { const x = num(), y = num(); pt = rel ? [pt[0] + x, pt[1] + y] : [x, y]; }
        else if (c === 'H') { const x = num(); pt = [rel ? pt[0] + x : x, pt[1]]; }
        else { const y = num(); pt = [pt[0], rel ? pt[1] + y : y]; }
        cur.points.push(pt);
        break;
      }
      case 'Z':
        if (!cur) throw new DataError(`The SVG path ${JSON.stringify(d)} closes before it starts.`);
        cur.closed = true; pt = start; cur = null; closedLast = true;
        break;
      default:
        throw new DataError(`The SVG path uses the command "${cmd}", which is not read: only straight lines (M, L, H, V and Z) can be transformed, not curves or arcs.`);
    }
  }
  return subs;
}
/**
 * Closed rings to polygons: a ring inside an earlier, larger outer ring is a hole in it;
 * any other ring is a polygon of its own. (An island inside a hole becomes a hole too.)
 */
function ringsToPolygons(rings) {
  const sorted = [...rings].sort((a, b) => Math.abs(signedArea2(b)) - Math.abs(signedArea2(a)));
  const polygons = [];
  for (const r of sorted) {
    // A vertex off the other ring's edge decides (subpaths after Z share their first point).
    const host = polygons.find((p) => pointInRing(r.find((q) => !onRing(q, p[0])) ?? r[0], p[0]));
    if (host) host.push(r); else polygons.push([r]);
  }
  return polygons;
}

/**
 * The outer <svg>'s own frame must be the pixel frame, since its coordinates are read as pixels.
 * width and height, if given, must be plain numbers or px. A viewBox must start at 0 0 and, where
 * width or height is given, be the same size (otherwise it scales or shifts every shape; the size
 * of the target image is not known here, so that is as far as it can be checked). A viewBox alone,
 * with no width and height, starting at 0 0, says nothing about the size it is drawn at: it is
 * taken as pixels, as the rest of the SVG is.
 */
function svgFrame(a) {
  const refuse = (why) => { throw new DataError(`The SVG's <svg> element ${why}, so its shapes would not be read in the image's pixels. Nothing was changed: give the shapes in an <svg> whose frame is the image's pixels (no viewBox, or viewBox="0 0 W H" with width="W" height="H").`); };
  const size = {};
  for (const k of ['width', 'height']) {
    if (a[k] === undefined) continue;
    const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(px)?\s*$/.exec(a[k]);
    if (!m || !(Number(m[1]) > 0)) refuse(`has ${k}="${a[k]}", which is not a number of pixels`);
    size[k] = Number(m[1]);
  }
  if (a.viewBox === undefined) return;
  const v = a.viewBox.trim().split(/[\s,]+/).map((t) => (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(t) ? Number(t) : NaN));
  if (v.length !== 4 || !v.every(Number.isFinite) || !(v[2] > 0 && v[3] > 0)) refuse(`has viewBox="${a.viewBox}", which is not four numbers with a width and height more than 0`);
  if (v[0] !== 0 || v[1] !== 0) refuse(`has viewBox="${a.viewBox}", which does not start at 0 0`);
  if ((size.width !== undefined && size.width !== v[2]) || (size.height !== undefined && size.height !== v[3])) {
    refuse(`has viewBox="${a.viewBox}" and ${['width', 'height'].filter((k) => a[k] !== undefined).map((k) => `${k}="${a[k]}"`).join(' ')}, which differ, so the viewBox scales the shapes`);
  }
}

/**
 * An SVG selector (a whole <svg> element or a fragment) as a GeoJSON-shaped pixel geometry.
 * Read: polygon, polyline, line, rect, circle and ellipse (as a polygon of CIRCLE_SIDES sides),
 * and path with straight segments only; a transform attribute on the shape itself is applied.
 * Refused: curves and arcs (and a rect with rounded corners), an outer <svg> whose viewBox or size
 * is not the pixel frame (see svgFrame), a transform on anything but a shape (a group, a link, the <svg>
 * itself), an <svg> inside another, text and images, and a mixture of areas and lines.
 */
export function parseSvg(svg) {
  const s = String(svg);
  const polys = [], lines = [];
  let svgs = 0;
  for (const m of s.matchAll(/<\s*([A-Za-z][\w:-]*)\b([^>]*)>/g)) {
    const tag = m[1].replace(/^svg:/, '');
    const a = attributes(m[2]);
    // Only a transform on a shape is applied; one on anything else (the <svg> itself, a group, a
    // link) would move the shapes inside it, and so would a nested <svg> (its x, y and viewBox).
    if (tag === 'svg' && ++svgs > 1) throw new DataError('The SVG has an <svg> inside another, whose position and viewBox are not applied, so its shapes would be put in the wrong place. Nothing was changed: give the shapes in one <svg>.');
    if (tag === 'svg') svgFrame(a);
    if (a.transform && !SHAPES.includes(tag)) throw new DataError(`The SVG has a transform on ${tag === 'g' ? 'a group (<g>)' : `an <${tag}> element`}, which is not applied, so the shapes inside it would be put in the wrong place. Nothing was changed: give the transform on each shape itself.`);
    if (REFUSED.includes(tag)) throw new DataError(`The SVG has a <${tag}> element, which is not a shape that can be transformed.`);
    if (!SHAPES.includes(tag)) continue;
    const M = a.transform ? transformMatrix(a.transform) : null;
    const T = (pts) => (M ? pts.map((p) => apply(M, p)) : pts);
    const n = (k) => { const v = Number(a[k] ?? 0); if (!Number.isFinite(v)) throw new DataError(`The SVG <${tag}> has ${k}="${a[k]}", which is not a number.`); return v; };
    const ringOf = (pts) => {
      const r = openRing(pts);
      if (r.length < 3) throw new DataError(`The SVG <${tag}> has fewer than three distinct points, so it encloses no area.`);
      return closeRing(T(r));
    };
    switch (tag) {
      case 'polygon': polys.push(ringOf(pairs(a.points ?? '', 'polygon'))); break;
      case 'polyline': {
        const p = pairs(a.points ?? '', 'polyline');
        if (p.length < 2) throw new DataError('The SVG <polyline> has fewer than two points.');
        lines.push(T(p)); break;
      }
      case 'line': lines.push(T([[n('x1'), n('y1')], [n('x2'), n('y2')]])); break;
      case 'rect': {
        const x = n('x'), y = n('y'), w = n('width'), h = n('height');
        if (!(w > 0 && h > 0)) throw new DataError('The SVG <rect> has no area: its width and height must be more than 0.');
        // Rounded corners: a missing rx or ry takes the other's value; the corners are round only
        // when both are more than 0.
        const rx = a.rx !== undefined ? n('rx') : a.ry !== undefined ? n('ry') : 0;
        const ry = a.ry !== undefined ? n('ry') : rx;
        if (rx > 0 && ry > 0) throw new DataError(`The SVG <rect> has rounded corners (rx="${a.rx ?? a.ry}", ry="${a.ry ?? a.rx}"), which are curves and are not read: only straight lines can be transformed. Nothing was changed: give the rectangle without rx and ry, or as a polygon.`);
        polys.push(ringOf([[x, y], [x + w, y], [x + w, y + h], [x, y + h]])); break;
      }
      case 'circle': { const r = n('r'); if (!(r > 0)) throw new DataError('The SVG <circle> has no radius.'); polys.push(ringOf(ellipseRing(n('cx'), n('cy'), r, r))); break; }
      case 'ellipse': {
        const rx = n('rx'), ry = n('ry');
        if (!(rx > 0 && ry > 0)) throw new DataError('The SVG <ellipse> has no radius.');
        polys.push(ringOf(ellipseRing(n('cx'), n('cy'), rx, ry))); break;
      }
      case 'path': {
        const subs = pathSubpaths(a.d ?? '');
        if (!subs.length) throw new DataError('The SVG <path> draws nothing.');
        const closed = subs.filter((p) => p.closed), open = subs.filter((p) => !p.closed);
        if (closed.length && open.length) throw new DataError('The SVG <path> mixes closed areas and open lines, which cannot be one geometry.');
        if (closed.length) {
          const rings = closed.map((p) => ringOf(p.points));
          for (const poly of ringsToPolygons(rings)) polys.push(poly);
        } else {
          for (const p of open) { if (p.points.length < 2) throw new DataError('The SVG <path> has a line with fewer than two points.'); lines.push(T(p.points)); }
        }
        break;
      }
    }
  }
  if (polys.length && lines.length) throw new DataError('The SVG mixes areas and lines, which cannot be one geometry (a GeometryCollection is not made).');
  // A plain ring is a polygon of one ring; a path may already have given [outer, ...holes].
  const polygons = polys.map((p) => (typeof p[0][0] === 'number' ? [p] : p));
  if (polygons.length === 1) return { type: 'Polygon', coordinates: polygons[0] };
  if (polygons.length > 1) return { type: 'MultiPolygon', coordinates: polygons };
  if (lines.length === 1) return { type: 'LineString', coordinates: lines[0] };
  if (lines.length > 1) return { type: 'MultiLineString', coordinates: lines };
  throw new DataError('The SVG has no shape that can be transformed (polygon, polyline, line, rect, circle, ellipse or path).');
}
