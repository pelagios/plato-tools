// Hermes, place names in a text, phase 2: the work file (Stephen's decisions of 30 October 2026).
//   Q9 A   a reviewer may add a name the model missed: a result of provider "reviewer", no model, which
//          readWork and the attestation's note read as the contributor's own;
//   Q2 A   a decision may say that one occurrence of a spelling is a different place from the others;
//   gap    the text is kept in the work file, so that the review can be read again, but a copy for
//          sharing leaves it out and carries, in its place, short quoted contexts of the names with the
//          text's rights statement; and the rights statement can be given.
//
// Every test that something is refused or absent has beside it the case that is accepted or present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/engine/hermes/text/index.js';
import { DataError } from '../src/engine/input.js';
import { found, NOW, REVIEWER, SOURCE } from './hermes-text-helpers.js';

const TEXT = 'He came from Ostia to Roma, and later to Capua; the road to Neapolis was long.';
const cpOf = (text, s) => T.cpLength(text.slice(0, text.indexOf(s)));
const AT = '2026-10-02T09:00:00Z';

async function missed() {
  const { work } = await found(TEXT, ['Ostia', 'Roma']);   // the model missed Capua and Neapolis
  T.setReviewer(work, REVIEWER);
  return work;
}

test('a reviewer adds a name the model missed: a result of the reviewer\'s own, which is suggested, counted and read back', async () => {
  const work = await missed();
  const start = cpOf(TEXT, 'Capua');
  assert.equal(T.suggestions(work).some((s) => s.text === 'Capua'), false, 'the model did not find it');
  const id = T.addMention(work, TEXT, { start, end: start + 5 }, { at: AT });
  assert.equal(id, `${start}-${start + 5}`);
  const s = T.suggestions(work).find((x) => x.id === id);
  assert.equal(s.text, 'Capua');
  assert.equal(s.provider, 'reviewer');
  assert.equal(s.added, true);
  assert.equal(s.kind, 'other', 'no kind is guessed for a name a person added');
  assert.equal(s.generated_at, AT);
  assert.equal(T.suggestions(work).filter((x) => x.added).length, 1, 'only the one added');
  const r = work.results.at(-1);
  assert.deepEqual({ provider: r.provider, model: r.model, prompt_version: r.prompt_version, reviewer: r.reviewer }, { provider: 'reviewer', model: 'reviewer', prompt_version: 'reviewer', reviewer: { name: 'Ada Lovelace', orcid: REVIEWER.orcid } });
  assert.deepEqual(r.chunk, { index: 0, start: 0, end: T.cpLength(TEXT), sha256: work.text.sha256 });
  assert.deepEqual(r.usage, { input: 0, output: 0 }, 'nothing was sent anywhere');
  assert.deepEqual(T.reviewProgress(work), { suggested: 3, decided: 0, confirmed: 0, linked: 0, rejected: 0, added: 1 });
  assert.deepEqual(T.readWork(T.serialiseWork(work)), work, 'read back as written');
  // A model's results are still shown when only that model is asked for: the reviewer's are always the reviewer's.
  assert.equal(T.suggestions(work, { provider: 'fake', model: 'claude-x' }).some((x) => x.text === 'Capua'), true);
  assert.equal(T.suggestions(work, { provider: 'fake', model: 'claude-x' }).some((x) => x.text === 'Ostia'), true, 'control: and the model\'s own');
  assert.equal(T.suggestions(work, { provider: 'other', model: 'x' }).some((x) => x.text === 'Ostia'), false, 'control: another model\'s are not');
});

test('a name cannot be added without a named reviewer, outside the text, blank, too long, twice, or for another text', async () => {
  const work = await missed();
  const start = cpOf(TEXT, 'Capua');
  const add = (w, span, text = TEXT) => T.addMention(w, text, span, { at: AT });
  const anon = JSON.parse(T.serialiseWork(work)); anon.review.reviewer = null;
  assert.throws(() => add(anon, { start, end: start + 5 }), (e) => e instanceof DataError && /Name the reviewer/.test(e.message));
  assert.throws(() => add(work, { start: T.cpLength(TEXT) - 2, end: T.cpLength(TEXT) + 4 }), /not a span of the text with words in it/);
  assert.throws(() => add(work, { start: 2, end: 3 }), /not a span of the text with words in it/);
  assert.throws(() => add(work, { start: 5, end: 5 }), /not a span/);
  assert.throws(() => add(work, { start: 0, end: 201 }), /longer than any place name/);
  assert.throws(() => add(work, { start, end: start + 5 }, TEXT + ' '), /not the text the work file was made from/);
  assert.throws(() => T.addMention(work, TEXT, { start, end: start + 5 }, { at: 'yesterday' }), /ISO 8601/);
  const ostia = cpOf(TEXT, 'Ostia');
  assert.throws(() => add(work, { start: ostia, end: ostia + 5 }), /already suggested/);
  const before = work.results.length;
  assert.equal(add(work, { start, end: start + 5 }), `${start}-${start + 5}`, 'control: a good span is taken');
  assert.equal(work.results.length, before + 1);
  assert.throws(() => add(work, { start, end: start + 5 }), /already suggested/, 'and then it is already suggested');
  assert.equal(work.results.length, before + 1, 'a refusal adds nothing');
});

test('the attestation of a name the reviewer added says so, and not that a model suggested it; a model\'s says what it did', async () => {
  const work = await missed();
  const start = cpOf(TEXT, 'Capua');
  const id = T.addMention(work, TEXT, { start, end: start + 5 }, { at: AT });
  T.decide(work, TEXT, id, { status: 'confirmed', type: 'settlement', place: 'https://pleiades.stoa.org/places/432754' }, { at: '2026-10-02T09:05:00Z' });
  const ostia = T.suggestions(work).find((s) => s.text === 'Ostia');
  T.decide(work, TEXT, ostia.id, { status: 'confirmed', place: 'https://pleiades.stoa.org/places/422995' }, { at: '2026-10-02T09:06:00Z' });
  const [o, c] = T.attestationsFrom(work, TEXT).attestations;
  assert.equal(c.names[0].toponym, 'Capua');
  assert.equal(c.notes, 'Added by the contributor, who marked it in the text: no model suggested it (2026-10-02); linked by the contributor.');
  assert.doesNotMatch(c.notes, /Suggested by|guess/);
  assert.deepEqual(c.types, [{ label: 'settlement' }], 'the kind the reviewer confirmed');
  assert.equal(c.citations[0].locator, `characters ${start} to ${start + 5}`);
  assert.deepEqual(c.contributor, REVIEWER);
  assert.match(o.notes, /^Suggested by claude-x-20261001 \(fake\)/, 'control: the model\'s still say so');
  // Not linked (the dataset's case): confirmed by the contributor, not linked.
  assert.equal(T.hermesTextNote({ model: 'm', provider: 'p', prompt: 'v', date: '2026-10-01', linked: false }), 'Suggested by m (p), prompt v, 2026-10-01; confirmed by the contributor.');
  assert.equal(T.hermesTextNote({ addedBy: true, date: '2026-10-02', linked: false }), 'Added by the contributor, who marked it in the text: no model suggested it (2026-10-02).');
});

test('readWork refuses a reviewer\'s result no review could have written', async () => {
  const work = await missed();
  const start = cpOf(TEXT, 'Capua');
  T.addMention(work, TEXT, { start, end: start + 5 }, { at: AT });
  const tamper = (fn) => { const w = JSON.parse(T.serialiseWork(work)); fn(w); return () => T.readWork(w); };
  assert.ok(tamper(() => {})(), 'control: as written it is read');
  const last = (w) => w.results.at(-1);
  assert.throws(tamper((w) => { last(w).mentions.push({ start: 0, end: 2, text: 'He', kind: 'other' }); }), /one name/);
  assert.throws(tamper((w) => { last(w).model = 'claude-x'; }), /reviewer's result/);
  assert.throws(tamper((w) => { delete last(w).reviewer; }), /names no reviewer/);
  assert.throws(tamper((w) => { last(w).reviewer = { name: '' }; }), /reviewer/);
  assert.throws(tamper((w) => { last(w).chunk.end -= 1; }), /whole text/);
  assert.throws(tamper((w) => { last(w).usage = { input: 5, output: 1 }; }), /sent nothing|usage/);
  assert.throws(tamper((w) => { last(w).prompt_version = 'hermes-text 1'; }), /reviewer's result/);
});

test('a decision may say an occurrence is a different place from the others of its spelling', async () => {
  const text = 'Newton lay near Leeds; but another Newton lay by the sea.';
  const { work } = await found(text, ['Newton']);
  T.setReviewer(work, REVIEWER);
  const [a, b] = T.suggestions(work);
  assert.deepEqual(T.decide(work, text, b.id, { status: 'confirmed', separate: true }, { at: AT }), { status: 'confirmed', decided_at: AT, separate: true });
  assert.equal(T.decide(work, text, a.id, { status: 'confirmed' }, { at: AT }).separate, undefined, 'control: the first is as it was');
  assert.throws(() => T.decide(work, text, a.id, { status: 'confirmed', separate: 'yes' }), /true or false/);
  assert.equal(T.decide(work, text, a.id, { status: 'rejected', separate: true }, { at: AT }).separate, undefined, 'a rejection is not a place');
  assert.deepEqual(T.readWork(T.serialiseWork(work)), work);
  const bad = JSON.parse(T.serialiseWork(work)); bad.review.decisions[b.id].separate = 1;
  assert.throws(() => T.readWork(bad), /separate/);
});

test('the text\'s rights statement is kept with its source, and an address for it is the source\'s licence', () => {
  const w = T.newWork({ text: TEXT, source: { ...SOURCE, rights: '  Public domain: a transcription made in 1912.  ' }, now: NOW });
  assert.equal(w.source.rights, 'Public domain: a transcription made in 1912.');
  assert.deepEqual(T.readWork(T.serialiseWork(w)).source, w.source);
  assert.equal(T.sourceOf(w).licence, undefined, 'a sentence is not a licence\'s address');
  const cc0 = T.newWork({ text: TEXT, source: { ...SOURCE, rights: 'https://creativecommons.org/publicdomain/zero/1.0/' }, now: NOW });
  assert.equal(T.sourceOf(cc0).licence, 'https://creativecommons.org/publicdomain/zero/1.0/');
  assert.equal(T.sourceOf(T.newWork({ text: TEXT, source: SOURCE, now: NOW })).licence, undefined, 'control: none given, none made up');
  assert.equal(T.newWork({ text: TEXT, source: { ...SOURCE, rights: '   ' }, now: NOW }).source.rights, undefined, 'blank is none');
  assert.throws(() => T.newWork({ text: TEXT, source: { ...SOURCE, rights: 'x'.repeat(1001) }, now: NOW }), /rights/);
  const bad = JSON.parse(T.serialiseWork(w)); bad.source.rights = 7;
  assert.throws(() => T.readWork(bad), /rights statement/);
});

test('the text is kept in the work file, and checked to be the text the file says it is of', () => {
  const w = T.newWork({ text: TEXT, source: SOURCE, now: NOW });
  assert.equal(w.text.content, TEXT);
  assert.equal(T.textOf(w), TEXT);
  assert.deepEqual(T.readWork(T.serialiseWork(w)), w);
  const off = T.newWork({ text: TEXT, source: SOURCE, keepText: false, now: NOW });
  assert.equal(off.text.content, undefined);
  assert.equal(T.textOf(off), null);
  assert.equal(off.text.sha256, w.text.sha256, 'the same text, the same hash, kept or not');
  const bad = JSON.parse(T.serialiseWork(w)); bad.text.content = TEXT.replace('Roma', 'Rome');
  assert.throws(() => T.readWork(bad), /is not the text it says it is of/);
  const num = JSON.parse(T.serialiseWork(w)); num.text.content = 5;
  assert.throws(() => T.readWork(num), /is not the text it says it is of/);
});

test('a copy for sharing leaves the text out and carries short quoted contexts with its rights statement', async () => {
  // The names have words around them; one lies near the start, one has an astral letter before it, and a sentinel is far from any.
  const far = 'SENTINEL-FAR-FROM-EVERY-NAME'.repeat(3);
  const text = `Roma est. ${'w '.repeat(60)}${far} ${'x '.repeat(40)}𝔄 Ostia lay ${'y '.repeat(40)}and then ${'z '.repeat(40)}`;
  const { work } = await found(text, ['Roma', 'Ostia'], { source: { ...SOURCE, rights: 'Public domain; transcription by A. Reader, 2020.' } });
  T.setReviewer(work, REVIEWER);
  const ids = T.suggestions(work).map((s) => s.id);
  const shared = T.withoutText(work);
  assert.equal(shared.text.content, undefined);
  assert.equal(work.text.content, text, 'the file itself is as it was');
  assert.equal(shared.context.rights, 'Public domain; transcription by A. Reader, 2020.');
  assert.deepEqual(Object.keys(shared.context.of), ids);
  const [roma, ostia] = ids.map((id) => shared.context.of[id]);
  assert.deepEqual(roma, { start: 0, end: 4, before: '', after: text.slice(4, 4 + T.CONTEXT_CHARACTERS) }, 'at the start there is nothing before');
  assert.equal(T.cpLength(ostia.before), T.CONTEXT_CHARACTERS);
  assert.equal(T.cpLength(ostia.after), T.CONTEXT_CHARACTERS);
  assert.ok(ostia.before.endsWith('x 𝔄 '), 'counted in code points, the astral letter whole');
  assert.equal(ostia.after.startsWith(' lay y y'), true);
  // The text is not in it, but what is quoted is: an absence beside a presence.
  const json = T.serialiseWork(shared);
  assert.equal(json.includes('SENTINEL-FAR'), false, 'a passage far from every name is not in the copy');
  assert.equal(json.includes('Ostia lay') || json.includes(' lay y y'), true, 'a passage around a name is');
  assert.equal(T.serialiseWork(work).includes('SENTINEL-FAR'), true, 'control: the full file has it');
  // It reads back, is still the file of that text, and can still be reviewed with the text given.
  assert.deepEqual(T.readWork(json), shared);
  T.checkText(shared, text);
  T.decide(shared, text, ids[0], { status: 'confirmed' }, { at: AT });
  assert.equal(T.attestationsFrom(shared, text, { reviewer: REVIEWER }).counts.confirmed, 1);
  // The text given back is kept again, and the quoted contexts go (the text is there to quote).
  const back = T.keepText(shared, text);
  assert.equal(back.text.content, text);
  assert.equal(back.context, undefined);
  assert.throws(() => T.keepText(shared, text + '!'), /not the text the work file was made from/);
});

test('without a rights statement the copy for sharing says none was given; and a context is only for a name the file has', async () => {
  const { work } = await found(TEXT, ['Ostia']);
  const shared = T.withoutText(work);
  assert.equal(shared.context.rights, 'No statement of the text\'s rights was given when this file was made: the quotations in it are the contributor\'s to answer for.');
  assert.match(T.TEXT_WORDS.quotedContext, /not in this file/);
  const bad = JSON.parse(T.serialiseWork(shared)); bad.context.of['0-1'] = { start: 0, end: 1, before: '', after: 'x' };
  assert.throws(() => T.readWork(bad), /quoted context of 0-1/);
  const noRights = JSON.parse(T.serialiseWork(shared)); noRights.context.rights = '';
  assert.throws(() => T.readWork(noRights), /rights statement/);
  const long = JSON.parse(T.serialiseWork(shared)); long.context.of[Object.keys(long.context.of)[0]].after = 'x'.repeat(500);
  assert.throws(() => T.readWork(long), /quoted context of/);
  // A name the reviewer adjusted is quoted at its adjusted span.
  const [s] = T.suggestions(work);
  T.setReviewer(work, REVIEWER);
  T.decide(work, TEXT, s.id, { status: 'confirmed', start: s.start, end: s.start + 3 }, { at: AT });
  const adj = T.withoutText(work).context.of[s.id];
  assert.deepEqual([adj.start, adj.end], [s.start, s.start + 3]);
  assert.equal(adj.after.startsWith(TEXT.slice(s.start + 3, s.start + 3 + 10)), true);
});
