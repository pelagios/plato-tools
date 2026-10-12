import { PLATO_REPO } from './paths.js';
// Krisis: a decision changed after its answer was written into the dataset withdraws that answer in the
// same run (src/engine/krisis/withdraw.js; the candidate set specification, 2.3 and 13.5; plato:Retracts,
// plato:Supersedes), and the version check catches a changed answer that does not (answered-both-ways).
//
// Each case finishes a review into the dataset, changes a decision, and finishes again ON THE DATASET
// WRITTEN, as a published dataset must be revised: then it reads the current state of the answers, and
// requires exactly one current answer and the withdrawal. Every absence is paired with a presence in the
// same test: "no answered-both-ways" is asserted beside the count of what was withdrawn, and the check
// that finds it is shown finding it on the same data without the withdrawal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, textFile, outText } from './engine.js';
import { detect } from '../src/engine/input.js';
import { match } from '../src/engine/krisis/match.js';
import { serialiseWork, decide } from '../src/engine/krisis/work.js';
import { apply, checkAppendOnly } from '../src/engine/krisis/apply.js';
import { answerSig, sameContributor } from '../src/engine/krisis/withdraw.js';
import { compare } from '../src/engine/compare.js';
import { publish } from '../src/engine/agora/index.js';
import { Report } from '../src/engine/report.js';
import { collectWithdrawn, resolveWithdrawn } from '../src/formats/shared.js';
import { summary } from '../src/engine/words.js';

void PLATO_REPO;
const P = 'https://w3id.org/plato#', X = 'https://example.org/';
const A = (id) => `${X}a/${id}`, B = (id) => `${X}b/${id}`;
const src = { '@id': X + 'source/s', title: 'S' };
const at = (lon, lat) => ({ geometries: [{ geojson: { type: 'Point', coordinates: [lon, lat] } }], sources: [src] });
const place = (iri, label, attestations) => ({ '@id': iri, label, attestations });
const G = { '@id': X + 'a/', title: 'Dataset A', licence: 'https://creativecommons.org/licenses/by/4.0/', status: 'published', version: '1' };
const subjectsDoc = (g = G) => ({ profile: 'place-centric', gazetteer: g, spatialEntities: [place(A('newton'), 'Newton', [at(-1.0, 52.0)])] });
const othersDoc = () => ({ profile: 'place-centric', gazetteer: { '@id': X + 'b/', title: 'Dataset B' }, spatialEntities: [
  place(B('newton'), 'Newton', [at(-1.01, 52.01)]), place(B('newtown'), 'Newtown', [at(-1.02, 52.0)])] });
const json = (d, name) => textFile(JSON.stringify(d), name);
const reviewer = { name: 'A. Reviewer', orcid: 'https://orcid.org/0000-0002-1825-0097' };

/** A review of Newton against B's Newton and Newtown, with `decisions` ({ object: [kind, options] }) made. */
async function reviewed(decisions, g) {
  const subjects = await detect([json(subjectsDoc(g), 'a.json')]);
  const { work } = await match({ subjects, others: await detect([json(othersDoc(), 'b.json')]), options: {} }, env());
  assert.deepEqual(work.candidates.map((c) => c.candidate_candidate).sort(), [B('newton'), B('newtown')], 'both of B\'s places are suggested');
  work.reviewer = reviewer;
  redecide(work, decisions);
  return { subjects, work };
}
function redecide(work, decisions) {
  for (const [object, [kind, o = {}]] of Object.entries(decisions)) decide(work, work.candidates.find((c) => c.candidate_candidate === object).id, kind, o);
  return work;
}
/** Finish `work` on `subjects` (an input), into the dataset. */
async function finish(subjects, work, options = {}) {
  const e = env();
  const r = await apply({ subjects, work: JSON.parse(serialiseWork(work)), options }, e);
  const text = r.outputs.length ? outText(e, r.outputs[0].name) : null;
  return { r, text, doc: text && JSON.parse(text) };
}
const asInput = (text, name = 'a.krisis-dataset.json') => detect([textFile(text, name)]);
/** Newton's attestations in a dataset written. */
const newton = (doc) => doc.spatialEntities.find((p) => p['@id'] === A('newton')).attestations;
/** The answers about Newton that are current: not retracted or superseded. */
function current(doc) {
  const atts = newton(doc);
  const withdrawn = resolveWithdrawn(collectWithdrawn(atts)).status;
  return atts.filter((a) => a.identities && !(a['@id'] && withdrawn.has(a['@id'])))
    .map((a) => `${a.negated ? 'not ' : ''}${a.identities.map((r) => r.object.slice(X.length)).join(' + ')}`);
}
const metas = (doc) => newton(doc).filter((a) => a.meta).map((a) => [a.meta.metaType.slice(P.length), a.meta.targetAttestation, !!a.identities]);
const kinds = (r) => r.report.items.map((i) => i.kind);
/** The version check from one dataset to the next, as a user would run it. */
async function mneme(earlierText, laterText) {
  return (await compare({ earlier: await asInput(earlierText, 'v1.json'), later: await asInput(laterText, 'v2.json') }, env())).report;
}

test('accepted, then rejected ("different places"): the acceptance is retracted, the denial written, and one answer is current', async () => {
  const { subjects, work } = await reviewed({ [B('newton')]: ['match', { at: '2026-10-01T09:00:00Z' }] });
  const v1 = await finish(subjects, work);
  assert.equal(v1.r.report.errors, 0, JSON.stringify(v1.r.report.items));
  assert.deepEqual(current(v1.doc), ['b/newton']);
  const first = newton(v1.doc).find((a) => a.identities);
  assert.match(first['@id'], new RegExp(`^${A('newton')}#a-[0-9a-f]{8}$`), 'the answer is given an address in Agora\'s form');
  redecide(work, { [B('newton')]: ['distinct', { basis: 'The mill, not the village.', at: '2026-10-02T09:00:00Z' }] });
  const v2 = await finish(await asInput(v1.text), work);
  assert.equal(v2.r.report.errors, 0, JSON.stringify(v2.r.report.items));
  assert.deepEqual(current(v2.doc), ['not b/newton'], 'exactly one current answer: the denial');
  assert.deepEqual(metas(v2.doc), [['Retracts', first['@id'], false]], 'the acceptance is retracted by an attestation of its own');
  const retraction = newton(v2.doc).find((a) => a.meta);
  assert.equal(retraction.created, '2026-10-02T09:00:00Z', 'dated by the changed decision');
  assert.deepEqual(retraction.contributor, { name: reviewer.name, orcid: reviewer.orcid }, 'withdrawn by whoever made it');
  assert.ok(newton(v2.doc).includes(first) || newton(v2.doc).some((a) => a['@id'] === first['@id'] && answerSig(a) === answerSig(first)), 'the earlier answer is kept, as it was');
  assert.equal(v2.r.report.counts.retracted, 1);
  assert.deepEqual([v2.r.report.counts.versionCheck.retracted, v2.r.report.counts.versionCheck.superseded], [1, 0]);
  // The version check, as a user would run it on the two versions: nothing deleted or changed, the retraction counted, no answer both ways.
  const m = await mneme(v1.text, v2.text);
  assert.equal(m.errors, 0, JSON.stringify(m.items));
  assert.equal(m.counts.retracted, 1, 'presence: the withdrawal is seen');
  assert.ok(!m.items.some((i) => i.kind === 'answered-both-ways'));
  assert.match(summary(v2.r.report, 'apply').counted, /1 withdrawing an earlier answer \(plato:Retracts\)/);
});

test('accepted, then "not this one": the acceptance is retracted and nothing else is written', async () => {
  const { subjects, work } = await reviewed({ [B('newton')]: ['match', { at: '2026-10-01T09:00:00Z' }] });
  const v1 = await finish(subjects, work);
  redecide(work, { [B('newton')]: ['not-this', { at: '2026-10-02T09:00:00Z' }] });
  const v2 = await finish(await asInput(v1.text), work);
  assert.equal(v2.r.report.errors, 0, JSON.stringify(v2.r.report.items));
  assert.deepEqual(current(v2.doc), [], 'no answer is current');
  assert.deepEqual(metas(v2.doc).map((x) => x[0]), ['Retracts']);
  assert.equal(newton(v2.doc).length, newton(v1.doc).length + 1, 'one attestation added: the retraction');
});

test('accepted A, then B: the acceptance of B supersedes that of A', async () => {
  const { subjects, work } = await reviewed({ [B('newton')]: ['match', { at: '2026-10-01T09:00:00Z' }] });
  const v1 = await finish(subjects, work);
  const first = newton(v1.doc).find((a) => a.identities);
  redecide(work, { [B('newton')]: ['not-this', { at: '2026-10-02T09:00:00Z' }], [B('newtown')]: ['match', { at: '2026-10-02T09:01:00Z' }] });
  const v2 = await finish(await asInput(v1.text), work);
  assert.equal(v2.r.report.errors, 0, JSON.stringify(v2.r.report.items));
  assert.deepEqual(current(v2.doc), ['b/newtown'], 'exactly one current answer: B');
  assert.deepEqual(metas(v2.doc), [['Supersedes', first['@id'], true]], 'the new answer is itself the supersession (plato:Supersedes replaces its target with newer information)');
  assert.deepEqual([v2.r.report.counts.superseded, v2.r.report.counts.retracted ?? 0], [1, 0]);
  const m = await mneme(v1.text, v2.text);
  assert.equal(m.errors, 0, JSON.stringify(m.items));
  assert.deepEqual([m.counts.superseded, m.counts.retracted], [1, 0]);
});

test('rejected ("different places"), then accepted: the denial is retracted and the acceptance written', async () => {
  const { subjects, work } = await reviewed({ [B('newton')]: ['distinct', { basis: 'A namesake.', at: '2026-10-01T09:00:00Z' }] });
  const v1 = await finish(subjects, work);
  assert.deepEqual(current(v1.doc), ['not b/newton']);
  const denial = newton(v1.doc).find((a) => a.negated);
  redecide(work, { [B('newton')]: ['match', { at: '2026-10-02T09:00:00Z' }] });
  const v2 = await finish(await asInput(v1.text), work);
  assert.equal(v2.r.report.errors, 0, JSON.stringify(v2.r.report.items));
  assert.deepEqual(current(v2.doc), ['b/newton'], 'exactly one current answer: the acceptance');
  assert.deepEqual(metas(v2.doc), [['Retracts', denial['@id'], false]], 'a denial is never superseded by an acceptance: it is retracted');
  const m = await mneme(v1.text, v2.text);
  assert.equal(m.errors, 0, JSON.stringify(m.items));
  assert.equal(m.counts.retracted, 1);
});

test('a decision made again, unchanged, writes nothing new; the control, the same review finished on the original, writes it', async () => {
  const { subjects, work } = await reviewed({ [B('newton')]: ['match', { at: '2026-10-01T09:00:00Z' }], [B('newtown')]: ['distinct', { basis: 'A farm.', at: '2026-10-01T09:01:00Z' }] });
  const v1 = await finish(subjects, work);
  assert.deepEqual(current(v1.doc).sort(), ['b/newton', 'not b/newtown']);
  // The same decisions made again, later: the same answers.
  redecide(work, { [B('newton')]: ['match', { at: '2026-10-05T09:00:00Z' }], [B('newtown')]: ['distinct', { basis: 'A farm.', at: '2026-10-05T09:01:00Z' }] });
  const again = await finish(await asInput(v1.text), work);
  assert.equal(again.r.report.errors, 0, JSON.stringify(again.r.report.items));
  assert.deepEqual(again.r.outputs, [], 'nothing written');
  assert.ok(kinds(again.r).includes('nothing-new') && kinds(again.r).includes('already-answered'), JSON.stringify(again.r.report.items));
  assert.equal(again.r.report.items.find((i) => i.kind === 'already-answered').count, 2);
  // Control: on the original dataset, which has no answers yet, the same review is written in full.
  const control = await finish(subjects, work);
  assert.equal(control.r.report.counts.attestations, 2);
  assert.ok(!kinds(control.r).includes('already-answered'));
  // And a basis corrected is a change: the denial is superseded by the corrected one (presence beside the absence above).
  redecide(work, { [B('newtown')]: ['distinct', { basis: 'A farm, on the tithe map.', at: '2026-10-06T09:00:00Z' }] });
  const corrected = await finish(await asInput(v1.text), work);
  assert.equal(corrected.r.report.errors, 0, JSON.stringify(corrected.r.report.items));
  assert.deepEqual(metas(corrected.doc).map((x) => x[0]), ['Supersedes']);
  assert.deepEqual(current(corrected.doc).sort(), ['b/newton', 'not b/newtown']);
  assert.equal(corrected.r.report.counts.unchanged, 1, 'the acceptance, unchanged, is not written again');
});

test('a taken-back decision says nothing: the earlier answer is kept', async () => {
  const { subjects, work } = await reviewed({ [B('newton')]: ['match', { at: '2026-10-01T09:00:00Z' }] });
  const v1 = await finish(subjects, work);
  redecide(work, { [B('newtown')]: ['match', { at: '2026-10-02T09:00:00Z' }] });
  work.candidates.find((c) => c.candidate_candidate === B('newton')).decision = null;
  work.candidates.find((c) => c.candidate_candidate === B('newton')).candidate_status = 'suggested';
  const v2 = await finish(await asInput(v1.text), work);
  assert.equal(v2.r.report.errors, 0, JSON.stringify(v2.r.report.items));
  assert.deepEqual(metas(v2.doc), [], 'nothing withdrawn');
  assert.deepEqual(current(v2.doc).sort(), ['b/newton', 'b/newtown'], 'presence: the new answer is written beside the one kept');
});

test('another reviewer\'s answer is never withdrawn', async () => {
  const { subjects, work } = await reviewed({ [B('newton')]: ['match', { at: '2026-10-01T09:00:00Z' }] });
  const v1 = await finish(subjects, work);
  redecide(work, { [B('newton')]: ['not-this', { at: '2026-10-02T09:00:00Z' }] });
  work.reviewer = { name: 'Someone Else' };
  const v2 = await finish(await asInput(v1.text), work);
  assert.deepEqual(v2.r.outputs, [], 'nothing to write: not this one writes nothing, and the answer is not this reviewer\'s');
  assert.ok(kinds(v2.r).includes('nothing-decided'));
  // Control: the reviewer who made it withdraws it.
  work.reviewer = reviewer;
  const v3 = await finish(await asInput(v1.text), work);
  assert.deepEqual(metas(v3.doc).map((x) => x[0]), ['Retracts']);
  assert.ok(sameContributor({ name: 'A. Reviewer', orcid: '0000-0002-1825-0097' }, reviewer), 'an ORCID is the same written bare or as an address');
  assert.ok(!sameContributor({ name: 'A. Reviewer', orcid: '0000-0002-1825-0098' }, reviewer), 'two ORCIDs: the name is not enough');
});

test('an earlier answer with no address is given the one Agora\'s minting would give it, in the dataset written; the attestations-only file refuses', async () => {
  const { subjects, work } = await reviewed({ [B('newton')]: ['match', { at: '2026-10-01T09:00:00Z' }] });
  const v1 = await finish(subjects, work);
  // As a review finished before Krisis gave addresses wrote it.
  const bare = JSON.parse(v1.text);
  for (const a of newton(bare)) delete a['@id'];
  const bareText = JSON.stringify(bare);
  // What Agora's minting gives it.
  const e = env();
  const minted = await publish({ part: 'mint', input: await asInput(bareText, 'bare.json'), options: { name: 'bare.json', base: X + 'a/' } }, e);
  const agoraId = outText(e, minted.outputs[0].name).trim().split('\n').slice(1).map((l) => JSON.parse(l)).find((p) => p['@id'] === A('newton')).attestations.find((a) => a.identities)['@id'];
  assert.equal(agoraId, newton(v1.doc).find((a) => a.identities)['@id'], 'Krisis gives an answer the address Agora would');
  redecide(work, { [B('newton')]: ['not-this', { at: '2026-10-02T09:00:00Z' }] });
  const v2 = await finish(await asInput(bareText), work);
  assert.equal(v2.r.report.errors, 0, JSON.stringify(v2.r.report.items));
  const given = newton(v2.doc).find((a) => a.identities);
  assert.equal(given['@id'], agoraId, 'the earlier answer now has its address');
  assert.deepEqual(metas(v2.doc), [['Retracts', agoraId, false]]);
  assert.ok(kinds(v2.r).includes('answers-addressed'));
  const m = await mneme(bareText, v2.text);
  assert.equal(m.errors, 0, JSON.stringify(m.items));
  assert.equal(m.counts.retracted, 1, 'the version check counts a withdrawal of an answer given its address in the later version');
  // The attestations-only output cannot give it one.
  const e2 = env();
  const a = await apply({ subjects: await asInput(bareText), work: JSON.parse(serialiseWork(work)), options: { output: 'attestations' } }, e2);
  assert.ok(a.incomplete && kinds(a).includes('answer-unaddressed'), JSON.stringify(a.report.items));
  // Control: with the address, the attestations-only output withdraws it.
  const b = await apply({ subjects: await asInput(v1.text), work: JSON.parse(serialiseWork(work)), options: { output: 'attestations' } }, env());
  assert.equal(b.report.errors, 0, JSON.stringify(b.report.items));
  assert.equal(b.report.counts.retracted, 1);
});

test('Agora\'s minting keeps every address Krisis gives', async () => {
  const { subjects, work } = await reviewed({ [B('newton')]: ['match', { at: '2026-10-01T09:00:00Z' }], [B('newtown')]: ['distinct', { basis: 'A farm.', at: '2026-10-01T09:01:00Z' }] });
  const v1 = await finish(subjects, work);
  const ids = newton(v1.doc).filter((a) => a.identities).map((a) => a['@id']);
  assert.equal(ids.length, 2);
  assert.ok(ids.every((id) => /#a-[0-9a-f]{8}$/.test(id)), ids.join(' '));
  const e = env();
  const minted = await publish({ part: 'mint', input: await asInput(v1.text, 'v1.json'), options: { name: 'v1.json', base: X + 'a/' } }, e);
  const after = outText(e, minted.outputs[0].name).trim().split('\n').slice(1).map((l) => JSON.parse(l)).find((p) => p['@id'] === A('newton')).attestations;
  assert.deepEqual(after.filter((a) => a.identities).map((a) => a['@id']), ids);
  assert.equal(after.filter((a) => a['@id'] && !ids.includes(a['@id'])).length, 1, 'presence: the point attestation, which had none, was given one');
});

// ---- the version check: answered both ways ------------------------------------------------------------
const answer = (id, object, negated, who = { name: 'Ada' }) => ({ '@id': A('newton') + '#' + id, identities: [{ subject: A('newton'), object, identityType: 'exactMatch' }], ...(negated ? { negated: true } : {}), contributor: who, created: '2026-10-01T09:00:00Z', sources: [src] });
const retract = (id, target) => ({ '@id': A('newton') + '#' + id, meta: { targetAttestation: A('newton') + '#' + target, metaType: P + 'Retracts' }, contributor: { name: 'Ada' }, created: '2026-10-02T09:00:00Z', sources: [src] });
const version = (atts, g = G) => JSON.stringify({ profile: 'place-centric', gazetteer: g, spatialEntities: [place(A('newton'), 'Newton', atts)] });
test('the version check: a changed answer that does not withdraw the earlier one is found, and named', async () => {
  const v1 = version([answer('yes', B('newton'), false)]);
  const both = await mneme(v1, version([answer('yes', B('newton'), false), answer('no', B('newton'), true)]));
  const found = both.items.find((i) => i.kind === 'answered-both-ways');
  assert.ok(found && found.severity === 'error', JSON.stringify(both.items));
  assert.deepEqual(found.examples, [`Ada: ${A('newton')} and ${B('newton')}`]);
  // Control: the same with the yes retracted passes, and the retraction is counted (presence).
  const withdrawn = await mneme(v1, version([answer('yes', B('newton'), false), answer('no', B('newton'), true), retract('r', 'yes')]));
  assert.equal(withdrawn.errors, 0, JSON.stringify(withdrawn.items));
  assert.equal(withdrawn.counts.retracted, 1);
  // Two reviewers may disagree: not a changed answer.
  const two = await mneme(v1, version([answer('yes', B('newton'), false), answer('no', B('newton'), true, { name: 'Bea' })]));
  assert.ok(!two.items.some((i) => i.kind === 'answered-both-ways'), JSON.stringify(two.items));
  assert.equal(two.counts.added, 1, 'presence: the other reviewer\'s answer is seen, as added');
  // Both ways already in the earlier version is not this version's doing.
  const old = version([answer('yes', B('newton'), false), answer('no', B('newton'), true)]);
  assert.ok(!(await mneme(old, old)).items.some((i) => i.kind === 'answered-both-ways'));
  // A draft binds nothing yet: said as a warning.
  const draft = { ...G, status: 'draft' };
  const d = await mneme(version([answer('yes', B('newton'), false)], draft), version([answer('yes', B('newton'), false), answer('no', B('newton'), true)], draft));
  assert.equal(d.items.find((i) => i.kind === 'answered-both-ways')?.severity, 'warning', JSON.stringify(d.items));
});

test('finishing reads the version check\'s count of withdrawals, and fails a dataset written without them', async () => {
  const v1 = version([answer('yes', B('newton'), false)]);
  const later = (atts) => new File([version(atts)], 'v2.json');
  const run = async (atts, withdrawing) => { const rep = new Report(); await checkAppendOnly({ earlier: await asInput(v1, 'v1.json'), later: later(atts), added: atts.length - 1, withdrawing }, env(), rep); return rep.toJSON(); };
  const ok = await run([answer('yes', B('newton'), false), retract('r', 'yes')], { retracted: 1, superseded: 0 });
  assert.equal(ok.errors, 0, JSON.stringify(ok.items));
  const dropped = await run([answer('yes', B('newton'), false), answer('no', B('newton'), true)], { retracted: 1, superseded: 0 });
  assert.deepEqual(dropped.items.filter((i) => i.severity === 'error').map((i) => i.kind).sort(), ['not-all-withdrawn', 'not-append-only'], JSON.stringify(dropped.items));
});
