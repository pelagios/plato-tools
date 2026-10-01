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
const RDF_FORMATS = new Set(['ntriples', 'nquads', 'turtle']);
/**
 * How a dataset is read, which decides the storage it needs: 'rdf' (a triple store of its text beside
 * Chora's database), 'store' (JSON gathered in a triple store first: attestation-centric PLATO and W3C
 * annotations, the pipeline's needsStore in src/engine/pipeline.js), or 'json'. From `input` (detect()'s
 * { format, profile }) when it is known, else from the name.
 */
function readAs(name, input) {
  if (input && input.format) {
    if (RDF_FORMATS.has(input.format)) return 'rdf';
    return input.profile === 'attestation-centric' || input.format === 'w3c-annotations' ? 'store' : 'json';
  }
  return RDF.test(String(name || '')) ? 'rdf' : 'json';
}
// PLATO's text compresses by far more than this (DEEP's by about 20 to 1): a gzip trailer that says
// less is not believed. It may have wrapped past 4 GB, or the file be text that compresses poorly; the
// larger of it and the typical ratio is taken, which errs toward a warning given that need not have been.
const MIN_RATIO = 4;
// What DEEP's exports compress by (23:1 JSON Lines, 19:1 N-Triples, 21:1 LPF), for a file whose trailer cannot be believed.
const TYPICAL_RATIO = 20;
// How much of a gzip's end is looked through for the header of a member after the first: BGZF blocks
// (bgzip) are at most 64 KiB, so a bgzip file always has one there.
export const GZIP_TAIL = 65536;

const isGzipHead = (h) => !!h && h.length >= 2 && h[0] === 0x1f && h[1] === 0x8b;
/** Whether a first gzip header says it is BGZF (bgzip): FEXTRA set, with a subfield 'BC'. */
function isBgzf(h) {
  if (!h || h.length < 16 || !(h[3] & 4)) return false;
  const xlen = h[10] | (h[11] << 8);
  for (let i = 12; i + 4 <= Math.min(h.length, 12 + xlen); ) {
    if (h[i] === 0x42 && h[i + 1] === 0x43) return true;
    i += 4 + (h[i + 2] | (h[i + 3] << 8));
  }
  return false;
}
/**
 * Whether `tail` (the last bytes of a gzip file, from byte `from` of it) holds the header of a member
 * after the first: the magic, deflate, no reserved flags, an XFL and an OS gzip writes. Found by chance
 * in compressed data about once in 10^11 bytes, and then the estimate is only larger.
 */
function laterMember(tail, from) {
  for (let i = 0; i + 10 <= tail.length - 8; i++) {
    if (tail[i] !== 0x1f || tail[i + 1] !== 0x8b || tail[i + 2] !== 8 || from + i === 0) continue;
    if ((tail[i + 3] & 0xe0) === 0 && [0, 2, 4].includes(tail[i + 8]) && (tail[i + 9] <= 13 || tail[i + 9] === 255)) return true;
  }
  return false;
}

/**
 * The size a file will be read at, from its size and bytes read from it: `head`, its first bytes (at
 * least 2; 18 to see a bgzip header), and `tail`, its last bytes (at least 8, the gzip trailer; up to
 * GZIP_TAIL to find a later member). A file is gzipped when it begins with gzip's two bytes, whatever
 * its name. A gzip of one member is read at the size its trailer gives (ISIZE, the uncompressed size
 * modulo 2^32), unless that is less than MIN_RATIO times the compressed size, when the typical ratio
 * is taken if larger. A gzip of several members (bgzip, or gzips concatenated) has in its trailer the
 * size of its last member only, so the typical ratio is taken if larger. Without a trailer, the
 * typical ratio.
 */
export function uncompressedSize(file, { head, tail } = {}) {
  if (!isGzipHead(head)) return file.size;
  const typical = file.size * TYPICAL_RATIO;
  if (!tail || tail.length < 8) return typical;
  const t = tail.length - 4;
  const n = (tail[t] | (tail[t + 1] << 8) | (tail[t + 2] << 16)) + tail[t + 3] * 2 ** 24;
  if (isBgzf(head) || laterMember(tail, file.size - tail.length)) return Math.max(n, typical);
  // Only a file of more than 4 MB can hold more than 4 GB (deflate compresses by 1,032:1 at most), so
  // the trailer of a small one of one member is exact, even when its gzip overhead outweighs its text.
  if (file.size <= 2 ** 32 / 1032) return n;
  return n < file.size * MIN_RATIO ? Math.max(n, typical) : n;
}

/** The size a File (or Blob with a name) will be read at: uncompressedSize() of its first and last bytes. */
export async function sizeRead(file) {
  const bytes = async (a, b) => { try { return new Uint8Array(await file.slice(a, b).arrayBuffer()); } catch { return null; } };
  const head = await bytes(0, 18);
  if (!isGzipHead(head)) return file.size;
  return uncompressedSize(file, { head, tail: file.size >= 18 ? await bytes(Math.max(0, file.size - GZIP_TAIL), file.size) : null });
}

/**
 * The storage opening a dataset needs, for `bytes` read (uncompressed) from a file called `name`, read
 * as `input` says (detect()'s { format, profile }, when known): Chora's database, about 1.2 times what
 * is read (1.40 GB for DEEP's 1.185 GB of JSON Lines), and from RDF, whose records are much smaller
 * than its text (DEEP's N-Triples are 2.3 times its JSON Lines), a triple store of 1.25 times the text
 * besides. JSON gathered in a triple store (attestation-centric, annotations) has a store of its
 * triples, 2.3 times its text taken at 1.25: not measured, but from the same run's factors.
 */
export function loadNeed({ name, bytes, input }) {
  const as = readAs(name, input);
  return as === 'rdf' ? bytes * (1.25 + 0.6) * 1.1 : as === 'store' ? bytes * (1.2 + STORE_OF_JSON) * 1.1 : bytes * 1.2 * 1.1;
}
const STORE_OF_JSON = 1.25 * 2.3;

/**
 * The storage a save needs beyond what the open dataset already holds: the file written (about the
 * size of the records, which is what a JSON input reads at, and 0.42 times an RDF input), Mneme's
 * ledger (up to 1.12 times the file), and a triple store where the input is read through one: 1.25
 * times the text for RDF, as loadNeed() has it for JSON.
 */
export function saveNeed({ name, bytes, input }) {
  const as = readAs(name, input);
  const file = as === 'rdf' ? bytes * 0.42 : bytes;
  return (file * 2.12 + (as === 'rdf' ? bytes * 1.25 : as === 'store' ? bytes * STORE_OF_JSON : 0)) * 1.1;
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
