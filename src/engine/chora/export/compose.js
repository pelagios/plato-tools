// A map made from Chora's view (#37, "Make an open map"), as one SVG: its background (Natural Earth as true
// vectors, vector.js; or a picture: a raster basemap's tiles, or a style rendered, embedded as an <image>),
// the shaded relief over it, a georeferenced historical map if chosen (embedded with its own affine
// transformation and clipped by its mask, or rendered beforehand into a picture of the map's size), the places
// (their areas, lines and points, each point's circle of uncertainty to scale, and the marks of how well each is
// known only with their key), their labels (labels.js), and the furniture (furniture.js). The PNG is drawn from
// this same file, so the two always match: for it, the fonts are inlined (`fonts`), as an image drawn from an
// SVG may load nothing else; the file for Commons names them only, as Commons ignores web fonts.
// Pure: every picture, font and dataset is given, already fetched.
import { el, num, raw, pathData, layer, svgDocument, FONT_STACK } from './svg.js';
import { projectionOf, exportView } from './project.js';
import { clipLine, clipRing, boxOf, thin } from './clip.js';
import { placeLabels, shownText } from './labels.js';
import { styleNodes } from './vector.js';
import { unitOf, scaleBar, northArrow, attribution, titleBlock, inset, key, shapesSvg } from './furniture.js';
import { circleAround } from '../geo.js';
import { markShapes, placeShapes, MARK_SIZE } from '../marks.js';

/** The colour the places are drawn in, with a white casing so that they read on any background. */
export const PLACE_COLOUR = '#b3261e';
const CASING = '#ffffff';

/** The layers of Natural Earth's style a plain map draws: no modern borders and no modern names. */
export const NE_PLAIN = ['ocean', 'land', 'rivers', 'lakes'];
/** Natural Earth's modern features, off unless asked for: the countries' tints, borders and names, and its towns. */
export const NE_MODERN = ['country-tint', 'admin1', 'boundaries', 'boundaries-disputed', 'river-labels', 'lake-labels', 'country-labels', 'place-dots', 'place-labels'];
/** Natural Earth's names of seas and of regions (mountains, deserts, peninsulas), each off unless asked for. */
export const NE_MARINE = ['marine-labels'], NE_PHYSICAL = ['physical-labels'];
/** The layers to draw of Natural Earth, by what is asked, in the style's own order. */
export function neLayers(style, { modern = false, marine = false, physical = false } = {}) {
  const want = new Set([...NE_PLAIN, ...(modern ? NE_MODERN : []), ...(marine ? NE_MARINE : []), ...(physical ? NE_PHYSICAL : [])]);
  return (style.layers || []).map((l) => l.id).filter((id) => want.has(id));
}

const isArea = (t) => t === 'Polygon' || t === 'MultiPolygon';
const isLine = (t) => t === 'LineString' || t === 'MultiLineString';
const isPoint = (t) => t === 'Point' || t === 'MultiPoint';

/**
 * The map. `m`:
 *   view, width, projection          what Chora shows ({ center, zoom, width, height }), the file's width in
 *                                    pixels, and 'mercator' or 'equirectangular';
 *   background                       { kind: 'vector', style, data, layers } (Natural Earth) or { kind: 'image',
 *                                    href, name } (a picture of the whole map, at its size);
 *   relief                           { href } (the toned relief at the map's size, a PNG with transparency) or null;
 *   historical                       { name, href, opacity, affine?: { matrix: [a, b, c, d, e, f], width, height,
 *                                    mask: [[x, y]] } (the image in its own pixels, placed by the matrix and
 *                                    clipped by the mask) } or null (a picture of the map's size otherwise);
 *   places                           [{ id, text, cls, size (at 1,200 pixels wide), note, hidden, offset,
 *                                    geometries: [{ geojson, precision, precisionKm }], point: [lon, lat] }];
 *   marks                            true to draw the marks of how well each location is known, with their key;
 *   keyRows                          vague.js's keyRows, for the key;
 *   furniture                        { north, inset: land features or null, title, attribution: [lines] };
 *   lang, title, desc, settings, dc  the file's language, words and metadata (svg.js svgDocument);
 *   measure                          a text's width (labels.js);
 *   fonts                            CSS @font-face rules (with data: addresses) to inline, or null.
 * Returns { svg, width, height, bounds, scale (furniture.js scaleOf's), labels (labels.js's, placed), overlapping
 * (how many labels found no free place), rasterInSvg (whether the file is mostly a picture), layers (the
 * Natural Earth layers drawn), projection }.
 */
export function composeMap(m) {
  const v = exportView(m.view, m.width);
  const proj = projectionOf(m.projection || 'mercator', v);
  const W = proj.width, H = proj.height, u = unitOf(W), scale = W / m.view.width;
  const box = boxOf(W, H, 6 * u);
  const body = [], defs = [];
  let rasterInSvg = false, layersDrawn = [], neLabels = [];

  // The background.
  const b = m.background || {};
  if (b.kind === 'vector') {
    const r = styleNodes(b.style, b.data, proj, { zoom: m.view.zoom, scale, only: b.layers || null });
    body.push(layer('background', 'Background: Natural Earth', ...r.nodes));
    layersDrawn = r.drawn; neLabels = r.labels;
  } else if (b.kind === 'image') {
    rasterInSvg = true;
    body.push(layer('background', `Background: ${b.name || 'a picture'}`, el('image', { x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none', 'xlink:href': b.href })));
  }
  if (m.relief?.href) {
    rasterInSvg = true;
    body.push(layer('relief', 'Shaded relief', el('image', { x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none', 'xlink:href': m.relief.href })));
  }
  const h = m.historical;
  if (h?.href) {
    rasterInSvg = true;
    const op = h.opacity !== undefined && h.opacity < 1 ? h.opacity : null;
    if (h.affine) {
      const mat = `matrix(${h.affine.matrix.map(num).join(' ')})`;
      const clip = h.affine.mask?.length >= 3 ? 'historical-mask' : null;
      if (clip) defs.push(el('clipPath', { id: clip, clipPathUnits: 'userSpaceOnUse' }, el('path', { transform: mat, d: pathData([h.affine.mask], true) })));
      body.push(layer('historical-map', `Historical map: ${h.name}`, el('g', { 'clip-path': clip ? `url(#${clip})` : null, opacity: op },
        el('image', { transform: mat, x: 0, y: 0, width: h.affine.width, height: h.affine.height, preserveAspectRatio: 'none', 'xlink:href': h.href }))));
    } else {
      body.push(layer('historical-map', `Historical map: ${h.name}`, el('image', { x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none', opacity: op, 'xlink:href': h.href })));
    }
  }

  // The places.
  const shown = (m.places || []);
  const areas = [], lines = [], circles = [], dots = [], marks = [], items = [], obstacles = [], usedPrecisions = new Set();
  let circleUsed = false;
  const dotR = 4 * u;
  for (const p of shown) {
    let anchor = null, isAreaLabel = false;
    for (const g of p.geometries || []) {
      const t = g.geojson?.type, c = g.geojson?.coordinates;
      if (isArea(t)) {
        const rings = (t === 'Polygon' ? [c] : c).flatMap((poly) => poly.map((ring) => clipRing(thin(ring.map(proj.project), 0.3), box)).filter(Boolean));
        if (rings.length) areas.push(el('path', { d: pathData(rings, true), 'data-place': p.id }));
        if (!anchor) { anchor = p.point; isAreaLabel = true; }
      } else if (isLine(t)) {
        const pieces = (t === 'LineString' ? [c] : c).flatMap((l) => clipLine(thin(l.map(proj.project), 0.3), box));
        if (pieces.length) lines.push(el('path', { d: pathData(pieces), 'data-place': p.id }));
        if (!anchor) anchor = p.point;
      } else if (isPoint(t)) {
        for (const pt of t === 'Point' ? [c] : c) {
          const [x, y] = proj.project(pt);
          if (x < 0 || y < 0 || x > W || y > H) continue;
          dots.push(el('circle', { cx: x, cy: y, r: dotR, 'data-place': p.id }));
          obstacles.push([x - dotR - 1, y - dotR - 1, x + dotR + 1, y + dotR + 1]);
          if (Number.isFinite(g.precisionKm) && g.precisionKm > 0) {
            const ring = circleAround(pt, g.precisionKm);
            const r = ring && clipRing(thin(ring.coordinates[0].map(proj.project), 0.3), box);
            if (r) { circles.push(el('path', { d: pathData([r], true), 'data-place': p.id })); circleUsed = true; }
          }
          if (m.marks && markShapes(g.precision)) {
            usedPrecisions.add(g.precision);
            const k = (1 * u), half = (MARK_SIZE * k) / 2;
            marks.push(el('g', { 'data-place': p.id }, ...shapesSvg(placeShapes(markShapes(g.precision), x - half, y - half, k))));
            obstacles.push([x - half * 0.8, y - half * 0.8, x + half * 0.8, y + half * 0.8]);
          }
          if (!anchor) anchor = pt;
        }
      }
    }
    anchor ||= p.point;
    if (!anchor || p.hidden) continue;
    const [x, y] = proj.project(anchor);
    if (x < 0 || y < 0 || x > W || y > H) continue;
    items.push({ id: p.id, text: p.text, cls: p.cls || 'settlement', size: (p.size || 13) * u, note: p.note || null, x, y, area: isAreaLabel && !(p.geometries || []).some((g) => isPoint(g.geojson?.type)),
      r: m.marks ? (MARK_SIZE * u) / 2 * 0.8 : dotR, offset: Array.isArray(p.offset) ? [p.offset[0] * (W / (p.offsetWidth || W)), p.offset[1] * (W / (p.offsetWidth || W))] : null, priority: p.priority || 0 });
  }
  const placeGroup = [];
  if (areas.length) placeGroup.push(el('g', { id: 'areas', fill: PLACE_COLOUR, 'fill-opacity': 0.18, stroke: PLACE_COLOUR, 'stroke-width': 1.8 * u, 'stroke-linejoin': 'round' }, ...areas));
  if (lines.length) {
    placeGroup.push(el('g', { id: 'lines-casing', fill: 'none', stroke: CASING, 'stroke-width': 4.5 * u, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, ...lines.map((l) => el('path', { d: l.attrs.d }))));
    placeGroup.push(el('g', { id: 'lines', fill: 'none', stroke: PLACE_COLOUR, 'stroke-width': 2.2 * u, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, ...lines));
  }
  if (circles.length) placeGroup.push(el('g', { id: 'uncertainty', fill: PLACE_COLOUR, 'fill-opacity': 0.08, stroke: PLACE_COLOUR, 'stroke-width': 1.6 * u, 'stroke-dasharray': `${num(0.2 * u)} ${num(3.5 * u)}`, 'stroke-linecap': 'round' }, ...circles));
  if (marks.length) placeGroup.push(el('g', { id: 'precision-marks' }, ...marks));
  if (dots.length) placeGroup.push(el('g', { id: 'points', fill: PLACE_COLOUR, stroke: CASING, 'stroke-width': 1.3 * u }, ...dots));
  if (placeGroup.length) body.push(layer('places', 'Places', ...placeGroup));

  // The furniture, then the labels, which keep clear of it.
  const fx = { unit: u, measure: m.measure };
  const f = m.furniture || {};
  const pieces = [];
  const sb = scaleBar(proj, fx); pieces.push(sb);
  const at = attribution(proj, f.attribution || [], fx); pieces.push(at);
  if (f.title) pieces.push(titleBlock(proj, f.title, fx));
  let insetBox = null;
  if (f.inset) { const i = inset(proj, f.inset, fx); pieces.push(i); insetBox = i.box; }
  if (f.north) pieces.push(northArrow(proj, { ...fx, below: insetBox ? insetBox[3] - insetBox[1] + 6 * u : 0 }));
  const keyUsed = [...(m.marks ? [...usedPrecisions] : []), ...(m.marks && circleUsed ? ['circle'] : [])];
  if (m.marks && keyUsed.length) pieces.push(key(proj, m.keyRows || [], keyUsed, { ...fx, above: sb.box[3] - sb.box[1] }));
  for (const pc of pieces) if (pc.box) obstacles.push(pc.box);
  for (const l of neLabels) obstacles.push(l.box);
  const placed = placeLabels(items, { obstacles, bounds: [W, H], measure: m.measure });
  const texts = placed.map((l) => el('text', {
    'data-place': l.id, 'font-family': FONT_STACK, 'text-anchor': l.anchor, fill: '#1b1f24', stroke: CASING, 'stroke-width': 3 * u, 'stroke-linejoin': 'round', 'paint-order': 'stroke',
    'font-style': l.cls === 'water' ? 'italic' : null, 'letter-spacing': l.cls === 'region' ? num(l.lines[0].spacing) : null,
    // A water label in a blue of its own, as a map names water.
    ...(l.cls === 'water' ? { fill: '#1f4e79' } : {}),
  }, ...l.lines.map((ln, k) => el('tspan', { x: l.x, y: ln.y, 'font-size': ln.size, 'letter-spacing': k && l.cls === 'region' ? '0' : null }, ln.text))));
  if (texts.length) body.push(layer('labels', 'Labels', ...texts));
  body.push(layer('furniture', 'Scale, attribution and key', ...pieces.flatMap((pc) => pc.nodes)));

  if (m.fonts) defs.unshift(el('style', { type: 'text/css' }, raw(`<![CDATA[${String(m.fonts).replace(/\]\]>/g, '')}]]>`)));
  const svg = svgDocument({ width: W, height: H, lang: m.lang || null, title: m.title || '', desc: m.desc || '', metadata: { settings: m.settings || null, dc: m.dc || {} }, defs, body });
  return { svg, width: W, height: H, bounds: proj.bounds, scale: sb.scale, labels: placed, overlapping: placed.filter((l) => l.overlaps).length, rasterInSvg, layers: layersDrawn, projection: proj.kind, unit: u };
}

/** The words of a label as it is drawn, for a test or a list: a region's in capitals. */
export { shownText };
