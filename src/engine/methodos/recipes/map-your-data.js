// Map your data (docs/plans/methodos.md, section 5): a list of place names, its columns matched,
// its regions identified level by level where it gives them, looked up in a gazetteer and reviewed,
// the decisions recorded (with the region each place is in, where it gives them), the matched places'
// locations taken from their matches, the places still without one drawn where wanted, checked again,
// compared with what came in, seen on a map, and written out; published if asked.
// The decisions are recorded by one of two steps, by the answer about regions: `relate` where the
// table gives them (PLATO #23, option B), `apply` where it does not. Between the review and either, under
// "will-mint" (Issue #36), Wikidata items for the places no gazetteer knows: the step hands on the review's
// work file with the new Q-ids recorded, which the recording step takes in place of the review's.
import { BASE } from './asks.js';

const decided = 'relate.dataset ?? apply.dataset';
// The locations of the matched places are taken into the dataset the decisions were recorded in (`locate`, from the
// review's work file, which alone keeps the sources' licences); the places still without one are put on the map by
// hand where that was asked for (`place`); and, before it is written out, the result is seen on a map (`see`, which
// hands on the dataset as it is, or the one saved from the map there).
const located = 'locate.dataset';
const placed = `place.dataset ?? ${located}`;
const result = 'see.dataset';
export default {
  key: 'map-your-data',
  title: 'Map your data',
  // The scholar-facing workflow: its steps are named by what the scholar does, the page says each without its tool's name in
  // the headline (the tool's name small, beside it), and puts what is not the step's own behind "More options (for experts)".
  plain: true,
  version: 7,   // 7 (18 November 2026): the steps named by what the scholar does, in plain words (and `plain`: the page names no tool in the step's headline); 6 (18 November 2026): the result may be written as one flat table (table-flat) or as Linked Places Format v2 for WHG (lpf2), the two offered first; 5 (18 November 2026): the matched places' locations taken in a step of their own (locate), and the places seen on a map before they are written out (see); 4 (13 November 2026): the dataset step's standInRegions and the mint step's base, for a table with regions and no base address
  files: {
    files: { words: 'The table of place names (a spreadsheet: .xlsx or .csv)', types: ['files'] },
  },
  asks: {
    // No by default, each of them (13 November 2026): a list of names needs none, so the plan and "Follow" are shown as soon
    // as the first two questions are answered, and a Yes is one click for whoever wants it.
    'has-regions': { question: 'Does the table say which region each place is in (a parish, a county)?', kind: 'yes-no', default: false },
    'will-draw': { question: 'Some places may not be found. Do you want to place them by hand on a map afterwards?', kind: 'yes-no', default: false },
    'will-publish': { question: 'Will you publish the result?', kind: 'yes-no', default: false },
    // Issue #36: Wikidata items, under their own answer, no by default (the question is asked last).
    'will-mint': { question: 'Will you create Wikidata items for the places no gazetteer knows (a batch you run in QuickStatements yourself)?', kind: 'yes-no', default: false },
    // Asked by the interview when the table gives regions, or the result is published (interview.js baseAsked), pre-filled from Options and written back
    // there; optional in both (Stephen, 13 November 2026). Without it the dataset step mints the regions under the temporary stand-in base
    // (`standInRegions`, with the places), the relate step exports its candidates for that base, and the mint step, given the real base when
    // publishing (the base in Options then, or the host's), moves every temporary address to it; no part of publishing takes a temporary address.
    base: BASE,
    // The two a scholar asks for first, in that order (a spreadsheet back, or a file for WHG: src/engine/plain.js names them in
    // plain words), then the formats there were before them. The page lists them in this order beside Convert at the step.
    target: { question: 'In what format do you want the result?', kind: 'choice', choices: ['table-flat', 'lpf2', 'plato-json', 'plato-jsonl', 'tables', 'ntriples', 'lpf', 'lpf-seq', 'lpf2-seq'] },
    release: { question: 'What is this release called (for example 2026-10 or v1)?', kind: 'text', optional: true },
    repo: { question: 'Which GitHub repository will the site be published from (owner/name)?', kind: 'text', optional: true },
    maintainers: { question: 'Who maintains the permanent addresses on w3id.org (GitHub user names)?', kind: 'list', optional: true },
  },
  steps: [
    { id: 'columns', op: 'read.columns', title: 'Check your columns', from: { files: '$files' } },
    { id: 'check', op: 'check', title: 'Check the table', from: { files: '$files', mapping: 'columns.mapping' } },
    { id: 'dataset', op: 'convert', title: 'Prepare your places', from: { files: '$files', mapping: 'columns.mapping' }, options: { target: 'plato-json', base: '$base', standInRegions: '$has-regions' } },
    { id: 'regions', op: 'lookup.levels', title: 'Find the regions your places are in, the widest first', from: { subjects: 'dataset.dataset' }, when: 'has-regions' },
    { id: 'lookup', op: 'lookup', title: 'Find your places in WHG', from: { subjects: 'dataset.dataset', work: 'regions.work' } },
    { id: 'review', op: 'review', title: 'Decide which matches are right', from: { work: 'lookup.work' } },
    { id: 'wikidata', op: 'wikidata.items', title: 'Create Wikidata items for the places no gazetteer knows', from: { subjects: 'dataset.dataset', work: 'review.work' }, when: 'will-mint' },
    { id: 'apply', op: 'apply', title: 'Save your decisions', from: { subjects: 'dataset.dataset', work: 'wikidata.work ?? review.work' }, when: '!has-regions' },
    { id: 'relate', op: 'relate.containment', title: 'Save your decisions, with the region each place is in', from: { subjects: 'dataset.dataset', work: 'wikidata.work ?? review.work' }, options: { base: '$base' }, when: 'has-regions' },
    { id: 'locate', op: 'locate', title: 'Use the locations of the matches', from: { dataset: decided, work: 'wikidata.work ?? review.work' } },
    { id: 'place', op: 'place', title: 'Draw or trace the places still without a location', from: { dataset: located }, when: 'will-draw' },
    { id: 'again', op: 'check', title: 'Check the result', from: { files: placed } },
    { id: 'compare', op: 'compare', title: 'Compare the result with what you began with', from: { earlier: 'dataset.dataset', later: placed } },
    { id: 'see', op: 'map.view', title: 'See your places on a map', from: { dataset: placed } },
    { id: 'out', op: 'convert', title: 'Download your results', from: { files: result }, options: { target: '$target' } },
    { id: 'mint', op: 'publish.mint', title: 'Give every place and source a permanent address', from: { dataset: result }, options: { release: '$release', base: '$base' }, when: 'will-publish' },
    { id: 'report', op: 'publish.report', title: 'Write the FAIR report', from: { dataset: 'mint.dataset' }, options: { release: '$release' }, when: 'will-publish' },
    { id: 'site', op: 'publish.site', title: 'Build the web site', from: { dataset: 'mint.dataset' }, options: { release: '$release', repo: '$repo' }, when: 'will-publish' },
    { id: 'w3id', op: 'publish.w3id', title: 'Write the permanent-address rules', from: { dataset: 'mint.dataset' }, options: { repo: '$repo', maintainers: '$maintainers' }, when: 'will-publish' },
  ],
};
