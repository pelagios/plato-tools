// Tracing from a historical map on Chora's page: which map a drawing was traced from, where it lies on
// that map, and what the attestation it becomes says of it (PLATO's pattern for a geometry traced
// from a georeferenced map, PLATO 3acab8e: the map cited as the evidence, with the canvas and a box on
// it as the locator; the georeference cited as the method, derived from the map; the fixed sentences of
// src/engine/georef/'s georefNote in the notes).
//
// The geometry saved is the one drawn, in longitude and latitude, unchanged: the map is where it was
// drawn from, and the georeference is how the drawing was placed. Positions on the map are those of
// src/engine/georef/, which fits the transformation as Allmaps' renderer draws the map (the browser
// checks compare the two in the page).
//
// Pure: no DOM, nothing fetched. The page gives it the georeferences of the maps shown (g, from
// readGeoreference), topmost first.
import * as georef from '../georef/index.js';
import { DataError } from '../input.js';
import { choraTracingNote, choraAssistedNote } from '../words.js';
import { countEdits } from './ink/edits.js';

/** Canvas pixels of context around a traced point, in the citation's box. */
export const POINT_CONTEXT_PX = 32;
/**
 * How far a drawing may come back from its round trip through the georeference (world to map and back
 * to the world), in pixels of the map there. The two directions are exact inverses (georef's toPixels),
 * so anything near this is a fault, not rounding: on the fixtures the worst is below 1e-6 px.
 */
export const ROUND_TRIP_PX = 0.05;

/** A drawing that cannot be cited as traced from the map; the message says why, in words. */
export class TraceError extends Error {
  constructor(message) { super(message); this.name = 'TraceError'; }
}

/** Every [x, y] of a GeoJSON-shaped geometry, in order. */
function vertices(geometry) {
  const out = [];
  const walk = (c) => { if (typeof c[0] === 'number') out.push(c); else c.forEach(walk); };
  walk(geometry.coordinates);
  return out;
}

/**
 * The map a drawing was traced from. `maps` are the maps shown, topmost first: [{ key, g, visible }]
 * (a map not shown, visible false, does not count; one at opacity 0 does). A map counts when its
 * mask holds at least one of the drawing's vertices; the topmost holding the whole drawing is chosen,
 * else the topmost holding part of it (partial: true, for a warning). A map whose georeference cannot
 * place the drawing (a fold, a horizon: a DataError) is passed over, and why is kept.
 * Returns { chosen: { key, partial } | null, candidates: [key], skipped: [{ key, reason }] }.
 */
export async function pickOverlay(maps, geojson, { toPixels = georef.toPixels } = {}) {
  const out = { chosen: null, candidates: [], skipped: [] };
  let whole = null, part = null;
  for (const m of maps) {
    if (m.visible === false) continue;
    let r;
    try { r = await toPixels(m.g, geojson, { space: 'image' }); } catch (e) {
      if (e instanceof DataError) { out.skipped.push({ key: m.key, reason: e.message }); continue; }
      throw e;
    }
    const vs = vertices(r.geometry);
    const inside = vs.filter((v) => georef.containsRegion(m.g, { type: 'Point', coordinates: v }, { space: 'image' }));
    if (!inside.length) continue;
    out.candidates.push(m.key);
    const all = inside.length === vs.length && georef.containsRegion(m.g, r.geometry, { space: 'image' });
    if (all && !whole) whole = { key: m.key, partial: false };
    if (!all && !part) part = { key: m.key, partial: true };
  }
  out.chosen = whole || part;
  return out;
}

const R = 6378137, RAD = Math.PI / 180;
/** Metres between two nearby positions (degrees), on the sphere of Web Mercator. */
function metres([lon1, lat1], [lon2, lat2]) {
  const x = (lon2 - lon1) * RAD * Math.cos(((lat1 + lat2) / 2) * RAD), y = (lat2 - lat1) * RAD;
  return Math.hypot(x, y) * R;
}

/**
 * The guard on a traced drawing: its pixels on the map (from toPixels) taken back into the world must
 * land where it was drawn, to within ROUND_TRIP_PX of the map's pixels there (each vertex's own scale,
 * measured by placing the pixel one to the right and one below). This tests the georeference module
 * against itself, so it is a guard against a fault, not proof that the map is drawn where the renderer
 * draws it (the browser checks compare those). Returns { ok, worstPx, degreesPerPx }.
 */
export async function roundTrip(g, drawn, pixels, { toWorld = georef.toWorld } = {}) {
  const back = vertices((await toWorld(g, pixels, { space: 'image', precision: 12 })).geojson);
  const px = vertices(pixels), dv = vertices(drawn);
  const probes = px.flatMap(([x, y]) => [[x, y], [x + 1, y], [x, y + 1]]);
  const w = (await georef.toWorld(g, { type: 'MultiPoint', coordinates: probes }, { space: 'image', precision: 12 })).geojson.coordinates;
  let worstPx = 0;
  for (let i = 0; i < dv.length; i++) {
    const perPx = Math.max(metres(w[3 * i], w[3 * i + 1]), metres(w[3 * i], w[3 * i + 2]));
    // A ring may come back the other way round (outer rings counter-clockwise): the nearest vertex.
    const off = Math.min(...back.map((b) => metres(dv[i], b)));
    worstPx = Math.max(worstPx, off / perPx);
  }
  const degreesPerPx = Math.hypot(w[1][0] - w[0][0], w[1][1] - w[0][1]);
  return { ok: worstPx <= ROUND_TRIP_PX, worstPx, degreesPerPx };
}

/** The box [x, y, w, h] of pixels, at least 1 pixel each way (a point, a level line), centred on it. */
function boxOf(pixels) {
  const vs = vertices(pixels);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of vs) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  let w = x1 - x0, h = y1 - y0;
  if (w < 1) { x0 -= (1 - w) / 2; w = 1; }
  if (h < 1) { y0 -= (1 - h) / 2; h = 1; }
  return [x0, y0, w, h];
}

const sized = (d) => d && Number.isFinite(d.width) && Number.isFinite(d.height) && d.width > 0 && d.height > 0;
/**
 * The region [x, y, w, h] of image pixels widened by `pad` CANVAS pixels each way ([x−p, y−p, w+2p,
 * h+2p], p the pad scaled from canvas to image pixels; the pad as image pixels when either size is
 * unknown), and kept within the image when its size is known. A pad of 0 leaves the region as it is.
 */
export function withContext(region, pad, record = {}) {
  if (!pad) return region;
  const c = record.canvasSize, i = record.imageSize, both = sized(c) && sized(i);
  const px = both ? pad * (i.width / c.width) : pad, py = both ? pad * (i.height / c.height) : pad;
  const [x, y, w, h] = region;
  let x0 = x - px, y0 = y - py, x1 = x + w + px, y1 = y + h + py;
  if (sized(i)) { x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(i.width, x1); y1 = Math.min(i.height, y1); }
  // Off the image altogether (not so for a point on the map's mask): left for georef to refuse, in words.
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : region;
}

/**
 * What a drawing traced from the map of `g` carries until it is saved: { key, title, record, region,
 * pad, partial, fetchedAt, licence }. record is georef's (toPixels, image pixels); region the box of
 * image pixels it covers (lines and areas followed along their curve on the map, to a pixel); pad the
 * context, in canvas pixels, put around it in the citation (POINT_CONTEXT_PX for a point, none for a
 * line or area; withContext, when it is saved: so a draft kept before it is cited the same way).
 * `meta` gives key, title, partial, fetchedAt (when the georeference was fetched; null if pasted) and
 * licence (the map's, to link in the citation). Throws TraceError when the round trip fails, and
 * DataError when the georeference cannot place the drawing.
 */
export async function traceFor(g, drawn, meta = {}) {
  const { geometry: px, record } = await georef.toPixels(g, drawn, { space: 'image' });
  const rt = await roundTrip(g, drawn, px);
  if (!rt.ok) {
    throw new TraceError(`The drawing does not come back through the map's georeference to where it was drawn (it is off by ${rt.worstPx.toFixed(2)} of the map's pixels), so it was not kept as traced from that map.`);
  }
  const point = drawn.type === 'Point';
  const dense = point ? px : (await georef.toPixels(g, drawn, { space: 'image', densify: 1 })).geometry;
  return {
    key: meta.key ?? null, title: meta.title ?? g.title ?? null, record, region: boxOf(dense), pad: point ? POINT_CONTEXT_PX : 0,
    partial: !!meta.partial, fetchedAt: meta.fetchedAt ?? null, licence: meta.licence ?? null,
  };
}

/**
 * The citations and notes of a traced drawing, when it is saved: the map (georefCitation, the
 * region padded as `trace.pad` says, the map's licence linked in its source) and the georeference
 * (georefAnnotationCitation: when it has an address; otherwise there is nothing to cite), and the notes:
 * how it was drawn (by hand, or with assistance: trace.assisted, its edits counted against `geometry`),
 * then georefNote's fixed sentences (with the date the georeference was fetched, and the label-anchor
 * sentence when the role is LabelAnchor).
 */
export function tracedParts(trace, { zoom, role, geometry, version } = {}) {
  const anchor = role === 'LabelAnchor' || role === georef.LABEL_ANCHOR;
  const record = anchor ? { ...trace.record, role: georef.LABEL_ANCHOR } : trace.record;
  // The context is put into the region here, and no pad is passed: georefCitation's own padding (2% of
  // the box now; none by default once georef takes a pad option) then adds nothing a point depends on.
  const map = georef.georefCitation(record, { region: withContext(trace.region, trace.pad, record) });
  if (trace.licence) map.source = { ...map.source, licence: trace.licence };
  const citations = [map, ...(record.annotationId ? [georef.georefAnnotationCitation(record)] : [])];
  // Traced with assistance (a shape proposed from the map's ink, then accepted): said so, with what was
  // done to it by hand, counted against the proposal (`geometry`, the drawing as saved).
  const how = trace.assisted
    ? choraAssistedNote(trace.assisted, geometry ? countEdits(trace.assisted.proposed, geometry) : null, { version, zoom })
    : choraTracingNote({ zoom });
  const notes = `${how} ${georef.georefNote(record, trace.fetchedAt ? { fetched: trace.fetchedAt } : {})}`;
  return { citations, notes };
}

/**
 * The notes of a shape traced with assistance that has since been moved off the map it was proposed from
 * (`assisted.from`, that map's title): no citation (the map no longer holds it), and the notes saying how
 * it was proposed, its edits counted against `geometry`, and that the map is not cited. It is not passed off
 * as drawn by hand.
 */
export function uncitedParts(assisted, { zoom, geometry, version } = {}) {
  const { from = null, ...a } = assisted;
  return { notes: choraAssistedNote(a, geometry ? countEdits(a.proposed, geometry) : null, { version, zoom, uncited: from || '' }) };
}

/** What a point traced from a map is taken to mark until the user says otherwise (a maintainer's decision). */
export const TRACED_POINT = { role: 'RepresentativePoint', precision: 'approximate' };
/**
 * A draft's role and precision once it is (`traced`) or is no longer traced from a map. A point traced from
 * a map's symbol stands for the place, approximately: a RepresentativePoint, 'approximate', not a
 * FeaturePoint (unless the user says the map draws the feature itself, choosing it). Off the map these
 * defaults go back to a basemap point's (none said). What the user chose (`d.chosen[field]`) stands; lines
 * and areas are left as they are. Returns { role, precision }.
 */
export function pointDefaults(d, traced) {
  const out = { role: d.role ?? '', precision: d.precision ?? '' };
  if (d.geojson?.type !== 'Point') return out;
  for (const f of ['role', 'precision']) {
    if (d.chosen?.[f]) continue;
    if (traced) out[f] = TRACED_POINT[f];
    else if (out[f] === TRACED_POINT[f]) out[f] = '';
  }
  return out;
}
