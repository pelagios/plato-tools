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
  read a dataset's records through `options.sink` (`candidate-set-not-a-dataset`). From RDF, a graph
  with a candidate set and no dataset (no gazetteer with anything said of it beyond its type, no
  attestation and no identity relation: typed N-Triples type a candidate's dataset and places, and a
  place described a little more is still one the candidates name) is written as the candidate set; a graph with both is written as the dataset, and the candidate set is
  reported as not written (`candidate-set-not-written`), to RDF as well as to JSON. Krisis's apply
  refuses a candidate set given as its dataset. A dataset's `gazetteer.candidateSets` is the
  reverse of `plato:candidates_for`, written and read back as such (`test/candidates.test.js` checks
  the triples against jsonld.js's); the tables and LPF leave it out and report it
  (`dropped:gazetteer.candidateSets`). Where the tools stand: a candidate set is read, checked against
  its profile and converted. Krisis's export of one and its `promotedFrom` come later, as do the checks
  no schema can make (ids under their set, the mint rule, duplicates, across sets, `promotedFrom`
  against a set given beside a dataset) and the version check of a candidate set (the candidate set
  specification's section 13). An edge case to keep: a candidate's score records what the software
  said when it first suggested the pair. A candidate is frozen once issued, and a later set leaves out
  any pair already published, so if the places' names change and the same algorithm with the same
  settings would now score the pair differently, the first score stands. A different
  `algorithmVersion` or different `matchParameters` make a different candidate, with its own address.
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
  refused. Any other XML (TEI P4, TEI in no namespace, KML, anything else) is refused by
  `detect()` with a reason (`XML_REASONS`), never sniffed as N-Triples.
- **Tables of places** (`columns.js`, `generic.js`). `input.js`'s `detect()` sends a lone CSV (or
  `.tsv`/`.tab`) that is not one of the tables' sheets, and a FeatureCollection or Feature whose
  structure is not LPF's (`isLpf`, on the head read as structure by `jsonHead`), here. A GeoJSON
  sequence is LPF only by the same test, of its collection line or its first feature; a sequence of
  plain features is refused (`GEOJSON_SEQ_REASON`), asking for one FeatureCollection. A IIIF
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
  pattern, until the user confirms it. `mappingToSave(mapping, patterns)` gives the one JSON object
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
- **The pipeline hook** (`pipeline.js`, `runChecked`): `tei` goes to `teiSource`, `csv` and
  `geojson` to `genericSource`. TEI is attestation-centric, so it goes through the store like
  annotations; for a table of places `genericProfile` reads the mapping first to decide the profile,
  and so whether the store is needed, and its records are schema-checked like the tables'.

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
- **Scoring** (`names.js`, algorithm `krisis-names 5`). Names are normalised: NFKD, combining marks
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
  bound); a name exactly the same is always compared. So a name is compared with at most 1% of the
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
  mints one) and no `promotedFrom` (the candidate is not published).
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
guard and drawing; `basemaps.js`; `overlays.js` and `remote.js`, the historical maps; `ink.js`,
`ink.worker.js` and `inkfetch.js`, tracing with assistance; `contributor.js`; `drafts.js`; `handoff.js`,
which passes files chosen on the main page through IndexedDB, taken out of it as soon as Chora's page
starts, not offered if older than two minutes, and let go by the main page too, when it starts, is shown
again or is left, once it is that old), and its engine `src/engine/chora/` (`store.js`, `view.js`,
`draw.js`, `save.js`, `geo.js`, `trace.js`, and `ink/`, the pixel work of tracing with assistance). It
publishes its state on `window.__chora` for tests.

- **The worker** is the main page's, with commands of its own, sent one at a time: `chora-load`,
  `chora-search`, `chora-overview` (every place's point, at most 50,000), `chora-place` (one
  place's view) and `chora-save`.
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
- **Saving** writes the whole dataset as PLATO JSON, `<input>.chora.json`, each record as it was
  read with its drawings appended as new attestations: one `run()`, a conversion to `plato-json`
  whose `options.augment` puts each place's drawings after its own attestations. The pipeline does
  not check what `augment` adds, so drawings are checked against the pinned JSON Schema, and
  against the places the dataset has, before anything is read or written. A drawing for a place whose
  `attestations` are not a list (the schema refuses it, and Chora still opens it) is refused, naming
  the place, since it could only replace them. Problems the writing finds are shown even when Mneme
  passes, as it compares attestations and nothing else.
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
  `lookup.clearToken()`). A tool reads the token from its one keeper (`token` in `src/lib/permissions.js`)
  and passes it, rather than keeping a copy of its own. What is held when: within a page or
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
  anything. **A permission withdrawn** takes its maps off the map at once (they stay kept, and come
  back once it is allowed again); tiles the renderer has already asked for cannot be called back.
  Each map's row names its image's site, with a "Permissions…" button that opens the panel there.
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
    `choraAssistedNote` (`words.js`, the one place they are made) and then georefNote's: how it was
    proposed (ε in image pixels, the gaps bridged, the holes left out) and "accepted as proposed" or
    "edited by hand: moved k, added a, removed d, of n proposed", counted against the proposal
    (`ink/edits.js`). Attested, not computed: a person accepted it. Moved off its map, it keeps saying it
    was proposed from that map's ink, and that the citation was dropped (`uncitedParts`).
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

## Gazetteer lookup

Krisis can also look the subject places up in a gazetteer, through its W3C reconciliation service (the
World Historical Gazetteer by default, or any other by its address), and add what it answers to the
same work file as a local match, for the same review. `src/engine/krisis/lookup.js` holds it; the
talking to the service is the shared gazetteer module's (`src/engine/gazetteer/`, owned by the Chora
work, used here and never changed). The command line is `plato-tools lookup` (with `--dry-run` to see
what would be sent); on the page it is the panel "Look up in a gazetteer (online, optional)" beside
matching (below). This sends each place's name to the gazetteer, and its coordinates only with `--near`.

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
  be in it). What it does with an answer is the core's `checkAnswer(r, url, sites)`, so that a fetch
  in Node (Hermes's, for `--fetch-georef`) refuses exactly what the page does: a redirect, a browser's
  opaque one or Node's 3xx, and an answer from another site;
  `transformRequest(() => [[cat, subj], …], { onBlocked })` for MapLibre; `needs(el, cat, subj)` for
  the one line (for an http site it says why, in words, offers nothing to allow, and returns
  `'insecure'`; it throws only for what is no site at all), or `needs(el, [[cat, subj], …])` for a feature that needs several sites at once (one
  line naming those still to allow; the panel opens at the first); `open({ focus: 'cat:subj' })`; `onBeforeReload(fn, { loses })`, `reloadLosses()` and `reload({ confirmed })` (a part of the page that
  cannot keep something across the reload says so in `loses()`, and the panel then asks first, with
  Cancel: the main page names the files chosen, a run in progress and the review decisions not yet
  saved; Chora a line or area still being drawn, an address typed in the paste box and a save running); `mount({ state })`
  for the header button and the canary; `keepWorkingData()`; `persistChoice()` and `choosePersist(on)`; and
  `token`, the World Historical Gazetteer token's keeper (`get`, `set`, `forget`, `onChange`, the API
  Krisis's own keeper had before it moved here, and `remember(on)`, `remembered()`: kept for the tab
  unless the user chooses to remember it; the panel says which, and that only regenerating the token
  in WHG revokes it).
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
  last output), can be read and changed by any page of `pelagios.org`, on that computer only. A
  page there could forge a grant; the panel lists whatever is kept, so a forged grant is seen and can
  be withdrawn, and the policy admits only plain sites. The panel says this in words. Moving the
  tools to an origin of their own was considered and not done (2026-10-01); the audit of that day
  proposes it again. Until then, **nothing read from storage is trusted to act on its own**: a pasted
  basemap is used only after a click in this load (above, Chora), and is rebuilt from its address alone
  when read (`pasted()`: its kind, its name and its group come from the address, never from fields a
  sibling could write, such as `local` or `provider`; a click chooses the basemap as it was listed, at
  that address, not whatever storage holds by then, `sameBasemap`); a remembered
  contributor's or reviewer's ORCID is checked again on load (`orcidUri`, `checkReviewer`) and dropped,
  and the cleaned value written back, if it is not one; files handed to Chora are usable for two
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
  last output and the historical maps it keeps (`chora-overlays/`) at the next load (not at a reload for a permission), and the output once saved to disk.
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
  workbook over 50 MB is warned of. CSV files, and a zip of them, stream at any size, as the JSON,
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
  gazetteer, where "bru" is common, it may not be. **A qualifier word in front is never found**: Great
  Marlow and Marlow score 0.333, Chipping Ongar and Ongar 0.514, as the qualifier is a word not shared.
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
```

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

- **The toolbox.** The page opens with the introduction, step 1's drop zone, and one card per tool
  (`nav#toolbox` in `index.html`), and the README with a table of them. When a tool lands, update
  its card and its row in the same change. A card is a link to `#tool=<key>` (never a button's id),
  which narrows step 2 to that tool: each part of step 2 names in `data-tools` the tools it is for,
  and `src/app.js` (`TOOLS`, `chooseTool`) does the rest. With no tool chosen, step 2 offers every
  action, Chora's map included. Hermes's card goes to the drop zone; Chora's opens `chora.html`,
  with the chosen file (`src/chora/handoff.js`).
  The cards are grouped, one `ul.tools.choose` under each plain `h3.tool-group` heading (Start here,
  Bring your data in, Check and convert, Identify and locate, Publish and keep, Explore), with each
  card's name an `h4`; the order is decided in `docs/plans/methodos.md` (11.2). Each group is a
  `div.tool-set` with `data-cards` (its number of cards), and the groups flow in one grid of card-wide
  columns (3, 2 or 1, by container query), each spanning as many columns as it has cards, so that a
  group of one shares a row; its list is on those columns by `subgrid`. A planned card
  (`li.tool.coming`: Methodos first, Peripleo last) has a badge and no link, and is never chosen. A
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
  basemaps, the places drawn on it (`STATUS_COLOURS` in `src/chora/map.js`), and its controls
  (MapLibre's own white control group).
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
