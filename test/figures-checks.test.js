// The checks on a table's figures (plan #34, item 11, branch B0; the design in Issue #14, docs/statistics.md).
// A copy of PLATO's statistics example with seven planted faults, each of which must be caught as Stephen
// decided (Q9): the Data Cube's integrity constraints IC-1, 2, 11, 12 and 14 (and IC-19 when a code file is
// given) and the structural faults of a figure (a universe that is no figure, a table or a coordinate its
// table does not declare, a value that is not a number) BLOCK; the arithmetic of a universe's parts WARNS.
// Measured on the code before this branch, four of the seven passed every check the tools had.
//
// Elenchos (check) reads the dataset: the kinds figure-*. Arithmos (the datacube action, check.cube in
// Methodos, `datacube` on the command line) reads the cube export: the integrity constraints and P-1 to P-4,
// named so that they are not confused with the W3C's numbering. Every constraint is shown to pass over a
// non-zero count on the clean example, to fail on its planted fault, and to be "not tested" over nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { openSqlite } from '../src/lib/store.js';
import { PLATO_REPO } from './paths.js';
import { res, textFile, outText, go } from './engine.js';
import { integrity, graph, checks, cubeChecks } from './datacube.js';
import { OPERATIONS, ADAPTERS, RECIPES, checkRecipe, refsOf, runner, runStep, problemOf } from '../src/engine/methodos/index.js';

const STATS = `${PLATO_REPO}/schemas/examples/place-centric-statistics.json`;
const EXAMPLE = existsSync(STATS) ? JSON.parse(readFileSync(STATS, 'utf8')) : null;
const doc = () => structuredClone(EXAMPLE);
const QB = 'http://purl.org/linked-data/cube#', SD = 'http://purl.org/linked-data/sdmx/2009/dimension#';
const T = 'https://whgazetteer.org/example/table/occupations-1851';
const figures = (d) => d.spatialEntities.flatMap((e) => (e.attestations || []).flatMap((a) => a.properties || []));
const figure = (d, tail) => figures(d).find((f) => f['@id'] === `${T}/${tail}`);
const kinds = (r, severity) => r.report.items.filter((i) => i.severity === severity).map((i) => i.kind);
const verdicts = (results) => Object.fromEntries(results.map((x) => [x.ic, x.status]));
const cubeOf = async (d) => outText((await go([textFile(JSON.stringify(d), 'c.json')], 'convert', 'ntriples', { cube: true })).e, 'c.nt');

test('PLATO\'s statistics example is there to test against', () => {
  assert.ok(existsSync(STATS), `${STATS} not found: set PLATO_REPO to a checkout of PLATO at the pinned commit`);
});

// ---- the seven planted faults -------------------------------------------------------------------------
// Each: what is planted, what Elenchos says of the dataset (an error kind, or none: the fault is in the cube),
// and what the cube check says: the constraints that fail (blocking) and those that warn. `also` are the
// constraints that fail with it by the rules of the cube (an observation missing a coordinate is also a
// duplicate of the total that agrees with it on the rest, IC-12's query; a universe in another table is no
// universe of the same table, P-1).
const FAULTS = [
  { name: 'a universe that is no figure', plant: (d) => { figure(d, 'agri/total').universe = 'https://example.org/nowhere'; },
    elenchos: ['figure-universe-missing'], fails: ['P-1'], warns: [] },
  { name: 'a figure with its sex coordinate removed', plant: (d) => { delete figure(d, 'agri/m').dimensions[`${SD}sex`]; },
    elenchos: [], fails: ['IC-11', 'IC-12'], warns: [] },
  { name: 'the table\'s period widened to 1851-1861', plant: (d) => { d.spatialEntities[0].attestations[0].timespans[0].endLatest = '1861'; },
    elenchos: [], fails: ['IC-11'], warns: [] },
  { name: 'a value written as the string "280"', plant: (d) => { figure(d, 'agri/m').value = '280'; },
    elenchos: ['figure-value-not-number'], fails: ['P-4'], warns: [] },
  { name: 'parts that do not sum to their total', plant: (d) => { figure(d, 'agri/m').value = 999; },
    elenchos: [], fails: [], warns: ['P-2'] },
  { name: 'a coordinate the table\'s structure does not declare', plant: (d) => { figure(d, 'agri/total').dimensions['https://example.org/dim/extra'] = { '@id': 'https://example.org/c/x' }; },
    elenchos: ['figure-coordinate-undeclared'], fails: ['P-3'], warns: [] },
  { name: 'a figure whose table is not in dataSets', plant: (d) => { figure(d, 'agri/total').dataSet = 'https://example.org/other-table'; },
    elenchos: ['figure-table-undeclared', 'figure-universe-other-table'], fails: ['IC-2', 'P-1'], warns: [] },
];

const ALL = ['IC-1', 'IC-2', 'IC-11', 'IC-12', 'IC-14', 'P-1', 'P-2', 'P-3', 'P-4'];
test('the clean example: Elenchos finds nothing, and every constraint of the cube passes over something', async () => {
  const check = await go([textFile(JSON.stringify(doc()), 'd.json')], 'check');
  assert.deepEqual([kinds(check, 'error'), kinds(check, 'warning')], [[], []]);
  const results = cubeChecks(graph(await cubeOf(doc())));
  assert.deepEqual(results.map((x) => x.ic), ALL);
  assert.deepEqual(verdicts(results), Object.fromEntries(ALL.map((ic) => [ic, 'pass'])));
  // The counts each evaluated: the three universe links, the one family of parts (the agricultural labourers' two sexes),
  // every statement that is a coordinate, a measure or an attribute (5 areas, 5 periods, 10 codes, 4 values; the one printed dash's status is SDMX's own, not asked for), the 4 values.
  assert.deepEqual(Object.fromEntries(results.filter((x) => x.ic.startsWith('P-')).map((x) => [x.ic, x.evaluated])), { 'P-1': 3, 'P-2': 1, 'P-3': 24, 'P-4': 4 });
  for (const x of results) assert.ok(x.evaluated > 0, x.ic);
  // The datacube action says the same in a report: no problem, no warning, and a note for each constraint with its count.
  const r = await go([textFile(await cubeOf(doc()), 'c.nt')], 'datacube');
  assert.deepEqual([r.report.errors, kinds(r, 'warning')], [0, []]);
  assert.equal(r.report.items.filter((i) => i.severity === 'note').length, ALL.length);
  assert.match(r.report.items.find((i) => i.kind === 'cube-checked' && /^P-2 /.test(i.message)).message, /^P-2 .*passes, 1 evaluated; 1 not summed/);
});

for (const f of FAULTS) {
  test(`planted fault: ${f.name} is caught${f.fails.length ? ', and stops the workflow' : ', and warns without stopping it'}`, async () => {
    const d = doc(); f.plant(d);
    const json = JSON.stringify(d);
    // Elenchos, on the dataset.
    const check = await go([textFile(json, 'd.json')], 'check');
    assert.deepEqual(kinds(check, 'error').sort(), f.elenchos.slice().sort(), JSON.stringify(check.report.items));
    // The cube check, on the export: the constraints that fail are the planted fault's (and what follows from it by the rules of the cube), none else.
    const cube = await cubeOf(d);
    const results = cubeChecks(graph(cube));
    assert.deepEqual(results.filter((x) => x.status === 'fail' && x.blocks).map((x) => x.ic), f.fails, JSON.stringify(verdicts(results)));
    assert.deepEqual(results.filter((x) => x.status === 'fail' && !x.blocks).map((x) => x.ic), f.warns);
    // The same through the engine's action, from the dataset and from the cube: a failure is an error (it blocks), the arithmetic a warning.
    for (const [file, name] of [[json, 'd.json'], [cube, 'c.nt']]) {
      const r = await go([textFile(file, name)], 'datacube');
      const errors = kinds(r, 'error').filter((k) => !k.startsWith('figure-'));
      assert.deepEqual(errors.slice().sort(), f.fails.map((ic) => ic.toLowerCase()).sort(), `${name}: ${JSON.stringify(r.report.items)}`);
      assert.deepEqual(kinds(r, 'warning').filter((k) => !['cube-no-period', 'cube-no-structure'].includes(k)), f.warns.map((ic) => ic.toLowerCase()), name);
      // What Methodos does with it: the step stops on an error, and goes on past a warning.
      assert.equal(problemOf(r) !== null, f.fails.length > 0, name);
    }
  });
}

test('the control: the five integrity constraints alone miss four of the seven, which is what the figure checks are for', async () => {
  const missed = [];
  for (const f of FAULTS) {
    const d = doc(); f.plant(d);
    const old = integrity(await cubeOf(d));
    if (old.every((x) => x.status === 'pass')) missed.push(f.name);
  }
  assert.equal(missed.length, 4, missed.join('; '));
  // And the new ones are not the cause of anything on the clean example (the presence this absence is told from).
  assert.ok(verdicts(integrity(await cubeOf(doc()))) && Object.values(verdicts(integrity(await cubeOf(doc())))).every((s) => s === 'pass'));
  assert.deepEqual(checks(graph(await cubeOf(doc()))).map((x) => x.ic), ['IC-1', 'IC-2', 'IC-11', 'IC-12', 'IC-14']);
});

// ---- Elenchos, the kinds, one by one ---------------------------------------------------------------------
test('a universe that is itself, or goes round in a circle, or is a figure of another table, is an error (the presence: the good example has none)', async () => {
  const bad = async (plant) => { const d = doc(); plant(d); return kinds(await go([textFile(JSON.stringify(d), 'd.json')], 'check'), 'error'); };
  assert.deepEqual(await bad(() => {}), []);
  assert.deepEqual(await bad((d) => { figure(d, 'agri/m').universe = `${T}/agri/m`; }), ['figure-universe-cycle']);
  assert.deepEqual(await bad((d) => { figure(d, 'all/total').universe = `${T}/agri/m`; }), ['figure-universe-cycle']);
  // A second table, described in dataSets, with a figure of its own that the first table's figure takes as its universe.
  assert.deepEqual(await bad((d) => {
    d.dataSets.push({ ...structuredClone(d.dataSets[0]), '@id': 'https://example.org/t2' });
    const other = structuredClone(figure(d, 'all/total')); other['@id'] = 'https://example.org/t2/all'; other.dataSet = 'https://example.org/t2'; delete other.universe;
    d.spatialEntities[0].attestations[0].properties.push(other);
    figure(d, 'agri/total').universe = other['@id'];
  }), ['figure-universe-other-table']);
});
test('a value that is not a number is an error whatever it is written as; a printed dash (no value, a status) and a number are not', async () => {
  const bad = async (value) => { const d = doc(); figure(d, 'agri/m').value = value; return kinds(await go([textFile(JSON.stringify(d), 'd.json')], 'check'), 'error'); };
  for (const v of ['280', '280 or so', true, { a: 1 }]) assert.deepEqual(await bad(v), ['figure-value-not-number'], JSON.stringify(v));
  for (const v of [280, 0, 1.5]) assert.deepEqual(await bad(v), [], String(v));
  const d = doc();                                                                 // the example's own dash: no value, and a status
  assert.equal(figure(d, 'miner/f').value, undefined);
  assert.deepEqual(kinds(await go([textFile(JSON.stringify(d), 'd.json')], 'check'), 'error'), []);
});
test('the kinds are found whatever the document is read through: RDF (the cube export read back), and the order of the records', async () => {
  for (const f of FAULTS.filter((x) => x.elenchos.length)) {
    const d = doc(); f.plant(d);
    const back = await go([textFile(await cubeOf(d), 'c.nt')], 'check');
    for (const k of f.elenchos) assert.ok(kinds(back, 'error').includes(k), `${f.name}: ${k}: ${JSON.stringify(back.report.items.map((i) => [i.severity, i.kind]))}`);
  }
  const ok = await go([textFile(await cubeOf(doc()), 'c.nt')], 'check');
  assert.deepEqual(kinds(ok, 'error').filter((k) => k.startsWith('figure-')), []);
});
test('a figure in an attestation-centric document is checked as in a place-centric one', async () => {
  const d = doc(); FAULTS[0].plant(d);
  const att = { $schema: 'https://w3id.org/plato/schemas/attestation-centric.schema.json', profile: 'attestation-centric', gazetteer: d.gazetteer, dataSets: d.dataSets,
    attestations: d.spatialEntities.flatMap((e) => e.attestations.map((a) => ({ ...a, about: e['@id'] }))) };
  const r = await go([textFile(JSON.stringify(att), 'a.json')], 'check');
  assert.deepEqual(kinds(r, 'error'), ['figure-universe-missing'], JSON.stringify(r.report.items));
  const clean = structuredClone(att); figure({ spatialEntities: [{ attestations: clean.attestations }] }, 'agri/total').universe = `${T}/all/total`;
  assert.deepEqual(kinds(await go([textFile(JSON.stringify(clean), 'a.json')], 'check'), 'error'), []);
});

// ---- the cube, constraint by constraint, over nothing and over something --------------------------------
const lines = (nt) => nt.split('\n').filter(Boolean);
test('P-1 to P-4 over nothing are not tested, never passed (a cube with no universe, no partition or no measure)', async () => {
  const judgements = readFileSync(`${PLATO_REPO}/schemas/examples/place-centric-judgements.json`, 'utf8');
  const nothing = cubeChecks(graph(outText((await go([textFile(judgements, 'j.json')], 'convert', 'ntriples', { cube: true })).e, 'j.nt')));
  assert.deepEqual(verdicts(nothing), Object.fromEntries(ALL.map((ic) => [ic, 'not-tested'])));
  for (const x of nothing) assert.equal(x.evaluated, 0, x.ic);
  // One universe taken away: P-1 has two links left, and the family of the labourers' sexes (P-2) is still there; both universes gone: P-1 and P-2 have nothing.
  const cube = await cubeOf(doc());
  const without = cubeChecks(graph(lines(cube).filter((l) => !l.includes('plato#universe>')).join('\n') + '\n'));
  assert.deepEqual(without.filter((x) => x.status === 'not-tested').map((x) => x.ic), ['P-1', 'P-2']);
  assert.deepEqual(without.filter((x) => x.status === 'pass').map((x) => x.ic), ['IC-1', 'IC-2', 'IC-11', 'IC-12', 'IC-14', 'P-3', 'P-4']);
  // The report says so in words, as a warning that does not stop the workflow, and the constraint is not among those passed.
  const r = await go([textFile(judgements, 'j.json')], 'datacube');
  assert.equal(r.report.errors, 0);
  assert.equal(problemOf(r), null);
  assert.equal(kinds(r, 'warning').filter((k) => k === 'cube-not-tested').length, 5);   // the five integrity constraints; P-1 to P-4 over nothing are noted, not warned
  assert.ok(r.report.items.every((i) => !/passes/.test(i.message)));
});
test('P-2: parts are summed by partition, in the one dimension in which they differ from their whole; a lone part, a part with no value, and parts that differ in two are not summed', async () => {
  const p2 = async (plant) => { const d = doc(); plant(d); return cubeChecks(graph(await cubeOf(d))).find((x) => x.ic === 'P-2'); };
  const clean = await p2(() => {});
  assert.deepEqual([clean.status, clean.evaluated, clean.violations], ['pass', 1, []]);
  const wrong = await p2((d) => { figure(d, 'agri/f').value = 21; });
  assert.deepEqual([wrong.status, wrong.evaluated, wrong.violations.length], ['fail', 1, 1]);
  assert.match(wrong.violations[0], /agri\/total.*300.*parts.*301/);
  // A part without a value (a dash) leaves the family unsummed: it is not evaluated, and not passed.
  const dash = await p2((d) => { const f = figure(d, 'agri/f'); delete f.value; f.attributes = { 'http://purl.org/linked-data/sdmx/2009/attribute#obsStatus': { '@id': 'https://whgazetteer.org/example/code/obs-status/nil-or-not-applicable' } }; });
  assert.deepEqual([dash.status, dash.evaluated], ['not-tested', 0]);
  // The whole of a single part is not summed: "of which" is not a partition (the example's 1000 against its one listed occupation, 300).
  assert.equal(clean.violations.length, 0);
  // Another partition of the same whole, in another dimension, is summed on its own: sex-T against two occupations that do not add up.
  const second = await p2((d) => {
    const extra = (tail, occupation, v) => { const f = structuredClone(figure(d, 'agri/total')); f['@id'] = `${T}/${tail}`; f.value = v; f.dimensions['https://whgazetteer.org/example/dim/occupation'] = { '@id': `https://whgazetteer.org/example/code/occupation/${occupation}` }; f.universe = `${T}/all/total`; d.spatialEntities[0].attestations[0].properties.push(f); };
    extra('x/total', 'x', 300); extra('y/total', 'y', 300);
  });
  assert.deepEqual([second.status, second.evaluated, second.violations.length], ['fail', 2, 1]);
  assert.match(second.violations[0], /all\/total.*1000.*parts.*900/);
});

test('P-3: a coordinate or attribute a figure has that its table\'s structure does not declare, as the planted fault, and not one that it does', async () => {
  const d = doc(); FAULTS[5].plant(d);
  const p3 = cubeChecks(graph(await cubeOf(d))).find((x) => x.ic === 'P-3');
  assert.deepEqual([p3.status, p3.evaluated, p3.violations.length], ['fail', 25, 1]);
  assert.match(p3.violations[0], /agri\/total.*dim\/extra/);
  // Declared in the structure, the same coordinate passes (the presence).
  const e = doc(); FAULTS[5].plant(e);
  e.dataSets[0].structure.components.push({ dimension: 'https://example.org/dim/extra' });
  assert.equal(cubeChecks(graph(await cubeOf(e))).find((x) => x.ic === 'P-3').status, 'pass');
});
test('P-4: a measure whose value is not a number, whatever it looks like; numbers of any XSD kind pass', async () => {
  for (const v of ['280', 'about 280', true]) {
    const d = doc(); figure(d, 'agri/m').value = v;
    const p4 = cubeChecks(graph(await cubeOf(d))).find((x) => x.ic === 'P-4');
    assert.deepEqual([p4.status, p4.evaluated, p4.violations.length], ['fail', 4, 1], JSON.stringify(v));
  }
  for (const v of [280, 0, 1.5, -3]) {
    const d = doc(); figure(d, 'agri/m').value = v;
    assert.equal(cubeChecks(graph(await cubeOf(d))).find((x) => x.ic === 'P-4').status, 'pass', String(v));
  }
});

// ---- IC-19: every value of a coordinate with a code list is in it, when a code file is given -------------
const SKOS = 'http://www.w3.org/2004/02/skos/core#', OCC = 'https://whgazetteer.org/example/dim/occupation';
const SCHEME = 'https://whgazetteer.org/example/code/occupation';
const codeFile = (codes) => [`<${OCC}> <${QB}codeList> <${SCHEME}> .`, ...codes.map((c) => `<${SCHEME}/${c}> <${SKOS}inScheme> <${SCHEME}> .`)].join('\n') + '\n';
test('IC-19: with a code file, every occupation of the cube is in its code list; a value outside it fails; without a file there is no IC-19 line', async () => {
  const cube = await cubeOf(doc());
  const full = cubeChecks(graph(cube, { codes: codeFile(['all', 'agricultural-labourer', 'miner']) }));
  assert.deepEqual(full.filter((x) => x.ic === 'IC-19').map((x) => [x.status, x.evaluated, x.blocks]), [['pass', 5, true]]);
  const missing = cubeChecks(graph(cube, { codes: codeFile(['all', 'agricultural-labourer']) })).find((x) => x.ic === 'IC-19');
  assert.deepEqual([missing.status, missing.evaluated, missing.violations.length], ['fail', 5, 1]);
  assert.match(missing.violations[0], /miner\/f.*occupation\/miner/);
  assert.equal(cubeChecks(graph(cube)).some((x) => x.ic === 'IC-19'), false);
  // A code file that declares no code list gives IC-19 nothing to evaluate: not tested, never passed.
  const none = cubeChecks(graph(cube, { codes: `<${SCHEME}/all> <${SKOS}inScheme> <${SCHEME}> .\n` })).find((x) => x.ic === 'IC-19');
  assert.deepEqual([none.status, none.evaluated], ['not-tested', 0]);
  // Through the engine: given as the second file, a failure is an error that blocks.
  const r = await go([textFile(cube, 'c.nt')], 'datacube', undefined, { codes: textFile(codeFile(['all']), 'codes.nt') });
  assert.deepEqual(kinds(r, 'error'), ['ic-19']);
  assert.equal((await go([textFile(cube, 'c.nt')], 'datacube', undefined, { codes: textFile(codeFile(['all', 'agricultural-labourer', 'miner']), 'codes.nt') })).report.errors, 0);
});

// ---- Methodos: the operation and its adapter ---------------------------------------------------------------
test('the operation check.cube is declared (Arithmos, automatic, nothing given on, the code file optional) and has an adapter', () => {
  const o = OPERATIONS['check.cube'];
  assert.equal(o.tool, 'Arithmos');
  assert.equal(o.kind, 'automatic');
  assert.equal(o.available, true);
  assert.deepEqual(Object.keys(o.takes), ['dataset', 'codes']);
  assert.equal(o.takes.codes.optional, true);
  assert.deepEqual(o.gives, {});
  assert.equal(typeof ADAPTERS['check.cube'], 'function');
});
function memoryHost(initial) {
  const store = new Map(initial.map((f) => [f.name, f]));
  return {
    store,
    open: async (r) => store.get(r.name) || new File([], r.name),
    file: async (o) => store.get(o.name),
    env() {
      const e = {
        resources: res, csvMeta: res.csvMeta, xlsx: XLSX, openDb: () => openSqlite(sqlite3InitModule, { memory: true }),
        output: async (name) => { const parts = []; return { write: (s) => parts.push(s), writeBytes: (b) => parts.push(b), close: async () => { const f = new File(parts, name); store.set(name, f); return { name, size: f.size }; } }; },
        tree: undefined,
      };
      return { env: e, finish: () => {} };
    },
  };
}
const MINI = {
  key: 'cube-check-test', title: 'Convert to a cube and check it', version: 1, files: { files: { words: 'A dataset with figures', types: ['files'] } },
  steps: [
    { id: 'cube', op: 'convert', title: 'Write the Data Cube', from: { files: '$files' }, options: { target: 'ntriples', cube: true } },
    { id: 'check', op: 'check.cube', title: 'Check the Data Cube', from: { dataset: 'cube.dataset' } },
  ],
};
test('in a workflow: convert to a cube, then check.cube; a fault in the figures stops the step in words, the arithmetic does not, and a clean cube is done with a report that counts what it evaluated', async () => {
  checkRecipe(MINI);
  const walk = async (plant) => {
    const d = doc(); plant(d);
    const file = textFile(JSON.stringify(d), 'figures.json');
    const host = memoryHost([file]);
    const made = await runStep(runner.next(runner.start(MINI, {}, { files: await refsOf([file], 'files') })), host);   // the conversion
    if (made.state.status === 'stopped') return { made };
    return { made, checked: await runStep(runner.next(made.state), host) };
  };
  const step = (w, id) => w.state.steps.find((x) => x.id === id);
  const clean = await walk(() => {});
  assert.equal(step(clean.checked, 'check').state, 'done');
  assert.deepEqual(clean.checked.report.counts.checks.map((x) => [x.ic, x.status, x.evaluated > 0]), ALL.map((ic) => [ic, 'pass', true]));
  // A fault in the cube (a coordinate removed): the check stops, in words naming the constraint that failed.
  const stopped = await walk(FAULTS[1].plant);
  assert.equal(step(stopped.checked, 'check').state, 'stopped');
  assert.match(step(stopped.checked, 'check').problem.words, /IC-11 fails/);
  // A universe that is no figure is found by the conversion already (Elenchos), and the cube is never checked.
  const early = await walk(FAULTS[0].plant);
  assert.equal(early.checked, undefined);
  assert.equal(step(early.made, 'cube').state, 'stopped');
  assert.match(step(early.made, 'cube').problem.words, /universe/);
  // Parts that do not sum: the step is done, with the warning.
  const warned = await walk(FAULTS[4].plant);
  assert.equal(step(warned.checked, 'check').state, 'done');
  assert.deepEqual(kinds({ report: warned.checked.report }, 'warning'), ['p-2']);
});
test('check.cube refuses a file it cannot read in words, and takes a PLATO dataset or a cube alike', async () => {
  const ok = textFile(JSON.stringify(doc()), 'figures.json'), nt = textFile(await cubeOf(doc()), 'figures.nt'), junk = textFile('this is not data', 'junk.txt');
  const host = memoryHost([ok, nt, junk]);
  for (const f of [ok, nt]) {
    const r = await ADAPTERS['check.cube']({ inputs: { dataset: await refsOf([f], 'files') }, options: {}, host });
    assert.equal(r.problem, undefined, f.name);
    assert.equal(r.report.counts.checks.length, ALL.length, f.name);
  }
  const junkRefs = await refsOf([junk], 'files');
  await assert.rejects(() => ADAPTERS['check.cube']({ inputs: { dataset: junkRefs }, options: {}, host }), /The dataset was not recognised as data these tools read/);
});

// ---- the command line, which is the same code ------------------------------------------------------------
const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
test('the command line: datacube prints P-1 to P-4 beside the integrity constraints, exits 1 on a failure, 0 on a warning, and --json says which block', async () => {
  const dir = mkdtempSync(`${process.env.TMPDIR || '/tmp'}/plato-tools-figures-`);
  try {
    const run = (...args) => { const r = spawnSync(process.execPath, [CLI, 'datacube', ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
    const write = async (name, plant) => { const d = doc(); plant?.(d); const p = join(dir, name); writeFileSync(p, await cubeOf(d)); return p; };
    const clean = run(await write('clean.nt'));
    assert.equal(clean.code, 0, clean.out + clean.err);
    for (const ic of ALL) assert.match(clean.out, new RegExp(`${ic} +passes, [1-9][0-9,]* evaluated`), ic);
    const dangling = run(await write('dangling.nt', FAULTS[0].plant));
    assert.equal(dangling.code, 1);
    assert.match(dangling.out, /P-1 +FAILS \(1\)/);
    assert.match(dangling.out, /nowhere/);
    const sums = run(await write('sums.nt', FAULTS[4].plant));
    assert.equal(sums.code, 0, 'the arithmetic warns, it does not fail the command');
    assert.match(sums.out, /P-2 +WARNS \(1\)/);
    const j = JSON.parse(run('--json', await write('sums-json.nt', FAULTS[4].plant)).out);
    assert.deepEqual(j.results.filter((x) => x.status === 'fail').map((x) => [x.ic, x.blocks]), [['P-2', false]]);
    assert.deepEqual(j.results.map((x) => x.ic), ALL);
    // A code file given with --codes adds IC-19; not given, there is no IC-19 line.
    const codes = join(dir, 'codes.nt'); writeFileSync(codes, codeFile(['all', 'agricultural-labourer']));
    const withCodes = run('--codes', codes, await write('codes-clean.nt'));
    assert.equal(withCodes.code, 1);
    assert.match(withCodes.out, /IC-19 +FAILS \(1\)/);
    assert.doesNotMatch(clean.out, /IC-19/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
