// Hermes, place names in a text, phase 2: the text as given, and the text as a model is sent it
// (Stephen's decision of 30 October 2026, Q7 B). A model answers in composed (NFC) characters and
// with line feeds; a file may be decomposed (NFD: macOS, some OCR, much polytonic Greek) and have
// CRLF line ends. The name is matched in the composed text and its offsets are mapped back, so that
// every locator is true to the text AS GIVEN: the characters at those offsets are the name, in the
// form the file has. A name that begins or ends inside a composed character is refused, not guessed.
//
// Every test that something is refused has beside it the case that is accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/engine/hermes/text/index.js';
import { normalised } from '../src/engine/hermes/text/normalise.js';
import { decodeText } from '../src/engine/hermes/text/decode.js';
import { DataError } from '../src/engine/input.js';
import { found, fake, NOW, SOURCE } from './hermes-text-helpers.js';

const GREEK = 'ἐν Ἀθήναις καὶ ἐν Κορίνθῳ οἱ ἄνδρες ἔμειναν, ἔπειτα εἰς Σπάρτην ἦλθον.';
const NFD = GREEK.normalize('NFD');
const slice = (text, m) => T.sliceCodePoints(text, m.start, m.end);

test('the Fable review\'s failing input: a name in NFC is found in an NFD text, and its offsets are true to the text as given', async () => {
  const text = 'Von Čáslav nach Brno.'.normalize('NFD');
  assert.notEqual(text, text.normalize('NFC'), 'the text really is decomposed');
  const { work, run } = await found(text, ['Čáslav', 'Brno']);
  assert.deepEqual(run.counts, {}, 'nothing refused');
  const ms = T.suggestions(work);
  assert.deepEqual(ms.map((m) => m.text), ['Čáslav'.normalize('NFD'), 'Brno'], 'the name is the text as given, decomposed');
  for (const m of ms) assert.equal(slice(text, m), m.text, `the characters at ${m.start}-${m.end} are the name`);
  assert.equal(T.cpLength(ms[0].text), 8, 'eight code points where the composed name has six: the offsets are the file\'s');
  assert.equal(ms[1].start, T.cpLength('Von Čáslav nach '.normalize('NFD')), 'Brno begins after the extra combining marks');
  // Control: the same text composed gives the same names at the composed offsets.
  const nfc = text.normalize('NFC');
  const c = await found(nfc, ['Čáslav', 'Brno']);
  assert.deepEqual(T.suggestions(c.work).map((m) => [m.text, m.start]), [['Čáslav', 4], ['Brno', 16]]);
  assert.notEqual(ms[1].start, T.suggestions(c.work)[1].start, 'the offsets differ between the forms');
});

test('the model is sent composed text, and the work file keeps the text as given: polytonic Greek in NFD', async () => {
  const { work, run, provider } = await found(NFD, ['Ἀθήναις', 'Κορίνθῳ', 'Σπάρτην'], { language: 'grc' });
  assert.deepEqual(run.counts, {});
  assert.equal(provider.calls[0].chunk.text, GREEK.normalize('NFC'), 'the model read the composed form');
  assert.notEqual(provider.calls[0].chunk.text, NFD);
  const ms = T.suggestions(work);
  assert.equal(ms.length, 3);
  for (const m of ms) {
    assert.equal(slice(NFD, m), m.text);
    assert.equal(m.text, m.text.normalize('NFD'), 'as the file has it');
  }
  assert.equal(ms[0].text.normalize('NFC'), 'Ἀθήναις');
  assert.equal(work.text.sha256, T.newWork({ text: NFD, source: SOURCE }).text.sha256, 'the hash is of the text as given');
  assert.equal(work.text.characters, Array.from(NFD).length);
  // The work file reads back, and an attestation cites the NFD offsets with the NFD toponym.
  T.setReviewer(work, { name: 'Ada' });
  T.decide(work, NFD, ms[0].id, { status: 'confirmed', place: 'https://pleiades.stoa.org/places/579885' }, { at: NOW });
  const w2 = T.readWork(T.serialiseWork(work));
  const [a] = T.attestationsFrom(w2, NFD).attestations;
  assert.equal(a.names[0].toponym, ms[0].text);
  assert.equal(a.citations[0].locator, `characters ${ms[0].start} to ${ms[0].end}`);
});

test('marks in another order, astral letters before the name, and a text already composed all map', async () => {
  // a + acute + dot below: NFC puts the dot below first, so the model's letter is not the file's.
  const text = 'x a\u0301\u0323 𝔄 Roma est.';
  assert.notEqual(text, text.normalize('NFC'));
  const { work, run } = await found(text, ['Roma', 'ạ\u0301']);
  assert.deepEqual(run.counts, {});
  const ms = T.suggestions(work);
  assert.deepEqual(ms.map((m) => slice(text, m)), ['a\u0301\u0323', 'Roma'], 'the reordered letter is taken whole, in the form the file has');
  assert.equal(ms[1].start, T.cpLength(text.slice(0, text.indexOf('Roma'))), 'code points, past the astral letter');
  assert.notEqual(ms[1].start, text.indexOf('Roma'), 'UTF-16 would have given another number');
});

test('a name that begins or ends inside a composed character is refused, beside the same name taken whole', async () => {
  // x + acute has no composed form: it stays two code points in NFC, so the bare "x" is found in the text, inside the character.
  const text = 'at x\u0301 and x then';
  const { work, run } = await found(text, ['x', 'x\u0301']);
  assert.deepEqual(T.suggestions(work).map((m) => [m.start, m.text]), [[3, 'x\u0301'], [10, 'x']], 'the whole character and the free x are suggested');
  assert.equal(run.counts['text-mention-invalid'], 1, 'the x inside x + acute is refused');
  // A name that is half of a letter that composes is not in the composed text at all.
  const hw = T.newWork({ text: 'Ae\u0301nea', source: SOURCE, now: NOW });
  const said = fake(() => ({ reply: { mentions: [{ text: 'Ae', prefix: '', suffix: 'nea', start: 0, kind: 'settlement' }] } }));
  const half = await T.runExtraction({ work: hw, text: 'Ae\u0301nea', provider: said, model: 'm', now: () => NOW });
  assert.equal(T.suggestions(hw).length, 0);
  assert.equal(half.counts['text-not-in-text'], 1);
  const whole = await found('Ae\u0301nea', ['Aénea']);
  assert.equal(T.suggestions(whole.work)[0].text, 'Ae\u0301nea', 'control: the whole name is found, as the file has it');
});

test('CRLF: a name across a line break is found, and every offset counts the carriage return', async () => {
  const text = 'We came to Aquae\r\nSulis, and then\r\nto Roma by the road.\r\n';
  const provider = fake(() => ({ reply: { mentions: [
    { text: 'Aquae\nSulis', prefix: 'We came to ', suffix: ', and then', start: 11, kind: 'settlement' },
    { text: 'Roma', prefix: 'to ', suffix: ' by the road', start: 99, kind: 'settlement' }] } }));
  const work = T.newWork({ text, source: SOURCE, now: NOW });
  const run = await T.runExtraction({ work, text, provider, model: 'm', now: () => NOW });
  assert.deepEqual(run.counts, {});
  assert.equal(provider.calls[0].chunk.text.includes('\r'), false, 'the model was sent line feeds');
  const [a, r] = T.suggestions(work);
  assert.equal(a.text, 'Aquae\r\nSulis', 'the name is the text as given');
  assert.equal(slice(text, a), 'Aquae\r\nSulis');
  assert.equal(r.start, text.indexOf('Roma'), 'Roma is after two carriage returns: all of them counted');
  assert.equal(slice(text, r), 'Roma');
  // Control: a text with line feeds only gives offsets two fewer.
  assert.equal(text.replace(/\r\n/g, '\n').indexOf('Roma'), r.start - 2);
});

test('normalised(): a text already composed with line feeds is the identity; the map is by whole characters', () => {
  const plain = normalised('Roma.\nOstia.');
  assert.equal(plain.identity, true);
  assert.deepEqual(plain.toOriginal(2, 5), [2, 5]);
  const n = normalised('a\u0301b\r\nc');
  assert.equal(n.identity, false);
  assert.equal(n.text, 'áb\nc');
  assert.deepEqual(n.toOriginal(0, 1), [0, 2], 'á, two code points as given');
  assert.deepEqual(n.toOriginal(1, 2), [2, 3]);
  assert.deepEqual(n.toOriginal(2, 3), [3, 5], 'the line feed the model saw is CR LF as given');
  assert.deepEqual(n.toOriginal(0, 4), [0, 6]);
  assert.equal(n.toOriginal(1, 1), null);
  assert.equal(normalised('x\u0301y').toOriginal(0, 1), null, 'x + acute is one character: its first half is no span');
  assert.deepEqual(normalised('x\u0301y').toOriginal(0, 2), [0, 2], 'control: the whole of it is');
  // Hangul written as conjoining jamo composes to one syllable.
  const h = normalised('\u1112\u1161\u11ab x');
  assert.equal(h.text, '한 x');
  assert.deepEqual(h.toOriginal(0, 1), [0, 3]);
});

test('normalised(): if the segments do not compose to what NFC gives, the whole text is one segment and no inner span is mapped', () => {
  const t = 'a\u0301c';
  const n = normalised(t, { continues: () => false });   // a boundary rule that cuts every character apart
  assert.equal(n.text, t.normalize('NFC'));
  assert.equal(n.coarse, true, 'the check against NFC of the whole failed, so it fell back');
  assert.deepEqual(n.toOriginal(0, n.text.length), [0, 3]);
  assert.equal(n.toOriginal(0, 1), null);
  // Control: with the real rule it is not coarse, and the same span maps.
  const ok = normalised(t);
  assert.equal(ok.coarse, undefined);
  assert.deepEqual(ok.toOriginal(0, 1), [0, 2]);
});

test('decodeText: UTF-8, its byte order mark noted and not counted; UTF-16 and other encodings refused in words', () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.deepEqual(decodeText(enc('Roma est.'), 'a.txt'), { text: 'Roma est.', bom: false });
  const bom = decodeText(Uint8Array.of(0xef, 0xbb, 0xbf, ...enc('Roma est.')), 'a.txt');
  assert.deepEqual(bom, { text: 'Roma est.', bom: true }, 'offsets count from the first character after the mark');
  assert.equal(decodeText(Uint8Array.of(0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...enc('x')), 'a.txt').text, '\ufeffx', 'a second U+FEFF is a character of the text');
  const refused = (bytes, re) => assert.throws(() => decodeText(bytes, 'a.txt'), (e) => e instanceof DataError && re.test(e.message), String(re));
  refused(Uint8Array.of(0xff, 0xfe, 0x52, 0x00, 0x6f, 0x00), /UTF-16/);
  refused(Uint8Array.of(0xfe, 0xff, 0x00, 0x52, 0x00, 0x6f), /UTF-16/);
  refused(Uint8Array.of(0x52, 0x00, 0x6f, 0x00, 0x6d, 0x00), /UTF-16/);
  refused(Uint8Array.from(Buffer.from('K\xf6ln est.', 'latin1')), /not encoded as UTF-8/);
  // Control: the same word in UTF-8 reads, its letter intact.
  assert.equal(decodeText(enc('Köln est.'), 'a.txt').text, 'Köln est.');
  refused(new Uint8Array(0), /empty/);
});

test('a work file records a byte order mark, and refuses a note of one that is not true or false', () => {
  const w = T.newWork({ text: 'Roma est.', source: SOURCE, bom: true, now: NOW });
  assert.equal(w.text.bom, true);
  assert.equal(T.readWork(T.serialiseWork(w)).text.bom, true);
  assert.equal(T.newWork({ text: 'Roma est.', source: SOURCE, now: NOW }).text.bom, undefined, 'control: none noted when there was none');
  const bad = JSON.parse(T.serialiseWork(w)); bad.text.bom = 'yes';
  assert.throws(() => T.readWork(bad), /byte order mark/);
});
