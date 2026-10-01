// The gazetteer lookup (src/engine/gazetteer/): W3C reconciliation against a service that is stood
// in for by a fake fetch, which records every request and how many were in flight at once. Nothing
// here reaches the network.
//
// Each check that something does NOT happen (a second request in flight, the token in an address or
// a message) also asserts in the same test that the thing looked for is there to be seen: the
// concurrency check is run against two separate lookups too, where it must find two in flight, and
// the token check finds the token in the Authorization header before it looks everywhere else.
//
// Most checks use `lookup()`, a PRIVATE instance with no cross-tab lock (`shared: false, locks: null`),
// so that no check inherits a queue, a token or a lock from another. The checks of sharing and of
// locks say so, use endpoints of their own, and each carries a control where overlap is allowed.
// Pacing across tabs is checked with a fake shared ledger (and with fake-indexeddb for the default
// one), against a control of two tabs with a ledger each, which the same measure sees cross 600.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLookup, createPacer, GazetteerError, WHG_ENDPOINT, BLOCKED_AGENTS, USER_AGENT, whgIri, normaliseWhgIri, parseCentroid, parseGeojsonValues,
} from '../src/engine/gazetteer/index.js';
// Names added later are read from the namespace, so that a missing one fails its own check only.
import * as gz from '../src/engine/gazetteer/index.js';
import { IDBFactory } from 'fake-indexeddb';

const TOKEN = 'tok-5ecret-9f8e7d';

/** A private lookup, with no cross-tab lock: what every check not about sharing uses. */
const lookup = (o) => createLookup({ shared: false, locks: null, ...o });

/** A JSON response, as fetch gives it. */
const reply = (status, json, headers = {}) =>
  new Response(typeof json === 'string' ? json : JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/**
 * A stand-in for the service. `answer(sent, call)` gives the Response for each request (default: one
 * candidate per query, named after the query). Each request waits `delay` ms, or until its signal
 * aborts, as a real fetch would.
 */
function service({ answer, delay = 2 } = {}) {
  const calls = [];
  let inFlight = 0, maxInFlight = 0;
  const fetch = async (url, init = {}) => {
    const call = { url: String(url), init, headers: init.headers, sent: readBody(init) };
    calls.push(call);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve, reject) => {
        if (init.signal?.aborted) return reject(init.signal.reason);
        const t = setTimeout(resolve, delay);
        init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(init.signal.reason); }, { once: true });
      });
      return (answer ?? echo)(call.sent, call);
    } finally { inFlight--; }
  };
  return { fetch, calls, get maxInFlight() { return maxInFlight; } };
}
function readBody(init) {
  if (init.body instanceof URLSearchParams) {
    const out = {};
    for (const [k, v] of init.body) out[k] = JSON.parse(v);
    return out;
  }
  return init.body == null ? null : JSON.parse(init.body);
}
/** One candidate per query, whose name is the query: shows which answer went back to which query. */
function echo(sent, call) {
  if (!sent) return reply(200, { type: 'Feature', '@id': call.url, properties: {}, geometry: null });
  if (sent.extend) return reply(200, { meta: [], rows: Object.fromEntries(sent.extend.ids.map((id) => [id, {}])) });
  const out = { attribution: { sources: {} } };
  for (const [k, q] of Object.entries(sent.queries)) {
    out[k] = { result: [{ id: 'place:gn:' + q.query, name: q.query, score: 100, match: true, description: 'Country: GB', ccodes: ['GB'], repr_point: [-1, 52] }] };
  }
  return reply(200, out);
}
const noSleep = () => Promise.resolve();
const PLACE = 'https://whgazetteer.org/static/whg_schema.jsonld#Place', PERIOD = 'https://whgazetteer.org/static/whg_schema.jsonld#Period';
const names = (n, prefix = 'n') => Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}`, query: `${prefix}${i}` }));

test('a batch is POSTed as W3C queries q0…qN, JSON, with the token in the Authorization header only', async () => {
  const s = service();
  const look = lookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch });
  await look.reconcile([
    { key: 'a', query: 'London', type: 'https://whgazetteer.org/static/whg_schema.jsonld#Place', limit: 3, properties: [{ pid: 'whg:countries_codes', v: 'GB' }] },
    { key: 'b', query: 'Rome', type: 'https://whgazetteer.org/static/whg_schema.jsonld#Place', params: { contained_in: ['un:ita'] } },
  ]);
  assert.equal(s.calls.length, 1);
  const [c] = s.calls;
  assert.equal(c.url, WHG_ENDPOINT);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.headers['Content-Type'], 'application/json');
  assert.equal(c.headers.Authorization, 'Bearer ' + TOKEN);
  assert.match(c.headers['User-Agent'], /^plato-tools\//);
  // WHG is sent the short form of a type, whichever form it was given in.
  assert.deepEqual(c.sent, { queries: {
    q0: { query: 'London', type: 'Place', limit: 3, properties: [{ pid: 'whg:countries_codes', v: 'GB' }] },
    q1: { contained_in: ['un:ita'], query: 'Rome', type: 'Place', limit: 10 },
  } });
});

test("encoding 'form' sends queries= as the W3C protocol and OpenRefine do", async () => {
  const s = service();
  const look = lookup({ endpoint: 'https://example.org/reconcile', token: TOKEN, fetch: s.fetch, encoding: 'form' });
  await look.reconcile([{ query: 'Paris' }]);
  assert.ok(s.calls[0].init.body instanceof URLSearchParams);
  assert.equal(s.calls[0].headers['Content-Type'], undefined, 'fetch sets the form type itself');
  assert.deepEqual(s.calls[0].sent, { queries: { q0: { query: 'Paris', limit: 10 } } });
});

test('answers go back to the queries in input order, each list with its key, and candidates read as WHG gives them', async () => {
  const s = service({ answer: () => reply(200, {
    // Keys out of order, the root's attribution beside them, and candidates of several shapes.
    attribution: { sources: { gn: {} } },
    q1: { result: [], namespaces_searched: ['gn'] },
    q0: { result: [
      { id: 'place:gn:2643743', name: 'London', score: 100, match: true, description: 'Country: GB', ccodes: ['gb'], repr_point: [-0.1257, 51.5085],
        type: [{ id: 'https://whgazetteer.org/static/whg_schema.jsonld#Place', name: 'Place' }], confidence: 100,
        namespace: 'gn', alt_names: ['Londinium', { toponym: 'Londres' }, 7], has_geom: false, wikipedia: ['x'] },
      { id: 'place:osm:r65606', name: 'London', score: '87.5', description: 'Country: GB, IE', repr_point: null, has_geom: true },
      { id: 'place:tgn:7011781', name: 'London', description: 'Country: ', ccodes: [], repr_point: [200, 10] },
      'not a candidate', { name: 'no id' },
    ] },
  }) });
  const look = lookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch });
  const [london, nowhere] = await look.reconcile([{ key: 'rec-1', query: 'London' }, { key: 'rec-2', query: 'Xyzzy' }]);
  assert.equal(london.key, 'rec-1');
  assert.equal(nowhere.key, 'rec-2');
  assert.equal(nowhere.length, 0);
  assert.equal(nowhere.unanswered, undefined, 'an ordinary empty result is an answer');
  assert.equal(london.length, 3);
  const [a, b, c] = london;
  assert.deepEqual({ ...a, raw: undefined }, {
    id: 'place:gn:2643743', iri: 'https://w3id.org/whg/id/place:gn:2643743', name: 'London', description: 'Country: GB', score: 100,
    match: true, confidence: 100, namespace: 'gn', altNames: ['Londinium', 'Londres'], hasGeom: false,
    types: [{ id: 'https://whgazetteer.org/static/whg_schema.jsonld#Place', name: 'Place' }], coords: [-0.1257, 51.5085], ccodes: ['GB'], raw: undefined,
  });
  assert.equal(a.raw.wikipedia[0], 'x', 'raw keeps what the service sent');
  assert.equal(b.confidence, null, 'absent is not measured, not 0');
  assert.equal(b.namespace, 'osm', 'from the id when the candidate does not say');
  assert.equal(b.hasGeom, true);
  assert.deepEqual(b.altNames, []);
  assert.equal(b.score, 87.5);
  assert.equal(b.match, false);
  assert.deepEqual(b.ccodes, ['GB', 'IE'], 'from the description when ccodes is absent');
  assert.equal(b.coords, null);
  assert.equal(c.ccodes, null, 'none given is null, not []');
  assert.equal(c.coords, null, 'a longitude of 200 is not a place');
  assert.equal(c.score, null);
});

test('a query the service could not search for is marked unanswered, not taken for no match', async () => {
  const s = service({ answer: () => reply(200, {
    q0: { result: [], gateway: { answered: false, error: 'timeout' } },
    q1: { result: [], scope: { applied: false, containers_unresolved: ['tgn:1'] } },
    // q2 left out altogether
  }) });
  const look = lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch });
  const [timedOut, scoped, missing] = await look.reconcile([{ query: 'a' }, { query: 'b' }, { query: 'c' }]);
  assert.equal(timedOut.unanswered, true);
  assert.equal(scoped.unanswered, undefined);
  assert.equal(scoped.scope.applied, false);
  assert.equal(missing.unanswered, true);
  assert.equal(missing.key, null);
});

test('120 queries in batches of 50 are three POSTs of 50, 50 and 20, answered in order, with progress', async () => {
  const s = service();
  const look = lookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch, batchSize: 50 });
  const progress = [];
  const qs = names(120);
  const out = await look.reconcile(qs, { onProgress: (p) => progress.push(p) });
  assert.deepEqual(s.calls.map((c) => Object.keys(c.sent.queries).length), [50, 50, 20]);
  assert.deepEqual(Object.keys(s.calls[2].sent.queries), Array.from({ length: 20 }, (_, i) => 'q' + i));
  assert.equal(out.length, 120);
  out.forEach((list, i) => {
    assert.equal(list.key, qs[i].key);
    assert.equal(list[0].name, qs[i].query, `query ${i} got its own answer`);
  });
  assert.deepEqual(progress, [{ done: 50, total: 120 }, { done: 100, total: 120 }, { done: 120, total: 120 }]);
});

test('batch size is 25 by default and held between 1 and 50', () => {
  const f = service().fetch;
  const at = (batchSize) => lookup({ endpoint: WHG_ENDPOINT, fetch: f, batchSize }).batchSize;
  assert.equal(at(undefined), 25);
  assert.equal(at(500), 50);
  assert.equal(at(0), 1);
  assert.equal(at(-3), 1);
  assert.equal(at(12.7), 12);
  assert.equal(at('x'), 25);
});

test('no queries, no request', async () => {
  const s = service();
  const look = lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch });
  const out = await look.reconcile([]);
  assert.equal(out.length, 0);
  assert.equal(s.calls.length, 0);
});

test('one request in flight at a time across all callers of a lookup (and two lookups do overlap)', async () => {
  const shared = service({ delay: 5 });
  const look = lookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: shared.fetch, batchSize: 10 });
  const [x, y, z] = await Promise.all([look.reconcile(names(30, 'x')), look.reconcile(names(25, 'y')), look.extend(['place:gn:1'], ['whg:countries_codes'])]);
  assert.equal(shared.calls.length, 3 + 3 + 1);
  assert.equal(shared.maxInFlight, 1);
  assert.equal(x[29][0].name, 'x29');
  assert.equal(y[24][0].name, 'y24');
  // The callers take turns: the second caller's first batch is not left until the first has finished.
  const order = shared.calls.map((c) => (c.sent.queries ? Object.values(c.sent.queries)[0].query[0] : 'e'));
  assert.ok(order.indexOf('y') < order.lastIndexOf('x'), `turns taken: ${order.join('')}`);
  assert.deepEqual(z.rows, { 'place:gn:1': {} });

  // The same measure, where overlap is allowed, must see it: otherwise the 1 above proves nothing.
  const apart = service({ delay: 5 });
  const one = lookup({ endpoint: WHG_ENDPOINT, fetch: apart.fetch });
  const two = lookup({ endpoint: WHG_ENDPOINT, fetch: apart.fetch });
  await Promise.all([one.reconcile(names(3)), two.reconcile(names(3))]);
  assert.equal(apart.maxInFlight, 2);
});

test('429 waits as long as Retry-After says, capped, then carries on', async () => {
  let n = 0;
  const s = service({ answer: (sent) => (++n <= 2 ? reply(429, { detail: 'slow down' }, { 'Retry-After': n === 1 ? '7' : '3600' }) : echo(sent)) });
  const waits = [];
  const look = lookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch, sleep: async (ms) => { waits.push(ms); } });
  const [r] = await look.reconcile([{ query: 'Oxford' }]);
  assert.equal(r[0].name, 'Oxford');
  assert.equal(s.calls.length, 3);
  assert.deepEqual(waits, [7000, 60000], 'seven seconds as asked; an hour capped at a minute');
});

test('429 without Retry-After, and 503, back off growing; retries are limited', async () => {
  const s = service({ answer: (_, call) => reply(s.calls.indexOf(call) % 2 ? 503 : 429, {}) });
  const waits = [];
  const look = lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, maxRetries: 3, sleep: async (ms) => { waits.push(ms); } });
  const err = await look.reconcile([{ query: 'a' }]).then(() => null, (e) => e);
  assert.ok(err instanceof GazetteerError);
  assert.equal(err.kind, 'server', 'the last answer was 503');
  assert.equal(err.status, 503);
  assert.equal(s.calls.length, 4);
  assert.equal(waits.length, 3);
  // 429 starts at 4 s (WHG's window is a minute), 503 at 1 s; each doubles with the attempt.
  assert.ok(waits[0] >= 3000 && waits[0] <= 4000 && waits[1] >= 1500 && waits[1] <= 2000 && waits[2] >= 12000 && waits[2] <= 16000, `backoff: ${waits}`);

  const always = service({ answer: () => reply(429, {}, { 'Retry-After': '1' }) });
  const e2 = await lookup({ endpoint: WHG_ENDPOINT, fetch: always.fetch, maxRetries: 2, sleep: noSleep }).reconcile([{ query: 'a' }]).catch((e) => e);
  assert.equal(e2.kind, 'rate');
  assert.equal(e2.status, 429);
  assert.equal(always.calls.length, 3);
});

test('401 and 403 are refused at once, as kind auth, with what the service said', async () => {
  for (const status of [401, 403]) {
    const s = service({ answer: () => reply(status, { detail: 'Invalid token. Token login failed.' }) });
    let slept = 0;
    const look = lookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch, sleep: async () => { slept++; } });
    const err = await look.reconcile([{ query: 'a' }]).catch((e) => e);
    assert.ok(err instanceof GazetteerError, String(err));
    assert.equal(err.kind, 'auth');
    assert.equal(err.status, status);
    assert.match(err.message, /Invalid token/);
    assert.equal(s.calls.length, 1, 'not asked again');
    assert.equal(slept, 0);
  }
});

test('the token is in the Authorization header and nowhere else: not the address, nor any error', async () => {
  // Every way of failing, each answering with the token in what it says back.
  const failures = [
    () => reply(401, { detail: `Invalid token ${TOKEN}` }),
    () => reply(400, `bad request for ?token=${TOKEN}`),
    () => reply(429, { detail: TOKEN }),
    () => reply(500, { error: { token: TOKEN } }),
    () => { throw new TypeError(`fetch failed: connect ECONNREFUSED ?token=${TOKEN}`); },
    () => reply(200, `<html>${TOKEN}`),
  ];
  for (const fail of failures) {
    const s = service({ answer: fail });
    const look = lookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch, maxRetries: 1, sleep: noSleep });
    const err = await look.reconcile([{ query: 'a' }]).catch((e) => e);
    assert.ok(err instanceof GazetteerError, String(err));
    // Present where it belongs, so that looking for it elsewhere can find it.
    assert.equal(s.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    for (const c of s.calls) {
      assert.ok(!c.url.includes(TOKEN), 'not in the address');
      assert.ok(!JSON.stringify(c.sent).includes(TOKEN), 'not in the body');
    }
    const seen = [err.message, String(err), err.stack, JSON.stringify(err), JSON.stringify(Object.getOwnPropertyDescriptors(err)), String(err.cause ?? '')].join('\n');
    assert.ok(!seen.includes(TOKEN), `leaked by ${err.kind} ${err.status}: ${err.message}`);
    assert.deepEqual(Object.keys(err).sort(), ['kind', 'name', 'status']);
  }
  // Nor on the lookup itself.
  const look = lookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: service().fetch });
  assert.ok(!JSON.stringify(look).includes(TOKEN) && !Object.values(look).some((v) => String(v).includes(TOKEN)));
});

test('no answer at all is tried again, then reported as kind network', async () => {
  const s = service({ answer: () => { throw new TypeError('fetch failed'); } });
  const look = lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, maxRetries: 2, sleep: noSleep });
  const err = await look.reconcile([{ query: 'a' }]).catch((e) => e);
  assert.equal(err.kind, 'network');
  assert.equal(err.status, null);
  assert.equal(s.calls.length, 3);
});

// A lookup that loses a waiting job would leave its caller waiting for ever: the timeout makes that a failure.
test('an AbortSignal stops the request in flight, and a caller\'s batches still waiting', { timeout: 5000 }, async () => {
  // In flight: the request is cancelled and the lookup rejects with the signal's reason.
  const slow = service({ delay: 10_000 });
  const look = lookup({ endpoint: WHG_ENDPOINT, fetch: slow.fetch });
  const ac = new AbortController();
  const pending = look.reconcile(names(3), { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(slow.calls.length, 1);
  assert.equal(slow.calls[0].init.signal.aborted, false);
  ac.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  // fetch is given a signal of its own (the caller's, or the timeout), which the caller's abort reaches.
  assert.equal(slow.calls[0].init.signal.aborted, true, "the caller's abort reached fetch");

  // Queued: B waits behind A; B is aborted; A finishes; B's request is never sent.
  let release;
  const gate = new Promise((r) => { release = r; });
  const gated = service({ delay: 0, answer: async (sent) => { await gate; return echo(sent); } });
  const shared = lookup({ endpoint: WHG_ENDPOINT, fetch: gated.fetch });
  const b = new AbortController();
  const aDone = shared.reconcile([{ query: 'A' }]);
  const bDone = shared.reconcile([{ query: 'B' }], { signal: b.signal });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(gated.calls.length, 1, 'B is waiting its turn');
  b.abort();
  await assert.rejects(bDone, { name: 'AbortError' });
  release();
  assert.equal((await aDone)[0][0].name, 'A');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(gated.calls.length, 1, 'B was never sent');
  // And the queue still works afterwards.
  assert.equal((await shared.reconcile([{ query: 'C' }]))[0][0].name, 'C');

  // Already aborted: nothing is sent.
  const none = service();
  await assert.rejects(lookup({ endpoint: WHG_ENDPOINT, fetch: none.fetch }).reconcile([{ query: 'x' }], { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(none.calls.length, 0);
});

test('an AbortSignal stops a pause between tries', { timeout: 5000 }, async () => {
  const s = service({ answer: () => reply(429, {}, { 'Retry-After': '30' }) });
  const look = lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch }); // the real sleep
  const ac = new AbortController();
  const started = Date.now();
  const p = look.reconcile([{ query: 'a' }], { signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, { name: 'AbortError' });
  assert.ok(Date.now() - started < 5000, 'did not wait out the 30 seconds');
  assert.equal(s.calls.length, 1);
});

test('extend asks for properties of chosen ids and decodes the values', async () => {
  const s = service({ answer: (sent) => reply(200, {
    meta: [{ id: 'whg:geometry_centroid', name: 'whg:geometry_centroid' }, { id: 'whg:countries_codes', name: 'whg:countries_codes' }],
    rows: Object.fromEntries(sent.extend.ids.map((id) => [id, {
      'whg:geometry_centroid': [{ str: '51.5085, -0.1257' }],
      'whg:countries_codes': [{ str: 'GB' }, { str: 'IE' }],
      'whg:geometry_geojson': [{ str: JSON.stringify([{ type: 'Point', coordinates: [-0.1257, 51.5085] }, { type: 'Nonsense' }]) }],
      other: [{ float: 1.5 }, { id: 'x', name: 'X' }, { bool: false }],
    }])),
  }) });
  const look = lookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch, batchSize: 2 });
  const out = await look.extend(['place:gn:1', 'place:gn:2', 'place:osm:r3'], ['whg:geometry_centroid', { id: 'whg:countries_codes' }]);
  assert.deepEqual(s.calls.map((c) => c.sent), [
    { extend: { ids: ['place:gn:1', 'place:gn:2'], properties: [{ id: 'whg:geometry_centroid' }, { id: 'whg:countries_codes' }] } },
    { extend: { ids: ['place:osm:r3'], properties: [{ id: 'whg:geometry_centroid' }, { id: 'whg:countries_codes' }] } },
  ]);
  assert.equal(out.meta.length, 2);
  assert.deepEqual(Object.keys(out.rows), ['place:gn:1', 'place:gn:2', 'place:osm:r3']);
  const row = out.rows['place:osm:r3'];
  assert.deepEqual(row['whg:countries_codes'], ['GB', 'IE']);
  assert.deepEqual(parseCentroid(row['whg:geometry_centroid'][0]), [-0.1257, 51.5085], 'latitude first in, longitude first out');
  assert.deepEqual(parseGeojsonValues(row['whg:geometry_geojson']), [{ type: 'Point', coordinates: [-0.1257, 51.5085] }]);
  assert.deepEqual(row.other, [1.5, { id: 'x', name: 'X' }, false]);
});

test('WHG helpers: addresses and centroids', () => {
  assert.equal(whgIri('place:169687'), 'https://w3id.org/whg/id/place:169687');
  assert.equal(whgIri('London'), null);
  assert.equal(parseCentroid('91, 0'), null);
  assert.equal(parseCentroid('not a point'), null);
  assert.deepEqual(parseCentroid(' -33.9 , 151.2 '), [151.2, -33.9]);
  // Another service's ids are kept as addresses only when they are addresses.
  const other = lookup({ endpoint: 'https://example.org/reconcile', fetch: service().fetch });
  return other.reconcile([{ query: 'x' }]).then(([r]) => assert.equal(r[0].iri, null));
});

// ---- Verified WHG behaviour (whg.js A1 to A11) ----

/** The Response a page sees across origins: WHG's CORS exposes only Content-Length and Content-Range (A6). */
async function corsFiltered(res) {
  const headers = new Headers();
  for (const k of ['Content-Length', 'Content-Range']) if (res.headers.has(k)) headers.set(k, res.headers.get(k));
  return new Response(await res.text(), { status: res.status, headers });
}
/** A clock that moves only when the lookup sleeps. */
function fakeTime() {
  const t = { now: 0, slept: [] };
  t.clock = () => t.now;
  t.sleep = async (ms) => { t.slept.push(ms); t.now += ms; };
  return t;
}
/** The most queries sent in any 60 seconds, from calls stamped with the fake clock. */
function busiestMinute(calls) {
  let most = 0;
  for (const a of calls) {
    const n = calls.filter((b) => b.t >= a.t && b.t < a.t + 60_000).reduce((sum, b) => sum + Object.keys(b.sent.queries).length, 0);
    most = Math.max(most, n);
  }
  return most;
}

test('a query refused inside a 200 has .error and is unanswered, not an empty match', async () => {
  const s = service({ answer: () => reply(200, { q0: { error: 'end must be greater than or equal to start', result: [] }, q1: { result: [] } }) });
  const [refused, none] = await lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch }).reconcile([{ query: 'a', params: { start: 5, end: 1 } }, { query: 'b' }]);
  assert.equal(refused.error, 'end must be greater than or equal to start');
  assert.equal(refused.unanswered, true);
  assert.equal(none.error, undefined);
  assert.equal(none.unanswered, undefined, 'an ordinary empty result is an answer');
});

test('Retry-After is honoured where it can be read (503 too), and a page, which cannot read it, backs off', async () => {
  for (const [filtered, expect] of [[false, (w) => w === 7000], [true, (w) => w >= 3000 && w <= 4000]]) {
    let n = 0;
    const s = service({ answer: async (sent) => {
      if (++n > 1) return echo(sent);
      const r = reply(429, {}, { 'Retry-After': '7', 'Content-Length': '2' });
      return filtered ? corsFiltered(r) : r;
    } });
    const waits = [];
    await lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, sleep: async (ms) => { waits.push(ms); } }).reconcile([{ query: 'a' }]);
    assert.equal(waits.length, 1);
    assert.ok(expect(waits[0]), `${filtered ? 'filtered' : 'readable'}: waited ${waits[0]}`);
  }
});

test('the pacer: never more than 600 queries in any 60 seconds, across batches and callers', async () => {
  const t = fakeTime();
  const paced = service({ delay: 0 });
  const stamp = (svc) => async (url, init) => { const r = svc.fetch(url, init); svc.calls.at(-1).t = t.now; return r; };
  const look = lookup({ endpoint: WHG_ENDPOINT, fetch: stamp(paced), batchSize: 50, now: t.clock, sleep: t.sleep });
  const [a, b] = await Promise.all([look.reconcile(names(1000, 'a')), look.reconcile(names(300, 'b'))]);
  assert.equal(a[999][0].name, 'a999');
  assert.equal(b[299][0].name, 'b299');
  assert.equal(paced.calls.length, 26);
  assert.ok(busiestMinute(paced.calls) <= 600, `busiest minute: ${busiestMinute(paced.calls)}`);
  assert.ok(t.now >= 120_000, `1,300 queries take at least two full minutes; took ${t.now} ms`);

  // Without the pacer the same measure sees the limit crossed: the check above can fail.
  const t2 = fakeTime();
  const unpaced = service({ delay: 0 });
  const free = lookup({ endpoint: WHG_ENDPOINT, fetch: (u, i) => { const r = unpaced.fetch(u, i); unpaced.calls.at(-1).t = t2.now; return r; }, batchSize: 50, queryRate: null, now: t2.clock, sleep: t2.sleep });
  await free.reconcile(names(1300));
  assert.equal(busiestMinute(unpaced.calls), 1300);
});

test('createPacer waits exactly until enough of the oldest have left the window', async () => {
  const t = fakeTime();
  const p = createPacer({ limit: 5, windowMs: 1000, now: t.clock, sleep: t.sleep });
  await p.take(3); t.now = 400; await p.take(2);
  assert.deepEqual(t.slept, []);
  await p.take(1);
  assert.deepEqual(t.slept, [600], 'until the first 3 are a second old');
  await p.take(3);
  assert.deepEqual(t.slept, [600, 400], 'then until the 2 taken at 400 ms have gone too');
  await assert.rejects(p.take(6), RangeError);
});

test("a spent day's allowance is kind quota, told from a refused token by what WHG says", async () => {
  for (const [said, kind] of [['Daily API limit (5000 calls) exceeded', 'quota'], ['Invalid token.', 'auth']]) {
    const s = service({ answer: () => reply(401, { detail: said }) });
    const err = await lookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch, sleep: noSleep }).reconcile([{ query: 'a' }]).catch((e) => e);
    assert.ok(err instanceof GazetteerError, String(err));
    assert.equal(err.kind, kind, said);
    assert.equal(err.status, 401);
    assert.equal(s.calls.length, 1, 'not asked again');
  }
});

test('a query without a limit asks for 10 candidates, not WHG\'s 100; one with a limit keeps it', async () => {
  const s = service();
  await lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch }).reconcile([{ query: 'a' }, { query: 'b', limit: 3 }]);
  assert.deepEqual(Object.values(s.calls[0].sent.queries).map((q) => q.limit), [10, 3]);
  const s2 = service();
  await lookup({ endpoint: WHG_ENDPOINT, fetch: s2.fetch, defaultLimit: 500 }).reconcile([{ query: 'a' }]);
  assert.equal(s2.calls[0].sent.queries.q0.limit, 50, 'a default is never above 50');
});

test('a batch holds queries of one type only, and the answers still come back in input order', async () => {
  // As WHG does: a batch of mixed types is refused with 400.
  const s = service({ answer: (sent, call) => (new Set(Object.values(sent.queries).map((q) => q.type ?? '')).size > 1 ? reply(400, { detail: 'All queries must share a type' }) : echo(sent, call)) });
  const types = [PLACE, undefined, PERIOD, PLACE, PLACE, undefined, PERIOD];
  const qs = types.map((type, i) => ({ key: 'k' + i, query: 'p' + i, type }));
  const out = await lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, batchSize: 2 }).reconcile(qs);
  assert.equal(s.calls.length, 4, 'Place 5, none being Place too (three batches), Period 2 (one)');
  out.forEach((list, i) => { assert.equal(list.key, 'k' + i); assert.equal(list[0].name, 'p' + i); });
  // The fake refuses a mixed batch, so the check above can fail.
  const mixed = await s.fetch(WHG_ENDPOINT, { body: JSON.stringify({ queries: { q0: { query: 'x', type: PLACE }, q1: { query: 'y' } } }) });
  assert.equal(mixed.status, 400);
});

test('the User-Agent avoids everything WHG\'s bot filter refuses, and one that would be refused is refused here', async () => {
  const s = service();
  await lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch }).reconcile([{ query: 'a' }]);
  const ua = s.calls[0].headers['User-Agent'];
  assert.equal(ua, USER_AGENT);
  assert.equal(BLOCKED_AGENTS.length, 10);
  for (const b of BLOCKED_AGENTS) assert.ok(!ua.toLowerCase().includes(b.toLowerCase()), `contains ${b}`);
  for (const bad of ['curl/8.5.0', 'Mozilla/5.0 python-requests/2.31', 'my-scrapy-thing']) {
    assert.throws(() => lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, userAgent: bad }), TypeError, bad);
  }
});

test('entity: a GET of /entity/<id>/api, from any form of the id, with the token only for WHG\'s own records', async () => {
  const s = service();
  const look = lookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch });
  const f = await look.entity('place:gn:745044');
  assert.equal(f.type, 'Feature');
  for (const form of ['https://w3id.org/whg/id/place:gn:745044', 'https://whgazetteer.org/entity/place:gn:745044/api']) await look.entity(form);
  await look.entity('place:whg:1319:277');
  await look.entity('place:169687');
  assert.deepEqual(s.calls.map((c) => c.url), [
    ...Array(3).fill('https://whgazetteer.org/entity/place:gn:745044/api'),
    'https://whgazetteer.org/entity/place:whg:1319:277/api', 'https://whgazetteer.org/entity/place:169687/api',
  ]);
  for (const c of s.calls) {
    assert.equal(c.init.method, 'GET');
    assert.equal(c.init.body, undefined);
    assert.equal(c.headers['Content-Type'], undefined);
    assert.ok(!c.url.includes(TOKEN));
  }
  assert.deepEqual(s.calls.map((c) => c.headers.Authorization ?? null), [null, null, null, `Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  // No token configured: none sent, even for WHG's own.
  const anon = service();
  await lookup({ endpoint: WHG_ENDPOINT, fetch: anon.fetch }).entity('place:whg:1319:277');
  assert.equal(anon.calls[0].headers.Authorization, undefined);
  await assert.rejects(look.entity('12345'), TypeError);
  await assert.rejects(look.entity('https://whgazetteer.org/places/12345/portal/'), TypeError);
  await assert.rejects(lookup({ endpoint: 'https://example.org/reconcile', fetch: s.fetch }).entity('place:gn:1'), TypeError);
});

test('entity: 451 is kind unavailable at once; 503 with Retry-After: 30 is tried again', async () => {
  const s = service({ answer: () => reply(451, { detail: 'The source does not permit redistribution.', namespace: 'kain_par', source: 'Ancient Parishes' }) });
  const err = await lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, sleep: noSleep }).entity('place:kain_par:100').catch((e) => e);
  assert.ok(err instanceof GazetteerError, String(err));
  assert.equal(err.kind, 'unavailable');
  assert.equal(err.status, 451);
  assert.match(err.message, /Ancient Parishes/);
  assert.equal(s.calls.length, 1);

  let n = 0;
  const busy = service({ answer: (sent, call) => (++n === 1 ? reply(503, { detail: 'busy' }, { 'Retry-After': '30' }) : echo(sent, call)) });
  const waits = [];
  const f = await lookup({ endpoint: WHG_ENDPOINT, fetch: busy.fetch, sleep: async (ms) => { waits.push(ms); } }).entity('place:gn:1');
  assert.equal(f.type, 'Feature');
  assert.deepEqual(waits, [30_000]);
});

test('entity: through the same queue as queries, and paced at 60 a minute of its own', async () => {
  const shared = service({ delay: 3 });
  const look = lookup({ endpoint: WHG_ENDPOINT, fetch: shared.fetch });
  await Promise.all([look.reconcile(names(60)), look.entity('place:gn:1'), look.entity('place:gn:2'), look.extend(['place:gn:1'], ['whg:countries_codes'])]);
  assert.equal(shared.maxInFlight, 1);
  assert.equal(shared.calls.length, 3 + 2 + 1);

  const t = fakeTime();
  const s = service({ delay: 0 });
  const paced = lookup({ endpoint: WHG_ENDPOINT, fetch: (u, i) => { const r = s.fetch(u, i); s.calls.at(-1).t = t.now; return r; }, now: t.clock, sleep: t.sleep });
  for (let i = 0; i < 61; i++) await paced.entity('place:gn:' + i);
  assert.equal(s.calls[59].t, 0);
  assert.equal(s.calls[60].t, 60_000, 'the 61st waits for the minute');
  // 60 entity requests did not use up the query allowance.
  await paced.reconcile(names(50));
  assert.equal(s.calls.at(-1).t, 60_000);
});

test('normaliseWhgIri: entity addresses become w3id; legacy cluster addresses and bare numbers are left alone', () => {
  const W = 'https://w3id.org/whg/id/place:gn:745044';
  assert.equal(normaliseWhgIri('https://whgazetteer.org/entity/place:gn:745044/api'), W);
  assert.equal(normaliseWhgIri('https://whgazetteer.org/entity/place:gn:745044'), W);
  assert.equal(normaliseWhgIri('https://whgazetteer.org/entity/place:gn:745044/'), W);
  assert.equal(normaliseWhgIri(W), W);
  assert.equal(normaliseWhgIri('https://whgazetteer.org/places/12345/portal/'), 'https://whgazetteer.org/places/12345/portal/');
  assert.equal(normaliseWhgIri('12345'), '12345');
  assert.equal(normaliseWhgIri(12345), 12345);
  assert.equal(whgIri('place:gn:745044'), W);
});

test('the answers keep the root attribution, merged across batches, with null left as unknown', async () => {
  let n = 0;
  const s = service({ answer: (sent, call) => echo(sent, call).json().then((j) => reply(200, { ...j, attribution: ++n === 1
    ? { sources: { gn: { license: { spdx_id: 'CC-BY-4.0', permits_commercial: true, no_derivatives: false } } } }
    : { sources: { un: { license: { spdx_id: null, permits_commercial: null, no_derivatives: null } } } } })) });
  const out = await lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, batchSize: 2 }).reconcile(names(3));
  assert.equal(s.calls.length, 2);
  assert.deepEqual(Object.keys(out.attribution.sources).sort(), ['gn', 'un']);
  assert.equal(out.attribution.sources.un.license.permits_commercial, null);
  assert.equal(out.attribution.sources.un.license.no_derivatives, null);
  assert.equal(out.attribution.sources.gn.license.no_derivatives, false);
  assert.equal(out.length, 3, 'attribution is not among the answers');
});

// ---- One request in flight across callers, tools and tabs ----

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Given to a later call on a shared lookup: never used there, and never reaches the network. */

/**
 * A stand-in for the Web Locks API's LockManager (exclusive mode only), which records who holds a
 * lock and who waits for one. A request whose signal aborts while it waits is taken off the queue
 * and rejects with the signal's reason, as the real one does.
 */
function fakeLocks() {
  const held = new Map(), waiting = [];
  const log = { requests: [], heldNow: 0, maxHeld: 0, get waiting() { return waiting.length; } };
  log.request = async (name, options, fn) => {
    if (typeof options === 'function') { fn = options; options = {}; }
    const signal = options?.signal;
    log.requests.push({ name, mode: options?.mode, signal });
    if (signal?.aborted) throw signal.reason;
    if (held.get(name)) {
      await new Promise((resolve, reject) => {
        const w = { name, resolve };
        waiting.push(w);
        signal?.addEventListener('abort', () => {
          const i = waiting.indexOf(w);
          if (i >= 0) { waiting.splice(i, 1); reject(signal.reason); }
        }, { once: true });
      });
    } else held.set(name, true);
    log.heldNow++; log.maxHeld = Math.max(log.maxHeld, log.heldNow);
    try { return await fn({ name, mode: 'exclusive' }); } finally {
      log.heldNow--;
      const i = waiting.findIndex((w) => w.name === name);
      if (i >= 0) waiting.splice(i, 1)[0].resolve(); else held.delete(name);
    }
  };
  return log;
}

test('createLookup gives one shared lookup per endpoint: one request in flight across both callers (shared:false ones overlap)', async () => {
  const OTHER = 'tok-other-1a2b3c';
  const s = service({ delay: 5 });
  const a = createLookup({ endpoint: 'https://shared-one.example/reconcile', token: TOKEN, fetch: s.fetch, batchSize: 10, locks: null });
  // The same service written differently, a later token, and a batch size that differs: still the same
  // lookup. (A different fetch is refused: see 'a later createLookup … with another fetch throws'.)
  const b = createLookup({ endpoint: 'HTTPS://Shared-One.example/reconcile/', token: OTHER, fetch: s.fetch, batchSize: 3, locks: null });
  assert.equal(a, b, 'one lookup for one endpoint');
  assert.equal(b.batchSize, 10, 'the first batch size stands');
  await Promise.all([a.reconcile(names(30, 'x')), b.reconcile(names(20, 'y')), a.extend(['i'], ['p'])]);
  assert.equal(s.calls.length, 3 + 2 + 1, 'every request went to the first fetch');
  assert.equal(s.maxInFlight, 1);
  assert.ok(s.calls.every((c) => c.headers.Authorization === `Bearer ${OTHER}`), 'the later token is the one sent');
  // A call with no token leaves the token as it is; the earlier token is still cleaned from messages.
  const c = createLookup({ endpoint: 'https://shared-one.example/reconcile', locks: null });
  assert.equal(c, a);
  await c.reconcile([{ query: 'z' }]);
  assert.equal(s.calls.at(-1).headers.Authorization, `Bearer ${OTHER}`);
  // A private one is another lookup, even for the same endpoint.
  assert.notEqual(createLookup({ endpoint: 'https://shared-one.example/reconcile', fetch: s.fetch, shared: false, locks: null }), a);

  // Control: the same measure over two private lookups must see two in flight.
  const apart = service({ delay: 5 });
  const one = createLookup({ endpoint: 'https://shared-one.example/reconcile', fetch: apart.fetch, shared: false, locks: null });
  const two = createLookup({ endpoint: 'https://shared-one.example/reconcile', fetch: apart.fetch, shared: false, locks: null });
  await Promise.all([one.reconcile(names(3)), two.reconcile(names(3))]);
  assert.equal(apart.maxInFlight, 2);
});

test('a shared lookup cleans every token it has been given from what it repeats', async () => {
  const FIRST = 'tok-first-77aa', SECOND = 'tok-second-88bb';
  const s = service({ answer: () => reply(401, { detail: `Invalid token ${FIRST} or ${SECOND}` }) });
  // The first call's options stand, so `sleep` goes there: a later call's would be ignored.
  createLookup({ endpoint: 'https://shared-two.example/reconcile', token: FIRST, fetch: s.fetch, sleep: noSleep, locks: null });
  const look = createLookup({ endpoint: 'https://shared-two.example/reconcile', token: SECOND, fetch: s.fetch, locks: null });
  const err = await look.reconcile([{ query: 'a' }]).catch((e) => e);
  assert.equal(s.calls[0].headers.Authorization, `Bearer ${SECOND}`, 'present where it belongs');
  assert.match(err.message, /Invalid token \[token\] or \[token\]/);
  assert.ok(!err.message.includes(FIRST) && !err.message.includes(SECOND), err.message);
});

test('with a LockManager, every request (queries, extend, entity, retries) is made holding one exclusive lock per site, so two lookups never overlap', async () => {
  const locks = fakeLocks();
  let n = 0, unlocked = 0;
  // The first request is a 503, so a retry is among those checked.
  const s = service({ delay: 5, answer: (sent, call) => (++n === 1 ? reply(503, {}) : echo(sent, call)) });
  const fetch = (u, i) => { if (locks.heldNow !== 1) unlocked++; return s.fetch(u, i); };
  const one = lookup({ endpoint: WHG_ENDPOINT, fetch, locks, sleep: noSleep, batchSize: 5 });
  const two = lookup({ endpoint: WHG_ENDPOINT, fetch, locks, sleep: noSleep, batchSize: 5 });
  await Promise.all([one.reconcile(names(10)), two.reconcile(names(10)), one.extend(['place:gn:1'], ['whg:countries_codes']), two.entity('place:gn:1')]);
  assert.equal(s.calls.length, 1 + 2 + 2 + 1 + 1, 'the retry, four batches, extend and entity');
  assert.equal(s.maxInFlight, 1);
  assert.equal(unlocked, 0, 'no request was made without the lock');
  assert.ok(locks.requests.length >= 6);
  for (const r of locks.requests) {
    assert.equal(r.name, 'plato-tools:gazetteer:whgazetteer.org');
    assert.equal(r.mode, 'exclusive');
  }
  assert.equal(locks.heldNow, 0, 'every lock let go');

  // Control: without the LockManager, the same two lookups overlap and the same check sees requests
  // made without a lock.
  const apart = service({ delay: 5 });
  let bare = 0;
  const f2 = (u, i) => { if (locks.heldNow !== 1) bare++; return apart.fetch(u, i); };
  await Promise.all([lookup({ endpoint: WHG_ENDPOINT, fetch: f2 }).reconcile(names(3)), lookup({ endpoint: WHG_ENDPOINT, fetch: f2 }).reconcile(names(3))]);
  assert.equal(apart.maxInFlight, 2);
  assert.equal(bare, 2);
});

test('an AbortSignal stops a lookup waiting for the lock, and the lock is not kept', { timeout: 5000 }, async () => {
  const locks = fakeLocks();
  const NAME = 'plato-tools:gazetteer:whgazetteer.org';
  // Another tab holds the lock.
  let release;
  const other = locks.request(NAME, { mode: 'exclusive' }, () => new Promise((r) => { release = r; }));
  const s = service();
  const look = lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, locks });
  const ac = new AbortController();
  const pending = look.reconcile(names(2), { signal: ac.signal });
  await wait(5);
  assert.equal(locks.waiting, 1, 'waiting for the lock');
  assert.equal(s.calls.length, 0, 'nothing sent while another holds it');
  ac.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(locks.waiting, 0, 'no longer waiting');
  release(); await other;
  assert.equal(locks.heldNow, 0);
  // The lock and the lookup's queue both still work.
  assert.equal((await look.reconcile([{ query: 'after' }]))[0][0].name, 'after');
  assert.equal(s.calls.length, 1, 'the aborted batch was never sent');
  assert.equal(locks.heldNow, 0);
});

test("by default the platform's navigator.locks is used (Node has one): two private lookups do not overlap", async (t) => {
  if (!globalThis.navigator?.locks) return t.skip('no navigator.locks here');
  const s = service({ delay: 5 });
  const endpoint = 'https://default-locks.example/reconcile';
  await Promise.all([createLookup({ endpoint, fetch: s.fetch, shared: false }).reconcile(names(3)), createLookup({ endpoint, fetch: s.fetch, shared: false }).reconcile(names(3))]);
  assert.equal(s.maxInFlight, 1);
  // Control: with locks: null they do.
  const apart = service({ delay: 5 });
  await Promise.all([createLookup({ endpoint, fetch: apart.fetch, shared: false, locks: null }).reconcile(names(3)), createLookup({ endpoint, fetch: apart.fetch, shared: false, locks: null }).reconcile(names(3))]);
  assert.equal(apart.maxInFlight, 2);
});

test('a spent allowance is kind quota however WHG words it, with what it said (token cleaned); a refused token stays auth', async () => {
  const cases = [
    [401, `Request limit exceeded for ${TOKEN}`, 'quota'],
    [403, 'Your API QUOTA limit has been reached', 'quota'],
    [401, 'Daily API limit (5000 calls) exceeded', 'quota'],
    [401, 'Invalid token', 'auth'],
    [403, 'No limit on this page; token refused', 'auth'],
  ];
  for (const [status, said, kind] of cases) {
    const s = service({ answer: () => reply(status, { detail: said }) });
    const err = await lookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch, sleep: noSleep }).reconcile([{ query: 'a' }]).catch((e) => e);
    assert.ok(err instanceof GazetteerError, String(err));
    assert.equal(err.kind, kind, said);
    assert.equal(err.status, status);
    assert.ok(err.message.includes(said.split(TOKEN).join('[token]')), err.message);
    assert.ok(!err.message.includes(TOKEN));
    assert.equal(s.calls.length, 1);
  }
});

// ---- Types (whg.js A4) ----

test('WHG is always sent a type: Place when none is given, so a batch of empty queries is not taken for type-guessing', async () => {
  const s = service({ answer: () => reply(200, { q0: { result: [] }, q1: { result: [] } }) });
  await lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch }).reconcile([{ query: '', params: { contained_in: ['un:ita'] } }, { params: { countries: ['IT'] } }]);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(Object.values(s.calls[0].sent.queries).map((q) => q.type), ['Place', 'Place']);
  // Another service is sent no type it was not given.
  const o = service();
  await lookup({ endpoint: 'https://example.org/reconcile', fetch: o.fetch }).reconcile([{ query: '' }]);
  assert.equal(o.calls[0].sent.queries.q0.type, undefined);
});

test("'Place', 'place' and the schema address are one type, and go in one batch; Period in another", async () => {
  const s = service();
  const out = await lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch }).reconcile([
    { key: 'a', query: 'a', type: 'Place' }, { key: 'b', query: 'b', type: PERIOD }, { key: 'c', query: 'c', type: PLACE }, { key: 'd', query: 'd', type: 'place' }, { key: 'e', query: 'e', type: 'Period' },
  ]);
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.calls.map((c) => Object.values(c.sent.queries).map((q) => `${q.query}:${q.type}`)), [['a:Place', 'c:Place', 'd:Place'], ['b:Period', 'e:Period']]);
  out.forEach((list, i) => assert.equal(list[0].name, 'abcde'[i]));
});

test('a type WHG does not have is refused before anything is sent', async () => {
  for (const type of ['Person', 'https://whgazetteer.org/static/whg_schema.jsonld#Thing', { id: 'Place' }]) {
    const s = service();
    const look = lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch });
    await assert.rejects(look.reconcile([{ query: 'fine', type: 'Place' }, { query: 'x', type }]), TypeError, JSON.stringify(type));
    assert.equal(s.calls.length, 0, 'not even the valid one');
    // Positive: the same lookup does send a valid batch.
    await look.reconcile([{ query: 'fine', type: 'Place' }]);
    assert.equal(s.calls.length, 1);
  }
});

// ---- Pacing shared across tabs and workers (a ledger read and written holding the lock) ----

/**
 * A stand-in for a ledger two tabs share (IndexedDB in a browser). It records any read or write made
 * without the lock held, which is where a shared count could be raced.
 */
function sharedLedger(locks) {
  const map = new Map();
  const l = { map, reads: 0, writes: 0, unlocked: 0 };
  l.read = async (key) => { l.reads++; if (locks && locks.heldNow !== 1) l.unlocked++; return structuredClone(map.get(key) ?? []); };
  l.write = async (key, entries) => { l.writes++; if (locks && locks.heldNow !== 1) l.unlocked++; map.set(key, structuredClone(entries)); };
  return l;
}
const stamped = (svc, t) => (u, i) => { const r = svc.fetch(u, i); svc.calls.at(-1).t = t.now; return r; };

test('two tabs sharing the lock and the ledger send no more than 600 queries in any 60 seconds between them', async () => {
  const t = fakeTime();
  const locks = fakeLocks();
  const ledger = sharedLedger(locks);
  const s = service({ delay: 0 });
  const tab = () => lookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: stamped(s, t), batchSize: 50, locks, ledger, now: t.clock, sleep: t.sleep });
  const [a, b] = await Promise.all([tab().reconcile(names(600, 'a')), tab().reconcile(names(600, 'b'))]);
  assert.equal(a[599][0].name, 'a599');
  assert.equal(b[599][0].name, 'b599');
  assert.equal(s.calls.length, 24);
  assert.ok(busiestMinute(s.calls) <= 600, `busiest minute: ${busiestMinute(s.calls)}`);
  assert.ok(t.now >= 60_000, `1,200 queries take at least a minute; took ${t.now} ms`);
  // The ledger was used, and only while holding the lock.
  assert.ok(ledger.reads > 0 && ledger.writes > 0);
  assert.equal(ledger.unlocked, 0, 'read and written only holding the lock');
  // What it keeps: times and counts, under the site's name; no query, no token.
  assert.ok(ledger.map.size > 0);
  for (const [key, entries] of ledger.map) {
    assert.match(key, /^whgazetteer\.org:/);
    assert.ok(entries.length > 0);
    for (const e of entries) assert.deepEqual(Object.keys(e).sort(), ['n', 't']);
  }
  const kept = JSON.stringify([...ledger.map]);
  assert.ok(!kept.includes(TOKEN) && !kept.includes('a0') && !kept.includes('b0'), kept);

  // Control: two tabs with a ledger each (the lock alone) cross the limit, as the same measure sees.
  const t2 = fakeTime();
  const locks2 = fakeLocks();
  const s2 = service({ delay: 0 });
  const tab2 = () => lookup({ endpoint: WHG_ENDPOINT, fetch: stamped(s2, t2), batchSize: 50, locks: locks2, now: t2.clock, sleep: t2.sleep });
  await Promise.all([tab2().reconcile(names(600, 'a')), tab2().reconcile(names(600, 'b'))]);
  assert.equal(busiestMinute(s2.calls), 1200);
});

test('the IndexedDB ledger is the default where there is indexedDB, and two tabs over one database share it', async () => {
  assert.equal(typeof gz.indexedDbLedger, 'function', 'indexedDbLedger is exported');
  const idb = new IDBFactory();
  const had = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  globalThis.indexedDB = idb;
  try {
    const t = fakeTime();
    const locks = fakeLocks();
    const s = service({ delay: 0 });
    // No `ledger` given: each tab's default is the database.
    const tab = () => lookup({ endpoint: WHG_ENDPOINT, fetch: stamped(s, t), batchSize: 50, locks, now: t.clock, sleep: t.sleep });
    await Promise.all([tab().reconcile(names(600, 'a')), tab().reconcile(names(600, 'b'))]);
    assert.equal(s.calls.length, 24);
    assert.ok(busiestMinute(s.calls) <= 600, `busiest minute: ${busiestMinute(s.calls)}`);
    // A third reader of the same database sees times and counts only.
    const kept = await gz.indexedDbLedger({ indexedDB: idb }).read('whgazetteer.org:queries');
    assert.ok(kept.length > 0);
    for (const e of kept) assert.deepEqual(Object.keys(e).sort(), ['n', 't']);
    assert.equal(kept.reduce((sum, e) => sum + e.n, 0) <= 600, true);
  } finally {
    if (had) Object.defineProperty(globalThis, 'indexedDB', had); else delete globalThis.indexedDB;
  }
});

// ---- Tokens ----

test('token: null clears the token (sent without Authorization from then on); undefined leaves it; setToken and clearToken', async () => {
  const EP = 'https://token-clear.example/reconcile';
  const s = service();
  const first = createLookup({ endpoint: EP, token: 'tok-A-1111', fetch: s.fetch, locks: null });
  await first.reconcile(names(1));
  await createLookup({ endpoint: EP, fetch: s.fetch, locks: null }).reconcile(names(1));
  await createLookup({ endpoint: EP, token: undefined, fetch: s.fetch, locks: null }).reconcile(names(1));
  await createLookup({ endpoint: EP, token: null, fetch: s.fetch, locks: null }).reconcile(names(1));
  await first.reconcile(names(1));
  first.setToken('tok-B-2222');
  await first.reconcile(names(1));
  first.clearToken();
  await first.reconcile(names(1));
  assert.deepEqual(s.calls.map((c) => c.headers.Authorization ?? null),
    ['Bearer tok-A-1111', 'Bearer tok-A-1111', 'Bearer tok-A-1111', null, null, 'Bearer tok-B-2222', null]);
});

test("a request's retries carry the token it started with; the next request carries the new one", async () => {
  let n = 0;
  const s = service({ answer: (sent, call) => (++n === 1 ? reply(503, {}) : echo(sent, call)) });
  let look;
  // The token changes while the first request waits to be tried again.
  look = lookup({ endpoint: WHG_ENDPOINT, token: 'tok-old-3333', fetch: s.fetch, sleep: async () => { look.setToken('tok-new-4444'); } });
  await look.reconcile(names(1));
  await look.reconcile(names(1));
  assert.deepEqual(s.calls.map((c) => c.headers.Authorization), ['Bearer tok-old-3333', 'Bearer tok-old-3333', 'Bearer tok-new-4444']);
});

test("a token changed while a reconcile is in flight is used from that call's next batch", async () => {
  const EP = 'https://midflight.example/reconcile';
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = service({ delay: 0, answer: async (sent, call) => { await gate; return echo(sent, call); } });
  const look = createLookup({ endpoint: EP, token: 'tok-A-5555', fetch: s.fetch, locks: null, batchSize: 1 });
  const p = look.reconcile(names(2));
  await wait(5);
  assert.equal(s.calls.length, 1, 'the first batch is in flight');
  createLookup({ endpoint: EP, token: 'tok-B-6666', fetch: s.fetch, locks: null });
  release();
  const out = await p;
  assert.equal(out[1][0].name, 'n1');
  assert.deepEqual(s.calls.map((c) => c.headers.Authorization), ['Bearer tok-A-5555', 'Bearer tok-B-6666']);
});

test('the last 8 tokens retired are cleaned from what is repeated, with the current one; older ones are not kept', async () => {
  const toks = Array.from({ length: 10 }, (_, i) => `tok-${i}-abcdef`);
  const s = service({ answer: () => reply(401, { detail: toks.join(' ') }) });
  const look = lookup({ endpoint: WHG_ENDPOINT, token: toks[0], fetch: s.fetch });
  for (const t of toks.slice(1)) look.setToken(t);
  const err = await look.reconcile(names(1)).catch((e) => e);
  assert.equal(s.calls[0].headers.Authorization, `Bearer ${toks[9]}`);
  // The oldest is no longer held, so it is repeated; the nine since are not.
  assert.ok(err.message.includes(toks[0]), err.message);
  for (const t of toks.slice(1)) assert.ok(!err.message.includes(t), `${t} in ${err.message}`);
  assert.equal(err.message.split('[token]').length - 1, 9);
});

test("every known token is cleaned from a query's .error", async () => {
  const OLD = 'tok-old-7777';
  const s = service({ answer: () => reply(200, { q0: { error: `bad query for ${TOKEN} and ${OLD}`, result: [] } }) });
  const look = lookup({ endpoint: WHG_ENDPOINT, token: OLD, fetch: s.fetch });
  look.setToken(TOKEN);
  const [r] = await look.reconcile([{ query: 'a' }]);
  assert.equal(r.unanswered, true);
  assert.equal(r.error, 'bad query for [token] and [token]');
});

// ---- A request that never answers ----

test('a request that never answers times out (timeoutMs), is retried as network, and lets the lock go', { timeout: 5000 }, async () => {
  const locks = fakeLocks();
  let hungCalls = 0;
  // A fetch that ignores its signal too: the lookup must not depend on it.
  const hung = lookup({ endpoint: WHG_ENDPOINT, fetch: () => { hungCalls++; return new Promise(() => {}); }, locks, timeoutMs: 60, maxRetries: 1, sleep: noSleep });
  const s = service();
  const other = lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, locks });
  const started = Date.now();
  const failed = hung.reconcile(names(1)).catch((e) => e);
  await wait(5);
  const answered = other.reconcile([{ query: 'after' }]);
  await wait(20);
  assert.equal(locks.waiting, 1, 'the other lookup waits while the hung one holds the lock');
  assert.equal(s.calls.length, 0);
  const err = await failed;
  assert.ok(err instanceof GazetteerError, String(err));
  assert.equal(err.kind, 'network');
  assert.equal(hungCalls, 2, 'tried again once, as maxRetries says');
  assert.ok(Date.now() - started >= 110, 'each try waited its timeout');
  assert.equal((await answered)[0][0].name, 'after');
  assert.equal(locks.heldNow, 0);
});

test('the timeout works without AbortSignal.any and AbortSignal.timeout', { timeout: 5000 }, async () => {
  const { any, timeout } = AbortSignal;
  AbortSignal.any = undefined; AbortSignal.timeout = undefined;
  try {
    let signal;
    const look = lookup({ endpoint: WHG_ENDPOINT, fetch: (u, i) => { signal = i.signal; return new Promise(() => {}); }, timeoutMs: 30, maxRetries: 0 });
    const err = await look.reconcile(names(1)).catch((e) => e);
    assert.equal(err.kind, 'network', String(err));
    assert.equal(signal.aborted, true, "fetch's signal was aborted");
    // A caller's abort still reaches fetch.
    const ac = new AbortController();
    let s2;
    const p = lookup({ endpoint: WHG_ENDPOINT, fetch: (u, i) => { s2 = i.signal; return new Promise(() => {}); }, timeoutMs: 10_000 }).reconcile(names(1), { signal: ac.signal });
    await wait(5);
    ac.abort();
    await assert.rejects(p, { name: 'AbortError' });
    assert.equal(s2.aborted, true);
  } finally { AbortSignal.any = any; AbortSignal.timeout = timeout; }
});

// ---- One site, however written ----

test('whgazetteer.org and www.whgazetteer.org are one lookup and one lock; www. is dropped for any site', async () => {
  const f = service().fetch;
  const apex = createLookup({ endpoint: 'https://whgazetteer.org/reconcile', fetch: f, locks: null });
  assert.equal(createLookup({ endpoint: 'https://www.whgazetteer.org/reconcile', fetch: f, locks: null }), apex);
  const ex = createLookup({ endpoint: 'https://www.hosts-one.example/reconcile', fetch: f, locks: null });
  assert.equal(createLookup({ endpoint: 'https://hosts-one.example/reconcile', fetch: f, locks: null }), ex);
  // Control: another site is another lookup.
  assert.notEqual(createLookup({ endpoint: 'https://hosts-two.example/reconcile', fetch: f, locks: null }), ex);

  const locks = fakeLocks();
  for (const endpoint of ['https://whgazetteer.org/reconcile', 'https://www.whgazetteer.org/reconcile', 'https://www.hosts-one.example/reconcile', 'https://hosts-one.example/reconcile', 'https://hosts-two.example/reconcile']) {
    await lookup({ endpoint, fetch: f, locks }).reconcile(names(1));
  }
  assert.deepEqual(locks.requests.map((r) => r.name), [
    'plato-tools:gazetteer:whgazetteer.org', 'plato-tools:gazetteer:whgazetteer.org',
    'plato-tools:gazetteer:hosts-one.example', 'plato-tools:gazetteer:hosts-one.example', 'plato-tools:gazetteer:hosts-two.example',
  ]);
});

// ---- Later calls to createLookup ----

test('a later createLookup call is still refused a fetch, locks or ledger of the wrong kind', () => {
  const EP = 'https://later-types.example/reconcile';
  const first = createLookup({ endpoint: EP, fetch: service().fetch, locks: null });
  assert.equal(typeof first.reconcile, 'function', 'the first call made a lookup');
  assert.throws(() => createLookup({ endpoint: EP, fetch: 'not a function' }), TypeError);
  assert.throws(() => createLookup({ endpoint: EP, locks: 42 }), TypeError);
  assert.throws(() => createLookup({ endpoint: EP, ledger: {} }), TypeError);
  // What is allowed still is.
  assert.equal(createLookup({ endpoint: EP, locks: null }), first);
});

test('a later createLookup call with differing options warns once per option, naming it', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const EP = 'https://later-warn.example/reconcile';
  const f = service().fetch;
  createLookup({ endpoint: EP, fetch: f, batchSize: 10, locks: null });
  createLookup({ endpoint: EP, fetch: f, batchSize: 10, token: 'tok-x-8888', locks: null });
  assert.equal(warn.mock.callCount(), 0, 'the same options, and a token, are no cause to warn');
  createLookup({ endpoint: EP, fetch: f, batchSize: 3, locks: null });
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /batchSize/);
  assert.doesNotMatch(String(warn.mock.calls[0].arguments[0]), /fetch|token/);
  createLookup({ endpoint: EP, fetch: f, batchSize: 4, locks: null });
  assert.equal(warn.mock.callCount(), 1, 'once for batchSize');
  createLookup({ endpoint: EP, fetch: f, maxRetries: 1, locks: null });
  assert.equal(warn.mock.callCount(), 2);
  assert.match(String(warn.mock.calls[1].arguments[0]), /maxRetries/);
});

test("a type WHG does not have is refused with a message saying what is allowed", async () => {
  const err = await lookup({ endpoint: WHG_ENDPOINT, fetch: service().fetch }).reconcile([{ query: 'x', type: { id: 'Place' } }]).catch((e) => e);
  assert.ok(err instanceof TypeError);
  assert.match(err.message, /a string, 'Place' or 'Period'/);
});

// ---- Locks: how they are let go (the platform's own navigator.locks) ----

test('an error inside the lock lets the lock go, and another lookup on the site then runs', { timeout: 5000 }, async (t) => {
  if (!globalThis.navigator?.locks) return t.skip('no navigator.locks here');
  const endpoint = 'https://lock-error.example/reconcile';
  const bad = service({ answer: () => reply(401, { detail: 'Invalid token' }) });
  const err = await createLookup({ endpoint, token: TOKEN, fetch: bad.fetch, shared: false }).reconcile(names(1)).catch((e) => e);
  assert.equal(err.kind, 'auth');
  assert.equal(bad.calls.length, 1, 'the request was made, under the lock');
  const { held } = await navigator.locks.query();
  assert.ok(!held.some((l) => l.name === 'plato-tools:gazetteer:lock-error.example'), 'not held after the error');
  const good = service();
  const r = await Promise.race([createLookup({ endpoint, fetch: good.fetch, shared: false }).reconcile(names(1)), wait(1000).then(() => 'HUNG')]);
  assert.notEqual(r, 'HUNG');
  assert.equal(good.calls.length, 1);
});

test('an AbortSignal stops a lookup waiting for the real navigator.locks', { timeout: 5000 }, async (t) => {
  if (!globalThis.navigator?.locks) return t.skip('no navigator.locks here');
  const NAME = 'plato-tools:gazetteer:real-abort.example';
  let release;
  const other = navigator.locks.request(NAME, () => new Promise((r) => { release = r; }));
  const s = service();
  const ac = new AbortController();
  const p = createLookup({ endpoint: 'https://real-abort.example/reconcile', fetch: s.fetch, shared: false }).reconcile(names(1), { signal: ac.signal });
  await wait(10);
  const { pending } = await navigator.locks.query();
  assert.ok(pending.some((l) => l.name === NAME), 'waiting for the lock');
  ac.abort();
  const r = await Promise.race([p.then(() => 'ran', (e) => e.name), wait(1000).then(() => 'HUNG')]);
  assert.equal(r, 'AbortError');
  assert.equal(s.calls.length, 0);
  release(); await other;
});

test('with the real lock: held during a request, not during the pause between tries, and an AbortSignal ends the pause at once', { timeout: 5000 }, async (t) => {
  if (!globalThis.navigator?.locks) return t.skip('no navigator.locks here');
  const NAME = 'plato-tools:gazetteer:abort-in-backoff.example';
  const heldNow = async () => (await navigator.locks.query()).held.some((l) => l.name === NAME);
  let n = 0;
  const heldInRequest = [];
  const s = service({ answer: async (sent, call) => { heldInRequest.push(await heldNow()); return ++n === 1 ? reply(503, {}) : echo(sent, call); } });
  const look = createLookup({ endpoint: 'https://abort-in-backoff.example/reconcile', fetch: s.fetch, shared: false }); // real sleep
  const ac = new AbortController();
  const p = look.reconcile(names(1), { signal: ac.signal }).catch((e) => e.name);
  await wait(30);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(heldInRequest, [true], 'held while the request was made');
  assert.equal(await heldNow(), false, 'not held during the pause');
  const aborted = Date.now();
  ac.abort();
  assert.equal(await p, 'AbortError');
  // The pause is at least 750 ms; the abort ends it at once, not when it is over.
  assert.ok(Date.now() - aborted < 500, `stopped ${Date.now() - aborted} ms after the abort`);
  assert.equal(await heldNow(), false);
  const r = await Promise.race([createLookup({ endpoint: 'https://abort-in-backoff.example/reconcile', fetch: s.fetch, shared: false }).reconcile(names(1)).then(() => 'ran'), wait(1000).then(() => 'HUNG')]);
  assert.equal(r, 'ran');
  assert.deepEqual(heldInRequest, [true, true]);
});

// ---- The manifest, and exports ----

test("manifest: a GET of the endpoint, without the token, through the same queue; a failure is a GazetteerError", async () => {
  const s = service({ delay: 5, answer: (sent, call) => (call.init.method === 'GET' ? reply(200, { versions: ['0.2'], name: 'WHG' }) : echo(sent, call)) });
  const look = lookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch });
  assert.equal(typeof look.manifest, 'function');
  const [m] = await Promise.all([look.manifest(), look.reconcile(names(3))]);
  assert.deepEqual(m, { versions: ['0.2'], name: 'WHG' });
  const get = s.calls.find((c) => c.init.method === 'GET');
  assert.equal(get.url, WHG_ENDPOINT);
  assert.equal(get.headers.Authorization, undefined, 'no token with the manifest');
  assert.equal(s.calls.find((c) => c.init.method === 'POST').headers.Authorization, `Bearer ${TOKEN}`, 'present on queries');
  assert.equal(s.maxInFlight, 1);
  for (const bad of [() => reply(500, { detail: 'down' }), () => reply(200, '[1]'), () => reply(200, 'not json')]) {
    const e = await lookup({ endpoint: WHG_ENDPOINT, fetch: service({ answer: bad }).fetch, maxRetries: 0 }).manifest().catch((x) => x);
    assert.ok(e instanceof GazetteerError, String(e));
  }
});

test('mergeAttribution and WHG_PLACE_TYPE are exported', () => {
  assert.equal(gz.WHG_PLACE_TYPE, 'Place');
  assert.equal(typeof gz.mergeAttribution, 'function');
  assert.deepEqual(gz.mergeAttribution(null, { sources: { gn: {} } }), { sources: { gn: {} } });
});

// ---- The second independent review (repros NEW B, C, D, H; the lock's scope; sameOption) ----

/** An IDBFactory whose open() returns a request none of whose events ever fire. */
const hungOpen = () => ({ opened: 0, open() { this.opened++; return {}; } });
/** An IDBFactory whose open() succeeds but whose transactions never complete, abort or fail. */
const hungTransaction = () => ({
  open() {
    const req = {};
    const conn = { transaction: () => ({ objectStore: () => ({ get: () => ({}), put: () => ({}) }) }), close() {} };
    setTimeout(() => { req.result = conn; req.onsuccess?.(); }, 0);
    return req;
  },
});

test('an IndexedDB that never answers (open, or a transaction) is given up after ledgerTimeoutMs: the lookup goes on and lets the lock go', { timeout: 5000 }, async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  for (const [what, idb] of [['open', hungOpen()], ['transaction', hungTransaction()]]) {
    const locks = fakeLocks();
    const s = service();
    const look = lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, locks, ledger: gz.indexedDbLedger({ indexedDB: idb, timeoutMs: 50 }) });
    const started = Date.now();
    const r = await Promise.race([look.reconcile([{ query: 'after' }]).then((o) => o[0][0].name), wait(1500).then(() => 'HUNG')]);
    assert.equal(r, 'after', `${what}: the lookup answered`);
    assert.ok(Date.now() - started >= 45, `${what}: it did wait for the database first`);
    assert.equal(s.calls.length, 1, `${what}: the request was sent`);
    assert.equal(locks.heldNow, 0, `${what}: the lock was let go`);
    // Counted in memory from then on: a second lookup through the same ledger does not wait again.
    const again = Date.now();
    await look.reconcile([{ query: 'again' }]);
    assert.ok(Date.now() - again < 45, `${what}: not waited for again`);
  }
  assert.equal(warn.mock.callCount(), 2, 'one warning per ledger');
  assert.match(String(warn.mock.calls[0].arguments[0]), /counted in this tab only/);
  // The same timeout is createLookup's ledgerTimeoutMs for the default (IndexedDB) ledger.
  const had = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  globalThis.indexedDB = hungOpen();
  try {
    const s = service();
    const look = lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, ledgerTimeoutMs: 50 });
    const r = await Promise.race([look.reconcile([{ query: 'default' }]).then((o) => o[0][0].name), wait(1500).then(() => 'HUNG')]);
    assert.equal(r, 'default');
    assert.equal(globalThis.indexedDB.opened, 1, 'the default ledger was the database');
  } finally {
    if (had) Object.defineProperty(globalThis, 'indexedDB', had); else delete globalThis.indexedDB;
  }
});

test('a ledger entry from a clock since stepped back makes a query wait no longer than the window', async () => {
  const t = fakeTime();
  const ledger = gz.memoryLedger();
  // Written when this machine's clock was an hour ahead, and a full minute's worth.
  await ledger.write('whgazetteer.org:queries', [{ t: 3_600_000, n: 600 }]);
  const s = service({ delay: 0 });
  const look = lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, ledger, now: t.clock, sleep: t.sleep });
  assert.equal((await look.reconcile([{ query: 'soon' }]))[0][0].name, 'soon');
  const waited = t.slept.reduce((a, b) => a + b, 0);
  // Positive: the entry was counted (it is a full window's worth), so there was a wait…
  assert.ok(waited > 0, 'the entry was read and counted');
  // …but no longer than one window.
  assert.ok(waited <= 60_000, `waited ${waited / 60_000} minutes`);
});

test('an indexedDB that throws when read (storage blocked) leaves createLookup working, counting in memory, with one warning', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const had = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  let reads = 0;
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get() { reads++; throw new DOMException('The operation is insecure.', 'SecurityError'); } });
  try {
    const s = service();
    const look = lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch });
    assert.ok(reads > 0, 'indexedDB was looked for');
    assert.equal((await look.reconcile([{ query: 'x' }]))[0][0].name, 'x');
    lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch });
    assert.equal(warn.mock.callCount(), 1, 'warned once');
    assert.match(String(warn.mock.calls[0].arguments[0]), /counted in this tab only.*insecure/);
  } finally {
    if (had) Object.defineProperty(globalThis, 'indexedDB', had); else delete globalThis.indexedDB;
  }
});

test('a token that begins another (current \'abcdef\', retired \'abcdef123456\') is cleaned whole: the longer is replaced first', async () => {
  const s = service({ answer: () => reply(401, { detail: 'bad: abcdef123456' }) });
  // The shorter is the current token, the longer one it replaced: the current is cleaned first today.
  const look = lookup({ endpoint: WHG_ENDPOINT, token: 'abcdef123456', fetch: s.fetch });
  look.setToken('abcdef');
  const err = await look.reconcile(names(1)).catch((e) => e);
  assert.equal(s.calls[0].headers.Authorization, 'Bearer abcdef', 'the shorter is the current token');
  assert.match(err.message, /bad: \[token\]/);
  assert.ok(!err.message.includes('123456'), err.message);
});

test('a later createLookup call with a different ledger or LockManager object warns, naming it; the same object does not', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const EP = 'https://later-objects.example/reconcile';
  const f = service().fetch;
  const ledger = gz.memoryLedger(), locks = fakeLocks();
  createLookup({ endpoint: EP, fetch: f, ledger, locks });
  createLookup({ endpoint: EP, fetch: f, ledger, locks });
  assert.equal(warn.mock.callCount(), 0, 'the same objects are no cause to warn');
  createLookup({ endpoint: EP, fetch: f, ledger: gz.memoryLedger(), locks });
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /gave ledger unlike/);
  createLookup({ endpoint: EP, fetch: f, ledger, locks: fakeLocks() });
  assert.equal(warn.mock.callCount(), 2);
  assert.match(String(warn.mock.calls[1].arguments[0]), /gave locks unlike/);
});

test('the lock is held for each try, not across the pause between tries: another tab is served during the pause', { timeout: 5000 }, async () => {
  const locks = fakeLocks();
  let n = 0, heldInFetch = 0, heldInPause = null, other = null;
  const s = service({ delay: 1, answer: (sent, call) => (++n === 1 ? reply(503, {}) : echo(sent, call)) });
  const fetch = (u, i) => { heldInFetch += locks.heldNow; return s.fetch(u, i); };
  // Another tab (its own lookup, sharing only the LockManager).
  const tab2 = lookup({ endpoint: WHG_ENDPOINT, fetch, locks });
  const tab1 = lookup({
    endpoint: WHG_ENDPOINT, fetch, locks,
    sleep: async () => {
      heldInPause = locks.heldNow;
      other = await Promise.race([tab2.reconcile([{ query: 'other' }]).then((o) => o[0][0].name), wait(500).then(() => 'blocked')]);
    },
  });
  const [r] = await tab1.reconcile([{ query: 'first' }]);
  assert.equal(r[0].name, 'first', 'the first tab got its answer after the retry');
  assert.equal(heldInPause, 0, 'the lock was not held during the pause');
  assert.equal(other, 'other', 'the other tab was served during the pause');
  assert.deepEqual(s.calls.map((c) => c.sent.queries.q0.query), ['first', 'other', 'first']);
  assert.equal(heldInFetch, 3, 'every request, the retry too, was made holding the lock');
  assert.equal(locks.heldNow, 0);
});

// ---- A request the permissions module would not make ----
//
// The page gives the lookup permissions.fetch (or a wrapper of it) as its `fetch`. A PermissionError
// from it is a refusal, not a failure to reach the service: asking again cannot change it. Each check
// below is beside its control: an ordinary network failure, through the same lookup, is still retried.

/** An error shaped as src/lib/permissions.js throws it, without importing the module. */
const refusal = (kind, message = `Not allowed (${kind}).`) => Object.assign(new Error(message), { name: 'PermissionError', kind });

test('a PermissionError from fetch is not retried: the job ends at once as kind refused, keeping its kind, token cleaned', async () => {
  let slept = 0;
  const sleep = () => { slept++; return Promise.resolve(); };
  const s = service({ answer: () => { throw refusal('never', `World Historical Gazetteer is set to Never (${TOKEN}).`); } });
  const look = lookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch, maxRetries: 5, sleep });
  const err = await look.reconcile([{ query: 'a' }]).catch((e) => e);
  assert.ok(err instanceof GazetteerError, String(err));
  assert.equal(err.kind, 'refused');
  assert.equal(err.refusal, 'never', "the PermissionError's kind is kept");
  assert.equal(err.status, null);
  assert.equal(s.calls.length, 1, 'asked once, never again');
  assert.equal(slept, 0, 'no pause for a retry');
  assert.equal(s.calls[0].headers.Authorization, `Bearer ${TOKEN}`, 'the token was there to be leaked');
  assert.match(err.message, /set to Never \(\[token\]\)/);
  assert.ok(!err.message.includes(TOKEN), err.message);
  assert.ok(!('cause' in err), 'nothing of the PermissionError is carried but its kind and words');

  // Control: an ordinary network failure through the same kind of lookup is still tried again.
  const down = service({ answer: () => { throw new TypeError('fetch failed'); } });
  slept = 0;
  const e2 = await lookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: down.fetch, maxRetries: 5, sleep }).reconcile([{ query: 'a' }]).catch((e) => e);
  assert.equal(e2.kind, 'network');
  assert.equal(down.calls.length, 6);
  assert.equal(slept, 5);
});

test("err.retry === false is a refusal too, whatever its name; a PermissionError of kind 'network' is retried as no answer", async () => {
  const noRetry = service({ answer: () => { throw Object.assign(new Error('Blocked here.'), { retry: false, kind: 'blocked' }); } });
  const e1 = await lookup({ endpoint: WHG_ENDPOINT, fetch: noRetry.fetch, maxRetries: 3, sleep: noSleep }).reconcile([{ query: 'a' }]).catch((e) => e);
  assert.equal(e1.kind, 'refused');
  assert.equal(e1.refusal, 'blocked');
  assert.equal(noRetry.calls.length, 1);
  // The module's 'network' is fetch failing beneath it: the service was not reached, which may change.
  const unreached = service({ answer: () => { throw refusal('network', 'whgazetteer.org could not be reached.'); } });
  const e2 = await lookup({ endpoint: WHG_ENDPOINT, fetch: unreached.fetch, maxRetries: 3, sleep: noSleep }).reconcile([{ query: 'a' }]).catch((e) => e);
  assert.equal(e2.kind, 'network');
  assert.equal(unreached.calls.length, 4);
  // ...unless it says itself that it is not to be retried.
  const final = service({ answer: () => { throw Object.assign(refusal('network'), { retry: false }); } });
  const e3 = await lookup({ endpoint: WHG_ENDPOINT, fetch: final.fetch, maxRetries: 3, sleep: noSleep }).reconcile([{ query: 'a' }]).catch((e) => e);
  assert.equal(e3.kind, 'refused');
  assert.equal(final.calls.length, 1);
});

test('reconcile, extend, entity and manifest: each ends at once on a refusal, and the job queued behind it runs', async () => {
  const paths = {
    reconcile: (l) => l.reconcile([{ query: 'a' }]),
    extend: (l) => l.extend(['place:gn:1'], ['whg:countries_codes']),
    entity: (l) => l.entity('place:whg:1'),
    manifest: (l) => l.manifest(),
  };
  for (const [name, call] of Object.entries(paths)) {
    let n = 0;
    // The first request is refused; every later one is answered.
    const s = service({ answer: (sent, c) => {
      if (++n === 1) throw refusal('undecided');
      return c.init.method === 'GET' && c.url === WHG_ENDPOINT ? reply(200, { name: 'WHG' }) : echo(sent, c);
    } });
    const look = lookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch, maxRetries: 5, sleep: noSleep });
    // Queued together: the second waits its turn behind the first.
    const [first, second] = await Promise.allSettled([call(look), look.reconcile([{ query: 'next' }])]);
    assert.equal(first.status, 'rejected', name);
    assert.equal(first.reason.kind, 'refused', `${name}: ${first.reason}`);
    assert.equal(first.reason.refusal, 'undecided', name);
    assert.equal(second.status, 'fulfilled', `${name}: the queued job ran (${second.reason})`);
    assert.equal(second.value[0][0].name, 'next', name);
    assert.equal(s.calls.length, 2, `${name}: one refused request, one answered`);
  }
});

test('a refusal lets the lock go (fake LockManager): the next lookup on the site runs; control: retries hold it per try', { timeout: 5000 }, async () => {
  const locks = fakeLocks();
  const s = service({ answer: () => { throw refusal('reload'); } });
  const err = await lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, locks, sleep: noSleep }).reconcile(names(1)).catch((e) => e);
  assert.equal(err.kind, 'refused');
  assert.equal(err.refusal, 'reload');
  assert.equal(locks.requests.length, 1, 'one try, under the lock');
  assert.equal(locks.heldNow, 0, 'let go');
  assert.equal(locks.waiting, 0);
  const good = service();
  const r = await Promise.race([lookup({ endpoint: WHG_ENDPOINT, fetch: good.fetch, locks }).reconcile(names(1)), wait(1000).then(() => 'HUNG')]);
  assert.notEqual(r, 'HUNG');
  assert.equal(good.calls.length, 1);
  // Control: a network failure takes the lock once for each try.
  const before = locks.requests.length;
  const down = service({ answer: () => { throw new TypeError('fetch failed'); } });
  await lookup({ endpoint: WHG_ENDPOINT, fetch: down.fetch, locks, sleep: noSleep, maxRetries: 2 }).reconcile(names(1)).catch(() => {});
  assert.equal(locks.requests.length - before, 3);
  assert.equal(locks.heldNow, 0);
});

test('a refusal lets the real navigator.locks go, and a following job on the site runs', { timeout: 5000 }, async (t) => {
  if (!globalThis.navigator?.locks) return t.skip('no navigator.locks here');
  const endpoint = 'https://refused-lock.example/reconcile', NAME = 'plato-tools:gazetteer:refused-lock.example';
  let heldInFetch = null;
  const s = service({ answer: async () => { heldInFetch = (await navigator.locks.query()).held.some((l) => l.name === NAME); throw refusal('unprotected'); } });
  const look = createLookup({ endpoint, fetch: s.fetch, shared: false, maxRetries: 5 }); // real sleep: a retry would take seconds
  const started = Date.now();
  const err = await look.reconcile(names(1)).catch((e) => e);
  assert.equal(err.kind, 'refused');
  assert.equal(err.refusal, 'unprotected');
  assert.ok(Date.now() - started < 500, 'no pause before giving up');
  assert.equal(heldInFetch, true, 'held while asked');
  const { held, pending } = await navigator.locks.query();
  assert.ok(!held.some((l) => l.name === NAME) && !pending.some((l) => l.name === NAME), 'not held, not waited for');
  const good = service();
  const r = await Promise.race([createLookup({ endpoint, fetch: good.fetch, shared: false }).reconcile(names(1)).then(() => 'ran'), wait(1000).then(() => 'HUNG')]);
  assert.equal(r, 'ran');
});

test("the real permissions.fetch, undecided, as the lookup's fetch: refused once, kind kept, nothing sent", async () => {
  const permissions = await import('../src/lib/permissions.js');
  const sent = [];
  permissions.configure({ fetch: async (u) => { sent.push(u); return new Response('{}'); }, enforced: async () => true });
  const fetch = (url, init) => permissions.fetch(url, { cat: 'gazetteer', subj: 'whg', ...init });
  let tried = 0;
  const counted = (u, i) => { tried++; return fetch(u, i); };
  const err = await lookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: counted, sleep: noSleep }).reconcile([{ query: 'a' }]).catch((e) => e);
  assert.equal(permissions.state('gazetteer', 'whg'), 'undecided', 'the module saw no grant');
  assert.equal(err.kind, 'refused', String(err));
  assert.equal(err.refusal, 'undecided');
  assert.equal(tried, 1);
  assert.equal(sent.length, 0, 'nothing reached the network');
});

test('the WHG token is kept by permissions.token: no file names src/lib/whg-token.js, which does not exist', async () => {
  const { readFileSync, readdirSync, existsSync } = await import('node:fs');
  const root = new URL('../', import.meta.url);
  assert.ok(!existsSync(new URL('src/lib/whg-token.js', root)));
  const files = ['DEVELOPERS.md', 'README.md', ...readdirSync(new URL('src/', root), { recursive: true }).filter((f) => /\.(js|mjs|html)$/.test(f)).map((f) => 'src/' + f)];
  const texts = files.map((f) => [f, readFileSync(new URL(f, root), 'utf8')]);
  // Control: the search sees the files, and the storage key, which keeps its name, is found.
  assert.ok(texts.some(([f, t]) => f === 'src/lib/permissions.js' && t.includes("'plato-tools.whg-token'")));
  assert.deepEqual(texts.filter(([, t]) => t.includes('whg-token.js')).map(([f]) => f), []);
  const index = texts.find(([f]) => f === 'src/engine/gazetteer/index.js')[1];
  assert.match(index, /permissions\.token|`token` in src\/lib\/permissions\.js/);
});

test("a refusal of kind 'moved' says the answer was not used (the request was sent); every other refusal, that the gazetteer was not asked", async () => {
  const moved = service({ answer: () => { throw refusal('moved', 'whgazetteer.org answered with a redirect.'); } });
  const e1 = await lookup({ endpoint: WHG_ENDPOINT, fetch: moved.fetch, sleep: noSleep }).reconcile(names(1)).catch((e) => e);
  assert.equal(e1.kind, 'refused');
  assert.equal(e1.refusal, 'moved');
  assert.equal(moved.calls.length, 1, 'asked once');
  assert.equal(e1.message, "The gazetteer's answer was not used: whgazetteer.org answered with a redirect.");
  // Control: each kind of refusal before sending keeps the words for a request never made.
  for (const kind of ['never', 'undecided', 'reload', 'unprotected', 'address']) {
    const s = service({ answer: () => { throw refusal(kind, `Refused as ${kind}.`); } });
    const e = await lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, sleep: noSleep }).reconcile(names(1)).catch((x) => x);
    assert.equal(e.refusal, kind);
    assert.equal(e.message, `The gazetteer was not asked: Refused as ${kind}.`, kind);
  }
});

test("a refused request is not charged to the pacer's ledger, under the lock; a sent one, and a 'moved' one (sent, its answer not used), are", async () => {
  const NOW = 1_000_000, KEY = 'whgazetteer.org:queries', BEFORE = [{ t: NOW - 1000, n: 7 }];
  const run = async (answer) => {
    const locks = fakeLocks();
    const ledger = sharedLedger(locks);
    ledger.map.set(KEY, structuredClone(BEFORE));
    let charged = null;
    const s = service({ delay: 0, answer: async (sent, call) => {
      // What the ledger held while fetch was asked: the pacer had charged the batch by then.
      charged = structuredClone(ledger.map.get(KEY));
      return (answer ?? echo)(sent, call);
    } });
    const result = await lookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, batchSize: 50, locks, ledger, now: () => NOW, sleep: noSleep })
      .reconcile(names(50)).catch((e) => e);
    return { result, charged, after: ledger.map.get(KEY), unlocked: ledger.unlocked, calls: s.calls.length };
  };
  const refused = await run(() => { throw refusal('undecided'); });
  assert.equal(refused.result.kind, 'refused', String(refused.result));
  assert.equal(refused.calls, 1);
  assert.deepEqual(refused.charged, [...BEFORE, { t: NOW, n: 50 }], 'charged before fetch was asked');
  assert.deepEqual(refused.after, BEFORE, 'and refunded: the ledger is as it was');
  assert.equal(refused.unlocked, 0, 'the refund was made holding the lock');
  // A wrapper's retry: false is a refusal too, and refunded.
  const final = await run(() => { throw Object.assign(new Error('Blocked here.'), { retry: false }); });
  assert.equal(final.result.kind, 'refused');
  assert.deepEqual(final.after, BEFORE);
  // Control: a request sent and answered is charged its 50 queries.
  const sent = await run();
  assert.equal(sent.result[49][0].name, 'n49');
  assert.deepEqual(sent.after, [...BEFORE, { t: NOW, n: 50 }]);
  // 'moved': the request was sent, so it stays charged.
  const moved = await run(() => { throw refusal('moved'); });
  assert.equal(moved.result.refusal, 'moved');
  assert.deepEqual(moved.after, [...BEFORE, { t: NOW, n: 50 }]);
});

test('a later createLookup for a shared endpoint with another fetch throws, naming the problem; the same fetch, or shared:false, is fine', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const EP = 'https://later-fetch.example/reconcile';
  const s = service(), other = service();
  const first = createLookup({ endpoint: EP, token: TOKEN, fetch: s.fetch, locks: null });
  assert.equal(createLookup({ endpoint: EP, fetch: s.fetch, locks: null }), first, 'the same fetch: the same lookup');
  assert.equal(createLookup({ endpoint: 'https://LATER-FETCH.example/reconcile/', locks: null }), first, 'no fetch: the same lookup');
  assert.throws(() => createLookup({ endpoint: 'https://www.later-fetch.example/reconcile', token: 'tok-new-7777', fetch: other.fetch, locks: null }),
    (e) => e instanceof TypeError && /already uses another fetch; pass permissions\.fetch/.test(e.message));
  // The refused call changed nothing: its token was not taken, and the first fetch is still used.
  await first.reconcile(names(1));
  assert.equal(s.calls.length, 1);
  assert.equal(other.calls.length, 0);
  assert.equal(s.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  // A lookup of its own may have any fetch.
  const own = createLookup({ endpoint: EP, fetch: other.fetch, shared: false, locks: null });
  assert.notEqual(own, first);
  await own.reconcile(names(1));
  assert.equal(other.calls.length, 1);
  // A first call that gave no fetch uses the platform's: a later page caller's permissions.fetch differs.
  const EP2 = 'https://later-fetch-two.example/reconcile';
  createLookup({ endpoint: EP2, locks: null });
  assert.throws(() => createLookup({ endpoint: EP2, fetch: s.fetch, locks: null }), /already uses another fetch/);
  // Softer options still only warn.
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(createLookup({ endpoint: EP, fetch: s.fetch, batchSize: 3, locks: null }), first);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /batchSize/);
});
