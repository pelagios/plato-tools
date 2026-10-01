// The tiles a trace reads (src/chora/inkfetch.js): through the guard alone, two at a time, a 429 waited
// out, refusals said in words, kept so that the same tile is not asked for twice, and only from the map's
// own image server. The guard and the decoding are stand-ins; what they are asked is what is checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTileFetcher, waitAfter, TileError, CONCURRENCY } from '../src/chora/inkfetch.js';
import { GuardError } from '../src/chora/fetchguard.js';

const A = 'http://127.0.0.1:9001';
const blob = (n) => ({ size: n, n });
function guardOf(answer, log = []) {
  let inFlight = 0;
  return {
    log, peak: () => log.peak || 0,
    async fetch(url, kind) {
      log.push({ url, kind }); inFlight++; log.peak = Math.max(log.peak || 0, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const a = answer(url, log.filter((x) => x.url === url).length);
      if (a instanceof Error) throw a;
      return { blob: async () => a };
    },
  };
}
const decode = async (b) => ({ decoded: b, close() {} });

test('tiles are fetched through the guard as iiif, at most two at a time, in the order asked', async () => {
  const g = guardOf(() => blob(10));
  const f = createTileFetcher({ guard: g, decode });
  const urls = Array.from({ length: 7 }, (_, k) => `${A}/iiif/ink/${k}/default.jpg`);
  const out = await f.fetch(urls, { origin: A });
  assert.deepEqual(out.map((t) => t.url), urls);
  assert.equal(g.log.length, 7);
  assert.ok(g.log.every((x) => x.kind === 'iiif'));
  assert.equal(CONCURRENCY, 2);
  assert.equal(g.peak(), 2, 'more (or fewer) than two at once');
});

test('a tile fetched once is not asked for again', async () => {
  const g = guardOf(() => blob(10));
  const f = createTileFetcher({ guard: g, decode });
  await f.fetch([`${A}/a.jpg`, `${A}/b.jpg`]);
  await f.fetch([`${A}/b.jpg`, `${A}/c.jpg`]);
  assert.deepEqual(g.log.map((x) => x.url), [`${A}/a.jpg`, `${A}/b.jpg`, `${A}/c.jpg`]);
  assert.equal(f.stats.fromCache, 1);
});

test('a 429 is waited out as Retry-After says (else 1 s, then 2 s), and given up in words after four', async () => {
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  const g = guardOf((url, n) => (n <= 2 ? new GuardError('status', 'x', { status: 429, retryAfter: url.includes('ra') ? '3' : null }) : blob(1)));
  const f = createTileFetcher({ guard: g, decode, sleep });
  await f.fetch([`${A}/ra.jpg`]);
  assert.deepEqual(slept, [3000, 3000]);
  slept.length = 0;
  await f.fetch([`${A}/plain.jpg`]);
  assert.deepEqual(slept, [1000, 2000]);
  const always = createTileFetcher({ guard: guardOf(() => new GuardError('status', 'x', { status: 429 })), decode, sleep: async () => {} });
  await assert.rejects(always.fetch([`${A}/x.jpg`]), (e) => e instanceof TileError && e.kind === 'busy' && /429/.test(e.message));
  assert.equal(waitAfter(new Date(Date.parse('2026-10-01T00:00:05Z')).toUTCString(), 0, Date.parse('2026-10-01T00:00:00Z')), 5);
});

test('a 403 and a server that lets no other site read it are said in words; nothing else is asked after', async () => {
  const g403 = guardOf(() => new GuardError('status', 'x', { status: 403 }));
  await assert.rejects(createTileFetcher({ guard: g403, decode }).fetch([`${A}/a.jpg`, `${A}/b.jpg`, `${A}/c.jpg`]),
    (e) => e.kind === 'auth' && /403/.test(e.message) && /IIIF Auth/.test(e.message) && e.message.includes(A));
  assert.ok(g403.log.length <= 2, `asked ${g403.log.length} after a refusal`);
  const cors = guardOf(() => new GuardError('network', 'x'));
  await assert.rejects(createTileFetcher({ guard: cors, decode }).fetch([`${A}/a.jpg`]), (e) => e.kind === 'cors' && /CORS/.test(e.message));
});

test('a tile not on the map\'s image server is refused before anything is asked; a trace let go asks no more', async () => {
  const g = guardOf(() => blob(1));
  const f = createTileFetcher({ guard: g, decode });
  await assert.rejects(f.fetch([`${A}/a.jpg`, 'http://127.0.0.1:9002/b.jpg'], { origin: A }), (e) => e instanceof TileError && /not on its image server/.test(e.message));
  assert.equal(g.log.length, 0);
  // The control: the same call with the origin both are on asks for both.
  await f.fetch([`${A}/a.jpg`, `${A}/b2.jpg`], { origin: A });
  assert.equal(g.log.length, 2);
  let current = true;
  const g2 = guardOf(() => { current = false; return blob(1); });
  await assert.rejects(createTileFetcher({ guard: g2, decode }).fetch([`${A}/1`, `${A}/2`, `${A}/3`, `${A}/4`], { isCurrent: () => current }), (e) => e.kind === 'cancelled');
  assert.ok(g2.log.length <= 2, `asked ${g2.log.length} after being let go`);
});
