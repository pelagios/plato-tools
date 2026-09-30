// Looking places up in a gazetteer, by the W3C reconciliation protocol (version 0.2, as OpenRefine
// speaks it): a batch of name queries in, a list of candidate places for each out, and data
// extension (`extend`) to fetch more about chosen candidates. Shared by Chora (where a place is) and
// Krisis (which place it is). What is particular to the World Historical Gazetteer is in whg.js.
//
// Pure engine code: no page, no storage. It runs in a Web Worker and in Node, and is given `fetch`
// so that tests can stand in for the service.
//
// - One request at a time per lookup, whoever asks: callers share one queue, and a caller's batches
//   take their turn with everyone else's. WHG asks for this (it fans each batch out itself, and has
//   answered 503 under load).
// - Queries go in batches (25 by default, never more than 50, WHG's limit). Each batch names its
//   queries q0, q1, …, and the answers are put back in the order the queries were given.
// - The token goes in the Authorization header and nowhere else: not in the address, not in a
//   message, not on an error. What the service says back is cleaned of it before it is repeated.
// - 429 (too many queries), and 502, 503, 504 or no answer at all, are tried again after a pause:
//   the service's Retry-After when it gives one (capped), else a growing one. 401 and 403 are
//   final at once: a token that is refused, or a day's allowance spent, will not change by asking
//   again, and WHG blocks clients that keep asking.
// - An AbortSignal stops a lookup: its request in flight, its pause between tries, and its batches
//   still waiting their turn.
import { isWhg, whgIri, reprPoint, candidateCcodes, answerStatus, WHG_BATCH_LIMIT, WHG_ENCODING } from './whg.js';

export { WHG_ENDPOINT, isWhg, whgIri, parseCentroid, parseGeojsonValues } from './whg.js';

const DEFAULT_BATCH = 25;
// Names the client and where to find it, as WHG asks (whg.js, A5).
const USER_AGENT = 'plato-tools/0.1 (+https://github.com/pelagios/plato-tools)';
const RETRY_STATUS = new Set([429, 502, 503, 504]);

/**
 * Why a lookup failed. `kind` is 'auth' (the token was refused, or the day's allowance is spent),
 * 'rate' (still too many queries after waiting), 'network' (no answer) or 'server' (any other
 * refusal or failure, and an answer that could not be read). `status` is the HTTP status, or null.
 * It carries nothing else: no request, no headers, no cause.
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
 * @typedef {{id: string, iri: string|null, name: string, description: string|null, score: number|null,
 *   match: boolean, types: {id: string, name: string}[], coords: [number, number]|null,
 *   ccodes: string[]|null, raw: object}} Candidate
 */

/**
 * A lookup against one reconciliation service.
 * @param {object} o
 * @param {string} o.endpoint  the service's address, e.g. WHG_ENDPOINT
 * @param {string} [o.token]  sent as `Authorization: Bearer`, and only so
 * @param {typeof fetch} [o.fetch]
 * @param {number} [o.batchSize]  queries per request, 1 to 50 (default 25)
 * Optional, beyond the agreed interface: `userAgent` (sent where the platform allows; browsers may
 * drop it), `encoding` ('json', the default, or 'form' for a service that takes only `queries=`),
 * `iri(id)` (a candidate's address; for WHG, its w3id), `sleep(ms, signal)`, `maxRetries` (5) and
 * `maxRetryAfter` (seconds a pause may last, 60).
 */
export function createLookup({
  endpoint, token, fetch: fetchFn = globalThis.fetch, batchSize = DEFAULT_BATCH,
  userAgent = USER_AGENT, encoding = WHG_ENCODING, iri, sleep = abortableSleep, maxRetries = 5, maxRetryAfter = 60,
} = {}) {
  if (typeof endpoint !== 'string' || !endpoint) throw new TypeError('createLookup needs an endpoint');
  if (typeof fetchFn !== 'function') throw new TypeError('createLookup needs fetch');
  const size = clampBatch(batchSize);
  const iriOf = iri ?? (isWhg(endpoint) ? whgIri : (id) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(id) ? id : null));
  const scrub = (text) => (token ? String(text).split(token).join('[token]') : String(text));

  // The shared queue: one job (one request, with its retries) runs at a time.
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

  function headers() {
    const h = { Accept: 'application/json' };
    if (encoding !== 'form') h['Content-Type'] = 'application/json';
    if (token) h.Authorization = 'Bearer ' + token;
    if (userAgent) h['User-Agent'] = userAgent;
    return h;
  }
  // The W3C protocol names the parameter (`queries` or `extend`) and gives it JSON; WHG documents
  // the same object as a JSON body, which is what it gets by default (whg.js, A4).
  function body(name, value) {
    if (encoding === 'form') return new URLSearchParams({ [name]: JSON.stringify(value) });
    return JSON.stringify({ [name]: value });
  }

  async function post(payload, signal) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchFn(endpoint, { method: 'POST', headers: headers(), body: payload, signal, credentials: 'omit' });
      } catch (e) {
        if (signal?.aborted) throw signal.reason;
        if (attempt < maxRetries) { await sleep(backoff(attempt), signal); continue; }
        throw new GazetteerError(`The gazetteer could not be reached${e?.message ? ` (${scrub(e.message)})` : ''}.`, { kind: 'network' });
      }
      if (res.ok) {
        const text = await res.text();
        try { return JSON.parse(text); } catch {
          throw new GazetteerError('The gazetteer answered with something that is not JSON.', { status: res.status, kind: 'server' });
        }
      }
      if (RETRY_STATUS.has(res.status) && attempt < maxRetries) {
        const asked = res.status === 429 ? retryAfter(res.headers?.get?.('Retry-After')) : null;
        const wait = asked ?? backoff(attempt);
        await discard(res);
        await sleep(Math.min(wait, maxRetryAfter * 1000), signal);
        continue;
      }
      const said = scrub(await detail(res));
      const kind = res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate' : 'server';
      const lead = kind === 'auth' ? 'The gazetteer refused the token'
        : kind === 'rate' ? 'The gazetteer is still refusing queries as too many, after waiting'
          : 'The gazetteer refused or failed the request';
      throw new GazetteerError(`${lead} (${res.status}${said ? ': ' + said : ''}).`, { status: res.status, kind });
    }
  }

  /**
   * Candidates for each query, in the order given; each list has `.key` (the query's key, or null).
   * A list also has `.unanswered = true` when the service said it could not search for that query
   * (WHG's `gateway`), or left it out: an empty list then is not a finding that nothing matched.
   * WHG's `scope` (whether a contained_in region was applied) is kept as `.scope`.
   * @param {{key?: *, query?: string, type?: string, limit?: number, properties?: {pid: string, v: *}[],
   *   params?: object}[]} queries  `params` goes into the query as it is (WHG's contained_in, countries, …)
   * @returns {Promise<Candidate[][]>}
   */
  async function reconcile(queries, { signal, onProgress } = {}) {
    const list = Array.from(queries ?? []);
    const out = new Array(list.length);
    for (let start = 0; start < list.length; start += size) {
      const batch = list.slice(start, start + size);
      const sent = {};
      batch.forEach((q, j) => { sent['q' + j] = encodeQuery(q); });
      const answer = await schedule(() => post(body('queries', sent), signal), signal);
      batch.forEach((q, j) => { out[start + j] = readResult(answer?.['q' + j], q, iriOf); });
      onProgress?.({ done: Math.min(start + size, list.length), total: list.length });
    }
    return out;
  }

  /**
   * More about chosen candidates: {meta: [{id, name}], rows: {id: {property: value[]}}}. A value is
   * a string, number or boolean, or {id, name} for an entity; see whg.js for how WHG writes its
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
      const answer = await schedule(() => post(body('extend', sent), signal), signal);
      if (!result.meta.length && Array.isArray(answer?.meta)) result.meta = answer.meta.filter((m) => m && typeof m === 'object');
      for (const [id, row] of Object.entries(isObject(answer?.rows) ? answer.rows : {})) {
        const values = {};
        for (const [pid, vs] of Object.entries(isObject(row) ? row : {})) values[pid] = (Array.isArray(vs) ? vs : [vs]).map(decodeValue);
        result.rows[id] = values;
      }
    }
    return result;
  }

  return { reconcile, extend, batchSize: size };
}

function clampBatch(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(WHG_BATCH_LIMIT, Math.max(1, v)) : DEFAULT_BATCH;
}

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function encodeQuery(q) {
  const out = {};
  if (q?.params && isObject(q.params)) Object.assign(out, q.params);
  if (q?.query != null) out.query = String(q.query);
  if (q?.type != null) out.type = q.type;
  if (q?.limit != null) out.limit = q.limit;
  if (Array.isArray(q?.properties) && q.properties.length) out.properties = q.properties;
  return out;
}

function readResult(obj, q, iriOf) {
  const found = isObject(obj) && Array.isArray(obj.result) ? obj.result : [];
  const list = found.filter((c) => isObject(c) && c.id != null).map((c) => candidate(c, iriOf));
  list.key = q?.key ?? null;
  const { unanswered, scope } = answerStatus(obj);
  if (unanswered) list.unanswered = true;
  if (scope) list.scope = scope;
  return list;
}

// The protocol gives id, name, score, match, type and description. coords and ccodes are WHG's
// (whg.js, A6); another service gives null for them.
function candidate(c, iriOf) {
  const id = String(c.id);
  const score = Number(c.score);
  const types = (Array.isArray(c.type) ? c.type : c.type != null ? [c.type] : [])
    .map((t) => (typeof t === 'string' ? { id: t, name: t } : isObject(t) && t.id != null ? { id: String(t.id), name: String(t.name ?? t.id) } : null))
    .filter(Boolean);
  return {
    id,
    iri: iriOf(id) ?? null,
    name: typeof c.name === 'string' ? c.name : c.name != null ? String(c.name) : '',
    description: typeof c.description === 'string' ? c.description : null,
    score: c.score != null && Number.isFinite(score) ? score : null,
    match: c.match === true,
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

// 1, 2, 4, 8 … seconds, each shortened by up to a quarter at random so that clients do not return
// in step.
const backoff = (attempt) => Math.min(30_000, 1000 * 2 ** attempt) * (1 - Math.random() / 4);

async function detail(res) {
  let text = '';
  try { text = await res.text(); } catch { return ''; }
  try {
    const j = JSON.parse(text);
    const said = j?.detail ?? j?.error ?? j?.message;
    if (said != null) text = typeof said === 'string' ? said : JSON.stringify(said);
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
