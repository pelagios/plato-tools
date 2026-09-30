import { PLATO_REPO } from './paths.js';
// Agora's report (src/engine/agora/fair.js): the FAIR checks on a dataset's description, and the
// deposit files made from it.
//
// A check that never fires passes every dataset, so each is shown firing on a description with one
// thing wrong, and not firing on the good description it was made from, in the same test. A good
// run also asserts that its records were read and its files written, or a dataset that was never
// read would pass too.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env as baseEnv, file, textFile } from './engine.js';
import { detect } from '../src/engine/input.js';
import { publish } from '../src/engine/agora/index.js';
import { scheme } from '../src/engine/agora/address.js';
import { orcidProblem, orcidChecksumOk, recogniseLicence, schemaOrgDataset, slug, TEXT } from '../src/engine/agora/fair.js';

const BASE = 'https://w3id.org/fair-test/';
const GOOD = Object.freeze({
  '@id': BASE, title: 'A test gazetteer of market towns',
  description: 'Market towns of a county, their names as the charters give them, and where they were.',
  creator: [{ '@id': 'https://orcid.org/0000-0002-1825-0097', name: 'Josiah Carberry' }],
  licence: 'https://creativecommons.org/licenses/by/4.0/', version: '1.0', status: 'draft',
  keywords: ['markets', 'charters'], spatial: ['http://www.wikidata.org/entity/Q21'],
  temporal: { startDate: '1200', endDate: '1500' }, uriSpace: BASE,
});
const place = (base, id, srcBase = base) => ({
  '@id': `${base}place/${id}`, label: id,
  attestations: [{ names: [{ toponym: id }], sources: [{ '@id': `${srcBase}source/s-${id}`, title: 'Charter' }], citations: [{ source: `${srcBase}source/cited-only` }] }],
});
const doc = (gazetteer, places = [place(BASE, 'a'), place(BASE, 'b')]) => ({ profile: 'place-centric', gazetteer, spatialEntities: places });
const edit = (change) => { const g = structuredClone(GOOD); change(g); return g; };

/** The test engine's env, with a folder that keeps its files in memory (as the command line's writes them to disk). */
function env() {
  const e = baseEnv();
  e.files = {};
  e.folder = async (name) => ({
    path: name,
    file: async (rel) => { const parts = []; return { write: (s) => parts.push(s), writeBytes: (b) => parts.push(Buffer.from(b).toString()), close: async () => { e.files[`${name}/${rel}`] = parts.join(''); return { name: rel, size: parts.join('').length }; } }; },
  });
  return e;
}
async function report(d, options = {}) {
  const e = env();
  const input = await detect([textFile(JSON.stringify(d), 'fair.json')]);
  const r = await publish({ part: 'report', input, options }, e);
  return { ...r.report, outputs: r.outputs, files: e.files };
}
const item = (r, kind) => r.items.find((i) => i.kind === kind);
const kinds = (r) => r.items.map((i) => `${i.severity}:${i.kind}`).sort();

test('a good description passes every check, is read, and gets its deposit files', async () => {
  const r = await report(doc(GOOD));
  assert.deepEqual(kinds(r), []);
  assert.equal(r.errors, 0);
  assert.equal(r.counts.places, 2, 'the records were read');
  assert.equal(r.counts.fair.passed, r.counts.fair.of);
  assert.ok(r.counts.fair.of >= 17);
  assert.match(r.counts.said[0], /^\d+ of \d+ FAIR checks pass\.$/);
  assert.ok(r.counts.said.includes(`The site will be the landing page, at ${BASE}.`));
  assert.deepEqual(Object.keys(r.files).sort(), ['a-test-gazetteer-of-market-towns-deposit/.zenodo.json', 'a-test-gazetteer-of-market-towns-deposit/CITATION.cff', 'a-test-gazetteer-of-market-towns-deposit/README.txt', 'a-test-gazetteer-of-market-towns-deposit/datacite.json']);
  assert.equal(r.outputs.length, 1);
});

// Each: an edit to the good description, the finding it must raise, and its severity.
const FIRES = [
  ['no description', (g) => delete g.description, 'no-description', 'warning'],
  ['a short description', (g) => { g.description = 'Market towns.'; }, 'short-description', 'warning'],
  ['a long description', (g) => { g.description = 'x'.repeat(5001); }, 'long-description', 'warning'],
  ['no creator', (g) => delete g.creator, 'no-creator', 'warning'],
  ['a creator by name only', (g) => { g.creator = [{ name: 'Josiah Carberry' }]; }, 'creator-without-orcid', 'warning'],
  ['a creator by another address', (g) => { g.creator = [{ '@id': 'https://example.org/people/jc', name: 'J C' }]; }, 'creator-id-unrecognised', 'warning'],
  ['an ORCID with a wrong check digit', (g) => { g.creator[0]['@id'] = 'https://orcid.org/0000-0002-1825-0098'; }, 'orcid-checksum', 'error'],
  ['an ORCID not written as one', (g) => { g.creator[0]['@id'] = 'https://orcid.org/0000-0002-1825'; }, 'orcid-malformed', 'error'],
  ['a contributor with a wrong ORCID', (g) => { g.contributor = 'https://orcid.org/0000-0002-1825-0091'; }, 'orcid-checksum', 'error'],
  ['a ROR not written as one', (g) => { g.creator = [{ '@id': 'https://ror.org/12345', name: 'An institute' }]; }, 'ror-malformed', 'error'],
  ['a creator by ORCID only', (g) => { delete g.creator[0].name; }, 'creator-without-name', 'warning'],
  ['no licence in a draft', (g) => delete g.licence, 'no-licence', 'warning'],
  ['a licence in words', (g) => { g.licence = 'CC BY 4.0'; }, 'licence-not-uri', 'warning'],
  ['a licence in words, published', (g) => { g.licence = 'CC BY 4.0'; g.status = 'published'; }, 'licence-not-uri', 'error'],
  ['a licence not recognised', (g) => { g.licence = 'https://example.org/my-licence'; }, 'licence-unrecognised', 'warning'],
  ['no keywords', (g) => delete g.keywords, 'no-keywords', 'warning'],
  ['no spatial coverage', (g) => delete g.spatial, 'no-spatial', 'warning'],
  ['no temporal coverage', (g) => delete g.temporal, 'no-temporal', 'warning'],
  ['no version', (g) => delete g.version, 'no-version', 'warning'],
  ['no status', (g) => delete g.status, 'no-status', 'warning'],
  ['a landing page that is not an address', (g) => { g.landingPage = 'our website'; }, 'landing-page-not-uri', 'warning'],
  ['a base without its closing slash', (g) => { g.uriSpace = BASE.slice(0, -1); }, 'base-no-slash', 'warning'],
  ['no dataset address', (g) => delete g['@id'], 'no-dataset-id', 'warning'],
  ['a dataset address elsewhere', (g) => { g['@id'] = 'https://example.org/other'; }, 'dataset-id-mismatch', 'error'],
  ['a previous version that is not a release', (g) => { g.previousVersion = 'https://example.org/old'; }, 'previous-version-outside', 'warning'],
  ['a custom domain', (g) => { g.uriSpace = g['@id'] = 'https://gazetteer.example.ac.uk/towns/'; }, 'base-custom', 'warning'],
];
for (const [what, change, kind, severity] of FIRES) {
  test(`the report finds ${what} (${kind}), and not in the good description`, async () => {
    const good = await report(doc(GOOD)), bad = await report(doc(edit(change)));
    assert.equal(item(good, kind), undefined, 'the good description does not raise it');
    const i = item(bad, kind);
    assert.ok(i, `${kind} raised; got ${kinds(bad)}`);
    assert.equal(i.severity, severity);
    assert.equal(i.message, TEXT[kind]);
    assert.ok(bad.counts.fair.passed < good.counts.fair.passed || kind === 'creator-without-name' || kind === 'base-no-slash', 'a failed check is counted');
    assert.equal(bad.counts.fair.of, good.counts.fair.of, 'the same checks are made');
  });
}

test('ORCIDs: the form and the ISO 7064 11,2 check digit', () => {
  assert.equal(orcidProblem('https://orcid.org/0000-0002-1825-0097'), null);
  assert.equal(orcidProblem('https://orcid.org/0000-0002-1694-233X'), null, 'a check digit of 10 is X');
  assert.equal(orcidProblem('https://orcid.org/0000-0002-1825-0098'), 'orcid-checksum', 'the check digit changed');
  assert.equal(orcidProblem('https://orcid.org/0000-0002-1835-0097'), 'orcid-checksum', 'another digit changed');
  assert.equal(orcidProblem('https://orcid.org/0000-0002-1694-2330'), 'orcid-checksum');
  assert.equal(orcidProblem('0000-0002-1825-0097'), 'orcid-malformed', 'not the full address');
  assert.equal(orcidProblem('http://orcid.org/0000-0002-1825-0097'), 'orcid-malformed');
  assert.ok(orcidChecksumOk('0000-0003-3060-0181'));
});

test('licences are recognised by address, however written, and mapped to SPDX and Zenodo ids', () => {
  assert.deepEqual([recogniseLicence('https://creativecommons.org/licenses/by/4.0/')?.spdx, recogniseLicence('http://creativecommons.org/licenses/by-sa/4.0/legalcode')?.spdx,
    recogniseLicence('https://creativecommons.org/licenses/by-nc/4.0/deed.en')?.spdx, recogniseLicence('https://creativecommons.org/publicdomain/zero/1.0/')?.zenodo,
    recogniseLicence('https://opendatacommons.org/licenses/odbl/1-0/')?.spdx, recogniseLicence('https://www.opendatacommons.org/licenses/by/1.0/')?.zenodo],
  ['CC-BY-4.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'cc0-1.0', 'ODbL-1.0', 'odc-by-1.0']);
  assert.equal(recogniseLicence('https://creativecommons.org/licenses/by/3.0/'), null);
  assert.equal(recogniseLicence('CC BY 4.0'), null);
});

test('the base is graded: w3id passes, custom warns, a temporary host warns in a draft and stops a published dataset', async () => {
  const at = (base, status) => doc(edit((g) => { g.uriSpace = g['@id'] = base; g.status = status; }), [place(base, 'a')]);
  const w3id = await report(at(BASE, 'published'));
  assert.equal(item(w3id, 'base-temporary'), undefined);
  assert.equal(item(w3id, 'base-custom'), undefined);
  assert.equal(w3id.errors, 0);
  for (const [base, kind] of [['https://someone.github.io/towns/', 'github.io'], ['http://localhost:8000/', 'local'], ['https://example.org/towns/', 'example']]) {
    const draft = await report(at(base, 'draft')), published = await report(at(base, 'published'));
    assert.equal(item(draft, 'base-temporary')?.severity, 'warning', base);
    assert.equal(item(draft, 'base-temporary').examples[0], `${base} (${kind})`);
    assert.equal(item(published, 'base-temporary')?.severity, 'error', base);
    assert.equal(published.errors, 1);
    assert.equal(published.outputs.length, 1, 'the report still writes the deposit files: FAIR problems are not check problems');
  }
});

test('places and sources outside the base are counted, with examples; places stop a published dataset', async () => {
  const other = 'https://example.org/elsewhere/';
  const places = (status) => doc(edit((g) => { g.status = status; }), [place(BASE, 'in'), place(other, 'x1', BASE), place(other, 'x2', other), place(BASE, 'in2')]);
  const draft = await report(places('draft')), published = await report(places('published')), good = await report(doc(GOOD));
  assert.equal(item(good, 'places-outside-base'), undefined);
  assert.equal(item(good, 'sources-outside-base'), undefined);
  assert.equal(draft.counts.places, 4);
  const p = item(draft, 'places-outside-base');
  assert.equal(p.severity, 'warning');
  assert.equal(p.count, 2);
  assert.deepEqual(p.examples, [`${other}place/x1`, `${other}place/x2`]);
  assert.equal(item(published, 'places-outside-base').severity, 'error');
  // A source described in full outside the base is counted; one cited by its address alone is not.
  const s = item(draft, 'sources-outside-base');
  assert.equal(s.count, 1);
  assert.deepEqual(s.examples, [`${other}source/s-x2`]);
});

test('a release: its name, and the dataset\'s address and isVersionOf for it', async () => {
  const plain = await report(doc(GOOD), { release: 'v1' });
  assert.equal(item(plain, 'release-id').examples[0], `set @id to ${BASE}release/v1 and set isVersionOf to ${BASE}`);
  const right = await report(doc(edit((g) => { g['@id'] = `${BASE}release/v1`; g.isVersionOf = BASE; g.previousVersion = `${BASE}release/v0`; })), { release: 'v1' });
  assert.equal(item(right, 'release-id'), undefined);
  assert.equal(item(right, 'previous-version-outside'), undefined);
  assert.equal(item(right, 'dataset-id-mismatch'), undefined);
  assert.equal(right.counts.fair.passed, right.counts.fair.of);
  const bad = await report(doc(GOOD), { release: '.hidden' });
  assert.equal(item(bad, 'release-name').severity, 'error');
  assert.equal(item(plain, 'release-name'), undefined);
});

test('a dataset with problems of its own is still reported on, and no deposit files are written', async () => {
  const bad = await report(doc(edit((g) => { delete g.licence; g.status = 'published'; })));
  const good = await report(doc(edit((g) => { g.status = 'published'; })));
  assert.ok(item(bad, 'dataset-has-problems'), kinds(bad));
  assert.equal(item(good, 'dataset-has-problems'), undefined);
  assert.equal(item(bad, 'no-licence'), undefined, 'the check already says a published dataset needs a licence');
  assert.ok(item(await report(doc(edit((g) => delete g.licence))), 'no-licence'), 'but says it of a draft');
  assert.deepEqual(bad.files, {});
  assert.equal(bad.outputs.length, 0);
  assert.equal(good.outputs.length, 1);
  assert.ok(bad.counts.said.includes('The deposit files are not written while the dataset has problems.'));
  assert.ok(bad.counts.fair.passed < good.counts.fair.passed, 'following PLATO is itself a check');
});

test('without a base: the report says so, the same checks are counted, and nothing is written', async () => {
  const r = await report(doc(edit((g) => { delete g.uriSpace; delete g['@id']; })));
  const good = await report(doc(GOOD));
  assert.ok(item(r, 'no-base'));
  assert.equal(item(good, 'no-base'), undefined);
  assert.equal(r.counts.fair.of, good.counts.fair.of);
  assert.equal(r.outputs.length, 0);
});

// ---- the deposit files ---------------------------------------------------------------------------

/** The top-level keys of a CITATION.cff and their scalar values; list items under their key. No YAML library: the file is written simply enough to read by line. */
function cff(text) {
  const top = {}; let key = null;
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-z-]+):(?: (.*))?$/.exec(line);
    if (m) { key = m[1]; top[key] = m[2] === undefined ? [] : m[2].startsWith('"') ? JSON.parse(m[2]) : m[2]; continue; }
    const item = /^  - ([a-z-]+): (.*)$/.exec(line) || /^    ([a-z-]+): (.*)$/.exec(line);
    const scalar = /^  - (".*")$/.exec(line);
    assert.ok(item || scalar, `a line CITATION.cff should not have: ${line}`);
    if (scalar) top[key].push(JSON.parse(scalar[1]));
    else if (line.startsWith('  - ')) top[key].push({ [item[1]]: JSON.parse(item[2].startsWith('"') ? item[2] : JSON.stringify(item[2])) });
    else Object.assign(top[key].at(-1), { [item[1]]: item[2].startsWith('"') ? JSON.parse(item[2]) : item[2] });
  }
  return top;
}

test('the deposit files parse, and carry the description', async () => {
  const g = edit((x) => { x['@id'] = `${BASE}release/v2`; x.isVersionOf = BASE; x.previousVersion = `${BASE}release/v1`; x.description = 'Market towns <and> "fairs".\n\nA second paragraph, long enough to pass.'; x.creator.push({ '@id': 'https://ror.org/02mhbdp94', name: 'Universidad de los Andes' }); });
  const r = await report(doc(g), { release: 'v2', conceptDoi: 'https://doi.org/10.5281/zenodo.123', name: 'towns.json' });
  assert.deepEqual(kinds(r), []);
  const f = (n) => r.files[`towns-deposit/${n}`];
  const z = JSON.parse(f('.zenodo.json'));
  assert.equal(z.upload_type, 'dataset');
  assert.equal(z.title, GOOD.title);
  assert.equal(z.description, '<p>Market towns &lt;and&gt; &quot;fairs&quot;.</p><p>A second paragraph, long enough to pass.</p>');
  assert.deepEqual(z.creators, [{ name: 'Carberry, Josiah', orcid: '0000-0002-1825-0097' }, { name: 'Universidad de los Andes' }]);
  assert.equal(z.license, 'cc-by-4.0');
  assert.deepEqual(z.keywords, GOOD.keywords);
  assert.equal(z.version, '1.0');
  assert.deepEqual(z.related_identifiers.map((x) => [x.relation, x.identifier]), [['isIdenticalTo', `${BASE}release/v2`], ['isDerivedFrom', BASE], ['isNewVersionOf', `${BASE}release/v1`]]);
  assert.match(z.notes, /Temporal coverage: 1200\/1500/);
  assert.match(z.notes, /wikidata\.org\/entity\/Q21/);
  assert.equal(z.dates, undefined, "Zenodo's date types do not fit coverage");

  const c = cff(f('CITATION.cff'));
  assert.equal(c['cff-version'], '1.2.0');
  assert.equal(c.type, 'dataset');
  assert.equal(c.title, GOOD.title);
  assert.equal(c.license, 'CC-BY-4.0');
  assert.equal(c.version, '1.0');
  assert.equal(c.url, BASE);
  assert.deepEqual(c.authors, [{ 'family-names': 'Carberry', 'given-names': 'Josiah', orcid: 'https://orcid.org/0000-0002-1825-0097' }, { name: 'Universidad de los Andes' }]);
  assert.deepEqual(c.identifiers[0], { type: 'doi', value: '10.5281/zenodo.123', description: 'The DOI of every version of the dataset (the concept DOI).' });
  assert.equal(c.identifiers[1].value, `${BASE}release/v2`);
  assert.deepEqual(c.keywords, GOOD.keywords);
  assert.equal(c.abstract, g.description);

  const d = JSON.parse(f('datacite.json')).data.attributes;
  assert.equal(d.doi, '10.5281/zenodo.123');
  assert.equal(d.types.resourceTypeGeneral, 'Dataset');
  assert.deepEqual(d.creators[0].nameIdentifiers, [{ nameIdentifier: 'https://orcid.org/0000-0002-1825-0097', nameIdentifierScheme: 'ORCID', schemeUri: 'https://orcid.org' }]);
  assert.equal(d.creators[1].nameType, 'Organizational');
  assert.deepEqual(d.publisher, { name: 'Josiah Carberry' });
  assert.equal(d.publicationYear, new Date().getFullYear());
  assert.deepEqual(d.rightsList[0], { rights: 'Creative Commons Attribution 4.0 International', rightsUri: GOOD.licence, rightsIdentifier: 'CC-BY-4.0', rightsIdentifierScheme: 'SPDX', schemeUri: 'https://spdx.org/licenses/' });
  assert.deepEqual(d.dates, [{ date: '1200/1500', dateType: 'Coverage' }]);
  assert.deepEqual(d.relatedIdentifiers.map((x) => [x.relationType, x.relatedIdentifier]), [['IsIdenticalTo', `${BASE}release/v2`], ['IsVersionOf', BASE], ['IsNewVersionOf', `${BASE}release/v1`]]);
  assert.deepEqual(d.subjects.map((s) => s.subject), ['markets', 'charters', 'http://www.wikidata.org/entity/Q21']);
  assert.equal(d.url, `${BASE}release/v2`);
  assert.match(f('README.txt'), /\.zenodo\.json +For Zenodo/);
  assert.doesNotMatch(f('README.txt'), /the DOI, once/, 'the DOI was given');
});

test('deposit files for an author given by ORCID only, and without a DOI, say what to fill in', async () => {
  const r = await report(doc(edit((g) => { delete g.creator[0].name; })));
  const f = (n) => r.files[`a-test-gazetteer-of-market-towns-deposit/${n}`];
  assert.deepEqual(JSON.parse(f('.zenodo.json')).creators, [{ name: '0000-0002-1825-0097', orcid: '0000-0002-1825-0097' }]);
  assert.match(f('CITATION.cff'), /family-names: "FILL IN: the name for https:\/\/orcid.org\/0000-0002-1825-0097"/);
  const d = JSON.parse(f('datacite.json')).data.attributes;
  assert.equal(d.doi, undefined);
  assert.deepEqual(d.publisher, { name: '' });
  assert.ok(item(r, 'no-publisher'));
  assert.match(f('README.txt'), /the names of 1 author given by ORCID only/);
  assert.match(f('README.txt'), /the DOI, once/);
  assert.equal(item(await report(doc(GOOD)), 'no-publisher'), undefined);
});

test('schemaOrgDataset: the landing page\'s Dataset', () => {
  const s = schemaOrgDataset(edit((g) => { g.creator.push({ '@id': 'https://ror.org/02mhbdp94', name: 'Uniandes' }); }), scheme(BASE), { release: 'v1', conceptDoi: '10.5281/zenodo.9', distribution: [{ '@type': 'DataDownload', contentUrl: `${BASE}download/x.json` }] });
  assert.equal(s['@type'], 'Dataset');
  assert.equal(s['@id'], `${BASE}release/v1`);
  assert.equal(s.url, BASE);
  assert.deepEqual(s.identifier, [`${BASE}release/v1`, 'https://doi.org/10.5281/zenodo.9']);
  assert.deepEqual(s.creator.map((c) => [c['@type'], c['@id']]), [['Person', 'https://orcid.org/0000-0002-1825-0097'], ['Organization', 'https://ror.org/02mhbdp94']]);
  assert.equal(s.license, GOOD.licence);
  assert.equal(s.temporalCoverage, '1200/1500');
  assert.deepEqual(s.spatialCoverage, [{ '@type': 'Place', sameAs: 'http://www.wikidata.org/entity/Q21' }]);
  assert.equal(s.isAccessibleForFree, true);
  assert.equal(s.isPartOf, BASE);
  assert.equal(s.distribution.length, 1);
  assert.equal(schemaOrgDataset(edit((g) => { g.temporal = { startDate: '1200' }; }), scheme(BASE)).temporalCoverage, '1200/..');
  assert.equal(slug('Ἑρμῆς: Café towns!'), 'cafe-towns');
});

// ---- the command line, and PLATO's examples ---------------------------------------------------

const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const dir = mkdtempSync(join(tmpdir(), 'plato-tools-fair-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('publish report on the command line writes the deposit folder, and exits 1 with problems', () => {
  const good = join(dir, 'good.json'), bad = join(dir, 'bad.json');
  writeFileSync(good, JSON.stringify(doc(GOOD)));
  writeFileSync(bad, JSON.stringify(doc(edit((g) => { g.uriSpace = g['@id'] = 'https://someone.github.io/t/'; g.status = 'published'; }), [place('https://someone.github.io/t/', 'a')])));
  const out = join(dir, 'out');
  const r = cli('publish', 'report', '--out', out, good);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /Nothing stops publication\. \d+ of \d+ FAIR checks pass\./);
  // A single file gives no name of its own to the command line: the folder is named after the title.
  const folder = join(out, 'a-test-gazetteer-of-market-towns-deposit');
  assert.deepEqual(readdirSync(folder).sort(), ['.zenodo.json', 'CITATION.cff', 'README.txt', 'datacite.json']);
  assert.equal(JSON.parse(readFileSync(join(folder, '.zenodo.json'), 'utf8')).title, GOOD.title);
  const b = cli('publish', 'report', '--out', join(dir, 'out-bad'), bad);
  assert.equal(b.code, 1, b.out + b.err);
  assert.match(b.out, /1 problem to fix before publishing/);
  assert.match(b.out, /someone\.github\.io\/t\/ \(github\.io\)/);
  const j = JSON.parse(cli('publish', 'report', '--json', '--overwrite', '--out', out, good).out);
  assert.equal(j.counts.fair.passed, j.counts.fair.of);
  assert.ok(existsSync(join(dir, 'out-bad', 'a-test-gazetteer-of-market-towns-deposit', 'datacite.json')), 'FAIR problems still get deposit files');
});

test("PLATO's examples are reported on without failing", async () => {
  const examples = [`${PLATO_REPO}/schemas/examples/place-centric-constantinople.json`];
  const tables = `${PLATO_REPO}/schemas/tables/examples`;
  const sets = readdirSync(tables).map((d) => readdirSync(join(tables, d)).filter((f) => f.endsWith('.csv')).map((f) => join(tables, d, f)));
  assert.ok(sets.length >= 5, 'the table examples were found');
  for (const paths of [...examples.map((p) => [p]), ...sets]) {
    const e = env();
    const input = await detect(paths.map((p) => file(p)));
    const r = await publish({ part: 'report', input, options: {} }, e);
    assert.ok(!r.incomplete, paths[0]);
    assert.ok(r.report.counts.places > 0, `${paths[0]}: read`);
    assert.ok(r.report.counts.fair.of >= 17, paths[0]);
    // PLATO's examples are drafts on a stand-in base, which the report must notice.
    if (paths.length > 1) assert.equal(r.report.items.find((i) => i.kind === 'base-temporary')?.severity, 'warning', paths[0]);
  }
});
