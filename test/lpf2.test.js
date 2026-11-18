// Linked Places Format v2, as the World Historical Gazetteer reads it (convert --to lpf2, check --whg).
//
// WHG holds an upload to its own JSON Schema, copied to src/vendor/whg-lpf_v2.0.json. These tests hold the
// writer to that schema with a validator of their own, compiled here from the copy (not the one the tools
// use, src/formats/whg-lpf-check.js, which is tested against it): a place with a kind, a date and a name
// passes; one without is written as it is, with nothing made up, and the report says WHG would refuse it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import { file, textFile, outText, go } from './engine.js';
import { nameAndLanguage, featureToV2, recordToFeature, GN_CLASS, LPF2_CONTEXT } from '../src/formats/lpf.js';
import { validateForWhg, checkFeatureForWhg, whgChecker, WHG_PROBLEMS } from '../src/formats/whg-lpf-check.js';
import { LOSS_TEXT } from '../src/engine/report.js';
import { TARGETS } from '../src/engine/pipeline.js';

const SCHEMA_PATH = 'src/vendor/whg-lpf_v2.0.json';
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, unicodeRegExp: false });
ajv.addSchema({ $id: 'https://whgazetteer.org/schema/csl-citation.json' });
const schemaAccepts = ajv.compile(SCHEMA);
/** As WHG validates: each feature alone in a FeatureCollection. The @ids of those the schema refuses. */
const refusedBySchema = (features) => features.filter((f) => !schemaAccepts({ type: 'FeatureCollection', features: [f] })).map((f) => f['@id']);

const CLI = 'bin/plato-tools.mjs';
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const item = (r, kind) => r.report.items.find((i) => i.kind === kind);
const errors = (r) => r.report.items.filter((i) => i.severity === 'error');

const B = 'https://example.org/gaz/';
const S = [{ '@id': `${B}source/s`, title: 'The Survey', timespan: { startEarliest: '1300', endLatest: '1300' } }];
const AAT = 'http://vocab.getty.edu/aat/300008347';
const named = (toponym, language) => ({ names: [language === undefined ? { toponym } : { toponym, language }], sources: S });
const kind = { types: [{ identifier: AAT, label: 'inhabited place' }], sources: S };
const fclass = { types: [{ identifier: `${GN_CLASS}P`, label: 'Populated places' }], sources: S };
const dated = { timespans: [{ startEarliest: '1200', endLatest: '1300' }], sources: S };
const located = { geometries: [{ geojson: { type: 'Point', coordinates: [36.72, 34.73] } }], sources: S };
const place = (id, label, ...attestations) => ({ '@id': `${B}place/${id}`, label, attestations });
const doc = (...spatialEntities) => ({ profile: 'place-centric', gazetteer: { '@id': B, title: 'Test gazetteer' }, spatialEntities });
const WHOLE = () => place('whole', 'Emesa', named('Emesa'), kind, fclass, dated, located);
async function convert(d, target = 'lpf2', options = {}) {
  const r = await go([textFile(JSON.stringify(d), 'd.json')], 'convert', target, options);
  const text = outText(r.e, `d${TARGETS[target].ext}`);
  const fc = target.endsWith('-seq') ? { head: JSON.parse(text.split('\n')[0]), features: text.trim().split('\n').slice(1).map((l) => JSON.parse(l)) } : JSON.parse(text);
  return { ...r, fc, text, byId: (id) => fc.features.find((f) => f['@id'] === `${B}place/${id}`) };
}

test("the copy of WHG's schema is the file its NOTICE names, byte for byte, and is draft-07", () => {
  const notice = readFileSync('src/vendor/whg-lpf_v2.0.NOTICE', 'utf8');
  const sha = /sha256\s+([0-9a-f]{64})/.exec(notice)?.[1];
  assert.ok(sha, 'the NOTICE gives a sha256');
  assert.equal(createHash('sha256').update(readFileSync(SCHEMA_PATH)).digest('hex'), sha);
  assert.match(notice, /validation\/static\/lpf_v2\.0\.jsonld/);
  assert.match(notice, /copied\s+2026-11-18/);
  assert.equal(SCHEMA.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.equal(SCHEMA.$id, 'https://whgazetteer.org/schema/lpf_v2.0.jsonld');
});

for (const target of ['lpf2', 'lpf2-seq']) {
  test(`a place with a name, a kind, a date and a location is written as LPF v2 that WHG's schema accepts (${target})`, async () => {
    const r = await convert(doc(WHOLE()), target);
    assert.deepEqual(errors(r), []);
    assert.equal(r.fc.features.length, 1);
    assert.deepEqual(refusedBySchema(r.fc.features), [], JSON.stringify(schemaAccepts.errors));
    const f = r.byId('whole');
    assert.equal((target === 'lpf2' ? r.fc : r.fc.head)['@context'], LPF2_CONTEXT);
    assert.equal(LPF2_CONTEXT, SCHEMA['@context'], "the context is the one WHG's schema names");
    assert.deepEqual(f.properties, { title: 'Emesa', fclasses: ['P'] });
    assert.deepEqual(f.types.map((t) => t.identifier), [AAT]);
    assert.deepEqual(f.when, { timespans: [{ start: { in: '1200' }, end: { in: '1300' } }] });
    assert.deepEqual(f.geometry.coordinates, [36.72, 34.73]);
    // The report says so: a note, and no warning of anything WHG would refuse.
    const verdict = item(r, 'whg-verdict');
    assert.equal(verdict.severity, 'note');
    assert.match(verdict.message, /^The one place would be accepted by WHG\./);
    assert.deepEqual(r.report.items.filter((i) => /^whg-/.test(i.kind)).map((i) => i.kind), ['whg-verdict']);
  });
}

test("a citation's year is a string in v2, as WHG's schema asks, and a number in v1 as before", async () => {
  const v1 = await convert(doc(WHOLE()), 'lpf'), v2 = await convert(doc(WHOLE()));
  assert.strictEqual(v1.byId('whole').names[0].citations[0].year, 1300);
  assert.strictEqual(v2.byId('whole').names[0].citations[0].year, '1300');
  // WHG's schema refuses the number, so the v1 feature is not what to send it.
  assert.deepEqual(refusedBySchema(v1.fc.features), [`${B}place/whole`]);
  assert.deepEqual(refusedBySchema(v2.fc.features), []);
  assert.strictEqual(featureToV2({ names: [{ toponym: 'A', citations: [{ label: 'x', year: -50 }] }], geometry: { type: 'Point', coordinates: [1, 2], citations: [{ label: 'y', year: 7 }] } }).geometry.citations[0].year, '7');
});

test('a place with no kind of place, or no date, is written as the data has it, nothing made up, and the report names it', async () => {
  const d = doc(WHOLE(),
    place('nokind', 'Arados', named('Arados'), dated, located),
    place('nokind2', 'Byblos', named('Byblos'), dated),
    place('nodate', 'Qanawat', named('Qanawat'), kind, located),
    place('neither', 'Tarsus', named('Tarsus')));
  const r = await convert(d);
  assert.deepEqual(errors(r), []);
  assert.equal(r.fc.features.length, 5, 'every place is written, accepted by WHG or not');
  // Nothing is made up: no type, no feature class, no date. The whole place, in the same file, has each.
  for (const id of ['nokind', 'nokind2', 'neither']) { assert.equal(r.byId(id).types, undefined, id); assert.equal(r.byId(id).properties.fclasses, undefined, id); }
  for (const id of ['nodate', 'neither']) assert.ok(!JSON.stringify(r.byId(id)).includes('"when"'), id);
  assert.ok(r.byId('whole').types.length && r.byId('whole').properties.fclasses.length && r.byId('whole').when);
  assert.deepEqual(r.byId('nodate').types.map((t) => t.identifier), [AAT]);
  // WHG's schema, asked here, refuses exactly those four.
  assert.deepEqual(refusedBySchema(r.fc.features), ['nokind', 'nokind2', 'nodate', 'neither'].map((id) => `${B}place/${id}`));
  // And the report says so in plain words, counting the places and naming them by title and id.
  const noKind = item(r, 'whg-no-kind'), noDate = item(r, 'whg-no-date'), verdict = item(r, 'whg-verdict');
  assert.equal(noKind.severity, 'warning');
  assert.equal(noKind.count, 3);
  assert.deepEqual(noKind.examples, [`Arados (${B}place/nokind)`, `Byblos (${B}place/nokind2)`, `Tarsus (${B}place/neither)`]);
  assert.match(noKind.message, /has no kind of place; WHG needs one/);
  assert.match(noKind.message, /Nothing is made up/);
  assert.equal(noKind.message, LOSS_TEXT['whg-no-kind']);
  assert.equal(noDate.count, 2);
  assert.deepEqual(noDate.examples, [`Qanawat (${B}place/nodate)`, `Tarsus (${B}place/neither)`]);
  assert.match(noDate.message, /has no date; WHG needs one/);
  assert.equal(verdict.severity, 'warning');
  assert.match(verdict.message, /^1 of 5 places would be accepted by WHG; 4 would be refused/);
  // v1 asks for feature classes of every place and says so; v2 asks for a kind, and its verdict has said it.
  assert.equal(item(r, 'lpf-fclasses-missing'), undefined);
  const v1 = await convert(d, 'lpf');
  assert.equal(item(v1, 'lpf-fclasses-missing').count, 4);
  assert.equal(item(v1, 'whg-verdict'), undefined, 'v1 is not held to WHG\'s schema');
});

test('no more than five examples are named, and the count is of every place', async () => {
  const many = Array.from({ length: 12 }, (_, i) => place(`p${i}`, `Place ${i}`, named(`Place ${i}`), dated));
  const r = await convert(doc(WHOLE(), ...many));
  assert.equal(item(r, 'whg-no-kind').count, 12);
  assert.equal(item(r, 'whg-no-kind').examples.length, 5);
  assert.match(item(r, 'whg-verdict').message, /^1 of 13 places would be accepted by WHG; 12 would be refused/);
  // None accepted is said as that.
  const none = await convert(doc(...many));
  assert.match(item(none, 'whg-verdict').message, /^None of the 12 places would be accepted by WHG/);
});

test('a name ending "@" with no language is written without the "@", and name@language as the name and its language, in v1 and v2', async () => {
  const d = doc(place('q', 'Qanawat', named('Qanawat@'), named('قنوات@ar'), named('Qanawāt@ar-Latn'), named('Kanatha', ''), named('Canatha', 'la'), named('Canatha@la', 'la'), named('Q@Q street'), kind, dated));
  for (const target of ['lpf', 'lpf2']) {
    const r = await convert(d, target);
    const names = r.byId('q').names.map((n) => [n.toponym, n.lang]);
    assert.deepEqual(names, [['Qanawat', undefined], ['قنوات', 'ar'], ['Qanawāt', 'ar-Latn'], ['Kanatha', undefined], ['Canatha', 'la'], ['Canatha', 'la'], ['Q@Q street', undefined]], target);
    assert.ok(r.byId('q').names.every((n) => !('lang' in n) || n.lang), 'no empty language is written');
    assert.deepEqual([item(r, 'lpf-name-at-no-language').severity, item(r, 'lpf-name-at-no-language').count, item(r, 'lpf-name-at-no-language').examples], ['warning', 1, ['Qanawat@']], target);
    assert.deepEqual([item(r, 'lpf-name-at-language').count, item(r, 'lpf-name-at-language').examples], [3, ['قنوات@ar', 'Qanawāt@ar-Latn', 'Canatha@la']], target);
  }
  // The PLATO record is not changed: the names are as the data has them (the reader's to read, not the writer's).
  const plato = await go([textFile(JSON.stringify(d), 'd.json')], 'convert', 'plato-json');
  assert.ok(outText(plato.e, 'd.json').includes('"toponym":"Qanawat@"'));
  // With them written so, WHG's schema accepts the place; with the "@" left on, it would not.
  const v2 = await convert(doc(place('q', 'Qanawat', named('Qanawat@'), named('قنوات@ar'), kind, dated)));
  assert.deepEqual(refusedBySchema(v2.fc.features), []);
  const left = JSON.parse(JSON.stringify(v2.fc.features[0])); left.names[0].toponym = 'Qanawat@';
  assert.deepEqual(refusedBySchema([left]), [`${B}place/q`]);
  assert.deepEqual(checkFeatureForWhg(left).found, [{ code: 'name-at', detail: '"Qanawat@"' }]);
});

test('nameAndLanguage: what is and is not taken for a language', () => {
  const seen = [];
  const of = (toponym, language) => nameAndLanguage({ toponym, language }, (l) => seen.push(l.kind));
  assert.deepEqual(of('Livorno@it'), { toponym: 'Livorno', lang: 'it' });
  assert.deepEqual(of('Qanawat@'), { toponym: 'Qanawat', lang: undefined });
  assert.deepEqual(of('Qanawat @ '), { toponym: 'Qanawat', lang: undefined });
  assert.deepEqual(of('Karak@ar-Latn-x-ijmes'), { toponym: 'Karak', lang: 'ar-Latn-x-ijmes' });
  assert.deepEqual(seen, ['lpf-name-at-language', 'lpf-name-at-no-language', 'lpf-name-at-no-language', 'lpf-name-at-language']);
  // Left as they are: a language of its own that differs, a tail that is no language tag, an "@" alone, no "@".
  seen.length = 0;
  assert.deepEqual(of('Livorno@it', 'en'), { toponym: 'Livorno@it', lang: 'en' });
  assert.deepEqual(of('A@B C'), { toponym: 'A@B C', lang: undefined });
  assert.deepEqual(of('@'), { toponym: '@', lang: undefined });
  assert.deepEqual(of('Roma', ' '), { toponym: 'Roma', lang: undefined });
  assert.deepEqual(of('Roma', 'la'), { toponym: 'Roma', lang: 'la' });
  assert.deepEqual(seen, []);
});

test("temporary ids are said for WHG: its schema accepts them, and they would stay with the places", async () => {
  const csv = 'id,name,type,start\n1,Emesa,settlement,1200\n2,Arados,settlement,1250\n';
  const temporary = await go([textFile(csv, 'places.csv')], 'convert', 'lpf2');
  const fc = JSON.parse(outText(temporary.e, 'places.lpf2.geojson'));
  assert.deepEqual(fc.features.map((f) => f['@id']), ['https://temporary.invalid/my-dataset/place/1', 'https://temporary.invalid/my-dataset/place/2']);
  assert.deepEqual(refusedBySchema(fc.features), [], "WHG's schema accepts a temporary address as an @id");
  const w = item(temporary, 'whg-temporary-ids');
  assert.deepEqual([w.severity, w.count, w.examples], ['warning', 2, ['https://temporary.invalid/my-dataset/place/1']]);
  assert.match(w.message, /WHG's schema accepts them/);
  assert.match(w.message, /would stay with the place in WHG/);
  assert.match(item(temporary, 'whg-verdict').message, /^All 2 places would be accepted by WHG\./);
  // With an address of the maker's own, nothing temporary is written and nothing is said of it.
  const own = await go([textFile(csv, 'places.csv')], 'convert', 'lpf2', { base: B });
  assert.deepEqual(JSON.parse(outText(own.e, 'places.lpf2.geojson')).features.map((f) => f['@id']), [`${B}place/1`, `${B}place/2`]);
  assert.equal(item(own, 'whg-temporary-ids'), undefined);
  assert.match(item(own, 'whg-verdict').message, /^All 2 places would be accepted by WHG\./);
});

// ---- the validator, on features given to it ---------------------------------------------------------
const when = { timespans: [{ start: { in: '1200' } }] };
const good = () => ({ '@id': 'https://example.org/p/1', type: 'Feature', properties: { title: 'Emesa', fclasses: ['P'] }, names: [{ toponym: 'Emesa' }], types: [{ identifier: 'aat:300008347', label: 'inhabited place' }], when, geometry: { type: 'Point', coordinates: [36.72, 34.73] } });
const without = (...keys) => { const f = good(); for (const k of keys) delete f[k]; return f; };
const CASES = [
  ['no-kind', { ...without('types'), properties: { title: 'Emesa' } }, /^has no kind of place; WHG needs one/],
  ['no-date', without('when'), /^has no date; WHG needs one/],
  ['no-names', without('names'), /^has no name/],
  ['no-names', { ...good(), names: [] }, /^has no name/],
  ['no-id', without('@id'), /^has no id/],
  ['bad-id', { ...good(), '@id': 'place one' }, /neither a web address nor a prefixed name.*: "place one"$/],
  ['no-title', { ...good(), properties: { fclasses: ['P'] } }, /^has no title/],
  ['geometry-missing', without('geometry'), /^has no geometry member/],
  ['geometry', { ...good(), geometry: { type: 'Point', coordinates: [36.72, 34.73, 500] } }, /location WHG cannot read: a position has more than a longitude and a latitude/],
  ['geometry', { ...good(), geometry: { type: 'Point', coordinates: [36.72, 134.73] } }, /a position is not on the earth \(36\.72, 134\.73\)/],
  ['geometry', { ...good(), geometry: { geowkt: 'POINT(36.72 34.73)' } }, /it has no type/],
  ['when-no-years', { ...good(), when: { periods: [{ name: 'Ayyubid', uri: 'http://n2t.net/ark:/99152/p0x' }] } }, /date with no years in it/],
  ['when-no-years', { ...good(), geometry: { type: 'Point', coordinates: [1, 2], when: { label: 'medieval' } } }, /date with no years in it/],
  ['date', { ...good(), when: { timespans: [{ start: { in: '12000' } }] } }, /a date WHG cannot read.*: "12000"$/],
  ['name-at', { ...good(), names: [{ toponym: 'Qanawat@' }] }, /ends with "@" and no language: "Qanawat@"$/],
  ['name-language', { ...good(), names: [{ toponym: 'Karak@ar_Latn' }] }, /whose language WHG does not read as one: "Karak@ar_Latn"$/],
  ['language', { ...good(), names: [{ toponym: 'Karak', lang: '' }] }, /a language WHG does not read as one.*: ""$/],
  ['link', { ...good(), links: [{ type: 'closeMatch', identifier: 'Q84' }] }, /has a link WHG cannot read.*: "Q84"$/],
  ['link', { ...good(), links: [{ type: 'sameAs', identifier: 'wd:Q84' }] }, /has a link WHG cannot read.*: "sameAs"$/],
  ['citation', { ...good(), names: [{ toponym: 'Emesa', citations: [{ label: 'x', year: 1300 }] }] }, /has a citation WHG cannot read.*: 1300$/],
  ['country', { ...good(), properties: { title: 'Emesa', fclasses: ['P'], ccodes: ['UK'] } }, /country code.*: "UK"$/],
  ['kind-code', { ...good(), properties: { title: 'Emesa', fclasses: ['Q'] } }, /feature class.*: "Q"$/],
  ['depiction', { ...good(), depictions: [{ '@id': 'https://example.org/a.jpg' }] }, /image with no @id, title or licence/],
  ['certainty', { ...good(), when: { ...when, certainty: 'probable' } }, /certainty.*: "probable"$/],
];
test('the feature that has everything is accepted, by the schema asked here and by the validator', () => {
  assert.ok(schemaAccepts({ type: 'FeatureCollection', features: [good()] }), JSON.stringify(schemaAccepts.errors));
  assert.deepEqual(checkFeatureForWhg(good()), { valid: true, problems: [], found: [] });
});
for (const [code, feature, words] of CASES) {
  test(`the validator says in plain words: ${code} (${words.source.slice(0, 40)})`, () => {
    assert.equal(schemaAccepts({ type: 'FeatureCollection', features: [feature] }), false, 'the schema, asked here, refuses the feature');
    const v = checkFeatureForWhg(feature);
    assert.equal(v.valid, false);
    assert.deepEqual(v.found.map((p) => p.code), [code], JSON.stringify(v.problems));
    assert.equal(v.problems.length, 1);
    assert.match(v.problems[0], words);
    assert.ok(v.problems[0].startsWith(WHG_PROBLEMS[code].each));
    assert.ok(typeof LOSS_TEXT[`whg-${code}`] === 'string' && LOSS_TEXT[`whg-${code}`].includes(WHG_PROBLEMS[code].each), 'the report has words for it');
  });
}
test("the validator's verdict is the schema's for every case, and a place with two faults has both said once", () => {
  const two = { ...without('types', 'when'), properties: { title: 'Emesa' }, names: [{ toponym: 'A@' }, { toponym: 'B@' }] };
  const v = checkFeatureForWhg(two);
  assert.deepEqual(v.found.map((p) => p.code), ['no-kind', 'no-date', 'name-at', 'name-at']);
  const all = [good(), two, ...CASES.map(([, f]) => f)].map((f, i) => ({ ...f, '@id': f['@id'] === 'https://example.org/p/1' ? `https://example.org/p/${i}` : f['@id'] }));
  const r = validateForWhg({ type: 'FeatureCollection', features: all });
  const refused = all.filter((f) => !schemaAccepts({ type: 'FeatureCollection', features: [f] }));
  assert.equal(r.total, all.length);
  assert.equal(r.valid, all.length - refused.length);
  assert.equal(r.valid, 1);
  assert.equal(r.invalid.length, refused.length);
  // A place counts once for a kind of problem, however many of its names have it.
  const mine = r.invalid.find((x) => x.id === 'https://example.org/p/1');
  assert.deepEqual([mine.label, mine.codes, mine.problems.length], ['Emesa', ['no-kind', 'no-date', 'name-at'], 4]);
  assert.equal(r.summary.find((g) => g.code === 'name-at').count, 2);
  assert.equal(r.summary.find((g) => g.code === 'no-kind').text, '2 places have no kind of place; WHG needs one');
  assert.equal(r.summary.find((g) => g.code === 'no-id').text, '1 place has no id');
  assert.deepEqual(r.summary.find((g) => g.code === 'no-id').examples, [{ id: `feature ${all.findIndex((f) => f['@id'] === undefined) + 1}`, label: 'Emesa' }]);
});
test('the validator takes a collection, a list of features, or a GeoJSON sequence as text', () => {
  const features = [good(), without('when')];
  const seq = [JSON.stringify({ type: 'FeatureCollection', '@context': LPF2_CONTEXT }), ...features.map((f) => JSON.stringify(f))].join('\n') + '\n';
  for (const input of [{ type: 'FeatureCollection', features }, features, seq]) {
    const r = validateForWhg(input);
    assert.deepEqual([r.total, r.valid, r.refused, r.invalid.map((x) => x.codes)], [2, 1, 1, [['no-date']]]);
  }
  const streamed = whgChecker({ examples: 1 });
  for (const f of [without('when'), without('when'), good()]) streamed.feature(f);
  const r = streamed.result();
  assert.deepEqual([r.total, r.valid, r.summary[0].count, r.summary[0].examples.length, r.invalid], [3, 1, 2, 1, []]);
});

// ---- WHG's own example table ------------------------------------------------------------------------
const LP7 = 'test/fixtures/generic/whg-lp7-12.tsv';
test("WHG's twelve example rows, converted to lpf2: all are accepted by its schema, the private-use language tag included", async () => {
  const r = await go([file(LP7)], 'convert', 'lpf2');
  assert.deepEqual(errors(r), []);
  const fc = JSON.parse(outText(r.e, 'whg-lp7-12.lpf2.geojson'));
  assert.equal(fc.features.length, 12);
  // Every row has a type (an AAT identifier) and a date; none has a feature class, which v2 does not need beside a type.
  assert.ok(fc.features.every((f) => f.types?.length && f.types.every((t) => /^http:\/\/vocab\.getty\.edu\/aat\/\d+$/.test(t.identifier))));
  assert.ok(fc.features.every((f) => f.names.some((n) => n.when?.timespans?.length)));
  assert.ok(fc.features.every((f) => f.properties.fclasses === undefined));
  assert.equal(item(r, 'whg-no-kind'), undefined);
  assert.equal(item(r, 'whg-no-date'), undefined);
  // No name is left ending "@" (seven were), and the names with a language have it apart (thirty-three):
  // the table's reader now reads both (hermes/columns.js), saying the seven, so the writer finds none to mend.
  const toponyms = fc.features.flatMap((f) => f.names.map((n) => n.toponym));
  assert.ok(toponyms.includes('Qalʿat al-Mafraq') && !toponyms.some((t) => t.includes('@')));
  assert.equal(item(r, 'lpf-name-at-no-language').count, 7);
  assert.equal(item(r, 'lpf-name-at-language'), undefined);
  assert.equal(fc.features.flatMap((f) => f.names).filter((n) => n.lang).length, 33);
  // The schema, asked here: all twelve accepted. A language tag with a private part (ar-Latn-x-ijmes), which is
  // well-formed BCP 47, was refused by WHG's pattern until its fix (WorldHistoricalGazetteer/place#351); the
  // vendored schema has the fix. The tag is not altered.
  const AL_MAFRAQ = 'https://temporary.invalid/my-dataset/place/oape_201';
  assert.deepEqual(refusedBySchema(fc.features), []);
  assert.ok(fc.features.find((f) => f['@id'] === AL_MAFRAQ).names.some((n) => n.lang === 'ar-Latn-x-ijmes'));
  assert.equal(item(r, 'whg-language'), undefined);
  assert.match(item(r, 'whg-verdict').message, /^All 12 places would be accepted by WHG/);
  assert.equal(item(r, 'whg-temporary-ids').count, 12);
  const v = validateForWhg(fc);
  assert.deepEqual([v.total, v.valid, v.invalid.map((x) => x.id)], [12, 12, []]);
});

// ---- check --whg --------------------------------------------------------------------------------------
test("check says what WHG would accept only when asked (options.whg), and is otherwise as it was", async () => {
  const d = doc(WHOLE(), place('nokind', 'Arados', named('Arados'), dated, located));
  const files = () => [textFile(JSON.stringify(d), 'd.json')];
  const plain = await go(files(), 'check');
  const asked = await go(files(), 'check', undefined, { whg: true });
  assert.deepEqual(asked.report.items.filter((i) => /^whg-/.test(i.kind)).map((i) => [i.kind, i.count]), [['whg-no-kind', 1], ['whg-verdict', 1]]);
  assert.deepEqual(item(asked, 'whg-no-kind').examples, [`Arados (${B}place/nokind)`]);
  assert.match(item(asked, 'whg-verdict').message, /^1 of 2 places would be accepted by WHG; 1 would be refused/);
  assert.deepEqual(asked.outputs, []);
  assert.deepEqual(asked.report.items.filter((i) => !/^whg-/.test(i.kind)), plain.report.items);
  assert.deepEqual(asked.report.counts, plain.report.counts);
  assert.equal(asked.report.errors, plain.report.errors);
  // An attestation-centric table (read through the store) reaches it as places too.
  const table = await go([textFile('uri,name,type,start\nhttps://example.org/gaz/place/x,Emesa,settlement,1200\nhttps://example.org/gaz/place/y,Arados,,\n', 'places.csv')], 'check', undefined, { whg: true });
  assert.match(item(table, 'whg-verdict').message, /^1 of 2 places would be accepted by WHG/);
  assert.deepEqual(item(table, 'whg-no-kind').examples, ['Arados (https://example.org/gaz/place/y)']);
});

test('a Linked Places Format v2 file is held to WHG\'s schema as it stands by check with whg, and is not read otherwise', async () => {
  const made = await convert(doc(WHOLE(), place('nodate', 'Qanawat', named('Qanawat'), kind, located)));
  for (const [name, text] of [['d.lpf2.geojson', made.text], ['d.lpf2.geojsonl', (await convert(doc(WHOLE(), place('nodate', 'Qanawat', named('Qanawat'), kind, located)), 'lpf2-seq')).text]]) {
    const asked = await go([textFile(text, name)], 'check', undefined, { whg: true });
    assert.equal(asked.input.lpfVersion, 2, name);
    assert.deepEqual(errors(asked), [], name);
    assert.deepEqual(item(asked, 'whg-no-date').examples, [`Qanawat (${B}place/nodate)`], name);
    assert.match(item(asked, 'whg-verdict').message, /^1 of 2 places would be accepted by WHG/, name);
    assert.equal(item(asked, 'lpf-v2-whg-only').severity, 'note', name);
    assert.equal(asked.report.counts.places, 2, name);
    const plain = await go([textFile(text, name)], 'check');
    assert.deepEqual(errors(plain).map((i) => i.kind), ['lpf-v2'], name);
    assert.match(errors(plain)[0].message, /convert --to lpf2.*check --whg/, name);
    assert.equal(item(plain, 'whg-verdict'), undefined, name);
  }
});

test('the command line: check says it applies PLATO\'s rules only, --whg adds WHG\'s verdict (in brief too), and --whg is for check', () => {
  const plain = cli('check', '--brief', LP7);
  assert.equal(plain.code, 0);
  assert.match(plain.out, /\nThis checks PLATO's rules only\. To see also what the World Historical Gazetteer would accept, add --whg\.\nChecked 1 input: 1 without problems, 0 with problems\.\n$/);
  assert.ok(!/would be accepted by WHG/.test(plain.out));
  const asked = cli('check', '--whg', '--brief', LP7);
  assert.equal(asked.code, 0);
  assert.match(asked.out, /\n {2}All 12 places would be accepted by WHG/);
  assert.match(asked.out, /\nChecked by PLATO's rules, and against the World Historical Gazetteer's schema for Linked Places Format v2 \(--whg\)\.\nChecked 1 input: 1 without problems, 0 with problems\.\n$/);
  const full = cli('check', '--whg', LP7);
  assert.ok(!/language WHG does not read/.test(full.out));
  // A conversion says nothing of rules, and --whg is not one of its options: lpf2 is the target that reports it.
  const dir = mkdtempSync(join(tmpdir(), 'lpf2-'));
  const refused = cli('convert', '--to', 'lpf', '--whg', '--out', dir, LP7);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /--whg is for check; convert --to lpf2 says the same of the file it writes\./);
  const converted = cli('convert', '--to', 'lpf2', '--brief', '--out', dir, LP7);
  assert.equal(converted.code, 0);
  assert.match(converted.out, /\n {2}All 12 places would be accepted by WHG/);
  assert.ok(!/PLATO's rules/.test(converted.out));
  const written = JSON.parse(readFileSync(join(dir, 'whg-lp7-12.lpf2.geojson'), 'utf8'));
  assert.equal(written['@context'], LPF2_CONTEXT);
  assert.equal(refusedBySchema(written.features).length, 0);
  // The file it wrote, given back with --whg, has the same verdict.
  const again = cli('check', '--whg', '--brief', join(dir, 'whg-lp7-12.lpf2.geojson'));
  assert.match(again.out, /\n {2}All 12 places would be accepted by WHG/);
  writeFileSync(join(dir, 'x.json'), JSON.stringify(doc(WHOLE())));
  assert.match(cli('check', '--whg', '--brief', join(dir, 'x.json')).out, /\n {2}The one place would be accepted by WHG\./);
});

test('the targets are listed, and a candidate set cannot be written as lpf2 any more than as lpf', async () => {
  assert.deepEqual(Object.keys(TARGETS).filter((t) => t.startsWith('lpf')), ['lpf-seq', 'lpf', 'lpf2-seq', 'lpf2']);
  assert.match(TARGETS.lpf2.label, /Linked Places Format v2, as the World Historical Gazetteer reads it/);
  assert.match(TARGETS.lpf.label, /Linked Places Format v1/);
  // recordToFeature is v1's, and unchanged by v2 being there: the year is a number until featureToV2.
  const f = recordToFeature(WHOLE());
  assert.strictEqual(f.names[0].citations[0].year, 1300);
});
