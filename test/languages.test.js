// The language codes suggested by the lookup panel's language field (src/lib/languages.js), and the
// matching that finds them by code and by name. Each check that something is not found has, beside
// it, a text that does find it, so that an empty answer is not taken for a correct one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, matchLanguages } from '../src/lib/languages.js';
import { whgLang } from '../src/engine/gazetteer/index.js';

const codes = (q, opts) => matchLanguages(q, opts).map((l) => l.code);

test('every code is one WHG takes, sent as itself, and listed once', () => {
  assert.ok(LANGUAGES.length > 200, `${LANGUAGES.length} languages`);
  for (const l of LANGUAGES) {
    assert.match(l.code, /^[a-z]{2,3}$/, l.code);
    assert.equal(whgLang(l.code), l.code, `${l.code} would be sent as ${whgLang(l.code)}`);
    assert.ok(l.name && l.name.trim() === l.name, l.code);
  }
  const seen = new Set(LANGUAGES.map((l) => l.code));
  assert.equal(seen.size, LANGUAGES.length, 'a code is listed twice');
  // The control: a code with a two-letter equivalent IS sent as another, so the check above can fail.
  assert.equal(whgLang('eng'), 'en');
});

test('the historical languages relevant to gazetteers are all listed, and the major modern ones', () => {
  const want = ['la', 'grc', 'ang', 'enm', 'fro', 'frm', 'gmh', 'goh', 'non', 'sga', 'mga', 'ota', 'peo', 'akk', 'egy', 'cop', 'syc', 'arc', 'hbo', 'sa', 'pi', 'lzh', 'och',
    'en', 'fr', 'de', 'es', 'it', 'pt', 'ru', 'zh', 'ja', 'ar', 'hi', 'tr', 'fa', 'el', 'he', 'nl', 'cy', 'ga'];
  const have = new Set(LANGUAGES.map((l) => l.code));
  assert.deepEqual(want.filter((c) => !have.has(c)), []);
});

test('by code: "ang" finds Old English first, and "an" finds ang (after an itself)', () => {
  assert.equal(matchLanguages('ang')[0].code, 'ang');
  assert.equal(matchLanguages('ang')[0].name, 'Old English');
  const an = codes('an');
  assert.equal(an[0], 'an');
  assert.ok(an.includes('ang'), an.join(' '));
  // Upper case and spaces are read as typed in lower case.
  assert.equal(codes(' ANG ')[0], 'ang');
});

test('by name: "old eng", "Old Eng" and "eng old" find ang; "old english" does not find enm', () => {
  for (const q of ['old eng', 'Old Eng', 'eng old', 'Old English', 'english']) assert.ok(codes(q).includes('ang'), `${q}: ${codes(q).join(' ')}`);
  assert.equal(codes('Old Eng')[0], 'ang');
  assert.ok(!codes('old english').includes('enm'), codes('old english').join(' '));
  assert.ok(codes('middle english').includes('enm'));   // the control: enm is found by its own name
});

test('accents are not needed, and any word of the name is found by its beginning, never its middle', () => {
  assert.ok(codes('bokmal').includes('nb'));
  assert.ok(codes('greek').includes('grc'));
  assert.ok(codes('chinese').includes('lzh'));
  assert.deepEqual(codes('reek'), []);
  // "und" (undetermined, which WHG is never sent) begins no code and no word of a name: nothing is offered.
  assert.deepEqual(codes('und'), []);
  assert.ok(codes('sund').includes('su'), 'the control: Sundanese is found by the beginning of its name');
});

test('the best come first: an exact code, then codes beginning with it, then names', () => {
  const la = codes('la', { limit: 50 });
  assert.equal(la[0], 'la');
  assert.ok(la.indexOf('lad') < la.indexOf('lo'), la.join(' '));   // lad begins with la; Lao is found by name only
});

test('nothing for an empty text or one that matches nothing, and at most the limit', () => {
  assert.deepEqual(matchLanguages(''), []);
  assert.deepEqual(matchLanguages('   '), []);
  assert.deepEqual(matchLanguages(null), []);
  assert.deepEqual(matchLanguages('qqq'), []);
  assert.ok(matchLanguages('q').length > 0, 'the control: a single letter finds something');
  assert.equal(matchLanguages('a', { limit: 3 }).length, 3);
  assert.ok(matchLanguages('a').length <= 10);
});
