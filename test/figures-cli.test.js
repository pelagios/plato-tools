// A table of figures on the command line (bin/plato-tools.mjs): convert --columns FILE with the roles of
// figures, then datacube on what it wrote, run as a user runs them, a separate process with files on disk.
// The first test of the branch's design is here again through the command line: figures written as one
// attestation to a row (attestation-centric) go through --cube and datacube.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const FX = fileURLToPath(new URL('./fixtures/figures/', import.meta.url));
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const made = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'plato-tools-figures-')); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const TABLE = join(FX, 'example-statistics.csv'), COLUMNS = join(FX, 'example-statistics.columns.json');
const BASE = 'https://whgazetteer.org/example/';

test('convert --columns with figures --to ntriples --cube writes the cube, and datacube passes all nine checks (IC-1 to IC-14 and P-1 to P-4) over their counts', () => {
  const out = scratch();
  const c = cli('convert', '--to', 'ntriples', '--cube', '--columns', COLUMNS, '--base', BASE, '--out', out, TABLE);
  assert.equal(c.code, 0, c.out + c.err);
  assert.deepEqual(readdirSync(out).sort(), ['example-statistics.codes.nt', 'example-statistics.nt']);
  assert.match(c.out, /Wrote .*example-statistics\.nt/); assert.match(c.out, /Wrote .*example-statistics\.codes\.nt/);
  const d = cli('datacube', join(out, 'example-statistics.nt'));
  assert.equal(d.code, 0, d.out);
  assert.equal((d.out.match(/ passes, /g) || []).length, 9, d.out);
  assert.match(d.out, /IC-11 {2}passes, 20 evaluated/);
  assert.match(d.out, /IC-12 {2}passes, 5 evaluated/);
});
test('the report says what became of every cell, in the summary, beside the places and attestations', () => {
  const out = scratch();
  const c = cli('convert', '--to', 'plato-json', '--columns', COLUMNS, '--base', BASE, '--out', out, TABLE);
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /Read 5 rows, 1 place, 5 attestations, 125 triples\. 5 cells of figures: 4 figures, 1 printed dash, 0 blank, 0 left out\./);
  assert.match(c.out, /the total looked for, has no figure for occupation Miner/);
  assert.match(c.out, /Warnings\./);
});
test('the mapping is printed as it was read, with its description, in a form that can be given back', () => {
  const out = scratch();
  const c = cli('check', '--columns', COLUMNS, '--base', BASE, TABLE);
  assert.equal(c.code, 0, c.out + c.err);
  assert.match(c.out, /Occupation +dimension/); assert.match(c.out, /Persons +value/); assert.match(c.out, /Year +period/);
  const json = c.out.split('\n').find((l) => l.trim().startsWith('{"columns":'));
  assert.ok(json, c.out);
  const given = JSON.parse(json.trim());
  assert.deepEqual(given.columns.Persons, { field: 'value', measure: 'persons' });
  assert.deepEqual(given.columns.Occupation, { field: 'dimension', dimension: 'occupation' });
  assert.equal(given.table.title, JSON.parse(readFileSync(COLUMNS, 'utf8')).table.title);
  // Saved, and given back, it reads the same table the same way.
  const f = join(scratch(), 'again.json'); writeFileSync(f, json);
  const again = cli('convert', '--to', 'ntriples', '--cube', '--columns', f, '--base', BASE, '--out', out, TABLE);
  assert.equal(again.code, 0, again.out);
  const first = scratch();
  cli('convert', '--to', 'ntriples', '--cube', '--columns', COLUMNS, '--base', BASE, '--out', first, TABLE);
  assert.equal(readFileSync(join(out, 'example-statistics.nt'), 'utf8'), readFileSync(join(first, 'example-statistics.nt'), 'utf8'));
});
test('without the description a table of places is read as before: the same file, mapped as places, writes places and no code file', () => {
  const out = scratch();
  const places = join(scratch(), 'places.json'); writeFileSync(places, JSON.stringify({ County: 'name', Year: 'note', Occupation: 'note', Sex: 'note', Persons: 'note' }));
  const c = cli('convert', '--to', 'plato-json', '--columns', places, '--out', out, TABLE);
  assert.equal(c.code, 0, c.out + c.err);
  assert.deepEqual(readdirSync(out), ['example-statistics.json']);
  assert.doesNotMatch(c.out, /cells of figures/);
});
test('a description that cannot be used is a problem in the report and exit status 1, and nothing is written', () => {
  const out = scratch();
  const f = join(scratch(), 'bad.json');
  writeFileSync(f, JSON.stringify({ columns: { Year: 'period', Persons: { field: 'value' } } }));
  const c = cli('convert', '--to', 'plato-json', '--columns', f, '--out', out, TABLE);
  assert.equal(c.code, 1, c.out + c.err);
  assert.match(c.out, /no column is the places' id, their web address or their name/);
  assert.deepEqual(readdirSync(out).filter((x) => x.endsWith('.nt')), []);
});
test('figures written as one attestation to a row go through --cube and datacube: a row twice is found as a duplicate by the check, not only by the reader', () => {
  // The reader leaves a duplicate cell out; the check is for a cube made some other way. Write the cube, then plant the fault in it.
  const out = scratch();
  assert.equal(cli('convert', '--to', 'ntriples', '--cube', '--columns', COLUMNS, '--base', BASE, '--out', out, TABLE).code, 0);
  const nt = readFileSync(join(out, 'example-statistics.nt'), 'utf8');
  const obs = nt.split('\n').filter((l) => / <http:\/\/purl\.org\/linked-data\/cube#dataSet> /.test(l))[2].split(' ')[0];
  const twin = nt.split('\n').filter((l) => l.startsWith(obs + ' ')).map((l) => l.replace(obs, obs.replace('#f-', '#f-twin-'))).join('\n');
  const bad = join(out, 'bad.nt'); writeFileSync(bad, nt + twin + '\n');
  const d = cli('datacube', bad);
  assert.equal(d.code, 1, d.out);
  assert.match(d.out, /IC-12 {2}FAILS \(1\)/);
});
