// Chora at the scale of DEEP (539,372 places, 1,414,328 attestations): what the full-size run of
// 30 September 2026 found. A JSON Lines dataset is saved as JSON Lines, as it came; a write that
// cannot hold what was read is refused before the version check (Mneme), which took ~90% of a
// 14-minute save to say so; the storage a load and a save need is estimated before they start; and
// the page is told which step of a save it is on. Each test below failed before its change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'fflate';
import { env, textFile } from './engine.js';
import { detect } from '../src/engine/input.js';
import { save, savedName, refusalOf } from '../src/engine/chora/save.js';
import { newGeometryAttestation } from '../src/engine/chora/draw.js';
import { load } from '../src/engine/chora/store.js';
import { choraSavedFormat, choraSaveText, choraSaveProgress, choraStorageWarning, choraPersistNote, CHORA_TEXT } from '../src/engine/words.js';
import { uncompressedSize, loadNeed, saveNeed, storageShort, shouldPersist, PERSIST_ABOVE } from '../src/engine/chora/storage.js';

const X = 'https://example.org/';
const who = { name: 'Ada Surveyor' };
const drawing = (x, y) => newGeometryAttestation({ geojson: { type: 'Point', coordinates: [x, y] }, role: 'RepresentativePoint', contributor: who, created: '2026-09-30T10:00:00Z' });
const place = (id, label, n = 1) => ({ '@id': X + 'p/' + id, label, attestations: Array.from({ length: n }, (_, i) => ({ '@id': `${X}a/${id}-${i}`, names: [{ toponym: label }], sources: [{ title: 's' }], created: '2013-09-19T00:00:00Z' })) });
const idr = (id, other) => ({ subject: X + 'p/' + id, object: other, identityType: 'unspecified', basis: 'a test' });
const HEADER = { $schema: 'https://w3id.org/plato/schemas/place-centric.schema.json', profile: 'place-centric', gazetteer: { '@id': X + 'g/1', title: 'Interleaved', licence: 'https://creativecommons.org/licenses/by/4.0/', status: 'published', version: '1' } };
// The shape of DEEP's JSON Lines export (tiny.jsonl of the scale run): places, then identity relations
// among them, then more places, as the file lists them volume by volume.
const INTERLEAVED = [HEADER, place('a', 'Alpha', 2), place('b', 'Beta'), idr('a', 'https://sws.geonames.org/1/'), idr('b', 'https://sws.geonames.org/2/'), place('c', 'Gamma', 3), place('d', 'Delta')];
const jsonl = (rows, name = 'deep-like.jsonl') => textFile(rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n', name);

/** A save in Node, as test/chora-save.test.js does it, with every progress event kept. */
async function saved(file, additions, options = {}) {
  const e = env();
  const events = [];
  e.progress = (p) => events.push(p);
  const input = await detect([file]);
  const r = await save(input, additions, e, { reopen: (o) => new File(e.outs[o.name], o.name), discard: (o) => { delete e.outs[o.name]; }, ...options });
  const name = r.outputs[0]?.name;
  return { ...r, input, e, events, name, text: name ? e.outs[name].join('') : null };
}
const mnemeRan = (events) => events.some((p) => p.version || p.phase === 'comparing' || p.save === 'checking');

// ---- 1. The format saved follows the dataset's --------------------------------------------------
test('a JSON Lines dataset with identity relations among its places is saved as JSON Lines, line for line, and Mneme passes with exactly the drawings added', async () => {
  const additions = [{ placeId: X + 'p/b', attestation: drawing(1, 1) }, { placeId: X + 'p/d', attestation: drawing(2, 2) }];
  for (const options of [{}, { hasPlace: (k) => ['a', 'b', 'c', 'd'].some((x) => k === X + 'p/' + x) }]) {
    const r = await saved(jsonl(INTERLEAVED), additions, options);
    assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
    assert.equal(r.name, 'deep-like.chora.jsonl');
    const out = r.text.trimEnd().split('\n').map((l) => JSON.parse(l));
    assert.equal(out.length, INTERLEAVED.length, 'a line for each line read, and no more');
    // Every line as it was, in its place: the header, the relations among the places, the places not
    // drawn on; a place drawn on has its own attestations first, as they were, then the drawings.
    assert.equal(out[0].profile, 'place-centric');
    assert.deepEqual(out[0].gazetteer, HEADER.gazetteer);
    for (const i of [1, 3, 4, 5]) assert.deepEqual(out[i], INTERLEAVED[i], `line ${i + 1} as it was`);
    assert.deepEqual(out[2].attestations, [...INTERLEAVED[2].attestations, additions[0].attestation]);
    assert.deepEqual(out[6].attestations, [...INTERLEAVED[6].attestations, additions[1].attestation]);
    assert.deepEqual(r.mneme.reasons, []);
    assert.equal(r.mneme.passed, true);
    assert.deepEqual(r.mneme.report.counts, { earlier: 7, later: 9, unchanged: 7, changed: 0, lost: 0, added: 2, retracted: 0, superseded: 0 });
    assert.match(choraSaveText(r), /^Saved, with 2 new attestations;/);
  }
});

test('the saved name and format follow the dataset: JSON Lines as JSON Lines, anything else as a PLATO JSON document', async () => {
  assert.equal(savedName('deep.jsonl.gz', 'plato-jsonl'), 'deep.chora.jsonl');
  assert.equal(savedName('deep.jsonl', 'plato-jsonl'), 'deep.chora.jsonl');
  assert.equal(savedName('deep.nt.gz', 'plato-json'), 'deep.chora.json');
  assert.equal(savedName('deep.json'), 'deep.chora.json', 'PLATO JSON when no format is named, as before');
  for (const [format, target, words] of [['plato-jsonl', 'plato-jsonl', 'PLATO JSON Lines'], ['plato-json', 'plato-json', 'PLATO JSON'], ['ntriples', 'plato-json', 'PLATO JSON'], ['tables', 'plato-json', 'PLATO JSON'], ['lpf-seq', 'plato-json', 'PLATO JSON']]) {
    assert.deepEqual(choraSavedFormat({ format }), { target, words }, format);
  }
  // The control: an attestation-centric JSON Lines file is JSON Lines still, regrouped by place.
  assert.equal(choraSavedFormat({ format: 'plato-jsonl', profile: 'attestation-centric' }).target, 'plato-jsonl');
  // A PLATO JSON document is saved as one, as before.
  const r = await saved(textFile(JSON.stringify({ ...HEADER, spatialEntities: [place('a', 'Alpha')] }), 'doc.json'), [{ placeId: X + 'p/a', attestation: drawing(0, 0) }]);
  assert.equal(r.name, 'doc.chora.json');
  assert.equal(JSON.parse(r.text).spatialEntities[0].attestations.length, 2);
  assert.equal(r.mneme.passed, true, r.mneme.reasons.join('; '));
});

// ---- 2. A write that cannot hold what was read is refused before Mneme --------------------------
test('refusalOf: a write report saying the output does not hold the input is a refusal; problems of the data itself are not', () => {
  const item = (severity, kind, message = kind) => ({ severity, kind, message, count: 1, examples: [] });
  // The scale run's report: the writer moved 538,369 places among the identity relations.
  const order = refusalOf({ errors: 0, counts: {}, items: [item('warning', 'order', 'A place came after the identity relations; it is written with them')] });
  assert.equal(order.length, 1);
  assert.equal(order[0].kind, 'order');
  for (const kind of ['record-failed', 'json-syntax', 'rdf-syntax', 'not-a-list', 'late-header', 'unreadable', 'lpf-v2']) {
    assert.deepEqual(refusalOf({ items: [item('error', kind)] }).map((i) => i.kind), [kind], kind);
  }
  // The controls: a place the schema refuses is written as read, and what a conversion cannot carry
  // is reported, not hidden; neither stops a save (test/chora-save.test.js shows such saves passing).
  assert.deepEqual(refusalOf({ items: [item('error', 'schema'), item('warning', 'no-label'), item('loss', 'dropped:foo'), item('warning', 'attestation-centric')] }), []);
  assert.deepEqual(refusalOf({ items: [] }), []);
  assert.deepEqual(refusalOf(undefined), []);
});

test('a dataset with a line that cannot be read is refused before the version check runs, saying why, and nothing is kept or offered', async () => {
  const rows = [HEADER, place('a', 'Alpha'), '{"@id": "https://example.org/p/broken", "label": ', place('b', 'Beta')];
  const additions = [{ placeId: X + 'p/b', attestation: drawing(1, 1) }];
  // Read first (no store), known from the store with the report of its reading, and known from the
  // store with no report: the last is found in the writing, and refused there, before Mneme.
  const e = env();
  const store = await load(await detect([jsonl(rows, 'broken.jsonl')]), e, await e.openDb());
  assert.ok(store.has(X + 'p/b') && store.loaded.report.items.some((i) => i.kind === 'json-syntax'), 'Chora opens it, and its reading reports the line');
  for (const [how, options, wrote] of [
    ['read first', {}, false],
    ['store, with the report of its reading', { hasPlace: (k) => k === X + 'p/b', readReport: store.loaded.report }, false],
    ['store, without it', { hasPlace: (k) => k === X + 'p/b' }, true],
  ]) {
    const t0 = Date.now();
    const r = await saved(jsonl(rows, 'broken.jsonl'), additions, options);
    const refused = r.report.items.filter((i) => i.kind === 'chora-not-kept');
    assert.equal(refused.length, 1, `${how}: ${JSON.stringify(r.report.items.map((i) => i.kind))}`);
    assert.equal(refused[0].severity, 'error');
    assert.equal(refused[0].message, CHORA_TEXT['chora-not-kept']);
    assert.match(refused[0].examples.join(), /not valid JSON/, `${how}: says why`);
    assert.deepEqual(r.outputs, [], `${how}: nothing offered`);
    assert.deepEqual(Object.keys(r.e.outs), [], `${how}: nothing kept`);
    assert.equal(r.mneme, null, how);
    assert.equal(choraSaveText(r), 'Nothing was saved.');
    // The version check did not run: none of its progress, while the save's own was reported.
    // (Refused from the report of its reading, nothing is read at all.)
    assert.ok(options.readReport ? r.events.length === 0 : r.events.length > 0, `${how}: ${r.events.length} progress events`);
    assert.equal(mnemeRan(r.events), false, `${how}: ${JSON.stringify(r.events.map((p) => [p.save, p.version, p.phase]))}`);
    assert.equal(r.events.some((p) => p.save === 'writing'), wrote, `${how}: written ${wrote ? 'and then refused' : 'not at all'}`);
    assert.ok(Date.now() - t0 < 5000);
  }
  store.close();
  // The control: the same dataset without the broken line is saved, and the version check runs.
  const ok = await saved(jsonl(rows.filter((r) => typeof r !== 'string'), 'mended.jsonl'), additions);
  assert.equal(ok.mneme.passed, true, ok.mneme.reasons.join('; '));
  assert.equal(mnemeRan(ok.events), true);
});

// ---- 4. The page is told which step a save is on ----------------------------------------------
test('a save reports its steps: writing, then the version check reading each version, n of N attestations, then comparing', async () => {
  const r = await saved(jsonl(INTERLEAVED), [{ placeId: X + 'p/b', attestation: drawing(1, 1) }], { attestations: 7 });
  assert.equal(r.mneme.passed, true);
  const steps = r.events.filter((p) => p.save);
  assert.equal(steps.length, r.events.length, 'every event says which step of the save it is');
  const writing = steps.filter((p) => p.save === 'writing');
  const earlier = steps.filter((p) => p.save === 'checking' && p.version === 'earlier');
  const later = steps.filter((p) => p.save === 'checking' && p.version === 'later');
  assert.ok(writing.length && earlier.length && later.length, JSON.stringify(steps.map((p) => [p.save, p.version, p.phase])));
  assert.ok(steps.findIndex((p) => p.save === 'checking') > steps.findLastIndex((p) => p.save === 'writing'), 'writing, then checking');
  assert.ok(steps.some((p) => p.save === 'checking' && p.phase === 'comparing'));
  assert.ok(writing.every((p) => p.total === 7));
  assert.ok(earlier.every((p) => p.total === 7) && later.every((p) => p.total === 8), JSON.stringify([...earlier, ...later].map((p) => p.total)));
  // In words, for the page.
  assert.equal(choraSaveProgress({ save: 'writing', attestations: 700000, total: 1414328, elapsedMs: 65000 }), 'Saving, step 1 of 2, writing the file: 700,000 of 1,414,328 attestations (1 min 5 s)');
  assert.equal(choraSaveProgress({ save: 'checking', version: 'earlier', phase: 'reading', attestations: 5, total: 7, elapsedMs: 0 }), 'Saving, step 2 of 2, the version check (Mneme), reading the dataset as opened: 5 of 7 attestations (0 s)');
  assert.equal(choraSaveProgress({ save: 'checking', version: 'later', phase: 'reading', attestations: 8, total: 8, elapsedMs: 0 }), 'Saving, step 2 of 2, the version check (Mneme), reading the file written: 8 of 8 attestations (0 s)');
  assert.equal(choraSaveProgress({ save: 'checking', phase: 'comparing', elapsedMs: 2000 }), 'Saving, step 2 of 2, the version check (Mneme), comparing the two (2 s)');
  assert.equal(choraSaveProgress({ save: 'writing', phase: 'loading', triples: 50000, elapsedMs: 0 }), 'Saving, step 1 of 2, writing the file: loading 50,000 triples (0 s)');
  assert.equal(choraSaveProgress({ save: 'writing', attestations: 3, elapsedMs: 0 }), 'Saving, step 1 of 2, writing the file: 3 attestations (0 s)');
});

// ---- 3. The storage a load and a save need ------------------------------------------------------
// The measured run (full DEEP, 30 September 2026): JSON Lines 51,476,824 bytes gzipped,
// 1,184,971,984 read; N-Triples 141,297,263 gzipped, 2,718,243,383 read. Chora's database 1.40 GB
// either way; the N-Triples load's triple store 3.35 GB beside it. The save's file 1.14 GB, Mneme's
// ledger 1.27 GB (from JSON Lines) or 0.89 GB (from N-Triples, with a 3.35 GB triple store beside).
const GB = 1e9;
test('the size a gzipped file will be read at is taken from its gzip trailer, past 4 GB too', () => {
  const text = new TextEncoder().encode('{"label":"x"}\n'.repeat(5000));
  const gz = gzipSync(text);
  assert.equal(uncompressedSize({ name: 'a.jsonl.gz', size: gz.length }, gz.slice(-4)), text.length);
  assert.equal(uncompressedSize({ name: 'a.jsonl', size: 1234 }, null), 1234, 'a file not gzipped is its size');
  const small = gzipSync(new TextEncoder().encode('{}'));
  assert.equal(uncompressedSize({ name: 'tiny.json.gz', size: small.length }, small.slice(-4)), 2, 'a tiny file bigger gzipped than not is taken at its word');
  // The trailer holds the size modulo 2^32: a 5 GB file compressed to 200 MB reads as 705 MB, which is
  // too small to be believed of text, and 4 GB is added until it is not.
  const trailer = new Uint8Array(new Uint32Array([5e9 % 2 ** 32]).buffer);
  assert.equal(uncompressedSize({ name: 'big.nt.gz', size: 200e6 }, trailer), 5e9);
  // Without a trailer to read, a guess from the ratio DEEP's exports have (about 20 to 1).
  assert.ok(uncompressedSize({ name: 'a.jsonl.gz', size: 51476824 }, null) >= 1.0 * GB);
});

test('the storage a load needs covers what the full DEEP load used, JSON Lines and N-Triples, without asking for more than twice that', () => {
  const jsonl = loadNeed({ name: 'deep-plato.jsonl.gz', bytes: 1184971984 });
  assert.ok(jsonl >= 1.40 * GB && jsonl <= 2.8 * GB, `${jsonl}`);
  const nt = loadNeed({ name: 'deep-plato.nt.gz', bytes: 2718243383 });
  assert.ok(nt >= (3.35 + 1.40) * GB && nt <= 9.5 * GB, `${nt}`);
  assert.ok(loadNeed({ name: 'x.ttl', bytes: 1e6 }) > loadNeed({ name: 'x.json', bytes: 1e6 }), 'RDF needs a triple store beside the database');
});

test('the storage a save needs covers what the full DEEP save used: the file, Mneme\'s ledger, and for RDF a triple store', () => {
  const jsonl = saveNeed({ name: 'deep-plato.jsonl.gz', bytes: 1184971984 });
  assert.ok(jsonl >= (1.14 + 1.27) * GB && jsonl <= 4.8 * GB, `${jsonl}`);
  const nt = saveNeed({ name: 'deep-plato.nt.gz', bytes: 2718243383 });
  assert.ok(nt >= (1.14 + 0.89 + 3.35) * GB && nt <= 10.8 * GB, `${nt}`);
});

test('storage is short when what is needed is more than the browser has left; unknown is not short', () => {
  assert.deepEqual(storageShort(3 * GB, { quota: 10 * GB, usage: 8 * GB }), { need: 3 * GB, free: 2 * GB, quota: 10 * GB });
  assert.equal(storageShort(1 * GB, { quota: 10 * GB, usage: 8 * GB }), null);
  assert.equal(storageShort(1 * GB, { quota: 10 * GB }), null, 'no usage given: all of it free');
  assert.equal(storageShort(1 * GB, null), null);
  assert.equal(storageShort(1 * GB, {}), null);
  assert.equal(PERSIST_ABOVE, 200e6);
  assert.equal(shouldPersist(250e6), true);
  assert.equal(shouldPersist(150e6), false);
});

test('the storage warnings and the note on keeping storage say what is needed, what is left, and what to do', () => {
  const short = storageShort(saveNeed({ name: 'deep-plato.jsonl.gz', bytes: 1184971984 }), { quota: 3 * GB, usage: 1.5 * GB });
  assert.ok(short, 'DEEP cannot be saved in 1.5 GB');
  assert.equal(choraStorageWarning('save', short), "Saving needs about 2.76 GB of the browser's storage, for the file and the version check's working copy, and this browser has only 1.50 GB left for this site (of the 3.00 GB it allows). The save may stop part-way. Free some disk space, then save.");
  assert.match(choraStorageWarning('load', { need: 1.5e9, free: 2e8, quota: 1e9 }), /^Opening this dataset needs about 1.50 GB .* only 200.0 MB left .* private one/);
  assert.match(choraPersistNote(true), /It agreed/);
  assert.match(choraPersistNote(false), /did not agree.*save often/);
  assert.match(choraPersistNote(null), /cannot be asked/);
});
