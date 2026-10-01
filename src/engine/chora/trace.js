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
import { choraTracingNote } from '../words.js';

/**
 * What a point traced from a historical map is taken to be until the user says otherwise: a point
 * standing for the place, its position approximate. A map's symbol marks where the place is, not the
 * feature itself (a FeaturePoint only when the map draws the feature, a church drawn as such): the
 * user may choose that (Stephen, 2026-10-01; PLATO's georeference example follows it).
 */
export const TRACED_POINT_DEFAULTS = Object.freeze({ role: 'RepresentativePoint', precision: 'approximate' });

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

/**
 * Which map a traced drawing that was moved or reshaped is traced from now, given pickOverlay's result
 * over every map shown (`pick`) and the key of the map it was traced from (`wasKey`): that map, while it
 * holds any of the drawing (the user's choice, or the one made before, stands); else the one pickOverlay
 * chooses; else null, when it lies on none.
 */
export function afterReshape(pick, wasKey) {
  return pick.candidates.includes(wasKey) ? wasKey : pick.chosen?.key ?? null;
}

const R = 6371008.8, RAD = Math.PI / 180;
/** Metres between two nearby positions (degrees), on a sphere of the IUGG mean radius, as georef's metresPerPixel measures. */
function metres([lon1, lat1], [lon2, lat2]) {
  const x = (lon2 - lon1) * RAD * Math.cos(((lat1 + lat2) / 2) * RAD), y = (lat2 - lat1) * RAD;
  return Math.hypot(x, y) * R;
}

/**
 * The guard on a traced drawing: its pixels on the map (from toPixels) taken back into the world must
 * land where it was drawn, to within ROUND_TRIP_PX of the map's pixels there (each vertex's own scale,
 * from georef's metresPerPixel, the geometric mean of the scale along x and along y). This tests the
 * georeference module against itself, so it is a guard against a fault, not proof that the map is
 * drawn where the renderer draws it (the browser checks compare those). Returns { ok, worstPx,
 * metresPerPx } (metresPerPx: the scale at the first vertex).
 */
export async function roundTrip(g, drawn, pixels, { toWorld = georef.toWorld } = {}) {
  const back = vertices((await toWorld(g, pixels, { space: 'image', precision: 12 })).geojson);
  const px = vertices(pixels), dv = vertices(drawn);
  let worstPx = 0, metresPerPx = null;
  for (let i = 0; i < dv.length; i++) {
    const { mean } = await georef.metresPerPixel(g, px[i], { space: 'image' });
    metresPerPx ??= mean;
    // A ring may come back the other way round (outer rings counter-clockwise): the nearest vertex.
    const off = Math.min(...back.map((b) => metres(dv[i], b)));
    worstPx = Math.max(worstPx, off / mean);
  }
  return { ok: worstPx <= ROUND_TRIP_PX, worstPx, metresPerPx };
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

/**
 * What a drawing traced from the map of `g` carries until it is saved: { key, title, record, region,
 * pad, partial, fetchedAt, licence }. record is georef's (toPixels, image pixels); region the box of
 * image pixels it covers (lines and areas followed along their curve on the map, to a pixel); pad the
 * context, in canvas pixels, put around it in the citation (POINT_CONTEXT_PX for a point, none for a
 * line or area; georefCitation's pad, when it is saved: so a draft kept before it is cited the same way).
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
 * how it was drawn, then georefNote's fixed sentences (with the date the georeference was fetched, and
 * the label-anchor sentence when the role is LabelAnchor).
 */
export function tracedParts(trace, { zoom, role } = {}) {
  const anchor = role === 'LabelAnchor' || role === georef.LABEL_ANCHOR;
  const record = anchor ? { ...trace.record, role: georef.LABEL_ANCHOR } : trace.record;
  // The box of image pixels, padded by `pad` canvas pixels on every side by georef (converted to image
  // pixels where the citation falls back to the image), rounded outwards and kept on the canvas.
  const map = georef.georefCitation(record, { region: trace.region, ...(trace.pad ? { pad: trace.pad } : {}) });
  if (trace.licence) map.source = { ...map.source, licence: trace.licence };
  const citations = [map, ...(record.annotationId ? [georef.georefAnnotationCitation(record)] : [])];
  const notes = `${choraTracingNote({ zoom })} ${georef.georefNote(record, trace.fetchedAt ? { fetched: trace.fetchedAt } : {})}`;
  return { citations, notes };
}
