// Krisis, gazetteer lookup on the command line (bin/plato-tools.mjs lookup), run as a user runs it: a
// separate process, files on disk, and a reconciliation service of our own on 127.0.0.1 standing in for
// a gazetteer, so nothing goes further. It speaks https (a token is never sent over http), with a
// certificate made for the test and given to the command line by NODE_EXTRA_CA_CERTS. The token is
// given only in the environment, and looked for in everything the command writes, beside a control
// that the service received it.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWork } from '../src/engine/krisis/work.js';

const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const TOKEN = 'cli-SECRET-5b1e2d';
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'WHG_TOKEN' && k !== 'MY_TOKEN'));
/** Run the command line, asynchronously (the service answers from this process meanwhile). */
function cli(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...BASE_ENV, NODE_EXTRA_CA_CERTS: certFile, ...extraEnv } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
const made = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'plato-tools-lookup-test-')); made.push(d); return d; };
// A certificate for 127.0.0.1, made now; without openssl the tests that need the service are skipped, and say so.
const certDir = scratch(), certFile = join(certDir, 'cert.pem'), keyFile = join(certDir, 'key.pem');
const made_cert = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
const NO_TLS = made_cert.status === 0 ? false : 'openssl could not make a certificate for the test service, so the lookups against it are not run';

// The service: answers each query by its name, as `reply` says; every request is kept.
const requests = [];
let reply = () => ({ status: 200 });
const server = NO_TLS ? null : createServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, (req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const sent = JSON.parse(body || '{}');
    requests.push({ headers: req.headers, body: sent, url: req.url });
    const r = reply(sent);
    if (r.status !== 200) { res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r.body)); return; }
    const out = { attribution: { sources: { ex: { license: { spdx_id: 'CC-BY-4.0', permits_commercial: true, no_derivatives: null } } } } };
    for (const [k, q] of Object.entries(sent.queries || {})) {
      out[k] = { result: q.query === 'Newcastle' ? [{ id: 'https://gaz.example.org/p/1', name: 'Newcastle', score: 100, match: true, repr_point: [-1.6, 54.97] }, { id: 'relative-id', name: 'Newcastle', score: 50 }] : [] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
  });
});
let endpoint;
before(async () => { if (server) { await new Promise((r) => server.listen(0, '127.0.0.1', r)); endpoint = `https://127.0.0.1:${server.address().port}/reconcile`; } });
after(() => { server?.close(); for (const d of made) rmSync(d, { recursive: true, force: true }); });

const X = 'https://example.org/';
const src = { '@id': X + 'source/s', title: 'S', authorityType: 'source' };
const at = (lon, lat) => ({ geometries: [{ geojson: { type: 'Point', coordinates: [lon, lat] } }], sources: [src] });
function fixture() {
  const dir = scratch();
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ profile: 'place-centric', gazetteer: { '@id': X + 'a', title: 'Dataset A' },
    spatialEntities: [{ '@id': X + 'a/newcastle', label: 'Newcastle', attestations: [at(-1.61, 54.97)] }, { '@id': X + 'a/york', label: 'York', attestations: [at(-1.08, 53.96)] }] }));
  return dir;
}
const noToken = (r, dir) => {
  const files = dir && existsSync(join(dir, 'a.krisis.json')) ? readFileSync(join(dir, 'a.krisis.json'), 'utf8') : '';
  assert.ok(!(r.out + r.err + files).includes(TOKEN), 'the token is in nothing the command wrote');
};

test('a dry run says what would be sent and sends nothing; the run sends it', { skip: NO_TLS }, async () => {
  const dir = fixture();
  requests.length = 0;
  const dry = await cli(['lookup', join(dir, 'a.json'), '--gazetteer', endpoint, '--token-env', 'MY_TOKEN', '--dry-run', '--out', dir], { MY_TOKEN: TOKEN });
  assert.equal(dry.code, 0, dry.out + dry.err);
  assert.match(dry.out, /Would look up 2 places in 127\.0\.0\.1:\d+: 2 queries in 1 request\./);
  assert.match(dry.out, /Each place is looked up by its label only\./);
  assert.match(dry.out, /No filters/);
  assert.ok(dry.out.includes('{"query":"Newcastle","limit":10}'), dry.out);
  assert.equal(requests.length, 0, 'nothing sent');
  assert.ok(!existsSync(join(dir, 'a.krisis.json')), 'nothing written');
  const run = await cli(['lookup', join(dir, 'a.json'), '--gazetteer', endpoint, '--token-env', 'MY_TOKEN', '--out', dir], { MY_TOKEN: TOKEN });
  assert.equal(run.code, 0, run.out + run.err);
  assert.equal(requests.length, 1, 'control: the run sends');
  assert.equal(requests[0].headers.authorization, `Bearer ${TOKEN}`, 'control: the token went, in the header');
  assert.match(run.out, /1 possible match to review\. Looked up 2 places in 127\.0\.0\.1:\d+, with 2 queries; 2 places were answered, 1 with no candidates\. Not suggested: 1 candidate without a web address\./);
  const w = readWork(readFileSync(join(dir, 'a.krisis.json'), 'utf8'));
  assert.equal(w.others, null);
  assert.deepEqual(w.candidates.map((c) => c.candidate_candidate), ['https://gaz.example.org/p/1']);
  assert.equal(w.lookups[0].attribution.sources.ex.license.no_derivatives, null, 'kept as it came');
  noToken(run, dir);
});
test('the token is refused on the command line, and WHG without one is refused; a WHG token never goes to another service', { skip: NO_TLS }, async () => {
  const dir = fixture();
  const given = await cli(['lookup', join(dir, 'a.json'), `--token=${TOKEN}`]);
  assert.equal(given.code, 2);
  assert.match(given.err, /never given on the command line/);
  noToken(given);
  const none = await cli(['lookup', join(dir, 'a.json'), '--out', dir]);
  assert.equal(none.code, 2);
  assert.match(none.err, /needs a token: set WHG_TOKEN/);
  requests.length = 0;
  const elsewhere = await cli(['lookup', join(dir, 'a.json'), '--gazetteer', endpoint, '--out', dir], { WHG_TOKEN: TOKEN });
  assert.equal(elsewhere.code, 0, elsewhere.out + elsewhere.err);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.authorization, undefined, 'WHG\'s token is not sent to another service');
  noToken(elsewhere, dir);
  requests.length = 0;
  const http = await cli(['lookup', join(dir, 'a.json'), '--gazetteer', endpoint.replace('https:', 'http:'), '--token-env', 'MY_TOKEN', '--out', dir, '--overwrite'], { MY_TOKEN: TOKEN });
  assert.equal(http.code, 2);
  assert.match(http.err, /never sent over http:/);
  assert.equal(requests.length, 0, 'nothing sent');
  noToken(http);
  const unset = await cli(['lookup', join(dir, 'a.json'), '--gazetteer', endpoint, '--token-env', 'MY_TOKEN', '--out', dir, '--overwrite']);
  assert.equal(unset.code, 2);
  assert.match(unset.err, /--token-env names MY_TOKEN, which is not set/);
  const whgEnv = await cli(['lookup', join(dir, 'a.json'), '--token-env', 'MY_TOKEN'], { MY_TOKEN: TOKEN });
  assert.equal(whgEnv.code, 2);
  assert.match(whgEnv.err, /WHG's token is read from WHG_TOKEN/);
});
test('a refusal stops the lookup with exit 1; the work file keeps it, and the message does not repeat the token', { skip: NO_TLS }, async () => {
  const dir = fixture();
  reply = () => ({ status: 403, body: { detail: `token ${TOKEN} refused` } });
  try {
    const r = await cli(['lookup', join(dir, 'a.json'), '--gazetteer', endpoint, '--token-env', 'MY_TOKEN', '--out', dir, '--json'], { MY_TOKEN: TOKEN });
    assert.equal(r.code, 1, r.out + r.err);
    const j = JSON.parse(r.out);
    assert.equal(j.status, 'problems');
    assert.match(j.warnings[0], /refused the token/);
    assert.ok(j.warnings[0].includes('[token]'), 'control: the service\'s words are passed on, cleaned');
    const w = readWork(readFileSync(join(dir, 'a.krisis.json'), 'utf8'));
    assert.deepEqual(Object.values(w.lookups[0].queries).map((q) => q.state), ['stopped', 'stopped']);
    assert.equal(w.lookups[0].stopped.kind, 'auth');
    noToken(r, dir);
  } finally { reply = () => ({ status: 200 }); }
});
test('--review adds to a work file from match; wrong commands exit 2', { skip: NO_TLS }, async () => {
  const dir = fixture();
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ profile: 'place-centric', gazetteer: { '@id': X + 'b', title: 'Dataset B' }, spatialEntities: [{ '@id': X + 'b/york', label: 'York', attestations: [at(-1.08, 53.96)] }] }));
  const m = await cli(['match', join(dir, 'a.json'), '--with', join(dir, 'b.json'), '--out', dir]);
  assert.equal(m.code, 0, m.out + m.err);
  requests.length = 0;
  const r = await cli(['lookup', join(dir, 'a.json'), '--review', join(dir, 'a.krisis.json'), '--gazetteer', endpoint, '--out', dir, '--overwrite']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(Object.values(requests[0].body.queries).map((q) => q.query), ['Newcastle'], 'York had a local candidate');
  const w = readWork(readFileSync(join(dir, 'a.krisis.json'), 'utf8'));
  assert.equal(w.others.title, 'Dataset B');
  assert.deepEqual(w.candidates.map((c) => c.lookup ?? 'local'), ['local', 'l1']);
  const again = await cli(['lookup', join(dir, 'a.json'), '--review', join(dir, 'a.krisis.json'), '--gazetteer', endpoint, '--out', dir]);
  assert.equal(again.code, 2, 'an existing work file is not replaced unasked');
  assert.match(again.err, /already exists/);
  assert.equal((await cli(['lookup', join(dir, 'a.json'), '--places', 'some'])).code, 2);
  assert.equal((await cli(['lookup', join(dir, 'a.json'), '--batch', '51', '--dry-run'])).code, 2);
  assert.equal((await cli(['check', join(dir, 'a.json'), '--dry-run'])).code, 2, '--dry-run is for lookup');
  assert.equal((await cli(['lookup', join(dir, 'a.json'), '--gazetteer', 'not a url'])).code, 2);
  // An IRI template makes addresses of ids that are not.
  const t = await cli(['lookup', join(dir, 'a.json'), '--gazetteer', endpoint, '--gazetteer-iri', 'https://gaz.example.org/id/{{id}}', '--places', 'all', '--out', dir, '--overwrite']);
  assert.equal(t.code, 0, t.out + t.err);
  assert.ok(readWork(readFileSync(join(dir, 'a.krisis.json'), 'utf8')).candidates.some((c) => c.candidate_candidate === 'https://gaz.example.org/id/relative-id'));
  assert.equal((await cli(['lookup', join(dir, 'a.json'), '--gazetteer', endpoint, '--gazetteer-iri', 'https://gaz.example.org/id/'])).code, 2, 'a template without {{id}}');
});
