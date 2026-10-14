// Methodos: "Match two datasets" (src/engine/methodos/recipes/match-two-datasets.js; Stephen's decisions
// of 14 October 2026): its plan, the interview's route to it, the other dataset chosen late (at the
// match, runner.supply) and checked by its hash from then on, and the workflow walked end to end in Node
// with the engine's real calls on two small constructed files (test/fixtures/methodos/match-mine.csv and
// match-other.json), both ways of recording the decisions, published and not. Nothing goes on the network:
// fetch is replaced by one that throws, beside a call showing that it does.
//
// Every refusal or absence is paired with the presence it is told from, and each check of an end result
// is shown failing on a mutation of the same file (a step that skipped its work would leave it so).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { openSqlite } from '../src/lib/store.js';
import { res } from './engine.js';
import { readWork, serialiseWork, decide } from '../src/engine/krisis/work.js';
import { HAVE, WANT, choose, questionsFor, answersFor, answered, baseAsked, plan } from '../src/engine/methodos/interview.js';
import { RECIPES, OPERATIONS, ADAPTERS, runner, drive, refsOf, checkRecipe, digest, checkChosen, exportRecord, importRecord, recordOf } from '../src/engine/methodos/index.js';

const M = RECIPES['match-two-datasets'], MAP = RECIPES['map-your-data'];
const BASE = 'https://w3id.org/match-test/';
const MINE = `${BASE}place/`, OTHER = 'https://example.org/other/place/';
const AT = '2026-10-14T10:00:00Z';
const MAPPING = { id: 'id', name: 'name', latitude: 'latitude', longitude: 'longitude', type: 'type' };
const fixture = (name) => readFileSync(new URL(`./fixtures/methodos/${name}`, import.meta.url), 'utf8');
const TABLE = () => new File([fixture('match-mine.csv')], 'match-mine.csv');
// The other dataset as the fixture has it: Kingsbury there already says it is the table's Kingsbury (under BASE).
const otherDoc = () => JSON.parse(fixture('match-other.json').replaceAll('https://example.org/mine/', BASE));
const OTHERS = (d = otherDoc(), name = 'match-other.json') => new File([JSON.stringify(d)], name);
const ANSWERS = { 'into-dataset': true, 'will-publish': false, target: 'plato-json', base: BASE };

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
    open: async (r) => store.get(r.name) || new File([], r.name),
    file: async (o) => store.get(o.name),
    env() {
      const made = [];
      const env = {
        resources: res, csvMeta: res.csvMeta, xlsx: XLSX,
        openDb: () => openSqlite(sqlite3InitModule, { memory: true }),
        output: async (name) => {
          const parts = [];
          return { write: (s) => parts.push(s), writeBytes: (b) => parts.push(b), close: async () => { const f = new File(parts, name); store.set(name, f); made.push(name); return { name, size: f.size }; } };
        },
      };
      return { env, finish: (failed) => { if (failed) for (const n of made) store.delete(n); } };
    },
  };
}
const said = (state) => JSON.stringify(state.steps.map((s) => [s.id, s.state, s.problem?.words || s.error || s.findings?.words]));

/** Begun with the table, its columns given, driven to the match; the other dataset chosen there (supply), and driven on to the review. */
async function begun({ answers = ANSWERS, others = OTHERS() } = {}) {
  const table = TABLE(), mapping = new File([JSON.stringify(MAPPING)], 'columns.json');
  const host = memoryHost([table, mapping, others]);
  let s = runner.start(M, answers, { files: await refsOf([table], 'files') });
  s = runner.complete(runner.next(s), 'columns', { mapping: await refsOf([mapping], 'mapping') });
  // Driven without the other dataset, the workflow cannot take the match: refused, in words, before anything runs.
  let early = null;
  try { await drive(s, host); } catch (e) { early = e; }
  s = runner.supply(s, M, 'others', await refsOf([others], 'files'));
  const d = await drive(s, host);
  return { host, early, ...d };
}
const workOf = async (host, state, id = 'match') => readWork(await host.store.get(state.steps.find((x) => x.id === id).outputs.work[0].name).text());
/** The review: Newton and Windermere (the town) accepted as the same place, by a named reviewer; the work file as the step's result. */
async function reviewed(host, state, pick = ['newton', 'windermere']) {
  const work = await workOf(host, state);
  work.reviewer = { name: 'A. Reviewer' };
  for (const c of work.candidates) {
    const mine = c.candidate_source.slice(MINE.length), other = c.candidate_candidate.slice(OTHER.length);
    if (pick.includes(mine) && other === mine) decide(work, c.id, 'match', { identityType: 'closeMatch', at: AT });
  }
  const f = new File([serialiseWork(work)], 'match-mine.reviewed.krisis.json');
  host.store.set(f.name, f);
  return runner.complete(state, 'review', { work: await refsOf([f], 'work.krisis') });
}
const fileOf = async (host, state, id) => JSON.parse(await host.store.get(state.steps.find((x) => x.id === id).outputs.dataset[0].name).text());
/** What the decisions made, read from a PLATO document of either profile: each identity [subject, object], and whether it names the candidate it answers. */
function decisions(doc) {
  const atts = doc.profile === 'attestation-centric' ? doc.attestations : (doc.spatialEntities || []).flatMap((e) => e.attestations || []);
  const ids = atts.flatMap((a) => a.identities || []);
  return { pairs: ids.map((i) => [i.subject, i.object]).sort(), promoted: ids.filter((i) => typeof i.promotedFrom === 'string').length, places: (doc.spatialEntities || []).length };
}

// ---- the plan, the steps, the interview --------------------------------------------------------------------
test('the recipe is well formed: the table read as Map your data reads it, the other dataset chosen late and matched as it is, checked after the match, its problems not stopping the workflow', () => {
  assert.equal(checkRecipe(M), M);
  assert.deepEqual(M.steps.map((s) => s.id), ['columns', 'check', 'dataset', 'match', 'check-other', 'review', 'apply', 'again', 'compare', 'out', 'mint', 'report', 'site', 'w3id']);
  // The table's three steps are Map your data's own, by operation, inputs and options.
  for (const id of ['columns', 'check', 'dataset']) {
    const [mine, map] = [M, MAP].map((r) => r.steps.find((s) => s.id === id));
    assert.deepEqual([mine.op, mine.from, mine.options], [map.op, map.from, map.options], id);
  }
  // The other dataset: chosen late, straight to the match (no columns, no conversion), and checked with its problems reported.
  assert.equal(M.files.others.late, true);
  assert.equal(M.files.files.late, undefined, 'the table is chosen at the start (the presence: one file is)');
  assert.deepEqual(M.steps.find((s) => s.id === 'match').from, { subjects: 'dataset.dataset', others: '$others' });
  assert.deepEqual(M.steps.find((s) => s.id === 'check-other').options, { problems: 'report' });
  assert.equal(M.steps.find((s) => s.id === 'check').options, undefined, "the table's check stops for its problems, as Map your data's does");
  // The decisions: where, from the one question; the candidates exported only when publishing; compared only when added to the dataset.
  assert.deepEqual(M.steps.find((s) => s.id === 'apply').options, { intoDataset: '$into-dataset', exportCandidates: '$will-publish', base: '$base' });
  assert.equal(M.steps.find((s) => s.id === 'compare').when, 'into-dataset');
  for (const s of M.steps) { assert.equal(OPERATIONS[s.op].available, true, s.op); assert.ok(ADAPTERS[s.op] || OPERATIONS[s.op].kind === 'interactive', s.op); }
  // The question's two answers in words, and its default (into the dataset).
  assert.deepEqual([M.asks['into-dataset'].kind, M.asks['into-dataset'].answers, M.asks['into-dataset'].default], ['yes-no', ['Add them to my dataset', 'Keep them in a file of their own'], true]);
  assert.equal(M.asks['into-dataset'].question, 'Add the decisions to your dataset, or keep them in a file of their own about it?');
  for (const k of ['will-publish', 'target', 'release', 'repo', 'maintainers']) assert.deepEqual(M.asks[k], MAP.asks[k], k);
  assert.deepEqual(M.asks.base, MAP.asks.base);
  // What it cannot do, in sentences; the other dataset's addresses among them.
  assert.ok(M.cannot.length >= 3 && M.cannot.every((c) => /\.$/.test(c)));
  assert.match(M.cannot.join(' '), /other dataset's places must have web addresses/);
  const { digest: d0, ...plain } = M;
  assert.equal(digest(plain), d0);
  assert.notEqual(digest({ ...plain, files: { ...plain.files, others: { ...plain.files.others, late: false } } }), d0, 'whether a file is chosen late is part of the recipe');
  // A recipe's late files, answers' words and default are checked (each beside the recipe above, passed).
  assert.throws(() => checkRecipe({ ...M, files: { ...M.files, others: { ...M.files.others, late: 'yes' } } }), /chosen late must be true or false/);
  assert.throws(() => checkRecipe({ ...M, asks: { ...M.asks, 'will-publish': { ...M.asks['will-publish'], answers: ['Yes'] } } }), /names its answers/);
  assert.throws(() => checkRecipe({ ...M, asks: { ...M.asks, target: { ...M.asks.target, default: true } } }), /default that is not yes or no/);
});

test('the interview: a table of places, and a match of two datasets, leads to the workflow, asking where the decisions go (into the dataset unless said otherwise) and publishing, and the base address, optional', () => {
  const c = choose('table', 'match');
  assert.deepEqual([c.kind, c.recipe, c.ask], ['recipe', 'match-two-datasets', ['into-dataset', 'will-publish']]);
  const qs = questionsFor(c);
  assert.deepEqual(qs.map((q) => [q.key, q.answers ?? null, q.default ?? null]), [['into-dataset', M.asks['into-dataset'].answers, true], ['will-publish', null, null]]);
  // Answered once publishing is: the question with a default needs no answer (the presence: without publishing, it is not answered).
  assert.equal(answered(c, {}), false);
  assert.equal(answered(c, { 'will-publish': false }), true);
  assert.equal(answersFor(c, { 'will-publish': false })['into-dataset'], true, 'the default, into the dataset');
  assert.equal(answersFor(c, { 'will-publish': false, 'into-dataset': false })['into-dataset'], false, 'and the other answer, when given');
  assert.deepEqual(baseAsked(c, {}), { needed: false, question: M.asks.base.question });
  assert.equal(answersFor(c, { 'will-publish': false }, { base: BASE }).base, BASE);
  // The plans: compared only when the decisions go into the dataset; the other dataset named, to be chosen at the match.
  const into = plan(c.recipe, answersFor(c, { 'will-publish': false }));
  const own = plan(c.recipe, answersFor(c, { 'will-publish': false, 'into-dataset': false }));
  assert.deepEqual(into.steps.map((s) => s.id), ['columns', 'check', 'dataset', 'match', 'check-other', 'review', 'apply', 'again', 'compare', 'out']);
  assert.deepEqual(own.steps.map((s) => s.id), ['columns', 'check', 'dataset', 'match', 'check-other', 'review', 'apply', 'again', 'out']);
  assert.deepEqual(own.left.map((s) => s.id), ['compare', 'mint', 'report', 'site', 'w3id']);
  assert.deepEqual(into.late, [{ key: 'others', words: 'The other dataset' }]);
  assert.deepEqual(plan('map-your-data', answersFor(choose('table', 'map'), { 'has-regions': false, 'will-draw': false, 'will-publish': false })).late, [], 'Map your data chooses nothing late');
  assert.deepEqual([into.unavailable, into.notes], [[], []]);
  // A match from anything but a table still names no workflow, and says where to go meanwhile (Krisis).
  for (const h of HAVE) if (h.key !== 'table') {
    const n = choose(h.key, 'match');
    assert.equal(n.kind, 'none', h.key);
    assert.match(n.why, /starts from a table of places/);
    assert.deepEqual(n.tools, ['match']);
  }
  assert.ok(WANT.some((w) => w.key === 'match'));
});

// ---- the other dataset, chosen late --------------------------------------------------------------------------
test('the other dataset is chosen at the match: the workflow begins without it, the match is refused in words until it is chosen, and it is kept by its hash from then on', async () => {
  const table = await refsOf([TABLE()], 'files'), others = await refsOf([OTHERS()], 'files'), changed = await refsOf([OTHERS({ ...otherDoc(), spatialEntities: otherDoc().spatialEntities.slice(1) })], 'files');
  let s = runner.start(M, ANSWERS, { files: table });
  assert.deepEqual([Object.keys(s.files), s.late], [['files'], { others: 'The other dataset' }]);
  // The steps before the match have their inputs (the presence); the match is refused, naming what it waits for.
  assert.deepEqual(runner.inputsOf(s, 'columns').files, table);
  assert.throws(() => runner.inputsOf(s, 'check-other'), /^TransitionError: The step "Check the other dataset" cannot be done yet: the other dataset is not chosen\. Choose it at this step\.$/);
  // Chosen: the match takes it, by reference.
  s = runner.supply(s, M, 'others', others);
  assert.deepEqual(runner.inputsOf(s, 'check-other').files, others);
  // Only a recipe's late files are chosen so (the table is chosen at the start), and only references of their type.
  assert.throws(() => runner.supply(s, M, 'files', others), /are chosen at the start/);
  assert.throws(() => runner.supply(s, M, 'elsewhere', others), /has none of that name/);
  assert.throws(() => runner.supply(s, M, 'others', [{ ...others[0], type: 'dataset' }]), /is a file of places the tools wrote/);
  // Before any step has taken it, another may be chosen in its place; the same again changes nothing.
  assert.deepEqual(runner.supply(s, M, 'others', changed).files.others, changed);
  assert.deepEqual(runner.supply(s, M, 'others', others), s);
  // Once the match is done with it, another is refused, in words; the same is not. Done again, the match takes another,
  // and the check of the other dataset is to do again with it.
  const at = (st, id) => { let w = st; while (w.current !== id) { w = runner.next(w); if (w.current !== id) w = runner.complete(w, w.current, Object.fromEntries(Object.entries(OPERATIONS[w.steps.find((x) => x.id === w.current).op].gives).map(([k, t]) => [k, [{ type: t, name: `${k}.json`, size: 1, sha256: 'a'.repeat(64) }]]))); } return w; };
  let m = at(s, 'check-other');
  assert.equal(m.steps.find((x) => x.id === 'match').state, 'done');
  assert.deepEqual(runner.inputsOf(m, 'match').others, others);
  assert.throws(() => runner.supply(m, M, 'others', changed), /The other dataset is already chosen \(match-other\.json\), and the step "Find the places of yours.*" was done with it: do that step again to choose another\./);
  assert.deepEqual(runner.supply(m, M, 'others', others).files.others, others);
  m = runner.complete(m, 'check-other', {});
  const again = runner.invalidate(m, 'match');
  assert.deepEqual(['match', 'check-other', 'review'].map((id) => again.steps.find((x) => x.id === id).state), ['pending', 'pending', 'pending']);
  assert.equal(again.steps.find((x) => x.id === 'dataset').state, 'done', 'the steps before it stay done');
  assert.deepEqual(runner.supply(again, M, 'others', changed).files.others, changed);
  // The record keeps it, and resuming checks it as it checks the table: the other dataset as it was passes, another does not.
  const rec = importRecord(exportRecord(recordOf(m, { name: 'match' })));
  assert.deepEqual(rec.files.others, others);
  assert.deepEqual(rec.late, { others: 'The other dataset' });
  assert.equal(await checkChosen(rec, { files: [TABLE()], others: [OTHERS()] }), true);
  await assert.rejects(() => checkChosen(rec, { files: [TABLE()], others: [OTHERS({ ...otherDoc(), spatialEntities: otherDoc().spatialEntities.slice(1) })] }), /These are not the files this workflow was begun with \("others"\): match-other\.json, match-other\.json differ\. Choose match-other\.json as they were\./);
});

// ---- walked end to end in Node ---------------------------------------------------------------------------------
test('Match two datasets, end to end in Node, the decisions added to the dataset: the table made a dataset, matched with the other, the other checked, reviewed, recorded, checked again, compared (only added to) and written out', async () => {
  const a = await begun();
  assert.match(a.early?.message || '', /cannot be done yet: the other dataset is not chosen/, 'driven before it was chosen, the match was refused in words');
  assert.equal(a.state.current, 'review', said(a.state));
  assert.deepEqual(a.state.steps.slice(0, 5).map((s) => s.state), ['done', 'done', 'done', 'done', 'done']);
  assert.equal(a.state.steps.find((s) => s.id === 'check-other').findings, undefined, 'the other dataset is clean: nothing found');
  // The table's places, under the base address, matched with the other's: Kingsbury, which the other dataset already says is the
  // table's own, is not suggested (counted as linked); the other Newton is too far; Zanzibar has no namesake.
  const work = await workOf(a.host, a.state);
  const pairs = work.candidates.map((c) => [c.candidate_source.slice(MINE.length), c.candidate_candidate.slice(OTHER.length)]);
  assert.deepEqual(pairs, [['newton', 'newton'], ['neuton', 'newton'], ['windermere', 'windermere-lake'], ['windermere', 'windermere']]);
  assert.deepEqual([a.reports.match.counts.linked, a.reports.match.counts.tooFar], [1, 2]);
  assert.ok(!pairs.some(([s]) => s === 'kingsbury'));
  assert.equal(work.others.title, 'The other dataset (constructed)');
  // Done again on the other dataset without its link, Kingsbury is suggested: the check of the absence above can fail.
  const unlinked = otherDoc(); delete unlinked.spatialEntities[2].identityRelations;
  const b = await begun({ others: OTHERS(unlinked) });
  assert.ok((await workOf(b.host, b.state)).candidates.some((c) => c.candidate_source === `${MINE}kingsbury` && c.candidate_candidate === `${OTHER}kingsbury`));
  assert.equal(b.reports.match.counts.linked, 0);

  const c = await drive(await reviewed(a.host, a.state), a.host);
  assert.equal(c.state.status, 'completed', said(c.state));
  assert.deepEqual(c.state.steps.map((s) => s.state), ['done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'skipped', 'skipped', 'skipped', 'skipped']);
  assert.equal(c.reports.again.errors, 0);
  // Mneme: only added to. Every place of the dataset made from the table is there, unchanged; two answers are added (with the dataset's own three).
  assert.deepEqual(['unchanged', 'changed', 'lost', 'added'].map((k) => c.reports.compare.counts[k]), [5, 0, 0, 2]);
  const doc = await fileOf(a.host, c.state, 'apply');
  const d = decisions(doc);
  assert.deepEqual(d.pairs, [[`${MINE}newton`, `${OTHER}newton`], [`${MINE}windermere`, `${OTHER}windermere`]]);
  assert.equal(d.places, 5);
  assert.equal(d.promoted, 0, 'not published: the suggestions are not exported, so no answer names a candidate');
  assert.ok(!a.host.store.has('match-mine.candidates.json'));
  // The check of the end fails on the same file as a step that skipped its work would leave it: no identities recorded.
  const none = { ...doc, spatialEntities: doc.spatialEntities.map((x) => ({ ...x, attestations: x.attestations.map(({ identities, ...rest }) => rest) })) };
  assert.deepEqual(decisions(none).pairs, []);
});

test('the decisions kept in a file of their own: an attestation-centric document of the answers alone, about the places of the dataset, which is not compared as a version of it', async () => {
  const a = await begun({ answers: { ...ANSWERS, 'into-dataset': false, target: 'ntriples' } });
  assert.equal(a.state.current, 'review', said(a.state));
  const c = await drive(await reviewed(a.host, a.state), a.host);
  assert.equal(c.state.status, 'completed', said(c.state));
  assert.deepEqual(c.state.steps.map((s) => [s.id, s.state]).filter(([id]) => ['apply', 'again', 'compare', 'out'].includes(id)), [['apply', 'done'], ['again', 'done'], ['compare', 'skipped'], ['out', 'done']]);
  assert.equal(c.reports.again.errors, 0);
  const doc = await fileOf(a.host, c.state, 'apply');
  assert.equal(doc.profile, 'attestation-centric');
  assert.deepEqual(decisions(doc).pairs, [[`${MINE}newton`, `${OTHER}newton`], [`${MINE}windermere`, `${OTHER}windermere`]]);
  assert.deepEqual(doc.attestations.map((x) => x.about).sort(), [`${MINE}newton`, `${MINE}windermere`]);
  assert.equal(doc.spatialEntities, undefined, 'nothing of the places is copied');
  // The control: added to the dataset instead, the same review writes the places with them.
  const into = await begun();
  const ci = await drive(await reviewed(into.host, into.state), into.host);
  assert.equal((await fileOf(into.host, ci.state, 'apply')).profile, 'place-centric');
});

test('published: the suggestions are exported as a candidate set beside the result, and every answer names the candidate it answers (promotedFrom), whichever way the decisions are kept', async () => {
  for (const into of [true, false]) {
    const a = await begun({ answers: { ...ANSWERS, 'into-dataset': into, 'will-publish': true, target: 'ntriples', release: 'v1', repo: 'pelagios/match-test', maintainers: ['docuracy'] } });
    const c = await drive(await reviewed(a.host, a.state), a.host);
    // Minted, reported and its site built; the w3id rules wait, as in every workflow, for a dataset that says it is published.
    assert.deepEqual(c.state.steps.slice(-4).map((s) => s.state), ['done', 'done', 'done', 'stopped'], said(c.state));
    assert.match(c.state.steps.at(-1).problem.words, /does not say that it is published/);
    const set = JSON.parse(await a.host.store.get('match-mine.candidates.json').text());
    assert.equal(set.profile, 'candidate-set');
    const doc = await fileOf(a.host, c.state, 'apply');
    const d = decisions(doc);
    assert.equal(d.pairs.length, 2);
    assert.equal(d.promoted, 2, `into the dataset: ${into}`);
    assert.ok(c.reports.apply.counts.candidateSet.startsWith(BASE), c.reports.apply.counts.candidateSet);
  }
});

test('the other dataset checked: its problems are recorded with the step and shown, and the workflow goes on to the review; one the tools cannot read stops the match', async () => {
  // A timespan that is not a list: the check finds one error, the match reads the places all the same.
  const bad = otherDoc(); bad.spatialEntities[0].attestations[0].timespans = 'never';
  const a = await begun({ others: OTHERS(bad) });
  const step = a.state.steps.find((s) => s.id === 'check-other');
  assert.equal(a.state.current, 'review', said(a.state));
  assert.deepEqual([step.state, step.findings.errors], ['done', 1]);
  assert.match(step.findings.words, /timespans must be array/);
  assert.equal(a.reports['check-other'].errors, 1);
  // The control: the clean other dataset is done with nothing found.
  const t = await begun();
  const ok = t.state.steps.find((s) => s.id === 'check-other');
  assert.deepEqual([ok.state, ok.findings], ['done', undefined]);
  // Only a step whose problems are reported is done with them: the table's own check is not (it stops, as Map your data's does).
  let w = runner.start(M, ANSWERS, { files: await refsOf([TABLE()], 'files') });
  w = runner.next(runner.complete(runner.next(w), 'columns', { mapping: [{ type: 'mapping', name: 'c.json', size: 1, sha256: 'b'.repeat(64) }] }));
  assert.equal(w.current, 'check');
  assert.throws(() => runner.complete(w, 'check', {}, { findings: { words: 'One error.', errors: 1 } }), /stops for the problems it finds: it is not done with them/);
  assert.equal(runner.complete(w, 'check', {}).steps.find((x) => x.id === 'check').state, 'done');
  // A check whose problems are reported still stops on a file it could not read to the end (cut short), and is done on one it read (the presence).
  const only = { key: 'check-only', title: 'Check only', version: 1, files: { files: { words: 'A file', types: ['files'] } }, steps: [{ id: 'c', op: 'check', from: { files: '$files' }, options: { problems: 'report' } }] };
  const cut = new File([fixture('match-other.json').slice(0, 700)], 'cut.json'), whole = OTHERS(bad);
  const cutRun = await drive(runner.start(only, {}, { files: await refsOf([cut], 'files') }), memoryHost([cut]));
  assert.deepEqual([cutRun.state.status, cutRun.state.steps[0].state, cutRun.state.steps[0].findings], ['stopped', 'stopped', undefined]);
  const wholeRun = await drive(runner.start(only, {}, { files: await refsOf([whole], 'files') }), memoryHost([whole]));
  assert.deepEqual([wholeRun.state.status, wholeRun.state.steps[0].state, wholeRun.state.steps[0].findings.errors], ['completed', 'done', 1]);
  // A file the tools cannot read stops the match, in words; nothing is suggested.
  const u = await begun({ others: new File(['not data at all'], 'match-other.txt') });
  assert.equal(u.state.status, 'stopped', said(u.state));
  assert.equal(u.state.current, null);
  assert.equal(u.state.steps.find((s) => s.id === 'match').state, 'stopped');
  assert.match(u.state.steps.find((s) => s.id === 'match').problem.words, /other dataset was not recognised/);
});

test('a match on another file than the other dataset chosen is refused: the file under that name changed since, the match stops and nothing is matched', async () => {
  const table = TABLE(), mapping = new File([JSON.stringify(MAPPING)], 'columns.json'), others = OTHERS();
  const host = memoryHost([table, mapping, others]);
  let s = runner.start(M, ANSWERS, { files: await refsOf([table], 'files') });
  s = runner.complete(runner.next(s), 'columns', { mapping: await refsOf([mapping], 'mapping') });
  s = runner.supply(s, M, 'others', await refsOf([others], 'files'));
  // The presence: as chosen, the match runs (in a copy of the host's files).
  const ok = await drive(s, memoryHost([table, mapping, others]));
  assert.equal(ok.state.current, 'review', said(ok.state));
  host.store.set('match-other.json', OTHERS({ ...otherDoc(), spatialEntities: otherDoc().spatialEntities.slice(1) }));
  const d = await drive(s, host);
  const m = d.state.steps.find((x) => x.id === 'match');
  assert.deepEqual([d.state.status, m.state], ['stopped', 'stopped']);
  assert.match(m.problem.words, /^match-other\.json: not the file the workflow recorded/);
  assert.ok(![...host.store.keys()].some((k) => k.endsWith('.krisis.json')), 'no work file was written');
  assert.equal(asked.length, 1, 'nothing went to the network but the one call made to show the stub throws');
});

// ---- the review: a candidate of another kind ranked after the others, and one accepted twice said so ------------
test('in the review, a candidate of the other dataset whose kind of place conflicts with yours (a lake for a village) comes after the others, marked; which candidates are suggested does not change', async () => {
  const { candidatesOf, kindOfCandidate } = await import('../src/engine/krisis/work.js');
  const { ALGORITHM } = await import('../src/engine/krisis/match.js');
  const a = await begun();
  const work = await workOf(a.host, a.state);
  const order = (w) => candidatesOf(w, `${MINE}windermere`).map((c) => c.candidate_candidate.slice(OTHER.length));
  // The match suggests the lake first (nearer, the same name); the review puts the town first, and says why of the lake.
  assert.deepEqual(work.candidates.filter((c) => c.candidate_source === `${MINE}windermere`).map((c) => c.candidate_candidate.slice(OTHER.length)), ['windermere-lake', 'windermere']);
  assert.deepEqual(order(work), ['windermere', 'windermere-lake']);
  const lake = work.candidates.find((c) => c.candidate_candidate === `${OTHER}windermere-lake`), town = work.candidates.find((c) => c.candidate_candidate === `${OTHER}windermere`);
  assert.deepEqual([kindOfCandidate(work, lake).fit, kindOfCandidate(work, lake).candidate.id, kindOfCandidate(work, lake).place.label], ['conflict', 'lake', 'village']);
  assert.equal(kindOfCandidate(work, town).fit, 'other', 'a town for a village does not conflict');
  // The same review with your places saying nothing of their kind keeps the match's order: the check above can fail.
  const plain = JSON.parse(JSON.stringify(work));
  for (const p of Object.values(plain.places)) delete p.types;
  assert.deepEqual(order(plain), ['windermere-lake', 'windermere']);
  assert.equal(kindOfCandidate(plain, lake).fit, 'unknown');
  // Nothing about the match changed: its algorithm, and the pairs it suggests (as the walk above has them).
  assert.equal(ALGORITHM, 'krisis-names 7');
  assert.equal(work.algorithm_version, ALGORITHM);
  // A lookup's candidates keep the order the lookup ranked them in (lookup.js), after the other dataset's.
  const w = JSON.parse(JSON.stringify(work));
  w.candidates.push({ ...lake, id: 'g1', lookup: 'l1', candidate_candidate: 'https://w3id.org/whg/id/place:gn:1' }, { ...town, id: 'g2', lookup: 'l1', candidate_candidate: 'https://w3id.org/whg/id/place:gn:2' });
  assert.deepEqual(candidatesOf(w, `${MINE}windermere`).map((c) => c.id).slice(2), ['g1', 'g2']);
});

test('in the review, a place of the other dataset already accepted for another of yours is said to be, and can still be accepted: never refused', async () => {
  const { acceptedFor } = await import('../src/engine/krisis/work.js');
  const { review: W } = await import('../src/engine/words.js');
  const a = await begun();
  const work = await workOf(a.host, a.state);
  const [newton, neuton] = ['newton', 'neuton'].map((p) => work.candidates.find((c) => c.candidate_source === `${MINE}${p}`));
  assert.equal(neuton.candidate_candidate, newton.candidate_candidate, 'the other Newton is a candidate for both');
  // Before any decision, nothing is said (the presence follows, on the same candidate).
  assert.deepEqual(acceptedFor(work, neuton), []);
  decide(work, newton.id, 'match', { identityType: 'closeMatch', at: AT });
  assert.deepEqual(acceptedFor(work, neuton), [`${MINE}newton`]);
  assert.equal(W.acceptedFor(acceptedFor(work, neuton).map((iri) => work.places[iri].label)), 'Already accepted for Newton.');
  assert.deepEqual(acceptedFor(work, newton), [], 'not of itself');
  // "Not this one" or "Different places" for the first does not count; and it never blocks the second.
  const other = JSON.parse(JSON.stringify(work));
  decide(other, newton.id, 'not-this', { at: AT });
  assert.deepEqual(acceptedFor(other, neuton), []);
  decide(work, neuton.id, 'match', { identityType: 'closeMatch', at: AT });
  assert.equal(work.candidates.find((c) => c.id === neuton.id).decision.kind, 'match');
  assert.deepEqual(acceptedFor(work, newton), [`${MINE}neuton`]);
});
