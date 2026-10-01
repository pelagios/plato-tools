// Chora at the scale of DEEP (539,372 places, 1,414,328 attestations): what the full-size run of
// 30 September 2026 found. A JSON Lines dataset is saved as JSON Lines, as it came; a write that
// cannot hold what was read is refused before the version check (Mneme), which took ~90% of a
// 14-minute save to say so; the storage a load and a save need is estimated before they start; and
// the page is told which step of a save it is on. Each test below failed before its change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'fflate';
import { readFileSync, readdirSync } from 'node:fs';
import { env, textFile } from './engine.js';
import { detect } from '../src/engine/input.js';
import { save, savedName, refusalOf } from '../src/engine/chora/save.js';
import { newGeometryAttestation } from '../src/engine/chora/draw.js';
import { load, keyer } from '../src/engine/chora/store.js';
import { run } from '../src/engine/pipeline.js';
import { choraSavedFormat, choraSaveText, choraProblemText, choraSaveProgress, choraStorageWarning, CHORA_TEXT } from '../src/engine/words.js';
import { uncompressedSize, sizeRead, loadNeed, saveNeed, storageShort } from '../src/engine/chora/storage.js';

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
  const input = await detect([].concat(file));
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
  // The writer's own: identity relations it held back and could not write (the run is incomplete).
  assert.deepEqual(refusalOf({ items: [item('error', 'identity-relations-lost')] }, { written: true }).map((i) => i.kind), ['identity-relations-lost']);
  for (const kind of ['record-failed', 'json-syntax', 'rdf-syntax', 'not-a-list', 'late-header', 'unreadable', 'lpf-v2']) {
    assert.deepEqual(refusalOf({ items: [item('error', kind)] }).map((i) => i.kind), [kind], kind);
  }
  // The controls: a place the schema refuses is written as read, and what a conversion cannot carry
  // is reported, not hidden; neither stops a save (test/chora-save.test.js shows such saves passing).
  assert.deepEqual(refusalOf({ items: [item('error', 'schema'), item('warning', 'no-label'), item('loss', 'dropped:foo')] }), []);
  assert.deepEqual(refusalOf({ items: [item('error', 'schema'), item('warning', 'no-label'), item('loss', 'dropped:foo')] }, { written: true }), []);
  // The writer of PLATO JSON (Lines) drops an attestation-shaped line of a place-centric file, saying
  // 'attestation-centric': in the WRITE report that is a refusal. A reading reports no such thing.
  assert.deepEqual(refusalOf({ items: [item('warning', 'attestation-centric')] }, { written: true }).map((i) => i.kind), ['attestation-centric']);
  assert.deepEqual(refusalOf({ items: [item('warning', 'attestation-centric')] }), [], 'not in the report of a reading');
  assert.deepEqual(refusalOf({ items: [] }), []);
  assert.deepEqual(refusalOf(undefined), []);
});

test('a place-centric JSON Lines file with an attestation-shaped line (which the writer drops) is refused before the version check, and nothing is kept', async () => {
  const loose = { '@id': X + 'a/loose', about: X + 'p/a', names: [{ toponym: 'Loose' }], sources: [{ title: 's' }] };
  const rows = [HEADER, place('a', 'Alpha'), loose, place('b', 'Beta')];
  const additions = [{ placeId: X + 'p/b', attestation: drawing(1, 1) }];
  for (const [how, options] of [['read first', {}], ['from the store', { hasPlace: (k) => k === X + 'p/b' }]]) {
    const r = await saved(jsonl(rows, 'loose.jsonl'), additions, options);
    // It was written, and the writer said what it dropped: the subject of the refusal is present.
    assert.ok(r.events.some((p) => p.save === 'writing'), `${how}: written`);
    assert.ok(r.report.items.some((i) => i.kind === 'attestation-centric'), `${how}: ${JSON.stringify(r.report.items.map((i) => i.kind))}`);
    const refused = r.report.items.filter((i) => i.kind === 'chora-not-kept');
    assert.equal(refused.length, 1, `${how}: ${JSON.stringify(r.report.items.map((i) => i.kind))}`);
    assert.match(refused[0].examples.join(), /has no place to go here/, `${how}: says why`);
    assert.deepEqual(r.outputs, [], `${how}: nothing offered`);
    assert.deepEqual(Object.keys(r.e.outs), [], `${how}: nothing kept`);
    assert.equal(r.mneme, null, how);
    assert.equal(mnemeRan(r.events), false, `${how}: ${JSON.stringify(r.events.map((p) => [p.save, p.version, p.phase]))}`);
  }
  // The control: the same file without that line is saved, and the version check runs and passes.
  const ok = await saved(jsonl(rows.filter((r) => r !== loose), 'tight.jsonl'), additions);
  assert.equal(ok.mneme.passed, true, ok.mneme.reasons.join('; '));
  assert.equal(mnemeRan(ok.events), true);
});

// run() closes the outputs of a run stopped part-way (src/engine/pipeline.js), and returns none: the
// file it was writing is still there, and removing it is save()'s job, which this tests.
test('a write that stops part-way (a gzip cut short) leaves no file behind: save() removes the file the run opened', async () => {
  const rows = [HEADER, ...Array.from({ length: 300 }, (_, i) => place('p' + i, 'Place ' + i, 3))];
  const gz = gzipSync(new TextEncoder().encode(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'));
  const cut = () => new File([gz.slice(0, Math.floor(gz.length * 0.6))], 'cut.jsonl.gz');
  const additions = [{ placeId: X + 'p/p1', attestation: drawing(1, 1) }];
  // A host that makes the file when it is opened, as the browser's (createSyncAccessHandle) and the
  // command line's do, and says which it opened.
  const once = async (discard) => {
    const e = env(), opened = [], removed = [], output = e.output;
    e.output = async (name) => { opened.push(name); e.outs[name] = []; return output(name); };
    const r = await save(await detect([cut()]), additions, e, { hasPlace: () => true, reopen: (o) => new File(e.outs[o.name], o.name), discard: discard && ((o) => { if (!(o.name in e.outs)) throw new Error('no such file'); removed.push(o.name); delete e.outs[o.name]; }) });
    return { r, e, opened, removed };
  };
  // The control: given no discard, the file opened for the write is still there when the save ends.
  const kept = await once(false);
  assert.equal(kept.r.incomplete, true);
  assert.deepEqual(kept.r.outputs, [], 'the run stopped part-way returns no outputs to go by');
  assert.deepEqual(kept.opened, ['cut.chora.jsonl'], 'the write opened its file');
  assert.deepEqual(Object.keys(kept.e.outs), ['cut.chora.jsonl'], 'without a discard, the file is left');
  // The subject: save() removes it, by the name it was opened under, though the run returned none.
  const gone = await once(true);
  assert.equal(gone.r.incomplete, true);
  assert.ok(gone.r.report.items.some((i) => i.kind === 'unreadable'), JSON.stringify(gone.r.report.items.map((i) => i.kind)));
  assert.equal(gone.r.report.items[0].kind, 'chora-unreadable', 'refused as a dataset not read to the end');
  assert.deepEqual(gone.opened, ['cut.chora.jsonl']);
  assert.deepEqual(gone.removed, ['cut.chora.jsonl'], 'the file opened is removed');
  assert.deepEqual(Object.keys(gone.e.outs), [], 'nothing kept');
  assert.deepEqual(gone.r.outputs, []);
});

test('a dataset whose opening was cut short is refused as not read to the end, not as a file that could not hold it', async () => {
  const rows = [HEADER, ...Array.from({ length: 300 }, (_, i) => place('p' + i, 'Place ' + i, 3))];
  const gz = gzipSync(new TextEncoder().encode(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'));
  const cut = () => new File([gz.slice(0, Math.floor(gz.length * 0.6))], 'cut.jsonl.gz');
  const additions = [{ placeId: X + 'p/p1', attestation: drawing(1, 1) }];
  const e = env();
  const store = await load(await detect([cut()]), e, await e.openDb());
  assert.equal(store.loaded.incomplete, true, 'the opening was cut short');
  assert.ok(store.loaded.report.items.some((i) => i.kind === 'unreadable'), 'and its report says so');
  for (const [how, options] of [
    ['read first', {}],
    ['from the store', { hasPlace: () => true, readReport: store.loaded.report, readIncomplete: store.loaded.incomplete }],
  ]) {
    const r = await saved(cut(), additions, options);
    const kinds = r.report.items.map((i) => i.kind);
    assert.equal(kinds[0], 'chora-unreadable', `${how}: ${JSON.stringify(kinds)}`);
    assert.equal(r.report.items[0].message, CHORA_TEXT['chora-unreadable']);
    assert.ok(!kinds.includes('chora-not-kept'), `${how}: ${JSON.stringify(kinds)}`);
    assert.deepEqual(r.outputs, [], how);
    assert.deepEqual(Object.keys(r.e.outs), [], `${how}: nothing kept`);
    assert.equal(r.events.some((p) => p.save === 'writing'), false, `${how}: not written`);
  }
  store.close();
});

// The PLATO JSON writer holds identity relations back, past 10,000 in a working database; one that
// cannot be had loses them, and the run is incomplete. The dataset was read whole: the FILE could not
// hold it, and the refusal says so, not that the dataset could not be read.
test('a write the writer left short (identity relations lost) is refused as a file that could not hold the dataset, and removed', async () => {
  const doc = JSON.stringify({ ...HEADER, spatialEntities: [place('a', 'Alpha'), place('b', 'Beta')], identityRelations: Array.from({ length: 10001 }, (_, i) => idr(i % 2 ? 'a' : 'b', `https://sws.geonames.org/${i}/`)) });
  const additions = [{ placeId: X + 'p/b', attestation: drawing(1, 1) }];
  const once = async (broken) => {
    const e = env();
    if (broken) e.openDb = async () => { throw new Error('no room'); };
    const r = await save(await detect([textFile(doc, 'many.json')]), additions, e, { hasPlace: () => true, reopen: (o) => new File(e.outs[o.name], o.name), discard: (o) => { delete e.outs[o.name]; } });
    return { r, e };
  };
  const { r, e } = await once(true);
  const kinds = r.report.items.map((i) => i.kind);
  assert.ok(kinds.includes('identity-relations-lost'), JSON.stringify(kinds));
  assert.equal(kinds[0], 'chora-not-kept', JSON.stringify(kinds));
  assert.equal(r.report.items[0].message, CHORA_TEXT['chora-not-kept']);
  assert.match(r.report.items[0].examples.join(), /identity relations are not in the output/);
  assert.ok(!kinds.includes('chora-unreadable'), JSON.stringify(kinds));
  assert.equal(r.incomplete, true);
  assert.deepEqual(r.outputs, []);
  assert.deepEqual(Object.keys(e.outs), [], 'nothing kept');
  assert.equal(r.mneme, null);
  // The control: with a working database the same save is written, checked, and passes.
  const ok = await once(false);
  assert.equal(ok.r.mneme?.passed, true, JSON.stringify(ok.r.mneme?.reasons || ok.r.report.items));
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
    const r = await saved(jsonl(rows, 'broken.jsonl'), additions, options);
    const refused = r.report.items.filter((i) => i.kind === 'chora-not-kept');
    assert.equal(refused.length, 1, `${how}: ${JSON.stringify(r.report.items.map((i) => i.kind))}`);
    assert.equal(refused[0].severity, 'error');
    assert.equal(refused[0].message, CHORA_TEXT['chora-not-kept']);
    assert.match(refused[0].examples.join(), /not valid JSON: line 3: /, `${how}: says why, and where`);
    assert.deepEqual(r.outputs, [], `${how}: nothing offered`);
    assert.deepEqual(Object.keys(r.e.outs), [], `${how}: nothing kept`);
    assert.equal(r.mneme, null, how);
    assert.equal(choraSaveText(r), 'Nothing was saved.');
    // The version check did not run: none of its progress, while the save's own was reported.
    // (Refused from the report of its reading, nothing is read at all.)
    assert.ok(options.readReport ? r.events.length === 0 : r.events.length > 0, `${how}: ${r.events.length} progress events`);
    assert.equal(mnemeRan(r.events), false, `${how}: ${JSON.stringify(r.events.map((p) => [p.save, p.version, p.phase]))}`);
    assert.equal(r.events.some((p) => p.save === 'writing'), wrote, `${how}: written ${wrote ? 'and then refused' : 'not at all'}`);
  }
  store.close();
  // The control: the same dataset without the broken line is saved, and the version check runs.
  const ok = await saved(jsonl(rows.filter((r) => typeof r !== 'string'), 'mended.jsonl'), additions);
  assert.equal(ok.mneme.passed, true, ok.mneme.reasons.join('; '));
  assert.equal(mnemeRan(ok.events), true);
});

// Spreadsheet tables with a sheet that cannot be read (names.csv in Latin-1): the reader stops there,
// or reads on past it and says the records are short; either way the run is incomplete, and a save
// of it is refused before the version check, saying why, with nothing kept.
const TABLES_DIR = 'test/fixtures/tables-routes';
const tables = (bad) => readdirSync(TABLES_DIR).filter((f) => f.endsWith('.csv')).sort().map((f) => {
  const text = readFileSync(`${TABLES_DIR}/${f}`, 'utf8');
  return new File([f === 'names.csv' && bad ? Buffer.from(text.replace('Grantanbrycg', 'Grantanbrycgö'), 'latin1') : Buffer.from(text, 'utf8')], f);
});
test('spreadsheet tables with a sheet that cannot be read are refused before the version check, saying why, and nothing is kept or offered', async () => {
  // A place of the tables, by the key a save finds it by.
  let first = null;
  const keyOf = keyer();
  await run({ input: await detect(tables(false)), action: 'check', options: { sink: { header() {}, event(ev) { if (ev.type === 'record' && first === null) first = keyOf(ev.value); }, async close() {} } } }, env());
  assert.ok(first, 'the tables have a place');
  const additions = [{ placeId: first, attestation: drawing(0.1, 52.2) }];
  // What Chora's store read of the tables, as the page has it when it saves.
  const e = env();
  const store = await load(await detect(tables(true)), e, await e.openDb());
  assert.equal(store.loaded.incomplete, true, 'the reading of the tables is incomplete');
  for (const [how, options, wrote] of [
    ['read first', {}, false],
    ['store, with its reading', { hasPlace: () => true, readReport: store.loaded.report, readIncomplete: store.loaded.incomplete }, false],
    ['store, without it', { hasPlace: () => true }, null],
  ]) {
    const r = await saved(tables(true), additions, { name: 'tables-routes', ...options });
    const kinds = r.report.items.map((i) => i.kind);
    const refused = r.report.items.filter((i) => i.kind === 'chora-unreadable' || i.kind === 'chora-not-kept');
    assert.ok(refused.length >= 1 && refused[0] === r.report.items[0], `${how}: the refusal comes first: ${JSON.stringify(kinds)}`);
    assert.equal(refused[0].severity, 'error');
    // Why, in words: the sheet, and that it is not UTF-8, in the refusal or in the problems after it.
    const words = r.report.items.filter((i) => i.severity === 'error').map(choraProblemText).join(' | ');
    assert.match(words, /names\.csv.*not encoded as UTF-8/, `${how}: ${words}`);
    assert.deepEqual(r.outputs, [], `${how}: nothing offered`);
    assert.deepEqual(Object.keys(r.e.outs), [], `${how}: nothing kept`);
    assert.equal(r.mneme, null, how);
    assert.equal(r.incomplete, true, how);
    assert.equal(choraSaveText(r), 'Nothing was saved.');
    assert.equal(mnemeRan(r.events), false, `${how}: ${JSON.stringify(r.events.map((p) => [p.save, p.version, p.phase]))}`);
    // Refused from what was read, nothing is written; found only in the writing, it may have been.
    if (wrote === false) assert.equal(r.events.some((p) => p.save === 'writing'), false, `${how}: not written`);
  }
  store.close();
  // The control: the same tables in UTF-8 are saved, and the version check runs and passes.
  const ok = await saved(tables(false), additions, { name: 'tables-routes' });
  assert.equal(ok.mneme?.passed, true, JSON.stringify(ok.mneme?.reasons || ok.report.items));
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
  // Spreadsheet tables are loaded into a working database, then checked, row by row, before a place is written.
  assert.equal(choraSaveProgress({ save: 'writing', phase: 'loading', rows: 50000, elapsedMs: 0 }), 'Saving, step 1 of 2, writing the file: loading the tables: 50,000 rows (0 s)');
  assert.equal(choraSaveProgress({ save: 'writing', phase: 'checking', rows: 100000, elapsedMs: 0 }), 'Saving, step 1 of 2, writing the file: checking the tables: 100,000 rows (0 s)');
  assert.equal(choraSaveProgress({ save: 'writing', phase: 'checking', elapsedMs: 0 }), 'Saving, step 1 of 2, writing the file: checking the tables (0 s)');
});

// ---- 3. The storage a load and a save need ------------------------------------------------------
// The measured run (full DEEP, 30 September 2026): JSON Lines 51,476,824 bytes gzipped,
// 1,184,971,984 read; N-Triples 141,297,263 gzipped, 2,718,243,383 read. Chora's database 1.40 GB
// either way; the N-Triples load's triple store 3.35 GB beside it. The save's file 1.14 GB, Mneme's
// ledger 1.27 GB (from JSON Lines) or 0.89 GB (from N-Triples, with a 3.35 GB triple store beside).
const GB = 1e9;
// A gzip trailer: CRC32 then ISIZE, the uncompressed size modulo 2^32, little-endian.
const trailerOf = (isize) => { const t = new Uint8Array(8); new DataView(t.buffer).setUint32(4, isize % 2 ** 32, true); return t; };
const GZ_HEAD = Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3);
test('the size a gzipped file will be read at is taken from its gzip trailer, when that can be believed', async () => {
  const text = new TextEncoder().encode('{"label":"x"}\n'.repeat(5000));
  const gz = gzipSync(text);
  assert.equal(await sizeRead(new File([gz], 'a.jsonl.gz')), text.length);
  assert.equal(await sizeRead(new File(['x'.repeat(1234)], 'a.jsonl')), 1234, 'a file not gzipped is its size');
  const small = gzipSync(new TextEncoder().encode('{}'));
  assert.equal(await sizeRead(new File([small], 'tiny.json.gz')), 2, 'a tiny file bigger gzipped than not is taken at its word');
  // A 17 MB gzip of text compressed only 2 to 1: its trailer is too small to be believed of PLATO's
  // text, but it is not 4 GB more: the larger of it and the typical ratio (20 to 1), 340 MB, not 4.3 GB.
  const est = uncompressedSize({ size: 17e6 }, { head: GZ_HEAD, tail: trailerOf(34e6) });
  assert.equal(est, 17e6 * 20);
  assert.ok(est < 1e9, `${est}`);
  // The trailer holds the size modulo 2^32: a 5 GB file compressed to 200 MB reads as 705 MB, which is
  // too small to be believed of text: the typical ratio is taken instead.
  assert.equal(uncompressedSize({ size: 200e6 }, { head: GZ_HEAD, tail: trailerOf(5e9) }), 4e9);
  // A trailer that is believable is taken as it is.
  assert.equal(uncompressedSize({ size: 51476824 }, { head: GZ_HEAD, tail: trailerOf(1184971984) }), 1184971984);
  // Without a trailer to read, a guess from the ratio DEEP's exports have (about 20 to 1).
  assert.ok(uncompressedSize({ size: 51476824 }, { head: GZ_HEAD, tail: null }) >= 1.0 * GB);
});

test('a gzip is known by its first two bytes, not by its name', async () => {
  const text = new TextEncoder().encode('{"label":"x"}\n'.repeat(5000));
  const gz = gzipSync(text);
  assert.equal(await sizeRead(new File([gz], 'export.jsonl')), text.length, 'gzipped, without .gz in its name');
  assert.equal(await sizeRead(new File([text], 'plain.jsonl.gz')), text.length, 'named .gz, and not gzipped');
});

test('a gzip of several members (bgzip, or files concatenated) is not taken at its last member\'s trailer', async () => {
  const enc = (s) => new TextEncoder().encode(s);
  const a = gzipSync(enc('{"label":"x"}\n'.repeat(400000))), b = gzipSync(enc('{"label":"y"}\n'.repeat(1000)));
  const cat = new Uint8Array(a.length + b.length); cat.set(a); cat.set(b, a.length);
  const lastMember = 14 * 1000;
  const est = await sizeRead(new File([cat], 'm.jsonl.gz'));
  assert.equal(est, Math.max(lastMember, cat.length * 20), `${est}`);
  // The control: each member alone is taken at its trailer.
  assert.equal(await sizeRead(new File([b], 'b.jsonl.gz')), lastMember);
  // bgzip says so in its first header (an extra field 'BC'), and is known from that alone.
  const bgzf = Uint8Array.of(0x1f, 0x8b, 8, 4, 0, 0, 0, 0, 0, 0xff, 6, 0, 0x42, 0x43, 2, 0);
  assert.equal(uncompressedSize({ size: 30e6 }, { head: bgzf, tail: trailerOf(150e6) }), 30e6 * 20);
  // The control: the same trailer after a plain header is believed.
  assert.equal(uncompressedSize({ size: 30e6 }, { head: GZ_HEAD, tail: trailerOf(150e6) }), 150e6);
});

test('the storage a load needs covers what the full DEEP load used, JSON Lines and N-Triples, without asking for more than twice that', () => {
  const jsonl = loadNeed({ name: 'deep-plato.jsonl.gz', bytes: 1184971984 });
  assert.ok(jsonl >= 1.40 * GB && jsonl <= 2.8 * GB, `${jsonl}`);
  const nt = loadNeed({ name: 'deep-plato.nt.gz', bytes: 2718243383 });
  assert.ok(nt >= (3.35 + 1.40) * GB && nt <= 9.5 * GB, `${nt}`);
  assert.ok(loadNeed({ name: 'x.ttl', bytes: 1e6 }) > loadNeed({ name: 'x.json', bytes: 1e6 }), 'RDF needs a triple store beside the database');
  // Attestation-centric PLATO JSON and W3C annotations are gathered in a triple store too (the
  // pipeline's needsStore): the store is of their triples, about 2.3 times their text (DEEP's).
  const plain = loadNeed({ name: 'x.json', bytes: 1e6, input: { format: 'plato-json', profile: 'place-centric' } });
  for (const input of [{ format: 'plato-json', profile: 'attestation-centric' }, { format: 'plato-jsonl', profile: 'attestation-centric' }, { format: 'w3c-annotations' }]) {
    const need = loadNeed({ name: 'x.json', bytes: 1e6, input });
    assert.ok(need >= (1.2 + 1.25 * 2.3) * 1e6, `${JSON.stringify(input)}: ${need}`);
    assert.ok(saveNeed({ name: 'x.json', bytes: 1e6, input }) >= saveNeed({ name: 'x.json', bytes: 1e6 }) + 1.25 * 2.3 * 1e6, JSON.stringify(input));
  }
  assert.equal(plain, loadNeed({ name: 'x.json', bytes: 1e6 }), 'the control: place-centric JSON has none');
  // TEI, and a CSV or GeoJSON whose column matching finds the places' web addresses, are read by
  // address through the store too; a CSV or GeoJSON not yet matched is taken as one that may be.
  for (const input of [{ format: 'tei' }, { format: 'csv' }, { format: 'geojson' }, { format: 'csv', profile: 'attestation-centric' }]) {
    assert.ok(loadNeed({ name: 'x', bytes: 1e6, input }) >= (1.2 + 1.25 * 2.3) * 1e6, JSON.stringify(input));
    assert.ok(saveNeed({ name: 'x', bytes: 1e6, input }) >= saveNeed({ name: 'x.json', bytes: 1e6 }) + 1.25 * 2.3 * 1e6, JSON.stringify(input));
  }
  // The control: one matched as place-centric has no store.
  for (const format of ['csv', 'geojson']) assert.equal(loadNeed({ name: 'x', bytes: 1e6, input: { format, profile: 'place-centric' } }), plain, format);
  // RDF known by its format, whatever its name.
  assert.equal(loadNeed({ name: 'export.txt', bytes: 1e6, input: { format: 'ntriples' } }), loadNeed({ name: 'x.nt', bytes: 1e6 }));
});

test('the dataset opened says how a CSV was read (by address or not), so that a save counts a store only where there is one', async () => {
  const csv = (text, name) => textFile(text, name);
  const cases = [
    ['by address', csv('place_uri,name,latitude,longitude\nhttps://example.org/p/a,Alpha,51.38,-2.36\nhttps://example.org/p/b,Beta,53.96,-1.08\n', 'by-address.csv'), 'attestation-centric'],
    ['places', textFile(readFileSync('test/fixtures/generic/with-ids.csv', 'utf8'), 'with-ids.csv'), 'place-centric'],
  ];
  const needs = [];
  for (const [how, file, profile] of cases) {
    const e = env();
    const store = await load(await detect([file]), e, await e.openDb());
    assert.ok(store.loaded.places > 0, `${how}: opened`);
    assert.equal(store.loaded.input.profile, profile, how);
    needs.push(saveNeed({ name: file.name, bytes: 1e6, input: store.loaded.input }));
    store.close();
  }
  assert.ok(needs[0] >= needs[1] + 1.25 * 2.3 * 1e6, `${needs}`);
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
});

test('the storage warnings say what is needed, what is left, and what to do', () => {
  const short = storageShort(saveNeed({ name: 'deep-plato.jsonl.gz', bytes: 1184971984 }), { quota: 3 * GB, usage: 1.5 * GB });
  assert.ok(short, 'DEEP cannot be saved in 1.5 GB');
  assert.equal(choraStorageWarning('save', short), "Saving needs about 2.76 GB of the browser's storage, for the file and the version check's working copy, and this browser has only 1.50 GB left for this site (of the 3.00 GB it allows). The save may stop part-way. Free some disk space, then save.");
  assert.match(choraStorageWarning('load', { need: 1.5e9, free: 2e8, quota: 1e9 }), /^Opening this dataset needs about 1.50 GB .* only 200.0 MB left .* private one/);
  // The refusal says why after a colon, and the page adds none of its own.
  assert.ok(CHORA_TEXT['chora-not-kept'].endsWith('Why:'), CHORA_TEXT['chora-not-kept']);
  const why = choraProblemText({ kind: 'chora-not-kept', message: CHORA_TEXT['chora-not-kept'], examples: ['A line is not valid JSON: line 3: x'] });
  assert.ok(why.endsWith('nothing was saved. Why: A line is not valid JSON: line 3: x'), why);
  assert.doesNotMatch(why, /::/);
  // The control: a text without its own colon is given one.
  assert.equal(choraProblemText({ kind: 'chora-no-such-place', message: 'x', examples: ['https://example.org/p/a'] }), `${CHORA_TEXT['chora-no-such-place']}: https://example.org/p/a`);
});

// navigator.storage.persist() makes Firefox show a permission prompt, and the tools are to ask for no
// permission of their own (persistent storage is to be offered in the toolbox's Permissions window):
// nothing the page runs calls it, or persisted(). The control: the same scan of the same files finds
// the storage estimate Chora does ask for, and the pattern finds a call written as it was.
test('no page asks the browser to keep its storage (persist() is never called); the estimate still is', () => {
  const files = [];
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = `${dir}/${e.name}`; if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(new URL('../src', import.meta.url).pathname);
  const CALL = /\.persist(ed)?\s*\(/;
  assert.match('try { kept = (await navigator.storage.persisted()) || (await navigator.storage.persist()); }', CALL, 'the pattern finds a call');
  const chora = files.find((f) => f.endsWith('/src/chora/app.js'));
  assert.ok(chora && files.length > 50, `${files.length} files, Chora's page among them`);
  assert.match(readFileSync(chora, 'utf8'), /navigator\.storage\.estimate\(\)/, 'the same scan sees the estimate');
  const calls = files.filter((f) => CALL.test(readFileSync(f, 'utf8')));
  assert.deepEqual(calls, []);
});
