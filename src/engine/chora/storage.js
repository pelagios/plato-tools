// How much of the browser's storage Chora needs to open a dataset, and to save it: estimated before
// either starts, so that a browser short of room is named as the cause before a long run fails, not
// after. The factors are from the full-size run of 30 September 2026 (DEEP: 539,372 places,
// 1,414,328 attestations), measured in Node on the same engine, with a margin of about a tenth:
//
//   input read, uncompressed:   JSON Lines 1.185 GB (51 MB gzipped); N-Triples 2.718 GB (141 MB gzipped)
//   opening it:                 Chora's database 1.40 GB, either way; from N-Triples, a triple store of
//                               3.35 GB beside it while it is read
//   saving it:                  the file 1.14 GB; Mneme's ledger 1.27 GB (from JSON Lines) or 0.89 GB
//                               (from N-Triples, with a triple store of 3.35 GB for each RDF reading)
//
// Chora's database is already held when a save starts, and counts in the browser's `usage`.

/** Names read as RDF (N-Triples, N-Quads, Turtle), which go through a triple store on disk. */
const RDF = /\.(nt|nq|ttl|n3|rdf)(\.gz)?$/i;
const isRdf = (name) => RDF.test(String(name || ''));
// PLATO's text compresses by far more than this (DEEP's by about 20 to 1); a gzip trailer that says
// less has most likely wrapped past 4 GB. Wrongly taken so, the estimate is 4 GB too high: a warning
// given that need not have been, which is the side to err on.
const MIN_RATIO = 4;
// What DEEP's exports compress by (23:1 JSON Lines, 19:1 N-Triples, 21:1 LPF), for a file whose trailer cannot be read.
const TYPICAL_RATIO = 20;

/**
 * The size a file will be read at: its own, or, gzipped, the size its trailer gives (the last four
 * bytes, `trailer`, little-endian), which is the uncompressed size modulo 2^32: 4 GB is added until it
 * is at least four times the compressed size. Without a trailer, a guess from DEEP's ratio.
 */
export function uncompressedSize(file, trailer) {
  if (!/\.gz$/i.test(file.name || '')) return file.size;
  if (!trailer || trailer.length < 4) return file.size * TYPICAL_RATIO;
  let n = (trailer[0] | (trailer[1] << 8) | (trailer[2] << 16)) + trailer[3] * 2 ** 24;
  // Only a file of more than 4 MB can hold more than 4 GB (deflate compresses by 1,032:1 at most), so a
  // small one whose gzip overhead outweighs its text is taken at its word.
  if (file.size > 2 ** 32 / 1032) while (n < file.size * MIN_RATIO) n += 2 ** 32;
  return n;
}

/**
 * The storage opening a dataset needs, for `bytes` read (uncompressed) from a file called `name`:
 * Chora's database, about 1.2 times what is read (1.40 GB for DEEP's 1.185 GB of JSON Lines), and from
 * RDF, whose records are much smaller than its text (DEEP's N-Triples are 2.3 times its JSON Lines), a
 * triple store of 1.25 times the text besides.
 */
export function loadNeed({ name, bytes }) {
  return isRdf(name) ? bytes * (1.25 + 0.6) * 1.1 : bytes * 1.2 * 1.1;
}

/**
 * The storage a save needs beyond what the open dataset already holds: the file written (about the
 * size of the records, which is what a JSON input reads at, and 0.42 times an RDF input), Mneme's
 * ledger (up to 1.12 times the file), and for RDF a triple store of 1.25 times the text.
 */
export function saveNeed({ name, bytes }) {
  const file = isRdf(name) ? bytes * 0.42 : bytes;
  return (file * 2.12 + (isRdf(name) ? bytes * 1.25 : 0)) * 1.1;
}

/**
 * Whether `need` bytes fit in what navigator.storage.estimate() says is left: null when they do, or
 * when the browser does not say; else { need, free, quota }.
 */
export function storageShort(need, estimate) {
  if (!estimate || !Number.isFinite(estimate.quota)) return null;
  const free = estimate.quota - (Number.isFinite(estimate.usage) ? estimate.usage : 0);
  return need > free ? { need, free, quota: estimate.quota } : null;
}

/** Above this size read, the browser is asked to keep Chora's storage (navigator.storage.persist()). */
export const PERSIST_ABOVE = 200e6;
export const shouldPersist = (bytes) => bytes > PERSIST_ABOVE;
