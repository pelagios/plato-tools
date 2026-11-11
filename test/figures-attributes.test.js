import { PLATO_REPO } from './paths.js';
// The figures reader's `attribute` column role (decision of 11 November 2026): a flag or other fact about the
// figures of a row, one value or several for one attribute, from repeated columns or from a separator in a
// cell. Values are codes the table's description declares, never made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { go, textFile, outText } from './engine.js';

const BASE = 'https://whgazetteer.org/example/';
const SA = 'http://purl.org/linked-data/sdmx/2009/attribute#', SC = 'http://purl.org/linked-data/sdmx/2009/code#';
const FLAG = 'https://example.org/attr/flag', E = 'https://example.org/flag/e', P = 'https://example.org/flag/p', Q = 'https://example.org/flag/q';
const figuresOf = (d) => d.spatialEntities.flatMap((e) => (e.attestations || []).flatMap((a) => a.properties || []));
const TABLE = { dimensions: { sex: { codes: {} } }, attributes: { flag: { iri: FLAG, codes: { e: E, p: P, q: Q } } } };
const columns = (extra, table = TABLE) => ({ columns: { Place: 'name', Year: 'period', Sex: { field: 'dimension', dimension: 'sex' }, N: { field: 'value', measure: 'n' }, ...extra }, table });
async function read(text, cols) {
  const r = await go([textFile(text, 't.csv')], 'convert', 'plato-json', { columns: cols, base: BASE });
  return { r, doc: JSON.parse(outText(r.e, 't.json')) };
}
const unmapped = (r) => r.report.items.filter((i) => i.kind === 'figures-attribute-value');

test('repeated columns of one attribute give a list; one value stays a scalar; none gives no key', async () => {
  const { r, doc } = await read('Place,Year,Sex,N,F1,F2\nA,1851,M,1,e,p\nA,1851,F,2,q,\nA,1851,T,3,,\n', columns({ F1: { field: 'attribute', attribute: 'flag' }, F2: { field: 'attribute', attribute: 'flag' } }));
  assert.equal(r.report.errors, 0);
  const f = figuresOf(doc);
  assert.deepEqual(f[0].attributes, { [FLAG]: [{ '@id': E }, { '@id': P }] });
  assert.deepEqual(f[1].attributes, { [FLAG]: { '@id': Q } });
  assert.equal(f[2].attributes, undefined);
  assert.equal(unmapped(r).length, 0);
});
test('a separator in one cell gives the same list, whatever the order written; blanks between are ignored', async () => {
  const { doc } = await read('Place,Year,Sex,N,F\nA,1851,M,1,p ; e\nA,1851,F,2,e;;\n', columns({ F: { field: 'attribute', attribute: 'flag', separator: ';' } }));
  const f = figuresOf(doc);
  assert.deepEqual(f[0].attributes, { [FLAG]: [{ '@id': E }, { '@id': P }] });
  assert.deepEqual(f[1].attributes, { [FLAG]: { '@id': E } });
});
test('both ways at once, and a value written twice, are one list without repeats', async () => {
  const { doc } = await read('Place,Year,Sex,N,F1,F2\nA,1851,M,1,e;p,p\n', columns({ F1: { field: 'attribute', attribute: 'flag', separator: ';' }, F2: { field: 'attribute', attribute: 'flag' } }));
  assert.deepEqual(figuresOf(doc)[0].attributes, { [FLAG]: [{ '@id': E }, { '@id': P }] });
});
test('a value with no declared code is reported and left out, never made up; the figure is still read', async () => {
  const { r, doc } = await read('Place,Year,Sex,N,F\nA,1851,M,1,e;zz\n', columns({ F: { field: 'attribute', attribute: 'flag', separator: ';' } }));
  assert.deepEqual(figuresOf(doc)[0].attributes, { [FLAG]: { '@id': E } });
  assert.equal(unmapped(r).length, 1); assert.match(unmapped(r)[0].examples[0], /"zz"/);
  assert.equal(unmapped(r)[0].severity, 'loss');
  // control: with no code at all the figure has no attribute, and every value is reported
  const none = await read('Place,Year,Sex,N,F\nA,1851,M,1,e\n', columns({ F: { field: 'attribute', attribute: 'flag' } }, { dimensions: {} }));
  assert.equal(figuresOf(none.doc)[0].attributes, undefined); assert.equal(unmapped(none.r).length, 1);
});
test('a printed dash and flags on one obsStatus: the dash\'s code and the flags\' codes, once each', async () => {
  const T = { attributes: { status: { iri: SA + 'obsStatus', codes: { E: SC + 'obsStatus-E' } } } };
  const { doc } = await read('Place,Year,Sex,N,S\nA,1851,M,—,E\nA,1851,F,—,\nA,1851,T,5,E\n', columns({ S: { field: 'attribute', attribute: 'status' } }, T));
  const f = figuresOf(doc);
  const dash = `${BASE}code/obs-status/nil-or-not-applicable`;
  assert.deepEqual(f[0].attributes, { [SA + 'obsStatus']: [{ '@id': SC + 'obsStatus-E' }, { '@id': dash }].sort((a, b) => (a['@id'] < b['@id'] ? -1 : 1)) });
  assert.deepEqual(f[1].attributes, { [SA + 'obsStatus']: { '@id': dash } });
  assert.deepEqual(f[2].attributes, { [SA + 'obsStatus']: { '@id': SC + 'obsStatus-E' } });
});
test('flags do not change a figure\'s address, and cells are counted as before', async () => {
  const cols = { F: { field: 'attribute', attribute: 'flag' } };
  const a = await read('Place,Year,Sex,N,F\nA,1851,M,1,e\nA,1851,F,2,\n', columns(cols));
  const b = await read('Place,Year,Sex,N\nA,1851,M,1\nA,1851,F,2\n', columns({}));
  assert.deepEqual(figuresOf(a.doc).map((f) => f['@id']), figuresOf(b.doc).map((f) => f['@id']));
  assert.deepEqual([a.r.report.counts?.['figure cells'], a.r.report.counts?.figures], [b.r.report.counts?.['figure cells'], b.r.report.counts?.figures]);
});
test('an attribute outside SDMX is declared in the structure, so the figures read back with it under attributes', async () => {
  const { doc } = await read('Place,Year,Sex,N,F\nA,1851,M,1,e;p\n', columns({ F: { field: 'attribute', attribute: 'flag', separator: ';' } }));
  assert.ok(doc.dataSets[0].structure.components.some((c) => c.attribute === FLAG));
  const nt = await go([textFile(JSON.stringify(doc), 'd.json')], 'convert', 'ntriples');
  const back = await go([textFile(outText(nt.e, 'd.nt'), 'b.nt')], 'convert', 'plato-json');
  assert.deepEqual(figuresOf(JSON.parse(outText(back.e, 'b.json')))[0].attributes, { [FLAG]: [{ '@id': E }, { '@id': P }] });
  assert.equal(back.report.items.filter((i) => i.kind === 'figure-undeclared' || i.kind === 'multiple-values').length, 0);
});
test('a mapping that cannot be used is kept in the notes, with the reason', async () => {
  for (const bad of [{ field: 'attribute' }, { field: 'attribute', attribute: 'flag', separator: '' }, { field: 'value', measure: 'n', attribute: 'flag' }]) {
    const { r } = await read('Place,Year,Sex,N,F\nA,1851,M,1,e\n', columns({ F: bad }));
    assert.ok(r.report.items.some((i) => i.kind === 'generic-mapping'), JSON.stringify(bad));
  }
});
