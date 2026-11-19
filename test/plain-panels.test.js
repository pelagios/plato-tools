// The plain-language layer of the panels a scholar-facing workflow opens (src/engine/plain-panels.js): the review of
// regions, the Wikidata items, the gazetteer search on the map, the list of suggestions at the review's end, and the
// publishing reports that named a command-line flag on the page. In the manner of test/plain-names.test.js: each plain
// word is held to say no expert's, and the tools' own, which it stands in for, is shown to say one (the control).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setPlain, plainOn, laidOver, wordsOf, PLAIN_REGION, REGION_SAID, PLAIN_WIKIDATA, WIKIDATA_SAID, PLAIN_ADOPT, ADOPT_SAID, CARD_SAID,
  PLAIN_SUGGESTIONS, plainUnexported, plainBareRegions, PLAIN_NO_REGIONS, plainExported, PAGE_REPORT, PLAIN_SUGGESTIONS_REPORT } from '../src/engine/plain-panels.js';
import { REGION_PAGE, WIKIDATA_WORDS, CHORA_ADOPT_PAGE, summary } from '../src/engine/words.js';
import { PLAIN_REPORT, PLAIN_FINISH } from '../src/engine/plain.js';
import { TEXT as W3ID_TEXT } from '../src/engine/agora/w3id.js';
import { unexported, relateProblem } from '../src/engine/methodos/containment.js';
import { constraintLine } from '../src/krisis/region-page.js';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const GREEK = /Methodos|Hermes|Elenchos|Metaphrasis|Arithmos|Krisis|Chora|Agora|Mneme/;
// What a scholar is not to be shown: the engine's nouns, the model's property names, and the command line's flags.
const EXPERT = /attestation|candidate|promotedFrom|identit(y|ies)\b|@id|\bIRI|--[a-z]|Q-id|constraint|contained_in|\bunion\b|quer(y|ies)|close match|exact match|\bminted\b|base address|\bFinish\b/;
// Every string a group of words can say, its functions called with something of each shape they take.
const ARGS = [3, { looked: true, kinds: ['contained_in', 'countries'], name: 'Suffolk', ids: ['gn:2636561'], countries: ['GB'], relaxed: 'countries', from: 'k', lang: 'la', labels: ['Lancashire'], pairs: [1, 2], extraQids: 1, rowsLeft: 1, queries: 3, requests: 1 }];
function said(words) {
  const out = [];
  for (const v of Object.values(words)) {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) out.push(...v);
    else if (typeof v === 'function') { for (const a of ARGS) { try { const s = v(a, 2, 'Suffolk'); if (typeof s === 'string') out.push(s); } catch { /* not its shape */ } } }
    else if (v && typeof v === 'object') out.push(...said(v));
  }
  return out;
}
const plainly = (fn) => { setPlain(true); try { return fn(); } finally { setPlain(false); } };
test.after(() => setPlain(null));

test('the words of a panel follow the page: the tools\' own outside a scholar-facing workflow, the plain ones within, a word not listed the tools\' own either way', () => {
  setPlain(false);
  assert.equal(plainOn(), false);
  assert.equal(REGION_SAID.relax.all, 'With no constraint');
  assert.equal(REGION_SAID.heading, REGION_PAGE.heading);
  setPlain(true);
  assert.equal(REGION_SAID.relax.all, 'Everywhere');
  assert.equal(REGION_SAID.relax.countries, REGION_PAGE.relax.countries, 'a group is laid over key by key');
  assert.equal(REGION_SAID.heading, REGION_PAGE.heading);
  assert.equal(REGION_SAID.buttons, REGION_PAGE.buttons);
  setPlain(false);
  assert.equal(REGION_SAID.relax.all, 'With no constraint');
  assert.deepEqual(laidOver({ a: 1, g: { x: 1, y: 2 }, list: [1] }, { g: { y: 3 }, list: [2] }), { a: 1, g: { x: 1, y: 3 }, list: [2] });
  const w = wordsOf({ a: 'own', b: 'kept' }, { a: 'plain' });
  assert.deepEqual([w.a, w.b, plainly(() => w.a), plainly(() => w.b)], ['own', 'kept', 'plain', 'kept']);
  // With nobody saying (null), it is the page's <body data-plain> that says; in Node there is no page, so the tools' own.
  setPlain(null);
  assert.equal(plainOn(), false);
  setPlain(false);
});

test('every plain word names a word the panel has, and none says an expert\'s; the tools\' own, which they stand in for, do', () => {
  for (const [name, plain, own] of [['regions', PLAIN_REGION, REGION_PAGE], ['Wikidata', PLAIN_WIKIDATA, WIKIDATA_WORDS]]) {
    for (const k of Object.keys(plain)) {
      assert.ok(Object.hasOwn(own, k), `${name}: ${k} is no word of the panel`);
      assert.equal(typeof plain[k], typeof own[k], `${name}: ${k}`);
      if (typeof plain[k] === 'object' && !Array.isArray(plain[k])) for (const kk of Object.keys(plain[k])) assert.ok(Object.hasOwn(own[k], kk), `${name}: ${k}.${kk} is no word of the panel`);
    }
    const strings = said(plain);
    assert.ok(strings.length >= 12, `${name}: ${strings.length} strings examined`);
    for (const s of strings) { assert.doesNotMatch(s, EXPERT, `${name}: ${s}`); assert.doesNotMatch(s, GREEK, `${name}: ${s}`); }
    // The control: the same search finds an expert's word in the tools' own, in the words the plain ones replace.
    assert.ok(said(Object.fromEntries(Object.keys(plain).map((k) => [k, own[k]]))).some((s) => EXPERT.test(s) || GREEK.test(s)), `${name}: the tools' own say no expert's word, so the test proves nothing`);
  }
  // The map's words are plain in themselves, in a workflow or not (test/chora-plain.test.js): only what a search sends is laid over them.
  assert.deepEqual(Object.keys(PLAIN_ADOPT), ['sends', 'where']);
  for (const k of Object.keys(PLAIN_ADOPT)) assert.equal(typeof CHORA_ADOPT_PAGE[k], 'function', k);
  for (const s of said(CARD_SAID)) assert.doesNotMatch(s, EXPERT, s);
  assert.equal(said(CARD_SAID).length, 4);
  assert.match(CARD_SAID.draw, /added to what is recorded of this place/);
  assert.equal(plainly(() => CARD_SAID.draw), CARD_SAID.draw);
});

test('the review of regions in plain words: what a region is looked up within, without the gazetteer\'s ids; the buttons say what they would send as searches', () => {
  const c = { looked: true, kinds: ['contained_in', 'countries'], name: 'Suffolk', ids: ['gn:2636561'], countries: ['GB'], relaxed: null, from: 'k' };
  assert.equal(REGION_PAGE.constraint(c), 'Looked up within Suffolk (gn:2636561) and in GB.');
  assert.equal(PLAIN_REGION.constraint(c), 'Looked up inside Suffolk and in GB.');
  assert.equal(PLAIN_REGION.constraint({ looked: false, kinds: [], from: null }), 'To be looked up everywhere (no region above it is matched).');
  assert.equal(REGION_PAGE.constraint({ looked: false, kinds: [], from: null }), 'To be looked up with no constraint (no region above it is matched).');
  assert.equal(PLAIN_REGION.constraint({ looked: true, kinds: ['area'], name: 'Kent', radius: 1200, relaxed: 'contained-in', from: 'k' }), 'Looked up in the area around Kent (about 1,200 km across). Widened: in the area around the region, not the gazetteer’s own outline of it.');
  assert.equal(PLAIN_REGION.constraint({ looked: true, kinds: [], unconstrained: true }), 'Looked up everywhere, before the regions were settled.');
  assert.equal(PLAIN_REGION.constraint({ looked: false, kinds: [], name: 'Kent', noArea: 'point-only', from: 'k' }), 'To be looked up everywhere (Kent cannot be looked inside: the gazetteer gives only a point for its match, not an outline).');
  assert.equal(PLAIN_REGION.cost('Look up this region', { queries: 3, requests: 1 }, 2), 'Look up this region (3 searches)');
  assert.equal(REGION_PAGE.cost('Look up this region', { queries: 3, requests: 1 }, 2), 'Look up this region (3 queries in 1 request, and 2 records fetched for an area)');
  assert.equal(PLAIN_REGION.candidates(0), 'WHG suggested nothing.');
  assert.equal(PLAIN_REGION.candidates(2), '2 suggestions from WHG:');
  assert.deepEqual(PLAIN_REGION.identity, { closeMatch: 'much the same region', exactMatch: 'the same region' });
  // The page's own module (region-page.js) says a region's line in the words of the page as it is.
  const work = { regions: { k: { label: 'Suffolk', names: ['Suffolk'], level: 1, within: null, outcome: null } }, places: {}, candidates: [], lookups: [] };
  const own = constraintLine(work, 'k');
  assert.match(own, /with no constraint/);
  assert.match(plainly(() => constraintLine(work, 'k')), /^To be looked up everywhere/);
});

test('the Wikidata panel in plain words: an item\'s number, not a Q-id; a match, not an identity; the button that saves, by its name', () => {
  assert.match(WIKIDATA_WORDS.intro, /Q-ids are checked against the batch and recorded here as identities, which Finish writes/);
  assert.match(PLAIN_WIKIDATA.intro, /you bring their numbers \(each begins with Q\) back here: each is checked, and recorded as a match, which “Save your decisions” writes into your data\.$/);
  assert.match(PLAIN_WIKIDATA.intro, /these tools never write to Wikidata/);
  assert.equal(PLAIN_WIKIDATA.record(1), 'Record 1 match');
  assert.equal(PLAIN_WIKIDATA.record(3), 'Record 3 matches');
  assert.equal(WIKIDATA_WORDS.record(3), 'Record 3 identities');
  assert.equal(PLAIN_WIKIDATA.recorded(2), `2 matches recorded in the review: “${PLAIN_FINISH.button}” writes them into your data. Save the review as well.`);
  assert.equal(PLAIN_WIKIDATA.howTo.length, WIKIDATA_WORDS.howTo.length);
  assert.deepEqual(PLAIN_WIKIDATA.howTo.slice(0, 3), WIKIDATA_WORDS.howTo.slice(0, 3));
  // Why places are left out: the plain reasons where there are any, the tools' own for the rest, in one line.
  const left = { matched: ['a'], noName: ['b', 'c'], undecided: [] };
  assert.equal(PLAIN_WIKIDATA.leftOutLine(left), '1 place matched to a record already; 2 places with no name');
  assert.equal(WIKIDATA_WORDS.leftOutLine(left), '1 place matched to a record (not minted); 2 places with no name');
  assert.equal(plainly(() => WIKIDATA_SAID.leftOut.noName), WIKIDATA_WORDS.leftOut.noName);
  assert.equal(plainly(() => WIKIDATA_SAID.statements.description), WIKIDATA_WORDS.statements.description);
  assert.match(PLAIN_WIKIDATA.statements.p31, /^The kind of place \(Wikidata’s “instance of”, P31\)$/);
});

test('the gazetteer search on the map in plain words: no tool\'s name, and what is sent without the gazetteer\'s ids', () => {
  const scope = { lang: 'la', labels: ['Lancashire'], ids: ['gn:2644974'], countries: ['GB'] };
  assert.equal(CHORA_ADOPT_PAGE.sends(scope), 'Sent: the name, with the type Place, its language (la), looked for only within Lancashire (WHG gn:2644974), in GB.');
  assert.equal(PLAIN_ADOPT.sends(scope), 'Sent to the gazetteer: the name, and its language (la); looked for only inside Lancashire, in GB.');
  assert.equal(PLAIN_ADOPT.sends({}), 'Sent to the gazetteer: the name; looked for everywhere.');
  assert.equal(ADOPT_SAID.sends(scope), CHORA_ADOPT_PAGE.sends(scope));
  assert.equal(plainly(() => ADOPT_SAID.sends(scope)), PLAIN_ADOPT.sends(scope));
  // The rest is the panel's own, the same in a workflow and outside one, and plain.
  assert.match(CHORA_ADOPT_PAGE.denied, /review the matches again, under “Find in gazetteers”/);
  assert.equal(plainly(() => ADOPT_SAID.denied), CHORA_ADOPT_PAGE.denied);
  assert.equal(CHORA_ADOPT_PAGE.adopted(2), 'Taken: the match and the location are waiting to be saved.');
  assert.equal(CHORA_ADOPT_PAGE.adopted(1), 'Taken: the location is waiting to be saved.');
  assert.equal(plainly(() => ADOPT_SAID.find), CHORA_ADOPT_PAGE.find);
});

test('the list of suggestions at the review\'s end: the page marks its three parts, each has plain words, and the refusal at the step that saves the regions names the button as it is named there', () => {
  const marked = Object.fromEntries([...HTML.matchAll(/data-plain-words="([a-z-]+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]]));
  for (const k of Object.keys(PLAIN_SUGGESTIONS)) { assert.ok(marked[k], `${k} is not marked on the page`); assert.doesNotMatch(PLAIN_SUGGESTIONS[k], EXPERT, k); assert.equal(PLAIN_FINISH[k], undefined, k); }
  assert.equal(marked.export, 'Export the suggestions as a candidate set');   // the tools' own, kept outside the workflow
  assert.equal(PLAIN_SUGGESTIONS.export, 'Save the list of suggestions');
  const work = { regions: { 'https://example.org/r/1': {} }, candidates: [{ decision: { kind: 'match' } }, { decision: { kind: 'distinct' } }, { decision: { kind: 'not-this' } }, { decision: { kind: 'match' }, iri: 'https://example.org/c/1' }, {}] };
  assert.equal(unexported(work), '2 decisions do not name the candidate they answer yet: export the suggestions first ("Export the suggestions as a candidate set", under the review), so that each identity records it (promotedFrom).');
  assert.equal(unexported(work, { plain: true }), '2 of your decisions do not yet say which suggestion they answer: press “Save the list of suggestions”, under the review, first, and then “Save your decisions” again.');
  assert.equal(relateProblem(work, { plain: true }), unexported(work, { plain: true }));
  assert.equal(plainUnexported(1), '1 of your decisions does not yet say which suggestion it answers: press “Save the list of suggestions”, under the review, first, and then “Save your decisions” again.');
  assert.equal(plainUnexported(0), null);
  for (const c of work.candidates) if (c.decision) c.iri = 'https://example.org/c/x';
  assert.equal(unexported(work, { plain: true }), null);
  assert.equal(relateProblem({ regions: {}, candidates: [] }, { plain: true }), PLAIN_NO_REGIONS);
  assert.match(relateProblem({ regions: {}, candidates: [] }), /identify the regions first/);
  const bare = { regions: { 'England > Kent': {}, 'https://example.org/r/1': {} }, candidates: [] };
  assert.match(relateProblem(bare), /converted without a base address/);
  assert.equal(relateProblem(bare, { plain: true }), plainBareRegions(1, 2));
  assert.match(plainBareRegions(1, 2), /^1 of the 2 regions has no web address of its own yet, .*“Web address for your identifiers”/);
  for (const s of [PLAIN_NO_REGIONS, plainBareRegions(2, 3), plainUnexported(2)]) assert.doesNotMatch(s, EXPERT, s);
  // What saving the list came to.
  assert.equal(plainExported({ candidates: 5, leftOut: 1 }), 'The list of suggestions was saved: it holds 5 suggestions. 1 suggestion was already in a list saved before, and is left out of this one. Save the review as well (“Save the review”): it now records which list each suggestion is in.');
  assert.equal(plainExported({ candidates: 0, leftOut: 2 }), 'No list was written: every suggestion was already in a list saved before. 2 suggestions were already in a list saved before, and are left out of this one.');
  assert.equal(plainExported({}), 'The list of suggestions could not be made.');
  for (const c of [{ candidates: 5, leftOut: 1 }, { candidates: 0, leftOut: 2 }, {}]) assert.doesNotMatch(plainExported(c), EXPERT);
  assert.match(summary({ counts: { candidates: 5 }, errors: 0 }, 'candidates').problems, /exported as a candidate set/);   // what it stands in for
});

test('a report\'s items that named the command line are said for the page: the w3id refusals name the page\'s own fields, each of which is there', () => {
  for (const [kind, words] of Object.entries(PAGE_REPORT)) {
    assert.ok(W3ID_TEXT[kind], `${kind} is no item of the w3id report`);
    assert.match(W3ID_TEXT[kind], /--[a-z]/, `${kind}: the tools' own words name no flag, so need no others on the page`);
    assert.doesNotMatch(words, /--[a-z]|attestation|@id|base address/, kind);
    // Every field a sentence names in quotation marks is a label on the page.
    for (const [, label] of words.matchAll(/“([^”]+)”/g)) assert.ok(HTML.includes(`>${label}</label>`), `${kind}: no field “${label}” on the page`);
  }
  // Every w3id refusal that names a flag has its words for the page (a new one must be given them).
  assert.deepEqual(Object.keys(W3ID_TEXT).filter((k) => /--[a-z]/.test(W3ID_TEXT[k])).sort(), Object.keys(PAGE_REPORT).sort());
  assert.match(PAGE_REPORT['not-w3id'], /https:\/\/w3id\.org\/your-name\//);
  // In a scholar-facing workflow: what saving the decisions says of the list of suggestions; neither kind is said twice.
  for (const [kind, words] of Object.entries(PLAIN_SUGGESTIONS_REPORT)) { assert.doesNotMatch(words, EXPERT, kind); assert.equal(PLAIN_REPORT[kind], undefined, kind); assert.equal(PAGE_REPORT[kind], undefined, kind); }
  assert.deepEqual(Object.keys(PLAIN_SUGGESTIONS_REPORT), ['answers-not-exported', 'publish-candidate-sets']);
  assert.match(PLAIN_SUGGESTIONS_REPORT['answers-not-exported'], /press “Save the list of suggestions” again/);
});
