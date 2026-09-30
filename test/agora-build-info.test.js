// Which commit of PLATO tools is running (src/node/build-info.js), for the site's workflow to run the
// same one. Each way of knowing is shown answering, and shown staying silent where it must: git
// inside someone else's repository, a lockfile that names a registry version, a record never made.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ROOT, commitFromGit, commitFromLockfile, commitFromInfo, toolsCommit, writeBuildInfo } from '../src/node/build-info.js';
import { unzipSync, strFromU8 } from 'fflate';
import { PLATO_REPO } from './paths.js';
import { env as memEnv, textFile } from './engine.js';
import { detect } from '../src/engine/input.js';
import { publish } from '../src/engine/agora/index.js';

const HEAD = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const SHA1 = 'a'.repeat(40), SHA2 = 'b'.repeat(40);
const dir = mkdtempSync(join(tmpdir(), 'plato-tools-build-info-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const TABLES = `${PLATO_REPO}/schemas/tables/examples/king-john`;
const KING_JOHN = `${PLATO_REPO}/schemas/examples/place-centric-king-john.json`;

/** A project with plato-tools installed in it from git, as npx leaves one: its lockfile names the commit. */
function installed(name, resolved) {
  const project = join(dir, name);
  const pkg = join(project, 'node_modules', 'plato-tools');
  mkdirSync(pkg, { recursive: true });
  if (resolved !== undefined) writeFileSync(join(project, 'node_modules', '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/plato-tools': { version: '0.1.0', resolved } } }));
  return pkg;
}

test('git answers for its own checkout only, never for a repository the tools are inside', () => {
  assert.match(HEAD, /^[0-9a-f]{40}$/);
  assert.equal(commitFromGit(ROOT), HEAD);
  // A folder inside this repository stands for node_modules/plato-tools inside a user's repository.
  assert.equal(commitFromGit(join(ROOT, 'src')), null);
  assert.equal(commitFromGit(dir), null);
});

test("the lockfile of the project the tools are installed in names npm's commit", () => {
  const pkg = installed('npx', `git+ssh://git@github.com/pelagios/plato-tools.git#${SHA1}`);
  assert.equal(commitFromLockfile(pkg), SHA1);
  // Installed from the registry, or with no lockfile, or not installed at all: nothing.
  assert.equal(commitFromLockfile(installed('registry', 'https://registry.npmjs.org/plato-tools/-/plato-tools-0.1.0.tgz')), null);
  assert.equal(commitFromLockfile(installed('bare')), null);
  assert.equal(commitFromLockfile(ROOT), null);
});

test('the order: git, then the lockfile, then the record written at build time', () => {
  const info = join(dir, 'build-info.json');
  writeFileSync(info, JSON.stringify({ commit: SHA2 }));
  assert.equal(commitFromInfo(info), SHA2);
  assert.deepEqual(toolsCommit({ root: ROOT, infoFile: info }), { commit: HEAD, from: 'git' });
  const pkg = installed('ordered', `git+ssh://git@github.com/pelagios/plato-tools.git#${SHA1}`);
  assert.deepEqual(toolsCommit({ root: pkg, infoFile: info }), { commit: SHA1, from: 'lockfile' });
  assert.deepEqual(toolsCommit({ root: installed('record-only'), infoFile: info }), { commit: SHA2, from: 'build-info' });
  assert.equal(toolsCommit({ root: installed('nothing'), infoFile: join(dir, 'missing.json') }), null);
});

test('the record: the commit given, else git; without either, one written before is kept, else null', () => {
  const file = join(dir, 'written.json');
  assert.deepEqual(writeBuildInfo({ root: ROOT, file, env: {} }), { commit: HEAD, from: 'git' });
  assert.equal(commitFromInfo(file), HEAD);
  assert.deepEqual(writeBuildInfo({ root: dir, file, env: { PLATO_TOOLS_COMMIT: SHA1 } }), { commit: SHA1, from: 'PLATO_TOOLS_COMMIT' });
  assert.deepEqual(writeBuildInfo({ root: dir, file, env: {} }), { commit: SHA1, kept: true });
  assert.equal(commitFromInfo(file), SHA1);
  const fresh = join(dir, 'fresh.json');
  assert.deepEqual(writeBuildInfo({ root: dir, file: fresh, env: { PLATO_TOOLS_COMMIT: 'not-a-sha' } }), { commit: null, from: null });
  assert.equal(JSON.parse(readFileSync(fresh, 'utf8')).commit, null);
});

test("publish site pins the workflow to this checkout's commit, and --tools-ref overrides it", () => {
  const run = (out, ...more) => spawnSync(process.execPath, [CLI, 'publish', 'site', TABLES, '--base', 'https://w3id.org/test-x/', '--out', join(dir, out), '--json', ...more], { encoding: 'utf8' });
  const pinned = run('pinned');
  const j = JSON.parse(pinned.stdout.trim());
  assert.equal(pinned.status, 0, pinned.stdout + pinned.stderr);
  assert.ok(!j.items.some((i) => i.kind === 'tools-ref-unpinned'), JSON.stringify(j.items.map((i) => i.kind)));
  assert.match(readFileSync(join(dir, 'pinned/king-john-repo/.github/workflows/pages.yml'), 'utf8'), new RegExp(`npx --yes 'github:pelagios/plato-tools#${HEAD}'`));
  const given = run('given', '--tools-ref', 'v9.9.9');
  assert.equal(given.status, 0);
  assert.match(readFileSync(join(dir, 'given/king-john-repo/.github/workflows/pages.yml'), 'utf8'), /npx --yes 'github:pelagios\/plato-tools#v9\.9\.9'/);
});

test("the page's site: the commit the page was built from pins the workflow; without one, the tag, with a warning", async () => {
  const workflow = async (options) => {
    const e = memEnv();
    const r = await publish({ part: 'site', input: await detect([textFile(readFileSync(KING_JOHN, 'utf8'), 'kj.json')]), options }, e);
    const zip = unzipSync(new Uint8Array(Buffer.concat(e.outs['kj-repo.zip'].map((p) => Buffer.from(p)))));
    return { kinds: r.report.items.map((i) => i.kind), text: strFromU8(zip['.github/workflows/pages.yml']) };
  };
  const built = await workflow({ toolsCommit: SHA1 });
  assert.match(built.text, new RegExp(`plato-tools#${SHA1}'`));
  assert.ok(!built.kinds.includes('tools-ref-unpinned'));
  const over = await workflow({ toolsCommit: SHA1, toolsRef: 'v2.0.0' });
  assert.match(over.text, /plato-tools#v2\.0\.0'/);
  const none = await workflow({});
  assert.match(none.text, /plato-tools#v\d+\.\d+\.\d+'/);
  assert.ok(none.kinds.includes('tools-ref-unpinned'));
});
