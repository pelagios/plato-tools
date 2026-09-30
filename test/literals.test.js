// RDF to PLATO JSON: a literal's language tag, or a datatype other than the one PLATO JSON writes
// for its key, has no place in the JSON. The value is kept and what is lost is said.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { go, textFile, outText } from './engine.js';

const P = 'https://w3id.org/plato#', XSD = 'http://www.w3.org/2001/XMLSchema#', RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const nt = (extra) => `<https://x.org/p> <${RDFS}label> "Place" .
<https://x.org/p> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${P}SpatialEntity> .
<https://x.org/a> <${P}attests_about> <https://x.org/p> .
<https://x.org/a> <${P}attests_name> _:n .
_:n <${P}toponym> "Place" .
<https://x.org/a> <${P}attests_timespan> _:t .
_:t <${P}start_earliest> "1086"^^<${XSD}gYear> .
<https://x.org/a> <${P}created> "2020-01-01T00:00:00Z"^^<${XSD}dateTime> .
${extra}`;
const losses = (r, kind) => r.report.items.filter((i) => i.severity === 'loss' && i.kind === kind);
const records = (r, name) => outText(r.e, name).trim().split('\n').slice(1).map((l) => JSON.parse(l));

test('a language tag on an ordinary key is reported lost, and the text kept', async () => {
  const r = await go([textFile(nt(`<https://x.org/a> <${P}notes> "une note"@fr .\n`), 'lang.nt')], 'convert', 'plato-jsonl');
  const l = losses(r, 'literal-language');
  assert.equal(l.length, 1, JSON.stringify(r.report.items));
  assert.match(l[0].message, /language tag/);
  assert.match(l[0].message, /kept/);
  assert.equal(l[0].examples[0], `https://x.org/a ${P}notes "une note"@fr`);
  assert.equal(records(r, 'lang.jsonl')[0].attestations[0].notes, 'une note');
});
test('a datatype other than the one PLATO JSON writes for the key is reported lost, and the value kept', async () => {
  const r = await go([textFile(nt(`<https://x.org/a> <${P}notes> "n"^^<${XSD}token> .\n<https://x.org/a> <${P}modified> "2021"^^<${XSD}gYear> .\n`), 'dt.nt')], 'convert', 'plato-jsonl');
  const l = losses(r, 'literal-datatype');
  assert.equal(l.length, 1, JSON.stringify(r.report.items));
  assert.equal(l[0].count, 2);
  assert.deepEqual(l[0].examples.sort(), [`https://x.org/a ${P}modified "2021"^^<${XSD}gYear>`, `https://x.org/a ${P}notes "n"^^<${XSD}token>`]);
  const a = records(r, 'dt.jsonl')[0].attestations[0];
  assert.equal(a.notes, 'n');
  assert.equal(a.modified, '2021');
});
test('control: the datatypes PLATO JSON writes again, a typed export\'s bounds included, are no loss', async () => {
  // created is xsd:dateTime, as the context types it; a bound typed xsd:gYear is what --typing writes.
  const r = await go([textFile(nt(`<https://x.org/a> <${P}notes> "plain" .\n<https://x.org/a> <${P}negated> "false"^^<${XSD}boolean> .\n`), 'ok.nt')], 'convert', 'plato-jsonl');
  assert.deepEqual([...losses(r, 'literal-language'), ...losses(r, 'literal-datatype')], []);
  const a = records(r, 'ok.jsonl')[0].attestations[0];
  assert.equal(a.timespans[0].startEarliest, '1086');
  assert.equal(a.notes, 'plain');
  // And the tools' own typed export of PLATO JSON reads back with neither loss.
  const doc = { profile: 'place-centric', gazetteer: { '@id': 'https://x.org/g', title: 't' }, spatialEntities: [{ '@id': 'https://x.org/p', label: 'P',
    attestations: [{ names: [{ toponym: 'P' }], timespans: [{ startEarliest: '1086', endLatest: '1086-12-25' }], created: '2020-01-01T00:00:00Z', properties: [{ property: 'https://x.org/n', value: 2.5 }, { property: 'https://x.org/m', value: 3 }] }] }] };
  const typed = await go([textFile(JSON.stringify(doc), 'typed.json')], 'convert', 'ntriples', { typing: true });
  const back = await go([textFile(outText(typed.e, 'typed.nt'), 'typed.nt')], 'convert', 'plato-jsonl');
  assert.deepEqual([...losses(back, 'literal-language'), ...losses(back, 'literal-datatype')], []);
});
