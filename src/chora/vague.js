// How well a location is known, on Chora's map (Issue #16; WHG's place#64 and place#9). PLATO says it
// in two ways, and Chora draws each, and nothing more:
// - spatialPrecision (exact, approximate, uncertain, historical_approximate): a mark around the
//   location's point, one shape per value, in dark ink with a white casing, so that each is told by its
//   shape and never by colour alone, and reads on a light basemap and a dark one alike;
// - precisionKm: a circle of that many kilometres around a point (circleAround in geo.js), drawn on the
//   ground, so that it is the right size at every zoom and latitude.
// A location whose precision is not said has no mark, and one without precisionKm no circle: the map
// does not make up an uncertainty the data does not give. Each mark means one PLATO value, so the
// question place#9 asks of a "porous" marker (uncertain where, how large, or whether at all?) has
// the answer PLATO's definition gives (PRECISION_WORDS).
//
// Pure, apart from drawing a mark on a 2D canvas context it is given: the map (map.js) makes its icons
// with drawMark, and the key (app.js) draws the same marks with it, so that the two cannot differ.
import { PRECISIONS } from '../engine/chora/draw.js';
import { circleAround, reprPointOf, positions } from '../engine/chora/geo.js';

export { PRECISIONS };
/** Each precision in words: its name, and PLATO's own gloss of it (plato:spatial_precision, ontology.ttl). */
export const PRECISION_WORDS = {
  exact: { name: 'exact', gloss: 'surveyed, or by GPS' },
  approximate: { name: 'approximate', gloss: 'estimated from maps or descriptions' },
  uncertain: { name: 'uncertain', gloss: 'one of several possible locations' },
  historical_approximate: { name: 'historical approximate', gloss: 'from historical sources, imprecise by nature' },
};
export const isPrecision = (p) => typeof p === 'string' && Object.hasOwn(PRECISION_WORDS, p);

/** The size of a mark, in CSS pixels, square; the status's disc it surrounds is 19 across (map.js). */
export const MARK_SIZE = 36;
/** A mark's image on the map, by precision: chora-precision-<value>. */
export const markImage = (p) => `chora-precision-${p}`;
const INK = '#1b1f24', CASING = '#ffffff';

// A path stroked twice, wide in white and then in ink, so that it shows on any basemap.
function inked(ctx, path, width, dash = []) {
  for (const [colour, w] of [[CASING, width + 3], [INK, width]]) {
    ctx.beginPath(); path(); ctx.setLineDash(dash); ctx.lineWidth = w; ctx.strokeStyle = colour; ctx.stroke();
  }
  ctx.setLineDash([]);
}
// A small badge at the top right: a white disc with an ink rim, and something drawn in it.
function badge(ctx, s, inside) {
  const x = s - 7.5, y = 7.5;
  ctx.beginPath(); ctx.arc(x, y, 6.5, 0, 2 * Math.PI); ctx.fillStyle = CASING; ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = INK; ctx.stroke();
  inside(x, y);
}
const RING = 13.5;
const MARKS = {
  // Four ticks out from the point: pinned to it.
  exact(ctx, s) {
    const c = s / 2;
    inked(ctx, () => { for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) { ctx.moveTo(c + dx * 11, c + dy * 11); ctx.lineTo(c + dx * 16, c + dy * 16); } }, 2);
  },
  // A dashed ring: about here.
  approximate(ctx, s) {
    const c = s / 2;
    inked(ctx, () => ctx.arc(c, c, RING, 0, 2 * Math.PI), 2, [4, 3]);
  },
  // A dotted ring and a question mark: one of several places, this one among them.
  uncertain(ctx, s) {
    const c = s / 2;
    ctx.lineCap = 'round';
    inked(ctx, () => ctx.arc(c, c, RING, 0, 2 * Math.PI), 2.2, [0.1, 4]);
    ctx.lineCap = 'butt';
    badge(ctx, s, (x, y) => { ctx.fillStyle = INK; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('?', x, y + 0.5); });
  },
  // The dashed ring of an approximate location, and an hourglass: approximate, from historical sources.
  historical_approximate(ctx, s) {
    MARKS.approximate(ctx, s);
    badge(ctx, s, (x, y) => {
      ctx.beginPath(); ctx.moveTo(x - 3, y - 3.5); ctx.lineTo(x + 3, y - 3.5); ctx.lineTo(x - 3, y + 3.5); ctx.lineTo(x + 3, y + 3.5); ctx.closePath();
      ctx.fillStyle = INK; ctx.fill();
    });
  },
};
/**
 * Draw the mark of precision `p` on `ctx`, a 2D canvas context of `size` CSS pixels each way (scaled
 * beforehand for a finer screen), centred on its middle. False, and nothing drawn, for a value PLATO
 * does not define.
 */
export function drawMark(ctx, p, size = MARK_SIZE) {
  if (!isPrecision(p)) return false;
  ctx.save(); MARKS[p](ctx, size); ctx.restore();
  return true;
}

const isPoints = (t) => t === 'Point' || t === 'MultiPoint';
/**
 * What the map draws of a place view's precision: a FeatureCollection of the marks (a Point for each,
 * with `precision` and `status`) and of the circles (a Polygon of `km` around each point, with
 * `status`). A mark goes on a point, on each point of a MultiPoint, and on a line's or an area's
 * representative point (reprPointOf). A circle goes only around a point: PLATO's precisionKm of an
 * area or a line is the uncertainty of its boundary, which a circle would not show. Where a location
 * gives several precisions or radii (PLATO allows a list, "for heterogeneous geometries"), the first is
 * drawn, as the card writes it (view.js).
 */
export function vagueFeatures(view) {
  const features = [];
  for (const g of view?.geometries || []) {
    const type = g?.geojson?.type;
    if (!type) continue;
    const pts = isPoints(type) ? [...positions(g.geojson.coordinates)] : [reprPointOf(g.geojson)].filter(Boolean);
    const status = g.status || 'asserted';
    if (isPrecision(g.precision)) for (const p of pts) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p[0], p[1]] }, properties: { precision: g.precision, status } });
    if (isPoints(type) && Number.isFinite(g.precisionKm) && g.precisionKm > 0) {
      for (const p of pts) { const c = circleAround(p, g.precisionKm); if (c) features.push({ type: 'Feature', geometry: c, properties: { status, km: g.precisionKm } }); }
    }
  }
  return { type: 'FeatureCollection', features };
}

/** What the key says of each mark, and of the circle, in order: [{ precision | 'circle' | 'none', name, gloss }]. */
export function keyRows() {
  return [
    ...PRECISIONS.map((p) => ({ key: p, name: PRECISION_WORDS[p].name[0].toUpperCase() + PRECISION_WORDS[p].name.slice(1), gloss: PRECISION_WORDS[p].gloss })),
    { key: 'circle', name: 'Circle', gloss: 'how far the true position may be from the point, drawn to scale' },
    { key: 'none', name: 'No mark', gloss: 'how well it is known is not said' },
  ];
}
