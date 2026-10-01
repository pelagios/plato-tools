// What Chora shows of one place: its record, read into the view the place card and the map draw
// from (see the worker protocol, chora-place). Pure: whatever depends on the rest of the dataset
// (what it withdraws, the places related to this one, the extent of a country) comes in `ctx`.
//
// Each attestation is shown with its status: 'denied' when the source says it is not so
// (plato:negated), else the source's own stance (plato:source_stance: reported, tentative, doubted),
// else 'asserted'. What a later attestation retracts or supersedes is not the current state: it is
// left out, and counted, so the card can say that it was there.
import { PLATO } from '../../lib/context.js';
import { isDenial, collectWithdrawn, resolveWithdrawn } from '../../formats/shared.js';
import { bboxOf, unionBbox, reprPointOf, drawable } from './geo.js';

const full = (iri) => (typeof iri === 'string' && iri.startsWith('plato:') ? PLATO + iri.slice(6) : iri);
// What an attestation's timespans date (plato:timespan_role, PLATO #20). EvidenceSpan: the span of the
// texts that mention the place, not when anything held, so a timeline entry says so (`evidence`) and
// it is never a location's own date. WhenTrue is the default. A role PLATO does not define is shown as
// WhenTrue is, the ordinary date of the claim: that is how a consumer that does not know the term
// would read it, and it is the only reading Chora could give it.
const isEvidence = (a) => full(a.timespanRole) === PLATO + 'EvidenceSpan';
const STANCES = { [PLATO + 'StanceReported']: 'reported', [PLATO + 'StanceTentative']: 'tentative', [PLATO + 'StanceDoubted']: 'doubted' };
/** 'denied' | 'doubted' | 'reported' | 'tentative' | 'asserted'. A denial outranks any stance. */
export function statusOf(a) {
  if (isDenial(a)) return 'denied';
  return STANCES[full(a.sourceStance)] || 'asserted';
}
/**
 * The last segment of an address, for a label where nothing better is given: plato#ContainedIn ->
 * ContainedIn. Decoded where it can be (St%20Ives -> St Ives); a stray % is shown as it is written.
 */
export function tail(iri) {
  if (typeof iri !== 'string') return '';
  const t = iri.replace(/[#/]+$/, '').split(/[#/]/).pop() || iri;
  try { return decodeURIComponent(t); } catch { return t; }
}

/** A source as the card lists it: its address, its title where the record gives one, and a locator. */
function sourceRef(s, locator) {
  if (!s) return null;
  const o = typeof s === 'string' ? { id: s, title: null } : { id: s['@id'] || null, title: s.title || null };
  if (locator) o.locator = locator;
  return o.id || o.title ? o : null;
}
function sourcesOf(a) {
  const out = [];
  for (const s of a.sources || []) { const r = sourceRef(s); if (r) out.push(r); }
  for (const c of a.citations || []) { const r = c && sourceRef(c.source, c.locator); if (r) out.push(r); }
  return out;
}
const span = (t) => (t && typeof t === 'object' ? {
  start: t.startEarliest ?? t.startLatest ?? null,
  end: t.endLatest ?? t.endEarliest ?? null,
  label: t.label ?? t.sourceLabel ?? t.edtfString ?? null,
} : null);

// What an attestation is chiefly about, for its line on the timeline: its first facet, in this order.
function facetOf(a) {
  if (a.names?.length) return ['name', a.names.map((n) => n && n.toponym).filter(Boolean).join(' / ')];
  if (a.geometries?.length) return ['geometry', a.geometries.map((g) => g?.geojson?.type || (g?.reprPoint ? 'Point' : g?.wkt ? 'WKT' : '')).filter(Boolean).join(', ') || 'location'];
  if (a.types?.length) return ['type', a.types.map((t) => t && (t.label || tail(t.identifier))).filter(Boolean).join(', ')];
  if (a.relations?.length) { const r = a.relations[0] || {}; return ['relation', `${tail(r.relationType)} ${r.relatedLabel || tail(r.relatesTo)}`.trim()]; }
  if (a.properties?.length) return ['property', a.properties.map((p) => p && (p.label || tail(p.property) || tail(p.type))).filter(Boolean).join(', ') || 'property'];
  if (a.identities?.length) return ['identity', a.identities.map((i) => i && tail(i.object)).filter(Boolean).join(', ')];
  return ['other', a.notes || ''];
}

/**
 * The view of one place record. `ctx`:
 * - withdrawn: attestation @id -> 'retracted' | 'superseded', for the WHOLE dataset (a retraction
 *   may sit under another place); without it, only this record's own withdrawals are seen;
 * - lookup(id): { id, label, reprPoint, bbox } of another place in the dataset, or null;
 * - ccodeBbox(code): [w, s, e, n] of a country, by its ISO 3166-1 alpha-2 code, or null.
 * The fallback says where the map should look: the place's own current geometries; else the places
 * it is related to; else its countries; else nowhere ('none').
 */
// An uncertainty radius, the first of a location's: a finite number, or nothing. A dataset the schema
// refuses still opens, so anything else (text, markup) is dropped here, not shown.
const km = (v) => { const x = Array.isArray(v) ? v[0] : undefined; return typeof x === 'number' && Number.isFinite(x) ? x : null; };
// A location's precision (the first of its list) and role: text, or nothing, for the same reason.
const word = (v) => { const x = Array.isArray(v) ? v[0] : undefined; return typeof x === 'string' ? x : null; };
const text = (v) => (typeof v === 'string' ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// The relative qualifiers PLATO defines (plato:RelativeQualifierScheme), in words. DuringReignOf and
// VariantOf qualify a timespan and a name, not a location, and are worded only in case one is used.
const QUALIFIERS = { Near: 'near', Within: 'within', Beyond: 'beyond', UpstreamOf: 'upstream of', BetweenXAndY: 'between', DuringReignOf: 'during the reign of', VariantOf: 'a variant of' };
const qualifierWords = (q) => {
  const f = full(q);
  if (typeof f !== 'string' || !f) return 'relative to';
  return f.startsWith(PLATO) && QUALIFIERS[f.slice(PLATO.length)] ? QUALIFIERS[f.slice(PLATO.length)] : tail(f);
};
export function viewPlace(record, ctx = {}) {
  const rec = record || {};
  const atts = Array.isArray(rec.attestations) ? rec.attestations : [];
  const withdrawn = ctx.withdrawn || resolveWithdrawn(collectWithdrawn(atts)).status;
  const lookup = ctx.lookup || (() => null);
  const view = {
    id: rec['@id'] ?? null, label: rec.label ?? rec['@id'] ?? '', ccodes: Array.isArray(rec.ccodes) ? rec.ccodes : [],
    names: [], geometries: [], relative: [], types: [], relations: [], timeline: [], sources: [], withdrawn: 0, fallback: null,
  };
  const seenSources = new Set();
  const related = new Map();
  const place = (x) => { if (!related.has(x)) related.set(x, lookup(x) || null); return related.get(x); };
  for (const [i, a] of atts.entries()) {
    if (!a || typeof a !== 'object') continue;
    if (typeof a['@id'] === 'string' && withdrawn.get(a['@id'])) { view.withdrawn++; continue; }
    const status = statusOf(a), srcs = sourcesOf(a), attestationId = a['@id'] ?? null, created = a.created ?? null;
    const evidence = isEvidence(a);
    const timespan = evidence ? null : span((a.timespans || [])[0]);
    for (const s of srcs) { const k = s.id || s.title; if (!seenSources.has(k)) { seenSources.add(k); view.sources.push({ id: s.id, title: s.title }); } }
    for (const n of a.names || []) if (n && n.toponym) view.names.push({ toponym: n.toponym, language: n.language ?? null, romanized: n.romanized ?? null, status, attestationIndex: i });
    for (const g of a.geometries || []) {
      const geojson = drawable(g);
      // A location given only relative to other places (PLATO #19: "between Assuan and Philai"): kept in
      // words, with its anchors (one, or a list), never drawn and never used to place the place.
      const q = g && typeof g === 'object' && g.qualification && typeof g.qualification === 'object' ? g.qualification : null;
      if (!geojson && q && (q.relativeQualifier !== undefined || q.relativeTo !== undefined)) {
        const anchors = [].concat(q.relativeTo ?? []).filter((x) => typeof x === 'string' && x).map((x) => {
          const other = place(x);
          return other ? { id: other.id, label: other.label || tail(x), place: true } : { id: x, label: tail(x), place: false };
        });
        view.relative.push({
          qualifier: text(q.relativeQualifier), qualifierLabel: qualifierWords(q.relativeQualifier), anchors,
          distance: num(q.relativeDistance), bearing: num(q.relativeBearing), sourceLabel: text(g.sourceLabel),
          status, attestationId, attestationIndex: i, sources: srcs, timespan,
        });
        continue;
      }
      if (!geojson) continue;
      view.geometries.push({
        geojson, role: text(g.role), precision: word(g.spatialPrecision), precisionKm: km(g.precisionKm),
        status, attestationId, attestationIndex: i, sources: srcs, created, timespan,
      });
    }
    for (const t of a.types || []) if (t) view.types.push({ label: t.label ?? tail(t.identifier), identifier: t.identifier ?? null, status, attestationIndex: i });
    for (const r of a.relations || []) {
      if (!r) continue;
      // A target named only (relatedLabel, no relatesTo; PLATO #18: "in the Delta"): shown by its name,
      // looked up nowhere, related to no place, so it neither links nor places anything on the map.
      if (typeof r.relatesTo !== 'string') {
        if (typeof r.relatedLabel === 'string' && r.relatedLabel) {
          view.relations.push({ type: r.relationType ?? null, typeLabel: tail(r.relationType), relatesTo: null, label: r.relatedLabel, related: null, status, attestationIndex: i });
        }
        continue;
      }
      const other = place(r.relatesTo);
      view.relations.push({
        type: r.relationType ?? null, typeLabel: tail(r.relationType), relatesTo: r.relatesTo,
        label: r.relatedLabel ?? other?.label ?? r.relationLabel ?? tail(r.relatesTo),
        related: other ? { id: other.id, label: other.label, geometry: other.reprPoint ?? null, bbox: other.bbox ?? null } : null,
        status, attestationIndex: i,
      });
    }
    for (const t of a.timespans || []) {
      const s = span(t);
      if (s.start === null && s.end === null && s.label === null) continue;
      // An attestation window (PLATO #20) is an attestation with only its timespan: about the evidence.
      let [facet, text] = facetOf(a);
      if (evidence && facet === 'other') [facet, text] = ['evidence', ''];
      view.timeline.push({ facet, text, start: s.start, end: s.end, label: s.label, status, evidence, attestationIndex: i });
    }
  }
  // Where to look. A denied location is where the place is NOT, so it never places it.
  const own = unionBbox(view.geometries.filter((g) => g.status !== 'denied').map((g) => bboxOf(g.geojson)));
  const near = unionBbox(view.relations.filter((r) => r.status !== 'denied' && r.related).map((r) => r.related.bbox || (r.related.geometry ? [...r.related.geometry, ...r.related.geometry] : null)));
  const countries = unionBbox(view.ccodes.map((c) => (ctx.ccodeBbox ? ctx.ccodeBbox(c) : null)));
  view.fallback = own ? { kind: 'geometry', bbox: own } : near ? { kind: 'related', bbox: near } : countries ? { kind: 'ccodes', bbox: countries } : { kind: 'none', bbox: null };
  return view;
}

/**
 * The current geometries of a record, for the index: each drawable geometry of an attestation that
 * is neither withdrawn nor denied, with its box and representative point.
 */
export function currentGeometries(record, withdrawn) {
  const out = [];
  for (const a of record?.attestations || []) {
    if (!a || typeof a !== 'object' || isDenial(a)) continue;
    if (typeof a['@id'] === 'string' && withdrawn && withdrawn.get(a['@id'])) continue;
    for (const g of a.geometries || []) {
      const geojson = drawable(g);
      if (!geojson) continue;
      const rp = Array.isArray(g.reprPoint) && g.reprPoint.length === 2 && g.reprPoint.every(Number.isFinite) ? g.reprPoint : reprPointOf(geojson);
      out.push({ attestationId: typeof a['@id'] === 'string' ? a['@id'] : null, bbox: bboxOf(geojson), reprPoint: rp });
    }
  }
  return out;
}
