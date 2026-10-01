// Routes, itineraries and networks, and places in the history of people, objects and events (PLATO
// 0.6.0): plato:MemberOf with a sequence, the connections sheet, relations to a target described
// elsewhere (related_uri, relatedLabel), and plato:computed. The fixture test/fixtures/tables-routes
// was accepted by rdf-tabular (strict, serialize --validate) on 2026-09-29, 345 triples, and with its
// about sheet (a draft with a title only) on 2026-09-30, 350 triples. A set of CSV files is named
// after the first, which is now about.csv.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import Papa from 'papaparse';
import { file, textFile, outText, go } from './engine.js';
import { checkTableRules } from '../src/formats/tables.js';

const P = 'https://w3id.org/plato#';
const DIR = 'test/fixtures/tables-routes';
const tables = () => readdirSync(DIR).map((f) => file(`${DIR}/${f}`));
const items = (r, sev) => r.report.items.filter((i) => i.severity === sev);
const kinds = (r, sev) => items(r, sev).map((i) => i.kind);
const records = (r, name) => outText(r.e, name).trim().split('\n').slice(1).map((l) => JSON.parse(l));
const rowsOf = (text) => Papa.parse(text, { header: true, skipEmptyLines: true }).data;

test('tables with routes, segments, connections and outside targets are valid, and read as PLATO says', async () => {
  const r = await go(tables(), 'convert', 'plato-jsonl');
  assert.deepEqual(items(r, 'error'), []);
  // The fixture's about sheet is a draft with only a title: it has no licence and no base_uri, each a warning.
  assert.deepEqual(items(r, 'warning').map((i) => i.message.split(':')[0]).sort(), ['about.csv, column base_uri', 'about.csv, column licence']);
  const recs = records(r, 'about.jsonl');
  const atts = (id) => recs.find((x) => x.entityIdentifier === id).attestations;
  const station = atts('bunsty').find((a) => a.relations?.[0].relationType === P + 'MemberOf');
  assert.equal(station.sequence, 3);
  assert.match(station.relations[0].relatesTo, /\/place\/iter2$/);
  const birth = atts('lumbini').find((a) => a.relations);
  assert.deepEqual(birth.relations[0], { relatesTo: 'http://www.wikidata.org/entity/Q9441', relatedLabel: 'the Buddha', relationType: P + 'BirthplaceOf' });
  assert.ok(!recs.some((x) => x['@id'] === 'http://www.wikidata.org/entity/Q9441'), 'an outside target is not made a place');
  // A connections row is one attestation: the figure is about the connection, not about Florence.
  const link = atts('florence').find((a) => a.relations);
  assert.equal(link.relations[0].relationType, P + 'LeadsTo');
  assert.deepEqual(link.properties, [{ property: 'https://example.org/prop/letters', label: 'letters sent', value: 412 }]);
});

test('tables -> PLATO -> tables gives back every relations and connections row', async () => {
  const a = await go(tables(), 'convert', 'plato-jsonl');
  const b = await go([textFile(outText(a.e, 'about.jsonl'), 'routes.jsonl')], 'convert', 'tables');
  assert.deepEqual(items(b, 'error'), []);
  const z = unzipSync(b.e.outs['routes-tables.zip'][0]);
  for (const sheet of ['relations', 'connections']) {
    const want = rowsOf(readFileSync(`${DIR}/${sheet}.csv`, 'utf8')).map((x) => JSON.stringify(x)).sort();
    const got = rowsOf(strFromU8(z[`${sheet}.csv`])).map((x) => JSON.stringify(x)).sort();
    assert.deepEqual(got, want, `${sheet} rows differ`);
  }
  // Florence has no properties row: its figure went back to the connections sheet.
  assert.ok(!rowsOf(strFromU8(z['properties.csv'])).some((x) => x.place_id === 'florence'));
  const places = rowsOf(strFromU8(z['places.csv'])).map((x) => x.place_id);
  assert.ok(!places.some((p) => /Q9441|Q935/.test(p)), `outside targets got place rows: ${places}`);
});

test('JSON -> RDF: the new keys map to PLATO terms, and RDF -> JSON gives them back', async () => {
  const doc = {
    profile: 'attestation-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' },
    attestations: [
      { '@id': 'https://example.org/a/1', about: 'https://example.org/e/durobrivae', sequence: 3,
        relations: [{ relatesTo: 'https://example.org/e/iter2', relationType: P + 'MemberOf' }], citations: [{ source: 'https://example.org/s/it' }] },
      { '@id': 'https://example.org/a/2', about: 'https://example.org/e/lumbini',
        relations: [{ relatesTo: 'http://www.wikidata.org/entity/Q9441', relatedLabel: 'the Buddha', relationType: P + 'BirthplaceOf' }], citations: [{ source: 'https://example.org/s/it' }] },
      { '@id': 'https://example.org/a/3', about: 'https://example.org/e/iter2', computed: true,
        timespans: [{ startEarliest: '0200', endLatest: '0300', qualification: { computed: true } }], citations: [{ source: 'https://example.org/s/it' }] },
    ],
  };
  const a = await go([textFile(JSON.stringify(doc), 'r.json')], 'convert', 'ntriples');
  assert.deepEqual(items(a, 'error'), []);
  const nt = outText(a.e, 'r.nt');
  assert.match(nt, /<https:\/\/example\.org\/a\/1> <https:\/\/w3id\.org\/plato#sequence> "3"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#integer> \./);
  assert.match(nt, /<https:\/\/example\.org\/a\/2> <https:\/\/w3id\.org\/plato#related_label> "the Buddha" \./);
  assert.match(nt, /<https:\/\/example\.org\/a\/3> <https:\/\/w3id\.org\/plato#computed> "true"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#boolean> \./);
  assert.equal((nt.match(/#computed>/g) || []).length, 2, 'the attestation and its timespan');
  assert.doesNotMatch(nt, /Q9441> <http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#type>/, 'an outside target is given no type');
  const b = await go([textFile(nt, 'r2.nt')], 'convert', 'plato-jsonl');
  assert.deepEqual(items(b, 'loss'), []);
  const back = outText(b.e, 'r2.jsonl');
  for (const s of ['"sequence":3', '"relatedLabel":"the Buddha"', '"computed":true']) assert.ok(back.includes(s), `${s} not in ${back}`);
});

// Images and records about a place (PLATO DepictedIn, SubjectOf): outside targets, like people and
// events, so they go to related_uri and never become places of their own.
test('a DepictedIn relation with a label goes JSON -> tables -> JSON through related_uri and related_label, unchanged', async () => {
  const photo = { relatesTo: 'https://collections.example.org/photo/1234', relatedLabel: 'Aerial photograph of the cave site, 1962', relationType: P + 'DepictedIn' };
  const record = { relatesTo: 'https://archive.example.org/file/77', relationType: P + 'SubjectOf' };
  const doc = { profile: 'place-centric', gazetteer: { '@id': 'https://example.org/my-dataset/', title: 't' }, spatialEntities: [{ '@id': 'https://example.org/my-dataset/place/cave', label: 'Cave', entityIdentifier: 'cave', attestations: [
    { relations: [photo], citations: [{ source: 'https://example.org/my-dataset/source/cat' }] },
    { relations: [record], citations: [{ source: 'https://example.org/my-dataset/source/cat' }] },
  ] }] };
  const t = await go([textFile(JSON.stringify(doc), 'd.json')], 'convert', 'tables');
  assert.deepEqual(items(t, 'error'), []);
  assert.ok(!kinds(t, 'loss').includes('relation-type-not-in-plato'), kinds(t, 'loss').join(', '));
  const z = unzipSync(t.e.outs['d-tables.zip'][0]);
  const rel = rowsOf(strFromU8(z['relations.csv']));
  assert.deepEqual(rel.map((r) => [r.relation_type, r.related_place_id, r.related_uri, r.related_label]),
    [['DepictedIn', '', photo.relatesTo, photo.relatedLabel], ['SubjectOf', '', record.relatesTo, '']]);
  assert.deepEqual(rowsOf(strFromU8(z['places.csv'])).map((r) => r.place_id), ['cave'], 'the photograph and the file get no place rows');
  const back = await go([new File([t.e.outs['d-tables.zip'][0]], 'd.zip')], 'convert', 'plato-jsonl');
  assert.deepEqual(items(back, 'error'), []);
  // A record named by no label is a warning, as for any outside target; the photograph's has one.
  assert.deepEqual(items(back, 'warning').filter((i) => /related_label/.test(i.message)).map((i) => i.count), [1]);
  const [cave] = records(back, 'd.jsonl');
  assert.deepEqual(cave.attestations.map((a) => a.relations[0]), [photo, record]);
});

test('a computed value is left out of the tables and of LPF, and reported; never written as evidence', async () => {
  const doc = {
    profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' },
    spatialEntities: [{ '@id': 'https://example.org/e/iter2', label: 'Iter II', attestations: [
      { names: [{ toponym: 'Iter Britanniarum II' }], citations: [{ source: 'https://example.org/s/it' }] },
      { computed: true, timespans: [{ startEarliest: '0200', endLatest: '0300' }], types: [{ label: 'route' }], citations: [{ source: 'https://example.org/s/it' }] },
      { geometries: [{ geojson: { type: 'LineString', coordinates: [[0.1, 51.5], [0.5, 51.7]] }, qualification: { computed: true } }], citations: [{ source: 'https://example.org/s/it' }] },
    ] }],
  };
  const t = await go([textFile(JSON.stringify(doc), 'c.json')], 'convert', 'tables');
  const z = unzipSync(t.e.outs['c-tables.zip'][0]);
  assert.equal(rowsOf(strFromU8(z['types.csv'])).length, 0, 'the computed type is not written');
  assert.equal(rowsOf(strFromU8(z['locations.csv'])).length, 0, 'the computed line is not written');
  assert.equal(rowsOf(strFromU8(z['names.csv'])).length, 1, 'the attested name is');
  assert.equal(kinds(t, 'loss').filter((k) => k === 'computed').length, 1, 'reported as one kind of loss');
  assert.equal(items(t, 'loss').find((i) => i.kind === 'computed').count, 2);
  const l = await go([textFile(JSON.stringify(doc), 'c.json')], 'convert', 'lpf');
  const fc = JSON.parse(outText(l.e, 'c.geojson'));
  assert.equal(fc.features[0].geometry, null, 'no computed geometry in LPF');
  assert.ok(!fc.features[0].types, 'no computed type in LPF');
  assert.equal(items(l, 'loss').find((i) => i.kind === 'computed').count, 2);
});

test('LPF: a sequence and an outside target\'s name are reported as losses, never dropped silently', async () => {
  const a = await go(tables(), 'convert', 'plato-jsonl');
  const l = await go([textFile(outText(a.e, 'about.jsonl'), 'routes.jsonl')], 'convert', 'lpf');
  const k = kinds(l, 'loss');
  assert.ok(k.includes('dropped:attestation.sequence'), k.join(', '));
  assert.ok(k.includes('dropped:relation.relatedLabel'), k.join(', '));
});

test('PLATO\'s own table rules: at most one target, a name for an address or alone, a sequence only on MemberOf', () => {
  const run = (rows) => { const issues = [], warns = []; checkTableRules((n) => (n === 'relations' ? rows : []), { issue: (i) => issues.push(i), warn: (i) => warns.push(i) }); return { issues, warns }; };
  const base = { place_id: 'a', relation_type: 'ContainedIn', related_place_id: 'b', related_uri: '', related_label: '', sequence: '' };
  assert.deepEqual(run([base]), { issues: [], warns: [] }, 'a positive control');
  assert.equal(run([{ ...base, related_uri: 'http://www.wikidata.org/entity/Q1', related_label: 'x' }]).issues.length, 1, 'both targets');
  assert.equal(run([{ ...base, related_place_id: '' }]).issues.length, 1, 'no target and no name');
  // PLATO 7720890 (#18): a name alone, for something the source gives no address for ('in the Delta').
  assert.deepEqual(run([{ ...base, related_place_id: '', related_label: 'the Delta' }]), { issues: [], warns: [] }, 'a name alone');
  assert.deepEqual(run([{ ...base, relation_type: 'BirthplaceOf', related_place_id: '', related_uri: 'http://www.wikidata.org/entity/Q1' }]).warns.map((w) => w.column), ['related_label']);
  assert.deepEqual(run([{ ...base, sequence: '2' }]).warns.map((w) => w.column), ['sequence']);
});

test('the tables report a row with two targets, and one with none, as problems; a row with only a name is not', async () => {
  const relations = readFileSync(`${DIR}/relations.csv`, 'utf8');
  const withRows = (text) => go(readdirSync(DIR).filter((f) => f !== 'relations.csv').map((f) => file(`${DIR}/${f}`)).concat(textFile(text, 'relations.csv')), 'check');
  const twoAndNone = relations.replace('lumbini,BirthplaceOf,,', 'lumbini,BirthplaceOf,cambridge,').replace('bunsty,MemberOf,iter2,', 'bunsty,MemberOf,,');
  const r = await withRows(twoAndNone);
  const msgs = items(r, 'error').map((i) => i.message);
  // The row with no target is also an attestation with neither relatesTo nor relatedLabel, which the schema reports too.
  assert.equal(r.report.errors, 3, JSON.stringify(msgs));
  assert.ok(msgs.some((m) => /fill in one of them/.test(m)) && msgs.some((m) => /gives no related place/.test(m)), JSON.stringify(msgs));
  // PLATO 7720890 (#18): the same row naming its target in related_label alone ("in the Delta") passes.
  const nameAlone = await withRows(relations.replace('bunsty,ContainedIn,buckinghamshire,,,', 'bunsty,ContainedIn,,,the Delta,'));
  assert.deepEqual(items(nameAlone, 'error').map((i) => i.message), []);
  assert.ok(relations.includes('bunsty,ContainedIn,buckinghamshire,,,'), 'the row the control edits is there');
});

// PLATO 7720890 (#20): timespanRole EvidenceSpan dates the evidence (the documents that mention the
// place), not the place. Written as LPF's when, or in the tables' date columns, it would date the place.
test('an evidence span is not written as the place\'s dates in LPF or the tables, and is reported', async () => {
  const window = { timespanRole: P + 'EvidenceSpan', timespans: [{ startEarliest: '-0250', endLatest: '0150' }], citations: [{ source: 'https://example.org/s/tm' }] };
  const named = { timespanRole: P + 'EvidenceSpan', names: [{ toponym: 'Syene' }], timespans: [{ startEarliest: '-0200', endLatest: '0100' }], citations: [{ source: 'https://example.org/s/tm' }] };
  const doc = (atts) => JSON.stringify({ profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' },
    spatialEntities: [{ '@id': 'https://example.org/e/syene', label: 'Syene', attestations: atts }] });
  const l = await go([textFile(doc([window, named]), 'w.json')], 'convert', 'lpf');
  const f = JSON.parse(outText(l.e, 'w.geojson')).features[0];
  assert.equal(f.when, undefined, `the window is not the place's when: ${JSON.stringify(f.when)}`);
  assert.deepEqual(f.names.map((n) => [n.toponym, n.when]), [['Syene', undefined]], 'the name is written, without the evidence span as its dates');
  const ll = items(l, 'loss').find((i) => i.kind === 'evidence-span');
  assert.equal(ll?.count, 2, JSON.stringify(kinds(l, 'loss')));
  assert.match(ll.message, /dates of the place/);
  // A control: the same attestations with no role are dated as the source says.
  const plain = (a) => { const { timespanRole, ...rest } = a; return rest; };
  const c = await go([textFile(doc([plain(window), plain(named)]), 'w.json')], 'convert', 'lpf');
  const cf = JSON.parse(outText(c.e, 'w.geojson')).features[0];
  assert.ok(cf.when && cf.names[0].when, JSON.stringify(cf));
  assert.equal(items(c, 'loss').find((i) => i.kind === 'evidence-span'), undefined);
  const t = await go([textFile(doc([window, named]), 'w.json')], 'convert', 'tables');
  const z = unzipSync(t.e.outs['w-tables.zip'][0]);
  const names = rowsOf(strFromU8(z['names.csv']));
  assert.deepEqual(names.map((r) => [r.name, r.date, r.from, r.to]), [['Syene', 'undated', '', '']]);
  assert.equal(items(t, 'loss').find((i) => i.kind === 'evidence-span')?.count, 2, JSON.stringify(kinds(t, 'loss')));
  assert.ok(!kinds(t, 'loss').includes('attestation-without-facet'), 'the window is reported once, as an evidence span');
  const ct = await go([textFile(doc([plain(window), plain(named)]), 'w.json')], 'convert', 'tables');
  const cnames = rowsOf(strFromU8(unzipSync(ct.e.outs['w-tables.zip'][0])['names.csv']));
  assert.deepEqual(cnames.map((r) => [r.from, r.to]), [['-0200', '0100']], 'a control: without the role the name is dated');
});

test('a route that is, through its members, a member of itself is an error; a chain is not', async () => {
  const att = (about, whole) => ({ about, relations: [{ relatesTo: whole, relationType: P + 'MemberOf' }], citations: [{ source: 'https://example.org/s' }] });
  const doc = (atts) => JSON.stringify({ profile: 'attestation-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' }, attestations: atts });
  const E = (x) => `https://example.org/e/${x}`;
  const chain = await go([textFile(doc([att(E('stage'), E('pilgrimage')), att(E('town'), E('stage'))]), 'chain.json')], 'check');
  assert.deepEqual(kinds(chain, 'error'), [], 'a stage within a pilgrimage is fine');
  const loop = await go([textFile(doc([att(E('a'), E('b')), att(E('b'), E('c')), att(E('c'), E('a')), att(E('town'), E('a'))]), 'loop.json')], 'check');
  const err = items(loop, 'error').find((i) => i.kind === 'membership-cycle');
  assert.ok(err, JSON.stringify(loop.report.items));
  assert.deepEqual(err.examples.sort(), [E('a'), E('b'), E('c')], 'the three in the loop, not the town that is only a member');
  // The same loop in the tables.
  const rel = readFileSync(`${DIR}/relations.csv`, 'utf8') + 'iter2,MemberOf,bunsty,,,1,undated,,,domesday,,,,,,,,\n';
  const files = readdirSync(DIR).filter((f) => f !== 'relations.csv').map((f) => file(`${DIR}/${f}`)).concat(textFile(rel, 'relations.csv'));
  const t = await go(files, 'check');
  assert.ok(kinds(t, 'error').includes('membership-cycle'), JSON.stringify(t.report.items));
});

test('a duration is checked as rdf-tabular checks it: P42D is one, six weeks and P6W are not', async () => {
  // rdf-tabular (strict) accepted P42D in the relations sheet's duration column and rejected
  // 'six weeks' on 2026-09-29; xsd:duration has no weeks, so P6W is rejected too.
  const { checkCell } = await import('../src/formats/tables.js');
  const col = { datatype: { base: 'duration' } };
  for (const ok of ['P42D', 'P1D', 'PT12H', 'P1Y2M', 'P0D']) assert.equal(checkCell(col, ok), null, ok);
  for (const bad of ['six weeks', 'P6W', 'P', 'PT', '42D']) assert.ok(checkCell(col, bad), bad);
  const rel = readFileSync(`${DIR}/relations.csv`, 'utf8').replace('bunsty,MemberOf,iter2,,,3,undated,,,', 'bunsty,MemberOf,iter2,,,3,undated,,,P42D');
  const files = (text) => readdirSync(DIR).filter((f) => f !== 'relations.csv').map((f) => file(`${DIR}/${f}`)).concat(textFile(text, 'relations.csv'));
  const good = await go(files(rel), 'convert', 'plato-jsonl');
  assert.deepEqual(items(good, 'error'), []);
  assert.ok(outText(good.e, 'about.jsonl').includes('"duration":"P42D"'));
  const bad = await go(files(rel.replace('P42D', 'six weeks')), 'check');
  // The cell, and the record it becomes (the JSON Schema's duration pattern), each report it.
  assert.ok(items(bad, 'error').some((i) => i.kind === 'table' && /duration/.test(i.message)), JSON.stringify(bad.report.items));
  assert.ok(items(bad, 'error').every((i) => /duration|pattern|match/i.test(i.message + JSON.stringify(i.examples))), JSON.stringify(bad.report.items));
});

test('a relation type a document declares for itself goes to RDF and back, and LPF and the tables report it as lost', async () => {
  const doc = {
    profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g/rivers', title: 'Rivers' },
    relationTypes: [{ '@id': 'https://example.org/vocab/flows-into', label: 'flows into', inverseLabel: 'receives', broaderRelation: P + 'LeadsTo' }],
    spatialEntities: [{ '@id': 'https://example.org/e/ryton', label: 'River Ryton', attestations: [
      { relations: [{ relatesTo: 'https://example.org/e/idle', relationType: 'https://example.org/vocab/flows-into' }], citations: [{ source: { '@id': 'https://example.org/s/rewt', title: 'REWT' } }] }] }],
  };
  const a = await go([textFile(JSON.stringify(doc), 'r.json')], 'convert', 'ntriples');
  assert.deepEqual(items(a, 'error'), []);
  const nt = outText(a.e, 'r.nt');
  assert.match(nt, /<https:\/\/example\.org\/g\/rivers> <https:\/\/w3id\.org\/plato#declares_relation_type> <https:\/\/example\.org\/vocab\/flows-into> \./);
  assert.match(nt, /<https:\/\/example\.org\/vocab\/flows-into> <https:\/\/w3id\.org\/plato#broader_relation> <https:\/\/w3id\.org\/plato#LeadsTo> \./);
  const b = await go([textFile(nt, 'r2.nt')], 'convert', 'plato-json');
  assert.deepEqual(items(b, 'loss'), []);
  assert.deepEqual(JSON.parse(outText(b.e, 'r2.json')).relationTypes, doc.relationTypes);
  for (const target of ['lpf', 'tables']) {
    const c = await go([textFile(JSON.stringify(doc), 'r.json')], 'convert', target);
    assert.ok(kinds(c, 'loss').includes('relation-types'), `${target}: ${kinds(c, 'loss')}`);
  }
  // The tables take only PLATO's own relation types, so the relation that uses it is reported too.
  const t = await go([textFile(JSON.stringify(doc), 'r.json')], 'convert', 'tables');
  assert.ok(kinds(t, 'loss').includes('relation-type-not-in-plato'), kinds(t, 'loss').join(', '));
});
