// Natural Earth, drawn as true vectors in a map made from Chora's view (#37; Stephen's decision of 14 October
// 2026, "SVG is a hybrid"): the basemap's own style (public/basemap/style.json) read layer by layer, each
// layer's filter and paint evaluated by MapLibre's own style specification (@maplibre/maplibre-gl-style-spec:
// featureFilter, createExpression), at the zoom the screen shows, so that the file's colours, widths and
// dashes are the screen's. Its fills, lines and circles become paths; its text (only the layers asked for:
// the seas and regions named, the modern names) becomes SVG text at each feature's point. A raster layer (the
// shaded relief) is not drawn here: compose.js embeds it. Pure: the sources' data is given.
import { featureFilter, createExpression, latest, Color } from '@maplibre/maplibre-gl-style-spec';
import { el, num, pathData, FONT_STACK } from './svg.js';
import { clipLine, clipRing, boxOf, thin, overlaps } from './clip.js';

const TYPE = { Point: 1, MultiPoint: 1, LineString: 2, MultiLineString: 2, Polygon: 3, MultiPolygon: 3 };
const SPEC = { fill: latest.paint_fill, line: latest.paint_line, circle: latest.paint_circle, symbol: { ...latest.paint_symbol, ...latest.layout_symbol }, background: latest.paint_background };

/** A colour as SVG writes it: { color: '#rrggbb', opacity } (the style may say rgba(), hsl() or a name). */
export function colour(v) {
  const c = v instanceof Color ? v : Color.parse(String(v ?? ''));
  if (!c) return { color: '#000000', opacity: 1 };
  const a = c.a, un = (x) => (a ? Math.round((x / a) * 255) : 0);
  const hex = (x) => Math.max(0, Math.min(255, un(x))).toString(16).padStart(2, '0');
  return { color: `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`, opacity: Math.round(a * 1000) / 1000 };
}

/** One property of a layer, evaluated for a feature at a zoom: the style's value, else the specification's default. */
function evaluator(layer, part, key, i) {
  const v = layer[part]?.[key];
  const spec = SPEC[layer.type]?.[key];
  if (v === undefined) return () => spec?.default;
  if (!spec) return () => v;
  const e = createExpression(v, spec, `layers[${i}].${part}.${key}`);
  if (e.result !== 'success') return () => spec.default;
  return (zoom, f) => { try { return e.value.evaluate({ zoom }, f); } catch { return spec.default; } };
}

const polygonsOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);
const linesOf = (g) => (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates
  : polygonsOf(g).flat());   // a line layer over an area draws its outlines, as MapLibre does
const pointsOf = (g) => (g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : []);

/**
 * The SVG elements of the style's layers, bottom first, for projection `proj` (project.js). `data`: each
 * GeoJSON source's FeatureCollection by its id. `zoom`: the zoom the screen shows (paint and filters are
 * evaluated at it). `scale`: the file's pixels per screen pixel (widths and sizes are multiplied by it).
 * `only`: the layer ids to draw (null for all). Returns { nodes: [one group per layer], labels: [{ text,
 * box }] (the text drawn, which the map's own labels keep clear of), drawn: [layer ids that drew anything] }.
 */
export function styleNodes(style, data, proj, { zoom, scale = 1, only = null } = {}) {
  const box = boxOf(proj.width, proj.height, 4 * scale), nodes = [], labels = [], drawn = [];
  for (const [i, layer] of (style.layers || []).entries()) {
    if (only && !only.includes(layer.id)) continue;
    if (layer.layout?.visibility === 'none' || layer.type === 'raster') continue;
    if ((layer.minzoom !== undefined && zoom < layer.minzoom) || (layer.maxzoom !== undefined && zoom >= layer.maxzoom)) continue;
    const P = (k) => evaluator(layer, 'paint', k, i), Lo = (k) => evaluator(layer, 'layout', k, i);
    if (layer.type === 'background') {
      const c = colour(P('background-color')(zoom));
      nodes.push(el('g', { id: `ne-${layer.id}` }, el('rect', { x: 0, y: 0, width: proj.width, height: proj.height, fill: c.color, 'fill-opacity': c.opacity < 1 ? c.opacity : null })));
      drawn.push(layer.id); continue;
    }
    const fc = data[layer.source];
    if (!fc) continue;
    const filter = layer.filter ? featureFilter(layer.filter, `layers[${i}].filter`) : null;
    const out = [];
    for (const f of fc.features || []) {
      const g = f.geometry;
      if (!g || !TYPE[g.type]) continue;
      const feature = { type: TYPE[g.type], properties: f.properties || {}, id: f.id };
      if (filter && !filter.filter({ zoom }, feature)) continue;
      if (layer.type === 'fill') {
        if (feature.type !== 3) continue;
        const rings = [];
        for (const poly of polygonsOf(g)) for (const ring of poly) { const c = clipRing(thin(ring.map(proj.project), 0.3), box); if (c) rings.push(c); }
        if (!rings.length) continue;
        const c = colour(P('fill-color')(zoom, feature)), o = Number(P('fill-opacity')(zoom, feature)) * c.opacity;
        const outline = layer.paint?.['fill-outline-color'] !== undefined ? colour(P('fill-outline-color')(zoom, feature)) : null;
        out.push(el('path', { d: pathData(rings, true), fill: c.color, 'fill-opacity': o < 1 ? o : null, 'fill-rule': 'evenodd',
          stroke: outline ? outline.color : null, 'stroke-width': outline ? 0.6 * scale : null, 'stroke-opacity': outline && outline.opacity < 1 ? outline.opacity : null }));
      } else if (layer.type === 'line') {
        const pieces = [];
        for (const line of linesOf(g)) pieces.push(...clipLine(thin(line.map(proj.project), 0.3), box));
        if (!pieces.length) continue;
        const c = colour(P('line-color')(zoom, feature)), w = Number(P('line-width')(zoom, feature)) * scale;
        const o = Number(P('line-opacity')(zoom, feature)) * c.opacity, dash = layer.paint?.['line-dasharray'] !== undefined ? P('line-dasharray')(zoom, feature) : null;
        out.push(el('path', { d: pathData(pieces), fill: 'none', stroke: c.color, 'stroke-width': w, 'stroke-opacity': o < 1 ? o : null,
          'stroke-dasharray': Array.isArray(dash) ? dash.map((d) => num(d * w)).join(' ') : null,
          'stroke-linecap': Lo('line-cap')(zoom, feature) === 'round' ? 'round' : null, 'stroke-linejoin': Lo('line-join')(zoom, feature) === 'round' ? 'round' : null }));
      } else if (layer.type === 'circle') {
        const r = Number(P('circle-radius')(zoom, feature)) * scale, c = colour(P('circle-color')(zoom, feature));
        const sw = Number(P('circle-stroke-width')(zoom, feature)) * scale, sc = colour(P('circle-stroke-color')(zoom, feature));
        for (const p of pointsOf(g)) {
          const [x, y] = proj.project(p);
          if (x < box[0] || y < box[1] || x > box[2] || y > box[3]) continue;
          out.push(el('circle', { cx: x, cy: y, r, fill: c.color, stroke: sw ? sc.color : null, 'stroke-width': sw || null }));
        }
      } else if (layer.type === 'symbol') {
        if (layer.layout?.['symbol-placement'] === 'line') continue;   // a river's name along it: not drawn
        let t = Lo('text-field')(zoom, feature);
        if (t && typeof t === 'object') t = t.sections ? t.sections.map((s) => s.text).join('') : String(t);
        t = String(t ?? '').trim();
        if (!t) continue;
        if (Lo('text-transform')(zoom, feature) === 'uppercase') t = t.toLocaleUpperCase();
        const size = Number(Lo('text-size')(zoom, feature)) * scale, ls = Number(Lo('text-letter-spacing')(zoom, feature)) * size;
        const c = colour(P('text-color')(zoom, feature)), halo = colour(P('text-halo-color')(zoom, feature)), hw = Number(P('text-halo-width')(zoom, feature)) * scale;
        for (const p of pointsOf(g).slice(0, 1)) {
          const [x, y] = proj.project(p);
          const w = [...t].length * size * 0.58 + ls * [...t].length, b = [x - w / 2, y - size * 0.7, x + w / 2, y + size * 0.5];
          if (b[0] < 0 || b[1] < 0 || b[2] > proj.width || b[3] > proj.height || labels.some((l) => overlaps(l.box, b))) continue;   // as MapLibre leaves out a label that collides
          labels.push({ text: t, box: b });
          out.push(el('text', { x, y: y + size * 0.35, 'font-family': FONT_STACK, 'font-size': size, 'text-anchor': 'middle', 'letter-spacing': ls ? num(ls) : null,
            'font-style': layer.metadata?.['plato-tools:italic'] ? 'italic' : null, fill: c.color, stroke: hw ? halo.color : null, 'stroke-width': hw ? hw * 2 : null,
            'stroke-linejoin': hw ? 'round' : null, 'paint-order': hw ? 'stroke' : null }, t));
        }
      }
    }
    if (out.length) { nodes.push(el('g', { id: `ne-${layer.id}` }, ...out)); drawn.push(layer.id); }
  }
  return { nodes, labels, drawn };
}
