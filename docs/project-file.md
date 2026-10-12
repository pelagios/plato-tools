# The PLATO tools project file, version 1

A PLATO tools project holds one Methodos workflow whole: its record, its Scope, the files its steps
made, the user's own starting file, the Krisis review open, and Chora's hand-back if one waits. It is
written and read by `src/engine/methodos/project.js`; DEVELOPERS.md ("The project file") says how the page
uses it. This page is the contract that WHG's Workbench stores it under (its `plato` doc_type).

PLATO tools never read WHG's `.whgproj` files or its synced projects, and a WHG project is not a PLATO
tools project.

## The container

- A ZIP file, extension **`.platoproj`**, media type `application/zip`.
- Every entry is compressed with DEFLATE (method 8). Entries may use data descriptors (sizes after the
  data), as a streaming writer writes them; ZIP64 is not used.
- The **first entry is `manifest.json`**, so that a reader can check everything after it as it streams.
- Every other entry is listed in the manifest's `parts`, exactly once, in any order. An entry not listed
  makes the file not a project.

## manifest.json

UTF-8 JSON, at most 1 MB, an object with exactly these keys (`left` optional):

| Key | Value |
|---|---|
| `format` | `"plato-tools-project"` |
| `version` | `1`. A reader refuses a version newer than it reads, saying so. |
| `tools` | `{ "version": "<package version>", "commit": "<40 hex>" or null }`: the PLATO tools that wrote it |
| `created` | ISO 8601 date and time |
| `workflow` | `{ "id", "name", "recipe": { "key", "version" }, "at" }`: `id` is 1 to 64 of `A-Z a-z 0-9 _ -`, beginning with a letter or digit; `at` is the id of the step it is at, or null when every step is done. These must agree with the record. |
| `parts` | the entries after the manifest, at least one, at most 1000, the record first: see below |
| `left` | optional: `[{ "name", "size", "sha256", "why" }]`, files the record names that are not in the project; `why` is `"left-out"` (the user chose to leave it out) or `"not-kept"` (the browser that saved it no longer kept it) |

Each part is an object with exactly the keys of its role:

| `role` | `path` | Keys | At most |
|---|---|---|---|
| `record` | `workflow.json` | `path`, `role`, `size`, `sha256` | one, always; 4 MB |
| `review` | `review.krisis.json` | the same, and `name` (the work file's name) | one; 256 MB |
| `handback` | `chora-handback.json` | `path`, `role`, `size`, `sha256` | one; 64 KB |
| `file` | `files/<sha256>` | the same, and `name` and `own` (true for the user's own starting file) | any |

`size` is the number of bytes of the entry uncompressed; `sha256` is the SHA-256 of those bytes, as 64
lower-case hex digits. A `file`'s path is its own `sha256`. A `name` is 1 to 255 characters, with no `/`
or `\`, no control or invisible characters (U+200B to U+200F, U+202A to U+202E, U+2066 to U+2069,
U+FEFF), not only white space, and not `.` or `..`.

## The parts

- **`workflow.json`**: the workflow's record, exactly as Methodos writes it to a `.workflow.json`
  (`src/engine/methodos/record.js`: `{ methodos: 1, recipe: { key, version, digest }, answers, files,
  steps, status, current, id, name, created, saved, scope? }`). It names every file by `{ type, name,
  size, sha256 }`; its `scope` is the workflow's Scope.
- **`review.krisis.json`**: the Krisis work file of the review open when the project was saved (version 3:
  `src/engine/krisis/work.js`), with its decisions, candidates and regions.
- **`chora-handback.json`**: `{ "handback": 1, "workflow": "<the record's id>", "files": [{ "type":
  "dataset", "name", "size", "sha256" }], "at": <ms since 1970> }`, a reference to the dataset saved in
  Chora, never its bytes.
- **`files/<sha256>`**: a file the record names, byte for byte: the user's own (`own: true`) or one a step
  made. Every `file` part must be named by the record, by SHA-256 and size.

## Reading

A reader checks, and refuses in words: that the file is a ZIP; that its first entry is `manifest.json`;
the format, then the version, then every key; each entry against its part, its size and SHA-256, as it
streams (a part longer than its size is stopped there); that no part is missing or listed twice; the
record, the review and the hand-back by their own rules; and that every file is one the record names.
Anything it does not know is refused: **a writer that adds anything raises the version.** Nothing read
acts on its own: opening a project runs no step and asks no other site.

## What a project never holds

The WHG token or any other key or secret, permission grants, file handles, and the storage of the
browser that saved it. The reviewer's name and ORCID are in it only where a review records who decided
(the work file's `reviewer`).

## Checking one

```bash
plato-tools project info [--json] FILE.platoproj
```

lists the manifest and checks every part's size and SHA-256: exit 0 when it would open, 1 when it is
refused, 2 when the file cannot be read.
