import { PLATO_REPO } from './paths.js';
// A value the converter cannot turn into RDF (a null in a list, or anywhere else) is skipped and
// reported, never thrown: a Check must always finish with a report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import jsonld from 'jsonld';
import { Json2Rdf } from '../src/formats/json2rdf.js';
import { tripleNT } from '../src/lib/ntriples.js';
import { loadResources } from '../src/engine/resources.js';
import { prepare, run } from '../src/engine/pipeline.js';
import { detect } from '../src/engine/input.js';

const RES = prepare(await loadResources(async (f) => readFileSync(`public/plato/${f}`, 'utf8')));
const CTX = JSON.parse(readFileSync('public/plato/plato.context.jsonld', 'utf8'));
const EX = `${PLATO_REPO}/schemas/examples`;
const dedupe = (nq) => [...new Set(nq.split('\n').filter(Boolean))].join('\n') + '\n';
const canon = (nq) => jsonld.canonize(dedupe(nq), { algorithm: 'URDNA2015', inputFormat: 'application/n-quads', format: 'application/n-quads', safe: false });

function convert(doc) {
  let nt = ''; const issues = [];
  const w = new Json2Rdf(CTX, (s, p, o) => { nt += tripleNT(s, p, o); }, { onIssue: (i) => issues.push(i) });
  const { spatialEntities, newSpatialEntities, attestations, identityRelations, ...head } = doc;
  w.header(head);
  for (const [k, arr] of Object.entries({ spatialEntities, newSpatialEntities, attestations, identityRelations })) {
    if (arr === undefined) continue;
    for (const r of [].concat(arr)) w.record(k, r);
  }
  return { nt, issues };
}
const reference = async (doc) => {
  try { return await jsonld.toRDF({ ...doc, '@context': CTX['@context'] }, { format: 'application/n-quads', safe: false }); }
  catch { return null; }   // jsonld.js rejects some of these documents outright; ours must still report
};

const place = (point) => ({
  profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' },
  spatialEntities: [{ '@id': 'https://example.org/p/1', label: 'Ranny', attestations: [{ geometries: [{ reprPoint: point }], sources: [{ title: 's' }] }] }],
});

test('regression: a null coordinate is skipped and reported, not thrown', async () => {
  const doc = place([130.6, null]);
  const { nt, issues } = convert(doc);   // threw "Cannot read properties of null (reading '@id')" before
  assert.ok(issues.some((i) => i.kind === 'null-value' && /reprPoint/.test(i.where)), JSON.stringify(issues));
  assert.equal((nt.match(/rdf-syntax-ns#first/g) || []).length, 1, 'the coordinate that is there is kept');
  assert.equal(await canon(nt), await canon(await reference(doc)), 'and the graph is the one jsonld.js gives');
});

test('control: the same place without a null reports nothing', () => {
  assert.deepEqual(convert(place([130.6, -3.78])).issues, []);
});

// Every position in every example, one at a time: the value there becomes null.
function positions(v, path = []) {
  const out = [];
  if (v && typeof v === 'object') for (const [k, c] of Object.entries(v)) { out.push([...path, k]); out.push(...positions(c, [...path, k])); }
  return out;
}
function withNull(doc, path) {
  const d = structuredClone(doc); let o = d;
  for (const k of path.slice(0, -1)) o = o[k];
  o[path.at(-1)] = null; return d;
}
const JSON_EXAMPLES = readdirSync(EX).filter((f) => f.endsWith('.json'));
test('the examples swept for nulls are there to sweep', () => {
  for (const f of ['attestation-centric-customs.json', 'candidate-set-judgements.json', 'place-centric-constantinople.json', 'place-centric-river-idle.json'])
    assert.ok(JSON_EXAMPLES.includes(f), `${f} is not among ${JSON_EXAMPLES.join(', ')}`);
});
for (const f of JSON_EXAMPLES) {
  test(`sweep: a null in any position of ${f} is reported, never thrown`, async () => {
    const doc = JSON.parse(readFileSync(`${EX}/${f}`, 'utf8'));
    // Inside a GeoJSON value a null is kept, as JSON, in the RDF literal: nothing is lost there.
    const all = positions(doc).filter((p) => p[0] !== '$schema' && p[0] !== '@context' && !p.slice(0, -1).includes('geojson'));
    // The sweep reaches into every part of the document. (It once asked for more than 50 positions,
    // which PLATO's smaller examples, a candidate set of two candidates among them, do not have.)
    for (const [k, v] of Object.entries(doc)) if (v && typeof v === 'object' && k !== '@context') assert.ok(all.some((p) => p[0] === k && p.length >= 2), `nothing swept under ${k}`);
    assert.ok(all.length > 25, `only ${all.length} positions`);
    let compared = 0;
    const silent = [], differ = [];
    for (const path of all) {
      const d = withNull(doc, path);
      const { nt, issues } = convert(d);   // must not throw
      if (!issues.length) silent.push(path.join('.'));
      const ref = await reference(d);
      if (ref !== null) { compared++; if (await canon(nt) !== await canon(ref)) differ.push(path.join('.')); }
    }
    // A null the converter keeps (a GeoJSON value is JSON, null and all) must be reported by the
    // Check's schema validation instead.
    for (const p of [...silent]) {
      const input = await detect([new File([JSON.stringify(withNull(doc, p.split('.')))], 'x.json')]);
      const r = await run({ input, action: 'check', target: null, options: {} }, { resources: RES, csvMeta: RES.csvMeta });
      if (r.report.items.some((i) => i.severity === 'error')) silent.splice(silent.indexOf(p), 1);
    }
    assert.deepEqual(silent, [], 'a null that neither the converter nor the schema reports');
    assert.deepEqual(differ, [], 'a null where the graph differs from jsonld.js');
    assert.ok(compared > all.length / 2, `only ${compared} of ${all.length} compared with jsonld.js`);
  });
}

test('a Check of a file with a null finishes with a report that names it', async () => {
  const res = RES;
  const input = await detect([new File([JSON.stringify(place([130.6, null]))], 'null.json')]);
  const r = await run({ input, action: 'check', target: null, options: {} }, { resources: res, csvMeta: res.csvMeta });
  assert.ok(r.report.items.some((i) => i.kind === 'null-value'), JSON.stringify(r.report.items.map((i) => i.kind)));
});
