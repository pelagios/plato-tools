// Hermes, place names in a text, phase 2: `text.dataset`, the step that turns the names a reviewer
// confirmed into a dataset of places (Stephen's decisions of 30 October 2026, Q1 A and Q2 A).
//
// attestationsFrom writes an attestation only for a name the reviewer also linked to a place, because
// an unlinked name is "evidence about nothing". A text's names arrive with no address, as a table's do,
// and the later steps (lookup in WHG, review, Chora, publishing) start from a dataset of places not yet
// identified: so here every confirmed name is evidence that the text names a place called so, and gets
// a place of its own to be identified later. One place for each spelling (NFC, case-sensitive); a
// reviewer's "this is a different place" gives that occurrence a place of its own; an address the
// reviewer already gave is kept as what the attestation is about and never replaced.
//
// Every test that something is absent has beside it what is present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { addPlatoFormats, strictFormatLogger } from '../src/lib/formats.js';
import { DataError } from '../src/engine/input.js';
import * as T from '../src/engine/hermes/text/index.js';
import { datasetFrom, placeIdOf } from '../src/engine/hermes/text/dataset.js';
import { tableIds } from '../src/formats/tables.js';
import { sha256 } from '../src/lib/sha256.js';
import { go, textFile } from './engine.js';
import { found, REVIEWER, SOURCE } from './hermes-text-helpers.js';

const BASE = 'https://example.org/places-in-a-text/';
const PLEIADES_OSTIA = 'https://pleiades.stoa.org/places/422995';
const TEXT = 'Londinium was large. Newton lay near Londinium, but another Newton lay by the sea. '
  + 'From Ostia the party went to Capua and Londinium; Neapolis was not seen. Tarentum came last. '
  + 'Then they went back to Ostia, and on to Brundisium.';
const at = (text, s, n = 0) => { let i = -1; for (let k = 0; k <= n; k++) i = text.indexOf(s, i + 1); return T.cpLength(text.slice(0, i)); };
const idAt = (work, name, n = 0) => T.suggestions(work).filter((s) => s.text === name)[n].id;
const AT = (m) => `2026-10-02T09:${String(m).padStart(2, '0')}:00Z`;
const load = (f) => JSON.parse(readFileSync(`public/plato/${f}`, 'utf8'));
const ajv = addPlatoFormats(new Ajv2020({ strict: false, allErrors: true, logger: strictFormatLogger }));
ajv.addSchema(load('plato.schema.json'), 'https://w3id.org/plato/schemas/plato.schema.json');
const attestationCentric = ajv.compile(load('attestation-centric.schema.json'));

/** A text with repeated and ambiguous names, reviewed: see each decision below. */
async function reviewed(extra = {}) {
  const { work } = await found(TEXT, ['Londinium', 'Newton', 'Ostia', 'Capua', 'Neapolis', 'Tarentum'], { language: 'la', source: { ...SOURCE, rights: 'Public domain.' }, ...extra });
  T.setReviewer(work, REVIEWER);
  let m = 0;
  const confirm = (name, n, d = {}) => T.decide(work, TEXT, idAt(work, name, n), { status: 'confirmed', ...d }, { at: AT(m++) });
  confirm('Londinium', 0); confirm('Londinium', 1); confirm('Londinium', 2);
  confirm('Newton', 0); confirm('Newton', 1, { separate: true });                       // two places called Newton
  confirm('Ostia', 0, { place: PLEIADES_OSTIA, placeFrom: 'pasted' });                  // the reviewer knew this one
  confirm('Ostia', 1);                                                                 // and not this one
  T.decide(work, TEXT, idAt(work, 'Capua'), { status: 'rejected' }, { at: AT(m++) });
  // Neapolis: not decided. Tarentum: confirmed as a settlement.
  confirm('Tarentum', 0, { type: 'settlement' });
  const s = at(TEXT, 'Brundisium');
  const added = T.addMention(work, TEXT, { start: s, end: s + 10 }, { at: AT(m++) });   // the model missed it
  T.decide(work, TEXT, added, { status: 'confirmed' }, { at: AT(m++) });
  return work;
}

test('one place for each spelling, one attestation for each confirmed mention, each citing the characters of the text', async () => {
  const work = await reviewed();
  const { document: doc, counts, places } = datasetFrom(work, TEXT, { base: BASE });
  assert.deepEqual(counts, { confirmed: 9, linked: 1, places: 6, separate: 1, rejected: 1, undecided: 1 });
  assert.equal(doc.profile, 'attestation-centric');
  assert.equal(doc.gazetteer.title, 'Places in A test itinerary');
  assert.deepEqual(doc.attestations.map((a) => a.names[0].toponym), ['Londinium', 'Newton', 'Londinium', 'Newton', 'Ostia', 'Londinium', 'Tarentum', 'Ostia', 'Brundisium'], 'in the order of the text');
  // Londinium: three mentions, one place.
  const lon = doc.attestations.filter((a) => a.names[0].toponym === 'Londinium');
  assert.equal(lon.length, 3);
  assert.equal(new Set(lon.map((a) => a.about)).size, 1, 'about one place');
  const londinium = doc.newSpatialEntities.find((p) => p['@id'] === lon[0].about);
  assert.equal(londinium.label, 'Londinium');
  assert.deepEqual(lon.map((a) => a.citations[0].locator), [0, 1, 2].map((n) => { const s = at(TEXT, 'Londinium', n); return `characters ${s} to ${s + 9}`; }));
  // Each carries what attestationsFrom's carry.
  const a = lon[0];
  assert.equal(a.formStatus, 'https://w3id.org/plato#Attested');
  assert.deepEqual(a.contributor, REVIEWER);
  assert.deepEqual(a.names, [{ toponym: 'Londinium', language: 'la' }]);
  assert.deepEqual(a.citations[0].source, { '@id': SOURCE.uri, title: SOURCE.title, authorityType: 'source' });
  assert.equal(a.created, AT(0));
  assert.equal(a['@id'], undefined, 'the saver mints the address');
  assert.equal(a.types, undefined, 'no type unless the reviewer confirmed one');
  assert.match(a.notes, /^Suggested by claude-x-20261001 \(fake\), prompt hermes-text 1, 2026-10-01; confirmed by the contributor\. The model's guess at the kind of place, not confirmed: settlement\.$/);
  assert.doesNotMatch(a.notes, /linked/, 'nothing was linked by the contributor');
  // The new places: every place about which the attestations are, apart from the address the reviewer gave.
  assert.deepEqual(places.map((p) => [p.label, p.mentions]), [['Londinium', 3], ['Newton', 1], ['Newton', 1], ['Tarentum', 1], ['Ostia', 1], ['Brundisium', 1]]);
  assert.equal(doc.newSpatialEntities.length, 6);
  for (const p of doc.newSpatialEntities) {
    assert.match(p['@id'], /^https:\/\/example\.org\/places-in-a-text\/place\/text-[0-9a-f]{16}$/);
    assert.equal(p.entityIdentifier, p['@id'].split('/').pop());
    assert.equal(p['@id'], tableIds(BASE, () => null).place(p.entityIdentifier), 'an address made as a table\'s ids are');
    assert.deepEqual(p.attestations, [], 'the attestations are given on their own, about it');
  }
  assert.equal(new Set(doc.newSpatialEntities.map((p) => p['@id'])).size, 6, 'six distinct addresses');
  // Control: an unlinked name is a place here, where attestationsFrom would have left it out.
  assert.deepEqual(T.attestationsFrom(work, TEXT).attestations.map((x) => x.names[0].toponym), ['Ostia'], 'the engine\'s other path writes the one linked name');
});

test('absent: what is not confirmed is not in the dataset, beside what is', async () => {
  const work = await reviewed();
  const { document: doc } = datasetFrom(work, TEXT, { base: BASE });
  const json = JSON.stringify(doc);
  assert.equal(json.includes('Capua'), false, 'rejected');
  assert.equal(json.includes('Neapolis'), false, 'not decided');
  for (const n of ['Londinium', 'Tarentum', 'Brundisium', 'Ostia']) assert.equal(json.includes(n), true, n);
});

test('a name the reviewer separated is a place of its own; the rest of its spelling share one', async () => {
  const work = await reviewed();
  const { document: doc } = datasetFrom(work, TEXT, { base: BASE });
  const newton = doc.attestations.filter((a) => a.names[0].toponym === 'Newton');
  assert.equal(newton.length, 2);
  assert.notEqual(newton[0].about, newton[1].about, 'two places');
  const labels = doc.newSpatialEntities.filter((p) => p.label === 'Newton');
  assert.equal(labels.length, 2, 'both are called Newton');
  assert.deepEqual(labels.map((p) => p['@id']).sort(), newton.map((a) => a.about).sort());
  // Control: without the split, the two are one place.
  const w2 = JSON.parse(T.serialiseWork(work));
  delete w2.review.decisions[idAt(work, 'Newton', 1)].separate;
  const merged = datasetFrom(T.readWork(w2), TEXT, { base: BASE }).document;
  const m = merged.attestations.filter((a) => a.names[0].toponym === 'Newton');
  assert.equal(m[0].about, m[1].about);
  assert.equal(merged.newSpatialEntities.length, 5);
});

test('a place\'s address does not change with the order of decisions, differs between texts, and is made from the spelling and the text only', async () => {
  const work = await reviewed();
  const ids = (w) => Object.fromEntries(datasetFrom(w, TEXT, { base: BASE }).document.newSpatialEntities.map((p, i) => [`${p.label}${i}`, p['@id']]));
  const first = ids(work);
  const w2 = JSON.parse(T.serialiseWork(work));
  w2.review.decisions = Object.fromEntries(Object.entries(w2.review.decisions).reverse());
  assert.deepEqual(ids(T.readWork(w2)), first, 'the same addresses');
  assert.equal(placeIdOf(work.text.sha256, 'Londinium'), placeIdOf(work.text.sha256, 'Londinium'));
  assert.notEqual(placeIdOf(work.text.sha256, 'Londinium'), placeIdOf(work.text.sha256, 'londinium'), 'case-sensitive');
  assert.notEqual(placeIdOf(work.text.sha256, 'Londinium'), placeIdOf('0'.repeat(64), 'Londinium'), 'another text, another place');
  assert.notEqual(placeIdOf(work.text.sha256, 'Newton', '10-16'), placeIdOf(work.text.sha256, 'Newton'), 'a separated occurrence is its own');
  // The base address is where the places are, and only that.
  const other = datasetFrom(work, TEXT, { base: 'https://other.example/x' }).document;
  assert.ok(other.newSpatialEntities.every((p) => p['@id'].startsWith('https://other.example/x/place/')));
});

test('a spelling is NFC and case-sensitive: the same name in NFD and NFC is one place, "londinium" another', async () => {
  const text = 'Ἀθῆναι'.normalize('NFC') + ' stood. Then ' + 'Ἀθῆναι'.normalize('NFD') + ' fell. athenae and Athenae.';
  const { work } = await found(text, ['Ἀθῆναι', 'athenae', 'Athenae']);
  T.setReviewer(work, REVIEWER);
  for (const s of T.suggestions(work)) T.decide(work, text, s.id, { status: 'confirmed' }, { at: AT(0) });
  assert.equal(T.suggestions(work).length, 4);
  const { document: doc, places } = datasetFrom(work, text, { base: BASE });
  const greek = doc.attestations.filter((a) => a.names[0].toponym.normalize('NFC') === 'Ἀθῆναι');
  assert.equal(greek.length, 2);
  assert.notEqual(greek[0].names[0].toponym, greek[1].names[0].toponym, 'as given: one composed, one decomposed');
  assert.equal(greek[0].about, greek[1].about, 'one place');
  assert.deepEqual(places.map((p) => [p.label, p.mentions]), [['Ἀθῆναι', 2], ['athenae', 1], ['Athenae', 1]]);
  assert.equal(places[0].label, 'Ἀθῆναι'.normalize('NFC'), 'the label is the composed spelling');
});

test('an address the reviewer gave is what the attestation is about, and never replaced by a new place', async () => {
  const work = await reviewed();
  const { document: doc } = datasetFrom(work, TEXT, { base: BASE });
  const [first, second] = doc.attestations.filter((a) => a.names[0].toponym === 'Ostia');
  assert.equal(first.about, PLEIADES_OSTIA, 'kept as the reviewer gave it');
  assert.match(first.notes, /confirmed and linked by the contributor\./);
  assert.ok(second.about.startsWith(BASE), 'the other occurrence of the spelling, not linked, is a place to be identified');
  assert.doesNotMatch(second.notes, /linked/);
  assert.equal(doc.newSpatialEntities.some((p) => p['@id'] === PLEIADES_OSTIA), false, 'the address is not made a new place');
  assert.equal(doc.newSpatialEntities.some((p) => p.label === 'Ostia'), true, 'the unlinked occurrence has its place');
});

test('a type is written only when the reviewer confirmed one; a name the reviewer added says so', async () => {
  const work = await reviewed();
  const { document: doc } = datasetFrom(work, TEXT, { base: BASE });
  const tar = doc.attestations.find((a) => a.names[0].toponym === 'Tarentum');
  assert.deepEqual(tar.types, [{ label: 'settlement' }]);
  assert.doesNotMatch(tar.notes, /guess/, 'confirmed, so the guess is not mentioned');
  const bru = doc.attestations.find((a) => a.names[0].toponym === 'Brundisium');
  assert.equal(bru.notes, 'Added by the contributor, who marked it in the text: no model suggested it (2026-10-02).');
  assert.equal(bru.types, undefined);
  const s = at(TEXT, 'Brundisium');
  assert.equal(bru.citations[0].locator, `characters ${s} to ${s + 10}`);
});

test('a rights statement that is a web address is the source\'s licence', async () => {
  const work = await reviewed({ source: { ...SOURCE, rights: 'https://creativecommons.org/publicdomain/zero/1.0/' } });
  const { document: doc } = datasetFrom(work, TEXT, { base: BASE });
  assert.equal(doc.attestations[0].citations[0].source.licence, 'https://creativecommons.org/publicdomain/zero/1.0/');
  assert.equal(datasetFrom(await reviewed(), TEXT, { base: BASE }).document.attestations[0].citations[0].source.licence, undefined, 'control: a sentence is not an address');
});

test('the dataset passes PLATO\'s schema and the check, and a broken one does not', async () => {
  const work = await reviewed();
  const { document: doc } = datasetFrom(work, TEXT, { base: BASE });
  assert.ok(attestationCentric(doc), JSON.stringify(attestationCentric.errors));
  assert.equal(attestationCentric({ ...doc, attestations: [{ ...doc.attestations[0], about: 'not an address' }] }), false, 'control: the schema can fail');
  const text = JSON.stringify(doc, null, 2);
  const r = await go([textFile(text, 'places-in-a-text.json')], 'check');
  const bad = r.report.items.filter((i) => i.severity === 'error');
  assert.deepEqual(bad.map((i) => i.kind), [], JSON.stringify(r.report.items.slice(0, 5)));
  assert.equal(r.incomplete ?? false, false);
  // Control: the check finds a fault when one is there.
  const broken = JSON.parse(text); broken.attestations[0].about = 'not an address';
  const rb = await go([textFile(JSON.stringify(broken), 'broken.json')], 'check');
  assert.ok(rb.report.items.some((i) => i.severity === 'error'), 'the check can fail');
});

test('a dataset made again after more names are confirmed keeps every earlier attestation and place (the version check)', async () => {
  const { compare } = await import('../src/engine/compare.js');
  const { detect } = await import('../src/engine/input.js');
  const { env } = await import('./engine.js');
  const work = await reviewed();
  const earlier = datasetFrom(work, TEXT, { base: BASE }).document;
  // The reviewer comes back and confirms Neapolis.
  T.decide(work, TEXT, idAt(work, 'Neapolis'), { status: 'confirmed' }, { at: AT(30) });
  const later = datasetFrom(work, TEXT, { base: BASE }).document;
  assert.equal(later.attestations.length, earlier.attestations.length + 1);
  // Published, an attestation has an address (Agora's minting gives it; here a hash of what it is about and cites, which a later version keeps).
  const minted = (d) => ({ ...d, attestations: d.attestations.map((a) => ({ '@id': `${BASE}attestation/${sha256(`${a.about} ${a.citations[0].locator}`).slice(0, 16)}`, ...a })) });
  const withGazetteer = (d, version, extra = {}) => ({ ...minted(d), gazetteer: { ...d.gazetteer, '@id': `${BASE}dataset/${version}`, version: String(version), status: 'published', isVersionOf: `${BASE}dataset`, licence: 'https://creativecommons.org/licenses/by/4.0/', ...extra } });
  const files = (d, n) => detect([textFile(JSON.stringify(d), n)]);
  const run = async (e, l) => (await compare({ earlier: await files(e, 'e.json'), later: await files(l, 'l.json'), options: {} }, env())).report;
  const ok = await run(withGazetteer(earlier, 1), withGazetteer(later, 2, { previousVersion: `${BASE}dataset/1` }));
  assert.deepEqual(ok.items.filter((i) => i.severity === 'error').map((i) => i.kind), [], JSON.stringify(ok.items.slice(0, 4)));
  // Control: the reverse (an attestation gone) is found.
  const back = await run(withGazetteer(later, 2), withGazetteer(earlier, 3, { previousVersion: `${BASE}dataset/2` }));
  assert.ok(back.items.some((i) => i.severity === 'error'), 'a deleted attestation is found');
});

test('refused in words: no reviewer, no base address, a base that is not one, nothing confirmed, or another text', async () => {
  const work = await reviewed();
  const bad = (w, o, re, text = TEXT) => assert.throws(() => datasetFrom(w, text, o), (e) => e instanceof DataError && re.test(e.message), String(re));
  const anon = JSON.parse(T.serialiseWork(work)); anon.review.reviewer = null;
  bad(T.readWork(anon), { base: BASE }, /Name the reviewer/);
  bad(work, {}, /Give the base address/);
  bad(work, { base: 'not a web address' }, /Give the base address/);
  bad(work, { base: 'https://example.org/x#' }, /Give the base address/);
  bad(work, { base: BASE }, /not the text the work file was made from/, TEXT + ' ');
  // Nothing confirmed: a message, not a file.
  const none = JSON.parse(T.serialiseWork(work)); none.review.decisions = {};
  const e = (() => { try { datasetFrom(T.readWork(none), TEXT, { base: BASE }); } catch (x) { return x; } })();
  assert.ok(e instanceof DataError);
  assert.match(e.message, /^No name in the text has been confirmed: 11 suggested, 0 rejected, 11 not yet decided\. Nothing was written/);
  // Control: the reviewed one gives a dataset.
  assert.ok(datasetFrom(work, TEXT, { base: BASE }).document);
});
