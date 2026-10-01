// Reading inputs as streams. Nothing here holds a whole file: gzip is decompressed as it arrives,
// text is cut into lines or parsed incrementally, and JSON documents are parsed with a streaming
// parser that hands over one record at a time. Works on browser File objects and on Node's File.
// Vendored, with the one change that keeps a U+FEFF inside a string: see src/vendor/streamparser-json/.
import { JSONParser, TokenType } from '../vendor/streamparser-json/index.js';
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
 * (`whole` when `b` is all there is). A fault begun in the bytes before `b` is placed at its start.
 */
function whereNotUtf8(b, bytes, lines, whole = false) {
  const found = firstNonUtf8(b);
  if (found < 0 && whole) return AT_END;
  const i = Math.max(found, 0);
  let n = lines;
  for (let k = 0; k < i; k++) if (b[k] === 0x0a) n++;
  return `on line ${n.toLocaleString('en-GB')} (byte ${(bytes + i + 1).toLocaleString('en-GB')})`;
}
/** Bytes -> text, strictly: a TransformStream that stops with notUtf8, saying where, at the first byte that is not UTF-8. */
function strictUtf8(name) {
  const dec = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, lines = 1;
  return new TransformStream({
    transform(chunk, ctl) {
      let t;
      try { t = dec.decode(chunk, { stream: true }); } catch { throw notUtf8(name, whereNotUtf8(chunk, bytes, lines)); }
      bytes += chunk.length;
      for (let k = 0; k < chunk.length; k++) if (chunk[k] === 0x0a) lines++;
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
    buf += value;
    const i = buf.lastIndexOf('\n');
    if (i < 0) continue;
    yield buf.slice(0, i + 1);
    buf = buf.slice(i + 1);
  }
  if (buf) yield buf.endsWith('\n') ? buf : buf + '\n';
}
export async function* lines(file) {
  let n = 0;
  for await (const chunk of lineChunks(file)) {
    for (const line of chunk.split('\n')) { n++; if (line.trim()) yield { line, n }; }
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
  if (files.length !== 1) return { format: null, reason: 'Choose one file, or the ten CSV files of a set of tables.' };
  const f = files[0], n = names[0];
  if (n.endsWith('.zip')) {
    // A zip is the tables only when a file in it is named after a sheet; one that holds none (a
    // gazetteer's download, say) is refused, saying what it holds.
    const inside = await zipNames(f);
    if (inside && !inside.some((x) => sheetOf(x))) return { format: null, reason: zipReason(inside) };
    return { format: 'tables', container: 'zip', files };
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
    // The first line as structure, as far as the head goes (a line longer than the head is cut).
    const line = h.split('\n')[0];
    let first;
    try { first = JSON.parse(line); } catch { first = jsonHead(line); }
    if (!first || typeof first !== 'object' || Array.isArray(first)) return { format: null, reason: 'This is JSON Lines, but its first line is not a JSON object, so what it holds cannot be told.' };
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
    const profile = (h.match(/"profile"\s*:\s*"([a-z-]+)"/) || [])[1];
    if (profile === 'place-centric' || profile === 'attestation-centric') return { format: 'plato-json', profile, files };
    if (/"type"\s*:\s*"FeatureCollection"/.test(h)) {
      if (!isLpf(top)) return { format: 'geojson', shape: 'collection', files };
      return { format: 'lpf', files, lpfVersion: lpfVersion({ '@context': top?.['@context'] ?? (h.match(/"@context"\s*:\s*"([^"]+)"/) || [])[1] }) };
    }
    const shape = annotationShape(h, false);
    if (shape) return { format: 'w3c-annotations', shape, files };
    // One GeoJSON Feature on its own (tested after the annotations, whose bodies may hold Features).
    if (/"type"\s*:\s*"Feature"/.test(h) && !isLpf(top)) return { format: 'geojson', shape: 'feature', files };
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
/** How a JSON document that begins `h` holds annotations: 'array' | 'collection' | 'page' | 'annotation' | null. */
function annotationShape(h, array) {
  if (!ANNO_CONTEXT.test(h)) return null;
  const typed = (t) => new RegExp(`"type"\\s*:\\s*(?:\\[[^\\]]*?)?"${t}"`).test(h);
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
 * The names of the files in a zip, from its central directory at the end of the file (so only the
 * end is read, however large the zip), or null when they cannot be listed (not a zip, or a Zip64
 * archive): the tables reader then says what is wrong.
 */
export async function zipNames(file) {
  try {
    const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 65557)).arrayBuffer());
    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) return null;
    const count = dv.getUint16(e + 10, true), size = dv.getUint32(e + 12, true), offset = dv.getUint32(e + 16, true);
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) return null;
    const cd = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer());
    const c = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const names = [];
    for (let i = 0; names.length < count; ) {
      if (i + 46 > cd.length || c.getUint32(i, true) !== 0x02014b50) return null;
      const utf8 = c.getUint16(i + 8, true) & 0x800, len = c.getUint16(i + 28, true), extra = c.getUint16(i + 30, true), note = c.getUint16(i + 32, true);
      const raw = cd.subarray(i + 46, i + 46 + len);
      names.push(utf8 ? new TextDecoder().decode(raw) : String.fromCharCode(...raw));
      i += 46 + len + extra + note;
    }
    return names.filter((x) => !x.endsWith('/'));
  } catch { return null; }
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

/**
 * Whether a detected input can be read: it has a format, and no reason it is refused. An input with
 * a reason (a IIIF Georeference Annotation, which is recognised but not read on its own) is refused
 * exactly as one that was not recognised, with the reason.
 */
export const readable = (input) => !!input?.format && input.reason === undefined;
