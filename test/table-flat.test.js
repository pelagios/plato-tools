// The flat table (convert --to table-flat, src/formats/flat.js): one row for each place, to open in
// a spreadsheet, holding only what the dataset records. Every absence asserted here (no match, an
// empty cell, a row not there) stands beside a presence read from the same output.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import { go, textFile, file, outText } from './engine.js';
import { TARGETS } from '../src/engine/pipeline.js';
import { LOSS_TEXT } from '../src/engine/report.js';
import { matchBasis } from '../src/engine/hermes/columns.js';
import { guardWords, choraDrawingNote } from '../src/engine/words.js';
import { FLAT_BEFORE, FLAT_AFTER, MATCH_STATUS, MATCH_UNSPECIFIED, NO_MATCH, BOM, NOTE_COLUMNS, splitNotes, FlatTable } from '../src/formats/flat.js';

const B = 'https://example.org/places/';
const WHG = { title: 'World Historical Gazetteer', authorityType: 'dataset' };
const TABLE = { title: 'my-places.csv', authorityType: 'source' };
const REVIEWER = { name: 'Ada Reviewer' };
const WHEN = '2026-11-01T10:00:00Z';
const own = (name, more = {}) => ({ names: [{ toponym: name }], sources: [TABLE], citations: [{ source: TABLE }], ...more });
const identity = (subject, targets, more = {}) => ({ identities: targets.map(([object, identityType, basis]) => ({ subject, object, identityType, ...(basis ? { basis } : {}) })), ...more });
const reviewed = (subject, targets, more = {}) => identity(subject, targets, { contributor: REVIEWER, created: WHEN, citations: [{ source: WHG }], ...more });
const place = (id, label, attestations, more = {}) => ({ '@id': B + id, label, entityIdentifier: id, attestations, ...more });
const dataset = (spatialEntities, more = {}) => JSON.stringify({ $schema: 'https://w3id.org/plato/schemas/place-centric.schema.json', profile: 'place-centric', gazetteer: { title: 'My places' }, spatialEntities, ...more });

const COPIED_NOTE = 'Copied from World Historical Gazetteer record https://w3id.org/whg/id/place:pl:658381 ("Emesa"; upstream source: Pleiades (pl); id 658381; licence CC-BY-3.0), fetched 2026-11-01; in PLATO tools (Chora). The identity with this record is a separate attestation.';
const POLYGON = { type: 'Polygon', coordinates: [[[10, 50], [12, 50], [12, 52], [10, 52], [10, 50]]] };
const PLACES = [
  // An exact match a reviewer accepted, and the location copied from the record.
  place('emesa', 'Emesa', [
    own('Emesa', { names: [{ toponym: 'Emesa' }, { toponym: 'Ḥimṣ' }, { toponym: 'Homs' }], types: [{ identifier: 'http://vocab.getty.edu/aat/300008347', label: 'settlement' }], timespans: [{ startEarliest: '1200', endLatest: '1300' }], notes: 'region: Syria\nremark: the modern Homs (Ḥimṣ), "City of the Sun", see below\nits second line' }),
    reviewed(B + 'emesa', [['https://w3id.org/whg/id/place:pl:658381', 'exactMatch', 'Same name and river']], { notes: 'remark: accepted by the reviewer in a match review (PLATO tools, Krisis).' }),
    { geometries: [{ geojson: { type: 'Point', coordinates: [36.72, 34.73] }, reprPoint: [36.72, 34.73] }], contributor: REVIEWER, created: WHEN, timespans: [{ startEarliest: '-0300' }],
      citations: [{ source: { ...WHG, licence: 'https://spdx.org/licenses/CC-BY-3.0' }, locator: 'https://w3id.org/whg/id/place:pl:658381', citationFunction: 'http://purl.org/spar/cito/citesAsEvidence' }], notes: COPIED_NOTE },
  ]),
  // A close match a reviewer accepted; the table's own point.
  place('gora', 'Góra', [own('Góra', { geometries: [{ geojson: { type: 'Point', coordinates: [16.074648, 52.62206] } }] }), reviewed(B + 'gora', [['https://www.wikidata.org/entity/Q1010', 'closeMatch']])]),
  // A match the table itself gave: no contributor, and the basis says so.
  place('livorno', 'Livorno', [own('Livorno'), identity(B + 'livorno', [['https://sws.geonames.org/3174659/', 'closeMatch', matchBasis('my-places.csv', 'matches')]], { sources: [TABLE], citations: [{ source: TABLE, locator: 'row 4' }] })]),
  // No match at all.
  place('gebal', 'Gebal', [own('Gebal', { notes: 'region: Lebanon' })]),
  // Two matches: the table's close match, and an exact match accepted in bulk (listed first).
  place('zurich', 'Zurich', [
    own('Zurich'),
    identity(B + 'zurich', [['https://sws.geonames.org/2657896/', 'closeMatch', matchBasis('my-places.csv', 'matches')]]),
    reviewed(B + 'zurich', [['https://pleiades.stoa.org/places/187612', 'exactMatch', guardWords.basis({ exact: true })]]),
  ]),
  // A shape: its representative point as the dataset records it, and the shape as WKT.
  place('saxony', 'Saxony', [own('Saxony', { geometries: [{ geojson: POLYGON, reprPoint: [11.5, 51.25] }] })]),
  // A shape with no point recorded, drawn by a person: the point is worked out, and said to be.
  place('halle', 'Halle', [own('Halle'), { geometries: [{ geojson: POLYGON }], contributor: REVIEWER, created: WHEN, notes: choraDrawingNote({ zoom: 9 }) }]),
  // A related place; and a match with no kind stated, given on its own after the places.
  place('geneva', 'Geneva', [own('Geneva'), reviewed(B + 'geneva', [['https://vocab.getty.edu/tgn/7007279', 'related']])]),
  place('salzburg', 'Salzburg', [own('Salzburg')]),
];
const RELATIONS = [{ subject: B + 'salzburg', object: 'https://gazetteer.example.net/id/77', identityType: 'unspecified' }];

async function flat(text, name = 'my-places.json', options = {}) {
  const r = await go([textFile(text, name)], 'convert', 'table-flat', options);
  const out = Object.keys(r.e.outs);
  assert.deepEqual(out, [name.replace(/\.[^.]+$/, '') + '.flat.csv'], 'one output, named after the input');
  const csv = outText(r.e, out[0]);
  const parsed = Papa.parse(csv.replace(/^﻿/, ''), { skipEmptyLines: true });
  assert.deepEqual(parsed.errors, [], 'the CSV parses cleanly');
  const [header, ...rows] = parsed.data;
  const records = rows.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i]])));
  const kinds = (severity) => r.report.items.filter((i) => i.severity === severity).map((i) => i.kind);
  return { r, csv, header, rows, records, by: Object.fromEntries(records.map((x) => [x.place_id, x])), kinds, item: (kind) => r.report.items.find((i) => i.kind === kind) };
}

test('the target is listed, and its extension is .flat.csv', () => {
  assert.equal(TARGETS['table-flat'].ext, '.flat.csv');
  assert.match(TARGETS['table-flat'].label, /one row per place/);
});

test('one row for each place: the header, the columns made of the notes, and nothing lost on the way to CSV', async () => {
  const { header, rows, records, by, csv, r } = await flat(dataset(PLACES, { identityRelations: RELATIONS }));
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items.filter((i) => i.severity === 'error'), null, 1));
  assert.deepEqual(header, [...FLAT_BEFORE, 'region', 'remark', ...FLAT_AFTER]);
  assert.deepEqual(header, ['place_id', 'label', 'alternative_names', 'kind', 'region', 'remark', 'notes', 'start', 'end', 'match_status', 'match_id', 'matches_count', 'match_source', 'match_given_by', 'lat', 'lon', 'geometry_wkt', 'geometry_note', 'source', 'is_region']);
  assert.equal(rows.length, PLACES.length, 'one row for each place, not for each attestation');
  assert.ok(rows.every((cells) => cells.length === header.length), 'every row has every column');
  assert.deepEqual(records.map((x) => x.place_id), ['emesa', 'gora', 'livorno', 'gebal', 'zurich', 'saxony', 'halle', 'geneva', 'salzburg']);
  assert.equal(r.report.counts['table rows'], PLACES.length);

  // Excel reads it: a byte-order mark first, and CRLF between rows.
  assert.equal(csv[0], BOM);
  assert.ok(csv.startsWith(BOM + 'place_id,label,'));
  assert.ok(csv.endsWith('\r\n'));

  // Accents, and a cell with commas, quotation marks and a line break, come back as they went in.
  const emesa = by.emesa;
  assert.equal(emesa.label, 'Emesa');
  assert.equal(emesa.alternative_names, 'Ḥimṣ; Homs', 'the other names, without the label');
  assert.equal(emesa.kind, 'settlement');
  assert.equal(emesa.region, 'Syria');
  assert.equal(emesa.remark, 'the modern Homs (Ḥimṣ), "City of the Sun", see below\nits second line');
  assert.match(csv, /"the modern Homs \(Ḥimṣ\), ""City of the Sun"", see below\nits second line"/, 'quoted as CSV quotes it');
  assert.equal(emesa.notes, 'remark: accepted by the reviewer in a match review (PLATO tools, Krisis).\n' + COPIED_NOTE, "a reviewer's notes are kept whole, never made columns");
  assert.equal(by.gora.label, 'Góra');
  assert.equal(by.gebal.region, 'Lebanon');
  assert.equal(by.gora.region, '', 'a place with no such note has an empty cell (Gebal and Emesa have theirs)');
  assert.equal(emesa.source, 'my-places.csv');
});

test('match_status says only what the dataset records, in plain words', async () => {
  const { by, item } = await flat(dataset(PLACES, { identityRelations: RELATIONS }));
  const of = (id) => [by[id].match_status, by[id].match_id, by[id].matches_count, by[id].match_source, by[id].match_given_by];
  assert.deepEqual(of('emesa'), ['same place (exact match)', 'https://w3id.org/whg/id/place:pl:658381', '1', 'World Historical Gazetteer', 'the reviewer Ada Reviewer']);
  assert.deepEqual(of('gora'), ['much the same place (close match)', 'https://www.wikidata.org/entity/Q1010', '1', 'Wikidata', 'the reviewer Ada Reviewer']);
  assert.deepEqual(of('livorno'), ['much the same place (close match)', 'https://sws.geonames.org/3174659/', '1', 'GeoNames', 'the table']);
  assert.deepEqual(of('gebal'), ['no match recorded', '', '0', '', '']);
  assert.deepEqual(of('geneva'), ['a related place', 'https://vocab.getty.edu/tgn/7007279', '1', 'Getty Thesaurus of Geographic Names', 'the reviewer Ada Reviewer']);
  // Two matches: the strongest first and in match_status, the count beside them, and who gave each.
  assert.deepEqual(of('zurich'), ['same place (exact match)', 'https://pleiades.stoa.org/places/187612 ; https://sws.geonames.org/2657896/', '2', 'Pleiades ; GeoNames', 'bulk accept by Ada Reviewer ; the table']);
  // A relation given on its own, its kind not stated, from a gazetteer these tools do not know by name.
  assert.deepEqual(of('salzburg'), ['a match, its kind not stated', 'https://gazetteer.example.net/id/77', '1', 'gazetteer.example.net', 'the dataset (no reviewer recorded)']);
  assert.deepEqual([MATCH_STATUS.exactMatch, MATCH_STATUS.closeMatch, MATCH_STATUS.related, MATCH_UNSPECIFIED, NO_MATCH],
    ['same place (exact match)', 'much the same place (close match)', 'a related place', 'a match, its kind not stated', 'no match recorded']);

  // The honesty note: counted (three places: Gebal, Saxony, Halle), and saying what the dataset cannot.
  const note = item('flat-no-match-recorded');
  assert.equal(note.severity, 'note');
  assert.equal(note.count, 3);
  assert.match(note.message, /never looked up/);
  assert.match(note.message, /skipped/);
  assert.match(note.message, /no candidate was found/);
  assert.match(note.message, /work file/);
  assert.equal(item('flat-summary').severity, 'note');
  assert.deepEqual(item('flat-notes-columns').examples, ['region, remark']);
});

test('a status the dataset does not record is never written: no cell says skipped, left out or not found', async () => {
  const { records, by } = await flat(dataset(PLACES, { identityRelations: RELATIONS }));
  const allowed = new Set([...Object.values(MATCH_STATUS), MATCH_UNSPECIFIED, NO_MATCH]);
  assert.equal(by.gebal.match_status, NO_MATCH, 'the unmatched place is there, and says so');
  for (const x of records) assert.ok(allowed.has(x.match_status), x.match_status);
});

test('the location: a point as lat and lon, a shape as WKT with its point, and where each came from', async () => {
  const { by, item } = await flat(dataset(PLACES));
  const of = (id) => [by[id].lat, by[id].lon, by[id].geometry_wkt, by[id].geometry_note];
  assert.deepEqual(of('gora'), ['52.62206', '16.074648', '', 'own to the table']);
  assert.deepEqual(of('emesa'), ['34.73', '36.72', '', 'copied from https://w3id.org/whg/id/place:pl:658381 (licence CC-BY-3.0) by Ada Reviewer']);
  const wkt = 'POLYGON((10 50, 12 50, 12 52, 10 52, 10 50))';
  assert.deepEqual(of('saxony'), ['51.25', '11.5', wkt, 'own to the table; lat and lon are the representative point the dataset records for the shape']);
  assert.deepEqual(of('halle'), ['51', '11', wkt, 'drawn by Ada Reviewer; lat and lon are a representative point worked out from the shape by PLATO tools']);
  assert.deepEqual(of('gebal'), ['', '', '', ''], 'a place with no location has none (Góra has its own)');
  // The dates are the place's own: the copied location's dates (the record's) are not the place's.
  assert.deepEqual([by.emesa.start, by.emesa.end], ['1200', '1300']);
  assert.deepEqual([by.gora.start, by.gora.end], ['', '']);
  assert.equal(item('flat-more-locations'), undefined, 'no place here has two locations');
});

test('a second location, a second date and what has no column are reported, never dropped silently', async () => {
  const text = dataset([
    place('a', 'Alpha', [
      own('Alpha', { geometries: [{ geojson: { type: 'Point', coordinates: [1, 2] } }], timespans: [{ startEarliest: '1100', startLatest: '1150', endLatest: '1200' }] }),
      own('Alpha', { geometries: [{ geojson: { type: 'Point', coordinates: [3, 4] } }], timespans: [{ startEarliest: '1500' }] }),
      own('Alpha', { relations: [{ relationType: 'plato:ContainedIn', relatesTo: B + 'r' }] }),
      own('Alpha', { names: [], properties: [{ property: 'https://example.org/p/population', value: 120 }] }),
      own('Aleph', { negated: true }),
    ]),
    place('b', 'Beta', [own('Beta', { timespans: [{ sourceLabel: 'in the time of the old king' }] })]),
    place('r', 'The Region', [own('The Region')]),
  ]);
  const { by, kinds, item, header } = await flat(text);
  assert.deepEqual([by.a.lat, by.a.lon], ['2', '1'], 'the first location');
  assert.equal(by.a.geometry_note, 'own to the table; 1 more location of this place in the dataset is not shown');
  assert.deepEqual([by.a.start, by.a.end], ['1100', '1200']);
  assert.equal(by.a.alternative_names, '', 'the name the source denies is not a name of the place');
  assert.deepEqual([by.b.start, by.b.end], ['', '']);
  // A place another lies in is a row too, and flagged.
  assert.deepEqual([by.r.is_region, by.a.is_region], ['yes', '']);
  assert.deepEqual(header, [...FLAT_BEFORE, ...FLAT_AFTER], 'no notes, no columns of their own');
  const losses = kinds('loss');
  for (const k of ['flat-more-locations', 'flat-more-dates', 'four-date-bounds', 'flat-facet-not-carried', 'flat-denied', 'flat-date-in-words', 'flat-gazetteer']) assert.ok(losses.includes(k), `${k} is reported: ${losses}`);
  assert.deepEqual(item('flat-facet-not-carried').examples, [`${B}a: relations`, `${B}a: properties`]);
  assert.deepEqual(item('flat-date-in-words').examples, [`${B}b: in the time of the old king`]);
  for (const i of [...kinds('loss'), ...kinds('note')].filter((k) => k.startsWith('flat-'))) assert.ok(typeof LOSS_TEXT[i] === 'string' && LOSS_TEXT[i].length > 40, `${i} has words`);
});

test('a match withdrawn, or denied, is not a match: only the current state is shown', async () => {
  const match = { '@id': B + 'a#a-1', ...reviewed(B + 'a', [['https://sws.geonames.org/1/', 'exactMatch']]) };
  // The retraction sits under another place, so only a reading of the whole document finds it.
  const retraction = { '@id': B + 'b#a-2', contributor: REVIEWER, created: WHEN, notes: 'Withdrawn.', meta: [{ metaType: 'plato:Retracts', targetAttestation: B + 'a#a-1' }] };
  const denial = { ...reviewed(B + 'b', [['https://sws.geonames.org/2/', 'exactMatch']]), negated: true };
  const kept = await flat(dataset([place('a', 'Alpha', [own('Alpha'), match]), place('b', 'Beta', [own('Beta')])]));
  assert.deepEqual([kept.by.a.match_status, kept.by.a.match_id], ['same place (exact match)', 'https://sws.geonames.org/1/'], 'control: the match is shown while it stands');
  const { by, kinds } = await flat(dataset([place('a', 'Alpha', [own('Alpha'), match]), place('b', 'Beta', [own('Beta'), retraction, denial]), place('c', 'Gamma', [own('Gamma'), reviewed(B + 'c', [['https://sws.geonames.org/3/', 'closeMatch']])])]));
  assert.deepEqual([by.c.match_status, by.c.match_id], ['much the same place (close match)', 'https://sws.geonames.org/3/'], 'a match that stands is shown');
  assert.deepEqual([by.a.match_status, by.a.match_id, by.a.matches_count], ['no match recorded', '', '0'], 'the withdrawn match is not');
  assert.deepEqual([by.b.match_status, by.b.match_id], ['no match recorded', ''], '"not the same place" is not a match');
  assert.ok(kinds('loss').includes('retracted') && kinds('loss').includes('identity-denied'), `both are reported: ${kinds('loss')}`);
});

test('a cell a spreadsheet would run as a formula is guarded, and a negative number is left alone', async () => {
  const text = dataset([place('x', '=HYPERLINK("https://example.org","click")', [own('=HYPERLINK("https://example.org","click")', { geometries: [{ geojson: { type: 'Point', coordinates: [-1.25, -51.5] } }], timespans: [{ startEarliest: '-0500' }], notes: 'remark: +see also @home' })])]);
  const { by, records, item } = await flat(text);
  const x = records[0];
  assert.equal(x.label, '\'=HYPERLINK("https://example.org","click")');
  assert.equal(x.remark, "'+see also @home");
  assert.deepEqual([x.lat, x.lon, x.start], ['-51.5', '-1.25', '-0500'], 'numbers below zero are not touched');
  assert.equal(item('flat-formula-guard').count, 2);
  assert.equal(by.x.place_id, 'x');
});

test("the notes: only the table's own \"heading: value\" lines become columns, and no more than the limit", () => {
  assert.deepEqual(splitNotes('first words\ntitle_uri: https://example.org/a\ndescription: a town: old\nhttps://example.org/b\nempty:'),
    { columns: [['title_uri', 'https://example.org/a'], ['description', 'a town: old\nhttps://example.org/b'], ['empty', '']], rest: 'first words' });
  assert.deepEqual(splitNotes('https://example.org/a'), { columns: [], rest: 'https://example.org/a' }, 'a web address alone is not a heading');
  // A heading named as one of the table's own columns is told apart; one beyond the limit stays in notes.
  const t = new FlatTable();
  const lines = ['label: the old label', ...Array.from({ length: NOTE_COLUMNS + 1 }, (_, i) => `h${i}: v${i}`)];
  t.record({ type: 'record', value: place('p', 'P', [own('P', { notes: lines.join('\n') })]) });
  const { header, rows } = t.table();
  assert.equal(header.length, FLAT_BEFORE.length + NOTE_COLUMNS + FLAT_AFTER.length);
  assert.equal(header[FLAT_BEFORE.length], 'label (note)');
  assert.equal(rows[0][header.indexOf('label (note)')], 'the old label');
  assert.equal(rows[0][header.indexOf('label')], 'P');
  assert.equal(rows[0][header.indexOf(`h${NOTE_COLUMNS - 2}`)], `v${NOTE_COLUMNS - 2}`, 'the last heading within the limit is a column');
  assert.ok(!header.includes(`h${NOTE_COLUMNS - 1}`) && !header.includes(`h${NOTE_COLUMNS}`));
  assert.equal(rows[0][header.indexOf('notes')], `h${NOTE_COLUMNS - 1}: v${NOTE_COLUMNS - 1}\nh${NOTE_COLUMNS}: v${NOTE_COLUMNS}`, 'those beyond it are kept, as they were written');
});

test('a candidate set is refused, as the other tables refuse it; a dataset in the same call is written', async () => {
  const set = JSON.stringify({ $schema: 'https://w3id.org/plato/schemas/candidate-set.schema.json', profile: 'candidate-set', candidateSet: { '@id': 'https://example.org/sets/1', title: 'A set' }, candidates: [] });
  const r = await go([textFile(set, 'set.json')], 'convert', 'table-flat');
  assert.ok(r.incomplete && !r.outputs.length && r.report.items.some((i) => i.kind === 'candidate-set-target'));
  const ok = await go([textFile(dataset(PLACES), 'd.json')], 'convert', 'table-flat');
  assert.ok(!ok.incomplete && ok.outputs.length === 1);
});

// ---- the command line, on a real table ---------------------------------------------------------------
const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test("convert --to table-flat reads WHG's LP-TSV example: its header and its twelve rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plato-tools-flat-test-')); made.push(dir);
  const r = cli('convert', '--to', 'table-flat', '--out', dir, 'test/fixtures/generic/whg-lp7-12.tsv');
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /12 table rows/);
  assert.match(r.out, /whg-lp7-12\.flat\.csv/);
  const bytes = readFileSync(join(dir, 'whg-lp7-12.flat.csv'));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'UTF-8, with its byte-order mark');
  const csv = bytes.toString('utf8');
  const { data, errors } = Papa.parse(csv.replace(/^﻿/, ''), { skipEmptyLines: true });
  assert.deepEqual(errors, []);
  const [header, ...rows] = data;
  assert.deepEqual(header, ['place_id', 'label', 'alternative_names', 'kind', 'title_uri', 'description', 'notes', 'start', 'end', 'match_status', 'match_id', 'matches_count', 'match_source', 'match_given_by', 'lat', 'lon', 'geometry_wkt', 'geometry_note', 'source', 'is_region']);
  assert.equal(rows.length, 12);
  const col = (h) => rows.map((x) => x[header.indexOf(h)]);
  // The table's own ids, in its own order, and its own columns back under their headings.
  const source = Papa.parse(readFileSync('test/fixtures/generic/whg-lp7-12.tsv', 'utf8'), { header: true, delimiter: '\t', skipEmptyLines: true }).data;
  assert.deepEqual(col('place_id'), source.map((x) => x.id));
  assert.deepEqual(col('label'), source.map((x) => x.title));
  assert.deepEqual(col('description'), source.map((x) => x.description));
  assert.deepEqual(col('title_uri'), source.map((x) => x.title_uri));
  assert.deepEqual(col('start'), source.map((x) => x.start));
  assert.deepEqual(col('source'), source.map((x) => x.title_source));
  assert.deepEqual(col('lat').map(Number), source.map((x) => Number(x.lat)), 'each latitude, and none where the table has none');
  assert.ok(col('label').includes('Ḥarrān') && col('alternative_names').some((v) => v.includes('اسكى موصل')), 'accents and Arabic script survive');
  // Seven rows have a match the table gave (its matches column); five have none, and say only that.
  const matched = source.map((x) => (x.matches ? 'much the same place (close match)' : 'no match recorded'));
  assert.deepEqual(col('match_status'), matched);
  assert.equal(matched.filter((m) => m !== 'no match recorded').length, 7);
  assert.deepEqual([...new Set(col('match_given_by'))].sort(), ['', 'the table']);
  assert.deepEqual([...new Set(col('match_source'))].sort(), ['', 'GeoNames']);
  assert.equal(rows.find((x) => x[0] === 'oape_529')[header.indexOf('match_id')], 'https://sws.geonames.org/3174659/');
  assert.deepEqual([...new Set(col('geometry_note'))].sort(), ['', 'own to the table']);
  assert.match(r.out, /× 5 {2}These places have "no match recorded" in match_status\./);
  // The same bytes as the engine gives in memory: the command line adds and loses nothing.
  const mem = await go([file('test/fixtures/generic/whg-lp7-12.tsv')], 'convert', 'table-flat');
  assert.equal(outText(mem.e, 'whg-lp7-12.flat.csv'), csv);
});

test('--help lists the flat table among the targets', () => {
  const h = cli('--help');
  assert.match(h.out, /\n {2}table-flat +One flat table \(\.flat\.csv\)/);
  assert.match(h.out, /\n {2}tables +PLATO spreadsheet tables/, 'beside the ten tables');
});
