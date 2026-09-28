// IC-14 (every observation has a value for every measure) exempts a declared absence: a figure with
// an sdmx-attribute:obsStatus and no value, a printed dash. obsStatus is a general attribute, though:
// "approximate" is not an absence, and a figure with that status and a value must still have its
// measure. The exemption is "a status and no plato:value_literal", which is exactly what PLATO's
// schema allows without a value, so the check never needs to know what a status code means. Found on
// the 1886 markets return, where IC-14 evaluated 24,443 observations of 24,468 with a value: the 25
// skipped were its approximate amounts, and removing the measure from one still passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { integrity } from '../src/lib/datacube.js';

const QB = 'http://purl.org/linked-data/cube#', SA = 'http://purl.org/linked-data/sdmx/2009/attribute#';
const P = 'https://w3id.org/plato#', E = 'https://example.org/';
const M = `${E}measure/amount`;
const head = `<${E}t> <${QB}structure> <${E}s> .\n<${E}s> <${QB}component> _:d .\n_:d <${QB}dimension> <${E}dim/a> .\n<${E}s> <${QB}component> _:m .\n_:m <${QB}measure> <${M}> .\n`;
/** One observation: `value` writes plato:value_literal, `measure` the direct measure statement, `status` an obsStatus. */
const obs = (n, { value = true, measure = true, status = null } = {}) =>
  `<${E}o/${n}> <${QB}dataSet> <${E}t> .\n<${E}o/${n}> <${E}dim/a> "${n}" .\n`
  + (value ? `<${E}o/${n}> <${P}value_literal> "12"^^<http://www.w3.org/2001/XMLSchema#integer> .\n` : '')
  + (measure ? `<${E}o/${n}> <${M}> "12"^^<http://www.w3.org/2001/XMLSchema#integer> .\n` : '')
  + (status ? `<${E}o/${n}> <${SA}obsStatus> <${E}code/${status}> .\n` : '');
const ic14 = (nt) => integrity(nt).find((r) => r.ic === 'IC-14');

test('IC-14: a figure with a status that is not an absence, and no measure statement, fails', () => {
  const r = ic14(head + obs(1) + obs(2, { status: 'approximate', measure: false }));
  assert.equal(r.status, 'fail', JSON.stringify(r));
  assert.deepEqual(r.violations, [`${E}o/2 has no ${M}`]);
});
test('IC-14: a figure with a status and a value is evaluated, so the count includes it', () => {
  const r = ic14(head + obs(1) + obs(2, { status: 'approximate' }) + obs(3, { status: 'approximate' }));
  assert.deepEqual([r.status, r.evaluated], ['pass', 3]);
});
test('IC-14: a declared absence (a status and no value) is still exempt, and is not counted', () => {
  const r = ic14(head + obs(1) + obs(2, { status: 'nil', value: false, measure: false }));
  assert.deepEqual([r.status, r.evaluated, r.violations], ['pass', 1, []]);
});
test('IC-14: control: a figure with no status and no measure fails', () => {
  const r = ic14(head + obs(1, { measure: false }));
  assert.deepEqual([r.status, r.violations.length], ['fail', 1]);
});

test('plato-tools datacube gives the evaluated count beside every verdict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plato-ic14-'));
  try {
    const f = join(dir, 'c.nt');
    writeFileSync(f, head + obs(1) + obs(2, { status: 'approximate' }) + obs(3, { status: 'nil', value: false, measure: false }));
    const r = spawnSync(process.execPath, ['bin/plato-tools.mjs', 'datacube', f], { encoding: 'utf8' });
    const verdicts = r.stdout.split('\n').filter((l) => /^\s+IC-\d+/.test(l));
    assert.equal(verdicts.length, 5, r.stdout);
    for (const l of verdicts) assert.match(l, /, \d[\d,]* evaluated$/, l);
    assert.match(r.stdout, /IC-14  passes, 2 evaluated/);
    assert.equal(r.status, 0, r.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
