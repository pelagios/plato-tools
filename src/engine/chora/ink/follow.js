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
// A narrow fork (two ways on within FORK_SPLIT degrees of each other): thinning joins the two lines' ink for
// several widths before the junction and bends the skeleton between them, so each way is judged over a longer
// baseline, FORK_SPAN widths back along the line and twice that on along each way; and when the two turn alike
// (by less than FORK_AMBIGUOUS of the angle between them) and are alike in width, the line stops at the fork
// ('fork') rather than guess.
export const FORK_SPLIT = 30, FORK_SPAN = 8, FORK_AMBIGUOUS = 0.3;

const angle = (u, v) => {
  const n = Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]);
  return n ? (Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / n))) * 180) / Math.PI : 180;
};

/**
 * Follow from skeleton pixel `start` (an index into the graph's w × h). `width` is the line's width at
 * the click (pixels), `widthAt(i)` a pixel's width; `jumps` whether gaps may be jumped; `isEdge(i)`
 * whether a pixel is on the edge of the window. Returns { px: [pixel index] in order along the line,
 * gaps: [[from, to]] (pixel indices), closed, ends: [first, last] (why each end stopped: 'end' | 'turn'
 * | 'used' | 'edge' | 'fork') }.
 */
export function follow(g, start, { width, widthAt = () => width, jumps = true, maxTurn = MAX_TURN, cone = JUMP_CONE, reach = JUMP_REACH, span = DIRECTION_SPAN, isEdge = () => false, forkSpan = FORK_SPAN } = {}) {
  const { w } = g;
  const xy = (i) => [i % w, (i / w) | 0];
  let c0 = null, k0 = -1;
  for (const c of g.chains) { if (c.removed) continue; const k = c.px.indexOf(start); if (k >= 0) { c0 = c; k0 = k; break; } }
  if (!c0) return { px: [start], gaps: [], closed: false, ends: ['end', 'end'] };
  const used = new Set([c0.id]);
  const K = Math.max(3, Math.round(span * width));
  const gaps = [];
  const dirOf = (px) => { const a = xy(px[0]), b = xy(px[Math.min(px.length - 1, K)]); return [b[0] - a[0], b[1] - a[1]]; };

  // The direction a run of pixels runs (least squares, from its first towards its last).
  function runDir(px) {
    let mx = 0, my = 0;
    for (const p of px) { const [x, y] = xy(p); mx += x; my += y; }
    mx /= px.length; my /= px.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of px) { const [x, y] = xy(p), dx = x - mx, dy = y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), u = [Math.cos(th), Math.sin(th)], a = xy(px[0]), b = xy(px.at(-1));
    return u[0] * (b[0] - a[0]) + u[1] * (b[1] - a[1]) < 0 ? [-u[0], -u[1]] : u;
  }

  // A way on from a node, `need` pixels long if it can be: the chain, and on from its far end along the chain
  // that turns least (thinning can leave a fork as two junctions a few pixels apart).
  function onward(o, need) {
    const run = [...o.px], seen = new Set([o.c.id]);
    while (run.length <= need) {
      const end = g.nodeOf.get(run.at(-1));
      if (end === undefined) break;
      const a = xy(run[Math.max(0, run.length - 1 - K)]), b = xy(run.at(-1)), d = [b[0] - a[0], b[1] - a[1]];
      let best = null, bt = Infinity;
      for (const id of live(g, end)) {
        if (seen.has(id)) continue;
        const c = g.chains[id], px = g.nodeOf.get(c.px[0]) === end ? c.px : [...c.px].reverse(), t = angle(d, dirOf(px));
        if (t < bt) { bt = t; best = { id, px }; }
      }
      if (!best) break;
      seen.add(best.id); run.push(...best.px.slice(1));
    }
    return run;
  }

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
        // A narrow fork: the ways on judged again over the longer baseline (from a point FORK_SPAN widths back,
        // the way the line ran there, to a point twice that far on along each way).
        let narrow = null;
        if (options.length >= 2) {
          const Lb = Math.max(4, Math.round(forkSpan * width)), n = path.length;
          const back = (k) => (n - 1 - k >= 0 ? path[n - 1 - k] : behind[behind.length + (n - 1 - k)] ?? behind[0] ?? path[0]);
          const P = xy(back(Lb)), P2 = xy(back(2 * Lb)), din = [P[0] - P2[0], P[1] - P2[1]];
          const nd = g.nodes[node];
          if (din[0] || din[1]) {
            for (const o of options) {
              // o.dir, the way's own direction: the line fitted to its pixels from Lb on along it to 2Lb on, clear of the
              // junction (thinning sets the node back towards the stem, so that the node's directions to the two ways are
              // wider apart than the ways are, by 3° at 28°).
              const run = onward(o, 2 * Lb), Q = xy(run[Math.min(run.length - 1, 2 * Lb)]);
              o.long = angle(din, [Q[0] - P[0], Q[1] - P[1]]);
              o.dir = run.length > Lb + 2 ? runDir(run.slice(Lb, 2 * Lb + 1)) : [Q[0] - nd.x, Q[1] - nd.y];
            }
            const byLong = [...options].sort((p, q) => p.long - q.long), [o1, o2] = byLong;
            const split = angle(o1.dir, o2.dir);
            if (split < FORK_SPLIT) {
              narrow = { split };
              if (Math.abs(o1.long - o2.long) < FORK_AMBIGUOUS * split && Math.abs(o1.dw - o2.dw) < 0.5) {
                // Stopped where the two lines part: the pixels of their joined ink (see below) let go.
                const rb2 = (width / Math.sin((Math.max(5, split) * Math.PI) / 180) + width) ** 2;
                while (path.length > behindLen + 1 && (xy(path.at(-1))[0] - nd.x) ** 2 + (xy(path.at(-1))[1] - nd.y) ** 2 <= rb2) path.pop();
                return 'fork';
              }
              options = byLong;
            }
          }
        }
        // A node with one way on and one way in (a spur pruned, a ring's own node) is passed, whatever its turn.
        const through = live(g, node).length === 2 && options.length === 1;
        if (options.length && (through || options[0].turn <= maxTurn || narrow)) next = options[0];
        if (next && narrow) next.narrow = narrow;
      }
      if (next) {
        used.add(next.c.id);
        // Through a junction, the pixels within a width of it are let go on both sides: thinning bends a
        // line towards the line crossing it, and the line is taken to run straight across.
        let head = 1;
        if (live(g, node).length >= 3) {
          const n = g.nodes[node], r2 = (Math.max(1.5, width)) ** 2;
          // At a narrow fork the lines' ink is joined (and the skeleton bent) from where they part, a width over the
          // sine of the angle between them back from the junction: the pixels within that (and a width) are let go
          // behind, and within two widths on.
          const rb2 = next.narrow ? (width / Math.sin((Math.max(5, next.narrow.split) * Math.PI) / 180) + width) ** 2 : r2;
          const ra2 = next.narrow ? (2 * width) ** 2 : r2;
          const near = (i, rr) => { const [x, y] = xy(i); return (x - n.x) ** 2 + (y - n.y) ** 2 <= rr; };
          while (path.length > 2 && near(path.at(-1), rb2) && path.length > behindLen + 1) path.pop();
          while (head < next.px.length - 1 && near(next.px[head], ra2)) head++;
        }
        if (take(next.px.slice(head))) return 'edge';
        continue;
      }
      const why = options.length ? 'turn' : node !== undefined && live(g, node).length > 1 ? 'used' : 'end';
      // A jump is for a break in the ink: not where the line meets ink that turns too far (a T, a line ending on a road
      // across it), whose own pixels a jump would find a pixel or two ahead and run along.
      if (!jumps || why === 'turn') return why;
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
