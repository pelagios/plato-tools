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
import { teiToDocument, teiSource, teiKeyPrefixes, TEI_KINDS } from '../src/engine/hermes/tei.js';
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
  // And a name in neither the file nor the table is an error there too.
  assert.throws(() => mapped(P5('<!DOCTYPE TEI SYSTEM "tei_all.dtd">', pn('&nosuchname;'))), (e) => e instanceof DataError && /nosuchname/.test(e.message));
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
  const p5 = readdirSync(DIR).filter((f) => f.endsWith('.xml') && f !== 'p4-constructed.xml');
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
