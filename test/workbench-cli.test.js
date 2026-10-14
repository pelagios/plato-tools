// plato-tools project info <share link> (plan #34, item A1, D5): the one command that asks WHG for anything, for
// a project shared from its Workbench, against the fake WHG served on this computer (test/workbench-fake.js):
// never the real one. The token of the user is never sent (WHG_TOKEN set in its environment, and not in any
// request: beside the request that is made), the share token never printed, and the link said to be in the
// shell's history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { RECIPES, runner, recordOf, refsOf } from '../src/engine/methodos/index.js';
import { writeProject } from '../src/engine/methodos/project.js';
import { workbench, envelope } from '../src/engine/workbench.js';
import { workbenchFake, serve } from './workbench-fake.js';

const CLI = new URL('../bin/plato-tools.mjs', import.meta.url).pathname;
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const TOKEN = 'whg-token-9a8b7c6d5e4f3a2b';
const cli = (args, env = {}) => new Promise((resolve) => {
  execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout, err: stderr }));
});

async function project() {
  const own = new File(['id,name\n1,Mill Farm\n'], 'parishes.csv', { type: 'text/csv' });
  const [table] = await refsOf([own], 'files');
  const s = runner.start(RECIPES['map-your-data'], { 'has-regions': false, 'will-draw': false, 'will-publish': false, target: 'plato-json' }, { files: [table] });
  const record = recordOf({ ...s, id: 'map-your-data-cli1' }, { name: 'Parishes' });
  const chunks = [];
  await writeProject({ record, files: [{ ref: table, blob: own }], tools: { version: 'test', commit: null } }, (c) => { chunks.push(c); });
  return { record, bytes: new Uint8Array(await new Blob(chunks).arrayBuffer()) };
}

test('project info <share link>: the shared project read from WHG with no token and the tools\' User-Agent, checked as a file is; the link said to be in the history, its token never printed', async () => {
  const fake = workbenchFake();
  fake.addUser({ token: TOKEN });
  const server = await serve(fake, 0);
  const base = `http://127.0.0.1:${server.address().port}/reconciliation/`;
  try {
    const wb = workbench({ fetch: (u, i) => fake.fetch(u, i), token: () => TOKEN });
    const { record, bytes } = await project();
    const made = await wb.create({ snapshot: envelope(bytes, record), title: 'Parishes' });
    const { token } = await wb.share(made.id);
    const link = `https://pelagios.org/plato-tools/#whg-shared=${token}`;
    const n = fake.log.length;
    const ok = await cli(['project', 'info', link], { PLATO_TOOLS_WORKBENCH: base, WHG_TOKEN: TOKEN });
    assert.equal(ok.code, 0, ok.err + ok.out);
    assert.match(ok.out, /^"Parishes", shared from WHG \(version 1 there\)\nA PLATO tools project, format version 1\.1/);
    assert.match(ok.out, /files\/[0-9a-f]{64} +\d+ bytes {2}file: parishes\.csv \(the file the workflow began with\)/);
    assert.match(ok.err, /the share link is now in your shell's history/);
    assert.ok(!ok.out.includes(token) && !ok.err.includes(token), 'the share token is never printed');
    const asked = fake.log.slice(n);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].path, `/reconciliation/shared/${token}/`);
    assert.equal(asked[0].headers['user-agent'], `plato-tools/${VERSION} (+https://pelagios.org/plato-tools/)`);
    assert.equal(asked[0].headers.authorization, undefined, 'no token of the user\'s, though WHG_TOKEN is set');
    const json = JSON.parse((await cli(['project', 'info', '--json', link], { PLATO_TOOLS_WORKBENCH: base })).out);
    assert.equal(json.ok, true); assert.equal(json.manifest.workflow.id, 'map-your-data-cli1'); assert.ok(!JSON.stringify(json).includes(token));
    // Withdrawn: it opens nothing (1); not a link at all (1, and nothing asked); WHG not reachable (2).
    await wb.unshare(made.id);
    const gone = await cli(['project', 'info', link], { PLATO_TOOLS_WORKBENCH: base });
    assert.equal(gone.code, 1); assert.match(gone.out, /no longer opens anything/);
    const before = fake.log.length;
    const bad = await cli(['project', 'info', 'https://pelagios.org/plato-tools/#whg-shared=not-a-token'], { PLATO_TOOLS_WORKBENCH: base });
    assert.equal(bad.code, 1); assert.match(bad.out, /not a WHG share link/);
    assert.equal(fake.log.length, before);
    const down = await cli(['project', 'info', link], { PLATO_TOOLS_WORKBENCH: 'http://127.0.0.1:9/reconciliation/' });
    assert.equal(down.code, 2); assert.match(down.out, /could not be reached/);
    // Another Workbench than WHG's only on this computer or over https.
    assert.equal((await cli(['project', 'info', link], { PLATO_TOOLS_WORKBENCH: 'http://example.org/reconciliation/' })).code, 2);
  } finally { server.close(); }
});
