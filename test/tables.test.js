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

for (const ex of readdirSync(EX)) {
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
for (const [name, make] of Object.entries(controls)) {
  test(`broken tables are rejected: ${name}`, async () => {
    const issues = await validate(make());
    assert.ok(issues.length >= 1, 'expected at least one issue');
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
  assert.equal(witness.derivedFrom, 'https://example.org/survey/source/asc-annal-921');
  assert.deepEqual(witness.timespan, { label: 'c. 925', startEarliest: '0915', endLatest: '0935' });
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
  const norm = (rows) => rows.map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)])))).sort();
  for (const sheet of ['names', 'types', 'relations']) {
    const orig = parse(sheet).map((r) => ({ ...r, certainty: r.certainty === '' ? '' : String(Number(r.certainty)) }));
    assert.deepEqual(norm(back[sheet]), norm(orig), `${sheet} rows differ`);
  }
  assert.deepEqual(losses, []);
});
