// Methodos's "Make an open map" (src/engine/methodos/recipes/make-an-open-map.js; #37): the interview's new want
// ("A map image for Wikipedia or Commons") and its two routes, the plan each gives, its operation `map.export`
// (interactive, Chora's, giving a hand-off of its own type, `map`), and a walk in Node from pasted names: read as a
// one-column table, its columns matched, checked, made a dataset, looked up in a fake WHG (nothing goes on the
// network), reviewed, recorded, checked again, and done with a map made by the export's engine from the result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { openSqlite } from '../src/lib/store.js';
import { res } from './engine.js';
import { WANT, choose, questionsFor, answersFor, answered, plan, baseAsked } from '../src/engine/methodos/interview.js';
import { RECIPES, OPERATIONS, runner, checkRecipe, digest, drive, refsOf } from '../src/engine/methodos/index.js';
import { TYPES } from '../src/engine/methodos/handoffs.js';
import { createLookup, memoryLedger, WHG_ENDPOINT } from '../src/engine/gazetteer/index.js';
import { readWork, serialiseWork } from '../src/engine/krisis/work.js';
import { acceptGuarded } from '../src/engine/krisis/guards.js';
import { pastedListFile } from '../src/engine/hermes/pasted.js';
import { exportPlace } from '../src/engine/chora/export/places.js';
import { composeMap } from '../src/engine/chora/export/compose.js';
import { estimate } from '../src/engine/chora/export/labels.js';
import { settingsIn } from '../src/engine/chora/export/svg.js';

const R = RECIPES['make-an-open-map'];

const LISTED_BASE = 'https://example.org/listed/';
test('the recipe: well formed, its digest over every word; identified as Map your data identifies, then the map made in Chora; nothing published', () => {
  assert.equal(checkRecipe(R), R);
  assert.equal(R.digest, digest({ ...R, digest: undefined }));
  assert.equal(R.steps.at(-1).op, 'map.export');
  assert.equal(R.asks.base.question, RECIPES['map-your-data'].asks.base.question, 'the one shared question');
  assert.equal(R.steps.find((s) => s.id === 'dataset').options.base, '$base');
  assert.ok(!R.steps.some((s) => s.op.startsWith('publish.') || s.op === 'trace'), 'no tracing, nothing published');
  assert.equal(TYPES.map, 'a map made in Chora, as an SVG or a PNG, its settings kept in it');
  const op = OPERATIONS['map.export'];
  assert.equal(op.kind, 'interactive'); assert.equal(op.tool, 'Chora'); assert.equal(op.available, true);
  assert.deepEqual(op.takes, { dataset: { types: ['files', 'dataset'] } }); assert.deepEqual(op.gives, { map: 'map' });
  assert.deepEqual(op.permissions, [], 'on Natural Earth nothing is asked of another site; a background on another site asks in Chora, as ever');
  assert.match(op.waitsFor, /made in Chora \("Make a map"\) and downloaded there/);
});

test('the interview: "A map image for Wikipedia or Commons", from a list or a table (the base address needed, with why), or a PLATO dataset (not asked); no yes-or-no question', () => {
  assert.ok(WANT.some((w) => w.key === 'commons' && w.words === 'A map image for Wikipedia or Commons'));
  for (const [have, fromTable] of [['table', true], ['plato', false]]) {
    const c = choose(have, 'commons');
    assert.equal(c.kind, 'recipe'); assert.equal(c.recipe, 'make-an-open-map');
    assert.deepEqual(c.set, { 'from-table': fromTable });
    assert.deepEqual(questionsFor(c), []);
  }
  const t = choose('table', 'commons'), p = choose('plato', 'commons');
  assert.deepEqual(baseAsked(t, {}), { needed: true, question: R.asks.base.question,
    why: 'Needed: each place of your list is given its address under it, against which what the gazetteer matches it with is recorded.' });
  assert.equal(answered(t, {}), false, 'not without the base address');
  assert.equal(answered(t, {}, { base: LISTED_BASE }), true);
  assert.equal(answersFor(t, {}, { base: LISTED_BASE }).base, LISTED_BASE);
  assert.equal(baseAsked(p, {}), null, "a PLATO dataset's places have their addresses");
  assert.equal(answered(p, {}), true);
  // From anything else, no workflow: why, and the tools that do it meanwhile (Chora's "Make a map" among them).
  const tei = choose('tei', 'commons');
  assert.equal(tei.kind, 'none'); assert.match(tei.why, /Make an open map starts from a list of place names/); assert.deepEqual(tei.tools, ['read', 'chora']);
});

test('the plan: from a table, its columns, check and dataset; from a PLATO dataset, its check; then the lookup (WHG\'s cap said), the review, the decisions, the places located in Chora every time, the check again, and the map', () => {
  const t = plan('make-an-open-map', answersFor(choose('table', 'commons'), {}, { base: LISTED_BASE }));
  assert.deepEqual(t.steps.map((s) => s.id), ['columns', 'check', 'dataset', 'lookup', 'review', 'apply', 'place', 'again', 'map']);
  assert.match(t.before[0], /cap is 5,000 requests a day per token/);
  assert.equal(t.steps.at(-1).tool, 'Chora'); assert.equal(t.steps.at(-1).kind, 'interactive');
  assert.equal(t.cannot.length, 3); assert.match(t.cannot[0], /at most 200/); assert.match(t.cannot[1], /cannot go to Wikimedia Commons/);
  const p = plan('make-an-open-map', answersFor(choose('plato', 'commons'), {}));
  assert.deepEqual(p.steps.map((s) => s.id), ['check-a', 'lookup', 'review', 'apply', 'place', 'again', 'map']);
  assert.deepEqual(p.left.map((s) => s.id), ['columns', 'check', 'dataset']);
});

// ---- end to end in Node, from pasted names -----------------------------------------------------------------
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
// A stand-in WHG: one candidate for each name, a Pleiades-like record located where the table puts nothing.
const SPOTS = { Athenae: [23.7267, 37.9715], Eleusis: [23.5417, 38.0389], Piraeus: [23.6466, 37.9429] };
function fakeWhg() {
  const bodies = [], urls = [];
  let n = 0;
  const fetch = async (url, init = {}) => {
    urls.push(String(url));
    if (init.method === 'GET') return new Response(JSON.stringify({ type: 'Feature', geometry: null }), { status: 200 });
    const body = JSON.parse(init.body); bodies.push(body);
    const out = { attribution: null };
    for (const [k, q] of Object.entries(body.queries)) out[k] = { result: [{ id: `place:pl:${5800000 + ++n}`, name: q.query, score: 100, match: true, description: 'Country: GR', ccodes: ['GR'], namespace: 'pl', alt_names: [], repr_point: SPOTS[q.query] }] };
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { fetch, bodies, urls };
}

test('end to end in Node, from pasted names: read as a table, matched, checked, made a dataset, looked up (WHG sent the names alone), reviewed, recorded, checked again; the step "map" done with a map made of the result, of type map only', async () => {
  const names = ['Athenae', 'Eleusis', 'Piraeus'];
  const pasted = pastedListFile(names.join('\n'));
  const mapping = new File([JSON.stringify({ id: 'id', name: 'name' })], 'columns.json');
  const host = memoryHost([pasted, mapping]);
  const fake = fakeWhg();
  host.lookup = createLookup({ endpoint: WHG_ENDPOINT, token: 'test-token', fetch: fake.fetch, sleep: () => Promise.resolve(), queryRate: null, entityRate: null,
    get shared() { return false; }, get locks() { return null; }, get ledger() { return memoryLedger(); } });
  const a = answersFor(choose('table', 'commons'), {}, { base: LISTED_BASE });
  let st = runner.start(R, a, { files: await refsOf([pasted], 'files') });
  st = runner.next(st);
  assert.equal(st.current, 'columns');
  st = runner.complete(st, 'columns', { mapping: await refsOf([mapping], 'mapping') });
  let d = await drive(st, host);
  assert.equal(d.state.current, 'review', JSON.stringify(d.state.steps.map((x) => [x.id, x.state, x.problem?.words || x.error])));
  assert.equal(d.reports.check.errors, 0, 'the pasted names pass the check');
  // What WHG was sent: the names, and nothing of the file or the map.
  const qs = fake.bodies.flatMap((b) => Object.values(b.queries));
  assert.deepEqual(qs.map((q) => q.query).sort(), [...names].sort());
  for (const q of qs) for (const k of Object.keys(q)) assert.ok(['query', 'type', 'limit', 'bounds', 'lang'].includes(k), `sent ${k}`);
  assert.ok(!JSON.stringify(fake.bodies).includes('pasted-list') && !JSON.stringify(fake.bodies).includes(LISTED_BASE), 'neither the file nor the places\' addresses');
  // The review: accepted in bulk, by a named reviewer; recorded and checked again.
  const ref = d.state.steps.find((x) => x.id === 'lookup').outputs.work[0];
  const work = readWork(await host.store.get(ref.name).text());
  assert.equal(acceptGuarded(work, { reviewer: { name: 'A. Reviewer' }, at: '2026-10-15T10:00:00Z' }).accepted, 3);
  const reviewed = new File([serialiseWork(work)], ref.name.replace(/\.krisis\.json$/, '.reviewed.krisis.json'));
  host.store.set(reviewed.name, reviewed);
  st = runner.complete(d.state, 'review', { work: await refsOf([reviewed], 'work.krisis') });
  d = await drive(st, host);
  // Recorded, each place identified, and none located: the step that locates them waits for Chora.
  assert.equal(d.state.status, 'waiting'); assert.equal(d.state.current, 'place');
  const [recorded] = d.state.steps.find((x) => x.id === 'apply').outputs.dataset;
  const doc = JSON.parse(await host.store.get(recorded.name).text());
  assert.equal(doc.spatialEntities.length, 3);
  assert.ok(doc.spatialEntities.every((e) => e['@id'].startsWith(LISTED_BASE)), 'each place under the base address');
  assert.equal(doc.spatialEntities.flatMap((e) => e.attestations.flatMap((x) => x.identities || [])).length, 3, 'each identified');
  assert.equal(doc.spatialEntities.flatMap((e) => e.attestations.flatMap((x) => x.geometries || [])).length, 0, 'none located by recording the decisions');
  // Located in Chora (each match's location adopted, as an attestation citing the gazetteer): the dataset its save writes does the step.
  for (const e of doc.spatialEntities) e.attestations.push({ sources: [{ title: 'World Historical Gazetteer', licence: 'https://creativecommons.org/licenses/by/4.0/' }], geometries: [{ geojson: { type: 'Point', coordinates: SPOTS[e.label] } }] });
  const located = new File([JSON.stringify(doc)], 'pasted-list.located.json');
  host.store.set(located.name, located);
  st = runner.complete(d.state, 'place', { dataset: await refsOf([located], 'dataset') });
  d = await drive(st, host);
  assert.equal(d.state.status, 'waiting'); assert.equal(d.state.current, 'map');
  assert.match(d.state.steps.find((x) => x.id === 'map').why, /^Waiting for the map to be made in Chora/);
  // The map step takes the dataset the places were located in.
  const [dsRef] = runner.inputsOf(d.state, 'map').dataset;
  assert.equal(dsRef.name, 'pasted-list.located.json');
  // The map, made by the export's engine from the dataset's places, as Chora makes it: an SVG with its settings kept.
  const places = doc.spatialEntities.map((rec) => exportPlace(rec, { id: rec['@id'] })).map((p) => ({ ...p, text: p.label }));
  assert.ok(places.every((p) => p.geometries.length === 1 && p.point), 'each located');
  const out = composeMap({ view: { center: [23.65, 37.98], zoom: 9, width: 900, height: 600 }, width: 900, projection: 'mercator', background: { kind: 'none' }, places,
    furniture: { attribution: ['Map: A. Reviewer, CC BY 4.0, made with PLATO tools'] }, settings: { version: 1, made: 'in a test' }, measure: estimate });
  assert.deepEqual(out.labels.map((l) => l.lines[0].text).sort(), [...names].sort());
  const svg = new File([out.svg], 'Places.svg', { type: 'image/svg+xml' });
  host.store.set(svg.name, svg);
  // A dataset handed to it is refused, in words, before anything is done; the map, of its own type, does it.
  assert.throws(() => runner.complete(d.state, 'map', { map: [{ ...dsRef }] }), /takes a map made in Chora/);
  st = runner.complete(d.state, 'map', { map: await refsOf([svg], 'map') });
  st = runner.next(st);
  assert.equal(st.status, 'completed', JSON.stringify(st.steps.map((x) => [x.id, x.state])));
  assert.deepEqual(st.steps.find((x) => x.id === 'map').outputs.map.map((r) => [r.type, r.name]), [['map', 'Places.svg']]);
  assert.deepEqual(settingsIn(await host.store.get('Places.svg').text()), { version: 1, made: 'in a test' });
  assert.ok(fake.urls.length && fake.urls.every((u) => u.startsWith(new URL(WHG_ENDPOINT).origin + '/')));
});
