// What the tools say about a run, in the browser (src/app.js) and in the terminal (bin/), so that
// both give the same messages in the same words.
export function fmtBytes(n) { return n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' bytes'; }
export function fmtTime(ms) { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; }
export const FORMAT_NAMES = { tables: 'PLATO spreadsheet tables', 'plato-json': 'a PLATO JSON document', 'plato-jsonl': 'PLATO JSON Lines', ntriples: 'RDF (N-Triples)', nquads: 'RDF (N-Quads)', turtle: 'RDF (Turtle)', lpf: 'a Linked Places Format FeatureCollection', 'lpf-seq': 'a Linked Places Format sequence', 'w3c-annotations': 'W3C Web Annotations (as Recogito exports them)' };
FORMAT_NAMES.tei = 'a TEI XML edition';
FORMAT_NAMES.csv = 'a table of places (CSV), its columns matched to PLATO';
FORMAT_NAMES.geojson = 'plain GeoJSON (not Linked Places Format), its properties matched to PLATO';
/** What a detected input is, in words: "PLATO JSON Lines (place-centric)". */
export const formatName = (input) => FORMAT_NAMES[input.format] + (input.profile ? ` (${input.profile})` : '') + (input.lpfVersion === 2 ? ', version 2' : '');

// A count in words, singular for one: "1 place", "2 places", "1 identity relation".
const ONE = { 'earlier attestations': 'earlier attestation', annotations: 'annotation', places: 'place', attestations: 'attestation', 'identity relations': 'identity relation', triples: 'triple', 'triples written': 'triple written', 'table rows': 'table row', observations: 'Data Cube observation' };
const MANY = { observations: 'Data Cube observations' };
ONE['place names'] = 'place name';
ONE.rows = 'row'; ONE.features = 'feature';
const count = (n, what) => `${n.toLocaleString('en-GB')} ${n === 1 ? ONE[what] || what : MANY[what] || what}`;

/**
 * What the page and the command line add to a PLATO pin that is not the head of PLATO's main branch
 * (`npm run vendor -- --ref NAME`): a draft, which must never pass for a release. Empty otherwise.
 */
export const draftNote = (v) => (v?.draft ? `DRAFT: PLATO's ${v.ref} branch, not a release` : '');

/** A progress event in words: "Loading into the working database: 1,000 triples (3 s)". */
export function progressText(p) {
  const bits = [];
  if (p.triples) bits.push(count(p.triples, 'triples'));
  if (p.places) bits.push(count(p.places, 'places'));
  if (p.attestations) bits.push(count(p.attestations, 'attestations'));
  const phase = { reading: 'Reading', loading: 'Loading into the working database', indexing: 'Indexing', writing: 'Writing', done: 'Finishing', read: 'Read', comparing: 'Comparing the two versions' }[p.phase] || KRISIS_PHASES[p.phase] || p.phase;
  // The version check reads two inputs, one after the other, and says which it is on.
  const which = p.version ? `${p.version === 'earlier' ? 'Earlier' : 'Later'} version${p.again ? ', again, to see what changed' : ''}: ` : p.dataset ? `${KRISIS_DATASETS[p.dataset]}: ` : '';
  return `${which}${phase}${bits.length ? ': ' + bits.join(', ') : ''} (${fmtTime(p.elapsedMs || 0)})`;
}

/**
 * The two halves of a report's summary: "2 problems found." and "Read 3 places, 5 attestations."
 * A comparison of two versions (`action` 'compare') counts other things, in other words.
 */
export function summary(report, action) {
  const c = report.counts;
  if (action === 'compare') return compareSummary(report);
  if (action === 'publish') return publishSummary(report);
  if (action === 'match') return matchSummary(report);
  if (action === 'apply') return applySummary(report);
  const counted = ['annotations', 'place names', 'rows', 'features', 'places', 'attestations', 'identity relations', 'triples', 'triples written', 'table rows', 'observations'].filter((k) => c[k]).map((k) => count(c[k], k)).join(', ');
  const nErr = report.errors;
  return {
    problems: nErr ? `${nErr.toLocaleString('en-GB')} problem${nErr === 1 ? '' : 's'} found.` : 'No problems found.',
    counted: counted ? `Read ${counted}.` : '',
  };
}

/** What changed in one example of a version check, a line for each statement only one version makes. */
export function explainedLines(x) {
  return [...x.earlier.map((t) => `Only in the earlier version: ${t}`), ...x.later.map((t) => `Only in the later version: ${t}`)];
}

/** The summary of a version check: whether the append-only rule holds, and what became of the earlier attestations. */
function compareSummary(report) {
  const c = report.counts, n = (x) => (x || 0).toLocaleString('en-GB');
  if (c.earlier === undefined) return { problems: 'The two versions could not be compared.', counted: '' };
  const parts = [`${n(c.unchanged)} unchanged`];
  if (c.changed) parts.push(`${n(c.changed)} changed`);
  if (c.lost) parts.push(`${n(c.lost)} no longer there`);
  const withdrawn = [c.retracted ? `retracts ${n(c.retracted)}` : '', c.superseded ? `replaces ${n(c.superseded)}` : ''].filter(Boolean).join(' and ');
  const nErr = report.errors;
  return {
    problems: nErr ? `${n(nErr)} problem${nErr === 1 ? '' : 's'} found.`
      : c.unchanged === c.earlier ? 'Nothing was deleted or changed.' : 'The append-only rule is not broken, but see the warnings.',
    counted: `Of ${count(c.earlier, 'earlier attestations')}, ${parts.join(', ')}. The later version has ${count(c.later, 'attestations')}, ${n(c.added)} of them new${withdrawn ? `; it ${withdrawn} of the earlier ones` : ''}.`,
  };
}

/**
 * The summary of a part of publishing (Agora): whether anything stops publication, and what the
 * part counted. Each part counts in its own words (report.counts.said, a list of short phrases).
 */
function publishSummary(report) {
  const nErr = report.errors, said = report.counts.said || [];
  return {
    problems: nErr ? `${nErr.toLocaleString('en-GB')} problem${nErr === 1 ? '' : 's'} to fix before publishing.` : 'Nothing stops publication.',
    counted: said.length ? said.join(' ') : '',
  };
}

/** The report's groups, in order, with a title and a line saying what each means, for `action` 'check', 'convert' or 'compare'. */
export function groups(action) {
  const checking = action === 'check';
  if (action === 'publish') return [
    { severity: 'error', title: 'Problems', intro: 'These stop the dataset being published as it is.' },
    { severity: 'warning', title: 'Warnings', intro: 'Worth fixing: the dataset can be published, but is harder to find, cite or reuse.' },
  ];
  if (action === 'match' || action === 'apply') return krisisGroups(action);
  if (action === 'compare') return [
    { severity: 'error', title: 'Problems', intro: 'These break the append-only rule: once a dataset is published, its attestations are added to, never deleted or changed.' },
    { severity: 'warning', title: 'Warnings', intro: 'Worth a look; none of these breaks the rule.' },
  ];
  return [
    { severity: 'error', title: 'Problems', intro: 'These must be fixed for the data to be valid PLATO.' },
    { severity: 'warning', title: 'Warnings', intro: 'Worth a look; the data can still be used.' },
    { severity: 'loss', title: checking ? 'Would not be carried over' : 'Not carried over',
      intro: checking ? 'PLATO JSON has no place for these, so a conversion to it would leave them out.' : 'The target format has no place for these, so they are left out.' },
  ];
}

// ---- Hermes: matching the columns of a table of places (a CSV file, or plain GeoJSON) to PLATO ----
// The page shows the guess (src/engine/hermes/columns.js, guessColumns) as a table, one choice for
// each column, before anything is checked or converted. The fields are named in plain words here;
// the JSON saved and loaded keeps the engine's own names (the format --columns takes).
/** Each choice a column can be given, in the order the page offers them. `properties` is never one. */
export const COLUMN_CHOICES = {
  name: 'Name', alternativeNames: 'Alternative names', latitude: 'Latitude', longitude: 'Longitude',
  wkt: 'Point or shape, as WKT text', geometry: 'Point or shape, as GeoJSON', id: 'Place id', address: "Place's web address",
  type: 'Kind of place', language: 'Language of the name', source: 'Source', date: 'Date, as the source writes it',
  start: 'Earliest date', end: 'Latest date', note: 'Keep as a note', skip: "Don't carry over",
};
export const COLUMN_WORDS = {
  heading: 'Which column holds what',
  intro: (geojson) => `These are guesses, made from the ${geojson ? 'names of the properties' : 'column headings'} and the first rows. Check each one and change any that is wrong before you check or convert the file. A column kept as a note is carried over as “column: value” in the notes; one you choose not to carry over is named in the report.`,
  caption: (file, geojson) => `The ${geojson ? 'properties' : 'columns'} of ${file}, three examples of each, and what each will be read as`,
  column: 'Column', examples: 'Examples from the file', readAs: 'Read as', why: 'Why',
  selectLabel: (col) => `Read the column “${col}” as`,
  noExamples: 'empty in the first rows',
  youChose: 'your choice',
  saved: 'as the saved matching says',
  movedTo: (field, col) => `kept as a note, as ${field} is now the column “${col}”, and only one column can be`,
  looking: 'Reading the columns…',
  save: 'Save this matching', load: 'Use a saved matching…', loadLabel: 'A saved matching',
  saveNote: 'Saved as JSON, the file can be used again here, or given to the command line with --columns.',
  base: 'Each place id becomes a web address under the web address given in Options.',
  loaded: (name) => `Using the matching saved in ${name}.`,
  notJson: (name) => `${name} cannot be used: it is not a saved matching (a JSON object of column names, each with what it is read as, in UTF-8).`,
  missing: (col) => `The saved matching does not mention the column “${col}”, so it is kept as a note.`,
  unknown: (col) => `The saved matching mentions a column this file does not have, “${col}”; that part of it is not used.`,
  unusable: (example) => `Part of the saved matching cannot be used, so that column is kept as a note: ${example}.`,
  cannotRead: (message) => `The columns could not be read: ${message}`,
  noIds: 'These places will have no web addresses: they can be checked and converted, but not published or linked until they have ids. Choose a column as the place id, or add one.',
  latOnly: 'A column is read as latitude but none as longitude, so no place will have a location from them. Choose the longitude column too, or keep the latitude as a note.',
  lonOnly: 'A column is read as longitude but none as latitude, so no place will have a location from them. Choose the latitude column too, or keep the longitude as a note.',
  gazetteerNotAddress: (col, cli) => `The column “${col}” is named for a gazetteer or a web address, but no column is read as the place's web address, so no row will be linked to a gazetteer's place: each is read as a new place. If “${col}” holds the places' addresses, ${cli ? 'map it to "address" in the mapping given with --columns' : 'choose “Place\'s web address” for it'}.`,
};
/**
 * The warnings a matching deserves before it is used, in words: a column named for a gazetteer
 * (`gazetteer`, columns.js's gazetteerColumns) when no column is the address, no ids or addresses,
 * half a coordinate pair.
 */
export function columnWarnings(mapping, gazetteer = []) {
  const fields = new Set(Object.values(mapping || {}));
  const out = gazetteerWarnings(mapping, gazetteer);
  if (!fields.has('address') && !fields.has('id')) out.push(COLUMN_WORDS.noIds);
  if (fields.has('latitude') && !fields.has('longitude')) out.push(COLUMN_WORDS.latOnly);
  if (fields.has('longitude') && !fields.has('latitude')) out.push(COLUMN_WORDS.lonOnly);
  return out;
}
/** A warning for each column named for a gazetteer or a web address when no column is read as the address; `cli` words it for the command line. */
export function gazetteerWarnings(mapping, gazetteer = [], { cli = false } = {}) {
  if (Object.values(mapping || {}).includes('address')) return [];
  return gazetteer.filter((h) => Object.hasOwn(mapping || {}, h)).map((h) => COLUMN_WORDS.gazetteerNotAddress(h, cli));
}
/** A problem with a saved matching (columns.js, resolveColumns: { kind, example }) in words. */
export function columnProblem(p) {
  if (p.kind === 'generic-mapping-missing-column') return COLUMN_WORDS.missing(p.example);
  if (p.kind === 'generic-mapping-unknown-column') return COLUMN_WORDS.unknown(p.example);
  return COLUMN_WORDS.unusable(p.example);
}

// Krisis: review screen
// What the page says while matches are reviewed one subject place at a time (src/app.js).
const IDENTITY_WORDS = { exactMatch: 'the same place', closeMatch: 'much the same place', related: 'a related place' };
export const review = {
  /** "12 of 340 places reviewed; this is place 13." */
  progress: ({ reviewed, total }, at) => `${reviewed.toLocaleString('en-GB')} of ${count(total, 'places')} reviewed${at ? `; this is place ${at.toLocaleString('en-GB')}` : ''}.`,
  /** Coordinates, longitude and latitude, as "51.4545° N, 2.5879° W"; or that there are none. */
  point: (p) => (Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)
    ? `${Math.abs(p[1]).toFixed(4)}° ${p[1] < 0 ? 'S' : 'N'}, ${Math.abs(p[0]).toFixed(4)}° ${p[0] < 0 ? 'W' : 'E'}` : 'no coordinates'),
  /** Other names than the label: "Also: Bristow, Brigstowe"; empty when there are none. */
  names: (label, names) => { const other = [...new Set((names || []).filter((n) => n && n !== label))]; return other.length ? `Also: ${other.join(', ')}` : ''; },
  /** How alike and how far: "names 93% alike, 1.2 km apart". */
  facts: (c) => [`names ${Math.round((c.similarity_score || 0) * 100)}% alike`,
    Number.isFinite(c.distance_km) ? `${c.distance_km < 10 ? c.distance_km.toFixed(1) : Math.round(c.distance_km).toLocaleString('en-GB')} km apart` : 'distance not known'].join(', '),
  /** A decision taken, in words: "Decided: the same place (exact match)". */
  decision: (d) => !d ? 'Not decided yet'
    : d.kind === 'match' ? `Decided: ${IDENTITY_WORDS[d.identityType] || d.identityType}`
    : d.kind === 'not-this' ? 'Decided: not this one'
    : `Decided: different places, because ${d.basis}`,
  candidates: (n) => (n ? `${n === 1 ? 'One candidate' : `${n} candidates`} in the other dataset:` : 'No candidates in the other dataset.'),
  basisLabel: 'Why are these different places? Say what shows it: this is recorded with the attestation.',
  basisNeeded: 'Say why they are different places before recording it.',
  none: 'No matches were suggested, so there is nothing to review. With a lower threshold for how alike names must be, or a greater distance, there may be some.',
  allDone: 'Every place has been reviewed. Finish to make the attestations, or choose "all places" to look again.',
  nameNeeded: 'Give your name first: each attestation records who made it.',
  saved: (name) => `Saved the review as ${name}.`,
  /** When a resumed review was made from other files than those chosen now. */
  differs: (names) => `This review was made from other files than the ones chosen: ${names.join(', ')}. Its places may no longer match the data.`,
  noDataset: 'Choose the dataset this review was made from first; it is needed to finish.',
  /** A dataset given to matching that is not data these tools read ('subjects' or 'others'). */
  notRecognised: (which) => `${which === 'subjects' ? 'Your dataset' : 'The other dataset'} was not recognised as data these tools read, so nothing was matched`,
};

// Krisis: matching. What the match review (src/engine/krisis/) says, on the page and the command line.
const KRISIS_PHASES = { matching: 'Comparing the names', applying: 'Making the attestations' };
const KRISIS_DATASETS = { subjects: 'Places to match', others: 'Other dataset' };
const plural = (n, one, many = one + 's') => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

/** The summary of a matching: how many places were compared, and how many suggestions were found for how many. */
function matchSummary(report) {
  const c = report.counts, nErr = report.errors;
  if (c.subjects === undefined) return { problems: 'The two datasets could not be matched.', counted: '' };
  const already = [c.linked ? `${plural(c.linked, 'pair')} already linked` : '', c.judgedDifferent ? `${plural(c.judgedDifferent, 'pair')} already said to be different places` : '',
    c.tooFar ? `${plural(c.tooFar, 'pair')} alike in name but further apart than the greatest distance` : ''].filter(Boolean);
  return {
    problems: nErr ? `${plural(nErr, 'problem')} found.` : c.candidates ? `${plural(c.candidates, 'possible match', 'possible matches')} to review.` : 'No possible matches found.',
    counted: `Compared ${plural(c.subjects, 'place')} with ${plural(c.others, 'place')} of the other dataset; ${plural(c.suggestedFor, 'place has', 'places have')} suggestions.`
      + (already.length ? ` Not suggested: ${already.join('; ')}.` : ''),
  };
}
/** The summary of finishing a review: the attestations made. */
function applySummary(report) {
  const c = report.counts, nErr = report.errors;
  if (c.attestations === undefined) return { problems: nErr ? `${plural(nErr, 'problem')} found.` : '', counted: '' };
  return {
    problems: nErr ? `${plural(nErr, 'problem')} found.` : c.attestations ? 'The review was made into attestations.' : 'Nothing to write.',
    counted: `Made ${plural(c.attestations, 'new attestation')}: ${c.matchAttestations.toLocaleString('en-GB')} accepting ${plural(c.relations - c.distinctAttestations, 'match', 'matches')}, ${c.distinctAttestations.toLocaleString('en-GB')} saying that two places are different.`,
  };
}
function krisisGroups(action) {
  return action === 'match' ? [
    { severity: 'error', title: 'Problems', intro: 'These stopped places being matched: a place that is not matched is not suggested.' },
    { severity: 'warning', title: 'Warnings', intro: 'Worth a look; the suggestions can still be reviewed.' },
  ] : [
    { severity: 'error', title: 'Problems', intro: 'Nothing was written because of these.' },
    { severity: 'warning', title: 'Warnings', intro: 'Worth a look before the attestations are added to the dataset.' },
  ];
}
/** The note each attestation a review makes carries, saying how it came about. */
export function krisisNote(kind, algorithm) {
  return kind === 'match'
    ? `Accepted by the reviewer in a match review (PLATO tools, Krisis), from suggestions made by comparing names (${algorithm}).`
    : `The reviewer judged these to be different places in a match review (PLATO tools, Krisis), rejecting a suggestion made by comparing names (${algorithm}).`;
}
/** A match review's progress: "12 of 340 places reviewed". */
export const reviewProgressText = ({ reviewed, total }) => `${reviewed.toLocaleString('en-GB')} of ${plural(total, 'place')} reviewed`;
