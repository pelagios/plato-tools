// Which PLATO the tools check against. The pin is to PLATO's main branch, which carries no draft
// marking; a pin to any other branch or commit (`vendor-plato.mjs --ref NAME`) is a draft, and must
// say so in VERSION.json, the page footer and --version, so that a draft can never pass for a
// release. The draft case is tested by running the real vendoring script, in a directory of its
// own, with GitHub answered by a stand-in so that the test needs no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { draftNote } from '../src/engine/words.js';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('the pin is PLATO main: VERSION.json and package.json agree, and neither is marked a draft', () => {
  const v = json(root('public/plato/VERSION.json')), pkg = json(root('package.json'));
  assert.deepEqual(Object.keys(v).sort(), ['commit', 'repository', 'versionInfo']);
  assert.deepEqual(Object.keys(pkg.plato).sort(), ['commit', 'repository']);
  assert.equal(pkg.plato.commit, v.commit);
  assert.match(v.commit, /^[0-9a-f]{40}$/);
  assert.equal(draftNote(v), '');
});
test('--version names the pinned commit, and says nothing of a draft', () => {
  const r = spawnSync(process.execPath, [root('bin/plato-tools.mjs'), '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(json(root('public/plato/VERSION.json')).commit), r.stdout);
  assert.doesNotMatch(r.stdout, /draft/i);
});

// A stand-in for GitHub: each branch name resolves to a made-up commit, and each raw file is a stub.
const STUB = `
const SHA = { main: 'b'.repeat(40), 'some-design': 'a'.repeat(40) };
globalThis.fetch = async (url) => {
  const u = new URL(url);
  if (u.hostname === 'api.github.com') {
    const sha = SHA[decodeURIComponent(u.pathname.split('/').pop())];
    return sha ? new Response(sha) : new Response('', { status: 404 });
  }
  if (u.hostname === 'raw.githubusercontent.com') return new Response(u.pathname.endsWith('ontology.ttl') ? '<x> owl:versionInfo "9.9.9" .' : '{}');
  throw new Error('unexpected fetch ' + url);
};`;
function vendor(dir, ...args) {
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(dir, 'stub.mjs')).href, root('scripts/vendor-plato.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { out: r.stdout, pkg: json(join(dir, 'package.json')), v: json(join(dir, 'public/plato/VERSION.json')) };
}
test('a draft pin (--ref) is marked as a draft everywhere the pin is shown, and keeps the marking when re-vendored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plato-pin-'));
  try {
    writeFileSync(join(dir, 'stub.mjs'), STUB);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', plato: { repository: 'r', commit: 'c'.repeat(40) } }));
    let { out, pkg, v } = vendor(dir, '--ref', 'some-design');
    assert.deepEqual(pkg.plato, { repository: 'https://github.com/pelagios/place-attestation-ontology', commit: 'a'.repeat(40), ref: 'some-design', draft: true });
    assert.deepEqual([v.commit, v.versionInfo, v.ref, v.draft], ['a'.repeat(40), '9.9.9', 'some-design', true]);
    assert.match(v.note, /not a release/);
    assert.match(out, /DRAFT: branch some-design/);
    // What the page footer and --version add, from this VERSION.json.
    assert.equal(draftNote(v), "DRAFT: PLATO's some-design branch, not a release");
    // The build's own vendoring (no flags) must write the marking again, not drop it.
    ({ pkg, v } = vendor(dir));
    assert.deepEqual([v.commit, v.draft, v.ref, pkg.plato.draft], ['a'.repeat(40), true, 'some-design', true]);
    // Re-pinning to main clears it.
    ({ pkg, v } = vendor(dir, '--latest'));
    assert.deepEqual(Object.keys(v).sort(), ['commit', 'repository', 'versionInfo']);
    assert.deepEqual([v.commit, pkg.plato.draft, pkg.plato.ref], ['b'.repeat(40), undefined, undefined]);
    assert.equal(draftNote(v), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
