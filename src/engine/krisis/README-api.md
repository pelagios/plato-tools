# Krisis engine API (for the page and the worker)

Status: IMPLEMENTED; engine and CLI tests pass (test/krisis.test.js, test/krisis-cli.test.js).

## Modules

- `src/engine/krisis/work.js` — light (no pipeline import; safe to import in app.js):
  - `readWork(text) -> work` — parses and validates a work file; throws `DataError` (from
    `../input.js`) with a plain message.
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
    `maxDistanceKm` (50), `topK` (5). Writes output `<subjects stem>.krisis.json`.
- `src/engine/krisis/apply.js`:
  - `apply({ subjects, work, options: { output = 'attestations', reviewer, date } }, env) -> { report, outputs, incomplete? }`
    `work` is a work object or its text. `reviewer` ({ name, orcid? }) overrides `work.reviewer`.
    'attestations' writes `<subjects stem>.krisis-attestations.json` (attestation-centric PLATO).
    'dataset' is not yet available: report item `dataset-not-yet`, no outputs.
- `src/engine/krisis/identity.js`: `recordIdentity({ subject, targets, source, reviewer, date, negated, notes })`,
  `attestationsFrom(work, { reviewer, source, date }) -> [{ subject, attestation }]` (each attestation
  dated by its latest decision's `decided_at` unless `date` is given).
- `src/engine/krisis/names.js`: `normalise(s)`, `similarity(a, b)`, `trigrams(normalised)`.

## Work file (version 1)

See the comment at the top of `work.js`. Candidate `other: { label, names, point, source: { title, uri? }, ccodes?, types? }`;
`decision: null | { kind, identityType (not for 'not-this'), basis?, decided_at }`. `places` holds only
subject places with at least one candidate, in review order. `reviewer: null | { name, orcid? }`
(`match` puts `options.reviewer` there if given). `cursor`: index into `reviewPlaces(work)`.

## Worker/UI notes

- `match()` result `{ report, outputs: [{ name, size }], work }`; `report.counts` keys: subjects,
  others, candidates, suggestedFor, linked, judgedDifferent, tooFar, unaddressed.
- `apply()` result `{ report, outputs, attestations }`; counts: attestations, matchAttestations,
  distinctAttestations, relations. output 'dataset' → error item `dataset-not-yet`, `incomplete: true`.
- For resume: `readWork(text)` then `filesDiffer(work.subjects, files)` / `filesDiffer(work.others, files)`.
- words.js also exports `reviewProgressText({ reviewed, total })` → "12 of 340 places reviewed".

## Progress phases (env.progress)

`{ phase, dataset: 'subjects' | 'others', ...counts, elapsedMs }` while reading (phases are
pipeline's: reading/loading/indexing/writing, and 'read' when a dataset is finished), then
`{ phase: 'matching', places, elapsedMs }`, then `{ phase: 'done' }`. `progressText()` in words.js
words them all.

## Words

`summary(report, 'match' | 'apply')`, `groups('match' | 'apply')` in words.js.
