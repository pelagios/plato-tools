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
import { placeKey, load } from '../src/engine/chora/store.js';
import { newGeometryAttestation } from '../src/engine/chora/draw.js';
import { choraDrawingNote, choraSaveText } from '../src/engine/words.js';
import { PLATO_REPO } from './paths.js';

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

// The key a drawing is saved under is the one Chora's store gave the place when the dataset was
// opened (load() in store.js): the save reads the dataset again and must find each place by the same
// key. A place without an @id goes by its position ('#n'), and a place of the tables by its address,
// made from its place_id with the characters an address cannot hold encoded (RFC 3986).
async function storeKeys(files) {
  const e = env();
  const store = await load(await detect([].concat(files)), e, await e.openDb());
  return { store, ids: store.search('', 0, 1000).items.map((i) => i.id) };
}
test("the keys Chora's store gives places are the keys a save finds them by: places without @id, and tables' encoded addresses", async () => {
  const doc = JSON.parse(await file(JUDGEMENTS).text());
  const { '@id': _, ...nameless } = doc.spatialEntities[2];
  doc.spatialEntities.splice(1, 0, { ...nameless, label: 'Nowhere in particular' });
  doc.spatialEntities.push({ label: 'Also unnamed', attestations: [] });
  const json = () => textFile(JSON.stringify(doc), 'nameless.json');
  const places = (await file(TABLES[1]).text()).trimEnd() + '\nSt Ives (Hunts),Saint Ives,GB\nÆbbe’s tūn,Ebbe’s farm,GB\n';
  const tables = () => TABLES.map((p, i) => (i === 1 ? textFile(places, 'places.csv') : file(p)));
  for (const [what, files, want] of [['PLATO JSON', json, ['#2', '#8']], ['tables', tables, [/place\/St%20Ives%20%28Hunts%29$/, /place\/%C3%86bbe%E2%80%99s%20t%C5%ABn$/]]]) {
    const { store, ids } = await storeKeys(files());
    const keys = want.map((w) => ids.find((id) => (typeof w === 'string' ? id === w : w.test(id))));
    assert.ok(keys.every(Boolean), `${what}: the store has ${want.join(', ')} among ${ids.join(', ')}`);
    const additions = keys.map((k, i) => ({ placeId: k, attestation: drawing(i, i) }));
    for (const options of [{ name: what }, { name: what, hasPlace: (k) => store.has(k) }]) {
      const r = await saved(files(), additions, options);
      assert.equal(r.report.errors, 0, `${what}: ${JSON.stringify(r.report.items)}`);
      await assertAppendedOnly(r.input, r.text, additions);
      assert.equal(r.mneme.passed, true, `${what}: ${r.mneme.reasons.join('; ')}`);
      assert.equal(r.mneme.report.counts.added, 2);
    }
    store.close();
  }
});

// ---- The review of 30 September 2026: each test below failed before its fix. ----------------------
const X = 'https://example.org/';
const doc = (places, g = {}) => JSON.stringify({ profile: 'place-centric', gazetteer: { '@id': X + 'g', title: 'Test', ...g }, spatialEntities: places });
const named = (label, extra = {}) => ({ ...extra, label, attestations: [{ names: [{ toponym: label }], sources: [{ title: 's' }] }] });

test('a record that is not a place is counted by the one rule everywhere: a drawing reaches its own place, and none is made', async () => {
  const files = () => textFile(doc([named('First'), null, named('Third')]), 'nulls.json');
  const { store } = await storeKeys(files());
  const third = store.search('third').items[0]?.id;
  assert.ok(third, 'the store has Third');
  for (const options of [{}, { hasPlace: (k) => store.has(k) }]) {
    const r = await saved(files(), [{ placeId: third, attestation: drawing(1, 1) }], options);
    const out = JSON.parse(r.text).spatialEntities;
    assert.equal(out.find((p) => p && p.label === 'Third')?.attestations.length, 2, 'the drawing is on Third');
    assert.ok(out.every((p) => p === null || typeof p.label === 'string'), `no place without a label was made: ${JSON.stringify(out)}`);
    assert.equal(r.mneme.passed, true, r.mneme.reasons.join('; '));
  }
  // The record that is not a place has a position, and no key: a drawing on it is refused, not made a place.
  for (const options of [{}, { hasPlace: (k) => store.has(k) }]) {
    const r = await saved(files(), [{ placeId: '#2', attestation: drawing(1, 1) }], options);
    assert.deepEqual(r.report.items.map((i) => i.kind), ['chora-no-such-place']);
    assert.equal(r.mneme, null);
  }
  store.close();
});

test('a place whose @id the dataset gives twice gets its drawing once, on the first, and Mneme passes', async () => {
  const twin = X + 'p/twin';
  const r = await saved(textFile(doc([named('Twin', { '@id': twin }), named('Other', { '@id': X + 'p/other' }), named('Twin again', { '@id': twin })]), 'twins.json'),
    [{ placeId: twin, attestation: drawing(2, 2) }]);
  const out = JSON.parse(r.text).spatialEntities;
  assert.deepEqual(out.map((p) => p.attestations.length), [2, 1, 1]);
  assert.equal(r.mneme.passed, true, r.mneme.reasons.join('; '));
  assert.equal(r.mneme.report.counts.added, 1);
});

test('a dataset with no attestations yet, a list of places to locate: the first drawings are saved, and Mneme passes', async () => {
  const places = [{ '@id': X + 'p/a', label: 'Alpha' }, { '@id': X + 'p/b', label: 'Beta' }, { label: 'Gamma' }];
  const json = () => textFile(doc(places), 'to-locate.json');
  const additions = [{ placeId: X + 'p/b', attestation: drawing(1, 1) }, { placeId: '#3', attestation: area() }];
  const r = await saved(json(), additions);
  await assertAppendedOnly(r.input, r.text, additions);
  assert.deepEqual(r.mneme.reasons, []);
  assert.equal(r.mneme.passed, true);
  assert.deepEqual([r.mneme.report.counts.earlier, r.mneme.report.counts.added], [0, 2]);
  // The controls: the list itself, where two were expected, fails; so does a file that adds a third.
  const none = await verify(r.input, json(), 2, env());
  assert.equal(none.passed, false);
  assert.match(none.reasons.join(), /0 added where 2 were expected/);
  const more = JSON.parse(r.text); more.spatialEntities[0].attestations = [drawing(5, 5)];
  const m = await verify(r.input, textFile(JSON.stringify(more), 'more.json'), 2, env());
  assert.equal(m.passed, false);
  assert.match(m.reasons.join(), /3 added where 2 were expected/);
  // A dataset with no attestations and another problem still fails for it: the one allowance is not a blanket one.
  const cut = await verify(r.input, textFile(r.text.slice(0, 200), 'cut.json'), 2, env());
  assert.equal(cut.passed, false);

  // The same, as spreadsheet tables: only the places, with their labels.
  const tables = () => [file(TABLES[0]), textFile('place_id,label\nalpha,Alpha\nbeta,Beta\n', 'places.csv')];
  const { store, ids } = await storeKeys(tables());
  assert.equal(ids.length, 2);
  const t = await saved(tables(), [{ placeId: ids[1], attestation: drawing(3, 3) }], { name: 'to-locate', hasPlace: (k) => store.has(k) });
  assert.equal(t.mneme.passed, true, t.mneme.reasons.join('; '));
  assert.deepEqual([t.mneme.report.counts.earlier, t.mneme.report.counts.added], [0, 1]);
  store.close();
});

test('Mneme fails a save that changes or drops what identifies or describes a place, which Chora must never do', async () => {
  const ANT = `${PLATO_REPO}/schemas/examples/place-centric-antonine.json`;
  const input = await detect([file(ANT)]);
  const first = [...(await attestationsOf(input)).keys()][0];
  const r = await saved(file(ANT), [{ placeId: first, attestation: drawing(0, 51) }]);
  assert.equal(r.mneme.passed, true, r.mneme.reasons.join('; '));
  const d = JSON.parse(r.text);
  const withIds = d.spatialEntities.filter((p) => p.identityRelations?.length);
  assert.ok(withIds.length, 'the example has identity relations to lose');
  const noIds = JSON.parse(r.text); for (const p of noIds.spatialEntities) delete p.identityRelations;
  const i = await verify(r.input, textFile(JSON.stringify(noIds), 'no-ids.json'), 1, env());
  assert.equal(i.passed, false);
  assert.match(i.reasons.join(), /identity-(removed|gone)/);
  const relabelled = JSON.parse(r.text); relabelled.spatialEntities[0].label += ' (relabelled)';
  const l = await verify(r.input, textFile(JSON.stringify(relabelled), 'relabelled.json'), 1, env());
  assert.equal(l.passed, false, JSON.stringify(l.report.items.map((x) => x.kind)));
  assert.match(l.reasons.join(), /description-changed/);
});
