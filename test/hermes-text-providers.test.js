// Hermes, place names in a text: the provider adapters (Anthropic; any OpenAI-compatible service, such
// as Ollama), each given a FAKE fetch that records every request and answers as the provider would.
// No real key exists here and none is used: the key is a sentinel made for each run, which the tests
// look for everywhere it must not be. Nothing reaches a network: the global fetch is replaced by one
// that fails the test.
//
// Each check of an absence has its presence beside it: the key is found in its header before it is
// looked for anywhere else, and the search that finds no key in the error, the work file and the
// PLATO output is shown to find it in a leaking copy of each.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/engine/hermes/text/index.js';
import * as core from '../src/lib/permissions-core.js';
import * as permissions from '../src/lib/permissions.js';

let guardHits = 0;
globalThis.fetch = () => { guardHits++; throw new Error('network guard: a test tried to reach the network'); };
test('the network guard fails any use of the global fetch', () => {
  assert.throws(() => fetch('https://api.anthropic.com/v1/models'), /network guard/);
  assert.equal(guardHits, 1);
  guardHits = 0;
});

const KEY = `test-key-NEVER-REAL-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const CHUNK = { index: 0, start: 0, end: 30, text: 'We sailed from Gades to Ostia.', sha256: 'x' };
const noSleep = async () => {};

/** A fake fetch: `answer(url, init, n)` gives { status, json | text, headers }; every call is kept. */
function fakeFetch(answer) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const a = await answer(url, init, calls.length);
    return new Response(a.text ?? JSON.stringify(a.json ?? {}), { status: a.status ?? 200, headers: a.headers ?? { 'content-type': 'application/json' } });
  };
  f.calls = calls;
  return f;
}
const anthropicReply = (extra = {}) => ({ json: {
  id: 'msg_1', type: 'message', model: 'claude-sonnet-5-5', stop_reason: 'end_turn',
  content: [{ type: 'thinking', thinking: 'The text names two ports.', signature: 'sig' }, { type: 'text', text: JSON.stringify({ mentions: [{ text: 'Gades', prefix: 'sailed from ', suffix: ' to', start: 15, kind: 'settlement' }] }) }],
  usage: { input_tokens: 812, output_tokens: 64 }, ...extra } });
const chatReply = (extra = {}) => ({ json: {
  id: 'c1', model: 'llama3.3:70b', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"mentions":[]}' } }],
  usage: { prompt_tokens: 700, completion_tokens: 9 }, ...extra } });

// ---- constructing an adapter ---------------------------------------------------------------------
test('an adapter needs the fetch it is given (never the global one) and has no default model', async () => {
  assert.throws(() => T.anthropic({ key: KEY }), /give the fetch/);
  assert.throws(() => T.openaiCompatible({ base: 'http://localhost:11434' }), /give the fetch/);
  assert.throws(() => T.anthropic({ fetch: fakeFetch(() => ({})) }), /give the key/);
  const f = fakeFetch(() => anthropicReply());
  const a = T.anthropic({ key: KEY, fetch: f });
  await assert.rejects(a.extract(CHUNK, {}), /choose a model; there is no default/);
  assert.equal(f.calls.length, 0);
  await a.extract(CHUNK, { model: 'claude-sonnet-5-5' });
  assert.equal(f.calls.length, 1, 'control: given a model, it asks');
  assert.equal(guardHits, 0);
});

test('an OpenAI-compatible service must be given as a site: https, or http only on this computer', () => {
  const f = fakeFetch(() => chatReply());
  for (const bad of ['http://example.org', 'https://example.org/v1', 'localhost:11434', 'https://example.org/?key=x']) assert.throws(() => T.openaiCompatible({ base: bad, fetch: f }), /as a site/, bad);
  for (const good of ['http://localhost:11434', 'http://127.0.0.1:8080', 'https://llm.example.org']) assert.ok(T.openaiCompatible({ base: good, fetch: f }));
});

// ---- the shape of each request -------------------------------------------------------------------
test('Anthropic: the key in x-api-key and nowhere else, the browser header, the schema in output_config, and no sampling settings', async () => {
  const f = fakeFetch(() => anthropicReply());
  const a = T.anthropic({ key: KEY, fetch: f });
  assert.deepEqual(a.origins, ['https://api.anthropic.com']);
  const r = await a.extract(CHUNK, { model: 'claude-sonnet-5-5', language: 'la' });
  const { url, init, body } = f.calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-api-key'], KEY, 'presence: the key is in its header');
  assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.cat, 'llm'); assert.equal(init.subj, 'anthropic');
  assert.ok(!url.includes(KEY) && !init.body.includes(KEY), 'absence: not in the address or the body');
  assert.ok(!Object.entries(init.headers).some(([k, v]) => k !== 'x-api-key' && String(v).includes(KEY)), 'nor in any other header');
  for (const k of ['temperature', 'top_p', 'top_k']) assert.ok(!(k in body), `no ${k}`);
  assert.deepEqual(body.output_config, { format: { type: 'json_schema', schema: T.OUTPUT_SCHEMA } });
  assert.equal(body.output_format, undefined, 'not the deprecated field');
  assert.equal(body.system, T.systemPrompt({ language: 'la' }));
  assert.deepEqual(body.messages, [{ role: 'user', content: CHUNK.text }]);
  assert.equal(body.model, 'claude-sonnet-5-5');
  // The answer: the text blocks only (not a thinking block), usage, and the model as named.
  assert.deepEqual(JSON.parse(r.reply).mentions[0].text, 'Gades');
  assert.deepEqual(r.usage, { input: 812, output: 64 });
  assert.equal(r.truncated, false);
  assert.equal(r.settings.sampling, 'provider defaults (none sent)');
});

test('Anthropic: a reply cut off at max_tokens is marked so; a refusal is an error of its own', async () => {
  const a = T.anthropic({ key: KEY, fetch: fakeFetch(() => anthropicReply({ stop_reason: 'max_tokens' })) });
  assert.equal((await a.extract(CHUNK, { model: 'm' })).truncated, true);
  const b = T.anthropic({ key: KEY, fetch: fakeFetch(() => anthropicReply({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } })) });
  await assert.rejects(b.extract(CHUNK, { model: 'm' }), { name: 'LlmError', kind: 'refused' });
});

test('Anthropic: the models are listed from the provider, page by page, with the key in its header', async () => {
  const f = fakeFetch((url) => (new URL(url).searchParams.get('after_id')
    ? { json: { data: [{ id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' }], has_more: false, last_id: 'claude-haiku-4-5-20251001' } }
    : { json: { data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-08-01T00:00:00Z' }], has_more: true, last_id: 'claude-sonnet-5-5' } }));
  const models = await T.anthropic({ key: KEY, fetch: f }).listModels();
  assert.deepEqual(models.map((m) => m.id), ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001']);
  assert.equal(f.calls.length, 2);
  assert.equal(new URL(f.calls[1].url).searchParams.get('after_id'), 'claude-sonnet-5-5');
  assert.equal(f.calls[0].init.method, 'GET');
  assert.equal(f.calls[0].init.headers['x-api-key'], KEY);
  assert.ok(f.calls.every((c) => !c.url.includes(KEY)));
});

test('OpenAI-compatible (Ollama): chat completions with a strict json_schema, temperature 0 and a seed, the key only as a bearer token', async () => {
  const f = fakeFetch(() => chatReply());
  const o = T.openaiCompatible({ base: 'http://localhost:11434', fetch: f, seed: 7 });
  const r = await o.extract(CHUNK, { model: 'llama3.3:70b' });
  const { url, init, body } = f.calls[0];
  assert.equal(url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(init.cat, 'llm'); assert.equal(init.subj, 'http://localhost:11434');
  assert.equal(init.headers.Authorization, undefined, 'no key given, none sent');
  assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'place_mentions', strict: true, schema: T.OUTPUT_SCHEMA } });
  assert.equal(body.temperature, 0);
  assert.equal(body.seed, 7);
  assert.deepEqual(body.messages, [{ role: 'system', content: T.PROMPT }, { role: 'user', content: CHUNK.text }]);
  assert.deepEqual(r.settings, { temperature: 0, seed: 7 });
  assert.deepEqual(r.usage, { input: 700, output: 9 });
  // With a key: in the Authorization header, and nowhere else.
  const g = fakeFetch(() => chatReply());
  await T.openaiCompatible({ base: 'https://llm.example.org', key: KEY, fetch: g }).extract(CHUNK, { model: 'm' });
  assert.equal(g.calls[0].init.headers.Authorization, 'Bearer ' + KEY);
  assert.ok(!g.calls[0].url.includes(KEY) && !g.calls[0].init.body.includes(KEY));
  // A server that refuses a temperature can be given none.
  const h = fakeFetch(() => chatReply());
  await T.openaiCompatible({ base: 'http://localhost:11434', fetch: h, temperature: null }).extract(CHUNK, { model: 'm' });
  assert.ok(!('temperature' in h.calls[0].body));
});

test('OpenAI-compatible: finish_reason length is a reply cut off; a refusal is an error; models are listed from /v1/models', async () => {
  const cut = T.openaiCompatible({ base: 'http://localhost:11434', fetch: fakeFetch(() => chatReply({ choices: [{ finish_reason: 'length', message: { content: '{"mentions":[' } }] })) });
  assert.equal((await cut.extract(CHUNK, { model: 'm' })).truncated, true);
  const no = T.openaiCompatible({ base: 'http://localhost:11434', fetch: fakeFetch(() => chatReply({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'I cannot.' } }] })) });
  await assert.rejects(no.extract(CHUNK, { model: 'm' }), { kind: 'refused' });
  const f = fakeFetch(() => ({ json: { object: 'list', data: [{ id: 'llama3.3:70b', object: 'model', created: 1730000000 }, { id: 'qwen3:32b', object: 'model' }] } }));
  const models = await T.openaiCompatible({ base: 'http://localhost:11434', fetch: f }).listModels();
  assert.deepEqual(models.map((m) => m.id), ['llama3.3:70b', 'qwen3:32b']);
  assert.equal(f.calls[0].url, 'http://localhost:11434/v1/models');
});

// ---- retries and errors --------------------------------------------------------------------------
test('429, 503 and 529 are tried again, at most three tries, after Retry-After; 401 at once, and never again', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const f = fakeFetch((u, i, n) => (n === 1 ? { status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, headers: { 'retry-after': '7' } } : anthropicReply()));
  await T.anthropic({ key: KEY, fetch: f, sleep }).extract(CHUNK, { model: 'm' });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(waits, [7000]);
  const busy = fakeFetch(() => ({ status: 429, json: { error: { message: 'rate limited' } } }));
  await assert.rejects(T.anthropic({ key: KEY, fetch: busy, sleep: noSleep }).extract(CHUNK, { model: 'm' }), { kind: 'rate', status: 429 });
  assert.equal(busy.calls.length, 3);
  const refused = fakeFetch(() => ({ status: 401, json: { error: { message: 'invalid x-api-key' } } }));
  await assert.rejects(T.anthropic({ key: KEY, fetch: refused, sleep: noSleep }).extract(CHUNK, { model: 'm' }), { kind: 'auth', status: 401 });
  assert.equal(refused.calls.length, 1);
  const unknown = fakeFetch(() => ({ status: 404, json: { error: { message: 'model: not-a-model' } } }));
  await assert.rejects(T.anthropic({ key: KEY, fetch: unknown, sleep: noSleep }).extract(CHUNK, { model: 'not-a-model' }), (e) => e.kind === 'request' && /not-a-model/.test(e.message));
});

test('a try that does not answer in time counts as no answer; cancelling aborts the request in flight', async () => {
  const hang = async (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  await assert.rejects(T.anthropic({ key: KEY, fetch: hang, timeoutMs: 20, maxTries: 2, sleep: noSleep }).extract(CHUNK, { model: 'm' }), (e) => e.kind === 'network' && /within/.test(e.message));
  const ac = new AbortController();
  const p = T.anthropic({ key: KEY, fetch: hang, sleep: noSleep }).extract(CHUNK, { model: 'm', signal: ac.signal });
  ac.abort(new Error('cancelled by the user'));
  await assert.rejects(p, /cancelled by the user/);
});

// ---- the key, never anywhere it should not be ------------------------------------------------------
// Any ten characters of the key in a row: the whole key, or a piece of it echoed back.
const holdsKey = (s) => { for (let i = 0; i + 10 <= KEY.length; i++) if (s.includes(KEY.slice(i, i + 10))) return true; return false; };

test('redact() removes the key, any long piece of it, and anything shaped like a key; and the search for the key can find it', () => {
  const raw = `Incorrect API key provided: ${KEY.slice(0, 12)}****${KEY.slice(-10)}. Your key ${KEY} was refused; also sk-proj-abc123def456 and AIzaSyA1234567890abcdefghij and Bearer abcdefghijkl.`;
  assert.ok(holdsKey(raw), 'presence: the search finds the key in the raw text');
  const clean = T.redact(raw, [KEY]);
  assert.ok(!holdsKey(clean), clean);
  assert.doesNotMatch(clean, /sk-proj|AIzaSy|abcdefghijkl/);
  assert.ok(holdsKey(T.redact(raw, [])), 'control: without the key to remove, a key of no known shape is still there');
  assert.equal(T.redact('Overloaded, try again', [KEY]), 'Overloaded, try again', 'ordinary words are left alone');
});

test('a key echoed back in a 401 is in no error, no work file, no report and no PLATO output; a leaking copy of each is caught', async () => {
  const echo = fakeFetch(() => ({ status: 401, json: { error: { message: `Incorrect API key provided: ${KEY}. Partial: ${KEY.slice(0, 14)}…${KEY.slice(-9)}`, type: 'authentication_error' } } }));
  const a = T.anthropic({ key: KEY, fetch: echo, sleep: noSleep });
  const text = 'We sailed from Gades to Ostia, and on to Roma.';
  const work = T.newWork({ text, source: { title: 'A voyage' }, now: '2026-10-01T12:00:00Z' });
  const run = await T.runExtraction({ work, text, provider: a, model: 'claude-sonnet-5-5' });
  assert.equal(run.stopped.kind, 'auth');
  assert.equal(echo.calls[0].init.headers['x-api-key'], KEY, 'presence: the key was sent, in its header');
  const error = `${run.stopped.message} ${run.stopped.stack} ${JSON.stringify(run.stopped)}`;
  const report = JSON.stringify({ ...run, stopped: { message: run.stopped.message, kind: run.stopped.kind } });
  // A work file and PLATO output with a result and an attestation in them, made with the same adapter.
  const ok = T.anthropic({ key: KEY, fetch: fakeFetch(() => anthropicReply()), sleep: noSleep });
  await T.runExtraction({ work, text, provider: ok, model: 'claude-sonnet-5-5' });
  const id = T.suggestions(work)[0].id;
  T.setReviewer(work, { name: 'Ada' });
  T.decide(work, text, id, { status: 'confirmed', place: 'https://pleiades.stoa.org/places/265840' });
  const workText = T.serialiseWork(work);
  const plato = JSON.stringify(T.attestationsDocument(T.attestationsFrom(work, text).attestations));
  assert.match(plato, /Gades/, 'presence: the output holds the attestation');
  assert.match(error, /refused the key \(401: Incorrect API key provided: \[key removed\]/);
  for (const [what, s] of Object.entries({ error, report, workText, plato })) assert.ok(!holdsKey(s), `the key is in the ${what}`);
  // The same search finds the key in a leaking copy of each: it can fail.
  const rawBody = await (await new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }))).text();
  for (const leak of [new Error(rawBody).message, report.replace('[key removed]', KEY), workText.replace('"settings": {', `"settings": { "key": "${KEY}",`), plato + KEY.slice(0, 16)]) assert.ok(holdsKey(leak));
});

test('a network failure whose message holds the key is redacted too', async () => {
  const f = async () => { throw new TypeError(`fetch failed for https://x.example/?key=${KEY}`); };
  await assert.rejects(T.anthropic({ key: KEY, fetch: f, sleep: noSleep }).extract(CHUNK, { model: 'm' }), (e) => e.kind === 'network' && !holdsKey(e.message) && /key removed/.test(e.message));
});

// ---- through the permissions module --------------------------------------------------------------
class Store { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }
beforeEach(() => {
  globalThis.localStorage = new Store(); globalThis.sessionStorage = new Store();
  globalThis.__platoCsp = { policy: '', origins: [] };
  permissions.resetForTests();
});

test('given the permissions module\'s fetch, an adapter asks nothing while its permission is not allowed, and is not retried; allowed, it asks once, without credentials', async () => {
  // The llm category is phase 2's; a local service under a category that exists shows the plumbing.
  const base = 'http://127.0.0.1:11434', route = { cat: 'gazetteer', subj: base };
  const stub = fakeFetch(() => chatReply());
  permissions.configure({ fetch: stub, enforced: async () => true });
  let asked = 0;
  const o = T.openaiCompatible({ base, fetch: (...a) => { asked++; return permissions.fetch(...a); }, route, sleep: noSleep });
  await assert.rejects(o.extract(CHUNK, { model: 'm' }), { name: 'PermissionError', kind: 'undecided' });
  assert.equal(stub.calls.length, 0, 'undecided: nothing asked');
  assert.equal(asked, 1, 'and the refusal is not tried again');
  permissions.set('gazetteer', base, 'never');
  await assert.rejects(o.extract(CHUNK, { model: 'm' }), { kind: 'never' });
  assert.equal(stub.calls.length, 0);
  permissions.set('gazetteer', base, 'allowed');
  globalThis.__platoCsp = { policy: core.policyFor([base]), origins: [base] };
  await o.extract(CHUNK, { model: 'm' });
  assert.equal(stub.calls.length, 1, 'control: allowed and in the policy, it asks');
  assert.equal(stub.calls[0].init.credentials, 'omit');
  assert.equal(stub.calls[0].init.redirect, 'manual');
  assert.equal(guardHits, 0, 'and never the global fetch');
});
