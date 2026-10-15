// Cutting what is drawn on a map made from Chora's view (#37) to the map's own rectangle, in its pixels:
// lines by Liang and Barsky's clipping, segment by segment, and the rings of areas by Sutherland and
// Hodgman's, edge by edge. A margin beyond the edge keeps a line's width and an area's outline from
// stopping short of it. Points closer together than a tolerance are thinned first (radially, keeping
// the ends), so that a coastline drawn at a small scale does not carry thousands of points the file
// cannot show. Pure.

/** The rectangle [x0, y0, x1, y1] of a map `width` × `height`, grown by `margin` pixels each way. */
export const boxOf = (width, height, margin = 0) => [-margin, -margin, width + margin, height + margin];

const inside = ([x, y], [x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

/**
 * Points of a line or a ring no nearer than `tol` pixels to the point kept before them, the first and last
 * always kept (so a ring stays closed). A tolerance of 0 keeps every point.
 */
export function thin(points, tol = 0.3) {
  if (!(tol > 0) || points.length < 3) return points.slice();
  const out = [points[0]], t2 = tol * tol;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i], [px, py] = out[out.length - 1];
    if ((x - px) ** 2 + (y - py) ** 2 >= t2) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

/** One segment cut to the box, Liang–Barsky: [[x, y], [x, y]], or null when none of it is inside. */
function clipSegment([ax, ay], [bx, by], [x0, y0, x1, y1]) {
  const dx = bx - ax, dy = by - ay;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [[ax + t0 * dx, ay + t0 * dy], [ax + t1 * dx, ay + t1 * dy]];
}
const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

/**
 * A line (a list of [x, y]) cut to the box: the pieces of it inside, each a list of two points or more,
 * in order. A line wholly inside comes back whole; one wholly outside, as no piece.
 */
export function clipLine(points, box) {
  const out = [];
  let cur = null;
  for (let i = 1; i < points.length; i++) {
    const s = clipSegment(points[i - 1], points[i], box);
    if (!s) { if (cur) { out.push(cur); cur = null; } continue; }
    if (cur && same(cur[cur.length - 1], s[0])) cur.push(s[1]);
    else { if (cur) out.push(cur); cur = [s[0], s[1]]; }
    // The segment left the box: the piece ends here.
    if (!inside(points[i], box)) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.filter((l) => l.length >= 2);
}

/**
 * A ring (a list of [x, y], closed or not) cut to the box, Sutherland–Hodgman: the part of the area inside,
 * as one ring, closed; null when nothing of it is inside. A ring that leaves the box and comes back may come
 * back joined along the box's edge, which fills nothing more than the area did.
 */
export function clipRing(ring, [x0, y0, x1, y1]) {
  let pts = same(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring.slice();
  const edges = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ];
  for (const [keep, cross] of edges) {
    if (!pts.length) break;
    const next = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i];
      if (keep(b)) { if (!keep(a)) next.push(cross(a, b)); next.push(b); }
      else if (keep(a)) next.push(cross(a, b));
    }
    pts = next;
  }
  if (pts.length < 3) return null;
  return [...pts, pts[0]];
}

/** Whether two rectangles [x0, y0, x1, y1] overlap (touching is not overlapping). */
export const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
/** The area two rectangles share, in square pixels (0 when they do not overlap). */
export const overlapArea = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
