// Georeferencing: positions on a map image to positions in the world and back, through a IIIF
// Georeference Annotation (as Allmaps makes them), for every PLATO tool that needs it.
//
//   import { readGeoreference, toWorld, toPixels, georefNote, georefCitation, georefAnnotationCitation,
//            matchesTarget, matchTarget, containsRegion, allmapsLookupUrl,
//            allmapsTransformationName } from './engine/georef/index.js'
//
// ASYNC: readGeoreference, toWorld and toPixels return Promises. The Allmaps libraries they use
// are loaded by dynamic import() the first time one of them is called, so that a page which never
// meets a georeference never downloads them. georefNote, georefCitation, georefAnnotationCitation,
// matchesTarget, matchTarget, containsRegion and allmapsTransformationName are synchronous and
// never load Allmaps.
// allmapsLookupUrl is async only because it hashes with Web Crypto; it builds a URL and fetches
// nothing.
//
// Nothing here fetches anything: the caller fetches the annotation and the manifest.
// Pure ESM, no DOM: runs in Node and in a Web Worker.
//
// How positions are computed. The transformation is fitted between image pixels and Web Mercator
// (EPSG:3857) metres, as @allmaps/render fits it (through @allmaps/project's
// ProjectedGcpTransformer), and the results are given as WGS84 longitude and latitude. So a point
// placed here lies where the same point of the warped map is drawn by Allmaps: a test checks this
// against values computed by @allmaps/project itself. An annotation that names its own projection
// (resourceCrs) is refused, since Allmaps fits those in that projection, which needs proj4.
//
// The way back (toPixels) inverts the forward transformation exactly. Where a transformation folds
// the map over, one place has several positions on the map: the one inside the mask (or the image)
// is used if there is exactly one, the only one if there is one; otherwise it is a DataError. A
// projective transformation cannot be inverted at all at some positions, even inside the map (27 of
// 98 interior points on one real map), because the fitted plane passes its horizon there: those are
// DataErrors, never a wrong position.
import { DataError } from '../input.js';
import { normaliseId, parseImageRequest, imageRequestFrameChange, labelText, manifestCanvases, partOfCanvases, manifestId as idOfManifest } from './iiif.js';
import {
  readGeojson, parseXywh, xywhPolygon, parseSvg, closeRing, openRing, signedArea2, pointInRing,
  segmentsCross, vertices, edges,
} from './shapes.js';

/**
 * The transformation library, as the record names it. A test checks this against
 * node_modules/@allmaps/transform/package.json, so it cannot drift from package.json's pin.
 */
export { allmapsLookupUrl, parseImageRequest } from './iiif.js';
export const SOFTWARE = '@allmaps/transform@1.0.0-beta.53';

// ---- Loading Allmaps, lazily ------------------------------------------------------------------

let allmaps = null, imports = 0;
/** How many times the Allmaps libraries have been loaded (0 until a georeference is used; then 1). */
export const allmapsImportCount = () => imports;
function library() {
  if (!allmaps) {
    imports++;
    allmaps = Promise.all([import('@allmaps/annotation'), import('@allmaps/transform')])
      .then(([annotation, transform]) => ({ parseAnnotation: annotation.parseAnnotation, GcpTransformer: transform.GcpTransformer }));
    allmaps.catch(() => { allmaps = null; }); // a failed load may be tried again
  }
  return allmaps;
}

// ---- Transformations ---------------------------------------------------------------------------

/** Our names -> Allmaps' names, with the fewest control points each needs. */
const TRANSFORMATIONS = {
  polynomial: { allmaps: 'polynomial1', min: 3, words: 'polynomial order 1' },
  polynomial2: { allmaps: 'polynomial2', min: 6, words: 'polynomial order 2' },
  polynomial3: { allmaps: 'polynomial3', min: 10, words: 'polynomial order 3' },
  thinPlateSpline: { allmaps: 'thinPlateSpline', min: 3, words: 'thin plate spline' },
  projective: { allmaps: 'projective', min: 4, words: 'projective' },
  helmert: { allmaps: 'helmert', min: 2, words: 'Helmert' },
  // Allowed in annotations by Allmaps, so accepted when an annotation names them.
  straight: { allmaps: 'straight', min: 2, words: 'straight' },
  linear: { allmaps: 'linear', min: 3, words: 'linear' },
};
const ALIASES = { polynomial1: 'polynomial' };
function transformationName(t, where) {
  const n = ALIASES[t] ?? t;
  if (!TRANSFORMATIONS[n]) {
    throw new DataError(`${where} names the transformation ${JSON.stringify(t)}, which is not one of: polynomial, polynomial2, polynomial3, thinPlateSpline, projective, helmert.`);
  }
  return n;
}
/**
 * An annotation's own transformation ({ type, options: { order } }) in our names.
 *
 * The ANNOTATION's order is authoritative. @allmaps/annotation's parser gives a polynomial of order
 * 2 or 3 as { type: 'polynomial', options: { order } }, and that order is read here. @allmaps/render's
 * WarpedMap (1.0.0-beta.84, dist/maps/WarpedMap.js line 209) takes only transformation.type, so
 * Allmaps' renderer DRAWS such a map at order 1 unless told otherwise; Chora makes it draw what the
 * annotation says with setMapTransformationType(allmapsTransformationName(g)). So positions here
 * follow the annotation, and the map drawn follows them.
 *
 * A bare "polynomial2" or "polynomial3" in place of { type, options } is not a transformation to
 * @allmaps/annotation's parser (1.0.0-beta.38 gives none, which Allmaps takes as order 1), and so it
 * is order 1 here too: what Allmaps reads, not what the text might have meant.
 */
function annotationTransformation(t) {
  if (!t || !t.type) return 'polynomial';
  const order = t.options && t.options.order;
  if (t.type === 'polynomial') {
    if (order === undefined || order === 1) return 'polynomial';
    if (order === 2 || order === 3) return `polynomial${order}`;
    throw new DataError(`The georeference names a polynomial transformation of order ${order}, which is not supported (orders 1, 2 and 3 are).`);
  }
  return transformationName(t.type, 'The georeference');
}
/**
 * The name Allmaps gives g's transformation (a record works too), as @allmaps/transform's
 * TransformationType spells it: 'polynomial1', 'polynomial2', 'polynomial3', 'thinPlateSpline',
 * 'projective', 'helmert', 'straight' or 'linear'. For @allmaps/maplibre's (WarpedMapLayer's)
 * setMapTransformationType, so that the map is drawn with the transformation it is read with. A
 * TypeError when g names no known transformation.
 */
export function allmapsTransformationName(g) {
  const t = g && g.transformation;
  const name = typeof t === 'string' ? ALIASES[t] ?? t : undefined;
  if (!name || !Object.hasOwn(TRANSFORMATIONS, name)) throw new TypeError(`The georeference names no known transformation (${JSON.stringify(t ?? null)}).`);
  return TRANSFORMATIONS[name].allmaps;
}
function enoughPoints(g, name) {
  const { min, words } = TRANSFORMATIONS[name];
  if (g.gcps < min) {
    throw new DataError(`The georeference ${g.annotationId ?? ''} has ${g.gcps} control point${g.gcps === 1 ? '' : 's'}, too few for a ${words} transformation, which needs at least ${min}.`.replace('  ', ' '));
  }
  if (Array.isArray(g.controlPoints)) spreadEnough(g, name);
}

// ---- Control points that cannot fix a transformation ------------------------------------------

/**
 * Where the control points are too few once repeats are counted, or all on one line, the
 * transformation is not determined: Allmaps either fails (a thin plate spline's matrix is
 * singular) or, worse, returns a position that means nothing (three points on a line gave
 * [0.2, 0.199989]; three identical points put every pixel at [0, 0]). So both sets of points, on
 * the map and on the ground (in the Web Mercator metres the transformation is fitted in), are
 * checked for the chosen transformation. A Helmert transformation (a shift, a turn and a scale)
 * and a straight one are fixed by any two distinct points, on a line or not; every other needs
 * points that span an area. A thin plate spline passes through every point exactly, so it cannot
 * take two control points at the same place at all.
 */
const LINE_ONLY = new Set(['helmert', 'straight']);
/** Points closer than this share of the spread of all of them count as the same point. */
const SAME = 1e-9;
/**
 * Points count as on one line when none lies further from the line through the two furthest apart
 * than this share of the distance between those two (so twice the largest triangle's area is below
 * this share of that distance squared): the scale of the map or of the ground does not matter.
 */
const FLAT = 1e-4;
function spreadOf(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const size = Math.max(x1 - x0, y1 - y0, 0);
  const distinct = [];
  for (const p of points) if (!distinct.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= SAME * size)) distinct.push(p);
  let a = null, b = null, far = 0;
  for (let i = 0; i < distinct.length; i++) {
    for (let k = i + 1; k < distinct.length; k++) {
      const d = Math.hypot(distinct[i][0] - distinct[k][0], distinct[i][1] - distinct[k][1]);
      if (d > far) { far = d; a = distinct[i]; b = distinct[k]; }
    }
  }
  let off = 0;
  if (far > 0) {
    for (const p of distinct) off = Math.max(off, Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / far);
  }
  return { distinct: distinct.length, repeats: distinct.length < points.length, flat: far === 0 || off <= FLAT * far };
}
function spreadEnough(g, name) {
  const { min, words } = TRANSFORMATIONS[name];
  const who = `The georeference${g.annotationId ? ` ${g.annotationId}` : ''}`;
  const sets = [
    ['on the map', g.controlPoints.map((p) => p.resource)],
    ['on the ground', g.controlPoints.map((p) => mercatorAgain(toMercator(p.geo)))],
  ];
  for (const [where, points] of sets) {
    const s = spreadOf(points);
    if (s.distinct < min) {
      throw new DataError(`${who} has ${g.gcps} control points but only ${s.distinct} different place${s.distinct === 1 ? '' : 's'} ${where} among them, too few for a ${words} transformation, which needs at least ${min}. Nothing was changed: the map cannot be placed until the control points are spread out.`);
    }
    if (name === 'thinPlateSpline' && s.repeats) {
      throw new DataError(`${who} has two or more control points at the same place ${where}, which a thin plate spline transformation cannot use (it must pass through each point exactly). Nothing was changed: remove the repeated control points, or choose another transformation.`);
    }
    if (!LINE_ONLY.has(name) && s.flat) {
      throw new DataError(`${who} has its control points all on one straight line ${where}, so a ${words} transformation cannot tell where anything off that line goes. Nothing was changed: the map cannot be placed until a control point is added off the line.`);
    }
  }
}
/** Each control point must be a pair of numbers on the map and a longitude and latitude a web map can show. */
function checkControlPoint(p, i, who) {
  const n = `Control point ${i + 1} of ${who}`;
  if (!p.resource.every(Number.isFinite)) {
    throw new DataError(`${n} has a position on the map that is not a pair of numbers (${JSON.stringify(p.resource)}). Nothing was changed.`);
  }
  const [lon, lat] = p.geo;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new DataError(`${n} has a position on the ground that is not a pair of numbers (${JSON.stringify(p.geo)}). Nothing was changed.`);
  }
  if (Math.abs(lon) > 180) {
    throw new DataError(`${n} is at longitude ${lon}, which is not a longitude (they run from -180 to 180). Nothing was changed.`);
  }
  if (Math.abs(lat) > MAX_LAT) {
    throw new DataError(`${n} is at latitude ${lat}, beyond the ±85.0511° that a web map can show, so the map cannot be placed with it. Nothing was changed.`);
  }
}

/**
 * The control points must lie on one side of the 180° meridian. A set is taken to straddle it when
 * its points fit within half the world across ±180° while leaving more than half the world empty
 * between them (sorted, a gap between neighbours wider than 180° that is not the gap across ±180°):
 * Web Mercator would then put them at either edge of the world, and a point between 179.5° and
 * -179.5° came out at [0, 10.1] (as it does in Allmaps). Such a set is refused. A world map, whose
 * points spread round the world with no gap wider than 180°, is not: it fits in Web Mercator.
 */
function checkAntimeridian(points, who) {
  const lons = points.map((p) => p.geo[0]).sort((a, b) => a - b);
  if (lons.length < 2) return;
  const across = lons[0] + 360 - lons[lons.length - 1];
  let widest = 0, at = 0;
  for (let i = 1; i < lons.length; i++) if (lons[i] - lons[i - 1] > widest) { widest = lons[i] - lons[i - 1]; at = i; }
  if (widest > 180 && widest > across) {
    throw new DataError(`${who[0].toUpperCase()}${who.slice(1)} has control points on both sides of the 180° meridian (at longitudes up to ${lons[at - 1]} and from ${lons[at]}), and maps that cross the 180° meridian are not supported yet. Nothing was changed.`);
  }
}

// Web Mercator (EPSG:3857 on its sphere), computed exactly as proj4 computes it for Allmaps
// (proj4's merc.js, with its constants and order of operations), so that the control points
// Allmaps' renderer fits are the same numbers, bit for bit. That matters: the projective solve is
// ill-conditioned enough that a difference of 5e-9 m in the control points moved results by metres.
const A = 6378137, D2R = 0.01745329251994329577, R2D = 57.29577951308232088, MAX_LAT = 85.0511287798066;
const FORTPI = Math.PI / 4, HALF_PI = Math.PI / 2;
const toMercator = ([lon, lat]) => { const lam = lon * D2R, phi = lat * D2R; return [0 + A * 1 * (lam - 0), 0 + A * 1 * Math.log(Math.tan(FORTPI + 0.5 * phi))]; };
const fromMercator = ([x, y]) => [(0 + x / (A * 1)) * R2D, (HALF_PI - 2 * Math.atan(Math.exp(-y / (A * 1)))) * R2D];
/**
 * The control points as Allmaps' renderer fits them: projected, and then passed once more through
 * proj4's EPSG:3857 -> EPSG:3857 conversion (@allmaps/project's ProjectedGcpTransformer applies
 * its preToResource to every control point), which is an inverse and a forward, not the identity.
 */
const mercatorAgain = ([x, y]) => {
  const phi = HALF_PI - 2 * Math.atan(Math.exp(-(y - 0) / (A * 1))), lam = 0 + (x - 0) / (A * 1);
  return [0 + A * 1 * (lam - 0), 0 + A * 1 * Math.log(Math.tan(FORTPI + 0.5 * phi))];
};

/** Distance from a point to a segment. */
function segmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const u = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy);
}
/** One fitted transformer per georeference and transformation, kept while g is in use. */
const cache = new WeakMap();
async function transformerFor(g, name) {
  let byName = cache.get(g);
  if (!byName) { byName = new Map(); cache.set(g, byName); }
  if (!byName.has(name)) {
    const { GcpTransformer } = await library();
    const points = (g.controlPoints || []).map((p) => ({ resource: p.resource, geo: mercatorAgain(toMercator(p.geo)) }));
    const t = new GcpTransformer(points, TRANSFORMATIONS[name].allmaps);
    // Metres per image pixel near the middle of the image, so that a tolerance in pixels can be
    // given in metres when the refinement is measured on the ground.
    const cx = (g.image && g.image.width || 0) / 2, cy = (g.image && g.image.height || 0) / 2;
    const [o, ex, ey] = [[cx, cy], [cx + 1, cy], [cx, cy + 1]].map((p) => t.transformToGeo(p));
    const det = (ex[0] - o[0]) * (ey[1] - o[1]) - (ex[1] - o[1]) * (ey[0] - o[0]);
    // Seeds for the inverse: every control point and a 7 x 7 grid over the image; and what counts
    // as on the map: inside the mask, or with no mask, inside the image.
    const W = g.image && g.image.width || 0, H = g.image && g.image.height || 0;
    const seeds = points.map((p) => p.resource);
    for (let i = 0; i < 7; i++) for (let k = 0; k < 7; k++) seeds.push([(W * (i + 0.5)) / 7, (H * (k + 0.5)) / 7]);
    const mask = g.mask && g.mask.length >= 3 ? closeRing(g.mask) : null;
    // Half a pixel of grace at the edge, so that a point on the mask's edge is not lost to rounding.
    const nearEdge = (p) => mask.some((q, i) => i > 0 && segmentDistance(p, mask[i - 1], q) <= 0.5);
    const inside = mask ? (p) => pointInRing(p, mask) || nearEdge(p) : ([x, y]) => x >= -0.5 && y >= -0.5 && x <= W + 0.5 && y <= H + 0.5;
    byName.set(name, { t, metresPerPixel: Math.sqrt(Math.abs(det)) || 1, seeds, inside });
  }
  return byName.get(name);
}
/** Allmaps' midpoint refinement: split a segment while its midpoint is off by more than `limit`. */
const refinement = (limit) => ({ maxDepth: MAX_DEPTH, minOffsetRatio: Infinity, minOffsetDistance: limit });
const MAX_DEPTH = 10;

/**
 * The exact inverse of the forward (pixels to world) transformation at one point, by Newton's
 * method. Allmaps fits a separate transformation for the way back, which is not the inverse of the
 * way there (least squares either way, or a second thin plate spline), and on real maps the two
 * can disagree by hundreds of pixels; the forward transformation is the one the warped map is
 * drawn with, so it is the one inverted here. Allmaps' way back gives the first guess.
 */
function inverse(entry, target) {
  const { t, metresPerPixel, seeds, inside } = entry;
  const f = (p) => t.transformToGeo(p);
  const err = (p) => { const q = f(p); return [q[0] - target[0], q[1] - target[1]]; };
  const norm = (e) => Math.hypot(e[0], e[1]);
  const goal = 1e-6 * metresPerPixel; // a millionth of a pixel, on the ground
  const converged = 1e-3 * metresPerPixel;
  const newton = (start) => {
    let p = start, e = err(p), n = norm(e);
    for (let i = 0; i < 60 && n > goal; i++) {
      const h = 0.5;
      const ex = err([p[0] + h, p[1]]), ey = err([p[0], p[1] + h]);
      const a = (ex[0] - e[0]) / h, b = (ey[0] - e[0]) / h, c = (ex[1] - e[1]) / h, d = (ey[1] - e[1]) / h;
      const det = a * d - b * c;
      if (!Number.isFinite(det) || det === 0) break;
      const step = [(d * e[0] - b * e[1]) / det, (-c * e[0] + a * e[1]) / det];
      let k = 1, moved = false;
      for (let s = 0; s < 30; s++, k /= 2) { // damped: never accept a step that makes it worse
        const q = [p[0] - k * step[0], p[1] - k * step[1]], eq = err(q), nq = norm(eq);
        if (nq < n) { p = q; e = eq; n = nq; moved = true; break; }
      }
      if (!moved) break;
    }
    return n <= converged && p.every(Number.isFinite) ? p : null;
  };
  // Where the forward transformation folds, one place on the ground has several positions on the
  // map. So Newton's method is started from many seeds (Allmaps' way back, every control point, a
  // grid over the image), and every distinct position it converges to is kept.
  const found = [];
  for (const start of [t.transformToResource(target), ...seeds]) {
    if (!start.every(Number.isFinite)) continue;
    const p = newton(start);
    if (p && !found.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.01)) found.push(p);
  }
  const [lon, lat] = fromMercator(target);
  if (!found.length) {
    throw new DataError(`The position [${lon}, ${lat}] cannot be taken back to the map: the transformation does not reach it, or folds over near it.`);
  }
  const within = found.filter(inside);
  if (within.length === 1) return within[0];
  if (!within.length && found.length === 1) return found[0];
  const where = within.length ? within : found;
  throw new DataError(`The position [${lon}, ${lat}] has more than one position on the map through this transformation (${where.map((p) => `[${p.map((v) => Math.round(v * 10) / 10).join(', ')}]`).join(', ')}${within.length ? ', all inside the map' : ', none inside the map'}), because the transformation folds the map over there.`);
}
/** The inverse along a line or ring, split at midpoints until within `tol` pixels (as Allmaps refines). */
function inverseLine(entry, pts, closed, tol) {
  const px = pts.map((p) => inverse(entry, p));
  if (!tol) return px;
  const out = [];
  const split = (g0, g1, p0, p1, depth) => {
    if (depth >= MAX_DEPTH) return;
    const gm = [(g0[0] + g1[0]) / 2, (g0[1] + g1[1]) / 2], pm = inverse(entry, gm);
    if (Math.hypot(pm[0] - (p0[0] + p1[0]) / 2, pm[1] - (p0[1] + p1[1]) / 2) <= tol) return;
    split(g0, gm, p0, pm, depth + 1); out.push(pm); split(gm, g1, pm, p1, depth + 1);
  };
  const n = pts.length, segs = closed ? n : n - 1;
  for (let i = 0; i < n; i++) {
    out.push(px[i]);
    if (i < segs) split(pts[i], pts[(i + 1) % n], px[i], px[(i + 1) % n], 0);
  }
  return out;
}

// ---- Reading a georeference --------------------------------------------------------------------

/**
 * Read a Georeference Annotation.
 *
 * @param annotation A Georeference Annotation, an AnnotationPage of them, or either as JSON text.
 * @param options.manifest  A parsed IIIF Presentation 2 or 3 manifest (optional): gives the canvas
 *   dimensions, and is checked against the annotation. Without it, the canvas and manifest ids are
 *   taken from the annotation's own `partOf`, and the canvas dimensions are unknown.
 * @param options.canvasId  Which canvas, when the manifest has several (optional).
 * @param options.index     Which annotation of an AnnotationPage (0-based, optional). Without it, a
 *   page of several is narrowed to the one on `canvasId`; if that does not leave exactly one, a
 *   DataError says so.
 * @returns Promise of g = { annotationId, imageServiceId, canvasId, manifestId, image: {width, height},
 *   canvas: {width, height} | null, gcps, transformation, title, controlPoints, mask }. `title` is
 *   the manifest's label (else the label the annotation gives it), or null; `controlPoints` are
 *   [{ resource: [x, y], geo: [lon, lat] }] and `mask` the annotation's mask in image pixels (or
 *   null), carried so that g still works after it is copied or sent to a worker.
 *
 * g is IMMUTABLE, and is returned frozen, all the way down: the transformations fitted from it
 * (control points, image size and mask) are cached by g itself, so a g changed in place would go on
 * giving the old results. A frozen g still copies (structuredClone, postMessage; the copy is not
 * frozen, and is fitted afresh) and spreads ({ ...g, … } is a new g); to change a georeference,
 * make a new object rather than editing this one.
 */
export async function readGeoreference(annotation, { manifest, canvasId, index } = {}) {
  if (typeof annotation === 'string') {
    try { annotation = JSON.parse(annotation); } catch (e) { throw new DataError(`The georeference is not well-formed JSON (${String(e.message).split('\n')[0]}).`); }
  }
  if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) throw new DataError('The georeference is not a Georeference Annotation: it is not a JSON object.');
  const type = annotation.type ?? annotation['@type'];
  let items;
  if (type === 'AnnotationPage') items = Array.isArray(annotation.items) ? annotation.items : [];
  else if (type === 'Annotation') items = [annotation];
  else throw new DataError(`The georeference is not a Georeference Annotation: its type is ${JSON.stringify(type ?? null)}, not Annotation or AnnotationPage.`);
  if (!items.length) throw new DataError('The AnnotationPage holds no annotations, so there is no georeference in it.');

  const { parseAnnotation } = await library();
  const maps = items.map((item, i) => {
    const id = item && (item.id ?? item['@id']);
    const where = items.length > 1 ? `Annotation ${i + 1} of the page${id ? ` (${id})` : ''}` : `The annotation${id ? ` ${id}` : ''}`;
    const georeferencing = item && (item.motivation === 'georeferencing' || (Array.isArray(item.motivation) && item.motivation.includes('georeferencing')));
    if (!georeferencing) {
      throw new DataError(`${where} is not a Georeference Annotation: its motivation is ${JSON.stringify(item && item.motivation || null)}, not "georeferencing".`);
    }
    // Allmaps' parser takes the motivation only as the string; an array holding it means the same.
    try { return parseAnnotation(typeof item.motivation === 'string' ? item : { ...item, motivation: 'georeferencing' })[0]; }
    catch (e) { throw new DataError(`${where} is not a Georeference Annotation that can be read (${String(e && e.message || e).split('\n')[0].slice(0, 300)}).`); }
  });

  const canvases = manifest ? manifestCanvases(manifest) : null;
  const wanted = canvasId === undefined || canvasId === null ? undefined : normaliseId(canvasId);
  const chosenCanvas = wanted && canvases ? canvases.find((c) => normaliseId(c.id) === wanted) : undefined;
  if (wanted && canvases && !chosenCanvas) throw new DataError(`The manifest has no canvas ${canvasId}.`);
  /** Does this map's image appear on the canvas (by its image service, or by the annotation's partOf)? */
  const onCanvas = (map, canvas, id) => {
    const img = normaliseId(map.resource.id);
    if (canvas && canvas.services.includes(img)) return true;
    return partOfCanvases(map.resource).some((p) => normaliseId(p.id) === id);
  };

  let map;
  if (index !== undefined && index !== null) {
    if (!Number.isInteger(index) || index < 0 || index >= maps.length) throw new DataError(`There is no annotation ${index} to choose: the georeference holds ${maps.length} (counted from 0).`);
    map = maps[index];
  } else if (maps.length === 1) {
    map = maps[0];
  } else if (wanted) {
    const here = maps.filter((m) => onCanvas(m, chosenCanvas, wanted));
    if (here.length !== 1) {
      throw new DataError(here.length
        ? `The AnnotationPage holds ${here.length} georeferences on canvas ${canvasId} (${here.map((m) => m.id).join(', ')}): choose one with the index option.`
        : `None of the ${maps.length} georeferences in the AnnotationPage is on canvas ${canvasId}.`);
    }
    map = here[0];
  } else {
    throw new DataError(`The AnnotationPage holds ${maps.length} georeferences (${maps.map((m) => m.id).join(', ')}) and none was chosen: give the index option, or a canvasId that has only one.`);
  }

  // Allmaps' renderer fits the transformation in the map's own projection when the annotation
  // gives one (resourceCrs), which needs proj4; not having it, a projection other than Web
  // Mercator is refused rather than put somewhere other than where Allmaps draws the map.
  const crs = map.resourceCrs;
  if (crs && !/EPSG:3857\b|EPSG:900913\b|\+proj=merc \+a=6378137 \+b=6378137/.test(`${crs.id ?? ''} ${crs.name ?? ''} ${typeof crs.definition === 'string' ? crs.definition : ''}`)) {
    throw new DataError(`This map's georeference${map.id ? ` (${map.id})` : ''} is made in the projection ${crs.name || crs.id || 'that it names'}, which PLATO tools do not support yet. Nothing was changed. Positions worked out without that projection would not match where the map is drawn.`);
  }
  const image = normaliseId(map.resource.id);
  const partOf = partOfCanvases(map.resource);
  let canvas = null, cId = null, mId = null, title = null;
  if (canvases) {
    mId = idOfManifest(manifest) ?? null;
    let c = chosenCanvas;
    if (c) {
      if (!onCanvas(map, c, normaliseId(c.id))) throw new DataError(`Canvas ${c.id} does not show the georeferenced image ${map.resource.id}.`);
    } else {
      const showing = canvases.filter((k) => onCanvas(map, k, normaliseId(k.id)));
      const named = showing.filter((k) => partOf.some((p) => normaliseId(p.id) === normaliseId(k.id)));
      c = showing.length === 1 ? showing[0] : named.length === 1 ? named[0] : undefined;
      if (!c) {
        throw new DataError(showing.length
          ? `The georeferenced image ${map.resource.id} is on ${showing.length} canvases of the manifest: choose one with canvasId.`
          : `No canvas of the manifest ${mId ?? ''} shows the georeferenced image ${map.resource.id}, so the manifest does not belong to this georeference.`.replace('  ', ' '));
      }
    }
    cId = c.id ?? null;
    if (Number.isFinite(c.width) && Number.isFinite(c.height) && c.width > 0 && c.height > 0) canvas = { width: c.width, height: c.height };
    title = labelText(manifest.label) ?? null;
  } else if (wanted) {
    if (partOf.length && !partOf.some((p) => normaliseId(p.id) === wanted)) throw new DataError(`The georeference is not on canvas ${canvasId}: it names ${partOf.map((p) => p.id).join(', ')}.`);
    cId = canvasId;
    mId = partOf.find((p) => normaliseId(p.id) === wanted)?.manifestId ?? null;
  } else if (partOf.length === 1) {
    cId = partOf[0].id ?? null;
    mId = partOf[0].manifestId ?? null;
  }
  if (!title) title = partOf.find((p) => !cId || normaliseId(p.id) === normaliseId(cId))?.manifestLabel ?? null;

  const controlPoints = map.gcps.map((p) => ({ resource: [p.resource[0], p.resource[1]], geo: [p.geo[0], p.geo[1]] }));
  const who = `the georeference${map.id ? ` ${map.id}` : ''}`;
  controlPoints.forEach((p, i) => checkControlPoint(p, i, who));
  checkAntimeridian(controlPoints, who);
  const g = {
    annotationId: map.id ?? null,
    imageServiceId: map.resource.id ?? image,
    canvasId: cId,
    manifestId: mId,
    image: { width: map.resource.width, height: map.resource.height },
    canvas,
    gcps: controlPoints.length,
    transformation: annotationTransformation(map.transformation),
    title,
    controlPoints,
    mask: Array.isArray(map.resourceMask) && map.resourceMask.length >= 3 ? map.resourceMask.map((p) => [p[0], p[1]]) : null,
  };
  enoughPoints(g, g.transformation);
  return deepFreeze(g);
}
/** Freeze g and everything in it (see readGeoreference: fitted transformations are cached by g). */
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// ---- Transforming ------------------------------------------------------------------------------

function spaceOf(space) {
  if (space !== 'canvas' && space !== 'image') {
    throw new TypeError(`The space must be given as 'canvas' or 'image' (it was ${JSON.stringify(space)}): pixel positions mean different things in each.`);
  }
  return space;
}
/** [sx, sy] that take pixels of `space` to image pixels. */
function scaleToImage(g, space) {
  const ok = (d) => d && Number.isFinite(d.width) && Number.isFinite(d.height) && d.width > 0 && d.height > 0;
  if (!ok(g.image)) throw new DataError(`The size of the georeferenced image ${g.imageServiceId} is not known, so pixel positions cannot be used.`);
  if (space === 'image') return [1, 1];
  if (!ok(g.canvas)) {
    throw new DataError(`The size of the canvas${g.canvasId ? ` ${g.canvasId}` : ''} is not known, so canvas positions cannot be turned into image positions: give the manifest, or give positions in image pixels.`);
  }
  return [g.image.width / g.canvas.width, g.image.height / g.canvas.height];
}
function precisionOf(p, fallback) {
  if (p === undefined) return fallback;
  if (!Number.isInteger(p) || p < 0 || p > 15) throw new TypeError(`The precision must be a whole number of decimals from 0 to 15 (it was ${JSON.stringify(p)}).`);
  return p;
}
function densifyOf(d) {
  if (d === undefined || d === null || d === false) return null;
  if (!(typeof d === 'number' && d > 0 && Number.isFinite(d))) throw new TypeError(`densify must be a tolerance in pixels, more than 0 (it was ${JSON.stringify(d)}).`);
  return d;
}
function roundTo(p) {
  if (p === null) return (v) => v;
  const f = 10 ** p;
  return (v) => { const r = Math.round(v * f) / f; return Object.is(r, -0) ? 0 : r; };
}
/** Apply fn to each part of a geometry: points, lines, and polygons (as lists of open rings). */
function mapParts(geom, { point, line, polygon }) {
  const c = geom.coordinates;
  const poly = (rings) => polygon(rings.map(openRing)).map(closeRing);
  switch (geom.type) {
    case 'Point': return { type: 'Point', coordinates: point(c) };
    case 'MultiPoint': return { type: 'MultiPoint', coordinates: c.map(point) };
    case 'LineString': return { type: 'LineString', coordinates: line(c) };
    case 'MultiLineString': return { type: 'MultiLineString', coordinates: c.map(line) };
    case 'Polygon': return { type: 'Polygon', coordinates: poly(c) };
    case 'MultiPolygon': return { type: 'MultiPolygon', coordinates: c.map(poly) };
  }
}
const mapPositions = (geom, f) => mapParts(geom, { point: f, line: (l) => l.map(f), polygon: (rs) => rs.map((r) => r.map(f)) });
/** RFC 7946: the outer ring counter-clockwise, holes clockwise (x = longitude, y = latitude). */
function orient(geom) {
  const fix = (rings) => rings.map((r, i) => ((signedArea2(r) > 0) === (i === 0) ? r : [...r].reverse()));
  if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: fix(geom.coordinates) };
  if (geom.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: geom.coordinates.map(fix) };
  return geom;
}
/**
 * The region in canvas units, for citing on the canvas: as given in 'canvas' space; converted from
 * 'image' space when the canvas size is known, rounded outwards to whole pixels (a media fragment's
 * pixels are whole numbers) so that it still holds the whole region. A percent region is the same
 * share of the canvas as of the image. Undefined when the canvas size is not known.
 */
function canvasRegionOf(g, r, space) {
  if (space === 'canvas' || r.percent) return r.region;
  const c = g.canvas, i = g.image;
  if (!c || !i || !(c.width > 0 && c.height > 0 && i.width > 0 && i.height > 0)) return undefined;
  const sx = c.width / i.width, sy = c.height / i.height;
  const x0 = Math.floor(r.x * sx + 1e-9), y0 = Math.floor(r.y * sy + 1e-9);
  const x1 = Math.ceil((r.x + r.w) * sx - 1e-9), y1 = Math.ceil((r.y + r.h) * sy - 1e-9);
  return `${x0},${y0},${x1 - x0},${y1 - y0}`;
}
/** A pixel geometry, a region or an SVG selector, read in the given space. */
function pixelGeometry(g, geometry, space) {
  if (geometry && typeof geometry === 'object' && 'xywh' in geometry) {
    const r = parseXywh(geometry.xywh);
    let size;
    if (r.percent) size = space === 'canvas' ? g.canvas : g.image;
    if (r.percent && !size) scaleToImage(g, space); // says why the size is not known
    return { geom: xywhPolygon(r, size), region: r.region, canvasRegion: canvasRegionOf(g, r, space) };
  }
  if (geometry && typeof geometry === 'object' && 'svg' in geometry) return { geom: parseSvg(geometry.svg) };
  return { geom: readGeojson(geometry, 'The pixel geometry') };
}
function makeRecord(g, direction, name, space, region, canvasRegion, role) {
  return {
    direction, transformation: name, gcps: g.gcps,
    annotationId: g.annotationId ?? null, manifestId: g.manifestId ?? null, canvasId: g.canvasId ?? null,
    imageServiceId: g.imageServiceId ?? null, space,
    ...(region ? { region } : {}),
    ...(region && canvasRegion && g.canvasId ? { canvasRegion } : {}),
    title: g.title ?? null,
    imageSize: okSize(g.image) ? { width: g.image.width, height: g.image.height } : null,
    canvasSize: okSize(g.canvas) ? { width: g.canvas.width, height: g.canvas.height } : null,
    ...(role ? { role } : {}),
    software: SOFTWARE,
  };
}

/**
 * Pixels to the world.
 *
 * @param geometry A GeoJSON-shaped pixel geometry (Point, LineString, Polygon or a Multi- of one of
 *   them), or { xywh: 'x,y,w,h' } (with "pixel:" or "percent:" if wanted), or { svg: '<svg …>' }.
 * @param options.space 'canvas' or 'image': REQUIRED; a TypeError if missing.
 * @param options.transformation Default: the annotation's own. One of polynomial (order 1),
 *   polynomial2, polynomial3, thinPlateSpline, projective, helmert.
 * @param options.precision Decimals of the output degrees (default 6).
 * @param options.densify Tolerance in pixels: lines and ring edges are split until the curve the
 *   transformation makes is followed to within about this many pixels (Allmaps' midpoint
 *   refinement, measured on the ground and converted at the scale of the middle of the map).
 * @param options.role Optional: what the geometry is, as an IRI, copied into the record (e.g.
 *   https://w3id.org/plato#LabelAnchor, which georefNote then mentions).
 * @returns Promise of { geojson (WGS84 [lon, lat]; polygons closed, outer rings counter-clockwise), record }.
 */
export async function toWorld(g, geometry, { space, transformation, precision, densify, role } = {}) {
  spaceOf(space);
  const p = precisionOf(precision, 6), tol = densifyOf(densify);
  const name = transformation === undefined ? g.transformation : transformationName(transformation, 'The option');
  enoughPoints(g, name);
  const { geom, region, canvasRegion } = pixelGeometry(g, geometry, space);
  const [sx, sy] = scaleToImage(g, space);
  const inImage = mapPositions(geom, ([x, y]) => [x * sx, y * sy]);
  const { t, metresPerPixel } = await transformerFor(g, name);
  const opts = tol ? refinement(tol * metresPerPixel) : undefined;
  const round = roundTo(p);
  const out = (m) => {
    const [lon, lat] = fromMercator(m);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      throw new DataError(`The georeference${g.annotationId ? ` ${g.annotationId}` : ''} gives no position in the world for this geometry through a ${TRANSFORMATIONS[name].words} transformation (it came out as [${lon}, ${lat}]). Nothing was changed.`);
    }
    return [round(lon), round(lat)];
  };
  const world = mapParts(inImage, {
    point: (pt) => out(t.transformToGeo(pt)),
    line: (l) => t.transformToGeo(l, opts).map(out),
    polygon: (rings) => t.transformToGeo(rings, opts).map((r) => r.map(out)),
  });
  return { geojson: orient(world), record: makeRecord(g, 'toWorld', name, space, region, canvasRegion, role) };
}

/**
 * The world to pixels: the exact inverse of toWorld (see inverse(), below the transformations).
 *
 * @param geojson A GeoJSON geometry (or Feature) in WGS84 [lon, lat]; no GeometryCollection.
 * @param options.space 'canvas' or 'image': REQUIRED.
 * @param options.transformation As for toWorld.
 * @param options.densify Tolerance in pixels, as for toWorld: segments are split at their midpoint on
 *   the ground while the inverse of that midpoint lies more than this many pixels off the straight line.
 *   (The same midpoint rule as Allmaps' refinement, applied to the exact inverse.)
 * @param options.precision Decimals of the output pixels (default: not rounded).
 * @returns Promise of { geometry (GeoJSON-shaped, in pixels of `space`; rings closed), record }.
 */
export async function toPixels(g, geojson, { space, transformation, densify, precision } = {}) {
  spaceOf(space);
  const p = precisionOf(precision, null), tol = densifyOf(densify);
  const name = transformation === undefined ? g.transformation : transformationName(transformation, 'The option');
  enoughPoints(g, name);
  const geom = readGeojson(geojson, 'The GeoJSON geometry');
  for (const [lon, lat] of vertices(geom)) {
    if (Math.abs(lat) > MAX_LAT || Math.abs(lon) > 180) throw new DataError(`The position [${lon}, ${lat}] is not a longitude and latitude that can be mapped (latitudes beyond ±85.05° cannot be).`);
  }
  const [sx, sy] = scaleToImage(g, space);
  const entry = await transformerFor(g, name);
  const merc = mapPositions(geom, toMercator);
  const round = roundTo(p);
  const out = ([x, y]) => [round(x / sx), round(y / sy)];
  const pixels = mapParts(merc, {
    point: (pt) => out(inverse(entry, pt)),
    line: (l) => inverseLine(entry, l, false, tol).map(out),
    polygon: (rings) => rings.map((r) => inverseLine(entry, r, true, tol).map(out)),
  });
  return { geometry: pixels, record: makeRecord(g, 'toPixels', name, space) };
}

// ---- Choosing among georeferences --------------------------------------------------------------

/** Is sourceId (an annotation target's source) this georeference's canvas or image? See matchTarget. */
export function matchesTarget(g, sourceId) {
  return matchTarget(g, sourceId).match;
}

/**
 * Whether sourceId is this georeference's canvas or image, and how:
 * { match, via: 'canvas' | 'service' | 'image-url' | null, reason?: 'cropped' | 'rotated' | 'resized' }.
 * Ids are compared with a trailing /info.json and trailing slashes ignored, scheme and case as
 * given. A IIIF Image API picture URL ({service}/full/{size}/0/{quality}.{format}) matches the
 * image service only (via 'image-url'), never the canvas, and only at full size ("full" or
 * "max"); one of this image that is cropped, rotated or scaled does not match, and `reason` says why.
 * A picture at size "max" is matched, but marked `assumedFullSize: true`: on a server that sets a
 * maxWidth, maxHeight or maxArea, "max" is a scaled picture, whose pixels are not the image's, and
 * that cannot be told from the URL; so a caller can report that the full size was assumed. "full"
 * is always the whole image, and is not marked.
 */
export function matchTarget(g, sourceId) {
  const s = normaliseId(sourceId);
  if (!s) return { match: false, via: null };
  if (s === normaliseId(g.canvasId)) return { match: true, via: 'canvas' };
  const service = normaliseId(g.imageServiceId);
  if (s === service) return { match: true, via: 'service' };
  const parts = parseImageRequest(sourceId);
  if (!parts || !service || parts.service !== service) return { match: false, via: null };
  const reason = imageRequestFrameChange(parts);
  if (reason) return { match: false, via: null, reason };
  return parts.size === 'max' ? { match: true, via: 'image-url', assumedFullSize: true } : { match: true, via: 'image-url' };
}

/**
 * Does the pixel geometry lie inside the annotation's mask (the part of the image that is the
 * georeferenced map)? True when every vertex is inside or on the mask and no edge crosses it.
 * With no mask, the whole image counts. Takes the same geometries and `space` as toWorld.
 */
export function containsRegion(g, geometry, { space } = {}) {
  spaceOf(space);
  const { geom } = pixelGeometry(g, geometry, space);
  const [sx, sy] = scaleToImage(g, space);
  const inImage = mapPositions(geom, ([x, y]) => [x * sx, y * sy]);
  const { width: w, height: h } = g.image;
  const mask = closeRing(g.mask && g.mask.length >= 3 ? g.mask : [[0, 0], [w, 0], [w, h], [0, h]]);
  if (!vertices(inImage).every((pt) => pointInRing(pt, mask))) return false;
  for (const [a, b] of edges(inImage)) {
    for (let i = 1; i < mask.length; i++) if (segmentsCross(a, b, mask[i - 1], mask[i])) return false;
  }
  return true;
}

// ---- What is written into PLATO ----------------------------------------------------------------

export const LABEL_ANCHOR = 'https://w3id.org/plato#LabelAnchor';
const LABEL_ANCHOR_NOTE = 'The position is where the map writes the name, not necessarily where the place is.';
const CITO = 'http://purl.org/spar/cito/';

/**
 * The fixed words georefNote uses for each transformation. A PLATO issue quotes and parses the
 * note, so these do not change.
 */
export const TRANSFORMATION_WORDS = Object.freeze(Object.fromEntries(Object.entries(TRANSFORMATIONS).map(([k, v]) => [k, v.words])));

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The note for PLATO `notes`: a FIXED TEMPLATE, quoted and parsed by a PLATO issue, so its wording
 * does not change:
 *
 *   Georeferenced through <annotationId> (<transformation words>, <N> control point(s)), retrieved <fetched>.
 *
 * with "retrieval date not recorded" in place of "retrieved <fetched>" when `fetched` is not given
 * (the user supplied the file). Then, each as its own fixed sentence: where the map is ("On canvas
 * <c> of manifest <m>." | "On canvas <c>." | "In manifest <m>." | "On image <i>."), and, when
 * record.role is LABEL_ANCHOR, "The position is where the map writes the name, not necessarily
 * where the place is."
 *
 * @param options.fetched When the annotation was retrieved: an ISO 8601 date-time with an offset
 *   or Z (e.g. 2026-09-30T14:05:00Z). A TypeError otherwise.
 */
export function georefNote(record, { fetched } = {}) {
  if (fetched !== undefined && (typeof fetched !== 'string' || !ISO_DATE_TIME.test(fetched) || Number.isNaN(Date.parse(fetched)))) {
    throw new TypeError(`fetched must be an ISO 8601 date-time with a time zone, such as 2026-09-30T14:05:00Z (it was ${JSON.stringify(fetched)}).`);
  }
  const words = TRANSFORMATION_WORDS[ALIASES[record.transformation] ?? record.transformation];
  if (!words) throw new TypeError(`The record names no known transformation (${JSON.stringify(record.transformation)}).`);
  const n = record.gcps;
  const when = fetched ? `retrieved ${fetched}` : 'retrieval date not recorded';
  const sentences = [`Georeferenced through ${record.annotationId ?? '(no identifier)'} (${words}, ${n} control point${n === 1 ? '' : 's'}), ${when}.`];
  if (record.canvasId && record.manifestId) sentences.push(`On canvas ${record.canvasId} of manifest ${record.manifestId}.`);
  else if (record.canvasId) sentences.push(`On canvas ${record.canvasId}.`);
  else if (record.manifestId) sentences.push(`In manifest ${record.manifestId}.`);
  else if (record.imageServiceId) sentences.push(`On image ${record.imageServiceId}.`);
  if (record.role === LABEL_ANCHOR) sentences.push(LABEL_ANCHOR_NOTE);
  return sentences.join(' ');
}

const okSize = (d) => d && Number.isFinite(d.width) && Number.isFinite(d.height) && d.width > 0 && d.height > 0;

/**
 * [x, y, w, h] padded by 2% of its larger side (at least 1), rounded outwards, then kept within size
 * when known (and at 0 or more always). A TypeError when nothing of the padded box is left: the
 * region is not on the canvas (or image) at all, which is the caller's mistake.
 */
function paddedXywh([x, y, w, h], size) {
  const pad = Math.max(1, 0.02 * Math.max(w, h));
  const clamp = (v, max) => Math.min(Math.max(0, v), max);
  const W = okSize(size) ? size.width : Infinity, H = okSize(size) ? size.height : Infinity;
  const x0 = clamp(Math.floor(x - pad + 1e-9), W), y0 = clamp(Math.floor(y - pad + 1e-9), H);
  const x1 = clamp(Math.ceil(x + w + pad - 1e-9), W), y1 = clamp(Math.ceil(y + h + pad - 1e-9), H);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) {
    throw new TypeError(`The region ${JSON.stringify([x, y, w, h])} lies outside the ${Number.isFinite(W) ? `${W} x ${H} ` : ''}picture it is given on, so it cannot be cited there.`);
  }
  return `${x0},${y0},${x1 - x0},${y1 - y0}`;
}

/** The locator for an explicit pixel bbox [x, y, w, h] in record.space (see georefCitation). */
function regionLocator(record, region) {
  if (!Array.isArray(region) || region.length !== 4 || !region.every(Number.isFinite) || region[2] <= 0 || region[3] <= 0) {
    throw new TypeError(`The region must be a pixel box [x, y, w, h] with a positive width and height (it was ${JSON.stringify(region)}).`);
  }
  const { canvasSize: c, imageSize: i } = record;
  const [x, y, w, h] = region;
  if (record.canvasId) {
    if (record.space === 'canvas') return `${record.canvasId}#xywh=${paddedXywh(region, c)}`;
    if (okSize(c) && okSize(i)) {
      const sx = c.width / i.width, sy = c.height / i.height;
      return `${record.canvasId}#xywh=${paddedXywh([x * sx, y * sy, w * sx, h * sy], c)}`;
    }
  }
  if (!record.imageServiceId) return record.canvasId ?? undefined;
  if (record.space === 'image') return `${record.imageServiceId}#xywh=${paddedXywh(region, i)}`;
  if (okSize(c) && okSize(i)) {
    const sx = i.width / c.width, sy = i.height / c.height;
    return `${record.imageServiceId}#xywh=${paddedXywh([x * sx, y * sy, w * sx, h * sy], i)}`;
  }
  return record.canvasId ?? undefined;
}

/**
 * A PLATO citation of the map: the manifest (else the image) as an inline source, as
 * src/formats/annotations.js writes one ({ '@id', title, authorityType }), cited as the evidence
 * (cito:citesAsEvidence: PLATO's pattern for georeferenced geometries, ontology.ttl plato:Geometry,
 * since plato:citation_function tells consumers not to assume evidence unless it is stated), and
 * the canvas as the locator, with "#xywh=…" in canvas units
 * (record.canvasRegion) when the geometry was a region. Only when there is no canvas, or its size
 * is unknown so the region cannot be converted, is the region given on the image service's id, in
 * image pixels.
 *
 * @param options.region A pixel box [x, y, w, h] in record.space, overriding record.canvasRegion:
 *   the locator is then the canvas "#xywh=…" of that box padded by 2% of its larger side (at least
 *   1 pixel), rounded outwards and kept within the canvas, in canvas units (converted from image
 *   pixels when needed); on the image service, in image pixels, when there is no canvas or its
 *   size is unknown. A TypeError when no part of the padded box is on the canvas (or image).
 */
export function georefCitation(record, { region } = {}) {
  const id = record.manifestId || record.imageServiceId;
  const title = record.title
    || (record.manifestId ? `The georeferenced map (IIIF manifest ${record.manifestId})` : `The georeferenced map (IIIF image ${record.imageServiceId})`);
  const source = { ...(id ? { '@id': id } : {}), title, authorityType: 'source' };
  let locator;
  if (region !== undefined) locator = regionLocator(record, region);
  else if (record.region && record.canvasId && record.canvasRegion) locator = `${record.canvasId}#xywh=${record.canvasRegion}`;
  else if (record.region && record.space === 'image' && record.imageServiceId) locator = `${record.imageServiceId}#xywh=${record.region}`;
  else if (record.canvasId) locator = record.canvasId;
  return { source, ...(locator ? { locator } : {}), citationFunction: `${CITO}citesAsEvidence` };
}

/**
 * A PLATO citation of the georeference annotation itself, whose method (its control points and
 * transformation) placed the position: { source: { '@id': annotationId, title: 'Georeference of
 * <map title>' (", made in Allmaps" when Allmaps' annotation server holds it), authorityType:
 * 'source', derivedFrom: <the map's source> }, citationFunction: cito:usesMethodIn }, as PLATO's
 * pattern for georeferenced geometries has it (plato:derived_from covers a work made from a
 * source). A TypeError when the record has no annotation id, since there is then nothing to cite.
 */
export function georefAnnotationCitation(record) {
  if (!record.annotationId) throw new TypeError('The georeference has no identifier, so it cannot be cited.');
  const of = record.title
    || (record.manifestId ? `the map in IIIF manifest ${record.manifestId}` : `the map in IIIF image ${record.imageServiceId}`);
  const allmaps = /^https:\/\/annotations\.allmaps\.org\//.test(record.annotationId) ? ', made in Allmaps' : '';
  const map = record.manifestId || record.imageServiceId;
  return {
    source: { '@id': record.annotationId, title: `Georeference of ${of}${allmaps}`, authorityType: 'source', ...(map ? { derivedFrom: map } : {}) },
    citationFunction: `${CITO}usesMethodIn`,
  };
}
