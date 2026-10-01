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
  is one node in RDF, so it is a changed attestation.
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

## Chora, the map

What it does is in the guide:
[Placing on the map](https://pelagios.org/place-attestation-ontology/guide/tools.html#chora).
It is a page of its own, `chora.html`, a second entry in `vite.config.js`, so that MapLibre GL JS,
Terra Draw and Allmaps load only there. The page is `src/chora/` (`app.js`; `map.js`, the map, the
guard and drawing; `basemaps.js`; `consent.js`; `csp-head.js` and `csp.js`, the hard block;
`fetchguard.js` and `overlays.js`, the historical maps; `contributor.js`; `drafts.js`; `handoff.js`,
which passes files chosen
on the main page through IndexedDB, taken out of it as soon as Chora's page starts, and not offered
if older than five minutes), and its engine `src/engine/chora/` (`store.js`, `view.js`,
`draw.js`, `save.js`, `geo.js`, `trace.js`). It publishes its state on `window.__chora` for tests.

- **The worker** is the main page's, with commands of its own, sent one at a time: `chora-load`,
  `chora-search`, `chora-overview` (every place's point, at most 50,000), `chora-place` (one
  place's view) and `chora-save`.
- **The session database.** `chora-load` reads the dataset with `run()` and `options.sink`, so every
  format arrives as place-centric records, and writes each to `/chora.sqlite3` on the origin
  private file system, with a folded label for search and the boxes and points of its current
  geometries, settled at the end of the file, where what is retracted or superseded is known. One
  dataset at a time.
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
  against the places the dataset has, before anything is read or written.
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
  The file a save wrote is offered only while the drawings are those it holds.
- **The basemap** is Natural Earth, served from this site from `public/basemap/`. Every address in
  its `style.json` begins `{base}/`, which the page replaces with the folder's address as text,
  since `URL()` would escape the braces of the glyph template. `node scripts/build-basemap.mjs`
  rebuilds it from pinned commits, refusing any download whose sha256 differs, and records inputs
  and outputs in `sources.json`; on the same pins it reproduces the committed files byte for byte.
  [public/basemap/README.md](public/basemap/README.md) has the rest.
- **The hard block.** The first script in `chora.html`'s `<head>` (`src/chora/csp-head.js`, put
  there inline by `scripts/vite-chora-csp.mjs`, in the dev server and the build alike) writes a
  Content Security Policy in a `<meta>` tag before the page requests anything: `connect-src` and
  `img-src` this site and the sites the user has agreed to (`connect-src` with `blob:` but no `data:`:
nothing on the page fetches one), `worker-src 'self' blob:`,
  `default-src 'self'`, no `unsafe-eval`. CSP Level 3 checks every hop of a redirect, and a worker
  made from a `blob:` takes the page's policy, so it holds for the historical maps' tile workers,
  where no page code can see a request. Only a plain lower-case `http(s)` origin reaches the policy,
  and storage that cannot be read gives the policy of nothing agreed to. MapLibre's own worker is
  started from a `blob:` that imports it (`blobWorkerUrl` in `csp.js`): one started from its own
  address would take its response's policy, which has none. At startup a canary (`canary()` in
  `src/chora/csp.js`) has a `blob:` worker ask for `https://canary.invalid/`; unless the policy
  raises a `securitypolicyviolation` in that worker, historical maps are refused, in words. Measured
  2026-10-01: Chromium 147 and Playwright's Firefox (build 1538) raise it; Playwright's WebKit
  (build 2336) enforces the policy but raises no event anywhere, so maps are refused there (and
  Chora's page does not start in that build: it has no OPFS for SQLite).
- **The policy is written at load.** A policy in a `<meta>` tag cannot be widened while the page
  runs, so a site agreed to is reachable from the next load: Chora reloads once for each set of
  sites agreed to, keeping the files open, the place, the view and what was being added
  (`keepForReload` in `handoff.js`; drafts are on OPFS already). A reload that did not put its sites
  in the policy is not repeated. Playwright's `wait_for_function` must be given a function, not an
  expression: the policy forbids evaluating a string (`as_function` in `e2e/app_test.py`).
- **The privacy guard in code.** MapLibre's `transformRequest` (`map.js`) still refuses any site but
  this one and those of the basemap agreed to, and counts each refusal (`window.__chora.blocked`)
  and names it (`blockedOrigins`): it is what counts, names and explains; the policy is what holds.
- **Consent** (`src/chora/consent.js`): `{origin, kind}` in `localStorage` (`chora-consent`), of
  three kinds, each with its notice ending "It sees nothing of your data": `basemap`, `iiif` (a
  historical map's image server and its manifest's site) and `allmaps` (`annotations.allmaps.org`).
  The basemap consents kept before there were kinds are carried over once. "Forget the sites I
  agreed to" empties the record and reloads: each site is asked about again. The sites agreed to are
  listed beside it, as stored (`renderSites`), and each map's row names its image's site: the policy
  guards against map servers, not against other pages of this site, which can write the same storage.
  A site no policy could name (an underscore in its host, say) is refused in words, never asked about.
  A reload refused (the sites still not in the policy) is said where it was asked for: the maps panel
  for a map. A reload waits for the drafts being written (`draftsWritten` in `drafts.js`). The maps
  kept from last time are asked about together, in one notice, so one reload brings them all back.
- **Other basemaps** (OpenFreeMap, OpenStreetMap, CARTO, or a pasted style or tile address) are
  used only after a notice naming who will see the requests: the site of the basemap's address
  first, then any other its style names (its sources, TileJSON tiles, glyphs and sprites: the page
  fetches the style itself, so these are known before MapLibre asks any of them). Choices and consents stay in
  `localStorage`. A basemap whose style cannot be loaded gives way to Natural Earth, and the page
  says why. A map error goes to the console without the query strings of its addresses, where a key
  may be. CARTO's key is given at build time as `VITE_CARTO_API_KEY`, and without it CARTO
  is shown disabled. It is scoped by referrer to `https://pelagios.org`, so it never works on
  localhost and no test may need it. Vite writes it into the built page, where anyone can read it:
  the scope is its protection. Never commit it (`.gitignore` does not cover `.env` files). It is to
  reach the build from a GitHub Actions variable, which `pages.yml` does not yet pass.
- **The gazetteer lookup** (`src/engine/gazetteer/`), shared with Krisis, speaks the W3C
  reconciliation protocol, one request at a time per lookup, with the token in the `Authorization`
  header only. Every assumption about the World Historical Gazetteer, and whether it is verified,
  is in `whg.js`, so that a correction is made in one place.
- **Historical maps** (`src/chora/overlays.js`, `fetchguard.js`): a IIIF image placed by a IIIF
  Georeference Annotation, drawn by `@allmaps/maplibre` (pinned; loaded only when a map is shown, in
  a chunk of its own). What is pasted (`parseInput`) is followed to a georeference (`resolve`),
  asking about every site a step needs at once, before anything is fetched; a manifest is one step
  and its images the next. With no georeference, Allmaps is asked only on "Look for a georeference"
  (`/images/<id of the image service>`, then `?url=`), and otherwise the Allmaps Editor is linked.
  A georeference of several maps (Allmaps' `/images/<id>` often holds several of one image) is a
  choice (`NeedChoice`): each with its label, date and number of control points, the most recently
  `modified` offered first; the one chosen goes on alone.
  Every document is fetched through the guard: only from a site agreed to and in the policy, with
  no credentials. **Admission** (`admit`): the page fetches the image's `info.json` itself, with
  `redirect: 'error'`, and refuses the map unless the id it gives IS the image the georeference
  names (the renderer builds tile addresses from that id); it then gives the renderer the
  information (`addImageInfos`, so the renderer asks for none) and the annotation, naming the image by
  the id the information gives exactly (the renderer looks it up as written, so `…/grid/` against
  `…/grid` would have it fetch the information again itself), and sets the
  map's transformation from the georeference (`setMapTransformationType`): the renderer takes the
  transformation's type but not a polynomial's order, and would draw an order-2 map at order 1.
  Maps shown are kept in OPFS (`chora-overlays/`) and admitted afresh on the next load; a change of
  basemap puts them back in a new layer without fetching anything.
- **Why tiles cannot be guarded request by request** (the spike of 2026-09-30, @allmaps/maplibre
  1.0.0-beta.44, render beta.84): tiles are fetched in a pool of five `blob:` workers. A `fetchFn`
  cannot be passed to them (a function cannot be cloned: `DataCloneError`, logged only, and no tile
  loads), so the page sees no tile request. A map admitted for site A reached site B two ways: an
  `info.json` whose id is on B (the tiles are built from it: refused at admission), and a tile
  answered with a redirect to B, which the worker follows after admission. Only the policy stops the
  second; a Service Worker also did, but fails open on Shift+Reload, before it is installed and in
  private windows. The renderer reports a tile its worker could not fetch only to the console (a
  `ResourceFetchError` naming the tile; no event), so the page listens there, for its own maps'
  tiles, and says in plain words that part of the map could not be loaded.
- **Attribution**: the manifest's credit and licence (Presentation 3 `requiredStatement` and
  `rights`, 2 `attribution` and `license`), as text only; the manifest's logo, thumbnail,
  rendering, homepage and seeAlso are never used. David Rumsey's manifests carry no licence, so it
  comes from a table by site (`HOSTS`). A non-commercial licence gets one neutral line, and the
  licence is linked in the traced attestation's citation of the map (`source.licence`).
- **Tracing** (`src/engine/chora/trace.js`): a drawing made over a map is traced from the topmost
  map shown whose mask holds it whole, else the topmost holding part of it (with a warning); a
  georeference that cannot place it (a fold) passes to the next. It keeps georef's `toPixels`
  record and its box of image pixels (at least 1 px each way; 32 canvas px of context for a point,
  none for a line or area, put into the region by `withContext` itself, so georef is passed no pad), and must come back through the georeference to within 0.05 of the map's
  pixels there, or it is not kept. Saved, it cites the map (`georefCitation`, the canvas and the box
  as the locator; `cito:citesAsEvidence`) and the georeference (`georefAnnotationCitation`,
  `cito:usesMethodIn`, derived from the map), and its notes are `choraTracingNote` then `georefNote`
  with the date the georeference was fetched (PLATO 3acab8e's pattern). Moved or reshaped, it is
  traced again, or no longer cites the map and says so. The geometry saved is the one drawn.
- **Georeferencing** comes from `src/engine/georef/`, which belongs to Hermes; Chora keeps none of
  its own, except `allmapsTransformationName` in `overlays.js`, a marked stand-in until georef's
  export of that name is merged here.

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
python3 e2e/app_test.py --chora-only      # Chora's checks alone (--maps-only: its historical maps)
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

Chora's historical maps are checked against a real second origin: `e2e/iiif_fixture_server.py`
serves `test/fixtures/chora-iiif/` on two free ports, A (the image server agreed to) and B (never to
be asked), and logs every request it receives. That log is the census: Playwright's request events
also list requests the browser stopped. Allmaps' annotation server is answered by `page.route`.
The checks include a tile answered with a redirect to B (B must get nothing in the whole run while
the honest map on A draws), an `info.json` naming B, and the renderer's own transformation of 25
pixels against `src/engine/georef/`'s, to 1e-7 m, at order 1 and 2, with the renderer's order-1
transformation of the order-2 map as the control.

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
