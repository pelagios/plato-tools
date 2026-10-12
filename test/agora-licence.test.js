import { PLATO_REPO } from './paths.js';
// Licences that travel with a contribution (Issue #24): the table of licences and their terms
// (src/engine/agora/licence.js), and the report's warnings when an attestation's licence may not sit
// under the dataset's (fair.js). The adoptions are made by Chora's own engine (adopt.js), from WHG's
// answers as fixtures (no request leaves the test), so that what Agora reads is what Chora writes.
//
// Every warning is shown firing beside an attestation in the same dataset that must not fire it, and
// the attestations with a licence are counted, so that a report that read nothing would fail.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env as baseEnv, textFile } from './engine.js';
import { detect } from '../src/engine/input.js';
import { publish, TEXT as SHARED } from '../src/engine/agora/index.js';
import { licenceTerms, licenceReasons, attestationLicences, KNOWN_LICENCES } from '../src/engine/agora/licence.js';
import { TEXT } from '../src/engine/agora/fair.js';
import { createLookup, WHG_ENDPOINT, whgLicence } from '../src/engine/gazetteer/index.js';
import * as adopt from '../src/engine/chora/adopt.js';

void PLATO_REPO;
const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'agora-licence-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// ---- the table -----------------------------------------------------------------------------------

test('licences are read from their addresses, however written, and from bare SPDX ids; others are unknown', () => {
  const id = (v) => licenceTerms(v)?.id ?? null;
  // What Chora writes, and its forms.
  assert.equal(id('https://spdx.org/licenses/CC-BY-NC-4.0'), 'CC-BY-NC-4.0');
  assert.equal(id('https://spdx.org/licenses/CC-BY-NC-4.0.html'), 'CC-BY-NC-4.0');
  assert.equal(id('http://spdx.org/licenses/odbl-1.0.json'), 'ODbL-1.0');
  // Creative Commons, with deed, legalcode, www and a port to one country.
  assert.equal(id('https://creativecommons.org/licenses/by/4.0/'), 'CC-BY-4.0');
  assert.equal(id('http://www.creativecommons.org/licenses/by-sa/4.0/deed.fr'), 'CC-BY-SA-4.0');
  assert.equal(id('https://creativecommons.org/licenses/by-nc-nd/3.0/legalcode'), 'CC-BY-NC-ND-3.0');
  assert.equal(id('https://creativecommons.org/licenses/by/3.0/de/'), 'CC-BY-3.0');
  assert.equal(id('https://creativecommons.org/publicdomain/zero/1.0/'), 'CC0-1.0');
  assert.equal(id('https://creativecommons.org/publicdomain/mark/1.0/'), 'CC-PDM-1.0');
  // Open Data Commons, either way of writing the version.
  assert.equal(id('https://opendatacommons.org/licenses/odbl/1-0/'), 'ODbL-1.0');
  assert.equal(id('https://opendatacommons.org/licenses/by/1.0/'), 'ODC-By-1.0');
  assert.equal(id('https://opendatacommons.org/licenses/pddl/1-0/'), 'PDDL-1.0');
  // A bare SPDX id, in any case.
  assert.equal(id('cc-by-sa-4.0'), 'CC-BY-SA-4.0');
  // Unknown: a bespoke licence, a version or licence not in the table, nothing at all.
  for (const v of ['https://example.org/our-licence', 'https://creativecommons.org/licenses/by/1.0/', 'https://spdx.org/licenses/GPL-3.0-only', 'MIT', '', null, 42])
    assert.equal(licenceTerms(v), null, String(v));
  // Every licence in the table is read back from its SPDX address.
  assert.ok(KNOWN_LICENCES.length >= 30, KNOWN_LICENCES.join());
  for (const k of KNOWN_LICENCES) assert.equal(id(`https://spdx.org/licenses/${k}`), k);
});

test('the terms of each kind of licence', () => {
  const t = (v) => { const x = licenceTerms(v); return { by: x.by, nc: x.nc, nd: x.nd, sa: x.sa, pd: x.pd }; };
  assert.deepEqual(t('CC-BY-4.0'), { by: true, nc: false, nd: false, sa: null, pd: false });
  assert.deepEqual(t('CC-BY-NC-SA-4.0'), { by: true, nc: true, nd: false, sa: 'CC-BY-NC-SA', pd: false });
  assert.deepEqual(t('CC-BY-ND-4.0'), { by: true, nc: false, nd: true, sa: null, pd: false });
  assert.deepEqual(t('ODbL-1.0'), { by: true, nc: false, nd: false, sa: 'ODbL', pd: false });
  assert.deepEqual(t('CC0-1.0'), { by: false, nc: false, nd: false, sa: null, pd: true });
  assert.deepEqual(t('OGL-UK-3.0'), { by: true, nc: false, nd: false, sa: null, pd: false });
});

test('compatibility: what may not sit under the dataset\'s licence, and why; what may, says nothing', () => {
  const why = (contained, dataset) => licenceReasons(licenceTerms(contained), licenceTerms(dataset));
  const CASES = [
    // [contained, dataset, reasons]
    ['CC-BY-NC-4.0', 'CC-BY-4.0', ['nc']],              // NC inside a dataset that allows commercial use
    ['CC-BY-NC-4.0', 'CC-BY-NC-4.0', []],               // the same licence: never a reason
    ['CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', []],            // the dataset is NC too
    ['CC-BY-NC-ND-4.0', 'CC-BY-4.0', ['nc', 'nd']],
    ['CC-BY-ND-4.0', 'CC-BY-4.0', ['nd']],              // no adaptations
    ['CC-BY-ND-4.0', 'CC-BY-ND-3.0', ['nd']],           // a different ND licence is still no licence to adapt
    ['CC-BY-SA-4.0', 'CC-BY-4.0', ['sa']],              // share-alike inside a permissive dataset
    ['ODbL-1.0', 'CC-BY-4.0', ['sa']],
    ['ODbL-1.0', 'CC-BY-SA-4.0', ['sa']],               // two share-alike licences are not each other
    ['CC-BY-SA-3.0', 'CC-BY-SA-4.0', []],               // a later version of the same will do
    ['CC-BY-SA-4.0', 'CC-BY-SA-3.0', ['sa']],           // an earlier one will not
    ['CC-BY-SA-4.0', 'CC-BY-NC-SA-4.0', ['sa']],        // NC-SA is another licence
    ['CC-BY-4.0', 'CC0-1.0', ['attribution']],          // credit asked, inside the public domain
    ['ODC-By-1.0', 'PDDL-1.0', ['attribution']],
    ['CC0-1.0', 'CC-BY-4.0', []],                       // the public domain may go anywhere
    ['CC-BY-4.0', 'ODbL-1.0', []],                      // a stricter dataset asks more than the source
    ['CC-BY-4.0', 'CC-BY-NC-4.0', []],
    ['ODC-By-1.0', 'CC-BY-4.0', []],
    ['OGL-UK-3.0', 'CC-BY-4.0', []],
    ['CC-BY-3.0', 'CC-BY-4.0', []],
  ];
  for (const [c, d, want] of CASES) assert.deepEqual(why(c, d), want, `${c} in ${d}`);
  // Nothing is said without both licences known.
  assert.deepEqual(licenceReasons(null, licenceTerms('CC-BY-4.0')), []);
  assert.deepEqual(licenceReasons(licenceTerms('CC-BY-NC-4.0'), null), []);
});

// ---- adoptions, as Chora makes them -------------------------------------------------------------

const F = 'test/fixtures/chora/adopt/';
const json = (name) => JSON.parse(readFileSync(F + name, 'utf8'));
const BASE = 'https://w3id.org/licence-test/';
const who = { name: 'Ada Surveyor', orcid: '0000-0002-1825-0097' };

/** WHG's answer to "Newcastle" from its fixture, through the shared lookup with a stand-in fetch. */
async function newcastles() {
  const fetch = async () => new Response(JSON.stringify(json('whg-newcastle-reconcile.json')), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const look = createLookup({ endpoint: WHG_ENDPOINT, token: 'tok-fixture', fetch, shared: false, locks: null, queryRate: null, entityRate: null, maxRetries: 0, sleep: async () => {} });
  const lists = await look.reconcile([{ query: 'Newcastle' }]);
  return { byId: Object.fromEntries(lists[0].map((c) => [c.id, c])), attribution: lists.attribution };
}
/** The attestations Chora records for adopting `candidate`'s point as `slug`'s location. */
function adopted(slug, candidate, attribution) {
  const r = adopt.adoptionAttestations({ place: { '@id': `${BASE}place/${slug}`, label: slug }, candidate, feature: json('lpf-point.json'), geometryIndex: 0,
    basis: 'The same town', attribution, contributor: who, created: '2026-10-01T10:00:00Z', fetched: '2026-10-01T09:58:00Z' });
  assert.equal(r.refused, undefined, JSON.stringify(r.refused));
  return r.attestations.map((a, i) => ({ '@id': `${BASE}place/${slug}#a-${i + 1}`, ...a }));
}
/** A geometry cited as evidence from a dataset under `licence`, as Chora's adoption writes one. */
const copied = (slug, licence, title) => ({
  '@id': `${BASE}place/${slug}#a-1`, geometries: [{ geojson: { type: 'Point', coordinates: [-1.6, 54.9] }, reprPoint: [-1.6, 54.9] }],
  contributor: { name: who.name }, created: '2026-10-01T10:00:00Z',
  citations: [{ source: { title, authorityType: 'dataset', '@id': 'https://example.org/', licence }, locator: 'https://example.org/r/1', citationFunction: 'http://purl.org/spar/cito/citesAsEvidence' }],
});
const placeOf = (slug, attestations) => ({ '@id': `${BASE}place/${slug}`, label: slug, attestations });
const gazetteer = (licence) => ({
  '@id': BASE, title: 'Towns of the north-east, for testing licences', description: 'Towns of the north-east and their locations, some adopted from a gazetteer, to test the report on licences.',
  creator: [{ '@id': 'https://orcid.org/0000-0002-1825-0097', name: 'Josiah Carberry' }], ...(licence === undefined ? {} : { licence }), version: '1', status: 'draft',
  keywords: ['towns'], spatial: ['http://www.wikidata.org/entity/Q21'], temporal: { startDate: '1080', endDate: '2026' }, uriSpace: BASE,
});

/** The dataset: one adoption each from GeoNames (CC BY 4.0), TGN (CC BY-NC 4.0, the fixture's) and TGN with no licence given; one ND and one ODbL copy; and attestations that carry no licence of their own. */
async function dataset(licence) {
  const { byId, attribution } = await newcastles();
  const noLicence = structuredClone(attribution);
  delete noLicence.sources.tgn;
  return {
    profile: 'place-centric', gazetteer: gazetteer(licence),
    spatialEntities: [
      placeOf('newcastle', adopted('newcastle', byId['place:gn:2641673'], attribution)),
      placeOf('tynemouth', adopted('tynemouth', byId['place:tgn:7011781'], attribution)),
      placeOf('jarrow', adopted('jarrow', byId['place:tgn:7011781'], noLicence)),
      placeOf('hexham', [copied('hexham', 'https://spdx.org/licenses/CC-BY-ND-4.0', 'A survey that allows no adaptations (illustrative)')]),
      placeOf('alnwick', [copied('alnwick', 'https://opendatacommons.org/licenses/odbl/1-0/', 'OpenStreetMap')]),
      // No licence of its own: a book cited, and a record consulted for information only (nothing copied).
      placeOf('morpeth', [
        { '@id': `${BASE}place/morpeth#a-1`, names: [{ toponym: 'Morpeth' }], sources: [{ title: 'A charter', authorityType: 'source' }] },
        { '@id': `${BASE}place/morpeth#a-2`, names: [{ toponym: 'Morpath' }], citations: [{ source: { title: 'A closed survey', authorityType: 'dataset', licence: 'https://spdx.org/licenses/CC-BY-NC-ND-4.0' }, citationFunction: 'http://purl.org/spar/cito/citesForInformation' }] },
      ]),
    ],
  };
}

async function report(d) {
  const e = baseEnv();
  e.files = {};
  e.folder = async (name) => ({ path: name, file: async () => ({ write() {}, writeBytes() {}, close: async () => ({}) }) });
  const r = await publish({ part: 'report', input: await detect([textFile(JSON.stringify(d), 'licences.json')]), options: {} }, e);
  return r.report;
}
const item = (r, kind) => r.items.find((i) => i.kind === kind);
const licenceKinds = (r) => r.items.filter((i) => /^licence-(nc|nd|sa|attribution|unknown)$|^licences-not-compared$/.test(i.kind)).map((i) => `${i.severity}:${i.kind}`).sort();

test("Chora's adoption writes the upstream licence where Agora reads it, and none when WHG gives none", async () => {
  const d = await dataset('https://creativecommons.org/licenses/by/4.0/');
  const geometryOf = (slug) => d.spatialEntities.find((p) => p['@id'].endsWith(slug)).attestations.find((a) => a.geometries);
  assert.equal(geometryOf('newcastle').citations[0].source.licence, 'https://spdx.org/licenses/CC-BY-4.0');
  assert.equal(geometryOf('tynemouth').citations[0].source.licence, 'https://spdx.org/licenses/CC-BY-NC-4.0');
  assert.equal(geometryOf('jarrow').citations[0].source.licence, undefined);
  // Each read as such: licensed, and flagged or not.
  const cc = licenceTerms('CC-BY-4.0');
  assert.deepEqual([...attestationLicences(geometryOf('newcastle'), cc).reasons.keys()], []);
  assert.deepEqual([...attestationLicences(geometryOf('tynemouth'), cc).reasons.keys()], ['nc']);
  assert.deepEqual([...attestationLicences(geometryOf('jarrow'), cc).reasons.keys()], ['unknown']);
  assert.ok(attestationLicences(geometryOf('newcastle'), cc).licensed);
});

test('a CC BY dataset: the NC, ND, share-alike and unknown licences are flagged, each with its attestation; the CC BY adoption is not', async () => {
  const r = await report(await dataset('https://creativecommons.org/licenses/by/4.0/'));
  assert.equal(r.counts.places, 6, 'every place was read');
  // newcastle's geometry, tynemouth's, jarrow's, hexham's and alnwick's; not morpeth's two.
  assert.deepEqual(r.counts.licences, { licensed: 5, flagged: 4 });
  assert.deepEqual(licenceKinds(r), ['warning:licence-nc', 'warning:licence-nd', 'warning:licence-sa', 'warning:licence-unknown']);
  assert.deepEqual(item(r, 'licence-nc').examples, [`${BASE}place/tynemouth#a-2: CC-BY-NC-4.0, World Historical Gazetteer`]);
  assert.equal(item(r, 'licence-nc').count, 1);
  assert.deepEqual(item(r, 'licence-nd').examples, [`${BASE}place/hexham#a-1: CC-BY-ND-4.0, A survey that allows no adaptations (illustrative)`]);
  assert.deepEqual(item(r, 'licence-sa').examples, [`${BASE}place/alnwick#a-1: ODbL-1.0, OpenStreetMap`]);
  assert.deepEqual(item(r, 'licence-unknown').examples, [`${BASE}place/jarrow#a-2: none given, World Historical Gazetteer`]);
  // The CC BY adoption is in no example, and nothing of morpeth's.
  assert.ok(!r.items.some((i) => i.examples.some((e) => /newcastle|morpeth/.test(String(e)))), JSON.stringify(r.items.map((i) => i.examples)));
  // What to do, and what it is not, in plain words.
  assert.match(item(r, 'licence-nc').message, /publish the dataset under a licence compatible with the source's, remove those attestations/);
  assert.match(item(r, 'licence-nc').message, /not legal advice/);
  assert.ok(r.counts.said.includes("5 attestations cite a source with a licence of its own; 4 of them may not agree with the dataset's licence (see the warnings)."), r.counts.said.join(' | '));
  // Warnings only: the deposit files are still written.
  assert.equal(r.errors, 0);
});

test('the same attestations under other dataset licences: NC, public domain, and one these tools do not know', async () => {
  // A CC BY-NC-SA dataset: the NC adoption may sit in it; the others still may not.
  const nc = await report(await dataset('https://creativecommons.org/licenses/by-nc-sa/4.0/'));
  assert.deepEqual(licenceKinds(nc), ['warning:licence-nd', 'warning:licence-sa', 'warning:licence-unknown']);
  // CC0: everything that asks for credit is flagged too, the CC BY adoption among them.
  const pd = await report(await dataset('https://creativecommons.org/publicdomain/zero/1.0/'));
  assert.deepEqual(licenceKinds(pd), ['warning:licence-attribution', 'warning:licence-nc', 'warning:licence-nd', 'warning:licence-sa', 'warning:licence-unknown']);
  assert.ok(item(pd, 'licence-attribution').examples.includes(`${BASE}place/newcastle#a-2: CC-BY-4.0, World Historical Gazetteer`));
  assert.equal(item(pd, 'licence-attribution').count, 4, 'GeoNames, TGN, the ND survey and OpenStreetMap all ask for credit');
  // A licence not known here: nothing compared, and said so once, with the count and the licence.
  const odd = await report(await dataset('https://example.org/our-own-licence'));
  assert.deepEqual(licenceKinds(odd), ['warning:licences-not-compared']);
  assert.equal(item(odd, 'licences-not-compared').count, 5);
  assert.deepEqual(item(odd, 'licences-not-compared').examples, ['https://example.org/our-own-licence']);
  assert.deepEqual(odd.counts.licences, { licensed: 5, flagged: 0 });
});

test('a dataset with no licence of its own anywhere says nothing of licences', async () => {
  const d = await dataset('https://creativecommons.org/licenses/by/4.0/');
  d.spatialEntities = d.spatialEntities.filter((p) => p['@id'].endsWith('morpeth'));
  const r = await report(d);
  assert.equal(r.counts.places, 1, 'read');
  assert.deepEqual(r.counts.licences, { licensed: 0, flagged: 0 });
  assert.deepEqual(licenceKinds(r), []);
  assert.ok(!r.counts.said.some((s) => /licence of their own|a licence of its own/.test(s)));
});

test('the report says a draft is public once uploaded, and does not say it of a published dataset', async () => {
  const d = await dataset('https://creativecommons.org/licenses/by/4.0/');
  const draft = await report(d);
  d.gazetteer.status = 'published';
  const pub = await report(d);
  assert.ok(draft.counts.said.includes(SHARED['draft-is-public']), draft.counts.said.join(' | '));
  assert.match(SHARED['draft-is-public'], /anyone with the address can read/);
  assert.match(SHARED['draft-is-public'], /noindex/);
  assert.ok(pub.counts.said.length > 0 && !pub.counts.said.includes(SHARED['draft-is-public']), pub.counts.said.join(' | '));
});

// The browser checks (e2e/app_test.py, agora_checks) report on this same dataset, kept as a file: it
// must be what Chora makes today, or the page would be tested on adoptions Chora no longer writes.
const FIXTURE = 'test/fixtures/agora/licences.json';
test(`the browser checks' dataset (${FIXTURE}) is this one, as Chora makes it today`, async () => {
  const want = await dataset('https://creativecommons.org/licenses/by/4.0/');
  // To make it again: JSON.stringify(want, null, 1) + '\n', written to FIXTURE.
  assert.deepEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')), want);
});

test('the command line gives the same warnings', async () => {
  const f = join(dir, 'towns.json');
  writeFileSync(f, JSON.stringify(await dataset('https://creativecommons.org/licenses/by/4.0/')));
  const r = spawnSync(process.execPath, [CLI, 'publish', 'report', '--out', join(dir, 'out'), f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const k of ['licence-nc', 'licence-nd', 'licence-sa', 'licence-unknown']) assert.ok(r.stdout.includes(TEXT[k]), k);
  assert.ok(!r.stdout.includes(TEXT['licence-attribution']), 'and not the one that does not apply');
  assert.match(r.stdout, /place\/tynemouth#a-2: CC-BY-NC-4\.0, World Historical Gazetteer/);
  assert.match(r.stdout, /5 attestations cite a source with a licence of its own; 4 of them may not agree/);
  assert.ok(r.stdout.includes(SHARED['draft-is-public']));
  const j = JSON.parse(spawnSync(process.execPath, [CLI, 'publish', 'report', '--json', '--overwrite', '--out', join(dir, 'out'), f], { encoding: 'utf8' }).stdout);
  assert.deepEqual(j.counts.licences, { licensed: 5, flagged: 4 });
});

// ---- WHG's licence fields (whg.js, A16) -------------------------------------------------------------

test("whgLicence reads an attribution entry's licence as WHG writes it, leaving what it does not say unknown", () => {
  assert.deepEqual(whgLicence({ spdx_id: 'CC-BY-NC-4.0', permits_commercial: false, no_derivatives: null }, { redistributable: true }),
    { spdx: 'CC-BY-NC-4.0', commercial: false, derivatives: null, redistributable: true });
  assert.deepEqual(whgLicence({ spdx_id: 'CC-BY-ND-4.0', permits_commercial: true, no_derivatives: true }, {}),
    { spdx: 'CC-BY-ND-4.0', commercial: true, derivatives: false, redistributable: null });
  assert.deepEqual(whgLicence('ODbL-1.0', { redistributable: null }), { spdx: 'ODbL-1.0', commercial: null, derivatives: null, redistributable: null });
  // Not to be passed on, with no licence: an object still, so not read as merely unknown.
  assert.deepEqual(whgLicence(null, { redistributable: false }), { spdx: null, commercial: null, derivatives: null, redistributable: false });
  assert.equal(whgLicence(null, { redistributable: true }), null);
  assert.equal(whgLicence(undefined, undefined), null);
});
