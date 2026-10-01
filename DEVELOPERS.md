# PLATO tools, for developers

How the tools are built, what they do beyond what the
[PLATO guide](https://pelagios.org/place-attestation-ontology/guide/tools.html) says of them, how
they are tested, and the conventions to keep. For what the tools are and how to run them, see the
[README](README.md).

## How it works

- **One engine, two front ends.** `src/engine/pipeline.js` composes readers and writers, and
  `src/engine/compare.js` reads two versions through it. `src/engine/worker.js` runs them in the
  browser, and `src/node/host.js` in Node for `bin/plato-tools.mjs`. What the tools say about a run
  is worded once, in `src/engine/words.js` and `src/engine/report.js`, for both.
- **The mapping.** `src/lib/context.js` compiles PLATO's JSON-LD context into an explicit mapping
  used in both directions. JSON becomes RDF one record at a time (`src/formats/json2rdf.js`), so
  it streams.
- **The store.** RDF becomes JSON through an on-disk SQLite store (`src/lib/store.js`,
  `src/formats/rdf2json.js`), because an entity's triples can be anywhere in an RDF file. In the
  browser SQLite runs as WebAssembly on the origin private file system, through the pool-based
  VFS, which needs none of the cross-origin isolation headers GitHub Pages cannot send. In Node it
  is a file opened with Node's built-in SQLite (`src/node/sqlite.js`, which gives it the few calls
  the store makes of SQLite in the browser). [spike/](spike/README.md) records how the any-size
  claim was established, on DEEP's 24.8 million triples.
- **The spreadsheet tables stream** (`tablesSource` in `pipeline.js`). Each sheet is read a row at a
  time (`csvRecords` in `src/formats/csv.js`, shared with Hermes) into a working database
  (`TableStore` in `src/lib/store.js`): one row of cells to a row, with the key it is looked up by.
  The validator (`validateTables`, unchanged) scans it, and keeps the keys it has seen in it
  (`INSERT OR IGNORE … RETURNING 1`); then each place is read back with its attestations and
  identities in one join, in the places sheet's order, which SQLite gives without sorting. A zip is
  read from its central directory, entry by entry (`zipEntries`, `zipEntryText` in `input.js`),
  never by scanning for where an entry ends. Each row is still the object `Papa.parse(text,
  { header: true })` made of it when the sheets were read whole (`papaRow`, `papaFirstRow`: a
  repeated heading renamed `b_1`, a cell past the header under `__parsed_extra`), so streaming
  changed nothing a conversion writes. A sheet whose text stops it (not UTF-8, a quotation mark out
  of place, a damaged entry) is an error naming that sheet and the line of the file it stopped at;
  the other sheets are still checked, and the run is incomplete. A table issue's "row N" is a row of
  the sheet, the header being row 1 and blank rows not counted; a "line N" is a line of the file.
  The working database is about twice the size of the tables' text, and its join needs no
  temporary space. At scale (`SCALE=1 node --test test/tables-stream.test.js`, 512 MB of heap):
  1 million places, 6 million rows, 296 MB of CSV became 2.0 GB of PLATO JSON Lines in 6 min 38 s
  on the command line, with a peak RSS of 367 MB and a working database of 589 MB.
- **Language tags and datatypes, RDF to JSON.** PLATO JSON has no place for a literal's language
  tag or for a datatype other than the one it writes for the key; `_literalLoss` in `rdf2json.js`
  reports each as `literal-language` or `literal-datatype`, except where nothing is lost (the
  maintainer's decision of 2026-10-01). A tag on a name's toponym or `sourceLabel` fills the
  name's empty `language` key when PLATO's `languageTag` pattern admits it (`grc-Latn` does; the
  pattern is read from the schema, not written here); a tag on a name's text that equals its
  `language` key, ignoring case, is silent. A tag that differs from the key, cannot be one, or is
  on other text (labels, notes, titles) is reported. A number written back in another numeric
  datatype is silent when it is exactly the same number: `exactValue` expands the literal (as
  written for `xsd:decimal` and the integers, as the nearest double or single for `xsd:double` and
  `xsd:float`) and what is written back to every digit, and compares the strings, never `==`. So
  `"1.0"^^xsd:decimal` (back as `"1"^^xsd:integer`) and `"0.5"^^xsd:decimal` are silent, and
  `"0.1"^^xsd:decimal` and `"0.93"^^xsd:float` are reported. `test/literals.test.js` holds the
  cases, PLATO's own Turtle examples among them.
- **Candidate sets** (PLATO 53c5a40: `schemas/candidate-set.schema.json`, loaded as
  `profiles['candidate-set']`). The matches one run of matching software suggested for a dataset's
  places, published apart from the dataset. `runCandidateSet` in `pipeline.js` checks one against its
  profile and writes it as PLATO JSON, JSON Lines (the header, then a candidate a line) or N-Triples;
  the tables and Linked Places Format refuse it in words (`candidate-set-target`), as do the tools that
  read a dataset's records through `options.sink` (`candidate-set-not-a-dataset`), unless the sink
  has a `candidate` method (the version check's), which is given the set's header and candidates. From RDF, a graph
  with a candidate set and no dataset (no gazetteer with anything said of it beyond its type, no
  attestation and no identity relation: typed N-Triples type a candidate's dataset and places, and a
  place described a little more is still one the candidates name) is written as the candidate set; a graph with both is written as the dataset, and the candidate set is
  reported as not written (`candidate-set-not-written`), to RDF as well as to JSON. Krisis's apply
  refuses a candidate set given as its dataset. A dataset's `gazetteer.candidateSets` is the
  reverse of `plato:candidates_for`, written and read back as such (`test/candidates.test.js` checks
  the triples against jsonld.js's); the tables and LPF leave it out and report it
  (`dropped:gazetteer.candidateSets`). Where the tools stand: a candidate set is read, checked against
  its profile and by the rules no schema can make (see Candidate sets, checked together, below), and
  converted. Krisis exports one and writes `promotedFrom` (see Match review), and the version check
  holds a candidate set frozen (see the version check, below). An edge case to keep: a candidate's score records what the software
  said when it first suggested the pair. A candidate is frozen once issued, and a later set leaves out
  any pair already published, so if the places' names change and the same algorithm with the same
  settings would now score the pair differently, the first score stands. A different
  `algorithmVersion` or different `matchParameters` make a different candidate, with its own address.
- **Regions matched to a gazetteer, in LPF** (PLATO 1d2cf6e, #23). A dataset says a place is
  `ContainedIn` a region minted from its own data; a reviewer's attestation about that region bundles
  an identity (closeMatch or exactMatch) to the gazetteer's region, with `certaintyLevel` on the
  attestation and `promotedFrom` naming the Candidate, in a candidate set published apart, that holds
  the score. The LPF writer writes each `ContainedIn` as one relation of type `gvp:broaderPartitive`,
  as WHG does: `relationTo` is the identity's object, `certainty` the reviewer's level in LPF's words
  (`certain`, `less-certain`, `uncertain`), `whg_match_score` the Candidate's `similarityScore`, and
  `label` the relation's `relationLabel`, else the toponym of the region's current name attestation
  (not denied, retracted or superseded), else the region's `label`, which is a display form (*Surrey
  (England)*) where WHG wants the name (*Surrey*). Its `when`
  and citations are the containment attestation's, as for any relation. `RegionIndex` in `lpf.js`
  gathers what the document says of the regions before any feature is written: in the JSON pre-pass
  that already finds withdrawals; for spreadsheet tables, by the tables' reader from its working
  database once the sheets are loaded and checked, before its first place (`hooks.beforeRecords`, which
  `indexRegions` in `pipeline.js` fills by the same `gatherRegion` and `settleRegions` as the JSON
  pre-pass, so the sheets are not read twice); or, for RDF and attestation-centric input, from the store
  (the regions some place is `ContainedIn` that are places of the dataset, read once more through a
  quiet `Rdf2Json`). Only current matches count, by the same `currentAttestations` every
  writer uses, with denials left out. The cases: a `ContainedIn` straight at the gazetteer, or at a
  region with no current match, is written as it stands, with the containment's own certainty and no
  score (a region assigned by hand). Several current matches to different places: no guess, the
  region's own address, reported (`region-match-several`). A score is written only from a Candidate
  found in the sets given whose pair is the identity's (either way round); otherwise none, reported
  with the suggestion's address (`region-match-no-score`; `region-match-unscored` for a Candidate found
  with no score, `region-match-score-conflict` for one in two sets with different scores). A set whose
  `candidatesFor` names another dataset is warned of (`candidates-other-dataset`), the pair check
  still deciding. The reviewer's certainty level, written in the relation, is not reported as dropped
  from the reviewer's attestation (`RegionIndex.carries`). Reading LPF back, `gvp:broaderPartitive`
  (prefixed or in full) becomes `plato:ContainedIn`, and a `whg_match_score` is reported as lost
  (`lpf-match-score`). The candidate sets come as
  `options.candidates` (inputs detected as a candidate set; `--candidates SET` on the command line,
  repeatable, for `convert --to lpf` or `lpf-seq` only); a set is read for its scores alone, its own
  faults left to checking it on its own. The page gives none yet, so its LPF has no scores, each
  reported. Names are kept only for the regions some place is `ContainedIn`, matched or not, so that the index
  stays small; a region whose record comes before every place in it is named on a second reading of the
  file (for tables, of the places from the working database), made only when some target was not named
  on the first. `test/lpf-regions.test.js` has each case on PLATO's `place-centric-regions.json` and
  `candidate-set-regions.json`, and that example exported as tables, compared with the same tables read
  as PLATO JSON first.
- **Candidate sets, checked together** (Elenchos; the candidate set specification's section 13.3).
  `src/engine/candidates.js` holds the rules no schema can make, ported rule for rule from the
  specification's prototype (`elenchos.py`, tested by `neg.py`); `candidateCheck` in `pipeline.js`
  feeds them, and `CANDIDATE_CHECK_TEXT` in `report.js` words each kind. The sets are given with
  `options.candidates` (detected inputs, one per set): `plato-tools check --candidates SET`, once for
  each set, with a dataset or a candidate set as the input, or with no input, when the first set is
  checked with the others; on the page, *Check with candidate sets…* asks for the files. The sets
  given are read before the input and checked against their profile, each problem said to be in that
  set; only their candidates are held. A candidate's `@id` is `<set IRI>#c-` and a prefix of the
  SHA-256 of the JCS text (json2rdf's `jcs`) of `[subject, object, algorithmVersion, matchParameters ?? '']`.
  Within a set: `duplicate-id` and `same-candidate-twice` (the same four inputs under two ids) are
  errors, as is `id-not-under-set` (which refuses the withdrawn `<subject IRI>#c-` form); an id whose
  hex is not its hash's beginning is `id-not-minted` and a place matched with itself
  `subject-is-object`, both warnings. An id not in the `#c-` form at all is the schema's refusal, worded
  by `explainSchema` (as is a status other than `suggested`), and the id rules leave it alone, so that
  one fault is not two problems. Across the sets, earliest `issued` first (ties: the order given, the
  input first): `already-published` (a later set lists a candidate an earlier one published) and
  `described-differently` (two copies of one set disagree; identical copies are not reported) are
  errors; `not-distinct` (an id not lengthened past another hash in its set or an earlier set) is a
  warning, and compares only sets under the same base (the set IRI up to its last `/`), since only
  the minter knew what it was given. So not-distinct compares only sets whose IRIs share a folder,
  while Krisis, minting, lengthens against every set it is given; the rule is advisory (a warning),
  and a set it flags is not wrong. With a dataset, each answer (`promotedFrom`, wherever it is, with
  the subject its relation, attestation or place gives) is checked as it streams past:
  `promoted-from-unresolved` and `promoted-from-other-pair` are warnings; `ends-disagree` (a listed set
  made for another dataset) is an error and `set-not-listed` a warning. From RDF, the same is read from
  the records as they are read back from the graph. With no set given, a dataset that answers
  candidates or lists candidate sets gets one note (`candidates-not-given`, a report severity of its
  own, shown under *Notes* by a check only), naming the sets it lists; nothing is fetched.
  `test/elenchos-candidates.test.js` gives each rule a case that must raise it and a control that must
  not, on PLATO's examples and schema-valid copies of them.
- **The about sheet's authors.** Each item of `creator` is `Name <address>`, an address alone, or a
  name alone (PLATO 8385472; `creatorOf` in `tables.js`). An item alone is an address only with a
  scheme and `//`, or a `urn:`, `tag:`, `mailto:`, `doi:` or `info:` scheme, so that `Re:Place` is a
  name (PLATO's own pattern would take it as an address); `creator_name`, deprecated, is still read
  and warned of. The writer puts every author in `creator` and leaves `creator_name` empty.
- **The other formats** are in `src/formats/`: `tables.js`, `lpf.js`, `annotations.js`, `cube.js`,
  and `shared.js` for the rules the lossy writers share (denials, the current state, computed
  values, figures, bundled identities).
- **Errors.** A file whose content stops a reader is a `DataError`, thrown by the readers in
  `src/engine/input.js`; `run()` turns it into a problem in the report, marked incomplete. A new
  reader must throw `DataError` for bad input, or a fault in the data will look like a fault in
  the tools, which is the only thing shown as one.
- **Text is UTF-8, strictly.** Every text input is decoded by `textStream` (or, for a sheet in a
  zip, `zipEntryText`) with a fatal decoder: a byte that is not UTF-8 is a `DataError` naming the file,
  the line and the byte, and saying how to save it as UTF-8, never a replacement character. A
  byte-order mark is dropped. Detection alone (`head`) decodes leniently, so that such a file is
  still recognised and its reader can say what is wrong.

## What it checks against

PLATO's normative files (the ontology, the JSON Schemas, the JSON-LD context and the table
definitions) are vendored into `public/plato/` from a pinned commit of
[pelagios/place-attestation-ontology](https://github.com/pelagios/place-attestation-ontology),
recorded in `package.json` and `public/plato/VERSION.json`, shown at the foot of the page and by
`--version`. The build checks that the vendored ontology is byte-identical to the pinned commit's.

- `npm run vendor` re-pins to the head of PLATO's main branch. Do this, and run the tests, whenever
  PLATO's schemas, context or table definitions change. It fetches from GitHub, so a PLATO commit
  must be pushed before the tools can be pinned to it.
- `node scripts/vendor-plato.mjs --ref NAME` pins to a PLATO branch or commit, for testing a design
  before it reaches main. Such a pin is a draft, and `VERSION.json`, the page footer and
  `--version` all say so, so that it cannot pass for a release.

The JSON Schemas give PLATO's identifiers the format `iri`, so that an address with a non-ASCII
letter is valid as written. The JSON Schema library's formats package does not define `iri`, and
would accept any string at all; `src/lib/formats.js` defines it (an absolute IRI, by RFC 3987), and
the tools refuse to start on any format they do not know rather than leave it unchecked.

## Conversions, in detail

The guide gives the two rules a conversion follows, and what each format keeps. Here is how they
are held to.

- **Nothing is dropped silently.** Each writer names the keys of each PLATO object it holds; every
  other key present is reported by name, in words (`src/engine/report.js`), including a key PLATO
  adds after the tools were written. `test/keys.test.js` takes every key the JSON Schema allows, at
  every level, from the schema itself, and fails for any that a writer (LPF, LPF sequence, the
  tables, N-Triples, or PLATO JSON made from RDF) neither carries nor reports.
- **The base address** for the places and sources of a set of tables is the one given for the
  conversion (`--base`, or the page's field), else the about sheet's `base_uri`, else
  `https://example.org/my-dataset/` (`DEFAULT_TABLE_BASE` in `pipeline.js`). A base given that
  differs from `base_uri` is used, with a warning. Writing tables, a place's or source's address
  survives only if reading the tables back would mint the same one.
- **Names where RDF needs addresses.** PLATO's context reads a gazetteer's `contributor` or an
  identity match's `assertedBy` as an IRI, and the schema allows a name. A name there cannot be
  written in RDF, and is reported as lost whenever the output is RDF or is made through it.
- **Numbers.** JSON-LD writes a number with a fractional part as a canonical `xsd:double` of 16
  significant digits, and the tools write exactly what `jsonld.js` writes. A JavaScript number can
  need 17 digits to be told from its neighbour, and such a number comes back from RDF one unit in
  its last place away: `106.82041100000001` becomes `"1.06820411E2"^^xsd:double` and is read back
  as `106.820411`. Numbers of 16 significant digits or fewer, and whole numbers below 10²¹, come
  back exactly. `test/roundtrip.test.js` pins this. One departure from `jsonld.js` is deliberate:
  it tells a double by a `.` in the number's text, so it writes `1e-7` (JavaScript's form for a
  number below 10⁻⁶ with one significant digit) as `"0"^^xsd:integer`, and the value is lost. Here
  a whole number below 10²¹ is an `xsd:integer` and any other number an `xsd:double`, so `1e-7` is
  `"1.0E-7"^^xsd:double` and comes back exactly. The tests of equivalence with `jsonld.js` check
  that their data holds no such number, and `test/json2rdf.test.js` shows the difference.
- **A workbook's cells** (.xlsx and .ods, both read by SheetJS) are read as stored, not as their
  number formats show them (`workbookSheetCsv` in `pipeline.js`), and each sheet is then read as
  CSV text, as a CSV file is. A number is written in JavaScript's shortest round-trip form
  (`String(n)`), never as an exponent, which a CSVW decimal does not allow (`1e-7` is `0.0000001`):
  a coordinate formatted `0.00` keeps all its digits, a General number all 15 or more (SheetJS's
  formatted text has 11), a whole number formatted `0.00` is `42`, and a percentage or an amount of
  money is the number (`0.95`, not `95%`). A date is ISO 8601: `YYYY-MM-DD` at midnight, the form
  `from` and `to` take; otherwise `YYYY-MM-DDThh:mm:ss`, with no zone, as the workbook gives none;
  a cell whose format shows no day nor year is a time, `hh:mm:ss`. In a column that takes a date
  alone (`from`, `to`, `temporal_from`, `temporal_to`: any whose format in the table definitions
  takes a date and refuses a time, `dateOnlyColumns`), a date with a time of day keeps the date,
  drops the time, and is warned of by sheet, row and column (`workbook-date-time`, words in
  `report.js`), so that the user checks it: a time of day can mean that a time zone moved the date. The workbook is read with `UTC: true`, so a
  Date's UTC fields are the date as stored: SheetJS 0.20.3 gives UTC Dates from `read` whatever
  the option, but its `sheet_to_json` turns them to local time, and `toISOString` on a local
  midnight in London in summer is the day before. A text cell is its text, so `007` stays `007`.
  `test/workbook-values.test.js` builds an .xlsx and an .ods with each of these and runs in London's
  time zone.
- **A structured value** (a property value whose `value` is a JSON object) goes to RDF as
  `plato:value_json`, in canonical form (RFC 8785), and comes back as the object. This departs from
  `jsonld.js`, which would make the object a node and drop its keys.
- **Several values where PLATO JSON holds one**, reading RDF, keep the first and report the rest,
  once per distinct value (a source cited in thousands of records is counted once).

### Statistical figures

The guide's [Statistical tables](https://pelagios.org/place-attestation-ontology/guide/statistics.html)
gives the design and the two commands.

- **PLATO JSON to RDF.** Under `dimensions` and `attributes`, a key that is an IRI becomes a
  predicate on the figure, as in JSON-LD. The graph is exactly the one `jsonld.js` gives.
- **RDF to PLATO JSON.** A statement on a figure that no PLATO key names goes back under
  `attributes` or `dimensions` by this rule, in order: the table's structure, where the graph has
  it (`qb:attribute`, `qb:dimension`); else the property's own type in the graph; else its
  namespace (SDMX's attribute or dimension namespace); else `dimensions`, with a warning naming it.
  Both keys give the same graph, so the round trip is lossless either way. A value whose datatype
  JSON cannot carry (a year typed `xsd:gYear`) keeps its text, and the loss is reported.
- **`--cube`** (`src/formats/cube.js`) adds the types `qb:Observation`, `qb:DataSet` and
  `qb:DataStructureDefinition`, the measure as a direct statement, `sdmx-dimension:refArea` (the
  attestation's place) and `sdmx-dimension:refPeriod` (an `xsd:gYear` or `xsd:date` when the date
  is one year or one day), declared in each table's structure. Reading an export back leaves out
  only these derived statements.
- **`datacube`** (`src/lib/datacube.js`) checks integrity constraints IC-1, IC-2, IC-11, IC-12 and
  IC-14, IC-12 by grouping rather than by pairs, and says beside each verdict how many
  things it evaluated; a constraint with nothing to evaluate is not tested, never passed. IC-14
  exempts only a declared absence, a figure with an `obsStatus` and no value, since `obsStatus` is
  a general attribute. On PLATO's example and six planted defects it gives the verdicts of the
  specification's own SPARQL queries, run after its normalisation. The file is read as a stream,
  but the cube's graph is held in memory to be checked, so the size it can check is bounded by
  memory (see Limits).

### Web annotations

`src/formats/annotations.js` reads Recogito's exports and says why at each choice. The mapping key
by key, and the fixtures (most of them real exports), are in
[test/fixtures/annotations](test/fixtures/annotations/README.md#the-mapping).

**Georeferenced regions** (`src/formats/regions.js`, Hermes #5). A Recogito export chosen together
with IIIF Georeference Annotations, and optionally the maps' IIIF manifests, is one input:
`detect()` gives the export's input with `georefs` and `manifests` (Files) beside `files`
(`detectGroup` in `input.js`; any other mix of several files is refused with a reason). On the command
line they are `--georef FILE` and `--manifest FILE`, both repeatable, for a Recogito export only.
Nothing is fetched. `annotationSource` (`pipeline.js`) then calls `AnnotationReader.useGeoreferences`,
which reads each georeference file once (every map of an AnnotationPage; a map given twice, by its
annotation's id, is used once, the later modified of two versions), pairing each map with the
manifest whose id is the one its annotation names if it shows the map's image (else a warning, and
the map is used without it), failing that with a manifest given that shows the image (a warning
naming both ids), and `place(annotation, attestations)` after each
`annotation()`, which stays synchronous. Without georeferences neither is called, nothing of
`src/engine/georef/` is loaded (the test counts Allmaps imports in a process of its own), and the
output is byte for byte what it was (the test holds the digests).

- **Which map.** The georeferences whose image or canvas the target's source is (`matchTarget`; a
  IIIF picture address only whole, unrotated and full size, with a warning), in image pixels (as
  Recogito Studio's regions are); of those, the one whose mask holds the region's centre. None, or
  more than one, and the region is not placed, and is reported. The centre must also lie inside the
  convex hull of that map's control points in image pixels (`withinControlPoints`, with a tolerance
  of `HULL_TOLERANCE`, 1% of the hull's bounding-box diagonal), or it is not placed
  (`annotation-region-beyond-control-points`): beyond them a thin plate spline extrapolates wildly
  (the fixture's "45" in the border would go to about -127.8, 57.4). Not through a Helmert or
  straight transformation, though: a similarity, fixed by any two points, extrapolates safely, and
  the hull of two points is a segment that would place nothing; the mask still applies. A region
  whose centre is inside both but which reaches beyond the mask is placed, with a warning.
- **What is written.** One `Point`: the centre, worked out in pixels (the area centroid; the
  midpoint by length of a line) and then transformed; `precisionKm` (an array, as the schema has
  it) the greatest haversine distance from it to the transformed outline's vertices, plus the
  record's `controlPointMisfitKm` for a transformation fitted by least squares (null, so nothing,
  for a thin plate spline), rounded up to 0.01 km (`radiusKm`). The outline is reported, not
  carried. The image's citation is replaced by `georefCitation(record, { region })` (the exact
  pixel box, unpadded, but at least 1 pixel each way, so that a straight horizontal or vertical
  line has a box) and followed by `georefAnnotationCitation(record)`; the notes get
  `georefNote(record, { misfit: true })` (no `fetched`: "retrieval date not recorded"; the misfit
  sentence says what the georeference's error is, or that a spline's is not estimated), and a
  rectangle's pixels in words where the map's locator does not give the same box.
- **Roles, by evidence only.** `plato:LabelAnchor` for a transcription, a quote, or a tag `label`;
  otherwise no role, a note and a warning. The tag conventions (`label`, `symbol`, or `map label`,
  `map symbol`, singular or plural, any case, free or from a vocabulary) are the only evidence
  Recogito Studio's own editor can write for an image: it has no transcription, and Annotorious
  writes no quote for an image. A region tagged `symbol` is `plato:RepresentativePoint` with
  `spatialPrecision: ["approximate"]` and the note "The position is the centre of the region drawn
  round the map's symbol, not the symbol itself." (the maintainer's decision, 2026-10-01), and is
  not given the `annotation-region-no-label-evidence` warning. A region with both label evidence and
  a tag `symbol` is a symbol: the tag wins (`roleOf`).
- **Reporting.** Every region is reported by exactly one of the `annotation-region-*` kinds, and a
  placed one also by `annotation-region-shape`; with georeferences an SVG shape is not also
  reported as `annotation-selector` (it still is when its annotation is not converted at all, and
  when it is nested in `refinedBy`, which is never placed). A georeference or manifest that cannot
  be read is an error, and the run goes on without it; one that placed nothing, or a manifest no
  map uses, is a warning. Any error other than a `DataError` while placing a region is a fault in
  the tools: it costs that region its point (`annotation-region-unplaced`, "an unexpected error"),
  never the run, and is recorded in `unexpectedRegionErrors`, which the tests assert empty.
- **The fixtures.** `test/fixtures/annotations/recogito-studio-regions-generated.json` was written
  by Recogito Studio's own exporter code (run with its database client stubbed, not exported from a
  running instance), and is the authority on what Studio writes: where it and the constructed
  `recogito-studio-regions-constructed.json` differ, the generated file is right. The constructed
  one (written by `make-recogito-studio-regions.mjs`) is kept for the paths Studio's editor cannot
  reach. How each was made, and what each shows:
  [test/fixtures/annotations/README.md](test/fixtures/annotations/README.md#generated-by-recogito-studios-own-exporter).

### Hermes: TEI, and tables of places (CSV and GeoJSON)

The readers are in `src/engine/hermes/`. Each one's mapping, row by row, is in its fixture folder's
README, under **The mapping**: [test/fixtures/tei](test/fixtures/tei/README.md#the-mapping) and
[test/fixtures/generic](test/fixtures/generic/README.md#the-mapping). The guide's pages for these
readers link to those headings, so keep them.

- **TEI** (`tei.js`). Each place name in `<text>` (`placeName`, `settlement`, `region`, `country`,
  `bloc`, `district`, `geogName`, and `rs` or `name` with `type="place"`) becomes one
  attestation-centric attestation about the place its `@ref` resolves to (its words leave out a
  `<geo>`, `<location>`, `<idno>` or `<note>` inside it, `ASIDE`; a `<geo>` there is `tei-place-geo`): a web address as it is,
  a prefixed pointer through the header's `<prefixDef>` (the pattern anchored to the whole of what
  follows the prefix), and `#x` through the web-address `<idno>`s (or `<linkGrp>/<link type="normal">` targets, as
  EHRI writes them: `placeUri`) of `<place xml:id="x">` in the same file. Several addresses, from a ref, a `#x` or a listed place,
  are one place, about the preferred one with identity relations to the others, unless two are from one gazetteer
  ("Preferred authorities", below). A place name in an `<rdg>`, or in the part of a
  `<choice>` not taken, is a variant (`tei-variant`): one in a part of a `<choice>` waits until the
  `<choice>` closes. In a `<text>` with a top-level `div type="edition"`, every other top-level div,
  of whatever type (an introduction as much as a commentary), before the edition div as after it,
  and every `<note>` is the editors' (`tei-place-editorial`). A place name in a top-level div that
  is not the edition, or in a note, read before any edition div is held (only it, in `held`) until
  the edition div opens (it is the editors'), a place name is read outside every top-level div and
  note, or the `<text>` ends (no edition div, then: it is the source's words). At most `HOLD_CAP`
  (10,000) names are held: the next decides the `<text>` as having no edition div, the held names
  are emitted as ordinary, and `tei-editorial-undecided` (a warning) is reported once for each `<text>`, so a
  translation-only or commentary-only file holds no more than that; an edition div found after
  that makes only the names after it the editors', and is reported as a definite loss
  (`tei-editorial-late-edition`, its example the edition div's line, the count of names already
  converted as the source's words in the editors' parts, and those parts' div types, counted in `late`).
  Everything else is emitted at once, so a held name comes out after the names read after it. The reading
  options that convert the editors' words (`commentaryPlaces`, `headerPlaces`) give each place name
  they convert the form status `EDITORIAL_IRI`, `plato:Editorial`'s full IRI exactly as the vendored
  `public/plato/ontology.ttl` writes it (`test/tei-editorial-iri.test.js` reads it from there and
  compares). They are refused should it ever be unset (`teiReadingRefusal`), since a record with no
  `formStatus` would be read as Attested; tests unset it with `setEditorialIriForTests(null)`. In any
  file, edition div or not, a `<note>` marked as the editors' (`noteMark`: `@type` editorial,
  commentary or translator, or a `@resp` that is not the work's author's) is the editors' at once,
  never held, its example naming the mark (`note (resp="editor")`). A `@resp` is the author's when
  each of its pointers is `#x` for an `xml:id` on the titleStmt's `<author>` (or inside it) or on a
  titleStmt or editionStmt `<respStmt>` (or inside it) whose `<resp>` is "author" or "aut", or the
  whole `@resp` is such an author's or respStmt name's text, case ignored (`authorField`,
  `isAuthor`); anything else (an editor's id, an id not in the header, a URI) is the editors'.
  Unmarked notes in a file with no edition div stay the source's. With `listPlaces`, a `<place>` gives a Headword
  attestation (`listPlace()`), from its own names (a name that is the `<place>`'s child) and its own `<location>`s (not one whose type says it is another place's, `OTHER_PLACE_LOCATION`, such as Schnitzler's `located_in_place`: `tei-listplace-geo-other-place`), its `<geo>` read by `parseGeo`; one in the teiHeader goes on the header's `queue`, run at
  `</teiHeader>` after `header()`, so that the source, the own host and the `geoDecl` are read from
  the whole header. With `headerPlaces`, a findspot (a `provenance type="found"` with no subtype, or one meaning found, `FOUND_SUBTYPE`; another subtype, such as I.Sicily's `first-seen`, is a plain attestation with a note, `tei-provenance-other`) or place of origin in the header (a `<geo>` there is reported, `tei-header-geo`, with the option or without)
  goes on the same queue (`headerMention`, `headerPlace`), so its prefixes are those in force at
  `</teiHeader>`; it is then placed as a name in the text is (`place()`), so one whose ref points to
  a `<place>` not yet read (in `<back>`) waits in `pending`. A place name with no ref and a `@key` is converted with `keyPatterns`
  (`fromKey`, through `addressFromPattern` in `addresses.js`); keys with no pattern are counted by
  prefix and reported at `close()`. `teiKeyPrefixes(input)` streams the file through a `TeiReader`
  with an `onKey` hook, for the page's prefill. Entities declared with their text in the file's own DOCTYPE are given to
  saxes' `ENTITIES`; an external entity is never read. The file is parsed as a stream with saxes, with
  no DOM (a Web Worker has none); the only thing held to the end is a place name waiting for a
  `<place>` later in the file, indexed by the id it waits for. The edition, from its `teiHeader`, is the source; a place name's
  `xml:id` is never the attestation's `@id`. A file that declares an encoding other than UTF-8 is
  refused. Any other XML (KML, TEI in a namespace not TEI's, anything else) is refused by
  `detect()` with a reason (`XML_REASONS`), never sniffed as N-Triples.
- **TEI P4, and TEI with no namespace** (`tei.js`, "TEI P4, and TEI with no namespace"). `detect()`
  gives `{format: 'tei', variant: 'p4'}` for `<TEI.2>` or `<teiCorpus.2>` in no namespace, and
  `variant: 'no-namespace'` for `<TEI>` or `<teiCorpus>` in none (a TEI root in another namespace is
  refused as XML). The reader decides for itself, from the root: the root fixes the namespace
  (`this.ns`), and an element is TEI's when its namespace is the root's. P4 semantics apply only to
  P4 (`teiVariant === 'p4'`, `tei-p4`, a warning): `P4Attributes` renames `id` and `lang` to
  `xml:id` and `xml:lang` before anything reads them; `lang` is an IDREF into the header's
  `<language id>`, resolved by `languageTag` to the `<language>`'s `ident` where that is a tag,
  else to the id where that is one (`<language id="la">`), else `tei-lang-not-tag` naming the
  `<language>` (once for each value, `langNotTag`, in P4 and P5 alike); the `<language>`s are kept on each scope's header (`hdr.languages`, pushed and
  popped with `this.scopes`) and looked up innermost first (`language()`), so in a `teiCorpus.2`
  each `<TEI.2>` has its own, and the corpus header's hold for every text in it; a place name's `@reg` (the editors' regularised form) is `tei-reg`, a loss, and the
  name is the text's (in P5 it is an attribute not read, `tei-attribute`, beside a ref or, on a name
  with a key and no ref, alone); a name whose language is Greek (`isGreek`: its tag `grc`/`el`, or its
  `<language>`'s words or id naming Greek; its language is its own `lang`, else the nearest
  enclosing one, so a note's own `lang` overrides its div's) and whose text is ASCII with a letter
  and one of Beta Code's signs (`BETA_SIGNATURE`: `*`, `(`, `)`, `/`, `\`, `=`, `|`, `+` or a digit) is
  Beta Code: `tei-p4-beta-code`, a loss naming the string, and the attestation carries no `names`
  (and so no `formStatus`), with a note (decided 2026-10-01: reported, not converted; a later opt-in
  only with exact round trips). ASCII with a letter and none of the signs ("Rwmh", or an English
  "Athens" in a note with no `lang` of its own, in a Greek div) cannot be told from Latin letters:
  the conservative reading (decided 2026-10-01, in the review fixes) carries it as written, not
  converted, with no `language`, and a note, and reports it as `tei-p4-maybe-beta-code`, a warning. P4's numbered divs (`div1`…`div7`) are read as `div` is (`DIVS`); Perseus's
  top-level divs are books and chapters, never `type="edition"`, so the edition rule does not fire
  for such a file and its notes are the source's unless marked as the editors' (`noteMark`, as
  `resp="ed"`). Keys (`key="tgn,7011179"`) take the key path, with TGN's pattern suggested. A
  namespace-less TEI is P5 without its xmlns (`tei-no-namespace`, a warning): `xml:id` and
  `xml:lang` are read, `id` and `lang` are not (reported as attributes).
- **The ISO entity sets.** A DOCTYPE naming an outside DTD (`namesOutsideDtd`: an external subset,
  `SYSTEM` or `PUBLIC` after the root's name, or a parameter entity declared `SYSTEM`/`PUBLIC` and
  used, `%ISOgrk1;`, in the internal subset) means the file relies on that DTD's entities, which are
  never fetched. For such a file only (decided 2026-10-01), `installIso()` gives saxes' `ENTITIES`
  each name of `src/vendor/iso-entities.json` as a getter that counts its use (`useIso`), in
  `doctype()` before its early return for a DOCTYPE with no internal subset; the file's own
  declarations are made after it and replace it (`declared`, not `Object.hasOwn`, decides which
  declaration is first), and an in-file entity whose text uses a table name counts it each time it
  is used. At `close()`, each set used is reported once (`tei-entity-iso`, a warning: "isogrk1: agr
  (3), bgr (1)"), since some names were remapped over the years (the 2007 sets have `phiv` U+03D5,
  `epsiv` U+03F5 and no `phis`). A `Proxy` on `ENTITIES` remembers the last name looked up, so that
  an error can name it. **A name in neither the file nor the table** (decided 2026-10-02) is, in such
  a file only, left out with nothing in its place, and reported once with each name and its count
  (`tei-entity-unknown`, a warning, saying the DTD was never read). saxes 6 has no hook for an
  unresolved entity (`parseEntity` reads `this.ENTITIES[name]` and fails on `undefined`), so the
  same `Proxy` answers such a name with a marker, U+FDD0 name U+FDD1 (noncharacters, which no XML
  name can hold), which saxes puts into the text or attribute value as the entity's text. `open()`
  strips markers from attribute values, keeping which attribute held which names
  (`t.unknownAttrs`); text keeps them until it is read, where `norm()` strips them, so a capture's
  raw `pref`/`printed` still shows them (`unknownIn`). A place name whose words (taken or printed),
  `ref` or `key` held one is not converted (`tei-place-entity-unknown`, a loss, with the entity and
  the words as read without it); so is a listed `<place>` whose `idno` or link target held one (and
  every name pointing to it), or whose headword did, with `listPlaces`; and a header place name with
  `headerPlaces`. An `n` holding one on a `div`/`div1`…, `milestone`, `pb`, `lb` or `l` is left out
  of the locator, rather than giving an incomplete one ("book 1, section "), and reported by element
  and line (`tei-locator-entity-unknown`, a loss); a lost `lb` or milestone number also ends the one
  before it. The source's title (`mainTitle`'s) or the edition's address (the `idno` `source()`
  uses: type URI or URL, else a DOI) holding one stops the file (`checkSourceEntities`, at the end of
  each `teiHeader`), naming it, since every citation would be incomplete. A file naming no outside
  DTD refuses any undeclared entity, as before. Markers are looked for and stripped only where the
  table is installed (the reader's `norm`, `unknownIn` and `stripUnknown` methods; the module-level
  `norm` only collapses whitespace): in any other file U+FDD0 and U+FDD1 are characters of the text,
  read as written. So that a marker cannot collide with real text, an outside-DTD file whose input
  already holds either is refused with a `DataError` (`markerRefusal`): a raw chunk holding one, in
  `write()` before the parser sees it (a chunk read before the DOCTYPE is remembered, `markerSeen`,
  and refused when `installIso()` runs), a character reference to one (`&#xFDD0;`, by wrapping
  saxes' `parseEntity`), or an entity the file declares with one in its text. `teiSource` and `teiKeyPrefixes` read
  the file's first 64 KB (`headed`) and load the table (`loadIsoEntities`, a dynamic JSON import,
  cached) only when a DOCTYPE there has `SYSTEM` or `PUBLIC`; `teiToDocument` takes it as the option
  `entities`, or uses the cached one. The table is built by `node scripts/make-entities.mjs`
  (`--from DIR` for local copies) from the W3C's *XML Entity Definitions for Characters*
  (https://www.w3.org/2003/entities/2007/, the 22 `iso*.ent` files: not the WHATWG's entities.json,
  which lacks ISOgrk1's transliterations, and not ISO 8879's own files, licensed only for SGML
  systems); it writes `src/vendor/iso-entities.NOTICE`, with the W3C Software Notice and License and
  the ISO 1986 and 1991 notices verbatim, and puts the same text in the JSON's `licence`, so the
  notice travels into the built site. Real Perseus P4 files also use their own DTD's entities in the
  header (`&responsibility;`, `&fund.NEH;`, `&Perseus.publish;`), which are not ISO's: they are left
  out and reported, as above (`test/fixtures/tei/p4-boilerplate-constructed.xml`). `scripts/check-perseus-p4.mjs` checks the reading against a
  local Perseus file (opt-in, `PERSEUS_P4_FILE`; Perseus's texts are CC BY-SA and none is committed).
- **Tables of places** (`columns.js`, `generic.js`). `input.js`'s `detect()` sends a lone CSV (or
  `.tsv`/`.tab`) that is not one of the tables' sheets, and a FeatureCollection or Feature whose
  structure is not LPF's (`isLpf`, on the head read as structure by `jsonHead`), here. A GeoJSON
  sequence is LPF only by the same test, of its collection line or its first feature; a sequence of
  plain features is refused (`GEOJSON_SEQ_REASON`), asking for one FeatureCollection. A workbook
  (`.xlsx`, `.ods`) comes here too unless it is the tables: `workbookSheets(file)` reads its list of
  sheets (`XLSX.read(data, { sheets: [] })` for xlsx, which gives `Workbook.Sheets[i].Hidden` without
  parsing a sheet; `bookSheets: true` for ODS, whose hidden flag SheetJS 0.20.3 does not read, so
  `generic-sheet-hidden` is xlsx-only), and `workbookKind` applies `tableSheets`' rule with the one
  header test they share (`isSheetHeader`): two or more sheets named after PLATO's (any case, as the
  tables reader takes them), or exactly one whose first cell (`sheetRows: 1`) is that sheet's first
  column. Otherwise it is `{ format: 'csv', container: 'workbook', sheets: [{ name, hidden }], sheet }`,
  `sheet` the first not hidden, so `isTable`, `genericProfile`, Krisis and the page treat it as a CSV
  file. SheetJS is imported lazily (`useXlsx(lib)` injects one). `generic.js`'s `openSheet` reads the
  sheet with `XLSX.read(data, { cellDates: true, UTC: true, sheets: [name], dense: true })` and
  `sheet_to_json(ws, { header: 1, raw: true, UTC: true, defval: '', blankrows: true })`, each cell made
  text by `sheetCellText` (a number by `String`, so full precision, never the displayed `0.00`; a
  date `YYYY-MM-DD` at midnight, else `YYYY-MM-DDTHH:MM:SS`; it is `sheet_to_json`'s `UTC` that keeps
  a date from shifting by the local time zone, which the TZ test catches), the header the first row
  that is not blank, rows numbered as the workbook numbers them. A formula saved with no cached value
  is found on the dense cells and reported (`generic-sheet-formula-no-value`) in either of the two
  forms SheetJS 0.20.3 reads it as: `{ t: 'e', f }` with no `v`, as SheetJS's own writer saves it
  (`test/workbooks.js` `formulaCell`), and `{ t: 'z', f, v: 0 }`, as Excel, openpyxl and pandas save
  it (`<f>B2*2</f>` alone, or with an empty `<v></v>`), which is seen only because an xlsx sheet is
  read with `sheetStubs: true`; without it SheetJS drops such a cell as empty, with nothing to report.
  A stub is empty to `sheet_to_json`, so the rows are unchanged. The test of the second form edits
  an xlsx file's sheet XML (fflate), not a workbook SheetJS writes. An ODS sheet is read without
  `sheetStubs` (SheetJS would make a stub of every repeated empty cell, as in a styled row repeated
  to the end of the sheet), so an ODS formula saved with no value is untested and may be read as
  empty unreported: LibreOffice always saves a formula's value. A cell holding an error (`{ t: 'e', v: <code>, w: '#DIV/0!' }`),
  which `sheet_to_json` gives as empty, is found on the same dense cells and reported as a loss
  (`generic-sheet-error-cell`) naming its row, column, cell and error text, and carries nothing; a
  row whose only value is an error is still yielded (so its loss is reported), and an error in the
  heading row or past the last column is reported from `headProblems`. The sheet is `options.sheet` (a run's options, `sheetIn`), else
  `input.sheet`; `withSheet(input, name)` sets it, refusing a name the workbook lacks with a
  DataError listing its sheets (the worker's `columns`, `match` and `apply` commands, and the command
  line's `--sheet`, a usage error there). The other sheets (`generic-sheets-not-read`), hidden ones,
  an empty sheet (`generic-sheet-empty`, an error) and a workbook over 50 MB (`workbook-whole`, as the
  tables reader warns) are reported from the sheet's `headProblems`. SheetJS holds the whole
  workbook, so the sheet is read once for its columns and once more for its rows, and nothing
  between. The tables reader's own workbook path (`pipeline.js`, `tableSheetsOf`) is unchanged. A IIIF
  Georeference Annotation (Allmaps) is detected first, as `georef` with a `reason`, and refused
  like an unrecognised file (`readable()`); opened on Chora as a dataset, it is refused with Chora's
  own advice instead, to paste it under Historical maps (`words.js` `choraLoadFailure`). `guessColumns` maps each column to one `FIELDS` key, `note` or `skip`
  from its normalised heading and the first 50 rows; `resolveColumns` checks a saved mapping
  instead. The mapping is the same JSON on the page (the column-matching step in `src/app.js`, via
  `columnsOf`/`mappingOf` in `worker.js`, worded in `words.js`: `COLUMN_CHOICES`, `COLUMN_WORDS`,
  `columnWarnings`, which warns of a column named for a gazetteer when no column is the address,
  and points at the pattern suggested for a column of a gazetteer's ids until it is confirmed) and on
  the command line (printed with each input, taken back with
  `--columns FILE`). A mapping value may also be `{"field": "address", "pattern": "…{id}…"}`, a
  column of a gazetteer's ids made into addresses (`addresses.js`, shared with TEI's keys:
  `addressFromPattern(value, pattern, { shape })` returns `placeAddress`'s result, `{ lost: 'shape',
  value }` for an id of the wrong shape or any `whg:` code, or `{ error }` for a pattern that cannot
  be used; `patternFault(pattern)` gives `'placeholder'`, `'not-web'` or `'whg'` (TEI words these
  itself) and `patternProblem(pattern)` the same verdict in words, refusing a pattern without `{id}`
  (or `{key}`) once, one that makes no web address, and any World Historical Gazetteer one;
  `GAZETTEER_PATTERNS` has Pleiades', GeoNames' and Wikidata's patterns and id shapes, and
  `patternShape` the shape a pattern takes; Pleiades' has `idPrefix`, so that its pattern takes
  `/places/579885`, as Pleiades' own `pid` columns write an id, as `579885`: `patternId`). GeoNames'
  own heading `geonameid` names GeoNames, and `pid` of such paths is suggested Pleiades' pattern. A
  GeoJSON file (any JSON document) that is not well formed is refused with where and why in plain
  words (`jsonFaultWords` in `input.js`: a NaN or Infinity, a single quote), not the parser's message. `guessColumns`/`resolveColumns` return `{ mapping, patterns,
  suggested, reasons, problems, gazetteer }`: `mapping` is fields as strings, `patterns` is
  `{ column: pattern }` (only from a saved mapping; the guess never makes one), and
  `suggested[column]` is `{ field: 'address', pattern, gazetteer, fit, sampled }` for a column named
  for Pleiades, GeoNames or Wikidata of which at least half the sampled values have that gazetteer's
  shape, when no other column is the address; the column stays `note`, and its reason names the
  pattern, until the user confirms it. `mappingToSave(mapping, patterns, levels, splits)` gives the one JSON object
  to save (the object form for a pattern column). `mappingOf` (the worker's `columns` reply) passes
  `patterns` and `suggested` through; the page shows a *Make web addresses* box in a suggested
  column's row (`patternControl`), and sends, and saves, `mappingToSave(mapping, patterns)`; the
  command line prints the object form, and `--json` gives `pattern` beside `field`.
  An address column makes the rows attestation-centric (converted to place-centric output, each
  place is labelled by the name its rows agree on, in `pipeline.js`, as a place-centric row is by its
  name; rows that disagree leave the address as the label, with `no-label`); otherwise each row is a
  place whose `@id` is minted by `tableIds` from its id under the base address, with the id kept as
  `entityIdentifier`. No id column means no addresses and one `generic-no-ids` warning; a repeated
  id is a `DataError`, whose message names `--same-id`. With `options.sameId` (and an id column)
  `genericProfile` and `genericSource` are attestation-centric: each row is an attestation about
  the place minted from its id, and after the last row each id is one
  `{ type: 'record', newEntity: true, value: { '@id', label, entityIdentifier, attestations: [] } }`,
  which the store path (`needsStore`, then `listedThenOthers`/`r2j.entity`) regroups with its
  attestations. The reader holds only `Map(id → { names: Set })` (about 300 bytes an id, measured
  in `test/hermes-generic-same-id-large.test.js`), never a row. Names that agree are the label;
  names that differ make the id the label (`generic-same-id-label`); a row with no id is a loss
  (`generic-same-id-empty`). The page's Reading options and the command line's `--same-id`
  set `options.sameId: true`, and both refuse it in plain words when no column is the id. An unrecognised column goes to `notes`, never `properties`. The mapping, reasons
  and rows have no prototype, so a column called `__proto__` is kept. A CSV streams through Papa's
  chunk parser (`csvRecords`): the columns and guess read its header and first 50 rows, and the rows
  are read again, never kept. A FeatureCollection streams too, read twice (columns, then rows).
- **The regions a place lies in** (`within.js`, `columns.js`, `generic.js`; Methodos stage 1,
  `docs/plans/methodos.md` 5.3). A column read as `within` is a region the row's place lies in, at a
  level; levels are **positional per mapping**: the `within` columns are numbered widest first, 1 to
  n, with no gaps, and two columns cannot share one. `guessColumns` reads a heading (normalised:
  case, spaces and punctuation aside) as a region's kind and orders the guess by World Historical
  Gazetteer's own ranks (whg3 `reconciliation.js`, `ADMIN_RANK`): country 0 (`country`, `nation`),
  region 10 (`region`, `state`, `province`, `land`), county 20 (`county`, `shire`, `department`,
  `oblast`), district 30 (`district`, `arrondissement`), hundred 40 (`hundred`, `wapentake`), diocese
  42, deanery 43, parish 45 (`parish`, `civilparish`, `township`, `commune`, `municipality`…), each
  also with `name` or `label` after it; `admin0`…`admin4` and `adm0`…`adm4` at 0, 10, 20, 30, 40; and
  `contained in`, `within`, `part of`, `parent`… (no named kind) at 50, the narrowest. Two of one rank
  keep the file's order. A column of numbers under such a heading (`admin1` = 12) is codes, kept as a
  note. The ranks only order the guess: the page's level selector and the saved mapping reorder
  them. **A country column is the widest region**, an ordinary `within` level here; WHG takes
  countries as `ccodes`, a hard filter, on the lookup side, and whether to send it so is Krisis's to
  decide (Hermes never maps it to `ccodes`). The saved mapping is `{"Parish": {"field": "within",
  "level": 3}}` (`resolveColumns` returns `levels`, `{ column: level }`, beside `patterns`;
  `mappingToSave(mapping, patterns, levels, splits)` writes it back); a level that is not a whole
  number of 1 or more is `generic-mapping`, a second column at one level is
  `generic-within-same-level` (a warning, the column kept as a note), and a `within` column given no
  level takes the next free one. On the page, a level's selector offers 1 to the highest level in
  use or one for each, whichever is more (`levelChoices(level, used)`), so a loaded mapping with gaps
  ({1, 3, 6}) reaches 6 from any column. **Split into levels**: `{"Place": {"field": "split", "separator":
  ", ", "levels": [3, 2, 1], "firstIsName": true}}` (`splits`, `{ column: { separator, levels,
  firstIsName } }`; levels guessed from the sampled values' most parts when not given, and left out of
  the saved form when no sampled value has a part, since `--columns` refuses `"levels": []`), a transform
  made before `applyColumns`: `expandSplits(mapping, levels, splits)` once gives a mapping in which
  each part is a column of its own (`<column>\u0000<level>`, a `within` at its level, and
  `<column>\u0000name` the name, or an other name when a column is already the name), and
  `splitRow(row, splits, { report, where })` fills them per row (`splitCell` splits one cell: on the
  separator with the spaces around it not counting, parts trimmed, given narrowest first to the
  levels; a row with fewer parts leaves its widest levels empty). Parts beyond the levels are
  `generic-split-extra-parts`, a loss naming them. `applyColumns` gathers the row's chain, and
  `genericSource` puts it on every record and attestation event of the row as `event.within`:
  `[{ level, value, column }]`, widest first, empty cells skipped, values trimmed (a split's parts
  name the split column), and no `within` key when the chain is empty. **It is never a key of PLATO
  JSON**: the writers write `ev.value` only, and the event passes intact through `runChecked` to a
  writer or `options.sink` (`augmented` copies the event); read through the store (attestation-centric
  rows), the store path keeps by place the first `within` (and `region`, below) each place's events
  give and puts them back on its record's event (`withinByPlace`, `pipeline.js`), so Krisis's
  `readSide`/`gather` and `match`, and the version check, see `within` on every **record** event.
  **The first `within` for a place's address wins**: attestation-centric rows about one address that
  give different chains (row 2 "Newton < Lancashire", row 9 "Newton < Cheshire", both about one
  Wikidata place) give that place's record event one chain, the first row's, and the others' are not
  carried on the event (their ContainedIn attestations, under a base address, are all still written).
  That is enough for Methodos's stage 1, which reads one chain a place; a later stage that weighs
  conflicting chains must read them from the attestations, not from `event.within`.
  **What PLATO is told**, as PLATO's worked example has it (`schemas/examples/place-centric-regions.json`
  and the guide's "Regions matched to a gazetteer", PLATO 1d2cf6e, a6bc022): with a base address of the user's
  own (`options.base`: the page's Options, `--base`), each distinct container, the same value under
  the same parents, is minted once as a place-centric record (a `newEntity` record, its attestations
  given on their own about it, when the rows are attestation-centric) `{ '@id': <base>place/region-<the
  first 16 hex of the SHA-256 of its containerKey> (regionId, src/lib/sha256.js), label: "Surrey
  (England)" (its value, then its parents narrowest first), entityIdentifier: containerKey,
  attestations }`, with a name attestation (`toponym` the value) and, but for the widest, one
  `plato:ContainedIn` its parent region; each row's place gets one attestation `{ relations: [{
  relationType: 'https://w3id.org/plato#ContainedIn', relatesTo: <its narrowest region> }] }`
  and nothing more (PLATO a6bc022: no `relatedLabel`, which is for a target outside the dataset or
  standing alone, and no `relationLabel`, which is a source's own wording; a region's name is only in
  its own name attestation), the chain above following from the regions. Every one cites what
  the row's attestation cites (the file and the row where the region was first met). No `sequence`
  (it orders a route's members). Two "Newton"
  parishes under different chains are two regions, never merged; only the keys of the regions made
  are held (`regionsMade`), bounded by the distinct containers. Each region made is counted (`rep.count('regions')`), and the summary says them among the places: "Read 3 rows, 8 places (5 of them regions), 15 attestations." (`summary`, `words.js`). A region's events are tagged
  `event.region = { level, key }` and carry their parents as `within`. Linking a region to WHG is
  Krisis's (an identity relation after review), not Hermes's. **Without a base address**, nothing is
  minted (no address could be made: the no-id rule) and no relation written: each attestation gets
  the note `Within (as the source gives it): England > Surrey > Rotherhithe` (widest first, then the
  place's name; `withinNote`), and `generic-within-no-base` (a warning) says so once.
  `test/hermes-within.test.js` reads `plato:ContainedIn` from the vendored ontology, skipping visibly
  should a pin lack it. Krisis's work file takes both object forms (`isColumns` in `krisis/work.js`).
  **`src/engine/hermes/within.js`, for Krisis and Methodos**: `withinOf(event, regions?)` is the
  event's chain, or, with no `within` on it and `regions` given (`regionIndex(events)`: Map(address ->
  a region's record), from the events or a sink's), the chain its PLATO gives, read back by following
  its ContainedIn up through the regions, each region's level and value its entityIdentifier's,
  `{ level, value, iri }` (so the two agree on levels and values; only the event knows the column);
  `[]` for none. `containerKey(level, value,
  parentValues)` is `JSON.stringify([level, ...parentValues, value])`, parents widest first (labels
  may hold "/" or ","), the one definition every grouping and the minting use. `withinChains(events)`
  is `[{ name, chain, n, iri? }]`, one for each row's record or attestation event (not a region's
  own). `withinLevels(events)` is `Map(level -> Map(containerKey -> { level, value, parents, rows }))`,
  levels ascending, `rows` each `{ n, iri?, name? }`. `CONTAINED_IN` is the relation type's IRI.
  **The page**: the column table offers *Region it lies in* with a *Level* selector beside it
  (`extraControls`; choosing a level another column has swaps the two; a column that stops being a
  region gives its level up and the rest close up, unless a split's typed levels are in play), and
  *Regions, to split into levels* with its separator, its levels (narrowest first) and *The first
  part is the place's name*; `columnWarnings(…, levels, splits)` warns of two regions at one level.
  **The pasted list**: `<details id="paste">` under the drop zone (`PASTE_WORDS`): the lines that are
  not blank, trimmed, become `pastedListCsv(text)`, a CSV headed `name` with every cell quoted (so a
  `;`, `,` or tab is never taken for the separator), handed to `choose()` as `pasted-list.csv`
  (`pastedListFile`, `src/engine/hermes/pasted.js`), through the usual detection and matching. The
  command line reads files, and has none (its `--help` says so). **The command line**: `--split
  COLUMN=SEP[:LEVELS]` (repeatable; LEVELS after the last `:`, narrowest first, `name` first for
  `firstIsName`) puts a split into `--columns`, or into the guess saved as a mapping, for that column
  only; the printed mapping and `--json`'s `columns` give `level`, or `separator`, `levels` and
  `firstIsName`. Out of scope: spelling clustering (grid references are read: below).
- **Grid references** (`gridref.js`, the column field `gridref`). `parseGridRef(text)` reads two
  letters (Ordnance Survey National Grid) or one (Irish Grid) and an even number of digits, with or
  without spaces (two groups must be of one length), as `{ grid, letters, digits, sizeM, easting,
  northing }` (the square's south-west corner) or `{ error }` in words: no letter I, letters naming a
  100 km square of the National Grid (eastings below 700 km, northings below 1300 km from the false
  origin's square S; any of the Irish Grid's 25), at most ten digits. n digits per axis are a square of
  10^(5-n) m: letters alone 100 km, two figures 10 km, four 1 km, up to ten, 1 m. `gridRefToWgs84`
  takes the square's **centre**, converts it with `gridToLatLon` (the inverse Transverse Mercator of
  the OS's *A Guide to Coordinate Systems in Great Britain*, v3.6, annex C, on Airy 1830 or Airy
  modified, with its table A.2's projections) and `datumToWgs84` (Cartesian, a 7-parameter Helmert in
  the position vector convention, back to GRS80): for OSGB36 the guide's table 4 with every sign
  changed (its section 6.2), whose error the guide gives as up to 3.5 m (95%); for TM65, EPSG 1641
  (Ordnance Survey Ireland's parameters), 1 m. `precisionKm` is the larger of the square's half
  diagonal (the farthest a point of the square is from its centre) and that accuracy, so 70.71 km for
  letters alone, 0.7071 km for four figures, 3.5 m (OSGB) or 1 m (Irish) for ten; `spatialPrecision`
  is `approximate` for a square of 1 km or more, and absent below. The geometry keeps the reference as
  written in `sourceLabel`, and the attestation's notes say which transformation was used and its
  accuracy. OSTN15, the OS's definitive transformation (about 0.1 m, Open Government Licence), is
  not used: its grid is about 15 MB. A column is guessed `gridref` from its heading (`grid ref`,
  `NGR`, `OSGB`, `OS grid`, `irish grid`… in `HEADINGS`) when at least half its sampled values are
  references, and from its values alone, when its heading says nothing, if at least half are
  references of a 1 km square or finer, four digits or more (`looksLikeGridRef`: letters alone, such
  as a state code, are not enough, and neither are UK postcode districts such as E14, SW11 or NW10,
  which have at most two digits and would otherwise be read as 10 km and 100 km squares).
  Irish Transverse Mercator (ITM) coordinates, which are numbers with no letters, are not read. A
  missing value's marker in the column (R's `NA`, `N/A`, `NULL`, `NIL`, `NONE`, `NaN`, a dash, `?`:
  `isMissingMarker`) is an empty cell, with no location and nothing reported, since `NA` is otherwise
  the National Grid's 100 km square NA, in the Atlantic; other fields are unaffected. An
  invalid reference is `generic-gridref-invalid` (a loss, with the value), and every reference of
  letters only is `generic-gridref-square-only` (a warning, "read as a 100 km square"), so a column of
  them, which may be codes rather than references, is seen. A row with a latitude and
  longitude too takes its location from those; the reference is kept in the notes, and
  `generic-gridref-disagrees` (a warning) is given when the two are farther apart than the
  reference's `precisionKm` plus half the last decimal place of the latitude and longitude. A POINT in
  the row's `wkt` or `geometry` column, when there is no latitude and longitude, is treated the same
  way (`cellPoint`): it is the location, the reference goes to the notes, and the same warning is
  given, with the point's own decimals. A `wkt` or `geometry` that is not a point (a polygon, a line)
  is kept beside the reference's point, so that row has two geometries and nothing is compared. The tests
  (`test/hermes-gridref.test.js`) check the guide's worked examples (annex C to 0.0001", annex D's
  Helmert) and the OS's OSTN15 test points (`OSTN15-OSGM15-DevelopersPack.zip`) and its Northern
  Ireland Irish Grid ones, which come from OSTN15 and OSNI's transformation, not this Helmert: six
  GB points within 3.5 m, and TP31 (North Uist), 4.9 m, out of it, as the guide's 95% allows at the
  grid's edges (4 of its 40 points, at Scilly and the Western Isles, are 4.1 to 4.9 m out); the
  Northern Ireland points are within 0.44 m.
- **Reading options** (the page and the command line). The page has one `<fieldset id="reading">`
  after `#columns`, filled by `src/app.js` (`renderReading`) in `words.js`'s `READING_WORDS`, shown
  only for TEI or a table of places, every control off: TEI's `listPlaces`, and a table of the keys'
  prefixes from the worker's `tei-keys` command (`teiKeyPrefixes`; its reply carries the page's
  `columnsAsked` id, as `columns` does, and a stale one is dropped), each with its suggested pattern
  filled in and unticked; a table's `sameId`. The worker's `ready` says whether the options for the
  editors' words may be shown (`reading.editorial`, `EDITORIAL_IRI !== null`, as it is); were it null,
  `headerPlaces` and `commentaryPlaces` would not be shown. `readingOptions()` adds only the options that
  are on to the run's `options` (`keyPatterns` as `{ prefix: pattern }`, `''` for keys with no
  prefix). No `title` attributes and no explanatory prose: hints await the shared tooltip module (a
  TODO in `app.js`), and the report says what each option does. The command line's `--list-places`,
  `--key-pattern [PREFIX=]PATTERN` (repeatable; a prefix has no `:`, `,` or `/`, so a pattern with an
  `=` of its own is read whole), `--header-places`, `--commentary-places` (both giving `plato:Editorial`) and `--same-id` are for `check` and `convert`. Each input is
  detected first when one is given, and a flag that applies to none of them, or `--same-id` for a
  table with no id column, is a usage error (exit 2). TEI options go only to TEI inputs and `sameId`
  only to tables; `--json` gives a TEI input's `keyPatterns`. `test/cli-reading.test.js` and the
  Reading options checks in `e2e/app_test.py` cover both.
- **Addresses** (`addresses.js`). `placeAddress(value)` returns `{ iri }`; `{ iri, from, rules }`
  when it rewrote the address by the rules below (`from` is what the source wrote); `{ iri, part }`
  for part of a Pleiades place's record, carried as given and reported (`address-pleiades-part`, a
  warning in all three readers); `{ iri, page: true }` for a page of a site that is not a gazetteer
  (Wikipedia, `goo.gl` and `maps.app.goo.gl` short links, Google Maps), carried as given and reported
  (`address-web-page`, a warning); or `{ lost, value }` for an address on Pleiades' or GeoNames' host
  that is not a place's record once the canonical rules have run (Pleiades: anything but
  `/places/<digits>` and its parts, such as `/places/` alone or a doubled
  `/places/http://pleiades.stoa.org/places/687966/`; GeoNames: no numeric id as the path's first
  step, such as `/maps/…`, `/search…`, `/advanced-search…`), refused in every reader as
  `address-not-a-place` (a loss), a WHG portal address below whg_id 12,345,678
  (`whg-portal-record`) or one on dev.whgazetteer.org (`whg-staging`). It applies the canonical rules
  (`canonicalAddress`) first, then that check (`notAPlace`), then WHG's; no address matches two, so
  the order cannot change a result. The check rewrites nothing, so it is not a rule of the table
  below and does not change its version. The Recogito, TEI and CSV/GeoJSON readers all pass every place address
  through it, and a rewritten address gets the note `addressNote` words: "Place address given as X
  (rule <name>, hermes-addresses 1)".
- **Loss kinds.** Each reader lists its kinds with their severity (`TEI_KINDS` in `tei.js`,
  `GENERIC_KINDS` in `columns.js`: `loss`, `warning` or `error`), and their words are in
  `src/engine/report.js`'s `LOSS_TEXT` under the same `tei-*` and `generic-*` names, with
  `address-pleiades-part` shared by all three readers that take place addresses. The tests
  require a text for every kind.
- **The pipeline hook** (`pipeline.js`, `sourceFor`, which `runChecked` and the preview share):
  `tei` goes to `teiSource`, `csv` and `geojson` to `genericSource`. TEI is attestation-centric, so it goes through the store like
  annotations; for a table of places `genericProfile` reads the mapping first to decide the profile,
  and so whether the store is needed, and its records are schema-checked like the tables'.

- **The preview** (`src/engine/hermes/preview.js`, `preview({ input, options, limit }, env)`):
  the first `limit` record and attestation events of a table of places, a TEI edition or W3C
  annotations (`PREVIEWED`; anything else is a `DataError` in `PREVIEW_WORDS.refused`'s words), read
  through `sourceFor`, so that they are exactly the first events a run's reader gives (the tests
  deep-equal them for a CSV, a GeoJSON, a TEI and an annotations fixture). Equality is with the
  reader's event stream, not with what a run writes: attestation-centric input is regrouped by
  place through the store at the end of a run, which the preview never reaches. It reads one
  record past the limit, to know whether there is more, then breaks out of the reader, whose
  generators close in turn; each lets go of its stream in a `finally` (`textChunks`, `lineChunks`,
  `jsonDocument`, `annotationItems` and the TEI reader's `chunks` cancel it, `csvRecords` and the
  TEI head buffer close the chunks they took by hand), which the tests check on a file that counts
  its streams, for each format made larger than a few 64 KB pieces. Each event is schema-checked as
  a run checks it; env is given only `resources` and `xlsx`, so it never calls `env.output` or
  opens a database. It returns `{ header, profile, items, report, complete, read, total, why }`:
  `report` as it stood at the last record shown (so the record read past the limit, and its losses,
  are not shown), `read` the reader's counts including that record, `total` only when the whole
  input was read (the input is never read to its end to count it; `previewLine` words the line
  "first N of M records" or "the first N records read; the rest not read", with "nothing checked or
  written"), and `why`, when partial, built from `PREVIEW_WORDS`: stopped, regrouped (attestation-
  centric), places made at the end (`sameId`), and, from the TEI reader's `watch` hook (the 4th
  argument of `teiSource`), the names still waiting for a `<place>` (`pending`) or held until the
  edition div is known (`held`) when reading stopped. The report then carries `preview-partial`, a
  warning, as the report has no notice severity. The worker's `preview` command (no database, the
  page's `id` in its reply), the page's button (shown for those formats, enabled once the columns
  are answered or the TEI keys looked for, cleared when the matching, sheet, reading options or base
  change; its result in `state.preview`), and `plato-tools preview [--limit N]` (records as JSON
  Lines to stdout, the rest to stderr, or one object with `--json`; exit 0, 1 with problems in what
  was read, 2 when none could be made) all call it.

#### Grouping similar spellings for lookup, and lookupName on events (Methodos #28, stage 1)

`src/engine/hermes/cluster.js` is OpenRefine-style key-collision clustering, written here with no
dependency. `clusterValues(values, { method })` takes any iterable of strings (a column's cells, a
level of containing regions once the 'within' role lands, a pasted list) and gives
`[{ key, members: [{ value, count }], suggested }]`: only keys shared by two or more distinct values,
members most frequent first (a tie: first met), `suggested` the first member, clusters by rows then
member count then key, so the output depends only on the values. `clusterCounter` is the same,
streamed (`add(value)`, `clusters()`, `distinct`): a Map of distinct values and their counts, which
is all that is held (100,000 values in well under a second, `test/hermes-cluster.test.js`). Blank
values are not counted, and a value whose key is empty (punctuation only) is not clustered.

| Method | Key |
|---|---|
| `fingerprint` (default) | OpenRefine's fingerprint keyer: trim, lower-case, NFKD with combining marks dropped and ß æ œ ø ł đ ð þ ı ŋ ħ spelt out, Unicode punctuation, symbols and control characters (not whitespace) removed, split on whitespace, words de-duplicated, sorted, joined with a space |
| `ngram-fingerprint` | OpenRefine's n-gram keyer, n = 2: as above with whitespace removed too, every 2-letter run, de-duplicated, sorted, joined with nothing; a value shorter than 2 is its own key |
| `phonetic` | Cologne phonetics (Postel 1969), written from the published rules (no code ported; the tools' own licence), on each word of the fingerprint, the codes kept whole (not cut to 4), de-duplicated and sorted; a digit is kept as itself, a word with no Latin letter is kept as it is. German rules: coarse for English (`Rotherhithe` = `Redruth` = 7272), finer than Soundex (`Bradford` and `Bradfield`, both B631 there, stay apart) |

Applying is never silent and never touches the source's spellings. The confirmed groups are
`{ "<column>": { method, groups: [{ chosen, members }] } }`, checked by `checkClusters` (a member in
two groups of one column, an empty `chosen`, an unknown method: a `DataError`), and given to a run
as `options.clusters`. `genericSource` (generic.js) applies them with `lookupSpellings(clusters)`:
for each row whose cell in a grouped column, trimmed as `cellText` trims it, is a member, the
row's attestation gets a note of its own line, `Grouped for lookup with: <the group's other
spellings> (spelling chosen: <chosen>)` (for a column other than the name, `The column "<c>"
grouped for lookup with: …`), and the event gets:

- **`lookupName` on events**: the chosen spelling, when the grouped column is the one mapped to
  `name`. It is on the event (`{ type: 'record' | 'attestation', value, n, lookupName,
  lookupValues }`), beside `value`, never in it: `value.label` and `value.attestations[].names` keep
  the source's spelling, and nothing is written for it but the note. A lookup that reads the
  reader's events (Krisis, Methodos's region levels) sends `ev.lookupName` where there is one, else the name it would have sent. A
  lookup that reads a saved PLATO file instead has the note, and the groups file:
  `lookupSpellings(clustersInFile(json)).apply(row, null, nameColumn)` gives the same answer for a row, and the
  members of each group map to its `chosen`. Krisis's code is unchanged; it does not yet read
  either.
- `lookupValues`: `{ "<column>": chosen }` for every grouped column of the row, the name's
  included: the per-level lookup value a 'within' level will use.

A group for a column the file lacks is a warning, `generic-clusters-unknown-column`, and nothing
else. Rows read with `sameId` carry it on each attestation, not on the place made at the end.

Saving: inside the mapping no key is safe, since any text can be a column's heading (a
`__clusters` column included). So the page's *Save matching* writes the mapping alone while no
group is ticked, as before, and otherwise the envelope `{ "columns": {mapping}, "clusters": {…} }`
(`matchingToSave`), which `savedColumns` already reads as options and `splitMatching` splits; a
mapping whose columns are called `columns` and `clusters` is still told apart (`isMatchingEnvelope`:
`columns` must be an object that is not a `{ field }`). `--clusters FILE` reads the envelope,
`{ clusters }` or the groups alone (`clustersInFile`); `--columns` given an envelope uses its mapping
and says on stderr that its groups need `--clusters`. `plato-tools cluster --column NAME [--method
M] [--sheet NAME] INPUT` streams the column (`columnValues` in generic.js) and prints `{ input,
column, method, values, distinct, clusters }`, applying nothing.

On the page, `src/hermes-spellings.js` (`spellingsPanel`) owns `#spellings`, below the Reading
options, for a table of places; `src/app.js` only calls it (reset on a new file or sheet, the
columns when answered, `options()` into the run's and the preview's options, `confirmed()` into the
saved matching, `load()` from a loaded one, `problem()` into `readingProblem`). The worker's
`cluster` command answers `{ column, method, values, distinct, clusters }` for the page's `id`.
Groups are shown unticked; `confirmedGroups(column, method, shown)` keeps only ticked ones with a
spelling, and any tick or edit of a ticked spelling clears the preview. A group found again with
the same members keeps its tick and spelling. Its state is `window.__plato.spellings`.

#### Address rules, hermes-addresses 1 (2026-10-01)

| Rule | Written as | Carried as |
| --- | --- | --- |
| `pleiades-https` | `http://pleiades.stoa.org/places/<n>` | `https://pleiades.stoa.org/places/<n>` |
| `pleiades-slash` | `https://pleiades.stoa.org/places/<n>/` | `https://pleiades.stoa.org/places/<n>` |
| `geonames-page` | a GeoNames page: `http(s)://(www.)geonames.org/<n>`, with or without a closing `/` and a name (`/<n>/siracusa.html`) | `https://sws.geonames.org/<n>/` |
| `geonames-https` | `https://sws.geonames.org/<n>`, without its closing slash | `https://sws.geonames.org/<n>/` |
| `geonames-sws-https` | `http://sws.geonames.org/<n>`, with or without its closing slash | `https://sws.geonames.org/<n>/` |
| `wikidata-page` | `http(s)://(www.)wikidata.org/wiki/Q<n>` | `http://www.wikidata.org/entity/Q<n>` |
| `wikidata-https` | `https://www.wikidata.org/entity/Q<n>`, or `http(s)://wikidata.org/entity/Q<n>` (without `www.`) | `http://www.wikidata.org/entity/Q<n>` |
| `whg-record-id` | `place:<ns>:<id>` (with no `prefixDef` for `place`, in TEI) | `https://w3id.org/whg/id/place:<ns>:<id>` |
| `whg-entity-page` | `http(s)://(www.)whgazetteer.org/entity/place:<ns>:<id>[/api][/]` | `https://w3id.org/whg/id/place:<ns>:<id>` |

Both Pleiades rules can apply to one address (`http://…/places/<n>/`); its note names both. Each
gazetteer's canonical form is the one it gives as its place's address: Pleiades' https address, and
GeoNames' and Wikidata's RDF addresses (GeoNames' `https://sws.geonames.org/<n>/`, slash included;
Wikidata's `http://www.wikidata.org/entity/Q<n>`, http included). Anything else is carried as
written. A Pleiades address that names part of a place's record (`/places/<n>/<slug>`, a location or
a name; `/places/<n>/json`) or the place in Pleiades' own data (`/places/<n>#this`) is carried as
given and reported as `address-pleiades-part`, never rewritten to the place's address.

Any change to a rule, or a new one, is a new version: change `ADDRESS_RULES` and this heading
together (`test/hermes-addresses.test.js` fails when they differ, or when the table and the tests'
rules differ), since every note names the version. **The version check** will show attestations an
earlier version converted, and this one rewrites, as changed (their `about` and their notes differ),
and the version in the notes says why. Agora mints addresses only for attestations about places under the
dataset's own base address (an attestation about a Pleiades, GeoNames or Wikidata place is left
without one, `place-outside-base`), so releases already published are mostly untouched.

#### Preferred authorities, hermes-preferred 1 (2026-10-01)

A place given several addresses (a TEI `<place>`'s idnos or links, a ref's addresses, or a `#x`
ref's place's) is one place. After the address rules above, `preferredAddress` (`addresses.js`)
groups the addresses by authority (`authorityOf`: the rows below; any other address by its host,
without a leading `www.`). Two different addresses from one authority name two records of one
gazetteer: the place is ambiguous, refused and reported (`tei-listplace-ambiguous` for a listed
place, `tei-ref-ambiguous` for a ref, each listing the two). Otherwise the attestation is about the
address of the first authority in this order, and carries `identities`, one for each other address
(in the same order): `{ subject: <preferred>, object: <other>, identityType: "unspecified" }` (the
edition links them without saying how strongly; the relations bundled by an attestation share its
provenance, so the attestation's citation of the edition is theirs, and they carry no `source` of
their own). Its note names the addresses and this version, and each place is reported once
(`tei-several-ids`, a warning: carried, worth a look). A listed place's coordinates are compared
with the preferred address's host only.

| Order | Authority | Addresses |
| --- | --- | --- |
| 1 | `pleiades` | Pleiades: `pleiades.stoa.org` |
| 2 | `whg` | World Historical Gazetteer: `w3id.org/whg/…`, `whgazetteer.org` |
| 3 | `geonames` | GeoNames: `sws.geonames.org`, `(www.)geonames.org` |
| 4 | `tgn` | Getty TGN: `vocab.getty.edu/tgn/…` |
| 5 | `wikidata` | Wikidata: `(www.)wikidata.org` |
| 6 | `gnd` | GND: `d-nb.info/gnd/…` |
| 7 | `viaf` | VIAF: `(www.)viaf.org` |
| 8 | `pmb` | PMB (a project's own): `pmb.acdh.oeaw.ac.at` |

Gazetteers of places come first, then authority files, then a project's own; any other host comes
after them all, in alphabetical order of its host.

An address that is a web page rather than a gazetteer record (the ones `placeAddress` marks `page`
and the readers report as `address-web-page`: Wikipedia pages, `goo.gl` and `maps.app.goo.gl` short
links, `google.com/maps`) is never the preferred address nor the object of an identity relation. It
is left out of the grouping, still reported as `address-web-page`, and the attestation's note names
it as given but not used as an identifier (`pagesNote`). Only where a place's addresses are all web
pages does one count: a lone web page is carried as given, with its warning, as before; several are
ambiguous, refused and reported (`tei-listplace-ambiguous`, `tei-ref-ambiguous`, listing them). A change to the order, or a new authority, is a new version:
change `PREFERRED_RULES` and this heading together (`test/tei-ids-and-notes.test.js` fails when the
heading, the rows and `AUTHORITIES` differ), since every such note names the version and an earlier
conversion's attestation may be about a different address.

**Georeferencing** (`src/engine/georef/`, on branch `hermes-georef`, shared with Chora). Positions
on a map image to positions in the world and back, through a IIIF Georeference Annotation as
Allmaps makes them. `readGeoreference(annotation, { manifest, canvasId, index })`, `toWorld(g,
geometry, { space, … })` and `toPixels(g, geojson, { space, … })` are async; `space` (`'canvas'` or
`'image'`) is required. `matchesTarget`, `containsRegion`, `georefNote` and `georefCitation` are
synchronous. The Allmaps libraries are loaded by dynamic `import()` on first use, so a page that
never meets a georeference never downloads them (`test/georef-lazy.test.js` checks this in a fresh
process). Nothing in the module fetches: the caller supplies the annotation and the manifest. The
transformation is fitted in Web Mercator, as Allmaps renders it, and results are WGS 84; an
annotation with its own `resourceCrs` is refused. Where the inverse is undefined or several
positions fit, it is a `DataError`, never a wrong position. The annotation's transformation,
including a polynomial's order, is authoritative: Allmaps' renderer takes only the type and would
draw an order-2 or order-3 map at order 1, so Chora passes `allmapsTransformationName(g)` to
`setMapTransformationType`. Records carry the annotation's version and `modified` (which
`georefNote` states in a sentence of its own) and, for least-squares transformations, how far the
fit misses its own control points (`controlPointMisfitKm`, `controlPointMisfitMaxKm`; null for a
thin plate spline), stated in the note only with `{ misfit: true }`. `georefCitation(record, {
region, pad })` pads a region by `pad` canvas pixels, none by default. `metresPerPixel(g, px, { space, transformation })` (async) gives the ground scale at
a pixel as `{ x, y, mean }` metres per pixel of `space`, by a ±0.5 px symmetric difference through
the same transformation and canvas scaling as `toWorld`, and refuses as it does. The IIIF helpers
`normaliseId`, `manifestCanvases`, `partOfCanvases`, `labelText` and `parseImageRequest` are public,
re-exported from `iiif.js` by `index.js` (`test/georef-exports.test.js`). The fixtures, real Allmaps annotations
and IIIF manifests with reference values from Allmaps' own code, are described in
`test/fixtures/georef/README.md`.

## The version check

What it reports, and why, is in the guide:
[Comparing two versions](https://pelagios.org/place-attestation-ontology/guide/tools.html#comparing-two-versions).
`src/engine/compare.js` holds it.

- **Each version is read by `run()`** with `options.sink`, so every input reaches the check as
  place-centric records, whatever format it came in. Each record goes through `Json2Rdf`, and each
  attestation's statements are written out with every node that has no IRI in place and every
  node that has one by its IRI, sorted, so that blank node labels, key order and form never
  matter.
- **Only digests are kept**: 128 bits of SHA-256 per attestation and per statement about a named
  thing, in a SQLite ledger (`src/lib/sha256.js`, synchronous because the pipeline's sink is).
- **Facets by address.** A named node that an earlier attestation points to by `attests_*` (other
  than `attests_about`) or `has_citation` is part of what it says (PLATO's `plato:Gazetteer`), so a
  lost statement about it is a breach, and an added one a warning. A facet no longer described that
  no later attestation points to went with the attestations that did, whose deletion is reported
  already, so it is not reported again (DEEP's names have addresses, and a deleted attestation
  would otherwise count twice). Any other named node (a place, a
  source) may be corrected: a lost statement is a warning, an added one nothing.
- **An address used twice** in the later version, once unchanged and once saying something else,
  is one node in RDF, so it is a changed attestation. **An address lost**, where the later version
  says the same without it or under another, is a breach of its own (`attestation-readdressed`),
  since its remedy is the address, not the content.
- **A stand-in label is not compared.** Reading RDF or attestation-centric JSON, the pipeline gives
  a place with no label its address as a label; that statement is not the data's, so the check
  leaves it out, or every such place would read as relabelled. (A table of places' rows about an
  address label their place by the name they agree on, which is the data's, and is compared.)
- **What changed.** When anything changed, both versions are read a second time, keeping the
  statements of the first five changed things of each kind only (as many as the report shows), and
  each example is given the statements one version makes and the other does not.
- **The queries** (`QUERIES`) each look up, for every row of one version, its counterpart in the
  other, so every inner lookup must go by an index on more than the version. SQLite once chose the
  wrong index and the comparison became quadratic; the queries now say `INDEXED BY`, and a test
  reads SQLite's plan for each.
- **Candidate sets** (PLATO 05cf78a). Two copies of one candidate set (the same `@id`) are compared
  candidate by candidate, as attestations are: a candidate is a node with `plato:candidate_source`,
  kind 2 in the ledger. A published candidate set is frozen as a whole (the candidate set
  specification, 13.4): its address is minted from a hash of its candidates' texts (13.5), and new
  suggestions go in a new set, which leaves out those already published. So a candidate removed or
  changed in any field (its places, score, software, settings, time or status) is an error, named by
  its address with what changed (`candidate-removed`, `candidate-changed`, `candidate-readdressed`),
  whatever became of it: that is read from the attestations that answer it, never from its status. A
  candidate added is an error too (`candidate-added`, named by its address, saying that new
  suggestions belong in a new candidate set); one given a new address is readdressed, not added as
  well. The counts say `counts.of` is `'candidates'`. A set has no `status`; it binds from issue. A
  changed `issued` or `candidatesFor` is an error (`candidate-set-issued-changed`,
  `candidate-set-for-changed`). A corrected title, description, creator or licence is reported and
  allowed, as 13.4 says (`candidate-set-described-changed`, a warning naming the fields), since a
  description may be corrected as an Authority's may. A dataset against a candidate set (`different-kinds`), and two sets under
  different addresses (`different-candidate-set`: a later run is a new set, not a version, and the refusal points to
  `plato-tools check --candidates <earlier> <later>` for Elenchos's `already-published`), are
  refused in words and marked incomplete. On the dataset side, `promotedFrom` is part of what an
  attestation says (its identity relation is written out in it, or, with an address, is a facet of
  it), so changing, adding or removing one is a breach already. A dataset's `candidateSets` is the
  reverse of `plato:candidates_for`, a statement of the set's naming the version's own address, so it
  is left out of the comparison of named things (it would change with every version), and the two
  headers' lists are compared instead: a set gone from the list is a warning
  (`candidate-set-unlisted`), as a place no longer described is, since the list is the dataset's
  description of itself, not an attestation; a set added is reported and allowed, as 13.4 says
  (`candidate-set-listed`, a warning, as a corrected description is). `test/compare-candidates.test.js`
  has a failing case and a control for each.
- **At scale**: DEEP's export against itself, 1.4 million attestations a side, took under six
  minutes on the command line, 520 MB of memory and a working database of 860 MB.
  `e2e/compare_scale.mjs` deletes, changes and adds one attestation in a hundred of a published
  export and requires exactly those counts back: on DEEP, 14,144 deleted, 14,143 changed and 14,143
  added were all found, with nothing else but a warning for each of the 32 sources only the deleted
  attestations cited, in under ten minutes (the second reading included) and 490 MB of memory.

## Publishing (Agora)

What each part reports, and the order to take them in, is in the guide:
[Publishing your dataset](https://pelagios.org/place-attestation-ontology/guide/tools.html#publishing-your-dataset).
`src/engine/agora/` holds it: `index.js` runs one part, reading the dataset through `run()` as the
version check does, and each part is a module of its own, with its wording in its own `TEXT`.

- **The four parts.** `report` (`fair.js`) grades the dataset's description against FAIR and writes
  the deposit files (`.zenodo.json`, `CITATION.cff`, DataCite 4.7 JSON, which agree with each
  other); `mint` (`mint.js`) writes a copy in which every attestation has an address,
  `<place>#a-<hash>` from the digest the version check uses, inherited from a previous release
  where it has one and never changed once given; `site` (`site.js`, `site/`) writes a page and a
  JSON-LD document for every place and source, for GitHub Pages, with the workflow that builds it;
  `w3id` (`w3id.js`, `w3id/`) writes the `.htaccess` for a w3id.org namespace and the addresses to
  test it with. A part that writes something to publish writes nothing from a dataset the check
  finds problems in; the report writes no deposit files while it finds errors of its own either.
- **One address scheme.** `address.js` is the only place that says where things live: the address
  of a place, a source, an attestation, a release and a download, and the file the site holds for
  each. The report, minting, the site and the rules all ask it, so the data, the files and the
  redirects cannot drift apart. Change an address there or nowhere.
- **Folder or zip.** `tree.js` writes a set of files as a folder on the command line and as one
  zip, streamed into a single output, in the browser, which cannot write a folder without asking
  for each file. A part asks for a tree and does not know which it has.
- **Which tools made the site.** The site's workflow runs the same commit of PLATO tools that made
  the site locally. `src/node/build-info.js` finds it: from git in a clone of the tools, else from
  the lockfile of the project they are installed in (npx's cache is one), else from
  `src/build-info.json`, which `scripts/build-info.mjs` writes before the page is built.
- **The site's size** is estimated while the dataset is checked, from each record's size and
  factors measured on PLATO's examples (`FACTORS` in `site.js`; `test/agora-site.test.js` fails if
  the estimate ever falls short of what is written), against GitHub Pages' 1 GB. Over it, the page
  refuses, and the command line writes the site with a warning. DEEP cannot fit whole. A subset of
  the places (`options.only`) keeps a site within it: a text file of place keys, one to a line,
  given as `--only FILE` or as *Only these places* on the page, and read the same way by both
  (lines trimmed, blank ones skipped) in `bin/plato-tools.mjs` and `src/app.js`.
- **The w3id rules in Apache.** `test/agora-w3id.test.js` serves the folder with Apache's own
  `httpd:2.4` image in Docker and asks for every row of `tests.tsv`, as curl would, then shows a
  copy without the `text/html` rule failing. It is skipped, visibly, when Docker or the image is
  not there (a test does not download 60 MB): `docker pull httpd:2.4` to run it.

Traps found on the way:

- **CI must never mint.** Addresses minted in the site's workflow would be minted afresh on every
  push, and an address that changes is none. The user mints once and commits the copy with ids; the
  site refuses a dataset whose attestations have no addresses, and never makes them itself.
- **Duplicate places.** Two records whose addresses are the same, or differ only after `#` (which a
  server never sees), would write the same files; only the first gets them, and the rest is a
  `duplicate-place` problem, not a page silently overwritten.
- **The browser checks' port.** Another session's preview server on the port `e2e/app_test.py`
  uses would be tested instead of this build, and pass. Set `E2E_PORT` to a free port (`ss -ltn`);
  the run stops if the port is taken. The preview server is started in a session of its own and
  stopped as a group: stopping `npx` alone left `vite` holding the port.

## Match review

Krisis suggests places of one dataset (the subjects) that may be the same as places of another (the
others), and records the reviewer's judgements as PLATO attestations. `src/engine/krisis/` holds it;
`README-api.md` there lists what the page calls. Matching two local files sends nothing anywhere.

- **Each dataset is read by `run()`** with `options.sink`, as the version check reads, so every input
  format is matched alike (the tests match the same places as JSON, Linked Places Format and
  spreadsheet tables). Of each place only its address, label, names (label, every toponym and
  romanised form, from attestations that are not denials), one point (from attestations that are
  neither denials nor withdrawn: PLATO's judgements example retracts a bad import that put
  Littleworth at 0°, 0°, and that point is not Littleworth's; withdrawals are resolved over the whole
  dataset, so a retraction that is itself retracted elsewhere restores the point), country codes and types, and
  the identity relations either dataset states are kept, in memory. A place without an `@id` cannot
  be matched, and is reported as a problem.
- **Scoring** (`names.js`, algorithm `krisis-names 7`). Names are normalised: NFKD, combining marks
  removed, ß æ œ ø ł đ ð þ ı spelt out, lower-cased, everything but letters and digits a space. Two
  names score their Jaro-Winkler similarity (prefix scale 0.1, up to four letters) or, if higher, that
  of their words sorted, so that "Upper Newton" and "Newton Upper" agree. Two places score the best
  pair of their names. The work file's `match_parameters.scoring` says the same, so that a review can
  be read without this file.
- **Names alike only in a word they share** (`distinctive()`, new in `krisis-names 2`). Jaro-Winkler
  rewards a shared beginning, so "Saint Martin" and "Saint Maurice" scored 0.921 and "East Ham" and
  "West Ham" 0.917 on letters alone. Now the words both names have are set aside (a word also counts
  as shared with its known short form, `SHORT_FORMS`, and only these: St and Saint, Ste and Sainte, Mt
  and Mount, Ft and Fort, Pt and Port, on and upon), and what is left of each is compared. If the rest is alike (at least 0.85, `DISTINCT_GATE`, or one letter added,
  dropped, changed or two swapped), the pair scores the shared words' share of the weight plus the
  rest's score over the remaining weight; if not, the shared words' share alone (Saint Martin and
  Saint Maurice now 0.333 with equal weights). Each word weighs its inverse document frequency in the
  names of both datasets, ln(1 + N / df), so a common word such as Kafr or Tell counts for little.
  This only ever lowers the name score, and names that share no word, or where every word of one is
  shared ("Newton", "Upper Newton"), keep it. Respellings and reorderings stay over the threshold
  (Tell Brak and Tell Barak, Stratford upon Avon and Stratford-on-Avon: the tests hold both lists).
  **Words of three letters:** one letter changed scores 0.78 to 0.82 on the letters, so the pair
  reaches 0.85 only when the words it shares weigh a sixth to a third of all its words. Kafr Cal and
  Kafr Cel score 0.87 with every word weighed alike, but once Kafr is common in the datasets it weighs
  little, and they score 0.836 and are not suggested (the tests hold both, with weights as a gazetteer
  gives them). So for a distinctive word of three letters one letter is already the limit, and a
  common shared word takes the pair under it; and letters alone cannot tell "East" from "West", so a
  short distinctive word that differs by more than one letter is never suggested. The limits are
  deliberate. (Until `krisis-names 3` this file said Kafr Cal and Kafr Cel were suggested; with the
  weights of a real gazetteer they are not.)
- **Abbreviations** (`expandedScore()`, new in `krisis-names 3`). Counting St as shared with Saint
  set the pair's distinctive score aside, but the name score still counted the letters of "st" against
  "saint": Mount Pleasant and Mt Pleasant scored 0.813 and Saint Zan and St Zan 0.775, not suggested,
  while Saint Martin and St Martin (0.950) were, so whether St and Saint passed depended on the length
  of the other word. Now two names whose words are all shared, some only as a known short form, are
  scored again with each short form written out in full, and the higher score is kept: such pairs
  score 1. This is the one case where a score is raised; a pair with a word not shared is still lowered
  as above (Saint Martin and St Maurice 0.333). **The short forms are a list** (new in `krisis-names
  4`). Until then any contraction counted (a word of at most three letters whose letters are in order
  in the other, ending alike, two letters shorter), and a trial on real data (DEEP, 539,372 places)
  found it wrong in principle: it scored Danebury Hill and Dry Hill, Great Baddow and Great Bow, Tan
  Hill and Tapton Hill, Cornbury Park and By Park at 1, 85 of the 89 pairs at 1 that were not the same
  name. Salt Ives and St Ives, Foot Lee and Ft Lee, Lake Mans and Le Mans were 1 too. Rd for Road is no
  longer written out, and on the scale test three planted pairs a doubled letter apart after a common
  word (Ain Bo and Ain BBo, 0.710) are no longer suggested: only the contraction rule found them.
- **Names that differ by a qualifier** (`qualifierScore()`, new in `krisis-names 6`; the lists per
  language, `qualifiers.js`, new in `krisis-names 7`; `match_parameters.qualifiers`). Chipping Ongar
  and Ongar scored 0.514, so they were never suggested, while Abingdon and Abingdon-on-Thames (0.889)
  were, only because the qualifier trails. A qualifier is a word or phrase on one of the **lists
  chosen** (see the table below; by default only the measured English, Welsh and Latin list):
  Chipping and Market in front; Regis behind; or at the end a phrase of
  on, upon, under, next, juxta or super and at most three words after it ("on Thames", "next the
  Sea", "under Wychwood"). The rest is the name's core, which keeps a word not on the lists. When one
  name has every qualifier the other has and more, and their cores are the same (scoring 1: the same
  words, but for their order or a short form), the pair scores **0.88** (`QUALIFIER_CAP`): over the
  threshold, so it is suggested, but under any respelling, because a qualifier is still a
  difference. **The rule only ever raises a score**: a pair letters already score over 0.88 keeps
  that score (Abingdon-on-Thames 0.889, Market Harborough 0.918 with its words sorted), so a pair
  letters would find at a threshold over 0.88 is still found with qualifiers on (until the Fable
  review of 1 October 2026 the cap lowered them to 0.88). **When each name has a
  qualifier the other has not** (Chipping Ongar and Market Ongar) the
  rule does not apply, and they score as before, low. **A core respelt is not raised**: the first
  version scored 0.88 times the cores' score, and in the trial below every pair it added that way was
  wrong (Bradfield and Great Bardfield, 0.851). **A common core is not a place**: when a qualifier
  word added (a phrase counted by its joining word) weighs more by inverse document frequency than the
  core, the pair scores the core's share of the weight, if lower (where Farm is in more names than
  Market, Market Farm and Farm score under a half); a core in no more than 50 names
  (`QUALIFIER_RARE`) is never common, as in a small dataset the qualifiers are rare too. **Only words
  that rarely mark a separate place** are qualifiers (the maintainer's ruling of 1 October 2026,
  `krisis-names 7`): `krisis-names 6` had sixty (Great, Little, Long, Old, New, North and the other
  points, Upper, Lower, Nether, High, Much, Steeple, King's, Bishop's, St, Hen, and the joining words
  by, in, le and en among them), and of the 10 suggestions they added on market towns matched with
  CAMPOP's places (1,048 market places with a CAMPOP place within 1.5 km; 956 suggested before, 961
  with them) five were the same place (Great Marlow, Chipping Ongar, Market Warsop, Weldon and Great
  Weldon) and five not (Old Windsor and Windsor, Sutton and Long Sutton 44 km apart, High Ongar and
  Ongar, two parishes 1.45 km apart, and West Horsley and Hornsey). Great and Little are a real
  difference as often as not (Great and Little Marlow are two places), so Great Marlow and Marlow are
  no longer found by the rule; the price is that recall, against the precision of a suggestion at
  0.88 the reviewer can trust. **A suggestion that only the rule took over the threshold is marked**
  in the work file (`rule: 'qualifier'`, `qualifier: 'Chipping'`, or a phrase as the name writes it,
  "next Ridley"), and the review says "qualifier rule: Chipping" beside its score; one its letters
  reached anyway (Abingdon-on-Thames) is not marked. A work file made before has no marks, and reads
  as it did. On the scale test (5,000 with 5,000, the synthetic names half beginning with a common
  word, Great, Upper and East among them) the comparisons are back to 137,742, from 168,440 with the
  sixty, and the planted pairs found the same (497 of 500). On the held-out pair at small size (the 92
  market places within the bounds of DEEP's Gloucestershire volumes, 25,404 places, at 293 MB) the
  rule added nothing: both name their towns in full (Chipping Campden, Chipping Sodbury, Upton on Severn).
  **Magna, Parva, Fawr and Bach were dropped** too (the maintainer's ruling of 1 October 2026,
  `krisis-qualifiers 2`): they mean or work like Great and Little, and often mark separate places
  (Aston Magna and Aston, Llanfair Fawr and Llanfair are no longer raised). Any of them may be
  re-admitted only if the held-out Index Villaris check measures it separately and it does well;
  Mawr and Fach would go back with Fawr and Bach.
  **Still to be measured**: the precision of the restricted list on a pair of gazetteers
  not used to choose it (`e2e/qualifier_precision.mjs`, below), and recall on the DEEP perturbed sets.
- **The lists of qualifiers** (`src/engine/krisis/qualifiers.js`, `QUALIFIER_LISTS`, version
  `QUALIFIER_TABLE_VERSION`, recorded with the ids of the lists used and their words in
  `match_parameters.qualifiers`). The tools have an international audience, and what is a qualifier
  is a fact of a language's place names, so the lists are data, one per language or group of
  languages, and the reviewer chooses them: a checkbox each in the page's options (with its
  language, "unmeasured" where it is, and a line saying what it holds), or `--qualifiers
  en-cy-la,fr` on the command line (`--qualifiers none` for none; an id that is not a list's is
  refused, by `qualifierIds()`, the rule both use). Seeded: `en-cy-la` (English, Welsh and Latin,
  **measured**, on by default); `fr` (French: "sur" and a river, "en" and a district at the end:
  Châtillon-sur-Seine, Châlons-en-Champagne; "en" only before one word that is not an article, so
  not Chapel-en-le-Frith) and `de` (German: "Bad" in front, "am" or "an der" and
  a river at the end: Bad Ems, Frankfurt am Main), each **unmeasured** and off unless chosen. Names
  are compared lowercased, so neither can tell a river from an ordinary word, and both read some
  ordinary phrases as qualifiers ("Haus am See" and "Haus" score 0.88 with `de` on); their
  `evidence` says so. A list
  is seeded only where the usage is well established and the risk low: Dutch "Nieuw-" (Nieuw-Vennep
  is not Vennep) and the like are left out, and other languages are left to contributors. Note that
  a trailing phrase often scores over the threshold on its letters alone (Châtillon-sur-Seine and
  Châtillon 0.895: Jaro-Winkler rewards the shared beginning), so for such names a list does not
  decide the suggestion (and never lowers the score); it decides it for short cores (Bar-sur-Aube and
  Bar 0.825 without it) and for words in front (Bad Ems and Ems 0).

  **To add a language's list**, add an entry to `QUALIFIER_LISTS`:
  `{ id, language: [BCP 47 tags], label, description, status: 'unmeasured', on: false, front: [],
  behind: [], phrases: [], same: {}, evidence }`. `front` and `behind` are words as people write them
  (they are matched normalised: lower case, no accents, punctuation as spaces, so "Saint-" is
  `saint`); each phrase is the source of a regular expression matched against the rest of the
  normalised name, whole, with three named groups: `core` (the rest of the name), `join` (the joining
  word or words, which weigh for the phrase: `an der`) and `tail` (at most three words after it;
  reuse the `TAIL` pattern); `same` maps a joining word to the spelling it counts as (`upon` to `on`).
  List only qualifiers that **rarely** mark a separate place: a word that as often names a different
  place (a direction, Old, New, Great, Little, and their equivalents) does more harm than good, since
  every pair it finds is suggested at 0.88. `evidence` says why each is there: the usage, with
  examples, and, for a list to be 'measured', a trial on real data (how many suggestions the list
  added, and how many of them were the same place, judged by hand, as `e2e/qualifier_precision.mjs`
  prints them). A new list starts `unmeasured` and `on: false`; it becomes measured, and on by
  default, only with that evidence and the maintainer's agreement. Change `QUALIFIER_TABLE_VERSION`
  whenever a list's words change, and `ALGORITHM` in `match.js` when the default lists do. Tests to
  add, in `test/krisis.test.js` beside "qualifiers per language": pairs the list finds when switched
  on and not when off (choose names whose letters alone stay under the threshold, or the test proves
  nothing), a pair each with its own qualifier not suggested beside each found for its core, a name
  that only looks like it has a qualifier left alone, and the list's line in the table test.
- **Blocking** (`blocking.js`, `match_parameters.blocking`). The rule until September 2026 (compare
  names sharing 30% of their padded trigrams) let every "Saint …", "San …", "Kafr …" or "Tell …" pass
  against each other, and a short name against every name with its first letter: a review measured
  11 s for 5,000 names with 5,000, and 20,000 with 20,000 did not finish in two minutes. Now the other dataset's names
  are indexed by trigram, and a trigram is **common** when more than 1% of those names have it, and more
  than 50 (so a small dataset has none). A name is looked up only by its trigrams that are not common,
  or, with fewer than four of those, by its four rarest; the lists of common trigrams are not read.
  **The keys are spread over the name** (`BLOCKING.spread`, new in `krisis-names 3`): one letter
  changed, added or dropped, or two swapped, breaks the trigrams beginning at no more than four places
  in a row, and the rarest trigrams of a name often all fall in its one unusual stretch ("great
  shunia" was looked up by uni, hun, nia and shu, and "Great Shnuia", 0.963, has none of them). So when
  the keys all begin within four places of each other, the rarest trigram beginning further off is
  added ("t s"), **unless more than ten times as many names as make a trigram common have it**
  (`BLOCKING.far`, new in `krisis-names 4`): in "San Xyz" or "Kafr Cal" the only trigram far enough off
  may be the common word's last ("an ", in every such name), and reading it compared every such name
  with all of them. Measured on 20,000 names "San" and three letters with 20,000 more: 44 s before the
  keys were spread, over ten minutes (not finished) with them, 40 to 53 s with the bound (16.6 million
  comparisons, 4% of the pairs: each name beginning "San x" shares 40% of the trigrams, and is
  compared). At five times, not ten, Granabad loses Grnaabad, whose far keys are in 6 to 7 times as
  many names. A name found so is compared when the two share at least 40% of the trigrams of the one
  with fewer, **or begin with the same three letters and share at least three trigrams** (new in
  `krisis-names 3`: Bruxelles and Brussels, 0.864, share 3 of 9, where 40% asks 4; Jaro-Winkler
  rewards a shared beginning; it costs up to about 2.5 times more comparisons on names that share a
  prefix: 20,000 names "Sai" and five letters with 20,000 more, 2.06 million before, 5.13 million
  with it), and when their lengths let them reach the threshold at all
  (`canReach()`: a name of two letters cannot reach 0.85 with one of more than four; names of the same
  number of words are let through, as abbreviations can raise them past what letters and lengths
  bound); a name exactly the same is always compared. **Qualifiers** (new in `krisis-names 6`): a
  subject Warsop finds Market Warsop through its keys as they are, since Market Warsop has every trigram
  of "warsop" but the padded first one ("  m", common, and a key only of a name of four trigrams, then
  one of four). The other way round it may not: Chipping Ongar's keys can all fall in "chipping" and
  "g o" when the trigrams of "ongar" are common (the suite builds that case), so a subject name with
  qualifiers is looked up by its core too; and names of which either has qualifiers are let through
  `canReach()` when their cores' lengths can reach the threshold over 0.88 (Ay and Ay-sur-Moselle,
  with the French list, which letters bound at 0.771). So a name is compared with at most 1% of the
  other dataset for each trigram it is looked up by. `e2e/match_scale.mjs [N]` matches two synthetic
  datasets of N places (half the names beginning with a common word, one in ten of the others a planted
  variant) with `plato-tools match` and requires it to finish in time and suggest 97% of the planted
  pairs: on its data, 20,000 with 20,000 took 50.6 s (about 11 million comparisons of names) before,
  and takes about 12 s (2.2 million) now: about a fifth longer than before the keys were spread and
  names beginning alike compared (1.5 million; measured in turn on one busy machine, 11.5 to 15.9 s
  against 9.6 to 13.3 s), suggesting 1,979 of the 2,000 planted pairs (1,978 before; 1,982 while any
  contraction counted, see short forms above). It then runs the same with a fifth of each dataset
  "San" or "Kafr" and three letters, and requires fewer comparisons than 1% of the pairs too: 2.3
  million, where without the bound on the far key it made 19.6 million. **Of the 18 not suggested
  before the short forms were a list, 17 score under the threshold and one is lost by blocking**: 8
  pairs whose distinctive word has two or three letters, one changed, after a common word (Nahr Nem
  and Nahr Nam, Fort Wu and Fort We: see words of three letters above), 6 whole names of two or three
  letters (Wum and Wem, Ra and Re), and 3 names of six letters with the second changed (Giveia and
  Geveia, 0.840); blocking loses Chapu and Chpau (0.947), which share only their first two padded
  trigrams, 2 of 6, where 40% asks 3. (Before, this file put the four planted pairs blocking lost down
  to the 40% share: all four were lost because every key fell in the one stretch that one mistake
  broke, so they were never read, and the rule before loses the same four at 30%. Now three are found
  through the key spread over the name, and Chapu is read but shares too little: at 30% it would be
  compared, 1,983 found, for 56% more comparisons.)
  The suite runs 4,000 with 4,000 and requires fewer comparisons than 1% of the pairs, where the rule
  before made more than 2%, and the same with a fifth "San" or "Kafr" and three letters (0.7%, where
  without the bound it was 5%).
- **Filters**, in order, after the threshold (0.85): a pair either dataset already links by an
  identity relation (nested, top-level, or bundled in an attestation not since withdrawn) is not
  suggested, and is counted; so is one either says are different places (a negated identity); a pair
  whose points (the first Point, else the centre of the first bounding box or shape, of attestations
  neither negated nor withdrawn) are further apart than the greatest distance (50 km) is dropped and
  counted; a pair without two points is kept, with no distance. Each subject place keeps its best
  five, and **when it has a point, the places within the greatest distance (by score, then distance)
  and those with no point (by score) take turns**, the group whose best scores higher first (the
  places with a point on a tie), and when one runs out the other fills the rest (new in
  `krisis-names 5`; a subject with no point keeps the best scores). Neither group can crowd the other
  out. Before `krisis-names 4`, namesakes with no point, at 1, crowded out a variant near by: in the
  DEEP trial Broomfield lost Bromfield, 4 km away, to five Broomfields with no coordinates.
  `krisis-names 4` put every near place first, which turned the fault round: an exact match with no
  point lost its place to five near places that only resembled it, and that is the common case, as
  95.7% of DEEP's places have no point (in the trial, 28% of the subjects with a point had five near
  candidates already). Measured on 23,448 perturbed copies of DEEP's located places, matched with
  DEEP (the true match located): 99.1% of the originals suggested by `krisis-names 4`, 98.4% now (the
  166 lost had ranked third to fifth among the near places, behind a better place with no point). On
  half of them, 11,682, with the true match's point removed from DEEP (the true match unlocated, the
  case that dominates real use): 82.8% before, 89.2% now. A dataset matched with itself suggests
  each pair once.
- **The work file** (`work.js`) is the tools' own, not PLATO: PLATO holds what people say, and a
  suggestion is software's. Its candidate fields are named after `plato:Candidate`'s
  (`candidate_source`, `candidate_candidate`, `similarity_score`, `candidate_status`, …), and a
  candidate describes the place it suggests itself (`other`), so that a suggestion from a gazetteer's
  reconciliation service fits the same record. It records each dataset's files by name, size and
  SHA-256 (streamed, `digest.js`), so a resumed or finished review can say when the files have
  changed. It records where each dataset's title came from (`titleFrom`: `gazetteer`, `given`, or
  `file-name` when the dataset gives none; a title the engine's reader makes up for a dataset without
  one, such as the file's name an LPF FeatureCollection with no title is given, counts as none), because the other dataset's title is the source every
  attestation of the review cites, and a published attestation is never changed: a title that is only
  a file's name is warned of at matching and again at finishing, and the page's option "the other
  dataset's title" (`--others-title` on the command line) gives the real one, kept in the work file, or
  given again when finishing. `readWork` refuses a file no review could have written: a decision that disagrees with its
  candidate's status, a candidate for a place it does not list, a denial without a basis, and what
  would only fail later, as a fault in the tools, when the attestations are made: a decision time that
  is not an ISO date-time, a place or a suggestion whose address is not an IRI, the same suggestion
  twice for one place, a candidate for a place listed only by inheritance (`constructor`: the file's
  objects are looked in with `Object.hasOwn`). The page checks the reviewer's ORCID by the same rule (`checkReviewer`) before
  it saves or finishes, so it never writes one a resumed review would refuse. The base address given
  for spreadsheet tables is kept in `match_parameters.base`; finishing tables with another warns
  (`base-differs`), as their places' addresses are made from it. A table of places (CSV, plain
  GeoJSON) to match is read by the matching of its columns chosen on the page, or given with
  `--columns` (Hermes), which is kept in `match_parameters.columns`; finishing reads the table by it
  again, unless another is given, which warns (`columns-differ`). The other dataset's columns are
  guessed.
- **Decisions.** "Same place" confirms a candidate; "Not this one" rejects it and writes nothing;
  "Different places" rejects it and writes a negated attestation bundling exactly one exactMatch,
  with the reviewer's basis. The matches accepted for one place are ONE attestation bundling a
  relation to each (`identity.js`, `recordIdentity`, whose signature is shared with Chora), so they
  share provenance and are withdrawn together; a consumer chains exactMatch only within one
  attestation. Each is dated by its last decision, cites the other dataset as its source
  (`authorityType: dataset`), names the reviewer as its contributor, and has no `@id` (the saver
  mints one). **Withdrawn:** the earlier statement here that an attestation has "no `promotedFrom`
  (the candidate is not published)", and Krisis's first decision that its output carries none, no
  longer hold since PLATO 05cf78a gave candidates a published form (the candidate set): once the
  suggestions are exported as one (below), each answer points at the candidate it answers. A review
  never exported still writes no `promotedFrom`, since there is nothing published to point at.
- **The candidate set** (`candidates.js`, `exportCandidates`; the candidate set specification,
  sections 5 and 13.5). The suggestions of a work file, published as a PLATO candidate set
  (`<subjects>.candidates.json`): `candidate_source`, `candidate_candidate`, `similarity_score` become
  `subject`, `object`, `similarityScore`; `algorithm_version`, `match_parameters` (as JCS text) and
  `generated_at` the candidate's own, else the work file's; `status` is always `suggested`, whatever
  was decided (the decisions become attestations). The distance, the other place's description, the
  decisions and the cursor stay in the work file, which the report says once. The header's
  `candidatesFor` is the subjects' gazetteer `@id` (refused in words when there is none), `issued` the
  day of export, and the title and description name the two datasets. The set's IRI comes first,
  since every candidate's is minted under it: `<base>candidates/<issued>-<first 8 hex of the SHA-256
  of the JCS array of the candidates' hash texts, sorted by code point>`, where the base defaults to
  the folder of the subjects' dataset address, and the whole IRI can be given instead. Each
  candidate's IRI is `<set IRI>#c-<hash>`, the hash SHA-256 of the JCS text of `[subject, object,
  algorithmVersion, matchParameters or ""]` (it gives PLATO's example ids, which the tests check),
  8 hex digits, lengthened by 4 until it differs from the hash of every other candidate in the set and
  in the earlier sets given (both of a colliding pair lengthen; against an earlier set, only the
  newcomer). A candidate whose four inputs are those of one an earlier set published is left out and
  counted ("N candidates were already published in an earlier candidate set and are left out of this
  one; answers to them point at their earlier IRIs"); when every candidate is, no set is written and
  the report says so. The score and the time are not hashed, so a rerun that scores an old pair again
  leaves it out all the same: the first score stands. Each export stores every candidate's IRI in the
  work file (`iri`: the new set's, or the earlier set's for one left out), overwriting what an earlier
  export stored, and records the set in `candidate_sets` (`{ @id, issued, previous }`, the latest
  last). A later export refuses, in words, when the earlier sets the latest export was made against
  are not given again (as Agora refuses without its previous release), and warns when the latest
  exported set itself is not given: if it was published, its candidates would be published twice.
  The command line has `plato-tools candidates WORKFILE [--base] [--set-iri] [--previous-candidates
  SET…] [--out]`, a command of its own rather than an option of `match`, because it runs on a work
  file alone, after the review, and reads no dataset; its `--base` is the set's, not the tables'. The
  page has "Export the suggestions as a candidate set" on the review screen (and "Earlier candidate
  sets…" to give those already published); it makes the set in the page, from the work object, which
  "Save the review" then saves with the addresses. The command line checks the set it writes against
  the vendored candidate-set schema before writing it; the page does not (the validators are in the
  worker, and the export is made in the page), so a set saved from the page is checked only when it
  is given to Finish or to `check`.
- **promotedFrom and candidateSets.** When finishing, each answered candidate's stored IRI must be
  under the set last exported from the review (`candidate_sets`) or under a candidate set given
  (`--candidates SET…`, or the page's exported and earlier sets); otherwise nothing is written
  (`candidate-not-under-set`), and so when a given set does not hold the candidate for the same
  places (`candidate-not-in-set`), is not a valid candidate set, or is for another dataset. Then
  `promotedFrom` is written on every identity relation of an accepting attestation and on the one
  exactMatch of a negated ("different places") attestation; "not this one" still writes nothing.
  Both outputs list in their gazetteer's `candidateSets` every set a written answer points into
  (merged with those the dataset lists already): the pipeline hands a caller each record, not the
  header, so `apply.js` adds them to the header text as it is written (`headerWithSets`), and the
  version check, reading the original as the earlier version, still finds only the new attestations
  added. The report says to publish each of those sets wherever the dataset is published
  (`publish-candidate-sets`). Not done yet: a decision changed after its answer was published should
  retract or supersede the earlier answer in the same run (the specification's section 13.5); apply
  does not yet read the dataset's earlier answers to do so.
- **The output**, by default, is the subject dataset with the new attestations appended to their
  places (`apply.js`, `writeDataset`). The dataset is converted to a PLATO JSON document by `run()`
  with `options.augment`, whatever format it came in (tables, LPF, RDF: the report says the output is
  PLATO JSON, and passes on what the conversion could not carry over). Its own schema problems are
  counted as one warning, not listed: the review adds to the dataset, it does not mend it. A place the
  decisions are about that no record of the dataset has is an error (`not-in-dataset`): its
  attestations would have nowhere to go. Then the version check (`compare()`) reads the original as the
  earlier version and the new file as the later: anything deleted or changed, or fewer attestations
  added than were made, is an error, a fault in the tools, and its counts are carried into the report
  ("the version check found nothing deleted or changed"). Any error means nothing is offered for saving
  (`incomplete`), and the command line removes the file. Before anything is converted, each new
  attestation is checked against the place-centric schema, under a place of its own (the profile has
  no schema for an attestation alone), as the attestations-only output checks its own. The file is `<name>.krisis-dataset.json`, so
  it never takes the work file's name. The tests prove the check can fail: an augment that drops an
  attestation of the original is caught as not append-only, one that adds nothing as not all added.
- **The other output** is a PLATO document of only the new attestations, in the attestation-centric
  profile, PLATO's profile for attesting about places that exist already: each attestation names its
  place in `about`, and nothing of the places is copied. Each attestation is checked against the schema
  before it is written, and the tests run the checker on the file.

## Chora, the map

What it does is in the guide:
[Placing on the map](https://pelagios.org/place-attestation-ontology/guide/tools.html#chora).
It is a page of its own, `chora.html`, a second entry in `vite.config.js`, so that MapLibre GL JS,
Terra Draw and Allmaps load only there. The page is `src/chora/` (`app.js`; `map.js`, the map, the
guard and drawing; `card.js`, what the place card writes, pure so that it is tested without a page;
`basemaps.js`; `overlays.js` and `remote.js`, the historical maps; `ink.js`,
`ink.worker.js` and `inkfetch.js`, tracing with assistance; `contributor.js`; `drafts.js`; `handoff.js`,
which passes files chosen on the main page through IndexedDB, taken out of it as soon as Chora's page
starts, not offered if older than two minutes, and let go by the main page too, when it starts, is shown
again or is left, once it is that old), and its engine `src/engine/chora/` (`store.js`, `view.js`,
`draw.js`, `save.js`, `geo.js`, `trace.js`, and `ink/`, the pixel work of tracing with assistance). It
publishes its state on `window.__chora` for tests.

**Chora's way back into a workflow** (`src/chora/handback.js`; Methodos, `docs/plans/methodos.md`,
section 5.3, stage 6). Opened as `chora.html#workflow=<id>`, where the id starts with a letter or a
digit and has only letters, digits, `-` and `_`, at most 64 in all (anything else is refused in
words, and never reaches the page or an address), a file saved, by the save dialogue or as a
download, is handed back: a record in the hand-off's store (`plato-tools-chora`, `kv`) under its own
key, `chora-handback`, of the hand-off's shape with the workflow and a format,
`{ handback: 1, workflow, files: [{ type: 'dataset', name, size, sha256 }], at }`. `files` holds a
reference, never the bytes: a Methodos hand-off, made by Methodos's own `refsOf`
(`src/engine/methodos/handoffs.js`) from the very File that went to disk, before a copy kept here is
let go; `refsOf` hashes it as a stream (Krisis's `fileRecords` and `fileSha256`), so that a saved
dataset of DEEP's size is never in memory whole, and while it does, the Save button waits and the
page says "Handing the file back to the workflow…". The name must be one the page can show as it
is (no path, no control or invisible characters such as zero-width spaces, bidirectional overrides
or a byte-order mark, not blank, not `.` or `..`). Then the save result offers **Back to the
workflow**, a link to `./#workflow=<id>`; a click writes the record again. It is good for thirty
minutes (`HANDBACK_FRESH`; the hand-off's `FRESH` stays two), tied to its workflow's id and deleted
once taken, and Chora drops a stale one when it starts.
Reading and deleting are one transaction (`take`, `dropStale`), so a record written meanwhile is
never the one deleted. Opened without `#workflow`, nothing is written.

The main page's side is built (`src/methodos/page.js`, the tracker's "Take the dataset back from Chora"; `src/app.js` passes the id and keeps it in `setHash`). On loading with `#workflow=<id>` it does this:

- find the workflow's record by that id, and show the step waiting ("Draw or trace the places on a
  map", operation `place`);
- carry `#workflow=<id>` through `setHash` in `src/app.js`, which rewrites the fragment to
  `#tool=<key>` (or nothing) on a toolbox click, and would otherwise lose the workflow;
- only on the user's click, `take(id)` the hand-back (read once, deleted, checked again by
  `check()`: another workflow's, another format's, a stale one, or any reference not exactly one
  `dataset` with a name the page can show, is refused);
- when `take(id)` returns null (none, stale, refused, or a browser that keeps nothing), fall back to
  asking the user to choose the saved file by hand, as the step does today;
- otherwise ask the user to choose the saved file, since the record names it and does not hold it,
  and complete the step with `runner.complete(state, 'place', { dataset: record.files })` only when
  `refsDiffer(record.files, [file])` is empty (checked in the browser by `handed_back`, in `methodos_join_checks`);
- drop a stale hand-back (`dropStale`) where it drops a stale hand-off.

`test/chora-handback.test.js` checks the record, its refusals and the hash, that the file is read as
a stream and never whole, that a give() beside take() or dropStale() is not lost, and that Methodos's
`isRef`, `checkHandoff` and `refsDiffer` take the reference and its step `place` is completed with
it. The browser checks (`handback_given`, `handback_control`, `handback_bad_id` in
`e2e/app_test.py`) save in a workflow and compare the record with the downloaded file's size and
SHA-256, see the busy line and the record rewritten by the click, follow the link; save without
`#workflow` as the control; and open an address whose workflow is markup, which is refused in words
and reaches nothing.

- **The worker** is the main page's, with commands of its own, sent one at a time: `chora-load`,
  `chora-search`, `chora-overview` (every place's point, at most 50,000), `chora-place` (one
  place's view, with its identities as Krisis reads the whole dataset) and `chora-save`.
- **The session database.** `chora-load` reads the dataset with `run()` and `options.sink`, so every
  format arrives as place-centric records, and writes each to `/chora.sqlite3` on the origin
  private file system, with the boxes and points of its current geometries and the names it is
  searched by, settled at the end of the file, where what is retracted or superseded is known. One
  dataset at a time.
- **The search box** finds a place by its label or any current name (toponym or romanized; not
  denied, retracted or superseded), by part of it, in dataset order, each place once. A name's
  `sourceLabel` (the name as the source prints it) is not searched. Both sides are folded
  (`fold` in `src/engine/chora/fold.js`): NFKD, marks dropped, lower case, so case, accents and
  compatibility forms aside (ﬁ fi, ſ s, µ μ); œ, æ, þ, ð and ß as oe, ae, th, th and ss; ς as σ;
  U+0000 and U+0001 dropped. What it gives is a fixed point of FTS5's trigram case fold, which is
  not JavaScript's (it takes ς to σ, ſ to s, µ to μ and the Greek symbol letters ϐ ϑ ϰ ϖ ϱ ϕ ϵ to
  their letters, and SQLite reads U+FFFE and U+FFFF as U+FFFD): tried over every code point, fold
  leaves none that FTS5 would fold further, so the index, the scan and the name shown agree. A place
  found by a name and not its label comes with `matched`, the first such name, which the list shows
  ("Byzantium — also Konstantinoupolis"). The names go to SQLite as they are read (`sx`, a row per
  name, written 64 rows to a statement; and `sxa`, a row per attestation with an `@id` giving the
  range of `sx` numbers its names took, kept only until the withdrawn names are taken out and then
  dropped, its pages used again by what is made after it); then one row per place holds its
  folded label and names joined (`sf`), apart from the records. A query of three letters or more is
  looked up in an FTS5 trigram index of `sf` (`sft`, which does not copy its text), as one phrase; a
  shorter one scans `sf` with `LIKE`. A page goes on from the last place of the one before (`after`,
  and the reply's `next`), not past an offset. The count is made once per query (folded) and kept;
  it costs what the hits cost, so the first page of a query that matches many places is the slow
  one. The page's queue to the worker (`queue.js`) sends only the latest of the new queries waiting,
  so a place chosen is not kept behind searches nobody will see; Next and Previous are each sent, the
  page they ask for worked out when they are sent (so Next clicked twice goes on two pages), for the
  query there when they were clicked: if the box holds another by the time they would be sent, they
  send nothing (`pageRequest`), since a page of the new query worked out from the pages of the old
  would be neither's. A reply is shown only if it is for the query its request was made for and that
  query is still in the box (`answers`). The list's state is `window.__chora.lastSearch`.
  - *Measured*, on synthetic places made by a script (three attestations each, two names and a
    romanized form in each, one attestation in fifty retracted), read into an in-memory database by
    sqlite-wasm under Node: at 50,000 places, dropping the attestation ids from `sx` took it from
    30.6 to 13.5 MB and the whole database from 91.1 to 73.9 MB. At 540,000 places (a database of
    800 MB: records 443 MB, `sx` 148, `sft` 126, `sf` 54): the first page of a query of three
    letters or more, count included, 14 to 31 ms for 5,600 to 89,000 hits; of one or two letters
    matching nearly every place, 96 to 147 ms; any later page about 2 ms. An independent review
    measured about 200 ms for the count of a common trigram at DEEP's scale, once per query.
    Earlier, on 540,000 synthetic places of about 1.9 KB each in a 1.6 GB database on disk (Node's
    SQLite, with the attestation ids still in `sx`): labels alone took 450 to 1,000 ms a search and a
    deep offset up to 900 ms.
  - *What names cost to load*, measured by timing `load()` over the same kind of synthetic file
    (20,000 places, 146,800 current names after the label and repeats within an attestation are
    left out; in-memory sqlite-wasm under Node, database size as `page_count` × `page_size`, the
    branch and `main` run alternately, two loads a run, on a shared machine): `main`, which
    searches labels only and has no `sf` or `sft`, loads it in 3.5 to 4.4 s to an 18.4 MB
    database; with the names and their trigram index, 5.6 to 6.3 s and 34.9 MB. So names cost
    about 2 s and 16.5 MB per 20,000 places here: about 100 µs and 0.8 KB a place, or 14 µs and
    110 bytes a name, of which `sx` is 6.4 MB, `sft` 5.9 MB and `sf` 2.4 MB. Writing `sxa` a row
    per attestation and not a row per name took the load from 6.4 to 6.7 s to 6.1 to 6.4 s, and
    writing `sx` 64 rows to a statement to 5.8 to 6.0 s; the database is the same size.
- **The place card** shows each attestation with its status (`view.js`). A relation that names its
  target only (`relatedLabel` with no `relatesTo`, PLATO #18: "in the Delta") is shown by its name,
  as text: it is looked up nowhere, links nowhere, and never places the place on the map; the
  store's list of related places (`p.rel`) holds addresses only. An attestation whose
  `timespanRole` is `EvidenceSpan` (PLATO #20) dates the texts that mention the place: its timeline
  entries are `evidence: true`, written "mentioned in texts dated …" and drawn hatched, with a
  legend only when there is one, and it is never a location's own date. `WhenTrue`, the default,
  and any role PLATO does not define are shown as the date of the claim. A location given only
  relative to other places (a `qualification` with `relativeQualifier` or `relativeTo`, one anchor
  or a list, #19, and no coordinates) is a line under Locations in words, with its distance and
  bearing when given. An anchor that is a place of the dataset is a link to it, any other its
  address's last segment, so the source's own words follow where it gives them: in PLATO's
  Trismegistos example neither anchor is a place of the dataset, so the card writes "between 2207
  and 1767, as written “between U01 Assuan (2207) and U01 Philai (1767)” (relative; not drawn)".
  It is never drawn and never places the place on the map. A location with coordinates and a qualification is drawn, as before; one
  with coordinates Chora cannot draw (a WKT polygon) and a qualification is not "only relative",
  and is left out as it was. A name
  is written with its language tag (else its script), its romanised form, and the system of
  transliteration where one is named (#21: "Sṯt (egy-Latn-t-egy-egyd) in Egyptological
  transliteration" for a Demotic name known only so; with a romanised form the system is that
  form's), and with what it denotes where that is not a toponym alone (#22: "Agrianes toponym,
  ethnonym" for the land of a people, "Agrian demonym" for its inhabitants). A `HomelandOf`
  relation (#22) is written as any relation is, by its type's name. The card's words are pure
  functions in `src/chora/card.js` (`nameItem`, `relationItem`, `locations`, `timeline`), tested
  without a page; `test/chora-view.test.js` and `test/chora-card.test.js` also run PLATO's own
  Trismegistos example (`schemas/examples/place-centric-trismegistos.json`, read from
  `PLATO_REPO`, so a missing checkout fails them) through the view and the card, with the expected
  words taken from the example.
- **The overview** reads a covering index of the places with a point (`pov`), not the records.
- **A pool and an outputs folder of its own.** A SQLite SAHPool holds every file in its folder open,
  so a second tab on the same pool cannot start. Chora's page asks the worker for its own
  (`init` with `pool: 'chora'`, `.opfs-sahpool-chora/`), and saves to `chora-outputs/`, since each
  page clears its outputs folder when it runs: the main page and Chora can be open at once, and
  neither loses the other's file. Two Chora tabs still share one pool, and the second cannot start:
  Chora's `init` takes the pool at once, and when the browser refuses a file another tab holds
  (`createSyncAccessHandle`, a `NoModificationAllowedError`) the worker's error says `kind:
  'pool-busy'`, and the page says Chora is open in another tab (`CHORA_TEXT` in `words.js`), not
  the browser's words.
- **Saving** writes the whole dataset as PLATO JSON Lines, `<input>.chora.jsonl`, if it was read
  from them, and otherwise as PLATO JSON, `<input>.chora.json` (`choraSavedFormat` in `words.js`,
  which the page's button and its note on the saved file follow too), each record as it was
  read with its drawings appended as new attestations: one `run()`, a conversion to that format
  whose `options.augment` puts each place's drawings after its own attestations. JSON Lines keep
  every line in its place, identity relations among the places included, and are the smaller file.
  The pipeline does not check what `augment` adds, so drawings are checked against the pinned JSON Schema, and
  against the places the dataset has, before anything is read or written. A drawing for a place whose
  `attestations` are not a list (the schema refuses it, and Chora still opens it) is refused, naming
  the place, since it could only replace them. Problems the writing finds are shown even when Mneme
  passes, as it compares attestations and nothing else.
- **Refused before the version check.** A run whose report says the file cannot hold what was read
  (`refusalOf` in `save.js`: the kinds Mneme calls not read, a line that could not be read, and, in the
  report of the writing only, what the writer itself left out: `attestation-centric`, an
  attestation-shaped line of a place-centric file, which the PLATO JSON (Lines) writer drops, and
  `identity-relations-lost`, held back by the PLATO JSON writer where its working database could not
  be had) stops the save before Mneme,
  which is ~90% of a save's time (14 minutes of DEEP's) and could only fail: the file written is
  removed (`discard`), nothing is offered, and the page says why (`chora-not-kept`). A dataset whose
  opening was incomplete (`readIncomplete`: cut short, or a reader that read on past part of its
  input it could not read, such as a sheet of the tables) is refused before anything is written, as
  not read to the end (`chora-unreadable`), with that reading's errors as why; this is tested before
  the opening's report, which then also holds `unreadable`. One whose opening read to the end and
  reported such a problem is refused before anything is written as `chora-not-kept`. A write that
  ends incomplete is removed in the same way, and the report begins with the refusal, then the run's
  own problems: `chora-not-kept` when the dataset was read to the end and the writer left its file
  short (`identity-relations-lost`), else `chora-unreadable`. Problems of the data itself (a place
  the schema refuses) do not stop a save.
- **A write that stops part-way** (a gzip cut short: `run()` catches the `DataError`) or ends knowingly
  short returns no outputs, and leaves the file it was writing. `run()` closes every output it opened
  and did not close (the browser cannot remove a file whose access handle is open); removing the file
  is `save()`'s job. It gives the run an `env.output` that keeps the name of each file opened, and,
  with no outputs to go by, removes the file by those names and the name expected (`discard`).
- **Known: a save cut off with its page** (the tab closed or crashed mid-save) leaves its partial
  file in `chora-outputs/` until the next save, which clears that folder first. Opening a dataset
  leaves the folder as it is (the last saved file is kept there, and its download cannot be seen to
  finish), and a partial file cannot be told there from a completed save without a record of which
  saves completed.
- **Progress** of a save is shown under its button, step by step: each event from `save()` says
  which (`save`: `finding`, `writing`, `checking`) and, where known, how many attestations that step
  reads (`total`), in words by `choraSaveProgress`.
- **Storage.** Before a dataset is opened and before it is saved, the page estimates what it needs
  (`src/engine/chora/storage.js`, from the full DEEP run: to open, about 1.3 times what is read, and
  about 2 times for RDF, which needs a triple store beside Chora's database; to save, the file and
  Mneme's ledger, about 2.3 times the records, and a triple store again for RDF), and warns plainly
  when `navigator.storage.estimate()` says too little is left. A triple store is counted wherever the
  pipeline uses one (its `needsStore`: RDF, attestation-centric PLATO, W3C annotations, TEI, and a
  CSV or plain GeoJSON whose column matching finds the places' web addresses), from the format
  detected, not the name. A CSV or GeoJSON is counted as read by address before it is opened (its
  columns are not matched then, so the estimate errs toward a warning), and as the opened dataset was
  read when it is saved (`loaded.input.profile`, from `genericProfile`). A file is gzipped when its first two bytes say so, whatever its name.
  A gzip of one member is read at the size its trailer gives (ISIZE, the size modulo 4 GB), unless
  that is less than 4 times the compressed size, when the larger of it and 20 times (DEEP's ratio) is
  taken; a gzip of several members (bgzip, known by its first header, or any whose last 64 KiB holds
  another member's header) has only its last member's size there, so the same fallback is taken.
  Chora does not ask the browser to keep its storage (`navigator.storage.persist()`), whatever the
  dataset's size: Firefox shows a permission prompt for it, and the tools add no consent prompts of
  their own. Persistent storage is to be offered in the toolbox's Permissions window. A unit test
  (`test/chora-scale.test.js`) finds no call of it in `src/`, and an e2e check records none while a
  dataset read at 210 MB opens, with its space warning given.
- **A place's key** is its `@id`, or `#n` (its position among the records) when it has none
  (`placeKey` in `store.js`). Loading and saving both count the records `run()` gives, in the same
  order and by one rule (`keyer`: every record counts, and one that is not a place has no key), so a
  place without an address is found by the same key in each. A place given twice under one `@id`
  gets its drawings at the first, which is the one Chora shows. A place of the tables has
  the address made from its `place_id`, encoded as PLATO says, the same when read to load and to
  save.
- **Mneme is the oracle.** The same run then compares the input with the file written (`verify()`
  in `save.js`): nothing lost or changed, whatever the dataset's status, nothing that identifies or
  describes a place changed or removed, and exactly as many attestations added as were drawn. A
  dataset with no attestations yet, a list of places to locate, leaves Mneme nothing to compare,
  which it reports as a problem: for a save that is the one problem allowed, and the counts must
  still show exactly the drawings added. On a save that passes, the page says whether the file is a
  conversion, and shows what the writing of it reported, which Mneme cannot see. The append-only rule is shown kept, by the check a publisher
  would run, not assumed.
- **Drafts** are kept in the origin private file system, `chora-drafts/`, one file per dataset,
  named by a hash of each input file's name, size and last change. A drawing made on a copy of the
  world (longitudes past 180) is moved back onto it whole (`wrapLongitudes` in `draw.js`), and one
  across the antimeridian is refused when it is finished, in words, as the save would refuse it.
  The file a save wrote is offered only while the drawings are those it holds. Saved through the save
  dialogue, which returns once the file is written, the drawings it holds are let go; saved as a
  download, which the page cannot see finish, they are kept until the user says the download is complete.
- **The basemap** is Natural Earth, served from this site from `public/basemap/`. Every address in
  its `style.json` begins `{base}/`, which the page replaces with the folder's address as text,
  since `URL()` would escape the braces of the glyph template. `node scripts/build-basemap.mjs`
  rebuilds it from pinned commits, refusing any download whose sha256 differs, and records inputs
  and outputs in `sources.json`; on the same pins it reproduces the committed files byte for byte.
  [public/basemap/README.md](public/basemap/README.md) has the rest.
- **The privacy guard.** MapLibre's `transformRequest` is the permissions module's (see
  [Permissions](#permissions)): it refuses any site but this one and those of the basemap shown whose
  permission is allowed, at every request, and Chora counts each refusal (`window.__chora.blocked`).
  Beneath it is the page's Content Security Policy, and MapLibre's worker is made from a `blob:`
  (`blobWorkerUrl`) so that its requests are under the policy too.
- **Other basemaps** (OpenFreeMap, OpenStreetMap, CARTO, or a pasted style or tile address) are
  used only once their permission is allowed: `basemap:<provider>` for a built-in one, whose sites
  are all in the module's `REGISTRY` (a style's sources, glyphs and sprites may be on sites other
  than its own: CARTO's are on `tiles.basemaps.cartocdn.com`, and its TileJSON's tiles on `tiles-a`
  to `-d`), and `basemap:<site>` for each site of a pasted one. Chosen before then, the basemap is
  remembered as the one wanted (`basemaps.wanted()`), the map stays as it is, and one "Needs
  permission" line opens the panel at it; allowed, it is used from the next load, and the page
  reloads with the files, the place and the view kept (`keepForReload` and `takeResume` in
  `handoff.js`). Withdrawn, the map goes back to Natural Earth at once; set to Never, the basemap is
  not offered. A pasted style is read by the page, through the module's `fetch`, once its own site
  is allowed; any further sites it names (`styleOrigins`) each get a line, and the map does not use
  it until they are allowed too. Sites named only by a TileJSON are not found this way, and are
  refused. The chosen basemap and pasted ones stay in `localStorage`. **A pasted basemap is never used
  without a click in this load** (`basemaps.automatic`, `current({ chosen })`, 1 October 2026): its
  address, its permission (`added`) and its being the one chosen are all in storage that any page of
  the site's origin can write, so at load, and when a permission changes (which may be another tab's
  doing), the map stays on Natural Earth, the site is asked nothing, and one line names it as the
  remembered choice with "Use it now"; the user's click (that button, its radio, or pasting) uses it,
  for this load. A provider of the `REGISTRY` (OpenFreeMap, OpenStreetMap, CARTO), whose sites are
  fixed in the code, loads as before. After the reload for a pasted site's permission the click is
  needed again, which is the cost of the rule. A basemap whose style cannot be loaded
  gives way to Natural Earth, and the page says why. A map error goes to the console with only the
  site of its addresses, since a key may be in the query or the path. A drawing's note names the
  basemap it was drawn on if it is a built-in one, and a pasted one only as such. CARTO's key is given at build time as `VITE_CARTO_API_KEY`, and without it CARTO
  is shown disabled. It is scoped by referrer to `https://pelagios.org`, so it never works on
  localhost and no test may need it. Vite writes it into the built page, where anyone can read it:
  the scope is its protection. Never commit it (`.gitignore` does not cover `.env` files). It is to
  reach the build from a GitHub Actions variable, which `pages.yml` does not yet pass.
- **The gazetteer lookup** (`src/engine/gazetteer/`), shared with Krisis, speaks the W3C
  reconciliation protocol, with the token in the `Authorization` header only. WHG has 16 slots for
  the whole site, so there is one request in flight whoever asks. `createLookup` gives one shared
  lookup per endpoint in a page or worker (`whgazetteer.org` with or without `www.`), and the first
  call's options stand: a later call's differing options are ignored with one `console.warn` each,
  but a later token replaces the token and `token: null` clears it (also `lookup.setToken(t)`,
  `lookup.clearToken()`). A tool reads the token from its one keeper (`permissions.token` in
  `src/lib/permissions.js`) and passes it, rather than keeping a copy of its own. On a page the
  lookup's `fetch` is `permissions.fetch` (cat `gazetteer`), and **every page caller of
  `createLookup` must pass it**: a later call whose `fetch` is another function than the shared
  lookup's (by identity; the platform's `fetch` if the first call gave none) throws a `TypeError`
  ("the WHG lookup on this page already uses another fetch; pass permissions.fetch") and changes
  nothing, rather than be given a lookup that sends past its permissions; a later call with no
  `fetch` uses the lookup's, and `shared: false` may have any. A `PermissionError` that fetch throws
  (told by `name === 'PermissionError'`, or by `retry === false` on any error a wrapper throws) is
  never tried again, except its kind `network` (fetch failing beneath the module: the service was
  not reached), which is no answer and keeps the retries unless it says `retry: false`. The job ends
  at once as a `GazetteerError` of kind `refused` whose `refusal` is the PermissionError's `kind`
  (`never`, `undecided`, `reload`, …) and whose message is its words, token cleaned: "The gazetteer
  was not asked: …", or for `moved` (the request WAS sent, and its answer, a redirect, not used)
  "The gazetteer's answer was not used: …". The lock and the queue are let go and the jobs behind it
  run. A request refused before it was sent is not counted against WHG's allowance: the pacer's
  charge for it is taken back from the ledger before the lock is let go; a `moved` one, which was
  sent, stays counted. What is held when: within a page or
  worker, the shared lookup's queue runs one request at a time, and a request's retries and the
  pauses between them finish before the next request in that page starts. Across tabs and workers,
  each TRY of a request is made holding the Web Lock `plato-tools:gazetteer:<site>`, which covers
  the pacer's read and write of its ledger (and any wait the pacer asks for), the request, and
  reading its answer; the lock is let go before the pause that precedes a retry (after a 429, a 5xx
  or no answer), so another tab or worker may make its request during that pause. What is
  guaranteed about WHG's 600 queries a minute: the pacer's ledger (times and counts per site only)
  is kept in IndexedDB and used only holding that lock, so where a platform has both (browsers,
  pages and workers alike) every tab and worker of an origin shares ONE allowance; in Node, which
  has no IndexedDB, and wherever there is none, the allowance is per lookup; other origins and
  programs are not counted. If IndexedDB cannot be read, refuses, or does not answer an open or a
  transaction within `ledgerTimeoutMs` (5 s), the lookup warns once and counts in that tab's memory
  from then on. A ledger entry dated after now (a clock stepped back) counts as sent now, so it
  never makes a wait longer than the window. Each try of a request is abandoned after `timeoutMs`
  (60 s) and counts as no answer, so a hung request cannot hold the lock for longer than that (plus
  the pacer's wait) per try. Tests use `shared: false` and
  `locks: null`, or a fake LockManager and a fake `ledger`. Every assumption about the World
  Historical Gazetteer, and whether it is verified, is in `whg.js`, so that a correction is made in
  one place.
- **Historical maps** (`src/chora/overlays.js`, `remote.js`): a IIIF image placed by a IIIF
  Georeference Annotation, drawn by `@allmaps/maplibre` (pinned exactly, with a test that the one
  `@allmaps/transform` installed is the version `src/engine/georef/` names; loaded only when a map is
  shown, in a chunk of its own). What is pasted (`parseInput`) is followed to a georeference
  (`resolve`). Every permission a step needs (`iiif:<site>` for a map's servers, `allmaps:allmaps`
  for Allmaps' annotation server) is named at once (`NeedPermission`), before anything is fetched,
  each in a "Needs permission" line under the paste box, so that one reload brings them all; a
  manifest is one step and its images the next. The map waiting, and what is typed in the box, are
  kept across that reload (`keepForReload`) and the map is added after it. A map pasted and maps kept
  (from the last visit, or withdrawn) can wait at once: what they wait on (`mapNeed`) is built by
  `withNeed` from the two parts, each replaced only by its own, so the maps kept, looked at again on
  every change of permission, never take the place of the map pasted; the reload hands over both
  (`reloadHandOver`: the map pasted, and, for the record only, whether maps kept waited: they are
  looked at again after every load whatever it says), and after it the maps kept are
  admitted again and then the map pasted is added. A permission set to Never
  is done without: the maps that need it are not shown, and nothing is said of them, but a map just
  pasted says it is set to Never. With no georeference, Allmaps is asked only from "Look for a
  georeference", which shows no notice: it needs `allmaps:allmaps`, and its line, like any other.
  The Allmaps Editor is always linked unless `allmaps:allmaps` is set to Never (Stephen, 2026-10-01):
  following the link is the user's own act, so it needs no permission, and its words say it sends
  the map's address ("Open in the Allmaps Editor ↗ (sends this map's address)"). A georeference of several maps
  (Allmaps' `/images/<id>` often holds several of one image) is a choice (`NeedChoice`): each with its
  label, date and number of control points, the most recently `modified` offered first.
  **Fetching** (`remote.js`): every document through `permissions.fetch`, which follows no redirect;
  the redirects measured (see [Permissions](#permissions)) are avoided before asking: http is asked
  over https, an image's information at `{id}/info.json` with no trailing slash, Allmaps at
  `/images/<id>` computed here (never `?url=`). Allmaps' own `?url=` address for an image
  (`annotations.allmaps.org/?url=<image id or info.json>`, which forwards) is read by `parseInput` as
  that image (`allmaps-image`) and asked at `/images/<id>`, as "Look for a georeference" asks, under
  `allmaps:allmaps`; its `?url=` of anything else (a manifest) is fetched as written, and refused as
  forwarding. An address that still forwards (an ARK resolver) is
  refused with "This address forwards to another one, which PLATO tools does not follow. Open it in a
  new tab, and paste the address it ends at.", and the address offered as a link to a new tab.
  **Admission** (`admit`): only where the page's policy was shown to be enforced
  (`permissions.enforced()`; otherwise maps are refused in words, since their tiles could go
  anywhere); the page fetches the image's `info.json` itself and refuses the map unless the id it
  gives IS the image the georeference names (the renderer builds tile addresses from that id); it
  then gives the renderer the information (`addImageInfos`, so the renderer asks for none) and the
  annotation, naming the image by the id the information gives exactly, over https (the renderer
  looks it up as written, so `…/grid/` against `…/grid` would have it fetch the information again
  itself), and sets the map's transformation from the georeference (`setMapTransformationType` with
  georef's `allmapsTransformationName`): the renderer takes the transformation's type but not a
  polynomial's order, and would draw an order-2 map at order 1. Maps shown are kept in OPFS
  (`chora-overlays/`, working data: cleared at the next load when the user keeps none) and admitted
  afresh on the next load; a change of basemap puts them back in a new layer without fetching
  anything. **What is shown survives a reload made at once**: ticking "Show" or moving the opacity
  (`keepShown`) writes the map's record from the copy `overlays.js` holds, in turn with every other
  write of that map (one queue per map, so a later write never lands under an earlier one and a map
  let go is not written back), and notes the new state at once, synchronously, in sessionStorage
  (`chora-overlays-shown`, this tab's only, let go once the record holding it is on disk). An OPFS
  file is written only when its writable closes, so a reload within those milliseconds (or, before
  the fix of 4 October 2026, while the folder was still being read first) brought a map back hidden;
  `kept()` reads the note over the record, and reads only a map's own file (`<24 hex>.json`, holding
  that key): while a write is open Chrome lists its swap file, `<key>.json.crswap`, in the folder
  too, holding the record being written (the old `kept()` read it as a second copy of the map). A
  note is read only if Show is a boolean and the opacity a number from 0 to 1 (another page of the
  origin can write it, below), and is otherwise let go; a record on disk whose state is not one is
  read as a map just added (shown, opaque). `window.__chora.overlayWrites` counts the writes not yet
  on disk (as `draftWrites` does for drawings), and a reload for a permission waits for them
  (`keptWritten`). The unit test (`test/chora-overlays-kept.test.js`) holds a fake OPFS's close to
  stand for the reload, with the note taken away as the control; the browser checks hold
  `FileSystemWritableFileStream.prototype.close` and reload at once, showing (back shown) and the
  other way (hidden: back hidden). **A permission withdrawn** takes its maps off the map at once
  (they stay kept, and come back once it is allowed again); tiles the renderer has already asked for
  cannot be called back. Each map's row names its image's site, with a "Permissions…" button that
  opens the panel there.
- **Why tiles cannot be guarded request by request** (the spike of 2026-09-30, @allmaps/maplibre
  1.0.0-beta.44, render beta.84): tiles are fetched in a pool of five workers, each made from a
  `blob:` (the renderer's own code, kept so by the build: the built chunk makes them with
  `createObjectURL`), so they are under the page's policy. A `fetchFn` cannot be passed to them (a
  function cannot be cloned: `DataCloneError`, logged only, and no tile loads), so the page sees no
  tile request. A map admitted for site A reached site B two ways: an `info.json` whose id is on B
  (the tiles are built from it: refused at admission), and a tile answered with a redirect to B,
  which the worker follows after admission. Only the policy stops the second (CSP Level 3 checks
  every hop); the browser checks run it against the built page. The renderer reports a tile its
  worker could not fetch only to the console (a `ResourceFetchError` naming the tile; no event), so
  the page listens there, for its own maps' tiles, and says in plain words that part of the map could
  not be loaded.
- **Attribution**: the manifest's credit and licence (Presentation 3 `requiredStatement` and
  `rights`, 2 `attribution` and `license`), as text only; the manifest's logo, thumbnail,
  rendering, homepage and seeAlso are never used. David Rumsey's manifests carry no licence, so it
  comes from a table by site (`HOSTS`). A non-commercial licence gets one neutral line, and the
  licence is linked in the traced attestation's citation of the map (`source.licence`).
- **Tracing** (`src/engine/chora/trace.js`): a drawing made over a map is traced from the topmost
  map shown whose mask holds it whole, else the topmost holding part of it (with a warning); a
  georeference that cannot place it (a fold) passes to the next. It keeps georef's `toPixels`
  record and its box of image pixels (at least 1 px each way), and must come back through the
  georeference to within 0.05 of the map's pixels there (georef's `metresPerPixel`), or it is not
  kept. A point traced is, until the user chooses otherwise, a `RepresentativePoint` whose
  `spatialPrecision` is `approximate`: a map's symbol stands for the place, and is not the feature
  (a `FeaturePoint` only where the map draws the feature itself); a traced drawing may also be a
  `LabelAnchor`. Saved, it cites the map (`georefCitation`, the canvas and the box as the locator,
  a point's box padded by 32 canvas pixels with georef's `pad`; `cito:citesAsEvidence`) and the
  georeference (`georefAnnotationCitation`, `cito:usesMethodIn`, derived from the map), and its
  notes are `georefNote`, with the date the georeference was fetched, then `choraTracingNote` appended, as
  Hermes writes them and as the template's contract requires (PLATO
  3acab8e's pattern; the tests compare with its example, read from the pinned PLATO). Moved or
  reshaped, it is traced again, or no longer cites the map and says so, and loses the traced
  point's defaults. The geometry saved is the one drawn.
- **Tracing with assistance** ("Trace area", "Trace line", "Snap to ink"; `src/chora/ink.js`, loaded only
  when first wanted, in a chunk of its own): a shape proposed from a historical map's own pixels, which the
  user accepts (Enter), edits like any drawing, or lets go (Esc). The design is `ink-tracing-design.md` with
  its amendments. The chunk is loaded by the first press of a trace tool, and a click on the map made before
  it has arrived waits for it (`app.js`, `traceWanted`): the first click of a user who presses "Trace line"
  and clicks the river at once is not lost on a slow connection (a browser check holds the chunk until the
  click has landed). The tool set once it has arrived is the one wanted then, so a tool pressed again, or a
  drawing tool chosen, before then leaves tracing off.
  - **Where the pixels come from.** The IIIF tiles of the map's image, asked for exactly as the renderer
    asks (`@allmaps/iiif-parser`'s `getTileImageRequest` and `getImageUrl`), fetched by the page through
    `inkfetch.js` and `remote.js`'s `fetchImage`, that is through `permissions.fetch` under the map's
    `iiif:<site>` permission (no credentials, no redirect followed, from the map's own image server only;
    two at a time; a 429 waited out as Retry-After says; a refusal said in words: 401 or 403, IIIF Auth
    being unsupported, CORS or no answer, a redirect, or the permission's own words), and decoded with
    `createImageBitmap` (no colour-space conversion, no premultiplied alpha). A level-0 server gives its
    `tiles`; a level-1 or 2 server without them gives the parser's default regions. The window is 512
    working pixels each way at the scale factor read (the smallest offered at least half the image pixels
    per screen pixel), grown when a line followed or a fill reaches its edge, to 2048, then once at one
    scale coarser, then "too large" in words. An edge tile is not at its scale factor: each tile is placed
    by its region and scaled by its region over its bitmap's size (`compose`).
  - **A permission withdrawn** (any change seen through `permissions.onChange` that leaves a site no longer
    allowed) lets go at once of everything read from that site for tracing: the page's cache of fetched
    tiles (which keeps a tile only while its site is allowed), the worker's tiles and the window it made
    ready (`{ type: 'forget', origin }`), and any proposal or snapping made from them. The map itself goes
    from the map as any map does.
  - **Who does what.** The page plans (`ink/job.js`: the scale, the window, its tiles, its growth) and
    carries the proposal into the world through the map's georeference (`toWorld`, no densifying); the
    worker (`ink.worker.js`, made from a `blob:` with the permissions module's `blobWorkerUrl`, so under
    the page's policy, and fetching nothing) does one window's pixel work (`ink/step.js`), and keeps the
    window made ready so that a slider re-proposes without reading it again. Jobs carry a generation id:
    a new click or Esc lets the older go.
  - **The engine** (`src/engine/chora/ink/`, pure, tested in Node on synthetic maps): the 3×3 median of
    CIELAB (an area) or of L* alone (a line), L* as Float32 and a*, b* as Int8, the RGBA let go once
    converted. An area: ΔE76 from the clicked colour, a scanline fill (gaps bridged by growing the
    boundary, filling, and growing the fill back), refused when it reaches the window's edge or covers
    more than 60% of it; outlined by d3-contour (ISC), each edge pixel placed within the pixels by its
    cover (1 − ΔE over the local contrast), holes smaller than (4 × the map's pen stroke)² left out. A
    line: Sauvola's adaptive threshold on L* (or ΔE, "match the colour"), the seed on the darkest pixel
    within 6 screen pixels, the component under it and those across gaps ahead taken in, each thinned in
    its own box (exact distance transform, Felzenszwalb–Huttenlocher; Zhang–Suen), the skeleton kept
    within a thickness band (0.5 to 2 widths; measured 2026-10-01 without it: no faster, a road four
    times as thick no longer cuts the line, though a line ending on a bar twice as wide then stops at it
    rather than running on along it, a limit left), read as a graph (junction pixels within 2 px one node, spurs pruned),
    followed both ways by the least turn (direction over 2 widths, stopping past 60°), gaps jumped up to
    3 widths ahead in a ±20° cone, never into a chain used; each point moved across the line to the
    ink's centre, the ends carried to where the ink stops. Douglas–Peucker in image pixels, corners kept,
    ε halved while the result crosses itself, down to 0.1. **Half pixels**: a contour's coordinates are
    pixel corners (IIIF's convention; no half pixel added); a skeleton's are pixel centres (+0.5).
  - **Accepted**, a proposal is an ordinary Terra Draw drawing (an area as its outline: Terra Draw takes
    no holes, and the page says they were left out), cited from the map it was traced from exactly as one
    traced by hand is, its round trip checked. With no place chosen, Enter keeps the proposal and says to
    choose one. The draft keeps what was proposed and how (`trace.assisted`); its notes are
    georefNote's fixed template first and then `choraAssistedNote` (`words.js`, the one place they are
    made), appended after it: how it was proposed (ε in image pixels, the gaps bridged, the holes left
    out) and "accepted as proposed" or "edited by hand: moved k, added a, removed d, of n proposed",
    counted against the proposal (`ink/edits.js`). Attested, not computed: a person accepted it. Moved
    off its map, it keeps saying it was proposed from that map's ink, and that the citation was dropped
    (`uncitedParts`).
  - **Offered** once a map shown has drawn a tile (`maptileloaded`: the renderer's `firstmaptileloaded`
    comes only when the first tile it asked for loads, and never when that one is refused). Until then
    the buttons are `aria-disabled` (not `disabled`, so that they can be focused) and their tooltip says
    why. A server that lets no other site read it is refused at admission (the image information).
  - **Snap to ink**: Terra Draw asks for a snapped position on every move, synchronously, so on each
    `moveend` the worker finds the ink's ridges (a line's centre) and edges over the view, the page
    carries them into the world through the georeference as one MultiPoint, and bins them by screen
    pixel; a vertex within 10 screen pixels goes to the nearest ridge, else edge. Alt held: no snapping.
- **Georeferencing** comes from `src/engine/georef/`, which belongs to Hermes; Chora keeps none of
  its own.

### Adopting a gazetteer location

"Find in a gazetteer…" on the place card (`src/chora/adopt-ui.js`; the engine, pure, is
`src/engine/chora/adopt.js`) looks the place up in the World Historical Gazetteer and adopts a record's
location as one act that records two claims: an identity (this place IS the record) and a geometry
(it is located where the record says).

- **Only places with an `@id`.** An identity needs the place's address, so the button is disabled, with
  the reason beside it, for a place Chora keys as `#<n>`.
- **Asking WHG** goes through the shared lookup (`createLookup`, one queue per page) with Krisis's
  `permittedFetch`, under the same permission (`gazetteer:whg`) and the same token keeper
  (`permissions.token`) as Krisis on the main page. Until it is allowed, the module's one "Needs
  permission" line stands in for Look up; there is no notice or consent of Chora's own. One query, the
  name typed, always with `type: 'Place'` and `limit: 10`; no filters (WHG's filters remove candidates, never rank them).
- **Ranking, honestly** (`referenceOf`, `rankCandidates`): by distance only when the place has its own
  current geometry; inside or outside the box of its related places or countries otherwise; with neither,
  the gazetteer's order, said as such. Candidates without coordinates come last and say so. WHG's score is
  relative and its confidence the name's, so nothing is preselected. The numbers in the list are the
  numbers of the markers (HTML markers, which need no glyphs from the basemap's style).
- **What the dataset already says** comes from Krisis's `createIdentityCollector`, run over the whole
  dataset as Chora's store reads it (`identitiesOf`, given with each place's view): `linkState(entry,
  candidate, { exact: true }) === 'linked'` is "already linked" (the geometry only is recorded), and
  `linkState(entry, candidate) === 'denied'` is "ruled out" (struck through, nothing to adopt; "Different
  places?" links to Krisis). A link wins over a denial. Decisions in Krisis not yet saved are not seen.
  Amendment 6 is met only in part: a link to a legacy WHG cluster page (`whgazetteer.org/places/<n>/portal/`)
  is NOT counted as a link to any record, since a cluster cannot be told apart into records; the panel
  says "This place is linked to a WHG cluster page; whether it holds this record is not known"
  (`clusterLinks`). A place whose `@id` is the record's own w3id is that record already: the location
  only is recorded, with a note saying so (an identity with itself is no claim).
- **The record** is fetched with `entity()` (LPF; the token only for WHG's own records). A
  GeometryCollection's members are offered one by one; a geometry's `when` is carried into the
  attestation's timespans, or the geometry is refused with the reason. A line's role is Itinerary by
  default, or Extent (`rolesFor`). If the record cannot be fetched for a passing reason only (no answer,
  too many requests, or a 5xx: `fallbackAllowed`), WHG's representative point is offered, labelled as only
  that; never after a 403 or 404, and never for a WHG record whose licence cannot be known (an id with no
  dataset).
- **Never copied:** a 451, or a source whose `redistributable` is `false` (Krisis's `upstreamLicence`,
  tested directly, not through `licenceWarns`). Its marker is hidden, the record is said to be consulted,
  not copied, and "Draw it yourself" makes the next drawing of the place cite it (`consultedParts`:
  `citesForInformation`, since the user saw the record's name and description but never its location;
  the record as locator, no licence). Cancel beside it, closing the panel, or choosing
  another place disarms it.
- **The attestations** (`adoptionAttestations`) share `created` and the contributor and have no `@id`.
  Both cite `gazetteerSource(WHG_SERVICE)`; the geometry with `cito:citesAsEvidence`, the record's w3id as
  the locator, and the upstream source's licence as `https://spdx.org/licenses/<id>` (never WHG's own,
  which the notes give beside it). So the same source `@id` (`https://whgazetteer.org/`) carries different
  `licence` values across a dataset, one per upstream source copied from, and the notes give both the
  upstream licence and WHG's own. The record's address is in both notes, verbatim, to pair them; a WHG
  record of its own is named with its dataset's name and id too. A licence that warns gets one neutral
  line, never a block.
- **The draft** is one draft kind in `chora-drafts/` (`kind: 'adoption'`, `adoptionDraft`): the one
  geometry chosen, the candidate's address, name and point, the attribution entry used, the place's
  identities, the time of adopting; no lookup and no token. Removing it removes both claims. Saving makes
  the attestations then (`draftAttestations`, with the contributor asked for as for drawings), so Mneme
  counts 2 added for an adoption, 1 for a place already linked.
- **Errors** (`lookupProblem`): a quota 401 keeps the token and says try tomorrow; a refused token offers to
  give it again or forget it; a per-query error or `gateway.answered: false` is "try again", never "nothing
  found".

## Gazetteer lookup

Krisis can also look the subject places up in a gazetteer, through its W3C reconciliation service (the
World Historical Gazetteer by default, or any other by its address), and add what it answers to the
same work file as a local match, for the same review. `src/engine/krisis/lookup.js` holds it; the
talking to the service is the shared gazetteer module's (`src/engine/gazetteer/`, owned by the Chora
work, used here and never changed). The command line is `plato-tools lookup` (with `--dry-run` to see
what would be sent); on the page it is the panel "Look up in a gazetteer (online, optional)" beside
matching (below). This sends each place's name to the gazetteer, and its coordinates only with `--near`.
To WHG it also sends each name's language (whg.js A13): the name's own tag, mapped to its primary subtag
(two letters where the language has them: `eng` as `en`), else the dataset's language (`--lang`, or the
panel's language field, either refused when it is not a code), else none, never `und`. A name tagged
`und` or `mis` is taken as untagged; one tagged `mul` or `zxx` is sent with none; collective codes and
grandfathered tags name no language. A language is not a filter, so it never makes a batch suspect. The region review's levels ask for areas only
(`area_only`, A12), so that a region is never matched to a point, which could not scope the lookup of
the places within it; the places themselves never send it.

- **The token** is never seen by the engine: it is given a lookup made with it (`createLookup`), and
  nothing writes a token into the work file, a report or an error. The command line reads WHG's from
  `WHG_TOKEN` only, refuses `--token`, sends another service a token only from the variable
  `--token-env` names and only over https, and never sends WHG's elsewhere. A query the service refuses
  inside a good answer comes back with the service's words, which the module cleans of the token (and
  of the ones it replaced), and Krisis keeps them as they come (`queries[…].error`). The tests look for
  the token in everything written, beside a control that the service received it and that the query's
  words are kept, cleaned (that check found an unscrubbed per-query error before the module cleaned it).
- **One request in flight.** Krisis relies on the gazetteer module for it and keeps no queue of its
  own: `createLookup` gives one shared lookup per endpoint in a page or worker, so Krisis's and
  Chora's lookups in one page share its queue and one request is in flight whoever asks, and across
  tabs each request is made holding the module's Web Lock for the site. `runLookup` takes the lookup
  it is given and uses nothing of it but `reconcile` and `batchSize` (the first caller's, which the
  plan follows), so it works the same with the shared one; a later `createLookup` with a token
  changes the shared lookup's token, and its other options are the first call's (the command line
  makes one lookup a run, so its `--batch` and `--gazetteer-iri` stand). The tests make private
  lookups (`shared: false`, `locks: null`, as Node 24 has `navigator.locks`, and a `memoryLedger()`
  of their own): shared, each test was answered by the first test's fake.
- **What is sent.** Each place's label, and only its label, unless `allNames` (`--all-names`) sends its
  other names too, one query each. WHG's queries always carry its type, `Place`, in the form the
  module sends it (its `WHG_PLACE_TYPE`, which Krisis re-exports; the module refuses any type but Place
  or Period before a request), so that the preview is what WHG receives (confirmed from WHG's code: an
  unknown type, or two in one request, is refused, and a query without one is unsafe); another service's the first of
  its manifest's `defaultTypes`. The page and the command line read another service's manifest
  through the lookup (`manifestSettings`, the module's `manifest()`, which never sends a token) before
  its first query: its type, and its `view.url` as the template for its candidates' addresses unless
  one is given (`--gazetteer-iri`, or the panel's field). A manifest that cannot be read is said, and
  the lookup goes on without them. A dry run sends nothing, so its preview shows no type for another
  service; on the page, the preview shows it once a lookup has read the manifest. Query properties FILTER, never boost,
  and a wrong value silently removes the right answer (WHG's country codes are patchy), so none is sent
  unless asked for: `countries` (the place's own codes as a JSON list of ISO 3166-1 alpha-2 codes, in
  capitals, as the module's owner confirmed; a code not of two letters is not sent) and
  `nearKm` (`lat`, `lng` and `radius` in kilometres, which WHG resolves as a disc of H3 cells, so the
  edge is approximate, and answers from its upstream gateway only; confirmed). An answer whose
  `scope.applied` is not true is counted and warned of (the filter was not applied). A place's
  queries are never split across batches (`planQueries` chunks), so each place is answered at once. The
  preview gives the places, queries and requests, and the first 20 queries exactly as the service
  receives them (a test compares them with what the fake service received). `planLookup` makes the
  plan from the lookup itself, in requests of its own `batchSize`, and both `runLookup` and the page's
  preview use it, so the count of requests shown is the count sent. A place with no name (no label,
  and no name but its own address, which `gather()` gives a place without a label as its label) is not
  looked up, and is counted (`withoutName`) in the preview and the summary: its address is never sent as
  a query.
- **Ranking, never accepting.** WHG's score is relative to the best in its own answer (the top is about
  100 however bad) and its confidence measures the name only, so neither decides anything. Candidates
  are ranked by distance, then whether the countries agree (yes, unknown, no), then Krisis's own name
  similarity (`names.js`, which is every candidate's `similarity_score`), then the service's order.
  A candidate further than `maxDistanceKm` (50) is kept and marked `far`, never dropped (the test has
  three Newcastles, all 100: GB first, Namibia and Australia marked far). WHG's own figures are kept
  apart under `gazetteer: { service, id, score, confidence, match, answer_rank, description, namespace,
  query }`. `candidatesOf` lists a lookup's candidates in this order, after the local ones.
- **Not suggested, and counted:** a candidate without an address (`iri` null: a WHG id that is not
  `place:…`, or another service's id with no `--gazetteer-iri` template), one the dataset already links
  to the place or says is a different place, one the review has already decided, and one already a
  candidate. What the dataset says is read by `identities.js` (`currentIdentities`, shared with Chora):
  identities from every attestation and the record's own, negated ones as denials, withdrawn ones
  dropped (`resolveWithdrawn`), WHG addresses in their w3id form and legacy `/places/<n>/portal/`
  addresses kept as found. For this comparison only, a WHG candidate also goes by its authority's
  address (`authorityIris`: `place:gn:2641673` is `https://sws.geonames.org/2641673/`, and likewise
  Getty TGN, Wikidata, OpenStreetMap); the address a candidate is suggested and attested by is always
  WHG's w3id.
- **Which places.** `unmatched` (the default after a match: those without a local candidate), `all`,
  `pending` (the default once a lookup has run: those a lookup of this service left unanswered,
  stopped or pending; a place never looked up is not pending) and `unlinked` (not linked to the
  service, legacy WHG addresses included, and with no confirmed candidate of it). Looking a place up
  again (a batch, "Look it up again", "Try its other names") replaces its undecided candidates from that
  service and keeps the decided ones. A name typed for one place ("Find this place in WHG…",
  `options.query` with one place in `only`) adds what it finds beside the place's candidates, replacing
  none, and an address already among them is not added twice (it is counted as already suggested): a
  typed name is a further search, not a fresh one. Services are compared by address, and WHG is
  recorded by one (`canonicalEndpoint`: `www.` and a trailing slash are the same WHG), both when a
  lookup is made (`serviceOf`) and when a work file is read.
- **Answers that are not findings.** `.unanswered` (the gateway did not answer, or the query was
  refused) makes the place `unanswered`, to be tried again, never "no match"; a place answered with no
  candidates is labelled with what was sent ("label only"). A first batch of several queries that all
  come back empty, while a filter or another service's type (from its manifest) is sent, is suspect (a
  filter or type the service did not take): its places are marked unanswered and `suspect`, and the
  lookup stops (`suspect`). WHG without a filter is never suspect: all it is sent is then fixed (the
  label, the module's own type, which WHG takes, and the limit), so there is nothing the reviewer could
  check, and a stop would only cost a request. Sending the same places again asked the same way
  (Resume; the same names, limit, filters and type) is the reviewer's word that the empty answers are
  genuine: they are accepted, and the lookup goes on. Without that, a suspect batch could never be
  passed (Resume took the same places in the same order, and stopped again each time). A refused token, a spent allowance, too many queries, no
  answer or a failure stop the lookup, keep what was answered, and mark the rest `stopped`, as does the
  signal (Stop); a fault in the tools does the same and is thrown on. The work file can then be saved
  and the lookup resumed.
- **Attestations: one per source.** A place with matches accepted from the other dataset and from WHG
  makes two attestations, same reviewer and date, each citing its own source; the local = WHG link is
  not stated. WHG is cited as `{ title: 'World Historical Gazetteer', '@id': 'https://whgazetteer.org/',
  authorityType: 'dataset' }` (`gazetteerSource`); a judgement on a looked-up candidate cites its
  gazetteer whatever `source` `attestationsFrom` is given, which stands for the other dataset only.
  **No licence is written into an attestation.** The service's `attribution` is kept in the work file as
  it came, nulls left null (`lookups[].attribution`), and `licenceOf(attribution, namespace, dataset)`
  reads a candidate's (its source's; for WHG's own records its dataset's, then WHG's), or null: "licence
  unknown". It gives `redistributable` as well: false only when the entry says `redistributable: false`
  ("not to be passed on"), and missing or null is not known, never true, like `permits_commercial` and
  `no_derivatives` ("terms partly unknown"). No licence value is written in the code.
  `upstreamLicence` is the same without WHG's own licence (its source's, or its contributed dataset's, else null), for data copied from a candidate, such as its geometry; `identities.js` keeps exactMatch links apart (`exact`), and `linkState(…, { exact: true })` counts only those.
- **The work file, version 2** (`work.js`): `others` may be null; `places` may hold places without
  candidates; `lookups: [{ id, service, started_at, finished_at, algorithm_version, parameters,
  attribution, counts, stopped, queries: { <place>: { state, sent, found, added, refused?, error?,
  suspect?, scopeNotApplied? } } }]`; a looked-up candidate has `lookup` and `gazetteer`. `readWork` reads
  version 1 and gives it back as version 2, so **saving a version 1 file writes version 2**, which
  earlier tools cannot read. `match()` writes version 2 with `lookups: []`.
- **On the page** (`src/app.js`, Krisis's lookup block), the lookup runs on the page's own thread,
  never in the worker, so that the token never crosses to it; the worker only reads the dataset's places
  and the links it states (`cmd: 'places'`, `gather()`, a table of places read by the columns chosen).
  **Every request goes through the permissions module** (see [Permissions](#permissions)): the lookups
  are made with `permittedFetch(permissions.fetch, onRefused)` (lookup.js), which asks
  `permissions.fetch(url, { cat: 'gazetteer', subj, …init })`, `subj` being `gazetteerPermission(url)`:
  `'whg'` for WHG, else the service's site. Send (and, on the review screen, Find, Look it up again and
  Try its other names) is offered only while `permissions.allowed('gazetteer', subj)`; otherwise the
  module's one line (`permissions.needs(el, …)`, whose button opens the panel at that permission) is
  shown in its place, nothing is sent, and the preview of what would be sent is still shown (it is
  information, not consent). There is no inline privacy note: what a gazetteer learns, and where the
  token is kept, are said in the panel. A request the module refuses (`PermissionError`) stops the
  lookup: `onRefused` aborts it with the error, and runLookup records `stopped: { kind: 'permission',
  refused: <the error's kind> }`, worded by `LOOKUP_WORDS.refused` (address, never, undecided, reload,
  unprotected, moved, network); `network` is left to the gazetteer module's retries, as any failure to
  reach the service is, and stops as its `network`. The token has one keeper, `permissions.token`
  (`get`, `set`, `forget`, `onChange`, `remember(on)`, `remembered()`): kept for the tab unless the user
  chooses, in the Permissions panel, to remember it in this browser, where the panel states its scope.
  The page keeps no
  copy: the field is emptied once the token is given, and the keeper's token is handed to the shared
  WHG lookup at start and on every change (`setToken`, through the keeper's `onChange`); Forget calls
  the lookup's `clearToken()` and the keeper's `forget()`, and no `createLookup` call carries a token. No
  token is sent to another service. What the service says (a stop's message, a query's `error`) is
  cleaned of the token by the module, and Krisis keeps it as it comes; only a fault's stack, which is
  not the module's, is cleaned on the page before the console. The panel previews places, queries, requests, the share of WHG's
  5,000 requests a day, and the first 20 queries exactly as sent (the e2e compares them with what the
  fake WHG received); filters are off by default and say they hide the right answer too. Answers are
  merged into the review's work object after each batch, so "Save the review" works at any moment; a
  stop (refused token, spent allowance, too many queries, no answer, failure, or Stop) keeps what was
  answered and offers Resume (the places the stop left, and those not answered). On the review screen,
  candidates are grouped by where they came from, in the order ranked (`candidatesOf`); a looked-up
  one shows WHG's own figures labelled as WHG's, a far mark rather than being hidden, and its source's
  licence (a warning when not for commercial use or not to be passed on, and "licence unknown" never
  shown as fine). Each place has "Find this place in WHG…" (one query, the name editable), "Look it up
  again" when it was not answered, and "Not found? Try its other names" when it was answered with
  nothing under its label; after one place's lookup the focus goes to its first new candidate. The
  keys do nothing in the panel or the find form. While a lookup runs, Check, Convert, Compare, Match,
  Resume and Finish are disabled, as while the worker runs (each would take the review off the screen
  under the lookup); the review stays usable, and each batch's redrawing keeps what was being typed in
  the find form or the basis field, and its focus. After a refused token the panel is opened, and the
  focus put in the token field. Above Finish, the page says what each attestation
  will cite. The e2e (`krisis_lookup_case`) answers for WHG with `page.route`, never the real service,
  and looks for the token in window.__plato, the page, the console, request addresses and bodies, and
  the saved work file, beside the control that it is in every request's Authorization header.

## Workflows (Methodos)

Methodos runs a workflow, a named sequence of the tools' own operations, from a recipe
(`docs/plans/methodos.md`). It is a coordinator over the engine, not a second engine: plain ES modules
in `src/engine/methodos/`, with no page, no storage and no framework, so that the same code runs in
Node (the tests) and in the worker. Phases 0, 1 and 3 are built: the engine, its adapters, and the
page's interview and tracker (below); keeping a workflow beyond the tab is phase 2.

- **Operations** (`operations.js`) describe the calls the tools already make: each says whether it is
  automatic or interactive (done by the user, so the step waits), what types it takes and gives,
  which permissions it needs, and whether a cancelled run keeps what it had done (a review and a
  lookup do; a conversion or a part of publishing is all or nothing, and the runner names what such
  a step had written for the host to remove: stopping the engine's call and removing its files are
  the host's, as the page does now). An operation that does not
  exist yet (regions level by level, the containment relation, adopting a match's geometry, finding
  places in a text) is declared with the reason it is not available, and a
  workflow whose answers would reach it is refused at the start, in those words.
  Chora's hand-back is no operation of its own: it is how the interactive step `place` gets its
  result (below, "Chora's way back into a workflow").
- **Recipes** (`recipes/`) are data: "Map your data" and "Publish a dataset". A step names an
  operation, where each input comes from (a file chosen at the start, `$files`, or an earlier step's
  output, `mint.dataset`, with `??` for "this, or that if it was skipped"), its options (literal or
  from an answer) and the yes-or-no question under which it runs. `recipe.js` checks a recipe
  (every input made before it is used, of a type the operation takes, and never only by a step that
  may be skipped) and gives its digest: the SHA-256 of the whole recipe, its words included, which a
  workflow records.
- **Hand-offs** (`handoffs.js`) are references, never content: `{ type, name, size, sha256 }`, made by
  Krisis's `fileRecords`, with a type from a closed list (`files`, `dataset`, `mapping`,
  `work.krisis`, `work.hermes-text`, `deposit`, `site`, `w3id`). A hand-off of the wrong type is
  refused in words; a file that is not the one a reference names is refused by Krisis's `filesDiffer`.
- **The runner** (`runner.js`) is pure: a workflow's state is JSON, and `start`, `next`, `complete`,
  `waiting`, `resume`, `stop`, `fail`, `cancel`, `progress` and `invalidate` each return a new state
  or throw, in words, where they do not apply. It keeps the three ways of stopping apart: waiting
  for the user (`waiting`, with what for), a data problem (`stopped`, with what to put right and the
  step to run again) and an execution failure (`failed`, kept so that it can be tried again).
  `invalidate` does a step again and resets every step that took its outputs.
- **The adapters** (`adapters.js`) are one per automatic operation that has landed (check, convert,
  compare, the four parts of publishing, match, apply, lookup), each calling the engine as the worker
  does. The front end gives a host: `open(ref)` for the file a reference names, `env()` for one run's
  environment, `file(output)` for what the run wrote, and, for the lookup, a lookup made on the page
  thread through the permissions module. `drive()` runs the automatic steps until the workflow waits,
  stops, fails or completes. A run whose report counts errors stops the workflow but keeps what it
  wrote, as the page and the command line do; one that did not finish leaves nothing. A permission
  still to decide, set to Never, or needing a reload is waiting; any other refusal is a failure.

`test/methodos.test.js` drives "Publish a dataset" through the real engine on PLATO's Antonine example
and checks that every output the record names is the file the engine wrote, by size and SHA-256.

**Saving and resuming** (phase 2). A workflow's record (`record.js`) is the runner's state with an id,
a name and its times: references to files by name, size and SHA-256, never the files, and nothing in
OPFS. `src/methodos/store.js` keeps it as its `.workflow.json` text in IndexedDB (`plato-tools-methodos`,
store `workflows`), saved at every step boundary (`drive()`'s `atBoundary`); with "keep working data"
off it is kept in sessionStorage for the tab alone, and what IndexedDB held is let go. On resume,
`reconcile()` applies the version rule: the same digest continues; a recipe whose words alone changed
(same version, the same steps with the same operations, inputs and options) continues and says so;
anything else stays at its last finished step and offers `restartRemaining()` (the finished steps the
new recipe begins with are kept) or to leave it. `checkChosen()` refuses files that are not the ones
the record names, through `filesDiffer`. A lookup the gazetteer stopped part-way (its quota spent, or a refusal; not a
permission, which waits) fails keeping the answers received as its declared partial result, a work
file; done again, it begins from that file and asks only for the places not yet answered. `exportRecord()` and `importRecord()` write and read the
downloadable `.workflow.json`. Tested in `test/methodos-record.test.js`, and in the browser by
`e2e/app_test.py` through a test hook (`e2e/methodos-hook.js`) the harness bundles and serves itself,
until the page has a Methodos panel (phase 3).

**On the page** (phase 3): two self-contained components, mounted by `mountMethodos()` in
`src/methodos/page.js` on elements the host gives it, so that where they sit can change without
changing them.

- **The interview** (`section#methodos`, opened by the one-line banner above step 1, the Methodos
  card, or an address ending `#methodos`) asks three questions as radio groups, each a `fieldset`
  with its question as `legend`. The words and the routing are engine code,
  `src/engine/methodos/interview.js`: `choose(have, want)` gives a recipe and the yes-or-no questions
  still to ask, `{ kind: 'grid' }` for "not sure" (a button to the plain grid of cards), or
  `{ kind: 'none', why, tools }` (no composition: it says which tools do the work meanwhile);
  `plan(key, answers)` gives the steps the tracker shows, each with its tool, its act, and, where its
  operation is declared unavailable, the reason. Such a step does not stop the workflow: it is shown
  greyed as "Not yet available", with the reason, is not counted and is skipped (`unavailable`), and
  the last step says what was not done for it (`notes`: "The regions were not identified…"). Answers
  that lead to no workflow also offer "Tell us what you wanted to do": a new GitHub issue, in a new
  tab, titled with the two answers and labelled Methodos (`feedbackUrl()`).
- **The tracker** (`section#methodos-tracker`, above step 1) lists the steps, each with its state in
  words (Done, Now, To come, Not yet available), the current one `aria-current="step"`, and "Step 3
  of 10" in a polite live region; no percentage, no time. The host's `onStep({ tool, text, link })`
  (`src/app.js`) chooses the step's tool as its card would (`#tool=`, step 2 narrowed) and says the
  step first in `#for-tool`; `onStep(null)` when the workflow is left.
- **The join to the tools' runs.** Before a file is chosen the workflow is pending (its recipe and
  answers, for the tab only); the runner starts (`runner.start`, which skips a step not yet available
  and keeps its reason in `unavailable`) when step 1's file is chosen. The host tells Methodos each
  run as it begins (`began({ op, files })`, `op` the operation a step names: `check`, `convert`,
  `compare`, `publish.<part>`, `match`, `lookup`, `apply`) and ends (`ended(...)`, with its report and
  outputs, or an error, a wait or a cancellation). A run is the current step's only if it is the step's
  operation on the step's file (by size and SHA-256); its outputs, copied for the tab, become the
  step's result, and the tracker offers them to the next step ("Use …"). A report with errors stops
  the step (`stop`), a failure fails it (`fail`, keeping a lookup's partial work file, which the
  tracker reopens), a permission not given makes it wait: each is said in the tracker's words. Only
  an interactive step (matching columns, review, Chora's drawing) waits for "This step is done", its
  result taken from the page as it stands; Chora's step also takes Chora's hand-back (below, "Chora's
  way back"), and the tracker's "Open Chora" opens `chora.html#workflow=<id>`. "Back a step" is
  `invalidate` of the last step done.
- **Save and resume** are phase 2's `workflowStore()` (`src/methodos/store.js`), saved at every step
  boundary, and taken up on load by the version rule (`reconcile()`), whose words the tracker shows
  ("Start the remaining steps under the new recipe" for a changed recipe). After a reload the step's
  file is chosen again and checked (`refsDiffer`): a different one is refused in words and a run on it
  is not counted. Where the browser gives a `FileSystemFileHandle` (Chromium's `showOpenFilePicker`,
  through the tracker's "Choose the file"), it is kept beside the records (`keepHandle`, database
  `plato-tools-methodos-handles`) and resuming is one click; elsewhere the file is chosen again.
  Turning "keep working data" off in the Permissions panel clears both databases at once
  (`keepChanged`), and the workflow carries on in the tab's sessionStorage.
- **Stephen's decisions of 4 October 2026.** A workflow chosen before any file is kept too
  (`savePending`, under `pending:<id>` beside the records, never read as one), shown after a reload as
  not started, with "Discard this workflow". The files the steps make (a dataset, a work file, a
  matching of columns) are kept as working data in OPFS, folder `methodos-outputs`, each under its
  SHA-256 (`src/methodos/outputs.js`), overriding decision 3 for these files only: the record still
  holds only references, the user's own files are never copied, and after a reload the next step's
  file is chosen for it. The tracker says what is kept, with "Clear them"; "keep working data" off
  keeps them for the tab only and clears the folder at once, and the Permissions panel's note says so.
  A file dropped in step 1 gives a handle too where the browser can (`getAsFileSystemHandle`,
  feature-detected; a folder's handle, or a refusal, gives none and the drop goes on).

`test/methodos-interview.test.js` holds the interview to `test/methodos-predicted.json`, which the
browser checks (`methodos_page_checks` in `e2e/app_test.py`) answer through the page and compare with what
it shows.

## Permissions

Nothing goes to another site unless the user allows it, in one panel for the whole toolbox: the
header's **Permissions** button, on both pages. `src/lib/permissions.js` is the only way a tool asks
another site, and `src/lib/permissions-panel.js` the panel; its words are in
`src/lib/permission-words.js`.

- **A permission is (category, subject)**, categories by what the site learns: `basemap` (a provider
  of the `REGISTRY`, `openfreemap`, `osm` or `carto`, each declaring every site it asks, or a pasted
  basemap's site), `iiif` (a historical map's host), `allmaps` (the service), `gazetteer` (`whg`, or
  another service's site), `linked` (a host). Its state is Allowed, Never, or Not decided (nothing
  recorded, the default). Not decided, a feature shows one line, "Needs permission: <name> —
  Permissions…", which opens the panel at that entry, where it can also be allowed for this tab only;
  Never, the feature does without, and says nothing. Never beats allowing for the tab. Everything
  decided is remembered (`localStorage` `plato-tools.permissions`); a site, rather than a known
  service, is listed as "Added on <date>", in words that do not claim the user added it (a sibling
  site may have, or the carrying over of an old consent); Forget all forgets them. The module reads
  storage again only when its text has changed (MapLibre asks at every tile), and carries old consents
  over once per load, never on the way to a request. `remembered()` gives the panel a person's name,
  or a pasted basemap's host and whether its address may hold a key, never the address. Tabs keep in step through the storage event.
- **The API.** The pure core, `src/lib/permissions-core.js`, re-exported by the module: `CATEGORIES`,
  `REGISTRY`, `parse`, `originsFor`, `check(grants, cat, subj, tab)`, `allowedOrigins`, `policyFor`,
  `fromFlags`. The page's side: `state(cat, subj)` (`'allowed' | 'never' | 'undecided'`),
  `allowed(cat, subj)` (allowed and in this load's policy: may be asked now), `waitsForReload`,
  `set(cat, subj, state)`, `allowOnce`, `forget`, `forgetAll`, `list()` (never the token),
  `onChange(fn)`; `fetch(url, { cat, subj, …init })`, which asks only that permission's sites, never
  with credentials, never follows a redirect (`redirect: 'manual'`: an answer that is a redirect, to
  any site, is refused as `moved`, since the page cannot see where it points), and throws a
  `PermissionError` whose `kind` is `address`, `insecure` (a plain http site, other than localhost and
  127.0.0.1: IIIF addresses often are, and none can be allowed), `undecided`, `never`, `reload`,
  `unprotected`, `moved` or `network`, and whose message names the site, never the address (a key may
  be in it); every kind but `moved` (sent, and answered with a redirect or from another site) and
  `network` (sent, or tried, and failed beneath the module) means nothing was sent. What it does with
  an answer is the core's `checkAnswer(r, url, sites)`, so that a fetch in Node (Hermes's, for
  `--fetch-georef`) refuses exactly what the page does: a redirect, a browser's opaque one or Node's
  3xx, and an answer from another site. The gazetteer lookup must be given it as its `fetch` by every
  page caller (`createLookup` refuses a later caller with another);
  `transformRequest(() => [[cat, subj], …], { onBlocked })` for MapLibre; `needs(el, cat, subj)` for
  the one line (for an http site it says why, in words, offers nothing to allow, and returns
  `'insecure'`; it throws only for what is no site at all), or `needs(el, [[cat, subj], …])` for a feature that needs several sites at once (one
  line naming those still to allow; the panel opens at the first); `open({ focus: 'cat:subj' })`; `onBeforeReload(fn, { loses })`, `reloadLosses()` and `reload({ confirmed })` (a part of the page that
  cannot keep something across the reload says so in `loses()`, and the panel then asks first, with
  Cancel: the main page names the files chosen, a run in progress and the review decisions not yet
  saved; Chora a line or area still being drawn, an address typed in the paste box and a save running); `mount({ state })`
  for the header button and the canary; `keepWorkingData()`; `persistChoice()` and `choosePersist(on)`; and
  `token`, the World Historical Gazetteer token's one keeper (`permissions.token`: `get`, `set`, `forget`,
  `onChange`, the API Krisis's own keeper had before it moved here, and `remember(on)`, `remembered()`:
  kept for the tab unless the user chooses to remember it; the panel says which, and that only
  regenerating the token in WHG revokes it); there is no other.
- **The Content Security Policy.** The first script in each page's `<head>` is the pure core, its
  `export`s removed, and `src/lib/csp-head.js`, put there inline by `scripts/vite-csp.mjs` at the
  page's `<!-- plato:csp -->` (a page without the mark fails the build). It writes, from the grants,
  before the page asks for anything: `default-src 'self'; script-src 'self'; style-src 'self'
  'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: <sites>; connect-src 'self'
  blob: <sites>; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'`,
  where `<sites>` are the sites of the permissions allowed, each checked against a strict origin rule
  twice (https, or http only for localhost and 127.0.0.1; a port no higher than 65535), so nothing
  kept in storage can add a directive. Storage that cannot be read gives the policy
  of nothing allowed. With nothing allowed it is the same on both pages. The policy cannot be widened
  while the page runs: a permission allowed takes effect from the next load (the panel offers the
  reload, and Chora keeps what is open); one withdrawn is refused at once by `fetch` and
  `transformRequest`. No `'wasm-unsafe-eval'` is needed: SQLite's WebAssembly runs in the engine's
  worker, which is made from this site's address and so takes no policy from the page (it fetches
  only this site's files; any request to another site belongs on the page, through the module).
  MapLibre's worker is made from a `blob:`, and is under the policy. The engine's worker cannot be
  put under it as things stand: ajv compiles PLATO's JSON Schemas with `new Function`, which a
  policy without `'unsafe-eval'` refuses (measured: the page stops with "Error compiling schema"; with
  `'unsafe-eval'` added, checks and Chora run). `'unsafe-eval'` was considered and refused (1 October
  2026). The plan, as a follow-up: compile the validators at build time with ajv's standalone code,
  from the vendored schemas, and then start the worker from a `blob:` (with `'wasm-unsafe-eval'` for
  SQLite). Until then, every request to another site is made on the page's own thread, through the
  module, never in the engine's worker.
- **The canary** (`src/lib/csp.js`) proves two things at start, and only both count. First, that a
  policy is enforced at all in a worker made from a `blob:`: the worker fetches a `data:` address,
  which only a policy can refuse (`connect-src` does not list `data:`), and, as the control, a
  `blob:` of its own, which the policy allows. That proves enforcement, not what the policy allows:
  a policy widened to every site refuses `data:` too. So, second, `checkPolicy` reads the page's one
  Content Security Policy `<meta>` and requires its text to be exactly `policyFor()` of the sites
  published with it, each a plain site, with `connect-src` and `img-src` naming nothing else but
  `'self'`, `blob:` and (images only) `data:`. Unless both hold, the module asks no other site at all
  (`unprotected`), whatever is allowed, the panel says so in a plain line, and Chora stays on Natural
  Earth and says why. What it cannot see: a policy sent by a server header (GitHub Pages sends none).
  The canary used to wait for a `securitypolicyviolation` event, which WebKit never raises, so Safari
  had no other site at all. `node scripts/canary-engines.mjs` (opt-in: set `PLAYWRIGHT_MODULE` to an
  install of Playwright, which is not a dependency; an engine without its browser is skipped, said
  so) runs the real module in Chromium, Firefox and WebKit under the policy written, none, one that
  lists `data:` and one widened to `*`, with the `<meta>` as served and as written by a script: on 1
  October 2026 (Playwright 1.62: Chromium 151, Firefox 153, WebKit 26.5) each gave the expected answer.
  The browser reports the canary's refused `data:` request in the console ("Connecting to
  'data:text/plain,canary' violates … connect-src"), which no page can silence, so the page then says,
  once per load (`announceCanary`), that this was its test and was blocked as it should be, or warns
  that the page is not protected, with the panel's reason. Playwright evaluates a bare expression with
  `eval()`, which the policy forbids: the browser checks give it functions.
- **The shared origin, plainly.** The tools are served on `pelagios.org`, which other Pelagios sites
  share. Everything the tools keep in this browser, permissions, choices, a pasted basemap's address
  and key, the WHG token if remembered, a reviewer's name, the working data (Chora's drafts, its
  last output, the historical maps it keeps in `chora-overlays/` and their notes in sessionStorage),
  can be read and changed by any page of `pelagios.org`, on that computer only. A
  page there could forge a grant; the panel lists whatever is kept, so a forged grant is seen and can
  be withdrawn, and the policy admits only plain sites. The panel says this in words. Moving the
  tools to an origin of their own was considered and not done (2026-10-01); the audit of that day
  proposes it again. Until then, **nothing read from storage is trusted to act on its own**: a pasted
  basemap is used only after a click in this load (above, Chora), and is rebuilt from its address alone
  when read (`pasted()`: its kind, its name and its group come from the address, never from fields a
  sibling could write, such as `local` or `provider`; a click chooses the basemap as it was listed, at
  that address, not whatever storage holds by then, `sameBasemap`); a remembered
  contributor's or reviewer's ORCID is checked again on load (`orcidUri`, `checkReviewer`) and dropped,
  and the cleaned value written back, if it is not one; a historical map's shown state (its note or
  its record) is read only if Show is a boolean and the opacity a number from 0 to 1, and a map kept
  is admitted afresh, permissions and all, on every load; files handed to Chora are usable for two
  minutes and let go by either page after that.
- **The frame and the referrer.** The head script also guards against framing: framed by another
  origin (the top window's address cannot be read), the page hides everything it has behind one line,
  "PLATO tools cannot be used inside another site's page", and publishes `__platoCsp.framed`. Framed
  by this site's own origin, any page of `pelagios.org`, it cannot tell, and does not try: script
  cannot stop same-origin framing, and only a `frame-ancestors` header or an origin of the tools' own
  could. Each page's `<meta name="referrer">` is `strict-origin-when-cross-origin`: another site, on a
  link followed or a tile asked, is sent this site's origin at most, never the page's address. Not
  `no-referrer`: OpenStreetMap's tile usage policy requires a Referer on requests to
  `tile.openstreetmap.org` ("Do not set a restrictive Referrer-Policy that prevents the Referer header
  being sent", read 1 October 2026), and CARTO's key is scoped by it. Links written from the data (a
  source's address, an ORCID) carry `rel="noopener noreferrer"`, so they send nothing, and the panel
  says that following one is a visit the user makes, outside the permissions.
- **Working data.** "Keep my working data between visits" (on by default,
  `plato-tools.keep-working-data` is `no` when off): off, Chora clears its drawings not saved, its
  last output and the historical maps it keeps (`chora-overlays/`, and their notes in sessionStorage) at the next load (not at a reload for a permission), and the output once saved to disk.
  The dataset's working copy, in Chora's SQLite pool, is cleared at every start anyway (`clearOnInit`).
- **Persistent storage.** "Keep large datasets' working files (ask the browser for persistent
  storage)" calls `navigator.storage.persist()` once, when the user ticks it, never on load (Firefox
  asks the user, which is why Chora no longer calls it itself), and remembers the browser's answer
  (`plato-tools.persist`: `{granted, at}`), which the panel shows. Unticking forgets the choice; the
  browser's answer can be undone only by clearing the site's data in the browser, which the panel says.
- **Redirects.** `permissions.fetch` never follows one (`redirect: 'manual'`), and a browser cannot
  read a redirect's `Location` (the answer is opaque), so it cannot tell where it pointed. Every
  redirect is refused, as `moved`, in words naming the site. What e2 found in real IIIF and Allmaps
  data is that the redirects that matter are mended by the caller before asking: an `http:` address
  asked as `https:`, an image service's `{id}` given its `/info.json`, and Allmaps' annotation found by
  the hash of the image's address rather than through its redirect. A redirect to another host (an
  ARK resolver, say) is refused with words, never followed: allowing the resolver's site would not
  say where it sends the user next.
  Measured on 1 October 2026, with 37 curl requests, without `-L`,
  sending `Origin: https://pelagios.org`:

  | Case | Request | Status | From → to | Same origin? |
  |---|---|---|---|---|
  | Digital Commonwealth ARK manifest | `https://ark.digitalcommonwealth.org/ark:/50959/ks65px29g/manifest` | 302, then 301 | → `digitalcommonwealth.org/search/commonwealth:ks65px29g/manifest` → `www.digitalcommonwealth.org/…` | No: 2 hops, 3 hosts |
  | n2t resolver | `https://n2t.net/ark:/50959/ks65px29g` | 302 | → `https://arks.org/ark:/…` | No |
  | http manifest or info.json | Rumsey, DC, LoC, Gallica, Stanford, Bodleian over http | 301 or 302 | → https, same host and path | Scheme only |
  | Image id without /info.json | Rumsey (relative Location), DC (303), LoC (scheme-relative `//tile.loc.gov/…`) | 302 or 303 | → `{id}/info.json` | Yes |
  | Image id with a trailing slash | DC | 301 | → without the slash | Yes |
  | Allmaps `?url=<image id or info.json>` | `annotations.allmaps.org/?url=…` | 301 | → `/images/<id>` (404 when there is no georeference); pasted, it is asked there instead | Yes |
  | Canonical https manifest, info.json or tile | every server tested | 200 | — | — |

  The decision (c2, 1 October 2026): `permissions.fetch` stays strict and refuses every redirect.
  Callers avoid the same-origin cases: upgrade to https, use `{id}/info.json` without a trailing
  slash, and compute the Allmaps `/images/<hash>` themselves (Chora's `remote.js`). Cross-host
  forwarding (ARKs) is refused with words that ask the user to open the address in a new tab and paste
  the address it ends at. A test shows the module never reads a `Location`, so a relative or
  scheme-relative one needs no resolving. Following redirects whose final address stays within the
  same permission's sites (option b) could be reconsidered with this table to hand.
- **Chora's old consents** (`chora-basemap-consent`, a list of sites) are carried over by the head
  script at load, by the module at its first read, and by the module again when another tab writes
  the old key (the storage event): a provider all of whose sites are listed becomes
  `basemap:<provider>`, every other site `basemap:<site>`, and the old key goes.
- **The command line has no settings: the flag is the consent.** A command that asks another site
  takes `--gazetteer` (`whg` or a service's address) and repeatable `--allow-host`, makes grants for
  that run with `fromFlags({ gazetteer, allowHost, hostCategory })`, and asks `check()` before each
  request; tokens come from the environment, never from a file the tools write. A value of
  `--allow-host` that names a known service (`allmaps`) grants that service; a site grants it only for
  the category of what the command fetches (`hostCategory`, `iiif` for a georeference's maps), and is
  refused when the command gives none. **Changed on 1 October 2026:** a site given to `--allow-host`
  used to be granted for `iiif` and `linked` both. No command asks another site yet, so nothing that
  runs today changes; a command written against the old rule must now say its `hostCategory`.
- **Adopting it.** Chora's basemaps and historical maps (`iiif`, `allmaps`) use it now. Krisis's
  gazetteer lookup (`allowed('gazetteer', 'whg')` before sending; `token` for the token) moves onto
  it in its own branch, and Hermes's linked sites (`linked`, per host) when it fetches.

## Limits

- **Private windows** keep the browser's file storage in memory and allow it very little, so large
  files fail there. The page warns when the storage allowance looks too small.
- **Tracing with assistance** (`src/engine/chora/ink/`; measured on the synthetic maps of
  `test/chora-ink-lines.test.js`, 2026-10-01, in working pixels):
  - **A line 3 px wide running near 45° thins short**: the 3×3 median leaves it two pixels wide on the
    diagonal, which Zhang–Suen erases. So a plain curve's end there is carried on straight from where
    the skeleton stops (7 px short of the ink at radius 30, 13.5 at radius 90) while the arc curves
    away: up to 4.8 px short at radius 30 and 3.9 at radius 90 (2.2 and 2.3 at 104a9f9); within 2.2 px
    at 6 px wide. The arc test holds the ends to 5 px, a limit, not a target. Drawn bends (a straight
    leg turning by 20° or 45°, 1.5 to 5 widths from the end) are placed to 2.5 px. And a short stroke
    (2 to 5 widths long) 3 px wide at about 50° thins to four pixels, so its width at the click is
    over-read (13.18 for 3), the thickness band takes every skeleton pixel but the seed's, and it is
    traced as one point (a `test.todo` there, run and reported as to do while it fails).
  - **A flat end narrower than 6 px on a slant** is placed as a round one, half a width short of where
    the ink stops: the pixels do not tell the two apart there (`FLAT_END` in `ink/index.js`).
  - **A line ending on a bar twice as wide** can run on along it: the thickness band cuts the bar's
    widest pixels out of the skeleton, and the stem's chain runs round into one half of the bar with
    no junction to stop at. On a bar as wide, the line stops at it, within 1.3 px of its near edge.
- **A workbook** (.xlsx, .ods) is read whole, one sheet at a time, since SheetJS cannot stream one; a
  workbook over 50 MB is warned of, as tables or as a table of places. Only one sheet of a workbook
  of one's own is read per run; a hidden sheet of an ODS workbook is not known as hidden. CSV files, and a zip of them, stream at any size, as the JSON,
  JSON Lines, LPF and RDF routes do.
- **A document's header comes first.** `dataSets` or `relationTypes` written after the records are
  reported, not read.
- **Web annotations** give attestations about places the file does not describe, so each place is
  labelled with its address, with a warning. A region on a georeferenced map is carried as a
  point, never as its outline.
- **Finishing a review with the dataset output holds the dataset written in memory** until the
  version check has read it back (the engine's hosts have no way to read an output again): as Blob
  parts, so about the size of the file in UTF-8, on top of what the conversion and the check need. A
  very large dataset may need the attestations-only output instead.
- **A long SQLite step cannot be interrupted** from the command line: Ctrl-C takes effect when it
  ends.
- **Memory that grows with the named things written.** Streaming keeps memory flat in the number
  of records, except for two sets that grow, linearly, with the distinct addresses written: with
  `--typing`, `Json2Rdf` keeps each named node it has typed (`typedNamed`, one set of addresses per
  class), so that none is typed twice; the LPF writers keep each place written (`placed`), to
  report an identity match whose place is not in the file. On data rich in addresses they dominate:
  the audit of 30 September 2026 measured 358 MB converting 300,000 places whose attestations all
  have minted addresses to N-Triples with `--typing`, against 221 MB without.
- **`datacube` holds the cube's graph in memory** (`graphOfFile` in `src/lib/datacube.js`): the
  file streams in, but every statement is kept until the checks have run, so a cube export larger
  than memory cannot be checked.
- **A match review keeps the places of both datasets in memory**: their names and points, not their
  attestations, but a gazetteer of millions of places needs a machine with room for them.
- **Matching finds names alike in their letters, not translations or short respellings**: Köln and
  Cologne, or Wum and Wem, are not suggested (see Match review for the limits of three-letter words).
  A pair that shares little but its first three letters (Bruxelles and Brussels) is compared only
  when blocking finds it at all, through a trigram that is not common in the other dataset; in a large
  gazetteer, where "bru" is common, it may not be. **Qualifiers are lists, one per language** (see
  Match review), and only English, Welsh and Latin is on by default and measured: a pair that differs
  by a word not on a list chosen (Great Marlow and Marlow, a manorial name, Wootton Bassett and
  Wootton) is not found, nor one whose cores are spelt differently (Chipping Ongaar and Ongar), and a
  qualifier pair is suggested at 0.88 whether or not it is the same place.
  The default threshold stays 0.85: in the DEEP trial 0.80 added noise and found nothing more, and 0.90
  lost real pairs that differ in a suffix or are in two languages.
- **RDF output is N-Triples only**, and Linked Places Format v2 is refused until it is specified.

## Testing

```bash
npm test                                  # the engine and the command line, in Node
python3 e2e/app_test.py                   # the page itself, in Playwright's bundled Chromium
python3 e2e/app_test.py --url=https://pelagios.org/plato-tools/   # the deployed page
python3 e2e/app_test.py --prove-it-fails  # every check pointed at a page with no tools: all must fail
python3 e2e/ink_budget.py                 # the budget of tracing with assistance, timed in the page
node e2e/ink_memory.mjs                   # the tracing worker's memory, for its budget
node scripts/install-test.mjs             # install the packed tools as npx does, and run the command
node e2e/compare_scale.mjs deep-plato.jsonl.gz --work-dir DIR   # the version check at full scale
python3 e2e/scale_test.py --input deep-plato.nt.gz --target plato-jsonl --out out.jsonl
PERSEUS_P4_FILE=/path/to/text.xml node scripts/check-perseus-p4.mjs   # TEI P4 against a real Perseus file (opt-in)
```

**The full gates run on GitHub, not here.** Every branch pushed (any but `main`) runs
`.github/workflows/gates.yml`: its jobs side by side, each with PLATO checked out at the pinned
commit, on every branch: **unit**, **e2e** and **prove-it-fails**, plus **same-checks**. They also run
every night on `main` (03:17 UTC), and by hand with `gh workflow run Gates --ref <branch>`.
**same-checks** runs whenever prove-it-fails does, and compares the two.

- **unit**: `npm test`, `scripts/install-test.mjs` (the tools installed as npx installs them, and
  the command run) and `npm run build`.
- **e2e**: `python e2e/app_test.py` against the build, in Playwright's Chromium. Its `RESULT:` line
  is in the run's summary, with every failing check named.
- **prove-it-fails**: `python e2e/app_test.py --prove-it-fails`, green only when every check fails
  against a page with no tools on it (the harness can fail); a check that passed there is named in
  the summary. Every check runs, as in **e2e**, but a wait on that page ends after a second
  (`FAST` in `e2e/app_test.py`) where it used to run its full timeout: the page has no script, so
  what a check waits for there is true at once or never. Only waits on that page are cut short
  (`toolless()`), not on a page other than the one with no tools (about:blank, a framing page, the
  real page that a few checks open in this mode), and never a navigation or a fixed pause. Nor once
  the harness may have put into it something that acts later: a script tag or new content
  (`add_script_tag`, `set_content`) or an `evaluate()` naming a timer, a promise or an async
  function (until the next navigation), or an init script naming one (for good, on the page or its
  whole context, as init scripts run again on every navigation). A check that passes there fails the
  job as before, with one limit: the test for "acts later" reads the script's text, so a script that
  changes the page later without naming a timer, a promise or `async`, and a check that passes only
  more than a second after that change, would be missed here and caught by `PROVE_FULL_WAITS=1`,
  which waits in full everywhere (some 85 minutes on GitHub). Planted vacuous checks of each kind (a
  wait on what the page has, an absence after a wait that timed out, a state set 3 s later by a
  script tag, by `evaluate()`, by an init script) were each caught, October 2026. The run's last
  lines give the number of checks and of waits cut short, and a run that cut none short fails (the
  shortener no longer recognises the page). The step takes some twelve minutes on GitHub and the job
  about thirteen; it is given 20. Most of what is left is the pages whose init scripts define an
  async function (the stand-ins for `navigator.storage`, which Chora's context has), waited on in
  full by the rule above.
- **same-checks**: the names of the checks run in **e2e** and in **prove-it-fails**, sorted (a check
  run twice counts twice), must be the same list. prove-it-fails says only that every check that ran
  failed; a check it never reached (a section stopped early) would otherwise go unnoticed. A
  difference is shown as a diff, and an empty list from **e2e** fails too.

```bash
git push -u origin my-branch
gh run list --branch my-branch --workflow Gates -L 1   # the run's id
gh run watch <id> --interval 300 --exit-status          # exits non-zero if any job failed; poll no faster
```

A branch lands on `main` when its Gates run is green: the hour-long browser runs on this desktop are
no longer needed for landing. A new push to the branch cancels its run in progress. A job that
fails uploads its log as an artifact (`gh run download <id>`). The run is given no secrets: what
needs a token (`WHG_TOKEN`) is skipped, as it is locally without one. Keep quick, targeted checks
local while working (`node --test test/x.test.js`, `npm test`), and push for the full gates.

`npm test` reads PLATO's examples from a checkout of PLATO beside this one, or wherever
`PLATO_REPO` says; it should be at the pinned commit, as it is in CI. The tests check that:

- JSON to RDF gives exactly the graph `jsonld.js` gives, and JSON to RDF to JSON loses nothing, on
  every PLATO example;
- the table validator agrees with the reference CSV on the Web implementation (rdf-tabular), on
  good and broken tables;
- every key the JSON Schema allows is carried or reported by every writer;
- no writer states what a source denies, a withdrawn claim as current, or a computed value as
  evidence;
- Recogito's exports become the attestations designed for them;
- the version check finds each kind of deletion and change, each made by one edit to a version
  that passes;
- the match review suggests near namesakes and not far ones, refuses a tampered work file, and
  writes attestations the checker passes;
- the command line gives what the engine gives, with the right exit status;
- nothing is asked of another site without its permission, Never beats allowing for the tab, a forged
  or injected grant cannot reach the policy, and the token is in no list and no error;
- tracing with assistance proposes known shapes from synthetic maps drawn in code (`test/ink-synth.js`,
  seeded; non-square windows, off-centre asymmetric shapes, a 1001 × 701 image tiled at an odd size):
  outlines and centrelines within a pixel, the half-pixel conventions, faint ink on a vignette (where one
  threshold fails), specks and JPEG blocks, gaps, colours, the seam between tiles; and its tiles are
  asked only through the permissions, and let go once a site's permission is withdrawn.

The browser checks run every page under its Content Security Policy, and check that with nothing
allowed neither page asks another site; that a permission allowed in the panel, from its "Needs
permission" line, is used after the reload and refused at once when withdrawn; that a page served
without its policy is found unprotected by the canary and asks nothing; and that turning off "Keep
my working data" clears Chora's drawings, and the historical maps it keeps, at the next load; that a
pasted basemap written into storage as allowed and chosen is not used, and its site asked nothing,
until a click; that a page framed by another origin hides itself; that a link carries the origin at
most, and a data link nothing; that a planted ORCID is dropped on load; and that a stale hand-off is
let go by the main page.

Chora's historical maps are checked against a real second origin: `e2e/iiif_fixture_server.py`
serves `test/fixtures/chora-iiif/` on three free ports, A (the image server allowed), B (never to
be asked) and C (which sends no CORS header), and logs every request it receives. It serves `ink.png`,
a synthetic map for tracing with assistance, as IIIF tiles cut and scaled with Pillow (JPEG, PNG, and
with its full-resolution tiles refused, 403). That log is the census: Playwright's request events
also list requests the browser stopped. Allmaps' annotation server is answered by `page.route`.
The checks include nothing asked of A before its permission is allowed in the panel, and the map
pasted then added after the one reload, also when a map kept waits on A too (both come back); a tile answered with a redirect to B, in the built page's
tile workers (B must get nothing in the whole run, and is not in `window.__platoCsp.origins`,
while the honest map on A draws); an `info.json` naming B; an address on A forwarding to B; Allmaps
asked nothing until its permission is allowed from "Look for a georeference", then at `/images/<id>`
only; the renderer's own transformation of 25 pixels against `src/engine/georef/`'s, to 1e-7 m, at
order 1 and 2, with the renderer's order-1 transformation of the order-2 map as the control; a
permission withdrawn, and set to Never; maps refused on a page without its policy; and tracing with
assistance: a line and an area proposed, carried on, accepted, saved and cited, a slider asking
nothing more, a permission withdrawn letting go of the tiles read, Snap to ink, and a server without
CORS or refusing the pixels (403).

A check that finds nothing is worth something only if it could have found something: each test of
an absence has a presence beside it, or a control that finds the same thing when it is there.

Tests that need the DEEP exports (from
[WorldHistoricalGazetteer/epns](https://github.com/WorldHistoricalGazetteer/epns), in
`../deep/data/export` or wherever `DEEP_EXPORT` says) run when the exports are present and are
skipped, visibly, when not. `e2e/scale_test.py` runs one conversion in the real page at full scale,
sampling memory and disk, and `e2e/verify_jsonl.mjs` and `e2e/verify_nt.mjs` check its output
independently.

## Development

```bash
npm run dev      # a local server
npm run build    # the site in dist/; fetches PLATO's files at the pinned commit first
npx vite build   # the same, with the PLATO files already in public/plato/
```

A push to `main` runs the tests, builds the site and publishes it to GitHub Pages
(`.github/workflows/pages.yml`).

- **A release.** The version is in `package.json` (and `package-lock.json`), `CITATION.cff` and
  `.zenodo.json`, which must agree, and the git tag (`v0.9.0-alpha.1` style). The `alpha.N` in a
  version is for developers; everything a user reads calls the tools *experimental*. After updating
  `CITATION.cff`, run `node scripts/badges.mjs`: it writes the README's three badges (DOI, status,
  version) into `badges/` as static SVG files, from `CITATION.cff`'s `version` and its concept DOI
  under `identifiers` (no badge service is used, since those can break). Commit them with the
  release; `test/badges.test.js` fails while a committed badge differs from what the script makes,
  and `node scripts/badges.mjs --check` says the same. Only the concept DOI
  (`10.5281/zenodo.23133141`) belongs in the repository: a version's own DOI does not exist until
  Zenodo has archived the tag.
- **The toolbox.** The page opens with the introduction, step 1's drop zone, and one card per tool
  (`nav#toolbox` in `index.html`), and the README with a table of them. When a tool lands, update
  its card and its row in the same change. A card is a link to `#tool=<key>` (never a button's id),
  which narrows step 2 to that tool: each part of step 2 names in `data-tools` the tools it is for,
  and `src/app.js` (`TOOLS`, `chooseTool`) does the rest. With no tool chosen, step 2 offers every
  action, Chora's map included. Hermes's card goes to the drop zone; Chora's opens `chora.html`,
  with the chosen file (`src/chora/handoff.js`).
  The cards are grouped, one `ul.tools.choose` under each plain `h3.tool-group` heading (Guided workflows,
  Bring your data in, Check and convert, Identify and locate, Publish and keep, Explore), with each
  card's name an `h4`; the order is decided in `docs/plans/methodos.md` (11.2). Each group is a
  `div.tool-set` with `data-cards` (its number of cards), and the groups flow in one grid of card-wide
  columns (3, 2 or 1, by container query), each spanning as many columns as it has cards, so that a
  group of one shares a row; its list is on those columns by `subgrid`. A planned card
  (`li.tool.coming`: Peripleo, last) has a badge and no link, and is never chosen. Methodos's card,
  first, is a link (`#methodos-card`, no `data-tool`) that opens the interview. A
  check that wants the n-th card counts across the groups, not `:nth-child` within one.
- **The introduction** (`#intro`) can be hidden, and stays hidden (localStorage
  `plato-tools.intro`). `public/intro.js`, a classic script in `<head>`, sets `html.intro-hidden`
  before the first paint; it is a file, not an inline script, so that a policy of
  `script-src 'self'` allows it.
- **The colour theme** is Auto (the device's setting), Light or Dark, chosen in the header of both
  pages (`#theme-switch`, three radio buttons) and remembered per browser (localStorage
  `plato-tools.theme`; nothing for Auto). `public/theme.js`, a classic script in `<head>` before the
  stylesheet, sets `html[data-theme="light|dark"]` before the first paint, and takes up a choice
  made in another tab. In `src/styles.css` every dark rule is written twice, under
  `@media (prefers-color-scheme: dark)` for `:root:not([data-theme="light"])` and again for
  `:root[data-theme="dark"]`, word for word; `test/theme.test.js` fails if a twin is missing or
  differs, so add a colour to both. The statuses' colours are tokens (`--status-…`), used by the
  card's labels and its timeline's bars alike. What does not change with the theme is the map: its
  basemaps, the places drawn on it (`STATUS_COLOURS`, defined in `src/chora/card.js` and imported
  by `src/chora/map.js`), and its controls (MapLibre's own white control group).
- **Tooltips** are the site's own (`src/lib/tooltip.js`, loaded by each page; its styles are the
  commented block in `src/styles.css`), never the browser's: give an element `data-tip="…"`, or
  `data-tip-template="id"` for a `<template>` of rich text (no links or controls: a tooltip cannot
  be entered), not `title`. A `title` that appears anyway, such as MapLibre's on its buttons, is
  turned into a tooltip as it appears. Each shows on hover and on keyboard focus, stays while the
  pointer is on it, closes with Esc (which still reaches the page: Terra Draw and the match review use it), and is named by its element's `aria-describedby`; an element
  that cannot take focus, and is not inside a link or button that can, is given `tabindex="0"`
  (except in an SVG drawing). `npm test` and the browser checks fail if a `title` attribute is left
  on either page. The pages Agora writes carry no script and no tooltips.
- **Wording** lives in `src/engine/words.js` and `src/engine/report.js`, so that the page and the
  command line say the same thing. British spelling, plain words.
- **The PLATO guide links to this repository** in two places: the README's
  `#from-the-command-line`, and `test/fixtures/annotations/README.md#the-mapping`. Keep those
  headings.
- **The guide's Hermes pages** (proposed, not yet published) add two more links:
  `test/fixtures/tei/README.md#the-mapping` and `test/fixtures/generic/README.md#the-mapping`.
