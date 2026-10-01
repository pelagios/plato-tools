// Collects problems and losses without letting them grow with the data: each kind keeps a count
// and a handful of examples, however many times it occurs.
export class Report {
  constructor({ examples = 5 } = {}) { this.examples = examples; this.kinds = new Map(); this.counts = {}; }
  add(severity, kind, message, example, n = 1) {
    const key = severity + '\u0001' + kind + '\u0001' + message;
    let k = this.kinds.get(key);
    if (!k) { k = { severity, kind, message, count: 0, examples: [] }; this.kinds.set(key, k); }
    k.count += n;
    if (example !== undefined && k.examples.length < this.examples) k.examples.push(example);
  }
  error(kind, message, example) { this.add('error', kind, message, example); }
  warning(kind, message, example) { this.add('warning', kind, message, example); }
  loss(kind, message, example) { this.add('loss', kind, message, example); }
  count(name, n = 1) { this.counts[name] = (this.counts[name] || 0) + n; }
  /**
   * Say what changed in one of a kind's examples (the version check): the statements the earlier
   * version makes of it that the later does not, and the other way round.
   */
  explain(kind, example, earlier, later) {
    for (const k of this.kinds.values()) if (k.kind === kind) (k.explained ||= []).push({ example, earlier, later });
  }
  toJSON() {
    const items = [...this.kinds.values()].sort((a, b) => ['error', 'warning', 'loss'].indexOf(a.severity) - ['error', 'warning', 'loss'].indexOf(b.severity) || b.count - a.count);
    return { counts: this.counts, errors: items.filter((i) => i.severity === 'error').reduce((n, i) => n + i.count, 0), items };
  }
}

// Plain-language explanations for the kinds the converters report.
export const LOSS_TEXT = {
  'value-is-node': "A value is given as a blank node rather than a literal (a structured value written without plato:value_json leaves this), so there is no value to carry and it is left out; the node's label is not a value.",
  'value-json-invalid': 'A structured value (plato:value_json) is not a JSON object, so it cannot be read back and is left out.',
  'type-not-carried': "A type the input states for a node is neither one PLATO JSON carries nor one the tools would derive from the node's own statements, so it is left out; the example names the node and the type.",
  'lpf-licence-text': "The collection's licence is written in words, not as a web address, and PLATO's licence must be an address, so it is left out; give the licence's address (for example https://creativecommons.org/licenses/by-nc/4.0/) to keep it.",
  'bundled-attestation': 'Attestations that bundle several kinds of fact are split into one row or element per fact; that they came from one attestation is lost.',
  'extra-sources': 'Only the first source of an attestation fits; the others are dropped.',
  'extra-timespans': 'Only the first date of an attestation fits; the others are dropped.',
  'four-date-bounds': 'Only the earliest start and latest end fit; the latest start and earliest end are dropped.',
  'attestation-without-source': 'An attestation has no source; the tables require one, so it is given the source "No source given".',
  'attestation-without-facet': 'An attestation with no name, location, type, relation or property has no row to go in and is dropped.',
  retracted: 'An attestation that has been withdrawn (plato:Retracts) is left out: this file shows only the current state, and written here the withdrawn claim would read as current.',
  superseded: 'An attestation that has been replaced by a later one (plato:Supersedes) is left out: this file shows only the current state, of which the replaced claim is no longer part.',
  'about-value': "A value of the gazetteer is not in the form its column in the about sheet takes (a web address, 'draft' or 'published', a date of at least four digits, or a list item without ';'), so it is left out; the example names the key and the value.",
  'creator-name': "An author's name that the about sheet's creator column cannot hold (it contains '<', '>' or ';', or is not text) is left out, and the author's web address is kept.",
  'gazetteer-version': "The gazetteer's version and status (version, status, isVersionOf, previousVersion) have no place here and are dropped, so this file does not say which state of the gazetteer it holds.",
  'figure-literal': 'A coordinate or attribute of a statistical figure whose datatype PLATO JSON cannot carry (a year typed xsd:gYear, a language tag) keeps its text; the datatype is dropped.',
  'figure-blank-value': 'A coordinate or attribute of a statistical figure that is a node with no web address cannot be written in PLATO JSON, which needs a code or a literal, and is dropped.',
  'component-address': "The web address of a component of a table's structure has no place in PLATO JSON and is dropped; the component itself is kept.",
  'statistical-figure': 'A figure from a statistical table cannot go here: without its coordinates it would be stated of the place as a whole (a county does not have "persons: 280", its male agricultural labourers do), so it is left out.',
  'relation-types': "The relation types the document declares for its own use (relationTypes: their names and the PLATO types they narrow) have no place here and are dropped; relations that use them keep their addresses where the format can hold them.",
  'statistical-tables': "The document's statistical tables (dataSets: their titles, scope and structure) have no place here and are dropped.",
  'meta-attestation': 'Comments on other attestations (contradicts, supports…) have no place here and are dropped.',
  denial: 'A denial (the source says that this is not so) cannot be expressed here, so that attestation is left out: written, it would assert what its source denies.',
  'denial-bundled': 'A denial of several things at once is left out: a row denies one thing, and split into rows it would deny each thing on its own, which the source did not say.',
  'alternative-readings': 'Alternative readings of one piece of evidence (at most one of them right) cannot be marked as alternatives here: each reading is written as a claim of its own, so one piece of evidence counts as several.',
  qualification: 'Fuzziness, relative positions and per-value certainty have no place here and are dropped.',
  'transcription-judgement': 'Judgements of how well a value was read (transcription accuracy and completeness) have no place here and are dropped; the spreadsheet tables hold them for names only.',
  'transcription-value': 'A transcription judgement that is not one of PLATO\'s own (Accurate, Inaccurate, False; Complete, Reconstructable, NonReconstructable) cannot go in the names sheet and is dropped.',
  'citation-function': 'Why a source is cited (its CiTO citation function, such as citesAsEvidence) has no LPF slot and is dropped.',
  'citation-function-not-cito': 'A citation function that is not one of the CiTO terms the tables list cannot go in the citation_function column and is dropped.',
  'point-derived-from-shape': 'A shape without a point is given the centre of its bounding box as latitude and longitude.',
  'geometry-without-coordinates': 'A geometry with neither coordinates nor a shape is dropped.',
  'relation-type-not-in-plato': 'A relation whose type is not in PLATO\'s vocabulary cannot go in the tables and is dropped.',
  'relation-label': 'Relation labels are dropped.',
  'relation-without-target': 'Linked Places Format needs a target address for a relation; a relation named only by its label (relatedLabel, with no relatesTo: "in the Delta") is left out.',
  'evidence-span': "The span of the evidence for a place (timespanRole EvidenceSpan: the earliest and latest documents that mention it) is not the dates of the place, and cannot be marked as such here, so those dates are left out: written here they would read as the dates of the place.",
  computed: "A value worked out by software rather than taken from a source (computed), such as an itinerary's span from its stops, is left out: it is not evidence, and written here it would read as a source's statement.",
  'source-label': 'A value as the source wrote it (a name, location or type, before it was normalised) has no column or field here, so it is dropped; the normalised value is kept.',
  'period-label': 'A timespan with both a period name and the date as written keeps only the date as written.',
  'certainty-level': 'A certainty level that cannot be expressed here (not one of Certain, LessCertain, Uncertain, or on a kind of fact that has no certainty) is dropped.',
  'identity-bundle': "Identity matches that an attestation makes together (its identities, such as the matches made in accepting a cluster) cannot go here: written as separate matches they would lose the source, date and certainty they share, and could no longer be withdrawn together. They are left out; the example names the attestation.",
  'identity-denied': 'A statement that places are NOT the same (an attestation that denies the identity matches it bundles) cannot be expressed here, so it is left out: written as a match, it would say the opposite. The example names the attestation.',
  'identity-provenance': 'Who made an identity match, and the candidate it answers, have no place here and are dropped.',
  'place-without-address': 'A place has no web address (@id), so it is written as a place of its own, with a place_id of its own (place, place-2 and so on), and reading the tables back gives it an address under the base address it did not have.',
  'place-address': "A place's web address is not kept: its place_id is only the last part of it, and reading the tables back makes a new address from the base address you choose.",
  'source-address': "A source's web address is not kept: its source_id is only the last part of it, and reading the tables back makes a new address from the base address you choose.",
  'lpf-undated': "A date with no years (a date as the source wrote it, or a period's name, alone) cannot be an LPF when, which needs a timespan, so it is dropped.",
  'literal-language': 'A value has a language tag (as in "Londres"@fr), which PLATO JSON has no place for: the text is kept and the tag is lost. A tag on a name is no loss when the name\'s "language" key says the same language, or when the name has no "language" key and the tag can be one (it then becomes the key); it is reported here when the key says another language, when PLATO\'s pattern for a language tag cannot hold it, and on any other text (labels, notes, titles). The example names the node, the property and the value.',
  'literal-datatype': 'A value has a datatype other than the one PLATO JSON gives its key (as in "1086"^^xsd:gYear where PLATO writes a plain string): the value is kept, as text or a number, and the datatype is lost; written back to RDF it takes PLATO\'s own. A number is reported only when it may not be exactly the same number afterwards (as in "0.1"^^xsd:decimal, read as the nearest binary fraction); "1.0"^^xsd:decimal, written back as "1"^^xsd:integer, loses nothing. The example names the node, the property and the value with its datatype.',
  'candidate-set-not-written': 'Candidates (matches suggested by software) in this graph are not written: a candidate set is published apart from the dataset whose places it matches, and this output holds the dataset. Write the candidate set from a graph of its own, as PLATO JSON or RDF; the example names the candidate set, or a candidate in none.',
  'attestation-centric': 'An attestation given on its own (saying what it is about), in input whose header says it is place-centric, has no place to go here, where attestations are written under their place, so it is left out; the example names it. Put it under its place, or give the document the attestation-centric profile, to keep it.',
  'identity-without-place': 'An identity match whose place is not in the file has no feature to go on in Linked Places Format, so it is dropped.',
  'identity-type-missing': 'An identity match does not say what kind of match it is; the tables require match_type, so these rows must be completed before the tables are valid.',
  'form-status': 'Form status (headword, normalised…) has no LPF slot and is dropped.',
  'occurrence-context': 'Occurrence context (in a personal name…) has no LPF slot and is dropped.',
  'occurrence-count': 'Occurrence counts have no LPF slot and are dropped.',
  'numeric-certainty': 'LPF certainty is a word, not a number; numeric certainty is dropped.',
  'attribution-status': 'Inferred attributions ("ibid.") have no LPF slot; the fact is dropped.',
  'source-derivation': 'That one source is a copy of another has no LPF slot and is dropped.',
  'geometry-role': 'What a geometry depicts (extent, feature point…) has no LPF slot and is dropped.',
  'property-value': 'Properties other than descriptions and depictions have no LPF slot and are dropped.',
  'identity-type': 'LPF links are exact or close matches; "related" becomes a close match.',
  'identity-certainty-or-basis': 'The certainty and basis of identity matches have no LPF slot and are dropped.',
  'lpf-fclasses-missing': 'LPF requires feature classes (A, H, L, P, R, S, T); none could be derived for some places.',
  'lpf-duration': 'LPF durations (such as P100Y) have no PLATO equivalent and are dropped.',
  'lpf-extra-source-labels': 'Only the first source label of an LPF type fits.',
  'lpf-not-a-list': 'A member that Linked Places Format gives as a list is not one, so nothing in it is read; the example names the member.',
  'lpf-description-language': 'The language of LPF descriptions is dropped.',
  'lpf-depiction-licence': 'The licence of LPF depictions is dropped.',
  'lpf-link-type': 'An LPF link type PLATO does not know is dropped.',
  // W3C Web Annotations (src/formats/annotations.js): what an annotation holds that is not carried,
  // and what is carried but worth a look. The severity of each is ANNOTATION_KINDS's.
  'annotation-no-place': 'An annotation that links to no place (only comments, tags or transcriptions) has nothing for an attestation to be about, so it is not converted.',
  'annotation-place-unlinked': 'A mention marked as a place but never linked to one in a gazetteer (Recogito\'s "PLACE" with no match, or a geotag flagged as having none) has nothing for an attestation to be about, so it is not converted; link it to a gazetteer and export again to keep it. The example gives the words marked.',
  'annotation-not-place': 'An annotation of a person or an event, with no place, is not converted: a PLATO attestation is about a place.',
  'annotation-unidentified': 'An annotation that marks an entity without saying what kind or which one (an "identifying" body with nothing in it, as older Recogito exports write an unlinked mention) has nothing for an attestation to be about, so it is not converted.',
  'annotation-unverified': 'A place link suggested by software (Recogito\'s named-entity recognition and gazetteer matching) and never confirmed by a person is not converted: it is a suggestion, not anyone\'s statement, and PLATO has no way to mark a suggested link from a passage to a place. Confirm or correct it in Recogito and export again to keep it. The example gives the annotation and the suggested place.',
  'annotation-place-not-address': 'A place link whose identifier is not a web address (a gazetteer\'s own id, such as a Core Data record or a feature of an uploaded GeoJSON file) cannot say what the attestation is about, so it is not converted.',
  'annotation-gazetteer-copy': 'What the export copies from the gazetteer about a linked place (its coordinates, its title) is not carried: it is the gazetteer\'s description of the place, not evidence from the annotated document, and the place\'s web address leads to it.',
  'annotation-body': 'A part of an annotation (a body) of a kind PLATO has no place for (a classification, grouping or ordering, or a person or event beside a place link) is not carried; the example says what kind.',
  'annotation-selector': 'A way of pointing into the document that cannot be written as a locator in words (the shape of an area drawn on an image, or a selector of an unknown kind) is not carried; where it can, the locator says what kind of area it was.',
  'annotation-quote-context': 'The words before and after a marked passage (prefix and suffix) are not carried; the passage itself is the name, and its position the locator.',
  'annotation-key': 'A key of an annotation that PLATO has no place for is not carried; the example names it.',
  'annotation-creator-not-address': "A creator identified by the annotation tool's own internal id, not a web address, keeps only the name; the id is not carried.",
  'annotation-date': 'A date that is not a full date and time (such as 2024-06-01T16:48:39Z) cannot be the date an attestation was made or changed, so it is not carried.',
  'annotation-whg-record': "A World Historical Gazetteer address of the form /places/<number>/portal with a number below 12,345,678 names one of WHG's database records in the place of a place cluster, and WHG answers it with the wrong place or an error, so the link is not carried. Recogito Studio writes these for some search results: link the place again, or give its address in the form https://w3id.org/whg/id/place:….",
  'annotation-whg-staging': "An address on dev.whgazetteer.org is WHG's staging copy, which has its own records and changes without notice, so the link is not carried. Link the place on whgazetteer.org instead.",
  'annotation-source-not-address': "The annotated document is identified by something that is not a web address, so its source has no address and keeps that identifier as its title. Recogito Studio writes its project's id here, so the documents of one project cannot be told apart: convert one document's export at a time, and give the source its address.",
  'annotation-target-no-source': "An annotation's target gives a position (a region, say) but not the document it is in. Recogito Studio does not write the address of an image that is not part of a IIIF manifest, so the document is named only by the export itself (its file, and the Studio project it came from): the source is given a title and no address. Convert one document's export at a time, and give the source the document's address. With georeferences, a region on such an image cannot be matched to a map. The example names the annotation.",
  'annotation-several-places': 'An annotation links one passage to several places: each link becomes an attestation of its own, with a note naming the others, and none takes the annotation\'s address.',
  'annotation-verification-unknown': "Recogito's export does not say whether a person confirmed a place link. A link with no creator was made by software and is left out (see above); a link a person added with Recogito's automatic match and never confirmed looks the same as a confirmed one, so these links are converted as the annotators' statements. Check them in Recogito if some may be unconfirmed.",
  'annotation-none-linked': 'No annotation in this file links a passage to a place in a gazetteer, so there is nothing to convert.',
  'annotation-more-pages': 'The annotations continue on another page, elsewhere on the web, which is not read: download every page and convert each.',
  'annotation-malformed': 'An annotation could not be read: it is not an object, or it has no target saying what document it is in. It is not converted; the rest of the file was.',
  // Georeferenced regions (src/formats/regions.js): only when georeferences are given with the export.
  'annotation-region-shape': 'A region drawn on a georeferenced map is carried as its centre, with a radius that holds all of it; the outline is not carried. The example names the annotation and the shape.',
  'annotation-region-no-georef': "A region on an image that none of the georeferences given is for, or on a cropped, rotated or resized picture of one (whose pixels are not the image's), cannot be placed in the world; it is kept only as the locator in words. The example names the image and, where there is one, why the picture does not match.",
  'annotation-region-outside-map': "A region whose centre lies outside the georeferenced part of its image (the map's mask, which leaves out margins, titles and insets) is not placed: a position there would stretch the georeference beyond its evidence. It is kept as the locator in words; the example says whether part of it is inside.",
  'annotation-region-beyond-control-points': "A region lies beyond the map's control points, where the georeference can only guess, so no position in the world is given for it. Its centre is inside the georeferenced part of the image, but outside the area the control points enclose (by more than 1% of the diagonal of the box round them); it is kept as the locator in words. The example names the region and the map.",
  'annotation-region-crosses-map-edge': "A region whose centre is inside the georeferenced part of its image, but which reaches beyond it (into a margin, a title or an inset), is placed at its centre; its radius holds the whole region, the part outside the map included, where the georeference is stretched beyond its evidence. The example names the region and the map.",
  'annotation-region-ambiguous': 'A region inside more than one georeferenced map on the same image is not placed, since the maps would place it differently; the example names the maps. It is kept as the locator in words.',
  'annotation-region-not-iiif': 'A region on a Recogito v1 document (recogito.pelagios.org) is not on a IIIF image, so no georeference can be for it, and it is not placed; it is kept as the locator in words.',
  'annotation-region-unplaced': 'A region could not be placed through its georeference (a shape that cannot be transformed, such as a curve, or a position the georeference cannot give); the example gives the reason. It is kept as the locator in words, and the rest of the file was converted. Where the reason is "an unexpected error", that is a fault in these tools: please report it.',
  'annotation-region-image-url': 'A region drawn on a picture of the image (a IIIF picture address, such as …/full/max/0/default.jpg) rather than on its canvas or image service is placed as though the picture\'s pixels were the image\'s, which holds only for the whole image, unrotated, at full size. Where the size is "max" the server may give a smaller picture, and the example says that full size was assumed.',
  'annotation-region-no-label-evidence': 'A region placed on a georeferenced map is given no role, because nothing in the annotation says it marks the map\'s label for the place: it has no transcription, no quoted name and no tag "label". Its centre is still carried, with a note saying so. To mark a region as a label, tag it "label". (A region tagged "symbol" is not reported here: it is a representative point.)',
  'annotation-georef-unreadable': 'A georeference or IIIF manifest given with the annotations could not be read, so it is not used; the example gives the file and the reason. The regions it would have placed are reported as having no georeference, and the rest of the file was converted.',
  'annotation-georef-unused': 'A georeference given with the annotations placed no region: no region in the file is inside its map. The example names it.',
  'annotation-georef-duplicate': "The same map's georeference was given twice (by its annotation's address: a single annotation and a page holding it, say, or one file given twice), so it is used once, rather than making every region on the map ambiguous between it and itself. Of two versions of it, the later modified is used. The example names the map and both files.",
  'annotation-manifest-matched-by-image': "A georeference names a manifest that was not given, but a IIIF manifest given shows the georeferenced image, so it is used as the map's manifest (its id may be the same address written another way, such as http for https). The record names the manifest given. The example gives both ids.",
  'annotation-manifest-mismatch': "A IIIF manifest given has the id that a georeference names, but none of its canvases shows the georeferenced image, so it does not describe this map, and is not used for it: the map is placed without it. Check that the right manifest was given. The example names the manifest and the map.",
  'annotation-manifest-unused': 'A IIIF manifest given with the annotations belongs to none of the georeferences given, so it is not used. The example names it.',
  // TEI XML (src/engine/hermes/tei.js): what an edition's place names hold that is not carried.
  'tei-place-no-ref': 'A place name in the text with no ref points to no place, so it has nothing for an attestation to be about and is not converted; the example gives the words, and its key where it has one. Give it a ref to a gazetteer to keep it.',
  'tei-place-in-record': 'A place name in a description of a person, an organisation, an event or a book (such as a birthplace in a listPerson) describes that person, organisation, event or book, not a passage of the text that names the place, so it is not converted. The example gives where it stands, the words and the ref.',
  'tei-place-empty': 'A place name in the text with a ref but no words (such as <placeName ref="…"/>) gives no name for an attestation to attest, so it is not converted. The example gives the element, its ref and its line.',
  'tei-place-ethnic': 'A place name of the type "ethnic" (such as Σελινόντιοι, the people of Selinous) names a people, not a place, so it is not converted as a name of the place. The example gives the words, the ref and the line.',
  'tei-place-outside-text': "A place name outside the text (in the teiHeader, such as where an inscription was found, or in a standOff or facsimile) is the edition's description of the document, not a name the text attests, so it is not converted. The example says where it is, the words and the ref.",
  'tei-ref-prefix': 'A ref written with a prefix (such as pl:579885) that the header does not expand to a web address, with a prefixDef whose pattern matches it, cannot say what place is meant, so it is not converted. Add a prefixDef to the header, or write the full web address.',
  'tei-ref-local': 'A ref that points within the file (such as #athens) is converted only where it points to a place in a list of places in the same file that gives one web address for the place (an idno). This one points to no such place, or to a place with no web address, so it is not converted.',
  'tei-ref-ambiguous': 'A ref points to a place in a list of places that gives several different web addresses, so which place is meant cannot be told, and nothing is converted from it. The example lists the addresses: keep one, or point the ref at the address you mean.',
  'tei-ref-relative': 'A ref that points into another file (such as places.xml#athens), or is only a word, cannot be followed from here, so it is not converted. Write the place\'s web address in the ref.',
  'tei-ref-not-web': 'A ref that is an address but not a web address (such as a urn:), or a prefix that expands to one, cannot say what place is meant in PLATO, which identifies places by web address, so it is not converted.',
  'tei-listplace-names': "The names a list of places gives for a place are not converted: they are the edition's description of the place, not a passage of the text that names it. A place name in the text that points to the place is converted, with the words it uses.",
  'tei-listplace-geo': "The location a list of places gives for a place (its coordinates) is not converted: it is the edition's description of the place, not evidence from the text, and the place's web address leads to the gazetteer's.",
  'tei-lang-not-tag': 'A language (xml:lang) that is not a language tag (such as grc or en) cannot be carried, so the name is converted without a language.',
  'tei-licence-not-address': "The edition's licence is given only in words, with no web address (a licence's target), so the source is converted without a licence. The example gives the words.",
  'tei-sourcedesc-several': "The header names several originals the edition was made from; only the first is carried, as the source the edition is derived from. The example gives one that is not carried.",
  'tei-ref-several': 'A place name whose ref gives several web addresses becomes one attestation for each, with a note naming the others. Where the addresses are the same place in two gazetteers, that the two are the same is not carried: PLATO says so with an identity match, not with a place name.',
  'tei-source-no-address': "The edition has no web address in its header (an idno of type URI or DOI in the publicationStmt), so its source is known only by its title. Give the edition's address in the header, so that the attestations can be traced to it.",
  'tei-none-linked': 'No place name in the text of this file has a ref that points to a place, so there is nothing to convert.',
  'tei-whg-record': "A World Historical Gazetteer address of the form /places/<number>/portal with a number below 12,345,678 names one of WHG's database records in the place of a place cluster, and WHG answers it with the wrong place or an error, so the place name is not converted with it. Give the place's address in the form https://w3id.org/whg/id/place:… instead.",
  'tei-whg-staging': "An address on dev.whgazetteer.org is WHG's staging copy, which has its own records and changes without notice, so the place name is not converted with it. Use the place's address on whgazetteer.org instead.",
  'tei-attribute': 'An attribute of a place name that PLATO has no place for (such as cert, type or resp) is not carried; the example gives the element, the attribute and its value. TEI\'s cert does not say what it is certain of (the reading, or which place is meant), so it is not taken for the certainty of the attestation.',
  'tei-place-content': 'A part of a place in a list of places that PLATO has no place for (a description, a note, an idno that is not a web address) is not carried; the example names the place and the part.',
  'tei-variant': "A place name in a variant reading (an rdg in an app), or in the part of a choice that is not taken (an orig, abbr or sic beside a reg, expan or corr), is not converted: the edition's text at that point is the lemma or the edited form, and a variant is not what the text says. Where the part taken names the same place, the form not taken is kept as the name's form in the source (its sourceLabel), and is not reported. The example gives the part, the words, the element and its line.",
  'tei-place-editorial': "A place name in the editors' own part of an edition that has a div of type \"edition\" (in its commentary, translation, apparatus or bibliography, or in a note anywhere) is in the editors' words, not the source's, so it is not converted. The example gives the part, the words, the ref and the line. Converting it, marked as the editors' words (Reading options, or --commentary-places), is available once PLATO's Editorial form status is pinned.",
  'not-in-rdf': 'The PLATO RDF model has no property for this key, so its values are dropped in RDF.',
  'unmapped-predicate': 'A predicate that has no place in PLATO JSON is dropped.',
  'unmapped-type': 'A class that has no place in PLATO JSON is dropped.',
};
// A place's address, in any reader that passes it through src/engine/hermes/addresses.js (Recogito's
// annotations, TEI, and tables of places). The severity is each reader's kinds map's.
Object.assign(LOSS_TEXT, {
  'address-pleiades-part': "A Pleiades address that names part of a place's record (a location, a name, or a format such as /json), not the place itself, is carried as it is, not changed to the place's address. Check that it is the place you mean. An address ending #this is not a part: it is the place in Pleiades' own data, written differently from its plain address, and it too is carried as it is.",
});
// A table of places, CSV or plain GeoJSON (src/engine/hermes/columns.js, generic.js): what a row holds
// that is not carried, and what is carried but worth a look. The severity of each is GENERIC_KINDS's.
Object.assign(LOSS_TEXT, {
  'generic-column-skipped': 'A column marked "skip" in the matching of columns is not carried over. The example names the column; match it to a field, or to "note" to keep it in the notes.',
  'generic-coordinate-missing': 'A row gives a latitude with no longitude, or a longitude with no latitude, so it has no location; the rest of the row is carried.',
  'generic-coordinate-not-number': 'A latitude or longitude is not a number in decimal degrees (such as 51.75 or -1.25), so the row has no location; the rest of the row is carried. Degrees, minutes and seconds must be converted first.',
  'generic-coordinate-range': 'A latitude outside -90 to 90, or a longitude outside -180 to 180, is not a place on the earth (the two may be the wrong way round, or the coordinates not in degrees), so the row has no location from it; the rest of the row is carried. In a geometry, one such position is enough for the whole geometry to be left out; the example says which.',
  'generic-geometry-collection': "A feature's geometry is a GeometryCollection, which PLATO does not accept, so it is not carried; the rest of the feature is. Give each of its geometries as a feature of its own.",
  'generic-geometry-invalid': 'A geometry that is not a GeoJSON Point, LineString, Polygon or one of their Multi forms with well-formed coordinates is not carried; the rest of the row is. Each position must be two or three numbers, a line must have at least two positions, and each ring of a polygon at least four, ending where it begins. The example says what is wrong.',
  'generic-date-invalid': 'A start or end date that is not a year (such as 1066 or -0500) or an ISO date (such as 1066-10-14) is not carried; the example names the column. Match the column to "date" instead to keep it as the date the source writes.',
  'generic-language-invalid': 'A language that is not a language code (such as en, la or grc) is not carried, so the name has no language.',
  'generic-wkt-invalid': 'A cell read as Well-Known Text (WKT) is not WKT of a shape PLATO takes (a POINT, LINESTRING, POLYGON or one of their MULTI forms, longitude first), so it is not carried; the rest of the row is. The example says what is wrong.',
  'generic-features-not-list': "The FeatureCollection's features are not a list, so no feature can be read from them. The example says what they are instead.",
  'generic-nothing-converted': "Not one row became a place or an attestation, so nothing was converted. Check which column holds what (on the page, or with --columns): a row needs a name, or a web address in the column of places' addresses.",
  'generic-empty': 'The file holds no rows, or no features, so there is nothing in it to check or convert.',
  'generic-row-empty': "A row with neither a name nor a web address in the column of places' addresses is not carried: with no address it is about no place, and with no name it cannot be a place of its own. Give it the address of its place in a gazetteer, or a name.",
  'generic-row-no-name': 'A row with no name (in the column of names or of other names) is not carried, even with an id, as a place needs a name for its label. Give it a name.',
  'generic-no-address': "A row with no web address in the column of places' addresses, and no id to make it a place of its own, has no place to be about, so it is not carried, though it has a name. Give it the address of its place in a gazetteer, or an id.",
  'generic-address-not-web': "A value in the column of places' addresses is not a web address (http or https), and the row has no id to make it a place of its own, so it has no place to be about and is not carried. A bare number, or whg: followed by one, is not taken for an address.",
  'generic-whg-record': "A World Historical Gazetteer address of the form /places/<number>/portal with a number below 12,345,678 names one of WHG's database records in the place of a place cluster, and WHG answers it with the wrong place or an error, so the address is not carried. The row is read without it: with an id it becomes a place of its own, and otherwise it is not carried. Give the place's address in the form https://w3id.org/whg/id/place:….",
  'generic-whg-staging': "An address on dev.whgazetteer.org is WHG's staging copy, which has its own records and changes without notice, so the address is not carried. The row is read without it: with an id it becomes a place of its own, and otherwise it is not carried. Give the place's address on whgazetteer.org instead.",
  'generic-feature-key': 'A member of a GeoJSON feature besides its type, id, geometry and properties (a bbox, or one of the file\'s own) is not carried; the example names it.',
  'generic-not-feature': 'An item in the FeatureCollection that is not a GeoJSON Feature is not carried.',
  'generic-csv-extra-cells': 'A row has more cells than the header has columns; the cells with no column are not carried. The example gives them.',
  'generic-csv-row': 'A row of the CSV file has fewer cells than the header has columns, so it may have been read wrongly; it is read as far as it goes. Check it.',
  'generic-csv-duplicate-header': 'More than one column has the same heading, so each is known by its heading and its place (such as "name (column 3)") in the matching of columns and in the notes. The example gives the heading and the columns. Give each column a heading of its own to be sure which is which.',
  'generic-no-ids': 'No column is matched as the places\' id, so the places have no web address, and cannot be published or linked to until they have one. Add a column of ids that will not change (one for each place), or match an existing column as the id.',
  'generic-id-empty': 'A row has no id in the id column, so its place has no web address, and cannot be published or linked to until it has one.',
  'generic-stand-in-base': 'The web addresses of the places are made from their ids under a stand-in base address, and so are not permanent: give a base address you control (--base, or the field on the page).',
  'generic-mapping-missing-column': 'The matching of columns given does not name this column, so it is kept in the notes. The example names the column.',
  'generic-mapping-unknown-column': 'The matching of columns given names a column this file does not have, so that part of it is not used. The example names the column.',
  'generic-mapping': 'Part of the matching of columns given cannot be used (a field that does not exist, or a second column for a field that takes one), so that column is kept in the notes.',
});

// ---- a key a format has no place for, in words ------------------------------------------------------
// The writers report such a key as 'where.key' (src/formats/shared.js, dropKeys); these are the words
// for each. A key with no entry here (one PLATO adds later) is still reported, by its name.
const KEY_WORDS = {
  'gazetteer.@id': "the gazetteer's own web address",
  'gazetteer.title': "the gazetteer's title",
  'gazetteer.description': "the gazetteer's description",
  'gazetteer.contributor': 'who made the gazetteer (its contributor)',
  'gazetteer.licence': "the gazetteer's licence",
  'gazetteer.creator': "the gazetteer's authors, by whom it is cited (creator)",
  'gazetteer.keywords': 'the words a catalogue finds the gazetteer by (keywords)',
  'gazetteer.spatial': 'the area the gazetteer covers (spatial)',
  'gazetteer.temporal': 'the years the gazetteer covers (temporal)',
  'gazetteer.landingPage': 'the web page where the gazetteer is found and downloaded (landingPage)',
  'gazetteer.uriSpace': "the base of the addresses of the gazetteer's places and sources (uriSpace)",
  'gazetteer.isVersionOf': 'the gazetteer this one is a version of (isVersionOf)',
  'gazetteer.previousVersion': "the gazetteer's previous version (previousVersion)",
  'gazetteer.candidateSets': 'the candidate sets that suggest matches for the gazetteer\'s places (candidateSets): suggestions made by software, which are claims by no one, published apart from the dataset',
  'source.licence': "a source's licence",
  'spatialEntity.@id': "a place's web address",
  'spatialEntity.entityIdentifier': "a place's own identifier in its project (entityIdentifier)",
  'spatialEntity.namespace': "the namespace of a place's own identifier",
  'attestation.@id': "an attestation's web address, by which a later comment, retraction or supersession can point at it",
  'attestation.certaintyNote': 'the note on how certain an attestation is (certaintyNote)',
  'attestation.sequence': "an attestation's place in a sequence, such as a stop on a route (sequence)",
  'relation.relatedLabel': 'the name of something a place is related to that is not itself a place, such as a person (relatedLabel)',
  'attestation.notes': 'the notes on an attestation',
  'attestation.timespanRole': 'what an attestation\'s dates are dates of (timespanRole: the span of the evidence that mentions the place, rather than when what it records held)',
  'attestation.sourceStance': 'how firmly the source itself says it (its stance: reported, tentative or doubted), so the claim reads as if the source simply asserted it',
  'attestation.contributor': 'who made an attestation (its contributor)',
  'attestation.created': 'when an attestation was made (created)',
  'attestation.modified': 'when an attestation was last changed (modified)',
  'attestation.formStatus': 'the form status of a name (headword, normalised…) on an attestation with no name, or one not in PLATO\'s vocabulary',
  'attestation.occurrenceContext': 'the occurrence context of a name (in a personal name…) on an attestation with no name, or one not in PLATO\'s vocabulary',
  'attestation.occurrenceCount': 'the number of occurrences of a name, on an attestation with no name',
  'name.@id': "a name's web address",
  'name.script': 'the script a name is written in (script)',
  'name.nameType': 'what a name denotes (nameType: toponym, hydronym…)',
  'name.romanized': 'the romanised form of a name',
  'name.transliterationSystem': 'the system a name was romanised by (transliterationSystem)',
  'name.ipa': 'the pronunciation of a name in the International Phonetic Alphabet (ipa)',
  'name.nameEmbedding': "a name's vector embedding (nameEmbedding)",
  'geometry.@id': "a location's web address",
  'geometry.reprPoint': "a location's representative point, beside its shape (reprPoint)",
  'geometry.geojson': "a location's GeoJSON point, where it differs from its representative point",
  'geometry.role': "what a location depicts (role), where it is not one of PLATO's own",
  'geometry.bbox': "a location's bounding box (bbox)",
  'geometry.hull': "a location's convex hull (hull)",
  'geometry.spatialPrecision': 'how precisely a location is known, in words (spatialPrecision)',
  'geometry.precisionKm': "a location's uncertainty radius beyond the first (precisionKm)",
  'geometry.sourceCrs': 'the coordinate reference system a location was given in (sourceCrs)',
  'timespan.@id': "a timespan's web address",
  'timespan.startPrecision': 'how precise the start of a date is (startPrecision)',
  'timespan.endPrecision': 'how precise the end of a date is (endPrecision)',
  'timespan.precisionValue': "a date's precision in years (precisionValue)",
  'timespan.openStart': 'that a date deliberately has no start (openStart)',
  'timespan.openEnd': 'that a date deliberately has no end (openEnd)',
  'timespan.duration': 'how long something lasted, such as a stay on a journey (duration)',
  'timespan.periodoUri': "a date's PeriodO period (periodoUri)",
  'timespan.edtfString': 'a date in Extended Date/Time Format (edtfString)',
  'timespan.label': "a period's name, beside the date as the source wrote it",
  'timespan.sourceLabel': 'a date as the source wrote it, with no years to place it',
  'timespan.certaintyLevel': 'how certain a date is, where an attestation has several dates of differing certainty',
  'type.@id': "a type's web address",
  'type.scheme': 'the vocabulary a type comes from (scheme)',
  'type.schemeVersion': 'the version of the vocabulary a type comes from (schemeVersion)',
  'attestation.identities': 'the identity matches an attestation makes together (identities)',
  'type.sourceLabel': 'a type as the source words it, beside its label (sourceLabel)',
  'propertyValue.@id': "a property value's web address",
  'propertyValue.label': "a property's label",
  'propertyValue.sourceLabel': 'a property value as the source words it (sourceLabel)',
  'propertyValue.datatype': 'the datatype of a property value',
  'propertyValue.unit': 'the unit of a property value',
  'propertyValue.valueType': 'the shape of a structured property value (valueType)',
  'source.@id': "a source's web address",
  'source.uri': "a source's resolvable address, beside its identifier (uri)",
  'source.citation': "a source's bibliographic citation",
  'source.authorityType': 'that a cited authority is a dataset, period or other kind rather than a source (authorityType)',
  'source.timespan': "part of a source's date that a citation's one year cannot give",
  'citation.@id': "a citation's web address",
  'citation.attributionStatus': "how a source's attribution was made (attributionStatus), where it is not one of PLATO's own",
  'identityRelation.@id': "an identity match's web address",
  'identityRelation.assertedBy': 'who made an identity match (assertedBy)',
  'identityRelation.assertedAt': 'when an identity match was made (assertedAt)',
  'identityRelation.source': 'the source of an identity match',
  'identityRelation.promotedFrom': 'the candidate an identity match or a denial answers (promotedFrom)',
};
const OBJECT_WORDS = { gazetteer: 'the gazetteer', spatialEntity: 'a place', attestation: 'an attestation', name: 'a name', geometry: 'a location', timespan: 'a date', type: 'a type', propertyValue: 'a property value', source: 'a source', citation: 'a citation', identityRelation: 'an identity match', relation: 'a relation' };
/** Words for a dropped key: "The notes on an attestation: Linked Places Format has no place for this, so it is left out." */
export function droppedText(key, format) {
  const [where, ...rest] = key.split('.');
  const words = KEY_WORDS[key] || (where === 'source' && rest[0] === 'timespan' ? KEY_WORDS['source.timespan'] + ` (${rest.slice(1).join('.')})` : `the key "${rest.join('.')}" of ${OBJECT_WORDS[where] || where}`);
  return `${words[0].toUpperCase()}${words.slice(1)}: ${format[0].toUpperCase()}${format.slice(1)} no place for this, so it is left out.`;
}
// Each format with its verb, so that "the spreadsheet tables have" agrees.
export const FORMAT_WORDS = { lpf: 'Linked Places Format has', 'lpf-seq': 'Linked Places Format has', tables: 'the spreadsheet tables have', ntriples: 'RDF has', 'plato-json': 'PLATO JSON has', 'plato-jsonl': 'PLATO JSON has' };

// What reading a workbook reports (pipeline.js, workbookSheetCsv).
export const WORKBOOK_TEXT = {
  'workbook-date-time': "A date in a column that takes a date alone (such as from and to) has a time of day in the workbook: the date is kept and the time dropped. A time of day can mean that a time zone moved the date to the day before or after, so check each date named.",
};
/** One date of 'workbook-date-time': where it is, what the workbook holds, and what it was read as. */
export const dateTimeWords = (sheet, row, column, given, date) => `${sheet} row ${row}, ${column}: ${given} was read as the date ${date}; check the date.`;
