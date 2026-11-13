# Files to try the PLATO tools with

Drop these into the tools at <https://pelagios.org/plato-tools/> (Check, Convert, Compare,
Publish, Match; Chora, the map, is "Show on the map" on the same page, at
<https://pelagios.org/plato-tools/#chora>). Each result below was
checked with the command-line version of the same tools (`plato-tools`) on 13 November 2026
(the problems in `2-problems`, again after the streaming spreadsheet reader landed).

The examples come from PLATO (place-attestation-ontology) and the plato-tools test fixtures; the
files made for this set are said to be made. Nothing here is real data unless it says where it is from.

## 1-check-and-convert

Drop any of them, then **Check**, or choose a format under **Convert to** and **Convert**.

| File | What it is | Expect |
|---|---|---|
| `king-john.json` | PLATO JSON, place-centric (King John's itinerary, 1215) | No problems; 19 places, 47 attestations |
| `king-john.jsonl` | the same, as JSON Lines | the same |
| `king-john.jsonl.gz` | the same, gzipped | the same |
| `king-john.nt` | the same, as N-Triples | the same; 1,001 triples |
| `king-john-itinerary.ttl` | PLATO's Turtle example (part of the itinerary) | No problems; 5 places, 7 attestations |
| `judgements.json` | PLATO JSON, place-centric, with identity judgements | No problems; 6 places, 10 attestations |
| `constantinople.json` | PLATO JSON, place-centric, one place | No problems; 1 place, 3 attestations |
| `customs-attestations.json` | PLATO JSON, attestation-centric | No problems; 2 places, 2 attestations; warning: 2 places have no label |
| `customs-tables/` | PLATO spreadsheet tables, ten CSV files: drop all ten together | No problems; 2 places, 4 attestations |
| `customs-tables.zip` | the same ten CSV files in a zip | the same |
| `lpf-example.json` | Linked Places Format (the LPF README's example) | No problems; 1 place, 15 attestations |
| `lpf-sample.geojson` | Linked Places Format (WHG's v1.2.2 sample) | No problems; 1 place, 2 attestations |

## 2-problems

Each should be refused or reported with a problem. Use **Check**.

| File | What is wrong | Expect |
|---|---|---|
| `cut-short.json` | `king-john.json` cut off part-way | 1 problem: "The file could not be read to the end…"; the JSON "stops before it is complete" (5 places read) |
| `null-line.jsonl` | `king-john.jsonl` with a line `null` | 1 problem: "A line is not a JSON object…", line 4 |
| `unclosed-quote-tables.zip` | the customs tables with a quotation mark opened and never closed in `names.csv` | 1 problem: "names.csv cannot be read, so it is not checked; the other sheets are checked": a quotation mark "opens a cell and is never closed near line 2". The other sheets are read: 2 places, 2 attestations |
| `windows-1252-tables.zip` | the customs tables, plus Köln, saved in Windows-1252 | 2 problems: names.csv and places.csv each "cannot be read": not encoded as UTF-8, from line 4, with how to save as UTF-8 |
| `windows-1252-places.csv` | the places sheet alone, same encoding | read as a table of places; 1 problem: "The file could not be read to the end…", not encoded as UTF-8, line 4 |
| `not-data.png`, `not-data.txt` | an icon and a shopping list | "The format of this file could not be recognised" |

## 3-compare-versions (Mneme)

`earlier.jsonl` is King John's itinerary as a published dataset (status published, CC BY 4.0,
version 1, at `https://w3id.org/plato-test/king-john/`), every attestation given an address by
`publish mint`. The others are version 2.

Drop the later file, then **Compare with the earlier version…** and choose `earlier.jsonl`.

| File | What changed | Expect |
|---|---|---|
| `later-ok.jsonl` | one attestation added (Runnymede as "Runingmede", with `created`) | Nothing deleted or changed; 47 unchanged, 1 new |
| `later-respelt.jsonl` | the name "Runnemead" respelt "Runnymead" | 1 problem: an attestation "says something different in the later one" (Runnymede) |
| `later-removed.jsonl` | Corfe Castle's name attestation deleted | 1 problem: an attestation "is not in the later one" (Corfe) |

All four pass **Check** with no problems.

## 4-publish (Agora)

Drop a file, choose under the publishing step what to prepare, then **Prepare**. For the site and
the w3id rules, open **Options** and type **GitHub repository**: `pelagios/plato-test`; for w3id
also **w3id maintainers**: a GitHub user name (yours).

| File | What it is | Expect |
|---|---|---|
| `king-john-published.jsonl` | same as `earlier.jsonl`: published, with addresses | Report: nothing stops publication, 18 of 18 FAIR checks; 2 warnings (author given by ORCID only; no publisher). Site: 19 places, 3 sources. w3id: rules for `https://w3id.org/plato-test/king-john/`, 99 addresses to test. Without a repository, site warns and w3id refuses; without a maintainer, w3id refuses |
| `king-john-draft.json` | the same, as a draft with no version and no addresses | Report: 17 of 18 FAIR checks; adds "no version". Mint: gives 47 attestations addresses. Site: made, marked as a draft, with a warning that 47 attestations have no address. w3id: refused (not published) |
| `customs-tables-w3id.zip` | the customs tables, `base_uri` `https://w3id.org/plato-test/customs/`, published, version 1, no addresses | Report: 18 of 18 FAIR checks, the same 2 warnings. Site: refused until minted (4 attestations without addresses). w3id: rules made, 73 addresses to test |

## 5-readers (Hermes)

Drop any of them and **Check** or **Convert**. All read with no problems; the warnings and
"would not be carried over" lists are the point.

- `tei/`: five TEI editions (one real, from I.Sicily; four constructed), 2 to 8 attestations each.
- `tables-of-places/`: CSV and plain GeoJSON. The tools say which column they read as what.
  `with-ids.csv` (5 places; a row without id, a date "c. 75" and a language in words are reported),
  `no-ids.csv` (2 places; "no column is matched as the places' id"), `odd-headers.csv` (6 places;
  odd column names guessed; bad coordinates reported), `pleiades-places-subset.csv` (5 places;
  most columns kept as notes), `plain.geojson` (4 places; a GeometryCollection not carried),
  `feature-ids.geojson` (3 places, ids from the features).
- `recogito/`: six Recogito exports (W3C Web Annotations), 2 to 51 places each.
- `iiif/georeference-annotation.json`: an Allmaps georeference of Rocque's map of North America.
  Expect a refusal with a reason: "This is a IIIF Georeference Annotation (a map's georeference,
  not a dataset)…".

## 6-match (Krisis)

Drop `king-john.json`, then **Match with another dataset…** and choose `other-list.csv` (made for
this set: 15 of the itinerary's places, some respelt or moved slightly, Odiham and Woodstock left out,
and Lindisfarne, Tintagel and Ely added).

Expect 12 suggestions: exact names (Windsor, Winchester, Runnymede, Devizes, Bradenstoke, Calne,
Newbury, Oxford) at 1; weaker ones for Cirencestre 0.98, Clarendon Palace 0.91, Corfe 0.88,
Abbendon 0.87. No suggestion for Merleberge (Marlborough), Lutgarshale (Ludgershall), Wight (Isle
of Wight), or the three added places.

## 7-chora

Open <https://pelagios.org/plato-tools/#chora> and drop one of `judgements.json` (6 places),
`king-john.json` (19 places) or `routes-tables.zip` (spreadsheet tables with routes: 8 places,
18 attestations). All pass Check with no problems.

`for-tracing/`: the Rocque georeference annotation and its IIIF manifest, for tracing places from a
historical map. Chora opens IIIF maps (and Allmaps georeferences): use its "Show a historical map to
trace from it", give it these two files, and draw or trace places on the map. (Dropped on the main
page's file box, they are refused, because they are maps, not datasets of places.)

## 8-scale

`scale-5000.jsonl.gz`: 5,000 made-up places at random points in a box around Britain (210 KB gzipped), for trying size. Check:
no problems; 5,000 places, 5,000 attestations (about a second on the command line).
