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
import { readWork, serialiseWork } from '../src/engine/krisis/work.js';
import { acceptGuarded, planGuarded, guardOf } from '../src/engine/krisis/guards.js';
import { runLookup } from '../src/engine/krisis/lookup.js';
import { gather } from '../src/engine/krisis/match.js';
import { detect } from '../src/engine/input.js';
import { summary } from '../src/engine/words.js';
import { HAVE, WANT, choose, questionsFor, answersFor, answered, baseAsked, plan } from '../src/engine/methodos/interview.js';
import { RECIPES, OPERATIONS, ADAPTERS, runner, drive, refsOf, checkRecipe, writesItself, digest } from '../src/engine/methodos/index.js';

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
const C = (id, name, point = null) => ({ id, name, score: 100, match: true, description: 'Country: GR', ccodes: ['GR'], namespace: id.split(':')[1], alt_names: [], ...(point ? { repr_point: point } : {}) });
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
/** The review: the bulk accept of what passes WHG's guards (as the page's button), by a named reviewer; the work file as the step's result. */
async function reviewed(host, state) {
  const ref = state.steps.find((x) => x.id === 'lookup').outputs.work[0];
  const work = readWork(await host.store.get(ref.name).text());
  const bulk = acceptGuarded(work, { reviewer: { name: 'A. Reviewer' }, at: AT });
  const f = new File([serialiseWork(work)], ref.name.replace(/\.krisis\.json$/, '.reviewed.krisis.json'));
  host.store.set(f.name, f);
  return { work, bulk, accepted: bulk.accepted, state: runner.complete(state, 'review', { work: await refsOf([f], 'work.krisis') }) };
}
/** The lookup step's work file. */
const workOf = async (host, state) => readWork(await host.store.get(state.steps.find((x) => x.id === 'lookup').outputs.work[0].name).text());
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
    // Not Map your data's Wikidata items step either (Issue #36): the editions' and the export's workflows are not among the three that have it.
    const map = MAP.steps.filter((s) => !['columns', 'check', 'dataset', 'regions', 'relate', 'wikidata'].includes(s.id)).map((s) => [s.id, s.op, s.when === '!has-regions' ? null : s.when ?? null]);
    assert.deepEqual(mine, map);
    // Every operation is one the tools already have, available, with its adapter or the page's interactive step: none forked.
    for (const s of r.steps) { assert.equal(OPERATIONS[s.op].available, true, s.op); assert.ok(ADAPTERS[s.op] || OPERATIONS[s.op].kind === 'interactive', s.op); }
    // The dataset is PLATO JSON, from the files chosen, with no columns to match; its regions are not asked for.
    assert.deepEqual(r.steps[1].from, { files: '$files' });
    assert.deepEqual(r.steps[1].options, { target: 'plato-json' });
    // What the reader cannot carry is said, in sentences.
    assert.ok(r.cannot.length >= 3 && r.cannot.every((c) => /\.$/.test(c)));
    // Its digest is its own, and changes with a word of what it cannot carry (the recipe as it is gives its own digest: the control).
    assert.notEqual(r.digest, MAP.digest);
    const { digest: d0, ...plain } = r;
    assert.equal(digest(plain), d0);
    assert.notEqual(digest({ ...plain, cannot: [...r.cannot.slice(0, -1), r.cannot.at(-1).replace(/\.$/, '!')] }), d0);
  }
  assert.match(TEI.cannot.join(' '), /no ref, or a ref it cannot follow, points to no place/);
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

// Argos's ref is Pleiades 570106. WHG answers its record (place:pl:570106, at Argos) and, ranked above it, an Argos in
// Indiana: WHG's best candidate is some 8,900 km from the ref's record, so the place is flagged and left to the reviewer.
const ARGOS_PL = [22.7278, 37.6331], ARGOS_IN = [-86.2453, 41.2373];
test('Places from an edition (TEI), end to end in Node: read, checked, looked up in batches, reviewed, recorded, checked again, compared and written out, each place keeping its ref and gaining its WHG identity, Argos flagged', async () => {
  const fake = fakeWhg({ Phlious: [], Argos: [C('place:gn:9300001', 'Argos', ARGOS_IN), { ...C('place:pl:570106', 'Argos', ARGOS_PL), score: 90 }] });
  // (Its own record scores under the Indiana one, so that the Indiana one passes WHG's guards: only the flag keeps it from the bulk accept.)
  const a = await begun(TEI, [EDITION()], fake);
  assert.equal(a.state.status, 'waiting', JSON.stringify(a.state.steps.map((s) => [s.id, s.state, s.problem || s.error])));
  assert.equal(a.state.current, 'review');
  assert.equal(a.reports.check.errors, 0);
  // Read by Hermes's TEI reader: five places, about the addresses the refs give; Lechaeum, with no ref, is not carried, and the report says so.
  const made = JSON.parse(await a.host.store.get(a.state.steps.find((s) => s.id === 'dataset').outputs.dataset[0].name).text());
  assert.deepEqual(ends(made).addresses, PLEIADES);
  assert.ok(a.reports.dataset.items.some((i) => (i.examples || []).some((x) => JSON.stringify(x).includes('Lechaeum'))), 'the place name with no ref is reported');
  // The names went to the fake WHG, one place each, in one batched request (WHG's batch: 25 queries a request by default); Phlious answered with nothing.
  assert.deepEqual(fake.sent().sort(), ['Argos', 'Corinth', 'Kenchreai', 'Phlious', 'Sikyon']);
  assert.deepEqual(fake.bodies.map((b) => Object.keys(b.queries).length), [5], 'five queries in one POST, not one a request');
  // Argos: the ref's own record is never suggested; WHG's best candidate is flagged as far from it, and the bulk accept leaves it.
  const looked = await workOf(a.host, a.state);
  const argos = looked.places['https://pleiades.stoa.org/places/570106'];
  assert.deepEqual([argos.ref.state, argos.ref.record.id, argos.ref.best.id], ['disagrees', 'place:pl:570106', 'place:gn:9300001']);
  assert.ok(argos.ref.distance_km > 8000 && argos.ref.limit_km === 25, JSON.stringify(argos.ref));
  assert.deepEqual(looked.candidates.filter((c) => c.candidate_source === 'https://pleiades.stoa.org/places/570106').map((c) => c.gazetteer.id), ['place:gn:9300001']);
  assert.ok(guardOf(looked.candidates.find((c) => c.gazetteer.id === 'place:gn:9300001')).pass, 'it passes the guards: the flag alone keeps it out');
  const { accepted, bulk, state } = await reviewed(a.host, a.state);
  assert.equal(accepted, 3);
  assert.equal(bulk.flagged, 1);
  const c = await drive(state, a.host);
  assert.equal(c.state.status, 'completed', JSON.stringify(c.state.steps.map((s) => [s.id, s.state, s.problem || s.error])));
  assert.deepEqual(c.state.steps.map((s) => s.state), ['done', 'done', 'done', 'done', 'done', 'skipped', 'done', 'done', 'done', 'skipped', 'skipped', 'skipped', 'skipped']);
  assert.equal(c.reports.again.errors, 0);
  assert.equal(c.reports.compare.errors, 0, 'only added to: the dataset made from the edition is all still there');
  const e = ends(await outOf(a.host, c.state));
  assert.deepEqual(e.addresses, PLEIADES, 'every place keeps the address its ref gave');
  assert.equal(e.stub, 3);
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

test('a ref is kept as the identification: the WHG record it names is never suggested, whether the ref is WHG\'s address or GeoNames\'; another record is', async () => {
  // Paris's ref is WHG's place:gn:2988507 (its own address once read); Grenoble's is GeoNames'.
  const fake = fakeWhg({ Paris: [C('place:gn:2988507', 'Paris'), C('place:gn:9999001', 'Paris')], Grenoble: [C('place:gn:3014728', 'Grenoble')] });
  const a = await begun(TEI, [fixture('tei/whg-constructed.xml')], fake);
  assert.equal(a.state.current, 'review', JSON.stringify(a.state.steps.map((s) => [s.id, s.state, s.problem || s.error])));
  const work = readWork(await a.host.store.get(a.state.steps.find((x) => x.id === 'lookup').outputs.work[0].name).text());
  const suggested = (iri) => work.candidates.filter((c) => c.candidate_source === iri && c.lookup).map((c) => c.candidate_candidate);
  assert.deepEqual(suggested(`${W3ID}place:gn:2988507`), [`${W3ID}place:gn:9999001`], 'Paris: its own record is not suggested; the other is');
  assert.deepEqual(suggested('https://sws.geonames.org/3014728/'), [], 'Grenoble: WHG\'s record of its GeoNames ref is its own, not suggested');
  assert.equal(work.lookups[0].counts.skipped.linked, 2, JSON.stringify(work.lookups[0].counts));
});

test('a Pleiades ref checked against WHG: its record (place:pl:...) never suggested; a best candidate far from it flags the place, a near one does not, the distance set by the reviewer; a record not answered, or with no point, is said and flags nothing', async () => {
  const PL = (n, name, point) => C(`place:pl:${n}`, name, point);
  const answers = {
    Argos: [C('place:gn:9300002', 'Argos', [22.73, 37.70]), { ...PL(570106, 'Argos', ARGOS_PL), score: 90 }],   // 7.4 km apart: agrees
    Kenchreai: [C('place:gn:9300003', 'Kenchreai', [23.9, 38.9]), PL(570536, 'Kenchreai', [22.995, 37.884])],  // about 140 km apart: disagrees
    Corinth: [C('place:gn:9300004', 'Corinth', [22.88, 37.94])],                                          // its record not answered
    Sikyon: [PL(570700, 'Sikyon'), C('place:gn:9300005', 'Sikyon', [22.71, 37.98])],                       // its record has no point
    Phlious: [],
  };
  const a = await begun(TEI, [EDITION()], fakeWhg(answers));
  const work = await workOf(a.host, a.state);
  const ref = (n) => work.places[`https://pleiades.stoa.org/places/${n}`].ref;
  assert.deepEqual([ref(570106).state, ref(570536).state, ref(570182).state, ref(570182).why, ref(570700).state, ref(570700).why],
    ['agrees', 'disagrees', 'unresolved', 'not-found', 'unresolved', 'no-point']);
  assert.ok(ref(570106).distance_km < 25 && ref(570536).distance_km > 25);
  // No Pleiades record is suggested; the other records are.
  assert.deepEqual(work.candidates.map((c) => c.gazetteer.id).sort(), ['place:gn:9300002', 'place:gn:9300003', 'place:gn:9300004', 'place:gn:9300005']);
  assert.equal(work.lookups[0].counts.refsDisagree, 1);
  assert.equal(work.lookups[0].counts.refsUnresolved, 3, 'Corinth, Sikyon, and Phlious, which WHG answered with nothing');
  // The bulk accept settles the places that agree or could not be checked, never the flagged one.
  const plan = planGuarded(work);
  assert.deepEqual(plan.flagged, ['https://pleiades.stoa.org/places/570536']);
  assert.ok(!plan.accept.some((c) => c.candidate_source === 'https://pleiades.stoa.org/places/570536'));
  assert.ok(plan.accept.some((c) => c.candidate_source === 'https://pleiades.stoa.org/places/570106'), 'the presence: a place that agrees is accepted');
  // The distance is the reviewer's: looked up again with 200 km, Kenchreai agrees.
  const made = a.host.store.get(a.state.steps.find((s) => s.id === 'dataset').outputs.dataset[0].name);
  const g = await gather({ subjects: await detect([made]) }, a.host.env().env);
  const again = await runLookup({ lookup: lookupWith(fakeWhg(answers)), subjects: g.subjects, places: g.places, options: { places: 'all', disagreeKm: 200 } });
  assert.deepEqual([again.work.places['https://pleiades.stoa.org/places/570536'].ref.state, again.work.places['https://pleiades.stoa.org/places/570536'].ref.limit_km], ['agrees', 200]);
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
  // Nine queries in one batched request.
  assert.deepEqual(fake.bodies.map((b) => Object.keys(b.queries).length), [9]);
  // The step that read the export says how many of its regions were placed.
  assert.deepEqual([a.reports.dataset.counts['regions on images'], a.reports.dataset.counts['regions placed']], [16, PLACED]);
  assert.match(summary(a.reports.dataset).counted, /7 of 16 regions on images placed on a map/);
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

test('the export dropped with another map\'s georeference places none, and says so: the georeference unused, and "0 of 16 regions placed" in the step\'s summary (the right map\'s places seven)', async () => {
  const [exp] = RECOGITO();
  const other = [fixture('georef/bpl-british-dominions-annotation.json'), fixture('georef/bpl-british-dominions-manifest.json')];
  const a = await begun(REC, [exp, ...other], fakeWhg());
  assert.equal(a.state.current, 'review', JSON.stringify(a.state.steps.map((s) => [s.id, s.state, s.problem || s.error])));
  const made = ends(JSON.parse(await a.host.store.get(a.state.steps.find((s) => s.id === 'dataset').outputs.dataset[0].name).text()));
  assert.equal(made.placed, 0);
  const kinds = a.reports.dataset.items.map((i) => i.kind);
  assert.ok(kinds.includes('annotation-georef-unused') || kinds.includes('annotation-manifest-mismatch'), kinds.join(' '));
  assert.deepEqual([a.reports.dataset.counts['regions on images'], a.reports.dataset.counts['regions placed'] ?? 0], [16, 0]);
  assert.match(summary(a.reports.dataset).counted, /0 of 16 regions on images placed on a map/);
  // The control: the right map's georeference places seven, and its summary says so.
  const right = await begun(REC, RECOGITO(), fakeWhg());
  assert.match(summary(right.reports.dataset).counted, /7 of 16 regions on images placed on a map/);
});

test('a gazetteer address and the WHG record it names go both ways, for GeoNames, Getty TGN, Wikidata, OpenStreetMap and Pleiades (new), and WHG\'s own; a project\'s address names none', async () => {
  const { authorityIris, whgIdOf, addressesOf } = await import('../src/engine/krisis/identities.js');
  for (const id of ['place:gn:2641673', 'place:tgn:7011179', 'place:wd:Q42', 'place:osm:r65606', 'place:osm:w12', 'place:osm:n3', 'place:pl:570106']) {
    const iris = authorityIris(id);
    assert.ok(iris.length >= 4, id);
    for (const iri of iris) assert.equal(whgIdOf(iri), id, iri);
    assert.ok(addressesOf({ id, iri: `${W3ID}${id}` }).has(iris[0]));
  }
  assert.equal(whgIdOf(`${W3ID}place:gn:2988507`), 'place:gn:2988507');
  assert.equal(whgIdOf('https://whgazetteer.org/entity/place:gn:2995469/api'), 'place:gn:2995469');
  for (const iri of ['https://example.org/places/1', 'https://whgazetteer.org/places/6421/portal/', 'https://pleiades.stoa.org/places/570106/json', 'https://www.wikidata.org/wiki/Special:Search']) assert.equal(whgIdOf(iri), null, iri);
});
