// The furniture of a map made from Chora's view (#37; Stephen's decisions of 14 October 2026): a scale bar,
// always, said to be true "at latitude N", and how much the scale varies across the map where that is more
// than about a tenth; a north arrow if wanted; the attribution written into the image, the coastline named by
// its source among it; an optional locator inset of Natural Earth's land, the map's extent outlined on it;
// and the key to the marks of how well a location is known, only where the map uses them. Each piece is
// SVG elements (svg.js) and the box it takes, which the labels keep clear of (labels.js). Pure.
import { el, num, pathData, FONT_STACK } from './svg.js';
import { clipLine, clipRing, thin } from './clip.js';
import { markShapes, placeShapes, MARK_SIZE, INK, CASING } from '../marks.js';

/** The size of the furniture, for a map `width` pixels wide: 1 at 1,200 pixels, never under 0.75 or over 3. */
export const unitOf = (width) => Math.max(0.75, Math.min(3, width / 1200));
const TEXT = '#1b1f24', PANEL = '#ffffff';
const text = (x, y, words, { size, anchor = 'start', weight = null, style = null, fill = TEXT } = {}) =>
  el('text', { x, y, 'font-family': FONT_STACK, 'font-size': size, 'text-anchor': anchor, 'font-weight': weight, 'font-style': style, fill }, words);

// ---- The scale bar -----------------------------------------------------------------------------

/** A length to show on a scale bar: the largest 1, 2 or 5 times a power of ten that is at most `metres`. */
export function niceLength(metres) {
  if (!(metres > 0)) return 0;
  const p = 10 ** Math.floor(Math.log10(metres));
  return [5, 2, 1].map((k) => k * p).find((v) => v <= metres) || p;
}
/** A length in words: kilometres, or metres under one. */
export const lengthWords = (m) => (m >= 1000 ? `${(m / 1000).toLocaleString('en-GB', { maximumFractionDigits: 3 })} km` : `${Math.round(m)} m`);
/** A latitude in words, to a whole degree: 38° N, 12° S, 0°. */
export const latitudeWords = (lat) => (Math.round(lat) === 0 ? '0°' : `${Math.abs(Math.round(lat))}° ${lat > 0 ? 'N' : 'S'}`);

/**
 * What the scale bar shows, for projection `proj` (project.js): { metres (its length on the ground), pixels
 * (its length on the map), latitude (where it is true: the middle of the map), varies (how much the scale
 * along a parallel differs between the top and the bottom of the map, as a share: 0.14 is 14%), words: the
 * caption, "at latitude 38° N", with the variation said where it is over `threshold` }.
 */
export function scaleOf(proj, { target = 140, threshold = 0.1 } = {}) {
  const [, south, , north] = proj.bounds;
  const lat = proj.kind === 'equirectangular' ? proj.standard : (south + north) / 2;
  const mpp = proj.metresPerPixel(lat);
  const metres = niceLength(mpp * target);
  const top = proj.metresPerPixel(north), bottom = proj.metresPerPixel(south);
  const varies = Math.abs(top - bottom) / Math.min(top, bottom);
  const at = `at latitude ${latitudeWords(lat)}`;
  const words = varies > threshold ? `${at}; the scale varies by ${Math.round(varies * 100)}% from the top of the map to the bottom` : at;
  return { metres, pixels: metres / mpp, latitude: lat, varies, words, caption: `Scale ${at}` };
}

/** The scale bar at the bottom left: { nodes, box }. */
export function scaleBar(proj, { unit = 1, margin = 14 } = {}) {
  const s = scaleOf(proj, { target: 140 * unit });
  const h = 6 * unit, size = 11 * unit, x0 = margin * unit, y0 = proj.height - margin * unit - size * 2.6 - h;
  const parts = 4, w = s.pixels / parts;
  const blocks = [];
  for (let i = 0; i < parts; i++) blocks.push(el('rect', { x: x0 + i * w, y: y0, width: w, height: h, fill: i % 2 ? PANEL : INK, stroke: INK, 'stroke-width': 0.8 * unit }));
  const label = text(x0 + s.pixels + 5 * unit, y0 + h, lengthWords(s.metres), { size });
  const zero = text(x0, y0 + h + size * 1.25, '0', { size: size * 0.9 });
  const caption = text(x0, y0 + h + size * 2.45, s.words, { size: size * 0.9 });
  const width = Math.max(s.pixels + 5 * unit + size * 0.6 * lengthWords(s.metres).length, size * 0.5 * s.words.length);
  const box = [x0 - 4 * unit, y0 - 4 * unit, x0 + width + 4 * unit, y0 + h + size * 2.9];
  const panel = el('rect', { x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1], fill: PANEL, 'fill-opacity': 0.75, rx: 2 * unit });
  return { nodes: [el('g', { id: 'scale-bar' }, panel, ...blocks, label, zero, caption)], box, scale: s };
}

// ---- The north arrow ---------------------------------------------------------------------------

/** A north arrow at the top right, below the inset if there is one: { nodes, box }. North is up on both projections. */
export function northArrow(proj, { unit = 1, margin = 14, below = 0 } = {}) {
  const x = proj.width - margin * unit - 10 * unit, y = margin * unit + below + 4 * unit, h = 26 * unit;
  const arrow = el('path', { d: `M${num(x)} ${num(y)}L${num(x + 7 * unit)} ${num(y + h)}L${num(x)} ${num(y + h * 0.72)}L${num(x - 7 * unit)} ${num(y + h)}Z`, fill: INK, stroke: CASING, 'stroke-width': unit });
  const n = text(x, y + h + 13 * unit, 'N', { size: 12 * unit, anchor: 'middle', weight: 'bold' });
  return { nodes: [el('g', { id: 'north-arrow' }, arrow, n)], box: [x - 10 * unit, y - 2 * unit, x + 10 * unit, y + h + 16 * unit] };
}

// ---- The attribution ---------------------------------------------------------------------------

/** Words wrapped into lines of at most `max` pixels (`measure`d), breaking at spaces only. */
export function wrap(words, max, measure, size) {
  const out = [];
  for (const para of String(words).split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${w}` : w;
      if (line && measure(next, { size }) > max) { out.push(line); line = w; } else line = next;
    }
    if (line) out.push(line);
  }
  return out;
}
/**
 * The attribution at the bottom right, on a pale panel: `lines` of words (the map's own licence and author,
 * each background's credit and licence, the relief's, the places' sources, the coastline's source), each
 * wrapped to at most half the map's width. { nodes, box }.
 */
export function attribution(proj, lines, { unit = 1, margin = 14, measure } = {}) {
  const size = 9.5 * unit, lh = size * 1.3, max = proj.width * 0.5;
  const wrapped = lines.flatMap((l) => wrap(l, max, measure, size));
  const width = Math.min(max, Math.max(0, ...wrapped.map((l) => measure(l, { size }))));
  const x1 = proj.width - margin * unit, y1 = proj.height - margin * unit;
  const box = [x1 - width - 8 * unit, y1 - wrapped.length * lh - 6 * unit, x1, y1];
  const panel = el('rect', { x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1], fill: PANEL, 'fill-opacity': 0.8, rx: 2 * unit });
  const texts = wrapped.map((l, i) => text(x1 - 4 * unit, box[1] + 3 * unit + size + i * lh, l, { size, anchor: 'end' }));
  return { nodes: [el('g', { id: 'attribution' }, panel, ...texts)], box, lines: wrapped };
}

/** The map's title at the top left, on a pale panel: { nodes, box }. */
export function titleBlock(proj, title, { unit = 1, margin = 14, measure } = {}) {
  if (!String(title || '').trim()) return { nodes: [], box: null };
  const size = 18 * unit, lines = wrap(title, proj.width * 0.55, measure, size), lh = size * 1.2;
  const width = Math.max(...lines.map((l) => measure(l, { size })));
  const x0 = margin * unit, y0 = margin * unit;
  const box = [x0, y0, x0 + width + 12 * unit, y0 + lines.length * lh + 8 * unit];
  const panel = el('rect', { x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1], fill: PANEL, 'fill-opacity': 0.8, rx: 2 * unit });
  return { nodes: [el('g', { id: 'title' }, panel, ...lines.map((l, i) => text(x0 + 6 * unit, y0 + 4 * unit + size * 0.95 + i * lh, l, { size })))], box };
}

// ---- The locator inset -------------------------------------------------------------------------

/**
 * A locator inset at the top right: Natural Earth's land (`land`, GeoJSON features of polygons) over a region
 * about six times as wide as the map's, plainly projected (longitude and latitude in proportion, true at its
 * middle), with the map's extent outlined in red. { nodes, box, region: [w, s, e, n] }.
 */
export function inset(proj, land, { unit = 1, margin = 14, share = 0.22 } = {}) {
  const [w, s, e, n] = proj.bounds;
  const cx = (w + e) / 2, cy = (s + n) / 2;
  const half = Math.min(180, Math.max(8, (e - w) * 3)), halfLat = Math.min(80, Math.max(5, (n - s) * 3));
  const region = [cx - half, Math.max(-85, cy - halfLat), cx + half, Math.min(85, cy + halfLat)];
  const cos = Math.cos((cy * Math.PI) / 180);
  const W = proj.width * share, H = Math.max(40, Math.min(proj.height * 0.4, (W * (region[3] - region[1])) / ((region[2] - region[0]) * cos)));
  const x0 = proj.width - margin * unit - W, y0 = margin * unit;
  const P = ([lon, lat]) => [x0 + ((lon - region[0]) / (region[2] - region[0])) * W, y0 + ((region[3] - lat) / (region[3] - region[1])) * H];
  const box = [x0, y0, x0 + W, y0 + H], clip = [x0, y0, x0 + W, y0 + H];
  const rings = [];
  for (const f of land || []) {
    const g = f.geometry || f;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) for (const ring of poly) {
      const c = clipRing(thin(ring.map(P), 0.6), clip);
      if (c) rings.push(c);
    }
  }
  const frame = [P([w, n]), P([e, n]), P([e, s]), P([w, s]), P([w, n])];
  return {
    region, box,
    nodes: [el('g', { id: 'inset' },
      el('rect', { x: x0, y: y0, width: W, height: H, fill: '#d5e3ea', stroke: INK, 'stroke-width': unit }),
      rings.length ? el('path', { d: pathData(rings, true), fill: '#f4f2ec', stroke: '#9aa5ab', 'stroke-width': 0.4 * unit, 'fill-rule': 'evenodd' }) : null,
      el('path', { d: pathData(clipLine(frame, clip)), fill: 'none', stroke: '#c0392b', 'stroke-width': 1.6 * unit }))],
  };
}

// ---- The key -----------------------------------------------------------------------------------

/** A mark's shapes (marks.js) as SVG elements, the same shapes a canvas draws (vague.js drawShapes). */
export function shapesSvg(shapes) {
  const inked = (attrs, width, dash) => [
    el('path', { ...attrs, fill: 'none', stroke: CASING, 'stroke-width': width + 3 }),
    el('path', { ...attrs, fill: 'none', stroke: INK, 'stroke-width': width, 'stroke-dasharray': dash.length ? dash.map(num).join(' ') : null }),
  ];
  return shapes.flatMap((s) => {
    switch (s.kind) {
      case 'lines': return inked({ d: s.segments.map(([a, b, c, d]) => `M${num(a)} ${num(b)}L${num(c)} ${num(d)}`).join('') }, s.width, s.dash);
      case 'arc': {
        const full = Math.abs(s.to - s.from) >= 2 * Math.PI - 1e-9;
        const p = (a) => `${num(s.cx + s.r * Math.cos(a))} ${num(s.cy + s.r * Math.sin(a))}`;
        const d = full ? `M${num(s.cx + s.r)} ${num(s.cy)}A${num(s.r)} ${num(s.r)} 0 1 1 ${num(s.cx - s.r)} ${num(s.cy)}A${num(s.r)} ${num(s.r)} 0 1 1 ${num(s.cx + s.r)} ${num(s.cy)}Z`
          : `M${p(s.from)}A${num(s.r)} ${num(s.r)} 0 ${s.to - s.from > Math.PI ? 1 : 0} 1 ${p(s.to)}`;
        return inked({ d }, s.width, s.dash);
      }
      case 'disc': return [el('circle', { cx: s.cx, cy: s.cy, r: s.r, fill: s.fill })];
      case 'ring': return [el('circle', { cx: s.cx, cy: s.cy, r: s.r, fill: 'none', stroke: s.stroke, 'stroke-width': s.width })];
      case 'polygon': return [el('path', { d: pathData([s.points], true), fill: s.fill })];
      default: return [];
    }
  });
}
/**
 * The key to the marks of how well a location is known, at the bottom left above the scale bar: one row for
 * each precision the map uses (`used`, in PLATO's order), its mark and its name, and the circle's where one is
 * drawn. `rows` are vague.js's keyRows. { nodes, box }.
 */
export function key(proj, rows, used, { unit = 1, margin = 14, above = 0, measure } = {}) {
  const shown = rows.filter((r) => used.includes(r.key));
  if (!shown.length) return { nodes: [], box: null };
  const size = 10.5 * unit, rh = 22 * unit, k = (rh * 1.05) / MARK_SIZE;
  const width = Math.max(...shown.map((r) => measure(`${r.name}: ${r.gloss}`, { size }))) + rh + 14 * unit;
  const x0 = margin * unit, y1 = proj.height - margin * unit - above - 6 * unit, y0 = y1 - shown.length * rh - 8 * unit;
  const nodes = [el('rect', { x: x0 - 4 * unit, y: y0, width, height: y1 - y0, fill: PANEL, 'fill-opacity': 0.8, rx: 2 * unit })];
  shown.forEach((r, i) => {
    const cy = y0 + 4 * unit + i * rh + rh / 2, cx = x0 + rh / 2;
    if (r.key === 'circle') nodes.push(el('circle', { cx, cy, r: rh * 0.38, fill: '#2757dd', 'fill-opacity': 0.1, stroke: '#2757dd', 'stroke-width': 1.5 * unit, 'stroke-dasharray': `${num(0.2 * unit)} ${num(3.5 * unit)}`, 'stroke-linecap': 'round' }));
    else nodes.push(el('circle', { cx, cy, r: 3 * unit, fill: '#2757dd', stroke: CASING, 'stroke-width': unit }), ...shapesSvg(placeShapes(markShapes(r.key), cx - (MARK_SIZE * k) / 2, cy - (MARK_SIZE * k) / 2, k)));
    nodes.push(text(x0 + rh + 6 * unit, cy + size * 0.35, `${r.name}: ${r.gloss}`, { size }));
  });
  return { nodes: [el('g', { id: 'key' }, ...nodes)], box: [x0 - 4 * unit, y0, x0 - 4 * unit + width, y1] };
}
