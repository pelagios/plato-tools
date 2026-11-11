import { PLATO_REPO } from './paths.js';
// The figures reader (src/engine/hermes/figures.js): a census or return table, long or wide, read
// as PLATO statistical figures. The oracle is PLATO's own statistics example; the other tests are of
// what the reader promises and what it reports (decisions of 30 October 2026, plan #34 item 11).
// Each test that finds nothing has its control beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { go, file, outText, textFile } from './engine.js';
import { integrity } from './datacube.js';
import { conservation } from '../src/engine/hermes/figures-text.js';
import { figureCell, parsePeriod } from '../src/engine/hermes/figures.js';

const DIR = 'test/fixtures/figures';
const BASE = 'https://whgazetteer.org/example/';
const STATS = `${PLATO_REPO}/schemas/examples/place-centric-statistics.json`;
const csv = (name) => file(`${DIR}/${name}`);
const spec = (name) => JSON.parse(readFileSync(`${DIR}/${name}`, 'utf8'));
const kinds = (r, severity) => r.report.items.filter((i) => !severity || i.severity === severity).map((i) => i.kind);
const item = (r, kind) => r.report.items.find((i) => i.kind === kind);
const figuresOf = (d) => d.spatialEntities.flatMap((e) => (e.attestations || []).flatMap((a) => a.properties || []));
/** A table read and converted to PLATO JSON: { r, doc } */
async function read(f, columns, options = {}) {
  const r = await go([f], 'convert', 'plato-json', { columns, base: BASE, ...options });
  const name = f.name.replace(/\.[^.]+$/, '.json');
  return { r, doc: r.e.outs[name] ? JSON.parse(outText(r.e, name)) : null };
}
const last = (iri) => iri.split(/[/#]/).pop();
/** What the cell counts say, as the identity cells = figures + dashes + blanks + left out. */
const conserved = (c) => c['figure cells'] === c.figures + c['declared absences'] + c['blank cells'] + c['cells left out'];

// ---- the oracle: PLATO's own example -----------------------------------------------------------------
const EXAMPLE = existsSync(STATS) ? JSON.parse(readFileSync(STATS, 'utf8')) : null;
/** The differences between a document and PLATO's example, modulo the addresses of the figures themselves (they are hashes here). */
function differences(doc) {
  const out = [];
  const want = EXAMPLE.spatialEntities[0].attestations[0].properties;
  const got = figuresOf(doc);
  // Each figure is told by its coordinates: occupation code, sex code.
  const key = (f) => [f.dimensions[`${BASE}dim/occupation`]?.['@id'], f.dimensions['http://purl.org/linked-data/sdmx/2009/dimension#sex']?.['@id']].join('|');
  const byKey = new Map(got.map((f) => [key(f), f]));
  const ids = new Map(got.map((f) => [f['@id'], key(f)]));
  const wantIds = new Map(want.map((f) => [f['@id'], key(f)]));
  if (got.length !== want.length) out.push(`${got.length} figures, ${want.length} wanted`);
  for (const w of want) {
    const g = byKey.get(key(w));
    if (!g) { out.push(`no figure for ${key(w)}`); continue; }
    for (const k of ['property', 'label', 'value', 'sourceLabel', 'attributes']) {
      // A figure in the example may carry several values for an attribute (obsStatus-E and -P, PLATO 0cd9af7): the
      // table has no column for that, so they are not asked of the reader.
      const wk = k === 'attributes' && w.attributes ? Object.fromEntries(Object.entries(w.attributes).filter(([, v]) => !Array.isArray(v))) : w[k];
      if (JSON.stringify(g[k]) !== JSON.stringify(k === 'attributes' && !Object.keys(wk || {}).length ? undefined : wk)) out.push(`${key(w)}: ${k} is ${JSON.stringify(g[k])}, wanted ${JSON.stringify(w[k])}`);
    }
    if (g.dataSet !== doc.dataSets?.[0]?.['@id']) out.push(`${key(w)}: dataSet ${g.dataSet}`);
    if (JSON.stringify(g.dimensions) !== JSON.stringify(w.dimensions)) out.push(`${key(w)}: dimensions ${JSON.stringify(g.dimensions)}`);
    if ((g.universe ? ids.get(g.universe) : undefined) !== (w.universe ? wantIds.get(w.universe) : undefined)) out.push(`${key(w)}: universe ${ids.get(g.universe)}, wanted ${wantIds.get(w.universe)}`);
  }
  const wantSet = EXAMPLE.dataSets[0], gotSet = doc.dataSets?.[0];
  if (doc.dataSets?.length !== 1) out.push(`${doc.dataSets?.length} data sets`);
  else {
    for (const k of ['title', 'description']) if (gotSet[k] !== wantSet[k]) out.push(`data set ${k}: ${gotSet[k]}`);
    // The structure: the same components in the same order (the addresses are the example's, the base being the same).
    if (JSON.stringify(gotSet.structure.components) !== JSON.stringify(wantSet.structure.components)) out.push(`structure ${JSON.stringify(gotSet.structure.components)}`);
    if (gotSet.isPartOf !== doc.spatialEntities[0].attestations[0].citations[0].source['@id']) out.push('the data set is not part of the source the figures cite');
  }
  const ts = doc.spatialEntities[0].attestations.flatMap((a) => a.timespans || []);
  if (!ts.length || !ts.every((t) => JSON.stringify(t) === JSON.stringify(EXAMPLE.spatialEntities[0].attestations[0].timespans[0]))) out.push(`timespans ${JSON.stringify(ts)}`);
  return out;
}
test('PLATO\'s statistics example is there to test against', () => {
  assert.ok(EXAMPLE, `${STATS} not found: set PLATO_REPO to a checkout of PLATO at the pinned commit`);
});
test('the oracle: the example as a table, read with its description, gives the example\'s figures, structure and universes', async () => {
  const { r, doc } = await read(csv('example-statistics.csv'), spec('example-statistics.columns.json'));
  assert.equal(r.report.errors, 0);
  assert.deepEqual(differences(doc), []);
  // Not only the same shape: the same addresses where the example fixes them by hand.
  const f = figuresOf(doc);
  assert.ok(f.every((x) => x.property === `${BASE}measure/persons`));
  assert.deepEqual([...new Set(f.map((x) => x.dimensions[`${BASE}dim/occupation`]['@id']))].sort(), [`${BASE}code/occupation/agricultural-labourer`, `${BASE}code/occupation/all`, `${BASE}code/occupation/miner`]);
  // The dash is a figure with a status and no value, never a 0.
  const dash = f.find((x) => x.sourceLabel === '—');
  assert.equal(dash.value, undefined); assert.deepEqual(dash.attributes, { 'http://purl.org/linked-data/sdmx/2009/attribute#obsStatus': { '@id': `${BASE}code/obs-status/nil-or-not-applicable` } });
  // What it says aloud: the names are the place's key; the miner's total is nowhere in the table.
  assert.deepEqual(kinds(r, 'warning').sort(), ['figures-names-as-keys', 'figures-total-missing']);
  assert.deepEqual(kinds(r, 'loss'), []);
  assert.deepEqual(conserved(r.report.counts), true);
  assert.deepEqual([r.report.counts['figure cells'], r.report.counts.figures, r.report.counts['declared absences']], [5, 4, 1]);
});
test('control: the comparison with the example notices a total left unmarked, a figure lost and a period changed', async () => {
  const noTotals = spec('example-statistics.columns.json');
  delete noTotals.table.dimensions.occupation.total; delete noTotals.table.dimensions.sex.total;
  const a = await read(csv('example-statistics.csv'), noTotals);
  assert.ok(differences(a.doc).some((d) => /universe/.test(d)), differences(a.doc).join('; '));
  assert.equal(figuresOf(a.doc).filter((x) => x.universe).length, 0, 'nothing is linked unmarked');
  const noSex = spec('example-statistics.columns.json');
  noSex.columns.Sex = 'note';
  const b = await read(csv('example-statistics.csv'), noSex);
  assert.notDeepEqual(differences(b.doc), []);
  const changed = await read(csv('example-statistics.csv'), { ...spec('example-statistics.columns.json'), columns: { ...spec('example-statistics.columns.json').columns, Year: 'note' } });
  assert.ok(differences(changed.doc).some((d) => /timespans/.test(d)));
});
test('the example\'s cube, from the table, passes the five checks over what they evaluate', async () => {
  const r = await go([csv('example-statistics.csv')], 'convert', 'ntriples', { columns: spec('example-statistics.columns.json'), base: BASE, cube: true });
  assert.deepEqual(integrity(outText(r.e, 'example-statistics.nt')).map((x) => [x.ic, x.status, x.evaluated]), [['IC-1', 'pass', 5], ['IC-2', 'pass', 1], ['IC-11', 'pass', 20], ['IC-12', 'pass', 5], ['IC-14', 'pass', 4]]);
});

// ---- long and wide: the same cube -----------------------------------------------------------------
const LONG = { columns: { Id: 'id', Place: 'name', Year: 'period', Occupation: { field: 'dimension', dimension: 'occupation' }, Persons: { field: 'value', measure: 'persons' } },
  table: { id: 'occupations', title: 'Occupations', source: 'A census (constructed)', dimensions: { occupation: { total: 'All' } } } };
const WIDE = { columns: { Id: 'id', Place: 'name', Year: 'period',
  Farmers: { field: 'figure', coordinates: { occupation: 'Farmers' }, measure: 'persons' }, Miners: { field: 'figure', coordinates: { occupation: 'Miners' }, measure: 'persons' },
  All: { field: 'figure', coordinates: { occupation: 'All' }, measure: 'persons', totalOf: ['Farmers', 'Miners'] } },
  table: { id: 'occupations', title: 'Occupations', source: 'A census (constructed)' } };
/** Each figure as what it says, told by its address: the cube's content, whatever the attestations that hold it. */
const content = (d) => figuresOf(d).map((f) => JSON.stringify(f)).sort();
test('the same table long and wide gives the same figures, the same addresses and the same checks', async () => {
  const l = await read(csv('long-shape.csv'), LONG), w = await read(csv('wide-shape.csv'), WIDE);
  assert.deepEqual([l.r.report.errors, w.r.report.errors], [0, 0]);
  assert.equal(figuresOf(l.doc).length, 6);
  assert.deepEqual(content(w.doc), content(l.doc));
  assert.deepEqual(w.doc.dataSets, l.doc.dataSets);
  // One attestation to a row: six in the long table, two in the wide.
  const atts = (d) => d.spatialEntities.reduce((n, e) => n + e.attestations.length, 0);
  assert.deepEqual([atts(l.doc), atts(w.doc)], [6, 2]);
  const cube = async (f, c) => integrity(outText((await go([f], 'convert', 'ntriples', { columns: c, base: BASE, cube: true })).e, f.name.replace('.csv', '.nt'))).map((x) => [x.ic, x.status, x.evaluated, x.violations.length]);
  const a = await cube(csv('long-shape.csv'), LONG), b = await cube(csv('wide-shape.csv'), WIDE);
  assert.deepEqual(a, b);
  assert.deepEqual(a, [['IC-1', 'pass', 6, 0], ['IC-2', 'pass', 1, 0], ['IC-11', 'pass', 18, 0], ['IC-12', 'pass', 6, 0], ['IC-14', 'pass', 5, 0]]);
});
test('control: the comparison of the two shapes notices a coordinate dropped from the wide one', async () => {
  const bad = structuredClone(WIDE); bad.columns.Miners.coordinates = { occupation: 'Farmers' };
  const w = await read(csv('wide-shape.csv'), bad), l = await read(csv('long-shape.csv'), LONG);
  assert.notDeepEqual(content(w.doc), content(l.doc));
  assert.ok(kinds(w.r, 'loss').includes('figures-duplicate'), 'two columns with one set of coordinates are a duplicate, said');
});
test('the universes are the ones marked: the parts to the printed total, the total to nothing', async () => {
  const { doc } = await read(csv('wide-shape.csv'), WIDE);
  const f = figuresOf(doc), by = (code, place) => f.find((x) => last(x.dimensions[`${BASE}dim/occupation`]['@id']) === code && x['@id'].includes(place));
  const alpha = f.filter((x) => x['@id'].includes('/place/a1#'));
  assert.equal(by('all', 'a1').universe, undefined);
  assert.equal(by('farmers', 'a1').universe, by('all', 'a1')['@id']);
  assert.equal(by('miners', 'a1').universe, by('all', 'a1')['@id']);
  assert.equal(alpha.length, 3);
  // A dash is a figure, and can have a universe: Beta's miners are absent from a total of fifty.
  assert.equal(by('miners', 'b2').universe, by('all', 'b2')['@id']);
  assert.equal(by('miners', 'b2').value, undefined);
});
test('nothing is a universe unless it is marked: a total in the table that is not named as one links to nothing', async () => {
  const none = structuredClone(WIDE); delete none.columns.All.totalOf;
  const w = await read(csv('wide-shape.csv'), none);
  assert.equal(figuresOf(w.doc).filter((x) => x.universe).length, 0);
  const longNone = structuredClone(LONG); delete longNone.table.dimensions;
  assert.equal(figuresOf((await read(csv('long-shape.csv'), longNone)).doc).filter((x) => x.universe).length, 0);
  // and with them marked, the same files do have links (the control for the two absences above)
  assert.equal(figuresOf((await read(csv('wide-shape.csv'), WIDE)).doc).filter((x) => x.universe).length, 4);
});

// ---- cells ----------------------------------------------------------------------------------------
const CLASS = { columns: { Id: 'id', Place: 'name', Year: 'period', Class: { field: 'dimension', dimension: 'class' }, Persons: { field: 'value', measure: 'persons' } } };
test('dashes are declared absences, blanks are no figure, 0 is 0, thousands separators are read, words are left out', async () => {
  const { r, doc } = await read(csv('dashes-and-blanks.csv'), CLASS);
  const f = figuresOf(doc), cls = (x) => last(x.dimensions[`${BASE}dim/class`]['@id']);
  const by = Object.fromEntries(f.map((x) => [cls(x), x]));
  assert.deepEqual(Object.keys(by).sort(), ['a', 'b', 'c', 'd', 'f', 'g']);
  assert.equal(by.a.value, 10); assert.equal(by.f.value, 0); assert.equal(by.g.value, 1234); assert.equal(by.g.sourceLabel, '1,234');
  for (const c of ['b', 'c', 'd']) {
    assert.equal(by[c].value, undefined, c); assert.ok(by[c].attributes['http://purl.org/linked-data/sdmx/2009/attribute#obsStatus'], c);
  }
  assert.deepEqual([by.b.sourceLabel, by.c.sourceLabel, by.d.sourceLabel], ['-', '–', '—']);
  assert.equal(by.f.attributes, undefined, 'a zero is not an absence');
  const c = r.report.counts;
  assert.deepEqual([c['figure cells'], c.figures, c['declared absences'], c['blank cells'], c['cells left out']], [10, 3, 3, 1, 3]);
  assert.ok(conserved(c));
  const bad = item(r, 'figures-cell-not-number');
  assert.equal(bad.count, 3); assert.equal(bad.severity, 'loss');
  assert.deepEqual(bad.examples.map((e) => e.replace(/^row \d+, /, '')), ['column "Persons": About 500', 'column "Persons": 12a', 'column "Persons": 1,5']);
  assert.equal(conservation(c), '10 cells of figures: 3 figures, 3 printed dashes, 1 blank, 3 left out.');
});
test('control: the conservation line is not satisfied by a count that is wrong', () => {
  const c = { 'figure cells': 10, figures: 3, 'declared absences': 3, 'blank cells': 1, 'cells left out': 2 };
  assert.ok(!conserved(c));
  assert.equal(conservation({}), null, 'no figures read, no line');
});
test('a cell is read as a number only as plainly written', () => {
  const v = (s) => figureCell(s);
  assert.deepEqual(v('1234'), { kind: 'value', value: 1234 });
  assert.deepEqual(v('1,234'), { kind: 'value', value: 1234, label: '1,234' });
  assert.deepEqual(v('1 234 567'), { kind: 'value', value: 1234567, label: '1 234 567' });
  assert.deepEqual(v("1'234"), { kind: 'value', value: 1234, label: "1'234" });
  assert.deepEqual(v('12.5'), { kind: 'value', value: 12.5 });
  assert.deepEqual(v('-3'), { kind: 'value', value: -3 });
  assert.deepEqual(v('007'), { kind: 'value', value: 7, label: '007' });
  for (const s of ['1,5', '1,23', '1.234,5', '1,2345', '12a', 'About 500', '£5', '1e3', '--', '1 2', '9007199254740993']) assert.equal(v(s).kind, 'bad', s);
  assert.equal(v('').kind, 'blank'); assert.equal(v('  ').kind, 'blank');
  assert.equal(v('—').kind, 'dash'); assert.equal(figureCell('n.a.', ['-', 'n.a.']).kind, 'dash'); assert.equal(v('n.a.').kind, 'bad');
});

// ---- places ---------------------------------------------------------------------------------------
const PARISH = { columns: { Place: 'name', County: { field: 'within', level: 1 }, Year: 'period', Persons: { field: 'value', measure: 'persons' } } };
test('a place with no id is its name with the regions it lies in: two parishes of one name in two counties are two places', async () => {
  const { r, doc } = await read(csv('repeated-names.csv'), PARISH);
  assert.equal(doc.spatialEntities.length, 3);
  assert.equal(figuresOf(doc).length, 3);
  assert.deepEqual(doc.spatialEntities.map((e) => e.label).sort(), ['Newport', 'Newport', 'Wem']);
  assert.equal(new Set(doc.spatialEntities.map((e) => e['@id'])).size, 3);
  assert.deepEqual(kinds(r, 'loss'), []);
  assert.ok(kinds(r, 'warning').includes('figures-names-as-keys'), 'and says that names are the keys');
});
test('control: without the county the two are one place, and the second figure is a duplicate, named', async () => {
  const noCounty = { columns: { ...PARISH.columns, County: 'note' } };
  const { r, doc } = await read(csv('repeated-names.csv'), noCounty);
  assert.equal(doc.spatialEntities.length, 2);
  assert.equal(figuresOf(doc).length, 2);
  const dup = item(r, 'figures-duplicate');
  assert.equal(dup.count, 1); assert.match(dup.examples[0], /row 3, column "Persons".*the same as row 2/);
  assert.ok(conserved(r.report.counts));
});
test('with an id column the id is the place, the name only its label, and the id is kept as its own identifier', async () => {
  const { r, doc } = await read(csv('long-shape.csv'), LONG);
  assert.deepEqual(doc.spatialEntities.map((e) => [e['@id'], e.label, e.entityIdentifier]), [[`${BASE}place/a1`, 'Alpha', 'a1'], [`${BASE}place/b2`, 'Beta', 'b2']]);
  assert.ok(!kinds(r).includes('figures-names-as-keys'));
});
test('a row with no place carries none of its figures, and every cell of it is counted', async () => {
  const m = { columns: { Id: 'id', Place: 'name', Year: 'period', 'Persons (column 4)': { field: 'value', measure: 'males' }, 'Persons (column 5)': { field: 'value', measure: 'females' } } };
  const { r, doc } = await read(csv('bad-cells.csv'), m);
  const c = r.report.counts;
  assert.equal(c.rows, 3);
  assert.deepEqual([c['figure cells'], c.figures, c['cells left out'], c['blank cells']], [6, 3, 3, 0]);
  assert.ok(conserved(c));
  assert.equal(item(r, 'figures-row-no-place').count, 1); assert.equal(item(r, 'figures-row-no-place').examples[0], 'row 3');
  assert.equal(item(r, 'figures-cell-not-number').count, 1); assert.match(item(r, 'figures-cell-not-number').examples[0], /row 4, column "Persons \(column 4\)": x/);   // rows are counted as the reader counts records: the empty line is not one
  assert.ok(kinds(r).includes('generic-csv-duplicate-header'));
  assert.equal(doc.dataSets.length, 2, 'two measures, two tables');
});

// ---- periods --------------------------------------------------------------------------------------
test('a period is read as the table gives it: a year stays a year, a day a day, a span a span, words a label only', () => {
  assert.deepEqual(parsePeriod('1851'), { startEarliest: '1851', endLatest: '1851', sourceLabel: '1851' });
  assert.deepEqual(parsePeriod('921'), { startEarliest: '0921', endLatest: '0921', sourceLabel: '921' });
  assert.deepEqual(parsePeriod('1851-03-30'), { startEarliest: '1851-03-30', endLatest: '1851-03-30', sourceLabel: '1851-03-30' });
  assert.deepEqual(parsePeriod('1851-1861'), { startEarliest: '1851', endLatest: '1861', sourceLabel: '1851-1861' });
  assert.deepEqual(parsePeriod('1851–1861'), { startEarliest: '1851', endLatest: '1861', sourceLabel: '1851–1861' });
  for (const s of ['circa 1850', '', '1861-1851', '1851-13-01', '1851-02-30x', '18510']) assert.equal(parsePeriod(s), null, JSON.stringify(s));
});
test('the periods of a table, and the share with a place on the cube\'s time axis', async () => {
  const m = { columns: { Id: 'id', Place: 'name', Period: 'period', Persons: { field: 'value', measure: 'persons' } } };
  const { r, doc } = await read(csv('period-forms.csv'), m);
  const ts = Object.fromEntries(doc.spatialEntities.map((e) => [e.entityIdentifier, e.attestations[0].timespans?.[0]]));
  assert.deepEqual(ts.p1, { startEarliest: '1851', endLatest: '1851', sourceLabel: '1851' });
  assert.deepEqual(ts.p2, { startEarliest: '1851-03-30', endLatest: '1851-03-30', sourceLabel: '1851-03-30' });
  assert.deepEqual(ts.p3, { startEarliest: '1851', endLatest: '1861', sourceLabel: '1851-1861' });
  assert.deepEqual(ts.p4, { sourceLabel: 'circa 1850' });
  assert.equal(ts.p5, undefined);
  assert.equal(item(r, 'figures-period-invalid').count, 1); assert.match(item(r, 'figures-period-invalid').examples[0], /row 5, column "Period": circa 1850/);
  assert.equal(item(r, 'figures-period-span').count, 1);
  assert.equal(item(r, 'figures-no-period').count, 1);
  // On the cube: two of the five have a year or a day for refPeriod; the others fail IC-11 over a structure that declares it.
  const c = await go([csv('period-forms.csv')], 'convert', 'ntriples', { columns: m, base: BASE, cube: true });
  const nt = outText(c.e, 'period-forms.nt');
  assert.equal(nt.split('\n').filter((l) => /dimension#refPeriod> "/.test(l)).length, 2);
  assert.deepEqual(integrity(nt).find((x) => x.ic === 'IC-11').violations.length, 3);
});
test('a period every figure shares is given once in the table\'s description; start and end columns work as for places', async () => {
  const m = { columns: { Id: 'id', Place: 'name', Persons: { field: 'value', measure: 'persons' } }, table: { period: '1851-03-30' } };
  const { r, doc } = await read(csv('two-measures.csv'), { columns: { Id: 'id', Place: 'name', Year: 'note', Persons: { field: 'value', measure: 'persons' }, Houses: 'skip' }, table: m.table });
  assert.ok(doc.spatialEntities.every((e) => e.attestations.every((a) => a.timespans[0].startEarliest === '1851-03-30')));
  assert.equal(r.report.errors, 0);
  const se = await read(csv('two-measures.csv'), { Id: 'id', Place: 'name', Year: 'start', Persons: { field: 'value', measure: 'persons' }, Houses: 'end' });
  assert.ok(se.doc.spatialEntities.every((e) => e.attestations[0].timespans[0].startEarliest === '1851'), 'start and end columns give the timespan');
});

// ---- measures, codes, ids -------------------------------------------------------------------------
const TWO = { columns: { Id: 'id', Place: 'name', Year: 'period', Persons: { field: 'value', measure: 'persons' }, Houses: { field: 'value', measure: 'houses' } }, table: { id: 'returns', title: 'Returns' } };
test('a table of two measures is two data sets, each with its own structure, and the cube checks both', async () => {
  const { doc } = await read(csv('two-measures.csv'), TWO);
  assert.deepEqual(doc.dataSets.map((d) => [d['@id'], d.title]), [[`${BASE}table/returns-persons`, 'Returns: persons'], [`${BASE}table/returns-houses`, 'Returns: houses']]);
  assert.deepEqual(doc.dataSets[1].structure.components.at(-1), { measure: `${BASE}measure/houses` });
  const f = figuresOf(doc);
  assert.equal(f.length, 4);
  assert.deepEqual(f.map((x) => last(x.dataSet)).sort(), ['returns-houses', 'returns-houses', 'returns-persons', 'returns-persons']);
  const c = await go([csv('two-measures.csv')], 'convert', 'ntriples', { columns: TWO, base: BASE, cube: true });
  assert.deepEqual(integrity(outText(c.e, 'two-measures.nt')).map((x) => [x.ic, x.status, x.evaluated, x.violations.length]), [['IC-1', 'pass', 4, 0], ['IC-2', 'pass', 2, 0], ['IC-11', 'pass', 8, 0], ['IC-12', 'pass', 4, 0], ['IC-14', 'pass', 4, 0]]);
});
test('figure addresses are fragments of the place\'s address and do not depend on the order of the rows or on a second reading', async () => {
  const text = readFileSync(`${DIR}/long-shape.csv`, 'utf8').trim().split('\n');
  const shuffled = [text[0], ...text.slice(1).reverse()].join('\n') + '\n';
  const a = await read(csv('long-shape.csv'), LONG), b = await read(textFile(shuffled, 'long-shape.csv'), LONG), c = await read(csv('long-shape.csv'), LONG);
  const ids = (d) => figuresOf(d).map((f) => f['@id']).sort();
  assert.deepEqual(ids(b.doc), ids(a.doc));
  assert.deepEqual(ids(c.doc), ids(a.doc));
  assert.ok(ids(a.doc).every((i) => /^https:\/\/whgazetteer\.org\/example\/place\/(a1|b2)#f-[0-9a-f]{16}$/.test(i)), ids(a.doc).join('\n'));
  assert.equal(new Set(ids(a.doc)).size, 6);
  // The universes follow the ids; the content is the same either way.
  assert.deepEqual(content(b.doc), content(a.doc));
  // Control: a figure's address changes with its coordinates, its period and its table, so these are what it is made of.
  const other = structuredClone(LONG); other.table.id = 'other';
  assert.notDeepEqual(ids((await read(csv('long-shape.csv'), other)).doc), ids(a.doc));
  const year = text.map((l, i) => (i ? l.replace(',1851,', ',1861,') : l)).join('\n') + '\n';
  assert.notDeepEqual(ids((await read(textFile(year, 'long-shape.csv'), LONG)).doc), ids(a.doc));
});
test('a blank dimension cell is the dimension\'s "unknown" code; two labels of one slug both take the hash of their label', async () => {
  const rows = 'Id,Place,Year,Trade,Persons\nx1,Xi,1851,Coal Miner,1\nx1,Xi,1851,coal miner,2\nx1,Xi,1851,,3\nx1,Xi,1851,Unknown,4\n';
  const m = { columns: { Id: 'id', Place: 'name', Year: 'period', Trade: { field: 'dimension', dimension: 'trade' }, Persons: { field: 'value', measure: 'persons' } } };
  const { r, doc } = await read(textFile(rows, 't.csv'), m);
  const codes = figuresOf(doc).map((f) => f.dimensions[`${BASE}dim/trade`]['@id']);
  assert.equal(new Set(codes).size, 3, 'a blank and the word Unknown are the one code; the two spellings are two');
  const names = codes.map(last);
  assert.ok(names.filter((n) => /^coal-miner-[0-9a-f]{8}$/.test(n)).length === 2, names.join(','));
  assert.equal(last(codes[2]), last(codes[3])); assert.match(last(codes[2]), /^unknown/);
  assert.equal(r.report.counts.figures, 4);
  // Reading in another order gives the same addresses (none depends on which row met it first).
  const flipped = 'Id,Place,Year,Trade,Persons\nx1,Xi,1851,coal miner,2\nx1,Xi,1851,Coal Miner,1\n';
  const f = await read(textFile(flipped, 't.csv'), m);
  const byValue = (d) => Object.fromEntries(figuresOf(d).map((x) => [x.value, last(x.dimensions[`${BASE}dim/trade`]['@id'])]));
  assert.equal(byValue(f.doc)[1], byValue(doc)[1]); assert.equal(byValue(f.doc)[2], byValue(doc)[2]);
});
test('the code lists are a second N-Triples file beside the output, with the labels the table gives', async () => {
  const r = await go([csv('long-shape.csv')], 'convert', 'plato-json', { columns: LONG, base: BASE });
  assert.deepEqual(Object.keys(r.e.outs), ['long-shape.json', 'long-shape.codes.nt']);
  assert.deepEqual(r.outputs.map((o) => o.name), ['long-shape.json', 'long-shape.codes.nt']);
  const nt = outText(r.e, 'long-shape.codes.nt');
  for (const l of [
    `<${BASE}dim/occupation> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://purl.org/linked-data/cube#DimensionProperty> .`,
    `<${BASE}dim/occupation> <http://purl.org/linked-data/cube#codeList> <${BASE}code/occupation> .`,
    `<${BASE}code/occupation/farmers> <http://www.w3.org/2004/02/skos/core#prefLabel> "Farmers" .`,
    `<${BASE}code/occupation/farmers> <http://www.w3.org/2004/02/skos/core#inScheme> <${BASE}code/occupation> .`,
    `<${BASE}measure/persons> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://purl.org/linked-data/cube#MeasureProperty> .`,
    `<${BASE}code/obs-status/nil-or-not-applicable> <http://www.w3.org/2004/02/skos/core#prefLabel> "nil or not applicable" .`,
  ]) assert.ok(nt.split('\n').includes(l), l);
  assert.equal(nt, outText((await go([csv('long-shape.csv')], 'convert', 'plato-json', { columns: LONG, base: BASE })).e, 'long-shape.codes.nt'), 'the same table gives the same bytes');
  // A check writes nothing; a table of places writes no code file.
  assert.deepEqual(Object.keys((await go([csv('long-shape.csv')], 'check', undefined, { columns: LONG, base: BASE })).e.outs), []);
  assert.deepEqual(Object.keys((await go([csv('repeated-names.csv')], 'convert', 'plato-json', { columns: { Place: 'name', County: 'note', Year: 'note', Persons: 'note' }, base: BASE })).e.outs), ['repeated-names.json']);
});

// ---- what is carried as it stands ----------------------------------------------------------------
test('parts that do not add up to the printed total are carried as marked: the reader does not judge the sum', async () => {
  const m = { columns: { Id: 'id', Place: 'name', Year: 'period', A: { field: 'figure', coordinates: { part: 'A' }, measure: 'n' }, B: { field: 'figure', coordinates: { part: 'B' }, measure: 'n' }, Total: { field: 'figure', coordinates: { part: 'Total' }, measure: 'n', totalOf: ['A', 'B'] } } };
  const { r, doc } = await read(csv('totals-wrong.csv'), m);
  assert.equal(r.report.errors, 0); assert.deepEqual(kinds(r, 'loss'), []);
  const f = figuresOf(doc);
  assert.equal(f.length, 6);
  assert.equal(f.filter((x) => x.universe).length, 4);
  assert.equal(f.find((x) => x.value === 35).universe, undefined);
});
test('a total whose figure is missing links nothing and says so; nothing is put in its place', async () => {
  const rows = 'Id,Place,Year,A,B,Total\nu1,Eta,1851,1,2,\n';
  const m = { columns: { Id: 'id', Place: 'name', Year: 'period', A: { field: 'figure', coordinates: { part: 'A' } }, B: { field: 'figure', coordinates: { part: 'B' } }, Total: { field: 'figure', coordinates: { part: 'Total' }, totalOf: ['A', 'B'] } }, table: { measure: 'n' } };
  const { r, doc } = await read(textFile(rows, 'u.csv'), m);
  assert.equal(figuresOf(doc).filter((x) => x.universe).length, 0);
  assert.equal(item(r, 'figures-total-missing').count, 2);
  assert.equal(r.report.counts['blank cells'], 1);
});
test('a code marked as a total that the table never uses is reported', async () => {
  const m = structuredClone(LONG); m.table.dimensions.occupation.total = 'Everyone';
  const { r, doc } = await read(csv('long-shape.csv'), m);
  assert.equal(figuresOf(doc).filter((x) => x.universe).length, 0);
  assert.match(item(r, 'figures-total-unmet').examples[0], /occupation.*Everyone/);
});
test('every row is an attestation about its place, citing the table\'s source with the row as its locator', async () => {
  const r = await go([csv('long-shape.csv')], 'convert', 'ntriples', { columns: LONG, base: BASE });
  const nt = outText(r.e, 'long-shape.nt');
  assert.equal(nt.split('\n').filter((l) => / <https:\/\/w3id\.org\/plato#attests_about> /.test(l)).length, 6);
  const j = await read(csv('long-shape.csv'), LONG);
  const locators = j.doc.spatialEntities.flatMap((e) => e.attestations.map((a) => a.citations[0].locator)).sort();
  assert.deepEqual(locators, ['row 2', 'row 3', 'row 4', 'row 5', 'row 6', 'row 7']);
  assert.ok(j.doc.spatialEntities.every((e) => e.attestations.every((a) => a.citations[0].source.title === 'A census (constructed)')));
  assert.equal(j.doc.dataSets[0].isPartOf, j.doc.spatialEntities[0].attestations[0].citations[0].source['@id']);
});

// ---- a description that cannot be used ------------------------------------------------------------
test('a table that cannot be read says why, as an error, and reads nothing', async () => {
  const cases = [
    [{ columns: { Id: 'id', Place: 'name', Year: 'period', Persons: 'note' } }, /no column is a "value" or a "figure"/],
    [{ columns: { Year: 'period', Persons: { field: 'value', measure: 'persons' } } }, /no column is the places' id/],
    [{ columns: { Id: 'id', Place: 'name', Occupation: { field: 'dimension' }, Persons: { field: 'value' } }, table: { coordinates: { Occupation: 'x' } } }, /is a column and also a coordinate/],
    [{ columns: { Id: 'id', Farmers: { field: 'figure', coordinates: { o: 'F' }, totalOf: ['Farmers'] } }, table: { measure: 'n' } }, /total of itself/],
    [{ columns: { Id: 'id', Farmers: { field: 'figure', coordinates: { o: 'F' }, totalOf: ['Miners'] }, Miners: { field: 'figure', coordinates: { o: 'M' }, totalOf: ['Farmers'] } }, table: { measure: 'n' } }, /loop round/],
    [{ columns: { Id: 'id', A: { field: 'figure', coordinates: { o: 'A' } }, B: { field: 'figure', coordinates: { o: 'B' }, totalOf: ['A'] }, C: { field: 'figure', coordinates: { o: 'C' }, totalOf: ['A'] } }, table: { measure: 'n' } }, /part of two totals/],
    [{ columns: { Id: 'id', A: { field: 'figure', coordinates: { o: 'A' }, measure: 'x' }, B: { field: 'figure', coordinates: { o: 'B' }, measure: 'y', totalOf: ['A'] } } }, /another measure/],
    [{ columns: { Id: 'id', A: { field: 'figure', coordinates: { 'Sex!': 'A' }, measure: 'x' }, B: { field: 'figure', coordinates: { 'sex?': 'B' }, measure: 'x' } } }, /would have one address/],
  ];
  for (const [m, why] of cases) {
    const f = textFile('Id,Place,Year,Occupation,Persons,Farmers,Miners,A,B,C\n1,A,1851,x,1,1,1,1,1,1\n', 't.csv');
    const r = await go([f], 'check', undefined, { columns: m, base: BASE });
    const e = r.report.items.filter((i) => i.severity === 'error');
    assert.deepEqual(e.map((i) => i.kind), ['figures-mapping'], JSON.stringify(m));
    assert.match(e[0].examples.join('; '), why);
    assert.equal(r.report.counts.figures, undefined, 'nothing was read');
  }
});
test('a description with a key it does not know, or an entry given wrongly, is warned of and the rest is used', async () => {
  const m = structuredClone(LONG);
  m.table.colour = 'red'; m.table.dimensions.occupation.tpyo = 1; m.table.dimensions.nowhere = { total: 'x' }; m.table.dashes = 'n.a.';
  const r = await go([csv('long-shape.csv')], 'check', undefined, { columns: m, base: BASE });
  assert.equal(r.report.errors, 0);
  const w = item(r, 'figures-mapping-table');
  assert.equal(w.severity, 'warning'); assert.equal(w.count, 4);
  assert.equal(r.report.counts.figures, 5);
  // Entries of the columns given wrongly keep the column in the notes and say so, as a place's do.
  const bad = { columns: { Id: 'id', Place: 'name', Year: 'period', Occupation: { field: 'dimension', measure: 'x' }, Persons: { field: 'value', coordinates: { a: 'b' } } } };
  const b = await go([csv('long-shape.csv')], 'check', undefined, { columns: bad, base: BASE });
  assert.equal(item(b, 'generic-mapping').count, 2);
});
test('GeoJSON is not a table of figures', async () => {
  const f = textFile(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'A', n: 3 }, geometry: null }] }), 'p.geojson');
  const r = await go([f], 'check', undefined, { columns: { name: 'name', n: { field: 'value', measure: 'n' } } });
  assert.deepEqual(kinds(r, 'error'), ['figures-not-csv']);
});

// ---- the words ------------------------------------------------------------------------------------
test('every kind the reader reports has its words and a severity, and the words reach the report', async () => {
  const { FIGURES_KINDS, FIGURES_TEXT } = await import('../src/engine/hermes/figures-text.js');
  const { LOSS_TEXT } = await import('../src/engine/report.js');
  assert.deepEqual(Object.keys(FIGURES_KINDS).sort(), Object.keys(FIGURES_TEXT).sort());
  for (const [k, severity] of Object.entries(FIGURES_KINDS)) {
    assert.ok(['error', 'warning', 'loss'].includes(severity), k);
    assert.equal(LOSS_TEXT[k], FIGURES_TEXT[k], k);
    assert.ok(FIGURES_TEXT[k].length > 40, k);
  }
  // Control: the kinds a run reports are among them, with their words and severity.
  const r = await go([csv('dashes-and-blanks.csv')], 'check', undefined, { columns: CLASS, base: BASE });
  const mine = r.report.items.filter((i) => i.kind.startsWith('figures-'));
  assert.ok(mine.length > 0);
  for (const i of mine) { assert.ok(FIGURES_KINDS[i.kind], i.kind); assert.equal(i.message, FIGURES_TEXT[i.kind]); assert.equal(i.severity, FIGURES_KINDS[i.kind]); }
});
