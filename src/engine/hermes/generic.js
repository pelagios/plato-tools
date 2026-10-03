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
//     row's number or its name, since such an address would change whenever the file did;
//   - with options.sameId (rows with the same id are evidence about one place), each row is an
//     attestation about the address made from its id (attestation-centric), and at the end each id
//     is one new place, with its label and entityIdentifier and no attestations of its own: the
//     store regroups the rows under it. Only each id and the names its rows give are held, never a
//     row. Names that agree are the label; names that differ make the id the label, and are reported.
// A GeoJSON feature's own id counts as a column (FEATURE_ID), and its geometry is always carried.
// A sheet of a workbook (.xlsx, .ods) that is not PLATO's tables is read as a CSV file is (openSheet).
import { jsonDocument, DataError, jsonFaultWords, workbookSheets, xlsxLib } from '../input.js';
import { csvRecords, textChunks } from '../../formats/csv.js';
import { LOSS_TEXT } from '../report.js';
import { tableIds } from '../../formats/tables.js';
// The tables reader's own forms for a workbook's numbers and dates, so that a sheet reads alike either way.
import { numberText, dateText } from '../pipeline.js';
import { resolveColumns, applyColumns, expandSplits, splitRow, GENERIC_KINDS, FEATURE_ID, FIELDS, OTHER } from './columns.js';
import { containerKey, CONTAINED_IN } from './within.js';
import { sha256 } from '../../lib/sha256.js';
/** The id a region is minted with, under the base address: "region-" and 16 hex digits of the SHA-256 of its containerKey. */
export const regionId = (key) => `region-${sha256(key).slice(0, 16)}`;

// The CSV reader is shared with the spreadsheet tables (src/formats/csv.js); exported here as before.
export { csvRecords };

const SAMPLE = 50;
const NOT_A_LIST = Symbol('not a list');
// The feature members GeoJSON defines and this reader uses; any other is reported by name.
const FEATURE_KEYS = new Set(['type', 'id', 'geometry', 'properties']);
// Coordinates in GeoJSON are WGS 84 longitude and latitude (RFC 7946); an older file may name another
// reference system in `crs`, and its coordinates would then be read as degrees they are not.
const WGS84 = /^(urn:ogc:def:crs:OGC:1\.3:CRS84|urn:ogc:def:crs:EPSG::4326|EPSG:4326|CRS84)$/i;

async function wholeText(file) {
  let s = '';
  for await (const t of textChunks(file)) s += t;
  return s;
}

// What has been read of each input's start (its columns and first rows), so that finding the
// profile, the columns and the mapping reads the start once. The rows are never kept: each reading
// of them streams the file again. A workbook's are kept by sheet.
const opened = new WeakMap();

/**
 * Open a CSV/TSV or plain GeoJSON input, or a sheet of a workbook: { headers, sample, rows(), head },
 * where rows() yields { row, where, geometry?, extra? } for each row or feature. Bad input throws
 * DataError. `sheet` is the workbook's sheet to read (else the one detection chose).
 */
async function open(input, sheet = input.sheet) {
  const file = input.files[0];
  const key = input.container === 'workbook' ? `sheet:${sheet}` : 'file';
  if (!opened.has(file)) opened.set(file, new Map());
  const done = opened.get(file);
  if (done.has(key)) return done.get(key);
  const t = input.container === 'workbook' ? await openSheet(file, sheet) : input.format === 'csv' ? await openCsv(file, input) : await openGeojson(file, input);
  done.set(key, t);
  return t;
}
/** The workbook's sheet a run reads: options.sheet when the options are a run's (not a mapping alone), else the input's. */
const sheetIn = (input, options) => (input.container === 'workbook' && options && savedColumns(options) !== options && typeof options.sheet === 'string' ? options.sheet : input.sheet);
/**
 * The input with `name` as the workbook's sheet to read, or the input as it is when no name is
 * given; a name the workbook does not have is a DataError naming the sheets it has.
 */
export function withSheet(input, name) {
  if (name === undefined || name === null || name === '') return input;
  if (input.container !== 'workbook' || input.format !== 'csv') throw new DataError(`A sheet ("${name}") can be chosen only for a workbook (.xlsx or .ods) read as a table of places.`);
  if (!input.sheets.some((s) => s.name === name)) throw new DataError(sheetMissing(name, input.sheets));
  return { ...input, sheet: name };
}
const quoted = (names) => names.map((n) => `"${n}"`).join(', ');
const sheetMissing = (name, sheets) => `The workbook has no sheet "${name}"; its sheets are ${quoted(sheets.map((s) => s.name))}.`;

// ---- a sheet of a workbook ------------------------------------------------------------------------
// A workbook can only be read whole (SheetJS): read once for the columns and first rows, then once
// more for the rows. Each cell is read as its value, not as the workbook shows it: a coordinate
// formatted "0.00" keeps every digit it has (String of the number), a date is an ISO date, and a
// formula is its last calculated value (one saved with none is reported, and read as empty). A cell
// holding an error (#DIV/0!, #N/A, #REF!…) is reported as a loss, naming its row, column and error,
// and carries nothing.
const WORKBOOK_WHOLE = 50 * 2 ** 20;   // as the tables reader warns (pipeline.js)
// The text of a spreadsheet's error codes, for a cell that keeps the code and not its text.
const ERROR_TEXT = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0F: '#VALUE!', 0x17: '#REF!', 0x1D: '#NAME?', 0x24: '#NUM!', 0x2A: '#N/A', 0x2B: '#GETTING_DATA' };
/**
 * A cell's value as text, as the tables reader writes it (pipeline.js, numberText and dateText): a
 * date YYYY-MM-DD at midnight, else YYYY-MM-DDThh:mm:ss (the time as the workbook gives it, in no
 * time zone), or hh:mm:ss where the cell's number format `z` shows no day nor year; TRUE or FALSE; a
 * number in full, never as an exponent (1e-7 is 0.0000001).
 */
export function sheetCellText(v, z) {
  if (v === undefined || v === null) return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    // Read with UTC: true, the date's UTC fields are the workbook's own: toISOString, never the local time.
    return dateText(v, z);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return numberText(v);
  return String(v);
}
async function openSheet(file, name) {
  const XLSX = await xlsxLib();
  const { sheets } = await workbookSheets(file);
  if (!sheets.length) throw new DataError(`The workbook ${file.name} has no sheets, so there is nothing in it to read.`);
  if (!sheets.some((s) => s.name === name)) throw new DataError(sheetMissing(name, sheets));
  const damaged = (e) => new DataError(`The workbook is damaged or incomplete, so its sheet "${name}" cannot be read (${String(e && e.message || e)}).`);
  // The sheet's rows as text (blank rows kept, so that each has its number), where its rows begin,
  // and its formulas saved with no value.
  const read = async () => {
    // sheetStubs (xlsx only): a formula saved with no value, as Excel, openpyxl and pandas write it
    // (`<f>B2*2</f>` alone, or with an empty `<v></v>`), is then a cell { t: 'z', f } and not dropped
    // unseen; sheet_to_json gives a stub as empty, so the rows are as without it. Not for ODS, where
    // SheetJS would make a stub of every repeated empty cell (a styled row repeated to the sheet's end).
    const stubs = !file.name.toLowerCase().endsWith('.ods');
    let ws;
    try { ws = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', cellDates: true, cellNF: true, UTC: true, sheets: [name], dense: true, sheetStubs: stubs }).Sheets[name]; }
    catch (e) { throw damaged(e); }
    if (!ws || !ws['!ref']) return { rows: [], top: 0, left: 0, formulas: [], errors: new Map() };
    const { s } = XLSX.utils.decode_range(ws['!ref']);
    // Formulas with no value, and cells holding an error (which SheetJS gives as empty), by the index
    // of their row among the rows read: { j (the column among those read), ref, text }.
    const formulas = [], errors = new Map();
    (ws['!data'] || []).forEach((cells, r) => (cells || []).forEach((cell, c) => {
      // A formula with no value: { t: 'z', f } from Excel, openpyxl, pandas; { t: 'e', f } with no v from SheetJS's own writer.
      if (cell && cell.t === 'z' && cell.f) { formulas.push({ r, c, f: cell.f }); return; }
      if (!cell || cell.t !== 'e') return;
      if (cell.v === undefined) { if (cell.f) formulas.push({ r, c, f: cell.f }); return; }
      const i = r - s.r;
      if (!errors.has(i)) errors.set(i, []);
      errors.get(i).push({ j: c - s.c, ref: XLSX.utils.encode_cell({ r, c }), text: typeof cell.w === 'string' && cell.w ? cell.w : ERROR_TEXT[cell.v] || `error ${cell.v}` });
    }));
    // Each number and date as its text, with the cell's number format (a time of day shows no day nor year).
    for (const cells of ws['!data'] || []) for (const cell of cells || []) {
      if (cell && (cell.t === 'n' || cell.t === 'd') && (typeof cell.v === 'number' || cell.v instanceof Date)) cell.v = sheetCellText(cell.v, cell.z);
    }
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, UTC: true, defval: '', blankrows: true }).map((cells) => cells.map((v) => sheetCellText(v)));
    return { rows, top: s.r, left: s.c, formulas, errors };
  };
  const { rows, top, left, formulas, errors } = await read();
  const blank = (cells) => cells.every((c) => c.trim() === '');
  const h = rows.findIndex((cells) => !blank(cells));
  const headProblems = [];
  const others = sheets.filter((x) => x.name !== name);
  if (others.length) headProblems.push({ kind: 'generic-sheets-not-read', example: `${file.name}: read "${name}"; not read ${quoted(others.map((x) => x.name))}` });
  for (const x of sheets) if (x.hidden) headProblems.push({ kind: 'generic-sheet-hidden', example: `"${x.name}" in ${file.name}${x.name === name ? ', the sheet read' : ', not read'}` });
  if (file.size > WORKBOOK_WHOLE) headProblems.push({ kind: 'workbook-whole', example: `${file.name}: ${(file.size / 2 ** 20).toFixed(0)} MB` });
  // An error in no row or column that is read (above or in the heading row, or past the last
  // column): reported here, by its cell, never passed over.
  const stray = (i, e) => headProblems.push({ kind: 'generic-sheet-error-cell', example: `cell ${e.ref} of "${name}"${i === h ? ', in the heading row' : ''}: ${e.text}` });
  if (h < 0) { for (const [i, es] of errors) for (const e of es) stray(i, e); }
  if (h < 0) return { empty: true, sheet: name, headers: [], headerText: Object.create(null), headProblems, sample: [], head: {}, async *rows() {} };
  // The columns are as wide as any heading or value goes: a column formatted and never filled is not one.
  let width = 0;
  for (const cells of rows) for (let j = cells.length - 1; j >= width; j--) if (cells[j].trim() !== '') { width = j + 1; break; }
  const rawHeaders = rows[h].slice(0, width);
  while (rawHeaders.length < width) rawHeaders.push('');
  const uses = new Map();
  rawHeaders.forEach((x, j) => uses.set(x, [...(uses.get(x) || []), j + 1]));
  const headers = rawHeaders.map((x, j) => (uses.get(x).length > 1 ? `${x} (column ${j + 1})` : x));
  const headerText = Object.create(null);
  headers.forEach((k, j) => { headerText[k] = rawHeaders[j]; });
  for (const [x, cols] of uses) if (cols.length > 1) headProblems.push({ kind: 'generic-csv-duplicate-header', example: `"${x}": ${cols.length} columns (${cols.join(', ')}), read as ${cols.map((c) => `"${x} (column ${c})"`).join(', ')}` });
  for (const [i, es] of errors) for (const e of es) if (i <= h || e.j >= width) stray(i, e);
  for (const { r, c, f } of formulas) {
    // The dense sheet's rows and columns are counted from A1; the rows read, from where the sheet's range begins.
    const column = c - left < width && r - top > h ? `, column "${headers[c - left]}"` : '';
    headProblems.push({ kind: 'generic-sheet-formula-no-value', example: `cell ${XLSX.utils.encode_cell({ r, c })} of "${name}"${column}: =${f}` });
  }
  // Each row, with the error cells in it (a row whose only value is an error is still a row: never
  // passed over as blank, so that its loss is reported).
  const body = function* (all, errs) {
    for (let i = h + 1; i < all.length; i++) {
      const cellErrors = (errs.get(i) || []).filter((e) => e.j < width).map((e) => ({ column: headers[e.j], ref: e.ref, text: e.text }));
      if (blank(all[i]) && !cellErrors.length) continue;
      yield { row: rowOfCells(headers, all[i].slice(0, width)), where: `row ${top + i + 1}`, ...(cellErrors.length ? { cellErrors } : {}) };
    }
  };
  const sample = [];
  for (const { row } of body(rows, errors)) { sample.push(row); if (sample.length >= SAMPLE) break; }
  return {
    sheet: name, headers, headerText, headProblems, sample, head: {},
    // The rows are read again, the workbook being read whole, rather than kept between readings.
    async *rows() { const again = await read(); yield* body(again.rows, again.errors); },
  };
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
    try { f = JSON.parse(await wholeText(file)); } catch (e) { throw new DataError(`The JSON is not well formed, so the file cannot be read (${jsonFaultWords(e)}).`); }
    features = all = async function* () { yield f; };
  } else {
    // `features` given as something else than a list is no features: null says so; anything else
    // is reported (NOT_A_LIST), never read as one feature.
    features = async function* () {
      for await (const { value, notAList } of jsonDocument(file, { arrays: ['features'] })) {
        if (notAList) { if (notAList !== 'null') yield { [NOT_A_LIST]: notAList }; } else yield value;
      }
    };
    all = async function* () {
      for await (const { path, value, notAList } of jsonDocument(file, { arrays: ['features'], keys: ['crs', 'name', 'title'] })) { if (path === 'features') { if (!notAList) yield value; } else head[path] = value; }
    };
  }
  // The columns are every property any feature has, in the order they are first met, and the
  // feature's own id first when any feature has one.
  let anyId = false, ownGeometry = false;
  for await (const f of all()) {
    if (!f || typeof f !== 'object' || f.type !== 'Feature') continue;
    if (f.id !== undefined && f.id !== null) anyId = true;
    if (f.properties && typeof f.properties === 'object') for (const k of Object.keys(f.properties)) add(k);
    if (sample.length < SAMPLE) { sample.push(rowOf(f)); if (f.geometry && typeof f.geometry === 'object') ownGeometry = true; }
  }
  if (anyId) headers.unshift(FEATURE_ID);
  const crs = head.crs?.properties?.name;
  if (head.crs && !(typeof crs === 'string' && WGS84.test(crs))) throw new DataError(`The GeoJSON names a coordinate reference system other than WGS 84 longitude and latitude (${typeof crs === 'string' ? crs : JSON.stringify(head.crs)}), so its coordinates cannot be read as degrees. Convert it to WGS 84 (EPSG:4326) first.`);
  return {
    headers, sample, head, ownGeometry,
    async *rows() {
      let n = 0;
      for await (const f of features()) {
        if (f && f[NOT_A_LIST]) { yield { notAList: f[NOT_A_LIST] }; continue; }
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
  const t = await open(input);
  if (t.empty) throw new DataError(`${LOSS_TEXT['generic-sheet-empty']} (the sheet "${t.sheet}")`);
  return { headers: t.headers, sample: t.sample };
}
/**
 * The mapping a run of this input uses: { mapping, reasons, problems, gazetteer } (columns.js,
 * resolveColumns), and `headers`, the columns in the file's order (which the mapping, an object,
 * does not keep for a column whose heading is a number).
 */
export async function mappingOf(input, saved, sheet) {
  const { headers, sample, headerText, ownGeometry } = await open(input, sheet ?? input.sheet);
  return { ...resolveColumns(headers, sample, saved, headerText, { ownGeometry }), headers };
}
/**
 * The saved mapping in what genericProfile was given: the run's options (their `columns`), or, as
 * before the options were passed whole, a mapping alone. A mapping alone is told by its values:
 * each a string or a { field } object, and at least one a field's name. Options hold something
 * else (an address, a title, a function), or a `columns` key.
 */
export function savedColumns(given) {
  if (given === undefined || given === null || typeof given !== 'object' || Array.isArray(given)) return given;
  const c = Object.hasOwn(given, 'columns') ? given.columns : undefined;
  if (c !== undefined && typeof c !== 'string' && !(c && typeof c === 'object' && typeof c.field === 'string')) return c;
  const values = Object.values(given);
  const entry = (v) => typeof v === 'string' || (v !== null && typeof v === 'object' && typeof v.field === 'string');
  const named = (v) => { const f = typeof v === 'string' ? v : v.field; return Object.hasOwn(FIELDS, f) || Object.hasOwn(OTHER, f); };
  return values.length && values.every(entry) && values.some(named) ? given : c;
}
/**
 * 'attestation-centric' when a column holds the places' web addresses, or when rows with the same
 * id are one place (options.sameId, with an id column), else 'place-centric'. `options` are the
 * run's options (`options.columns` a saved mapping, else the guess is used); a saved mapping alone is
 * still accepted (savedColumns).
 */
export async function genericProfile(input, options) {
  const saved = savedColumns(options);
  const { mapping } = await mappingOf(input, saved, sheetIn(input, options));
  const fields = Object.values(mapping);
  const sameId = saved !== options && options?.sameId === true && fields.includes('id');
  return fields.includes('address') || sameId ? 'attestation-centric' : 'place-centric';
}

/**
 * The records of a CSV or plain GeoJSON input: a header, then a 'record' for each place
 * (place-centric), or an 'attestation' for each row about a web address (attestation-centric).
 * `options.columns` is a saved mapping (else the guess is used); `options.base` the base address
 * places' addresses are made under, `defaultBase` the stand-in used without one; `options.sameId`
 * reads rows with the same id as evidence about one place (an attestation each, and one new place
 * for each id at the end).
 */
export async function* genericSource(input, rep, options = {}, defaultBase = 'https://example.org/my-dataset/') {
  const file = input.files[0];
  const report = (kind, example) => rep.add(GENERIC_KINDS[kind] || 'loss', kind, LOSS_TEXT[kind] || kind, example);
  const sheet = sheetIn(input, options);
  const t = await open(input, sheet);
  const { mapping, patterns, levels, splits, problems } = resolveColumns(t.headers, t.sample, options.columns, t.headerText, { ownGeometry: t.ownGeometry });
  for (const p of [...(t.headProblems || []), ...problems]) report(p.kind, p.example);
  // A column split into levels is a column of its own for each part (columns.js, expandSplits).
  const expanded = expandSplits(mapping, levels, splits);
  const fields = Object.values(expanded.mapping);
  const byAddress = fields.includes('address'), hasId = fields.includes('id');
  // Rows with the same id as one place: each id, and the names its rows give (no row is kept).
  const sameId = options.sameId === true && hasId;
  const places = sameId ? new Map() : null;
  const attestationCentric = byAddress || sameId;
  const what = input.container === 'workbook' ? `a table of places, the sheet "${sheet}" of a workbook` : input.format === 'csv' ? 'a table of places (CSV)' : 'plain GeoJSON';
  const title = options.title || (typeof t.head.title === 'string' && t.head.title) || (typeof t.head.name === 'string' && t.head.name) || `Places in ${file.name}`;
  yield { type: 'header', value: {
    profile: byAddress || sameId ? 'attestation-centric' : 'place-centric',
    gazetteer: { title, description: `Converted by PLATO tools from ${what}, ${file.name}: one attestation for each ${input.format === 'csv' ? 'row' : 'feature'}${byAddress ? ', about the place whose web address it gives' : ''}${sameId ? `${byAddress ? ', or else ' : ', '}about the place its id names, ${input.format === 'csv' ? 'rows' : 'features'} with the same id being one place` : ''}.` },
  } };
  // A sheet with nothing on it: said once, as an error, and nothing more is read.
  if (t.empty) { report('generic-sheet-empty', `"${sheet}" in ${file.name}`); return; }
  const base = options.base || defaultBase;
  if (!byAddress && !hasId) report('generic-no-ids', file.name);
  const minted = tableIds(base, () => null);
  // The regions the rows' places lie in (within.js), as PLATO's worked example has them
  // (schemas/examples/place-centric-regions.json, PLATO 1d2cf6e): with a base address of the user's
  // own, each distinct container (the same value under the same parents, containerKey) is minted once
  // as a place of its own, <base>place/region-<hex>, labelled with its name and, after it, its parents
  // narrowest first ("Surrey (England)"), with a name attestation and a plato:ContainedIn attestation
  // to its parent region; each row's place is ContainedIn its narrowest region, and the chain above
  // it follows from the regions. Without a base address, the chain is kept in the notes (columns.js,
  // applyColumns), and that is said once. Only the keys of the regions made are held, never a row.
  const containment = !!options.base;
  const regionsMade = new Set();
  let withinNoted = false;
  const regionIri = (key) => minted.place(regionId(key));
  // What a region's and a place's attestations cite: what the row's attestation cites.
  const cites = (att) => ({ sources: att.sources, citations: att.citations });
  const containedIn = (value, iri, att) => ({ relations: [{ relationType: CONTAINED_IN, relatesTo: iri, relatedLabel: value }], ...cites(att) });
  // For a row read as `a`: the events of the regions not yet made, and the place's ContainedIn attestation.
  const regionsOf = (a) => {
    const events = [], contained = [];
    if (!a.within) return { events, contained };
    if (!containment) {
      if (!withinNoted) { withinNoted = true; report('generic-within-no-base', file.name); }
      return { events, contained };
    }
    const parents = [];
    let parentIri, iri;
    a.within.forEach((c, i) => {
      const key = containerKey(c.level, c.value, parents);
      iri = regionIri(key);
      if (!regionsMade.has(key)) {
        regionsMade.add(key);
        const own = [{ names: [{ toponym: c.value }], ...cites(a.attestation) }];
        if (parentIri) own.push(containedIn(parents[parents.length - 1], parentIri, a.attestation));
        const chain = a.within.slice(0, i);
        const tags = { region: { level: c.level, key }, ...(chain.length ? { within: chain } : {}) };
        const label = parents.length ? `${c.value} (${[...parents].reverse().join(', ')})` : c.value;
        const value = { '@id': iri, label, entityIdentifier: key, attestations: [] };
        // Attestation-centric: a new place, its attestations given on their own, about it.
        if (attestationCentric) { events.push({ type: 'record', newEntity: true, value, ...tags }); for (const x of own) events.push({ type: 'attestation', value: { about: iri, ...x }, ...tags }); }
        else { value.attestations.push(...own); events.push({ type: 'record', value, ...tags }); }
      }
      parents.push(c.value); parentIri = iri;
    });
    contained.push(containedIn(a.within[a.within.length - 1].value, iri, a.attestation));
    return { events, contained };
  };
  let standIn = false;
  const mint = (id) => { if (!options.base && !standIn) { standIn = true; report('generic-stand-in-base', base); } return minted.place(id); };
  // Each id met, with the number of its row (a number, not the row, so that a large file's ids are
  // all that is kept).
  const seen = new Map();
  const whereOf = (k) => (input.format === 'csv' ? `row ${k + 1}` : `feature ${k}`);
  const skipped = new Set();
  let n = 0, out = 0;
  for await (const r of t.rows()) {
    if (r.notAList) { report('generic-features-not-list', `features is ${r.notAList}`); continue; }
    n++;
    rep.count(input.format === 'csv' ? 'rows' : 'features');
    if (r.notFeature) { report('generic-not-feature', r.where); continue; }
    if (r.problem) report('generic-csv-row', `${r.where}: ${r.problem}`);
    if (r.extra?.length) report('generic-csv-extra-cells', `${r.where}: ${r.extra.join(', ')}`);
    for (const k of r.keys || []) report('generic-feature-key', k);
    // A cell holding an error carries nothing (it is read as empty), and is lost aloud.
    for (const e of r.cellErrors || []) report('generic-sheet-error-cell', `${r.where}, ${e.column.trim() ? `column "${e.column}"` : `column ${e.ref.replace(/\d+$/, '')} (no heading)`}, cell ${e.ref}: ${e.text}`);
    const row = splitRow(r.row, splits, { report, where: r.where });
    const a = applyColumns(row, expanded.mapping, { where: r.where, report, fileName: file.name, geometry: r.geometry, idAsNote: byAddress, patterns, levels: expanded.levels, from: expanded.from, withinNote: !containment });
    for (const c of a.skipped) skipped.add(c);
    // The regions the row's place lies in, widest first, on the event and never in its value (within.js).
    const w = a.within ? { within: a.within } : {};
    if (byAddress && a.address) {
      out++;
      const { events, contained } = regionsOf(a);
      yield* events;
      yield { type: 'attestation', value: { about: a.address, ...a.attestation }, n, ...w };
      for (const c of contained) yield { type: 'attestation', value: { about: a.address, ...c }, n, ...w };
      continue;
    }
    // A row about an address that gives none it can use is still read: with an id, it is a place of
    // its own (a new place, beside the attestations); without one, it has nothing to be about.
    if (byAddress && (a.id === undefined || !a.label)) {
      if (a.addressLost) { /* reported, with why, as the address was read */ }
      else if (a.addressText) report('generic-address-not-web', `${r.where}: ${a.addressText}`);
      else report(a.label ? 'generic-no-address' : 'generic-row-empty', r.where);
      continue;
    }
    if (!a.label) { report('generic-row-no-name', r.where); continue; }
    if (sameId) {
      // Evidence about the place its id names: an attestation needs that address, so a row with no id is lost.
      if (a.id === undefined) { report('generic-same-id-empty', r.where); continue; }
      let p = places.get(a.id);
      if (!p) places.set(a.id, (p = { names: new Set() }));
      p.names.add(a.label);
      out++;
      const { events, contained } = regionsOf(a);
      yield* events;
      yield { type: 'attestation', value: { about: mint(a.id), ...a.attestation }, n, ...w };
      for (const c of contained) yield { type: 'attestation', value: { about: mint(a.id), ...c }, n, ...w };
      continue;
    }
    const rec = {};
    if (a.id !== undefined) {
      if (seen.has(a.id)) throw new DataError(`The id "${a.id}" is used by more than one ${input.format === 'csv' ? 'row' : 'feature'} (${whereOf(seen.get(a.id))} and ${r.where}). Each id becomes the web address of a place, so ids must be unique: correct the duplicate, or map another column as the id, or, if every ${input.format === 'csv' ? 'row' : 'feature'} is evidence about the same place, read ${input.format === 'csv' ? 'rows' : 'features'} with the same id as one place (Reading options, or --same-id).`);
      seen.set(a.id, n);
      rec['@id'] = mint(a.id);
    } else if (hasId) report('generic-id-empty', r.where);
    rec.label = a.label;
    if (a.id !== undefined) rec.entityIdentifier = a.id;
    const { events, contained } = regionsOf(a);
    rec.attestations = [a.attestation, ...contained];
    yield* events;
    out++;
    yield byAddress ? { type: 'record', value: rec, n, newEntity: true, ...w } : { type: 'record', value: rec, n, ...w };
  }
  // Each id read with options.sameId is one new place, its attestations the rows above. Its label is
  // the name its rows agree on; where they differ, none is picked: the label is the id, and the names
  // are reported (every one is still its own row's attestation's).
  if (sameId) {
    for (const [id, p] of places) {
      const names = [...p.names];
      if (names.length > 1) report('generic-same-id-label', `"${id}": ${names.slice(0, 5).join(' / ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}`);
      yield { type: 'record', newEntity: true, value: { '@id': mint(id), label: names.length > 1 ? id : names[0], entityIdentifier: id, attestations: [] } };
    }
  }
  // A skipped column is reported once, by name, if it had a value to lose.
  for (const c of skipped) report('generic-column-skipped', c);
  // Rows read and nothing made of them is an error, never "No problems found": every row was lost,
  // most likely because no column is matched as what a row needs.
  const rows = input.format === 'csv' ? 'rows' : 'features';
  if (!n) report('generic-empty', `${file.name}: no ${rows}`);
  else if (!out) {
    const why = byAddress ? "no row's web address could be used, and none has both an id and a name to make it a place of its own"
      : !fields.includes('name') && !fields.includes('alternativeNames') ? "no column is matched as the place's name (or its other names), or as its web address"
        : 'the columns matched as the name are empty in every row';
    report('generic-nothing-converted', `${n === 1 ? `The one ${rows.slice(0, -1)} did not become` : `None of the ${n.toLocaleString('en-GB')} ${rows} became`} a place: ${why}`);
  }
}
