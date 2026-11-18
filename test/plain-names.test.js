// The plain-language layer, its names (src/engine/plain.js; Stephen, 18 November 2026): the tools by plain names, the
// steps of Map your data named by what the scholar does, and the page's own markup holding the two together.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLAIN_TOOLS, toolTip, PLAIN_REPORT, decisionsSummary, DECISION_HINT, SAME_PLACE_LABEL, COUNTRY_HINT, EXPERT_SUMMARY,
  PLAIN_WAITS, PLAIN_MAP, PLAIN_PARTS, PLAIN_PUBLISH, plainPart, publishNext, PLAIN_FINISH, PRESS_SAVE, plainCites, PLAIN_RECORDED, FINISH_EXPERT_NOTE, LOOKUP_EXPERT_NOTE } from '../src/engine/plain.js';
import { lookupPage } from '../src/engine/words.js';
import { OPERATIONS } from '../src/engine/methodos/operations.js';
import { RECIPES } from '../src/engine/methodos/recipes/index.js';
import { plan } from '../src/engine/methodos/interview.js';
import { whereWords, resultLabel } from '../src/methodos/layout.js';
import { typeWord } from '../src/engine/krisis/kinds.js';
import { summary } from '../src/engine/words.js';
import MAP from '../src/engine/methodos/recipes/map-your-data.js';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const GREEK = /Methodos|Hermes|Elenchos|Metaphrasis|Arithmos|Krisis|Chora|Agora|Mneme/;

test('every tool a step can name has a plain name, and its own name\'s title says what it is', () => {
  assert.deepEqual(PLAIN_TOOLS, { Methodos: 'Guided steps', Hermes: 'Read my table', Elenchos: 'Check', Metaphrasis: 'Convert', Arithmos: 'Count and compare',
    Krisis: 'Find in gazetteers', Chora: 'Map', Agora: 'Publish', Mneme: 'Compare versions' });
  const tools = new Set(Object.values(OPERATIONS).map((o) => o.tool).filter(Boolean));
  assert.ok(tools.size >= 7);
  for (const t of tools) assert.ok(PLAIN_TOOLS[t], `${t} has no plain name`);
  assert.equal(toolTip('Krisis'), 'Krisis: the tool that does this');
});

test('the list of tools on the page: each card is named in plain words first, its own name small beside it with a tooltip that says what it is', () => {
  for (const [greek, plain] of Object.entries(PLAIN_TOOLS)) {
    const card = new RegExp(`<span class="plain-name">${plain}</span></h4><p class="label"><span class="why greek-name" data-tip="${greek}: the tool that does this\\. [^"]+">${greek}</span></p>`);
    assert.ok(card.test(HTML), `${greek}: its card is not named “${plain}” first`);
  }
  // No card is headed by a tool's own name any more (the control: the cards are there, nine of them, each with its plain name).
  assert.equal((HTML.match(/<span class="plain-name">/g) || []).length, 9);
  // Only the tool still planned (Peripleo, no card to choose) is headed by its own name.
  const headed = [...HTML.matchAll(/<\/svg><span class="why" data-tip="[^"]*">([A-Za-z]+)<\/span><\/h4>/g)].map((m) => m[1]);
  assert.deepEqual(headed, ['Peripleo']);
  assert.ok(HTML.includes(`<label for="identity-type">${SAME_PLACE_LABEL}</label>`));
  assert.ok(!HTML.includes('Same place means'));
});

test('Map your data is the scholar-facing workflow: its steps are named by what the scholar does, none by a tool\'s name', () => {
  assert.equal(MAP.plain, true);
  assert.equal(MAP.version, 7);
  for (const r of Object.values(RECIPES)) if (r.key !== 'map-your-data') assert.equal(r.plain, undefined, r.key);
  const titles = Object.fromEntries(MAP.steps.map((s) => [s.id, s.title]));
  assert.deepEqual(titles, {
    columns: 'Check your columns', check: 'Check the table', dataset: 'Prepare your places', regions: 'Find the regions your places are in, the widest first',
    lookup: 'Find your places in WHG', review: 'Decide which matches are right', wikidata: 'Create Wikidata items for the places no gazetteer knows',
    apply: 'Save your decisions', relate: 'Save your decisions, with the region each place is in', locate: 'Use the locations of the matches',
    place: 'Draw or trace the places still without a location', again: 'Check the result', compare: 'Compare the result with what you began with',
    see: 'See your places on a map', out: 'Download your results',
    mint: 'Give every place and source a permanent address', report: 'Write the FAIR report', site: 'Build the web site', w3id: 'Write the permanent-address rules',
  });
  for (const t of Object.values(titles)) { assert.doesNotMatch(t, GREEK, t); assert.doesNotMatch(t, /PLATO|attestation|candidate/i, t); }
});

test('the step\'s headline in plain words has no tool\'s name; another workflow\'s keeps it', () => {
  const p = plan('map-your-data', { 'has-regions': false, 'will-draw': false, 'will-publish': false, 'will-mint': false, target: 'table-flat' });
  const steps = p.steps.filter((s) => s.available === true);
  assert.equal(steps.length, 11);
  const heads = steps.map((s, i) => whereWords(i, steps.length, s.tool, s.title, true));
  assert.deepEqual(heads, ['Step 1 of 11: Check your columns', 'Step 2 of 11: Check the table', 'Step 3 of 11: Prepare your places', 'Step 4 of 11: Find your places in WHG',
    'Step 5 of 11: Decide which matches are right', 'Step 6 of 11: Save your decisions', 'Step 7 of 11: Use the locations of the matches', 'Step 8 of 11: Check the result',
    'Step 9 of 11: Compare the result with what you began with', 'Step 10 of 11: See your places on a map', 'Step 11 of 11: Download your results']);
  for (const h of heads) assert.doesNotMatch(h, GREEK, h);
  // Each step still has its tool, for the small label beside it.
  assert.deepEqual(steps.map((s) => s.tool), ['Hermes', 'Elenchos', 'Metaphrasis', 'Krisis', 'Krisis', 'Krisis', 'Chora', 'Elenchos', 'Mneme', 'Chora', 'Metaphrasis']);
  // The control: with its tool, as every other workflow says a step.
  assert.equal(whereWords(1, 10, 'Elenchos', 'Check the edition'), 'Step 2 of 10: Elenchos, check the edition');
  assert.equal(resultLabel('Step 3 of 11: Prepare your places'), 'Result of step 3: Prepare your places');
});

test('recording the decisions, in plain words: "Recorded 7 decisions: 8 matches accepted, 0 places said to be different", and no "attestation"', () => {
  const counts = { attestations: 7, matchAttestations: 7, relations: 8, distinctAttestations: 0, places: 6, versionCheck: { earlier: 6, later: 13, added: 7, changed: 0, lost: 0 } };
  const s = decisionsSummary({ counts, errors: 0 });
  assert.equal(s.problems, 'Your decisions were saved with your places.');
  assert.equal(s.counted, 'Recorded 7 decisions: 8 matches accepted, 0 places said to be different. Your 6 places had 6 statements about them, and now have 13, with 7 added; nothing that was there before was deleted or changed.');
  assert.doesNotMatch(`${s.problems} ${s.counted}`, /attestation/i);
  // The control: the tools' own summary of the same run, which the plain one stands in for, says it in the engine's words.
  assert.match(summary({ counts, errors: 0 }, 'apply').counted, /^Made 7 new attestations: 7 accepting 8 matches, 0 saying that two places are different\./);
  const one = decisionsSummary({ counts: { attestations: 1, matchAttestations: 0, relations: 1, distinctAttestations: 1 }, errors: 0 });
  assert.deepEqual(one, { problems: 'Your decisions were saved.', counted: 'Recorded 1 decision: 0 matches accepted, 1 place said to be different.' });
  assert.equal(decisionsSummary({ counts: { attestations: 0, relations: 0, distinctAttestations: 0 }, errors: 0 }).problems, 'Nothing to save.');
  assert.equal(decisionsSummary({ counts: { attestations: 2, relations: 2, distinctAttestations: 0 }, errors: 1 }).problems, '1 problem found.');
  assert.equal(decisionsSummary({ counts: { places: 3 }, errors: 0 }), null, 'not a Finish: no summary of decisions');
  const lost = decisionsSummary({ counts: { ...counts, versionCheck: { earlier: 6, later: 12, added: 7, changed: 1, lost: 2 } }, errors: 3 });
  assert.match(lost.counted, /the check of what was there before found 1 statement changed and 2 statements no longer there\.$/);
});

test('a type\'s code is said in words where the data names it, and is only a code where it does not', () => {
  assert.equal(typeWord('wikidata:Q515'), 'city');
  assert.equal(typeWord('osm:isolated_dwelling'), 'isolated dwelling');
  assert.equal(typeWord('kain_par:parish'), 'parish');
  assert.equal(typeWord('whg:Village'), 'village');
  for (const code of ['aat:300000774', 'gn:P.PPL', 'wikidata:Q99999999', 'osm:12345', 'Place', '', null]) assert.equal(typeWord(code), null, String(code));
});

test('the plain sentences say what they stand for, in no expert\'s word', () => {
  assert.match(PLAIN_REPORT['attestations-unaddressed'], /^These decisions have no web address of their own yet/);
  assert.doesNotMatch(PLAIN_REPORT['attestations-unaddressed'], /@id|uriSpace|attestation/);
  for (const k of ['generic-stand-in-base', 'stand-in-written', 'whg-temporary-ids']) {
    assert.match(PLAIN_REPORT[k], /^Your places have working ids for now/, k);
    assert.doesNotMatch(PLAIN_REPORT[k], /--base|@id|stand-in|attestation/, k);
  }
  assert.match(PLAIN_REPORT['stand-in-written'], /Permanent web addresses are only needed if you publish/);
  assert.match(DECISION_HINT, /“Not this one” sets this suggestion aside and writes nothing to your data\. “Different places” records, with your reason, that the two are known to be different places\./);
  assert.match(COUNTRY_HINT, /^Also a hint when your places are looked up in a gazetteer: candidates in this country are listed first, and none is left out\.$/);
  assert.equal(EXPERT_SUMMARY, 'More options (for experts)');
  // The fold is on the page, closed and empty until a scholar-facing workflow fills it.
  assert.ok(HTML.includes('<details id="expert" class="expert" hidden><summary></summary><p class="expert-note"></p><div id="expert-body"></div></details>'));
});

// ---- The optional steps, the publishing steps, the end of the review and the lookup's fold (18 November 2026)
const EXPERT_WORD = /attestation|candidate set|PLATO JSON|--base|@id|Q-id/i;
const strings = (o) => Object.values(o).map((v) => (typeof v === 'function' ? v('abbeys.json', 'Draw or trace the places still without a location') : v));
const PAGE = readFileSync(new URL('../src/methodos/page.js', import.meta.url), 'utf8');

test('the optional steps wait in plain words: the regions, the Wikidata items and the places drawn by hand name no tool, and every step of Map your data that waits for the scholar has its words', () => {
  const waits = MAP.steps.map((s) => s.op).filter((op) => OPERATIONS[op].kind === 'interactive' && OPERATIONS[op].waitsFor);
  assert.deepEqual([...new Set(waits)].sort(), ['lookup.levels', 'map.view', 'place', 'read.columns', 'review', 'wikidata.items']);
  // (The columns and the map seen are said by the tools' own words, which name no tool: the control of the pattern below.)
  for (const op of ['read.columns', 'map.view']) assert.doesNotMatch(OPERATIONS[op].waitsFor, GREEK, op);
  for (const op of ['lookup.levels', 'place', 'review', 'wikidata.items']) {
    assert.ok(PLAIN_WAITS[op], `${op} has no plain words`);
    assert.match(PLAIN_WAITS[op], /^you to /, op);
    assert.doesNotMatch(PLAIN_WAITS[op], GREEK, op); assert.doesNotMatch(PLAIN_WAITS[op], EXPERT_WORD, op);
  }
  // The tools' own words for the step on the map do name it (what the plain ones stand in for).
  assert.match(OPERATIONS.place.waitsFor, /in Chora/);
  assert.match(PLAIN_WAITS['lookup.levels'], /press “Review the regions level by level” below/);
  assert.match(PLAIN_WAITS['wikidata.items'], /in the panel “Wikidata items” below the review/);
});

test('the step on the map in plain words: "Open the map", and what is said there names the map, never Chora; another workflow keeps "Open Chora"', () => {
  assert.equal(PLAIN_MAP.open, 'Open the map');
  assert.deepEqual(Object.keys(PLAIN_MAP), ['open', 'chooseSaved', 'unchanged', 'notFromIt', 'saved', 'nothingDrawn', 'takenUp', 'handback']);
  for (const s of strings(PLAIN_MAP)) { assert.doesNotMatch(s, GREEK, s); assert.doesNotMatch(s, EXPERT_WORD, s); assert.match(s, /\bmap\b/, s); }
  assert.equal(PLAIN_MAP.unchanged('abbeys.json'), 'abbeys.json is the file that went to the map, as it was: nothing drawn there is in it. Save on the map once you have drawn, or choose the file you saved there in “Choose your data”; or, if there was nothing to draw, say so (“Nothing to draw: go on with this dataset”).');
  assert.equal(PLAIN_MAP.saved('a.json', 'Draw'), 'a.json, saved on the map: the step “Draw” is done with it.');
  assert.equal(PLAIN_MAP.takenUp(' a.json is chosen again in “Choose your data”.'), 'This step is done on the map. a.json is chosen again in “Choose your data”. Open the map to draw: saving there does this step, with the file it writes. Or choose a file you saved from the map before, and say the step is done.');
  // The button the message names is the page's own.
  assert.ok(PAGE.includes("textContent: 'Nothing to draw: go on with this dataset'"));
  // The control: the tools' own words are still there for every other workflow, chosen by the recipe's `plain`.
  assert.ok(PAGE.includes("const mapWords = (op, plain = false) => (op === VIEW ? 'See your places on the map' : plain ? PLAIN_MAP.open : 'Open Chora');"));
  for (const own of ['is the dataset that went to Chora, as it was', 'saved in Chora: the step', 'Nothing drawn in Chora', "At Chora's step:"]) assert.ok(PAGE.includes(own), own);
});

test('the publishing steps in plain words: the list beside Prepare is named entry by entry, and each step says which to choose and what it does', () => {
  const options = [...HTML.matchAll(/<option value="(\w+)">([^<]+)<\/option>/g)].filter((m) => ['report', 'mint', 'site', 'w3id'].includes(m[1])).map((m) => [m[1], m[2]]);
  assert.deepEqual(options.map((o) => o[0]), Object.keys(PLAIN_PARTS));
  // The page's own words for the list are the tools' (kept outside the workflow), and one of them is an expert's.
  assert.ok(options.some((o) => /attestation/.test(o[1])));
  const ops = Object.keys(OPERATIONS).filter((k) => k.startsWith('publish.'));
  assert.deepEqual(ops.sort(), Object.keys(PLAIN_PUBLISH).sort());
  for (const op of ops) {
    assert.ok(MAP.steps.some((s) => s.op === op && s.when === 'will-publish'), op);
    assert.equal(plainPart(op), PLAIN_PARTS[op.slice('publish.'.length)]);
    assert.equal(publishNext(op), `In the list below, choose “${plainPart(op)}”, then press Prepare. ${PLAIN_PUBLISH[op]}`);
    assert.doesNotMatch(publishNext(op), GREEK, op); assert.doesNotMatch(publishNext(op), EXPERT_WORD, op);
  }
  assert.equal(PLAIN_PARTS.mint, 'Give every place and source a permanent web address');
  assert.match(PLAIN_PUBLISH['publish.report'], /\(the FAIR report\)/);   // the step's title names it; the sentence says what it is
});

test('the end of the review in plain words: every part marked on the page has its words, none an expert\'s, and the page keeps the tools\' own for use outside the workflow', () => {
  const marked = [...HTML.matchAll(/data-plain-words="([a-z-]+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(marked.map((m) => m[0]), ['legend', 'dataset', 'attestations', 'draft-legend', 'withdraw', 'replace', 'draft-note', 'button']);
  assert.deepEqual(Object.keys(PLAIN_FINISH), marked.map((m) => m[0]));
  for (const [k, v] of Object.entries(PLAIN_FINISH)) { assert.doesNotMatch(v, GREEK, k); assert.doesNotMatch(v, /attestation|candidate|version check|Finish/i, k); }
  // The control: the page's own words, which the plain ones stand in for, do say them.
  const own = Object.fromEntries(marked);
  assert.equal(own.attestations, 'A PLATO file of only the new attestations');
  assert.equal(own.legend, 'Finish: what to make of your decisions'); assert.equal(own.button, 'Finish');
  assert.match(own.dataset, /new attestations added, as a PLATO JSON document, checked with the version check$/);
  assert.equal(PLAIN_FINISH.button, 'Save your decisions');
  assert.equal(PLAIN_FINISH.button, MAP.steps.find((s) => s.id === 'apply').title);
  assert.equal(PRESS_SAVE, '“Save your decisions”, below the review');
  // The two choices stay as radio buttons of the same two values; the changed decision's two ways too.
  for (const [name, value] of [['review-output', 'dataset'], ['review-output', 'attestations'], ['draft-answers', 'withdraw'], ['draft-answers', 'replace']]) assert.ok(new RegExp(`name="${name}" value="${value}"`).test(HTML), `${name}=${value}`);
  const sources = [{ title: 'World Historical Gazetteer', '@id': 'https://whgazetteer.org/' }, { title: 'Another' }];
  assert.equal(plainCites(sources), 'Each decision is saved with its source: World Historical Gazetteer (https://whgazetteer.org/); Another.');
  assert.equal(plainCites([]), 'Nothing is decided yet, so there is nothing to save.');
  assert.match(lookupPage.cites(sources), /^Finishing makes one attestation for each source/);   // what it stands in for
  assert.doesNotMatch(`${plainCites(sources)} ${PLAIN_RECORDED} ${FINISH_EXPERT_NOTE}`, /attestation|Finish/i);
});

test('the folds within the lookup and the review\'s end are on the page, closed and hidden until a scholar-facing workflow fills them; the lookup\'s expert choices are together, after "Which places"', () => {
  assert.ok(HTML.includes('<details id="lookup-expert" class="expert lookup-expert" hidden><summary></summary><p class="expert-note"></p><div id="lookup-expert-body"></div><div id="lookup-expert-sent"></div></details>'));
  assert.ok(HTML.includes('<details id="finish-expert" class="expert finish-expert" hidden><summary></summary><p class="expert-note"></p><div id="finish-expert-body"></div></details>'));
  const at = (s) => { const i = HTML.indexOf(s); assert.ok(i > 0, s); return i; };
  const begin = at('<div id="lookup-advanced">'), end = at('<div id="lookup-scope"');
  const block = HTML.slice(begin, end);
  for (const id of ['lookup-all-names', 'lookup-variants', 'lookup-lang', 'lookup-countries', 'lookup-near', 'lookup-near-km', 'lookup-disagree-km']) assert.ok(block.includes(`id="${id}"`), id);
  // What a scholar is left with is outside the block: the token, which places, the preview and the button.
  for (const id of ['whg-token', 'lookup-places', 'lookup-preview', 'lookup-send']) { assert.ok(HTML.includes(`id="${id}"`), id); assert.ok(!block.includes(`id="${id}"`), id); }
  assert.ok(at('id="lookup-places"') < at('id="lookup-expert"') && at('id="lookup-expert"') < begin && end < at('id="lookup-preview"') && at('id="lookup-preview"') < at('id="lookup-send"'));
  assert.match(LOOKUP_EXPERT_NOTE, /filters, and the first queries exactly as they would be sent/);
});
