// The permissions module (src/lib/permissions.js and its pure core) and the policy written into each
// page's <head> (scripts/vite-csp.mjs). Each test of a refusal has its control beside it: the same
// request, allowed, does go.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../src/lib/permissions-core.js';
import * as permissions from '../src/lib/permissions.js';
import { headScript, HEAD_MARK, cspPlugin } from '../scripts/vite-csp.mjs';

class Store {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const OSM = 'https://tile.openstreetmap.org';
let calls;
const stub = (answer = (url) => ({ ok: true, status: 200, url })) => async (url, init) => { calls.push({ url, init }); return answer(url, init); };

beforeEach(() => {
  globalThis.localStorage = new Store();
  globalThis.sessionStorage = new Store();
  globalThis.__platoCsp = { policy: '', origins: [] };
  calls = [];
  permissions.configure({ fetch: stub(), enforced: async () => true });
});
const inPolicy = (...origins) => { globalThis.__platoCsp = { policy: core.policyFor(origins), origins }; };

test('by default nothing is asked: an undecided permission refuses, and fetch is not called; allowed, the same request goes', async () => {
  inPolicy(OSM);
  assert.equal(permissions.state('basemap', 'osm'), 'undecided');
  await assert.rejects(permissions.fetch(`${OSM}/1/1/1.png`, { cat: 'basemap', subj: 'osm' }), { name: 'PermissionError', kind: 'undecided' });
  assert.equal(calls.length, 0);
  permissions.set('basemap', 'osm', 'allowed');
  const r = await permissions.fetch(`${OSM}/1/1/1.png`, { cat: 'basemap', subj: 'osm' });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.credentials, 'omit');
});

test('allowed but not in this load\'s policy: refused until the reload; and an address not of the permission\'s sites is refused', async () => {
  permissions.set('basemap', 'osm', 'allowed');
  await assert.rejects(permissions.fetch(`${OSM}/a.png`, { cat: 'basemap', subj: 'osm' }), { kind: 'reload' });
  assert.equal(permissions.waitsForReload('basemap', 'osm'), true);
  inPolicy(OSM, 'https://tiles.openfreemap.org');
  assert.equal(permissions.waitsForReload('basemap', 'osm'), false);
  assert.equal(permissions.allowed('basemap', 'osm'), true);
  await assert.rejects(permissions.fetch('https://tiles.openfreemap.org/x', { cat: 'basemap', subj: 'osm' }), { kind: 'address' });
  assert.equal(calls.length, 0);
});

test('where the policy was not shown to be enforced, nothing is asked, allowed or not', async () => {
  inPolicy(OSM); permissions.set('basemap', 'osm', 'allowed');
  permissions.configure({ enforced: async () => false });
  await assert.rejects(permissions.fetch(`${OSM}/a.png`, { cat: 'basemap', subj: 'osm' }), { kind: 'unprotected' });
  assert.equal(calls.length, 0);
});

test('Never beats allowing for the tab, and allowing for the tab alone is allowed', () => {
  permissions.allowOnce('gazetteer', 'whg');
  assert.equal(permissions.state('gazetteer', 'whg'), 'allowed');
  assert.equal(permissions.list().find((x) => x.key === 'gazetteer:whg').scope, 'tab');
  permissions.set('gazetteer', 'whg', 'never');
  assert.equal(permissions.state('gazetteer', 'whg'), 'never');
  permissions.allowOnce('gazetteer', 'whg');   // asked for again in the tab: still Never
  assert.equal(permissions.state('gazetteer', 'whg'), 'never');
  assert.equal(core.check({ 'gazetteer:whg': { state: 'never' } }, 'gazetteer', 'whg', ['gazetteer:whg']), 'never');
  assert.equal(core.check({}, 'gazetteer', 'whg', ['gazetteer:whg']), 'allowed');
});

test('a forged grant is listed as kept; unknown ids, malformed and injected sites are dropped from the grants, the list and the policy', () => {
  const INJECT = 'https://evil.example.org; script-src *';
  localStorage.setItem('plato-tools.permissions', JSON.stringify({ version: 1, grants: {
    'basemap:https://forged.example.org': { state: 'allowed', at: '2026-10-01T10:00:00Z' },
    [`basemap:${INJECT}`]: { state: 'allowed' },
    'basemap:https://UPPER.example.org': { state: 'allowed' },
    'basemap:https://path.example.org/x': { state: 'allowed' },
    'basemap:nosuchprovider': { state: 'allowed' },
    'basemap:constructor': { state: 'allowed' },
    'allmaps:https://allmaps-lookalike.example.org': { state: 'allowed' },
    'nosuchcategory:https://x.example.org': { state: 'allowed' },
    'basemap:https://odd-state.example.org': { state: 'maybe' },
    'iiif:https://maps.example.org': { state: 'allowed' },
  } }));
  const keys = permissions.list().map((x) => x.key);
  assert.ok(keys.includes('basemap:https://forged.example.org'), 'the forged grant is listed');
  assert.ok(keys.includes('iiif:https://maps.example.org'));
  for (const bad of [`basemap:${INJECT}`, 'basemap:https://UPPER.example.org', 'basemap:https://path.example.org/x', 'basemap:nosuchprovider', 'basemap:constructor',
    'allmaps:https://allmaps-lookalike.example.org', 'nosuchcategory:https://x.example.org']) assert.ok(!keys.includes(bad), bad);
  const origins = core.allowedOrigins(core.normalise(JSON.parse(localStorage.getItem('plato-tools.permissions')).grants), []);
  assert.deepEqual(origins, ['https://forged.example.org', 'https://maps.example.org']);
  const policy = core.policyFor([...origins, INJECT, "'unsafe-eval'", '*']);
  assert.ok(policy.includes('https://forged.example.org'));
  assert.ok(!policy.includes('evil') && !policy.includes('*') && !policy.includes('unsafe-eval'), policy);
  assert.throws(() => permissions.set('basemap', INJECT, 'allowed'), TypeError);
  assert.throws(() => permissions.set('basemap', 'osm', 'sometimes'), TypeError);
});

test('Chora\'s old basemap consents are carried over once: a whole provider by its id, the rest as pasted sites, the old key removed', () => {
  const carto = core.REGISTRY.basemap.carto.origins;
  localStorage.setItem('chora-basemap-consent', JSON.stringify(['https://tiles.openfreemap.org', carto[0], 'https://my-tiles.example.org', 'not a site']));
  const l = permissions.list();
  const st = (k) => l.find((x) => x.key === k)?.state;
  assert.equal(st('basemap:openfreemap'), 'allowed');
  assert.equal(st('basemap:carto'), 'undecided', 'CARTO had one of its six sites only');
  assert.equal(st(`basemap:${carto[0]}`), 'allowed');
  assert.equal(st('basemap:https://my-tiles.example.org'), 'allowed');
  assert.equal(l.find((x) => x.key === 'basemap:https://my-tiles.example.org').added, true);
  assert.equal(localStorage.getItem('chora-basemap-consent'), null);
  const once = localStorage.getItem('plato-tools.permissions');
  permissions.list();
  assert.equal(localStorage.getItem('plato-tools.permissions'), once, 'idempotent');
  // A grant already made is not changed by a later carrying over.
  permissions.set('basemap', 'osm', 'never');
  localStorage.setItem('chora-basemap-consent', JSON.stringify([OSM]));
  assert.equal(permissions.state('basemap', 'osm'), 'never');
  // The whole of CARTO's list makes the provider's permission.
  assert.equal(core.check(core.migrateBasemapConsent({}, carto), 'basemap', 'carto'), 'allowed');
});

test('an answer from another site, after a redirect, is refused; one from the same site, or another of the provider\'s sites, is used', async () => {
  inPolicy(...core.REGISTRY.basemap.carto.origins);
  permissions.set('basemap', 'carto', 'allowed');
  permissions.configure({ fetch: stub(() => ({ ok: true, url: 'https://elsewhere.example.org/style.json' })) });
  await assert.rejects(permissions.fetch('https://basemaps.cartocdn.com/style.json', { cat: 'basemap', subj: 'carto' }), (e) => e.kind === 'moved' && e.landed === 'https://elsewhere.example.org');
  permissions.configure({ fetch: stub(() => ({ ok: true, url: 'https://tiles-a.basemaps.cartocdn.com/style.json' })) });
  assert.equal((await permissions.fetch('https://basemaps.cartocdn.com/style.json', { cat: 'basemap', subj: 'carto' })).ok, true);
  assert.equal(calls[0].init.redirect, 'follow');
});

test('the token is never in list(), in the panel\'s data or in an error; it is kept for the tab unless remembered', async () => {
  const T = 'SECRET-TOKEN-123';
  permissions.token.set(`  ${T} `);
  assert.equal(permissions.token.get(), T);
  assert.equal(sessionStorage.getItem('plato-tools.whg-token'), T);
  assert.equal(localStorage.getItem('plato-tools.whg-token'), null, 'not remembered by default');
  permissions.token.remember(true);
  assert.equal(localStorage.getItem('plato-tools.whg-token'), T);
  assert.ok(!JSON.stringify(permissions.list()).includes(T));
  assert.ok(!JSON.stringify(permissions.remembered()).includes(T));
  let err;
  try { await permissions.fetch(`https://whgazetteer.org/reconcile?token=${T}`, { cat: 'gazetteer', subj: 'whg', headers: { Authorization: `Token ${T}` } }); } catch (e) { err = e; }
  assert.equal(err?.kind, 'undecided');
  assert.ok(!err.message.includes(T) && !JSON.stringify(err).includes(T) && !String(err.stack).includes(T));
  // A new tab: the remembered token is found in the browser; not remembered, it is gone with the tab.
  sessionStorage.clear();
  assert.equal(permissions.token.get(), T);
  permissions.token.remember(false);
  assert.equal(localStorage.getItem('plato-tools.whg-token'), null);
  permissions.token.forget();
  assert.equal(permissions.token.get(), null);
});

test('forget and forget all: the permission is undecided again; keep working data is on by default', () => {
  permissions.set('basemap', 'osm', 'allowed'); permissions.allowOnce('gazetteer', 'whg');
  permissions.forget('basemap', 'osm');
  assert.equal(permissions.state('basemap', 'osm'), 'undecided');
  assert.equal(permissions.state('gazetteer', 'whg'), 'allowed');
  permissions.forgetAll();
  assert.equal(permissions.state('gazetteer', 'whg'), 'undecided');
  assert.equal(permissions.keepWorkingData(), true);
  permissions.setKeepWorkingData(false);
  assert.equal(permissions.keepWorkingData(), false);
  permissions.setKeepWorkingData(true);
  assert.equal(permissions.keepWorkingData(), true);
});

test('MapLibre\'s transformRequest: this site goes, an allowed provider goes, and once withdrawn it is refused at once and counted', async () => {
  globalThis.location = { origin: 'https://pelagios.org', href: 'https://pelagios.org/plato-tools/chora.html' };
  try {
    inPolicy(OSM); permissions.set('basemap', 'osm', 'allowed');
    await permissions.enforced();
    const blocked = [];
    const tr = permissions.transformRequest(() => [['basemap', 'osm']], { onBlocked: (o) => blocked.push(o) });
    assert.deepEqual(tr('./basemap/style.json'), { url: './basemap/style.json' });
    assert.deepEqual(tr(`${OSM}/1/0/0.png`), { url: `${OSM}/1/0/0.png` });
    assert.throws(() => tr('https://tiles.example.net/1/0/0.png'));
    permissions.set('basemap', 'osm', 'never');
    assert.throws(() => tr(`${OSM}/1/0/0.png`));
    assert.deepEqual(blocked, ['https://tiles.example.net', OSM]);
  } finally { delete globalThis.location; }
});

test('the command line: the flag is the consent, and anything that is not a site or a known service is refused', () => {
  const { grants, refused } = core.fromFlags({ gazetteer: ['whg', 'https://gaz.example.org/reconcile'], allowHost: ['https://maps.example.org', 'not a host'] });
  assert.equal(core.check(grants, 'gazetteer', 'whg'), 'allowed');
  assert.equal(core.check(grants, 'gazetteer', 'https://gaz.example.org'), 'allowed');
  assert.equal(core.check(grants, 'iiif', 'https://maps.example.org'), 'allowed');
  assert.equal(core.check(grants, 'basemap', 'osm'), 'undecided');
  assert.deepEqual(refused, ['not a host']);
  assert.equal(core.check(core.fromFlags({}).grants, 'gazetteer', 'whg'), 'undecided');
});

// ---- The policy written into each page's <head> --------------------------------------------------
function runHead({ local = new Store(), session = new Store() } = {}) {
  const head = { prepended: [], prepend(m) { this.prepended.push(m); } };
  const document = { head, createElement: () => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }) };
  const window = {};
  vm.runInNewContext(headScript(), { document, window, localStorage: local, sessionStorage: session, URL });
  // Arrays made in the other context are not this one's: compared as data.
  return { meta: head.prepended[0], csp: JSON.parse(JSON.stringify(window.__platoCsp)), local };
}

test('the head script writes the policy of the grants kept, and only their plain sites, before anything else', () => {
  const local = new Store();
  local.setItem('plato-tools.permissions', JSON.stringify({ version: 1, grants: {
    'basemap:osm': { state: 'allowed' }, 'basemap:openfreemap': { state: 'never' },
    'basemap:https://evil.example.org; script-src *': { state: 'allowed' }, 'iiif:https://maps.example.org': { state: 'allowed' } } }));
  const session = new Store(); session.setItem('plato-tools.permissions.tab', JSON.stringify(['gazetteer:whg', 'basemap:openfreemap', 42]));
  const { meta, csp } = runHead({ local, session });
  assert.equal(meta.attrs['http-equiv'], 'Content-Security-Policy');
  assert.deepEqual(csp.origins, ['https://maps.example.org', OSM, 'https://whgazetteer.org', 'https://www.whgazetteer.org']);
  assert.ok(meta.attrs.content.includes(`connect-src 'self' blob: https://maps.example.org ${OSM}`));
  assert.ok(!meta.attrs.content.includes('evil') && !meta.attrs.content.includes('openfreemap'), meta.attrs.content);
  assert.equal(meta.attrs.content, core.policyFor(csp.origins), 'the page and the core agree');
});

test('the head script fails closed: storage it cannot read gives the policy of nothing allowed, still written', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
  const { meta, csp } = runHead({ local: broken, session: broken });
  assert.deepEqual(csp.origins, []);
  assert.equal(meta.attrs.content, core.policyFor([]));
  assert.ok(meta.attrs.content.includes("connect-src 'self' blob:;"));
});

test('the head script carries Chora\'s old consents over, as the module does, and the policy has them', () => {
  const local = new Store();
  local.setItem('chora-basemap-consent', JSON.stringify(['https://tiles.openfreemap.org']));
  const { csp } = runHead({ local });
  assert.deepEqual(csp.origins, ['https://tiles.openfreemap.org']);
  assert.equal(local.getItem('chora-basemap-consent'), null);
  assert.equal(JSON.parse(local.getItem('plato-tools.permissions')).grants['basemap:openfreemap'].state, 'allowed');
});

test('the build puts the head script where each page marks it, and refuses a page without the mark', () => {
  const plugin = cspPlugin(), root = new URL('../', import.meta.url).pathname;
  const out = plugin.transformIndexHtml.handler(`<head><meta charset="utf-8">${HEAD_MARK}</head>`, { filename: `${root}chora.html` });
  assert.ok(out.includes('<script>') && out.includes('Content-Security-Policy') && !/^\s*export\b/m.test(out));
  assert.throws(() => plugin.transformIndexHtml.handler('<head></head>', { filename: `${root}index.html` }), /plato:csp/);
  assert.equal(plugin.transformIndexHtml.handler('<head></head>', { filename: `${root}spike/index.html` }), '<head></head>');
});
