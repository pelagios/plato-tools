// Agora's site: a static website made from a checked dataset, for GitHub Pages. Tested on PLATO's
// own examples (spreadsheet tables and JSON) and on small datasets made here: the files it writes,
// that each place's JSON-LD means what the dataset says of that place, what its page shows, and when
// it refuses. Every absence asserted is paired with a presence in the same test, so that a site that
// was never written, or a search that finds nothing anywhere, cannot pass.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8, gunzipSync } from 'fflate';
import jsonld from 'jsonld';
import { Parser } from 'n3';
import { env as memEnv, file, textFile, res } from './engine.js';
import { PLATO_REPO } from './paths.js';
import { detect } from '../src/engine/input.js';
import { run } from '../src/engine/pipeline.js';
import { publish } from '../src/engine/agora/index.js';
import { NodeHost } from '../src/node/host.js';
import { SITE_FILES } from '../src/engine/agora/w3id.js';
import { scheme } from '../src/engine/agora/address.js';

const TABLES = `${PLATO_REPO}/schemas/tables/examples/king-john`;
const KING_JOHN = `${PLATO_REPO}/schemas/examples/place-centric-king-john.json`;
const KJ_BASE = 'https://whgazetteer.org/example/king-john/';
const PLATO = 'https://w3id.org/plato#';
const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'plato-tools-site-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let runs = 0;

// ---- running it ---------------------------------------------------------------------------------
const tableFiles = (d) => readdirSync(d).filter((f) => f.endsWith('.csv')).map((f) => file(join(d, f)));
/** The site part on the command line's host: a folder of real files, read back from disk. */
async function site(files, options = {}) {
  // The command line names a set of tables after their folder; so does this.
  if (files.every((f) => f.name.endsWith('.csv')) && !options.name) options = { ...options, name: 'king-john' };
  const out = join(dir, `run-${++runs}`);
  const host = new NodeHost({ outDir: out });
  const { env } = host.env(res);
  const input = await detect(files);
  const r = await publish({ part: 'site', input, options }, env);
  host.cleanup();
  const siteDir = r.outputs[0]?.path;
  return {
    r, out, siteDir, repoDir: r.outputs[1]?.path,
    kinds: r.report.items.map((i) => i.kind),
    item: (kind) => r.report.items.find((i) => i.kind === kind),
    has: (p) => !!siteDir && existsSync(join(siteDir, p)),
    read: (p) => readFileSync(join(siteDir, p), 'utf8'),
  };
}
/** The same in the browser's way: no folders, so one zip per tree. */
async function siteInBrowser(files, options = {}) {
  const e = memEnv();
  const r = await publish({ part: 'site', input: await detect(files), options }, e);
  const zips = Object.fromEntries(Object.entries(e.outs).map(([k, parts]) => [k, unzipSync(new Uint8Array(Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : Buffer.from(p))))))]));
  return { r, e, zips, kinds: r.report.items.map((i) => i.kind) };
}
const memOuts = (b) => Object.fromEntries(Object.entries(b.e.outs).map(([k, parts]) => [k, parts.map((p) => Buffer.from(p))]));
/** Every file under a folder, as paths relative to it. */
function walk(root, at = '') {
  return readdirSync(join(root, at), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(root, join(at, d.name)) : [join(at, d.name)]));
}

// A PLATO JSON dataset from the King John example, moved to `base` if given, published or not,
// with its attestations given addresses by hand (<place>#a-<8 hex>) when `mint` is set, and one of
// Windsor's retracted by a later attestation.
function kingJohn({ base = KJ_BASE, status = 'draft', mint = true, retract = true } = {}) {
  const doc = JSON.parse(readFileSync(KING_JOHN, 'utf8').replaceAll(KJ_BASE, base));
  doc.gazetteer.status = status;
  doc.gazetteer.version = '2026-10';
  let n = 0;
  for (const p of doc.spatialEntities) for (const a of p.attestations) if (mint) a['@id'] = `${p['@id']}#a-${(++n).toString(16).padStart(8, '0')}`;
  const windsor = doc.spatialEntities.find((p) => p['@id'].endsWith('/windsor'));
  if (retract) {
    windsor.attestations.push({
      ...(mint ? { '@id': windsor['@id'] + '#a-ffffffff' } : {}),
      meta: { targetAttestation: windsor.attestations[0]['@id'] || windsor['@id'] + '#a-00000000', metaType: PLATO + 'Retracts' },
      sources: [{ title: 'Editorial correction' }], created: '2026-10-01T00:00:00Z', notes: 'Withdrawn: wrong point.',
    });
  }
  return doc;
}
const jsonFile = (doc, name = 'king-john.json') => textFile(JSON.stringify(doc), name);

// ---- the graph, compared --------------------------------------------------------------------------
const CTX = JSON.parse(readFileSync('public/plato/plato.context.jsonld', 'utf8'));
// jsonld.js is given PLATO's context from the vendored copy: no test reaches the network.
const documentLoader = async (url) => {
  if (url === 'https://w3id.org/plato/schemas/plato.context.jsonld') return { contextUrl: null, documentUrl: url, document: CTX };
  throw new Error(`the test would fetch ${url}`);
};
/**
 * A graph as a set of statements with no blank node labels in them: a node without an address is
 * written out in place, as what it says, so that two files' graphs compare as sets. Statements are
 * made for the roots only (a subject with an address, or a blank node nothing points to).
 */
async function statements(doc) {
  const nq = await jsonld.toRDF(doc, { format: 'application/n-quads', documentLoader, safe: false });
  const quads = new Parser({ format: 'N-Quads' }).parse(nq);
  const key = (t) => (t.termType === 'BlankNode' ? '_:' + t.value : t.value);
  const by = new Map(), pointed = new Set();
  for (const q of quads) {
    (by.get(key(q.subject)) || by.set(key(q.subject), []).get(key(q.subject))).push(q);
    if (q.object.termType === 'BlankNode') pointed.add(key(q.object));
  }
  const open = [];
  const node = (k) => { if (open.includes(k)) return '[loop]'; open.push(k); const s = '[' + (by.get(k) || []).map((q) => `<${q.predicate.value}> ${term(q.object)}`).sort().join(' ; ') + ']'; open.pop(); return s; };
  const term = (t) => (t.termType === 'NamedNode' ? `<${t.value}>` : t.termType === 'Literal' ? `${JSON.stringify(t.value)}^^${t.datatype.value}${t.language ? '@' + t.language : ''}` : node(key(t)));
  const out = new Set();
  for (const [s, qs] of by) {
    if (s.startsWith('_:') && pointed.has(s)) continue;
    const subject = s.startsWith('_:') ? node(s) : `<${s}>`;
    for (const q of qs) out.add(`${subject} <${q.predicate.value}> ${term(q.object)}`);
  }
  return out;
}
/** What the whole dataset says of one place: its own statements, and those of attestations about it. */
function aboutPlace(all, iri) {
  const about = ` <${PLATO}attests_about> <${iri}>`;
  // Attestations with addresses of their own, and those without, described in place.
  const named = new Set([...all].filter((x) => x.startsWith('<') && x.endsWith(about)).map((x) => x.slice(0, x.indexOf('> ') + 1)));
  return [...all].filter((x) => x.startsWith(`<${iri}> `) || named.has(x.slice(0, x.indexOf('> ') + 1)) || (x.startsWith('[') && x.slice(0, x.lastIndexOf('] <') + 1).includes(about.trim())));
}
/** The whole dataset as PLATO JSON, as the tools convert it, as a JSON-LD document. */
async function wholeDocument(files, base) {
  const e = memEnv();
  const r = await run({ input: await detect(files), action: 'convert', target: 'plato-json', options: { base } }, e);
  assert.equal(r.report.errors, 0);
  const text = Object.values(e.outs)[0].join('');
  return { '@context': 'https://w3id.org/plato/schemas/plato.context.jsonld', ...JSON.parse(text) };
}
async function samePlaceGraphs(s, whole, iri, key) {
  const placeDoc = JSON.parse(s.read(`place/${key}.jsonld`));
  const [mine, all] = await Promise.all([statements(placeDoc), statements(whole)]);
  const theirs = aboutPlace(all, iri);
  assert.ok(mine.size > 3 && theirs.length > 3, `${key}: too little said to compare (${mine.size}, ${theirs.length})`);
  for (const x of mine) assert.ok(all.has(x), `${key}: the page's JSON-LD says what the dataset does not: ${x.slice(0, 300)}`);
  for (const x of theirs) assert.ok(mine.has(x), `${key}: the dataset says what the page's JSON-LD does not: ${x.slice(0, 300)}`);
  return { mine, all };
}

// ---- the files ------------------------------------------------------------------------------------
test("spreadsheet tables under a w3id base: the site's files are where the addresses lead", async () => {
  const s = await site(tableFiles(TABLES), { base: 'https://w3id.org/test-x/', toolsRef: 'abc1234' });
  assert.equal(s.r.report.errors, 0, JSON.stringify(s.r.report.items));
  const sc = scheme('https://w3id.org/test-x/');
  const places = readFileSync(join(TABLES, 'places.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(',')[0]);
  assert.equal(places.length, 19);
  for (const k of places) for (const p of [SITE_FILES.page('place', k) + 'index.html', SITE_FILES.jsonld('place', k)]) assert.ok(s.has(p), p);
  for (const k of ['hardy-1835', 'chancery-rolls', 'wikidata']) for (const p of [SITE_FILES.page('source', k) + 'index.html', SITE_FILES.jsonld('source', k)]) assert.ok(s.has(p), p);
  for (const p of ['index.html', 'index.jsonld', '404.html', '.nojekyll', 'site.css', ...['.jsonl.gz', '.nt.gz', '-tables.zip'].map((x) => SITE_FILES.download(sc.stem + x))]) assert.ok(s.has(p), p);
  // Asked for neither Turtle nor a custom domain: none of either, beside the files that are there.
  assert.ok(s.has('place/windsor.jsonld') && !s.has('place/windsor.ttl') && !s.has('index.ttl'));
  assert.ok(s.has('index.html') && !s.has('CNAME'));
  // Nothing but what the scheme names: every file is one of these.
  const known = /^(index\.(html|jsonld)|404\.html|\.nojekyll|site\.css|download\/test-x(\.jsonl\.gz|\.nt\.gz|-tables\.zip)|(place|source)\/[A-Za-z0-9._~-]+(\.jsonld|\/index\.html))$/;
  const all = walk(s.siteDir);
  assert.equal(all.length, 3 + 2 + 19 * 2 + 3 * 2 + 3);
  for (const f of all) assert.match(f, known);
  // The downloads are the dataset: its JSON Lines hold every place, and its N-Triples name one.
  const jsonl = strFromU8(gunzipSync(readFileSync(join(s.siteDir, 'download/test-x.jsonl.gz')))).trim().split('\n');
  assert.equal(jsonl.length, 1 + 19);
  assert.match(strFromU8(gunzipSync(readFileSync(join(s.siteDir, 'download/test-x.nt.gz')))), /<https:\/\/w3id\.org\/test-x\/place\/windsor>/);
  assert.ok(Object.keys(unzipSync(readFileSync(join(s.siteDir, 'download/test-x-tables.zip')))).some((f) => f.endsWith('places.csv')));
  // The repository's part: the workflow, pinned, building this dataset under this base.
  const wf = readFileSync(join(s.repoDir, '.github/workflows/pages.yml'), 'utf8');
  assert.match(wf, /npx --yes github:pelagios\/plato-tools#abc1234 publish site 'king-john\/' --out _build --base 'https:\/\/w3id\.org\/test-x\/'/);
  assert.match(wf, /path: _build\/king-john-site\n\s+# .*\n\s+include-hidden-files: true/);
  assert.match(wf, /actions\/deploy-pages@v5/);
  assert.match(wf, /pages: write\n\s+id-token: write/);
  assert.match(readFileSync(join(s.repoDir, 'README-agora.md'), 'utf8'), /publish mint/);
  assert.ok(!s.kinds.includes('tools-ref-unpinned') && s.kinds.includes('attestations-without-ids'));
});

test("each place's JSON-LD expands to what the whole dataset says of that place (tables)", async () => {
  const base = 'https://w3id.org/test-x/';
  const s = await site(tableFiles(TABLES), { base });
  const whole = await wholeDocument(tableFiles(TABLES), base);
  for (const key of ['windsor', 'itinerary-1215', 'runnymede']) await samePlaceGraphs(s, whole, base + 'place/' + key, key);
  // The record is the dataset's own, not a rewriting of it.
  const rec = whole.spatialEntities.find((p) => p['@id'] === base + 'place/windsor');
  assert.deepEqual(JSON.parse(s.read('place/windsor.jsonld')).spatialEntities[0], rec);
});

test("each place's JSON-LD expands to what the whole dataset says of that place (JSON), and a change is seen", async () => {
  const doc = kingJohn({ status: 'published' });
  const s = await site([jsonFile(doc)]);
  assert.equal(s.r.report.errors, 0, JSON.stringify(s.r.report.items));
  const whole = { '@context': 'https://w3id.org/plato/schemas/plato.context.jsonld', ...doc };
  const { all } = await samePlaceGraphs(s, whole, KJ_BASE + 'place/windsor', 'windsor');
  await samePlaceGraphs(s, whole, KJ_BASE + 'place/odiham', 'odiham');
  // The comparison can fail: a place's document with its label changed says what the dataset does not.
  const changed = JSON.parse(s.read('place/windsor.jsonld'));
  changed.spatialEntities[0].label = 'Not Windsor';
  const mine = await statements(changed);
  assert.ok([...mine].some((x) => !all.has(x)), 'a changed document still matched the dataset');
});

test("a place's Turtle is the same graph as its JSON-LD", async () => {
  const s = await site(tableFiles(TABLES), { base: 'https://w3id.org/test-x/', turtle: true });
  assert.ok(s.has('place/windsor.ttl') && s.has('index.ttl') && s.has('source/hardy-1835.ttl'));
  const canon = (nq) => jsonld.canonize(nq, { algorithm: 'URDNA2015', inputFormat: 'application/n-quads', format: 'application/n-quads', safe: false });
  const nq = (quads) => quads.map((q) => `${q.subject.termType === 'BlankNode' ? '_:' + q.subject.value : `<${q.subject.value}>`} <${q.predicate.value}> ${q.object.termType === 'NamedNode' ? `<${q.object.value}>` : q.object.termType === 'BlankNode' ? '_:' + q.object.value : JSON.stringify(q.object.value) + (q.object.language ? '@' + q.object.language : `^^<${q.object.datatype.value}>`)} .\n`).join('');
  for (const key of ['windsor', 'itinerary-1215']) {
    const ttl = new Parser({ format: 'text/turtle' }).parse(s.read(`place/${key}.ttl`));
    const fromLd = await jsonld.toRDF(JSON.parse(s.read(`place/${key}.jsonld`)), { format: 'application/n-quads', documentLoader, safe: false });
    assert.ok(ttl.length > 5);
    assert.equal(await canon(nq(ttl)), await canon(fromLd), key);
  }
  // A source's JSON-LD and Turtle: the same graph, and what the dataset says of the source.
  const ttl = new Parser({ format: 'text/turtle' }).parse(s.read('source/hardy-1835.ttl'));
  const ld = JSON.parse(s.read('source/hardy-1835.jsonld'));
  const fromLd = await jsonld.toRDF(ld, { format: 'application/n-quads', documentLoader, safe: false });
  assert.match(fromLd, /<https:\/\/w3id\.org\/test-x\/source\/hardy-1835> <https:\/\/w3id\.org\/plato#authority_title> "A Description of the Patent Rolls/);
  assert.equal(await canon(nq(ttl)), await canon(fromLd));
});

// ---- the pages ------------------------------------------------------------------------------------
/** The <article> for one attestation, found by its id: the searches below look inside it only. */
const article = (html, id) => (html.match(new RegExp(`<article [^>]*id="${id}"[^>]*>[\\s\\S]*?</article>`)) || [null])[0];

test("a place's page shows its names, an element for each minted attestation, and a retracted one labelled, not hidden", async () => {
  const doc = kingJohn({ status: 'published' });
  const s = await site([jsonFile(doc)]);
  const html = s.read('place/windsor/index.html');
  const windsor = doc.spatialEntities.find((p) => p['@id'].endsWith('/windsor'));
  for (const n of windsor.attestations.flatMap((a) => a.names || [])) assert.ok(html.includes(`<strong>${n.toponym}</strong>`), n.toponym);
  assert.match(html, /<h1>Windsor<\/h1>/);
  const retracted = windsor.attestations[0]['@id'].split('#')[1], kept = windsor.attestations[1]['@id'].split('#')[1];
  const a1 = article(html, retracted), a2 = article(html, kept), a3 = article(html, 'a-ffffffff');
  assert.ok(a1 && a2 && a3, 'an attestation with an address has an element with that id');
  assert.match(a1, /class="att withdrawn"/);
  assert.match(a1, /<span class="label">Retracted<\/span>/);
  assert.match(a1, /href="#a-ffffffff"|href="\.\.\/\.\.\/place\/windsor\/#a-ffffffff"/);
  assert.doesNotMatch(a2, /Retracted|withdrawn/);   // beside it, one still held is not labelled
  assert.match(a3, /Comments on/);
  // Its own data, for machines, and the way back.
  assert.match(html, /<link rel="alternate" type="application\/ld\+json" href="\.\.\/windsor\.jsonld">/);
  assert.match(html, /<a href="\.\.\/\.\.\/">/);
  assert.match(html, /To cite: Windsor\. King John.*, version 2026-10\. https:\/\/whgazetteer\.org\/example\/king-john\/place\/windsor/);
  // No script, and nothing fetched from elsewhere: every src or stylesheet is the site's own.
  assert.doesNotMatch(html, /<script|src="http|href="https?:[^"]*\.css/);
  assert.match(html, /<link rel="stylesheet" href="\.\.\/\.\.\/site\.css">/);
});

test('a draft has a banner and is kept from search engines; a published dataset has neither', async () => {
  const draft = await site([jsonFile(kingJohn({ status: 'draft' }))]);
  const pub = await site([jsonFile(kingJohn({ status: 'published' }))]);
  for (const p of ['index.html', 'place/windsor/index.html', 'source/hardy-1835/index.html', '404.html']) {
    const d = draft.read(p), q = pub.read(p);
    assert.match(d, /<meta name="robots" content="noindex">/, p);
    assert.match(d, /DRAFT, not citable/, p);
    assert.doesNotMatch(q, /noindex|DRAFT/, p);
    assert.match(q, /<main>/, p);
  }
  assert.match(pub.read('index.html'), /<h2>How to cite<\/h2>\n<p>[^<]*version 2026-10\. https:\/\/whgazetteer\.org\/example\/king-john\//);
});

test('the landing page describes the dataset, for people and in schema.org, with its downloads and places', async () => {
  const s = await site([jsonFile(kingJohn({ status: 'published' }))], { conceptDoi: '10.5281/zenodo.123' });
  const html = s.read('index.html');
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(ld['@type'], 'Dataset');
  assert.ok([].concat(ld.identifier).includes('https://doi.org/10.5281/zenodo.123'));
  assert.equal(ld.distribution.length, 3);
  assert.ok(ld.distribution.every((d) => d.contentUrl.startsWith(KJ_BASE + 'download/king-john')));
  assert.match(html, /https:\/\/doi\.org\/10\.5281\/zenodo\.123/);
  assert.match(html, /ORCID 0000-0003-3060-0181/);
  assert.match(html, /<a href="download\/king-john\.jsonl\.gz">/);
  assert.match(html, /<a href="place\/windsor\/">Windsor<\/a>/);
  assert.equal(JSON.parse(s.read('index.jsonld'))['@context'], 'https://w3id.org/plato/schemas/plato.context.jsonld');
});

test('a source page lists the places citing it, and each attestation links to its source page', async () => {
  const s = await site(tableFiles(TABLES), { base: 'https://w3id.org/test-x/' });
  const src = s.read('source/hardy-1835/index.html');
  assert.match(src, /<h1>A Description of the Patent Rolls/);
  assert.match(src, /<a href="\.\.\/\.\.\/place\/windsor\/">Windsor<\/a>/);
  assert.match(src, /Derived from<\/dt><dd><a href="\.\.\/\.\.\/source\/chancery-rolls\/">/);
  assert.match(s.read('place/windsor/index.html'), /<a href="\.\.\/\.\.\/source\/hardy-1835\/">/);
});

// ---- the root, by kind of base (E2) -------------------------------------------------------------
test('a CNAME file only for a domain of its own at its root; a path on one is warned about', async () => {
  const custom = await site([jsonFile(kingJohn({ base: 'https://places.history.example.ac.uk/' }))]);
  assert.equal(custom.read('CNAME'), 'places.history.example.ac.uk\n');
  const w3id = await site([jsonFile(kingJohn({ base: 'https://w3id.org/test-kj/' }))]);
  assert.ok(w3id.has('index.html') && !w3id.has('CNAME'));
  const pathed = await site([jsonFile(kingJohn({ base: 'https://places.history.example.ac.uk/kj/' }))]);
  assert.ok(pathed.has('index.html') && !pathed.has('CNAME'));
  assert.ok(pathed.kinds.includes('custom-domain-path') && !custom.kinds.includes('custom-domain-path'));
  // The 404 page's links start from the site's own address, where it is known.
  assert.match(custom.read('404.html'), /href="https:\/\/places\.history\.example\.ac\.uk\/download\/places\.history\.example\.ac\.uk\.jsonl\.gz"|href="https:\/\/places\.history\.example\.ac\.uk\/download\/[^"]+\.jsonl\.gz"/);
  const repo = await site([jsonFile(kingJohn({ base: 'https://w3id.org/test-kj/' }))], { repo: 'Pelagios/kj-site' });
  assert.match(repo.read('404.html'), /href="https:\/\/pelagios\.github\.io\/kj-site\/download\/test-kj\.jsonl\.gz"/);
  assert.ok(w3id.kinds.includes('site-address-unknown') && !repo.kinds.includes('site-address-unknown'));
});

// ---- when it refuses, and what it leaves out --------------------------------------------------------
test('too big for Pages: the page refuses and writes nothing; the command line writes it and warns', async () => {
  const files = () => [jsonFile(kingJohn())];
  const browser = await siteInBrowser(files(), { limitBytes: 10_000 });
  assert.ok(browser.r.report.items.find((i) => i.kind === 'too-big-for-pages')?.severity === 'error');
  assert.equal(browser.r.outputs.length, 0);
  assert.equal(Object.keys(browser.zips).length, 0);
  const cli = await site(files(), { limitBytes: 10_000 });
  assert.equal(cli.item('too-big-for-pages')?.severity, 'warning');
  assert.ok(cli.has('place/windsor/index.html'));
  // Within the limit the page writes the same site, as a zip, and nothing is refused.
  const ok = await siteInBrowser(files());
  assert.ok(!ok.kinds.includes('too-big-for-pages'));
  const zip = ok.zips['king-john-site.zip'];
  assert.ok(zip && zip['place/windsor/index.html'] && zip['index.html'] && zip['.nojekyll']);
  assert.ok(ok.zips['king-john-repo.zip']['.github/workflows/pages.yml']);
});

test('the estimate is not less than what is written, on the tables and JSON examples', async () => {
  const measured = [];
  for (const [name, files, options] of [['tables', () => tableFiles(TABLES), { base: 'https://w3id.org/test-x/' }], ['json', () => [jsonFile(kingJohn())], {}], ['json+turtle', () => [jsonFile(kingJohn())], { turtle: true }]]) {
    const s = await site(files(), options);
    const written = walk(s.siteDir).reduce((n, f) => n + statSync(join(s.siteDir, f)).size, 0);
    measured.push(`${name}: estimated ${s.r.report.counts.estimate}, wrote ${written} (${(s.r.report.counts.estimate / written).toFixed(2)})`);
    assert.ok(s.r.report.counts.estimate >= written, measured.at(-1));
    assert.ok(s.r.report.counts.estimate < 4 * written, `wildly over: ${measured.at(-1)}`);
  }
  console.log(measured.join('\n'));
});

test('--only: the places left out have no files, and the 404 page and the report say where they are', async () => {
  const s = await site([jsonFile(kingJohn())], { only: ['windsor', 'odiham', 'nowhere'] });
  assert.ok(s.has('place/windsor/index.html') && s.has('place/odiham.jsonld'));
  assert.ok(!s.has('place/runnymede/index.html') && !s.has('place/runnymede.jsonld'));
  assert.equal(s.item('places-left-out')?.count, 17);
  assert.equal(s.item('only-unknown')?.examples[0], 'nowhere');
  assert.match(s.read('404.html'), /leaves out 17 of the dataset/);
  // A link to a place left out goes to its address, not to a page the site does not have.
  const odiham = s.read('place/odiham/index.html');
  assert.match(odiham, /href="https:\/\/whgazetteer\.org\/example\/king-john\/place\/itinerary-1215"/);
  assert.doesNotMatch(odiham, /href="\.\.\/\.\.\/place\/itinerary-1215\/"/);
  const all = await site([jsonFile(kingJohn())]);
  assert.match(all.read('place/odiham/index.html'), /href="\.\.\/\.\.\/place\/itinerary-1215\/"/);
});

test('addresses a static site cannot serve, or that differ only in case, are errors and get no files', async () => {
  const doc = kingJohn();
  doc.spatialEntities.push({ '@id': KJ_BASE + 'place/St%20Ives', label: 'St Ives', attestations: [{ '@id': KJ_BASE + 'place/St%20Ives#a-1', names: [{ toponym: 'St Ives' }] }] });
  doc.spatialEntities.push({ '@id': KJ_BASE + 'place/Windsor', label: 'Windsor again', attestations: [{ '@id': KJ_BASE + 'place/Windsor#a-1', names: [{ toponym: 'Windsor' }] }] });
  const s = await site([jsonFile(doc)]);
  assert.equal(s.item('key-not-servable')?.severity, 'error');
  assert.match(s.item('key-not-servable').examples[0], /St%20Ives/);
  assert.equal(s.item('keys-differ-in-case')?.severity, 'error');
  assert.ok(!s.has('place/St%20Ives.jsonld') && !s.has('place/Windsor.jsonld') && !s.has('place/windsor.jsonld'));
  assert.ok(s.has('place/odiham.jsonld'));
});

test('attestations without addresses: a warning in a draft, an error that stops a published site', async () => {
  const draft = await site([jsonFile(kingJohn({ mint: false, retract: false }))]);
  assert.equal(draft.item('attestations-without-ids')?.severity, 'warning');
  assert.equal(draft.item('attestations-without-ids').count, 47);
  assert.ok(draft.has('place/windsor/index.html'));
  const pub = await site([jsonFile(kingJohn({ status: 'published', mint: false, retract: false }))]);
  assert.equal(pub.item('attestations-without-ids')?.severity, 'error');
  assert.match(pub.item('attestations-without-ids').message, /plato-tools publish mint/);
  assert.equal(pub.r.outputs.length, 0);
  // Minted, the same published dataset has no such finding, and a site.
  const minted = await site([jsonFile(kingJohn({ status: 'published', retract: false }))]);
  assert.ok(!minted.kinds.includes('attestations-without-ids') && minted.has('index.html'));
});

test('a place given twice (the same address, or one differing after #) has one page, the first, and is an error', async () => {
  const doc = kingJohn();
  const windsor = doc.spatialEntities.find((p) => p['@id'].endsWith('/windsor'));
  const odiham = doc.spatialEntities.find((p) => p['@id'].endsWith('/odiham'));
  doc.spatialEntities.push({ '@id': windsor['@id'], label: 'Windsor the second', attestations: [{ '@id': windsor['@id'] + '#a-2nd00001', names: [{ toponym: 'Windlesora' }] }] });
  doc.spatialEntities.push({ '@id': odiham['@id'] + '#here', label: 'Odiham the second', attestations: [{ '@id': odiham['@id'] + '#a-2nd00002', names: [{ toponym: 'Odiham' }] }] });
  // On the command line's host a second file at the same path was refused (EEXIST) and the run died.
  const s = await site([jsonFile(doc)]);
  assert.equal(s.item('duplicate-place')?.severity, 'error');
  assert.equal(s.item('duplicate-place').count, 2);
  assert.deepEqual(s.item('duplicate-place').examples, [windsor['@id'], odiham['@id'] + '#here']);
  const page = s.read('place/windsor/index.html');
  assert.match(page, new RegExp(`<h1>${windsor.label}`));
  assert.doesNotMatch(page, /Windsor the second|Windlesora/);
  assert.doesNotMatch(s.read('place/odiham/index.html'), /Odiham the second/);
  assert.equal(s.r.report.counts.places, 19);
  // In the browser's zip, one entry for the place, not two.
  const b = await siteInBrowser([jsonFile(doc)]);
  assert.ok(b.kinds.includes('duplicate-place'));
  const names = [];
  unzipSync(new Uint8Array(Buffer.concat(memOuts(b)['king-john-site.zip'])), { filter: (f) => { names.push(f.name); return false; } });
  assert.equal(names.filter((n) => n === 'place/windsor/index.html').length, 1);
  assert.ok(names.includes('place/odiham.jsonld'));
});

test("an attestation's anchor is kept when its place's address has a fragment of its own", async () => {
  const doc = kingJohn({ retract: false });
  const place = KJ_BASE + 'place/frag-town';
  doc.spatialEntities.push({ '@id': place + '#this', label: 'Frag Town', attestations: [{ '@id': place + '#a-0000abcd', names: [{ toponym: 'Frag Town' }] }] });
  const s = await site([jsonFile(doc)]);
  assert.match(s.read('place/frag-town/index.html'), /<article class="att" id="a-0000abcd">/);
  assert.match(s.read('place/windsor/index.html'), /<article class="att" id="a-/);
});

test('a PeriodO link on a page is a link, not its markup shown as text', async () => {
  const doc = kingJohn({ retract: false });
  const windsor = doc.spatialEntities.find((p) => p['@id'].endsWith('/windsor'));
  windsor.attestations[0].timespans = [{ startEarliest: '1215', endLatest: '1216', label: 'reign of <John>', periodoUri: 'http://n2t.net/ark:/99152/p0qhb66' }];
  const page = (await site([jsonFile(doc)])).read('place/windsor/index.html');
  assert.match(page, /1215 to 1216, “reign of &lt;John&gt;”, <a href="http:\/\/n2t\.net\/ark:\/99152\/p0qhb66">PeriodO<\/a>/);
  assert.doesNotMatch(page, /&lt;a href/);
});

test('a site address that is not an http(s) address is refused, as the w3id rules refuse it', async () => {
  for (const bad of ['javascript:alert(1)//', 'ftp://example.org/', 'https://example.org/"><script>']) {
    const s = await siteInBrowser([jsonFile(kingJohn())], { siteUrl: bad });
    assert.equal(s.r.report.items.find((i) => i.kind === 'bad-site-url')?.severity, 'error', bad);
    assert.equal(s.r.outputs.length, 0, bad);
  }
  const ok = await siteInBrowser([jsonFile(kingJohn())], { siteUrl: 'https://kj.example.ac.uk/site/' });
  assert.ok(!ok.kinds.includes('bad-site-url') && ok.r.outputs.length === 2);
});

test('a dataset that cannot be read to the end the second time leaves no site, and says where it was', async () => {
  const text = readFileSync(KING_JOHN, 'utf8');
  // Read whole until the site's second reading of the places (its last), then cut short.
  class Flaky extends File { constructor(from) { super([text], 'flaky.json'); this.from = from; this.n = 0; } stream() { return ++this.n >= this.from ? new Blob([text.slice(0, text.length / 2)]).stream() : super.stream(); } }
  const out = join(dir, 'flaky');
  const runOn = async (from) => {
    const host = new NodeHost({ outDir: out, overwrite: true });
    const { env, finish } = host.env(res);
    const f = new Flaky(from);
    const r = await publish({ part: 'site', input: await detect([f]), options: {} }, env);
    const done = finish(!!r.incomplete);
    host.cleanup();
    return { r, done, reads: f.n };
  };
  const whole = await runOn(Infinity);
  assert.ok(!whole.r.incomplete && existsSync(join(out, 'flaky-site/place/windsor/index.html')));
  rmSync(out, { recursive: true, force: true });
  // The last reading is the second of the places, after the downloads (each a reading of its own).
  const cut = await runOn(whole.reads);
  assert.equal(cut.r.incomplete, true);
  const item = cut.r.report.items.find((i) => i.kind === 'dataset-not-read');
  assert.match(item.message, /second time/);
  assert.equal(item.examples[0], join(out, 'flaky-site'));
  assert.ok(cut.done.removed.some((p) => p.endsWith('index.html')));
  assert.equal(existsSync(join(out, 'flaky-site')), false);
});

// ---- the command line -------------------------------------------------------------------------------
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };

test('publish site on the command line writes both folders, and exits 0, 1 or 2', () => {
  const out = join(dir, 'cli');
  const r = cli('publish', 'site', TABLES, '--base', 'https://w3id.org/test-x/', '--out', out, '--tools-ref', 'abc1234');
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(existsSync(join(out, 'king-john-site/place/windsor/index.html')) && existsSync(join(out, 'king-john-repo/.github/workflows/pages.yml')));
  assert.match(r.out, /A site of 19 places and 3 sources/);
  // --only reads its file; a file that is not there is a wrong command.
  const only = join(dir, 'only.txt');
  writeFileSync(only, 'windsor\nodiham\n');
  const sub = cli('publish', 'site', TABLES, '--base', 'https://w3id.org/test-x/', '--out', join(dir, 'cli-only'), '--only', only, '--json');
  const j = JSON.parse(sub.out.trim());
  assert.equal(sub.code, 0);
  assert.equal(j.counts.places, 2);
  assert.ok(existsSync(join(dir, 'cli-only/king-john-repo/.github/plato-site-only.txt')));
  assert.equal(cli('publish', 'site', TABLES, '--out', join(dir, 'cli-x'), '--only', join(dir, 'missing.txt')).code, 2);
  // A published dataset without attestation addresses: problems, exit 1, and no site.
  const pub = join(dir, 'pub.json');
  writeFileSync(pub, JSON.stringify(kingJohn({ status: 'published', mint: false, retract: false })));
  const p = cli('publish', 'site', pub, '--out', join(dir, 'cli-pub'));
  assert.equal(p.code, 1, p.out);
  // Nothing at all under --out: not the site, and not a folder made for it and left empty.
  assert.deepEqual(leftIn(join(dir, 'cli-pub')), []);
  assert.ok(leftIn(out).length > 10);   // the same listing finds what a run wrote
});

/** Every file and folder under `d`, or none when it is not there. */
const leftIn = (d) => (existsSync(d) ? readdirSync(d, { recursive: true }) : []);

test('a publish site that fails part-way leaves nothing it made, and keeps what was there', () => {
  const out = join(dir, 'cli-fail');
  // A file in the way of the second folder: the run fails there, after the site was written.
  mkdirSync(join(out, 'king-john-repo/.github/workflows'), { recursive: true });
  writeFileSync(join(out, 'king-john-repo/.github/workflows/pages.yml'), 'mine\n');
  const r = cli('publish', 'site', TABLES, '--base', 'https://w3id.org/test-x/', '--out', out, '--tools-ref', 'abc1234');
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /already exists; give --overwrite[^]*Nothing was written/);
  assert.equal(existsSync(join(out, 'king-john-site')), false);
  assert.deepEqual(leftIn(out).sort(), ['king-john-repo', 'king-john-repo/.github', 'king-john-repo/.github/workflows', 'king-john-repo/.github/workflows/pages.yml']);
  assert.equal(readFileSync(join(out, 'king-john-repo/.github/workflows/pages.yml'), 'utf8'), 'mine\n');
  // With --overwrite the same run succeeds, and writes the site that failed to be kept above.
  const ok = cli('publish', 'site', TABLES, '--base', 'https://w3id.org/test-x/', '--out', out, '--tools-ref', 'abc1234', '--overwrite');
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.ok(existsSync(join(out, 'king-john-site/place/windsor/index.html')));
  assert.notEqual(readFileSync(join(out, 'king-john-repo/.github/workflows/pages.yml'), 'utf8'), 'mine\n');
});
