import { PLATO_REPO } from './paths.js';
// PLATO's changes of 2026-09-30 (238d15f, 45e4eed, 51b1d9a), through every reader and writer:
//   - identity relations an attestation bundles (plato:attests_identity, JSON `identities`), which
//     share its provenance, and which, in a denial, say that two entities are NOT the same;
//   - a meta-attestation need not say what it is about: its target does;
//   - a type's vocabulary and its version (scheme -> skos:inScheme, schemeVersion ->
//     plato:scheme_version; the tables' type_scheme and type_scheme_version);
//   - the four route and network kinds, now concepts in plato:EntityKindScheme, not plato:Type instances.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import Papa from 'papaparse';
import { file, textFile, outText, go } from './engine.js';

const EX = `${PLATO_REPO}/schemas/examples`;
const JUDGEMENTS = `${EX}/place-centric-judgements.json`;
const P = 'https://w3id.org/plato#', SKOS = 'http://www.w3.org/2004/02/skos/core#', RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const W = 'https://whgazetteer.org/example/';
const HILL = W + 'entity/newton-on-the-hill', RIVER = W + 'entity/newton-by-the-river', DISTINCT = W + 'attestation/newtons-distinct';
const errors = (r) => r.report.items.filter((i) => i.severity === 'error');
const lossKinds = (r) => r.report.items.filter((i) => i.severity === 'loss').map((i) => i.kind);
const loss = (r, kind) => r.report.items.find((i) => i.severity === 'loss' && i.kind === kind);
const sheet = (zipBytes, name) => Papa.parse(strFromU8(unzipSync(zipBytes)[name]), { header: true, skipEmptyLines: true }).data;
const judgements = () => JSON.parse(readFileSync(JUDGEMENTS, 'utf8'));
const jsonl = (r, name) => outText(r.e, name).trim().split('\n').slice(1).map((l) => JSON.parse(l));

/** N-Triples as [s, p, o] (o with its datatype), enough to look for the statements that matter. */
const triples = (nt) => nt.trim().split('\n').map((l) => l.match(/^(\S+) <([^>]+)> (.+) \.$/)).filter(Boolean).map(([, s, p, o]) => [s.replace(/^<|>$/g, ''), p, o]);
const objectsOf = (ts, s, p) => ts.filter((t) => t[0] === s && t[1] === p).map((t) => t[2]);
const toNt = async (doc, name = 'd.json') => {
  // With the node types the DEEP triplifier's rule adds (the command line's default), as a store finds them.
  const r = await go([textFile(JSON.stringify(doc), name)], 'convert', 'ntriples', { typing: true });
  assert.deepEqual(errors(r), []);
  return outText(r.e, name.replace(/\.json$/, '.nt'));
};
const one = (attestation, extra = {}) => ({ profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' },
  spatialEntities: [{ '@id': 'https://example.org/place/p', label: 'P', attestations: [{ sources: [{ '@id': 'https://example.org/source/s', title: 'S' }], ...attestation }], ...extra },
    { '@id': 'https://example.org/place/q', label: 'Q', attestations: [{ names: [{ toponym: 'Q' }], sources: [{ '@id': 'https://example.org/source/s', title: 'S' }] }] }] });
const bundle = (extra = {}) => ({ '@id': 'https://example.org/att/cluster', certainty: 0.5,
  identities: [{ subject: 'https://example.org/place/p', object: 'https://example.org/place/q', identityType: 'exactMatch', certainty: 0.8 }], ...extra });

// ---- 1. bundled identity relations -----------------------------------------------------------------
test('JSON -> RDF: bundled identities hang from the attestation by attests_identity, each with its own certainty', async () => {
  const ts = triples(await toNt(one(bundle())));
  const att = 'https://example.org/att/cluster';
  const [ir] = objectsOf(ts, att, P + 'attests_identity');
  assert.ok(ir, 'the attestation bundles an identity relation');
  const key = ir.replace(/^<|>$/g, '');
  assert.deepEqual(objectsOf(ts, key, P + 'identity_subject'), ['<https://example.org/place/p>']);
  assert.deepEqual(objectsOf(ts, key, P + 'identity_object'), ['<https://example.org/place/q>']);
  assert.deepEqual(objectsOf(ts, key, P + 'identity_type'), ['"exactMatch"']);
  assert.deepEqual(objectsOf(ts, key, RDF_TYPE), [`<${P}IdentityRelation>`]);
  // The relation's certainty is identity_certainty; the attestation's own stays plato:certainty.
  assert.match(objectsOf(ts, key, P + 'identity_certainty')[0] || '', /^"8\.0+E-1"\^\^/);
  assert.deepEqual(objectsOf(ts, key, P + 'certainty'), [], 'no plato:certainty on the identity relation');
  assert.match(objectsOf(ts, att, P + 'certainty')[0] || '', /^"5\.0+E-1"\^\^/);
  assert.deepEqual(objectsOf(ts, att, P + 'identity_certainty'), []);
  // It is not a relation of the document's own, and not one of the place's.
  assert.ok(!ts.some((t) => t[1] === P + 'contains_identity_relation'));
});

test("RDF -> JSON: the judgements example's denied identity comes back under its attestation, negated, and nowhere else", async () => {
  const original = judgements();
  const want = original.spatialEntities.flatMap((e) => e.attestations || []).find((a) => a['@id'] === DISTINCT);
  assert.ok(want?.identities?.length && want.negated === true, 'the example has the negated bundle');
  const nt = outText((await go([file(JUDGEMENTS)], 'convert', 'ntriples', { typing: true })).e, 'place-centric-judgements.nt');
  assert.match(nt, /IdentityRelation>/, 'typed, so that a relation can be found by its type');
  for (const [name, text] of [['with its document node', nt],
    // Without the Gazetteer node, identity relations are found by their type: the bundled one must still not surface.
    ['without a document node', nt.split('\n').filter((l) => !l.includes(P + 'contains_') && !l.includes(`<${P}Gazetteer>`)).join('\n') + '\n']]) {
    const r = await go([textFile(text, 'j.nt')], 'convert', 'plato-json');
    assert.deepEqual(errors(r), [], name);
    assert.deepEqual(lossKinds(r).filter((k) => k !== 'unmapped-predicate'), [], name);
    const d = JSON.parse(outText(r.e, 'j.json'));
    const got = d.spatialEntities.flatMap((e) => e.attestations || []).find((a) => a['@id'] === DISTINCT);
    assert.deepEqual(got.identities, want.identities, name);
    assert.equal(got.negated, true, name);
    // Never as a match: not a top-level relation, not nested under either Newton.
    const standalone = [...(d.identityRelations || []), ...d.spatialEntities.flatMap((e) => e.identityRelations || [])];
    assert.ok(!standalone.some((ir) => ir.object === RIVER || ir.subject === RIVER), `${name}: ${JSON.stringify(standalone)}`);
    // control: the search sees a standalone relation where there is one
    const c = JSON.parse(JSON.stringify(original));
    c.spatialEntities.find((e) => e['@id'] === HILL).identityRelations = [{ object: RIVER, identityType: 'closeMatch' }];
    const cr = await go([textFile(outText((await go([textFile(JSON.stringify(c), 'c.json')], 'convert', 'ntriples')).e, 'c.nt'), 'c.nt')], 'convert', 'plato-json');
    const cd = JSON.parse(outText(cr.e, 'c.json'));
    assert.ok(cd.spatialEntities.flatMap((e) => e.identityRelations || []).some((ir) => ir.object === RIVER), 'control');
  }
});

test('RDF -> JSON: a bundle keeps its relation certainty apart from the attestation\'s, losslessly', async () => {
  const d = one(bundle());
  const r = await go([textFile(await toNt(d), 'b.nt')], 'convert', 'plato-json');
  assert.deepEqual(errors(r), []);
  const a = JSON.parse(outText(r.e, 'b.json')).spatialEntities.find((e) => e['@id'].endsWith('/p')).attestations[0];
  assert.deepEqual(a.identities, d.spatialEntities[0].attestations[0].identities);
  assert.equal(a.certainty, 0.5);
});

/** Every LPF link, as one string to search: where an identity match would be written. */
const lpfLinks = (text) => JSON.stringify(JSON.parse(text).features.map((f) => f.links || []));
for (const target of ['tables', 'lpf']) {
  test(`${target}: a denied identity is never written as a match, and is reported in its own words`, async () => {
    for (const [name, input] of [['from JSON', () => file(JUDGEMENTS)],
      ['from RDF', async () => textFile(outText((await go([file(JUDGEMENTS)], 'convert', 'ntriples')).e, 'place-centric-judgements.nt'), 'j.nt')]]) {
      const r = await go([await input()], 'convert', target);
      assert.deepEqual(errors(r), [], name);
      const out = target === 'tables' ? strFromU8(unzipSync(r.e.outs[Object.keys(r.e.outs)[0]][0])['identities.csv']) : lpfLinks(outText(r.e, Object.keys(r.e.outs)[0]));
      assert.doesNotMatch(out, /newton-by-the-river/, `${name}: no match between the Newtons`);
      const l = loss(r, 'identity-denied');
      assert.equal(l?.count, 1, `${name}: ${JSON.stringify(lossKinds(r))}`);
      assert.match(l.message, /NOT the same/);
      assert.deepEqual(l.examples, [DISTINCT]);
      // The denial is not reported twice, as an ordinary denial too.
      assert.equal(loss(r, 'identity-bundle'), undefined);
    }
    // control: the same relation, standalone, is written, so the search above can see one
    const c = judgements();
    c.spatialEntities.find((e) => e['@id'] === HILL).identityRelations = [{ object: RIVER, identityType: 'exactMatch' }];
    const cr = await go([textFile(JSON.stringify(c), 'c.json')], 'convert', target);
    const out = target === 'tables' ? strFromU8(unzipSync(cr.e.outs['c-tables.zip'][0])['identities.csv']) : lpfLinks(outText(cr.e, 'c.geojson'));
    assert.match(out, /newton-by-the-river/, 'control');
  });

  test(`${target}: an asserted bundle is not split into standalone matches, and is reported`, async () => {
    const d = one(bundle({ names: [{ toponym: 'Pee' }] }));
    const r = await go([textFile(JSON.stringify(d), 'b.json')], 'convert', target);
    assert.deepEqual(errors(r), []);
    const l = loss(r, 'identity-bundle');
    assert.equal(l?.count, 1, JSON.stringify(lossKinds(r)));
    assert.match(l.message, /lose the source, date and certainty they share/);
    assert.deepEqual(l.examples, ['https://example.org/att/cluster']);
    assert.ok(!r.report.items.some((i) => i.kind === 'dropped' && /identities/.test(i.message)), 'reported once, in its own words');
    if (target === 'tables') {
      const zip = r.e.outs['b-tables.zip'][0];
      assert.deepEqual(sheet(zip, 'identities.csv'), []);
      assert.equal(sheet(zip, 'names.csv').filter((n) => n.name === 'Pee').length, 1, 'the name it also attests is written');
    } else {
      const fc = JSON.parse(outText(r.e, 'b.geojson'));
      assert.ok(!fc.features.some((f) => f.links?.length), JSON.stringify(fc.features.map((f) => f.links)));
      assert.ok(fc.features.some((f) => f.names?.some((n) => n.toponym === 'Pee')));
    }
    // A bundle alone is reported as that, not also as an attestation with no facet.
    const alone = await go([textFile(JSON.stringify(one(bundle())), 'a.json')], 'convert', target);
    assert.ok(loss(alone, 'identity-bundle'));
    assert.equal(loss(alone, 'attestation-without-facet'), undefined);
  });
}

test('tables: a denial that bundles identities with a facet is left out whole, not written as a denied facet', async () => {
  const d = one(bundle({ negated: true, types: [{ label: 'market' }] }));
  const r = await go([textFile(JSON.stringify(d), 'n.json')], 'convert', 'tables');
  const zip = r.e.outs['n-tables.zip'][0];
  // The empty sheets mean something only beside one that is not: the other place's name is written.
  assert.deepEqual(sheet(zip, 'names.csv').map((x) => [x.place_id, x.name]), [['q', 'Q']]);
  assert.deepEqual(sheet(zip, 'types.csv'), []);
  assert.deepEqual(sheet(zip, 'identities.csv'), []);
  assert.ok(loss(r, 'identity-denied'));
});

// ---- 2. a meta-attestation need not say what it is about -------------------------------------------
test("relation.ttl's meta-attestation (karakorum-dispute) checks clean, and is carried into JSON beside its target", async () => {
  const path = `${PLATO_REPO}/examples/relation.ttl`;
  const r = await go([file(path)], 'check', null);
  assert.deepEqual(errors(r), []);
  const c = await go([file(path)], 'convert', 'plato-json');
  const d = JSON.parse(outText(c.e, 'relation.json'));
  const atts = d.spatialEntities.find((e) => e['@id'].endsWith('/karakorum')).attestations;
  const dispute = atts.find((a) => a['@id'].endsWith('/karakorum-dispute'));
  assert.ok(dispute, JSON.stringify(atts.map((a) => a['@id'])));
  assert.equal(dispute.meta.targetAttestation, W + 'attestation/karakorum-capital');
  assert.ok(atts.some((a) => a['@id'].endsWith('/karakorum-capital')));
  // and the JSON it gives is valid
  const again = await go([textFile(outText(c.e, 'relation.json'), 'again.json')], 'check', null);
  assert.deepEqual(errors(again), []);
});
test('an ordinary attestation that does not say what it is about is still a problem', async () => {
  const ttl = `@prefix plato: <${P}> .
<https://example.org/att/a> a plato:Attestation ; plato:notes "about nothing" .
<https://example.org/att/m> a plato:Attestation ; plato:meta_attestation_about <https://example.org/att/b> .
<https://example.org/att/b> a plato:Attestation ; plato:attests_about <https://example.org/place/p> .
`;
  const r = await go([textFile(ttl, 'a.ttl')], 'check', null);
  const e = errors(r).filter((x) => x.kind === 'attestation-without-subject');
  assert.equal(e.length, 1, JSON.stringify(errors(r)));
  assert.deepEqual(e[0].examples, ['https://example.org/att/a'], 'the meta-attestation is not reported, the ordinary one is');
});

// ---- 3. a type's vocabulary and version -------------------------------------------------------------
const SCHEME = 'https://example.org/vocabularies/ecoregions';
const typed = () => one({ types: [{ label: 'Tropical moist forest', identifier: 'https://example.org/eco/1', scheme: SCHEME, schemeVersion: '2017' }] });

test('a type\'s scheme and version go to RDF (skos:inScheme, plato:scheme_version) and come back', async () => {
  const nt = await toNt(typed());
  const ts = triples(nt);
  assert.ok(ts.some((t) => t[1] === SKOS + 'inScheme' && t[2] === `<${SCHEME}>`), nt);
  assert.ok(ts.some((t) => t[1] === P + 'scheme_version' && t[2] === '"2017"'));
  const r = await go([textFile(nt, 't.nt')], 'convert', 'plato-json');
  assert.deepEqual([errors(r), lossKinds(r)], [[], []]);
  const ty = JSON.parse(outText(r.e, 't.json')).spatialEntities.find((e) => e['@id'].endsWith('/p')).attestations[0].types[0];
  assert.deepEqual(ty, typed().spatialEntities[0].attestations[0].types[0]);
});
test('a type\'s scheme and version go into the tables, which read them back', async () => {
  const r = await go([textFile(JSON.stringify(typed()), 't.json')], 'convert', 'tables');
  assert.equal(loss(r, 'dropped'), undefined, JSON.stringify(lossKinds(r)));
  const zip = r.e.outs['t-tables.zip'][0];
  const header = strFromU8(unzipSync(zip)['types.csv']).split(/\r?\n/)[0].split(',');
  assert.deepEqual(header.slice(header.indexOf('type_uri'), header.indexOf('type_uri') + 3), ['type_uri', 'type_scheme', 'type_scheme_version']);
  const [row] = sheet(zip, 'types.csv');
  assert.deepEqual([row.type_scheme, row.type_scheme_version], [SCHEME, '2017']);
  const back = await go([new File([zip], 't.zip')], 'convert', 'plato-jsonl');
  assert.deepEqual(errors(back), []);
  const ty = jsonl(back, 't.jsonl').flatMap((x) => x.attestations || []).find((a) => a.types)?.types[0];
  assert.deepEqual([ty.scheme, ty.schemeVersion], [SCHEME, '2017']);
});
test('tables with type_scheme and type_scheme_version filled in are valid, and read into JSON', async () => {
  const dir = 'test/fixtures/tables-routes';
  const types = readFileSync(`${dir}/types.csv`, 'utf8').replace(/^bunsty,hundred,,,,/m, `bunsty,hundred,,${SCHEME},2017,`);
  assert.match(types, /ecoregions,2017,/);
  const files = readdirSync(dir).filter((f) => f !== 'types.csv').map((f) => file(`${dir}/${f}`));
  const r = await go([...files, textFile(types, 'types.csv')], 'convert', 'plato-jsonl');
  assert.deepEqual(errors(r), []);
  const ty = jsonl(r, Object.keys(r.e.outs)[0]).flatMap((x) => x.attestations || []).flatMap((a) => a.types || []).find((t) => t.label === 'hundred');
  assert.deepEqual([ty.scheme, ty.schemeVersion], [SCHEME, '2017']);
  // control: a scheme that is not an address is refused, as rdf-tabular refuses it
  const bad = await go([...files, textFile(types.replace(SCHEME, 'not an address'), 'types.csv')], 'check', null);
  assert.ok(errors(bad).length, 'a bad type_scheme is a problem');
});
test('LPF has no scheme for a type: its vocabulary and version are reported, in words', async () => {
  for (const target of ['lpf', 'lpf-seq']) {
    const r = await go([textFile(JSON.stringify(typed()), 't.json')], 'convert', target);
    const msgs = r.report.items.filter((i) => i.severity === 'loss').map((i) => i.message).join('\n');
    assert.match(msgs, /The vocabulary a type comes from \(scheme\)/, msgs);
    assert.match(msgs, /The version of the vocabulary a type comes from \(schemeVersion\)/);
    const out = outText(r.e, Object.keys(r.e.outs)[0]);
    assert.match(out, /Tropical moist forest/, 'the type itself is written');
  }
});

// ---- 4. the four route and network kinds ----------------------------------------------------------------
test('the route and network kinds are concepts in plato:EntityKindScheme, and RDF naming them checks clean', async () => {
  const ttl = readFileSync('public/plato/ontology.ttl', 'utf8');
  for (const k of ['TypeRoute', 'TypeItinerary', 'TypeNetwork', 'TypeSegment']) {
    const block = ttl.split(/\n(?=plato:)/).find((b) => b.startsWith(`plato:${k}\n`) || b.startsWith(`plato:${k} `));
    assert.ok(block, k);
    assert.match(block, /a skos:Concept/, k);
    assert.match(block, /skos:inScheme plato:EntityKindScheme/, k);
    assert.doesNotMatch(block, /\ba plato:Type\b/, k);
  }
  const data = (kind) => `@prefix plato: <${P}> . @prefix skos: <${SKOS}> .
<https://example.org/doc> a plato:Gazetteer ; plato:contains_entity <https://example.org/place/r> .
<https://example.org/place/r> a plato:SpatialEntity .
<https://example.org/att/1> a plato:Attestation ; plato:attests_about <https://example.org/place/r> ; plato:attests_type <https://example.org/type/1> .
<https://example.org/type/1> a plato:Type ; plato:type_label "route" ; skos:broader plato:${kind} ; skos:inScheme plato:EntityKindScheme .
`;
  for (const k of ['TypeRoute', 'TypeItinerary', 'TypeNetwork', 'TypeSegment']) {
    const r = await go([textFile(data(k), 'k.ttl')], 'check', null);
    assert.deepEqual(errors(r).filter((e) => e.kind === 'undeclared-term'), [], k);
  }
  // control: a kind PLATO does not declare is caught
  const bad = await go([textFile(data('TypeCanal'), 'k.ttl')], 'check', null);
  assert.deepEqual(errors(bad).filter((e) => e.kind === 'undeclared-term').flatMap((e) => e.examples), [P + 'TypeCanal']);
});
