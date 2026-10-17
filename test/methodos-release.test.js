// Methodos: "Release a new version" (src/engine/methodos/recipes/release-a-new-version.js; plan #34, item 10;
// Issue #23; Stephen's decisions of 17 October 2026): its plan, the interview's route to it (a dataset in a
// PLATO format, a new version of a published dataset: once a dead end), the previous release chosen late (at
// the revise step, runner.supply) and checked by its hash from then on, and the workflow walked end to end
// in Node with the engine's real calls on PLATO's Antonine example, minted first as the previous release and
// then edited three ways (an attestation deleted, one changed, a place dropped, and one added), through
// revising, checking, comparing, writing out, minting against the previous release, the FAIR report, the site
// and the w3id rules. Nothing goes on the network: fetch is replaced by one that throws, beside a call showing it.
//
// Every refusal or absence is paired with the presence it is told from, and the end result is shown failing on
// a mutation of the same file (a step that skipped its work would leave it so).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { openSqlite } from '../src/lib/store.js';
import { res, env, textFile, outText } from './engine.js';
import { PLATO_REPO } from './paths.js';
import { detect } from '../src/engine/input.js';
import { publish } from '../src/engine/agora/index.js';
import { HAVE, WANT, choose, questionsFor, answersFor, answered, baseAsked, plan } from '../src/engine/methodos/interview.js';
import { RECIPES, OPERATIONS, ADAPTERS, runner, drive, refsOf, checkRecipe, digest, checkChosen, exportRecord, importRecord, recordOf, filesWords } from '../src/engine/methodos/index.js';
import { collectWithdrawn, resolveWithdrawn } from '../src/formats/shared.js';

const R = RECIPES['release-a-new-version'], PUBLISH = RECIPES['publish-a-dataset'];
const BASE = 'https://w3id.org/release-test/';
const ANSWERS = { 'will-publish': false, target: 'plato-json' };

// ---- no network: fetch throws, here and in every test below ------------------------------------------------
const realFetch = globalThis.fetch;
const asked = [];
globalThis.fetch = async (url) => { asked.push(String(url)); throw new Error(`No network in these tests: ${url}`); };
test.after(() => { globalThis.fetch = realFetch; });
test('the fetch these tests run with throws (the presence: a call is refused and counted), so that a walk that reached the network would fail', async () => {
  const before = asked.length;
  await assert.rejects(() => fetch('https://whgazetteer.org/reconcile'), /No network in these tests/);
  assert.equal(asked.length, before + 1);
});

// ---- a host in memory, as methodos.test.js has it -----------------------------------------------------------
function memoryHost(initial) {
  const store = new Map(initial.map((f) => [f.name, f]));
  return {
    store,
    reviewer: { name: 'Release Reviewer' },   // who signs the retractions: the page's remembered name, here the test's
    open: async (r) => store.get(r.name) || new File([], r.name),
    file: async (o) => store.get(o.name),
    env() {
      const made = [];
      const e = {
        resources: res, csvMeta: res.csvMeta, xlsx: XLSX,
        openDb: () => openSqlite(sqlite3InitModule, { memory: true }),
        output: async (name) => {
          const parts = [];
          return { write: (s) => parts.push(s), writeBytes: (b) => parts.push(b), close: async () => { const f = new File(parts, name); store.set(name, f); made.push(name); return { name, size: f.size }; } };
        },
        tree: undefined,
      };
      return { env: e, finish: (failed) => { if (failed) for (const n of made) store.delete(n); } };
    },
  };
}
const said = (state) => JSON.stringify(state.steps.map((s) => [s.id, s.state, s.problem?.words || s.error]));

// ---- the files: Antonine minted as the previous release, then edited --------------------------------------
/** PLATO's Antonine example under the test's base, published. */
function antonine() {
  const d = JSON.parse(readFileSync(join(PLATO_REPO, 'schemas/examples/place-centric-antonine.json'), 'utf8').replaceAll('https://whgazetteer.org/example/antonine/', BASE));
  d.gazetteer.status = 'published';
  return d;
}
let cached = null;
/** The previous release: the example minted by Agora (every attestation given an address), as JSON Lines; and the new version, edited three ways, as JSON. */
async function versions() {
  if (cached) return cached;
  const e = env();
  const minted = await publish({ part: 'mint', input: await detect([textFile(JSON.stringify(antonine()), 'antonine.json')]), options: { name: 'antonine.json' } }, e);
  assert.equal(minted.report.errors, 0, JSON.stringify(minted.report.items));
  const prevText = outText(e, minted.outputs[0].name);
  const lines = prevText.trim().split('\n').map((l) => JSON.parse(l));
  const [head, ...places] = lines;
  // The working copy's header: a draft, not named as the release it was (a header still the previous release's is refused without a release name).
  const later = { ...head, gazetteer: { ...head.gazetteer, '@id': undefined, status: 'draft' }, spatialEntities: [] };
  const edits = { changed: null, deleted: null, dropped: null };
  for (const [i, p] of places.entries()) {
    if (!Array.isArray(p.attestations)) continue;
    const q = JSON.parse(JSON.stringify(p));
    if (i === 1) { edits.changed = q.attestations[0]['@id']; q.attestations[0] = { ...q.attestations[0], notes: 'Changed in the new version.' }; }
    if (i === 2) { edits.deleted = q.attestations.at(-1)['@id']; q.attestations.pop(); }
    if (i === places.length - 1) { edits.dropped = { place: q['@id'], attestations: q.attestations.length }; continue; }
    if (i === 3) q.attestations.push({ names: [{ toponym: 'Added in the new version' }], citations: [{ source: `${BASE}source/parthey-pinder-1848` }] });
    later.spatialEntities.push(q);
  }
  for (const p of places) if (!Array.isArray(p.attestations)) later.identityRelations = [...(later.identityRelations || []), p];
  delete later.$schema;
  cached = { previous: new File([prevText], 'antonine-with-ids.jsonl'), later: new File([JSON.stringify(later)], 'antonine-v2.json'), edits, previousAttestations: places.reduce((n, p) => n + (p.attestations?.length || 0), 0), previousId: head.gazetteer['@id'] };
  return cached;
}

test('the recipe is well formed: the new version chosen at the start, the previous release chosen late at the revise step, revised, checked, compared, written out, and published as Publish a dataset publishes, against the previous release', () => {
  assert.equal(checkRecipe(R), R);
  assert.equal(R.version, 1);
  assert.match(R.digest, /^[0-9a-f]{64}$/);
  assert.equal(digest(R), R.digest);
  assert.deepEqual(Object.keys(R.files), ['files', 'previous']);
  assert.equal(R.files.previous.late, true);
  assert.deepEqual(R.steps.map((s) => s.id), ['check', 'revise', 'again', 'compare', 'out', 'mint', 'report', 'site', 'w3id']);
  const revise = R.steps.find((s) => s.id === 'revise');
  assert.deepEqual(revise.from, { later: '$files', earlier: '$previous' });
  assert.equal(OPERATIONS.revise.tool, 'Mneme');
  assert.deepEqual(OPERATIONS.revise.gives, { dataset: 'dataset' });
  assert.equal(typeof ADAPTERS.revise, 'function');
  // Minting takes the previous release, so that every published address is kept; the questions of publishing are Publish a dataset's.
  assert.deepEqual(R.steps.find((s) => s.id === 'mint').from, { dataset: 'revise.dataset', previous: '$previous' });
  for (const k of ['release', 'repo', 'maintainers']) assert.deepEqual(R.asks[k], PUBLISH.asks[k]);
  // Publish a dataset and the other recipes are as they were: no version was raised for this.
  assert.equal(PUBLISH.version, 2);
  assert.equal(R.cannot.length, 4);
  assert.equal(R.before.length, 2);
});

test('the interview: a dataset in a PLATO format, and a new version of a published dataset, leads to the workflow (once a dead end), asking publishing, and the base address when publishing, optional; a table wanting a new version is sent to bring it into PLATO first', () => {
  const c = choose('plato', 'version');
  assert.deepEqual(c, { kind: 'recipe', recipe: 'release-a-new-version', set: { target: 'plato-json' }, ask: ['will-publish'], base: { when: 'will-publish', needed: false } });
  assert.deepEqual(questionsFor(c).map((q) => q.key), ['will-publish']);
  assert.equal(baseAsked(c, { 'will-publish': false }), null);
  assert.deepEqual(baseAsked(c, { 'will-publish': true }), { needed: false, question: R.asks.base.question });
  assert.equal(answered(c, {}), false); assert.equal(answered(c, { 'will-publish': false }), true);
  assert.deepEqual(answersFor(c, { 'will-publish': false }), { target: 'plato-json', 'will-publish': false });
  const p = plan(c.recipe, answersFor(c, { 'will-publish': false }));
  assert.deepEqual(p.steps.map((s) => s.id), ['check', 'revise', 'again', 'compare', 'out']);
  assert.deepEqual(p.left.map((s) => s.id), ['mint', 'report', 'site', 'w3id']);
  assert.deepEqual(p.late, [{ key: 'previous', words: 'The previous release, as published (the copy with addresses)' }]);
  assert.deepEqual(plan(c.recipe, answersFor(c, { 'will-publish': true })).steps.map((s) => s.id), ['check', 'revise', 'again', 'compare', 'out', 'mint', 'report', 'site', 'w3id']);
  assert.equal(p.before.length, 2);
  // The other way in names no recipe, and says to bring the file into PLATO first (the presence: the tools it names).
  const none = choose('table', 'version');
  assert.equal(none.kind, 'none');
  assert.match(none.why, /starts from a dataset in a PLATO format: bring yours into PLATO first/);
  assert.deepEqual(none.tools, ['read', 'versions', 'publish']);
  assert.ok(HAVE.some((h) => h.key === 'plato') && WANT.some((w) => w.key === 'version'));
});

test('the previous release is chosen at the revise step: the workflow begins without it, the step is refused in words until it is chosen, it is kept by its hash from then on, and forgotten only while no step was done with it', async () => {
  const { previous, later } = await versions();
  const otherFile = new File([await previous.text() + '\n'], 'antonine-with-ids.jsonl');
  const files = await refsOf([later], 'files'), prev = await refsOf([previous], 'files'), other = await refsOf([otherFile], 'files');
  let s = runner.start(R, ANSWERS, { files });
  assert.deepEqual([Object.keys(s.files), s.late], [['files'], { previous: 'The previous release, as published (the copy with addresses)' }]);
  assert.deepEqual(runner.inputsOf(s, 'check').files, files);
  assert.throws(() => runner.inputsOf(s, 'revise'), /^TransitionError: The step "Revise it against the previous release.*" cannot be done yet: the previous release, as published \(the copy with addresses\) is not chosen\. Choose it at this step\.$/);
  s = runner.supply(s, R, 'previous', prev);
  assert.deepEqual(runner.inputsOf(s, 'revise'), { later: files, earlier: prev });
  assert.throws(() => runner.supply(s, R, 'files', prev), /are chosen at the start/);
  assert.throws(() => runner.supply(s, R, 'previous', other), /^TransitionError: The previous release, as published \(the copy with addresses\) is already chosen for this workflow \(antonine-with-ids\.jsonl\), so antonine-with-ids\.jsonl is not taken: forget it first to choose another\.$/);
  assert.equal(runner.forgettable(s, 'previous'), true);
  const forgot = runner.forget(s, R, 'previous');
  assert.throws(() => runner.inputsOf(forgot, 'revise'), /is not chosen/);
  assert.deepEqual(runner.supply(forgot, R, 'previous', other).files.previous, other);
  // Once the revise step is done with it, it is neither replaced nor forgotten; done again, the revise step takes the compare and the mint with it.
  const at = (st, id) => { let w = st; while (w.current !== id) { w = runner.next(w); if (w.current !== id) w = runner.complete(w, w.current, Object.fromEntries(Object.entries(OPERATIONS[w.steps.find((x) => x.id === w.current).op].gives).map(([k, t]) => [k, [{ type: t, name: `${k}.json`, size: 1, sha256: 'a'.repeat(64) }]]))); } return w; };
  let m = at(s, 'again');
  assert.equal(m.steps.find((x) => x.id === 'revise').state, 'done');
  assert.equal(runner.forgettable(m, 'previous'), false);
  assert.throws(() => runner.forget(m, R, 'previous'), /cannot be forgotten: the step "Revise it against the previous release.*" was done with it\. Do that step again first\.$/);
  m = runner.complete(m, 'again', {});
  m = runner.complete(runner.next(m), 'compare', {});
  const again = runner.invalidate(m, 'revise');
  assert.deepEqual(['check', 'revise', 'again', 'compare', 'out'].map((id) => again.steps.find((x) => x.id === id).state), ['done', 'pending', 'pending', 'pending', 'pending']);
  assert.equal(runner.forgettable(again, 'previous'), true);
  // The record keeps it, and resuming checks it as it checks the new version: the previous release as it was passes, another does not.
  const rec = importRecord(exportRecord(recordOf(m, { name: 'release' })));
  assert.deepEqual(rec.files.previous, prev);
  assert.equal(filesWords(rec, 'previous'), 'the previous release, as published (the copy with addresses), chosen at the step “Revise it against the previous release: withdraw or replace what it changed, so nothing published is lost”');
  assert.equal(await checkChosen(rec, { files: [later], previous: [previous] }), true);
  await assert.rejects(() => checkChosen(rec, { files: [later], previous: [otherFile] }), /These are not the previous release, as published \(the copy with addresses\), chosen at the step/);
  await assert.rejects(() => checkChosen(rec, { files: [new File(['{}'], 'antonine-v2.json')], previous: [previous] }), /These are not the files this workflow was begun with/);
});

test('Release a new version, end to end in Node, published: the new version checked, revised against the previous release (the deleted attestation and the dropped place retracted, the changed one replaced, the added one addressed), checked again, compared, written out, minted against the previous release with every address kept, the FAIR report, the site and the w3id rules', { timeout: 300000 }, async () => {
  const { previous, later, edits, previousAttestations, previousId } = await versions();
  const host = memoryHost([previous, later]);
  const answers = { 'will-publish': true, target: 'plato-json', release: 'v2', repo: 'pelagios/release-test', maintainers: ['docuracy'] };
  let s = runner.start(R, answers, { files: await refsOf([later], 'files') });
  // Driven before the previous release is chosen: the revise step is refused in words, after the check is done.
  let early = null;
  try { await drive(s, host); } catch (e) { early = e; }
  assert.match(early?.message || '', /cannot be done yet: the previous release, as published \(the copy with addresses\) is not chosen/);
  s = runner.supply(s, R, 'previous', await refsOf([previous], 'files'));
  const { state, reports } = await drive(s, host);
  assert.equal(state.status, 'completed', said(state));
  assert.deepEqual(state.steps.map((x) => x.state), ['done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'done']);
  assert.deepEqual(Object.keys(reports), ['check', 'revise', 'again', 'compare', 'out', 'mint', 'report', 'site', 'w3id']);
  // The revision: exactly the three edits, plus the addition.
  const c = reports.revise.counts;
  assert.deepEqual([c.changed, c.removed, c.tombstones, c.added, c.retracted, c.superseded], [1, 1, 1, 1, 1 + edits.dropped.attestations, 1]);
  assert.equal(c.previous, previousAttestations);
  const items = Object.fromEntries(reports.revise.items.map((i) => [i.kind, i]));
  assert.deepEqual(items.superseded.examples, [edits.changed]);
  assert.deepEqual(items.retracted.examples, [edits.deleted]);
  assert.deepEqual(items.tombstone.examples, [edits.dropped.place]);
  assert.ok(items['release-written'] && items['later-not-published']);
  const revisedRefs = state.steps.find((x) => x.id === 'revise').outputs.dataset;
  assert.deepEqual(revisedRefs.map((x) => x.name), ['antonine-v2-revised.json'], 'the dataset alone is the step\'s result');
  const account = JSON.parse(await host.store.get('antonine-v2.release.json').text());
  assert.deepEqual([account.counts.superseded, account.counts.retracted, account.counts.tombstones, account.tombstones], [1, 1 + edits.dropped.attestations, 1, [edits.dropped.place]], 'the release report beside it');
  const revised = JSON.parse(await host.store.get(revisedRefs[0].name).text());
  assert.deepEqual([revised.gazetteer.version, revised.gazetteer.previousVersion, revised.gazetteer.status, revised.gazetteer['@id']], ['v2', previousId, 'published', `${BASE}release/v2`]);
  // The dropped place is in the revised dataset as a tombstone: its description kept, every attestation retracted.
  const tomb = revised.spatialEntities.find((p) => p['@id'] === edits.dropped.place);
  assert.ok(tomb && tomb.label);
  const w = new Map(); for (const p of revised.spatialEntities) collectWithdrawn(p.attestations, w);
  const current = resolveWithdrawn(w).status;
  assert.ok(tomb.attestations.filter((a) => !a.meta).every((a) => current.get(a['@id']) === 'retracted'));
  assert.equal(current.get(edits.changed), 'superseded'); assert.equal(current.get(edits.deleted), 'retracted');
  // Mneme: only added to, the withdrawals counted.
  assert.equal(reports.again.errors, 0);
  assert.deepEqual(['changed', 'lost', 'retracted', 'superseded'].map((k) => reports.compare.counts[k]), [0, 0, 1 + edits.dropped.attestations, 1]);
  assert.equal(reports.compare.counts.added, revised.spatialEntities.reduce((n, p) => n + p.attestations.length, 0) - previousAttestations);
  // Minted against the previous release: every address it gave is kept (nothing minted afresh), the gate passed.
  assert.equal(reports.mint.errors, 0, JSON.stringify(reports.mint.items));
  assert.deepEqual([reports.mint.counts.minted, reports.mint.counts.kept], [0, revised.spatialEntities.reduce((n, p) => n + p.attestations.length, 0)]);
  assert.equal(reports.mint.counts.previous.lost, 0);
  // The site and the rules were built from the minted dataset, and written.
  for (const id of ['report', 'site', 'w3id']) assert.ok(Object.values(state.steps.find((x) => x.id === id).outputs).flat().length >= 1, id);
  // The end check, one predicate for both: every edit answered in the document (the deleted retracted, the changed
  // superseded, the dropped place's attestations retracted). It holds on the dataset written and fails on the same file
  // with its withdrawals left out, as a step that skipped them would leave it.
  const answered = (d) => {
    const w = new Map(); for (const p of d.spatialEntities) collectWithdrawn(p.attestations, w);
    const st = resolveWithdrawn(w).status, t = d.spatialEntities.find((p) => p['@id'] === edits.dropped.place);
    return st.get(edits.deleted) === 'retracted' && st.get(edits.changed) === 'superseded' && !!t && t.attestations.filter((a) => !a.meta).every((a) => st.get(a['@id']) === 'retracted');
  };
  const stripped = { ...revised, spatialEntities: revised.spatialEntities.map((p) => ({ ...p, attestations: p.attestations.filter((a) => !a.meta) })) };
  assert.equal(answered(revised), true);
  assert.equal(answered(stripped), false);
  assert.equal(asked.length, 1, 'nothing went to the network but the control call');
});

test('not published: the workflow ends at writing out, and the revise step stops in words on a previous release without addresses (the working copy before minting), naming the copy to give', async () => {
  const { later } = await versions();
  const unminted = new File([JSON.stringify(antonine())], 'antonine.json');
  const host = memoryHost([unminted, later]);
  let s = runner.start(R, ANSWERS, { files: await refsOf([later], 'files') });
  s = runner.supply(s, R, 'previous', await refsOf([unminted], 'files'));
  const { state } = await drive(s, host);
  assert.equal(state.status, 'stopped', said(state));
  const step = state.steps.find((x) => x.id === 'revise');
  assert.equal(step.state, 'stopped');
  assert.match(step.problem.words, /Give the copy with addresses that the site was made from \(<name>-with-ids\.jsonl, which minting wrote\)/);
  assert.deepEqual(state.steps.slice(5).map((x) => x.state), ['skipped', 'skipped', 'skipped', 'skipped']);
  // The presence: with the minted copy, the same workflow runs through to the end.
  const { previous } = await versions();
  const ok = await drive(runner.supply(runner.start(R, ANSWERS, { files: await refsOf([later], 'files') }), R, 'previous', await refsOf([previous], 'files')), memoryHost([previous, later]));
  assert.equal(ok.state.status, 'completed', said(ok.state));
  assert.deepEqual(ok.state.steps.map((x) => x.state), ['done', 'done', 'done', 'done', 'done', 'skipped', 'skipped', 'skipped', 'skipped']);
});
