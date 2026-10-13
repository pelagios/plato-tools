// Methodos: the project file (plan #34, item A2; src/engine/methodos/project.js). A whole workflow in
// one zip, its manifest first, read by its central directory, every part's size and SHA-256 checked as
// it streams. Every refusal is paired with the same project, untouched, opening; every absence (no
// token in it) with a presence (what is in it, found by the same search).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { RECIPES, runner, recordOf, reconcile, refsOf } from '../src/engine/methodos/index.js';
import { writeProject, readProject, checkManifest, describe, projectName, blobSource, secretSearch, ProjectError, FORMAT, VERSION, MINOR, EXTENSION, MANIFEST, RECORD, REVIEW, HANDBACK } from '../src/engine/methodos/project.js';
import { outputStore } from '../src/methodos/outputs.js';
import { stepAt } from '../src/methodos/seams.js';
import { fakeOpfs } from './opfs-fake.js';

const { start, next, complete } = runner;
const MYD = RECIPES['map-your-data'];
const NOW = new Date('2026-10-12T10:00:00Z');
const TOKEN = 'whg-token-7f3a9c2e1d0b4a68';
const file = (text, name, type = 'application/json') => new File([text], name, { type });
const enc = (s) => new TextEncoder().encode(s);

const TABLE = file('id,name,parish,county\n1,Mill Farm,Newton,Cheshire\n', 'parishes.csv', 'text/csv');
const DATASET_TEXT = JSON.stringify({ profile: 'place-centric', spatialEntities: [{ '@id': 'https://example.org/parishes/1' }] });
const DATASET = file(DATASET_TEXT, 'parishes.json');
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
const memorySink = async () => { const got = []; return { write: (c) => { got.push(c); }, close: async () => new Blob(got), abort: async () => { got.length = 0; } }; };
/** Read `bytes` back by offset, as the page reads the File (a Blob), every file kept by a sink in memory. */
const read = (bytes, { name = 'p.platoproj', ...o } = {}) => readProject(blobSource(new Blob([bytes])), { sink: memorySink, name, ...o });
const refused = (p, re) => assert.rejects(p, (e) => e instanceof ProjectError && re.test(e.message));
/** A project's zip with its entries changed by `fn(entries)`, re-zipped (the manifest kept first). */
function rezip(bytes, fn) {
  const entries = unzipSync(bytes);
  fn(entries);
  const order = [MANIFEST, ...Object.keys(entries).filter((k) => k !== MANIFEST)].filter((k) => entries[k]);
  return zipSync(Object.fromEntries(order.map((k) => [k, entries[k]])));
}
const withManifest = (bytes, fn) => rezip(bytes, (e) => { const m = JSON.parse(strFromU8(e[MANIFEST])); fn(m, e); e[MANIFEST] = strToU8(JSON.stringify(m)); });
/**
 * A zip written byte by byte, stored, its sizes in its headers (CRCs left 0, which these tools do not
 * read): so that a test can make what no writer here makes, an entry twice, or a size that lies.
 * `usize` is the size declared for an entry, if not its data's.
 */
function rawZip(entries) {
  const out = [], cd = [];
  let off = 0;
  for (const e of entries) {
    const name = enc(e.name), data = e.data, usize = e.usize ?? data.length;
    const h = new Uint8Array(30 + name.length), v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x800, true);
    v.setUint32(18, data.length, true); v.setUint32(22, usize, true); v.setUint16(26, name.length, true); h.set(name, 30);
    const c = new Uint8Array(46 + name.length), w = new DataView(c.buffer);
    w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true); w.setUint16(8, 0x800, true);
    w.setUint32(20, data.length, true); w.setUint32(24, usize, true); w.setUint16(28, name.length, true); w.setUint32(42, off, true); c.set(name, 46);
    out.push(h, data); cd.push(c); off += h.length + data.length;
  }
  const cdSize = cd.reduce((n, c) => n + c.length, 0), end = new Uint8Array(22), x = new DataView(end.buffer);
  x.setUint32(0, 0x06054b50, true); x.setUint16(8, entries.length, true); x.setUint16(10, entries.length, true); x.setUint32(12, cdSize, true); x.setUint32(16, off, true);
  const all = [...out, ...cd, end], bytes = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0; for (const c of all) { bytes.set(c, at); at += c.length; }
  return bytes;
}
const entriesOf = (bytes) => Object.entries(unzipSync(bytes)).map(([name, data]) => ({ name, data }));

test('the manifest round trip: written and read back, every part is what was put in, by bytes', async () => {
  const p = await atReview();
  const handback = { handback: 1, workflow: p.record.id, files: [{ type: 'dataset', name: 'parishes.drawn.json', size: 12, sha256: 'c'.repeat(64) }], at: NOW.getTime() };
  const { bytes, manifest, chunks } = await written({ record: p.record, files: p.files, review: p.review, handback });
  assert.ok(chunks > 1, 'handed on a chunk at a time');
  assert.equal(projectName(p.record), `Parishes${EXTENSION}`);
  assert.deepEqual(Object.keys(unzipSync(bytes)).slice(0, 2), [MANIFEST, RECORD]);
  assert.equal(manifest.format, FORMAT); assert.equal(manifest.version, VERSION); assert.equal(manifest.minor, MINOR);
  assert.deepEqual(manifest.tools, { version: '0.9.0-alpha.2', commit: 'f'.repeat(40) });
  assert.equal(manifest.created, NOW.toISOString());
  assert.deepEqual(manifest.workflow, { id: 'map-your-data-mgx1', name: 'Parishes', recipe: { key: 'map-your-data', version: MYD.version }, at: 'review' });
  assert.deepEqual(manifest.parts.map((x) => [x.path, x.role]), [[RECORD, 'record'], [REVIEW, 'review'], [HANDBACK, 'handback'],
    ...p.files.map((f) => [`files/${f.ref.sha256}`, 'file'])]);
  assert.deepEqual(manifest.parts.filter((x) => x.role === 'file').map((x) => [x.name, x.own]), [['parishes.csv', true], ['columns.json', false], ['parishes.json', false], ['parishes.krisis.json', false]]);

  const r = await read(bytes);
  assert.deepEqual(r.manifest, manifest);
  assert.equal(r.newer, false);
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
  // Read from bytes in memory too (the tests' source), as from the Blob.
  assert.deepEqual((await readProject(blobSource(bytes), { sink: memorySink })).record, p.record);
  assert.match(describe(r).join('\n'), /A PLATO tools project, format version 1\.0.*\n.*"Parishes", following map-your-data.*4 of 9 steps done, at "Decide which candidates are the same place"/);
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
  await refused(read(cut), /parishes\.json .* is not the size its manifest says/);
  // The directory and the manifest agreeing on a size the data runs past: stopped there.
  const list = entriesOf(bytes), size = unzipSync(bytes)[path].length;
  await read(rawZip(list));   // the control: the raw writer's zip of the same entries opens
  await refused(read(rawZip(list.map((e) => (e.name === path ? { ...e, data: new Uint8Array([...e.data, 32, 32]), usize: size } : e)))), /parishes\.json .* is longer than its manifest says/);
  const gone = rezip(bytes, (e) => { delete e[path]; });
  await refused(read(gone), /parishes\.json \(files\/[0-9a-f]{64}\) is missing from it/);
  // A sink is aborted, not closed, for the part that failed; the parts closed before it are listed, and every file part named, for the caller to let go.
  const aborted = [], closed = [];
  const sink = async (part) => ({ write() {}, close: async () => { closed.push(part.name); return part.name; }, abort: async () => { aborted.push(part.name); } });
  await assert.rejects(readProject(blobSource(tampered), { sink }), (e) => e.closed.map((c) => c.result).join() === closed.join() && closed.length === 2 && e.fileParts.length === 4);
  assert.deepEqual(aborted, ['parishes.json']);
});

test('versions: a greater major is refused; a greater minor opens and says so, ignoring what it does not know; at its own minor an unknown key is damage', async () => {
  const p = await atReview();
  const { bytes } = await written({ record: p.record, files: p.files });
  assert.equal((await read(withManifest(bytes, () => {}))).newer, false);   // the control: re-zipped, unchanged, it opens
  await refused(read(withManifest(bytes, (m) => { m.version = 2; m.tools.version = '1.4.0'; m.somethingNew = true; })),
    /saved by newer PLATO tools \(PLATO tools 1\.4\.0\), in version 2 of the project format; these tools read version 1, so it is not opened/);
  assert.throws(() => checkManifest({ format: FORMAT, version: 2 }), /newer PLATO tools, in version 2/);
  // A later minor of this major: a key, a key in a part, and an optional part of a role these tools do not know.
  const extra = strToU8('{"note": "a later minor"}'), sha = (await refsOf([new File([extra], 'n')], 'files'))[0].sha256;
  const later = (m, e) => { m.minor = MINOR + 3; m.tools.version = '1.2.0'; m.annotations = { x: 1 }; m.parts[0].encoding = 'utf-8';
    m.parts.push({ path: 'notes/later.json', role: 'notes', size: extra.length, sha256: sha, optional: true }); e['notes/later.json'] = extra; };
  const r = await read(withManifest(bytes, later));
  assert.equal(r.newer, true);
  assert.deepEqual(r.record, p.record);
  assert.match(describe(r).join('\n'), /saved by newer PLATO tools \(PLATO tools 1\.2\.0, project format 1\.3\); what they added is not read \(notes\/later\.json\)/);
  // Not optional, a role it does not know is refused even at a later minor; at its own minor, the same keys are damage.
  await refused(read(withManifest(bytes, (m, e) => { later(m, e); delete m.parts[m.parts.length - 1].optional; })), /a part these tools do not know \(a "notes"\)/);
  await refused(read(withManifest(bytes, (m) => { m.parts[0].encoding = 'utf-8'; })), /lists the part "workflow\.json" in a way these tools do not know/);
  await refused(read(withManifest(bytes, (m) => { m.annotations = {}; })), /manifest has keys these tools do not know \(annotations\)/);
});

test('the manifest and the record must agree: the step it is at, and its name', async () => {
  const p = await atReview();
  const { bytes } = await written({ record: p.record, files: p.files });
  await read(withManifest(bytes, () => {}));
  await refused(read(withManifest(bytes, (m) => { m.workflow.at = 'apply'; })), /manifest and its workflow's record do not describe the same workflow/);
  await refused(read(withManifest(bytes, (m) => { m.workflow.name = 'Another'; })), /manifest and its workflow's record do not describe the same workflow/);
});

test('anything unknown is refused: a key, a part, a file the manifest does not list, a file the workflow does not name', async () => {
  const p = await atReview();
  const { bytes } = await written({ record: p.record, files: p.files });
  await refused(read(withManifest(bytes, (m) => { m.extra = 1; })), /manifest has keys these tools do not know \(extra\)/);
  await refused(read(withManifest(bytes, (m) => { m.parts.push({ path: 'script.js', role: 'script', size: 1, sha256: 'a'.repeat(64) }); })), /a part these tools do not know \(a "script"\)/);
  await refused(read(rezip(bytes, (e) => { e['notes.txt'] = strToU8('hello'); })), /holds a file its manifest does not list \("notes\.txt"\)/);
  const stray = strToU8('stray'), sha = (await refsOf([new File([stray], 's')], 'files'))[0].sha256;
  await refused(read(withManifest(bytes, (m, e) => { m.parts.push({ path: `files/${sha}`, role: 'file', size: stray.length, sha256: sha, name: 'stray.txt', own: false }); e[`files/${sha}`] = stray; })),
    /holds stray\.txt, which its workflow does not name/);
  await refused(read(withManifest(bytes, (m) => { m.parts[0].path = '../workflow.json'; })), /lists the part "\.\.\/workflow\.json" in a way these tools do not know/);
});

test('the central directory is authoritative: none, one that disagrees with the entries, duplicates, a stored entry, a huge declared size, and room asked first', async () => {
  const p = await atReview();
  const { bytes } = await written({ record: p.record, files: p.files });
  const cdAt = (b) => { for (let i = 0; i + 3 < b.length; i++) if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 1 && b[i + 3] === 2) return i; return -1; };
  await refused(read(bytes.subarray(0, cdAt(bytes))), /has no central directory/);
  // The directory names the record otherwise than its local header does: another reader would see another project.
  const other = rezip(bytes, () => {}), spliced = other.slice(), at = Buffer.from(spliced).indexOf('workflow.json', cdAt(other));
  spliced[at + 12] = 0x58;
  await read(other);   // the control: the same zip, unspliced, opens
  await refused(read(spliced), /central directory and its entries disagree about workflow\.jsoX/);
  const list = entriesOf(bytes);
  await refused(read(rawZip([...list, list[1]])), /holds workflow\.json twice/);
  // Stored entries are read as they are.
  assert.deepEqual((await read(zipSync(Object.fromEntries(list.map((e) => [e.name, [e.data, { level: 0 }]]))))).record, p.record);
  // A file part declared at 3 GiB: not the size the directory says.
  await refused(read(withManifest(bytes, (m) => { m.parts[1].size = 3 * 2 ** 30; })), /is not the size its manifest says/);
  // Room is asked before any file is written: refused there, no sink is asked for.
  let asked = 0, sinks = 0;
  await refused(readProject(blobSource(bytes), { room: async (n) => { asked = n; throw new ProjectError('not room enough'); }, sink: async () => { sinks++; return memorySink(); } }), /not room enough/);
  assert.equal(asked, p.files.reduce((n, f) => n + f.ref.size, 0)); assert.equal(sinks, 0);
});

test('a part that is itself a zip (a workbook as the user\'s own file) is written and read back whole, however its signatures fall', async () => {
  const workbook = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'xl/workbook.xml': strToU8('<workbook/>'), 'xl/worksheets/sheet1.xml': strToU8('<sheet>' + 'Mill Farm,'.repeat(400) + '</sheet>') }, { level: 0 });
  const noisy = new Uint8Array(300000);
  for (let i = 0; i < noisy.length; i++) noisy[i] = (Math.imul(i, 2654435761) >>> 24) & 255;
  for (let k = 1; k < 8; k++) noisy.set([0x50, 0x4b, 0x03, 0x04], Math.floor(noisy.length * k / 8));
  for (const [plain, name] of [[workbook, 'parishes.xlsx'], [noisy, 'noisy.ods']]) {
    const own = new File([plain], name);
    const [ref] = await refsOf([own], 'files');
    const s = start(MYD, { 'has-regions': false, 'will-draw': false, 'will-publish': false, target: 'plato-json' }, { files: [ref] });
    const record = recordOf({ ...s, id: 'map-your-data-zip1' }, { name: 'Workbook' });
    const { bytes } = await written({ record, files: [{ ref, blob: own }] });
    const r = await read(bytes);
    assert.deepEqual(new Uint8Array(await r.files[0].result.arrayBuffer()), plain, name);
  }
});

test('a refusal from the sink leaves nothing behind in the outputs folder', async () => {
  const p = await atReview();
  const { bytes } = await written({ record: p.record, files: p.files });
  const disk = fakeOpfs(), outs = outputStore({ root: disk.root, keep: () => true });
  // The control: the same project, written through the store, keeps its four files.
  await readProject(blobSource(bytes), { sink: (part) => outs.writer({ type: 'files', name: part.name, size: part.size, sha256: part.sha256 }) });
  assert.equal((await outs.kept()).count, 4);
  const disk2 = fakeOpfs(), outs2 = outputStore({ root: disk2.root, keep: () => true });
  let n = 0;
  const failing = async (part) => { const w = await outs2.writer({ type: 'files', name: part.name, size: part.size, sha256: part.sha256 }); return { ...w, write: async (c) => { if (++n === 3) throw new ProjectError('full'); return w.write(c); } }; };
  const e = await readProject(blobSource(bytes), { sink: failing }).catch((x) => x);
  assert.equal(e.message, 'full');
  // As the page's undo does: every file part the manifest named, not kept before, is let go.
  await outs2.drop(e.fileParts);
  assert.deepEqual(await outs2.kept(), { count: 0, bytes: 0, files: [] });
});

test('not a project: WHG\'s .whgproj, a file that is not a zip, a zip of other things, and an empty file are refused in words', async () => {
  const whg = strToU8(JSON.stringify({ title: 'My WHG project', columns: [], rows: [] }));
  await refused(read(whg, { name: 'parishes.whgproj' }), /This is a WHG project \(\.whgproj\)\. PLATO tools do not open WHG's projects/);
  await refused(read(whg, { name: 'parishes.json' }), /not a PLATO tools project \(\.platoproj\): it is not a zip file/);
  await refused(read(zipSync({ 'places.csv': strToU8('id,name\n') })), /its first entry is "places\.csv", not manifest\.json/);
  await refused(read(new Uint8Array(0)), /This file is empty/);
  await refused(read(zipSync({ [MANIFEST]: strToU8(JSON.stringify({ format: 'whg-project', version: 1 })) })), /its manifest does not name the format "plato-tools-project"/);
});

test('nothing secret goes in: no part holds the token, the grants or the reviewer remembered; a part that holds the token is refused, a file part too', async () => {
  const p = await atReview();
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
    /The review parishes\.krisis\.json holds your WHG token or another key, which a project never does, so the project was not saved/);
  assert.equal(chunks.length, 0);
  await written({ record: p.record, files: p.files, review: planted });   // the control: with no secret to refuse, written
  // Every part is searched, the files too: the token in a step's output (the dataset) is refused, naming it.
  const leakFile = file(DATASET_TEXT.replace('"place-centric"', JSON.stringify(TOKEN)), 'parishes.json'), [leakRef] = await refsOf([leakFile], 'dataset');
  const leakRecord = { ...p.record, steps: p.record.steps.map((s) => (s.id === 'dataset' ? { ...s, outputs: { dataset: [leakRef] } } : s)) };
  const leakFiles = [...p.files.filter((f) => f.ref !== p.refs.dataset), { ref: leakRef, blob: leakFile }];
  await assert.rejects(written({ record: leakRecord, files: leakFiles, refuse: [TOKEN] }), /parishes\.json holds your WHG token or another key/);
  await written({ record: leakRecord, files: leakFiles });   // the control: with nothing to refuse, the same file goes in
  // A secret split across two chunks is found, as one within a chunk; a near miss is not.
  const find = (chunks2, secrets = [TOKEN]) => { const x = secretSearch(secrets); return chunks2.some((c) => x.push(c)); };
  assert.equal(find([enc('abc' + TOKEN.slice(0, 5)), enc(TOKEN.slice(5) + 'xyz')]), true);
  assert.equal(find([enc('abc'), enc(TOKEN)]), true);
  assert.equal(find([enc('abc' + TOKEN.slice(0, 5)), enc('Q' + TOKEN.slice(5))]), false);
  assert.equal(find([enc(TOKEN)], ['short']), false, 'shorter than 8 characters is not searched for');
});

test('the writer refuses what a project cannot hold: a part over 4 GiB, and a kept file that is not the one recorded; the user\'s own file can be left out, and is listed so', async () => {
  const p = await atReview();
  const changed = p.files.map((f) => (f.ref === p.refs.dataset ? { ...f, blob: file(JSON.stringify({ changed: true }).padEnd(DATASET.size), 'parishes.json') } : f));
  await assert.rejects(written({ record: p.record, files: changed }), /parishes\.json, as this browser keeps it, is not the file the workflow recorded/);
  const bigRef = { type: 'files', name: 'huge.csv', size: 5 * 2 ** 30, sha256: 'd'.repeat(64) };
  const bigRecord = recordOf({ ...start(MYD, { 'has-regions': false, 'will-draw': false, 'will-publish': false, target: 'plato-json' }, { files: [bigRef] }), id: 'map-your-data-big' }, { name: 'Big' });
  await assert.rejects(written({ record: bigRecord, files: [{ ref: bigRef, blob: TABLE }] }), /huge\.csv is over 4 GiB, more than a project can hold/);
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
    assert.match(ok.out, /A PLATO tools project, format version 1\.0/);
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
