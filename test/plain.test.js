// The plain-language layer of Map your data (src/engine/plain.js): the formats a scholar asks for first, what a format
// cannot hold of a review's decisions, and what came of writing a result, said from the engine's own report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAIN_TARGETS, targetList, lossyWords, outcome } from '../src/engine/plain.js';
import { TARGETS } from '../src/engine/pipeline.js';
import { Report, LOSS_TEXT, whgVerdictText } from '../src/engine/report.js';
import { WHG_PROBLEMS } from '../src/formats/whg-lpf-check.js';
import MAP from '../src/engine/methodos/recipes/map-your-data.js';
import { RECIPES } from '../src/engine/methodos/recipes/index.js';

const asReport = (rep) => ({ items: [...rep.kinds.values()], counts: rep.counts, errors: 0 });

test('Map your data offers a spreadsheet first, then a file for WHG, then the formats there were before, every one a format the engine writes', () => {
  const choices = MAP.asks.target.choices;
  assert.deepEqual(choices.slice(0, 2), ['table-flat', 'lpf2']);
  for (const k of ['plato-json', 'plato-jsonl', 'tables', 'ntriples', 'lpf', 'lpf-seq']) assert.ok(choices.indexOf(k) > 1, k);
  for (const k of choices) assert.ok(Object.hasOwn(TARGETS, k), k);
  assert.equal(new Set(choices).size, choices.length);
  // Every workflow that asks the format asks it of the same list (downstream.js takes Map your data's).
  let asked = 0;
  for (const r of Object.values(RECIPES)) if (r.asks?.target) { asked++; assert.deepEqual(r.asks.target.choices, choices, r.key); }
  assert.ok(asked >= 5, `${asked} recipes ask the format`);
});

test('the list beside Convert: the recipe\'s choices first, in plain words, then the rest in the engine\'s words; never the file\'s own format', () => {
  const list = targetList(TARGETS, MAP.asks.target.choices, 'plato-json');
  assert.deepEqual(list.slice(0, 2), [['table-flat', 'A spreadsheet: one row per place (CSV)'], ['lpf2', 'A file for the World Historical Gazetteer (Linked Places Format v2)']]);
  assert.equal(list.some(([k]) => k === 'plato-json'), false, 'the file\'s own format is not offered');
  assert.deepEqual(list.map(([k]) => k).sort(), Object.keys(TARGETS).filter((k) => k !== 'plato-json').sort(), 'every other format is there, once');
  assert.equal(list.find(([k]) => k === 'ntriples')[1], TARGETS.ntriples.label);
  // With no choices (a tool used on its own, or a step whose format is fixed), the engine's list, in its order and its words.
  assert.deepEqual(targetList(TARGETS, [], 'lpf'), Object.entries(TARGETS).filter(([k]) => k !== 'lpf').map(([k, v]) => [k, v.label]));
  assert.deepEqual(Object.keys(PLAIN_TARGETS), ['table-flat', 'lpf2']);
});

test('what a format cannot hold of the decisions: Linked Places Format (both versions) and the tables keep a link alone; the flat table also who decided; PLATO JSON loses nothing', () => {
  const lpf = lossyWords('lpf', 4);
  assert.equal(lpf, 'Linked Places Format, the format chosen beside Convert, cannot hold everything in the 4 decisions this dataset records about which places are the same: each match is kept as a link, but not who decided it or from which candidate, and a place you said was not the same is left out. PLATO JSON keeps all of it.');
  assert.equal(lossyWords('lpf-seq', 4), lpf);
  assert.match(lossyWords('lpf2', 1), /^Linked Places Format v2, the file for the World Historical Gazetteer, the format chosen beside Convert, cannot hold everything in the 1 decision this dataset records/);
  assert.match(lossyWords('lpf2-seq', 2), /but not who decided it or from which candidate/);
  assert.match(lossyWords('tables', 2), /^The spreadsheet tables, the format chosen beside Convert, cannot hold everything in the 2 decisions/);
  const flat = lossyWords('table-flat', 7);
  assert.match(flat, /^The spreadsheet, chosen beside Convert, is a summary of the 7 decisions/);
  assert.match(flat, /each match is kept with its kind, the gazetteer it is in and who decided it, but not the candidate it answered, and a place you said was not the same is left out/);
  assert.doesNotMatch(flat, /but not who decided it/);
  for (const k of ['plato-json', 'plato-jsonl', 'ntriples']) assert.equal(lossyWords(k, 4), '', k);
  // Nothing decided (or not yet counted): nothing to say, of any format.
  for (const k of Object.keys(TARGETS)) { assert.equal(lossyWords(k, 0), '', k); assert.equal(lossyWords(k, null), '', k); }
});

/** A report as convert --to lpf2 makes it (pipeline.js whgWatch): a warning for each reason with its examples, the verdict, and the temporary ids. */
function whgReport(total, groups, temporary = 0) {
  const rep = new Report();
  rep.count('places', total);
  let refused = 0;
  for (const [code, count, examples] of groups) { examples.forEach((x, i) => rep.add('warning', `whg-${code}`, LOSS_TEXT[`whg-${code}`], x, i === 0 ? count : 0)); refused = Math.max(refused, count); }
  rep.add(refused || !total ? 'warning' : 'note', 'whg-verdict', whgVerdictText(total - refused, total), undefined, refused || 1);
  if (temporary) rep.add('warning', 'whg-temporary-ids', LOSS_TEXT['whg-temporary-ids'], 'https://temporary.invalid/my-dataset/place/1', temporary);
  return asReport(rep);
}

test('the WHG verdict in plain words: how many would be accepted, and for the rest each reason with its examples and its remedy', () => {
  const o = outcome(whgReport(12, [['no-kind', 1, ['Nowhere Known (https://example.org/place/6)']]]));
  assert.equal(o.kind, 'whg'); assert.equal(o.tone, 'warn');
  assert.equal(o.head, '11 of 12 places would be accepted by WHG; 1 would be refused:');
  assert.deepEqual(o.reasons, [{ words: '1 place has no kind of place; WHG needs one (a type, or a feature class).',
    remedy: 'To have them accepted, give each a kind of place (in a table, a column of types, in words or as Getty AAT identifiers, or of GeoNames feature classes), and convert again.',
    examples: ['Nowhere Known (https://example.org/place/6)'] }]);
  assert.equal(o.scope, "This is WHG's schema for Linked Places Format v2, as copied into these tools on 18 November 2026; WHG also tests the shape of each location, which is not done here.");
  assert.deepEqual(o.notes, []);
});

test('the WHG verdict: all accepted is good news with no reasons; none accepted says so; temporary ids are said in one plain sentence, with what WHG would do with them', () => {
  const all = outcome(whgReport(6, []));
  assert.equal(all.tone, 'good'); assert.equal(all.head, 'All 6 places would be accepted by WHG.'); assert.deepEqual(all.reasons, []);
  const none = outcome(whgReport(6, [['no-kind', 6, ['A (a)', 'B (b)']], ['no-date', 6, ['A (a)']]], 6));
  assert.equal(none.tone, 'warn'); assert.equal(none.head, 'None of the 6 places would be accepted by WHG:');
  assert.equal(none.reasons.length, 2);
  assert.equal(none.reasons[1].words, '6 places: each has no date; WHG needs one (a year or a span of years, for the place or for one of its names, types, locations or relations).');
  assert.deepEqual(none.reasons[0].examples, ['A (a)', 'B (b)']);
  assert.equal(none.notes.length, 1);
  assert.match(none.notes[0], /^Your places have working ids for now \(6 places\)\. WHG would keep those ids as they are, so before you send this file to WHG, give the web address your places will live under/);
  assert.doesNotMatch(none.notes[0], /--base|@id/);
  const empty = outcome(whgReport(0, []));
  assert.equal(empty.tone, 'warn'); assert.equal(empty.head, 'There are no places, and WHG needs at least one.');
});

test('every reason WHG can refuse a place for is said in plain words from the report\'s own (a change to the report\'s wording must not silently drop a reason)', () => {
  assert.ok(Object.keys(WHG_PROBLEMS).length >= 10);
  for (const code of Object.keys(WHG_PROBLEMS)) {
    const o = outcome(whgReport(3, [[code, 2, ['X (x)']]]));
    assert.equal(o.reasons.length, 1, code);
    assert.equal(o.reasons[0].words, `2 places: each ${WHG_PROBLEMS[code].each}.`, code);
    assert.equal(outcome(whgReport(3, [[code, 1, ['X (x)']]])).reasons[0].words, `1 place ${WHG_PROBLEMS[code].each}.`, code);
    assert.doesNotMatch(o.reasons[0].remedy, /^Nothing is made up/, code);
  }
});

test('the flat table in plain words: what it is, and how many places have no match recorded; nothing is said of a run that wrote neither', () => {
  const rep = new Report();
  rep.count('places', 6); rep.count('table rows', 6);
  rep.add('note', 'flat-summary', LOSS_TEXT['flat-summary']);
  rep.add('note', 'flat-no-match-recorded', LOSS_TEXT['flat-no-match-recorded'], undefined, 2);
  const o = outcome(asReport(rep));
  assert.equal(o.kind, 'flat'); assert.equal(o.tone, 'good');
  assert.equal(o.head, 'Your spreadsheet has one row for each of the 6 places, with its match and its location.');
  assert.equal(o.notes[0], '2 places of 6 have “no match recorded”: never looked up, skipped, or looked up with nothing found or accepted. The table cannot say which; your review can.');
  assert.match(o.notes[1], /it cannot be read back in\. Keep the PLATO JSON as the dataset itself\.$/);
  const plain = new Report(); plain.count('places', 6); plain.add('loss', 'dropped', 'Something left out');
  assert.equal(outcome(asReport(plain)), null);
  assert.equal(outcome(null), null);
});
