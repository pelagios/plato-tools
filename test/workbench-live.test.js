// Methodos's projects in the real World Historical Gazetteer's Workbench (plan #34, item A1): one tiny project
// made, read back, pushed, refused when stale, shared, read through its link with no token, its preflight
// asked as the page's browser would, unshared, and deleted, to see that WHG still answers as
// src/engine/workbench.js and test/workbench-fake.js expect. It needs a token of an account enrolled in the
// Workbench's beta, read from WHG_TOKEN in the environment only, and is skipped, saying so, without one; the rest
// of the suite never goes on the network. Run it by hand, as:
//   set -a; . ~/.config/plato-tools/secrets.env; set +a; node --test test/workbench-live.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RECIPES, runner, recordOf, refsOf } from '../src/engine/methodos/index.js';
import { writeProject, readProject, blobSource } from '../src/engine/methodos/project.js';
import { workbench, envelope, unwrap, WORKBENCH, WorkbenchError } from '../src/engine/workbench.js';

const TOKEN = process.env.WHG_TOKEN;
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const USER_AGENT = `plato-tools/${VERSION} (+https://pelagios.org/plato-tools/)`;

test('WHG\'s Workbench keeps, refuses when stale, shares and deletes a PLATO tools project as the tools expect, and no body carries the token', { skip: !TOKEN && 'WHG_TOKEN is not set, so the live test against WHG\'s Workbench is not run' }, async () => {
  const bodies = [];
  const fetch = async (url, init) => {
    assert.ok(!String(url).includes(TOKEN), 'the token is never in an address');
    if (init?.body) bodies.push(String(init.body));
    const r = await globalThis.fetch(url, init);
    const text = await r.text();
    bodies.push(text);
    return new Response(r.status === 204 ? null : text, { status: r.status, headers: r.headers });
  };
  const wb = workbench({ fetch, token: () => TOKEN, userAgent: USER_AGENT });
  const anyone = workbench({ fetch, token: () => null, userAgent: USER_AGENT });
  const own = new File([`id,name\n1,Live test ${new Date().toISOString()}\n`], 'live.csv', { type: 'text/csv' });
  const [table] = await refsOf([own], 'files');
  const record = recordOf({ ...runner.start(RECIPES['map-your-data'], { 'has-regions': false, 'will-draw': false, 'will-publish': false, target: 'plato-json' }, { files: [table] }), id: `map-your-data-live${Date.now().toString(36)}` }, { name: 'PLATO tools live test (delete me)' });
  const chunks = [];
  await writeProject({ record, files: [{ ref: table, blob: own }], tools: { version: VERSION, commit: null } }, (c) => { chunks.push(c); });
  const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
  let id = null;
  try {
    const made = await wb.create({ snapshot: envelope(bytes, record), title: record.name });
    id = made.id;
    assert.equal(made.version, 1); assert.equal(made.doc_type, 'plato');
    const got = await wb.get(id);
    assert.deepEqual(unwrap(got.snapshot), bytes, 'the project comes back whole, whatever jsonb did to the envelope\'s keys');
    assert.deepEqual((await readProject(blobSource(new Blob([unwrap(got.snapshot)])))).record, record);
    assert.ok((await wb.list()).some((p) => p.id === id), 'listed under ?doc_type=plato');
    const v2 = envelope(bytes.slice(), { ...record, name: 'v2' });
    assert.equal((await wb.push(id, { snapshot: v2, base_version: 1 })).version, 2);
    // Stale: refused whole, with WHG's version and snapshot.
    let stale;
    await assert.rejects(wb.push(id, { snapshot: envelope(bytes, record), base_version: 1 }), (e) => { stale = e; return e instanceof WorkbenchError && e.kind === 'conflict'; });
    assert.equal(stale.version, 2); assert.equal(stale.snapshot.workflow.name, 'v2');
    // Shared: read with no Authorization at all.
    const { token: share } = await wb.share(id);
    const shared = await anyone.shared(share);
    assert.equal(shared.read_only, true); assert.equal(shared.version, 2); assert.deepEqual(unwrap(shared.snapshot), bytes);
    // The preflight a page at pelagios.org makes before a PUT: answered, PUT and DELETE offered, no credentials.
    const pre = await globalThis.fetch(`${WORKBENCH}projects/${id}/`, { method: 'OPTIONS', headers: { Origin: 'https://pelagios.org', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization, content-type', 'User-Agent': USER_AGENT } });
    assert.ok(pre.status === 204 || pre.status === 200, `preflight ${pre.status}`);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://pelagios.org');
    assert.match(pre.headers.get('access-control-allow-methods') || '', /PUT/); assert.match(pre.headers.get('access-control-allow-methods') || '', /DELETE/);
    assert.match((pre.headers.get('access-control-allow-headers') || '').toLowerCase(), /authorization/);
    assert.equal(pre.headers.get('access-control-allow-credentials'), null);
    await wb.unshare(id);
    await assert.rejects(anyone.shared(share), (e) => e.kind === 'gone');
  } finally {
    if (id) await wb.remove(id);
  }
  if (id) await assert.rejects(wb.get(id), (e) => e.kind === 'gone');
  assert.ok(bodies.length > 10);
  assert.ok(bodies.every((b) => !b.includes(TOKEN)), 'the token is in no body, sent or received');
});
