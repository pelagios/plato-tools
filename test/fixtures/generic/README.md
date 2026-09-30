# Tables of places: CSV and plain GeoJSON fixtures

Test fixtures for reading a table of places that is not PLATO's own, a CSV file or plain GeoJSON
(`src/engine/hermes/columns.js`, `src/engine/hermes/generic.js`; `test/hermes-columns.test.js`,
`test/hermes-generic.test.js`). One is a real export, trimmed; the rest are constructed, and say
so. The constructed ones are not real data: the coordinates are rounded or approximate, the ids and
remarks invented, and the Wikidata addresses are used only as examples of web addresses.

| File | Where it comes from | Licence | What it exercises |
|---|---|---|---|
| `pleiades-places-subset.csv` | The Pleiades places dump, [pleiades-places-latest.csv.gz](https://atlantides.org/downloads/pleiades/dumps/pleiades-places-latest.csv.gz), dated 30 September 2026 (Last-Modified `Wed, 30 Sep 2026 11:08:45 GMT`, sha256 of the download `8ea1008057afb07d3e83a68d63ac489199f4d2f0a5d3cd082533c7c28f24ff43`; the dump has no commit). Five rows (ids 579885, 570536, 295374, 991361, 687917) and the header, every column and value unchanged; the rows re-quoted by Python's csv writer. | Creative Commons Attribution 3.0 ([Pleiades downloads](https://pleiades.stoa.org/downloads)); the authors of each place are in its `authors` and `creators` columns | A real export: `id`, `title`, `reprLat`/`reprLong`, `minDate`/`maxDate` guessed; deep-time and negative years; 21 other columns kept in the notes; types written comma-separated (see below) |
| `odd-headers.csv` | Constructed | As the repository (BSD-3-Clause) | Headings in odd case and punctuation (`Place Name`, `LAT`, `Long`, `Alt. names`, `Feature Type`); a `wikidata` column of web addresses, so the rows are attestations about those addresses; two rows about one address; a source column; a longitude missing, a latitude not a number, a latitude out of range; a row with no address; a row with no name and no address |
| `with-ids.csv` | Constructed | As the repository (BSD-3-Clause) | An id column and no addresses, so the rows are places with addresses made from their ids; a language; start and end years padded (`71` to `0071`); a start date in words; a language that is not a code; a row with no id |
| `no-ids.csv` | Constructed | As the repository (BSD-3-Clause) | No id column: places with no address, and the one warning that says how to give them one |
| `duplicate-ids.csv` | Constructed | As the repository (BSD-3-Clause) | Two rows with the same id, which is refused |
| `plain.geojson` | Constructed | As the repository (BSD-3-Clause) | A FeatureCollection with no LPF markers and no feature ids; properties of every kind (a list of other names, a number, a null); a Point, a LineString, a GeometryCollection (refused) and no geometry; a `bbox` and a foreign member on a feature; a feature with no name; the collection's `name` as the title |
| `feature-ids.geojson` | Constructed | As the repository (BSD-3-Clause) | Feature ids, a word and a number, making the places' addresses; a Polygon; two types in one property |

Tests also build small inputs of their own in the test file: WHG addresses (reconciliation ids,
entity pages, record and staging addresses), a TSV file, rows with too many or too few cells, and
GeoJSON that names a coordinate reference system other than WGS 84.

## The mapping

Which column holds what is guessed from its heading (case, spaces and punctuation do not count)
and from the values in the first 50 rows. The guess is a plain JSON object, `{"column": "field"}`,
which the command line prints and takes back with `--columns FILE`, and which the page will show
as a table to edit. Every column goes to exactly one field, to `note`, or to `skip`.

| Column guessed as | In PLATO | Notes |
|---|---|---|
| `name`, `toponym`, `title`, `label`, `place name` → **name** | The place's `label`, and a name (`toponym`) of the attestation | Without a name, the label is the first other name; a row with neither, and no address, is not carried |
| `alternative names`, `alt names`, `variants`, `aliases`, `names`… → **alternativeNames** | Further names of the attestation | Split on `;` or `\|`; a GeoJSON list is taken item by item |
| `lat`, `latitude`, `y`, `reprLat` → **latitude**; `lon`, `lng`, `long`, `longitude`, `x`, `reprLong` → **longitude** | A geometry exactly as the locations sheet makes one: `reprPoint` and a GeoJSON Point | Guessed only if a value is a number. Missing one of the pair, not a number, or out of range: reported, and the row carried without a location |
| `wkt`, `geowkt` → **wkt** | The geometry's `wkt`, beside the point if there is one | |
| `geometry`, `geom`, `geojson` → **geometry** | The geometry's `geojson` (and `reprPoint` for a point) | In a CSV, GeoJSON written out in the cell; guessed only if the values are. A GeoJSON feature's own geometry is always carried if it is well formed: every position two or three numbers on the earth, a line of two positions or more, each ring of a polygon four or more, closed. Otherwise, and for a GeometryCollection (which PLATO's schema refuses), it is reported, with why, and the rest of the row carried |
| `id`, `identifier`, `place id`; a GeoJSON feature's own `id` → **id** | The place's `@id`, made under the base address as the tables make one from `place_id`, and its `entityIdentifier` | Two rows with one id are refused. No id: no address, and a warning. Never an address from a row number or a name |
| `uri`, `url`, `wikidata`, `pleiades`, `geonames`, `whg`, `gazetteer`… → **address** | The attestation's `about`: the rows become attestation-centric | Only if, of the first 50 rows' values, at least half are web addresses (or WHG's `place:<ns>:<id>`), or at least one is and the heading names a gazetteer or a web address (not `link`); an `id` column at least half of addresses too. The reason gives the count ("49 of its 50 sampled values are web addresses"). When no column is the address, the page and the command line warn of each column whose heading names a gazetteer. WHG's forms are rewritten to its persistent addresses, with a note; record and staging addresses are reported and not carried. A row whose address cannot be used becomes a new place of its own if it has an id |
| `type`, `feature type`, `category`, `class`, `fclass`… → **type** | A type: its `label`, and its `identifier` when the value is a web address | Split on `;` or `\|`, not on commas: Pleiades' `settlement, settlement-modern` stays one label |
| `language`, `lang` → **language** | The name's `language` | Only a language code; with no name, kept in the notes |
| `source`, `citation`, `reference` → **source** | The citation's source (with its `@id` when a web address) | With no source value, the file is cited, with the row as the locator |
| `date`, `period`, `year` → **date**; `start`, `from`, `minDate`… → **start**; `end`, `to`, `maxDate`… → **end** | The timespan's `sourceLabel`, `startEarliest` and `endLatest`, as in the tables | A start or end must be a year (padded to four digits) or an ISO date; otherwise reported |
| anything else → **note** | The attestation's `notes`, as `column: value` | Never `properties`: a property would claim the source said something PLATO defines |
| (chosen) → **skip** | Nothing | Reported once, naming the column |

Two columns with the same heading are each known by the heading and their place, `name (column 3)`,
in the matching and the notes, and the report says so once. A quotation mark never closed, or stray
in a quoted cell, stops the file, naming the line. A property of plain GeoJSON called `toponym`,
`timespans` or `@id` does not make it Linked Places Format: only LPF's context, or features with
`names` that have a toponym, a `when` with `timespans`, or an `@id` of the feature itself do.
