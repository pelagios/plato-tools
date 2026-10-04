// Map your data (docs/plans/methodos.md, section 5): a list of place names, its columns matched,
// its regions identified level by level where it gives them, looked up in a gazetteer and reviewed,
// the decisions recorded (with the region each place is in, where it gives them), the places drawn
// where wanted, checked again, compared with what came in, and written out; published if asked.
// The decisions are recorded by one of two steps, by the answer about regions: `relate` where the
// table gives them (PLATO #23, option B), `apply` where it does not.
const decided = 'relate.dataset ?? apply.dataset';
const result = `place.dataset ?? ${decided}`;
export default {
  key: 'map-your-data',
  title: 'Map your data',
  version: 2,
  files: {
    files: { words: 'The table of place names (CSV or GeoJSON)', types: ['files'] },
  },
  asks: {
    'has-regions': { question: 'Does the table say which region each place is in (a parish, a county)?', kind: 'yes-no' },
    'will-draw': { question: 'Will you draw or trace places that the gazetteer cannot locate?', kind: 'yes-no' },
    'will-publish': { question: 'Will you publish the result?', kind: 'yes-no' },
    // Asked by the interview when the table gives regions (interview.js baseAsked), pre-filled from Options and written back there.
    base: { question: 'Under what base address will your places and regions have web addresses of their own (for example https://example.org/places/)?', kind: 'text', optional: true },
    target: { question: 'In what format do you want the result?', kind: 'choice', choices: ['plato-json', 'plato-jsonl', 'tables', 'ntriples', 'lpf', 'lpf-seq'] },
    release: { question: 'What is this release called (for example 2026-10 or v1)?', kind: 'text', optional: true },
    repo: { question: 'Which GitHub repository will the site be published from (owner/name)?', kind: 'text', optional: true },
    maintainers: { question: 'Who maintains the permanent addresses on w3id.org (GitHub user names)?', kind: 'list', optional: true },
  },
  steps: [
    { id: 'columns', op: 'read.columns', title: 'Match the columns to PLATO', from: { files: '$files' } },
    { id: 'check', op: 'check', title: 'Check the table', from: { files: '$files', mapping: 'columns.mapping' } },
    { id: 'dataset', op: 'convert', title: 'Make a PLATO dataset of it', from: { files: '$files', mapping: 'columns.mapping' }, options: { target: 'plato-json', base: '$base' } },
    { id: 'regions', op: 'lookup.levels', title: 'Identify the regions, the widest first', from: { subjects: 'dataset.dataset' }, when: 'has-regions' },
    { id: 'lookup', op: 'lookup', title: 'Look the places up in the World Historical Gazetteer', from: { subjects: 'dataset.dataset', work: 'regions.work' } },
    { id: 'review', op: 'review', title: 'Decide which candidates are the same place', from: { work: 'lookup.work' } },
    { id: 'apply', op: 'apply', title: 'Record the decisions in the dataset', from: { subjects: 'dataset.dataset', work: 'review.work' }, when: '!has-regions' },
    { id: 'relate', op: 'relate.containment', title: 'Record the decisions, with the region each place is in', from: { subjects: 'dataset.dataset', work: 'review.work' }, options: { base: '$base' }, when: 'has-regions' },
    { id: 'place', op: 'place', title: 'Draw or trace the places still without a location', from: { dataset: decided }, when: 'will-draw' },
    { id: 'again', op: 'check', title: 'Check the result', from: { files: result } },
    { id: 'compare', op: 'compare', title: 'Compare the result with the dataset made from the table', from: { earlier: 'dataset.dataset', later: result } },
    { id: 'out', op: 'convert', title: 'Write it out', from: { files: result }, options: { target: '$target' } },
    { id: 'mint', op: 'publish.mint', title: 'Give every place and source a permanent address', from: { dataset: result }, options: { release: '$release' }, when: 'will-publish' },
    { id: 'report', op: 'publish.report', title: 'Write the FAIR report', from: { dataset: 'mint.dataset' }, options: { release: '$release' }, when: 'will-publish' },
    { id: 'site', op: 'publish.site', title: 'Build the web site', from: { dataset: 'mint.dataset' }, options: { release: '$release', repo: '$repo' }, when: 'will-publish' },
    { id: 'w3id', op: 'publish.w3id', title: 'Write the permanent-address rules', from: { dataset: 'mint.dataset' }, options: { repo: '$repo', maintainers: '$maintainers' }, when: 'will-publish' },
  ],
};
