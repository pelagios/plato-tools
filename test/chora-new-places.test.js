// Tracing a historical map into a new dataset (src/engine/chora/seed.js, featureParts in trace.js, and
// save.js's newPlaces): the empty dataset a tracing begins with, a new place from each feature traced, one
// attestation of it citing the map as PLATO's example of a traced geometry does, and a save that adds the
// places after the dataset's own, which the version check (Mneme) must pass with exactly the places and
// attestations added, and fail when one of them, or one of the dataset's own, is not as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { env, textFile, go } from './engine.js';
import { detect } from '../src/engine/input.js';
import * as georef from '../src/engine/georef/index.js';
import * as trace from '../src/engine/chora/trace.js';
import { save, verify, checkAddition } from '../src/engine/chora/save.js';
import { seedDataset, seedName, mintPlaceId, mapTimespan, navDateWords, newPlaceRecord, featureAttestation, KINDS, kindType, scriptOf, slugOf, TRACED_DEFAULTS, shapeOf } from '../src/engine/chora/seed.js';
import { DrawError } from '../src/engine/chora/draw.js';
import { rightsOf, annotationLicenceOf, freeToReuse, CC0 } from '../src/engine/chora/rights.js';
import { placeKinds } from '../src/engine/krisis/kinds.js';
import { gather } from '../src/engine/krisis/match.js';
import { areaCheck, MAX_AREA_POINTS } from '../src/engine/krisis/scope.js';
import { res } from './engine.js';
import { PLATO_REPO } from './paths.js';

const fx = (f) => JSON.parse(readFileSync(f, 'utf8'));
const ROCQUE_A = fx('test/fixtures/georef/bpl-rocque-annotation.json'), ROCQUE_M = fx('test/fixtures/georef/bpl-rocque-manifest.json');
const rocque = await georef.readGeoreference(ROCQUE_A, { manifest: ROCQUE_M });
const GRID = fx('test/fixtures/chora-iiif/annotation.json');
const grid = await georef.readGeoreference(GRID, { manifest: fx('test/fixtures/chora-iiif/manifest-rumsey-shaped.json') });
const order2 = await georef.readGeoreference(fx('test/fixtures/chora-iiif/annotation-order2.json'));
const EXAMPLE = fx(`${PLATO_REPO}/schemas/examples/place-centric-georeference.json`);
const BASE = 'https://example.org/traced/';
const who = { name: 'Ada Surveyor' };
const WHEN = '2026-10-14T09:00:00Z';
/** A point of the map's image, in the world. */
const at = async (g, x, y) => (await georef.toWorld(g, { type: 'Point', coordinates: [x, y] }, { space: 'image', precision: 7 })).geojson.coordinates;

/** A feature traced from `g` at image pixels `pts` (one: a point; more: a line), cited as Chora cites it. */
async function traced(g, pts, { names = [{ toponym: 'Fort Du Quesne', language: 'en' }], types = ['fort'], timespan = mapTimespan('1764'), label = null } = {}) {
  const geojson = pts.length === 1 ? { type: 'Point', coordinates: await at(g, ...pts[0]) } : { type: 'LineString', coordinates: await Promise.all(pts.map((p) => at(g, ...p))) };
  const t = await trace.traceFor(g, geojson, { key: 'm', title: g.title, fetchedAt: '2026-10-14T08:00:00Z', licence: null });
  const parts = [{ trace: t, role: TRACED_DEFAULTS[shapeOf(geojson)].role, geometry: geojson, zoom: 12 }];
  const geometries = [{ geojson, ...TRACED_DEFAULTS[shapeOf(geojson)] }];
  if (label) {
    const lg = { type: 'Point', coordinates: await at(g, ...label) };
    parts.push({ trace: await trace.traceFor(g, lg, { key: 'm', title: g.title, fetchedAt: '2026-10-14T08:00:00Z' }), role: 'LabelAnchor', geometry: lg, zoom: 12 });
    geometries.push({ geojson: lg, role: 'LabelAnchor' });
  }
  const p = trace.featureParts(parts, { credit: 'Public Domain/No known restrictions on use.', sourceTimespan: timespan });
  return featureAttestation({ geometries, names, types, timespan, contributor: who, created: WHEN, ...p });
}
async function seedFile(extra = {}) {
  return textFile(JSON.stringify(seedDataset({ mapTitle: rocque.title, licence: 'https://creativecommons.org/publicdomain/mark/1.0/', base: BASE, ...extra })), seedName(rocque.title));
}
async function saved(f, newPlaces, additions = [], options = {}) {
  const e = env();
  const input = await detect([f]);
  const r = await save(input, additions, e, { reopen: (o) => new File(e.outs[o.name], o.name), newPlaces, ...options });
  const name = r.outputs[0]?.name;
  return { ...r, input, e, name, text: name ? e.outs[name].join('') : null };
}

test('the seed: an empty place-centric dataset named for the map, under the base address, with its licence, which Elenchos passes', async () => {
  const doc = seedDataset({ mapTitle: rocque.title, licence: 'https://creativecommons.org/publicdomain/mark/1.0/', base: 'https://example.org/traced' });
  assert.equal(doc.profile, 'place-centric');
  assert.deepEqual(doc.spatialEntities, []);
  assert.equal(doc.gazetteer.title, `Places traced from ${rocque.title}`);
  assert.equal(doc.gazetteer.uriSpace, 'https://example.org/traced/');
  assert.equal(doc.gazetteer.licence, 'https://creativecommons.org/publicdomain/mark/1.0/');
  assert.equal(doc.gazetteer.status, 'draft');
  assert.match(seedName(rocque.title), /^traced-a-general-map-of-north-america[a-z-]*\.json$/);
  const r = await go([textFile(JSON.stringify(doc), 'seed.json')], 'check');
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  assert.equal(r.report.counts.places ?? 0, 0);
  // The control: Elenchos can fail it. A seed that is not one (a place with no label) has a problem.
  const bad = await go([textFile(JSON.stringify({ ...doc, spatialEntities: [{ '@id': BASE + 'place/x' }] }), 'bad.json')], 'check');
  assert.ok(bad.report.errors > 0);
  // Without a licence, or a base, none is written.
  const bare = seedDataset({ mapTitle: '' });
  assert.equal(bare.gazetteer.licence, undefined); assert.equal(bare.gazetteer.uriSpace, undefined);
  assert.equal(bare.gazetteer.title, 'Places traced from a historical map');
});

test('an address minted under the base by the address scheme, from the name, distinct from those taken; refused without a base', () => {
  assert.equal(mintPlaceId(BASE, 'Fort Du Quesne'), BASE + 'place/fort-du-quesne');
  assert.equal(mintPlaceId(BASE, 'Fort Du Quesne', new Set([BASE + 'place/fort-du-quesne'])), BASE + 'place/fort-du-quesne-2');
  assert.equal(mintPlaceId('https://example.org/traced', 'Montréal'), BASE + 'place/montreal');
  assert.equal(mintPlaceId(BASE, 'Αθῆναι', new Set(), { romanized: 'Athenai' }), BASE + 'place/athenai');
  assert.equal(mintPlaceId(BASE, '北京'), BASE + 'place/place');
  assert.equal(slugOf('  St. Mary’s Ch.  '), 'st-mary-s-ch');
  assert.throws(() => mintPlaceId('not an address', 'X'), DrawError);
});

test('the map\'s date: a year or ISO date as it is, a year found in words, two as a range, the words kept as written; navDate read from the manifest', () => {
  assert.deepEqual(mapTimespan('1764'), { startEarliest: '1764', endLatest: '1764', sourceLabel: '1764' });
  assert.deepEqual(mapTimespan('[ca. 1764]'), { startEarliest: '1764', endLatest: '1764', sourceLabel: '[ca. 1764]' });
  assert.deepEqual(mapTimespan('from the year 1754, to 1761'), { startEarliest: '1754', endLatest: '1761', sourceLabel: 'from the year 1754, to 1761' });
  assert.deepEqual(mapTimespan('undated'), { sourceLabel: 'undated' });
  assert.equal(mapTimespan('  '), null);
  assert.equal(georef.manifestNavDate({ navDate: '1764-01-01T00:00:00Z' }), '1764-01-01T00:00:00Z');
  assert.equal(georef.manifestNavDate({ navDate: 'about 1764' }), null);
  assert.equal(georef.manifestNavDate(ROCQUE_M), null);   // the BPL manifest gives none; its metadata's "Date" is words, never read
  assert.equal(navDateWords('1764-01-01T00:00:00Z'), '1764');
  assert.equal(navDateWords('1764-06-01T00:00:00+00:00'), '1764-06-01');
  assert.equal(navDateWords(null), '');
});

test('kinds: each a Getty AAT concept by its full IRI; free text a label alone; Krisis reads the IRI and the word as the place\'s kind', async () => {
  for (const k of KINDS) assert.match(k.identifier, /^http:\/\/vocab\.getty\.edu\/aat\/3\d{8}$/);
  assert.equal(new Set(KINDS.map((k) => k.identifier)).size, KINDS.length);
  assert.deepEqual(kindType('church'), { label: 'church', identifier: 'http://vocab.getty.edu/aat/300007466' });
  assert.deepEqual(kindType('Church'), { label: 'church', identifier: 'http://vocab.getty.edu/aat/300007466' });
  assert.deepEqual(kindType('beacon'), { label: 'beacon' });
  assert.equal(kindType(''), null);
  // What Krisis ranks a candidate by: the kind of the place, from its type's IRI and its word.
  const ks = placeKinds({ typeIds: [kindType('village').identifier], types: ['village'] });
  assert.ok(ks.some((k) => k.aat === 'aat:300008372' && k.facet === 'settlement'), JSON.stringify(ks));
  assert.ok(placeKinds({ typeIds: [kindType('river').identifier] }).some((k) => k.facet === 'water'));
  // And Krisis's reading of a dataset carries the kind from the attestation written (gather).
  const a = await traced(rocque, [[5000, 4000]], { types: ['village'] });
  const doc = { ...seedDataset({ mapTitle: 'm', base: BASE }), spatialEntities: [newPlaceRecord({ id: BASE + 'place/v', label: 'V', attestations: [a] })] };
  const g = await gather({ subjects: await detect([textFile(JSON.stringify(doc), 'v.json')]) }, env());
  const place = g.places?.[BASE + 'place/v'] || g.work?.places?.[BASE + 'place/v'] || [...(g.places?.values?.() || [])][0];
  assert.ok(place, JSON.stringify(Object.keys(g)));
  assert.ok((place.typeIds || []).includes(kindType('village').identifier), JSON.stringify(place));
});

test('the script asked only where the language implies one that is not Latin', () => {
  assert.equal(scriptOf('en'), null); assert.equal(scriptOf('la'), null); assert.equal(scriptOf('fr'), null);
  assert.equal(scriptOf('grc'), 'Grek'); assert.equal(scriptOf('ar'), 'Arab'); assert.equal(scriptOf('ru'), 'Cyrl');
  assert.equal(scriptOf('grc-Latn'), null); assert.equal(scriptOf('sr-Latn'), null); assert.equal(scriptOf('en-Arab'), 'Arab');
  assert.equal(scriptOf(''), null);
});

test('a feature traced: one attestation with its names, its geometry, its kind, the map\'s date, schema-valid, citing the map and its georeference as PLATO\'s example does', async () => {
  const a = await traced(rocque, [[7340, 2890]]);
  assert.equal(checkAddition(a, res.validators), null);
  assert.deepEqual(a.names, [{ toponym: 'Fort Du Quesne', language: 'en' }]);
  assert.equal(a.geometries.length, 1);
  assert.equal(a.geometries[0].role, 'https://w3id.org/plato#RepresentativePoint');
  assert.deepEqual(a.geometries[0].spatialPrecision, ['approximate']);
  assert.equal(a.geometries[0].precisionKm, undefined, 'the misfit is never made the precision');
  assert.deepEqual(a.types, [{ label: 'fort', identifier: 'http://vocab.getty.edu/aat/300006909' }]);
  assert.deepEqual(a.timespans, [{ startEarliest: '1764', endLatest: '1764', sourceLabel: '1764' }]);
  // Shaped as the example's traced attestation: the same two citations, the same kinds of locator.
  const ex = EXAMPLE.spatialEntities[0].attestations[0];
  assert.equal(a.citations.length, ex.citations.length);
  const [map, method] = a.citations, [exMap, exMethod] = ex.citations;
  assert.equal(map.citationFunction, exMap.citationFunction);
  assert.equal(map.source['@id'], exMap.source['@id']);
  assert.equal(map.source.title, exMap.source.title);
  assert.equal(map.source.authorityType, 'source');
  assert.match(map.locator, /^https:\/\/ark\.digitalcommonwealth\.org\/ark:\/50959\/ks65px29g\/canvas\/8623qf00m#xywh=\d+,\d+,\d+,\d+$/);
  assert.deepEqual(method, exMethod, 'the georeference cited as the method, exactly as the example has it');
  // What this tracing adds to the map's source: its credit as written, and its date (plato:source_timespan).
  assert.equal(map.source.citation, 'Public Domain/No known restrictions on use.');
  assert.deepEqual(map.source.timespan, { startEarliest: '1764', endLatest: '1764', sourceLabel: '1764' });
  // The notes: the example's fixed sentences first, then the misfit's (a thin plate spline passes through its points), then how.
  assert.ok(a.notes.startsWith('Georeferenced through https://annotations.allmaps.org/maps/56425c69f9cd4f1b (thin plate spline, 22 control points), retrieved 2026-10-14T08:00:00Z. On canvas https://ark.digitalcommonwealth.org/ark:/50959/ks65px29g/canvas/8623qf00m of manifest https://ark.digitalcommonwealth.org/ark:/50959/ks65px29g/manifest.'), a.notes);
  assert.ok(a.notes.includes('The georeference passes through its control points exactly, so its error elsewhere is not estimated.'), a.notes);
  assert.ok(a.notes.endsWith('Traced by hand from a georeferenced historical map at zoom 12 in PLATO tools (Chora).'), a.notes);
  assert.ok(!a.notes.includes('where the map writes the name'));
});

test('the misfit sentence for a map fitted by least squares (order 2): its figures in km, said to be of the georeference, not of the position', async () => {
  const a = await traced(order2, [[200, 200]], { types: [] });
  assert.match(a.notes, /The georeference misses its own control points by \d+\.\d\d km on average \(root mean square; at most \d+\.\d\d km\); this is a measure of the georeference, not of this position's accuracy\./);
  assert.equal(a.geometries[0].precisionKm, undefined);
  assert.equal(a.types, undefined, 'no kind: none written');
  // Chora's own path (a drawing of a place the dataset has) says no misfit, as before.
  const t = await trace.traceFor(order2, { type: 'Point', coordinates: await at(order2, 200, 200) }, { key: 'm', title: 'x' });
  assert.ok(!trace.tracedParts(t, { zoom: 9 }).notes.includes('misses its own control points'));
});

test('a label anchor is a second geometry of the same attestation, cited by its own box; the label-anchor sentence only when every part is the label', async () => {
  const a = await traced(rocque, [[7340, 2890]], { label: [7400, 2830] });
  assert.equal(a.geometries.length, 2);
  assert.equal(a.geometries[1].role, 'https://w3id.org/plato#LabelAnchor');
  assert.equal(a.citations.length, 3, 'the map twice (two boxes), the georeference once');
  assert.notEqual(a.citations[0].locator, a.citations[1].locator);
  assert.ok(!a.notes.includes('The position is where the map writes the name'));
  assert.equal(checkAddition(a, res.validators), null);
});

test('a feature with no name, or a name or kind PLATO would not take, is refused in words', async () => {
  const g = { geojson: { type: 'Point', coordinates: [-80, 40] } };
  assert.throws(() => featureAttestation({ geometries: [g], names: [{ toponym: '  ' }], contributor: who, created: WHEN }), /Name 1 is empty/);
  assert.throws(() => featureAttestation({ geometries: [g], names: [{ toponym: 'X', language: 'not a tag!' }], contributor: who, created: WHEN }), /not a language tag/);
  assert.throws(() => featureAttestation({ geometries: [], contributor: who, created: WHEN }), /no geometry/);
  assert.throws(() => featureAttestation({ geometries: [g], types: [{ label: 'x', identifier: 'aat:1' }], contributor: who, created: WHEN }), /full web address/);
  const ok = featureAttestation({ geometries: [g], names: [{ toponym: 'Αθῆναι', language: 'grc', script: 'Grek', romanized: 'Athenai' }], contributor: who, created: WHEN });
  assert.deepEqual(ok.names, [{ toponym: 'Αθῆναι', language: 'grc', script: 'Grek', romanized: 'Athenai' }]);
});

/** N places traced from the Rocque map, along a row of it. */
async function places(n, { from = 0 } = {}) {
  const out = [], taken = new Set();
  for (let i = from; i < from + n; i++) {
    const name = `Fort ${i}`;
    const id = mintPlaceId(BASE, name, taken); taken.add(id);
    out.push(newPlaceRecord({ id, label: name, attestations: [await traced(rocque, [[3000 + 37 * i, 3000 + 11 * i]], { names: [{ toponym: name, language: 'en' }] })] }));
  }
  return out;
}

test('saved: the seed with N new places, every one as given, and Mneme passes with N places and N attestations added', async () => {
  const fresh = await places(5);
  const r = await saved(await seedFile(), fresh);
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  assert.ok(r.mneme?.passed, JSON.stringify(r.mneme?.reasons));
  assert.equal(r.report.counts['attestations added'], 5);
  assert.equal(r.report.counts['places added'], 5);
  assert.equal(r.mneme.report.counts.added, 5);
  assert.deepEqual(r.mneme.report.counts.places, { earlier: 0, later: 5 });
  const doc = JSON.parse(r.text);
  assert.deepEqual(doc.spatialEntities, fresh);
  assert.equal(doc.gazetteer.title, `Places traced from ${rocque.title}`);
  assert.match(r.name, /\.chora\.json$/);
  // Checked by itself, the file has no problem.
  const c = await go([textFile(r.text, r.name)], 'check');
  assert.equal(c.report.errors, 0, JSON.stringify(c.report.items));
});

test('saved again: places traced before are kept as they were, the new ones after; Mneme fails when one of the earlier is changed, one new place is missing, or two are one', async () => {
  const first = await saved(await seedFile(), await places(3));
  assert.ok(first.mneme.passed);
  const earlier = textFile(first.text, first.name);
  const more = await places(2, { from: 3 });
  // A drawing added to a place traced before (Chora's own path), and the two new places.
  const add = { placeId: BASE + 'place/fort-0', attestation: (await places(1, { from: 9 }))[0].attestations[0] };
  const r = await saved(earlier, more, [add]);
  assert.ok(r.mneme?.passed, JSON.stringify(r.mneme?.reasons));
  assert.equal(r.report.counts['attestations added'], 3);
  assert.deepEqual(r.mneme.report.counts.places, { earlier: 3, later: 5 });
  const doc = JSON.parse(r.text);
  assert.deepEqual(doc.spatialEntities.map((p) => p['@id']), [0, 1, 2, 3, 4].map((i) => `${BASE}place/fort-${i}`));
  assert.equal(doc.spatialEntities[0].attestations.length, 2);
  const input = await detect([earlier]);
  const judge = async (d, added, places) => verify(input, textFile(JSON.stringify(d), 'later.json'), added, env(), { places });
  // The control: the file as saved passes, judged the same way.
  assert.ok((await judge(doc, 3, 2)).passed);
  // One of the earlier attestations changed: a breach.
  const changed = structuredClone(doc); changed.spatialEntities[1].attestations[0].names[0].toponym = 'Fort Changed';
  const c = await judge(changed, 3, 2);
  assert.equal(c.passed, false); assert.ok(c.reasons.some((x) => /changed|gone|attestation/.test(x)), JSON.stringify(c.reasons));
  // One new place missing: an attestation and a place fewer.
  const missing = structuredClone(doc); missing.spatialEntities.pop();
  assert.equal((await judge(missing, 3, 2)).passed, false);
  // Two new places made one: as many attestations, a place fewer. Only the count of places sees it.
  const merged = structuredClone(doc); const last = merged.spatialEntities.pop(); merged.spatialEntities[3].attestations.push(...last.attestations);
  const m = await judge(merged, 3, 2);
  assert.equal(m.passed, false); assert.ok(m.reasons.some((x) => /1 places added where 2 were expected/.test(x)), JSON.stringify(m.reasons));
  assert.ok((await judge(merged, 3, 0)).passed, 'without the count of places the merge goes unseen: the count is what catches it');
});

test('a new place whose address the dataset has already, two new places of one address, or one with nothing traced, are refused before anything is written', async () => {
  const first = await saved(await seedFile(), await places(1));
  const again = await places(1);   // Fort 0 again: the same address
  const r = await saved(textFile(first.text, first.name), again);
  assert.equal(r.outputs.length, 0); assert.equal(r.mneme, null);
  assert.ok(r.report.items.some((i) => i.kind === 'chora-place-exists' && i.examples[0] === BASE + 'place/fort-0'), JSON.stringify(r.report.items));
  const two = [...await places(1), ...await places(1)];
  const d = await saved(await seedFile(), two);
  assert.ok(d.report.items.some((i) => i.kind === 'chora-new-place-invalid'), JSON.stringify(d.report.items));
  const empty = await saved(await seedFile(), [newPlaceRecord({ id: BASE + 'place/x', label: 'X' })]);
  assert.ok(empty.report.items.some((i) => i.kind === 'chora-new-place-invalid' && /nothing traced/.test(i.examples[0])));
  // And one known to Chora's store (hasPlace) is refused without reading the dataset.
  const known = await saved(await seedFile(), await places(1), [], { hasPlace: (k) => k === BASE + 'place/fort-0' });
  assert.ok(known.report.items.some((i) => i.kind === 'chora-place-exists'));
});

test('rights: the map\'s licence and the georeference\'s (Allmaps\' are CC0) given one verdict, free to reuse or not, or not known', () => {
  assert.deepEqual(annotationLicenceOf(ROCQUE_A), { licence: CC0, licenceLabel: 'CC0', from: 'allmaps' });
  assert.deepEqual(annotationLicenceOf({ id: 'https://example.org/a', rights: 'https://creativecommons.org/licenses/by/4.0/' }).from, 'annotation');
  assert.equal(annotationLicenceOf({ id: 'https://example.org/a' }).licence, null);
  assert.equal(freeToReuse('https://creativecommons.org/publicdomain/mark/1.0/'), true);
  assert.equal(freeToReuse('https://creativecommons.org/licenses/by-sa/4.0/'), true);
  assert.equal(freeToReuse('https://creativecommons.org/licenses/by-nc-sa/3.0/'), false);
  assert.equal(freeToReuse('https://creativecommons.org/licenses/by-nd/4.0/'), false);
  assert.equal(freeToReuse('http://rightsstatements.org/vocab/InC/1.0/'), false);
  assert.equal(freeToReuse('http://rightsstatements.org/vocab/NoC-US/1.0/'), true);
  assert.equal(freeToReuse(null), null);
  const free = rightsOf({ manifest: { id: 'https://x.example.org/m', rights: 'https://creativecommons.org/publicdomain/mark/1.0/' }, annotation: ROCQUE_A });
  assert.equal(free.free, true); assert.match(free.words, /^Free to reuse: the map is licensed Public Domain Mark, and its georeference is licensed CC0\.$/);
  const nc = rightsOf({ manifest: { id: 'https://www.davidrumsey.com/m' }, annotation: ROCQUE_A });
  assert.equal(nc.free, false); assert.match(nc.words, /CC BY-NC-SA 3\.0/);
  const unknown = rightsOf({ manifest: ROCQUE_M, annotation: ROCQUE_A });
  assert.equal(unknown.free, null); assert.match(unknown.words, /the map names no licence/);
  assert.equal(unknown.map.credit, ROCQUE_M.attribution);
});

test('the sheet\'s outline: the mask through the georeference, at most 1,000 corners, an area WHG takes; the image\'s rectangle with no mask', async () => {
  const o = await trace.sheetOutline(rocque);
  assert.equal(o.from, 'mask');
  assert.ok(o.corners >= 4 && o.corners <= MAX_AREA_POINTS, o.corners);
  assert.deepEqual(areaCheck(o.area).area, o.area);
  // Around Fort Duquesne, which the map shows, and not far beyond the mask's corners.
  const ring = o.area.coordinates[0];
  const [w, e] = [Math.min(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[0]))];
  assert.ok(w < -80.01 && e > -80.01, `${w}..${e}`);
  const small = await trace.sheetOutline(rocque, { max: 12 });
  assert.ok(small.corners <= 12 && small.simplified, small.corners);
  // A georeference with no mask (a copy of one, which is a new georeference: readGeoreference's g spreads).
  const r = await trace.sheetOutline({ ...grid, mask: null });
  assert.equal(r.from, 'image');
  assert.ok(r.corners >= 4 && r.corners <= MAX_AREA_POINTS);
  // The image's corners are in it: the whole image, not the mask's inset.
  const corner = await at(grid, 0, 0);
  assert.ok(r.area.coordinates[0].some((p) => Math.abs(p[0] - corner[0]) < 1e-5 && Math.abs(p[1] - corner[1]) < 1e-5), JSON.stringify(corner));
});
