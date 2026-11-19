// The map's words (Chora's) are plain in themselves, in a scholar-facing workflow or not (November 2026): its panel, the
// place's card, the gazetteer search, tracing, the save and what is said when something fails. In the manner of
// test/plain-panels.test.js: every word table the map shows is held to say no expert's word, and beside each such absence
// the same search is shown to find one where it is meant to be: in the notes the map writes into a dataset, which are not
// changed (a note is part of the record, and names the tool that made it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHORA_ADOPT_PAGE, CHORA_ADOPT_TEXT, CHORA_TRACE, CHORA_TEXT, CHORA_HANDOVER, CHORA_GEOREF_REASON, NO_WEBGL, choraSaveText, choraSaveProgress, choraStorageWarning,
  choraDrawingNote, choraTracingNote, choraAdoptIdentityNote } from '../src/engine/words.js';
import { CARD_SAID, PLAIN_ADOPT } from '../src/engine/plain-panels.js';
import { CATEGORY_WORDS, REMEMBERED_BASEMAP, REMEMBERED, RELOAD_LOSES, PANEL } from '../src/lib/permission-words.js';
import { shapeWord, SHAPE_WORDS, geometryItem, timeline } from '../src/chora/card.js';
import { pickerForm, pickerStatus } from '../src/chora/overlays.js';

const src = (name) => readFileSync(new URL(`../src/chora/${name}`, import.meta.url), 'utf8');
// What a historian who is not a developer is not to be shown by the map: the model's nouns and property names, the tools'
// Greek names, and the programmer's words for a background map, a shape and a browser's storage.
const EXPERT = /attestation|\bIRIs?\b|@id|\bOPFS\b|N-Triples|LabelAnchor|basemap|identit(y|ies)\b|candidate|\badopt|geometr(y|ies)|\bvert(ex|ices)\b|navDate|place-centric|LineString|Polygon|\bCORS\b|IIIF Auth|quer(y|ies)\b/i;
const GREEK = /Methodos|Hermes|Elenchos|Metaphrasis|Arithmos|Krisis|Chora|Agora|Mneme/;
// Every string a table of words can say: its functions are called with something of each shape they take.
const ARGS = [['Rocque 1746', 'Places of London', 3, 1], [3, 1, 12], [{ lang: 'la', labels: ['Lancashire'], ids: ['gn:2644974'], countries: ['GB'] }], ['related'], [1], ['CC-BY-NC-4.0']];
function said(words) {
  const out = [];
  for (const v of Object.values(words)) {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'function') { for (const a of ARGS) { try { const s = v(...a); if (typeof s === 'string') out.push(s); } catch { /* not its shape */ } } }
    else if (v && typeof v === 'object') out.push(...said(v));
  }
  return out;
}
const saved = (n, p = 0, passed = true) => ({ mneme: { passed }, report: { counts: { 'attestations added': n, 'places added': p } } });
// The notes the map writes into a dataset, as they were: the control of every absence below, and themselves held unchanged.
const WRITTEN = [choraDrawingNote({ zoom: 9 }), choraTracingNote({ zoom: 9 }), choraAdoptIdentityNote({ id: 'whg:1', title: 'Newcastle' })];

test('no table of the map\'s words says an expert\'s word or a tool\'s Greek name; the notes written into a dataset, which are not changed, do', () => {
  const tables = { 'the gazetteer search': CHORA_ADOPT_PAGE, 'what using a record says': CHORA_ADOPT_TEXT, tracing: CHORA_TRACE, 'the save': CHORA_TEXT, 'the hand-over': CHORA_HANDOVER, 'the card': CARD_SAID,
    'in a workflow': PLAIN_ADOPT, 'a remembered background map': REMEMBERED_BASEMAP, 'the permission': { ...CATEGORY_WORDS.basemap, a: REMEMBERED['chora-contributor'].label, b: REMEMBERED['chora-basemaps'].label, c: RELOAD_LOSES.pasted },
    'one-liners': { NO_WEBGL, CHORA_GEOREF_REASON, a: choraSaveText(saved(3, 1)), b: choraSaveText(saved(1)), c: choraSaveText(saved(1, 0, false)), d: choraStorageWarning('load', { need: 5e6, free: 1e6, quota: 1e7 }), e: choraStorageWarning('save', { need: 5e6, free: 1e6, quota: 1e7 }),
      f: choraSaveProgress({ save: 'writing', attestations: 7, total: 9, elapsedMs: 0 }), g: choraSaveProgress({ save: 'checking', phase: 'comparing', elapsedMs: 0 }), h: choraSaveProgress({ save: 'finding', places: 4, elapsedMs: 0 }) } };
  let examined = 0;
  for (const [name, words] of Object.entries(tables)) {
    const strings = said(words);
    assert.ok(strings.length >= 2, `${name}: ${strings.length} strings examined`);
    examined += strings.length;
    for (const s of strings) { assert.doesNotMatch(s, EXPERT, `${name}: ${s}`); assert.doesNotMatch(s, GREEK, `${name}: ${s}`); }
  }
  assert.ok(examined >= 200, `${examined} strings examined`);
  // The control: the same two searches find such words where they are meant to stay.
  assert.match(WRITTEN[0], EXPERT); assert.match(WRITTEN[0], GREEK); assert.match(WRITTEN[2], GREEK);
  assert.equal(WRITTEN[0], 'Drawn by hand on the Natural Earth basemap at zoom 9 in PLATO tools (Chora)');
  assert.equal(WRITTEN[1], 'Traced by hand from a georeferenced historical map at zoom 9 in PLATO tools (Chora).');
  // A term that must stay, because it is what is typed into a file, is said once and with what it is.
  const names = said(CHORA_TRACE).filter((s) => /uriSpace|base_uri/.test(s));
  assert.ok(names.length >= 1);
  for (const s of names) assert.match(s, /does not say under what web address its places are published, .* Give the dataset that address \(in its file: uriSpace in PLATO JSON, or base_uri on a spreadsheet's about sheet\)/);
  assert.equal(Object.values(CHORA_TRACE).filter((v) => /uriSpace|base_uri/.test(String(v))).length, 1, 'said in one place only');
  assert.match(PANEL.keepWorkNote, /^The map keeps the dataset you opened, .* they are cleared when you next open the map,/);
});

test('the save in plain words: statements about your places, and the version check by what it does', () => {
  assert.equal(choraSaveText(saved(3, 1)), 'Saved, with 3 new statements about your places and 1 new place; the version check confirms that everything the dataset said before is there as it was.');
  assert.equal(choraSaveText(saved(1)), 'Saved, with 1 new statement about your places; the version check confirms that everything the dataset said before is there as it was.');
  assert.equal(choraSaveText(saved(1, 0, false)), CHORA_TEXT['chora-mneme-failed']);
  assert.match(CHORA_TEXT['chora-mneme-failed'], /^The version check found that the saved file does not keep everything the dataset said exactly as it was/);
  assert.equal(choraSaveText({}), 'Nothing was saved.');
  assert.equal(CHORA_TEXT['chora-in-another-tab'], 'The map is already open in another tab of this browser. Close it, or use that one.');
  assert.equal(choraSaveProgress({ save: 'checking', version: 'later', phase: 'reading', attestations: 1, elapsedMs: 0 }), 'Saving, step 2 of 2, the version check, reading the file written: 1 statement (0 s)');
  assert.match(choraStorageWarning('load', { need: 5e6, free: 1e6, quota: 1e7 }), /for the map's working copy of it/);
});

test('the gazetteer search and tracing in plain words: a web address, a suggestion, a match; the field named as Options names it', () => {
  assert.match(CHORA_ADOPT_PAGE.noAddress, /^This place has no web address of its own in your data yet/);
  assert.match(CHORA_ADOPT_TEXT['no-address'], /^This place has no web address of its own in the dataset/);
  assert.equal(CHORA_ADOPT_PAGE.none, 'The gazetteer found nothing of that name.');
  assert.equal(CHORA_ADOPT_PAGE.dismissed(1), 'One suggestion set aside as not this one, for this visit only.');
  assert.equal(CHORA_ADOPT_PAGE.dismissed(3), '3 suggestions set aside as not this one, for this visit only.');
  assert.equal(CHORA_ADOPT_PAGE.adopt, 'Use it: this place is that record, and is located there');
  assert.equal(CHORA_ADOPT_PAGE.pendingItem('Newcastle'), 'Location taken from Newcastle');
  assert.equal(CHORA_ADOPT_TEXT['no-geometry'], "There is no location to use: choose one of the record's locations.");
  assert.match(CHORA_ADOPT_TEXT.denied, /review the matches again, under “Find in gazetteers”\.$/);
  assert.equal(CHORA_TRACE.baseQuestion, 'Web address for your identifiers: your places will have their web addresses under it');
  assert.match(CHORA_TRACE.baseHelp, /It is the “Web address for your identifiers” in Options, which this changes too\.$/);
  // The field is so named in Options (index.html), so the words lead to it.
  assert.ok(readFileSync(new URL('../index.html', import.meta.url), 'utf8').includes('Web address for your identifiers'));
  assert.equal(CHORA_TRACE.notTraced, 'drawn on the background map, not traced from the map');
  assert.match(NO_WEBGL, /it needs the browser’s 3D graphics \(WebGL\), which this browser or window has turned off/);
  assert.match(CHORA_GEOREF_REASON, /^This file is a georeference, not a dataset: it records where a scanned historical map sits on the modern map \(a IIIF Georeference Annotation\)\./);
});

test('a location\'s shape is named in ordinary words on the card: a line and an area, not a LineString and a MultiPolygon', () => {
  assert.deepEqual(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'].map(shapeWord), ['Point', 'Points', 'Line', 'Lines', 'Area', 'Areas', 'Several shapes']);
  assert.equal(shapeWord('Curve'), 'Curve', 'a shape of another kind is named as given');
  assert.equal(shapeWord(undefined), '');
  for (const w of Object.values(SHAPE_WORDS)) assert.doesNotMatch(w, EXPERT);
  const line = geometryItem({ geojson: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, role: 'https://w3id.org/plato#Itinerary' });
  assert.match(line, /^Line, a route/);
  assert.doesNotMatch(line, /LineString/);
  assert.match(geometryItem({ geojson: { type: 'MultiPolygon', coordinates: [] } }), /^Areas/);
  const bars = timeline([{ facet: 'name', text: 'Eboracum', start: '0071', end: '0400', status: 'asserted' }]);
  assert.match(bars, /aria-label="When each statement about the place applies or was made, from 71 to 400"/);
  assert.doesNotMatch(bars, /attestation/);
});

test('the map\'s own page says a background map, a point of a line, and what a georeference is; the tools\' Greek names are not in what it shows', () => {
  const app = src('app.js'), page = app.slice(app.indexOf('const html = () => `'), app.indexOf('let root = null;'));
  assert.ok(page.length > 3000, 'the page\'s template was found');
  assert.ok(page.includes('<summary>Background map: <span id="chora-basemap-name">'));
  assert.ok(page.includes('The map needs a georeference: a record of where it sits on the modern map.'));
  assert.ok(page.includes('data-tip="Draw a line: click each point along it, and click the last one again to finish"'));
  // Its visible text (the tags, with their ids and classes, taken out) says no expert's word; with them in, the same search finds one, in an id.
  const visible = page.replace(/\$\{[^}]*\}/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*?(?:(?:aria-label|data-tip|placeholder)="([^"]*)")?[^>]*>/g, ' $1 ');
  assert.match(visible, /Background map:/);
  assert.doesNotMatch(visible, EXPERT); assert.doesNotMatch(visible, GREEK);
  assert.match(page, /basemap/);
  // Elsewhere in the map's modules, each phrase replaced is gone and its plain form is there.
  for (const [file, gone, there] of [
    ['app.js', 'Check it with Elenchos', '<a href="#tool=check">Check the dataset</a> to see them.'],
    ['app.js', 'the identity and the location', "'the match and the location'"],
    ['app.js', 'Paste a style address or a tile template', 'Add another background map: paste the web address of its style, or of its tiles (with {z}/{x}/{y} in it)'],
    ['app.js', '(place-centric)', '(written place by place)'],
    ['export-ui.js', 'Drawn as vectors', 'Drawn as lines and shapes, which stay sharp at any size.'],
    ['export-ui.js', "Chora's contributor", 'the name the map keeps in this browser'],
    ['export-ui.js', '>the basemap<', '>the background map</option>'],
    ['inkfetch.js', 'CORS)', '(it allows no other site to read them)'],
    ['basemaps.js', 'needs an API key', 'not set up on this site: it needs a key from CARTO'],
    ['basemaps.js', 'Natural Earth basemap could not', 'The Natural Earth background map could not be read'],
    ['inkfetch.js', 'IIIF Auth', 'Maps that need a login cannot be traced here'],
  ]) { const s = src(file); assert.ok(!s.includes(gone), `${file} still says “${gone}”`); assert.ok(s.includes(there), `${file} does not say “${there}”`); }
});

test('the box for a historical map says what may be pasted, each thing with what it is; a choice of georeferences says how each was placed', () => {
  const form = pickerForm('chora');
  assert.match(form, /<label for="chora-map-input">Paste a georeference of the map \(a IIIF Georeference Annotation\), or a web address: of a georeference \(from Allmaps\), or of the map as its library publishes it \(a IIIF manifest or image\)<\/label>/);
  const choice = pickerStatus({ choice: { chosen: 0, choices: [{ index: 0, label: 'A', modified: '2026-10-01T00:00:00Z', gcps: 12, id: null }, { index: 1, label: '', modified: null, gcps: null, id: null }, { index: 2, label: '', modified: null, gcps: 1, id: null }] } });
  assert.match(choice, /Georeference 1: A <span class="muted">\(changed 2026-10-01, placed by 12 matched points\)<\/span>/);
  assert.match(choice, /Georeference 2 <span class="muted">\(no date given, its matched points not given\)<\/span>/);
  assert.match(choice, /placed by 1 matched point\)/);
  assert.doesNotMatch(choice, /control point/);
});
