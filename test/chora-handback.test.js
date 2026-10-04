// Chora's hand-back to a Methodos workflow (src/chora/handback.js): the record's shape, its check on
// read (bad, old and foreign records refused), the workflow id taken from the address, and the SHA-256
// over known bytes, read as a stream. The reference is a Methodos hand-off, made by Methodos's refsOf
// (src/engine/methodos/handoffs.js), and the step "place" of a workflow is completed with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { FRESH, stash, take as takeHandoff } from '../src/chora/handoff.js';
import { HANDBACK_FRESH } from '../src/chora/handback.js';
import { isRef, checkHandoff, refsOf, refsDiffer, TYPES, OPERATIONS, RECIPES, runner } from '../src/engine/methodos/index.js';
import { KEY, FORMAT, TYPE, workflowOf, isWorkflowId, backTo, refOf, isDatasetRef, record, check, give, take, dropStale } from '../src/chora/handback.js';

const hex = (b) => createHash('sha256').update(b).digest('hex');
const NOW = 1_800_000_000_000;
const REF = { type: 'dataset', name: 'antonine.chora.json', size: 12, sha256: hex('hello, world') };

const shaOf = async (bytes) => (await refOf(new File([bytes], 'x.json'))).sha256;
test('the SHA-256 is over the exact bytes: the standard\'s vectors, and Node\'s own over random bytes of several chunks', async () => {
  assert.equal(await shaOf(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await shaOf(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const bytes = randomBytes(300_001);
  assert.equal(await shaOf(bytes), hex(bytes));
  // The control: one byte changed changes the digest (the comparison can see a difference).
  const other = Buffer.from(bytes); other[150_000] ^= 1;
  assert.notEqual(await shaOf(other), hex(bytes));
});

test('the file is hashed as a stream, a chunk at a time, never read whole', async () => {
  const bytes = randomBytes(1_000_003);
  // A File-like whose whole-file reads throw: only its stream can be read, and it gives 64 KiB at a
  // time, as a file on disk does (Node's in-memory File gives itself in one chunk).
  const streamOnly = (f) => {
    let chunks = 0;
    const g = { name: f.name, size: f.size, type: f.type, get chunks() { return chunks; },
      stream: () => { let at = 0; return new ReadableStream({ async pull(ctl) {
        if (at >= f.size) { ctl.close(); return; }
        ctl.enqueue(new Uint8Array(await f.slice(at, at + 65536).arrayBuffer())); at += 65536; chunks++;
      } }); } };
    for (const k of ['arrayBuffer', 'text', 'bytes']) g[k] = () => { throw new Error(`${k}() read the whole file`); };
    return g;
  };
  const s = streamOnly(new File([bytes], 'big.chora.json'));
  assert.deepEqual(await refOf(s), { type: 'dataset', name: 'big.chora.json', size: bytes.length, sha256: hex(bytes) });
  assert.ok(s.chunks > 1, `read in ${s.chunks} chunks`);
  // The control: the same File-like with its stream refused too cannot be hashed, so the hash above came from the stream.
  const none = { ...streamOnly(new File([bytes], 'big.chora.json')), stream: () => { throw new Error('no stream'); } };
  await assert.rejects(refOf(none), /no stream/);
});

test('a saved file\'s reference is exactly { type: "dataset", name, size, sha256 } of its bytes', async () => {
  const text = '{"spatialEntities":[]}\n'; const file = new File([text], 'antonine.chora.json', { type: 'application/json' });
  const ref = await refOf(file);
  assert.deepEqual(ref, { type: 'dataset', name: 'antonine.chora.json', size: Buffer.byteLength(text), sha256: hex(text) });
  assert.deepEqual(Object.keys(ref).sort(), ['name', 'sha256', 'size', 'type']);
  assert.equal(TYPE, 'dataset');
  // Bytes, not characters: a name with an accent and a body in UTF-8.
  const utf = new File(['Londinium – Λονδίνιον'], 'Londinium.json');
  assert.equal((await refOf(utf)).size, Buffer.byteLength('Londinium – Λονδίνιον'));
  await assert.rejects(refOf(new File(['x'], 'a/b.json')), /cannot be handed back/);
});

test('the record is the hand-off\'s shape, { files, at }, with the workflow and a format, and holds no bytes', () => {
  const r = record('wf-1', REF, NOW);
  assert.deepEqual(r, { handback: FORMAT, workflow: 'wf-1', files: [REF], at: NOW });
  assert.equal(FORMAT, 1); assert.equal(KEY, 'chora-handback');
  assert.ok(!(r.files[0] instanceof Blob));
  assert.notEqual(r.files[0], REF, 'a copy, not the object given');
  assert.throws(() => record('<b>', REF, NOW), /workflow id/);
  assert.throws(() => record('wf-1', { ...REF, type: 'files' }, NOW), /reference/);
});

test('a hand-back read is used only if it is for this workflow, of this format, fresh, and exactly one reference to a dataset', () => {
  const good = record('wf-1', REF, NOW);
  // The presence first: the good record is accepted, rebuilt, at any age under two minutes.
  assert.deepEqual(check(good, 'wf-1', NOW), good);
  assert.deepEqual(check(good, 'wf-1', NOW + HANDBACK_FRESH - 1), good);
  // Thirty minutes, not the hand-off's two: ten minutes after the save it is still good.
  assert.equal(HANDBACK_FRESH, 30 * 60 * 1000);
  assert.ok(HANDBACK_FRESH > FRESH);
  assert.deepEqual(check(good, 'wf-1', NOW + 10 * 60 * 1000), good);
  assert.notEqual(check(good, 'wf-1', NOW), good, 'rebuilt, not the object read');
  const f = (files) => ({ ...good, files });
  const refused = {
    'nothing': undefined, 'null': null, 'a string': 'wf-1', 'an array': [good], 'a number': 1,
    'another workflow\'s (foreign)': { ...good, workflow: 'wf-2' },
    'an older format': { ...good, handback: 0 }, 'a later format': { ...good, handback: 2 }, 'the format as text': { ...good, handback: '1' },
    'no format (a hand-off\'s shape)': { files: good.files, at: NOW, workflow: 'wf-1' },
    'a key more': { ...good, run: 'now' }, 'no time': { handback: 1, workflow: 'wf-1', files: good.files },
    'thirty minutes old (old)': { ...good, at: NOW - HANDBACK_FRESH }, 'an hour old': { ...good, at: NOW - 60 * 60 * 1000 },
    'from the future': { ...good, at: NOW + 1 }, 'time as text': { ...good, at: String(NOW) },
    'no files': f([]), 'files not a list': f(REF), 'two files': f([REF, REF]),
    'a File, as the hand-off keeps (bytes, not a reference)': f([new File(['x'], 'a.json')]),
    'of type files': f([{ ...REF, type: 'files' }]), 'of type work.krisis': f([{ ...REF, type: 'work.krisis' }]), 'of no type': f([{ name: REF.name, size: REF.size, sha256: REF.sha256 }]),
    'an upper-case hash': f([{ ...REF, sha256: REF.sha256.toUpperCase() }]), 'a short hash': f([{ ...REF, sha256: REF.sha256.slice(1) }]),
    'a size below zero': f([{ ...REF, size: -1 }]), 'a fractional size': f([{ ...REF, size: 1.5 }]), 'a size as text': f([{ ...REF, size: '12' }]),
    'no name': f([{ ...REF, name: '' }]), 'a path': f([{ ...REF, name: '../../etc/passwd' }]), 'a name with a line break': f([{ ...REF, name: 'a\n<script>' }]),
    'a name too long': f([{ ...REF, name: 'a'.repeat(256) }]),
    'the name "."': f([{ ...REF, name: '.' }]), 'the name ".."': f([{ ...REF, name: '..' }]), 'a name of a space': f([{ ...REF, name: ' ' }]),
    'a name of spaces and a tab-like space': f([{ ...REF, name: ' \u00a0 ' }]),
    'a right-to-left override (txt.exe shown as exe.txt)': f([{ ...REF, name: 'places\u202Enosj.exe' }]),
    'a zero-width space': f([{ ...REF, name: 'places\u200B.json' }]), 'a left-to-right mark': f([{ ...REF, name: 'places\u200E.json' }]),
    'an embedding': f([{ ...REF, name: '\u202Aplaces.json' }]), 'an isolate': f([{ ...REF, name: 'places\u2066.json\u2069' }]),
    'a byte-order mark': f([{ ...REF, name: '\uFEFFplaces.json' }]), 'a reference with a key more': f([{ ...REF, bytes: 'eA==' }]),
  };
  for (const [why, v] of Object.entries(refused)) assert.equal(check(v, 'wf-1', NOW), null, why);
  // The controls: ordinary names, one with a space and an accent, and one of dots with a letter, are kept.
  for (const name of ['antonine draw.chora.json', 'Λονδίνιον.json', '..a', 'a.']) assert.ok(check(f([{ ...REF, name }]), 'wf-1', NOW), name);
  // Asked for a workflow that is not an id, nothing is used, however good the record.
  for (const bad of [undefined, '', '<x>', 'wf 1']) assert.equal(check({ ...good, workflow: bad }, bad, NOW), null, String(bad));
});

test('the workflow is taken from the address only if it is an id: nothing that could reach an address or the page otherwise', () => {
  assert.deepEqual(workflowOf('#workflow=wf-1'), { id: 'wf-1' });
  assert.deepEqual(workflowOf('workflow=3f2b9c1e-7a4d-4e8f-9b0a-1c2d3e4f5a6b'), { id: '3f2b9c1e-7a4d-4e8f-9b0a-1c2d3e4f5a6b' });
  assert.deepEqual(workflowOf('#workflow=' + 'a'.repeat(64)), { id: 'a'.repeat(64) });
  for (const none of ['', '#', '#tool=check', '#workflows=wf-1']) assert.equal(workflowOf(none), null, none);
  for (const bad of ['#workflow=', '#workflow=' + 'a'.repeat(65), '#workflow=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E', '#workflow=<b>x</b>',
    '#workflow=javascript:alert(1)', '#workflow=a%22%20onmouseover%3D1', '#workflow=../index.html', '#workflow=wf%2F1', '#workflow=wf+1', '#workflow=-wf', '#workflow=wf%0A1'])
    assert.deepEqual(workflowOf(bad), { refused: true }, bad);
  assert.ok(isWorkflowId('A_b-9') && !isWorkflowId('é') && !isWorkflowId(42));
});

test('the way back is the main page beside this one, with the workflow in its fragment and nothing else carried', () => {
  assert.equal(backTo('wf-1', 'https://pelagios.org/plato-tools/chora.html?x=1#workflow=wf-1'), 'https://pelagios.org/plato-tools/#workflow=wf-1');
  assert.equal(backTo('wf-1', 'http://localhost:4174/chora.html'), 'http://localhost:4174/#workflow=wf-1');
  assert.throws(() => backTo('a"b', 'http://localhost:4174/chora.html'), /workflow id/);
});

test('kept in the hand-off\'s store under a key of its own: given, taken once, a foreign or stale one refused and let go', async () => {
  globalThis.indexedDB = new IDBFactory();
  // The hand-off and the hand-back side by side: neither displaces the other.
  await stash([new File(['{}'], 'chosen.json')]);
  const kept = await give('wf-1', REF);
  assert.deepEqual(kept.files, [REF]);
  assert.deepEqual(await take('wf-1'), kept);
  assert.equal(await take('wf-1'), null, 'taken once');
  assert.deepEqual((await takeHandoff()).map((f) => f.name), ['chosen.json']);
  // Another workflow's is refused, and let go all the same.
  await give('wf-2', REF);
  assert.equal(await take('wf-1'), null);
  assert.equal(await take('wf-2'), null, 'already let go');
  // One planted under the key, not a record of this page's: refused.
  const { tx } = await import('../src/chora/handoff.js');
  await tx('readwrite', (s) => s.put({ handback: 1, workflow: 'wf-1', files: [new File(['x'], 'x.json')], at: Date.now() }, KEY));
  assert.equal(await take('wf-1'), null);
  // Stale: let go by dropStale; fresh: kept by it (the presence, so the absence means something).
  await give('wf-1', REF);
  assert.equal(await dropStale(), false);
  assert.ok(await take('wf-1'));
  await give('wf-1', REF);
  assert.equal(await dropStale(Date.now() + HANDBACK_FRESH + 1), true);
  assert.equal(await take('wf-1'), null);
  delete globalThis.indexedDB;
});

test('taking a hand-back, or letting a stale one go, reads and deletes in one transaction: a record written meanwhile is never lost', async () => {
  globalThis.indexedDB = new IDBFactory();
  const B = { ...REF, name: 'second.chora.json', sha256: hex('second') };
  // take() and a give() started together: the give is queued after take's transaction, never inside it.
  await give('wf-1', REF);
  const [taken] = await Promise.all([take('wf-1'), give('wf-1', B)]);
  assert.deepEqual(taken?.files, [REF], 'the record there when take began');
  assert.deepEqual((await take('wf-1'))?.files, [B], 'the one written meanwhile is still there');
  // dropStale() and a fresh give() started together: the stale one goes, the fresh one stays.
  const { tx } = await import('../src/chora/handoff.js');
  await tx('readwrite', (s) => s.put({ ...record('wf-1', REF), at: Date.now() - HANDBACK_FRESH - 1 }, KEY));
  const [dropped] = await Promise.all([dropStale(), give('wf-1', B)]);
  assert.equal(dropped, true);
  assert.deepEqual((await take('wf-1'))?.files, [B], 'the fresh one written meanwhile is kept');
  delete globalThis.indexedDB;
});

test('the reference is one Methodos accepts as a hand-off of a dataset, made as Methodos makes one, and nothing Methodos refuses is used here', async () => {
  const text = '{"spatialEntities":[]}\n'; const file = new File([text], 'antonine.chora.json');
  const ref = await refOf(file);
  assert.ok(isRef(ref));
  assert.deepEqual(checkHandoff(record('wf-1', ref).files, ['dataset'], 'the step "place"'), [ref]);
  assert.deepEqual(await refsOf([file], 'dataset'), [ref]);
  assert.deepEqual(await refsDiffer([ref], [file]), []);
  // The control: another file is told apart by refsDiffer.
  assert.deepEqual(await refsDiffer([ref], [new File([text + ' '], 'antonine.chora.json')]), ['antonine.chora.json', 'antonine.chora.json']);
  assert.ok(Object.hasOwn(TYPES, TYPE));
  // At least as strict: every reference Methodos refuses is refused here too.
  for (const bad of [{ ...ref, sha256: ref.sha256.toUpperCase() }, { ...ref, size: -1 }, { ...ref, name: '' }, { ...ref, type: 'nonsense' }, { name: 'a', size: 1 }, null])
    assert.equal(isRef(bad) || isDatasetRef(bad), false, JSON.stringify(bad));
});

test('the hand-back completes the workflow\'s step "place", which is where Chora\'s way back belongs (no operation of its own)', async () => {
  assert.equal(OPERATIONS['place.handback'], undefined);
  assert.equal(OPERATIONS.place.kind, 'interactive'); assert.equal(OPERATIONS.place.available, true);
  assert.match(OPERATIONS.place.waitsFor, /handed back/);
  const fake = (type, name) => [{ type, name, size: 1, sha256: hex(name) }];
  let s = runner.start(RECIPES['map-your-data'], { 'has-regions': false, 'will-draw': true, 'will-publish': false, target: 'plato-json' }, { files: fake('files', 'places.csv') });
  // Every step before "place" done with outputs of the types it gives, as the page and the adapters would.
  for (s = runner.next(s); s.current !== 'place'; s = runner.next(s)) {
    const st = s.steps.find((x) => x.id === s.current);
    s = runner.complete(s, st.id, Object.fromEntries(Object.entries(OPERATIONS[st.op].gives).map(([k, t]) => [k, fake(t, `${st.id}.${k}`)])));
  }
  assert.equal(s.status, 'waiting');
  const r = check(record('wf-1', await refOf(new File(['{}'], 'places.chora.json'))), 'wf-1');
  const done = runner.complete(s, 'place', { dataset: r.files });
  assert.deepEqual(done.steps.find((x) => x.id === 'place').outputs, { dataset: r.files });
  assert.deepEqual(runner.inputsOf(runner.next(done), 'again').files, r.files, 'the next step takes the dataset Chora saved');
});
