<img src="public/logo/plato-mark.svg" alt="" width="40" align="left">

# PLATO tools

Tools for data about places in the formats of PLATO, the Place Attestation Ontology: check it,
convert it, compare two versions of it, publish it. They run in your browser at
**https://pelagios.org/plato-tools/**, and [from the command line](#from-the-command-line) for many
files at a time.

Your files are never uploaded. Everything happens in the browser tab, at any size your disk can
hold: memory stays roughly constant while the working data lives on disk, in the browser's private
file storage.

**How to use them is in the PLATO guide**:
[Checking, converting and comparing](https://pelagios.org/place-attestation-ontology/guide/tools.html) says what each check looks at, what each format keeps
when converting, and what the version check reports. The rest of the [guide](https://pelagios.org/place-attestation-ontology/guide/) explains PLATO
itself. How the tools work, and how they are tested, is in [DEVELOPERS.md](DEVELOPERS.md).

## The toolbox

<table>
<tr><th width="290">Tool</th><th>What it does</th><th>How to use it</th></tr>
<tr><td nowrap><img src="public/icons/search-check.svg" alt="" width="26" height="26" align="absmiddle">&nbsp;<b>Elenchos</b>: check</td><td>Finds every problem in a file, names it and says where it is</td><td><a href="https://pelagios.org/place-attestation-ontology/guide/tools.html#checking">Checking</a></td></tr>
<tr><td nowrap><img src="public/icons/arrow-right-left.svg" alt="" width="26" height="26" align="absmiddle">&nbsp;<b>Metaphrasis</b>: convert</td><td>Writes a file in another format, and reports what that format cannot hold</td><td><a href="https://pelagios.org/place-attestation-ontology/guide/tools.html#converting">Converting</a></td></tr>
<tr><td nowrap><img src="public/icons/chart-column.svg" alt="" width="26" height="26" align="absmiddle">&nbsp;<b>Arithmos</b>: statistical figures</td><td>Publishes figures from statistical tables as RDF Data Cube, and checks the result</td><td><a href="https://pelagios.org/place-attestation-ontology/guide/statistics.html">Statistical tables</a></td></tr>
<tr><td nowrap><img src="public/icons/history.svg" alt="" width="26" height="26" align="absmiddle">&nbsp;<b>Mneme</b>: version check</td><td>Shows that a new version of a published dataset deleted and changed nothing</td><td><a href="https://pelagios.org/place-attestation-ontology/guide/tools.html#comparing-two-versions">Comparing two versions</a></td></tr>
<tr><td nowrap><img src="public/icons/file-input.svg" alt="" width="26" height="26" align="absmiddle">&nbsp;<b>Hermes</b>: readers</td><td>Brings other formats into PLATO. So far: Recogito's annotations</td><td><a href="https://pelagios.org/place-attestation-ontology/guide/annotations.html">Annotations from Recogito</a></td></tr>
<tr><td nowrap><img src="public/icons/landmark.svg" alt="" width="26" height="26" align="absmiddle">&nbsp;<b>Agora</b>: publish</td><td>Reports what a dataset still needs to be FAIR and writes its deposit files, gives every attestation a permanent address, and makes a website and w3id redirects for it</td><td><a href="https://pelagios.org/place-attestation-ontology/guide/tools.html#publishing-your-dataset">Publishing your dataset</a></td></tr>
</table>

Still to come, each planned in its own issue, with the plan as a whole in
[#1](https://github.com/pelagios/plato-tools/issues/1):

<table>
<tr><th width="290">Tool</th><th>What it will do</th><th>Issue</th></tr>
<tr><td nowrap><img src="public/icons/map-pinned.svg" alt="" width="26" height="26" align="absmiddle">&nbsp;<b>Chora</b>: place on the map</td><td>Point to a place, draw it, or trace it from a georeferenced map</td><td><a href="https://github.com/pelagios/plato-tools/issues/4">#4</a></td></tr>
<tr><td nowrap><img src="public/icons/file-input.svg" alt="" width="26" height="26" align="absmiddle">&nbsp;<b>Hermes</b>: more readers</td><td>TEI, any CSV or GeoJSON, georeferenced Recogito regions</td><td><a href="https://github.com/pelagios/plato-tools/issues/5">#5</a></td></tr>
<tr><td nowrap><img src="public/icons/scale.svg" alt="" width="26" height="26" align="absmiddle">&nbsp;<b>Krisis</b>: match review</td><td>Find a place in other gazetteers, and record each judgement of identity</td><td><a href="https://github.com/pelagios/plato-tools/issues/6">#6</a></td></tr>
</table>

They read and write PLATO's spreadsheet tables, PLATO JSON and JSON Lines, RDF (N-Triples, N-Quads
and Turtle, written as N-Triples) and Linked Places Format v1, and read the W3C Web Annotations that
Recogito exports: [the formats in full](https://pelagios.org/place-attestation-ontology/guide/tools.html#what-it-reads-and-writes).

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
- `--base URL` gives the base for the web addresses of spreadsheet identifiers
  ([web addresses for your identifiers](https://pelagios.org/place-attestation-ontology/guide/tools.html#converting)). `--no-typing` leaves out the
  node types and typed dates that N-Triples output otherwise has. `--cube` adds what Data Cube
  expects of statistical figures.
- **`--work-dir DIR`.** RDF, attestation-centric JSON and comparisons go through a working database
  on disk, as in the browser, so memory stays roughly constant at any size. It is kept in the
  system's temporary directory unless `--work-dir` says otherwise, and removed afterwards. It needs
  room for about one and a half times the uncompressed input. If the temporary directory is held in
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
  and the command line writes it with a warning, for hosting elsewhere. For Pages, give `--only`
  a list of the places to include (the rest are in the site's downloads), or leave out `--turtle`.
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

## Licence

BSD 3-Clause. PLATO itself is CC BY 4.0.

- **Type:** Alegreya and Alegreya Sans, as in the PLATO guide, under the SIL Open Font Licence 1.1
  (`public/fonts/`). They are bundled from the Fontsource packages rather than loaded from Google
  Fonts, so that opening the page makes no request to a third party.
- **Icons:** from [Lucide](https://lucide.dev), under the ISC Licence (`public/icons/`).
- **The logo and the drawing of Plato** are PLATO's (`docs/_static/` in the PLATO repository).
