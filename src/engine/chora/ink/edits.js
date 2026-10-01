// What was done by hand to a proposed shape before it was saved, for its notes: the vertices moved, added
// and removed, of those proposed. The proposal's vertices and the saved shape's are aligned in order (the
// longest common sequence of vertices unchanged, to within `tol` degrees: Terra Draw keeps nine decimals);
// between two vertices kept, as many as both have are counted moved, and the rest added or removed.

const close = (a, b, tol) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
/** A geometry's vertices in order: a line's; a polygon's outer ring, without its closing vertex. */
export function verticesOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return geometry.coordinates;
  if (geometry.type === 'Polygon') { const r = geometry.coordinates[0] || []; return r.length > 1 && close(r[0], r.at(-1), 0) ? r.slice(0, -1) : r; }
  return [];
}

/** { moved, added, removed, proposed, unchanged } between the geometry proposed and the one saved. */
export function countEdits(proposed, saved, { tol = 1e-8 } = {}) {
  let P = verticesOf(proposed), S = verticesOf(saved);
  // A ring may come back starting elsewhere: turned to start at the vertex matching the proposal's first.
  if (proposed?.type === 'Polygon' && saved?.type === 'Polygon' && P.length && S.length) {
    const k = S.findIndex((v) => close(v, P[0], tol));
    if (k > 0) S = [...S.slice(k), ...S.slice(0, k)];
    else if (k < 0) { const r = [...S].reverse(); const j = r.findIndex((v) => close(v, P[0], tol)); if (j >= 0) S = [...r.slice(j), ...r.slice(0, j)]; }
  }
  const n = P.length, m = S.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = close(P[i], S[j], tol) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0, moved = 0, added = 0, removed = 0, gp = 0, gs = 0;
  const settle = () => { const mv = Math.min(gp, gs); moved += mv; removed += gp - mv; added += gs - mv; gp = gs = 0; };
  while (i < n || j < m) {
    if (i < n && j < m && close(P[i], S[j], tol)) { settle(); i++; j++; }
    else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) { gp++; i++; }
    else { gs++; j++; }
  }
  settle();
  return { moved, added, removed, proposed: n, unchanged: L[0][0] };
}
