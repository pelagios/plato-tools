import { PLATO_REPO, DEEP_EXPORT } from './paths.js';
// LPF -> PLATO must produce valid PLATO JSON and lose only what is reported; LPF -> PLATO -> LPF
// must give back every LPF element the README example uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { featureToRecord, recordToFeature, expandLpf } from '../src/formats/lpf.js';

const load = (f) => JSON.parse(readFileSync(`public/plato/${f}`, 'utf8'));
const CORE = load('plato.schema.json'), PC = load('place-centric.schema.json');
const ajv = new Ajv2020({ strict: false, allErrors: true }); addFormats(ajv);
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
