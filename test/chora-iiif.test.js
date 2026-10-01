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
import * as ov from '../src/chora/overlays.js';
import { createGuard, GuardError } from '../src/chora/fetchguard.js';
import { DataError } from '../src/engine/input.js';

const A = 'https://iiif.example.org', B = 'https://elsewhere.example.org';
const ANN = json('annotation.json'), MANIFEST = json('manifest-rumsey-shaped.json');
/** A guard over a fake network: routes by address; every request recorded, in order. */
function network(routes, { agreed = [[A, 'iiif']] } = {}) {
  const calls = [], state = {};
  const fetch = async (url, init = {}) => {
    calls.push(String(url));
    const r = routes[String(url)];
    if (r === undefined) return { ok: false, status: 404, url: String(url), json: async () => ({}) };
    if (r && r.redirectTo) { if (init.redirect === 'error') throw new TypeError('Failed to fetch'); return { ok: true, status: 200, url: r.redirectTo, json: async () => r.body }; }
    return { ok: true, status: 200, url: String(url), json: async () => structuredClone(r) };
  };
  const ok = new Set(agreed.map(([o, k]) => `${k} ${o}`));
  const consented = (o, k) => ok.has(`${k} ${o}`);
  return { calls, state, consented, guard: createGuard({ state, fetch, consented, inPolicy: () => true }), agree: (o, k) => ok.add(`${k} ${o}`) };
}
const NOW = () => '2026-09-30T12:00:00.000Z';

test('parseInput tells a georeference, an Allmaps address, a manifest and an image apart, and says what it cannot read', () => {
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
  for (const bad of ['', 'not a map', '{"type": "Feature"}', '{broken', 'ftp://example.org/x', 'javascript:alert(1)']) assert.equal(ov.parseInput(bad).kind, 'error', bad);
});

test('a georeference pasted asks about the image\'s site and the manifest\'s together, before anything is fetched; then reads the manifest', async () => {
  const net = network({ [`${A}/manifests/grid/manifest`]: MANIFEST }, { agreed: [] });
  await assert.rejects(ov.resolve(ov.parseInput(JSON.stringify(ANN)), { ...net, now: NOW }), (e) => e instanceof ov.NeedConsent && e.kind === 'iiif' && e.origins.join() === A);
  assert.deepEqual(net.calls, [], 'nothing asked before the agreement');
  net.agree(A, 'iiif');
  const r = await ov.resolve(ov.parseInput(JSON.stringify(ANN)), { ...net, now: NOW });
  assert.deepEqual(net.calls, [`${A}/manifests/grid/manifest`]);
  assert.equal(r.fetchedAt, null, 'pasted: no retrieval date');
  assert.equal(r.manifest['@id'], MANIFEST['@id']);
  // A manifest that cannot be read: the map is still shown, and the page is told why the canvas size is unknown.
  const net2 = network({});
  const r2 = await ov.resolve(ov.parseInput(JSON.stringify(ANN)), { ...net2, now: NOW });
  assert.equal(r2.manifest, null);
  assert.match(r2.notes[0], /could not be read/);
});

test('an Allmaps address is fetched once Allmaps is agreed to, with the time it was fetched; then the map\'s own sites are asked about', async () => {
  const url = 'https://annotations.allmaps.org/maps/0000000000000001';
  const net = network({ [url]: ANN, [`${A}/manifests/grid/manifest`]: MANIFEST }, { agreed: [] });
  await assert.rejects(ov.resolve(ov.parseInput(url), { ...net, now: NOW }), (e) => e.kind === 'allmaps' && e.origins.join() === ov.ALLMAPS_ANNOTATIONS);
  net.agree(ov.ALLMAPS_ANNOTATIONS, 'allmaps');
  await assert.rejects(ov.resolve(ov.parseInput(url), { ...net, now: NOW }), (e) => e.kind === 'iiif' && e.origins.join() === A);
  net.agree(A, 'iiif');
  const r = await ov.resolve(ov.parseInput(url), { ...net, now: NOW });
  assert.equal(r.fetchedAt, NOW());
  // Nothing on the first try; the georeference on each of the next two; then the manifest.
  assert.deepEqual(net.calls, [url, url, `${A}/manifests/grid/manifest`]);
});

test('a manifest leads to its images, and nothing is looked for until asked; the lookup asks Allmaps by the image\'s id, then by its address', async () => {
  const murl = `${A}/manifests/grid/manifest`;
  const net = network({ [murl]: MANIFEST });
  const r = await ov.resolve(ov.parseInput(murl), { ...net, now: NOW });
  assert.deepEqual(r.services, [`${A}/iiif/grid`]);
  assert.equal(r.title, 'A synthetic grid over Cambridge (test fixture)');
  assert.ok(net.calls.every((u) => !u.includes('allmaps')), 'Allmaps not asked');
  // The lookup needs Allmaps agreed to; then /images/<id> first.
  await assert.rejects(ov.lookup(r.services, { ...net, now: NOW }), (e) => e.kind === 'allmaps');
  net.agree(ov.ALLMAPS_ANNOTATIONS, 'allmaps');
  const byId = await georef.allmapsLookupUrl(`${A}/iiif/grid`);
  const page = json('allmaps-images-e564650581f5f6bb.json');
  const net2 = network({ [byId]: page }, { agreed: [[ov.ALLMAPS_ANNOTATIONS, 'allmaps']] });
  const found = await ov.lookup(r.services, { ...net2, now: NOW });
  assert.equal(found.url, byId);
  assert.deepEqual(net2.calls, [byId]);
  // Not there by id: by its address; and when Allmaps has none, null (the Editor is offered instead).
  const byUrl = `${ov.ALLMAPS_ANNOTATIONS}/?url=${encodeURIComponent(`${A}/iiif/grid`)}`;
  const net3 = network({ [byUrl]: ANN }, { agreed: [[ov.ALLMAPS_ANNOTATIONS, 'allmaps']] });
  assert.equal((await ov.lookup(r.services, { ...net3, now: NOW })).url, byUrl);
  assert.deepEqual(net3.calls, [byId, byUrl]);
  const net4 = network({}, { agreed: [[ov.ALLMAPS_ANNOTATIONS, 'allmaps']] });
  assert.equal(await ov.lookup(r.services, { ...net4, now: NOW }), null);
  assert.equal(ov.editorUrl(murl), `https://editor.allmaps.org/images?url=${encodeURIComponent(murl)}`);
});

test('admission: the image information is fetched with no redirect, and a map whose image information names another image is refused', async () => {
  const resolved = { annotation: ANN, manifest: MANIFEST, fetchedAt: null, notes: [] };
  const info = json('info-v2.json');
  const net = network({ [`${A}/iiif/grid/info.json`]: info });
  const a = await ov.admit(resolved, { ...net, canary: true });
  assert.equal(a.g.imageServiceId, `${A}/iiif/grid`);
  assert.deepEqual(a.info, info);
  assert.equal(a.item, ANN);
  assert.equal(a.title, 'A synthetic grid over Cambridge (test fixture)');
  assert.deepEqual(net.calls, [`${A}/iiif/grid/info.json`]);
  // Another image's information (the same path on another site): refused, in words.
  const foreign = network({ [`${A}/iiif/grid/info.json`]: json('info-foreign-id.json') });
  await assert.rejects(ov.admit(resolved, { ...foreign, canary: true }), (e) => e instanceof DataError && e.message.includes(B) && /not shown/.test(e.message));
  // Not merely another site: another image on the same site is refused as well.
  const other = network({ [`${A}/iiif/grid/info.json`]: { ...info, '@id': `${A}/iiif/other` } });
  await assert.rejects(ov.admit(resolved, { ...other, canary: true }), DataError);
  // A redirect, even within the site, is refused for the image information.
  const moved = network({ [`${A}/iiif/grid/info.json`]: { redirectTo: `${A}/iiif/grid2/info.json`, body: info } });
  await assert.rejects(ov.admit(resolved, { ...moved, canary: true }), (e) => e instanceof GuardError && e.kind === 'redirect');
  // With the policy not found enforced, nothing is fetched at all.
  const none = network({ [`${A}/iiif/grid/info.json`]: info });
  await assert.rejects(ov.admit(resolved, { ...none, canary: false }), (e) => e.message === ov.REFUSED);
  assert.deepEqual(none.calls, []);
  // The image's site not agreed to: asked about, nothing fetched.
  const unagreed = network({ [`${A}/iiif/grid/info.json`]: info }, { agreed: [] });
  await assert.rejects(ov.admit(resolved, { ...unagreed, canary: true }), (e) => e instanceof ov.NeedConsent && e.origins.join() === A);
  assert.deepEqual(unagreed.calls, []);
});

test('admission of a page of georeferences gives the renderer the one read, and a manifest that does not belong is set aside, with a note', async () => {
  const page = json('allmaps-images-e564650581f5f6bb.json');
  const net = network({ [`${A}/iiif/grid/info.json`]: json('info-v2.json') });
  const a = await ov.admit({ annotation: page, manifest: null, fetchedAt: NOW(), notes: [] }, { ...net, canary: true });
  assert.equal(a.item.id, ANN.id);
  assert.equal(a.fetchedAt, NOW());
  const wrong = { ...MANIFEST, sequences: [{ canvases: [{ ...MANIFEST.sequences[0].canvases[0], '@id': `${A}/elsewhere/canvas`, images: [] }] }] };
  const b = await ov.admit({ annotation: ANN, manifest: wrong, notes: [] }, { ...net, canary: true });
  assert.equal(b.manifest, null);
  assert.match(b.notes.join(' '), /does not match/);
  assert.equal(b.g.canvas, null);
});

test('the transformation the renderer is told is the georeference\'s own, order and all', async () => {
  assert.equal(ov.allmapsTransformationName({ transformation: 'polynomial' }), 'polynomial1');
  assert.equal(ov.allmapsTransformationName({ transformation: 'polynomial2' }), 'polynomial2');
  assert.equal(ov.allmapsTransformationName({ transformation: 'polynomial3' }), 'polynomial3');
  assert.equal(ov.allmapsTransformationName({ transformation: 'thinPlateSpline' }), 'thinPlateSpline');
  assert.throws(() => ov.allmapsTransformationName({ transformation: 'magic' }), TypeError);
  // Each name is one the transformation library knows, and polynomial2 is not order 1 in disguise:
  // on control points no affine map fits, orders 1 and 2 give different positions.
  const { GcpTransformer } = await import('@allmaps/transform');
  const gcps = [[0, 0, 0, 0], [100, 0, 100, 0], [0, 100, 0, 100], [100, 100, 130, 120], [50, 0, 50, 5], [0, 50, 5, 50], [50, 50, 55, 58]].map(([x, y, X, Y]) => ({ resource: [x, y], geo: [X, Y] }));
  for (const t of ['polynomial', 'polynomial2', 'polynomial3', 'thinPlateSpline', 'projective', 'helmert']) {
    if (t === 'polynomial3') continue;   // 10 points needed
    assert.doesNotThrow(() => new GcpTransformer(gcps, ov.allmapsTransformationName({ transformation: t })).transformToGeo([25, 75]), t);
  }
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
  // Rumsey's own credit, when the manifest gives one, is kept; the licence still comes from the table.
  const credited = ov.attributionOf({ ...rumsey, attribution: 'Rumsey says so' }, null);
  assert.equal(credited.credit, 'Rumsey says so'); assert.equal(credited.from, 'manifest and table');
  // Presentation 3: requiredStatement and rights; HTML in a value is shown as its words.
  const v3 = ov.attributionOf({ id: 'https://x.example.org/m', type: 'Manifest', requiredStatement: { label: { en: ['Attribution'] }, value: { en: ['<a href="https://evil.example.org"><img src="x">Held by</a> <b>X</b> &amp; Y'] } }, rights: 'https://creativecommons.org/licenses/by/4.0/', logo: [{ id: 'https://x.example.org/logo.png' }], thumbnail: [{ id: 'https://x.example.org/t.jpg' }], homepage: [{ id: 'https://x.example.org/home' }], seeAlso: [{ id: 'https://x.example.org/see' }] }, null);
  assert.deepEqual(v3, { credit: 'Held by X & Y', licence: 'https://creativecommons.org/licenses/by/4.0/', licenceLabel: 'CC BY 4.0', nonCommercial: false, from: 'manifest' });
  // Nothing of the logo, thumbnail, homepage or seeAlso, nor of the markup, reaches what is shown.
  assert.doesNotMatch(JSON.stringify(v3), /logo|t\.jpg|home|see|evil|<|>/);
  // A licence that is not a web address is not made into one.
  assert.equal(ov.attributionOf({ license: 'javascript:alert(1)' }, null).licence, null);
  // No manifest at all, and not a site the table knows: nothing to say, said as nothing.
  assert.deepEqual(ov.attributionOf(null, `${A}/iiif/grid`), { credit: null, licence: null, licenceLabel: null, nonCommercial: false, from: null });
});

test('the layer manager gives the renderer the image information first, then the georeference, then sets its transformation', async () => {
  const net = network({ [`${A}/iiif/grid/info.json`]: json('info-v2.json') });
  const order2 = structuredClone(ANN); order2.body.transformation = { type: 'polynomial', options: { order: 2 } };
  // Order 2 needs six control points: the four corners and two between them.
  order2.body.features.push({ type: 'Feature', properties: { resourceCoords: [256, 64] }, geometry: { type: 'Point', coordinates: [0.125, 52.221] } },
    { type: 'Feature', properties: { resourceCoords: [256, 448] }, geometry: { type: 'Point', coordinates: [0.126, 52.19] } });
  const a = await ov.admit({ annotation: order2, manifest: null, notes: [] }, { ...net, canary: true });
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
  // The real renderer needs WebGL (the browser checks use it); the order is checked with a stand-in.
  const mf = ov.createLayerManager(map, { Layer: FakeLayer });
  await mf.add({ ...a, key: 'k', opacity: 0.7, visible: true });
  assert.deepEqual(log, [['new', 'chora-historical-maps'], ['addLayer', 'chora-overview-clusters'], ['addImageInfos', `${A}/iiif/grid`],
    ['addGeoreferenceAnnotation', ANN.id], ['setMapTransformationType', 'map-1', 'polynomial2'], ['setMapOptions', 'map-1', { opacity: 0.7, visible: true }]]);
  // A new style: attach() puts the map back into a new layer, with nothing fetched again.
  log.length = 0; const calls = net.calls.length;
  await mf.attach();
  assert.deepEqual(log.map((l) => l[0]), ['new', 'addLayer', 'addImageInfos', 'addGeoreferenceAnnotation', 'setMapTransformationType', 'setMapOptions']);
  assert.equal(net.calls.length, calls);
  assert.ok(mf.remove('k')); assert.deepEqual(log.at(-1), ['remove', 'map-1']);
});

// ---- A page of several georeferences, and the image's id as the renderer keys it -----------------

const ORDER2 = json('annotation-order2.json');
/** Allmaps' /images/<id> often answers with several georeferences of one image: two here, the newer second. */
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
  assert.equal(asked.annotation, TWO); assert.equal(asked.fetchedAt, NOW());
  assert.doesNotMatch(asked.message, /index option|canvasId/);
  // Newest by `modified`, wherever it is in the page; one with no date is never preferred to one with a date.
  assert.equal(ov.newestChoice([{ index: 0, modified: '2026-09-30T00:00:00Z' }, { index: 1, modified: '2026-01-01T00:00:00Z' }, { index: 2 }]), 0);
  assert.equal(ov.newestChoice([{ index: 0 }, { index: 1 }]), 0);
  // Chosen: that one alone goes on, with when the page was fetched.
  const r = await ov.resolve({ kind: 'annotation', annotation: TWO, fetchedAt: NOW(), index: 0 }, { ...net, now: NOW });
  assert.equal(r.annotation.id, TWO.items[0].id); assert.equal(r.fetchedAt, NOW());
  const a = await ov.admit(r, { ...net, canary: true });
  assert.equal(a.g.annotationId, TWO.items[0].id); assert.equal(a.item.id, TWO.items[0].id);
  // Given the whole page, admission asks for the choice too, rather than failing in the reader's words.
  await assert.rejects(ov.admit({ annotation: TWO, manifest: null, notes: [] }, { ...net, canary: true }), (e) => e instanceof ov.NeedChoice && e.defaultIndex === 1);
  // A page fetched from its address: the choice carries what was fetched, so nothing is fetched again.
  const url = 'https://annotations.allmaps.org/images/e564650581f5f6bb';
  const net2 = network({ [url]: TWO }, { agreed: [[ov.ALLMAPS_ANNOTATIONS, 'allmaps']] });
  await assert.rejects(ov.resolve(ov.parseInput(url), { ...net2, now: NOW }), (e) => e instanceof ov.NeedChoice && e.url === url && e.fetchedAt === NOW() && e.annotation.items.length === 2);
  assert.deepEqual(net2.calls, [url]);
});

test('admission gives the renderer the georeference with the image\'s id exactly as the image information gives it, which is how the renderer looks it up', async () => {
  // The annotation names the image with a trailing slash; its information without: the same image to
  // admission, and two keys to the renderer, which would then fetch the information again itself.
  const slash = structuredClone(ANN); slash.target.source.id = `${A}/iiif/grid/`;
  const net = network({ [`${A}/iiif/grid/info.json`]: json('info-v2.json') });
  const a = await ov.admit({ annotation: slash, manifest: null, notes: [] }, { ...net, canary: true });
  assert.equal(a.item.target.source.id, `${A}/iiif/grid`);
  assert.equal(slash.target.source.id, `${A}/iiif/grid/`, 'what was given is not changed');
  // The other way round, and with the image information of Image API 3 (id, not @id).
  const v3 = structuredClone(json('info-v3.json')); v3.id = `${A}/iiif3/grid/`;
  const plain = structuredClone(ANN); plain.target.source.id = `${A}/iiif3/grid`;
  const net3 = network({ [`${A}/iiif3/grid/info.json`]: v3 });
  const b = await ov.admit({ annotation: plain, manifest: null, notes: [] }, { ...net3, canary: true });
  assert.equal(b.item.target.source.id, `${A}/iiif3/grid/`);
  // The control: ids that agree already are left as they are.
  const same = await ov.admit({ annotation: ANN, manifest: null, notes: [] }, { ...network({ [`${A}/iiif/grid/info.json`]: json('info-v2.json') }), canary: true });
  assert.equal(same.item.target.source.id, ANN.target.source.id);
});

test('a georeference\'s address on Allmaps is asked about as fetching that georeference, not as looking for one', async () => {
  const url = 'https://annotations.allmaps.org/maps/0000000000000001';
  const net = network({ [url]: ANN }, { agreed: [] });
  let e = null;
  await assert.rejects(ov.resolve(ov.parseInput(url), { ...net, now: NOW }), (x) => { e = x; return x instanceof ov.NeedConsent; });
  assert.equal(e.kind, 'allmaps'); assert.equal(e.fetch, url);
  const { notice } = await import('../src/chora/consent.js');
  const text = notice('allmaps', { origins: e.origins, fetch: e.fetch });
  assert.match(text, /^Showing this map fetches its georeference from Allmaps \(https:\/\/annotations\.allmaps\.org\)/);
  assert.ok(text.includes(url), text);
  assert.doesNotMatch(text, /Looking for|looked for/);
  assert.match(text, /It sees nothing of your data, which stays in this tab\.$/);
  // The control: the lookup's notice is still about looking for one.
  assert.match(notice('allmaps', { origins: e.origins }), /^Looking for a georeference/);
  // The lookup is asked without `fetch`.
  await assert.rejects(ov.lookup([`${A}/iiif/grid`], { ...net, now: NOW }), (x) => x instanceof ov.NeedConsent && x.fetch === undefined);
});
