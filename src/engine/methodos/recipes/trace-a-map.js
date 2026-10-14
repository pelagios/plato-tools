// Trace a historical map (plan #34, item 6; Stephen's decisions of 14 October 2026): a georeferenced
// historical map, its places traced in Chora into a new dataset made from the map (each feature a place of
// its own, its name as the map writes it, its address minted under the base address), checked, looked up in
// the World Historical Gazetteer within the map's outline if asked, the decisions recorded, checked and
// compared again, written out, and published if asked.
//
// It begins from no file: the dataset is made in Chora at the first step, from the map. The lookup, its
// review and the recording of the decisions are Map your data's, through the same operations and adapters
// (downstream.js), under the answer "will-identify".
import { ASKS } from './downstream.js';
import { BASE } from './asks.js';

const result = 'apply.dataset ?? trace.dataset';
export default {
  key: 'trace-a-map',
  title: 'Trace a historical map',
  version: 1,
  files: {},
  asks: {
    'will-identify': { question: 'Will you look the places up in the World Historical Gazetteer, to identify each with a record there?', kind: 'yes-no' },
    'will-publish': ASKS['will-publish'],
    // Needed from the start (decision 8): every place traced is given its address under it as it is named.
    base: { ...BASE, optional: false },
    target: ASKS.target,
    release: ASKS.release,
    repo: ASKS.repo,
    maintainers: ASKS.maintainers,
  },
  before: [
    { words: "Looking the places up uses the World Historical Gazetteer's allowance of requests: its daily cap is 5,000 requests per token, and the lookup says before it sends how much of that it would use. A map of many places may be looked up over more than one day, the lookup resuming where it stopped.", when: 'will-identify' },
  ],
  steps: [
    { id: 'trace', op: 'trace', title: 'Trace the places from the map, into a new dataset', from: {} },
    { id: 'check', op: 'check', title: 'Check the dataset traced', from: { files: 'trace.dataset' } },
    { id: 'lookup', op: 'lookup', title: "Look the places up in the World Historical Gazetteer, within the map's outline", from: { subjects: 'trace.dataset' }, when: 'will-identify' },
    { id: 'review', op: 'review', title: 'Decide which candidates are the same place', from: { work: 'lookup.work' }, when: 'will-identify' },
    { id: 'apply', op: 'apply', title: 'Record the decisions in the dataset', from: { subjects: 'trace.dataset', work: 'review.work' }, when: 'will-identify' },
    { id: 'again', op: 'check', title: 'Check the result', from: { files: 'apply.dataset' }, when: 'will-identify' },
    { id: 'compare', op: 'compare', title: 'Compare the result with the dataset traced', from: { earlier: 'trace.dataset', later: 'apply.dataset' }, when: 'will-identify' },
    { id: 'out', op: 'convert', title: 'Write it out', from: { files: result }, options: { target: '$target' } },
    { id: 'mint', op: 'publish.mint', title: 'Give every place and source a permanent address', from: { dataset: result }, options: { release: '$release', base: '$base' }, when: 'will-publish' },
    { id: 'report', op: 'publish.report', title: 'Write the FAIR report', from: { dataset: 'mint.dataset' }, options: { release: '$release' }, when: 'will-publish' },
    { id: 'site', op: 'publish.site', title: 'Build the web site', from: { dataset: 'mint.dataset' }, options: { release: '$release', repo: '$repo' }, when: 'will-publish' },
    { id: 'w3id', op: 'publish.w3id', title: 'Write the permanent-address rules', from: { dataset: 'mint.dataset' }, options: { repo: '$repo', maintainers: '$maintainers' }, when: 'will-publish' },
  ],
};
