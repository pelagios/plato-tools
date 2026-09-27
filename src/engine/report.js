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
  'bundled-attestation': 'Attestations that bundle several kinds of fact are split into one row or element per fact; that they came from one attestation is lost.',
  'extra-sources': 'Only the first source of an attestation fits; the others are dropped.',
  'extra-timespans': 'Only the first date of an attestation fits; the others are dropped.',
  'four-date-bounds': 'Only the earliest start and latest end fit; the latest start and earliest end are dropped.',
  'attestation-without-source': 'An attestation has no source; the tables require one, so it is given the source "No source given".',
  'attestation-without-facet': 'An attestation with no name, location, type, relation or property has no row to go in and is dropped.',
  'meta-attestation': 'Comments on other attestations (contradicts, supports…) have no place here and are dropped.',
  qualification: 'Fuzziness, relative positions and per-value certainty have no place here and are dropped.',
  'point-derived-from-shape': 'A shape without a point is given the centre of its bounding box as latitude and longitude.',
  'geometry-without-coordinates': 'A geometry with neither coordinates nor a shape is dropped.',
  'relation-type-not-in-plato': 'A relation whose type is not in PLATO\'s vocabulary cannot go in the tables and is dropped.',
  'relation-label': 'Relation labels are dropped.',
  'identity-provenance': 'Who asserted an identity match, and the candidate it came from, are dropped.',
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
