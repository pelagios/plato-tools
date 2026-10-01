// What reading real editions found (I.Sicily, Schnitzler's letters, EHRI's editions, IIP), each fixed
// and tested here: on a small trimmed excerpt of the real file where its licence allows (each named,
// with its commit and licence, in test/fixtures/tei/README.md), else on a constructed equivalent.
// Every test of an absence has a presence beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { teiToDocument, TEI_KINDS, parseGeo, setEditorialIriForTests } from '../src/engine/hermes/tei.js';
import { LOSS_TEXT } from '../src/engine/report.js';

const DIR = 'test/fixtures/tei/';
const text = (f) => readFileSync(DIR + f, 'utf8');
function mapped(s, options = {}, name = 'test.xml') {
  const reported = [];
  const doc = teiToDocument(s, name, (kind, example) => reported.push([kind, example]), options);
  return { doc, reported, kinds: new Set(reported.map(([k]) => k)) };
}
const examples = (m, kind) => m.reported.filter(([k]) => k === kind).map(([, e]) => e);
const HEADER = '<teiHeader><fileDesc><titleStmt><title>T</title></titleStmt><publicationStmt><idno type="URI">https://example.org/e</idno></publicationStmt><sourceDesc><p>x</p></sourceDesc></fileDesc></teiHeader>';
const tei = (body, header = HEADER) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<TEI xmlns="http://www.tei-c.org/ns/1.0">${header}<text><body>${body}</body></text></TEI>\n`;

// ---- <geo> with a comma for each decimal point (Schnitzler) -------------------------------------------
test('a <geo> with a comma for each decimal point and a space between is read; a dot decimal and a comma separator still is; anything ambiguous is not', () => {
  assert.deepEqual(parseGeo('48,177598 16,329723'), { lat: 48.177598, lon: 16.329723 });
  assert.deepEqual(parseGeo('-33,86 151,21'), { lat: -33.86, lon: 151.21 });
  // controls: the forms read before are read as before
  assert.deepEqual(parseGeo('37.08415, 15.27628'), { lat: 37.08415, lon: 15.27628 });
  assert.deepEqual(parseGeo('37.97 23.72'), { lat: 37.97, lon: 23.72 });
  assert.deepEqual(parseGeo('37,15'), { lat: 37, lon: 15 }, 'two whole numbers and a comma: a separator, as before');
  for (const g of ['48,1,16,3', '48,1 16', '48 16,3', '48,1, 16,3', '48,1  16,3,4', '48,177598 196,329723', 'somewhere', ''])
    assert.equal(parseGeo(g), null, g);
});
