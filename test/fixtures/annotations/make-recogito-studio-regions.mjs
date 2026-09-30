// Writes recogito-studio-regions-constructed.json: regions drawn on the Rocque/Dury map (and two
// other images), serialised exactly as Recogito Studio's W3C export writes image annotations, until
// a real export of regions on that map replaces it. See README.md ("Constructed").
//
//   node test/fixtures/annotations/make-recogito-studio-regions.mjs
//
// The serialisation follows, step by step:
//   - recogito-client b211f751c19497d37e01e819d47511ed0ed71dac: src/backend/helpers/annotationHelpers.ts
//     (getAnnotations: the target is { annotation, selector, created, creator, updated, updatedBy },
//     the creator { id, name, avatar }, visibility undefined unless private) and
//     src/util/export/w3c/w3cExporter.ts (normalize: layer_id removed, motivation "commenting";
//     the image source is the stored selector's `source`; crosswalkAnnotationBodies);
//   - @annotorious/annotorious 3.8.10: serializeW3CImageAnnotation (an unrotated rectangle as a
//     FragmentSelector "xywh=pixel:x,y,w,h", every other shape as an SvgSelector, with the numbers
//     written as JavaScript writes them), serializeSVGSelector, and @annotorious/core's
//     serializeW3CBodies.
// Key order is the order those spreads give: id, target, motivation, @context, type, created,
// creator, body. `modified` is left out, as it is when a target was never updated.
import { writeFileSync } from 'node:fs';

const CANVAS = 'https://ark.digitalcommonwealth.org/ark:/50959/ks65px29g/canvas/8623qf00m';
const SERVICE = 'https://iiif.digitalcommonwealth.org/iiif/2/commonwealth:8623qf00m';
const SECOND_CANVAS = 'https://ark.digitalcommonwealth.org/ark:/50959/ks65px29g/canvas/qr46xn78z';
const CHESAPEAKE = 'https://tile.loc.gov/image-services/iiif/service:gmd:gmd384:g3842:g3842c:ct008615';
const V1_PART = 'https://recogito.pelagios.org/part/7d2c4e1a-0b3f-4a5e-9c8d-1e2f3a4b5c6d';

const user = { id: '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d', name: 'Ayşe Yılmaz', avatar: null };
const created = '2026-09-30T09:00:00.000Z';

// @annotorious/annotorious 3.8.10, serializeFragmentSelector and serializeSVGSelector.
const rectangle = ({ x, y, w, h, rot = 0 }) => {
  if (!rot) return { type: 'FragmentSelector', conformsTo: 'http://www.w3.org/TR/media-frags/', value: `xywh=pixel:${x},${y},${w},${h}` };
  const cx = x + w / 2, cy = y + h / 2, angle = ((rot ?? 0) * 180) / Math.PI;
  return { type: 'SvgSelector', value: `<svg><rect x="${x}" y="${y}" width="${w}" height="${h}" transform="rotate(${angle} ${cx} ${cy})" /></svg>` };
};
const polygon = (points) => ({ type: 'SvgSelector', value: `<svg><polygon points="${points.map((xy) => xy.join(',')).join(' ')}" /></svg>` });
const ellipse = ({ cx, cy, rx, ry }) => ({ type: 'SvgSelector', value: `<svg><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" /></svg>` });
const path = (d) => ({ type: 'SvgSelector', value: `<svg><path d="${d}" /></svg>` });

// Bodies as crosswalkAnnotationBodies writes them.
const who = { id: user.id, name: user.name };
const geotag = (id, title, coordinates) => ({ created, creator: who, purpose: 'geotagging', value: { id, type: 'Feature', properties: { title }, geometry: { type: 'Point', coordinates } }, format: 'application/json' });
const tag = (value) => ({ created, creator: who, purpose: 'tagging', value });
const comment = (value) => ({ created, creator: who, purpose: 'commenting', value, type: 'TextualBody', format: 'text/html' });
// NOT written by Recogito Studio's own editor, which has no transcription (its bodies are
// commenting, replying, tagging and the geotagging plugin's): a body with purpose "transcribing"
// as crosswalkAnnotationBodies would write one (no type, since the purpose is not commenting).
const transcription = (value) => ({ created, creator: who, purpose: 'transcribing', value });

let n = 0;
const annotation = (source, selector, body) => ({
  id: `3b7e2f10-6c4d-4e5a-9f8b-${String(++n).padStart(12, '0')}`,
  target: { source, type: 'SpecificResource', selector },
  motivation: 'commenting',
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  created,
  creator: user,
  body,
});

// Pixel positions are full-resolution image pixels of the Rocque/Dury map (11436 x 6268), read off
// the image around each printed label. The Allmaps mask is 284,942 226,6060 10776,6112 10752,976.
const out = [
  // 1. A rectangle round "LAKE ERIE", with a transcription: a label.
  annotation(CANVAS, rectangle({ x: 5120, y: 5600, w: 230, h: 72 }), [geotag('http://www.wikidata.org/entity/Q5492', 'Lake Erie', [-81.2, 42.2]), transcription('LAKE ERIE')]),
  // 2. A polygon round "LAKE ONTARIO", with the name as a quote. NOT Studio's shape: Annotorious
  //    writes one selector, and no TextQuoteSelector, for an image. Here to test a quote as evidence.
  annotation(CANVAS, [polygon([[5524, 5352], [5906, 5350], [5908, 5410], [5522, 5414]]), { type: 'TextQuoteSelector', exact: 'LAKE ONTARIO' }], [geotag('http://www.wikidata.org/entity/Q1062', 'Lake Ontario', [-77.9, 43.7])]),
  // 3. A rotated rectangle along "St Georges Bank", written at a slant.
  annotation(CANVAS, rectangle({ x: 6932, y: 5370, w: 280, h: 40, rot: -0.2 }), [geotag('http://www.wikidata.org/entity/Q5546752', 'Georges Bank', [-67.7, 41.4]), transcription('St Georges Bank')]),
  // 4. An ellipse round "LAKE HURON".
  annotation(CANVAS, ellipse({ cx: 5040, cy: 5170, rx: 190, ry: 32 }), [geotag('http://www.wikidata.org/entity/Q1383', 'Lake Huron', [-82.4, 44.8]), transcription('LAKE HURON')]),
  // 5. "Montreal", with a comment but no transcription: nothing says it is a label.
  annotation(CANVAS, rectangle({ x: 6140, y: 5074, w: 140, h: 32 }), [geotag('http://www.wikidata.org/entity/Q340', 'Montreal', [-73.56, 45.5]), comment('<p>Town on the St Lawrence.</p>')]),
  // 6. The town symbol (a small circle) of Worcester, tagged "symbol".
  annotation(CANVAS, rectangle({ x: 6358, y: 5510, w: 15, h: 15 }), [geotag('http://www.wikidata.org/entity/Q49179', 'Worcester', [-71.8, 42.27]), tag('symbol')]),
  // 7. The meridian label "120" in the top margin, above the neatline: outside the mask.
  annotation(CANVAS, rectangle({ x: 3718, y: 892, w: 84, h: 36 }), [geotag('http://www.wikidata.org/entity/Q2696926', '120th meridian west', [-120, 45]), transcription('120')]),
  // 8. The parallel label "45" in the left border, drawn round loosely, well into the map: its centre
  //    is inside the mask, and it reaches beyond it; but its centre is beyond the control points.
  annotation(CANVAS, rectangle({ x: 188, y: 2190, w: 192, h: 60 }), [geotag('http://www.wikidata.org/entity/Q1256191', '45th parallel north', [-90, 45]), transcription('45')]),
  // 9. "Boston", on the image service's full-size picture rather than the canvas.
  annotation(`${SERVICE}/full/max/0/default.jpg`, rectangle({ x: 6278, y: 5480, w: 120, h: 30 }), [geotag('http://www.wikidata.org/entity/Q100', 'Boston', [-71.06, 42.36]), transcription('Boston')]),
  // 10. "Boston Harbour", on a cropped picture of the image: its pixels are not the image's.
  annotation(`${SERVICE}/6200,5300,1000,500/full/0/default.jpg`, rectangle({ x: 290, y: 150, w: 260, h: 40 }), [geotag('http://www.wikidata.org/entity/Q100', 'Boston', [-71.06, 42.36]), transcription('Boston Harbour')]),
  // 11. "Nantucket I.", drawn with a curved outline (a cubic Bezier), which cannot be transformed.
  annotation(CANVAS, path('M 6550 5640 C 6600 5630 6680 5630 6725 5642 L 6725 5676 L 6550 5676 Z'), [geotag('http://www.wikidata.org/entity/Q49149', 'Nantucket', [-70.1, 41.28]), transcription('Nantucket I.')]),
  // 12. "GULF OF MEXICO" on the map's second sheet, which has no georeference.
  annotation(SECOND_CANVAS, rectangle({ x: 3850, y: 2200, w: 1250, h: 750 }), [geotag('http://www.wikidata.org/entity/Q12630', 'Gulf of Mexico', [-90, 25]), transcription('GULF OF MEXICO')]),
  // 13. A region on a Recogito v1 document part, which is not a IIIF image.
  annotation(V1_PART, rectangle({ x: 1200, y: 800, w: 300, h: 60 }), [geotag('http://www.wikidata.org/entity/Q5492', 'Lake Erie', [-81.2, 42.2]), transcription('Lake Erie')]),
  // 14. A region on the Library of Congress's Chesapeake and Ohio Canal map, where its two
  //     georeferenced maps meet (inside the second only; inside both on the constructed page).
  annotation(CHESAPEAKE, rectangle({ x: 2750, y: 5000, w: 100, h: 40 }), [geotag('http://www.wikidata.org/entity/Q1070564', 'Chesapeake and Ohio Canal', [-77.5, 39.3])]),
  // 15. The meridian label "120" again, drawn round loosely, down into the map: part of it is inside
  //     the mask, but not its centre.
  annotation(CANVAS, rectangle({ x: 3718, y: 892, w: 84, h: 80 }), [geotag('http://www.wikidata.org/entity/Q2696926', '120th meridian west', [-120, 45]), transcription('120')]),
  // 16. "Albany", tagged "Label" (the tag convention, which Studio's editor can write).
  annotation(CANVAS, rectangle({ x: 6096, y: 5482, w: 110, h: 28 }), [geotag('http://www.wikidata.org/entity/Q24861', 'Albany', [-73.76, 42.65]), tag('Label')]),
];

writeFileSync(new URL('./recogito-studio-regions-constructed.json', import.meta.url), JSON.stringify(out, null, 2));
