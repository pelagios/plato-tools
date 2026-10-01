// What Chora's place card writes, from the view of a place (src/engine/chora/view.js): pure, so that
// it can be tested without a page. The card itself (renderCard in app.js) puts these together.

// Colours of the statuses on the map (map.js), the same as the light theme's in styles.css (--status-…),
// which the card uses, so that the card follows the colour theme.
export const STATUS_COLOURS = { asserted: '#2757dd', reported: '#7a4fc9', tentative: '#b7791f', doubted: '#6b7280', denied: '#c0392b' };
export const STATUS_WORDS = { denied: 'denied', doubted: 'doubted', reported: 'reported', tentative: 'tentative' };
const STATUS_TITLES = {
  denied: 'The source says this is NOT so.', doubted: 'The source reports this, and doubts it.',
  reported: 'The source reports this as said by others.', tentative: 'The source gives this tentatively.',
};
export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
export const badge = (s) => (STATUS_WORDS[s] ? ` <span class="status status-${s}" data-tip="${esc(STATUS_TITLES[s])}">${s}</span>` : '');
export const tailOf = (iri) => (iri ? String(iri).split(/[#/]/).pop() : '');
const trim = (s, k) => (s.length > k ? s.slice(0, k - 1) + '…' : s);

export const ROLE_WORDS = { Extent: 'the whole place', FeaturePoint: 'a feature of it', RepresentativePoint: 'a point standing for it', LabelAnchor: 'where its label goes', Itinerary: 'a route' };
const dated = (t) => (t?.label || t?.start ? ` <span class="muted">${esc(t.label || `${t.start ?? ''}–${t.end ?? ''}`)}</span>` : '');
/** One location drawn on the map: its kind, what it marks, how well it is known, and its date. */
export const geometryItem = (g) => `${esc(g.geojson.type)}${g.role ? `, ${esc(ROLE_WORDS[tailOf(g.role)] || tailOf(g.role))}` : ''}${g.precision ? `, ${esc(g.precision.replace('_', ' '))}` : ''}${g.precisionKm != null ? ` (±${esc(g.precisionKm)} km)` : ''}${dated(g.timespan)}${badge(g.status)}`;

const anchorLink = (a) => (a.place ? `<a href="#" data-place="${esc(a.id)}">${esc(a.label)}</a>` : esc(a.label));
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const metres = (m) => (m >= 1000 ? `${+(m / 1000).toFixed(1)} km` : `${+m.toFixed(0)} m`);
/**
 * A location given only relative to other places (PLATO #19), in words: "between Assuan and Philai
 * (relative; not drawn)". An anchor that is a place of the dataset is a link to it; any other is its
 * address's last segment, as text. Never drawn.
 */
export function relativeItem(r) {
  const notes = [];
  if (r.distance != null) notes.push(`${metres(r.distance)} away`);
  if (r.bearing != null) notes.push(`bearing ${+r.bearing.toFixed(1)}°`);
  notes.push('relative; not drawn');
  const anchors = andList((r.anchors || []).map(anchorLink));
  return `${esc(r.qualifierLabel)}${anchors ? ` ${anchors}` : ''} <span class="muted">(${notes.join('; ')})</span>${dated(r.timespan)}${badge(r.status)}`;
}
/** The card's Locations: those drawn, then those given only relative to other places. */
export function locations(v) {
  const items = [...(v.geometries || []).map(geometryItem), ...(v.relative || []).map(relativeItem)];
  return items.length ? `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>` : '<p class="muted">None recorded.</p>';
}

/**
 * One related place: a link to it when it is a place of the dataset; otherwise its name as text. A
 * relation that names its target only (relatedLabel with no relatesTo, PLATO #18: "in the Delta") has
 * nothing to go to, so it is never a link.
 */
export const relationItem = (r) => `${esc(r.typeLabel || tailOf(r.type))}: ${r.related ? `<a href="#" data-place="${esc(r.related.id)}">${esc(r.label)}</a>` : esc(r.label)}${badge(r.status)}`;

// An evidence span (PLATO #20, timespanRole EvidenceSpan) dates the texts that mention the place, not
// what they say of it: it is written as a mention, and drawn hatched, never as a claim's solid bar.
const MENTIONED = 'mentioned in texts dated';
// A hatched bar's fill and outline, in a style attribute: the stylesheet's rules for .tl-… would
// override a fill attribute, and its token follows the colour theme.
const hatch = (s) => `fill: url(#tl-hatch-${s}); stroke: var(--status-${s})`;

/**
 * The timeline: one row per dated attestation, a bar from its start to its end, in its status's
 * colour; an evidence span hatched, with a legend saying so when there is one. Years only; a date that
 * is not a year is read for its year.
 */
export function timeline(items) {
  const year = (x) => { const m = x == null ? null : String(x).match(/^(-?\d{1,6})/); return m ? Number(m[1]) : null; };
  const rows = items.map((t) => ({ ...t, a: year(t.start), b: year(t.end) })).filter((t) => t.a !== null || t.b !== null);
  const undated = items.length - rows.length;
  // Dates given only in words ("undated", "in the reign of Henry II"), each once, with how many.
  const words = () => {
    const c = new Map();
    for (const t of items) if ((year(t.start) ?? year(t.end)) === null && t.label) { const k = `${t.evidence ? `${MENTIONED} ` : ''}“${esc(t.label)}”`; c.set(k, (c.get(k) || 0) + 1); }
    return [...c].map(([w, k]) => `${w}${k > 1 ? ` (${k})` : ''}`).join(', ');
  };
  if (!rows.length) return `<p class="muted">${items.length ? `Dated only in words: ${words()}.` : 'No dates recorded.'}</p>`;
  let lo = Math.min(...rows.map((t) => t.a ?? t.b)), hi = Math.max(...rows.map((t) => t.b ?? t.a));
  if (hi === lo) { lo -= 10; hi += 10; }
  const W = 320, L = 4, R = 4, H = 26, x = (y) => L + ((y - lo) / (hi - lo)) * (W - L - R);
  // Each bar in its status's colour from the stylesheet (--status-…, svg.timeline .tl-…), so that it
  // follows the colour theme; a hatching, drawn here, takes the same token.
  const hatched = new Set();   // the statuses whose hatching is used
  const bars = rows.map((t, i) => {
    const a = t.a ?? t.b, b = t.b ?? t.a, y = i * H;
    const s = STATUS_COLOURS[t.status] ? t.status : 'asserted';
    const when = a === b ? `${a}` : `${a}–${b}`;
    const st = STATUS_WORDS[t.status] ? `, ${t.status}` : '';
    let tip, line, bar;
    if (t.evidence) {
      hatched.add(s);
      const what = t.text ? `${t.text}: ` : '';
      tip = `${what || 'M'}${what ? MENTIONED : MENTIONED.slice(1)} ${t.label || when}${st}`;
      line = `${esc(trim(what, 30))}${MENTIONED} ${esc(when)}${STATUS_WORDS[t.status] ? ` · ${t.status}` : ''}`;
      bar = `<rect x="${x(a)}" y="${y + 14}" width="${Math.max(3, x(b) - x(a))}" height="6" rx="2" class="tl-evidence" style="${hatch(s)}"/>`;
    } else {
      tip = `${t.text || t.facet} (${t.label || when})${st}`;
      line = `${esc(trim(`${t.text || t.facet}`, 44))} · ${esc(when)}${STATUS_WORDS[t.status] ? ` · ${t.status}` : ''}`;
      bar = `<rect x="${x(a)}" y="${y + 14}" width="${Math.max(3, x(b) - x(a))}" height="6" rx="2" class="tl-bar tl-${s}"${s !== 'asserted' ? ' fill-opacity=".45" stroke-dasharray="2 1"' : ''}/>`;
    }
    // Its whole text, shown on hover by src/lib/tooltip.js (the row's own text may be cut short).
    return `<g data-tip="${esc(tip)}">
      <text x="${L}" y="${y + 10}" class="tl-text">${line}</text>
      ${bar}</g>`;
  }).join('');
  const defs = hatched.size ? `<defs>${[...hatched].map((k) => `<pattern id="tl-hatch-${k}" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke-width="1.5" style="stroke: var(--status-${k})"/></pattern>`).join('')}</defs>` : '';
  const axisY = rows.length * H + 14, h = axisY + (hatched.size ? 16 : 2);
  const [k0] = hatched;
  const legend = hatched.size ? `<g class="tl-legend"><rect x="${L}" y="${axisY + 6}" width="14" height="6" rx="2" style="${hatch(k0)}"/>
    <text x="${L + 18}" y="${axisY + 12}" class="tl-axis">hatched: when texts mention the place, not when what they say was so</text></g>` : '';
  return `<svg class="timeline" viewBox="0 0 ${W} ${h}" role="img" aria-label="When each attestation applies, from ${lo} to ${hi}${hatched.size ? '; hatched bars are when texts mention the place' : ''}">${defs}${bars}
    <text x="${L}" y="${axisY}" class="tl-axis">${lo}</text><text x="${W - R}" y="${axisY}" class="tl-axis" text-anchor="end">${hi}</text>${legend}</svg>`
    + (undated ? `<p class="muted">Also dated only in words: ${words()}.</p>` : '');
}
