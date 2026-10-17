// The command line's `revise` (bin/plato-tools.mjs; src/engine/revise.js): it writes what the engine writes,
// with the right exit status; a wrong command is a mistake (exit 2), not a fault in the tools; and a revision
// refused in words writes nothing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, textFile, outText } from './engine.js';
import { detect } from '../src/engine/input.js';
import { revise } from '../src/engine/revise.js';

const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const made = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'plato-tools-revise-test-')); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const X = 'https://example.org/g/';
const src = { '@id': X + 'source/s', title: 'S' };
const att = (id, name) => ({ '@id': `${X}place/${id.split(':')[0]}#a-${id.split(':')[1]}`, names: [{ toponym: name }], citations: [{ source: src }], created: '2026-01-01T00:00:00Z' });
const place = (k, label, attestations) => ({ '@id': X + 'place/' + k, label, attestations });
const G = { '@id': X + 'release/v1', title: 'G', licence: 'https://creativecommons.org/licenses/by/4.0/', status: 'published', version: 'v1', uriSpace: X };
const v1 = { profile: 'place-centric', gazetteer: G, spatialEntities: [place('a', 'A', [att('a:11111111', 'Alpha'), att('a:22222222', 'Alfa')]), place('b', 'B', [att('b:33333333', 'Beta')])] };
const v2 = { profile: 'place-centric', gazetteer: { ...G, '@id': X, version: undefined, status: 'draft' }, spatialEntities: [place('a', 'A', [att('a:11111111', 'Alpha'), att('a:22222222', 'Alfa respelt')]), place('b', 'B', [])] };
function files() {
  const d = scratch();
  writeFileSync(join(d, 'v1.json'), JSON.stringify(v1)); writeFileSync(join(d, 'v2.json'), JSON.stringify(v2));
  return { d, v1: join(d, 'v1.json'), v2: join(d, 'v2.json') };
}

test('revise writes the revised dataset the engine writes, and exits 0; --json carries the counts; the same again is refused unless --overwrite', async () => {
  const { d, v1: p1, v2: p2 } = files();
  const DATE = '2026-10-17T12:00:00Z';
  const r = cli('revise', p2, '--previous', p1, '--reviewer', 'R. Viewer', '--release', 'v2', '--date', DATE, '--out', d, '--json');
  assert.equal(r.code, 0, r.out + r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.status, 'ok'); assert.equal(j.errors, 0);
  assert.deepEqual([j.counts.superseded, j.counts.retracted, j.counts.added, j.counts.versionCheck.lost], [1, 1, 0, 0]);
  assert.deepEqual(j.outputs.map((o) => o.path), [join(d, 'v2-revised.json'), join(d, 'v2.release.json')]);
  const account = JSON.parse(readFileSync(join(d, 'v2.release.json'), 'utf8'));
  assert.deepEqual([account.format, account.counts.superseded, account.counts.retracted, account.counts.unchanged, account.maintainer], ['plato-tools-release', 1, 1, 1, { name: 'R. Viewer' }]);
  // What the engine writes in-process, given the same date, byte for byte.
  const e = env();
  const same = await revise({ earlier: await detect([textFile(JSON.stringify(v1), 'v1.json')]), later: await detect([textFile(JSON.stringify(v2), 'v2.json')]), options: { reviewer: { name: 'R. Viewer' }, release: 'v2', date: DATE } }, e);
  assert.equal(readFileSync(join(d, 'v2-revised.json'), 'utf8'), outText(e, same.outputs[0].name));
  // The words, without --json, say what was done and what was written.
  const again = cli('revise', p2, '--previous', p1, '--reviewer', 'R. Viewer', '--release', 'v2', '--out', d);
  assert.equal(again.code, 2, again.out + again.err);
  assert.match(again.out, /already exists; give --overwrite to replace it/);
  const over = cli('revise', p2, '--previous', p1, '--reviewer', 'R. Viewer', '--release', 'v2', '--out', d, '--overwrite', '--brief');
  assert.equal(over.code, 0, over.out + over.err);
  assert.match(over.out, /The new version was revised: nothing published is deleted or changed\. Kept 1 attestation; superseded 1 and retracted 1\./);
  assert.match(over.out, /Wrote .*v2-revised\.json/);
  assert.match(over.out, /Wrote .*v2\.release\.json/);
});

test('a wrong command exits 2 with its mistake: no --previous, no --reviewer, a bad --orcid, a bad --date, --date with another command, two inputs', () => {
  const { d, v1: p1, v2: p2 } = files();
  const problem = (args, re) => { const r = cli('revise', ...args); assert.equal(r.code, 2, r.out + r.err); assert.match(r.err, re); };
  problem([p2, '--reviewer', 'R', '--out', d], /revise needs --previous/);
  problem([p2, '--previous', p1, '--out', d], /revise needs --reviewer/);
  problem([p2, '--previous', p1, '--reviewer', 'R', '--orcid', 'nope', '--out', d], /give the ORCID in full/);
  problem([p2, '--previous', p1, '--reviewer', 'R', '--date', 'yesterday', '--out', d], /--date yesterday is not a date/);
  problem([p2, p1, '--previous', p1, '--reviewer', 'R', '--out', d], /revise takes one dataset, the new version; 2 were given/);
  const other = cli('check', p1, '--date', '2026-10-17');
  assert.equal(other.code, 2); assert.match(other.err, /--date is for revise/);
  assert.deepEqual(readdirSync(d).sort(), ['v1.json', 'v2.json'], 'nothing written');
  assert.match(cli('--help').out, /plato-tools revise \[options\] NEW --previous PUBLISHED --reviewer NAME/);
});

test('refused in words (the same release name as the previous release\'s; a previous release without addresses): exit 2, the reason given, and nothing written', () => {
  const { d, v1: p1, v2: p2 } = files();
  const same = cli('revise', p2, '--previous', p1, '--reviewer', 'R', '--release', 'v1', '--out', d, '--json');
  assert.equal(same.code, 2, same.out + same.err);
  const j = JSON.parse(same.out);
  assert.equal(j.status, 'failed');
  assert.ok(j.items.some((i) => i.kind === 'same-release'), JSON.stringify(j.items));
  assert.deepEqual(j.outputs, []);
  const un = { ...v1, spatialEntities: v1.spatialEntities.map((p) => ({ ...p, attestations: p.attestations.map(({ '@id': _, ...a }) => a) })) };
  writeFileSync(join(d, 'v1-unminted.json'), JSON.stringify(un));
  const unminted = cli('revise', p2, '--previous', join(d, 'v1-unminted.json'), '--reviewer', 'R', '--out', d);
  assert.equal(unminted.code, 2, unminted.out + unminted.err);
  assert.match(unminted.out, /Give the copy with addresses that the site was made from/);
  assert.ok(!existsSync(join(d, 'v2-revised.json')) && !existsSync(join(d, 'v2.release.json')), 'nothing written');
  // The presence: the same command with a new release name writes it.
  const ok = cli('revise', p2, '--previous', p1, '--reviewer', 'R', '--release', 'v2', '--out', d, '--brief');
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.ok(existsSync(join(d, 'v2-revised.json')));
});
