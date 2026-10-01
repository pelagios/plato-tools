// Chora's historical maps: the pins its renderer depends on, and the fixtures its tests use
// (test/fixtures/chora-iiif/, whose README says where each comes from).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as georef from '../src/engine/georef/index.js';

const D = 'test/fixtures/chora-iiif/';
const json = (f) => JSON.parse(readFileSync(D + f, 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const pinned = georef.SOFTWARE.slice(georef.SOFTWARE.lastIndexOf('@') + 1);

// Every copy of a package under node_modules, however deep it is nested.
function copiesOf(name, dir = 'node_modules', found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = join(dir, entry.name);
    if (entry.name.startsWith('@')) {
      for (const sub of readdirSync(p, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const q = join(p, sub.name);
        if (`${entry.name}/${sub.name}` === name) found.push(q);
        copiesOf(name, join(q, 'node_modules'), found);
      }
    } else {
      copiesOf(name, join(p, 'node_modules'), found);
    }
  }
  return found;
}
const versionsIn = (paths) => paths.map((p) => JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).version);
const lockVersions = (name) => Object.entries(lock.packages)
  .filter(([k]) => k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`))
  .map(([, v]) => v.version);

test('the renderer draws with the transformation library the georeference module names, and no other', () => {
  // Presence first, so that "every copy agrees" is not said of no copies.
  const copies = copiesOf('@allmaps/transform');
  assert.ok(copies.length >= 1, 'no @allmaps/transform installed');
  assert.deepEqual([...new Set(versionsIn(copies))], [pinned], `installed copies: ${copies.join(', ')}`);
  const locked = lockVersions('@allmaps/transform');
  assert.ok(locked.length >= 1);
  assert.deepEqual([...new Set(locked)], [pinned]);
  // The renderer is installed, and it is what brings the transformation library in.
  assert.ok(copiesOf('@allmaps/render').length >= 1);
  assert.ok(lock.packages['node_modules/@allmaps/render'].dependencies['@allmaps/transform']);
  // Control: the walk finds a package that is nested, not only one at the top.
  assert.ok(copiesOf('@allmaps/maplibre').length === 1);
  assert.ok(lockVersions('@allmaps/maplibre').length === 1);
});

test('every @allmaps package is pinned to an exact version', () => {
  const allmaps = Object.entries(pkg.dependencies).filter(([k]) => k.startsWith('@allmaps/'));
  assert.ok(allmaps.some(([k]) => k === '@allmaps/maplibre'));
  for (const [k, v] of allmaps) assert.match(v, /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/, `${k} is ${v}, not an exact version`);
  assert.equal(pkg.dependencies['@allmaps/transform'], pinned);
  // Control: the pattern refuses a range.
  assert.doesNotMatch('^1.0.0-beta.44', /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
});

// Web Mercator, written out here rather than taken from the module under test.
const R = 6378137;
const mercY = (lat) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const latOf = (y) => (360 / Math.PI) * Math.atan(Math.exp(y / R)) - 90;

test('the synthetic annotation is a georeference, and each control point goes to its own place', async () => {
  const a = json('annotation.json');
  const g = await georef.readGeoreference(a);
  assert.equal(g.gcps, 4);
  assert.equal(g.transformation, 'polynomial');
  assert.equal(g.imageServiceId, 'https://iiif.example.org/iiif/grid');
  assert.deepEqual(g.image, { width: 512, height: 512 });
  const features = a.body.features;
  assert.equal(features.length, 4);
  for (const f of features) {
    const { geojson } = await georef.toWorld(g, { type: 'Point', coordinates: f.properties.resourceCoords }, { space: 'image', precision: 12 });
    assert.ok(Math.abs(geojson.coordinates[0] - f.geometry.coordinates[0]) < 1e-9, `${f.properties.resourceCoords} → ${geojson.coordinates}`);
    assert.ok(Math.abs(geojson.coordinates[1] - f.geometry.coordinates[1]) < 1e-9, `${f.properties.resourceCoords} → ${geojson.coordinates}`);
    const { geometry } = await georef.toPixels(g, f.geometry, { space: 'image' });
    assert.ok(Math.hypot(geometry.coordinates[0] - f.properties.resourceCoords[0], geometry.coordinates[1] - f.properties.resourceCoords[1]) < 1e-6);
  }
  // Control: a point that is not a control point goes where Web Mercator puts it, which is not
  // halfway in latitude, so the comparison above could have failed.
  const { geojson: centre } = await georef.toWorld(g, { type: 'Point', coordinates: [256, 256] }, { space: 'image', precision: 12 });
  const expected = latOf((mercY(52.22) + mercY(52.19)) / 2);
  assert.ok(Math.abs(centre.coordinates[0] - 0.125) < 1e-9);
  assert.ok(Math.abs(centre.coordinates[1] - expected) < 1e-9, `${centre.coordinates[1]} against ${expected}`);
  assert.ok(Math.abs(centre.coordinates[1] - 52.205) > 1e-6);
});

test('the map lies over Cambridge, a place in the survey fixture', async () => {
  const survey = JSON.parse(readFileSync('test/fixtures/chora/attestation-centric-survey.json', 'utf8'));
  assert.ok(survey.attestations.some((a) => a.about === 'https://whgazetteer.org/example/entity/cambridge'));
  const g = await georef.readGeoreference(json('annotation.json'));
  // Cambridge, the town centre (Great St Mary's), is inside the mask.
  const { geometry } = await georef.toPixels(g, { type: 'Point', coordinates: [0.1183, 52.2053] }, { space: 'image' });
  assert.ok(georef.containsRegion(g, { type: 'Point', coordinates: geometry.coordinates }, { space: 'image' }));
  // Control: a place well away from it is not.
  const { geometry: away } = await georef.toPixels(g, { type: 'Point', coordinates: [0.3, 52.2] }, { space: 'image' });
  assert.ok(!georef.containsRegion(g, { type: 'Point', coordinates: away.coordinates }, { space: 'image' }));
});

test('the Rumsey-shaped manifest has a credit but no licence, and leads to the annotated canvas', async () => {
  const m = json('manifest-rumsey-shaped.json');
  assert.equal(m['@context'], 'http://iiif.io/api/presentation/2/context.json');
  assert.equal(typeof m.attribution, 'string');
  for (const k of ['license', 'rights', 'requiredStatement']) assert.ok(!(k in m), `${k} present`);
  const g = await georef.readGeoreference(json('annotation.json'), { manifest: m });
  assert.equal(g.canvasId, 'https://iiif.example.org/manifests/grid/canvas/c1');
  assert.equal(g.manifestId, m['@id']);
  assert.deepEqual(g.canvas, { width: 512, height: 512 });
});

test('the Allmaps /images response is filed under the id Allmaps gives the image service', async () => {
  const a = json('annotation.json');
  const url = await georef.allmapsLookupUrl(a.target.source.id);
  const file = `allmaps-images-${url.slice(url.lastIndexOf('/') + 1)}.json`;
  assert.ok(existsSync(D + file), file);
  const page = json(file);
  assert.equal(page.type, 'AnnotationPage');
  assert.equal(page.id, url);
  assert.deepEqual(page.items, [a]);
});

test('the image information: v2 and v3 at the annotated server, level 0, one 512-pixel tile; one naming another server', () => {
  const a = json('annotation.json');
  const v2 = json('info-v2.json'), v3 = json('info-v3.json'), foreign = json('info-foreign-id.json');
  assert.equal(v2['@id'], a.target.source.id);
  assert.equal(new URL(v3.id).origin, new URL(a.target.source.id).origin);
  for (const info of [v2, v3, foreign]) {
    assert.equal(info.width, 512);
    assert.deepEqual(info.tiles, [{ width: 512, height: 512, scaleFactors: [1] }]);
  }
  assert.notEqual(new URL(foreign['@id']).origin, new URL(a.target.source.id).origin);
  assert.equal(new URL(foreign['@id']).pathname, new URL(v2['@id']).pathname);
});

// ---- Overlays: what was pasted, what it leads to, and what is admitted (src/chora/overlays.js) ----
// Every document is fetched through src/chora/remote.js's fetchJson; here over a fake network, with
// the permissions given as a list (src/lib/permissions.js itself is tested, with remote.js over it, in
// test/chora-remote.test.js).
import * as ov from '../src/chora/overlays.js';
import * as remote from '../src/chora/remote.js';
import { DataError } from '../src/engine/input.js';

const A = 'https://iiif.example.org', B = 'https://elsewhere.example.org';
const ANN = json('annotation.json'), MANIFEST = json('manifest-rumsey-shaped.json');
const ALLMAPS = ['allmaps', 'allmaps'];
/**
 * A fake network, routed by address, every request recorded in order; `allowed` the permissions that
 * may be asked now, `never` those set to Never. A route { redirect: true } answers as the permissions'
 * fetch does a redirect: refused, 'moved'.
 */
function network(routes, { allowed = [['iiif', A]], never = [] } = {}) {
  const calls = [];
  const ok = new Set(allowed.map((s) => s.join(':'))), no = new Set(never.map((s) => s.join(':')));
  const fetch = async (url, init = {}) => {
    calls.push(String(url));
    assert.ok(ok.has(`${init.cat}:${init.subj}`), `${url} was asked under ${init.cat}:${init.subj}, which is not allowed`);
    const r = routes[String(url)];
    if (r === undefined) return { ok: false, status: 404, url: String(url), json: async () => ({}) };
    if (r && r.redirect) throw Object.assign(new Error('moved'), { name: 'PermissionError', kind: 'moved', origin: new URL(url).origin });
    return { ok: true, status: 200, url: String(url), json: async () => structuredClone(r) };
  };
  return {
    calls,
    fetchJson: (u) => remote.fetchJson(u, { fetch }),
    allowed: (c, s) => ok.has(`${c}:${s}`),
    state: (c, s) => (no.has(`${c}:${s}`) ? 'never' : ok.has(`${c}:${s}`) ? 'allowed' : 'undecided'),
    allow: (c, s) => ok.add(`${c}:${s}`),
  };
}
const NOW = () => '2026-09-30T12:00:00.000Z';
const needs = (...subjects) => (e) => e instanceof ov.NeedPermission && JSON.stringify(e.subjects) === JSON.stringify(subjects);
/** A MapLibre map as the layer manager uses it: its style holds Chora's layers and those added to it. */
function fakeMap() {
  const ids = new Set(['chora-overview-clusters']);
  return { on() {}, getLayer: (id) => (ids.has(id) ? { id } : undefined), addLayer: () => ids.add('chora-historical-maps'), removeLayer: (id) => ids.delete(id) };
}
/** What the layer manager gives the renderer for an admitted map: { info, item }. */
async function rendered(a) {
  const got = {};
  class FakeLayer {
    addImageInfos(i) { got.info = i[0]; }
    addGeoreferenceAnnotation(item) { got.item = item; return [{ ok: true, mapId: 'm', index: 0 }]; }
    setMapTransformationType() {}
    setMapOptions() {}
  }
  const map = fakeMap();
  await ov.createLayerManager(map, { Layer: FakeLayer }).add({ ...a, key: 'k', opacity: 1, visible: true });
  assert.ok(got.item && got.info, 'the renderer was given the map');
  return got;
}

test('parseInput tells a georeference, an Allmaps address, a manifest and an image apart, asks over https, and says what it cannot read', () => {
  assert.equal(ov.parseInput(JSON.stringify(ANN)).kind, 'annotation');
  assert.equal(ov.parseInput(JSON.stringify(MANIFEST)).kind, 'manifest-json');
  assert.deepEqual(ov.parseInput(JSON.stringify(json('info-v3.json'))), { kind: 'service', serviceId: `${A}/iiif3/grid` });
  assert.deepEqual(ov.parseInput('56425C69F9CD4F1B'), { kind: 'annotation-url', url: 'https://annotations.allmaps.org/maps/56425c69f9cd4f1b' });
  assert.deepEqual(ov.parseInput('https://annotations.allmaps.org/images/e564650581f5f6bb'), { kind: 'annotation-url', url: 'https://annotations.allmaps.org/images/e564650581f5f6bb' });
  assert.deepEqual(ov.parseInput('https://viewer.allmaps.org/?url=https%3A%2F%2Fexample.org%2Fgeoref.json'), { kind: 'annotation-url', url: 'https://example.org/georef.json' });
  assert.deepEqual(ov.parseInput(`https://editor.allmaps.org/images?url=${encodeURIComponent(A + '/manifests/grid/manifest')}`), { kind: 'manifest', url: `${A}/manifests/grid/manifest` });
  assert.deepEqual(ov.parseInput(`${A}/iiif/grid/info.json`), { kind: 'service', serviceId: `${A}/iiif/grid` });
  assert.deepEqual(ov.parseInput(`${A}/iiif/grid/full/512,/0/default.jpg`), { kind: 'service', serviceId: `${A}/iiif/grid` });
  assert.deepEqual(ov.parseInput('https://www.davidrumsey.com/luna/servlet/iiif/m/RUMSEY~8~1~200375~3001080/manifest'), { kind: 'manifest', url: 'https://www.davidrumsey.com/luna/servlet/iiif/m/RUMSEY~8~1~200375~3001080/manifest' });
  assert.deepEqual(ov.parseInput('https://example.org/something'), { kind: 'url', url: 'https://example.org/something' });
  // http is asked over https (every server measured redirected it there), but for this computer's.
  assert.deepEqual(ov.parseInput('http://www.davidrumsey.com/luna/servlet/iiif/m/X/manifest'), { kind: 'manifest', url: 'https://www.davidrumsey.com/luna/servlet/iiif/m/X/manifest' });
  assert.deepEqual(ov.parseInput('http://annotations.allmaps.org/maps/0000000000000001'), { kind: 'annotation-url', url: 'https://annotations.allmaps.org/maps/0000000000000001' });
  assert.deepEqual(ov.parseInput('http://127.0.0.1:8123/iiif/grid/info.json'), { kind: 'service', serviceId: 'http://127.0.0.1:8123/iiif/grid' });
  for (const bad of ['', 'not a map', '{"type": "Feature"}', '{broken', 'ftp://example.org/x', 'javascript:alert(1)']) assert.equal(ov.parseInput(bad).kind, 'error', bad);
});

test('a georeference pasted needs the image\'s site and the manifest\'s together, before anything is fetched; then reads the manifest', async () => {
  const net = network({ [`${A}/manifests/grid/manifest`]: MANIFEST }, { allowed: [] });
  await assert.rejects(ov.resolve(ov.parseInput(JSON.stringify(ANN)), { ...net, now: NOW }), needs(['iiif', A]));
  assert.deepEqual(net.calls, [], 'nothing asked before it is allowed');
  // Two sites: both named in one NeedPermission, so that one reload brings both.
  const two = structuredClone(ANN); two.target.source.partOf[0].partOf[0].id = `${B}/manifests/grid/manifest`;
  await assert.rejects(ov.resolve({ kind: 'annotation', annotation: two }, { ...net, now: NOW }), needs(['iiif', A], ['iiif', B]));
  net.allow('iiif', A);
  const r = await ov.resolve(ov.parseInput(JSON.stringify(ANN)), { ...net, now: NOW });
  assert.deepEqual(net.calls, [`${A}/manifests/grid/manifest`]);
  assert.equal(r.fetchedAt, null, 'pasted: no retrieval date');
  assert.equal(r.manifest['@id'], MANIFEST['@id']);
  // A manifest that cannot be read: the map is still shown, and the page is told why the canvas size is unknown.
  const r2 = await ov.resolve(ov.parseInput(JSON.stringify(ANN)), { ...network({}), now: NOW });
  assert.equal(r2.manifest, null);
  assert.match(r2.notes[0], /could not be read/);
  // The manifest's site set to Never: not needed, not asked; the map goes on without it, and says so.
  const net3 = network({}, { never: [['iiif', B]] });
  const r3 = await ov.resolve({ kind: 'annotation', annotation: two }, { ...net3, now: NOW });
  assert.equal(r3.manifest, null); assert.deepEqual(net3.calls, []);
  assert.match(r3.notes[0], /Never/);
});

test('a site that cannot be a permission is refused in words, before anything is asked', async () => {
  const bad = structuredClone(ANN); bad.target.source.id = 'https://my_host.example.org/iiif/grid';
  const net = network({});
  await assert.rejects(ov.resolve({ kind: 'annotation', annotation: bad }, { ...net, now: NOW }), (e) => e instanceof remote.RemoteError && e.kind === 'address' && /my_host\.example\.org/.test(e.message) && /plain https address/.test(e.message));
  assert.deepEqual(net.calls, []);
});

test('an Allmaps address is fetched once Allmaps is allowed, as fetching that georeference, with the time it was fetched; then the map\'s own site is needed', async () => {
  const url = 'https://annotations.allmaps.org/maps/0000000000000001';
  const net = network({ [url]: ANN, [`${A}/manifests/grid/manifest`]: MANIFEST }, { allowed: [] });
  await assert.rejects(ov.resolve(ov.parseInput(url), { ...net, now: NOW }), (e) => needs(ALLMAPS)(e) && e.fetch === url);
  net.allow(...ALLMAPS);
  await assert.rejects(ov.resolve(ov.parseInput(url), { ...net, now: NOW }), needs(['iiif', A]));
  net.allow('iiif', A);
  const r = await ov.resolve(ov.parseInput(url), { ...net, now: NOW });
  assert.equal(r.fetchedAt, NOW());
  // Nothing before it was allowed; the georeference on each of the next two tries; then the manifest.
  assert.deepEqual(net.calls, [url, url, `${A}/manifests/grid/manifest`]);
});

test('a manifest leads to its images, and nothing is looked for until asked; the lookup asks Allmaps at /images/<id> only, never ?url=', async () => {
  const murl = `${A}/manifests/grid/manifest`;
  const net = network({ [murl]: MANIFEST });
  const r = await ov.resolve(ov.parseInput(murl), { ...net, now: NOW });
  assert.deepEqual(r.services, [`${A}/iiif/grid`]);
  assert.equal(r.title, 'A synthetic grid over Cambridge (test fixture)');
  assert.ok(net.calls.every((u) => !u.includes('allmaps')), 'Allmaps not asked');
  await assert.rejects(ov.lookup(r.services, { ...net, now: NOW }), needs(ALLMAPS));
  const byId = await georef.allmapsLookupUrl(`${A}/iiif/grid`);
  const net2 = network({ [byId]: json('allmaps-images-e564650581f5f6bb.json') }, { allowed: [ALLMAPS] });
  const found = await ov.lookup(r.services, { ...net2, now: NOW });
  assert.equal(found.url, byId); assert.equal(found.fetchedAt, NOW());
  assert.deepEqual(net2.calls, [byId]);
  // Allmaps has none: null (the Editor may be offered instead), and ?url= was never asked.
  const net4 = network({}, { allowed: [ALLMAPS] });
  assert.equal(await ov.lookup(r.services, { ...net4, now: NOW }), null);
  assert.deepEqual(net4.calls, [byId]);
  // An image named over http: its id as written, and over https, each hashed as Allmaps does.
  const net5 = network({}, { allowed: [ALLMAPS] });
  await ov.lookup(['http://www.example.org/iiif/x'], { ...net5, now: NOW });
  assert.deepEqual(net5.calls, [await georef.allmapsLookupUrl('http://www.example.org/iiif/x'), await georef.allmapsLookupUrl('https://www.example.org/iiif/x')]);
  assert.ok([...net2.calls, ...net4.calls, ...net5.calls].every((u) => !u.includes('?url=')));
  assert.equal(ov.editorUrl(murl), `https://editor.allmaps.org/images?url=${encodeURIComponent(murl)}`);
  assert.equal(ov.editorUrl(null, `${A}/iiif/grid/`), `https://editor.allmaps.org/images?url=${encodeURIComponent(`${A}/iiif/grid/info.json`)}`);
});

test('Allmaps\' ?url= address for an image is asked at /images/<id>, under Allmaps\' permission; any other address that forwards is still refused', async () => {
  const id = `${A}/iiif/grid`;
  const byId = await georef.allmapsLookupUrl(id);
  // The image's information, and its id alone, each become the lookup Look for a georeference makes.
  const viaInfo = `https://annotations.allmaps.org/?url=${encodeURIComponent(`${id}/info.json`)}`;
  assert.deepEqual(ov.parseInput(viaInfo), { kind: 'allmaps-image', serviceId: id });
  assert.deepEqual(ov.parseInput(`https://annotations.allmaps.org/?url=${encodeURIComponent(id)}`), { kind: 'allmaps-image', serviceId: id });
  // Wrapped twice, it is unwrapped to the same lookup.
  assert.deepEqual(ov.parseInput(`https://annotations.allmaps.org/?url=${encodeURIComponent(viaInfo)}`), { kind: 'allmaps-image', serviceId: id });
  // Not yet allowed: Allmaps' permission is needed, and nothing is asked.
  const net = network({ [byId]: json('allmaps-images-e564650581f5f6bb.json') });
  await assert.rejects(ov.resolve(ov.parseInput(viaInfo), { ...net, now: NOW }), needs(ALLMAPS));
  assert.deepEqual(net.calls, []);
  // Allowed: /images/<id>, never ?url=, and the georeference found there read as one fetched.
  const net2 = network({ [byId]: json('allmaps-images-e564650581f5f6bb.json'), [`${A}/manifests/grid/manifest`]: MANIFEST }, { allowed: [ALLMAPS, ['iiif', A]] });
  const r = await ov.resolve(ov.parseInput(viaInfo), { ...net2, now: NOW });
  assert.equal(r.fetchedAt, NOW()); assert.ok(r.annotation); assert.equal(r.manifestUrl, `${A}/manifests/grid/manifest`);
  assert.deepEqual(net2.calls, [byId, `${A}/manifests/grid/manifest`]);
  // Allmaps has none: said in words, not as an address that forwards.
  const net3 = network({}, { allowed: [ALLMAPS] });
  await assert.rejects(ov.resolve(ov.parseInput(viaInfo), { ...net3, now: NOW }), (e) => e instanceof DataError && /Allmaps has no georeference/.test(e.message));
  assert.deepEqual(net3.calls, [byId]);
  // Controls: Allmaps' own addresses are as they were, and ?url= of a manifest is not rewritten (it forwards, and is refused).
  assert.deepEqual(ov.parseInput('https://annotations.allmaps.org/images/e564650581f5f6bb'), { kind: 'annotation-url', url: 'https://annotations.allmaps.org/images/e564650581f5f6bb' });
  const viaManifest = `https://annotations.allmaps.org/?url=${encodeURIComponent(`${A}/manifests/grid/manifest`)}`;
  assert.equal(ov.parseInput(viaManifest).kind, 'annotation-url');
  const net4 = network({ [viaManifest]: { redirect: true } }, { allowed: [ALLMAPS] });
  await assert.rejects(ov.resolve(ov.parseInput(viaManifest), { ...net4, now: NOW }), (e) => e instanceof remote.RemoteError && e.kind === 'moved' && e.message === remote.FORWARDS);
  const ark = 'https://ark.example.org/ark:/50959/ks65px29g/manifest';
  const net5 = network({ [ark]: { redirect: true } }, { allowed: [['iiif', 'https://ark.example.org']] });
  await assert.rejects(ov.resolve(ov.parseInput(ark), { ...net5, now: NOW }), (e) => e instanceof remote.RemoteError && e.kind === 'moved' && e.message === remote.FORWARDS);
});

test('an address that answers with a redirect: an image\'s id is asked again at its info.json; anything else is refused in c2\'s words, with the address to open', async () => {
  const id = `${A}/iiif/grid`;
  const net = network({ [id]: { redirect: true }, [`${id}/info.json`]: json('info-v2.json') });
  const r = await ov.resolve({ kind: 'url', url: id }, { ...net, now: NOW });
  assert.deepEqual(r.services, [id]);
  assert.deepEqual(net.calls, [id, `${id}/info.json`]);
  const ark = 'https://ark.example.org/ark:/50959/ks65px29g/manifest';
  const net2 = network({ [ark]: { redirect: true } }, { allowed: [['iiif', 'https://ark.example.org']] });
  await assert.rejects(ov.resolve(ov.parseInput(ark), { ...net2, now: NOW }), (e) => e instanceof remote.RemoteError && e.kind === 'moved' && e.message === remote.FORWARDS && e.url === ark);
  // No host is named: none can be read from a redirect the page does not follow.
  assert.doesNotMatch(remote.FORWARDS, /https?:|\.org|\.com/);
});

test('admission: the image information is fetched at {id}/info.json, and a map whose image information names another image is refused', async () => {
  const resolved = { annotation: ANN, manifest: MANIFEST, fetchedAt: null, notes: [] };
  const info = json('info-v2.json');
  const net = network({ [`${A}/iiif/grid/info.json`]: info });
  const a = await ov.admit(resolved, { ...net, enforced: true });
  assert.equal(a.g.imageServiceId, `${A}/iiif/grid`);
  assert.deepEqual(a.info, info);
  assert.equal(a.item, ANN);
  assert.deepEqual(a.subject, ['iiif', A]);
  assert.equal(a.title, 'A synthetic grid over Cambridge (test fixture)');
  assert.deepEqual(net.calls, [`${A}/iiif/grid/info.json`]);
  // Another image's information (the same path on another site): refused, in words.
  const foreign = network({ [`${A}/iiif/grid/info.json`]: json('info-foreign-id.json') });
  await assert.rejects(ov.admit(resolved, { ...foreign, enforced: true }), (e) => e instanceof DataError && e.message.includes(B) && /not shown/.test(e.message));
  // Not merely another site: another image on the same site is refused as well.
  const other = network({ [`${A}/iiif/grid/info.json`]: { ...info, '@id': `${A}/iiif/other` } });
  await assert.rejects(ov.admit(resolved, { ...other, enforced: true }), DataError);
  // A redirect, even within the site, is refused (the permissions' fetch follows none).
  const moved = network({ [`${A}/iiif/grid/info.json`]: { redirect: true } });
  await assert.rejects(ov.admit(resolved, { ...moved, enforced: true }), (e) => e instanceof remote.RemoteError && e.kind === 'moved');
  // With the policy not shown to be enforced, nothing is fetched at all.
  const none = network({ [`${A}/iiif/grid/info.json`]: info });
  await assert.rejects(ov.admit(resolved, { ...none, enforced: false }), (e) => e.message === ov.REFUSED);
  assert.deepEqual(none.calls, []);
  // The image's site not allowed: needed, nothing fetched.
  const unallowed = network({ [`${A}/iiif/grid/info.json`]: info }, { allowed: [] });
  await assert.rejects(ov.admit(resolved, { ...unallowed, enforced: true }), needs(['iiif', A]));
  assert.deepEqual(unallowed.calls, []);
});

test('admission of an image named over http asks over https, and gives the renderer the image under its https id', async () => {
  const H = 'http://www.example.org';
  const ann = JSON.parse(JSON.stringify(ANN).replaceAll(A, H));
  const info = JSON.parse(JSON.stringify(json('info-v2.json')).replaceAll(A, H));   // a server that echoes http
  const net = network({ ['https://www.example.org/iiif/grid/info.json']: info }, { allowed: [['iiif', 'https://www.example.org']] });
  const a = await ov.admit({ annotation: ann, manifest: null, notes: [] }, { ...net, enforced: true });
  assert.deepEqual(net.calls, ['https://www.example.org/iiif/grid/info.json']);
  assert.equal(a.info['@id'], 'https://www.example.org/iiif/grid');
  // Kept as written (it is what is kept, and read again on the next load); the renderer is given it under the https id.
  assert.equal(a.item.target.source.id, `${H}/iiif/grid`, 'the georeference is kept as written');
  const r = await rendered(a);
  assert.equal(r.info['@id'], 'https://www.example.org/iiif/grid');
  assert.equal(r.item.target.source.id, 'https://www.example.org/iiif/grid', 'the renderer is given the image under its https id');
  assert.equal(a.g.imageServiceId, `${H}/iiif/grid`, 'the georeference is cited as written');
  assert.equal(info['@id'], `${H}/iiif/grid`, 'what was fetched is not changed');
});

test('a map named over http, with no georeference id, kept and admitted again on the next load, is the same map: cited over http, under the same key', async () => {
  const H = 'http://www.example.org';
  const ann = JSON.parse(JSON.stringify(ANN).replaceAll(A, H)); delete ann.id;
  const info = JSON.parse(JSON.stringify(json('info-v2.json')).replaceAll(A, H));
  const net = network({ ['https://www.example.org/iiif/grid/info.json']: info }, { allowed: [['iiif', 'https://www.example.org']] });
  const deps = { ...net, now: NOW };
  const first = await ov.admit(await ov.resolve({ kind: 'annotation', annotation: ann }, deps), { ...net, enforced: true });
  assert.equal(first.g.annotationId ?? null, null, 'the control: no georeference id, so the key is the image\'s');
  // What app.js keeps (ov.keep's item), as the file holds it, and admitted again from it, as on the next load.
  const kept = JSON.parse(JSON.stringify({ item: first.item }));
  const again = await ov.admit(await ov.resolve({ kind: 'annotation', annotation: kept.item }, deps), { ...net, enforced: true });
  assert.equal(first.g.imageServiceId, `${H}/iiif/grid`);
  assert.equal(again.g.imageServiceId, `${H}/iiif/grid`, 'still cited over http');
  assert.equal(await ov.keyOf(again.g), await ov.keyOf(first.g), 'the same key, so the same file');
  assert.deepEqual(again.item, first.item);
  // Both are shown from the image's https id.
  assert.equal((await rendered(again)).item.target.source.id, 'https://www.example.org/iiif/grid');
});

test('admission of a page of georeferences gives the renderer the one read, and a manifest that does not belong is set aside, with a note', async () => {
  const page = json('allmaps-images-e564650581f5f6bb.json');
  const net = network({ [`${A}/iiif/grid/info.json`]: json('info-v2.json') });
  const a = await ov.admit({ annotation: page, manifest: null, fetchedAt: NOW(), notes: [] }, { ...net, enforced: true });
  assert.equal(a.item.id, ANN.id);
  assert.equal(a.fetchedAt, NOW());
  const wrong = { ...MANIFEST, sequences: [{ canvases: [{ ...MANIFEST.sequences[0].canvases[0], '@id': `${A}/elsewhere/canvas`, images: [] }] }] };
  const b = await ov.admit({ annotation: ANN, manifest: wrong, notes: [] }, { ...net, enforced: true });
  assert.equal(b.manifest, null);
  assert.match(b.notes.join(' '), /does not match/);
  assert.equal(b.g.canvas, null);
});

test('the transformation the renderer is told is georef\'s name for the georeference\'s own, order and all', async () => {
  assert.equal(ov.allmapsTransformationName, georef.allmapsTransformationName, 'georef\'s, not a copy');
  assert.equal(ov.allmapsTransformationName({ transformation: 'polynomial' }), 'polynomial1');
  assert.equal(ov.allmapsTransformationName({ transformation: 'polynomial2' }), 'polynomial2');
  assert.equal(ov.allmapsTransformationName({ transformation: 'thinPlateSpline' }), 'thinPlateSpline');
  assert.throws(() => ov.allmapsTransformationName({ transformation: 'magic' }), TypeError);
  // polynomial2 is not order 1 in disguise: on control points no affine map fits, they differ.
  const { GcpTransformer } = await import('@allmaps/transform');
  const gcps = [[0, 0, 0, 0], [100, 0, 100, 0], [0, 100, 0, 100], [100, 100, 130, 120], [50, 0, 50, 5], [0, 50, 5, 50], [50, 50, 55, 58]].map(([x, y, X, Y]) => ({ resource: [x, y], geo: [X, Y] }));
  const p1 = new GcpTransformer(gcps, 'polynomial1').transformToGeo([75, 75]);
  const p2 = new GcpTransformer(gcps, ov.allmapsTransformationName({ transformation: 'polynomial2' })).transformToGeo([75, 75]);
  assert.ok(Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) > 1, `${p1} against ${p2}`);
});

test('attribution: the manifest\'s own credit and licence, else David Rumsey\'s by its site; text only, and one neutral line for a non-commercial licence', () => {
  const here = ov.attributionOf(MANIFEST, `${A}/iiif/grid`);
  assert.deepEqual(here, { credit: 'A Synthetic Historical Map Collection', licence: null, licenceLabel: null, nonCommercial: false, from: 'manifest' });
  const rumsey = JSON.parse(JSON.stringify(MANIFEST).replaceAll(A, 'https://www.davidrumsey.com'));
  delete rumsey.attribution;
  const r = ov.attributionOf(rumsey, 'https://www.davidrumsey.com/iiif/grid');
  assert.equal(r.credit, 'David Rumsey Map Collection, David Rumsey Map Center, Stanford University Libraries');
  assert.equal(r.licence, 'https://creativecommons.org/licenses/by-nc-sa/3.0/');
  assert.equal(r.licenceLabel, 'CC BY-NC-SA 3.0');
  assert.ok(r.nonCommercial);
  assert.equal(ov.nonCommercialLine(r), 'The map image is licensed CC BY-NC-SA 3.0; this may bear on how what you trace from it can be reused.');
  const credited = ov.attributionOf({ ...rumsey, attribution: 'Rumsey says so' }, null);
  assert.equal(credited.credit, 'Rumsey says so'); assert.equal(credited.from, 'manifest and table');
  const v3 = ov.attributionOf({ id: 'https://x.example.org/m', type: 'Manifest', requiredStatement: { label: { en: ['Attribution'] }, value: { en: ['<a href="https://evil.example.org"><img src="x">Held by</a> <b>X</b> &amp; Y'] } }, rights: 'https://creativecommons.org/licenses/by/4.0/', logo: [{ id: 'https://x.example.org/logo.png' }], thumbnail: [{ id: 'https://x.example.org/t.jpg' }], homepage: [{ id: 'https://x.example.org/home' }], seeAlso: [{ id: 'https://x.example.org/see' }] }, null);
  assert.deepEqual(v3, { credit: 'Held by X & Y', licence: 'https://creativecommons.org/licenses/by/4.0/', licenceLabel: 'CC BY 4.0', nonCommercial: false, from: 'manifest' });
  assert.doesNotMatch(JSON.stringify(v3), /logo|t\.jpg|home|see|evil|<|>/);
  assert.equal(ov.attributionOf({ license: 'javascript:alert(1)' }, null).licence, null);
  assert.deepEqual(ov.attributionOf(null, `${A}/iiif/grid`), { credit: null, licence: null, licenceLabel: null, nonCommercial: false, from: null });
});

test('the layer manager gives the renderer the image information first, then the georeference, then sets its transformation', async () => {
  const net = network({ [`${A}/iiif/grid/info.json`]: json('info-v2.json') });
  const order2 = structuredClone(ANN); order2.body.transformation = { type: 'polynomial', options: { order: 2 } };
  order2.body.features.push({ type: 'Feature', properties: { resourceCoords: [256, 64] }, geometry: { type: 'Point', coordinates: [0.125, 52.221] } },
    { type: 'Feature', properties: { resourceCoords: [256, 448] }, geometry: { type: 'Point', coordinates: [0.126, 52.19] } });
  const a = await ov.admit({ annotation: order2, manifest: null, notes: [] }, { ...net, enforced: true });
  const log = [];
  class FakeLayer {
    constructor(o) { log.push(['new', o.layerId]); }
    addImageInfos(i) { log.push(['addImageInfos', i[0]['@id']]); return [i[0]['@id']]; }
    addGeoreferenceAnnotation(item) { log.push(['addGeoreferenceAnnotation', item.id]); return [{ ok: true, mapId: 'map-1', index: 0 }]; }
    setMapTransformationType(id, t) { log.push(['setMapTransformationType', id, t]); }
    setMapOptions(id, o) { log.push(['setMapOptions', id, o]); }
    removeGeoreferencedMapById(id) { log.push(['remove', id]); }
    getMapZIndex() { return 0; }
  }
  const map = { on() {}, getLayer: (id) => id === 'chora-overview-clusters', addLayer: (l, before) => log.push(['addLayer', before]) };
  const mf = ov.createLayerManager(map, { Layer: FakeLayer });
  await mf.add({ ...a, key: 'k', opacity: 0.7, visible: true });
  assert.deepEqual(log, [['new', 'chora-historical-maps'], ['addLayer', 'chora-overview-clusters'], ['addImageInfos', `${A}/iiif/grid`],
    ['addGeoreferenceAnnotation', ANN.id], ['setMapTransformationType', 'map-1', 'polynomial2'], ['setMapOptions', 'map-1', { opacity: 0.7, visible: true }]]);
  log.length = 0; const calls = net.calls.length;
  await mf.attach();
  assert.deepEqual(log.map((l) => l[0]), ['new', 'addLayer', 'addImageInfos', 'addGeoreferenceAnnotation', 'setMapTransformationType', 'setMapOptions']);
  assert.equal(net.calls.length, calls);
  assert.ok(mf.remove('k')); assert.deepEqual(log.at(-1), ['remove', 'map-1']);
});

// ---- A page of several georeferences, and the image's id as the renderer keys it -----------------

const ORDER2 = json('annotation-order2.json');
const TWO = { id: 'https://annotations.allmaps.org/images/e564650581f5f6bb', type: 'AnnotationPage', items: [
  { ...ANN, id: 'https://annotations.allmaps.org/maps/00000000000000a1', created: '2026-08-01T00:00:00.000Z', modified: '2026-09-01T10:00:00.000Z' },
  { ...ORDER2, id: 'https://annotations.allmaps.org/maps/00000000000000a2', created: '2026-08-02T00:00:00.000Z', modified: '2026-09-30T10:00:00.000Z' },
] };

test('a page of several georeferences is a choice, offered before anything is fetched, the newest by default; never the reader\'s message', async () => {
  const net = network({ [`${A}/manifests/grid/manifest`]: MANIFEST, [`${A}/iiif/grid/info.json`]: json('info-v2.json') });
  let asked = null;
  await assert.rejects(ov.resolve({ kind: 'annotation', annotation: TWO, fetchedAt: NOW() }, { ...net, now: NOW }), (e) => { asked = e; return e instanceof ov.NeedChoice; });
  assert.deepEqual(net.calls, [], 'nothing fetched before the choice');
  assert.equal(asked.defaultIndex, 1, 'the most recently changed');
  assert.deepEqual(asked.choices.map((c) => [c.index, c.id, c.modified, c.gcps]), [
    [0, TWO.items[0].id, '2026-09-01T10:00:00.000Z', 4], [1, TWO.items[1].id, '2026-09-30T10:00:00.000Z', 9]]);
  assert.ok(asked.choices.every((c) => c.label === 'A synthetic grid'), JSON.stringify(asked.choices));
  assert.doesNotMatch(asked.message, /index option|canvasId/);
  assert.equal(ov.newestChoice([{ index: 0, modified: '2026-09-30T00:00:00Z' }, { index: 1, modified: '2026-01-01T00:00:00Z' }, { index: 2 }]), 0);
  assert.equal(ov.newestChoice([{ index: 0 }, { index: 1 }]), 0);
  const r = await ov.resolve({ kind: 'annotation', annotation: TWO, fetchedAt: NOW(), index: 0 }, { ...net, now: NOW });
  assert.equal(r.annotation.id, TWO.items[0].id); assert.equal(r.fetchedAt, NOW());
  const a = await ov.admit(r, { ...net, enforced: true });
  assert.equal(a.g.annotationId, TWO.items[0].id); assert.equal(a.item.id, TWO.items[0].id);
  await assert.rejects(ov.admit({ annotation: TWO, manifest: null, notes: [] }, { ...net, enforced: true }), (e) => e instanceof ov.NeedChoice && e.defaultIndex === 1);
  const url = 'https://annotations.allmaps.org/images/e564650581f5f6bb';
  const net2 = network({ [url]: TWO }, { allowed: [ALLMAPS] });
  await assert.rejects(ov.resolve(ov.parseInput(url), { ...net2, now: NOW }), (e) => e instanceof ov.NeedChoice && e.url === url && e.fetchedAt === NOW() && e.annotation.items.length === 2);
  assert.deepEqual(net2.calls, [url]);
});

test('admission gives the renderer the georeference with the image\'s id exactly as the image information gives it, which is how the renderer looks it up', async () => {
  const slash = structuredClone(ANN); slash.target.source.id = `${A}/iiif/grid/`;
  const net = network({ [`${A}/iiif/grid/info.json`]: json('info-v2.json') });
  const a = await ov.admit({ annotation: slash, manifest: null, notes: [] }, { ...net, enforced: true });
  assert.equal((await rendered(a)).item.target.source.id, `${A}/iiif/grid`);
  assert.equal(a.item.target.source.id, `${A}/iiif/grid/`, 'kept as written');
  assert.deepEqual(net.calls, [`${A}/iiif/grid/info.json`], 'asked with no trailing slash');
  assert.equal(slash.target.source.id, `${A}/iiif/grid/`, 'what was given is not changed');
  const v3 = structuredClone(json('info-v3.json')); v3.id = `${A}/iiif3/grid/`;
  const plain = structuredClone(ANN); plain.target.source.id = `${A}/iiif3/grid`;
  const b = await ov.admit({ annotation: plain, manifest: null, notes: [] }, { ...network({ [`${A}/iiif3/grid/info.json`]: v3 }), enforced: true });
  assert.equal((await rendered(b)).item.target.source.id, `${A}/iiif3/grid/`);
  assert.equal(b.item.target.source.id, `${A}/iiif3/grid`, 'kept as written');
  const same = await ov.admit({ annotation: ANN, manifest: null, notes: [] }, { ...network({ [`${A}/iiif/grid/info.json`]: json('info-v2.json') }), enforced: true });
  assert.equal((await rendered(same)).item.target.source.id, ANN.target.source.id);
  assert.equal(same.item, ANN);
});

test('a map added while a new basemap has taken the layer away is shown in a new layer, not the one taken away', async () => {
  const a = await ov.admit({ annotation: ANN, manifest: null, notes: [] }, { ...network({ [`${A}/iiif/grid/info.json`]: json('info-v2.json') }), enforced: true });
  const log = []; let n = 0;
  class FakeLayer {
    constructor() { this.n = ++n; log.push(['new', this.n]); }
    addImageInfos() { log.push(['addImageInfos', this.n]); }
    addGeoreferenceAnnotation() { log.push(['addGeoreferenceAnnotation', this.n]); return [{ ok: true, mapId: `map-${this.n}`, index: 0 }]; }
    setMapTransformationType() {}
    setMapOptions() {}
  }
  // A fake map whose style holds the layers added to it; setStyle takes them all away, as MapLibre's does.
  const layers = new Set(['chora-overview-clusters']);
  const map = { on() {}, getLayer: (id) => (layers.has(id) ? { id } : undefined), addLayer: (l) => layers.add(l.layerId ?? 'chora-historical-maps'), removeLayer: (id) => layers.delete(id),
    setStyle() { layers.clear(); layers.add('chora-overview-clusters'); } };
  const mf = ov.createLayerManager(map, { Layer: FakeLayer });
  await mf.add({ ...a, key: 'one', opacity: 1, visible: true });
  assert.deepEqual(log, [['new', 1], ['addImageInfos', 1], ['addGeoreferenceAnnotation', 1]], 'the control: shown in the first layer');
  map.setStyle();   // a new basemap, its style.load (and attach()) not yet come
  log.length = 0;
  const two = await mf.add({ ...a, key: 'two', opacity: 1, visible: true });
  assert.ok(log.length > 0, 'something was given to a renderer');
  assert.ok(log.every(([, i]) => i !== 1), `nothing given to the layer taken away: ${JSON.stringify(log)}`);
  assert.equal(two.mapId, 'map-2');
  assert.deepEqual(mf.entries.map((e) => e.key), ['one', 'two']);
  // Then the style's own attach: one layer, not two of the same id.
  log.length = 0;
  await mf.attach();
  assert.equal(log.filter(([t]) => t === 'new').length, 1);
  assert.ok(map.getLayer('chora-historical-maps'));
});

test('a map the renderer refuses is not left among the maps shown', async () => {
  const a = await ov.admit({ annotation: ANN, manifest: null, notes: [] }, { ...network({ [`${A}/iiif/grid/info.json`]: json('info-v2.json') }), enforced: true });
  let refuse = false;
  class FakeLayer {
    addImageInfos() {}
    addGeoreferenceAnnotation() { return [refuse ? { ok: false, error: new Error('no') } : { ok: true, mapId: 'm', index: 0 }]; }
    setMapTransformationType() {}
    setMapOptions() {}
  }
  const map = fakeMap();
  const mf = ov.createLayerManager(map, { Layer: FakeLayer });
  await mf.add({ ...a, key: 'one', opacity: 1, visible: true });
  assert.deepEqual(mf.entries.map((e) => e.key), ['one'], 'the control: one accepted is there');
  refuse = true;
  await assert.rejects(mf.add({ ...a, key: 'two', opacity: 1, visible: true }), /could not show the map/);
  assert.deepEqual(mf.entries.map((e) => e.key), ['one']);
});

test('a pasted map waiting on a permission set to Never since is said to be refused; maps kept, or one allowed, are not', () => {
  const st = (never) => (c, s) => (never.includes(`${c}:${s}`) ? 'never' : 'undecided');
  const pasted = { subjects: [['iiif', A]], pending: { text: '{}' } };
  assert.equal(ov.waitRefused(pasted, st([`iiif:${A}`])), true);
  assert.equal(ov.waitRefused({ ...pasted, pending: { parsed: {} } }, st([`iiif:${A}`])), true, 'one chosen from several is pasted too');
  assert.equal(ov.waitRefused(pasted, st([])), false, 'not Never');
  assert.equal(ov.waitRefused(pasted, st([`iiif:${B}`])), false, 'another site\'s Never');
  assert.equal(ov.waitRefused({ ...pasted, pending: { readmit: true } }, st([`iiif:${A}`])), false, 'maps kept say nothing');
  assert.equal(ov.waitRefused({ ...pasted, pending: { kept: 'k' } }, st([`iiif:${A}`])), false);
  assert.equal(ov.waitRefused(null, st([`iiif:${A}`])), false);
});

test('a map pasted and the maps kept wait together: the maps kept never take the place of the map pasted, and the reload brings back both', () => {
  const pastedA = { subjects: [['iiif', A]], pending: { text: `${A}/iiif/grid/info.json` }, maps: 1 };
  const keptB = { subjects: [['iiif', B], ['iiif', A]], maps: 2 };
  // The case found in review: a map pasted waits on A; the maps kept, looked at again, wait on B (and A).
  const both = ov.withNeed(ov.withNeed(null, { pasted: pastedA }), { kept: keptB });
  assert.deepEqual(both.pending, pastedA.pending, 'the map pasted is still what is added once allowed');
  assert.deepEqual(both.subjects, [['iiif', A], ['iiif', B]], 'one line for each site, A once');
  assert.equal(both.maps, 3);
  assert.deepEqual(ov.reloadHandOver(both), { pending: pastedA.pending, readmit: true });
  // In the other order, the same.
  assert.deepEqual(ov.withNeed(ov.withNeed(null, { kept: keptB }), { pasted: pastedA }), both);
  // Control: the maps kept alone wait as before, as { readmit }, and the hand-over says so.
  const kept = ov.withNeed(null, { kept: keptB });
  assert.deepEqual(kept.pending, { readmit: true });
  assert.deepEqual(kept.subjects, keptB.subjects);
  assert.deepEqual(ov.reloadHandOver(kept), { pending: null, readmit: true });
  // Control: a map pasted alone hands over itself, and nothing kept.
  assert.deepEqual(ov.reloadHandOver(ov.withNeed(null, { pasted: pastedA })), { pending: pastedA.pending, readmit: false });
  assert.deepEqual(ov.reloadHandOver(null), { pending: null, readmit: false });
  // Each part is let go alone: the maps kept shown leave the map pasted waiting, and the other way about.
  assert.deepEqual(ov.withNeed(both, { kept: null }), ov.withNeed(null, { pasted: pastedA }));
  assert.deepEqual(ov.withNeed(both, { pasted: null }), kept);
  assert.equal(ov.withNeed(kept, { kept: null }), null);
  // A map pasted again replaces the map pasted, never the maps kept.
  const pastedB = { subjects: [['iiif', B]], pending: { text: 'other' }, maps: 1 };
  const again = ov.withNeed(both, { pasted: pastedB });
  assert.deepEqual(again.pending, pastedB.pending);
  assert.deepEqual(again.kept, keptB);
  // A permission set to Never among the maps kept's says nothing of the map pasted; among its own, it does.
  const st = (never) => (c, s) => (never.includes(`${c}:${s}`) ? 'never' : 'undecided');
  assert.equal(ov.waitRefused(both, st([`iiif:${B}`])), false);
  assert.equal(ov.waitRefused(both, st([`iiif:${A}`])), true);
  assert.equal(ov.waitRefused(kept, st([`iiif:${B}`])), false);
});

test('the Allmaps Editor link is offered unless Allmaps is set to Never, and says what following it sends (Stephen, R4)', () => {
  // Following the link is the user's own act, so it needs no permission; Never hides it.
  assert.equal(ov.editorLinkShown('undecided'), true);
  assert.equal(ov.editorLinkShown('allowed'), true);
  assert.equal(ov.editorLinkShown('never'), false);
  assert.match(ov.EDITOR_LINK_TEXT, /Allmaps Editor/);
  assert.match(ov.EDITOR_LINK_TEXT, /sends this map's address/);
});

// ---- A georeference opened as a dataset (src/engine/worker.js chora-load) ---------------------------
import { detect, readable, GEOREF_REASON } from '../src/engine/input.js';
import { choraLoadFailure, CHORA_GEOREF_REASON } from '../src/engine/words.js';
import { file, textFile } from './engine.js';

test('a georeference opened on Chora as a dataset is refused with Chora\'s advice (paste it under Historical maps); the main page\'s reason, and every other, are as they were', async () => {
  const georefInput = await detect([file('test/fixtures/hermes-detect/bpl-rocque-annotation.json')]);
  assert.equal(georefInput.format, 'georef'); assert.equal(readable(georefInput), false);
  assert.equal(choraLoadFailure(georefInput), CHORA_GEOREF_REASON);
  assert.match(CHORA_GEOREF_REASON, /IIIF Georeference Annotation/);
  assert.match(CHORA_GEOREF_REASON, /under Historical maps/);
  assert.doesNotMatch(CHORA_GEOREF_REASON, /Recogito/);
  // Controls: the main page keeps its reason (drop it with the Recogito export), and another refusal is passed on as it is.
  assert.equal(georefInput.reason, GEOREF_REASON);
  assert.match(GEOREF_REASON, /Recogito export/);
  const other = await detect([textFile('neither JSON nor a table', 'notes.txt')]);
  assert.equal(readable(other), false); assert.ok(other.reason);
  assert.equal(choraLoadFailure(other), other.reason);
  assert.equal(choraLoadFailure({ format: 'unknown', reason: 'Unsupported input.' }), 'Unsupported input.');
});
