// Reading inputs as streams. Nothing here holds a whole file: gzip is decompressed as it arrives,
// text is cut into lines or parsed incrementally, and JSON documents are parsed with a streaming
// parser that hands over one record at a time. Works on browser File objects and on Node's File.
// Vendored, with the one change that keeps a U+FEFF inside a string: see src/vendor/streamparser-json/.
import { JSONParser } from '../vendor/streamparser-json/index.js';

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
/**
 * Stream a JSON document, yielding { path, value } for each element of the arrays named in
 * `arrays` (e.g. ['spatialEntities', 'identityRelations']) and each top-level key in `keys`.
 */
export async function* jsonDocument(file, { arrays = [], keys = [], onlyKeys = false } = {}) {
  const paths = [...arrays.map((a) => `$.${a}.*`), ...keys.map((k) => `$.${k}`)];
  const parser = new JSONParser({ paths, keepStack: false });
  const queue = [];
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

// ---- detection ----------------------------------------------------------------------------------
export const TABLE_SHEETS = ['places', 'sources', 'names', 'locations', 'types', 'relations', 'properties', 'identities'];
const base = (name) => name.replace(/\.gz$/i, '').toLowerCase();

/**
 * Group the chosen files into one input and say what it is:
 *   tables (8 CSVs, a zip or a workbook), plato-json, plato-jsonl, lpf, lpf-seq, ntriples, nquads, turtle.
 */
export async function detect(files) {
  const names = files.map((f) => base(f.name));
  const csvs = files.filter((f, i) => names[i].endsWith('.csv'));
  if (csvs.length && csvs.length === files.length) return { format: 'tables', container: 'csv', files };
  if (files.length !== 1) return { format: null, reason: 'Choose one file, or the eight CSV files of a set of tables.' };
  const f = files[0], n = names[0];
  if (n.endsWith('.zip')) return { format: 'tables', container: 'zip', files };
  if (n.endsWith('.xlsx') || n.endsWith('.ods')) return { format: 'tables', container: 'workbook', files };
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
    return { format: null, reason: 'This is JSON Lines, but its first line is neither a PLATO header nor an LPF feature.' };
  }
  if (h.startsWith('{')) {
    const profile = (h.match(/"profile"\s*:\s*"([a-z-]+)"/) || [])[1];
    if (profile === 'place-centric' || profile === 'attestation-centric') return { format: 'plato-json', profile, files };
    if (/"type"\s*:\s*"FeatureCollection"/.test(h)) return { format: 'lpf', files, lpfVersion: lpfVersion({ '@context': (h.match(/"@context"\s*:\s*"([^"]+)"/) || [])[1] }) };
    return { format: null, reason: 'This JSON document is neither a PLATO submission (it has no "profile") nor an LPF FeatureCollection.' };
  }
  if (/^(@prefix|@base|PREFIX|BASE)\b/i.test(h)) return { format: 'turtle', files };
  if (/^(<[^>]+>|_:\S+)\s+<[^>]+>/.test(h)) return { format: 'ntriples', files };
  return { format: null, reason: 'The format of this file could not be recognised.' };
}
function lpfVersion(obj) {
  const c = JSON.stringify(obj['@context'] || '');
  return /v2/i.test(c) ? 2 : 1;
}
