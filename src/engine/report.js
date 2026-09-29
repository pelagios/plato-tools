// Collects problems and losses without letting them grow with the data: each kind keeps a count
// and a handful of examples, however many times it occurs.
export class Report {
  constructor({ examples = 5 } = {}) { this.examples = examples; this.kinds = new Map(); this.counts = {}; }
  add(severity, kind, message, example) {
    const key = severity + '\u0001' + kind + '\u0001' + message;
    let k = this.kinds.get(key);
    if (!k) { k = { severity, kind, message, count: 0, examples: [] }; this.kinds.set(key, k); }
    k.count++;
    if (example !== undefined && k.examples.length < this.examples) k.examples.push(example);
  }
  error(kind, message, example) { this.add('error', kind, message, example); }
  warning(kind, message, example) { this.add('warning', kind, message, example); }
  loss(kind, message, example) { this.add('loss', kind, message, example); }
  count(name, n = 1) { this.counts[name] = (this.counts[name] || 0) + n; }
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
  'gazetteer-version': "The gazetteer's version and status (version, status, isVersionOf, previousVersion) have no place here and are dropped, so this file does not say which state of the gazetteer it holds.",
  'figure-literal': 'A coordinate or attribute of a statistical figure whose datatype PLATO JSON cannot carry (a year typed xsd:gYear, a language tag) keeps its text; the datatype is dropped.',
  'figure-blank-value': 'A coordinate or attribute of a statistical figure that is a node with no web address cannot be written in PLATO JSON, which needs a code or a literal, and is dropped.',
  'component-address': "The web address of a component of a table's structure has no place in PLATO JSON and is dropped; the component itself is kept.",
  'statistical-figure': 'A figure from a statistical table cannot go here: without its coordinates it would be stated of the place as a whole (a county does not have "persons: 280", its male agricultural labourers do), so it is left out.',
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
  computed: "A value worked out by software rather than taken from a source (computed), such as an itinerary's span from its stops, is left out: it is not evidence, and written here it would read as a source's statement.",
  'source-label': 'A value as the source wrote it (a name, location or type, before it was normalised) has no column or field here, so it is dropped; the normalised value is kept.',
  'period-label': 'A timespan with both a period name and the date as written keeps only the date as written.',
  'certainty-level': 'A certainty level that cannot be expressed here (not one of Certain, LessCertain, Uncertain, or on a kind of fact that has no certainty) is dropped.',
  'identity-provenance': 'Who made an identity match, and the candidate it came from, have no place here and are dropped.',
  'place-address': "A place's web address is not kept: its place_id is only the last part of it, and reading the tables back makes a new address from the base address you choose.",
  'source-address': "A source's web address is not kept: its source_id is only the last part of it, and reading the tables back makes a new address from the base address you choose.",
  'lpf-undated': "A date with no years (a date as the source wrote it, or a period's name, alone) cannot be an LPF when, which needs a timespan, so it is dropped.",
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
  'lpf-description-language': 'The language of LPF descriptions is dropped.',
  'lpf-depiction-licence': 'The licence of LPF depictions is dropped.',
  'lpf-link-type': 'An LPF link type PLATO does not know is dropped.',
  'not-in-rdf': 'The PLATO RDF model has no property for this key, so its values are dropped in RDF.',
  'unmapped-predicate': 'A predicate that has no place in PLATO JSON is dropped.',
  'unmapped-type': 'A class that has no place in PLATO JSON is dropped.',
};

// ---- a key a format has no place for, in words ------------------------------------------------------
// The writers report such a key as 'where.key' (src/formats/shared.js, dropKeys); these are the words
// for each. A key with no entry here (one PLATO adds later) is still reported, by its name.
const KEY_WORDS = {
  'gazetteer.@id': "the gazetteer's own web address",
  'gazetteer.title': "the gazetteer's title",
  'gazetteer.description': "the gazetteer's description",
  'gazetteer.contributor': 'who made the gazetteer (its contributor)',
  'gazetteer.licence': "the gazetteer's licence",
  'source.licence': "a source's licence",
  'spatialEntity.@id': "a place's web address",
  'spatialEntity.entityIdentifier': "a place's own identifier in its project (entityIdentifier)",
  'spatialEntity.namespace': "the namespace of a place's own identifier",
  'attestation.@id': "an attestation's web address, by which a later comment, retraction or supersession can point at it",
  'attestation.certaintyNote': 'the note on how certain an attestation is (certaintyNote)',
  'attestation.sequence': "an attestation's place in a sequence, such as a stop on a route (sequence)",
  'relation.relatedLabel': 'the name of something a place is related to that is not itself a place, such as a person (relatedLabel)',
  'attestation.notes': 'the notes on an attestation',
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
  'timespan.periodoUri': "a date's PeriodO period (periodoUri)",
  'timespan.edtfString': 'a date in Extended Date/Time Format (edtfString)',
  'timespan.label': "a period's name, beside the date as the source wrote it",
  'timespan.sourceLabel': 'a date as the source wrote it, with no years to place it',
  'timespan.certaintyLevel': 'how certain a date is, where an attestation has several dates of differing certainty',
  'type.@id': "a type's web address",
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
  'identityRelation.promotedFrom': 'the candidate an identity match was promoted from (promotedFrom)',
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
