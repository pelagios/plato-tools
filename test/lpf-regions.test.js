import { PLATO_REPO } from './paths.js';
// Regions matched to a gazetteer (PLATO 1d2cf6e, #23): the dataset's ContainedIn points at a region
// minted from its own data, and a reviewer's attestation says that region is the gazetteer's, with
// promotedFrom naming the Candidate that holds the score. Linked Places Format writes the two as one
// gvp:broaderPartitive relation: relationTo the identity's object, certainty the reviewer's level,
// whg_match_score the Candidate's score, label the region's name. Every case where the writer cannot
// tell (no candidate set, a candidate not found, several matches) writes no guess and is reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { go, file, textFile, outText } from './engine.js';
import { detect } from '../src/engine/input.js';

const EX = `${PLATO_REPO}/schemas/examples`;
const DATASET = `${EX}/place-centric-regions.json`, SET = `${EX}/candidate-set-regions.json`;
const P = 'https://w3id.org/plato#';
const W = 'https://whgazetteer.org/example/';
const SURREY = `${W}entity/region/england/surrey`, ENGLAND = `${W}entity/region/england`;
const WHG_SURREY = `${W}whg/place/surrey`, WHG_ENGLAND = `${W}whg/place/england`;
const ROTHERHITHE = `${W}entity/rotherhithe`;
const dataset = () => JSON.parse(readFileSync(DATASET, 'utf8'));
const candidateSet = () => JSON.parse(readFileSync(SET, 'utf8'));
const losses = (r) => r.report.items.filter((i) => i.severity === 'loss');
const loss = (r, kind) => losses(r).find((i) => i.kind === kind);
const sets = async (...docs) => Promise.all(docs.map(async (d, i) => detect([textFile(JSON.stringify(d), `set-${i}.json`)])));

/** Convert a document to LPF, with the candidate sets given; the features by @id, and the run. */
async function lpf(doc, candidates, target = 'lpf') {
  const r = await go([textFile(JSON.stringify(doc), 'd.json')], 'convert', target, candidates ? { candidates } : {});
  const text = outText(r.e, target === 'lpf' ? 'd.geojson' : 'd.geojsonl');
  const features = target === 'lpf' ? JSON.parse(text).features : text.trim().split('\n').slice(1).map((l) => JSON.parse(l));
  return { r, byId: new Map(features.map((f) => [f['@id'], f])) };
}
const relationsOf = (byId, id) => byId.get(id)?.relations || [];
/** The containment relations of a feature. */
const containedIn = (byId, id) => relationsOf(byId, id).filter((x) => x.relationType === 'gvp:broaderPartitive');

/** The example's region Surrey, with its reviewer's attestation replaced by `atts` (and the others kept). */
function withSurreyMatches(atts) {
  const d = dataset();
  const surrey = d.spatialEntities.find((e) => e['@id'] === SURREY);
  surrey.attestations = [...surrey.attestations.filter((a) => !a.identities), ...atts];
  return d;
}
const review = (id, object, extra = {}) => ({
  '@id': `${W}attestation/${id}`,
  identities: [{ subject: SURREY, object, identityType: 'closeMatch', basis: 'b', ...(extra.promotedFrom ? { promotedFrom: extra.promotedFrom } : {}) }],
  certaintyLevel: extra.certaintyLevel || P + 'Certain',
  sources: [{ '@id': `${W}source/region-review`, title: 'Review' }],
  ...(extra.negated ? { negated: true } : {}),
  ...(extra.meta ? { meta: extra.meta } : {}),
});
const SURREY_CANDIDATE = `${W}candidates/regions-2026-10-03#c-95321738`;

test('the example with its candidate set: each ContainedIn is one gvp:broaderPartitive to the gazetteer, with its certainty, score and label', async () => {
  const { r, byId } = await lpf(dataset(), await sets(candidateSet()));
  assert.deepEqual(r.report.errors, 0);
  const [rel] = containedIn(byId, ROTHERHITHE);
  assert.deepEqual({ ...rel, citations: undefined }, { relationType: 'gvp:broaderPartitive', relationTo: WHG_SURREY, label: 'Surrey', certainty: 'certain', whg_match_score: 93, citations: undefined });
  assert.equal(rel.citations?.length, 1, 'the containment keeps its citation');
  const [up] = containedIn(byId, SURREY);
  assert.deepEqual([up.relationTo, up.label, up.certainty, up.whg_match_score], [WHG_ENGLAND, 'England', 'certain', 98]);
  // A presence control for the absences below: the reviewers' identities are still reported as not
  // written as links (identity-bundle), and the run's losses are read.
  assert.equal(loss(r, 'identity-bundle')?.count, 2, JSON.stringify(losses(r).map((i) => i.kind)));
  assert.equal(loss(r, 'region-match-no-score'), undefined, JSON.stringify(losses(r).map((i) => i.kind)));
  // The reviewers' certainty is written, in the broaderPartitive, so it is not reported as dropped.
  assert.equal(loss(r, 'certainty-level'), undefined, JSON.stringify(losses(r).map((i) => i.kind)));
  assert.equal(containedIn(byId, ROTHERHITHE).length, 1);
});

test("LPF as GeoJSON Lines (lpf-seq) carries the same relation", async () => {
  const { byId } = await lpf(dataset(), await sets(candidateSet()), 'lpf-seq');
  assert.deepEqual(containedIn(byId, ROTHERHITHE).map((x) => [x.relationTo, x.whg_match_score]), [[WHG_SURREY, 93]]);
});

test('with no candidate set, the match is still written, with no score, and the missing score is reported', async () => {
  const { r, byId } = await lpf(dataset());
  const [rel] = containedIn(byId, ROTHERHITHE);
  assert.deepEqual([rel.relationTo, rel.certainty, rel.label], [WHG_SURREY, 'certain', 'Surrey']);
  assert.equal('whg_match_score' in rel, false);
  const l = loss(r, 'region-match-no-score');
  assert.equal(l?.count, 2, JSON.stringify(losses(r)));
  assert.match(l.message, /candidate set/);
});

test('a promotedFrom that names no candidate in the sets given writes no score, and is reported; the other region keeps its score', async () => {
  const s = candidateSet();
  s.candidates = s.candidates.filter((c) => c['@id'] !== SURREY_CANDIDATE);
  const { r, byId } = await lpf(dataset(), await sets(s));
  assert.equal('whg_match_score' in containedIn(byId, ROTHERHITHE)[0], false);
  assert.equal(containedIn(byId, SURREY)[0].whg_match_score, 98, 'a control: the candidate that is there is used');
  assert.equal(loss(r, 'region-match-no-score')?.count, 1);
});

test("a candidate for another pair than the identity's gives no score, and is reported", async () => {
  const s = candidateSet();
  s.candidates.find((c) => c['@id'] === SURREY_CANDIDATE).object = `${W}whg/place/somewhere-else`;
  const { r, byId } = await lpf(dataset(), await sets(s));
  assert.equal('whg_match_score' in containedIn(byId, ROTHERHITHE)[0], false);
  assert.equal(containedIn(byId, SURREY)[0].whg_match_score, 98);
  assert.equal(loss(r, 'region-match-no-score')?.count, 1);
});

test('a region assigned by hand: ContainedIn straight at the gazetteer, with its own certainty and no score', async () => {
  const d = dataset();
  const att = d.spatialEntities[0].attestations.find((a) => a.relations);
  att.relations[0].relatesTo = WHG_SURREY;
  att.certaintyLevel = P + 'LessCertain';
  att.timespans = [{ startEarliest: '1801', endLatest: '1900' }];
  const { r, byId } = await lpf(d, await sets(candidateSet()));
  const [rel] = containedIn(byId, ROTHERHITHE);
  assert.deepEqual([rel.relationTo, rel.certainty, rel.label, 'whg_match_score' in rel], [WHG_SURREY, 'less-certain', 'Surrey', false]);
  assert.deepEqual(rel.when?.timespans?.map((t) => [t.start?.in, t.end?.in]), [['1801', '1900']], 'the containment keeps its when');
  assert.equal(containedIn(byId, SURREY)[0].whg_match_score, 98, 'a control: the matched region still has its score');
  assert.equal(loss(r, 'region-match-no-score'), undefined);
});

test('a region with no live identity: its own address, no certainty and no score', async () => {
  const matched = await lpf(withSurreyMatches([review('m1', WHG_SURREY, { promotedFrom: SURREY_CANDIDATE })]), await sets(candidateSet()));
  assert.equal(containedIn(matched.byId, ROTHERHITHE)[0].relationTo, WHG_SURREY, 'a control: the live match is followed');
  const cases = {
    negated: [review('m1', WHG_SURREY, { promotedFrom: SURREY_CANDIDATE, negated: true })],
    retracted: [review('m1', WHG_SURREY, { promotedFrom: SURREY_CANDIDATE }), { '@id': `${W}attestation/r1`, meta: [{ metaType: P + 'Retracts', targetAttestation: `${W}attestation/m1` }], sources: [{ '@id': `${W}source/region-review`, title: 'Review' }] }],
    none: [],
  };
  for (const [name, atts] of Object.entries(cases)) {
    const { r, byId } = await lpf(withSurreyMatches(atts), await sets(candidateSet()));
    const [rel] = containedIn(byId, ROTHERHITHE);
    assert.deepEqual([rel.relationTo, 'whg_match_score' in rel, 'certainty' in rel], [SURREY, false, false], name);
    assert.equal(loss(r, 'region-match-no-score'), undefined, name);
  }
});

test('a superseded match gives way to the one that supersedes it', async () => {
  const OTHER = `${W}whg/place/surrey-2`;
  const later = review('m2', OTHER, { certaintyLevel: P + 'LessCertain', meta: [{ metaType: P + 'Supersedes', targetAttestation: `${W}attestation/m1` }] });
  const { r, byId } = await lpf(withSurreyMatches([review('m1', WHG_SURREY, { promotedFrom: SURREY_CANDIDATE }), later]), await sets(candidateSet()));
  const [rel] = containedIn(byId, ROTHERHITHE);
  assert.deepEqual([rel.relationTo, rel.certainty, 'whg_match_score' in rel], [OTHER, 'less-certain', false]);
  assert.equal(loss(r, 'region-match-several'), undefined, 'the superseded match is not counted');
});

test('two live matches to different places: no guess, the region\'s own address, reported', async () => {
  const OTHER = `${W}whg/place/surrey-2`;
  const { r, byId } = await lpf(withSurreyMatches([review('m1', WHG_SURREY, { promotedFrom: SURREY_CANDIDATE }), review('m2', OTHER)]), await sets(candidateSet()));
  const [rel] = containedIn(byId, ROTHERHITHE);
  assert.deepEqual([rel.relationTo, 'whg_match_score' in rel], [SURREY, false]);
  assert.equal(loss(r, 'region-match-several')?.count, 1);
  // Here no reviewer's certainty is written, so each is reported as dropped (a control for the first test).
  assert.equal(loss(r, 'certainty-level')?.count, 2, JSON.stringify(losses(r).map((i) => i.kind)));
  // A control: two live matches to the same place are one match.
  const same = await lpf(withSurreyMatches([review('m1', WHG_SURREY, { promotedFrom: SURREY_CANDIDATE }), review('m2', WHG_SURREY)]), await sets(candidateSet()));
  assert.equal(containedIn(same.byId, ROTHERHITHE)[0].relationTo, WHG_SURREY);
  assert.equal(loss(same.r, 'region-match-several'), undefined);
});

test("with no relationLabel, the label is the region's label, else its toponym", async () => {
  const d = dataset();
  delete d.spatialEntities[0].attestations.find((a) => a.relations).relations[0].relationLabel;
  const { byId } = await lpf(d, await sets(candidateSet()));
  assert.equal(containedIn(byId, ROTHERHITHE)[0].label, 'Surrey (England)');
  delete d.spatialEntities.find((e) => e['@id'] === SURREY).label;
  const { byId: b2 } = await lpf(d, await sets(candidateSet()));
  assert.equal(containedIn(b2, ROTHERHITHE)[0].label, 'Surrey');
});

test('the containment attestation keeps everything else: its citations, and a meta-attestation is still reported', async () => {
  const d = dataset();
  const att = d.spatialEntities[0].attestations.find((a) => a.relations);
  att.meta = [{ metaType: P + 'Supports', targetAttestation: `${W}attestation/rotherhithe-name` }];
  const { r, byId } = await lpf(d, await sets(candidateSet()));
  const [rel] = containedIn(byId, ROTHERHITHE);
  assert.deepEqual(rel.citations?.map((c) => c['@id']), [`${W}source/parish-list`]);
  assert.ok(loss(r, 'meta-attestation'), JSON.stringify(losses(r).map((i) => i.kind)));
});

test('read from RDF, the same relations: the store is searched for the regions\' matches', async () => {
  const nt = await go([file(DATASET, 'd.json')], 'convert', 'ntriples');
  const r = await go([textFile(outText(nt.e, 'd.nt'), 'd.nt')], 'convert', 'lpf', { candidates: await sets(candidateSet()) });
  const byId = new Map(JSON.parse(outText(r.e, 'd.geojson')).features.map((f) => [f['@id'], f]));
  assert.deepEqual(containedIn(byId, ROTHERHITHE).map((x) => [x.relationTo, x.certainty, x.whg_match_score, x.label]), [[WHG_SURREY, 'certain', 93, 'Surrey']]);
  assert.deepEqual(containedIn(byId, SURREY).map((x) => [x.relationTo, x.whg_match_score]), [[WHG_ENGLAND, 98]]);
});

test('a file given as a candidate set that is not one is warned of, and gives no score', async () => {
  const { r, byId } = await lpf(dataset(), await sets(dataset()));
  assert.equal(r.report.items.find((i) => i.kind === 'candidates-not-a-set')?.severity, 'warning');
  assert.equal(containedIn(byId, ROTHERHITHE)[0].relationTo, WHG_SURREY);
  assert.equal(loss(r, 'region-match-no-score')?.count, 2);
});

test('LPF -> PLATO reads gvp:broaderPartitive back as ContainedIn, prefixed or in full, and reports whg_match_score as lost', async () => {
  const { r } = await lpf(dataset(), await sets(candidateSet()));
  const fc = JSON.parse(outText(r.e, 'd.geojson'));
  const surreyRel = fc.features.find((f) => f['@id'] === SURREY).relations[0];
  surreyRel.relationType = 'http://vocab.getty.edu/ontology#broaderPartitive';   // the full form
  const back = await go([textFile(JSON.stringify(fc), 'd.geojson')], 'convert', 'plato-json');
  const doc = JSON.parse(outText(back.e, 'd.json'));
  const rels = (id) => doc.spatialEntities.find((e) => e['@id'] === id).attestations.flatMap((a) => a.relations || []);
  assert.deepEqual(rels(ROTHERHITHE).map((x) => [x.relationType, x.relatesTo, x.relationLabel]), [[P + 'ContainedIn', WHG_SURREY, 'Surrey']]);
  assert.deepEqual(rels(SURREY).map((x) => [x.relationType, x.relatesTo]), [[P + 'ContainedIn', WHG_ENGLAND]]);
  assert.equal(loss(back, 'lpf-match-score')?.count, 2, JSON.stringify(losses(back).map((i) => i.kind)));
  // A control: an LPF relation with no score reports none.
  for (const f of fc.features) for (const x of f.relations || []) delete x.whg_match_score;
  const plain = await go([textFile(JSON.stringify(fc), 'd.geojson')], 'convert', 'plato-json');
  assert.equal(loss(plain, 'lpf-match-score'), undefined);
  const plainDoc = JSON.parse(outText(plain.e, 'd.json'));
  assert.equal(plainDoc.spatialEntities.flatMap((e) => e.attestations.flatMap((a) => a.relations || [])).length, 2, 'the relations were read');
});

test('one candidate in two sets with different scores: no score, and the conflict is reported', async () => {
  const other = candidateSet();
  other.candidates.find((c) => c['@id'] === SURREY_CANDIDATE).similarityScore = 50;
  const { r, byId } = await lpf(dataset(), await sets(candidateSet(), other));
  assert.equal('whg_match_score' in containedIn(byId, ROTHERHITHE)[0], false);
  assert.equal(loss(r, 'region-match-score-conflict')?.count, 1, JSON.stringify(losses(r).map((i) => i.kind)));
  assert.equal(containedIn(byId, SURREY)[0].whg_match_score, 98, 'the candidate both agree on keeps its score');
  // A control: the same candidate with the same score in both sets is no conflict.
  const same = await lpf(dataset(), await sets(candidateSet(), candidateSet()));
  assert.equal(containedIn(same.byId, ROTHERHITHE)[0].whg_match_score, 93);
  assert.equal(loss(same.r, 'region-match-score-conflict'), undefined);
});

test("a candidate set for another dataset is warned of; the pair check still decides the score", async () => {
  const other = candidateSet();
  other.candidateSet.candidatesFor = `${W}gazetteer/someone-else`;
  const { r, byId } = await lpf(dataset(), await sets(other));
  assert.equal(r.report.items.find((i) => i.kind === 'candidates-other-dataset')?.severity, 'warning');
  assert.equal(containedIn(byId, ROTHERHITHE)[0].whg_match_score, 93);
  const own = await lpf(dataset(), await sets(candidateSet()));
  assert.equal(own.r.report.items.find((i) => i.kind === 'candidates-other-dataset'), undefined, 'a control: its own set is not');
  assert.ok(own.r.report.items.length, 'the report is read');
});

test('a candidate found with no score is reported in its own words, not as missing', async () => {
  const s = candidateSet();
  delete s.candidates.find((c) => c['@id'] === SURREY_CANDIDATE).similarityScore;
  const { r, byId } = await lpf(dataset(), await sets(s));
  assert.equal('whg_match_score' in containedIn(byId, ROTHERHITHE)[0], false);
  assert.equal(loss(r, 'region-match-unscored')?.count, 1, JSON.stringify(losses(r).map((i) => i.kind)));
  assert.equal(loss(r, 'region-match-no-score'), undefined);
  assert.equal(containedIn(byId, SURREY)[0].whg_match_score, 98, 'a control: the scored candidate is used');
});

test('the command line: --candidates SET with convert --to lpf; refused for anything else', () => {
  const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'plato-tools-regions-'));
  try {
    const cli = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });
    const ok = cli('convert', '--to', 'lpf', '--out', dir, '--candidates', SET, DATASET);
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    const fc = JSON.parse(readFileSync(join(dir, 'place-centric-regions.geojson'), 'utf8'));
    const rel = fc.features.find((f) => f['@id'] === ROTHERHITHE).relations.find((x) => x.relationType === 'gvp:broaderPartitive');
    assert.equal(rel.whg_match_score, 93);
    const check = cli('check', '--candidates', SET, DATASET);
    assert.equal(check.status, 2); assert.match(check.stderr, /--candidates is for convert --to lpf/);
    const tables = cli('convert', '--to', 'tables', '--out', dir, '--candidates', SET, DATASET);
    assert.equal(tables.status, 2); assert.match(tables.stderr, /--candidates is for convert --to lpf/);
    const notASet = cli('convert', '--to', 'lpf', '--out', dir, '--overwrite', '--candidates', DATASET, DATASET);
    assert.equal(notASet.status, 2); assert.match(notASet.stderr, /not a candidate set/);
    const missing = join(dir, 'nowhere.json');
    const gone = cli('convert', '--to', 'lpf', '--out', dir, '--overwrite', '--candidates', missing, DATASET);
    assert.equal(gone.status, 2); assert.match(gone.stderr, /cannot be read/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
