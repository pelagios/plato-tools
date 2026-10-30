// Hermes, place names in a text, phase 2: what a run may cost in tokens for a text in Greek, Cyrillic,
// Arabic or Chinese (Stephen's decision of 30 October 2026, Q8 A). One token for 3.5 characters is
// about right for English and several times too few for Greek or CJK, which also made the second
// confirmation (over 200 parts or $5) come too late. Each script has a ratio, an ESTIMATE labelled so
// and rounded towards too many tokens; a mixed text is counted run by run; and the real count the
// provider gives for the first part replaces the estimates for the rest. A provider's own token-counting
// service is never asked: that would send the text (the 1 October ruling).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/engine/hermes/text/index.js';
import { SCRIPT_RATIOS, tokensOf, calibrate } from '../src/engine/hermes/text/prices.js';

// The Fable review's sample: polytonic Greek of about 70 code points, which the old ratio put at 20 tokens.
const GREEK = 'ἐν Ἀθήναις καὶ ἐν Κορίνθῳ οἱ ἄνδρες ἔμειναν, ἔπειτα εἰς Σπάρτην ἦλθον.';
const LATIN = 'On the road from Rome the party walked for many hours, resting at an inn.';
const cps = (s) => Array.from(s).length;

test('the review\'s polytonic sample: the old ratio said 20 tokens, a token for about 3.5 characters; now it is counted by its script', () => {
  const n = cps(GREEK);
  assert.ok(n >= 68 && n <= 72, `the sample is about 70 code points (${n})`);
  assert.equal(Math.ceil(n / T.CHARS_PER_TOKEN), 20, 'what one ratio for every script gave');
  const t = tokensOf(GREEK);
  assert.deepEqual(Object.keys(t.scripts), ['polytonic-greek']);
  assert.ok(t.tokens >= n * 0.9, `at least about a token for each character (${t.tokens})`);
  // Control: Latin text of the same length is counted as before.
  assert.equal(Math.ceil(tokensOf(LATIN).tokens), Math.ceil(cps(LATIN) / T.CHARS_PER_TOKEN));
  assert.deepEqual(Object.keys(tokensOf(LATIN).scripts), ['latin']);
});

test('decomposed (NFD) polytonic Greek is the same script, its marks counted with their letters, not as another script', () => {
  const nfd = GREEK.normalize('NFD');
  assert.ok(cps(nfd) > cps(GREEK));
  const t = tokensOf(nfd);
  assert.deepEqual(Object.keys(t.scripts), ['polytonic-greek']);
  assert.ok(t.tokens >= tokensOf(GREEK).tokens, 'never fewer than the composed text');
});

test('modern Greek, Cyrillic, Arabic and Chinese are each counted at their own ratio, every one labelled an estimate', () => {
  const sample = {
    greek: 'Η Αθήνα είναι η πρωτεύουσα της Ελλάδας.',
    cyrillic: 'Москва стоит на реке Москве, а Киев на Днепре.',
    arabic: 'القاهرة مدينة على نهر النيل في مصر.',
    cjk: '長安から洛陽へ向かう道に、多くの宿があった。',
  };
  for (const [script, text] of Object.entries(sample)) {
    const t = tokensOf(text);
    assert.deepEqual(Object.keys(t.scripts), [script], script);
    const r = SCRIPT_RATIOS[script];
    assert.equal(r.estimate, true, `${script} is labelled an estimate`);
    assert.ok(r.charsPerToken < T.CHARS_PER_TOKEN, `${script} has more tokens to the character than Latin`);
    assert.ok(t.tokens > cps(text) / T.CHARS_PER_TOKEN * 1.5, `${script}: well over what the Latin ratio gives`);
    assert.ok(Math.abs(t.tokens - cps(text) / r.charsPerToken) < 1e-9, `${script}: its characters over its ratio`);
  }
  assert.equal(SCRIPT_RATIOS.cjk.charsPerToken, 1, 'Chinese and Japanese: a token a character, to be on the safe side');
  assert.equal(SCRIPT_RATIOS.latin.charsPerToken, T.CHARS_PER_TOKEN);
  assert.ok(Object.values(SCRIPT_RATIOS).every((r) => Object.isFrozen(r) && r.estimate === true && !('measured' in r && r.measured)), 'none is a measurement');
  assert.ok(Object.isFrozen(SCRIPT_RATIOS));
});

test('a text of two scripts is counted run by run: Latin with a Greek quotation', () => {
  const text = `${LATIN} He wrote: ${GREEK} And so he went on to Capua.`;
  const t = tokensOf(text);
  assert.deepEqual(Object.keys(t.scripts).sort(), ['latin', 'polytonic-greek']);
  const greek = t.scripts['polytonic-greek'], latin = t.scripts.latin;
  assert.equal(greek + latin, cps(text), 'every character is in one run or the other');
  assert.ok(greek >= cps(GREEK) - 1 && greek <= cps(GREEK) + 2, 'the quotation, with the space before it');
  assert.ok(Math.abs(t.tokens - (greek / SCRIPT_RATIOS['polytonic-greek'].charsPerToken + latin / SCRIPT_RATIOS.latin.charsPerToken)) < 1e-9);
  // More than the text as all Latin, less than all Greek.
  assert.ok(t.tokens > cps(text) / SCRIPT_RATIOS.latin.charsPerToken && t.tokens < cps(text) / SCRIPT_RATIOS['polytonic-greek'].charsPerToken);
});

test('a letter of a script with no ratio of its own is counted at the cautious "other"; digits and marks go with the text around them', () => {
  assert.ok(SCRIPT_RATIOS.other.estimate && SCRIPT_RATIOS.other.charsPerToken < T.CHARS_PER_TOKEN);
  const t = tokensOf('שלום עולם');
  assert.deepEqual(Object.keys(t.scripts), ['other']);
  assert.deepEqual(Object.keys(tokensOf('In 1492, 12 men.')), ['tokens', 'scripts']);
  assert.deepEqual(tokensOf('In 1492, 12 men.').scripts, { latin: 16 });
  assert.deepEqual(tokensOf('').scripts, {});
  assert.equal(tokensOf('').tokens, 0);
});

test('a chunk in Greek is estimated at several times a chunk of Latin of the same length; Latin is estimated as it was', () => {
  const lat = (n) => ({ text: 'a'.repeat(n) });
  // As it was: the characters over 3.5, the prompt over 3.5 too.
  assert.equal(T.estimateChunk(lat(3500)).input - T.estimateChunk(lat(0)).input, 1000);
  const greek = { text: 'ἐ'.repeat(3500) };
  const g = T.estimateChunk(greek), l = T.estimateChunk(lat(3500));
  const base = T.estimateChunk(lat(0)).input;   // the prompt and schema, sent with every part
  assert.ok(g.input - base >= 2.5 * (l.input - base), `Greek ${g.input - base} against Latin ${l.input - base}`);
  assert.ok(g.input - base >= 3500 * 0.95, 'at least a token for each Greek character');
  assert.ok(g.output.high > l.output.high);
  assert.deepEqual(g.scripts, { 'polytonic-greek': 3500 });
  // The run adds them up, and says which scripts were counted.
  const run = T.estimateRun([greek, lat(100)]);
  assert.deepEqual(run.scripts, { 'polytonic-greek': 3500, latin: 100 });
  // Strings are chunks too.
  assert.equal(T.estimateChunk('a'.repeat(3500)).input, l.input);
});

test('the words say when a count is an estimate for a script, and say nothing of it for Latin', () => {
  const fresh = new Date(Date.parse(T.PRICES.checkedOn) + 1 * 86_400_000);
  const words = (chunks) => { const e = T.estimateRun(chunks); return T.estimateWords(e, T.costOf(e, 'anthropic', 'claude-sonnet-5-5', { now: fresh })); };
  const greek = words([{ text: 'ἐν Ἀθήναις '.repeat(300) }]);
  assert.match(greek, /Greek/);
  assert.match(greek, /estimated ratio/);
  assert.match(greek, /the real count of the first part replaces/);
  assert.match(greek, /prices as of 2026-10-10[^]*$/);
  const latin = words([{ text: LATIN.repeat(40) }]);
  assert.doesNotMatch(latin, /estimated ratio|Greek|real count/);
  assert.match(latin, new RegExp(`, at prices as of ${T.PRICES.checkedOn}\\.$`), 'a Latin run reads as it did');
  // CJK and polytonic Greek have their own names.
  assert.match(words([{ text: '長安'.repeat(200) }]), /Chinese, Japanese or Korean/);
  assert.match(words([{ text: 'ἐν Ἀθήναις '.repeat(300) }]), /polytonic Greek/);
});

test('the first part\'s real count replaces the estimate for the rest, and the user is asked again only if that crosses a limit it had not', () => {
  const fresh = new Date(Date.parse(T.PRICES.checkedOn) + 1 * 86_400_000);
  const chunks = Array.from({ length: 30 }, () => ({ text: 'ἐν Ἀθήναις '.repeat(700).slice(0, 8000) }));
  const before = T.estimateRun(chunks);
  const costBefore = T.costOf(before, 'anthropic', 'claude-sonnet-5-5', { now: fresh });
  const estimated = T.estimateChunk(chunks[0]).input;
  // The provider says the first part took half what was estimated: the rest is cheaper, and nobody is asked.
  const less = calibrate(chunks, { chunk: chunks[0], usage: { input: Math.round(estimated / 2), output: 400 } }, { provider: 'anthropic', model: 'claude-sonnet-5-5', now: fresh, before: { estimate: before, cost: costBefore } });
  assert.ok(Math.abs(less.scale - 0.5) < 0.01);
  assert.ok(less.estimate.input < before.input * 0.55);
  assert.equal(less.ask, false);
  assert.equal(less.source, 'first-part', 'said to be a real count');
  // Four times what was estimated: this crosses $5 where the estimate did not, so the user is asked again.
  assert.equal(T.needsSecondConfirmation(before, costBefore), false, 'not asked at first');
  const more = calibrate(chunks, { chunk: chunks[0], usage: { input: estimated * 40, output: 400 } }, { provider: 'anthropic', model: 'claude-sonnet-5-5', now: fresh, before: { estimate: before, cost: costBefore } });
  assert.ok(more.scale > 39);
  assert.equal(more.ask, true);
  assert.ok(more.cost.usd.high > T.CONFIRM_USD);
  assert.equal(more.estimate.chunks, 30);
  // Already asked a second time at the start, and still over: not asked a third time.
  const wasAsked = { estimate: { ...before, chunks: 300 }, cost: { usd: { low: 1, high: 9 } } };
  assert.equal(calibrate(chunks, { chunk: chunks[0], usage: { input: estimated * 40, output: 400 } }, { provider: 'anthropic', model: 'claude-sonnet-5-5', now: fresh, before: wasAsked }).ask, false);
  // A count of nothing (a provider that does not say) leaves the estimate as it was.
  const none = calibrate(chunks, { chunk: chunks[0], usage: { input: 0, output: 0 } }, { provider: 'anthropic', model: 'claude-sonnet-5-5', now: fresh, before: { estimate: before, cost: costBefore } });
  assert.equal(none.scale, 1);
  assert.equal(none.source, 'estimate');
  assert.equal(none.estimate.input, before.input);
});
