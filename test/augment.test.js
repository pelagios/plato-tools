// options.augment: another tool's attestations added to the places they are about, on the way to the
// output, whatever the input's format (Krisis's and Chora's saved datasets are made this way). And
// the addresses the tables make, as PLATO states them: ids percent-encoded to RFC 3986's unreserved
// characters, and the dataset's own address the base with its closing '/'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { file, textFile, go, outText } from './engine.js';
import { tableIds, aboutToGazetteer, encodeId } from '../src/formats/tables.js';
import { PLATO_REPO } from './paths.js';

const EXAMPLE = `${PLATO_REPO}/schemas/examples/place-centric-antonine.json`;
const added = { sourceLabel: 'added by augment', source: 'https://example.org/source/aug', names: [{ toponym: 'Augmentopolis' }] };
const augmentFirst = () => { let done = false; return (rec) => { if (done) return rec; done = true; return { ...rec, attestations: [...(rec.attestations || []), added] }; }; };

async function convertedRecords(files, options) {
  const r = await go(files, 'convert', 'plato-jsonl', options);
  return outText(r.e, Object.keys(r.e.outs)[0]).trim().split('\n').slice(1).map((l) => JSON.parse(l));
}

test('augment adds to a record of a streamed input, and only to the record it returns', async () => {
  const plain = await convertedRecords([file(EXAMPLE)]);
  const aug = await convertedRecords([file(EXAMPLE)], { augment: augmentFirst() });
  assert.equal(aug.length, plain.length);
  // Presence: the first place has the added attestation; absence: no other place does, and the plain run has none.
  assert.ok(aug[0].attestations.some((a) => a.sourceLabel === 'added by augment'));
  assert.ok(!aug.slice(1).some((r) => (r.attestations || []).some((a) => a.sourceLabel === 'added by augment')));
  assert.ok(!plain.some((r) => (r.attestations || []).some((a) => a.sourceLabel === 'added by augment')));
  assert.equal(aug[0].attestations.length, plain[0].attestations.length + 1);
});

test('augment reaches records rebuilt from RDF (the store path) too', async () => {
  const nt = await go([file(EXAMPLE)], 'convert', 'ntriples');
  const text = outText(nt.e, Object.keys(nt.e.outs)[0]);
  const back = await convertedRecords([textFile(text, 'x.nt')], { augment: augmentFirst() });
  const hits = back.filter((r) => (r.attestations || []).some((a) => a.sourceLabel === 'added by augment'));
  assert.equal(hits.length, 1);
  assert.ok(back.length > 1);
});

test('augment changes nothing that is checked: its additions are not counted as read', async () => {
  const plain = await go([file(EXAMPLE)], 'check');
  const aug = await go([file(EXAMPLE)], 'check', undefined, { augment: augmentFirst(), sink: { header() {}, event() {}, async close() {} } });
  assert.equal(aug.report.counts.attestations, plain.report.counts.attestations);
  assert.equal(aug.report.errors, plain.report.errors);
});

test('ids are percent-encoded to the unreserved characters, ! \' ( ) * included', () => {
  const t = tableIds('https://w3id.org/x', () => null);
  assert.equal(t.place('bristol'), 'https://w3id.org/x/place/bristol');
  assert.equal(t.place("st mary's (old)*!"), 'https://w3id.org/x/place/st%20mary%27s%20%28old%29%2A%21');
  assert.equal(t.sourceIri('a/b'), 'https://w3id.org/x/source/a%2Fb');
  assert.equal(encodeId('Zürich~a.b_c-d'), 'Z%C3%BCrich~a.b_c-d');
  // Every reserved character a CSVW URI template encodes is encoded here too.
  for (const c of "!#$&'()*+,/:;=?@[]") assert.notEqual(encodeId(c), c, c);
});

test("the dataset's own address is the base with its closing '/', as for its places", () => {
  assert.equal(aboutToGazetteer({ title: 't' }, 'https://w3id.org/x')['@id'], 'https://w3id.org/x/');
  assert.equal(aboutToGazetteer({ title: 't' }, 'https://w3id.org/x/')['@id'], 'https://w3id.org/x/');
  assert.equal(aboutToGazetteer({ title: 't', dataset_uri: 'https://w3id.org/x/release/r1' }, 'https://w3id.org/x')['@id'], 'https://w3id.org/x/release/r1');
});

test('places without addresses stay apart in the tables, and say so', async () => {
  const doc = { profile: 'place-centric', gazetteer: { title: 't' },
    spatialEntities: [{ label: 'Alpha', attestations: [{ source: 'https://example.org/s', names: [{ toponym: 'Alpha' }] }] },
      { label: 'Beta', attestations: [{ source: 'https://example.org/s', names: [{ toponym: 'Beta' }] }] }] };
  const r = await go([textFile(JSON.stringify(doc), 'x.json')], 'convert', 'tables');
  const { unzipSync, strFromU8 } = await import('fflate');
  const z = unzipSync(new Uint8Array(await new Blob(r.e.outs[Object.keys(r.e.outs)[0]]).arrayBuffer()));
  const places = strFromU8(z[Object.keys(z).find((k) => k.endsWith('places.csv'))]).trim().split('\n').slice(1);
  assert.equal(places.length, 2, places.join(' | '));
  assert.ok(places.some((l) => l.includes('Alpha')) && places.some((l) => l.includes('Beta')));
  assert.equal(new Set(places.map((l) => l.split(',')[0])).size, 2);
  assert.ok(r.report.items.some((i) => i.kind === 'place-without-address' && i.count === 2));
});
