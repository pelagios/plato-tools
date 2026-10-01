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
import { normalise, similarity, similarityNormalised, nameScore, distinctive, expandedScore, oneEdit, jaroWinkler, trigrams } from '../src/engine/krisis/names.js';
import { NameIndex, BLOCKING } from '../src/engine/krisis/blocking.js';
import { syntheticNames, random } from './krisis-synthetic.js';
import { DataError } from '../src/engine/input.js';
import { Sha256, fileSha256 } from '../src/engine/krisis/digest.js';
import { match, distanceKm, representativePoint, DEFAULTS, ALGORITHM, SCORING } from '../src/engine/krisis/match.js';
import { readWork, serialiseWork, decide, reviewProgress, reviewPlaces, candidatesOf, isReviewed, filesDiffer, checkMatchOptions } from '../src/engine/krisis/work.js';
import { recordIdentity, attestationsFrom } from '../src/engine/krisis/identity.js';
import { apply, checkAppendOnly } from '../src/engine/krisis/apply.js';
import { compare } from '../src/engine/compare.js';
import { run as runPipeline } from '../src/engine/pipeline.js';
import { Report } from '../src/engine/report.js';
import { summary, groups, progressText, review } from '../src/engine/words.js';

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
test("a place's point passes over negated and withdrawn attestations", () => {
  const RETRACTS = 'https://w3id.org/plato#Retracts';
  const bad = { '@id': 'x#bad', ...at(0, 0) };
  assert.deepEqual(representativePoint({ attestations: [bad, at(3, 4)] }), [0, 0], 'control: the first point is taken');
  assert.deepEqual(representativePoint({ attestations: [{ ...bad, negated: true }, at(3, 4)] }), [3, 4], 'a negated one is not');
  assert.deepEqual(representativePoint({ attestations: [bad, at(3, 4), { meta: { targetAttestation: 'x#bad', metaType: RETRACTS }, sources: [src] }] }), [3, 4], 'nor one the record retracts');
  assert.deepEqual(representativePoint({ attestations: [bad, at(3, 4)] }, new Map([['x#bad', 'superseded']])), [3, 4], 'nor one withdrawn elsewhere');
  // A retraction in the record that is itself retracted elsewhere no longer holds: the point is restored.
  const retraction = { '@id': 'x#r', meta: { targetAttestation: 'x#bad', metaType: RETRACTS }, sources: [src] };
  assert.deepEqual(representativePoint({ attestations: [bad, at(3, 4), retraction] }, new Map([['x#r', 'retracted']])), [0, 0], 'restored elsewhere');
  assert.deepEqual(representativePoint({ attestations: [bad, at(3, 4), retraction] }, new Map([['x#bad', 'retracted']])), [3, 4], 'control: the retraction holding');
  assert.equal(representativePoint({ attestations: [{ ...bad, negated: true }] }), null);
});
test("PLATO's judgements example: Littleworth's retracted point at 0°, 0° is not its point, wherever the retraction sits", async () => {
  const doc = JSON.parse(readFileSync(JUDGEMENTS, 'utf8'));
  const lw = doc.spatialEntities.find((p) => p.label === 'Littleworth');
  const retraction = lw.attestations.find((a) => a.meta);
  assert.equal(retraction.meta.targetAttestation, lw.attestations.find((a) => a.geometries?.[0]?.geojson?.coordinates?.[0] === 0)['@id'], 'control: the example retracts the point at 0°, 0°');
  const subjects = { profile: 'place-centric', gazetteer: { '@id': X + 'a', title: 'A' }, spatialEntities: [place('a', 'lw', 'Littleworth', [at(-1.4, 51.6)])] };
  const m = async (d) => match({ subjects: await detect([json(subjects, 'a.json')]), others: await detect([json(d, 'j.json')]), options: {} }, env());
  const asIs = (await m(doc)).work;
  assert.deepEqual(asIs.candidates.map((c) => [c.candidate_candidate, c.distance_km, c.other.point]), [[lw['@id'], null, null]], 'suggested, with no point');
  // The retraction moved to another place of the dataset: still withdrawn.
  const moved = structuredClone(doc);
  const mlw = moved.spatialEntities.find((p) => p.label === 'Littleworth');
  mlw.attestations = mlw.attestations.filter((a) => !a.meta);
  moved.spatialEntities.find((p) => p !== mlw).attestations.push(retraction);
  assert.deepEqual((await m(moved)).work.candidates.map((c) => c.other.point), [null]);
  // Control: without the retraction, the point is 0°, 0°, over 5,000 km off, and the pair is not suggested.
  moved.spatialEntities.forEach((p) => { p.attestations = p.attestations.filter((a) => !a.meta); });
  const kept = await m(moved);
  assert.deepEqual(kept.work.candidates, []);
  assert.equal(kept.report.counts.tooFar, 1, 'found, and dropped as too far');
  // The retraction, left in place, and itself retracted by an attestation of another place: the point is restored.
  const restored = structuredClone(doc);
  restored.spatialEntities.find((p) => p.label !== 'Littleworth').attestations.push({ '@id': X + 'restore', meta: { targetAttestation: retraction['@id'], metaType: retraction.meta.metaType }, sources: [src] });
  const back = await m(restored);
  assert.deepEqual(back.work.candidates, [], 'restored elsewhere: 0°, 0° again, too far');
  assert.equal(back.report.counts.tooFar, 1);
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
test('the best few: an exact match with no point is not crowded out by near places that only resemble it', async () => {
  // DEEP gives most of its places no point: the true match with none must not lose its place to five near-namesakes.
  const s = { profile: 'place-centric', gazetteer: { '@id': X + 'a', title: 'A' }, spatialEntities: [place('a', 'ashford', 'Ashford', [at(-1.0, 52.0)])] };
  const near = ['Ashfield', 'Ashforth', 'Ashfold', 'Ashfort', 'Ashferd'];
  const o = { profile: 'place-centric', gazetteer: { '@id': X + 'b', title: 'B' }, spatialEntities: [
    ...near.map((n, i) => place('b', n.toLowerCase(), n, [at(-1.0 + 0.01 * (i + 1), 52.0)])), place('b', 'ashford', 'Ashford', [named('Ashford')])] };
  const got = (await run({}, s, o)).work.candidates.map((c) => [c.candidate_candidate.split('/').pop(), c.similarity_score, c.distance_km]);
  assert.equal(got.length, 5);
  assert.deepEqual(got[0], ['ashford', 1, null], 'the exact match, with no point, is kept, and first: it scores higher');
  assert.equal(got.filter(([, , d]) => d !== null).length, 4, 'and the near places fill the rest');
  // Control: the five near places are all found, over the threshold and under 1, and all kept when there is room.
  const all = (await run({ topK: 6 }, s, o)).work.candidates;
  assert.deepEqual(all.filter((c) => c.distance_km !== null).map((c) => c.candidate_candidate.split('/').pop()).sort(), near.map((n) => n.toLowerCase()).sort());
  assert.ok(all.every((c) => c.distance_km === null || (c.similarity_score >= 0.85 && c.similarity_score < 1)));
});
test('the best few: a near variant is not crowded out by namesakes with no point', async () => {
  // Found in a trial on real data (DEEP): Bromfield, 4 km from Broomfield, lost its place to five Broomfields with no coordinates.
  const s = { profile: 'place-centric', gazetteer: { '@id': X + 'a', title: 'A' }, spatialEntities: [place('a', 'broomfield', 'Broomfield', [at(-1.0, 52.0)])] };
  const o = { profile: 'place-centric', gazetteer: { '@id': X + 'b', title: 'B' }, spatialEntities: [
    ...[1, 2, 3, 4, 5].map((i) => place('b', `nowhere-${i}`, 'Broomfield', [named('Broomfield')])),
    place('b', 'bromfield', 'Bromfield', [at(-1.05, 52.02)]), place('b', 'bromfield-far', 'Bromfield', [at(-3, 55)])] };
  const got = (await run({}, s, o)).work.candidates.map((c) => [c.candidate_candidate.split('/').pop(), c.distance_km]);
  // The two groups take turns, the better first: a namesake at 1, the near variant, then the namesakes left.
  assert.deepEqual(got, [['nowhere-1', null], ['bromfield', 4.1], ['nowhere-2', null], ['nowhere-3', null], ['nowhere-4', null]]);
  assert.ok(similarity('Broomfield', 'Bromfield') < 1 && similarity('Broomfield', 'Bromfield') >= 0.85, 'control: Bromfield scores under the namesakes, over the threshold');
  assert.match(SCORING, /taking turns/);
});
test('the best few: a subject with no point keeps the best scores, as before', async () => {
  const s = { profile: 'place-centric', gazetteer: { '@id': X + 'a', title: 'A' }, spatialEntities: [place('a', 'broomfield', 'Broomfield', [named('Broomfield')])] };
  const o = { profile: 'place-centric', gazetteer: { '@id': X + 'b', title: 'B' }, spatialEntities: [
    place('b', 'bromfield', 'Bromfield', [at(-1.05, 52.02)]), place('b', 'broomfeld', 'Broomfeld', [at(-3, 55)]),
    ...[1, 2, 3, 4, 5].map((i) => place('b', `nowhere-${i}`, 'Broomfield', [named('Broomfield')]))] };
  const none = (await run({}, s, o)).work.candidates.map((c) => c.candidate_candidate.split('/').pop());
  assert.deepEqual(none, ['nowhere-1', 'nowhere-2', 'nowhere-3', 'nowhere-4', 'nowhere-5']);
  // Control: with room, the places with points are found too, by score, with no distance.
  const more = (await run({ topK: 7 }, s, o)).work.candidates;
  assert.deepEqual(more.slice(5).map((c) => [c.candidate_candidate.split('/').pop(), c.distance_km]).sort(), [['bromfield', null], ['broomfeld', null]]);
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
  // And the retraction, itself retracted in another place: the link holds again.
  s.spatialEntities[2].attestations.push({ '@id': A('springfield#restore'), meta: { targetAttestation: A('kingsbury#retract'), metaType: 'https://w3id.org/plato#Retracts' }, sources: [src] });
  const restored = await run({}, s);
  assert.ok(!has(restored.work, A('kingsbury'), B('kingsbury')), 'restored elsewhere');
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
  // Two empty lists are equal: the comparisons below mean something only if there is a suggestion.
  assert.ok(pairs(plain.work).length > 0, 'the plain run suggests something');
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

test("a CSV file read by Hermes's reader, its columns guessed, is matched against a PLATO JSON file", async () => {
  const subjects = await detect([file('test/fixtures/generic/with-ids.csv')]);
  assert.equal(subjects.format, 'csv');
  const others = { profile: 'place-centric', gazetteer: { '@id': X + 'b', title: 'Dataset B' }, spatialEntities: [
    place('b', 'bath', 'Aquae Sulis', [at(-2.36, 51.38)]),
    place('b', 'york', 'Eburacum', [at(-1.08, 53.96)]),
    place('b', 'london', 'Londinium', [at(-0.09, 51.51)]),
  ] };
  const r = await match({ subjects, others: await detect([json(others, 'b.json')]), options: { base: X + 'a/' } }, env());
  // Four rows have ids and are matched; the fifth, Isca, has none, and is the one problem, named.
  assert.equal(r.report.counts.subjects, 4);
  assert.equal(r.report.counts.unaddressed, 1);
  assert.deepEqual(r.report.items.map((i) => i.kind), ['no-address']);
  // Aquae Sulis exactly, Eboracum and Eburacum by a letter; Londinium, like no row, is not suggested.
  assert.deepEqual(r.work.candidates.map((c) => [c.candidate_source.split('/').pop(), c.candidate_candidate]),
    [['bath', B('bath')], ['york', B('york')]]);
  assert.equal(r.work.candidates[0].similarity_score, 1);
  assert.ok(r.work.candidates[1].similarity_score >= DEFAULTS.threshold && r.work.candidates[1].similarity_score < 1);
  assert.ok(r.work.candidates.every((c) => c.distance_km < 1), 'the rows\' coordinates were read');
  assert.ok(!r.work.candidates.some((c) => c.candidate_candidate === B('london')));
});

test('a line of a dataset that is not read is said to be not read, by matching and by finishing: not an object, a record wrapped in a list, not an LPF feature', async () => {
  const head = { profile: 'place-centric', gazetteer: { '@id': X + 'a', title: 'Dataset A' } };
  const lines = [JSON.stringify(head), ...subjectsDoc().spatialEntities.slice(0, 3).map((x) => JSON.stringify(x))];
  const jsonl = (bad) => detect([textFile([...lines, ...bad].join('\n') + '\n', 'a.jsonl')]);
  const others = async () => (await inputs()).others;
  // Control: the same lines with nothing added are read whole, and matched.
  const clean = await match({ subjects: await jsonl([]), others: await others(), options: {} }, env());
  assert.deepEqual(clean.report.items.map((i) => i.kind), []);
  assert.ok(clean.work.candidates.length > 0);
  const feature = (p) => JSON.stringify({ type: 'Feature', '@id': p['@id'], properties: { title: p.label }, geometry: p.attestations.find((a) => a.geometries).geometries[0].geojson });
  const lpf = (bad) => detect([textFile([...subjectsDoc().spatialEntities.slice(0, 3).map(feature), ...bad].join('\n') + '\n', 'a.geojsonl')]);
  const lpfClean = await match({ subjects: await lpf([]), others: await others(), options: {} }, env());
  assert.ok(!lpfClean.report.items.some((i) => i.kind === 'dataset-not-read'), JSON.stringify(lpfClean.report.items));
  for (const [kind, subjects] of [['jsonl-not-an-object', await jsonl(['42'])], ['not-a-list', await jsonl([`[${lines[1]}]`])],
    ['lpf-not-a-feature', await lpf([JSON.stringify({ type: 'Point', coordinates: [0, 0] })])]]) {
    const r = await match({ subjects, others: await others(), options: {} }, env());
    assert.ok(r.report.items.some((i) => i.kind === 'dataset-not-read'), `match, ${kind}: ${JSON.stringify(r.report.items)}`);
    assert.ok(!r.report.items.some((i) => i.kind === 'dataset-has-problems'), `match, ${kind}: not one of the dataset's own problems`);
  }
  const w = serialiseWork(await reviewed());
  const done = await apply({ subjects: await jsonl([]), work: w, options: {} }, env());
  assert.ok(!done.report.items.some((i) => i.kind === 'dataset-not-read'), 'control: ' + JSON.stringify(done.report.items));
  for (const [kind, bad] of [['jsonl-not-an-object', '42'], ['not-a-list', `[${lines[1]}]`]]) {
    const r = await apply({ subjects: await jsonl([bad]), work: w, options: {} }, env());
    assert.ok(r.report.items.some((i) => i.kind === 'dataset-not-read'), `apply, ${kind}: ${JSON.stringify(r.report.items)}`);
  }
});

// Hermes's matching of a table's columns, chosen on the page or given with --columns, is the one the
// review reads the dataset with: here the guess takes "label" for the name and "town" for a note,
// and the mapping says the opposite. Only with the mapping are the places' names the ones to match.
const MISGUESSED_CSV = 'id,label,town,lat,lon\nbath,Spa Site,Aquae Sulis,51.3811,-2.3590\nyork,Fortress,Eboracum,53.9590,-1.0815\n';
const MAPPING = { id: 'id', label: 'note', town: 'name', lat: 'latitude', lon: 'longitude' };
const romanOthers = () => ({ profile: 'place-centric', gazetteer: { '@id': X + 'b', title: 'Dataset B' }, spatialEntities: [
  place('b', 'bath', 'Aquae Sulis', [at(-2.36, 51.38)]), place('b', 'york', 'Eburacum', [at(-1.08, 53.96)])] });
test("a table's columns as mapped, not as guessed, are what it is matched by, and the mapping is kept in the work file", async () => {
  const subjects = await detect([textFile(MISGUESSED_CSV, 'roman.csv')]);
  const others = await detect([json(romanOthers(), 'b.json')]);
  const guessed = await match({ subjects, others, options: { base: X + 'a/' } }, env());
  const mapped = await match({ subjects, others, options: { base: X + 'a/', columns: MAPPING } }, env());
  // Both read the two rows; only the mapped one has the names to match.
  assert.equal(guessed.report.counts.subjects, 2);
  assert.equal(mapped.report.counts.subjects, 2);
  assert.deepEqual(guessed.work.candidates, [], 'absence: by the guess, "Spa Site" and "Fortress" are the names');
  assert.deepEqual(mapped.work.candidates.map((c) => [c.candidate_source, c.candidate_candidate]), [[X + 'a/place/bath', B('bath')], [X + 'a/place/york', B('york')]]);
  assert.deepEqual(mapped.work.match_parameters.columns, MAPPING);
  assert.ok(!('columns' in guessed.work.match_parameters), 'no mapping given, none recorded');
  // The work file with its mapping is read back as it was written; a mapping that is not one is refused.
  assert.deepEqual(readWork(serialiseWork(mapped.work)).match_parameters.columns, MAPPING);
  const bad = JSON.parse(serialiseWork(mapped.work)); bad.match_parameters.columns = ['town'];
  assert.throws(() => readWork(bad), (e) => e instanceof DataError && /columns/.test(e.message));
});
test("apply reads a table by the mapping the review was made with, so its dataset and version check agree", async () => {
  const subjects = await detect([textFile(MISGUESSED_CSV, 'roman.csv')]);
  const { work } = await match({ subjects, others: await detect([json(romanOthers(), 'b.json')]), options: { base: X + 'a/', columns: MAPPING } }, env());
  decide(work, work.candidates[0].id, 'match', { at: '2026-09-30T13:00:00Z' });
  work.reviewer = reviewer;
  const finish = async (w, options = {}) => { const e = env(); const r = await apply({ subjects, work: w, options: { base: X + 'a/', ...options } }, e); return { r, e }; };
  const { r, e } = await finish(work);
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  assert.equal(r.report.counts.versionCheck.added, 1);
  const toponyms = (p) => p.attestations.flatMap((a) => (a.names || []).map((n) => n.toponym));
  const bath = byId(JSON.parse(outText(e, 'roman.krisis-dataset.json'))).get(X + 'a/place/bath');
  assert.deepEqual(toponyms(bath), ['Aquae Sulis'], 'the place is named as mapped, and the column mapped as a note is not a name');
  // The same review with its mapping taken out reads the table by the guess: the place is named otherwise.
  const unmapped = JSON.parse(serialiseWork(work)); delete unmapped.match_parameters.columns;
  const g = await finish(unmapped);
  const named = byId(JSON.parse(outText(g.e, 'roman.krisis-dataset.json'))).get(X + 'a/place/bath');
  assert.deepEqual(toponyms(named), ['Spa Site']);
  // A mapping given to apply is used in place of the review's, and said to differ.
  const other = await finish(work, { columns: { ...MAPPING, label: 'name', town: 'note' } });
  assert.ok(other.r.report.items.some((i) => i.kind === 'columns-differ'), JSON.stringify(other.r.report.items));
  assert.ok(!r.report.items.some((i) => i.kind === 'columns-differ'), 'the review\'s own mapping: nothing to say');
});
test('a mapping given to finish a review made by the guess is said to differ, as one given to a review made by another is', async () => {
  const subjects = await detect([textFile(MISGUESSED_CSV, 'roman.csv')]);
  const others = await detect([json(romanOthers(), 'b.json')]);
  const { work } = await match({ subjects, others, options: { base: X + 'a/' } }, env());
  assert.ok(!('columns' in work.match_parameters), 'the review was made by the guess');
  work.reviewer = reviewer;
  const finish = async (options) => (await apply({ subjects, work: JSON.parse(serialiseWork(work)), options: { base: X + 'a/', output: 'attestations', ...options } }, env())).report.items;
  assert.ok((await finish({ columns: MAPPING })).some((i) => i.kind === 'columns-differ'), 'presence: a mapping given now, none then');
  assert.ok(!(await finish({})).some((i) => i.kind === 'columns-differ'), 'control: no mapping given now, none then');
});
test('match refuses a mapping of columns that is not one before anything is written, as readWork would refuse it in the work file', async () => {
  const subjects = await detect([textFile(MISGUESSED_CSV, 'roman.csv')]);
  const others = await detect([json(romanOthers(), 'b.json')]);
  for (const columns of [{ town: 5 }, { ...MAPPING, label: { x: 1 } }, ['town']]) {
    const e = env();
    await assert.rejects(match({ subjects, others, options: { base: X + 'a/', columns } }, e), (err) => err instanceof DataError && /matching of columns/.test(err.message), JSON.stringify(columns));
  }
  const ok = await match({ subjects, others, options: { base: X + 'a/', columns: MAPPING } }, env());
  assert.deepEqual(readWork(serialiseWork(ok.work)).match_parameters.columns, MAPPING, 'control: a mapping that is one is kept and read back');
});

// A column of a gazetteer's ids made into web addresses through a pattern confirmed on the page (Hermes's
// object form, which the page sends to Match and Finish as it does to a Hermes run): the review's places
// are the pattern-built addresses, the work file keeps the pattern, and apply re-reads the table by it.
const PLEIADES_CSV = 'id,name,pleiades_id,lat,lon\n1,Athenae,579885,37.97,23.72\n2,Roma,423025,41.89,12.49\n';
const PLEIADES_PATTERN = 'https://pleiades.stoa.org/places/{id}';
const PATTERNED = { id: 'id', name: 'name', pleiades_id: { field: 'address', pattern: PLEIADES_PATTERN }, lat: 'latitude', lon: 'longitude' };
const greekOthers = () => ({ profile: 'place-centric', gazetteer: { '@id': X + 'b', title: 'Dataset B' }, spatialEntities: [
  place('b', 'athens', 'Athenae', [at(23.72, 37.97)]), place('b', 'rome', 'Roma', [at(12.49, 41.89)])] });
test('a confirmed gazetteer pattern in the column options makes the review\'s places its web addresses, is kept in the work file, and is what apply reads by', async () => {
  const subjects = await detect([textFile(PLEIADES_CSV, 'greek.csv')]);
  const others = await detect([json(greekOthers(), 'b.json')]);
  const mapped = await match({ subjects, others, options: { base: X + 'a/', columns: PATTERNED } }, env());
  assert.deepEqual(mapped.work.candidates.map((c) => c.candidate_source).sort(), ['https://pleiades.stoa.org/places/423025', 'https://pleiades.stoa.org/places/579885']);
  // control: the same mapping without the pattern (the column a note) matches the rows by the base address, as before
  const plain = await match({ subjects, others, options: { base: X + 'a/', columns: { ...PATTERNED, pleiades_id: 'note' } } }, env());
  assert.deepEqual(plain.work.candidates.map((c) => c.candidate_source).sort(), [X + 'a/place/1', X + 'a/place/2']);
  // The work file keeps the pattern and is read back with it; one of plain fields is still read (control).
  assert.deepEqual(readWork(serialiseWork(mapped.work)).match_parameters.columns, PATTERNED);
  assert.deepEqual(readWork(serialiseWork(plain.work)).match_parameters.columns, { ...PATTERNED, pleiades_id: 'note' });
  for (const bad of [{ field: 'address' }, { field: 'address', pattern: 5 }, { field: 'address', pattern: PLEIADES_PATTERN, x: 1 }]) {
    const w = JSON.parse(serialiseWork(mapped.work)); w.match_parameters.columns = { ...PATTERNED, pleiades_id: bad };
    assert.throws(() => readWork(w), (e) => e instanceof DataError && /columns/.test(e.message), JSON.stringify(bad));
  }
  // Finished by the recorded options, the dataset's places are the pattern-built addresses and the version check sees one change, not false ones.
  const work = readWork(serialiseWork(mapped.work));
  decide(work, work.candidates.find((c) => c.candidate_source.endsWith('/579885')).id, 'match', { at: '2026-10-01T09:00:00Z' });
  work.reviewer = reviewer;
  const finish = async (options = {}) => { const e = env(); const r = await apply({ subjects, work: JSON.parse(serialiseWork(work)), options: { base: X + 'a/', ...options } }, e); return { r, e }; };
  const { r, e } = await finish();
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  assert.equal(r.report.counts.versionCheck.added, 1, JSON.stringify(r.report.counts.versionCheck));
  assert.ok(byId(JSON.parse(outText(e, 'greek.krisis-dataset.json'))).has('https://pleiades.stoa.org/places/579885'));
  // The same mapping with another pattern differs, and is said to; the identical options given again do not (control).
  const other = await finish({ columns: { ...PATTERNED, pleiades_id: { field: 'address', pattern: 'https://example.org/p/{id}' } } });
  assert.ok(other.r.report.items.some((i) => i.kind === 'columns-differ'), 'presence: ' + JSON.stringify(other.r.report.items));
  const same = await finish({ columns: JSON.parse(JSON.stringify(PATTERNED)) });
  assert.ok(!same.r.report.items.some((i) => i.kind === 'columns-differ'), 'control: ' + JSON.stringify(same.r.report.items));
  assert.ok(!r.report.items.some((i) => i.kind === 'columns-differ'), 'the review\'s own options: nothing to say');
});

// ---- the work file ---------------------------------------------------------------------------------------
test('decisions: each sets its status, and a place counts as reviewed once any of its candidates is decided', async () => {
  const { work } = await run();
  const [first] = candidatesOf(work, A('newton'));
  assert.equal(first.candidate_candidate, B('newton'));
  assert.deepEqual(reviewProgress(work), { reviewed: 0, total: 3 });
  assert.equal(review.progress(reviewProgress(work)), '0 of 3 places reviewed.');
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
  refused(tamper((w) => { w.krisis = 3; }), /later version of the tools/);
  refused(tamper((w) => { w.candidates[0].candidate_status = 'confirmed'; }), /confirmed, but no decision/);
  refused(tamper((w) => { w.candidates[0].decision = { kind: 'match', identityType: 'exactMatch', decided_at: '2026-09-30T13:00:00Z' }; }), /suggested, which disagrees/);
  refused(tamper((w) => { w.candidates[0].candidate_status = 'rejected'; w.candidates[0].decision = { kind: 'distinct', identityType: 'exactMatch', decided_at: '2026-09-30T13:00:00Z' }; }), /without saying why/);
  refused(tamper((w) => { w.candidates[0].candidate_source = X + 'elsewhere'; }), /a place the file does not list/);
  // Not a place the file lists, though every object has one of that name by inheritance.
  for (const inherited of ['constructor', 'toString', '__proto__']) refused(tamper((w) => { w.candidates[0].candidate_source = inherited; }), /a place the file does not list/);
  refused(tamper((w) => { w.others.titleFrom = 'somewhere'; }), /where the others dataset's title came from/);
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
test('apply refuses a candidate set given as the dataset, in words, and writes nothing', async () => {
  const w = await reviewed();
  const set = readFileSync(`${PLATO_REPO}/schemas/examples/candidate-set-judgements.json`, 'utf8');
  const e = env();
  const r = await apply({ subjects: await detect([textFile(set, 'a.json')]), work: w, options: {} }, e);
  assert.ok(r.incomplete);
  assert.deepEqual(r.report.items.filter((i) => i.severity === 'error').map((i) => i.kind), ['candidate-set-not-a-dataset']);
  assert.deepEqual([r.outputs, Object.keys(e.outs)], [[], []]);
});
test('apply refuses a tampered work file, and a review with no reviewer', async () => {
  const w = await reviewed();
  const tampered = JSON.parse(serialiseWork(w)); tampered.candidates[0].candidate_status = 'rejected';
  const t = await apply({ work: JSON.stringify(tampered), options: {} }, env());
  assert.ok(t.incomplete);
  assert.deepEqual(t.report.items.map((i) => i.kind), ['work-unreadable']);
  assert.deepEqual(t.outputs, []);
  const anon = { ...w, reviewer: null };
  const n = await apply({ work: anon, options: { output: 'attestations' } }, env());
  assert.deepEqual(n.report.items.map((i) => i.kind), ['no-reviewer']);
  const given = await apply({ work: anon, options: { output: 'attestations', reviewer: { name: 'Given' } } }, env());
  assert.equal(given.report.errors, 0, 'control: a reviewer given with the command will do');
  assert.equal(given.attestations[0].attestation.contributor.name, 'Given');
  const none = await apply({ work: (await run()).work, options: { reviewer } }, env());
  assert.deepEqual(none.report.items.map((i) => i.kind), ['nothing-decided']);
  assert.deepEqual(none.outputs, []);
});

// ---- the dataset output (the default) ----------------------------------------------------------------
const byId = (doc) => new Map(doc.spatialEntities.filter((p) => p['@id']).map((p) => [p['@id'], p]));
test('apply, by default: the dataset with the new attestations on exactly their places, valid, and passed by the version check', async () => {
  const w = await reviewed();
  const e = env();
  const phases = [];
  e.progress = (p) => phases.push(p.phase);
  const subjects = (await inputs()).subjects;
  const r = await apply({ subjects, work: w, options: {} }, e);
  assert.ok(!r.incomplete, JSON.stringify(r.report.items));
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  assert.ok(!r.report.items.some((i) => i.kind === 'dataset-now-plato-json'), 'PLATO JSON in, so nothing to say about the format');
  assert.deepEqual(r.outputs.map((o) => o.name), ['a.krisis-dataset.json']);
  assert.ok(phases.includes('checking'), 'the version check ran');
  const text = outText(e, 'a.krisis-dataset.json');
  const doc = JSON.parse(text), was = subjectsDoc();
  assert.equal(doc.profile, 'place-centric');
  assert.deepEqual(doc.gazetteer, was.gazetteer);
  assert.equal(doc.spatialEntities.length, was.spatialEntities.length, 'every place of the original, and no other');
  // The new attestations are on Newton (the matches) and Sainte-Mère-Église (the denial), after its own.
  const now = byId(doc), before = byId(was);
  for (const [id, p] of before) {
    const extra = now.get(id).attestations.slice(p.attestations.length);
    assert.deepEqual(now.get(id).attestations.slice(0, p.attestations.length), p.attestations, `${id} keeps its own attestations`);
    assert.deepEqual({ ...now.get(id), attestations: undefined }, { ...p, attestations: undefined }, `${id} is otherwise as it was`);
    const want = r.attestations.filter((m) => m.subject === id).map((m) => m.attestation);
    assert.deepEqual(extra, want, `${id} has exactly its new attestations`);
  }
  assert.equal(now.get(A('newton')).attestations.length, before.get(A('newton')).attestations.length + 1, 'presence: Newton has one more');
  assert.equal(now.get(A('springfield')).attestations.length, before.get(A('springfield')).attestations.length, 'absence: "not this one" adds nothing to Springfield');
  assert.ok(now.get(A('sainte-mere-eglise')).attestations.at(-1).negated);
  assert.deepEqual(doc.spatialEntities.at(-1), was.spatialEntities.at(-1), 'the place without an address is carried over as it was');
  // The checker passes it, and the version check, run by itself, finds the two new attestations and nothing lost.
  const checked = await go([textFile(text, 'out.json')], 'check');
  assert.equal(checked.report.errors, 0, JSON.stringify(checked.report.items));
  assert.equal(checked.report.counts.attestations, 7 + 2);
  const c = await compare({ earlier: subjects, later: await detect([textFile(text, 'out.json')]) }, env());
  assert.equal(c.report.errors, 0);
  assert.deepEqual([c.report.counts.earlier, c.report.counts.unchanged, c.report.counts.added, c.report.counts.lost, c.report.counts.changed], [7, 7, 2, 0, 0]);
  // Its counts are carried into the report, and said plainly.
  assert.deepEqual(r.report.counts.versionCheck, { earlier: 7, later: 9, unchanged: 7, changed: 0, lost: 0, added: 2 });
  const s = summary(r.report, 'apply');
  assert.equal(s.problems, 'The review was added to the dataset.');
  assert.equal(s.counted, 'Made 2 new attestations: 1 accepting 2 matches, 1 saying that two places are different. The dataset of 6 places had 7 attestations, and has 9 with 2 added; the version check found nothing deleted or changed.');
});
test('control: the version check catches a dataset that was not only added to, as a fault in the tools', async () => {
  const w = await reviewed();
  const subjects = (await inputs()).subjects;
  const made = attestationsFrom(w, { reviewer });
  const by = new Map(made.map((m) => [m.subject, m.attestation]));
  const write = async (augment) => {
    const e = env();
    await runPipeline({ input: subjects, action: 'convert', target: 'plato-json', options: { name: 'x.json', augment } }, e);
    return textFile(outText(e, 'x.json'), 'x.json');
  };
  const honest = (rec) => (by.has(rec['@id']) ? { ...rec, attestations: [...rec.attestations, by.get(rec['@id'])] } : rec);
  // Tampered: Newton's own first attestation (its other name) is dropped as the new one is added.
  const tampered = (rec) => (rec['@id'] === A('newton') ? { ...honest(rec), attestations: honest(rec).attestations.slice(1) } : honest(rec));
  const ok = new Report();
  await checkAppendOnly({ earlier: subjects, later: await write(honest), added: made.length }, env(), ok);
  assert.equal(ok.toJSON().errors, 0, 'presence: appended as apply appends, it passes');
  const bad = new Report();
  await checkAppendOnly({ earlier: subjects, later: await write(tampered), added: made.length }, env(), bad);
  const items = bad.toJSON().items;
  assert.ok(items.some((i) => i.kind === 'not-append-only' && i.severity === 'error' && /fault in the tools/.test(i.message)), JSON.stringify(items));
  assert.equal(bad.counts.versionCheck.lost, 1);
  const counts = { attestations: 2, matchAttestations: 1, distinctAttestations: 1, relations: 3, places: 6, versionCheck: bad.counts.versionCheck };
  assert.match(summary({ ...bad.toJSON(), counts }, 'apply').counted, /; the version check found 1 attestation no longer there\.$/);
  assert.match(summary({ ...ok.toJSON(), counts: { ...counts, versionCheck: ok.counts.versionCheck } }, 'apply').counted, /; the version check found nothing deleted or changed\.$/, 'control');
  // And one that adds too few is caught as well: nothing appended at all.
  const short = new Report();
  await checkAppendOnly({ earlier: subjects, later: await write((rec) => rec), added: made.length }, env(), short);
  assert.deepEqual(short.toJSON().items.map((i) => i.kind), ['not-all-added']);
});
test('apply, the dataset from spreadsheet tables: written as PLATO JSON, said so, with the attestations on their places', async () => {
  const s = subjectsDoc(); s.spatialEntities.pop();
  const tables = await go([json(s, 'a.json')], 'convert', 'tables');
  const subjects = await detect([new File(tables.e.outs['a-tables.zip'], 'a-tables.zip')]);
  assert.equal(subjects.format, 'tables');
  // Reviewed as tables: their places' addresses are made from the base given (base + 'place/' + id).
  const { work: w } = await match({ subjects, others: (await inputs()).others, options: { base: X + 'a/' } }, env());
  const newton = X + 'a/place/newton', springfield = X + 'a/place/springfield';
  decide(w, w.candidates.find((c) => c.candidate_source === newton && c.candidate_candidate === B('newton')).id, 'match', { at: '2026-09-30T13:00:00Z' });
  w.reviewer = reviewer;
  const e = env();
  const r = await apply({ subjects, work: w, options: { base: X + 'a/' } }, e);
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  const said = r.report.items.find((i) => i.kind === 'dataset-now-plato-json');
  assert.ok(said, 'it says the output is PLATO JSON');
  assert.match(said.message, /^Your dataset is PLATO spreadsheet tables; the dataset written with the new attestations is a PLATO JSON document/);
  assert.ok(!r.report.items.some((i) => i.kind === 'subjects-differ'), 'the tables are the files reviewed');
  assert.deepEqual(r.outputs.map((o) => o.name), ['a-tables.krisis-dataset.json']);
  const doc = JSON.parse(outText(e, 'a-tables.krisis-dataset.json'));
  assert.equal(doc.profile, 'place-centric');
  const now = byId(doc);
  assert.equal(now.size, 5);
  assert.ok(now.get(newton).attestations.some((a) => a.identities?.some((i) => i.object === B('newton'))), 'presence: the match is on Newton');
  assert.ok(!now.get(springfield).attestations.some((a) => a.identities), 'absence: nothing on Springfield');
  assert.equal(r.report.counts.versionCheck.added, 1);
  assert.equal(r.report.counts.versionCheck.lost + r.report.counts.versionCheck.changed, 0);
  // The same review applied to the JSON the tables came from finds none of its places there.
  const json_ = await apply({ subjects: (await inputs()).subjects, work: w, options: {} }, env());
  assert.deepEqual(json_.report.items.filter((i) => i.kind === 'not-in-dataset').map((i) => i.examples), [[newton]]);
});
test('apply, the dataset: a place the review is about that is not in the dataset is reported, and nothing is written', async () => {
  const w = await reviewed();
  const s = subjectsDoc(); s.spatialEntities = s.spatialEntities.filter((p) => p['@id'] !== A('newton'));
  const e = env();
  const r = await apply({ subjects: await detect([json(s, 'a.json')]), work: w, options: {} }, e);
  assert.ok(r.incomplete);
  assert.deepEqual(r.outputs, []);
  const missing = r.report.items.filter((i) => i.kind === 'not-in-dataset');
  assert.deepEqual(missing.map((i) => [i.severity, i.examples]), [['error', [A('newton')]]], 'Newton, and only Newton');
  // Control: with Newton there, it is not reported (the test above has the whole dataset pass).
  const whole = await apply({ subjects: (await inputs()).subjects, work: w, options: {} }, env());
  assert.ok(!whole.report.items.some((i) => i.kind === 'not-in-dataset'));
  // No dataset at all: said so, not thrown.
  const no = await apply({ work: w, options: {} }, env());
  assert.deepEqual(no.report.items.map((i) => i.kind), ['no-dataset']);
});
test('progress is worded for each dataset and each phase', () => {
  assert.equal(progressText({ phase: 'reading', dataset: 'others', places: 3, elapsedMs: 0 }), 'Other dataset: Reading: 3 places (0 s)');
  assert.equal(progressText({ phase: 'matching', places: 10, elapsedMs: 2000 }), 'Comparing the names: 10 places (2 s)');
  assert.equal(progressText({ phase: 'reading', places: 3, elapsedMs: 0 }), 'Reading: 3 places (0 s)', 'control: a plain run is not labelled');
});

// ---- scoring: names alike only in a shared word (krisis-names 2) ---------------------------------------------
test('names alike only in a word they share score under the threshold; respellings, abbreviations and reorderings stay over it', () => {
  for (const [a, b] of [['Saint Martin', 'Saint Maurice'], ['East Ham', 'West Ham'], ['Kafr Saba', 'Kafr Qasim'], ['Newton on the Hill', 'Newton by the River']]) {
    assert.ok(nameScore(normalise(a), normalise(b)) >= 0.85, `control: ${a} and ${b} score over the threshold on their letters alone`);
    assert.ok(similarity(a, b) < 0.85, `${a} and ${b}: ${similarity(a, b)}`);
  }
  for (const [a, b] of [['Tell Brak', 'Tell Barak'], ['Newton Abbot', 'Newton Abbott'], ['Saint Martin', 'San Martin'], ['St Martin', 'Saint Martin'],
    ['Stratford upon Avon', 'Stratford-on-Avon'], ['Sainte-Mère-Église', 'Ste Mere Eglise'], ['Kafr Cal', 'Kafr Cel'], ['Upper Newton', 'Newton Upper'],
    ['Kafr Saba', 'Kafar Saba'], ['Bristol', 'Bristoll'], ['Köln', 'Koln'], ['Newton', 'Neuton']])
    assert.ok(similarity(a, b) >= 0.85, `${a} and ${b}: ${similarity(a, b)}`);
  // It only ever lowers a score, and leaves names that share no word as they were.
  assert.equal(similarity('Springfield', 'Springfeld'), nameScore('springfield', 'springfeld'));
  assert.equal(distinctive('newton', 'neuton'), null);
  assert.equal(distinctive('newton', 'upper newton'), null, 'every word of one is shared: the name score stands');
  // One edit apart: a letter added, dropped, changed, or two swapped; not two changes.
  assert.deepEqual([oneEdit('cal', 'cel'), oneEdit('ab', 'ba'), oneEdit('abc', 'abcd'), oneEdit('abcd', 'acd')], [true, true, true, true]);
  assert.deepEqual([oneEdit('east', 'west'), oneEdit('cal', 'cal'), oneEdit('ab', 'abcd')], [false, false, false]);
});
test('a word common in the datasets counts for little: the same pair scores lower when the word they share is common', () => {
  const uniform = similarity('Kafr Cal', 'Kafr Cel');
  const common = similarity('Kafr Cal', 'Kafr Cel', (w) => (w === 'kafr' ? 0.2 : 3));
  const rare = similarity('Kafr Cal', 'Kafr Cel', (w) => (w === 'kafr' ? 3 : 0.2));
  assert.ok(common < uniform && uniform < rare, `${common} < ${uniform} < ${rare}`);
  // In matching, the weights are the words' inverse document frequency in the names of both datasets.
  const idx = new NameIndex([['Kafr Cel'], ['Kafr Dan'], ['Kafr Ana'], ['Kafr Bir']], [['Kafr Cal']]);
  assert.ok(idx.weight('kafr') < idx.weight('cel'), 'kafr, in every name, weighs less than cel, in one');
});
test('matching: Saint Maurice is not suggested for Saint Martin, St Martin is; the work file says how it was made', async () => {
  const s = { profile: 'place-centric', gazetteer: { '@id': X + 'a', title: 'A' }, spatialEntities: [place('a', 'martin', 'Saint Martin', [at(2, 48)])] };
  const o = { profile: 'place-centric', gazetteer: { '@id': X + 'b', title: 'B' }, spatialEntities: [
    place('b', 'maurice', 'Saint Maurice', [at(2.01, 48.01)]), place('b', 'st-martin', 'St Martin', [at(2.02, 48.02)])] };
  const { work, report } = await run({}, s, o);
  assert.deepEqual(pairs(work), [`${A('martin')} ${B('st-martin')}`]);
  assert.equal(work.algorithm_version, 'krisis-names 5');
  assert.equal(ALGORITHM, 'krisis-names 5');
  assert.match(work.match_parameters.scoring, /do not share/);
  assert.deepEqual({ ...work.match_parameters.blocking, rule: undefined }, { ...BLOCKING, rule: undefined });
  assert.match(work.match_parameters.blocking.rule, /common when more than 1%/);
  assert.equal(report.counts.comparisons, 2, 'both names were compared: the one not suggested was scored, not missed');
});

test('abbreviations: names alike but for St and Saint, or Mt and Mount, are suggested, whatever the words\' lengths and order', () => {
  for (const [a, b] of [['Mount Pleasant', 'Mt Pleasant'], ['Saint Zan', 'St Zan'], ['St Zan', 'Saint Zan'], ['Fort Lee', 'Ft Lee'], ['Sainte Anne', 'Ste Anne'], ['Zan Saint', 'Zan St']]) {
    assert.ok(nameScore(normalise(a), normalise(b)) < 0.95, `control: ${a} and ${b} differ in their letters (${nameScore(normalise(a), normalise(b))})`);
    assert.ok(similarity(a, b) >= 0.85, `${a} and ${b}: ${similarity(a, b)}`);
  }
  // Letters alone put these under the threshold: the rule is what raises them.
  assert.ok(nameScore('mount pleasant', 'mt pleasant') < 0.85 && nameScore('saint zan', 'st zan') < 0.85, 'control: under the threshold on letters alone');
  // Only an abbreviation is written out, and only when every other word is shared: the rest still lowers.
  assert.equal(expandedScore('kafr cal', 'kafr carl'), null, 'Cal and Carl: not a short form on the list');
  assert.equal(expandedScore('saint martin', 'st maurice'), null, 'a word not shared');
  assert.ok(similarity('Saint Martin', 'St Maurice') < 0.85, `Saint Martin and St Maurice: ${similarity('Saint Martin', 'St Maurice')}`);
  assert.ok(similarity('St Martin', 'Saint Martin') >= 0.85, 'control: St Martin and Saint Martin are');
  // And in matching, through blocking, as by the score alone.
  const idx = new NameIndex([['Mt Pleasant'], ['St Zan'], ['St Maurice']]);
  assert.ok(idx.best(['Mount Pleasant'], 0.85).has(0) && idx.best(['Saint Zan'], 0.85).has(1));
  assert.ok(!idx.best(['Saint Martin'], 0.85).has(2), 'control: St Maurice is not suggested for Saint Martin');
});
test('short forms are a list, St, Ste, Mt, Ft, Pt and on: a word that only contracts another (Dry, Danebury) is not written out, nor counted as shared', () => {
  // Found in a trial on real data (DEEP): each of these scored 1 when any contraction counted.
  for (const [a, b] of [['Danebury Hill', 'Dry Hill'], ['Great Baddow', 'Great Bow'], ['Tan Hill', 'Tapton Hill'], ['Cornbury Park', 'By Park'],
    ['Salt Ives', 'St Ives'], ['Foot Lee', 'Ft Lee'], ['Lake Mans', 'Le Mans']]) {
    assert.equal(expandedScore(normalise(a), normalise(b)), null, `${a} and ${b} are not written out`);
    assert.ok(similarity(a, b) < 0.85, `${a} and ${b}: ${similarity(a, b)}`);
  }
  // Beside them, the short forms on the list are written out, and raise the pair to 1.
  for (const [a, b] of [['St Zan', 'Saint Zan'], ['Mt Pleasant', 'Mount Pleasant'], ['Ft Lee', 'Fort Lee'], ['Pt Arthur', 'Port Arthur'], ['Ste Anne', 'Sainte Anne'], ['Stratford on Avon', 'Stratford upon Avon']]) {
    assert.ok(nameScore(normalise(a), normalise(b)) < 1, `control: ${a} and ${b} differ in their letters`);
    assert.equal(similarity(a, b), 1, `${a} and ${b}`);
  }
  assert.match(SCORING, /only these: St and Saint, Ste and Sainte, Mt and Mount, Ft and Fort, Pt and Port, on and upon/);
});
test('three-letter words: one letter is the limit, and a common shared word takes the pair under it, as the work file says', () => {
  // Weights as a gazetteer gives them: Kafr begins many names, Cel, Saba and Sabe one each.
  const idx = new NameIndex([...Array.from({ length: 200 }, (_, i) => [`Kafr ${String.fromCharCode(97 + (i % 26), 97 + ((i / 26) | 0) % 26, 97 + ((i * 7) % 26))}x`]), ['Kafr Cel'], ['Kafr Sabe']], [['Kafr Cal'], ['Kafr Saba']]);
  assert.ok(idx.weight('kafr') < idx.weight('cel') / 3, 'control: Kafr is common');
  assert.ok(similarity('Kafr Cal', 'Kafr Cel') >= 0.85, 'with every word weighed alike, Kafr Cal and Kafr Cel are suggested');
  assert.ok(similarity('Kafr Cal', 'Kafr Cel', idx.weight) < 0.85, `with Kafr common, they are not: ${similarity('Kafr Cal', 'Kafr Cel', idx.weight)}`);
  assert.ok(similarity('Kafr Saba', 'Kafr Sabe', idx.weight) >= 0.85, 'control: a word of four letters with one changed still is');
  assert.ok(!idx.best(['Kafr Cal'], 0.85).has(200) && idx.best(['Kafr Saba'], 0.85).has(201), 'and so in matching');
  assert.match(SCORING, /for words of three letters one letter is already the limit/);
});

// ---- blocking --------------------------------------------------------------------------------------------------
/** How many pairs the rule before this one compared: every pair sharing 30% of the padded trigrams of the one with fewer. */
function oldRule(subjects, others) {
  const post = new Map(), sizes = others.map((n) => trigrams(normalise(n)).size);
  others.forEach((n, i) => { for (const t of trigrams(normalise(n))) (post.get(t) || post.set(t, []).get(t)).push(i); });
  let pairs = 0;
  for (const n of subjects) {
    const tri = trigrams(normalise(n)), k = new Map();
    for (const t of tri) for (const i of post.get(t) || []) k.set(i, (k.get(i) || 0) + 1);
    for (const [i, c] of k) if (c >= Math.max(1, Math.ceil(0.3 * Math.min(tri.size, sizes[i])))) pairs++;
  }
  return pairs;
}
test('blocking: a short name, or one that begins with a common word, is not compared with every name that shares its beginning; respellings, accents and short names are still found', () => {
  const { subjects: background } = syntheticNames({ n: 3000, m: 0, seed: 3 });
  const others = [...background, 'Bristoll', 'Koln', 'Ur', 'Ay', 'Kaiubrg', 'Saint Martine'];
  const idx = new NameIndex(others.map((n) => [n]));
  const at_ = (n) => others.indexOf(n);
  for (const [s, o] of [['Bristol', 'Bristoll'], ['Köln', 'Koln'], ['Ur', 'Ur'], ['Ay', 'Ay'], ['Kaiburg', 'Kaiubrg'], ['Saint Martin', 'Saint Martine']])
    assert.ok(idx.best([s], 0.85).has(at_(o)), `${s} finds ${o}`);
  // The absences, beside the presences above: how many names each is compared with, and how many the rule before compared it with.
  for (const [s, most, oldMore] of [['Sa', 10, 150], ['Saint Martin', 10, 80], ['Tell Bara', 10, 40]]) {
    const before = idx.comparisons;
    idx.best([s], 0.85);
    const compared = idx.comparisons - before, old = oldRule([s], others);
    assert.ok(old > oldMore, `control: the rule before compared ${s} with ${old} names`);
    assert.ok(compared <= most, `${s} was compared with ${compared} names`);
  }
  assert.equal(idx.common, Math.max(BLOCKING.commonFloor, Math.ceil(BLOCKING.commonShare * others.length)));
});
test('blocking at scale: 4,000 names with 4,000 compare a small share of the pairs, and find the planted variants', () => {
  const n = 4000;
  const { subjects, others, pairs: planted } = syntheticNames({ n, seed: 1 });
  const t0 = performance.now();
  const idx = new NameIndex(others.map((x) => [x]), subjects.map((x) => [x]));
  const found = subjects.map((x) => idx.best([x], 0.85));
  const ms = performance.now() - t0;
  // The planted variants that score over the threshold are the ones a matcher can find: blocking must not lose them.
  const findable = planted.filter(([i, j]) => similarityNormalised(normalise(subjects[i]), normalise(others[j]), idx.weight) >= 0.85);
  const got = findable.filter(([i, j]) => found[i].has(j)).length;
  assert.ok(findable.length > planted.length * 0.95, `${findable.length} of ${planted.length} planted variants score over the threshold`);
  assert.ok(got >= findable.length * 0.98, `${got} of ${findable.length} found`);
  const old = oldRule(subjects, others);
  assert.ok(old > 0.02 * n * n, `control: the rule before compared ${old} pairs`);
  assert.ok(idx.comparisons < 0.01 * n * n, `${idx.comparisons} pairs compared`);
  assert.ok(ms < 15000, `${Math.round(ms)} ms`);
});

test('blocking: one mistake in the rare part of a name does not lose it, where the rarest trigrams all fall together', () => {
  const { subjects, others, pairs: planted } = syntheticNames({ n: 20000, seed: 7 });
  const idx = new NameIndex(others.map((x) => [x]), subjects.map((x) => [x]));
  for (const [s, o] of [['Great Shunia', 'Great Shnuia'], ['Granabad', 'Grnaabad'], ['Lenzai', 'Leznai']]) {
    const pair = planted.find(([i, j]) => subjects[i] === s && others[j] === o);
    assert.ok(pair, `control: ${s} and ${o} are a planted pair`);
    // Control: the pair shares none of the four rarest trigrams of the subject's name, which were all the rule before looked it up by.
    const n = normalise(s), shared = trigrams(normalise(o));
    const rarest = [...trigrams(n)].filter((g) => idx.ids.has(g)).sort((a, b) => idx.postings[idx.ids.get(a)].length - idx.postings[idx.ids.get(b)].length).slice(0, 4);
    assert.ok(rarest.every((g) => !shared.has(g)), `control: ${o} has none of ${rarest}`);
    assert.ok(similarityNormalised(n, normalise(o), idx.weight) >= 0.85, `control: ${s} and ${o} score over the threshold`);
    assert.ok(idx.best([s], 0.85).has(pair[1]), `${s} finds ${o}`);
  }
});
test('blocking at scale: names of a common word and a word of three letters ("San Xyz") are not each compared with the whole dataset', () => {
  // Every such name has the trigram "an " (or "fr "), so the far key added when the keys fall together
  // must not be one of those: it would read every such name for every such name.
  const n = 4000, k = n / 5;
  for (const head of ['San', 'Kafr']) {
    const r = random(5), w = () => Array.from({ length: 3 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(r() * 26)]).join('');
    const syn = syntheticNames({ n: n - k, seed: 1 }), extra = Array.from({ length: k }, () => `${head} ${w()}`);
    const others = [...syn.others, ...extra], subjects = [...syn.subjects, ...extra];
    const idx = new NameIndex(others.map((x) => [x]), subjects.map((x) => [x]));
    const last = idx.postings[idx.ids.get(head === 'San' ? 'an ' : 'fr ')].length;
    assert.ok(last > 0.15 * n, `control: ${last} names have the common word's last trigram`);
    const found = subjects.map((x) => idx.best([x], 0.85));
    assert.equal(extra.filter((x, i) => found[n - k + i].has(n - k + i)).length, k, `each ${head} name finds itself`);
    const planted = syn.pairs.filter(([i, j]) => found[i].has(j)).length;
    assert.ok(planted >= syn.pairs.length * 0.97, `${planted} of ${syn.pairs.length} planted variants found`);
    assert.ok(idx.comparisons < 0.01 * n * n, `${head}: ${idx.comparisons} pairs compared of ${n * n}`);
  }
});
test('blocking: names that begin alike are compared, though they share fewer trigrams than the rule asks', () => {
  const idx = new NameIndex([['Brussels'], ['Bremen'], ['Bristol']]);
  const t = trigrams('bruxelles'), o = trigrams('brussels'), shared = [...t].filter((g) => o.has(g)).length;
  assert.ok(shared < Math.ceil(BLOCKING.share * Math.min(t.size, o.size)), `control: ${shared} shared, fewer than ${BLOCKING.share * 100}% of ${Math.min(t.size, o.size)}`);
  assert.ok(similarity('Bruxelles', 'Brussels') >= 0.85, 'control: they score over the threshold');
  assert.ok(idx.best(['Bruxelles'], 0.85).has(0), 'Bruxelles finds Brussels');
  assert.ok(!idx.best(['Bruxelles'], 0.85).has(1), 'control: Bremen is not suggested');
});

// ---- the other dataset's title, cited by every attestation ------------------------------------------------------------
test('an other dataset with no title of its own is warned of at matching and at finishing, and the title given is cited', async () => {
  const untitled = othersDoc(); delete untitled.gazetteer.title;
  const warned = (r) => r.report.items.some((i) => i.kind === 'others-title-is-file-name');
  const plain = await run({}, subjectsDoc(), untitled);
  assert.ok(warned(plain), 'no title: warned');
  assert.equal(plain.work.others.title, 'b.json');
  assert.equal(plain.work.others.titleFrom, 'file-name');
  assert.ok(!warned(await run()), 'control: a dataset with its own title is not warned of');
  assert.equal((await run()).work.others.titleFrom, 'gazetteer');
  const given = await run({ othersTitle: '  Dataset B, 2026  ' }, subjectsDoc(), untitled);
  assert.ok(!warned(given), 'a title given: not warned');
  assert.deepEqual([given.work.others.title, given.work.others.titleFrom], ['Dataset B, 2026', 'given']);
  assert.ok(given.work.candidates.every((c) => c.other.source.title === 'Dataset B, 2026'));
  assert.deepEqual(readWork(serialiseWork(given.work)).others, given.work.others, 'kept in the work file');
  // Finishing: the title recorded is cited; one recorded only as a file name is warned of again, and one given now is cited instead.
  const decideOne = (w) => { decide(w, w.candidates.find((c) => c.candidate_source === A('newton') && c.candidate_candidate === B('newton')).id, 'match', { at: '2026-09-30T13:00:00Z' }); w.reviewer = reviewer; return w; };
  const cited = (r) => r.attestations.map((m) => m.attestation.citations[0].source.title);
  const a1 = await apply({ work: decideOne(given.work), options: { output: 'attestations' } }, env());
  assert.deepEqual(cited(a1), ['Dataset B, 2026']);
  assert.ok(!warned(a1));
  const a2 = await apply({ work: decideOne(plain.work), options: { output: 'attestations' } }, env());
  assert.ok(warned(a2), 'a file name recorded: warned at finishing too');
  assert.deepEqual(cited(a2), ['b.json']);
  const a3 = await apply({ work: decideOne(plain.work), options: { output: 'attestations', othersTitle: 'Dataset B' } }, env());
  assert.ok(!warned(a3));
  assert.deepEqual(cited(a3), ['Dataset B']);
});
test('an other dataset in every format with no title of its own is recorded as cited by its file name, and warned of: LPF, whose reader gives it the file name', async () => {
  const warned = (r) => r.report.items.some((i) => i.kind === 'others-title-is-file-name');
  const lpf = async (title) => {
    const d = othersDoc(); if (title) d.gazetteer.title = title; else delete d.gazetteer.title;
    const c = await go([json(d, 'b.json')], 'convert', 'lpf');
    const text = outText(c.e, 'b.geojson');
    const r = await match({ subjects: (await inputs()).subjects, others: await detect([textFile(text, 'campop.geojson')]), options: {} }, env());
    return { r, text };
  };
  const bare = await lpf(null);
  assert.equal(JSON.parse(bare.text).title, undefined, 'control: the LPF file gives no title of its own');
  assert.equal(JSON.parse((await lpf('Dataset B')).text).title, 'Dataset B', 'control: and this one does');
  assert.equal(bare.r.work.others.title, 'campop.geojson');
  assert.equal(bare.r.work.others.titleFrom, 'file-name');
  assert.ok(warned(bare.r));
  // Control: an LPF file with its title is cited by it.
  const titled = await lpf('Dataset B');
  assert.deepEqual([titled.r.work.others.title, titled.r.work.others.titleFrom], ['Dataset B', 'gazetteer']);
  assert.ok(!warned(titled.r));
  // And the spreadsheet tables, whose reader gives a title of its own making.
  const s = othersDoc(); delete s.gazetteer.title;
  const tables = await go([json(s, 'b.json')], 'convert', 'tables');
  const t = await match({ subjects: (await inputs()).subjects, others: await detect([new File(tables.e.outs['b-tables.zip'], 'b-tables.zip')]), options: { base: X + 'b/' } }, env());
  assert.equal(t.work.others.titleFrom, 'file-name', t.work.others.title);
});
test('matching options out of range are refused in plain words, by the rule the page uses too', () => {
  for (const threshold of [0, 1.5, -1]) assert.throws(() => checkMatchOptions({ threshold }), (e) => e instanceof DataError && /threshold must be above 0 and at most 1/.test(e.message), String(threshold));
  assert.throws(() => checkMatchOptions({ maxDistanceKm: -5 }), DataError);
  assert.deepEqual(checkMatchOptions({ threshold: 1, maxDistanceKm: 0 }), { ...DEFAULTS, threshold: 1, maxDistanceKm: 0 }, 'control: 1 and 0 are allowed');
  assert.deepEqual(checkMatchOptions({}), DEFAULTS, 'control: none given, the defaults');
});

// ---- the base address, the work file's checks, the dataset output's schema check ----------------------------------
test('the base address matched with is kept in the work file, and finishing with another warns', async () => {
  const s = subjectsDoc(); s.spatialEntities.pop();
  const tables = await go([json(s, 'a.json')], 'convert', 'tables');
  const subjects = await detect([new File(tables.e.outs['a-tables.zip'], 'a-tables.zip')]);
  const { work: w } = await match({ subjects, others: (await inputs()).others, options: { base: X + 'a/' } }, env());
  assert.equal(w.match_parameters.base, X + 'a/');
  assert.equal(readWork(serialiseWork(w)).match_parameters.base, X + 'a/');
  decide(w, w.candidates.find((c) => c.candidate_source === X + 'a/place/newton' && c.candidate_candidate === B('newton')).id, 'match', { at: '2026-09-30T13:00:00Z' });
  w.reviewer = reviewer;
  const same = await apply({ subjects, work: w, options: { output: 'attestations', base: X + 'a/' } }, env());
  assert.ok(!same.report.items.some((i) => i.kind === 'base-differs'), 'control: the same base, no warning');
  for (const base of [X + 'elsewhere/', undefined]) {
    const r = await apply({ subjects, work: w, options: { output: 'attestations', base } }, env());
    const warned = r.report.items.find((i) => i.kind === 'base-differs');
    assert.ok(warned, `base ${base}`);
    assert.match(warned.message, base ? /elsewhere\/ is given now/ : /none is given now/);
  }
  const plain = (await run()).work;
  assert.equal(plain.match_parameters.base, undefined, 'no base given, none recorded');
});
test('a work file that would make attestations PLATO cannot hold is refused as the data\'s mistake, in plain words', async () => {
  const w = await reviewed();
  const text = serialiseWork(w);
  const tamper = (edit) => { const x = JSON.parse(text); edit(x); return x; };
  const decided = (x) => x.candidates.find((c) => c.decision?.kind === 'match');
  const cases = [
    [(x) => { decided(x).decision.decided_at = 'yesterday'; }, /decided "yesterday", which is not a date and time/],
    [(x) => { decided(x).candidate_candidate = 'Newton'; }, /suggests "Newton", which is not a web address/],
    [(x) => { const k = decided(x).candidate_source; x.places.newton = x.places[k]; delete x.places[k]; for (const c of x.candidates) if (c.candidate_source === k) c.candidate_source = 'newton'; }, /listed by "newton", which is not a web address/],
    [(x) => { const c = decided(x); x.candidates.push({ ...structuredClone(c), id: 'c99' }); }, /same place for the same place as another candidate/],
  ];
  for (const [edit, re] of cases) {
    const x = tamper(edit);
    // Control: unchecked, the same work makes recordIdentity throw a plain Error, which would be reported as a fault in the tools.
    assert.throws(() => attestationsFrom(x, { reviewer }), (e) => !(e instanceof DataError), `control for ${re}`);
    assert.throws(() => readWork(JSON.stringify(x)), (e) => e instanceof DataError && re.test(e.message), re);
    const r = await apply({ work: JSON.stringify(x), options: { output: 'attestations' } }, env());
    assert.deepEqual(r.report.items.map((i) => i.kind), ['work-unreadable']);
  }
  assert.ok(readWork(text), 'control: the file untouched reads');
});
test('apply, the dataset: each new attestation is checked against the schema before anything is written', async () => {
  const w = await reviewed();
  const e = env();
  const rejecting = Object.assign(() => false, { errors: [{ instancePath: '/attestations/0', message: 'is not what the schema allows' }] });
  e.resources = { ...res, validators: { ...res.validators, 'place-centric': { ...res.validators['place-centric'], entity: rejecting } } };
  const r = await apply({ subjects: (await inputs()).subjects, work: w, options: {} }, e);
  assert.ok(r.incomplete);
  assert.deepEqual(r.outputs, []);
  assert.deepEqual([...new Set(r.report.items.map((i) => i.kind))], ['not-valid']);
  assert.match(r.report.items[0].examples[0], /is not what the schema allows/);
  const ok = await apply({ subjects: (await inputs()).subjects, work: w, options: {} }, env());
  assert.equal(ok.report.errors, 0, 'control: with the real schema, the same review is written');
});
