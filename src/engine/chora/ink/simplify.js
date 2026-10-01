// Simplifying a traced line or outline: Douglas–Peucker, in image pixels, to within ε; if what comes out
// crosses itself (or one ring crosses another) where what went in did not, ε is halved and it is done
// again, down to EPSILON_FLOOR (then the shape is given unsimplified).

export const EPSILON = 0.75;
export const EPSILON_FLOOR = 0.1;

function segDist2(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
  return x * x + y * y;
}

/**
 * The corners of a traced path: vertices where it turns by more than `minTurn` degrees over `span` pixels
 * either way, at the sharpest point of each turn. Kept through simplification: the outline of a pixelated
 * corner is already blunted by up to a pixel, and dropping the vertex nearest the corner adds to that.
 */
export function corners(pts, { closed = false, span = 3, minTurn = 35 } = {}) {
  const n = closed && pts.length > 1 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1] ? pts.length - 1 : pts.length;
  if (n < 5) return [];
  const at = (k) => pts[((k % n) + n) % n];
  const turn = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    if (!closed && (k === 0 || k === n - 1)) continue;
    // The points a span's length of path back and ahead.
    let b = k, len = 0;
    while (len < span && (closed ? k - b < n - 1 : b > 0)) { const p = at(b), q = at(b - 1); len += Math.hypot(p[0] - q[0], p[1] - q[1]); b--; }
    let f = k; len = 0;
    while (len < span && (closed ? f - k < n - 1 : f < n - 1)) { const p = at(f), q = at(f + 1); len += Math.hypot(p[0] - q[0], p[1] - q[1]); f++; }
    const u = [at(k)[0] - at(b)[0], at(k)[1] - at(b)[1]], v = [at(f)[0] - at(k)[0], at(f)[1] - at(k)[1]];
    const nu = Math.hypot(u[0], u[1]), nv = Math.hypot(v[0], v[1]);
    if (!nu || !nv) continue;
    turn[k] = (Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (nu * nv)))) * 180) / Math.PI;
  }
  const out = [];
  for (let k = 0; k < n; k++) {
    if (turn[k] <= minTurn) continue;
    // The sharpest of its neighbours within the span.
    let best = true;
    for (let d = 1; d <= span + 1 && best; d++) {
      const a = closed ? ((k - d) % n + n) % n : k - d, c = closed ? (k + d) % n : k + d;
      if ((a >= 0 && turn[a] > turn[k]) || (c < n && turn[c] >= turn[k])) best = false;
    }
    if (best) out.push(k);
  }
  return out;
}

/** Douglas–Peucker of an open polyline [[x, y]…] (the ends, and the vertices in `keep`, are kept). */
export function douglasPeucker(pts, eps, keepAlso = []) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  for (const k of keepAlso) if (k > 0 && k < pts.length - 1) keep[k] = 1;
  const fixed = [...keep.keys()].filter((k) => keep[k]);
  const stack = fixed.slice(1).map((k, i) => [fixed[i], k]), e2 = eps * eps;
  while (stack.length) {
    const [i, j] = stack.pop();
    let worst = -1, at = -1;
    for (let k = i + 1; k < j; k++) { const d = segDist2(pts[k], pts[i], pts[j]); if (d > worst) { worst = d; at = k; } }
    if (worst > e2) { keep[at] = 1; stack.push([i, at], [at, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}

/** Douglas–Peucker of a closed ring (first point = last): split at the point farthest from the first. */
export function simplifyRing(ring, eps, span = 3) {
  const pts = ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring.slice();
  if (pts.length < 4) return [...pts, pts[0]];
  let far = 0, fd = -1;
  for (let k = 1; k < pts.length; k++) { const d = (pts[k][0] - pts[0][0]) ** 2 + (pts[k][1] - pts[0][1]) ** 2; if (d > fd) { fd = d; far = k; } }
  const cs = corners([...pts, pts[0]], { closed: true, span });
  const a = douglasPeucker(pts.slice(0, far + 1), eps, cs.filter((k) => k < far)), b = douglasPeucker([...pts.slice(far), pts[0]], eps, cs.filter((k) => k > far).map((k) => k - far));
  const out = [...a, ...b.slice(1)];
  return out.length >= 4 ? out : [...pts, pts[0]];
}

const orient = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
const onSeg = (a, b, p) => Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
function crosses(a, b, c, d) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSeg(a, b, c)) || (o2 === 0 && onSeg(a, b, d)) || (o3 === 0 && onSeg(c, d, a)) || (o4 === 0 && onSeg(c, d, b));
}

/**
 * Whether any two segments of these paths touch, other than neighbours along one path (and a ring's
 * last and first). `paths`: [{ pts, closed }]. Segments are bucketed on a grid, so long paths are cheap.
 */
export function selfIntersects(paths) {
  const segs = [];
  paths.forEach(({ pts, closed }, pi) => {
    const n = pts.length - 1;
    for (let k = 0; k < n; k++) segs.push({ a: pts[k], b: pts[k + 1], pi, k, n, closed });
  });
  if (segs.length < 2) return false;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, len = 0;
  for (const s of segs) { for (const p of [s.a, s.b]) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); } len += Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]); }
  const cell = Math.max(1, (len / segs.length) * 2);
  const grid = new Map();
  segs.forEach((s, i) => {
    const cx0 = Math.floor((Math.min(s.a[0], s.b[0]) - x0) / cell), cx1 = Math.floor((Math.max(s.a[0], s.b[0]) - x0) / cell);
    const cy0 = Math.floor((Math.min(s.a[1], s.b[1]) - y0) / cell), cy1 = Math.floor((Math.max(s.a[1], s.b[1]) - y0) / cell);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) { const key = cx * 1e6 + cy; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(i); }
  });
  const adjacent = (s, t) => s.pi === t.pi && (Math.abs(s.k - t.k) <= 1 || (s.closed && ((s.k === 0 && t.k === s.n - 1) || (t.k === 0 && s.k === t.n - 1))));
  const tested = new Set();
  for (const list of grid.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const p = Math.min(list[i], list[j]), q = Math.max(list[i], list[j]), key = p * segs.length + q;
      if (tested.has(key)) continue; tested.add(key);
      const s = segs[p], t = segs[q];
      if (adjacent(s, t)) continue;
      if (crosses(s.a, s.b, t.a, t.b)) return true;
    }
  }
  return false;
}

/**
 * Simplified within ε (halved while the result crosses itself and the input did not, down to the floor):
 * `paths` [{ pts, closed }] simplified together, corners kept (`scale` the pixels of the paths to a
 * working pixel, for the span corners are measured over). Returns { paths, epsilon } (epsilon the one used, or 0
 * when unsimplified).
 */
export function simplifyAll(paths, eps = EPSILON, floor = EPSILON_FLOOR, scale = 1) {
  const crossedBefore = selfIntersects(paths);
  for (let e = Math.max(eps, floor); ; e = Math.max(floor, e / 2)) {
    const out = paths.map(({ pts, closed }) => ({ pts: closed ? simplifyRing(pts, e, 3 * scale) : douglasPeucker(pts, e, corners(pts, { span: 3 * scale })), closed }));
    if (crossedBefore || !selfIntersects(out)) return { paths: out, epsilon: e };
    if (e === floor) break;
  }
  return { paths: paths.map((p) => ({ pts: p.pts.slice(), closed: p.closed })), epsilon: 0 };
}
