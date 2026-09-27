# Spike: can a browser page convert a dataset of any size?

**Question.** Can a static page, with no server, turn DEEP's 24.8-million-triple N-Triples file back
into one JSON record per entity, while its memory stays roughly constant however large the input?
That conversion is the hard case, because an entity's triples can be scattered anywhere in an RDF
file, so they must be gathered through an index rather than read in order.

**Design under test.** A worker streams the gzipped file (`File.stream()`, `DecompressionStream`),
parses it in batches with N3.js, and loads the triples into SQLite compiled to WebAssembly, stored
on the origin private file system (OPFS) through SQLite's pool-based VFS, which needs none of the
cross-origin isolation headers GitHub Pages cannot send. It indexes by subject and by object, then
writes one JSON line per `SpatialEntity`, gathering its attestations and their names, dates,
geometries and citations.

**Harness.** `run_spike.py` drives Playwright's own bundled Chromium (never the user's browser),
polls the page's own progress object, and samples the resident memory of every browser process
throughout. `verify.py` checks the output independently of the page.

## Result: it works, and memory is bounded

Ground truths were fixed before any code ran, from the export's manifest and an independent `awk`
count: 24,789,544 triples, 547,063 SpatialEntity-typed nodes, 1,414,328 attestations.

| Input | Triples | Peak memory, largest process | Peak on disk | Time |
|---|---|---|---|---|
| 5% of DEEP | 1,239,474 | 534 MB | 70 MB | 29 s |
| 20% of DEEP | 4,957,905 | 548 MB | 893 MB | 117 s |
| All of DEEP (2.6 GB uncompressed) | 24,789,544 | 756 MB | 5.2 GB | 10 min |
| Control: hold every line, 5% | 1,239,474 | 476 MB | none | 4 s |
| Control: hold every line, 20% | 4,957,905 | 1,164 MB | none | 4 s |

The full run wrote 547,063 lines, 2.15 GB, the largest record 2.7 MB, with all 1,414,328
attestations accounted for. `verify.py` rebuilt three entities from the N-Triples by plain string
matching (Bunsty Hundred, 287 triples; Cambridge, 171 attestations and 2,334 triples; one taken
three-quarters of the way through the file) and each matched the output exactly. Its comparator
said SAME for a sample against itself and DIFFERENT when one triple was removed.

Memory grows far more slowly than the data: 20 times the input added about 220 MB, while the
database on disk grew to 5.2 GB. The naive control shows the sampler does see growth.

## Two findings that decided the design

1. **Implicit read transactions made OPFS lookups five times slower.** Every lookup ran in its own
   transaction, so SQLite re-checked the file and its page cache each time. Exclusive locking and
   one read transaction for the whole writing phase took the 5% writing phase from 88 s to 19 s,
   close to the 16 s of an in-memory database. A larger cache did not help.
2. **An off-the-record browser profile keeps OPFS in memory.** The first scale run used
   Playwright's `new_context()`, which is incognito-like, and memory climbed with the data because
   the "disk" was RAM. With a persistent profile in a fresh temporary directory, memory was flat.
   The same applies to users: **a private window cannot process large files.**

## Reproduce

```bash
npm install && npx vite build
python3 spike/run_spike.py --input deep-plato.nt.gz --download out.jsonl
python3 spike/verify.py deep-plato.nt.gz out.jsonl 547063 1414328
```
