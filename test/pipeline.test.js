import { PLATO_REPO, DEEP_EXPORT } from './paths.js';
// The engine end to end in Node, over every input format, with an in-memory database and outputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import * as XLSX from 'xlsx';
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate';
import jsonld from 'jsonld';
import { loadResources } from '../src/engine/resources.js';
import { prepare, run } from '../src/engine/pipeline.js';
import { detect } from '../src/engine/input.js';
import { openSqlite } from '../src/lib/store.js';

const res = prepare(await loadResources(async (f) => readFileSync(`public/plato/${f}`, 'utf8')));
const file = (path, name) => new File([readFileSync(path)], name || path.split('/').pop());
const textFile = (text, name) => new File([text], name);
function env() {
  const outs = {};
  return {
    outs, resources: res, csvMeta: res.csvMeta, xlsx: XLSX,
    openDb: () => openSqlite(sqlite3InitModule, { memory: true }),
    output: async (name) => { const parts = []; return { write: (s) => parts.push(s), writeBytes: (b) => parts.push(b), close: async () => { outs[name] = parts; const size = parts.reduce((n, p) => n + p.length, 0); return { name, size }; } }; },
  };
}
const outText = (e, name) => e.outs[name].join('');
async function go(files, action, target, options = {}) {
  const e = env(); const input = await detect(files);
  assert.ok(input.format, `not detected: ${input.reason}`);
  const r = await run({ input, action, target, options }, e);
  return { ...r, e, input };
}
const errors = (r) => r.report.items.filter((i) => i.severity === 'error');
const canon = (nt) => jsonld.canonize([...new Set(nt.split('\n').filter(Boolean))].join('\n') + '\n', { algorithm: 'URDNA2015', inputFormat: 'application/n-quads', format: 'application/n-quads', safe: false });
const EX = `${PLATO_REPO}/schemas/examples`;

test('place-centric JSON -> N-Triples: exactly the graph jsonld.js gives', async () => {
  const doc = JSON.parse(readFileSync(`${EX}/place-centric-constantinople.json`, 'utf8'));
  const r = await go([file(`${EX}/place-centric-constantinople.json`)], 'convert', 'ntriples');
  assert.deepEqual(errors(r), []);
  const ref = await jsonld.toRDF({ ...doc, '@context': res.context['@context'] }, { format: 'application/n-quads', safe: false });
  assert.equal(await canon(outText(r.e, 'place-centric-constantinople.nt')), await canon(ref));
});

for (const f of readdirSync(EX).filter((f) => f.startsWith('attestation-centric'))) {
  test(`attestation-centric JSON -> JSON Lines (regrouped through the store) is valid: ${f}`, async () => {
    const r = await go([file(`${EX}/${f}`)], 'convert', 'plato-jsonl');
    assert.deepEqual(errors(r), []);
    const lines = outText(r.e, f.replace(/\.json$/, '.jsonl')).trim().split('\n').map((l) => JSON.parse(l));
    const doc = JSON.parse(readFileSync(`${EX}/${f}`, 'utf8'));
    const atts = lines.slice(1).filter((l) => l.attestations).reduce((n, l) => n + l.attestations.length, 0);
    assert.equal(atts, doc.attestations.length);
    const v = res.validators['place-centric'];
    for (const l of lines.slice(1)) assert.ok(l.subject ? v.identity(l) : v.entity(l), JSON.stringify((v.entity.errors || v.identity.errors || []).slice(0, 2)));
  });
}

const tablesDir = (ex) => readdirSync(`${PLATO_REPO}/schemas/tables/examples/${ex}`).map((f) => file(`${PLATO_REPO}/schemas/tables/examples/${ex}/${f}`));
test('tables (customs, eight CSV files) -> JSON Lines: valid, no errors', async () => {
  const r = await go(tablesDir('customs'), 'convert', 'plato-jsonl', { base: 'https://example.org/customs/' });
  assert.equal(r.input.format, 'tables');
  assert.deepEqual(errors(r), []);
  assert.equal(r.report.counts.places, 2);
});
test('tables (survey) -> JSON: the two things the tables allow and PLATO JSON does not are reported', async () => {
  // The tables allow a type with only a label, and a place with no evidence rows (Buckinghamshire
  // is only the target of a relation); the JSON Schema requires a type identifier, and at least
  // one attestation per place. Both are reported, and nothing else.
  const r = await go(tablesDir('survey'), 'check');
  const e = errors(r).map((x) => x.examples[0]).sort();
  assert.equal(e.length, 2, JSON.stringify(e));
  assert.match(e[0], /buckinghamshire: \/attestations must NOT have fewer than 1 items/);
  assert.match(e[1], /bunsty: .*types\/0 must have required property 'identifier'/);
  const msgs = errors(r).map((x) => x.message).sort();
  assert.match(msgs[0], /^A place has no evidence about it.*names, locations, types, relations or properties/);
  assert.match(msgs[1], /^A type has no identifier.*fill in type_uri/);
});
test('tables -> tables round trip through a zip, and the zip is accepted again', async () => {
  const r = await go(tablesDir('customs'), 'convert', 'tables', { base: 'https://example.org/customs/' });
  const zipName = Object.keys(r.e.outs)[0];
  const bytes = r.e.outs[zipName][0];
  const z = unzipSync(bytes);
  assert.deepEqual(Object.keys(z).sort(), ['identities.csv', 'locations.csv', 'names.csv', 'places.csv', 'properties.csv', 'relations.csv', 'sources.csv', 'types.csv']);
  assert.match(strFromU8(z['names.csv']), /Bristowe/);
  const again = await go([new File([bytes], 'again.zip')], 'check');
  assert.deepEqual(errors(again), []);
  assert.equal(again.report.counts.places, 2);
});
test('tables from a workbook (.xlsx) are read like CSV files', async () => {
  const wb = XLSX.utils.book_new();
  for (const f of tablesDir('customs')) XLSX.utils.book_append_sheet(wb, XLSX.read(readFileSync(`${PLATO_REPO}/schemas/tables/examples/customs/${f.name}`, 'utf8'), { type: 'string', raw: true }).Sheets.Sheet1, f.name.replace('.csv', ''));
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const r = await go([new File([bytes], 'customs.xlsx')], 'check');
  assert.deepEqual(errors(r), []);
  assert.equal(r.report.counts.places, 2);
});
test('LPF README example -> PLATO JSON (valid, losses reported) -> LPF', async () => {
  const r = await go([file('test/fixtures/lpf-readme-example.json', 'abingdon.geojson')], 'convert', 'plato-json');
  assert.deepEqual(errors(r), []);
  assert.ok(r.report.items.some((i) => i.kind === 'lpf-duration'));
  const doc = JSON.parse(outText(r.e, 'abingdon.json'));
  assert.equal(doc.spatialEntities.length, 1);
  const back = await go([textFile(JSON.stringify(doc), 'abingdon.json')], 'convert', 'lpf');
  const fc = JSON.parse(outText(back.e, 'abingdon.geojson'));
  assert.equal(fc.features[0].names.length, 2);
  assert.equal(fc.features[0].links.length, 6);
});
test('N-Triples written by the tool read back to the same places', async () => {
  const a = await go([file(`${EX}/place-centric-constantinople.json`)], 'convert', 'ntriples');
  const nt = outText(a.e, 'place-centric-constantinople.nt');
  const b = await go([textFile(nt, 'c.nt')], 'convert', 'plato-jsonl');
  assert.deepEqual(errors(b), []);
  const recs = outText(b.e, 'c.jsonl').trim().split('\n').slice(1).map((l) => JSON.parse(l));
  const orig = JSON.parse(readFileSync(`${EX}/place-centric-constantinople.json`, 'utf8')).spatialEntities;
  assert.equal(recs.length, orig.length);
  assert.equal(recs[0].attestations.length, orig[0].attestations.length);
  const c = await go([textFile(outText(b.e, 'c.jsonl'), 'c.jsonl')], 'convert', 'ntriples');
  assert.equal(await canon(outText(c.e, 'c.nt')), await canon(nt));
});
test('Turtle examples from the PLATO repository -> JSON Lines', async () => {
  const r = await go([file(`${PLATO_REPO}/examples/survey-attestations.ttl`)], 'convert', 'plato-jsonl');
  assert.deepEqual(errors(r).filter((e) => e.kind !== 'schema'), []);
  const ttl = readFileSync(`${PLATO_REPO}/examples/survey-attestations.ttl`, 'utf8');
  const expected = (ttl.match(/\ba plato:Attestation\b/g) || []).length;
  assert.ok(expected > 0);
  assert.equal(r.report.counts.attestations, expected, JSON.stringify(r.report.counts));
});

// Controls: each broken input must be reported, with where.
test('control: a JSON Lines place without a label is a schema error, with its line', async () => {
  const good = readFileSync(`${EX}/place-centric-constantinople.json`, 'utf8');
  const d = JSON.parse(good); const head = { ...d }; delete head.spatialEntities;
  const rec = structuredClone(d.spatialEntities[0]); delete rec.label;
  const r = await go([textFile(JSON.stringify(head) + '\n' + JSON.stringify(rec) + '\n', 'bad.jsonl')], 'check');
  assert.ok(errors(r).some((e) => e.kind === 'schema' && /label/.test(e.examples[0])), JSON.stringify(errors(r)));
});
test('control: a broken N-Triples line is reported with its line number', async () => {
  const nt = '<https://x.org/a> <https://w3id.org/plato#notes> "fine" .\n<https://x.org/a> <https://w3id.org/plato#notes "broken .\n';
  const r = await go([textFile(nt, 'bad.nt')], 'check');
  assert.ok(errors(r).some((e) => e.kind === 'rdf-syntax' && /line 2/.test(e.examples[0])), JSON.stringify(errors(r)));
});
test('control: an undeclared PLATO term in RDF is reported', async () => {
  const nt = '<https://x.org/a> <https://w3id.org/plato#no_such_term> "x" .\n';
  const r = await go([textFile(nt, 'bad.nt')], 'check');
  assert.ok(errors(r).some((e) => e.kind === 'undeclared-term'));
});
test('control: tables with an unknown place_id are rejected', async () => {
  const files = tablesDir('customs').map((f) => f);
  const names = readFileSync(`${PLATO_REPO}/schemas/tables/examples/customs/names.csv`, 'utf8').replace('\nbristol,', '\nnowhere,');
  const r = await go([...files.filter((f) => f.name !== 'names.csv'), textFile(names, 'names.csv')], 'check');
  assert.ok(errors(r).some((e) => e.kind === 'table' && /nowhere/.test(e.examples[0])), JSON.stringify(errors(r)));
});
