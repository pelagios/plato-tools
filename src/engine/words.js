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
const ONE = { 'earlier attestations': 'earlier attestation', 'earlier candidates': 'earlier candidate', annotations: 'annotation', places: 'place', attestations: 'attestation', 'identity relations': 'identity relation', candidates: 'candidate', triples: 'triple', 'triples written': 'triple written', 'table rows': 'table row', observations: 'Data Cube observation' };
const MANY = { observations: 'Data Cube observations' };
ONE['place names'] = 'place name';
ONE.rows = 'row'; ONE.features = 'feature';
// The candidates of the candidate sets given with a check (Elenchos: --candidates), read beside its input.
ONE['candidates given'] = 'candidate in the candidate sets given'; MANY['candidates given'] = 'candidates in the candidate sets given';
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
  if (action === 'candidates') return candidatesSummary(report);
  // The regions a table's places lie in, minted as places (Hermes, generic.js), are among the places, and said apart.
  const regions = (k) => (k === 'places' && c.regions ? ` (${c.regions.toLocaleString('en-GB')} of them ${c.regions === 1 ? 'a region' : 'regions'})` : '');
  const counted = ['annotations', 'place names', 'rows', 'features', 'places', 'attestations', 'identity relations', 'candidates', 'candidates given', 'triples', 'triples written', 'table rows', 'observations'].filter((k) => c[k]).map((k) => count(c[k], k) + regions(k)).join(', ');
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

/**
 * The summary of a version check: whether the append-only rule holds, and what became of the earlier
 * attestations, or, for two copies of a candidate set (counts.of 'candidates'), of its candidates.
 */
function compareSummary(report) {
  const c = report.counts, n = (x) => (x || 0).toLocaleString('en-GB'), what = c.of === 'candidates' ? 'candidates' : 'attestations';
  if (c.earlier === undefined) return { problems: 'The two versions could not be compared.', counted: '' };
  const parts = [`${n(c.unchanged)} unchanged`];
  if (c.changed) parts.push(`${n(c.changed)} changed`);
  if (c.lost) parts.push(`${n(c.lost)} no longer there`);
  const withdrawn = [c.retracted ? `retracts ${n(c.retracted)}` : '', c.superseded ? `replaces ${n(c.superseded)}` : ''].filter(Boolean).join(' and ');
  const nErr = report.errors;
  return {
    problems: nErr ? `${n(nErr)} problem${nErr === 1 ? '' : 's'} found.`
      : c.unchanged === c.earlier ? 'Nothing was deleted or changed.' : 'The append-only rule is not broken, but see the warnings.',
    counted: `Of ${count(c.earlier, `earlier ${what}`)}, ${parts.join(', ')}. The later version has ${count(c.later, what)}, ${n(c.added)} of them new${withdrawn ? `; it ${withdrawn} of the earlier ones` : ''}.`,
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
  if (action === 'candidates') return candidatesGroups();
  if (action === 'compare') return [
    { severity: 'error', title: 'Problems', intro: 'These break the append-only rule: once a dataset is published, its attestations are added to, never deleted or changed; once a candidate set is issued, its candidates are never deleted or changed.' },
    { severity: 'warning', title: 'Warnings', intro: 'Worth a look; none of these breaks the rule.' },
  ];
  return [
    { severity: 'error', title: 'Problems', intro: 'These must be fixed for the data to be valid PLATO.' },
    { severity: 'warning', title: 'Warnings', intro: 'Worth a look; the data can still be used.' },
    { severity: 'loss', title: checking ? 'Would not be carried over' : 'Not carried over',
      intro: checking ? 'PLATO JSON has no place for these, so a conversion to it would leave them out.' : 'The target format has no place for these, so they are left out.' },
    ...(checking ? [{ severity: 'note', title: 'Notes', intro: 'Not problems: what this check could not do with what it was given, and how to let it.' }] : []),
  ];
}

// ---- Hermes: matching the columns of a table of places (a CSV file, or plain GeoJSON) to PLATO ----
// The page shows the guess (src/engine/hermes/columns.js, guessColumns) as a table, one choice for
// each column, before anything is checked or converted. The fields are named in plain words here;
// the JSON saved and loaded keeps the engine's own names (the format --columns takes).
/** Each choice a column can be given, in the order the page offers them. `properties` is never one. */
export const COLUMN_CHOICES = {
  name: 'Name', alternativeNames: 'Alternative names', latitude: 'Latitude', longitude: 'Longitude',
  wkt: 'Point or shape, as WKT text', geometry: 'Point or shape, as GeoJSON', gridref: 'Grid reference (Ordnance Survey, Irish Grid)', id: 'Place id', address: "Place's web address",
  type: 'Kind of place', language: 'Language of the name', source: 'Source', date: 'Date, as the source writes it',
  start: 'Earliest date', end: 'Latest date', within: 'Region it lies in', split: 'Regions, to split into levels',
  note: 'Keep as a note', skip: "Don't carry over",
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
  /** A region the place lies in (columns.js, "within"): its level, beside the choice. Levels count from the widest. */
  level: 'Level',
  levelLabel: (col) => `The level of the region in the column “${col}”: 1 is the widest`,
  levelTip: 'Regions are numbered from the widest: 1 for the widest (a country, say), then 2, 3… for the regions inside it. Choosing a level another column has swaps the two.',
  levelSwapped: (col, level) => `your choice: level ${level}, swapped with the column “${col}”`,
  /** A column of several regions in one cell, split into levels (columns.js, "split"). */
  splitOn: 'Split on', splitOnLabel: (col) => `What separates the parts of the column “${col}”`,
  splitLevels: 'Levels, narrowest first', splitLevelsLabel: (col) => `The levels the parts of the column “${col}” go to, narrowest first`,
  splitName: "The first part is the place's name",
  splitTip: 'A cell such as “Rotherhithe, Surrey, England” is split where the separator is. Its parts, narrowest first, go to the levels given (1 is the widest): 3, 2, 1 for a parish, a county and a country. Parts beyond the levels given are named in the report.',
  splitLevelsBad: 'Give the levels as whole numbers of 1 or more, each once, separated by commas, narrowest first, such as 3, 2, 1.',
  splitSeparatorEmpty: 'Give what separates the parts, such as a comma.',
  sameLevel: (cols, level) => `${cols.map((c) => `“${c}”`).join(' and ')} are both at level ${level}, and each level is one column: the second is kept as a note. Give each region a level of its own.`,
  gazetteerNotAddress: (col, cli) => `The column “${col}” is named for a gazetteer or a web address, but no column is read as the place's web address, so no row will be linked to a gazetteer's place: each is read as a new place. If “${col}” holds the places' addresses, ${cli ? 'map it to "address" in the mapping given with --columns' : 'choose “Place\'s web address” for it'}.`,
};
/**
 * The warnings a matching deserves before it is used, in words: a column named for a gazetteer
 * (`gazetteer`, columns.js's gazetteerColumns) when no column is the address, no ids or addresses,
 * half a coordinate pair.
 */
export function columnWarnings(mapping, gazetteer = [], suggested = {}, patterns = {}, levels = {}, splits = {}) {
  const fields = new Set(Object.values(mapping || {}));
  const out = gazetteerWarnings(mapping, gazetteer, { suggested, patterns });
  // Two regions at one level (a "within" column's, or a split's parts').
  const at = new Map();
  for (const [h, f] of Object.entries(mapping || {})) {
    const ls = f === 'within' && Object.hasOwn(levels, h) ? [levels[h]] : f === 'split' && Object.hasOwn(splits, h) ? splits[h].levels : [];
    for (const l of ls) at.set(l, [...(at.get(l) || []), h]);
  }
  for (const [l, cols] of at) if (new Set(cols).size > 1) out.push(COLUMN_WORDS.sameLevel([...new Set(cols)], l));
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

// ---- Hermes: a pasted list of names ---------------------------------------------------------------
// The box under the drop zone (src/app.js): a list pasted, one name a line, is read as a table of
// places of one column, "name" (src/engine/hermes/pasted.js), as a file dropped would be.
export const PASTE_WORDS = {
  summary: 'Or paste a list of names',
  label: 'Paste a list of names, one per line',
  use: 'Use this list',
  note: 'Read as a table of places with one column, “name”, as a file dropped here would be.',
  empty: 'There are no names to use: paste one name on each line.',
};

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

// ---- Hermes: grouping similar spellings for lookup (src/engine/hermes/cluster.js) -------------------
// Grouping never changes the source's spellings: a group the user ticks gives its members a spelling
// to look the place up by, carried beside the record and noted in its attestation.
const listed = (xs, most = 10) => (xs.length > most ? `${xs.slice(0, most).join(', ')} and ${xs.length - most} more` : xs.join(', '));
export const CLUSTER_WORDS = {
  methods: { fingerprint: 'Same letters and words (case, accents, punctuation and word order ignored)', 'ngram-fingerprint': 'Same pairs of letters (spacing ignored too; groups more, wrongly too)', phonetic: 'Sounds alike (Cologne phonetics; groups the most, wrongly too)' },
  // The note on each attestation whose value was grouped: `others` the group's other spellings.
  note: (others, chosen, column) => `${column ? `The column "${column}" grouped` : 'Grouped'} for lookup with: ${listed(others)} (spelling chosen: ${chosen})`,
  unknownMethod: (m, methods) => `"${m}" is not a way of grouping spellings; the ways are ${methods.join(', ')}.`,
  notAnObject: 'The groups of spellings must be one JSON object, {"column name": {"method": "fingerprint", "groups": [{"chosen": "…", "members": ["…", "…"]}]}}.',
  columnShape: (c) => `The groups of spellings for the column "${c}" must be an object with a list of "groups".`,
  groupShape: (c, n) => `Group ${n} of the spellings for the column "${c}" must have a "chosen" spelling and a list of "members", each a spelling.`,
  memberTwice: (c, m) => `The spelling "${m}" is in two groups for the column "${c}", so which spelling it is looked up by cannot be told. Keep it in one group.`,
  // The report: groups for a column the file does not have.
  noColumnKind: 'Groups of spellings for a column the file does not have were not used',
  // The page.
  button: 'Group similar spellings…',
  tip: 'Finds spellings in one column that may be the same name (Rotherhith, Rotherhithe), for you to group so that the place is looked up by one spelling. Nothing is changed unless you tick a group, and the names in the PLATO file always keep the source’s spelling.',
  legend: 'Group similar spellings for lookup',
  intro: 'Tick a group to look its spellings up by the spelling chosen. The names in the PLATO file keep the source’s own spellings; each grouped row gets a note saying what it was grouped with.',
  columnLabel: 'Column', methodLabel: 'How', find: 'Find groups', close: 'Close',
  finding: 'Reading the column…',
  none: (column, n) => `No spellings in "${column}" group together this way (${n.toLocaleString('en-GB')} different ${n === 1 ? 'value' : 'values'} read).`,
  found: (k, column, n) => `${k.toLocaleString('en-GB')} ${k === 1 ? 'group' : 'groups'} of similar spellings in "${column}" (${n.toLocaleString('en-GB')} different values read). None is used until you tick it.`,
  caption: (column) => `Groups of similar spellings in "${column}"`,
  use: 'Use', spellings: 'Spellings (rows)', chosen: 'Look up as',
  useLabel: (chosen) => `Use the group looked up as “${chosen}”`,
  chosenLabel: (first) => `The spelling to look up the group of “${first}” by`,
  chosenEmpty: 'Give a spelling to look the group up by, or untick it.',
  ticked: (n) => (n ? `${n} ${n === 1 ? 'group' : 'groups'} ticked: ${n === 1 ? 'its' : 'their'} rows are looked up by the spelling chosen.` : 'No group is ticked, so no spelling is grouped.'),
  loaded: (n, columns) => `${n} ${n === 1 ? 'group' : 'groups'} of spellings loaded with the matching, for ${columns.map((c) => `"${c}"`).join(', ')}.`,
  cannotRead: (message) => `The column could not be read: ${message}`,
  // A ticked group that "Find groups" did not find again: kept, still ticked, after the groups found.
  savedNotFound: 'From the saved matching, not found this way.',
  tickedNotFound: 'Ticked before, not found this way.',
  carried: (n) => `${n.toLocaleString('en-GB')} ticked ${n === 1 ? 'group' : 'groups'} not found this way ${n === 1 ? 'is' : 'are'} kept at the end of the list, still ticked.`,
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
/**
 * The note an attestation made from a language model's suggestion carries (src/engine/hermes/text/
 * attest.js): who suggested it, with which prompt and when, and that a person confirmed and linked it;
 * the model's guess at the kind of place when the reviewer did not confirm one; and the span the model
 * gave when the reviewer adjusted it.
 */
export function hermesTextNote({ model, provider, prompt, date, kindGuess, adjustedFrom }) {
  let n = `Suggested by ${model} (${provider}), prompt ${prompt}, ${date}; confirmed and linked by the contributor.`;
  if (kindGuess) n += ` The model's guess at the kind of place, not confirmed: ${kindGuess}.`;
  if (adjustedFrom) n += ` The contributor adjusted the span from characters ${adjustedFrom[0]} to ${adjustedFrom[1]}.`;
  return n;
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
// Krisis: the suggestions exported as a candidate set (src/engine/krisis/candidates.js), and the
// answers that point back at them (promotedFrom), on the page and the command line.
/** "3 candidates were already published …": the count of candidates an export left out. */
const leftOutText = (n) => `${plural(n, 'candidate was', 'candidates were')} already published in an earlier candidate set and ${n === 1 ? 'is' : 'are'} left out of this one; answers to ${n === 1 ? 'it point at its earlier IRI' : 'them point at their earlier IRIs'}.`;
export const KRISIS_CANDIDATES = {
  leftOut: leftOutText,
  allLeftOut: (n) => `Every candidate of this review was already published in an earlier candidate set, so there is nothing new to publish and no candidate set was written. ${leftOutText(n)}`,
  workFileOnly: 'What the work file keeps for the review (each suggestion\'s distance and description of the other place, the decisions, the reviewer\'s place in the review) is not part of a candidate set and is not exported: a candidate records only what the software suggested. The decisions become attestations when the review is finished.',
  noDatasetIri: 'The dataset of the places matched has no address of its own (its gazetteer has no @id), and a candidate set must say which dataset its suggestions are for. Give the dataset an @id in its gazetteer header, match again, and export then.',
  noCandidates: 'This review has no suggestions, so there is no candidate set to export.',
  badIssued: (d) => `The date of issue must be written as YYYY-MM-DD, not ${d}.`,
  badSetIri: (iri) => `The candidate set's address must be a web address (an IRI), not ${iri}.`,
  setIriTaken: (iri) => `The address ${iri} is an earlier candidate set's, given as such; a new set needs an address of its own.`,
  notASet: (where) => `${where} is not a PLATO candidate set: it must have the profile candidate-set, a candidateSet with an @id, and candidates each with an @id, subject, object and algorithmVersion.`,
  earlierSetN: (n) => `Earlier candidate set ${n}`,
  previousNotGiven: (iris) => `This review was last exported against ${iris.length === 1 ? 'an earlier candidate set' : 'earlier candidate sets'}, ${iris.join(', ')}, which ${iris.length === 1 ? 'is' : 'are'} not given now. Give ${iris.length === 1 ? 'it' : 'them'} again: without ${iris.length === 1 ? 'it' : 'them'}, candidates already published would be published again.`,
  earlierForAnother: (iri, theirs, ours) => `The earlier candidate set ${iri} is for another dataset (${theirs}), not for ${ours}.`,
  noAlgorithm: (id) => `Candidate ${id} does not say which software suggested it (algorithm_version).`,
  noGeneratedAt: (id) => `Candidate ${id} does not say when it was suggested (generated_at).`,
  sameHash: (h) => `Two suggestions are the same: they have the same place, the same other place, the same software and the same settings, so they are one suggestion, and no candidate set was written. (Both hash to ${h}.)`,
  earlierExportNotGiven: 'This review was exported before, as the candidate set named here, which is not given now as an earlier set. If that set was published, give it as an earlier candidate set and export again: otherwise its candidates are published a second time, under new addresses. If it was not published, this set replaces it.',
  /** The candidate set's title and description. */
  title: (subjects, others, issued) => `Matches suggested for ${subjects} in ${others}, ${issued}`,
  /** What a review by gazetteer lookup only sought its suggestions in, for the title and description. */
  gazetteers: (titles) => (titles.length ? titles.join(', ') : 'a gazetteer'),
  description: (subjects, others, algorithm) => `What PLATO tools (Krisis) suggested by comparing names (${algorithm}), as it suggested it, for the places of ${subjects} in ${others}. What the reviewer made of each suggestion is in the dataset, in the attestations whose identity relations point here through promotedFrom.`,
  // Finishing a review that was exported (apply.js).
  notUnderSet: 'A suggestion the review answers has an address that is not under the candidate set last exported from this review, nor under an earlier candidate set given, so nothing was written. Export the suggestions again, or give the candidate set the address belongs to.',
  notInSet: 'A suggestion the review answers is not in the candidate set given that its address belongs to, or is there for other places, so nothing was written. Is this the candidate set exported from this review?',
  givenNotASet: 'A candidate set given is not one these tools can point into, so nothing was written',
  givenForAnother: 'A candidate set given is for another dataset than the one reviewed, so nothing was written',
  givenNotValid: 'A candidate set given does not match the PLATO JSON Schema for candidate sets, so nothing was written',
  noGazetteerId: 'The dataset written has no address of its own (its gazetteer has no @id), so it cannot list the candidate sets its new attestations answer (candidateSets), and nothing was written. Give the dataset an @id in its gazetteer header.',
  setsNotWritten: 'The candidate sets the new attestations answer could not be added to the dataset\'s header, which is a fault in the tools (please report it); nothing was written.',
  notExported: 'Some of the suggestions the review answers are in no candidate set exported from it, so their answers do not say which suggestion they answer (promotedFrom). Export the suggestions again before finishing to include them.',
  publishSets: 'The new attestations answer suggestions in these candidate sets, and point at them (promotedFrom). Publish each candidate set wherever the dataset is published, so that the answers can be followed to what they answer.',
  // The page (src/app.js, the review screen).
  earlierGiven: (n) => `${plural(n, 'earlier candidate set')} given: ${n === 1 ? 'its' : 'their'} candidates will be left out of the set exported.`,
  saveReviewToo: 'Save the review as well: it now records each candidate\'s address, which finishing points at.',
};
/** The summary of exporting a candidate set: how many candidates it holds, and how many were left out. */
function candidatesSummary(report) {
  const c = report.counts, nErr = report.errors;
  if (c.candidates === undefined) return { problems: nErr ? `${plural(nErr, 'problem')} found.` : 'The candidate set could not be made.', counted: '' };
  if (!c.candidates) return { problems: 'No candidate set was written: every candidate was published already.', counted: leftOutText(c.leftOut) };
  return {
    problems: nErr ? `${plural(nErr, 'problem')} found.` : 'The suggestions were exported as a candidate set.',
    counted: `It holds ${plural(c.candidates, 'candidate')}${c.lengthened ? `, ${plural(c.lengthened, 'of which has', 'of which have')} a longer address to tell it from another` : ''}.${c.leftOut ? ' ' + leftOutText(c.leftOut) : ''}`,
  };
}
const candidatesGroups = () => [
  { severity: 'error', title: 'Problems', intro: 'No candidate set was written because of these.' },
  { severity: 'warning', title: 'Warnings', intro: 'Worth a look before the candidate set is published.' },
  { severity: 'loss', title: 'Not exported', intro: 'A candidate set has no place for these.' },
];
// ---- Chora (the map viewer and editor) -----------------------------------------------------------
/**
 * What a drawing's notes say of how it was made, since PLATO has no term for it: "Drawn by hand on
 * the Natural Earth basemap at zoom 9 in PLATO tools (Chora)". A pasted basemap is not named: its
 * site may be a private one, and the notes are published with the dataset.
 */
export const PASTED_BASEMAP = 'a basemap pasted by the contributor';
export const choraDrawingNote = ({ basemap = 'Natural Earth', zoom } = {}) =>
  `Drawn by hand on ${basemap === PASTED_BASEMAP ? basemap : `the ${basemap} basemap`}${Number.isFinite(zoom) ? ` at zoom ${Math.round(zoom)}` : ''} in PLATO tools (Chora)`;

// Adopting a location from a gazetteer match (src/engine/chora/adopt.js). Both notes give the record's
// address verbatim, so that the two attestations of one adoption can be paired by their text.
/** A record as the notes name it: its address, then its name, upstream source and id there. */
// A WHG record of its own (namespace whg) is named with its contributed dataset: its name and id, which outlast a re-upload's change of record id.
const ownRecord = (sourceName, dataset) => `the gazetteer's own record${sourceName || dataset ? `, from dataset ${[sourceName ? `"${sourceName}"` : null, dataset ? `(${dataset})` : null].filter(Boolean).join(' ')}` : ''}`;
const recordWords = ({ record, name, sourceName, namespace, localId, dataset }, more = []) =>
  `${record} (${[name ? `"${name}"` : null, namespace ? `upstream source: ${sourceName ? `${sourceName} (${namespace})` : namespace}` : ownRecord(sourceName, dataset), localId ? `id ${localId}` : null, ...more].filter(Boolean).join('; ')})`;
/** The identity's notes. */
export const choraAdoptIdentityNote = (r) =>
  `Accepted in PLATO tools (Chora) when adopting the location of World Historical Gazetteer record ${recordWords(r)}. The location copied from the record is a separate attestation.`;
/**
 * The copied geometry's notes. `licence` and `whgLicence` are SPDX ids or null; `fallback` says the
 * record could not be fetched and WHG's representative point was taken instead; `linked` that the
 * identity was already in the dataset, so none was recorded with this.
 */
export const choraAdoptGeometryNote = ({ licence, whgLicence, fetched, fallback = false, linked = false, ...r }) => {
  const record = recordWords(r, [`licence ${licence || 'not stated'}`, `World Historical Gazetteer's own licence: ${whgLicence || 'not stated'}`]);
  return `${fallback ? `World Historical Gazetteer's representative point for record ${record}, copied` : `Copied from World Historical Gazetteer record ${record}`}, fetched ${String(fetched).slice(0, 10)};`
  + `${fallback ? " the record itself could not be fetched, so this is only WHG's representative point, not the record's geometry;" : ''}`
  + ' coordinates rounded to 7 decimal places; in PLATO tools (Chora). '
  + (linked ? 'The identity with this record was already recorded in the dataset.' : 'The identity with this record is a separate attestation.');
};
/** What an adoption tells the person adopting, beside the attestations (adopt.js, notes), by kind. */
export const CHORA_ADOPT_TEXT = {
  'already-linked': 'This place is already recorded as the same as this record, so only its location is added.',
  'loosely-linked': 'This place is already linked to this record, but not as the same place: adopting records that it is.',
  'licence-restricted': (spdx) => `The record's source is licensed ${spdx}; this may bear on how the copied location can be reused.`,
  'licence-unknown': "The gazetteer does not say under what licence the record's source may be reused.",
  'unstable-id': "This is one of the gazetteer's own records, whose id may change if its dataset is uploaded again: its name and dataset are kept in the notes.",
  'representative-point-only': "The record could not be fetched, so only the gazetteer's representative point is offered, not the record's own geometry.",
  // Refusals: nothing is recorded. ('geometry' and 'when' give their own reasons.)
  'no-address': 'This place has no address (@id) in the dataset, so nothing can be recorded about it here. Give it one first.',
  denied: 'The dataset already says this place and this record are different places. To change that, use Krisis.',
  unavailable: "The record's source does not allow the gazetteer to pass it on, so nothing is copied: the record was consulted, not copied. You can draw the location yourself, citing the record as evidence.",
  'no-geometry': "There is no geometry to adopt: choose one of the record's geometries.",
  'no-record': 'This candidate has no address in the gazetteer, so it cannot be adopted.',
  'same-address': "This place's address is the record's own, so it is already that record: only its location is added.",
  error: (why) => `This could not be adopted: ${why}`,
  /** A lookup or a record fetch that gave no answer (adopt.js lookupProblem). */
  problem: {
    quota: "The World Historical Gazetteer's allowance of requests for today is spent. Your token is kept: try again tomorrow.",
    auth: 'The World Historical Gazetteer refused the token. Give it again (from your WHG profile), or forget it.',
    permission: 'The World Historical Gazetteer is not allowed in Permissions now, so nothing was sent.',
    rate: 'The World Historical Gazetteer still refused the query as one too many after waiting. Try again in a minute.',
    network: 'The World Historical Gazetteer could not be reached. Try again when it can.',
    server: 'The World Historical Gazetteer refused or failed the request. Try again later.',
    unanswered: 'The World Historical Gazetteer did not answer this query; this is not a finding that it has no such place. Try again.',
  },
};
/** Chora's page for adopting a location (src/chora/adopt-ui.js), in words. */
export const CHORA_ADOPT_PAGE = {
  find: 'Find in a gazetteer…',
  /** Why the button is disabled, shown beside it. */
  noAddress: 'This place has no address (@id) in the dataset, so a gazetteer record cannot be adopted for it: give it one first.',
  heading: 'Find in the World Historical Gazetteer',
  queryLabel: 'The name to look for (only this is sent, with the type Place)',
  tokenLabel: 'Your WHG token',
  tokenUse: 'Use this token',
  tokenNeeded: 'Give your WHG token first: WHG answers only queries that carry one. It is kept as Permissions says.',
  tokenGiven: 'A token is given.',
  forget: 'Forget the token',
  send: 'Look up',
  sending: 'Asking the World Historical Gazetteer…',
  close: 'Close',
  /** How the candidates are ordered (adopt.js rankCandidates), said once above them. */
  order: { point: "In order of distance from this place's own location.", box: (from) => `Those inside the area of ${from === 'related' ? 'the places it is related to' : 'its countries'} first, each group in the gazetteer's order.`, none: "No geographic reference: the gazetteer's order." },
  none: 'The gazetteer found no candidates for that name.',
  caveat: "Nothing is chosen for you: the gazetteer's score is relative to its best answer, and its confidence measures the name only.",
  distance: (km) => `${km.toLocaleString('en-GB')} km away`,
  inside: 'inside the area', outside: 'outside the area',
  noCoords: 'no coordinates given, so not on the map',
  sameSpelling: 'same spelling',
  linked: 'Already recorded in your dataset as the same place as this record.',
  loose: 'Already linked to this record in your dataset, but not as the same place.',
  denied: 'Your dataset says this is a different place (change that in Krisis).',
  krisisUnsaved: 'Decisions made in Krisis and not yet saved into the dataset open here are not seen.',
  preview: 'Show the record',
  useLocation: 'Use its location',
  notThis: 'Not this one',
  different: 'Different places? Record it in Krisis ↗',
  dismissed: (n) => `${n === 1 ? 'One candidate' : `${n} candidates`} set aside as not this one, for this visit only.`,
  fetching: 'Fetching the record…',
  geometries: "The record's locations: choose one",
  role: 'What it marks',
  basis: 'Why they are the same place (optional, kept with the identity)',
  adopt: 'Adopt: this place is that record, located there',
  adoptLinked: "Adopt the record's location",
  consulted: 'This record was consulted, not copied: its source does not allow it to be passed on.',
  drawInstead: 'Draw it yourself, citing the record as consulted',
  drawArmed: (name) => `Draw on the map: the next drawing for this place cites ${name} as consulted.`,
  adopted: (n) => `Adopted: ${n === 2 ? 'two attestations (the identity and the location) are' : 'one attestation (the location) is'} waiting to be saved.`,
  pendingItem: (name) => `Adopted from ${name}`,
  consultedItem: (name) => `Cites ${name} as consulted (nothing copied from it)`,
  when: (t) => `dated ${t}`,
  noRecordGeometry: 'The record gives no location.',
  repOnly: "WHG's representative point only",
  cluster: 'This place is linked to a WHG cluster page; whether it holds this record is not known.',
  cancelDraw: 'Cancel',
  reloadLoses: 'The gazetteer lookup on screen, and its answers (anything adopted is kept).',
};
/** A hand-drawing's notes, after how it was drawn, for a record consulted and not copied (adopt.js consultedParts). */
export const choraConsultedNote = (r) =>
  `Drawn consulting World Historical Gazetteer record ${recordWords(r)}, whose source does not allow it to be passed on: nothing was copied from it.`;
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
  'chora-unreadable': 'The dataset could not be read to the end, so it was not saved',
  'chora-in-another-tab': 'Chora is already open in another tab of this browser. Close it, or use that one.',
  'chora-mneme-failed': 'The version check (Mneme) found that the saved file does not keep every attestation of the dataset exactly as it was, or does not add exactly the drawings. Do not use it.',
  'chora-not-kept': 'The saved file could not hold the dataset exactly as it was read, so it was not checked, kept or offered, and nothing was saved. Why:',
};
/**
 * A problem of a save, in words for the page: its text (CHORA_TEXT, else its message), then its first
 * examples after a colon, unless the text ends with one of its own.
 */
export function choraProblemText(i) {
  const text = CHORA_TEXT[i.kind] || i.message;
  return i.examples?.length ? `${text}${text.endsWith(':') ? ' ' : ': '}${i.examples.slice(0, 3).join('; ')}` : text;
}
/**
 * The storage warning, for `when` 'load' or 'save', from storageShort() (src/engine/chora/storage.js):
 * what is needed, what is left, and what to do about it.
 */
export function choraStorageWarning(when, { need, free, quota }) {
  const left = `this browser has only ${fmtBytes(Math.max(0, Math.round(free)))} left for this site (of the ${fmtBytes(quota)} it allows)`;
  return when === 'save'
    ? `Saving needs about ${fmtBytes(Math.round(need))} of the browser's storage, for the file and the version check's working copy, and ${left}. The save may stop part-way. Free some disk space, then save.`
    : `Opening this dataset needs about ${fmtBytes(Math.round(need))} of the browser's storage, for Chora's working copy of it, and ${left}. It may stop part-way. Free some disk space, or use an ordinary window: a private one keeps its storage in memory and allows very little.`;
}
/**
 * What a Chora save writes, for a dataset as detect() describes it: JSON Lines as JSON Lines, since PLATO
 * has that format and it keeps each line as it came; anything else as a PLATO JSON document.
 */
export function choraSavedFormat(input) {
  return input?.format === 'plato-jsonl' ? { target: 'plato-jsonl', words: 'PLATO JSON Lines' } : { target: 'plato-json', words: 'PLATO JSON' };
}
/**
 * A step of a Chora save in words, from a progress event that says which (`save`, set by save.js):
 * "Saving, step 1 of 2, writing the file: 700,000 of 1,414,328 attestations (1 min 5 s)".
 */
export function choraSaveProgress(p) {
  const n = (x) => x.toLocaleString('en-GB');
  const what = p.attestations !== undefined ? `${n(p.attestations)}${p.total ? ` of ${n(p.total)}` : ''} attestation${p.attestations === 1 && !p.total ? '' : 's'}`
    : p.triples ? `${p.phase === 'indexing' ? 'indexing' : 'loading'} ${count(p.triples, 'triples')}`
    : p.rows ? `${p.phase === 'checking' ? 'checking the tables' : 'loading the tables'}: ${count(p.rows, 'rows')}`
    : p.phase === 'checking' ? 'checking the tables'
    : p.places ? count(p.places, 'places') : '';
  const time = ` (${fmtTime(p.elapsedMs || 0)})`;
  if (p.save === 'finding') return `Saving: first reading the dataset, to find the places drawn on${what ? `: ${what}` : ''}${time}`;
  if (p.save === 'writing') return `Saving, step 1 of 2, writing the file${what ? `: ${what}` : ''}${time}`;
  const check = 'Saving, step 2 of 2, the version check (Mneme)';
  if (p.phase === 'comparing') return `${check}, comparing the two${time}`;
  if (p.phase === 'done') return `${check}, finishing${time}`;
  const which = p.version === 'later' ? 'the file written' : 'the dataset as opened';
  return `${check}, ${p.again ? 'again, to show what changed, ' : ''}reading ${which}${what ? `: ${what}` : ''}${time}`;
}
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

// Krisis × Methodos (#28): WHG's guards, the bulk accept, query variants, flags, notes and row states
// (src/engine/krisis/guards.js, names.js queryVariants, work.js; the review screen in src/app.js).
const guardFigures = (g) => (g.exact ? 'exact title' : [g.score != null ? `score ${g.score.toLocaleString('en-GB')}` : '',
  g.confidence != null ? `confidence ${g.confidence.toLocaleString('en-GB')}` : g.dice != null ? `names ${Math.round(g.dice * 100)}% alike by WHG's measure` : ''].filter(Boolean).join(', '));
const GUARD_FAILS = {
  'not-top': 'not the top of its answer', 'head-word': 'found only by its head word', weak: 'neither an exact title nor a score of 90 or more',
  withheld: 'withheld: the name is too unlike', tie: 'tied with another candidate', 'not-recorded': 'looked up before the guard was recorded; look it up again to judge it',
};
export const guardWords = {
  /** The basis each decision of the bulk accept carries, naming the guard (recorded with the attestation). */
  basis: (g) => `Accepted in bulk by the reviewer as passing WHG's guard (${guardFigures(g)}).`,
  /** The badge of a candidate that passes: "Passes WHG's guard: exact title", "…: score 94, confidence 41". */
  passes: (g) => `Passes WHG's guard: ${guardFigures(g)}`,
  /** Why a looked-up candidate does not pass. */
  fails: (reason) => `Does not pass WHG's guard: ${GUARD_FAILS[reason] || reason}`,
  orderLabel: 'Order',
  orders: { file: 'As in the file', guards: "WHG's guards first" },
  /** The bulk accept's button, and the type chosen beside it. */
  accept: (n) => `Accept the ${n.toLocaleString('en-GB')} that pass WHG's guards`,
  typeLabel: 'as',
  none: "No place has exactly one candidate passing WHG's guards and no decision yet.",
  /** After the bulk accept: how many, and that they are the reviewer's. */
  accepted: (n) => `${n.toLocaleString('en-GB')} accepted as yours.`,
  undo: 'Undo',
  undone: (n) => `${n.toLocaleString('en-GB')} taken back; any you changed since are kept.`,
  /** A place left out of the bulk accept for having namesakes where it was looked for (#31), on its own screen. */
  namesakes: (n, region) => `${n.toLocaleString('en-GB')} places of this name ${region ? `in ${region}` : 'where it was looked for'}: left for you, not accepted in bulk.`,
  /** Those left out of the bulk accept, and why. */
  leftOut: (l, several = 0, tied = []) => [
    l.total ? `${l.total.toLocaleString('en-GB')} left out: ${[l.far ? `${l.far.toLocaleString('en-GB')} further from the place than the greatest distance` : '', l.ccodes ? `${l.ccodes.toLocaleString('en-GB')} in another country than the place's own` : ''].filter(Boolean).join(', ')}. Decide on them yourself.` : '',
    several ? `${several.toLocaleString('en-GB')} ${several === 1 ? 'place has' : 'places have'} more than one passing, and ${several === 1 ? 'is' : 'are'} left to you.` : '',
    guardWords.ties(tied)].filter(Boolean).join(' '),
  /** The places left out for namesakes (#31), from how many places of its name each has: "1 place has 2 candidates of its name …". */
  ties: (tied = []) => {
    if (!tied.length) return '';
    const n = tied.length, least = Math.min(...tied), same = tied.every((c) => c === least);
    if (n === 1) return `1 place has ${least.toLocaleString('en-GB')} candidates of its name where it was looked for, and is left to you.`;
    return `${n.toLocaleString('en-GB')} places have ${least.toLocaleString('en-GB')}${same ? '' : ' or more'} candidates of their name where they were looked for, and are left to you.`;
  },
  /** The command line's dry run of a review: the count only; it never accepts. */
  dryRun: (n, l, several = 0, tied = []) => `${n.toLocaleString('en-GB')} ${n === 1 ? 'place has' : 'places have'} exactly one candidate passing WHG's guards and would be accepted (${[
    `${l.total.toLocaleString('en-GB')} more left out as far or in another country`,
    `${several.toLocaleString('en-GB')} with more than one passing`,
    `${tied.length.toLocaleString('en-GB')} with candidates of their name where they were looked for`].join(', ')}). Accepting them is done on the page only.`,
};
export const variantWords = {
  option: "Also send forms of each name (inverted, alternatives, without brackets, and its head word last), each as a query of its own (at most 10 a place; the preview shows the cost). A candidate found only by a head word never passes WHG's guards.",
  how: { given: 'as given', inverted: 'inverted', alternative: 'an alternative', brackets: 'without brackets', 'head-word': 'its head word' },
  /** Which form of the name found a candidate. */
  foundBy: (text, how) => `Found by ${variantWords.how[how] || how}: ${text}`,
};
export const rowWords = {
  flag: 'Flag', flagged: 'Flagged',
  noteLabel: 'Note (kept in the review only, never written to the dataset)',
  noteSave: 'Keep the note',
  stateLabel: 'This place',
  states: { reconcile: 'Reconcile', filter: 'Keep without reconciling', exclude: 'Leave out of the dataset' },
  /** In the report of finishing, and the version check's expectation. */
  leftOutReport: 'Left out of the dataset by the reviewer (row state "Leave out of the dataset"); the version check was told to expect exactly these missing',
};
/** The version check, told that places are left out on purpose (compare.js expectMissing). */
export const expectMissingWords = {
  present: 'A place the version check was told to expect missing (left out by the reviewer) is still in the later version, with what it said: it was not left out.',
  unknown: 'A place the version check was told to expect missing (left out by the reviewer) is not in the earlier version at all, so there was nothing of it to leave out: check that the review is of this dataset, and that the place was not renamed.',
};
/**
 * Krisis: region review (Methodos stages 3 and 4; src/engine/krisis/regions.js): the regions a
 * table's places lie in, looked up level by level from the widest, each constrained by the match of
 * the region above; then the places within them.
 */
const quoted = (k) => (typeof k === 'string' ? `"${k}"` : JSON.stringify(k));
export const REGION_WORDS = {
  /** readWork's refusals of what version 3 adds (each completes "This work file cannot be used: …"). */
  work: {
    noRegionsBefore: (v) => `it is of version ${v}, which has no regions (regions came in version 3).`,
    noRegions: 'it has no list of regions (regions).',
    regionNoKey: 'a region has no key.',
    regionShape: (k) => `the region ${quoted(k)} is not given as a label, names and a level (a whole number from 1, the widest).`,
    regionContainer: (k) => `the region ${quoted(k)} does not say which container of the source it is (container).`,
    regionWithin: (k, w) => `the region ${quoted(k)} lies within ${quoted(w)}, which is not a region the file lists.`,
    regionLevel: (k) => `the region ${quoted(k)} is not at a narrower level than the region it lies within.`,
    regionLoop: (k) => `the region ${quoted(k)} lies, through the regions above it, within itself.`,
    regionCount: (k) => `the region ${quoted(k)} does not say how many rows name it (count).`,
    regionOutcome: (k) => `the region ${quoted(k)} has an outcome that is not empty, matched or no-match.`,
    rowState: (k) => `the region ${quoted(k)} has a state that is not filter or exclude (rowState).`,
    regionArea: (k) => `the region ${quoted(k)} has an area that is not a box with a centre and a radius in kilometres, or a reason there is none.`,
    placeWithin: (iri, w) => `the place ${iri} lies within ${quoted(w)}, which is not a region the file lists.`,
    placeLevel: (iri) => `the place ${iri} gives a level that is not that of the region it lies within.`,
    certainty: (where, list) => `${where} has a certainty that is not one of ${list.join(', ')}.`,
    constraintFrom: (where) => `the lookup of ${where} was constrained by a region the file does not list (constraint.from).`,
    constraintKinds: (where, list) => `the lookup of ${where} names a constraint that is not one of ${list.join(', ')} (constraint.kinds).`,
    constraintParams: (where) => `the lookup of ${where} does not say what its constraint sent (constraint.params).`,
    constraintRelaxed: (where, list) => `the lookup of ${where} was relaxed in a way that is not one of ${list.join(', ')} (constraint.relaxed).`,
    scope: (id, iri) => `lookup ${id} records the gazetteer's word on a filter for ${iri} without saying whether it was applied (scope.applied).`,
  },
  /** A region's state in the review (regions.js regionState). */
  states: {
    locked: 'Waiting for the region above to be settled',
    ready: 'Ready to look up',
    review: 'Looked up; to review',
    settled: 'Settled',
  },
  /** A filter the gazetteer could not apply (scope.applied false) and so answered nothing: never "no match". */
  failedClosed: 'The gazetteer could not apply the region filter (it has no outline for the region above), so it answered nothing. This is not a finding that there is no match: look it up again with the filter relaxed.',
  approximate: 'The gazetteer applied the filter approximately (by cells of its grid), so a candidate just outside it may be kept, or one just inside left out.',
  /** What a constraint is, in words (regions.js constraintFor). */
  constraint(c, label = (k) => k) {
    if (!c.kinds.length) return c.relaxed === 'unconstrained' ? 'Looked up without a constraint, before the regions above it were settled.' : c.from === null && c.relaxed === null ? 'No constraint: no region above it is matched.' : 'No constraint (all relaxed).';
    const parts = c.kinds.map((k) => (k === 'contained_in' ? `within the gazetteer's ${plural(c.params.contained_in.length, 'record')} for ${label(c.from)}`
      : k === 'area' ? `within about ${c.params.radius.toLocaleString('en-GB')} km of the middle of ${label(c.from)}`
      : `in ${c.params.countries.join(', ')} (from the match for ${label(c.from)})`));
    return `Constrained to ${parts.join(', and ')}.${c.relaxed ? ` Relaxed: ${REGION_WORDS.relax[c.relaxed]}.` : ''}${c.kinds.includes('countries') ? ` ${REGION_WORDS.countriesAnded}` : ''}`;
  },
  countriesAnded: 'A filter by country leaves out every candidate with no country recorded, the right one too.',
  /** Each step of relaxing a constraint, in order. */
  relax: {
    countries: 'the countries dropped',
    'contained-in': 'an area in place of the gazetteer\'s region',
    ancestor: 'the region above that instead',
    all: 'no constraint',
    unconstrained: 'looked up before the regions above it were settled',
  },
  relaxUnknown: (v, list) => `--relax ${v} is not one of ${list.join(', ')}.`,
  /** A step asked for that does not apply to what would be looked up (regions.js relaxAvailable): refused, never sent unconstrained. */
  relaxUnavailable: (v, target, steps) => `--relax ${v} does not apply to ${target === 'places' ? 'the places within' : `the regions of level ${target}`}`
    + `${v === 'ancestor' ? ' (not every one has a matched region further up that gives a constraint)' : ' (not every one is sent what it would drop)'}, so nothing was looked up. `
    + `The steps that apply: ${steps.join(', ')}. Only --relax all${target === 'places' ? ' or --unconstrained' : ''} looks up without a constraint.`,
  /** Why a matched region has no area to constrain by (regions.js areaOf). */
  noArea: {
    'no-geometry': 'the gazetteer gives no geometry for its match',
    'point-only': 'the gazetteer gives only a point for its match, which is no area',
    unavailable: 'the gazetteer could not give its match\'s record',
  },
  /** The plan of a region review, level by level, before anything is sent (the command line's --dry-run). */
  plan(levels, places) {
    const out = [];
    for (const l of levels) {
      const s = l.states;
      out.push(`Level ${l.level}: ${plural(l.nodes, 'region')} (${[s.settled ? `${s.settled} settled` : '', s.review ? `${s.review} to review` : '', s.ready ? `${s.ready} ready` : '', s.locked ? `${s.locked} waiting for the level above` : ''].filter(Boolean).join(', ') || 'none'}).`);
      for (const r of l.ready.slice(0, 20)) out.push(`  ${r.label}: ${r.constraint}${r.needsArea ? ' (its area is fetched first)' : ''}`);
      if (l.ready.length > 20) out.push(`  and ${plural(l.ready.length - 20, 'more region')}.`);
    }
    if (places) out.push(`Places within: ${plural(places.ready, 'place')} ready, ${plural(places.locked, 'place')} waiting for ${places.locked === 1 ? 'its' : 'their'} regions${places.unconstrained ? ' (looked up anyway, without a constraint)' : ''}.`);
    return out;
  },
  /** What a run of one level, or of the places within, did. */
  ran: (what, n, failedClosed) => `${what === 'places' ? 'Places within their regions' : `Level ${what}`}: ${plural(n, what === 'places' ? 'place' : 'region')} looked up${failedClosed ? `; for ${failedClosed.toLocaleString('en-GB')} of them the gazetteer could not apply the filter, which is not "no match"` : ''}.`,
  nothingReady: 'Nothing is ready to look up: the regions above are not yet settled, or every region and place has been looked up.',
};
/** The basis a region's match is written with when the reviewer gave none: the constraint it was looked up under. */
REGION_WORDS.basis = (c, label = (k) => k) => (c && c.kinds?.length
  ? `Chosen by the reviewer from the gazetteer's candidates, looked up ${c.kinds.map((k) => (k === 'contained_in' ? `within the match for ${label(c.from)}` : k === 'area' ? `near the match for ${label(c.from)}` : `in ${c.params.countries.join(', ')}`)).join(' and ')}`
  : "Chosen by the reviewer from the gazetteer's candidates");
REGION_WORDS.noRegionsInData = 'The dataset gives no regions for its places (no column read as "within", and no ContainedIn to a region of its own), so there is nothing to review level by level.';
REGION_WORDS.onlyUnknown = (k) => `--only ${k}: neither a region nor a place of this review.`;

/**
 * Krisis: the region review on the page (src/app.js, src/krisis/region-page.js; Methodos #28, stages 3
 * and 4): the levels, each region with its constraint and its candidates, relaxing, changing a settled
 * region, and the places within. The engine's own words for these are REGION_WORDS.
 */
export const REGION_PAGE = {
  heading: 'Regions, level by level',
  how: 'The regions your places lie in are looked up first, from the widest. Each is looked up within the match of the region above it, so settle a level before the one below: settling a region unlocks the regions and places within it.',
  /** The lookup panel's offer, once the dataset is read and gives regions. */
  offer: (regions, levels) => `Your places lie in ${plural(regions, 'region')} at ${plural(levels, 'level')}. They can be looked up first, level by level, so that each place is looked up within its own regions.`,
  start: 'Review the regions level by level',
  noRegions: REGION_WORDS.noRegionsInData,
  /** A level's name: the heading of its column, else its number. */
  level: (n) => `Level ${n}`,
  /** The navigator: "Country 1/1 settled · County 12/15 · Parish locked · Places 0/340". */
  nav: {
    label: 'The levels of the region review',
    settled: (name, s, t) => `${name} ${s.toLocaleString('en-GB')}/${t.toLocaleString('en-GB')} settled`,
    locked: (name) => `${name} locked`,
    open: (name, s, t) => `${name} ${s.toLocaleString('en-GB')}/${t.toLocaleString('en-GB')}`,
    places: (s, t) => `Places ${s.toLocaleString('en-GB')}/${t.toLocaleString('en-GB')}`,
  },
  identityLabel: 'This one means',
  identity: { closeMatch: 'much the same region (close match)', exactMatch: 'the same region (exact match)' },
  /** How certain the reviewer is of a match: PLATO's certainty levels (#Certain, #LessCertain, #Uncertain). */
  certaintyLabel: 'How certain',
  certainty: { certain: 'certain', 'less-certain': 'less certain', uncertain: 'uncertain' },
  /** Where a region lies: "in England › Suffolk". */
  chain: (names) => (names.length ? `in ${names.join(' › ')}` : 'the widest level'),
  places: (n) => plural(n, 'place'),
  states: { locked: 'locked until the region above is settled', ready: 'ready to look up', review: 'looked up; to review', settled: 'settled' },
  /** What a region is (to be) looked up within, in words. */
  constraint({ looked, kinds, name, ids, countries, radius, needsArea, noArea, relaxed, from, unconstrained }) {
    const verb = looked ? 'Looked up' : 'To be looked up';
    if (unconstrained) return `${verb} without the regions, before they were settled.`;
    const parts = [];
    if (kinds.includes('contained_in')) parts.push(`within ${name} (${ids.join(', ')})`);
    if (kinds.includes('area')) parts.push(`within the area around ${name} (about ${radius.toLocaleString('en-GB')} km across from its middle)`);
    if (needsArea) parts.push(`within the area around ${name} (its outline is fetched from WHG first)`);
    if (kinds.includes('countries')) parts.push(`in ${countries.join(', ')}`);
    const relaxedText = relaxed && relaxed !== 'unconstrained' ? ` Relaxed: ${REGION_WORDS.relax[relaxed]}.` : '';
    if (!parts.length) {
      const why = noArea ? ` (${name} has no area to look within: ${REGION_WORDS.noArea[noArea] || noArea})` : from === null && !relaxed ? ' (no region above it is matched)' : '';
      return `${verb} with no constraint${why}.${relaxedText}`;
    }
    return `${verb} ${parts.join(' and ')}.${relaxedText}`;
  },
  failedClosed: (name) => `WHG could not narrow this search to ${name}, so it returned nothing. That is not 'no match': look it up again with the constraint relaxed.`,
  approximate: (name) => `WHG narrowed this search to ${name} only approximately, by the cells of its grid: a candidate just outside may be kept, or one just inside left out.`,
  uncoded: "Places with no country codes can't pass a country filter: if WHG records no country for the right one, it is left out.",
  union: (n) => `Matched to ${plural(n, 'record')}: the regions and places within it are looked up within the union of their areas.`,
  unanswered: 'WHG did not answer for this region; this is not a finding that it has no match. Look it up again.',
  /**
   * The steps of relaxing, as buttons. 'contained-in' includes 'countries'; the 'ancestor' step is said
   * by what it sends (region-page.js ancestorText): the region further up by its ids, else its area,
   * else only its countries.
   */
  relax: { countries: 'Again without the countries', 'contained-in': 'Within the area instead', ancestor: (name) => `Within ${name} instead`, all: 'With no constraint' },
  /** The 'ancestor' step where the region further up is sent otherwise than by its ids. */
  relaxAncestor: {
    area: (name) => `Within the area around ${name} instead`,
    countries: (countries) => `In ${countries} instead`,
    mixed: 'Within the region above that, or the area around it, instead',
  },
  ancestorAny: 'the region above that',
  /** A button with what it would send. */
  cost: (text, p, fetches = 0) => `${text} (${plural(p.queries, 'query', 'queries')} in ${plural(p.requests, 'request')}${fetches ? `, and ${plural(fetches, 'record')} fetched for an area` : ''})`,
  relaxOne: 'Ask WHG again for this region:',
  relaxLevel: (name, n) => `Ask WHG again for ${n === 1 ? 'the unsettled region' : `all ${plural(n, 'unsettled region')}`} of ${name}:`,
  lookLevel: (name, n) => `Look up the ${n === 1 ? 'ready region' : plural(n, 'ready region')} of ${name}`,
  lookOne: 'Look up this region',
  noneReady: (name) => `No region of ${name} is ready to look up: each is settled, looked up, or waiting for the region above it.`,
  candidates: (n) => (n ? `${n === 1 ? 'One candidate' : `${n} candidates`} from WHG:` : 'No candidates from WHG.'),
  buttons: { match: 'This one', notThis: 'Not this', none: 'None of these', skip: 'Skip', undo: 'Undo', reopen: 'Open it again' },
  decided: { match: 'Decided: this one', 'not-this': 'Decided: not this one', distinct: 'Decided: a different place' },
  settledNone: 'Settled: none of these is this region. What lies within it is looked up within the region above it.',
  noneButMatched: 'Take back the match first: a region with a match cannot also have none.',
  /** Changing a settled region: asked on the page first. */
  confirm: (d, c, name) => `This clears ${plural(d, 'decision')} and ${plural(c, 'candidate')} below ${name}.`,
  confirmYes: 'Clear them, and change it',
  confirmNo: 'Keep it as it was',
  cleared: (d, c, name) => `Cleared ${plural(d, 'decision')} and ${plural(c, 'candidate')} below ${name}.`,
  undo: 'Undo',
  undone: (name) => `Put back what was cleared below ${name}, and ${name} as it was.`,
  more: (n) => `Show ${plural(n, 'more region')}`,
  /** Stage 4: the places within their regions. */
  placesHeading: 'Places within their regions',
  lookPlaces: (n) => `Look up the ${n === 1 ? 'place' : plural(n, 'place')} in settled regions`,
  noPlacesReady: 'No place is ready to look up: each is looked up already, or waiting for its regions.',
  placesHow: 'Each place found is reviewed below, one at a time, as any other match.',
  locked: (n) => `${plural(n, 'place')} waiting for ${n === 1 ? 'its' : 'their'} regions:`,
  lockedReason: (name, level) => `waiting for ${name} (${level}) to be settled`,
  unconstrained: 'Look up without the regions',
  unconstrainedAll: (n) => `Look up ${n === 1 ? 'it' : `all ${plural(n, 'waiting place')}`} without the regions`,
  andMore: (n) => `and ${plural(n, 'more place')}.`,
  /** Where a place lies, on the review screen of places. */
  placeWithin: (names) => `In ${names.join(' › ')}.`,
  stop: 'Stop',
};
