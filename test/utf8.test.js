// Every text input is decoded as UTF-8, strictly (src/engine/input.js, textStream): a byte that is
// not UTF-8 stops the file with a DataError that names it and says where and how to re-save it,
// reported as unreadable, with no output. Decoded leniently, a Windows-1252 file had its letters
// replaced ("Köln" read as "K�ln") without a word. Each refusal has beside it a control that
// reads the same content in UTF-8, with its letters intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import { PLATO_REPO } from './paths.js';
import { go, outText } from './engine.js';
import { detect, firstNonUtf8, decodeUtf8, DataError } from '../src/engine/input.js';

const latin1 = (s, name) => new File([Buffer.from(s, 'latin1')], name);
const utf8 = (s, name) => new File([Buffer.from(s, 'utf8')], name);
const unreadable = (r) => r.report.items.filter((i) => i.kind === 'unreadable');
const CSV = 'name,lat,lon\nRoma,41.9,12.5\nKöln,50.9,6.9\n';
const DOC = (label) => JSON.stringify({ profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' },
  spatialEntities: [{ '@id': 'https://example.org/p/1', label, attestations: [{ names: [{ toponym: label }], sources: [{ title: 's' }] }] }] });

test('a Windows-1252 CSV is unreadable, naming the file, the line and the byte, and how to save it as UTF-8; nothing is written', async () => {
  const r = await go([latin1(CSV, 'places-1252.csv')], 'convert', 'plato-json');
  const [u] = unreadable(r);
  assert.ok(u, JSON.stringify(r.report.items));
  assert.match(u.examples[0], /^places-1252\.csv is not encoded as UTF-8: the first byte that is not is on line 3 \(byte 30\)/);
  assert.match(u.examples[0], /“CSV UTF-8”/);
  assert.equal(r.incomplete, true);
  assert.deepEqual(r.outputs, []);
  // Control: the same text in UTF-8 reads, ö and all.
  const ok = await go([utf8(CSV, 'places.csv')], 'convert', 'plato-json');
  assert.deepEqual(unreadable(ok), []);
  assert.match(outText(ok.e, Object.keys(ok.e.outs)[0]), /"Köln"/);
});
test('a Latin-1 PLATO JSON document, and a Latin-1 CSV compressed with gzip, are unreadable too', async () => {
  for (const f of [latin1(DOC('Köln'), 'doc.json'), new File([gzipSync(Buffer.from(CSV, 'latin1'))], 'places.csv.gz')]) {
    const r = await go([f], 'check');
    assert.equal(unreadable(r).length, 1, f.name);
    assert.match(unreadable(r)[0].examples[0], /is not encoded as UTF-8/, f.name);
  }
  assert.match(unreadable(await go([new File([gzipSync(Buffer.from(CSV, 'latin1'))], 'p.csv.gz')], 'check'))[0].examples[0], /the first byte of its decompressed text that is not/);
  // Controls: the same in UTF-8.
  for (const f of [utf8(DOC('Köln'), 'doc.json'), new File([gzipSync(Buffer.from(CSV, 'utf8'))], 'places.csv.gz')]) assert.deepEqual(unreadable(await go([f], 'check')), [], f.name);
});
test('UTF-8 with a byte-order mark, and with Greek and accented letters, still reads, letters intact', async () => {
  const r = await go([utf8('﻿' + DOC('Κωνσταντινούπολις'), 'bom.json')], 'convert', 'plato-json');
  assert.deepEqual(unreadable(r), []);
  assert.equal(JSON.parse(outText(r.e, Object.keys(r.e.outs)[0])).spatialEntities[0].label, 'Κωνσταντινούπολις');
  const c = await go([utf8('﻿name,lat,lon\nKöln,50.9,6.9\nΑθῆναι,37.97,23.72\n', 'bom.csv')], 'convert', 'plato-json');
  assert.deepEqual(unreadable(c), []);
  assert.deepEqual(JSON.parse(outText(c.e, Object.keys(c.e.outs)[0])).spatialEntities.map((p) => p.label), ['Köln', 'Αθῆναι']);
});
test('TEI, N-Triples and JSON Lines that are not UTF-8 are unreadable; the same in UTF-8 are not', async () => {
  const tei = '<?xml version="1.0"?>\n<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/><text><body><p><placeName ref="https://pleiades.stoa.org/places/423025">Köln</placeName></p></body></text></TEI>\n';
  const nt = '<https://example.org/p/1> <http://www.w3.org/2000/01/rdf-schema#label> "Köln" .\n';
  const jsonl = JSON.stringify({ profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' } }) + '\n' + JSON.parse(DOC('Köln')).spatialEntities.map((p) => JSON.stringify(p)).join('\n') + '\n';
  for (const [text, name] of [[tei, 'e.xml'], [nt, 'x.nt'], [jsonl, 'x.jsonl']]) {
    const bad = await go([latin1(text, name)], 'check');
    assert.equal(unreadable(bad).length, 1, `${name}: ${JSON.stringify(bad.report.items)}`);
    assert.match(unreadable(bad)[0].examples[0], new RegExp(`^${name.replace('.', '\\.')} is not encoded as UTF-8`));
    assert.deepEqual(unreadable(await go([utf8(text, name)], 'check')), [], `control: ${name} in UTF-8`);
  }
});
test('a file that is not UTF-8 is still detected, so that the reader can say what is wrong with it', async () => {
  assert.equal((await detect([latin1(DOC('Köln'), 'doc.json')])).format, 'plato-json');
  assert.equal((await detect([latin1(CSV, 'x.csv')])).format, 'csv');
});
test('firstNonUtf8 finds the first byte that is not UTF-8, and passes valid sequences of every length', () => {
  const b = (...x) => Uint8Array.from(x);
  assert.equal(firstNonUtf8(Buffer.from('aö€𝄞', 'utf8')), -1);
  assert.equal(firstNonUtf8(b(0x61, 0xf6, 0x62)), 1, 'a Latin-1 ö');
  assert.equal(firstNonUtf8(b(0xc0, 0xaf)), 0, 'an overlong form');
  assert.equal(firstNonUtf8(b(0x61, 0xed, 0xa0, 0x80)), 1, 'a surrogate');
  assert.equal(firstNonUtf8(b(0x61, 0xe2, 0x82)), -1, 'cut off at the end: not counted here');
  assert.throws(() => decodeUtf8(b(0x61, 0xe2, 0x82), 'x.csv'), (e) => e instanceof DataError && /at its very end/.test(e.message));
  assert.equal(decodeUtf8(Buffer.from('﻿Köln', 'utf8'), 'x.csv'), 'Köln', 'control: a byte-order mark is dropped');
});

// ---- the spreadsheet tables (src/engine/pipeline.js, readSheets) ------------------------------------
const CUSTOMS = `${PLATO_REPO}/schemas/tables/examples/customs`;
/** The customs tables, with places.csv's Bristol renamed Bristöl and written in `encoding`. */
function customs(encoding) {
  return Object.fromEntries(readdirSync(CUSTOMS).filter((f) => f.endsWith('.csv')).map((f) => {
    const text = readFileSync(`${CUSTOMS}/${f}`, 'utf8');
    return [f, f === 'places.csv' ? Buffer.from(text.replace('bristol,Bristol,', 'bristol,Bristöl,'), encoding) : Buffer.from(text, 'utf8')];
  }));
}
test('a sheet of the tables that is not UTF-8 is unreadable, as CSV files and in a zip; the same in UTF-8 reads', async () => {
  for (const encoding of ['latin1', 'utf8']) {
    const sheets = customs(encoding);
    const csvs = await go(Object.entries(sheets).map(([f, b]) => new File([b], f)), 'check');
    const zip = await go([new File([zipSync(Object.fromEntries(Object.entries(sheets).map(([f, b]) => [f, new Uint8Array(b)])))], 'customs.zip')], 'check');
    for (const [r, name] of [[csvs, /^places\.csv is not encoded as UTF-8: the first byte that is not is on line 2 /], [zip, /^places\.csv in customs\.zip is not encoded as UTF-8/]]) {
      if (encoding === 'latin1') { assert.equal(unreadable(r).length, 1, JSON.stringify(r.report.items)); assert.match(unreadable(r)[0].examples[0], name); }
      else { assert.deepEqual(unreadable(r), [], 'control: in UTF-8'); assert.equal(r.report.errors, 0, JSON.stringify(r.report.items)); }
    }
  }
});
