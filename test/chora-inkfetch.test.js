// The tiles a trace reads (src/chora/inkfetch.js): through remote.js's fetchImage and the permissions
// module alone, under iiif:<site>, two at a time, a 429 waited out, refusals said in words, kept so that
// the same tile is not asked for twice, let go once the site's permission is withdrawn, and only from the
// map's own image server. The first tests stub the fetch and the decoding (what they are asked is what is
// checked); the last run over the real permissions module, its network stubbed, as chora-remote.test.js does.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTileFetcher, waitAfter, tileErrorOf, TileError, CONCURRENCY } from '../src/chora/inkfetch.js';
import { RemoteError, fetchImage } from '../src/chora/remote.js';
import * as core from '../src/lib/permissions-core.js';
import * as permissions from '../src/lib/permissions.js';

const A = 'http://127.0.0.1:9001';
const blob = (n) => ({ size: n, n });
const status = (s, extra = {}) => new RemoteError('status', `answered ${s}`, { status: s, ...extra });
const permissionError = (kind) => new permissions.PermissionError(kind, `refused (${kind}) for ${A}`, { origin: A });
function fetchOf(answer, log = []) {
  let inFlight = 0;
  const f = async (url) => {
    log.push(url); inFlight++; log.peak = Math.max(log.peak || 0, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    const a = answer(url, log.filter((x) => x === url).length);
    if (a instanceof Error) throw a;
    return a;
  };
  f.log = log;
  return f;
}
const decode = async (b) => ({ decoded: b, close() {} });

test('tiles are fetched at most two at a time, in the order asked', async () => {
  const f = fetchOf(() => blob(10));
  const t = createTileFetcher({ fetch: f, decode });
  const urls = Array.from({ length: 7 }, (_, k) => `${A}/iiif/ink/${k}/default.jpg`);
  const out = await t.fetch(urls, { origin: A });
  assert.deepEqual(out.map((x) => x.url), urls);
  assert.equal(f.log.length, 7);
  assert.equal(CONCURRENCY, 2);
  assert.equal(f.log.peak, 2, 'more (or fewer) than two at once');
});

test('a tile fetched once is not asked for again', async () => {
  const f = fetchOf(() => blob(10));
  const t = createTileFetcher({ fetch: f, decode });
  await t.fetch([`${A}/a.jpg`, `${A}/b.jpg`]);
  await t.fetch([`${A}/b.jpg`, `${A}/c.jpg`]);
  assert.deepEqual([...f.log], [`${A}/a.jpg`, `${A}/b.jpg`, `${A}/c.jpg`]);
  assert.equal(t.stats.fromCache, 1);
});

test('a 429 is waited out as Retry-After says (else 1 s, then 2 s), and given up in words after four', async () => {
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  const f = fetchOf((url, n) => (n <= 2 ? status(429, { retryAfter: url.includes('ra') ? '3' : null }) : blob(1)));
  const t = createTileFetcher({ fetch: f, decode, sleep });
  await t.fetch([`${A}/ra.jpg`]);
  assert.deepEqual(slept, [3000, 3000]);
  slept.length = 0;
  await t.fetch([`${A}/plain.jpg`]);
  assert.deepEqual(slept, [1000, 2000]);
  const always = createTileFetcher({ fetch: fetchOf(() => status(429)), decode, sleep: async () => {} });
  await assert.rejects(always.fetch([`${A}/x.jpg`]), (e) => e instanceof TileError && e.kind === 'busy' && /429/.test(e.message));
  assert.equal(waitAfter(new Date(Date.parse('2026-10-01T00:00:05Z')).toUTCString(), 0, Date.parse('2026-10-01T00:00:00Z')), 5);
});

test('a 403, a server that lets no other site read it, a redirect and a permission not allowed are each said in words; nothing else is asked after', async () => {
  const f403 = fetchOf(() => status(403));
  await assert.rejects(createTileFetcher({ fetch: f403, decode }).fetch([`${A}/a.jpg`, `${A}/b.jpg`, `${A}/c.jpg`]),
    (e) => e.kind === 'auth' && /403/.test(e.message) && /IIIF Auth/.test(e.message) && e.message.includes(A));
  assert.ok(f403.log.length <= 2, `asked ${f403.log.length} after a refusal`);
  const cors = fetchOf(() => permissionError('network'));
  await assert.rejects(createTileFetcher({ fetch: cors, decode }).fetch([`${A}/a.jpg`]), (e) => e.kind === 'cors' && /CORS/.test(e.message));
  const moved = fetchOf(() => permissionError('moved'));
  await assert.rejects(createTileFetcher({ fetch: moved, decode }).fetch([`${A}/a.jpg`]), (e) => e.kind === 'moved' && /elsewhere/.test(e.message) && !/paste/.test(e.message));
  for (const kind of ['undecided', 'never', 'reload', 'unprotected']) {
    const e = tileErrorOf(permissionError(kind), `${A}/a.jpg`);
    assert.equal(e.kind, 'permission'); assert.equal(e.permission, kind); assert.match(e.message, new RegExp(kind));
  }
  // The control: a status that is none of these is said as a status, with the number.
  assert.equal(tileErrorOf(status(500), `${A}/a.jpg`).kind, 'status');
});

test('a tile not on the map\'s image server is refused before anything is asked; a trace let go asks no more', async () => {
  const f = fetchOf(() => blob(1));
  const t = createTileFetcher({ fetch: f, decode });
  await assert.rejects(t.fetch([`${A}/a.jpg`, 'http://127.0.0.1:9002/b.jpg'], { origin: A }), (e) => e instanceof TileError && /not on its image server/.test(e.message));
  assert.equal(f.log.length, 0);
  // The control: the same call with the origin both are on asks for both.
  await t.fetch([`${A}/a.jpg`, `${A}/b2.jpg`], { origin: A });
  assert.equal(f.log.length, 2);
  let current = true;
  const f2 = fetchOf(() => { current = false; return blob(1); });
  await assert.rejects(createTileFetcher({ fetch: f2, decode }).fetch([`${A}/1`, `${A}/2`, `${A}/3`, `${A}/4`], { isCurrent: () => current }), (e) => e.kind === 'cancelled');
  assert.ok(f2.log.length <= 2, `asked ${f2.log.length} after being let go`);
});

test('prune lets go of the tiles of a site no longer allowed, and only those; a tile arriving after the withdrawal is not kept', async () => {
  const B = 'http://127.0.0.1:9002';
  const ok = new Set([A, B]);
  const f = fetchOf(() => blob(1));
  const t = createTileFetcher({ fetch: f, decode, allowed: (o) => ok.has(o) });
  await t.fetch([`${A}/a.jpg`, `${B}/b.jpg`]);
  assert.equal(t.size, 2);
  assert.deepEqual(t.prune(), [], 'nothing withdrawn, nothing let go (the control)');
  ok.delete(A);
  assert.deepEqual(t.prune(), [A]);
  assert.ok(!t.has(`${A}/a.jpg`)); assert.ok(t.has(`${B}/b.jpg`));
  await t.fetch([`${A}/a.jpg`]);
  assert.equal(f.log.filter((u) => u === `${A}/a.jpg`).length, 2, 'asked again (the fetch itself is the permissions module\'s to refuse)');
  assert.ok(!t.has(`${A}/a.jpg`), 'kept although its site is not allowed');
});

// ---- Over the real permissions module ------------------------------------------------------------
class Store {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
const IIIF = 'https://iiif.example.org';
let calls;
const stub = (fn) => async (url, init) => { calls.push({ url, init }); return { url, ...fn(url, init) }; };
const image = (extra = {}) => ({ ok: true, status: 200, type: 'cors', blob: async () => blob(7), ...extra });
const inPolicy = (...origins) => { globalThis.__platoCsp = { policy: core.policyFor(origins), origins }; };

beforeEach(() => {
  globalThis.localStorage = new Store();
  globalThis.sessionStorage = new Store();
  inPolicy();
  calls = [];
  permissions.resetForTests();
  permissions.configure({ fetch: stub(() => image()), enforced: async () => true });
});

test('a tile is asked through the permissions module under iiif:<its site>, with no credentials and following no redirect; not before it is allowed', async () => {
  const url = `${IIIF}/iiif/ink/0,0,512,512/512,/0/default.jpg`;
  await assert.rejects(fetchImage(url), (e) => e.name === 'PermissionError' && e.kind === 'undecided');
  assert.equal(calls.length, 0, 'asked before it was allowed');
  const t = createTileFetcher({ decode });
  await assert.rejects(t.fetch([url]), (e) => e instanceof TileError && e.kind === 'permission' && e.permission === 'undecided');
  assert.equal(calls.length, 0);
  // The control: allowed, and in this load's policy, it is asked, as the module asks.
  permissions.set('iiif', IIIF, 'allowed'); inPolicy(IIIF);
  const [got] = await t.fetch([url], { origin: IIIF });
  assert.equal(got.url, url);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, url);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.redirect, 'manual');
  // Allmaps' annotation server is not an image server: refused before asking.
  await assert.rejects(fetchImage('https://annotations.allmaps.org/images/x.jpg'), (e) => e instanceof RemoteError && e.kind === 'address');
  assert.equal(calls.length, 1);
});

test('a tile answered with a redirect is refused as moved, and a 429\'s Retry-After is read', async () => {
  permissions.set('iiif', IIIF, 'allowed'); inPolicy(IIIF);
  permissions.configure({ fetch: stub(() => ({ ok: false, status: 0, type: 'opaqueredirect' })) });
  await assert.rejects(createTileFetcher({ decode }).fetch([`${IIIF}/t.jpg`]), (e) => e.kind === 'moved');
  permissions.configure({ fetch: stub(() => ({ ok: false, status: 429, type: 'cors', headers: { get: (h) => (h === 'Retry-After' ? '2' : null) } })) });
  await assert.rejects(fetchImage(`${IIIF}/t.jpg`), (e) => e instanceof RemoteError && e.status === 429 && e.retryAfter === '2');
});

test('withdrawn in the panel (permissions.onChange), the site\'s tiles are let go; another site\'s are kept', async () => {
  const OTHER = 'https://other.example.org';
  for (const o of [IIIF, OTHER]) permissions.set('iiif', o, 'allowed');
  inPolicy(IIIF, OTHER);
  const t = createTileFetcher({ decode, allowed: (o) => permissions.allowed('iiif', o) });
  const stop = permissions.onChange(() => t.prune());
  try {
    await t.fetch([`${IIIF}/a.jpg`, `${OTHER}/b.jpg`]);
    assert.equal(t.size, 2);
    permissions.set('iiif', OTHER, 'allowed');   // a change that withdraws nothing (the control)
    assert.equal(t.size, 2);
    permissions.set('iiif', IIIF, 'never');
    assert.ok(!t.has(`${IIIF}/a.jpg`), 'kept after its permission was set to Never');
    assert.ok(t.has(`${OTHER}/b.jpg`));
    permissions.forget('iiif', OTHER);
    assert.equal(t.size, 0);
  } finally { stop(); }
});
