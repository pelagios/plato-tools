# Krisis engine API (for the page and the worker)

Status: IMPLEMENTED; engine and CLI tests pass (test/krisis.test.js, test/krisis-cli.test.js).

## Modules

- `src/engine/krisis/work.js` — light (no pipeline import; safe to import in app.js):
  - `readWork(text) -> work` — parses and validates a work file; throws `DataError` (from
    `../input.js`) with a plain message. It also refuses what would make `recordIdentity` throw
    later: a `decided_at` that is not an ISO date-time, a place key or `candidate_candidate` that is
    not an IRI, the same (candidate_source, candidate_candidate) pair twice.
  - `checkReviewer({ name, orcid? }, where?)` — throws `DataError` unless it is PLATO's
    contributorObject (a name that is not blank; an ORCID written in full,
    `https://orcid.org/0000-0000-0000-0000`). The page checks the reviewer with it before saving or
    finishing, and never stores an ORCID it refuses.
  - `DATE_TIME`, `isIri` — the rules `readWork` and `recordIdentity` share.
  - `checkMatchOptions({ threshold, maxDistanceKm, topK }) -> numbers` (with `MATCH_DEFAULTS` for
    those not given); throws `DataError` in plain words (a threshold of 0 or above 1, a negative
    distance). `match()` uses it, and the page checks its options with it before it asks for the
    other dataset.
  - `TITLE_FROM` — `['gazetteer', 'given', 'file-name']`, the values of a side's `titleFrom`.
  - Places and candidates are looked up with `Object.hasOwn`, never `in` (a `candidate_source` of
    `constructor` is refused as a place the file does not list).
  - `serialiseWork(work) -> string` (JSON, 2-space indent, trailing newline).
  - `decide(work, candidateId, kind, { identityType = 'exactMatch', basis, at = new Date().toISOString() } = {}) -> candidate`
    kind: `'match' | 'not-this' | 'distinct' | null` (null clears the decision). Sets
    `candidate_status` ('confirmed' | 'rejected' | 'suggested') to agree. 'distinct' requires a
    non-empty basis (throws otherwise).
  - `reviewPlaces(work) -> [iri…]` subject places in review order (= `Object.keys(work.places)`).
  - `candidatesOf(work, iri) -> [candidate…]` in score order.
  - `isReviewed(work, iri) -> boolean` — at least one of its candidates has a decision.
  - `reviewProgress(work) -> { reviewed, total }`.
  - `filesDiffer(side, files) -> Promise<string[]>` — `side` is `work.subjects` or `work.others`;
    returns the names of files whose size/sha256 differ or are missing (empty = same).
  - `fileRecords(files) -> Promise<[{ name, size, sha256 }]>` (streams; any size).
- `src/engine/krisis/match.js`:
  - `match({ subjects, others, options }, env) -> { report, outputs, work, incomplete? }`
    `subjects`/`others` are inputs as `detect()` returns them. options: `threshold` (0.85),
    `maxDistanceKm` (50), `topK` (5), `base` (spreadsheet tables: the base address of their
    places; kept in `match_parameters.base`), `reviewer`, `othersTitle` (the other dataset's title,
    which every attestation cites as its source: it replaces the title the dataset gives, and
    `work.others.titleFrom` becomes `'given'`). When the other dataset gives no title and none is
    given, its file's name stands in (`titleFrom: 'file-name'`) and the report has a warning
    `others-title-is-file-name`. Bad options throw `DataError`. Writes output
    `<subjects stem>.krisis.json`. `match_parameters` also holds `blocking` (`BLOCKING` with its
    `rule` in words) and `scoring` (in words); `algorithm_version` is `krisis-names 3`.
- `src/engine/krisis/apply.js`:
  - `apply({ subjects, work, options: { output = 'dataset', reviewer, date, base, othersTitle } }, env) -> { report, outputs, incomplete? }`
    `work` is a work object or its text. `reviewer` ({ name, orcid? }) overrides `work.reviewer`;
    `othersTitle` overrides `work.others.title` as the title of the source each attestation cites.
    A title that is only a file's name (`work.others.titleFrom === 'file-name'`, none given now) is
    warned of (`others-title-is-file-name`): it would be published in every attestation.
    `base`: for spreadsheet tables, the base address given to `match()`; if it differs from the
    review's `match_parameters.base` (tables only), a warning `base-differs`. The page passes the
    Options' base to both `match` and `apply`, as the command line passes `--base`.
    'dataset' (the default) converts `subjects` with `run({ action: 'convert', target: 'plato-json',
    options: { augment } })`, appending each place's new attestations, and writes
    `<subjects stem>.krisis-dataset.json` (place-centric PLATO JSON, whatever the input format; not
    `.krisis.json`, which is the work file's name). Each new attestation is first checked against
    the place-centric schema (`validators['place-centric'].entity`, under a place of its own): a
    failure is `not-valid`, nothing converted. It then runs `checkAppendOnly()`. Any error
    (below) → `incomplete: true`, no outputs.
    'attestations' writes `<subjects stem>.krisis-attestations.json` (attestation-centric PLATO).
  - `checkAppendOnly({ earlier, later, added, options: { base } }, env, rep)` — the version check
    (`compare()`) of the dataset written (`later`, a File) against the subject dataset; adds its
    findings to the Report `rep` and returns compare's result.
- `src/engine/krisis/identity.js`: `recordIdentity({ subject, targets, source, reviewer, date, negated, notes })`,
  `attestationsFrom(work, { reviewer, source, date }) -> [{ subject, attestation }]` (each attestation
  dated by its latest decision's `decided_at` unless `date` is given).
- `src/engine/krisis/names.js`: `normalise(s)`, `similarity(a, b, weight?)`,
  `similarityNormalised(x, y, weight?)`, `nameScore(x, y)` (Jaro-Winkler, as written or with the
  words sorted), `distinctive(x, y, weight?)` (the score on the words the names do not share, or
  null), `expandedScore(x, y)` (when every word is shared, some only as an abbreviation of at most
  three letters, two fewer than its word, the name score with the abbreviations written out; else
  null: the one case that raises a score), `oneEdit(a, b)`, `trigrams(normalised)`, `DISTINCT_GATE`. `weight(word)` defaults to 1 for
  every word; the matcher gives inverse document frequency.
- `src/engine/krisis/blocking.js`: `new NameIndex(otherPlacesNames, subjectPlacesNames)`;
  `.best(names, threshold) -> Map(other place number -> score)` (only scores reaching the
  threshold), `.candidates(normalised, threshold)`, `.comparisons` (pairs of names scored), `.weight`;
  `BLOCKING` `{ share: 0.4, commonShare: 0.01, commonFloor: 50, keys: 4, spread: 4 }`, `BLOCKING_RULE`,
  `canReach(lengthA, lengthB, threshold)`.

## Work file (version 1)

See the comment at the top of `work.js`. Candidate `other: { label, names, point, source: { title, uri? }, ccodes?, types? }`;
`decision: null | { kind, identityType (not for 'not-this'), basis?, decided_at }`. Each side
(`subjects`, `others`) has `titleFrom`: `'gazetteer'`, `'given'` (by `othersTitle`) or `'file-name'`. `places` holds only
subject places with at least one candidate, in review order. `reviewer: null | { name, orcid? }`
(`match` puts `options.reviewer` there if given). `cursor`: index into `reviewPlaces(work)`.

## Worker/UI notes

- `match()` result `{ report, outputs: [{ name, size }], work }`; `report.counts` keys: subjects,
  others, candidates, suggestedFor, linked, judgedDifferent, tooFar, unaddressed, comparisons.
- `apply()` result `{ report, outputs, attestations }`; counts: attestations, matchAttestations,
  distinctAttestations, relations; with output 'dataset' also `places` and `versionCheck: { earlier,
  later, unchanged, changed, lost, added }` (compare's counts). Report kinds of the dataset output:
  errors `no-dataset`, `dataset-not-read`, `not-in-dataset` (a subject IRI in the decisions that no
  record of the dataset has), `not-append-only` (compare found something deleted or changed: a fault
  in the tools), `not-checked`, `not-all-added`; warnings `dataset-has-problems` (the dataset's own
  schema problems, counted), `dataset-now-plato-json` (input was not a place-centric PLATO JSON
  document), and the conversion's own warnings and losses, passed on (`groups('apply')` has a loss group).
- For resume: `readWork(text)` then `filesDiffer(work.subjects, files)` / `filesDiffer(work.others, files)`.
  With no dataset chosen, the page says so (`review.noDatasetYet`) rather than comparing nothing.
- A `DataError` thrown by `match()` or `apply()` in the worker (options out of range) comes back as
  a `done` message with `incomplete: true` and one error item of kind `not-possible` carrying its
  message, so the page shows it plainly, not as "Something went wrong".
- The page's Options hold "the other dataset's title" (`#others-title`), passed as `othersTitle` to
  both `match` and `apply`.
- The review's progress line is `review.progress({ reviewed, total }, at?)` in words.js → "12 of 340
  places reviewed; this is place 13."

## Progress phases (env.progress)

`{ phase, dataset: 'subjects' | 'others', ...counts, elapsedMs }` while reading (phases are
pipeline's: reading/loading/indexing/writing, and 'read' when a dataset is finished), then
`{ phase: 'matching', places, elapsedMs }`, then `{ phase: 'done' }`. `apply()` with the dataset
output reports `applying`, the conversion's phases, `checking`, then the version check's (with
`version: 'earlier' | 'later'`), then `done`. `progressText()` in words.js
words them all.

## Words

`summary(report, 'match' | 'apply')`, `groups('match' | 'apply')` in words.js.

## Gazetteer lookup (change 2, phase A)

- `src/engine/krisis/lookup.js` (light; runs on the page's main thread): `runLookup({ lookup, work,
  subjects, places, options, signal, onBatch, now }) -> { work, record, plan, stopped }`,
  `planQueries(places, options) -> { queries, chunks, preview }`, `rankGazetteer(place, candidates,
  { maxDistanceKm })`, `mergeAnswers(work, record, place, lists, opts)`, `startLookup`, `newWork`,
  `selectPlaces({ work, places, which, service, only })`, `defaultChoice(work)`, `serviceOf(endpoint)`,
  `licenceOf(attribution, namespace, dataset)`, `lookupCandidatesOf`, `typeFromManifest`,
  `iriFromTemplate`, `WHG_SERVICE`, `WHG_PLACE_TYPE`, `PLACE_CHOICES`; re-exports `krisisLookupNote`,
  `authorityIris`, `currentIdentities`.
- `src/engine/krisis/identities.js`: `currentIdentities(records) -> Map<place IRI, { linked, denied }>`,
  `createIdentityCollector()`, `linkState(entry, { id, iri })`, `authorityIris(id)`.
- `src/engine/krisis/identity.js`: `gazetteerSource(service)`, `candidateSource(work, candidate)`.
- `src/engine/krisis/match.js`: `gather({ subjects, options }, env) -> { report, subjects, places }`.
- Words: `LOOKUP_WORDS`, `krisisLookupNote` in words.js. DEVELOPERS.md, "Gazetteer lookup".

## Gazetteer lookup on the page (change 2, phase B)

- `src/lib/whg-token.js`: `get()`, `set(token)`, `forget()`, `onChange(fn(hasToken))`; sessionStorage,
  memory fallback, no localStorage. Shared with Chora; no Krisis UI in it.
- worker.js `cmd: 'places'` `{ subjects, options: { base } }` → `{ type: 'places', subjects, places, report }`
  (`gather()`), for `runLookup`'s `places`; the lookup itself runs on the page's thread.
- words.js `lookupPage` (the panel, progress, the review screen's additions, what Finish cites).
