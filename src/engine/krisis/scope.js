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
//     types: [{ id: 'aat:…', label, narrower: ['aat:…', …], from: 'whg' | 'cache' | 'bundled', at? }],   sent as types
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
// - With years given, WHG leaves out every place that has no dates, unless it is sent `undated: true`, which
//   it takes only beside `start` and/or `end` (live end to end on production, 12 October 2026: "Newport", gn,
//   1500 to 1600 gave 0 places without it and 100 with it). `temporal: true` is always sent with a year
//   window: WHG's legacy arm ignores the years without it.
//
// Precedence. A lookup that already says where to look keeps it: a region's or a place's constraint from
// the region review (its contained_in, its area, its countries, from the table's region columns, county
// then parish), and the panel's own filters (the place's countries, near its point). For those lookups
// Scope's Where is not sent; its types, years and sources still are. A region review's regions take
// Scope's Where alone (a region is not one of the places the types, years and sources describe), and so
// only the widest regions, and any whose region above has no match, take it. "With no constraint"
// (relax 'all') sends no Where either.
import { whgPlaceId } from '../gazetteer/whg.js';

/** The one switch for WHG's `undated: true`: on since WHG's gateway took it (12 October 2026, indexing a7f10bc). */
export const UNDATED_TAKEN = true;
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

/** A longitude brought into [-180, 180] (a map scrolled round the world gives 190 for -170). */
export const wrapLon = (x) => (x >= -180 && x <= 180 ? x : ((((x + 180) % 360) + 360) % 360) - 180);
/** Twice the signed area of a closed ring, in degrees: positive when it runs counter-clockwise. */
export function ringArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return s;
}
const orient = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
const onSegment = (a, b, p) => Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
function crosses(a, b, c, d) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSegment(a, b, c)) || (o2 === 0 && onSegment(a, b, d)) || (o3 === 0 && onSegment(c, d, a)) || (o4 === 0 && onSegment(c, d, b));
}
/** Does a closed ring cross or touch itself anywhere but where each side meets the next? */
export function selfIntersects(ring) {
  const n = ring.length - 1;   // sides
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (j === i + 1 || (i === 0 && j === n - 1)) continue;   // neighbours share a corner
    if (crosses(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
  }
  return false;
}
/**
 * An area drawn, made what WHG's `bounds` takes (RFC 7946): { area } a GeoJSON Polygon of one closed ring,
 * its points rounded to six places, longitudes in [-180, 180], running counter-clockwise; or { problem }:
 * 'not-polygon', 'too-few' (fewer than three corners), 'too-many' (over MAX_AREA_POINTS), 'out-of-range'
 * (a latitude beyond the poles, or a coordinate that is not a number), 'self-intersects'. Never silently
 * mended beyond the wrapping, the closing and the direction: a problem is said (SCOPE_WORDS.where.areaProblem).
 */
export function areaCheck(g) {
  const ring = g && g.type === 'Polygon' && Array.isArray(g.coordinates) ? g.coordinates[0] : null;
  if (!Array.isArray(ring)) return { problem: 'not-polygon' };
  if (ring.length > MAX_AREA_POINTS + 1) return { problem: 'too-many' };
  const pts = [];
  for (const p of ring) {
    if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number' || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[1]) > 90) return { problem: 'out-of-range' };
    pts.push([r6(wrapLon(p[0])), r6(p[1])]);
  }
  if (pts.length && (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1])) pts.push([...pts[0]]);
  if (pts.length < 4 || new Set(pts.slice(0, -1).map((p) => p.join(','))).size < 3) return { problem: 'too-few' };
  if (selfIntersects(pts)) return { problem: 'self-intersects' };
  if (ringArea(pts) < 0) pts.reverse();
  return { area: { type: 'Polygon', coordinates: [pts] } };
}
/** The area as WHG takes it (areaCheck), or null when it is not one. */
export const areaPolygon = (g) => areaCheck(g).area ?? null;

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
    // Where its narrower ones came from: WHG asked then ('whg'), WHG's answer kept in this browser from an
    // earlier day ('cache', with `at`), or the bundled expansion ('bundled'); the label says the last two.
    const from = ['whg', 'cache'].includes(t.from) ? t.from : 'bundled';
    const at = typeof t.at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.at) ? t.at : null;
    out.types.push({ id: t.id, label: str(t.label) || t.id, narrower, from, ...(from !== 'bundled' && at ? { at } : {}) });
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
 * `relaxed` (its constraint's relaxation: 'all' sends no Where), `undatedTaken` (UNDATED_TAKEN, given here
 * only by the tests). WHG's form (12 October 2026): `undated: true` only with `start` and/or `end`, and
 * `temporal: true` with every year window; `temporal_mode` ('possibly' | 'definitely') is not sent.
 */
export function scopeFields(scope, { region = false, own = null, relaxed = null, undatedTaken = UNDATED_TAKEN } = {}) {
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
    if (undatedTaken && s.when.undated) params.undated = true;   // exactly undated: true, and only beside a year (WHG, 12 October 2026)
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
export function scopeType({ id, label }, expandedIds = [], from = 'whg', at = null) {
  return normaliseScope({ types: [{ id, label, narrower: expandedIds, from, at }] }).types[0] ?? null;
}
