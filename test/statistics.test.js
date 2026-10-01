import { PLATO_REPO } from './paths.js';
// PLATO's design for statistical figures (issue #14). A figure is a PropertyValue that is also a
// Data Cube observation: its table (dataSet), its coordinates (dimensions) and facts about it
// (attributes) are direct statements on it, keyed by IRI. Covered: JSON -> RDF gives jsonld.js's
// graph for keys that are IRIs; RDF -> JSON puts them back, validly and losslessly; the header's
// dataSets both ways; the cube export (--cube); the rule that a value is required unless obsStatus
// says why not; and the Data Cube integrity constraints on the export. That the pin is PLATO main,
// and that a draft pin is marked as one, is in pin.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import jsonld from 'jsonld';
import { res, file, textFile, outText, go } from './engine.js';
import { Json2Rdf } from '../src/formats/json2rdf.js';
import { tripleNT } from '../src/lib/ntriples.js';
import { refPeriod } from '../src/formats/cube.js';
import { integrity } from './datacube.js';

const STATS = `${PLATO_REPO}/schemas/examples/place-centric-statistics.json`;
test('PLATO\'s statistics example is there to test against', () => {
  assert.ok(existsSync(STATS), `${STATS} not found: set PLATO_REPO to a checkout of PLATO at the pinned commit`);
});
const EXAMPLE = existsSync(STATS) ? JSON.parse(readFileSync(STATS, 'utf8')) : null;
const doc = () => structuredClone(EXAMPLE);
const CTX = JSON.parse(readFileSync('public/plato/plato.context.jsonld', 'utf8'));
const QB = 'http://purl.org/linked-data/cube#', SD = 'http://purl.org/linked-data/sdmx/2009/dimension#', SA = 'http://purl.org/linked-data/sdmx/2009/attribute#';
const XSD = 'http://www.w3.org/2001/XMLSchema#', P = 'https://w3id.org/plato#';
const T = 'https://whgazetteer.org/example/table/occupations-1851';
const errors = (r) => r.report.items.filter((i) => i.severity === 'error');
const warnings = (r, kind) => r.report.items.filter((i) => i.severity === 'warning' && (!kind || i.kind === kind));
const loss = (r, kind) => r.report.items.find((i) => i.severity === 'loss' && i.kind === kind);
const losses = (r) => r.report.items.filter((i) => i.severity === 'loss');
const lines = (nt) => nt.split('\n').filter(Boolean);
const nt = async (d, name = 'd.json', options = {}) => { const r = await go([textFile(JSON.stringify(d), name)], 'convert', 'ntriples', options); return { r, text: outText(r.e, name.replace(/\.[^.]+$/, '.nt')) }; };
const jsonBack = async (text, name = 'back.nt') => { const r = await go([textFile(text, name)], 'convert', 'plato-json'); return { r, doc: JSON.parse(outText(r.e, name.replace(/\.nt$/, '.json'))) }; };
/** The predicate of each N-Triples line, so that a term's use as a predicate is not confused with its mention as an object. */
const predicates = (nt) => lines(nt).map((l) => l.match(/^\S+ <([^>]+)>/)?.[1]);
const CUBE_P = new Set([SD + 'refArea', SD + 'refPeriod', 'https://whgazetteer.org/example/measure/persons']);
const cubeLines = (nt) => lines(nt).filter((l) => CUBE_P.has(l.match(/^\S+ <([^>]+)>/)?.[1]) || new RegExp(`> <${QB}(Observation|DataSet|DataStructureDefinition)> \\.$`).test(l)).sort();
const figures = (d) => d.spatialEntities.flatMap((e) => (e.attestations || []).flatMap((a) => a.properties || []));

// ---- JSON -> RDF: keys that are IRIs --------------------------------------------------------------
const compiled = (d) => {
  let out = ''; const w = new Json2Rdf(CTX, (s, p, o) => { out += tripleNT(s, p, o); });
  const { spatialEntities, ...head } = d; w.header(head); for (const r of spatialEntities) w.record('spatialEntities', r);
  return out;
};
const canon = (q) => jsonld.canonize([...new Set(lines(q))].join('\n') + '\n', { algorithm: 'URDNA2015', inputFormat: 'application/n-quads', format: 'application/n-quads', safe: false });
test('keys that are IRIs, with every kind of value, give exactly the graph jsonld.js gives', async () => {
  const d = doc();
  const f = d.spatialEntities[0].attestations[0].properties[2];
  f.dimensions['https://example.org/dim/age'] = 20;                                   // an integer
  f.dimensions['https://example.org/dim/share'] = 0.25;                               // a double
  f.dimensions['https://example.org/dim/flag'] = true;                                // a boolean
  f.dimensions['https://example.org/dim/word'] = 'twenty and over';                  // a string
  f.dimensions['qb:order'] = 3;                                                       // a compact IRI with a context prefix
  f.dimensions['sdmx-dimension:x'] = 'y';                                             // a scheme that is no prefix
  f.attributes = { [SA + 'unitMult']: [0, 1], 'https://example.org/attr/year': { '@value': '1851', '@type': 'xsd:gYear' },
    'https://example.org/attr/note': { '@value': 'about', '@language': 'EN' }, 'https://example.org/attr/n': { '@value': 3, '@type': XSD + 'double' },
    'https://example.org/attr/node': { '@id': 'https://example.org/n/1', 'https://example.org/p': 'nested' } };
  const ours = compiled(d);
  for (const x of [`<https://example.org/dim/age> "20"^^<${XSD}integer>`, `<${QB}order> "3"^^<${XSD}integer>`, '<sdmx-dimension:x> "y"', `<https://example.org/attr/year> "1851"^^<${XSD}gYear>`, '"about"@en']) assert.ok(ours.includes(x), x);
  assert.equal(await canon(ours), await canon(await jsonld.toRDF({ ...d, '@context': CTX['@context'] }, { format: 'application/n-quads', safe: false })));
});
test('control: the comparison notices a dimension that is left out', async () => {
  const d = doc(); const kept = compiled(d);
  const without = lines(kept).filter((l) => !l.includes(`${SD}sex>`)).join('\n');
  assert.notEqual(await canon(without), await canon(await jsonld.toRDF({ ...d, '@context': CTX['@context'] }, { format: 'application/n-quads', safe: false })));
});
test('the example: each coordinate and attribute is a statement on the figure, never on the place', async () => {
  const { r, text } = await nt(doc());
  assert.deepEqual(errors(r), []); assert.deepEqual(warnings(r), []);
  assert.ok(lines(text).includes(`<${T}/agri/m> <${SD}sex> <http://purl.org/linked-data/sdmx/2009/code#sex-M> .`));
  assert.ok(lines(text).includes(`<${T}/miner/f> <${SA}obsStatus> <https://whgazetteer.org/example/code/obs-status/nil-or-not-applicable> .`));
  assert.ok(!lines(text).some((l) => l.startsWith('<https://whgazetteer.org/example/entity/example-county>') && /sdmx|\/dim\//.test(l)), 'nothing about coordinates is said of the county');
});

// ---- RDF -> JSON: back under dimensions and attributes ---------------------------------------------
test('the example: JSON -> RDF -> JSON gives back the same document, key for key, and it is valid', async () => {
  const { text } = await nt(doc(), 'place-centric-statistics.json');
  const { r, doc: back } = await jsonBack(text);
  assert.deepEqual(errors(r), []); assert.deepEqual(losses(r), []); assert.deepEqual(warnings(r), []);
  const { spatialEntities, ...head } = back;
  assert.ok(res.validators['place-centric'].header(head), JSON.stringify(res.validators['place-centric'].header.errors));
  for (const e of back.spatialEntities) assert.ok(res.validators['place-centric'].entity(e), JSON.stringify(res.validators['place-centric'].entity.errors));
  const { $schema, ...want } = doc();
  assert.deepEqual({ ...back, $schema: undefined }, { ...want, $schema: undefined });
});
/** One figure in its own document, with a table whose structure lists the given components. */
function oneFigure(extra, components = [{ dimension: 'https://example.org/dim/a' }, { measure: 'https://example.org/m' }]) {
  return { profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' },
    dataSets: [{ '@id': 'https://example.org/t', structure: { '@id': 'https://example.org/t/s', components } }],
    spatialEntities: [{ '@id': 'https://example.org/p', label: 'P', attestations: [{ sources: [{ '@id': 'https://example.org/s', title: 'S' }],
      timespans: [{ startEarliest: '1851', endLatest: '1851' }],
      properties: [{ '@id': 'https://example.org/f', property: 'https://example.org/m', value: 5, dataSet: 'https://example.org/t', ...extra }] }] }] };
}
const backFigure = async (d, graphExtra = '') => {
  const { text } = await nt(d);
  const { r, doc: back } = await jsonBack(text + graphExtra);
  return { r, f: figures(back)[0], back };
};
test('RDF -> JSON: the table\'s structure decides, then the property\'s type, then the SDMX namespace, then dimensions', async () => {
  // 1. declared in the structure as an attribute: an attribute, though its IRI says nothing
  let x = await backFigure(oneFigure({ dimensions: { 'https://example.org/dim/a': 'v' }, attributes: { 'https://example.org/attr/approx': true } },
    [{ dimension: 'https://example.org/dim/a' }, { attribute: 'https://example.org/attr/approx' }, { measure: 'https://example.org/m' }]));
  assert.deepEqual([x.f.dimensions, x.f.attributes], [{ 'https://example.org/dim/a': 'v' }, { 'https://example.org/attr/approx': true }]);
  assert.deepEqual(warnings(x.r), []);
  // ... and the structure outranks the namespace: an SDMX attribute IRI listed as a dimension is a dimension
  x = await backFigure(oneFigure({ dimensions: { [SA + 'odd']: 'v' } }, [{ dimension: SA + 'odd' }]));
  assert.deepEqual([x.f.dimensions, x.f.attributes], [{ [SA + 'odd']: 'v' }, undefined]);
  // 2. not in the structure, but typed in the graph
  x = await backFigure(oneFigure({ attributes: { 'https://example.org/attr/typed': 'v' } }), `<https://example.org/attr/typed> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${QB}AttributeProperty> .\n`);
  assert.deepEqual(x.f.attributes, { 'https://example.org/attr/typed': 'v' });
  // 3. in neither: by SDMX namespace
  x = await backFigure(oneFigure({ attributes: { [SA + 'obsStatus']: { '@id': 'https://example.org/code/dash' } }, value: undefined }));
  assert.deepEqual(x.f.attributes, { [SA + 'obsStatus']: { '@id': 'https://example.org/code/dash' } });
  assert.equal(x.f.value, undefined);
  // 4. in none of them: a dimension, with a warning naming it; the graph is the same either way
  x = await backFigure(oneFigure({ attributes: { 'https://example.org/attr/unknown': 'v' } }));
  assert.deepEqual([x.f.dimensions, x.f.attributes], [{ 'https://example.org/attr/unknown': 'v' }, undefined]);
  assert.deepEqual(warnings(x.r, 'figure-undeclared').map((w) => w.examples), [['https://example.org/attr/unknown']]);
  const again = await nt(x.back);
  assert.ok(lines(again.text).includes('<https://example.org/f> <https://example.org/attr/unknown> "v" .'));
});
test('RDF -> JSON: on a property value that is not a figure, only a typed or SDMX property is taken; anything else is a loss', async () => {
  const d = oneFigure({ attributes: { [SA + 'obsStatus']: { '@id': 'https://example.org/code/e' }, 'https://example.org/other': 'x' } });
  delete d.spatialEntities[0].attestations[0].properties[0].dataSet;
  const { r, f } = await backFigure(d);
  assert.deepEqual(f.attributes, { [SA + 'obsStatus']: { '@id': 'https://example.org/code/e' } });
  assert.equal(f.dimensions, undefined);
  assert.equal(losses(r).find((l) => l.kind === 'unmapped-predicate')?.examples[0], 'https://example.org/other');
});
test('RDF -> JSON: a coordinate whose datatype JSON cannot carry keeps its text, and says it lost the type', async () => {
  const d = oneFigure({ dimensions: { 'https://example.org/dim/a': 7 } });
  const { text } = await nt(d);
  const typed = text.replace(`<https://example.org/dim/a> "7"^^<${XSD}integer>`, `<https://example.org/dim/a> "1851"^^<${XSD}gYear>`);
  assert.notEqual(typed, text);
  const { r, doc: back } = await jsonBack(typed);
  assert.equal(figures(back)[0].dimensions['https://example.org/dim/a'], '1851');
  assert.ok(loss(r, 'figure-literal'), JSON.stringify(losses(r)));
  // control: an integer, as JSON writes it, comes back as a number with no loss
  const plain = await jsonBack(text);
  assert.equal(figures(plain.doc)[0].dimensions['https://example.org/dim/a'], 7);
  assert.equal(loss(plain.r, 'figure-literal'), undefined);
});

// ---- dataSets in the header -------------------------------------------------------------------------
test('dataSets: a structure given by address alone comes back as an address; one with components as an object', async () => {
  const d = oneFigure({ dimensions: { 'https://example.org/dim/a': 'v' } });
  d.dataSets.push({ '@id': 'https://example.org/t2', title: 'Second', structure: 'https://example.org/elsewhere/s' });
  const { text } = await nt(d);
  const { r, doc: back } = await jsonBack(text);
  assert.deepEqual(losses(r), []);
  assert.deepEqual(back.dataSets, d.dataSets);
});
test('dataSets written after the places are reported, not silently dropped', async () => {
  const { dataSets, ...rest } = doc();
  const late = JSON.stringify({ ...rest, dataSets });
  assert.ok(late.indexOf('"dataSets"') > late.indexOf('"spatialEntities"'));
  const r = await go([textFile(late, 'late.json')], 'check');
  assert.ok(errors(r).some((e) => e.kind === 'late-header'), JSON.stringify(errors(r)));
  assert.equal(errors(await go([file(STATS)], 'check')).length, 0, 'control: before them, no problem');
});

// ---- the cube export --------------------------------------------------------------------------------
test('refPeriod: one year is an xsd:gYear, one day an xsd:date, anything else is not placed', () => {
  const Y = XSD + 'gYear', D = XSD + 'date';
  assert.deepEqual(refPeriod('1851', '1851'), { value: '1851', datatype: Y });
  assert.deepEqual(refPeriod('1851-01-01', '1851-12-31'), { value: '1851', datatype: Y });
  assert.deepEqual(refPeriod('1851', '1851-03-30'), { value: '1851', datatype: Y });
  assert.deepEqual(refPeriod('1851-03-30', '1851-03-30'), { value: '1851-03-30', datatype: D });
  assert.deepEqual(refPeriod('1851-03-30T00:00:00Z', '1851-03-30T23:59:59Z'), { value: '1851-03-30', datatype: D });
  assert.deepEqual(refPeriod('-12000', '-12000'), { value: '-12000', datatype: Y });
  for (const [a, b] of [['1851', '1852'], ['1851-12-31', '1852-01-01'], ['1851', undefined], [undefined, '1851'], ['c. 1851', '1851'], ['1851', 'about 1851']]) assert.equal(refPeriod(a, b), null, `${a} to ${b}`);
});
test('--cube on the example adds exactly what Data Cube expects, and nothing else changes', async () => {
  const plain = await nt(doc(), 'place-centric-statistics.json');
  const cube = await nt(doc(), 'place-centric-statistics.json', { cube: true });
  assert.deepEqual(errors(cube.r), []); assert.deepEqual(warnings(cube.r), []);
  assert.equal(cube.r.report.counts.observations, 5);
  const before = new Set(lines(plain.text));
  assert.ok(lines(plain.text).every((l) => cube.text.includes(l + '\n')), 'every plain statement is in the cube');
  const added = lines(cube.text).filter((l) => !before.has(l)).sort();
  const obs = ['all/total', 'agri/total', 'agri/m', 'agri/f', 'miner/f'].map((x) => `<${T}/${x}>`);
  const TYPE = '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>', persons = '<https://whgazetteer.org/example/measure/persons>';
  const want = [
    `<${T}> ${TYPE} <${QB}DataSet> .`, `<${T}/structure> ${TYPE} <${QB}DataStructureDefinition> .`,
    ...obs.map((o) => `${o} ${TYPE} <${QB}Observation> .`),
    ...obs.map((o) => `${o} <${SD}refArea> <https://whgazetteer.org/example/entity/example-county> .`),
    ...obs.map((o) => `${o} <${SD}refPeriod> "1851"^^<${XSD}gYear> .`),
    ...[[0, 1000], [1, 300], [2, 280], [3, 20]].map(([i, n]) => `${obs[i]} ${persons} "${n}"^^<${XSD}integer> .`),
  ].sort();
  assert.deepEqual(added, want, 'the dash (miner/f) has no measure statement: its obsStatus declares the absence');
  // Without --cube the output has none of it.
  assert.deepEqual(cubeLines(plain.text), []);
  assert.equal(cubeLines(cube.text).length, 21);
});
test('--cube from RDF input gives the same statements as from JSON', async () => {
  const plain = await nt(doc(), 'place-centric-statistics.json');
  const viaRdf = await go([textFile(plain.text, 'in.nt')], 'convert', 'ntriples', { cube: true });
  const fromJson = await nt(doc(), 'place-centric-statistics.json', { cube: true });
  assert.deepEqual(cubeLines(outText(viaRdf.e, 'in.nt')), cubeLines(fromJson.text));
  assert.equal(cubeLines(fromJson.text).length, 21);
});
test('a figure whose date is not one year or one day gets no refPeriod, and is reported, not guessed', async () => {
  const d = doc(); d.spatialEntities[0].attestations[0].timespans = [{ startEarliest: '1851', endLatest: '1852' }];
  const { r, text } = await nt(d, 'd.json', { cube: true });
  assert.ok(!predicates(text).includes(SD + 'refPeriod'));
  assert.equal(warnings(r, 'cube-no-period')[0]?.count, 5);
  assert.match(warnings(r, 'cube-no-period')[0].message, /not guessed/);
  assert.equal(predicates(text).filter((x) => x === SD + 'refArea').length, 5, 'the area is still placed');
});
test('reading a cube export back leaves out only its own derived statements', async () => {
  const cube = await nt(doc(), 'place-centric-statistics.json', { cube: true });
  const { r, doc: back } = await jsonBack(cube.text);
  assert.deepEqual(losses(r), []);
  const { $schema, ...want } = doc();
  assert.deepEqual({ ...back, $schema: undefined }, { ...want, $schema: undefined });
  // control: without the qb:Observation type, a refArea written in the data is the data's, and is kept
  const d = oneFigure({ dimensions: { [SD + 'refArea']: { '@id': 'https://example.org/p' } } });
  const { f } = await backFigure(d);
  assert.deepEqual(f.dimensions, { [SD + 'refArea']: { '@id': 'https://example.org/p' } });
});
test('the command line refuses --cube on anything but N-Triples', () => {
  // Into a directory of its own, so that a command line that did not refuse leaves nothing behind.
  const dir = mkdtempSync(`${process.env.TMPDIR || '/tmp'}/plato-tools-cube-`);
  try {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url)), 'convert', '--to', 'lpf', '--cube', '--out', dir, STATS], { encoding: 'utf8' });
    assert.equal(r.status, 2); assert.match(r.stderr, /--cube is for convert --to ntriples/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- a value, or a reason for none ------------------------------------------------------------------
for (const [name, change, ok] of [
  ['a value', (f) => f, true],
  ['no value, with obsStatus', (f) => { delete f.value; f.attributes = { [SA + 'obsStatus']: { '@id': 'https://example.org/code/dash' } }; return f; }, true],
  ['no value and no attributes', (f) => { delete f.value; return f; }, false],
  ['no value, with attributes but no obsStatus', (f) => { delete f.value; f.attributes = { [SA + 'unitMult']: 0 }; return f; }, false],
]) {
  test(`a property value with ${name} is ${ok ? 'valid' : 'a problem'}`, async () => {
    const d = oneFigure({ dimensions: { 'https://example.org/dim/a': 'v' } });
    d.spatialEntities[0].attestations[0].properties[0] = change(d.spatialEntities[0].attestations[0].properties[0]);
    const r = await go([textFile(JSON.stringify(d), 'v.json')], 'check');
    if (ok) assert.deepEqual(errors(r), []);
    else {
      assert.equal(errors(r).length, 1, JSON.stringify(errors(r)));
      assert.match(errors(r)[0].message, /has no value.*obsStatus/);
    }
  });
}

// ---- LPF and the tables cannot hold a figure ----------------------------------------------------------
for (const target of ['lpf', 'tables']) {
  test(`a statistical figure is left out of ${target}, never written as a fact about the place, and reported`, async () => {
    const r = await go([file(STATS)], 'convert', target);
    assert.equal(loss(r, 'statistical-figure')?.count, 5, JSON.stringify(losses(r).map((l) => l.kind)));
    assert.equal(loss(r, 'statistical-tables')?.count, 1);
    const out = Object.values(r.e.outs)[0].map((x) => (typeof x === 'string' ? x : new TextDecoder().decode(x))).join('');
    // The absences below mean something only beside a presence: the county is written.
    if (target === 'lpf') {
      assert.ok(out.includes('"features":[{"@id":"https://whgazetteer.org/example/entity/example-county"'), out.slice(0, 500));
      assert.doesNotMatch(out, /measure\/persons|"280"|:280\b/);
    } else {
      const { unzipSync, strFromU8 } = await import('fflate');
      const props = strFromU8(unzipSync(r.e.outs['place-centric-statistics-tables.zip'][0])['properties.csv']);
      assert.equal(props.trim().split('\n').length, 1, 'the properties sheet has its header and no rows');
    }
    // control: the same value with no table or coordinates is an ordinary property value, and is written
    const d = doc(); const f = figures(d)[2]; for (const k of ['dataSet', 'dimensions', 'universe']) delete f[k];
    const c = await go([textFile(JSON.stringify(d), 'c.json')], 'convert', target);
    assert.equal(loss(c, 'statistical-figure')?.count, 4);
    if (target === 'tables') {
      const { unzipSync, strFromU8 } = await import('fflate');
      const props = strFromU8(unzipSync(c.e.outs['c-tables.zip'][0])['properties.csv']);
      assert.match(props, /\nexample-county,https:\/\/whgazetteer\.org\/example\/measure\/persons,persons,280,/, 'the same sheet holds the value once it is not a figure');
    }
  });
}

// ---- the Data Cube integrity constraints, on the export ------------------------------------------------
const cubeOf = async (d, name = 'c.json') => (await nt(d, name, { cube: true })).text;
const status = (results) => Object.fromEntries(results.map((x) => [x.ic, x.status]));
/** The example with a code for "both sexes" on its two totals, as decision 9 asks of every coordinate. */
function clean() {
  const d = doc();
  for (const f of figures(d)) if (!f.dimensions[SD + 'sex']) f.dimensions[SD + 'sex'] = { '@id': 'http://purl.org/linked-data/sdmx/2009/code#sex-T' };
  return d;
}
test('Data Cube: a clean cube passes IC-1, IC-2, IC-11, IC-12 and IC-14, each with something to evaluate', async () => {
  const results = integrity(await cubeOf(clean()));
  assert.deepEqual(status(results), { 'IC-1': 'pass', 'IC-2': 'pass', 'IC-11': 'pass', 'IC-12': 'pass', 'IC-14': 'pass' });
  for (const x of results) assert.ok(x.evaluated > 0, x.ic);
});
test('Data Cube: the example as published passes IC-1, IC-2, IC-11, IC-12 and IC-14', async () => {
  // PLATO 3ef2063 gave the example's two totals the SDMX code sex-T; before that they had no sex,
  // though the structure declares it, and failed IC-11 and IC-12. The control below keeps that case.
  const results = integrity(await cubeOf(doc()));
  assert.deepEqual(status(results), { 'IC-1': 'pass', 'IC-2': 'pass', 'IC-11': 'pass', 'IC-12': 'pass', 'IC-14': 'pass' });
});
test('control: a total without its sex code fails IC-11 and IC-12, as the example once did', async () => {
  const d = doc();
  const total = d.spatialEntities[0].attestations[0].properties.find((f) => f['@id'].endsWith('/agri/total'));
  delete total.dimensions[`${SD}sex`];
  const results = integrity(await cubeOf(d));
  assert.deepEqual(status(results), { 'IC-1': 'pass', 'IC-2': 'pass', 'IC-11': 'fail', 'IC-12': 'fail', 'IC-14': 'pass' });
  assert.deepEqual(results[2].violations, [`${T}/agri/total has no ${SD}sex`]);
});
const TYPE = '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>';
// Each planted defect fails its constraint, and no other except where the spec makes it follow:
// an observation missing a coordinate is also, by IC-12's query, a duplicate of the total that
// agrees with it on the rest; a second table (IC-1) is a data set with no structure (IC-2).
const ALSO = { 'IC-1': ['IC-2'], 'IC-11': ['IC-12'] };
for (const [ic, why, plant] of [
  ['IC-1', 'an observation in two data sets', (c) => c + `<${T}/agri/m> <${QB}dataSet> <https://example.org/other-table> .\n`],
  ['IC-2', 'a data set with two structures', (c) => c + `<${T}> <${QB}structure> <https://example.org/other-structure> .\n`],
  ['IC-11', 'an observation that has lost a coordinate', (c) => lines(c).filter((l) => !l.startsWith(`<${T}/agri/f> <${SD}sex>`)).join('\n') + '\n'],
  ['IC-12', 'two observations at one address', (c) => c + lines(c).filter((l) => l.startsWith(`<${T}/agri/m> `)).map((l) => l.replace(`<${T}/agri/m>`, `<${T}/agri/m-again>`)).join('\n') + '\n'],
  ['IC-14', 'an observation with a value that lost its measure statement', (c) => lines(c).filter((l) => !l.startsWith(`<${T}/agri/f> <https://whgazetteer.org/example/measure/persons>`)).join('\n') + '\n'],
  ['IC-14', 'a dash that lost its obsStatus', (c) => lines(c).filter((l) => !l.startsWith(`<${T}/miner/f> <${SA}obsStatus>`)).join('\n') + '\n'],
]) {
  test(`Data Cube: ${ic} catches ${why}`, async () => {
    const c = await cubeOf(clean());
    const planted = plant(c);
    assert.notEqual(planted, c);
    const s = status(integrity(planted));
    assert.equal(s[ic], 'fail', JSON.stringify(s));
    for (const [k, v] of Object.entries(s)) if (k !== ic) assert.equal(v, (ALSO[ic] || []).includes(k) ? 'fail' : 'pass', `${k} with ${why}`);
  });
}
test('Data Cube: a constraint over nothing is reported as not tested, never as passed', async () => {
  const judgements = readFileSync(`${PLATO_REPO}/schemas/examples/place-centric-judgements.json`, 'utf8');
  const r = await go([textFile(judgements, 'j.json')], 'convert', 'ntriples', { cube: true });
  const results = integrity(outText(r.e, 'j.nt'));
  assert.deepEqual(status(results), { 'IC-1': 'not-tested', 'IC-2': 'not-tested', 'IC-11': 'not-tested', 'IC-12': 'not-tested', 'IC-14': 'not-tested' });
  for (const x of results) assert.equal(x.evaluated, 0);
  // observations whose structure declares nothing of its own: the export still declares the area it
  // adds, so IC-11 and IC-12 have that to evaluate, but no measure is declared, so IC-14 has nothing
  const bare = oneFigure({ dimensions: { 'https://example.org/dim/a': 'v' } }, []);
  bare.dataSets[0].structure = 'https://example.org/t/s';
  const s = status(integrity(await cubeOf(bare)));
  assert.deepEqual(s, { 'IC-1': 'pass', 'IC-2': 'pass', 'IC-11': 'pass', 'IC-12': 'pass', 'IC-14': 'not-tested' });
});
// What this guards is the algorithm, not the machine: IC-12 groups observations by their dimension
// values, so ten times the observations take about ten times as long; comparing every pair would take
// a hundred times as long. The ratio of two runs in the same process holds on a loaded machine, where
// a fixed limit in seconds did not (31–81 s at load 100+, against 14–25 s alone). A generous ceiling
// still catches a collapse that hits both sizes alike.
test('Data Cube: IC-12 groups rather than pairs, so ten times the observations take about ten times as long', async () => {
  const head = `<https://example.org/t> <${QB}structure> <https://example.org/s> .\n<https://example.org/s> <${QB}component> _:a .\n_:a <${QB}dimension> <https://example.org/dim/a> .\n<https://example.org/s> <${QB}component> _:b .\n_:b <${QB}dimension> <https://example.org/dim/b> .\n`;
  const cube = (n) => {
    const obs = [];
    for (let i = 0; i < n; i++) obs.push(`<https://example.org/o/${i}> <${QB}dataSet> <https://example.org/t> .\n<https://example.org/o/${i}> <https://example.org/dim/a> "${i % 1000}" .\n<https://example.org/o/${i}> <https://example.org/dim/b> "${Math.floor(i / 1000)}" .\n`);
    return head + obs.join('');
  };
  const timed = (text) => { const t0 = performance.now(); const r = integrity(text)[3]; return [r, performance.now() - t0]; };
  timed(cube(1000));                                   // warm the code paths, so the first size is not paying for them
  const [small, tSmall] = timed(cube(10000));
  const [clean12, tLarge] = timed(cube(100000));
  assert.deepEqual([small.status, small.evaluated], ['pass', 10000]);
  assert.deepEqual([clean12.status, clean12.evaluated], ['pass', 100000]);
  const dup = integrity(cube(100000) + `<https://example.org/o/dup> <${QB}dataSet> <https://example.org/t> .\n<https://example.org/o/dup> <https://example.org/dim/a> "7" .\n<https://example.org/o/dup> <https://example.org/dim/b> "3" .\n`)[3];
  assert.deepEqual(dup.violations, ['https://example.org/t: https://example.org/o/3007 and https://example.org/o/dup have the same dimension values']);
  assert.ok(tLarge / tSmall < 30, `ten times the observations took ${(tLarge / tSmall).toFixed(1)} times as long (${tSmall.toFixed(0)} ms, ${tLarge.toFixed(0)} ms): pairwise is about 100`);
  assert.ok(tLarge < 180000, `${tLarge.toFixed(0)} ms for 100,000 observations`);
});
test('--cube: a figure with neither a value nor an obsStatus gets no measure, and is reported', async () => {
  const d = doc(); const f = figures(d)[4]; delete f.attributes;
  const { r, text } = await nt(d, 'd.json', { cube: true });
  assert.ok(errors(r).length, 'the schema reports it too');
  assert.equal(warnings(r, 'cube-no-value')[0]?.examples[0], `${T}/miner/f`);
  assert.ok(!lines(text).some((l) => l.startsWith(`<${T}/miner/f> <https://whgazetteer.org/example/measure/persons>`)));
});
test('the command line writes the cube with --cube, and the plain graph without it', () => {
  const dir = mkdtempSync(`${process.env.TMPDIR || '/tmp'}/plato-tools-cube-`);
  try {
    const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
    for (const [flag, want] of [[['--cube'], 21], [[], 0]]) {
      const r = spawnSync(process.execPath, [CLI, 'convert', '--to', 'ntriples', '--overwrite', '--out', dir, ...flag, STATS], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(cubeLines(readFileSync(`${dir}/place-centric-statistics.nt`, 'utf8')).length, want, flag.join(' ') || 'no flag');
    }
    const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    assert.match(help.stdout, /--cube\s+N-Triples output/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The derived area and date must reach the table's structure, or the checks cannot use them: found
// on Vision of Britain, where the same row in 55 counties read as 28,620 duplicates under IC-12.
const REF_AREA = SD + 'refArea', REF_PERIOD = SD + 'refPeriod';
/** Two counties with the same figures, and a structure that lists neither area nor date. */
function twoCounties({ secondPeriod } = {}) {
  const d = clean();
  d.dataSets[0].structure.components = d.dataSets[0].structure.components.filter((c) => c.dimension !== REF_AREA && c.dimension !== REF_PERIOD);
  const se = d.spatialEntities[0], other = structuredClone(se);
  other['@id'] = se['@id'] + '-2'; other.label = 'Other County';
  for (const f of other.attestations[0].properties) { f['@id'] += '-2'; if (f.universe) f.universe += '-2'; }
  if (secondPeriod) other.attestations[0].timespans = [secondPeriod];
  d.spatialEntities.push(other);
  return d;
}
const declares = (text, prop) => new RegExp(`<http://purl.org/linked-data/cube#dimension> <${prop.replace(/[.#]/g, '\\$&')}>`).test(text);
test('--cube declares refArea in each structure, so the same row in two places is not a duplicate', async () => {
  const text = await cubeOf(twoCounties());
  assert.ok(declares(text, REF_AREA), 'refArea is declared');
  assert.ok(declares(text, REF_PERIOD), 'refPeriod is declared where every figure has one');
  assert.deepEqual(status(integrity(text)), { 'IC-1': 'pass', 'IC-2': 'pass', 'IC-11': 'pass', 'IC-12': 'pass', 'IC-14': 'pass' });
});
test('control: without refArea declared, the two counties read as duplicates under IC-12', async () => {
  const text = (await cubeOf(twoCounties())).split('\n').filter((l) => !(l.includes('cube#dimension') && l.includes('refArea'))).join('\n') + '\n';
  assert.equal(status(integrity(text))['IC-12'], 'fail');
});
test('--cube declares refPeriod only where every figure of the table has one, and reports the rest', async () => {
  const { r, text } = await nt(twoCounties({ secondPeriod: { startEarliest: '1887', endLatest: '1891', sourceLabel: '1887-91' } }), 'p.json', { cube: true });
  assert.ok(declares(text, REF_AREA));
  assert.ok(!declares(text, REF_PERIOD), 'refPeriod is not declared for a table where some figures have none');
  assert.ok(r.report.items.some((i) => i.kind === 'cube-period-partial'), JSON.stringify(r.report.items.map((i) => i.kind)));
  assert.equal(status(integrity(text))['IC-11'], 'pass', 'no figure fails for a date the source never gives');
});
test('--cube does not declare a component twice when the structure already lists it', async () => {
  const text = await cubeOf(clean());
  assert.equal((text.match(/cube#dimension> <http:\/\/purl\.org\/linked-data\/sdmx\/2009\/dimension#refArea>/g) || []).length, 1);
});
