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
