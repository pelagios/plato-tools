// Agora's address scheme and its tree of outputs: the addresses every part of publishing agrees on,
// and the folder (command line) or zip (browser) a part writes its files into.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync, strFromU8 } from 'fflate';
import { scheme, baseKind, normaliseBase, keyProblem, releaseProblem, caseGuard, servable, servability, sourcesOf, SUFFIXES } from '../src/engine/agora/address.js';
import { openTree, put } from '../src/engine/agora/tree.js';
import { tableIds } from '../src/formats/tables.js';
import { NodeHost } from '../src/node/host.js';
import { env, res } from './engine.js';

test('a base gains its closing slash; what is not an http(s) address is no base', () => {
  assert.equal(normaliseBase('https://w3id.org/x'), 'https://w3id.org/x/');
  assert.equal(normaliseBase('https://w3id.org/x/'), 'https://w3id.org/x/');
  for (const bad of ['', 'w3id.org/x', 'ftp://w3id.org/x', 'https://w3id.org/x?y', 'https://w3id.org/x#', null, 42]) assert.equal(normaliseBase(bad), null, String(bad));
});

test('the kind of a base address says how long its addresses may last', () => {
  const cases = {
    'https://w3id.org/whg-epns/': 'w3id', 'https://w3id.org/pelagios/customs/': 'w3id',
    'https://w3id.org/': 'custom',   // w3id's own root is no namespace
    'https://pelagios.github.io/customs/': 'github.io', 'http://localhost:4173/': 'local', 'http://192.168.1.4/x/': 'local',
    'https://example.org/my-dataset/': 'example', 'https://whgazetteer.org/example/customs/': 'example',
    'https://whgazetteer.org/place/': 'custom', 'https://data.history.ac.uk/customs/': 'custom',
  };
  for (const [base, kind] of Object.entries(cases)) assert.equal(baseKind(base), kind, base);
  assert.equal(baseKind('nonsense'), 'none');
});

test('the scheme makes the addresses the tables make, and finds the key in each', () => {
  const s = scheme('https://w3id.org/pelagios/customs');
  assert.equal(s.base, 'https://w3id.org/pelagios/customs/');
  assert.equal(s.w3idPath, 'pelagios/customs');
  assert.equal(s.dataset, s.base);
  assert.equal(s.stem, 'customs');
  assert.equal(scheme('https://gazetteer.example.ac.uk/').stem, 'gazetteer-example-ac-uk');
  // The same addresses as reading spreadsheet tables makes (formats/tables.js), which PLATO makes normative.
  const t = tableIds(s.base, () => null);
  for (const id of ['bristol', 'St Ives', 'a/b', "St Mary's (Old)!*", 'Zürich']) {
    assert.equal(s.place(id), t.place(id));
    assert.equal(s.source(id), t.sourceIri(id));
  }
  // PLATO's rule: everything but RFC 3986's unreserved characters is encoded, ! ' ( ) * too, which
  // encodeURIComponent leaves alone; the unreserved ones are not (the control).
  assert.equal(s.place("St Mary's (Old)!*"), s.base + 'place/St%20Mary%27s%20%28Old%29%21%2A');
  assert.equal(s.source('a-b.c_d~e'), s.base + 'source/a-b.c_d~e');
  assert.equal(s.placeKey(s.place('bristol')), 'bristol');
  assert.equal(s.placeKey(s.place('bristol') + '#a-12345678'), 'bristol');
  assert.equal(s.sourceKey(s.source('tna-e190')), 'tna-e190');
  // Not under this base, or in the other part, or deeper: no key.
  assert.equal(s.placeKey('https://w3id.org/pelagios/other/place/bristol'), null);
  assert.equal(s.placeKey(s.source('bristol')), null);
  assert.equal(s.placeKey(s.base + 'place/a/b'), null);
  assert.equal(s.placeKey(s.base + 'place/'), null);
  assert.equal(s.release('data-2026-10-01'), s.base + 'release/data-2026-10-01');
  assert.equal(s.attestation(s.place('bristol'), 'deadbeef'), s.base + 'place/bristol#a-deadbeef');
  assert.deepEqual(s.files('place', 'bristol'), { html: 'place/bristol/index.html', jsonld: 'place/bristol.jsonld', ttl: 'place/bristol.ttl', dir: 'place/bristol/' });
  assert.equal(scheme('not a url'), null);
});

test('keys that a static site cannot serve are found, and ordinary ones pass', () => {
  for (const ok of ['bristol', 'St_Ives', 'a.b-c~d', '000002']) assert.equal(keyProblem(ok), null, ok);
  for (const bad of ['', 'St%20Ives', 'a%2Fb', 'Zürich', '..', '.hidden']) assert.ok(keyProblem(bad), bad);
  assert.equal(releaseProblem('data-2026-10-01'), null);
  assert.equal(releaseProblem('0.7.1'), null);
  for (const bad of ['', '.x', 'a/b', 'a b', undefined]) assert.ok(releaseProblem(bad), String(bad));
});

test('one rule says which addresses the site and the w3id rules can serve, and why not', () => {
  const s = scheme('https://w3id.org/pelagios/customs/');
  const B = s.base;
  const cases = [
    ['place', B + 'place/bristol#a-1', { key: 'bristol' }],
    ['source', B + 'source/tna-e190', { key: 'tna-e190' }],
    ['source', B + 'source/gazetteer/geonames', { problem: 'key', why: /more than one part/ }],
    ['place', B + 'place/kent/dover', { problem: 'key', why: /more than one part/ }],
    ['source', B + 'volume/12', { problem: 'elsewhere', why: /not under https:\/\/w3id\.org\/pelagios\/customs\/source\// }],
    ['place', B + 'places/p-1', { problem: 'elsewhere' }],
    ['place', B + 'source/x', { problem: 'elsewhere' }],   // a source's address is not a place's
    ['source', 'https://other.org/source/x', { problem: 'outside' }],
    ['place', B + 'place/london.html', { problem: 'key', why: /ends in \.jsonld, \.ttl, \.html/, suffix: true }],
    ['place', B + 'place/London.JSONLD', { problem: 'key', suffix: true }],
    ['place', B + 'place/St%20Ives', { problem: 'key', why: /characters other than/ }],
    ['place', B + 'place/', { problem: 'key', why: /is empty/ }],
    ['place', B + 'place/.hidden', { problem: 'key', why: /starts with '\.'/ }],
  ];
  for (const [part, iri, want] of cases) {
    const r = servable(s, part, iri);
    if (want.key) { assert.deepEqual(r, { key: want.key }, iri); continue; }
    assert.equal(r.key, undefined, iri);
    assert.equal(r.problem, want.problem, iri);
    if (want.why) assert.match(r.why, want.why, iri);
    assert.equal(!!r.suffix, !!want.suffix, iri);
  }
  // placeKey and sourceKey are servable's key, or null.
  assert.equal(s.placeKey(B + 'place/london.html'), null);
  assert.equal(s.placeKey(B + 'place/london'), 'london');
  assert.deepEqual(SUFFIXES, ['jsonld', 'ttl', 'html']);
});

test('servability judges each address once, and finds keys that differ only in case', () => {
  const s = scheme('https://w3id.org/x/');
  const f = servability(s);
  assert.deepEqual(f.check('place', s.base + 'place/Bristol'), { key: 'Bristol' });
  assert.deepEqual(f.check('place', s.base + 'place/Bristol#a-1'), { key: 'Bristol', seen: true });
  assert.deepEqual(f.check('source', s.base + 'source/bristol'), { key: 'bristol' });   // another part
  const twin = f.check('place', s.base + 'place/bristol');
  assert.equal(twin.problem, 'case');
  assert.equal(twin.other, s.base + 'place/Bristol');
  assert.equal(f.check('place', s.base + 'place/bristol').seen, true);
  const bad = f.check('place', s.base + 'place/a/b');
  assert.equal(bad.problem, 'key');
  assert.equal(bad.seen, undefined);
  assert.equal(f.check('place', s.base + 'place/a/b').seen, true);
});

test('the sources of an attestation: its sources, its citations\' sources, and what they derive from', () => {
  const att = {
    sources: ['s1', { '@id': 's2', derivedFrom: [{ '@id': 's3', derivedFrom: 's4' }] }],
    citations: [{ source: 's5' }, { source: { '@id': 's6' } }, 'not a citation object'],
    names: [{ toponym: 'not a source', source: 'nor this' }],
  };
  const ids = [...sourcesOf(att)].map((x) => (typeof x === 'string' ? x : x['@id']));
  assert.deepEqual(ids, ['s1', 's2', 's3', 's4', 's5', 's6']);
  assert.deepEqual([...sourcesOf(null)], []);
  // A loop of derivations ends.
  const loop = { '@id': 'L' }; loop.derivedFrom = loop;
  assert.equal([...sourcesOf({ sources: [loop] })].length, 21);   // depths 0 to 20
});

test('keys differing only in case collide; the same key twice does not', () => {
  const g = caseGuard();
  assert.equal(g.add('place', 'Bristol'), null);
  assert.equal(g.add('place', 'Bristol'), null);
  assert.equal(g.add('source', 'bristol'), null);   // another part is another folder
  assert.equal(g.add('place', 'bristol'), 'Bristol');
});

test('a tree is one zip in the browser, holding every file at its path', async () => {
  const e = env();
  const tree = await openTree(e, 'site');
  await put(tree, 'index.html', '<p>hello</p>');
  await put(tree, 'place/bristol/index.html', '<p>Bristol</p>');
  await put(tree, 'place/bristol.jsonld', new TextEncoder().encode('{"@id":"x"}'));
  const r = await tree.close();
  assert.equal(r.name, 'site.zip');
  assert.equal(r.files, 3);
  const bytes = new Uint8Array(await new Blob(e.outs['site.zip']).arrayBuffer());
  const z = unzipSync(bytes);
  assert.deepEqual(Object.keys(z).sort(), ['index.html', 'place/bristol.jsonld', 'place/bristol/index.html']);
  assert.equal(strFromU8(z['place/bristol/index.html']), '<p>Bristol</p>');
  assert.equal(strFromU8(z['place/bristol.jsonld']), '{"@id":"x"}');
});

test('a tree is a folder on the command line, and never replaces a file unasked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agora-tree-'));
  try {
    const host = new NodeHost({ outDir: dir });
    const { env: e } = host.env(res);
    const tree = await openTree(e, 'site');
    await put(tree, 'place/bristol/index.html', 'Bristol');
    const r = await tree.close();
    assert.equal(r.files, 1);
    assert.equal(readFileSync(join(dir, 'site/place/bristol/index.html'), 'utf8'), 'Bristol');
    const again = await openTree(host.env(res).env, 'site');
    await assert.rejects(() => put(again, 'place/bristol/index.html', 'other'), { code: 'EEXIST' });
    assert.equal(readFileSync(join(dir, 'site/place/bristol/index.html'), 'utf8'), 'Bristol');
    // A path that would leave the folder is refused, and nothing is written for it.
    await assert.rejects(() => again.file('../escape.txt'));
    assert.equal(existsSync(join(dir, 'escape.txt')), false);
    host.cleanup();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a run that fails takes back the folders it made, but never one that was there before', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agora-undo-'));
  try {
    const host = new NodeHost({ outDir: join(dir, 'out') });
    // A tree this run began: removed whole, and the --out folder it made too.
    const { env: e, finish } = host.env(res);
    const tree = await openTree(e, 'site');
    await put(tree, 'place/bristol/index.html', 'Bristol');
    assert.ok(existsSync(join(dir, 'out/site/place/bristol/index.html')));   // written, before the failure
    assert.deepEqual(finish(true).removed, [join(dir, 'out/site/place/bristol/index.html')]);
    assert.equal(existsSync(join(dir, 'out/site')), false);
    assert.equal(existsSync(join(dir, 'out')), false);
    // A folder that was there before keeps what it held; only what this run made in it goes.
    mkdirSync(join(dir, 'out/site'), { recursive: true });
    writeFileSync(join(dir, 'out/site/keep.txt'), 'mine');
    const second = host.env(res);
    const t2 = await openTree(second.env, 'site');
    await put(t2, 'place/york/index.html', 'York');
    assert.ok(existsSync(join(dir, 'out/site/place/york/index.html')));
    second.finish(true);
    assert.equal(readFileSync(join(dir, 'out/site/keep.txt'), 'utf8'), 'mine');
    assert.equal(existsSync(join(dir, 'out/site/place')), false);
    // Stopped part-way (abandon), the same.
    const third = host.env(res);
    const t3 = await openTree(third.env, 'other');
    await put(t3, 'a/b.txt', 'x');
    assert.ok(existsSync(join(dir, 'out/other/a/b.txt')));
    host.abandon();
    assert.equal(existsSync(join(dir, 'out/other')), false);
    assert.ok(existsSync(join(dir, 'out/site/keep.txt')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--overwrite replaces a tree whole, so no file of the last one stays behind; a name that is a path is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agora-overwrite-'));
  try {
    const first = new NodeHost({ outDir: dir });
    await put(await openTree(first.env(res).env, 'site'), 'place/old/index.html', 'old');
    assert.ok(existsSync(join(dir, 'site/place/old/index.html')));
    const again = new NodeHost({ outDir: dir, overwrite: true });
    const { env: e, finish } = again.env(res);
    await put(await openTree(e, 'site'), 'place/new/index.html', 'new');
    finish(false);
    assert.equal(readFileSync(join(dir, 'site/place/new/index.html'), 'utf8'), 'new');
    assert.equal(existsSync(join(dir, 'site/place/old')), false);
    // A replaced tree that then fails is emptied, not removed: it was there before the run.
    const failing = again.env(res);
    await put(await openTree(failing.env, 'site'), 'place/x/index.html', 'x');
    failing.finish(true);
    assert.ok(existsSync(join(dir, 'site')));
    assert.equal(existsSync(join(dir, 'site/place')), false);
    for (const bad of ['../site', 'a/b', '..', '']) await assert.rejects(() => again.env(res).env.folder(bad), /not a name for a folder/, bad);
    assert.ok(existsSync(join(dir, 'site')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
