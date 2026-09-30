// Georeferenced Recogito regions (Hermes, pelagios/plato-tools#5): a region drawn on a map image,
// with the IIIF Georeference Annotation of that map, becomes a point in the world.
//
// The user supplies the georeferences (and, if they have them, the maps' IIIF manifests) with the
// Recogito export; nothing is fetched. A region (a media-fragment rectangle, or an SVG shape) on an
// image that a supplied georeference is for, whose centre lies inside exactly one such map's mask,
// is carried as ONE POINT: the region's centre, worked out in image pixels (the area centroid of an
// area, the midpoint by length of a line) and then placed with the map's own transformation (not
// the centre of the placed outline, which a non-linear transformation would move), with
// `precisionKm` the greatest ground distance from that point to any vertex of the placed outline
// (so that the radius holds the whole region), plus, for a transformation fitted by least squares,
// how far the georeference misses its own control points (the root mean square, in the record). The outline itself is not carried, and is reported. A
// region whose centre is inside the mask but beyond the convex hull of the georeference's control
// points (in image pixels, with a tolerance of 1% of the hull's diagonal) is not placed, since
// there the transformation only extrapolates. A region whose centre is inside both, but which
// reaches beyond the mask, is still placed, with a warning.
//
// The citation of the annotated image is REPLACED, for a placed region, by the citation of the map
// (the manifest, cito:citesAsEvidence, the region on the canvas as the locator), followed by the
// citation of the georeference (cito:usesMethodIn): one evidence citation, as in PLATO's worked
// example. The pixel region in words, where it says more than the map's locator, goes to the notes.
//
// What the point is (its role) needs evidence, never a guess:
//   - plato:LabelAnchor when the annotation gives the label's words or says it is a label: a
//     transcription, a quote (what src/formats/annotations.js takes as the attested name), or a tag
//     "label" (see isLabelTag), the one of these Recogito Studio's own editor can write;
//   - else no role, with a note saying why, and a warning. A region tagged "symbol" (isSymbolTag)
//     is given no role too, for now (see the TODO at roleOf).
// Everything else (no georeference for the image, a centre outside the map, in two maps or beyond
// its control points, a Recogito v1 document, a georeference that cannot place it) is reported by
// kind, and the region stays what it was before: a locator in words, in the citation of the image.
//
// The async functions here load Allmaps (through src/engine/georef/); they are only called when
// georeferences were supplied, so a run without them never loads it.
import { DataError, textStream } from '../engine/input.js';
import {
  readGeoreference, toWorld, matchTarget, containsRegion, georefNote, georefCitation, georefAnnotationCitation, LABEL_ANCHOR,
} from '../engine/georef/index.js';
import { normaliseId, manifestId } from '../engine/georef/iiif.js';
import { parseXywh, xywhPolygon, parseSvg, vertices, openRing, signedArea2 } from '../engine/georef/shapes.js';

/** The note on a placed region that nothing marks as a label. */
export const NO_ROLE_NOTE = 'The position is the centre of a region drawn on the map. Nothing in the annotation says that the region marks a label, so the position is given no role.';
/** The note on a placed region tagged as a symbol, which is given no role for now (see roleOf). */
export const SYMBOL_NOTE = 'The position is the centre of a region drawn on the map and tagged as a symbol; it is given no role.';
const MEDIA_FRAGS = /^https?:\/\/www\.w3\.org\/TR\/media-frags\/?$/;
const RECOGITO_V1 = /^https?:\/\/recogito\.pelagios\.org\//i;
const EARTH_KM = 6371.0088; // the mean radius (IUGG), for the haversine distance

/**
 * The tag conventions (documented in test/fixtures/annotations/README.md, "The mapping"): a tag
 * that marks a region as the map's label for the place, or as its symbol. A free tag whose text is
 * "label" (or "symbol"), or a tag from a vocabulary whose label is "label" or "map label" ("symbol"
 * or "map symbol"), singular or plural, whatever the vocabulary: these say the same thing in the
 * annotator's words, where a concept's own address would need a list of vocabularies to be
 * recognised. Case and surrounding space are ignored.
 */
export const isLabelTag = (text) => typeof text === 'string' && /^(map\s+)?labels?$/i.test(text.trim());
export const isSymbolTag = (text) => typeof text === 'string' && /^(map\s+)?symbols?$/i.test(text.trim());
/**
 * The role of a placed region's point, and the note for one with none.
 * TODO(maintainer): a region tagged "symbol" was to be plato:RepresentativePoint; an independent
 * review argued that a map's town symbol depicts a feature (plato:FeaturePoint, as PLATO's example
 * has it) rather than standing in for the place ("need not depict any feature"). Until the
 * maintainer chooses, a symbol is given no role, with its own note and the no-label warning.
 */
function roleOf(ctx) {
  if (ctx.symbol) return { role: undefined, note: SYMBOL_NOTE };
  if (ctx.label) return { role: LABEL_ANCHOR };
  return { role: undefined, note: NO_ROLE_NOTE };
}

/** A file's whole text, gzipped or not. */
async function wholeText(file) {
  const reader = (await textStream(file)).getReader();
  let s = '';
  for (;;) { const { value, done } = await reader.read(); if (done) return s; s += value; }
}
async function readJson(file) {
  let text;
  try { text = await wholeText(file); } catch (e) { throw new DataError(`it cannot be read (${String(e && e.message || e).split('\n')[0]})`); }
  try { return JSON.parse(text); } catch (e) { throw new DataError(`it is not well-formed JSON (${String(e.message).split('\n')[0]})`); }
}
const message = (e) => String(e && e.message || e).replace(/\.$/, '');

/**
 * Read the georeference files once each, and the manifests, pairing each map with the manifest
 * whose id is the manifest its annotation says it is part of. An AnnotationPage gives one map for
 * each of its annotations. A file that cannot be read, or a map in it that cannot, is reported
 * ('annotation-georef-unreadable', an error) and left out; the rest are used. A manifest that
 * belongs to no map is reported ('annotation-manifest-unused').
 * @returns Promise of [{ g, file, used }]
 */
export async function readGeoreferences(georefFiles, manifestFiles, report) {
  const manifests = [];
  for (const f of manifestFiles || []) {
    try {
      const json = await readJson(f);
      const id = normaliseId(manifestId(json));
      if (!id) throw new DataError('it is not a IIIF manifest with an id');
      manifests.push({ id, json, name: f.name, used: false });
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      report('annotation-georef-unreadable', `${f.name}: ${message(e)}`);
    }
  }
  const maps = [];
  for (const f of georefFiles || []) {
    let json;
    try { json = await readJson(f); } catch (e) {
      if (!(e instanceof DataError)) throw e;
      report('annotation-georef-unreadable', `${f.name}: ${message(e)}`);
      continue;
    }
    const count = json && typeof json === 'object' && (json.type ?? json['@type']) === 'AnnotationPage' && Array.isArray(json.items) ? json.items.length : 1;
    for (let index = 0; index < Math.max(count, 1); index++) {
      const where = `${f.name}${count > 1 ? ` (map ${index + 1} of ${count})` : ''}`;
      let g;
      try { g = await readGeoreference(json, { index }); } catch (e) {
        if (!(e instanceof DataError)) throw e;
        report('annotation-georef-unreadable', `${where}: ${message(e)}`);
        continue;
      }
      const m = g.manifestId ? manifests.find((x) => x.id === normaliseId(g.manifestId)) : undefined;
      if (m) {
        // The manifest gives the canvas's size; one that does not fit the map is reported, and the
        // map is used without it.
        try { g = await readGeoreference(json, { index, manifest: m.json }); m.used = true; } catch (e) {
          if (!(e instanceof DataError)) throw e;
          report('annotation-georef-unreadable', `${m.name}, with ${where}: ${message(e)}`);
        }
      }
      maps.push({ g, file: f.name, used: 0 });
    }
  }
  for (const m of manifests) if (!m.used) report('annotation-manifest-unused', m.name);
  return maps;
}

/** A map's name in the report: its title and its annotation's id, as far as it has them. */
const mapName = (g) => [g.title, g.annotationId].filter(Boolean).join(', ') || g.imageServiceId;

/** The targets annotations.js reads, in its order: each gives the citation of the same index. */
const readTargets = (a) => [].concat(a?.target ?? []).filter((t) => typeof t === 'string' || (t && typeof t === 'object'));
/** The regions a target's selectors draw: [{ kind: 'xywh' | 'svg', value }]. */
function regionsOf(t) {
  const out = [];
  for (const s of [].concat(t && typeof t === 'object' ? t.selector ?? [] : [])) {
    if (!s || typeof s !== 'object' || typeof s.value !== 'string') continue;
    if (s.type === 'SvgSelector') out.push({ kind: 'svg', value: s.value });
    // Only a selector that is a region and nothing else: "page=3&xywh=…" is a region of a page.
    else if (s.type === 'FragmentSelector' && (MEDIA_FRAGS.test(s.conformsTo || '') || /^xywh=/.test(s.value)) && /^xywh=[^&]*$/.test(s.value)) out.push({ kind: 'xywh', value: s.value });
  }
  return out;
}
const sourceOf = (t) => {
  if (typeof t === 'string') return t;
  if (!t || typeof t !== 'object') return undefined;
  const s = t.source && typeof t.source === 'object' ? t.source.id ?? t.source['@id'] : t.source;
  return typeof s === 'string' ? s : undefined;
};
/** How many SVG shapes the targets draw (for reporting them as before when they are not placed). */
export const svgRegionCount = (a) => readTargets(a).reduce((n, t) => n + regionsOf(t).filter((r) => r.kind === 'svg').length, 0);

/** The region as a GeoJSON-shaped geometry in image pixels (a percent region needs the image's size). */
function pixelGeometry(region, size) {
  if (region.kind === 'svg') return parseSvg(region.value);
  const r = parseXywh(region.value);
  if (r.percent && !(size && size.width > 0 && size.height > 0)) throw new DataError(`The region ${region.value} is given in per cent, and the size of the image is not known.`);
  return xywhPolygon(r, size);
}

/**
 * The centre of a pixel geometry: the area centroid of a polygon (holes subtracted) or of several;
 * the midpoint by length of a line or of several; the mean of the vertices only where there is no
 * area or length to weigh by.
 */
export function centreOf(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : null;
  if (polys) {
    let a = 0, cx = 0, cy = 0;
    for (const rings of polys) {
      for (const [i, raw] of rings.entries()) {
        const r = openRing(raw);
        // Each ring's signed area counts with the sign that makes the outer ring add and holes subtract.
        const sign = (signedArea2(r) >= 0) === (i === 0) ? 1 : -1;
        for (let k = 0; k < r.length; k++) {
          const [x0, y0] = r[k], [x1, y1] = r[(k + 1) % r.length];
          const cross = (x0 * y1 - x1 * y0) * sign;
          a += cross; cx += (x0 + x1) * cross; cy += (y0 + y1) * cross;
        }
      }
    }
    if (a !== 0) return [cx / (3 * a), cy / (3 * a)];
  } else if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
    const lines = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
    const total = lines.reduce((n, l) => n + l.slice(1).reduce((m, p, i) => m + Math.hypot(p[0] - l[i][0], p[1] - l[i][1]), 0), 0);
    let left = total / 2;
    for (const l of lines) {
      for (let i = 1; i < l.length; i++) {
        const d = Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
        if (d > 0 && left <= d) return [l[i - 1][0] + ((l[i][0] - l[i - 1][0]) * left) / d, l[i - 1][1] + ((l[i][1] - l[i - 1][1]) * left) / d];
        left -= d;
      }
    }
  }
  const v = vertices(geom);
  return [v.reduce((n, p) => n + p[0], 0) / v.length, v.reduce((n, p) => n + p[1], 0) / v.length];
}
/** The pixel bounding box [x, y, w, h] of a geometry. */
function bboxOf(geom) {
  const v = vertices(geom);
  const xs = v.map((p) => p[0]), ys = v.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
}
/** Great-circle distance in km between two [lon, lat] positions (haversine, mean radius). */
export function haversineKm([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180;
  const h = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** Kilometres rounded UP to the next 0.01 (a radius must hold the whole region). */
const upToHundredths = (km) => Math.ceil(km * 100 - 1e-9) / 100;
/**
 * The radius of a placed region, in km: the greatest ground distance from its point to any vertex
 * of its placed outline, plus the georeference's control-point misfit (record.controlPointMisfitKm,
 * the root mean square) where there is one: a transformation fitted by least squares misses its own
 * control points, and one that passes through them (a thin plate spline) has no misfit to add, and
 * no estimate of its error elsewhere. georefNote's misfit sentence says which.
 */
function radiusKm(point, outline, record) {
  const outlineKm = Math.max(0, ...vertices(outline).map((v) => haversineKm(point.coordinates, v)));
  return upToHundredths(outlineKm + (record.controlPointMisfitKm ?? 0));
}

/**
 * Place the regions of one annotation, adding to each of its attestations the point, the citations
 * of the map and of the georeference, and the note. `ctx` = { maps (from readGeoreferences), where
 * (the annotation, for the report), v1 (a Recogito v1 export), symbol (tagged as a symbol), label
 * (the annotation gives the label's words) }. Every region is reported by exactly one of the region
 * kinds, and a placed one also by 'annotation-region-shape'.
 */
export async function placeRegions(a, attestations, ctx, report) {
  const { maps, where } = ctx;
  const replaced = new Set();
  for (const [index, t] of readTargets(a).entries()) {
    const source = sourceOf(t);
    for (const region of regionsOf(t)) {
      const shape = region.kind === 'svg' ? 'an SVG shape' : `the rectangle ${region.value}`;
      if (ctx.v1 || (source && RECOGITO_V1.test(source))) { report('annotation-region-not-iiif', `${where}: ${shape} on ${source}`); continue; }
      const tried = maps.map((m) => ({ m, match: matchTarget(m.g, source) }));
      const candidates = tried.filter((x) => x.match.match);
      if (!candidates.length) {
        const why = tried.find((x) => x.match.reason);
        report('annotation-region-no-georef', why
          ? `${where}: ${source} is a ${why.match.reason} picture of the image ${why.m.g.imageServiceId}, whose pixels are not the image's`
          : `${where}: ${shape} on ${source}, which no georeference given is for`);
        continue;
      }
      for (const { match } of candidates) {
        if (match.via === 'image-url') report('annotation-region-image-url', `${where}: ${source}${match.assumedFullSize ? ' (size "max": the full size was assumed)' : ''}`);
      }
      try {
        // Which map a region is on is decided by its centre (in pixels): inside exactly one mask.
        const geoms = new Map(candidates.map(({ m }) => [m, pixelGeometry(region, m.g.image)]));
        const centres = new Map(candidates.map(({ m }) => [m, centreOf(geoms.get(m))]));
        const inside = candidates.filter(({ m }) => containsRegion(m.g, { type: 'Point', coordinates: centres.get(m) }, { space: 'image' }));
        const maps = (list) => (list.length === 1 ? `the map ${mapName(list[0].m.g)}` : `each of the maps ${list.map(({ m }) => mapName(m.g)).join('; ')}`);
        if (!inside.length) {
          const partly = candidates.some(({ m }) => vertices(geoms.get(m)).some((p) => containsRegion(m.g, { type: 'Point', coordinates: p }, { space: 'image' })));
          report('annotation-region-outside-map', `${where}: ${shape} on ${source} has its centre outside ${maps(candidates)}${partly ? ', though part of it is inside' : ', and lies wholly outside'}`);
          continue;
        }
        if (inside.length > 1) {
          report('annotation-region-ambiguous', `${where}: ${shape} on ${source} is inside ${inside.length} maps: ${inside.map(({ m }) => mapName(m.g)).join('; ')}`);
          continue;
        }
        const { m } = inside[0];
        const geom = geoms.get(m);
        // Beyond the control points a georeference extrapolates (a thin plate spline wildly: the
        // "45" in the Rocque map's border went to about -127.8, 57.4), so such a centre is not placed.
        if (!withinControlPoints(m.g, centres.get(m))) {
          report('annotation-region-beyond-control-points', `${where}: ${shape} on ${source} has its centre beyond the control points of ${maps(inside)}`);
          continue;
        }
        if (!containsRegion(m.g, geom, { space: 'image' })) report('annotation-region-crosses-map-edge', `${where}: ${shape} on ${source} reaches beyond ${maps(inside)}`);
        await place(m, geom, centres.get(m), attestations, { ...ctx, index, replaced }, report, shape);
      } catch (e) {
        if (!(e instanceof DataError)) throw e;
        report('annotation-region-unplaced', `${where}: ${shape} on ${source}: ${message(e)}`);
      }
    }
  }
}

/**
 * The convex hull of pixel positions (Andrew's monotone chain), with every turn positive by the
 * cross product, without repeated or collinear points: one point, two, or a polygon's vertices.
 */
export function convexHull(points) {
  const p = [...new Map(points.map((q) => [`${q[0]},${q[1]}`, q])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const h = [];
    for (const q of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return [...half(p), ...half([...p].reverse())];
}
/** Distance from a point to the segment a-b. */
function segmentDistance([x, y], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}
/** Share of the hull's diagonal (its bounding box's) by which a centre may lie outside it. */
export const HULL_TOLERANCE = 0.01;
/**
 * Whether a pixel position lies inside the convex hull of the georeference's control points (in
 * image pixels), or within HULL_TOLERANCE of the diagonal of the hull's bounding box of it: where the transformation
 * interpolates between evidence rather than extrapolating beyond it.
 */
export function withinControlPoints(g, point) {
  const hull = convexHull((g.controlPoints || []).map((c) => c.resource));
  if (!hull.length) return false;
  const xs = hull.map((q) => q[0]), ys = hull.map((q) => q[1]);
  const tolerance = HULL_TOLERANCE * Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (hull.length >= 3) {
    const cross = (a, b) => (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
    if (hull.every((a, i) => cross(a, hull[(i + 1) % hull.length]) >= 0)) return true;
  }
  const d = hull.length === 1 ? Math.hypot(point[0] - hull[0][0], point[1] - hull[0][1])
    : Math.min(...hull.map((a, i) => segmentDistance(point, a, hull[(i + 1) % hull.length])));
  return d <= tolerance;
}

/** The locator annotations.js writes for any SVG shape: it says nothing the canvas locator does not. */
const SHAPE_WORDS = 'a shape drawn on the image';

async function place(m, geom, centre, attestations, ctx, report, shape) {
  const { role, note } = roleOf(ctx);
  // The centre was worked out in pixels, and is placed as a point of its own.
  const { geojson: point, record } = await toWorld(m.g, { type: 'Point', coordinates: centre }, { space: 'image', role });
  const { geojson: outline } = await toWorld(m.g, geom, { space: 'image' });
  const geometry = { geojson: point, ...(role ? { role } : {}), precisionKm: [radiusKm(point, outline, record)] };
  // The region's exact pixel box (georefCitation pads nothing unless asked).
  const box = bboxOf(geom);
  const map = georefCitation(record, { region: box });
  // The pixel region in words adds something only where the map's locator does not give the same
  // box (a canvas of another size than the image, say).
  const same = typeof map.locator === 'string' && map.locator.endsWith(`#xywh=${box.join(',')}`);
  const method = record.annotationId ? [georefAnnotationCitation(record)] : [];
  // Georeference files are supplied by the user, so no retrieval date is known (georefNote says so);
  // the misfit sentence says what precisionKm holds of the georeference's own error.
  const notes = [georefNote(record, { misfit: true }), ...(note ? [note] : [])];
  const first = !ctx.replaced.has(ctx.index);
  ctx.replaced.add(ctx.index);
  for (const att of attestations) {
    const citations = [...(att.citations || [])];
    const own = citations[ctx.index];
    const words = own && own.locator && own.locator !== SHAPE_WORDS && !same ? [`Drawn on the map: ${own.locator}.`] : [];
    // The image's citation gives way to the map's, in its place (so that the citations of the other
    // targets keep theirs); another region on the same target adds its own citation of the map. The
    // citation of the georeference comes after.
    if (first && own) citations[ctx.index] = structuredClone(map);
    else citations.push(structuredClone(map));
    citations.push(...structuredClone(method));
    att.citations = citations;
    att.geometries = [...(att.geometries || []), structuredClone(geometry)];
    att.notes = [att.notes, ...(first ? words : []), ...notes].filter(Boolean).join('\n');
  }
  m.used++;
  report('annotation-region-shape', `${ctx.where}: ${shape}`);
  if (!role) report('annotation-region-no-label-evidence', ctx.where);
}
