// Krisis: region review (Methodos stages 3 and 4). The regions a table's places lie in (a parish, its
// county, its country: Hermes's "within" columns, src/engine/hermes/within.js) are looked up level by
// level from the widest, and each region's lookup is constrained by the match of the region above it;
// then the places are looked up within their regions. Pure: nothing here sends anything (lookup.js's
// runLevel and runPlaces do, through the shared gazetteer queue) or reads a file.
//
// - A region is a node of the work file's `regions` (work.js, version 3), keyed by its minted address
//   where the dataset has one, else by its containerKey: two regions of one name under different
//   parents are two nodes, the same name under the same parents one.
// - Each node is gated by its own parent, not by its whole level: it is 'locked' until the region
//   above it is settled, then 'ready', then (looked up) 'review', then 'settled' (a match decided, or
//   the reviewer's word that there is none).
// - The constraint (constraintFor) comes from the nearest ancestor with a match. WHG's spatial filters
//   are NOT combined (contained_in wins over lat/lng/radius, which wins over bounds), so one is sent:
//   `contained_in`, a LIST of the match's bare ids ("gn:2635167"), several unioned; else the match's
//   area from its record (entity()), as lat/lng/radius. The match's countries are added, and are ANDed
//   with it: a candidate with no country recorded cannot pass, which the constraint says. A region
//   matched to several records is constrained by the union of them (decided by the maintainer).
// - Relaxing, in order: drop the countries; the area in place of contained_in (each includes the one
//   before it); the next ancestor up, constrained as the nearest is (its contained_in where it has ids,
//   else its area, and its own countries: the steps before are not carried up); no constraint.
// - WHG says whether it applied a filter (`scope.applied`, and `scope.approximate`). A filter it could
//   not apply that answered nothing (applied false, zero candidates) FAILED CLOSED: it is recorded as
//   such and the node stays ready, never read as "no match" (lookup.js mergeAnswers).
// - A changed decision on a settled region (a different resolution) clears everything below it
//   (invalidate), returning a snapshot for Undo; a decision that leaves the resolution as it was, or
//   settles a region for the first time, clears nothing.
import { decide } from './work.js';
import { REGION_WORDS } from '../words.js';

/**
 * The steps of relaxing a constraint, in order. 'contained-in' includes 'countries'; 'ancestor' starts
 * afresh from the region further up (its contained_in, else its area, with its countries); 'all' is none.
 */
export const RELAX_ORDER = ['countries', 'contained-in', 'ancestor', 'all'];
/** Other names for a step: "area" is the area in place of contained_in. */
export const RELAX_ALIASES = { area: 'contained-in' };
/** Every name the command line and the page accept for a step. */
export const RELAX_NAMES = ['countries', 'contained-in', 'area', 'ancestor', 'all'];
/** How far a relaxation goes: -1 for none, else its place in RELAX_ORDER. Throws on an unknown name. */
export function relaxStep(relax) {
  if (relax === undefined || relax === null) return -1;
  const name = RELAX_ALIASES[relax] ?? relax;
  const i = RELAX_ORDER.indexOf(name);
  if (i < 0) throw new TypeError(REGION_WORDS.relaxUnknown(relax, RELAX_NAMES));
  return i;
}
/** PLATO's certainty levels, for a match's certainty (work.js CERTAINTIES). */
export const CERTAINTY_LEVELS = { certain: 'https://w3id.org/plato#Certain', 'less-certain': 'https://w3id.org/plato#LessCertain', uncertain: 'https://w3id.org/plato#Uncertain' };
/** The greatest radius WHG takes, in kilometres (lookup.js MAX_RADIUS_KM). */
const MAX_RADIUS_KM = 20015;

const isRegion = (work, key) => typeof key === 'string' && Object.hasOwn(work.regions || {}, key);

// ---- seeding the review ----------------------------------------------------------------------------------
/**
 * Put gather()'s regions into the work file (work.regions), and each place's narrowest region and
 * level on its entry (a place in regions not yet listed is listed, without candidates, so that the
 * review of the places within can count it). A region already there keeps its review (outcome,
 * area, rowState); its label and count are brought up to date. Returns the work file.
 */
export function seedRegions(work, { regions = [], places = [] } = {}) {
  if (!work.regions) work.regions = {};
  for (const r of regions) {
    const had = Object.hasOwn(work.regions, r.key) ? work.regions[r.key] : null;
    work.regions[r.key] = { label: r.label, names: [...r.names], level: r.level, container: r.container, within: r.within, count: r.count,
      outcome: had?.outcome ?? null, ...(had && Object.hasOwn(had, 'area') ? { area: had.area } : {}), ...(had && Object.hasOwn(had, 'rowState') ? { rowState: had.rowState } : {}) };
  }
  for (const p of places) {
    if (!(typeof p.within === 'string' && isRegion(work, p.within))) continue;
    if (!Object.hasOwn(work.places, p.iri)) work.places[p.iri] = { label: p.label, names: p.names || [p.label], point: p.point ?? null, ...(p.ccodes ? { ccodes: p.ccodes } : {}), ...(p.types ? { types: p.types } : {}) };
    Object.assign(work.places[p.iri], { within: p.within, level: p.level });
  }
  return work;
}

// ---- the nodes and their states ----------------------------------------------------------------------------
/** The latest query record for a key (a region or a place) in any lookup, or null. */
export function lastQueryOf(work, key) {
  let q = null;
  for (const l of work.lookups || []) if (Object.hasOwn(l.queries, key)) q = l.queries[key];
  return q;
}
/** The keys above a region, or above a place (its narrowest region first), nearest first. */
export function ancestorsOf(work, key) {
  const out = [];
  let k = isRegion(work, key) ? work.regions[key].within : Object.hasOwn(work.places, key) ? work.places[key].within ?? null : null;
  while (typeof k === 'string' && isRegion(work, k) && !out.includes(k)) { out.push(k); k = work.regions[k].within; }
  return out;
}
/** The candidates a key's review has matched. */
export const matchesOf = (work, key) => work.candidates.filter((c) => c.candidate_source === key && c.decision?.kind === 'match');
/** What a region resolved to, as one string, to tell a decision that changes it from one that does not. */
export function resolutionOf(work, key) {
  const r = isRegion(work, key) ? work.regions[key] : null;
  return JSON.stringify([r?.outcome ?? null, matchesOf(work, key).map((c) => c.candidate_candidate).sort()]);
}
const settled = (work, key) => isRegion(work, key) && work.regions[key].outcome !== null;
/**
 * A region's state: 'settled' (a match decided, or settled with none), 'locked' (the region above is
 * not settled), 'review' (answered, and not since made stale), else 'ready'.
 */
export function regionState(work, key) {
  if (!isRegion(work, key)) throw new TypeError(`Not a region of this review: ${key}`);
  const r = work.regions[key];
  if (r.outcome !== null) return 'settled';
  if (r.within !== null && !settled(work, r.within)) return 'locked';
  const q = lastQueryOf(work, key);
  return q && q.state === 'answered' && !q.stale ? 'review' : 'ready';
}
/**
 * A place's state in the review of the places within: 'locked' while any region of its chain is not
 * settled, 'settled' once one of its candidates is decided, 'review' when answered (and not made
 * stale), else 'ready'. A place in no region is never locked, nor is one answered by a plain lookup
 * (a query with no constraint record: looked up as any place is, outside the region review), which
 * is reviewed as it is. `place` is its entry, if not the work file's.
 */
export function placeState(work, iri, place = Object.hasOwn(work.places, iri) ? work.places[iri] : null) {
  const q = lastQueryOf(work, iri);
  const answered = !!q && q.state === 'answered' && !q.stale;
  if (!(answered && !Object.hasOwn(q, 'constraint'))) {
    let k = place?.within ?? null;
    const seen = new Set();
    while (typeof k === 'string' && isRegion(work, k) && !seen.has(k)) { if (!settled(work, k)) return 'locked'; seen.add(k); k = work.regions[k].within; }
  }
  if (work.candidates.some((c) => c.candidate_source === iri && c.decision)) return 'settled';
  return answered ? 'review' : 'ready';
}
/** The levels in use, widest first. */
export const levelsOf = (work) => [...new Set(Object.values(work.regions || {}).map((r) => r.level))].sort((a, b) => a - b);
/** Every region, with its key and state, by level then label. */
export function regionNodes(work) {
  return Object.entries(work.regions || {}).map(([key, r]) => ({ key, ...r, state: regionState(work, key) }))
    .sort((a, b) => a.level - b.level || a.label.localeCompare(b.label) || (a.key < b.key ? -1 : 1));
}
/**
 * The regions of a level to look up: those ready; with `only` (keys), just those, in review too
 * (asked again, relaxed say), but never one locked or settled.
 */
export function selectLevel(work, level, { only } = {}) {
  const keep = only ? new Set(only) : null;
  return regionNodes(work).filter((n) => n.level === level && (keep ? keep.has(n.key) && (n.state === 'ready' || n.state === 'review') : n.state === 'ready'));
}
/** How far the region review has come: { settled, total, levels: [{ level, total, locked, ready, review, settled }] }. */
export function regionProgress(work) {
  const levels = new Map();
  for (const n of regionNodes(work)) {
    if (!levels.has(n.level)) levels.set(n.level, { level: n.level, total: 0, locked: 0, ready: 0, review: 0, settled: 0 });
    const l = levels.get(n.level); l.total++; l[n.state]++;
  }
  const all = [...levels.values()];
  return { settled: all.reduce((s, l) => s + l.settled, 0), total: all.reduce((s, l) => s + l.total, 0), levels: all };
}

// ---- the constraint ------------------------------------------------------------------------------------
/** A WHG id as contained_in takes it: bare, without "place:" ("gn:2635167"). */
export const bareId = (id) => (typeof id === 'string' && id ? id.replace(/^place:/, '') : null);
const iso2 = (codes) => [...new Set((codes || []).filter((c) => typeof c === 'string' && /^[a-z]{2}$/i.test(c.trim())).map((c) => c.trim().toUpperCase()))].sort();
/** The ids an area is made from, for a region's matches: each match's gazetteer id, else its address. */
export const areaIds = (work, key) => matchesOf(work, key).map((c) => c.gazetteer?.id ?? c.candidate_candidate).sort();
const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The constraint for looking up `key` (a region, or a place within regions), from the nearest region
 * above it with a match. options: relax (RELAX_NAMES, RELAX_ORDER says what each step does), areas (a
 * Map of region key -> area for this run, consulted before the work file's). Returns
 * { from, kinds, params, relaxed } (the query record keeps these), and, when they apply:
 * `needsArea` (the key of the region whose area must be fetched first: entity(), lookup.js),
 * `noArea` (why the region has no area to give: REGION_WORDS.noArea), and `uncodedFail` (countries are
 * sent, so a candidate with no country recorded cannot pass).
 */
export function constraintFor(work, key, { relax, areas } = {}) {
  const step = relaxStep(relax);
  const relaxed = step < 0 ? null : RELAX_ORDER[step];
  const none = { from: null, kinds: [], params: {}, relaxed };
  if (step >= RELAX_ORDER.indexOf('all')) return none;
  const matched = ancestorsOf(work, key).filter((k) => work.regions[k].outcome === 'matched' && matchesOf(work, k).length);
  // At 'ancestor', the region further up constrains as the nearest does with nothing relaxed: the steps before are not carried up.
  const up = step === RELAX_ORDER.indexOf('ancestor');
  const from = matched[up ? 1 : 0];
  if (from === undefined) return none;
  const ms = matchesOf(work, from);
  const ids = [...new Set(ms.map((c) => bareId(c.gazetteer?.id)).filter(Boolean))].sort();
  const out = { from, kinds: [], params: {}, relaxed };
  const keepIds = up || step < RELAX_ORDER.indexOf('contained-in'), keepCountries = up || step < RELAX_ORDER.indexOf('countries');
  if (keepIds && ids.length) {
    out.kinds.push('contained_in');
    out.params.contained_in = ids;
  } else {
    const area = areas?.has(from) ? areas.get(from) : Object.hasOwn(work.regions[from], 'area') ? work.regions[from].area : null;
    if (!area || !sameList(area.from, areaIds(work, from))) out.needsArea = from;
    else if (typeof area.none === 'string') out.noArea = area.none;
    else { out.kinds.push('area'); Object.assign(out.params, { lat: area.lat, lng: area.lng, radius: area.radius }); }
  }
  const countries = iso2(ms.flatMap((c) => c.other?.ccodes || []));
  if (keepCountries && countries.length) {
    out.kinds.push('countries');
    out.params.countries = countries;
    out.uncodedFail = true;
  }
  return out;
}
/**
 * The steps of relaxing that apply to every one of these keys (RELAX_ORDER's names), so that a step
 * asked for never sends less than it says: 'countries' where countries are sent, 'contained-in' where
 * contained_in is, 'ancestor' where a region further up is matched and gives a constraint, and 'all'
 * always. A key with nothing to relax (no constraint at all) is passed over.
 */
export function relaxAvailable(work, keys) {
  const has = (c) => c.kinds.length > 0 || !!c.needsArea;
  const relaxable = keys.filter((k) => { const c = constraintFor(work, k); return has(c) || !!c.noArea; });
  const applies = {
    countries: (k) => constraintFor(work, k).kinds.includes('countries'),
    'contained-in': (k) => constraintFor(work, k).kinds.includes('contained_in'),
    ancestor: (k) => { const c = constraintFor(work, k, { relax: 'ancestor' }); return c.from !== null && has(c); },
  };
  return RELAX_ORDER.filter((s) => s === 'all' || (relaxable.length > 0 && relaxable.every(applies[s])));
}
/** What a query record keeps of a constraint. */
export const storedConstraint = (c) => ({ from: c.from, kinds: [...c.kinds], params: structuredClone(c.params), relaxed: c.relaxed });

const R = 6371.0088;
function km([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** Every [lon, lat] in a GeoJSON geometry (any type, a GeometryCollection's members too). */
function positions(g, out = []) {
  if (!g || typeof g !== 'object') return out;
  if (Array.isArray(g.geometries)) for (const m of g.geometries) positions(m, out);
  const walk = (c) => { if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') { if (Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90) out.push(c); } else if (Array.isArray(c)) c.forEach(walk); };
  walk(g.coordinates);
  return out;
}
/**
 * The area to constrain by, from the records of a region's matches (Linked Places Features, as
 * entity() gives them): the box about all their geometries (the union), and, as WHG takes an area, the
 * box's middle and the radius (km, rounded up) that reaches its corners. `from` is the ids it was made
 * from. With no geometry, or only one point, there is no area: { none, from }.
 */
export function areaOf(features, from = []) {
  const pts = [];
  for (const f of features) {
    if (!f || typeof f !== 'object') continue;
    positions(f.geometry, pts);
    for (const g of Array.isArray(f.geometries) ? f.geometries : []) positions(g.geometry ?? g, pts);
  }
  if (!pts.length) return { none: 'no-geometry', from: [...from] };
  const w = Math.min(...pts.map((p) => p[0])), e = Math.max(...pts.map((p) => p[0])), s = Math.min(...pts.map((p) => p[1])), n = Math.max(...pts.map((p) => p[1]));
  if (w === e && s === n) return { none: 'point-only', from: [...from] };
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  const lat = (s + n) / 2, lng = (w + e) / 2;
  const radius = Math.min(MAX_RADIUS_KM, Math.max(1, Math.ceil(Math.max(...[[w, s], [w, n], [e, s], [e, n]].map((c) => km([lng, lat], c))))));
  return { bbox: [w, s, e, n].map(r6), lat: r6(lat), lng: r6(lng), radius, from: [...from] };
}

// ---- decisions, and what they clear --------------------------------------------------------------------
/** Everything below a region: the regions under it (at any depth) and the places within any of them or it. */
export function below(work, key) {
  const regions = Object.keys(work.regions || {}).filter((k) => k !== key && ancestorsOf(work, k).includes(key));
  const inside = new Set([key, ...regions]);
  const places = Object.keys(work.places).filter((iri) => inside.has(work.places[iri].within));
  return { regions, places };
}
/**
 * Clear everything below a region, as WHG resets the levels below a changed parent: the decisions on
 * the regions and places below are taken back and their outcomes cleared, the candidates a lookup gave
 * them are removed (a local match's stay), and their query records are marked stale. Returns a
 * snapshot for undo(), with what was cleared counted: { key, counts: { regions, places, decisions,
 * candidates }, … }.
 */
export function invalidate(work, key) {
  const { regions, places } = below(work, key);
  const keys = new Set([...regions, ...places]);
  const snapshot = {
    key, candidates: structuredClone(work.candidates),
    regions: Object.fromEntries(regions.map((k) => [k, structuredClone(work.regions[k])])),
    queries: (work.lookups || []).flatMap((l) => Object.keys(l.queries).filter((k) => keys.has(k)).map((k) => ({ lookup: l.id, key: k, query: structuredClone(l.queries[k]) }))),
    counts: { regions: regions.length, places: places.length, decisions: 0, candidates: 0 },
  };
  const kept = [];
  for (const c of work.candidates) {
    if (!keys.has(c.candidate_source)) { kept.push(c); continue; }
    if (c.decision) snapshot.counts.decisions++;
    if (c.lookup !== undefined && c.lookup !== null) { snapshot.counts.candidates++; continue; }
    c.decision = null; c.candidate_status = 'suggested';
    kept.push(c);
  }
  work.candidates = kept;
  for (const k of regions) { work.regions[k].outcome = null; delete work.regions[k].area; }
  for (const l of work.lookups || []) for (const k of Object.keys(l.queries)) if (keys.has(k)) l.queries[k].stale = true;
  return snapshot;
}
/** Put back what invalidate() cleared (Undo), from its snapshot. */
export function undo(work, snapshot) {
  work.candidates = structuredClone(snapshot.candidates);
  for (const [k, r] of Object.entries(snapshot.regions)) work.regions[k] = structuredClone(r);
  for (const { lookup, key, query } of snapshot.queries) {
    const l = (work.lookups || []).find((x) => x.id === lookup);
    if (l) l.queries[key] = structuredClone(query);
  }
  return work;
}
/** A region's outcome from its decisions: matched while any match is decided; else as the reviewer settled it, or open. */
function refreshOutcome(work, key) {
  const r = work.regions[key];
  if (matchesOf(work, key).length) r.outcome = 'matched';
  else if (r.outcome === 'matched') r.outcome = null;
  return r.outcome;
}
/**
 * Decide on a region's candidate (work.js decide(), with its options, certainty among them), and
 * bring the region's outcome up to date. When that changes what the region resolved to, everything
 * below it is cleared (invalidate); a decision that leaves it as it was clears nothing. Returns
 * { candidate, snapshot } (snapshot null when nothing was cleared).
 */
export function decideRegion(work, candidateId, kind, options = {}) {
  const c = work.candidates.find((x) => x.id === candidateId);
  if (!c) throw new Error(`No candidate ${candidateId}`);
  if (!isRegion(work, c.candidate_source)) throw new Error(`Candidate ${candidateId} is not a region's`);
  const was = work.regions[c.candidate_source].outcome, before = resolutionOf(work, c.candidate_source);
  decide(work, candidateId, kind, options);
  refreshOutcome(work, c.candidate_source);
  return { candidate: c, snapshot: changed(work, c.candidate_source, was, before) ? invalidate(work, c.candidate_source) : null };
}
/**
 * The reviewer's word that a region has no match among its candidates ('no-match'), or that it is open
 * again (null). The regions below are then constrained by the region above it. Clears below on a change,
 * as decideRegion does. Returns the snapshot, or null.
 */
export function settleRegion(work, key, outcome) {
  if (!isRegion(work, key)) throw new TypeError(`Not a region of this review: ${key}`);
  if (outcome !== null && outcome !== 'no-match') throw new TypeError(`A region is settled with no match (no-match), or opened again (null), not ${outcome}`);
  if (outcome === 'no-match' && matchesOf(work, key).length) throw new Error('This region has a match decided: take it back before saying it has none.');
  const was = work.regions[key].outcome, before = resolutionOf(work, key);
  work.regions[key].outcome = outcome;
  return changed(work, key, was, before) ? invalidate(work, key) : null;
}
/**
 * Whether a decision changed a SETTLED region's resolution: only then is what lies below cleared. A
 * region settled for the first time clears nothing (what below it was looked up unconstrained, before,
 * is kept); one settled before and now resolved otherwise, or opened again, clears what was constrained by it.
 */
const changed = (work, key, was, before) => was !== null && resolutionOf(work, key) !== before;

// ---- the plan ---------------------------------------------------------------------------------------------
/**
 * What a region review would look up, level by level, before anything is sent (the command line's
 * --dry-run, the page's preview): for each level its regions by state, and for each ready region its
 * constraint in words (needsArea: its area is fetched first); then the places within, ready and
 * locked. `places`: gather()'s places, else the work file's.
 */
export function planLevels(work, { relax, unconstrained = false, places = null } = {}) {
  const label = (k) => (isRegion(work, k) ? work.regions[k].label : k);
  const levels = regionProgress(work).levels.map((l) => ({
    level: l.level, nodes: l.total, states: { locked: l.locked, ready: l.ready, review: l.review, settled: l.settled },
    ready: selectLevel(work, l.level).map((n) => { const c = constraintFor(work, n.key, { relax }); return { key: n.key, label: n.label, constraint: REGION_WORDS.constraint(c, label), kinds: c.kinds, ...(c.needsArea ? { needsArea: c.needsArea } : {}) }; }),
  }));
  const list = places ? places : Object.entries(work.places).map(([iri, p]) => ({ iri, ...p }));
  const states = list.map((p) => placeState(work, p.iri, Object.hasOwn(work.places, p.iri) ? work.places[p.iri] : p));
  return { levels, places: { ready: states.filter((s) => s === 'ready').length, locked: states.filter((s) => s === 'locked').length, unconstrained } };
}
