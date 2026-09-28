// The Data Cube checks read a cube export as a stream, so that one of any size can be checked: Vision
// of Ireland's is 957 MB, more than the longest string JavaScript allows, which broke the checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { integrity, integrityOfFile } from '../src/lib/datacube.js';
import { PLATO_REPO } from './paths.js';
import { existsSync } from 'node:fs';

const QB = 'http://purl.org/linked-data/cube#';
// A cube with blank-node components, large enough to be read in many chunks (about 20 MB).
function cube(n, dup = false) {
  const head = `<https://example.org/t> <${QB}structure> <https://example.org/s> .\n<https://example.org/s> <${QB}component> _:a .\n_:a <${QB}dimension> <https://example.org/dim/a> .\n<https://example.org/s> <${QB}component> _:b .\n`;
  const obs = [];
  for (let i = 0; i < n; i++) obs.push(`<https://example.org/o/${i}> <${QB}dataSet> <https://example.org/t> .\n<https://example.org/o/${i}> <https://example.org/dim/a> "${i % 1000}" .\n<https://example.org/o/${i}> <https://example.org/dim/b> "${Math.floor(i / 1000)}" .\n`);
  // What component _:b is comes only at the end, so the one blank node is named in two chunks.
  const tail = dup ? `<https://example.org/o/dup> <${QB}dataSet> <https://example.org/t> .\n<https://example.org/o/dup> <https://example.org/dim/a> "7" .\n<https://example.org/o/dup> <https://example.org/dim/b> "0" .\n` : '';
  return head + obs.join('') + tail + `_:b <${QB}dimension> <https://example.org/dim/b> .\n`;
}
const summary = (rs) => rs.map((r) => [r.ic, r.status, r.evaluated, r.violations.length]);
const dir = mkdtempSync(join(tmpdir(), 'plato-dc-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('the streamed checks give the same results as the in-memory ones, across many chunks', async () => {
  for (const dup of [false, true]) {
    const text = cube(100000, dup);
    const want = summary(integrity(text));
    assert.deepEqual(summary(await integrityOfFile(new File([text], 'c.nt'))), want, `dup ${dup}`);
    assert.deepEqual(summary(await integrityOfFile(new File([gzipSync(text)], 'c.nt.gz'))), want, `gzipped, dup ${dup}`);
  }
});
test('a blank node named in two chunks is one node: the structure keeps both components', async () => {
  const r = await integrityOfFile(new File([cube(100000)], 'c.nt'));
  assert.equal(r.find((x) => x.ic === 'IC-11').evaluated, 200000, 'both dimensions are found for every observation');
});

const cli = (...args) => spawnSync(process.execPath, ['bin/plato-tools.mjs', ...args], { encoding: 'utf8' });
test('plato-tools datacube: 0 when every constraint passes, 1 when one fails, 2 for a file it cannot read', () => {
  const good = join(dir, 'good.nt'), bad = join(dir, 'bad.nt');
  writeFileSync(good, cube(2000)); writeFileSync(bad, cube(2000, true));
  // IC-14 has no measure to evaluate in this cube, so it is not tested, which is not a pass.
  let r = cli('datacube', good);
  assert.match(r.stdout, /IC-12  passes, 2,000 evaluated/);
  assert.match(r.stdout, /IC-14  NOT TESTED/);
  assert.equal(r.status, 1, 'a constraint not tested is not a pass');
  r = cli('datacube', bad);
  assert.match(r.stdout, /IC-12  FAILS \(1\)/);
  assert.equal(r.status, 1);
  // A real cube export that passes everything: the draft example, through convert --cube.
  const ex = `${PLATO_REPO}/schemas/examples/place-centric-statistics.json`;
  if (existsSync(ex)) {
    const c = cli('convert', '--to', 'ntriples', '--cube', '--out', dir, '--overwrite', ex);
    assert.equal(c.status, 0, c.stdout + c.stderr);
    r = cli('datacube', join(dir, 'place-centric-statistics.nt'));
    assert.equal(r.status, 0, r.stdout);
    assert.equal((r.stdout.match(/ passes, /g) || []).length, 5, r.stdout);
  }
  r = cli('datacube', join(dir, 'missing.nt'));
  assert.equal(r.status, 2, r.stdout + r.stderr);
  r = cli('datacube', '--json', bad);
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.results.find((x) => x.ic === 'IC-12').violationCount, 1);
});
