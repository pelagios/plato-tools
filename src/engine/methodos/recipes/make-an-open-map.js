// Make an open map (plan #34, item 8; Issue #37; Stephen's decisions of 14 October 2026): a list of place names,
// a table, or a dataset in a PLATO format, its places identified as Map your data identifies them (a list or a
// table: its columns matched, checked, made a PLATO dataset; a PLATO dataset: checked, and taken as it is),
// looked up in the World Historical Gazetteer, reviewed, the decisions recorded, located in Chora and checked
// again; then made into a map in Chora ("Make a map") and downloaded there: an SVG and a PNG under a licence
// Wikimedia Commons accepts, with the file's Commons page ready to paste. No tracing: that is the other direction
// ("Trace a historical map"); here a georeferenced historical map is only an optional background.
//
// Locating the places in Chora is a step every time, not a question: recording the decisions gives each place the
// identity it was matched with, not its location (adopting a match's location is done by hand in Chora, "Adopt:
// this place is that record, located there", as decided for Map your data), so a list of names reaches the map
// with nothing to draw unless its places are located there. A dataset whose places have locations already goes
// on with "Nothing to draw: go on with this dataset".
//
// Which way the dataset is made is the interview's route (`from-table`, set, never asked), as Match two
// datasets has it. A list or a table is read under the base address (needed: the lookup records what each place is
// matched with against the place's own address, which a place of a list has only under it); a PLATO dataset's places
// have their addresses already. Nothing is published under it.
import { BASE } from './asks.js';

const decided = 'apply.dataset';
const result = 'place.dataset';
export default {
  key: 'make-an-open-map',
  title: 'Make an open map',
  version: 1,
  files: {
    files: { words: 'The place names (a list pasted, one a line, or a table, CSV or GeoJSON), or a dataset in a PLATO format', types: ['files'] },
  },
  // What the map cannot carry, said in words before the workflow is followed and while it is.
  cannot: [
    'The map is made of the places in view in Chora, at most 200 at a time: zoom in to make it of fewer. A place with no location is not drawn: recording the decisions identifies each place with its match, but gives it no location, so each is located in Chora (its location adopted from its match, or drawn) before the map is made.',
    "A background whose licence is not known (a basemap you pasted), CARTO's basemaps, and anything under a licence for no commercial use or no adaptations cannot go to Wikimedia Commons: Chora names which, and why, and does not offer the map until it is put right. Share-alike (the Digital Atlas of the Roman Empire, OpenStreetMap) makes the map CC BY-SA.",
    'Labels are placed so as not to overlap one another, a place or the scale and the attribution; a label that finds no room is said, for you to drag where it should go.',
  ],
  asks: {
    // Set by the interview's route (a list or a table, or a PLATO dataset), never asked: whether the dataset is read from a table first.
    'from-table': { question: 'Is your dataset a list or a table of places (CSV or GeoJSON), to be read into PLATO first?', kind: 'yes-no' },
    // Asked by the interview for a list or a table (interview.js), needed there.
    base: BASE,
  },
  before: [
    { words: "Looking the places up uses the World Historical Gazetteer's allowance of requests: its cap is 5,000 requests a day per token, and the lookup says before it sends how much of that it would use." },
  ],
  steps: [
    { id: 'columns', op: 'read.columns', title: 'Match the columns to PLATO', from: { files: '$files' }, when: 'from-table' },
    { id: 'check', op: 'check', title: 'Check the table', from: { files: '$files', mapping: 'columns.mapping' }, when: 'from-table' },
    { id: 'dataset', op: 'convert', title: 'Make a PLATO dataset of it', from: { files: '$files', mapping: 'columns.mapping' }, options: { target: 'plato-json', base: '$base' }, when: 'from-table' },
    { id: 'check-a', op: 'check', title: 'Check your dataset', from: { files: '$files' }, when: '!from-table' },
    { id: 'lookup', op: 'lookup', title: 'Look the places up in the World Historical Gazetteer', from: { subjects: 'dataset.dataset ?? $files' } },
    { id: 'review', op: 'review', title: 'Decide which candidates are the same place', from: { work: 'lookup.work' } },
    { id: 'apply', op: 'apply', title: 'Record the decisions in the dataset', from: { subjects: 'dataset.dataset ?? $files', work: 'review.work' } },
    { id: 'place', op: 'place', title: 'Locate the places in Chora: adopt each one\'s location from its match, or draw it', from: { dataset: decided } },
    { id: 'again', op: 'check', title: 'Check the result', from: { files: result } },
    { id: 'map', op: 'map.export', title: 'Make the map in Chora, and download it', from: { dataset: result } },
  ],
};
