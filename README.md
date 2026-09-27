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
| PLATO spreadsheet tables: the eight CSV files, a zip of them, or the template workbook (`.xlsx`) | yes | yes (a zip of the eight CSV files) |
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

A **denial**, where a source states that something is not so (PLATO's `negated`, the tables'
`denied`: no market here), is never written as an assertion. PLATO JSON, RDF and the spreadsheet
tables carry it. Linked Places Format cannot, so a denied attestation is left out of LPF and
reported; so is a denial of several things at once in the tables, whose rows deny one thing each.

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
  which identifiers from spreadsheet tables are made (`https://example.org/my-dataset/`), and
  `--no-typing` to leave out the node types and typed dates N-Triples output otherwise has.
- RDF and attestation-centric JSON go through a working database on disk, as in the browser, so
  memory stays roughly constant at any size. It is kept in the system's temporary directory, or in
  `--work-dir DIR`, and removed afterwards. It needs room for about one and a half times the
  uncompressed input: checking DEEP's 25 million triples (2.7 GB of N-Triples) took 3.7 GB there at
  most, about four minutes, and 830 MB of memory. If the temporary directory is held in memory (a
  `tmpfs`), point `--work-dir` at a real disk.

`plato-tools --help` lists everything.

## What it checks against

PLATO's normative files (the ontology, the JSON Schemas, the JSON-LD context and the table
definitions) are vendored from a pinned commit of
[pelagios/place-attestation-ontology](https://github.com/pelagios/place-attestation-ontology),
recorded in `package.json` and `public/plato/VERSION.json` and shown at the foot of the page. The
build checks that the vendored ontology is byte-identical to the pinned commit's. `npm run vendor`
re-pins to the current head of PLATO's main branch.

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
