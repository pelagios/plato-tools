// Places from an edition (TEI) (docs/plans/methodos.md, section 6): the place names of a TEI edition,
// read by Hermes's TEI reader into a PLATO dataset (each name an attestation about the place its ref
// points to, citing the edition), then as Map your data goes on without regions (downstream.js): looked
// up in the World Historical Gazetteer, reviewed, the decisions recorded, drawn or traced where wanted,
// checked again, compared with what came in, written out; published if asked.
import { ASKS, afterDataset } from './downstream.js';

export default {
  key: 'places-from-tei',
  title: 'Places from an edition (TEI)',
  version: 1,
  files: {
    files: { words: 'The edition in TEI XML', types: ['files'] },
  },
  // What the reader cannot carry, said in words before the workflow is followed and while it is.
  cannot: [
    "A place name with no ref points to no place, so it is not carried; one with a key is carried only with a pattern for its prefix, in the Reading options. The conversion's report names each one left out.",
    "A ref is kept as the place's own address, as the edition gives it: the lookup looks for the place in the World Historical Gazetteer beside it and does not check it, and the record the ref names is not suggested again.",
    "An edition does not say which region each place is in, as a table's columns can, so no regions are identified.",
    "Coordinates in a place name's own <geo> are not carried, and are reported; a list of places, with its coordinates, is read only with “Read the list of places” ticked in the Reading options, and the header and the commentary only with theirs, as the editors' words.",
  ],
  asks: ASKS,
  steps: [
    { id: 'check', op: 'check', title: 'Check the edition', from: { files: '$files' } },
    { id: 'dataset', op: 'convert', title: 'Read its place names into a PLATO dataset', from: { files: '$files' }, options: { target: 'plato-json' } },
    ...afterDataset('the edition'),
  ],
};
