# PLATO tools

Check and convert data about places in the formats of
[PLATO](https://pelagios.org/place-attestation-ontology/guide/), the Place Attestation Ontology,
in your browser: **https://pelagios.org/plato-tools/**

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
PLATO JSON and RDF is not.

## What it checks against

PLATO's normative files (the ontology, the JSON Schemas, the JSON-LD context and the table
definitions) are vendored from a pinned commit of
[pelagios/place-attestation-ontology](https://github.com/pelagios/place-attestation-ontology),
recorded in `package.json` and `public/plato/VERSION.json` and shown at the foot of the page. The
build checks that the vendored ontology is byte-identical to the pinned commit's. `npm run vendor`
re-pins to the current head of PLATO's main branch.

## How it works

`src/lib/context.js` compiles PLATO's JSON-LD context into an explicit mapping used in both
directions. JSON becomes RDF one record at a time (`src/formats/json2rdf.js`); RDF becomes JSON
through an on-disk SQLite store (`src/lib/store.js`, `src/formats/rdf2json.js`), because an entity's
triples can be anywhere in an RDF file. SQLite runs as WebAssembly on the origin private file system,
through the pool-based VFS, which needs none of the cross-origin isolation headers GitHub Pages
cannot send. `src/engine/pipeline.js` composes readers and writers; `src/engine/worker.js` runs it in
the browser, `test/` in Node.

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
npm test                                  # 42 conversion tests in Node, against jsonld.js and PLATO's examples
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
