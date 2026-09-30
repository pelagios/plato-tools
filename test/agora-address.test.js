// Agora's address scheme and its tree of outputs: the addresses every part of publishing agrees on,
// and the folder (command line) or zip (browser) a part writes its files into.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync, strFromU8 } from 'fflate';
import { scheme, baseKind, normaliseBase, keyProblem, releaseProblem, caseGuard } from '../src/engine/agora/address.js';
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
  // The same addresses as reading spreadsheet tables makes (formats/tables.js), which PLATO makes normative.
  const t = tableIds(s.base, () => null);
  for (const id of ['bristol', 'St Ives', 'a/b']) {
    assert.equal(s.place(id), t.place(id));
    assert.equal(s.source(id), t.sourceIri(id));
  }
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
