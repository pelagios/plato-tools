// Recording what is traced from a map into a new dataset (src/chora/traced.js, newPlacesOf; Stephen's
// decisions 4, 5 and 9 of 14 October 2026): one attestation for each feature, with its names, its
// geometries (a label's position among them), its kind, the map's date and the map cited; the
// georeference's misfit said in the notes and never made a precision. The attestations a point, a line, an
// area and a label anchor become are held to golden files (test/fixtures/chora/traced/), made from the
// fixtures and read through by hand when they were first written; a change to any of them is a change to
// what the tools write, to be looked at, not regenerated unseen. Also the settings kept for each map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { res } from './engine.js';
import * as georef from '../src/engine/georef/index.js';
import * as trace from '../src/engine/chora/trace.js';
import { checkAddition } from '../src/engine/chora/save.js';
import { TRACED_DEFAULTS } from '../src/engine/chora/seed.js';
import * as traced from '../src/chora/traced.js';
import { rightsOf } from '../src/engine/chora/rights.js';

const fx = (f) => JSON.parse(readFileSync(f, 'utf8'));
const ROCQUE_A = fx('test/fixtures/georef/bpl-rocque-annotation.json'), ROCQUE_M = fx('test/fixtures/georef/bpl-rocque-manifest.json');
const rocque = await georef.readGeoreference(ROCQUE_A, { manifest: ROCQUE_M });
const grid = await georef.readGeoreference(fx('test/fixtures/chora-iiif/annotation.json'), { manifest: fx('test/fixtures/chora-iiif/manifest-rumsey-shaped.json') });
const order2 = await georef.readGeoreference(fx('test/fixtures/chora-iiif/annotation-order2.json'));
const who = { name: 'Ada Surveyor' };
const WHEN = '2026-10-14T09:00:00Z', FETCHED = '2026-10-14T08:00:00Z';
const GOLDEN = 'test/fixtures/chora/traced/';
const at = async (g, x, y) => (await georef.toWorld(g, { type: 'Point', coordinates: [x, y] }, { space: 'image', precision: 7 })).geojson.coordinates;

/** A map's settings as the form gives them, for map `key`. */
function settings(key, title, over = {}, manifest = { rights: 'https://creativecommons.org/publicdomain/mark/1.0/' }) {
  const was = traced.defaultSettings({ key, title, manifest: null, rights: rightsOf({ manifest, annotation: ROCQUE_A }), base: 'https://example.org/traced/' });
  return traced.settingsFrom({ base: 'https://example.org/traced/', datasetTitle: '', date: '[ca. 1764]', dateEach: true, language: 'en', ...over }, was).settings;
}
/** A feature draft as Chora makes one: drawn at image pixels `pts` of `g`, traced from it, named or a part of a place named. */
async function draft(g, key, pts, { shape = pts.length === 1 ? 'Point' : 'LineString', placeId, label, names, types = [], part = false, role, s } = {}) {
  const coords = await Promise.all(pts.map((p) => at(g, ...p)));
  const geojson = shape === 'Point' ? { type: 'Point', coordinates: coords[0] } : shape === 'Polygon' ? { type: 'Polygon', coordinates: [[...coords, coords[0]]] } : { type: 'LineString', coordinates: coords };
  const t = await trace.traceFor(g, geojson, { key, title: g.title, fetchedAt: FETCHED, licence: s?.licence || null });
  return { id: `${key}-${placeId}-${pts.flat().join('-')}`, kind: 'feature', placeId, placeLabel: label, names, types, part, mapKey: key, geojson, ...traced.featureDefaults(s, geojson),
    ...(role ? { role, defaulted: false } : {}), trace: t, zoom: 13, basemap: 'Natural Earth', drawnAt: WHEN };
}
/** The golden file `name`: compared, or written when GOLDEN_WRITE=1 (to be read through by hand before it is committed); one missing fails. */
function golden(name, value) {
  const f = `${GOLDEN}${name}.json`;
  if (process.env.GOLDEN_WRITE) { writeFileSync(f, JSON.stringify(value, null, 2) + '\n'); return; }
  assert.ok(existsSync(f), `${f} is missing: make it with GOLDEN_WRITE=1, and read it through before committing it`);
  assert.deepEqual(value, fx(f), `${name}: what is written differs from ${f}`);
}

// The Rocque map's manifest gives a credit and no licence; here it is given the Public Domain Mark, to cite it under.
const S = { rocque: settings('rocque', rocque.title, {}, { ...ROCQUE_M, rights: 'https://creativecommons.org/publicdomain/mark/1.0/' }), grid: settings('grid', grid.title, { language: 'la' }), order2: settings('o2', order2.title, { dateEach: false, date: '1790' }) };
const settingsOf = (k) => (k === 'rocque' ? S.rocque : k === 'grid' ? S.grid : k === 'o2' ? S.order2 : null);

test('a point traced from the Rocque map (a thin plate spline): its name, kind, date and the map cited, the interpolating sentence in its notes', async () => {
  const d = await draft(rocque, 'rocque', [[7340, 2890]], { placeId: 'https://example.org/traced/place/fort-du-quesne', label: 'Fort Duquesne', names: [traced.nameOf({ toponym: 'Fort Du Quesne', language: 'en' })], types: [traced.kindType('fort')], s: S.rocque });
  const { newPlaces, unnamed } = traced.newPlacesOf([d], { settingsOf, contributor: who, version: '0.9.0-test' });
  assert.deepEqual(unnamed, []);
  assert.equal(newPlaces.length, 1);
  const [p] = newPlaces;
  assert.equal(p['@id'], 'https://example.org/traced/place/fort-du-quesne'); assert.equal(p.label, 'Fort Duquesne');
  const a = p.attestations[0];
  assert.equal(checkAddition(a, res.validators), null);
  assert.deepEqual(a.timespans, [{ startEarliest: '1764', endLatest: '1764', sourceLabel: '[ca. 1764]' }]);
  assert.deepEqual(a.citations[0].source.timespan, { startEarliest: '1764', endLatest: '1764', sourceLabel: '[ca. 1764]' });
  assert.equal(a.citations[0].source.licence, 'https://creativecommons.org/publicdomain/mark/1.0/');
  assert.equal(a.citations[0].source.citation, ROCQUE_M.attribution, "the manifest's credit, as written, in the cited source's citation (decision 10)");
  assert.match(a.notes, /The georeference passes through its control points exactly, so its error elsewhere is not estimated\./);
  assert.equal(a.geometries[0].precisionKm, undefined);
  golden('point', a);
});

test('a line traced from a map fitted at order 2: the misfit sentence, with its figures, never a precision; no date given to the place when the map\'s settings say not', async () => {
  const d = await draft(order2, 'o2', [[100, 100], [250, 180], [400, 260]], { placeId: 'https://example.org/traced/place/the-road', label: 'The road', names: [traced.nameOf({ toponym: 'The Road', language: 'en' })], types: [traced.kindType('road')], s: S.order2 });
  const a = traced.newPlacesOf([d], { settingsOf, contributor: who, version: '0.9.0-test' }).newPlaces[0].attestations[0];
  assert.equal(checkAddition(a, res.validators), null);
  assert.equal(a.geometries[0].role, 'https://w3id.org/plato#Extent');
  assert.deepEqual(a.geometries[0].spatialPrecision, ['approximate']);
  assert.equal(a.geometries[0].precisionKm, undefined);
  const m = /misses its own control points by (\d+\.\d\d) km on average \(root mean square; at most (\d+\.\d\d) km\)/.exec(a.notes);
  assert.ok(m, a.notes);
  assert.equal(m[1], d.trace.record.controlPointMisfitKm.toFixed(2));
  assert.equal(a.timespans, undefined, 'not dated by the map');
  assert.deepEqual(a.citations[0].source.timespan, { startEarliest: '1790', endLatest: '1790', sourceLabel: '1790' }, 'the map still dated as a source');
  golden('line', a);
});

test('the misfit of a real map fitted at order 1 (the British Dominions): the figures the georeference gives, above nothing', async () => {
  const dominions = await georef.readGeoreference(fx('test/fixtures/georef/bpl-british-dominions-annotation.json'), { manifest: fx('test/fixtures/georef/bpl-british-dominions-manifest.json') });
  const s = settings('dom', dominions.title);
  const d = await draft(dominions, 'dom', [[3000, 2000]], { placeId: 'https://example.org/traced/place/x', label: 'X', names: [traced.nameOf({ toponym: 'X' })], s });
  const a = traced.newPlacesOf([d], { settingsOf: () => s, contributor: who }).newPlaces[0].attestations[0];
  const rms = d.trace.record.controlPointMisfitKm, max = d.trace.record.controlPointMisfitMaxKm;
  assert.ok(rms > 0.5 && max >= rms, `${rms} ${max}`);
  assert.ok(a.notes.includes(`misses its own control points by ${rms.toFixed(2)} km on average (root mean square; at most ${max.toFixed(2)} km)`), a.notes);
  assert.equal(a.geometries[0].precisionKm, undefined, 'never the precision');
});

test('an area traced from the grid map, its names in Latin, its kind free text; the map\'s own defaults for an area', async () => {
  const d = await draft(grid, 'grid', [[100, 100], [300, 100], [300, 300], [100, 300]], { shape: 'Polygon', placeId: 'https://example.org/traced/place/silva', label: 'Silva', names: [traced.nameOf({ toponym: 'Silva', language: 'la' })], types: [traced.kindType('greenwood')], s: S.grid });
  assert.equal(d.defaulted, true);
  assert.deepEqual([d.role, d.precision], [TRACED_DEFAULTS.area.role, TRACED_DEFAULTS.area.precision]);
  const a = traced.newPlacesOf([d], { settingsOf, contributor: who, version: '0.9.0-test' }).newPlaces[0].attestations[0];
  assert.equal(checkAddition(a, res.validators), null);
  assert.deepEqual(a.types, [{ label: 'greenwood' }], 'free text: a label alone');
  assert.deepEqual(a.names, [{ toponym: 'Silva', language: 'la' }]);
  assert.equal(a.geometries[0].geojson.type, 'Polygon');
  golden('area', a);
});

test('a label anchor added to a place named before: a second geometry of its one attestation, cited by its own box', async () => {
  const id = 'https://example.org/traced/place/fort-du-quesne';
  const main = await draft(rocque, 'rocque', [[7340, 2890]], { placeId: id, label: 'Fort Duquesne', names: [traced.nameOf({ toponym: 'Fort Du Quesne', language: 'en' })], types: [traced.kindType('fort')], s: S.rocque });
  // Added to the place as "Add to … instead" adds it: a point, so where the map writes the name, with no precision.
  const label = { ...await draft(rocque, 'rocque', [[7450, 2830]], { placeId: id, label: 'Fort Duquesne', part: true, s: S.rocque }), ...traced.addedPart({ type: 'Point' }) };
  assert.deepEqual(traced.addedPart({ type: 'LineString' }), {}, "a line added keeps the map's defaults");
  const { newPlaces } = traced.newPlacesOf([label, main], { settingsOf, contributor: who, version: '0.9.0-test' });
  assert.equal(newPlaces.length, 1, 'one place');
  const a = newPlaces[0].attestations[0];
  assert.equal(newPlaces[0].attestations.length, 1, 'one attestation');
  assert.deepEqual(a.geometries.map((g) => g.role), ['https://w3id.org/plato#RepresentativePoint', 'https://w3id.org/plato#LabelAnchor'], 'the one it was named from first');
  assert.equal(a.geometries[1].spatialPrecision, undefined, "a label's position says nothing of how well the place is known");
  assert.equal(a.citations.filter((c) => c.citationFunction.endsWith('citesAsEvidence')).length, 2);
  assert.equal(checkAddition(a, res.validators), null);
  golden('label', a);
});

test('a feature not yet named is not saved, but said; one drawn on the basemap carries Chora\'s drawing note; an uncertainty radius of the user\'s is said to be theirs', async () => {
  const s = settings('rocque', rocque.title, { precisionKm: '2.5' });
  assert.equal(s.precisionKm, 2.5);
  const d = await draft(rocque, 'rocque', [[5000, 4000]], { placeId: null, s });
  const plain = { id: 'b1', kind: 'feature', placeId: 'https://example.org/traced/place/b', placeLabel: 'B', names: [{ toponym: 'B' }], types: [], mapKey: 'rocque', geojson: { type: 'Point', coordinates: [-80, 40] }, ...traced.featureDefaults(s, { type: 'Point' }), trace: null, zoom: 7, basemap: 'Natural Earth', drawnAt: WHEN };
  const { newPlaces, unnamed } = traced.newPlacesOf([d, plain], { settingsOf: () => s, contributor: who });
  assert.deepEqual(unnamed.map((x) => x.id), [d.id]);
  assert.equal(newPlaces.length, 1);
  const a = newPlaces[0].attestations[0];
  assert.equal(a.citations, undefined, 'drawn on the basemap: no map cited');
  assert.match(a.notes, /^Drawn by hand on the Natural Earth basemap at zoom 7 in PLATO tools \(Chora\)\. /);
  assert.match(a.notes, /Its uncertainty radius \(2\.5 km\) is the tracer's own estimate for this map, not computed\.$/);
  assert.deepEqual(a.geometries[0].precisionKm, [2.5]);
  assert.equal(checkAddition(a, res.validators), null);
});

test('a map\'s settings: the base address needed, a bad language or radius refused in words; the date pre-filled from the navDate; what is kept read back checked', () => {
  const was = traced.defaultSettings({ key: 'k', title: 'A map', manifest: { navDate: '1764-01-01T00:00:00Z' }, rights: null, base: '' });
  assert.equal(was.date, '1764');
  assert.equal(was.datasetTitle, 'Places traced from A map');
  assert.deepEqual(was.defaults, { point: { ...TRACED_DEFAULTS.point }, line: { ...TRACED_DEFAULTS.line }, area: { ...TRACED_DEFAULTS.area } });
  assert.match(traced.settingsFrom({ base: '' }, was).error, /Give the base address/);
  assert.match(traced.settingsFrom({ base: 'https://example.org/x', language: 'not one!' }, was).error, /not a language code/);
  assert.match(traced.settingsFrom({ base: 'https://example.org/x', precisionKm: '-1' }, was).error, /kilometres/);
  const ok = traced.settingsFrom({ base: 'https://example.org/x', language: 'grc', script: 'Grek', lineRole: 'Itinerary', outline: false }, was).settings;
  assert.equal(ok.base, 'https://example.org/x/'); assert.equal(ok.script, 'Grek'); assert.equal(ok.defaults.line.role, 'Itinerary'); assert.equal(ok.outline, false);
  assert.equal(traced.settingsFrom({ base: 'https://example.org/x', language: 'en', script: 'Grek' }, was).settings.script, '', 'no script asked for a language written in Latin');
  // What is kept, read back: junk dropped, each map's settings checked.
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  try {
    store.set('chora-trace', JSON.stringify({ maps: { k: { ...ok, defaults: { point: { role: 'Nonsense' } } }, bad: 'x' }, seeds: { k: { name: 'a.json', text: '{}', lastModified: 1 }, j: { name: 3 } }, open: { fp: 'k', x: 4 }, current: 'k' }));
    const t = traced.loadTracing();
    assert.deepEqual(Object.keys(t.maps), ['k']); assert.equal(t.maps.k.defaults.point.role, TRACED_DEFAULTS.point.role);
    assert.deepEqual(Object.keys(t.seeds), ['k']); assert.deepEqual(t.open, { fp: 'k' }); assert.equal(t.current, 'k');
    traced.forgetTracing();
    assert.deepEqual(traced.loadTracing(), { maps: {}, seeds: {}, open: {}, current: null });
  } finally { delete globalThis.localStorage; }
  // The seed made from the settings: the map's title and the base; the map's licence is not the dataset's (decision 10).
  const seed = JSON.parse(traced.seedFile({ ...ok, mapTitle: 'A map', licence: 'https://creativecommons.org/licenses/by-nc-sa/3.0/' }, { now: 5 }).text);
  assert.equal(seed.gazetteer.uriSpace, 'https://example.org/x/'); assert.equal(seed.gazetteer.licence, undefined);
  assert.equal(seed.gazetteer.title, ok.datasetTitle);
});

test('a feature with a part over another sheet: each map cited with its own credit and date, never the first sheet\'s; with no settings for that sheet, none', async () => {
  const dominions = await georef.readGeoreference(fx('test/fixtures/georef/bpl-british-dominions-annotation.json'), { manifest: fx('test/fixtures/georef/bpl-british-dominions-manifest.json') });
  const id = 'https://example.org/traced/place/two-sheets';
  const main = await draft(rocque, 'rocque', [[7340, 2890]], { placeId: id, label: 'Two sheets', names: [traced.nameOf({ toponym: 'Two sheets' })], s: S.rocque });
  const other = await draft(dominions, 'dom', [[3000, 2000]], { placeId: id, label: 'Two sheets', part: true, s: S.rocque });
  const B = settings('dom', dominions.title, { date: '1820' }, { rights: 'https://creativecommons.org/publicdomain/mark/1.0/', attribution: 'The second sheet\'s credit' });
  const cites = (settingsOf) => traced.newPlacesOf([main, other], { settingsOf, contributor: who }).newPlaces[0].attestations[0].citations.filter((c) => c.citationFunction.endsWith('citesAsEvidence'));
  const onlyA = cites((k) => (k === 'rocque' ? S.rocque : null));
  assert.equal(onlyA.length, 2);
  const [a, b] = onlyA;
  assert.equal(a.source.citation, ROCQUE_M.attribution); assert.equal(a.source.timespan.sourceLabel, '[ca. 1764]');
  assert.notEqual(b.source['@id'], a.source['@id'], 'the second part is on the other sheet');
  assert.equal(b.source.citation, undefined, "no credit for a sheet whose settings are not given, never the first sheet's");
  assert.equal(b.source.timespan, undefined);
  const both = cites((k) => (k === 'rocque' ? S.rocque : k === 'dom' ? B : null));
  assert.equal(both[1].source.citation, "The second sheet's credit");
  assert.deepEqual(both[1].source.timespan, { startEarliest: '1820', endLatest: '1820', sourceLabel: '1820' });
  assert.equal(both[0].source.citation, ROCQUE_M.attribution);
});
