// Methodos's projects in WHG's Workbench (plan #34, item A1; src/engine/workbench.js), against a fake of
// WHG that copies its code (test/workbench-fake.js): never the real WHG (test/workbench-live.test.js
// does that, by hand, with a token). Every refusal has its control beside it (the same request, as it
// should be, goes), and every absence its presence (no token in any address, beside the token found in
// the Authorization header of the same requests).
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { RECIPES, runner, recordOf, refsOf } from '../src/engine/methodos/index.js';
import { readProject, blobSource, writeProject } from '../src/engine/methodos/project.js';
import { workbench, envelope, unwrap, workflowOf, fitProject, withPause, bodySize, shareLink, sharedToken, toBase64, fromBase64, titleOf, whyWords,
  WorkbenchError, WORDS, BODY_MAX, WORKBENCH, ENROL } from '../src/engine/workbench.js';
import { workbenchFake, jsonb } from './workbench-fake.js';

const TOKEN = 'whg-token-5e1d7c9a3b2f4e60';
const OTHER = 'whg-token-0a9b8c7d6e5f4a3b';
const NOW = new Date('2026-10-14T10:00:00Z');
const file = (bytes, name, type = 'application/octet-stream') => new File([bytes], name, { type });
const MYD = RECIPES['map-your-data'];

/** A workflow at its check step: begun with `own` (the user's file), its columns matched; and `outputs` more step files made. */
async function workflow({ own = file('id,name\n1,Mill Farm\n', 'parishes.csv', 'text/csv'), outputs = [] } = {}) {
  const [table] = await refsOf([own], 'files');
  let s = runner.start(MYD, { 'has-regions': false, 'will-draw': false, 'will-publish': false, target: 'plato-json' }, { files: [table] });
  const mappingFile = file('{"name": "name"}', 'columns.json', 'application/json');
  const [mapping] = await refsOf([mappingFile, ...outputs], 'mapping');
  const extra = outputs.length ? await refsOf(outputs, 'mapping') : [];
  s = runner.complete(runner.next(s), 'columns', { mapping: [mapping, ...extra] });
  const record = recordOf({ ...s, id: 'map-your-data-wb1' }, { name: 'Parishes', now: NOW });
  const files = [{ ref: table, blob: own }, { ref: mapping, blob: mappingFile }, ...extra.map((ref, i) => ({ ref, blob: outputs[i] }))];
  return { record, files, table, mapping, extra };
}
async function projectBytes(w) {
  const chunks = [];
  await writeProject({ record: w.record, files: w.files, tools: { version: 'test', commit: null }, now: NOW }, (c) => { chunks.push(c); });
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}
/** A client of `fake` as the user of `token`, every request seen. */
function client(fake, token = TOKEN, wrap = (f) => f) {
  return workbench({ fetch: wrap((url, init) => fake.fetch(url, init)), token: () => token });
}
const setup = () => { const fake = workbenchFake({ clock: () => NOW.getTime() }); fake.addUser({ token: TOKEN, name: 'alice' }); return fake; };
const rejects = (p, kind, re) => assert.rejects(p, (e) => e instanceof WorkbenchError && e.kind === kind && (!re || re.test(e.message)) && !e.message.includes(TOKEN));

test('the envelope: the project as base64 with its size and SHA-256, read back by readProject whole after a JSON round trip that reorders its keys, as WHG\'s jsonb does', async () => {
  const w = await workflow();
  const bytes = await projectBytes(w);
  const snap = envelope(bytes, w.record);
  assert.deepEqual(Object.keys(snap), ['plato', 'format', 'workflow', 'formatVersion', 'project', 'size', 'sha256']);
  assert.equal(snap.plato, 1); assert.equal(snap.formatVersion, '1.1'); assert.equal(snap.size, bytes.length);
  assert.deepEqual(snap.workflow, { id: 'map-your-data-wb1', name: 'Parishes', created: w.record.created });
  // As WHG gives it back: keys in jsonb's order (the control: that order is not the one sent), white space gone.
  const back = JSON.parse(JSON.stringify(jsonb(JSON.parse(JSON.stringify(snap, null, 2)))));
  assert.notDeepEqual(Object.keys(back), Object.keys(snap));
  assert.deepEqual(Object.keys(back), ['size', 'plato', 'format', 'sha256', 'project', 'workflow', 'formatVersion']);
  const got = unwrap(back);
  assert.deepEqual(got, bytes);
  const read = await readProject(blobSource(new Blob([got])), { name: 'Parishes.platoproj' });
  assert.deepEqual(read.record, w.record);
  assert.deepEqual(workflowOf(back), { id: 'map-your-data-wb1', created: w.record.created, name: 'Parishes' });
});

test('the envelope is checked before anything is read from it: its format, its version, its base64, its size and its SHA-256; the same envelope untouched opens', async () => {
  const bytes = await projectBytes(await workflow());
  const snap = envelope(bytes, { id: 'x', name: 'x', created: 'x' });
  assert.deepEqual(unwrap(snap), bytes);   // the control
  const bad = (change, re) => assert.throws(() => unwrap({ ...snap, ...change }), (e) => e instanceof WorkbenchError && e.kind === 'not-ours' && re.test(e.message));
  bad({ format: 'reconciliation' }, /not a PLATO tools project kept in WHG: it does not say it is one/);
  bad({ plato: 2 }, /saved to WHG by newer PLATO tools/);
  bad({ project: snap.project.slice(0, -1) }, /not base64/);
  bad({ project: `${snap.project.slice(0, 8)}*${snap.project.slice(9)}` }, /not base64/);
  bad({ size: bytes.length + 1 }, /size or SHA-256 differs/);
  bad({ sha256: 'f'.repeat(64) }, /size or SHA-256 differs/);
  assert.throws(() => unwrap(null), /does not say it is one/);
  // The envelope's workflow is for matching only: a forged one changes nothing that is read (the record inside is the one opened).
  const forged = unwrap({ ...snap, workflow: { id: 'someone-else', name: 'Forged', created: 'never' } });
  assert.equal((await readProject(blobSource(new Blob([forged])))).record.id, 'map-your-data-wb1');
});

test('base64, both ways, for every length and every byte, and refused when it is not', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 255, 256, 257, 70000]) {
    const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
    const t = toBase64(b);
    assert.equal(t, Buffer.from(b).toString('base64'), `length ${n}`);
    assert.deepEqual(fromBase64(t), b, `length ${n}`);
  }
  for (const t of ['abc', 'ab=c', '====', 'ab\ncd==', 'ab cd===', 'é123']) assert.equal(fromBase64(t), null, JSON.stringify(t));
});

test('a NUL byte in the project travels in its base64; the same bytes as text in the snapshot are refused by WHG\'s store', async () => {
  const own = file(new Uint8Array([0x50, 0x00, 0x41, 0x00]), 'nul.bin');
  const w = await workflow({ own });
  const fake = setup(), wb = client(fake);
  const bytes = await projectBytes(w);
  const made = await wb.create({ snapshot: envelope(bytes, w.record), title: titleOf(w.record) });
  assert.deepEqual(unwrap((await wb.get(made.id)).snapshot), bytes);
  await rejects(wb.create({ snapshot: { text: 'P\u0000A' }, title: 'x' }), 'server', /WHG answered with an error \(500\)/);
});

test('the token goes in the Authorization header and nowhere else: never in an address, a body or an error; with no token nothing is sent', async () => {
  const fake = setup();
  const sent = [];
  const wb = client(fake, TOKEN, (f) => (url, init) => { sent.push({ url, init }); return f(url, init); });
  const w = await workflow();
  const made = await wb.create({ snapshot: envelope(await projectBytes(w), w.record), title: 'Parishes' });
  await wb.get(made.id); await wb.push(made.id, { snapshot: { plato: 1 }, base_version: 1 }); await wb.list(); await wb.share(made.id);
  // The presence: five requests, each with the token in its header, credentials omitted, redirects not followed.
  assert.equal(sent.length, 5);
  for (const s of sent) {
    assert.equal(s.init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(s.init.credentials, 'omit'); assert.equal(s.init.redirect, 'manual');
    assert.ok(s.url.startsWith(WORKBENCH), s.url);
  }
  // The absence: in no address, no body, nothing the fake logged but that header.
  for (const s of sent) assert.ok(!s.url.includes(TOKEN) && !String(s.init.body ?? '').includes(TOKEN), s.url);
  for (const e of fake.log) { assert.ok(!e.url.includes(TOKEN) && !e.body.includes(TOKEN)); assert.equal(e.headers.authorization, `Bearer ${TOKEN}`); }
  // With no token: refused before anything is sent (the same calls, which went above).
  const none = workbench({ fetch: (url, init) => { sent.push({ url, init }); return fake.fetch(url, init); }, token: () => null });
  const before = sent.length;
  await rejects(none.list(), 'token', /Nothing was sent/);
  await rejects(none.create({ snapshot: {} }), 'token');
  await rejects(none.push(made.id, { snapshot: {}, base_version: 2 }), 'token');
  assert.equal(sent.length, before);
  // Only an id goes into an address: anything else is refused unsent.
  await rejects(wb.get('../projects/?token=x'), 'not-ours');
  await rejects(wb.get(made.id.toUpperCase()), 'not-ours');
  assert.equal(sent.length, before);
});

test('save, open and push: created in the personal team as version 1, listed with its role, a push on the current version is version 2, and the title is the workflow\'s', async () => {
  const fake = setup(), wb = client(fake);
  const w = await workflow();
  const made = await wb.create({ snapshot: envelope(await projectBytes(w), w.record), title: titleOf(w.record) });
  assert.equal(made.version, 1); assert.equal(made.role, 'owner'); assert.equal(made.doc_type, 'plato');
  const [listed] = await wb.list();
  assert.deepEqual([listed.id, listed.title, listed.role, listed.version, listed.shared], [made.id, 'Parishes', 'owner', 1, false]);
  // Another kind of project in the same team is not listed (the presence: ours is).
  fake.handle({ method: 'POST', url: '/reconciliation/projects/', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ snapshot: { rows: [] }, title: 'MyD' }) });
  assert.deepEqual((await wb.list()).map((p) => p.id), [made.id]);
  const pushed = await wb.push(made.id, { snapshot: envelope(await projectBytes(w), w.record), base_version: 1, title: 'Parishes again' });
  assert.deepEqual(pushed, { status: 'ok', version: 2, snapshot: null });
  assert.equal((await wb.list())[0].title, 'Parishes again');
});

test('a stale push is refused whole (409), with WHG\'s version and snapshot, and nothing is stored; pushed on that version, it goes', async () => {
  const fake = setup(), wb = client(fake);
  const w = await workflow();
  const bytes = await projectBytes(w);
  const made = await wb.create({ snapshot: envelope(bytes, w.record), title: 'Parishes' });
  fake.pushAs(made.id, { plato: 1, from: 'another browser' });
  let conflict = null;
  await assert.rejects(wb.push(made.id, { snapshot: envelope(bytes, w.record), base_version: 1 }), (e) => { conflict = e; return e.kind === 'conflict'; });
  assert.equal(conflict.version, 2);
  assert.deepEqual(conflict.snapshot, { from: 'another browser', plato: 1 });
  assert.equal(fake.projects.get(made.id).version, 2);
  assert.deepEqual(fake.projects.get(made.id).snapshot, { from: 'another browser', plato: 1 });
  assert.equal((await wb.push(made.id, { snapshot: envelope(bytes, w.record), base_version: 2 })).version, 3);
});

test('every refusal in words, each with its control: 401, 403 beta (with the enrolment page), 403 origin, 403 for a viewer, 404, 413, 429, 400 and 500', async () => {
  const fake = setup(), wb = client(fake);
  const made = await wb.create({ snapshot: { plato: 1 }, title: 'x' });
  // 401: a token WHG does not know (control: the right one lists).
  await rejects(client(fake, 'not-a-token-at-all').list(), 'unauthenticated', /did not accept your token/);
  assert.equal((await wb.list()).length, 1);
  // 403 beta_required: an account not enrolled; nothing to join here, WHG's page named.
  fake.addUser({ token: OTHER, beta: false });
  let beta;
  await assert.rejects(client(fake, OTHER).list(), (e) => { beta = e; return e.kind === 'beta'; });
  assert.equal(beta.link, ENROL); assert.match(beta.message, /not enrolled/); assert.match(beta.message, /Get in touch/);
  // 403 origin_not_allowed: an Origin outside the allow-list (control: pelagios.org's, and none, as Node's).
  const from = (origin) => client(fake, TOKEN, (f) => (url, init) => f(url, { ...init, headers: { ...init.headers, Origin: origin } }));
  await rejects(from('https://evil.example.org').list(), 'origin', /only from the tools at pelagios\.org/);
  assert.equal((await from('https://pelagios.org').list()).length, 1);
  // 403 without a code: a viewer cannot save, or delete; an editor can save, not delete.
  const viewer = fake.addUser({ token: 'viewer-token-1234567' }), editor = fake.addUser({ token: 'editor-token-1234567' });
  const team = fake.addTeam(fake.users.get(1), [[viewer, 'viewer'], [editor, 'editor']]);
  fake.moveTo(made.id, team);
  const asViewer = client(fake, 'viewer-token-1234567'), asEditor = client(fake, 'editor-token-1234567');
  let e403;
  await assert.rejects(asViewer.push(made.id, { snapshot: { plato: 1 }, base_version: 1 }), (e) => { e403 = e; return e.kind === 'forbidden'; });
  assert.equal(whyWords(e403, 'save'), WORDS.forbidden.save);
  assert.equal((await asViewer.get(made.id)).role, 'viewer');
  assert.equal((await asEditor.push(made.id, { snapshot: { plato: 1 }, base_version: 1 })).version, 2);
  await assert.rejects(asEditor.remove(made.id), (e) => e.kind === 'forbidden' && whyWords(e, 'delete') === WORDS.forbidden.delete);
  // 404: deleted (control: it was there).
  assert.equal((await wb.get(made.id)).version, 2);
  await wb.remove(made.id);
  await rejects(wb.get(made.id), 'gone', /no longer has this project/);
  // 413: over the cap, with WHG's limit and the size (control: under it, created).
  fake.cfg.bodyMax = 2000;
  let big;
  await assert.rejects(wb.create({ snapshot: { plato: 1, pad: 'x'.repeat(3000) } }), (e) => { big = e; return e.kind === 'too-large'; });
  assert.equal(big.limit, 2000); assert.ok(big.size > 3000); assert.match(big.message, /Too large for WHG/);
  assert.equal((await wb.create({ snapshot: { plato: 1, pad: 'x'.repeat(100) } })).version, 1);
  fake.cfg.bodyMax = BODY_MAX;
  // 429: the per-minute budget, with WHG's Retry-After (control: within it, answered).
  fake.cfg.rate = 2; fake.newMinute();
  assert.ok(await wb.list()); assert.ok(await wb.list());
  let r429;
  await assert.rejects(wb.list(), (e) => { r429 = e; return e.kind === 'rate'; });
  assert.ok(r429.retryAfter >= 1 && r429.retryAfter <= 60); assert.match(r429.message, /pause of \d+ seconds?/);
  fake.cfg.rate = 120; fake.newMinute();
  // 400 and 500, as WHG says them; and the words a page shows for each, which never name the token.
  await rejects(wb.push(made.id.replace(/.$/, '0'), { snapshot: { plato: 1 }, base_version: 1 }), 'gone');
  const bad = workbench({ fetch: async () => new Response('{"error": "base_version (int) is required"}', { status: 400 }), token: () => TOKEN });
  await rejects(bad.list(), 'refused', /base_version \(int\) is required/);
  const down = workbench({ fetch: async () => new Response('<h1>Bad Gateway</h1>', { status: 502 }), token: () => TOKEN });
  await assert.rejects(down.list(), (e) => e.kind === 'server' && whyWords(e, 'save') === 'Not saved to WHG. Your work is kept in this browser. WHG answered with an error (502).');
  const offline = workbench({ fetch: async () => { throw new TypeError('Failed to fetch'); }, token: () => TOKEN });
  await assert.rejects(offline.list(), (e) => e.kind === 'network' && /^Not saved to WHG\. Your work is kept in this browser\. WHG could not be reached/.test(whyWords(e, 'save')));
  const refused = workbench({ fetch: async () => { throw Object.assign(new Error('World Historical Gazetteer Workbench has not been allowed: see Permissions.'), { name: 'PermissionError', kind: 'undecided' }); }, token: () => TOKEN });
  await assert.rejects(refused.list(), (e) => e.kind === 'permission' && whyWords(e, 'save') === 'Not saved to WHG. Your work is kept in this browser. World Historical Gazetteer Workbench has not been allowed: see Permissions.');
  // A redirect is never followed, and never taken for an answer.
  const moved = workbench({ fetch: async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.org/' } }), token: () => TOKEN });
  await rejects(moved.list(), 'server', /sending the request elsewhere/);
});

test('a pause asked for (429) is waited once, as long as WHG asks, then the request is made again; asked again, it stops in words', async () => {
  const fake = setup(), wb = client(fake);
  fake.cfg.rate = 1; fake.newMinute();
  await wb.list();
  const waited = [];
  // Waited, and a new minute begins meanwhile: the second try is answered.
  const got = await withPause(() => wb.list(), async (s) => { waited.push(s); fake.newMinute(); await wb.list(); fake.newMinute(); });
  assert.equal(waited.length, 1); assert.ok(waited[0] >= 1);
  assert.ok(Array.isArray(got));
  // Waited, and still refused: stopped, once, in words.
  fake.newMinute(); await wb.list();
  const twice = [];
  await assert.rejects(withPause(() => wb.list(), async (s) => { twice.push(s); }), (e) => e.kind === 'rate' && e.again === true && e.message === WORDS.rateAgain);
  assert.equal(twice.length, 1);
  // Anything else is not waited for.
  const none = [];
  await assert.rejects(withPause(() => client(fake, 'unknown-token-123').list(), async (s) => { none.push(s); }), (e) => e.kind === 'unauthenticated');
  assert.equal(none.length, 0);
});

test('sharing: a token for a read-only link, read with no Authorization at all; stopped, the link opens nothing; shared again, a new token', async () => {
  const fake = setup(), wb = client(fake);
  const w = await workflow();
  const bytes = await projectBytes(w);
  const made = await wb.create({ snapshot: envelope(bytes, w.record), title: 'Parishes' });
  const { token, url } = await wb.share(made.id);
  assert.match(token, /^[0-9a-f-]{36}$/); assert.equal(url, null);
  assert.equal((await wb.share(made.id)).token, token, 'shared again while shared: the same token');
  const anyone = workbench({ fetch: (u, i) => fake.fetch(u, i), token: () => { throw new Error('the token was asked for'); } });
  const n = fake.log.length;
  const got = await anyone.shared(token);
  assert.equal(got.read_only, true); assert.equal(got.doc_type, 'plato'); assert.equal(got.title, 'Parishes');
  assert.deepEqual(unwrap(got.snapshot), bytes);
  const req = fake.log[n];
  assert.equal(req.path, `/reconciliation/shared/${token}/`);
  assert.equal(req.headers.authorization, undefined);
  // The newest save, not the one shared: a push after sharing is what the link shows.
  fake.pushAs(made.id, envelope(new Uint8Array([1, 2, 3]), w.record));
  assert.equal((await anyone.shared(token)).version, 2);
  await wb.unshare(made.id);
  await assert.rejects(anyone.shared(token), (e) => e.kind === 'gone' && whyWords(e, 'shared') === WORDS.goneShared);
  const again = (await wb.share(made.id)).token;
  assert.notEqual(again, token);
  assert.equal((await anyone.shared(again)).version, 2);
  // A link to another kind of project is refused (the control: ours above opened).
  const myd = JSON.parse(fake.handle({ method: 'POST', url: '/reconciliation/projects/', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ snapshot: { rows: [] }, title: 'MyD' }) }).body);
  const other = (await wb.share(myd.id)).token;
  await rejects(anyone.shared(other), 'not-ours', /another kind/);
  // Not a token: refused unsent.
  const before = fake.log.length;
  await assert.rejects(anyone.shared('not-a-token'), (e) => e.kind === 'gone');
  assert.equal(fake.log.length, before);
});

test('the share link: the page\'s own address and #whg-shared=<token>, read back from an address or a fragment', () => {
  const t = '0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b';
  assert.equal(shareLink('https://pelagios.org/plato-tools/#tool=check', t), `https://pelagios.org/plato-tools/#whg-shared=${t}`);
  assert.equal(shareLink('http://localhost:4174/?x=1', t), `http://localhost:4174/?x=1#whg-shared=${t}`);
  assert.equal(sharedToken(`https://pelagios.org/plato-tools/#whg-shared=${t}`), t);
  assert.equal(sharedToken(`#whg-shared=${t}`), t);
  assert.equal(sharedToken(`#tool=match&whg-shared=${t}`), t);
  for (const bad of ['#whg-shared=', `#whg-shared=${t.toUpperCase()}`, `#whg-shared=${t}x`, `https://pelagios.org/?whg-shared=${t}`, '#tool=check', null]) assert.equal(sharedToken(bad), null, String(bad));
  assert.throws(() => shareLink('https://pelagios.org/', 'x'), WorkbenchError);
});

test('D1: over WHG\'s cap, files are left out, the user\'s own first, then the largest of the steps\', each listed as too-large; the record never; the body measured is the one sent, and WHG takes it', async () => {
  // Random bytes, which DEFLATE cannot make smaller: each file's share of the body is known in advance (4/3 of its size).
  const noise = (n) => randomBytes(n);
  const own = file(noise(30000, 1), 'parishes.bin');
  const outputs = [file(noise(20000, 2), 'big.json', 'application/json'), file(noise(9000, 3), 'small.json', 'application/json')];
  const w = await workflow({ own, outputs });
  const isOwn = (ref) => ref.sha256 === w.table.sha256;
  const fit = (max, extra = {}) => fitProject({ record: w.record, files: w.files, tools: { version: 'test', commit: null }, now: NOW, own: isOwn, max, bodyOf: (snapshot) => ({ snapshot, title: 'Parishes', ...extra }) });
  // Room for all: nothing left out (the control).
  const all = await fit(BODY_MAX);
  assert.deepEqual(all.tooLarge, []);
  const ample = all.size;
  // Room for all but the user's own file: it alone goes.
  const a = await fit(ample - 30000);
  assert.deepEqual(a.tooLarge.map((r) => r.name), ['parishes.bin']);
  // Less: then the larger of the steps' files, then the smaller; the record and the columns (the smallest) stay longest.
  const b = await fit(ample - 45000);
  assert.deepEqual(b.tooLarge.map((r) => r.name), ['parishes.bin', 'big.json']);
  for (const f of [all, a, b]) {
    assert.equal(bodySize(f.body), f.size); assert.ok(f.size <= (f === all ? BODY_MAX : f === a ? ample - 30000 : ample - 45000));
    const read = await readProject(blobSource(new Blob([unwrap(f.snapshot)])));
    assert.deepEqual(read.manifest.left || [], f.tooLarge.map((r) => ({ name: r.name, size: r.size, sha256: r.sha256, why: 'too-large' })));
    assert.deepEqual(read.record, w.record);
  }
  // WHG at that cap takes the fitted body, and refuses the whole one (413): what was measured is what it measures.
  const fake = setup(), wb = client(fake);
  fake.cfg.bodyMax = ample - 30000;
  await assert.rejects(wb.create({ snapshot: all.snapshot, title: 'Parishes' }), (e) => e.kind === 'too-large');
  assert.equal((await wb.create({ snapshot: a.snapshot, title: 'Parishes' })).version, 1);
  // Too small even for the record: refused in words that offer the file instead.
  await assert.rejects(fit(600), (e) => e instanceof WorkbenchError && e.kind === 'too-large' && /even with every file left out/.test(e.message) && /“Save the project”/.test(e.message));
});

test('fitProject keeps the project\'s own refusals: a part that holds the token is not saved, to WHG as to a file', async () => {
  const own = file(`id,name\n1,${TOKEN}\n`, 'leaky.csv', 'text/csv');
  const w = await workflow({ own });
  await assert.rejects(fitProject({ record: w.record, files: w.files, tools: { version: 'test', commit: null }, refuse: [TOKEN], own: (r) => r.sha256 === w.table.sha256 }), /holds your WHG token/);
  // The control: without the token in it, it fits.
  const clean = await workflow();
  assert.deepEqual((await fitProject({ record: clean.record, files: clean.files, tools: { version: 'test', commit: null }, refuse: [TOKEN] })).tooLarge, []);
});

test('the fake is WHG\'s, in what the page relies on: CORS for the allow-list only and never with credentials, a preflight without a token, JSON refusals, 405 with Allow, and the HTML 404 off its paths', async () => {
  const fake = setup();
  const pre = fake.handle({ method: 'OPTIONS', url: '/reconciliation/projects/', headers: { Origin: 'https://pelagios.org', 'Access-Control-Request-Method': 'PUT' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['Access-Control-Allow-Origin'], 'https://pelagios.org');
  assert.match(pre.headers['Access-Control-Allow-Headers'], /Authorization/);
  assert.equal(pre.headers['Access-Control-Allow-Credentials'], undefined);
  const elsewhere = fake.handle({ method: 'OPTIONS', url: '/reconciliation/projects/', headers: { Origin: 'https://evil.example.org' } });
  assert.equal(elsewhere.status, 204); assert.equal(elsewhere.headers['Access-Control-Allow-Origin'], undefined);
  const r401 = fake.handle({ method: 'GET', url: '/reconciliation/projects/', headers: { Origin: 'https://pelagios.org' } });
  assert.equal(r401.status, 401); assert.equal(r401.headers['Access-Control-Allow-Origin'], 'https://pelagios.org'); assert.match(r401.headers['WWW-Authenticate'], /Bearer/);
  assert.equal(fake.handle({ method: 'GET', url: `/reconciliation/projects/?token=${TOKEN}`, headers: {} }).status, 401, 'never ?token=');
  const r405 = fake.handle({ method: 'PATCH', url: '/reconciliation/projects/', headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(r405.status, 405); assert.equal(r405.headers.Allow, 'GET, POST, OPTIONS');
  assert.equal(fake.handle({ method: 'GET', url: '/reconciliation/nothing/', headers: {} }).headers['Content-Type'], 'text/html');
  assert.equal(fake.handle({ method: 'GET', url: '/reconciliation/projects', headers: {} }).status, 301);
});
