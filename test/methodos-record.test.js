// Methodos phase 2: the workflow's record, saving it at step boundaries, resuming it, and the version
// rule (docs/plans/methodos.md, sections 7 and 9). Every refusal is paired with the same thing done
// rightly passing, and every absence (nothing kept) with a presence (the same save, kept).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { RECIPES, digest, runner, drive, recordOf, atBoundary, fileName, exportRecord, importRecord, reconcile, restartRemaining, checkFiles, checkChosen, RecordError, refsOf } from '../src/engine/methodos/index.js';
import { workflowStore, DB, STORE, TAB } from '../src/methodos/store.js';

const { start, next, complete } = runner;
const PUBLISH = RECIPES['publish-a-dataset'];
const hex = (c) => c.repeat(64);
const ref = (type, name, c = 'a') => ({ type, name, size: 10, sha256: hex(c) });
const copy = (r) => JSON.parse(JSON.stringify({ ...r, digest: undefined }));
const NOW = new Date('2026-10-03T10:00:00Z');

// Publish a dataset, its check and mint done: at the FAIR report.
function midway(recipe = PUBLISH) {
  let s = start(recipe, { release: 'v1' }, { files: [ref('files', 'p.json')] });
  s = complete(next(s), 'check', {});
  s = complete(next(s), 'mint', { dataset: [ref('dataset', 'p.minted.json', 'b')] });
  return recordOf(s, { name: 'My places', now: NOW });
}

class Storage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
const idbKeys = (idb) => new Promise((resolve, reject) => {
  const req = idb.open(DB, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(STORE);
  req.onsuccess = () => { const db = req.result, g = db.transaction(STORE).objectStore(STORE).getAllKeys(); g.onsuccess = () => { db.close(); resolve(g.result); }; g.onerror = () => reject(g.error); };
  req.onerror = () => reject(req.error);
});

test('the same recipe: the workflow continues where it was, saying nothing', () => {
  const rec = midway();
  const r = reconcile(rec, PUBLISH);
  assert.equal(r.action, 'continue');
  assert.equal(r.words, '');
  assert.deepEqual(r.state, rec);
  assert.equal(runner.next(r.state).current, 'report');
});

test("only the recipe's words changed: it continues, and says so", () => {
  const rec = midway();
  const reworded = copy(PUBLISH);
  reworded.steps[2].title = 'Write the FAIR report for the deposit';
  assert.notEqual(digest(reworded), rec.recipe.digest);
  const r = reconcile(rec, reworded);
  assert.equal(r.action, 'continue');
  assert.match(r.words, /words of "Publish a dataset" have changed.*steps have not/);
  assert.equal(r.state.recipe.digest, digest(reworded));
  assert.equal(r.state.steps[2].title, 'Write the FAIR report for the deposit');
  assert.deepEqual(r.state.steps.map((s) => [s.id, s.state]), rec.steps.map((s) => [s.id, s.state]));
  assert.equal(rec.recipe.digest, PUBLISH.digest, 'the record itself is not changed');
});

test('a changed step under the same version is not continued blindly', () => {
  const rec = midway();
  // The same version, the same ids and operations, but the site is built from the files as chosen.
  const rewired = copy(PUBLISH);
  rewired.steps[3].from = { dataset: '$files' };
  const r = reconcile(rec, rewired);
  assert.equal(r.action, 'changed');
  assert.equal(r.lastDone, 'mint');
  assert.match(r.words, /has changed since this workflow was saved \(version 1 then, 1 now\).*last finished step, "Give every place and source a permanent address".*start the remaining steps under the new recipe, or leave/);
  assert.equal(r.state, undefined, 'no state to carry on from is offered');
  // A step's operation changed, ids kept.
  const swapped = copy(PUBLISH);
  swapped.steps[4].op = 'publish.site';
  swapped.steps[3].op = 'publish.w3id';
  assert.equal(reconcile(rec, swapped).action, 'changed');
});

test('a new version of the recipe: it stays at its last finished step and offers a restart', () => {
  const rec = midway();
  const v2 = copy(PUBLISH);
  v2.version = 2;
  v2.steps.splice(2, 0, { id: 'compare', op: 'compare', title: 'Compare with the last release', from: { earlier: '$files', later: 'mint.dataset' } });
  const r = reconcile(rec, v2);
  assert.equal(r.action, 'changed');
  assert.match(r.words, /version 1 then, 2 now/);
  // Restarting the remaining steps keeps check and mint (the same in both) and does the rest again.
  const s = restartRemaining(rec, v2);
  assert.deepEqual(s.steps.map((x) => [x.id, x.state]), [['check', 'done'], ['mint', 'done'], ['compare', 'pending'], ['report', 'pending'], ['site', 'pending'], ['w3id', 'pending']]);
  assert.deepEqual(s.steps[1].outputs, rec.steps[1].outputs);
  assert.equal(s.recipe.digest, digest(v2));
  assert.equal(s.recipe.version, 2);
  assert.equal(s.id, rec.id);
  assert.equal(runner.next(s).current, 'compare');
  // A first step that changed keeps nothing after it.
  const v3 = copy(v2); v3.version = 3; v3.steps[0].title = 'Check'; v3.steps[1].options = {};
  assert.deepEqual(restartRemaining(rec, v3).steps.map((x) => x.state), ['done', 'pending', 'pending', 'pending', 'pending', 'pending']);
  // The words branch is only for the same version: the same steps under a new version are a change.
  const bumped = copy(PUBLISH); bumped.version = 2;
  assert.equal(reconcile(rec, bumped).action, 'changed');
});

test("a new recipe that cannot take the record's answers is refused in words", () => {
  const rec = midway();
  const v2 = copy(PUBLISH); v2.version = 2; delete v2.asks.release;
  v2.steps = v2.steps.map((s) => ({ ...s, options: Object.fromEntries(Object.entries(s.options || {}).filter(([, v]) => v !== '$release')) }));
  assert.equal(reconcile(rec, v2).action, 'changed');
  assert.throws(() => restartRemaining(rec, v2), (e) => e instanceof RecordError && /do not fit the new "Publish a dataset".*does not ask "release".*started afresh/.test(e.message));
});

test('a record of a recipe these tools do not have is refused', () => {
  const rec = midway();
  assert.match(reconcile(rec, undefined).words, /followed the recipe "publish-a-dataset", which these tools do not have/);
  assert.equal(reconcile(rec, RECIPES['map-your-data']).action, 'refuse');
  assert.equal(reconcile(rec, PUBLISH).action, 'continue');
});

test('a record saved while a step ran resumes at that step, failed, to run again', () => {
  const s = runner.next(midway());
  assert.equal(s.status, 'running');
  assert.equal(atBoundary(s), false);
  const r = reconcile(s, PUBLISH);
  assert.equal(r.state.status, 'failed');
  assert.equal(r.state.steps[2].state, 'failed');
  assert.match(r.state.steps[2].error, /page was closed while this step was running/);
  // One that says a step is running and not which is refused in words.
  assert.throws(() => reconcile({ ...s, current: null }, PUBLISH), (e) => e instanceof RecordError && /says a step is running, but not which/.test(e.message));
});

test('.workflow.json: a record round-trips, and what is not one is refused', () => {
  const rec = midway();
  const text = exportRecord(rec);
  assert.deepEqual(importRecord(text), rec);
  assert.equal(exportRecord(importRecord(text)), text);
  assert.equal(fileName(rec), 'My-places.workflow.json');
  assert.equal(fileName({ name: '../../x y' }), 'x-y.workflow.json');
  // It holds references only: no file's content, under any key.
  assert.ok(!/"(content|text|data|bytes|blob)"/.test(text), text);
  // One written by hand, with no id or name, is given them.
  const bare = JSON.parse(text); delete bare.id; delete bare.name;
  const got = importRecord(JSON.stringify(bare));
  assert.match(got.id, /\S/); assert.equal(got.name, 'publish-a-dataset');
  assert.throws(() => importRecord('{'), (e) => e instanceof RecordError && /not JSON/.test(e.message));
  assert.throws(() => importRecord(JSON.stringify({ ...rec, methodos: 9 })), RecordError);
  assert.throws(() => importRecord(JSON.stringify({ ...rec, id: 7 })), /its id is not text/);
  const damaged = JSON.parse(text); damaged.files.files[0].sha256 = 'nope';
  assert.throws(() => importRecord(JSON.stringify(damaged)), /a file chosen is not a reference to a file/);
});

test('a record that names a different file is refused, by filesDiffer; the same file passes', async () => {
  const mine = new File(['{"places": []}'], 'p.json'), other = new File(['{"places": [1]}'], 'p.json');
  let s = start(PUBLISH, {}, { files: await refsOf([mine], 'files') });
  const rec = recordOf(s, { name: 'x' });
  assert.equal(await checkChosen(rec, { files: [mine] }), true);
  await assert.rejects(checkChosen(rec, { files: [other] }), (e) => e instanceof RecordError && /not the files this workflow was begun with \("files"\): p\.json, p\.json differ\. Choose p\.json as they were/.test(e.message));
  await assert.rejects(checkChosen(rec, {}), /p\.json differs/);
  await assert.rejects(checkFiles(rec.files.files, [mine, other]), /p\.json differs/);
});

test('the store: a record saved at each step boundary is found again by a new page, at the same step', async () => {
  const idb = new IDBFactory(), session = new Storage();
  const store = workflowStore({ indexedDB: idb, session, keep: () => true });
  let { record } = await store.save(start(PUBLISH, {}, { files: [ref('files', 'p.json')] }), { name: 'Mine' });
  assert.equal(record.name, 'Mine');
  // Driven with stand-in adapters: check passes, mint gives a dataset, the report stops on a problem.
  const saved = [];
  const adapters = {
    check: async () => ({ outputs: {} }),
    'publish.mint': async () => ({ outputs: { dataset: [ref('dataset', 'p.minted.json', 'b')] } }),
    'publish.report': async () => ({ outputs: {}, problem: { words: 'Give the dataset a licence.' } }),
  };
  const r = await drive(record, null, { adapters, atBoundary: async (s) => { saved.push([s.status, s.steps.map((x) => x.state).join(' ')]); await store.save(s); } });
  assert.equal(r.state.status, 'stopped');
  assert.deepEqual(saved, [['idle', 'done pending pending pending pending'], ['idle', 'done done pending pending pending'], ['stopped', 'done done stopped pending pending']]);
  // A new page: a new store over the same browser.
  const again = workflowStore({ indexedDB: idb, session: new Storage(), keep: () => true });
  const back = await again.load(record.id);
  assert.deepEqual(back, { ...r.state, saved: back.saved });
  assert.equal(back.steps.find((s) => s.state === 'stopped').id, 'report');
  assert.deepEqual((await again.list()).map((x) => x.id), [record.id]);
  assert.deepEqual(await idbKeys(idb), [record.id]);
  await again.remove(record.id);
  assert.equal(await again.load(record.id), null);
  assert.deepEqual(await idbKeys(idb), []);
});

test('with "keep working data" off, a record is kept for the tab only, and none is left in the browser', async () => {
  const idb = new IDBFactory();
  let keep = true;
  const session = new Storage();
  const store = workflowStore({ indexedDB: idb, session, keep: () => keep });
  // Kept, first: it is in IndexedDB (the presence beside the absence below).
  const kept = await store.save(midway());
  assert.equal(kept.kept, 'browser');
  assert.deepEqual(await idbKeys(idb), [kept.record.id]);
  assert.equal(session.length, 0);
  // Turned off: the next save keeps it for the tab, and what IndexedDB held is let go.
  keep = false;
  const tabOnly = await store.save(kept.record);
  assert.equal(tabOnly.kept, 'tab');
  assert.deepEqual(await idbKeys(idb), []);
  assert.ok(session.getItem(TAB + kept.record.id));
  // The same tab reloaded finds it; a new tab (its own sessionStorage) finds nothing.
  assert.equal((await workflowStore({ indexedDB: idb, session, keep: () => false }).load(kept.record.id)).id, kept.record.id);
  const newTab = workflowStore({ indexedDB: idb, session: new Storage(), keep: () => false });
  assert.equal(await newTab.load(kept.record.id), null);
  assert.deepEqual(await newTab.list(), []);
  // A record kept before the choice was made is let go the next time the store is used.
  const before = await workflowStore({ indexedDB: idb, session: new Storage(), keep: () => true }).save(midway());
  assert.deepEqual(await idbKeys(idb), [before.record.id]);
  assert.deepEqual(await newTab.list(), []);
  assert.deepEqual((await idb.databases()).map((d) => d.name), [], 'not even the database is left');
  assert.deepEqual(await idbKeys(idb), []);
});

test('a browser that refuses storage gets a workflow that lives for the tab', async () => {
  const refusing = { open() { throw new Error('refused'); } };
  const store = workflowStore({ indexedDB: refusing, session: null, keep: () => true });
  const { record, kept } = await store.save(midway());
  assert.equal(kept, 'tab');
  assert.equal((await store.load(record.id)).id, record.id);
  assert.equal(await workflowStore({ indexedDB: refusing, session: null, keep: () => true }).load(record.id), null);
});
