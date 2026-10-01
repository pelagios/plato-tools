// Hermes, place names in a text: one request to a language model's provider, with its retries.
//
// The provider adapters (anthropic.js, openai-compatible.js) are given the fetch to use: in the page,
// the permissions module's fetch, which asks only a site the user allowed, never with credentials and
// never following a redirect; in tests, a fake. No adapter ever calls the global fetch.
//
// - 429, 503 and 529 (overloaded), and no answer at all, are tried again, at most `maxTries` tries in
//   all, after the provider's Retry-After where it can be read (capped at a minute), else a growing pause.
// - Each try is abandoned after `timeoutMs` and counts as no answer.
// - A refusal by the permissions module (anything but its 'network' kind) is passed on as it is, at
//   once: asking again would not change it.
// - A provider's error body is never passed on as it is: the error says what happened in words chosen
//   by the status, followed by the provider's own message, redacted (redact.js) and cut short.

import { redact, clip } from '../redact.js';

const RETRY = new Set([429, 503, 529]);
export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_TRIES = 3;

/**
 * Why a request to a provider failed. `kind`:
 * - 'auth': the key was refused (401, 403);
 * - 'rate': still too many requests after waiting (429);
 * - 'overloaded': the provider still busy after waiting (503, 529);
 * - 'request': the request was refused as it is (400, 404, 413, 422: a model that does not exist, a
 *   text too long, a setting the model does not take);
 * - 'server': any other failure of the provider's, and an answer that could not be read;
 * - 'network': no answer, or none in time;
 * - 'refused': the model declined to answer (its stop reason says so).
 * It carries the status and the words, never the request, its headers or the answer's body.
 */
export class LlmError extends Error {
  constructor(message, { kind, status = null } = {}) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = status;
  }
}

const LEAD = {
  auth: (who) => `${who} refused the key`,
  rate: (who) => `${who} is still refusing requests as too many, after waiting`,
  overloaded: (who) => `${who} is still too busy to answer, after waiting`,
  request: (who) => `${who} refused the request`,
  server: (who) => `${who} failed the request`,
};
function kindOf(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  if (status === 503 || status === 529) return 'overloaded';
  if (status >= 400 && status < 500) return 'request';
  return 'server';
}

/** The provider's own message from an error body (Anthropic's and OpenAI's shapes), else the text. */
function detail(text) {
  try {
    const j = JSON.parse(text);
    const said = j?.error?.message ?? j?.message ?? j?.error ?? j?.detail;
    if (typeof said === 'string') return said;
    if (said != null) return JSON.stringify(said);
  } catch { /* not JSON */ }
  return String(text ?? '');
}

// Retry-After: seconds or an HTTP date; anything else, null.
function retryAfter(v) {
  if (v == null || v === '') return null;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function trySignal(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, timedOut: () => timeout.aborted };
}

/**
 * Send one request and return its answer's JSON. `fetch(url, init)` is the caller's; `route` (such as
 * { cat: 'llm', subj: 'anthropic' }) is added to init for the permissions module's fetch. `keys` are
 * removed from anything said. `who` names the provider in messages.
 */
export async function send({ fetch: f, url, init, route = {}, signal, timeoutMs = DEFAULT_TIMEOUT_MS, maxTries = DEFAULT_TRIES, sleep = abortableSleep, keys = [], who = 'The provider' }) {
  if (typeof f !== 'function') throw new TypeError('No fetch was given: the page passes the permissions module\'s fetch; nothing here uses the global one.');
  for (let tries = 1; ; tries++) {
    if (signal?.aborted) throw signal.reason;
    const one = trySignal(signal, timeoutMs);
    let res, text;
    try {
      res = await f(url, { ...init, ...route, signal: one.signal, credentials: 'omit' });
      text = await res.text();
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      if (e?.name === 'PermissionError' && e.kind !== 'network') throw e;
      if (tries < maxTries) { await sleep(Math.min(30_000, 1000 * 2 ** (tries - 1)), signal); continue; }
      const why = one.timedOut() ? ` within ${Math.round(timeoutMs / 1000)} seconds` : e?.message ? ` (${clip(redact(e.message, keys))})` : '';
      throw new LlmError(`${who} could not be reached${why}.`, { kind: 'network' });
    }
    if (res.ok) {
      try { return JSON.parse(text); } catch {
        throw new LlmError(`${who} answered with something that is not JSON.`, { kind: 'server', status: res.status });
      }
    }
    if (RETRY.has(res.status) && tries < maxTries) {
      const asked = retryAfter(res.headers?.get?.('retry-after'));
      await sleep(Math.min(asked ?? 1000 * 2 ** tries, 60_000), signal);
      continue;
    }
    const kind = kindOf(res.status), said = clip(redact(detail(text).replace(/\s+/g, ' ').trim(), keys));
    throw new LlmError(`${LEAD[kind](who)} (${res.status}${said ? ': ' + said : ''}).`, { kind, status: res.status });
  }
}
