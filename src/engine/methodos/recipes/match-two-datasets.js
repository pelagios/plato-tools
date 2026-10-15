// Match two datasets (docs/plans/methodos.md, section 6; Stephen's decisions of 14 October 2026): the
// places of the user's own dataset matched with the places of another dataset, by Krisis's local match, and
// the decisions recorded. Your dataset, the one the decisions are about, is a table read as Map your data
// reads it (its columns matched, checked, made a PLATO dataset under the base address), or, already in a
// PLATO format, checked and taken as it is: which, the route says (`from-table`, an answer the interview
// sets, never asks, from what the user has). The other dataset goes
// to the match as it is, in any format the tools read, chosen at the match (a file chosen late: it is not
// asked for at the start), and is checked after it, its problems shown but never stopping the workflow.
// Then the review, the decisions recorded in the dataset or in a file of their own about it, checked
// again, compared with the dataset (only when they were added to it: a file of its own is not a version
// of it), written out, and published if asked.
import mapYourData from './map-your-data.js';
import { BASE } from './asks.js';

const ask = (k) => ({ ...mapYourData.asks[k] });

export default {
  key: 'match-two-datasets',
  title: 'Match two datasets',
  version: 2,
  files: {
    files: { words: 'Your dataset (a table of places, CSV or GeoJSON, or a dataset in a PLATO format), the one the decisions are about', types: ['files'] },
    others: { words: 'The other dataset', types: ['files'], late: true },
  },
  // What the match cannot do, said in words before the workflow is followed and while it is.
  cannot: [
    "The other dataset's places must have web addresses of their own (an @id): a decision names both places by their addresses, so a place without one cannot be matched. The match counts them.",
    "Places are matched by their names, and only within 50 km of each other where both have a location; each of your places is given at most its five best candidates. These are Krisis's default options: the distance, and how alike two names must be, are changed in its options. Nothing is accepted in bulk: every decision is yours.",
    'Measured with the command line (in Node, not in the browser), with 50,000 places in each dataset (constructed ones), the match took about 65 seconds on a laptop of 2024 and held under 500 MB; larger datasets are not refused, but are unmeasured.',
    'A candidate of another kind of place than yours (a lake for a village) is ranked after the others and marked, never left out.',
    "The other dataset is checked after the match, and what the check finds is shown, but does not stop the workflow; a file the tools cannot read stops the match.",
  ],
  asks: {
    // Set by the interview's route (a table, or a PLATO dataset), never asked: whether your dataset is read from a table first.
    'from-table': { question: 'Is your dataset a table of places (CSV or GeoJSON), to be read into PLATO first?', kind: 'yes-no' },
    'into-dataset': {
      question: 'Add the decisions to your dataset, or keep them in a file of their own about it?',
      kind: 'yes-no', answers: ['Add them to my dataset', 'Keep them in a file of their own'], default: true,
    },
    'will-publish': ask('will-publish'),
    'will-mint': ask('will-mint'),   // Issue #36: Wikidata items, under their own answer
    base: BASE,
    target: ask('target'),
    release: ask('release'),
    repo: ask('repo'),
    maintainers: ask('maintainers'),
  },
  steps: [
    { id: 'columns', op: 'read.columns', title: 'Match the columns to PLATO', from: { files: '$files' }, when: 'from-table' },
    { id: 'check', op: 'check', title: 'Check the table', from: { files: '$files', mapping: 'columns.mapping' }, when: 'from-table' },
    { id: 'dataset', op: 'convert', title: 'Make a PLATO dataset of it', from: { files: '$files', mapping: 'columns.mapping' }, options: { target: 'plato-json', base: '$base' }, when: 'from-table' },
    { id: 'check-a', op: 'check', title: 'Check your dataset', from: { files: '$files' }, when: '!from-table' },
    { id: 'match', op: 'match', title: 'Find the places of yours that may be the same as places of the other dataset', from: { subjects: 'dataset.dataset ?? $files', others: '$others' } },
    { id: 'check-other', op: 'check', title: 'Check the other dataset', from: { files: '$others' }, options: { problems: 'report' } },
    { id: 'review', op: 'review', title: 'Decide which candidates are the same place', from: { work: 'match.work' } },
    { id: 'wikidata', op: 'wikidata.items', title: 'Create Wikidata items for the places no gazetteer knows', from: { subjects: 'dataset.dataset ?? $files', work: 'review.work' }, when: 'will-mint' },
    { id: 'apply', op: 'apply', title: 'Record the decisions', from: { subjects: 'dataset.dataset ?? $files', work: 'wikidata.work ?? review.work' }, options: { intoDataset: '$into-dataset', exportCandidates: '$will-publish', base: '$base' } },
    { id: 'again', op: 'check', title: 'Check the result', from: { files: 'apply.dataset' } },
    { id: 'compare', op: 'compare', title: 'Compare the result with your dataset', from: { earlier: 'dataset.dataset ?? $files', later: 'apply.dataset' }, when: 'into-dataset' },
    { id: 'out', op: 'convert', title: 'Write it out', from: { files: 'apply.dataset' }, options: { target: '$target' } },
    { id: 'mint', op: 'publish.mint', title: 'Give every place and source a permanent address', from: { dataset: 'apply.dataset' }, options: { release: '$release', base: '$base' }, when: 'will-publish' },
    { id: 'report', op: 'publish.report', title: 'Write the FAIR report', from: { dataset: 'mint.dataset' }, options: { release: '$release' }, when: 'will-publish' },
    { id: 'site', op: 'publish.site', title: 'Build the web site', from: { dataset: 'mint.dataset' }, options: { release: '$release', repo: '$repo' }, when: 'will-publish' },
    { id: 'w3id', op: 'publish.w3id', title: 'Write the permanent-address rules', from: { dataset: 'mint.dataset' }, options: { repo: '$repo', maintainers: '$maintainers' }, when: 'will-publish' },
  ],
};
