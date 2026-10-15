// How well a location is known, on Chora's map (Issue #16; WHG's place#64 and place#9). PLATO says it
// in two ways, and Chora draws each, and nothing more:
// - spatialPrecision (exact, approximate, uncertain, historical_approximate): around a point, a mark
//   of its own form; on a line or an area's outline, a casing of its own pattern. In dark ink on white,
//   so that each is told by its form and never by colour alone, and reads on a light basemap and a
//   dark one alike;
// - precisionKm: a circle of that many kilometres around a point (circleAround in geo.js), drawn on the
//   ground, so that it is the right size at every zoom and latitude.
// A location whose precision is not said has no mark and no casing, and one without precisionKm no
// circle: the map does not make up an uncertainty the data does not give. Each form means one PLATO
// value, so the question place#9 asks of a "porous" marker (uncertain where, how large, or whether at
// all?) has the answer PLATO's definition gives (PRECISION_WORDS).
//
// Pure, apart from drawing on a 2D canvas context it is given: the map (map.js) makes its icons with
// drawMark and its casings from LINE_DASHES, and the key (app.js) draws the same marks and casings
// with drawMark and drawLineSample, so that the two cannot differ.
import { PRECISIONS } from '../engine/chora/draw.js';
import { circleAround, positions } from '../engine/chora/geo.js';
import { markShapes, MARK_SIZE, INK, CASING } from '../engine/chora/marks.js';

export { PRECISIONS };
/** Each precision in words: its name, and PLATO's own gloss of it (plato:spatial_precision, ontology.ttl). */
export const PRECISION_WORDS = {
  exact: { name: 'exact', gloss: 'surveyed, or by GPS' },
  approximate: { name: 'approximate', gloss: 'estimated from maps or descriptions' },
  uncertain: { name: 'uncertain', gloss: 'one of several possible locations' },
  historical_approximate: { name: 'historical approximate', gloss: 'from historical sources, imprecise by nature' },
};
export const isPrecision = (p) => typeof p === 'string' && Object.hasOwn(PRECISION_WORDS, p);

// The marks themselves are one list of shapes for each precision (src/engine/chora/marks.js), which this
// file draws on a canvas and a map made from Chora's view writes in its SVG (#37): one description, two readers.
export { MARK_SIZE, INK, CASING } from '../engine/chora/marks.js';
/** A mark's image on the map, by precision: chora-precision-<value>. */
export const markImage = (p) => `chora-precision-${p}`;
const TAU = 2 * Math.PI;

// A path stroked twice, wide in white and then in ink, so that it shows on any basemap. A dashed one
// is cased whole, the white unbroken under the dashes, so that a gap shows the white and not the map.
function inked(ctx, path, width, dash = []) {
  for (const [colour, w, d] of [[CASING, width + 3, []], [INK, width, dash]]) {
    ctx.beginPath(); path(); ctx.setLineDash(d); ctx.lineWidth = w; ctx.strokeStyle = colour; ctx.stroke();
  }
  ctx.setLineDash([]);
}
/** Draw a mark's shapes (marks.js markShapes) on a 2D canvas context. */
export function drawShapes(ctx, shapes) {
  for (const s of shapes) {
    if (s.kind === 'lines') inked(ctx, () => { for (const [a, b, c, d] of s.segments) { ctx.moveTo(a, b); ctx.lineTo(c, d); } }, s.width, s.dash);
    else if (s.kind === 'arc') inked(ctx, () => ctx.arc(s.cx, s.cy, s.r, s.from, s.to), s.width, s.dash);
    else if (s.kind === 'disc') { ctx.beginPath(); ctx.arc(s.cx, s.cy, s.r, 0, TAU); ctx.fillStyle = s.fill; ctx.fill(); }
    else if (s.kind === 'ring') { ctx.beginPath(); ctx.arc(s.cx, s.cy, s.r, 0, TAU); ctx.lineWidth = s.width; ctx.strokeStyle = s.stroke; ctx.stroke(); }
    else if (s.kind === 'polygon') { ctx.beginPath(); s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fillStyle = s.fill; ctx.fill(); }
  }
}
/**
 * Draw the mark of precision `p` on `ctx`, a 2D canvas context of `size` CSS pixels each way (scaled
 * beforehand for a finer screen), centred on its middle. False, and nothing drawn, for a value PLATO
 * does not define.
 */
export function drawMark(ctx, p, size = MARK_SIZE) {
  if (!isPrecision(p)) return false;
  ctx.save(); drawShapes(ctx, markShapes(p, size)); ctx.restore();
  return true;
}

/**
 * A line's or an area outline's casing, by precision: an ink line LINE_CASING pixels wide under the
 * status's own line, on an unbroken white one, so that its pattern shows on either side of it.
 * Dashes are in line widths, as MapLibre's line-dasharray has them: exact solid; approximate dashed;
 * uncertain dotted (round dots, their period twice the casing's width, so that they never run into a
 * band); historical approximate dash and dot.
 */
export const LINE_CASING = 8, LINE_WHITE = 11;
export const LINE_DASHES = { exact: null, approximate: [2, 1.5], uncertain: [0.01, 2], historical_approximate: [2, 1, 0.01, 1] };
/**
 * Draw a short line of precision `p` as the map draws it (the white, the ink casing, and the status's
 * line in `colour` on top), across a `w` × `h` context. False, and nothing drawn, for a value PLATO
 * does not define.
 */
export function drawLineSample(ctx, p, w, h, colour) {
  if (!isPrecision(p)) return false;
  const y = h / 2, from = 4, to = w - 4;
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.beginPath(); ctx.moveTo(from, y); ctx.lineTo(to, y); ctx.lineWidth = LINE_WHITE; ctx.strokeStyle = CASING; ctx.stroke();
  const dash = LINE_DASHES[p];
  ctx.lineCap = dash && dash.includes(0.01) ? 'round' : 'butt';
  ctx.setLineDash(dash ? dash.map((x) => x * LINE_CASING) : []);
  ctx.beginPath(); ctx.moveTo(from, y); ctx.lineTo(to, y); ctx.lineWidth = LINE_CASING; ctx.strokeStyle = INK; ctx.stroke();
  ctx.setLineDash([]); ctx.lineCap = 'butt';
  ctx.beginPath(); ctx.moveTo(from, y); ctx.lineTo(to, y); ctx.lineWidth = 2.5; ctx.strokeStyle = colour; ctx.stroke();
  ctx.restore();
  return true;
}

const isPoints = (t) => t === 'Point' || t === 'MultiPoint';
/**
 * What the map draws of a place view's precision around its points: a FeatureCollection of the marks
 * (a Point for each point, and each point of a MultiPoint, with `precision` and `status`) and of the
 * circles (a Polygon of `km` around each, with `status`). A line or an area has no point to sit
 * around: its precision is drawn on its own outline (placeFeatures carries it, map.js cases it), and
 * PLATO's precisionKm of an area is the uncertainty of its boundary, which a circle would not show (for
 * a line, PLATO says nothing: the tools read it as an area's, and write it on the card). A radius too
 * large to draw (circleAround) has no circle; the card says so. Where a location gives several
 * precisions or radii (PLATO allows a list, "for heterogeneous geometries"), the first is drawn, as the
 * card writes it (view.js).
 */
export function vagueFeatures(view) {
  const features = [];
  for (const g of view?.geometries || []) {
    if (!isPoints(g?.geojson?.type)) continue;
    const status = g.status || 'asserted';
    for (const p of positions(g.geojson.coordinates)) {
      if (isPrecision(g.precision)) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p[0], p[1]] }, properties: { precision: g.precision, status } });
      const c = Number.isFinite(g.precisionKm) && g.precisionKm > 0 ? circleAround(p, g.precisionKm) : null;
      if (c) features.push({ type: 'Feature', geometry: c, properties: { status, km: g.precisionKm } });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** What the key says of each precision, and of the circle, in order: [{ key: precision | 'circle' | 'none', name, gloss }]. */
export function keyRows() {
  return [
    ...PRECISIONS.map((p) => ({ key: p, name: PRECISION_WORDS[p].name[0].toUpperCase() + PRECISION_WORDS[p].name.slice(1), gloss: PRECISION_WORDS[p].gloss })),
    { key: 'circle', name: 'Circle', gloss: 'how far the true position may be from the point, drawn to scale (points only)' },
    { key: 'none', name: 'No mark', gloss: 'how well it is known is not said' },
  ];
}
