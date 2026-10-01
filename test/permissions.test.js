// The permissions module (src/lib/permissions.js and its pure core) and the policy written into each
// page's <head> (scripts/vite-csp.mjs). Each test of a refusal has its control beside it: the same
// request, allowed, does go.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../src/lib/permissions-core.js';
import * as permissions from '../src/lib/permissions.js';
import { readFileSync } from 'node:fs';
import { headScript, HEAD_MARK, cspPlugin } from '../scripts/vite-csp.mjs';
import { checkPolicy } from '../src/lib/csp.js';

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
  permissions.resetForTests();
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
  // The first read after load carries them over, with no call to migrate().
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
  // Written after that first read (by an older Chora in another tab): not carried over on the way to a
  // request, which transformRequest makes at every tile; carried over by migrate() (the storage event's).
  localStorage.setItem('chora-basemap-consent', JSON.stringify(['https://late.example.org']));
  assert.equal(permissions.state('basemap', 'https://late.example.org'), 'undecided');
  assert.notEqual(localStorage.getItem('chora-basemap-consent'), null);
  permissions.migrate();
  assert.equal(permissions.state('basemap', 'https://late.example.org'), 'allowed');
  // A grant already made is not changed by a later carrying over.
  permissions.set('basemap', 'osm', 'never');
  localStorage.setItem('chora-basemap-consent', JSON.stringify([OSM]));
  permissions.migrate();
  assert.equal(permissions.state('basemap', 'osm'), 'never');
  // The whole of CARTO's list makes the provider's permission.
  assert.equal(core.check(core.migrateBasemapConsent({}, carto), 'basemap', 'carto'), 'allowed');
});

test('a redirect is never followed: an answer that is one is refused, wherever it points; a plain answer is used', async () => {
  inPolicy(...core.REGISTRY.basemap.carto.origins);
  permissions.set('basemap', 'carto', 'allowed');
  const style = 'https://basemaps.cartocdn.com/style.json';
  // What fetch gives with redirect: 'manual' for a redirect: an opaque answer, status 0, no address.
  permissions.configure({ fetch: stub(() => ({ ok: false, type: 'opaqueredirect', status: 0, url: '' })) });
  await assert.rejects(permissions.fetch(style, { cat: 'basemap', subj: 'carto' }), (e) => e.kind === 'moved' && !e.message.includes('style.json'));
  assert.equal(calls[0].init.redirect, 'manual');
  // A fetch that shows the redirect itself (Node's, say) is refused the same.
  permissions.configure({ fetch: stub(() => ({ ok: false, status: 302, url: style })) });
  await assert.rejects(permissions.fetch(style, { cat: 'basemap', subj: 'carto' }), { kind: 'moved' });
  // And an answer that says it came from elsewhere.
  permissions.configure({ fetch: stub(() => ({ ok: true, status: 200, url: 'https://elsewhere.example.org/style.json' })) });
  await assert.rejects(permissions.fetch(style, { cat: 'basemap', subj: 'carto' }), (e) => e.kind === 'moved' && e.landed === 'https://elsewhere.example.org');
  // The control: a plain answer is used.
  permissions.configure({ fetch: stub(() => ({ ok: true, status: 200, type: 'cors', url: style })) });
  assert.equal((await permissions.fetch(style, { cat: 'basemap', subj: 'carto' })).ok, true);
});

test('only https sites, or http on this computer, with a port no higher than 65535, can be permissions', () => {
  for (const o of ['https://a.example.org', 'http://localhost:5173', 'http://127.0.0.1', 'https://a.example.org:65535']) assert.ok(core.isOrigin(o), o);
  for (const o of ['http://a.example.org', 'https://a.example.org:65536', 'https://a.example.org:99999', 'https://a.example.org:0443', 'http://10.0.0.1', 'HTTPS://A.org']) assert.ok(!core.isOrigin(o), o);
  assert.equal(core.parse('iiif', 'http://maps.example.org'), null);
  assert.ok(!core.policyFor(['http://maps.example.org', 'https://x.example.org:70000']).includes('example'));
});

test('what is remembered is shown by host and name only: a pasted basemap\'s address and key are not given out', () => {
  localStorage.setItem('chora-basemaps', JSON.stringify([{ id: 'pasted-1', url: 'https://tiles.example.org/style.json?api_key=SECRETKEY' }, { id: 'pasted-2', tiles: 'https://plain.example.org/{z}/{x}/{y}.png' }]));
  localStorage.setItem('plato-tools.reviewer', JSON.stringify({ name: 'Ada', orcid: 'https://orcid.org/0000-0002-1825-0097' }));
  const r = permissions.remembered(), text = JSON.stringify(r);
  assert.deepEqual(r.find((x) => x.key === 'chora-basemaps').value, { basemaps: [{ host: 'tiles.example.org', key: true }, { host: 'plain.example.org', key: false }] });
  assert.ok(!text.includes('SECRETKEY') && !text.includes('style.json'), text);
  assert.equal(r.find((x) => x.key === 'plato-tools.reviewer').value.name, 'Ada');
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

test('the command line: the flag is the consent; --allow-host grants only the category the command asks, or the service it names', () => {
  const { grants, refused } = core.fromFlags({ gazetteer: ['whg', 'https://gaz.example.org/reconcile'], allowHost: ['https://maps.example.org', 'allmaps', 'not a host'], hostCategory: 'iiif' });
  assert.equal(core.check(grants, 'gazetteer', 'whg'), 'allowed');
  assert.equal(core.check(grants, 'gazetteer', 'https://gaz.example.org'), 'allowed');
  assert.equal(core.check(grants, 'iiif', 'https://maps.example.org'), 'allowed');
  assert.equal(core.check(grants, 'linked', 'https://maps.example.org'), 'undecided', 'a host for historical maps is not a linked site too');
  assert.equal(core.check(grants, 'allmaps', 'allmaps'), 'allowed', 'a value naming a known service grants that service');
  assert.equal(core.check(grants, 'basemap', 'osm'), 'undecided');
  assert.deepEqual(refused, ['not a host']);
  // A host with no category to grant it for is refused, not granted for every one.
  assert.deepEqual(core.fromFlags({ allowHost: ['https://maps.example.org'] }).refused, ['https://maps.example.org']);
  assert.deepEqual(core.fromFlags({ allowHost: ['http://maps.example.org'], hostCategory: 'iiif' }).refused, ['http://maps.example.org']);
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
  assert.throws(() => plugin.transformIndexHtml.handler('<head></head>', { filename: `${root}spike/index.html` }), /plato:csp/);
});

test('every page the site builds carries the mark, the spike page included: none is served outside the policy', async () => {
  const root = new URL('../', import.meta.url).pathname;
  const { default: config } = await import('../vite.config.js');
  const cfg = typeof config === 'function' ? config({ command: 'build', mode: 'production' }) : config;
  const pages = Object.values(cfg.build.rollupOptions.input).map((p) => String(p).replace(/\\/g, '/'));
  assert.ok(pages.some((p) => p.endsWith('/index.html')) && pages.some((p) => p.endsWith('/spike/index.html')), pages.join(', '));
  for (const p of pages) assert.ok(readFileSync(p, 'utf8').includes(HEAD_MARK), `${p.replace(root, '')} has no ${HEAD_MARK}`);
});

test('the canary\'s second half: the policy in force must be exactly the one written from the permissions', () => {
  const origins = ['https://maps.example.org'];
  const written = { policy: core.policyFor(origins), origins };
  const doc = (...contents) => ({ querySelectorAll: () => contents.map((c) => ({ getAttribute: (k) => (k === 'http-equiv' ? 'Content-Security-Policy' : c) })) });
  assert.deepEqual(checkPolicy(doc(written.policy), written), { ok: true });
  const widened = written.policy.replace("connect-src 'self' blob:", "connect-src 'self' blob: *");
  assert.equal(checkPolicy(doc(widened), written).ok, false, 'a policy widened to every site');
  assert.equal(checkPolicy(doc(widened), { policy: widened, origins }).ok, false, 'even when published as written');
  const dataAllowed = written.policy.replace("connect-src 'self' blob:", "connect-src 'self' blob: data:");
  assert.equal(checkPolicy(doc(dataAllowed), { policy: dataAllowed, origins }).ok, false);
  assert.equal(checkPolicy(doc(written.policy, written.policy), written).ok, false, 'two policies');
  assert.equal(checkPolicy(doc(), written).ok, false, 'none in force');
  assert.equal(checkPolicy(doc(written.policy), null).ok, false, 'none written');
  const forged = { policy: core.policyFor(['https://maps.example.org', '*']), origins: ['https://maps.example.org', '*'] };
  assert.equal(checkPolicy(doc(forged.policy), forged).ok, false, 'a site that is not one');
});

// ---- The follow-up of 1 October 2026 (permissions-next) -------------------------------------------
import { readFileSync } from 'node:fs';
import * as words from '../src/lib/permission-words.js';

test('"Keep large datasets\' working files": persist() is asked only on the choice, once, and its answer remembered', async () => {
  let asked = 0, answer = true;
  const nav = { storage: { persist: async () => { asked++; return answer; } } };
  const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  try {
    assert.equal(permissions.persistChoice(), null, 'nothing chosen yet');
    assert.equal(asked, 0, 'never asked on the way in');
    let r = await permissions.choosePersist(true);
    assert.equal(r.granted, true); assert.equal(asked, 1);
    r = await permissions.choosePersist(true);   // chosen already: the browser is not asked again
    assert.equal(asked, 1); assert.equal(r.granted, true);
    permissions.resetForTests();                 // the next visit: remembered, not asked
    assert.equal(permissions.persistChoice().granted, true); assert.equal(asked, 1);
    await permissions.choosePersist(false);
    assert.equal(permissions.persistChoice(), null, 'unchosen, forgotten');
    answer = false;
    r = await permissions.choosePersist(true);
    assert.equal(r.granted, false); assert.equal(asked, 2);
    assert.equal(permissions.persistChoice().granted, false, 'a refusal is remembered too');
    await permissions.choosePersist(false);
    nav.storage = {};                            // a browser without it
    r = await permissions.choosePersist(true);
    assert.deepEqual([r.granted, r.unsupported], [false, true]);
    for (const k of ['granted', 'refused', 'unsupported']) assert.equal(typeof words.PANEL.persistResult[k], 'string', k);
  } finally {
    if (before) Object.defineProperty(globalThis, 'navigator', before); else delete globalThis.navigator;
  }
});

test('what the historical maps and Allmaps learn, the trace a reload would lose, and the maps the working data keeps, in words (e2 R1-R4)', () => {
  const iiif = words.CATEGORY_WORDS.iiif.learns;
  assert.ok(/manifest/.test(iiif) && /georeference/.test(iiif), iiif);
  assert.ok(iiif.includes('Tracing from a map asks its server for the part you click, in more detail.'), iiif);
  assert.equal(words.RELOAD_LOSES.tracing, 'The trace being proposed now, not yet accepted.');
  const allmaps = words.CATEGORY_WORDS.allmaps.learns;
  assert.ok(/Allmaps Editor/.test(allmaps) && /address/.test(allmaps), allmaps);
  assert.ok(words.PANEL.keepWorkNote.includes('the historical maps you showed'), words.PANEL.keepWorkNote);
});

test('the token is said to be held for the tab or remembered, as it is, and only WHG can revoke it (fc)', () => {
  assert.equal(typeof words.PANEL.tokenHeld, 'function');
  const tab = words.PANEL.tokenHeld(false), kept = words.PANEL.tokenHeld(true);
  assert.ok(/this tab/.test(tab) && !/remembered/.test(tab), tab);
  assert.ok(/remembered in this browser/.test(kept) && !/this tab/.test(kept), kept);
  assert.ok(/regenerat/.test(words.PANEL.tokenRevoke) && /World Historical Gazetteer/.test(words.PANEL.tokenRevoke), words.PANEL.tokenRevoke);
});

// A page element, as much of one as needs() uses.
function fakeEl() {
  const el = { children: [], hidden: false, dataset: {}, isConnected: true, classList: { add() {} },
    ownerDocument: { createElement: () => ({ type: '', textContent: '', className: '' }) },
    replaceChildren(...c) { this.children = [...c]; }, append(...c) { this.children.push(...c); },
    get text() { return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); } };
  return el;
}

test('needs() for several sites at once: one line naming those still to allow, gone once all are, silent if one is Never (e2 R5)', () => {
  const pairs = [['iiif', 'https://maps.example.org'], ['iiif', 'https://images.example.org']];
  const el = fakeEl();
  permissions.needs(el, pairs);
  assert.equal(el.hidden, false);
  assert.ok(el.text.startsWith('Needs permission: maps.example.org and images.example.org'), el.text);
  assert.equal(el.dataset.permission, 'iiif:https://maps.example.org');
  inPolicy('https://maps.example.org');
  permissions.set('iiif', 'https://maps.example.org', 'allowed');
  assert.ok(el.text.startsWith('Needs permission: images.example.org'), el.text);
  assert.equal(el.dataset.permission, 'iiif:https://images.example.org', 'the panel opens at the one still to decide');
  inPolicy('https://maps.example.org', 'https://images.example.org');
  permissions.set('iiif', 'https://images.example.org', 'allowed');
  assert.equal(el.hidden, true, 'all allowed: no line');
  permissions.set('iiif', 'https://images.example.org', 'never');
  assert.equal(el.hidden, true, 'one Never: the feature does without, and says nothing');
  // The one-site form is as it was.
  const one = fakeEl();
  permissions.needs(one, 'basemap', 'osm');
  assert.ok(one.text.startsWith('Needs permission: OpenStreetMap'), one.text);
  assert.throws(() => permissions.needs(fakeEl(), [['basemap', 'https://evil.example.org; script-src *']]), TypeError);
});

test('DEVELOPERS.md names no module that is gone, and says what happens to a redirect', () => {
  const dev = readFileSync(new URL('../DEVELOPERS.md', import.meta.url), 'utf8');
  assert.ok(!dev.includes('src/lib/whg-token.js'), 'src/lib/whg-token.js is not in the tools');
  assert.ok(dev.includes('**Redirects.**'), 'a Redirects note');
});

test('an answer is checked by one pure rule, for the page and for Node alike: a redirect, or an answer from elsewhere, is refused (b7)', () => {
  const sites = ['https://maps.example.org'];
  const url = 'https://maps.example.org/a/info.json';
  assert.equal(core.checkAnswer({ status: 200, type: 'cors', url }, url, sites), null);
  assert.equal(core.checkAnswer({ status: 0, type: 'opaqueredirect', url: '' }, url, sites).kind, 'moved', 'a browser\'s redirect');
  for (const status of [301, 302, 303, 307, 308]) assert.equal(core.checkAnswer({ status, url }, url, sites).kind, 'moved', `Node's ${status}`);
  const away = core.checkAnswer({ status: 200, url: 'https://elsewhere.example.org/x' }, url, sites);
  assert.deepEqual([away.kind, away.landed], ['moved', 'https://elsewhere.example.org']);
  assert.equal(core.checkAnswer({ status: 404, url }, url, sites), null, 'a status that is not a redirect is the caller\'s to read');
  assert.equal(core.checkAnswer(null, url, sites).kind, 'network');
});

test('an http site is refused with words, as insecure, and needs() says so rather than throwing (b7)', async () => {
  assert.equal(core.isInsecure('http://maps.example.org'), true);
  assert.equal(core.isInsecure('http://localhost:5173'), false);
  assert.equal(core.isInsecure('https://maps.example.org'), false);
  const el = fakeEl();
  assert.equal(permissions.needs(el, 'iiif', 'http://maps.example.org'), 'insecure');
  assert.equal(el.hidden, false);
  assert.ok(/maps\.example\.org/.test(el.text) && /https/.test(el.text), el.text);
  assert.equal(el.children.some((c) => typeof c !== 'string'), false, 'no Permissions button: allowing could not help');
  inPolicy('https://maps.example.org'); permissions.set('iiif', 'https://maps.example.org', 'allowed');
  await assert.rejects(permissions.fetch('http://maps.example.org/a/info.json', { cat: 'iiif', subj: 'http://maps.example.org' }), (e) => e.kind === 'insecure' && /https/.test(e.message));
  await assert.rejects(permissions.fetch('http://maps.example.org/a/info.json', { cat: 'iiif', subj: 'https://maps.example.org' }), { kind: 'insecure' });
  assert.equal(calls.length, 0);
  // Several sites, one of them http: the line says so, and offers nothing to allow.
  const two = fakeEl();
  assert.equal(permissions.needs(two, [['iiif', 'https://images.example.org'], ['iiif', 'http://maps.example.org']]), 'insecure');
  assert.ok(/maps\.example\.org/.test(two.text), two.text);
  // Still thrown for what is no site at all.
  assert.throws(() => permissions.needs(fakeEl(), 'iiif', 'not a site'), TypeError);
});

test('the canary says in the console, once per load, that the blocked data: request is its own test, or that the page is not protected', async () => {
  const said = [];
  const log = { info: (m) => said.push(['info', m]), warn: (m) => said.push(['warn', m]) };
  permissions.announceCanary({ enforced: true }, log);
  assert.equal(said.length, 1);
  assert.equal(said[0][0], 'info');
  assert.ok(said[0][1].includes('data:text/plain,canary') && /deliberate test/.test(said[0][1]) && /blocked, as it should be/.test(said[0][1]), said[0][1]);
  permissions.announceCanary({ enforced: false, why: 'no policy was written' }, log);
  assert.equal(said[1][0], 'warn');
  assert.ok(said[1][1].includes(words.PANEL.notProtected) && said[1][1].includes('no policy was written'), said[1][1]);
  // From the canary itself, once per load however often it is asked (here, in Node, it finds no policy).
  const warn = console.warn, info = console.info, seen = [];
  console.warn = (m) => seen.push(['warn', m]); console.info = (m) => seen.push(['info', m]);
  try {
    permissions.resetForTests(); delete globalThis.__platoCsp;
    assert.equal(await permissions.enforced(), false);
    assert.equal(await permissions.enforced(), false);
  } finally { console.warn = warn; console.info = info; }
  assert.equal(seen.length, 1, JSON.stringify(seen));
  assert.equal(seen[0][0], 'warn');
});
