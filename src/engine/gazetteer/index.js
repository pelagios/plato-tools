// Looking places up in a gazetteer, by the W3C reconciliation protocol (version 0.2, as OpenRefine
// speaks it): a batch of name queries in, a list of candidate places for each out; data extension
// (`extend`) for more about chosen candidates; and, from WHG, a whole record by itself (`entity`),
// since a candidate carries no geometry and no dates. Shared by Chora (where a place is) and Krisis
// (which place it is). Everything particular to the World Historical Gazetteer, and what is and is
// not verified about it, is in whg.js (A1 to A11 there).
//
// Pure engine code: no page, no storage. It runs in a Web Worker and in Node, and is given `fetch`
// so that tests can stand in for the service.
//
// - One request at a time per lookup, whoever asks: callers share one queue, and a caller's batches
//   take their turn with everyone else's. WHG asks for this (it fans each batch out itself, and has
//   answered 503 under load).
// - A pacer on the queue keeps within WHG's rates: never more than 600 queries in any 60 seconds,
//   nor more than 60 record requests (A3, A10). WHG's window is fixed; any-60-seconds is stricter, so
//   the lookup is never the one to cross it.
// - Queries go in batches (25 by default, never more than 50), and a batch holds queries of one
//   type only (A4). Each batch names its queries q0, q1, …, and the answers are put back in the order
//   the queries were given.
// - The token goes in the Authorization header and nowhere else: not in an address, not in a
//   message, not on an error. What the service says back is cleaned of it before it is repeated.
// - 429 (too many queries), and 502, 503, 504 or no answer at all, are tried again after a pause:
//   the service's Retry-After when it can be read (capped; a page cannot read it from WHG, A6),
//   else a growing one. 401, 403 and 451 are final at once: a token refused, a day's allowance
//   spent or a source's terms will not change by asking again, and WHG blocks clients that keep
//   asking.
// - An AbortSignal stops a lookup: its request in flight, its pause between tries or for the pacer,
//   and its requests still waiting their turn.
import {
  isWhg, whgIri, reprPoint, candidateCcodes, answerStatus, mergeAttribution, namespaceOf, entityRequest,
  isBlockedAgent, isQuotaSpent, WHG_BATCH_LIMIT, WHG_DEFAULT_LIMIT, WHG_ENCODING, WHG_QUERY_RATE, WHG_ENTITY_RATE,
} from './whg.js';

export {
  WHG_ENDPOINT, BLOCKED_AGENTS, isWhg, whgIri, normaliseWhgIri, parseCentroid, parseGeojsonValues,
} from './whg.js';

const DEFAULT_BATCH = 25;
// Names the client and where to find it, as WHG asks, and avoids what its bot filter refuses (A6).
export const USER_AGENT = 'plato-tools/0.1 (+https://github.com/pelagios/plato-tools)';
const RETRY_STATUS = new Set([429, 502, 503, 504]);

/**
 * Why a lookup failed. `kind` is:
 * - 'auth': the token was refused (401, 403);
 * - 'quota': the day's allowance of requests is spent (a 401 that says so; A3);
 * - 'rate': still too many queries after waiting (429);
 * - 'unavailable': the source does not allow the record to be passed on (451; A10);
 * - 'network': no answer;
 * - 'server': any other refusal or failure, and an answer that could not be read.
 * `status` is the HTTP status, or null. It carries nothing else: no request, no headers, no cause.
 */
export class GazetteerError extends Error {
  constructor(message, { status = null, kind }) {
    super(message);
    this.name = 'GazetteerError';
    this.status = status;
    this.kind = kind;
  }
}

/**
 * A candidate for a query. NEVER accept one on `match` or `score` alone: `score` is relative within
 * one response (the top candidate is always about 100, however bad the lot), and `match` says only
 * that the name is spelt the same. `confidence` (0 to 100, the name match only; null when WHG did
 * not measure it) can be compared across queries, but says nothing of WHERE: same-named places in
 * different countries score alike. A person decides.
 * @typedef {{id: string, iri: string|null, name: string, description: string|null, score: number|null,
 *   match: boolean, confidence: number|null, namespace: string|null, altNames: string[],
 *   hasGeom: boolean|null, types: {id: string, name: string}[], coords: [number, number]|null,
 *   ccodes: string[]|null, raw: object}} Candidate
 */

/**
 * At most `limit` units (queries, requests) in any `windowMs`. `take(n)` waits until n more fit.
 * @param {{limit: number, windowMs: number, now?: () => number, sleep?: (ms: number, signal?: AbortSignal) => Promise<void>}} o
 */
export function createPacer({ limit, windowMs, now = Date.now, sleep = abortableSleep }) {
  const sent = [];
  return {
    async take(n, signal) {
      if (n > limit) throw new RangeError(`${n} is more than the pacer allows in one window (${limit})`);
      for (;;) {
        const t = now();
        while (sent.length && sent[0].t <= t - windowMs) sent.shift();
        const used = sent.reduce((a, e) => a + e.n, 0);
        if (used + n <= limit) { sent.push({ t, n }); return; }
        // Wait until enough of the oldest have left the window.
        let freed = 0, until = t;
        for (const e of sent) {
          freed += e.n; until = e.t + windowMs;
          if (used - freed + n <= limit) break;
        }
        await sleep(Math.max(1, until - t), signal);
      }
    },
  };
}

/**
 * A lookup against one reconciliation service.
 * @param {object} o
 * @param {string} o.endpoint  the service's address, e.g. WHG_ENDPOINT
 * @param {string} [o.token]  sent as `Authorization: Bearer`, and only so
 * @param {typeof fetch} [o.fetch]
 * @param {number} [o.batchSize]  queries per request, 1 to 50 (default 25)
 * Optional, beyond the agreed interface: `userAgent` (sent where the platform allows; browsers may
 * drop it; one WHG's bot filter would refuse is refused here), `encoding` ('json', the default, or
 * 'form' for a service that takes only `queries=`), `defaultLimit` (candidates asked for when a
 * query does not say; 10), `iri(id)` (a candidate's address; for WHG, its w3id), `entityBase` (where
 * records are fetched; WHG's by default), `queryRate` and `entityRate` ({limit, windowMs}, or null
 * for none), `now()` and `sleep(ms, signal)` (for tests), `maxRetries` (5) and `maxRetryAfter`
 * (seconds a pause may last, 60).
 */
export function createLookup({
  endpoint, token, fetch: fetchFn = globalThis.fetch, batchSize = DEFAULT_BATCH,
  userAgent = USER_AGENT, encoding = WHG_ENCODING, defaultLimit = WHG_DEFAULT_LIMIT, iri, entityBase,
  queryRate = WHG_QUERY_RATE, entityRate = WHG_ENTITY_RATE, now = Date.now, sleep = abortableSleep,
  maxRetries = 5, maxRetryAfter = 60,
} = {}) {
  if (typeof endpoint !== 'string' || !endpoint) throw new TypeError('createLookup needs an endpoint');
  if (typeof fetchFn !== 'function') throw new TypeError('createLookup needs fetch');
  if (userAgent && isBlockedAgent(userAgent)) throw new TypeError(`WHG refuses the User-Agent "${userAgent}" as a bot`);
  const size = clampBatch(batchSize);
  const limitDefault = Math.min(WHG_BATCH_LIMIT, Math.max(1, Math.floor(Number(defaultLimit)) || WHG_DEFAULT_LIMIT));
  const iriOf = iri ?? (isWhg(endpoint) ? whgIri : (id) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(id) ? id : null));
  const recordsFrom = entityBase ?? (isWhg(endpoint) ? endpoint : null);
  const scrub = (text) => (token ? String(text).split(token).join('[token]') : String(text));
  const queryPacer = queryRate ? createPacer({ ...queryRate, now, sleep }) : null;
  const entityPacer = entityRate ? createPacer({ ...entityRate, now, sleep }) : null;

  // The shared queue: one job (one request, with its pacing and retries) runs at a time.
  const queue = [];
  let busy = false;
  function schedule(run, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const job = { run, resolve, reject };
      const onAbort = () => {
        const i = queue.indexOf(job);
        if (i >= 0) { queue.splice(i, 1); reject(signal.reason); }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      job.detach = () => signal?.removeEventListener('abort', onAbort);
      queue.push(job);
      pump();
    });
  }
  async function pump() {
    if (busy || !queue.length) return;
    const job = queue.shift();
    busy = true;
    job.detach();
    try { job.resolve(await job.run()); } catch (e) { job.reject(e); } finally { busy = false; pump(); }
  }

  function headers(post, auth) {
    const h = { Accept: 'application/json' };
    if (post && encoding !== 'form') h['Content-Type'] = 'application/json';
    if (auth && token) h.Authorization = 'Bearer ' + token;
    if (userAgent) h['User-Agent'] = userAgent;
    return h;
  }
  // The W3C protocol names the parameter (`queries` or `extend`) and gives it JSON; WHG documents
  // the same object as a JSON body, which is what it gets by default (whg.js, A5).
  function body(name, value) {
    if (encoding === 'form') return new URLSearchParams({ [name]: JSON.stringify(value) });
    return JSON.stringify({ [name]: value });
  }

  async function send({ method, url, payload, auth, pacer, cost }, signal) {
    for (let attempt = 0; ; attempt++) {
      await pacer?.take(cost, signal);
      let res;
      try {
        res = await fetchFn(url, { method, headers: headers(method === 'POST', auth), body: payload, signal, credentials: 'omit' });
      } catch (e) {
        if (signal?.aborted) throw signal.reason;
        if (attempt < maxRetries) { await sleep(backoff(attempt, 1000), signal); continue; }
        throw new GazetteerError(`The gazetteer could not be reached${e?.message ? ` (${scrub(e.message)})` : ''}.`, { kind: 'network' });
      }
      if (res.ok) {
        const text = await res.text();
        try { return JSON.parse(text); } catch {
          throw new GazetteerError('The gazetteer answered with something that is not JSON.', { status: res.status, kind: 'server' });
        }
      }
      if (RETRY_STATUS.has(res.status) && attempt < maxRetries) {
        // Null in a browser talking to WHG, whose CORS does not expose Retry-After (A6).
        const asked = retryAfter(res.headers?.get?.('Retry-After'));
        // Without it, a 429 waits longer: WHG's window is a minute (A3).
        const wait = asked ?? backoff(attempt, res.status === 429 ? 4000 : 1000);
        await discard(res);
        await sleep(Math.min(wait, maxRetryAfter * 1000), signal);
        continue;
      }
      const raw = await detail(res);
      const said = scrub(raw);
      const kind = res.status === 401 || res.status === 403 ? (isQuotaSpent(raw) ? 'quota' : 'auth')
        : res.status === 451 ? 'unavailable' : res.status === 429 ? 'rate' : 'server';
      const lead = {
        auth: 'The gazetteer refused the token',
        quota: "The gazetteer's allowance of requests for today is spent",
        unavailable: 'The source of this record does not allow the gazetteer to pass it on',
        rate: 'The gazetteer is still refusing queries as too many, after waiting',
        server: 'The gazetteer refused or failed the request',
      }[kind];
      throw new GazetteerError(`${lead} (${res.status}${said ? ': ' + said : ''}).`, { status: res.status, kind });
    }
  }
  const post = (payload, cost, signal) => send({ method: 'POST', url: endpoint, payload, auth: true, pacer: queryPacer, cost }, signal);

  /**
   * Candidates for each query, in the order given; each list has `.key` (the query's key, or null).
   * A list also has `.unanswered = true` when the service refused the query (`.error` then says why),
   * could not search for it, or left it out: an empty list then is not a finding that nothing
   * matched. WHG's `scope` (whether a contained_in region was applied) is kept as `.scope`. The
   * returned list of lists has `.attribution`: the licences of the sources searched, or null.
   * @param {{key?: *, query?: string, type?: string, limit?: number, properties?: {pid: string, v: *}[],
   *   params?: object}[]} queries  `params` goes into the query as it is (WHG's contained_in, countries, …)
   * @returns {Promise<Candidate[][]>}
   */
  async function reconcile(queries, { signal, onProgress } = {}) {
    const list = Array.from(queries ?? []);
    const out = new Array(list.length);
    out.attribution = null;
    // One type to a batch (A4): group by type, in order of first appearance, then cut to size.
    const byType = new Map();
    list.forEach((q, i) => {
      const t = q?.type == null ? '' : JSON.stringify(q.type);
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t).push(i);
    });
    let done = 0;
    for (const indices of byType.values()) {
      for (let start = 0; start < indices.length; start += size) {
        const batch = indices.slice(start, start + size);
        const sent = {};
        batch.forEach((i, j) => { sent['q' + j] = encodeQuery(list[i], limitDefault); });
        const answer = await schedule(() => post(body('queries', sent), batch.length, signal), signal);
        batch.forEach((i, j) => { out[i] = readResult(answer?.['q' + j], list[i], iriOf); });
        if (isObject(answer)) out.attribution = mergeAttribution(out.attribution, answer.attribution);
        done += batch.length;
        onProgress?.({ done, total: list.length });
      }
    }
    return out;
  }

  /**
   * More about chosen candidates: {meta: [{id, name}], rows: {id: {property: value[]}}}. A value is
   * a string, number or boolean, or {id, name} for an entity; see whg.js (A11) for how WHG writes its
   * geometry and country values.
   * @param {string[]} ids
   * @param {(string|{id: string, settings?: object})[]} properties
   */
  async function extend(ids, properties, { signal } = {}) {
    const all = Array.from(ids ?? []);
    const props = Array.from(properties ?? []).map((p) => (typeof p === 'string' ? { id: p } : p));
    const result = { meta: [], rows: {} };
    for (let start = 0; start < all.length; start += size) {
      const sent = { ids: all.slice(start, start + size), properties: props };
      // The pacer counts queries; an extend request is counted as one.
      const answer = await schedule(() => post(body('extend', sent), 1, signal), signal);
      if (!result.meta.length && Array.isArray(answer?.meta)) result.meta = answer.meta.filter((m) => m && typeof m === 'object');
      for (const [id, row] of Object.entries(isObject(answer?.rows) ? answer.rows : {})) {
        const values = {};
        for (const [pid, vs] of Object.entries(isObject(row) ? row : {})) values[pid] = (Array.isArray(vs) ? vs : [vs]).map(decodeValue);
        result.rows[id] = values;
      }
    }
    return result;
  }

  /**
   * One WHG record, as a Linked Places Format Feature (A10): where a candidate's geometry and dates
   * are. `id` is a candidate id (place:gn:745044) or any of its addresses. Through the same queue as
   * the rest, paced apart. The token goes only with WHG's own records, never an authority's.
   */
  async function entity(id, { signal } = {}) {
    if (!recordsFrom) throw new TypeError('This gazetteer has no record endpoint');
    const req = entityRequest(id, recordsFrom);
    if (!req) throw new TypeError(`Not a WHG identifier: ${id}`);
    const feature = await schedule(() => send({ method: 'GET', url: req.url, auth: req.tokenAllowed, pacer: entityPacer, cost: 1 }, signal), signal);
    if (!isObject(feature)) throw new GazetteerError('The gazetteer answered with something that is not a record.', { status: 200, kind: 'server' });
    return feature;
  }

  return { reconcile, extend, entity, batchSize: size };
}

function clampBatch(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(WHG_BATCH_LIMIT, Math.max(1, v)) : DEFAULT_BATCH;
}

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function encodeQuery(q, limitDefault) {
  const out = {};
  if (q?.params && isObject(q.params)) Object.assign(out, q.params);
  if (q?.query != null) out.query = String(q.query);
  if (q?.type != null) out.type = q.type;
  out.limit = q?.limit ?? out.limit ?? limitDefault;
  if (Array.isArray(q?.properties) && q.properties.length) out.properties = q.properties;
  return out;
}

function readResult(obj, q, iriOf) {
  const found = isObject(obj) && Array.isArray(obj.result) ? obj.result : [];
  const list = found.filter((c) => isObject(c) && c.id != null).map((c) => candidate(c, iriOf));
  list.key = q?.key ?? null;
  const { unanswered, error, scope } = answerStatus(obj);
  if (unanswered) list.unanswered = true;
  if (error != null) list.error = error;
  if (scope) list.scope = scope;
  return list;
}

// The protocol gives id, name, score, match, type and description. The rest are WHG's (whg.js, A7);
// another service gives null (or []) for them.
function candidate(c, iriOf) {
  const id = String(c.id);
  const score = Number(c.score), confidence = Number(c.confidence);
  const types = (Array.isArray(c.type) ? c.type : c.type != null ? [c.type] : [])
    .map((t) => (typeof t === 'string' ? { id: t, name: t } : isObject(t) && t.id != null ? { id: String(t.id), name: String(t.name ?? t.id) } : null))
    .filter(Boolean);
  const altNames = (Array.isArray(c.alt_names) ? c.alt_names : [])
    .map((n) => (typeof n === 'string' ? n : isObject(n) ? n.toponym ?? n.name ?? null : null))
    .filter((n) => typeof n === 'string' && n);
  return {
    id,
    iri: iriOf(id) ?? null,
    name: typeof c.name === 'string' ? c.name : c.name != null ? String(c.name) : '',
    description: typeof c.description === 'string' ? c.description : null,
    score: c.score != null && Number.isFinite(score) ? score : null,
    match: c.match === true,
    // Absent when not measured, which is not zero (A7).
    confidence: c.confidence != null && Number.isFinite(confidence) ? confidence : null,
    namespace: typeof c.namespace === 'string' && c.namespace ? c.namespace : namespaceOf(id),
    altNames,
    hasGeom: typeof c.has_geom === 'boolean' ? c.has_geom : null,
    types,
    coords: reprPoint(c),
    ccodes: candidateCcodes(c),
    raw: c,
  };
}

function decodeValue(v) {
  if (!isObject(v)) return v;
  for (const k of ['str', 'float', 'int', 'bool', 'date']) if (k in v) return v[k];
  if ('id' in v) return { id: v.id, name: v.name ?? null };
  return v;
}

// Retry-After is seconds or an HTTP date; anything else is ignored.
function retryAfter(value) {
  if (value == null || value === '') return null;
  const s = Number(value);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

// base, 2 × base, 4 × base … up to 30 seconds, each shortened by up to a quarter at random so that
// clients do not return in step.
const backoff = (attempt, base) => Math.min(30_000, base * 2 ** attempt) * (1 - Math.random() / 4);

async function detail(res) {
  let text = '';
  try { text = await res.text(); } catch { return ''; }
  try {
    const j = JSON.parse(text);
    let said = j?.detail ?? j?.error ?? j?.message;
    if (said != null && typeof said !== 'string') said = JSON.stringify(said);
    // A 451 names the source whose terms forbid it (A10).
    if (said != null && typeof j?.source === 'string') said += ` (source: ${j.source})`;
    if (said != null) text = said;
  } catch { /* not JSON: the text as it is */ }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 200 ? text.slice(0, 200) + '…' : text;
}

async function discard(res) {
  try { await res.body?.cancel?.(); } catch { /* nothing to do */ }
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
