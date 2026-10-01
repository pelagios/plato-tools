// Rows of a table of places that share an id, read as evidence about one place (options.sameId,
// src/engine/hermes/generic.js): an attestation for each row about the address made from its id,
// and one new place for each id, regrouped with its attestations by the store. Without the option
// a repeated id is refused, and the refusal says how to ask for this. Every test that asserts an
// absence asserts, in the same test, a presence it could have missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { addPlatoFormats, strictFormatLogger } from '../src/lib/formats.js';
import { detect, DataError } from '../src/engine/input.js';
import { Report, LOSS_TEXT } from '../src/engine/report.js';
import { genericSource, genericProfile } from '../src/engine/hermes/generic.js';
import { GENERIC_KINDS } from '../src/engine/hermes/columns.js';
import { file, textFile, go, outText } from './engine.js';

const fx = (f) => file(`test/fixtures/generic/${f}`);
const PLACE = (id) => `https://example.org/my-dataset/place/${id}`;
const load = (f) => JSON.parse(readFileSync(`public/plato/${f}`, 'utf8'));
const ajv = addPlatoFormats(new Ajv2020({ strict: false, allErrors: true, logger: strictFormatLogger }));
ajv.addSchema(load('plato.schema.json'), 'https://w3id.org/plato/schemas/plato.schema.json');
const attestationCentric = ajv.compile(load('attestation-centric.schema.json'));

/** Read an input through the generic reader: { header, attestations, fresh, records, items, kinds, of(kind) }. */
async function readAll(files, options = {}) {
  const input = await detect([].concat(files));
  const rep = new Report();
  const events = [];
  for await (const ev of genericSource(input, rep, options)) events.push(ev);
  const { items } = rep.toJSON();
  return {
    header: events[0].value,
    attestations: events.filter((e) => e.type === 'attestation').map((e) => e.value),
    fresh: events.filter((e) => e.type === 'record' && e.newEntity).map((e) => e.value),
    records: events.filter((e) => e.type === 'record' && !e.newEntity).map((e) => e.value),
    items, kinds: new Set(items.map((i) => i.kind)), of: (k) => items.find((i) => i.kind === k),
  };
}

test('duplicate-ids.csv without --same-id: refused, and the refusal says how to read the rows as one place', async () => {
  await assert.rejects(readAll(fx('duplicate-ids.csv')), (e) => e instanceof DataError && /"a"/.test(e.message)
    && /or, if every row is evidence about the same place, read rows with the same id as one place \(Reading options, or --same-id\)\.$/.test(e.message));
});
test('duplicate-ids.csv with sameId: an attestation for each row about its id\'s place, and one new place for each id', async () => {
  const r = await readAll(fx('duplicate-ids.csv'), { sameId: true });
  assert.equal(r.header.profile, 'attestation-centric');
  assert.match(r.header.gazetteer.description, /about the place its id names, rows with the same id being one place/);
  assert.deepEqual(r.attestations.map((a) => [a.about, a.names[0].toponym, a.citations[0].locator]),
    [[PLACE('a'), 'Alpha', 'row 2'], [PLACE('b'), 'Beta', 'row 3'], [PLACE('a'), 'Alpha again', 'row 4']]);
  // The names differ, so neither is picked: the label is the id, and the names are reported.
  assert.deepEqual(r.fresh, [
    { '@id': PLACE('a'), label: 'a', entityIdentifier: 'a', attestations: [] },
    { '@id': PLACE('b'), label: 'Beta', entityIdentifier: 'b', attestations: [] },
  ]);
  assert.deepEqual(r.records, []);
  assert.deepEqual(r.of('generic-same-id-label').examples, ['"a": Alpha / Alpha again']);
  assert.equal(r.of('generic-same-id-label').severity, 'warning');
  const doc = { ...r.header, attestations: r.attestations, newSpatialEntities: r.fresh };
  assert.ok(attestationCentric(doc), JSON.stringify(attestationCentric.errors));
});
test('rows with one id whose names agree: that name is the label, with no warning', async () => {
  const r = await readAll(textFile('id,name,date\nx,Eboracum,71\nx,Eboracum,122\ny,Deva,\ny,Chester,\n', 'x.csv'), { sameId: true });
  assert.equal(r.attestations.filter((a) => a.about === PLACE('x')).length, 2, 'present: both rows are about x');
  assert.deepEqual(r.fresh.map((p) => [p.entityIdentifier, p.label]), [['x', 'Eboracum'], ['y', 'y']]);
  assert.deepEqual(r.of('generic-same-id-label').examples, ['"y": Deva / Chester'], 'reported for y only, not for x');
});
test('with sameId a row with no id is a loss, since an attestation needs a place to be about; without, a place with no address', async () => {
  const csv = 'id,name\na,Alpha\n,Nameless id\na,Alpha\n';
  const r = await readAll(textFile(csv, 'x.csv'), { sameId: true });
  assert.deepEqual(r.attestations.map((a) => a.about), [PLACE('a'), PLACE('a')], 'present: the rows with an id');
  assert.deepEqual(r.of('generic-same-id-empty').examples, ['row 3']);
  assert.equal(GENERIC_KINDS['generic-same-id-empty'], 'loss');
  assert.ok(!JSON.stringify(r.attestations).includes('Nameless id'));
  assert.ok(LOSS_TEXT['generic-same-id-empty'] && LOSS_TEXT['generic-same-id-label']);
  // Control: without sameId the same row is a place of its own with no address (and a's repetition is refused).
  const w = await readAll(textFile('id,name\na,Alpha\n,Nameless id\n', 'x.csv'));
  assert.deepEqual(w.records.map((p) => p.label), ['Alpha', 'Nameless id']);
  assert.ok(w.kinds.has('generic-id-empty') && !w.kinds.has('generic-same-id-empty'));
});
test('genericProfile: attestation-centric with sameId and an id column; place-centric without either', async () => {
  const input = await detect([fx('duplicate-ids.csv')]);
  assert.equal(await genericProfile(input, { sameId: true }), 'attestation-centric');
  assert.equal(await genericProfile(input, {}), 'place-centric');
  assert.equal(await genericProfile(input, { sameId: true, columns: { id: 'note', name: 'name', lat: 'latitude', lon: 'longitude' } }), 'place-centric', 'no id column: nothing to group');
  // A saved mapping alone (the form before the options were passed whole) with a column called sameId is still a mapping.
  const odd = await detect([textFile('id,name,sameId\na,A,x\n', 'x.csv')]);
  assert.equal(await genericProfile(odd, { id: 'id', name: 'name', sameId: 'note' }), 'place-centric');
  assert.equal(await genericProfile(odd, { sameId: true }), 'attestation-centric', 'control');
});
test('GeoJSON features sharing an id are one place too', async () => {
  const fc = { type: 'FeatureCollection', features: [
    { type: 'Feature', id: 'k', properties: { name: 'Kos' }, geometry: { type: 'Point', coordinates: [27.1, 36.9] } },
    { type: 'Feature', id: 'k', properties: { name: 'Kos' }, geometry: null }] };
  await assert.rejects(readAll(textFile(JSON.stringify(fc), 'x.geojson')), (e) => e instanceof DataError && /read features with the same id as one place/.test(e.message));
  const r = await readAll(textFile(JSON.stringify(fc), 'x.geojson'), { sameId: true });
  assert.deepEqual(r.attestations.map((a) => a.about), [PLACE('k'), PLACE('k')]);
  assert.deepEqual(r.fresh.map((p) => p.label), ['Kos']);
});

// ---- the store path, through run() --------------------------------------------------------------------
test('through the engine: rows sharing an id are regrouped as one place with all its attestations', async () => {
  const j = await go([fx('duplicate-ids.csv')], 'convert', 'plato-json', { sameId: true });
  assert.equal(j.report.errors, 0, JSON.stringify(j.report.items.filter((i) => i.severity === 'error')));
  assert.ok(!j.incomplete);
  assert.deepEqual([j.report.counts.places, j.report.counts.attestations], [2, 3]);
  const doc = JSON.parse(outText(j.e, 'duplicate-ids.json'));
  const byId = Object.fromEntries(doc.spatialEntities.map((p) => [p['@id'], p]));
  assert.deepEqual(Object.keys(byId).sort(), [PLACE('a'), PLACE('b')]);
  assert.equal(byId[PLACE('a')].label, 'a');
  assert.equal(byId[PLACE('a')].entityIdentifier, 'a');
  assert.deepEqual(byId[PLACE('a')].attestations.map((a) => a.names[0].toponym).sort(), ['Alpha', 'Alpha again']);
  assert.deepEqual(byId[PLACE('b')].attestations.map((a) => a.names[0].toponym), ['Beta']);
  assert.ok(j.report.items.some((i) => i.kind === 'generic-same-id-label'));
  // N-Triples too: each row's attestation is about the one place.
  const n = await go([fx('duplicate-ids.csv')], 'convert', 'ntriples', { sameId: true });
  assert.equal(n.report.errors, 0);
  const about = outText(n.e, 'duplicate-ids.nt').split('\n').filter((l) => l.includes('<https://w3id.org/plato#attests_about>') && l.includes(`<${PLACE('a')}>`));
  assert.equal(about.length, 2);
  // Control: without sameId, the same file stops the run.
  const off = await go([fx('duplicate-ids.csv')], 'convert', 'plato-json');
  assert.ok(off.incomplete);
});
