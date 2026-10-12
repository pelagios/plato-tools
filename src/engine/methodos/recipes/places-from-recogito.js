// Places from Recogito (docs/plans/methodos.md, section 6): the places linked in a Recogito export of
// W3C Web Annotations, read by Hermes's reader into a PLATO dataset (each link from a passage or a region
// an attestation about the place, citing the annotated document; a region on a map placed through the
// map's IIIF georeference, when that is chosen with the export), then as Map your data goes on without
// regions (downstream.js): looked up in the World Historical Gazetteer, reviewed, the decisions recorded,
// drawn or traced where wanted, checked again, compared with what came in, written out; published if asked.
import { ASKS, afterDataset } from './downstream.js';

export default {
  key: 'places-from-recogito',
  title: 'Places from Recogito',
  version: 1,
  files: {
    files: { words: 'The Recogito export (W3C Web Annotations), with the IIIF georeferences of its maps, and their manifests, if it has regions drawn on maps', types: ['files'] },
  },
  // What the reader cannot carry, said in words before the workflow is followed and while it is.
  cannot: [
    "A mention marked as a place but never linked to one, or linked by something that is not a web address, and a link made by Recogito's own name recognition that no person saved, are not carried. The conversion's report names them.",
    "Recogito's link is kept as the place's own address, and is never replaced: the lookup looks for the place in the World Historical Gazetteer beside it, never suggests WHG's record of what the link names (for a WHG, GeoNames, Getty TGN, Wikidata, OpenStreetMap or Pleiades address), and flags the place for you, never accepting it in bulk, when WHG's best candidate is more than 25 km from that record (the distance is set in the lookup panel).",
    "What the export copies from the gazetteer (a place's title, its coordinates) is not carried, so a region with no transcription or quoted name has no name to look up, and is not looked up.",
    "A region drawn on a map is placed only through the map's IIIF georeference, chosen with the export: as its centre, with a radius that holds it all, not as drawn. A region off the map, beyond its control points or on a map with no georeference is not placed, and is reported; the step that reads the export says how many of its regions were placed.",
  ],
  asks: ASKS,
  steps: [
    { id: 'check', op: 'check', title: 'Check the annotations', from: { files: '$files' } },
    { id: 'dataset', op: 'convert', title: 'Read the places they link into a PLATO dataset', from: { files: '$files' }, options: { target: 'plato-json' } },
    ...afterDataset('the annotations'),
  ],
};
