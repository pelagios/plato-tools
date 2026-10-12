// Scope (Issue #33, points 2 and 8; Stephen's decisions of 12 October 2026): what every WHG lookup of a
// workflow is confined to, as WHG's own Map your Data has it. Pure: nothing here sends anything, reads
// storage or knows the page. lookup.js puts what scopeFields() gives into each query; the workflow's record
// keeps the Scope (src/methodos/page.js), and the page edits it (src/scope-page.js).
//
// A Scope is
//   { where: { mode: 'anywhere' }
//          | { mode: 'countries', countries: ['GB', …] }                      sent as countries
//          | { mode: 'place', place: { id: 'gn:2635167', label, description? } }   sent as contained_in: [id]
//          | { mode: 'area', area: <GeoJSON Polygon> },                        sent as bounds
//     types: [{ id: 'aat:…', label, narrower: ['aat:…', …], from: 'whg' | 'bundled' }],   sent as types
//     when: { start, end, undated },                                          sent as start, end, temporal
//     sources: ['gn', 'tgn', …] }                                             sent as namespaces
//
// What WHG said of these (its session, 12 October 2026):
// - Every one is a hard filter, applied after a window of about 200 candidates by name: a narrow Scope can
//   leave a place with nothing, which is said, row by row, and never relaxed by itself.
// - A scoped query with nothing in it is answered empty (fail-closed), with scope.applied (lookup.js).
// - A spatial filter turns WHG's legacy index off.
// - Ids are case-sensitive, and contained_in takes them bare ("gn:2635167"), never a full address.
// - Types are NOT matched hierarchically (the gateway's aat_paths are reported empty): a type matches only
//   places typed with exactly that concept. So each type chosen keeps its narrower ones (WHG's
//   /types/expand/, or the bundled expansion, scope-data.js), and all of them are sent.
// - With years given, WHG leaves out every place that has no dates. WHG is to add `undated: true` to keep
//   them; until it confirms, the choice is shown and cannot be ticked (UNDATED_TAKEN).
//
// Precedence. A lookup that already says where to look keeps it: a region's or a place's constraint from
// the region review (its contained_in, its area, its countries, from the table's region columns, county
// then parish), and the panel's own filters (the place's countries, near its point). For those lookups
// Scope's Where is not sent; its types, years and sources still are. A region review's regions take
// Scope's Where alone (a region is not one of the places the types, years and sources describe), and so
// only the widest regions, and any whose region above has no match, take it. "With no constraint"
// (relax 'all') sends no Where either.
import { whgPlaceId } from '../gazetteer/whg.js';

/** The one switch for WHG's `undated: true` (its session, 12 October 2026): false until WHG confirms it takes it. */
export const UNDATED_TAKEN = false;
export const WHERE_MODES = ['anywhere', 'countries', 'place', 'area'];
/** The keys of a query that already say where to look: a lookup sending one of them takes no Where from Scope. */
export const WHERE_KEYS = ['countries', 'contained_in', 'lat', 'lng', 'radius', 'bounds'];
/** The years WHG's sources span (GET /api/sources/: PeriodO's earliest aside), and what a Scope may give. */
export const YEAR_RANGE = [-10000, 3000];
/** The most points an area drawn may have. */
export const MAX_AREA_POINTS = 1000;

const AAT = /^aat:\d+$/;
const NAMESPACE = /^[a-z][a-z0-9_]*$/;
const CCODE = /^[A-Z]{2}$/;
const BARE = /^[A-Za-z][\w-]*:[^\s/?#]+$/;

/** A Scope that confines nothing. */
export const emptyScope = () => ({ where: { mode: 'anywhere' }, types: [], when: { start: null, end: null, undated: false }, sources: [] });

const year = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= YEAR_RANGE[0] && v <= YEAR_RANGE[1] ? v : null);
const str = (v, max = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const r6 = (x) => Math.round(x * 1e6) / 1e6;

/**
 * A WHG place's id as contained_in takes it: bare ("gn:2635167"), from a candidate id ("place:gn:2635167"),
 * a bare id, or one of its addresses. Case is kept (WHG's ids are case-sensitive). Null for anything else.
 */
export function containerId(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (/^https?:\/\//i.test(t)) return whgPlaceId(t);
  const bare = t.replace(/^place:/, '');
  return BARE.test(bare) ? bare : null;
}

/** A GeoJSON Polygon of one closed ring, its points rounded to six places, or null if it is not one. */
export function areaPolygon(g) {
  const ring = g && g.type === 'Polygon' && Array.isArray(g.coordinates) ? g.coordinates[0] : null;
  if (!Array.isArray(ring) || ring.length < 4 || ring.length > MAX_AREA_POINTS + 1) return null;
  const pts = [];
  for (const p of ring) {
    if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number' || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) return null;
    pts.push([r6(p[0]), r6(p[1])]);
  }
  const [a, z] = [pts[0], pts[pts.length - 1]];
  if (a[0] !== z[0] || a[1] !== z[1]) pts.push([...a]);
  if (new Set(pts.slice(0, -1).map((p) => p.join(','))).size < 3) return null;
  return { type: 'Polygon', coordinates: [pts] };
}

/**
 * A Scope made safe to use, from anything (a record, storage, the page): each part checked and kept only
 * if it is what it says, everything else dropped. What is read from storage is never trusted to act as it
 * stands (DEVELOPERS.md, "The shared origin"), so every Scope used is one of these.
 */
export function normaliseScope(x) {
  const out = emptyScope();
  if (!x || typeof x !== 'object') return out;
  const w = x.where && typeof x.where === 'object' ? x.where : {};
  if (w.mode === 'countries') {
    const cs = [...new Set((Array.isArray(w.countries) ? w.countries : []).filter((c) => typeof c === 'string').map((c) => c.trim().toUpperCase()).filter((c) => CCODE.test(c)))].sort();
    if (cs.length) out.where = { mode: 'countries', countries: cs };
  } else if (w.mode === 'place' && w.place && typeof w.place === 'object') {
    const id = containerId(w.place.id);
    if (id) out.where = { mode: 'place', place: { id, label: str(w.place.label) || id, ...(str(w.place.description) ? { description: str(w.place.description) } : {}) } };
  } else if (w.mode === 'area') {
    const area = areaPolygon(w.area);
    if (area) out.where = { mode: 'area', area };
  }
  const seen = new Set();
  for (const t of Array.isArray(x.types) ? x.types : []) {
    if (!t || typeof t.id !== 'string' || !AAT.test(t.id) || seen.has(t.id)) continue;
    seen.add(t.id);
    const narrower = [...new Set((Array.isArray(t.narrower) ? t.narrower : []).filter((n) => typeof n === 'string' && AAT.test(n) && n !== t.id))].sort();
    out.types.push({ id: t.id, label: str(t.label) || t.id, narrower, from: t.from === 'whg' ? 'whg' : 'bundled' });
  }
  const when = x.when && typeof x.when === 'object' ? x.when : {};
  out.when = { start: year(when.start), end: year(when.end), undated: when.undated === true };
  out.sources = [...new Set((Array.isArray(x.sources) ? x.sources : []).filter((s) => typeof s === 'string').map((s) => s.trim().toLowerCase()).filter((s) => NAMESPACE.test(s)))].sort();
  return out;
}

/** Does the Scope confine nothing at all? */
export function isEmptyScope(scope) {
  const s = normaliseScope(scope);
  return s.where.mode === 'anywhere' && !s.types.length && s.when.start === null && s.when.end === null && !s.sources.length;
}

/** Why the years cannot be sent as they are, or null: a start after the end. */
export const yearsProblem = (scope) => {
  const { start, end } = normaliseScope(scope).when;
  return start !== null && end !== null && start > end ? 'start-after-end' : null;
};

/** Every type a Scope's types stand for: each chosen with its narrower ones, sorted, once each. */
export function typeIds(scope) {
  const out = new Set();
  for (const t of normaliseScope(scope).types) { out.add(t.id); for (const n of t.narrower) out.add(n); }
  return [...out].sort();
}

/** The request fields of the Scope's Where alone, or {} for anywhere. */
export function whereFields(scope) {
  const w = normaliseScope(scope).where;
  if (w.mode === 'countries') return { countries: [...w.countries] };
  if (w.mode === 'place') return { contained_in: [w.place.id] };
  if (w.mode === 'area') return { bounds: structuredClone(w.area) };
  return {};
}

/**
 * What a lookup sends of a Scope: { params, parts, yielded }. `params` are the query's keys (countries,
 * contained_in or bounds; types; start, end and temporal, and undated once WHG takes it; namespaces);
 * `parts` the parts of the Scope sent ('where', 'what', 'when', 'sources'); `yielded` true when the Scope
 * has a Where that was not sent because the lookup already says where to look. options: `region` (a region
 * of a region review: its Where alone), `own` (the query's own keys: its filters, or its constraint),
 * `relaxed` (its constraint's relaxation: 'all' sends no Where).
 */
export function scopeFields(scope, { region = false, own = null, relaxed = null } = {}) {
  const s = normaliseScope(scope), params = {}, parts = [];
  const where = whereFields(s);
  const hasWhere = Object.keys(where).length > 0;
  const placed = !!own && WHERE_KEYS.some((k) => own[k] !== undefined && own[k] !== null);
  let yielded = false;
  if (hasWhere) {
    if (placed || relaxed === 'all') yielded = true;
    else { Object.assign(params, where); parts.push('where'); }
  }
  if (region) return { params, parts, yielded };
  const types = typeIds(s);
  if (types.length) { params.types = types; parts.push('what'); }
  if (!yearsProblem(s) && (s.when.start !== null || s.when.end !== null)) {
    if (s.when.start !== null) params.start = s.when.start;
    if (s.when.end !== null) params.end = s.when.end;
    params.temporal = true;
    if (UNDATED_TAKEN && s.when.undated) params.undated = true;
    parts.push('when');
  }
  if (s.sources.length) { params.namespaces = [...s.sources]; parts.push('sources'); }
  return { params, parts, yielded };
}

/** Whether places with no dates are left out: years are given, and WHG cannot yet be asked to keep them. */
export function excludesUndated(scope) {
  const s = normaliseScope(scope);
  return (s.when.start !== null || s.when.end !== null) && !(UNDATED_TAKEN && s.when.undated);
}

/**
 * A type as Scope keeps it, from a node of WHG's tree ({ id, text }) or a shortlist entry, with its narrower
 * ones (from /types/expand/'s { ids }, which lists the type itself too, or the bundled expansion).
 */
export function scopeType({ id, label }, expandedIds = [], from = 'whg') {
  return normaliseScope({ types: [{ id, label, narrower: expandedIds, from }] }).types[0] ?? null;
}
