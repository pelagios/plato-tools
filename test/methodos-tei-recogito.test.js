// Methodos: "Places from an edition (TEI)" and "Places from Recogito" (src/engine/methodos/recipes/
// places-from-tei.js, places-from-recogito.js, downstream.js): their plans, their steps, the interview's
// routing to them, and each walked end to end in Node with the engine's real calls, from the fixture to
// the dataset written out, against a fake WHG through the shared gazetteer module (nothing goes on the
// network). A reviewer stands in for the person at the review.
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
import { createLookup, memoryLedger, WHG_ENDPOINT } from '../src/engine/gazetteer/index.js';
import { readWork, serialiseWork, decide } from '../src/engine/krisis/work.js';
import { HAVE, WANT, choose, questionsFor, answersFor, answered, baseAsked, plan } from '../src/engine/methodos/interview.js';
import { RECIPES, OPERATIONS, ADAPTERS, runner, drive, refsOf, checkRecipe, writesItself } from '../src/engine/methodos/index.js';

const TEI = RECIPES['places-from-tei'], REC = RECIPES['places-from-recogito'], MAP = RECIPES['map-your-data'];
const W3ID = 'https://w3id.org/whg/id/';
const AT = '2026-10-12T10:00:00Z';
const fixture = (path) => new File([readFileSync(new URL(`./fixtures/${path}`, import.meta.url))], path.split('/').pop());
const EDITION = () => fixture('tei/prose-constructed.xml');
const RECOGITO = () => [fixture('annotations/recogito-studio-regions-constructed.json'), fixture('georef/bpl-rocque-annotation.json'), fixture('georef/bpl-rocque-manifest.json')];
const NO_ANSWERS = { 'will-draw': false, 'will-publish': false, target: 'plato-json' };

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

// ---- a fake WHG: every request kept; each name answered from `answers`, else with one record of its own --
const C = (id, name) => ({ id, name, score: 100, match: true, description: 'Country: GR', ccodes: ['GR'], namespace: id.split(':')[1], alt_names: [] });
function fakeWhg(answers = {}) {
  const urls = [], bodies = [];
  let n = 0;
  const fetch = async (url, init = {}) => {
    urls.push(String(url));
    if (init.method === 'GET') return new Response(JSON.stringify({ type: 'Feature', geometry: null }), { status: 200 });
    const body = JSON.parse(init.body);
    bodies.push(body);
    const out = { attribution: null };
    for (const [k, q] of Object.entries(body.queries)) out[k] = { result: answers[q.query] ?? [C(`place:gn:${9100000 + ++n}`, q.query)] };
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { fetch, urls, bodies, sent: () => bodies.flatMap((b) => Object.values(b.queries).map((q) => q.query)) };
}
const PRIVATE = { get shared() { return false; }, get locks() { return null; }, get ledger() { return memoryLedger(); } };
const lookupWith = (fake) => createLookup({ endpoint: WHG_ENDPOINT, token: 'test-token', fetch: fake.fetch, sleep: () => Promise.resolve(), queryRate: null, entityRate: null, ...PRIVATE });

/** The workflow begun with `files` and driven to the step it waits at (the review). */
async function begun(recipe, files, fake, { adapters } = {}) {
  const host = memoryHost(files);
  host.lookup = lookupWith(fake);
  const s = runner.start(recipe, NO_ANSWERS, { files: await refsOf(files, 'files') });
  return { host, ...(await drive(s, host, adapters ? { adapters } : {})) };
}
/** The review: every candidate the lookup suggested accepted (closeMatch) by a named reviewer; the work file as the step's result. */
async function reviewed(host, state) {
  const ref = state.steps.find((x) => x.id === 'lookup').outputs.work[0];
  const work = readWork(await host.store.get(ref.name).text());
  work.reviewer = { name: 'A. Reviewer' };
  const accepted = work.candidates.filter((c) => c.lookup);
  for (const c of accepted) decide(work, c.id, 'match', { identityType: 'closeMatch', at: AT });
  const f = new File([serialiseWork(work)], ref.name.replace(/\.krisis\.json$/, '.reviewed.krisis.json'));
  host.store.set(f.name, f);
  return { work, accepted: accepted.length, state: runner.complete(state, 'review', { work: await refsOf([f], 'work.krisis') }) };
}
const outOf = async (host, state) => JSON.parse(await host.store.get(state.steps.find((x) => x.id === 'out').outputs.dataset[0].name).text());

/** What the end must hold, read from the PLATO JSON written: the places, their own addresses, the identities to the stub citing WHG, the geometries. */
function ends(doc) {
  const ents = doc.spatialEntities || [];
  const ids = ents.flatMap((e) => (e.attestations || []).flatMap((a) => (a.identities || []).map((i) => ({ ...i, sources: [...(a.sources || []), ...(a.citations || []).map((c) => c.source || {})] }))));
  const toStub = ids.filter((i) => i.object.startsWith(W3ID));
  return {
    places: ents.length, addresses: ents.map((e) => e['@id']).sort(),
    stub: toStub.length, citesWhg: toStub.length > 0 && toStub.every((i) => i.sources.some((s) => s.title === 'World Historical Gazetteer')),
    others: ids.filter((i) => !i.object.startsWith(W3ID)).map((i) => [i.subject, i.object]),
    placed: ents.filter((e) => (e.attestations || []).some((a) => (a.geometries || []).length)).length,
  };
}

// ---- the plans, the steps, the interview -------------------------------------------------------------
test('both recipes are well formed, take Map your data\'s questions in its words (not its regions), and follow its steps after the dataset through the same operations', () => {
  for (const r of [TEI, REC]) {
    assert.equal(checkRecipe(r), r);
    for (const k of ['will-draw', 'will-publish', 'target', 'release', 'repo', 'maintainers']) assert.deepEqual(r.asks[k], MAP.asks[k], `${r.key}: ${k}`);
    assert.equal(r.asks['has-regions'], undefined, 'no regions: an edition and an export do not say which region a place is in');
    assert.deepEqual(r.asks.base, RECIPES['publish-a-dataset'].asks.base);
    // The steps: read and made a dataset, then Map your data's own, without regions, by operation and id.
    assert.deepEqual(r.steps.map((s) => s.op), ['check', 'convert', 'lookup', 'review', 'apply', 'place', 'check', 'compare', 'convert', 'publish.mint', 'publish.report', 'publish.site', 'publish.w3id']);
    const mine = r.steps.slice(2).map((s) => [s.id, s.op, s.when ?? null]);
    const map = MAP.steps.filter((s) => !['columns', 'check', 'dataset', 'regions', 'relate'].includes(s.id)).map((s) => [s.id, s.op, s.when === '!has-regions' ? null : s.when ?? null]);
    assert.deepEqual(mine, map);
    // Every operation is one the tools already have, available, with its adapter or the page's interactive step: none forked.
    for (const s of r.steps) { assert.equal(OPERATIONS[s.op].available, true, s.op); assert.ok(ADAPTERS[s.op] || OPERATIONS[s.op].kind === 'interactive', s.op); }
    // The dataset is PLATO JSON, from the files chosen, with no columns to match; its regions are not asked for.
    assert.deepEqual(r.steps[1].from, { files: '$files' });
    assert.deepEqual(r.steps[1].options, { target: 'plato-json' });
    // What the reader cannot carry is said, in sentences.
    assert.ok(r.cannot.length >= 3 && r.cannot.every((c) => /\.$/.test(c)));
    // Its digest is its own, and changes with a word of what it cannot carry.
    assert.notEqual(r.digest, MAP.digest);
  }
  assert.match(TEI.cannot.join(' '), /no ref points to no place/);
  assert.match(TEI.cannot.join(' '), /ref is kept as the place's own address/);
  assert.match(REC.cannot.join(' '), /never linked to one/);
  assert.match(REC.cannot.join(' '), /IIIF georeference/);
  // A recipe whose `cannot` is not a list of sentences is refused, in words (beside the two above, passed).
  assert.throws(() => checkRecipe({ ...TEI, cannot: 'one string' }), /must be a list of sentences/);
  assert.throws(() => checkRecipe({ ...TEI, cannot: [''] }), /must be a list of sentences/);
});

test('the interview: an edition in TEI, or annotations from Recogito, with places on a map or a published dataset, leads to its workflow, asking drawing (and publishing) but not regions', () => {
  const words = (have) => HAVE.find((h) => h.key === have).words;
  assert.equal(words('tei'), 'An edition in TEI');
  assert.equal(words('recogito'), 'Annotations from Recogito');
  for (const [have, recipe] of [['tei', 'places-from-tei'], ['recogito', 'places-from-recogito']]) {
    const map = choose(have, 'map'), pub = choose(have, 'publish');
    assert.deepEqual([map.kind, map.recipe, map.ask], ['recipe', recipe, ['will-draw', 'will-publish']]);
    assert.deepEqual([pub.kind, pub.recipe, pub.ask, pub.set['will-publish']], ['recipe', recipe, ['will-draw'], true]);
    assert.deepEqual(questionsFor(map).map((q) => q.question), [MAP.asks['will-draw'].question, MAP.asks['will-publish'].question]);
    // Answered once the yes-or-no questions are; the base address is asked when publishing, optional, and not otherwise.
    assert.equal(answered(map, {}), false);
    assert.equal(answered(map, { 'will-draw': false, 'will-publish': true }), true);
    assert.deepEqual(baseAsked(map, { 'will-draw': false, 'will-publish': true }), { needed: false, question: RECIPES[recipe].asks.base.question });
    assert.equal(baseAsked(map, { 'will-draw': false, 'will-publish': false }), null);
    assert.equal(baseAsked(pub, {}).needed, false, '"A citable, published dataset" settles publishing, so the base address is asked at once');
    // Given, it reaches the minting step; not given, nothing is put there.
    const files = { files: [{ type: 'files', name: 'x', size: 1, sha256: 'a'.repeat(64) }] };
    const mint = (a) => runner.start(RECIPES[recipe], a, files).steps.find((s) => s.id === 'mint').options;
    assert.equal(mint(answersFor(pub, { 'will-draw': false }, { base: 'https://example.org/e/' })).base, 'https://example.org/e/');
    assert.equal(Object.hasOwn(mint(answersFor(pub, { 'will-draw': false })), 'base'), false);
    // The plan: what it cannot carry, beside its steps; nothing unavailable, nothing noted.
    const p = plan(recipe, answersFor(map, { 'will-draw': true, 'will-publish': false }));
    assert.deepEqual(p.steps.map((s) => s.id), ['check', 'dataset', 'lookup', 'review', 'apply', 'place', 'again', 'compare', 'out']);
    assert.deepEqual(p.cannot, RECIPES[recipe].cannot);
    assert.deepEqual([p.unavailable, p.notes], [[], []]);
    assert.deepEqual(p.left.map((s) => s.id), ['mint', 'report', 'site', 'w3id']);
    // "Write it out" in PLATO JSON, the format the dataset already has, is a download, as in Map your data.
    assert.equal(writesItself(runner.start(RECIPES[recipe], answersFor(map, { 'will-draw': false, 'will-publish': false }), files).steps.find((s) => s.id === 'out'), 'plato-json'), true);
    // Every other answer with an edition or annotations still names no workflow, and says why (the presence: map and publish do).
    for (const w of WANT) if (!['map', 'publish', 'unsure'].includes(w.key)) assert.equal(choose(have, w.key).kind, 'none', `${have} + ${w.key}`);
  }
  // Map your data's own plan names nothing it cannot carry (the absence, beside the two above).
  assert.deepEqual(plan('map-your-data', answersFor(choose('table', 'map'), { 'has-regions': false, 'will-draw': false, 'will-publish': false })).cannot, []);
});

// ---- Places from an edition (TEI), end to end -----------------------------------------------------------
const PLEIADES = ['https://pleiades.stoa.org/places/570106', 'https://pleiades.stoa.org/places/570182', 'https://pleiades.stoa.org/places/570536', 'https://pleiades.stoa.org/places/570642', 'https://pleiades.stoa.org/places/570700'];

test('Places from an edition (TEI), end to end in Node: read, checked, looked up, reviewed, recorded, checked again, compared and written out, each place keeping its ref and gaining its WHG identity', async () => {
  const fake = fakeWhg({ Phlious: [] });   // one place WHG does not find
  const a = await begun(TEI, [EDITION()], fake);
  assert.equal(a.state.status, 'waiting', JSON.stringify(a.state.steps.map((s) => [s.id, s.state, s.problem || s.error])));
  assert.equal(a.state.current, 'review');
  assert.equal(a.reports.check.errors, 0);
  // Read by Hermes's TEI reader: five places, about the addresses the refs give; Lechaeum, with no ref, is not carried, and the report says so.
  const made = JSON.parse(await a.host.store.get(a.state.steps.find((s) => s.id === 'dataset').outputs.dataset[0].name).text());
  assert.deepEqual(ends(made).addresses, PLEIADES);
  assert.ok(a.reports.dataset.items.some((i) => (i.examples || []).some((x) => JSON.stringify(x).includes('Lechaeum'))), 'the place name with no ref is reported');
  // The names went to the fake WHG, one place each; Phlious answered with nothing.
  assert.deepEqual(fake.sent().sort(), ['Argos', 'Corinth', 'Kenchreai', 'Phlious', 'Sikyon']);
  const { accepted, state } = await reviewed(a.host, a.state);
  assert.equal(accepted, 4);
  const c = await drive(state, a.host);
  assert.equal(c.state.status, 'completed', JSON.stringify(c.state.steps.map((s) => [s.id, s.state, s.problem || s.error])));
  assert.deepEqual(c.state.steps.map((s) => s.state), ['done', 'done', 'done', 'done', 'done', 'skipped', 'done', 'done', 'done', 'skipped', 'skipped', 'skipped', 'skipped']);
  assert.equal(c.reports.again.errors, 0);
  assert.equal(c.reports.compare.errors, 0, 'only added to: the dataset made from the edition is all still there');
  const e = ends(await outOf(a.host, c.state));
  assert.deepEqual(e.addresses, PLEIADES, 'every place keeps the address its ref gave');
  assert.equal(e.stub, 4);
  assert.equal(e.citesWhg, true);
  // Kenchreai's second ref (GeoNames) is kept as the edition gives it.
  assert.deepEqual(e.others, [['https://pleiades.stoa.org/places/570536', 'https://sws.geonames.org/257880/']]);
  // Every request went to WHG's address alone (the presence: the lookup was made).
  assert.ok(fake.urls.length >= 1 && fake.urls.every((u) => u.startsWith(new URL(WHG_ENDPOINT).origin + '/')), fake.urls.join(' '));
  // The check of the end fails on the same file as a step that skipped its work would leave it: no identities recorded; or the refs lost.
  const doc = await outOf(a.host, c.state);
  const noIds = { ...doc, spatialEntities: doc.spatialEntities.map((x) => ({ ...x, attestations: x.attestations.map(({ identities, ...rest }) => rest) })) };
  assert.equal(ends(noIds).stub, 0);
  assert.equal(ends(noIds).citesWhg, false);
  const noRefs = { ...doc, spatialEntities: doc.spatialEntities.map((x, i) => ({ ...x, '@id': `https://example.org/minted/${i}` })) };
  assert.notDeepEqual(ends(noRefs).addresses, PLEIADES);
});

test('a ref to WHG is kept as the identification: the record it names is not suggested again, while a WHG record for a place whose ref is another gazetteer\'s is', async () => {
  // Paris's ref is WHG's place:gn:2988507 (its own address once read); Grenoble's is GeoNames'.
  const fake = fakeWhg({ Paris: [C('place:gn:2988507', 'Paris'), C('place:gn:9999001', 'Paris')], Grenoble: [C('place:gn:3014728', 'Grenoble')] });
  const a = await begun(TEI, [fixture('tei/whg-constructed.xml')], fake);
  assert.equal(a.state.current, 'review', JSON.stringify(a.state.steps.map((s) => [s.id, s.state, s.problem || s.error])));
  const work = readWork(await a.host.store.get(a.state.steps.find((x) => x.id === 'lookup').outputs.work[0].name).text());
  const suggested = (iri) => work.candidates.filter((c) => c.candidate_source === iri && c.lookup).map((c) => c.candidate_candidate);
  assert.deepEqual(suggested(`${W3ID}place:gn:2988507`), [`${W3ID}place:gn:9999001`], 'Paris: its own record is not suggested; the other is');
  assert.deepEqual(suggested('https://sws.geonames.org/3014728/'), [`${W3ID}place:gn:3014728`], 'Grenoble: the WHG record is suggested beside its GeoNames ref');
  assert.ok(work.lookups[0].counts.skipped.linked >= 1, JSON.stringify(work.lookups[0].counts));
});

// ---- Places from Recogito, end to end ----------------------------------------------------------------------
const PLACED = 7;   // the regions of the constructed export placed through the Rocque map's georeference

test('Places from Recogito, end to end in Node: the export and the map\'s georeference read together, regions placed, the named places looked up, reviewed, recorded and written out, keeping Recogito\'s links and the placed regions', async () => {
  const fake = fakeWhg();
  const a = await begun(REC, RECOGITO(), fake);
  assert.equal(a.state.current, 'review', JSON.stringify(a.state.steps.map((s) => [s.id, s.state, s.problem || s.error])));
  // The three files are one input, as the page and the command line take them: the step's files are all three.
  assert.equal(a.state.files.files.length, 3);
  const made = ends(JSON.parse(await a.host.store.get(a.state.steps.find((s) => s.id === 'dataset').outputs.dataset[0].name).text()));
  assert.equal(made.places, 13);
  assert.equal(made.placed, PLACED);
  assert.ok(made.addresses.every((x) => x.startsWith('http://www.wikidata.org/entity/Q')), 'each place is about the item Recogito linked it to');
  // A region with no transcription or quoted name has nothing to look up, and is not looked up: counted, not sent.
  const work = readWork(await a.host.store.get(a.state.steps.find((x) => x.id === 'lookup').outputs.work[0].name).text());
  assert.equal(work.lookups[0].counts.withoutName, 4);
  assert.equal(fake.sent().length, 9);
  assert.deepEqual(fake.sent().sort(), ['120', '45', 'Boston', 'GULF OF MEXICO', 'LAKE ERIE', 'LAKE HURON', 'LAKE ONTARIO', 'Nantucket I.', 'St Georges Bank']);
  const { accepted, state } = await reviewed(a.host, a.state);
  assert.equal(accepted, 9);
  const c = await drive(state, a.host);
  assert.equal(c.state.status, 'completed', JSON.stringify(c.state.steps.map((s) => [s.id, s.state, s.problem || s.error])));
  assert.equal(c.reports.again.errors, 0);
  assert.equal(c.reports.compare.errors, 0);
  const doc = await outOf(a.host, c.state);
  const e = ends(doc);
  assert.deepEqual(e.addresses, made.addresses);
  assert.deepEqual([e.placed, e.stub, e.citesWhg], [PLACED, 9, true]);
  // A placed region cites the map's georeference (the method used), as Hermes wrote it.
  const georef = doc.spatialEntities.flatMap((x) => x.attestations).filter((x) => (x.geometries || []).length);
  assert.equal(georef.length, PLACED);
  assert.ok(georef.every((x) => JSON.stringify(x.citations).includes('annotations.allmaps.org')), 'each placed region cites the georeference');
});

test('the check of the placed regions can fail: the export read without the map\'s georeference places none, and the end check says so (the same export with it places seven)', async () => {
  const [exp] = RECOGITO();
  const a = await begun(REC, [exp], fakeWhg());
  assert.equal(a.state.current, 'review');
  const made = ends(JSON.parse(await a.host.store.get(a.state.steps.find((s) => s.id === 'dataset').outputs.dataset[0].name).text()));
  assert.equal(made.places, 13, 'the places are read all the same');
  assert.equal(made.placed, 0, 'and none is placed');
  assert.notEqual(made.placed, PLACED);
});
