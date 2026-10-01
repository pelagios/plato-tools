// A rule of 2026-10-01 for the TEI reader (src/engine/hermes/tei.js):
//   - a <note> marked as the editors' (@resp not the work's author, or @type editorial, commentary
//     or translator) is the editors' words in any file.
// Every test of an absence has a presence beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { addPlatoFormats, strictFormatLogger } from '../src/lib/formats.js';
import { teiToDocument, setEditorialIriForTests } from '../src/engine/hermes/tei.js';

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
