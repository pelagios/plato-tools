// Methodos's "Trace a historical map" (src/engine/methodos/recipes/trace-a-map.js): the interview's two
// routes to it, the base address it needs from the start, the plan each answer gives (the lookup under
// "will-identify", saying WHG's daily cap), its operation `trace` (interactive, Chora's, with the map's
// permissions), and a runner that starts it with no file and is done with the dataset Chora saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { openSqlite } from '../src/lib/store.js';
import { res, env as testEnv } from './engine.js';
import { HAVE, choose, questionsFor, answersFor, answered, plan, baseAsked, baseWhy } from '../src/engine/methodos/interview.js';
import { RECIPES, OPERATIONS, runner, checkRecipe, digest, drive, refsOf } from '../src/engine/methodos/index.js';
import { createLookup, memoryLedger, WHG_ENDPOINT } from '../src/engine/gazetteer/index.js';
import { readWork, serialiseWork } from '../src/engine/krisis/work.js';
import { acceptGuarded } from '../src/engine/krisis/guards.js';
import { detect } from '../src/engine/input.js';
import * as georef from '../src/engine/georef/index.js';
import * as trace from '../src/engine/chora/trace.js';
import { save } from '../src/engine/chora/save.js';
import { seedDataset, mintPlaceId, newPlaceRecord, featureAttestation, mapTimespan, TRACED_DEFAULTS } from '../src/engine/chora/seed.js';

const R = RECIPES['trace-a-map'];
const BASE = 'https://example.org/traced/';
const ref = (name) => ({ type: 'dataset', name, size: 10, sha256: 'b'.repeat(64) });

test('the recipe: well formed, begins from no file, its digest over every word; its first step is Chora\'s trace', () => {
  assert.equal(checkRecipe(R), R);
  assert.deepEqual(R.files, {});
  assert.equal(R.digest, digest({ ...R, digest: undefined }));
  assert.equal(R.steps[0].op, 'trace');
  assert.equal(R.asks.base.optional, false, 'the base address is needed from the start');
  assert.ok(HAVE.some((h) => h.key === 'map'));
});

test('the operation: interactive, done in Chora, declaring the map\'s server and Allmaps as its permissions, taking nothing, giving a dataset', () => {
  const op = OPERATIONS.trace;
  assert.equal(op.kind, 'interactive'); assert.equal(op.tool, 'Chora'); assert.equal(op.available, true);
  assert.deepEqual(op.permissions, [['iiif', '<site>'], ['allmaps', 'allmaps']]);
  assert.deepEqual(op.takes, {}); assert.deepEqual(op.gives, { dataset: 'dataset' });
  assert.match(op.waitsFor, /traced from the map in Chora, into a new dataset/);
});

test('the interview: a map, to a map or to publish, leads to it; the base address is needed, with why; the lookup is a question', () => {
  for (const [want, ask] of [['map', ['will-identify', 'will-publish']], ['publish', ['will-identify']]]) {
    const c = choose('map', want);
    assert.equal(c.kind, 'recipe'); assert.equal(c.recipe, 'trace-a-map');
    assert.deepEqual(questionsFor(c).map((q) => q.key), ask);
    const b = baseAsked(c, {});
    assert.equal(b.needed, true); assert.equal(b.why, 'Needed: every place you trace is given its address under it as you name it.');
    const yes = Object.fromEntries(ask.map((k) => [k, false]));
    assert.equal(answered(c, yes), false, 'not without the base address');
    assert.equal(answered(c, yes, { base: 'not an address' }), false);
    assert.equal(answered(c, yes, { base: BASE }), true);
    assert.equal(answersFor(c, yes, { base: BASE }).base, BASE);
  }
  // Map your data's regions keep their own words.
  assert.equal(baseWhy(baseAsked(choose('table', 'map'), { 'has-regions': true })), 'Needed: the regions are given addresses under it.');
  assert.equal(baseAsked(choose('table', 'map'), { 'has-regions': true }).why, undefined, "Map your data's answer is as it was");
});

test('the plan: the lookup, its review and the decisions only when identifying, saying WHG\'s daily cap of 5,000 requests per token; publishing adds Agora\'s steps', () => {
  const c = choose('map', 'map');
  const yes = plan('trace-a-map', answersFor(c, { 'will-identify': true, 'will-publish': false }, { base: BASE }));
  assert.deepEqual(yes.steps.map((s) => s.id), ['trace', 'check', 'lookup', 'review', 'apply', 'again', 'compare', 'out']);
  assert.equal(yes.before.length, 1);
  assert.match(yes.before[0], /daily cap is 5,000 requests per token/);
  assert.equal(yes.steps[0].tool, 'Chora'); assert.equal(yes.steps[0].kind, 'interactive');
  const no = plan('trace-a-map', answersFor(c, { 'will-identify': false, 'will-publish': true }, { base: BASE }));
  assert.deepEqual(no.steps.map((s) => s.id), ['trace', 'check', 'out', 'mint', 'report', 'site', 'w3id']);
  assert.deepEqual(no.before, [], 'no lookup, nothing said of its cap');
  assert.ok(no.left.some((s) => s.id === 'lookup'));
});

test('the runner: started with no file, the first step waits for Chora; done with the dataset saved there, the check takes that dataset', () => {
  const a = answersFor(choose('map', 'map'), { 'will-identify': false, 'will-publish': false }, { base: BASE });
  assert.throws(() => runner.start(R, { ...a, base: undefined }), /needs an answer to/);
  assert.throws(() => runner.start(R, a, { files: [{ ...ref('x.csv'), type: 'files' }] }), /does not take files called "files"/);
  let st = runner.start(R, a, {});
  assert.deepEqual(st.files, {});
  assert.deepEqual(st.steps.filter((s) => s.state === 'pending').map((s) => s.id), ['trace', 'check', 'out']);
  st = runner.next(st);
  assert.equal(st.status, 'waiting'); assert.equal(st.current, 'trace');
  assert.match(st.steps[0].why, /^Waiting for the places to be traced from the map in Chora/);
  st = runner.complete(st, 'trace', { dataset: [ref('traced-map.chora.json')] });
  assert.equal(st.steps[0].state, 'done');
  st = runner.next(st);
  assert.equal(st.current, 'check');
  assert.deepEqual(runner.inputsOf(st, 'check').files.map((r) => r.name), ['traced-map.chora.json']);
  // The written-out step takes it too, when nothing was looked up.
  assert.deepEqual(runner.inputsOf(st, 'out').files.map((r) => r.name), ['traced-map.chora.json']);
  // Identifying: the decisions recorded go on, compared with the dataset traced.
  const b = answersFor(choose('map', 'map'), { 'will-identify': true, 'will-publish': false }, { base: BASE });
  const s2 = runner.start(R, b, {});
  assert.deepEqual(s2.steps.find((s) => s.id === 'compare').from, { earlier: 'trace.dataset', later: 'apply.dataset' });
});

// ---- end to end in Node, identified and published ---------------------------------------------------------------
// A host in memory, and a fake WHG through the shared gazetteer module (nothing goes on the network), as
// methodos-tei-recogito.test.js has them; the dataset traced made as Chora's save makes it (save.js, newPlaces).
function memoryHost(initial) {
  const store = new Map(initial.map((f) => [f.name, f]));
  return {
    store,
    open: async (r) => store.get(r.name) || new File([], r.name),
    file: async (o) => store.get(o.name),
    env() {
      const made = [];
      const env = { resources: res, csvMeta: res.csvMeta, xlsx: XLSX, openDb: () => openSqlite(sqlite3InitModule, { memory: true }),
        output: async (name) => { const parts = []; return { write: (x) => parts.push(x), writeBytes: (b) => parts.push(b), close: async () => { const f = new File(parts, name); store.set(name, f); made.push(name); return { name, size: f.size }; } }; } };
      return { env, finish: (failed) => { if (failed) for (const n of made) store.delete(n); } };
    },
  };
}
function fakeWhg(near) {
  const bodies = [], urls = [];
  let n = 0;
  const fetch = async (url, init = {}) => {
    urls.push(String(url));
    if (init.method === 'GET') return new Response(JSON.stringify({ type: 'Feature', geometry: null }), { status: 200 });
    const body = JSON.parse(init.body); bodies.push(body);
    const out = { attribution: null };
    for (const [k, q] of Object.entries(body.queries)) out[k] = { result: [{ id: `place:gn:${9400000 + ++n}`, name: q.query, score: 100, match: true, description: 'Country: GB', ccodes: ['GB'], namespace: 'gn', alt_names: [], repr_point: near }] };
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { fetch, bodies, urls };
}
const fx = (f) => JSON.parse(readFileSync(f, 'utf8'));
async function tracedDataset(names, base) {
  const g = await georef.readGeoreference(fx('test/fixtures/chora-iiif/annotation.json'), { manifest: fx('test/fixtures/chora-iiif/manifest-rumsey-shaped.json') });
  const seed = new File([JSON.stringify(seedDataset({ mapTitle: g.title, base }))], 'traced-grid.json');
  const taken = new Set(), places = [];
  for (const [i, name] of names.entries()) {
    const geojson = { type: 'Point', coordinates: (await georef.toWorld(g, { type: 'Point', coordinates: [120 + 90 * i, 200] }, { space: 'image', precision: 7 })).geojson.coordinates };
    const t = await trace.traceFor(g, geojson, { key: 'grid', title: g.title });
    const id = mintPlaceId(base, name, taken); taken.add(id);
    const parts = trace.featureParts([{ trace: t, role: 'RepresentativePoint', geometry: geojson, zoom: 14 }], { sourceTimespan: mapTimespan('1746') });
    places.push(newPlaceRecord({ id, label: name, attestations: [featureAttestation({ geometries: [{ geojson, ...TRACED_DEFAULTS.point }], names: [{ toponym: name, language: 'en' }], timespan: mapTimespan('1746'), contributor: { name: 'Ada Tracer' }, created: '2026-10-14T09:00:00Z', ...parts })] }));
  }
  const e = testEnv();
  const r = await save(await detect([seed]), [], e, { reopen: (o) => new File(e.outs[o.name], o.name), newPlaces: places });
  assert.ok(r.mneme.passed, JSON.stringify(r.mneme.reasons));
  return { file: new File(e.outs[r.outputs[0].name], r.outputs[0].name), outline: await trace.sheetOutline(g) };
}

test('end to end in Node: traced, checked, looked up within the map\'s outline (WHG sent the names and the outline, nothing else), reviewed, recorded, checked again, compared, written out and published', async () => {
  const names = ['Mill Farm', 'Church Barn', 'Hall Green'];
  // Published, so under a w3id.org base address: Agora writes no w3id rules for a stand-in (example.org), and says so.
  const PUB = 'https://w3id.org/plato-tools-test/';
  const { file, outline } = await tracedDataset(names, PUB);
  const host = memoryHost([file]);
  const fake = fakeWhg([0.12, 52.21]);
  host.lookup = createLookup({ endpoint: WHG_ENDPOINT, token: 'test-token', fetch: fake.fetch, sleep: () => Promise.resolve(), queryRate: null, entityRate: null,
    get shared() { return false; }, get locks() { return null; }, get ledger() { return memoryLedger(); } });
  const a = answersFor(choose('map', 'map'), { 'will-identify': true, 'will-publish': true }, { base: PUB });
  // The map's outline as the workflow's Scope, as Chora sets it (outlineScope, through the page's setScope).
  let st = { ...runner.start(R, { ...a, release: 'v1' }, {}), scope: { where: { mode: 'area', area: outline.area } } };
  st = runner.next(st);
  assert.equal(st.current, 'trace');
  st = runner.complete(st, 'trace', { dataset: await refsOf([file], 'dataset') });
  let d = await drive(st, host);
  assert.equal(d.state.status, 'waiting', JSON.stringify(d.state.steps.map((x) => [x.id, x.state, x.problem || x.error])));
  assert.equal(d.state.current, 'review');
  assert.equal(d.reports.check.errors, 0, 'the dataset traced passes the check');
  // What WHG was sent: each name with the outline as its bounds, and nothing else of the map or the dataset.
  const qs = fake.bodies.flatMap((b) => Object.values(b.queries));
  assert.deepEqual(qs.map((q) => q.query).sort(), [...names].sort());
  for (const q of qs) {
    assert.deepEqual(q.bounds, outline.area, 'the outline, as the Scope gave it');
    for (const k of Object.keys(q)) assert.ok(['query', 'type', 'limit', 'bounds', 'lang'].includes(k), `sent ${k}`);
  }
  const text = JSON.stringify(fake.bodies);
  for (const w of [PUB, 'A synthetic grid', 'Ada Tracer', 'annotations.allmaps.org', 'iiif.example.org']) assert.ok(!text.includes(w), `sent ${w}`);
  // The control: with no Scope, no bounds are sent.
  const fake2 = fakeWhg([0.12, 52.21]);
  const host2 = memoryHost([file]);
  host2.lookup = createLookup({ endpoint: WHG_ENDPOINT, token: 't', fetch: fake2.fetch, sleep: () => Promise.resolve(), queryRate: null, entityRate: null, get shared() { return false; }, get locks() { return null; }, get ledger() { return memoryLedger(); } });
  let s2 = runner.complete(runner.next(runner.start(R, { ...a, release: 'v1' }, {})), 'trace', { dataset: await refsOf([file], 'dataset') });
  await drive(s2, host2);
  assert.ok(fake2.bodies.length && Object.values(fake2.bodies[0].queries).every((q) => q.bounds === undefined));
  // The review: accepted in bulk, by a named reviewer.
  const ref = d.state.steps.find((x) => x.id === 'lookup').outputs.work[0];
  const work = readWork(await host.store.get(ref.name).text());
  const bulk = acceptGuarded(work, { reviewer: { name: 'A. Reviewer' }, at: '2026-10-14T10:00:00Z' });
  assert.equal(bulk.accepted, 3);
  const f = new File([serialiseWork(work)], ref.name.replace(/\.krisis\.json$/, '.reviewed.krisis.json'));
  host.store.set(f.name, f);
  st = runner.complete(d.state, 'review', { work: await refsOf([f], 'work.krisis') });
  d = await drive(st, host);
  // Every step done but the w3id rules, which stop, saying why: the dataset made from the map is a draft until its
  // maker says it is published, and the rules make its addresses public for good (as for every workflow that publishes).
  assert.deepEqual(d.state.steps.map((x) => [x.id, x.state]), [['trace', 'done'], ['check', 'done'], ['lookup', 'done'], ['review', 'done'], ['apply', 'done'], ['again', 'done'],
    ['compare', 'done'], ['out', 'done'], ['mint', 'done'], ['report', 'done'], ['site', 'done'], ['w3id', 'stopped']], JSON.stringify(d.state.steps.map((x) => [x.id, x.state, x.problem || x.error])));
  assert.match(d.state.steps.at(-1).problem.words, /status is not 'published'/);
  assert.equal(d.reports.compare.errors, 0, 'only added to: the dataset traced is all still there');
  const out = JSON.parse(await host.store.get(d.state.steps.find((x) => x.id === 'out').outputs.dataset[0].name).text());
  const ids = out.spatialEntities.flatMap((e) => e.attestations.flatMap((x) => x.identities || []));
  assert.equal(ids.length, 3);
  assert.deepEqual(out.spatialEntities.map((e) => e['@id']), names.map((n) => mintPlaceId(PUB, n)), 'each place keeps the address it was given as it was named');
  // The dataset minted (PLATO JSON, or JSON Lines: its header, then a place a line).
  const text2 = await host.store.get(d.state.steps.find((x) => x.id === 'mint').outputs.dataset[0].name).text();
  const lines = text2.trim().split('\n');
  const mintedPlaces = lines.length > 1 ? lines.slice(1).map((l) => JSON.parse(l)).filter((x) => x.label) : JSON.parse(text2).spatialEntities;
  assert.equal(mintedPlaces.length, 3);
  assert.ok(mintedPlaces.every((e) => e['@id'].startsWith(PUB + 'place/')), 'published under the base address');

  assert.ok(fake.urls.every((u) => u.startsWith(new URL(WHG_ENDPOINT).origin + '/')));
});
