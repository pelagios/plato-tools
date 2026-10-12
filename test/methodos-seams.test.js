// Methodos at its seams with Chora (Stephen, 12 October 2026, Issue #33 point 5): what a workflow keeps
// in this browser (the user's own file now, beside the files its steps made, under "Keep my working
// data"), the file chosen again when the main page is back (src/methodos/seams.js), the words the
// tracker says of it, Chora's few words of the workflow, and the round trip outside a workflow
// (src/chora/handoff.js: one record for the hand-off and the round trip, kept for the tab while Chora's page lives).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { RECIPES, runner } from '../src/engine/methodos/index.js';
import { stepAt, currentInput, startFiles, madeBy, keptBy, keptWords, trackOf } from '../src/methodos/seams.js';
import { outputStore } from '../src/methodos/outputs.js';
import { RETURN_FRESH, returnOf, takeReturn, returnKept, FRESH, take as takeHandoff, stash, stamp, dropStale, dropStaleReturn, forgetReturn, tx } from '../src/chora/handoff.js';

const ref = (type, name, c) => ({ type, name, size: name.length, sha256: c.repeat(64) });
const OWN = ref('files', 'places.csv', 'a');
// Map your data, with drawing, taken to its step "place" (as e2e/methodos-hook.js's placeAt).
function atPlace() {
  const MAP = RECIPES['map-your-data'];
  let s = runner.start(MAP, { 'has-regions': false, 'will-draw': true, 'will-publish': false, target: 'lpf' }, { files: [OWN] });
  for (const [id, out] of [['columns', { mapping: [ref('mapping', 'columns.json', 'b')] }], ['check', {}], ['dataset', { dataset: [ref('dataset', 'places.json', 'c')] }],
    ['lookup', { work: [ref('work.krisis', 'w.krisis.json', 'd')] }], ['review', { work: [ref('work.krisis', 'w.krisis.json', 'e')] }], ['apply', { dataset: [ref('dataset', 'applied.json', 'f')] }]])
    s = runner.complete(runner.next(s), id, out);
  return s;
}

test('the step a workflow is at, and the file chosen again for it: the user\'s own at the start, a step\'s later, the dataset that went to Chora at its step', () => {
  const MAP = RECIPES['map-your-data'];
  const begun = runner.start(MAP, { 'has-regions': false, 'will-draw': true, 'will-publish': false, target: 'lpf' }, { files: [OWN] });
  assert.equal(stepAt(begun).id, 'columns');
  assert.deepEqual(currentInput(begun), [OWN], 'matching the columns: the table the workflow began with');
  const checking = runner.complete(runner.next(begun), 'columns', { mapping: [ref('mapping', 'columns.json', 'b')] });
  assert.equal(stepAt(checking).id, 'check');
  assert.deepEqual(currentInput(checking), [OWN], 'the check: the user\'s own file');
  const p = atPlace();
  assert.equal(stepAt(p).id, 'place');
  assert.deepEqual(currentInput(p), [ref('dataset', 'applied.json', 'f')], 'Chora\'s step: the dataset the decisions were recorded in');
  // A review's work file is not chosen in step 1: nothing to choose again (the control: a step that has one, above).
  let r = runner.complete(runner.next(checking), 'check', {});
  r = runner.complete(runner.next(r), 'dataset', { dataset: [ref('dataset', 'places.json', 'c')] });
  r = runner.complete(runner.next(r), 'lookup', { work: [ref('work.krisis', 'w.krisis.json', 'd')] });
  assert.equal(stepAt(r).id, 'review');
  assert.equal(currentInput(r), null);
  // A step that stopped is the one the workflow is at; a completed workflow is at none.
  const stopped = runner.stop(runner.next(checking), 'check', { words: 'Put it right.' });
  assert.equal(stepAt(stopped).id, 'check');
  assert.equal(stepAt({ ...p, status: 'completed' }), null);
  assert.equal(stepAt(null), null);
});

test('what a workflow keeps is the user\'s own file and every file its steps made, let go together', () => {
  const p = atPlace();
  assert.deepEqual(startFiles(p), [OWN]);
  const made = madeBy(p).map((x) => x.name);
  assert.deepEqual(made, ['columns.json', 'places.json', 'w.krisis.json', 'w.krisis.json', 'applied.json']);
  assert.deepEqual(keptBy(p).map((x) => x.name), ['places.csv', ...made]);
  // The control: before the user's file was kept too, what was let go was the steps' alone.
  assert.ok(!madeBy(p).some((x) => x.sha256 === OWN.sha256));
  assert.deepEqual(startFiles(null), []);
});

test('the tracker says what is kept honestly: your file, the steps\' files, their size, that nothing leaves the computer; or that nothing of yours is kept', () => {
  const own = [OWN];
  const both = keptWords({ files: [{ sha256: OWN.sha256, size: 1000 }, { sha256: 'c'.repeat(64), size: 1048 }, { sha256: 'f'.repeat(64), size: 48 }], own });
  assert.equal(both, 'Kept in this browser for the next steps: your file and 2 files the steps made (2 KB). Nothing leaves this computer. ');
  assert.match(keptWords({ files: [{ sha256: OWN.sha256, size: 10 }], own }), /^Kept in this browser for the next steps: your file \(10 bytes\)/);
  assert.match(keptWords({ files: [{ sha256: 'c'.repeat(64), size: 10 }], own }), /: 1 file the steps made \(10 bytes\)/);
  assert.match(keptWords({ files: [{ sha256: 'a'.repeat(64), size: 1 }, { sha256: 'b'.repeat(64), size: 1 }], own: [OWN, ref('files', 'b.csv', 'b')] }), /: your 2 files \(/);
  assert.ok(!/never your own/.test(both), 'the old promise is gone');
  assert.equal(keptWords({ files: [], own }), '', 'nothing kept, nothing said');
  const off = keptWords({ files: [], own, keeping: false });
  assert.match(off, /^Nothing of yours is kept in this browser: “Keep my working data” is off/);
  assert.match(off, /back from Chora, you choose your file again/);
  assert.equal(keptWords({ keeping: false, workflow: false }), '', 'no workflow, nothing to say');
});

test('Chora\'s few words of the workflow: its title, "Step n of N" of the steps followed, and the step\'s words', () => {
  const p = atPlace();
  const t = trackOf(p, RECIPES['map-your-data']);
  const followed = p.steps.filter((s) => s.state !== 'skipped');
  assert.deepEqual({ title: t.title, step: t.step, words: t.words, op: t.op, tool: t.tool },
    { title: 'Map your data', step: `Step ${followed.findIndex((s) => s.id === 'place') + 1} of ${followed.length}`, words: 'Draw or trace the places still without a location', op: 'place', tool: 'Chora' });
  assert.equal(t.step, 'Step 7 of 10');
  assert.equal(trackOf({ ...p, status: 'completed' }, RECIPES['map-your-data']), null);
});

// ---- The user's own file kept in OPFS (src/methodos/outputs.js keepOwn), under "Keep my working data".
function fakeOpfs() {
  const dirs = new Map();
  const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });
  const dirHandle = (files) => ({
    async getFileHandle(name, { create } = {}) {
      if (!files.has(name)) { if (!create) throw notFound(); files.set(name, new Uint8Array(0)); }
      return {
        async getFile() { if (!files.has(name)) throw notFound(); return new File([files.get(name)], name); },
        async createWritable() {
          const parts = [];
          return new WritableStream({ write(c) { parts.push(c); }, close() { files.set(name, new Uint8Array(Buffer.concat(parts.map((x) => Buffer.from(x))))); } });
        },
      };
    },
    async removeEntry(name) { if (!files.delete(name)) throw notFound(); },
    async *entries() { for (const name of [...files.keys()]) yield [name, { kind: 'file', ...(await this.getFileHandle(name)) }]; },
  });
  const root = {
    async getDirectoryHandle(name, { create } = {}) { if (!dirs.has(name)) { if (!create) throw notFound(); dirs.set(name, new Map()); } return dirHandle(dirs.get(name)); },
    async removeEntry(name) { if (!dirs.delete(name)) throw notFound(); },
  };
  return { dirs, root: async () => root };
}
const sha = async (f) => Buffer.from(await crypto.subtle.digest('SHA-256', await f.arrayBuffer())).toString('hex');

test('the user\'s own file is kept in the browser where working data is kept, found again by a later page, and let go with the workflow', async () => {
  const disk = fakeOpfs();
  const file = new File(['name,lat,lon\nAbingdon,51.67,-1.28\n'], 'places.csv');
  const r = { type: 'files', name: file.name, size: file.size, sha256: await sha(file) };
  const page1 = outputStore({ root: disk.root, keep: () => true });
  assert.equal(await page1.keepOwn(r, file), 'browser');
  assert.equal(page1.held(r), file, 'the tab holds the user\'s own File, not a copy');
  const { files } = await page1.kept();
  assert.deepEqual(files, [{ sha256: r.sha256, size: file.size }]);
  assert.match(keptWords({ files, own: [r] }), /your file \(/);
  // A later page (after a reload, or back from Chora) finds it, the same bytes under the same name.
  const page2 = outputStore({ root: disk.root, keep: () => true });
  const again = await page2.get(r);
  assert.equal(again.name, 'places.csv');
  assert.equal(await again.text(), await file.text());
  // Let go with the workflow (Leave): nothing is left.
  await page2.drop([r]);
  assert.equal(await outputStore({ root: disk.root, keep: () => true }).get(r), null);
  assert.deepEqual((await page2.kept()).files, []);
});

test('with "Keep my working data" off, nothing of the user\'s is written to the browser: the file lasts for the tab, and is not found by a later page', async () => {
  const disk = fakeOpfs();
  const file = new File(['a,b\n1,2\n'], 'mine.csv');
  const r = { type: 'files', name: file.name, size: file.size, sha256: await sha(file) };
  // The presence first: kept, it is on the disk.
  assert.equal(await outputStore({ root: disk.root, keep: () => true }).keepOwn(r, file), 'browser');
  assert.ok(disk.dirs.get('methodos-outputs')?.has(r.sha256));
  const off = outputStore({ root: disk.root, keep: () => false });
  assert.equal(await off.keepOwn(r, file), 'tab');
  assert.equal(off.held(r), file, 'still chosen in the tab');
  assert.equal(disk.dirs.has('methodos-outputs'), false, 'what was kept went, the folder too');
  assert.equal(await outputStore({ root: disk.root, keep: () => false }).get(r), null);
  assert.deepEqual(await off.kept(), { count: 0, bytes: 0, files: [] });
});

test('"Clear them", and working data turned off, never read the user\'s own file into memory: held as chosen it stays, read from OPFS it is no longer held; the steps\' files are copied', async () => {
  const disk = fakeOpfs();
  const file = new File(['x,y\n'], 'own.csv'), made = new File(['{"made":1}'], 'made.json');
  const r = { type: 'files', name: file.name, size: file.size, sha256: await sha(file) };
  const m = { type: 'dataset', name: made.name, size: made.size, sha256: await sha(made) };
  await outputStore({ root: disk.root, keep: () => true }).keepOwn(r, file);
  await outputStore({ root: disk.root, keep: () => true }).put(m, made);
  // A later page holds both from the disk (after a reload).
  let keeping = true;
  const page = outputStore({ root: disk.root, keep: () => keeping });
  const fromDisk = await page.get(r);
  await page.keepOwn(r, fromDisk); await page.get(m);   // chosen again in step 1, as the page does: its own
  // Held as read from OPFS, then marked as the user's (as the page does on choosing it): watched for whole reads.
  let readWhole = 0;
  for (const k of ['arrayBuffer', 'text', 'bytes']) { const f = page.held(r); const orig = f[k].bind(f); f[k] = (...a) => { readWhole++; return orig(...a); }; }
  keeping = false; await page.forget();
  assert.equal(disk.dirs.has('methodos-outputs'), false);
  assert.equal(readWhole, 0, 'the user\'s own file was not read into memory');
  assert.equal(page.held(r), undefined, 'no longer held: it is chosen again by hand');
  assert.equal(await page.held(m).text(), '{"made":1}', 'the steps\' file is copied into memory, as before');
  // The user's own File as they chose it (no copy) stays held through "Clear them".
  keeping = true;
  const page2 = outputStore({ root: disk.root, keep: () => keeping });
  assert.equal(await page2.keepOwn(r, file), 'browser');
  await page2.clear();
  assert.equal(page2.held(r), file);
  assert.equal(disk.dirs.has('methodos-outputs'), false);
});

test('the user\'s own file is not written where the browser says there is not room for it, and a failed write is said', async () => {
  const disk = fakeOpfs();
  const file = new File(['a'.repeat(5000)], 'big.csv');
  const r = { type: 'files', name: file.name, size: file.size, sha256: await sha(file) };
  const short = outputStore({ root: disk.root, keep: () => true, estimate: async () => ({ quota: 2_000_000, usage: 1_500_000 }) });
  assert.equal(await short.keepOwn(r, file), 'short');
  assert.equal(disk.dirs.get('methodos-outputs')?.has(r.sha256) ?? false, false, 'nothing written');
  assert.equal(short.held(r), file, 'still chosen in the tab');
  // The control: with room, it is kept.
  const roomy = outputStore({ root: disk.root, keep: () => true, estimate: async () => ({ quota: 1e9, usage: 0 }) });
  assert.equal(await roomy.keepOwn(r, file), 'browser');
  // A write the browser refuses is 'failed', and leaves nothing.
  const broken = { root: async () => ({ getDirectoryHandle: async () => ({ getFileHandle: async (n, o) => { if (!o?.create) throw Object.assign(new Error('nf'), { name: 'NotFoundError' }); return { createWritable: async () => { throw new Error('QuotaExceededError'); } }; }, removeEntry: async () => {} }) }) };
  assert.equal(await outputStore({ ...broken, keep: () => true, estimate: async () => ({ quota: 1e9, usage: 0 }) }).keepOwn(r, file), 'failed');
  // The tracker says it, by name.
  assert.match(keptWords({ files: [], own: [r], missed: [{ name: 'big.csv', why: 'short' }] }), /^big\.csv could not be kept in this browser \(it has not room enough\): after a reload, or back from Chora, choose it again/);
  assert.match(keptWords({ files: [{ sha256: 'c'.repeat(64), size: 10 }], own: [r], missed: [{ name: 'big.csv', why: 'failed' }] }), /file the steps made .*big\.csv could not be kept in this browser \(it would not keep it\)/);
});

// ---- One record for the hand-off and the round trip (src/chora/handoff.js) ------------------------
class Session { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }
beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
const raw = () => tx('readonly', (s) => s.getAll());

test('the round trip is judged on read: this tab\'s, taken by Chora, alive within five minutes of its last stamp, files that are files, a tool that is a key', () => {
  const NOW = 1_800_000_000_000, f = new File(['{}'], 'a.json');
  const v = { files: [f], at: NOW - 3_600_000, id: 'r1', ret: { tab: 't1', tool: 'check' } }, a = { id: 'r1', at: NOW - 1000 };
  assert.deepEqual(returnOf(v, a, 't1', NOW), { files: [f], tool: 'check' }, 'an hour old, and alive: the record\'s own age does not count');
  assert.equal(RETURN_FRESH, 5 * 60 * 1000);
  assert.ok(RETURN_FRESH > FRESH);
  assert.equal(returnOf(v, { ...a, at: NOW - RETURN_FRESH }, 't1', NOW), null, 'not stamped for five minutes');
  assert.equal(returnOf(v, { ...a, at: NOW - RETURN_FRESH + 1 }, 't1', NOW)?.files.length, 1);
  assert.equal(returnOf(v, { ...a, at: NOW + 60_000 }, 't1', NOW), null, 'a stamp from the future');
  assert.equal(returnOf(v, null, 't1', NOW), null, 'never taken by Chora');
  assert.equal(returnOf(v, { ...a, id: 'other' }, 't1', NOW), null, 'another record\'s stamp');
  assert.equal(returnOf(v, a, 't2', NOW), null, 'another tab\'s');
  assert.equal(returnOf({ ...v, ret: undefined }, a, 't1', NOW), null, 'a plain hand-off');
  assert.equal(returnOf({ ...v, files: [{ name: 'x', size: 1 }] }, a, 't1', NOW), null, 'not a file');
  assert.equal(returnOf({ ...v, ret: { tab: 't1', tool: '<img src=x>' } }, a, 't1', NOW).tool, null);
});

test('the files are written once: Chora takes the hand-off, which stays as the round trip, never opened twice; the main page takes it once on return', async () => {
  const tab = new Session(), other = new Session();
  const f = new File(['{"places":[]}'], 'mine.json');
  assert.equal(await stash([f], { forReturn: { tool: 'check' }, session: tab }), true);
  assert.equal((await raw()).length, 1, 'one record: the files, once');
  assert.equal(await returnKept({ session: tab }), null, 'not a round trip until Chora has taken it');
  assert.equal((await takeHandoff())[0].name, 'mine.json', 'Chora opens it');
  assert.equal(await takeHandoff(), null, 'and never twice (a reload of Chora opens nothing)');
  assert.deepEqual(await returnKept({ session: tab }), ['mine.json'], 'Chora can say it is kept, without taking it');
  assert.equal(await takeReturn({ session: other }), null, 'another tab does not take it');
  const got = await takeReturn({ session: tab });
  assert.equal(got.files[0].name, 'mine.json'); assert.equal(got.tool, 'check');
  assert.equal(await takeReturn({ session: tab }), null, 'taken once');
  assert.deepEqual(await raw(), [], 'nothing left: record and stamp');
  // A plain hand-off (a workflow's, or with working data off) is let go by Chora at once, as before.
  await stash([f], { session: tab });
  assert.equal((await takeHandoff())[0].name, 'mine.json');
  assert.deepEqual(await raw(), []);
  // Marked, but taken where working data is no longer kept: let go at once too.
  await stash([f], { forReturn: { tool: null }, session: tab });
  await takeHandoff({ keep: false });
  assert.deepEqual(await raw(), []);
});

test('the round trip lives while Chora stamps it: a stamp rewrites no files; five minutes unstamped, it is swept by whichever page looks', async () => {
  const tab = new Session(), f = new File(['{}'], 'mine.json');
  await stash([f], { forReturn: {}, session: tab });
  const t0 = Date.now();
  await takeHandoff({ now: t0 });
  // Stamped later: the stamp moves, the record (the files) is the same object kept.
  await stamp(t0 + 4 * 60_000);
  const stampKept = await tx('readonly', (s) => s.get('chora-handoff-alive'));
  assert.equal(stampKept.at, t0 + 4 * 60_000);
  assert.deepEqual(Object.keys(stampKept).sort(), ['at', 'id'], 'the stamp holds an id and a time, nothing else');
  // Alive (stamped four minutes after the start): a sweep at eight minutes leaves it.
  assert.equal(await dropStaleReturn(t0 + 8 * 60_000), false);
  assert.equal(await dropStale(t0 + 8 * 60_000), false, 'the hand-off\'s own two minutes do not sweep a round trip that is alive');
  assert.deepEqual(await returnKept({ session: tab, now: t0 + 8 * 60_000 }), ['mine.json']);
  // Nine minutes and more after the last stamp: swept, record and stamp.
  assert.equal(await dropStaleReturn(t0 + 9 * 60_000 + 1), true);
  assert.deepEqual(await raw(), []);
  // A stamp with no record goes too; a hand-off never taken goes after two minutes (dropStale), as before.
  await tx('readwrite', (s) => s.put({ id: 'orphan', at: Date.now() }, 'chora-handoff-alive'));
  assert.equal(await dropStaleReturn(), true);
  await stash([f], { forReturn: {}, session: tab });
  assert.equal(await dropStale(Date.now() + FRESH + 1), true);
  assert.deepEqual(await raw(), []);
});

test('working data turned off: the round trip is let go, and a return does not act on it but deletes it', async () => {
  const tab = new Session(), f = new File(['{}'], 'mine.json');
  // Presence first: kept and taken by Chora.
  await stash([f], { forReturn: {}, session: tab }); await takeHandoff();
  assert.deepEqual(await returnKept({ session: tab }), ['mine.json']);
  await forgetReturn();
  assert.deepEqual(await raw(), []);
  // A return after the permission was turned off: not used, and deleted.
  await stash([f], { forReturn: {}, session: tab }); await takeHandoff();
  assert.equal(await takeReturn({ keep: false, session: tab }), null);
  assert.deepEqual(await raw(), []);
  // A plain hand-off on its way to Chora is not the round trip's, and stays.
  await stash([f], { session: tab });
  await forgetReturn();
  assert.equal((await raw()).length, 1);
});
