// Krisis, gazetteer lookup under the toolbox's permissions (src/lib/permissions.js): every request goes
// through permissions.fetch (lookup.js permittedFetch), a refusal stops the lookup in words, and nothing
// is sent while the service is not allowed. The permissions module is the real one, with storage and
// the page's policy stood in for; the service is a fake fetch, so nothing goes on the network. Each
// refusal has its control beside it: the same lookup, allowed, does send.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/lib/permissions-core.js';
import * as permissions from '../src/lib/permissions.js';
import { createLookup, memoryLedger, WHG_ENDPOINT } from '../src/engine/gazetteer/index.js';
import { runLookup, newWork, serviceOf, gazetteerPermission, permittedFetch } from '../src/engine/krisis/lookup.js';
import { readWork, serialiseWork } from '../src/engine/krisis/work.js';
import { LOOKUP_WORDS } from '../src/engine/words.js';

class Store {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const WHG = ['https://whgazetteer.org', 'https://www.whgazetteer.org'];
const OTHER = 'https://recon.example.org';
const inPolicy = (...origins) => { globalThis.__platoCsp = { policy: core.policyFor(origins), origins }; };
let calls, answer, enforced;
beforeEach(() => {
  globalThis.localStorage = new Store();
  globalThis.sessionStorage = new Store();
  inPolicy();
  calls = []; enforced = true;
  answer = (url, init) => {
    const out = {};
    for (const k of Object.keys(JSON.parse(init.body).queries)) out[k] = { result: [{ id: 'place:gn:1', name: 'Alpha', score: 100 }] };
    return new Response(JSON.stringify(out), { status: 200 });
  };
  permissions.resetForTests();
  permissions.configure({ fetch: async (url, init) => { calls.push({ url, init }); return answer(url, init); }, enforced: async () => enforced });
});

const X = 'https://example.org/';
const places = ['Alpha', 'Beta', 'Gamma'].map((label, i) => ({ iri: `${X}p/${i}`, label, names: [label], point: null, identities: { linked: [], denied: [] } }));
const subjects = { title: 'Dataset', files: [{ name: 'a.json', size: 1, sha256: '0'.repeat(64) }] };
/** A lookup as the page makes it: its fetch is permittedFetch over permissions.fetch, whose refusal aborts it. */
async function lookUp(endpoint = WHG_ENDPOINT) {
  const ctl = new AbortController();
  let refusedWith = null;
  const fetch = permittedFetch(permissions.fetch, (e) => { refusedWith = e; ctl.abort(e); });
  const lookup = createLookup({ endpoint, token: endpoint === WHG_ENDPOINT ? 'test-token' : null, fetch, shared: false, locks: null, ledger: memoryLedger(),
    sleep: () => Promise.resolve(), queryRate: null, batchSize: 1 });
  const r = await runLookup({ lookup, work: newWork(subjects, { now: '2026-10-01T00:00:00Z' }), places, options: { places: 'all', service: serviceOf(endpoint) }, signal: ctl.signal });
  return { ...r, refusedWith, states: Object.values(r.record.queries).map((q) => q.state) };
}

test('the permission a service is looked up under: whg for WHG (with or without www), else its site', () => {
  assert.equal(gazetteerPermission(WHG_ENDPOINT), 'whg');
  assert.equal(gazetteerPermission('https://www.whgazetteer.org/reconcile/'), 'whg');
  assert.equal(gazetteerPermission('https://Recon.Example.org:8443/api/reconcile'), 'https://recon.example.org:8443');
  assert.ok(permissions.parse('gazetteer', gazetteerPermission(`${OTHER}/reconcile`)), 'another service\'s site is a gazetteer permission');
  assert.equal(gazetteerPermission('not an address'), null);
});

test('not decided: nothing is sent, and the lookup stops in words; allowed (and in the policy), the same lookup sends', async () => {
  inPolicy(...WHG);
  const r = await lookUp();
  assert.equal(calls.length, 0, 'nothing sent');
  assert.deepEqual(r.stopped, { kind: 'permission', refused: 'undecided', status: null, message: null });
  assert.deepEqual(r.states, ['stopped', 'stopped', 'stopped']);
  assert.match(LOOKUP_WORDS.stopped(r.stopped), /not allowed in Permissions now, so nothing more was sent/);
  assert.deepEqual(readWork(serialiseWork(r.work)), r.work, 'a lookup stopped by a refusal can be saved');
  permissions.set('gazetteer', 'whg', 'allowed');
  const ok = await lookUp();
  assert.equal(ok.stopped, null, 'control: allowed, it runs to the end');
  assert.equal(calls.length, 3, 'control: one request a place');
  assert.ok(calls.every((c) => c.url === WHG_ENDPOINT && c.init.credentials === 'omit' && c.init.redirect === 'manual'), 'through permissions.fetch: no cookies, no redirect followed');
  assert.deepEqual(ok.states, ['answered', 'answered', 'answered']);
});

test('withdrawn part-way: what was answered is kept, the rest stopped, and nothing more is sent', async () => {
  inPolicy(...WHG);
  permissions.set('gazetteer', 'whg', 'allowed');
  const first = answer;
  answer = (url, init) => { permissions.set('gazetteer', 'whg', 'undecided'); return first(url, init); };
  const r = await lookUp();
  assert.equal(calls.length, 1, 'the first request only');
  assert.deepEqual(r.states, ['answered', 'stopped', 'stopped']);
  assert.equal(r.stopped.refused, 'undecided');
});

test('Never, allowed since the page loaded, and an unenforced policy each stop the lookup with nothing sent, in words of their own', async () => {
  permissions.set('gazetteer', 'whg', 'never'); inPolicy(...WHG);
  const never = await lookUp();
  permissions.set('gazetteer', 'whg', 'allowed'); inPolicy();
  const reload = await lookUp();
  inPolicy(...WHG); enforced = false;
  const unprotected = await lookUp();
  assert.equal(calls.length, 0);
  assert.deepEqual([never, reload, unprotected].map((r) => r.stopped.refused), ['never', 'reload', 'unprotected']);
  assert.match(LOOKUP_WORDS.stopped(never.stopped), /set to Never in Permissions/);
  assert.match(LOOKUP_WORDS.stopped(reload.stopped), /once the page is reloaded/);
  assert.match(LOOKUP_WORDS.stopped(unprotected.stopped), /did not show that it enforces the page's protection/);
  enforced = true;
  assert.equal((await lookUp()).stopped, null, 'control: allowed, in the policy, enforced: it runs');
});

test('a redirect is refused (moved) and stops the lookup at once, not retried; a request to a site the permission does not cover is refused (address)', async () => {
  inPolicy(...WHG);
  permissions.set('gazetteer', 'whg', 'allowed');
  answer = () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } });
  const moved = await lookUp();
  assert.equal(calls.length, 1, 'one request, not retried');
  assert.equal(moved.stopped.refused, 'moved');
  assert.match(LOOKUP_WORDS.stopped(moved.stopped), /sent the request on elsewhere/);
  // A WHG host the permission does not list: refused before anything is sent, and the page told.
  let told = null;
  const f = permittedFetch(permissions.fetch, (e) => { told = e; });
  await assert.rejects(f('https://api.whgazetteer.org/reconcile', { method: 'POST' }), { name: 'PermissionError', kind: 'address' });
  assert.equal(told?.kind, 'address');
  assert.equal(calls.length, 1, 'nothing more sent');
  assert.match(LOOKUP_WORDS.stopped({ kind: 'permission', refused: 'address' }), /does not cover, so nothing was sent there/);
});

test('a service that cannot be reached is left to the gazetteer module\'s retries, and stops as it does (network), not as a permission', async () => {
  inPolicy(...WHG);
  permissions.set('gazetteer', 'whg', 'allowed');
  answer = () => { throw new TypeError('Failed to fetch'); };
  const r = await lookUp();
  assert.equal(r.refusedWith, null, 'the page is not told to stop it');
  assert.ok(calls.length > 1, 'retried');
  assert.equal(r.stopped.kind, 'network');
  assert.match(LOOKUP_WORDS.stopped(r.stopped), /could not be reached/);
});

test('another service is asked under its own site: WHG allowed does not allow it; its site allowed does', async () => {
  inPolicy(...WHG, OTHER);
  permissions.set('gazetteer', 'whg', 'allowed');
  answer = (url, init) => {
    if (init.method === 'GET' || !init.body) return new Response('{}', { status: 200 });
    const body = init.body instanceof URLSearchParams ? JSON.parse(init.body.get('queries')) : JSON.parse(init.body).queries;
    return new Response(JSON.stringify(Object.fromEntries(Object.keys(body).map((k) => [k, { result: [] }]))), { status: 200 });
  };
  const refused = await lookUp(`${OTHER}/reconcile`);
  assert.equal(calls.length, 0);
  assert.equal(refused.stopped.refused, 'undecided');
  permissions.set('gazetteer', OTHER, 'allowed');
  const ok = await lookUp(`${OTHER}/reconcile`);
  assert.equal(ok.stopped?.kind ?? null, ok.stopped ? 'suspect' : null, 'control: its site allowed, it is asked');
  assert.ok(calls.length > 0 && calls.every((c) => c.url.startsWith(OTHER)));
});

test('every kind of refusal the permissions module names has plain words of its own', () => {
  const kinds = ['address', 'never', 'undecided', 'reload', 'unprotected', 'moved', 'network'];
  const said = kinds.map((refused) => LOOKUP_WORDS.stopped({ kind: 'permission', refused }));
  assert.deepEqual(Object.keys(LOOKUP_WORDS.refused).sort(), [...kinds].sort());
  assert.equal(new Set(said).size, kinds.length, 'each its own');
  for (const s of said) assert.match(s, /^The lookup stopped: /);
  assert.ok(said.every((s) => !/https?:\/\//.test(s)), 'no address in them');
});
