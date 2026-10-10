// Looking places up in a gazetteer, by the W3C reconciliation protocol (version 0.2, as OpenRefine
// speaks it): a batch of name queries in, a list of candidate places for each out; data extension
// (`extend`) for more about chosen candidates; the service's manifest (`manifest`); and, from WHG, a
// whole record by itself (`entity`), since a candidate carries no geometry and no dates. Shared by
// Chora (where a place is) and Krisis (which place it is). Everything particular to the World
// Historical Gazetteer, and what is and is not verified about it, is in whg.js (A1 to A11 there).
//
// Pure engine code: no page. It runs in a Web Worker and in Node, and is given `fetch` so that tests
// can stand in for the service. The only thing it keeps is the pacer's ledger (below).
//
// - One request in flight to a service, whoever asks (WHG has 16 slots for the whole site, fans each
//   batch out itself, and has answered 503 under load). Within one page or worker, createLookup gives
//   ONE lookup per endpoint, so two tools or callers share its queue and take turns: a request, with
//   its retries and the pauses between them, is finished before the next one in the page starts.
//   Across tabs and workers, where the platform has Web Locks (browsers, and Node 24, which this repo
//   needs), each TRY of a request is made holding an exclusive lock named after the service's site:
//   'plato-tools:gazetteer:whgazetteer.org' for WHG however its host is written, else the host
//   without a leading 'www.'. Held: the pacer's reading and writing of its ledger (and any wait it
//   asks for), the request, and the reading of its answer. Not held: the pause before a retry (after
//   a 429, a 5xx or no answer), in which another tab or worker may make its own request. `shared:
//   false` gives a lookup of its own (for tests), which still takes the lock.
// - A pacer keeps within WHG's rates: never more than 600 queries in any 60 seconds, nor more than
//   60 record requests (A3, A10). WHG's window is fixed; any-60-seconds is stricter. What the pacer
//   has sent is kept in a LEDGER (times and counts per site, nothing else), read and written only
//   while holding the site's lock. Where there is IndexedDB (a page or a worker), the ledger is kept
//   there, so every tab and worker of this origin counts against ONE allowance: with both Web Locks
//   and IndexedDB, all of them together stay within the rates. If IndexedDB cannot be read, refuses,
//   or leaves opening or a transaction unanswered for `ledgerTimeoutMs` (5 seconds), the lookup warns
//   once and counts in memory from then on. An entry dated later than now (the clock was stepped
//   back) is counted as sent now, so it never makes a wait longer than the window. Without IndexedDB (Node) the ledger
//   is the lookup's own, and so is the allowance; without Web Locks, lookups in different tabs are
//   neither serialised nor jointly paced. Other origins, and other programs using the same token,
//   are not counted at all: WHG's 429 is still handled.
// - A request that has not answered within `timeoutMs` (60 seconds) is abandoned and counts as no
//   answer (tried again as below), so a hung request holds the lock for at most that long (plus the
//   pacer's wait) per try.
// - Queries go in batches (25 by default, never more than 50), and a batch holds queries of one
//   type only (A4). Each batch names its queries q0, q1, …, and the answers are put back in the order
//   the queries were given.
// - The token goes in the Authorization header and nowhere else: not in an address, not in a
//   message, not on an error, not in the ledger. What the service says back (a failure's detail, a
//   query's `.error`) is cleaned of the current token and the last 8 it replaced. A request reads the
//   token once, when it is first sent, and its retries send the same one; a change of token takes
//   effect from the next request (for reconcile and extend, the next batch).
// - 429 (too many queries), and 502, 503, 504 or no answer at all, are tried again after a pause:
//   the service's Retry-After when it can be read (capped; a page cannot read it from WHG, A6),
//   else a growing one; the lock is let go for the pause. 401, 403 and 451 are final at once: a
//   token refused, a day's allowance spent or a source's terms will not change by asking again, and
//   WHG blocks clients that keep asking.
// - A request the page's permissions would not let go (the injected fetch threw a PermissionError,
//   src/lib/permissions.js) is final at once too, and is not counted as no answer: the job ends with
//   kind 'refused', the lock and the queue are let go, and the jobs behind it run as usual (each is
//   refused in its turn while the permission stays as it is). Told by the error's `name ===
//   'PermissionError'`, or by `retry === false` on any error a fetch wrapper throws; a PermissionError
//   of kind 'network' (fetch failing beneath the module: the service was not reached) is no answer,
//   and tried again, unless it says `retry: false`. A refused request was not sent, so the pacer's
//   charge for it is taken back from the ledger before the lock is let go; except kind 'moved' (the
//   request WAS sent and answered with a redirect, whose answer was not used), which stays counted.
// - An AbortSignal stops a lookup: its request in flight, its pause between tries or for the pacer,
//   its wait for the lock, and its requests still waiting their turn.
import {
  isWhg, whgIri, reprPoint, candidateCcodes, answerStatus, mergeAttribution, namespaceOf, entityRequest,
  isBlockedAgent, isQuotaSpent, whgQueryType, WHG_BATCH_LIMIT, WHG_DEFAULT_LIMIT, WHG_ENCODING, WHG_QUERY_RATE, WHG_ENTITY_RATE,
} from './whg.js';

export {
  WHG_ENDPOINT, WHG_PLACE_TYPE, BLOCKED_AGENTS, isWhg, whgIri, normaliseWhgIri, parseCentroid, parseGeojsonValues, mergeAttribution, whgLang, nameLang,
} from './whg.js';

const DEFAULT_BATCH = 25;
const DEFAULT_TIMEOUT_MS = 60_000;
// Tokens replaced are kept this long for cleaning what the service says back: enough for a few
// changes of token (one in flight when it is replaced, a sign-out and in again), and a bound on how
// many secrets a lookup holds in memory.
const RETIRED_TOKENS = 8;
// Names the client and where to find it, as WHG asks, and avoids what its bot filter refuses (A6).
export const USER_AGENT = 'plato-tools/0.1 (+https://github.com/pelagios/plato-tools)';
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const LOCK_PREFIX = 'plato-tools:gazetteer:';

/**
 * Why a lookup failed. `kind` is:
 * - 'auth': the token was refused (401, 403);
 * - 'quota': the day's allowance of requests is spent (a 401 that says so; A3);
 * - 'rate': still too many queries after waiting (429);
 * - 'unavailable': the source does not allow the record to be passed on (451; A10);
 * - 'network': no answer, or none within the timeout;
 * - 'refused': the page's permissions would not let the request go, or would not let its answer be
 *   used (a PermissionError from fetch, or an error with `retry: false`); `refusal` is that error's
 *   `kind` ('never', 'undecided', 'reload', 'unprotected', 'address', 'moved', …), or null. For every
 *   kind but 'moved' the gazetteer was not asked ("The gazetteer was not asked: …"); 'moved' means
 *   the request WAS sent and its answer, a redirect, was not used ("The gazetteer's answer was not
 *   used: …");
 * - 'server': any other refusal or failure, and an answer that could not be read.
 * `status` is the HTTP status, or null. It carries nothing else: no request, no headers, no cause.
 */
export class GazetteerError extends Error {
  constructor(message, { status = null, kind, refusal }) {
    super(message);
    this.name = 'GazetteerError';
    this.status = status;
    this.kind = kind;
    if (kind === 'refused') this.refusal = refusal ?? null;
  }
}

/**
 * Is what fetch threw a refusal, never to be asked again (rather than no answer)? A PermissionError
 * (src/lib/permissions.js; told by its name, so that this engine imports nothing of the page) other
 * than its 'network', or any error that says `retry === false`.
 */
const isRefusal = (e) => e != null && (e.retry === false || (e.name === 'PermissionError' && e.kind !== 'network'));

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
 * Where a pacer keeps what it has sent: `read(key)` gives [{t, n}] (a time in ms and a count),
 * `write(key, entries)` replaces them. A key is a site and what is counted, e.g.
 * 'whgazetteer.org:queries'. Nothing else is stored.
 * @typedef {{read: (key: string) => Promise<{t: number, n: number}[]>, write: (key: string, entries: {t: number, n: number}[]) => Promise<void>}} Ledger
 */

const entriesOf = (v) => (Array.isArray(v) ? v : [])
  .filter((e) => e && Number.isFinite(e.t) && Number.isFinite(e.n))
  .map(({ t, n }) => ({ t, n }));

/** A ledger in this page's or worker's memory: counts for it alone. @returns {Ledger} */
export function memoryLedger() {
  const kept = new Map();
  return {
    async read(key) { return entriesOf(kept.get(key)); },
    async write(key, entries) { kept.set(key, entriesOf(entries)); },
  };
}

const DEFAULT_LEDGER_TIMEOUT_MS = 5000;
const warnCountedHere = (e) =>
  console.warn(`The gazetteer's pacing is counted in this tab only: IndexedDB could not be used (${e?.message ?? e}).`);

/** A promise's outcome, or a rejection once `ms` have passed without one. */
function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * A ledger in IndexedDB (database 'plato-tools-gazetteer', store 'pacing'), which every tab and
 * worker of this origin shares. If the database cannot be used (a private window may refuse it), or
 * opening it or a transaction on it has not answered within `timeoutMs` (5 seconds; a browser can
 * leave a request unanswered for good, and the ledger is used holding the site's lock), it says so
 * once on the console and counts in memory from then on.
 * @param {{indexedDB?: IDBFactory, name?: string, timeoutMs?: number}} [o]
 * @returns {Ledger}
 */
export function indexedDbLedger({ indexedDB = globalThis.indexedDB, name = 'plato-tools-gazetteer', timeoutMs = DEFAULT_LEDGER_TIMEOUT_MS } = {}) {
  const STORE = 'pacing';
  const limit = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_LEDGER_TIMEOUT_MS;
  let db = null, fallback = null;
  const open = () => (db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    // A connection that arrives after the ledger has given up on it is closed.
    req.onsuccess = () => { if (fallback) req.result?.close?.(); resolve(req.result); };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('the pacing database is blocked'));
  }));
  const run = async (mode, act) => {
    const conn = await within(open(), limit, 'opening the pacing database');
    return within(new Promise((resolve, reject) => {
      const tx = conn.transaction(STORE, mode);
      const req = act(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('aborted'));
    }), limit, 'the pacing database');
  };
  const fallBack = (e) => {
    if (!fallback) {
      warnCountedHere(e);
      fallback = memoryLedger();
    }
    return fallback;
  };
  return {
    async read(key) {
      if (fallback) return fallback.read(key);
      try { return entriesOf(await run('readonly', (s) => s.get(key))); } catch (e) { return fallBack(e).read(key); }
    },
    async write(key, entries) {
      if (fallback) return fallback.write(key, entries);
      try { await run('readwrite', (s) => s.put(entriesOf(entries), key)); } catch (e) { await fallBack(e).write(key, entries); }
    },
  };
}

// One IndexedDB ledger per IDBFactory, for every lookup of this page or worker (the first one's
// timeout stands).
const idbLedgers = new WeakMap();
let warnedNoIndexedDb = false;
function defaultLedger(timeoutMs) {
  let idb;
  // Reading it can throw (Firefox with storage blocked): counted here, said once.
  try { idb = globalThis.indexedDB; } catch (e) {
    if (!warnedNoIndexedDb) { warnedNoIndexedDb = true; warnCountedHere(e); }
    return memoryLedger();
  }
  if (!idb) return memoryLedger();
  if (!idbLedgers.has(idb)) idbLedgers.set(idb, indexedDbLedger({ indexedDB: idb, timeoutMs }));
  return idbLedgers.get(idb);
}

/**
 * At most `limit` units (queries, requests) in any `windowMs`. `take(n)` waits until n more fit, and
 * gives the entry it wrote ({t, n}); `refund(entry)` removes that entry again (a request not sent).
 * What has been sent is read from and written to `ledger` under `key`, each time: a caller who
 * shares the ledger with other contexts must call take() holding a lock they share too.
 * @param {{limit: number, windowMs: number, now?: () => number, sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   ledger?: Ledger, key?: string}} o
 */
export function createPacer({ limit, windowMs, now = Date.now, sleep = abortableSleep, ledger = memoryLedger(), key = 'pacer' }) {
  return {
    async take(n, signal) {
      if (n > limit) throw new RangeError(`${n} is more than the pacer allows in one window (${limit})`);
      for (;;) {
        const t = now();
        // An entry later than now was written before the clock was stepped back: it is taken as
        // sent now, and kept so, so that it is counted but never makes a wait longer than the window.
        const read = await ledger.read(key);
        const ahead = read.some((e) => e.t > t);
        const sent = read.map((e) => (e.t > t ? { t, n: e.n } : e))
          .filter((e) => e.t > t - windowMs).sort((a, b) => a.t - b.t);
        const used = sent.reduce((a, e) => a + e.n, 0);
        if (used + n <= limit) { const entry = { t, n }; sent.push(entry); await ledger.write(key, sent); return { ...entry }; }
        if (ahead) await ledger.write(key, sent);
        // Wait until enough of the oldest have left the window.
        let freed = 0, until = t;
        for (const e of sent) {
          freed += e.n; until = e.t + windowMs;
          if (used - freed + n <= limit) break;
        }
        await sleep(Math.max(1, until - t), signal);
      }
    },
    // Takes back what take() charged (the entry it returned), for a request that was never sent.
    async refund(entry) {
      if (!entry) return;
      const read = await ledger.read(key);
      const i = read.findIndex((e) => e.t === entry.t && e.n === entry.n);
      if (i < 0) return;
      read.splice(i, 1);
      await ledger.write(key, read);
    },
  };
}

// The lookups of this page or worker, one per endpoint: {lookup, options (the first call's), fetch
// (the one it uses), warned}.
const shared = new Map();
// Options that are not the lookup's configuration, so never a cause to warn (fetch: a cause to throw).
const NOT_CONFIG = new Set(['endpoint', 'token', 'shared', 'fetch']);

/**
 * The lookup against one reconciliation service: the SAME one for every call with the same endpoint
 * (written in any way that is the same address; for WHG, with or without www.) within this page or
 * worker, so that its requests are made one at a time whoever asks.
 * - A later call with a token changes the token of the shared lookup, for every caller; `token: null`
 *   (or '') clears it, and requests go without Authorization from then on; an absent or undefined
 *   token leaves it. `lookup.setToken(t)` and `lookup.clearToken()` do the same. A tool should read
 *   the token from its one keeper (`permissions.token` in src/lib/permissions.js: token.get(), and
 *   token.onChange for a change) and pass it on each call, or on a change, rather than keep a copy
 *   of its own: two copies would take turns being sent.
 * - A later call whose `fetch` is not the one the lookup uses (by identity; the platform's fetch if
 *   the first call gave none) is refused with a TypeError, and changes nothing: on a page that fetch
 *   is permissions.fetch, and a caller that passed another would believe its requests went through
 *   it. Every page caller passes permissions.fetch; a later call that gives no fetch uses the lookup's.
 * - Every other option is the first call's: a later call's differing values (batchSize, rates, …)
 *   are ignored, as a second queue is what is to be avoided, and console.warn names each such option
 *   once per endpoint. A later call is still refused a blocked User-Agent, a missing endpoint, and a
 *   fetch, locks or ledger of the wrong kind.
 * - `shared: false` makes a lookup of its own, apart from the shared one (for tests).
 * @param {object} o
 * @param {string} o.endpoint  the service's address, e.g. WHG_ENDPOINT
 * @param {string|null} [o.token]  sent as `Authorization: Bearer`, and only so; null clears it
 * @param {typeof fetch} [o.fetch]  on a page, permissions.fetch with cat 'gazetteer'; a PermissionError
 *   it throws ends the request at once as kind 'refused' (above)
 * @param {number} [o.batchSize]  queries per request, 1 to 50 (default 25)
 * @param {boolean} [o.shared]  true (the default): the one lookup for this endpoint
 * @param {{request: Function}|null} [o.locks]  a Web Locks LockManager (default
 *   globalThis.navigator?.locks; null for none): each try of a request (pacing, request, answer) is
 *   made holding the exclusive lock 'plato-tools:gazetteer:<site>', so that tabs and workers take
 *   turns too; the pause before a retry is not
 * @param {Ledger|null} [o.ledger]  where the pacer counts (default: IndexedDB where there is one, so
 *   that tabs and workers share one allowance; else this lookup's memory)
 * @param {number} [o.timeoutMs]  how long one try of a request may take (60000)
 * @param {number} [o.ledgerTimeoutMs]  how long the default IndexedDB ledger waits for the database
 *   to open or a transaction to finish before counting in memory instead (5000)
 * Optional, beyond the agreed interface: `userAgent` (sent where the platform allows; browsers may
 * drop it; one WHG's bot filter would refuse is refused here), `encoding` ('json', the default, or
 * 'form' for a service that takes only `queries=`), `defaultLimit` (candidates asked for when a
 * query does not say; 10), `iri(id)` (a candidate's address; for WHG, its w3id), `entityBase` (where
 * records are fetched; WHG's by default), `queryRate` and `entityRate` ({limit, windowMs}, or null
 * for none), `now()` and `sleep(ms, signal)` (for tests), `maxRetries` (5) and `maxRetryAfter`
 * (seconds a pause may last, 60).
 */
export function createLookup(options = {}) {
  const o = options ?? {};
  const { endpoint, userAgent = USER_AGENT, shared: isShared = true } = o;
  if (typeof endpoint !== 'string' || !endpoint) throw new TypeError('createLookup needs an endpoint');
  if (userAgent && isBlockedAgent(userAgent)) throw new TypeError(`WHG refuses the User-Agent "${userAgent}" as a bot`);
  checkKinds(o);
  if (!isShared) return makeLookup(o);
  const key = sameAddress(endpoint);
  const found = shared.get(key);
  if (found) {
    // Fail closed: a caller is never given a lookup that sends through a fetch other than its own.
    if (o.fetch !== undefined && o.fetch !== found.fetch) {
      throw new TypeError(`createLookup: the ${isWhg(endpoint) ? 'WHG' : siteOf(endpoint)} lookup on this page already uses another fetch; pass permissions.fetch`);
    }
    if (o.token !== undefined) found.lookup.setToken(o.token);
    const differ = Object.keys(o).filter((k) => !NOT_CONFIG.has(k) && o[k] !== undefined && !found.warned.has(k) && !sameOption(k, found.options[k], o[k]));
    if (differ.length) {
      differ.forEach((k) => found.warned.add(k));
      console.warn(`createLookup: a later call for ${siteOf(endpoint)} gave ${differ.join(', ')} unlike the first call; the first call's stand, as there is one lookup per endpoint.`);
    }
    return found.lookup;
  }
  const lookup = makeLookup(o);
  const { token: _secret, ...kept } = o;
  shared.set(key, { lookup, options: kept, fetch: o.fetch ?? globalThis.fetch, warned: new Set() });
  return lookup;
}

function checkKinds({ fetch: f, locks, ledger, token }) {
  if (f !== undefined && typeof f !== 'function') throw new TypeError('fetch must be a function');
  if (locks != null && typeof locks.request !== 'function') throw new TypeError('locks must be a LockManager');
  if (ledger != null && (typeof ledger.read !== 'function' || typeof ledger.write !== 'function')) throw new TypeError('ledger must have read and write');
  if (token != null && typeof token !== 'string') throw new TypeError('token must be a string, or null to clear it');
}

// Options that are things with behaviour (a ledger, a LockManager, fetch), not values: the same only
// if the same object. JSON would see two memoryLedger()s alike, as {}.
const BY_IDENTITY = new Set(['fetch', 'locks', 'ledger', 'now', 'sleep', 'iri']);
function sameOption(k, a, b) {
  if (a === b) return true;
  if (BY_IDENTITY.has(k)) return false;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return false;
}

/** A site's name, for its lock and its ledger: whgazetteer.org for WHG, else the host without 'www.'. */
function siteOf(endpoint) {
  if (isWhg(endpoint)) return 'whgazetteer.org';
  try { return new URL(endpoint.trim()).host.replace(/^www\./, ''); } catch { return endpoint.trim(); }
}

/** An endpoint written one way: scheme and host in lower case, no 'www.', no fragment, no trailing slash. */
function sameAddress(endpoint) {
  try {
    const u = new URL(endpoint.trim());
    u.hash = '';
    u.hostname = u.hostname.replace(/^www\./, '');
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    return u.href;
  } catch { return endpoint.trim(); }
}

function makeLookup({
  endpoint, token: firstToken, fetch: fetchFn = globalThis.fetch, batchSize = DEFAULT_BATCH,
  userAgent = USER_AGENT, encoding = WHG_ENCODING, defaultLimit = WHG_DEFAULT_LIMIT, iri, entityBase,
  queryRate = WHG_QUERY_RATE, entityRate = WHG_ENTITY_RATE, now = Date.now, sleep = abortableSleep,
  maxRetries = 5, maxRetryAfter = 60, locks = globalThis.navigator?.locks, ledger, timeoutMs = DEFAULT_TIMEOUT_MS,
  ledgerTimeoutMs = DEFAULT_LEDGER_TIMEOUT_MS,
}) {
  if (typeof fetchFn !== 'function') throw new TypeError('createLookup needs fetch');
  const size = clampBatch(batchSize);
  const whg = isWhg(endpoint);
  const perTry = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;

  // The token, and the last few it replaced, which are still cleaned from what is repeated.
  let token = null;
  const retired = [];
  const retire = (t) => {
    const i = retired.indexOf(t);
    if (i >= 0) retired.splice(i, 1);
    retired.push(t);
    if (retired.length > RETIRED_TOKENS) retired.shift();
  };
  function setToken(t) {
    if (t == null || t === '') return clearToken();
    if (typeof t !== 'string') throw new TypeError('token must be a string, or null to clear it');
    if (t === token) return;
    if (token) retire(token);
    token = t;
    const i = retired.indexOf(t);
    if (i >= 0) retired.splice(i, 1);
  }
  function clearToken() {
    if (token) retire(token);
    token = null;
  }
  setToken(firstToken);
  const scrub = (text, also) => {
    let out = String(text);
    // Longest first, so that a token which begins another does not leave the rest of it.
    const all = [token, also, ...retired].filter(Boolean).sort((a, b) => b.length - a.length);
    for (const t of all) out = out.split(t).join('[token]');
    return out;
  };

  const site = siteOf(endpoint);
  const lockName = LOCK_PREFIX + site;
  const limitDefault = Math.min(WHG_BATCH_LIMIT, Math.max(1, Math.floor(Number(defaultLimit)) || WHG_DEFAULT_LIMIT));
  const iriOf = iri ?? (whg ? whgIri : (id) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(id) ? id : null));
  const recordsFrom = entityBase ?? (whg ? endpoint : null);
  const book = ledger ?? defaultLedger(ledgerTimeoutMs);
  const queryPacer = queryRate ? createPacer({ ...queryRate, now, sleep, ledger: book, key: site + ':queries' }) : null;
  const entityPacer = entityRate ? createPacer({ ...entityRate, now, sleep, ledger: book, key: site + ':entities' }) : null;

  // The shared queue: one job (one request, with its pacing and retries) runs at a time in this page
  // or worker. Each TRY of it is made holding the site's lock where there is a LockManager (send).
  const queue = [];
  let busy = false;
  function schedule(run, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const job = { run, signal, resolve, reject };
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
  // Waiting for the lock ends when the signal aborts, rejecting with its reason; the lock is let go
  // when `run` ends, however it ends.
  async function exclusive(run, signal) {
    if (!locks) return run();
    try {
      return await locks.request(lockName, signal ? { mode: 'exclusive', signal } : { mode: 'exclusive' }, () => run());
    } catch (e) {
      throw signal?.aborted ? signal.reason : e;
    }
  }

  function headers(post, tok) {
    const h = { Accept: 'application/json' };
    if (post && encoding !== 'form') h['Content-Type'] = 'application/json';
    if (tok) h.Authorization = 'Bearer ' + tok;
    if (userAgent) h['User-Agent'] = userAgent;
    return h;
  }
  // The W3C protocol names the parameter (`queries` or `extend`) and gives it JSON; WHG documents
  // the same object as a JSON body, which is what it gets by default (whg.js, A5).
  function body(name, value) {
    if (encoding === 'form') return new URLSearchParams({ [name]: JSON.stringify(value) });
    return JSON.stringify({ [name]: value });
  }

  // One try, holding the site's lock: the pacer's take (its ledger, and any wait it asks for), the
  // request, and reading its body. The lock is let go before any pause between tries.
  function attempt({ method, url, payload, pacer, cost }, tok, signal) {
    return exclusive(async () => {
      const charged = await pacer?.take(cost, signal);
      const one = trySignal(signal, perTry);
      try {
        const res = await settleOrAbort(fetchFn(url, { method, headers: headers(method === 'POST', tok), body: payload, signal: one.signal, credentials: 'omit' }), one.signal);
        // The body too, within the same time.
        const text = await settleOrAbort(res.text(), one.signal);
        return { res, text };
      } catch (e) {
        // Refused before it was sent: not counted against the allowance. Taken back still holding the
        // lock; if the ledger fails, the charge stays, which errs towards asking less. Before the check
        // for a stop: a page's wrapper (Krisis's permittedFetch) aborts the lookup with the refusal
        // before it rethrows it, so what is caught is then the signal's reason, and still a refusal.
        if (charged && isRefusal(e) && e.kind !== 'moved') await pacer.refund(charged).catch(() => {});
        if (signal?.aborted) throw signal.reason;
        return { failed: e, timedOut: one.timedOut() };
      } finally { one.done(); }
    }, signal);
  }

  async function send(request, signal) {
    // Read once: every try of this request carries the same token.
    const tok = request.auth ? token : null;
    for (let tries = 0; ; tries++) {
      const { res, text, failed, timedOut } = await attempt(request, tok, signal);
      if (failed !== undefined) {
        if (isRefusal(failed)) {
          const said = clip(scrub(String(failed.message ?? '').replace(/\s+/g, ' ').trim(), tok));
          // 'moved': sent, and answered with a redirect that was not followed.
          const lead = failed.kind === 'moved' ? "The gazetteer's answer was not used" : 'The gazetteer was not asked';
          throw new GazetteerError(`${lead}${said ? ': ' + said : '.'}`, { kind: 'refused', refusal: typeof failed.kind === 'string' ? failed.kind : null });
        }
        if (tries < maxRetries) { await sleep(backoff(tries, 1000), signal); continue; }
        const why = timedOut ? ` within ${perTry / 1000} seconds` : failed?.message ? ` (${scrub(failed.message, tok)})` : '';
        throw new GazetteerError(`The gazetteer could not be reached${why}.`, { kind: 'network' });
      }
      if (res.ok) {
        try { return JSON.parse(text); } catch {
          throw new GazetteerError('The gazetteer answered with something that is not JSON.', { status: res.status, kind: 'server' });
        }
      }
      if (RETRY_STATUS.has(res.status) && tries < maxRetries) {
        // Null in a browser talking to WHG, whose CORS does not expose Retry-After (A6).
        const asked = retryAfter(res.headers?.get?.('Retry-After'));
        // Without it, a 429 waits longer: WHG's window is a minute (A3).
        const wait = asked ?? backoff(tries, res.status === 429 ? 4000 : 1000);
        await sleep(Math.min(wait, maxRetryAfter * 1000), signal);
        continue;
      }
      const raw = detail(text);
      const said = clip(scrub(raw, tok));
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
   * A list also has `.unanswered = true` when the service refused the query (`.error` then says why,
   * cleaned of tokens), could not search for it, or left it out: an empty list then is not a finding
   * that nothing matched. WHG's `scope` (whether a contained_in region was applied) is kept as
   * `.scope`. The returned list of lists has `.attribution`: the licences of the sources searched,
   * or null.
   * @param {{key?: *, query?: string, type?: string, limit?: number, properties?: {pid: string, v: *}[],
   *   params?: object}[]} queries  `params` goes into the query as it is (WHG's contained_in, countries, …)
   * @returns {Promise<Candidate[][]>}
   */
  async function reconcile(queries, { signal, onProgress } = {}) {
    const list = Array.from(queries ?? []);
    // WHG is always sent a type, in one form, and is sent none it would refuse (A4): all are read
    // before anything is sent.
    const types = whg ? list.map((q) => whgQueryType(q?.type ?? q?.params?.type)) : null;
    const out = new Array(list.length);
    out.attribution = null;
    // One type to a batch (A4): group by type, in order of first appearance, then cut to size.
    const byType = new Map();
    list.forEach((q, i) => {
      const t = types ? types[i] : q?.type == null ? '' : JSON.stringify(q.type);
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t).push(i);
    });
    let done = 0;
    for (const indices of byType.values()) {
      for (let start = 0; start < indices.length; start += size) {
        const batch = indices.slice(start, start + size);
        const sent = {};
        batch.forEach((i, j) => { sent['q' + j] = encodeQuery(list[i], limitDefault, types?.[i]); });
        const answer = await schedule(() => post(body('queries', sent), batch.length, signal), signal);
        batch.forEach((i, j) => { out[i] = readResult(answer?.['q' + j], list[i], iriOf, scrub); });
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

  /**
   * The service's manifest (a GET of the endpoint itself, W3C protocol): its name, versions,
   * identifierSpace, defaultTypes, extend and so on, as it gives them. Anonymous: no token is sent
   * (WHG answers it without one; A1). Through the same queue, lock and pacer (counted as one query).
   */
  async function manifest({ signal } = {}) {
    const m = await schedule(() => send({ method: 'GET', url: endpoint, auth: false, pacer: queryPacer, cost: 1 }, signal), signal);
    if (!isObject(m)) throw new GazetteerError('The gazetteer answered with something that is not a manifest.', { status: 200, kind: 'server' });
    return m;
  }

  return { reconcile, extend, entity, manifest, setToken, clearToken, batchSize: size };
}

/**
 * The signal for one try of a request: the caller's, or `ms` passing, whichever comes first.
 * AbortSignal.any and AbortSignal.timeout where the platform has them, else the same by hand.
 */
function trySignal(signal, ms) {
  if (typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function') {
    const timeout = AbortSignal.timeout(ms);
    return { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, timedOut: () => timeout.aborted, done() {} };
  }
  const ac = new AbortController();
  let expired = false;
  const timer = setTimeout(() => { expired = true; ac.abort(new DOMException('The request timed out.', 'TimeoutError')); }, ms);
  const onAbort = () => ac.abort(signal.reason);
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ac.signal,
    timedOut: () => expired,
    done() { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); },
  };
}

/** A promise's outcome, or the signal's reason as soon as it aborts, even if the promise never settles. */
function settleOrAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return reject(signal.reason); }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function clampBatch(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(WHG_BATCH_LIMIT, Math.max(1, v)) : DEFAULT_BATCH;
}

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function encodeQuery(q, limitDefault, type) {
  const out = {};
  if (q?.params && isObject(q.params)) Object.assign(out, q.params);
  if (q?.query != null) out.query = String(q.query);
  if (type != null) out.type = type;
  else if (q?.type != null) out.type = q.type;
  out.limit = q?.limit ?? out.limit ?? limitDefault;
  if (Array.isArray(q?.properties) && q.properties.length) out.properties = q.properties;
  return out;
}

function readResult(obj, q, iriOf, scrub) {
  const found = isObject(obj) && Array.isArray(obj.result) ? obj.result : [];
  const list = found.filter((c) => isObject(c) && c.id != null).map((c) => candidate(c, iriOf));
  list.key = q?.key ?? null;
  const { unanswered, error, scope } = answerStatus(obj);
  if (unanswered) list.unanswered = true;
  if (error != null) list.error = scrub(error);
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

function detail(text) {
  try {
    const j = JSON.parse(text);
    let said = j?.detail ?? j?.error ?? j?.message;
    if (said != null && typeof said !== 'string') said = JSON.stringify(said);
    // A 451 names the source whose terms forbid it (A10).
    if (said != null && typeof j?.source === 'string') said += ` (source: ${j.source})`;
    if (said != null) text = said;
  } catch { /* not JSON: the text as it is */ }
  return text.replace(/\s+/g, ' ').trim();
}

// Cut after cleaning, so that no part of a token is left at the cut.
const clip = (text) => (text.length > 200 ? text.slice(0, 200) + '…' : text);

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
