// Krisis: the search in Wikidata before an item is made, and the reads that bring the Q-ids back
// (src/engine/krisis/wikidata-search.js), with a fake fetch standing in for api.php: what is asked (each
// request's address, in series, with origin=*), what comes back as candidates of the ordinary review, what a
// failure does (unanswered, never "no match"), and the permissions: nothing is sent while Wikidata is not
// allowed, and the same search sends once it is. Each absence has its presence beside it. The one live read
// (test/krisis-wikidata-live.test.js) is apart, and skipped unless asked for.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/lib/permissions-core.js';
import * as permissions from '../src/lib/permissions.js';
import { readWork, serialiseWork } from '../src/engine/krisis/work.js';
import { newWork, gazetteerPermission, permittedFetch, lookupCandidatesOf } from '../src/engine/krisis/lookup.js';
import { searchRequests, searchPreview, searchPlace, runWikidataSearch, readContribs, readEntities, getJson, HEADERS, WikidataError, SEARCH_DEFAULTS } from '../src/engine/krisis/wikidata-search.js';
import { WIKIDATA_SERVICE, ENTITY, ALGORITHM, qualifying, searchState, matchItems, verifyItem } from '../src/engine/krisis/wikidata.js';
import { USER_AGENT } from '../src/engine/gazetteer/index.js';
import { guardOf } from '../src/engine/krisis/guards.js';

const X = 'https://example.org/';
const API = 'https://www.wikidata.org/w/api.php';
const subjects = { title: 'Dataset', files: [] };
const NEWSTEAD = { iri: `${X}place/newstead`, label: 'Newstead', names: ['Newstead', 'Novum Locum'], point: [-1.193, 53.081], ccodes: ['GB'], langs: { 'novum locum': 'la' }, identities: { linked: [], denied: [] } };
const NOWHERE = { iri: `${X}place/nowhere`, label: 'Nowhere', names: ['Nowhere'], point: null, identities: { linked: [], denied: [] } };
const NAMELESS = { iri: `${X}place/nameless`, label: `${X}place/nameless`, names: [], point: [0, 50], identities: { linked: [], denied: [] } };

/** An entity as wbgetentities gives it. */
const entity = (id, { label = 'Newstead', lang = 'en', point = [-1.19, 53.08], cls = 'Q532', country = 'Q145', aliases = [], desc = 'a village' } = {}) => ({
  id, type: 'item', labels: { [lang]: { language: lang, value: label } }, descriptions: { en: { language: 'en', value: desc } }, aliases: { en: aliases.map((value) => ({ language: 'en', value })) },
  claims: { P31: [{ mainsnak: { snaktype: 'value', property: 'P31', datavalue: { value: { id: cls }, type: 'wikibase-entityid' } } }],
    ...(point ? { P625: [{ mainsnak: { snaktype: 'value', property: 'P625', datavalue: { value: { latitude: point[1], longitude: point[0] }, type: 'globecoordinate' } } }] } : {}),
    ...(country ? { P17: [{ mainsnak: { snaktype: 'value', property: 'P17', datavalue: { value: { id: country }, type: 'wikibase-entityid' } } }] } : {}) } });
const ENTITIES = { Q11: entity('Q11'), Q12: entity('Q12', { label: 'Newstead Abbey', point: [-1.2, 53.07], cls: 'Q23413' }), Q13: entity('Q13', { label: 'Novum Locum', lang: 'la', point: [-1.195, 53.082], aliases: ['Newstead Priory'] }), Q14: entity('Q14', { label: 'Papplewick', point: [-1.18, 53.03] }) };
/** A fake api.php: wbsearchentities by name, CirrusSearch near a point, wbgetentities by ids; every call kept, in order, with when it began and ended. */
function fakeApi({ answers = { Newstead: ['Q11', 'Q12'], 'Novum Locum': ['Q13'] }, near = ['Q12', 'Q14'], fail = () => null, delay = 0 } = {}) {
  const calls = [];
  let inFlight = 0, overlap = 0;
  const fetch = async (url, init) => {
    const u = new URL(url), p = u.searchParams;
    const call = { url, init, action: p.get('action'), list: p.get('list'), search: p.get('search') ?? p.get('srsearch'), ids: p.get('ids') };
    calls.push(call);
    inFlight++; if (inFlight > 1) overlap++;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    inFlight--;
    const f = fail(call);
    if (f) return f;
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (call.action === 'wbsearchentities') return json({ search: (answers[call.search] || []).map((id) => ({ id, label: ENTITIES[id]?.labels?.en?.value ?? id })) });
    if (call.action === 'query' && call.list === 'search') return json({ query: { search: near.map((id) => ({ title: id, ns: 0 })) } });
    if (call.action === 'wbgetentities') return json({ entities: Object.fromEntries(call.ids.split('|').map((id) => [id, ENTITIES[id] || { id, missing: '' }])) });
    if (call.action === 'query' && call.list === 'usercontribs') return json({ query: { usercontribs: [{ title: 'Q11', timestamp: '2026-10-15T13:00:00Z', comment: 'Created a new Item' }, { title: 'Q14', timestamp: '2026-10-15T13:01:00Z', comment: '' }, { title: 'Talk:Q1', timestamp: '2026-10-15T13:02:00Z', comment: '' }] } });
    return new Response('{}', { status: 404 });
  };
  return { fetch, calls, overlap: () => overlap };
}

test('the requests one place makes: each name in its own language (the dataset\'s, else English), then items near the point; a place with no point has no near search, one with no name none at all', () => {
  const r = searchRequests(NEWSTEAD, { lang: 'cy' });
  assert.deepEqual(r.map((x) => [x.kind, x.text ?? x.km, x.lang ?? null]), [['name', 'Newstead', 'cy'], ['name', 'Novum Locum', 'la'], ['near', 5, null]]);
  assert.equal(r[0].url, `${API}?format=json&origin=*&action=wbsearchentities&search=Newstead&language=cy&type=item&limit=10`);
  assert.equal(r[2].url, `${API}?format=json&origin=*&action=query&list=search&srsearch=nearcoord%3A5km%2C53.081%2C-1.193+haswbstatement%3AP625&srnamespace=0&srlimit=10`);
  assert.equal(searchRequests(NEWSTEAD)[0].lang, 'en', 'no language given: English');
  assert.deepEqual(searchRequests(NOWHERE).map((x) => x.kind), ['name']);
  assert.deepEqual(searchRequests(NAMELESS), [], 'an address is not a name');
  assert.deepEqual(searchRequests(NEWSTEAD, { nearKm: 0 }).map((x) => x.kind), ['name', 'name'], 'near switched off');
  assert.deepEqual(searchPreview([NEWSTEAD, NOWHERE, NAMELESS], { lang: 'en-GB' }), { places: 2, withoutName: 1, names: 3, queries: 3, near: 1, requests: 6, nearKm: 5, lang: 'en' });
  assert.equal(SEARCH_DEFAULTS.nearKm, 5);
});

test('one place searched: the names and the near search in series, the entities fetched once, and the hits as candidates with their point, classes and country; a near hit says so', async () => {
  const api = fakeApi({ delay: 2 });
  const { lists, requests } = await searchPlace({ fetch: api.fetch, place: NEWSTEAD, options: { lang: 'en' } });
  assert.deepEqual(api.calls.map((c) => c.action + (c.list ? `:${c.list}` : '')), ['wbsearchentities', 'wbsearchentities', 'query:search', 'wbgetentities']);
  assert.equal(api.overlap(), 0, 'one request at a time');
  assert.ok(api.calls.every((c) => c.url.includes('origin=*') && c.init.headers['Api-User-Agent'] === USER_AGENT && c.init.method === 'GET'), 'anonymous, named');
  assert.deepEqual(api.calls[3].ids.split('|').sort(), ['Q11', 'Q12', 'Q13', 'Q14'], 'each id once, those found near too');
  assert.deepEqual(requests.map((r) => [r.kind, r.status]), [['name', 200], ['name', 200], ['near', 200], ['entities', 200]]);
  assert.equal(lists.length, 2);
  assert.deepEqual(lists[0].key, [NEWSTEAD.iri, 'Newstead']);
  assert.deepEqual(lists[0].map((c) => c.id), ['Q11', 'Q12', 'Q14'], 'the name\'s hits, then the one found near the point only');
  assert.deepEqual(lists[1].map((c) => c.id), ['Q13']);
  const q11 = lists[0][0];
  assert.deepEqual([q11.iri, q11.name, q11.coords, q11.ccodes, q11.types.map((t) => t.id), q11.namespace, q11.score, q11.match, q11.description], [`${ENTITY}Q11`, 'Newstead', [-1.19, 53.08], ['GB'], ['wikidata:Q532'], 'wd', null, false, 'a village']);
  assert.match(lists[0][2].description, /^found near the place's point/);
  assert.deepEqual(lists[1][0].altNames, ['Newstead Priory']);
  assert.ok(!lists[0].unanswered && !lists[1].unanswered);
});

test('a failed request leaves the place unanswered (never "no match"), a 429 stops the search, and an answer that is not JSON is a server failure', async () => {
  const broken = fakeApi({ fail: (c) => (c.search === 'Novum Locum' ? new Response('down', { status: 503 }) : null) });
  const r = await searchPlace({ fetch: broken.fetch, place: NEWSTEAD });
  assert.equal(r.lists[0].unanswered, undefined); assert.equal(r.lists[1].unanswered, true); assert.match(r.lists[1].error, /503/);
  assert.deepEqual(r.requests.map((x) => x.status), [200, 503, 200, 200]);
  await assert.rejects(getJson(fakeApi({ fail: () => new Response('', { status: 429 }) }).fetch, `${API}?x`), (e) => e instanceof WikidataError && e.kind === 'rate');
  await assert.rejects(getJson(async () => new Response('<html>', { status: 200 }), `${API}?x`), /not JSON/);
  await assert.rejects(getJson(async () => new Response(JSON.stringify({ error: { code: 'badvalue', info: 'bad' } }), { status: 200 }), `${API}?x`), /refused the request: bad/);
  await assert.rejects(getJson(async () => { throw new TypeError('fetch failed'); }, `${API}?x`), (e) => e instanceof WikidataError && e.kind === 'network');
  assert.deepEqual(Object.keys(HEADERS), ['Accept', 'Api-User-Agent']);
});

test('the search over a work file: a lookup of Wikidata recorded as any lookup\'s, its hits the places\' candidates, not-found and unanswered told apart, a failure in three places stopping it', async () => {
  const api = fakeApi();
  const work = newWork(subjects, { now: '2026-10-15T12:00:00Z' });
  const r = await runWikidataSearch({ fetch: api.fetch, work, places: [NEWSTEAD, NOWHERE, NAMELESS], options: { lang: 'en' }, now: () => '2026-10-15T12:00:01Z' });
  assert.equal(r.stopped, null);
  assert.deepEqual(r.record.service, WIKIDATA_SERVICE);
  assert.equal(r.record.algorithm_version, ALGORITHM);
  assert.deepEqual(r.record.parameters, { places: 'chosen', nearKm: 5, limit: 10, lang: 'en', maxDistanceKm: 50, allNames: true, countries: false, linksKnown: true });
  assert.deepEqual(Object.fromEntries(Object.entries(r.record.queries).map(([k, q]) => [k, q.state])), { [NEWSTEAD.iri]: 'answered', [NOWHERE.iri]: 'answered' }, 'the nameless place is not sent');
  assert.deepEqual(r.record.counts.withoutName, 1);
  assert.equal(searchState(work, NEWSTEAD.iri), 'answered');
  const cands = lookupCandidatesOf(work, NEWSTEAD.iri, r.record.id);
  // Ranked by distance, as any lookup's (lookup.js rankGazetteer): Q11 and Q13 both 0.2 km, then Q12 (1.3 km), then Q14 (5.8 km).
  assert.deepEqual(cands.slice(0, 2).map((c) => c.candidate_candidate).sort(), ['Q11', 'Q13'].map((q) => ENTITY + q));
  assert.deepEqual(cands.slice(2).map((c) => c.candidate_candidate), ['Q12', 'Q14'].map((q) => ENTITY + q));
  assert.ok(cands.every((c) => c.lookup === r.record.id && c.algorithm_version === ALGORITHM && c.gazetteer.namespace === 'wd' && c.gazetteer.match === false && c.gazetteer.score === null), 'this search\'s, with no score and no exact match');
  assert.equal(r.record.counts.queries, 3, 'Newstead\'s two names and Nowhere\'s one');
  assert.ok(cands.every((c) => guardOf(c).pass === false && ['weak', 'not-top'].includes(guardOf(c).reason)), 'never bulk-accepted (guards.js): the reviewer decides each');
  assert.deepEqual(cands.map((c) => c.other.types), [['wikidata:Q532'], ['wikidata:Q532'], ['wikidata:Q23413'], ['wikidata:Q532']]);
  assert.equal(lookupCandidatesOf(work, NOWHERE.iri).length, 0, 'nothing found: no candidates, and the place answered');
  assert.equal(r.record.counts.notFound, 1);
  assert.deepEqual(readWork(serialiseWork(work)), work, 'the work file reads back');
  // The licence of a hit's source, as the review shows one: CC0.
  assert.equal(r.record.attribution.sources.wd.license.spdx_id, 'CC0-1.0');
  // A place whose search failed is unanswered; three in a row stop the rest.
  const down = fakeApi({ fail: () => new Response('down', { status: 502 }) });
  const w2 = newWork(subjects, { now: '2026-10-15T12:00:00Z' });
  const many = [1, 2, 3, 4, 5].map((i) => ({ ...NOWHERE, iri: `${X}place/p${i}`, label: `Place ${i}`, names: [`Place ${i}`] }));
  const r2 = await runWikidataSearch({ fetch: down.fetch, work: w2, places: many });
  assert.deepEqual(Object.values(r2.record.queries).map((q) => q.state), ['unanswered', 'unanswered', 'unanswered', 'stopped', 'stopped']);
  assert.equal(r2.stopped.kind, 'server');
  assert.equal(down.calls.length, 3);
  assert.equal(searchState(w2, `${X}place/p1`), 'unanswered');
  assert.deepEqual(qualifying(w2, many).leftOut.unanswered.length, 5, 'unanswered, and stopped before it was asked, are not "no match": none qualifies');
  // Stopped by the caller: the rest stopped, what was answered kept.
  const ctl = new AbortController();
  const slow = fakeApi({ delay: 1 });
  const w3 = newWork(subjects, { now: '2026-10-15T12:00:00Z' });
  const r3 = await runWikidataSearch({ fetch: slow.fetch, work: w3, places: many, signal: ctl.signal, onBatch: ({ done }) => { if (done === 2) ctl.abort(); } });
  assert.equal(r3.stopped.kind, 'stopped');
  assert.deepEqual(Object.values(r3.record.queries).map((q) => q.state), ['answered', 'answered', 'stopped', 'stopped', 'stopped']);
  // The search needs a work file: it adds to a review, never begins one by itself.
  await assert.rejects(runWikidataSearch({ fetch: api.fetch, work: null, places: many }), /needs a work file/);
});

test("the user's new items and the entities read back, matched to the batch by the reference each carries", async () => {
  const api = fakeApi();
  const c = await readContribs({ fetch: api.fetch, user: 'Lu Reviewer', since: '2026-10-15T12:00:00Z' });
  assert.deepEqual(c.items.map((x) => x.qid), ['Q11', 'Q14'], 'items only (not a talk page)');
  const u = new URL(c.requests[0]);
  assert.deepEqual([u.searchParams.get('ucuser'), u.searchParams.get('ucshow'), u.searchParams.get('ucnamespace'), u.searchParams.get('ucstart'), u.searchParams.get('ucdir'), u.searchParams.get('origin')], ['Lu Reviewer', 'new', '0', '2026-10-15T12:00:00Z', 'newer', '*']);
  await assert.rejects(readContribs({ fetch: api.fetch, user: 'lu@example.org', since: '2026-10-15T12:00:00Z' }), /never an address/);
  await assert.rejects(readContribs({ fetch: api.fetch, user: 'Lu', since: 'yesterday' }), /ISO date-time/);
  const e = await readEntities({ fetch: api.fetch, ids: ['Q11', 'Q14', 'Q11', 'nonsense'] });
  assert.deepEqual(Object.keys(e.entities), ['Q11', 'Q14']);
  assert.equal(e.requests.length, 1);
  // Matched to a batch: Q11 carries no reference to the batch's place in this fixture, so nothing is matched (the presence: an entity with the reference is).
  const items = [{ iri: NEWSTEAD.iri, labels: { en: 'Newstead' }, point: NEWSTEAD.point }];
  assert.deepEqual(matchItems(e.entities, items).matched, []);
  const withRef = { Q11: { ...ENTITIES.Q11, claims: { ...ENTITIES.Q11.claims, P31: [{ ...ENTITIES.Q11.claims.P31[0], references: [{ snaks: { P854: [{ datavalue: { value: NEWSTEAD.iri } }] } }] }] } } };
  const m = matchItems(withRef, items);
  assert.deepEqual(m.matched.map((x) => [x.qid, x.iri, x.verified.ok, x.verified.near]), [['Q11', NEWSTEAD.iri, true, true]]);
  assert.equal(verifyItem(withRef.Q11, items[0]).distanceKm < 1, true);
});

// ---- under the permissions module: nothing is sent while Wikidata is not allowed ----------------------------
class Store {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const WD = 'https://www.wikidata.org';
const inPolicy = (...origins) => { globalThis.__platoCsp = { policy: core.policyFor(origins), origins }; };
let sent, api;
beforeEach(() => {
  globalThis.localStorage = new Store(); globalThis.sessionStorage = new Store();
  inPolicy(); sent = [];
  api = fakeApi();
  permissions.resetForTests();
  permissions.configure({ fetch: async (url, init) => { sent.push(url); return api.fetch(url, init); }, enforced: async () => true });
});
/** The search as the page makes it: through permittedFetch over permissions.fetch, whose refusal stops it. */
async function search() {
  const ctl = new AbortController();
  const fetch = permittedFetch(permissions.fetch, (e) => ctl.abort(e));
  const work = newWork(subjects, { now: '2026-10-15T12:00:00Z' });
  return runWikidataSearch({ fetch, work, places: [NEWSTEAD, NOWHERE], signal: ctl.signal });
}
test('Wikidata is a permission of its own (gazetteer:wikidata), the one its API address is asked under', () => {
  assert.equal(gazetteerPermission(WIKIDATA_SERVICE.endpoint), 'wikidata');
  assert.equal(gazetteerPermission('https://www.wikidata.org/w/api.php?action=wbsearchentities'), 'wikidata');
  assert.equal(gazetteerPermission('https://wikidata.org/w/api.php'), 'wikidata');
  assert.equal(gazetteerPermission('http://www.wikidata.org/w/api.php'), 'http://www.wikidata.org', 'over plain http it is no known service, and the module refuses the site as insecure');
  assert.equal(core.isInsecure(gazetteerPermission('http://www.wikidata.org/w/api.php')), true);
  assert.equal(gazetteerPermission('https://wikidata-reconciliation.wmcloud.org/en/api'), 'https://wikidata-reconciliation.wmcloud.org', 'another service is its site');
  assert.deepEqual(core.parse('gazetteer', 'wikidata'), { cat: 'gazetteer', subj: 'wikidata' });
  assert.deepEqual(core.originsFor('gazetteer', 'wikidata'), [WD]);
  assert.equal(permissions.nameOf('gazetteer', 'wikidata'), 'Wikidata');
  assert.deepEqual(core.fromFlags({ allowHost: ['wikidata'] }).grants, { 'gazetteer:wikidata': { state: 'allowed' } }, 'the command line\'s consent');
});
test('not decided: nothing is sent and the search stops in words; allowed and in the policy, the same search sends, through permissions.fetch (no cookies, no redirect followed)', async () => {
  inPolicy(WD);
  const r = await search();
  assert.equal(sent.length, 0, 'nothing sent');
  assert.deepEqual(r.stopped, { kind: 'permission', refused: 'undecided', status: null, message: null });
  assert.deepEqual(Object.values(r.record.queries).map((q) => q.state), ['stopped', 'stopped']);
  permissions.set('gazetteer', 'wikidata', 'allowed');
  const ok = await search();
  assert.equal(ok.stopped, null, 'control: allowed, it runs');
  assert.ok(sent.length >= 4 && sent.every((u) => u.startsWith(`${WD}/w/api.php?`)), sent);
  assert.ok(api.calls.every((c) => c.init.credentials === 'omit' && c.init.redirect === 'manual'));
  assert.deepEqual(Object.values(ok.record.queries).map((q) => q.state), ['answered', 'answered']);
});
test('Never, allowed since the page loaded, and a redirect each stop it with nothing used', async () => {
  permissions.set('gazetteer', 'wikidata', 'never'); inPolicy(WD);
  const never = await search();
  permissions.set('gazetteer', 'wikidata', 'allowed'); inPolicy();
  const reload = await search();
  assert.equal(sent.length, 0);
  assert.deepEqual([never.stopped.refused, reload.stopped.refused], ['never', 'reload']);
  inPolicy(WD);
  api = { ...api, fetch: async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } }) };
  const moved = await search();
  assert.equal(moved.stopped.refused, 'moved');
  assert.equal(sent.length, 1, 'one request, its answer not used');
});
