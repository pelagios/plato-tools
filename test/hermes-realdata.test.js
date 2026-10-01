// What reading real editions found (I.Sicily, Schnitzler's letters, EHRI's editions, IIP), each fixed
// and tested here: on a small trimmed excerpt of the real file where its licence allows (each named,
// with its commit and licence, in test/fixtures/tei/README.md, and kept in test/fixtures/tei/excerpts/), else on a constructed equivalent.
// Every test of an absence has a presence beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { teiToDocument, TEI_KINDS, parseGeo, setEditorialIriForTests } from '../src/engine/hermes/tei.js';
import { LOSS_TEXT } from '../src/engine/report.js';

const DIR = 'test/fixtures/tei/excerpts/';
const text = (f) => readFileSync(DIR + f, 'utf8');
function mapped(s, options = {}, name = 'test.xml') {
  const reported = [];
  const doc = teiToDocument(s, name, (kind, example) => reported.push([kind, example]), options);
  return { doc, reported, kinds: new Set(reported.map(([k]) => k)) };
}
const examples = (m, kind) => m.reported.filter(([k]) => k === kind).map(([, e]) => e);
const HEADER = '<teiHeader><fileDesc><titleStmt><title>T</title></titleStmt><publicationStmt><idno type="URI">https://example.org/e</idno></publicationStmt><sourceDesc><p>x</p></sourceDesc></fileDesc></teiHeader>';
const tei = (body, header = HEADER) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<TEI xmlns="http://www.tei-c.org/ns/1.0">${header}<text><body>${body}</body></text></TEI>\n`;

// ---- <geo> with a comma for each decimal point (Schnitzler) -------------------------------------------
test('a <geo> with a comma for each decimal point and a space between is read; a dot decimal and a comma separator still is; anything ambiguous is not', () => {
  assert.deepEqual(parseGeo('48,177598 16,329723'), { lat: 48.177598, lon: 16.329723 });
  assert.deepEqual(parseGeo('-33,86 151,21'), { lat: -33.86, lon: 151.21 });
  // controls: the forms read before are read as before
  assert.deepEqual(parseGeo('37.08415, 15.27628'), { lat: 37.08415, lon: 15.27628 });
  assert.deepEqual(parseGeo('37.97 23.72'), { lat: 37.97, lon: 23.72 });
  assert.deepEqual(parseGeo('37,15'), { lat: 37, lon: 15 }, 'two whole numbers and a comma: a separator, as before');
  for (const g of ['48,1,16,3', '48,1 16', '48 16,3', '48,1, 16,3', '48,1  16,3,4', '48,177598 196,329723', 'somewhere', ''])
    assert.equal(parseGeo(g), null, g);
});

// ---- a listed place's own location (Schnitzler's listplace.xml) ---------------------------------------
const SCHNITZLER = 'schnitzler-listplace-pmb365563.xml';
test('Schnitzler: a listed place\'s own <location> is read, and the locations of the places it is in are skipped and reported', () => {
  const m = mapped(text(SCHNITZLER), { listPlaces: true }, SCHNITZLER);
  assert.equal(m.doc.attestations.length, 1);
  const [a] = m.doc.attestations;
  assert.equal(a.about, 'https://pmb.acdh.oeaw.ac.at/entity/365563/');
  assert.deepEqual(a.names, [{ toponym: 'Meidlinger Hauptstraße 56' }]);
  // The edition's own address is on id.acdh.oeaw.ac.at, PMB's on pmb.acdh.oeaw.ac.at: its own point
  // only (comma decimals read) is the one considered, and reported as a gazetteer's.
  assert.deepEqual(examples(m, 'tei-listplace-geo-gazetteer'), ['#pmb365563: 48,177598 16,329723 (https://pmb.acdh.oeaw.ac.at/entity/365563/)']);
  assert.deepEqual(examples(m, 'tei-listplace-geo-other-place'), [
    '#pmb365563: located_in_place: XII., Meidling (48,17192 16,32586)',
    '#pmb365563: located_in_place: Meidlinger Hauptstraße (48,178825 16,329918)',
  ]);
  // the parent places' names are not this place's variants, and nothing is invalid
  assert.ok(!m.kinds.has('tei-listplace-variant'), JSON.stringify(examples(m, 'tei-listplace-variant')));
  assert.ok(!m.kinds.has('tei-listplace-geo-invalid'), JSON.stringify(examples(m, 'tei-listplace-geo-invalid')));
  // The same entry, the edition's address put on PMB's host (changed here, not in the fixture): its own point is carried, and only it.
  const own = mapped(text(SCHNITZLER).replace('https://id.acdh.oeaw.ac.at/arthur-schnitzler-briefe/v1/indices/listPlace', 'https://pmb.acdh.oeaw.ac.at/'), { listPlaces: true }, SCHNITZLER);
  assert.deepEqual(own.doc.attestations[0].geometries, [{ reprPoint: [16.329723, 48.177598], geojson: { type: 'Point', coordinates: [16.329723, 48.177598] }, sourceLabel: '48,177598 16,329723' }]);
  assert.equal(TEI_KINDS['tei-listplace-geo-other-place'], 'loss');
  assert.match(LOSS_TEXT['tei-listplace-geo-other-place'], /located_in_place/);
});

test('a listed place with a variant name as its own child still reports it; a location with no type, or type="coords", is its own', () => {
  const s = tei('<p>x</p>').replace('</body>', '</body><back><listPlace><place xml:id="a"><placeName>Main</placeName><placeName>Other</placeName><idno type="URI">https://example.org/places/a</idno><location><geo>1 2</geo></location><location type="coords"><geo>3 4</geo></location><location type="located_in_place"><placeName>Parent</placeName><geo>5 6</geo></location></place></listPlace></back>');
  const m = mapped(s, { listPlaces: true });
  assert.deepEqual(examples(m, 'tei-listplace-variant'), ['#a: Other']);
  assert.deepEqual(m.doc.attestations[0].geometries.map((g) => g.reprPoint), [[2, 1], [4, 3]]);
  assert.deepEqual(examples(m, 'tei-listplace-geo-other-place'), ['#a: located_in_place: Parent (5 6)']);
});
