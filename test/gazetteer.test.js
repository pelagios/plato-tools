// The gazetteer lookup (src/engine/gazetteer/): W3C reconciliation against a service that is stood
// in for by a fake fetch, which records every request and how many were in flight at once. Nothing
// here reaches the network.
//
// Each check that something does NOT happen (a second request in flight, the token in an address or
// a message) also asserts in the same test that the thing looked for is there to be seen: the
// concurrency check is run against two separate lookups too, where it must find two in flight, and
// the token check finds the token in the Authorization header before it looks everywhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLookup, createPacer, GazetteerError, WHG_ENDPOINT, BLOCKED_AGENTS, USER_AGENT, whgIri, normaliseWhgIri, parseCentroid, parseGeojsonValues,
} from '../src/engine/gazetteer/index.js';

const TOKEN = 'tok-5ecret-9f8e7d';

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
  const look = createLookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch });
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
  assert.deepEqual(c.sent, { queries: {
    q0: { query: 'London', type: 'https://whgazetteer.org/static/whg_schema.jsonld#Place', limit: 3, properties: [{ pid: 'whg:countries_codes', v: 'GB' }] },
    q1: { contained_in: ['un:ita'], query: 'Rome', type: 'https://whgazetteer.org/static/whg_schema.jsonld#Place', limit: 10 },
  } });
});

test("encoding 'form' sends queries= as the W3C protocol and OpenRefine do", async () => {
  const s = service();
  const look = createLookup({ endpoint: 'https://example.org/reconcile', token: TOKEN, fetch: s.fetch, encoding: 'form' });
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
  const look = createLookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch });
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
  const look = createLookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch });
  const [timedOut, scoped, missing] = await look.reconcile([{ query: 'a' }, { query: 'b' }, { query: 'c' }]);
  assert.equal(timedOut.unanswered, true);
  assert.equal(scoped.unanswered, undefined);
  assert.equal(scoped.scope.applied, false);
  assert.equal(missing.unanswered, true);
  assert.equal(missing.key, null);
});

test('120 queries in batches of 50 are three POSTs of 50, 50 and 20, answered in order, with progress', async () => {
  const s = service();
  const look = createLookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch, batchSize: 50 });
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
  const at = (batchSize) => createLookup({ endpoint: WHG_ENDPOINT, fetch: f, batchSize }).batchSize;
  assert.equal(at(undefined), 25);
  assert.equal(at(500), 50);
  assert.equal(at(0), 1);
  assert.equal(at(-3), 1);
  assert.equal(at(12.7), 12);
  assert.equal(at('x'), 25);
});

test('no queries, no request', async () => {
  const s = service();
  const look = createLookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch });
  const out = await look.reconcile([]);
  assert.equal(out.length, 0);
  assert.equal(s.calls.length, 0);
});

test('one request in flight at a time across all callers of a lookup (and two lookups do overlap)', async () => {
  const shared = service({ delay: 5 });
  const look = createLookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: shared.fetch, batchSize: 10 });
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
  const one = createLookup({ endpoint: WHG_ENDPOINT, fetch: apart.fetch });
  const two = createLookup({ endpoint: WHG_ENDPOINT, fetch: apart.fetch });
  await Promise.all([one.reconcile(names(3)), two.reconcile(names(3))]);
  assert.equal(apart.maxInFlight, 2);
});

test('429 waits as long as Retry-After says, capped, then carries on', async () => {
  let n = 0;
  const s = service({ answer: (sent) => (++n <= 2 ? reply(429, { detail: 'slow down' }, { 'Retry-After': n === 1 ? '7' : '3600' }) : echo(sent)) });
  const waits = [];
  const look = createLookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch, sleep: async (ms) => { waits.push(ms); } });
  const [r] = await look.reconcile([{ query: 'Oxford' }]);
  assert.equal(r[0].name, 'Oxford');
  assert.equal(s.calls.length, 3);
  assert.deepEqual(waits, [7000, 60000], 'seven seconds as asked; an hour capped at a minute');
});

test('429 without Retry-After, and 503, back off growing; retries are limited', async () => {
  const s = service({ answer: (_, call) => reply(s.calls.indexOf(call) % 2 ? 503 : 429, {}) });
  const waits = [];
  const look = createLookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, maxRetries: 3, sleep: async (ms) => { waits.push(ms); } });
  const err = await look.reconcile([{ query: 'a' }]).then(() => null, (e) => e);
  assert.ok(err instanceof GazetteerError);
  assert.equal(err.kind, 'server', 'the last answer was 503');
  assert.equal(err.status, 503);
  assert.equal(s.calls.length, 4);
  assert.equal(waits.length, 3);
  // 429 starts at 4 s (WHG's window is a minute), 503 at 1 s; each doubles with the attempt.
  assert.ok(waits[0] >= 3000 && waits[0] <= 4000 && waits[1] >= 1500 && waits[1] <= 2000 && waits[2] >= 12000 && waits[2] <= 16000, `backoff: ${waits}`);

  const always = service({ answer: () => reply(429, {}, { 'Retry-After': '1' }) });
  const e2 = await createLookup({ endpoint: WHG_ENDPOINT, fetch: always.fetch, maxRetries: 2, sleep: noSleep }).reconcile([{ query: 'a' }]).catch((e) => e);
  assert.equal(e2.kind, 'rate');
  assert.equal(e2.status, 429);
  assert.equal(always.calls.length, 3);
});

test('401 and 403 are refused at once, as kind auth, with what the service said', async () => {
  for (const status of [401, 403]) {
    const s = service({ answer: () => reply(status, { detail: 'Invalid token. Token login failed.' }) });
    let slept = 0;
    const look = createLookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch, sleep: async () => { slept++; } });
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
    const look = createLookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch, maxRetries: 1, sleep: noSleep });
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
  const look = createLookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: service().fetch });
  assert.ok(!JSON.stringify(look).includes(TOKEN) && !Object.values(look).some((v) => String(v).includes(TOKEN)));
});

test('no answer at all is tried again, then reported as kind network', async () => {
  const s = service({ answer: () => { throw new TypeError('fetch failed'); } });
  const look = createLookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, maxRetries: 2, sleep: noSleep });
  const err = await look.reconcile([{ query: 'a' }]).catch((e) => e);
  assert.equal(err.kind, 'network');
  assert.equal(err.status, null);
  assert.equal(s.calls.length, 3);
});

// A lookup that loses a waiting job would leave its caller waiting for ever: the timeout makes that a failure.
test('an AbortSignal stops the request in flight, and a caller\'s batches still waiting', { timeout: 5000 }, async () => {
  // In flight: the request is cancelled and the lookup rejects with the signal's reason.
  const slow = service({ delay: 10_000 });
  const look = createLookup({ endpoint: WHG_ENDPOINT, fetch: slow.fetch });
  const ac = new AbortController();
  const pending = look.reconcile(names(3), { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(slow.calls.length, 1);
  ac.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(slow.calls[0].init.signal, ac.signal, 'the signal was handed to fetch');

  // Queued: B waits behind A; B is aborted; A finishes; B's request is never sent.
  let release;
  const gate = new Promise((r) => { release = r; });
  const gated = service({ delay: 0, answer: async (sent) => { await gate; return echo(sent); } });
  const shared = createLookup({ endpoint: WHG_ENDPOINT, fetch: gated.fetch });
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
  await assert.rejects(createLookup({ endpoint: WHG_ENDPOINT, fetch: none.fetch }).reconcile([{ query: 'x' }], { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(none.calls.length, 0);
});

test('an AbortSignal stops a pause between tries', { timeout: 5000 }, async () => {
  const s = service({ answer: () => reply(429, {}, { 'Retry-After': '30' }) });
  const look = createLookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch }); // the real sleep
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
  const look = createLookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch, batchSize: 2 });
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
  const other = createLookup({ endpoint: 'https://example.org/reconcile', fetch: service().fetch });
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
  const [refused, none] = await createLookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch }).reconcile([{ query: 'a', params: { start: 5, end: 1 } }, { query: 'b' }]);
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
    await createLookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, sleep: async (ms) => { waits.push(ms); } }).reconcile([{ query: 'a' }]);
    assert.equal(waits.length, 1);
    assert.ok(expect(waits[0]), `${filtered ? 'filtered' : 'readable'}: waited ${waits[0]}`);
  }
});

test('the pacer: never more than 600 queries in any 60 seconds, across batches and callers', async () => {
  const t = fakeTime();
  const paced = service({ delay: 0 });
  const stamp = (svc) => async (url, init) => { const r = svc.fetch(url, init); svc.calls.at(-1).t = t.now; return r; };
  const look = createLookup({ endpoint: WHG_ENDPOINT, fetch: stamp(paced), batchSize: 50, now: t.clock, sleep: t.sleep });
  const [a, b] = await Promise.all([look.reconcile(names(1000, 'a')), look.reconcile(names(300, 'b'))]);
  assert.equal(a[999][0].name, 'a999');
  assert.equal(b[299][0].name, 'b299');
  assert.equal(paced.calls.length, 26);
  assert.ok(busiestMinute(paced.calls) <= 600, `busiest minute: ${busiestMinute(paced.calls)}`);
  assert.ok(t.now >= 120_000, `1,300 queries take at least two full minutes; took ${t.now} ms`);

  // Without the pacer the same measure sees the limit crossed: the check above can fail.
  const t2 = fakeTime();
  const unpaced = service({ delay: 0 });
  const free = createLookup({ endpoint: WHG_ENDPOINT, fetch: (u, i) => { const r = unpaced.fetch(u, i); unpaced.calls.at(-1).t = t2.now; return r; }, batchSize: 50, queryRate: null, now: t2.clock, sleep: t2.sleep });
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
    const err = await createLookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch, sleep: noSleep }).reconcile([{ query: 'a' }]).catch((e) => e);
    assert.ok(err instanceof GazetteerError, String(err));
    assert.equal(err.kind, kind, said);
    assert.equal(err.status, 401);
    assert.equal(s.calls.length, 1, 'not asked again');
  }
});

test('a query without a limit asks for 10 candidates, not WHG\'s 100; one with a limit keeps it', async () => {
  const s = service();
  await createLookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch }).reconcile([{ query: 'a' }, { query: 'b', limit: 3 }]);
  assert.deepEqual(Object.values(s.calls[0].sent.queries).map((q) => q.limit), [10, 3]);
  const s2 = service();
  await createLookup({ endpoint: WHG_ENDPOINT, fetch: s2.fetch, defaultLimit: 500 }).reconcile([{ query: 'a' }]);
  assert.equal(s2.calls[0].sent.queries.q0.limit, 50, 'a default is never above 50');
});

test('a batch holds queries of one type only, and the answers still come back in input order', async () => {
  // As WHG does: a batch of mixed types is refused with 400.
  const s = service({ answer: (sent, call) => (new Set(Object.values(sent.queries).map((q) => q.type ?? '')).size > 1 ? reply(400, { detail: 'All queries must share a type' }) : echo(sent, call)) });
  const types = [PLACE, undefined, PERIOD, PLACE, PLACE, undefined, PERIOD];
  const qs = types.map((type, i) => ({ key: 'k' + i, query: 'p' + i, type }));
  const out = await createLookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, batchSize: 2 }).reconcile(qs);
  assert.equal(s.calls.length, 4, 'Place 3 (two batches), none 2, Period 2');
  out.forEach((list, i) => { assert.equal(list.key, 'k' + i); assert.equal(list[0].name, 'p' + i); });
  // The fake refuses a mixed batch, so the check above can fail.
  const mixed = await s.fetch(WHG_ENDPOINT, { body: JSON.stringify({ queries: { q0: { query: 'x', type: PLACE }, q1: { query: 'y' } } }) });
  assert.equal(mixed.status, 400);
});

test('the User-Agent avoids everything WHG\'s bot filter refuses, and one that would be refused is refused here', async () => {
  const s = service();
  await createLookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch }).reconcile([{ query: 'a' }]);
  const ua = s.calls[0].headers['User-Agent'];
  assert.equal(ua, USER_AGENT);
  assert.equal(BLOCKED_AGENTS.length, 10);
  for (const b of BLOCKED_AGENTS) assert.ok(!ua.toLowerCase().includes(b.toLowerCase()), `contains ${b}`);
  for (const bad of ['curl/8.5.0', 'Mozilla/5.0 python-requests/2.31', 'my-scrapy-thing']) {
    assert.throws(() => createLookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, userAgent: bad }), TypeError, bad);
  }
});

test('entity: a GET of /entity/<id>/api, from any form of the id, with the token only for WHG\'s own records', async () => {
  const s = service();
  const look = createLookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch: s.fetch });
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
  await createLookup({ endpoint: WHG_ENDPOINT, fetch: anon.fetch }).entity('place:whg:1319:277');
  assert.equal(anon.calls[0].headers.Authorization, undefined);
  await assert.rejects(look.entity('12345'), TypeError);
  await assert.rejects(look.entity('https://whgazetteer.org/places/12345/portal/'), TypeError);
  await assert.rejects(createLookup({ endpoint: 'https://example.org/reconcile', fetch: s.fetch }).entity('place:gn:1'), TypeError);
});

test('entity: 451 is kind unavailable at once; 503 with Retry-After: 30 is tried again', async () => {
  const s = service({ answer: () => reply(451, { detail: 'The source does not permit redistribution.', namespace: 'kain_par', source: 'Ancient Parishes' }) });
  const err = await createLookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, sleep: noSleep }).entity('place:kain_par:100').catch((e) => e);
  assert.ok(err instanceof GazetteerError, String(err));
  assert.equal(err.kind, 'unavailable');
  assert.equal(err.status, 451);
  assert.match(err.message, /Ancient Parishes/);
  assert.equal(s.calls.length, 1);

  let n = 0;
  const busy = service({ answer: (sent, call) => (++n === 1 ? reply(503, { detail: 'busy' }, { 'Retry-After': '30' }) : echo(sent, call)) });
  const waits = [];
  const f = await createLookup({ endpoint: WHG_ENDPOINT, fetch: busy.fetch, sleep: async (ms) => { waits.push(ms); } }).entity('place:gn:1');
  assert.equal(f.type, 'Feature');
  assert.deepEqual(waits, [30_000]);
});

test('entity: through the same queue as queries, and paced at 60 a minute of its own', async () => {
  const shared = service({ delay: 3 });
  const look = createLookup({ endpoint: WHG_ENDPOINT, fetch: shared.fetch });
  await Promise.all([look.reconcile(names(60)), look.entity('place:gn:1'), look.entity('place:gn:2'), look.extend(['place:gn:1'], ['whg:countries_codes'])]);
  assert.equal(shared.maxInFlight, 1);
  assert.equal(shared.calls.length, 3 + 2 + 1);

  const t = fakeTime();
  const s = service({ delay: 0 });
  const paced = createLookup({ endpoint: WHG_ENDPOINT, fetch: (u, i) => { const r = s.fetch(u, i); s.calls.at(-1).t = t.now; return r; }, now: t.clock, sleep: t.sleep });
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
  const out = await createLookup({ endpoint: WHG_ENDPOINT, fetch: s.fetch, batchSize: 2 }).reconcile(names(3));
  assert.equal(s.calls.length, 2);
  assert.deepEqual(Object.keys(out.attribution.sources).sort(), ['gn', 'un']);
  assert.equal(out.attribution.sources.un.license.permits_commercial, null);
  assert.equal(out.attribution.sources.un.license.no_derivatives, null);
  assert.equal(out.attribution.sources.gn.license.no_derivatives, false);
  assert.equal(out.length, 3, 'attribution is not among the answers');
});
