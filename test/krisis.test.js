import { PLATO_REPO } from './paths.js';
// Krisis, the match review (src/engine/krisis/): suggestions of places in two datasets that may be
// the same, a work file that keeps the reviewer's decisions, and the PLATO attestations they make.
//
// Each absence here has a presence beside it: a pair that is not suggested is shown beside one that
// is, or with the one setting that removed it changed back, so that a matcher that suggested nothing
// at all could not pass. Every attestation made is run through PLATO's JSON Schema, and the finished
// document through the checker, with a control that the checker fails a broken one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { env, res, file, textFile, go, outText } from './engine.js';
import { detect } from '../src/engine/input.js';
import { normalise, similarity, jaroWinkler, trigrams } from '../src/engine/krisis/names.js';
import { Sha256, fileSha256 } from '../src/engine/krisis/digest.js';
import { match, distanceKm, representativePoint, DEFAULTS } from '../src/engine/krisis/match.js';
import { readWork, serialiseWork, decide, reviewProgress, reviewPlaces, candidatesOf, isReviewed, filesDiffer } from '../src/engine/krisis/work.js';
import { recordIdentity, attestationsFrom } from '../src/engine/krisis/identity.js';
import { apply } from '../src/engine/krisis/apply.js';
import { summary, groups, progressText, reviewProgressText } from '../src/engine/words.js';

const X = 'https://example.org/';
const JUDGEMENTS = `${PLATO_REPO}/schemas/examples/place-centric-judgements.json`;
const src = { '@id': X + 'source/s', title: 'S', authorityType: 'source' };
const at = (lon, lat) => ({ geometries: [{ geojson: { type: 'Point', coordinates: [lon, lat] } }], sources: [src] });
const named = (...names) => ({ names: names.map((toponym) => ({ toponym })), sources: [src] });
const place = (ds, id, label, attestations, more = {}) => ({ '@id': `${X}${ds}/${id}`, label, attestations, ...more });
const A = (id) => `${X}a/${id}`, B = (id) => `${X}b/${id}`;

/** The places to match. */
const subjectsDoc = () => ({
  profile: 'place-centric', gazetteer: { '@id': X + 'a', title: 'Dataset A' },
  spatialEntities: [
    place('a', 'newton', 'Newton', [named('Neuton'), at(-1.0, 52.0)]),
    place('a', 'sainte-mere-eglise', 'Sainte-Mère-Église', [at(-1.3163, 49.4083)]),
    place('a', 'springfield', 'Springfield', [at(-89.65, 39.8)]),
    // Already linked by the dataset itself: not suggested again.
    place('a', 'kingsbury', 'Kingsbury', [at(-0.28, 51.58)], { identityRelations: [{ object: B('kingsbury'), identityType: 'exactMatch' }] }),
    place('a', 'zanzibar', 'Zanzibar', [at(39.2, -6.16)]),
    // No address: it cannot be matched.
    { label: 'Nowhere', attestations: [at(0, 51)] },
  ],
});
/** The other dataset. */
const othersDoc = () => ({
  profile: 'place-centric', gazetteer: { '@id': X + 'b', title: 'Dataset B' },
  spatialEntities: [
    place('b', 'newton', 'Newton', [at(-1.01, 52.01)]),
    place('b', 'newton-far', 'Newton', [at(-3.0, 55.0)]),
    place('b', 'sainte-mere', 'Sainte Mere Eglise', [at(-1.32, 49.41)]),
    place('b', 'springfield-ma', 'Springfield', [at(-72.59, 42.1)]),
    place('b', 'springfeld', 'Springfeld', [at(-89.6, 39.78)]),
    place('b', 'kingsbury', 'Kingsbury', [at(-0.281, 51.581)]),
    place('b', 'neuton', 'Neuton', [named('Neuton')]),
  ],
});
const json = (d, name) => textFile(JSON.stringify(d), name);
const inputs = async (s = subjectsDoc(), o = othersDoc()) => ({ subjects: await detect([json(s, 'a.json')]), others: await detect([json(o, 'b.json')]) });
async function run(options = {}, s, o) {
  const e = env();
  const r = await match({ ...(await inputs(s, o)), options: { now: '2026-09-30T12:00:00Z', ...options } }, e);
  return { ...r, e };
}
const pairs = (work) => work.candidates.map((c) => `${c.candidate_source} ${c.candidate_candidate}`).sort();
const has = (work, a, b) => pairs(work).includes(`${a} ${b}`);

// ---- names ------------------------------------------------------------------------------------------
test('names are normalised: accents, punctuation and letters that do not decompose', () => {
  assert.equal(normalise('Sainte-Mère-Église'), 'sainte mere eglise');
  assert.equal(normalise('  Ōsaka  '), 'osaka');
  assert.equal(normalise('Straße'), 'strasse');
  assert.equal(normalise('Łódź'), 'lodz');
  assert.equal(normalise("St. Mary's, (Upper)"), 'st mary s upper');
  assert.equal(normalise(undefined), '');
});
test('Jaro-Winkler gives the published values, and word order does not count against a name', () => {
  // Winkler's own examples.
  assert.equal(jaroWinkler('martha', 'marhta').toFixed(3), '0.961');
  assert.equal(jaroWinkler('dwayne', 'duane').toFixed(3), '0.840');
  assert.equal(jaroWinkler('dixon', 'dicksonx').toFixed(3), '0.813');
  assert.equal(similarity('Sainte-Mère-Église', 'Sainte Mere Eglise'), 1);
  assert.equal(similarity('Upper Newton', 'Newton Upper'), 1);
  assert.ok(jaroWinkler('upper newton', 'newton upper') < 0.85, 'control: as written, the reordered name scores low');
  assert.ok(similarity('Newton', 'Neuton') >= 0.85);
  assert.ok(similarity('Newton', 'Zanzibar') < 0.5, 'control: unlike names score low');
  assert.equal(similarity('', 'Newton'), 0);
  assert.deepEqual([...trigrams('ely')], ['  e', ' el', 'ely', 'ly ']);
});

// ---- the digest -------------------------------------------------------------------------------------
test('the streamed SHA-256 gives the digests Node gives, whatever the chunks', async () => {
  const node = (b) => createHash('sha256').update(b).digest('hex');
  for (const n of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1000, 70000]) {
    const b = randomBytes(n);
    const h = new Sha256();
    for (let i = 0; i < n;) { const k = 1 + ((i * 7) % 97); h.update(b.subarray(i, i + k)); i += k; }
    assert.equal(h.hex(), node(b), `length ${n}`);
    assert.equal(await fileSha256(new File([b], 'x')), node(b));
  }
  assert.notEqual(await fileSha256(new File(['a'], 'x')), await fileSha256(new File(['b'], 'x')));
});

// ---- points and distances ------------------------------------------------------------------------------
test('a place\'s point: its first Point, else the centre of a bounding box or shape, else none', () => {
  assert.deepEqual(representativePoint({ attestations: [named('x'), at(1, 2), at(3, 4)] }), [1, 2]);
  assert.deepEqual(representativePoint({ attestations: [{ geometries: [{ bbox: [0, 0, 2, 4] }] }] }), [1, 2]);
  assert.deepEqual(representativePoint({ attestations: [{ geometries: [{ geojson: { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 2], [0, 0]]] } }] }] }), [2, 1]);
  assert.deepEqual(representativePoint({ attestations: [{ geometries: [{ bbox: [9, 9, 9, 9] }, { reprPoint: [5, 6] }] }] }), [5, 6], 'a point comes before a box');
  assert.equal(representativePoint({ attestations: [named('x')] }), null);
  assert.equal(Math.round(distanceKm([-0.1276, 51.5072], [2.3522, 48.8566])), 344, 'London to Paris');
});

// ---- matching -------------------------------------------------------------------------------------------
test('matching suggests the near namesakes, the accented and the misspelt, and not the far namesakes', async () => {
  const { report, work, outputs, e } = await run();
  assert.deepEqual(pairs(work), [
    `${A('newton')} ${B('neuton')}`, `${A('newton')} ${B('newton')}`,
    `${A('sainte-mere-eglise')} ${B('sainte-mere')}`, `${A('springfield')} ${B('springfeld')}`,
  ].sort());
  // The absences, beside the presences above: the same names, far away.
  assert.ok(!has(work, A('newton'), B('newton-far')));
  assert.ok(!has(work, A('springfield'), B('springfield-ma')));
  assert.equal(report.counts.tooFar, 2);
  // The pair the dataset already links is not suggested, and is counted.
  assert.ok(!has(work, A('kingsbury'), B('kingsbury')));
  assert.equal(report.counts.linked, 1);
  assert.deepEqual([report.counts.subjects, report.counts.others, report.counts.candidates, report.counts.suggestedFor], [5, 7, 4, 3]);
  // The place with no address is a problem, named by its label.
  const noAddress = report.items.find((i) => i.kind === 'no-address');
  assert.equal(noAddress.severity, 'error');
  assert.deepEqual(noAddress.examples, ['Nowhere']);
  assert.equal(report.counts.unaddressed, 1);
  // What each candidate says: the near one has a distance, the one with no point none.
  const near = work.candidates.find((c) => c.candidate_candidate === B('newton'));
  assert.equal(near.similarity_score, 1);
  assert.ok(near.distance_km > 1 && near.distance_km < 2, String(near.distance_km));
  assert.equal(work.candidates.find((c) => c.candidate_candidate === B('neuton')).distance_km, null);
  assert.deepEqual(near.other, { label: 'Newton', names: ['Newton'], point: [-1.01, 52.01], source: { title: 'Dataset B', uri: X + 'b' } });
  assert.equal(near.candidate_status, 'suggested');
  assert.equal(near.decision, null);
  // The work file is written as an output, and reads back as what was returned.
  assert.deepEqual(outputs.map((o) => o.name), ['a.krisis.json']);
  assert.deepEqual(readWork(outText(e, 'a.krisis.json')), work);
  assert.deepEqual(Object.keys(work.places), [A('newton'), A('sainte-mere-eglise'), A('springfield')]);
  assert.deepEqual(work.places[A('newton')], { label: 'Newton', names: ['Newton', 'Neuton'], point: [-1, 52] });
  assert.equal(work.subjects.title, 'Dataset A');
  assert.equal(work.subjects.uri, X + 'a');
  assert.match(work.subjects.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual({ ...work.match_parameters, scoring: undefined, blocking: undefined }, { ...DEFAULTS, scoring: undefined, blocking: undefined });
  assert.match(work.match_parameters.scoring, /Jaro-Winkler/);
  // In words.
  const s = summary(report, 'match');
  assert.equal(s.problems, '1 problem found.');
  assert.match(s.counted, /^Compared 5 places with 7 places of the other dataset; 3 places have suggestions\. Not suggested: 1 pair already linked; 2 pairs alike in name but further apart/);
  assert.equal(groups('match').length, 2);
});
test('control: with no greatest distance to speak of, the far namesakes are suggested too', async () => {
  const { work, report } = await run({ maxDistanceKm: 20000 });
  assert.ok(has(work, A('newton'), B('newton-far')));
  assert.ok(has(work, A('springfield'), B('springfield-ma')));
  assert.equal(report.counts.tooFar, 0);
});
test('control: the dataset\'s own link, taken away, lets the pair be suggested', async () => {
  const s = subjectsDoc();
  delete s.spatialEntities[3].identityRelations;
  const { work, report } = await run({}, s);
  assert.ok(has(work, A('kingsbury'), B('kingsbury')));
  assert.equal(report.counts.linked, 0);
});
test('the threshold and top K are kept to', async () => {
  const strict = await run({ threshold: 0.99 });
  assert.ok(!has(strict.work, A('springfield'), B('springfeld')), 'Springfeld scores under 0.99');
  assert.ok(has(strict.work, A('newton'), B('newton')), 'control: an exact name still scores 1');
  const one = await run({ topK: 1 });
  assert.equal(one.work.candidates.filter((c) => c.candidate_source === A('newton')).length, 1);
  assert.equal(one.work.candidates.find((c) => c.candidate_source === A('newton')).candidate_candidate, B('newton'), 'the best is kept: the same score, and nearer');
  await assert.rejects(run({ threshold: 2 }), /threshold/);
  await assert.rejects(run({ topK: 0 }), /whole number/);
});
test('a link another attestation withdrew no longer holds', async () => {
  const s = subjectsDoc();
  s.spatialEntities[3] = place('a', 'kingsbury', 'Kingsbury', [at(-0.28, 51.58),
    { '@id': A('kingsbury#link'), identities: [{ subject: A('kingsbury'), object: B('kingsbury'), identityType: 'exactMatch' }], sources: [src] }]);
  const linked = await run({}, s);
  assert.ok(!has(linked.work, A('kingsbury'), B('kingsbury')), 'control: the bundled link is honoured');
  s.spatialEntities[3].attestations.push({ '@id': A('kingsbury#retract'), meta: { targetAttestation: A('kingsbury#link'), metaType: 'https://w3id.org/plato#Retracts' }, sources: [src] });
  const retracted = await run({}, s);
  assert.ok(has(retracted.work, A('kingsbury'), B('kingsbury')));
});
test("PLATO's judgements example matched with itself: the Newtons it says are different places are not suggested", async () => {
  const e = env();
  const r = await match({ subjects: await detect([file(JUDGEMENTS)]), others: await detect([file(JUDGEMENTS)]), options: {} }, e);
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  assert.equal(r.report.counts.subjects, 6);
  assert.equal(r.report.counts.judgedDifferent, 1);
  assert.deepEqual(r.work.candidates, []);
  // Control: without the denial, the two Newtons (both Neuton) are suggested, once, not both ways.
  const doc = JSON.parse(readFileSync(JUDGEMENTS, 'utf8'));
  for (const p of doc.spatialEntities) p.attestations = p.attestations.filter((a) => !(a.negated && a.identities));
  const c = await match({ subjects: await detect([json(doc, 'j.json')]), others: await detect([json(doc, 'j.json')]), options: {} }, env());
  assert.equal(c.report.counts.judgedDifferent, 0);
  assert.deepEqual(c.work.candidates.map((x) => [x.candidate_source, x.candidate_candidate].map((i) => i.split('/').pop()).sort()), [['newton-by-the-river', 'newton-on-the-hill']]);
});
test('every input format is matched alike: the other dataset as Linked Places Format, the subjects as spreadsheet tables', async () => {
  const plain = await run();
  // The other dataset converted to LPF: the same suggestions.
  const lpf = await go([json(othersDoc(), 'b.json')], 'convert', 'lpf');
  const lpfText = outText(lpf.e, 'b.geojson');
  assert.match(lpfText, /"type":"FeatureCollection"/);
  const viaLpf = await match({ subjects: (await inputs()).subjects, others: await detect([textFile(lpfText, 'b.geojson')]), options: {} }, env());
  assert.equal(viaLpf.report.counts.others, 7);
  assert.deepEqual(pairs(viaLpf.work), pairs(plain.work));
  // The subjects as tables (the place without an address left out: the tables give every place one).
  const s = subjectsDoc(); s.spatialEntities.pop();
  const tables = await go([json(s, 'a.json')], 'convert', 'tables');
  const zip = new File(tables.e.outs['a-tables.zip'], 'a-tables.zip');
  const subjects = await detect([zip]);
  assert.equal(subjects.format, 'tables');
  const viaTables = await match({ subjects, others: (await inputs()).others, options: { base: X + 'a/' } }, env());
  assert.equal(viaTables.report.counts.subjects, 5);
  assert.deepEqual(viaTables.work.candidates.map((c) => c.candidate_candidate).sort(), plain.work.candidates.map((c) => c.candidate_candidate).sort());
});

// ---- the work file ---------------------------------------------------------------------------------------
test('decisions: each sets its status, and a place counts as reviewed once any of its candidates is decided', async () => {
  const { work } = await run();
  const [first] = candidatesOf(work, A('newton'));
  assert.equal(first.candidate_candidate, B('newton'));
  assert.deepEqual(reviewProgress(work), { reviewed: 0, total: 3 });
  assert.equal(reviewProgressText(reviewProgress(work)), '0 of 3 places reviewed');
  decide(work, first.id, 'match', { at: '2026-09-30T13:00:00Z' });
  assert.equal(first.candidate_status, 'confirmed');
  assert.ok(isReviewed(work, A('newton')));
  assert.ok(!isReviewed(work, A('springfield')), 'control: an undecided place is not reviewed');
  assert.deepEqual(reviewProgress(work), { reviewed: 1, total: 3 });
  const spring = candidatesOf(work, A('springfield'))[0];
  decide(work, spring.id, 'not-this');
  assert.equal(spring.candidate_status, 'rejected');
  assert.equal(spring.decision.identityType, undefined);
  assert.throws(() => decide(work, spring.id, 'distinct'), /basis/);
  decide(work, spring.id, null);
  assert.equal(spring.candidate_status, 'suggested');
  assert.deepEqual(reviewPlaces(work), Object.keys(work.places));
  assert.deepEqual(readWork(serialiseWork(work)), work, 'a work file with decisions reads back');
});
test('a work file that no review could have written is refused, saying why; the file it was made from is not', async () => {
  const { work } = await run();
  const text = serialiseWork(work);
  assert.ok(readWork(text), 'control: the file as written reads');
  const tamper = (edit) => { const w = JSON.parse(text); edit(w); return JSON.stringify(w); };
  const refused = (t, re) => assert.throws(() => readWork(t), (e) => e.name === 'DataError' && re.test(e.message), re);
  refused('{ not json', /not JSON/);
  refused('{}', /no "krisis" version/);
  refused(tamper((w) => { w.krisis = 2; }), /later version of the tools/);
  refused(tamper((w) => { w.candidates[0].candidate_status = 'confirmed'; }), /confirmed, but no decision/);
  refused(tamper((w) => { w.candidates[0].decision = { kind: 'match', identityType: 'exactMatch', decided_at: 'x' }; }), /suggested, which disagrees/);
  refused(tamper((w) => { w.candidates[0].candidate_status = 'rejected'; w.candidates[0].decision = { kind: 'distinct', identityType: 'exactMatch', decided_at: 'x' }; }), /without saying why/);
  refused(tamper((w) => { w.candidates[0].candidate_source = X + 'elsewhere'; }), /a place the file does not list/);
  refused(tamper((w) => { w.candidates[1].id = w.candidates[0].id; }), /two candidates have the id/);
  refused(tamper((w) => { w.candidates[0].similarity_score = 1.5; }), /between 0 and 1/);
  refused(tamper((w) => { w.candidates[0].candidate_candidate = w.candidates[0].candidate_source; }), /same as itself/);
  refused(tamper((w) => { w.subjects.files[0].sha256 = 'abc'; }), /SHA-256/);
  refused(tamper((w) => { w.reviewer = { name: 'R', orcid: '0000-0001' }; }), /ORCID/);
});
test('resuming: the files a review was made of are recognised, and changed ones named', async () => {
  const { work } = await run();
  assert.deepEqual(await filesDiffer(work.subjects, [json(subjectsDoc(), 'renamed.json')]), [], 'the same bytes, under any name');
  const s = subjectsDoc(); s.spatialEntities[0].label = 'Newtown';
  assert.deepEqual(await filesDiffer(work.subjects, [json(s, 'a.json')]), ['a.json', 'a.json']);
});

// ---- the attestations -------------------------------------------------------------------------------------
const V = res.validators;
// A place-centric document holds attestations under their places, so one is checked under a place.
const valid = (a, profile = 'place-centric') => {
  const [f, x] = profile === 'place-centric' ? [V[profile].entity, { '@id': A('p'), label: 'P', attestations: [a] }] : [V[profile].attestation, a];
  assert.ok(f(x), JSON.stringify(f.errors));
};
const reviewer = { name: 'A. Reviewer', orcid: 'https://orcid.org/0000-0002-1825-0097' };
test('recordIdentity: one attestation bundling a relation to each target, valid PLATO, with no @id', () => {
  const a = recordIdentity({ subject: A('newton'), targets: [{ iri: B('newton'), label: 'Newton' }, { iri: B('neuton'), identityType: 'closeMatch', certainty: 0.8, basis: 'same parish' }],
    source: { title: 'Dataset B', '@id': X + 'b', authorityType: 'dataset' }, reviewer, date: '2026-09-30T12:00:00Z', notes: ' n ' });
  assert.deepEqual(a, {
    contributor: reviewer, created: '2026-09-30T12:00:00Z',
    identities: [{ subject: A('newton'), object: B('newton'), identityType: 'exactMatch' }, { subject: A('newton'), object: B('neuton'), identityType: 'closeMatch', certainty: 0.8, basis: 'same parish' }],
    citations: [{ source: { title: 'Dataset B', '@id': X + 'b', authorityType: 'dataset' } }], notes: 'n',
  });
  valid(a); valid({ about: A('newton'), ...a }, 'attestation-centric');
  const denied = recordIdentity({ subject: A('newton'), targets: [{ iri: B('newton-far'), basis: 'different county' }], reviewer: { name: 'R' }, date: '2026-09-30T12:00:00Z', negated: true });
  assert.equal(denied.negated, true);
  valid(denied);
  // Control: the validator does fail an attestation that is not valid.
  assert.throws(() => valid({ ...a, identities: [{ subject: A('newton'), object: B('newton'), identityType: 'sameish' }] }), /identityType|enum|allowed/);
  assert.throws(() => valid({ ...a, promotedFrom: X + 'c1' }), /additional/);
});
test('recordIdentity refuses what PLATO cannot say: a denial of two, or of a close match; a place matched with itself', () => {
  const base = { subject: A('newton'), reviewer: { name: 'R' }, date: '2026-09-30T12:00:00Z' };
  assert.ok(recordIdentity({ ...base, targets: [{ iri: B('newton') }], negated: true }), 'control: a denial of one exact match is recorded');
  assert.throws(() => recordIdentity({ ...base, targets: [{ iri: B('newton') }, { iri: B('neuton') }], negated: true }), /exactly one target/);
  assert.throws(() => recordIdentity({ ...base, targets: [{ iri: B('newton'), identityType: 'closeMatch' }], negated: true }), /exactMatch/);
  assert.throws(() => recordIdentity({ ...base, targets: [{ iri: A('newton') }] }), /itself/);
  assert.throws(() => recordIdentity({ ...base, targets: [{ iri: B('newton') }, { iri: B('newton') }] }), /twice/);
  assert.throws(() => recordIdentity({ ...base, targets: [] }), /at least one/);
  assert.throws(() => recordIdentity({ ...base, targets: [{ iri: B('newton') }], date: '30 Sept' }), /date-time/);
  assert.throws(() => recordIdentity({ ...base, targets: [{ iri: B('newton') }], reviewer: { name: '' } }), /name/);
});

/** A review of the fixtures: Newton matched with two places, Springfield not this one, Sainte-Mère-Église different. */
async function reviewed() {
  const r = await run();
  const w = r.work;
  const id = (a, b) => w.candidates.find((c) => c.candidate_source === a && c.candidate_candidate === b).id;
  decide(w, id(A('newton'), B('newton')), 'match', { at: '2026-09-30T13:00:00Z' });
  decide(w, id(A('newton'), B('neuton')), 'match', { identityType: 'closeMatch', at: '2026-09-30T13:01:00Z' });
  decide(w, id(A('springfield'), B('springfeld')), 'not-this', { at: '2026-09-30T13:02:00Z' });
  decide(w, id(A('sainte-mere-eglise'), B('sainte-mere')), 'distinct', { basis: 'The other is the hamlet of that name in Manche, not the town.', at: '2026-09-30T13:03:00Z' });
  w.reviewer = reviewer;
  return w;
}
test('attestationsFrom: one attestation per place for its matches, one per denial, nothing for "not this one"', async () => {
  const w = await reviewed();
  const made = attestationsFrom(w);
  assert.deepEqual(made.map((m) => [m.subject, m.attestation.negated || false, m.attestation.identities.map((i) => `${i.object} ${i.identityType}`)]), [
    [A('newton'), false, [`${B('newton')} exactMatch`, `${B('neuton')} closeMatch`]],
    [A('sainte-mere-eglise'), true, [`${B('sainte-mere')} exactMatch`]],
  ]);
  assert.equal(made[0].attestation.created, '2026-09-30T13:01:00Z', 'dated by its last decision');
  assert.equal(made[1].attestation.identities[0].basis, 'The other is the hamlet of that name in Manche, not the town.');
  assert.deepEqual(made[0].attestation.citations, [{ source: { title: 'Dataset B', authorityType: 'dataset', '@id': X + 'b' } }]);
  assert.match(made[0].attestation.notes, /Krisis/);
  for (const m of made) { valid(m.attestation); assert.equal(m.attestation['@id'], undefined); }
  assert.doesNotMatch(JSON.stringify(made), /promotedFrom|#a-/);
});
test('apply: the new attestations only, an attestation-centric PLATO document the checker passes', async () => {
  const w = await reviewed();
  const e = env();
  const r = await apply({ subjects: (await inputs()).subjects, work: serialiseWork(w), options: { output: 'attestations' } }, e);
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  assert.deepEqual(r.report.items, [], 'the files are the ones reviewed: no warning');
  assert.deepEqual(r.outputs.map((o) => o.name), ['a.krisis-attestations.json']);
  const text = outText(e, 'a.krisis-attestations.json');
  const doc = JSON.parse(text);
  assert.equal(doc.profile, 'attestation-centric');
  assert.deepEqual(doc.gazetteer, { '@id': X + 'a', title: 'Dataset A' });
  assert.deepEqual(doc.attestations.map((a) => a.about), [A('newton'), A('sainte-mere-eglise')]);
  // The checker, as a user would run it on the file.
  const checked = await go([textFile(text, 'out.json')], 'check');
  assert.equal(checked.input.profile, 'attestation-centric');
  assert.equal(checked.report.errors, 0, JSON.stringify(checked.report.items));
  assert.equal(checked.report.counts.attestations, 2);
  // Control: the checker fails the same file with an attestation that says what it is about taken out.
  const broken = JSON.parse(text); delete broken.attestations[0].about;
  const failed = await go([textFile(JSON.stringify(broken), 'out.json')], 'check');
  assert.ok(failed.report.errors > 0, 'the checker can fail it');
  // In words.
  assert.equal(summary(r.report, 'apply').counted, 'Made 2 new attestations: 1 accepting 2 matches, 1 saying that two places are different.');
});
test('apply warns when the dataset is not the one reviewed, and says nothing when it is', async () => {
  const w = await reviewed();
  const s = subjectsDoc(); s.spatialEntities[0].label = 'Newtown';
  const r = await apply({ subjects: await detect([json(s, 'a.json')]), work: w, options: {} }, env());
  assert.deepEqual(r.report.items.map((i) => i.kind), ['subjects-differ']);
  assert.equal(r.outputs.length, 1, 'a warning, not a refusal');
});
test('apply refuses a tampered work file, a review with no reviewer, and (for now) the whole dataset', async () => {
  const w = await reviewed();
  const tampered = JSON.parse(serialiseWork(w)); tampered.candidates[0].candidate_status = 'rejected';
  const t = await apply({ work: JSON.stringify(tampered), options: {} }, env());
  assert.ok(t.incomplete);
  assert.deepEqual(t.report.items.map((i) => i.kind), ['work-unreadable']);
  assert.deepEqual(t.outputs, []);
  const anon = { ...w, reviewer: null };
  const n = await apply({ work: anon, options: {} }, env());
  assert.deepEqual(n.report.items.map((i) => i.kind), ['no-reviewer']);
  const given = await apply({ work: anon, options: { reviewer: { name: 'Given' } } }, env());
  assert.equal(given.report.errors, 0, 'control: a reviewer given with the command will do');
  assert.equal(given.attestations[0].attestation.contributor.name, 'Given');
  const d = await apply({ work: w, options: { output: 'dataset' } }, env());
  assert.ok(d.incomplete);
  assert.deepEqual(d.report.items.map((i) => i.kind), ['dataset-not-yet']);
  const none = await apply({ work: (await run()).work, options: { reviewer } }, env());
  assert.deepEqual(none.report.items.map((i) => i.kind), ['nothing-decided']);
  assert.deepEqual(none.outputs, []);
});
test('progress is worded for each dataset and each phase', () => {
  assert.equal(progressText({ phase: 'reading', dataset: 'others', places: 3, elapsedMs: 0 }), 'Other dataset: Reading: 3 places (0 s)');
  assert.equal(progressText({ phase: 'matching', places: 10, elapsedMs: 2000 }), 'Comparing the names: 10 places (2 s)');
  assert.equal(progressText({ phase: 'reading', places: 3, elapsedMs: 0 }), 'Reading: 3 places (0 s)', 'control: a plain run is not labelled');
});
