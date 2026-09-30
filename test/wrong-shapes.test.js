import { PLATO_REPO } from './paths.js';
// A list given as something else (an object, a string, a number, true, null) where the schema
// expects an array is a fault in the data, so it is reported, never thrown: a Check must finish with
// a report that names it, and a conversion must finish too (DEVELOPERS.md, errors). A place whose
// attestations were {} once stopped the run with "(attestations || []) is not iterable".
// The arrays are found by walking PLATO's examples, not listed here, so a new one is swept too.
// Spreadsheet tables are not swept: their lists are made by their reader, never given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { go, textFile, outText } from './engine.js';
import { TARGETS } from '../src/engine/pipeline.js';

const EX = `${PLATO_REPO}/schemas/examples`;
const WRONG = [{}, 'x', 5, true, null];
const show = (v) => JSON.stringify(v);

// The first place each key holds an array, as a path; inside a GeoJSON value too.
function firstArrays(doc) {
  const found = new Map();
  (function walk(v, path) {
    if (!v || typeof v !== 'object') return;
    for (const [k, c] of Object.entries(v)) {
      if (Array.isArray(c) && !Array.isArray(v) && !found.has(k)) found.set(k, [...path, k]);
      walk(c, [...path, k]);
    }
  })(doc, []);
  return found;
}
function withValue(doc, path, value) {
  const d = structuredClone(doc); let o = d;
  for (const k of path.slice(0, -1)) o = o[k];
  o[path.at(-1)] = value; return d;
}
// Where it threw: the message and the first frame in src/.
const where = (e) => `${e.message} @ ${(String(e.stack).split('\n').find((l) => l.includes('/src/')) || '').trim()}`;

// A record the writer threw on is caught and reported as record-failed (and left out): that is a
// fault of the tools shown as one of the data, so it counts as thrown here.
const failed = (r) => r.report.items.filter((i) => i.kind === 'record-failed').map((i) => i.examples[0]);
// Every mutation, checked and converted to every target; returns what threw or went unreported.
// reported(report, key): whether the check's report says something of the key. A GeoJSON value's
// coordinates are carried as the JSON they are (PLATO's schema leaves them open), so a wrong shape
// there need not be reported; it must still not be thrown on.
async function sweep(doc, name, arrays, fileName, reported) {
  const threw = [], silent = [];
  for (const [key, path] of arrays) {
    for (const value of WRONG) {
      const text = JSON.stringify(withValue(doc, path, value));
      const label = `${name} ${path.join('.')}=${show(value)}`;
      try {
        const r = await go([textFile(text, fileName)], 'check', null);
        if (key !== 'coordinates' && !reported(r.report, key)) silent.push(label);
      } catch (e) { threw.push(`${label} check: ${where(e)}`); }
      for (const target of Object.keys(TARGETS)) {
        try { const r = await go([textFile(text, fileName)], 'convert', target); for (const x of failed(r)) threw.push(`${label} ${target}: record-failed ${x}`); }
        catch (e) { threw.push(`${label} ${target}: ${where(e)}`); }
      }
    }
  }
  return { threw, silent };
}

// Presence control: the example as it is converts, with records, to every target, and (a PLATO
// example) checks with no errors, so that an error after a change is the change's.
async function control(text, fileName, clean) {
  if (clean) assert.equal((await go([textFile(text, fileName)], 'check', null)).report.errors, 0, `${fileName} has errors of its own`);
  for (const target of Object.keys(TARGETS)) {
    const r = await go([textFile(text, fileName)], 'convert', target);
    assert.ok(!r.incomplete && r.outputs.length > 0, `${fileName} -> ${target}: no output`);
    assert.ok(Object.values(r.report.counts).some((n) => n > 0), `${fileName} -> ${target}: nothing counted ${show(r.report.counts)}`);
  }
}

const examples = readdirSync(EX).filter((f) => f.endsWith('.json')).sort();
test('the sweep has something to sweep', () => {
  assert.ok(examples.length >= 5, `only ${examples.length} examples in ${EX}`);
  const keys = new Set(examples.flatMap((f) => [...firstArrays(JSON.parse(readFileSync(`${EX}/${f}`, 'utf8'))).keys()]));
  for (const k of ['attestations', 'names', 'geometries', 'types', 'relations', 'timespans', 'citations', 'sources', 'identityRelations'])
    assert.ok(keys.has(k), `no ${k} found in the examples: the walk is not finding arrays`);
});

for (const f of examples) {
  test(`a list given as something else in ${f} is reported, never thrown`, async () => {
    const text = readFileSync(`${EX}/${f}`, 'utf8');
    const doc = JSON.parse(text);
    await control(text, f, true);
    const arrays = firstArrays(doc);
    assert.ok(arrays.size >= 3, `only ${arrays.size} arrays found`);
    const reported = (report, key) => report.errors > 0 || report.items.some((i) => JSON.stringify(i).includes(key));
    const { threw, silent } = await sweep(doc, f, arrays, f, reported);
    // silent: neither an error nor an item naming the key in the check's report.
    assert.deepEqual({ threw, silent }, { threw: [], silent: [] });
  });
}

// Linked Places Format input: a PLATO example converted to LPF, and the LPF samples, whose lists
// are the ones LPF has (some only in the samples). A list LPF has that none of them holds is added.
const LPF_KEYS = ['names', 'types', 'relations', 'links', 'timespans', 'periods', 'descriptions', 'depictions', 'citations'];
function lpfArrays(doc) {
  const found = firstArrays(doc);
  const feature = doc.features.findIndex((x) => x && typeof x === 'object');
  for (const k of LPF_KEYS) {
    if (found.has(k)) continue;
    found.set(k, k === 'timespans' || k === 'periods' ? ['features', feature, 'when', k] : ['features', feature, k]);
  }
  return found;
}
const lpfInputs = async () => {
  const r = await go([textFile(readFileSync(`${EX}/place-centric-datini.json`, 'utf8'), 'datini.json')], 'convert', 'lpf');
  return [['datini.geojson', outText(r.e, r.outputs[0].name)],
    ['lpf-sample.geojson', readFileSync('test/fixtures/lpf-sample-v1.2.2.geojson', 'utf8')],
    ['lpf-readme.geojson', readFileSync('test/fixtures/lpf-readme-example.json', 'utf8')]];
};
test('a list given as something else in Linked Places Format is reported, never thrown', async () => {
  const threw = [], silent = [];
  for (const [name, text] of await lpfInputs()) {
    await control(text, name);
    const doc = JSON.parse(text);
    // An LPF feature's when may be missing where a key is added under it.
    for (const f of doc.features) if (f && typeof f === 'object' && !f.when) f.when = { timespans: [{ start: { in: '1600' } }] };
    // LPF has no schema here: what is reported is anything the report of the unchanged file lacks.
    const before = (await go([textFile(JSON.stringify(doc), name)], 'check', null)).report;
    const kinds = new Set(before.items.map((i) => i.kind));
    const reported = (report) => report.errors > before.errors || report.items.some((i) => !kinds.has(i.kind));
    const r = await sweep(doc, name, lpfArrays(doc), name, reported);
    threw.push(...r.threw); silent.push(...r.silent);
  }
  assert.deepEqual({ threw, silent }, { threw: [], silent: [] });
});
