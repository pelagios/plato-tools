// Chora's hand-back to a Methodos workflow (src/chora/handback.js): the record's shape, its check on
// read (bad, old and foreign records refused), the workflow id taken from the address, and the SHA-256
// over known bytes. The reference must be the shape of a Methodos hand-off, { type, name, size, sha256 }
// (src/engine/methodos/handoffs.js, on the branch methodos-engine): pinned here, and checked against
// that module itself where it is present (in this tree once merged, or at METHODOS_HANDOFFS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { FRESH, stash, take as takeHandoff } from '../src/chora/handoff.js';
import { KEY, FORMAT, TYPE, workflowOf, isWorkflowId, backTo, sha256Hex, refOf, isDatasetRef, record, check, give, take, dropStale } from '../src/chora/handback.js';

const hex = (b) => createHash('sha256').update(b).digest('hex');
const NOW = 1_800_000_000_000;
const REF = { type: 'dataset', name: 'antonine.chora.json', size: 12, sha256: hex('hello, world') };

test('the SHA-256 is SubtleCrypto\'s over the exact bytes: the standard\'s vectors, and Node\'s own over random bytes', async () => {
  assert.equal(await sha256Hex(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const bytes = randomBytes(300_001);
  assert.equal(await sha256Hex(bytes), hex(bytes));
  // The control: one byte changed changes the digest (the comparison can see a difference).
  const other = Buffer.from(bytes); other[150_000] ^= 1;
  assert.notEqual(await sha256Hex(other), hex(bytes));
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
  assert.deepEqual(check(good, 'wf-1', NOW + FRESH - 1), good);
  assert.notEqual(check(good, 'wf-1', NOW), good, 'rebuilt, not the object read');
  const f = (files) => ({ ...good, files });
  const refused = {
    'nothing': undefined, 'null': null, 'a string': 'wf-1', 'an array': [good], 'a number': 1,
    'another workflow\'s (foreign)': { ...good, workflow: 'wf-2' },
    'an older format': { ...good, handback: 0 }, 'a later format': { ...good, handback: 2 }, 'the format as text': { ...good, handback: '1' },
    'no format (a hand-off\'s shape)': { files: good.files, at: NOW, workflow: 'wf-1' },
    'a key more': { ...good, run: 'now' }, 'no time': { handback: 1, workflow: 'wf-1', files: good.files },
    'two minutes old (old)': { ...good, at: NOW - FRESH }, 'ten minutes old': { ...good, at: NOW - 10 * 60 * 1000 },
    'from the future': { ...good, at: NOW + 1 }, 'time as text': { ...good, at: String(NOW) },
    'no files': f([]), 'files not a list': f(REF), 'two files': f([REF, REF]),
    'a File, as the hand-off keeps (bytes, not a reference)': f([new File(['x'], 'a.json')]),
    'of type files': f([{ ...REF, type: 'files' }]), 'of type work.krisis': f([{ ...REF, type: 'work.krisis' }]), 'of no type': f([{ name: REF.name, size: REF.size, sha256: REF.sha256 }]),
    'an upper-case hash': f([{ ...REF, sha256: REF.sha256.toUpperCase() }]), 'a short hash': f([{ ...REF, sha256: REF.sha256.slice(1) }]),
    'a size below zero': f([{ ...REF, size: -1 }]), 'a fractional size': f([{ ...REF, size: 1.5 }]), 'a size as text': f([{ ...REF, size: '12' }]),
    'no name': f([{ ...REF, name: '' }]), 'a path': f([{ ...REF, name: '../../etc/passwd' }]), 'a name with a line break': f([{ ...REF, name: 'a\n<script>' }]),
    'a name too long': f([{ ...REF, name: 'a'.repeat(256) }]), 'a reference with a key more': f([{ ...REF, bytes: 'eA==' }]),
  };
  for (const [why, v] of Object.entries(refused)) assert.equal(check(v, 'wf-1', NOW), null, why);
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
  assert.equal(await dropStale(Date.now() + FRESH + 1), true);
  assert.equal(await take('wf-1'), null);
  delete globalThis.indexedDB;
});

// The Methodos module, where it can be reached: in this tree once methodos-engine is merged, else at
// METHODOS_HANDOFFS (a path to src/engine/methodos/handoffs.js in a checkout of that branch).
const here = fileURLToPath(new URL('../src/engine/methodos/handoffs.js', import.meta.url));
const methodosAt = existsSync(here) ? here : process.env.METHODOS_HANDOFFS || null;
test('the reference is one Methodos accepts as a hand-off of a dataset, made as Methodos makes one, and nothing Methodos refuses is used here',
  { skip: methodosAt ? false : 'src/engine/methodos/handoffs.js is not on this branch and METHODOS_HANDOFFS is not set: the shape is pinned by the tests above' }, async () => {
    const m = await import(pathToFileURL(methodosAt).href);
    const text = '{"spatialEntities":[]}\n'; const file = new File([text], 'antonine.chora.json');
    const ref = await refOf(file);
    assert.ok(m.isRef(ref));
    assert.deepEqual(m.checkHandoff(record('wf-1', ref).files, ['dataset'], 'the step "place"'), [ref]);
    // Made by Methodos from the same file (Krisis's streaming hash): the same reference, key for key.
    assert.deepEqual(await m.refsOf([file], 'dataset'), [ref]);
    assert.deepEqual(await m.refsDiffer([ref], [file]), []);
    assert.ok(Object.hasOwn(m.TYPES, TYPE));
    // At least as strict: every reference Methodos refuses is refused here too.
    for (const bad of [{ ...ref, sha256: ref.sha256.toUpperCase() }, { ...ref, size: -1 }, { ...ref, name: '' }, { ...ref, type: 'nonsense' }, { name: 'a', size: 1 }, null])
      if (!m.isRef(bad)) assert.equal(isDatasetRef(bad), false, JSON.stringify(bad));
  });
