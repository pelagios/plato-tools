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
import { jsonDocument, DataError } from '../input.js';
import { csvRecords, textChunks } from '../../formats/csv.js';
import { LOSS_TEXT } from '../report.js';
import { tableIds } from '../../formats/tables.js';
import { resolveColumns, applyColumns, GENERIC_KINDS, FEATURE_ID, FIELDS, OTHER } from './columns.js';

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
  const { headers, sample } = await open(input);
  return { headers, sample };
}
/**
 * The mapping a run of this input uses: { mapping, reasons, problems, gazetteer } (columns.js,
 * resolveColumns), and `headers`, the columns in the file's order (which the mapping, an object,
 * does not keep for a column whose heading is a number).
 */
export async function mappingOf(input, saved) {
  const { headers, sample, headerText, ownGeometry } = await open(input);
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
 * 'attestation-centric' when a column holds the places' web addresses, else 'place-centric'.
 * `options` are the run's options (`options.columns` a saved mapping, else the guess is used); a
 * saved mapping alone is still accepted (savedColumns).
 */
export async function genericProfile(input, options) {
  const { mapping } = await mappingOf(input, savedColumns(options));
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
  const { mapping, patterns, problems } = resolveColumns(t.headers, t.sample, options.columns, t.headerText, { ownGeometry: t.ownGeometry });
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
  let n = 0, out = 0;
  for await (const r of t.rows()) {
    if (r.notAList) { report('generic-features-not-list', `features is ${r.notAList}`); continue; }
    n++;
    rep.count(input.format === 'csv' ? 'rows' : 'features');
    if (r.notFeature) { report('generic-not-feature', r.where); continue; }
    if (r.problem) report('generic-csv-row', `${r.where}: ${r.problem}`);
    if (r.extra?.length) report('generic-csv-extra-cells', `${r.where}: ${r.extra.join(', ')}`);
    for (const k of r.keys || []) report('generic-feature-key', k);
    const a = applyColumns(r.row, mapping, { where: r.where, report, fileName: file.name, geometry: r.geometry, idAsNote: byAddress, patterns });
    for (const c of a.skipped) skipped.add(c);
    if (byAddress && a.address) { out++; yield { type: 'attestation', value: { about: a.address, ...a.attestation }, n }; continue; }
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
    out++;
    yield byAddress ? { type: 'record', value: rec, n, newEntity: true } : { type: 'record', value: rec, n };
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
