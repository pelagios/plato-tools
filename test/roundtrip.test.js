import { PLATO_REPO, DEEP_EXPORT } from './paths.js';
// JSON -> RDF -> JSON must lose nothing: the second JSON must give the same graph as the first,
// and must itself be valid against the PLATO JSON Schemas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import jsonld from 'jsonld';
import Ajv2020 from 'ajv/dist/2020.js';
import { addPlatoFormats, strictFormatLogger } from '../src/lib/formats.js';
import { Json2Rdf } from '../src/formats/json2rdf.js';
import { Rdf2Json, MemGraph } from '../src/formats/rdf2json.js';
import { tripleNT } from '../src/lib/ntriples.js';
import { PLATO } from '../src/lib/context.js';

const load = (f) => JSON.parse(readFileSync(`public/plato/${f}`, 'utf8'));
const CTX = load('plato.context.jsonld'), CORE = load('plato.schema.json');
const PROFILES = { 'place-centric': load('place-centric.schema.json'), 'attestation-centric': load('attestation-centric.schema.json'), 'candidate-set': load('candidate-set.schema.json') };
const EXAMPLES = `${PLATO_REPO}/schemas/examples`;
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
  const r = new Rdf2Json({ context: CTX, core: CORE, profile: PROFILES[profileName === 'candidate-set' ? 'place-centric' : profileName], candidateProfile: PROFILES['candidate-set'] }, g, { onLoss: (l) => losses.push(l) });
  const id = docNode.termType === 'BlankNode' ? '_:' + docNode.value : docNode.value;
  const kids = (p) => g.out(id).filter((t) => t.p === PLATO + p).map((t) => (t.o.termType === 'BlankNode' ? '_:' + t.o.value : t.o.value));
  // A candidate set (PLATO 53c5a40): its header, then its candidates.
  if (profileName === 'candidate-set') {
    const doc = { $schema: 'https://w3id.org/plato/schemas/candidate-set.schema.json', ...r.candidateSetHeader(id), candidates: kids('contains_candidate').map((c) => r.candidate(c)) };
    return { doc, losses };
  }
  const head = r.header(id);
  const doc = { $schema: `https://w3id.org/plato/schemas/${profileName}.schema.json`, ...head, profile: profileName };
  if (profileName === 'place-centric') doc.spatialEntities = kids('contains_entity').map((e) => r.entity(e));
  else {
    doc.attestations = kids('contains_attestation').map((a) => r.attestation(a));
    const ne = kids('contains_entity'); if (ne.length) doc.newSpatialEntities = ne.map((e) => r.entity(e));
  }
  const ir = kids('contains_identity_relation'); if (ir.length) doc.identityRelations = ir.map((i) => r.identityRelation(i));
  return { doc, losses };
}
const ajv = addPlatoFormats(new Ajv2020({ strict: false, allErrors: true, logger: strictFormatLogger }));
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
    // Lean equivalence: a shared source written out in each record that cites it gives each copy its
    // own blank-node date when read again, which RDF treats as the same information.
    assert.equal(lean(toRdf(back).nt), lean(first.nt));
  });
}
// PLATO 7720890 (#19): relativeTo is one anchor or a list; BetweenXAndY takes exactly two.
const placeWith = (qualification) => ({
  profile: 'place-centric', title: 't', '@id': 'https://example.org/d',
  spatialEntities: [{ '@id': 'https://example.org/p', attestations: [{ '@id': 'https://example.org/p#a', geometries: [{ sourceLabel: 's', qualification }] }] }],
});
const qualificationBack = (doc) => {
  const first = toRdf(doc);
  return toJson(first.g, first.docNode, 'place-centric').doc.spatialEntities[0].attestations[0].geometries[0].qualification;
};
test('relativeTo: two anchors come back as a list of both, and one anchor as a string', () => {
  const two = ['https://example.org/x', 'https://example.org/y'];
  const back = qualificationBack(placeWith({ relativeQualifier: 'https://w3id.org/plato#BetweenXAndY', relativeTo: two }));
  assert.ok(Array.isArray(back.relativeTo), `relativeTo came back as ${JSON.stringify(back.relativeTo)}`);
  assert.deepEqual([...back.relativeTo].sort(), two);
  const one = qualificationBack(placeWith({ relativeQualifier: 'https://w3id.org/plato#Near', relativeTo: 'https://example.org/x' }));
  assert.equal(one.relativeTo, 'https://example.org/x');
  // A list of one is the same graph as the string, and reads back as the string.
  const listOfOne = qualificationBack(placeWith({ relativeQualifier: 'https://w3id.org/plato#Near', relativeTo: ['https://example.org/x'] }));
  assert.equal(listOfOne.relativeTo, 'https://example.org/x');
});
// PLATO 7720890 (#18): a relation may name its target by relatedLabel alone; Trismegistos place 60 is "in the Delta".
test('a relation named by relatedLabel alone, with no relatesTo, comes back as it went in (Trismegistos place 60)', () => {
  const doc = JSON.parse(readFileSync(`${EXAMPLES}/place-centric-trismegistos.json`, 'utf8'));
  const place = (d) => d.spatialEntities.find((e) => e['@id'] === 'https://www.trismegistos.org/place/60');
  const relationsOf = (e) => e.attestations.flatMap((a) => a.relations || []);
  const delta = relationsOf(place(doc)).filter((r) => r.relatesTo === undefined);
  assert.deepEqual(delta, [{ relationType: 'https://w3id.org/plato#ContainedIn', relatedLabel: 'the Delta', relationLabel: 'in the Delta' }], 'the example has the relation');
  const first = toRdf(doc);
  assert.match(first.nt, /<https:\/\/w3id\.org\/plato#related_label> "the Delta"/);
  const { doc: back, losses } = toJson(first.g, first.docNode, 'place-centric');
  assert.deepEqual(losses, []);
  assert.deepEqual(relationsOf(place(back)).filter((r) => r.relatesTo === undefined), delta);
});
test('control: the comparison notices a dropped attestation', async () => {
  const doc = JSON.parse(readFileSync(`${EXAMPLES}/place-centric-constantinople.json`, 'utf8'));
  const first = toRdf(doc);
  const { doc: back } = toJson(first.g, first.docNode, 'place-centric');
  back.spatialEntities[0].attestations.pop();
  assert.notEqual(lean(toRdf(back).nt), lean(first.nt));
});

import { existsSync, createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
const DEEP = `${DEEP_EXPORT}/deep-plato.jsonl.gz`;
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

test('a name that carries the IRI of its own place keeps its spelling (DEEP does this 27,447 times)', () => {
  const doc = { profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 'test' }, spatialEntities: [
    { '@id': 'https://example.org/p1', label: 'Norton', attestations: [{ names: [{ '@id': 'https://example.org/p1', toponym: 'Norton' }], sources: [{ title: 's' }] }] }] };
  const first = toRdf(doc);
  const { doc: back } = toJson(first.g, first.docNode, 'place-centric');
  assert.equal(back.spatialEntities[0].attestations[0].names[0].toponym, 'Norton');
  const validate = ajv.getSchema('https://w3id.org/plato/schemas/place-centric.schema.json');
  assert.ok(validate(back), JSON.stringify(validate.errors?.slice(0, 2)));
});

import { loadResources } from '../src/engine/resources.js';
const RES = await loadResources(async (f) => readFileSync(`public/plato/${f}`, 'utf8'));
test('the report stays quiet about a place that is also a name, and about identical repeated values', () => {
  const src = { '@id': 'https://example.org/source/db', title: 'DB', authorityType: 'source', timespan: { label: '1086' } };
  const doc = { profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' }, spatialEntities: [
    { '@id': 'https://example.org/p1', label: 'Norton', attestations: [{ names: [{ '@id': 'https://example.org/p1', toponym: 'Norton' }], sources: [src] }] },
    { '@id': 'https://example.org/p2', label: 'Sutton', attestations: [{ names: [{ toponym: 'Sutton' }], sources: [src] }] }] };
  const first = toRdf(doc);   // two records each mint their own copy of the source's date
  const losses = [], issues = [];
  const r = new Rdf2Json({ context: CTX, core: CORE, profile: PROFILES['place-centric'], types: RES.types }, first.g, { onLoss: (l) => losses.push(l), onIssue: (i) => issues.push(i) });
  const recs = ['https://example.org/p1', 'https://example.org/p2'].map((e) => r.entity(e));
  assert.equal(recs[0].attestations[0].names[0].toponym, 'Norton');
  assert.deepEqual(losses, [], 'the toponym on p1 is its name role, not a loss');
  assert.deepEqual(issues, [], 'identical copies of the source date are one value');
  // control: a genuinely different second value is still reported
  first.g.add({ termType: 'NamedNode', value: 'https://example.org/source/db' }, { termType: 'NamedNode', value: 'https://w3id.org/plato#authority_title' }, { termType: 'Literal', value: 'Domesday', datatype: 'http://www.w3.org/2001/XMLSchema#string' });
  const issues2 = [];
  new Rdf2Json({ context: CTX, core: CORE, profile: PROFILES['place-centric'], types: RES.types }, first.g, { onIssue: (i) => issues2.push(i) }).entity('https://example.org/p1');
  assert.ok(issues2.some((i) => i.kind === 'multiple-values' && i.key === 'title'), JSON.stringify(issues2));
});

test("a relation's wording survives JSON -> RDF -> JSON (plato:source_label), and would be noticed if lost", () => {
  const doc = { profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' }, spatialEntities: [
    { '@id': 'https://example.org/abingdon', label: 'Abingdon', attestations: [{ relations: [{ relatesTo: 'https://example.org/berkshire',
      relationType: 'https://w3id.org/plato#ContainedIn', relationLabel: 'part of Berkshire (UK)' }], sources: [{ title: 's' }] }] }] };
  const first = toRdf(doc);
  assert.match(first.nt, /<https:\/\/w3id\.org\/plato#source_label> "part of Berkshire \(UK\)"/);
  const { doc: back, losses } = toJson(first.g, first.docNode, 'place-centric');
  assert.deepEqual(losses, []);
  assert.equal(back.spatialEntities[0].attestations[0].relations[0].relationLabel, 'part of Berkshire (UK)');
  // control: with the old context, where relationLabel mapped to null, the wording would be gone
  const old = structuredClone(CTX);
  const walk = (o) => { if (o && typeof o === 'object') { if ('relationLabel' in o) o.relationLabel = null; Object.values(o).forEach(walk); } };
  walk(old['@context']);
  let nt = ''; const w = new Json2Rdf(old, (s, p, o) => { nt += tripleNT(s, p, o); });
  w.header({ gazetteer: doc.gazetteer }); w.record('spatialEntities', doc.spatialEntities[0]);
  assert.doesNotMatch(nt, /source_label/);
});

// JSON -> RDF -> JSON is exact for every value but one kind: a JSON number that needs all 17
// significant digits. JSON-LD writes a non-integer as a canonical xsd:double with 16 significant
// digits (%1.15E), as jsonld.js does and these tools must, so such a number comes back one unit in
// the last place away. GLOBALISE's Fort Rijswijk longitude is the case that was found. This test
// pins the behaviour: it fails if the rounding changes, or if it starts to reach shorter numbers.
test('a 17-digit number comes back rounded to 16 digits, exactly as jsonld.js writes it', async () => {
  const lon = 106.82041100000001, lat = -6.1333;
  const doc = { profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' }, spatialEntities: [
    { '@id': 'https://example.org/rijswijk', label: 'Fort Rijswijk', attestations: [{ geometries: [{ reprPoint: [lon, lat] }], sources: [{ title: 's' }] }] }] };
  const first = toRdf(doc);
  assert.match(first.nt, /"1\.06820411E2"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#double>/);
  const ref = await jsonld.toRDF({ ...doc, '@context': CTX['@context'] }, { format: 'application/n-quads', safe: false });
  assert.match(ref, /"1\.06820411E2"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#double>/, 'jsonld.js writes the same literal');
  const { doc: back } = toJson(first.g, first.docNode, 'place-centric');
  const [lon2, lat2] = back.spatialEntities[0].attestations[0].geometries[0].reprPoint;
  assert.equal(lon2, 106.820411);
  assert.notEqual(lon2, lon, 'the 17th digit is lost');
  assert.equal(Math.abs(lon2 - lon), 2 ** -46, 'by one unit in the last place (for numbers between 64 and 128)');
  assert.equal(lat2, lat, 'a number of 16 digits or fewer comes back exactly');
  for (const n of [0.1, 1 / 3, 51.507222, -0.1275, 2.220446049250313e-16, 123456789.12345678]) {
    const d = structuredClone(doc); d.spatialEntities[0].attestations[0].geometries[0].reprPoint = [n, 0];
    const r = toRdf(d); const got = toJson(r.g, r.docNode, 'place-centric').doc.spatialEntities[0].attestations[0].geometries[0].reprPoint[0];
    assert.equal(got, Number(n.toPrecision(16)), `${n}`);
  }
});

// An rdf:type the tools would derive again passes in silence; any other is reported as a loss.
test('types: the tools\' own typed export reads back with no type lost; a foreign or contrary type is reported', async () => {
  const { go, textFile, outText } = await import('./engine.js');
  for (const f of ['place-centric-constantinople.json', 'place-centric-judgements.json', 'place-centric-statistics.json', 'attestation-centric-survey.json']) {
    const nt = await go([textFile(readFileSync(`${EXAMPLES}/${f}`, 'utf8'), f)], 'convert', 'ntriples', { typing: true });
    const text = outText(nt.e, f.replace(/\.json$/, '.nt'));
    assert.ok(/22-rdf-syntax-ns#type/.test(text), `${f}: the export is typed`);
    const back = await go([textFile(text, 'b.nt')], 'convert', 'plato-jsonl');
    assert.deepEqual(back.report.items.filter((i) => i.kind === 'type-not-carried').map((i) => i.examples), [], f);
  }
  const doc = { profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' },
    spatialEntities: [{ '@id': 'https://example.org/p/1', label: 'P', attestations: [{ '@id': 'https://example.org/a/1', names: [{ '@id': 'https://example.org/n/1', toponym: 'P' }], sources: [{ title: 's' }] }] }] };
  const nt = await go([textFile(JSON.stringify(doc), 'd.json')], 'convert', 'ntriples', { typing: true });
  const T = '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>';
  const extra = `<https://example.org/p/1> ${T} <http://xmlns.com/foaf/0.1/Person> .\n<https://example.org/n/1> ${T} <https://w3id.org/plato#Timespan> .\n`;
  const back = await go([textFile(outText(nt.e, 'd.nt') + extra, 'e.nt')], 'convert', 'plato-jsonl');
  const lost = back.report.items.filter((i) => i.kind === 'type-not-carried');
  assert.equal(lost.length, 1);
  assert.equal(lost[0].severity, 'loss');
  assert.deepEqual(lost[0].examples.sort(), ['https://example.org/n/1: https://w3id.org/plato#Timespan', 'https://example.org/p/1: http://xmlns.com/foaf/0.1/Person']);
});
