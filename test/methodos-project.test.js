// Methodos: the project file (plan #34, item A2; src/engine/methodos/project.js). A whole workflow in
// one zip, its manifest first, every part's size and SHA-256 checked as it streams. Every refusal is
// paired with the same project, untouched, opening; every absence (no token in it) with a presence
// (what is in it, found by the same search).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { RECIPES, runner, recordOf, reconcile, refsOf } from '../src/engine/methodos/index.js';
import { writeProject, readProject, checkManifest, describe, projectName, ProjectError, FORMAT, VERSION, EXTENSION, MANIFEST, RECORD, REVIEW, HANDBACK } from '../src/engine/methodos/project.js';
import { stepAt } from '../src/methodos/seams.js';

const { start, next, complete } = runner;
const MYD = RECIPES['map-your-data'];
const NOW = new Date('2026-10-12T10:00:00Z');
const TOKEN = 'whg-token-7f3a9c2e1d0b4a68';
const file = (text, name, type = 'application/json') => new File([text], name, { type });

const TABLE = file('id,name,parish,county\n1,Mill Farm,Newton,Cheshire\n', 'parishes.csv', 'text/csv');
const DATASET = file(JSON.stringify({ profile: 'place-centric', spatialEntities: [{ '@id': 'https://example.org/parishes/1' }] }), 'parishes.json');
const MAPPING = file('{"name": "name"}', 'columns.json');

function work(subjects, { decided = true } = {}) {
  return {
    krisis: 3, generated_at: '2026-10-12T09:00:00Z', algorithm_version: 'test', match_parameters: { threshold: 0.85 },
    subjects: { title: 'Parishes', files: [{ name: subjects.name, size: subjects.size, sha256: subjects.sha256 }] }, others: { title: 'Gazetteer', files: [{ name: 'gazetteer.json', size: 1, sha256: 'b'.repeat(64) }] },
    places: { 'https://example.org/parishes/1': { label: 'Mill Farm', names: ['Mill Farm'], point: [-2.4, 53.3] } },
    candidates: [{ id: 'c1', candidate_source: 'https://example.org/parishes/1', candidate_candidate: 'https://w3id.org/whg/id/gn:9000001', similarity_score: 1, distance_km: null,
      candidate_status: decided ? 'confirmed' : 'suggested', other: { label: 'Mill Farm', names: ['Mill Farm'], point: [-2.4, 53.3] },
      decision: decided ? { kind: 'match', identityType: 'exactMatch', decided_at: '2026-10-12T09:30:00Z' } : null }],
    reviewer: null, cursor: 0, regions: {}, lookups: [],
  };
}

/** Map your data, without regions, at the review: its columns matched, checked, converted and looked up; the files each step made, as Files. */
async function atReview() {
  const [table] = await refsOf([TABLE], 'files');
  let s = start(MYD, { 'has-regions': false, 'will-draw': false, 'will-publish': false, target: 'plato-json' }, { files: [table] });
  const [mapping] = await refsOf([MAPPING], 'mapping');
  s = complete(next(s), 'columns', { mapping: [mapping] });
  s = complete(next(s), 'check', {});
  const [dataset] = await refsOf([DATASET], 'dataset');
  s = complete(next(s), 'dataset', { dataset: [dataset] });
  const lookupWork = file(JSON.stringify(work(dataset, { decided: false })), 'parishes.krisis.json');
  const [looked] = await refsOf([lookupWork], 'work.krisis');
  s = complete(next(s), 'lookup', { work: [looked] });
  s = runner.next(s);   // the review: interactive, so it waits for the user
  const record = recordOf({ ...s, id: 'map-your-data-mgx1', scope: { where: { countries: ['GB'] }, types: [], sources: ['gn'] } }, { name: 'Parishes', now: NOW });
  const blobs = new Map([[table.sha256, TABLE], [mapping.sha256, MAPPING], [dataset.sha256, DATASET], [looked.sha256, lookupWork]]);
  const files = [table, mapping, dataset, looked].map((ref) => ({ ref, blob: blobs.get(ref.sha256) }));
  return { record, files, refs: { table, mapping, dataset, looked }, review: { name: 'parishes.krisis.json', text: JSON.stringify(work(dataset), null, 2) + '\n' } };
}

/** The project's bytes, written as the page writes it, a chunk at a time. */
async function written(opts) {
  const chunks = [];
  const r = await writeProject({ tools: { version: '0.9.0-alpha.2', commit: 'f'.repeat(40) }, now: NOW, ...opts }, async (c) => { chunks.push(c); });
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; }
  assert.equal(out.length, r.size);
  return { bytes: out, manifest: r.manifest, chunks: chunks.length };
}
/** Read `bytes` back as a stream of `size`-byte pieces (as a File's stream gives them), every file kept by a sink in memory. */
async function read(bytes, { size = 4096, name = 'p.platoproj' } = {}) {
  async function* pieces() { for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size); }
  const sink = async (part) => { const got = []; return { write: (c) => { got.push(c); }, close: async () => new Blob(got), abort: async () => { got.length = 0; } }; };
  return readProject(pieces(), { sink, name });
}
const refused = (p, re) => assert.rejects(p, (e) => e instanceof ProjectError && re.test(e.message));
/** A project's zip with one entry changed by `fn(entries)`, re-zipped (the manifest kept first). */
function rezip(bytes, fn) {
  const entries = unzipSync(bytes);
  fn(entries);
  const order = [MANIFEST, ...Object.keys(entries).filter((k) => k !== MANIFEST)].filter((k) => entries[k]);
  return zipSync(Object.fromEntries(order.map((k) => [k, entries[k]])));
}

test('the manifest round trip: written and read back, every part is what was put in, by bytes', async () => {
  const p = await atReview();
  const handback = { handback: 1, workflow: p.record.id, files: [{ type: 'dataset', name: 'parishes.drawn.json', size: 12, sha256: 'c'.repeat(64) }], at: NOW.getTime() };
  const { bytes, manifest, chunks } = await written({ record: p.record, files: p.files, review: p.review, handback });
  assert.ok(chunks > 1, 'handed on a chunk at a time');
  assert.equal(projectName(p.record), `Parishes${EXTENSION}`);
  // The zip's own order: the manifest first, then the record.
  assert.deepEqual(Object.keys(unzipSync(bytes)).slice(0, 2), [MANIFEST, RECORD]);
  assert.equal(manifest.format, FORMAT); assert.equal(manifest.version, VERSION);
  assert.deepEqual(manifest.tools, { version: '0.9.0-alpha.2', commit: 'f'.repeat(40) });
  assert.equal(manifest.created, NOW.toISOString());
  assert.deepEqual(manifest.workflow, { id: 'map-your-data-mgx1', name: 'Parishes', recipe: { key: 'map-your-data', version: MYD.version }, at: 'review' });
  assert.deepEqual(manifest.parts.map((x) => [x.path, x.role]), [[RECORD, 'record'], [REVIEW, 'review'], [HANDBACK, 'handback'],
    ...p.files.map((f) => [`files/${f.ref.sha256}`, 'file'])]);
  assert.deepEqual(manifest.parts.filter((x) => x.role === 'file').map((x) => [x.name, x.own]), [['parishes.csv', true], ['columns.json', false], ['parishes.json', false], ['parishes.krisis.json', false]]);

  const r = await read(bytes);
  assert.deepEqual(r.manifest, manifest);
  assert.deepEqual(r.record, p.record);
  assert.deepEqual(r.record.scope, { where: { countries: ['GB'] }, types: [], sources: ['gn'] }, 'the Scope travels in the record');
  assert.equal(r.review.text, p.review.text); assert.equal(r.review.name, 'parishes.krisis.json');
  assert.equal(r.review.work.candidates[0].decision.kind, 'match', 'the decisions travel');
  assert.deepEqual(r.handback, handback);
  assert.equal(r.files.length, 4);
  for (const { part, result } of r.files) {
    const was = p.files.find((f) => f.ref.sha256 === part.sha256).blob;
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), new Uint8Array(await was.arrayBuffer()), part.name);
  }
  // Read in pieces of one byte too: where the chunks fall does not matter.
  const tiny = await read(bytes.slice(0, bytes.length), { size: 1 });
  assert.deepEqual(tiny.record, p.record);
  assert.match(describe(r).join('\n'), /A PLATO tools project, format version 1.*\n.*"Parishes", following map-your-data.*4 of 9 steps done, at "Decide which candidates are the same place"/);
});

test('restored at the right step: the workflow read back is at the review, as resuming after a reload finds it', async () => {
  const p = await atReview();
  const r = await read((await written({ record: p.record, files: p.files, review: p.review })).bytes);
  const v = reconcile(r.record, RECIPES[r.record.recipe.key]);
  assert.equal(v.action, 'continue');
  assert.equal(stepAt(v.state).id, 'review');
  assert.equal(v.state.status, 'waiting');
  assert.deepEqual(v.state.steps.filter((s) => s.state === 'done').map((s) => s.id), ['columns', 'check', 'dataset', 'lookup']);
  // The control: the same record a step earlier is at the lookup, so the step read is the record's, not a default.
  const earlier = { ...p.record, steps: p.record.steps.map((s) => (['lookup', 'review'].includes(s.id) ? { ...s, state: 'pending', outputs: {} } : s)), current: null, status: 'idle' };
  const e = await read((await written({ record: earlier, files: p.files.filter((f) => f.ref !== p.refs.looked) })).bytes);
  assert.equal(stepAt(reconcile(e.record, MYD).state).id, 'lookup');
});

test('a hash that does not match is refused, naming the part; the same project untouched opens', async () => {
  const p = await atReview();
  const { bytes } = await written({ record: p.record, files: p.files, review: p.review });
  await read(bytes);   // the control
  const path = `files/${p.refs.dataset.sha256}`;
  const tampered = rezip(bytes, (e) => { e[path] = e[path].slice(); e[path][5] ^= 1; });
  await refused(read(tampered), /damaged: parishes\.json \(files\/[0-9a-f]{64}\) is not the file its manifest names \(its SHA-256 differs\)/);
  const review = rezip(bytes, (e) => { e[REVIEW] = strToU8(strFromU8(e[REVIEW]).replace('Mill Farm', 'Mill Barn')); });
  await refused(read(review), /the review parishes\.krisis\.json is not the file its manifest names/);
  const cut = rezip(bytes, (e) => { e[path] = e[path].slice(0, 10); });
  await refused(read(cut), /parishes\.json .* is not the file its manifest names \(its size differs\)/);
  const longer = rezip(bytes, (e) => { e[path] = new Uint8Array([...e[path], 32, 32]); });
  await refused(read(longer), /parishes\.json .* is longer than its manifest says/);
  const gone = rezip(bytes, (e) => { delete e[path]; });
  await refused(read(gone), /parishes\.json \(files\/[0-9a-f]{64}\) is missing from it/);
  // A sink is aborted, not closed, for the part that failed; the parts closed before it are listed for the caller to let go.
  const aborted = [], closed = [];
  const sink = async (part) => ({ write() {}, close: async () => { closed.push(part.name); return part.name; }, abort: async () => { aborted.push(part.name); } });
  await assert.rejects(readProject((async function* () { yield tampered; })(), { sink }), (e) => e.closed.map((c) => c.result).join() === closed.join() && closed.length === 2);
  assert.deepEqual(aborted, ['parishes.json']);
});

test('a version newer than these tools read is refused in words, naming the tools that saved it; version 1 opens', async () => {
  const p = await atReview();
  const { bytes } = await written({ record: p.record, files: p.files });
  const as = (fn) => rezip(bytes, (e) => { const m = JSON.parse(strFromU8(e[MANIFEST])); fn(m); e[MANIFEST] = strToU8(JSON.stringify(m)); });
  await read(as(() => {}));   // the control: re-zipped, unchanged, it opens
  await refused(read(as((m) => { m.version = 2; m.tools.version = '1.4.0'; m.somethingNew = true; })),
    /saved by newer PLATO tools \(PLATO tools 1\.4\.0\), in version 2 of the project format; these tools read version 1 and earlier/);
  assert.throws(() => checkManifest({ format: FORMAT, version: 2 }), /newer PLATO tools, in version 2/);
});

test('anything unknown is refused: a key, a part, a file the manifest does not list, a file the workflow does not name', async () => {
  const p = await atReview();
  const { bytes } = await written({ record: p.record, files: p.files });
  const as = (fn) => rezip(bytes, (e) => { const m = JSON.parse(strFromU8(e[MANIFEST])); fn(m, e); e[MANIFEST] = strToU8(JSON.stringify(m)); });
  await refused(read(as((m) => { m.extra = 1; })), /manifest has keys these tools do not know \(extra\)/);
  await refused(read(as((m) => { m.parts.push({ path: 'script.js', role: 'script', size: 1, sha256: 'a'.repeat(64) }); })), /a part these tools do not know \(a "script"\)/);
  await refused(read(rezip(bytes, (e) => { e['notes.txt'] = strToU8('hello'); })), /holds a file its manifest does not list \("notes\.txt"\)/);
  // A file both listed and hashed rightly, but not one the workflow names.
  const stray = strToU8('stray'), sha = (await refsOf([new File([stray], 's')], 'files'))[0].sha256;
  await refused(read(as((m, e) => { m.parts.push({ path: `files/${sha}`, role: 'file', size: stray.length, sha256: sha, name: 'stray.txt', own: false }); e[`files/${sha}`] = stray; })),
    /holds stray\.txt, which its workflow does not name/);
  await refused(read(as((m) => { m.parts[0].path = '../workflow.json'; })), /lists the part "\.\.\/workflow\.json" in a way these tools do not know/);
});

test('not a project: WHG\'s .whgproj, a file that is not a zip, a zip of other things, and an empty file are refused in words', async () => {
  const whg = strToU8(JSON.stringify({ title: 'My WHG project', columns: [], rows: [] }));
  await refused(read(whg, { name: 'parishes.whgproj' }), /This is a WHG project \(\.whgproj\)\. PLATO tools do not open WHG's projects/);
  await refused(read(whg, { name: 'parishes.json' }), /not a PLATO tools project \(\.platoproj\): it is not a zip file/);
  await refused(read(zipSync({ 'places.csv': strToU8('id,name\n') })), /a zip whose first file is "places\.csv", not manifest\.json/);
  await refused(read(new Uint8Array(0)), /This file is empty/);
  // A synced WHG project, as its JSON snapshot, inside a zip with a manifest of another format.
  await refused(read(zipSync({ [MANIFEST]: strToU8(JSON.stringify({ format: 'whg-project', version: 1 })) })), /its manifest does not name the format "plato-tools-project"/);
});

test('nothing secret goes in: the WHG token, the permissions and the reviewer remembered are in no part; a part that holds the token is refused', async () => {
  const p = await atReview();
  // The browser's storage as it is when the project is saved: the token, the grants, the reviewer remembered.
  const storage = { 'plato-tools.whg-token': TOKEN, 'plato-tools.permissions': JSON.stringify({ version: 1, grants: { 'gazetteer:whg': { state: 'allowed' } } }), 'plato-tools.reviewer': JSON.stringify({ name: 'Remembered Reviewer' }) };
  const { bytes } = await written({ record: p.record, files: p.files, review: p.review, refuse: [storage['plato-tools.whg-token']] });
  const all = Object.values(unzipSync(bytes)).map((b) => strFromU8(b)).join('\n');
  // The presence: the same search finds what is in it (the record's name, the decisions, the user's table).
  assert.ok(all.includes('"name": "Parishes"') && all.includes('"kind": "match"') && all.includes('1,Mill Farm,Newton,Cheshire'));
  for (const x of [TOKEN, 'plato-tools.whg-token', 'plato-tools.permissions', 'gazetteer:whg', 'Remembered Reviewer', 'plato-tools.reviewer']) assert.ok(!all.includes(x), x);
  // A review that holds the token (planted) is refused, and nothing is written.
  const chunks = [];
  const planted = { ...p.review, text: p.review.text.replace('"test"', JSON.stringify(TOKEN)) };
  await assert.rejects(writeProject({ record: p.record, files: p.files, review: planted, tools: { version: 'x', commit: null }, refuse: [TOKEN] }, async (c) => { chunks.push(c); }),
    /The review parishes\.krisis\.json holds your WHG token, which a project never does, so nothing was saved/);
  assert.equal(chunks.length, 0);
  // The control for the refusal: the same planted review with no secret to refuse is written (so the refusal was the token's).
  await written({ record: p.record, files: p.files, review: planted });
});

test('a file this browser keeps that is not the one the workflow recorded is refused, and the user\'s own file can be left out, and is listed so', async () => {
  const p = await atReview();
  const changed = p.files.map((f) => (f.ref === p.refs.dataset ? { ...f, blob: file(JSON.stringify({ changed: true }).padEnd(DATASET.size), 'parishes.json') } : f));
  await assert.rejects(written({ record: p.record, files: changed }), /parishes\.json, as this browser keeps it, is not the file the workflow recorded/);
  const { manifest, bytes } = await written({ record: p.record, files: p.files.filter((f) => f.ref !== p.refs.table), left: [{ ref: p.refs.table, why: 'left-out' }] });
  assert.deepEqual(manifest.left, [{ name: 'parishes.csv', size: TABLE.size, sha256: p.refs.table.sha256, why: 'left-out' }]);
  assert.ok(!manifest.parts.some((x) => x.own));
  const r = await read(bytes);
  assert.equal(r.files.length, 3);
  assert.match(describe(r).join('\n'), /parishes\.csv \(\d+ bytes\): left out when it was saved/);
});

test('plato-tools project info lists the manifest and checks every hash: 0 for a project, 1 for a tampered one, 2 for no file', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const CLI = new URL('../bin/plato-tools.mjs', import.meta.url).pathname;
  const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  const dir = mkdtempSync(join(tmpdir(), 'plato-project-'));
  try {
    const p = await atReview();
    const { bytes } = await written({ record: p.record, files: p.files, review: p.review });
    writeFileSync(join(dir, 'Parishes.platoproj'), bytes);
    const ok = cli('project', 'info', join(dir, 'Parishes.platoproj'));
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /A PLATO tools project, format version 1/);
    assert.match(ok.out, /files\/[0-9a-f]{64} +\d+ bytes {2}file: parishes\.csv \(the file the workflow began with\)/);
    const json = JSON.parse(cli('project', 'info', '--json', join(dir, 'Parishes.platoproj')).out);
    assert.equal(json.ok, true); assert.equal(json.manifest.parts.length, 6);
    const path = `files/${p.refs.dataset.sha256}`;
    writeFileSync(join(dir, 'tampered.platoproj'), rezip(bytes, (e) => { e[path] = e[path].slice(); e[path][3] ^= 1; }));
    const bad = cli('project', 'info', join(dir, 'tampered.platoproj'));
    assert.equal(bad.code, 1);
    assert.match(bad.out, /parishes\.json .* is not the file its manifest names/);
    assert.equal(cli('project', 'info', join(dir, 'none.platoproj')).code, 2);
    assert.equal(cli('project', 'open', 'x').code, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
