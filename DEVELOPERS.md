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
- **Text is UTF-8, strictly.** Every text input is decoded by `textStream` (or `decodeUtf8`, for the
  tables' sheets) with a fatal decoder: a byte that is not UTF-8 is a `DataError` naming the file,
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
positions fit, it is a `DataError`, never a wrong position. The fixtures, real Allmaps annotations
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
  romanised form, from attestations that are not denials), one point, country codes and types, and
  the identity relations either dataset states are kept, in memory. A place without an `@id` cannot
  be matched, and is reported as a problem.
- **Scoring** (`names.js`, algorithm `krisis-names 3`). Names are normalised: NFKD, combining marks
  removed, ß æ œ ø ł đ ð þ ı spelt out, lower-cased, everything but letters and digits a space. Two
  names score their Jaro-Winkler similarity (prefix scale 0.1, up to four letters) or, if higher, that
  of their words sorted, so that "Upper Newton" and "Newton Upper" agree. Two places score the best
  pair of their names. The work file's `match_parameters.scoring` says the same, so that a review can
  be read without this file.
- **Names alike only in a word they share** (`distinctive()`, new in `krisis-names 2`). Jaro-Winkler
  rewards a shared beginning, so "Saint Martin" and "Saint Maurice" scored 0.921 and "East Ham" and
  "West Ham" 0.917 on letters alone. Now the words both names have are set aside (a word also counts
  as shared with its abbreviation or contraction: its letters in order in the other, ending alike, and
  beginning alike unless it has two letters, so St and Saint, Mt and Mount, on and upon), and what is
  left of each is compared. If the rest is alike (at least 0.85, `DISTINCT_GATE`, or one letter added,
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
  of the other word. Now two names whose words are all shared, some only as an abbreviation (a
  contraction of at most three letters, two fewer than its word: St, Ste, Mt, Ft, Rd, on for upon; not
  Tel for Tell or Cal for Carl), are scored again with each abbreviation written out in full, and the
  higher score is kept: such pairs score 1. This is the one case where a score is raised; a pair with a
  word not shared is still lowered as above (Saint Martin and St Maurice 0.333).
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
  added ("t s"). A name found so is compared when the two share at least 40% of the trigrams of the one
  with fewer, **or begin with the same three letters and share at least three trigrams** (new in
  `krisis-names 3`: Bruxelles and Brussels, 0.864, share 3 of 9, where 40% asks 4; Jaro-Winkler
  rewards a shared beginning), and when their lengths let them reach the threshold at all
  (`canReach()`: a name of two letters cannot reach 0.85 with one of more than four; names of the same
  number of words are let through, as abbreviations can raise them past what letters and lengths
  bound); a name exactly the same is always compared. So a name is compared with at most 1% of the
  other dataset for each trigram it is looked up by. `e2e/match_scale.mjs [N]` matches two synthetic
  datasets of N places (half the names beginning with a common word, one in ten of the others a planted
  variant) with `plato-tools match` and requires it to finish in time and suggest 97% of the planted
  pairs: on its data, 20,000 with 20,000 took 50.6 s (about 11 million comparisons of names) before,
  and takes about 12 s (2.2 million) now: about a fifth longer than before the keys were spread and
  names beginning alike compared (1.5 million; measured in turn on one busy machine, 11.5 to 15.9 s
  against 9.6 to 13.3 s), suggesting 1,982 of the 2,000 planted pairs (1,978 before). **Of the 18 not suggested, 17 score under the threshold and one is lost by blocking**: 8
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
  before made more than 2%.
- **Filters**, in order, after the threshold (0.85): a pair either dataset already links by an
  identity relation (nested, top-level, or bundled in an attestation not since withdrawn) is not
  suggested, and is counted; so is one either says are different places (a negated identity); a pair
  whose points (the first Point, else the centre of the first bounding box or shape) are further apart
  than the greatest distance (50 km) is dropped and counted; a pair without two points is kept, with
  no distance. Each subject place keeps its best five. A dataset matched with itself suggests each
  pair once.
- **The work file** (`work.js`) is the tools' own, not PLATO: PLATO holds what people say, and a
  suggestion is software's. Its candidate fields are named after `plato:Candidate`'s
  (`candidate_source`, `candidate_candidate`, `similarity_score`, `candidate_status`, …), and a
  candidate describes the place it suggests itself (`other`), so that a suggestion from a gazetteer's
  reconciliation service fits the same record. It records each dataset's files by name, size and
  SHA-256 (streamed, `digest.js`), so a resumed or finished review can say when the files have
  changed. It records where each dataset's title came from (`titleFrom`: `gazetteer`, `given`, or
  `file-name` when the dataset gives none), because the other dataset's title is the source every
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
  (`base-differs`), as their places' addresses are made from it.
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

## Limits

- **Private windows** keep the browser's file storage in memory and allow it very little, so large
  files fail there. The page warns when the storage allowance looks too small.
- **Spreadsheet tables** are read into memory, which suits them: a spreadsheet holds at most about a
  million rows per sheet. The JSON, JSON Lines, LPF and RDF routes stream at any size.
- **A document's header comes first.** `dataSets` or `relationTypes` written after the records are
  reported, not read.
- **Web annotations** give attestations about places the file does not describe, so each place is
  labelled with its address, with a warning.
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
  gazetteer, where "bru" is common, it may not be.
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
- **The guide's Hermes pages** (proposed, not yet published) add two more links:
  `test/fixtures/tei/README.md#the-mapping` and `test/fixtures/generic/README.md#the-mapping`.
