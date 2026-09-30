import { PLATO_REPO } from './paths.js';
// The terms PLATO cf87b78 added, through every reader and writer: a source's denial
// (plato:negated), alternative readings (plato:AlternativeTo), why a source is cited
// (plato:citation_function), how well a form was read (plato:transcription_accuracy and
// plato:transcription_completeness), and years of more than four digits. Each is carried where the
// target can hold it and reported where it cannot; a denial is never written as an assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import Papa from 'papaparse';
import { res, file, textFile, outText, go } from './engine.js';
import { recordToFeature, featureToRecord } from '../src/formats/lpf.js';
import { recordToRows, rowToAttestation, tableIds } from '../src/formats/tables.js';
import { boundDatatype } from '../src/formats/json2rdf.js';

const EX = `${PLATO_REPO}/schemas/examples`;
const JUDGEMENTS = `${EX}/place-centric-judgements.json`;
const FIXTURE = 'test/fixtures/tables-judgements';
const P = 'https://w3id.org/plato#', CITO = 'http://purl.org/spar/cito/';
const errors = (r) => r.report.items.filter((i) => i.severity === 'error');
const lossKinds = (r) => r.report.items.filter((i) => i.severity === 'loss').map((i) => i.kind);
const loss = (r, kind) => r.report.items.find((i) => i.severity === 'loss' && i.kind === kind);
const fixtureFiles = () => readdirSync(FIXTURE).map((f) => file(`${FIXTURE}/${f}`));
const sheet = (zipBytes, name) => Papa.parse(strFromU8(unzipSync(zipBytes)[name]), { header: true, skipEmptyLines: true }).data;
const doc = () => JSON.parse(readFileSync(JUDGEMENTS, 'utf8'));
const one = (attestation, extra = {}) => ({ profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' },
  spatialEntities: [{ '@id': 'https://example.org/place/p', label: 'P', attestations: [{ sources: [{ '@id': 'https://example.org/source/s', title: 'S' }], ...attestation }], ...extra }] });

// ---- denials ------------------------------------------------------------------------------------
/** Every LPF element that could carry a facet of the feature, as one string to search. */
const lpfFacets = (fc) => JSON.stringify(fc.features.map((f) => [f.names, f.types, f.relations, f.geometry, f.descriptions, f.links]));
// Kingsbury's markets are asserted, with a source stance (reported, doubted), so they are rightly written;
// a search for the denied market leaves them out, and the stance tests below check them.
const KINGSBURY = /\/kingsbury$/;
const deniedSearch = (fc) => lpfFacets({ features: fc.features.filter((f) => !KINGSBURY.test(f['@id'])) });
const littleworthFacets = (fc) => lpfFacets({ features: fc.features.filter((f) => f['@id'].endsWith('/littleworth')) });

for (const target of ['lpf', 'lpf-seq']) {
  test(`a denial is left out of LPF (${target}), never written as an assertion, and reported`, async () => {
    const r = await go([file(JUDGEMENTS)], 'convert', target);
    assert.deepEqual(errors(r), []);
    const text = outText(r.e, `place-centric-judgements.${target === 'lpf' ? 'geojson' : 'geojsonl'}`);
    const fc = target === 'lpf' ? JSON.parse(text) : { features: text.trim().split('\n').slice(1).map((l) => JSON.parse(l)) };
    const littleworth = fc.features.find((f) => f['@id'].endsWith('/littleworth'));
    assert.ok(littleworth, 'the place itself is still written');
    assert.equal(littleworth.types, undefined, 'the denied type is not written');
    assert.doesNotMatch(deniedSearch(fc), /"market"/, 'nowhere else in the output is there a market');
    assert.match(lpfFacets(fc), /"market"/, 'control: the search can see a market (Kingsbury\'s)');
    assert.equal(loss(r, 'denial')?.count, 1, JSON.stringify(lossKinds(r)));
    assert.match(loss(r, 'denial').message, /would assert what its source denies/);
  });
}
test('control: the same attestation without negated is written to LPF as a market', async () => {
  const d = doc(); delete d.spatialEntities[0].attestations[0].negated;
  const r = await go([textFile(JSON.stringify(d), 'asserted.json')], 'convert', 'lpf');
  assert.match(littleworthFacets(JSON.parse(outText(r.e, 'asserted.geojson'))), /"market"/);
  assert.equal(loss(r, 'denial'), undefined);
});
test('control: negated false is an assertion, and is written to LPF', () => {
  const f = recordToFeature({ '@id': 'https://example.org/p', label: 'P', attestations: [{ types: [{ label: 'market' }], negated: false }] });
  assert.equal(f.types[0].label, 'market');
});
test('a malformed denial flag errs towards leaving the attestation out', () => {
  for (const negated of ['true', 'yes', 1]) {
    const losses = [];
    const f = recordToFeature({ '@id': 'https://example.org/p', label: 'P', attestations: [{ types: [{ label: 'market' }], negated }] }, [], (l) => losses.push(l.kind));
    assert.equal(f.types, undefined, `negated: ${JSON.stringify(negated)}`);
    assert.ok(losses.includes('denial'));
  }
});

test('a denial read from RDF is still left out of LPF, whether written "true" or "1"', async () => {
  const nt = outText((await go([file(JUDGEMENTS)], 'convert', 'ntriples')).e, 'place-centric-judgements.nt');
  assert.match(nt, /<https:\/\/w3id\.org\/plato#negated> "true"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#boolean>/);
  for (const [name, text] of [['true', nt], ['1', nt.replace(/(plato#negated> )"true"/, '$1"1"')]]) {
    if (name === '1') assert.match(text, /plato#negated> "1"\^\^/);
    const r = await go([textFile(text, `denial-${name}.nt`)], 'convert', 'lpf');
    const fc = JSON.parse(outText(r.e, `denial-${name}.geojson`));
    assert.doesNotMatch(deniedSearch(fc), /"market"/, `plato:negated "${name}"`);
    assert.equal(loss(r, 'denial')?.count, 1);
  }
});
test('RDF -> PLATO JSON reads xsd:boolean "1" and "0" as true and false', async () => {
  const nt = outText((await go([file(JUDGEMENTS)], 'convert', 'ntriples')).e, 'place-centric-judgements.nt');
  for (const [lex, want] of [['1', true], ['0', false], ['true', true], ['false', false]]) {
    const r = await go([textFile(nt.replace(/(plato#negated> )"true"/, `$1"${lex}"`), 'b.nt')], 'convert', 'plato-jsonl');
    assert.deepEqual(errors(r).filter((e) => e.kind !== 'no-label'), []);
    const recs = outText(r.e, 'b.jsonl').trim().split('\n').slice(1).map((l) => JSON.parse(l));
    const a = recs.find((x) => x['@id']?.endsWith('/littleworth')).attestations[0];
    assert.equal(a.negated, want, `"${lex}"^^xsd:boolean`);
  }
});

test('a denial goes into the tables as denied = yes, and comes back as negated', async () => {
  const r = await go([file(JUDGEMENTS)], 'convert', 'tables');
  assert.equal(loss(r, 'denial'), undefined);
  const zip = r.e.outs['place-centric-judgements-tables.zip'][0];
  const types = sheet(zip, 'types.csv');
  const market = types.find((t) => t.type_label === 'market');
  assert.equal(market.denied, 'yes');
  assert.equal(types.find((t) => t.type_label === 'rock shelter').denied, '');
  const again = await go([new File([zip], 'again.zip')], 'convert', 'plato-jsonl');
  assert.deepEqual(errors(again), []);
  const recs = outText(again.e, 'again.jsonl').trim().split('\n').slice(1).map((l) => JSON.parse(l));
  const a = recs.flatMap((x) => x.attestations || []).find((x) => x.types?.[0]?.label === 'market');
  assert.equal(a.negated, true);
});
test('a denial of several things at once is left out of the tables and of LPF, and reported', async () => {
  const d = one({ names: [{ toponym: 'Littleworth' }], types: [{ label: 'market' }], negated: true });
  const t = await go([textFile(JSON.stringify(d), 'both.json')], 'convert', 'tables');
  const zip = t.e.outs['both-tables.zip'][0];
  assert.deepEqual([sheet(zip, 'names.csv').length, sheet(zip, 'types.csv').length], [0, 0], 'neither thing is denied on its own');
  assert.ok(loss(t, 'denial-bundled'), JSON.stringify(lossKinds(t)));
  const l = await go([textFile(JSON.stringify(d), 'both.json')], 'convert', 'lpf');
  const f = JSON.parse(outText(l.e, 'both.geojson')).features[0];
  assert.deepEqual([f.names, f.types], [undefined, undefined]);
  assert.ok(loss(l, 'denial'));
  // control: two things asserted together are split into rows, as before
  const a = one({ names: [{ toponym: 'Littleworth' }], types: [{ label: 'market' }] });
  const zip2 = (await go([textFile(JSON.stringify(a), 'both.json')], 'convert', 'tables')).e.outs['both-tables.zip'][0];
  assert.deepEqual([sheet(zip2, 'names.csv').length, sheet(zip2, 'types.csv').length], [1, 1]);
});
test('tables: a mistyped denied cell is a problem, and is read as a denial, not as an assertion', async () => {
  const types = readFileSync(`${FIXTURE}/types.csv`, 'utf8').replace(',yes,', ',Yes,');
  const r = await go([...fixtureFiles().filter((f) => f.name !== 'types.csv'), textFile(types, 'types.csv')], 'convert', 'lpf');
  assert.ok(errors(r).some((e) => e.kind === 'table' && /denied/.test(e.message)), JSON.stringify(errors(r)));
  const fc = JSON.parse(outText(r.e, Object.keys(r.e.outs)[0]));
  assert.doesNotMatch(lpfFacets(fc), /"hundred"/);
});

// ---- alternative readings -----------------------------------------------------------------------
for (const target of ['lpf', 'tables']) {
  test(`alternative readings written to ${target} are reported as such`, async () => {
    const r = await go([file(JUDGEMENTS)], 'convert', target);
    const l = loss(r, 'alternative-readings');
    assert.equal(l?.count, 1, JSON.stringify(lossKinds(r)));
    assert.match(l.message, /at most one of them right/);
    assert.deepEqual(l.examples, ['https://whgazetteer.org/example/attestation/newton-b']);
    // The example's other meta-attestation is a retraction (PLATO e96d90d): LPF reports it as a
    // meta-attestation, the tables as an attestation with no row. The alternative is not counted there.
    assert.equal(loss(r, 'meta-attestation')?.count, target === 'lpf' ? 1 : undefined, 'the alternative is not also a plain meta-attestation');
  });
}
test('control: a meta-attestation of another type is reported as a meta-attestation, not as alternatives', () => {
  for (const write of [(rec, l) => recordToFeature(rec, [], l), (rec, l) => recordToRows(rec, { place: () => 'p', source: () => 's' }, l)]) {
    const kinds = [];
    write({ '@id': 'https://example.org/p', label: 'P', attestations: [{ names: [{ toponym: 'N' }], meta: { targetAttestation: 'https://example.org/a', metaType: P + 'Supports' } }] }, (l) => kinds.push(l.kind));
    assert.ok(kinds.includes('meta-attestation') && !kinds.includes('alternative-readings'), JSON.stringify(kinds));
  }
});

// ---- why a source is cited ----------------------------------------------------------------------
test('citationFunction: JSON -> RDF -> JSON keeps it, as an IRI', async () => {
  const nt = outText((await go([file(JUDGEMENTS)], 'convert', 'ntriples')).e, 'place-centric-judgements.nt');
  assert.match(nt, /<https:\/\/w3id\.org\/plato#citation_function> <http:\/\/purl\.org\/spar\/cito\/citesAsEvidence>/);
  const r = await go([textFile(nt, 'j.nt')], 'convert', 'plato-jsonl');
  const recs = outText(r.e, 'j.jsonl').trim().split('\n').slice(1).map((l) => JSON.parse(l));
  const fns = recs.flatMap((x) => (x.attestations || []).flatMap((a) => (a.citations || []).map((c) => c.citationFunction))).filter(Boolean).sort();
  assert.deepEqual(fns, [CITO + 'citesAsDataSource', ...Array(4).fill(CITO + 'citesAsEvidence')]);
});
test('citationFunction goes into LPF nowhere, and is reported; the citation itself is kept', async () => {
  const r = await go([file(JUDGEMENTS)], 'convert', 'lpf');
  assert.ok(loss(r, 'citation-function'), JSON.stringify(lossKinds(r)));
  const fc = JSON.parse(outText(r.e, 'place-centric-judgements.geojson'));
  assert.doesNotMatch(JSON.stringify(fc), /citesAs/);
  // An attestation that names its source only in a citation keeps it as an LPF citation.
  const fen = fc.features.find((f) => f['@id'].endsWith('/fenland-hundred'));
  assert.deepEqual(fen.names[0].citations, [{ label: 'André 1980, p. 12', '@id': 'https://whgazetteer.org/example/bibliography#André-1980' }]);
});
test('citation_function: tables -> JSON -> tables keeps it; one the tables cannot hold is reported', async () => {
  const names = Papa.parse(readFileSync(`${FIXTURE}/names.csv`, 'utf8'), { header: true, skipEmptyLines: true }).data;
  const ids = tableIds('https://example.org/t/', () => null);
  const a = rowToAttestation('names', names[0], ids);
  assert.equal(a.citations[0].citationFunction, CITO + 'citesAsEvidence');
  const back = recordToRows({ '@id': 'https://example.org/t/place/x', label: 'X', attestations: [a] }, { place: () => 'x', source: () => 's' });
  assert.equal(back.names[0].citation_function, 'citesAsEvidence');
  for (const bad of ['https://example.org/functions/seeFurther', CITO + 'seeFurther']) {
    const kinds = [];
    const accepts = (s, c, v) => c !== 'citation_function' || v.startsWith('cites');   // as the table definitions' list would say
    const rows = recordToRows({ '@id': 'x', label: 'X', attestations: [{ ...a, citations: [{ ...a.citations[0], citationFunction: bad }] }] }, { place: () => 'x', source: () => 's' }, (l) => kinds.push(l.kind), accepts);
    assert.equal(rows.names[0].citation_function, '', bad);
    assert.deepEqual(kinds, ['citation-function-not-cito'], bad);
  }
});

// ---- how well a form was read -------------------------------------------------------------------
test('transcription judgements: JSON -> RDF puts them on the name, and RDF -> JSON back in its qualification', async () => {
  const nt = outText((await go([file(JUDGEMENTS)], 'convert', 'ntriples')).e, 'place-centric-judgements.nt');
  const name = nt.match(/^(\S+) <https:\/\/w3id\.org\/plato#toponym> "Fenl\[and\]"/m)[1];
  assert.ok(nt.includes(`${name} <${P}transcription_accuracy> <${P}TranscriptionAccurate>`));
  assert.ok(nt.includes(`${name} <${P}transcription_completeness> <${P}TranscriptionReconstructable>`));
  const r = await go([textFile(nt, 'j.nt')], 'convert', 'plato-jsonl');
  const recs = outText(r.e, 'j.jsonl').trim().split('\n').slice(1).map((l) => JSON.parse(l));
  assert.deepEqual(recs.find((x) => x['@id']?.endsWith('/fenland-hundred')).attestations[0].names[0].qualification,
    { transcriptionAccuracy: P + 'TranscriptionAccurate', transcriptionCompleteness: P + 'TranscriptionReconstructable' });
});
test('transcription judgements go into the names sheet, and are reported where LPF or the tables have no place for them', async () => {
  const t = await go([file(JUDGEMENTS)], 'convert', 'tables');
  assert.equal(loss(t, 'transcription-judgement'), undefined);
  assert.equal(loss(t, 'qualification'), undefined);
  const fen = sheet(t.e.outs['place-centric-judgements-tables.zip'][0], 'names.csv').find((n) => n.name === 'Fenl[and]');
  assert.deepEqual([fen.transcription_accuracy, fen.transcription_completeness], ['Accurate', 'Reconstructable']);
  const l = await go([file(JUDGEMENTS)], 'convert', 'lpf');
  assert.ok(loss(l, 'transcription-judgement'), JSON.stringify(lossKinds(l)));
  assert.equal(loss(l, 'qualification'), undefined, 'reported as what it is, not as fuzziness or certainty');
  // Judged coordinates and dates have no column; a judgement not among PLATO's own has no word.
  const kinds = [];
  const rows = recordToRows({ '@id': 'x', label: 'X', attestations: [
    { geometries: [{ reprPoint: [1, 2], qualification: { transcriptionAccuracy: P + 'TranscriptionInaccurate' } }] },
    { names: [{ toponym: 'N', qualification: { transcriptionAccuracy: 'https://example.org/Misread' } }] }] }, { place: () => 'x', source: () => 's' }, (l2) => kinds.push(l2.kind));
  assert.deepEqual(kinds.filter((k) => k.startsWith('transcription')), ['transcription-judgement', 'transcription-value']);
  assert.equal(rows.names[0].transcription_accuracy, '');
});

// ---- years of more than four digits -------------------------------------------------------------
test('a deep-time year is typed as xsd:gYear in typed N-Triples, and kept by LPF both ways', async () => {
  assert.equal(boundDatatype('-12000'), 'http://www.w3.org/2001/XMLSchema#gYear');
  assert.equal(boundDatatype('120000'), 'http://www.w3.org/2001/XMLSchema#gYear');
  assert.equal(boundDatatype('-12000-01-01'), 'http://www.w3.org/2001/XMLSchema#date');
  assert.equal(boundDatatype('921'), null, 'three digits are not a year here');
  const nt = outText((await go([file(JUDGEMENTS)], 'convert', 'ntriples', { typing: true })).e, 'place-centric-judgements.nt');
  assert.match(nt, /plato#start_earliest> "-12000"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#gYear>/);
  const fc = JSON.parse(outText((await go([file(JUDGEMENTS)], 'convert', 'lpf')).e, 'place-centric-judgements.geojson'));
  const cave = fc.features.find((f) => f['@id'].endsWith('/cave-site'));
  assert.deepEqual(cave.types[0].when.timespans, [{ start: { in: '-12000' }, end: { in: '-10000' } }]);
  const back = featureToRecord(cave);
  assert.deepEqual(back.attestations.find((a) => a.types?.[0]?.label === 'rock shelter').timespans[0], { startEarliest: '-12000', startLatest: '-12000', endEarliest: '-10000', endLatest: '-10000', label: 'c. 12,000–10,000 BCE' });
  // An LPF year written as a number becomes a string, padded as before when short.
  const n = featureToRecord({ '@id': 'https://example.org/p', type: 'Feature', properties: { title: 'P' }, names: [{ toponym: 'P', when: { timespans: [{ start: { in: -12000 }, end: { in: 921 } }] } }] });
  assert.deepEqual(n.attestations[0].timespans[0], { startEarliest: '-12000', startLatest: '-12000', endEarliest: '0921', endLatest: '0921' });
  // A source dated to a deep-time year gives LPF citation its year.
  const f = recordToFeature({ '@id': 'https://example.org/p', label: 'P', attestations: [{ names: [{ toponym: 'P' }], sources: [{ title: 'S', timespan: { startEarliest: '-12000' } }] }] });
  assert.equal(f.names[0].citations[0].year, -12000);
});

// ---- the spreadsheet tables, whole ----------------------------------------------------------------
test('tables using every new column are valid, and tables -> JSON -> tables gives back every row', async () => {
  const a = await go(fixtureFiles(), 'convert', 'plato-json', { base: 'https://example.org/survey/' });
  assert.deepEqual(errors(a), []);
  const json = outText(a.e, Object.keys(a.e.outs)[0]);
  const d = JSON.parse(json);
  const atts = d.spatialEntities.flatMap((x) => x.attestations || []);
  assert.equal(atts.filter((x) => x.negated === true).length, 1);
  assert.equal(atts.filter((x) => x.negated === false).length, 1);
  assert.ok(atts.some((x) => x.timespans?.[0]?.startEarliest === '-12000'));
  assert.ok(atts.some((x) => x.names?.[0]?.qualification?.transcriptionCompleteness === P + 'TranscriptionReconstructable'));
  assert.deepEqual(atts.map((x) => x.sourceStance).filter(Boolean).sort(), [P + 'StanceDoubted', P + 'StanceReported']);
  const licensed = JSON.stringify(d).match(/"licence":"([^"]+)"/g) || [];
  assert.ok(licensed.includes('"licence":"https://creativecommons.org/publicdomain/mark/1.0/"'), 'a source keeps its licence: ' + licensed);
  // Back with the same base address, so that every place and source address is the one it was minted as.
  const b = await go([textFile(json, 'j.json')], 'convert', 'tables', { base: 'https://example.org/survey/' });
  assert.deepEqual(errors(b), []);
  const zip = b.e.outs['j-tables.zip'][0];
  const norm = (rows) => rows.map((r) => JSON.stringify(r)).sort();
  for (const s of ['names', 'types', 'relations', 'places', 'sources']) {
    const orig = Papa.parse(readFileSync(`${FIXTURE}/${s}.csv`, 'utf8'), { header: true, skipEmptyLines: true }).data;
    assert.deepEqual(norm(sheet(zip, `${s}.csv`)), norm(orig), `${s} rows differ`);
  }
  // The gazetteer is the about sheet's row, so nothing at all is reported.
  assert.deepEqual(lossKinds(b).sort(), []);
  const again = await go([new File([zip], 'again.zip')], 'check');
  assert.deepEqual(errors(again), []);
});
