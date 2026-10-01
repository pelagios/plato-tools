// Krisis on the command line (bin/plato-tools.mjs match, apply), run as a user runs it: a separate
// process, files on disk, exit status and output read back, and the work file compared with what
// the engine gives for the same files.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
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
test('apply adds the decisions to the dataset by default, or writes them alone; both pass the checker; a tampered work file exits 2', () => {
  const dir = fixtures();
  assert.equal(cli('match', join(dir, 'a.json'), '--with', join(dir, 'b.json'), '--out', dir).code, 0);
  const w = readWork(readFileSync(join(dir, 'a.krisis.json'), 'utf8'));
  decide(w, w.candidates.find((c) => c.candidate_candidate === `${X}b/newton`).id, 'match');
  decide(w, w.candidates.find((c) => c.candidate_candidate === `${X}b/springfeld`).id, 'distinct', { basis: 'Another state.' });
  writeFileSync(join(dir, 'review.json'), serialiseWork(w));
  // No reviewer, in the file or given: nothing written.
  const anon = cli('apply', join(dir, 'a.json'), '--review', join(dir, 'review.json'), '--out', dir);
  assert.equal(anon.code, 2, anon.out + anon.err);
  assert.ok(!existsSync(join(dir, 'a.krisis-dataset.json')));
  // The default: the dataset, with the attestations added, checked with the version check.
  const r = cli('apply', join(dir, 'a.json'), '--review', join(dir, 'review.json'), '--out', dir, '--reviewer', 'A. Reviewer', '--orcid', 'https://orcid.org/0000-0002-1825-0097');
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /The review was added to the dataset\. Made 2 new attestations: 1 accepting 1 match, 1 saying that two places are different\. The dataset of 2 places had 2 attestations, and has 4 with 2 added; the version check found nothing deleted or changed\./);
  const ds = join(dir, 'a.krisis-dataset.json');
  assert.match(r.out, new RegExp(`Wrote ${ds.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const d = JSON.parse(readFileSync(ds, 'utf8'));
  assert.deepEqual(d.spatialEntities.map((p) => [p['@id'], p.attestations.length]), [[`${X}a/newton`, 2], [`${X}a/springfield`, 2]]);
  assert.deepEqual(d.spatialEntities.map((p) => [p.attestations[1].contributor.name, !!p.attestations[1].negated]), [['A. Reviewer', false], ['A. Reviewer', true]]);
  assert.ok(existsSync(join(dir, 'a.krisis.json')), 'the work file is not replaced by the dataset');
  const dsChecked = cli('check', ds);
  assert.equal(dsChecked.code, 0, dsChecked.out);
  const versions = cli('compare', join(dir, 'a.json'), ds);
  assert.equal(versions.code, 0, versions.out);
  // The alternative: only the new attestations.
  const r2 = cli('apply', join(dir, 'a.json'), '--review', join(dir, 'review.json'), '--out', dir, '--reviewer', 'A. Reviewer', '--output', 'attestations');
  assert.equal(r2.code, 0, r2.out + r2.err);
  assert.match(r2.out, /The review was made into attestations\. Made 2 new attestations/);
  const out = join(dir, 'a.krisis-attestations.json');
  const a = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(a.attestations.map((x) => [x.about, x.contributor.name, !!x.negated]), [[`${X}a/newton`, 'A. Reviewer', false], [`${X}a/springfield`, 'A. Reviewer', true]]);
  const checked = cli('check', out);
  assert.equal(checked.code, 0, checked.out);
  assert.match(checked.out, /attestation-centric/);
  // Tampered: a confirmed candidate with no decision.
  const t = JSON.parse(serialiseWork(w)); t.candidates[0].decision = null;
  writeFileSync(join(dir, 'tampered.json'), JSON.stringify(t));
  const bad = cli('apply', join(dir, 'a.json'), '--review', join(dir, 'tampered.json'), '--out', scratch(), '--reviewer', 'R');
  assert.equal(bad.code, 2, bad.out);
  assert.match(bad.out, /The work file cannot be used/);
  // A dataset that lacks a place the review is about: a problem, and nothing is left written.
  const lacking = scratch();
  writeFileSync(join(lacking, 'a.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8')), spatialEntities: JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8')).spatialEntities.slice(0, 1) }));
  const miss = cli('apply', join(lacking, 'a.json'), '--review', join(dir, 'review.json'), '--out', lacking, '--reviewer', 'R');
  assert.equal(miss.code, 2, miss.out);
  assert.match(miss.out, /is not in the dataset/);
  assert.ok(!existsSync(join(lacking, 'a.krisis-dataset.json')), 'the partial dataset is removed');
  // An unknown output is a wrong command.
  assert.equal(cli('apply', join(dir, 'a.json'), '--review', join(dir, 'review.json'), '--output', 'everything').code, 2);
  assert.equal(cli('apply', join(dir, 'a.json')).code, 2, 'no --review');
});
test('a reviewer with no name is a mistake in the command (exit 2), not a fault in the tools', () => {
  const dir = fixtures();
  for (const args of [['match', join(dir, 'a.json'), '--with', join(dir, 'b.json')], ['apply', join(dir, 'a.json'), '--review', join(dir, 'a.krisis.json')]]) {
    const r = cli(...args, '--out', scratch(), '--reviewer', ' ');
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.err, /--reviewer must give a name/);
    assert.doesNotMatch(r.out + r.err, /fault in the tools/);
  }
  const named = cli('match', join(dir, 'a.json'), '--with', join(dir, 'b.json'), '--out', dir, '--reviewer', 'R');
  assert.equal(named.code, 0, 'control: a reviewer with a name is taken');
  assert.equal(readWork(readFileSync(join(dir, 'a.krisis.json'), 'utf8')).reviewer.name, 'R');
});
test('spreadsheet tables: the base address matched with is kept, and apply with another warns', () => {
  const dir = fixtures();
  assert.equal(cli('convert', join(dir, 'a.json'), '--to', 'tables', '--out', dir).code, 0);
  const zip = join(dir, 'a-tables.zip');
  assert.ok(existsSync(zip));
  const m = cli('match', zip, '--with', join(dir, 'b.json'), '--out', dir, '--base', `${X}a/`);
  assert.equal(m.code, 0, m.out + m.err);
  const w = readWork(readFileSync(join(dir, 'a-tables.krisis.json'), 'utf8'));
  assert.equal(w.match_parameters.base, `${X}a/`);
  decide(w, w.candidates[0].id, 'match');
  writeFileSync(join(dir, 'review.json'), serialiseWork(w));
  const same = cli('apply', zip, '--review', join(dir, 'review.json'), '--out', scratch(), '--reviewer', 'R', '--output', 'attestations', '--base', `${X}a/`);
  assert.equal(same.code, 0, same.out);
  assert.doesNotMatch(same.out, /base address/, 'control: the same base, no warning');
  const other = cli('apply', zip, '--review', join(dir, 'review.json'), '--out', scratch(), '--reviewer', 'R', '--output', 'attestations', '--base', `${X}elsewhere/`);
  assert.match(other.out, /The review was made with the base address https:\/\/example\.org\/a\/ for the places of your spreadsheet tables, and https:\/\/example\.org\/elsewhere\/ is given now/);
});
test('--others-title: the other dataset\'s title, when it gives none, is kept in the work file and cited; without it, a warning', () => {
  const dir = fixtures();
  const b = JSON.parse(readFileSync(join(dir, 'b.json'), 'utf8')); delete b.gazetteer.title;
  writeFileSync(join(dir, 'b.json'), JSON.stringify(b));
  const plain = cli('match', join(dir, 'a.json'), '--with', join(dir, 'b.json'), '--out', scratch());
  assert.equal(plain.code, 0, plain.out + plain.err);
  assert.match(plain.out, /would cite it as its source by its file's name, b\.json/);
  const given = cli('match', join(dir, 'a.json'), '--with', join(dir, 'b.json'), '--out', dir, '--others-title', 'Dataset B');
  assert.equal(given.code, 0, given.out + given.err);
  assert.doesNotMatch(given.out, /file's name/, 'a title given: no warning');
  const w = readWork(readFileSync(join(dir, 'a.krisis.json'), 'utf8'));
  assert.deepEqual([w.others.title, w.others.titleFrom], ['Dataset B', 'given']);
  decide(w, w.candidates.find((c) => c.candidate_candidate === `${X}b/newton`).id, 'match');
  writeFileSync(join(dir, 'review.json'), serialiseWork(w));
  const r = cli('apply', join(dir, 'a.json'), '--review', join(dir, 'review.json'), '--out', dir, '--reviewer', 'R', '--output', 'attestations');
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'a.krisis-attestations.json'), 'utf8')).attestations.map((a) => a.citations[0].source.title), ['Dataset B']);
  assert.equal(cli('match', join(dir, 'a.json'), '--with', join(dir, 'b.json'), '--out', scratch(), '--others-title', ' ').code, 2, 'an empty title is a mistake in the command');
  assert.equal(cli('check', join(dir, 'a.json'), '--others-title', 'X').code, 2, '--others-title is for match and apply');
});
test('--columns: a table of places is matched by the mapping given, which the work file keeps for apply; a file that is not a mapping exits 2', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'roman.csv'), 'id,label,town,lat,lon\nbath,Spa Site,Aquae Sulis,51.3811,-2.3590\n');
  writeFileSync(join(dir, 'b.json'), JSON.stringify(doc('b', [['bath', 'Aquae Sulis', [-2.36, 51.38]]])));
  const mapping = { id: 'id', label: 'note', town: 'name', lat: 'latitude', lon: 'longitude' };
  writeFileSync(join(dir, 'columns.json'), JSON.stringify(mapping));
  const guessed = cli('match', join(dir, 'roman.csv'), '--with', join(dir, 'b.json'), '--out', scratch(), '--base', `${X}a/`, '--json');
  assert.equal(guessed.code, 0, guessed.out + guessed.err);
  assert.equal(JSON.parse(guessed.out).counts.candidates, 0, 'absence: by the guess, "Spa Site" is the name');
  const mapped = cli('match', join(dir, 'roman.csv'), '--with', join(dir, 'b.json'), '--out', dir, '--base', `${X}a/`, '--columns', join(dir, 'columns.json'), '--json');
  assert.equal(mapped.code, 0, mapped.out + mapped.err);
  assert.equal(JSON.parse(mapped.out).counts.candidates, 1, 'presence: by the mapping, "Aquae Sulis" is');
  const w = readWork(readFileSync(join(dir, 'roman.krisis.json'), 'utf8'));
  assert.deepEqual(w.match_parameters.columns, mapping);
  decide(w, w.candidates[0].id, 'match');
  writeFileSync(join(dir, 'review.json'), serialiseWork(w));
  const out = scratch();
  const applied = cli('apply', join(dir, 'roman.csv'), '--review', join(dir, 'review.json'), '--out', out, '--reviewer', 'R', '--base', `${X}a/`, '--json');
  assert.equal(applied.code, 0, applied.out + applied.err);
  assert.equal(JSON.parse(applied.out).errors, 0, applied.out);
  const written = JSON.parse(readFileSync(join(out, 'roman.krisis-dataset.json'), 'utf8'));
  assert.deepEqual(written.spatialEntities[0].attestations.flatMap((a) => (a.names || []).map((n) => n.toponym)), ['Aquae Sulis'], 'apply read the table by the review\'s mapping');
  // Not a mapping: a list, or an object whose columns are not each given a field's name (readWork would refuse the work file).
  for (const [file, text] of [['not-columns.json', '["town"]'], ['not-fields.json', '{"town":5,"label":{"x":1}}']]) {
    writeFileSync(join(dir, file), text);
    for (const action of [['match', '--with', join(dir, 'b.json')], ['apply', '--review', join(dir, 'review.json')]]) {
      const out = scratch();
      const r = cli(action[0], join(dir, 'roman.csv'), ...action.slice(1), '--out', out, '--base', `${X}a/`, '--reviewer', 'R', '--columns', join(dir, file));
      assert.equal(r.code, 2, `${file} ${action[0]}: ${r.out}${r.err}`);
      assert.match(r.err, /--columns .* must hold one JSON object/);
      assert.deepEqual(readdirSync(out), [], 'nothing written');
    }
  }
});
test('match: a IIIF Georeference Annotation as the other dataset is refused with its reason, not as a fault in the tools', () => {
  const dir = fixtures();
  const georef = fileURLToPath(new URL('./fixtures/hermes-detect/loc-chesapeake-annotationpage.json', import.meta.url));
  const r = cli('match', join(dir, 'a.json'), '--with', georef, '--out', scratch(), '--json');
  assert.equal(r.code, 2, r.out + r.err);
  const j = JSON.parse(r.out);
  assert.match(j.message, /IIIF Georeference Annotation/);
  assert.doesNotMatch(r.out + r.err, /fault in the tools/);
  assert.equal(cli('match', join(dir, 'a.json'), '--with', join(dir, 'b.json'), '--out', scratch()).code, 0, 'control: the PLATO JSON beside it is matched');
});
