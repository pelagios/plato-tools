// Two rules of 2026-10-01 for the TEI reader (src/engine/hermes/tei.js, addresses.js):
//   - several gazetteer ids for one place: one attestation about the preferred address (DEVELOPERS.md,
//     "Preferred authorities, hermes-preferred 1"), with identity relations to the others; two ids
//     from one authority stay ambiguous;
//   - a <note> marked as the editors' (@resp not the work's author, or @type editorial, commentary
//     or translator) is the editors' words in any file.
// Every test of an absence has a presence beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { addPlatoFormats, strictFormatLogger } from '../src/lib/formats.js';
import { teiToDocument, TEI_KINDS, setEditorialIriForTests } from '../src/engine/hermes/tei.js';
import { AUTHORITIES, PREFERRED_RULES, authorityOf, preferredAddress } from '../src/engine/hermes/addresses.js';
import { LOSS_TEXT } from '../src/engine/report.js';

const load = (f) => JSON.parse(readFileSync(`public/plato/${f}`, 'utf8'));
const ajv = addPlatoFormats(new Ajv2020({ strict: false, allErrors: true, logger: strictFormatLogger }));
ajv.addSchema(load('plato.schema.json'), 'https://w3id.org/plato/schemas/plato.schema.json');
ajv.addSchema(load('attestation-centric.schema.json'));
const valid = (doc) => { const v = ajv.getSchema('https://w3id.org/plato/schemas/attestation-centric.schema.json'); return v(doc) ? null : v.errors.slice(0, 3); };
function mapped(s, options = {}, name = 'test.xml') {
  const reported = [];
  const doc = teiToDocument(s, name, (kind, example) => reported.push([kind, example]), options);
  return { doc, reported, kinds: new Set(reported.map(([k]) => k)) };
}
const examples = (m, kind) => m.reported.filter(([k]) => k === kind).map(([, e]) => e);
const names = (m) => m.doc.attestations.flatMap((a) => (a.names || []).map((n) => n.toponym));
const HEADER = (extra = '') => `<teiHeader><fileDesc><titleStmt><title>T</title>${extra}</titleStmt><publicationStmt><idno type="URI">https://example.org/e</idno></publicationStmt><sourceDesc><p>x</p></sourceDesc></fileDesc></teiHeader>`;
const tei = (body, header = HEADER()) => `<?xml version="1.0" encoding="UTF-8"?>\n<TEI xmlns="http://www.tei-c.org/ns/1.0">${header}<text><body>${body}</body></text></TEI>\n`;
const withEditorial = (fn) => { const was = setEditorialIriForTests('https://w3id.org/plato#Editorial'); try { return fn(); } finally { setEditorialIriForTests(was); } };
const unspecified = (subject, object) => ({ subject, object, identityType: 'unspecified' });

// ---- the order -----------------------------------------------------------------------------------
test('the preferred order: gazetteers of places, then authority files, then a project\'s own, then other hosts alphabetically', () => {
  const all = ['https://zz.example.org/p/1', 'https://pmb.acdh.oeaw.ac.at/entity/1/', 'https://viaf.org/viaf/1', 'https://d-nb.info/gnd/1-1',
    'http://www.wikidata.org/entity/Q1', 'http://vocab.getty.edu/tgn/1', 'https://sws.geonames.org/1/', 'https://w3id.org/whg/id/place:gn:1',
    'https://pleiades.stoa.org/places/1', 'https://www.aa.example.org/p/1'];
  const want = ['pleiades', 'whg', 'geonames', 'tgn', 'wikidata', 'gnd', 'viaf', 'pmb', 'aa.example.org', 'zz.example.org'];
  const left = all.map((iri) => ({ iri }));
  const got = [];
  while (left.length) { const c = preferredAddress(left); got.push(authorityOf(c.preferred.iri).key); left.splice(left.indexOf(c.preferred), 1); }
  assert.deepEqual(got, want);
  const c = preferredAddress(all.map((iri) => ({ iri })));
  assert.deepEqual(c.others.map((o) => authorityOf(o.iri).key), want.slice(1), 'the others in the same order');
  // two from one authority: a clash, however far down the order
  assert.deepEqual(preferredAddress([{ iri: 'https://pleiades.stoa.org/places/1' }, { iri: 'https://viaf.org/viaf/1' }, { iri: 'https://www.viaf.org/viaf/2' }]).clash, ['https://viaf.org/viaf/1', 'https://www.viaf.org/viaf/2']);
  assert.equal(preferredAddress([{ iri: 'https://pleiades.stoa.org/places/1' }]).others.length, 0, 'control: one address is preferred, with no others');
});

test('DEVELOPERS.md gives the preferred order the code has, under the version the code names', () => {
  const doc = readFileSync('DEVELOPERS.md', 'utf8');
  const m = /^#+ Preferred authorities, (hermes-preferred \d+) \((\d{4}-\d{2}-\d{2})\)$/m.exec(doc);
  assert.ok(m, 'DEVELOPERS.md has the table "Preferred authorities, hermes-preferred <n> (<date>)"');
  assert.equal(m[1], PREFERRED_RULES);
  const section = doc.slice(m.index + m[0].length).split(/^#+ /m)[0];
  const rows = [...section.matchAll(/^\| (\d+) \| `([a-z]+)` \|/gm)].map((x) => [Number(x[1]), x[2]]);
  assert.deepEqual(rows, AUTHORITIES.map((a, i) => [i + 1, a.key]));
  assert.match(section, /any other host/i, 'the rule for any other host is stated');
});

// ---- a listed place with four ids (Schnitzler) ----------------------------------------------------------
const MONTE_VISO = readFileSync('test/fixtures/tei/excerpts/schnitzler-listplace-pmb364316.xml', 'utf8');
test('Schnitzler: a listed place with PMB, Wikidata, GND and GeoNames ids is one Headword about GeoNames, with identity relations to the others', () => {
  const m = mapped(MONTE_VISO, { listPlaces: true }, 'listplace.xml');
  assert.equal(m.doc.attestations.length, 1);
  const [a] = m.doc.attestations;
  const GN = 'https://sws.geonames.org/3164048/';
  assert.equal(a.about, GN);
  assert.equal(a.formStatus, 'https://w3id.org/plato#Headword');
  assert.deepEqual(a.names, [{ toponym: 'Monte Viso' }]);
  assert.deepEqual(a.identities, [
    unspecified(GN, 'http://www.wikidata.org/entity/Q1248'),
    unspecified(GN, 'https://d-nb.info/gnd/4449828-7'),
    unspecified(GN, 'https://pmb.acdh.oeaw.ac.at/entity/364316/'),
  ]);
  assert.equal(a.citations[0].locator, 'list of places, place pmb364316');
  assert.match(a.notes, /^The place has 4 addresses: this attestation is about https:\/\/sws\.geonames\.org\/3164048\/ \(hermes-preferred 1\)/);
  assert.deepEqual(examples(m, 'tei-several-ids'), [`${GN}, with http://www.wikidata.org/entity/Q1248, https://d-nb.info/gnd/4449828-7, https://pmb.acdh.oeaw.ac.at/entity/364316/`]);
  assert.ok(!m.kinds.has('tei-listplace-ambiguous'));
  // its own point is GeoNames', not the edition's: reported against the preferred address
  assert.deepEqual(examples(m, 'tei-listplace-geo-gazetteer'), [`#pmb364316: 44,6675 7,0916666666667 (${GN})`]);
  assert.equal(valid(m.doc), null);
});

test('a listed place with two GeoNames ids is refused, as ambiguous; with one GeoNames and one Wikidata, it is converted', () => {
  const place = (a, b) => tei(`<listPlace><place xml:id="p"><placeName>P</placeName><idno type="URL">${a}</idno><idno type="URL">${b}</idno></place></listPlace>`);
  const two = mapped(place('https://sws.geonames.org/3164048/', 'https://www.geonames.org/3164049/x.html'), { listPlaces: true });
  assert.deepEqual(two.doc.attestations, []);
  assert.deepEqual(examples(two, 'tei-listplace-ambiguous'), ['#p: https://sws.geonames.org/3164048/, https://sws.geonames.org/3164049/']);
  assert.ok(!two.kinds.has('tei-several-ids'));
  const ok = mapped(place('https://sws.geonames.org/3164048/', 'http://www.wikidata.org/entity/Q1248'), { listPlaces: true });
  assert.deepEqual(ok.doc.attestations.map((a) => a.about), ['https://sws.geonames.org/3164048/']);
  assert.equal(TEI_KINDS['tei-listplace-ambiguous'], 'loss');
  assert.match(LOSS_TEXT['tei-listplace-ambiguous'], /same gazetteer/);
  assert.match(LOSS_TEXT['tei-several-ids'], /hermes-preferred 1/);
});

test('#x to a place with Pleiades and Wikidata ids: the same one attestation and identity relation as the listed place; reported once for the place', () => {
  const list = '<listPlace><place xml:id="ath"><placeName>Athenae</placeName><idno type="URI">https://www.wikidata.org/wiki/Q1524</idno><idno type="URI">https://pleiades.stoa.org/places/579885</idno></place></listPlace>';
  const m = mapped(tei(`<p><placeName ref="#ath">Ἀθῆναι</placeName></p>${list}`), { listPlaces: true });
  const PL = 'https://pleiades.stoa.org/places/579885', WD = 'http://www.wikidata.org/entity/Q1524';
  assert.deepEqual(m.doc.attestations.map((a) => [a.names[0].toponym, a.about]), [['Athenae', PL], ['Ἀθῆναι', PL]]);
  for (const a of m.doc.attestations) assert.deepEqual(a.identities, [unspecified(PL, WD)], a.names[0].toponym);
  assert.match(m.doc.attestations[1].notes, /From TEI element <placeName ref="#ath">/);
  assert.match(m.doc.attestations[1].notes, /Place address given as https:\/\/www\.wikidata\.org\/wiki\/Q1524 \(rule wikidata-page, hermes-addresses 1\)/);
  assert.deepEqual(examples(m, 'tei-several-ids'), [`${PL}, with ${WD}`]);
  assert.equal(valid(m.doc), null);
  // control: a #x to a place with two Pleiades ids is ambiguous, and nothing is converted from it
  const two = mapped(tei('<p><placeName ref="#t">T</placeName></p><listPlace><place xml:id="t"><idno>https://pleiades.stoa.org/places/1</idno><idno>https://pleiades.stoa.org/places/2</idno></place></listPlace>'));
  assert.deepEqual([two.doc.attestations, examples(two, 'tei-ref-ambiguous')], [[], ['#t: https://pleiades.stoa.org/places/1, https://pleiades.stoa.org/places/2']]);
});

test('a ref with a web address and a #x: all their addresses together are one place', () => {
  const list = '<listPlace><place xml:id="ath"><idno>https://pleiades.stoa.org/places/579885</idno><idno>https://www.wikidata.org/wiki/Q1524</idno></place></listPlace>';
  const m = mapped(tei(`<p><placeName ref="https://sws.geonames.org/264371/ #ath">Athenae</placeName></p>${list}`));
  assert.deepEqual(m.doc.attestations.map((a) => a.about), ['https://pleiades.stoa.org/places/579885']);
  assert.deepEqual(m.doc.attestations[0].identities.map((i) => i.object), ['https://sws.geonames.org/264371/', 'http://www.wikidata.org/entity/Q1524']);
  // control: a GeoNames address beside a place that already has one is two GeoNames ids
  const clash = mapped(tei(`<p><placeName ref="https://sws.geonames.org/1/ #ath">Athenae</placeName></p>${list.replace('https://pleiades.stoa.org/places/579885', 'https://sws.geonames.org/264371/')}`));
  assert.deepEqual([clash.doc.attestations, examples(clash, 'tei-ref-ambiguous')], [[], ['<placeName> on line 2: https://sws.geonames.org/1/, https://sws.geonames.org/264371/']]);
});

// ---- notes in the editors' words ------------------------------------------------------------------------
// A Perseus-like file, constructed (no Perseus text is committed): no edition div, the text in a
// div type="translation", a note by the editor and an unmarked note.
const PERSEUS_LIKE = (noteAttrs, header = HEADER('<author>Pausanias</author><editor xml:id="jones">W. H. S. Jones</editor>')) => tei(
  '<div type="translation" n="1"><p>He came to <placeName ref="https://pleiades.stoa.org/places/570182">Corinth</placeName>.'
  + `<note${noteAttrs}>Cf. <placeName ref="https://pleiades.stoa.org/places/570106">Argos</placeName>.</note>`
  + '<note>Or <placeName ref="https://pleiades.stoa.org/places/580063">Sikyon</placeName>.</note></p></div>', header);

test('a file with no edition div: a place name in a note with resp is the editors\', reported; one in an unmarked note stays the source\'s', () => {
  const m = mapped(PERSEUS_LIKE(' resp="editor"'));
  assert.deepEqual(names(m), ['Corinth', 'Sikyon']);
  assert.deepEqual(examples(m, 'tei-place-editorial'), ['note (resp="editor"): Argos (https://pleiades.stoa.org/places/570106) on line 2']);
  assert.ok(m.doc.attestations.every((a) => a.formStatus === 'https://w3id.org/plato#Attested'));
  assert.equal(m.doc.attestations[1].citations[0].locator, 'translation 1, in a note');
  for (const [attrs, words] of [[' type="editorial"', 'type="editorial"'], [' type="Commentary"', 'type="Commentary"'], [' type="translator"', 'type="translator"'], [' resp="#jones"', 'resp="#jones"']]) {
    const t = mapped(PERSEUS_LIKE(attrs));
    assert.deepEqual(examples(t, 'tei-place-editorial'), [`note (${words}): Argos (https://pleiades.stoa.org/places/570106) on line 2`], attrs);
  }
  // control: a note with another type, and an unmarked one, are the source's in such a file
  assert.deepEqual(names(mapped(PERSEUS_LIKE(' type="gloss"'))), ['Corinth', 'Argos', 'Sikyon']);
});

test('a note whose resp points to the work\'s own author is the source\'s: by the author\'s id, an author\'s respStmt, or the author\'s name', () => {
  const byId = mapped(PERSEUS_LIKE(' resp="#paus"', HEADER('<author xml:id="paus">Pausanias</author>')));
  const byPersName = mapped(PERSEUS_LIKE(' resp="#p"', HEADER('<author><persName xml:id="p">Pausanias</persName></author>')));
  const byRespStmt = mapped(PERSEUS_LIKE(' resp="#a"', HEADER('<respStmt xml:id="a"><resp>author</resp><name>Pausanias</name></respStmt>')));
  const byName = mapped(PERSEUS_LIKE(' resp="pausanias"', HEADER('<author>Pausanias</author>')));
  const byRespName = mapped(PERSEUS_LIKE(' resp="Pausanias"', HEADER('<respStmt><resp>Author</resp><persName>Pausanias</persName></respStmt>')));
  for (const [what, m] of Object.entries({ byId, byPersName, byRespStmt, byName, byRespName })) {
    assert.deepEqual(names(m), ['Corinth', 'Argos', 'Sikyon'], what);
    assert.ok(!m.kinds.has('tei-place-editorial'), what);
  }
  // controls: an editor's id, a respStmt that is not the author's, the author with an editor beside, an id not in the header
  for (const [resp, header] of [['#jones', HEADER('<author xml:id="paus">Pausanias</author><editor xml:id="jones">Jones</editor>')],
    ['#t', HEADER('<respStmt xml:id="t"><resp>translator</resp><name>Pausanias</name></respStmt>')],
    ['#paus #jones', HEADER('<author xml:id="paus">Pausanias</author><editor xml:id="jones">Jones</editor>')],
    ['#nobody', HEADER('<author xml:id="paus">Pausanias</author>')]]) {
    const m = mapped(PERSEUS_LIKE(` resp="${resp}"`, header));
    assert.deepEqual(names(m), ['Corinth', 'Sikyon'], resp);
    assert.equal(examples(m, 'tei-place-editorial').length, 1, resp);
  }
});

test('a marked note goes the editorial path: converted only with commentaryPlaces, with the editors\' form status', () => {
  withEditorial(() => {
    const m = mapped(PERSEUS_LIKE(' resp="editor"'), { commentaryPlaces: true });
    const argos = m.doc.attestations.find((a) => a.names[0].toponym === 'Argos');
    assert.equal(argos.formStatus, 'https://w3id.org/plato#Editorial');
    assert.equal(argos.citations[0].locator, 'translation 1, in a note');
    assert.match(argos.notes, /^The editors' words, not the source's\./);
    // control: the unmarked note's name stays the source's
    assert.equal(m.doc.attestations.find((a) => a.names[0].toponym === 'Sikyon').formStatus, 'https://w3id.org/plato#Attested');
    assert.equal(valid(m.doc), null);
  });
  // held while EDITORIAL_IRI is null: the option is refused
  assert.throws(() => mapped(PERSEUS_LIKE(' resp="editor"'), { commentaryPlaces: true }), /Editorial form status/);
});

test('with an edition div, notes are the editors\' as before, marked or not; a marked one is named by its resp', () => {
  const s = tei('<div type="edition"><ab><placeName ref="https://pleiades.stoa.org/places/570182">Corinth</placeName>'
    + '<note>see <placeName ref="https://pleiades.stoa.org/places/580063">Sikyon</placeName></note>'
    + '<note resp="#paus">see <placeName ref="https://pleiades.stoa.org/places/570106">Argos</placeName></note></ab></div>', HEADER('<author xml:id="paus">Pausanias</author>'));
  const m = mapped(s);
  assert.deepEqual(names(m), ['Corinth']);
  // the author's own note is in the edition's note too: the editors', as every note in such a file is
  assert.deepEqual(examples(m, 'tei-place-editorial'), ['note: Sikyon (https://pleiades.stoa.org/places/580063) on line 2', 'note: Argos (https://pleiades.stoa.org/places/570106) on line 2']);
  const marked = mapped(s.replace('<note>', '<note type="commentary">'));
  assert.deepEqual(examples(marked, 'tei-place-editorial')[0], 'note (type="commentary"): Sikyon (https://pleiades.stoa.org/places/580063) on line 2');
  assert.deepEqual(names(marked), ['Corinth']);
});
