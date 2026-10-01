// A column of a gazetteer's ids (pleiades_id: 579885) read as the place's web address through a
// pattern the user confirms (src/engine/hermes/columns.js, addresses.js addressFromPattern): the
// guess suggests the pattern but never uses it unasked, a confirmed pattern makes each row an
// attestation about the address it makes, an id of the wrong shape makes none, and the World
// Historical Gazetteer's addresses are never made from an id. Every test that asserts an absence
// asserts, in the same test, a presence it could have missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessColumns, resolveColumns, applyColumns, mappingToSave, GENERIC_KINDS } from '../src/engine/hermes/columns.js';
import { addressFromPattern, patternProblem, GAZETTEER_PATTERNS, PATTERN_SHAPE } from '../src/engine/hermes/addresses.js';
import { genericSource, genericProfile, mappingOf } from '../src/engine/hermes/generic.js';
import { detect } from '../src/engine/input.js';
import { Report, LOSS_TEXT } from '../src/engine/report.js';
import { file, textFile, go, outText } from './engine.js';

const PLEIADES = GAZETTEER_PATTERNS.pleiades.pattern;
const fx = (f) => file(`test/fixtures/generic/${f}`);
const CONFIRMED = { id: 'id', name: 'name', pleiades_id: { field: 'address', pattern: PLEIADES } };

/** Read an input through the generic reader: { profile, attestations, records, fresh, items, kinds, of(kind) }. */
async function readAll(files, options = {}) {
  const input = await detect([].concat(files));
  const rep = new Report();
  const events = [];
  for await (const ev of genericSource(input, rep, options)) events.push(ev);
  const { items } = rep.toJSON();
  return {
    profile: events[0].value.profile,
    attestations: events.filter((e) => e.type === 'attestation').map((e) => e.value),
    records: events.filter((e) => e.type === 'record').map((e) => e.value),
    items, kinds: new Set(items.map((i) => i.kind)), of: (k) => items.find((i) => i.kind === k),
  };
}

// ---- addresses.js -----------------------------------------------------------------------------------
test('addressFromPattern: an id of the gazetteer\'s shape is made into its address; one of another shape, and whg:<n>, into none', () => {
  assert.deepEqual(addressFromPattern('579885', PLEIADES), { iri: 'https://pleiades.stoa.org/places/579885' });
  assert.deepEqual(addressFromPattern(' 2988507 ', GAZETTEER_PATTERNS.geonames.pattern), { iri: 'https://sws.geonames.org/2988507/' });
  assert.deepEqual(addressFromPattern('Q90', GAZETTEER_PATTERNS.wikidata.pattern), { iri: 'http://www.wikidata.org/entity/Q90' });
  assert.deepEqual(addressFromPattern('90', GAZETTEER_PATTERNS.wikidata.pattern), { lost: 'shape', value: '90' });
  assert.deepEqual(addressFromPattern('Q90', PLEIADES), { lost: 'shape', value: 'Q90' });
  // A pattern of the user's own takes letters, digits and . _ ~ - only; whg:<n> never, whatever the shape.
  assert.deepEqual(addressFromPattern('ab-1.2', 'https://ex.org/p/{id}'), { iri: 'https://ex.org/p/ab-1.2' });
  assert.deepEqual(addressFromPattern('a b', 'https://ex.org/p/{id}'), { lost: 'shape', value: 'a b' });
  assert.deepEqual(addressFromPattern('whg:123', 'https://ex.org/p/{id}', { shape: /./ }), { lost: 'shape', value: 'whg:123' });
  assert.deepEqual(addressFromPattern('123', 'https://ex.org/p/{id}', { shape: /./ }), { iri: 'https://ex.org/p/123' }, 'control: the same shape takes a plain id');
  // The address made goes through placeAddress: another form of a gazetteer's address becomes its one form.
  assert.deepEqual(addressFromPattern('12', 'http://pleiades.stoa.org/places/{id}'), { iri: 'https://pleiades.stoa.org/places/12', from: 'http://pleiades.stoa.org/places/12', rules: ['pleiades-https'] });
  // TEI's placeholder is {key}: the same function takes it.
  assert.deepEqual(addressFromPattern('579885', 'https://pleiades.stoa.org/places/{key}'), { iri: 'https://pleiades.stoa.org/places/579885' });
  assert.ok(PATTERN_SHAPE.test('a_b~c'));
});
test('patternProblem: a pattern needs {id} once, must make a web address, and is never the World Historical Gazetteer\'s', () => {
  for (const p of Object.values(GAZETTEER_PATTERNS).map((g) => g.pattern).concat(['https://ex.org/p/{id}', 'https://w3id.org/whgx/{id}'])) assert.equal(patternProblem(p), null, p);
  assert.match(patternProblem('https://ex.org/p/'), /no \{id\}/);
  assert.match(patternProblem('https://ex.org/{id}/{id}'), /more than one/);
  assert.match(patternProblem('ex.org/{id}'), /does not make a web address/);
  assert.match(patternProblem(42), /not text/);
  for (const p of ['https://whgazetteer.org/places/{id}/portal', 'https://www.whgazetteer.org/entity/place:gn:{id}', 'https://dev.whgazetteer.org/{id}', 'https://w3id.org/whg/id/place:gn:{id}', 'http://w3id.org/whg/{id}'])
    assert.match(patternProblem(p), /World Historical Gazetteer/, p);
});

// ---- the guess --------------------------------------------------------------------------------------
test('the guess suggests a gazetteer\'s pattern for a column of its ids, but keeps the column a note', () => {
  const rows = [{ pleiades_id: '579885', geonames: '2988507', 'Wikidata ID': 'Q90', id: '579885' }, { pleiades_id: '423025', geonames: '3169070', 'Wikidata ID': 'Q220', id: '423025' }];
  const g = guessColumns(['pleiades_id', 'geonames', 'Wikidata ID', 'id'], rows);
  assert.deepEqual({ ...g.mapping }, { pleiades_id: 'note', geonames: 'note', 'Wikidata ID': 'note', id: 'id' });
  assert.deepEqual({ ...g.suggested.pleiades_id }, { field: 'address', pattern: PLEIADES, gazetteer: 'pleiades', fit: 2, sampled: 2 });
  assert.equal(g.suggested.geonames.pattern, 'https://sws.geonames.org/{id}/');
  assert.equal(g.suggested['Wikidata ID'].pattern, 'http://www.wikidata.org/entity/{id}');
  assert.match(g.reasons.pleiades_id, /kept in the notes; but all 2 of its sampled values have the form of Pleiades ids, so it can be read as the place's web address, made with the pattern https:\/\/pleiades\.stoa\.org\/places\/\{id\}, once you confirm that pattern/);
  // Absent for a column whose heading names no gazetteer, though its values are the same (id).
  assert.equal(g.suggested.id, undefined);
  assert.deepEqual({ ...g.patterns }, {}, 'a guess never makes an address from an id');
});
test('the guess suggests a pattern only when at least half the values fit, and no other column is the address', () => {
  const half = guessColumns(['pleiades'], [{ pleiades: '1' }, { pleiades: 'Athens' }]);
  assert.equal(half.suggested.pleiades?.fit, 1, 'control: one of two fits');
  const under = guessColumns(['pleiades'], [{ pleiades: '1' }, { pleiades: 'Athens' }, { pleiades: 'Rome' }]);
  assert.equal(under.suggested.pleiades, undefined);
  assert.equal(under.mapping.pleiades, 'note');
  // Wikidata ids are Q and digits: digits alone are not.
  assert.equal(guessColumns(['wikidata_id'], [{ wikidata_id: '90' }]).suggested.wikidata_id, undefined);
  assert.ok(guessColumns(['wikidata_id'], [{ wikidata_id: 'Q90' }]).suggested.wikidata_id, 'control: Q90 fits');
  // Another column is the address already.
  const other = guessColumns(['pleiades_id', 'uri'], [{ pleiades_id: '1', uri: 'https://ex.org/1' }]);
  assert.equal(other.mapping.uri, 'address');
  assert.equal(other.suggested.pleiades_id, undefined);
  assert.doesNotMatch(other.reasons.pleiades_id, /pattern/);
});
test('an address column holding some ids and some web addresses: the pattern is suggested, the web addresses read as they are', () => {
  const g = guessColumns(['pleiades'], [{ pleiades: 'https://pleiades.stoa.org/places/1' }, { pleiades: '2' }, { pleiades: '3' }]);
  assert.equal(g.mapping.pleiades, 'address');
  assert.equal(g.suggested.pleiades?.fit, 2);
  assert.match(g.reasons.pleiades, /made into web addresses with the pattern .* kept in the notes until then/);
});

// ---- a saved mapping --------------------------------------------------------------------------------
test('a saved mapping takes { field: "address", pattern }; plain strings still load', () => {
  const r = resolveColumns(['id', 'name', 'pleiades_id'], [], CONFIRMED);
  assert.deepEqual([{ ...r.mapping }, { ...r.patterns }, r.problems], [{ id: 'id', name: 'name', pleiades_id: 'address' }, { pleiades_id: PLEIADES }, []]);
  assert.match(r.reasons.pleiades_id, /through the pattern https:\/\/pleiades/);
  const old = resolveColumns(['id', 'name', 'pleiades_id'], [{ pleiades_id: '1' }], { id: 'id', name: 'name', pleiades_id: 'note' });
  assert.deepEqual([{ ...old.mapping }, { ...old.patterns }, old.problems], [{ id: 'id', name: 'name', pleiades_id: 'note' }, {}, []]);
  // The guess's suggestion is still given beside a saved mapping that keeps the column a note.
  assert.equal(old.suggested.pleiades_id?.pattern, PLEIADES);
  assert.equal(r.suggested.pleiades_id, undefined, 'control: not once the column is the address');
  // { field } with no pattern is the field.
  assert.equal(resolveColumns(['a'], [], { a: { field: 'name' } }).mapping.a, 'name');
});
test('a World Historical Gazetteer pattern, or one that cannot be used, is refused under generic-mapping and the column kept as a note', () => {
  const cases = { 'https://w3id.org/whg/id/place:gn:{id}': /World Historical Gazetteer/, 'https://whgazetteer.org/places/{id}/portal': /World Historical Gazetteer/, 'https://ex.org/p': /no \{id\}/ };
  for (const [pattern, why] of Object.entries(cases)) {
    const r = resolveColumns(['name', 'g'], [], { name: 'name', g: { field: 'address', pattern } });
    assert.equal(r.mapping.g, 'note', pattern);
    assert.deepEqual({ ...r.patterns }, {}, pattern);
    assert.equal(r.problems.length, 1, pattern);
    assert.equal(r.problems[0].kind, 'generic-mapping');
    assert.match(r.problems[0].example, why);
    assert.equal(r.mapping.name, 'name', 'control: the rest of the mapping is taken');
  }
  const control = resolveColumns(['name', 'g'], [], { name: 'name', g: { field: 'address', pattern: 'https://ex.org/p/{id}' } });
  assert.deepEqual([control.mapping.g, control.problems], ['address', []], 'control: a pattern of the user\'s own is taken');
  // A pattern goes with the address only.
  const wrong = resolveColumns(['name', 'g'], [], { name: 'name', g: { field: 'id', pattern: PLEIADES } });
  assert.equal(wrong.mapping.g, 'note');
  assert.match(wrong.problems[0].example, /goes with "address", not "id"/);
});
test('mappingToSave gives the one JSON object, which loads back as the same mapping and patterns', () => {
  const r = resolveColumns(['id', 'name', 'pleiades_id'], [], CONFIRMED);
  const saved = JSON.parse(JSON.stringify(mappingToSave(r.mapping, r.patterns)));
  assert.deepEqual(saved, { id: 'id', name: 'name', pleiades_id: { field: 'address', pattern: PLEIADES } });
  const back = resolveColumns(['id', 'name', 'pleiades_id'], [], saved);
  assert.deepEqual([{ ...back.mapping }, { ...back.patterns }], [{ ...r.mapping }, { ...r.patterns }]);
  assert.deepEqual(JSON.parse(JSON.stringify(mappingToSave({ a: 'name' }))), { a: 'name' });
});

// ---- one row ------------------------------------------------------------------------------------------
test('one row: an id becomes the address through the pattern, with a note; a web address in the column is read as one', () => {
  const reported = [];
  const read = (v) => applyColumns({ name: 'X', g: v }, { name: 'name', g: 'address' }, { where: 'row 2', report: (k, e) => reported.push([k, e]), patterns: { g: PLEIADES } });
  const a = read('579885');
  assert.equal(a.address, 'https://pleiades.stoa.org/places/579885');
  assert.match(a.attestation.notes, /^Place address made from the value 579885 in the column "g" with the pattern https:\/\/pleiades\.stoa\.org\/places\/\{id\}$/);
  const w = read('http://pleiades.stoa.org/places/579885/');
  assert.equal(w.address, 'https://pleiades.stoa.org/places/579885');
  assert.match(w.attestation.notes, /Place address given as http:\/\/pleiades\.stoa\.org\/places\/579885\/ \(rules pleiades-https and pleiades-slash/);
  assert.doesNotMatch(w.attestation.notes, /pattern/);
  assert.deepEqual(reported, [], 'neither is reported');
  const bad = read('57-9885');
  assert.deepEqual([bad.address, bad.addressLost], [undefined, true]);
  assert.deepEqual(reported, [['generic-id-shape', `row 2, g: 57-9885 (the pattern ${PLEIADES})`]]);
  assert.match(bad.attestation.notes, /^g: 57-9885$/, 'kept in the notes, should the row become a place of its own');
  assert.equal(GENERIC_KINDS['generic-id-shape'], 'loss');
  assert.ok(LOSS_TEXT['generic-id-shape']);
});

// ---- the file ---------------------------------------------------------------------------------------
test('gazetteer-ids.csv unconfirmed: no address is made from the ids, which are kept in the notes', async () => {
  const m = await mappingOf(await detect([fx('gazetteer-ids.csv')]));
  assert.equal(m.mapping.pleiades_id, 'note');
  assert.equal(m.suggested.pleiades_id.pattern, PLEIADES);
  const r = await readAll(fx('gazetteer-ids.csv'));
  assert.equal(r.profile, 'place-centric');
  assert.equal(await genericProfile(await detect([fx('gazetteer-ids.csv')]), {}), 'place-centric');
  assert.equal(r.records.length, 6);
  assert.ok(r.records.some((rec) => rec.attestations[0].notes === 'pleiades_id: 579885'), 'present: the id is a note');
  assert.ok(!JSON.stringify(r.records).includes('pleiades.stoa.org'), 'absent: no Pleiades address');
});
test('gazetteer-ids.csv confirmed: attestation-centric, each id made into its address; whg:<n> and a misfit are never expanded', async () => {
  const input = await detect([fx('gazetteer-ids.csv')]);
  assert.equal(await genericProfile(input, { columns: CONFIRMED }), 'attestation-centric');
  const r = await readAll(fx('gazetteer-ids.csv'), { columns: CONFIRMED });
  assert.equal(r.profile, 'attestation-centric');
  assert.deepEqual(r.attestations.map((a) => a.about), ['579885', '423025', '422995'].map((n) => `https://pleiades.stoa.org/places/${n}`));
  for (const a of r.attestations) assert.match(a.notes, /^Place address made from the value \d+ in the column "pleiades_id" with the pattern https:\/\/pleiades\.stoa\.org\/places\/\{id\}\nid: \d$/);
  assert.deepEqual(r.of('generic-id-shape').examples, [`row 5, pleiades_id: whg:12345 (the pattern ${PLEIADES})`, `row 6, pleiades_id: 57-9885 (the pattern ${PLEIADES})`]);
  // The rows whose id makes no address are places of their own, with the value in their notes.
  assert.deepEqual(r.records.map((x) => [x.entityIdentifier, x.attestations[0].notes]), [['4', 'pleiades_id: whg:12345'], ['5', 'pleiades_id: 57-9885'], ['6', undefined]]);
  assert.ok(!/whg\/id|whgazetteer|\/places\/12345/.test(JSON.stringify(r)), 'absent: whg:12345 made into no address');
});
test('through the engine: a confirmed pattern converts to valid PLATO JSON about the Pleiades places', async () => {
  const j = await go([fx('gazetteer-ids.csv')], 'convert', 'plato-json', { columns: CONFIRMED });
  assert.equal(j.report.errors, 0, JSON.stringify(j.report.items.filter((i) => i.severity === 'error')));
  const doc = JSON.parse(outText(j.e, 'gazetteer-ids.json'));
  const athens = doc.spatialEntities.find((p) => p['@id'] === 'https://pleiades.stoa.org/places/579885');
  assert.equal(athens.attestations[0].names[0].toponym, 'Athenae');
  assert.ok(doc.spatialEntities.some((p) => p.entityIdentifier === '4'), 'the whg: row is a place of its own');
  // Control: unconfirmed, the same file has no Pleiades place.
  const u = await go([fx('gazetteer-ids.csv')], 'convert', 'plato-json');
  assert.equal(u.report.errors, 0);
  assert.ok(!outText(u.e, 'gazetteer-ids.json').includes('pleiades.stoa.org/places/579885"'));
});
test('a column of ids with a pattern, a row with no name and no usable id: reported once, not carried', async () => {
  const r = await readAll(textFile('name,pleiades\nAthenae,579885\nNowhere,abc\n', 'x.csv'), { columns: { name: 'name', pleiades: { field: 'address', pattern: PLEIADES } } });
  assert.deepEqual(r.attestations.map((a) => a.about), ['https://pleiades.stoa.org/places/579885']);
  assert.deepEqual(r.of('generic-id-shape').examples, [`row 3, pleiades: abc (the pattern ${PLEIADES})`]);
  assert.ok(!r.kinds.has('generic-address-not-web'), 'not reported twice');
  assert.equal(r.records.length, 0);
});
