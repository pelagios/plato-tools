# PLATO tools

Check and convert data about places in the formats of
[PLATO](https://pelagios.org/place-attestation-ontology/guide/), the Place Attestation Ontology,
in your browser: **https://pelagios.org/plato-tools/**, or [from the command line](#from-the-command-line),
many files at a time.

Everything happens in the browser tab. Your files are never uploaded, and the tools handle
datasets of any size your disk can hold: memory stays roughly constant while the working data
lives on disk, in the browser's private file storage.

## What it reads and writes

| Format | Read | Write |
|---|---|---|
| PLATO spreadsheet tables: the ten CSV files, a zip of them, or the template workbook (`.xlsx`) | yes | yes (a zip of the ten CSV files) |
| PLATO JSON document, place-centric or attestation-centric | yes | yes (place-centric) |
| PLATO JSON Lines: a header line, then one place per line (the DEEP export's form) | yes | yes |
| RDF: N-Triples, N-Quads, Turtle | yes | N-Triples |
| Linked Places Format v1: FeatureCollection, or one feature per line | yes | yes |
| Linked Places Format v2 | not yet: it is not yet specified | not yet |

Gzipped files are read directly. **Check** validates a file against PLATO: its JSON Schemas, its
spreadsheet table definitions, or, for RDF, the terms the ontology declares. **Convert** writes any
of the formats above, and reports everything the target format cannot hold instead of dropping it
silently: converting to LPF or to the spreadsheet tables is lossy by design, converting between
PLATO JSON and RDF is not, except at the last digit of some numbers (below).

**Nothing is dropped silently.** Each writer names the keys of each PLATO object it holds; every
other key present is reported by name, in words ("The pronunciation of a name in the International
Phonetic Alphabet (ipa): Linked Places Format has no place for this, so it is left out."), including
a key PLATO adds after the tools were written. `test/keys.test.js` enumerates every key the JSON
Schema allows, at every level, from the schema itself, and fails for any key that a writer (LPF,
LPF sequence, the tables, N-Triples, or PLATO JSON made from RDF) neither carries nor reports.

- **LPF** carries the gazetteer's address, title, licence (`license`) and description
  (`descriptions`, as on a feature) as the FeatureCollection's own members, which its context maps,
  and reads them back; it has no term for the gazetteer's contributor, nor for its dataset
  description (`creator`, `keywords`, `spatial`, `temporal`, `landingPage`, `uriSpace`), each of
  which is reported. It also carries a location's `bbox` (a GeoJSON member) and a dated timespan's
  PeriodO period.
- **The spreadsheet tables** describe the gazetteer in the `about` sheet, one row: its address
  (`dataset_uri`), title, description, contributor, authors (`creator` for web addresses,
  `creator_name` for names), licence, version, status, keywords, area (`spatial`), years
  (`temporal_from`, `temporal_to`), landing page and `base_uri` (`uriSpace`). An author given with
  both an address and a name keeps the address, and the name is reported; `isVersionOf` and
  `previousVersion` have no column and are reported. The tables check that the sheet has exactly one
  row, that a published dataset states its licence, and warn of a draft without one and of a
  missing `base_uri`. A place's or source's web address survives only when it is the one reading
  the tables back would make from the base address and its id; otherwise it is reported.
- **The base address** for the places and sources of a set of tables is the one given for the
  conversion (`--base`, or the page's "Web address for your identifiers"), else the about sheet's
  `base_uri`, else the stand-in `https://example.org/my-dataset/`. A base given that differs from
  `base_uri` is used, with a warning.
- **RDF.** A value that PLATO's context reads as a web address but that is a name (the gazetteer's
  `contributor`, an identity match's `assertedBy`, which the schema allows as names) cannot be written
  in RDF, and is reported as lost whenever the output is RDF or is made through it.
- **Attestation-centric documents** that list `newSpatialEntities` have every place written, not
  only the listed ones: an attestation about an existing place was once left out of every output.

A **denial**, where a source states that something is not so (PLATO's `negated`, the tables'
`denied`: no market here), is never written as an assertion. PLATO JSON, RDF and the spreadsheet
tables carry it. Linked Places Format cannot, so a denied attestation is left out of LPF and
reported; so is a denial of several things at once in the tables, whose rows deny one thing each.

**The current state.** A published gazetteer never deletes a claim: a later attestation withdraws
it (`plato:Retracts`) or replaces it (`plato:Supersedes`). PLATO JSON and RDF keep both, so that an
earlier state can be recomputed. Linked Places Format and the spreadsheet tables cannot express
either, so they show the current state: every attestation that the file retracts or supersedes,
wherever in the file that is said, is left out and reported. A withdrawn claim is never written as
current. A gazetteer's `version`, `status`, `isVersionOf` and `previousVersion` go to RDF and back;
LPF defines no place for them, so there they are reported as lost, and the tables hold `version` and
`status` in the about sheet and report the other two.

**Numbers in RDF.** JSON-LD writes a number with a fractional part as a canonical `xsd:double` of
16 significant digits, and these tools write exactly what `jsonld.js` writes. A JavaScript number
can need 17 digits to be told apart from its neighbour, and such a number comes back from RDF one
unit in its last place away: a longitude of `106.82041100000001` becomes
`"1.06820411E2"^^xsd:double` and is read back as `106.820411`. Numbers of 16 significant digits or
fewer, and whole numbers below 10²¹, come back exactly. `test/roundtrip.test.js` pins this behaviour.

## From the command line

The same checks and conversions run in a terminal, with Node.js 24 or later, using the same engine
as the page and saying the same things:

```bash
npx github:pelagios/plato-tools check data/*.jsonl tables/           # without installing anything
git clone https://github.com/pelagios/plato-tools && cd plato-tools && npm install
node bin/plato-tools.mjs check my-tables/ places.jsonl.gz export.nt    # or from a clone
node bin/plato-tools.mjs convert --to plato-jsonl --out converted/ export.nt.gz
node bin/plato-tools.mjs check --json data/*.json > report.jsonl        # for scripts
```

- `check INPUT…` reports on each input in turn, then gives a total. `convert --to TARGET INPUT…`
  also writes each input in the target format (`plato-jsonl`, `plato-json`, `ntriples`, `tables`,
  `lpf-seq` or `lpf`) into `--out` (the current directory by default), named after the input. It
  never replaces an existing file unless given `--overwrite`, and it removes an output left
  incomplete by a file that could not be read to the end.
- **Which files make one input.** Each file is one input, except that a directory is one set of
  spreadsheet tables (the CSV files in it), and CSV files named one by one are one set of tables per
  directory, so `a/*.csv b/*.csv` is two sets. A zip of the CSV files, or a workbook, is one set.
- **Exit status:** 0 if no input has problems, 1 if any has, 2 if the command is wrong or an input
  cannot be read or written (a missing file, an unrecognised format, an output that already exists).
  Warnings, and what a conversion cannot carry over, do not count as problems.
- `--json` prints one JSON object per input, one per line (the page's report, with the input's
  format, counts, outputs and status), then one for the total. `--brief` prints one line per input.
- The page's options are flags with the page's defaults: `--base URL` for the web address under
  which identifiers from spreadsheet tables are made (by default the about sheet's `base_uri`, else
  `https://example.org/my-dataset/`), and
  `--no-typing` to leave out the node types and typed dates N-Triples output otherwise has.
- RDF and attestation-centric JSON go through a working database on disk, as in the browser, so
  memory stays roughly constant at any size. It is kept in the system's temporary directory, or in
  `--work-dir DIR`, and removed afterwards. It needs room for about one and a half times the
  uncompressed input: checking DEEP's 25 million triples (2.7 GB of N-Triples) took 3.7 GB there at
  most, about four minutes, and 830 MB of memory. If the temporary directory is held in memory (a
  `tmpfs`), point `--work-dir` at a real disk.

`plato-tools --help` lists everything.

**Results that must be citable.** `npx github:pelagios/plato-tools` runs whatever the branch holds
when it is fetched (npx may also reuse a copy it has cached), and npm does not use a git
dependency's lockfile, so its dependencies can differ from those the tools were tested with. For a
result someone must be able to reproduce, run a named ref from a clone, with that ref's own
lockfile, and record the two commits:

```bash
REF=main                                   # a branch or tag; a clone of a ref that does not exist fails
git clone --depth 1 --branch "$REF" https://github.com/pelagios/plato-tools "plato-tools-$REF"
cd "plato-tools-$REF" && npm ci            # exactly the dependencies in the ref's package-lock.json
git rev-parse HEAD                         # the tools' commit
node bin/plato-tools.mjs --version         # and the PLATO commit they check against
node bin/plato-tools.mjs check my-data.json
```

For a single commit rather than a branch or tag, replace the clone with
`git init plato-tools-C && cd plato-tools-C && git fetch --depth 1 https://github.com/pelagios/plato-tools C && git checkout FETCH_HEAD`,
which also fails if the commit does not exist, then run `npm ci` as above.

## Statistical figures

PLATO records a figure from a statistical table (a census count, an amount in a return) as a
property value that is also an RDF Data Cube observation: `dataSet` names its table, and
`dimensions` and `attributes` hold its coordinates and the facts about it, each keyed by the IRI
of a dimension or attribute property. PLATO's guide explains the design in
[Statistical tables](https://pelagios.org/place-attestation-ontology/guide/statistics.html)
([issue #14](https://github.com/pelagios/place-attestation-ontology/issues/14)).

- **PLATO JSON to RDF.** A key that is an IRI becomes a predicate on the figure, as in JSON-LD: an
  `{"@id": …}` value an IRI, anything else a literal. The graph is exactly the one `jsonld.js`
  gives. The header's `dataSets` (tables, their scope and structure) go to RDF too.
- **RDF to PLATO JSON.** A statement on a figure that no PLATO key names goes back under
  `attributes` or `dimensions`, by this rule, in order: the table's structure, where the graph has
  it (`qb:attribute`, `qb:dimension`); else the property's own type in the graph
  (`qb:AttributeProperty`, `qb:DimensionProperty`); else its namespace (SDMX's attribute namespace,
  where `obsStatus` is, or its dimension namespace); else `dimensions`, with a warning naming it.
  Both keys give the same graph, so the round trip is lossless either way. A structure that lists
  its components comes back listed; one given by address alone, as an address. A value whose
  datatype JSON cannot carry (a year typed `xsd:gYear`) keeps its text, and the loss is reported.
- **`convert --to ntriples --cube`** (and the page's option for N-Triples) adds what Data Cube
  expects and PLATO does not write: `rdf:type qb:Observation`, `qb:DataSet` and
  `qb:DataStructureDefinition`; the measure as a direct statement, `figure <property> <value>`,
  except for a figure with no value whose `obsStatus` says why (a printed dash); `sdmx-dimension:refArea`,
  the attestation's place; and `sdmx-dimension:refPeriod`, an `xsd:gYear` when the timespan's earliest
  start and latest end fall in one year, an `xsd:date` when on one day. A figure whose date is neither
  is reported as not placeable on the time axis, and is not guessed. Without `--cube` the output is
  the plain PLATO graph. Reading an export back leaves out only its own derived statements.
- **Checks.** A property value needs a value unless its attributes give `sdmx-attribute:obsStatus`.
  `dataSets` written after the records are reported, since the header is read first.
- **LPF and the tables** leave a figure out, and report it: without its coordinates it would be
  stated of the place as a whole.

`plato-tools datacube FILE…` (`src/lib/datacube.js`) checks Data Cube's integrity constraints IC-1,
IC-2, IC-11, IC-12 and IC-14 on the export, reading it as a stream so that a file of any size can be
checked, and gives beside each verdict how many things it evaluated. IC-12 is checked by grouping,
in linear time, rather than by pairs. IC-14 exempts a declared absence, which is a figure with an
`obsStatus` and no value: a status alone is not enough, since `obsStatus` is a general attribute
("approximate" is not an absence), and a figure with a value must have its measure whatever its
status. A constraint with nothing to evaluate is reported as not tested, never as passed. On
PLATO's example and on six planted defects it gives the same verdicts as the specification's own
SPARQL queries run after its normalisation, and PLATO's example passes all five.

## What it checks against

PLATO's normative files (the ontology, the JSON Schemas, the JSON-LD context and the table
definitions) are vendored from a pinned commit of
[pelagios/place-attestation-ontology](https://github.com/pelagios/place-attestation-ontology),
recorded in `package.json` and `public/plato/VERSION.json` and shown at the foot of the page. The
build checks that the vendored ontology is byte-identical to the pinned commit's. `npm run vendor`
re-pins to the current head of PLATO's main branch. `node scripts/vendor-plato.mjs --ref NAME` pins
to a PLATO branch or commit instead, for testing a design before it reaches main: such a pin is a
draft, and `VERSION.json`, the page footer and `--version` all say so, so that it cannot pass for a
release.

The JSON Schemas give PLATO's identifiers the format `iri`, so that an address with a non-ASCII
letter (`#André-1980`) is valid as written. The JSON Schema library's formats package does not
define `iri`, and would ignore it, accepting any string at all; `src/lib/formats.js` defines it
(an absolute IRI, by RFC 3987), and the tools refuse to start on any format they do not know
rather than leave it unchecked.

## How it works

`src/lib/context.js` compiles PLATO's JSON-LD context into an explicit mapping used in both
directions. JSON becomes RDF one record at a time (`src/formats/json2rdf.js`); RDF becomes JSON
through an on-disk SQLite store (`src/lib/store.js`, `src/formats/rdf2json.js`), because an entity's
triples can be anywhere in an RDF file. SQLite runs as WebAssembly on the origin private file system,
through the pool-based VFS, which needs none of the cross-origin isolation headers GitHub Pages
cannot send. `src/engine/pipeline.js` composes readers and writers; `src/engine/worker.js` runs it in
the browser, and `src/node/host.js` runs it in Node for the command line (`bin/plato-tools.mjs`),
where the store is a file on disk opened with Node's built-in SQLite (`src/node/sqlite.js`, which
gives it the few calls the store makes of SQLite in the browser). What the tools say about a run is
worded once, in `src/engine/words.js`, for both.

## Limits, stated plainly

- **Private windows** keep the browser's file storage in memory and allow it very little, so large
  files fail there. The page warns when the storage allowance looks too small.
- **Spreadsheet tables** are read into memory, which suits them: a spreadsheet holds at most about a
  million rows per sheet. The JSON, JSON Lines, LPF and RDF routes stream at any size.
- **Identity relations listed at the end of a JSON Lines file** (as DEEP does) are gathered in a
  first pass when writing LPF, so that each feature carries its links.

## Testing

```bash
npm install
npm test                                  # conversion and command-line tests in Node, against jsonld.js and PLATO's examples
python3 e2e/app_test.py                   # the page itself, in Playwright's bundled Chromium
python3 e2e/app_test.py --prove-it-fails  # every check pointed at a page with no tools: all must fail
node scripts/install-test.mjs             # install the packed tools as npx does, and run the command
python3 e2e/scale_test.py --input deep-plato.nt.gz --target plato-jsonl --out out.jsonl
node e2e/verify_jsonl.mjs out.jsonl 539372 13032 deep-plato.jsonl.gz <entity IRIs…>
```

The Node tests check that JSON to RDF gives exactly the graph `jsonld.js` gives, that JSON to RDF to
JSON loses nothing (on every PLATO example and on a sample of DEEP), that the table validator agrees
with the reference CSVW implementation on good and broken tables, and that LPF round-trips. Tests
that need the DEEP exports (from [WorldHistoricalGazetteer/epns](https://github.com/WorldHistoricalGazetteer/epns))
run when they are present and are skipped, visibly, when not. [spike/](spike/README.md) records how
the any-size claim was established on DEEP's 24.8 million triples.

## Development

```bash
npm run dev      # local server
npm run build    # static site in dist/ (vendors PLATO's files first)
```

## Licence

BSD 3-Clause. PLATO itself is CC BY 4.0.

The page is set in the PLATO guide's type, Alegreya and Alegreya Sans, under the SIL Open Font
Licence 1.1 (the licences are in `public/fonts/` and served beside the page). The fonts are
bundled from the Fontsource packages rather than loaded from Google Fonts, so that opening the
page makes no request to a third party. The drawing of Plato in the header is the guide's
(`docs/_static/plato-thinking.png` in the PLATO repository), reduced.
