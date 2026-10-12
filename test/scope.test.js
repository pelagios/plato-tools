// Scope (Issue #33, points 2 and 8; src/engine/krisis/scope.js): what a Scope sends to WHG, the precedence of a
// row's own regions and filters over its Where, the Scope kept in the workflow's record, and the shape of the
// bundled data. Every absence asserted has its presence beside it: a Where not sent is checked beside the same
// lookup with nothing of its own, sending it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { normaliseScope, emptyScope, isEmptyScope, scopeFields, typeIds, containerId, areaPolygon, excludesUndated, yearsProblem, scopeType, UNDATED_TAKEN, WHERE_KEYS } from '../src/engine/krisis/scope.js';
import { TYPE_SHORTLIST, BUNDLED_SOURCES, COUNTRY_CODES } from '../src/engine/krisis/scope-data.js';
import { planQueries, runLookup, newWork, placeQuery } from '../src/engine/krisis/lookup.js';
import { LOOKUP_WORDS, SCOPE_WORDS, lookupPage } from '../src/engine/words.js';
import { RECIPES, runner, recordOf, exportRecord, importRecord, reconcile, restartRemaining, runStep } from '../src/engine/methodos/index.js';
import { workflowStore } from '../src/methodos/store.js';

const SQUARE = { type: 'Polygon', coordinates: [[[-3, 53], [-2, 53], [-2, 54], [-3, 54], [-3, 53]]] };
const FULL = {
  where: { mode: 'countries', countries: ['gb', 'IE', 'GB', 'XX1'] },
  types: [{ id: 'aat:300008347', label: 'Settlements', narrower: ['aat:300008389', 'aat:300008375', 'aat:300008347', 'nope'] }],
  when: { start: 1500, end: 1600, undated: true },
  sources: ['GN', 'tgn', 'bad ns'],
};

test('a Scope is made safe as it is read: codes in capitals and checked, ids bare and case kept, junk dropped', () => {
  const s = normaliseScope(FULL);
  assert.deepEqual(s.where, { mode: 'countries', countries: ['GB', 'IE'] });
  assert.deepEqual(s.types[0].narrower, ['aat:300008375', 'aat:300008389']);
  assert.deepEqual(s.sources, ['gn', 'tgn']);
  assert.deepEqual(s.when, { start: 1500, end: 1600, undated: true });
  // A WHG place given as a candidate id, a full address, or bare: bare, its case kept (WHG ids are case-sensitive).
  assert.equal(containerId('place:wd:Q21'), 'wd:Q21');
  assert.equal(containerId('https://w3id.org/whg/id/place:gn:2635167'), 'gn:2635167');
  assert.equal(containerId('osm:R62149'), 'osm:R62149');
  assert.equal(containerId('England'), null);
  assert.deepEqual(normaliseScope({ where: { mode: 'place', place: { id: 'https://w3id.org/whg/id/place:wd:Q21', label: 'England' } } }).where, { mode: 'place', place: { id: 'wd:Q21', label: 'England' } });
  // What is not a Scope gives the empty one; an area that is no polygon is dropped, one left open is closed.
  assert.deepEqual(normaliseScope('nonsense'), emptyScope());
  assert.equal(normaliseScope({ where: { mode: 'area', area: { type: 'Point', coordinates: [1, 2] } } }).where.mode, 'anywhere');
  const open = areaPolygon({ type: 'Polygon', coordinates: [[[-3, 53], [-2, 53], [-2, 54]]] });
  assert.equal(open, null);   // three corners, not closed: three distinct points need a fourth to close
  assert.deepEqual(areaPolygon({ type: 'Polygon', coordinates: [[[-3, 53], [-2, 53], [-2, 54], [-3, 54]]] }), SQUARE);
  assert.equal(isEmptyScope(emptyScope()), true);
  assert.equal(isEmptyScope(FULL), false);
});

test('each Where reaches the request as its own field: countries, contained_in (a bare id in a list), bounds', () => {
  const where = (w) => scopeFields({ where: w }).params;
  assert.deepEqual(where({ mode: 'countries', countries: ['GB'] }), { countries: ['GB'] });
  assert.deepEqual(where({ mode: 'place', place: { id: 'place:gn:2635167', label: 'England' } }), { contained_in: ['gn:2635167'] });
  assert.deepEqual(where({ mode: 'area', area: SQUARE }), { bounds: SQUARE });
  assert.deepEqual(where({ mode: 'anywhere' }), {});
});

test('types are sent with every narrower one, years with temporal, sources as namespaces; undated only once WHG takes it', () => {
  const { params, parts } = scopeFields(FULL);
  assert.deepEqual(params.types, ['aat:300008347', 'aat:300008375', 'aat:300008389']);
  assert.deepEqual(typeIds(FULL), params.types);
  assert.deepEqual([params.start, params.end, params.temporal], [1500, 1600, true]);
  assert.deepEqual(params.namespaces, ['gn', 'tgn']);
  assert.deepEqual(parts, ['where', 'what', 'when', 'sources']);
  // The one switch: off, a ticked "undated" sends nothing, and places with no dates are said to be left out.
  assert.equal(UNDATED_TAKEN, false);
  assert.equal('undated' in params, false);
  assert.equal(excludesUndated(FULL), true);
  assert.equal(excludesUndated({ when: { start: null, end: null } }), false);
  // A start after the end is no years at all, and said.
  const backwards = { when: { start: 1700, end: 1600 } };
  assert.equal(yearsProblem(backwards), 'start-after-end');
  assert.equal('start' in scopeFields(backwards).params, false);
});

test('precedence: a row that already says where to look keeps it; its types, years and sources still go', () => {
  for (const k of WHERE_KEYS) {
    const own = { [k]: k === 'countries' || k === 'contained_in' ? ['x'] : k === 'bounds' ? SQUARE : 1 };
    const r = scopeFields(FULL, { own });
    assert.equal(r.yielded, true, k);
    assert.equal('countries' in r.params, false, k);
    assert.deepEqual(r.parts, ['what', 'when', 'sources'], k);
  }
  // The control: with nothing of its own, the same Scope sends its Where.
  assert.deepEqual(scopeFields(FULL, { own: { lang: 'en' } }).params.countries, ['GB', 'IE']);
  // "With no constraint" sends no Where either.
  assert.equal('countries' in scopeFields(FULL, { relaxed: 'all' }).params, false);
  // A region of the region review takes the Where alone.
  assert.deepEqual(scopeFields(FULL, { region: true }).params, { countries: ['GB', 'IE'] });
});

test('planned queries: region columns override Where row by row, the widest regions take it, and the preview says so', () => {
  const places = [
    { iri: 'p:1', label: 'Mill Farm', params: { contained_in: ['gn:2641434'] }, constraint: { from: 'r:newton', kinds: ['contained_in'], params: { contained_in: ['gn:2641434'] }, relaxed: null } },
    { iri: 'p:2', label: 'Lone Farm' },
  ];
  const { queries, preview } = planQueries(places, { scope: FULL });
  const [mill, lone] = queries.map((q) => q.params);
  assert.deepEqual(mill.contained_in, ['gn:2641434']);
  assert.equal(mill.countries, undefined);
  assert.deepEqual(lone.countries, ['GB', 'IE']);
  for (const p of [mill, lone]) { assert.equal(p.types.length, 3); assert.equal(p.start, 1500); assert.deepEqual(p.namespaces, ['gn', 'tgn']); }
  assert.equal(preview.scope.whereYielded, 1);
  assert.deepEqual(preview.first[1], { ...lone, query: 'Lone Farm', type: 'Place', limit: 10 });
  const said = LOOKUP_WORDS.preview(preview).join(' ');
  assert.match(said, /The Scope is sent as countries, types, start, end, temporal, namespaces/);
  assert.match(said, /For 1 place, the Scope's Where gives way/);
  // A region review's widest level: Where alone, beside area_only.
  const regions = planQueries([{ iri: 'r:1', label: 'Cheshire', constraint: { from: null, kinds: [], params: {}, relaxed: null } }], { scope: FULL, areaOnly: true });
  assert.deepEqual(regions.queries[0].params, { countries: ['GB', 'IE'], area_only: true });
  // No Scope: none of its fields (the control for every field above).
  const none = planQueries(places, {}).queries.map((q) => q.params ?? {});
  assert.deepEqual(none[1], {});
  assert.equal(planQueries(places, {}).preview.scope, undefined);
  // Another service is sent no Scope (it is WHG's).
  const other = planQueries(places, { scope: FULL, service: { endpoint: 'https://example.org/reconcile', title: 'Other' } });
  assert.equal(other.queries[1].params, undefined);
});

test("Chora's adopt search takes the Scope too: the place's own region wins over Where, the rest still sent", () => {
  const within = placeQuery({ iri: 'p:1', label: 'Kirk House', params: { contained_in: ['gn:1'] } }, { scope: FULL });
  assert.deepEqual([within.sent.contained_in, within.sent.countries, within.sent.start], [['gn:1'], undefined, 1500]);
  const free = placeQuery({ iri: 'p:1', label: 'Kirk House' }, { scope: FULL });
  assert.deepEqual(free.sent.countries, ['GB', 'IE']);
});

test('a scoped place answered with nothing is said so, with the likely cause; unscoped, the plain words (the control)', async () => {
  const empty = { batchSize: 25, reconcile: async (qs) => Object.assign(qs.map((q) => Object.assign([], { key: q.key, scope: q.params?.types ? { applied: true } : undefined })), { attribution: null }) };
  const subjects = { title: 'T', files: [] };
  const places = [{ iri: 'p:1', label: 'Nowhere' }];
  const scoped = await runLookup({ lookup: empty, subjects, places, options: { places: 'all', scope: FULL } });
  const q = scoped.record.queries['p:1'];
  assert.deepEqual([q.state, q.found, q.scoped], ['answered', 0, ['where', 'what', 'when', 'sources']]);
  assert.deepEqual(scoped.record.parameters.scope, normaliseScope(FULL));
  assert.equal(lookupPage.state('WHG', q), `WHG: ${SCOPE_WORDS.emptyRow()}`);
  assert.match(SCOPE_WORDS.emptyRow(), /Nothing within the Scope among WHG's best name matches/);
  const plain = await runLookup({ lookup: empty, subjects, places, options: { places: 'all' } });
  const p = plain.record.queries['p:1'];
  assert.equal(p.scoped, undefined);
  assert.equal(lookupPage.state('WHG', p), 'WHG: No candidates (label only).');
});

test('the rail chips say each part of the Scope', () => {
  const chips = SCOPE_WORDS.chips(normaliseScope(FULL), (c) => ({ GB: 'United Kingdom', IE: 'Ireland' })[c]);
  assert.deepEqual(chips.map((c) => [c.key, c.text]), [['where', 'United Kingdom, Ireland'], ['what', 'Settlements (and 2 narrower types)'], ['when', '1500 to 1600'], ['sources', 'gn, tgn']]);
  assert.deepEqual(SCOPE_WORDS.chips(emptyScope()).map((c) => c.text), ['anywhere', 'every kind of place', 'any time', 'all sources']);
});

// ---- the workflow's record ----------------------------------------------------------------------------
const PUBLISH = RECIPES['publish-a-dataset'];
const ref = (type, name, c = 'a') => ({ type, name, size: 10, sha256: c.repeat(64) });
const scoped = () => ({ ...runner.start(PUBLISH, { release: 'v1' }, { files: [ref('files', 'p.json')] }), scope: normaliseScope(FULL) });

test("the Scope goes with the workflow's record: saved, read back, downloaded, taken up, and kept under a new recipe", async () => {
  const r = recordOf(runner.next(scoped()), { name: 'Scoped' });
  const back = importRecord(exportRecord(r));
  assert.deepEqual(back.scope, normaliseScope(FULL));
  assert.deepEqual(reconcile(back, PUBLISH).state.scope, normaliseScope(FULL));
  assert.deepEqual(restartRemaining(back, PUBLISH).scope, normaliseScope(FULL));
  // A record without one has none (the control): nothing is invented.
  assert.equal(restartRemaining(recordOf(runner.start(PUBLISH, { release: 'v1' }, { files: [ref('files', 'p.json')] })), PUBLISH).scope, undefined);
  // Kept in IndexedDB and read back after a "reload" (a new store on the same database).
  const indexedDB = new IDBFactory();
  const { record } = await workflowStore({ indexedDB, keep: () => true }).save(r);
  assert.deepEqual((await workflowStore({ indexedDB, keep: () => true }).load(record.id)).scope, normaliseScope(FULL));
  // A workflow chosen before any file keeps its Scope too.
  const st = workflowStore({ indexedDB, keep: () => true });
  await st.savePending({ id: 'p1', key: PUBLISH.key, answers: { release: 'v1' }, scope: normaliseScope(FULL) });
  assert.deepEqual((await st.pendings()).find((p) => p.id === 'p1').scope, normaliseScope(FULL));
});

test("a workflow's steps are run with its Scope (the lookup's adapters send it)", async () => {
  // Publish a dataset's first step, the check, running: its adapter (a stand-in) is given the Scope beside its inputs.
  const s = runner.next(scoped());
  assert.equal(s.status, 'running');
  const op = s.steps.find((x) => x.id === s.current).op;
  let given = 'not called';
  const r = await runStep(s, {}, { adapters: { [op]: async (a) => { given = a.scope; return { outputs: {}, report: null }; } } });
  assert.deepEqual(given, normaliseScope(FULL));
  assert.equal(r.state.scope.where.mode, 'countries');
  // Without one, none (the control).
  let none = 'not called';
  await runStep(runner.next(runner.start(PUBLISH, { release: 'v1' }, { files: [ref('files', 'p.json')] })), {}, { adapters: { [op]: async (a) => { none = a.scope; return { outputs: {}, report: null }; } } });
  assert.equal(none, null);
});

// ---- the bundled data ------------------------------------------------------------------------------------
test('the shortlist: 12 to 20 AAT place types, each with its narrower ones, and a type made from it keeps them', () => {
  assert.ok(TYPE_SHORTLIST.length >= 12 && TYPE_SHORTLIST.length <= 20, TYPE_SHORTLIST.length);
  assert.equal(new Set(TYPE_SHORTLIST.map((t) => t.id)).size, TYPE_SHORTLIST.length);
  for (const t of TYPE_SHORTLIST) {
    assert.match(t.id, /^aat:3\d{8}$/);
    assert.ok(t.label && t.aat, t.id);
    assert.ok(Array.isArray(t.narrower) && t.narrower.every((n) => /^aat:\d+$/.test(n) && n !== t.id), t.id);
  }
  const settlements = TYPE_SHORTLIST.find((t) => t.id === 'aat:300008347');
  assert.ok(settlements.narrower.length > 100);   // inhabited places: some 240 narrower types, on 12 October 2026
  const kept = scopeType({ id: settlements.id, label: settlements.label }, [settlements.id, ...settlements.narrower], 'bundled');
  assert.deepEqual(kept.narrower, [...settlements.narrower].sort());
  assert.equal(SCOPE_WORDS.typeLabel(kept), `${settlements.label} (and ${settlements.narrower.length} narrower types)`);
});

test('the bundled sources and countries: namespaces as WHG writes them, all 249 ISO codes, each named by the platform', () => {
  assert.ok(BUNDLED_SOURCES.length > 10);
  for (const s of BUNDLED_SOURCES) { assert.match(s.namespace, /^[a-z][a-z0-9_]*$/); assert.ok(s.name); }
  assert.ok(['gn', 'wd', 'tgn', 'osm', 'pl'].every((n) => BUNDLED_SOURCES.some((s) => s.namespace === n)));
  assert.equal(COUNTRY_CODES.length, 249);
  const names = new Intl.DisplayNames(['en-GB'], { type: 'region' });
  const unnamed = COUNTRY_CODES.filter((c) => { const n = names.of(c); return !n || n === c || /unknown/i.test(n); });
  assert.deepEqual(unnamed, []);
  assert.equal(names.of('ZZ'), 'Unknown Region');   // the control: a code that is not one is told apart
});
