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
// - To WHG only: each name's language (whg.js A13), from the name's own tag, else the dataset's language
//   (`lang`), else none, never "und"; and, for the regions of a region review, `area_only` (A12), so that
//   a region is matched only to a record with an outline, which can scope a lookup within it.
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
//   A place looked up again has its undecided candidates from that service replaced, except by a
//   name typed for one place (options.query), whose candidates are added beside them.
// - A place with no name (no label, and no name but its own address) is not looked up, and is counted:
//   its address is never sent as a query.
// - WHG is recorded by one address (WHG_ENDPOINT), however it was given (www, a trailing slash), so that
//   its lookups are told apart from another service's by comparing addresses.
// - The service's `attribution` (the licences of the sources searched) is kept as it came, a null
//   left null, on the lookup record, so the page can show each candidate's licence. No licence is ever
//   written into an attestation, and none is assumed here.
import { WHG_ENDPOINT, WHG_PLACE_TYPE, isWhg, normaliseWhgIri, mergeAttribution, whgLang } from '../gazetteer/index.js';
import { similarity, queryVariants, MAX_VARIANTS } from './names.js';
import { guard } from './guards.js';
import { WORK_VERSION, canonicalEndpoint } from './work.js';
import { linkState } from './identities.js';
import { constraintFor, selectLevel, placeState, areaOf, areaIds, storedConstraint, constraintParameters } from './regions.js';
export { authorityIris, currentIdentities } from './identities.js';
// The note an attestation on a looked-up candidate carries, here too for the tools that use this file (Chora).
export { krisisLookupNote } from '../words.js';

export const LOOKUP_ALGORITHM = 'krisis-lookup 1';
export const LOOKUP_DEFAULTS = { limit: 10, maxDistanceKm: 50, allNames: false, countries: false, nearKm: null, variants: false, lang: null, areaOnly: false };
/** Which places a lookup takes (selectPlaces). */
export const PLACE_CHOICES = ['unmatched', 'all', 'pending', 'unlinked'];
/** How many queries the preview shows exactly as they would be sent. */
export const PREVIEW_QUERIES = 20;
/** WHG's allowance of requests a day, for the preview (whg.js, A3). */
export const WHG_REQUESTS_A_DAY = 5000;
/** WHG, as the source a judgement on one of its candidates cites (identity.js gazetteerSource). */
export const WHG_SERVICE = { endpoint: WHG_ENDPOINT, title: 'World Historical Gazetteer', uri: 'https://whgazetteer.org/' };
/**
 * The type every query to WHG is sent as, always: the gazetteer module's own (it writes every form of
 * Place as "Place"), so that the preview is what WHG receives. WHG refuses an unknown type or two
 * types in one request (400), and a query without one is unsafe (confirmed from WHG's production
 * code, 30 September 2026).
 */
export { WHG_PLACE_TYPE };
/**
 * The permission a lookup of a service is made under (src/lib/permissions.js, category 'gazetteer'):
 * 'whg' for WHG, else the service's site (its origin, e.g. https://example.org), or null for an address
 * that has none. Pure: the page asks the permissions module with it.
 */
export function gazetteerPermission(endpoint) {
  if (isWhg(endpoint)) return 'whg';
  try { const u = new URL(String(endpoint)); return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null; } catch { return null; }
}
/**
 * A fetch for createLookup that makes every request through the permissions module: `ask` is its
 * fetch(url, { cat, subj, ...init }), which refuses (PermissionError) a site not allowed, not in the
 * page's policy, a redirect, and the rest. A refusal that will not change by asking again calls
 * onRefused(error), with which the page stops the lookup at once (it aborts the lookup's signal with the
 * error, which runLookup then words as 'permission'); 'network', a service that could not be reached,
 * is left to the gazetteer module's retries, as any failure to reach it is. Each request is asked under
 * the permission of its own address (gazetteerPermission), so a service's request to another site is
 * refused as not covered.
 */
export function permittedFetch(ask, onRefused) {
  return async (url, init = {}) => {
    try { return await ask(url, { cat: 'gazetteer', subj: gazetteerPermission(url), ...init }); } catch (e) {
      if (e?.name === 'PermissionError' && e.kind !== 'network') onRefused?.(e);
      throw e;
    }
  };
}
/** The type to send another service: the first of its manifest's defaultTypes, or null (none sent). */
export function typeFromManifest(manifest) {
  const t = Array.isArray(manifest?.defaultTypes) ? manifest.defaultTypes[0] : null;
  return typeof t?.id === 'string' && t.id ? t.id : null;
}
/**
 * What another service's manifest says Krisis uses, read through the lookup (lookup.manifest(), which
 * never sends a token): `type`, the first of its defaultTypes (typeFromManifest), and `template`, its
 * view.url when that is an address template with {{id}} in it. `read` is false, and both null, when
 * the manifest could not be had (the lookup then goes on without them, as before); stopping (signal)
 * is thrown on.
 */
export async function manifestSettings(lookup, { signal } = {}) {
  let m;
  try { m = await lookup.manifest({ signal }); } catch (e) { if (signal?.aborted) throw e; return { read: false, type: null, template: null }; }
  const url = m?.view?.url;
  let template = null;
  try { iriFromTemplate(url); template = url; } catch { /* not a template: none */ }
  return { read: true, type: typeFromManifest(m), template };
}
/**
 * iri(id) for createLookup, for another service whose template may be learnt after the lookup is
 * made (from its manifest): by `holder.template` when there is one, else the id when it is already
 * an address, as the gazetteer module does without a template.
 */
export function iriVia(holder) {
  return (id) => (holder.template ? iriFromTemplate(holder.template)(id) : typeof id === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(id) ? id : null);
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
  // Any of WHG's addresses is recorded as its one (canonicalEndpoint), so that two lookups of WHG are of one service.
  if (isWhg(endpoint)) return { ...WHG_SERVICE };
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
/** Are these the same service (WHG's addresses all one)? */
const sameEndpoint = (a, b) => canonicalEndpoint(a) === canonicalEndpoint(b);
/** The latest word on a place in the lookups of this service, { lookup, query }, or null if never looked up there. */
function lastQuery(work, iri, service) {
  let found = null;
  for (const l of work?.lookups || []) if (sameEndpoint(l.service.endpoint, service.endpoint) && Object.hasOwn(l.queries, iri)) found = { lookup: l, query: l.queries[iri] };
  return found;
}
/** The latest state of a place in the lookups of this service, or null if never looked up there. */
const lastState = (work, iri, service) => lastQuery(work, iri, service)?.query.state ?? null;

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
  // Krisis × Methodos: a place kept without reconciling ('filter') or left out of the dataset ('exclude') is never looked up.
  list = list.filter((p) => (work?.places?.[p.iri]?.rowState ?? p.rowState) !== 'filter' && (work?.places?.[p.iri]?.rowState ?? p.rowState) !== 'exclude');
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
// Krisis: region review. A pseudo-place's `params` (its constraint, regions.js constraintFor) are
// merged in last, over the place's own filters: the constraint is what was chosen for it.
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
  if (place.params && typeof place.params === 'object') {
    // WHG does not combine spatial filters (contained_in wins over lat/lng/radius): a constraint's one replaces the place's own.
    if (place.params.contained_in || place.params.radius !== undefined) { delete params.lat; delete params.lng; delete params.radius; }
    Object.assign(params, structuredClone(place.params));
  }
  return Object.keys(params).length ? params : null;
}
/**
 * A place's names to send: its label, then (allNames) each other name once, by how it is compared.
 * Its address is not a name (gather() gives a place without a label its address as label): a place
 * with no other name has none to send, and is not looked up.
 */
function namesToSend(place, allNames, variants = false) {
  const all = [place.label, ...(place.names || [])].filter((n) => typeof n === 'string' && n.trim() && n.trim() !== place.iri);
  if (!all.length) return [];
  const chosen = allNames ? all : [all[0]];
  // A name's language tag, as the dataset gives it (gather()); a form made from a name is in its language.
  const tagOf = (n) => (place.langs && Object.hasOwn(place.langs, n) ? place.langs[n] : null);
  const seen = new Set(), out = [];
  const add = (text, how, tag) => { const k = String(text).trim().toLowerCase(); if (k && !seen.has(k)) { seen.add(k); out.push({ text, how, tag }); } };
  if (!variants) { for (const n of chosen) add(n, 'given', tagOf(n)); return out; }
  // Krisis × Methodos: each name's forms (queryVariants), each a query of its own, at most MAX_VARIANTS a
  // place; the head words of all the names after every other form, so that they are the first cut.
  const forms = chosen.map((n) => queryVariants(n).map((v) => ({ ...v, tag: tagOf(n) })));
  for (const f of forms) for (const v of f) if (v.how !== 'head-word') add(v.text, v.how, v.tag);
  for (const f of forms) for (const v of f) if (v.how === 'head-word') add(v.text, v.how, v.tag);
  return out.slice(0, MAX_VARIANTS);
}

/**
 * The queries for `places`, and a preview of them. options: allNames, limit (10), countries (false),
 * nearKm (null), batchSize (the lookup's: 25), service, type (another service's: manifestSettings();
 * WHG's is always WHG_PLACE_TYPE), and to WHG only: lang (the dataset's language, for a name with no
 * tag of its own) and areaOnly (only records with an outline: a region review's regions). Returns { queries,
 * chunks, preview }: `queries` [{ key: [iri, name], query, limit, type?, params? }] in place order;
 * `chunks` the places in groups whose queries fill one batch (a place's queries are never split
 * across groups, so a place is answered all at once); `preview` { places, queries, requests,
 * allNames, filters: ['countries'|'near'], sendsCoordinates, nearKm, withoutCountries, withoutPoint,
 * withoutName (places with no name to send, which are left out: `places` does not count them),
 * withoutLanguage (WHG's queries sent with no language), lang (the dataset's, as sent, or null), areaOnly, first:
 * [the first PREVIEW_QUERIES queries as they are sent] }.
 */
export function planQueries(places, options = {}) {
  const o = { ...LOOKUP_DEFAULTS, batchSize: 25, service: WHG_SERVICE, ...defined(options) };
  const whg = isWhg(o.service.endpoint);
  const type = whg ? WHG_PLACE_TYPE : o.type || undefined;
  const datasetLang = whg ? whgLang(o.lang) : null, areaOnly = whg && !!o.areaOnly;
  const queries = [], chunks = [];
  let chunk = null, withoutCountries = 0, withoutPoint = 0, withoutName = 0, withoutLanguage = 0, looked = 0;
  for (const place of places) {
    const names = namesToSend(place, o.allNames, o.variants);
    if (!names.length) { withoutName++; continue; }
    looked++;
    const params = filtersOf(place, o);
    if (o.countries && !params?.countries) withoutCountries++;
    if (o.nearKm > 0 && params?.radius === undefined) withoutPoint++;
    const mine = names.map(({ text, how, tag }) => {
      // WHG only: the name's own language, else the dataset's; none rather than "und" (whg.js A13).
      const lang = whg ? whgLang(tag) ?? datasetLang : null;
      if (whg && !lang) withoutLanguage++;
      const own = { ...(params || {}), ...(areaOnly ? { area_only: true } : {}), ...(lang ? { lang } : {}) };
      return { key: [place.iri, text], query: text, how, limit: o.limit, ...(type ? { type } : {}), ...(Object.keys(own).length ? { params: own } : {}) };
    });
    queries.push(...mine);
    if (!chunk || (chunk.queries.length && chunk.queries.length + mine.length > o.batchSize)) chunks.push(chunk = { places: [], queries: [] });
    chunk.places.push(place); chunk.queries.push(...mine);
  }
  const requests = chunks.reduce((n, c) => n + Math.ceil(c.queries.length / o.batchSize), 0);
  const filters = [...(o.countries ? ['countries'] : []), ...(o.nearKm > 0 ? ['near'] : [])];
  const preview = {
    places: looked, queries: queries.length, requests, allNames: !!o.allNames, variants: !!o.variants, limit: o.limit, filters,
    sendsCoordinates: queries.some((q) => q.params?.radius !== undefined), withoutCountries, withoutPoint, withoutName, withoutLanguage, lang: datasetLang, areaOnly,
    nearKm: o.nearKm > 0 ? Math.min(MAX_RADIUS_KM, o.nearKm) : null,
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
    subjects, others: null, places: {}, regions: {}, candidates: [], reviewer, cursor: 0, lookups: [] };
}
const placeRecord = (p, work) => ({ label: p.label, names: p.names || [p.label], point: p.point ?? null, ...(p.ccodes ? { ccodes: p.ccodes } : {}), ...(p.types ? { types: p.types } : {}),
  ...(typeof p.within === 'string' && Object.hasOwn(work?.regions || {}, p.within) ? { within: p.within, level: p.level } : {}) });
/** Is this key one of the review's regions (work.js, version 3), not a place? */
const isRegionKey = (work, key) => Object.hasOwn(work.regions || {}, key);
const SKIPS = ['noIri', 'linked', 'denied', 'decided', 'duplicate'];
function emptyCounts() {
  return { places: 0, withoutName: 0, queries: 0, requests: 0, answered: 0, notFound: 0, unanswered: 0, stopped: 0, found: 0, added: 0, far: 0, skipped: Object.fromEntries(SKIPS.map((k) => [k, 0])) };
}
/** A new lookup record, added to the work file, with every place 'pending'. */
export function startLookup(work, { service, parameters, plan, now = new Date().toISOString() }) {
  let n = work.lookups.length + 1;
  while (work.lookups.some((l) => l.id === `l${n}`)) n++;
  const queries = {};
  for (const p of plan.chunks.flatMap((c) => c.places)) {
    if (!isRegionKey(work, p.iri) && !Object.hasOwn(work.places, p.iri)) work.places[p.iri] = placeRecord(p, work);
    const mine = plan.queries.filter((q) => q.key[0] === p.iri);
    queries[p.iri] = { state: 'pending', sent: mine.map((q) => q.query), ...(p.constraint ? { constraint: storedConstraint(p.constraint) } : {}) };
    // Krisis × Methodos: with variants asked for, how each query was made from the place's names.
    if (mine.some((q) => q.how && q.how !== 'given')) queries[p.iri].variants = mine.map((q) => ({ text: q.query, how: q.how || 'given' }));
  }
  const record = { id: `l${n}`, service, started_at: now, finished_at: null, algorithm_version: LOOKUP_ALGORITHM, parameters,
    attribution: null, counts: { ...emptyCounts(), places: plan.preview.places, withoutName: plan.preview.withoutName || 0, queries: plan.preview.queries, requests: plan.preview.requests }, stopped: null, queries };
  work.lookups.push(record);
  return record;
}

/**
 * Add one place's answers to the work file. `lists` are the module's answers to that place's queries,
 * in the order sent (each with `.unanswered`, `.error`); `place` the place, with `identities` (what
 * its dataset currently says, identities.js) if known. The place is 'answered' when every query was, else 'unanswered' (to try again,
 * never "no match"); only an answered place has its earlier undecided candidates from this service
 * replaced, unless `adds` (a name typed for one place: what it finds is added beside them, an address
 * already among them not twice). Returns the place's query record.
 */
export function mergeAnswers(work, record, place, lists, { now = new Date().toISOString(), maxDistanceKm = record.parameters?.maxDistanceKm ?? LOOKUP_DEFAULTS.maxDistanceKm, scoped = false, adds = false } = {}) {
  const iri = place.iri, c = record.counts, q = record.queries[iri] || (record.queries[iri] = { state: 'pending', sent: lists.map((l) => l.key?.[1]).filter(Boolean) });
  // Krisis: region review. A region's answers are kept under its key, in `regions`, never as a place.
  if (!isRegionKey(work, iri) && !Object.hasOwn(work.places, iri)) work.places[iri] = placeRecord(place, work);
  // The service's word on a spatial filter (WHG's scope), kept; and a filter it could not apply that so
  // answered nothing (applied false, no candidates) FAILED CLOSED: not answered, never "no match".
  const scope = lists.find((l) => l.scope && typeof l.scope === 'object')?.scope;
  if (scope) q.scope = { applied: scope.applied === true, approximate: scope.approximate === true }; else delete q.scope;
  const closed = lists.filter(failedClosed);
  if (closed.length) { q.failedClosed = true; c.failedClosed = (c.failedClosed || 0) + 1; } else delete q.failedClosed;
  const unanswered = lists.filter((l) => l.unanswered || failedClosed(l));
  // The state is set last, so that a fault part-way leaves the place as it was ('pending', then 'stopped').
  const state = unanswered.length ? 'unanswered' : 'answered';
  // A query the service refused (a malformed filter, say) inside a good answer, with the service's
  // words: the gazetteer module has already cleaned them of the token (and of the ones it replaced).
  const errors = unanswered.map((l) => l.error).filter((e) => e != null);
  if (errors.length) { q.refused = true; q.error = errors.join('; '); }
  else { delete q.refused; delete q.error; }
  // A filter by distance sent and not applied (WHG says so in `scope.applied`): the answer is not filtered.
  if (scoped && lists.some((l) => !l.unanswered && !failedClosed(l) && l.scope?.applied !== true)) { q.scopeNotApplied = true; c.scopeNotApplied = (c.scopeNotApplied || 0) + 1; }
  else delete q.scopeNotApplied;
  // One entry per address, from the query that ranked it best, a head-word query's only when no other
  // found it (Krisis × Methodos). WHG's guard (guards.js) is judged in that query's answer, which
  // only there is whole: whether it is withheld, its Dice, and (the top) whether it is tied.
  const byIri = new Map(), noIri = new Set();
  const howOf = (j) => q.variants?.[j]?.how ?? 'given';
  const forms = (q.sent || []).filter((t, j) => howOf(j) !== 'head-word');
  lists.forEach((list, j) => list.forEach((cand, rank) => {
    if (!cand.iri) { noIri.add(cand.id); return; }
    const head = howOf(j) === 'head-word';
    const had = byIri.get(cand.iri);
    const better = !had || (had.headWord && !head) || (had.headWord === head && rank + 1 < had.answer_rank);
    if (!better) return;
    const v = guard(cand, list, { forms: forms.length ? forms : [q.sent?.[j] ?? list.key?.[1]].filter(Boolean), headWord: head });
    byIri.set(cand.iri, { ...cand, answer_rank: rank + 1, query: q.sent[j] ?? list.key?.[1] ?? null, how: howOf(j), headWord: head, guardFigures: { dice: v.dice, withheld: v.withheld, tie: v.tie } });
  }));
  c.skipped.noIri += noIri.size;
  q.found = byIri.size + noIri.size;
  c.found += q.found;
  const service = record.service;
  const sameService = (x) => !localCandidate(x) && sameEndpoint(work.lookups.find((l) => l.id === x.lookup)?.service.endpoint, service.endpoint);
  if (state === 'answered' && !adds) work.candidates = work.candidates.filter((x) => !(x.candidate_source === iri && !x.decision && x.lookup !== record.id && sameService(x)));
  let added = 0, n = work.candidates.filter((x) => x.lookup === record.id).length;
  // Region review: the constraint the query was sent under, as the candidate set publishes it (matchParameters).
  const mp = constraintParameters(work, q.constraint);
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
      ...(mp ? { match_parameters: mp } : {}),
      ...(r.far ? { far: true } : {}), ccodes_agree: r.ccodes_agree,
      other: { label: g.name, names: [...new Set([g.name, ...(g.altNames || [])].filter(Boolean))], point: g.coords ?? null,
        source: { title: service.title, ...(service.uri ? { uri: service.uri } : {}) }, ...(g.ccodes ? { ccodes: g.ccodes } : {}), ...(g.types?.length ? { types: g.types.map((t) => t.name) } : {}) },
      gazetteer: { service: service.endpoint, id: g.id, score: g.score, confidence: g.confidence, match: g.match, answer_rank: g.answer_rank,
        description: g.description, namespace: g.namespace, query: g.query,
        // Krisis × Methodos: what WHG's guard needs (guards.js guardOf), judged in the answer that found it.
        dice: g.guardFigures.dice, withheld: g.guardFigures.withheld, tie: g.guardFigures.tie,
        ...(g.how !== 'given' ? { how: g.how } : {}), ...(g.headWord ? { head_word_only: true } : {}) },
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
 * The licence a lookup's attribution gives for a candidate's source, and that source's entry: its
 * namespace's; for WHG's own records (namespace null or whg), its contributed dataset's in
 * attribution.datasets, then, only with `whg`, WHG's own (attribution.whg, attribution.sources.whg).
 * An entry is taken when it names a licence or says `redistributable: false` (a dataset's as much as
 * a namespace's), so that "not to be passed on" is never lost, nor replaced by WHG's own licence.
 */
function licenceEntry(attribution, namespace, dataset, whg) {
  const pick = (x) => (x && (typeof x.license === 'string' || (x.license && typeof x.license === 'object')) ? x.license : null);
  const own = namespace && namespace !== 'whg' ? attribution?.sources?.[namespace] : null;
  if (pick(own) || (namespace && namespace !== 'whg')) return { l: pick(own), entry: own };
  const tries = [dataset != null ? attribution?.datasets?.[dataset] : null, ...(whg ? [attribution?.whg, attribution?.sources?.whg] : [])];
  for (const e of tries) if (pick(e) || e?.redistributable === false) return { l: pick(e), entry: e };
  return { l: null, entry: null };
}
/** The licence object of licenceOf() and upstreamLicence(), from what licenceEntry() found. */
function licenceFrom({ l, entry }) {
  const yes = (v) => (v === true || v === false ? v : null);
  const redistributable = yes(entry?.redistributable);
  if (!l) return redistributable === false ? { spdx: null, commercial: null, derivatives: null, redistributable } : null;
  if (typeof l === 'string') return { spdx: l, commercial: null, derivatives: null, redistributable };
  return { spdx: typeof l.spdx_id === 'string' ? l.spdx_id : null, commercial: yes(l.permits_commercial), derivatives: l.no_derivatives === true ? false : l.no_derivatives === false ? true : null, redistributable };
}
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
export const licenceOf = (attribution, namespace, dataset) => licenceFrom(licenceEntry(attribution, namespace, dataset, true));
/**
 * The licence of data COPIED from a candidate (its geometry, say): licenceOf() without the fall back to
 * WHG's own licence. The source namespace's, or for WHG's own records the contributed dataset's, else
 * null (unknown): WHG's licence covers WHG's records, not what its contributors licensed.
 */
export const upstreamLicence = (attribution, namespace, dataset) => licenceFrom(licenceEntry(attribution, namespace, dataset, false));

// ---- the run ------------------------------------------------------------------------------------------------
/**
 * A first batch of several queries that all came back empty, none refused, while something the
 * reviewer chose could have narrowed the answers: a filter, or another service's type (from its
 * manifest). Most likely that filter or type was not taken, not "nothing". WHG without a filter is never
 * suspect: what is sent it is then fixed (the label, the module's own type, which WHG takes, and the
 * limit), so there is nothing to check, and a stop would only cost a second request for the same answer.
 */
/** An answer to a filter the service could not apply, with nothing in it (WHG: scope.applied false): failed closed. */
export const failedClosed = (l) => !l.unanswered && l.length === 0 && !!l.scope && l.scope.applied === false;
// A language is not a filter (whg.js A13): it shapes how WHG reads the name, and leaves nothing out.
const filters = (params) => !!params && Object.keys(params).some((k) => k !== 'lang');
const narrowed = (chunk, service) => chunk.queries.some((q) => filters(q.params) || (q.type && !isWhg(service.endpoint)));
// A batch the service said it could not filter (failed closed) is recorded as that, not as suspect; nor
// is one where the service said, of every query, that it applied the filter (scope.applied).
const suspect = (chunk, answers, service) => chunk.queries.length > 1 && narrowed(chunk, service) && answers.every((l) => !l.unanswered && l.length === 0)
  && !answers.some(failedClosed) && !answers.every((l) => l.scope?.applied === true);
const spatial = (params) => !!params && (Array.isArray(params.contained_in) || params.radius !== undefined);
/** What makes a lookup's answers what they are, to tell whether a suspect batch is sent again unchanged. */
const SAME_ASKING = ['allNames', 'limit', 'countries', 'nearKm', 'type', 'variants', 'lang', 'areaOnly'];
/**
 * Was this place in a suspect batch of this service, asked the same way? Sending it again is the
 * reviewer's word that the empty answers are genuine, and they are then accepted.
 */
function wasSuspect(work, iri, service, parameters) {
  const last = lastQuery(work, iri, service);
  return !!last?.query.suspect && SAME_ASKING.every((k) => (last.lookup.parameters?.[k] ?? null) === (parameters[k] ?? null));
}

/**
 * The places a lookup would take and its queries, planned exactly as runLookup() plans them, in
 * requests of the lookup's own size (lookup.batchSize): the preview the page and the command line
 * show is this plan's. `options` as runLookup()'s; `query` (with one place in `only`) is sent instead
 * of the place's label, and its other names are not sent.
 */
export function planLookup({ lookup, work = null, places = null, options = {} }) {
  const service = options.service || WHG_SERVICE;
  const typed = typeof options.query === 'string' && options.query.trim() ? options.query.trim() : null;
  let chosen = selectPlaces({ work, places, which: options.places, service, only: options.only });
  // The name typed is sent in place of the label; it is compared with the candidates beside the place's own names.
  if (typed) chosen = chosen.map((p) => ({ ...p, label: typed, names: [...new Set([typed, ...(p.names || [])])] }));
  return planQueries(chosen, { ...options, ...(typed ? { allNames: false, variants: false } : {}), service, batchSize: lookup?.batchSize ?? 25 });
}

/**
 * Look places up and add what is found to the work file.
 *   lookup     a lookup from createLookup() (src/engine/gazetteer/), made with the token if any
 *   work       the work file (an object, changed in place), or null to begin one from `subjects`
 *   subjects   gather()'s record of the dataset ({ title, uri?, files }), when `work` is null
 *   places     gather()'s places, with the links the dataset states; else the work file's (links not known)
 *   options    service (serviceOf(): WHG's by default), places (PLACE_CHOICES; default defaultChoice()),
 *              only (IRIs), allNames, limit, countries, nearKm, maxDistanceKm, type (another service's:
 *              manifestSettings()), query (a name to send for the one place `only` names, instead of
 *              its label; what it finds is added to the place's candidates, replacing none)
 *   reviewer   the reviewer ({ name, orcid? }), recorded in the work file when given
 *   signal     stops it: what was answered is kept, the rest marked 'stopped'
 *   onBatch    ({ done, total, record, work }) after each batch of places, to show progress or save
 * Returns { work, record, plan, stopped }: `stopped` null, or { kind, status, message } (kind as
 * GazetteerError's; 'stopped' when signalled; 'permission', with `refused` its PermissionError's kind,
 * when the permissions module refused a request (signalled with that error, or thrown); 'suspect' when the first batch of several queries came
 * back empty for every one with a filter or another service's type in play, whose places are then
 * 'unanswered' and marked `suspect`, not "no match"; the same places asked the same way again are
 * accepted as genuinely not found). Anything else thrown
 * is a fault, and is thrown on, with the places not answered marked 'stopped' first.
 */
export async function runLookup({ lookup, work = null, subjects = null, places = null, options = {}, reviewer = null, signal, onBatch, now = () => new Date().toISOString() }) {
  if (!lookup || typeof lookup.reconcile !== 'function') throw new TypeError('runLookup needs a lookup (createLookup)');
  const given = options.service || WHG_SERVICE;
  const service = isWhg(given.endpoint) ? { ...given, endpoint: WHG_ENDPOINT } : given;
  const o = { ...LOOKUP_DEFAULTS, ...defined(options) };
  const typed = typeof o.query === 'string' && o.query.trim() ? o.query.trim() : null;
  if (typed && !(Array.isArray(o.only) && o.only.length === 1)) throw new TypeError('runLookup: a name typed (query) is for one place (only)');
  if (!work) {
    if (!subjects) throw new TypeError('runLookup needs a work file or the dataset (subjects)');
    work = newWork(subjects, { now: now(), reviewer });
  } else if (reviewer) work.reviewer = reviewer;
  const plan = planLookup({ lookup, work, places, options: { ...o, service } });
  const parameters = { places: o.places ?? defaultChoice(work), allNames: typed ? false : !!o.allNames, limit: o.limit, countries: !!o.countries, nearKm: o.nearKm ?? null, maxDistanceKm: o.maxDistanceKm, type: plan.queries[0]?.type ?? null, linksKnown: !!places, ...(typed ? { query: typed } : {}), ...(o.variants && !typed ? { variants: true } : {}),
    ...(plan.preview.lang ? { lang: plan.preview.lang } : {}), ...(plan.preview.areaOnly ? { areaOnly: true } : {}) };
  // Places of a suspect batch sent again, asked the same way: found before the new record is added.
  const confirmed = new Set(plan.chunks.flatMap((c) => c.places).filter((p) => wasSuspect(work, p.iri, service, parameters)).map((p) => p.iri));
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
      // Refused by the permissions module (permittedFetch): kind 'permission', and why (PermissionError's kind).
      const refused = [signal?.aborted ? signal.reason : null, e].find((x) => x?.name === 'PermissionError');
      if (refused) record.stopped = { kind: 'permission', refused: refused.kind, status: null, message: null };
      else if (signal?.aborted) record.stopped = { kind: 'stopped', status: null, message: null };
      else if (e?.name === 'GazetteerError') record.stopped = { kind: e.kind, status: e.status ?? null, message: e.message };
      else throw e;
      return { work, record, plan, stopped: record.stopped };
    }
    record.attribution = mergeAttribution(record.attribution, answers.attribution);
    if (i === 0 && suspect(chunk, answers, service) && !chunk.places.every((p) => confirmed.has(p.iri))) {
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
        mergeAnswers(work, record, p, answers.slice(at, at + k), { now: stamp, maxDistanceKm: o.maxDistanceKm, scoped: (o.nearKm > 0 && Array.isArray(p.point)) || spatial(p.params), adds: !!typed });
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

// ---- Krisis: region review (Methodos stages 3 and 4) ------------------------------------------------------
/**
 * Fetch the area of a region's matches (entity() of each, through the lookup's shared queue, paced
 * and one request in flight), union them (regions.js areaOf), and keep it: in `areas` for this run,
 * and on the region in the work file when it is an area or a lasting reason there is none. A record
 * the service could not give (a GazetteerError) is left out; stopping (signal) is thrown on.
 */
async function fetchArea(work, key, { entity, signal, areas }) {
  if (areas.has(key)) return areas.get(key);
  if (typeof entity !== 'function') throw new TypeError('A region review needs the lookup\'s entity() to fetch an area');
  const ids = areaIds(work, key), features = [];
  let failed = 0;
  for (const id of ids) {
    try { features.push(await entity(id, { signal })); } catch (e) { if (signal?.aborted || e?.name !== 'GazetteerError') throw e; failed++; }
  }
  const area = failed && !features.length ? { none: 'unavailable', from: ids } : areaOf(features, ids);
  areas.set(key, area);
  if (area.none !== 'unavailable') work.regions[key].area = area;
  return area;
}
/** The constraint for a key, with the area it needs fetched first; a key whose area cannot be had is constrained without it. */
async function constrained(work, key, { relax, entity, signal, areas }) {
  let c = constraintFor(work, key, { relax, areas });
  if (c.needsArea) { await fetchArea(work, c.needsArea, { entity, signal, areas }); c = constraintFor(work, key, { relax, areas }); }
  return c;
}
const pseudo = (base, c) => ({ ...base, ...(Object.keys(c.params).length ? { params: c.params } : {}), constraint: c });

/**
 * Look up the ready regions of one level, each constrained by the match of the region above it
 * (regions.js constraintFor), and add what is found to the work file under each region's key.
 *   work, level   the work file (version 3, with regions: regions.js seedRegions) and the level (1 = widest)
 *   lookup        a lookup from createLookup(); `entity` defaults to its entity()
 *   relax         a step of RELAX_NAMES, for every region looked up
 *   only          region keys: just these (in review too, to ask again)
 *   options       as runLookup()'s (limit, maxDistanceKm…); the places choice and the place filters are the review's
 * Each region's area, when needed, is fetched once (fetchArea) and kept. Batching, pacing and the one
 * request in flight are runLookup()'s and the lookup's, unchanged. Returns runLookup()'s result with
 * `looked` ([{ key, constraint }]), or { looked: [] } and no record when nothing is ready.
 */
export async function runLevel(work, level, { lookup, entity = lookup?.entity, signal, onBatch, relax, only, options = {}, reviewer = null, now } = {}) {
  const areas = new Map(), looked = [];
  for (const n of selectLevel(work, level, { only })) {
    const c = await constrained(work, n.key, { relax, entity, signal, areas });
    looked.push(pseudo({ iri: n.key, label: n.names[0], names: n.names, point: null }, c));
  }
  if (!looked.length) return { work, record: null, plan: null, stopped: null, looked: [] };
  // A region is matched only to a record with an outline (whg.js A12): a point cannot scope the lookup
  // of the places within it.
  const r = await runLookup({ lookup, work, places: looked, options: { ...options, places: 'all', countries: false, nearKm: null, only: undefined, query: undefined, areaOnly: true }, reviewer, signal, onBatch, ...(now ? { now } : {}) });
  return { ...r, looked: looked.map((p) => ({ key: p.iri, constraint: storedConstraint(p.constraint) })) };
}

/**
 * Look up the places within their regions (stage 4): those whose chain of regions is settled, each
 * constrained by the nearest matched region above it. A place whose regions are not yet settled is
 * locked, and skipped, unless `unconstrained` (then it is looked up without a constraint, and its
 * query says so). A place in no region is looked up without one. `places`: gather()'s places (with the
 * links the dataset states), else the work file's. `only`: place addresses (in review too). Returns as runLevel.
 */
export async function runPlaces(work, { lookup, entity = lookup?.entity, places = null, signal, onBatch, relax, only, unconstrained = false, options = {}, reviewer = null, now } = {}) {
  const areas = new Map(), looked = [];
  const list = places ? places : Object.entries(work.places).map(([iri, p]) => ({ iri, ...p }));
  const keep = only ? new Set(only) : null;
  for (const p of list) {
    if (keep && !keep.has(p.iri)) continue;
    const s = placeState(work, p.iri, Object.hasOwn(work.places, p.iri) ? work.places[p.iri] : p);
    if (s === 'locked' && !unconstrained) continue;
    if (s !== 'locked' && !(s === 'ready' || (keep && s === 'review'))) continue;
    const c = s === 'locked' ? { from: null, kinds: [], params: {}, relaxed: 'unconstrained' } : await constrained(work, p.iri, { relax, entity, signal, areas });
    looked.push(pseudo(p, c));
  }
  if (!looked.length) return { work, record: null, plan: null, stopped: null, looked: [] };
  const r = await runLookup({ lookup, work, places: looked, options: { ...options, places: 'all', only: undefined, query: undefined, areaOnly: false }, reviewer, signal, onBatch, ...(now ? { now } : {}) });
  return { ...r, looked: looked.map((p) => ({ key: p.iri, constraint: storedConstraint(p.constraint) })) };
}
