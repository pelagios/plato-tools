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
  // Only the rows with a title_uri or a description still have notes for LPF to leave out: two of the twelve (Emesa and Ḥarrān), where it was all twelve.
  assert.equal(lossCount(r, 'dropped:attestation.notes'), 2);
  // And the same rows as the ten tables: seven identities.
  const t = await go([fx()], 'convert', 'tables', { base: BASE });
  const ids = Papa.parse(strFromU8(unzipSync(t.e.outs['whg-lp7-12-tables.zip'][0])['identities.csv']), { header: true, skipEmptyLines: true }).data;
  assert.equal(ids.length, 7);
  assert.ok(ids.every((i) => i.match_type === 'closeMatch' && /^https:\/\/sws\.geonames\.org\/\d+\/$/.test(i.same_as)));
});
