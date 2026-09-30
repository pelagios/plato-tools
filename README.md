<img src="public/logo/plato-mark.svg" alt="" width="40" align="left">

# PLATO tools

Tools for data about places in the formats of PLATO, the Place Attestation Ontology: check it and
convert it. They run in your browser at
**https://pelagios.org/plato-tools/**, and [from the command line](#from-the-command-line) for many
files at a time.

Your files are never uploaded. Everything happens in the browser tab, at any size your disk can
hold: memory stays roughly constant while the working data lives on disk, in the browser's private
file storage.

**What PLATO is, and how to organise data in it, is in the
[PLATO guide](https://pelagios.org/place-attestation-ontology/guide/).** This README is about the
tools themselves: what they do that the guide does not say, how to run them from a terminal, and
how they are built and tested.

## The toolbox

| | Tool | What it does | How to use it |
|---|---|---|---|
| <img src="public/icons/search-check.svg" alt="" width="18"> | **Elenchos**: check | Finds every problem in a file, names it and says where it is | [Spreadsheets](https://pelagios.org/place-attestation-ontology/guide/spreadsheets/index.html#checking-your-tables), [JSON](https://pelagios.org/place-attestation-ontology/guide/json.html#checking-and-converting), [linked data](https://pelagios.org/place-attestation-ontology/guide/linked-data.html) |
| <img src="public/icons/arrow-right-left.svg" alt="" width="18"> | **Metaphrasis**: convert | Writes a file in another format, and reports what that format cannot hold | The same pages; [what is kept](#what-a-conversion-keeps-and-what-it-reports) |
| <img src="public/icons/chart-column.svg" alt="" width="18"> | **Arithmos**: statistical figures | Publishes figures from statistical tables as RDF Data Cube, and checks the result | [Statistical tables](https://pelagios.org/place-attestation-ontology/guide/statistics.html); [below](#statistical-figures) |
| <img src="public/icons/file-input.svg" alt="" width="18"> | **Hermes**: readers | Brings other formats into PLATO. So far: Recogito's annotations | [Annotations from Recogito](https://pelagios.org/place-attestation-ontology/guide/annotations.html); [below](#web-annotations-recogito) |

Still to come, each planned in its own issue, with the plan as a whole in
[#1](https://github.com/pelagios/plato-tools/issues/1):

| | Tool | What it will do | Issue |
|---|---|---|---|
| <img src="public/icons/history.svg" alt="" width="18"> | **Mneme**: version check | Show that a new version of a published dataset deleted and changed nothing | [#2](https://github.com/pelagios/plato-tools/issues/2) |
| <img src="public/icons/landmark.svg" alt="" width="18"> | **Agora**: publish | A FAIR report, a web page for every place, and permanent addresses | [#3](https://github.com/pelagios/plato-tools/issues/3) |
| <img src="public/icons/map-pinned.svg" alt="" width="18"> | **Chora**: place on the map | Point to a place, draw it, or trace it from a georeferenced map | [#4](https://github.com/pelagios/plato-tools/issues/4) |
| <img src="public/icons/file-input.svg" alt="" width="18"> | **Hermes**: more readers | TEI, any CSV or GeoJSON, georeferenced Recogito regions | [#5](https://github.com/pelagios/plato-tools/issues/5) |
| <img src="public/icons/scale.svg" alt="" width="18"> | **Krisis**: match review | Find a place in other gazetteers, and record each judgement of identity | [#6](https://github.com/pelagios/plato-tools/issues/6) |

## What it reads and writes

| Format | Read | Write |
|---|---|---|
| [PLATO spreadsheet tables](https://pelagios.org/place-attestation-ontology/guide/spreadsheets/index.html): the ten CSV files, a zip of them, or the template workbook (`.xlsx`) | yes | yes (a zip of the ten CSV files) |
| [PLATO JSON](https://pelagios.org/place-attestation-ontology/guide/json.html) document, place-centric or attestation-centric | yes | yes (place-centric) |
| PLATO JSON Lines: a header line, then one place per line | yes | yes |
| [RDF](https://pelagios.org/place-attestation-ontology/guide/linked-data.html): N-Triples, N-Quads, Turtle | yes | N-Triples |
| [Linked Places Format](https://github.com/LinkedPasts/linked-places-format) v1: a FeatureCollection, or one feature per line | yes | yes |
| Linked Places Format v2 | not yet: it is not yet specified | not yet |
| W3C Web Annotations, as Recogito and Recogito Studio export them | yes | no |

Gzipped files are read directly.

**Check** holds a file to PLATO's own definitions: JSON against the JSON Schemas; the tables against
the table definitions, as the reference CSV on the Web implementation does, and against the rules
those definitions cannot state; RDF against the terms the ontology declares. It also finds what no
schema can: a route that is, through its members, a member of itself; an identity match nested
under one place that names another as its subject. A file that stops part-way is reported as a
problem in the file, with what was read before it.

## What a conversion keeps, and what it reports

PLATO JSON and RDF hold everything, and converting between them loses nothing (but see *Numbers*,
below). Linked Places Format and the spreadsheet tables hold less, by design: the guide says
[what the spreadsheets cannot say](https://pelagios.org/place-attestation-ontology/guide/spreadsheets/index.html#what-the-spreadsheets-cannot-say).
Two rules govern what the tools do about that.

**Nothing is dropped silently.** Every key a target format has no place for is reported by name, in
words, including a key PLATO adds after the tools were written. `test/keys.test.js` takes every key
the JSON Schema allows, at every level, from the schema itself, and fails for any that a writer
neither carries nor reports.

**Nothing is written that would mislead.** Where leaving a detail out would change what a statement
says, the whole statement is left out, and reported:

| | PLATO JSON, RDF | Spreadsheet tables | Linked Places Format |
|---|---|---|---|
| A denial: the source says it is *not* so | kept | kept, one thing denied per row | left out |
| A claim the file retracts or replaces | kept, with what withdraws it | left out | left out |
| A value worked out by software, not taken from a source | kept, marked | left out | left out |
| A figure from a statistical table | kept | left out | left out |
| Identity matches an attestation makes together | kept | left out | left out |
| How firmly the source says it (reported, doubted) | kept | kept | the claim is kept, its stance reported as lost |

So a file in LPF or the tables shows the current state of a dataset, and never a withdrawn claim as
current, a denied market as a market, or one figure from a table as a fact about the whole place.

Three things are specific to these tools:

- **The base address.** The places and sources of a set of tables get web addresses under the one
  given for the conversion (`--base`, or the page's "Web address for your identifiers"), else the
  [about sheet](https://pelagios.org/place-attestation-ontology/guide/spreadsheets/first-dataset.html#say-what-the-dataset-is)'s
  `base_uri`, else the stand-in `https://example.org/my-dataset/`. Writing tables, an address
  survives only if reading them back would make the same one; otherwise it is reported.
- **Names where RDF needs addresses.** PLATO's context reads a `contributor` or an `assertedBy` as a
  web address, and the schema allows a name. A name there cannot be written in RDF, and is
  reported as lost whenever the output is RDF or is made through it.
- **Numbers.** JSON-LD writes a number with a fractional part as an `xsd:double` of 16 significant
  digits, and the tools write exactly what `jsonld.js` writes. A number that needs 17 comes back
  one unit in its last place away: a longitude of `106.82041100000001` is read back as
  `106.820411`. Numbers of 16 digits or fewer, and whole numbers below 10²¹, come back exactly.
  `test/roundtrip.test.js` pins this.

## Web annotations (Recogito)

Annotations made with [Recogito](https://recogito.pelagios.org/) or
[Recogito Studio](https://recogitostudio.org/), downloaded as W3C Web Annotations, are read as
attestation-centric PLATO: each link from a passage to a place becomes an attestation about that
place. The guide explains this for the people who made the annotations:
[what each part becomes](https://pelagios.org/place-attestation-ontology/guide/annotations.html#what-each-part-of-an-annotation-becomes),
and [what is left out, and why](https://pelagios.org/place-attestation-ontology/guide/annotations.html#what-is-left-out-and-why).

For developers, the mapping key by key. `src/formats/annotations.js` holds it, and says why at each
choice; the fixtures, most of them real exports, are described in
[test/fixtures/annotations](test/fixtures/annotations/README.md).

| In the annotation | In PLATO | Notes |
|---|---|---|
| The place link: Recogito's `identifying` body (the address in its `value`), Studio's `geotagging` body (the `id` of its GeoJSON Feature), or a W3C `identifying` or `linking` body's `source` | `about` | Only a web address; a gazetteer's own id is reported. One passage linked to several places gives one attestation each |
| The words marked (`TextQuoteSelector` `exact`); for an image, a `transcribing` body | `names[].toponym`, with `formStatus` `plato:Attested` | A transcription beside a quote is a note |
| The annotated document (the target's `source`, and its `label` as the title) | `citations[].source` | Recogito Studio writes its project's id here: kept as the title, with a warning |
| The selectors | `citations[].locator`, in words | "characters 1083 to 1092", "region at x 2948, y 4087, 197 by 173 pixels", "row 2" |
| The link body's `creator` (else the annotation's) | `contributor` | A web address, or a name; an internal user id is reported |
| `created`, `modified` (of the link body, else the annotation) | `created`, `modified` | Recogito v1 writes only `modified` |
| The annotation's `id` | `notes` ("From annotation …") | Never the attestation's `@id`: an annotation can be edited and exported again under the same address. A Studio UUID is written as `urn:uuid:` |
| Comments (`commenting`, `replying`), a place body's `note`, free tags | `notes` | |
| A tag that is the address of a vocabulary concept | `types[]` | |

A place link with no `creator` was made by Recogito's own name recognition and never saved by a
person, so it is left out and reported. A `status` on a body (`VERIFIED`, `UNVERIFIED`,
`NOT_IDENTIFIABLE`) is honoured.

## From the command line

The same engine runs in a terminal, with Node.js 24 or later, and says the same things in the same
words:

```bash
npx github:pelagios/plato-tools check data/*.jsonl tables/             # without installing anything
git clone https://github.com/pelagios/plato-tools && cd plato-tools && npm install
node bin/plato-tools.mjs check my-tables/ places.jsonl.gz export.nt     # or from a clone
node bin/plato-tools.mjs convert --to plato-jsonl --out converted/ export.nt.gz
node bin/plato-tools.mjs check --json data/*.json > report.jsonl        # for scripts
```

| Command | What it does |
|---|---|
| `check INPUT…` | Reports on each input in turn, then gives a total |
| `convert --to TARGET INPUT…` | Also writes each input as `plato-jsonl`, `plato-json`, `ntriples`, `tables`, `lpf-seq` or `lpf`, into `--out` (by default the current directory), named after the input |
| `datacube FILE…` | Checks a Data Cube export against Data Cube's integrity constraints ([below](#statistical-figures)) |

- **Which files make one input.** Each file is one input, except that a directory is one set of
  spreadsheet tables (the CSV files in it), and CSV files named one by one are one set per
  directory, so `a/*.csv b/*.csv` is two sets. A zip of the CSV files, or a workbook, is one set.
- **Exit status:** 0 if no input has problems, 1 if any has, 2 if the command is wrong or an input
  cannot be read or written (a missing file, an unrecognised format, an output that already
  exists). Warnings, and what a conversion cannot carry over, do not count as problems.
- **Outputs are never replaced** unless `--overwrite` is given, and an output left incomplete by a
  file that could not be read to the end is removed.
- `--json` prints one JSON object per input, one per line, then one for the total: the page's
  report, with the input's format, counts, outputs and status. `--brief` prints one line per input.
- `--base URL` gives the base address for spreadsheet tables (above). `--no-typing` leaves out the
  node types and typed dates that N-Triples output otherwise has. `--cube` adds what Data Cube
  expects of statistical figures.
- **`--work-dir DIR`.** RDF and attestation-centric JSON go through a working database
  on disk, as in the browser, so memory stays roughly constant at any size. It is kept in the
  system's temporary directory unless `--work-dir` says otherwise, and removed afterwards. For a
  conversion it needs about one and a half times the uncompressed input: checking DEEP's 25 million
  triples (2.7 GB of N-Triples) took 3.7 GB there, about four minutes, and 830 MB of memory. If the
  temporary directory is held in memory (a `tmpfs`), point `--work-dir` at a real disk.

`plato-tools --help` lists everything, and `plato-tools --version` names the PLATO commit the
checks follow.

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

How PLATO records a figure from a statistical table, and the two commands that turn a document into
standard RDF Data Cube and check it, are in the guide:
[Statistical tables](https://pelagios.org/place-attestation-ontology/guide/statistics.html). What
follows is how the tools carry that design out.

- **PLATO JSON to RDF.** Under `dimensions` and `attributes`, a key that is an IRI becomes a
  predicate on the figure, as in JSON-LD. The graph is exactly the one `jsonld.js` gives.
- **RDF to PLATO JSON.** A statement on a figure that no PLATO key names goes back under
  `attributes` or `dimensions` by this rule, in order: the table's structure, where the graph has
  it (`qb:attribute`, `qb:dimension`); else the property's own type in the graph; else its
  namespace (SDMX's attribute or dimension namespace); else `dimensions`, with a warning naming it.
  Both keys give the same graph, so the round trip is lossless either way. A value whose datatype
  JSON cannot carry (a year typed `xsd:gYear`) keeps its text, and the loss is reported.
- **A structured value** (a property value whose `value` is a JSON object) goes to RDF as
  `plato:value_json`, in canonical form, and comes back as the object. This departs from
  `jsonld.js`, which would make the object a node and drop its keys.
- **`convert --to ntriples --cube`**, and the page's option for N-Triples, adds what Data Cube
  expects and PLATO does not write twice: the types `qb:Observation`, `qb:DataSet` and
  `qb:DataStructureDefinition`; the measure as a direct statement; `sdmx-dimension:refArea`, the
  attestation's place; and `sdmx-dimension:refPeriod`, an `xsd:gYear` or `xsd:date` when the
  attestation's date is one year or one day. A figure dated otherwise is reported, not guessed.
  Reading an export back leaves out only these derived statements.
- **`datacube FILE…`** (`src/lib/datacube.js`) checks integrity constraints IC-1, IC-2, IC-11, IC-12
  and IC-14, reading the export as a stream, and says beside each verdict how many things it
  evaluated. A constraint with nothing to evaluate is reported as not tested, never as passed.
  IC-14 exempts only a declared absence, a figure with an `obsStatus` and no value. On PLATO's
  example and on six planted defects it gives the verdicts of the specification's own SPARQL
  queries, run after its normalisation.

## What it checks against

PLATO's normative files (the ontology, the JSON Schemas, the JSON-LD context and the table
definitions) are vendored from a pinned commit of
[pelagios/place-attestation-ontology](https://github.com/pelagios/place-attestation-ontology),
recorded in `package.json` and `public/plato/VERSION.json`, shown at the foot of the page and by
`--version`. The build checks that the vendored ontology is byte-identical to the pinned commit's.

- `npm run vendor` re-pins to the head of PLATO's main branch. Do this, and run the tests, whenever
  PLATO's schemas, context or table definitions change.
- `node scripts/vendor-plato.mjs --ref NAME` pins to a PLATO branch or commit, for testing a design
  before it reaches main. Such a pin is a draft, and `VERSION.json`, the page footer and
  `--version` all say so, so that it cannot pass for a release.

The JSON Schemas give PLATO's identifiers the format `iri`, so that an address with a non-ASCII
letter is valid as written. The JSON Schema library's formats package does not define `iri`, and
would accept any string at all; `src/lib/formats.js` defines it (an absolute IRI, by RFC 3987), and
the tools refuse to start on any format they do not know rather than leave it unchecked.

## How it works

- **One engine, two front ends.** `src/engine/pipeline.js` composes readers and writers. `src/engine/worker.js` runs it in the
  browser, and `src/node/host.js` in Node for `bin/plato-tools.mjs`. What the tools say about a run
  is worded once, in `src/engine/words.js` and `src/engine/report.js`, for both.
- **The mapping.** `src/lib/context.js` compiles PLATO's JSON-LD context into an explicit mapping
  used in both directions. JSON becomes RDF one record at a time (`src/formats/json2rdf.js`), so
  it streams.
- **The store.** RDF becomes JSON through an on-disk SQLite store (`src/lib/store.js`,
  `src/formats/rdf2json.js`), because an entity's triples can be anywhere in an RDF file. In the
  browser SQLite runs as WebAssembly on the origin private file system, through the pool-based
  VFS, which needs none of the cross-origin isolation headers GitHub Pages cannot send. In Node it
  is a file opened with Node's built-in SQLite (`src/node/sqlite.js`).
- **The other formats** are in `src/formats/`: `tables.js`, `lpf.js`, `annotations.js`, `cube.js`,
  and `shared.js` for the rules the lossy writers share.
- **Errors.** A file whose content stops a reader is a problem in the data, and ends in a report
  like any other. Only a fault in the tools themselves is shown as one.

[spike/](spike/README.md) records how the any-size claim was established, on DEEP's 24.8 million
triples.

## Limits, stated plainly

- **Private windows** keep the browser's file storage in memory and allow it very little, so large
  files fail there. The page warns when the storage allowance looks too small.
- **Spreadsheet tables** are read into memory, which suits them: a spreadsheet holds at most about a
  million rows per sheet. The JSON, JSON Lines, LPF and RDF routes stream at any size.
- **Web annotations** give attestations about places the file does not describe, so each place is
  labelled with its address, with a warning.
- **A document's header comes first.** `dataSets` or `relationTypes` written after the records are
  reported, not read.
- **RDF output is N-Triples only**, and Linked Places Format v2 is refused until it is specified.

## Testing

```bash
npm install
npm test                                  # the engine and the command line, in Node
python3 e2e/app_test.py                   # the page itself, in Playwright's bundled Chromium
python3 e2e/app_test.py --url=https://pelagios.org/plato-tools/   # the deployed page
python3 e2e/app_test.py --prove-it-fails  # every check pointed at a page with no tools: all must fail
node scripts/install-test.mjs             # install the packed tools as npx does, and run the command
```

`npm test` reads PLATO's examples from a checkout of PLATO beside this one, or wherever
`PLATO_REPO` says; it should be at the pinned commit, as it is in CI. The tests check that:

- JSON to RDF gives exactly the graph `jsonld.js` gives, and JSON to RDF to JSON loses nothing, on
  every PLATO example;
- the table validator agrees with the reference CSV on the Web implementation, on good and broken
  tables;
- every key the JSON Schema allows is carried or reported by every writer;
- no writer states what a source denies, a withdrawn claim as current, or a computed value as
  evidence;
- Recogito's exports become the attestations designed for them;
- the command line gives what the engine gives, with the right exit status.

Tests that need the DEEP exports (from
[WorldHistoricalGazetteer/epns](https://github.com/WorldHistoricalGazetteer/epns), in
`../deep/data/export` or wherever `DEEP_EXPORT` says) run when the exports are present and are
skipped, visibly, when not. `e2e/scale_test.py` runs one conversion in the real page at full scale,
sampling memory and disk, and `e2e/verify_jsonl.mjs` and `e2e/verify_nt.mjs` check its output
independently.

## Development

```bash
npm run dev      # local server
npm run build    # static site in dist/; fetches PLATO's files at the pinned commit first
npx vite build   # the same, with the PLATO files already in public/plato/
```

A push to `main` runs the tests, builds the site and publishes it to GitHub Pages
(`.github/workflows/pages.yml`).

The page opens with the toolbox, one panel per tool (`#toolbox` in `index.html`). When a tool
lands, update its panel in the same change, and its row in the table above.

## Licence

BSD 3-Clause. PLATO itself is CC BY 4.0.

- **Type:** Alegreya and Alegreya Sans, as in the PLATO guide, under the SIL Open Font Licence 1.1
  (`public/fonts/`). They are bundled from the Fontsource packages rather than loaded from Google
  Fonts, so that opening the page makes no request to a third party.
- **Icons:** from [Lucide](https://lucide.dev), under the ISC Licence (`public/icons/`).
- **The logo and the drawing of Plato** are PLATO's (`docs/_static/` in the PLATO repository).
