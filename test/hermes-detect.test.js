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
import { detect, readable, jsonHead, GEOREF_REASON, GEOJSON_SEQ_REASON, XML_REASONS, HEADERLESS_REASON } from '../src/engine/input.js';
import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { readdirSync, readFileSync } from 'node:fs';
import { PLATO_REPO } from './paths.js';
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
// ---- TEI -------------------------------------------------------------------------------------------
test('a DOCTYPE whose internal subset has ] or > in a comment or a quoted literal does not hide the TEI root', async () => {
  const body = '<teiHeader/><text><body><p>x</p></body></text>';
  const tei = (doctype, root = '<TEI xmlns="http://www.tei-c.org/ns/1.0">', end = '</TEI>') => `<?xml version="1.0"?>\n${doctype}${root}${body}${end}\n`;
  for (const d of ['<!DOCTYPE TEI [ <!-- ] --> <!ENTITY a "b"> ]>', '<!DOCTYPE TEI [ <!ENTITY a "b]"> ]>', "<!DOCTYPE TEI [ <!ENTITY a 'b]>'> ]>", '<!DOCTYPE TEI SYSTEM "tei[1].dtd">', '<!DOCTYPE TEI>']) {
    assert.equal(await kind(tei(d), 'x.xml'), 'tei', d);
    // Control: the same prolog before a root that is not TEI's, or not in its namespace, is not TEI.
    assert.notEqual(await kind(tei(d, '<html xmlns="http://www.w3.org/1999/xhtml">', '</html>'), 'x.xml'), 'tei', `${d} before <html>`);
    assert.notEqual(await kind(tei(d, '<TEI>'), 'x.xml'), 'tei', `${d} before a TEI with no namespace`);
  }
});
test('XML that is not TEI P5 is refused, saying what it is, and never read as N-Triples', async () => {
  const cases = {
    'tei-p4': ['<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE TEI.2 PUBLIC "-//TEI P4//DTD Main Document Type//EN" "http://www.tei-c.org/Guidelines/DTD/tei2.dtd" [ <!ENTITY % TEI.XML "INCLUDE"> ]>\n<TEI.2><teiHeader/></TEI.2>\n',
      '<?xml version="1.0"?>\n<TEI><teiHeader/></TEI>', '<teiCorpus><TEI/></teiCorpus>'],
    kml: ['<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark/></Document></kml>'],
    xml: ['<?xml version="1.0"?>\n<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>', '<root><a/></root>', '<?xml-stylesheet href="x.xsl"?><doc/>', '<!-- a note --><doc/>'],
  };
  for (const [kind, texts] of Object.entries(cases)) for (const t of texts) {
    const d = await detect([textFile(t, 'x.xml')]);
    assert.deepEqual([d.format, d.reason], [null, XML_REASONS[kind]], t);
  }
  // Controls: TEI P5 is TEI, and N-Triples, Turtle and N-Quads are detected as before, by content and by name.
  assert.equal(await kind('<?xml version="1.0"?>\n<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></TEI>', 'x.xml'), 'tei');
  const r = await go([file('test/fixtures/lpf-readme-example.json')], 'convert', 'ntriples');
  const nt = outText(r.e, Object.keys(r.e.outs).find((k) => k.endsWith('.nt')));
  assert.ok(nt.length > 100);
  assert.equal(await kind(nt, 'export.txt'), 'ntriples');
  assert.equal(await kind('_:b0 <https://example.org/p> "o" .\n', 'x.txt'), 'ntriples');
  assert.equal(await kind('<urn:x:a> <https://example.org/p> <urn:x:b> .\n', 'x.txt'), 'ntriples');
  assert.equal(await kind('@prefix ex: <https://example.org/> .\nex:a ex:p ex:b .\n', 'x.txt'), 'turtle');
  assert.equal(await kind('<https://example.org/a> <https://example.org/p> <https://example.org/b> <https://example.org/g> .\n', 'x.nq'), 'nquads');
  assert.equal(await kind(nt, 'x.nt'), 'ntriples');
});
test('a head that ends part-way (a first record past 64 KB, a gzip cut mid-record, a DOCTYPE past 64 KB) never makes detection throw', async () => {
  // A File made of 16 KB parts streams them one by one, as a file on disk streams in chunks, so the
  // head (64 KB) ends part-way through the record.
  const long = 'x'.repeat(300000);
  const chunked = (t, name) => { const parts = []; for (let i = 0; i < t.length; i += 16384) parts.push(t.slice(i, i + 16384)); return new File(parts, name); };
  const feature = { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { name: 'A', note: long } };
  const texts = {
    'jsonl, first line past the head': [JSON.stringify(feature) + '\n' + JSON.stringify(feature) + '\n', 'x.geojsonl'],
    'JSON Lines named so, first line past the head': [JSON.stringify({ profile: 'place-centric', note: long }) + '\n{}\n', 'x.jsonl'],
    'JSON Lines whose first line is not JSON': ['not json\n{}\n', 'x.jsonl'],
    'a FeatureCollection whose first feature is past the head': [JSON.stringify({ type: 'FeatureCollection', features: [feature] }), 'x.geojson'],
    'a georeference annotation cut': [JSON.stringify({ type: 'AnnotationPage', items: [{ type: 'Annotation', motivation: 'georeferencing', body: long }] }), 'x.json'],
    'a TEI DOCTYPE past the head': ['<?xml version="1.0"?>\n<!DOCTYPE TEI [ <!-- ' + long + ' --> ]>\n<TEI xmlns="http://www.tei-c.org/ns/1.0"/>', 'x.xml'],
    'a CSV header past the head': ['name,' + long + '\nA,1\n', 'x.csv'],
  };
  for (const [what, [t, name]] of Object.entries(texts)) {
    for (const f of [chunked(t, name), new File([gzipSync(Buffer.from(t))], name + '.gz')]) {
      let d;
      await assert.doesNotReject(async () => { d = await detect([f]); }, `${what} (${f.name})`);
      assert.ok(d.format || d.reason, `${what}: a format or a reason`);
    }
  }
  assert.equal((await detect([chunked(texts['a TEI DOCTYPE past the head'][0], 'x.xml')])).reason, XML_REASONS.unseen);
  // Control: the same records within the head are detected.
  assert.equal(await kind(JSON.stringify({ ...feature, properties: { name: 'A' } }) + '\n', 'x.geojsonl'), null, 'a plain sequence: refused with its reason');
  assert.equal(await kind(JSON.stringify({ profile: 'place-centric' }) + '\n{}\n', 'x.jsonl'), 'plato-jsonl');
});
test('a zip holding no file named after a sheet is refused, saying what it holds; one of the tables is the tables', async () => {
  const gb = zipSync({ 'GB.txt': Buffer.from('2633352\tBristol\t51.45\t-2.58\n'), 'readme.txt': Buffer.from('GeoNames'), 'docs/': new Uint8Array() });
  const d = await detect([new File([gb], 'GB.zip')]);
  assert.equal(d.format, null);
  assert.match(d.reason, /^This zip holds GB\.txt, readme\.txt, and no PLATO spreadsheet tables/);
  // Controls: PLATO's customs tables zipped, in a folder or not, and a damaged zip, left to the tables reader to report.
  const dir = `${PLATO_REPO}/schemas/tables/examples/customs`;
  const sheets = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.csv')).map((f) => [f, readFileSync(`${dir}/${f}`)]));
  assert.equal((await detect([new File([zipSync(sheets)], 'customs.zip')])).format, 'tables');
  assert.equal((await detect([new File([zipSync({ customs: sheets })], 'customs.zip')])).format, 'tables');
  assert.equal((await detect([new File([zipSync(sheets).slice(0, 200)], 'broken.zip')])).format, 'tables');
});
test('a table with no heading row (GeoNames) is refused with a reason; headings that are years are headings', async () => {
  const geonames = '2633352\tBristol\tBristol\t\t51.45523\t-2.59665\tP\tPPLA2\tGB\t\tENG\tA6\t\t\t465866\t\t20\tEurope/London\t2019-09-05\n';
  for (const [t, name] of [[geonames, 'GB.tsv'], [geonames.replaceAll('\t', ','), 'GB.csv']]) {
    const d = await detect([textFile(t, name)]);
    assert.deepEqual([d.format, d.reason], [null, HEADERLESS_REASON], name);
  }
  // Controls: the same rows under a heading row, and a census table whose headings are years.
  const heads = 'geonameid\tname\tasciiname\talternatenames\tlatitude\tlongitude\tfclass\tfcode\tcc\tcc2\tadmin1\tadmin2\tadmin3\tadmin4\tpopulation\televation\tdem\ttimezone\tmodified\n';
  assert.equal(await kind(heads + geonames, 'GB.tsv'), 'csv');
  assert.equal(await kind('parish,1801,1811,1821\nAshby,120,131,140\n', 'census.csv'), 'csv');
  assert.equal(await kind('id,name\n1,Roma\n', 'x.csv'), 'csv', 'one whole number in the first row of data is not enough to tell');
});
test('a places.csv separated by semicolons, tabs or bars is still the spreadsheet tables; with a header of its own, a table of places', async () => {
  for (const d of [';', '\t', '|', ',']) {
    assert.equal(await kind(['place_id', 'label', 'country_codes'].join(d) + '\n' + ['a', 'A', ''].join(d) + '\n', 'places.csv'), 'tables', JSON.stringify(d));
    assert.equal(await kind(['name', 'lat', 'lon'].join(d) + '\n' + ['A', '1', '2'].join(d) + '\n', 'places.csv'), 'csv', `control ${JSON.stringify(d)}`);
  }
  assert.equal(await kind('title;description\nT;D\n', 'about.csv'), 'tables');
});
