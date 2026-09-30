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
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
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
  ['a creator by name only', (g) => { g.creator = [{ name: 'Josiah Carberry' }]; }, 'creator-kind-unknown', 'warning'],
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
    // An error of the report's own stops the deposit files, as the dataset's problems do; the draft,
    // with only the warning, is the control.
    assert.equal(published.outputs.length, 0, 'a FAIR error stops the deposit files');
    assert.equal(draft.outputs.length, 1, 'a FAIR warning does not');
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

test('sources-outside-base is for sources not under the base at all; those under it go to the findings that say why', async () => {
  const other = 'https://other.org/';
  const d = doc(GOOD, [place(BASE, 'a')]);
  d.spatialEntities[0].attestations[0].sources.push({ '@id': `${other}source/x`, title: 'Elsewhere' },
    { '@id': `${BASE}source/gazetteer/geonames`, title: 'GeoNames' }, { '@id': `${BASE}volume/12`, title: 'Volume 12' });
  const r = await report(d);
  const s = item(r, 'sources-outside-base');
  assert.equal(s?.count, 1, kinds(r));
  assert.deepEqual(s.examples, [`${other}source/x`]);
  assert.match(s.message, /not under the dataset's base address/);
  assert.doesNotMatch(s.message, new RegExp(`under ${'<base>'}source/`));
  assert.deepEqual(item(r, 'sources-not-served')?.examples, [`${BASE}volume/12`]);
  assert.deepEqual(item(r, 'keys-not-servable')?.examples, [`${BASE}source/gazetteer/geonames: its last part has more than one part`]);
  // Control: the good description has none of them, and its sources were read (it has a source page's worth).
  const good = await report(doc(GOOD));
  for (const k of ['sources-outside-base', 'sources-not-served', 'keys-not-servable']) assert.equal(item(good, k), undefined, k);
  assert.equal(good.counts.places, 2);
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

test("the report's own errors stop the deposit files: a mistyped ORCID never reaches them; a warning does not stop them", async () => {
  const NOT_WRITTEN = 'Deposit files were not written: fix the problems above first.';
  const bad = await report(doc(edit((g) => { g.creator[0]['@id'] = 'https://orcid.org/0000-0002-1825-0098'; })));
  assert.ok(item(bad, 'orcid-checksum')?.severity === 'error', kinds(bad));
  assert.equal(bad.errors, 1, 'the dataset itself has no problems: only the report found one');
  assert.deepEqual(bad.files, {});
  assert.equal(bad.outputs.length, 0);
  assert.ok(bad.counts.said.includes(NOT_WRITTEN), bad.counts.said.join(' '));
  // The controls: the good description, and one with only a warning, get their files, and are not told so.
  for (const g of [GOOD, edit((x) => delete x.keywords)]) {
    const ok = await report(doc(g));
    assert.equal(ok.errors, 0);
    assert.equal(ok.outputs.length, 1);
    assert.ok(Object.keys(ok.files).some((f) => f.endsWith('/datacite.json')));
    assert.ok(!ok.counts.said.includes(NOT_WRITTEN));
  }
});

test('a concept DOI that is not a DOI is refused, and no deposit file carries it', async () => {
  for (const conceptDoi of ['zenodo 123', 'https://doi.org/11.5281/zenodo.1', '10.12/x', '10.5281/']) {
    const r = await report(doc(GOOD), { conceptDoi });
    const i = item(r, 'bad-doi');
    assert.ok(i && i.severity === 'error', `${conceptDoi}: ${kinds(r)}`);
    assert.equal(i.examples[0], conceptDoi);
    assert.deepEqual(r.files, {}, conceptDoi);
    assert.equal(r.outputs.length, 0);
  }
  // The control: a DOI in each form it is given in is taken, and written bare.
  for (const conceptDoi of ['10.5281/zenodo.123', 'doi:10.5281/zenodo.123', 'https://doi.org/10.5281/zenodo.123']) {
    const r = await report(doc(GOOD), { conceptDoi });
    assert.equal(item(r, 'bad-doi'), undefined, conceptDoi);
    assert.equal(r.outputs.length, 1, conceptDoi);
    assert.equal(JSON.parse(r.files['a-test-gazetteer-of-market-towns-deposit/datacite.json']).data.attributes.doi, '10.5281/zenodo.123');
  }
});

// ---- the deposit files ---------------------------------------------------------------------------

/** The top-level keys of a CITATION.cff and their scalar values; list items under their key. No YAML library: the file is written simply enough to read by line. */
test('places under the base but not under <base>place/ are a warning: minted, but not served; deeper under it, a key not servable', async () => {
  const deep = { '@id': `${BASE}places/p-1`, label: 'deep', attestations: [{ names: [{ toponym: 'Deep' }] }] };
  const nested = { '@id': `${BASE}place/a/b`, label: 'nested', attestations: [{ names: [{ toponym: 'Nested' }] }] };
  const other = place('https://example.org/elsewhere/', 'x', BASE);
  for (const status of ['draft', 'published']) {
    const r = await report(doc(edit((g) => { g.status = status; }), [place(BASE, 'a'), deep, nested, other]));
    const i = item(r, 'places-not-served');
    assert.equal(i?.severity, 'warning', status);
    assert.equal(i.count, 1);
    assert.deepEqual(i.examples, [deep['@id']]);
    assert.match(i.message, /given addresses \(publish mint\), but the site has no page/);
    // Under <base>place/ but more than one part deep: a key the site cannot serve, as the site and
    // the w3id rules judge it (servability in address.js).
    assert.deepEqual(item(r, 'keys-not-servable').examples, [`${nested['@id']}: its last part has more than one part`]);
    // Outside the base altogether is the other finding, and only that place.
    assert.deepEqual(item(r, 'places-outside-base').examples, [other['@id']]);
    assert.equal(r.counts.fairChecks.find((c) => c.check === 'every place and source address served by the site').passed, false);
  }
  const good = await report(doc(GOOD));
  assert.equal(item(good, 'places-not-served'), undefined);
  assert.equal(good.counts.fairChecks.find((c) => c.check === 'every place and source address served by the site').passed, true);
});

test('addresses the site cannot serve are an error in a draft, and a warning once published (their addresses are frozen)', async () => {
  const odd = (status) => doc(edit((g) => { g.status = status; }), [place(BASE, 'a'), place(BASE, 'St%20Ives'), place(BASE, 'A'), place(BASE, 'b', BASE)]);
  // A source cited by its address alone is served too, so its key counts. (Each place's own source,
  // source/s-<id>, is as odd as the place: s-St%20Ives, and s-a beside s-A.)
  const withSource = (status) => { const d = odd(status); d.spatialEntities[0].attestations[0].sources.push(`${BASE}source/.hidden`); return d; };
  const draft = await report(withSource('draft')), published = await report(withSource('published'));
  const d = item(draft, 'keys-not-servable');
  assert.equal(d?.severity, 'error');
  assert.equal(d.count, 5);
  assert.match(d.examples.join('\n'), /place\/St%20Ives: its last part has characters other than/);
  assert.match(d.examples.join('\n'), /place\/a and https:\/\/w3id\.org\/fair-test\/place\/A: they differ only in capital letters/);
  assert.match(d.examples.join('\n'), /source\/\.hidden: its last part starts with '\.'/);
  assert.equal(item(published, 'keys-not-servable')?.severity, 'warning');
  assert.equal(item(published, 'keys-not-servable').count, 5);
  const good = await report(doc(GOOD));
  assert.equal(item(good, 'keys-not-servable'), undefined);
  assert.equal(good.counts.places, 2);
});

test('.zenodo.json names no base, and no relation at all, for a dataset that is not a release', async () => {
  const r = await report(doc(GOOD), { name: 'towns.json' });
  const z = JSON.parse(r.files['towns-deposit/.zenodo.json']);
  const d = JSON.parse(r.files['towns-deposit/datacite.json']).data.attributes;
  assert.equal(z.title, GOOD.title);
  assert.equal(z.related_identifiers, undefined);
  assert.equal(d.relatedIdentifiers, undefined);
  assert.doesNotMatch(r.files['towns-deposit/.zenodo.json'], /isDerivedFrom/);
});

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
  // 'Josiah Carberry' has no comma, so it is kept whole (the next test splits names written with one).
  assert.deepEqual(z.creators, [{ name: 'Josiah Carberry', orcid: '0000-0002-1825-0097' }, { name: 'Universidad de los Andes' }]);
  assert.equal(z.license, 'cc-by-4.0');
  assert.deepEqual(z.keywords, GOOD.keywords);
  assert.equal(z.version, '1.0');
  // The same release, and the one before it, as datacite.json names them; the base only there, as what a release IsVersionOf.
  assert.deepEqual(z.related_identifiers.map((x) => [x.relation, x.identifier]), [['isIdenticalTo', `${BASE}release/v2`], ['isNewVersionOf', `${BASE}release/v1`]]);
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
  assert.deepEqual(c.authors, [{ 'family-names': 'Josiah Carberry', orcid: 'https://orcid.org/0000-0002-1825-0097' }, { name: 'Universidad de los Andes' }]);
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

// Round 4, B3: a name is split only at a comma; any other is kept whole in every file.
const WHOLE = ['Ludwig van Beethoven', 'Mao Zedong', 'Plato'];
// Valid ORCIDs (their check digits hold), one for each person below.
const ORCIDS = ['https://orcid.org/0000-0002-1825-0097', 'https://orcid.org/0000-0003-3060-0181', 'https://orcid.org/0000-0001-5109-3700', 'https://orcid.org/0000-0002-1694-233X'];
const INSTITUTE = 'University of Nottingham, Institute for Name-Studies';
const ROR_ORG = { '@id': 'https://ror.org/02mhbdp94', name: 'Universidad de los Andes' };
/** The authors of every kind: a person with an ORCID, written with a comma and without; one of unknown kind with a comma (an institute, and a person without an ORCID); an organisation by ROR. */
const MIXED = () => [
  { '@id': ORCIDS[0], name: 'Gadd, Stephen' },
  ...WHOLE.map((name, i) => ({ '@id': ORCIDS[i + 1], name })),
  { name: INSTITUTE }, { name: 'Gadd, Stephen' }, ROR_ORG,
];

test("authors' names are split only for a person (an ORCID), only at a comma; an author of unknown kind is kept whole and warned of", async () => {
  const r = await report(doc(edit((g) => { g.creator = MIXED(); })));
  const f = (n) => r.files[`a-test-gazetteer-of-market-towns-deposit/${n}`];
  assert.equal(r.counts.places, 2, 'the records were read');
  assert.equal(r.errors, 0, JSON.stringify(r.items));
  // The warning names both authors of unknown kind, and neither the people nor the organisation.
  const w = item(r, 'creator-kind-unknown');
  assert.equal(w?.severity, 'warning', kinds(r));
  assert.equal(w.message, TEXT['creator-kind-unknown']);
  assert.deepEqual([...new Set(w.examples)].sort(), ['Gadd, Stephen', INSTITUTE]);
  assert.equal(item(await report(doc(GOOD)), 'creator-kind-unknown'), undefined, 'control: an author with an ORCID raises none');
  // Zenodo: 'Family, Given' for the person split, the name as given for everyone else.
  assert.deepEqual(JSON.parse(f('.zenodo.json')).creators.map((c) => c.name), ['Gadd, Stephen', ...WHOLE, INSTITUTE, 'Gadd, Stephen', ROR_ORG.name]);
  // CITATION.cff: family-names and given-names for the person split; the whole name in family-names
  // for the other people and the unknown (its person has no single-name field); an entity for the ROR.
  assert.deepEqual(cff(f('CITATION.cff')).authors, [
    { 'family-names': 'Gadd', 'given-names': 'Stephen', orcid: ORCIDS[0] },
    ...WHOLE.map((n, i) => ({ 'family-names': n, orcid: ORCIDS[i + 1] })),
    { 'family-names': INSTITUTE }, { 'family-names': 'Gadd, Stephen' },
    { name: ROR_ORG.name },
  ]);
  // DataCite: Personal and split for the person with a comma; Personal and whole for the others with
  // an ORCID; a name alone, no nameType and no parts, for the unknown; Organizational for the ROR.
  const d = JSON.parse(f('datacite.json')).data.attributes.creators;
  const strip = ({ nameIdentifiers, ...o }) => o;
  assert.deepEqual(strip(d[0]), { name: 'Gadd, Stephen', nameType: 'Personal', familyName: 'Gadd', givenName: 'Stephen' });
  for (const [i, n] of WHOLE.entries()) assert.deepEqual(strip(d[i + 1]), { name: n, nameType: 'Personal' }, n);
  assert.deepEqual(d[4], { name: INSTITUTE });
  assert.deepEqual(d[5], { name: 'Gadd, Stephen' });
  assert.deepEqual(strip(d[6]), { name: ROR_ORG.name, nameType: 'Organizational' });
  // Nothing split at a space anywhere, nor the institute at its comma.
  for (const file of ['.zenodo.json', 'CITATION.cff', 'datacite.json']) {
    assert.match(f(file), /Gadd/, file);
    assert.match(f(file), /Institute for Name-Studies/, file);
    assert.doesNotMatch(f(file), /"(Beethoven|Zedong|Beethoven, Ludwig van|Zedong, Mao|Institute for Name-Studies)"/, file);
  }
  // The README says how to have names split, and that an ORCID is needed for it.
  assert.match(f('README.txt'), /"Family, Given"/);
  assert.match(f('README.txt'), /give each person an ORCID/);
  assert.match(f('CITATION.cff'), /only for a person \(with an ORCID\)/);
});

// One finding per author (C2): an author with no address is of unknown kind, and that one finding
// says both what the tools cannot tell and what makes the author findable; an author with some
// other address is reported as that (creator-id-unrecognised), which also says the kind is unknown.
// Either way the FAIR check 'authors identified' still fails.
test('an author without an ORCID or ROR is reported once: by name only as of unknown kind, by another address as unrecognised', async () => {
  const good = await report(doc(GOOD));
  const named = await report(doc(edit((g) => { g.creator = [{ name: 'Josiah Carberry' }]; })));
  const other = await report(doc(edit((g) => { g.creator = [{ '@id': 'https://example.org/people/jc', name: 'J C' }]; })));
  const creatorKinds = (r) => r.items.filter((i) => i.kind.startsWith('creator-')).map((i) => i.kind);
  assert.deepEqual(creatorKinds(named), ['creator-kind-unknown'], kinds(named));
  assert.deepEqual(item(named, 'creator-kind-unknown').examples, ['Josiah Carberry']);
  assert.deepEqual(creatorKinds(other), ['creator-id-unrecognised'], kinds(other));
  assert.deepEqual(item(other, 'creator-id-unrecognised').examples, ['https://example.org/people/jc']);
  assert.deepEqual(creatorKinds(good), [], 'control: an author with an ORCID raises none');
  // The one finding says both things: the kind cannot be told, and an ORCID or ROR makes the author findable.
  assert.match(TEXT['creator-kind-unknown'], /cannot tell whether this is a person or an organisation/);
  assert.match(TEXT['creator-kind-unknown'], /ORCID for a person or a ROR for an organisation/);
  assert.match(TEXT['creator-kind-unknown'], /FAIR/);
  assert.match(TEXT['creator-id-unrecognised'], /unknown kind/);
  assert.equal(TEXT['creator-without-orcid'], undefined, 'the second warning is gone');
  // The FAIR accounting: authors identified fails for both, passes for the good description.
  for (const r of [named, other]) assert.equal(r.counts.fair.passed, good.counts.fair.passed - 1);
  assert.equal(good.counts.fair.passed, good.counts.fair.of);
});

// CITATION.cff against its own JSON schema (1.2.0), which is not kept in this repository (63 KB):
// fetch https://raw.githubusercontent.com/citation-file-format/citation-file-format/main/schema.json
// and give its path in CFF_SCHEMA to run this. The file is parsed with cff() above, which fails on
// any line it does not expect, so what is validated is what is written.
test('CITATION.cff is valid against the CITATION.cff 1.2.0 schema, whole names and split (CFF_SCHEMA)', async (t) => {
  if (!process.env.CFF_SCHEMA) { t.skip('CFF_SCHEMA not set'); return; }
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(process.env.CFF_SCHEMA, 'utf8')));
  const g = edit((x) => { x.creator = MIXED(); });
  const r = await report(doc(g), { release: 'v2', conceptDoi: '10.5281/zenodo.123', name: 'towns.json' });
  const c = cff(r.files['towns-deposit/CITATION.cff']);
  assert.equal(c.authors.length, 7, 'the authors were read');
  assert.ok(validate(c), JSON.stringify(validate.errors));
  // Control: the same file with a person's field the schema does not have is refused.
  const bad = structuredClone(c); bad.authors[1].name = 'Ludwig van Beethoven';
  assert.equal(validate(bad), false);
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

test('schemaOrgDataset types an author only by address: ORCID a Person, ROR an Organization, neither untyped', () => {
  const s = schemaOrgDataset(edit((g) => { g.creator = MIXED(); g.creator.push({ '@id': 'https://example.org/people/jc', name: 'J C' }); }), scheme(BASE));
  const by = (n) => s.creator.filter((c) => c.name === n);
  assert.equal(s.creator.length, 8, 'every author is there');
  assert.deepEqual(by(INSTITUTE), [{ name: INSTITUTE }], 'the institute: a name, no guessed type');
  assert.deepEqual(by('J C'), [{ '@id': 'https://example.org/people/jc', name: 'J C', identifier: 'https://example.org/people/jc' }]);
  // 'Gadd, Stephen' twice: the one with an ORCID a Person, the one without untyped.
  assert.deepEqual(by('Gadd, Stephen').map((c) => c['@type'] ?? null), ['Person', null]);
  assert.deepEqual(s.creator.filter((c) => c['@type'] === 'Person').map((c) => c['@id']), ORCIDS, 'control: the people are typed');
  assert.deepEqual(s.creator.filter((c) => c['@type'] === 'Organization'), [{ '@type': 'Organization', '@id': ROR_ORG['@id'], name: ROR_ORG.name, identifier: ROR_ORG['@id'] }]);
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
  // A FAIR error (here a temporary base for a published dataset) stops the deposit files, which
  // would carry it to the repository; the good run's folder above is the control.
  assert.ok(!existsSync(join(dir, 'out-bad', 'a-test-gazetteer-of-market-towns-deposit')), 'FAIR errors get no deposit files');
  assert.match(b.out, /Deposit files were not written: fix the problems above first\./);
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

test('a malformed ORCID does not make its author a person on the landing page', () => {
  const g = { title: 't', creator: [{ '@id': 'https://orcid.org/0000-0002-1825-0098', name: 'Bad, Digit' }, { '@id': 'https://orcid.org/0000-0002-1825-0097', name: 'Carberry, Josiah' }] };
  const s = schemaOrgDataset(g, scheme(BASE), {});
  const [bad, good] = s.creator;
  assert.equal(bad['@type'], undefined, JSON.stringify(bad));     // its check digit is wrong: nothing sure about who it is
  assert.equal(good['@type'], 'Person', JSON.stringify(good));    // control: a well-formed ORCID is a person
});
