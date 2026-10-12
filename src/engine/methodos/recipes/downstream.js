// What the workflows that begin from a reader's dataset share with Map your data once that dataset is
// made: the same questions, in the same words (taken from Map your data's recipe, not written again),
// and the same steps after the dataset, through the same operations and adapters: looked up in the
// World Historical Gazetteer, reviewed, the decisions recorded, drawn or traced where wanted, checked
// again, compared with what came in, written out, and published if asked.
//
// Not shared, by design: Map your data's regions. A TEI edition and a Recogito export do not say which
// region each place is in as a table's "within" columns do, so there are no regions to identify, and
// the decisions are recorded by the plain step (`apply`), as Map your data records them without regions.
import mapYourData from './map-your-data.js';

const ask = (k) => ({ ...mapYourData.asks[k] });

/**
 * The questions: drawing and publishing, Map your data's yes-or-no questions; the format written; and,
 * for publishing, what Publish a dataset asks (the base address optional, as there: minting takes it where
 * the dataset has none of its own).
 */
export const ASKS = {
  'will-draw': ask('will-draw'),
  'will-publish': ask('will-publish'),
  base: { question: 'Under what base address will your places have web addresses of their own (for example https://example.org/places/)?', kind: 'text', optional: true },
  target: ask('target'),
  release: ask('release'),
  repo: ask('repo'),
  maintainers: ask('maintainers'),
};

/**
 * The steps after the dataset is made (`dataset.dataset`), as Map your data has them without regions;
 * `from` is what the dataset was made from, in words ("the edition").
 */
export function afterDataset(from) {
  const result = 'place.dataset ?? apply.dataset';
  return [
    { id: 'lookup', op: 'lookup', title: 'Look the places up in the World Historical Gazetteer', from: { subjects: 'dataset.dataset' } },
    { id: 'review', op: 'review', title: 'Decide which candidates are the same place', from: { work: 'lookup.work' } },
    { id: 'apply', op: 'apply', title: 'Record the decisions in the dataset', from: { subjects: 'dataset.dataset', work: 'review.work' } },
    { id: 'place', op: 'place', title: 'Draw or trace the places still without a location', from: { dataset: 'apply.dataset' }, when: 'will-draw' },
    { id: 'again', op: 'check', title: 'Check the result', from: { files: result } },
    { id: 'compare', op: 'compare', title: `Compare the result with the dataset made from ${from}`, from: { earlier: 'dataset.dataset', later: result } },
    { id: 'out', op: 'convert', title: 'Write it out', from: { files: result }, options: { target: '$target' } },
    { id: 'mint', op: 'publish.mint', title: 'Give every place and source a permanent address', from: { dataset: result }, options: { release: '$release', base: '$base' }, when: 'will-publish' },
    { id: 'report', op: 'publish.report', title: 'Write the FAIR report', from: { dataset: 'mint.dataset' }, options: { release: '$release' }, when: 'will-publish' },
    { id: 'site', op: 'publish.site', title: 'Build the web site', from: { dataset: 'mint.dataset' }, options: { release: '$release', repo: '$repo' }, when: 'will-publish' },
    { id: 'w3id', op: 'publish.w3id', title: 'Write the permanent-address rules', from: { dataset: 'mint.dataset' }, options: { repo: '$repo', maintainers: '$maintainers' }, when: 'will-publish' },
  ];
}
