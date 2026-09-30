// Matching (Krisis) at scale, against an answer known in advance. Two synthetic datasets of N places
// each (test/krisis-synthetic.js: half the names begin with a common word, as gazetteers' do), of
// which one place in ten of the other dataset is a variant of a subject place, a few kilometres from
// it. Runs `plato-tools match` on them as a user would, and requires it to finish within the time
// allowed and to suggest nearly every planted pair.
//
// A matcher that compares every pair of names sharing a common word or a first letter grows with the
// square of the datasets, and at 20,000 places each did not finish in two minutes; this is the check
// that it does not.
//   node e2e/match_scale.mjs [N=20000] [--seconds 120] [--work-dir DIR]
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { syntheticNames, random } from '../test/krisis-synthetic.js';

const args = process.argv.slice(2);
const flag = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const N = Number(args.find((a) => /^\d+$/.test(a)) || 20000);
const seconds = Number(flag('--seconds', 120));
const dir = mkdtempSync(join(flag('--work-dir', tmpdir()), 'plato-match-scale-'));
const X = 'https://example.org/';
const src = { '@id': X + 'source/s', title: 'S', authorityType: 'source' };

const { subjects, others, pairs } = syntheticNames({ n: N, seed: 7 });
const r = random(11);
// Points in a box of about 1,000 km a side; each planted variant within a few kilometres of its subject.
const pts = subjects.map(() => [10 + r() * 10, 40 + r() * 10]);
const plantedOf = new Map(pairs.map(([i, j]) => [j, i]));
const doc = (ds, names, point) => ({ profile: 'place-centric', gazetteer: { '@id': X + ds, title: `Synthetic ${ds}` },
  spatialEntities: names.map((label, i) => ({ '@id': `${X}${ds}/${i}`, label,
    attestations: [{ geometries: [{ geojson: { type: 'Point', coordinates: point(i) } }], sources: [src] }] })) });
writeFileSync(join(dir, 'a.json'), JSON.stringify(doc('a', subjects, (i) => pts[i])));
writeFileSync(join(dir, 'b.json'), JSON.stringify(doc('b', others, (j) => (plantedOf.has(j)
  ? [pts[plantedOf.get(j)][0] + 0.02, pts[plantedOf.get(j)][1] + 0.01] : [10 + r() * 10, 40 + r() * 10]))));

const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const t0 = Date.now();
const run = spawnSync(process.execPath, [CLI, 'match', join(dir, 'a.json'), '--with', join(dir, 'b.json'), '--out', dir, '--json'],
  { encoding: 'utf8', timeout: seconds * 1000, maxBuffer: 1 << 28 });
const elapsed = (Date.now() - t0) / 1000;
let failed = false;
const fail = (m) => { console.error(`FAIL: ${m}`); failed = true; };
if (run.error || run.status === null) fail(`plato-tools match did not finish in ${seconds} s`);
else {
  const j = JSON.parse(run.stdout);
  const work = JSON.parse(readFileSync(join(dir, 'a.krisis.json'), 'utf8'));
  const got = new Set(work.candidates.map((c) => `${c.candidate_source} ${c.candidate_candidate}`));
  const found = pairs.filter(([i, k]) => got.has(`${X}a/${i} ${X}b/${k}`)).length;
  console.log(`${N.toLocaleString('en-GB')} × ${N.toLocaleString('en-GB')} places: ${elapsed.toFixed(1)} s; `
    + `${j.counts.candidates.toLocaleString('en-GB')} suggestions, ${j.counts.comparisons?.toLocaleString('en-GB') ?? '?'} pairs of names compared; `
    + `${found} of ${pairs.length} planted pairs suggested.`);
  if (j.exitCode !== 0) fail(`exit status ${j.exitCode}`);
  if (found < pairs.length * 0.97) fail(`only ${found} of ${pairs.length} planted pairs were suggested`);
}
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
