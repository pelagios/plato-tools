// Methodos's projects in WHG, as the page keeps them (plan #34, item A1): the link beside each workflow's
// record (src/methodos/store.js) and the saving, opening, sharing and matching of src/methodos/whg.js,
// against the fake WHG (test/workbench-fake.js) and a fake IndexedDB. Every absence beside its presence:
// no link left once the workflow goes (beside the link kept while it stays), no share token kept (beside
// the shared flag that is).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { RECIPES, runner, recordOf, refsOf } from '../src/engine/methodos/index.js';
import { readProject, blobSource } from '../src/engine/methodos/project.js';
import { workbench, WorkbenchError } from '../src/engine/workbench.js';
import { workflowStore, cleanLink, LINKS } from '../src/methodos/store.js';
import { whgProjects, stateOf } from '../src/methodos/whg.js';
import { workbenchFake } from './workbench-fake.js';

const TOKEN = 'whg-token-1c2d3e4f5a6b7c8d';
const NOW = new Date('2026-10-14T10:00:00Z');
const MYD = RECIPES['map-your-data'];
class Storage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
async function idbKeys(idb, name) {
  const db = await new Promise((res, rej) => { const r = idb.open(name, 1); r.onupgradeneeded = () => r.result.createObjectStore('workflows'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  try { return await new Promise((res) => { const q = db.transaction('workflows').objectStore('workflows').getAllKeys(); q.onsuccess = () => res(q.result); }); } finally { db.close(); }
}
async function idbGet(idb, name, key) {
  const db = await new Promise((res, rej) => { const r = idb.open(name, 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  try { return await new Promise((res) => { const q = db.transaction('workflows').objectStore('workflows').get(key); q.onsuccess = () => res(q.result); }); } finally { db.close(); }
}
async function workflow(id = 'map-your-data-whg1', name = 'Parishes') {
  const own = new File(['id,name\n1,Mill Farm\n'], 'parishes.csv', { type: 'text/csv' });
  const [table] = await refsOf([own], 'files');
  const s = runner.start(MYD, { 'has-regions': false, 'will-draw': false, 'will-publish': false, target: 'plato-json' }, { files: [table] });
  const record = recordOf({ ...s, id }, { name, now: NOW });
  return { record, project: { record, files: [{ ref: table, blob: own }], tools: { version: 'test', commit: null }, own: (r) => r.sha256 === table.sha256 } };
}
function setup({ keep = () => true } = {}) {
  const fake = workbenchFake();
  fake.addUser({ token: TOKEN });
  const idb = new IDBFactory(), session = new Storage();
  const store = workflowStore({ indexedDB: idb, session, keep });
  const client = workbench({ fetch: (u, i) => fake.fetch(u, i), token: () => TOKEN });
  return { fake, idb, session, store, whg: whgProjects({ client, store, now: () => NOW }) };
}

test('a link is kept beside the record, cleaned, and let go with it; with working data not kept, it lasts for the tab only', async () => {
  const { idb, session, store } = setup();
  const { record } = await workflow();
  await store.save(record);
  const id = record.id, pid = '0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b';
  assert.equal(await store.setLink(id, { projectId: pid, version: 3, sha256: 'a'.repeat(64), shared: true, savedAt: NOW.toISOString(), base: 'https://whgazetteer.org/reconciliation/', title: 'P', token: 'a-share-token-never-kept', extra: 1 }), 'browser');
  const kept = await store.linkFor(id);
  assert.deepEqual(kept, { projectId: pid, version: 3, sha256: 'a'.repeat(64), shared: true, savedAt: NOW.toISOString(), base: 'https://whgazetteer.org/reconciliation/', title: 'P' });
  assert.deepEqual(await idbKeys(idb, LINKS), [id]);
  // What IndexedDB itself holds is the cleaned link: the project's id is there, the token given with it is not.
  const raw = JSON.stringify(await idbGet(idb, LINKS, id));
  assert.ok(raw.includes(pid) && !raw.includes('a-share-token-never-kept') && !raw.includes('extra'), raw);
  // A new page finds it; the record let go, the link goes with it.
  assert.deepEqual(await workflowStore({ indexedDB: idb, session: new Storage(), keep: () => true }).linkFor(id), kept);
  await store.remove(id);
  assert.equal(await store.linkFor(id), null);
  assert.deepEqual(await idbKeys(idb, LINKS), []);
  // Cleaned: what is not a link is not kept (the control: a link is).
  assert.equal(cleanLink({ projectId: 'not-a-uuid', version: 1 }), null);
  assert.equal(cleanLink({ origin: { workflowId: 'map-your-data-x', version: 'x' } }), null);
  assert.equal(cleanLink({ origin: { workflowId: '../x', version: 2 } }), null);
  assert.deepEqual(cleanLink({ origin: { workflowId: 'map-your-data-x', version: 2, title: 'P', token: 'x' } }), { origin: { workflowId: 'map-your-data-x', version: 2, title: 'P' } });
  // Working data not kept: for the tab (its sessionStorage), and nothing in IndexedDB.
  let keep = true;
  const tabStore = workflowStore({ indexedDB: idb, session, keep: () => keep });
  await tabStore.setLink(id, { projectId: pid, version: 1 });
  assert.deepEqual(await idbKeys(idb, LINKS), [id]);
  keep = false;
  assert.equal(await tabStore.setLink(id, { projectId: pid, version: 2 }), 'tab');
  assert.deepEqual((await tabStore.linkFor(id)).version, 2);
  assert.ok(!(await idb.databases()).some((d) => d.name === LINKS), 'not even the database is left');
  assert.equal(await workflowStore({ indexedDB: idb, session: new Storage(), keep: () => false }).linkFor(id), null, 'another tab has none');
});

test('save: a new project in WHG, the link kept with its version and SHA-256; saved again, an update on that version; the state digest says what changed', async () => {
  const { fake, store, whg } = setup();
  const { record, project } = await workflow();
  await store.save(record);
  const first = await whg.save({ project });
  assert.equal(first.created, true); assert.deepEqual(first.tooLarge, []);
  const link = await store.linkFor(record.id);
  assert.equal(link.version, 1); assert.equal(link.shared, false); assert.equal(link.base, 'https://whgazetteer.org/reconciliation/');
  const [p] = fake.projects.values();
  assert.equal(link.projectId, p.id); assert.equal(link.sha256, p.snapshot.sha256); assert.equal(p.title, 'Parishes');
  assert.equal(link.state, stateOf(record, null));
  assert.notEqual(stateOf(record, '{"krisis": 3}'), link.state, 'a review open changes it');
  assert.equal(stateOf({ ...record, saved: '2030-01-01T00:00:00Z' }, null), link.state, 'saving the record again does not');
  const second = await whg.save({ project, to: link });
  assert.equal(second.created, false);
  assert.equal((await store.linkFor(record.id)).version, 2);
  assert.equal(fake.projects.size, 1);
  assert.equal(fake.log.filter((e) => e.method === 'PUT').length, 1);
});

test('the body fitted is the body sent: with WHG\'s cap 10 bytes over the fitted size, a new project is made, not refused (413)', async () => {
  const { fake, whg } = setup();
  const { project } = await workflow();
  const f = await whg.fit(project);
  fake.cfg.bodyMax = f.size + 10;
  const saved = await whg.save({ project });
  assert.equal(saved.created, true);
  const [post] = fake.log.filter((e) => e.method === 'POST');
  assert.equal(Buffer.byteLength(post.body), saved.size, 'what was measured is what was sent');
  assert.ok(saved.size <= fake.cfg.bodyMax);
});

test('a stale save is refused, nothing stored either side, and the link stays at the version it was; "save mine as new" makes a second project, linked from then', async () => {
  const { fake, store, whg } = setup();
  const { record, project } = await workflow();
  const { link } = await whg.save({ project });
  fake.pushAs(link.projectId, { plato: 1, from: 'another browser' });
  await assert.rejects(whg.save({ project, to: link }), (e) => e instanceof WorkbenchError && e.kind === 'conflict' && e.version === 2 && e.snapshot.from === 'another browser');
  assert.equal((await store.linkFor(record.id)).version, 1);
  assert.equal(fake.projects.get(link.projectId).version, 2);
  const mine = await whg.save({ project });
  assert.equal(mine.created, true);
  assert.notEqual(mine.link.projectId, link.projectId);
  assert.equal((await store.linkFor(record.id)).projectId, mine.link.projectId);
  assert.equal(fake.projects.size, 2);
});

test('a project deleted in WHG (404) lets the link go; a copy\'s origin stays', async () => {
  const { fake, store, whg } = setup();
  const { record, project } = await workflow();
  const { link } = await whg.save({ project });
  await store.setLink(record.id, { ...link, origin: { workflowId: 'map-your-data-orig', version: 4 } });
  assert.ok((await store.linkFor(record.id)).projectId);
  fake.projects.delete(link.projectId);
  await assert.rejects(whg.save({ project, to: link }), (e) => e.kind === 'gone');
  assert.deepEqual(await store.linkFor(record.id), { origin: { workflowId: 'map-your-data-orig', version: 4 } });
});

test('open from WHG: the list (title, role, updated), a project opened as a file readProject reads, and the link kept at its version', async () => {
  const { store, whg } = setup();
  const { record, project } = await workflow();
  const { link } = await whg.save({ project });
  const list = await whg.list();
  assert.deepEqual(list.map((p) => [p.id, p.title, p.role, p.version]), [[link.projectId, 'Parishes', 'owner', 1]]);
  const got = await whg.open(link.projectId);
  assert.equal(got.name, 'Parishes.platoproj'); assert.equal(got.version, 1); assert.equal(got.role, 'owner');
  const read = await readProject(blobSource(got.blob), { name: got.name });
  assert.deepEqual(read.record, record);
  // Another browser: no link, until the opened workflow is the record kept.
  const other = workflowStore({ indexedDB: new IDBFactory(), session: new Storage(), keep: () => true });
  assert.equal(await other.linkFor(record.id), null);
  const again = whgProjects({ client: workbench({ fetch: () => { throw new Error('not asked'); } }), store: other, now: () => NOW });
  await again.opened(read.record, { ...got, projectId: link.projectId });
  assert.deepEqual(await other.linkFor(record.id), { projectId: link.projectId, version: 1, sha256: got.sha256, shared: false, savedAt: NOW.toISOString(), base: 'https://whgazetteer.org/reconciliation/', title: 'Parishes', state: stateOf(read.record, null) });
});

test('matching a workflow with no link: only projects that hold it (its id and when it was begun), titled as it is, that you can save to', async () => {
  const { fake, whg, store } = setup();
  const a = await workflow('map-your-data-a', 'Parishes');
  const b = await workflow('map-your-data-b', 'Parishes');
  const saved = await whg.save({ project: a.project });
  await whg.save({ project: b.project });
  await whg.save({ project: (await workflow('map-your-data-c', 'Other')).project });
  await store.setLink(a.record.id, null);   // as in another browser: the link is not here
  const n = fake.log.length;
  const m = await whg.matches(a.record);
  assert.deepEqual(m.map((p) => p.id), [saved.link.projectId]);
  // Only the two titled "Parishes" were opened to see (a list, and two gets), never "Other".
  assert.deepEqual(fake.log.slice(n).map((e) => e.method), ['GET', 'GET', 'GET']);
  // A viewer's copy is not offered (the presence: the owner's is, above).
  const viewer = fake.addUser({ token: 'viewer-token-7654321' });
  fake.moveTo(saved.link.projectId, fake.addTeam(fake.users.get(1), [[viewer, 'viewer']]));
  const asViewer = whgProjects({ client: workbench({ fetch: (u, i) => fake.fetch(u, i), token: () => 'viewer-token-7654321' }), store, now: () => NOW });
  assert.deepEqual(await asViewer.matches(a.record), []);
  assert.equal((await asViewer.list()).length, 1);
});

test('sharing: shared and stopped through the link, the token handed to the page and never kept; what the link opens, read with no token', async () => {
  const { fake, idb, session, store, whg } = setup();
  const { record, project } = await workflow();
  await store.save(record);
  await assert.rejects(whg.share(record.id), (e) => e.kind === 'gone' && /not saved to WHG yet/.test(e.message));
  await whg.save({ project });
  const token = await whg.share(record.id);
  assert.match(token, /^[0-9a-f-]{36}$/);
  assert.equal((await store.linkFor(record.id)).shared, true);
  // The token is in no store (the presence: the link, with shared: true, is).
  const stored = JSON.stringify(await store.linkFor(record.id)) + JSON.stringify([...session.m.values()]);
  assert.ok(stored.includes('"shared":true') && !stored.includes(token));
  const anyone = whgProjects({ client: workbench({ fetch: (u, i) => fake.fetch(u, i), token: () => null }), store: workflowStore({ indexedDB: new IDBFactory(), session: new Storage() }), now: () => NOW });
  const got = await anyone.shared(token);
  assert.equal(got.title, 'Parishes'); assert.equal(got.version, 1);
  assert.deepEqual((await readProject(blobSource(got.blob))).record, record);
  await whg.unshare(record.id);
  assert.equal((await store.linkFor(record.id)).shared, false);
  await assert.rejects(anyone.shared(token), (e) => e.kind === 'gone');
  assert.ok(idb);
});
