// The marks of how well a location is known (Issue #16; src/chora/vague.js), as one list of shapes for each
// precision, that the map's icons and the key draw on a canvas (vague.js drawMark) and a map made from
// Chora's view writes in its SVG (#37, export/compose.js): one description of each mark, drawn by two
// readers of it, so that the screen and the file cannot differ, and never a third.
//
// A mark is drawn in a square of `size` pixels, centred on its middle. Each shape is one of:
//   { kind: 'arc', cx, cy, r, from, to, width, dash }  a circle (from 0 to 2π) or an arc, clockwise on the
//                                                       screen from `from` to `to` (radians), inked;
//   { kind: 'lines', segments: [[x0, y0, x1, y1]], width, dash }   straight strokes, inked;
//   { kind: 'disc', cx, cy, r, fill }                  a filled circle;
//   { kind: 'ring', cx, cy, r, width, stroke }         a circle stroked once, not inked;
//   { kind: 'polygon', points: [[x, y]], fill }        a filled shape.
// "Inked": stroked twice, wide in white (CASING, `width` + 3) and then in ink (INK, `width`, its `dash`), so
// that it shows on any basemap; a dashed one is cased whole, the white unbroken under the dashes.
// Pure: no canvas, no DOM.
export const INK = '#1b1f24', CASING = '#ffffff';
/** The size of a mark, in CSS pixels, square; the status's disc it surrounds is 16.5 across (map.js). */
export const MARK_SIZE = 44;
/** PLATO's spatial precisions (plato:spatial_precision), each drawn by a mark of its own. */
export const MARK_PRECISIONS = ['exact', 'approximate', 'uncertain', 'historical_approximate'];
const TAU = 2 * Math.PI, RING = 13.5, deg = (a) => (a * Math.PI) / 180;

/** The shapes of precision `p`'s mark in a square of `size`, or null for a value PLATO does not define. */
export function markShapes(p, size = MARK_SIZE) {
  const c = size / 2;
  switch (p) {
    // Four ticks out from the point: pinned to it.
    case 'exact':
      return [{ kind: 'lines', segments: [[0, -1], [1, 0], [0, 1], [-1, 0]].map(([dx, dy]) => [c + dx * 11, c + dy * 11, c + dx * 16.5, c + dy * 16.5]), width: 2, dash: [] }];
    // A dashed ring, whole: about here.
    case 'approximate':
      return [{ kind: 'arc', cx: c, cy: c, r: RING, from: 0, to: TAU, width: 2, dash: [5, 3.5] }];
    // Three small hollow rings round the point, a third of a turn apart, and no ring: one of several places,
    // and the point one of them.
    case 'uncertain':
      return [-90, 30, 150].flatMap((a) => {
        const x = c + 13 * Math.cos(deg(a)), y = c + 13 * Math.sin(deg(a));
        return [{ kind: 'disc', cx: x, cy: y, r: 4, fill: CASING }, { kind: 'arc', cx: x, cy: y, r: 3.2, from: 0, to: TAU, width: 1.6, dash: [] }];
      });
    // The dashed ring of an approximate location, broken at the top right for an hourglass: approximate, from
    // historical sources. The hourglass is out past the ring, clear of the status's disc (8.25 across from the point).
    case 'historical_approximate': {
      const x = c + 16.5 * Math.cos(deg(-45)), y = c + 16.5 * Math.sin(deg(-45));
      return [
        { kind: 'arc', cx: c, cy: c, r: RING, from: deg(-12), to: deg(-78) + TAU, width: 2, dash: [5, 3.5] },
        { kind: 'disc', cx: x, cy: y, r: 8, fill: CASING },
        { kind: 'ring', cx: x, cy: y, r: 8, width: 1.5, stroke: INK },
        // The hourglass, 12 pixels tall: two triangles point to point.
        { kind: 'polygon', points: [[x - 4, y - 6], [x + 4, y - 6], [x - 4, y + 6], [x + 4, y + 6]], fill: INK },
      ];
    }
    default: return null;
  }
}

/** The shapes moved by [dx, dy] and scaled by `k` (a mark drawn at a point of a map, at the map's scale). */
export function placeShapes(shapes, dx, dy, k = 1) {
  const P = (x, y) => [dx + x * k, dy + y * k];
  return shapes.map((s) => {
    switch (s.kind) {
      case 'lines': return { ...s, width: s.width * k, dash: s.dash.map((d) => d * k), segments: s.segments.map(([a, b, c, d]) => [...P(a, b), ...P(c, d)]) };
      case 'arc': { const [cx, cy] = P(s.cx, s.cy); return { ...s, cx, cy, r: s.r * k, width: s.width * k, dash: s.dash.map((d) => d * k) }; }
      case 'disc': { const [cx, cy] = P(s.cx, s.cy); return { ...s, cx, cy, r: s.r * k }; }
      case 'ring': { const [cx, cy] = P(s.cx, s.cy); return { ...s, cx, cy, r: s.r * k, width: s.width * k }; }
      case 'polygon': return { ...s, points: s.points.map(([x, y]) => P(x, y)) };
      default: throw new TypeError(`No mark shape "${s.kind}".`);
    }
  });
}
