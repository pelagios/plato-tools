// Telling inputs apart (src/engine/input.js, detect) where Hermes added a format or a test: Linked
// Places Format and plain GeoJSON told apart by their structure, not by words in the text; a IIIF
// Georeference Annotation (Allmaps) recognised and refused, not read as W3C annotations; a places.csv
// separated by semicolons or tabs still the spreadsheet tables. The fixtures in
// test/fixtures/hermes-detect/ are described in its README. Every test that asserts an absence
// asserts, in the same test, a presence it could have missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detect, readable, jsonHead, GEOREF_REASON, GEOJSON_SEQ_REASON } from '../src/engine/input.js';
import { file, textFile, go, outText } from './engine.js';

const fc = (features, extra = {}) => JSON.stringify({ type: 'FeatureCollection', ...extra, features });
const pt = { type: 'Point', coordinates: [12.48, 41.89] };
const kind = async (text, name = 'x.geojson') => (await detect([textFile(text, name)])).format;

// ---- LPF or plain GeoJSON --------------------------------------------------------------------------
test('every LPF fixture is still detected as LPF', async () => {
  for (const f of ['lpf-readme-example.json', 'lpf-sample-v1.2.2.geojson']) assert.equal((await detect([file(`test/fixtures/${f}`)])).format, 'lpf', f);
});
test('plain GeoJSON whose properties are only CALLED toponym, timespans, or @id and title is GeoJSON; the same members where LPF puts them make it LPF', async () => {
  // The review's counterexample: a property named toponym.
  assert.equal(await kind(fc([{ type: 'Feature', geometry: pt, properties: { toponym: 'Roma' } }])), 'geojson');
  assert.equal(await kind(fc([{ type: 'Feature', geometry: pt, properties: { name: 'Roma' }, names: [{ toponym: 'Roma' }] }])), 'lpf', 'control: names with a toponym, at the feature\'s level');
  assert.equal(await kind(fc([{ type: 'Feature', geometry: pt, properties: { name: 'Roma', timespans: '-0753/0476' } }])), 'geojson');
  assert.equal(await kind(fc([{ type: 'Feature', geometry: pt, properties: { name: 'Roma' }, when: { timespans: [{ start: { in: '-0753' } }] } }])), 'lpf', 'control: a when with timespans');
  assert.equal(await kind(fc([{ type: 'Feature', geometry: pt, properties: { '@id': 'https://example.org/roma', title: 'Roma' } }])), 'geojson');
  assert.equal(await kind(fc([{ '@id': 'https://example.org/roma', type: 'Feature', geometry: pt, properties: { title: 'Roma' } }])), 'lpf', 'control: an @id of the feature itself');
  // A word in a string value is not structure either.
  assert.equal(await kind(fc([{ type: 'Feature', geometry: pt, properties: { note: '"toponym": "linkedplaces"' } }])), 'geojson');
  assert.equal(await kind(fc([{ type: 'Feature', geometry: pt, properties: {} }], { '@context': 'https://raw.githubusercontent.com/LinkedPasts/linked-places/master/linkedplaces-context-v1.1.jsonld' })), 'lpf', 'control: LPF\'s context');
});
test('one Feature on its own: the same tests', async () => {
  assert.equal(await kind(JSON.stringify({ type: 'Feature', geometry: pt, properties: { toponym: 'Roma', '@id': 'x', title: 'y' } })), 'geojson');
  // An LPF Feature on its own is not plain GeoJSON (and, as before, not read: LPF comes as a collection).
  assert.equal(await kind(JSON.stringify({ type: 'Feature', geometry: pt, properties: {}, names: [{ toponym: 'Roma' }] })), null, 'control');
});
test('a GeoJSON sequence is LPF only by its structure; a sequence of plain features is refused, saying to give them as one FeatureCollection', async () => {
  const plain = { type: 'Feature', geometry: pt, properties: { name: 'Roma', toponym: 'Roma' } };
  const lpf = { type: 'Feature', geometry: pt, properties: { title: 'Roma' }, names: [{ toponym: 'Roma' }] };
  const seq = (...ls) => ls.map((l) => JSON.stringify(l)).join('\n') + '\n';
  for (const name of ['x.geojsonl', 'x.json']) {
    const d = await detect([textFile(seq(plain, plain), name)]);
    assert.equal(d.format, null, name);
    assert.equal(d.reason, GEOJSON_SEQ_REASON);
    assert.match(d.reason, /one FeatureCollection/);
    assert.equal(await kind(seq(lpf, plain), name), 'lpf-seq', `control: ${name} whose first feature is LPF's`);
  }
  // After a collection's own line: LPF's context there, or the first feature, decides.
  const head = { type: 'FeatureCollection', title: 'T' };
  assert.equal(await kind(seq(head, plain), 'x.geojsonl'), null);
  assert.equal(await kind(seq(head, lpf), 'x.geojsonl'), 'lpf-seq', 'control: an LPF feature after the collection line');
  assert.equal(await kind(seq({ ...head, '@context': 'https://raw.githubusercontent.com/LinkedPasts/linked-places-format/main/linkedplaces-context-v1.1.jsonld' }, plain), 'x.geojsonl'), 'lpf-seq', 'control: the context on the collection line');
});
test('an LPF sequence these tools write is still detected as one, and reads back', async () => {
  const r = await go([file('test/fixtures/lpf-sample-v1.2.2.geojson')], 'convert', 'lpf-seq');
  const text = outText(r.e, Object.keys(r.e.outs).find((k) => k.endsWith('.geojsonl')));
  assert.ok(text.split('\n').length > 2, 'control: the sequence has features');
  const back = await go([textFile(text, 'back.geojsonl')], 'check');
  assert.equal(back.input.format, 'lpf-seq');
  assert.equal(back.report.errors, 0);
});
test('a FeatureCollection longer than the head read for detection is judged by the features the head holds', async () => {
  const many = Array.from({ length: 3000 }, (_, i) => ({ type: 'Feature', geometry: pt, properties: { name: `p${i}`, toponym: `p${i}` } }));
  const big = fc(many);
  assert.ok(big.length > 65536 * 2);
  assert.equal(await kind(big), 'geojson');
  many[0] = { ...many[0], names: [{ toponym: 'p0' }] };
  assert.equal(await kind(fc(many)), 'lpf', 'control: the first feature carries LPF\'s names');
});
test('jsonHead reads a document cut short as far as it goes, and keeps a key called __proto__', () => {
  assert.deepEqual(jsonHead('{"a": [1, {"b": "c"}, {"d": "unfinish'), { a: [1, { b: 'c' }, {}] });
  assert.deepEqual(jsonHead('{"a": 12'), {}, 'a number cut off may be longer: left out');
  assert.deepEqual(jsonHead('{"a": tr'), {});
  assert.deepEqual(jsonHead('{"a": true, "b": null}'), { a: true, b: null }, 'control: complete words are read');
  const o = jsonHead('{"__proto__": {"x": 1}}');
  assert.ok(Object.hasOwn(o, '__proto__'));
  assert.equal(Object.getPrototypeOf(o), Object.prototype);
  assert.equal(jsonHead('{"a" 1}'), null, 'not JSON');
});

// ---- IIIF Georeference Annotations -------------------------------------------------------------------
const GEO = 'test/fixtures/hermes-detect/';
test('an Allmaps Georeference Annotation, and an AnnotationPage of them, are recognised as georeferences, with the maps and image services in the head', async () => {
  const one = await detect([file(GEO + 'bpl-rocque-annotation.json')]);
  assert.deepEqual({ ...one, files: undefined }, { format: 'georef', count: 1, imageServiceIds: ['https://iiif.digitalcommonwealth.org/iiif/2/commonwealth:8623qf00m'], reason: GEOREF_REASON, files: undefined });
  const page = await detect([file(GEO + 'loc-chesapeake-annotationpage.json')]);
  assert.deepEqual([page.format, page.count, page.imageServiceIds], ['georef', 2, ['https://tile.loc.gov/image-services/iiif/service:gmd:gmd384:g3842:g3842c:ct008615']]);
  assert.equal(page.reason, "This is a IIIF Georeference Annotation (a map's georeference, not a dataset): drop it together with the Recogito export whose regions it places.");
  assert.equal(readable(page), false);
  // Controls: Recogito's exports are still W3C annotations, and readable.
  for (const f of ['recogito-v1-islandia-map.jsonld', 'recogito-studio-constructed.json']) {
    const d = await detect([file(`test/fixtures/annotations/${f}`)]);
    assert.equal(d.format, 'w3c-annotations', f);
    assert.equal(readable(d), true, f);
  }
});
test('an annotation that is not a georeference is not taken for one: the motivation, or the extension\'s context, decides', async () => {
  const anno = { '@context': 'http://www.w3.org/ns/anno.jsonld', type: 'Annotation', target: { source: { id: 'https://example.org/img' } } };
  assert.equal(await kind(JSON.stringify(anno), 'a.json'), 'w3c-annotations');
  assert.equal(await kind(JSON.stringify({ ...anno, motivation: 'georeferencing' }), 'a.json'), 'georef', 'control');
  assert.equal(await kind(JSON.stringify({ ...anno, '@context': ['http://www.w3.org/ns/anno.jsonld', 'http://iiif.io/api/extension/georef/1/context.json'] }), 'a.json'), 'georef', 'control');
});
const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
test('checking or converting a georeference is refused with the reason, as an input that is not recognised is', () => {
  for (const args of [['check'], ['convert', '--to', 'plato-json', '--out', '/nonexistent-never-written']]) {
    const r = cli(...args, GEO + 'bpl-rocque-annotation.json');
    assert.equal(r.code, 2, r.out);
    assert.ok(r.out.includes(GEOREF_REASON), r.out);
    assert.match(r.out, /could not be (checked|converted)/);
  }
  const ok = cli('check', 'test/fixtures/annotations/recogito-v1-islandia-map.jsonld');
  assert.ok(!/could not be checked/.test(ok.out) && /Checked 1 input/.test(ok.out), ok.out);
});

// ---- a places.csv with another delimiter -------------------------------------------------------------
test('a places.csv separated by semicolons, tabs or bars is still the spreadsheet tables; with a header of its own, a table of places', async () => {
  for (const d of [';', '\t', '|', ',']) {
    assert.equal(await kind(['place_id', 'label', 'country_codes'].join(d) + '\n' + ['a', 'A', ''].join(d) + '\n', 'places.csv'), 'tables', JSON.stringify(d));
    assert.equal(await kind(['name', 'lat', 'lon'].join(d) + '\n' + ['A', '1', '2'].join(d) + '\n', 'places.csv'), 'csv', `control ${JSON.stringify(d)}`);
  }
  assert.equal(await kind('title;description\nT;D\n', 'about.csv'), 'tables');
});
