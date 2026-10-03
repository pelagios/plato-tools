// Methodos (src/engine/methodos/): recipes as data, the runner's transitions, typed hand-offs, and the
// adapters over the engine's real calls. Every refusal here is paired with the same thing done
// rightly passing, so that a check which refuses everything (or nothing) cannot pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { openSqlite } from '../src/lib/store.js';
import { res } from './engine.js';
import { PLATO_REPO } from './paths.js';
import { DataError } from '../src/engine/input.js';
import { OPERATIONS, RECIPES, TYPES, HandoffError, RecipeError, checkRecipe, digest, refsOf, runner, drive, ADAPTERS } from '../src/engine/methodos/index.js';

const { start, next, complete, waiting, resume, stop, fail, cancel, invalidate, serialise, deserialise, TransitionError } = runner;
const hex = (c) => c.repeat(64);
const ref = (type, name, c = 'a') => ({ type, name, size: 10, sha256: hex(c) });
const PUBLISH = RECIPES['publish-a-dataset'], MAP = RECIPES['map-your-data'];
const MAP_ANSWERS = { 'has-regions': false, 'will-draw': true, 'will-publish': false, target: 'lpf' };
const recipe = (steps, more = {}) => ({ key: 'test', title: 'A test', version: 1, files: { files: { words: 'Some files', types: ['files'] } }, asks: {}, steps, ...more });

test('every recipe shipped is well formed: every input is produced before it is used', () => {
  assert.deepEqual(Object.keys(RECIPES).sort(), ['map-your-data', 'publish-a-dataset']);
  for (const r of Object.values(RECIPES)) {
    assert.equal(checkRecipe(r), r);
    // Walked directly too: each step's inputs come from a file chosen or an earlier step's output.
    const before = new Set();
    for (const s of r.steps) {
      for (const from of Object.values(s.from)) for (const a of from.split('??').map((x) => x.trim()))
        assert.ok(a.startsWith('$') ? Object.hasOwn(r.files, a.slice(1)) : before.has(a.split('.')[0]), `${r.key}: ${s.id} takes ${a} before it is made`);
      before.add(s.id);
    }
  }
  // The same check refuses a recipe that uses an output before it is made, one that names an output
  // the operation does not give, and one that takes an input only from a step that may be skipped.
  const ok = recipe([{ id: 'mint', op: 'publish.mint', from: { dataset: '$files' } }, { id: 'site', op: 'publish.site', from: { dataset: 'mint.dataset' } }]);
  assert.equal(checkRecipe(ok), ok);
  assert.throws(() => checkRecipe(recipe([{ id: 'site', op: 'publish.site', from: { dataset: 'mint.dataset' } }, { id: 'mint', op: 'publish.mint', from: { dataset: '$files' } }])),
    (e) => e instanceof RecipeError && /no earlier step is called "mint": every input must be produced before it is used/.test(e.message));
  assert.throws(() => checkRecipe(recipe([{ id: 'mint', op: 'publish.mint', from: { dataset: '$files' } }, { id: 'site', op: 'publish.site', from: { dataset: 'mint.site' } }])), /gives no "site"/);
  const skippable = recipe([{ id: 'mint', op: 'publish.mint', from: { dataset: '$files' }, when: 'go' }, { id: 'site', op: 'publish.site', from: { dataset: 'mint.dataset' } }],
    { asks: { go: { question: 'Go?', kind: 'yes-no' } } });
  assert.throws(() => checkRecipe(skippable), /only from a step that may be skipped/);
  // Under the same condition, or with a fallback that always runs, it is fine.
  skippable.steps[1].when = 'go';
  assert.equal(checkRecipe(skippable), skippable);
});

test('a recipe that hands an operation the wrong type is refused in words', () => {
  const bad = recipe([{ id: 'match', op: 'match', from: { subjects: '$files', others: '$files' } }, { id: 'site', op: 'publish.site', from: { dataset: 'match.work' } }]);
  assert.throws(() => checkRecipe(bad), (e) => e instanceof RecipeError
    && e.message.includes(`hands ${TYPES['work.krisis']} ("match.work") to Build the web site as "dataset", which takes ${TYPES.files}, or ${TYPES.dataset}`));
});

test('a wrong-type hand-off is refused in words, at the start, between steps and at the end of a step', () => {
  const files = [ref('files', 'places.json')];
  // At the start: a work file given where the recipe takes the files chosen.
  assert.throws(() => start(PUBLISH, {}, { files: [ref('work.krisis', 'x.krisis.json')] }),
    (e) => e instanceof HandoffError && e.message === `x.krisis.json is ${TYPES['work.krisis']}, but "Publish a dataset" (the dataset to publish) takes ${TYPES.files}, so it is refused and nothing was run.`);
  // At the end of a step: an output of a type the operation does not give.
  let s = next(start(PUBLISH, {}, { files }));
  s = complete(s, 'check', {});
  s = next(s);
  assert.throws(() => complete(s, 'mint', { dataset: [ref('site', 'site.zip')] }),
    (e) => e instanceof HandoffError && e.message.includes(`site.zip is ${TYPES.site}, but the output "dataset" of the step "Give every place and source a permanent address" takes ${TYPES.dataset}`));
  // Between steps: a record whose hand-off was changed is refused when the next step takes it.
  const done = complete(s, 'mint', { dataset: [ref('dataset', 'minted.json')] });
  assert.equal(next(done).current, 'report');
  const tampered = JSON.parse(serialise(done));
  tampered.steps.find((x) => x.id === 'mint').outputs.dataset[0].type = 'work.krisis';
  assert.throws(() => next(tampered), (e) => e instanceof HandoffError && /minted\.json is a Krisis work file .* takes .*so it is refused and nothing was run/.test(e.message));
});

test('every transition that does not apply throws, and a transition never changes the state it was given', () => {
  const files = [ref('files', 'places.json')];
  const s0 = start(PUBLISH, {}, { files });
  const frozen = serialise(s0);
  assert.equal(s0.status, 'idle');
  for (const t of [() => complete(s0, 'check', {}), () => waiting(s0, 'check', 'x'), () => resume(s0, 'check'), () => stop(s0, 'check', { words: 'x' }),
    () => fail(s0, 'check', 'x'), () => cancel(s0, 'check'), () => invalidate(s0, 'check'), () => runner.progress(s0, 'check', { n: 1 })])
    assert.throws(t, TransitionError);
  const s1 = next(s0);
  assert.equal(serialise(s0), frozen, 'next() changed the state it was given');
  assert.equal(s1.status, 'running');
  assert.throws(() => next(s1), /only between steps, and the workflow is running/);
  assert.throws(() => complete(s1, 'mint', { dataset: [ref('dataset', 'm.json')] }), /cannot be done: it is pending, and the workflow is at "Check the dataset"/);
  assert.throws(() => resume(s1, 'check'), TransitionError);                   // running, not waiting
  assert.throws(() => stop(s1, 'check', {}), /without saying what to put right/);
  assert.throws(() => waiting(s1, 'check', ''), /without saying for what/);
  const w = waiting(s1, 'check', 'Waiting for permission');
  assert.throws(() => stop(w, 'check', { words: 'x' }), TransitionError);       // a data problem is found running, not waiting
  assert.equal(resume(w, 'check').status, 'running');
  const st = stop(s1, 'check', { words: 'Fix it.' });
  for (const t of [() => next(st), () => complete(st, 'check', {}), () => fail(st, 'check', 'x'), () => cancel(st, 'check')]) assert.throws(t, TransitionError);
  const f = fail(s1, 'check', new Error('boom'));
  for (const t of [() => next(f), () => complete(f, 'check', {}), () => resume(f, 'check')]) assert.throws(t, TransitionError);
  // An interactive step is finished by its result, never resumed as if it ran.
  let m = next(start(MAP, MAP_ANSWERS, { files }));
  assert.equal(m.status, 'waiting');
  assert.throws(() => resume(m, 'columns'), /done by you, not run/);
  m = complete(m, 'columns', { mapping: [ref('mapping', 'columns.json')] });
  assert.equal(m.status, 'idle');
  // Done: nothing more applies but invalidate, and a completed workflow takes no next step's result.
  let p = start(PUBLISH, {}, { files });
  for (const [id, out] of [['check', {}], ['mint', { dataset: [ref('dataset', 'm.json')] }], ['report', { deposit: [ref('deposit', 'r.zip')] }],
    ['site', { site: [ref('site', 's.zip')] }], ['w3id', { w3id: [ref('w3id', 'w.zip')] }]]) p = complete(next(p), id, out);
  p = next(p);
  assert.equal(p.status, 'completed');
  assert.throws(() => next(p), TransitionError);
  assert.throws(() => complete(p, 'w3id', { w3id: [ref('w3id', 'w.zip')] }), TransitionError);
  // An unknown step, and a step not available yet, are refused by name.
  assert.throws(() => complete(s1, 'nope', {}), /no step "nope"/);
  assert.throws(() => start(MAP, { ...MAP_ANSWERS, 'has-regions': true }, { files }), /"Identify the regions, the widest first" is not available yet\. Regions cannot be identified yet/);
  assert.equal(start(MAP, MAP_ANSWERS, { files }).steps.find((x) => x.id === 'regions').state, 'skipped');
});

test('invalidate resets the step and every step that took its outputs, and no other', () => {
  let p = start(PUBLISH, {}, { files: [ref('files', 'places.json')] });
  for (const [id, out] of [['check', {}], ['mint', { dataset: [ref('dataset', 'm.json')] }], ['report', { deposit: [ref('deposit', 'r.zip')] }],
    ['site', { site: [ref('site', 's.zip')] }], ['w3id', { w3id: [ref('w3id', 'w.zip')] }]]) p = complete(next(p), id, out);
  const again = invalidate(p, 'mint');
  assert.deepEqual(again.steps.map((x) => [x.id, x.state]), [['check', 'done'], ['mint', 'pending'], ['report', 'pending'], ['site', 'pending'], ['w3id', 'pending']]);
  assert.equal(again.steps.find((x) => x.id === 'site').outputs, undefined);
  assert.equal(next(again).current, 'mint');
});

test('a serialised state round-trips, and a damaged one is refused in words', () => {
  let s = start(MAP, { ...MAP_ANSWERS, release: 'v1' }, { files: [ref('files', 'places.csv')] });
  s = complete(next(s), 'columns', { mapping: [ref('mapping', 'columns.json')] });
  s = waiting(next(s), 'check', 'Waiting for you to allow the World Historical Gazetteer.');
  s = runner.progress(s, 'check', { reviewed: 124, total: 310 });
  const text = serialise(s);
  assert.deepEqual(deserialise(text), s);
  assert.equal(serialise(deserialise(text)), text);
  // Every part survived: answers, files, outputs, the step waiting and why, the counts.
  const back = deserialise(text);
  assert.equal(back.answers.release, 'v1');
  assert.equal(back.steps.find((x) => x.id === 'columns').outputs.mapping[0].sha256, hex('a'));
  assert.equal(back.steps.find((x) => x.id === 'check').why, 'Waiting for you to allow the World Historical Gazetteer.');
  assert.deepEqual(back.steps.find((x) => x.id === 'check').progress, { reviewed: 124, total: 310 });
  assert.equal(back.recipe.digest, MAP.digest);
  assert.throws(() => deserialise('{'), /not a workflow record: it is not JSON/);
  const bad = JSON.parse(text); bad.steps[0].outputs.mapping[0].sha256 = 'nope';
  assert.throws(() => deserialise(JSON.stringify(bad)), /an output of the step "columns" is not a reference to a file/);
});

test("a recipe's digest changes when one word does, and only then", () => {
  const copy = JSON.parse(JSON.stringify({ ...PUBLISH, digest: undefined }));
  assert.equal(digest(copy), PUBLISH.digest);
  // Written in another order, it is the same recipe.
  const reordered = Object.fromEntries(Object.entries(copy).reverse());
  assert.equal(digest(reordered), PUBLISH.digest);
  // One word of one step's title.
  const changed = JSON.parse(JSON.stringify(copy));
  changed.steps[3].title = changed.steps[3].title.replace('web', 'Web');
  assert.notEqual(digest(changed), PUBLISH.digest);
  // One word of a question.
  const asked = JSON.parse(JSON.stringify(copy));
  asked.asks.release.question = asked.asks.release.question.replace('called', 'named');
  assert.notEqual(digest(asked), PUBLISH.digest);
  // And the workflow records the digest of the recipe it started from.
  assert.equal(start(PUBLISH, {}, { files: [ref('files', 'p.json')] }).recipe.digest, PUBLISH.digest);
  assert.notEqual(start(changed, {}, { files: [ref('files', 'p.json')] }).recipe.digest, PUBLISH.digest);
});

test('the three ways of stopping are kept apart: waiting for the user, a data problem, an execution failure', async () => {
  const files = [ref('files', 'places.json')];
  const host = {};
  const throwing = (e) => ({ ...ADAPTERS, check: async () => { throw e; } });
  const permission = Object.assign(new Error('The World Historical Gazetteer is not allowed yet: allow it in the permissions panel.'), { name: 'PermissionError', kind: 'undecided' });
  const runs = {
    waiting: await drive(start(PUBLISH, {}, { files }), host, { adapters: throwing(permission) }),
    stopped: await drive(start(PUBLISH, {}, { files }), host, { adapters: throwing(new DataError('Line 3 has no name.')) }),
    failed: await drive(start(PUBLISH, {}, { files }), host, { adapters: throwing(new TypeError('x is undefined')) }),
    // A clean run that finds problems in the data is a data problem too, with the report's words.
    report: await drive(start(PUBLISH, {}, { files }), host, { adapters: { ...ADAPTERS, check: async () => ({ report: { errors: 2, items: [{ severity: 'error', message: 'Two places have no name.' }] }, problem: { words: 'Two places have no name.', errors: 2 } }) } }),
    done: await drive(start(PUBLISH, {}, { files }), host, { adapters: { ...ADAPTERS, check: async () => ({ report: { errors: 0, items: [] }, outputs: {} }), 'publish.mint': async () => { throw permission; } } }),
  };
  const step = (r, id = 'check') => r.state.steps.find((x) => x.id === id);
  assert.equal(runs.waiting.state.status, 'waiting');
  assert.deepEqual([step(runs.waiting).state, step(runs.waiting).why, step(runs.waiting).problem, step(runs.waiting).error], ['waiting', permission.message, undefined, undefined]);
  assert.equal(runs.stopped.state.status, 'stopped');
  assert.deepEqual([step(runs.stopped).state, step(runs.stopped).problem, step(runs.stopped).why, step(runs.stopped).error], ['stopped', { words: 'Line 3 has no name.', rerun: 'check' }, undefined, undefined]);
  assert.equal(runs.failed.state.status, 'failed');
  assert.deepEqual([step(runs.failed).state, step(runs.failed).error, step(runs.failed).why, step(runs.failed).problem], ['failed', 'x is undefined', undefined, undefined]);
  assert.equal(runs.report.state.status, 'stopped');
  assert.deepEqual(step(runs.report).problem, { words: 'Two places have no name.', errors: 2, rerun: 'check' });
  // The presence beside those absences: a check that passes goes on, to the next step.
  assert.equal(step(runs.done).state, 'done');
  assert.equal(step(runs.done, 'mint').state, 'waiting');
  // A data problem is put right by doing its step again; a failure is tried again the same way.
  assert.equal(next(invalidate(runs.stopped.state, 'check')).current, 'check');
  assert.equal(next(invalidate(runs.failed.state, 'check')).current, 'check');
});

test('cancel keeps partial results only where the operation declares it keeps them', () => {
  const files = [ref('files', 'places.json')];
  assert.equal(OPERATIONS.review.cancel, 'keeps-partial');
  assert.equal(OPERATIONS['publish.mint'].cancel, 'all-or-nothing');
  // A review cancelled part-way keeps its work file.
  const work = { work: [ref('work.krisis', 'places.krisis.json')] };
  const reviewing = () => {
    const m = next(start(recipe([{ id: 'match', op: 'match', from: { subjects: '$files', others: '$files' } }, { id: 'review', op: 'review', from: { work: 'match.work' } }]), {}, { files }));
    return next(complete(m, 'match', work));
  };
  assert.equal(reviewing().status, 'waiting');
  const r = cancel(reviewing(), 'review', { work: [ref('work.krisis', 'part.krisis.json', 'b')] });
  const rv = r.steps.find((x) => x.id === 'review');
  assert.equal(r.status, 'cancelled');
  assert.deepEqual([rv.state, rv.partial.work[0].name, rv.discarded], ['cancelled', 'part.krisis.json', undefined]);
  // Done again, it begins from what it kept.
  assert.equal(invalidate(r, 'review').steps.find((x) => x.id === 'review').partial.work[0].name, 'part.krisis.json');
  // Minting cancelled part-way keeps nothing: its half-written file is named for removal.
  let p = start(PUBLISH, {}, { files });
  p = complete(next(p), 'check', {});
  const c = cancel(next(p), 'mint', { dataset: [ref('dataset', 'half.json')] });
  const mint = c.steps.find((x) => x.id === 'mint');
  assert.deepEqual([c.status, mint.state, mint.partial, mint.discarded], ['cancelled', 'cancelled', undefined, ['half.json']]);
  // A cancelled step's partial results are still typed: a wrong type is refused.
  assert.throws(() => cancel(reviewing(), 'review', { work: [ref('site', 's.zip')] }), HandoffError);
});

// ---- Phase 1: the adapters over the engine's real calls --------------------------------------------

/** A front end in memory: files by name, the engine's outputs collected as bytes, trees as zips (as in the browser). */
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
const BASE = 'https://w3id.org/methodos-test/';
function antonine() {
  const d = JSON.parse(readFileSync(join(PLATO_REPO, 'schemas/examples/place-centric-antonine.json'), 'utf8').replaceAll('https://whgazetteer.org/example/antonine/', BASE));
  d.gazetteer.status = 'published';   // w3id rules are written only for a published dataset
  return new File([JSON.stringify(d)], 'antonine.json');
}
const sha = async (f) => createHash('sha256').update(new Uint8Array(await f.arrayBuffer())).digest('hex');

test('driven through "Publish a dataset" with the real engine, the outputs are the files the record names, by their hashes', { timeout: 300000 }, async () => {
  const input = antonine();
  const host = memoryHost([input]);
  const files = await refsOf([input], 'files');
  const { state, reports } = await drive(start(PUBLISH, { release: 'v1', repo: 'pelagios/methodos-test', maintainers: ['docuracy'] }, { files }), host);
  assert.equal(state.status, 'completed', JSON.stringify(state.steps.map((s) => [s.id, s.state, s.problem || s.error])));
  assert.deepEqual(state.steps.map((s) => s.state), ['done', 'done', 'done', 'done', 'done']);
  // Every step reported, and the check read the places: an engine that read nothing would also be clean.
  assert.deepEqual(Object.keys(reports), ['check', 'mint', 'report', 'site', 'w3id']);
  assert.ok(reports.check.counts.places > 0, JSON.stringify(reports.check.counts));
  // Each output the record names is a file the engine wrote, with that size and SHA-256.
  let n = 0;
  for (const s of state.steps) for (const [slot, refs] of Object.entries(s.outputs)) for (const r of refs) {
    const f = host.store.get(r.name);
    assert.ok(f, `${s.id}.${slot}: ${r.name} was not written`);
    assert.equal(r.type, OPERATIONS[s.op].gives[slot]);
    assert.equal(r.size, f.size);
    assert.equal(r.sha256, await sha(f), `${s.id}.${slot}: ${r.name}`);
    n++;
  }
  assert.ok(n >= 5, `only ${n} outputs`);
  // The site and the w3id rules were built from the minted dataset, not from the file chosen.
  const minted = state.steps.find((s) => s.id === 'mint').outputs.dataset;
  assert.notEqual(minted[0].sha256, files[0].sha256);
  assert.deepEqual(runner.inputsOf(state, 'site').dataset, minted);
  // The record round-trips with them.
  assert.deepEqual(deserialise(serialise(state)), state);
});

test('a file that is not the one the record names is refused before the engine runs, as a data problem', async () => {
  const input = antonine();
  const host = memoryHost([input]);
  const files = await refsOf([input], 'files');
  // The presence: the right file passes the check.
  const ok = await drive(start(recipe([{ id: 'check', op: 'check', from: { files: '$files' } }]), {}, { files }), host);
  assert.equal(ok.state.status, 'completed');
  host.store.set('antonine.json', new File([(await input.text()).replace('Londinium', 'Londinivm')], 'antonine.json'));
  const { state } = await drive(start(recipe([{ id: 'check', op: 'check', from: { files: '$files' } }]), {}, { files }), host);
  assert.equal(state.status, 'stopped');
  assert.match(state.steps[0].problem.words, /^antonine\.json: not the file the workflow recorded \(the size or SHA-256 differs\), so nothing was run/);
});
