// Saving Chora's drawings (src/engine/chora/save.js): the whole dataset as PLATO JSON with each new
// attestation after its place's own, every existing attestation exactly as it was read, and the
// version check (Mneme) run on the result in the same save. Mneme passing is worth something only
// if it can fail, so a saved file is broken here one edit at a time and must fail each time; and
// each passing save also asserts how many attestations were compared and added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, file, textFile } from './engine.js';
import { detect } from '../src/engine/input.js';
import { run } from '../src/engine/pipeline.js';
import { save, verify, savedName } from '../src/engine/chora/save.js';
import { placeKey } from '../src/engine/chora/store.js';
import { newGeometryAttestation } from '../src/engine/chora/draw.js';
import { choraDrawingNote, choraSaveText } from '../src/engine/words.js';

const JUDGEMENTS = 'test/fixtures/chora/place-centric-judgements.json';
const SURVEY = 'test/fixtures/chora/attestation-centric-survey.json';
const TABLES = ['about', 'places', 'sources', 'names', 'locations', 'types', 'relations', 'connections', 'properties', 'identities'].map((n) => `test/fixtures/tables-routes/${n}.csv`);
const E = 'https://whgazetteer.org/example/entity/';
const who = { name: 'Ada Surveyor' };
const drawing = (x, y, when = '2026-09-30T10:00:00Z') => newGeometryAttestation({ geojson: { type: 'Point', coordinates: [x, y] }, role: 'RepresentativePoint', contributor: who, created: when, notes: choraDrawingNote({ zoom: 9 }) });
const area = () => newGeometryAttestation({ geojson: { type: 'Polygon', coordinates: [[[-1, 52], [0, 52], [0, 53], [-1, 53], [-1, 52]]] }, role: 'Extent', precision: 'approximate', contributor: who, created: '2026-09-30T10:05:00Z' });

/** Each place of an input as the engine reads it: key -> its attestations, each as JSON text. */
async function attestationsOf(input) {
  const out = new Map();
  let n = 0;
  await run({ input, action: 'check', options: { sink: { header() {}, event(ev) { if (ev.type === 'record') out.set(placeKey(ev.value, ++n), (ev.value.attestations || []).map((a) => JSON.stringify(a))); }, async close() {} } } }, env());
  return out;
}
async function saved(files, additions, options = {}) {
  const e = env();
  const input = await detect([].concat(files));
  const r = await save(input, additions, e, { reopen: (o) => new File(e.outs[o.name], o.name), ...options });
  const name = r.outputs[0]?.name;
  return { ...r, input, e, name, text: name ? e.outs[name].join('') : null };
}
/**
 * The saved document holds every place of the input, each with its attestations exactly as they were
 * read, in order, and after them the additions made to it, and nothing else.
 */
async function assertAppendedOnly(input, text, additions) {
  const before = await attestationsOf(input);
  const doc = JSON.parse(text);
  assert.equal(doc.spatialEntities.length, before.size, 'every place is there');
  let n = 0;
  for (const rec of doc.spatialEntities) {
    const key = placeKey(rec, ++n);
    const was = before.get(key), now = (rec.attestations || []).map((a) => JSON.stringify(a));
    assert.ok(was, `${key} is a place of the input`);
    assert.deepEqual(now.slice(0, was.length), was, `${key}: its own attestations, as they were`);
    assert.deepEqual(now.slice(was.length), additions.filter((a) => a.placeId === key).map((a) => JSON.stringify(a.attestation)), `${key}: then its additions, and nothing else`);
  }
}

test('a PLATO JSON dataset saved with drawings: every attestation as it was, the drawings after, and Mneme passes', async () => {
  const additions = [{ placeId: E + 'littleworth', attestation: drawing(-0.5, 52.1) }, { placeId: E + 'kingsbury', attestation: area() }, { placeId: E + 'littleworth', attestation: drawing(-0.6, 52.2, '2026-09-30T10:10:00Z') }];
  const r = await saved(file(JUDGEMENTS), additions);
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  assert.equal(r.name, 'place-centric-judgements.chora.json');
  await assertAppendedOnly(r.input, r.text, additions);
  const doc = JSON.parse(r.text), orig = JSON.parse(await file(JUDGEMENTS).text());
  assert.deepEqual(doc.gazetteer, orig.gazetteer, 'the header as it was');
  assert.equal(r.report.counts['attestations added'], 3);
  assert.deepEqual(r.mneme.reasons, []);
  assert.equal(r.mneme.passed, true);
  assert.deepEqual(r.mneme.report.counts, { earlier: 10, later: 13, unchanged: 10, changed: 0, lost: 0, added: 3, retracted: 0, superseded: 0 });
  assert.match(choraSaveText(r), /^Saved, with 3 new attestations;/);
});

test('spreadsheet tables saved with a drawing: the tables become PLATO JSON, every attestation as read, and Mneme passes', async () => {
  const input = await detect(TABLES.map((p) => file(p)));
  const first = [...(await attestationsOf(input)).keys()][0];
  const additions = [{ placeId: first, attestation: area() }];
  const r = await saved(TABLES.map((p) => file(p)), additions, { name: 'tables-routes' });
  assert.equal(r.name, 'tables-routes.chora.json');
  await assertAppendedOnly(r.input, r.text, additions);
  assert.equal(r.mneme.passed, true, r.mneme.reasons.join('; '));
  assert.ok(r.mneme.report.counts.earlier > 5, `${r.mneme.report.counts.earlier} attestations compared`);
  assert.equal(r.mneme.report.counts.added, 1);
});

test('an attestation-centric dataset is saved place-centric, and Mneme passes', async () => {
  const input = await detect([file(SURVEY)]);
  const place = [...(await attestationsOf(input)).keys()][0];
  const r = await saved(file(SURVEY), [{ placeId: place, attestation: drawing(1, 1) }]);
  assert.equal(JSON.parse(r.text).profile, 'place-centric');
  assert.equal(r.mneme.passed, true, r.mneme.reasons.join('; '));
  assert.equal(r.mneme.report.counts.added, 1);
  assert.ok(r.mneme.report.counts.earlier > 0);
});

test('Mneme can fail: a saved file with an attestation changed, or one lost, or no drawing added, fails', async () => {
  const additions = [{ placeId: E + 'littleworth', attestation: drawing(-0.5, 52.1) }];
  const r = await saved(file(JUDGEMENTS), additions);
  const ok = await verify(r.input, new File([r.text], 'ok.json'), 1, env());
  assert.equal(ok.passed, true, 'the saved file as written passes');
  // An existing attestation changed.
  const changed = JSON.parse(r.text);
  changed.spatialEntities[0].attestations[0].notes += ' (edited)';
  const c = await verify(r.input, new File([JSON.stringify(changed)], 'changed.json'), 1, env());
  assert.equal(c.passed, false);
  assert.equal(c.report.counts.changed, 1);
  assert.ok(c.report.items.some((i) => i.kind === 'attestation-changed'));
  // An existing attestation lost, with the drawing in its place: the counts still add up, and it fails.
  const lost = JSON.parse(r.text);
  lost.spatialEntities[1].attestations.splice(0, 1, drawing(3, 3));
  const l = await verify(r.input, new File([JSON.stringify(lost)], 'lost.json'), 2, env());
  assert.equal(l.passed, false);
  assert.equal(l.report.counts.lost, 1);
  // The input itself, where one drawing should have been added.
  const none = await verify(r.input, file(JUDGEMENTS), 1, env());
  assert.equal(none.passed, false);
  assert.match(none.reasons.join(), /0 added where 1 were expected/);
});

test('Mneme fails a changed save of an unpublished dataset too, where a breach is only a warning', async () => {
  const input = await detect(TABLES.map((p) => file(p)));
  const first = [...(await attestationsOf(input)).keys()][0];
  const r = await saved(TABLES.map((p) => file(p)), [{ placeId: first, attestation: area() }], { name: 'tables-routes' });
  assert.equal(r.mneme.passed, true);
  const doc = JSON.parse(r.text);
  const a = doc.spatialEntities.find((p) => p.attestations.length > 1).attestations[0];
  a.notes = 'changed after the fact';
  const v = await verify(r.input, new File([JSON.stringify(doc)], 'changed.json'), 1, env());
  assert.equal(v.report.errors, 0, 'draft: the check itself raises no error');
  assert.equal(v.passed, false);
  assert.match(v.reasons.join(), /attestation-gone/);
});

test('a drawing for a place the dataset does not have is an error, and nothing is written', async () => {
  const additions = [{ placeId: E + 'littleworth', attestation: drawing(0, 0) }, { placeId: E + 'atlantis', attestation: drawing(0, 0) }];
  for (const options of [{}, { hasPlace: (k) => k === E + 'littleworth' }]) {
    const r = await saved(file(JUDGEMENTS), additions, options);
    assert.deepEqual(r.report.items.map((i) => [i.kind, i.examples]), [['chora-no-such-place', [E + 'atlantis']]]);
    assert.deepEqual(r.outputs, []);
    assert.deepEqual(Object.keys(r.e.outs), []);
    assert.equal(r.mneme, null);
    assert.equal(choraSaveText(r), 'Nothing was saved.');
  }
});

test("the contributor is given to a drawing that does not name one, and a drawing's own is kept", async () => {
  const { contributor, ...anon } = drawing(0, 0);
  const own = drawing(1, 1);
  const r = await saved(file(JUDGEMENTS), [{ placeId: E + 'littleworth', attestation: anon }, { placeId: E + 'littleworth', attestation: own }], { contributor: { name: 'Saver' } });
  const lw = JSON.parse(r.text).spatialEntities.find((p) => p['@id'] === E + 'littleworth').attestations;
  assert.deepEqual(lw.slice(-2).map((a) => a.contributor), [{ name: 'Saver' }, who]);
  assert.equal(contributor.name, who.name);
  assert.equal(r.mneme.passed, true);
});

test('a dataset that stops part-way is not saved', async () => {
  const text = (await file(JUDGEMENTS).text()).slice(0, 4000);
  const r = await saved(textFile(text, 'cut.json'), [{ placeId: E + 'littleworth', attestation: drawing(0, 0) }]);
  assert.equal(r.incomplete, true);
  assert.deepEqual(r.outputs, []);
  assert.equal(r.mneme, null);
  assert.equal(savedName('deep.jsonl.gz'), 'deep.chora.json');
});
