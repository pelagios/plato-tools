// Tables of places that are not PLATO's own, CSV and plain GeoJSON (src/engine/hermes/generic.js):
// telling them from PLATO's spreadsheet tables and from Linked Places Format, and reading them as
// PLATO records. The fixtures, and where each comes from, are described in
// test/fixtures/generic/README.md. Every test that asserts an absence asserts, in the same test, a
// presence it could have missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { addPlatoFormats, strictFormatLogger } from '../src/lib/formats.js';
import { detect, DataError } from '../src/engine/input.js';
import { Report } from '../src/engine/report.js';
import { tableIds } from '../src/formats/tables.js';
import { genericSource, genericProfile, columnsOf, mappingOf, csvRecords } from '../src/engine/hermes/generic.js';
import Papa from 'papaparse';
import { FEATURE_ID, GENERIC_KINDS } from '../src/engine/hermes/columns.js';
import { columnWarnings, COLUMN_WORDS } from '../src/engine/words.js';
import { PLATO_REPO } from './paths.js';
import { file, textFile, go, outText } from './engine.js';

const DIR = 'test/fixtures/generic/';
const STAND_IN = 'https://example.org/my-dataset/';
const load = (f) => JSON.parse(readFileSync(`public/plato/${f}`, 'utf8'));
const ajv = addPlatoFormats(new Ajv2020({ strict: false, allErrors: true, logger: strictFormatLogger }));
ajv.addSchema(load('plato.schema.json'), 'https://w3id.org/plato/schemas/plato.schema.json');
ajv.addSchema(load('attestation-centric.schema.json'));
ajv.addSchema(load('place-centric.schema.json'));
const SCHEMA = { 'place-centric': 'https://w3id.org/plato/schemas/place-centric.schema.json', 'attestation-centric': 'https://w3id.org/plato/schemas/attestation-centric.schema.json' };
const valid = (doc) => { const v = ajv.getSchema(SCHEMA[doc.profile]); return v(doc) ? null : v.errors.slice(0, 3); };

/** Read an input through the generic reader into one document: { input, doc, items, kinds, of(kind) }. */
async function readAll(files, options = {}) {
  const input = await detect([].concat(files));
  const rep = new Report();
  const events = [];
  for await (const ev of genericSource(input, rep, options)) events.push(ev);
  const [head, ...rest] = events;
  assert.equal(head.type, 'header');
  const doc = head.value.profile === 'place-centric' ? { ...head.value, spatialEntities: rest.filter((e) => e.type === 'record').map((e) => e.value) }
    : { ...head.value, attestations: rest.filter((e) => e.type === 'attestation').map((e) => e.value) };
  const fresh = rest.filter((e) => e.type === 'record' && e.newEntity).map((e) => e.value);
  if (fresh.length) doc.newSpatialEntities = fresh;
  const { items, counts } = rep.toJSON();
  return { input, doc, items, counts, kinds: new Set(items.map((i) => i.kind)), of: (k) => items.find((i) => i.kind === k) };
}
const fx = (f) => file(DIR + f);

// ---- detection ----------------------------------------------------------------------------------------
const TABLE_DIRS = ['test/fixtures/tables-judgements', 'test/fixtures/tables-routes',
  ...(existsSync(`${PLATO_REPO}/schemas/tables/examples`) ? readdirSync(`${PLATO_REPO}/schemas/tables/examples`).map((d) => `${PLATO_REPO}/schemas/tables/examples/${d}`) : [])];
test('every set of PLATO spreadsheet tables is still read as tables, whole or one sheet at a time', async () => {
  assert.ok(TABLE_DIRS.length >= 2);
  for (const dir of TABLE_DIRS) {
    const csvs = readdirSync(dir).filter((f) => f.endsWith('.csv'));
    assert.ok(csvs.length >= 9, dir);
    assert.equal((await detect(csvs.map((f) => file(`${dir}/${f}`)))).format, 'tables', dir);
    // A sheet chosen on its own is still the tables (their check then says which sheets are missing).
    for (const f of csvs) assert.equal((await detect([file(`${dir}/${f}`)])).format, 'tables', `${dir}/${f}`);
  }
});
test('any other CSV file is a table of places; a TSV file too', async () => {
  const csvs = readdirSync(DIR).filter((f) => f.endsWith('.csv'));
  assert.ok(csvs.length >= 5);
  for (const f of csvs) assert.equal((await detect([fx(f)])).format, 'csv', f);
  // Named like a sheet, but with a header of its own: a table of places, not the tables.
  assert.equal((await detect([textFile('Name,Lat,Lon\nA,1,2\n', 'places.csv')])).format, 'csv');
  assert.equal((await detect([textFile('place_id,label,country_codes\na,A,\n', 'places.csv')])).format, 'tables', 'control: with the sheet\'s header, the tables');
  const tsv = await detect([textFile('name\tlat\tlon\nA\t1\t2\n', 'places.tsv')]);
  assert.deepEqual([tsv.format, tsv.delimiter], ['csv', '\t']);
});
test('several CSV files that are not tables are refused, with the reason, rather than read as broken tables', async () => {
  const d = await detect([fx('no-ids.csv'), fx('with-ids.csv')]);
  assert.equal(d.format, null);
  assert.match(d.reason, /one of them at a time/);
});
test('Linked Places Format is still read as LPF; plain GeoJSON is read as a table of its properties', async () => {
  for (const f of ['lpf-readme-example.json', 'lpf-sample-v1.2.2.geojson']) assert.equal((await detect([file(`test/fixtures/${f}`)])).format, 'lpf', f);
  for (const f of ['plain.geojson', 'feature-ids.geojson']) {
    const d = await detect([fx(f)]);
    assert.deepEqual([d.format, d.shape], ['geojson', 'collection'], f);
  }
  // LPF without its context is still told by its own members; the tools' own LPF output by its context.
  const bare = { type: 'FeatureCollection', features: [{ type: 'Feature', '@id': 'https://x.org/p', properties: { title: 'P' }, names: [{ toponym: 'P' }] }] };
  assert.equal((await detect([textFile(JSON.stringify(bare), 'x.json')])).format, 'lpf');
  const ours = { type: 'FeatureCollection', '@context': 'https://raw.githubusercontent.com/LinkedPasts/linked-places-format/main/linkedplaces-context-v1.1.jsonld', features: [] };
  assert.equal((await detect([textFile(JSON.stringify(ours), 'x.geojson')])).format, 'lpf');
  const one = await detect([textFile(JSON.stringify({ type: 'Feature', properties: { name: 'A' }, geometry: null }), 'one.geojson')]);
  assert.deepEqual([one.format, one.shape], ['geojson', 'feature']);
});

// ---- the fixtures read -------------------------------------------------------------------------------
for (const f of readdirSync(DIR).filter((f) => /\.(csv|geojson)$/.test(f) && f !== 'duplicate-ids.csv')) {
  test(`${f}: read into valid PLATO JSON`, async () => {
    const { doc } = await readAll(fx(f));
    const n = (doc.spatialEntities || doc.attestations).length;
    assert.ok(n > 0, f);
    assert.equal(valid(doc), null);
  });
}

test('odd-headers.csv: rows with a web address become attestations about it, several about one address', async () => {
  const r = await readAll(fx('odd-headers.csv'));
  assert.equal(r.doc.profile, 'attestation-centric');
  assert.equal(await genericProfile(r.input), 'attestation-centric');
  const about = r.doc.attestations.map((a) => a.about);
  assert.deepEqual(about.filter((a) => a === 'https://www.wikidata.org/wiki/Q90').length, 2);
  assert.equal(about.length, 7);
  const roma = r.doc.attestations[0];
  assert.deepEqual(roma.names, [{ toponym: 'Roma' }, { toponym: 'Rome' }, { toponym: 'Urbs' }]);
  assert.deepEqual(roma.citations, [{ source: { title: 'Itinerarium Antonini', authorityType: 'source' } }]);
  assert.equal(roma.notes, 'Remarks: the capital');
  for (const [k, ex] of [['generic-coordinate-missing', 'row 6'], ['generic-coordinate-not-number', 'row 7'], ['generic-coordinate-range', 'row 8'], ['generic-no-address', 'row 9'], ['generic-row-empty', 'row 10']]) {
    assert.ok(r.of(k)?.examples.some((e) => e.startsWith(ex)), `${k} at ${ex}`);
  }
  // The rows whose coordinates are lost are still carried, without a location.
  const lost = r.doc.attestations.filter((a) => ['Londinium', 'Eboracum', 'Thule'].includes(a.names[0].toponym));
  assert.equal(lost.length, 3);
  assert.ok(lost.every((a) => !a.geometries));
  assert.ok(roma.geometries?.length, 'control: a good row has its location');
  // A row about an address: never a place of its own, so neither an id nor a minted address.
  assert.ok(!r.doc.attestations.some((a) => '@id' in a));
  assert.equal(r.counts.rows, 9);
});

test('with-ids.csv: places get addresses made from their ids exactly as the tables make them, and keep the id', async () => {
  const r = await readAll(fx('with-ids.csv'));
  assert.equal(r.doc.profile, 'place-centric');
  const ids = tableIds(STAND_IN, () => null);
  const bath = r.doc.spatialEntities.find((p) => p.label === 'Aquae Sulis');
  assert.deepEqual([bath['@id'], bath.entityIdentifier], [ids.place('bath'), 'bath']);
  assert.deepEqual(bath.attestations[0].timespans, [{ startEarliest: '0060', endLatest: '0410' }]);
  assert.equal(bath.attestations[0].names[0].language, 'la');
  // The row with no id has no address at all, and is reported; the others are not.
  const isca = r.doc.spatialEntities.find((p) => p.label === 'Isca');
  assert.ok(isca && !('@id' in isca) && !('entityIdentifier' in isca));
  assert.deepEqual(r.of('generic-id-empty').examples, ['row 6']);
  assert.ok(r.of('generic-date-invalid').examples[0].includes('c. 75'));
  assert.ok(r.of('generic-language-invalid'));
  // Made under the stand-in base, the addresses are said not to be permanent; under a base given, not.
  assert.ok(r.kinds.has('generic-stand-in-base'));
  const based = await readAll(fx('with-ids.csv'), { base: 'https://data.example.ac.uk/forts' });
  assert.equal(based.doc.spatialEntities[0]['@id'], 'https://data.example.ac.uk/forts/place/bath');
  assert.ok(!based.kinds.has('generic-stand-in-base'));
});
test('an id is encoded into the address as the tables encode place_id', async () => {
  const r = await readAll(textFile('id,name\nSt Albans/Verulamium,Verulamium\n', 'x.csv'));
  assert.equal(r.doc.spatialEntities[0]['@id'], tableIds(STAND_IN, () => null).place('St Albans/Verulamium'));
  assert.equal(r.doc.spatialEntities[0]['@id'], `${STAND_IN}place/St%20Albans%2FVerulamium`);
});

test('no-ids.csv: places without ids have no address, and one warning says how to give them one', async () => {
  const r = await readAll(fx('no-ids.csv'));
  assert.equal(r.doc.spatialEntities.length, 2);
  assert.ok(r.doc.spatialEntities.every((p) => p.label && !('@id' in p)));
  const w = r.of('generic-no-ids');
  assert.deepEqual([w.severity, w.count], ['warning', 1]);
  assert.match(w.message, /cannot be published or linked/);
  assert.match(w.message, /match an existing column as the id/);
  // No address is made from a row number or a name instead.
  assert.ok(!JSON.stringify(r.doc).includes('/place/'));
  assert.ok(JSON.stringify((await readAll(fx('with-ids.csv'))).doc).includes('/place/'), 'control: with ids, the addresses are there');
});

test('duplicate-ids.csv: two rows with one id are refused, naming the id and both rows', async () => {
  await assert.rejects(readAll(fx('duplicate-ids.csv')), (e) => e instanceof DataError && /"a"/.test(e.message) && /row 2 and row 4/.test(e.message));
  await assert.doesNotReject(readAll(fx('with-ids.csv')), 'control: unique ids are read');
});

test('plain.geojson: properties matched, the geometry kept, a GeometryCollection and foreign members reported', async () => {
  const r = await readAll(fx('plain.geojson'));
  assert.equal(r.doc.gazetteer.title, 'Some Roman forts');
  const [vindolanda, wall, coria, magna] = r.doc.spatialEntities;
  assert.deepEqual(vindolanda.attestations[0].names.map((n) => n.toponym), ['Vindolanda', 'Vindolana', 'Vindolande']);
  assert.equal(vindolanda.attestations[0].notes, 'garrison: cohors IX Batavorum\npop: 500');
  assert.equal(wall.attestations[0].geometries[0].geojson.type, 'LineString');
  assert.ok(!coria.attestations[0].geometries && !magna.attestations[0].geometries);
  assert.deepEqual(r.of('generic-geometry-collection').examples, ['feature 3']);
  assert.deepEqual(r.of('generic-feature-key').examples, ['bbox', 'surveyed_by']);
  assert.deepEqual(r.of('generic-row-no-name').examples, ['feature 5']);
  assert.ok(!r.kinds.has('generic-row-empty'), 'a place-centric row needs only a name');
  assert.ok(r.kinds.has('generic-no-ids'));
  assert.equal(r.counts.features, 5);
});
test("feature-ids.geojson: a feature's own id makes the place's address, a number as well as a word", async () => {
  const r = await readAll(fx('feature-ids.geojson'));
  const { headers } = await columnsOf(r.input);
  assert.equal(headers[0], FEATURE_ID);
  assert.deepEqual(r.doc.spatialEntities.map((p) => p['@id']), ['vindolanda', '2', 'magna'].map((i) => tableIds(STAND_IN, () => null).place(i)));
  assert.deepEqual(r.doc.spatialEntities[1].attestations[0].types, [{ label: 'fort' }, { label: 'town' }]);
  assert.ok(!r.kinds.has('generic-no-ids'));
});
test('pleiades-places-subset.csv: a real Pleiades export is read with its ids, dates and representative points', async () => {
  const r = await readAll(fx('pleiades-places-subset.csv'));
  const athenae = r.doc.spatialEntities.find((p) => p.entityIdentifier === '579885');
  assert.equal(athenae.label, 'Athenae');
  assert.deepEqual(athenae.attestations[0].geometries[0].reprPoint, [23.7239143561, 37.9716372547]);
  assert.deepEqual(athenae.attestations[0].timespans, [{ startEarliest: '-0750', endLatest: '2100' }]);
  assert.match(athenae.attestations[0].notes, /^path: \/places\/579885$/m);
  assert.equal(r.doc.spatialEntities.length, 5);
});

// ---- a saved mapping ------------------------------------------------------------------------------
test('a saved mapping is used instead of the guess, and a skipped column is reported by name', async () => {
  const columns = { 'Place Name': 'name', LAT: 'latitude', Long: 'longitude', wikidata: 'note', 'Feature Type': 'skip', 'Alt. names': 'alternativeNames', Source: 'source', Remarks: 'note' };
  const r = await readAll(fx('odd-headers.csv'), { columns });
  assert.equal(r.doc.profile, 'place-centric', 'with no address column, the rows are places');
  assert.equal(await genericProfile(r.input, columns), 'place-centric');
  assert.deepEqual(r.of('generic-column-skipped').examples, ['Feature Type']);
  assert.ok(r.doc.spatialEntities.every((p) => !p.attestations[0].types));
  assert.match(r.doc.spatialEntities[0].attestations[0].notes, /wikidata: https:\/\/www\.wikidata\.org\/wiki\/Q220/);
  const { mapping } = await mappingOf(r.input, columns);
  assert.deepEqual({ ...mapping }, columns);
});
test('an address column whose value is not a web address loses the row, and says so', async () => {
  const r = await readAll(textFile('name,wikidata\nRoma,https://www.wikidata.org/wiki/Q220\nAthenae,Q1524\n', 'x.csv'), { columns: { name: 'name', wikidata: 'address' } });
  assert.deepEqual(r.doc.attestations.map((a) => a.about), ['https://www.wikidata.org/wiki/Q220']);
  assert.deepEqual(r.of('generic-address-not-web').examples, ['row 3: Q1524']);
});

// ---- World Historical Gazetteer addresses (addresses.js) ------------------------------------------
const W3ID = 'https://w3id.org/whg/id/';
const WHG_CSV = `id,name,whg
r1,Roma,place:gn:3169070
r2,Lutetia,https://whgazetteer.org/entity/place:wd:Q90/api
r3,Old link,https://whgazetteer.org/places/1234/portal/
r4,Staged,https://dev.whgazetteer.org/places/99999999/portal/
,No id,https://whgazetteer.org/places/1234/portal/
r6,Cluster,https://whgazetteer.org/places/12345999/portal/
`;
test("WHG's reconciliation ids and entity pages become its persistent addresses, with a note of what the file gave", async () => {
  const r = await readAll(textFile(WHG_CSV, 'whg.csv'));
  assert.equal(r.doc.profile, 'attestation-centric', 'place:<ns>:<id> values are recognised as addresses');
  assert.equal(valid(r.doc), null);
  const [roma, lutetia, cluster] = r.doc.attestations;
  assert.equal(roma.about, `${W3ID}place:gn:3169070`);
  assert.equal(roma.notes, 'id: r1\nPlace address given as place:gn:3169070');
  assert.equal(lutetia.about, `${W3ID}place:wd:Q90`);
  assert.match(lutetia.notes, /Place address given as https:\/\/whgazetteer\.org\/entity\/place:wd:Q90\/api$/);
  // A cluster's own address (a whg_id) has no other form, and is kept as it is, with no note.
  assert.equal(cluster.about, 'https://whgazetteer.org/places/12345999/portal/');
  assert.doesNotMatch(cluster.notes, /Place address given as/);
});
test('a WHG address that must not be carried is reported by kind; the row becomes a place of its own if it has an id', async () => {
  const r = await readAll(textFile(WHG_CSV, 'whg.csv'));
  assert.deepEqual(r.of('generic-whg-record').examples, ['row 4: https://whgazetteer.org/places/1234/portal/', 'row 6: https://whgazetteer.org/places/1234/portal/']);
  assert.deepEqual(r.of('generic-whg-staging').examples, ['row 5: https://dev.whgazetteer.org/places/99999999/portal/']);
  const ids = tableIds(STAND_IN, () => null);
  assert.deepEqual(r.doc.newSpatialEntities.map((p) => [p['@id'], p.label, p.entityIdentifier]), [[ids.place('r3'), 'Old link', 'r3'], [ids.place('r4'), 'Staged', 'r4']]);
  assert.ok(!JSON.stringify(r.doc).includes('/places/1234/'), 'the record address is carried nowhere');
  assert.ok(!r.doc.attestations.some((a) => a.about.includes('dev.whgazetteer')));
  // The row with neither is lost, reported once, as the WHG loss, not again as a row with no address.
  assert.ok(!r.kinds.has('generic-no-address') && !r.kinds.has('generic-address-not-web'));
  assert.equal(r.doc.attestations.length + r.doc.newSpatialEntities.length, 5, 'control: every other row is read');
});
test('a bare number, or whg:<n>, is never expanded into a WHG address', async () => {
  for (const v of ['2988507', 'whg:2988507']) {
    const r = await readAll(textFile(`name,whg\nA,${v}\nB,place:gn:2988507\n`, 'x.csv'), { columns: { name: 'name', whg: 'address' } });
    assert.deepEqual(r.of('generic-address-not-web').examples, [`row 2: ${v}`]);
    assert.deepEqual(r.doc.attestations.map((a) => a.about), [`${W3ID}place:gn:2988507`], 'control: the reconciliation id beside it is');
    const { mapping } = await mappingOf(await detect([textFile(`name,whg\nA,${v}\n`, 'y.csv')]));
    assert.equal(mapping.whg, 'note', `${v} is not guessed as an address`);
  }
});
test('a gazetteer column with one stray value is still the address: the file stays attestation-centric and only that row is lost', async () => {
  const rows = Array.from({ length: 49 }, (_, i) => `P${i},https://pleiades.stoa.org/places/${579885 + i}`);
  rows.splice(20, 0, 'Stray,see Barrington 42');
  const r = await readAll(textFile(`name,pleiades\n${rows.join('\n')}\n`, 'x.csv'));
  assert.equal(r.doc.profile, 'attestation-centric');
  assert.equal(r.doc.attestations.length, 49, 'control: every other row is about its address');
  assert.deepEqual(r.of('generic-address-not-web').examples, ['row 22: see Barrington 42']);
  assert.ok(!(r.doc.newSpatialEntities || []).length, 'no place is minted');
  assert.equal(valid(r.doc), null);
});
test('the WHG forms with one "whg:5" beside them are still the address, so the WHG refusals are made', async () => {
  const r = await readAll(textFile(WHG_CSV + ',Code,whg:5\n', 'whg.csv'));
  assert.equal(r.doc.profile, 'attestation-centric');
  assert.equal(r.of('generic-whg-record').examples.length, 2);
  assert.deepEqual(r.of('generic-whg-staging').examples, ['row 5: https://dev.whgazetteer.org/places/99999999/portal/']);
  assert.deepEqual(r.of('generic-address-not-web').examples, ['row 8: whg:5']);
  assert.equal(r.doc.attestations[0].about, `${W3ID}place:gn:3169070`, 'control: the reconciliation id is rewritten');
});
test('a column named for a gazetteer that is not the address is warned of, on the page and on the command line', async () => {
  const text = 'name,geonames_id\nRoma,3169070\nAthenae,264371\n';
  const m = await mappingOf(await detect([textFile(text, 'g.csv')]));
  assert.equal(m.mapping.geonames_id, 'note');
  const warn = COLUMN_WORDS.gazetteerNotAddress('geonames_id');
  assert.ok(columnWarnings(m.mapping, m.gazetteer).includes(warn));
  // Control: once it is the address, there is no such warning, and a file with no such column has none.
  assert.ok(!columnWarnings({ ...m.mapping, geonames_id: 'address' }, m.gazetteer).includes(warn));
  assert.ok(columnWarnings(m.mapping, m.gazetteer).length > columnWarnings(m.mapping, []).length);
  const d = mkdtempSync(join(tmpdir(), 'plato-tools-hermes-'));
  try {
    writeFileSync(join(d, 'g.csv'), text);
    writeFileSync(join(d, 'u.csv'), 'name,uri\nRoma,https://www.geonames.org/3169070\n');
    assert.match(cli('check', join(d, 'g.csv')).out, /Note: The column “geonames_id” is named for a gazetteer or a web address, but no column is read as the place's web address.*map it to "address" in the mapping given with --columns/);
    const u = cli('check', join(d, 'u.csv')).out;
    assert.match(u, /uri +address/, 'control: an address column is read');
    assert.doesNotMatch(u, /is named for a gazetteer/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a row with an id and no name is reported as having no name; one with neither a name nor an address, as that', async () => {
  const r = await readAll(textFile('id,name,lat,lon\nr1,Roma,41.9,12.5\nr2,,40,14\n', 'x.csv'));
  assert.deepEqual(r.of('generic-row-no-name').examples, ['row 3']);
  assert.ok(!r.kinds.has('generic-row-empty'));
  assert.deepEqual(r.doc.spatialEntities.map((p) => p.label), ['Roma'], 'control: the row with a name is read');
  const a = await readAll(textFile('id,name,uri\nr1,Roma,https://www.wikidata.org/wiki/Q220\nr2,,\n', 'y.csv'));
  assert.deepEqual(a.of('generic-row-empty').examples, ['row 3']);
  assert.ok(!a.kinds.has('generic-row-no-name'));
  assert.equal(a.doc.attestations.length, 1, 'control: the row with an address is read');
});

test('a Wikidata Query Service export is read as attestations about its items, named and placed', async () => {
  const r = await readAll(textFile('item,itemLabel,coord\nhttp://www.wikidata.org/entity/Q220,Rome,Point(12.4828 41.8931)\nhttp://www.wikidata.org/entity/Q90,Paris,Point(2.3514 48.8575)\n', 'query.csv'));
  assert.equal(r.doc.profile, 'attestation-centric');
  assert.deepEqual(r.doc.attestations.map((a) => [a.about, a.names[0].toponym, a.geometries[0].wkt]), [['http://www.wikidata.org/entity/Q220', 'Rome', 'Point(12.4828 41.8931)'], ['http://www.wikidata.org/entity/Q90', 'Paris', 'Point(2.3514 48.8575)']]);
  assert.equal(valid(r.doc), null);
});
test('a feature with a geometry and latitude and longitude properties gets one geometry, its own; the properties are notes', async () => {
  const fc = (geometry) => JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties: { NAME: 'Rome', LATITUDE: 41.9, LONGITUDE: 12.5, ne_id: 1 } }] });
  const r = await readAll(textFile(fc({ type: 'Point', coordinates: [12.48, 41.89] }), 'ne.geojson'));
  const a = r.doc.spatialEntities[0].attestations[0];
  assert.deepEqual(a.geometries.map((g) => g.geojson.coordinates), [[12.48, 41.89]]);
  assert.match(a.notes, /LATITUDE: 41\.9/);
  // Control: with no geometry of its own, the properties are its location.
  const b = (await readAll(textFile(fc(null), 'ne.geojson'))).doc.spatialEntities[0].attestations[0];
  assert.deepEqual(b.geometries.map((g) => g.reprPoint), [[12.5, 41.9]]);
});
test('a file whose every row is lost is an error, saying why, never "No problems found"; an empty one is a warning', async () => {
  // Nothing matched as the name: every row is lost.
  const r = await readAll(textFile('code,lat,lon\nA1,51.45,-2.59\nA2,51.5,-0.12\n', 'x.csv'));
  assert.deepEqual(r.of('generic-nothing-converted').examples, ["None of the 2 rows became a place: no column is matched as the place's name (or its other names), or as its web address"]);
  assert.equal(GENERIC_KINDS['generic-nothing-converted'], 'error');
  const g = await readAll(textFile(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: null, properties: { name: '' } }] }), 'x.geojson'));
  assert.deepEqual(g.of('generic-nothing-converted').examples, ['The one feature did not become a place: the columns matched as the name are empty in every row']);
  const e = await readAll(textFile(JSON.stringify({ type: 'FeatureCollection', features: [] }), 'empty.geojson'));
  assert.deepEqual(e.of('generic-empty').examples, ['empty.geojson: no features']);
  assert.ok(!e.kinds.has('generic-nothing-converted'));
  // Control: one row with a name is enough.
  const ok = await readAll(textFile('code,name\nA1,Bristol\nA2,\n', 'x.csv'));
  assert.ok(!ok.kinds.has('generic-nothing-converted') && !ok.kinds.has('generic-empty'));
  // And on the command line the run has problems, and exits 1.
  const d = mkdtempSync(join(tmpdir(), 'plato-tools-hermes-'));
  try {
    writeFileSync(join(d, 'x.csv'), 'code,lat,lon\nA1,51.45,-2.59\n');
    const c = cli('check', join(d, 'x.csv'));
    assert.equal(c.code, 1, c.out);
    assert.doesNotMatch(c.out, /No problems found/);
    assert.match(c.out, /The one row did not become a place/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('a feature that is null, a number, a string or a list, or has properties or a geometry of the wrong kind, is reported, never a TypeError', async () => {
  const features = [null, 5, 'x', [1, 2], { type: 'Feature', properties: 5, geometry: 'x' }, { type: 'Feature', properties: ['a', 'b'], geometry: [1, 2] },
    { type: 'Feature', properties: { name: 'Roma', alt: [null, 3, { a: 1 }] }, geometry: { type: 'Point', coordinates: [12.5, 41.9] } }];
  let r;
  await assert.doesNotReject(async () => { r = await readAll(textFile(JSON.stringify({ type: 'FeatureCollection', features }), 'odd.geojson'), { columns: { name: 'name', alt: 'alternativeNames', 0: 'note', 1: 'note' } }); });
  assert.deepEqual(r.of('generic-not-feature').examples, ['feature 1', 'feature 2', 'feature 3', 'feature 4']);
  assert.ok(r.kinds.has('generic-geometry-invalid'));
  // Control: the well-formed feature is read, its odd list items as text.
  assert.deepEqual(r.doc.spatialEntities.map((p) => [p.label, p.attestations[0].names.map((n) => n.toponym)]), [['Roma', ['Roma', '3', '{"a":1}']]]);
  await assert.doesNotReject(detect([textFile(JSON.stringify({ type: 'FeatureCollection', features }), 'odd.geojson')]));
  await assert.doesNotReject(detect([textFile(JSON.stringify({ type: 'FeatureCollection', features: 7 }), 'odd.geojson')]));
  // Features that are not a list are not one feature: a number is an error, null is no features.
  const seven = await readAll(textFile(JSON.stringify({ type: 'FeatureCollection', features: 7 }), 'odd.geojson'));
  assert.deepEqual(seven.of('generic-features-not-list').examples, ['features is a number']);
  assert.ok(!seven.kinds.has('generic-not-feature'));
  assert.equal(seven.counts.features, undefined);
  const none = await readAll(textFile(JSON.stringify({ type: 'FeatureCollection', features: null }), 'odd.geojson'));
  assert.ok(!none.kinds.has('generic-features-not-list') && !none.kinds.has('generic-not-feature'));
  assert.ok(none.kinds.has('generic-empty'));
});
test('a row whose address is not one, but which has an id, becomes a place of its own, keeping what the address column said', async () => {
  const r = await readAll(textFile('id,name,wikidata\nr1,Roma,https://www.wikidata.org/wiki/Q220\nr2,Athenae,Q1524\n', 'x.csv'), { columns: { id: 'id', name: 'name', wikidata: 'address' } });
  assert.deepEqual(r.doc.attestations.map((a) => a.about), ['https://www.wikidata.org/wiki/Q220']);
  assert.deepEqual(r.doc.newSpatialEntities.map((p) => [p.entityIdentifier, p.attestations[0].notes]), [['r2', 'wikidata: Q1524']]);
  assert.ok(!r.kinds.has('generic-address-not-web'), 'nothing is lost, so nothing is reported');
  assert.equal(valid(r.doc), null);
});

// ---- bad input -------------------------------------------------------------------------------------------
test('a CSV row with too many or too few cells is read as far as it goes, and reported', async () => {
  const r = await readAll(textFile('name,lat,lon\nA,1,2,extra\nB,1\nC,3,4\n', 'x.csv'));
  assert.deepEqual(r.of('generic-csv-extra-cells').examples, ['row 2: extra']);
  assert.ok(r.of('generic-csv-row').examples.some((e) => e.startsWith('row 3')));
  assert.equal(r.doc.spatialEntities.length, 3);
});
test('a quotation mark that is never closed, or stray in a quoted cell, stops the file, naming the line; it never merges the rows', async () => {
  await assert.rejects(readAll(textFile('id,name\n1,"Roma\n2,Ostia\n3,Athenae\n', 'x.csv')),
    (e) => e instanceof DataError && /never closed near line 2/.test(e.message));
  await assert.rejects(readAll(textFile('id,name\n1,Roma\n2,"Os"tia"\n3,Athenae\n', 'x.csv')),
    (e) => e instanceof DataError && /stray quotation mark in a quoted cell .* near line 3/.test(e.message));
  // Control: quotes used as CSV uses them, a line break and a doubled quotation mark inside a cell.
  const r = await readAll(textFile('id,name\n1,"Roma\nnova"\n2,"Os""tia"\n3,Athenae\n', 'x.csv'));
  assert.deepEqual(r.doc.spatialEntities.map((p) => p.label), ['Roma\nnova', 'Os"tia', 'Athenae']);
  assert.ok(!r.kinds.has('generic-csv-row'));
});
test('two columns with one heading are both read, each known by its heading and place, and the report says so', async () => {
  const r = await readAll(textFile('id,name,name\n1,Roma,Rome\n', 'x.csv'));
  assert.deepEqual(r.of('generic-csv-duplicate-header').examples, ['"name": 2 columns (2, 3), read as "name (column 2)", "name (column 3)"']);
  assert.equal(r.of('generic-csv-duplicate-header').severity, 'warning');
  const p = r.doc.spatialEntities[0];
  assert.equal(p.label, 'Roma', 'the first is guessed as the name, from its heading');
  assert.equal(p.attestations[0].notes, 'name (column 3): Rome');
  const { headers } = await columnsOf(r.input);
  assert.deepEqual(headers, ['id', 'name (column 2)', 'name (column 3)']);
  const { reasons } = await mappingOf(r.input);
  assert.match(reasons['name (column 3)'], /already column "name \(column 2\)"/);
  assert.ok(!Object.keys(reasons).some((h) => /name_1/.test(h)));
  // Control: headings that differ are read as they are, with nothing reported.
  const c = await readAll(textFile('id,name,other\n1,Roma,Rome\n', 'x.csv'));
  assert.deepEqual([(await columnsOf(c.input)).headers, c.kinds.has('generic-csv-duplicate-header')], [['id', 'name', 'other'], false]);
});
test('a column or a property called __proto__ is read like any other, in a CSV file and in GeoJSON', async () => {
  const r = await readAll(textFile('id,__proto__,name\n1,x,Roma\n', 'x.csv'));
  assert.deepEqual((await columnsOf(r.input)).headers, ['id', '__proto__', 'name']);
  assert.equal(r.doc.spatialEntities[0].label, 'Roma', 'control');
  assert.equal(r.doc.spatialEntities[0].attestations[0].notes, '__proto__: x');
  const gj = '{"type":"FeatureCollection","features":[{"type":"Feature","id":"f1","geometry":null,"properties":{"__proto__":{"a":1},"name":"Roma"}}]}';
  const g = await readAll(textFile(gj, 'x.geojson'));
  assert.deepEqual((await columnsOf(g.input)).headers, [FEATURE_ID, '__proto__', 'name']);
  assert.equal(g.doc.spatialEntities[0].label, 'Roma', 'control');
  assert.equal(g.doc.spatialEntities[0].attestations[0].notes, '__proto__: {"a":1}');
});
// ---- streaming: a CSV file is read a chunk at a time, never whole ------------------------------------------
async function* inChunks(text, size) { for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size); }
const streamed = async (text, size, opts) => { const out = []; for await (const r of csvRecords(inChunks(text, size), opts)) out.push(r); return out; };
test('a CSV file read in chunks of any size gives the rows Papa gives reading it whole', async () => {
  const texts = ['id,name\n1,"Roma\nnova"\n2,"Os""tia"\n\n3,Athenae\n', 'id,name\r\n1,"Ro,ma"\r\n2,"x"\r\n3,""\r\n', 'a;b;c\n1;"2;3";4\n5;6;7', 'one\nA\n\nB\n', 'a,b\n"q ""x"" q","y\r\nz"\nlast,row\n'];
  let compared = 0;
  for (const t of texts) {
    // Past the first ten lines, from which the delimiter and the line break are guessed, the chunks are as small as they are given.
    const nl = t.includes('\r\n') ? '\r\n' : '\n', [head, ...body] = t.split(nl);
    const text = [head, ...Array.from({ length: 12 }, () => body.filter(Boolean)).flat()].join(nl) + nl;
    const whole = Papa.parse(text, { skipEmptyLines: 'greedy' }).data;
    assert.ok(whole.length >= 3, text);
    for (const size of [1, 2, 3, 5, 7, 11, 64, 100000]) { assert.deepEqual(await streamed(text, size), whole, `${JSON.stringify(t)} in chunks of ${size}`); compared++; }
  }
  assert.equal(compared, 40);
});
test('a quotation mark out of place stops the file wherever it is, however the file is cut into chunks, naming its line', async () => {
  const rows = Array.from({ length: 30000 }, (_, i) => `${i},Place ${i}`);
  const good = ['id,name', ...rows].join('\n') + '\n';
  const bad = ['id,name', ...rows.slice(0, 20000), '20000,"Roma', ...rows.slice(20001)].join('\n') + '\n';
  const stray = ['id,name', ...rows.slice(0, 25000), '25000,"Os"tia"', ...rows.slice(25001)].join('\n') + '\n';
  for (const size of [1000, 4096, 65536]) {
    await assert.rejects(streamed(bad, size), (e) => e instanceof DataError && /never closed near line 20002/.test(e.message), `chunks of ${size}`);
    await assert.rejects(streamed(stray, size), (e) => e instanceof DataError && /stray quotation mark .* near line 25002/.test(e.message), `chunks of ${size}`);
    assert.equal((await streamed(good, size)).length, 30001, `control, chunks of ${size}`);
  }
  // Through the reader, from a file: the rows before are read, and the file is still refused.
  await assert.rejects(readAll(textFile(bad, 'x.csv')), (e) => e instanceof DataError && /near line 20002/.test(e.message));
  assert.equal((await readAll(textFile(good, 'x.csv'))).doc.spatialEntities.length, 30000, 'control');
});
test('a GeoJSON FeatureCollection is read twice, and a CSV file once whole beside the start of it, however many steps ask for its columns', async () => {
  for (const f of ['plain.geojson', 'with-ids.csv']) {
    let streams = 0;
    const counted = new (class extends File { stream() { streams++; return super.stream(); } })([readFileSync(DIR + f)], f);
    const input = await detect([counted]);
    const before = streams;   // detection reads a GeoJSON file's start; a CSV file only by its name
    await genericProfile(input); await columnsOf(input); await mappingOf(input);
    const rep = new Report(); let records = 0;
    for await (const ev of genericSource(input, rep)) if (ev.type === 'record') records++;
    assert.ok(records > 0, f);
    assert.equal(streams - before, 2, f);
  }
});
test('a CSV file with no header, and GeoJSON in another reference system, are refused', async () => {
  await assert.rejects(readAll(textFile('\n\n', 'x.csv')), DataError);
  const crs = { type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::27700' } }, features: [{ type: 'Feature', properties: { name: 'A' }, geometry: { type: 'Point', coordinates: [400000, 500000] } }] };
  await assert.rejects(readAll(textFile(JSON.stringify(crs), 'x.geojson')), (e) => e instanceof DataError && /EPSG::27700/.test(e.message));
  crs.crs.properties.name = 'urn:ogc:def:crs:OGC:1.3:CRS84';
  crs.features[0].geometry.coordinates = [-1, 52];
  await assert.doesNotReject(readAll(textFile(JSON.stringify(crs), 'x.geojson')), 'control: WGS 84 named is read');
});

// ---- through the engine (once src/engine/pipeline.js dispatches to the reader) ---------------------
const wired = /genericSource/.test(readFileSync('src/engine/pipeline.js', 'utf8'));
const skip = wired ? false : 'src/engine/pipeline.js does not yet dispatch csv and geojson to src/engine/hermes/generic.js';
test('through the engine: converted to PLATO JSON and N-Triples with no errors, place-centric and attestation-centric', { skip }, async () => {
  for (const [f, stem] of [['with-ids.csv', 'with-ids'], ['odd-headers.csv', 'odd-headers'], ['feature-ids.geojson', 'feature-ids']]) {
    const j = await go([fx(f)], 'convert', 'plato-json');
    assert.equal(j.report.errors, 0, `${f}: ${JSON.stringify(j.report.items.filter((i) => i.severity === 'error'))}`);
    const pc = JSON.parse(outText(j.e, `${stem}.json`));
    assert.equal(valid(pc), null);
    assert.ok(pc.spatialEntities.length > 0);
    const n = await go([fx(f)], 'convert', 'ntriples');
    assert.equal(n.report.errors, 0, f);
    assert.match(outText(n.e, `${stem}.nt`), /<https:\/\/w3id\.org\/plato#attests_about>|contains_entity/);
  }
});
test('through the engine: a duplicate id stops the run with no output', { skip }, async () => {
  const r = await go([fx('duplicate-ids.csv')], 'convert', 'plato-json');
  assert.ok(r.incomplete);
  assert.deepEqual(r.outputs, []);
  assert.ok(r.report.items.some((i) => i.severity === 'error' && i.examples.some((e) => /"a"/.test(e))));
});

// ---- the command line -----------------------------------------------------------------------------
const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
test('command line: --columns that is not a JSON object is refused before anything is read', () => {
  const d = mkdtempSync(join(tmpdir(), 'plato-tools-hermes-'));
  try {
    writeFileSync(join(d, 'bad.json'), '["name"]');
    const r = cli('check', '--columns', join(d, 'bad.json'), DIR + 'no-ids.csv');
    assert.equal(r.code, 2);
    assert.match(r.err, /must hold one JSON object/);
    const r2 = cli('check', '--columns', join(d, 'missing.json'), DIR + 'no-ids.csv');
    assert.equal(r2.code, 2);
    assert.match(r2.err, /cannot be read as JSON/);
    // A mapping that is not UTF-8 is refused too; the control, the same in UTF-8, is used.
    writeFileSync(join(d, 'latin1.json'), Buffer.from('{"Köln": "name"}', 'latin1'));
    const r3 = cli('check', '--columns', join(d, 'latin1.json'), DIR + 'no-ids.csv');
    assert.equal(r3.code, 2);
    assert.match(r3.err, /latin1\.json cannot be read as JSON: .*utf-8/i);
    writeFileSync(join(d, 'utf8.json'), '{"Köln": "name"}');
    assert.notEqual(cli('check', '--columns', join(d, 'utf8.json'), DIR + 'no-ids.csv').code, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('command line: columns whose headings are numbers are printed, and given in --json, in the file\'s order', () => {
  const d = mkdtempSync(join(tmpdir(), 'plato-tools-hermes-'));
  try {
    writeFileSync(join(d, 'census.csv'), 'parish,1801,1811,name\nAshby,120,131,Ashby\n');
    const r = cli('check', join(d, 'census.csv'));
    assert.ok(r.out.includes('{"parish":"note","1801":"note","1811":"note","name":"name"}'), r.out);
    assert.match(r.out, / {4}parish +note[^\n]*\n {4}1801 +note[^\n]*\n {4}1811 +note[^\n]*\n {4}name +name/);
    const j = JSON.parse(cli('check', '--json', join(d, 'census.csv')).out.split('\n')[0]);
    assert.deepEqual(j.columns.map((c) => c.column), ['parish', '1801', '1811', 'name']);
    // Control: an object of the same mapping would have put the numbers first.
    assert.deepEqual(Object.keys({ parish: 1, 1801: 1, 1811: 1, name: 1 }), ['1801', '1811', 'parish', 'name']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('command line: the columns as read are printed with the report, as JSON to save and give back', { skip }, () => {
  const r = cli('check', DIR + 'odd-headers.csv');
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /Columns read as/);
  assert.ok(r.out.includes('{"Place Name":"name","LAT":"latitude","Long":"longitude","wikidata":"address"'));
  const j = JSON.parse(cli('check', '--json', DIR + 'odd-headers.csv').out.split('\n')[0]);
  assert.deepEqual(j.columns.find((c) => c.column === 'wikidata'), { column: 'wikidata', field: 'address', reason: 'the heading "wikidata" reads as the place\'s web address, and all 7 of its sampled values are web addresses' });
  assert.equal(j.profile, 'attestation-centric');
});
