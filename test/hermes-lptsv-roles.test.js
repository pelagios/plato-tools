// The World Historical Gazetteer's LP-TSV template has columns of its own: title_source, fclasses,
// aat_types, matches, ccodes. Each was read as a plain note, which Linked Places Format has no place
// for, so all of them were lost on the way to LPF (issue #42, checkbox 4). Each now has a role: the
// source of the name, a feature class, a type with its AAT identifier, the place's matches (written as
// identities the TABLE gives, never a reviewer's), and the place's country codes. Every test that
// asserts an absence asserts, in the same test, a presence it could have missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Papa from 'papaparse';
import { unzipSync, strFromU8 } from 'fflate';
import { detect } from '../src/engine/input.js';
import { Report, LOSS_TEXT } from '../src/engine/report.js';
import { genericSource } from '../src/engine/hermes/generic.js';
import { GENERIC_KINDS, FIELDS, guessColumns, applyColumns, matchAddress } from '../src/engine/hermes/columns.js';
import { DCT_DESCRIPTION } from '../src/formats/lpf.js';
import { FlatTable } from '../src/formats/flat.js';
import { COLUMN_CHOICES } from '../src/engine/words.js';
import { sameContributor } from '../src/engine/krisis/withdraw.js';
import { file, textFile, go, outText } from './engine.js';

const BASE = 'https://example.org/gaz/';
const AAT = 'http://vocab.getty.edu/aat/';
const GN = 'http://www.geonames.org/ontology#';
const NEW_FIELDS = ['featureClass', 'aatType', 'matches', 'countryCodes'];
const NEW_KINDS = ['generic-fclass-invalid', 'generic-aat-invalid', 'generic-match-not-address', 'generic-match-no-place-address', 'generic-ccode-invalid', 'generic-ccodes-not-carried'];

async function readAll(text, options = { base: BASE }, name = 'lp.tsv') {
  const input = await detect([textFile(text, name)]);
  const rep = new Report();
  const events = [];
  for await (const ev of genericSource(input, rep, options)) events.push(ev);
  const { items } = rep.toJSON();
  const records = events.filter((e) => e.type === 'record').map((e) => e.value);
  return { events, items, records, of: (k) => items.find((i) => i.kind === k), rec: (id) => records.find((r) => r.entityIdentifier === id), attestations: events.filter((e) => e.type === 'attestation').map((e) => e.value) };
}
const tsv = (rows) => rows.map((r) => r.join('\t')).join('\n') + '\n';
const HEAD = ['id', 'title', 'title_source', 'fclasses', 'ccodes', 'types', 'aat_types', 'matches'];
// Constructed rows in the template's shape (the template's own rows give "town; castle" beside "300008375; 300008063").
const LP = tsv([HEAD,
  ['a1', 'Marienborch', 'Croniken', 'P', 'PL', 'town; castle', '300008375; 300008063', 'gn:3092472; wd:Q146820'],
  ['a2', 'Sampit', 'Broek', 'P;H', 'id', 'mine', '300000390; 300008347', 'tgn:7000000|https://pleiades.stoa.org/places/579885'],
  ['a3', 'Lossen', 'Croniken', '', '', '', 'aat:300008375', ''],
  ['a4', 'Gora', '', 'T', 'PL;DE', 'hill', '', ''],
]);
const typesOf = (rec) => rec.attestations.flatMap((a) => a.types || []);
const matchAtts = (rec) => rec.attestations.filter((a) => a.identities);

test('the guess reads each LP-TSV heading as its own role, and none of them as a note', () => {
  const rows = Papa.parse(LP, { header: true, delimiter: '\t', skipEmptyLines: true }).data;
  const g = guessColumns(HEAD, rows);
  assert.deepEqual({ ...g.mapping }, { id: 'id', title: 'name', title_source: 'source', fclasses: 'featureClass', ccodes: 'countryCodes', types: 'type', aat_types: 'aatType', matches: 'matches' });
  assert.ok(!Object.values(g.mapping).includes('note'), 'no column is left a note');
  for (const f of NEW_FIELDS) { assert.ok(FIELDS[f]?.words, `${f} is a field with words`); assert.ok(COLUMN_CHOICES[f], `${f} has a name on the page`); }
  for (const k of NEW_KINDS) { assert.equal(GENERIC_KINDS[k], 'loss', k); assert.ok(LOSS_TEXT[k], `${k} has words`); }
});

test('a heading alone is not enough: values of another form keep the column a note, and say why (the same headings over fitting values are read: control)', () => {
  const head = ['name', 'matches', 'country_code', 'fclasses', 'aat_types', 'Country'];
  const bad = guessColumns(head, [{ name: 'Alton', matches: 'yes', country_code: 'England', fclasses: 'village', aat_types: 'settlement', Country: 'England' }, { name: 'Bath', matches: 'no', country_code: 'Wales', fclasses: 'town', aat_types: 'town', Country: 'Wales' }]);
  for (const h of ['matches', 'country_code', 'fclasses', 'aat_types']) { assert.equal(bad.mapping[h], 'note', h); assert.match(bad.reasons[h], /so it is kept in the notes/, h); }
  // A country given by NAME is a region the place lies in, as before, whatever the codes beside it.
  assert.equal(bad.mapping.Country, 'within');
  const good = guessColumns(head, [{ name: 'Alton', matches: 'wd:Q1234', country_code: 'GB', fclasses: 'P', aat_types: '300008347', Country: 'England' }]);
  assert.deepEqual([good.mapping.matches, good.mapping.country_code, good.mapping.fclasses, good.mapping.aat_types, good.mapping.Country], ['matches', 'countryCodes', 'featureClass', 'aatType', 'within']);
  // Each heading the task names for country codes; a column empty in the sample is read by its heading.
  for (const h of ['ccodes', 'ccode', 'countrycode', 'countrycodes', 'iso2']) assert.equal(guessColumns(['name', h], [{ name: 'Alton', [h]: '' }]).mapping[h], 'countryCodes', h);
});

test('title_source is the source of the row, cited in place of the file', async () => {
  const r = await readAll(LP);
  assert.equal(r.records.length, 4, 'present: four places');
  const [a] = r.rec('a1').attestations;
  assert.deepEqual(a.sources, [{ title: 'Croniken', authorityType: 'source' }]);
  assert.deepEqual(a.citations, [{ source: { title: 'Croniken', authorityType: 'source' } }]);
  assert.equal(a.notes, undefined, 'nothing of the row is left in the notes');
  // Control: the row with no title_source cites the file, by its row.
  assert.deepEqual(r.rec('a4').attestations[0].citations, [{ source: { title: 'lp.tsv', authorityType: 'source' }, locator: 'row 5' }]);
});

test('aat_types go with the types beside them when the row has as many of each; otherwise each is a type of its own', async () => {
  const r = await readAll(LP);
  assert.deepEqual(typesOf(r.rec('a1')).filter((t) => !t.identifier.startsWith(GN)), [{ identifier: AAT + '300008375', label: 'town' }, { identifier: AAT + '300008063', label: 'castle' }]);
  // One type and two identifiers: nothing is paired, and nothing is dropped.
  assert.deepEqual(typesOf(r.rec('a2')).filter((t) => !t.identifier?.startsWith(GN)), [{ label: 'mine' }, { identifier: AAT + '300000390', label: 'aat:300000390' }, { identifier: AAT + '300008347', label: 'aat:300008347' }]);
  assert.deepEqual(typesOf(r.rec('a3')), [{ identifier: AAT + '300008375', label: 'aat:300008375' }], 'aat:<n> is read as <n>');
  assert.deepEqual(typesOf(r.rec('a4')).filter((t) => !t.identifier), [{ label: 'hill' }], 'control: a type with no identifier beside it stays a label');
  assert.equal(r.of('generic-aat-invalid'), undefined);
});

test('fclasses are written as the LPF reader writes them, and only the seven classes are', async () => {
  const r = await readAll(LP);
  const classes = (id) => typesOf(r.rec(id)).filter((t) => t.identifier?.startsWith(GN));
  assert.deepEqual(classes('a1'), [{ identifier: GN + 'P', label: 'Populated places' }]);
  assert.deepEqual(classes('a2'), [{ identifier: GN + 'P', label: 'Populated places' }, { identifier: GN + 'H', label: 'Water bodies' }]);
  assert.deepEqual(classes('a3'), [], 'control: an empty cell makes no class');
  assert.equal(r.of('generic-fclass-invalid'), undefined);
  // A value that is no class is kept in the notes and reported; the class beside it is still read.
  const b = await readAll(tsv([['id', 'title', 'fclasses'], ['x1', 'Alton', 'P;village'], ['x2', 'Bath', 'p']]));
  assert.deepEqual(typesOf(b.rec('x1')), [{ identifier: GN + 'P', label: 'Populated places' }]);
  assert.equal(b.rec('x1').attestations[0].notes, 'fclasses: village');
  assert.deepEqual(b.of('generic-fclass-invalid').examples, ['row 2, fclasses: village']);
  assert.deepEqual(typesOf(b.rec('x2')), [{ identifier: GN + 'P', label: 'Populated places' }], 'a class in lower case is the class');
});

test('ccodes are the place\'s country codes, in capitals, each once', async () => {
  const r = await readAll(LP);
  assert.deepEqual(r.rec('a1').ccodes, ['PL']);
  assert.deepEqual(r.rec('a2').ccodes, ['ID'], 'id is ID');
  assert.deepEqual(r.rec('a4').ccodes, ['PL', 'DE']);
  assert.equal(r.rec('a3').ccodes, undefined, 'none given, none made');
  assert.equal(r.of('generic-ccode-invalid'), undefined);
  assert.equal(r.of('generic-ccodes-not-carried'), undefined);
  // A value that is no code is kept in the notes and reported; the code beside it is still read.
  const b = await readAll(tsv([['id', 'title', 'ccodes'], ['x1', 'Alton', 'GB;England;GB'], ['x2', 'Bath', 'GB'], ['x3', 'Cork', 'IE']]));
  assert.deepEqual(b.rec('x1').ccodes, ['GB']);
  assert.equal(b.rec('x1').attestations[0].notes, 'ccodes: England');
  assert.deepEqual(b.of('generic-ccode-invalid').examples, ['row 2, ccodes: England']);
});

test('ccodes of a row about an address elsewhere have no record to be on: kept in the notes, and counted in the report', async () => {
  const r = await readAll(tsv([['title', 'uri', 'ccodes'], ['Rome', 'https://pleiades.stoa.org/places/423025', 'IT'], ['Athens', 'https://pleiades.stoa.org/places/579885', 'GR'], ['Nowhere', '', 'GB']]));
  assert.equal(r.attestations.length, 2, 'present: two rows are attestations about their addresses');
  assert.equal(r.attestations[0].notes, 'ccodes: IT');
  assert.equal(r.attestations[0].ccodes, undefined);
  const lost = r.of('generic-ccodes-not-carried');
  assert.equal(lost.count, 2, 'one for each row, not once for the file');
  assert.deepEqual(lost.examples, ['row 2, ccodes: IT', 'row 3, ccodes: GR']);
  // With the same id as one place, the place is the dataset's own: its rows' codes are on its record.
  const s = await readAll(tsv([['id', 'title', 'ccodes'], ['a', 'Danzig', 'PL'], ['a', 'Gdansk', 'PL;DE'], ['b', 'Bath', '']]), { base: BASE, sameId: true });
  assert.deepEqual(s.rec('a').ccodes, ['PL', 'DE']);
  assert.equal(s.rec('b').ccodes, undefined);
  assert.equal(s.of('generic-ccodes-not-carried'), undefined);
});

test('matches are identities of the place, close matches the table gives: its source the file and row, no contributor, a basis that says so', async () => {
  const r = await readAll(LP);
  const a1 = r.rec('a1');
  assert.equal(a1.attestations.length, 2, 'the row, and its matches');
  const [m] = matchAtts(a1);
  const basis = 'Given by the table lp.tsv in its column "matches": the table\'s own statement, not a reviewer\'s decision';
  assert.deepEqual(m, {
    identities: [
      { subject: BASE + 'place/a1', object: 'https://sws.geonames.org/3092472/', identityType: 'closeMatch', basis },
      { subject: BASE + 'place/a1', object: 'http://www.wikidata.org/entity/Q146820', identityType: 'closeMatch', basis },
    ],
    sources: [{ title: 'lp.tsv', authorityType: 'source' }],
    citations: [{ source: { title: 'lp.tsv', authorityType: 'source' }, locator: 'row 2' }],
  });
  // The source of the match is the file, though the row names another source for its name.
  assert.equal(a1.attestations[0].sources[0].title, 'Croniken');
  // Never a reviewer's decision: Krisis knows its own answers by their contributor (withdraw.js), and these have none.
  assert.equal(m.contributor, undefined);
  assert.equal(m.created, undefined);
  assert.ok(!sameContributor(m.contributor, { name: 'A Reviewer' }), 'not the answer of any reviewer');
  assert.ok(m.identities.every((i) => i.promotedFrom === undefined && /not a reviewer's decision/.test(i.basis)));
  // tgn: and a full address; | separates as ; does.
  assert.deepEqual(matchAtts(r.rec('a2'))[0].identities.map((i) => i.object), ['http://vocab.getty.edu/page/tgn/7000000', 'https://pleiades.stoa.org/places/579885']);
  // Control: a row with no matches has no such attestation.
  assert.equal(matchAtts(r.rec('a3')).length, 0);
  assert.equal(r.rec('a3').attestations.length, 1);
  assert.equal(r.of('generic-match-not-address'), undefined);
});

test('what a matches cell gives is made a web address by the prefixes LPF knows and the rules for addresses; anything else makes none', () => {
  assert.equal(matchAddress('wd:Q90'), 'http://www.wikidata.org/entity/Q90');
  assert.equal(matchAddress('GN:2988507'), 'https://sws.geonames.org/2988507/', 'the prefix in capitals');
  assert.equal(matchAddress('tgn:7008038'), 'http://vocab.getty.edu/page/tgn/7008038');
  assert.equal(matchAddress('pl:579885'), 'https://pleiades.stoa.org/places/579885');
  assert.equal(matchAddress('https://www.wikidata.org/wiki/Q90'), 'http://www.wikidata.org/entity/Q90', "a full address in the gazetteer's one form");
  assert.equal(matchAddress('https://example.org/place/7'), 'https://example.org/place/7', 'any other address as given');
  assert.equal(matchAddress('place:gn:2988507'), 'https://w3id.org/whg/id/place:gn:2988507');
  for (const v of ['2988507', 'whg:12345', 'xx:123', 'aat:300008347', 'yes', 'wp:Paris', 'https://en.wikipedia.org/wiki/Paris', 'https://pleiades.stoa.org/places/']) assert.equal(matchAddress(v), undefined, v);
});

test('a match no address can be made of is kept in the notes and reported, never dropped; the good one beside it is linked', async () => {
  const r = await readAll(tsv([['id', 'title', 'matches'], ['x1', 'Paris', 'wd:Q90; 2988507; xx:5'], ['x2', 'Lyon', 'gn:2996944'], ['x3', 'Nice', 'gn:2990440']]));
  const x1 = r.rec('x1');
  assert.deepEqual(matchAtts(x1)[0].identities.map((i) => i.object), ['http://www.wikidata.org/entity/Q90']);
  assert.equal(x1.attestations[0].notes, 'matches: 2988507\nmatches: xx:5');
  const lost = r.of('generic-match-not-address');
  assert.equal(lost.count, 2);
  assert.deepEqual(lost.examples, ['row 2, matches: 2988507', 'row 2, matches: xx:5']);
  assert.equal(lost.severity, 'loss');
});

test('a place with no address has nothing for a match to be about: kept in the notes, and said', async () => {
  const r = await readAll(tsv([['title', 'matches'], ['Paris', 'wd:Q90'], ['Lyon', 'gn:2996944'], ['Nice', '']]));
  assert.equal(r.records.length, 3, 'present: three places, with no ids');
  assert.equal(r.records.flatMap(matchAtts).length, 0);
  assert.equal(r.records[0].attestations[0].notes, 'matches: wd:Q90');
  assert.equal(r.of('generic-match-no-place-address').count, 2);
  // Control: the same rows with ids are linked, and nothing is reported.
  const c = await readAll(tsv([['id', 'title', 'matches'], ['p', 'Paris', 'wd:Q90'], ['l', 'Lyon', 'gn:2996944']]));
  assert.equal(c.records.flatMap(matchAtts).length, 2);
  assert.equal(c.of('generic-match-no-place-address'), undefined);
});

test('rows about an address, and rows with the same id: the matches are an attestation about that place', async () => {
  const r = await readAll(tsv([['title', 'uri', 'matches'], ['Rome', 'https://pleiades.stoa.org/places/423025', 'wd:Q220'], ['Roma', 'https://pleiades.stoa.org/places/423025', '']]));
  assert.equal(r.attestations.length, 3, 'two rows, and the matches of the first');
  const m = r.attestations.filter((a) => a.identities);
  assert.equal(m.length, 1);
  assert.equal(m[0].about, 'https://pleiades.stoa.org/places/423025');
  assert.deepEqual(m[0].identities.map((i) => [i.subject, i.object, i.identityType]), [['https://pleiades.stoa.org/places/423025', 'http://www.wikidata.org/entity/Q220', 'closeMatch']]);
  const s = await readAll(tsv([['id', 'title', 'matches'], ['a', 'Danzig', 'gn:3099434'], ['a', 'Gdansk', '']]), { base: BASE, sameId: true });
  const sm = s.attestations.filter((a) => a.identities);
  assert.deepEqual(sm.map((a) => [a.about, a.identities[0].subject, a.identities[0].object]), [[BASE + 'place/a', BASE + 'place/a', 'https://sws.geonames.org/3099434/']]);
  assert.equal(s.attestations.length, 3);
});

test('the mapping can be given: each role by name, on headings the guess would not know', async () => {
  const columns = { key: 'id', nm: 'name', cls: 'featureClass', aat: 'aatType', same: 'matches', cc: 'countryCodes', src: 'source' };
  const r = await readAll(tsv([['key', 'nm', 'cls', 'aat', 'same', 'cc', 'src'], ['k1', 'Paris', 'P', '300008389', 'wd:Q90', 'FR', 'Cassini']]), { base: BASE, columns });
  const rec = r.rec('k1');
  assert.deepEqual(rec.ccodes, ['FR']);
  assert.deepEqual(typesOf(rec), [{ identifier: AAT + '300008389', label: 'aat:300008389' }, { identifier: GN + 'P', label: 'Populated places' }]);
  assert.equal(matchAtts(rec)[0].identities[0].object, 'http://www.wikidata.org/entity/Q90');
  assert.equal(rec.attestations[0].sources[0].title, 'Cassini');
  assert.deepEqual(r.items.filter((i) => i.severity === 'error'), []);
});

test('applyColumns on its own returns the matches and the codes for the caller, and keeps nothing of them in the notes', () => {
  const a = applyColumns({ id: 'a', title: 'Paris', matches: 'wd:Q90', ccodes: 'fr' }, { id: 'id', title: 'name', matches: 'matches', ccodes: 'countryCodes' }, { where: 'row 2' });
  assert.deepEqual(a.matches, [{ iri: 'http://www.wikidata.org/entity/Q90', column: 'matches' }]);
  assert.deepEqual(a.ccodes, ['FR']);
  assert.equal(a.attestation.notes, undefined);
  assert.deepEqual(a.attestation.names, [{ toponym: 'Paris' }], 'present: the row is read');
});

// ---- through the engine, to Linked Places Format and the tables ---------------------------------------
const features = (r, name) => outText(r.e, name).split('\n').map((l) => l.replace(/^\u001e/, '')).filter(Boolean).map((l) => JSON.parse(l)).filter((f) => f.type === 'Feature');
const lossCount = (r, kind) => r.report.items.filter((i) => i.kind === kind).reduce((n, i) => n + i.count, 0);

test('to Linked Places Format: links, types with their AAT identifiers, fclasses, ccodes and the name\'s source all arrive, and no note is left out', async () => {
  const r = await go([textFile(LP, 'lp.tsv')], 'convert', 'lpf-seq', { base: BASE });
  assert.equal(r.report.errors, 0);
  const fs = features(r, 'lp.geojsonl');
  assert.equal(fs.length, 4);
  const f = fs.find((x) => x['@id'] === BASE + 'place/a1');
  assert.deepEqual(f.links, [{ type: 'closeMatch', identifier: 'https://sws.geonames.org/3092472/' }, { type: 'closeMatch', identifier: 'http://www.wikidata.org/entity/Q146820' }]);
  assert.deepEqual(f.properties, { title: 'Marienborch', ccodes: ['PL'], fclasses: ['P'] });
  assert.deepEqual(f.types.map((t) => [t.identifier, t.label]), [[AAT + '300008375', 'town'], [AAT + '300008063', 'castle']]);
  assert.deepEqual(f.names[0].citations, [{ label: 'Croniken' }]);
  assert.deepEqual(fs.find((x) => x['@id'] === BASE + 'place/a2').properties.fclasses, ['P', 'H']);
  assert.equal(fs.find((x) => x['@id'] === BASE + 'place/a3').links, undefined, 'control: no matches, no links');
  // What the report says is not carried: the notes are no longer among it (they were, for every row).
  const dropped = r.report.items.map((i) => i.kind).filter((k) => k.startsWith('dropped:'));
  assert.ok(dropped.includes('dropped:spatialEntity.entityIdentifier'), `present: what LPF cannot hold is still reported (${dropped})`);
  assert.ok(!dropped.includes('dropped:attestation.notes'), 'no note is left out');
  assert.equal(lossCount(r, 'identity-certainty-or-basis'), 4, 'the basis of each match has no place in LPF, and that is said');
});

test('to the ten tables: the matches are rows of the identities sheet, with their basis and the file as their source; the codes are on the places sheet', async () => {
  const r = await go([textFile(LP, 'lp.tsv')], 'convert', 'tables', { base: BASE });
  assert.equal(r.report.errors, 0);
  const zip = unzipSync(r.e.outs['lp-tables.zip'][0]);
  const sheet = (n) => Papa.parse(strFromU8(zip[n]), { header: true, skipEmptyLines: true }).data;
  const ids = sheet('identities.csv');
  assert.deepEqual(ids.map((i) => [i.place_id, i.same_as, i.match_type]), [
    ['a1', 'https://sws.geonames.org/3092472/', 'closeMatch'], ['a1', 'http://www.wikidata.org/entity/Q146820', 'closeMatch'],
    ['a2', 'http://vocab.getty.edu/page/tgn/7000000', 'closeMatch'], ['a2', 'https://pleiades.stoa.org/places/579885', 'closeMatch']]);
  assert.ok(ids.every((i) => /^Given by the table lp\.tsv in its column "matches"/.test(i.basis)));
  const sources = sheet('sources.csv');
  assert.equal(sources.find((s) => s.source_id === ids[0].source_id).title, 'lp.tsv', 'the source of a match is the file');
  assert.ok(sources.some((s) => s.title === 'Croniken'), 'and the source of the name is title_source');
  assert.deepEqual(sheet('places.csv').map((p) => [p.place_id, p.country_codes]), [['a1', 'PL'], ['a2', 'ID'], ['a3', ''], ['a4', 'PL;DE']]);
  assert.ok(sheet('types.csv').some((t) => t.place_id === 'a1' && t.type_label === 'town' && t.type_uri === AAT + '300008375'));
});

test('what the reader makes is valid PLATO, and reads back from its own JSON as the same places', async () => {
  const j = await go([textFile(LP, 'lp.tsv')], 'convert', 'plato-json', { base: BASE });
  assert.equal(j.report.errors, 0, JSON.stringify(j.report.items.filter((i) => i.severity === 'error')));
  const doc = JSON.parse(outText(j.e, 'lp.json'));
  const matched = doc.spatialEntities.filter((e) => e.attestations.some((a) => a.identities));
  assert.equal(matched.length, 2);
  assert.deepEqual(doc.spatialEntities.map((e) => e.ccodes), [['PL'], ['ID'], undefined, ['PL', 'DE']]);
  const back = await go([textFile(JSON.stringify(doc), 'back.json')], 'check');
  assert.equal(back.report.errors, 0, JSON.stringify(back.report.items.filter((i) => i.severity === 'error')));
  assert.equal(back.report.counts.records ?? back.report.counts.places, 4, JSON.stringify(back.report.counts));
  // Control: the check does refuse an identity that is not one (so "no errors" above says something).
  matched[0].attestations.find((a) => a.identities).identities[0].identityType = 'given by the table';
  const bad = await go([textFile(JSON.stringify(doc), 'bad.json')], 'check');
  assert.ok(bad.report.errors > 0, 'an identity type that is none is an error');
});

// ---- the real file: twelve rows of WHG's own example (test/fixtures/generic/README.md) ---------------------
test('twelve rows of WHG\'s example lp7_100.tsv: twelve places, seven with links, AAT identifiers on every type, and fewer notes left out', async () => {
  const fx = () => file('test/fixtures/generic/whg-lp7-12.tsv');
  const r = await go([fx()], 'convert', 'lpf-seq', { base: BASE });
  assert.equal(r.report.errors, 0);
  const fs = features(r, 'whg-lp7-12.geojsonl');
  assert.equal(fs.length, 12, 'twelve rows, twelve places');
  const linked = fs.filter((f) => f.links);
  assert.equal(linked.length, 7);
  assert.deepEqual(fs.find((f) => f.properties.title === 'Livorno').links, [{ type: 'closeMatch', identifier: 'https://sws.geonames.org/3174659/' }]);
  assert.ok(fs.every((f) => f.types?.length === 1 && f.types[0].identifier === AAT + '300008347'), 'every place has its AAT identifier');
  assert.deepEqual(fs.find((f) => f.properties.title === 'Emesa').types.map((t) => t.label), ['settlement']);
  assert.deepEqual(fs.find((f) => f.properties.title === 'Gebal').properties.ccodes, ['LB']);
  assert.deepEqual(fs.find((f) => f.properties.title === 'Emesa').names[0].citations, [{ label: 'LHOM' }]);
  // Only the rows with a title_uri still have notes for LPF to leave out: two of the twelve (Emesa and Ḥarrān), where it was all twelve.
  assert.equal(lossCount(r, 'dropped:attestation.notes'), 2);
  // Those two rows' descriptions are descriptions, and the ten rows with none have none.
  assert.deepEqual(fs.find((f) => f.properties.title === 'Emesa').descriptions, [{ value: 'a town, said here to be the modern Homs' }]);
  assert.equal(fs.filter((f) => f.descriptions).length, 2);
  // The variants: no "@" is left in a toponym (forty had one), and each language is the name's.
  const names = fs.flatMap((f) => f.names);
  assert.equal(names.filter((n) => n.lang).length, 33, 'present: the names are read, thirty-three with a language');
  assert.deepEqual(names.filter((n) => n.toponym.includes('@')), []);
  assert.deepEqual(fs.find((f) => f.properties.title === 'Livorno').names.map((n) => [n.toponym, n.lang]), [['Livorno', undefined], ['Livorno', 'it'], ['ليفورنو', 'ar'], ['Livorno', 'en'], ['Livourne', 'fr'], ['Livorno', 'de'], ['Livorno', 'tr']]);
  assert.ok(names.some((n) => n.toponym === 'Al Mafraq' && n.lang === 'ar-Latn-x-ijmes') && names.some((n) => n.toponym === 'زوريخ' && n.lang === 'de-Arab-AR'));
  // Seven names of one row were left with the "@" alone: said by the reader, each once; the writer has nothing left to mend.
  assert.equal(lossCount(r, 'lpf-name-at-no-language'), 7);
  assert.equal(lossCount(r, 'lpf-name-at-language'), 0);
  // And the same rows as the ten tables: seven identities.
  const t = await go([fx()], 'convert', 'tables', { base: BASE });
  const ids = Papa.parse(strFromU8(unzipSync(t.e.outs['whg-lp7-12-tables.zip'][0])['identities.csv']), { header: true, skipEmptyLines: true }).data;
  assert.equal(ids.length, 7);
  assert.ok(ids.every((i) => i.match_type === 'closeMatch' && /^https:\/\/sws\.geonames\.org\/\d+\/$/.test(i.same_as)));
});

// ---- description, and variants written name@language --------------------------------------------------
// The template's description was kept as a note, which Linked Places Format leaves out, and its variants
// (Livorno@it) were read whole as toponyms, "@" and all. The description is now the place's description
// (as the LPF reader writes one), and a variant's language is the name's. Each test that asserts an
// absence asserts a presence beside it, and the engine test ends with the same rows read the old way
// (the column given as a note), so that its checks are seen to tell the two apart.
const DESCRIBED = tsv([['id', 'title', 'title_source', 'variants', 'description'],
  ['d1', 'Livorno', 'oape', 'Livorno@it; ليفورنو@ar; Leghorn@en; Livorno@it; Livorno', 'a port of Tuscany; said to be free'],
  ['d2', 'Qanawat', 'oape', 'Qanawat@; Kanatha@grc-Latn-x-ijmes; Q@Q street; Canatha @ la; @la', ''],
  ['d3', 'Zurich', '', 'Zürich|Zurich@', 'a town on a lake'],
]);
const WORDS = 'a port of Tuscany; said to be free';
const LIVORNO = [['Livorno', undefined], ['Livorno', 'it'], ['ليفورنو', 'ar'], ['Leghorn', 'en']];
const namesOf = (rec) => rec.attestations[0].names.map((n) => [n.toponym, n.language]);

test('the guess reads description as the description and variants as other names; both have words on the page', () => {
  const head = ['id', 'title', 'variants', 'description'];
  const g = guessColumns(head, Papa.parse(tsv([head, ['d1', 'Livorno', 'Livorno@it', 'a port']]), { header: true, delimiter: '\t', skipEmptyLines: true }).data);
  assert.deepEqual({ ...g.mapping }, { id: 'id', title: 'name', variants: 'alternativeNames', description: 'description' });
  assert.match(g.reasons.description, /reads as a description of the place/);
  assert.ok(FIELDS.description?.words && COLUMN_CHOICES.description, 'description is a field with words, and a name on the page');
  assert.equal(GENERIC_KINDS['lpf-name-at-no-language'], 'warning');
  assert.ok(LOSS_TEXT['lpf-name-at-no-language']);
});

test('a description is the place\'s description, as the LPF reader writes one, and no note; a cell with a semicolon is one description', async () => {
  const r = await readAll(DESCRIBED);
  assert.equal(r.records.length, 3, 'present: three places');
  const [a] = r.rec('d1').attestations;
  assert.deepEqual(a.properties, [{ property: DCT_DESCRIPTION, label: 'description', value: WORDS }]);
  assert.equal(a.notes, undefined, 'nothing of the row is left in the notes');
  assert.deepEqual(a.sources, [{ title: 'oape', authorityType: 'source' }], "on the row's own attestation, with the row's source");
  assert.equal(r.rec('d2').attestations[0].properties, undefined, 'control: an empty cell makes no description');
  assert.deepEqual(r.rec('d3').attestations[0].properties.map((p) => p.value), ['a town on a lake']);
  // Columns given as descriptions are each a description; the same words twice are one.
  const two = await readAll(tsv([['id', 'nm', 'about', 'remark', 'again'], ['x', 'Bath', 'a spa', 'a city', 'a spa']]), { base: BASE, columns: { id: 'id', nm: 'name', about: 'description', remark: 'description', again: 'description' } });
  assert.deepEqual(two.rec('x').attestations[0].properties.map((p) => p.value), ['a spa', 'a city']);
});

test('a variant written name@language is the name and its language; a tail that is no language stays in the name; a dangling @ is taken off, and said', async () => {
  const r = await readAll(DESCRIBED);
  // Livorno@it twice is one name; the bare "Livorno" is the name itself and says nothing more; Livorno@it gives its language.
  assert.deepEqual(namesOf(r.rec('d1')), LIVORNO);
  // "Q@Q street": the tail is no language tag. "@la": there is no name before the @. Spaces about the @ do not count.
  assert.deepEqual(namesOf(r.rec('d2')), [['Qanawat', undefined], ['Kanatha', 'grc-Latn-x-ijmes'], ['Q@Q street', undefined], ['Canatha', 'la'], ['@la', undefined]]);
  assert.deepEqual(namesOf(r.rec('d3')), [['Zurich', undefined], ['Zürich', undefined]], 'Zurich@ is Zurich, the name itself');
  const dangling = r.of('lpf-name-at-no-language');
  assert.deepEqual([dangling.severity, dangling.count, dangling.examples], ['warning', 2, ['row 3, variants: Qanawat@', 'row 4, variants: Zurich@']]);
  assert.equal(r.of('lpf-name-at-language'), undefined, 'a language read where it was written is no loss, and is not reported');
  // A language column is the language of the name: a variant with that name and that language is not a second name, one in another language is.
  const l = await readAll(tsv([['id', 'title', 'lang', 'variants'], ['z', 'Genf', 'de', 'Genf@de; Genf@DE; Genf@gsw; Geneva@en']]));
  assert.deepEqual(namesOf(l.rec('z')), [['Genf', 'de'], ['Genf', 'gsw'], ['Geneva', 'en']]);
  // A list of names in plain GeoJSON is read the same way (applyColumns on its own).
  const a = applyColumns({ name: 'Livorno', alt: ['Livourne@fr', 'Leghorn'] }, { name: 'name', alt: 'alternativeNames' }, { where: 'feature 1' });
  assert.deepEqual(a.attestation.names, [{ toponym: 'Livorno' }, { toponym: 'Livourne', language: 'fr' }, { toponym: 'Leghorn' }]);
  // With no name column the label is the first variant, without its language.
  assert.equal(applyColumns({ alt: 'Livourne@fr' }, { alt: 'alternativeNames' }).label, 'Livourne');
});

const flatRows = (r, name) => Papa.parse(outText(r.e, name).replace(/^﻿/, ''), { header: true, skipEmptyLines: true }).data;

test('through the engine: the description and the languages arrive in PLATO JSON, both versions of Linked Places Format and the flat table; read the old way (as a note), they do not', async () => {
  const to = (target, options = {}) => go([textFile(DESCRIBED, 'lp.tsv')], 'convert', target, { base: BASE, ...options });
  // PLATO JSON: valid, and it reads back.
  const j = await to('plato-json');
  assert.equal(j.report.errors, 0, JSON.stringify(j.report.items.filter((i) => i.severity === 'error')));
  const text = outText(j.e, 'lp.json');
  const doc = JSON.parse(text);
  const d1 = doc.spatialEntities.find((e) => e['@id'] === BASE + 'place/d1').attestations[0];
  assert.deepEqual(d1.properties.map((p) => [p.property, p.value]), [[DCT_DESCRIPTION, WORDS]]);
  assert.deepEqual(d1.names.map((n) => [n.toponym, n.language]), LIVORNO);
  assert.ok(text.includes('"toponym":"Qanawat"') && !text.includes('@it') && !text.includes('Qanawat@'), 'no "@" of the variants is left in the PLATO record');
  const back = await go([textFile(text, 'back.json')], 'check');
  assert.equal(back.report.errors, 0, JSON.stringify(back.report.items.filter((i) => i.severity === 'error')));
  // Linked Places Format, v1 and v2: descriptions, and lang apart from the toponym; no note and no property is left out.
  for (const [target, read] of [['lpf-seq', (r) => features(r, 'lp.geojsonl')], ['lpf2', (r) => JSON.parse(outText(r.e, 'lp.lpf2.geojson')).features]]) {
    const r = await to(target);
    const fs = read(r);
    assert.equal(fs.length, 3, target);
    const f = fs.find((x) => x['@id'] === BASE + 'place/d1');
    assert.deepEqual(f.descriptions, [{ value: WORDS }], target);
    assert.deepEqual(f.names.map((n) => [n.toponym, n.lang]), LIVORNO, target);
    assert.equal(fs.find((x) => x['@id'] === BASE + 'place/d2').descriptions, undefined, `${target}: control, no description, none written`);
    assert.deepEqual(fs.flatMap((x) => x.names.map((n) => n.toponym)).filter((t) => /.@\s*$|.@\s*(it|ar|en|la|grc-Latn-x-ijmes)$/.test(t)), [], target);
    const kinds = r.report.items.map((i) => i.kind);
    assert.ok(!kinds.includes('dropped:attestation.notes') && !kinds.includes('property-value') && !kinds.includes('lpf-name-at-language'), `${target}: ${kinds}`);
    assert.equal(lossCount(r, 'lpf-name-at-no-language'), 2, `${target}: the reader's two, and none more from the writer`);
  }
  // The flat table: the description under its own heading, and nothing of it reported as left out.
  const t = await to('table-flat');
  const rows = flatRows(t, 'lp.flat.csv');
  assert.deepEqual(rows.map((x) => [x.place_id, x.description]), [['d1', WORDS], ['d2', ''], ['d3', 'a town on a lake']]);
  assert.equal(rows[0].alternative_names, 'ليفورنو; Leghorn');
  assert.ok(!t.report.items.some((i) => i.kind === 'flat-facet-not-carried'), 'a description is carried');
  // The ten tables: a row of the properties sheet.
  const x = await to('tables');
  const props = Papa.parse(strFromU8(unzipSync(x.e.outs['lp-tables.zip'][0])['properties.csv']), { header: true, skipEmptyLines: true }).data;
  assert.deepEqual(props.map((p) => [p.place_id, p.property_uri, p.value]), [['d1', DCT_DESCRIPTION, WORDS], ['d3', DCT_DESCRIPTION, 'a town on a lake']]);
  // The same rows with the column read the old way, as a note: the description is in the notes, LPF has
  // no descriptions and says a note was left out. So the checks above fail if the role is taken away.
  const old = { id: 'id', title: 'name', title_source: 'source', variants: 'alternativeNames', description: 'note' };
  const o = await to('lpf-seq', { columns: old });
  assert.equal(features(o, 'lp.geojsonl').find((f) => f['@id'] === BASE + 'place/d1').descriptions, undefined);
  assert.equal(lossCount(o, 'dropped:attestation.notes'), 2);
  const oj = JSON.parse(outText((await to('plato-json', { columns: old })).e, 'lp.json')).spatialEntities.find((e) => e['@id'] === BASE + 'place/d1').attestations[0];
  assert.deepEqual([oj.properties, oj.notes], [undefined, `description: ${WORDS}`]);
});

test('the flat table carries a description from any dataset, and still says what else it leaves out', () => {
  const lost = [];
  const table = new FlatTable({ loss: (l) => lost.push(`${l.kind} ${l.value}`) });
  const described = { property: DCT_DESCRIPTION, label: 'description', value: 'a city on the Seine' };
  table.record({ value: { '@id': BASE + 'place/p', label: 'Paris', attestations: [{ names: [{ toponym: 'Paris' }], properties: [described] }] } });
  table.record({ value: { '@id': BASE + 'place/l', label: 'Lyon', attestations: [{ names: [{ toponym: 'Lyon' }], properties: [{ ...described, value: 'a city on the Rhône' }, { property: 'https://example.org/population', label: 'population', value: 500000 }] }] } });
  const { header, rows } = table.table();
  assert.deepEqual(rows.map((row) => row[header.indexOf('description')]), ['a city on the Seine', 'a city on the Rhône']);
  assert.deepEqual(lost, [`flat-facet-not-carried ${BASE}place/l: properties`], 'the property that is no description is reported; the description alone is not');
});
