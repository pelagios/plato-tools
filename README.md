<img src="public/logo/plato-mark.svg" alt="" width="40" align="left">

# PLATO tools

Tools for data about places in the formats of PLATO, the Place Attestation Ontology: check it,
convert it, compare two versions of it, publish it. They run in your browser at
**https://pelagios.org/plato-tools/**, and [from the command line](#from-the-command-line) for many
files at a time.

Your files stay on your computer, and nothing is sent to any other site unless you allow it, in the
**Permissions** panel at the top of each page, which also shows what this browser remembers for the
tools and lets you forget it.
Everything happens in the browser tab, with the working data on disk, in the browser's private file
storage. A dataset of a million places has been checked and converted in the page;
[how large a dataset your browser can take](https://pelagios.org/place-attestation-ontology/guide/tools.html#large-datasets),
and what changes [on the command line](#from-the-command-line), which also takes many files at once,
is in the guide.

**How to use them is in the PLATO guide**:
[Checking, converting and comparing](https://pelagios.org/place-attestation-ontology/guide/tools.html) says what each check looks at, what each format keeps
when converting, and what the version check reports. The rest of the [guide](https://pelagios.org/place-attestation-ontology/guide/) explains PLATO
itself. How the tools work, and how they are tested, is in [DEVELOPERS.md](DEVELOPERS.md).

No data to hand? [Download example files](https://pelagios.org/plato-tools/try/plato-tools-try-files.zip)
(zip, 344 KB) to try each tool with, and a README in it saying what each should show. The zip is
also in this repository, in [`public/try/`](public/try/).

## The toolbox

<table>
<tr><th width="290">Tool</th><th>What it does</th><th>How to use it</th></tr>
<tr><td nowrap><img src="public/icons/search-check.svg" alt="" width="26" height="26" align="absmiddle">&nbsp;<b>Elenchos</b>: check</td><td>Finds every problem in a file, names it and says where it is</td><td><a href="https://pelagios.org/place-attestation-ontology/guide/tools.html#checking">Checking</a></td></tr>
<tr><td nowrap><img src="public/icons/arrow-right-left.svg" alt="" width="26" height="26" align="absmiddle">&nbsp;<b>Metaphrasis</b>: convert</td><td>Writes a file in another format, and reports what that format cannot hold</td><td><a href="https://pelagios.org/place-attestation-ontology/guide/tools.html#converting">Converting</a></td></tr>
<tr><td nowrap><img src="public/icons/chart-column.svg" alt="" width="26" height="26" align="absmiddle">&nbsp;<b>Arithmos</b>: statistical figures</td><td>Publishes figures from statistical tables as RDF Data Cube, and checks the result</td><td><a href="https://pelagios.org/place-attestation-ontology/guide/statistics.html">Statistical tables</a></td></tr>
<tr><td nowrap><img src="public/icons/history.svg" alt="" width="26" height="26" align="absmiddle">&nbsp;<b>Mneme</b>: version check</td><td>Shows that a new version of a published dataset deleted and changed nothing</td><td><a href="https://pelagios.org/place-attestation-ontology/guide/tools.html#comparing-two-versions">Comparing two versions</a></td></tr>
<tr><td nowrap><img src="public/icons/scale.svg" alt="" width="26" height="26" align="absmiddle">&nbsp;<b>Krisis</b>: match review</td><td>Suggests the places two datasets share, for you to accept or reject, and records each judgement as a PLATO attestation. It matches two files of your own, or looks places up in the World Historical Gazetteer and other reconciliation services, if you allow it in Permissions</td><td><a href="DEVELOPERS.md#match-review">Match review</a></td></tr>
<tr><td nowrap><img src="public/icons/file-input.svg" alt="" width="26" height="26" align="absmiddle">&nbsp;<b>Hermes</b>: readers</td><td>Brings other formats into PLATO: Recogito's annotations (with the regions marked on a georeferenced map placed as points, when the map's georeference is given), TEI editions, and any CSV or GeoJSON, its columns matched to PLATO</td><td><a href="https://pelagios.org/place-attestation-ontology/guide/annotations.html">Annotations from Recogito</a></td></tr>
<tr><td nowrap><img src="public/icons/landmark.svg" alt="" width="26" height="26" align="absmiddle">&nbsp;<b>Agora</b>: publish</td><td>Reports what a dataset still needs to be FAIR and writes its deposit files, gives every attestation a permanent address, and makes a website and w3id redirects for it</td><td><a href="https://pelagios.org/place-attestation-ontology/guide/tools.html#publishing-your-dataset">Publishing your dataset</a></td></tr>
<tr><td nowrap><img src="public/icons/map-pinned.svg" alt="" width="26" height="26" align="absmiddle">&nbsp;<b>Chora</b>: place on the map</td><td>Shows a dataset's places on a map, and adds a point, line or area drawn there, or traced from a georeferenced historical map (IIIF, Allmaps), by hand or with assistance from its ink, citing the map</td><td><a href="https://pelagios.org/place-attestation-ontology/guide/tools.html#chora">Placing on the map</a></td></tr>
</table>

Still to come, with the plan as a whole in [#1](https://github.com/pelagios/plato-tools/issues/1),
and the issue for each where it has one:

<table>
<tr><th width="290">Tool</th><th>What it will do</th><th>Issue</th></tr>
<tr><td nowrap><img src="public/icons/telescope.svg" alt="" width="26" height="26" align="absmiddle">&nbsp;<b>Peripleo</b>: visualisation</td><td>Peripleo, the Pelagios map viewer, for visualisation: planned</td><td></td></tr>
</table>

They read and write PLATO's spreadsheet tables, PLATO JSON and JSON Lines, RDF (N-Triples, N-Quads
and Turtle, written as N-Triples) and Linked Places Format v1, and read the W3C Web Annotations that
Recogito exports, TEI editions, and any other CSV or GeoJSON of places: [the formats in full](https://pelagios.org/place-attestation-ontology/guide/tools.html#what-it-reads-and-writes).

A TEI edition and a table of places have **reading options**, each off until chosen: on the page in
*Reading options*, below the column table, and on the command line as flags (below).

| Format | Reading option | Page | Command line |
|---|---|---|---|
| TEI | Read the `<listPlace>`: each `<place>` with a web address as an attestation, its first name the edition's headword, with its coordinates where the address is on the edition's own site | Read the list of places | `--list-places` |
| TEI | Make a place's address from its `@key` (with no ref), with a pattern for the key's prefix: `tgn,7011179` with `http://vocab.getty.edu/tgn/{id}` | A row for each prefix found, its suggested pattern filled in, unticked until you tick *Use* | `--key-pattern [PREFIX=]PATTERN`, repeatable; no prefix for keys with none |
| TEI | Places in the header (where the object was found or made), and place names in an edition's commentary, translation and notes, as the editors' words, each with the form status `plato:Editorial` | Read the places in the header (found at, made at), as the editors' words; Read place names in the commentary and notes, as the editors' words | `--header-places`, `--commentary-places` |
| CSV, GeoJSON | Rows with the same id are evidence about one place, an attestation each, where a repeated id is otherwise a problem; needs a column read as the place id | Rows with the same id are one place | `--same-id` |
| CSV, GeoJSON | A column of a gazetteer's ids (`pleiades_id: 579885`) made into web addresses with a pattern, suggested for Pleiades, GeoNames and Wikidata, never used until confirmed | In the column table, *Make web addresses* in the column's row | `--columns` with `{"field": "address", "pattern": "https://pleiades.stoa.org/places/{id}"}` for the column |

## From the command line

The same engine runs in a terminal, with Node.js 24 or later, and says the same things in the same
words:

```bash
npx github:pelagios/plato-tools check data/*.jsonl tables/             # without installing anything
git clone https://github.com/pelagios/plato-tools && cd plato-tools && npm install
node bin/plato-tools.mjs check my-tables/ places.jsonl.gz export.nt     # or from a clone
node bin/plato-tools.mjs convert --to plato-jsonl --out converted/ export.nt.gz
node bin/plato-tools.mjs check --json data/*.json > report.jsonl        # for scripts
node bin/plato-tools.mjs compare release-1.jsonl.gz release-2.jsonl.gz  # was anything deleted or changed?
```

| Command | What it does |
|---|---|
| `check INPUT…` | Reports on each input in turn, then gives a total |
| `convert --to TARGET INPUT…` | Also writes each input as `plato-jsonl`, `plato-json`, `ntriples`, `tables`, `lpf-seq` or `lpf`, into `--out` (by default the current directory), named after the input |
| `compare EARLIER LATER` | Checks that a published dataset was only added to ([what it reports](https://pelagios.org/place-attestation-ontology/guide/tools.html#comparing-two-versions)) |
| `publish PART INPUT` | Prepares a dataset for publishing: `report`, `mint`, `site` or `w3id` ([below](#publishing)) |
| `datacube FILE…` | Checks a Data Cube export against Data Cube's integrity constraints ([Statistical tables](https://pelagios.org/place-attestation-ontology/guide/statistics.html#checking-and-standard-data-cube)) |

- **Which files make one input.** Each file is one input, except that the sheets of a set of
  spreadsheet tables (`places.csv`, `names.csv`…) are one input per directory, whether the directory
  is given or its CSV files are named one by one, so `a/*.csv b/*.csv` is two sets. Any other CSV
  file in the directory, or named, is an input of its own, and so is a lone sheet whose header does
  not begin as that sheet's does (a `places.csv` of one's own). A zip of the CSV files, or a workbook, is one set.
- **Exit status:** 0 if no input has problems, 1 if any has, 2 if the command is wrong or an input
  cannot be read or written (a missing file, an unrecognised format, an output that already
  exists). Warnings, and what a conversion cannot carry over, do not count as problems. For
  `compare`: 0 if nothing was deleted or changed, 1 if something was, 2 if the two versions could
  not be compared, including when either cannot be read to the end.
- **Outputs are never replaced** unless `--overwrite` is given, and an output left incomplete, by a
  file that could not be read to the end or by identity relations that could not be held back for a
  PLATO JSON document, is removed.
- `--json` prints one JSON object per input, one per line, then one for the total: the page's
  report, with the input's format, counts, outputs and status. Its `storeBytes` is the size of the
  working database (the triple store) for RDF or attestation-centric input, or the tables' for
  spreadsheet tables, or null when the input streamed straight through. For a table of places its `columns` is a list of
  `{column, field, pattern, reason}` (`pattern` only for a column given one), to read; `--columns`
  takes the object printed without `--json` instead. For a TEI edition, `keyPatterns` holds the
  `--key-pattern` patterns. `--brief` prints one line per input.
- **Reading options** (the table above) are for `check` and `convert`. One that applies to none of
  the inputs (`--list-places` with no TEI edition among them), or `--same-id` for a table with no
  id column, is a mistake in the command: exit 2, with the reason, and nothing is read.
- `--base URL` gives the base for the web addresses of spreadsheet identifiers
  ([web addresses for your identifiers](https://pelagios.org/place-attestation-ontology/guide/tools.html#converting)). `--no-typing` leaves out the
  node types and typed dates that N-Triples output otherwise has. `--cube` adds what Data Cube
  expects of statistical figures.
- **`--georef FILE`** and **`--manifest FILE`** (each repeatable), for a Recogito export: the IIIF
  Georeference Annotation of a map its regions are drawn on (from Allmaps), and the map's IIIF
  manifest if you have it. Each region inside the map becomes a point, citing the map and the
  georeference ([the mapping](test/fixtures/annotations/README.md#the-mapping)). On the page, choose
  the files together. Nothing is fetched.
- **`--work-dir DIR`.** RDF, attestation-centric JSON, spreadsheet tables and comparisons go through
  a working database on disk, as in the browser, so memory stays roughly constant as the input grows. It is
  kept in the system's temporary directory unless `--work-dir` says otherwise, and removed
  afterwards. It needs room for about one and a half times the uncompressed input (twice the text,
  for spreadsheet tables). If the temporary directory is held in
  memory (a `tmpfs`), point `--work-dir` at a real disk.

### Publishing

`publish` (Agora) takes a checked dataset one step at a time towards being cited and found: each
part reads it through the same check, and writes nothing from a dataset with problems. What each
part reports, and the order to take them in, is in the guide:
[Publishing your dataset](https://pelagios.org/place-attestation-ontology/guide/tools.html#publishing-your-dataset).

```bash
node bin/plato-tools.mjs publish report --out deposit/ my-tables/          # what it lacks to be FAIR; .zenodo.json, CITATION.cff, datacite.json
node bin/plato-tools.mjs publish mint --out . my-tables/                   # my-tables-with-ids.jsonl: an @id for every attestation
node bin/plato-tools.mjs publish mint --previous release-1.jsonl --out . my-tables/   # keeping the addresses release 1 published
node bin/plato-tools.mjs publish site --repo owner/name --out build/ my-tables-with-ids.jsonl   # a page and a JSON-LD file for every place
node bin/plato-tools.mjs publish w3id --repo owner/name --maintainer you --out . my-tables-with-ids.jsonl   # the w3id.org folder, with its tests
```

- **Mint once, and commit the result.** The site is made only from a dataset whose attestations
  have addresses, and never makes them itself; the workflow `site` writes for GitHub Actions builds
  the site from the committed copy, so CI never mints.
- **On the command line** a site or a w3id folder is written as a folder; in the browser, as a zip.
  The site's size is estimated first against GitHub Pages' 1 GB: the page refuses a site over it,
  and the command line writes it with a warning, for hosting elsewhere. For Pages, give a list of
  the places to include, a text file of their keys one to a line (`--only`, or on the page *Only
  these places* in Options; the rest are in the site's downloads), or leave out `--turtle`.
- The w3id folder is for a base address on `w3id.org` and a dataset whose `status` is `published`;
  its `STEPS.md` says how to test the rules and open the pull request.
- `--overwrite` replaces a whole output folder (such as `<stem>-site`), not single files in it.

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

## Development

```bash
npm install
npm test                                  # the engine and the command line, in Node
python3 e2e/app_test.py                   # the page itself, in a headless browser
npm run dev                               # a local server
```

[DEVELOPERS.md](DEVELOPERS.md) has the rest: how the tools are built, how they are pinned to PLATO,
every test and what it proves, and the conventions to keep.

## Acknowledgements

Development has been supported by the
[Institute for Spatial History Innovation (ISHI)](https://www.ishi.pitt.edu/) at the University of
Pittsburgh.

## Licence

BSD 3-Clause. PLATO itself is CC BY 4.0.

- **Type:** Alegreya and Alegreya Sans, as in the PLATO guide, under the SIL Open Font Licence 1.1
  (`public/fonts/`). They are bundled from the Fontsource packages rather than loaded from Google
  Fonts, so that opening the page makes no request to a third party.
- **Icons:** from [Lucide](https://lucide.dev), under the ISC Licence (`public/icons/`).
- **The logo and the drawing of Plato** are PLATO's (`docs/_static/` in the PLATO repository).
