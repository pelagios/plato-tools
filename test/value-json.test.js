// A structured value (an object, its shape declared by valueType) goes to RDF as plato:value_json,
// JSON text, and comes back as the object it was. Before, it became an empty blank node on
// plato:value_literal and its keys were dropped, with the report reading clean (found on the
// markets corpus, whose market days and fair dates are all recurrence values).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textFile, go, outText } from './engine.js';

const VALUE = { frequency: 'annual', anchor: 'whitsun', duration_days: 3 };
const doc = { profile: 'place-centric', gazetteer: { title: 'probe' }, spatialEntities: [{ '@id': 'https://example.org/vj/place/1', label: 'Probe',
  attestations: [{ '@id': 'https://example.org/vj/att/1', sources: [{ title: 'Probe source' }], properties: [{ '@id': 'https://example.org/vj/pv/1',
    property: 'https://example.org/vj/prop/fair-date', valueType: 'https://example.org/vj/type/recurrence', value: VALUE, sourceLabel: 'Monday after Whitsun, 3 days' }] }] }] };

test('a structured value is written to plato:value_json as JSON text, and nothing is dropped', async () => {
  const r = await go([textFile(JSON.stringify(doc), 'vj.json')], 'convert', 'ntriples');
  const nt = outText(r.e, 'vj.nt');
  const line = nt.split('\n').find((l) => l.includes('#value_json>'));
  assert.ok(line, nt);
  assert.deepEqual(JSON.parse(JSON.parse(line.match(/> (".*")\s*\.$/)[1])), VALUE);
  assert.ok(!/#value_literal> _:/.test(nt), 'no blank node on value_literal');
  assert.deepEqual(r.report.items.filter((i) => i.kind === 'unmapped-key'), [], 'no key of the value is dropped');
});
test('and comes back from RDF as the same object, and a second pass is identical', async () => {
  const a = await go([textFile(JSON.stringify(doc), 'vj.json')], 'convert', 'ntriples');
  const nt1 = outText(a.e, 'vj.nt');
  const b = await go([textFile(nt1, 'vj.nt')], 'convert', 'plato-jsonl');
  const rec = outText(b.e, 'vj.jsonl').trim().split('\n').map((l) => JSON.parse(l)).find((l) => l['@id'] === 'https://example.org/vj/place/1');
  const pv = rec.attestations[0].properties[0];
  assert.deepEqual(pv.value, VALUE);
  assert.equal(pv.valueType, 'https://example.org/vj/type/recurrence');
  assert.deepEqual(b.report.items, [], JSON.stringify(b.report.items));
  const c = await go([textFile(outText(b.e, 'vj.jsonl'), 'vj2.jsonl')], 'convert', 'ntriples');
  const set = (t) => new Set(t.split('\n').filter(Boolean));
  assert.deepEqual([...set(outText(c.e, 'vj2.nt'))].filter((l) => !set(nt1).has(l)).filter((l) => !l.startsWith('_:')), []);
});
test('value_json that is not a JSON object is reported, not silently dropped', async () => {
  const nt = '<https://example.org/g> <https://w3id.org/plato#contains_entity> <https://example.org/p> .\n<https://example.org/p> <http://www.w3.org/2000/01/rdf-schema#label> "P" .\n<https://example.org/a> <https://w3id.org/plato#attests_about> <https://example.org/p> .\n<https://example.org/a> <https://w3id.org/plato#attests_property> <https://example.org/pv> .\n<https://example.org/pv> <https://w3id.org/plato#property_type> "https://example.org/prop"^^<http://www.w3.org/2001/XMLSchema#anyURI> .\n<https://example.org/pv> <https://w3id.org/plato#value_json> "not json" .\n';
  const r = await go([textFile(nt, 'bad.nt')], 'convert', 'plato-jsonl');
  assert.ok(r.report.items.some((i) => i.kind === 'value-json-invalid'), JSON.stringify(r.report.items));
});
test('a blank node where a value belongs is reported, and its label is never written as the value', async () => {
  const nt = '<https://example.org/g> <https://w3id.org/plato#contains_entity> <https://example.org/p> .\n<https://example.org/p> <http://www.w3.org/2000/01/rdf-schema#label> "P" .\n<https://example.org/a> <https://w3id.org/plato#attests_about> <https://example.org/p> .\n<https://example.org/a> <https://w3id.org/plato#attests_property> <https://example.org/pv> .\n<https://example.org/pv> <https://w3id.org/plato#property_type> "https://example.org/prop"^^<http://www.w3.org/2001/XMLSchema#anyURI> .\n<https://example.org/pv> <https://w3id.org/plato#value_literal> _:r2b6 .\n';
  const r = await go([textFile(nt, 'node.nt')], 'convert', 'plato-jsonl');
  const out = outText(r.e, 'node.jsonl');
  assert.ok(!out.includes('r2b6'), out);
  assert.ok(r.report.items.some((i) => i.kind === 'value-is-node' && i.severity === 'loss'), JSON.stringify(r.report.items));
});
