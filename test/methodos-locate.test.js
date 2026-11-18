// Map your data, from the decisions recorded to the end: the matched places' locations taken in a step of their own
// (src/engine/chora/locate.js, through its adapter), into the file the workflow carries on with, so that the dataset
// checked, compared, seen on a map and written out is the one with the locations. The dataset and the review are the
// fixture's (test/locate-fixture.js: the decisions recorded by Krisis's own Finish); nothing here asks any service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { openSqlite } from '../src/lib/store.js';
import { res } from './engine.js';
import { serialiseWork } from '../src/engine/krisis/work.js';
import { RECIPES, OPERATIONS, ADAPTERS, runner, drive, runStep, refsOf, checkRecipe } from '../src/engine/methodos/index.js';
import { plan as planOf } from '../src/engine/methodos/interview.js';
import { P, W3, WHO, ATTRIBUTION, workOf, recorded } from './locate-fixture.js';

const MAP = RECIPES['map-your-data'];
const ANSWERS = { 'has-regions': false, 'will-draw': false, 'will-publish': false, target: 'plato-json' };

/** A front end in memory (as test/methodos.test.js's): files by name, the engine's outputs kept as files. */
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
        output: async (name) => { const parts = []; return { write: (s) => parts.push(s), writeBytes: (b) => parts.push(b), close: async () => { const f = new File(parts, name); store.set(name, f); made.push(name); return { name, size: f.size }; } }; },
      };
      return { env, finish: (failed) => { if (failed) for (const n of made) store.delete(n); } };
    },
  };
}
/** The workflow with its decisions recorded (the step "apply" done with the fixture's dataset), about to take the locations. */
async function decided({ answers = ANSWERS, attribution = ATTRIBUTION, host: more = {} } = {}) {
  const { table, file } = await recorded();
  const work = new File([serialiseWork(workOf(table, { late: false, attribution }))], 'bay.krisis.json');
  const columns = new File(['{}'], 'columns.json');
  const host = Object.assign(memoryHost([table, file, work, columns]), more);
  let s = runner.start(MAP, answers, { files: await refsOf([table], 'files') });
  const done = [['columns', { mapping: await refsOf([columns], 'mapping') }], ['check', {}], ['dataset', { dataset: await refsOf([table], 'dataset') }],
    ['lookup', { work: await refsOf([work], 'work.krisis') }], ['review', { work: await refsOf([work], 'work.krisis') }], ['apply', { dataset: await refsOf([file], 'dataset') }]];
  for (const [id, out] of done) s = runner.complete(runner.next(s), id, out);
  return { state: s, host, applied: file };
}
const step = (state, id) => state.steps.find((x) => x.id === id);
const docOf = async (host, ref) => JSON.parse(await host.store.get(ref.name).text());
const located = (doc) => doc.spatialEntities.filter((e) => (e.attestations || []).some((a) => a.geometries)).map((e) => e['@id'].slice(P.length));
/** The step "See your places on a map", said done as the page says it: the dataset shown is handed on as it is. */
const seen = (state) => runner.complete(state, 'see', { dataset: runner.inputsOf(state, 'see').dataset });

test('the recipe: the locations are taken from the dataset the decisions were recorded in and the review\'s work file, and every later step takes the dataset that step made', () => {
  assert.equal(checkRecipe(MAP), MAP);
  assert.equal(MAP.version, 5);
  const by = Object.fromEntries(MAP.steps.map((s) => [s.id, s]));
  assert.deepEqual(by.locate.from, { dataset: 'relate.dataset ?? apply.dataset', work: 'wikidata.work ?? review.work' });
  // The review is taken, not only the dataset: the sources' licences are kept nowhere else.
  assert.deepEqual(OPERATIONS.locate.takes, { dataset: { types: ['files', 'dataset'] }, work: { types: ['work.krisis'] } });
  assert.deepEqual([OPERATIONS.locate.kind, OPERATIONS.locate.networked, OPERATIONS.locate.permissions, OPERATIONS.locate.available], ['automatic', false, [], true]);
  assert.equal(typeof ADAPTERS.locate, 'function');
  assert.deepEqual([by.place.from.dataset, by.again.from.files, by.compare.from.later, by.see.from.dataset], ['locate.dataset', 'place.dataset ?? locate.dataset', 'place.dataset ?? locate.dataset', 'place.dataset ?? locate.dataset']);
  assert.deepEqual([by.out.from.files, by.mint.from.dataset], ['see.dataset', 'see.dataset']);
  // It ends on a map: the step before "Write it out", in every plan, in plain words.
  const ids = MAP.steps.map((s) => s.id);
  assert.equal(ids[ids.indexOf('out') - 1], 'see');
  assert.deepEqual([by.see.title, by.see.when, OPERATIONS[by.see.op].kind], ['See your places on a map', undefined, 'interactive']);
  assert.equal(by.locate.title, 'Use the locations of the places you matched');
  for (const draw of [false, true]) assert.deepEqual(planOf('map-your-data', { ...ANSWERS, 'will-draw': draw }).steps.map((s) => s.id).slice(-3), ['compare', 'see', 'out']);
  assert.equal(MAP.asks['will-draw'].question, 'Some places may not be found. Do you want to place them by hand on a map afterwards?');
  // No new word of the tools' own in what the user reads of the two steps.
  for (const s of [by.locate, by.see]) assert.doesNotMatch(`${s.title} ${OPERATIONS[s.op].waitsFor || ''}`, /attestation|Chora|Krisis|IC-\d/);
  assert.match(`${by.place.title} ${OPERATIONS.place.waitsFor}`, /attestation|Chora|Krisis|IC-\d/);   // (the same check finds such a word where there is one: the presence)
});

test('the locations are in the file the workflow carries on with: checked, compared, seen on a map and written out, the result has them', async () => {
  const a = await decided();
  const b = await drive(a.state, a.host);
  // Taken by the step, checked and compared; then the workflow waits to be seen on a map.
  assert.deepEqual([b.state.status, b.state.current], ['waiting', 'see'], JSON.stringify(b.state.steps.map((s) => [s.id, s.state, s.problem || s.error])));
  const made = step(b.state, 'locate').outputs.dataset;
  assert.deepEqual(made.map((r) => r.name), ['bay.krisis-dataset.located.json']);
  assert.notEqual(made[0].sha256, step(b.state, 'apply').outputs.dataset[0].sha256);
  assert.deepEqual(b.reports.locate.counts, { matched: 9, use: 4, located: 1, noLocation: 1, unknownLicence: 1, notRedistributable: 1, leftForYou: 1, notRecorded: 0, attestationsAdded: 4 });
  // The file chain: the check, the comparison and the map each take that very file (by its hash), with nothing to choose.
  for (const [id, slot] of [['again', 'files'], ['compare', 'later'], ['see', 'dataset']]) assert.deepEqual(runner.inputsOf(b.state, id)[slot], made, id);
  assert.equal(b.reports.again.errors, 0, JSON.stringify(b.reports.again.items));
  assert.equal(b.reports.compare.errors, 0, 'compared with the dataset made from the table: only added to');
  assert.deepEqual(located(await docOf(a.host, made[0])), ['gdansk', 'oliva', 'puck', 'tczew', 'gdynia']);
  assert.deepEqual(located(await docOf(a.host, step(b.state, 'apply').outputs.dataset[0])), ['gdynia'], 'before the step: only the one the table gave');
  // Seen, and written out: the result of the workflow has the locations (it had none of them before this step was).
  const c = await drive(seen(b.state), a.host);
  assert.equal(c.state.status, 'completed', JSON.stringify(c.state.steps.map((s) => [s.id, s.state, s.problem || s.error])));
  assert.deepEqual(runner.inputsOf(c.state, 'out').files, made);
  const out = await docOf(a.host, step(c.state, 'out').outputs.dataset[0]);
  assert.deepEqual(located(out), ['gdansk', 'oliva', 'puck', 'tczew', 'gdynia']);
  const g = out.spatialEntities.find((e) => e['@id'] === P + 'gdansk').attestations.find((x) => x.geometries);
  assert.deepEqual([g.geometries[0].geojson.coordinates, g.contributor, g.citations[0].locator], [[18.6466384, 54.3520252], WHO, W3 + 'place:gn:1']);
  // Who took them: the review's reviewer here; the host's (the page's remembered name) when it gives one.
  const named = await decided({ host: { reviewer: () => ({ name: 'Bea Mapper' }) } });
  const n = await drive(named.state, named.host);
  const by = (await docOf(named.host, step(n.state, 'locate').outputs.dataset[0])).spatialEntities.flatMap((e) => e.attestations).filter((x) => x.geometries && x.contributor).map((x) => x.contributor.name);
  assert.deepEqual(by, ['Bea Mapper', 'Bea Mapper', 'Bea Mapper', 'Bea Mapper']);
});

test('a host that can ask is shown the counts first: declined, the dataset goes on as it was; a source with no licence stated is used only on its word', async () => {
  // Declined: nothing is written, and the next steps take the dataset as the decisions left it.
  const asked = [];
  const no = await decided({ host: { locate: async (plan, withUnknown) => { asked.push([plan.counts.use, plan.counts.unknownLicence, withUnknown.use]); return { use: false }; } } });
  const n = await drive(no.state, no.host);
  assert.deepEqual(asked, [[4, 1, 5]], 'asked once, with what would be done, and what would with the unlicensed source used too');
  assert.equal(n.state.current, 'see');
  assert.deepEqual(step(n.state, 'locate').outputs.dataset, step(n.state, 'apply').outputs.dataset);
  assert.ok(![...no.host.store.keys()].some((k) => k.includes('.located.')), [...no.host.store.keys()].join(' '));
  assert.ok(no.host.store.has('bay.krisis-dataset.json'));
  // Agreed, as it is: the four with a licence, and Hel left out.
  const yes = await decided({ host: { locate: async () => ({}) } });
  const y = await drive(yes.state, yes.host);
  assert.deepEqual(located(await docOf(yes.host, step(y.state, 'locate').outputs.dataset[0])), ['gdansk', 'oliva', 'puck', 'tczew', 'gdynia']);
  // And with the source whose licence is not stated: Hel too, its note saying whose choice that was.
  const all = await decided({ host: { locate: async () => ({ allowUnknown: true }) } });
  const l = await drive(all.state, all.host);
  const doc = await docOf(all.host, step(l.state, 'locate').outputs.dataset[0]);
  assert.deepEqual(located(doc), ['gdansk', 'oliva', 'hel', 'puck', 'tczew', 'gdynia']);
  assert.match(doc.spatialEntities.find((e) => e['@id'] === P + 'hel').attestations.find((x) => x.geometries).notes, /Ada Surveyor chose to use it all the same, for this batch\.$/);
  assert.equal(l.reports.locate.counts.unknownLicence, 0);
});

test('with nothing that can be used the step is done with the dataset as it was, and says why; undone, the workflow is back at the step with that dataset', async () => {
  // No licences in the review (the lookup's attribution lost): every source reads as not stated, and none is used unasked.
  const a = await decided({ attribution: null });
  const b = await drive(a.state, a.host);
  assert.equal(b.state.current, 'see');
  assert.deepEqual([b.reports.locate.counts.use, b.reports.locate.counts.unknownLicence, b.reports.locate.counts.matched], [0, 7, 9]);
  assert.deepEqual(step(b.state, 'locate').outputs.dataset, step(b.state, 'apply').outputs.dataset);
  assert.ok(b.reports.locate.items.some((i) => i.kind === 'locate-nothing'));
  // Undone (the tracker's "Undo", and "Back a step": the runner's invalidate): the step is to do again, from the dataset the
  // decisions were recorded in, and the steps after it with it; the steps before it stay done.
  const c = await decided();
  const d = await runStep(runner.next(c.state), c.host);   // the one step, as the page runs it: the workflow is then between steps
  assert.deepEqual([d.state.status, step(d.state, 'locate').state, step(d.state, 'locate').outputs.dataset[0].name], ['idle', 'done', 'bay.krisis-dataset.located.json']);
  const back = runner.invalidate(d.state, 'locate');
  assert.deepEqual(back.steps.filter((s) => s.state !== 'skipped').map((s) => [s.id, s.state]).slice(5), [['apply', 'done'], ['locate', 'pending'], ['again', 'pending'], ['compare', 'pending'], ['see', 'pending'], ['out', 'pending']]);
  assert.equal(step(back, 'locate').outputs, undefined);
  assert.deepEqual(runner.inputsOf(runner.next(back), 'locate').dataset.map((r) => r.name), ['bay.krisis-dataset.json']);
});

test('asked to place the rest by hand: the map step takes the dataset with the locations, and the dataset saved there is the one seen and written out', async () => {
  const a = await decided({ answers: { ...ANSWERS, 'will-draw': true } });
  const b = await drive(a.state, a.host);
  assert.deepEqual([b.state.status, b.state.current], ['waiting', 'place']);
  const made = step(b.state, 'locate').outputs.dataset;
  assert.deepEqual(runner.inputsOf(b.state, 'place').dataset, made, 'not the dataset as it was before the locations');
  // A dataset saved on the map (here, the same file under the name its save gives) does the step; the rest follows it.
  const saved = new File([await a.host.store.get(made[0].name).text(), '\n'], 'bay.krisis-dataset.located.chora.json');
  a.host.store.set(saved.name, saved);
  const c = await drive(runner.complete(b.state, 'place', { dataset: await refsOf([saved], 'dataset') }), a.host);
  assert.equal(c.state.current, 'see');
  for (const [id, slot] of [['again', 'files'], ['compare', 'later'], ['see', 'dataset']]) assert.deepEqual(runner.inputsOf(c.state, id)[slot].map((r) => r.name), [saved.name], id);
});
