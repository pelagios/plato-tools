// Georeferencing: positions on a map image to positions in the world and back, through a IIIF
// Georeference Annotation (as Allmaps makes them), for every PLATO tool that needs it.
//
//   import { readGeoreference, toWorld, toPixels, georefNote, georefCitation,
//            matchesTarget, containsRegion } from './engine/georef/index.js'
//
// ASYNC: readGeoreference, toWorld and toPixels return Promises. The Allmaps libraries they use
// are loaded by dynamic import() the first time one of them is called, so that a page which never
// meets a georeference never downloads them. georefNote, georefCitation, matchesTarget and
// containsRegion are synchronous and never load Allmaps.
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
import { normaliseId, labelText, manifestCanvases, partOfCanvases, manifestId as idOfManifest } from './iiif.js';
import {
  readGeojson, parseXywh, xywhPolygon, parseSvg, closeRing, openRing, signedArea2, pointInRing,
  segmentsCross, vertices, edges,
} from './shapes.js';

/**
 * The transformation library, as the record names it. A test checks this against
 * node_modules/@allmaps/transform/package.json, so it cannot drift from package.json's pin.
 */
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
/** An annotation's own transformation ({ type, options: { order } }) in our names. */
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
function enoughPoints(g, name) {
  const { min, words } = TRANSFORMATIONS[name];
  if (g.gcps < min) {
    throw new DataError(`The georeference ${g.annotationId ?? ''} has ${g.gcps} control point${g.gcps === 1 ? '' : 's'}, too few for a ${words} transformation, which needs at least ${min}.`.replace('  ', ' '));
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
    if (!item || item.motivation !== 'georeferencing') {
      throw new DataError(`${where} is not a Georeference Annotation: its motivation is ${JSON.stringify(item && item.motivation || null)}, not "georeferencing".`);
    }
    try { return parseAnnotation(item)[0]; }
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
    throw new DataError(`The georeference ${map.id ?? ''} is made in its own projection (${crs.name || crs.id || 'resourceCrs'}), which these tools cannot yet transform in; positions would not match where Allmaps draws the map.`.replace('  ', ' '));
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
  return g;
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
function makeRecord(g, direction, name, space, region, canvasRegion) {
  return {
    direction, transformation: name, gcps: g.gcps,
    annotationId: g.annotationId ?? null, manifestId: g.manifestId ?? null, canvasId: g.canvasId ?? null,
    imageServiceId: g.imageServiceId ?? null, space,
    ...(region ? { region } : {}),
    ...(region && canvasRegion && g.canvasId ? { canvasRegion } : {}),
    title: g.title ?? null,
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
 * @returns Promise of { geojson (WGS84 [lon, lat]; polygons closed, outer rings counter-clockwise), record }.
 */
export async function toWorld(g, geometry, { space, transformation, precision, densify } = {}) {
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
  const out = (m) => { const [lon, lat] = fromMercator(m); return [round(lon), round(lat)]; };
  const world = mapParts(inImage, {
    point: (pt) => out(t.transformToGeo(pt)),
    line: (l) => t.transformToGeo(l, opts).map(out),
    polygon: (rings) => t.transformToGeo(rings, opts).map((r) => r.map(out)),
  });
  return { geojson: orient(world), record: makeRecord(g, 'toWorld', name, space, region, canvasRegion) };
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

/** Is sourceId (an annotation target's source) this georeference's canvas or image? */
export function matchesTarget(g, sourceId) {
  const s = normaliseId(sourceId);
  if (!s) return false;
  return s === normaliseId(g.canvasId) || s === normaliseId(g.imageServiceId);
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

/** One sentence for PLATO `notes`, the same wherever it is written. */
export function georefNote(record) {
  const n = record.gcps;
  const words = (TRANSFORMATIONS[ALIASES[record.transformation] ?? record.transformation] || {}).words ?? record.transformation;
  const where = record.canvasId && record.manifestId ? `, canvas ${record.canvasId} of ${record.manifestId}`
    : record.canvasId ? `, canvas ${record.canvasId}`
      : record.manifestId ? `, in ${record.manifestId}`
        : record.imageServiceId ? `, image ${record.imageServiceId}` : '';
  const lead = record.direction === 'toPixels' ? 'Position on the map derived' : 'Position derived from the map';
  return `${lead} through its georeference ${record.annotationId ?? '(no identifier)'} (${n} control point${n === 1 ? '' : 's'}, ${words} transformation)${where}.`;
}

/**
 * A PLATO citation of the map: the manifest (else the image) as an inline source, as
 * src/formats/annotations.js writes one ({ '@id', title, authorityType }), and the canvas as the
 * locator, with "#xywh=…" in canvas units (record.canvasRegion) when the geometry was a region. Only
 * when there is no canvas, or its size is unknown so the region cannot be converted, is the region
 * given on the image service's id, in image pixels.
 */
export function georefCitation(record) {
  const id = record.manifestId || record.imageServiceId;
  const title = record.title
    || (record.manifestId ? `The georeferenced map (IIIF manifest ${record.manifestId})` : `The georeferenced map (IIIF image ${record.imageServiceId})`);
  const source = { ...(id ? { '@id': id } : {}), title, authorityType: 'source' };
  let locator;
  if (record.region && record.canvasId && record.canvasRegion) locator = `${record.canvasId}#xywh=${record.canvasRegion}`;
  else if (record.region && record.space === 'image' && record.imageServiceId) locator = `${record.imageServiceId}#xywh=${record.region}`;
  else if (record.canvasId) locator = record.canvasId;
  return { source, ...(locator ? { locator } : {}) };
}
