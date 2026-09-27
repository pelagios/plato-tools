// The reverse mapping must give the same records from the SQLite store as from the in-memory graph.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { Json2Rdf } from '../src/formats/json2rdf.js';
import { Rdf2Json, MemGraph } from '../src/formats/rdf2json.js';
import { openSqlite, TripleStore } from '../src/lib/store.js';

const load = (f) => JSON.parse(readFileSync(`public/plato/${f}`, 'utf8'));
const CTX = load('plato.context.jsonld'), CORE = load('plato.schema.json'), PROF = load('place-centric.schema.json');
const EXAMPLES = '../place-attestation-ontology/schemas/examples';

test('SQLite store and in-memory graph give identical records', async () => {
  const doc = JSON.parse(readFileSync(`${EXAMPLES}/place-centric-constantinople.json`, 'utf8'));
  const mem = new MemGraph();
  const store = new TripleStore(await openSqlite(sqlite3InitModule, { memory: true }));
  store.beginBatch();
  const w = new Json2Rdf(CTX, (s, p, o) => { mem.add(s, p, o); store.add(s, p, o); });
  const { spatialEntities, ...head } = doc; w.header(head); for (const r of spatialEntities) w.record('spatialEntities', r);
  store.endBatch(); store.index();
  assert.ok(store.count > 50, `store holds ${store.count} triples`);
  const a = new Rdf2Json({ context: CTX, core: CORE, profile: PROF }, mem).entity(spatialEntities[0]['@id']);
  const b = new Rdf2Json({ context: CTX, core: CORE, profile: PROF }, store).entity(spatialEntities[0]['@id']);
  assert.ok(a.attestations.length === spatialEntities[0].attestations.length);
  assert.deepEqual(b, a);
  store.close();
});
