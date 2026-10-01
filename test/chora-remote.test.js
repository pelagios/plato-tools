// Chora's fetch of a historical map's documents (src/chora/remote.js), over the real permissions
// module (src/lib/permissions.js) with its network stubbed: which permission an address is asked
// under, the redirects avoided before asking (measured 1 October 2026: DEVELOPERS.md, Permissions),
// and what is said of one that still forwards. Each refusal has its control beside it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/lib/permissions-core.js';
import * as permissions from '../src/lib/permissions.js';
import * as remote from '../src/chora/remote.js';
import { allmapsLookupUrl } from '../src/engine/georef/index.js';

class Store {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
const IIIF = 'https://iiif.example.org';
let calls;
const answer = (body, extra = {}) => ({ ok: true, status: 200, type: 'cors', json: async () => body, ...extra });
const stub = (fn) => async (url, init) => { calls.push({ url, init }); return { url, ...fn(url, init) }; };
const inPolicy = (...origins) => { globalThis.__platoCsp = { policy: core.policyFor(origins), origins }; };

beforeEach(() => {
  globalThis.localStorage = new Store();
  globalThis.sessionStorage = new Store();
  inPolicy();
  calls = [];
  permissions.resetForTests();
  permissions.configure({ fetch: stub(() => answer({ ok: 1 })), enforced: async () => true });
});

test('an address is asked under its own permission: Allmaps\' annotation server is allmaps:allmaps, any other site iiif:<site>', () => {
  assert.deepEqual(remote.subjectOf('https://annotations.allmaps.org/maps/0000000000000001'), ['allmaps', 'allmaps']);
  assert.deepEqual(remote.subjectOf(`${IIIF}/iiif/grid/info.json`), ['iiif', IIIF]);
  assert.deepEqual(remote.subjectOf('http://www.davidrumsey.com/luna/x'), ['iiif', 'https://www.davidrumsey.com'], 'asked over https');
  assert.deepEqual(remote.subjectOf('http://127.0.0.1:8123/iiif/grid'), ['iiif', 'http://127.0.0.1:8123'], 'this computer, over http');
  assert.equal(remote.keyOfUrl(`${IIIF}/m`), `iiif:${IIIF}`);
  // Nothing that cannot be a permission: a host the policy could not name, another scheme, not an address.
  for (const bad of ['https://my_host.example.org/x', 'ftp://example.org/x', 'javascript:alert(1)', 'not an address']) assert.equal(remote.subjectOf(bad), null, bad);
});

test('redirects avoided before asking: http becomes https (this computer\'s excepted), and an image\'s information is {id}/info.json with no trailing slash', () => {
  assert.equal(remote.upgrade('http://www.davidrumsey.com/luna/servlet/iiif/m/X/manifest'), 'https://www.davidrumsey.com/luna/servlet/iiif/m/X/manifest');
  assert.equal(remote.upgrade('http://localhost:5173/x'), 'http://localhost:5173/x');
  assert.equal(remote.upgrade('https://example.org/a?b=c'), 'https://example.org/a?b=c');
  assert.equal(remote.infoUrl(`${IIIF}/iiif/grid`), `${IIIF}/iiif/grid/info.json`);
  assert.equal(remote.infoUrl(`${IIIF}/iiif/grid/`), `${IIIF}/iiif/grid/info.json`);
  assert.equal(remote.infoUrl(`${IIIF}/iiif/grid/info.json`), `${IIIF}/iiif/grid/info.json`);
  assert.equal(remote.infoUrl('http://tile.loc.gov/image-services/iiif/x'), 'https://tile.loc.gov/image-services/iiif/x/info.json');
});

test('Allmaps is asked at /images/<id>, computed here, never ?url=', async () => {
  const id = `${IIIF}/iiif/grid`;
  assert.deepEqual(await remote.allmapsImageUrls(id), [await allmapsLookupUrl(id)]);
  assert.match((await remote.allmapsImageUrls(id))[0], /^https:\/\/annotations\.allmaps\.org\/images\/[0-9a-f]{16}$/);
  // Named over http: as written (Allmaps hashes the id as written), and over https.
  const both = await remote.allmapsImageUrls('http://www.example.org/iiif/x');
  assert.equal(both.length, 2);
  assert.ok(both.every((u) => !u.includes('?')));
});

test('fetchJson asks through the permissions: nothing before the permission is allowed and in the policy; then the document', async () => {
  await assert.rejects(remote.fetchJson(`${IIIF}/m`), { name: 'PermissionError', kind: 'undecided' });
  permissions.set('iiif', IIIF, 'allowed');
  await assert.rejects(remote.fetchJson(`${IIIF}/m`), { name: 'PermissionError', kind: 'reload' });
  assert.equal(calls.length, 0);
  inPolicy(IIIF);
  assert.deepEqual(await remote.fetchJson(`${IIIF}/m`), { ok: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.redirect, 'manual');
  // Set to Never: refused, and not asked.
  permissions.set('iiif', IIIF, 'never');
  await assert.rejects(remote.fetchJson(`${IIIF}/m`), { kind: 'never' });
  assert.equal(calls.length, 1);
  // An address that cannot be a permission is refused before the module is asked.
  await assert.rejects(remote.fetchJson('https://my_host.example.org/m'), (e) => e instanceof remote.RemoteError && e.kind === 'address');
});

test('an http address is asked over https, under the https site\'s permission', async () => {
  permissions.set('iiif', 'https://www.example.org', 'allowed'); inPolicy('https://www.example.org');
  await remote.fetchJson('http://www.example.org/iiif/m');
  assert.equal(calls[0].url, 'https://www.example.org/iiif/m');
});

test('a document that answers with a redirect is refused in c2\'s words, which name no host, with the address offered to open', async () => {
  permissions.set('iiif', IIIF, 'allowed'); inPolicy(IIIF);
  permissions.configure({ fetch: stub(() => ({ ok: false, type: 'opaqueredirect', status: 0 })) });
  await assert.rejects(remote.fetchJson(`${IIIF}/ark:/1/x`), (e) => e instanceof remote.RemoteError && e.kind === 'moved' && e.url === `${IIIF}/ark:/1/x` && e.message === remote.FORWARDS);
  assert.equal(remote.FORWARDS, 'This address forwards to another one, which PLATO tools does not follow. Open it in a new tab, and paste the address it ends at.');
  // The control: the same address answering with the document is used.
  permissions.configure({ fetch: stub(() => answer({ here: true })) });
  assert.deepEqual(await remote.fetchJson(`${IIIF}/ark:/1/x`), { here: true });
});

test('a redirect is refused without its Location ever being read, so a relative or scheme-relative one needs no resolving', async () => {
  permissions.set('iiif', IIIF, 'allowed'); inPolicy(IIIF);
  const read = [];
  const headers = new Proxy({}, { get(_, k) { read.push(String(k)); return (...a) => { read.push(`${String(k)}(${a.join(',')})`); return '//elsewhere.example.org/x'; }; } });
  for (const status of [301, 302, 303, 307, 308]) {
    permissions.configure({ fetch: stub(() => ({ ok: false, type: 'cors', status, headers })) });
    await assert.rejects(remote.fetchJson(`${IIIF}/iiif/grid`), (e) => e.kind === 'moved');
  }
  assert.deepEqual(read, [], 'the headers were not touched');
  // The control: the proxy does record a read when one is made.
  headers.get('Location');
  assert.deepEqual(read, ['get', 'get(Location)']);
});

test('a document not found, or not JSON, is said so by its site, never by its address', async () => {
  permissions.set('iiif', IIIF, 'allowed'); inPolicy(IIIF);
  permissions.configure({ fetch: stub(() => ({ ok: false, status: 404, type: 'cors' })) });
  await assert.rejects(remote.fetchJson(`${IIIF}/secret?key=123`), (e) => e.kind === 'status' && e.status === 404 && !e.message.includes('secret') && e.message.includes(IIIF));
  permissions.configure({ fetch: stub(() => ({ ok: true, status: 200, type: 'cors', json: async () => { throw new SyntaxError('x'); } })) });
  await assert.rejects(remote.fetchJson(`${IIIF}/secret?key=123`), (e) => e.kind === 'not-json' && !e.message.includes('secret'));
});

test('Allmaps\' answers are asked under allmaps:allmaps alone: allowing a map\'s server does not allow Allmaps', async () => {
  const u = 'https://annotations.allmaps.org/images/e564650581f5f6bb';
  permissions.set('iiif', IIIF, 'allowed'); inPolicy(IIIF, 'https://annotations.allmaps.org');
  await assert.rejects(remote.fetchJson(u), { kind: 'undecided' });
  permissions.set('allmaps', 'allmaps', 'allowed');
  const n = calls.length;
  assert.deepEqual(await remote.fetchJson(u), { ok: 1 });
  assert.equal(calls.length, n + 1); assert.equal(calls.at(-1).url, u);
  // And withdrawn, refused at once, though the page's policy still has the site.
  permissions.set('allmaps', 'allmaps', 'undecided');
  await assert.rejects(remote.fetchJson(u), { kind: 'undecided' });
  assert.equal(calls.length, n + 1);
});
