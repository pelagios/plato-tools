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

// The one kind of number where these tools depart from jsonld.js (DEVELOPERS.md, Numbers): not a
// whole number, yet written without a '.' (1e-7), which jsonld.js writes as "0"^^xsd:integer.
const departs = (n) => typeof n === 'number' && Number.isFinite(n) && !Number.isInteger(n) && !String(n).includes('.');
function departures(v, at = '$', out = []) {
  if (departs(v)) out.push(`${at}: ${v}`);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) departures(x, `${at}.${k}`, out);
  return out;
}
const JSON_EXAMPLES = readdirSync(EXAMPLES).filter((f) => f.endsWith('.json'));
test('the examples compared with jsonld.js are there to compare', () => {
  for (const f of ['attestation-centric-customs.json', 'candidate-set-judgements.json', 'place-centric-constantinople.json', 'place-centric-river-idle.json'])
    assert.ok(JSON_EXAMPLES.includes(f), `${f} is not among ${JSON_EXAMPLES.join(', ')}`);
});
for (const f of JSON_EXAMPLES) {
  test(`same graph as jsonld.js: ${f}`, async () => {
    const doc = JSON.parse(readFileSync(`${EXAMPLES}/${f}`, 'utf8'));
    // Such a number would make the graphs differ by design: none is here, so the comparison is whole.
    assert.deepEqual(departures(doc), [], 'a number these tools write, by design, otherwise than jsonld.js');
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
  // The relation's target is not typed at all since PLATO 0.6.0: relates_to has no range, because its
  // target may be a person or an object described elsewhere. The relation type is shared instead.
  assert.equal(count(/county> <http:\/\/www.w3.org\/1999\/02\/22-rdf-syntax-ns#type>/), 0, 'a relation\'s target is not inferred to be a SpatialEntity');
  assert.equal(count(/plato#ContainedIn> <http:\/\/www.w3.org\/1999\/02\/22-rdf-syntax-ns#type> <https:\/\/w3id.org\/plato#RelationType>/), 1, 'the relation type is typed once, not once per record');
  assert.equal(count(/example.org\/g> <http:\/\/www.w3.org\/1999\/02\/22-rdf-syntax-ns#type>/), 1, 'the gazetteer is typed once');
  assert.equal(lines.length, new Set(lines).size, 'no line is written twice');
  // Removing the type lines leaves exactly the untyped graph.
  const untyped = lines.filter((l) => !/22-rdf-syntax-ns#type>/.test(l) || /Source>|Dataset>/.test(l)).join('\n') + '\n';
  assert.equal(await canon(untyped), await canon(compiled(doc)));
});

// jsonld.js decides that a number is a double by its text containing '.', so a number JavaScript
// writes in exponent form without one (1e-7) is written as the integer 0: the value is lost. These
// tools write a whole number as an integer and every other as a double, and so depart from
// jsonld.js for exactly these numbers; the equivalence tests above hold because no example has one.
test('a number below 1e-6 is a double, not the integer 0 jsonld.js makes of it, and comes back exactly', async () => {
  const { go, textFile, outText } = await import('./engine.js');
  const tiny = [1e-7, -3e-10, 5e-324, 2e-7];
  const doc = { profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' }, spatialEntities: tiny.map((n, i) => ({
    '@id': `https://example.org/p${i}`, label: `P${i}`, attestations: [{ properties: [{ property: 'https://example.org/prop/share', value: n }] }] })) };
  assert.deepEqual(departures(doc).length, tiny.length, 'control: the finder finds them');
  const ref = await reference(doc);
  assert.match(ref, /"0"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#integer>/, 'why: jsonld.js writes 1e-7 as the integer 0');
  const nt = compiled(doc);
  assert.doesNotMatch(nt, /XMLSchema#integer/);
  for (const lex of ['1.0E-7', '-3.0E-10', '4.940656458412465E-324', '2.0E-7']) assert.ok(nt.includes(`"${lex}"^^<http://www.w3.org/2001/XMLSchema#double>`), lex);
  // And otherwise the graph is jsonld.js's: with 0.5 for each, where both agree, they are the same.
  const half = structuredClone(doc); for (const e of half.spatialEntities) e.attestations[0].properties[0].value = 0.5;
  assert.equal(await canon(compiled(half)), await canon(await reference(half)));
  // Whole numbers stay integers, as in jsonld.js, and a large one a double.
  assert.ok(compiled({ ...half, spatialEntities: [{ ...half.spatialEntities[0], attestations: [{ properties: [{ property: 'https://example.org/prop/n', value: 1e20 }] }] }] }).includes('"100000000000000000000"^^<http://www.w3.org/2001/XMLSchema#integer>'));
  // Through RDF and back, each is the number it was.
  const r = await go([textFile(JSON.stringify(doc), 'tiny.json')], 'convert', 'ntriples');
  const back = await go([textFile(outText(r.e, 'tiny.nt'), 'tiny.nt')], 'convert', 'plato-jsonl');
  const values = outText(back.e, 'tiny.jsonl').trim().split('\n').slice(1).map((l) => JSON.parse(l).attestations[0].properties[0].value);
  assert.deepEqual(values.sort(), [...tiny].sort());
});

test('a source cited by every record is described once, and its timespan, a blank node, does not grow the set that remembers it', () => {
  const lines = [];
  const w = new Json2Rdf(CTX, (s, p, o) => lines.push(tripleNT(s, p, o)));
  w.header({ profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 'g' } });
  const source = { '@id': 'https://example.org/source/s', title: 'S', timespan: { sourceLabel: '1086', startEarliest: '1086' } };
  for (let i = 0; i < 2000; i++) w.record('spatialEntities', { '@id': `https://example.org/place/p${i}`, label: `p${i}`, attestations: [{ sources: [source], names: [{ toponym: `p${i}` }] }] });
  // The source's own statements are kept, and written once (the presence); the statements linking it
  // to each record's fresh timespan are not kept, since none can come again.
  assert.equal(lines.filter((l) => l.includes('<https://example.org/source/s> <https://w3id.org/plato#authority_title>')).length, 1);
  assert.ok(w.shared.size > 0 && w.shared.size < 10, `the set holds ${w.shared.size} entries`);
});
