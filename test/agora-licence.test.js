// paths.js first: it stops the tests unless PLATO_REPO holds the pinned PLATO, whose examples are read below.
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
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env as baseEnv, textFile } from './engine.js';
import { detect } from '../src/engine/input.js';
import { publish, TEXT as SHARED } from '../src/engine/agora/index.js';
import { licenceTerms, licenceReasons, attestationLicences, rightsStatement, KNOWN_LICENCES } from '../src/engine/agora/licence.js';
import { TEXT, recogniseLicence } from '../src/engine/agora/fair.js';
import { createLookup, WHG_ENDPOINT, whgLicence } from '../src/engine/gazetteer/index.js';
import * as adopt from '../src/engine/chora/adopt.js';
import * as georef from '../src/engine/georef/index.js';
import * as trace from '../src/engine/chora/trace.js';
import { newGeometryAttestation } from '../src/engine/chora/draw.js';

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
  // ...and with no version at all, as OpenStreetMap links ODbL.
  assert.equal(id('https://opendatacommons.org/licenses/odbl/'), 'ODbL-1.0');
  // A deed in a locale with a region, written with an underscore.
  assert.equal(id('https://creativecommons.org/licenses/by-nc/4.0/deed.pt_BR'), 'CC-BY-NC-4.0');
  assert.equal(id('https://creativecommons.org/licenses/by/4.0/legalcode.zh-hans'), 'CC-BY-4.0');
  // The Open Government Licence by its own address.
  assert.equal(id('https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/'), 'OGL-UK-3.0');
  // A port says which country's, and is read as the licence it ports.
  assert.equal(licenceTerms('https://creativecommons.org/licenses/by/3.0/de/').port, 'de');
  assert.equal(licenceTerms('https://creativecommons.org/licenses/by/3.0/').port, undefined);
  // A bare SPDX id, in any case.
  assert.equal(id('cc-by-sa-4.0'), 'CC-BY-SA-4.0');
  // Unknown: a bespoke licence, a version or licence not in the table, a rights statement (no
  // licence at all), nothing at all.
  for (const v of ['https://example.org/our-licence', 'https://creativecommons.org/licenses/by/1.0/', 'https://spdx.org/licenses/GPL-3.0-only', 'MIT',
    'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/2/', 'http://rightsstatements.org/vocab/InC/1.0/', '', null, 42])
    assert.equal(licenceTerms(v), null, String(v));
  // A rights statement is read as one, and nothing else is.
  assert.equal(rightsStatement('http://rightsstatements.org/vocab/InC/1.0/'), 'InC 1.0');
  assert.equal(rightsStatement('https://rightsstatements.org/page/NoC-NC/1.0/?language=en'), 'NoC-NC 1.0');
  assert.equal(rightsStatement('https://creativecommons.org/licenses/by/4.0/'), null);
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
    ['CC-BY-NC-4.0', 'CC-BY-NC-4.0', []],               // the same licence: no reason but ND
    ['ODbL-1.0', 'ODbL-1.0', []],
    ['CC-BY-4.0', 'CC-BY-4.0', []],
    ['CC-BY-ND-4.0', 'CC-BY-ND-4.0', ['nd']],           // ND even under the same licence: the copy may have been changed
    ['CC-BY-NC-ND-4.0', 'CC-BY-NC-ND-4.0', ['nd']],
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
      // A name from a source in `sources` (not a citation), licensed for non-commercial use only.
      placeOf('blyth', [{ '@id': `${BASE}place/blyth#a-1`, names: [{ toponym: 'Blyth' }], sources: [{ title: 'An atlas (illustrative)', authorityType: 'source', licence: 'https://creativecommons.org/licenses/by-nc/4.0/' }] }]),
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
const licenceKinds = (r) => r.items.filter((i) => /^licence-(nc|nd|sa|attribution|unknown)$|^licences-not-compared$|^rights-statement$/.test(i.kind)).map((i) => `${i.severity}:${i.kind}`).sort();

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
  assert.equal(r.counts.places, 7, 'every place was read');
  // newcastle's geometry, tynemouth's, jarrow's, hexham's, alnwick's and blyth's name; not morpeth's two.
  assert.deepEqual(r.counts.licences, { licensed: 6, flagged: 5 });
  assert.deepEqual(licenceKinds(r), ['warning:licence-nc', 'warning:licence-nd', 'warning:licence-sa', 'warning:licence-unknown']);
  assert.deepEqual(item(r, 'licence-nc').examples, [`${BASE}place/tynemouth#a-2: CC-BY-NC-4.0, World Historical Gazetteer`, `${BASE}place/blyth#a-1: CC-BY-NC-4.0, An atlas (illustrative)`]);
  assert.equal(item(r, 'licence-nc').count, 2);
  assert.deepEqual(item(r, 'licence-nd').examples, [`${BASE}place/hexham#a-1: CC-BY-ND-4.0, A survey that allows no adaptations (illustrative)`]);
  assert.deepEqual(item(r, 'licence-sa').examples, [`${BASE}place/alnwick#a-1: ODbL-1.0, OpenStreetMap`]);
  assert.deepEqual(item(r, 'licence-unknown').examples, [`${BASE}place/jarrow#a-2: none given, World Historical Gazetteer`]);
  // The CC BY adoption is in no example, and nothing of morpeth's.
  assert.ok(!r.items.some((i) => i.examples.some((e) => /newcastle|morpeth/.test(String(e)))), JSON.stringify(r.items.map((i) => i.examples)));
  // What to do, and what it is not, in plain words.
  assert.match(item(r, 'licence-nc').message, /publish the dataset under a licence compatible with the source's, remove those attestations/);
  assert.match(item(r, 'licence-nc').message, /not legal advice/);
  assert.ok(r.counts.said.includes("6 attestations cite a source with a licence of its own; 5 of them may not agree with the dataset's licence (see the warnings)."), r.counts.said.join(' | '));
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
  assert.equal(item(pd, 'licence-attribution').count, 5, 'GeoNames, TGN, the ND survey, OpenStreetMap and the atlas all ask for credit');
  // A licence not known here: nothing compared, and said so once, with the count and the licence.
  const odd = await report(await dataset('https://example.org/our-own-licence'));
  assert.deepEqual(licenceKinds(odd), ['warning:licences-not-compared']);
  assert.equal(item(odd, 'licences-not-compared').count, 6);
  assert.deepEqual(item(odd, 'licences-not-compared').examples, ['https://example.org/our-own-licence']);
  assert.deepEqual(odd.counts.licences, { licensed: 6, flagged: 0 });
  assert.ok(odd.counts.said.some((s) => /the dataset's licence is not one these tools know, so none was compared/.test(s)), odd.counts.said.join(' | '));
});

test('a dataset with no licence yet: no-licence says what to do, once; nothing is compared, and the summary says why', async () => {
  const r = await report(await dataset(undefined));
  assert.equal(item(r, 'no-licence')?.severity, 'warning');
  assert.equal(item(r, 'licences-not-compared'), undefined, 'not a second warning about the same missing licence');
  assert.deepEqual(licenceKinds(r), []);
  assert.deepEqual(r.counts.licences, { licensed: 6, flagged: 0 }, 'the attestations were read');
  assert.ok(r.counts.said.includes('6 attestations cite a source with a licence of its own; the dataset has no licence yet, so none was compared.'), r.counts.said.join(' | '));
});

test('a rights statement is not read as an unknown licence: its own warning, which does not ask for an SPDX address', async () => {
  const d = await dataset('https://creativecommons.org/licenses/by/4.0/');
  d.spatialEntities.push(placeOf('wooler', [copied('wooler', 'http://rightsstatements.org/vocab/InC/1.0/', 'An estate map')]));
  const r = await report(d);
  assert.deepEqual(item(r, 'rights-statement')?.examples, [`${BASE}place/wooler#a-1: rights statement InC 1.0, An estate map`]);
  assert.equal(item(r, 'rights-statement').severity, 'warning');
  assert.match(TEXT['rights-statement'], /need the holder's permission to publish/);
  assert.doesNotMatch(TEXT['rights-statement'], /spdx/i);
  // The unknown licence beside it (jarrow) is still unknown, and wooler is not among them.
  assert.deepEqual(item(r, 'licence-unknown').examples, [`${BASE}place/jarrow#a-2: none given, World Historical Gazetteer`]);
});

test('an attestation without an address is named by its place; an attestation-centric dataset is read too, by what it is about', async () => {
  const nc = 'https://creativecommons.org/licenses/by-nc/4.0/';
  const d = await dataset('https://creativecommons.org/licenses/by/4.0/');
  d.spatialEntities = [placeOf('amble', [{ names: [{ toponym: 'Amble' }], sources: [{ title: 'An atlas', licence: nc }] }]), placeOf('newbiggin', [{ '@id': `${BASE}place/newbiggin#a-1`, names: [{ toponym: 'Newbiggin' }], sources: [{ title: 'A charter' }] }])];
  const p = await report(d);
  assert.equal(p.counts.places, 2);
  assert.deepEqual(item(p, 'licence-nc')?.examples, [`${BASE}place/amble, an attestation without an address: CC-BY-NC-4.0, An atlas`]);
  const about = 'https://whgazetteer.org/example/entity/cambridge';
  const ac = {
    profile: 'attestation-centric', gazetteer: { ...gazetteer('https://creativecommons.org/licenses/by/4.0/') },
    attestations: [
      { about, names: [{ toponym: 'Grantanbrycg' }], sources: [{ title: 'An atlas', licence: nc }] },
      { '@id': `${BASE}a/2`, about, names: [{ toponym: 'Cambridge' }], sources: [{ title: 'A gazetteer', licence: 'https://creativecommons.org/licenses/by/4.0/' }] },
    ],
  };
  const a = await report(ac);
  assert.deepEqual(a.counts.licences, { licensed: 2, flagged: 1 }, 'both read');
  assert.deepEqual(item(a, 'licence-nc')?.examples, [`${about}, an attestation without an address: CC-BY-NC-4.0, An atlas`]);
});

test("a drawing traced from a CC BY-NC-SA 3.0 map, as Chora's tracing cites it, is flagged in a CC BY dataset", async () => {
  const fx = (f) => JSON.parse(readFileSync(f, 'utf8'));
  const g = await georef.readGeoreference(fx('test/fixtures/chora-iiif/annotation.json'), { manifest: fx('test/fixtures/chora-iiif/manifest-rumsey-shaped.json') });
  const drawn = { type: 'Point', coordinates: (await georef.toWorld(g, { type: 'Point', coordinates: [256, 256] }, { space: 'image', precision: 12 })).geojson.coordinates };
  const t = await trace.traceFor(g, drawn, { key: 'grid', fetchedAt: '2026-09-30T13:55:00.000Z', licence: 'https://creativecommons.org/licenses/by-nc-sa/3.0/' });
  const traced = newGeometryAttestation({ geojson: drawn, ...trace.TRACED_POINT_DEFAULTS, contributor: { name: who.name }, created: '2026-09-30T14:00:00Z', ...trace.tracedParts(t, { zoom: 14 }) });
  const d = await dataset('https://creativecommons.org/licenses/by/4.0/');
  d.spatialEntities = [placeOf('rothbury', [{ '@id': `${BASE}place/rothbury#a-1`, ...traced }])];
  const r = await report(d);
  assert.deepEqual(r.counts.licences, { licensed: 1, flagged: 1 });
  assert.ok(item(r, 'licence-nc')?.examples[0].startsWith(`${BASE}place/rothbury#a-1: CC-BY-NC-SA-3.0, `), JSON.stringify(item(r, 'licence-nc')));
  assert.ok(item(r, 'licence-sa')?.examples[0].startsWith(`${BASE}place/rothbury#a-1: CC-BY-NC-SA-3.0, `));
  // Its georeference, cited too, carries no licence and is not counted as one.
  assert.deepEqual(licenceKinds(r), ['warning:licence-nc', 'warning:licence-sa']);
});

test("PLATO's examples raise no licence warning (what DEVELOPERS.md says), while their licensed attestations are read", async () => {
  const dirEx = `${PLATO_REPO}/schemas/examples`;
  const files = readdirSync(dirEx).filter((f) => /^(place|attestation)-centric-.*\.json$/.test(f));
  assert.ok(files.length >= 10, files.join());
  let licensed = 0;
  for (const f of files) {
    const r = await report(JSON.parse(readFileSync(join(dirEx, f), 'utf8')));
    assert.equal(r.counts.licences.flagged, 0, `${f}: ${JSON.stringify(r.items.filter((i) => /licen|rights/.test(i.kind)))}`);
    licensed += r.counts.licences.licensed;
  }
  assert.ok(licensed > 0, 'some attestations had a licence of their own: the absence is not an empty reading');
});

test("the FAIR check and the deposit files know a dataset's licence by the same table", () => {
  assert.equal(recogniseLicence('https://creativecommons.org/licenses/by-nc/4.0/deed.pt_BR')?.spdx, 'CC-BY-NC-4.0');
  assert.deepEqual(recogniseLicence('https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/'), {
    spdx: 'OGL-UK-3.0', name: 'Open Government Licence v3.0', zenodo: 'ogl-uk-3.0', uri: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/' });
  assert.equal(recogniseLicence('https://opendatacommons.org/licenses/odbl/')?.spdx, 'ODbL-1.0');
  assert.equal(recogniseLicence('https://creativecommons.org/licenses/by-nd/3.0/')?.name, 'Creative Commons Attribution-NoDerivs 3.0 Unported');
  // A port is compared, but not named in the deposit files; its unported licence is (the control).
  assert.ok(licenceTerms('https://creativecommons.org/licenses/by/3.0/de/'));
  assert.equal(recogniseLicence('https://creativecommons.org/licenses/by/3.0/de/'), null);
  assert.equal(recogniseLicence('https://creativecommons.org/licenses/by/3.0/')?.spdx, 'CC-BY-3.0');
  // An address only: a bare id is not one, for the dataset's licence.
  assert.equal(recogniseLicence('CC-BY-4.0'), null);
  for (const k of KNOWN_LICENCES) assert.equal(recogniseLicence(`https://spdx.org/licenses/${k}`)?.spdx, k);
});

test("each licence the table knows has the id Zenodo's vocabulary has for it (checked 12 October 2026)", () => {
  // Pinned by hand from Zenodo's /api/vocabularies/licenses/<id>, each 200 on 12 October 2026, so that a
  // change to the table's ids shows here. cc-pdm-1.0 was 404: the Mark is Zenodo's other-pd.
  const cc = ['by', 'by-sa', 'by-nc', 'by-nd', 'by-nc-sa', 'by-nc-nd'].flatMap((k) => ['2.0', '2.5', '3.0', '4.0'].map((v) => [`CC-${k.toUpperCase()}-${v}`, `cc-${k}-${v}`]));
  const want = Object.fromEntries([...cc, ['CC0-1.0', 'cc0-1.0'], ['ODbL-1.0', 'odbl-1.0'], ['ODC-By-1.0', 'odc-by-1.0'], ['PDDL-1.0', 'pddl-1.0'],
    ['OGL-UK-3.0', 'ogl-uk-3.0'], ['CC-PDM-1.0', 'other-pd']]);
  assert.deepEqual(Object.keys(want).sort(), [...KNOWN_LICENCES].sort(), 'every licence the table knows is pinned, and no other');
  for (const k of KNOWN_LICENCES) assert.equal(recogniseLicence(`https://spdx.org/licenses/${k}`)?.zenodo, want[k], k);
  // The Mark is still recognised, and compared as the public domain.
  assert.equal(recogniseLicence('https://creativecommons.org/publicdomain/mark/1.0/')?.zenodo, 'other-pd');
  assert.equal(licenceTerms('https://creativecommons.org/publicdomain/mark/1.0/').pd, true);
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
  assert.match(r.stdout, /6 attestations cite a source with a licence of its own; 5 of them may not agree/);
  assert.ok(r.stdout.includes(SHARED['draft-is-public']));
  const j = JSON.parse(spawnSync(process.execPath, [CLI, 'publish', 'report', '--json', '--overwrite', '--out', join(dir, 'out'), f], { encoding: 'utf8' }).stdout);
  assert.deepEqual(j.counts.licences, { licensed: 6, flagged: 5 });
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
