// What the tools say about a run, in the browser (src/app.js) and in the terminal (bin/), so that
// both give the same messages in the same words.
export function fmtBytes(n) { return n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' bytes'; }
export function fmtTime(ms) { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; }
export const FORMAT_NAMES = { tables: 'PLATO spreadsheet tables', 'plato-json': 'a PLATO JSON document', 'plato-jsonl': 'PLATO JSON Lines', ntriples: 'RDF (N-Triples)', nquads: 'RDF (N-Quads)', turtle: 'RDF (Turtle)', lpf: 'a Linked Places Format FeatureCollection', 'lpf-seq': 'a Linked Places Format sequence', 'w3c-annotations': 'W3C Web Annotations (as Recogito exports them)' };
FORMAT_NAMES.tei = 'a TEI XML edition';
FORMAT_NAMES.csv = 'a table of places (CSV), its columns matched to PLATO';
FORMAT_NAMES.geojson = 'plain GeoJSON (not Linked Places Format), its properties matched to PLATO';
/** What a detected input is, in words: "PLATO JSON Lines (place-centric)". */
export const formatName = (input) => (input.format === 'csv' && input.container === 'workbook' ? sheetName(input) : FORMAT_NAMES[input.format]) + (input.profile ? ` (${input.profile})` : '') + (input.lpfVersion === 2 ? ', version 2' : '') + withGeorefs(input);
// Hermes: a sheet of a workbook that is not PLATO's tables, read as a table of places.
const sheetName = ({ sheet }) => `a table of places${sheet !== undefined ? ` (the sheet “${sheet}” of a workbook)` : ' (a workbook)'}, its columns matched to PLATO`;
// Hermes: a Recogito export chosen with the georeferences of its maps, and their manifests (plural is below).
function withGeorefs({ georefs, manifests }) {
  if (!georefs?.length && !manifests?.length) return '';
  const parts = [georefs?.length ? plural(georefs.length, 'georeference', 'georeferences') : '', manifests?.length ? plural(manifests.length, 'IIIF manifest', 'IIIF manifests') : ''].filter(Boolean);
  return `, with ${parts.join(' and ')} to place its regions`;
}

// A count in words, singular for one: "1 place", "2 places", "1 identity relation".
const ONE = { 'earlier attestations': 'earlier attestation', annotations: 'annotation', places: 'place', attestations: 'attestation', 'identity relations': 'identity relation', candidates: 'candidate', triples: 'triple', 'triples written': 'triple written', 'table rows': 'table row', observations: 'Data Cube observation' };
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
  if (p.rows) bits.push(count(p.rows, 'rows'));
  if (p.places) bits.push(count(p.places, 'places'));
  if (p.attestations) bits.push(count(p.attestations, 'attestations'));
  const phase = { reading: 'Reading', loading: 'Loading into the working database', checking: 'Checking the tables', indexing: 'Indexing', writing: 'Writing', done: 'Finishing', read: 'Read', comparing: 'Comparing the two versions' }[p.phase] || KRISIS_PHASES[p.phase] || p.phase;
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
  const counted = ['annotations', 'place names', 'rows', 'features', 'places', 'attestations', 'identity relations', 'candidates', 'triples', 'triples written', 'table rows', 'observations'].filter((k) => c[k]).map((k) => count(c[k], k)).join(', ');
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
  /** A workbook read as a table of places: which of its sheets is read. */
  sheetLabel: 'Sheet to read',
  sheetTip: 'Only one sheet of a workbook is read. Choosing another reads its columns again; the report names the sheets not read.',
  sheetHidden: (name) => `${name} (hidden)`,
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
  /** A column of a gazetteer's ids for which a pattern is suggested (columns.js, guessColumns `suggested`), until it is confirmed. */
  patternSuggested: (col, pattern, cli) => `The column “${col}” seems to hold a gazetteer's ids, but they are not read as web addresses until you confirm the pattern that makes them, ${pattern}: ${cli ? `give it as {"field": "address", "pattern": "${pattern}"} in the mapping given with --columns` : 'tick “Make web addresses” in its row'}.`,
  /** The row control that confirms a suggested pattern. */
  usePattern: 'Make web addresses',
  usePatternLabel: (col, pattern) => `Make the web addresses of the column “${col}” with ${pattern}`,
  gazetteerNotAddress: (col, cli) => `The column “${col}” is named for a gazetteer or a web address, but no column is read as the place's web address, so no row will be linked to a gazetteer's place: each is read as a new place. If “${col}” holds the places' addresses, ${cli ? 'map it to "address" in the mapping given with --columns' : 'choose “Place\'s web address” for it'}.`,
};
/**
 * The warnings a matching deserves before it is used, in words: a column named for a gazetteer
 * (`gazetteer`, columns.js's gazetteerColumns) when no column is the address, no ids or addresses,
 * half a coordinate pair.
 */
export function columnWarnings(mapping, gazetteer = [], suggested = {}, patterns = {}) {
  const fields = new Set(Object.values(mapping || {}));
  const out = gazetteerWarnings(mapping, gazetteer, { suggested, patterns });
  if (!fields.has('address') && !fields.has('id')) out.push(COLUMN_WORDS.noIds);
  if (fields.has('latitude') && !fields.has('longitude')) out.push(COLUMN_WORDS.latOnly);
  if (fields.has('longitude') && !fields.has('latitude')) out.push(COLUMN_WORDS.lonOnly);
  return out;
}
/**
 * A warning for each column named for a gazetteer or a web address when no column is read as the
 * address; `cli` words it for the command line. A column with a pattern suggested for its ids
 * (`suggested`, columns.js) and not yet confirmed (`patterns`) is pointed at that pattern instead.
 */
export function gazetteerWarnings(mapping, gazetteer = [], { cli = false, suggested = {}, patterns = {} } = {}) {
  const m = mapping || {}, s = suggested || {}, p = patterns || {};
  const pending = Object.keys(s).filter((h) => Object.hasOwn(m, h) && !Object.hasOwn(p, h));
  // With a column read as the address, only that column's own ids, if it has a pattern still to confirm.
  if (Object.values(m).includes('address')) return pending.filter((h) => m[h] === 'address').map((h) => COLUMN_WORDS.patternSuggested(h, s[h].pattern, cli));
  return [...pending.map((h) => COLUMN_WORDS.patternSuggested(h, s[h].pattern, cli)),
    ...gazetteer.filter((h) => Object.hasOwn(m, h) && !pending.includes(h)).map((h) => COLUMN_WORDS.gazetteerNotAddress(h, cli))];
}
/** A problem with a saved matching (columns.js, resolveColumns: { kind, example }) in words. */
export function columnProblem(p) {
  if (p.kind === 'generic-mapping-missing-column') return COLUMN_WORDS.missing(p.example);
  if (p.kind === 'generic-mapping-unknown-column') return COLUMN_WORDS.unknown(p.example);
  return COLUMN_WORDS.unusable(p.example);
}

// ---- Hermes: Reading options --------------------------------------------------------------------
// The page's one fieldset of reading options (src/app.js), shown only for a format that has some:
// a TEI edition, or a table of places (CSV or plain GeoJSON). Every control is off until chosen; what
// each one does is said in the report (LOSS_TEXT), not here.
export const READING_WORDS = {
  legend: 'Reading options',
  listPlaces: "Read the list of places, each place's first name as its headword",
  headerPlaces: "Read the places in the header (found at, made at), as the editors' words",
  commentaryPlaces: "Read place names in the commentary and notes, as the editors' words",
  sameId: 'Rows with the same id are one place',
  /** Refused: the checkbox ticked with no column read as the place id. */
  sameIdNoId: 'Rows can be one place only when a column is read as the place id. Choose one in the table above first.',
  keysCaption: 'Keys with no web address: make one from each key with a pattern',
  keyPrefix: 'Prefix', keyCount: 'Place names', keyExamples: 'Examples', keyPattern: 'Pattern', keyUse: 'Use',
  noPrefix: '(none)',
  keyPatternLabel: (prefix) => `The pattern for keys ${prefix ? `with the prefix “${prefix}”` : 'with no prefix'}`,
  keyUseLabel: (prefix) => `Use the pattern for keys ${prefix ? `with the prefix “${prefix}”` : 'with no prefix'}`,
  /** A pattern ticked with nothing in it. */
  keyEmpty: (prefix) => `Give a pattern for keys ${prefix ? `with the prefix “${prefix}”` : 'with no prefix'}, or untick it.`,
  keysUnread: (message) => `The keys could not be read: ${message}`,
};

// ---- Hermes: the preview of the first records -------------------------------------------------------
// `plato-tools preview` and the page's "Preview the first 10 records" (src/engine/hermes/preview.js):
// the first records a run reads, shown as PLATO JSON, with what was lost from them so far. A preview
// writes nothing and checks nothing as a whole, and says so wherever it is shown.
const records = (n) => (n === 1 ? 'record' : 'records');
export const PREVIEW_WORDS = {
  button: (n) => `Preview the first ${n} records`,
  tip: 'Reads only the first records, as a conversion reads them, and shows them as PLATO JSON with what was lost from them so far. Nothing is checked as a whole, and nothing is written.',
  heading: 'Preview',
  losses: 'Losses so far',
  noLosses: 'Nothing has been lost from what was read so far.',
  none: 'No records were read.',
  pending: 'Reading the first records…',
  jsonLabel: 'The records, as PLATO JSON',
  /**
   * The line above a preview: "first N of M records" where the whole input was read (so M is known),
   * else "the first N records read; the rest not read". The input is never read to the end to count it.
   */
  line: ({ count, total }) => `${total === null || total === undefined ? `the first ${count.toLocaleString('en-GB')} ${records(count)} read; the rest not read` : `first ${count.toLocaleString('en-GB')} of ${total.toLocaleString('en-GB')} ${records(total)}`}; nothing checked or written`,
  /** A format with no preview: said plainly. */
  refused: (what) => `A preview is made only of a table of places (a CSV file, plain GeoJSON or a sheet of a workbook), a TEI edition, or W3C Web Annotations; this is ${what}, which is not previewed. Check or convert it instead.`,
  limit: (given) => `The number of records to preview must be a whole number of at least 1; "${given}" is not.`,
  failed: (message) => `No preview could be made: ${message}`,
  // Why a preview is partial (complete: false), each said where it applies.
  stopped: (n) => `Reading stopped after the first ${n.toLocaleString('en-GB')} ${records(n)}: the rest of the file was not read, so nothing after them, and no problem in it, is shown.`,
  regrouped: "A conversion gathers these attestations by the place each is about once the whole file has been read; here they are shown one by one, as they are read, and a place's other attestations may come later in the file.",
  sameId: 'Rows with the same id are read as one place, and each such place is made once every row has been read, so none is shown here.',
  teiPending: (n) => `${n.toLocaleString('en-GB')} place ${n === 1 ? 'name' : 'names'} read so far ${n === 1 ? 'points' : 'point'} to a <place> later in the file (ref="#…"), and ${n === 1 ? 'waits' : 'wait'} for it, so ${n === 1 ? 'is' : 'are'} not shown: a run gives ${n === 1 ? 'it' : 'them'} after that <place>, which can be near the end of the file.`,
  teiHeld: (n) => `${n.toLocaleString('en-GB')} place ${n === 1 ? 'name' : 'names'} read so far ${n === 1 ? 'is' : 'are'} held until it is known whether the text has an edition div (${n === 1 ? 'it' : 'they'} may be the editors' words), so ${n === 1 ? 'is' : 'are'} not shown.`,
  unreadable: (message) => `The file could not be read past a problem, so the preview stops there: ${message}`,
};

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
  badOrcid: 'Your ORCID is not written as one: it is sixteen digits in four groups, the last of which may be an X, such as 0000-0002-1825-0097, or the same as a web address, https://orcid.org/0000-0002-1825-0097. Correct it in the options, or leave it empty: until then the review cannot be saved or finished.',
  saved: (name) => `Saved the review as ${name}.`,
  /** When a resumed review was made from other files than those chosen now. */
  differs: (names) => `This review was made from other files than the ones chosen: ${names.join(', ')}. Its places may no longer match the data.`,
  noDataset: 'Choose the dataset this review was made from first; it is needed to finish.',
  /** A review resumed before any dataset is chosen. */
  noDatasetYet: 'No dataset is chosen yet. You can look through the review, but to finish it, choose the dataset it was made from, then resume the review again.',
  /** A review resumed with files chosen that are not data these tools read. */
  notRecognisedYet: 'The files chosen were not recognised as data these tools read. You can look through the review, but to finish it, choose the dataset it was made from, then resume the review again.',
  /** Finish pressed with files chosen that are not data these tools read: the reviewer is still in the review. */
  notRecognisedAtFinish: 'The files chosen were not recognised as data these tools read, so the review cannot be finished with them. Save the review, choose the dataset it was made from, and resume the saved review to finish it.',
  /** A dataset given to matching that is not data these tools read ('subjects' or 'others'). */
  notRecognised: (which) => `${which === 'subjects' ? 'Your dataset' : 'The other dataset'} was not recognised as data these tools read, so nothing was matched`,
  /** Beside the column choices of a table while a review is open, when they cannot be changed. */
  columnsLocked: 'Locked while a review is open: the review reads the dataset by the matching of columns it was made with.',
};

// Krisis: matching. What the match review (src/engine/krisis/) says, on the page and the command line.
const KRISIS_PHASES = { matching: 'Comparing the names', applying: 'Making the attestations', checking: 'Checking the new dataset with the version check' };
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
/** The summary of finishing a review: the attestations made, and with the dataset output, what the version check found. */
function applySummary(report) {
  const c = report.counts, nErr = report.errors, v = c.versionCheck;
  if (c.attestations === undefined) return { problems: nErr ? `${plural(nErr, 'problem')} found.` : '', counted: '' };
  const made = `Made ${plural(c.attestations, 'new attestation')}: ${c.matchAttestations.toLocaleString('en-GB')} accepting ${plural(c.relations - c.distinctAttestations, 'match', 'matches')}, ${c.distinctAttestations.toLocaleString('en-GB')} saying that two places are different.`;
  if (!v) return { problems: nErr ? `${plural(nErr, 'problem')} found.` : c.attestations ? 'The review was made into attestations.' : 'Nothing to write.', counted: made };
  const kept = v.changed || v.lost ? `the version check found ${[v.changed ? `${plural(v.changed, 'attestation')} changed` : '', v.lost ? `${plural(v.lost, 'attestation')} no longer there` : ''].filter(Boolean).join(' and ')}`
    : 'the version check found nothing deleted or changed';
  return {
    problems: nErr ? `${plural(nErr, 'problem')} found.` : 'The review was added to the dataset.',
    counted: `${made} The dataset of ${plural(c.places || 0, 'place')} had ${plural(v.earlier, 'attestation')}, and has ${v.later.toLocaleString('en-GB')} with ${v.added.toLocaleString('en-GB')} added; ${kept}.`,
  };
}
function krisisGroups(action) {
  return action === 'match' ? [
    { severity: 'error', title: 'Problems', intro: 'These stopped places being matched: a place that is not matched is not suggested.' },
    { severity: 'warning', title: 'Warnings', intro: 'Worth a look; the suggestions can still be reviewed.' },
  ] : [
    { severity: 'error', title: 'Problems', intro: 'Nothing was written because of these.' },
    { severity: 'warning', title: 'Warnings', intro: 'Worth a look before the attestations are added to the dataset.' },
    { severity: 'loss', title: 'Not carried over', intro: 'The dataset written is PLATO JSON, which has no place for these, so they are left out of it.' },
  ];
}
/** The note each attestation a review makes carries, saying how it came about. */
export function krisisNote(kind, algorithm) {
  return kind === 'match'
    ? `Accepted by the reviewer in a match review (PLATO tools, Krisis), from suggestions made by comparing names (${algorithm}).`
    : `The reviewer judged these to be different places in a match review (PLATO tools, Krisis), rejecting a suggestion made by comparing names (${algorithm}).`;
}
/** What finishing a review with the dataset output says (src/engine/krisis/apply.js), and matching's own warnings. */
export const KRISIS_TEXT = {
  /** The other dataset gives no title, so the attestations would cite it by its file's name. */
  othersTitleIsFileName: (name) => `The other dataset does not give its title, so each attestation of this review would cite it as its source by its file's name, ${name}, and a published attestation is never changed. Give the other dataset's title (in the options on the page, or --others-title on the command line) before you finish.`,
  noDataset: 'Choose the dataset this review was made from: the new attestations are added to it. Nothing was written.',
  datasetNotRead: 'The dataset could not be read to the end, so it was not written with the new attestations',
  datasetHasProblems: 'The dataset has problems of its own, which finishing a review does not list or change. The new attestations were still added; check the dataset by itself to see them.',
  /** The subject dataset came in another format than a PLATO JSON document. */
  datasetNowPlatoJson: (input) => `Your dataset is ${formatName(input)}; the dataset written with the new attestations is a PLATO JSON document (place-centric), whatever format it came in. What PLATO JSON has no place for is listed below, if anything.`,
  notInDataset: 'A place the review made attestations about is not in the dataset, so its attestations have nowhere to go and nothing was written. Is this the dataset the review was made of? The example gives the place.',
  notAppendOnly: 'The version check found that the dataset written does not keep all of the original, which is a fault in the tools (please report it); nothing was written.',
  notChecked: 'The dataset written could not be checked with the version check, so nothing was written',
  /** The base address given to finish a review of spreadsheet tables is not the one it was matched with. */
  baseDiffers: (reviewed, given) => `The review was made with ${reviewed ? `the base address ${reviewed}` : 'no base address'} for the places of your spreadsheet tables, and ${given ? `${given} is given now` : 'none is given now'}, so the places may not have the addresses the review gives them. Give the same base address as when matching.`,
  /** A mapping of a table's columns given to finish a review is not the one the review was made with. */
  columnsDiffer: 'The columns of your table are read as given now, which is not how they were read when matching: the places may not be the ones the review was made of. Use the same matching of columns as when matching.',
  /** A mapping of a table's columns given to match by is not one a work file can keep. */
  columnsNotAMapping: 'The matching of columns given is not one: it must be {"column name": "field"}, each column given the name of a field (or, made into web addresses, {"field": "address", "pattern": "…{id}…"}).',
  /** The version check does not find every new attestation in the dataset written. */
  notAllAdded: (made, added) => `The review made ${plural(made, 'new attestation')}, but the version check finds ${plural(added || 0, 'attestation')} added to the dataset written, which is a fault in the tools (please report it); nothing was written.`,
};
// ---- Chora (the map viewer and editor) -----------------------------------------------------------
/**
 * What a drawing's notes say of how it was made, since PLATO has no term for it: "Drawn by hand on
 * the Natural Earth basemap at zoom 9 in PLATO tools (Chora)". A pasted basemap is not named: its
 * site may be a private one, and the notes are published with the dataset.
 */
export const PASTED_BASEMAP = 'a basemap pasted by the contributor';
export const choraDrawingNote = ({ basemap = 'Natural Earth', zoom } = {}) =>
  `Drawn by hand on ${basemap === PASTED_BASEMAP ? basemap : `the ${basemap} basemap`}${Number.isFinite(zoom) ? ` at zoom ${Math.round(zoom)}` : ''} in PLATO tools (Chora)`;
/**
 * A run refused because another tab of the main page holds the working files: the browser lets one
 * tab at a time hold them (src/engine/worker.js, sqlitePool), and its own words for that are not ours.
 */
export const POOL_BUSY = 'Another tab of PLATO tools in this browser is working on a file. Wait for it to finish, or close it, then try again.';
/** This tab could not let go of the working files it was granted in part (worker.js, letGo). */
export const POOL_STUCK = 'PLATO tools could not free its storage in this tab. Reload the page and try again.';
/** How a drawing traced from a historical map was made; it follows georefNote's fixed template, after it (src/engine/chora/trace.js). */
export const choraTracingNote = ({ zoom } = {}) =>
  `Traced by hand from a georeferenced historical map${Number.isFinite(zoom) ? ` at zoom ${Math.round(zoom)}` : ''} in PLATO tools (Chora).`;
/**
 * Why Chora does not open what was chosen as a dataset (src/engine/worker.js, chora-load): the readers'
 * reason, but for a georeference, whose reason on the main page (input.js GEOREF_REASON) is to drop it
 * with the Recogito export it places; on Chora it is shown under Historical maps.
 */
export const CHORA_GEOREF_REASON = "This is a IIIF Georeference Annotation (a map's georeference, not a dataset): to show the map, paste it, or its address, under Historical maps, and open a dataset here to draw on.";
export const choraLoadFailure = (input) => (input?.format === 'georef' ? CHORA_GEOREF_REASON : input?.reason);
/**
 * How a drawing traced WITH ASSISTANCE from a historical map was made: a shape proposed from the map's
 * ink, then accepted or edited by hand. This is the one place its words are made (a citation of the
 * software may later be added beside it); it follows georefNote's sentences (src/engine/chora/trace.js).
 * The shape is attested, not computed: a person accepted it. `a` is the draft's trace.assisted: { mode
 * 'area' | 'line', params (tolerance, colour, bridge), scale (1/s of full resolution: the last part's),
 * scales (each part's, a line carried on from several clicks), epsilon (image pixels), gaps (a line's,
 * jumped), holes: { dropped } (an area's holes left out when it was accepted: a drawing is an outline) };
 * `edits` countEdits' { moved, added, removed, proposed }; `version` the tools'; `uncited`, the title of
 * the map it was proposed from when it has since been moved off that map (so the map is not cited);
 * `proposedFrom`, the title of the map it was proposed from when that is not the map cited (or the one whose
 * citation was dropped): it was moved onto another map and traced from that ('' when its title is not known).
 */
export function choraAssistedNote(a, edits, { version, zoom, uncited = null, proposedFrom = null } = {}) {
  const p = a.params || {};
  const by = a.mode === 'area' ? 'filling an area' : 'following a line';
  const tol = a.mode === 'area' || p.colour ? `tolerance ${fmt(p.tolerance)}` : 'by its darkness';
  const scales = (a.scales?.length ? a.scales : [a.scale]).filter(Number.isFinite);
  const lo = Math.min(...scales), hi = Math.max(...scales);
  const at = scales.length && lo !== hi ? `at 1/${lo} to 1/${hi}` : `at 1/${scales.length ? lo : a.scale}`;
  const eps = a.epsilon > 0 ? `simplified to within ${fmt(a.epsilon)} image pixels` : 'not simplified';
  const gaps = a.mode === 'area'
    ? (p.bridge > 0 ? `, gaps of up to ${fmt(p.bridge * a.scale)} image pixels bridged` : '')
    : `, ${a.gaps || 0} gap${a.gaps === 1 ? '' : 's'} bridged`;
  const n = a.holes?.dropped || 0;
  const holes = n > 0 ? `; its ${n} hole${n === 1 ? '' : 's'} left out, as drawings are outlines;` : ',';
  const done = !edits || (!edits.moved && !edits.added && !edits.removed)
    ? 'accepted as proposed'
    : `edited by hand: moved ${edits.moved}, added ${edits.added}, removed ${edits.removed}, of ${edits.proposed} proposed`;
  const off = uncited !== null ? ` Its citation of the map it was traced from${uncited ? ` (“${uncited}”)` : ''} was dropped: the drawing was moved off that map, or that map could not place it, or the basemap was chosen instead.` : '';
  return `Traced with assistance in PLATO tools (Chora)${version ? ` ${version}` : ''}${Number.isFinite(zoom) ? ` at zoom ${Math.round(zoom)}` : ''}: proposed from ${proposedFrom === null ? 'the map\'s ink' : proposedFrom ? `the ink of “${proposedFrom}”` : 'the ink of another map'} by ${by} (${tol}, ${at} of full resolution, ${eps}${gaps})${holes} then ${done}.${off}`;
}
const fmt = (x) => (Number.isFinite(x) ? String(Math.round(x * 100) / 100) : '?');
/**
 * What the ink panel says of a shape proposed (src/chora/ink.js): `mode` 'area' | 'line', `scale` (read at 1/scale of
 * full resolution), `gaps` jumped, `holes` (an area's), `ends` (a line's last part: why each end stopped, as the engine's
 * follow gives it; 'fork' where it stopped at a fork it could not judge, its end drawn back to where the two ways part).
 */
export function inkProposedText({ mode, scale, gaps = 0, holes = 0, ends = null }) {
  const forks = mode === 'line' && Array.isArray(ends) ? ends.filter((e) => e === 'fork').length : 0;
  const found = `${gaps ? `, ${gaps} gap${gaps === 1 ? '' : 's'} jumped (dotted)` : ''}${holes ? `, with ${holes} hole${holes === 1 ? '' : 's'}` : ''}`;
  const some = ['', 'a fork', 'two forks', 'three forks', 'four forks'][forks] ?? `${forks} forks`;
  const fork = forks ? ` It stopped short of ${some} it could not judge (two ways on, alike): Shift-click the way the line goes to carry it on.` : '';
  return `${mode === 'area' ? 'An area' : 'A line'} proposed (dashed orange), read at 1/${scale} of full resolution${found}.${fork} Enter accepts it, Esc lets it go${mode === 'line' && !forks ? '; Shift-click carries the line on' : ''}.`;
}
/**
 * The ends of a line proposed from one or more clicks (src/chora/ink.js: a Shift-click carries a line on, as another
 * result): every result's ends in order, so that a fork any one of them stopped at is still said after the line is
 * carried on past another; null when no result knows its ends (an older worker's).
 */
export function lineEnds(results) {
  const known = results.filter((r) => Array.isArray(r?.ends));
  return known.length ? known.flatMap((r) => r.ends) : null;
}
/** What a Chora save reports of itself (src/engine/chora/save.js), by kind. */
export const CHORA_TEXT = {
  'chora-addition-invalid': 'A drawing could not be added, because PLATO would not accept it as it is, so nothing was saved',
  'chora-no-such-place': 'A drawing is for a place this dataset does not have, so nothing was saved. Open the dataset the drawing was made on.',
  'chora-not-placed': 'A drawing did not reach its place in the saved file, so the file must not be used.',
  'chora-attestations-not-a-list': 'A drawing is for a place whose attestations are not a list, as PLATO requires, so the drawing could only replace them, and nothing was saved. Correct that place in the dataset first',
  'chora-unreadable': 'The dataset could not be read to the end, so it was not saved.',
  'chora-in-another-tab': 'Chora is already open in another tab of this browser. Close it, or use that one.',
  'chora-mneme-failed': 'The version check (Mneme) found that the saved file does not keep every attestation of the dataset exactly as it was, or does not add exactly the drawings. Do not use it.',
};
/** A Chora save's outcome in one line, for the page and the command line. */
export function choraSaveText(result) {
  const n = result.report?.counts?.['attestations added'] || 0;
  if (!result.mneme) return 'Nothing was saved.';
  return result.mneme.passed
    ? `Saved, with ${n.toLocaleString('en-GB')} new attestation${n === 1 ? '' : 's'}; the version check (Mneme) confirms that every attestation of the dataset is there as it was.`
    : CHORA_TEXT['chora-mneme-failed'];
}

// Krisis: gazetteer lookup. What looking places up in a gazetteer says (src/engine/krisis/lookup.js),
// on the page and the command line.
/** The note an attestation carries when its judgement is on a candidate a gazetteer's service found. */
export function krisisLookupNote(kind, title, algorithm) {
  return kind === 'match'
    ? `Accepted by the reviewer in a match review (PLATO tools, Krisis), from candidates found by looking the place up in ${title} (${algorithm}).`
    : `The reviewer judged these to be different places in a match review (PLATO tools, Krisis), rejecting a candidate found by looking the place up in ${title} (${algorithm}).`;
}
const STOPPED = {
  auth: "The lookup stopped: the gazetteer refused the token, or today's allowance of requests is spent. Check the token, and resume the lookup (tomorrow, if the allowance is spent).",
  quota: "The lookup stopped: the gazetteer's allowance of requests for today is spent. Resume it tomorrow.",
  rate: 'The lookup stopped: the gazetteer still refused the queries as too many after waiting. Resume it later.',
  unavailable: 'The lookup stopped: the gazetteer may not pass on what was asked for.',
  network: 'The lookup stopped: the gazetteer could not be reached. Resume it when it can.',
  server: 'The lookup stopped: the gazetteer refused or failed a request. Resume it later.',
  stopped: 'The lookup was stopped. What was answered is kept; resume it to look up the rest.',
  suspect: 'The lookup stopped: the gazetteer answered nothing at all to any query of the first batch, which is more likely a filter or setting it did not take than places it does not have. Those places are marked not answered, not "no match". Check the filters and settings. If they are right, send the same places again with the same settings (resume the lookup): their empty answers are then accepted as genuine, and the lookup goes on.',
  fault: 'The lookup stopped because of a fault in the tools (please report it). What was answered before it is kept.',
};
/** Why a lookup stopped when the permissions module refused a request (src/lib/permissions.js, PermissionError's kind). */
const REFUSED_LOOKUP = {
  address: 'The lookup stopped: the service asked for something from a site its permission does not cover, so nothing was sent there.',
  never: 'The lookup stopped: this gazetteer is set to Never in Permissions, so nothing more was sent.',
  undecided: 'The lookup stopped: this gazetteer is not allowed in Permissions now, so nothing more was sent. Allow it there, then resume the lookup.',
  reload: 'The lookup stopped: this gazetteer was allowed after the page loaded, and can be asked once the page is reloaded. Save the review, reload the page, and resume it.',
  unprotected: "The lookup stopped: this browser did not show that it enforces the page's protection, so no other site is asked from this page.",
  moved: 'The lookup stopped: the gazetteer sent the request on elsewhere, which is not followed, so its answer was not used.',
  network: 'The lookup stopped: the gazetteer could not be reached; it may not allow other sites to read it. Resume it when it can.',
};

export const LOOKUP_WORDS = {
  /** Why a lookup stopped ({ kind, message } from runLookup), with what the gazetteer said. */
  stopped: (s) => (s.kind === 'permission' ? REFUSED_LOOKUP[s.refused] || REFUSED_LOOKUP.undecided : (STOPPED[s.kind] || STOPPED.server) + (s.message ? ` (${s.message})` : '')),
  /** The same, for each kind of refusal by the permissions module. */
  refused: REFUSED_LOOKUP,
  /** The places a lookup takes, as the options name them. */
  choices: {
    unmatched: 'places without candidates from the other dataset', all: 'all places',
    pending: 'places not yet looked up, or not answered', unlinked: 'places not yet linked to the gazetteer',
  },
  /** A place answered with no candidates: which names were sent, so that "none" is read for what it is. */
  notFound: (q) => (q.sent.length > 1 ? `No candidates (label and ${plural(q.sent.length - 1, 'other name')}).` : 'No candidates (label only).'),
  /** A place the gazetteer did not answer: not "no match". */
  unanswered: 'The gazetteer did not answer for this place; this is not a finding that it has no match. Look it up again.',
  far: (km) => `further than ${km.toLocaleString('en-GB')} km`,
  /** A candidate's licence (lookup.js licenceOf), or that it is not known. */
  licence: (l) => (!l ? 'licence unknown' : [l.spdx || 'licence not named', l.commercial === false ? 'non-commercial' : '', l.derivatives === false ? 'no derivatives' : '',
    l.redistributable === false ? 'not to be passed on' : '',
    l.commercial === null || l.derivatives === null || l.redistributable == null ? 'terms partly unknown' : ''].filter(Boolean).join(', ')),
  gazetteerFigures: 'The gazetteer\'s own score is relative to its best answer for that query, and its confidence measures the name only: neither says the place is the same.',
  noToken: (variable) => `The World Historical Gazetteer needs a token: set ${variable} in the environment (from your WHG profile). It is never given on the command line.`,
  tokenOnCommandLine: 'the token is never given on the command line, where it would be kept in the shell\'s history and seen by other programs: set WHG_TOKEN in the environment instead (for another service, name the variable that holds its token with --token-env).',
  tokenOverHttp: 'a token is never sent over http://, where anyone on the way could read it: give the service\'s https:// address.',
  tokenEnvMissing: (name) => `--token-env names ${name}, which is not set in the environment.`,
  /** Another service whose manifest could not be read (lookup.js manifestSettings). */
  noManifest: "The service's manifest (what it says of itself) could not be read, so queries are sent to it without a type, and a candidate's id is made into a web address only by the template given, if any.",
  linksUnknown: 'The dataset was not read, so candidates it already links to a place, or says are different places, could not be left out.',
  noPlaces: 'No places to look up with this choice.',
  /** The preview, before anything is sent: how much is asked, and the first queries exactly. */
  preview(p, { perDay = null } = {}) {
    const lines = [`Would look up ${plural(p.places, 'place')} in ${p.service.title}: ${plural(p.queries, 'query', 'queries')} in ${plural(p.requests, 'request')}`
      + (perDay ? ` (the gazetteer allows ${perDay.toLocaleString('en-GB')} requests a day)` : '') + '.'];
    lines.push(p.allNames ? 'Each place is looked up by its label and each of its other names, one query for each.' : 'Each place is looked up by its label only.');
    lines.push(p.filters.length ? `Filters: ${p.filters.map((f) => (f === 'countries' ? "the place's own countries" : `within about ${p.nearKm.toLocaleString('en-GB')} km of its point (answered from the gazetteer's upstream sources only)`)).join(' and ')}. A filter leaves out every candidate outside it, the right one too if the data is wrong.` : 'No filters: nothing is left out by country or distance.');
    if (p.sendsCoordinates) lines.push("The places' coordinates are sent.");
    if (p.withoutCountries) lines.push(`${plural(p.withoutCountries, 'place has', 'places have')} no countries, and ${p.withoutCountries === 1 ? 'is' : 'are'} looked up without that filter.`);
    if (p.withoutName) lines.push(`${plural(p.withoutName, 'place has', 'places have')} no name (only a web address), and ${p.withoutName === 1 ? 'is' : 'are'} not looked up: an address is never sent as a name.`);
    if (p.withoutPoint) lines.push(`${plural(p.withoutPoint, 'place has', 'places have')} no coordinates, and ${p.withoutPoint === 1 ? 'is' : 'are'} looked up without the distance filter.`);
    if (p.first.length) lines.push(`The first ${p.first.length === 1 ? 'query' : `${plural(p.first.length, 'query', 'queries')}`}, as sent:`);
    return lines;
  },
  /** The summary of a lookup: what was found, and what was not suggested and why. */
  summary(c, service) {
    const skipped = [c.skipped.noIri ? `${plural(c.skipped.noIri, 'candidate')} without a web address` : '', c.skipped.linked ? `${plural(c.skipped.linked, 'candidate')} already linked` : '',
      c.skipped.denied ? `${plural(c.skipped.denied, 'candidate')} already said to be a different place` : '', c.skipped.decided ? `${plural(c.skipped.decided, 'candidate')} already decided in this review` : '',
      c.skipped.duplicate ? `${plural(c.skipped.duplicate, 'candidate')} already suggested` : ''].filter(Boolean);
    const rest = [c.withoutName ? `${plural(c.withoutName, 'place was', 'places were')} not looked up, having no name (only a web address)` : '',
      c.unanswered ? `${plural(c.unanswered, 'place was', 'places were')} not answered, and can be looked up again` : '',
      c.scopeNotApplied ? `for ${plural(c.scopeNotApplied, 'place')} the gazetteer did not apply the distance filter, so its candidates are not filtered by distance` : '',
      c.stopped ? `${plural(c.stopped, 'place was', 'places were')} not looked up before the lookup stopped` : ''].filter(Boolean);
    return {
      problems: c.added ? `${plural(c.added, 'possible match', 'possible matches')} to review${c.far ? `, ${c.far.toLocaleString('en-GB')} of them far away` : ''}.` : 'No possible matches found.',
      counted: `Looked up ${plural(c.places, 'place')} in ${service}, with ${plural(c.queries, 'query', 'queries')}; ${plural(c.answered, 'place was', 'places were')} answered, ${c.notFound.toLocaleString('en-GB')} with no candidates.`
        + (rest.length ? ` ${rest.join('; ')}.` : '') + (skipped.length ? ` Not suggested: ${skipped.join('; ')}.` : ''),
    };
  },
};
/** Krisis: gazetteer lookup on the page (src/app.js): the panel, the progress, and the review screen's additions. */
const pct = (part, whole) => { const x = (100 * part) / whole; return x > 0 && x < 1 ? 'under 1%' : `${Math.round(x).toLocaleString('en-GB')}%`; };
export const lookupPage = {
  whg: 'WHG',
  reading: 'Reading the places of your dataset…',
  noDataset: 'Choose your dataset first: its places are what is looked up.',
  placesNotRead: 'The places of your dataset could not be read, so there is nothing to look up.',
  busy: 'Wait for the work in hand to finish, then look up.',
  needToken: 'Give your WHG token first: WHG answers only queries that carry one.',
  tokenGiven: 'A token is given',
  tokenNone: 'No token given yet',
  forgotten: 'The token is forgotten. If it may have been seen anywhere else, regenerate it in WHG: that is the only way to revoke it.',
  /** The one line in place of Send (and of Find on the review screen) while the service's permission is set to Never, and its button, which opens Permissions there. */
  never: (name) => `Not allowed: ${name} is set to Never in Permissions.`,
  openPermissions: 'Permissions…',
  badEndpoint: "Give the reconciliation service's address, beginning https://.",
  badTemplate: "Give how to make a candidate's address from its id, with {{id}} in it, such as https://www.wikidata.org/wiki/{{id}}; or leave it empty.",
  /** The share of WHG's daily allowance a lookup would use. */
  share: (requests, perDay) => `That is ${pct(requests, perDay)} of WHG's allowance of ${perDay.toLocaleString('en-GB')} requests a day.`,
  /** The button that sends the lookup. */
  send: (n, service) => `Send ${plural(n, 'query', 'queries')} to ${service}`,
  sending: (service) => `Sending to ${service}…`,
  /** The progress line while a lookup runs. */
  progress: ({ done, total }, service) => `${done.toLocaleString('en-GB')} of ${plural(total, 'place')} looked up in ${service}…`,
  /** The button that takes up a stopped lookup again. */
  resume: (n) => `Resume: send ${plural(n, 'query', 'queries')}`,
  kept: 'What was answered is kept in the review below, and can be saved now.',
  /** Where the candidates of a group came from. */
  from: (title) => `From ${title}`,
  fromOthers: (title) => `From ${title}, the other dataset`,
  candidates: (n) => (n ? `${n === 1 ? 'One candidate' : `${n} candidates`}:` : 'No candidates yet.'),
  /** The gazetteer's own figures for a candidate, labelled as its own. */
  figures: (g, service) => {
    const parts = [g.score != null ? `score ${g.score.toLocaleString('en-GB')} (relative to the best in this search)` : '',
      g.confidence != null ? `confidence ${g.confidence.toLocaleString('en-GB')} (name only)` : ''].filter(Boolean);
    return parts.length ? `${service}'s own figures: ${parts.join(', ')}. Neither says it is the same place.` : '';
  },
  described: (service, text) => `${service} describes it: ${text}`,
  /** A candidate far away: shown, marked, never hidden. */
  far: (km) => `Far: ${LOOKUP_WORDS.far(km)}`,
  /** A candidate's licence, from the attribution the service sent; a warning when it limits use, and "licence unknown" never shown as fine. */
  licence: (l) => {
    const text = `Licence of its source: ${LOOKUP_WORDS.licence(l)}`;
    if (!l) return `${text}. Check its source's terms before you use its data.`;
    if (l.commercial === false || l.redistributable === false) return `${text}. Check the terms before you use or pass on its data.`;
    return `${text}.`;
  },
  licenceWarns: (l) => !l || l.commercial === false || l.redistributable === false,
  /** Single-place lookups on the review screen. */
  find: (service) => `Find this place in ${service}…`,
  findLabel: 'The name to look for. You may change it; only this name is sent. What it finds is added to the candidates already here, which it does not replace.',
  findSend: 'Send 1 query',
  tryNames: (n) => `Not found? Try its other names (${plural(n, 'query', 'queries')})`,
  again: 'Look it up again',
  /** What a lookup said about this place, when it found nothing or could not answer. */
  state: (service, q) => (q.state === 'answered' ? `${service}: ${LOOKUP_WORDS.notFound(q)}`
    : q.state === 'unanswered' ? `${service}: ${LOOKUP_WORDS.unanswered}`
    : `${service}: the lookup stopped before this place was looked up; this is not a finding that it has no match. Look it up again.`),
  /** What finishing will cite: one attestation per source. */
  cites: (sources) => (sources.length
    ? `Finishing makes one attestation for each source a place's decisions rest on, citing ${sources.map((s) => (s['@id'] ? `${s.title} (${s['@id']})` : s.title)).join('; ')}.`
    : 'Nothing is decided yet, so finishing would make no attestations.'),
};
