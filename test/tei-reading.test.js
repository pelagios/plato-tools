// The TEI reader's reading options and the editors' words (Hermes batch, step B: Q9, Q1, Q6, Q3).
// src/engine/hermes/tei.js; the fixtures are described in test/fixtures/tei/README.md. Each test of
// something absent has a control in the same test that something present was read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { addPlatoFormats, strictFormatLogger } from '../src/lib/formats.js';
import { teiToDocument, TeiReader, TEI_KINDS, EDITORIAL_IRI, setEditorialIriForTests, teiReadingRefusal } from '../src/engine/hermes/tei.js';
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
