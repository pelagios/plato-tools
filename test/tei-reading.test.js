// The TEI reader's reading options and the editors' words (Hermes batch, step B: Q9, Q1, Q6, Q3).
// src/engine/hermes/tei.js; the fixtures are described in test/fixtures/tei/README.md. Each test of
// something absent has a control in the same test that something present was read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { addPlatoFormats, strictFormatLogger } from '../src/lib/formats.js';
import { teiToDocument, TeiReader, TEI_KINDS, EDITORIAL_IRI, setEditorialIriForTests, teiReadingRefusal, teiKeyPrefixes, splitKey } from '../src/engine/hermes/tei.js';
import { addressFromPattern, patternProblem } from '../src/engine/hermes/addresses.js';
import { DataError } from '../src/engine/input.js';
import { LOSS_TEXT } from '../src/engine/report.js';

const PLATO = 'https://w3id.org/plato#';
const EDITORIAL = PLATO + 'Editorial';
const DIR = 'test/fixtures/tei/';
const load = (f) => JSON.parse(readFileSync(`public/plato/${f}`, 'utf8'));
const ajv = addPlatoFormats(new Ajv2020({ strict: false, allErrors: true, logger: strictFormatLogger }));
ajv.addSchema(load('plato.schema.json'), 'https://w3id.org/plato/schemas/plato.schema.json');
ajv.addSchema(load('attestation-centric.schema.json'));
const AC = 'https://w3id.org/plato/schemas/attestation-centric.schema.json';
const valid = (doc) => { const v = ajv.getSchema(AC); return v(doc) ? null : v.errors.slice(0, 3); };
const text = (f) => readFileSync(DIR + f, 'utf8');
function mapped(s, options = {}, name = 'test.xml') {
  const reported = [];
  const doc = teiToDocument(s, name, (kind, example) => reported.push([kind, example]), options);
  return { doc, reported, kinds: new Set(reported.map(([k]) => k)) };
}
const examples = (m, kind) => m.reported.filter(([k]) => k === kind).map(([, e]) => e);
const names = (m) => m.doc.attestations.flatMap((a) => (a.names || []).map((n) => n.toponym));
const HEADER = '<teiHeader><fileDesc><titleStmt><title>T</title></titleStmt><publicationStmt><idno type="URI">https://example.org/e</idno></publicationStmt><sourceDesc><p>x</p></sourceDesc></fileDesc></teiHeader>';
const tei = (body, header = HEADER) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<TEI xmlns="http://www.tei-c.org/ns/1.0">${header}<text><body>${body}</body></text></TEI>\n`;
const pn = (id, n, extra = '') => `<placeName ref="https://pleiades.stoa.org/places/${id}"${extra}>${n}</placeName>`;
/** Run fn with the editors' form status set as if EDITORIAL_IRI were, and put it back. */
function withEditorial(fn) {
  const was = setEditorialIriForTests(EDITORIAL);
  try { return fn(); } finally { setEditorialIriForTests(was); }
}
const ISIC = 'isicily-ISic000934.xml';

// ---- Q9: the editors' parts of an edition ------------------------------------------------------
test('the editors\' form status is held: EDITORIAL_IRI is null, and the opt-ins are refused saying why', () => {
  assert.equal(EDITORIAL_IRI, null);
  for (const k of ['commentaryPlaces', 'headerPlaces']) {
    assert.throws(() => new TeiReader(() => {}, { [k]: true }), (e) => e instanceof DataError && /available once PLATO's Editorial form status is pinned/.test(e.message), k);
    assert.match(teiReadingRefusal({ [k]: true }), /available once PLATO's Editorial form status is pinned/);
  }
  // control: other options, and the held ones turned off, are taken
  assert.equal(teiReadingRefusal({ listPlaces: true, commentaryPlaces: false }), null);
  assert.ok(new TeiReader(() => {}, { listPlaces: true, commentaryPlaces: false }));
  withEditorial(() => assert.equal(teiReadingRefusal({ commentaryPlaces: true, headerPlaces: true }), null));
});

test('I.Sicily: with an edition div, the commentary\'s place name is reported as the editors\', not converted; the edition\'s is', () => {
  const m = mapped(text(ISIC), {}, ISIC);
  assert.deepEqual(names(m), ['Μάκρης κώμης'], 'the edition\'s name is converted (control)');
  assert.deepEqual(examples(m, 'tei-place-editorial'), ['commentary: Sarepta (https://pleiades.stoa.org/places/678374) on line 205']);
  assert.equal(TEI_KINDS['tei-place-editorial'], 'loss');
  assert.match(LOSS_TEXT['tei-place-editorial'], /editors' words/);
});

test('I.Sicily with commentaryPlaces (the form status set): the commentary\'s name is converted as the editors\' words, never with no formStatus', () => {
  withEditorial(() => {
    const m = mapped(text(ISIC), { commentaryPlaces: true }, ISIC);
    const [ed, com] = m.doc.attestations;
    assert.equal(ed.formStatus, PLATO + 'Attested');
    assert.deepEqual([com.names[0].toponym, com.formStatus, com.citations[0].locator], ['Sarepta', EDITORIAL, 'commentary']);
    assert.equal(com.notes, "The editors' words, not the source's.\nFrom TEI element <placeName> on line 205 of isicily-ISic000934.xml");
    assert.ok(!m.kinds.has('tei-place-editorial'));
    assert.equal(valid(m.doc), null);
  });
});

test('with an edition div: a translation, a top-level div with no type, and a note in the edition are the editors\'; a textpart is the edition', () => {
  const s = tei(`<div type="edition"><div type="textpart" subtype="face" n="a"><ab><lb n="1"/>${pn(1, 'Alpha')}<note>${pn(2, 'Beta')}</note></ab></div></div>`
    + `<div type="translation"><p>${pn(3, 'Gamma')}</p></div><div><p>${pn(4, 'Delta')}</p></div>`);
  const m = mapped(s);
  assert.deepEqual(names(m), ['Alpha']);
  assert.deepEqual(examples(m, 'tei-place-editorial'), [
    'note: Beta (https://pleiades.stoa.org/places/2) on line 2',
    'translation: Gamma (https://pleiades.stoa.org/places/3) on line 2',
    'div: Delta (https://pleiades.stoa.org/places/4) on line 2',
  ]);
  withEditorial(() => {
    const o = mapped(s, { commentaryPlaces: true });
    assert.deepEqual(o.doc.attestations.map((a) => [a.names[0].toponym, a.citations[0].locator, a.formStatus.replace(PLATO, '')]), [
      ['Alpha', 'edition, face a, line 1', 'Attested'],
      ['Beta', 'edition, face a, line 1, in a note', 'Editorial'],
      ['Gamma', 'translation', 'Editorial'],
      ['Delta', 'div', 'Editorial'],
    ]);
  });
});

test('a commentary BEFORE the edition div is held until the edition opens, then reported; the output keeps the file\'s order', () => {
  const s = tei(`<div type="commentary"><p>${pn(1, 'Early')}</p></div><div type="edition"><ab>${pn(2, 'Text')}</ab></div>`);
  const m = mapped(s);
  assert.deepEqual(names(m), ['Text']);
  assert.deepEqual(examples(m, 'tei-place-editorial'), ['commentary: Early (https://pleiades.stoa.org/places/1) on line 2']);
  withEditorial(() => assert.deepEqual(names(mapped(s, { commentaryPlaces: true })), ['Early', 'Text']));
  // the same, read a character at a time: nothing comes out until it is known whose words "Early" are
  const kinds = [];
  const r = new TeiReader((k) => kinds.push(k), { fileName: 't.xml' });
  const evs = [];
  for (const ch of s) evs.push(...r.write(ch));
  evs.push(...r.close());
  assert.deepEqual(evs.map((e) => e.type), ['header', 'attestation'], 'only events, never a place name still held');
  assert.equal(evs[1].value.names[0].toponym, 'Text');
  assert.ok(kinds.includes('tei-place-editorial'));
});

test('with no edition div, notes, commentary and translations are read as before, in the file\'s order', () => {
  const s = tei(`<div type="commentary"><p>${pn(1, 'One')}</p></div><div type="chapter"><p>${pn(2, 'Two')}<note>${pn(3, 'Three')}</note></p></div><div type="translation"><p>${pn(4, 'Four')}</p></div>`);
  const m = mapped(s);
  assert.deepEqual(names(m), ['One', 'Two', 'Three', 'Four']);
  assert.ok(!m.kinds.has('tei-place-editorial'));
  assert.ok(m.doc.attestations.every((a) => a.formStatus === PLATO + 'Attested'));
  // and the held events come out, in order, however the file is cut
  const r = new TeiReader(() => {}, { fileName: 't.xml' });
  const evs = [];
  for (let i = 0; i < s.length; i += 7) evs.push(...r.write(s.slice(i, i + 7)));
  evs.push(...r.close());
  assert.deepEqual(evs.filter((e) => e.type === 'attestation').map((e) => e.value.names[0].toponym), ['One', 'Two', 'Three', 'Four']);
  assert.equal(evs.filter((e) => e.type === 'header').length, 1);
});

// ---- Q1: places in a list of places ------------------------------------------------------------
const LIST = (places, header = HEADER) => tei(`<p>${pn(9, 'Text')}</p>`, header).replace('</body>', `</body><back><listPlace>${places}</listPlace></back>`);
const OWN = 'https://example.org/places/athens';

test('listPlaces off: a listed place\'s names and location are reported as before; on: one Headword attestation for it', () => {
  const s = LIST(`<place xml:id="athens"><placeName xml:lang="la">Athenae</placeName><placeName xml:lang="grc">Ἀθῆναι</placeName><idno type="URI">https://pleiades.stoa.org/places/579885</idno></place>`);
  const off = mapped(s);
  assert.deepEqual(names(off), ['Text'], 'off: only the text\'s name (control)');
  assert.deepEqual(examples(off, 'tei-listplace-names'), ['#athens: Athenae, Ἀθῆναι']);
  const on = mapped(s, { listPlaces: true });
  assert.deepEqual(on.doc.attestations[1], {
    about: 'https://pleiades.stoa.org/places/579885',
    names: [{ toponym: 'Athenae', language: 'la' }],
    formStatus: PLATO + 'Headword',
    citations: [{ source: { '@id': 'https://example.org/e', title: 'T', authorityType: 'source' }, locator: 'list of places, place athens' }],
    notes: 'From TEI element <place xml:id="athens"> on line 2 of test.xml',
  });
  // the main name is converted (presence), the variant is not (absence), and it is reported
  assert.deepEqual(names(on), ['Text', 'Athenae']);
  assert.ok(!names(on).includes('Ἀθῆναι'));
  assert.deepEqual(examples(on, 'tei-listplace-variant'), ['#athens: Ἀθῆναι']);
  assert.ok(!on.kinds.has('tei-listplace-names'));
  assert.equal(valid(on.doc), null);
});

test('listPlaces: coordinates are kept for an address on the edition\'s own site, not for a gazetteer\'s; a comma between them is read', () => {
  const s = LIST(`<place xml:id="a"><placeName>Own</placeName><idno type="URI">${OWN}</idno><location><geo>37.08415, 15.27628</geo></location></place>`
    + `<place xml:id="b"><placeName>Pleiad</placeName><idno type="URI">https://pleiades.stoa.org/places/579885</idno><location><geo>37.97 23.72</geo></location></place>`);
  const m = mapped(s, { listPlaces: true });
  const [own, gaz] = m.doc.attestations.slice(1);
  assert.deepEqual(own.geometries, [{ reprPoint: [15.27628, 37.08415], geojson: { type: 'Point', coordinates: [15.27628, 37.08415] }, sourceLabel: '37.08415, 15.27628' }]);
  assert.equal(gaz.geometries, undefined);
  assert.deepEqual(gaz.names, [{ toponym: 'Pleiad' }], 'control: the gazetteer\'s place is still converted');
  assert.deepEqual(examples(m, 'tei-listplace-geo-gazetteer'), ['#b: 37.97 23.72 (https://pleiades.stoa.org/places/579885)']);
  assert.equal(valid(m.doc), null);
});

test('listPlaces: an edition known only by its DOI never has its coordinates converted', () => {
  const doiOnly = HEADER.replace('<idno type="URI">https://example.org/e</idno>', '<idno type="DOI">10.5281/zenodo.1</idno>');
  const s = LIST(`<place xml:id="a"><placeName>Own</placeName><idno type="URI">https://doi.org/10.5281/zenodo.1#a</idno><location><geo>37 15</geo></location></place>`, doiOnly);
  const m = mapped(s, { listPlaces: true });
  assert.deepEqual(names(m), ['Text', 'Own'], 'control: the place is converted');
  assert.equal(m.doc.attestations[1].geometries, undefined);
  assert.deepEqual(examples(m, 'tei-listplace-geo-gazetteer'), ['#a: 37 15 (https://doi.org/10.5281/zenodo.1#a)']);
  assert.match(LOSS_TEXT['tei-listplace-geo-gazetteer'], /DOI never has its coordinates converted/);
});

test('listPlaces: a datum other than WGS84 gives no geometry; WGS84, or no geoDecl, gives one', () => {
  const place = `<place xml:id="a"><placeName>Own</placeName><idno type="URI">${OWN}</idno><location><geo>51.5 -0.12</geo></location></place>`;
  const withDecl = (decl) => HEADER.replace('</fileDesc>', `</fileDesc><encodingDesc>${decl}</encodingDesc>`);
  const geo = (header) => mapped(LIST(place, header), { listPlaces: true });
  const osgb = geo(withDecl('<geoDecl datum="OSGB36">x</geoDecl>'));
  assert.equal(osgb.doc.attestations[1].geometries, undefined);
  assert.deepEqual(examples(osgb, 'tei-listplace-geo-datum'), ['#a: 51.5 -0.12 (datum OSGB36)']);
  for (const h of [withDecl('<geoDecl datum="WGS84">x</geoDecl>'), withDecl('<geoDecl>x</geoDecl>'), HEADER]) {
    const m = geo(h);
    assert.deepEqual(m.doc.attestations[1].geometries?.[0].reprPoint, [-0.12, 51.5]);
    assert.ok(!m.kinds.has('tei-listplace-geo-datum'));
  }
});

test('listPlaces: coordinates that are not a latitude and a longitude are reported; a place with no web address is reported', () => {
  const s = LIST(`<place xml:id="a"><placeName>Own</placeName><idno type="URI">${OWN}</idno><location><geo>95 10</geo></location></place>`
    + `<place xml:id="c"><placeName>Own2</placeName><idno type="URI">${OWN}2</idno><location><geo>somewhere</geo></location></place>`
    + `<place xml:id="n"><placeName>Nowhere</placeName><idno type="local">n1</idno></place>`);
  const m = mapped(s, { listPlaces: true });
  assert.deepEqual(names(m), ['Text', 'Own', 'Own2']);
  assert.deepEqual(examples(m, 'tei-listplace-geo-invalid'), ['#a: 95 10', '#c: somewhere']);
  assert.deepEqual(examples(m, 'tei-listplace-no-address'), ['#n: Nowhere']);
});

test('listPlaces: a list of places in the teiHeader is converted after the whole header is read: a geoDecl after it still counts', () => {
  // the listPlace is in the sourceDesc, before the encodingDesc that declares the datum
  const header = `<teiHeader><fileDesc><titleStmt><title>Header places</title></titleStmt><publicationStmt><idno type="URI">https://example.org/e</idno></publicationStmt>`
    + `<sourceDesc><listPlace><place xml:id="a"><placeName>Early</placeName><idno type="URI">${OWN}</idno><location><geo>51.5 -0.12</geo></location></place></listPlace></sourceDesc></fileDesc>`
    + `<encodingDesc><geoDecl datum="OSGB36">x</geoDecl></encodingDesc></teiHeader>`;
  const m = mapped(tei(`<p>${pn(9, 'Text')}</p>`, header), { listPlaces: true });
  assert.deepEqual(m.doc.attestations.map((a) => [a.names[0].toponym, a.citations[0].source.title]), [['Early', 'Header places'], ['Text', 'Header places']]);
  assert.equal(m.doc.attestations[0].geometries, undefined);
  assert.deepEqual(examples(m, 'tei-listplace-geo-datum'), ['#a: 51.5 -0.12 (datum OSGB36)']);
  assert.equal(m.doc.gazetteer.title, 'Place names in Header places');
});

test('the pointers fixture with listPlaces: its listed places with one or more web addresses become Headword attestations', () => {
  const off = mapped(text('pointers-constructed.xml'), {}, 'pointers-constructed.xml');
  const on = mapped(text('pointers-constructed.xml'), { listPlaces: true }, 'pointers-constructed.xml');
  const heads = on.doc.attestations.filter((a) => a.formStatus === PLATO + 'Headword');
  assert.ok(heads.length > 0);
  assert.deepEqual(on.doc.attestations.filter((a) => a.formStatus !== PLATO + 'Headword'), off.doc.attestations, 'the text\'s attestations are as before');
  assert.equal(valid(on.doc), null);
});

// ---- Q6: places in the teiHeader ---------------------------------------------------------------
const msHeader = ({ msIdno = '', pubIdno = '<idno type="URI">https://example.org/e</idno>', provenance, origin = '', after = '' }) =>
  `<teiHeader><fileDesc><titleStmt><title>A stone</title></titleStmt><publicationStmt>${pubIdno}</publicationStmt><sourceDesc><msDesc>`
  + `<msIdentifier><repository>Museum</repository><idno type="inventory">7</idno>${msIdno}</msIdentifier>`
  + `<history><origin>${origin}</origin><provenance type="found">${provenance}</provenance></history></msDesc></sourceDesc></fileDesc>${after}</teiHeader>`;

test('I.Sicily with headerPlaces (the form status set): the findspot has FindspotOf to the object; the origin a note and no relation', () => {
  withEditorial(() => {
    const m = mapped(text(ISIC), { headerPlaces: true }, ISIC);
    assert.deepEqual(m.doc.attestations.map((a) => [a.about, a.names[0].toponym, a.citations[0].locator, a.formStatus.replace(PLATO, '')]), [
      ['https://pleiades.stoa.org/places/462503', 'Syracusae', 'teiHeader, origin', 'Editorial'],
      ['https://sws.geonames.org/2523083/', 'Siracusa', 'teiHeader, origin', 'Editorial'],
      ['https://pleiades.stoa.org/places/560149180', 'catacomb of S. Giovanni', 'teiHeader, provenance (found)', 'Editorial'],
      ['https://pleiades.stoa.org/places/678374', 'Μάκρης κώμης', 'edition, lines 2 to 4', 'Attested'],
    ]);
    const [syr, , cat] = m.doc.attestations;
    // the object is the edition's URI (the msIdentifier gives only an inventory number); no relationLabel ("found" is a code, not words)
    assert.deepEqual(cat.relations, [{ relatesTo: 'http://sicily.classics.ox.ac.uk/inscription/ISic000934', relationType: PLATO + 'FindspotOf', relatedLabel: 'Epitaph of Zodoros' }]);
    assert.match(cat.notes, /^The name is the editors' form, in the edition's header, not words of the source\.\n/);
    // origin: no relation (absence), a note saying it is the place of origin (presence), and the loss
    assert.equal(syr.relations, undefined);
    assert.match(syr.notes, /place of origin/);
    assert.deepEqual(examples(m, 'tei-header-origin'), ['Syracusae (http://pleiades.stoa.org/places/462503)', 'Siracusa (http://sws.geonames.org/2523083)']);
    assert.ok(!m.kinds.has('tei-place-outside-text'));
    assert.equal(valid(m.doc), null);
  });
  // and without the option, as before
  const off = mapped(text(ISIC), {}, ISIC);
  assert.equal(examples(off, 'tei-place-outside-text').length, 3);
  assert.deepEqual(names(off), ['Μάκρης κώμης']);
});

test('headerPlaces: the object is the msIdentifier\'s URI, else the edition\'s URI; a DOI-only edition gives no relatesTo', () => {
  withEditorial(() => {
    const found = pn(5, 'Findspot');
    const rel = (h) => mapped(tei(`<p>${pn(9, 'Text')}</p>`, h), { headerPlaces: true });
    const byMs = rel(msHeader({ msIdno: '<idno type="URI">https://museum.example/obj/7</idno>', provenance: found }));
    assert.equal(byMs.doc.attestations[0].relations[0].relatesTo, 'https://museum.example/obj/7');
    const byEdition = rel(msHeader({ provenance: found }));
    assert.equal(byEdition.doc.attestations[0].relations[0].relatesTo, 'https://example.org/e');
    const doiOnly = rel(msHeader({ pubIdno: '<idno type="DOI">10.5281/zenodo.1</idno>', provenance: found }));
    assert.deepEqual(names(doiOnly), ['Findspot', 'Text'], 'control: the findspot is converted');
    assert.equal(doiOnly.doc.attestations[0].relations, undefined);
    assert.deepEqual(examples(doiOnly, 'tei-findspot-no-object'), ['Findspot (https://pleiades.stoa.org/places/5)']);
  });
});

test('headerPlaces: a prefixDef declared after the msDesc still resolves a findspot\'s ref; other header place names are still reported', () => {
  withEditorial(() => {
    const h = msHeader({
      provenance: '<placeName ref="pl:579885">Athens</placeName>', origin: '<origPlace ref="https://pleiades.stoa.org/places/1">Somewhere</origPlace>',
      after: '<encodingDesc><listPrefixDef><prefixDef ident="pl" matchPattern="(\\d+)" replacementPattern="https://pleiades.stoa.org/places/$1"/></listPrefixDef></encodingDesc>',
    }).replace('<repository>Museum</repository>', '<repository>Museum</repository><settlement ref="https://pleiades.stoa.org/places/2">Town</settlement>');
    const m = mapped(tei(`<p>${pn(9, 'Text')}</p>`, h), { headerPlaces: true });
    assert.deepEqual(m.doc.attestations.map((a) => [a.about, a.names[0].toponym]), [
      ['https://pleiades.stoa.org/places/1', 'Somewhere'],
      ['https://pleiades.stoa.org/places/579885', 'Athens'],
      ['https://pleiades.stoa.org/places/9', 'Text'],
    ]);
    assert.ok(!m.kinds.has('tei-ref-prefix'));
    assert.deepEqual(examples(m, 'tei-place-outside-text'), ['teiHeader: Town (https://pleiades.stoa.org/places/2)']);
  });
});

// ---- Q3: keys ------------------------------------------------------------------------------------
const KEYS = 'keys-constructed.xml';
const TGN = 'http://vocab.getty.edu/tgn/{id}';
const PLEIADES = 'https://pleiades.stoa.org/places/{id}';
const keyed = (options) => mapped(text(KEYS), options, KEYS);

test('a key is split at its first ":" or ","; a key with neither has the prefix ""', () => {
  assert.deepEqual(splitKey('tgn,7011179'), { prefix: 'tgn', rest: '7011179' });
  assert.deepEqual(splitKey('pleiades:579885'), { prefix: 'pleiades', rest: '579885' });
  assert.deepEqual(splitKey('a:b,c'), { prefix: 'a', rest: 'b,c' });
  assert.deepEqual(splitKey('Q1524'), { prefix: '', rest: 'Q1524' });
});

test('addressFromPattern: the shape is checked, the id put in, and the address made goes through placeAddress', () => {
  assert.deepEqual(addressFromPattern('579885', PLEIADES), { iri: 'https://pleiades.stoa.org/places/579885' });
  assert.deepEqual(addressFromPattern('579885', 'http://pleiades.stoa.org/places/{key}'), { iri: 'https://pleiades.stoa.org/places/579885', from: 'http://pleiades.stoa.org/places/579885', rules: ['pleiades-https'] });
  assert.deepEqual(addressFromPattern('athens', PLEIADES), { error: 'shape' });
  assert.deepEqual(addressFromPattern('1524', 'http://www.wikidata.org/entity/{id}'), { error: 'shape' });
  assert.deepEqual(addressFromPattern('Q1524', 'http://www.wikidata.org/entity/{id}'), { iri: 'http://www.wikidata.org/entity/Q1524' });
  // a pattern of the user's own takes only the characters an address takes unescaped
  assert.deepEqual(addressFromPattern('Argos', 'https://example.org/p/{id}'), { iri: 'https://example.org/p/Argos' });
  assert.deepEqual(addressFromPattern('Ar gos', 'https://example.org/p/{id}'), { error: 'shape' });
  assert.deepEqual(addressFromPattern('whg:123', 'https://example.org/p/{id}'), { error: 'whg' });
  assert.equal(patternProblem('https://example.org/{id}/{id}'), 'placeholder');
  assert.equal(patternProblem('https://example.org/'), 'placeholder');
  assert.equal(patternProblem('urn:x:{id}'), 'not-web');
  assert.equal(patternProblem('https://whgazetteer.org/places/{id}/portal/'), 'whg');
  assert.equal(patternProblem('https://w3id.org/whg/id/place:gn:{id}'), 'whg');
  assert.equal(patternProblem('https://w3id.org/other/{id}'), null);
});

test('a WHG pattern, a pattern for the prefix "whg", and a pattern with no placeholder are refused; a good one is taken', () => {
  for (const kp of [{ w: 'https://whgazetteer.org/places/{id}/portal/' }, { whg: 'https://example.org/{id}' }, { tgn: 'http://vocab.getty.edu/tgn/' }]) {
    assert.ok(teiReadingRefusal({ keyPatterns: kp }), JSON.stringify(kp));
    assert.throws(() => new TeiReader(() => {}, { keyPatterns: kp }), DataError);
  }
  assert.match(teiReadingRefusal({ keyPatterns: { w: 'https://w3id.org/whg/id/{id}' } }), /World Historical Gazetteer/);
  assert.equal(teiReadingRefusal({ keyPatterns: { tgn: TGN, '': PLEIADES } }), null);
});

test('with no pattern, keys are reported by prefix with a count, examples and a suggested pattern; a key beside a ref is not counted', () => {
  const m = keyed({});
  assert.deepEqual(names(m), ['Argos'], 'control: the place name with a ref is converted');
  assert.deepEqual(examples(m, 'tei-key-no-pattern'), [
    'prefix "tgn": 3 keys, such as tgn,7011179, tgn,7010720, tgn,7001393; try --key-pattern tgn=http://vocab.getty.edu/tgn/{id}',
    'prefix "pleiades": 2 keys, such as pleiades:579885, pleiades:athens; try --key-pattern pleiades=https://pleiades.stoa.org/places/{id}',
    'no prefix: 1 key, such as Q1524; try --key-pattern http://www.wikidata.org/entity/{id}',
    'prefix "perseus": 1 key, such as perseus,Argos; give a pattern, such as --key-pattern perseus=https://…/{id}',
  ]);
  assert.equal(examples(m, 'tei-place-no-ref').length, 7);
});

test('with a pattern for a prefix, its keys make attestations, with a note of the key and the pattern; other prefixes are still reported', () => {
  const m = keyed({ keyPatterns: { tgn: TGN } });
  const tgn = m.doc.attestations.filter((a) => a.about.startsWith('http://vocab.getty.edu/tgn/'));
  assert.deepEqual(tgn.map((a) => [a.about, a.names[0].toponym, a.citations[0].locator]), [
    ['http://vocab.getty.edu/tgn/7011179', 'Athens', 'edition, book 1'],
    ['http://vocab.getty.edu/tgn/7010720', 'Sparta', 'edition, book 1'],
    ['http://vocab.getty.edu/tgn/7001393', 'Corinth', 'edition, book 1'],
  ]);
  assert.equal(tgn[0].notes, `Place address made from the key tgn,7011179 with the pattern ${TGN}\nFrom TEI element <placeName> on line 18 of ${KEYS}`);
  assert.equal(tgn[0].formStatus, PLATO + 'Attested');
  assert.ok(!examples(m, 'tei-key-no-pattern').some((e) => e.startsWith('prefix "tgn"')));
  assert.ok(examples(m, 'tei-key-no-pattern').some((e) => e.startsWith('prefix "pleiades"')), 'control: a prefix with no pattern is still reported');
  assert.equal(valid(m.doc), null);
});

test('a key out of the pattern\'s shape is reported and not converted; one in shape beside it is', () => {
  const m = keyed({ keyPatterns: { pleiades: PLEIADES } });
  assert.deepEqual(m.doc.attestations.filter((a) => a.notes.includes('made from the key')).map((a) => [a.about, a.names[0].toponym]), [['https://pleiades.stoa.org/places/579885', 'Athenae']]);
  assert.deepEqual(examples(m, 'tei-key-shape'), [`pleiades:athens (pattern ${PLEIADES})`]);
  assert.ok(!names(m).includes('Athenai'));
});

test('the empty prefix takes a pattern too; a ref with a key beside it gives no attestation from the key', () => {
  const m = keyed({ keyPatterns: { '': 'http://www.wikidata.org/entity/{id}', tgn: TGN } });
  assert.ok(m.doc.attestations.some((a) => a.about === 'http://www.wikidata.org/entity/Q1524' && a.names[0].toponym === 'Athína'));
  const argos = m.doc.attestations.filter((a) => a.names[0].toponym === 'Argos');
  assert.deepEqual(argos.map((a) => a.about), ['https://pleiades.stoa.org/places/570106'], 'the ref, not tgn 7010832');
  assert.match(argos[0].notes, /^Key: tgn,7010832\n/);
  assert.ok(!m.doc.attestations.some((a) => a.about === 'http://vocab.getty.edu/tgn/7010832'));
  assert.ok(m.doc.attestations.some((a) => a.about === 'http://vocab.getty.edu/tgn/7011179'), 'control: the tgn pattern is in use');
});

test('teiKeyPrefixes reads the file as a stream and gives each prefix with its count, examples and suggested pattern', async () => {
  const got = await teiKeyPrefixes({ format: 'tei', files: [new File([readFileSync(DIR + KEYS)], KEYS)] });
  assert.deepEqual(got, [
    { prefix: 'tgn', count: 3, examples: ['tgn,7011179', 'tgn,7010720', 'tgn,7001393'], suggested: TGN },
    { prefix: 'pleiades', count: 2, examples: ['pleiades:579885', 'pleiades:athens'], suggested: PLEIADES },
    { prefix: '', count: 1, examples: ['Q1524'], suggested: 'http://www.wikidata.org/entity/{id}' },
    { prefix: 'perseus', count: 1, examples: ['perseus,Argos'], suggested: undefined },
  ]);
  // a file with no keys gives none (control above: the same call on a file with keys gives four)
  assert.deepEqual(await teiKeyPrefixes({ format: 'tei', files: [new File([readFileSync(DIR + ISIC)], ISIC)] }), []);
});

// ---- what is held stays small ------------------------------------------------------------------
// The garbage collector, so that the heap measured is what is still held, not what a test before left.
import v8 from 'node:v8';
import vm from 'node:vm';
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
/** Read a constructed file of `n` lines, each a place name and one in a note, after an early note, a chunk at a time, keeping nothing but counts. */
function readLarge(n, { divs }) {
  const r = new TeiReader(() => {}, { fileName: 'large.xml' });
  let maxHeld = 0, attestations = 0, early = 0;
  gc();
  const heap0 = process.memoryUsage().heapUsed;
  let peak = heap0;
  const take = (evs) => {
    for (const e of evs) if (e.type === 'attestation') { attestations++; if (e.value.names[0].toponym === 'Early') early++; }
    maxHeld = Math.max(maxHeld, r.held.length);
  };
  take(r.write(`<?xml version="1.0" encoding="UTF-8"?>\n<TEI xmlns="http://www.tei-c.org/ns/1.0">${HEADER}<text><body><p>Before: <note>${pn(1, 'Early')}</note></p>${divs ? '<div type="letter">' : ''}`));
  const line = `<p>${pn(2, 'Place')}<note>${pn(3, 'Noted')}</note></p>\n`;
  for (let i = 0; i < n; i += 1000) {
    take(r.write(line.repeat(Math.min(1000, n - i))));
    if (i % 20000 === 0) { gc(); peak = Math.max(peak, process.memoryUsage().heapUsed); }
  }
  take(r.write(`${divs ? '</div>' : ''}</body></text></TEI>\n`));
  take(r.close());
  return { maxHeld, attestations, early, growthMB: (peak - heap0) / 1e6 };
}

for (const divs of [true, false]) {
  test(`200,000 lines of place names and notes after an early note, no edition div${divs ? ', in a top-level div of the text' : ', no divs'}: at most one name is held, and the held names are still emitted`, () => {
    const got = readLarge(200000, { divs });
    assert.equal(got.attestations, 400001);
    assert.equal(got.early, 1, 'the held name is emitted, as an ordinary attestation');
    assert.ok(got.maxHeld <= 1, `held ${got.maxHeld}`);
    // holding every attestation would be hundreds of MB; reading as a stream stays well under this
    assert.ok(got.growthMB < 50, `heap grew ${got.growthMB.toFixed(1)} MB`);
  });
}
