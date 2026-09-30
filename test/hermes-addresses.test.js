// A place's address put into the form PLATO's `about` should carry (src/engine/hermes/addresses.js),
// alone and as the Recogito reader uses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeAddress } from '../src/engine/hermes/addresses.js';
import { annotationsToDocument } from '../src/formats/annotations.js';

const W3ID = 'https://w3id.org/whg/id/';

test('WHG record ids and entity pages become the persistent address, saying what was written', () => {
  assert.deepEqual(placeAddress('place:gn:2988507'), { iri: `${W3ID}place:gn:2988507`, from: 'place:gn:2988507' });
  assert.deepEqual(placeAddress('place:whg:42:abc-1'), { iri: `${W3ID}place:whg:42:abc-1`, from: 'place:whg:42:abc-1' });
  for (const v of ['https://whgazetteer.org/entity/place:wd:Q90/api', 'https://whgazetteer.org/entity/place:wd:Q90/', 'https://whgazetteer.org/entity/place:wd:Q90'])
    assert.deepEqual(placeAddress(v), { iri: `${W3ID}place:wd:Q90`, from: v }, v);
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
  assert.match(m.doc.attestations[0].notes, /^Place address given as https:\/\/whgazetteer\.org\/entity\/place:gn:2988507\/api$/m);
  const plain = mapped([studio('https://pleiades.stoa.org/places/579885')]);
  assert.ok(!/Place address given as/.test(plain.doc.attestations[0].notes || ''), 'control: an address left as it was gets no such note');
});

test('a staging address is refused', () => {
  const m = mapped([studio('https://dev.whgazetteer.org/entity/place:gn:2988507/api')]);
  assert.deepEqual([m.doc.attestations.length, m.reported.filter(([k]) => k === 'annotation-whg-staging').length], [0, 1]);
});
