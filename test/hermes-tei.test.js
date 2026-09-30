// TEI XML editions -> PLATO attestations (Hermes, src/engine/hermes/tei.js). The fixtures, and where
// each comes from, are described in test/fixtures/tei/README.md. The pipeline does not dispatch to
// the reader yet, so it is tested through teiToDocument and teiSource, and detection through detect().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { addPlatoFormats, strictFormatLogger } from '../src/lib/formats.js';
import { teiToDocument, teiSource, TeiReader, TEI_KINDS } from '../src/engine/hermes/tei.js';
import { detect, DataError } from '../src/engine/input.js';
import { LOSS_TEXT, Report } from '../src/engine/report.js';
import { summary, formatName } from '../src/engine/words.js';

const PLATO = 'https://w3id.org/plato#';
const DIR = 'test/fixtures/tei/';
const FIXTURES = readdirSync(DIR).filter((f) => f.endsWith('.xml')).sort();
const load = (f) => JSON.parse(readFileSync(`public/plato/${f}`, 'utf8'));
const ajv = addPlatoFormats(new Ajv2020({ strict: false, allErrors: true, logger: strictFormatLogger }));
ajv.addSchema(load('plato.schema.json'), 'https://w3id.org/plato/schemas/plato.schema.json');
ajv.addSchema(load('attestation-centric.schema.json'));
const AC = 'https://w3id.org/plato/schemas/attestation-centric.schema.json';
const valid = (doc) => { const v = ajv.getSchema(AC); return v(doc) ? null : v.errors.slice(0, 3); };
const text = (f) => readFileSync(DIR + f, 'utf8');
const file = (f, name) => new File([readFileSync(DIR + f)], name || f);
const textFile = (s, name) => new File([s], name);
/** Map a TEI text, collecting what is reported: { doc, reported: [[kind, example]], kinds }. */
function mapped(s, name = 'test.xml') {
  const reported = [];
  const doc = teiToDocument(s, name, (kind, example) => reported.push([kind, example]));
  return { doc, reported, kinds: new Set(reported.map(([k]) => k)) };
}
const examples = (m, kind) => m.reported.filter(([k]) => k === kind).map(([, e]) => e);
const names = (m) => m.doc.attestations.flatMap((a) => (a.names || []).map((n) => n.toponym));
const about = (m) => m.doc.attestations.map((a) => a.about);
const tei = (body, header = '<teiHeader><fileDesc><titleStmt><title>T</title></titleStmt><publicationStmt><idno type="URI">https://example.org/e</idno></publicationStmt><sourceDesc><p>x</p></sourceDesc></fileDesc></teiHeader>') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<TEI xmlns="http://www.tei-c.org/ns/1.0">${header}<text><body>${body}</body></text></TEI>\n`;

const ISIC = mapped(text('isicily-ISic000934.xml'), 'isicily-ISic000934.xml');
const PROSE = mapped(text('prose-constructed.xml'), 'prose-constructed.xml');
const VERSE = mapped(text('verse-constructed.xml'), 'verse-constructed.xml');
const PTR = mapped(text('pointers-constructed.xml'), 'pointers-constructed.xml');
const WHG = mapped(text('whg-constructed.xml'), 'whg-constructed.xml');

test('there are fixtures: a real EpiDoc edition and the four constructed ones', () => {
  assert.deepEqual(FIXTURES, ['isicily-ISic000934.xml', 'pointers-constructed.xml', 'prose-constructed.xml', 'verse-constructed.xml', 'whg-constructed.xml']);
});

for (const f of FIXTURES) {
  test(`${f}: detected as TEI, mapped to valid attestation-centric PLATO JSON`, async () => {
    const input = await detect([file(f)]);
    assert.equal(input.format, 'tei');
    assert.equal(formatName(input), 'a TEI XML edition');
    const { doc } = mapped(text(f), f);
    assert.equal(doc.profile, 'attestation-centric');
    assert.ok(doc.attestations.length > 0);
    assert.equal(valid(doc), null);
  });
}

// ---- the mapping, exactly -----------------------------------------------------------------------
const ISIC_SOURCE = {
  '@id': 'http://sicily.classics.ox.ac.uk/inscription/ISic000934',
  title: 'Epitaph of Zodoros',
  citation: 'Jonathan Prag (ed.). Epitaph of Zodoros.',
  licence: 'http://creativecommons.org/licenses/by/4.0/',
  derivedFrom: { title: 'Italy, Sicily, Siracusa, Museo Archeologico Regionale Paolo Orsi, 68', authorityType: 'source' },
  authorityType: 'source',
};
test('a real EpiDoc inscription (I.Sicily ISic000934) becomes exactly these attestations', () => {
  assert.deepEqual(ISIC.doc, {
    profile: 'attestation-centric',
    gazetteer: {
      title: 'Place names in Epitaph of Zodoros',
      description: 'Converted by PLATO tools from the TEI edition isicily-ISic000934.xml: one attestation for each place name in the text whose ref points to a place.',
    },
    attestations: [{
      about: 'https://pleiades.stoa.org/places/678374',
      // the name runs over three lines, broken within words (lb break="no")
      names: [{ toponym: 'Μάκρης κώμης', language: 'grc' }],
      formStatus: PLATO + 'Attested',
      citations: [{ source: ISIC_SOURCE, locator: 'edition, lines 2 to 4' }],
      notes: 'From TEI element <placeName> on line 180 of isicily-ISic000934.xml',
    }, {
      about: 'https://pleiades.stoa.org/places/678374',
      names: [{ toponym: 'Sarepta', language: 'en' }],
      formStatus: PLATO + 'Attested',
      citations: [{ source: ISIC_SOURCE, locator: 'commentary' }],
      notes: 'From TEI element <placeName> on line 205 of isicily-ISic000934.xml',
    }],
  });
});
test('a prose edition: book, chapter, milestone and page in the locator; the source from the header, its DOI as its address', () => {
  const a = PROSE.doc.attestations;
  assert.deepEqual(a.map((x) => [x.names[0].toponym, x.citations[0].locator]), [
    ['Corinth', 'book 2, chapter 1, section 1, page 12'],
    ['Kenchreai', 'book 2, chapter 1, section 2, page 12'],
    ['Kenchreai', 'book 2, chapter 1, section 2, page 12'],
    ['Sikyon', 'book 2, chapter 2, page 13'],
    ['Phlious', 'book 2, chapter 2, page 13, in a note'],
    ['Argos', 'book 2, chapter 2, page 13, xml:id arg'],
  ]);
  assert.deepEqual(a[0].citations[0].source, {
    '@id': 'https://doi.org/10.5281/zenodo.0000000', title: 'A Journey through Achaia',
    citation: 'Pausanias. A Journey through Achaia. Example Press. 2026.', licence: 'https://creativecommons.org/licenses/by/4.0/',
    derivedFrom: { title: 'Pausanias, Description of Greece, book 2 (Teubner, 1903)', authorityType: 'source' }, authorityType: 'source',
  });
  assert.equal(PROSE.doc.gazetteer.title, 'Place names in A Journey through Achaia', 'the main title, not the first');
});
test('a note inside a place name is not part of the name; a key is kept in the notes; an xml:id is not the attestation\'s @id', () => {
  const c = PROSE.doc.attestations[0];
  assert.deepEqual([c.names, c.notes], [[{ toponym: 'Corinth', language: 'en' }], 'Key: corinth\nFrom TEI element <placeName> on line 32 of prose-constructed.xml']);
  const argos = PROSE.doc.attestations.find((x) => x.about === 'https://pleiades.stoa.org/places/570106');
  assert.deepEqual([argos['@id'], argos.notes], [undefined, 'From TEI element <placeName xml:id="arg"> on line 43 of prose-constructed.xml']);
});
test('a verse edition: the line (<l n>) is the locator; <rs type="place">, <name type="place"> and <region> are read', () => {
  assert.deepEqual(VERSE.doc.attestations.map((a) => [a.names[0].toponym, a.citations[0].locator, a.notes.replace(/ on line.*/, '')]), [
    ['Navam', 'line 1', 'From TEI element <rs>'],
    ['Vinco', 'line 2', 'From TEI element <name>'],
    ['Dumnissum', 'line 6', 'From TEI element <placeName>'],
    ['Tabernas', 'line 6', 'From TEI element <region>'],
    ['Belgarum', 'line 8', 'From TEI element <placeName>'],
  ]);
  assert.ok(!names(VERSE).includes('Sauromatum'), '<rs type="person"> is not a place');
  assert.ok(names(VERSE).includes('Navam'), 'control: <rs type="place"> in the same file is');
});
test('choice and app: the edited form is the name, the form as printed its sourceLabel; a variant reading is not taken', () => {
  const byAbout = (id) => PTR.doc.attestations.find((a) => a.about === `https://pleiades.stoa.org/places/${id}`).names[0];
  assert.deepEqual(byAbout('570375'), { toponym: 'Ἦλις', language: 'grc', sourceLabel: 'Ἤλις' });
  assert.deepEqual(byAbout('570511'), { toponym: 'Ἰθάκη', language: 'grc', sourceLabel: 'Ἰθ.' });
  assert.deepEqual(byAbout('579925'), { toponym: 'Κύθηρα', language: 'grc', sourceLabel: 'Κυθῆρα' });
  assert.deepEqual(byAbout('589704'), { toponym: 'Πύλος', language: 'grc' });
  assert.ok(!names(PTR).some((n) => /Πύλλος|ΠύλοςΠύλλος/.test(n)));
});
test('a prefixed ref is expanded through the header\'s prefixDef; a word broken over a line (break="no") is joined', () => {
  const k = PTR.doc.attestations.filter((a) => a.about === 'https://pleiades.stoa.org/places/570182');
  assert.deepEqual(k.map((a) => [a.names[0].toponym, a.citations[0].locator, a.notes]), [
    ['Κόρινθος', 'line 1', 'From TEI element <placeName ref="pl:570182"> on line 50 of pointers-constructed.xml'],
    ['Κορινθος', 'lines 17 to 18', 'From TEI element <placeName ref="pl:570182"> on line 66 of pointers-constructed.xml'],
  ]);
});
test('a local ref (#x) is resolved through the <place> with that xml:id and its one web-address idno', () => {
  const a = PTR.doc.attestations.find((x) => x.about === 'https://pleiades.stoa.org/places/579885');
  assert.deepEqual([a.names[0].toponym, a.citations[0].locator, a.notes], ['Ἀθηνῶν', 'line 5', 'From TEI element <placeName ref="#athens"> on line 54 of pointers-constructed.xml']);
});
test('a local ref to a list of places AFTER the mention (in <back>) is held until the place is read, then resolved', () => {
  const a = PTR.doc.attestations.find((x) => x.about === 'https://pleiades.stoa.org/places/570685');
  assert.deepEqual([a.names[0].toponym, a.citations[0].locator, a.notes], ['Σπάρτη', 'line 8', 'From TEI element <placeName ref="#sparta"> on line 57 of pointers-constructed.xml']);
  assert.equal(PTR.doc.attestations.at(-1), a, 'it comes last, once the place has been read');
  // control: a ref to an id that never comes is not resolved at the end, and says so
  assert.ok(!names(PTR).includes('Ἄργος'));
  assert.deepEqual(examples(PTR, 'tei-ref-local').filter((e) => e.startsWith('#missing')), ['#missing (no place with this id in the file)']);
});
test('a teiCorpus: the corpus header names the gazetteer; each TEI cites its own header', () => {
  const doc = teiToDocument(`<teiCorpus xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt><title>The Corpus</title></titleStmt></fileDesc></teiHeader>
    <TEI><teiHeader><fileDesc><titleStmt><title>Text One</title></titleStmt><publicationStmt><idno type="URI">https://example.org/one</idno></publicationStmt></fileDesc></teiHeader>
    <text><body><p><placeName ref="https://pleiades.stoa.org/places/579885">Athenae</placeName></p></body></text></TEI></teiCorpus>`, 'c.xml');
  assert.equal(doc.gazetteer.title, 'Place names in The Corpus');
  assert.deepEqual(doc.attestations[0].citations[0].source, { '@id': 'https://example.org/one', title: 'Text One', authorityType: 'source' });
  assert.equal(valid(doc), null);
});
test('the text is read the same however it is cut into chunks (a stream)', () => {
  const s = text('pointers-constructed.xml');
  const whole = PTR.doc.attestations;
  for (const size of [1, 7, 64]) {
    const r = new TeiReader(() => {}, { fileName: 'pointers-constructed.xml' });
    const evs = [];
    for (let i = 0; i < s.length; i += size) evs.push(...r.write(s.slice(i, i + size)));
    evs.push(...r.close());
    assert.equal(evs[0].type, 'header', `${size}: the header comes first`);
    assert.deepEqual(evs.filter((e) => e.type === 'attestation').map((e) => e.value), whole, `chunks of ${size}`);
  }
});

// ---- what is not converted, and is reported -------------------------------------------------------
test('a place name with no ref is reported, with its key where it has one; one with a ref beside it is converted', () => {
  assert.deepEqual(examples(PROSE, 'tei-place-no-ref'), ['Lechaeum']);
  assert.ok(!names(PROSE).includes('Lechaeum'));
  assert.ok(names(PROSE).includes('Kenchreai'), 'control');
  assert.deepEqual(examples(PTR, 'tei-place-no-ref'), ['Ὀλυμπία (key olympia)', 'Ἐπίδαυρος']);
  // a name inside a referenced place name is part of it, and is not reported
  assert.ok(!examples(PROSE, 'tei-place-no-ref').includes('Sikyon'));
  assert.ok(names(PROSE).includes('Sikyon'), 'control: the place name around it is converted');
});
test('a place name in the teiHeader (where the inscription was found) is reported, not converted; one in the text is', () => {
  assert.deepEqual(examples(ISIC, 'tei-place-outside-text'), [
    'teiHeader: Syracusae (http://pleiades.stoa.org/places/462503)',
    'teiHeader: Siracusa (http://sws.geonames.org/2523083)',
    'teiHeader: catacomb of S. Giovanni (https://pleiades.stoa.org/places/560149180)',
  ]);
  assert.ok(!about(ISIC).includes('http://pleiades.stoa.org/places/462503') && !names(ISIC).includes('Syracusae'));
  assert.ok(names(ISIC).includes('Μάκρης κώμης'), 'control');
});
test('a prefix with no prefixDef, and a prefix that expands to something not a web address, are reported', () => {
  assert.deepEqual(examples(PTR, 'tei-ref-prefix'), ['xx:1 (Μέγαρα)']);
  assert.ok(!names(PTR).includes('Μέγαρα'));
  assert.deepEqual(examples(PTR, 'tei-ref-not-web'), ['gn:264371 (Ἀθῆναι): expands to urn:geonames:264371', 'urn:cts:greekLit:tlg0525 (Παυσανίας)']);
  assert.ok(!names(PTR).includes('Ἀθῆναι') && !names(PTR).includes('Παυσανίας'));
  assert.ok(names(PTR).includes('Κόρινθος'), 'control: pl: in the same file is expanded');
});
test('a local ref to a place with no web address is reported; one with a web address beside it is resolved', () => {
  assert.deepEqual(examples(PTR, 'tei-ref-local'), ['#nowhere', '#missing (no place with this id in the file)']);
  assert.ok(!names(PTR).includes('Νεφελοκοκκυγία'));
  assert.ok(names(PTR).includes('Ἀθηνῶν'), 'control');
});
test('a local ref to a place with several web addresses carries nothing over, and lists them', () => {
  assert.deepEqual(examples(PTR, 'tei-ref-ambiguous'), ['#thebes: https://pleiades.stoa.org/places/541138, https://www.wikidata.org/entity/Q192393']);
  assert.ok(!names(PTR).includes('Θῆβαι'));
  assert.ok(!about(PTR).includes('https://pleiades.stoa.org/places/541138') && !about(PTR).includes('https://www.wikidata.org/entity/Q192393'));
  assert.ok(about(PTR).includes('https://pleiades.stoa.org/places/579885'), 'control: #athens, with one address, is resolved');
});
test('a ref into another file is reported', () => {
  assert.deepEqual(examples(PTR, 'tei-ref-relative'), ['places.xml#delphi (Δελφοί)']);
  assert.ok(!names(PTR).includes('Δελφοί'));
  assert.ok(names(PTR).includes('Ἀθηνῶν'), 'control');
});
test("a list of places: its names and locations are reported once per place, not converted", () => {
  assert.deepEqual(examples(PTR, 'tei-listplace-names'), ['#athens: Athenae', '#nowhere: Nephelokokkygia', '#sparta: Lacedaemon']);
  assert.deepEqual(examples(PTR, 'tei-listplace-geo'), ['#athens: 37.97 23.72']);
  assert.ok(!names(PTR).includes('Athenae') && !names(PTR).includes('Lacedaemon'));
  assert.ok(PTR.doc.attestations.every((a) => a.geometries === undefined));
  assert.ok(names(PTR).includes('Ἀθηνῶν') && names(PTR).includes('Σπάρτη'), 'control: the names in the text that point to them are converted');
});
test('an xml:lang that is not a language tag is reported and not carried; a good one beside it is', () => {
  assert.deepEqual(examples(VERSE, 'tei-lang-not-tag'), ['Latin']);
  const b = VERSE.doc.attestations.find((a) => a.names[0].toponym === 'Belgarum');
  assert.deepEqual(b.names, [{ toponym: 'Belgarum' }]);
  assert.equal(VERSE.doc.attestations.find((a) => a.names[0].toponym === 'Dumnissum').names[0].language, 'la', 'control');
});
test('a licence in words only, and an edition with no web address, are reported; the source keeps its title', () => {
  assert.deepEqual(examples(VERSE, 'tei-licence-not-address'), ['Free to use for any purpose.']);
  assert.deepEqual(examples(VERSE, 'tei-source-no-address'), ['Verses on the Rivers of Gaul']);
  assert.deepEqual(VERSE.doc.attestations[0].citations[0].source, { title: 'Verses on the Rivers of Gaul', authorityType: 'source' });
  // control: an edition with a licence and an address carries both, and neither is reported
  assert.deepEqual([PROSE.kinds.has('tei-licence-not-address'), PROSE.kinds.has('tei-source-no-address')], [false, false]);
  assert.ok(PROSE.doc.attestations[0].citations[0].source.licence && PROSE.doc.attestations[0].citations[0].source['@id']);
});
test('several originals in the sourceDesc: the first is derivedFrom, the others reported', () => {
  assert.deepEqual(examples(PTR, 'tei-sourcedesc-several'), ['Second witness']);
  assert.deepEqual(PTR.doc.attestations[0].citations[0].source.derivedFrom, { title: 'First witness', authorityType: 'source' });
});
test('a ref with several web addresses gives one attestation each, a note naming them, and a warning', () => {
  assert.deepEqual(examples(PROSE, 'tei-ref-several'), ['<placeName> on line 35: https://pleiades.stoa.org/places/570536, https://sws.geonames.org/257880/']);
  const k = PROSE.doc.attestations.filter((a) => a.names[0].toponym === 'Kenchreai');
  assert.deepEqual(k.map((a) => a.about), ['https://pleiades.stoa.org/places/570536', 'https://sws.geonames.org/257880/']);
  assert.ok(k.every((a) => a.notes.startsWith('The ref of this place name gives 2 addresses, each an attestation of its own: ')));
  assert.equal(examples(PROSE, 'tei-ref-several').length, 1, 'control: the single-address names in the same file raise no warning');
});
test('a file with no place name that points to a place says so; one with such names does not', () => {
  const m = mapped(tei('<p><placeName>Athenae</placeName></p>'));
  assert.deepEqual([m.doc.attestations.length, examples(m, 'tei-none-linked')], [0, ['1 place name in the text']]);
  assert.equal(PROSE.kinds.has('tei-none-linked'), false, 'control');
});
// ---- variant readings: place names inside <app> and <choice> ---------------------------------------
const PL = (id) => `https://pleiades.stoa.org/places/${id}`;
const pn = (id, words) => `<placeName ref="${PL(id)}">${words}</placeName>`;
test('app: a place name in the lemma is an attestation; one wholly inside an rdg is not, and is reported once', () => {
  const m = mapped(tei(`<p><app><lem>${pn(1, 'Roma')}</lem><rdg>${pn(2, 'Remus')}</rdg></app> <app><lem>${pn(1, 'Roma')}</lem><rdg>${pn(2, 'Remus')}</rdg></app></p>`));
  assert.deepEqual(about(m), [PL(1), PL(1)], 'the lemmas are taken');
  assert.deepEqual(examples(m, 'tei-variant'), [`rdg: Remus (<placeName> ref="${PL(2)}" on line 2)`]);
  // An rdg with no lem beside it is still a variant; a place name with no ref in one is a variant too.
  const r = mapped(tei(`<p><app><rdg>${pn(3, 'Veii')}</rdg><rdg><placeName>Gabii</placeName></rdg></app> ${pn(4, 'Ostia')}</p>`));
  assert.deepEqual(about(r), [PL(4)], 'control: the place name outside the app is taken');
  assert.deepEqual(examples(r, 'tei-variant').map((e) => e.split(' (')[0]), ['rdg: Veii', 'rdg: Gabii']);
  assert.ok(!r.kinds.has('tei-place-no-ref'));
});
test('choice: of two place names, the one in the part taken is the attestation, and the one printed its sourceLabel', () => {
  for (const [printed, edited] of [['orig', 'reg'], ['abbr', 'expan'], ['sic', 'corr']]) {
    // The review's case, in each order of the parts.
    for (const body of [`<choice><${printed}>${pn(1, 'Rhoma')}</${printed}><${edited}>${pn(1, 'Roma')}</${edited}></choice>`,
      `<choice><${edited}>${pn(1, 'Roma')}</${edited}><${printed}>${pn(1, 'Rhoma')}</${printed}></choice>`]) {
      const m = mapped(tei(`<p>${body}</p>`));
      assert.deepEqual(m.doc.attestations.map((a) => [a.about, a.names[0].toponym, a.names[0].sourceLabel]), [[PL(1), 'Roma', 'Rhoma']], body);
      assert.ok(!m.kinds.has('tei-variant'), body);
    }
    // Pointing at another place, the part not taken is a variant, reported.
    const v = mapped(tei(`<p><choice><${printed}>${pn(2, 'Rhoma')}</${printed}><${edited}>${pn(1, 'Roma')}</${edited}></choice></p>`));
    assert.deepEqual(v.doc.attestations.map((a) => [a.about, a.names[0].toponym, a.names[0].sourceLabel]), [[PL(1), 'Roma', undefined]]);
    assert.deepEqual(examples(v, 'tei-variant'), [`${printed}: Rhoma (<placeName> ref="${PL(2)}" on line 2)`]);
    // Only in the part not taken: nothing converted, the variant reported.
    const o = mapped(tei(`<p><choice><${printed}>${pn(2, 'Rhoma')}</${printed}><${edited}>Roma</${edited}></choice> ${pn(5, 'Capua')}</p>`));
    assert.deepEqual(about(o), [PL(5)], `control (${printed}): the place name after the choice is taken`);
    assert.deepEqual(examples(o, 'tei-variant').map((e) => e.split(' (')[0]), [`${printed}: Rhoma`]);
  }
});
test('choice: with one part only, that part is taken; the same name spelt the same in both parts is one attestation', () => {
  const m = mapped(tei(`<p><choice><orig>${pn(1, 'Rhoma')}</orig></choice></p>`));
  assert.deepEqual(m.doc.attestations.map((a) => [a.about, a.names[0].toponym]), [[PL(1), 'Rhoma']]);
  assert.ok(!m.kinds.has('tei-variant'));
  const s = mapped(tei(`<p><choice><orig>${pn(1, 'Roma')}</orig><reg>${pn(1, 'Roma')}</reg></choice></p>`));
  assert.deepEqual(s.doc.attestations.map((a) => [a.about, a.names[0].toponym, a.names[0].sourceLabel]), [[PL(1), 'Roma', undefined]]);
  assert.ok(!s.kinds.has('tei-variant'));
});
test('a choice inside an rdg, and an app inside the part of a choice not taken: variants however deep', () => {
  const m = mapped(tei(`<p><app><lem>${pn(1, 'Roma')}</lem><rdg><choice><orig>${pn(2, 'Rhemus')}</orig><reg>${pn(2, 'Remus')}</reg></choice></rdg></app>`
    + `<choice><orig><app><lem>${pn(3, 'Ueii')}</lem></app></orig><reg>${pn(4, 'Veii')}</reg></choice></p>`));
  assert.deepEqual(about(m), [PL(1), PL(4)]);
  assert.deepEqual(examples(m, 'tei-variant').map((e) => e.split(' (')[0]), ['rdg: Remus', 'orig: Ueii']);
});
// ---- entities declared in the file's own DOCTYPE ------------------------------------------------------
const withDoctype = (decls, body) => tei(body).replace('<TEI ', `<!DOCTYPE TEI [${decls}]>\n<TEI `);
test('entities the file declares with their text in its DOCTYPE are read; one it does not declare is refused, saying so', () => {
  const m = mapped(withDoctype('<!ENTITY nbsp "&#160;"><!ENTITY rom "Ro&#x6D;a"><!ENTITY % param "ignored">', `<p>${pn(1, '&rom;&nbsp;Nova')}</p>`));
  assert.deepEqual(m.doc.attestations.map((a) => a.names[0].toponym), ['Roma Nova']);
  assert.throws(() => mapped(tei(`<p>${pn(1, 'Roma&nbsp;Nova')}</p>`)), (e) => e instanceof DataError && /does not declare/.test(e.message) && /own DOCTYPE/.test(e.message));
  assert.throws(() => mapped(withDoctype('<!ENTITY hi "<hi>Roma</hi>">', `<p>${pn(1, '&hi;')}</p>`)), (e) => e instanceof DataError && /not supported yet/.test(e.message));
});
test('an external entity is never read: using one stops the file, saying why; declaring one and not using it is harmless', () => {
  const ext = '<!ENTITY secret SYSTEM "file:///etc/hostname"><!ENTITY web PUBLIC "-//X//EN" "https://example.org/x.ent">';
  for (const e of ['secret', 'web']) {
    assert.throws(() => mapped(withDoctype(ext, `<p>${pn(1, `&${e};`)}</p>`)), (x) => x instanceof DataError && x.message.includes(`&${e};`) && /never read, for safety/.test(x.message), e);
  }
  const ok = mapped(withDoctype(ext, `<p>${pn(1, 'Roma')}</p>`));
  assert.deepEqual(ok.doc.attestations.map((a) => a.names[0].toponym), ['Roma'], 'control: the same DOCTYPE, the entities unused');
});
test('every kind the reader reports has words, and a severity the report knows', () => {
  for (const [k, sev] of Object.entries(TEI_KINDS)) {
    assert.ok(LOSS_TEXT[k], k);
    assert.ok(['loss', 'warning', 'error'].includes(sev), k);
    assert.ok(!/contribution|submission/i.test(LOSS_TEXT[k]), k);
  }
  // and every kind the fixtures raise is one of them
  const raised = new Set([ISIC, PROSE, VERSE, PTR, WHG].flatMap((m) => [...m.kinds]));
  for (const k of raised) assert.ok(k in TEI_KINDS, k);
  assert.ok(raised.size >= 18, [...raised].join(', '));
});

// ---- the source generator, as the pipeline will call it ------------------------------------------
test('teiSource yields the header first, then numbered attestations, and reports with the kinds\' severities and words', async () => {
  const rep = new Report();
  const evs = [];
  for await (const ev of teiSource({ format: 'tei', files: [file('pointers-constructed.xml')] }, rep)) evs.push(ev);
  assert.equal(evs[0].type, 'header');
  assert.equal(evs.filter((e) => e.type === 'header').length, 1);
  const atts = evs.filter((e) => e.type === 'attestation');
  assert.deepEqual(atts.map((e) => e.value), PTR.doc.attestations);
  assert.deepEqual(atts.map((e) => e.n), atts.map((_, i) => i + 1));
  const r = rep.toJSON();
  assert.equal(r.counts['place names'], 17);
  assert.equal(summary(r).counted, 'Read 17 place names.');
  for (const i of r.items) { assert.equal(i.severity, TEI_KINDS[i.kind], i.kind); assert.equal(i.message, LOSS_TEXT[i.kind], i.kind); }
  assert.equal(r.items.find((i) => i.kind === 'tei-ref-local').count, 2);
  assert.equal(summary({ counts: { 'place names': 1 } }).counted, 'Read 1 place name.');
});

// ---- detection, and files that cannot be read ------------------------------------------------------
test('detected as TEI: a prefixed root, a teiCorpus, a DOCTYPE and comments before the root', async () => {
  const cases = {
    'prefixed.xml': '<?xml version="1.0"?>\n<tei:TEI xmlns:tei="http://www.tei-c.org/ns/1.0"><tei:teiHeader/></tei:TEI>',
    'corpus.tei': '<teiCorpus xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></teiCorpus>',
    'doctype.xml': '<?xml version="1.0"?>\n<!-- a comment -->\n<!DOCTYPE TEI [ <!ENTITY x "y"> ]>\n<TEI xml:lang="en"\n  xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></TEI>',
  };
  for (const [name, s] of Object.entries(cases)) assert.equal((await detect([textFile(s, name)])).format, 'tei', name);
});
test('not detected as TEI: other XML, RDF/XML, TEI with no namespace or another one, TEI P4', async () => {
  const cases = {
    'other.xml': '<?xml version="1.0"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>',
    'rdf.xml': '<?xml version="1.0"?>\n<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="https://example.org/x"/></rdf:RDF>',
    'nons.xml': '<?xml version="1.0"?>\n<TEI><teiHeader/></TEI>',
    'otherns.xml': '<TEI xmlns="http://example.org/not-tei"><teiHeader/></TEI>',
    'teins-child.xml': '<root xmlns:t="http://www.tei-c.org/ns/1.0"><t:TEI/></root>',
    'p4.xml': '<?xml version="1.0"?>\n<TEI.2><teiHeader/></TEI.2>',
  };
  for (const [name, s] of Object.entries(cases)) assert.notEqual((await detect([textFile(s, name)])).format, 'tei', name);
  // control: the same test sees TEI when it is there
  assert.equal((await detect([file('prose-constructed.xml')])).format, 'tei');
});
test('what was detected before is detected as before', async () => {
  for (const f of readdirSync('test/fixtures/annotations').filter((x) => /\.json(ld)?$/.test(x))) {
    assert.equal((await detect([new File([readFileSync(`test/fixtures/annotations/${f}`)], f)])).format, 'w3c-annotations', f);
  }
  for (const f of ['lpf-readme-example.json', 'lpf-sample-v1.2.2.geojson']) assert.equal((await detect([new File([readFileSync(`test/fixtures/${f}`)], f)])).format, 'lpf', f);
  const nt = '<https://example.org/a> <https://example.org/p> <https://example.org/b> .\n';
  assert.equal((await detect([textFile(nt, 'x.txt')])).format, 'ntriples');
  assert.equal((await detect([textFile('@prefix ex: <https://example.org/> .\nex:a ex:p ex:b .\n', 'x.txt')])).format, 'turtle');
  assert.equal((await detect([textFile('{"profile":"attestation-centric","attestations":[]}', 'x.json')])).format, 'plato-json');
});
test('XML cut short, or not well formed, is a DataError; the whole file reads', async () => {
  const s = text('prose-constructed.xml');
  const cut = s.slice(0, Math.floor(s.length / 2));
  assert.throws(() => teiToDocument(cut), DataError);
  await assert.rejects(async () => { for await (const _ of teiSource({ files: [textFile(cut, 'cut.xml')] }, new Report())); }, DataError);
  const bad = s.replace('</settlement>', '</region>');
  assert.throws(() => teiToDocument(bad), (e) => e instanceof DataError && /not well formed/.test(e.message));
  assert.throws(() => teiToDocument(''), DataError);
  // control: the whole file reads, through the stream as well
  assert.ok(teiToDocument(s).attestations.length > 0);
  let n = 0;
  for await (const ev of teiSource({ files: [textFile(s, 'whole.xml')] }, new Report())) if (ev.type === 'attestation') n++;
  assert.equal(n, 6);
});
test('XML that is not TEI, or says it is not UTF-8, is a DataError in the reader', () => {
  assert.throws(() => teiToDocument('<root><placeName ref="https://example.org/p">X</placeName></root>'), (e) => e instanceof DataError && /not TEI/.test(e.message));
  assert.throws(() => teiToDocument('<?xml version="1.0" encoding="ISO-8859-1"?>\n' + tei('<p/>').replace(/^<\?xml[^>]*>\n/, '')), (e) => e instanceof DataError && /ISO-8859-1/.test(e.message));
  // control: a UTF-8 declaration, and none, read
  assert.equal(teiToDocument(tei('<p><placeName ref="https://example.org/p">X</placeName></p>')).attestations.length, 1);
  assert.equal(teiToDocument(tei('<p><placeName ref="https://example.org/p">X</placeName></p>').replace(/^<\?xml[^>]*>\n/, '')).attestations.length, 1);
});

// ---- World Historical Gazetteer addresses (src/engine/hermes/addresses.js) ------------------------
const whgAbout = (toponym) => WHG.doc.attestations.filter((a) => a.names[0].toponym === toponym).map((a) => [a.about, a.notes.split('\n')[0]]);
test('a WHG reconciliation id (place:gn:…) and a WHG entity page are carried as the w3id address, with a note of what was written', () => {
  assert.deepEqual(whgAbout('Paris'), [['https://w3id.org/whg/id/place:gn:2988507', 'Place address given as place:gn:2988507']]);
  assert.deepEqual(whgAbout('Marseille'), [['https://w3id.org/whg/id/place:gn:2995469', 'Place address given as https://whgazetteer.org/entity/place:gn:2995469/api']]);
  assert.ok(!examples(WHG, 'tei-ref-prefix').some((e) => e.startsWith('place:')), 'place:gn:… is no longer an unexpanded prefix');
  // control: an address WHG does not rewrite is carried as written, with no such note
  assert.deepEqual(whgAbout('Lyon'), [['https://whgazetteer.org/places/12345999/portal/', 'From TEI element <placeName> on line 16 of whg-constructed.xml']]);
});
test('a declared prefixDef, even with the ident "place", wins over the WHG form', () => {
  const header = '<teiHeader><fileDesc><titleStmt><title>T</title></titleStmt><publicationStmt><idno type="URI">https://example.org/e</idno></publicationStmt><sourceDesc><p>x</p></sourceDesc></fileDesc>'
    + '<encodingDesc><listPrefixDef><prefixDef ident="place" matchPattern="gn:([0-9]+)" replacementPattern="https://sws.geonames.org/$1/"/></listPrefixDef></encodingDesc></teiHeader>';
  const m = mapped(tei('<p><placeName ref="place:gn:2988507">Paris</placeName></p>', header));
  assert.deepEqual(m.doc.attestations.map((a) => [a.about, a.notes]), [['https://sws.geonames.org/2988507/', 'From TEI element <placeName ref="place:gn:2988507"> on line 2 of test.xml']]);
  // control: without the prefixDef, the same ref is WHG's
  assert.equal(mapped(tei('<p><placeName ref="place:gn:2988507">Paris</placeName></p>')).doc.attestations[0].about, 'https://w3id.org/whg/id/place:gn:2988507');
});
test('a WHG database-record address and a staging address are reported, not carried', () => {
  assert.deepEqual(examples(WHG, 'tei-whg-record'), ['https://whgazetteer.org/places/6421/portal/ (Toulouse)']);
  assert.deepEqual(examples(WHG, 'tei-whg-staging'), ['https://dev.whgazetteer.org/places/12400000/portal/ (Nice)', '#nantes: https://dev.whgazetteer.org/places/12400001/portal/']);
  assert.ok(!names(WHG).includes('Toulouse') && !names(WHG).includes('Nice') && !names(WHG).includes('Nantes'));
  assert.ok(names(WHG).includes('Lyon'), 'control: a WHG cluster address in the range of whg_ids is carried');
});
test('an idno in a list of places passes through the same rewriting: place:gn:… becomes the w3id address', () => {
  assert.deepEqual(whgAbout('Bordeaux'), [['https://w3id.org/whg/id/place:gn:3031582', 'Place address given as place:gn:3031582']]);
  // control: a place whose only idno is refused has no address, and says so
  assert.deepEqual(examples(WHG, 'tei-ref-local'), ['#nantes']);
});
test('attributes of a place name not read are reported once per attribute and value; cert is not taken for certainty', () => {
  assert.deepEqual(examples(WHG, 'tei-attribute'), ['placeName@cert="low"', 'placeName@type="modern"', 'placeName@resp="#ed"', 'place@type="city"']);
  const b = WHG.doc.attestations.find((a) => a.names[0].toponym === 'Bourges');
  assert.deepEqual([b.certainty, b.certaintyLevel], [undefined, undefined]);
  // control: the attributes that are read are not reported: ref, xml:lang, and type on <rs type="place">
  assert.ok(!examples(WHG, 'tei-attribute').some((e) => /@ref=|@xml:lang|^rs@type/.test(e)));
  assert.ok(names(WHG).includes('Amiens') && names(WHG).includes('Grenoble'));
  assert.deepEqual(examples(ISIC, 'tei-attribute'), ['placeName@type="ancient"']);
});
test("a place's description, note, and an idno that is not an address are reported, once each", () => {
  assert.deepEqual(examples(WHG, 'tei-place-content'), ['#bordeaux: <desc>', '#bordeaux: <note>']);
  assert.deepEqual(examples(PTR, 'tei-place-content'), ['#nowhere: <idno type="local"> N1']);
  // control: a place's idno that is an address, its names and its location are not reported as content
  assert.ok(!examples(PTR, 'tei-place-content').some((e) => /#athens|#thebes|#sparta/.test(e)));
});
