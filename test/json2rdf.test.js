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
const EXAMPLES = process.env.PLATO_REPO ? `${process.env.PLATO_REPO}/schemas/examples` : '../place-attestation-ontology/schemas/examples';
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

const DEEP = process.env.DEEP_JSONL || '../deep/data/export/deep-plato.jsonl.gz';
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
