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
- **The other formats** are in `src/formats/`: `tables.js`, `lpf.js`, `annotations.js`, `cube.js`,
  and `shared.js` for the rules the lossy writers share (denials, the current state, computed
  values, figures, bundled identities).
- **Errors.** A file whose content stops a reader is a `DataError`, thrown by the readers in
  `src/engine/input.js`; `run()` turns it into a problem in the report, marked incomplete. A new
  reader must throw `DataError` for bad input, or a fault in the data will look like a fault in
  the tools, which is the only thing shown as one.

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
  back exactly. `test/roundtrip.test.js` pins this.
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
  IC-14 as a stream, IC-12 by grouping rather than by pairs, and says beside each verdict how many
  things it evaluated; a constraint with nothing to evaluate is not tested, never passed. IC-14
  exempts only a declared absence, a figure with an `obsStatus` and no value, since `obsStatus` is
  a general attribute. On PLATO's example and six planted defects it gives the verdicts of the
  specification's own SPARQL queries, run after its normalisation.

### Web annotations

`src/formats/annotations.js` reads Recogito's exports and says why at each choice. The mapping key
by key, and the fixtures (most of them real exports), are in
[test/fixtures/annotations](test/fixtures/annotations/README.md#the-mapping).

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
  refuses, and the command line writes the site with a warning. DEEP cannot fit whole.
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

## Limits

- **Private windows** keep the browser's file storage in memory and allow it very little, so large
  files fail there. The page warns when the storage allowance looks too small.
- **Spreadsheet tables** are read into memory, which suits them: a spreadsheet holds at most about a
  million rows per sheet. The JSON, JSON Lines, LPF and RDF routes stream at any size.
- **A document's header comes first.** `dataSets` or `relationTypes` written after the records are
  reported, not read.
- **Web annotations** give attestations about places the file does not describe, so each place is
  labelled with its address, with a warning.
- **A long SQLite step cannot be interrupted** from the command line: Ctrl-C takes effect when it
  ends.
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
- the command line gives what the engine gives, with the right exit status.

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
- **Wording** lives in `src/engine/words.js` and `src/engine/report.js`, so that the page and the
  command line say the same thing. British spelling, plain words.
- **The PLATO guide links to this repository** in two places: the README's
  `#from-the-command-line`, and `test/fixtures/annotations/README.md#the-mapping`. Keep those
  headings.
