import { PLATO_REPO } from './paths.js';
// The version check (src/engine/compare.js) and candidate sets (PLATO 05cf78a). A published candidate
// set is frozen as a whole (its address is minted from its candidates' texts): no candidate is
// deleted, changed in any field or added, its status stays the one it was issued with, since what
// became of it is read from the attestations that answer it, and its date of issue and its dataset do
// not change. So between two copies of one candidate set, a candidate removed, changed or added breaks
// the rule, and is reported by its address, as an attestation is; a corrected description is reported
// and allowed (the candidate set specification, 13.4). A dataset and a candidate
// set, or two different candidate sets, are not two versions of one thing, and are refused in words.
// On the dataset side, promotedFrom is part of what an attestation says, and a dataset's list of its
// candidate sets (gazetteer.candidateSets) is its description of itself: one gone is a warning.
//
// Each rule has a failing case and a control in the same test, built on PLATO's own examples: a
// comparison that finds nothing is worth something only if the same comparison could find something.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { env, textFile, go, outText } from './engine.js';
import { compare } from '../src/engine/compare.js';
import { detect } from '../src/engine/input.js';
import { summary } from '../src/engine/words.js';

const EX = `${PLATO_REPO}/schemas/examples`;
const SET = () => JSON.parse(readFileSync(`${EX}/candidate-set-judgements.json`, 'utf8'));
const DATASET = () => JSON.parse(readFileSync(`${EX}/attestation-centric-judgements.json`, 'utf8'));
const C1 = 'https://whgazetteer.org/example/candidates/county-survey-2026-09-09#c-8ed2901c';
const C2 = 'https://whgazetteer.org/example/candidates/county-survey-2026-09-09#c-1ec753bb';
const json = (d, name) => textFile(JSON.stringify(d), name);
/** A candidate set (or dataset) as JSON Lines: its header, then one candidate (or attestation) a line. */
const jsonl = (d, key, name) => { const { [key]: list, ...head } = d; return textFile([head, ...list].map((x) => JSON.stringify(x)).join('\n') + '\n', name); };
/** The example candidate set, edited by `edit`. */
const set = (edit = () => {}) => { const d = SET(); edit(d); return d; };

async function cmp(earlier, later) {
  const r = await compare({ earlier: await detect([earlier]), later: await detect([later]) }, env());
  return { ...r.report, incomplete: !!r.incomplete };
}
const kinds = (r, severity) => r.items.filter((i) => i.severity === severity).map((i) => i.kind).sort();
const item = (r, kind) => r.items.find((i) => i.kind === kind);
const SAME = { of: 'candidates', earlier: 2, later: 2, unchanged: 2, changed: 0, lost: 0, added: 0, retracted: 0, superseded: 0 };

// ---- reading -----------------------------------------------------------------------------------------
test('a candidate set is read for comparison as PLATO JSON, as JSON Lines and as RDF, and a copy compares clean', async () => {
  const nt = await go([json(SET(), 's.json')], 'convert', 'ntriples');
  const forms = [json(SET(), 'a.json'), jsonl(SET(), 'candidates', 'a.jsonl'), textFile(outText(nt.e, 's.nt'), 'a.nt')];
  for (const earlier of forms) for (const later of [json(SET(), 'b.json'), jsonl(SET(), 'candidates', 'b.jsonl')]) {
    const r = await cmp(earlier, later);
    assert.deepEqual([r.incomplete, r.items, r.counts], [false, [], SAME], `${earlier.name} against ${later.name}: ${JSON.stringify(r.items)}`);
  }
  // The control: the same reading of each form finds a candidate removed.
  for (const earlier of forms) {
    const r = await cmp(earlier, jsonl(set((d) => d.candidates.splice(1, 1)), 'candidates', 'b.jsonl'));
    assert.deepEqual([kinds(r, 'error'), item(r, 'candidate-removed')?.examples], [['candidate-removed'], [C2]], earlier.name);
  }
});

test('a sink that does not read candidates still has a candidate set refused, and the version check\'s is given it', async () => {
  const { run } = await import('../src/engine/pipeline.js');
  const input = await detect([json(SET(), 's.json')]);
  const plain = await run({ input, action: 'check', options: { sink: { header() {}, event() {}, async close() {} } } }, env());
  assert.deepEqual(plain.report.items.map((i) => i.kind), ['candidate-set-not-a-dataset']);
  const seen = [];
  const reads = await run({ input, action: 'check', options: { sink: { header: (h) => seen.push(h.profile), event() {}, candidate: (c) => seen.push(c['@id']), async close() {} } } }, env());
  assert.deepEqual([reads.report.errors, seen], [0, ['candidate-set', C1, C2]]);
});

// ---- two copies of one candidate set ---------------------------------------------------------------------
test('a candidate removed from a candidate set breaks the rule, named by its address', async () => {
  const r = await cmp(json(SET(), 'a.json'), json(set((d) => d.candidates.splice(0, 1)), 'b.json'));
  assert.deepEqual(kinds(r, 'error'), ['candidate-removed']);
  assert.deepEqual(item(r, 'candidate-removed').examples, [C1]);
  assert.deepEqual([r.counts.unchanged, r.counts.lost, r.counts.changed], [1, 1, 0]);
  assert.match(summary(r, 'compare').counted, /^Of 2 earlier candidates, 1 unchanged, 1 no longer there\. The later version has 1 candidate, 0 of them new\.$/);
  // The control: the set unchanged.
  const same = await cmp(json(SET(), 'a.json'), json(SET(), 'b.json'));
  assert.deepEqual([same.items, same.counts], [[], SAME]);
  assert.equal(summary(same, 'compare').problems, 'Nothing was deleted or changed.');
});

test('a candidate changed in any field breaks the rule, with what changed in it', async () => {
  const changes = {
    similarityScore: [0.95, 'plato:similarity_score "9.3E-1"^^xsd:double', 'plato:similarity_score "9.5E-1"^^xsd:double'],
    status: ['confirmed', 'plato:candidate_status "suggested"', 'plato:candidate_status "confirmed"'],
    subject: ['https://whgazetteer.org/example/entity/newton', 'plato:candidate_source <https://whgazetteer.org/example/entity/newton-by-the-river>', 'plato:candidate_source <https://whgazetteer.org/example/entity/newton>'],
    object: ['https://whgazetteer.org/example/county-survey/newton', 'plato:candidate_candidate <https://whgazetteer.org/example/county-survey/newton-mill>', 'plato:candidate_candidate <https://whgazetteer.org/example/county-survey/newton>'],
    algorithmVersion: ['matcher 2.2', 'plato:algorithm_version "matcher 2.1"', 'plato:algorithm_version "matcher 2.2"'],
    generatedAt: ['2026-09-10T18:00:00Z', 'plato:generated_at "2026-09-09T18:00:00Z"^^xsd:dateTime', 'plato:generated_at "2026-09-10T18:00:00Z"^^xsd:dateTime'],
    matchParameters: ['{"threshold":0.7}', 'plato:match_parameters "{\\"threshold\\":0.8,\\"weights\\":{\\"distance\\":0.4,\\"name\\":0.5,\\"type\\":0.1}}"', 'plato:match_parameters "{\\"threshold\\":0.7}"'],
  };
  for (const [key, [value, was, is]] of Object.entries(changes)) {
    const r = await cmp(json(SET(), 'a.json'), json(set((d) => { d.candidates[0][key] = value; }), 'b.json'));
    assert.deepEqual(kinds(r, 'error'), ['candidate-changed'], `${key}: ${JSON.stringify(r.items)}`);
    assert.deepEqual(item(r, 'candidate-changed').explained, [{ example: C1, earlier: [was], later: [is] }], key);
    assert.deepEqual([r.counts.unchanged, r.counts.changed, r.counts.lost], [1, 1, 0], key);
  }
  // A status the profile no longer allows is the later version's own problem too, which the check
  // counts but does not list; the comparison is of the whole of it.
  const status = await cmp(json(SET(), 'a.json'), json(set((d) => { d.candidates[1].status = 'rejected'; }), 'b.json'));
  assert.deepEqual([kinds(status, 'error'), kinds(status, 'warning'), item(status, 'candidate-changed').examples], [['candidate-changed'], ['version-has-problems'], [C2]]);
  // A field taken away is a change too (matchParameters is optional).
  const gone = await cmp(json(SET(), 'a.json'), json(set((d) => { delete d.candidates[1].matchParameters; }), 'b.json'));
  assert.deepEqual([kinds(gone, 'error'), item(gone, 'candidate-changed').examples, item(gone, 'candidate-changed').explained[0].later], [['candidate-changed'], [C2], []]);
  // The control: the same edit made to both versions changes nothing between them.
  const both = set((d) => { d.candidates[0].similarityScore = 0.95; });
  const r = await cmp(json(both, 'a.json'), json(both, 'b.json'));
  assert.deepEqual([r.items, r.counts], [[], SAME]);
});

test('a candidate given another address, or none, breaks the rule as a readdressing', async () => {
  const r = await cmp(json(SET(), 'a.json'), json(set((d) => { d.candidates[0]['@id'] = C1.replace('8ed2901c', '8ed2901c0000'); }), 'b.json'));
  assert.deepEqual([kinds(r, 'error'), item(r, 'candidate-readdressed').examples, r.counts.changed], [['candidate-readdressed'], [C1], 1]);
  // The control: its address back, nothing to report.
  assert.deepEqual((await cmp(json(SET(), 'a.json'), json(SET(), 'b.json'))).items, []);
});

test('a candidate added to a candidate set breaks the rule, named by its address: new suggestions go in a new set', async () => {
  const C3 = C2.replace('1ec753bb', '5a5a5a5a');
  const extra = (d) => d.candidates.push({ ...d.candidates[1], '@id': C3, object: 'https://whgazetteer.org/example/county-survey/newton-fen' });
  const r = await cmp(json(SET(), 'a.json'), json(set(extra), 'b.json'));
  assert.deepEqual([r.incomplete, kinds(r, 'error'), kinds(r, 'warning'), item(r, 'candidate-added').examples], [false, ['candidate-added'], [], [C3]]);
  assert.match(item(r, 'candidate-added').message, /new suggestions belong in a new candidate set/);
  assert.deepEqual(r.counts, { ...SAME, later: 3, added: 1 });
  assert.equal(summary(r, 'compare').problems, '1 problem found.');
  assert.match(summary(r, 'compare').counted, /The later version has 3 candidates, 1 of them new\.$/);
  // Read as JSON Lines, the same.
  const l = await cmp(jsonl(SET(), 'candidates', 'a.jsonl'), jsonl(set(extra), 'candidates', 'b.jsonl'));
  assert.deepEqual(item(l, 'candidate-added')?.examples, [C3]);
  // Added with an earlier candidate dropped: both are found.
  const s = await cmp(json(SET(), 'a.json'), json(set((d) => { extra(d); d.candidates.splice(0, 1); }), 'b.json'));
  assert.deepEqual([kinds(s, 'error'), item(s, 'candidate-added').examples, s.counts.added, s.counts.lost], [['candidate-added', 'candidate-removed'], [C3], 1, 1]);
  // A candidate given a new address is readdressed, not added as well.
  const moved = await cmp(json(SET(), 'a.json'), json(set((d) => { d.candidates[0]['@id'] = C1.replace('8ed2901c', '8ed2901c0000'); }), 'b.json'));
  assert.deepEqual(kinds(moved, 'error'), ['candidate-readdressed']);
  // The controls: identical sets, and the same addition made to both, give nothing.
  for (const d of [SET(), set(extra)]) {
    const same = await cmp(json(d, 'a.json'), json(d, 'b.json'));
    assert.deepEqual([same.items, same.counts.added], [[], 0]);
  }
});

test('a candidate set\'s date of issue and its dataset are frozen with it: a change to either breaks the rule', async () => {
  const edits = {
    'candidate-set-issued-changed': [(d) => { d.candidateSet.issued = '2026-09-10'; }, '2026-09-09, then 2026-09-10'],
    'candidate-set-for-changed': [(d) => { d.candidateSet.candidatesFor = 'https://whgazetteer.org/example/gazetteer/other'; }, 'https://whgazetteer.org/example/gazetteer/fen-parishes, then https://whgazetteer.org/example/gazetteer/other'],
  };
  for (const [kind, [edit, example]] of Object.entries(edits)) {
    const r = await cmp(json(SET(), 'a.json'), json(set(edit), 'b.json'));
    assert.deepEqual([kinds(r, 'error'), kinds(r, 'warning'), item(r, kind).examples, r.counts], [[kind], [], [example], SAME], kind);
    // The control: identical sets, and the same edit made to both, give nothing.
    for (const d of [SET(), set(edit)]) assert.deepEqual((await cmp(json(d, 'a.json'), json(d, 'b.json'))).items, [], kind);
  }
});

test('a candidate set\'s description may be corrected: reported, and allowed', async () => {
  const fields = {
    title: (d) => { d.candidateSet.title = 'Another title'; },
    description: (d) => { d.candidateSet.description = 'Corrected.'; },
    creator: (d) => { d.candidateSet.creator = [{ name: 'Someone else' }]; },
    licence: (d) => { d.candidateSet.licence = 'https://creativecommons.org/publicdomain/zero/1.0/'; },
  };
  for (const [field, edit] of Object.entries(fields)) {
    const r = await cmp(json(SET(), 'a.json'), json(set(edit), 'b.json'));
    assert.deepEqual([kinds(r, 'error'), kinds(r, 'warning'), item(r, 'candidate-set-described-changed').examples, r.counts], [[], ['candidate-set-described-changed'], [field], SAME], field);
  }
  const all = await cmp(json(SET(), 'a.json'), json(set((d) => { for (const edit of Object.values(fields)) edit(d); }), 'b.json'));
  assert.deepEqual(item(all, 'candidate-set-described-changed').examples, ['title, description, creator, licence']);
  assert.equal(summary(all, 'compare').problems, 'Nothing was deleted or changed.');
  // The control: identical sets give nothing.
  assert.deepEqual((await cmp(json(SET(), 'a.json'), json(SET(), 'b.json'))).items, []);
});

// ---- what is not two versions of one thing ---------------------------------------------------------------
test('a dataset and a candidate set are refused in words, either way round', async () => {
  for (const [a, b] of [[json(DATASET(), 'd.json'), json(SET(), 's.json')], [jsonl(SET(), 'candidates', 's.jsonl'), json(DATASET(), 'd.json')]]) {
    const r = await cmp(a, b);
    assert.deepEqual([r.incomplete, kinds(r, 'error')], [true, ['different-kinds']], `${a.name} against ${b.name}`);
    assert.match(item(r, 'different-kinds').message, /One file is a dataset and the other a candidate set/);
    assert.equal(summary(r, 'compare').problems, 'The two versions could not be compared.');
  }
  // The controls: each against itself.
  assert.equal((await cmp(json(DATASET(), 'd.json'), json(DATASET(), 'e.json'))).incomplete, false);
  assert.equal((await cmp(json(SET(), 's.json'), json(SET(), 't.json'))).incomplete, false);
});

test('two different candidate sets are not two versions of one, and are refused in words', async () => {
  const other = set((d) => { d.candidateSet['@id'] += '-rerun'; for (const c of d.candidates) c['@id'] = c['@id'].replace('#', '-rerun#'); });
  const r = await cmp(json(SET(), 'a.json'), json(other, 'b.json'));
  assert.deepEqual([r.incomplete, kinds(r, 'error'), r.items.length], [true, ['different-candidate-set'], 1]);
  assert.match(item(r, 'different-candidate-set').message, /a later run of the software is a new set/);
});

// ---- the dataset side ------------------------------------------------------------------------------------
const published = (edit = () => {}) => { const d = DATASET(); Object.assign(d.gazetteer, { status: 'published', licence: 'https://creativecommons.org/licenses/by/4.0/' }); edit(d); return d; };

test('promotedFrom is part of what an attestation says: changed, added or taken away, it breaks the rule', async () => {
  const P2 = 'https://whgazetteer.org/example/candidates/county-survey-2026-09-09#c-00000000';
  const edits = {
    changed: (d) => { d.attestations[0].identities[0].promotedFrom = P2; },
    removed: (d) => { delete d.attestations[1].identities[0].promotedFrom; },
  };
  // The example's identity relations have addresses: each is part of what its attestation says (a facet).
  for (const [what, edit] of Object.entries(edits)) {
    const r = await cmp(json(published(), 'a.json'), json(published(edit), 'b.json'));
    assert.deepEqual(kinds(r, 'error'), ['facet-changed'], `${what}: ${JSON.stringify(r.items)}`);
  }
  const ex = item(await cmp(json(published(), 'a.json'), json(published(edits.changed), 'b.json')), 'facet-changed').explained[0];
  assert.deepEqual(ex, { example: 'https://whgazetteer.org/example/identity/river-mill-2', earlier: [`plato:promoted_from <${C1}>`], later: [`plato:promoted_from <${P2}>`] });
  // Without addresses, the relation is written out in the attestation's own statements.
  const bare = (edit = () => {}) => published((d) => { for (const a of d.attestations) for (const i of a.identities) delete i['@id']; edit(d); });
  const added = await cmp(json(bare((d) => { delete d.attestations[0].identities[0].promotedFrom; }), 'a.json'), json(bare(), 'b.json'));
  assert.deepEqual([kinds(added, 'error'), item(added, 'attestation-changed').examples], [['attestation-changed'], ['https://whgazetteer.org/example/attestation/newton-river-mill']]);
  assert.match(item(added, 'attestation-changed').explained[0].later[0], /plato:promoted_from/);
  // The controls: each version against itself.
  for (const d of [published(), bare()]) assert.deepEqual((await cmp(json(d, 'a.json'), json(d, 'b.json'))).items, []);
});

test('a candidate set gone from a dataset\'s list is a warning, one added to it nothing', async () => {
  const S1 = 'https://whgazetteer.org/example/candidates/county-survey-2026-09-09', S2 = 'https://whgazetteer.org/example/candidates/county-survey-2026-10-01';
  const unlisted = published((d) => { d.gazetteer.candidateSets = [S2]; });
  const r = await cmp(json(published(), 'a.json'), json(unlisted, 'b.json'));
  assert.deepEqual([kinds(r, 'error'), kinds(r, 'warning'), item(r, 'candidate-set-unlisted').examples], [[], ['candidate-set-unlisted'], [S1]]);
  // Read through RDF too: the list comes back as the reverse of plato:candidates_for.
  const nt = await go([json(unlisted, 'b.json')], 'convert', 'ntriples');
  const viaRdf = await cmp(json(published(), 'a.json'), textFile(outText(nt.e, 'b.nt'), 'b.nt'));
  assert.deepEqual(item(viaRdf, 'candidate-set-unlisted')?.examples, [S1]);
  // The key taken away altogether is the same loss.
  const none = await cmp(json(published(), 'a.json'), json(published((d) => { delete d.gazetteer.candidateSets; }), 'b.json'));
  assert.deepEqual(kinds(none, 'warning'), ['candidate-set-unlisted']);
  // The controls: a set added, and the dataset under a new address of its own (a new version is),
  // with its list as it was. Neither is reported.
  const more = await cmp(json(published(), 'a.json'), json(published((d) => { d.gazetteer.candidateSets.push(S2); d.gazetteer['@id'] += '/2'; }), 'b.json'));
  assert.deepEqual([more.items, more.counts.unchanged], [[], 2]);
});
