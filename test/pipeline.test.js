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
  const recs = outText(r.e, Object.keys(r.e.outs)[0]).trim().split('\n').slice(1).map((l) => JSON.parse(l));
  assert.deepEqual(recs.map((x) => x.ccodes), [['GB'], ['GB']]);
  assert.ok(!r.report.items.some((i) => i.severity === 'loss'), 'country codes are no longer a loss');
});
test('tables (survey) -> JSON: a label-only type and a place with no evidence are valid PLATO', async () => {
  // PLATO 0.4.0 plus the resolutions of ee80543: a type needs only a label, and a place may have
  // no attestations (Buckinghamshire is only the target of a relation). Nothing is reported.
  const r = await go(tablesDir('survey'), 'check');
  assert.deepEqual(errors(r), []);
  assert.equal(r.report.counts.places, 3);
});
test('control: an identity row without a match type is rejected, now that the tables require one', async () => {
  const ids = readFileSync(`${PLATO_REPO}/schemas/tables/examples/customs/identities.csv`, 'utf8').replace(',exactMatch,', ',,');
  const r = await go([...tablesDir('customs').filter((f) => f.name !== 'identities.csv'), textFile(ids, 'identities.csv')], 'check');
  assert.ok(errors(r).some((e) => e.kind === 'table' && /match_type/.test(e.message)), JSON.stringify(errors(r)));
});
test('tables -> tables round trip through a zip, and the zip is accepted again', async () => {
  const r = await go(tablesDir('customs'), 'convert', 'tables', { base: 'https://example.org/customs/' });
  const zipName = Object.keys(r.e.outs)[0];
  const bytes = r.e.outs[zipName][0];
  const z = unzipSync(bytes);
  assert.deepEqual(Object.keys(z).sort(), ['identities.csv', 'locations.csv', 'names.csv', 'places.csv', 'properties.csv', 'relations.csv', 'sources.csv', 'types.csv']);
  assert.match(strFromU8(z['names.csv']), /Bristowe/);
  assert.match(strFromU8(z['places.csv']), /\nbristol,Bristol,GB\n/);
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
  assert.equal(await canon(outText(c.e, 'c.nt')), await canon(nt));   // no shared blank-node children here, so even isomorphic
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

test('tables -> JSON Lines: place_id is kept as entityIdentifier, the date as sourceLabel, and both are valid', async () => {
  const r = await go(tablesDir('survey'), 'convert', 'plato-jsonl', { base: 'https://example.org/survey/' });
  assert.deepEqual(errors(r), []);
  const lines = outText(r.e, Object.keys(r.e.outs)[0]).trim().split('\n').map((l) => JSON.parse(l)).slice(1).filter((l) => l.label);
  assert.deepEqual(lines.map((l) => l.entityIdentifier).sort(), ['buckinghamshire', 'bunsty', 'cambridge']);
  for (const l of lines) assert.equal(l['@id'], `https://example.org/survey/place/${l.entityIdentifier}`);
  const spans = lines.flatMap((l) => (l.attestations || []).flatMap((a) => a.timespans || []));
  assert.ok(spans.length && spans.every((t) => t.sourceLabel && !t.label), JSON.stringify(spans.slice(0, 2)));
});

// A citation's source may be a URI or an object (a oneOf): the report must name what is wrong
// with the object, not complain that it is not a string.
const citing = (source) => JSON.stringify({ profile: 'attestation-centric', gazetteer: { title: 't' },
  attestations: [{ about: 'https://example.org/p', names: [{ toponym: 'N' }], citations: [{ source }] }] });
test('a source object without a title is reported as a missing title, not as "must be string"', async () => {
  const r = await go([textFile(citing({ authorityType: 'source', citation: 'Domesday Book' }), 'no-title.json')], 'check');
  const msgs = errors(r).map((i) => i.message);
  assert.ok(msgs.some((m) => /source has no title/.test(m)), JSON.stringify(msgs));
  assert.ok(!msgs.some((m) => /must be string/.test(m)), JSON.stringify(msgs));
});
test('control: a source that is a malformed address is reported as one', async () => {
  const r = await go([textFile(citing('not a web address'), 'bad-uri.json')], 'check');
  assert.ok(errors(r).some((i) => /full web address/.test(i.message)), JSON.stringify(errors(r).map((i) => i.message)));
});

// PLATO eb8065a: nested under its place, an identity relation may leave out its subject.
const withIdr = (ir) => JSON.stringify({ profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' },
  spatialEntities: [{ '@id': 'https://example.org/p/1', label: 'P', attestations: [{ names: [{ toponym: 'P' }], sources: [{ title: 's' }] }],
    identityRelations: [{ object: 'https://sws.geonames.org/745044/', identityType: 'closeMatch', ...ir }] }] });
test('a nested identity relation without a subject is valid, and reaches the tables with its place', async () => {
  const r = await go([textFile(withIdr({}), 'nested.json')], 'convert', 'tables');
  assert.deepEqual(errors(r), []);
  const zipName = Object.keys(r.e.outs).find((n) => n.endsWith('.zip'));
  const files = unzipSync(new Uint8Array(await new Blob(r.e.outs[zipName]).arrayBuffer()));
  const idRows = strFromU8(files['identities.csv']).trim().split(/\r?\n/);
  assert.equal(idRows.length, 2, idRows.join(' / '));
  const placeRows = strFromU8(files['places.csv']).trim().split(/\r?\n/).slice(1);
  assert.deepEqual(placeRows, ['1,P,'], 'only the one place, not a phantom place with no label');
  assert.equal(idRows[1].split(',')[0], '1', 'the identity row names the place it was nested under');
});
test('control: a nested identity relation whose subject is another place is an error', async () => {
  const r = await go([textFile(withIdr({ subject: 'https://example.org/p/2' }), 'mismatch.json')], 'check');
  assert.ok(errors(r).some((i) => i.kind === 'identity-subject-mismatch'), JSON.stringify(errors(r)));
  const ok = await go([textFile(withIdr({ subject: 'https://example.org/p/1' }), 'same.json')], 'check');
  assert.deepEqual(errors(ok), [], 'repeating its own place is fine');
});

// A JSON document is parsed as a stream, and a stream that stops early looks like one that ended.
test('control: a JSON document cut short is not passed as clean', async () => {
  const whole = readFileSync(`${EX}/place-centric-constantinople.json`, 'utf8');
  const ok = await go([textFile(whole, 'whole.json')], 'check');
  assert.deepEqual(errors(ok), [], 'the whole document is clean');
  await assert.rejects(go([textFile(whole.slice(0, 1500), 'cut.json')], 'check'), /stops before it is complete/);
});
