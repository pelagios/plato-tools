import { PLATO_REPO, DEEP_EXPORT } from './paths.js';
// LPF -> PLATO must produce valid PLATO JSON and lose only what is reported; LPF -> PLATO -> LPF
// must give back every LPF element the README example uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import Ajv2020 from 'ajv/dist/2020.js';
import { addPlatoFormats, strictFormatLogger } from '../src/lib/formats.js';
import { featureToRecord, recordToFeature, expandLpf } from '../src/formats/lpf.js';

const load = (f) => JSON.parse(readFileSync(`public/plato/${f}`, 'utf8'));
const CORE = load('plato.schema.json'), PC = load('place-centric.schema.json');
const ajv = addPlatoFormats(new Ajv2020({ strict: false, allErrors: true, logger: strictFormatLogger }));
ajv.addSchema(CORE, 'https://w3id.org/plato/schemas/plato.schema.json'); ajv.addSchema(PC);
const validDoc = (recs) => {
  const v = ajv.getSchema('https://w3id.org/plato/schemas/place-centric.schema.json');
  const ok = v({ profile: 'place-centric', gazetteer: { title: 'test' }, spatialEntities: recs });
  return ok ? null : v.errors.slice(0, 4);
};
const README = JSON.parse(readFileSync('test/fixtures/lpf-readme-example.json', 'utf8')).features[0];

test('LPF README example -> valid PLATO, with only the reported losses', () => {
  const losses = [];
  const rec = featureToRecord(README, (l) => losses.push(l.kind));
  assert.equal(validDoc([rec]), null);
  assert.deepEqual([...new Set(losses)].sort(), ['lpf-depiction-licence', 'lpf-description-language', 'lpf-duration'].sort());
  assert.equal(rec.identityRelations.length, 3);
  assert.deepEqual(rec.ccodes, README.properties.ccodes);
});

test('LPF README example -> PLATO -> LPF keeps every element', () => {
  const rec = featureToRecord(README);
  const back = recordToFeature(rec);
  const names = (f) => f.names.map((n) => n.toponym).sort();
  assert.deepEqual(names(back), names(README));
  assert.deepEqual(back.names.find((n) => n.toponym === 'Abingdon').citations.map((c) => [c.label, c.year, c['@id']]),
    README.names[0].citations.map((c) => [c.label, c.year, c['@id']]));
  const links = (f) => f.links.map((l) => l.type + ' ' + expandLpf(l.identifier)).sort();
  assert.deepEqual(links(back), links(README));
  const rels = (f) => f.relations.map((r) => [expandLpf(r.relationType), r.relationTo, r.label].join('|')).sort();
  assert.deepEqual(rels(back), rels(README));
  assert.deepEqual(back.types.map((t) => [t.identifier, t.label, t.sourceLabels[0].label]), README.types.map((t) => [expandLpf(t.identifier), t.label, t.sourceLabels[0].label]));
  const coords = (f) => (f.geometry.type === 'GeometryCollection' ? f.geometry.geometries : [f.geometry]).map((g) => JSON.stringify(g.coordinates ?? g.geowkt)).sort();
  assert.deepEqual(coords(back), coords(README));
  assert.equal(back.descriptions[0].value, README.descriptions[0].value);
  assert.deepEqual(back.properties.ccodes, README.properties.ccodes);
  assert.equal(back.depictions[0]['@id'], README.depictions[0]['@id']);
  assert.deepEqual(back.when.timespans, README.when.timespans);
  assert.deepEqual(back.when.periods.map((p) => p.uri), README.when.periods.map((p) => expandLpf(p['@id'])));
});

test('control: a dropped name is noticed', () => {
  const rec = featureToRecord(README); rec.attestations = rec.attestations.filter((a) => !a.names || a.names[0].toponym !== 'Abingdon');
  assert.notDeepEqual(recordToFeature(rec).names.map((n) => n.toponym).sort(), README.names.map((n) => n.toponym).sort());
});

const DEEP_LPF = `${DEEP_EXPORT}/deep-lpf.geojsonl.gz`;
test('DEEP LPF export (first 2,000 features) -> valid PLATO', async (t) => {
  if (!existsSync(DEEP_LPF)) { t.skip('DEEP LPF export not found'); return; }
  const rl = createInterface({ input: createReadStream(DEEP_LPF).pipe(createGunzip()), crlfDelay: Infinity });
  const recs = []; let header = true;
  for await (const l of rl) { if (header) { header = false; continue; } if (!l) continue; recs.push(featureToRecord(JSON.parse(l))); if (recs.length >= 2000) break; }
  assert.equal(recs.length, 2000);
  assert.equal(validDoc(recs), null);
});

// LPF certainty words are PLATO CertaintyLevels (PLATO 9d2c36e): they must come back as words,
// on the same element, with no number invented and no note written.
function certainties(f) {
  const out = [];
  const walk = (o, path) => {
    if (Array.isArray(o)) return o.forEach((x, i) => walk(x, path));
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) { if (k === 'certainty' && typeof v === 'string') out.push(`${path}:${v}`); else walk(v, k === 'when' ? path + '.when' : ['geometry', 'geometries', 'relations'].includes(k) ? k.replace(/ies$/, 'y').replace(/s$/, '') : path); }
  };
  walk(f, 'feature');
  return out.sort();
}
for (const [name, feature] of [['README example', README], ...JSON.parse(readFileSync('test/fixtures/lpf-sample-v1.2.2.geojson', 'utf8')).features.map((f, i) => [`sample feature ${i}`, f])]) {
  const want = certainties(feature);
  if (!want.length) continue;
  test(`LPF certainty words round-trip as certainty levels: ${name}`, () => {
    const rec = featureToRecord(feature);
    const json = JSON.stringify(rec);
    assert.ok(!json.includes('LPF certainty:'), 'a certainty word was written as a note');
    assert.ok(/#(Certain|LessCertain|Uncertain)"/.test(json), 'no certainty level in the PLATO record');
    assert.equal(validDoc([rec]), null);
    assert.deepEqual(certainties(recordToFeature(rec)), want);
  });
}
test('control: a changed certainty level is noticed', () => {
  const f = structuredClone(README);
  const rec = featureToRecord(f);
  const s = JSON.stringify(rec).replace(/#LessCertain"/g, '#Certain"').replace(/#Uncertain"/g, '#Certain"');
  assert.notDeepEqual(certainties(recordToFeature(JSON.parse(s))), certainties(f).length ? certainties(f) : ['none']);
});

// ---- the gazetteer, as the FeatureCollection's own members ---------------------------------------
// LPF v1's context maps @id, title (dct:title), license (dct:license) and descriptions (dct:description);
// a gazetteer's contributor has no term there, so it is reported. Read back, the members return.
import { go, textFile, outText } from './engine.js';
const GAZ = { '@id': 'https://example.org/gaz', title: 'A gazetteer', description: 'Places of one county', licence: 'https://creativecommons.org/licenses/by/4.0/', contributor: 'https://orcid.org/0000-0002-1825-0097' };
const gazDoc = (g) => JSON.stringify({ profile: 'place-centric', gazetteer: g, spatialEntities: [{ '@id': 'https://example.org/p', label: 'P', attestations: [{ names: [{ toponym: 'P' }] }] }] });
for (const [target, ext] of [['lpf', '.geojson'], ['lpf-seq', '.geojsonl']]) {
  test(`${target}: the gazetteer's address, title, description and licence are the collection's, and come back`, async () => {
    const r = await go([textFile(gazDoc(GAZ), 'g.json')], 'convert', target);
    const text = outText(r.e, 'g' + ext);
    const head = JSON.parse(target === 'lpf' ? text : text.split('\n')[0]);
    assert.deepEqual([head['@id'], head.title, head.license, head.descriptions], [GAZ['@id'], GAZ.title, GAZ.licence, [{ value: GAZ.description }]]);
    const lost = r.report.items.filter((i) => i.severity === 'loss').map((i) => i.kind);
    assert.deepEqual(lost.filter((k) => k.startsWith('dropped:gazetteer')), ['dropped:gazetteer.contributor']);
    assert.match(r.report.items.find((i) => i.kind === 'dropped:gazetteer.contributor').message, /^Who made the gazetteer \(its contributor\): Linked Places Format has no place for this, so it is left out\.$/);
    const back = await go([textFile(text, 'g' + ext)], 'convert', 'plato-json');
    const { contributor, ...kept } = GAZ;
    assert.deepEqual(JSON.parse(outText(back.e, 'g.json')).gazetteer, kept);
    // control: a header with a title alone writes none of the others, and the file name is not the title
    const bare = await go([textFile(gazDoc({ title: 'Bare' }), 'b.json')], 'convert', target);
    const bh = JSON.parse(outText(bare.e, 'b' + ext).split('\n')[0].replace(/,"features":.*$/, '}'));
    assert.deepEqual(Object.keys(bh).sort(), ['@context', 'title', 'type']);
  });
}

// LPF's collection licence may be prose (DEEP writes a sentence); PLATO's licence is an address.
test('an LPF licence in words is reported, not put where a web address belongs; a short form expands', async () => {
  const { collectionToGazetteer } = await import('../src/formats/lpf.js');
  const losses = [];
  const prose = 'Released under a Creative Commons Attribution-NonCommercial 4.0 International License.';
  const g = collectionToGazetteer({ type: 'FeatureCollection', license: prose }, 'f.geojson', (l) => losses.push(l));
  assert.equal(g.licence, undefined);
  assert.deepEqual(losses, [{ kind: 'lpf-licence-text', value: prose }]);
  assert.equal(collectionToGazetteer({ license: 'cc:by/4.0/' }, 'f').licence, 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(collectionToGazetteer({ license: 'https://example.org/licence' }, 'f').licence, 'https://example.org/licence');
});
