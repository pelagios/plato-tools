// The labels of a map made from Chora's view (#37; Stephen's decisions of 14 October 2026): which name each
// place is labelled with, and where the label goes.
//
// The name: the place's preferred label by default, or one of the names attested for it, offered by language
// and script; and a rule for the whole map ("Latin where attested, else the preferred label") that a label of
// its own overrides. One language per file: another is a click away, a map of its own.
//
// Where: our own placement, deterministic (the same places, view and settings give the same map, in the
// browser and in Node alike), greedy: each label in turn takes the first of eight positions round its point
// (upper right, lower right, upper left, lower left, right, above, left, below: the cartographer's order)
// that is inside the map and overlaps no label placed before it, no mark and nothing of the map's
// furniture (the scale bar, the attribution, the inset, the title); an area's label is centred on its
// centroid, or near it (above, below, to either side), placed before the points' as it has fewer places to go. A label the user has dragged keeps its place (its offset from its
// point) and is placed first. A label with no free position is put at its first and said to overlap, so
// that the panel can say so: never dropped unseen. No arrows (Stephen: a label is moved, not pointed).
//
// Text is measured by a function given (the page's canvas, in the font the PNG is drawn in; an estimate in
// Node), so this file draws nothing. Pure.
import { overlaps, overlapArea } from './clip.js';

/** The classes a label may be given: a settlement (plain), a region (spaced capitals), water (italic). */
export const LABEL_CLASSES = ['settlement', 'region', 'water'];
export const CLASS_WORDS = { settlement: 'a settlement', region: 'a region (spaced capitals)', water: 'water (italic)' };
/** A region's letters are spaced by this share of the font's size. */
export const REGION_SPACING = 0.15;
/** The line a label's short annotation is on is this share of the label's size. */
export const NOTE_RATIO = 0.8;
const LINE = 1.2;     // a line's height, in its font size
const ASCENT = 0.92;  // where the first baseline is below a box's top, in its font size

// ---- Which name ---------------------------------------------------------------------------------

/** A name's key among a place's names: its text, language and script, which together tell one from another. */
export const nameKey = (n) => `${n.toponym}|${n.language || ''}|${n.script || ''}`;
/**
 * The names a place's label may be chosen from: its preferred label first ({ key: 'label', text }), then
 * each name attested for it once (a name denied, being where the place is NOT so called, is not offered),
 * with its language and script, sorted by language then text so that the list reads the same each time.
 */
export function nameChoices(place) {
  const out = [{ key: 'label', text: place.label || '', language: null, script: null, preferred: true }];
  const seen = new Set();
  for (const n of place.names || []) {
    if (!n?.toponym || n.status === 'denied') continue;
    const k = nameKey(n);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ key: k, text: n.toponym, language: n.language || null, script: n.script || null, romanized: n.romanized || null });
  }
  const [first, ...rest] = out;
  rest.sort((a, b) => String(a.language || '~').localeCompare(String(b.language || '~')) || a.text.localeCompare(b.text));
  return [first, ...rest];
}
/** The languages the places' names are attested in, each once, sorted: what the whole-map rule offers. */
export const languagesOf = (places) => [...new Set(places.flatMap((p) => (p.names || []).filter((n) => n?.toponym && n.status !== 'denied' && n.language).map((n) => n.language)))].sort();
/** A language tag's base, lower case: 'la-Latn' → 'la'. */
const base = (t) => String(t || '').toLowerCase().split('-')[0];
/**
 * The text of a place's label: the name chosen for it (`chosen`, a key of nameChoices), if it has that
 * name; else the whole map's rule (`rule`: { language } for "this language where attested, else the
 * preferred label", or null for the preferred label throughout); else its preferred label. Where a
 * language has several names attested for a place, the first in the dataset's order is taken.
 */
export function labelText(place, { rule = null, chosen = null } = {}) {
  const choices = nameChoices(place);
  if (chosen) { const c = choices.find((x) => x.key === chosen); if (c) return c.text; }
  if (rule?.language) {
    const n = (place.names || []).find((x) => x?.toponym && x.status !== 'denied' && base(x.language) === base(rule.language));
    if (n) return n.toponym;
  }
  return place.label || '';
}

// ---- Where -------------------------------------------------------------------------------------

/** The eight positions round a point, in the order they are tried. */
export const POSITIONS = ['upper-right', 'lower-right', 'upper-left', 'lower-left', 'right', 'above', 'left', 'below'];

/** The text a label shows, as drawn: a region's in capitals. */
export const shownText = (text, cls) => (cls === 'region' ? String(text).toLocaleUpperCase() : String(text));

/** The size of a label's box: its lines' widths (`measure`d) and their heights. */
function sizeOf(item, measure) {
  const size = item.size, cls = item.cls || 'settlement';
  const text = shownText(item.text, cls);
  const spacing = cls === 'region' ? REGION_SPACING * size * Math.max(0, [...text].length - 1) : 0;
  const lines = [{ text, size, width: measure(text, { size, italic: cls === 'water' }) + spacing, spacing: cls === 'region' ? REGION_SPACING * size : 0 }];
  if (item.note) {
    const s = size * NOTE_RATIO;
    lines.push({ text: String(item.note), size: s, width: measure(String(item.note), { size: s, italic: false }), spacing: 0 });
  }
  return { lines, width: Math.max(...lines.map((l) => l.width)), height: lines.reduce((h, l) => h + l.size * LINE, 0) };
}

/** The box [x0, y0, x1, y1] of a label `w` × `h` at position `pos` round the point [x, y] with gap `g`. */
function boxAt(pos, [x, y], w, h, g) {
  switch (pos) {
    case 'upper-right': return [x + g * 0.7, y - g * 0.7 - h, x + g * 0.7 + w, y - g * 0.7];
    case 'lower-right': return [x + g * 0.7, y + g * 0.7, x + g * 0.7 + w, y + g * 0.7 + h];
    case 'upper-left': return [x - g * 0.7 - w, y - g * 0.7 - h, x - g * 0.7, y - g * 0.7];
    case 'lower-left': return [x - g * 0.7 - w, y + g * 0.7, x - g * 0.7, y + g * 0.7 + h];
    case 'right': return [x + g, y - h / 2, x + g + w, y + h / 2];
    case 'left': return [x - g - w, y - h / 2, x - g, y + h / 2];
    case 'above': return [x - w / 2, y - g - h, x + w / 2, y - g];
    case 'below': return [x - w / 2, y + g, x + w / 2, y + g + h];
    // An area's: centred on its point, then just above it, then just below.
    case 'centre': return [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
    case 'centre-above': return [x - w / 2, y - h * 1.5, x + w / 2, y - h / 2];
    case 'centre-below': return [x - w / 2, y + h / 2, x + w / 2, y + h * 1.5];
    case 'centre-left': return [x - w, y - h / 2, x, y + h / 2];
    case 'centre-right': return [x, y - h / 2, x + w, y + h / 2];
    case 'centre-above-far': return [x - w / 2, y - h * 2.5, x + w / 2, y - h * 1.5];
    case 'centre-below-far': return [x - w / 2, y + h * 1.5, x + w / 2, y + h * 2.5];
    default: throw new TypeError(`No label position "${pos}".`);
  }
}
const AREA_POSITIONS = ['centre', 'centre-above', 'centre-below', 'centre-left', 'centre-right', 'centre-above-far', 'centre-below-far'];
/** How the text sits in its box at a position: from its left, its middle or its right. */
const anchorOf = (pos) => (pos.startsWith('centre') ? 'middle' : /left$/.test(pos) ? 'end' : /right$/.test(pos) ? 'start' : 'middle');

/**
 * Place the labels. `items`: [{ id, text, x, y (the point, in the map's pixels), area (an area's label, at
 * its centroid), size (pixels), cls, note?, r (the mark's radius, which the label keeps clear of), offset?
 * ([dx, dy]: dragged, the box's top left from the point), hidden?, priority? (higher first) }]. `obstacles`:
 * boxes nothing may overlap (the marks of every place, the map's furniture). `bounds`: [width, height].
 * `measure(text, { size, italic })`: a text's width in pixels.
 *
 * Returns [{ id, position ('dragged' or one of POSITIONS, or an area's), anchor ('start' | 'middle' |
 * 'end'), x (where the text is anchored), lines: [{ text, size, x, y (its baseline), spacing }], box, cls,
 * overlaps (true when no position was free) }], in the order of `items`; a hidden label is left out.
 */
export function placeLabels(items, { obstacles = [], bounds: [W, H], measure, margin = 2 } = {}) {
  const placed = [], byId = new Map();
  const free = (b) => b[0] >= margin && b[1] >= margin && b[2] <= W - margin && b[3] <= H - margin
    && !placed.some((p) => overlaps(p.box, b)) && !obstacles.some((o) => overlaps(o, b));
  const cost = (b) => placed.reduce((s, p) => s + overlapArea(p.box, b), 0) + obstacles.reduce((s, o) => s + overlapArea(o, b), 0)
    + (b[0] < 0 || b[1] < 0 || b[2] > W || b[3] > H ? 1e6 : 0);
  // The order: dragged labels first, as they are where the user put them; then by priority; then areas, which
  // have fewer places to go than a point has; then as given.
  const order = items.map((it, i) => ({ it, i })).filter(({ it }) => !it.hidden && String(it.text || '').trim())
    .sort((a, b) => (b.it.offset ? 1 : 0) - (a.it.offset ? 1 : 0) || (b.it.priority || 0) - (a.it.priority || 0) || (b.it.area ? 1 : 0) - (a.it.area ? 1 : 0) || a.i - b.i);
  for (const { it } of order) {
    const { lines, width, height } = sizeOf(it, measure);
    const g = (it.r || 0) + Math.max(2, it.size * 0.25);
    let pos, box, over = false;
    if (Array.isArray(it.offset)) {
      pos = 'dragged';
      box = [it.x + it.offset[0], it.y + it.offset[1], it.x + it.offset[0] + width, it.y + it.offset[1] + height];
    } else {
      const tries = it.area ? AREA_POSITIONS : POSITIONS;
      for (const p of tries) { const b = boxAt(p, [it.x, it.y], width, height, g); if (free(b)) { pos = p; box = b; break; } }
      if (!box) {
        // None free: the one that overlaps least, said to overlap.
        let best = null;
        for (const p of tries) { const b = boxAt(p, [it.x, it.y], width, height, g); const c = cost(b); if (!best || c < best.c) best = { p, b, c }; }
        pos = best.p; box = best.b; over = true;
      }
    }
    const anchor = pos === 'dragged' ? 'start' : anchorOf(pos);
    const ax = anchor === 'start' ? box[0] : anchor === 'end' ? box[2] : (box[0] + box[2]) / 2;
    let y = box[1];
    const out = lines.map((l, k) => {
      const baseline = y + l.size * ASCENT + (k ? 0 : 0);
      y += l.size * LINE;
      return { text: l.text, size: l.size, x: ax, y: baseline, spacing: l.spacing };
    });
    const r = { id: it.id, position: pos, anchor, x: ax, lines: out, box, cls: it.cls || 'settlement', overlaps: over };
    placed.push(r); byId.set(it.id, r);
  }
  return items.map((it) => byId.get(it.id)).filter(Boolean);
}

/** A text's width estimated with no font at hand (for Node): its characters, a little over half the size each. */
export const estimate = (text, { size, italic = false }) => [...String(text)].length * size * (italic ? 0.56 : 0.58);
