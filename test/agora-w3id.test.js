// Agora's w3id part: the redirect rules for a w3id.org namespace, the addresses that test them, and
// the gates that decide whether they are written at all.
//
// The rules are tested twice: as text, for the rules that matter most (the order of text/html and
// the */* fallback, the CORS header, the maintainers), and by what they DO: when Docker can run
// httpd:2.4, the generated folder is served by Apache as w3id.org serves it, and every row of the
// generated tests.tsv is asked for and its status and Location compared. That run is only worth
// having if it can fail, so the same rows are run against a copy with the text/html rule for places
// taken out, and must fail there.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, chmodSync, readdirSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { publish } from '../src/engine/agora/index.js';
import { detect } from '../src/engine/input.js';
import { scheme, keyProblem, SITE } from '../src/engine/agora/address.js';
import { siteTarget, SITE_FILES, TEXT } from '../src/engine/agora/w3id.js';
import { htaccess, testRows, fromTsv, toTsv, KEY, BROWSER } from '../src/engine/agora/w3id/rules.js';
import { apacheArgs, APACHE_COMMAND } from '../src/engine/agora/w3id/texts.js';
import { NodeHost } from '../src/node/host.js';
import { res, textFile } from './engine.js';
import { PLATO_REPO } from './paths.js';

const dir = mkdtempSync(join(tmpdir(), 'plato-tools-w3id-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));

// PLATO's Antonine example, moved to a w3id base and published: 11 places, 3 sources.
const BASE = 'https://w3id.org/antonine-test/';
const antonineText = readFileSync(join(PLATO_REPO, 'schemas/examples/place-centric-antonine.json'), 'utf8');
function antonine({ base = BASE, status = 'published', edit } = {}) {
  const d = JSON.parse(antonineText.replaceAll('https://whgazetteer.org/example/antonine/', base));
  d.gazetteer.status = status;
  if (edit) edit(d);
  return JSON.stringify(d);
}
const OPTIONS = { maintainers: ['docuracy'], repo: 'Pelagios/antonine', release: 'data-2026-10-01' };

let runs = 0;
/** One run of the w3id part, writing a real folder, as the command line does. */
async function run(text, options = OPTIONS) {
  const out = join(dir, `run-${++runs}`);
  mkdirSync(out);
  const host = new NodeHost({ outDir: out });
  const { env, finish } = host.env(res);
  try {
    const input = await detect([textFile(text, 'data.json')]);
    const r = await publish({ part: 'w3id', input, options }, env);
    const kinds = r.report.items.map((i) => i.kind);
    return { ...r, out, kinds, item: (k) => r.report.items.find((i) => i.kind === k) };
  } finally { finish(false); host.cleanup(); }
}
const read = (r, rel) => readFileSync(join(r.out, 'w3id-antonine-test', rel), 'utf8');

// ---- the rules as text ------------------------------------------------------------------------

const C = {
  w3idPath: 'antonine-test', base: BASE, site: 'https://pelagios.github.io/antonine/', repo: 'Pelagios/antonine', release: 'data-2026-10-01',
  turtle: false, maintainers: ['docuracy', 'someone-else'], title: 'Antonine', gazetteer: { title: 'Antonine' },
  examples: { place: ['iter-iii'], source: ['pleiades'] }, counts: { places: 1, sources: 1 }, stem: 'antonine-test',
};

test("a rule's key is what keyProblem accepts: every accepted key is captured whole, every refused one is not", () => {
  const whole = new RegExp(`^${KEY}$`);
  const accepted = ['bristol', 'St_Ives', 'a.b-c~d', '000002', 'x.', '-y', '~z'];
  const refused = ['', 'St%20Ives', 'a%2Fb', 'Zürich', '..', '.hidden', 'a/b', 'a b', 'a+b'];
  for (const k of accepted) { assert.equal(keyProblem(k), null, k); assert.ok(whole.test(k), `captures ${k}`); }
  for (const k of refused) { assert.ok(keyProblem(k) || k.includes('/'), k); assert.ok(!whole.test(k), `does not capture ${k}`); }
});

test('the site is --site-url, or the Pages address of --repo; a repository named <owner>.github.io is served at the root', () => {
  assert.deepEqual(siteTarget({ repo: 'Pelagios/antonine' }), { site: 'https://pelagios.github.io/antonine/' });
  assert.deepEqual(siteTarget({ repo: 'Docuracy/docuracy.github.io' }), { site: 'https://docuracy.github.io/' });
  assert.deepEqual(siteTarget({ siteUrl: 'https://data.example.net/x', repo: 'a/b' }), { site: 'https://data.example.net/x/' });
  assert.deepEqual(siteTarget({}), { error: 'no-site-url' });
  for (const bad of ['nobody', 'a/b/c', '-a/b', 'a/b c']) assert.deepEqual(siteTarget({ repo: bad }), { error: 'bad-repo' }, bad);
  // Characters Apache would read as syntax never reach a rule.
  for (const bad of ['https://x.org/a b/', 'https://x.org/$1/', 'https://x.org/a%20b/', 'ftp://x.org/', 'https://x.org/?q']) assert.deepEqual(siteTarget({ siteUrl: bad }), { error: 'bad-site-url' }, bad);
});

test('the site files the rules point at are those the address scheme and the site root layout name', () => {
  const s = scheme(BASE), f = s.files('place', 'bristol');
  assert.equal(SITE_FILES.page('place', 'bristol'), f.dir);
  assert.equal(SITE_FILES.jsonld('place', 'bristol'), f.jsonld);
  assert.equal(SITE_FILES.ttl('place', 'bristol'), f.ttl);
  assert.equal(SITE_FILES.description, SITE.description);
  assert.equal(SITE_FILES.descriptionTtl, SITE.descriptionTtl);
});

test('the text/html rule comes before the */* fallback, for the root, places and sources (Apache ignores q-values)', () => {
  const h = htaccess(C);
  for (const [pattern, page, json] of [['^$', C.site + ' ', C.site + 'index.jsonld'], ['^place/', C.site + 'place/$1/ ', C.site + 'place/$1.jsonld'], ['^source/', C.site + 'source/$1/ ', C.site + 'source/$1.jsonld']]) {
    const lines = h.split('\n');
    const htmlRule = lines.findIndex((l, i) => l.startsWith(`RewriteRule ${pattern}`) && l.includes(page) && lines[i - 2] === 'RewriteCond %{HTTP_ACCEPT} text/html [OR]');
    const anyRule = lines.findIndex((l, i) => l.startsWith(`RewriteRule ${pattern}`) && l.includes(json) && lines[i - 2] === 'RewriteCond %{HTTP_ACCEPT} \\*/\\* [OR]' && lines[i - 1] === 'RewriteCond %{HTTP_ACCEPT} ^$');
    assert.ok(htmlRule > 0, `${pattern}: a text/html rule`);
    assert.ok(anyRule > 0, `${pattern}: a */* rule`);
    assert.ok(htmlRule < anyRule, `${pattern}: text/html first`);
  }
  // '+' is escaped in Accept patterns; every rule is anchored; the last rule is the 404.
  assert.ok(h.includes('RewriteCond %{HTTP_ACCEPT} application/ld\\+json [OR]'));
  assert.ok(!/HTTP_ACCEPT} [^\n]*[^\\]\+/.test(h), 'an unescaped +');
  for (const l of h.split('\n').filter((x) => x.startsWith('RewriteRule '))) assert.match(l, /^RewriteRule \^.*\$ /, l);
  assert.equal(h.trim().split('\n').at(-1), 'RewriteRule ^.*$ - [R=404,L]');
});

test('the rules name their maintainers and set CORS on the redirects themselves', () => {
  const h = htaccess(C);
  assert.ok(h.includes('# GitHub username: docuracy\n# GitHub username: someone-else\n'));
  assert.ok(h.includes('\nHeader always set Access-Control-Allow-Origin *\n'));
  assert.ok(h.includes('\nRewriteEngine on\n'));
});

test('Turtle rules only with --turtle, release rules only with a repository; without Turtle a .ttl address is 404', () => {
  const without = htaccess(C), withTtl = htaccess({ ...C, turtle: true }), noRepo = htaccess({ ...C, repo: null });
  assert.ok(withTtl.includes(`RewriteRule ^$ ${C.site}index.ttl [R=303,L]`));
  assert.ok(withTtl.includes('\\.ttl$ https://pelagios.github.io/antonine/place/$1.ttl [R=302,L]'));
  assert.ok(!without.includes('text/turtle') && !without.includes('.ttl [R='));
  assert.ok(without.includes('\\.ttl$ - [R=404,L]'));
  assert.ok(without.includes('^release/([A-Za-z0-9_~-][A-Za-z0-9._~-]*)/?$ https://github.com/Pelagios/antonine/releases/tag/$1 [R=303,L]'));
  assert.ok(without.includes('https://github.com/Pelagios/antonine/releases/download/$1/$2 [R=302,L]'));
  assert.ok(!noRepo.includes('release/'));
});

test('tests.tsv round-trips, and has the rows for every Accept, suffix and malformed path', () => {
  const rows = testRows({ ...C, turtle: true });
  assert.deepEqual(fromTsv(toTsv(rows)), rows);
  const at = (path, accept) => rows.find((r) => r.path === path && r.accept === accept);
  assert.deepEqual(at('antonine-test/place/iter-iii', BROWSER), { path: 'antonine-test/place/iter-iii', accept: BROWSER, status: 303, location: C.site + 'place/iter-iii/', note: 'a place, from a browser: its page' });
  assert.equal(at('antonine-test/place/iter-iii', '-').location, C.site + 'place/iter-iii.jsonld');
  assert.equal(at('antonine-test/place/iter-iii', 'text/turtle').location, C.site + 'place/iter-iii.ttl');
  assert.equal(at('antonine-test/source/pleiades.html', 'application/ld+json').status, 302);
  assert.equal(at('antonine-test/place/a%20b', '-').status, 404);
  assert.equal(at('antonine-test/release/data-2026-10-01', BROWSER).location, 'https://github.com/Pelagios/antonine/releases/tag/data-2026-10-01');
  assert.equal(at('antonine-test', '*/*').location, '{base}/antonine-test/');
  // Without Turtle, the Turtle rows expect 404; without a release, there are no release rows.
  const plain = testRows({ ...C, release: null });
  assert.equal(plain.find((r) => r.path === 'antonine-test/place/iter-iii' && r.accept === 'text/turtle').status, 404);
  assert.ok(!plain.some((r) => r.path.includes('/release/')));
  assert.ok(rows.some((r) => r.path.includes('/release/')));
});

// ---- the part, end to end ---------------------------------------------------------------------

test('publish w3id writes the folder: rules, README, tests from the real addresses, the script, the pull request and the steps', async () => {
  const r = await run(antonine());
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  assert.equal(r.report.counts.places, 11);
  assert.equal(r.report.counts.sources, 3);
  const files = ['ids/antonine-test/.htaccess', 'ids/antonine-test/README.md', 'tests.tsv', 'test-w3id.sh', 'PULL_REQUEST.md', 'STEPS.md'];
  for (const f of files) assert.ok(existsSync(join(r.out, 'w3id-antonine-test', f)), f);
  assert.equal(r.outputs[0].files, files.length);
  const rows = fromTsv(read(r, 'tests.tsv'));
  // Real keys of the dataset, its first places and a source it cites.
  assert.ok(rows.some((x) => x.path === 'antonine-test/place/iter-iii' && x.location === 'https://pelagios.github.io/antonine/place/iter-iii/'));
  assert.ok(rows.some((x) => x.path === 'antonine-test/source/parthey-pinder-1848'));
  assert.equal(new Set(rows.filter((x) => /\/place\/[^/]+$/.test(x.path) && !x.path.includes('not-in-the-dataset') && !x.path.includes('%') && !x.path.includes('.hidden')).map((x) => x.path.split('/')[2].replace(/\.(jsonld|html|ttl)$/, ''))).size, 3);
  const pr = read(r, 'PULL_REQUEST.md');
  assert.match(pr, /^New namespace: antonine-test \(The Antonine Itinerary/);
  assert.ok(pr.includes('\n---\n') && pr.includes('[docuracy](https://github.com/docuracy)'));
  assert.ok(read(r, 'STEPS.md').includes(APACHE_COMMAND));
  assert.ok(read(r, 'ids/antonine-test/README.md').includes('| `/release/{name}` |'));
  assert.match(r.report.counts.said.join(' '), /for 11 places and 3 sources, with \d+ addresses to test/);
});

test('a sub-namespace is a folder inside its parent, and its pull request asks the parent\'s maintainers', async () => {
  const r = await run(antonine({ base: 'https://w3id.org/pelagios/antonine/' }));
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  const root = join(r.out, 'w3id-pelagios-antonine');
  assert.ok(existsSync(join(root, 'ids/pelagios/antonine/.htaccess')));
  assert.match(readFileSync(join(root, 'PULL_REQUEST.md'), 'utf8'), /^pelagios\/antonine: add persistent addresses[\s\S]*maintainer of `pelagios`/);
});

// Each gate: the finding and nothing written; and its control, the same dataset passing it.
test('gate: only a w3id base has w3id rules; other kinds are told what to do instead', async () => {
  const custom = await run(antonine({ base: 'https://data.example-history.ac.uk/antonine/' }));
  assert.deepEqual(custom.kinds, ['not-w3id']);
  assert.match(custom.item('not-w3id').message, /CNAME/);
  assert.equal(custom.outputs.length, 0);
  const pages = await run(antonine({ base: 'https://pelagios.github.io/antonine/' }));
  assert.match(pages.item('not-w3id').message, /GitHub Pages address/);
  const ok = await run(antonine());
  assert.ok(!ok.kinds.includes('not-w3id'));
  assert.equal(ok.outputs.length, 1);
});

test('gate: only a published dataset; control: the same one published', async () => {
  const draft = await run(antonine({ status: 'draft' }));
  assert.deepEqual(draft.kinds, ['not-published']);
  assert.deepEqual(draft.item('not-published').examples, ['draft']);
  assert.equal(draft.outputs.length, 0);
  const ok = await run(antonine());
  assert.ok(!ok.kinds.includes('not-published') && ok.outputs.length === 1);
});

test('gate: a dataset with problems of its own writes nothing', async () => {
  const r = await run(antonine({ edit: (d) => { delete d.gazetteer.title; } }));
  assert.ok(r.kinds.includes('dataset-has-problems'), r.kinds.join());
  assert.equal(r.outputs.length, 0);
});

test('maintainers and the site are required, and checked', async () => {
  const none = await run(antonine(), { repo: 'pelagios/antonine' });
  assert.ok(none.kinds.includes('no-maintainers'));
  const noSite = await run(antonine(), { maintainers: ['docuracy'] });
  assert.deepEqual(noSite.kinds, ['no-site-url']);
  const bad = await run(antonine(), { maintainers: ['-bad-'], siteUrl: 'https://x.org/a b' });
  assert.deepEqual(bad.kinds.sort(), ['bad-maintainer', 'bad-site-url']);
  for (const r of [none, noSite, bad]) assert.equal(r.outputs.length, 0);
  const self = await run(antonine(), { maintainers: ['docuracy'], siteUrl: BASE });
  assert.deepEqual(self.kinds, ['site-is-base']);
});

test('a release without its repository is an error and writes nothing; control: with --repo, or without --release, the rules are written', async () => {
  const site = 'https://data.example.net/antonine/';
  const noRepo = await run(antonine(), { maintainers: ['docuracy'], siteUrl: site, release: 'v1' });
  assert.deepEqual(noRepo.kinds, ['release-without-repo']);
  const it = noRepo.item('release-without-repo');
  assert.equal(it.severity, 'error');
  assert.deepEqual(it.examples, ['v1']);
  assert.match(it.message, /--repo OWNER\/NAME/);
  assert.match(it.message, /leave out --release, which gives rules without releases/);
  assert.equal(noRepo.outputs.length, 0);
  // Either fix: the repository given (release rules), or the release left out (none).
  const withRepo = await run(antonine(), { maintainers: ['docuracy'], siteUrl: site, repo: 'Pelagios/antonine', release: 'v1' });
  assert.ok(!withRepo.kinds.includes('release-without-repo') && withRepo.outputs.length === 1, withRepo.kinds.join());
  assert.match(read(withRepo, 'ids/antonine-test/.htaccess'), /\^release\//);
  const noRelease = await run(antonine(), { maintainers: ['docuracy'], siteUrl: site });
  assert.ok(!noRelease.kinds.includes('release-without-repo') && noRelease.outputs.length === 1, noRelease.kinds.join());
  assert.doesNotMatch(read(noRelease, 'ids/antonine-test/.htaccess'), /\^release\//);
  // On the command line: exit 1 and no folder; with --repo, exit 0 and the folder.
  const data = join(dir, 'release.json'); writeFileSync(data, antonine());
  for (const [extra, code] of [[[], 1], [['--repo', 'pelagios/antonine'], 0]]) {
    const out = join(dir, `release-out-${code}`); mkdirSync(out);
    const r = cli('publish', 'w3id', '--maintainer', 'docuracy', '--site-url', site, '--release', 'v1', ...extra, '--out', out, data);
    assert.equal(r.code, code, r.out + r.err);
    assert.equal(existsSync(join(out, 'w3id-antonine-test', 'ids', 'antonine-test', '.htaccess')), code === 0);
    if (code === 1) assert.match(r.out + r.err, /release-without-repo|leave out --release/);
  }
});

test('addresses the rules cannot reach are found: bad characters, a deeper path, a suffix, a case twin; control: none in the clean dataset', async () => {
  const r = await run(antonine({ edit: (d) => {
    // Added, not renamed, so that the dataset stays one the check passes (a renamed place leaves
    // relations naming it behind): the rules are then written, and the findings are all there is.
    const p = d.spatialEntities;
    const add = (id) => p.push({ '@id': id, label: id, attestations: [{ names: [{ toponym: 'X' }] }] });
    for (const k of ['St%20Albans', 'kent/dover', 'london.html', 'Iter-III']) add(BASE + 'place/' + k);   // Iter-III: a case twin of iter-iii
    add('https://elsewhere.org/place/x');
    p[6].attestations[0].citations = [{ source: BASE + 'source/a.b/c' }];
  } }));
  assert.equal(r.item('key-unreachable').count, 3, JSON.stringify(r.item('key-unreachable')));
  assert.ok(r.item('key-unreachable').examples.some((e) => e.startsWith(BASE + 'place/St%20Albans: its last part has characters')));
  assert.ok(r.item('key-unreachable').examples.includes(BASE + 'place/kent/dover: its last part has more than one part'));
  assert.match(r.item('key-suffix').examples[0], new RegExp('^' + BASE + 'place/london\\.html: its last part ends in \\.jsonld'));
  assert.deepEqual(r.item('key-case').examples, [`${BASE}place/iter-iii and ${BASE}place/Iter-III: they differ only in capital letters`]);
  // The dataset is published, so these addresses are frozen (A3): warnings, and the rules are
  // written for the rest, with the count said in the README and the summary.
  for (const k of ['key-unreachable', 'key-suffix', 'key-case', 'place-outside-base']) assert.equal(r.item(k).severity, 'warning', k);
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items.filter((i) => i.severity === 'error')));
  assert.equal(r.outputs.length, 1);
  // A case twin is tested by neither address, since the site serves neither; the other places are.
  const tsv = read(r, 'tests.tsv');
  assert.doesNotMatch(tsv, /place\/iter-iii\b/i);
  assert.match(tsv, /place\/iter-iv\b/);
  assert.match(read(r, 'ids/antonine-test/README.md'), /\n5 addresses of the dataset are not of that form, so these rules cannot reach them; the site lists them as held in the downloads\./);
  assert.ok(r.report.counts.said.includes('5 addresses these rules cannot reach; the site lists them as held in the downloads.'), r.report.counts.said.join('\n'));
  const clean = await run(antonine());
  for (const k of ['key-unreachable', 'key-suffix', 'key-case', 'place-outside-base']) assert.ok(!clean.kinds.includes(k), k);
  assert.equal(clean.outputs.length, 1);
  assert.doesNotMatch(read(clean, 'ids/antonine-test/README.md'), /cannot reach/);
  assert.ok(!clean.report.counts.said.some((l) => /cannot reach/.test(l)) && clean.report.counts.said.length > 0);
});

test('every finding kind the part raises has its wording', () => {
  const src = readFileSync(new URL('../src/engine/agora/w3id.js', import.meta.url), 'utf8');
  const raised = new Set([...src.matchAll(/rep\.(?:add\('(?:error|warning)', |error\()'([a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(raised.size >= 10, [...raised].join());
  for (const k of raised) assert.ok(TEXT[k], k);
});

// ---- the command line -------------------------------------------------------------------------

const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
test('publish w3id on the command line: 0 and the folder when all is well, 1 when something stops it, 2 when the command is wrong', () => {
  const data = join(dir, 'cli.json'); writeFileSync(data, antonine());
  const draft = join(dir, 'draft.json'); writeFileSync(draft, antonine({ status: 'draft' }));
  const out = join(dir, 'cli-out'); mkdirSync(out);
  const ok = cli('publish', 'w3id', '--maintainer', 'docuracy', '--repo', 'pelagios/antonine', '--out', out, data);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.match(ok.out, /Nothing stops publication\. Redirect rules for https:\/\/w3id\.org\/antonine-test\//);
  assert.ok(existsSync(join(out, 'w3id-antonine-test', 'ids', 'antonine-test', '.htaccess')));
  const stopped = cli('publish', 'w3id', '--maintainer', 'docuracy', '--repo', 'pelagios/antonine', '--out', out, draft);
  assert.equal(stopped.code, 1, stopped.out + stopped.err);
  assert.match(stopped.out, /1 problem to fix before publishing\. Nothing was written\.[\s\S]*does not say that it is published/);
  const wrong = cli('publish', 'w3id');
  assert.equal(wrong.code, 2);
});

// ---- the rules in Apache ----------------------------------------------------------------------

// Docker, and the image, must be there already: a test does not download 60 MB.
function dockerProblem() {
  const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 10000 });
  if (info.error || info.status !== 0) return 'Docker is not available here' + (info.error ? ` (${info.error.code})` : '');
  const image = spawnSync('docker', ['image', 'inspect', 'httpd:2.4'], { encoding: 'utf8', timeout: 10000 });
  if (image.status !== 0) return 'the httpd:2.4 image is not pulled (docker pull httpd:2.4)';
  return null;
}

/** Ask for one row's address, as curl would: no Accept header unless the row gives one, no following. */
function ask(base, row) {
  return new Promise((resolve, reject) => {
    const headers = row.accept === '-' ? {} : { Accept: row.accept };
    const req = request(`${base}/${row.path}`, { headers }, (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location ?? '-', cors: res.headers['access-control-allow-origin'] }); });
    req.on('error', reject); req.end();
  });
}
async function failures(base, rows) {
  const bad = [];
  for (const row of rows) {
    const got = await ask(base, row);
    const want = row.location.replace('{base}', base);
    if (got.status !== row.status || got.location !== want || got.cors !== '*') bad.push({ row, got });
  }
  return bad;
}

test('the rules in Apache: every row of tests.tsv comes back as expected, and a copy without the text/html rule fails', async (t) => {
  const why = dockerProblem();
  if (why) { t.skip(`not run: ${why}`); return; }
  const r = await run(antonine(), { ...OPTIONS, turtle: true });
  assert.equal(r.report.errors, 0);
  const tree = join(r.out, 'w3id-antonine-test');
  // One Apache serves both: good/antonine-test (as written) and bad/antonine-test (mutated).
  const root = join(dir, 'htdocs');
  cpSync(join(tree, 'ids'), join(root, 'good'), { recursive: true });
  cpSync(join(tree, 'ids'), join(root, 'bad'), { recursive: true });
  const badRules = join(root, 'bad', 'antonine-test', '.htaccess');
  const h = readFileSync(badRules, 'utf8');
  const cut = h.replace(/RewriteCond %\{HTTP_ACCEPT\} text\/html \[OR\]\nRewriteCond %\{HTTP_ACCEPT\} application\/xhtml\\\+xml\nRewriteRule \^place\/[^\n]*\n/, '');
  assert.notEqual(cut, h, 'the text/html rule for places was found, to take out');
  writeFileSync(badRules, cut);
  spawnSync('chmod', ['-R', 'a+rX', dir]);
  const name = `plato-tools-w3id-test-${process.pid}`;
  const started = spawnSync('docker', apacheArgs({ ids: root, port: '', name }), { encoding: 'utf8', timeout: 60000 });
  assert.equal(started.status, 0, started.stderr);
  after(() => spawnSync('docker', ['rm', '-f', name], { timeout: 30000 }));
  const port = spawnSync('docker', ['port', name, '80/tcp'], { encoding: 'utf8' }).stdout.trim().split('\n')[0].split(':').pop();
  const host = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { try { await ask(host, { path: '', accept: '-' }); up = true; } catch { await new Promise((ok) => setTimeout(ok, 200)); } }
  assert.ok(up, 'Apache did not start');

  const rows = fromTsv(readFileSync(join(tree, 'tests.tsv'), 'utf8'));
  assert.ok(rows.length > 50, `${rows.length} rows`);
  assert.deepEqual(await failures(`${host}/good`, rows), []);
  // The control: without the text/html rule, a browser asking for a place is sent JSON-LD.
  const bad = await failures(`${host}/bad`, rows);
  assert.ok(bad.length > 0, 'the mutated rules failed no test');
  assert.ok(bad.some((b) => b.row.accept === BROWSER && b.row.path === 'antonine-test/place/iter-iii' && b.got.location === 'https://pelagios.github.io/antonine/place/iter-iii.jsonld'), JSON.stringify(bad.slice(0, 3)));

  // And the script the user runs, against both.
  if (spawnSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).status !== 0) { t.diagnostic('curl not found: test-w3id.sh not run'); return; }
  const good = spawnSync('sh', [join(tree, 'test-w3id.sh'), `${host}/good`], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, new RegExp(`\\n${rows.length} passed, 0 failed, against `));
  const worse = spawnSync('sh', [join(tree, 'test-w3id.sh'), `${host}/bad`], { encoding: 'utf8' });
  assert.equal(worse.status, 1, worse.stdout);
  assert.match(worse.stdout, /FAIL {2}\/antonine-test\/place\/iter-iii {2}\[text\/html/);
});
