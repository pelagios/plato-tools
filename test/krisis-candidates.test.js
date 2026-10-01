import { PLATO_REPO } from './paths.js';
// Krisis's suggestions published as a PLATO candidate set (src/engine/krisis/candidates.js), and the
// answers that point back at them (promotedFrom, gazetteer.candidateSets; apply.js, identity.js).
//
// Every candidate set exported here is run through the vendored candidate-set schema and through the
// checker; every absence (no promotedFrom for "not this one", a candidate left out) has its presence
// beside it; and the minting rule is checked against PLATO's own example, with a hash forced to
// collide, as Agora's mint test does.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import jsonld from 'jsonld';
import { env, res, textFile, go, outText } from './engine.js';
import { detect } from '../src/engine/input.js';
import { DataError } from '../src/engine/input.js';
import { match } from '../src/engine/krisis/match.js';
import { readWork, serialiseWork, decide } from '../src/engine/krisis/work.js';
import { apply, headerWithSets } from '../src/engine/krisis/apply.js';
import { attestationsFrom } from '../src/engine/krisis/identity.js';
import { exportCandidates, asCandidate, hashText, candidateHash, jcs, prefixLengths, proposeSetIri, defaultBase, byCodePoint } from '../src/engine/krisis/candidates.js';
import { compare } from '../src/engine/compare.js';
import { Json2Rdf } from '../src/formats/json2rdf.js';
import { tripleNT } from '../src/lib/ntriples.js';
import { summary, groups, KRISIS_CANDIDATES } from '../src/engine/words.js';

const X = 'https://example.org/';
const src = { '@id': X + 'source/s', title: 'S', authorityType: 'source' };
const at = (lon, lat) => ({ geometries: [{ geojson: { type: 'Point', coordinates: [lon, lat] } }], sources: [src] });
const named = (...names) => ({ names: names.map((toponym) => ({ toponym })), sources: [src] });
const place = (ds, id, label, attestations) => ({ '@id': `${X}${ds}/${id}`, label, attestations });
const A = (id) => `${X}a/${id}`, B = (id) => `${X}b/${id}`;
const subjectsDoc = (gazetteer = { '@id': X + 'a', title: 'Dataset A' }) => ({
  profile: 'place-centric', gazetteer,
  spatialEntities: [
    place('a', 'newton', 'Newton', [named('Neuton'), at(-1.0, 52.0)]),
    place('a', 'sainte-mere-eglise', 'Sainte-Mère-Église', [at(-1.3163, 49.4083)]),
    place('a', 'springfield', 'Springfield', [at(-89.65, 39.8)]),
  ],
});
const othersDoc = () => ({
  profile: 'place-centric', gazetteer: { '@id': X + 'b', title: 'Dataset B' },
  spatialEntities: [
    place('b', 'newton', 'Newton', [at(-1.01, 52.01)]),
    place('b', 'sainte-mere', 'Sainte Mere Eglise', [at(-1.32, 49.41)]),
    place('b', 'springfeld', 'Springfeld', [at(-89.6, 39.78)]),
    place('b', 'neuton', 'Neuton', [named('Neuton')]),
  ],
});
const json = (d, name) => textFile(JSON.stringify(d), name);
const subjectsInput = (d = subjectsDoc()) => detect([json(d, 'a.json')]);
async function matched(s = subjectsDoc()) {
  const r = await match({ subjects: await subjectsInput(s), others: await detect([json(othersDoc(), 'b.json')]), options: { now: '2026-09-30T12:00:00Z' } }, env());
  return r.work;
}
const reviewer = { name: 'A. Reviewer', orcid: 'https://orcid.org/0000-0002-1825-0097' };
const idOf = (w, a, b) => w.candidates.find((c) => c.candidate_source === a && c.candidate_candidate === b).id;
function decideAll(w) {
  decide(w, idOf(w, A('newton'), B('newton')), 'match', { at: '2026-09-30T13:00:00Z' });
  decide(w, idOf(w, A('newton'), B('neuton')), 'match', { identityType: 'closeMatch', at: '2026-09-30T13:01:00Z' });
  decide(w, idOf(w, A('springfield'), B('springfeld')), 'not-this', { at: '2026-09-30T13:02:00Z' });
  decide(w, idOf(w, A('sainte-mere-eglise'), B('sainte-mere')), 'distinct', { basis: 'The hamlet in Manche, not the town.', at: '2026-09-30T13:03:00Z' });
  w.reviewer = reviewer;
  return w;
}
const V = res.validators['candidate-set'];
/** A candidate set is valid by the vendored profile, part by part, and by the checker, as a user would run it. */
async function assertValidSet(set) {
  const { candidates, ...head } = set;
  assert.ok(V.header(head), JSON.stringify(V.header.errors));
  for (const c of candidates) assert.ok(V.candidate(c), JSON.stringify(V.candidate.errors));
  const checked = await go([textFile(JSON.stringify(set), 'set.json')], 'check');
  assert.deepEqual([checked.input.profile, checked.report.errors], ['candidate-set', 0], JSON.stringify(checked.report.items));
  assert.equal(checked.report.counts.candidates, candidates.length);
}
const ISSUED = '2026-10-01';

// ---- the hash, the ids, the set's IRI ------------------------------------------------------------------
test("the hash is SHA-256 of the JCS array, and gives PLATO's own example ids", () => {
  const ex = JSON.parse(readFileSync(`${PLATO_REPO}/schemas/examples/candidate-set-judgements.json`, 'utf8'));
  for (const c of ex.candidates) {
    const text = hashText(c);
    assert.equal(text, JSON.stringify([c.subject, c.object, c.algorithmVersion, c.matchParameters]));
    assert.equal(candidateHash(text), createHash('sha256').update(text, 'utf8').digest('hex'));
    assert.equal(c['@id'], `${ex.candidateSet['@id']}#c-${candidateHash(text).slice(0, 8)}`);
  }
  // An absent matchParameters is hashed as "": the same as an empty string, never as the word null.
  assert.equal(hashText({ subject: 's', object: 'o', algorithmVersion: 'v' }), '["s","o","v",""]');
  // The array, not the fields joined: a line feed moved from one field to the next is another text.
  assert.notEqual(hashText({ subject: 's', object: 'o', algorithmVersion: 'v\nX', matchParameters: 'Y' }), hashText({ subject: 's', object: 'o', algorithmVersion: 'v', matchParameters: 'X\nY' }));
  // JCS: keys in order, no spaces, whatever order they were given in.
  assert.equal(jcs({ b: 1, a: [true, null, 'x'], c: { z: 0.5, y: 'é' } }), '{"a":[true,null,"x"],"b":1,"c":{"y":"é","z":0.5}}');
  assert.equal(jcs({ c: { y: 'é', z: 0.5 }, a: [true, null, 'x'], b: 1 }), jcs({ b: 1, a: [true, null, 'x'], c: { z: 0.5, y: 'é' } }));
  // Code point order, not UTF-16's: an astral letter sorts after U+FFFD.
  assert.deepEqual(['\u{1F600}', '�'].sort(byCodePoint), ['�', '\u{1F600}']);
  assert.deepEqual(['\u{1F600}', '�'].sort(), ['\u{1F600}', '�'], 'control: sort() alone orders them the other way');
});

test('ids: 8 digits, lengthened in steps of 4 where hashes begin alike, both of a colliding pair whatever their order, against earlier sets too', () => {
  const h = (p) => p + 'f'.repeat(64 - p.length);
  const a = h('3f04af4c0'), b = h('3f04af4c1'), c = h('12345678');
  assert.deepEqual(prefixLengths([a, b, c]), [12, 12, 8]);
  assert.deepEqual(prefixLengths([c, b, a]), [8, 12, 12]);
  // Against an earlier set's hash: only the newcomer lengthens (the earlier one is not minted again).
  assert.deepEqual(prefixLengths([a, c], [b]), [12, 8]);
  // Further: alike to 12 digits takes 16.
  assert.deepEqual(prefixLengths([h('aaaaaaaaaaaa0'), h('aaaaaaaaaaaa1')]), [16, 16]);
  // The same hash twice is one candidate, not two.
  assert.throws(() => prefixLengths([a, a]), /same hash/);
});

test("the set's IRI is proposed from the base, the date and the candidates' hash texts in code point order, and the base from the dataset's address", () => {
  assert.equal(defaultBase('https://ex.org/data/gaz'), 'https://ex.org/data/');
  assert.equal(defaultBase('https://ex.org/data/'), 'https://ex.org/data/');
  assert.equal(defaultBase('https://ex.org'), 'https://ex.org/');
  const texts = ['["b"]', '["a"]'];
  const want = createHash('sha256').update(JSON.stringify(['["a"]', '["b"]'])).digest('hex').slice(0, 8);
  assert.equal(proposeSetIri('https://ex.org/x', '2026-10-01', texts), `https://ex.org/x/candidates/2026-10-01-${want}`);
  assert.equal(proposeSetIri('https://ex.org/x/', '2026-10-01', [...texts].reverse()), `https://ex.org/x/candidates/2026-10-01-${want}`, 'in any order');
});

// ---- the export -------------------------------------------------------------------------------------------
test('an export is a valid candidate set: the header, every candidate under the set, status suggested, and each IRI stored in the work file', async () => {
  const w = decideAll(await matched());
  const before = serialiseWork(w);
  const { set, work, report, setIri, leftOut } = exportCandidates(w, { issued: ISSUED });
  assert.equal(serialiseWork(w), before, 'the work given is not changed');
  await assertValidSet(set);
  assert.equal(leftOut, 0);
  assert.match(setIri, /^https:\/\/example\.org\/candidates\/2026-10-01-[0-9a-f]{8}$/);
  assert.deepEqual({ ...set.candidateSet, title: undefined, description: undefined }, {
    '@id': setIri, title: undefined, description: undefined, creator: [{ '@id': reviewer.orcid, name: reviewer.name }], issued: ISSUED, candidatesFor: X + 'a',
  });
  assert.equal(set.candidateSet.title, 'Matches suggested for Dataset A in Dataset B, 2026-10-01');
  assert.match(set.candidateSet.description, /promotedFrom/);
  assert.equal(set.candidates.length, w.candidates.length);
  for (const c of set.candidates) {
    const from = w.candidates.find((x) => x.candidate_source === c.subject && x.candidate_candidate === c.object);
    assert.equal(c['@id'], `${setIri}#c-${candidateHash(hashText(c)).slice(0, 8)}`);
    assert.deepEqual([c.status, c.similarityScore, c.algorithmVersion, c.generatedAt], ['suggested', from.similarity_score, w.algorithm_version, w.generated_at]);
    assert.equal(c.matchParameters, jcs(w.match_parameters));
    // What is the work file's alone does not reach the set.
    assert.deepEqual(Object.keys(c).sort(), ['@id', 'algorithmVersion', 'generatedAt', 'matchParameters', 'object', 'similarityScore', 'status', 'subject']);
    assert.equal(work.candidates.find((x) => x.id === from.id).iri, c['@id'], 'stored in the work file');
  }
  // The decided candidates are suggested in the set all the same: the decisions go into attestations.
  assert.ok(w.candidates.some((c) => c.candidate_status === 'confirmed') && set.candidates.every((c) => c.status === 'suggested'));
  assert.deepEqual(work.candidate_sets, [{ '@id': setIri, issued: ISSUED, previous: [] }]);
  assert.deepEqual(readWork(serialiseWork(work)).candidate_sets, work.candidate_sets, 'the work file reads back');
  assert.deepEqual(report.items.map((i) => i.kind), ['work-file-only']);
  assert.equal(summary(report, 'candidates').counted, `It holds ${w.candidates.length} candidates.`);
  assert.equal(groups('candidates').length, 3);
  // Deterministic, in any order: the same set again, the candidates listed backwards.
  const again = exportCandidates({ ...w, candidates: [...w.candidates].reverse() }, { issued: ISSUED });
  assert.equal(again.setIri, setIri);
  assert.deepEqual(again.set.candidates.map((c) => c['@id']).sort(), set.candidates.map((c) => c['@id']).sort());
  // Overridable: the set's IRI given, without a fragment, mints under it; and a base given.
  const given = exportCandidates(w, { issued: ISSUED, setIri: 'https://ex.org/sets/one#x' });
  assert.equal(given.set.candidateSet['@id'], 'https://ex.org/sets/one');
  assert.ok(given.set.candidates.every((c) => c['@id'].startsWith('https://ex.org/sets/one#c-')));
  assert.ok(given.work.candidates.every((c) => c.iri.startsWith('https://ex.org/sets/one#c-')), 'each export overwrites the stored IRIs');
  assert.match(exportCandidates(w, { issued: ISSUED, base: 'https://ex.org/b' }).setIri, /^https:\/\/ex\.org\/b\/candidates\/2026-10-01-/);
});

test('an export refuses a dataset with no address, a bad date, and a review last exported against sets not given now', async () => {
  const none = await matched(subjectsDoc({ title: 'No address' }));
  assert.throws(() => exportCandidates(none, { issued: ISSUED }), (e) => e instanceof DataError && e.message === KRISIS_CANDIDATES.noDatasetIri);
  const w = await matched();
  assert.ok(exportCandidates(w, { issued: ISSUED }).set, 'control: with the address it exports');
  assert.throws(() => exportCandidates(w, { issued: '1 Oct 2026' }), DataError);
  const first = exportCandidates(w, { issued: ISSUED });
  const second = exportCandidates(first.work, { issued: '2026-10-02', previousSets: [first.set] });
  assert.equal(second.set, null);
  assert.deepEqual(second.work.candidate_sets, first.work.candidate_sets, 'nothing issued, nothing recorded');
  const recorded = { ...first.work, candidate_sets: [...first.work.candidate_sets, { '@id': 'https://example.org/candidates/x', issued: '2026-10-02', previous: [first.setIri] }] };
  assert.throws(() => exportCandidates(recorded, { issued: '2026-10-03' }), (e) => e instanceof DataError && e.message.includes(first.setIri));
  assert.ok(exportCandidates(recorded, { issued: '2026-10-03', previousSets: [first.set] }), 'control: given again, it exports');
  // An earlier set for another dataset is refused.
  const other = { ...first.set, candidateSet: { ...first.set.candidateSet, candidatesFor: 'https://example.org/z' } };
  assert.throws(() => exportCandidates(w, { issued: ISSUED, previousSets: [other] }), /another dataset/);
});

test('a later set leaves out the candidates an earlier set published, counts them, and stores their earlier IRIs, which never change', async () => {
  const w = await matched();
  // Set 1 publishes two of the four suggestions (an earlier, smaller run).
  const keep = (c) => c.candidate_source === A('newton');
  const one = exportCandidates({ ...w, candidates: w.candidates.filter(keep) }, { issued: '2026-09-30' });
  assert.equal(one.set.candidates.length, 2);
  await assertValidSet(one.set);
  const published = new Map(one.set.candidates.map((c) => [c.object, c['@id']]));
  // Set 2, from the full run, given set 1: those two are left out, the rest published.
  const two = exportCandidates(w, { issued: ISSUED, previousSets: [one.set] });
  await assertValidSet(two.set);
  assert.equal(two.leftOut, 2);
  assert.equal(two.report.counts.leftOut, 2);
  assert.deepEqual(two.set.candidates.map((c) => c.subject).sort(), [A('sainte-mere-eglise'), A('springfield')]);
  assert.ok(two.set.candidates.every((c) => c['@id'].startsWith(two.setIri + '#c-')));
  for (const c of two.work.candidates.filter(keep)) assert.equal(c.iri, published.get(c.candidate_candidate), 'its IRI is the earlier set\'s');
  assert.deepEqual(two.work.candidate_sets.at(-1).previous, [one.setIri]);
  // In words, on the page and the command line alike.
  assert.equal(KRISIS_CANDIDATES.leftOut(2), '2 candidates were already published in an earlier candidate set and are left out of this one; answers to them point at their earlier IRIs.');
  assert.equal(summary(two.report, 'candidates').counted, `It holds 2 candidates. ${KRISIS_CANDIDATES.leftOut(2)}`);
  // The control: without set 1, nothing is left out.
  assert.equal(exportCandidates(w, { issued: ISSUED }).leftOut, 0);
  // A rerun that scores an old pair differently, at another time: still the same candidate, still left out (the first score stands).
  const rescored = JSON.parse(JSON.stringify(w));
  for (const c of rescored.candidates.filter(keep)) { c.similarity_score = 0.9; c.generated_at = '2026-10-01T09:00:00Z'; }
  assert.equal(exportCandidates(rescored, { issued: ISSUED, previousSets: [one.set] }).leftOut, 2);
  // Other settings make another candidate: not left out.
  const resettled = { ...JSON.parse(JSON.stringify(w)), match_parameters: { ...w.match_parameters, threshold: 0.8 } };
  assert.equal(exportCandidates(resettled, { issued: ISSUED, previousSets: [one.set] }).leftOut, 0);
  // Set 3, given both, issues nothing: every candidate was published, and the report says so.
  const three = exportCandidates(two.work, { issued: '2026-10-02', previousSets: [one.set, two.set] });
  assert.equal(three.set, null);
  assert.equal(three.leftOut, 4);
  assert.deepEqual(three.report.items.map((i) => i.kind), ['all-left-out']);
  assert.equal(three.report.items[0].message, KRISIS_CANDIDATES.allLeftOut(4));
  assert.equal(summary(three.report, 'candidates').problems, 'No candidate set was written: every candidate was published already.');
  for (const c of three.work.candidates) assert.equal(c.iri, two.work.candidates.find((x) => x.id === c.id).iri, 'no IRI changes');
});

test('a forced collision lengthens both new candidates, whatever their order, and only the newcomer against an earlier set', async () => {
  const w = await matched();
  // A hash that makes the first two candidates' texts begin alike for 8 digits, as Agora's test injects one.
  const [t0, t1] = w.candidates.slice(0, 2).map((c) => hashText(asCandidate(w, c)));
  const hash = (t) => { const real = candidateHash(t); return t === t0 ? 'abcdef01' + '0' + real.slice(9) : t === t1 ? 'abcdef01' + '1' + real.slice(9) : real; };
  const x = exportCandidates(w, { issued: ISSUED, hash, setIri: 'https://ex.org/s' });
  await assertValidSet(x.set);
  const len = (iri) => iri.split('#c-')[1].length;
  const byText = new Map(x.set.candidates.map((c) => [hashText(c), c['@id']]));
  assert.deepEqual([len(byText.get(t0)), len(byText.get(t1))], [12, 12]);
  assert.ok([...byText].filter(([t]) => t !== t0 && t !== t1).every(([, iri]) => len(iri) === 8), 'the rest keep 8');
  assert.equal(x.report.counts.lengthened, 2);
  assert.match(summary(x.report, 'candidates').counted, /2 of which have a longer address/);
  const y = exportCandidates({ ...w, candidates: [...w.candidates].reverse() }, { issued: ISSUED, hash, setIri: 'https://ex.org/s' });
  assert.deepEqual(new Set(y.set.candidates.map((c) => c['@id'])), new Set(x.set.candidates.map((c) => c['@id'])), 'in either order');
  // Against an earlier set: the first is published with 8 digits alone, then the second, colliding, takes 12; the first's IRI is untouched.
  const first = w.candidates.find((c) => hashText(asCandidate(w, c)) === t0);
  const one = exportCandidates({ ...w, candidates: [first] }, { issued: '2026-09-30', hash, setIri: 'https://ex.org/s1' });
  assert.equal(len(one.set.candidates[0]['@id']), 8);
  const two = exportCandidates(w, { issued: ISSUED, hash, setIri: 'https://ex.org/s2', previousSets: [one.set] });
  const two1 = two.set.candidates.find((c) => hashText(c) === t1);
  assert.equal(len(two1['@id']), 12);
  assert.ok(!two.set.candidates.some((c) => hashText(c) === t0), 'the published one is left out');
  assert.equal(two.work.candidates.find((c) => c.id === first.id).iri, one.set.candidates[0]['@id'], 'and keeps its 8-digit IRI');
  // The control: without the earlier set, the second keeps 8 digits.
  const alone = exportCandidates({ ...w, candidates: w.candidates.filter((c) => c.id !== first.id) }, { issued: ISSUED, hash, setIri: 'https://ex.org/s2' });
  assert.equal(len(alone.set.candidates.find((c) => hashText(c) === t1)['@id']), 8);
});

test('an exported set is the same graph in JSON as jsonld.js makes of it, and comes back from N-Triples as it was', async () => {
  const { set } = exportCandidates(decideAll(await matched()), { issued: ISSUED });
  let nt = '';
  const w = new Json2Rdf(res.context, (s, p, o) => { nt += tripleNT(s, p, o); });
  const { candidates, ...head } = set;
  w.header(head);
  for (const c of candidates) w.record('candidates', c);
  const ref = await jsonld.toRDF({ ...set, '@context': res.context['@context'] }, { format: 'application/n-quads', safe: false });
  const lines = (t) => t.split('\n').map((l) => l.trim().replace(/_:\S+/g, '_:b')).filter(Boolean).sort();
  assert.ok(lines(ref).length > 8 * candidates.length, 'jsonld.js made the graph');
  assert.deepEqual(lines(nt), lines(ref));
  assert.ok(lines(nt).some((l) => l.includes('candidate_source')) && lines(nt).some((l) => l.includes('similarity_score') && l.includes('^^<http://www.w3.org/2001/XMLSchema#')), 'presence: candidates with typed scores');
  // And back: JSON -> N-Triples -> PLATO JSON gives the set again.
  const a = await go([textFile(JSON.stringify(set), 'set.json')], 'convert', 'ntriples');
  const b = await go([textFile(outText(a.e, 'set.nt'), 'set2.nt')], 'convert', 'plato-json');
  const back = JSON.parse(outText(b.e, 'set2.json'));
  const order = (d) => ({ ...d, candidates: [...d.candidates].sort((x, y) => (x['@id'] < y['@id'] ? -1 : 1)) });
  assert.deepEqual(order(back), order(set));
});

// ---- apply: promotedFrom and candidateSets ----------------------------------------------------------------
const relations = (doc) => doc.attestations.flatMap((a) => a.identities.map((i) => ({ ...i, negated: !!a.negated })));
test('apply: promotedFrom on every relation of an accepting attestation and on a denial, none for "not this one"; the attestations name the set', async () => {
  const w = decideAll(await matched());
  const { set, work } = exportCandidates(w, { issued: ISSUED });
  const iri = (b) => work.candidates.find((c) => c.candidate_candidate === b).iri;
  const e = env();
  const r = await apply({ subjects: await subjectsInput(), work: serialiseWork(work), options: { output: 'attestations', candidates: [set] } }, e);
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  const doc = JSON.parse(outText(e, 'a.krisis-attestations.json'));
  const rel = relations(doc);
  assert.deepEqual(rel.map((x) => [x.object, x.negated, x.promotedFrom]), [
    [B('newton'), false, iri(B('newton'))], [B('neuton'), false, iri(B('neuton'))], [B('sainte-mere'), true, iri(B('sainte-mere'))],
  ]);
  assert.ok(!JSON.stringify(doc).includes(iri(B('springfeld'))), 'absence: "not this one" answers nothing in the dataset');
  assert.deepEqual(doc.gazetteer.candidateSets, [set.candidateSet['@id']]);
  const checked = await go([textFile(JSON.stringify(doc), 'out.json')], 'check');
  assert.equal(checked.report.errors, 0, JSON.stringify(checked.report.items));
  // The report says to publish the set beside the dataset.
  const pub = r.report.items.find((i) => i.kind === 'publish-candidate-sets');
  assert.deepEqual([pub?.severity, pub?.examples], ['warning', [set.candidateSet['@id']]]);
  // The control: the same review never exported writes no promotedFrom and lists no set.
  const e2 = env();
  const plain = await apply({ subjects: await subjectsInput(), work: serialiseWork(w), options: { output: 'attestations' } }, e2);
  assert.equal(plain.report.errors, 0);
  const plainText = outText(e2, 'a.krisis-attestations.json');
  assert.ok(!plainText.includes('promotedFrom') && !plainText.includes('candidateSets'));
  // attestationsFrom alone carries them too.
  assert.ok(attestationsFrom(work).every((m) => m.attestation.identities.every((i) => i.promotedFrom)));
});

test('apply, the dataset: candidateSets in its gazetteer, promotedFrom on the answers, and the version check still finds only additions', async () => {
  const w = decideAll(await matched());
  const { set, work } = exportCandidates(w, { issued: ISSUED });
  const subjects = await subjectsInput();
  const e = env();
  const r = await apply({ subjects, work, options: { candidates: [set] } }, e);
  assert.ok(!r.incomplete, JSON.stringify(r.report.items));
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  const text = outText(e, 'a.krisis-dataset.json');
  const doc = JSON.parse(text);
  assert.deepEqual(doc.gazetteer, { ...subjectsDoc().gazetteer, candidateSets: [set.candidateSet['@id']] });
  const atts = doc.spatialEntities.flatMap((p) => p.attestations).filter((a) => a.identities);
  assert.equal(atts.length, 2);
  assert.ok(atts.every((a) => a.identities.every((i) => i.promotedFrom.startsWith(set.candidateSet['@id'] + '#c-'))));
  const checked = await go([textFile(text, 'out.json')], 'check');
  assert.equal(checked.report.errors, 0, JSON.stringify(checked.report.items));
  assert.deepEqual(r.report.counts.versionCheck, { earlier: 4, later: 6, unchanged: 4, changed: 0, lost: 0, added: 2 });
  // Its sets are merged with those the dataset lists already, each once.
  const listed = subjectsDoc({ '@id': X + 'a', title: 'Dataset A', candidateSets: ['https://example.org/candidates/older', set.candidateSet['@id']] });
  const e2 = env();
  const r2 = await apply({ subjects: await subjectsInput(listed), work, options: { candidates: [set] } }, e2);
  assert.equal(r2.report.errors, 0, JSON.stringify(r2.report.items));
  assert.deepEqual(JSON.parse(outText(e2, 'a.krisis-dataset.json')).gazetteer.candidateSets, ['https://example.org/candidates/older', set.candidateSet['@id']]);
  // The control: the review not exported leaves the gazetteer as it was.
  const e3 = env();
  await apply({ subjects, work: w, options: {} }, e3);
  assert.deepEqual(JSON.parse(outText(e3, 'a.krisis-dataset.json')).gazetteer, subjectsDoc().gazetteer);
});

test('the header is found however the text arrives, and a key inside a header value does not end it', () => {
  const head = { $schema: 's', gazetteer: { '@id': X + 'a', title: 'T "spatialEntities":[ in a title', note: { spatialEntities: [] } }, profile: 'place-centric' };
  const s = JSON.stringify(head);
  const text = s.slice(0, -1) + ',"spatialEntities":[{"@id":"p"}]}';
  const out = headerWithSets(text, ['https://ex.org/set']);
  assert.deepEqual(JSON.parse(out.text).gazetteer.candidateSets, ['https://ex.org/set']);
  assert.deepEqual(JSON.parse(out.text).spatialEntities, [{ '@id': 'p' }]);
  assert.equal(headerWithSets(text.slice(0, 40), ['x']), null, 'not all there yet');
  const noId = JSON.stringify({ gazetteer: { title: 'T' } }).slice(0, -1) + ',"spatialEntities":[]}';
  assert.deepEqual(headerWithSets(noId, ['x']), { text: noId, id: false });
});

test('apply answers a candidate left out of the latest set with its earlier IRI, lists both sets, and needs the earlier set given', async () => {
  const w = decideAll(await matched());
  const keep = (c) => c.candidate_source === A('newton');
  const one = exportCandidates({ ...w, candidates: w.candidates.filter(keep) }, { issued: '2026-09-30' });
  const two = exportCandidates(w, { issued: ISSUED, previousSets: [one.set] });
  const e = env();
  const r = await apply({ subjects: await subjectsInput(), work: two.work, options: { output: 'attestations', candidates: [two.set, one.set] } }, e);
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  const doc = JSON.parse(outText(e, 'a.krisis-attestations.json'));
  const rel = relations(doc);
  assert.ok(rel.filter((x) => !x.negated).every((x) => x.promotedFrom.startsWith(one.setIri + '#c-')), 'Newton\'s matches point into set 1');
  assert.ok(rel.find((x) => x.negated).promotedFrom.startsWith(two.setIri + '#c-'), 'the denial into set 2');
  assert.deepEqual(doc.gazetteer.candidateSets, [one.setIri, two.setIri]);
  // Without set 1 given, its IRIs are under neither the latest set nor a set given: refused, nothing written.
  const e2 = env();
  const n = await apply({ subjects: await subjectsInput(), work: two.work, options: { output: 'attestations', candidates: [two.set] } }, e2);
  assert.ok(n.incomplete);
  assert.deepEqual([...new Set(n.report.items.filter((i) => i.severity === 'error').map((i) => i.kind))], ['candidate-not-under-set']);
  assert.deepEqual(Object.keys(e2.outs), []);
});

test('apply refuses a stored IRI that is not under the latest exported set or a set given, and one a set given does not hold', async () => {
  const w = decideAll(await matched());
  const { set, work } = exportCandidates(w, { issued: ISSUED });
  const ok = await apply({ subjects: await subjectsInput(), work, options: { output: 'attestations' } }, env());
  assert.equal(ok.report.errors, 0, 'control: under the latest set, with no set given, it is written');
  // The set exported again under another IRI, but the work file kept from the first: its IRIs are not under the latest.
  const stale = JSON.parse(serialiseWork(work));
  stale.candidate_sets.push({ '@id': 'https://example.org/candidates/later', issued: '2026-10-02', previous: [] });
  const e = env();
  const r = await apply({ subjects: await subjectsInput(), work: stale, options: { output: 'attestations' } }, e);
  assert.ok(r.incomplete);
  assert.equal(r.report.items.find((i) => i.kind === 'candidate-not-under-set')?.message, KRISIS_CANDIDATES.notUnderSet);
  assert.deepEqual(Object.keys(e.outs), []);
  // Given as an earlier set, the first set's IRIs are allowed again.
  const allowed = await apply({ subjects: await subjectsInput(), work: stale, options: { output: 'attestations', candidates: [set] } }, env());
  assert.equal(allowed.report.errors, 0, JSON.stringify(allowed.report.items));
  // A stored IRI under a set given that the set does not hold: refused.
  const tampered = JSON.parse(serialiseWork(work));
  const t = tampered.candidates.find((c) => c.decision?.kind === 'match');
  t.iri = t.iri.replace(/#c-.*/, '#c-00000000');
  const r2 = await apply({ subjects: await subjectsInput(), work: tampered, options: { output: 'attestations', candidates: [set] } }, env());
  assert.deepEqual(r2.report.items.filter((i) => i.severity === 'error').map((i) => i.kind), ['candidate-not-in-set']);
  // A set given for another dataset, or not valid, is refused.
  const other = { ...set, candidateSet: { ...set.candidateSet, candidatesFor: 'https://example.org/z' } };
  const r3 = await apply({ subjects: await subjectsInput(), work, options: { output: 'attestations', candidates: [other] } }, env());
  assert.ok(r3.report.items.some((i) => i.kind === 'candidate-set-for-another'));
  const invalid = { ...set, candidates: set.candidates.map((c, i) => (i ? c : { ...c, status: 'confirmed' })) };
  const r4 = await apply({ subjects: await subjectsInput(), work, options: { output: 'attestations', candidates: [invalid] } }, env());
  assert.ok(r4.report.items.some((i) => i.kind === 'candidate-set-not-valid'));
  // readWork refuses a stored IRI that is not a candidate's at all.
  const badForm = JSON.parse(serialiseWork(work)); badForm.candidates[0].iri = 'https://example.org/x#a-12345678';
  assert.throws(() => readWork(badForm), /address in a candidate set/);
});

// ---- the command line ---------------------------------------------------------------------------------------
const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
test('the command line: candidates exports the set and stores the IRIs in the work file; apply --candidates writes promotedFrom; a later export leaves out and counts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plato-tools-krisis-candidates-')); made.push(dir);
  writeFileSync(join(dir, 'a.json'), JSON.stringify(subjectsDoc())); writeFileSync(join(dir, 'b.json'), JSON.stringify(othersDoc()));
  const m = cli('match', join(dir, 'a.json'), '--with', join(dir, 'b.json'), '--out', dir);
  assert.equal(m.code, 0, m.out + m.err);
  const workPath = join(dir, 'a.krisis.json');
  const w = decideAll(readWork(readFileSync(workPath, 'utf8')));
  writeFileSync(workPath, serialiseWork(w));
  const c = cli('candidates', workPath, '--base', 'https://example.org/pub/', '--out', dir);
  assert.equal(c.code, 0, c.out + c.err);
  assert.match(c.out, /The suggestions were exported as a candidate set\. It holds 4 candidates\./);
  assert.match(c.out, /Wrote .*a\.candidates\.json/);
  assert.match(c.out, /Stored each candidate's address in .*a\.krisis\.json/);
  const set = JSON.parse(readFileSync(join(dir, 'a.candidates.json'), 'utf8'));
  await assertValidSet(set);
  assert.match(set.candidateSet['@id'], /^https:\/\/example\.org\/pub\/candidates\/\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
  const stored = readWork(readFileSync(workPath, 'utf8'));
  assert.deepEqual(stored.candidates.map((x) => x.iri).sort(), set.candidates.map((x) => x['@id']).sort());
  // The engine makes the same set of the same work file.
  assert.deepEqual(exportCandidates(w, { base: 'https://example.org/pub/', issued: set.candidateSet.issued }).set, set);
  // An existing set is not replaced unasked.
  const again = cli('candidates', workPath, '--base', 'https://example.org/pub/', '--out', dir);
  assert.equal(again.code, 2, again.out + again.err);
  assert.match(again.out + again.err, /already exists/);
  // apply --candidates: promotedFrom in the attestations written.
  const a = cli('apply', join(dir, 'a.json'), '--review', workPath, '--output', 'attestations', '--candidates', join(dir, 'a.candidates.json'), '--out', dir, '--json');
  assert.equal(a.code, 0, a.out + a.err);
  const doc = JSON.parse(readFileSync(join(dir, 'a.krisis-attestations.json'), 'utf8'));
  assert.equal(relations(doc).filter((x) => x.promotedFrom).length, 3);
  assert.deepEqual(doc.gazetteer.candidateSets, [set.candidateSet['@id']]);
  // The sets given with --candidates are read and checked: one for another dataset is refused, and nothing written.
  writeFileSync(join(dir, 'other.json'), JSON.stringify({ ...set, candidateSet: { ...set.candidateSet, candidatesFor: 'https://example.org/z' } }));
  const refused = cli('apply', join(dir, 'a.json'), '--review', workPath, '--output', 'attestations', '--candidates', join(dir, 'other.json'), '--out', join(dir, 'refused'), '--json');
  assert.equal(refused.code, 2, refused.out + refused.err);
  assert.ok(JSON.parse(refused.out).items.some((i) => i.kind === 'candidate-set-for-another'), refused.out);
  assert.ok(!existsSync(join(dir, 'refused', 'a.krisis-attestations.json')));
  // A later export given the first: everything left out, nothing written, and said so; exit 0.
  const later = cli('candidates', workPath, '--previous-candidates', join(dir, 'a.candidates.json'), '--out', join(dir, 'later'));
  assert.equal(later.code, 0, later.out + later.err);
  assert.match(later.out, /No candidate set was written: every candidate was published already\. 4 candidates were already published/);
  assert.ok(!existsSync(join(dir, 'later', 'a.candidates.json')));
  // Wrong commands exit 2: no work file; --previous-candidates on another command.
  assert.equal(cli('candidates').code, 2);
  assert.equal(cli('check', join(dir, 'a.json'), '--previous-candidates', 'x').code, 2);
  const help = cli('--help');
  assert.match(help.out, /plato-tools candidates \[options\] WORKFILE/);
  assert.match(help.out, /--candidates SET/);
});
