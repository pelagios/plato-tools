# Changelog

All notable changes to PLATO tools are recorded here, newest first, in the
manner of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The tools
are experimental: releases are SemVer pre-releases (`0.9.0-alpha.N`, then
`beta.N` once beta testing starts), each a GitHub pre-release archived on
Zenodo under the concept DOI 10.5281/zenodo.23133141.

This file was begun on 6 November 2026; the entries before that date are
reconstructed from the git history and the GitHub releases, grouped by tag.
Issue numbers are this repository's unless marked *PLATO #NN*, which are
issues of the [ontology's repository](https://github.com/pelagios/place-attestation-ontology/issues).
Changes to PLATO itself are in its own
[CHANGELOG](https://github.com/pelagios/place-attestation-ontology/blob/main/CHANGELOG.md);
the commit of PLATO the tools are checked against is pinned in `package.json`.

## [Unreleased]

### Added

- **Several values for one attribute of a figure.** The figures reader has a new column role, `attribute`, for
  flags and other facts about a figure: the same attribute on several columns, or a `separator` in one cell,
  gives a list; each value is a code the table's description declares, and one that is not is reported and
  left out. Reading PLATO RDF back gives a list for several values of one attribute and a single value for one
  (PLATO's `attributeValue`, from 0cd9af7). Figure addresses are unchanged.

- **Workflows (Methodos).** *Places from an edition (TEI)* and *Places from
  Recogito*; *Match two datasets* (the other dataset chosen at the match and
  checked by its hash, its problems reported without stopping, the decisions
  added to the dataset or kept in a file of their own; measured at 50,000
  places each); *Trace a historical map* (an empty dataset made from a map,
  a new place from each feature traced, or traced into the dataset open under
  its own base address); *Make an open map* (#37: a labelled map of the places
  in Chora's view, as SVG and PNG, over a free background or a georeferenced
  historical map with its rights stated, for Wikimedia Commons, with the
  Methodos workflow from a list of names, a table or a dataset); and *Release
  a new version* (#23, plan #34 item 10), in which Mneme revises a new
  version against its previous release so that nothing published is deleted
  or changed (`revise` on the command line). Each recipe's version bump and
  what it does to a workflow saved under the old version is documented.
- **Wikidata items for the places no gazetteer knows** (#36): which places
  qualify, the search in Wikidata before an item is made, the licence gate
  and the consent bound to a licence, a QuickStatements v1 batch, the Q-ids
  verified and recorded back as identities; the panel under the review, an
  optional step in Map your data, Match two datasets and Trace a historical
  map, and `wikidata search`, `wikidata batch` and `wikidata ids` on the
  command line. The review's fixes: a Q-id verified against what its batch
  wrote, labels compared in NFC, a place with a Q-id recorded takes no second
  one, a year before the common era written as BCE, a warning for two items
  Wikidata would refuse as namesakes, and no batch or consent while the plan
  has no licence gate.
- **The main page in three columns**, with the tracker as a rail of
  checkboxes and one numbering for a workflow; Chora mounted as a module in
  the centre column at `#chora`, sharing the page's files and Permissions
  panel (`chora.html`, the hand-off and the hand-back removed), a save in
  Chora doing the workflow's step; the file the user chose kept for as long
  as they want it, offered on a new visit; Cancel, which stops a run at the
  next record and a publishing part as stopped; `--gzip`, a conversion's
  output gzipped as it is written.
- **Projects.** A whole Methodos workflow saved as a `.platoproj` and opened in
  another browser (format 1.1: a file may be left out as too large);
  projects saved, opened, deleted and shared in WHG's Workbench under a
  `collaborate` permission, a share link opened read-only, `project info` on
  the command line; WHG's version History listed and any earlier version
  restored as a new save, a conflict saying who saved the newer version
  (#38). Gzip uploads to WHG were measured and not built (#38 item 1).
- **Gazetteer lookup.** A Scope for every WHG lookup (where, what kinds of
  place, when, which sources), kept with the workflow; the WHG token field
  shared, with Remember and Forget; a typeahead for the dataset's language,
  and each name's language sent, never `und`, with areas asked for only when
  matching regions (#30, #19); each WHG candidate's kind of place shown and
  the place's own kind preferred, placeholder records left out and counted,
  WHG's daily cap stopped on in plain words; the bulk accept leaves a place
  to the reviewer when another of its name was found where it was looked for,
  and counts namesakes as the review asked (#31); Chora's adopt search scoped
  to the place's nearest identified region and its countries (#32); a place's
  own gazetteer ref kept and flagged when WHG's best candidate is far from
  it; the qualifier rule for names (Great Marlow and Marlow found, Great and
  Little Marlow kept apart), with lists per language and `--qualifiers`.
- **Krisis.** An earlier answer withdrawn when a decision changes, never
  superseded, so that a withdrawn answer cannot come back; each Finish
  recorded; a source cited only by a place left out goes with it (#35); a
  candidate of another dataset whose kind of place conflicts ranked after the
  others, with the reason.
- **Chora.** How well a location is known shown on the map: a mark per
  `spatialPrecision`, a circle of `precisionKm` to scale, and a key (#16);
  the Consortium of Ancient World Mappers' tiles as the basemap *Ancient
  World (CAWM)* under a permission of its own; the Roman Empire (DARE) and
  a shaded relief over Natural Earth as backgrounds of an open map, with a
  finer coast from zoom 7 (#39).
- **Figures.** Agora's site shows a figure with its coordinates, its table
  and its universe, and offers a Data Cube download where the dataset holds
  figures; Arithmos checks a table's figures (Elenchos kinds for a figure's
  table, coordinates, universe and value; the Data Cube check adds P-1 to
  P-4 and IC-19) on the page and the command line (plan #34 item 11, PLATO
  #14); the figures reader, by which a table of figures, long or wide, is
  read as PLATO figures through Hermes's mapping with five more roles and
  the table's description, `--columns` printing the mapping with it.
- **Places from a text**: the engine's pure parts for finding
  place names in a text with a language model, with the prices checked
  against Anthropic's page; a permission category `llm` for language-model
  services; the key of a service held in this tab's memory only, bound to
  its site and forgotten with its permission; the user's agreement to a run
  and a hard cost ceiling ($2 unless changed), nothing sent without both;
  phase 2, in which the model's names are mapped back to the text as given,
  token estimates by script, a reviewer may add a name the model missed,
  the names confirmed are made into a dataset of places, and a work file
  with the text in it is left out of a project.
- **Licences.** A contained licence that may not sit under the dataset's is
  flagged (ND even under the same licence, rights statements, one table for
  the FAIR check and the comparison), a draft site is said to be public once
  uploaded, and the Public Domain Mark goes to Zenodo as `other-pd`.
- **Open map follow-ups** (#39): a historical map under *No Known Copyright*
  is not called free to reuse, and the map is refused until its rights are
  stated; the Commons upload link carries the licence tag in the description
  rather than `wpLicense`, which the upload form did not accept; the map's
  settings are kept in a `data-plato-map` attribute, since Commons refused
  the namespaced element.

### Changed

- The example files' README points at Chora on the main page (`#chora`, not the removed
  `chora.html`) and says Chora opens IIIF maps; the zip is built reproducibly from
  `examples/try-files/` by `scripts/build-try-zip.py`. The status line reads "Experimental, under
  development; one workflow, Map your data, is in beta testing", and the README names the browsers
  tested.
- The vendored PLATO is 0.9.0-alpha.2 (commit e10406d): five succession
  relation types (`SucceededBy`, `MergedInto`, `AbsorbedBy`, `SplitInto`,
  `TransferredTo`) accepted by the table definitions, relation types and
  certainty levels also SKOS concepts, free-text ranges `rdfs:Literal`. Before
  that, 0.9.0-alpha.1 as tagged (0b23ada).
- The README, DEVELOPERS.md and the smaller docs brought into step with the
  code: the command table lists all fourteen commands, and statements
  overtaken by later branches are corrected.
- The README's Methodos row names all eight workflows, and `preview`'s
  options include `--split` and `--clusters`, as its help does; the page's
  Methodos card no longer says Release a new version is to come. The plan
  `docs/plans/methodos.md` marks each passage its "As built" sections
  supersede (branch counts, "waits on", the Planned card), keeping the
  planning record. DEVELOPERS.md's figures that can be re-measured cheaply
  were, and two corrected: the map chunk is 1.1 MB (the shared chunk of
  12 October is gone), and the finer coast is 0.7 MB gzipped, not 1 MB.

### Fixed

- Chora in a window without WebGL (turned off in the browser, or not to be
  had on the machine) stayed at "loading" for good: the map's making threw
  before the engine was started. It now says that the map needs WebGL, and
  the dataset, its places, their cards and the save work without the map.
- A browser without the storage the engine writes through (GNOME Web and
  other WebKitGTK browsers) is told as the page loads that it cannot run the
  tools, and the run buttons stay off; every Check and Convert used to fail
  there with "Backend does not support this operation".
- When the browser's storage filled while a conversion wrote its result, the
  result was cut short, the run said "No problems found" and a workflow's
  step was ticked. Every write is now checked: the run fails in plain words,
  nothing cut is kept or offered, and the step is not done.
- A step's output the browser would not write left an empty file that the
  tracker counted as kept ("1 file the steps made (0 bytes)").
- Browser checks that failed now and then in CI under load (#41): a repaint
  asked for when a tile fails, so that a map whose basemap tiles all fail
  falls back to Natural Earth on a slow machine; the Shaded relief check
  clicks its box; the Wikidata Finish check reports what the page was doing
  when it fails.
- Release a new version, review fixes R1 to R4: a changed attestation keeps
  a meta-attestation of its own, the release name must be one an address can
  hold, a changed facet is refused against a draft previous release too, and
  a reviewer named by an address with `@` is refused everywhere.
- The seams between Chora and the main page: the file handed over opened at
  once, the way back offered from the start, the dataset chosen again on
  return; a lookup preview made before the dataset's language was refused
  never covers the refusal; a header's problems reported once when the input
  is read through the store; a digest taken two to five times faster.
- Command line: a conversion whose output would replace one of its own
  inputs is refused, with or without `--overwrite` (it emptied the input and
  then removed it); `--out` with a new folder of one character no longer
  runs for ever; `revise --date 2026-10-17`, a plain date, is taken as the
  start of that day instead of failing the schema; the help names
  `--clusters` for `preview` and all five roles of a table of figures.
- A table of figures whose periods are spans (1851-1861), or some of them
  blank, no longer declares `sdmx-dimension:refPeriod` in its structure and
  then fails IC-11: the cube export declares it where every figure has a
  year or a day, as its report says.

## [0.9.0-alpha.2] - 2026-10-04

Map your data runs end to end in Methodos: a table of place names, the
regions they lie in matched against the World Historical Gazetteer level by
level, the places matched, locations adopted or drawn (including over
georeferenced historical maps), checked, compared and written out in PLATO.
Checked against PLATO 0.8.0 (pinned at a6bc022).

### Added

- **Regions.** Hermes reads the regions a table's places lie in (the columns
  read as *within*) and writes them as `ContainedIn` relations to regions
  made from the table itself under a base address, as PLATO's worked example
  has them (PLATO #23, option B); a region's level chosen, a column split into
  levels (`--split COLUMN=SEP[:LEVELS]`), a list of names pasted on the page.
  Krisis reviews a table's regions level by level, each looked up within the
  match of the region above, then the places within them, with a relax to the
  region further up and the reviewer's choice of a match's certainty; each
  region claim points at the candidate it answers. A region matched to a
  gazetteer is written to LPF as `gvp:broaderPartitive`, labelled by its
  toponym.
- **Grid references.** A column of National Grid or Irish Grid references
  read as each row's location, converted to WGS 84; a letters-only reference
  warned of and read as a 100 km square.
- **Grouping similar spellings for lookup**, by OpenRefine's fingerprint and
  n-gram keys and Cologne phonetics: proposed unticked on the page, only
  ticked groups sent, saved with the matching; `cluster` proposes groups as
  JSON and `--clusters FILE` applies saved ones.
- **Krisis with WHG's guards**: an undoable bulk accept, query variants, flags,
  notes and row states; no lookup of a place the reviewer has left out.
- **Candidate sets.** A review's suggestions published as a candidate set,
  each answer pointing at the suggestion it answers (`promotedFrom`);
  candidate ids minted by one function (JCS and SHA-256); candidate sets held
  frozen in the version check and checked together with their dataset;
  `--candidates` for `check`, `convert` (including `--to lpf`) and `apply`; a
  candidate set exported from a review by gazetteer lookup alone.
- **Methodos joined to the tools' runs**: a step is done when its tool's run
  on its file finishes; a workflow may be chosen before any file; the files
  its steps made and a dropped file's handle are kept; Chora's hand-back is
  taken on the main page and is good for thirty minutes; at Finish a dataset
  already in the workflow's format is offered to download, the base address
  is asked where addresses are minted, and a changed one is warned of.

### Changed

- The tools are called *experimental* wherever a user reads their status, and
  the README shows static DOI, status and version badges made from
  `CITATION.cff` by `scripts/badges.mjs`. The version in `package.json`,
  still `0.1.0` at the alpha.1 tag, became `0.9.0-alpha.1` and then
  `0.9.0-alpha.2`.
- The proof that the browser checks can fail runs on every branch again, now
  that it takes thirteen minutes, and in full every night on `main`.

### Fixed

- A historical map's Show and opacity are kept with its tick, so a reload
  brings it back as shown; only a map's own file is read as kept, never the
  swap file of a write still open; a status badge is drawn only from the
  status words' own keys.

## [0.9.0-alpha.1] - 2026-10-04

The first release, after a week of development from the spike of 27
September 2026. The tools, in the browser at https://pelagios.org/plato-tools/
and on the command line, check, convert, compare, match, map and publish
data about places in the formats of PLATO; files stay on the user's computer,
and nothing is sent to any other site unless the user allows it. Checked
against PLATO 0.8.0 (pinned at a6bc022), after pins of 0.5.0, 0.6.0, 0.7.0
and 0.7.1 as each was released.

### Added

- **The engine, the page and the command line.** One engine composes readers
  and writers, run in a worker in the browser and in Node for
  `bin/plato-tools.mjs` (`check`, `convert`, `compare`, `datacube`, and the
  rest as each tool arrived). RDF becomes JSON through an on-disk SQLite
  store, so the tools work at any size (established on DEEP's 24.8 million
  triples); the spreadsheet tables stream through a working database. JSON
  Lines is read and saved as JSON Lines. Nothing is dropped silently: every
  schema key is carried or reported, in words; a denial is never written as
  an assertion; a document cut short is reported, not passed as clean; a
  fault in the tools is reported as one, not as a problem in the file.
- **Elenchos** (check) and **Metaphrasis** (convert), between PLATO JSON,
  RDF, the spreadsheet tables and Linked Places Format, with what each format
  loses said in words; a PLATO candidate set recognised, checked and
  converted.
- **Arithmos**: statistical figures carried as PLATO's design has them, with
  a Data Cube export and its integrity checks (PLATO #14).
- **Mneme**, the version check: a published dataset may only be added to;
  retracting a retraction restores its target; attestation addresses minted
  as `<place>#a-<hash of what it says>`, kept, inherited and checked.
- **Agora**, publishing: one address scheme, and a `publish` command with
  four parts, the report (FAIR checks on a dataset's description and its
  deposit files, `.zenodo.json`, `CITATION.cff` and DataCite JSON), mint,
  the site (a page and a JSON-LD document for every place, for GitHub Pages)
  and the w3id rules; a subset of the places with `--only`; `--overwrite`.
- **Hermes**, the readers: W3C Web Annotations from Recogito v1 and Recogito
  Studio, with georeferenced regions placed through their maps (`--georef`,
  `--manifest`); TEI P5, P4 and TEI with no namespace, with the ISO entity
  sets, Beta Code, variant readings left out, and the reading options
  (`--list-places`, `--key-pattern`, `--same-id`, the editors' own parts and
  header places); any CSV or GeoJSON, a researcher's own workbook one sheet
  at a time, and gazetteer ids as addresses in one form for Pleiades,
  GeoNames, Wikidata and WHG; a preview of the first records (`preview
  [--limit N]`).
- **Krisis**, match review: matches suggested between two datasets' places,
  reviewed one place at a time, and the reviewer's judgements recorded as
  PLATO identity attestations, finished with the version check; places
  looked up in the World Historical Gazetteer or any reconciliation service,
  with the licence of copied data, through the Permissions panel; a review
  that always resumes.
- **Chora**, the map: the dataset's places on a map (Natural Earth served
  from this site), searched by every current name through a trigram index;
  drawing a geometry and saving it with the version check; historical maps
  through the Allmaps renderer, traced from with the map and its georeference
  cited (PLATO #15), with assistance from the map's ink (the ink engine, pure
  and tested in Node); a location adopted from a gazetteer match as two
  attestations, the identity and the copied geometry; a dataset saved in
  Chora handed back to its Methodos workflow.
- **The shared georeference step**: map pixels to the world and back, from a
  IIIF Georeference Annotation, refusing what it would misread.
- **Permissions**: one module for the toolbox, with its panel and the policy
  it writes; only https sites, no redirects followed, `--allow-host` on the
  command line; the WHG allowance shared across tabs, hung requests timed
  out, a token cleared.
- **Methodos**, guided workflows through the tools: the plan, the recipes
  *Map your data* and *Publish a dataset* checked and given a digest, explicit
  transitions that keep waiting, a data problem and a failure apart, a
  record kept at every step boundary and resumed only under the recipe it
  followed, and the page's three-question interview with a tracker that
  chooses each step's tool.
- **The page**: the toolbox with a tooltip explaining each tool's name, a
  hideable introduction, example files to try the tools with, Auto, Light or
  Dark themes, PLATO's logo and a social-media preview card, the
  acknowledgement of ISHI, and the tools made citable (`CITATION.cff`,
  `.zenodo.json`).
- **PLATO's rulings on Trismegistos** (PLATO #18 to #22) followed: a relation
  named by `relatedLabel` alone, several `relativeTo` anchors, an evidence span
  never written as the place's dates in LPF or the tables, and a name known
  only in transliteration shown.
- **Testing**: the browser checks in headless Playwright, with a proof that
  they can fail; the full gates run on GitHub for every branch pushed.

[Unreleased]: https://github.com/pelagios/plato-tools/compare/v0.9.0-alpha.2...HEAD
[0.9.0-alpha.2]: https://github.com/pelagios/plato-tools/compare/v0.9.0-alpha.1...v0.9.0-alpha.2
[0.9.0-alpha.1]: https://github.com/pelagios/plato-tools/releases/tag/v0.9.0-alpha.1
