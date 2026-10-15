// A small writer of SVG for the maps made from Chora's view (#37): elements as plain objects, written out
// as text with every attribute value and text escaped, numbers to two decimals, in the order given, so that
// the same map is the same file byte for byte (the tests hold one to a golden file). Its groups are
// Inkscape's layers (inkscape:groupmode="layer", each with a label), so that the map can be edited there
// layer by layer. Pure: nothing here knows what a map is.

export const SVG_NS = 'http://www.w3.org/2000/svg';
export const XLINK_NS = 'http://www.w3.org/1999/xlink';
export const INKSCAPE_NS = 'http://www.inkscape.org/namespaces/inkscape';
/** The namespace of the map's settings kept in its <metadata>, from which it can be made again. */
export const PLATO_MAP_NS = 'https://w3id.org/plato-tools/map#';
/**
 * The fonts a label is set in, in order. Wikimedia Commons draws an SVG with librsvg (2.60 since August
 * 2026) and the fonts installed there, and ignores web fonts: Noto Sans and DejaVu Sans are among those it
 * has, both with polytonic Greek. The PNG is drawn in the browser from the same file with Noto Sans inlined.
 */
export const FONT_STACK = 'Noto Sans, DejaVu Sans, Liberation Sans, sans-serif';

/** A number as the file writes it: at most two decimals, no trailing zeros, never "-0". */
export function num(n) {
  if (!Number.isFinite(n)) throw new TypeError(`Not a number to write in an SVG: ${n}`);
  const s = (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

/**
 * An element: `el('path', { d, fill }, ...children)`. An attribute whose value is null, undefined or false
 * is left out; a number is written by num(). A child is an element, a string (text), or a list of either.
 */
export function el(name, attrs = {}, ...children) {
  return { name, attrs, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
}
/** Text written as it is, unescaped: only for what this module itself has made safe (a CSS block). */
export const raw = (text) => ({ raw: String(text) });

/** An element and all within it, as text; `indent` puts each child element on its own line. */
export function serialize(node, indent = '') {
  if (typeof node === 'string') return escText(node);
  if (node && node.raw !== undefined) return node.raw;
  const attrs = Object.entries(node.attrs).filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => ` ${k}="${escAttr(typeof v === 'number' ? num(v) : v)}"`).join('');
  if (!node.children.length) return `<${node.name}${attrs}/>`;
  // Text is written on one line: the white space between its <tspan>s would be part of what it says.
  const elements = node.children.every((c) => typeof c !== 'string') && node.name !== 'text';
  if (!elements || indent === null) return `<${node.name}${attrs}>${node.children.map((c) => serialize(c, null)).join('')}</${node.name}>`;
  const inner = indent + '  ';
  return `<${node.name}${attrs}>\n${node.children.map((c) => inner + serialize(c, inner)).join('\n')}\n${indent}</${node.name}>`;
}

/** Path data for lines (lists of [x, y]); `closed` closes each (a ring). */
export function pathData(lines, closed = false) {
  return lines.filter((l) => l.length >= 2).map((l) => `M${l.map(([x, y]) => `${num(x)} ${num(y)}`).join('L')}${closed ? 'Z' : ''}`).join('');
}

/** An Inkscape layer: a group with an id and a label, shown as a layer in Inkscape's Layers panel. */
export const layer = (id, label, ...children) => el('g', { id, 'inkscape:groupmode': 'layer', 'inkscape:label': label }, ...children);

/**
 * A whole SVG document, as text: { width, height, lang (the language of its labels, xml:lang), title, desc,
 * metadata: { settings (the map's settings, JSON: kept so that it can be made again), dc: { title, creator,
 * rights, source, date } }, defs: [elements], body: [elements] }. The settings are kept as text in a
 * <plato:map> element of PLATO_MAP_NS, beside a Dublin Core description that Inkscape shows as the
 * document's metadata.
 */
export function svgDocument({ width, height, lang = null, title = '', desc = '', metadata = {}, defs = [], body = [] }) {
  const dc = metadata.dc || {};
  const rdf = el('rdf:RDF', { 'xmlns:rdf': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'xmlns:dc': 'http://purl.org/dc/elements/1.1/', 'xmlns:cc': 'http://creativecommons.org/ns#' },
    el('cc:Work', { 'rdf:about': '' },
      el('dc:format', {}, 'image/svg+xml'),
      dc.title ? el('dc:title', {}, dc.title) : null,
      dc.creator ? el('dc:creator', {}, el('cc:Agent', {}, el('dc:title', {}, dc.creator))) : null,
      dc.date ? el('dc:date', {}, dc.date) : null,
      dc.source ? el('dc:source', {}, dc.source) : null,
      dc.rights ? el('cc:license', { 'rdf:resource': dc.rights }) : null,
      lang ? el('dc:language', {}, lang) : null));
  const settings = metadata.settings ? el('plato:map', { 'xmlns:plato': PLATO_MAP_NS, version: '1' }, JSON.stringify(metadata.settings)) : null;
  const root = el('svg', {
    xmlns: SVG_NS, 'xmlns:xlink': XLINK_NS, 'xmlns:inkscape': INKSCAPE_NS, version: '1.1',
    width: Math.round(width), height: Math.round(height), viewBox: `0 0 ${Math.round(width)} ${Math.round(height)}`, 'xml:lang': lang || null,
  },
  title ? el('title', {}, title) : null,
  desc ? el('desc', {}, desc) : null,
  el('metadata', { id: 'metadata' }, rdf, settings),
  defs.length ? el('defs', {}, ...defs) : null,
  ...body);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(root)}\n`;
}

/**
 * The settings kept in a map's SVG (svgDocument's metadata.settings), read back from its text: the parsed
 * JSON, or null when the file holds none (it was not made here, or was edited so that it lost them).
 */
export function settingsIn(svgText) {
  const m = /<plato:map\b[^>]*>([\s\S]*?)<\/plato:map>/.exec(String(svgText));
  if (!m) return null;
  const t = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
  try { return JSON.parse(t); } catch { return null; }
}
