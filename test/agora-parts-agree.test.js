// The parts of Agora that judge a place's or source's address (the FAIR report, the site and the
// w3id rules) must judge it alike: they once sorted the same address three ways, so that the report
// called an address fine that the site skipped and the w3id rules refused (Round 5). Each is run here
// on one dataset holding every kind of address, and what each says it cannot serve is compared.
//
// Every absence is paired with a presence: the clean dataset, run the same way, has none of these
// findings and has its files written, so a part that never read the dataset cannot pass.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publish } from '../src/engine/agora/index.js';
import { detect } from '../src/engine/input.js';
import { NodeHost } from '../src/node/host.js';
import { res, textFile } from './engine.js';
import { PLATO_REPO } from './paths.js';

const dir = mkdtempSync(join(tmpdir(), 'plato-tools-parts-agree-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// PLATO's Antonine example, moved to a w3id base.
const BASE = 'https://w3id.org/agree-test/';
const antonineText = readFileSync(join(PLATO_REPO, 'schemas/examples/place-centric-antonine.json'), 'utf8');
/** The example, its attestations given addresses; `odd` adds an address of each kind, to a place's first attestation and as a place. */
function dataset({ status = 'published', odd = false } = {}) {
  const d = JSON.parse(antonineText.replaceAll('https://whgazetteer.org/example/antonine/', BASE));
  d.gazetteer.status = status;
  if (odd) {
    const a = d.spatialEntities[0].attestations[0];
    a.sources = [].concat(a.sources || [],
      { '@id': BASE + 'source/gazetteer/geonames', title: 'GeoNames' },   // under source/, two parts deep
      { '@id': BASE + 'volume/12', title: 'Volume 12' });                 // under the base, not under source/
    a.citations = [].concat(a.citations || [], { source: BASE + 'agent/x' });   // cited by address alone, not under source/
    d.spatialEntities.push({ '@id': BASE + 'place/kent/dover', label: 'Dover', attestations: [{ names: [{ toponym: 'Dover' }] }] });
  }
  // Every attestation with an address, as publish mint gives them: a published site needs them.
  let n = 0;
  for (const p of d.spatialEntities) for (const a of p.attestations || []) a['@id'] = `${p['@id']}#a-${(++n).toString(16).padStart(8, '0')}`;
  return JSON.stringify(d);
}

let runs = 0;
async function run(part, text, options = {}) {
  const out = join(dir, `run-${++runs}`);
  mkdirSync(out);
  const host = new NodeHost({ outDir: out });
  const { env, finish } = host.env(res);
  try {
    const r = await publish({ part, input: await detect([textFile(text, 'agree.json')]), options }, env);
    return { ...r, out, item: (k) => r.report.items.find((i) => i.kind === k), kinds: r.report.items.map((i) => i.kind) };
  } finally { finish(false); host.cleanup(); }
}
const runAll = (text) => Promise.all([
  run('report', text),
  run('site', text, { toolsRef: 'abc1234', repo: 'pelagios/agree' }),
  run('w3id', text, { maintainers: ['docuracy'], repo: 'pelagios/agree' }),
]);
function walk(root, at = '') {
  return readdirSync(join(root, at), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(root, join(at, d.name)) : [join(at, d.name)]));
}

// The kind under which each part names the addresses it cannot serve, and those it does not reach at all.
const KEYS = { report: 'keys-not-servable', site: 'key-not-servable', w3id: 'key-unreachable' };
const WANT = [`${BASE}place/kent/dover: its last part has more than one part`, `${BASE}source/gazetteer/geonames: its last part has more than one part`];

test('the report, the site and the w3id rules find the same addresses unservable, and a published dataset is still served', async () => {
  const [report, site, w3id] = await runAll(dataset({ odd: true }));
  for (const [name, r] of Object.entries({ report, site, w3id })) {
    const i = r.item(KEYS[name]);
    assert.ok(i, `${name}: ${r.kinds.join()}`);
    assert.deepEqual([...i.examples].sort(), WANT, name);
    assert.equal(i.severity, 'warning', name);
    // Under the base but not under source/: served by none, and each part says so.
    const ns = r.item('sources-not-served');
    assert.equal(ns?.severity, 'warning', `${name}: ${r.kinds.join()}`);
    assert.deepEqual([...ns.examples].sort(), [BASE + 'agent/x', BASE + 'volume/12'], name);
    assert.equal(r.report.errors, 0, `${name}: ${JSON.stringify(r.report.items.filter((x) => x.severity === 'error'))}`);
  }
  // The w3id rules are written for the rest, and test none of what they cannot reach.
  const w = join(w3id.out, 'w3id-agree-test');
  assert.ok(existsSync(join(w, 'ids/agree-test/.htaccess')));
  const tsv = readFileSync(join(w, 'tests.tsv'), 'utf8');
  assert.match(tsv, /place\/iter-iii/);
  assert.doesNotMatch(tsv, /gazetteer|kent|volume|agent/);
  // The site: the other sources have their files, these none.
  const files = walk(site.outputs[0].path);
  assert.ok(files.some((f) => f.startsWith('source/')), files.filter((f) => f.startsWith('source')).join());
  assert.ok(files.some((f) => f.startsWith('place/iter-iii')));
  assert.deepEqual(files.filter((f) => /gazetteer|kent|dover|volume|agent/.test(f)), []);
});

test('a draft with those addresses: the report and the site make them errors, to fix before publishing', async () => {
  const text = dataset({ odd: true, status: 'draft' });
  const [report, site] = await Promise.all([run('report', text), run('site', text, { toolsRef: 'abc1234' })]);
  assert.equal(report.item(KEYS.report)?.severity, 'error', report.kinds.join());
  assert.equal(site.item(KEYS.site)?.severity, 'error', site.kinds.join());
  assert.deepEqual([...report.item(KEYS.report).examples].sort(), WANT);
  assert.deepEqual([...site.item(KEYS.site).examples].sort(), WANT);
  // Served by none, but no harm to a draft either: a warning still.
  assert.equal(report.item('sources-not-served')?.severity, 'warning');
});

test('control: the clean dataset has none of these findings in any part, and every part writes', async () => {
  const [report, site, w3id] = await runAll(dataset());
  for (const [name, r] of Object.entries({ report, site, w3id })) {
    for (const k of [...Object.values(KEYS), 'sources-not-served', 'places-not-served', 'place-not-under-base', 'key-suffix', 'key-case', 'keys-differ-in-case']) assert.ok(!r.kinds.includes(k), `${name}: ${k}`);
    assert.equal(r.report.errors, 0, name);
    assert.ok(r.outputs.length >= 1, name);
    assert.ok(r.report.counts.places > 0, name);
  }
  assert.ok(existsSync(join(w3id.out, 'w3id-agree-test', 'ids/agree-test/.htaccess')));
});

test("a base ending in '#' is refused by every part as a fragment base, not as no base at all", async () => {
  // Every address a fragment of one document, as PLATO allows for spreadsheet tables. The example as
  // PLATO gives it (a draft, its attestations without addresses, which could not be fragments again),
  // which the check finds nothing wrong with, so that it is the base that stops each part.
  const FRAG = 'https://w3id.org/agree-test#';
  const text = antonineText.replaceAll('https://whgazetteer.org/example/antonine/', FRAG);
  const fragment = [...await runAll(text), await run('mint', text)];
  const good = [...await runAll(dataset()), await run('mint', dataset())];
  const bare = JSON.parse(dataset()); delete bare.gazetteer.uriSpace;
  const missing = await Promise.all([run('report', JSON.stringify(bare)), run('site', JSON.stringify(bare), { toolsRef: 'abc1234' }), run('mint', JSON.stringify(bare))]);
  for (const r of fragment) {
    const i = r.item('base-is-fragment');
    assert.ok(i && i.severity === 'error', r.kinds.join());
    assert.equal(i.examples[0], FRAG);
    assert.ok(!r.kinds.includes('no-base'), r.kinds.join());
    assert.equal(r.outputs.length, 0, r.kinds.join());
  }
  // The controls: no base at all is still 'no-base', and a base ending in '/' raises neither.
  for (const r of missing) { assert.ok(r.kinds.includes('no-base'), r.kinds.join()); assert.ok(!r.kinds.includes('base-is-fragment')); }
  for (const r of good) { assert.ok(!r.kinds.includes('no-base') && !r.kinds.includes('base-is-fragment'), r.kinds.join()); assert.ok(r.outputs.length >= 1); }
});
