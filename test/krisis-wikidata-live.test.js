// Krisis, the Wikidata search against the real api.php: ONE anonymous read (wbsearchentities for one name), to
// see that Wikidata's answer still has the shape wikidata-search.js reads. Skipped, saying so, unless
// PLATO_LIVE_WIKIDATA=1 is set: the rest of the suite never goes on the network. Nothing is written, no account
// is used, and no user name or address is sent. Run it as: PLATO_LIVE_WIKIDATA=1 node --test test/krisis-wikidata-live.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getJson } from '../src/engine/krisis/wikidata-search.js';
import { searchUrl, QID } from '../src/engine/krisis/wikidata.js';

const LIVE = process.env.PLATO_LIVE_WIKIDATA === '1';
test('Wikidata answers one search for Newcastle upon Tyne with items (ids and labels), anonymously', { skip: !LIVE && 'PLATO_LIVE_WIKIDATA is not set, so the live read of Wikidata is not run' }, async () => {
  let requests = 0;
  const fetch = (...a) => { requests++; return globalThis.fetch(...a); };
  const j = await getJson(fetch, searchUrl('Newcastle upon Tyne', 'en', { limit: 3 }));
  assert.equal(requests, 1, 'one request');
  assert.ok(Array.isArray(j.search) && j.search.length > 0, 'Wikidata knows Newcastle upon Tyne');
  assert.ok(j.search.every((x) => QID.test(x.id) && typeof x.label === 'string'), JSON.stringify(j.search[0]));
  console.log('first hit:', j.search[0].id, j.search[0].label);
});
