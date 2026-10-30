// What the figures reader writes survives the round trip (PLATO JSON -> RDF -> PLATO JSON) with nothing
// lost and nothing added, and is stable on a second pass (convert, convert back, convert again), on the
// two shapes and on the example. The count of values compared stands beside the number that differed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { go, file, outText, textFile } from './engine.js';

const DIR = 'test/fixtures/figures';
const BASE = 'https://whgazetteer.org/example/';
const spec = (n) => JSON.parse(readFileSync(`${DIR}/${n}`, 'utf8'));
const LONG = { columns: { Id: 'id', Place: 'name', Year: 'period', Occupation: { field: 'dimension', dimension: 'occupation' }, Persons: { field: 'value', measure: 'persons' } },
  table: { id: 'occupations', title: 'Occupations', source: 'A census (constructed)', dimensions: { occupation: { total: 'All' } } } };
const CASES = [
  ['example-statistics.csv', spec('example-statistics.columns.json')],
  ['long-shape.csv', LONG],
  ['wide-shape.csv', { columns: { Id: 'id', Place: 'name', Year: 'period', Farmers: { field: 'figure', coordinates: { occupation: 'Farmers' }, measure: 'persons' }, Miners: { field: 'figure', coordinates: { occupation: 'Miners' }, measure: 'persons' },
    All: { field: 'figure', coordinates: { occupation: 'All' }, measure: 'persons', totalOf: ['Farmers', 'Miners'] } }, table: { id: 'occupations', title: 'Occupations' } }],
  ['two-measures.csv', { columns: { Id: 'id', Place: 'name', Year: 'period', Persons: { field: 'value', measure: 'persons' }, Houses: { field: 'value', measure: 'houses' } }, table: { title: 'Returns' } }],
  ['dashes-and-blanks.csv', { columns: { Id: 'id', Place: 'name', Year: 'period', Class: { field: 'dimension', dimension: 'class' }, Persons: { field: 'value', measure: 'persons' } } }],
];
const losses = (r) => r.report.items.filter((i) => ['error', 'loss'].includes(i.severity) && !i.kind.startsWith('figures-'));
const figuresOf = (d) => d.spatialEntities.flatMap((e) => (e.attestations || []).flatMap((a) => a.properties || []));
const plain = (d) => JSON.stringify(d, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
const sortedFigures = (d) => figuresOf(d).map(plain).sort();
const lines = (nt) => nt.split('\n').filter(Boolean).sort();

for (const [name, columns] of CASES) {
  test(`${name}: JSON -> RDF -> JSON loses nothing and adds nothing, and a second pass is the same`, async () => {
    const stem = name.replace('.csv', '');
    const made = await go([file(`${DIR}/${name}`)], 'convert', 'plato-json', { columns, base: BASE });
    const json = outText(made.e, `${stem}.json`);
    const doc = JSON.parse(json);
    // JSON -> RDF
    const a = await go([textFile(json, `${stem}.json`)], 'convert', 'ntriples');
    assert.deepEqual(losses(a), [], 'nothing is reported lost going to RDF');
    const nt = outText(a.e, `${stem}.nt`);
    // RDF -> JSON
    const b = await go([textFile(nt, `${stem}.nt`)], 'convert', 'plato-json');
    assert.deepEqual(losses(b), [], 'nor coming back');
    assert.deepEqual(b.report.items.filter((i) => i.severity === 'warning'), []);
    const back = JSON.parse(outText(b.e, `${stem}.json`));
    // The figures: every one back, each equal to what was written. The count compared is stated beside the number that differed.
    const want = sortedFigures(doc), got = sortedFigures(back);
    const differing = want.filter((f, i) => f !== got[i]).length;
    assert.ok(want.length >= 2, 'there are figures to compare');
    assert.deepEqual([got.length, differing], [want.length, 0], `${want.length} figures compared`);
    assert.deepEqual(back.dataSets.map(plain).sort(), doc.dataSets.map(plain).sort());
    assert.deepEqual(back.spatialEntities.map((e) => e['@id']).sort(), doc.spatialEntities.map((e) => e['@id']).sort());
    // Stable: the JSON that came back, converted again, gives the same RDF line for line.
    const c = await go([textFile(JSON.stringify(back), `${stem}.json`)], 'convert', 'ntriples');
    assert.deepEqual(lines(outText(c.e, `${stem}.nt`)), lines(nt));
    assert.ok(lines(nt).length > 30);
  });
}
test('control: the comparison of figures notices a value changed on the way', async () => {
  const made = await go([file(`${DIR}/long-shape.csv`)], 'convert', 'plato-json', { columns: LONG, base: BASE });
  const doc = JSON.parse(outText(made.e, 'long-shape.json'));
  const altered = structuredClone(doc);
  figuresOf(altered).find((f) => f.value === 300).value = 301;
  assert.notDeepEqual(sortedFigures(altered), sortedFigures(doc));
  assert.equal(sortedFigures(altered).filter((f, i) => f !== sortedFigures(doc)[i]).length, 1);
});
