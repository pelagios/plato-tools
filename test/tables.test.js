import { PLATO_REPO, DEEP_EXPORT } from './paths.js';
// The table validator must agree with the reference CSVW implementation (rdf-tabular, strict)
// on the PLATO examples and on the six broken variants the PLATO repository's checks use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import Papa from 'papaparse';
import { validateTables, tableSchemas, rowToAttestation, tableIds, ATTESTATION_SHEETS } from '../src/formats/tables.js';

const META = JSON.parse(readFileSync('public/plato/csv-metadata.json', 'utf8'));
const EX = `${PLATO_REPO}/schemas/tables/examples`;

function loadDir(dir) {
  const t = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.csv'))) t[f.replace(/\.csv$/, '')] = readFileSync(`${dir}/${f}`, 'utf8');
  return t;
}
async function validate(tables) {
  const parsed = {};
  for (const [k, text] of Object.entries(tables)) parsed[k] = Papa.parse(text, { header: true, skipEmptyLines: true });
  const sets = new Map(); const issues = [];
  await validateTables(META, {
    header: async (n) => (parsed[n] ? parsed[n].meta.fields : null),
    rows: async function* (n) { yield* parsed[n].data; },
    keys: { add: async (t, k) => { const s = sets.get(t) || sets.set(t, new Set()).get(t); if (s.has(k)) return false; s.add(k); return true; },
            has: async (t, k) => !!sets.get(t)?.has(k) },
    issue: (i) => issues.push(i),
  });
  return issues;
}
const mutate = (tables, sheet, fn) => {
  const p = Papa.parse(tables[sheet], { header: true, skipEmptyLines: true });
  fn(p.data);
  return { ...tables, [sheet]: Papa.unparse(p.data, { columns: p.meta.fields, newline: '\n' }) + '\n' };
};

const TABLE_EXAMPLES = readdirSync(EX);
test('the example tables are there to accept', () => {
  for (const ex of ['antonine', 'customs', 'datini', 'king-john', 'river-idle', 'survey'])
    assert.ok(TABLE_EXAMPLES.includes(ex), `${ex} is not among ${TABLE_EXAMPLES.join(', ')}`);
});
for (const ex of TABLE_EXAMPLES) {
  test(`valid tables are accepted: ${ex}`, async () => {
    const issues = await validate(loadDir(`${EX}/${ex}`));
    assert.deepEqual(issues, []);
  });
}
const survey = () => loadDir(`${EX}/survey`);
const controls = {
  'unknown place_id in names': () => mutate(survey(), 'names', (r) => { r[0].place_id = 'nowhere'; }),
  'misspelt form_status': () => mutate(survey(), 'names', (r) => { r[5].form_status = 'Headwrd'; }),
  'missing required date': () => mutate(survey(), 'names', (r) => { r[1].date = ''; }),
  'three-digit year': () => mutate(survey(), 'names', (r) => { r[1].from = '921'; }),
  'duplicate source_id': () => mutate(survey(), 'sources', (r) => { r[1].source_id = 'asc-annal-921'; }),
  'missing sheet': () => { const t = survey(); delete t.properties; return t; },
};
// The columns PLATO cf87b78 added, filled in (test/fixtures/tables-judgements), and broken one at a
// time. rdf-tabular (strict, serialize --validate) accepted the fixture and '12000', and rejected
// each of these, on 2026-09-27; the validator here must give the same verdicts.
const judged = () => loadDir('test/fixtures/tables-judgements');
test('valid tables are accepted: the new columns filled in', async () => {
  assert.deepEqual(await validate(judged()), []);
  assert.deepEqual(await validate(mutate(judged(), 'relations', (r) => { r[0].from = '12000'; })), [], 'a five-digit year is a year');
});
Object.assign(controls, {
  'denied written Yes': () => mutate(judged(), 'types', (r) => { r[0].denied = 'Yes'; }),
  'denied written true': () => mutate(judged(), 'types', (r) => { r[0].denied = 'true'; }),
  'denied written 1': () => mutate(judged(), 'types', (r) => { r[0].denied = '1'; }),
  'denied written y': () => mutate(judged(), 'types', (r) => { r[0].denied = 'y'; }),
  'a citation function that is not CiTO': () => mutate(judged(), 'names', (r) => { r[0].citation_function = 'seeFurther'; }),
  'a citation function given as a full address': () => mutate(judged(), 'names', (r) => { r[0].citation_function = 'http://purl.org/spar/cito/citesAsEvidence'; }),
  'a misspelt transcription accuracy': () => mutate(judged(), 'names', (r) => { r[0].transcription_accuracy = 'Misread'; }),
  'a transcription completeness in lower case': () => mutate(judged(), 'names', (r) => { r[0].transcription_completeness = 'complete'; }),
  'a three-digit year beside a deep-time one': () => mutate(judged(), 'relations', (r) => { r[0].from = '921'; }),
});
// The about sheet (PLATO's FAIR metadata). rdf-tabular (strict, serialize --validate) rejected each of
// these on 2026-09-30, and accepted zero rows, two rows and a published row without a licence, which
// CSVW cannot state and PLATO tools checks beside it (checkAboutRules, test/about.test.js).
// Since PLATO 8385472 a creator may be a name alone, so 'Stephen Gadd' is no longer a broken cell; the
// creator cell's own broken forms are the three rdf-tabular rejected for that commit: a name with
// something not an address in brackets, an address in brackets with no name, and an unclosed bracket.
Object.assign(controls, {
  'about without a title': () => mutate(survey(), 'about', (r) => { r[0].title = ''; }),
  'about status Published': () => mutate(survey(), 'about', (r) => { r[0].status = 'Published'; }),
  'about creator with a name and something not an address in brackets': () => mutate(survey(), 'about', (r) => { r[0].creator = 'Stephen Gadd <not an address>'; }),
  'about creator with an address in brackets and no name': () => mutate(survey(), 'about', (r) => { r[0].creator = '<https://orcid.org/0000-0003-3060-0181>'; }),
  'about creator with an unclosed bracket': () => mutate(survey(), 'about', (r) => { r[0].creator = 'Stephen Gadd <https://orcid.org/0000-0003-3060-0181'; }),
  'about temporal_from of three digits': () => mutate(survey(), 'about', (r) => { r[0].temporal_from = '921'; }),
});
test('the about sheet\'s creator takes a name with its address, an address alone and a name alone, several at once', async () => {
  for (const creator of ['Stephen Gadd', 'https://orcid.org/0000-0003-3060-0181', 'Stephen Gadd <https://orcid.org/0000-0003-3060-0181>',
    'Stephen Gadd <https://orcid.org/0000-0003-3060-0181>;Anne Annotator; https://ror.org/052gg0110']) {
    assert.deepEqual(await validate(mutate(survey(), 'about', (r) => { r[0].creator = creator; })), [], creator);
  }
});
test('the about rules CSVW cannot state are not CSVW errors: zero rows, two rows, published without a licence', async () => {
  const t = survey();
  assert.deepEqual(await validate({ ...t, about: t.about.split('\n')[0] + '\n' }), []);
  assert.deepEqual(await validate(mutate(survey(), 'about', (r) => { r.push({ ...r[0] }); })), []);
  assert.deepEqual(await validate(mutate(survey(), 'about', (r) => { r[0].status = 'published'; r[0].licence = ''; })), []);
});
for (const [name, make] of Object.entries(controls)) {
  test(`broken tables are rejected: ${name}`, async () => {
    const issues = await validate(make());
    assert.ok(issues.length >= 1, 'expected at least one issue');
    assert.ok(issues.length <= 2, `only the broken cell should be reported: ${JSON.stringify(issues)}`);
  });
}

test('tables -> PLATO attestations: the survey name rows', () => {
  const t = survey();
  const sources = Object.fromEntries(Papa.parse(t.sources, { header: true, skipEmptyLines: true }).data.map((r) => [r.source_id, r]));
  const ids = tableIds('https://example.org/survey/', (id) => sources[id]);
  const names = Papa.parse(t.names, { header: true, skipEmptyLines: true }).data;
  const ibid = rowToAttestation('names', names.find((r) => r.attribution === 'Inferred'), ids);
  assert.equal(ibid.citations[0].attributionStatus, 'https://w3id.org/plato#AttributionInferred');
  assert.equal(ibid.citations[0].locator, '1253-54, p. 31');
  assert.equal(ibid.citations[0].source['@id'], 'https://example.org/survey/source/close-rolls');
  const headword = rowToAttestation('names', names.find((r) => r.form_status === 'Headword'), ids);
  assert.equal(headword.formStatus, 'https://w3id.org/plato#Headword');
  const witness = ids.source('asc-ms-a');
  // The original is written in full, so that a source cited only as another's original keeps its title.
  assert.equal(witness.derivedFrom['@id'], 'https://example.org/survey/source/asc-annal-921');
  assert.equal(witness.derivedFrom.title, 'Anglo-Saxon Chronicle, annal for 921');
  assert.equal(witness.derivedFrom.citation, 'ASC s.a. 921');
  // The date column is the date as written: plato:source_label since PLATO 9d2c36e.
  assert.deepEqual(witness.timespan, { sourceLabel: 'c. 925', startEarliest: '0915', endLatest: '0935' });
  assert.equal(rowToAttestation('names', names[0], ids).timespans[0].sourceLabel, names[0].date);
});

test('tables: certainty_level becomes certaintyLevel, and comes back', () => {
  const t = survey();
  const sources = Object.fromEntries(Papa.parse(t.sources, { header: true, skipEmptyLines: true }).data.map((r) => [r.source_id, r]));
  const ids = tableIds('https://example.org/survey/', (id) => sources[id]);
  const row = { ...Papa.parse(t.names, { header: true, skipEmptyLines: true }).data[0], certainty_level: 'LessCertain', form_status: 'Preferred' };
  const a = rowToAttestation('names', row, ids);
  assert.equal(a.certaintyLevel, 'https://w3id.org/plato#LessCertain');
  assert.equal(a.formStatus, 'https://w3id.org/plato#Preferred');
  const losses = [];
  const back = recordToRows({ '@id': 'https://example.org/survey/place/x', label: 'X', entityIdentifier: 'x', attestations: [a] },
    { place: (iri, label, own, cc, eid) => eid || 'p', source: () => 's' }, (l) => losses.push(l.kind));
  assert.equal(back.names[0].certainty_level, 'LessCertain');
  assert.equal(back.names[0].form_status, 'Preferred');
  assert.equal(back.names[0].place_id, 'x', 'entityIdentifier is offered as the place_id');
  assert.deepEqual(losses, []);
  const other = recordToRows({ '@id': 'x', label: 'X', attestations: [{ ...a, certaintyLevel: 'https://example.org/levels/Probable' }] },
    { place: () => 'p', source: () => 's' }, (l) => losses.push(l.kind));
  assert.equal(other.names[0].certainty_level, '');
  assert.deepEqual(losses, ['certainty-level'], 'a level the tables cannot hold is reported');
});

import { recordToRows } from '../src/formats/tables.js';
test('tables -> PLATO records -> tables gives back the survey rows', () => {
  const t = survey();
  const parse = (s) => Papa.parse(t[s], { header: true, skipEmptyLines: true }).data;
  const sources = Object.fromEntries(parse('sources').map((r) => [r.source_id, r]));
  const places = parse('places');
  const base = 'https://example.org/survey/';
  const fwd = tableIds(base, (id) => sources[id]);
  // Group every attestation row under its place, as the engine does through its store.
  const recs = places.map((p) => ({ '@id': fwd.place(p.place_id), label: p.label, attestations: [] }));
  const byId = Object.fromEntries(recs.map((r, i) => [places[i].place_id, r]));
  for (const sheet of ATTESTATION_SHEETS) for (const row of parse(sheet)) byId[row.place_id].attestations.push(rowToAttestation(sheet, row, fwd));
  // And back, with ids read off the IRIs we minted.
  const back = { names: [], relations: [], types: [], locations: [], properties: [], identities: [] }; const losses = [];
  const ids = { place: (iri) => decodeURIComponent(iri.slice((base + 'place/').length)), source: (s) => decodeURIComponent((s['@id'] || s).slice((base + 'source/').length)) };
  for (const r of recs) { const rows = recordToRows(r, ids, (l) => losses.push(l.kind)); for (const k of Object.keys(back)) back[k].push(...rows[k]); }
  // Key order is not compared: the writer lays out each row by the sheet's own column order.
  const norm = (rows) => rows.map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)]).sort(([a], [b]) => a.localeCompare(b))))).sort();
  for (const sheet of ['names', 'types', 'relations']) {
    const orig = parse(sheet).map((r) => ({ ...r, certainty: r.certainty === '' ? '' : String(Number(r.certainty)) }));
    assert.deepEqual(norm(back[sheet]), norm(orig), `${sheet} rows differ`);
  }
  assert.deepEqual(losses, []);
});

test('a loop of derivations in the sources sheet stops at an address', () => {
  const rows = { a: { source_id: 'a', title: 'A', derived_from: 'b' }, b: { source_id: 'b', title: 'B', derived_from: 'a' } };
  const ids = tableIds('https://example.org/loop/', (id) => rows[id]);
  const a = ids.source('a');
  assert.equal(a.derivedFrom.title, 'B');
  assert.equal(a.derivedFrom.derivedFrom, 'https://example.org/loop/source/a');
});

// A property's value cell is a number only when it is written as one (JSON's number grammar, spaces
// round it allowed); Number() read " " as 0, "0x10" as 16, "007" as 7 and "Infinity" as a number
// JSON cannot hold.
test('a property value cell becomes a number only when it is written as a decimal number', () => {
  const ids = tableIds('https://example.org/t/', () => ({ title: 'S' }));
  const value = (cell) => rowToAttestation('properties', { place_id: 'p', source_id: 's', property_uri: 'https://example.org/prop', value: cell }, ids).properties[0].value;
  for (const [cell, want] of [['42', 42], [' 42 ', 42], ['-3.5', -3.5], ['0', 0], ['0.25', 0.25], ['1e-7', 1e-7], ['2.5E+3', 2500], ['1e+21', 1e21]]) assert.equal(value(cell), want, `${JSON.stringify(cell)} is a number`);
  for (const cell of [' ', '0x10', '007', 'Infinity', '-Infinity', 'NaN', '+5', '.5', '5.', '1,000', '0b1', '1e', 'twelve']) assert.equal(value(cell), cell, `${JSON.stringify(cell)} is kept as written`);
});

test('writing tables, an address with a malformed %-escape keeps its last part as written, and the place is written', async () => {
  const { go, textFile, outText } = await import('./engine.js');
  const { unzipSync, strFromU8 } = await import('fflate');
  const place = (id) => ({ '@id': id, label: 'P', attestations: [{ names: [{ toponym: 'P' }], sources: [{ '@id': 'https://example.org/source/s%E0%A4', title: 'S' }] }] });
  const doc = { profile: 'place-centric', gazetteer: { title: 't' }, spatialEntities: [place('https://example.org/place/bad%E0%A4'), place('https://example.org/place/good%20one')] };
  const r = await go([textFile(JSON.stringify(doc), 'pct.json')], 'convert', 'tables');
  assert.deepEqual(r.report.items.filter((i) => i.severity === 'error'), []);
  const zip = unzipSync(new Uint8Array(Buffer.concat(r.e.outs['pct-tables.zip'].map((b) => Buffer.from(b)))));
  const csv = (n) => strFromU8(zip[Object.keys(zip).find((k) => k.endsWith(`${n}.csv`))]);
  assert.match(csv('places'), /^bad%E0%A4,/m, 'kept as written');
  assert.match(csv('places'), /^good-one,/m, 'control: a well-formed escape is still decoded');
  assert.match(csv('sources'), /^s%E0%A4,/m);
});
