// Methodos: Map your data with regions, in Node (src/engine/methodos/adapters.js REVIEWS['lookup.levels'],
// ADAPTERS['relate.containment'] and the lookup within regions; containment.js). A ten-row table with
// county and parish columns is walked through the recipe with the engine's real calls: its columns
// matched, checked, converted under a base address (Hermes mints the regions and writes each place
// ContainedIn its parish), the regions reviewed level by level (a reviewer stands in for the person),
// the places looked up within them and decided, the decisions recorded as PLATO #23, option B asks,
// checked again, compared, and written out. A fake fetch stands in for WHG, through the shared gazetteer
// module, so nothing goes on the network.
//
// Every refusal is paired with the same thing done rightly passing, and the check of the end result is
// shown failing on a mutation (a convert that does not write ContainedIn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { openSqlite } from '../src/lib/store.js';
import { res } from './engine.js';
import { createLookup, memoryLedger, WHG_ENDPOINT } from '../src/engine/gazetteer/index.js';
import { readWork, serialiseWork, decide } from '../src/engine/krisis/work.js';
import { decideRegion, settleRegion, regionNodes } from '../src/engine/krisis/regions.js';
import { CONTAINED_IN } from '../src/engine/hermes/within.js';
import { RECIPES, ADAPTERS, runner, drive, review, refsOf, regionsSettled, notReviewed, relateProblem, datasetAddress, containment } from '../src/engine/methodos/index.js';

const MAP = RECIPES['map-your-data'];
const BASE = 'https://example.org/parishes/';
const W3ID = 'https://w3id.org/whg/id/';
const AT = '2026-10-04T10:00:00Z';
const CSV = readFileSync(new URL('./fixtures/methodos/parishes.csv', import.meta.url), 'utf8');
const MAPPING = { id: 'id', name: 'name', parish: { field: 'within', level: 2 }, county: { field: 'within', level: 1 } };
const ANSWERS = { 'has-regions': true, 'will-draw': false, 'will-publish': false, target: 'plato-json', base: BASE };

// ---- a host in memory, as methodos.test.js has it -----------------------------------------------------
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

// ---- a fake WHG: every request is kept, with its address ---------------------------------------------
const C = (id, name, point) => ({ id, name, score: 100, match: true, description: 'Country: GB', ccodes: ['GB'], repr_point: point, namespace: id.split(':')[1], alt_names: [] });
const WHG = {
  Cheshire: [C('place:gn:2653941', 'Cheshire', [-2.5, 53.2])], Lancashire: [C('place:gn:2644974', 'Lancashire', [-2.6, 53.8])],
  Newton: [C('place:gn:2641434', 'Newton', [-2.4, 53.3])], Barton: [C('place:gn:2656167', 'Barton', [-2.3, 53.1])], Ashby: [C('place:gn:2657441', 'Ashby', [-2.7, 53.9])],
  'Mill Farm': [C('place:gn:9000001', 'Mill Farm', [-2.41, 53.31])], 'Moss Side': [C('place:gn:9000006', 'Moss Side', [-2.42, 53.32])],
};
function fakeWhg() {
  const urls = [], bodies = [];
  const fetch = async (url, init = {}) => {
    urls.push(String(url));
    if (init.method === 'GET') return new Response(JSON.stringify({ type: 'Feature', geometry: null }), { status: 200 });
    const body = JSON.parse(init.body);
    bodies.push(body);
    const out = { attribution: null };
    for (const [k, q] of Object.entries(body.queries)) out[k] = { result: WHG[q.query] ?? [], ...(Array.isArray(q.contained_in) ? { scope: { applied: true } } : {}) };
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { fetch, urls, bodies };
}
const PRIVATE = { get shared() { return false; }, get locks() { return null; }, get ledger() { return memoryLedger(); } };
const lookupWith = (fake) => createLookup({ endpoint: WHG_ENDPOINT, token: 'test-token', fetch: fake.fetch, sleep: () => Promise.resolve(), queryRate: null, entityRate: null, ...PRIVATE });

/** The reviewer: each region matched to its one candidate, but Barton, said to have none. */
const REVIEWER = async ({ work, nodes }) => {
  for (const n of nodes) {
    if (n.names[0] === 'Barton') { settleRegion(work, n.key, 'no-match'); continue; }
    const c = work.candidates.find((x) => x.candidate_source === n.key);
    decideRegion(work, c.id, 'match', { identityType: 'closeMatch', certainty: 'certain', at: AT });
  }
};

/** The workflow taken to the step it waits at after the dataset is made: the columns given, then driven. */
async function begun({ host, adapters } = {}) {
  const table = new File([CSV], 'parishes.csv');
  host = host || memoryHost([table]);
  const mapping = new File([JSON.stringify(MAPPING)], 'columns.json');
  host.store.set('columns.json', mapping);
  let s = runner.start(MAP, ANSWERS, { files: await refsOf([table], 'files') });
  s = runner.next(s);
  assert.equal(s.current, 'columns');
  s = runner.complete(s, 'columns', { mapping: await refsOf([mapping], 'mapping') });
  const d = await drive(s, host, adapters ? { adapters } : {});
  return { host, ...d };
}

/** A place's candidates decided: those with a candidate matched (closeMatch), on the work file the lookup step made. */
async function decided(host, state) {
  const ref = state.steps.find((x) => x.id === 'lookup').outputs.work[0];
  const work = readWork(await host.store.get(ref.name).text());
  work.reviewer = { name: 'A. Reviewer' };   // as the page's reviewer field gives it
  let n = 0;
  for (const [iri, p] of Object.entries(work.places)) {
    if (!p.within) continue;
    const c = work.candidates.find((x) => x.candidate_source === iri && x.lookup);
    if (c) { decide(work, c.id, 'match', { identityType: 'closeMatch', at: AT }); n++; }
  }
  const f = new File([serialiseWork(work)], 'parishes.reviewed.krisis.json');
  host.store.set(f.name, f);
  return { refs: await refsOf([f], 'work.krisis'), n };
}

/** What the end of Map your data must hold: every place ContainedIn its parish, every matched region's and place's identity citing the stub, promotedFrom a candidate. */
function ends(doc) {
  const ents = doc.spatialEntities || [];
  const regions = new Set(ents.filter((e) => /\/place\/region-/.test(e['@id'])).map((e) => e['@id']));
  const places = ents.filter((e) => !regions.has(e['@id']));
  // What an identity cites: its attestation's sources, or its citations' sources (a place's answer cites the gazetteer so).
  const ids = ents.flatMap((e) => (e.attestations || []).flatMap((a) => (a.identities || []).map((i) => ({ ...i, sources: [...(a.sources || []), ...(a.citations || []).map((c) => c.source || {})] }))));
  return {
    places: places.length, regions: regions.size,
    contained: places.filter((e) => (e.attestations || []).some((a) => (a.relations || []).some((r) => r.relationType === CONTAINED_IN && regions.has(r.relatesTo)))).length,
    regionIdentities: ids.filter((i) => regions.has(i.subject)).length,
    stub: ids.length > 0 && ids.every((i) => i.object.startsWith(W3ID) && i.sources.some((s) => s.title === 'World Historical Gazetteer')),
    promoted: ids.length > 0 && ids.every((i) => typeof i.promotedFrom === 'string' && i.promotedFrom.startsWith(BASE + 'candidates/')),
    sets: doc.gazetteer?.candidateSets || [],
  };
}

test('Map your data with regions, end to end in Node: the regions level by level, the places within them, and the decisions recorded as PLATO #23, option B asks', async () => {
  const fake = fakeWhg();
  const host = memoryHost([new File([CSV], 'parishes.csv')]);
  host.lookup = lookupWith(fake);
  const a = await begun({ host });
  // Checked, converted under the base address, then at the region review, which waits for the reviewer.
  assert.equal(a.state.status, 'waiting');
  assert.equal(a.state.current, 'regions');
  assert.match(a.state.steps.find((x) => x.id === 'regions').why, /level by level, the widest first/);
  const converted = JSON.parse(await host.store.get(a.state.steps.find((x) => x.id === 'dataset').outputs.dataset[0].name).text());
  assert.equal(ends(converted).contained, 10, 'Hermes wrote each of the ten places ContainedIn its parish');
  assert.equal(ends(converted).regions, 6);
  // The hand-off: Krisis's regions are keyed by the addresses Hermes minted (its containerKey read back), each parish within its county.
  const r = await review(a.state, host, { reviewer: REVIEWER });
  const work = readWork(await host.store.get(r.state.steps.find((x) => x.id === 'regions').outputs.work[0].name).text());
  const minted = new Set(converted.spatialEntities.filter((e) => e.entityIdentifier?.startsWith('[')).map((e) => e['@id']));
  assert.deepEqual(new Set(Object.keys(work.regions)), minted);
  for (const [k, reg] of Object.entries(work.regions)) {
    const e = converted.spatialEntities.find((x) => x['@id'] === k);
    assert.equal(reg.container, e.entityIdentifier, 'the region\'s container is Hermes\'s containerKey');
    const parent = (e.attestations || []).flatMap((x) => x.relations || []).find((x) => x.relationType === CONTAINED_IN)?.relatesTo ?? null;
    assert.equal(reg.within, parent, `${reg.label} is within the region Hermes wrote it ContainedIn`);
  }
  assert.deepEqual(regionNodes(work).map((n) => [n.label, n.state]), [['Cheshire', 'settled'], ['Lancashire', 'settled'], ['Ashby (Lancashire)', 'settled'], ['Barton (Cheshire)', 'settled'], ['Newton (Cheshire)', 'settled'], ['Newton (Lancashire)', 'settled']]);
  assert.equal(regionsSettled(work).settled, 6);
  // Level 1 was sent with no constraint (the control), level 2 within the county's match.
  const [l1, l2] = fake.bodies.map((b) => Object.values(b.queries));
  assert.ok(l1.every((q) => q.contained_in === undefined) && l1.length === 2);
  assert.equal(l2.length, 4);
  const sent = (name) => l2.filter((q) => q.query === name).map((q) => q.contained_in).sort();
  assert.deepEqual([sent('Barton'), sent('Ashby'), sent('Newton')], [[['gn:2653941']], [['gn:2644974']], [['gn:2644974'], ['gn:2653941']]]);
  // The places within their regions (the lookup step, automatic), each constrained by its nearest matched region.
  const b = await drive(r.state, host);
  assert.equal(b.state.current, 'review');
  const l3 = Object.values(fake.bodies.at(-1).queries);
  assert.equal(l3.length, 10);
  const within = Object.fromEntries(l3.map((q) => [q.query, q.contained_in]));
  assert.deepEqual(within['Mill Farm'], ['gn:2641434'], 'a place in a matched parish is sought within the parish');
  assert.deepEqual(within['Kirk House'], ['gn:2653941'], 'a place in Barton (no match) is sought within Cheshire, the nearest matched region');
  // The places decided, then recorded with the region each is in.
  const { refs, n } = await decided(host, b.state);
  assert.equal(n, 2);
  let s = runner.complete(b.state, 'review', { work: refs });
  const c = await drive(s, host);
  assert.equal(c.state.status, 'completed', JSON.stringify(c.state.steps.filter((x) => x.problem || x.error).map((x) => [x.id, x.problem || x.error])));
  const relate = c.reports.relate.counts.containment;
  assert.deepEqual({ containedIn: relate.containedIn, regions: relate.regions, identities: relate.identities, promoted: relate.promoted, missing: relate.missing }, { containedIn: 10, regions: 6, identities: 5, promoted: 5, missing: [] });
  // The end: written out as PLATO JSON; every identity cites the stub and names its candidate; the candidate set is beside it.
  const out = JSON.parse(await host.store.get(c.state.steps.find((x) => x.id === 'out').outputs.dataset[0].name).text());
  const e = ends(out);
  assert.deepEqual({ places: e.places, regions: e.regions, contained: e.contained, regionIdentities: e.regionIdentities, stub: e.stub, promoted: e.promoted },
    { places: 10, regions: 6, contained: 10, regionIdentities: 5, stub: true, promoted: true });
  assert.equal(e.sets.length, 1);
  const set = JSON.parse(await host.store.get('parishes.candidates.json').text());
  assert.equal(set.candidateSet['@id'], e.sets[0]['@id'] ?? e.sets[0]);
  assert.equal(set.candidateSet.candidatesFor, BASE);
  // The checks after: clean.
  assert.equal(c.reports.again.errors, 0);
  // Every request went to WHG's address alone (the presence: the region and place lookups were made).
  assert.ok(fake.urls.length >= 3);
  assert.ok(fake.urls.every((u) => u.startsWith(new URL(WHG_ENDPOINT).origin + '/')), fake.urls.join(' '));
});

test('the check of the end fails on a mutation: a convert that skips writing ContainedIn leaves no regions to review, and a dataset without it fails ends()', async () => {
  const host = memoryHost([new File([CSV], 'parishes.csv')]);
  host.lookup = lookupWith(fakeWhg());
  const strip = (d) => ({ ...d, spatialEntities: d.spatialEntities.map((e) => ({ ...e, attestations: (e.attestations || []).filter((x) => !(x.relations || []).some((r) => r.relationType === CONTAINED_IN)) })) });
  // The mutation: the convert step's dataset written without ContainedIn (as a convert that skipped it would write it).
  const convert = async (args) => {
    const r = await ADAPTERS.convert(args);
    if (r.problem) return r;
    const [ref] = r.outputs.dataset;
    const f = new File([JSON.stringify(strip(JSON.parse(await host.store.get(ref.name).text())))], ref.name);
    host.store.set(ref.name, f);
    return { ...r, outputs: { dataset: await refsOf([f], 'dataset') } };
  };
  const a = await begun({ host, adapters: { ...ADAPTERS, convert } });
  assert.equal(a.state.current, 'regions');
  await assert.rejects(review(a.state, host, { reviewer: REVIEWER }), /gives no regions its places lie in/);
  const mutated = strip(JSON.parse(await host.store.get(a.state.steps.find((x) => x.id === 'dataset').outputs.dataset[0].name).text()));
  assert.equal(ends(mutated).contained, 0);
  assert.ok(containment(mutated, { regions: Object.fromEntries([...new Set(mutated.spatialEntities.filter((x) => /region-/.test(x['@id'])).map((x) => x['@id']))].map((k) => [k, { outcome: null }])) }).containedIn === 0);
  // The control: unmutated, the same review reaches the places.
  const ok = await begun({ host: Object.assign(memoryHost([new File([CSV], 'parishes.csv')]), { lookup: lookupWith(fakeWhg()) }) });
  assert.equal((await review(ok.state, ok.host, { reviewer: REVIEWER })).state.status, 'idle');
});

test('the region step stops, keeping its work, while a level has a region open; the level below is not looked up', async () => {
  const fake = fakeWhg();
  const host = memoryHost([new File([CSV], 'parishes.csv')]);
  host.lookup = lookupWith(fake);
  const a = await begun({ host });
  const lazy = async ({ work, nodes }) => { const n = nodes.find((x) => x.names[0] === 'Cheshire'); decideRegion(work, work.candidates.find((x) => x.candidate_source === n.key).id, 'match', { at: AT }); };
  const e = await review(a.state, host, { reviewer: lazy }).then(() => null, (x) => x);
  assert.match(e?.message || '', /1 region of level 1 is not settled \(Lancashire\)/);
  assert.ok(e.partial.work[0].name.endsWith('.krisis.json'));
  assert.equal(fake.bodies.length, 1, 'only level 1 was asked');
  // The control: settled, the level below is asked.
  const host2 = memoryHost([new File([CSV], 'parishes.csv')]); const f2 = fakeWhg(); host2.lookup = lookupWith(f2);
  await review((await begun({ host: host2 })).state, host2, { reviewer: REVIEWER });
  assert.equal(f2.bodies.length, 2);
  // No reviewer is refused; so is a step that does not wait for one.
  await assert.rejects(review(a.state, host, {}), /no reviewer was given/);
  await assert.rejects(review(runner.start(MAP, ANSWERS, { files: a.state.files.files }), host, { reviewer: REVIEWER }), /No step is waiting/);
});

test('recording the regions is refused in words where it could not be done as PLATO #23 asks, and allowed where it can', () => {
  const region = (k, more = {}) => [k, { label: 'R', names: ['R'], level: 1, container: '[1,"R"]', within: null, count: 1, outcome: 'matched', ...more }];
  const cand = (more = {}) => ({ id: 'c1', candidate_source: BASE + 'place/region-1', candidate_candidate: W3ID + 'place:gn:1', decision: { kind: 'match' }, ...more });
  assert.match(relateProblem({ regions: {}, candidates: [] }), /no regions/);
  assert.match(relateProblem({ regions: Object.fromEntries([region('[1,"R"]')]), candidates: [] }), /1 of the 1 regions have no web address of their own .* base address/);
  const w = { regions: Object.fromEntries([region(BASE + 'place/region-1')]), candidates: [cand()] };
  assert.match(relateProblem(w), /1 decision does not name the candidate it answers yet: export the suggestions first/);
  assert.equal(relateProblem(w, { exported: false }), null);
  assert.equal(relateProblem({ ...w, candidates: [cand({ iri: BASE + 'candidates/2026-10-04-abcd#c-1234abcd' })] }), null);
  assert.equal(datasetAddress('https://example.org/x'), 'https://example.org/x/');
  assert.equal(datasetAddress('not an address'), null);
  // A review is the step's only if it was made of the step's file (by SHA-256).
  const work = { subjects: { files: [{ name: 'd.json', size: 1, sha256: 'a'.repeat(64) }] } };
  assert.deepEqual(notReviewed(work, [{ name: 'd.json', sha256: 'a'.repeat(64) }]), []);
  assert.deepEqual(notReviewed(work, [{ name: 'e.json', sha256: 'b'.repeat(64) }]), ['e.json']);
  // A review with regions open is not done; with none at all, neither.
  assert.throws(() => regionsSettled({ regions: {}, candidates: [], lookups: [] }), /no regions to identify/);
  assert.throws(() => regionsSettled({ regions: Object.fromEntries([region(BASE + 'r', { outcome: null })]), candidates: [], lookups: [] }), /1 of the 1 regions are not settled yet \(level 1: 1 of 1\)/);
  assert.equal(regionsSettled({ regions: Object.fromEntries([region(BASE + 'r', { outcome: 'no-match' })]), candidates: [], lookups: [] }).settled, 1);
});
