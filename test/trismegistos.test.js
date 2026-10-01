import { PLATO_REPO } from './paths.js';
// What PLATO 7720890 (testing against Trismegistos, #18 to #22) asks of the writers and the checks,
// on PLATO's own example of it: a relation named by its label alone (#18), a relation to a unit
// minted as a place of the dataset, and relativeTo with one anchor or two (#19).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import Papa from 'papaparse';
import { file, textFile, outText, go } from './engine.js';

const EXAMPLE = `${PLATO_REPO}/schemas/examples/place-centric-trismegistos.json`;
const P = 'https://w3id.org/plato#';
const items = (r, sev) => r.report.items.filter((i) => i.severity === sev);
const kinds = (r, sev) => items(r, sev).map((i) => i.kind);
const rowsOf = (text) => Papa.parse(text, { header: true, skipEmptyLines: true }).data;

test('LPF: a relation named only by its label is left out whole, reported once, and the LPF reads back without error', async () => {
  const l = await go([file(EXAMPLE, 't.json')], 'convert', 'lpf');
  const fc = JSON.parse(outText(l.e, 't.geojson'));
  const rels = fc.features.flatMap((f) => f.relations || []);
  assert.ok(rels.length >= 2, 'a control: the relations with a target are written');
  assert.ok(rels.every((r) => typeof r.relationTo === 'string' && r.relationTo), JSON.stringify(rels));
  const lost = items(l, 'loss').find((i) => i.kind === 'relation-without-target');
  assert.equal(lost?.count, 1, JSON.stringify(kinds(l, 'loss')));
  assert.match(lost.message, /target address/);
  // The two relations with a target and a label lose their label; the one with only a label is not counted again.
  assert.equal(items(l, 'loss').find((i) => i.kind === 'dropped:relation.relatedLabel')?.count, 2);
  const back = await go([textFile(outText(l.e, 't.geojson'), 't.geojson')], 'convert', 'plato-json');
  assert.deepEqual(items(back, 'error').map((i) => i.message), []);
});

test('tables: a relation to a place of the dataset goes to related_place_id, its label beside it; one to an address outside goes to related_uri', async () => {
  const t = await go([file(EXAMPLE, 't.json')], 'convert', 'tables');
  const z = unzipSync(t.e.outs['t-tables.zip'][0]);
  const places = rowsOf(strFromU8(z['places.csv']));
  const aegyptus = places.find((p) => p.label === 'Aegyptus');
  assert.ok(aegyptus, 'Aegyptus is a place of the dataset');
  const rel = rowsOf(strFromU8(z['relations.csv'])).map((r) => [r.relation_type, r.related_place_id, r.related_uri, r.related_label]);
  assert.deepEqual(rel.find((r) => r[3] === 'Aegyptus'), ['ContainedIn', aegyptus.place_id, '', 'Aegyptus']);
  assert.deepEqual(rel.find((r) => r[3] === 'the Delta'), ['ContainedIn', '', '', 'the Delta']);
  // Read back, it joins: no error, and the relation points at Aegyptus's own address.
  const back = await go([new File([t.e.outs['t-tables.zip'][0]], 't.zip')], 'convert', 'plato-jsonl');
  assert.deepEqual(items(back, 'error').map((i) => i.message), []);
  // A control: a labelled target that is not a place of the dataset stays an outside address.
  const outside = 'http://www.wikidata.org/entity/Q5185';
  const doc = { profile: 'place-centric', gazetteer: { '@id': 'https://example.org/d/', title: 't' }, spatialEntities: [{ '@id': 'https://example.org/d/place/x', label: 'X', attestations: [
    { relations: [{ relatesTo: outside, relatedLabel: 'Lower Egypt', relationType: P + 'ContainedIn' }], citations: [{ source: 'https://example.org/d/source/s' }] }] }] };
  const o = await go([textFile(JSON.stringify(doc), 'o.json')], 'convert', 'tables');
  const oz = unzipSync(o.e.outs['o-tables.zip'][0]);
  assert.deepEqual(rowsOf(strFromU8(oz['relations.csv'])).map((r) => [r.related_place_id, r.related_uri, r.related_label]), [['', outside, 'Lower Egypt']]);
  assert.deepEqual(rowsOf(strFromU8(oz['places.csv'])).map((r) => r.label), ['X']);
});

// A check of one place with one attestation, giving the first error's words.
async function firstError(attestation) {
  const doc = { profile: 'place-centric', gazetteer: { '@id': 'https://example.org/d/', title: 't' },
    spatialEntities: [{ '@id': 'https://example.org/d/place/x', label: 'X', attestations: [{ ...attestation, citations: [{ source: 'https://example.org/d/source/s' }] }] }] };
  const r = await go([textFile(JSON.stringify(doc), 'e.json')], 'check');
  return items(r, 'error').map((i) => i.message);
}
const located = (qualification) => ({ geometries: [{ reprPoint: [32.9, 24.1], qualification }] });

test('the check words a relation with no target, and relativeTo with the wrong number of anchors', async () => {
  assert.deepEqual(await firstError({ relations: [{ relationType: P + 'ContainedIn', relatesTo: 'https://example.org/d/place/y' }] }), [], 'a control: a relation with a target');
  const none = await firstError({ relations: [{ relationType: P + 'ContainedIn' }] });
  assert.equal(none.length, 1, JSON.stringify(none));
  assert.match(none[0], /A relation names no target: give relatesTo, or relatedLabel alone where there is no address/);

  const two = ['https://example.org/d/place/a', 'https://example.org/d/place/b'];
  assert.deepEqual(await firstError(located({ relativeQualifier: P + 'BetweenXAndY', relativeTo: two })), [], 'a control: between two');
  assert.deepEqual(await firstError(located({ relativeQualifier: P + 'Near', relativeBearing: 90, relativeTo: two[0] })), [], 'a control: a bearing from one');
  const bearing = await firstError(located({ relativeQualifier: P + 'Near', relativeBearing: 90, relativeTo: two }));
  assert.match(bearing.join(' '), /A bearing or distance needs a single anchor/);
  for (const relativeTo of [two[0], [two[0]], [...two, 'https://example.org/d/place/c']]) {
    const between = await firstError(located({ relativeQualifier: P + 'BetweenXAndY', relativeTo }));
    assert.match(between.join(' '), /Between X and Y needs exactly two anchors/, JSON.stringify(relativeTo));
  }
});
