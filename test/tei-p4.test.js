// TEI P4 (<TEI.2>, <teiCorpus.2>) and TEI with no namespace (Hermes, issue #5, item 4 of the next
// four): detection, id and lang read as xml:id and xml:lang (lang an IDREF into the header's
// <language>), reg reported, Beta Code reported and never carried, and the ISO entity table
// (src/vendor/iso-entities.json) used only for a file that names an outside DTD. The P4 fixture is
// constructed (test/fixtures/tei/README.md); a real Perseus file is checked only by the opt-in
// scripts/check-perseus-p4.mjs, never committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { addPlatoFormats, strictFormatLogger } from '../src/lib/formats.js';
import { teiToDocument, teiSource, teiKeyPrefixes, TEI_KINDS, TeiReader } from '../src/engine/hermes/tei.js';
import { detect, DataError } from '../src/engine/input.js';
import { LOSS_TEXT, Report } from '../src/engine/report.js';

const DIR = 'test/fixtures/tei/';
const ISO = JSON.parse(readFileSync('src/vendor/iso-entities.json', 'utf8'));
const TGN = 'http://vocab.getty.edu/tgn/{id}';
const load = (f) => JSON.parse(readFileSync(`public/plato/${f}`, 'utf8'));
const ajv = addPlatoFormats(new Ajv2020({ strict: false, allErrors: true, logger: strictFormatLogger }));
ajv.addSchema(load('plato.schema.json'), 'https://w3id.org/plato/schemas/plato.schema.json');
ajv.addSchema(load('attestation-centric.schema.json'));
const valid = (doc) => { const v = ajv.getSchema('https://w3id.org/plato/schemas/attestation-centric.schema.json'); return v(doc) ? null : v.errors.slice(0, 3); };
const text = (f) => readFileSync(DIR + f, 'utf8');
const textFile = (s, name = 'x.xml') => new File([s], name);
/** Map a TEI text with the ISO table at hand, collecting what is reported. */
function mapped(s, options = {}, name = 'test.xml') {
  const reported = [];
  const doc = teiToDocument(s, name, (kind, example) => reported.push([kind, example]), { entities: ISO, ...options });
  return { doc, reported, kinds: new Set(reported.map(([k]) => k)) };
}
const examples = (m, kind) => m.reported.filter(([k]) => k === kind).map(([, e]) => e);
const names = (m) => m.doc.attestations.flatMap((a) => (a.names || []).map((n) => n.toponym));
// Read once, when the first test asks (so that a failure to read it fails the tests, not the file).
let p4read;
const p4 = () => (p4read ||= mapped(text('p4-constructed.xml'), { keyPatterns: { tgn: TGN } }, 'p4-constructed.xml'));
const byName = (m, toponym) => m.doc.attestations.find((a) => a.names?.[0]?.toponym === toponym);

// ---- detection ---------------------------------------------------------------------------------------
test('TEI P4 and TEI with no namespace are detected as TEI, with their variant; P5 has none', async () => {
  const cases = {
    'p4.xml': ['<?xml version="1.0"?>\n<!DOCTYPE TEI.2 PUBLIC "-//TEI P4//DTD Main Document Type//EN" "tei2.dtd" [ <!ENTITY % TEI.XML "INCLUDE"> ]>\n<TEI.2><teiHeader/></TEI.2>', 'p4'],
    'corpus4.xml': ['<?xml version="1.0"?>\n<teiCorpus.2><teiHeader/><TEI.2><teiHeader/></TEI.2></teiCorpus.2>', 'p4'],
    'nons.xml': ['<?xml version="1.0"?>\n<TEI><teiHeader/></TEI>', 'no-namespace'],
    'nons-corpus.xml': ['<teiCorpus><TEI/></teiCorpus>', 'no-namespace'],
  };
  for (const [name, [s, variant]] of Object.entries(cases)) {
    const d = await detect([textFile(s, name)]);
    assert.deepEqual([d.format, d.variant], ['tei', variant], name);
  }
  // Controls: P5 is TEI with no variant; a TEI root in another namespace, or a P4 root in a namespace, is not TEI.
  const p5 = await detect([textFile('<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></TEI>')]);
  assert.deepEqual([p5.format, p5.variant], ['tei', undefined]);
  for (const s of ['<TEI xmlns="http://example.org/not-tei"><teiHeader/></TEI>', '<x:TEI.2 xmlns:x="http://example.org/x"/>']) assert.equal((await detect([textFile(s)])).format, null, s);
});

// ---- the constructed P4 fixture -------------------------------------------------------------------------
test('the constructed P4 fixture: attestations made from tgn keys, valid PLATO, located by numbered divs and milestones', async () => {
  assert.equal(valid(p4().doc), null);
  assert.deepEqual(p4().doc.attestations.map((a) => a.about), [7000874, 7001393, 7001393, 7001393, 7002382, 7010720, 7003393, 7012149].map((n) => `http://vocab.getty.edu/tgn/${n}`));
  const roma = byName(p4(), 'Romae');
  assert.deepEqual(roma.citations[0].locator, 'book 1, chapter 1, section 1');
  assert.equal(roma.citations[0].source['@id'], 'https://example.org/texts/de-locis-fictis');
  assert.ok(roma.notes.includes('Place address made from the key tgn,7000874 with the pattern http://vocab.getty.edu/tgn/{id}'), roma.notes);
  assert.equal(byName(p4(), 'Corinthum').citations[0].locator, 'book 2, chapter 1');
  // id is read as xml:id
  assert.equal(byName(p4(), 'Athenas').citations[0].locator, 'book 1, chapter 1, section 1, xml:id pn-athenae');
  assert.ok(byName(p4(), 'Athenas').notes.includes('<placeName xml:id="pn-athenae">'));
  assert.deepEqual(examples(p4(), 'tei-p4').length, 1);
  // A note marked resp="ed" is the editors' words, as in any file; there is no edition div.
  assert.deepEqual(examples(p4(), 'tei-place-editorial'), ['note (resp="ed"): Romam (key tgn,7000874) on line 82']);
  // Without the pattern, the keys are reported, with TGN's pattern to try.
  const bare = mapped(text('p4-constructed.xml'));
  assert.deepEqual(bare.doc.attestations, []);
  assert.match(examples(bare, 'tei-key-no-pattern')[0], /^prefix "tgn": 9 keys, .*--key-pattern tgn=http:\/\/vocab\.getty\.edu\/tgn\/\{id\}$/);
});
test('P4 lang is an IDREF into the header\'s <language>: resolved to a tag where its id or ident is one, else tei-lang-not-tag', () => {
  assert.equal(byName(p4(), 'Romae').names[0].language, 'la', '<text lang="la">: <language id="la">');
  assert.equal(byName(p4(), 'Carthaginem').names[0].language, 'la', 'lang="lat": <language id="lat" ident="la">');
  assert.equal(byName(p4(), 'Massiliæ').names[0].language, 'la');
  assert.equal(byName(p4(), 'Lacedaemonem').names[0].language, undefined);
  assert.equal(byName(p4(), 'Αθηναι').names[0].language, undefined);
  assert.deepEqual([...new Set(examples(p4(), 'tei-lang-not-tag'))].sort(), ['greek (<language id="greek">Greek</language>)', 'latine (<language id="latine">Latin, with no tag</language>)']);
});
test('reg, the editors\' regularised form, is reported and not carried', () => {
  assert.deepEqual(examples(p4(), 'tei-reg'), ['Romae (reg="Roma") on line 73']);
  assert.ok(!JSON.stringify(p4().doc).includes('"Roma"'));
  assert.ok(!examples(p4(), 'tei-attribute').some((e) => /@(reg|id|lang)=/.test(e)), examples(p4(), 'tei-attribute').join('; '));
});
test('in P5, a reg on a place name with a key and no ref is reported, as one beside a ref is', () => {
  const doc = (pn) => `<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt><title>T</title></titleStmt></fileDesc></teiHeader><text><body><p>${pn}</p></body></text></TEI>`;
  const keyed = mapped(doc('<placeName key="tgn,7000874" reg="Roma">Romae</placeName>'), { keyPatterns: { tgn: TGN } });
  assert.deepEqual(names(keyed), ['Romae']);
  assert.deepEqual(examples(keyed, 'tei-attribute'), ['placeName@reg="Roma"']);
  assert.ok(!keyed.kinds.has('tei-reg'));
  // Control: beside a ref it was already reported so; with no reg, nothing is.
  assert.deepEqual(examples(mapped(doc('<placeName ref="http://vocab.getty.edu/tgn/7000874" reg="Roma">Romae</placeName>')), 'tei-attribute'), ['placeName@reg="Roma"']);
  assert.deepEqual(examples(mapped(doc('<placeName key="tgn,7000874">Romae</placeName>'), { keyPatterns: { tgn: TGN } }), 'tei-attribute'), []);
});
test('Beta Code: a Greek name in ASCII is reported, naming the string, and its attestation carries no toponym', () => {
  assert.deepEqual(examples(p4(), 'tei-p4-beta-code'), ['*)aqh=nai (<placeName> on line 75)']);
  assert.ok(!JSON.stringify(p4().doc).includes('aqh=nai'));
  const nameless = p4().doc.attestations.filter((a) => !a.names);
  assert.equal(nameless.length, 1);
  assert.equal(nameless[0].about, 'http://vocab.getty.edu/tgn/7001393');
  assert.equal(nameless[0].formStatus, undefined);
  assert.match(nameless[0].notes, /Beta Code/);
  // Control: the same place written in Greek letters (from the ISO entities) is carried; Latin in ASCII is not Beta Code.
  assert.ok(names(p4()).includes('Αθηναι'));
  assert.ok(names(p4()).includes('Athenas'));
});
test('the ISO entities are read, and each set used is reported once with each name and its count', () => {
  assert.ok(names(p4()).includes('Massiliæ'));
  assert.deepEqual(examples(p4(), 'tei-entity-iso'), ['isogrk1: Agr (1), thgr (1), eegr (1), ngr (1), agr (1), igr (1)', 'isolat1: aelig (1)']);
  // The file's own entity (responsibility) is not the table's, and is not reported.
  assert.ok(!examples(p4(), 'tei-entity-iso').some((e) => /responsibility/.test(e)));
});
test('teiSource and teiKeyPrefixes load the ISO table themselves for an outside-DTD file', async () => {
  const input = { format: 'tei', variant: 'p4', files: [textFile(text('p4-constructed.xml'), 'p4-constructed.xml')] };
  const rep = new Report(), evs = [];
  for await (const ev of teiSource(input, rep, { keyPatterns: { tgn: TGN } })) evs.push(ev);
  assert.equal(evs.filter((e) => e.type === 'attestation').length, 8);
  const kinds = new Map(rep.kinds && [...rep.kinds.values()].map((k) => [k.kind, k]));
  assert.equal(kinds.get('tei-entity-iso').severity, 'warning');
  assert.equal(kinds.get('tei-p4').severity, 'warning');
  assert.equal(kinds.get('tei-p4-beta-code').severity, 'loss');
  const prefixes = await teiKeyPrefixes(input);
  assert.deepEqual(prefixes.map((p) => [p.prefix, p.count, p.suggested]), [['tgn', 9, TGN]]);
});

// ---- the entity table: which files, and what wins ---------------------------------------------------------
const P5 = (doctype, body) => `<?xml version="1.0"?>\n${doctype}<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt><title>T</title></titleStmt></fileDesc></teiHeader><text><body><p>${body}</p></body></text></TEI>\n`;
const pn = (w) => `<placeName ref="https://pleiades.stoa.org/places/579885">${w}</placeName>`;
test('a file naming no outside DTD still refuses an entity it does not declare', () => {
  for (const d of ['', '<!DOCTYPE TEI>', '<!DOCTYPE TEI [<!ENTITY nbsp "&#160;">]>', '<!DOCTYPE TEI [<!ENTITY % ISOgrk1 PUBLIC "ISO 8879:1986//ENTITIES Greek Letters//EN//XML" "isogrk1.ent">]>']) {
    assert.throws(() => mapped(P5(d, pn('&agr;'))), (e) => e instanceof DataError && /&agr;|agr/.test(e.message), d);
  }
  // Control: an outside DTD (an external subset, or an external parameter entity the subset uses) gives the table.
  for (const d of ['<!DOCTYPE TEI SYSTEM "tei_all.dtd">', '<!DOCTYPE TEI [<!ENTITY % ISOgrk1 PUBLIC "ISO 8879:1986//ENTITIES Greek Letters//EN//XML" "isogrk1.ent"> %ISOgrk1;]>']) {
    assert.deepEqual(names(mapped(P5(d, pn('&agr;')))), ['α'], d);
  }
  // A name in neither the file nor the table is refused, named, here; with an outside DTD it is left out (below).
  assert.throws(() => mapped(P5('<!DOCTYPE TEI>', pn('&nosuchname;'))), (e) => e instanceof DataError && /nosuchname/.test(e.message));
});
test('the table is installed for a DOCTYPE with no internal subset (before doctype()\'s early return)', () => {
  const m = mapped('<?xml version="1.0"?>\n<!DOCTYPE TEI.2 SYSTEM "tei2.dtd">\n<TEI.2><teiHeader><fileDesc><titleStmt><title>T</title></titleStmt></fileDesc></teiHeader><text><body><p><placeName key="tgn,1">&Agr;&thgr;&eegr;&ngr;&agr;&igr;</placeName></p></body></text></TEI.2>', { keyPatterns: { tgn: TGN } });
  assert.deepEqual(names(m), ['Αθηναι']);
});
test('a declaration in the file beats the table, and is not reported as the table\'s', () => {
  const m = mapped(P5('<!DOCTYPE TEI SYSTEM "tei_all.dtd" [<!ENTITY agr "ALPHA"><!ENTITY both "&bgr;&agr;">]>', pn('&agr;&bgr;&both;')));
  assert.deepEqual(names(m), ['ALPHAββALPHA']);
  // Control: the table was in use (bgr is its), and only its names are counted.
  assert.deepEqual(examples(m, 'tei-entity-iso'), ['isogrk1: bgr (2)']);
});
test('a teiCorpus.2 is read as P4, each TEI.2 in it too', () => {
  const m = mapped('<?xml version="1.0"?>\n<teiCorpus.2><teiHeader><fileDesc><titleStmt><title>C</title></titleStmt></fileDesc></teiHeader><TEI.2 lang="la"><teiHeader><fileDesc><titleStmt><title>One</title></titleStmt></fileDesc><profileDesc><langUsage><language id="la">Latin</language></langUsage></profileDesc></teiHeader><text><body><div1 type="book" n="3"><p><placeName id="r1" key="tgn,7000874">Roma</placeName></p></div1></body></text></TEI.2></teiCorpus.2>', { keyPatterns: { tgn: TGN } });
  assert.equal(m.doc.attestations.length, 1);
  assert.deepEqual([m.doc.attestations[0].names[0], m.doc.attestations[0].citations[0].locator, m.doc.attestations[0].citations[0].source.title], [{ toponym: 'Roma', language: 'la' }, 'book 3, xml:id r1', 'One']);
  assert.equal(examples(m, 'tei-p4').length, 1);
});
test('TEI with no namespace is P5 without its xmlns: xml:id and xml:lang are read, id and lang are not, with a warning', () => {
  const s = '<TEI><teiHeader><fileDesc><titleStmt><title>T</title></titleStmt></fileDesc></teiHeader><text xml:lang="la"><body><p><placeName xml:id="a" ref="https://pleiades.stoa.org/places/579885">Athenae</placeName> <placeName id="b" lang="grc" ref="https://pleiades.stoa.org/places/423025">Roma</placeName></p></body></text></TEI>';
  const m = mapped(s);
  assert.deepEqual(m.doc.attestations.map((a) => [a.names[0], a.citations[0].locator]), [[{ toponym: 'Athenae', language: 'la' }, 'xml:id a'], [{ toponym: 'Roma', language: 'la' }, '']].map(([n, l]) => [n, l || undefined]));
  assert.equal(examples(m, 'tei-no-namespace').length, 1);
  assert.deepEqual(examples(m, 'tei-attribute').sort(), ['placeName@id="b"', 'placeName@lang="grc"']);
  assert.ok(!m.kinds.has('tei-p4'));
  // An element counts as TEI when its namespace is the root's: one in the TEI namespace inside a no-namespace TEI is not read.
  const mixed = mapped(s.replace('<placeName xml:id="a"', '<placeName xmlns="http://www.tei-c.org/ns/1.0" xml:id="a"'));
  assert.deepEqual(names(mixed), ['Roma']);
});
test('the P5 fixtures give no P4, no-namespace or ISO entity warning', () => {
  const p5 = readdirSync(DIR).filter((f) => f.endsWith('.xml') && !f.startsWith('p4-'));
  assert.ok(p5.length >= 6);
  for (const f of p5) {
    const m = mapped(text(f), {}, f);
    assert.ok(m.doc.attestations.length > 0, f);
    for (const k of ['tei-p4', 'tei-no-namespace', 'tei-entity-iso', 'tei-p4-beta-code', 'tei-reg']) assert.ok(!m.kinds.has(k), `${f}: ${k}`);
  }
  // Control: the P4 fixture gives each.
  for (const k of ['tei-p4', 'tei-entity-iso', 'tei-p4-beta-code', 'tei-reg']) assert.ok(p4().kinds.has(k), k);
});
test('the new kinds have words and the severities agreed', () => {
  const want = { 'tei-p4': 'warning', 'tei-no-namespace': 'warning', 'tei-entity-iso': 'warning', 'tei-p4-beta-code': 'loss', 'tei-reg': 'loss' };
  for (const [k, sev] of Object.entries(want)) { assert.equal(TEI_KINDS[k], sev, k); assert.ok(LOSS_TEXT[k], k); }
});

// ---- entities that only the outside DTD declares (decided 2026-10-02) ---------------------------------------
// In a file naming an outside DTD, an entity in neither the file nor the ISO table is left out, with
// nothing in its place, and reported (tei-entity-unknown); a place name holding one is not converted
// (tei-place-entity-unknown); a source title or edition address holding one stops the file. The
// fixture is constructed in the manner of a digital library's header boilerplate.
const boiler = () => text('p4-boilerplate-constructed.xml');
const KEYS = { keyPatterns: { tgn: TGN } };
test('header boilerplate in entities only the outside DTD declares: left out, reported once with names and counts, and the file converts', () => {
  const m = mapped(boiler(), KEYS, 'p4-boilerplate-constructed.xml');
  assert.equal(valid(m.doc), null);
  assert.deepEqual(names(m), ['Romam', 'Athenas']);
  const reported = examples(m, 'tei-entity-unknown');
  assert.equal(reported.length, 1);
  assert.match(reported[0], /^&responsibility; \(2\), &fund\.NEH; \(1\), &Perseus\.publish; \(1\): left out/);
  assert.match(reported[0], /never read/);
  assert.equal(TEI_KINDS['tei-entity-unknown'], 'warning');
  assert.ok(LOSS_TEXT['tei-entity-unknown']);
  // Nothing is put in an entity's place, not even its name.
  assert.ok(!/responsibility|fund\.NEH|Perseus\.publish|﷐|﷑/.test(JSON.stringify(m.doc)));
  assert.ok(!m.kinds.has('tei-place-entity-unknown'));
  // Control: the same file with the entities declared in its own DOCTYPE gives no such report.
  const declared = boiler().replace('%PersProse;\n', '%PersProse;\n<!ENTITY responsibility "encoded by"><!ENTITY fund.NEH "a foundation"><!ENTITY Perseus.publish "">\n');
  const c = mapped(declared, KEYS);
  assert.deepEqual(names(c), ['Romam', 'Athenas']);
  assert.ok(!c.kinds.has('tei-entity-unknown'));
});
test('a place name with an unknown entity (in its words, ref or key) is not converted and is reported; the others convert', () => {
  const cases = {
    words: ['<placeName key="tgn,7000874">Ro&lacuna;mam</placeName>', /^&lacuna; in "Romam" \(<placeName key="tgn,7000874">\) on line \d+$/],
    key: ['<placeName key="tgn,&roma.key;">Romam</placeName>', /^&roma\.key; in "Romam" \(<placeName key="tgn,">\)/],
    ref: ['<placeName ref="http://vocab.getty.edu/tgn/&roma.id;">Romam</placeName>', /^&roma\.id; in "Romam" \(<placeName ref="http:\/\/vocab\.getty\.edu\/tgn\/">\)/],
  };
  for (const [what, [pn, want]] of Object.entries(cases)) {
    const m = mapped(boiler().replace('<placeName key="tgn,7000874">Romam</placeName>', pn), KEYS);
    assert.deepEqual(names(m), ['Athenas'], what);
    const r = examples(m, 'tei-place-entity-unknown');
    assert.equal(r.length, 1, what);
    assert.match(r[0], want, what);
    assert.ok(!m.kinds.has('tei-key-shape') && !m.kinds.has('tei-ref-relative'), what);
  }
  assert.equal(TEI_KINDS['tei-place-entity-unknown'], 'loss');
  assert.ok(LOSS_TEXT['tei-place-entity-unknown']);
  // A listed place whose address holds one: names pointing to it are not converted either.
  const listed = boiler().replace('<div1 type="book" n="1">', '<div1 type="book" n="1"><p><placeName ref="#r">Roma</placeName></p>').replace('</body>', '</body><back><listPlace><place id="r"><placeName>Roma</placeName><idno>http://vocab.getty.edu/tgn/&roma.id;</idno></place></listPlace></back>');
  const l = mapped(listed, KEYS);
  assert.deepEqual(names(l), ['Romam', 'Athenas']);
  assert.equal(examples(l, 'tei-place-entity-unknown').length, 2);
  assert.ok(!l.kinds.has('tei-ref-local'));
  // Control: the same file with no entity in the names converts all three.
  const ok = mapped(listed.replace('&roma.id;', '7000874'), KEYS);
  assert.deepEqual(names(ok), ['Roma', 'Romam', 'Athenas']);
  assert.ok(!ok.kinds.has('tei-place-entity-unknown'));
});
test('an unknown entity in the source title, or in the edition\'s address, stops the file, naming the entity', () => {
  assert.throws(() => mapped(boiler().replace('<title>De Locis Fictis</title>', '<title>De Locis &title.suffix;</title>'), KEYS),
    (e) => e instanceof DataError && /&title\.suffix;/.test(e.message) && /title/.test(e.message) && /never read/.test(e.message));
  assert.throws(() => mapped(boiler().replace('de-locis-fictis</idno>', '&text.id;</idno>'), KEYS),
    (e) => e instanceof DataError && /&text\.id;/.test(e.message) && /address/.test(e.message));
  // Control: one in a sub-title the reader does not use, or in another header field, does not stop it.
  const sub = mapped(boiler().replace('<title>De Locis Fictis</title>', '<title>De Locis Fictis</title><title type="sub">&title.suffix;</title>'), KEYS);
  assert.deepEqual(names(sub), ['Romam', 'Athenas']);
  assert.equal(sub.doc.attestations[0].citations[0].source.title, 'De Locis Fictis');
});
test('a file naming no outside DTD still refuses an undeclared entity, in the header or a place name', () => {
  const noDtd = boiler().replace(/<!DOCTYPE[\s\S]*?\]>\n/, '');
  assert.throws(() => mapped(noDtd, KEYS), (e) => e instanceof DataError && /&responsibility;/.test(e.message));
  assert.throws(() => mapped(noDtd.replace(/&[\w.]+;/g, '').replace('Romam', 'Ro&lacuna;mam'), KEYS), (e) => e instanceof DataError && /&lacuna;/.test(e.message));
  // Control: without the entities, it converts.
  assert.deepEqual(names(mapped(noDtd.replace(/&[\w.]+;/g, ''), KEYS)), ['Romam', 'Athenas']);
});

// ---- U+FDD0 and U+FDD1, the markers of unknown entities, outside an outside-DTD file -------------------------
// The markers are looked for and stripped only where the ISO table is installed; elsewhere they are
// characters of the text, read as written. An outside-DTD file that already holds one is refused.
const OUTSIDE = '<!DOCTYPE TEI SYSTEM "tei_all.dtd">';
test('in a file naming no outside DTD, U+FDD0 and U+FDD1 are read as written, never as an unknown entity', () => {
  for (const w of ['Ro&#xFDD0;zz&#xFDD1;ma', 'Ro﷐zz﷑ma', 'Ro&#64976;ma']) {
    const m = mapped(P5('', pn(w)));
    const want = w.replace('&#xFDD0;', '﷐').replace('&#xFDD1;', '﷑').replace('&#64976;', '﷐');
    assert.deepEqual(names(m), [want], w);
    assert.ok(!m.kinds.has('tei-place-entity-unknown') && !m.kinds.has('tei-entity-unknown'), w);
  }
  // In an attribute too: the ref is read whole, and is not a web address with a hole in it.
  const a = mapped(P5('', '<placeName ref="https://pleiades.stoa.org/places/57&#xFDD0;x&#xFDD1;9885">Roma</placeName>'));
  assert.ok(!a.kinds.has('tei-place-entity-unknown'));
  // Control: an unknown entity in an outside-DTD file is still found, left out and reported.
  const c = mapped(P5(OUTSIDE, pn('Ro&zz;ma')));
  assert.deepEqual(names(c), []);
  assert.match(examples(c, 'tei-place-entity-unknown')[0], /^&zz; in "Roma"/);
});
test('a file naming an outside DTD that already holds U+FDD0 or U+FDD1 is refused, as the character or a reference to it', async () => {
  const refused = (e) => e instanceof DataError && /U\+FDD0 or U\+FDD1/.test(e.message) && /outside DTD/.test(e.message);
  for (const w of ['Ro﷐ma', 'Ro﷑ma', 'Ro﷐zz﷑ma', 'Ro&#xFDD0;ma', 'Ro&#xfdd1;ma', 'Ro&#64976;ma']) assert.throws(() => mapped(P5(OUTSIDE, pn(w))), refused, w);
  // In an entity the file declares; and before the DOCTYPE, in a chunk of its own.
  assert.throws(() => mapped(P5('<!DOCTYPE TEI SYSTEM "tei_all.dtd" [<!ENTITY m "&#xFDD0;">]>', pn('Ro&m;ma'))), refused);
  const r = new TeiReader(() => {}, { entities: ISO });
  r.write('<?xml version="1.0"?>\n<!-- ﷐ -->\n');
  assert.throws(() => r.write(P5(OUTSIDE, pn('Roma')).replace('<?xml version="1.0"?>\n', '')), refused);
  // And through teiSource, read in chunks.
  const input = { format: 'tei', files: [textFile(P5(OUTSIDE, pn('Ro﷐ma')))] };
  await assert.rejects(async () => { for await (const ev of teiSource(input, new Report())) void ev; }, refused);
  // Control: the same files with no marker convert.
  assert.deepEqual(names(mapped(P5(OUTSIDE, pn('Roma')))), ['Roma']);
  assert.deepEqual(names(mapped(P5('<!DOCTYPE TEI SYSTEM "tei_all.dtd" [<!ENTITY m "m">]>', pn('Ro&m;a')))), ['Roma']);
});

// ---- a teiCorpus.2's languages: each TEI.2's own -----------------------------------------------------------
const tei2 = (title, langs, body) => `<TEI.2><teiHeader><fileDesc><titleStmt><title>${title}</title></titleStmt></fileDesc><profileDesc><langUsage>${langs}</langUsage></profileDesc></teiHeader><text><body><p>${body}</p></body></text></TEI.2>`;
const corpus2 = (langs, ...texts) => `<?xml version="1.0"?>\n<teiCorpus.2><teiHeader><fileDesc><titleStmt><title>C</title></titleStmt></fileDesc>${langs ? `<profileDesc><langUsage>${langs}</langUsage></profileDesc>` : ''}</teiHeader>${texts.join('')}</teiCorpus.2>`;
test('in a teiCorpus.2, each TEI.2\'s <language id> is its own: the same id resolves to each text\'s language', () => {
  const m = mapped(corpus2('',
    tei2('One', '<language id="x" ident="la">Latin</language>', '<placeName lang="x" key="tgn,7000874">Roma</placeName>'),
    tei2('Two', '<language id="x" ident="grc">Greek</language>', '<placeName lang="x" key="tgn,7001393">Ἀθῆναι</placeName>')), KEYS);
  assert.deepEqual(m.doc.attestations.map((a) => [a.names[0].toponym, a.names[0].language, a.citations[0].source.title]), [['Roma', 'la', 'One'], ['Ἀθῆναι', 'grc', 'Two']]);
  // And an id a later text does not declare is not the earlier text's: there it is not resolved.
  const later = mapped(corpus2('',
    tei2('One', '<language id="x" ident="la">Latin</language>', '<placeName lang="x" key="tgn,7000874">Roma</placeName>'),
    tei2('Two', '', '<placeName lang="x" key="tgn,7000874">Roma</placeName>')), KEYS);
  assert.deepEqual(later.doc.attestations.map((a) => a.names[0].language), ['la', undefined]);
  assert.deepEqual(examples(later, 'tei-lang-not-tag'), ['x (no <language id="x"> in the header)']);
  // Control: the corpus's own header's languages hold for every text in it.
  const shared = mapped(corpus2('<language id="x" ident="la">Latin</language>',
    tei2('One', '', '<placeName lang="x" key="tgn,7000874">Roma</placeName>'),
    tei2('Two', '', '<placeName lang="x" key="tgn,7000874">Roma</placeName>')), KEYS);
  assert.deepEqual(shared.doc.attestations.map((a) => a.names[0].language), ['la', 'la']);
});
