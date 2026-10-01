// RDF to PLATO JSON: a literal's language tag, or a datatype other than the one PLATO JSON writes
// for its key, has no place in the JSON. The value is kept and what is lost is said, except where
// nothing is: a name's tag its language key holds, a number written back exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { go, textFile, outText, file, res } from './engine.js';
import { readdirSync } from 'node:fs';
import { PLATO_REPO } from './paths.js';

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
test("a language tag on a name that differs from its language key is lost, and the report says when it is not", async () => {
  const r = await go([textFile(nt(`<https://x.org/a> <${P}attests_name> _:m .\n_:m <${P}toponym> "Londres"@fr .\n_:m <${P}language> "en" .\n`), 'name.nt')], 'convert', 'plato-jsonl');
  const l = losses(r, 'literal-language');
  assert.equal(l.length, 1, JSON.stringify(r.report.items));
  assert.match(l[0].message, /the tag is lost/);
  assert.match(l[0].message, /name's "language" key/);
  assert.match(l[0].message, /no loss/);
  const names = records(r, 'name.jsonl')[0].attestations[0].names;
  assert.deepEqual(names.find((n) => n.toponym === 'Londres'), { toponym: 'Londres', language: 'en' });
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

// The maintainer's decision of 2026-10-01: a name's language tag goes into its `language` key
// when the key is empty and can hold it, and is no loss when the key already says the same; a
// number is no loss when the round trip gives exactly the same number in another datatype.
const nameNt = (name, extra = '') => nt(`<https://x.org/a> <${P}attests_name> _:m .\n${name}${extra}`);
const nameOf = (r, file, toponym) => records(r, file)[0].attestations[0].names.find((n) => n.toponym === toponym);

test("a name's tag goes into its empty language key, and is not reported", async () => {
  const r = await go([textFile(nameNt(`_:m <${P}toponym> "Londres"@fr .\n`), 'fill.nt')], 'convert', 'plato-jsonl');
  assert.deepEqual(losses(r, 'literal-language'), []);
  assert.deepEqual(nameOf(r, 'fill.jsonl', 'Londres'), { toponym: 'Londres', language: 'fr' });
});
test("a name's tag equal to its language key, in any case, is not reported", async () => {
  const r = await go([textFile(nameNt(`_:m <${P}toponym> "Londres"@fr .\n_:m <${P}language> "FR" .\n`), 'same.nt')], 'convert', 'plato-jsonl');
  assert.deepEqual(losses(r, 'literal-language'), []);
  assert.deepEqual(nameOf(r, 'same.jsonl', 'Londres'), { toponym: 'Londres', language: 'FR' });
});
test("control: a name's tag that differs from its language key is still reported, and the key kept", async () => {
  const r = await go([textFile(nameNt(`_:m <${P}toponym> "Londres"@fr .\n_:m <${P}language> "en" .\n`), 'diff.nt')], 'convert', 'plato-jsonl');
  const l = losses(r, 'literal-language');
  assert.equal(l.length, 1, JSON.stringify(r.report.items));
  assert.ok(l[0].examples[0].endsWith(` ${P}toponym "Londres"@fr`), l[0].examples[0]);
  assert.equal(nameOf(r, 'diff.jsonl', 'Londres').language, 'en');
});
test('control: a tag on a note, or on a label, is still reported with no language key to take it', async () => {
  const r = await go([textFile(nt(`<https://x.org/a> <${P}notes> "une note"@fr .\n<https://x.org/q> <http://www.w3.org/2000/01/rdf-schema#label> "Lieu"@fr .\n<https://x.org/q> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${P}SpatialEntity> .\n`), 'note.nt')], 'convert', 'plato-jsonl');
  const l = losses(r, 'literal-language');
  assert.equal(l.length, 1, JSON.stringify(r.report.items));
  assert.deepEqual(l[0].examples.sort(), [`https://x.org/a ${P}notes "une note"@fr`, `https://x.org/q http://www.w3.org/2000/01/rdf-schema#label "Lieu"@fr`]);
});
test("a tag with a script subtag fits PLATO's languageTag pattern and fills the key; one that does not fit is reported", async () => {
  const pattern = new RegExp(res.core.$defs.languageTag.pattern);
  assert.ok(pattern.test('grc-Latn') && !pattern.test('x-klingon'), 'the schema decides; the cases below assume this pattern');
  const r = await go([textFile(nameNt(`_:m <${P}toponym> "Byzantion"@grc-Latn .\n<https://x.org/a> <${P}attests_name> _:k .\n_:k <${P}toponym> "Qo'noS"@x-klingon .\n`), 'script.nt')], 'convert', 'plato-jsonl');
  assert.equal(nameOf(r, 'script.jsonl', 'Byzantion').language.toLowerCase(), 'grc-latn');
  assert.equal(nameOf(r, 'script.jsonl', "Qo'noS").language, undefined);
  const l = losses(r, 'literal-language');
  assert.equal(l.length, 1, JSON.stringify(r.report.items));
  assert.equal(l[0].examples.length, 1);
  assert.ok(l[0].examples[0].endsWith(` ${P}toponym "Qo'noS"@x-klingon`), l[0].examples[0]);
});
test('round trip: the language taken from a tag survives JSON -> RDF -> JSON', async () => {
  const first = await go([textFile(nameNt(`_:m <${P}toponym> "Londres"@fr .\n`), 'rt.nt')], 'convert', 'plato-jsonl');
  const rdf = await go([textFile(outText(first.e, 'rt.jsonl'), 'rt.jsonl')], 'convert', 'ntriples');
  assert.match(outText(rdf.e, 'rt.nt'), new RegExp(`<${P}language> "fr"`));
  const back = await go([textFile(outText(rdf.e, 'rt.nt'), 'rt2.nt')], 'convert', 'plato-jsonl');
  assert.deepEqual(nameOf(back, 'rt2.jsonl', 'Londres'), { toponym: 'Londres', language: 'fr' });
  assert.deepEqual([...losses(back, 'literal-language'), ...losses(back, 'literal-datatype')], []);
});
test('a number the round trip gives back exactly is no loss; one it could change is', async () => {
  const ps = (v, n) => `<https://x.org/a> <${P}attests_property> _:v${n} .\n_:v${n} <${P}property_type> "https://x.org/m${n}"^^<${XSD}anyURI> .\n_:v${n} <${P}value_literal> ${v} .\n`;
  const exact = ['"1.0"^^<' + XSD + 'decimal>', '"0.5"^^<' + XSD + 'decimal>', '"0.5"^^<' + XSD + 'float>', '"-12.250"^^<' + XSD + 'decimal>', '"7"^^<' + XSD + 'int>', '"0.1"^^<' + XSD + 'double>'];
  const inexact = ['"0.1"^^<' + XSD + 'decimal>', '"3.14159265358979323846264338327950288"^^<' + XSD + 'decimal>', '"0.93"^^<' + XSD + 'float>'];
  const r = await go([textFile(nt([...exact, ...inexact].map(ps).join('')), 'num.nt')], 'convert', 'plato-jsonl');
  const l = losses(r, 'literal-datatype');
  assert.equal(l.length, 1, JSON.stringify(r.report.items));
  assert.equal(l[0].count, inexact.length, JSON.stringify(l[0]));
  for (const v of inexact) assert.ok(l[0].examples.some((x) => x.endsWith(' ' + v)), v);
  const vals = records(r, 'num.jsonl')[0].attestations[0].properties.map((x) => x.value);
  assert.deepEqual(vals.slice(0, exact.length), [1, 0.5, 0.5, -12.25, 7, 0.1]);
});
test("PLATO's Turtle examples: a name's tag that its language key matches, and a certainty of 1.0, are no loss", async () => {
  const dir = `${PLATO_REPO}/examples`;
  const ttl = readdirSync(dir).filter((f) => f.endsWith('.ttl'));
  assert.ok(ttl.includes('simple-attestation.ttl') && ttl.includes('constantinople.ttl'), `examples not found in ${dir}`);
  const all = { lang: [], dt: [] };
  for (const f of ttl) {
    const r = await go([file(`${dir}/${f}`)], 'convert', 'plato-jsonl');
    for (const l of losses(r, 'literal-language')) all.lang.push(...l.examples);
    for (const l of losses(r, 'literal-datatype')) all.dt.push(...l.examples);
  }
  // Presence: the converter still reads these examples' tags and datatypes, and still reports
  // what it cannot keep (labels in English, a decimal precision of 0.01). The float control is the
  // synthetic test above: the examples' one float (a similarity score) is a candidate's, in a candidate
  // set, which converting the example's dataset reports as not written.
  assert.ok(all.lang.some((x) => x.includes('#label "')), all.lang.join('\n'));
  assert.ok(all.dt.some((x) => /"0\.0?[1-9]+"\^\^<http:\/\/www.w3.org\/2001\/XMLSchema#decimal>$/.test(x)), all.dt.join('\n'));
  // Absence: Bristowe@enm with language "enm", Grantanbrycg@ang, Athlone@en; certainty 1.0.
  assert.deepEqual(all.lang.filter((x) => /#toponym "/.test(x)), []);
  assert.deepEqual(all.dt.filter((x) => /"1\.0"\^\^/.test(x)), []);
});
test('exactValue gives every digit of a number, as written or as the double or single it reads as', async () => {
  const { exactValue } = await import('../src/formats/rdf2json.js');
  assert.equal(exactValue('1.0', XSD + 'decimal'), '1');
  assert.equal(exactValue('-012.2500', XSD + 'decimal'), '-12.25');
  assert.equal(exactValue('.5', XSD + 'decimal'), '0.5');
  assert.equal(exactValue('0.000123', XSD + 'decimal'), '0.000123');
  assert.equal(exactValue('0.1', XSD + 'double'), '0.1000000000000000055511151231257827021181583404541015625');
  assert.equal(exactValue('0.93', XSD + 'float'), '0.930000007152557373046875');
  // Values smaller than their own digit count (a subnormal) keep their leading zeros.
  assert.equal(exactValue('0.001', XSD + 'double').slice(0, 21), '0.0010000000000000000');
  assert.match(exactValue('5E-324', XSD + 'double'), /^0\.0{323}49406564584124654/);
  assert.equal(exactValue('1e400', XSD + 'double'), null);
  assert.equal(exactValue('abc', XSD + 'decimal'), null);
});
