import { PLATO_REPO } from './paths.js';
// Which inputs the command line's arguments make (gatherInputs, src/node/host.js): the CSV files
// that are sheets of PLATO's spreadsheet tables make one set per directory, and every other CSV file
// is an input of its own. Each test that finds files apart has a control that finds them together.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatherInputs } from '../src/node/host.js';

const CUSTOMS = `${PLATO_REPO}/schemas/tables/examples/customs`;
const SHEETS = readdirSync(CUSTOMS).filter((f) => f.endsWith('.csv')).sort();
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
/** A directory holding the customs tables (if `tables`) and the other CSV files given as { name: text }. */
function dir(tables, others = {}) {
  const d = mkdtempSync(join(tmpdir(), 'plato-tools-inputs-test-')); made.push(d);
  if (tables) for (const f of SHEETS) copyFileSync(join(CUSTOMS, f), join(d, f));
  for (const [f, text] of Object.entries(others)) writeFileSync(join(d, f), text);
  return d;
}
const GAUGES = 'station,lat,lon\nKew,51.48,-0.29\n', WELLS = 'name;county\nSt Winefride;Flintshire\n';
const shape = (inputs) => inputs.map((i) => ({ label: i.label, files: i.paths.map((p) => p.split('/').pop()) }));

test('the fixture: the customs example has all ten sheets', () => assert.equal(SHEETS.length, 10, SHEETS.join()));

// ---- a directory -------------------------------------------------------------------------------
test('control: a directory whose CSV files are all sheets is one set of tables, labelled by the directory', async () => {
  const d = dir(true);
  assert.deepEqual(shape(await gatherInputs([d])), [{ label: d + '/', files: SHEETS }]);
});
test('a directory of sheets and other CSV files: the sheets are one set of tables, each other file its own input', async () => {
  const d = dir(true, { 'gauges.csv': GAUGES, 'wells.csv': WELLS });
  assert.deepEqual(shape(await gatherInputs([d])), [
    { label: `${d}/ (10 sheets of tables)`, files: SHEETS },
    { label: join(d, 'gauges.csv'), files: ['gauges.csv'] },
    { label: join(d, 'wells.csv'), files: ['wells.csv'] },
  ]);
});
test('a directory of CSV files none of which is a sheet: each is its own input', async () => {
  const d = dir(false, { 'gauges.csv': GAUGES, 'wells.csv': WELLS });
  assert.deepEqual(shape(await gatherInputs([d])), [
    { label: join(d, 'gauges.csv'), files: ['gauges.csv'] },
    { label: join(d, 'wells.csv'), files: ['wells.csv'] },
  ]);
});
test('a lone places.csv of one\'s own (not beginning place_id) is its own input; the control, the real one, is the tables', async () => {
  const own = dir(false, { 'places.csv': 'name,lat,lon\nKew,51.48,-0.29\n', 'wells.csv': WELLS });
  assert.deepEqual(shape(await gatherInputs([own])).map((i) => i.files), [['places.csv'], ['wells.csv']]);
  const real = dir(false, { 'wells.csv': WELLS });
  copyFileSync(join(CUSTOMS, 'places.csv'), join(real, 'places.csv'));
  const inputs = await gatherInputs([real]);
  assert.deepEqual(shape(inputs), [
    { label: join(real, 'places.csv'), files: ['places.csv'] },
    { label: join(real, 'wells.csv'), files: ['wells.csv'] },
  ]);
  assert.equal(inputs[0].name, real.split('/').pop(), 'the tables are named after their directory, as before');
});
test('a directory with no CSV files is still refused', async () => {
  const d = dir(false, { 'notes.txt': 'no tables here\n' });
  const [i] = await gatherInputs([d]);
  assert.match(i.failure, /holds no(ne| CSV files)/);
});

// ---- CSV files named one by one -------------------------------------------------------------------
test('control: CSV files named one by one are one set of tables per directory, labelled as before', async () => {
  const a = dir(true), b = dir(true);
  assert.deepEqual(shape(await gatherInputs([...SHEETS.map((f) => join(a, f)), ...SHEETS.map((f) => join(b, f))])), [
    { label: `${join(a, '*.csv')} (10 files)`, files: SHEETS },
    { label: `${join(b, '*.csv')} (10 files)`, files: SHEETS },
  ]);
});
test('CSV files named one by one: the sheets of a directory are one set, and each other CSV file its own input', async () => {
  const a = dir(true, { 'gauges.csv': GAUGES }), b = dir(false, { 'wells.csv': WELLS, 'gauges.csv': GAUGES });
  const args = [join(a, 'gauges.csv'), ...SHEETS.map((f) => join(a, f)), join(b, 'wells.csv'), join(b, 'gauges.csv')];
  assert.deepEqual(shape(await gatherInputs(args)), [
    { label: `${a}/ (10 sheets of tables)`, files: SHEETS },
    { label: join(a, 'gauges.csv'), files: ['gauges.csv'] },
    { label: join(b, 'wells.csv'), files: ['wells.csv'] },
    { label: join(b, 'gauges.csv'), files: ['gauges.csv'] },
  ]);
});

// ---- the command line ---------------------------------------------------------------------------
test('the command line checks the tables of a mixed directory, and the other CSV file, as two inputs', () => {
  const d = dir(true, { 'gauges.csv': GAUGES });
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url)), 'check', d], { encoding: 'utf8' });
  assert.match(r.stdout, /\(10 sheets of tables\): PLATO spreadsheet tables.*\n {2}No problems found\. Read 2 places, 4 attestations\.\n/, r.stdout + r.stderr);
  assert.match(r.stdout, /\n\S*\/gauges\.csv: /, 'the other file is an input of its own');
  assert.match(r.stdout, /\nChecked 2 inputs: /);
});
test('the command line checks two ordinary CSV files named one by one as two inputs, each a table of places', () => {
  const d = dir(false, { 'a.csv': 'name,lat,lon\nKew,51.48,-0.29\n', 'b.csv': 'name,lat,lon\nOstia,41.75,12.29\n' });
  const run = (...files) => spawnSync(process.execPath, [fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url)), 'check', ...files], { encoding: 'utf8' });
  const r = run(join(d, 'a.csv'), join(d, 'b.csv'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /\n?\S*\/a\.csv: a table of places \(CSV\)/, r.stdout);
  assert.match(r.stdout, /\n\S*\/b\.csv: a table of places \(CSV\)/);
  assert.match(r.stdout, /\nChecked 2 inputs: 2 without problems/);
  // Control: one of them alone is one input, read the same way.
  const one = run(join(d, 'a.csv'));
  assert.match(one.stdout, /a\.csv: a table of places \(CSV\)[\s\S]*\nChecked 1 input: /);
});
