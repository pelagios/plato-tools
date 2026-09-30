// An ordinary table of places, a CSV (or TSV) file or plain GeoJSON, read as PLATO records through
// a mapping of its columns (src/engine/hermes/columns.js): each row, or each feature, is one
// attestation. What it is evidence about depends on the columns:
//   - a column of the places' web addresses (Wikidata, Pleiades…): each row is an attestation about
//     that address (attestation-centric, as the Recogito reader makes them), and rows sharing an
//     address are several attestations about one place. Each address is first put into the form
//     `about` should carry (addresses.js: WHG's place:<ns>:<id> and entity pages become its
//     persistent addresses, with a note saying what the file gave). A row whose address cannot be
//     used is still read: with an id it becomes a new place of its own, as below; without, a loss;
//   - otherwise, each row is a place (place-centric), whose address is made from its id exactly as
//     the spreadsheet tables make one from place_id (tableIds), with the id kept as the place's own
//     identifier (entityIdentifier). Two rows with one id are refused. With no id, a place has no
//     address at all, and the report says once how to give it one: no address is ever made from a
//     row's number or its name, since such an address would change whenever the file did.
// A GeoJSON feature's own id counts as a column (FEATURE_ID), and its geometry is always carried.
import Papa from 'papaparse';
import { textStream, jsonDocument, DataError } from '../input.js';
import { LOSS_TEXT } from '../report.js';
import { tableIds } from '../../formats/tables.js';
import { resolveColumns, applyColumns, GENERIC_KINDS, FEATURE_ID } from './columns.js';

const SAMPLE = 50;
// The feature members GeoJSON defines and this reader uses; any other is reported by name.
const FEATURE_KEYS = new Set(['type', 'id', 'geometry', 'properties']);
// Coordinates in GeoJSON are WGS 84 longitude and latitude (RFC 7946); an older file may name another
// reference system in `crs`, and its coordinates would then be read as degrees they are not.
const WGS84 = /^(urn:ogc:def:crs:OGC:1\.3:CRS84|urn:ogc:def:crs:EPSG::4326|EPSG:4326|CRS84)$/i;

/** The text of a file in chunks, decompressed and decoded, without its byte-order mark; a break in the bytes is a DataError. */
async function* textChunks(file) {
  const reader = (await textStream(file)).getReader();
  let first = true;
  try {
    for (;;) {
      let r;
      try { r = await reader.read(); }
      catch (e) { throw new DataError(`The file stops, or is damaged, part-way through, so it cannot be read to the end (${String(e && (e.message || e.name) || e).split('\n')[0]}).`); }
      if (r.done) break;
      let t = r.value;
      if (first && t) { t = t.replace(/^\ufeff/, ''); first = false; }
      if (t) yield t;
    }
  } finally { reader.cancel().catch(() => {}); }
}
async function wholeText(file) {
  let s = '';
  for await (const t of textChunks(file)) s += t;
  return s;
}

// What has been read of each input's start (its columns and first rows), so that finding the
// profile, the columns and the mapping reads the start once. The rows are never kept: each reading
// of them streams the file again.
const opened = new WeakMap();

/**
 * Open a CSV/TSV or plain GeoJSON input: { headers, sample, rows(), head }, where rows() yields
 * { row, where, geometry?, extra? } for each row or feature. Bad input throws DataError.
 */
async function open(input) {
  const file = input.files[0];
  if (opened.has(file)) return opened.get(file);
  const t = input.format === 'csv' ? await openCsv(file, input) : await openGeojson(file, input);
  opened.set(file, t);
  return t;
}

/**
 * The records of CSV text given in chunks, one array of cells at a time, as Papa reads them, with
 * the rows whose cells are all empty left out (as Papa's skipEmptyLines 'greedy'). Nothing is held
 * but the chunk being read and the row it breaks off in, so a file of any size streams. The
 * delimiter is `delimiter`, else guessed (as Papa guesses it) from the start of the text.
 *
 * A quotation mark out of place moves where Papa thinks a row ends: rows are merged into one cell,
 * or split, and nothing read after it can be trusted to be the row it seems. It stops the file with
 * a DataError naming the line, found from where in the text it is. Papa's chunk parser reports no
 * other kind of error (its delimiter and field-count errors are Papa.parse's, which this does not
 * use); one it came to report would stop the file too, never be dropped.
 */
export async function* csvRecords(chunks, { delimiter } = {}) {
  const it = chunks[Symbol.asyncIterator]();
  let buf = '', done = false;
  // Enough of the start to guess the delimiter and the line break from, as Papa guesses them from its
  // first rows: ten lines, or 64 KB, or the whole file.
  const lineCount = (t) => { let k = 0, i = -1; while ((i = t.indexOf('\n', i + 1)) !== -1 && k < 11) k++; return k; };
  while (!done && buf.length < 65536 && lineCount(buf) < 11) { const r = await it.next(); if (r.done) done = true; else buf += r.value; }
  const guess = Papa.parse(buf.slice(0, 65536), { preview: 10, skipEmptyLines: 'greedy', ...(delimiter ? { delimiter } : {}) }).meta;
  const newline = guess.linebreak || '\n';
  const parser = new Papa.Parser({ delimiter: delimiter || guess.delimiter || ',', newline });
  const count = (s, to) => { let n = 0, i = -1; while ((i = s.indexOf(newline, i + 1)) !== -1 && i < to) n++; return n; };
  let lines = 0;   // line breaks before the start of `buf`
  for (;;) {
    // Papa's own streaming: every row but the last, which may go on in the next chunk, is read.
    const last = done;
    const res = parser.parse(buf, 0, !last);
    const cursor = last ? buf.length : res.meta.cursor;
    for (const e of res.errors) {
      // An error in the row left for the next chunk is Papa's view of half a row: it is read again whole.
      if (!last && Number.isInteger(e.index) && e.index >= cursor) continue;
      const line = Number.isInteger(e.index) ? lines + count(buf, e.index) + 1 : undefined;
      if (e.type === 'Quotes') {
        throw new DataError(`The CSV file has ${e.code === 'MissingQuotes' ? 'a quotation mark that opens a cell and is never closed' : 'a stray quotation mark in a quoted cell (a quotation mark inside a quoted cell is written twice: "")'}${line ? ` near line ${line}` : ''}, so where its rows begin and end cannot be told. Correct the quotation marks and try again.`);
      }
      throw new DataError(`The CSV file cannot be read${line ? ` near line ${line}` : ''} (${e.message}).`);
    }
    for (const cells of res.data) if (!cells.every((c) => c.trim() === '')) yield cells;
    if (last) return;
    lines += count(buf, cursor);
    buf = buf.slice(cursor);
    const r = await it.next();
    if (r.done) done = true; else buf += r.value;
  }
}

/** A row of cells as an object keyed by column, with no prototype (so that a column called "__proto__" is kept). */
function rowOfCells(headers, cells) {
  const row = Object.create(null);
  headers.forEach((k, j) => { if (j < cells.length) row[k] = cells[j]; });
  return row;
}
async function openCsv(file, input) {
  const records = () => csvRecords(textChunks(file), { delimiter: input.delimiter });
  // The header and the first rows, for the guess: the rest of the file is not read here.
  let rawHeaders = [];
  const first = [];
  for await (const cells of records()) {
    if (!rawHeaders.length) { rawHeaders = cells; continue; }
    first.push(cells);
    if (first.length >= SAMPLE) break;
  }
  // The header is read here, not by Papa, which renamed a repeated heading (name -> name_1) without
  // saying so, and lost a heading "__proto__" from its rows.
  if (!rawHeaders.length || rawHeaders.every((h) => String(h).trim() === '')) throw new DataError('The CSV file has no header row naming its columns, so its columns cannot be read.');
  // A heading given to more than one column: each such column is known by the heading and its place,
  // "name (column 3)", in the matching, the notes and the report, and the report says so once.
  const uses = new Map();
  rawHeaders.forEach((h, j) => uses.set(h, [...(uses.get(h) || []), j + 1]));
  const headers = rawHeaders.map((h, j) => (uses.get(h).length > 1 ? `${h} (column ${j + 1})` : h));
  const headerText = Object.create(null);
  headers.forEach((k, j) => { headerText[k] = rawHeaders[j]; });
  const headProblems = [];
  for (const [h, cols] of uses) if (cols.length > 1) headProblems.push({ kind: 'generic-csv-duplicate-header', example: `"${h}": ${cols.length} columns (${cols.join(', ')}), read as ${cols.map((c) => `"${h} (column ${c})"`).join(', ')}` });
  return {
    headers, headerText, headProblems, sample: first.map((cells) => rowOfCells(headers, cells)), head: {},
    // Each row.
    async *rows() {
      let i = -1;
      for await (const cells of records()) {
        if (i++ < 0) continue;   // the header
        const where = `row ${i + 1}`;   // as a spreadsheet numbers it, the header being row 1
        const extra = cells.length > headers.length ? cells.slice(headers.length) : undefined;
        const problem = cells.length < headers.length ? `${plural(cells.length, 'cell')} where the header has ${plural(headers.length, 'column')}` : undefined;
        yield { row: rowOfCells(headers, cells), where, problem, extra };
      }
    },
  };
}
const plural = (n, one) => `${n} ${n === 1 ? one : one + 's'}`;
async function openGeojson(file, input) {
  const head = {};
  const headers = [], seen = new Set(), sample = [];
  const add = (k) => { if (!seen.has(k)) { seen.add(k); headers.push(k); } };
  // A row with no prototype, so that a property called "__proto__" is a column like any other.
  const rowOf = (f) => Object.assign(Object.create(null), f.properties && typeof f.properties === 'object' ? f.properties : {}, f.id !== undefined && f.id !== null ? { [FEATURE_ID]: f.id } : {});
  // A FeatureCollection is read twice, as it streams: once here, for its columns, its first rows and
  // what it says of itself (crs, name, title), and once for its rows. One Feature on its own is read
  // once, whole.
  let features, all;
  if (input.shape === 'feature') {
    let f;
    try { f = JSON.parse(await wholeText(file)); } catch (e) { throw new DataError(`The JSON is not well formed, so the file cannot be read (${String(e.message).split('\n')[0]}).`); }
    features = all = async function* () { yield f; };
  } else {
    features = async function* () { for await (const { value } of jsonDocument(file, { arrays: ['features'] })) yield value; };
    all = async function* () {
      for await (const { path, value } of jsonDocument(file, { arrays: ['features'], keys: ['crs', 'name', 'title'] })) { if (path === 'features') yield value; else head[path] = value; }
    };
  }
  // The columns are every property any feature has, in the order they are first met, and the
  // feature's own id first when any feature has one.
  let anyId = false;
  for await (const f of all()) {
    if (!f || typeof f !== 'object' || f.type !== 'Feature') continue;
    if (f.id !== undefined && f.id !== null) anyId = true;
    if (f.properties && typeof f.properties === 'object') for (const k of Object.keys(f.properties)) add(k);
    if (sample.length < SAMPLE) sample.push(rowOf(f));
  }
  if (anyId) headers.unshift(FEATURE_ID);
  const crs = head.crs?.properties?.name;
  if (head.crs && !(typeof crs === 'string' && WGS84.test(crs))) throw new DataError(`The GeoJSON names a coordinate reference system other than WGS 84 longitude and latitude (${typeof crs === 'string' ? crs : JSON.stringify(head.crs)}), so its coordinates cannot be read as degrees. Convert it to WGS 84 (EPSG:4326) first.`);
  return {
    headers, sample, head,
    async *rows() {
      let n = 0;
      for await (const f of features()) {
        n++;
        const where = `feature ${n}`;
        if (!f || typeof f !== 'object' || f.type !== 'Feature') { yield { where, notFeature: true }; continue; }
        const keys = Object.keys(f).filter((k) => !FEATURE_KEYS.has(k) && f[k] !== undefined && f[k] !== null);
        yield { row: rowOf(f), where, geometry: f.geometry, keys };
      }
    },
  };
}

/** The columns of a CSV or plain GeoJSON input, and its first rows: { headers, sample }, for the page's table of columns. */
export async function columnsOf(input) {
  const { headers, sample } = await open(input);
  return { headers, sample };
}
/** The mapping a run of this input uses: { mapping, reasons, problems } (columns.js, resolveColumns). */
export async function mappingOf(input, saved) {
  const { headers, sample, headerText } = await open(input);
  return resolveColumns(headers, sample, saved, headerText);
}
/** 'attestation-centric' when a column holds the places' web addresses, else 'place-centric'. */
export async function genericProfile(input, saved) {
  const { mapping } = await mappingOf(input, saved);
  return Object.values(mapping).includes('address') ? 'attestation-centric' : 'place-centric';
}

/**
 * The records of a CSV or plain GeoJSON input: a header, then a 'record' for each place
 * (place-centric), or an 'attestation' for each row about a web address (attestation-centric).
 * `options.columns` is a saved mapping (else the guess is used); `options.base` the base address
 * places' addresses are made under, `defaultBase` the stand-in used without one.
 */
export async function* genericSource(input, rep, options = {}, defaultBase = 'https://example.org/my-dataset/') {
  const file = input.files[0];
  const report = (kind, example) => rep.add(GENERIC_KINDS[kind] || 'loss', kind, LOSS_TEXT[kind] || kind, example);
  const t = await open(input);
  const { mapping, problems } = resolveColumns(t.headers, t.sample, options.columns, t.headerText);
  for (const p of [...(t.headProblems || []), ...problems]) report(p.kind, p.example);
  const fields = Object.values(mapping);
  const byAddress = fields.includes('address'), hasId = fields.includes('id');
  const what = input.format === 'csv' ? 'a table of places (CSV)' : 'plain GeoJSON';
  const title = options.title || (typeof t.head.title === 'string' && t.head.title) || (typeof t.head.name === 'string' && t.head.name) || `Places in ${file.name}`;
  yield { type: 'header', value: {
    profile: byAddress ? 'attestation-centric' : 'place-centric',
    gazetteer: { title, description: `Converted by PLATO tools from ${what}, ${file.name}: one attestation for each ${input.format === 'csv' ? 'row' : 'feature'}${byAddress ? ', about the place whose web address it gives' : ''}.` },
  } };
  const base = options.base || defaultBase;
  if (!byAddress && !hasId) report('generic-no-ids', file.name);
  const minted = tableIds(base, () => null);
  let standIn = false;
  const mint = (id) => { if (!options.base && !standIn) { standIn = true; report('generic-stand-in-base', base); } return minted.place(id); };
  // Each id met, with the number of its row (a number, not the row, so that a large file's ids are
  // all that is kept).
  const seen = new Map();
  const whereOf = (k) => (input.format === 'csv' ? `row ${k + 1}` : `feature ${k}`);
  const skipped = new Set();
  let n = 0;
  for await (const r of t.rows()) {
    n++;
    rep.count(input.format === 'csv' ? 'rows' : 'features');
    if (r.notFeature) { report('generic-not-feature', r.where); continue; }
    if (r.problem) report('generic-csv-row', `${r.where}: ${r.problem}`);
    if (r.extra?.length) report('generic-csv-extra-cells', `${r.where}: ${r.extra.join(', ')}`);
    for (const k of r.keys || []) report('generic-feature-key', k);
    const a = applyColumns(r.row, mapping, { where: r.where, report, fileName: file.name, geometry: r.geometry, idAsNote: byAddress });
    for (const c of a.skipped) skipped.add(c);
    if (byAddress && a.address) { yield { type: 'attestation', value: { about: a.address, ...a.attestation }, n }; continue; }
    // A row about an address that gives none it can use is still read: with an id, it is a place of
    // its own (a new place, beside the attestations); without one, it has nothing to be about.
    if (byAddress && (a.id === undefined || !a.label)) {
      if (a.addressLost) { /* reported, with why, as the address was read */ }
      else if (a.addressText) report('generic-address-not-web', `${r.where}: ${a.addressText}`);
      else report(a.label ? 'generic-no-address' : 'generic-row-empty', r.where);
      continue;
    }
    if (!a.label) { report('generic-row-no-name', r.where); continue; }
    const rec = {};
    if (a.id !== undefined) {
      if (seen.has(a.id)) throw new DataError(`The id "${a.id}" is used by more than one ${input.format === 'csv' ? 'row' : 'feature'} (${whereOf(seen.get(a.id))} and ${r.where}). Each id becomes the web address of a place, so ids must be unique: correct the duplicate, or map another column as the id.`);
      seen.set(a.id, n);
      rec['@id'] = mint(a.id);
    } else if (hasId) report('generic-id-empty', r.where);
    rec.label = a.label;
    if (a.id !== undefined) rec.entityIdentifier = a.id;
    rec.attestations = [a.attestation];
    yield byAddress ? { type: 'record', value: rec, n, newEntity: true } : { type: 'record', value: rec, n };
  }
  // A skipped column is reported once, by name, if it had a value to lose.
  for (const c of skipped) report('generic-column-skipped', c);
}
