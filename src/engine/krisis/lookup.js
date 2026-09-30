// Krisis: look the subject places up in a gazetteer, through its W3C reconciliation service (the
// World Historical Gazetteer by default), and add what it answers to the work file as candidates for
// the same review as a local match. The talking to the service is the shared gazetteer module's
// (src/engine/gazetteer/, which this file uses and never changes); what is Krisis's is here: which
// places are looked up and what is sent for each, how the answers are ranked, and how they are kept.
//
// Kept light (no pipeline): the page runs a lookup on its main thread, so that the token never enters
// the worker. The engine never sees the token at all: it is given a lookup made with it
// (createLookup), and nothing here writes a token into the work file, a report or an error.
//
// - What is sent. For each place its label, and only its label, unless `allNames` asks for its other
//   names too, each as a query of its own (a request costs the same however many queries it holds,
//   but WHG counts queries a minute). Query properties FILTER a gazetteer's answer, never boost it,
//   and a wrong value silently drops the right place (WHG's country codes are patchy), so none is sent
//   unless asked for: `countries` sends the place's own country codes, `nearKm` a box of that many
//   kilometres about its point (which sends its coordinates).
// - What comes back is ranked for the reviewer (rankGazetteer), never accepted: WHG's score is relative
//   to the best in its own answer (the top is always about 100, however bad), and its confidence
//   measures the name only. So the order is by distance, then whether the countries agree, then
//   Krisis's own name similarity (names.js, the similarity_score of every candidate), then the
//   service's order. A candidate further than maxDistanceKm is kept and marked `far`, not dropped.
//   The service's own figures are kept apart, under `gazetteer`.
// - An answer the service could not give (`.unanswered`) is not "nothing found": the place is marked
//   'unanswered', to be tried again. An error that stops the lookup (a refused token, the day's
//   allowance spent, too many queries, no answer, a failure) keeps what was answered and marks the rest
//   'stopped', as does the reviewer stopping it (signal); the work file can be saved and the lookup
//   resumed.
// - A candidate without an address (iri null), or one the dataset already links to the place, or says
//   is a different place, or that the review has already decided, is not suggested, and is counted.
//   A place looked up again has its undecided candidates from that service replaced.
// - The service's `attribution` (the licences of the sources searched) is kept as it came, a null
//   left null, on the lookup record, so the page can show each candidate's licence. No licence is ever
//   written into an attestation, and none is assumed here.
import { WHG_ENDPOINT, isWhg, normaliseWhgIri } from '../gazetteer/index.js';
// TODO: take mergeAttribution (and whgQueryType's canonical type) from index.js once the gazetteer
// module re-exports them there, as its owner plans; whg.js is imported directly until then.
import { mergeAttribution, whgQueryType } from '../gazetteer/whg.js';
import { similarity } from './names.js';
import { WORK_VERSION } from './work.js';
import { linkState } from './identities.js';
export { authorityIris, currentIdentities } from './identities.js';
// The note an attestation on a looked-up candidate carries, here too for the tools that use this file (Chora).
export { krisisLookupNote } from '../words.js';

export const LOOKUP_ALGORITHM = 'krisis-lookup 1';
export const LOOKUP_DEFAULTS = { limit: 10, maxDistanceKm: 50, allNames: false, countries: false, nearKm: null };
/** Which places a lookup takes (selectPlaces). */
export const PLACE_CHOICES = ['unmatched', 'all', 'pending', 'unlinked'];
/** How many queries the preview shows exactly as they would be sent. */
export const PREVIEW_QUERIES = 20;
/** WHG's allowance of requests a day, for the preview (whg.js, A3). */
export const WHG_REQUESTS_A_DAY = 5000;
/** WHG, as the source a judgement on one of its candidates cites (identity.js gazetteerSource). */
export const WHG_SERVICE = { endpoint: WHG_ENDPOINT, title: 'World Historical Gazetteer', uri: 'https://whgazetteer.org/' };
/**
 * The type every query to WHG is sent as, always, in the form the gazetteer module sends it (its
 * whgQueryType, which writes every form of Place as "Place"), so that the preview is what WHG
 * receives. WHG refuses an unknown type or two types in one request (400), and a query without one is
 * unsafe (confirmed from WHG's production code, 30 September 2026).
 * TODO: use whg.js's own constant when the gazetteer module has one (its owner plans to move it there).
 */
export const WHG_PLACE_TYPE = whgQueryType(null);
/** The type to send another service: the first of its manifest's defaultTypes, or null (none sent). */
export function typeFromManifest(manifest) {
  const t = Array.isArray(manifest?.defaultTypes) ? manifest.defaultTypes[0] : null;
  return typeof t?.id === 'string' && t.id ? t.id : null;
}
/**
 * A candidate's address from an IRI template (the manifest's view.url, or one given), for a service
 * whose ids are not addresses (Wikidata's Q42): `{{id}}` is replaced by the id. Returns iri(id) for
 * createLookup, or throws if the template is not a web address with {{id}} in it.
 */
export function iriFromTemplate(template) {
  if (typeof template !== 'string' || !template.includes('{{id}}') || !/^https?:\/\/\S+$/.test(template.replace('{{id}}', 'x'))) throw new TypeError(`Not an address template with {{id}} in it: ${template}`);
  return (id) => (typeof id === 'string' && id ? template.split('{{id}}').join(encodeURIComponent(id)) : null);
}

/**
 * The service a lookup asks, as the work file records it: WHG's by its name, any other by its
 * address. `title` and `uri` may be given for another service.
 */
export function serviceOf(endpoint = WHG_ENDPOINT, { title, uri } = {}) {
  if (isWhg(endpoint)) return { ...WHG_SERVICE, endpoint };
  let u;
  try { u = new URL(endpoint); } catch { throw new TypeError(`Not a web address: ${endpoint}`); }
  return { endpoint, title: title || u.host, uri: uri || `${u.protocol}//${u.host}/` };
}

// ---- which places ---------------------------------------------------------------------------------------
const localCandidate = (c) => c.lookup === undefined || c.lookup === null;
/** Does this address belong to the service (WHG: its w3id or its own site; another: its host)? */
function ofService(iri, service) {
  const s = normaliseWhgIri(iri);
  if (typeof s !== 'string') return false;
  if (isWhg(service.endpoint)) return s.startsWith('https://w3id.org/whg/') || /^https?:\/\/(www\.)?whgazetteer\.org\//.test(s);
  try { return new URL(s).host === new URL(service.endpoint).host; } catch { return false; }
}
/** The latest state of a place in the lookups of this service, or null if never looked up there. */
function lastState(work, iri, service) {
  let state = null;
  for (const l of work?.lookups || []) if (l.service.endpoint === service.endpoint && l.queries[iri]) state = l.queries[iri].state;
  return state;
}

/**
 * The places to look up. `places` as gather() gives them (with the links the dataset states), else the
 * work file's places (links then not known). `which`:
 * - 'unmatched': those without a candidate from the local match (every place, without one);
 * - 'all';
 * - 'pending': those a lookup of this service has not answered yet (unanswered, stopped, or still
 *   pending); a place never looked up is not among them, but among 'unmatched' and 'all';
 * - 'unlinked': those the dataset does not link to a place of this service, and without a candidate
 *   of it confirmed in the review. A legacy WHG address (/places/<n>/portal/) counts as a link.
 * `only`: IRIs to restrict it to (one place, from the review screen).
 */
export function selectPlaces({ work = null, places = null, which, service, only } = {}) {
  let list = places ? places : Object.entries(work?.places || {}).map(([iri, p]) => ({ iri, ...p }));
  if (only) { const keep = new Set(only); list = list.filter((p) => keep.has(p.iri)); }
  const cands = work?.candidates || [];
  const choose = which ?? defaultChoice(work);
  if (!PLACE_CHOICES.includes(choose)) throw new TypeError(`Not a choice of places: ${choose}`);
  if (choose === 'all') return list;
  if (choose === 'unmatched') {
    const matched = new Set(cands.filter(localCandidate).map((c) => c.candidate_source));
    return list.filter((p) => !matched.has(p.iri));
  }
  if (choose === 'pending') return list.filter((p) => ['pending', 'unanswered', 'stopped'].includes(lastState(work, p.iri, service)));
  const confirmed = new Set(cands.filter((c) => c.decision?.kind === 'match' && ofService(c.candidate_candidate, service)).map((c) => c.candidate_source));
  return list.filter((p) => !confirmed.has(p.iri) && ![...(p.identities?.linked || [])].some((iri) => ofService(iri, service)));
}
/** After a local match, the places it found nothing for; once a lookup has run, those it has not answered. */
export const defaultChoice = (work) => (work?.lookups?.length ? 'pending' : 'unmatched');

// ---- what is sent ----------------------------------------------------------------------------------------
/** The greatest radius WHG takes, in kilometres (half the Earth's circumference). */
export const MAX_RADIUS_KM = 20015;
/**
 * The filters of one place's queries, when asked for, as top-level keys of the query. `nearKm`: `lat`,
 * `lng` and `radius` (km), which WHG resolves as a disc (H3 cells, so its edge is approximate: a place
 * 10.3 km away may pass a 10 km radius), and answers from its upstream gateway only; confirmed from
 * WHG's production code, 30 September 2026. `countries`: the place's own country codes as a JSON list
 * of ISO 3166-1 alpha-2 codes, in capitals (as the gazetteer module's owner confirmed, 30 September
 * 2026); a code that is not two letters is not sent.
 */
function filtersOf(place, { countries, nearKm }) {
  const params = {};
  const iso2 = countries && Array.isArray(place.ccodes)
    ? [...new Set(place.ccodes.filter((c) => typeof c === 'string' && /^[a-z]{2}$/i.test(c.trim())).map((c) => c.trim().toUpperCase()))] : [];
  if (iso2.length) params.countries = iso2;
  const p = place.point;
  if (nearKm > 0 && Array.isArray(p) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90) {
    const r = (x) => Math.round(x * 1e6) / 1e6;
    Object.assign(params, { lat: r(p[1]), lng: r(p[0]), radius: Math.min(MAX_RADIUS_KM, nearKm) });
  }
  return Object.keys(params).length ? params : null;
}
/** A place's names to send: its label, then (allNames) each other name once, by how it is compared. */
function namesToSend(place, allNames) {
  const label = place.label || place.names?.[0] || place.iri;
  if (!allNames) return [label];
  const seen = new Set(), out = [];
  for (const n of [label, ...(place.names || [])]) {
    const k = String(n).trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(n);
  }
  return out;
}

/**
 * The queries for `places`, and a preview of them. options: allNames, limit (10), countries (false),
 * nearKm (null), batchSize (the lookup's: 25), service, type (another service's: typeFromManifest();
 * WHG's is always WHG_PLACE_TYPE). Returns { queries,
 * chunks, preview }: `queries` [{ key: [iri, name], query, limit, type?, params? }] in place order;
 * `chunks` the places in groups whose queries fill one batch (a place's queries are never split
 * across groups, so a place is answered all at once); `preview` { places, queries, requests,
 * allNames, filters: ['countries'|'near'], sendsCoordinates, nearKm, withoutCountries, withoutPoint, first:
 * [the first PREVIEW_QUERIES queries as they are sent] }.
 */
export function planQueries(places, options = {}) {
  const o = { ...LOOKUP_DEFAULTS, batchSize: 25, service: WHG_SERVICE, ...defined(options) };
  const type = isWhg(o.service.endpoint) ? WHG_PLACE_TYPE : o.type || undefined;
  const queries = [], chunks = [];
  let chunk = null, withoutCountries = 0, withoutPoint = 0;
  for (const place of places) {
    const params = filtersOf(place, o);
    if (o.countries && !params?.countries) withoutCountries++;
    if (o.nearKm > 0 && params?.radius === undefined) withoutPoint++;
    const mine = namesToSend(place, o.allNames).map((name) => ({ key: [place.iri, name], query: name, limit: o.limit, ...(type ? { type } : {}), ...(params ? { params } : {}) }));
    queries.push(...mine);
    if (!chunk || (chunk.queries.length && chunk.queries.length + mine.length > o.batchSize)) chunks.push(chunk = { places: [], queries: [] });
    chunk.places.push(place); chunk.queries.push(...mine);
  }
  const requests = chunks.reduce((n, c) => n + Math.ceil(c.queries.length / o.batchSize), 0);
  const filters = [...(o.countries ? ['countries'] : []), ...(o.nearKm > 0 ? ['near'] : [])];
  const preview = {
    places: places.length, queries: queries.length, requests, allNames: !!o.allNames, limit: o.limit, filters,
    sendsCoordinates: queries.some((q) => q.params?.radius !== undefined), withoutCountries, withoutPoint, nearKm: o.nearKm > 0 ? Math.min(MAX_RADIUS_KM, o.nearKm) : null,
    service: o.service, first: queries.slice(0, PREVIEW_QUERIES).map(sent),
  };
  return { queries, chunks, preview };
}
/** A query as the gazetteer module writes it into a request (its params, then query, type and limit). */
const defined = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null));
const sent = (q) => ({ ...(q.params || {}), query: q.query, ...(q.type ? { type: q.type } : {}), limit: q.limit });

// ---- ranking -----------------------------------------------------------------------------------------------
/**
 * The great-circle distance between two [lon, lat] points, in kilometres: match.js's distanceKm, not
 * imported from there because match.js brings in the pipeline, and a lookup runs on the page's thread.
 */
export function distanceKm([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * A place's candidates from a gazetteer (the module's Candidate objects, each with `answer_rank`, its
 * place in the service's answer, and `query`, the name that found it), ranked for the reviewer: by
 * distance (none last), then whether the countries agree (yes, not known, no), then Krisis's own name
 * similarity, then the service's order. Returns [{ candidate, similarity_score, distance_km,
 * ccodes_agree: true|false|null, far }], nothing dropped.
 */
export function rankGazetteer(place, candidates, { maxDistanceKm = LOOKUP_DEFAULTS.maxDistanceKm } = {}) {
  const mine = (place.names?.length ? place.names : [place.label]).filter(Boolean);
  const ranked = candidates.map((c, i) => {
    const theirs = [c.name, ...(c.altNames || [])].filter(Boolean);
    let best = 0;
    for (const a of mine) for (const b of theirs) best = Math.max(best, similarity(a, b));
    const distance = Array.isArray(place.point) && Array.isArray(c.coords) ? round(distanceKm(place.point, c.coords), 1) : null;
    const agree = place.ccodes?.length && c.ccodes?.length ? c.ccodes.some((x) => place.ccodes.includes(x)) : null;
    return { candidate: c, similarity_score: round(best, 3), distance_km: distance, ccodes_agree: agree, far: distance !== null && distance > maxDistanceKm, order: c.answer_rank ?? i };
  });
  const agreeKey = (x) => (x === true ? 0 : x === null ? 1 : 2);
  ranked.sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity) || agreeKey(a.ccodes_agree) - agreeKey(b.ccodes_agree)
    || b.similarity_score - a.similarity_score || a.order - b.order);
  return ranked.map(({ order, ...r }) => r);
}

// ---- keeping the answers -----------------------------------------------------------------------------------
/** A work file for places looked up without a local match: `subjects` as gather() records the dataset. */
export function newWork(subjects, { now = new Date().toISOString(), reviewer = null } = {}) {
  return { krisis: WORK_VERSION, generated_at: now, algorithm_version: LOOKUP_ALGORITHM, match_parameters: {},
    subjects, others: null, places: {}, candidates: [], reviewer, cursor: 0, lookups: [] };
}
const placeRecord = (p) => ({ label: p.label, names: p.names || [p.label], point: p.point ?? null, ...(p.ccodes ? { ccodes: p.ccodes } : {}), ...(p.types ? { types: p.types } : {}) });
const SKIPS = ['noIri', 'linked', 'denied', 'decided', 'duplicate'];
function emptyCounts() {
  return { places: 0, queries: 0, requests: 0, answered: 0, notFound: 0, unanswered: 0, stopped: 0, found: 0, added: 0, far: 0, skipped: Object.fromEntries(SKIPS.map((k) => [k, 0])) };
}
/** A new lookup record, added to the work file, with every place 'pending'. */
export function startLookup(work, { service, parameters, plan, now = new Date().toISOString() }) {
  let n = work.lookups.length + 1;
  while (work.lookups.some((l) => l.id === `l${n}`)) n++;
  const queries = {};
  for (const p of plan.chunks.flatMap((c) => c.places)) {
    if (!work.places[p.iri]) work.places[p.iri] = placeRecord(p);
    queries[p.iri] = { state: 'pending', sent: plan.queries.filter((q) => q.key[0] === p.iri).map((q) => q.query) };
  }
  const record = { id: `l${n}`, service, started_at: now, finished_at: null, algorithm_version: LOOKUP_ALGORITHM, parameters,
    attribution: null, counts: { ...emptyCounts(), places: plan.preview.places, queries: plan.preview.queries, requests: plan.preview.requests }, stopped: null, queries };
  work.lookups.push(record);
  return record;
}

/**
 * Add one place's answers to the work file. `lists` are the module's answers to that place's queries,
 * in the order sent (each with `.unanswered`, `.error`); `place` the place, with `identities` (what
 * its dataset currently says, identities.js) if known. The place is 'answered' when every query was, else 'unanswered' (to try again,
 * never "no match"); only an answered place has its earlier undecided candidates from this service
 * replaced. Returns the place's query record.
 */
export function mergeAnswers(work, record, place, lists, { now = new Date().toISOString(), maxDistanceKm = record.parameters?.maxDistanceKm ?? LOOKUP_DEFAULTS.maxDistanceKm, scrub, scoped = false } = {}) {
  const iri = place.iri, c = record.counts, q = record.queries[iri] || (record.queries[iri] = { state: 'pending', sent: lists.map((l) => l.key?.[1]).filter(Boolean) });
  if (!work.places[iri]) work.places[iri] = placeRecord(place);
  const unanswered = lists.filter((l) => l.unanswered);
  // The state is set last, so that a fault part-way leaves the place as it was ('pending', then 'stopped').
  const state = unanswered.length ? 'unanswered' : 'answered';
  // A query the service refused (a malformed filter, say) inside a good answer. Its words are kept only
  // when the caller, who holds the token, gives `scrub` to clean them of it: the module cleans only the
  // errors of a request, and the engine never sees the token.
  const errors = unanswered.map((l) => l.error).filter((e) => e != null);
  if (errors.length) { q.refused = true; if (typeof scrub === 'function') q.error = scrub(errors.join('; ')); else delete q.error; }
  else { delete q.refused; delete q.error; }
  // A filter by distance sent and not applied (WHG says so in `scope.applied`): the answer is not filtered.
  if (scoped && lists.some((l) => !l.unanswered && l.scope?.applied !== true)) { q.scopeNotApplied = true; c.scopeNotApplied = (c.scopeNotApplied || 0) + 1; }
  else delete q.scopeNotApplied;
  // One entry per address, from the query that ranked it best.
  const byIri = new Map(), noIri = new Set();
  lists.forEach((list, j) => list.forEach((cand, rank) => {
    if (!cand.iri) { noIri.add(cand.id); return; }
    const had = byIri.get(cand.iri);
    if (!had || rank < had.answer_rank) byIri.set(cand.iri, { ...cand, answer_rank: rank + 1, query: q.sent[j] ?? list.key?.[1] ?? null });
  }));
  c.skipped.noIri += noIri.size;
  q.found = byIri.size + noIri.size;
  c.found += q.found;
  const service = record.service;
  const sameService = (x) => !localCandidate(x) && work.lookups.find((l) => l.id === x.lookup)?.service.endpoint === service.endpoint;
  if (state === 'answered') work.candidates = work.candidates.filter((x) => !(x.candidate_source === iri && !x.decision && x.lookup !== record.id && sameService(x)));
  let added = 0, n = work.candidates.filter((x) => x.lookup === record.id).length;
  for (const r of rankGazetteer(place, [...byIri.values()], { maxDistanceKm })) {
    const g = r.candidate;
    if (g.iri === iri) { c.skipped.linked++; continue; }
    const known = linkState(place.identities, g);
    if (known) { c.skipped[known]++; continue; }
    const there = work.candidates.find((x) => x.candidate_source === iri && x.candidate_candidate === g.iri);
    if (there) { c.skipped[there.decision ? 'decided' : 'duplicate']++; continue; }
    let id;
    do id = `${record.id}-${++n}`; while (work.candidates.some((x) => x.id === id));
    work.candidates.push({
      id, candidate_source: iri, candidate_candidate: g.iri, similarity_score: r.similarity_score, distance_km: r.distance_km,
      candidate_status: 'suggested', generated_at: now, algorithm_version: LOOKUP_ALGORITHM, lookup: record.id,
      ...(r.far ? { far: true } : {}), ccodes_agree: r.ccodes_agree,
      other: { label: g.name, names: [...new Set([g.name, ...(g.altNames || [])].filter(Boolean))], point: g.coords ?? null,
        source: { title: service.title, ...(service.uri ? { uri: service.uri } : {}) }, ...(g.ccodes ? { ccodes: g.ccodes } : {}), ...(g.types?.length ? { types: g.types.map((t) => t.name) } : {}) },
      gazetteer: { service: service.endpoint, id: g.id, score: g.score, confidence: g.confidence, match: g.match, answer_rank: g.answer_rank,
        description: g.description, namespace: g.namespace, query: g.query },
      decision: null,
    });
    added++;
    if (r.far) c.far++;
  }
  q.added = added;
  c.added += added;
  q.state = state;
  if (state === 'answered') { c.answered++; if (!q.found) c.notFound++; } else c.unanswered++;
  return q;
}

/** A lookup's candidates for one place, in the order ranked (the order they were added). */
export const lookupCandidatesOf = (work, iri, lookupId) => work.candidates.filter((c) => c.candidate_source === iri && !localCandidate(c) && (!lookupId || c.lookup === lookupId));

/**
 * The licence a lookup's attribution gives for a candidate's source (its namespace; for WHG's own
 * records, whose namespace is null or whg, its dataset's in attribution.datasets, else WHG's own), as
 * the service wrote it, or null when it gives none ("licence unknown"): { spdx, commercial, derivatives }, where
 * commercial is permits_commercial and derivatives the opposite of no_derivatives, each true, false
 * or null (not known), and redistributable the source's own `redistributable` (false only when the
 * service says false; missing or null is not known, never true). Nothing is assumed: a value the
 * service left null stays null. A source that says it is not redistributable, with no licence, still
 * gives an object, so that it is not read as merely "licence unknown".
 */
export function licenceOf(attribution, namespace, dataset) {
  const pick = (x) => (x && (typeof x.license === 'string' || (x.license && typeof x.license === 'object')) ? x.license : null);
  // A source's own; else, for WHG's own records (no namespace, or whg), its dataset's, then WHG's.
  const own = namespace && namespace !== 'whg' ? attribution?.sources?.[namespace] : null;
  let l = pick(own), entry = own;
  if (!l && (!namespace || namespace === 'whg')) {
    for (const e of [dataset != null ? attribution?.datasets?.[dataset] : null, attribution?.whg, attribution?.sources?.whg]) if (pick(e)) { l = pick(e); entry = e; break; }
  }
  const yes = (v) => (v === true || v === false ? v : null);
  const redistributable = yes(entry?.redistributable);
  if (!l) return redistributable === false ? { spdx: null, commercial: null, derivatives: null, redistributable } : null;
  if (typeof l === 'string') return { spdx: l, commercial: null, derivatives: null, redistributable };
  return { spdx: typeof l.spdx_id === 'string' ? l.spdx_id : null, commercial: yes(l.permits_commercial), derivatives: l.no_derivatives === true ? false : l.no_derivatives === false ? true : null, redistributable };
}

// ---- the run ------------------------------------------------------------------------------------------------
/** A first batch of several queries that all came back empty, none refused: most likely a wrong filter or type, not "nothing". */
const suspect = (chunk, answers) => chunk.queries.length > 1 && answers.every((l) => !l.unanswered && l.length === 0);

/**
 * Look places up and add what is found to the work file.
 *   lookup     a lookup from createLookup() (src/engine/gazetteer/), made with the token if any
 *   work       the work file (an object, changed in place), or null to begin one from `subjects`
 *   subjects   gather()'s record of the dataset ({ title, uri?, files }), when `work` is null
 *   places     gather()'s places, with the links the dataset states; else the work file's (links not known)
 *   options    service (serviceOf(): WHG's by default), places (PLACE_CHOICES; default defaultChoice()),
 *              only (IRIs), allNames, limit, countries, nearKm, maxDistanceKm, type (another service's),
 *              scrub (text => text cleaned of the token, from the caller who holds it: a query's error
 *              is kept only when it is given)
 *   signal     stops it: what was answered is kept, the rest marked 'stopped'
 *   onBatch    ({ done, total, record, work }) after each batch of places, to show progress or save
 * Returns { work, record, plan, stopped }: `stopped` null, or { kind, status, message } (kind as
 * GazetteerError's; 'stopped' when signalled; 'suspect' when the first batch of several queries came
 * back empty for every one, whose places are then 'unanswered', not "no match"). Anything else thrown
 * is a fault, and is thrown on, with the places not answered marked 'stopped' first.
 */
export async function runLookup({ lookup, work = null, subjects = null, places = null, options = {}, signal, onBatch, now = () => new Date().toISOString() }) {
  if (!lookup || typeof lookup.reconcile !== 'function') throw new TypeError('runLookup needs a lookup (createLookup)');
  const service = options.service || WHG_SERVICE;
  const o = { ...LOOKUP_DEFAULTS, ...defined(options) };
  if (!work) {
    if (!subjects) throw new TypeError('runLookup needs a work file or the dataset (subjects)');
    work = newWork(subjects, { now: now() });
  }
  const chosen = selectPlaces({ work, places, which: o.places, service, only: o.only });
  const plan = planQueries(chosen, { ...o, service, batchSize: lookup.batchSize ?? 25 });
  const parameters = { places: o.places ?? defaultChoice(work), allNames: !!o.allNames, limit: o.limit, countries: !!o.countries, nearKm: o.nearKm ?? null, maxDistanceKm: o.maxDistanceKm, type: plan.queries[0]?.type ?? null, linksKnown: !!places };
  const record = startLookup(work, { service, parameters, plan, now: now() });
  const stopRest = (from) => {
    for (const chunk of plan.chunks.slice(from)) for (const p of chunk.places) if (record.queries[p.iri].state === 'pending') { record.queries[p.iri].state = 'stopped'; record.counts.stopped++; }
    record.finished_at = now();
  };
  let done = 0;
  for (let i = 0; i < plan.chunks.length; i++) {
    const chunk = plan.chunks[i];
    let answers;
    try {
      if (signal?.aborted) throw signal.reason ?? new Error('stopped');
      answers = await lookup.reconcile(chunk.queries, { signal });
    } catch (e) {
      stopRest(i);
      if (signal?.aborted) record.stopped = { kind: 'stopped', status: null, message: null };
      else if (e?.name === 'GazetteerError') record.stopped = { kind: e.kind, status: e.status ?? null, message: e.message };
      else throw e;
      return { work, record, plan, stopped: record.stopped };
    }
    record.attribution = mergeAttribution(record.attribution, answers.attribution);
    if (i === 0 && suspect(chunk, answers)) {
      for (const p of chunk.places) { Object.assign(record.queries[p.iri], { state: 'unanswered', suspect: true }); record.counts.unanswered++; }
      stopRest(1);
      record.stopped = { kind: 'suspect', status: null, message: null };
      return { work, record, plan, stopped: record.stopped };
    }
    let at = 0;
    const stamp = now();
    try {
      for (const p of chunk.places) {
        const k = record.queries[p.iri].sent.length;
        mergeAnswers(work, record, p, answers.slice(at, at + k), { now: stamp, maxDistanceKm: o.maxDistanceKm, scrub: o.scrub, scoped: o.nearKm > 0 && Array.isArray(p.point) });
        at += k;
      }
    } catch (e) {
      stopRest(i);
      record.stopped = { kind: 'fault', status: null, message: null };
      throw e;
    }
    done += chunk.places.length;
    onBatch?.({ done, total: plan.preview.places, record, work });
  }
  record.finished_at = now();
  return { work, record, plan, stopped: null };
}
