// JSON -> RDF -> JSON must lose nothing: the second JSON must give the same graph as the first,
// and must itself be valid against the PLATO JSON Schemas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import jsonld from 'jsonld';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { Json2Rdf } from '../src/formats/json2rdf.js';
import { Rdf2Json, MemGraph } from '../src/formats/rdf2json.js';
import { tripleNT } from '../src/lib/ntriples.js';
import { PLATO } from '../src/lib/context.js';

const load = (f) => JSON.parse(readFileSync(`public/plato/${f}`, 'utf8'));
const CTX = load('plato.context.jsonld'), CORE = load('plato.schema.json');
const PROFILES = { 'place-centric': load('place-centric.schema.json'), 'attestation-centric': load('attestation-centric.schema.json') };
const EXAMPLES = '../place-attestation-ontology/schemas/examples';
const dedupe = (nq) => [...new Set(nq.split('\n').filter(Boolean))].join('\n') + '\n';
const canon = (nq) => jsonld.canonize(dedupe(nq), { algorithm: 'URDNA2015', inputFormat: 'application/n-quads', format: 'application/n-quads', safe: false });

function toRdf(doc) {
  let nt = ''; const g = new MemGraph();
  const w = new Json2Rdf(CTX, (s, p, o) => { nt += tripleNT(s, p, o); g.add(s, p, o); });
  const { spatialEntities, newSpatialEntities, attestations, identityRelations, ...head } = doc;
  const docNode = w.header(head);
  for (const [k, arr] of Object.entries({ spatialEntities, newSpatialEntities, attestations, identityRelations })) for (const r of arr || []) w.record(k, r);
  return { nt, g, docNode };
}
function toJson(g, docNode, profileName) {
  const losses = [];
  const r = new Rdf2Json({ context: CTX, core: CORE, profile: PROFILES[profileName] }, g, { onLoss: (l) => losses.push(l) });
  const id = docNode.termType === 'BlankNode' ? '_:' + docNode.value : docNode.value;
  const head = r.header(id);
  const doc = { $schema: `https://w3id.org/plato/schemas/${profileName}.schema.json`, ...head, profile: profileName };
  const kids = (p) => g.out(id).filter((t) => t.p === PLATO + p).map((t) => (t.o.termType === 'BlankNode' ? '_:' + t.o.value : t.o.value));
  if (profileName === 'place-centric') doc.spatialEntities = kids('contains_entity').map((e) => r.entity(e));
  else {
    doc.attestations = kids('contains_attestation').map((a) => r.attestation(a));
    const ne = kids('contains_entity'); if (ne.length) doc.newSpatialEntities = ne.map((e) => r.entity(e));
  }
  const ir = kids('contains_identity_relation'); if (ir.length) doc.identityRelations = ir.map((i) => r.identityRelation(i));
  return { doc, losses };
}
const ajv = new Ajv2020({ strict: false, allErrors: true }); addFormats(ajv);
ajv.addSchema(CORE, 'https://w3id.org/plato/schemas/plato.schema.json');
for (const p of Object.values(PROFILES)) ajv.addSchema(p);

for (const f of readdirSync(EXAMPLES).filter((f) => f.endsWith('.json'))) {
  test(`JSON -> RDF -> JSON is lossless and valid: ${f}`, async () => {
    const doc = JSON.parse(readFileSync(`${EXAMPLES}/${f}`, 'utf8'));
    const first = toRdf(doc);
    const { doc: back, losses } = toJson(first.g, first.docNode, doc.profile);
    assert.deepEqual(losses, [], 'nothing should be unplaceable');
    const validate = ajv.getSchema(`https://w3id.org/plato/schemas/${doc.profile}.schema.json`);
    assert.ok(validate(back), JSON.stringify(validate.errors?.slice(0, 3)));
    const second = toRdf(back);
    assert.equal(await canon(second.nt), await canon(first.nt));
  });
}
test('control: the comparison notices a dropped attestation', async () => {
  const doc = JSON.parse(readFileSync(`${EXAMPLES}/place-centric-constantinople.json`, 'utf8'));
  const first = toRdf(doc);
  const { doc: back } = toJson(first.g, first.docNode, 'place-centric');
  back.spatialEntities[0].attestations.pop();
  assert.notEqual(await canon(toRdf(back).nt), await canon(first.nt));
});

import { existsSync, createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
const DEEP = process.env.DEEP_JSONL || '../deep/data/export/deep-plato.jsonl.gz';
test('JSON -> RDF -> JSON is lossless and valid: DEEP sample (300 entities, 50 identity relations)', async (t) => {
  if (!existsSync(DEEP)) { t.skip(`DEEP export not found at ${DEEP}`); return; }
  const rl = createInterface({ input: createReadStream(DEEP).pipe(createGunzip()), crlfDelay: Infinity });
  let head = null; const recs = [], idrs = [];
  for await (const l of rl) {
    if (!l) continue;
    if (!head) { head = JSON.parse(l); continue; }
    if (l.startsWith('{"@id"') && recs.length < 300) { recs.push(JSON.parse(l)); continue; }
    if (idrs.length < 50 && l.includes('"identityType"')) { const r = JSON.parse(l); if (r.subject && r.object) idrs.push(r); }
  }
  assert.ok(recs.length === 300 && idrs.length === 50);
  const doc = { ...head, spatialEntities: recs, identityRelations: idrs };
  const first = toRdf(doc);
  const { doc: back, losses } = toJson(first.g, first.docNode, 'place-centric');
  assert.deepEqual(losses, []);
  const validate = ajv.getSchema('https://w3id.org/plato/schemas/place-centric.schema.json');
  assert.ok(validate(back), JSON.stringify(validate.errors?.slice(0, 3)));
  // DEEP writes a shared source out in full in every record that cites it, so its blank-node
  // timespan becomes one distinct but redundant node per record. The round trip writes the lean
  // graph (the source in full once, then by IRI), which RDF treats as equivalent. So this test
  // compares lean forms, in which identical blank-node trees merge, rather than isomorphism.
  assert.equal(lean(toRdf(back).nt), lean(first.nt));
  const damaged = toRdf({ ...back, spatialEntities: back.spatialEntities.slice(1) });
  assert.notEqual(lean(damaged.nt), lean(first.nt), 'control: lean comparison must notice a dropped record');
});

/** Normal form for tree-shaped blank nodes: each blank node is labelled by a hash of its content. */
function lean(nt) {
  const out = new Map();
  const triples = [...new Set(nt.split('\n').filter(Boolean))].map((l) => {
    const m = l.match(/^(\S+) (\S+) (.*) \.$/);
    return [m[1], m[2], m[3]];
  });
  for (const t of triples) if (t[0].startsWith('_:')) (out.get(t[0]) || out.set(t[0], []).get(t[0])).push(t);
  const memo = new Map();
  const label = (b, depth = 0) => {
    if (memo.has(b)) return memo.get(b);
    if (depth > 50) return b;
    const parts = (out.get(b) || []).map(([, p, o]) => p + ' ' + (o.startsWith('_:') ? label(o, depth + 1) : o)).sort();
    let h = 0; const str = parts.join('|');
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    const v = '_:h' + (h >>> 0).toString(36) + '_' + str.length;
    memo.set(b, v); return v;
  };
  return [...new Set(triples.map(([s, p, o]) => (s.startsWith('_:') ? label(s) : s) + ' ' + p + ' ' + (o.startsWith('_:') ? label(o) : o)))].sort().join('\n');
}
