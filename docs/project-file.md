# The PLATO tools project file, version 1.0

A PLATO tools project holds one Methodos workflow whole: its record, its Scope, the files its steps
made, the user's own starting file, the Krisis review open, and Chora's hand-back if one waits. It is
written and read by `src/engine/methodos/project.js`; DEVELOPERS.md ("The project file") says how the page
uses it. This page is the contract that WHG's Workbench stores it under (its `plato` doc_type).

PLATO tools never read WHG's `.whgproj` files or its synced projects, and a WHG project is not a PLATO
tools project.

## The container

- A ZIP file, extension **`.platoproj`**, media type `application/zip`. No ZIP64, no encryption, one
  file (not split).
- **The central directory is authoritative.** A reader finds the end-of-central-directory record, reads
  the directory, and reads each entry at the offset and of the compressed size the directory gives. It
  never scans the data for signatures (a part may itself be a zip: a workbook). Each local header must
  agree with its directory entry (name, method, and, when the header carries them, CRC and sizes); no two
  entries may overlap; a file with no central directory is not a project.
- Entry names are UTF-8. Each appears once.
- Writers compress every entry with DEFLATE (method 8), and may use data descriptors (bit 3), as a
  streaming writer does. **Readers accept stored entries (method 0) too**; any other method is refused.
- The **first entry is `manifest.json`**, at offset 0, and first in the directory.
- Every other entry is listed in the manifest's `parts`, once. An entry not listed makes the file not a
  project.

## Size ceilings

| What | At most |
|---|---|
| the whole project, and any one part | 4 GiB (no ZIP64); a writer refuses more, in words |
| `manifest.json` | 1 MB |
| `workflow.json` | 4 MB |
| `review.krisis.json` | 64 MB |
| `chora-handback.json` | 64 KB |
| parts | 1000 |

A reader is told the sum of the file parts' sizes from the manifest before it writes any, and the page
refuses a project whose files exceed the room the browser reports (`navigator.storage.estimate()`, with
a tenth and a megabyte to spare), or, held in memory (working data not kept), 512 MB.

## manifest.json

UTF-8 JSON, an object with these keys (`minor` and `left` optional):

| Key | Value |
|---|---|
| `format` | `"plato-tools-project"` |
| `version` | `1`: the **major** version |
| `minor` | `0`: the minor version (absent means 0) |
| `tools` | `{ "version": "<package version>", "commit": "<40 hex>" or null }`: the PLATO tools that wrote it |
| `created` | ISO 8601 date and time |
| `workflow` | `{ "id", "name", "recipe": { "key", "version" }, "at" }`: `id` is 1 to 64 of `A-Z a-z 0-9 _ -`, beginning with a letter or digit; `name` is the record's name (its first 255 characters); `at` is the id of the step it is at, or null when every step is done. Each must agree with the record. |
| `parts` | the entries after the manifest, at least one, at most 1000, the record first: see below |
| `left` | optional: `[{ "name", "size", "sha256", "why" }]`, files the record names that are not in the project; `why` is `"left-out"` (the user chose to leave it out) or `"not-kept"` (the browser that saved it no longer kept it) |

Each part has exactly the keys of its role, and may have `"optional": true`:

| `role` | `path` | Keys |
|---|---|---|
| `record` | `workflow.json` | `path`, `role`, `size`, `sha256`; one, always |
| `review` | `review.krisis.json` | the same, and `name` (the work file's name); at most one |
| `handback` | `chora-handback.json` | `path`, `role`, `size`, `sha256`; at most one |
| `file` | `files/<sha256>` | the same, and `name` and `own` (true for the user's own starting file) |

`size` is the number of bytes of the entry uncompressed, and must equal the directory's; `sha256` is the
SHA-256 of those bytes, as 64 lower-case hex digits. A `file`'s path is its own `sha256`. A `name` is 1 to
255 characters, with no `/` or `\`, no control or invisible characters (U+200B to U+200F, U+202A to
U+202E, U+2066 to U+2069, U+FEFF), not only white space, and not `.` or `..`.

## Versions

- **`version` is the major.** A reader refuses a project of a greater major, saying which tools saved
  it. A change that an older reader could misread raises the major.
- **`minor` is what may be added without breaking a reader of the same major.** A reader opens a project
  of a greater minor of its own major, and must say so: "saved by newer PLATO tools; what they added is
  not read". It ignores keys it does not know, at any level of the manifest. When it saves the workflow
  again, it writes its own minor, and says that what the newer tools added is not kept.
- **A role or an entry a reader does not know is never ignored**, at any minor, unless the manifest marks
  that part `"optional": true` (whose path is then plain, relative, with no `..`); an optional part of an
  unknown role is not read and not checked.
- **At the reader's own minor or below, a key it does not know is damage**, and the project is refused.
- **The parts carry their own versions**, which the manifest's do not change: the record is `methodos: 1`
  (`src/engine/methodos/runner.js`), the review a Krisis work file of `krisis: 3`
  (`src/engine/krisis/work.js`), the hand-back `handback: 1`. A reader checks each by its own rules.

## The parts

- **`workflow.json`**: the workflow's record, exactly as Methodos writes it to a `.workflow.json`
  (`src/engine/methodos/record.js`: `{ methodos: 1, recipe: { key, version, digest }, answers, files,
  steps, status, current, id, name, created, saved, scope? }`). It names every file by `{ type, name,
  size, sha256 }`; its `scope` is the workflow's Scope.
- **`review.krisis.json`**: the Krisis work file of the review open when the project was saved, with
  its decisions, candidates and regions.
- **`chora-handback.json`**: `{ "handback": 1, "workflow": "<the record's id>", "files": [{ "type":
  "dataset", "name", "size", "sha256" }], "at": <ms since 1970> }`, a reference to the dataset saved in
  Chora, never its bytes.
- **`files/<sha256>`**: a file the record names, byte for byte: the user's own (`own: true`) or one a step
  made. Every `file` part must be named by the record, by SHA-256 and size.

## Identity

A project is the workflow **`workflow.id`** saved at **`created`**: the same workflow saved twice has
the same id and two times. A store of projects (WHG's Workbench) should key on the pair, and may treat a
later `created` for the same id as a later version of it.

## Verifying one (a reader, or a server storing it)

1. The container: a ZIP with a central directory, entries agreeing with their local headers, none
   overlapping, `manifest.json` first.
2. **The manifest first**: its format, its major, then its keys at its minor; every directory entry
   listed in it, every part present, each of the directory's size.
3. **Then the hashes**: each part read through, its size and SHA-256 checked. A server that does not
   unpack the parts can stop after step 2 and still refuse what is plainly not a project; only step 3
   says it is whole.
4. The parts by their own rules, and against each other: the record and the manifest describe the same
   workflow; every file is one the record names.

Anything that fails is refused, in words. Nothing read acts on its own: opening a project runs no step
and asks no other site.

## What a project never holds

The WHG token or any other key or secret (a writer searches every part, the user's files included, for
the secrets it knows, and refuses to save one that holds any), permission grants, file handles, and the
storage of the browser that saved it. The reviewer's name and ORCID are in it only where a review records
who decided (the work file's `reviewer`).

## Checking one

```bash
plato-tools project info [--json] FILE.platoproj
```

lists the manifest and checks every part's size and SHA-256, reading by the central directory as the
page does: exit 0 when it would open, 1 when it is refused, 2 when the file cannot be read.
