// PLATO's shared `uri` definition has format "iri" since cf87b78. ajv-formats does not know "iri",
// and ajv with strict: false ignores a format it does not know, so without src/lib/formats.js any
// string at all would pass where PLATO requires a web address. Both halves are tested: IRIs,
// non-ASCII ones included, are accepted, and what is not an absolute IRI is still rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { addPlatoFormats, strictFormatLogger, iriToUri } from '../src/lib/formats.js';
import { loadResources } from '../src/engine/resources.js';
import { prepare } from '../src/engine/pipeline.js';
import { res, textFile, go } from './engine.js';

const GOOD = ['https://whgazetteer.org/example/bibliography#André-1980', 'https://ja.wikipedia.org/wiki/東京', 'https://example.org/Σπάρτη?q=Λακωνία',
  'https://例え.jp/', 'https://example.org/😀', 'http://www.geonames.org/2654675', 'urn:uuid:6e8bc430-9c3a-11d9-9669-0800200c9a66', 'mailto:someone@example.org',
  'https://example.org/a%20b'];
const BAD = ['bibliography#André-1980', 'André-1980', '/places/1', '//example.org/x', 'not a web address', 'https://exa mple.org/', 'https://example.org/a<b>',
  '', 'https://example.org/%zz', 'https://example.org/\u{FFFE}', 'https://example.org/\u{E000}'];

const compile = (ajv) => ajv.compile({ type: 'string', format: 'iri' });
test('format "iri" accepts IRIs, non-ASCII ones included', () => {
  const v = compile(addPlatoFormats(new Ajv2020({ strict: false, logger: strictFormatLogger })));
  for (const s of GOOD) assert.ok(v(s), s);
});
test('format "iri" rejects what is not an absolute IRI', () => {
  const v = compile(addPlatoFormats(new Ajv2020({ strict: false, logger: strictFormatLogger })));
  for (const s of BAD) assert.equal(v(s), false, JSON.stringify(s));
});
test('a private-use character is allowed in a query only, as RFC 3987 says', () => {
  const v = compile(addPlatoFormats(new Ajv2020({ strict: false })));
  assert.ok(v('https://example.org/?q=\u{E000}'));
  assert.equal(v('https://example.org/\u{E000}'), false);
  assert.equal(v('https://example.org/#\u{E000}'), false);
});
test('format "iri-reference" accepts relative references and still rejects garbage', () => {
  const v = addPlatoFormats(new Ajv2020({ strict: false })).compile({ type: 'string', format: 'iri-reference' });
  for (const s of ['bibliography#André-1980', '/places/1', ...GOOD]) assert.ok(v(s), s);
  for (const s of ['not a reference', 'https://example.org/a<b>', 'https://example.org/%zz']) assert.equal(v(s), false, s);
});
test('the URI mapping percent-encodes non-ASCII characters as UTF-8, and nothing else', () => {
  assert.equal(iriToUri('https://whgazetteer.org/example/bibliography#André-1980'), 'https://whgazetteer.org/example/bibliography#Andr%C3%A9-1980');
  assert.equal(iriToUri('https://example.org/a%20b?x=1#f'), 'https://example.org/a%20b?x=1#f');
});

// What the finding was: ajv-formats alone ignores "iri", so every string passes.
test('finding: with ajv-formats alone, format "iri" is ignored and any string passes', () => {
  const warnings = [];
  const ajv = new Ajv2020({ strict: false, logger: { log() {}, warn: (m) => warnings.push(String(m)), error() {} } }); addFormats(ajv);
  const v = compile(ajv);
  assert.ok(warnings.some((w) => /unknown format "iri" ignored/.test(w)), JSON.stringify(warnings));
  for (const s of BAD) assert.ok(v(s), `ajv-formats alone would reject ${JSON.stringify(s)}`);
});
test('an unknown format stops the tools from starting, instead of checking nothing', async () => {
  const r = await loadResources(async (f) => readFileSync(`public/plato/${f}`, 'utf8'));
  r.core = structuredClone(r.core); r.core.$defs.uri.format = 'iri-2099';
  assert.throws(() => prepare(r), /format these tools do not know/);
});

// Through the engine, as the page and the command line check a document.
const withSource = (id) => JSON.stringify({ profile: 'place-centric', gazetteer: { title: 't' }, spatialEntities: [{ '@id': 'https://example.org/p', label: 'P',
  attestations: [{ names: [{ toponym: 'Fenl[and]' }], citations: [{ source: { '@id': id, title: 'André 1980' }, locator: 'p. 12' }] }] }] });
test('a check accepts a source whose address has an accented letter', async () => {
  const r = await go([textFile(withSource('https://whgazetteer.org/example/bibliography#André-1980'), 'ok.json')], 'check');
  assert.deepEqual(r.report.items.filter((i) => i.severity === 'error'), []);
});
for (const bad of ['bibliography#André-1980', 'not a web address']) {
  test(`a check rejects a source address that is not one: ${JSON.stringify(bad)}`, async () => {
    const r = await go([textFile(withSource(bad), 'bad.json')], 'check');
    const errs = r.report.items.filter((i) => i.severity === 'error');
    assert.ok(errs.some((e) => e.kind === 'schema' && /full web address/.test(e.message)), JSON.stringify(errs.map((e) => e.message)));
  });
}
test('every format the vendored schemas use is one these tools check', () => {
  const used = new Set();
  const walk = (o) => { if (o && typeof o === 'object') { if (typeof o.format === 'string' && !o.base) used.add(o.format); Object.values(o).forEach(walk); } };
  walk(res.core); Object.values(res.profiles).forEach(walk);
  const ajv = addPlatoFormats(new Ajv2020({ strict: false }));
  assert.ok(used.has('iri'), [...used].join(', '));
  for (const f of used) assert.ok(ajv.formats[f], `format "${f}" is not defined`);
});
