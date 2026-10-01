// Reading inputs as streams. Nothing here holds a whole file: gzip is decompressed as it arrives,
// text is cut into lines or parsed incrementally, and JSON documents are parsed with a streaming
// parser that hands over one record at a time. Works on browser File objects and on Node's File.
// Vendored, with the one change that keeps a U+FEFF inside a string: see src/vendor/streamparser-json/.
import { JSONParser, Tokenizer, TokenizerError, TokenType } from '../vendor/streamparser-json/index.js';
import Papa from 'papaparse';

/**
 * The file's content stopped the reader: JSON that is not well formed or stops early, or
 * compressed data that is damaged or cut short. It is a problem in the data, for the report, not
 * a failure of the tools; run() turns it into an error in the report.
 */
export class DataError extends Error {
  constructor(message) { super(message); this.name = 'DataError'; }
}
/**
 * Read a chunk, saying in plain words when the bytes themselves cannot be read or decompressed. A
 * DataError from the stream (text that is not UTF-8) is passed on as it is.
 */
async function readChunk(reader) {
  try { return await reader.read(); }
  catch (e) { throw e instanceof DataError ? e : new DataError(`The file stops, or is damaged, part-way through, so it cannot be read to the end (${String(e && (e.message || e.name) || e).split('\n')[0]}).`); }
}

export async function isGzip(file) {
  const b = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return b[0] === 0x1f && b[1] === 0x8b;
}

// ---- UTF-8, strictly ----------------------------------------------------------------------------
// Every text input is decoded as UTF-8, and a byte that is not UTF-8 stops the file: decoded
// leniently, a Windows-1252 or Latin-1 file would have its letters replaced (Köln read as K�ln)
// without a word. A byte-order mark is allowed, and dropped.
/** The index of the first byte of `b` that cannot begin or continue UTF-8, or -1 (a sequence cut off at the end is not counted). */
export function firstNonUtf8(b) {
  for (let i = 0; i < b.length;) {
    const x = b[i];
    if (x < 0x80) { i++; continue; }
    const len = x >= 0xc2 && x <= 0xdf ? 2 : x >= 0xe0 && x <= 0xef ? 3 : x >= 0xf0 && x <= 0xf4 ? 4 : 0;
    if (!len) return i;
    const lo = x === 0xe0 ? 0xa0 : x === 0xf0 ? 0x90 : 0x80, hi = x === 0xed ? 0x9f : x === 0xf4 ? 0x8f : 0xbf;
    for (let k = 1; k < len; k++) {
      if (i + k >= b.length) return -1;
      const c = b[i + k];
      if (c < (k === 1 ? lo : 0x80) || c > (k === 1 ? hi : 0xbf)) return i;
    }
    i += len;
  }
  return -1;
}
/** The DataError for a file that is not UTF-8; `at` says where, when it is known ("on line 3, byte 57"). */
export function notUtf8(name, at = '') {
  const gz = /\.gz$/i.test(name) ? ' of its decompressed text' : '';
  return new DataError(`${name} is not encoded as UTF-8${at ? `: the first byte${gz} that is not is ${at}` : ''}, so its letters cannot be read as they were meant (it may be in a Windows or Latin-1 encoding, where é or ö are single bytes). Save it as UTF-8 and try again: in Excel, “Save As” and choose “CSV UTF-8”; in LibreOffice, choose the character set “Unicode (UTF-8)”.`);
}
const AT_END = 'at its very end, where a character stops part-way';
/**
 * Where the first byte of `b` that is not UTF-8 is, in words, given the bytes and lines before `b`
 * (`whole` when `b` is all there is). `b` begins with the bytes of a character the bytes before it
 * left unfinished, if any, so that a character begun in one chunk and broken in the next is placed
 * at its first byte.
 */
function whereNotUtf8(b, bytes, lines, whole = false) {
  const found = firstNonUtf8(b);
  if (found < 0 && whole) return AT_END;
  const i = Math.max(found, 0);
  let n = lines;
  for (let k = 0; k < i; k++) if (b[k] === 0x0a) n++;
  return `on line ${n.toLocaleString('en-GB')} (byte ${(bytes + i + 1).toLocaleString('en-GB')})`;
}
/** How many bytes at the end of `b` (valid UTF-8 so far) are a character not yet finished: 0 to 3. */
function unfinished(b) {
  for (let k = 1; k <= Math.min(3, b.length); k++) {
    const x = b[b.length - k];
    if (x >= 0x80 && x <= 0xbf) continue;
    return (x >= 0xf0 ? 4 : x >= 0xe0 ? 3 : x >= 0xc0 ? 2 : 1) > k ? k : 0;
  }
  return 0;
}
/** Bytes -> text, strictly: a TransformStream that stops with notUtf8, saying where, at the first byte that is not UTF-8. */
export function strictUtf8(name) {
  const dec = new TextDecoder('utf-8', { fatal: true });
  // `carry`: the bytes of a character the chunks so far left unfinished (no line break among them).
  let bytes = 0, lines = 1, carry = new Uint8Array(0);
  return new TransformStream({
    transform(chunk, ctl) {
      let t;
      try { t = dec.decode(chunk, { stream: true }); }
      catch {
        const all = carry.length ? new Uint8Array(carry.length + chunk.length) : chunk;
        if (carry.length) { all.set(carry); all.set(chunk, carry.length); }
        throw notUtf8(name, whereNotUtf8(all, bytes - carry.length, lines));
      }
      bytes += chunk.length;
      for (let k = 0; k < chunk.length; k++) if (chunk[k] === 0x0a) lines++;
      const tail = chunk.length >= 3 ? chunk.subarray(chunk.length - 3) : Uint8Array.of(...carry, ...chunk).slice(-3);
      carry = tail.slice(tail.length - unfinished(tail));
      if (t) ctl.enqueue(t);
    },
    flush(ctl) {
      let t;
      try { t = dec.decode(); } catch { throw notUtf8(name, AT_END); }
      if (t) ctl.enqueue(t);
    },
  });
}
/** Bytes (a whole file's, or a file's in a zip) as text, strictly (notUtf8 names `name`). */
export function decodeUtf8(bytes, name) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw notUtf8(name, whereNotUtf8(bytes, 0, 1, true)); }
}
/**
 * The text of a file as a stream, decompressed and decoded as UTF-8. `lenient` replaces a byte that
 * is not UTF-8 instead of stopping, for detection only, which looks at the start of the file to
 * tell its format, and leaves the fault to the reader, which reports it.
 */
export async function textStream(file, { lenient = false } = {}) {
  let s = file.stream();
  if (await isGzip(file)) s = s.pipeThrough(new DecompressionStream('gzip'));
  return s.pipeThrough(lenient ? new TextDecoderStream() : strictUtf8(file.name));
}
/** Text chunks that each end on a line break (the last may not). */
export async function* lineChunks(file) {
  const reader = (await textStream(file)).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await readChunk(reader);
    if (done) break;
    // Only the new text is searched: a long line, searched whole at every chunk, took quadratic time.
    const i = value.lastIndexOf('\n');
    if (i < 0) { buf += value; continue; }
    yield buf + value.slice(0, i + 1);
    buf = value.slice(i + 1);
  }
  if (buf) yield buf.endsWith('\n') ? buf : buf + '\n';
}
export async function* lines(file) {
  let n = 0;
  for await (const chunk of lineChunks(file)) {
    // Each chunk ends on a line break, so the part after its last is not a line: counted, it put
    // every line after a chunk boundary one further on.
    const parts = chunk.split('\n'); parts.pop();
    for (const line of parts) { n++; if (line.trim()) yield { line, n }; }
  }
}
/** The first `bytes` of a file as text (decompressed, and decoded leniently: textStream), for format detection. */
export async function head(file, bytes = 65536) {
  const reader = (await textStream(file, { lenient: true })).getReader();
  let s = '';
  // Detection needs only the start: if the file breaks within it, use what came before the break,
  // and leave the break to the check, which reports it.
  try { while (s.length < bytes) { const { value, done } = await readChunk(reader); if (done) break; s += value; } }
  catch (e) { if (!(e instanceof DataError) || !s) throw e; }
  reader.cancel().catch(() => {});
  return s;
}
/** How far detection reads, at most, for a first line or a document's top-level keys (characters). */
export const DETECT_CAP = 16 * 2 ** 20;
/**
 * The first line of a file that has one (after any blank lines), read to its end however many
 * chunks that takes, up to `cap` characters: { line, capped, ended } (ended: an end of line was
 * found after it, so that it is the whole line and not all the file there is).
 */
export async function firstLine(file, cap = DETECT_CAP) {
  // Decoded leniently, as head() is: a byte that is not UTF-8 is left to the reader, which says where.
  const reader = (await textStream(file, { lenient: true })).getReader();
  // Chunks are kept apart and searched one by one: a string grown and searched whole each time is
  // copied each time, and a long line took quadratic time.
  const parts = []; let size = 0, started = false, ended = false;
  try {
    for (;;) {
      const { value, done } = await readChunk(reader);
      if (done) break;
      let v = value;
      if (!started) { v = v.trimStart(); if (!v) continue; started = true; }
      const nl = v.indexOf('\n');
      if (nl >= 0) { parts.push(v.slice(0, nl)); ended = true; break; }
      parts.push(v); size += v.length;
      if (size >= cap) break;
    }
  } finally { reader.cancel().catch(() => {}); }
  // A break within the line is thrown, not read past: part of a line is not JSON, and saying so
  // hid that the file is damaged or cut short.
  return { line: parts.join(''), capped: !ended && size >= cap, ended };
}
/**
 * The string values of the given top-level keys of a JSON document, read token by token (nothing
 * of the values is held), until all are found, its `profile` or `type` is met (a PLATO document has
 * a profile and no type, so the others matter only without one: reading on for them read a large
 * PLATO document to the cap; after a type of FeatureCollection it reads on for the @context, which
 * says whether it is LPF, as far as the features; a type that is not a string, as an AnnotationPage
 * may have, is met too), the document closes or breaks, or `cap` characters have been read.
 * Decoded leniently, as head() is: a byte that is not UTF-8 is left to the reader, which reports it.
 * Returns { found, seen, capped }: the strings found, the top-level keys seen, and whether the cap
 * stopped the reading (so that what was not found may lie past it).
 */
async function topLevelStrings(file, wanted, cap = DETECT_CAP) {
  const found = {}, seen = new Set();
  let stopped = false;
  const tokenizer = new Tokenizer();
  let depth = 0, expect = null, key = null;
  tokenizer.onToken = ({ token, value }) => {
    if (depth === 1) {
      if (expect === 'value') {
        expect = null;
        if (wanted.includes(key) && token === TokenType.STRING) { found[key] = value; if (key === 'profile' || key === 'type' && value !== 'FeatureCollection' || 'type' in found && '@context' in found || wanted.every((k) => k in found)) throw STOP; }
        // A type that is a list (an AnnotationPage's ["AnnotationPage"]) or an object is the type
        // met: reading on read such a document to the cap for nothing.
        else if (key === 'type') throw STOP;
        else if (key === 'features' && found.type === 'FeatureCollection') throw STOP;
      }
      else if (expect === 'key' && token === TokenType.STRING) { key = value; seen.add(key); expect = null; }
      else if (token === TokenType.COLON) expect = 'value';
      else if (token === TokenType.COMMA) expect = 'key';
    }
    if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) { if (depth++ === 0) { if (token !== TokenType.LEFT_BRACE) throw STOP; expect = 'key'; } }
    else if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) { if (--depth === 0) throw STOP; }
  };
  const reader = (await textStream(file, { lenient: true })).getReader();
  let read = 0;
  try {
    while (read < cap) {
      const { value, done } = await readChunk(reader);
      if (done) { stopped = true; break; }
      read += value.length;
      tokenizer.write(value);
    }
  } catch (e) {
    stopped = true;
    // STOP, or the document breaks here (it is not well formed, or its bytes cannot be read): what
    // was found before it stands, and the check reports the break. Anything else is a fault of the
    // tools, and is not passed off as the document's.
    if (e !== STOP && !(e instanceof TokenizerError) && !(e instanceof DataError)) throw e;
  } finally { reader.cancel().catch(() => {}); }
  return { found, seen, capped: !stopped };
}

const STOP = Symbol('stop');
const SHAPE = { [TokenType.LEFT_BRACE]: 'an object', [TokenType.STRING]: 'a string', [TokenType.NUMBER]: 'a number', [TokenType.TRUE]: 'true', [TokenType.FALSE]: 'false', [TokenType.NULL]: 'null' };
/**
 * Stream a JSON document, yielding { path, value } for each element of the arrays named in
 * `arrays` (e.g. ['spatialEntities', 'identityRelations']) and each top-level key in `keys`, and
 * { path, notAList } for one of `arrays` given as something else ('an object', 'a number', …).
 */
export async function* jsonDocument(file, { arrays = [], keys = [], onlyKeys = false } = {}) {
  const paths = [...arrays.map((a) => `$.${a}.*`), ...keys.map((k) => `$.${k}`)];
  const parser = new JSONParser({ paths, keepStack: false });
  const queue = [];
  // A list given as something else never matches its elements' path, so it would pass in silence:
  // the top level's keys are followed token by token, which holds nothing of the values.
  if (arrays.length && !onlyKeys) {
    let depth = 0, expect = null, key = null;
    parser.onToken = ({ token, value }) => {
      if (depth === 1) {
        if (expect === 'value') { expect = null; if (arrays.includes(key) && token !== TokenType.LEFT_BRACKET) queue.push({ path: key, notAList: SHAPE[token] }); }
        else if (expect === 'key' && token === TokenType.STRING) { key = value; expect = null; }
        else if (token === TokenType.COLON) expect = 'value';
        else if (token === TokenType.COMMA) expect = 'key';
      }
      if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) { if (depth++ === 0 && token === TokenType.LEFT_BRACE) expect = 'key'; }
      else if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) depth--;
    };
  }
  parser.onValue = ({ value, key, stack, parent }) => {
    const top = stack[1]?.key ?? key;
    if (arrays.includes(top) && typeof key === 'number') { if (onlyKeys) throw STOP; queue.push({ path: top, value }); }
    else if (keys.includes(key) && stack.length === 1) queue.push({ path: key, value });
  };
  const reader = (await textStream(file)).getReader();
  let stopped = false;
  try {
    for (;;) {
      const { value, done } = await readChunk(reader);
      if (done) break;
      try { parser.write(value); } catch (e) {
        if (e === STOP) { reader.cancel().catch(() => {}); stopped = true; break; }
        throw new DataError(`The JSON is not well formed, so the file cannot be read past that point (${String(e && e.message || e).split('\n')[0]}).`);
      }
      while (queue.length) yield queue.shift();
    }
    // The parser ends itself when the document closes; if the input ran out first, the document
    // was cut short, and saying so is the difference between a truncated file and a clean check.
    if (!stopped && !parser.isEnded) {
      try { parser.end(); } catch (e) { throw new DataError(`The JSON document stops before it is complete, so the file may have been cut short (${String(e.message).split('.')[0]}).`); }
    }
    while (queue.length) yield queue.shift();
  } finally { reader.releaseLock?.(); }
}

/**
 * Stream the W3C Web Annotations of a JSON document, one at a time, whatever its shape: a JSON
 * array of annotations (as Recogito and Recogito Studio export them), an AnnotationPage (its items),
 * an AnnotationCollection (its first page's items), or one annotation. Yields { annotation } for
 * each, and { label } or { next } for what the collection or page says of itself.
 */
export async function* annotationItems(file, shape) {
  const paths = shape === 'array' ? ['$.*'] : shape === 'page' ? ['$.items.*', '$.label', '$.next']
    : shape === 'collection' ? ['$.first.items.*', '$.items.*', '$.label', '$.first', '$.first.next'] : ['$'];
  const parser = new JSONParser({ paths, keepStack: false });
  const queue = [];
  parser.onValue = ({ value, key, stack }) => {
    const top = stack[1]?.key;
    if (shape === 'array' || shape === 'annotation') { if (stack.length <= 1) queue.push({ annotation: value }); return; }
    if (typeof key === 'number') { queue.push({ annotation: value }); return; }
    if (key === 'label' && stack.length === 1) queue.push({ label: value });
    else if (key === 'next' && typeof value === 'string') queue.push({ next: value });
    else if (key === 'first' && top === undefined && typeof value === 'string') queue.push({ next: value });
  };
  const reader = (await textStream(file)).getReader();
  try {
    for (;;) {
      const { value, done } = await readChunk(reader);
      if (done) break;
      try { parser.write(value); } catch (e) {
        throw new DataError(`The JSON is not well formed, so the file cannot be read past that point (${String(e && e.message || e).split('\n')[0]}).`);
      }
      while (queue.length) yield queue.shift();
    }
    if (!parser.isEnded) {
      try { parser.end(); } catch (e) { throw new DataError(`The JSON document stops before it is complete, so the file may have been cut short (${String(e.message).split('.')[0]}).`); }
    }
    while (queue.length) yield queue.shift();
  } finally { reader.releaseLock?.(); }
}

// ---- detection ----------------------------------------------------------------------------------
export const TABLE_SHEETS = ['about', 'places', 'sources', 'names', 'locations', 'types', 'relations', 'connections', 'properties', 'identities'];
const base = (name) => name.replace(/\.gz$/i, '').toLowerCase();
// The column each sheet begins with, where it is not place_id (csv-metadata.json).
const SHEET_FIRST_COLUMN = { about: 'title', sources: 'source_id' };
/** The sheet a CSV file is named after (places.csv, names.csv.gz…), or null. */
export const sheetOf = (name) => { const s = base(name).split('/').pop().replace(/\.csv$/, ''); return TABLE_SHEETS.includes(s) ? s : null; };
/**
 * Which of these CSV files are sheets of one set of PLATO spreadsheet tables: those named after a
 * sheet when there are several, or the one so named when its header begins with its sheet's first
 * column (a places.csv of one's own is not the tables). Only that one file's first line is read.
 */
export async function tableSheets(files) {
  const named = files.filter((f) => sheetOf(f.name));
  if (named.length !== 1) return named;
  let first;
  // The delimiter is guessed as the tables reader guesses it (Papa), so that a places.csv separated
  // by semicolons or tabs is still the tables. A file that cannot be read is left to the tables
  // reader, which says so; any other error is a fault in the tools, and is not hidden.
  try { first = String(Papa.parse((await head(named[0], 4096)).replace(/^\uFEFF/, ''), { preview: 1, skipEmptyLines: 'greedy' }).data[0]?.[0] ?? '').trim(); }
  catch (e) { if (e instanceof DataError) return named; throw e; }
  const sheet = sheetOf(named[0].name);
  return first === (SHEET_FIRST_COLUMN[sheet] || 'place_id') ? named : [];
}

/**
 * Group the chosen files into one input and say what it is:
 *   tables (10 CSVs, a zip or a workbook), plato-json, plato-jsonl, lpf, lpf-seq, ntriples, nquads, turtle,
 *   w3c-annotations (W3C Web Annotations, as Recogito exports them; `shape` says how they are held).
 */
export async function detect(files) {
  const names = files.map((f) => base(f.name));
  const csvs = files.filter((f, i) => names[i].endsWith('.csv'));
  if (csvs.length && csvs.length === files.length) return csvSetKind(files);
  if (files.length !== 1) return detectGroup(files);
  const f = files[0], n = names[0];
  if (n.endsWith('.zip')) {
    // A zip is the tables only when a file in it is named after a sheet; one that holds none (a
    // gazetteer's download, say) is refused, saying what it holds.
    let entries = null;
    try { entries = await zipEntries(f); } catch (e) { if (!(e instanceof DataError)) throw e; }
    const inside = entries && entries.map((x) => x.name).filter((x) => !x.endsWith('/'));
    if (inside && !inside.some((x) => sheetOf(x))) return { format: null, reason: zipReason(inside) };
    // The size of the sheets' text, from the central directory, for the page's storage estimate (storage.js).
    const textBytes = entries ? entries.filter((x) => x.name.toLowerCase().endsWith('.csv') && sheetOf(x.name)).reduce((n, x) => n + x.usize, 0) : undefined;
    return { format: 'tables', container: 'zip', files, ...(textBytes !== undefined ? { textBytes } : {}) };
  }
  if (n.endsWith('.xlsx') || n.endsWith('.ods')) return { format: 'tables', container: 'workbook', files };
  if (n.endsWith('.tsv') || n.endsWith('.tab')) return (await headerless(f, '\t')) ? { format: null, reason: HEADERLESS_REASON } : { format: 'csv', delimiter: '\t', files };
  if (n.endsWith('.nt')) return { format: 'ntriples', files };
  if (n.endsWith('.nq')) return { format: 'nquads', files };
  if (n.endsWith('.ttl')) return { format: 'turtle', files };
  let h;
  try { h = (await head(f)).trimStart(); }
  catch (e) { if (e instanceof DataError) return { format: null, reason: `${e.message} Nothing could be read from it.` }; throw e; }
  if (n.endsWith('.jsonl') || n.endsWith('.ndjson') || n.endsWith('.geojsonl') || n.endsWith('.geojsons') || /^\{[^\n]*\}\s*\n\s*\{/.test(h)) {
    // The first line is read whole, however long: gzipped, it may arrive in many chunks.
    let line = h.split('\n')[0], ended = h.includes('\n');
    if (!ended) {
      let capped;
      try { ({ line, capped, ended } = await firstLine(f)); }
      catch (e) { if (e instanceof DataError) return { format: null, reason: `${e.message} Its first line could not be read whole, so what the file is cannot be told from it.` }; throw e; }
      if (capped) return { format: null, reason: `This looks like JSON Lines, but its first line is longer than ${DETECT_CAP / 2 ** 20} MB, so what the file is cannot be told from it.` };
    }
    let first;
    try { first = JSON.parse(line); }
    catch (e) {
      // The file ends within its first line, and the line is JSON as far as it goes: the file has
      // most likely been cut short, which is what to look at, not the JSON.
      if (!ended && stopsShort(line)) return { format: null, reason: `This looks like JSON Lines, but the file ends part-way through its first line (${e.message}): the file may be cut short, so what it is cannot be told from it.` };
      return { format: null, reason: `This looks like JSON Lines, but its first line is not valid JSON (${e.message}), so what the file is cannot be told from it.` };
    }
    if (!first || typeof first !== 'object' || Array.isArray(first)) return { format: null, reason: 'This looks like JSON Lines, but its first line is not a JSON object, so it is neither a PLATO header, an LPF feature nor a W3C Web Annotation.' };
    if (first.profile) return { format: 'plato-jsonl', profile: first.profile, files };
    if (first.type === 'Feature' || first.type === 'FeatureCollection') {
      // Linked Places Format only by its structure, as for a FeatureCollection below: the collection's
      // own line naming LPF's context, or the first feature (the first line, or the first after the
      // collection's) carrying LPF's own members. A sequence of plain GeoJSON features is not read.
      const feature = first.type === 'Feature' ? first : h.split('\n').slice(1).map((l) => jsonHead(l.trim())).find((v) => v?.type === 'Feature');
      if (isLpf(first) || (feature && isLpf(feature))) return { format: 'lpf-seq', files, lpfVersion: lpfVersion(first) };
      return { format: null, reason: GEOJSON_SEQ_REASON };
    }
    if (isAnnotation(first)) return { format: 'w3c-annotations', shape: 'jsonl', files };
    return { format: null, reason: 'This is JSON Lines, but its first line is neither a PLATO header, an LPF feature nor a W3C Web Annotation.' };
  }
  if (h.startsWith('{')) {
    // Read as far as the head goes, as structure (null where it is not well formed): a test of the
    // text would take a property that is only called "toponym" for Linked Places Format.
    const top = jsonHead(h);
    // A IIIF Georeference Annotation (Allmaps) is an annotation too, so it is told apart first.
    const georef = georefOf(top);
    if (georef) return { format: 'georef', ...georef, reason: GEOREF_REASON, files };
    if (isManifest(top)) return { format: 'manifest', reason: MANIFEST_REASON, files };
    // The document's own profile, type and @context may come after a long member (a gazetteer, a
    // title), past the head, so its top-level keys are read as far as they go; the head's text is
    // the fallback it always was.
    const { found: keys, seen, capped } = await topLevelStrings(f, ['profile', 'type', '@context']);
    const profile = keys.profile ?? (h.match(/"profile"\s*:\s*"([a-z-]+)"/) || [])[1];
    if (profile === 'place-centric' || profile === 'attestation-centric') return { format: 'plato-json', profile, files };
    // The document's own type, at its top level: a "type" anywhere in the head may be a feature's,
    // within features that come before the collection's own type.
    const type = keys.type ?? (typeof top?.type === 'string' ? top.type : undefined);
    // Features, and no type within the cap: most likely a FeatureCollection whose type comes after
    // its features, but whether it is LPF (by an @context that may also lie past the cap) or plain
    // GeoJSON cannot be told, and a guess would be read whole by the wrong reader; so it is refused.
    if (type === undefined && capped && seen.has('features')) return { format: null, reason: `This JSON document has "features" but no "type" within its first ${DETECT_CAP / 2 ** 20} MB, so whether it is a GeoJSON or LPF FeatureCollection cannot be told. Put the collection's "type" (and any "@context") before its features.` };
    if (type === 'FeatureCollection') {
      if (!isLpf(top) && !isLpf({ '@context': keys['@context'] })) return { format: 'geojson', shape: 'collection', files };
      return { format: 'lpf', files, lpfVersion: lpfVersion({ '@context': keys['@context'] ?? top?.['@context'] ?? (h.match(/"@context"\s*:\s*"([^"]+)"/) || [])[1] }) };
    }
    const shape = annotationShape(h, false, keys);
    if (shape) return { format: 'w3c-annotations', shape, files };
    // One GeoJSON Feature on its own (tested after the annotations, whose bodies may hold Features).
    if (type === 'Feature' && !isLpf(top)) return { format: 'geojson', shape: 'feature', files };
    return { format: null, reason: 'This JSON document is neither a PLATO submission (it has no "profile"), an LPF FeatureCollection, nor W3C Web Annotations.' };
  }
  if (h.startsWith('[')) {
    if (annotationShape(h, true)) return { format: 'w3c-annotations', shape: 'array', files };
    return { format: null, reason: 'This JSON array is not a list of W3C Web Annotations (as Recogito exports them): the first annotations do not name the Web Annotation context.' };
  }
  // XML, before the N-Triples test, which an XML declaration followed by an element would also pass:
  // TEI P5 (src/engine/hermes/tei.js) is read; any other XML is refused, saying what it is.
  const xml = xmlKind(h);
  if (xml === 'tei') return { format: 'tei', files };
  if (xml) return { format: null, reason: XML_REASONS[xml] };
  if (/^(@prefix|@base|PREFIX|BASE)\b/i.test(h)) return { format: 'turtle', files };
  if (/^(<[^>]+>|_:\S+)\s+<[^>]+>/.test(h)) return { format: 'ntriples', files };
  return { format: null, reason: 'The format of this file could not be recognised.' };
}
export const GEOJSON_SEQ_REASON = 'This is a GeoJSON sequence (one feature per line), but not Linked Places Format, and a sequence of plain GeoJSON features is not read. Give the features as one FeatureCollection (a .geojson file), where their properties can be matched to PLATO.';
// W3C Web Annotations name the Web Annotation context (alone, or in a list of contexts).
const ANNO_CONTEXT = /"@context"\s*:\s*(?:\[[^\]]*?)?"https?:\/\/www\.w3\.org\/ns\/anno\.jsonld"/;
const isAnnotation = (o) => !!o && typeof o === 'object' && [].concat(o['@context']).some((c) => typeof c === 'string' && /^https?:\/\/www\.w3\.org\/ns\/anno\.jsonld$/.test(c))
  && [].concat(o.type).includes('Annotation');
/**
 * How a JSON document that begins `h` holds annotations: 'array' | 'collection' | 'page' | 'annotation' | null.
 * `keys` are its top-level @context and type as the scan past the head found them (topLevelStrings).
 */
function annotationShape(h, array, keys = {}) {
  if (!ANNO_CONTEXT.test(h) && !isAnnotation({ '@context': keys['@context'], type: 'Annotation' })) return null;
  const typed = (t) => keys.type === t || new RegExp(`"type"\\s*:\\s*(?:\\[[^\\]]*?)?"${t}"`).test(h);
  if (array) return typed('Annotation') ? 'array' : null;
  if (typed('AnnotationCollection')) return 'collection';
  if (typed('AnnotationPage')) return 'page';
  return typed('Annotation') ? 'annotation' : null;
}
// TEI (Hermes): past the XML declaration, processing instructions, comments and a DOCTYPE, the
// root element is TEI or teiCorpus, and it (or its prefix) is bound to the TEI namespace. In the
// DOCTYPE, a quoted literal or a comment is passed over whole, so that a ] or > in one does not end
// the internal subset or the DOCTYPE.
const XML_PROLOG = /^(?:\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE(?:"[^"]*"|'[^']*'|[^[>"']|\[(?:<!--[\s\S]*?-->|"[^"]*"|'[^']*'|<(?!!--)|[^\]"'<])*\])*>)*/;
const XML_ROOT = /^<(?:([A-Za-z_][\w.-]*):)?([A-Za-z_][\w.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/;
// The start of an element (a name, with or without a prefix), as far as the head goes; an IRI in
// angle brackets, as N-Triples and Turtle begin, is not one (<https://… has // after its "prefix").
const XML_START = /^<(?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*(?=[\s/>]|$)/;
// A first line that is a triple (or a quad), as N-Triples and N-Quads begin: <urn:a> looks like an
// element with a prefix, but <urn:a> <https://…> <urn:b> . is a triple, not XML. Its subject and
// predicate are absolute IRIs (with a colon), and it ends with a full stop, on the one line, so that
// elements on lines of their own (<a:b>, then <c:d>…) are still XML.
const IRI = '<[^>\\s]*:[^>\\s]*>';
const TRIPLE_START = new RegExp(`^[ \\t]*${IRI}[ \\t]+${IRI}[ \\t]+(?:<[^>\\s]*>|_:\\S+|")[^\\n]*\\.[ \\t]*(?:#[^\\n]*)?(?:\\r?\\n|$)`);
function isTei(h) {
  const m = XML_ROOT.exec(h.slice(XML_PROLOG.exec(h)[0].length));
  if (!m || (m[2] !== 'TEI' && m[2] !== 'teiCorpus')) return false;
  return new RegExp(`\\sxmlns${m[1] ? ':' + m[1] : ''}\\s*=\\s*["']http://www\\.tei-c\\.org/ns/1\\.0["']`).test(m[3]);
}
/**
 * The entries of a zip, from its central directory at the end of the file (so only the end is
 * read, however large the zip): { name, method, flags, csize, usize, offset } each, in the order
 * the directory lists them. The directory's sizes and offsets are authoritative: a stream of an
 * entry never has to find where it ends, as one written with a data descriptor would otherwise
 * make it. A file that is not a zip, or a Zip64 archive, is a DataError.
 */
export async function zipEntries(file) {
  const damaged = (why) => new DataError(`The zip is damaged or incomplete, so its tables cannot be read (${why}).`);
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 65557)).arrayBuffer());
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw damaged('no central directory at its end');
  const count = dv.getUint16(e + 10, true), size = dv.getUint32(e + 12, true), offset = dv.getUint32(e + 16, true);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new DataError('The zip is a Zip64 archive (over 4 GB, or over 65,535 files), which these tools cannot read. Zip the tables without Zip64, or choose the CSV files themselves.');
  if (offset + size > file.size) throw damaged('its central directory lies past its end');
  const cd = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer());
  const c = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries = [];
  for (let i = 0; entries.length < count; ) {
    if (i + 46 > cd.length || c.getUint32(i, true) !== 0x02014b50) throw damaged('its central directory is cut short');
    const flags = c.getUint16(i + 8, true), len = c.getUint16(i + 28, true), extra = c.getUint16(i + 30, true), note = c.getUint16(i + 32, true);
    const raw = cd.subarray(i + 46, i + 46 + len);
    entries.push({ name: flags & 0x800 ? new TextDecoder().decode(raw) : String.fromCharCode(...raw), flags, method: c.getUint16(i + 10, true),
      csize: c.getUint32(i + 20, true), usize: c.getUint32(i + 24, true), offset: c.getUint32(i + 42, true) });
    i += 46 + len + extra + note;
  }
  return entries;
}
/**
 * One entry of a zip (from zipEntries) as a stream of text, decompressed as it is read and decoded
 * as UTF-8 strictly (notUtf8 names it `label`). Only the entry's own bytes are read, by the sizes
 * the central directory gives; text that does not come to the size it gives is damaged.
 */
const PIECE = 2 ** 20;
export async function zipEntryText(file, entry, label) {
  const damaged = (why) => new DataError(`${label} is damaged, so it cannot be read (${why}).`);
  if (entry.flags & 1) throw new DataError(`${label} is encrypted, so it cannot be read. Zip the tables without a password.`);
  if (entry.method !== 0 && entry.method !== 8) throw new DataError(`${label} is compressed in a way these tools cannot read (method ${entry.method}). Zip the tables with ordinary compression (deflate), or none.`);
  const head = new Uint8Array(await file.slice(entry.offset, entry.offset + 30).arrayBuffer());
  const h = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.length < 30 || h.getUint32(0, true) !== 0x04034b50) throw damaged('its local header is missing');
  const start = entry.offset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
  if (start + entry.csize > file.size) throw damaged('it runs past the end of the zip');
  let bytes = file.slice(start, start + entry.csize).stream();
  if (entry.method === 8) {
    const { Inflate } = await import('fflate');
    let inflate;
    bytes = bytes.pipeThrough(new TransformStream({
      // What one chunk of the zip inflates to is given on in pieces of at most a megabyte (views of
      // it, not copies). Given on whole, a chunk was a sheet's text, or much of it (17.7 MB of
      // names.csv at 200,000 places), which the CSV reader parsed into rows all at once: the page
      // took 790 MB loading a zip of tables, and 500 MB loading the same tables as CSV files, which
      // the browser reads in chunks of 2 MB.
      start(ctl) { inflate = new Inflate((chunk) => { for (let i = 0; i < chunk.length; i += PIECE) ctl.enqueue(chunk.subarray(i, i + PIECE)); }); },
      transform(chunk) { try { inflate.push(chunk, false); } catch (e) { throw damaged(String(e && e.message || e)); } },
      flush() { try { inflate.push(new Uint8Array(0), true); } catch (e) { throw damaged(String(e && e.message || e)); } },
    }));
  }
  let got = 0;
  bytes = bytes.pipeThrough(new TransformStream({
    transform(chunk, ctl) { got += chunk.length; ctl.enqueue(chunk); },
    flush() { if (got !== entry.usize) throw damaged(`it holds ${got.toLocaleString('en-GB')} bytes where the zip says ${entry.usize.toLocaleString('en-GB')}`); },
  }));
  return bytes.pipeThrough(strictUtf8(label));
}
const zipReason = (inside) => {
  const shown = inside.slice(0, 5).map((x) => x.split('/').pop());
  const more = inside.length > 5 ? `, and ${inside.length - 5} more files` : '';
  return `This zip holds ${inside.length ? shown.join(', ') + more : 'no files'}, and no PLATO spreadsheet tables (CSV files named after their sheets, such as places.csv), so it cannot be read. Unzip it and choose the file to read.`;
};
export const XML_REASONS = {
  'tei-p4': 'This is a TEI P4 edition (or TEI with no namespace), which PLATO tools cannot read yet; TEI P5 with the TEI namespace can be read.',
  kml: 'This is KML, which PLATO tools cannot read yet. Convert it to GeoJSON (a FeatureCollection), whose properties can be matched to PLATO.',
  xml: 'This is XML but not TEI, so PLATO tools cannot read it: of XML, only TEI P5 editions (in the TEI namespace) can be read.',
  unseen: 'This is XML, but its root element is not in the first 64 KB (its prolog or DOCTYPE is longer), so what it is cannot be told. Of XML, only TEI P5 editions can be read.',
};
/**
 * What XML the head `h` is, or null when it is not XML: 'tei' (TEI P5, read), 'tei-p4' (<TEI.2>, or
 * <TEI>/<teiCorpus> in no namespace), 'kml', 'unseen' (XML whose root is past the head) or 'xml'.
 * XML is an XML declaration, a DOCTYPE or comment first, or an element first.
 */
function xmlKind(h) {
  if (!/^<\?[A-Za-z]/.test(h) && !/^<!(?:DOCTYPE\s|--)/.test(h) && (!XML_START.test(h) || TRIPLE_START.test(h))) return null;
  if (isTei(h)) return 'tei';
  const rest = h.slice(XML_PROLOG.exec(h)[0].length);
  const root = XML_START.exec(rest);
  if (!root) return rest.startsWith('<') || !rest ? 'unseen' : 'xml';
  const name = root[0].slice(1).replace(/^[^:]*:/, '');
  if (name === 'TEI.2' || name === 'TEI' || name === 'teiCorpus') return 'tei-p4';
  return name === 'kml' ? 'kml' : 'xml';
}
function lpfVersion(obj) {
  const c = JSON.stringify(obj['@context'] || '');
  return /v2/i.test(c) ? 2 : 1;
}

// ---- CSV and GeoJSON that are not PLATO's own (Hermes: src/engine/hermes/generic.js) --------------
/**
 * A set of CSV files is PLATO's spreadsheet tables, exactly as before, when any file is named after
 * one of the ten sheets (places.csv, names.csv…), unless it is a single file whose header does not
 * begin with that sheet's first column (a places.csv of one's own: tableSheets). Otherwise one CSV
 * file is a table of places, read through a mapping of its columns ('csv'); several are not a set
 * of tables, and are read one at a time.
 */
async function csvSetKind(files) {
  if (files.length > 1 ? files.some((f) => sheetOf(f.name)) : (await tableSheets(files)).length) return { format: 'tables', container: 'csv', files };
  if (files.length === 1) return (await headerless(files[0])) ? { format: null, reason: HEADERLESS_REASON } : { format: 'csv', files };
  return { format: null, reason: 'These CSV files are not a set of PLATO spreadsheet tables (none is named after one of its sheets, such as places.csv), so choose one of them at a time: each is read as a table of places, with its columns matched to PLATO.' };
}
export const HEADERLESS_REASON = 'This file seems to have no heading row: its first row holds numbers with decimals, as rows of data do, where the names of its columns should be. Add a first row naming each column (name, latitude, longitude…), then choose it again.';
/**
 * Whether a table of places seems to have no heading row: its first row has two numbers or more, one
 * of them with a fractional part (a coordinate, as in GeoNames' rows). Headings that are whole
 * numbers (years, as a census table has) do not count. The first row is read from the start of the
 * file only, and a start that cannot be read is left to the reader.
 */
async function headerless(file, delimiter) {
  let cells;
  try { cells = Papa.parse((await head(file, 4096)).replace(/^\uFEFF/, ''), { preview: 1, skipEmptyLines: 'greedy', ...(delimiter ? { delimiter } : {}) }).data[0] || []; }
  catch (e) { if (e instanceof DataError) return false; throw e; }
  const numbers = cells.map((c) => String(c).trim()).filter((c) => /^[+-]?\d+(\.\d+)?$/.test(c));
  return numbers.length >= 2 && numbers.some((c) => c.includes('.'));
}
/**
 * A FeatureCollection (or Feature) is Linked Places Format when it says so or has LPF's structure:
 * it names LPF's context (linkedplaces), or its features carry LPF's own members, at the feature's
 * level: names whose items have a toponym, a when with timespans, or an @id of the feature itself
 * (lpf.js reads each). A property of plain GeoJSON that is only called "toponym", "timespans" or
 * "@id" is none of these, and plain GeoJSON is read as a table of its features' properties
 * ('geojson'). `top` is the head of the document as structure (jsonHead), or null.
 */
function isLpf(top) {
  if (!top || typeof top !== 'object') return false;
  if ([].concat(top['@context'] ?? []).some((c) => typeof c === 'string' && /linked-?places/i.test(c))) return true;
  const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
  const lpfFeature = (f) => isObj(f) && (Object.hasOwn(f, '@id')
    || (Array.isArray(f.names) && f.names.some((n) => isObj(n) && Object.hasOwn(n, 'toponym')))
    || (isObj(f.when) && Array.isArray(f.when.timespans)));
  return Array.isArray(top.features) ? top.features.some(lpfFeature) : lpfFeature(top);
}

/**
 * The start of a JSON document as structure, as far as it goes: objects and arrays cut off by the
 * end of `text` hold what was complete in them, and a string, number or word cut off is left out.
 * null when the text is not well formed JSON as far as it goes. For detection, which reads only
 * the first 64 KB of a file.
 */
export function jsonHead(text) {
  let i = 0;
  const END = Symbol('end');
  const n = text.length;
  const space = () => { while (i < n && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++; };
  const bad = () => { throw new SyntaxError(`not JSON at ${i}`); };
  const string = () => {
    const start = i++;
    while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= n) return END;
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const NUMBER = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
  const value = () => {
    space();
    if (i >= n) return END;
    const c = text[i];
    if (c === '"') return string();
    if (c === '{') {
      i++;
      const o = {};
      for (let first = true; ; first = false) {
        space();
        if (i >= n) return o;
        if (text[i] === '}') { i++; return o; }
        if (!first) { if (text[i] !== ',') bad(); i++; space(); if (i >= n) return o; }
        if (text[i] !== '"') bad();
        const k = string();
        if (k === END) return o;
        space();
        if (i >= n) return o;
        if (text[i] !== ':') bad();
        i++;
        const v = value();
        if (v === END) return o;
        // Defined, not assigned, so that a key "__proto__" is a key like any other.
        Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
      }
    }
    if (c === '[') {
      i++;
      const a = [];
      for (let first = true; ; first = false) {
        space();
        if (i >= n) return a;
        if (text[i] === ']') { i++; return a; }
        if (!first) { if (text[i] !== ',') bad(); i++; }
        const v = value();
        if (v === END) return a;
        a.push(v);
      }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (m) { i += m[0].length; return i >= n ? END : Number(m[0]); }
    for (const [w, v] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(w, i)) { i += w.length; return v; }
      if (w.startsWith(text.slice(i))) { i = n; return END; }
    }
    return bad();
  };
  try { const v = value(); return v === END ? null : v; } catch { return null; }
}

/**
 * Whether `text` is the start of a JSON object or array that stops before it closes: well formed as
 * far as it goes (jsonHead), with no break in its tokens, and not closed (so not complete and then
 * followed by something else).
 */
function stopsShort(text) {
  if (jsonHead(text) === null) return false;
  const tokenizer = new Tokenizer();
  let depth = 0, closed = false;
  tokenizer.onToken = ({ token }) => {
    if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) depth++;
    else if ((token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) && --depth === 0) closed = true;
  };
  try { tokenizer.write(text); } catch { return false; }
  return depth > 0 && !closed;
}

// ---- IIIF Georeference Annotations (Allmaps) --------------------------------------------------------
const GEOREF_CONTEXT = /^https?:\/\/iiif\.io\/api\/extension\/georef\/1\/context\.json$/;
export const GEOREF_REASON = "This is a IIIF Georeference Annotation (a map's georeference, not a dataset): drop it together with the Recogito export whose regions it places.";
/**
 * A IIIF Georeference Annotation, or an AnnotationPage of them (as Allmaps publishes them): an
 * annotation whose motivation is "georeferencing", or that names the georeference extension's
 * context. It places a map image on the earth, and says nothing about places, so it is not read on
 * its own. Returns { count, imageServiceIds } from the head (the annotations and the image services
 * they georeference, as far as the head goes), or null.
 */
function georefOf(top) {
  if (!top || typeof top !== 'object' || Array.isArray(top)) return null;
  const contexts = (o) => [].concat(o?.['@context'] ?? []);
  const isGeoref = (o) => !!o && typeof o === 'object' && [].concat(o.type).includes('Annotation')
    && ([].concat(o.motivation ?? []).includes('georeferencing') || contexts(o).some((c) => typeof c === 'string' && GEOREF_CONTEXT.test(c)));
  const types = [].concat(top.type);
  let maps;
  if (types.includes('Annotation')) maps = isGeoref(top) ? [top] : [];
  else if (types.includes('AnnotationPage') && Array.isArray(top.items)) maps = top.items.filter(isGeoref);
  else return null;
  if (!maps.length) return null;
  const ids = [];
  for (const m of maps) {
    const s = m.target?.source;
    const id = s && typeof s === 'object' ? s.id ?? s['@id'] : undefined;
    if (typeof id === 'string' && !ids.includes(id)) ids.push(id);
  }
  return { count: maps.length, imageServiceIds: ids };
}

// ---- A Recogito export with the georeferences of its maps (Hermes: georeferenced regions) ------------
export const MANIFEST_REASON = 'This is a IIIF manifest (the description of a digitised object, not a dataset): drop it together with the Recogito export whose regions are on it and the georeference of its map.';
const GROUP_REASON = 'Choose one file, or the ten CSV files of a set of tables, or one Recogito export together with the georeferences (IIIF Georeference Annotations) of the maps its regions are drawn on, and their IIIF manifests if you have them.';
/** A IIIF Presentation manifest (2 or 3), from the head: its context and its type. */
function isManifest(top) {
  if (!top || typeof top !== 'object' || Array.isArray(top)) return false;
  const iiif = [].concat(top['@context'] ?? []).some((c) => typeof c === 'string' && /^https?:\/\/iiif\.io\/api\/presentation\/[23]\/context\.json$/.test(c));
  return iiif && [].concat(top.type ?? top['@type'] ?? []).some((t) => t === 'Manifest' || t === 'sc:Manifest');
}
/**
 * Several files that are not a set of tables: one Recogito export (W3C Web Annotations), with the
 * IIIF Georeference Annotations of the maps its regions are drawn on and, optionally, the maps'
 * IIIF manifests. Each file is detected on its own; exactly one must be annotations and every other
 * a georeference or a manifest. Gives the annotations' input, with `georefs` and `manifests` (the
 * files, in the order chosen); any other mix gives a reason.
 */
async function detectGroup(files) {
  if (!files.length) return { format: null, reason: GROUP_REASON };
  const each = [];
  for (const f of files) each.push(await detect([f]));
  const main = each.filter((d) => d.format === 'w3c-annotations');
  const georefs = files.filter((f, i) => each[i].format === 'georef');
  const manifests = files.filter((f, i) => each[i].format === 'manifest');
  if (main.length === 1 && 1 + georefs.length + manifests.length === files.length) return { ...main[0], georefs, manifests };
  if (main.length > 1) return { format: null, reason: `${main.length} of the files chosen are annotation exports: choose one export at a time, with the georeferences of its maps. ${GROUP_REASON}` };
  if (main.length === 1) {
    const other = files.filter((f, i) => !['w3c-annotations', 'georef', 'manifest'].includes(each[i].format)).map((f) => f.name);
    return { format: null, reason: `With a Recogito export, only georeferences and IIIF manifests can be chosen, and ${other.join(', ')} ${other.length === 1 ? 'is' : 'are'} neither. ${GROUP_REASON}` };
  }
  if (georefs.length || manifests.length) return { format: null, reason: `No Recogito export was chosen with the georeferences or manifests, which are not read on their own. ${GROUP_REASON}` };
  return { format: null, reason: GROUP_REASON };
}

/**
 * Whether a detected input can be read: it has a format, and no reason it is refused. An input with
 * a reason (a IIIF Georeference Annotation, which is recognised but not read on its own) is refused
 * exactly as one that was not recognised, with the reason.
 */
export const readable = (input) => !!input?.format && input.reason === undefined;
