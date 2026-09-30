// Which sites the user has agreed to (src/chora/consent.js), and the one guarded way Chora fetches a
// historical map's documents (src/chora/fetchguard.js). The Content Security Policy is written from
// the same record (src/chora/csp-head.js), so the two are checked against each other here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as consent from '../src/chora/consent.js';
import { createGuard, GuardError } from '../src/chora/fetchguard.js';

function storage(items = {}) {
  const m = new Map(Object.entries(items).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), keys: () => [...m.keys()] };
}
/** The origins the head script would put in the policy, reading this storage. */
function policyOrigins(st) {
  const window = {}, head = { prepend() {} };
  vm.runInNewContext(readFileSync('src/chora/csp-head.js', 'utf8'), { window, localStorage: st, document: { head, createElement: () => ({ setAttribute() {} }) } });
  return JSON.parse(JSON.stringify(window.__choraCsp.origins));
}

test('the basemap consents kept before there were kinds are carried over as basemap consents, once', () => {
  const st = storage({ 'chora-basemap-consent': ['https://tiles.openfreemap.org', 'https://tile.openstreetmap.org'] });
  assert.deepEqual(consent.list(st), [{ origin: 'https://tiles.openfreemap.org', kind: 'basemap' }, { origin: 'https://tile.openstreetmap.org', kind: 'basemap' }]);
  assert.equal(st.getItem('chora-basemap-consent'), null, 'the old key is let go');
  assert.ok(consent.consented('https://tiles.openfreemap.org', 'basemap', st));
  // A consent is for its kind: agreeing to a basemap is not agreeing to historical maps from that site.
  assert.ok(!consent.consented('https://tiles.openfreemap.org', 'iiif', st));
  // Carried over once: the list read again is the same, not doubled.
  assert.equal(consent.list(st).length, 2);
  // Merged with what is already in the new record, not replacing it.
  const st2 = storage({ 'chora-consent': [{ origin: 'https://iiif.example.org', kind: 'iiif' }], 'chora-basemap-consent': ['https://tiles.openfreemap.org'] });
  assert.deepEqual(consent.list(st2).map((c) => c.kind).sort(), ['basemap', 'iiif']);
});

test('what is agreed to is what the policy lets the page reach, and forgetting takes every site out of it', () => {
  const st = storage();
  assert.deepEqual(policyOrigins(st), []);
  consent.grant(['https://iiif.example.org', 'http://127.0.0.1:47941'], 'iiif', st);
  consent.grant(['https://annotations.allmaps.org'], 'allmaps', st);
  consent.grant(['https://iiif.example.org'], 'iiif', st);   // again: kept once
  assert.equal(consent.list(st).length, 3);
  assert.deepEqual(policyOrigins(st).sort(), ['http://127.0.0.1:47941', 'https://annotations.allmaps.org', 'https://iiif.example.org']);
  consent.forget(st);
  assert.deepEqual(consent.list(st), []);
  assert.deepEqual(policyOrigins(st), []);
  // An old basemap consent is forgotten too, and does not come back through the migration.
  const old = storage({ 'chora-basemap-consent': ['https://tiles.openfreemap.org'] });
  consent.forget(old);
  assert.deepEqual(policyOrigins(old), []);
  assert.deepEqual(consent.list(old), []);
});

test('only a plain origin of a known kind is agreed to', () => {
  const st = storage();
  assert.throws(() => consent.grant(['https://a.example.org/path'], 'iiif', st), /not a site/);
  assert.throws(() => consent.grant(['https://a.example.org; script-src *'], 'iiif', st), /not a site/);
  assert.throws(() => consent.grant(['https://a.example.org'], 'anything', st), /kind/);
  assert.deepEqual(consent.list(st), []);
  // The control: a plain one is taken, and an address is reduced to its site by originOf.
  assert.equal(consent.originOf('https://IIIF.example.org:443/iiif/grid/info.json'), 'https://iiif.example.org');
  consent.grant([consent.originOf('https://IIIF.example.org/x')], 'iiif', st);
  assert.deepEqual(consent.list(st), [{ origin: 'https://iiif.example.org', kind: 'iiif' }]);
});

test('each kind has its notice, naming the sites, and each ends by saying the site sees nothing of the data', () => {
  for (const [kind, sites] of [['basemap', ['https://tiles.openfreemap.org']], ['iiif', ['https://iiif.example.org', 'https://img.example.org']], ['allmaps', ['https://annotations.allmaps.org']]]) {
    const text = consent.notice(kind, { origins: sites, name: 'A map' });
    for (const s of sites) assert.ok(text.includes(s), `${kind}: ${s} named`);
    assert.match(text, /It sees nothing of your data, which stays in this tab\.$/);
  }
  assert.match(consent.notice('allmaps', { origins: ['https://annotations.allmaps.org'] }), /Allmaps/);
  assert.throws(() => consent.notice('nothing', { origins: [] }));
});

// ---- The guard ---------------------------------------------------------------------------------

function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = routes[String(url)];
    if (!r) return { ok: false, status: 404, url: String(url), json: async () => ({}) };
    if (r.redirectTo) {
      if (init.redirect === 'error') throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, url: r.redirectTo, json: async () => r.body };
    }
    return { ok: true, status: 200, url: String(url), json: async () => r.body };
  };
  f.calls = calls;
  return f;
}

test('the guard fetches only from a site agreed to for that kind, and in the page\'s policy; it counts what it refuses', async () => {
  const st = storage();
  consent.grant(['https://iiif.example.org'], 'iiif', st);
  consent.grant(['https://late.example.org'], 'iiif', st);
  const state = {};
  const fetch = fakeFetch({ 'https://iiif.example.org/m.json': { body: { ok: 1 } }, 'https://other.example.org/m.json': { body: { ok: 2 } } });
  const guard = createGuard({ state, fetch, consented: (o, k) => consent.consented(o, k, st), inPolicy: (o) => o === 'https://iiif.example.org' });
  // The control: an agreed site is fetched.
  assert.deepEqual(await guard.json('https://iiif.example.org/m.json', 'iiif'), { ok: 1 });
  assert.equal(state.iiifRequests, 1);
  // Another site is refused before any request, and named.
  await assert.rejects(guard.json('https://other.example.org/m.json', 'iiif'), (e) => e instanceof GuardError && e.kind === 'consent' && e.origin === 'https://other.example.org');
  // Agreed to as a basemap is not agreed to as a historical map.
  consent.grant(['https://other.example.org'], 'basemap', st);
  await assert.rejects(guard.json('https://other.example.org/m.json', 'iiif'), (e) => e.kind === 'consent');
  // Agreed to, but not yet in the page's policy (agreed since the page loaded): a reload is needed.
  await assert.rejects(guard.json('https://late.example.org/m.json', 'iiif'), (e) => e.kind === 'reload');
  assert.deepEqual(fetch.calls.map((c) => c.url), ['https://iiif.example.org/m.json']);
  assert.equal(state.iiifBlocked, 2);
  assert.deepEqual(state.iiifBlockedOrigins, ['https://other.example.org']);
  // No credentials go with a request.
  assert.equal(fetch.calls[0].init.credentials, 'omit');
});

test('the guard refuses a redirect when asked to, and a document that ends up on another site in any case', async () => {
  const st = storage();
  consent.grant(['https://iiif.example.org', 'https://b.example.org'], 'iiif', st);
  const state = {};
  const fetch = fakeFetch({
    'https://iiif.example.org/info.json': { redirectTo: 'https://b.example.org/info.json', body: { id: 'x' } },
    'https://iiif.example.org/same.json': { redirectTo: 'https://iiif.example.org/other.json', body: { ok: 3 } },
  });
  const guard = createGuard({ state, fetch, consented: (o, k) => consent.consented(o, k, st), inPolicy: () => true });
  await assert.rejects(guard.json('https://iiif.example.org/info.json', 'iiif', { redirect: 'error' }), (e) => e.kind === 'redirect');
  assert.equal(fetch.calls[0].init.redirect, 'error');
  // Followed, it lands on another site (one agreed to, even): still refused.
  await assert.rejects(guard.json('https://iiif.example.org/info.json', 'iiif'), (e) => e.kind === 'moved' && /b\.example\.org/.test(e.message));
  // The control: a redirect within the site is followed.
  assert.deepEqual(await guard.json('https://iiif.example.org/same.json', 'iiif'), { ok: 3 });
  // A status that is not OK is an error with the status.
  await assert.rejects(guard.json('https://iiif.example.org/missing.json', 'iiif'), (e) => e.kind === 'status' && e.status === 404);
});
