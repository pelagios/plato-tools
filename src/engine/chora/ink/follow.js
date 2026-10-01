// Following a line from the click, both ways, through the skeleton's graph (graph.js): at a junction the
// branch that turns least (and, of two that turn alike, the one of the more like width) is taken, and the
// line stops when every branch turns by more than MAX_TURN; where the line ends (a break in the ink), a
// jump across the gap is looked for, ahead, within a cone, to a part of the line not yet used, and taken
// if one is found within reach. A chain once used is never entered again.
import { live } from './graph.js';

export const MAX_TURN = 60;      // degrees
export const JUMP_CONE = 20;     // degrees either side of the way ahead
export const JUMP_REACH = 3;     // times the width at the click
export const DIRECTION_SPAN = 2; // the way ahead is estimated over this many widths of the path

const angle = (u, v) => {
  const n = Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]);
  return n ? (Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / n))) * 180) / Math.PI : 180;
};

/**
 * Follow from skeleton pixel `start` (an index into the graph's w × h). `width` is the line's width at
 * the click (pixels), `widthAt(i)` a pixel's width; `jumps` whether gaps may be jumped; `isEdge(i)`
 * whether a pixel is on the edge of the window. Returns { px: [pixel index] in order along the line,
 * gaps: [[from, to]] (pixel indices), closed, ends: [first, last] (why each end stopped: 'end' | 'turn'
 * | 'used' | 'edge') }.
 */
export function follow(g, start, { width, widthAt = () => width, jumps = true, maxTurn = MAX_TURN, cone = JUMP_CONE, reach = JUMP_REACH, span = DIRECTION_SPAN, isEdge = () => false } = {}) {
  const { w } = g;
  const xy = (i) => [i % w, (i / w) | 0];
  let c0 = null, k0 = -1;
  for (const c of g.chains) { if (c.removed) continue; const k = c.px.indexOf(start); if (k >= 0) { c0 = c; k0 = k; break; } }
  if (!c0) return { px: [start], gaps: [], closed: false, ends: ['end', 'end'] };
  const used = new Set([c0.id]);
  const K = Math.max(3, Math.round(span * width));
  const gaps = [];
  const dirOf = (px) => { const a = xy(px[0]), b = xy(px[Math.min(px.length - 1, K)]); return [b[0] - a[0], b[1] - a[1]]; };

  // path: the pixels from the click to the end, in order; behind: those before the click, in the same
  // order (for the way ahead while the path is still short).
  function extend(path, behind) {
    const behindLen = 1;   // the click's own pixel is never let go
    const ahead = () => {
      const n = path.length, at = n - 1 - K;
      const a = at >= 0 ? xy(path[at]) : xy(behind[Math.max(0, behind.length + at)] ?? path[0]);
      const b = xy(path[n - 1]);
      return [b[0] - a[0], b[1] - a[1]];
    };
    const take = (px) => { for (const p of px) { path.push(p); if (isEdge(p)) return true; } return false; };
    if (path.some(isEdge)) return 'edge';
    for (let guard = 0; guard < 1e5; guard++) {
      const d = ahead();
      const node = g.nodeOf.get(path.at(-1));
      let next = null, options = [];
      if (node !== undefined) {
        options = live(g, node).filter((id) => !used.has(id)).map((id) => {
          const c = g.chains[id];
          const px = g.nodeOf.get(c.px[0]) === node ? c.px : [...c.px].reverse();
          const ws = px.slice(1, K + 1).map(widthAt).sort((p, q) => p - q);
          const wm = ws.length ? ws[ws.length >> 1] : width;
          return { c, px, turn: angle(d, dirOf(px)), dw: Math.abs(Math.log(Math.max(wm, 0.5) / Math.max(width, 0.5))) };
        }).sort((p, q) => (Math.abs(p.turn - q.turn) < 5 ? p.dw - q.dw : p.turn - q.turn));
        // A node with one way on and one way in (a spur pruned, a ring's own node) is passed, whatever its turn.
        const through = live(g, node).length === 2 && options.length === 1;
        if (options.length && (through || options[0].turn <= maxTurn)) next = options[0];
      }
      if (next) {
        used.add(next.c.id);
        // Through a junction, the pixels within a width of it are let go on both sides: thinning bends a
        // line towards the line crossing it, and the line is taken to run straight across.
        let head = 1;
        if (live(g, node).length >= 3) {
          const n = g.nodes[node], r2 = (Math.max(1.5, width)) ** 2;
          const near = (i) => { const [x, y] = xy(i); return (x - n.x) ** 2 + (y - n.y) ** 2 <= r2; };
          while (path.length > 2 && near(path.at(-1)) && path.length > behindLen + 1) path.pop();
          while (head < next.px.length - 1 && near(next.px[head])) head++;
        }
        if (take(next.px.slice(head))) return 'edge';
        continue;
      }
      const why = options.length ? 'turn' : node !== undefined && live(g, node).length > 1 ? 'used' : 'end';
      if (!jumps) return why;
      // A jump across a gap: the nearest unused pixel ahead, within reach and the cone.
      const e = xy(path.at(-1));
      let best = null, bd = Infinity;
      for (const c of g.chains) {
        if (c.removed || used.has(c.id)) continue;
        for (const p of c.px) {
          const q = xy(p), v = [q[0] - e[0], q[1] - e[1]], dist = Math.hypot(v[0], v[1]);
          if (dist < 1 || dist > reach * width || dist >= bd || angle(d, v) > cone) continue;
          bd = dist; best = { p, c };
        }
      }
      if (!best) return why;
      // On along that chain, the way closest to the way ahead.
      const k = best.c.px.indexOf(best.p);
      const toB = best.c.px.slice(k), toA = best.c.px.slice(0, k + 1).reverse();
      const way = toB.length < 2 ? toA : toA.length < 2 ? toB : (angle(d, dirOf(toB)) <= angle(d, dirOf(toA)) ? toB : toA);
      gaps.push([path.at(-1), best.p]);
      used.add(best.c.id);
      if (take(way)) return 'edge';
    }
    return 'end';
  }
  const forward = c0.px.slice(k0), backward = c0.px.slice(0, k0 + 1).reverse();
  const end1 = extend(forward, c0.px.slice(0, k0));
  const end0 = extend(backward, c0.px.slice(k0 + 1).reverse());
  const px = [...backward.reverse(), ...forward.slice(1)];
  const closed = px.length > 3 && px[0] === px.at(-1);
  return { px, gaps, closed, ends: [end0, end1] };
}
