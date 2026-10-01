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

// ---- words inside a place name that are not the name (IIP-like; IIP is CC BY-NC, so constructed) ------
test('a <geo>, <location>, <idno> or <note> inside a place name is left out of the name; a <geo> in the text is reported once as tei-place-geo', () => {
  // An equivalent of what IIP writes (a <geo> inside the place name), constructed, not copied.
  const m = mapped(tei('<p><placeName ref="https://pleiades.stoa.org/places/687966">Beth Loya<geo>31.563611,34.928056</geo></placeName> and '
    + '<placeName ref="https://pleiades.stoa.org/places/678006">Gaza<location><geo>31.5 34.46</geo></location><idno type="URI">https://example.org/gaza</idno><note>the port</note></placeName></p>'));
  assert.deepEqual(m.doc.attestations.map((a) => a.names[0].toponym), ['Beth Loya', 'Gaza']);
  assert.deepEqual(examples(m, 'tei-place-geo'), ['31.563611,34.928056 on line 2', '31.5 34.46 on line 2']);
  // control: the words of a place name around other markup (a <choice>, an <hi>) are still the name
  const c = mapped(tei('<p><placeName ref="https://pleiades.stoa.org/places/687966">Beth <hi>Loya</hi></placeName></p>'));
  assert.deepEqual(c.doc.attestations.map((a) => a.names[0].toponym), ['Beth Loya']);
  assert.ok(!c.kinds.has('tei-place-geo'));
  assert.equal(TEI_KINDS['tei-place-geo'], 'loss');
  assert.ok(LOSS_TEXT['tei-place-geo']);
});

test('a listed place\'s <location> words still hold its <geo> (the place name rule does not reach a list of places)', () => {
  const s = tei('<p>x</p>').replace('</body>', '</body><back><listPlace><place xml:id="a"><placeName>A</placeName><location><geo>1 2</geo></location></place></listPlace></back>');
  assert.deepEqual(examples(mapped(s), 'tei-listplace-geo'), ['#a: 1 2']);
});

// ---- places in the header: findspot only for a provenance that says found (I.Sicily) --------------------
const EDITORIAL = 'https://w3id.org/plato#Editorial';
function withEditorial(fn) { const was = setEditorialIriForTests(EDITORIAL); try { return fn(); } finally { setEditorialIriForTests(was); } }
const FINDSPOT_OF = 'https://w3id.org/plato#FindspotOf';
const ISIC_FIRST_SEEN = 'isicily-ISic030001-header.xml';
const ISIC_FOUND = readFileSync('test/fixtures/tei/isicily-ISic000934.xml', 'utf8');

test('I.Sicily ISic030001: a provenance type="found" subtype="first-seen" (the Ragusa museum) is a plain attestation with a note, not a findspot; reported', () => withEditorial(() => {
  const m = mapped(text(ISIC_FIRST_SEEN), { headerPlaces: true }, ISIC_FIRST_SEEN);
  const ragusa = m.doc.attestations.find((a) => a.names[0].toponym === 'Ragusa');
  assert.ok(ragusa, JSON.stringify(m.doc.attestations.map((a) => a.names[0].toponym)));
  assert.equal(ragusa.about, 'https://sws.geonames.org/2523650/');
  assert.equal(ragusa.relations, undefined);
  assert.equal(ragusa.citations[0].locator, 'teiHeader, provenance (found, first-seen)');
  assert.match(ragusa.notes, /subtype "first-seen", which says where the object was seen or kept, not where it was found/);
  assert.equal(ragusa.formStatus, EDITORIAL);
  assert.deepEqual(examples(m, 'tei-provenance-other'), ['Ragusa (http://www.geonames.org/2523650/ragusa.html): subtype "first-seen"']);
  // the origin is read as before, and its <geo> is reported, not dropped unsaid
  assert.deepEqual(m.doc.attestations.filter((a) => a.citations[0].locator === 'teiHeader, origin').map((a) => a.names[0].toponym), ['Morgantina', 'Aidone']);
  assert.deepEqual(examples(m, 'tei-header-geo'), ['origin: 37.43067, 14.47945 on line 41']);
  assert.equal(TEI_KINDS['tei-provenance-other'], 'loss');
  assert.equal(TEI_KINDS['tei-header-geo'], 'loss');
}));

test('I.Sicily ISic000934 (control): a provenance type="found" subtype="discovered" is the findspot, with FindspotOf; its <geo> is reported', () => withEditorial(() => {
  const m = mapped(ISIC_FOUND, { headerPlaces: true });
  const found = m.doc.attestations.filter((a) => a.citations[0].locator === 'teiHeader, provenance (found)');
  assert.deepEqual(found.map((a) => [a.about, a.relations?.[0]?.relationType]), [['https://pleiades.stoa.org/places/560149180', FINDSPOT_OF]]);
  assert.ok(!m.kinds.has('tei-provenance-other'));
  assert.deepEqual(examples(m, 'tei-header-geo'), ['origin: 37.08415, 15.27628 on line 102', 'provenance (found, discovered): 37.0767995, 15.2848558 on line 106']);
}));

test('a provenance type="found" with no subtype is the findspot; with subtype "first-recorded" or "transferred" it is not', () => withEditorial(() => {
  const header = (prov) => `<teiHeader><fileDesc><titleStmt><title>Stone</title></titleStmt><publicationStmt><idno type="URI">https://example.org/stone</idno></publicationStmt><sourceDesc><msDesc><msIdentifier><idno>1</idno></msIdentifier><history>${prov}</history></msDesc></sourceDesc></fileDesc></teiHeader>`;
  const at = (prov) => mapped(tei('<div type="edition"><p>x</p></div>', header(prov)), { headerPlaces: true });
  const plain = at('<provenance type="found">At <placeName ref="https://pleiades.stoa.org/places/462503">Syracusae</placeName></provenance>');
  assert.deepEqual(plain.doc.attestations.map((a) => a.relations?.[0]?.relationType), [FINDSPOT_OF]);
  for (const sub of ['first-recorded', 'transferred']) {
    const other = at(`<provenance type="found" subtype="${sub}">At <placeName ref="https://pleiades.stoa.org/places/462503">Syracusae</placeName></provenance>`);
    assert.deepEqual(other.doc.attestations.map((a) => a.relations), [undefined], sub);
    assert.deepEqual(examples(other, 'tei-provenance-other'), [`Syracusae (https://pleiades.stoa.org/places/462503): subtype "${sub}"`]);
  }
}));

test('without header places, the header\'s findspot and origin <geo> are still reported, beside its place names', () => {
  const m = mapped(text(ISIC_FIRST_SEEN), {}, ISIC_FIRST_SEEN);
  assert.deepEqual(examples(m, 'tei-header-geo'), ['origin: 37.43067, 14.47945 on line 41']);
  assert.ok(m.kinds.has('tei-place-outside-text'));
});

// ---- EHRI: a place's gazetteer links in <linkGrp><link> ------------------------------------------------
// EHRI's only files with these (The Sunflower) are CC BY-NC-SA 4.0, so this is a constructed equivalent
// of their listPlace in the teiHeader's sourceDesc (EHRI-TS-19580908-A_EN.xml has the same shape).
const EHRI_LIKE = (placeBody) => `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt><title>A letter</title></titleStmt><publicationStmt><idno type="URI">https://example.org/letter</idno></publicationStmt><sourceDesc><listPlace>
<place xml:id="ehri_haifa"><placeName>Haifa</placeName><location><geo>32.81841 34.9885</geo></location>${placeBody}</place>
<place xml:id="ehri_camp"><placeName>A camp</placeName><linkGrp><link type="normal" target="https://portal.ehri-project.eu/keywords/ehri_camps-1"/></linkGrp></place>
<place xml:id="self"><placeName>no place</placeName><linkGrp><link type="normal" target="#self"/></linkGrp></place>
</listPlace></sourceDesc></fileDesc></teiHeader><text><body><p>To <placeName ref="#ehri_haifa">Haifa</placeName> and <placeName ref="#ehri_camp">the camp</placeName>.</p></body></text></TEI>
`;
test('EHRI-like: a <place>\'s <linkGrp><link type="normal"> web targets are read as its idnos, and the linkGrp is no longer reported as unknown', () => {
  const m = mapped(EHRI_LIKE('<linkGrp><link type="normal" target="https://www.geonames.org/294801/haifa.html"/><link type="desc" target="https://en.wikipedia.org/wiki/Haifa"/></linkGrp>'), { listPlaces: true });
  const text = m.doc.attestations.filter((a) => a.formStatus === 'https://w3id.org/plato#Attested');
  assert.deepEqual(text.map((a) => a.about), ['https://sws.geonames.org/294801/', 'https://portal.ehri-project.eu/keywords/ehri_camps-1']);
  assert.match(text[0].notes, /Place address given as https:\/\/www\.geonames\.org\/294801\/haifa\.html \(rule geonames-page/);
  const listed = m.doc.attestations.filter((a) => a.formStatus === 'https://w3id.org/plato#Headword');
  assert.deepEqual(listed.map((a) => a.about), ['https://sws.geonames.org/294801/', 'https://portal.ehri-project.eu/keywords/ehri_camps-1']);
  const content = examples(m, 'tei-place-content');
  assert.ok(!content.some((e) => /<linkGrp>$/.test(e)), JSON.stringify(content));
  assert.deepEqual(content, ['#ehri_haifa: <link type="desc"> https://en.wikipedia.org/wiki/Haifa', '#self: <link target="#self">']);
  // control: the same place with its address in an <idno> gives the same attestations
  const c = mapped(EHRI_LIKE('<idno type="URI">https://www.geonames.org/294801/haifa.html</idno>'), { listPlaces: true });
  assert.deepEqual(c.doc.attestations.map((a) => a.about), m.doc.attestations.map((a) => a.about));
});

test('EHRI-like: two different gazetteer links in one linkGrp make the place ambiguous, as two idnos do', () => {
  const m = mapped(EHRI_LIKE('<linkGrp><link type="normal" target="https://www.geonames.org/294801/haifa.html https://www.wikidata.org/wiki/Q41621"/></linkGrp>'));
  assert.deepEqual(examples(m, 'tei-ref-ambiguous'), ['#ehri_haifa: https://sws.geonames.org/294801/, http://www.wikidata.org/entity/Q41621']);
  assert.deepEqual(m.doc.attestations.map((a) => a.about), ['https://portal.ehri-project.eu/keywords/ehri_camps-1']);
});
