// A place's address put into the form PLATO's `about` should carry (src/engine/hermes/addresses.js),
// alone and as the Recogito, TEI and CSV/GeoJSON readers use it. Every test of an absence has a
// presence beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { placeAddress, canonicalAddress, addressNote, ADDRESS_RULES } from '../src/engine/hermes/addresses.js';
import { annotationsToDocument, ANNOTATION_KINDS } from '../src/formats/annotations.js';
import { teiToDocument, TEI_KINDS } from '../src/engine/hermes/tei.js';
import { genericSource } from '../src/engine/hermes/generic.js';
import { GENERIC_KINDS } from '../src/engine/hermes/columns.js';
import { detect } from '../src/engine/input.js';
import { Report, LOSS_TEXT } from '../src/engine/report.js';

const W3ID = 'https://w3id.org/whg/id/';

test('WHG record ids and entity pages become the persistent address, saying what was written', () => {
  assert.deepEqual(placeAddress('place:gn:2988507'), { iri: `${W3ID}place:gn:2988507`, from: 'place:gn:2988507', rules: ['whg-record-id'] });
  assert.deepEqual(placeAddress('place:whg:42:abc-1'), { iri: `${W3ID}place:whg:42:abc-1`, from: 'place:whg:42:abc-1', rules: ['whg-record-id'] });
  for (const v of ['https://whgazetteer.org/entity/place:wd:Q90/api', 'https://whgazetteer.org/entity/place:wd:Q90/', 'https://whgazetteer.org/entity/place:wd:Q90'])
    assert.deepEqual(placeAddress(v), { iri: `${W3ID}place:wd:Q90`, from: v, rules: ['whg-entity-page'] }, v);
  // control: the persistent address itself, and addresses from elsewhere, pass through unchanged
  assert.deepEqual(placeAddress(`${W3ID}place:gn:2988507`), { iri: `${W3ID}place:gn:2988507` });
  assert.deepEqual(placeAddress('https://pleiades.stoa.org/places/579885'), { iri: 'https://pleiades.stoa.org/places/579885' });
});

test('a legacy cluster address is kept as written; the same path with a record key is refused', () => {
  for (const v of ['https://whgazetteer.org/places/12345678/portal', 'https://whgazetteer.org/places/13000001/portal/'])
    assert.deepEqual(placeAddress(v), { iri: v }, v);
  assert.deepEqual(placeAddress('https://whgazetteer.org/places/12345677/portal'), { lost: 'whg-portal-record', value: 'https://whgazetteer.org/places/12345677/portal' });
  assert.deepEqual(placeAddress('https://dev.whgazetteer.org/entity/place:gn:1/api'), { lost: 'whg-staging', value: 'https://dev.whgazetteer.org/entity/place:gn:1/api' });
});

test('"whg:<n>" and bare numbers are not guessed at', () => {
  assert.deepEqual(placeAddress('whg:13000001'), { iri: 'whg:13000001' });
  assert.deepEqual(placeAddress('13000001'), { iri: '13000001' });
});

// A Recogito Studio geotag, as its WHG connector writes it: the whole WHG feature, id a portal URL.
const studio = (id) => ({ '@context': 'http://www.w3.org/ns/anno.jsonld', id: 'https://example.org/anno/1', type: 'Annotation',
  body: [{ type: 'Dataset', purpose: 'geotagging', creator: 'https://example.org/me', value: { type: 'Feature', id, properties: {} } }],
  target: { source: 'https://example.org/doc', selector: { type: 'TextQuoteSelector', exact: 'Ancyra' } } });
function mappedTei(body) {
  const reported = [];
  const doc = teiToDocument(`<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt><title>T</title></titleStmt><publicationStmt><idno type="URI">https://example.org/e</idno></publicationStmt><sourceDesc><p>x</p></sourceDesc></fileDesc></teiHeader><text><body>${body}</body></text></TEI>
`,
    'test.xml', (kind, example) => reported.push([kind, example]));
  return { doc, reported, kinds: new Set(reported.map(([k]) => k)) };
}
function mapped(items) {
  const reported = [];
  const doc = annotationsToDocument(items, 'test.json', (kind, example) => reported.push([kind, example]));
  return { doc, reported };
}

test('the Recogito reader refuses a WHG record key in a cluster address, and keeps a cluster address beside it', () => {
  const bad = mapped([studio('https://whgazetteer.org/places/6000123/portal')]);
  assert.deepEqual(bad.doc.attestations.length, 0);
  assert.deepEqual(bad.reported.filter(([k]) => k === 'annotation-whg-record'), [['annotation-whg-record', 'https://example.org/anno/1: https://whgazetteer.org/places/6000123/portal']]);
  assert.ok(!bad.reported.some(([k]) => k === 'annotation-no-place'), 'not reported a second time as having no place');
  const ok = mapped([studio('https://whgazetteer.org/places/13000001/portal')]);
  assert.deepEqual(ok.doc.attestations.map((a) => a.about), ['https://whgazetteer.org/places/13000001/portal'], 'control: a cluster address is converted');
  assert.ok(!ok.reported.some(([k]) => k === 'annotation-whg-record'));
});

test('the Recogito reader writes a WHG entity page as the persistent address, noting what was written', () => {
  const m = mapped([studio('https://whgazetteer.org/entity/place:gn:2988507/api')]);
  assert.deepEqual(m.doc.attestations.map((a) => a.about), [`${W3ID}place:gn:2988507`]);
  assert.match(m.doc.attestations[0].notes, /^Place address given as https:\/\/whgazetteer\.org\/entity\/place:gn:2988507\/api \(rule whg-entity-page, hermes-addresses 1\)$/m);
  const plain = mapped([studio('https://pleiades.stoa.org/places/579885')]);
  assert.ok(!/Place address given as/.test(plain.doc.attestations[0].notes || ''), 'control: an address left as it was gets no such note');
});

test('a staging address is refused', () => {
  const m = mapped([studio('https://dev.whgazetteer.org/entity/place:gn:2988507/api')]);
  assert.deepEqual([m.doc.attestations.length, m.reported.filter(([k]) => k === 'annotation-whg-staging').length], [0, 1]);
});

// ---- canonical addresses (hermes-addresses 1) --------------------------------------------------
// One row per rule: the rule, an address as a source writes it, and the address carried. The last
// column is also the presence control: written so, it is carried unchanged, with no note.
const RULES = [
  ['pleiades-https', 'http://pleiades.stoa.org/places/579885', 'https://pleiades.stoa.org/places/579885'],
  ['pleiades-slash', 'https://pleiades.stoa.org/places/579885/', 'https://pleiades.stoa.org/places/579885'],
  ['geonames-page', 'https://www.geonames.org/2523083/siracusa.html', 'https://sws.geonames.org/2523083/'],
  ['geonames-https', 'https://sws.geonames.org/2523083', 'https://sws.geonames.org/2523083/'],
  ['geonames-sws-https', 'http://sws.geonames.org/2523083/', 'https://sws.geonames.org/2523083/'],
  ['wikidata-page', 'https://www.wikidata.org/wiki/Q220', 'http://www.wikidata.org/entity/Q220'],
  ['wikidata-https', 'https://www.wikidata.org/entity/Q220', 'http://www.wikidata.org/entity/Q220'],
  ['whg-record-id', 'place:gn:2988507', `${W3ID}place:gn:2988507`],
  ['whg-entity-page', 'https://whgazetteer.org/entity/place:gn:2988507/api', `${W3ID}place:gn:2988507`],
];
const NOTE = /^Place address given as /m;
// The three readers, each given one address: { about, notes, reported } of the one attestation made.
const viaTei = (v) => {
  const m = mappedTei(`<p><placeName ref="${v}">X</placeName></p>`);
  assert.equal(m.doc.attestations.length, 1, `TEI: ${v}`);
  return { about: m.doc.attestations[0].about, notes: m.doc.attestations[0].notes, reported: m.reported };
};
const viaCsv = async (v) => {
  const rep = new Report(), evs = [];
  for await (const ev of genericSource(await detect([new File([`name,address\nX,${v}\n`], 'x.csv')]), rep, { columns: { name: 'name', address: 'address' } })) evs.push(ev);
  const atts = evs.filter((e) => e.type === 'attestation');
  assert.equal(atts.length, 1, `CSV: ${v}`);
  return { about: atts[0].value.about, notes: atts[0].value.notes || '', reported: rep.toJSON().items.flatMap((i) => i.examples.map((e) => [i.kind, e])) };
};
const viaRecogito = (v) => {
  const m = mapped([studio(v)]);
  assert.equal(m.doc.attestations.length, 1, `Recogito: ${v}`);
  return { about: m.doc.attestations[0].about, notes: m.doc.attestations[0].notes || '', reported: m.reported };
};

for (const [rule, given, carried] of RULES) {
  test(`rule ${rule}: ${given} is carried as ${carried}, noting what was written; ${carried} itself is carried unchanged, with no note`, async () => {
    assert.deepEqual(placeAddress(given), { iri: carried, from: given, rules: [rule] });
    assert.deepEqual(placeAddress(carried), { iri: carried }, 'control: the canonical address is left as it is');
    const note = `Place address given as ${given} (rule ${rule}, hermes-addresses 1)`;
    const readers = [['TEI', viaTei], ['CSV', viaCsv], ...(given.startsWith('http') ? [['Recogito', viaRecogito]] : [])];
    for (const [name, via] of readers) {
      const r = await via(given), c = await via(carried);
      assert.equal(r.about, carried, name);
      assert.ok(r.notes.split('\n').includes(note), `${name}: ${r.notes}`);
      assert.equal(c.about, carried, `${name}, control`);
      assert.doesNotMatch(c.notes, NOTE, `${name}, control: no note`);
    }
  });
}

test('rule wikidata-https also takes the entity address without www., by http or https; the canonical address is left as it is', async () => {
  const CANON = 'http://www.wikidata.org/entity/Q42';
  for (const given of ['https://wikidata.org/entity/Q42', 'http://wikidata.org/entity/Q42', 'https://www.wikidata.org/entity/Q42']) {
    assert.deepEqual(placeAddress(given), { iri: CANON, from: given, rules: ['wikidata-https'] }, given);
    for (const [name, via] of [['TEI', viaTei], ['CSV', viaCsv], ['Recogito', viaRecogito]]) {
      const r = await via(given);
      assert.equal(r.about, CANON, `${name}: ${given}`);
      assert.ok(r.notes.split('\n').includes(`Place address given as ${given} (rule wikidata-https, hermes-addresses 1)`), `${name}: ${r.notes}`);
    }
  }
  assert.deepEqual(placeAddress(CANON), { iri: CANON }, 'control: the canonical address, with no note');
  assert.deepEqual(placeAddress('https://wikidata.org/entity/P31'), { iri: 'https://wikidata.org/entity/P31' }, 'not a place: left as written');
});

test('an address two rules apply to names both in its note', () => {
  const r = placeAddress('http://pleiades.stoa.org/places/579885/');
  assert.deepEqual(r, { iri: 'https://pleiades.stoa.org/places/579885', from: 'http://pleiades.stoa.org/places/579885/', rules: ['pleiades-https', 'pleiades-slash'] });
  assert.equal(addressNote(r), 'Place address given as http://pleiades.stoa.org/places/579885/ (rules pleiades-https and pleiades-slash, hermes-addresses 1)');
  assert.equal(viaTei('http://pleiades.stoa.org/places/579885/').about, 'https://pleiades.stoa.org/places/579885');
});

test('addresses the rules do not name are carried as written', () => {
  for (const v of ['http://dare.ht.lu.se/places/10783', 'https://pleiades.stoa.org/places/579885?x=1', 'https://sws.geonames.org/2523083/about.rdf', 'http://www.wikidata.org/entity/Q220', 'https://www.wikidata.org/wiki/Special:Search'])
    assert.deepEqual(canonicalAddress(v), { iri: v }, v);
  assert.deepEqual(canonicalAddress('http://pleiades.stoa.org/places/579885'), { iri: 'https://pleiades.stoa.org/places/579885', rules: ['pleiades-https'] }, 'control');
});

// Part of a Pleiades place's record: kept as given, and reported, by all three readers.
const PARTS = [
  ['https://pleiades.stoa.org/places/579885/athenae', 'part'],
  ['https://pleiades.stoa.org/places/579885/json', 'part'],
  ['https://pleiades.stoa.org/places/579885#this', 'this'],
  ['http://pleiades.stoa.org/places/579885/#this', 'this'],
];
test('part of a Pleiades place\'s record is carried as given, not rewritten, and reported by each reader', async () => {
  for (const [v, part] of PARTS) {
    assert.deepEqual(placeAddress(v), { iri: v, part }, v);
    for (const [name, via, where] of [['TEI', viaTei, ''], ['CSV', viaCsv, 'row 2: '], ['Recogito', viaRecogito, 'https://example.org/anno/1: ']]) {
      const r = await via(v);
      assert.equal(r.about, v, `${name}: ${v}`);
      assert.doesNotMatch(r.notes, NOTE, `${name}: not rewritten, so no note`);
      assert.ok(r.reported.some(([k, e]) => k === 'address-pleiades-part' && e.startsWith(`${where}${v}`)), `${name}: ${JSON.stringify(r.reported)}`);
      // control: the place's own address, in the same reader, is not reported
      const c = await via('https://pleiades.stoa.org/places/579885');
      assert.equal(c.about, 'https://pleiades.stoa.org/places/579885');
      assert.ok(!c.reported.some(([k]) => k === 'address-pleiades-part'), `${name}, control`);
    }
  }
  // A TEI list of places' idno too: the place name pointing to it is about the address as given.
  const listed = mappedTei('<p><placeName ref="#ath">Athenae</placeName></p><listPlace><place xml:id="ath"><idno type="URI">https://pleiades.stoa.org/places/579885#this</idno></place></listPlace>');
  assert.deepEqual(listed.doc.attestations.map((a) => a.about), ['https://pleiades.stoa.org/places/579885#this']);
  assert.ok(listed.reported.some(([k, e]) => k === 'address-pleiades-part' && e === '#ath: https://pleiades.stoa.org/places/579885#this'), JSON.stringify(listed.reported));
  for (const kinds of [TEI_KINDS, GENERIC_KINDS, ANNOTATION_KINDS]) assert.equal(kinds['address-pleiades-part'], 'warning');
  assert.match(LOSS_TEXT['address-pleiades-part'], /#this is not a part: it is the place in Pleiades' own data, written differently from its plain address/);
  assert.match(LOSS_TEXT['address-pleiades-part'], /a location, a name, or a format such as \/json/);
});

test('a TEI ref giving one Pleiades place as http and as https gives one attestation, and is not ambiguous', () => {
  for (const ref of ['http://pleiades.stoa.org/places/579885 https://pleiades.stoa.org/places/579885', 'https://pleiades.stoa.org/places/579885 http://pleiades.stoa.org/places/579885/']) {
    const m = mappedTei(`<p><placeName ref="${ref}">Athenae</placeName></p>`);
    assert.deepEqual(m.doc.attestations.map((a) => a.about), ['https://pleiades.stoa.org/places/579885'], ref);
    assert.ok(!m.kinds.has('tei-ref-ambiguous') && !m.kinds.has('tei-several-ids'), ref);
    assert.equal(m.doc.attestations[0].identities, undefined, ref);
  }
  // control: two Pleiades places in one ref are ambiguous (one gazetteer), and nothing is converted
  const two = mappedTei('<p><placeName ref="http://pleiades.stoa.org/places/579885 https://pleiades.stoa.org/places/541138">Athenae</placeName></p>');
  assert.deepEqual(two.doc.attestations, []);
  assert.ok(two.kinds.has('tei-ref-ambiguous'));
});

test('I.Sicily\'s GeoNames address, http://sws.geonames.org/2523083, is carried as https://sws.geonames.org/2523083/', () => {
  // Taken from the fixture as it is written there (in its header, so placed in a text to be read).
  const ref = /ref="(http:\/\/sws\.geonames\.org\/2523083)"/.exec(readFileSync('test/fixtures/tei/isicily-ISic000934.xml', 'utf8'));
  assert.ok(ref, 'the fixture writes it so');
  assert.deepEqual(placeAddress(ref[1]), { iri: 'https://sws.geonames.org/2523083/', from: ref[1], rules: ['geonames-sws-https'] });
  const r = viaTei(ref[1]);
  assert.equal(r.about, 'https://sws.geonames.org/2523083/');
  assert.equal(r.notes.split('\n')[0], 'Place address given as http://sws.geonames.org/2523083 (rule geonames-sws-https, hermes-addresses 1)');
});

// The Recogito fixtures before hermes-addresses 1 carried 97 addresses as written with http: 86 of
// Pleiades, 11 of GeoNames' sws (counted in the output of the commit before, by fixture below). Each
// is now carried in its canonical form, with a note; the 7 addresses of other gazetteers (DARE,
// geo-kima) and Recogito Studio's Wikidata entities, already canonical, are not touched.
const RECOGITO = {
  'recogito-studio-constructed.json': { attestations: 2 },
  'recogito-studio-regions-constructed.json': { attestations: 16 },
  'recogito-studio-regions-generated.json': { attestations: 16 },
  'recogito-v1-constructed.jsonld': { attestations: 3, 'pleiades-https': 3 },
  'recogito-v1-islandia-map.jsonld': { attestations: 2, 'geonames-sws-https': 2 },
  'recogito-v1-linked-traces-readme.json': { attestations: 2, 'pleiades-https': 1, 'geonames-sws-https': 1 },
  'recogito-v1-paulinus-csv.jsonld': { attestations: 42, 'pleiades-https': 42 },
  'recogito-v1-pliny-text.jsonld': { attestations: 55, 'pleiades-https': 40, 'geonames-sws-https': 8 },
};
test('the Recogito fixtures: every Pleiades and GeoNames address written with http is carried as https, each with its note', () => {
  const D = 'test/fixtures/annotations/';
  assert.deepEqual(readdirSync(D).filter((f) => /\.json(ld)?$/.test(f)).sort(), Object.keys(RECOGITO).sort(), 'every fixture is counted');
  let other = 0;
  for (const [f, want] of Object.entries(RECOGITO)) {
    const { doc } = mapped(JSON.parse(readFileSync(D + f, 'utf8')));
    const got = { attestations: doc.attestations.length };
    for (const a of doc.attestations) {
      const rule = /^Place address given as \S+ \(rule ([a-z-]+), hermes-addresses 1\)$/m.exec(a.notes || '');
      if (rule) got[rule[1]] = (got[rule[1]] || 0) + 1;
      if (/^http:\/\/(pleiades\.stoa\.org|sws\.geonames\.org)\//.test(a.about)) got.notCanonical = (got.notCanonical || 0) + 1;
      if (!/^https?:\/\/(pleiades\.stoa\.org|sws\.geonames\.org|www\.wikidata\.org)\//.test(a.about)) other++;
    }
    assert.deepEqual(got, want, f);
  }
  assert.equal(other, 7, 'control: the addresses of other gazetteers are there, and carried as written');
});

test('DEVELOPERS.md names the rules version the code has, with a row for every rule', () => {
  const doc = readFileSync('DEVELOPERS.md', 'utf8');
  // Read any version, so that a change to either side fails here rather than going unread.
  const m = /^#+ Address rules, (hermes-addresses \d+) \((\d{4}-\d{2}-\d{2})\)$/m.exec(doc);
  assert.ok(m, 'DEVELOPERS.md has the table "Address rules, hermes-addresses <n> (<date>)"');
  assert.equal(m[1], ADDRESS_RULES);
  const section = doc.slice(m.index + m[0].length).split(/^#+ /m)[0];
  const named = [...section.matchAll(/^\| `([a-z-]+)` \|/gm)].map((x) => x[1]);
  assert.deepEqual(named.sort(), RULES.map(([r]) => r).sort());
});

// Addresses that are not a place's record (real-data findings, 2026-10-01): on a gazetteer's own host,
// a list, search or map page, or a garbled address, is refused; a page of a site that is not a
// gazetteer is carried and reported. Each reader is given one address, beside a place's own as the control.
const allThree = async (v) => {
  const out = [];
  const tei = mappedTei(`<p><placeName ref="${v.replace(/&/g, '&amp;')}">X</placeName></p>`);
  out.push(['TEI', tei.doc.attestations.map((a) => a.about), tei.reported]);
  const rep = new Report(), evs = [];
  for await (const ev of genericSource(await detect([new File([`name,address\nX,${v}\n`], 'x.csv')]), rep, { columns: { name: 'name', address: 'address' } })) evs.push(ev);
  out.push(['CSV', evs.filter((e) => e.type === 'attestation').map((e) => e.value.about), rep.toJSON().items.flatMap((i) => i.examples.map((e) => [i.kind, e]))]);
  const rec = mapped([studio(v)]);
  out.push(['Recogito', rec.doc.attestations.map((a) => a.about), rec.reported]);
  return out;
};
const NOT_PLACES = [
  'http://pleiades.stoa.org/places/',      // IIP's header writes this when no place is known (an equivalent, not copied: IIP is CC BY-NC)
  'https://pleiades.stoa.org/places/',
  'https://pleiades.stoa.org/places/http://pleiades.stoa.org/places/687966/',
  'https://pleiades.stoa.org/',
  'https://www.geonames.org/maps/google_31.563_34.928.html',
  'https://www.geonames.org/search.html?q=haifa',
  'https://www.geonames.org/advanced-search.html?q=lviv&country=UA',
  'http://geonames.org/',
];
test('an address on a gazetteer\'s host that names no place\'s record is refused by every reader, as address-not-a-place', async () => {
  for (const v of NOT_PLACES) {
    assert.deepEqual(placeAddress(v), { lost: 'address-not-a-place', value: v }, v);
    for (const [name, abouts, reported] of await allThree(v)) {
      assert.deepEqual(abouts, [], `${name}: ${v}`);
      assert.ok(reported.some(([k, e]) => k === 'address-not-a-place' && e.includes(v)), `${name}: ${JSON.stringify(reported)}`);
    }
  }
  // controls: real record addresses, in every form the canonical rules take, are carried, and not reported
  for (const [v, carried] of [['https://pleiades.stoa.org/places/687966', 'https://pleiades.stoa.org/places/687966'], ['http://pleiades.stoa.org/places/677994', 'https://pleiades.stoa.org/places/677994'],
    ['https://pleiades.stoa.org/places/687966/', 'https://pleiades.stoa.org/places/687966'], ['https://www.geonames.org/294801/haifa.html', 'https://sws.geonames.org/294801/'],
    ['http://sws.geonames.org/2525448', 'https://sws.geonames.org/2525448/'], ['https://sws.geonames.org/2523083/about.rdf', 'https://sws.geonames.org/2523083/about.rdf']]) {
    assert.equal(placeAddress(v).lost, undefined, v);
    for (const [name, abouts, reported] of await allThree(v)) {
      assert.deepEqual(abouts, [carried], `${name}, control: ${v}`);
      assert.ok(!reported.some(([k]) => k === 'address-not-a-place'), `${name}, control: ${v}`);
    }
  }
  // Pleiades' parts keep their own treatment
  assert.deepEqual(placeAddress('https://pleiades.stoa.org/places/687966/json'), { iri: 'https://pleiades.stoa.org/places/687966/json', part: 'part' });
  for (const kinds of [TEI_KINDS, GENERIC_KINDS, ANNOTATION_KINDS]) { assert.equal(kinds['address-not-a-place'], 'loss'); assert.equal(kinds['address-web-page'], 'warning'); }
  assert.match(LOSS_TEXT['address-not-a-place'], /names a gazetteer's list, search or map page, or is garbled, not a place's record/);
});

test('an address of a TEI list of places\' idno that names no place is refused too, and the place name pointing to it gives nothing', () => {
  const m = mappedTei('<p><placeName ref="#p">X</placeName></p><listPlace><place xml:id="p"><idno type="URI">https://pleiades.stoa.org/places/</idno></place></listPlace>');
  assert.deepEqual(m.doc.attestations, []);
  assert.ok(m.reported.some(([k, e]) => k === 'address-not-a-place' && e === '#p: https://pleiades.stoa.org/places/'), JSON.stringify(m.reported));
  const c = mappedTei('<p><placeName ref="#p">X</placeName></p><listPlace><place xml:id="p"><idno type="URI">https://pleiades.stoa.org/places/687966</idno></place></listPlace>');
  assert.deepEqual(c.doc.attestations.map((a) => a.about), ['https://pleiades.stoa.org/places/687966'], 'control');
});

test('a web page that is not a gazetteer record is carried as given, and reported as address-web-page by every reader', async () => {
  for (const v of ['https://en.wikipedia.org/wiki/Haifa', 'https://de.wikipedia.org/wiki/Palazzo_Orsini_di_Gravina', 'https://goo.gl/maps/AbCdEf123', 'https://maps.app.goo.gl/AbCdEf123', 'https://www.google.com/maps/place/Haifa/']) {
    assert.deepEqual(placeAddress(v), { iri: v, page: true }, v);
    for (const [name, abouts, reported] of await allThree(v)) {
      assert.deepEqual(abouts, [v], `${name}: ${v}`);
      assert.ok(reported.some(([k, e]) => k === 'address-web-page' && e.includes(v)), `${name}: ${JSON.stringify(reported)}`);
    }
  }
  // control: an address of another site is carried with no such warning
  for (const [name, abouts, reported] of await allThree('https://www.google.com/search?q=haifa')) {
    assert.deepEqual(abouts, ['https://www.google.com/search?q=haifa'], name);
    assert.ok(!reported.some(([k]) => k === 'address-web-page'), `${name}, control`);
  }
  assert.match(LOSS_TEXT['address-web-page'], /a web page, not a gazetteer record/);
});
