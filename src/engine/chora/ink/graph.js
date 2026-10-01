// A skeleton (one pixel wide, thin.js) read as a graph: nodes where a pixel has other than two
// neighbours (an end, or a junction), and chains of pixels between them. Zhang–Suen leaves a crossing
// as a little cluster of junction pixels (a plus sign gives degree-3 pixels around its centre, not one
// degree-4 pixel), so node pixels within MERGE_PX of each other are one node.

export const MERGE_PX = 2;
const DX = [0, 1, 1, 1, 0, -1, -1, -1], DY = [-1, -1, 0, 1, 1, 1, 0, -1];

/**
 * The graph of skeleton `sk` (w × h): { w, h, nodes: [{ id, pixels, x, y, chains: [chainId] }],
 * chains: [{ id, a, b, px: [pixel index], removed }], nodeOf: Map(pixel index -> node id) }. A chain's
 * px runs from a pixel of node a to a pixel of node b. A ring with no node gets a node of its own.
 */
export function skeletonGraph(sk, w, h) {
  const set = (x, y) => x >= 0 && y >= 0 && x < w && y < h && sk[y * w + x] === 1;
  const deg = (i) => { const x = i % w, y = (i / w) | 0; let n = 0; for (let k = 0; k < 8; k++) if (set(x + DX[k], y + DY[k])) n++; return n; };
  const pixels = [];
  for (let i = 0; i < sk.length; i++) if (sk[i]) pixels.push(i);
  // Node pixels, joined into nodes when within MERGE_PX of each other.
  const nodePx = pixels.filter((i) => deg(i) !== 2);
  const parent = new Map(nodePx.map((i) => [i, i]));
  const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  const R = MERGE_PX;
  for (const i of nodePx) {
    const x = i % w, y = (i / w) | 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > R * R || (!dx && !dy)) continue;
      const j = (y + dy) * w + x + dx;
      if (set(x + dx, y + dy) && parent.has(j)) { const a = find(i), b = find(j); if (a !== b) parent.set(a, b); }
    }
  }
  const nodes = [], nodeOf = new Map(), byRoot = new Map();
  const newNode = (pxs) => { const n = { id: nodes.length, pixels: pxs, x: 0, y: 0, chains: [] }; for (const p of pxs) { n.x += p % w; n.y += (p / w) | 0; nodeOf.set(p, n.id); } n.x /= pxs.length; n.y /= pxs.length; nodes.push(n); return n; };
  for (const i of nodePx) { const r = find(i); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(i); }
  for (const pxs of byRoot.values()) newNode(pxs);
  // Chains: from each node pixel along each neighbour that is not a node pixel, to the next node pixel.
  const chains = [], seen = new Uint8Array(sk.length);
  const neighbours = (i) => { const x = i % w, y = (i / w) | 0, out = []; for (let k = 0; k < 8; k++) if (set(x + DX[k], y + DY[k])) out.push((y + DY[k]) * w + x + DX[k]); return out; };
  const walk = (start, first) => {
    const px = [start, first]; let prev = start, cur = first;
    while (!nodeOf.has(cur)) {
      seen[cur] = 1;
      const next = neighbours(cur).filter((j) => j !== prev && !(seen[j] && !nodeOf.has(j)));
      if (!next.length) break;
      // Prefer a node pixel when one is next (the chain ends there).
      const n = next.find((j) => nodeOf.has(j)) ?? next[0];
      px.push(n); prev = cur; cur = n;
    }
    return px;
  };
  const addChain = (px) => {
    const a = nodeOf.get(px[0]), b = nodeOf.get(px[px.length - 1]);
    if (a === undefined || b === undefined) return;
    // A step around the pixels of one node is not a chain.
    if (a === b && px.length <= 2 * R + 2) return;
    const c = { id: chains.length, a, b, px, removed: false };
    chains.push(c); nodes[a].chains.push(c.id); nodes[b].chains.push(c.id);
  };
  for (const i of nodePx) {
    for (const j of neighbours(i)) {
      if (nodeOf.has(j) || seen[j]) continue;
      addChain(walk(i, j));
    }
  }
  // Rings with no node: a node of one pixel, and the ring from it back to it.
  for (const i of pixels) {
    if (seen[i] || nodeOf.has(i)) continue;
    seen[i] = 1;
    const [j] = neighbours(i);
    if (j === undefined) continue;
    const px = walk(i, j);
    const n = newNode([i]);
    if (px[px.length - 1] !== i) px.push(i);
    const c = { id: chains.length, a: n.id, b: n.id, px, removed: false };
    chains.push(c); n.chains.push(c.id, c.id);
  }
  return { w, h, nodes, chains, nodeOf };
}

/** The chains still in the graph at a node. */
export const live = (g, node) => g.nodes[node].chains.filter((c) => !g.chains[c].removed);

/**
 * Spurs pruned: a chain from an end (a node of degree 1) to a junction, shorter than `minLength`
 * pixels, is removed (a burr of the thinning, or a serif), unless it holds pixel `keep`. Repeated
 * until none is left. Of the spurs at one junction, the one that turns most from the chains through
 * it goes first: where a burr leaves a line near its end, the line's own last few pixels are a spur
 * too, and are kept (the junction, down to two chains, is then passed through). Each node a spur was
 * pruned from is listed in `g.pruned` (where thinning bent the line towards the burr).
 */
export function pruneSpurs(g, minLength, keep = -1) {
  const { w } = g, span = Math.max(3, Math.round(minLength / 2));
  // A chain's way out of a node, over `span` pixels of it.
  const out = (c, node) => {
    const px = g.nodeOf.get(c.px[0]) === node ? c.px : [...c.px].reverse(), b = px[Math.min(px.length - 1, span)];
    const n = g.nodes[node];
    return [(b % w) - n.x, ((b / w) | 0) - n.y];
  };
  const cos = (u, v) => { const n = Math.hypot(...u) * Math.hypot(...v); return n ? (u[0] * v[0] + u[1] * v[1]) / n : 1; };
  g.pruned = g.pruned || [];
  let pruned = 0;
  for (;;) {
    let worst = null, wc = Infinity;
    for (const c of g.chains) {
      if (c.removed || c.a === c.b || c.px.length >= minLength || c.px.includes(keep)) continue;
      const da = live(g, c.a).length, db = live(g, c.b).length;
      const node = da === 1 && db >= 3 ? c.b : db === 1 && da >= 3 ? c.a : -1;
      if (node < 0) continue;
      // How straight on from another chain at the junction this spur runs: the best of cos(its way out, the way
      // into the junction along the other); the spur running least straight on is pruned first.
      const v = out(c, node);
      let straight = -1;
      for (const id of live(g, node)) if (id !== c.id) { const u = out(g.chains[id], node); straight = Math.max(straight, -cos(u, v)); }
      if (straight < wc) { wc = straight; worst = { c, node }; }
    }
    if (!worst) break;
    worst.c.removed = true; pruned++;
    if (!g.pruned.includes(worst.node)) g.pruned.push(worst.node);
  }
  return pruned;
}
