// Krisis, gazetteer lookup against the real World Historical Gazetteer: ONE request, with ONE query,
// to see that WHG's answer still fits what lookup.js expects. It needs a token, read from WHG_TOKEN in
// the environment only, and is skipped, saying so, without one; the rest of the suite never goes on
// the network. Run it as: set -a; . ~/.config/plato-tools/secrets.env; set +a; node --test test/krisis-lookup-live.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLookup, memoryLedger, WHG_ENDPOINT } from '../src/engine/gazetteer/index.js';
import { runLookup, licenceOf } from '../src/engine/krisis/lookup.js';
import { serialiseWork, readWork } from '../src/engine/krisis/work.js';

const TOKEN = process.env.WHG_TOKEN;
test('WHG answers one query for Newcastle, ranked, with the attribution kept and no token in the work file', { skip: !TOKEN && 'WHG_TOKEN is not set, so the live lookup against WHG is not run' }, async () => {
  let requests = 0;
  const fetch = (...a) => { requests++; return globalThis.fetch(...a); };
  const subjects = { title: 'Live test', files: [] };
  const places = [{ iri: 'https://example.org/live/newcastle', label: 'Newcastle upon Tyne', names: ['Newcastle upon Tyne'], point: [-1.61, 54.97], ccodes: ['GB'], identities: { linked: [], denied: [] } }];
  const { work, record, stopped } = await runLookup({ lookup: createLookup({ endpoint: WHG_ENDPOINT, token: TOKEN, fetch, maxRetries: 0, shared: false, locks: null, ledger: memoryLedger() }), subjects, places, options: { limit: 5 } });
  assert.equal(requests, 1, 'one request');
  assert.equal(stopped, null, JSON.stringify(stopped));
  assert.equal(record.queries[places[0].iri].state, 'answered');
  assert.ok(work.candidates.length > 0, 'WHG knows Newcastle upon Tyne');
  const top = work.candidates[0];
  assert.match(top.candidate_candidate, /^https:\/\/w3id\.org\/whg\/id\/place:/);
  assert.ok(top.distance_km !== null && top.distance_km < 50, `the nearest first: ${top.distance_km} km`);
  const text = serialiseWork(work);
  assert.ok(!text.includes(TOKEN), 'the token is not in the work file');
  assert.deepEqual(readWork(text), work);
  // What WHG says of licences, as it says it (printed, not asserted: it is WHG's to change).
  console.log('attribution keys:', Object.keys(record.attribution || {}), 'top licence:', JSON.stringify(licenceOf(record.attribution, top.gazetteer.namespace)));
});
