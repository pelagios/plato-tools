// Krisis: the search in Wikidata before an item is made (Issue #36, D2), and the reads that bring the
// Q-ids back (D4). Wikidata's own API, api.php on www.wikidata.org, asked anonymously (origin=*, no
// cookies) and in series, one request at a time, as its etiquette asks; each request through the fetch
// the caller gives, which on the page is permissions.fetch (lookup.js permittedFetch, under the
// permission gazetteer:wikidata) and on the command line a fetch checked the same way. Never
// wikidata.reconci.link, which answers by a redirect that the permissions refuse.
//
// For each place: wbsearchentities for its label and each other name, in the name's language (else the
// dataset's, else English, said so); then, where the place has a point, items with a point within
// `nearKm` of it (CirrusSearch nearcoord: with haswbstatement:P625); then wbgetentities for every id found,
// which gives the labels, aliases, description, classes, point and country that make each a candidate
// (wikidata.js entityCandidate). The lists come back in the shape the gazetteer module's reconcile()
// gives, so that lookup.js mergeAnswers() keeps the hits as any lookup's candidates, for the ordinary
// review: a hit decided "not this one" or "different places" is what lets the place go to the batch.
import { startLookup, mergeAnswers, LOOKUP_DEFAULTS } from './lookup.js';
import { USER_AGENT } from '../gazetteer/index.js';
import { WIKIDATA_SERVICE, ALGORITHM, QID, searchUrl, nearUrl, entitiesUrl, contribsUrl, entityCandidate, wdLang, wikidataAttribution } from './wikidata.js';

export const SEARCH_DEFAULTS = Object.freeze({ nearKm: 5, limit: 10, lang: null, maxDistanceKm: LOOKUP_DEFAULTS.maxDistanceKm });
/** The headers every request carries: what the API's etiquette asks of a client in a browser, and JSON. */
export const HEADERS = Object.freeze({ Accept: 'application/json', 'Api-User-Agent': USER_AGENT });

/** Why a request failed, as the lookup's stop records it (lookup.js runLookup's `stopped`): kind, status, message. */
export class WikidataError extends Error {
  constructor(message, { status = null, kind = 'server' } = {}) { super(message); this.name = 'WikidataError'; this.status = status; this.kind = kind; }
}
/** One GET, its JSON answer; a status that is not 200, or an answer that is not JSON, is a WikidataError. */
export async function getJson(fetch, url, { signal } = {}) {
  let r;
  try { r = await fetch(url, { method: 'GET', headers: { ...HEADERS }, signal }); }
  catch (e) { if (e?.name === 'PermissionError' || e?.name === 'AbortError' || signal?.aborted) throw e; throw new WikidataError(`Wikidata could not be reached: ${e?.message || e}`, { kind: 'network' }); }
  if (r.status === 429) throw new WikidataError('Wikidata refused the request as too many (429).', { status: 429, kind: 'rate' });
  if (r.status !== 200) throw new WikidataError(`Wikidata answered ${r.status}.`, { status: r.status, kind: 'server' });
  let j;
  try { j = await r.json(); } catch { throw new WikidataError('Wikidata\'s answer was not JSON.', { status: 200, kind: 'server' }); }
  if (j?.error) throw new WikidataError(`Wikidata refused the request: ${j.error.info || j.error.code || 'an error'}.`, { status: 200, kind: 'server' });
  return j;
}

/**
 * The requests one place's search makes, in order, before the entities are fetched: [{ kind: 'name', text, lang, url }…,
 * { kind: 'near', km, url }?]. The names are the place's label and its other names (the work file's, or gather()'s
 * with their tags, `langs`); a name's language is its tag's code (wdLang), else `lang`, else 'en'. No point, no near.
 */
export function searchRequests(place, options = {}) {
  const o = { ...SEARCH_DEFAULTS, ...options };
  const seen = new Set(), out = [];
  for (const n of [place.label, ...(place.names || [])]) {
    const t = typeof n === 'string' ? n.trim() : '';
    if (!t || t === place.iri || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    const tag = place.langs && Object.hasOwn(place.langs, t.toLowerCase()) ? place.langs[t.toLowerCase()] : null;
    const lang = wdLang(tag) ?? wdLang(o.lang) ?? 'en';
    out.push({ kind: 'name', text: t, lang, url: searchUrl(t, lang, { limit: o.limit }) });
  }
  const p = place.point;
  if (o.nearKm > 0 && Array.isArray(p) && p.length === 2 && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90) out.push({ kind: 'near', km: o.nearKm, url: nearUrl(p, o.nearKm, { limit: o.limit }) });
  return out;
}
/** What a search of these places would send, for the preview: places, names, requests (each name, a near search where there is a point, and one fetch of the entities a place). */
export function searchPreview(places, options = {}) {
  let names = 0, near = 0, withoutName = 0;
  for (const p of places) { const r = searchRequests(p, options); const n = r.filter((x) => x.kind === 'name').length; if (!n) withoutName++; names += n; near += r.length - n; }
  const looked = places.length - withoutName;
  return { places: looked, withoutName, names, near, requests: names + near + looked, nearKm: options.nearKm ?? SEARCH_DEFAULTS.nearKm, lang: wdLang(options.lang) ?? null };
}

/**
 * One place searched: the answers as lists, one for each name sent (the gazetteer module's shape: each with `.key`
 * [iri, name], `.unanswered` and `.error` when the request failed), the items found near the point added to the first
 * list (their description says so). Each id found is fetched once (wbgetentities), so that a candidate has its point
 * and classes. Returns { lists, requests: [{ kind, url, status }] }. A failed request leaves its list unanswered (the
 * place is then 'unanswered', never "no match"); a refusal (PermissionError) or a stop (signal) is thrown on.
 */
export async function searchPlace({ fetch, place, options = {}, signal } = {}) {
  const o = { ...SEARCH_DEFAULTS, ...options };
  const reqs = searchRequests(place, o);
  const made = [];
  const byName = [], found = new Map();   // id -> how it was found ('name' | 'near')
  const halt = () => { if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('stopped'), { name: 'AbortError' }); };
  for (const r of reqs) {
    halt();
    let j = null, failed = null;
    try { j = await getJson(fetch, r.url, { signal }); } catch (e) { if (e?.name !== 'WikidataError') throw e; failed = e; }
    made.push({ kind: r.kind, url: r.url, status: failed ? failed.status : 200, ...(failed ? { error: failed.message } : {}) });
    if (r.kind === 'name') {
      const ids = failed ? [] : (Array.isArray(j.search) ? j.search : []).map((x) => x?.id).filter((id) => QID.test(id || ''));
      byName.push({ name: r.text, ids, failed });
      for (const id of ids) if (!found.has(id)) found.set(id, 'name');
    } else {
      const ids = failed ? [] : (Array.isArray(j.query?.search) ? j.query.search : []).map((x) => x?.title).filter((id) => QID.test(id || ''));
      if (failed && byName.length) byName[0].failed ||= failed;
      for (const id of ids) if (!found.has(id)) found.set(id, 'near');
    }
  }
  let entities = {};
  if (found.size) {
    halt();
    const ids = [...found.keys()];
    for (let i = 0; i < ids.length; i += 50) {
      try {
        const j = await getJson(fetch, entitiesUrl(ids.slice(i, i + 50)), { signal });
        made.push({ kind: 'entities', url: entitiesUrl(ids.slice(i, i + 50)), status: 200 });
        Object.assign(entities, j.entities || {});
      } catch (e) {
        if (e?.name !== 'WikidataError') throw e;
        made.push({ kind: 'entities', url: entitiesUrl(ids.slice(i, i + 50)), status: e.status, error: e.message });
        for (const l of byName) l.failed ||= e;
      }
    }
  }
  const lang = wdLang(o.lang);
  const lists = byName.map((l, i) => {
    const cands = l.ids.map((id) => entities[id] && entityCandidate(entities[id], { lang, foundBy: 'name' })).filter(Boolean);
    if (i === 0) for (const [id, how] of found) if (how === 'near' && entities[id]) { const c = entityCandidate(entities[id], { lang, foundBy: 'near' }); if (c && !cands.some((x) => x.id === id)) cands.push(c); }
    const list = Object.assign(cands, { key: [place.iri, l.name] });
    if (l.failed) { list.unanswered = true; list.error = l.failed.message; }
    return list;
  });
  return { lists, requests: made };
}

/** The plan a search makes, in the shape lookup.js startLookup() keeps: one chunk a place, its queries the names sent. */
export function searchPlan(places, options = {}) {
  const queries = [], chunks = [];
  for (const p of places) {
    const names = searchRequests(p, options).filter((r) => r.kind === 'name');
    if (!names.length) continue;
    const mine = names.map((r) => ({ key: [p.iri, r.text], query: r.text, limit: options.limit ?? SEARCH_DEFAULTS.limit, how: 'given' }));
    queries.push(...mine);
    chunks.push({ places: [p], queries: mine });
  }
  return { queries, chunks, preview: searchPreview(places, options) };
}
/**
 * Search the places in Wikidata and add what is found to the work file, as runLookup() does for a gazetteer:
 *   fetch      the fetch each request is made through (permittedFetch on the page);
 *   work       the work file (changed in place);
 *   places     the places to search (gather()'s, with their names' tags and the links the dataset states);
 *   options    nearKm (5), limit (10), lang (the dataset's language code, or null), maxDistanceKm (50);
 *   reviewer   recorded in the work file when given; signal stops it; onBatch({ done, total, record, work }) after each place.
 * Returns { work, record, stopped }: `stopped` null, or { kind: 'stopped' | 'permission' (with `refused`) | 'rate' |
 * 'network' | 'server' | 'fault', status, message }. A place whose request failed is 'unanswered' and the search goes
 * on; three failures in a row stop it (the rest 'stopped'), as does a refusal or a 429.
 */
export async function runWikidataSearch({ fetch, work, places, options = {}, reviewer = null, signal, onBatch, now = () => new Date().toISOString() } = {}) {
  if (typeof fetch !== 'function') throw new TypeError('runWikidataSearch needs a fetch');
  if (!work) throw new TypeError('runWikidataSearch needs a work file: look the places up first, or begin a review');
  if (reviewer) work.reviewer = reviewer;
  const o = { ...SEARCH_DEFAULTS, ...options };
  const plan = searchPlan(places, o);
  const parameters = { places: 'chosen', nearKm: o.nearKm, limit: o.limit, lang: wdLang(o.lang) ?? null, maxDistanceKm: o.maxDistanceKm, allNames: true, countries: false, linksKnown: true };
  const record = startLookup(work, { service: { ...WIKIDATA_SERVICE }, parameters, plan, now: now() });
  record.algorithm_version = ALGORITHM;
  record.attribution = wikidataAttribution();
  const stopRest = (from) => {
    for (const chunk of plan.chunks.slice(from)) for (const p of chunk.places) if (record.queries[p.iri].state === 'pending') { record.queries[p.iri].state = 'stopped'; record.counts.stopped++; }
    record.finished_at = now();
  };
  let done = 0, failures = 0;
  for (let i = 0; i < plan.chunks.length; i++) {
    const [place] = plan.chunks[i].places;
    let r;
    try {
      if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('stopped'), { name: 'AbortError' });
      r = await searchPlace({ fetch, place, options: o, signal });
    } catch (e) {
      stopRest(i);
      const refused = [signal?.aborted ? signal.reason : null, e].find((x) => x?.name === 'PermissionError');
      if (refused) record.stopped = { kind: 'permission', refused: refused.kind, status: null, message: null };
      else if (signal?.aborted || e?.name === 'AbortError') record.stopped = { kind: 'stopped', status: null, message: null };
      else if (e?.name === 'WikidataError') record.stopped = { kind: e.kind, status: e.status ?? null, message: e.message };
      else { record.stopped = { kind: 'fault', status: null, message: null }; throw e; }
      return { work, record, stopped: record.stopped };
    }
    record.counts.requests += r.requests.length;
    const stamp = now();
    try { mergeAnswers(work, record, place, r.lists, { now: stamp, maxDistanceKm: o.maxDistanceKm }); }
    catch (e) { stopRest(i); record.stopped = { kind: 'fault', status: null, message: null }; throw e; }
    failures = r.lists.some((l) => l.unanswered) ? failures + 1 : 0;
    done++;
    onBatch?.({ done, total: plan.chunks.length, record, work });
    if (failures >= 3) { stopRest(i + 1); record.stopped = { kind: 'server', status: null, message: 'three places in a row could not be searched' }; return { work, record, stopped: record.stopped }; }
  }
  record.finished_at = now();
  return { work, record, stopped: null };
}

/**
 * The user's own new items since `since` (D4): [{ qid, timestamp, comment }], oldest first, every page read (uccontinue),
 * at most `maxPages` (4: 2,000 items). The user name is the one they typed; it goes to Wikidata in the request, and
 * nowhere else. Returns { items, requests }.
 */
export async function readContribs({ fetch, user, since, signal, maxPages = 4 } = {}) {
  const u = typeof user === 'string' ? user.trim() : '';
  if (!u || /@/.test(u)) throw new TypeError('readContribs needs a Wikidata user name (never an address with @ in it)');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(String(since))) throw new TypeError(`readContribs: since must be an ISO date-time, not ${since}`);
  const items = [], requests = [];
  let cont = null;
  for (let page = 0; page < maxPages; page++) {
    const url = contribsUrl(u, since, { uccontinue: cont });
    const j = await getJson(fetch, url, { signal });
    requests.push(url);
    for (const c of Array.isArray(j.query?.usercontribs) ? j.query.usercontribs : []) if (QID.test(c?.title || '')) items.push({ qid: c.title, timestamp: c.timestamp ?? null, comment: typeof c.comment === 'string' ? c.comment : '' });
    cont = j.continue?.uccontinue ?? null;
    if (!cont) break;
  }
  return { items, requests };
}
/** The entities of these ids (wbgetentities), 50 a request, as { Qn: entity }: for verifying Q-ids (wikidata.js verifyItem, matchItems). */
export async function readEntities({ fetch, ids, signal } = {}) {
  const want = [...new Set((ids || []).filter((id) => QID.test(id || '')))];
  const entities = {}, requests = [];
  for (let i = 0; i < want.length; i += 50) {
    const url = entitiesUrl(want.slice(i, i + 50));
    const j = await getJson(fetch, url, { signal });
    requests.push(url);
    Object.assign(entities, j.entities || {});
  }
  return { entities, requests };
}
