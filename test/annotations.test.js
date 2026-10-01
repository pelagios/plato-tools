// W3C Web Annotations (Recogito's export) -> PLATO attestations. The fixtures, and where each
// comes from, are described in test/fixtures/annotations/README.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Parser } from 'n3';
import Ajv2020 from 'ajv/dist/2020.js';
import { addPlatoFormats, strictFormatLogger } from '../src/lib/formats.js';
import { annotationsToDocument, ANNOTATION_KINDS } from '../src/formats/annotations.js';
import { annotationItems, detect, DataError } from '../src/engine/input.js';
import { LOSS_TEXT } from '../src/engine/report.js';
import { go, file, textFile, outText } from './engine.js';

const PLATO = 'https://w3id.org/plato#';
const DIR = 'test/fixtures/annotations/';
const FIXTURES = readdirSync(DIR).filter((f) => /\.json(ld)?$/.test(f)).sort();
const load = (f) => JSON.parse(readFileSync(`public/plato/${f}`, 'utf8'));
const ajv = addPlatoFormats(new Ajv2020({ strict: false, allErrors: true, logger: strictFormatLogger }));
ajv.addSchema(load('plato.schema.json'), 'https://w3id.org/plato/schemas/plato.schema.json');
ajv.addSchema(load('attestation-centric.schema.json'));
ajv.addSchema(load('place-centric.schema.json'));
const valid = (id, doc) => { const v = ajv.getSchema(id); return v(doc) ? null : v.errors.slice(0, 3); };
const AC = 'https://w3id.org/plato/schemas/attestation-centric.schema.json', PC = 'https://w3id.org/plato/schemas/place-centric.schema.json';
const fixture = (f) => JSON.parse(readFileSync(DIR + f, 'utf8'));
/** Map a fixture, collecting what is reported: { doc, reported: [[kind, example]] }. */
function mapped(items, name = 'test.json') {
  const reported = [];
  const doc = annotationsToDocument(items, name, (kind, example) => reported.push([kind, example]));
  return { doc, reported, kinds: new Set(reported.map(([k]) => k)) };
}
const stem = (f) => f.replace(/\.[^.]+$/, '');
const allAttestations = (pc) => pc.spatialEntities.flatMap((p) => p.attestations.map((a) => ({ ...a, about: p['@id'] })));

test('there are fixtures: at least three real Recogito exports and the constructed ones', () => {
  assert.ok(FIXTURES.length >= 5, FIXTURES.join(', '));
  assert.ok(FIXTURES.includes('recogito-v1-constructed.jsonld') && FIXTURES.includes('recogito-studio-constructed.json'));
});

for (const f of FIXTURES) {
  test(`${f}: read as W3C Web Annotations, mapped to valid attestation-centric PLATO JSON`, async () => {
    const input = await detect([file(DIR + f)]);
    assert.equal(input.format, 'w3c-annotations');
    assert.equal(input.shape, 'array');
    const { doc } = mapped(fixture(f), f);
    assert.ok(doc.attestations.length > 0);
    assert.equal(valid(AC, doc), null);
  });
  test(`${f}: converts with no errors to PLATO JSON and to N-Triples`, async () => {
    const want = mapped(fixture(f)).doc.attestations.length;
    const j = await go([file(DIR + f)], 'convert', 'plato-json');
    assert.equal(j.report.errors, 0, JSON.stringify(j.report.items.filter((i) => i.severity === 'error')));
    const pc = JSON.parse(outText(j.e, stem(f) + '.json'));
    assert.equal(valid(PC, pc), null);
    assert.equal(allAttestations(pc).length, want);
    assert.equal(j.report.counts.annotations, fixture(f).length);
    const n = await go([file(DIR + f)], 'convert', 'ntriples');
    assert.equal(n.report.errors, 0);
    const quads = new Parser({ format: 'N-Triples' }).parse(outText(n.e, stem(f) + '.nt'));
    assert.equal(quads.filter((q) => q.predicate.value === PLATO + 'attests_about').length, want);
  });
}

test('every other target takes the annotations with no errors', async () => {
  for (const target of ['plato-jsonl', 'tables', 'lpf', 'lpf-seq']) {
    const r = await go([file(DIR + 'recogito-v1-constructed.jsonld')], 'convert', target);
    assert.equal(r.report.errors, 0, target);
    assert.equal(r.outputs.length, 1, target);
  }
  const c = await go([file(DIR + 'recogito-v1-constructed.jsonld')], 'check');
  assert.equal(c.report.errors, 0);
  assert.deepEqual(c.outputs, []);
  assert.ok(c.report.items.some((i) => i.kind === 'annotation-unverified' && i.severity === 'loss'));
});

// ---- the mapping, exactly -----------------------------------------------------------------------
const RT = fixture('recogito-v1-linked-traces-readme.json');
// An annotation's address is recorded in the notes, never used as the attestation's @id.
const fromAnno = (id) => (x) => x['@id'] === undefined && (x.notes || '').split('\n').includes(`From annotation ${id}`);
test('a place link on a TEI text (Linked Traces README, example 1) becomes exactly this attestation', () => {
  const { doc } = mapped([RT[0]]);
  assert.deepEqual(doc.attestations, [{
    about: 'https://pleiades.stoa.org/places/530906',
    names: [{ toponym: 'Ithaca' }],
    formStatus: PLATO + 'Attested',
    citations: [{
      source: { '@id': 'https://recogito.pelagios.org/part/5ec8253d-f398-4355-82d8-ba7f324ea935', title: 'https://recogito.pelagios.org/part/5ec8253d-f398-4355-82d8-ba7f324ea935', authorityType: 'source' },
      locator: 'XPath /TEI[1]/text[1]/body[1]/div[1]/p[2]',
    }],
    contributor: 'https://recogito.pelagios.org/rainer',
    modified: '2019-10-21T10:47:52+00:00',
    notes: 'Place address given as http://pleiades.stoa.org/places/530906 (rule pleiades-https, hermes-addresses 1)\nFrom annotation https://recogito.pelagios.org/annotation/533fb599-9e02-4fe2-ae98-6857b6055c22',
  }]);
});
test('a place link on a map image: the transcription is the name, the region the locator', () => {
  const { doc } = mapped(fixture('recogito-v1-islandia-map.jsonld'));
  const a = doc.attestations.find((x) => x.about === 'https://sws.geonames.org/3415496/');
  assert.deepEqual(a.names, [{ toponym: 'Keflavig' }]);
  assert.deepEqual(a.citations, [{ source: { '@id': 'https://recogito.pelagios.org/part/46c9126b-6904-4229-bfc3-06b40d1834f1', title: 'Islandia', authorityType: 'source' }, locator: 'region at x 2948, y 4087, 197 by 173 pixels' }]);
  assert.equal(a.geometries, undefined, "the gazetteer's coordinates are not the document's evidence");
});
test('a plain text: character positions; a CSV: the row; a tag that is only a word goes to the notes', () => {
  const p = mapped(fixture('recogito-v1-pliny-text.jsonld')).doc.attestations.find(fromAnno('https://recogito.pelagios.org/annotation/db7cebda-cb21-4942-8080-24074e78189e'));
  assert.deepEqual([p.about, p.names, p.citations[0].locator, p.citations[0].source.title], ['https://pleiades.stoa.org/places/570718', [{ toponym: 'Theganusa' }], 'characters 1083 to 1092', 'PlinyCapeMalea.txt']);
  const c = mapped(fixture('recogito-v1-paulinus-csv.jsonld')).doc.attestations.find(fromAnno('https://recogito.pelagios.org/annotation/dff95cf2-02a0-4ab7-9777-15efb4ce891d'));
  assert.deepEqual([c.about, c.names, c.citations[0].locator, c.notes, c.types], ['https://pleiades.stoa.org/places/442518', undefined, 'row 2', 'Tag: Paulinus of Nola\nPlace address given as http://pleiades.stoa.org/places/442518 (rule pleiades-https, hermes-addresses 1)\nFrom annotation https://recogito.pelagios.org/annotation/dff95cf2-02a0-4ab7-9777-15efb4ce891d', undefined]);
});
test('comments, notes and tags: a tag from a vocabulary is a type, a free tag and a comment are notes', () => {
  const { doc } = mapped(fixture('recogito-v1-constructed.jsonld'));
  const a = doc.attestations.find((x) => x.about === 'https://pleiades.stoa.org/places/570536');
  assert.deepEqual(a.types, [{ identifier: 'http://vocab.getty.edu/aat/300008347', label: 'inhabited places' }]);
  assert.equal(a.notes, 'Note: Corinth, not Kenchreai\nComment: The harbour town is meant here.\nTag: to check\nPlace address given as http://pleiades.stoa.org/places/570536 (rule pleiades-https, hermes-addresses 1)\nFrom annotation https://recogito.pelagios.org/annotation/7d0e2c10-0001-4000-8000-000000000001');
  const s = mapped(fixture('recogito-studio-constructed.json')).doc.attestations.find((x) => x.about === 'http://www.wikidata.org/entity/Q14989');
  assert.deepEqual([s['@id'], s.names, s.types, s.notes, s.contributor, s.created], [undefined, [{ toponym: 'Ancyra' }],
    [{ identifier: 'http://vocab.getty.edu/aat/300008347', label: 'settlement' }], 'Comment: Ancyra in the Itinerarium.\nFrom annotation urn:uuid:0c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d1', { name: 'Ayşe Yılmaz' }, '2026-09-29T10:16:00.000Z']);
});
test('the mapping survives the conversion: the attestation read back from PLATO JSON has the same about, name and locator', async () => {
  const r = await go([file(DIR + 'recogito-v1-linked-traces-readme.json')], 'convert', 'plato-json');
  const a = allAttestations(JSON.parse(outText(r.e, 'recogito-v1-linked-traces-readme.json'))).find(fromAnno(RT[0].id));
  assert.deepEqual([a.about, a.names, a.formStatus, a.citations[0].locator, a.contributor], ['https://pleiades.stoa.org/places/530906', [{ toponym: 'Ithaca' }], PLATO + 'Attested', 'XPath /TEI[1]/text[1]/body[1]/div[1]/p[2]', 'https://recogito.pelagios.org/rainer']);
});

// ---- what is not converted, and is reported -------------------------------------------------------
const V1 = mapped(fixture('recogito-v1-constructed.jsonld'));
const about = (m) => m.doc.attestations.map((a) => a.about);
const names = (m) => m.doc.attestations.flatMap((a) => (a.names || []).map((n) => n.toponym));
test('an unverified link (made by software, no creator) is left out and reported; a confirmed one beside it is kept', () => {
  assert.ok(!about(V1).includes('https://pleiades.stoa.org/places/570728'));
  assert.ok(!names(V1).includes('Lechaeum'));
  assert.deepEqual(V1.reported.filter(([k]) => k === 'annotation-unverified'), [['annotation-unverified', 'https://recogito.pelagios.org/annotation/7d0e2c10-0001-4000-8000-000000000002: https://pleiades.stoa.org/places/570728']]);
  assert.ok(about(V1).includes('https://pleiades.stoa.org/places/570536'), 'control: the confirmed link is converted');
  // The links that remain cannot be known to be confirmed, and the file says so once.
  assert.deepEqual(V1.reported.filter(([k]) => k === 'annotation-verification-unknown'), [['annotation-verification-unknown', '3 links']]);
});
test('an explicit verification status is honoured, whatever wrote it', () => {
  const base = (status, creator) => ({ '@context': 'http://www.w3.org/ns/anno.jsonld', id: 'https://example.org/anno/1', type: 'Annotation',
    body: [{ type: 'SpecificResource', source: 'https://pleiades.stoa.org/places/579885', purpose: 'identifying', ...(creator ? { creator } : {}), ...(status ? { status } : {}) }],
    target: { source: 'https://example.org/doc', selector: { type: 'TextQuoteSelector', exact: 'Athenae' } } });
  const un = mapped([base({ value: 'UNVERIFIED' }, 'https://example.org/me')]);
  assert.deepEqual([un.doc.attestations.length, [...un.kinds]], [0, ['annotation-unverified', 'annotation-none-linked']]);
  assert.equal(mapped([base('NOT_IDENTIFIABLE')]).kinds.has('annotation-place-unlinked'), true);
  const ok = mapped([base({ value: 'VERIFIED' })]);
  assert.deepEqual(ok.doc.attestations.map((a) => [a.about, a.names[0].toponym]), [['https://pleiades.stoa.org/places/579885', 'Athenae']]);
  // Outside Recogito v1, a body without a creator is not taken for a machine's suggestion.
  assert.equal(mapped([base()]).doc.attestations.length, 1);
});
test('a mention marked as a place but never linked is reported, not converted', () => {
  assert.ok(!names(V1).includes('Olmiae'));
  assert.deepEqual(V1.reported.filter(([k]) => k === 'annotation-place-unlinked').map(([, e]) => e), ['https://recogito.pelagios.org/annotation/7d0e2c10-0001-4000-8000-000000000003: Olmiae']);
  const s = mapped(fixture('recogito-studio-constructed.json'));
  assert.ok(!names(s).includes('Gordium'));
  assert.ok(s.reported.some(([k, e]) => k === 'annotation-place-unlinked' && /Gordium$/.test(e)));
  assert.ok(names(s).includes('Ancyra'), 'control: a linked mention in the same file is converted');
});
test('a person or an event is reported, not converted', () => {
  assert.ok(!names(V1).includes('Periander') && !names(V1).includes('the Isthmian Games'));
  assert.deepEqual(V1.reported.filter(([k]) => k === 'annotation-not-place').map(([, e]) => e.replace(/^.*annotation\//, '')),
    ['7d0e2c10-0001-4000-8000-000000000004: person (Periander)', '7d0e2c10-0001-4000-8000-000000000005: event (the Isthmian Games)']);
});
test('what else is not carried is reported by kind: gazetteer copies, drawn shapes, internal ids, keys', () => {
  for (const k of ['annotation-gazetteer-copy', 'annotation-selector']) assert.ok(V1.kinds.has(k), k);
  const s = mapped(fixture('recogito-studio-constructed.json'));
  for (const k of ['annotation-gazetteer-copy', 'annotation-place-not-address', 'annotation-creator-not-address', 'annotation-source-not-address', 'annotation-key', 'annotation-no-place']) assert.ok(s.kinds.has(k), k);
  assert.ok(s.reported.some(([k, e]) => k === 'annotation-key' && e === 'motivation (commenting)'));
  assert.ok(!s.reported.some(([k, e]) => k === 'annotation-key' && /visibility/.test(e)), 'a public annotation says nothing to lose');
});
test('every kind the reader reports has words, and a severity the report knows', () => {
  // The loop proves nothing of an empty list: kinds the other tests here meet must be in it.
  for (const k of ['annotation-no-place', 'annotation-gazetteer-copy', 'annotation-selector', 'annotation-key', 'annotation-place-not-address', 'annotation-malformed'])
    assert.ok(k in ANNOTATION_KINDS, `${k} is not among ${Object.keys(ANNOTATION_KINDS).join(', ')}`);
  for (const [k, sev] of Object.entries(ANNOTATION_KINDS)) {
    assert.ok(LOSS_TEXT[k], k);
    assert.ok(['loss', 'warning', 'error'].includes(sev), k);
  }
});
test('in the report, losses are losses and the rest keep their severity', async () => {
  const r = await go([file(DIR + 'recogito-studio-constructed.json')], 'convert', 'ntriples');
  const sev = Object.fromEntries(r.report.items.filter((i) => i.kind.startsWith('annotation-')).map((i) => [i.kind, i.severity]));
  for (const [k, s] of Object.entries(sev)) assert.equal(s, ANNOTATION_KINDS[k], k);
  assert.equal(sev['annotation-source-not-address'], 'warning');
  assert.equal(sev['annotation-place-unlinked'], 'loss');
});

// ---- shapes, and files that cannot be read ---------------------------------------------------------
const one = RT[0];
test('detected in every shape: array, page, collection, one annotation, JSON Lines', async () => {
  const cases = {
    array: JSON.stringify([one]),
    page: JSON.stringify({ '@context': 'http://www.w3.org/ns/anno.jsonld', type: 'AnnotationPage', items: [one, RT[1]] }),
    collection: JSON.stringify({ '@context': 'http://www.w3.org/ns/anno.jsonld', type: 'AnnotationCollection', label: 'Odyssey places', first: { type: 'AnnotationPage', items: [one, RT[1]] } }),
    annotation: JSON.stringify(one, null, 2),
    jsonl: JSON.stringify(one) + '\n' + JSON.stringify(RT[1]) + '\n',
  };
  for (const [shape, text] of Object.entries(cases)) {
    const input = await detect([textFile(text, `a.${shape === 'jsonl' ? 'jsonl' : 'json'}`)]);
    assert.deepEqual([input.format, input.shape], ['w3c-annotations', shape], shape);
    const r = await go([textFile(text, 'a.json')], 'convert', 'plato-json');
    assert.equal(r.report.errors, 0, shape);
    const pc = JSON.parse(outText(r.e, 'a.json'));
    assert.equal(allAttestations(pc).length, shape === 'array' || shape === 'annotation' ? 1 : 2, shape);
    if (shape === 'collection') assert.equal(pc.gazetteer.title, 'Odyssey places');
  }
  // control: a JSON array of something else is not taken for annotations
  const other = await detect([textFile(JSON.stringify([{ type: 'Feature' }]), 'x.json')]);
  assert.equal(other.format, null);
  assert.match(other.reason, /not a list of W3C Web Annotations/);
});
test('a collection whose pages are elsewhere says so', async () => {
  const text = JSON.stringify({ '@context': 'http://www.w3.org/ns/anno.jsonld', type: 'AnnotationCollection', first: 'https://example.org/annos/page1' });
  const r = await go([textFile(text, 'c.json')], 'check');
  assert.ok(r.report.items.some((i) => i.kind === 'annotation-more-pages' && i.examples[0] === 'https://example.org/annos/page1'));
});
test('a file cut short is a DataError: reported as unreadable, with no outputs', async () => {
  const text = readFileSync(DIR + 'recogito-v1-pliny-text.jsonld', 'utf8');
  const cut = text.slice(0, Math.floor(text.length / 2));
  await assert.rejects(async () => { for await (const _ of annotationItems(textFile(cut, 'cut.json'), 'array')); }, DataError);
  const r = await go([textFile(cut, 'cut.json')], 'convert', 'plato-json');
  assert.deepEqual([r.incomplete, r.outputs.length, r.report.items.find((i) => i.severity === 'error')?.kind], [true, 0, 'unreadable']);
  // and not well formed in the middle
  const bad = text.replace('"TextQuoteSelector"', '"TextQuoteSelector" "x"');
  const b = await go([textFile(bad, 'bad.json')], 'check');
  assert.equal(b.report.items.find((i) => i.severity === 'error')?.kind, 'unreadable');
  // control: the whole file reads
  const whole = await go([textFile(text, 'whole.json')], 'check');
  assert.equal(whole.report.errors, 0);
});
test('an item that is not an annotation, or has no target, is an error for that item; the rest is converted', async () => {
  const noTarget = { ...one, id: 'https://recogito.pelagios.org/annotation/no-target' }; delete noTarget.target;
  const r = await go([textFile(JSON.stringify([one, 42, noTarget]), 'm.json')], 'convert', 'plato-json');
  const err = r.report.items.filter((i) => i.severity === 'error');
  assert.deepEqual(err.map((i) => [i.kind, i.count]), [['annotation-malformed', 2]]);
  assert.equal(allAttestations(JSON.parse(outText(r.e, 'm.json'))).length, 1);
});
