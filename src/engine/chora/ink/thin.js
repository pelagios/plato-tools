// Thinning a line's pixels to its centreline, one pixel wide: Zhang and Suen ("A fast parallel algorithm
// for thinning digital patterns", 1984), then the steps Zhang–Suen leaves on a diagonal taken out, so
// that every pixel of a plain stretch of line has exactly two neighbours (the graph is then simple to
// read: graph.js).

// The eight neighbours, clockwise from north: P2..P9 in Zhang and Suen's naming.
const DX = [0, 1, 1, 1, 0, -1, -1, -1], DY = [-1, -1, 0, 1, 1, 1, 0, -1];

/** The skeleton of `mask` (1 = ink), as a new mask of the same size. */
export function zhangSuen(mask, w, h) {
  const W = w + 2, H = h + 2, p = new Uint8Array(W * H);
  const fg = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { const i = (y + 1) * W + x + 1; p[i] = 1; fg.push(i); }
  const off = DX.map((dx, k) => DY[k] * W + dx);
  let live = fg, changed = true;
  const del = [], n = new Uint8Array(8);
  const read = (i) => { for (let k = 0; k < 8; k++) n[k] = p[i + off[k]]; };
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (const i of live) {
        if (!p[i]) continue;
        read(i);
        let B = 0, A = 0;
        for (let k = 0; k < 8; k++) { B += n[k]; if (!n[k] && n[(k + 1) & 7]) A++; }
        if (B < 2 || B > 6 || A !== 1) continue;
        // N·E·S and E·S·W (first step); N·E·W and N·S·W (second).
        if (step === 0 ? (n[0] && n[2] && n[4]) || (n[2] && n[4] && n[6]) : (n[0] && n[2] && n[6]) || (n[0] && n[4] && n[6])) continue;
        del.push(i);
      }
      for (const i of del) p[i] = 0;
      if (del.length) changed = true;
    }
    live = live.filter((i) => p[i]);
  }
  // The steps of a diagonal: a pixel with two set neighbours at right angles (north and east, say), the
  // other two of its four sides clear, and the diagonal between them clear, whose removal leaves its
  // neighbours connected. Taken out one at a time, so that no two are taken that are needed together.
  for (const i of live) {
    if (!p[i]) continue;
    read(i);
    const N = n[0], E = n[2], S = n[4], Wt = n[6];
    const corner = (N && E && !S && !Wt && !n[1]) || (E && S && !N && !Wt && !n[3]) || (S && Wt && !N && !E && !n[5]) || (Wt && N && !E && !S && !n[7]);
    if (corner && simple(n)) p[i] = 0;
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = p[(y + 1) * W + x + 1];
  return out;
}

/** Whether the set neighbours (n, clockwise from north) form one 8-connected group. */
function simple(n) {
  const parent = [0, 1, 2, 3, 4, 5, 6, 7];
  const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  const join = (a, b) => { if (n[a] && n[b]) parent[find(a)] = find(b); };
  for (let k = 0; k < 8; k++) join(k, (k + 1) & 7);
  join(0, 2); join(2, 4); join(4, 6); join(6, 0);
  const roots = new Set();
  for (let k = 0; k < 8; k++) if (n[k]) roots.add(find(k));
  return roots.size === 1;
}
