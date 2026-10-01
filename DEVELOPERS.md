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
  attestation-centric attestation for each address its `@ref` resolves to: a web address as it is,
  a prefixed pointer through the header's `<prefixDef>` (the pattern anchored to the whole of what
  follows the prefix), and `#x` through the one web-address `<idno>` of `<place xml:id="x">` in the
  same file (several: ambiguous, nothing converted). A place name in an `<rdg>`, or in the part of a
  `<choice>` not taken, is a variant (`tei-variant`): one in a part of a `<choice>` waits until the
  `<choice>` closes. Entities declared with their text in the file's own DOCTYPE are given to
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
  like an unrecognised file (`readable()`). `guessColumns` maps each column to one `FIELDS` key, `note` or `skip`
  from its normalised heading and the first 50 rows; `resolveColumns` checks a saved mapping
  instead. The mapping is the same JSON on the page (the column-matching step in `src/app.js`, via
  `columnsOf`/`mappingOf` in `worker.js`, worded in `words.js`: `COLUMN_CHOICES`, `COLUMN_WORDS`,
  `columnWarnings`, which warns of a column named for a gazetteer when no column is the address) and on the command line (printed with each input, taken back with
  `--columns FILE`). An address column makes the rows attestation-centric; otherwise each row is a
  place whose `@id` is minted by `tableIds` from its id under the base address, with the id kept as
  `entityIdentifier`. No id column means no addresses and one `generic-no-ids` warning; a repeated
  id is a `DataError`. An unrecognised column goes to `notes`, never `properties`. The mapping, reasons
  and rows have no prototype, so a column called `__proto__` is kept. A CSV streams through Papa's
  chunk parser (`csvRecords`): the columns and guess read its header and first 50 rows, and the rows
  are read again, never kept. A FeatureCollection streams too, read twice (columns, then rows).
- **Addresses** (`addresses.js`). `placeAddress(value)` returns `{ iri }`, `{ iri, from }` when it
  rewrote a WHG form (`place:<ns>:<id>` or an entity page) to `https://w3id.org/whg/id/place:…`,
  or `{ lost, value }` for a WHG portal address below whg_id 12,345,678 (`whg-portal-record`) or
  one on dev.whgazetteer.org (`whg-staging`). The Recogito, TEI and CSV/GeoJSON readers all pass
  every place address through it.
- **Loss kinds.** Each reader lists its kinds with their severity (`TEI_KINDS` in `tei.js`,
  `GENERIC_KINDS` in `columns.js`: `loss`, `warning` or `error`), and their words are in
  `src/engine/report.js`'s `LOSS_TEXT` under the same `tei-*` and `generic-*` names. The tests
  require a text for every kind.
- **The pipeline hook** (`pipeline.js`, `runChecked`): `tei` goes to `teiSource`, `csv` and
  `geojson` to `genericSource`. TEI is attestation-centric, so it goes through the store like
  annotations; for a table of places `genericProfile` reads the mapping first to decide the profile,
  and so whether the store is needed, and its records are schema-checked like the tables'.

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
  leaves it out, or every such place would read as relabelled.
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
It is a page of its own, `chora.html`, a second entry in `vite.config.js`, so that MapLibre GL JS
and Terra Draw load only there. The page is `src/chora/` (`app.js`; `map.js`, the map, the guard
and drawing; `basemaps.js`; `contributor.js`; `drafts.js`; `handoff.js`, which passes files chosen
on the main page through IndexedDB, taken out of it as soon as Chora's page starts, and not offered
if older than five minutes), and its engine `src/engine/chora/` (`store.js`, `view.js`,
`draw.js`, `save.js`, `geo.js`). It publishes its state on `window.__chora` for tests.

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
  refused. The chosen basemap and pasted ones stay in `localStorage`. A basemap whose style cannot be loaded
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
- **Georeferencing**, for tracing from a georeferenced map, will come from `src/engine/georef/`,
  which belongs to Hermes. Chora uses it and keeps none of its own.

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
  `PermissionError` whose `kind` is `address`, `undecided`, `never`, `reload`, `unprotected`, `moved`
  or `network`, and whose message names the site, never the address (a key may be in it);
  `transformRequest(() => [[cat, subj], …], { onBlocked })` for MapLibre; `needs(el, cat, subj)` for
  the one line; `open({ focus: 'cat:subj' })`; `onBeforeReload(fn, { loses })`, `reloadLosses()` and `reload({ confirmed })` (a part of the page that
  cannot keep something across the reload says so in `loses()`, and the panel then asks first, with
  Cancel: the main page names the files chosen, a run in progress and a review open); `mount({ state })`
  for the header button and the canary; `keepWorkingData()`; and `token`, the World Historical
  Gazetteer token's keeper (`get`, `set`, `forget`, `onChange`, as `src/lib/whg-token.js` had them,
  and `remember(on)`, `remembered()`: kept for the tab unless the user chooses to remember it).
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
  Playwright evaluates a bare expression with `eval()`, which the policy forbids: the browser checks
  give it functions.
- **The shared origin, plainly.** The tools are served on `pelagios.org`, which other Pelagios sites
  share. Everything the tools keep in this browser, permissions, choices, a pasted basemap's address
  and key, the WHG token if remembered, a reviewer's name, the working data (Chora's drafts, its
  last output), can be read and changed by any page of `pelagios.org`, on that computer only. A
  page there could forge a grant; the panel lists whatever is kept, so a forged grant is seen and can
  be withdrawn, and the policy admits only plain sites. The panel says this in words. Moving the
  tools to an origin of their own was considered and not done (2026-10-01).
- **Working data.** "Keep my working data between visits" (on by default,
  `plato-tools.keep-working-data` is `no` when off): off, Chora clears its drawings not saved and its
  last output at the next load (not at a reload for a permission), and the output once saved to disk.
  The dataset's working copy, in Chora's SQLite pool, is cleared at every start anyway (`clearOnInit`).
- **Chora's old consents** (`chora-basemap-consent`, a list of sites) are carried over by the head
  script at load, by the module at its first read, and by the module again when another tab writes
  the old key (the storage event): a provider all of whose sites are listed becomes
  `basemap:<provider>`, every other site `basemap:<site>`, and the old key goes.
- **The command line has no settings: the flag is the consent.** A command that asks another site
  takes `--gazetteer` (`whg` or a service's address) and repeatable `--allow-host`, makes grants for
  that run with `fromFlags`, and asks `check()` before each request; tokens come from the
  environment, never from a file the tools write. No command asks another site yet.
- **Adopting it.** Chora's basemaps use it now. Chora's historical maps (`iiif`, `allmaps`) and
  Krisis's gazetteer lookup (`allowed('gazetteer', 'whg')` before sending; `token` for the token) move
  onto it in their own branches, and Hermes's linked sites (`linked`, per host) when it fetches.

## Limits

- **Private windows** keep the browser's file storage in memory and allow it very little, so large
  files fail there. The page warns when the storage allowance looks too small.
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
  or injected grant cannot reach the policy, and the token is in no list and no error.

The browser checks run every page under its Content Security Policy, and check that with nothing
allowed neither page asks another site; that a permission allowed in the panel, from its "Needs
permission" line, is used after the reload and refused at once when withdrawn; that a page served
without its policy is found unprotected by the canary and asks nothing; and that turning off "Keep
my working data" clears Chora's drawings at the next load.

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

- **The toolbox.** The page opens with one panel per tool (`#toolbox` in `index.html`), and the
  README with a table of them. When a tool lands, update its panel and its row in the same change.
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
