import { PLATO_REPO, DEEP_EXPORT } from './paths.js';
// The compiled context must give exactly the graph jsonld.js gives, for every example.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import jsonld from 'jsonld';
import { Json2Rdf } from '../src/formats/json2rdf.js';
import { tripleNT } from '../src/lib/ntriples.js';

const CTX = JSON.parse(readFileSync('public/plato/plato.context.jsonld', 'utf8'));
const EXAMPLES = process.env.PLATO_REPO ? `${process.env.PLATO_REPO}/schemas/examples` : `${PLATO_REPO}/schemas/examples`;
// Compared as graphs: duplicate lines (the same triple from two records) are one triple.
const dedupe = (nq) => [...new Set(nq.split('\n').filter(Boolean))].join('\n') + '\n';
const canon = (nq) => jsonld.canonize(dedupe(nq), { algorithm: 'URDNA2015', inputFormat: 'application/n-quads', format: 'application/n-quads', safe: false });

function compiled(doc, options = {}) {
  let nt = '';
  const w = new Json2Rdf(CTX, (s, p, o) => { nt += tripleNT(s, p, o); }, options);
  const { spatialEntities, newSpatialEntities, attestations, identityRelations, ...head } = doc;
  w.header(head);
  for (const [k, arr] of Object.entries({ spatialEntities, newSpatialEntities, attestations, identityRelations })) for (const r of arr || []) w.record(k, r);
  return nt;
}
const reference = (doc) => jsonld.toRDF({ ...doc, '@context': CTX['@context'] }, { format: 'application/n-quads', safe: false });

for (const f of readdirSync(EXAMPLES).filter((f) => f.endsWith('.json'))) {
  test(`same graph as jsonld.js: ${f}`, async () => {
    const doc = JSON.parse(readFileSync(`${EXAMPLES}/${f}`, 'utf8'));
    const [a, b] = await Promise.all([canon(compiled(doc)), canon(await reference(doc))]);
    assert.ok(b.length > 0, 'reference graph is empty');
    assert.equal(a, b);
  });
}

const DEEP = `${DEEP_EXPORT}/deep-plato.jsonl.gz`;
async function deepSample(nRecords, nIdrs) {
  // Streamed: the file is larger than any JavaScript string can be.
  const rl = createInterface({ input: createReadStream(DEEP).pipe(createGunzip()), crlfDelay: Infinity });
  let head = null; const recs = [], idrs = [];
  for await (const l of rl) {
    if (!l) continue;
    if (!head) { head = JSON.parse(l); continue; }
    if (l.startsWith('{"@id"') && recs.length < nRecords) { recs.push(JSON.parse(l)); continue; }
    if (idrs.length < nIdrs && l.includes('"identityType"')) { const r = JSON.parse(l); if (r.subject && r.object) idrs.push(r); }
  }
  return { head, recs, idrs };
}
test('same graph as jsonld.js: DEEP sample (header, 300 entities, 50 identity relations)', async (t) => {
  if (!existsSync(DEEP)) { t.skip(`DEEP export not found at ${DEEP}`); return; }
  const { head, recs, idrs } = await deepSample(300, 50);
  assert.ok(recs.length === 300 && idrs.length === 50, `sample too small: ${recs.length} records, ${idrs.length} identity relations`);
  const doc = { ...head, spatialEntities: recs, identityRelations: idrs };
  const [a, b] = await Promise.all([canon(compiled(doc)), canon(await reference(doc))]);
  assert.equal(a, b);
});

test('control: a changed value makes the graphs differ', async () => {
  const doc = JSON.parse(readFileSync(`${EXAMPLES}/attestation-centric-survey.json`, 'utf8'));
  const changed = structuredClone(doc); changed.attestations[0].names[0].toponym = 'Changed';
  const [a, b] = await Promise.all([canon(compiled(changed)), canon(await reference(doc))]);
  assert.notEqual(a, b);
});

test('a shared source is described once across records, and the graph is unchanged', async () => {
  const src = { '@id': 'https://example.org/source/db', title: 'DB', citation: 'Domesday Book', authorityType: 'source', timespan: { label: '1086' } };
  const doc = { profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' }, spatialEntities: [1, 2, 3].map((i) => ({
    '@id': `https://example.org/p${i}`, label: `P${i}`, attestations: [{ names: [{ toponym: `N${i}` }], sources: [src] }] })) };
  const nt = compiled(doc);
  assert.equal((nt.match(/authority_title/g) || []).length, 1, 'the source title should be written once');
  assert.equal(await canon(nt), await canon(await reference(doc)));
});

test('with typing, a node shared by records is typed once for the file, and the graph is unchanged', async () => {
  const { loadResources } = await import('../src/engine/resources.js');
  const { prepare } = await import('../src/engine/pipeline.js');
  const res = prepare(await loadResources(async (f) => readFileSync(`public/plato/${f}`, 'utf8')));
  const src = { '@id': 'https://example.org/source/db', title: 'DB', authorityType: 'source' };
  const doc = { profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' }, spatialEntities: [1, 2, 3].map((i) => ({
    '@id': `https://example.org/p${i}`, label: `P${i}`, attestations: [{ names: [{ toponym: `N${i}` }], sources: [src], relations: [{ relatesTo: 'https://example.org/county', relationType: 'https://w3id.org/plato#ContainedIn' }] }] })) };
  const typed = compiled(doc, { types: res.types });
  const lines = typed.split('\n').filter(Boolean);
  const count = (re) => lines.filter((l) => re.test(l)).length;
  assert.equal(count(/source\/db> <http:\/\/www.w3.org\/1999\/02\/22-rdf-syntax-ns#type>/), new Set(lines.filter((l) => /source\/db> <[^>]*#type>/.test(l))).size, 'each type of the source once');
  assert.equal(count(/county> <http:\/\/www.w3.org\/1999\/02\/22-rdf-syntax-ns#type> <https:\/\/w3id.org\/plato#SpatialEntity>/), 1, 'the county is typed once, not once per record');
  assert.equal(count(/example.org\/g> <http:\/\/www.w3.org\/1999\/02\/22-rdf-syntax-ns#type>/), 1, 'the gazetteer is typed once');
  assert.equal(lines.length, new Set(lines).size, 'no line is written twice');
  // Removing the type lines leaves exactly the untyped graph.
  const untyped = lines.filter((l) => !/22-rdf-syntax-ns#type>/.test(l) || /Source>|Dataset>/.test(l)).join('\n') + '\n';
  assert.equal(await canon(untyped), await canon(compiled(doc)));
});
