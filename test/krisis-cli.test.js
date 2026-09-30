// Krisis on the command line (bin/plato-tools.mjs match, apply), run as a user runs it: a separate
// process, files on disk, exit status and output read back, and the work file compared with what
// the engine gives for the same files.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, file } from './engine.js';
import { detect } from '../src/engine/input.js';
import { match } from '../src/engine/krisis/match.js';
import { readWork, serialiseWork, decide } from '../src/engine/krisis/work.js';

const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const made = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'plato-tools-krisis-test-')); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const X = 'https://example.org/';
const src = { '@id': X + 'source/s', title: 'S', authorityType: 'source' };
const at = (lon, lat) => ({ geometries: [{ geojson: { type: 'Point', coordinates: [lon, lat] } }], sources: [src] });
const doc = (ds, places) => ({ profile: 'place-centric', gazetteer: { '@id': X + ds, title: `Dataset ${ds}` },
  spatialEntities: places.map(([id, label, point]) => ({ '@id': `${X}${ds}/${id}`, label, attestations: point ? [at(...point)] : [{ names: [{ toponym: label }], sources: [src] }] })) });
function fixtures(withUnaddressed = false) {
  const dir = scratch();
  const a = doc('a', [['newton', 'Newton', [-1, 52]], ['springfield', 'Springfield', [-89.65, 39.8]]]);
  if (withUnaddressed) a.spatialEntities.push({ label: 'Nowhere', attestations: [at(0, 51)] });
  const b = doc('b', [['newton', 'Newton', [-1.01, 52.01]], ['newton-far', 'Newton', [-3, 55]], ['springfeld', 'Springfeld', [-89.6, 39.78]]]);
  writeFileSync(join(dir, 'a.json'), JSON.stringify(a)); writeFileSync(join(dir, 'b.json'), JSON.stringify(b));
  return dir;
}

test('match writes the work file the engine makes, and exits 0', async () => {
  const dir = fixtures();
  const r = cli('match', join(dir, 'a.json'), '--with', join(dir, 'b.json'), '--out', dir);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^Places to match: .*a\.json: a PLATO JSON document \(place-centric\)\nOther dataset: {3}.*b\.json: /);
  assert.match(r.out, /\n {2}2 possible matches to review\. Compared 2 places with 3 places of the other dataset; 2 places have suggestions\. Not suggested: 1 pair alike in name but further apart than the greatest distance\./);
  assert.match(r.out, /Wrote .*a\.krisis\.json/);
  const written = readWork(readFileSync(join(dir, 'a.krisis.json'), 'utf8'));
  const engine = await match({ subjects: await detect([file(join(dir, 'a.json'))]), others: await detect([file(join(dir, 'b.json'))]), options: { now: written.generated_at } }, env());
  assert.deepEqual(written, engine.work);
  assert.equal(written.candidates.length, 2);
});
test('match: options are passed on, and a place without an address exits 1', () => {
  const dir = fixtures(true);
  const r = cli('match', join(dir, 'a.json'), '--with', join(dir, 'b.json'), '--out', dir, '--max-distance', '1000', '--top', '1', '--json');
  assert.equal(r.code, 1, r.out + r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.status, 'problems');
  assert.deepEqual(j.items.map((i) => i.kind), ['no-address']);
  const w = readWork(readFileSync(join(dir, 'a.krisis.json'), 'utf8'));
  assert.equal(w.match_parameters.maxDistanceKm, 1000);
  assert.equal(w.match_parameters.topK, 1);
});
test('match: a command that is wrong exits 2, and an existing work file is not replaced unasked', () => {
  const dir = fixtures();
  assert.equal(cli('match', join(dir, 'a.json')).code, 2, 'no --with');
  assert.equal(cli('match', join(dir, 'a.json'), '--with', join(dir, 'b.json'), '--threshold', '2').code, 2);
  assert.equal(cli('match', join(dir, 'a.json'), '--with', join(dir, 'missing.json'), '--out', dir).code, 2);
  assert.equal(cli('check', join(dir, 'a.json'), '--with', join(dir, 'b.json')).code, 2, '--with is for match');
  assert.equal(cli('match', join(dir, 'a.json'), '--with', join(dir, 'b.json'), '--out', dir).code, 0);
  const again = cli('match', join(dir, 'a.json'), '--with', join(dir, 'b.json'), '--out', dir);
  assert.equal(again.code, 2);
  assert.match(again.out, /already exists; give --overwrite/);
  assert.equal(cli('match', join(dir, 'a.json'), '--with', join(dir, 'b.json'), '--out', dir, '--overwrite').code, 0);
});
test('apply makes the decisions into a file the checker passes; a tampered work file exits 2', () => {
  const dir = fixtures();
  assert.equal(cli('match', join(dir, 'a.json'), '--with', join(dir, 'b.json'), '--out', dir).code, 0);
  const w = readWork(readFileSync(join(dir, 'a.krisis.json'), 'utf8'));
  decide(w, w.candidates.find((c) => c.candidate_candidate === `${X}b/newton`).id, 'match');
  decide(w, w.candidates.find((c) => c.candidate_candidate === `${X}b/springfeld`).id, 'distinct', { basis: 'Another state.' });
  writeFileSync(join(dir, 'review.json'), serialiseWork(w));
  // No reviewer, in the file or given: nothing written.
  const anon = cli('apply', join(dir, 'a.json'), '--review', join(dir, 'review.json'), '--out', dir);
  assert.equal(anon.code, 2, anon.out + anon.err);
  assert.ok(!existsSync(join(dir, 'a.krisis-attestations.json')));
  const r = cli('apply', join(dir, 'a.json'), '--review', join(dir, 'review.json'), '--out', dir, '--reviewer', 'A. Reviewer', '--orcid', 'https://orcid.org/0000-0002-1825-0097');
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /Made 2 new attestations: 1 accepting 1 match, 1 saying that two places are different\./);
  const out = join(dir, 'a.krisis-attestations.json');
  const d = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(d.attestations.map((a) => [a.about, a.contributor.name, !!a.negated]), [[`${X}a/newton`, 'A. Reviewer', false], [`${X}a/springfield`, 'A. Reviewer', true]]);
  const checked = cli('check', out);
  assert.equal(checked.code, 0, checked.out);
  assert.match(checked.out, /attestation-centric/);
  // Tampered: a confirmed candidate with no decision.
  const t = JSON.parse(serialiseWork(w)); t.candidates[0].decision = null;
  writeFileSync(join(dir, 'tampered.json'), JSON.stringify(t));
  const bad = cli('apply', join(dir, 'a.json'), '--review', join(dir, 'tampered.json'), '--out', scratch(), '--reviewer', 'R');
  assert.equal(bad.code, 2, bad.out);
  assert.match(bad.out, /The work file cannot be used/);
  // The whole dataset is not yet available; an unknown output is a wrong command.
  assert.equal(cli('apply', join(dir, 'a.json'), '--review', join(dir, 'review.json'), '--out', scratch(), '--reviewer', 'R', '--output', 'dataset').code, 2);
  assert.equal(cli('apply', join(dir, 'a.json'), '--review', join(dir, 'review.json'), '--output', 'everything').code, 2);
  assert.equal(cli('apply', join(dir, 'a.json')).code, 2, 'no --review');
});
