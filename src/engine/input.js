// Reading inputs as streams. Nothing here holds a whole file: gzip is decompressed as it arrives,
// text is cut into lines or parsed incrementally, and JSON documents are parsed with a streaming
// parser that hands over one record at a time. Works on browser File objects and on Node's File.
// Vendored, with the one change that keeps a U+FEFF inside a string: see src/vendor/streamparser-json/.
import { JSONParser, TokenType } from '../vendor/streamparser-json/index.js';

/**
 * The file's content stopped the reader: JSON that is not well formed or stops early, or
 * compressed data that is damaged or cut short. It is a problem in the data, for the report, not
 * a failure of the tools; run() turns it into an error in the report.
 */
export class DataError extends Error {
  constructor(message) { super(message); this.name = 'DataError'; }
}
/** Read a chunk, saying in plain words when the bytes themselves cannot be read or decompressed. */
async function readChunk(reader) {
  try { return await reader.read(); }
  catch (e) { throw new DataError(`The file stops, or is damaged, part-way through, so it cannot be read to the end (${String(e && (e.message || e.name) || e).split('\n')[0]}).`); }
}

export async function isGzip(file) {
  const b = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return b[0] === 0x1f && b[1] === 0x8b;
}
export async function textStream(file) {
  let s = file.stream();
  if (await isGzip(file)) s = s.pipeThrough(new DecompressionStream('gzip'));
  return s.pipeThrough(new TextDecoderStream());
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
/** The first `bytes` of a file as text (decompressed), for format detection. */
export async function head(file, bytes = 65536) {
  const reader = (await textStream(file)).getReader();
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

/**
 * Group the chosen files into one input and say what it is:
 *   tables (10 CSVs, a zip or a workbook), plato-json, plato-jsonl, lpf, lpf-seq, ntriples, nquads, turtle,
 *   w3c-annotations (W3C Web Annotations, as Recogito exports them; `shape` says how they are held).
 */
export async function detect(files) {
  const names = files.map((f) => base(f.name));
  const csvs = files.filter((f, i) => names[i].endsWith('.csv'));
  if (csvs.length && csvs.length === files.length) return csvSetKind(files, names);
  if (files.length !== 1) return { format: null, reason: 'Choose one file, or the ten CSV files of a set of tables.' };
  const f = files[0], n = names[0];
  if (n.endsWith('.zip')) return { format: 'tables', container: 'zip', files };
  if (n.endsWith('.xlsx') || n.endsWith('.ods')) return { format: 'tables', container: 'workbook', files };
  if (n.endsWith('.tsv') || n.endsWith('.tab')) return { format: 'csv', delimiter: '\t', files };
  if (n.endsWith('.nt')) return { format: 'ntriples', files };
  if (n.endsWith('.nq')) return { format: 'nquads', files };
  if (n.endsWith('.ttl')) return { format: 'turtle', files };
  let h;
  try { h = (await head(f)).trimStart(); }
  catch (e) { if (e instanceof DataError) return { format: null, reason: `${e.message} Nothing could be read from it.` }; throw e; }
  if (n.endsWith('.jsonl') || n.endsWith('.ndjson') || n.endsWith('.geojsonl') || n.endsWith('.geojsons') || /^\{[^\n]*\}\s*\n\s*\{/.test(h)) {
    const first = JSON.parse(h.split('\n')[0]);
    if (first.profile) return { format: 'plato-jsonl', profile: first.profile, files };
    if (first.type === 'Feature' || first.type === 'FeatureCollection') return { format: 'lpf-seq', files, lpfVersion: lpfVersion(first) };
    if (isAnnotation(first)) return { format: 'w3c-annotations', shape: 'jsonl', files };
    return { format: null, reason: 'This is JSON Lines, but its first line is neither a PLATO header, an LPF feature nor a W3C Web Annotation.' };
  }
  if (h.startsWith('{')) {
    const profile = (h.match(/"profile"\s*:\s*"([a-z-]+)"/) || [])[1];
    if (profile === 'place-centric' || profile === 'attestation-centric') return { format: 'plato-json', profile, files };
    if (/"type"\s*:\s*"FeatureCollection"/.test(h)) {
      if (!isLpf(h)) return { format: 'geojson', shape: 'collection', files };
      return { format: 'lpf', files, lpfVersion: lpfVersion({ '@context': (h.match(/"@context"\s*:\s*"([^"]+)"/) || [])[1] }) };
    }
    const shape = annotationShape(h, false);
    if (shape) return { format: 'w3c-annotations', shape, files };
    // One GeoJSON Feature on its own (tested after the annotations, whose bodies may hold Features).
    if (/"type"\s*:\s*"Feature"/.test(h) && !isLpf(h)) return { format: 'geojson', shape: 'feature', files };
    return { format: null, reason: 'This JSON document is neither a PLATO submission (it has no "profile"), an LPF FeatureCollection, nor W3C Web Annotations.' };
  }
  if (h.startsWith('[')) {
    if (annotationShape(h, true)) return { format: 'w3c-annotations', shape: 'array', files };
    return { format: null, reason: 'This JSON array is not a list of W3C Web Annotations (as Recogito exports them): the first annotations do not name the Web Annotation context.' };
  }
  // TEI XML (src/engine/hermes/tei.js): the root element is <TEI> or <teiCorpus> in the TEI namespace.
  // Before the N-Triples test, which an XML declaration followed by an element would also pass.
  if (h.startsWith('<') && isTei(h)) return { format: 'tei', files };
  if (/^(@prefix|@base|PREFIX|BASE)\b/i.test(h)) return { format: 'turtle', files };
  if (/^(<[^>]+>|_:\S+)\s+<[^>]+>/.test(h)) return { format: 'ntriples', files };
  return { format: null, reason: 'The format of this file could not be recognised.' };
}
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
// root element is TEI or teiCorpus, and it (or its prefix) is bound to the TEI namespace.
const XML_PROLOG = /^(?:\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE(?:[^[>]|\[[\s\S]*?\])*>)*/;
const XML_ROOT = /^<(?:([A-Za-z_][\w.-]*):)?([A-Za-z_][\w.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/;
function isTei(h) {
  const m = XML_ROOT.exec(h.slice(XML_PROLOG.exec(h)[0].length));
  if (!m || (m[2] !== 'TEI' && m[2] !== 'teiCorpus')) return false;
  return new RegExp(`\\sxmlns${m[1] ? ':' + m[1] : ''}\\s*=\\s*["']http://www\\.tei-c\\.org/ns/1\\.0["']`).test(m[3]);
}
function lpfVersion(obj) {
  const c = JSON.stringify(obj['@context'] || '');
  return /v2/i.test(c) ? 2 : 1;
}

// ---- CSV and GeoJSON that are not PLATO's own (Hermes: src/engine/hermes/generic.js) --------------
// The column each of the ten sheets begins with (csv-metadata.json).
const SHEET_FIRST_COLUMN = { about: 'title', sources: 'source_id' };
/**
 * A set of CSV files is PLATO's spreadsheet tables, exactly as before, when any file is named after
 * one of the ten sheets (places.csv, names.csv…), unless it is a single file whose header does not
 * begin with that sheet's first column (a places.csv of one's own). Otherwise one CSV file is a
 * table of places, read through a mapping of its columns ('csv'); several are not a set of tables,
 * and are read one at a time.
 */
async function csvSetKind(files, names) {
  const sheets = names.map((n) => n.split('/').pop().replace(/\.csv$/, ''));
  const named = sheets.filter((s) => TABLE_SHEETS.includes(s));
  if (named.length && files.length > 1) return { format: 'tables', container: 'csv', files };
  if (named.length) {
    let first;
    try { first = (await head(files[0], 4096)).replace(/^﻿/, '').split(/\r?\n/)[0].split(',')[0].replace(/^"|"$/g, '').trim(); }
    catch (e) { if (e instanceof DataError) return { format: 'tables', container: 'csv', files }; throw e; }
    if (first === (SHEET_FIRST_COLUMN[sheets[0]] || 'place_id')) return { format: 'tables', container: 'csv', files };
  }
  if (files.length === 1) return { format: 'csv', files };
  return { format: null, reason: 'These CSV files are not a set of PLATO spreadsheet tables (none is named after one of its sheets, such as places.csv), so choose one of them at a time: each is read as a table of places, with its columns matched to PLATO.' };
}
/**
 * A FeatureCollection (or Feature) is Linked Places Format when it says so or looks it: it names
 * LPF's context (linkedplaces), or its features carry LPF's own members: names with a toponym, a
 * when with timespans, or an @id beside properties.title (lpf.js reads @id, title and names). Plain
 * GeoJSON has none of these, and is read as a table of its features' properties ('geojson').
 */
function isLpf(h) {
  if (/"@context"\s*:\s*(?:\[[^\]]*?)?"[^"]*linked-?places/i.test(h)) return true;
  if (/"toponym"\s*:/.test(h) || /"timespans"\s*:/.test(h)) return true;
  return /"@id"\s*:/.test(h) && /"title"\s*:/.test(h);
}
