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

async function wholeText(file) {
  const reader = (await textStream(file)).getReader();
  let s = '';
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; s += value; } }
  catch (e) { throw new DataError(`The file stops, or is damaged, part-way through, so it cannot be read to the end (${String(e && (e.message || e.name) || e).split('\n')[0]}).`); }
  return s.replace(/^﻿/, '');
}

// What has been read of each input, so that finding the profile, the columns and the rows reads the
// file once (a CSV file is parsed whole, as the spreadsheet tables are).
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
async function openCsv(file, input) {
  const parsed = Papa.parse(await wholeText(file), { header: true, skipEmptyLines: 'greedy', ...(input.delimiter ? { delimiter: input.delimiter } : {}) });
  const headers = parsed.meta.fields || [];
  if (!headers.length || headers.every((h) => h.trim() === '')) throw new DataError('The CSV file has no header row naming its columns, so its columns cannot be read.');
  // Papa's errors, by row: a row with more or fewer cells than the header is read as far as it goes,
  // and is reported; a file with one column has no delimiter to detect, which is not a problem.
  const problems = new Map();
  for (const e of parsed.errors) {
    if (e.code === 'UndetectableDelimiter') continue;
    if (e.row === undefined) throw new DataError(`The CSV file cannot be read: ${e.message}.`);
    problems.set(e.row, e.message);
  }
  return {
    headers, sample: parsed.data.slice(0, SAMPLE), head: {},
    *rows() {
      for (const [i, row] of parsed.data.entries()) {
        const where = `row ${i + 2}`;   // as a spreadsheet numbers it, the header being row 1
        const extra = row.__parsed_extra;
        if (extra) delete row.__parsed_extra;
        yield { row, where, problem: problems.get(i), extra };
      }
    },
  };
}
async function openGeojson(file, input) {
  const head = {};
  const headers = [], seen = new Set(), sample = [];
  const add = (k) => { if (!seen.has(k)) { seen.add(k); headers.push(k); } };
  const rowOf = (f) => ({ ...(f.properties && typeof f.properties === 'object' ? f.properties : {}), ...(f.id !== undefined && f.id !== null ? { [FEATURE_ID]: f.id } : {}) });
  let features;
  if (input.shape === 'feature') {
    let f;
    try { f = JSON.parse(await wholeText(file)); } catch (e) { throw new DataError(`The JSON is not well formed, so the file cannot be read (${String(e.message).split('\n')[0]}).`); }
    features = async function* () { yield f; };
  } else {
    for await (const { path, value } of jsonDocument(file, { arrays: ['features'], keys: ['crs', 'name', 'title'], onlyKeys: true })) head[path] = value;
    features = async function* () { for await (const { value } of jsonDocument(file, { arrays: ['features'] })) yield value; };
  }
  const crs = head.crs?.properties?.name;
  if (head.crs && !(typeof crs === 'string' && WGS84.test(crs))) throw new DataError(`The GeoJSON names a coordinate reference system other than WGS 84 longitude and latitude (${typeof crs === 'string' ? crs : JSON.stringify(head.crs)}), so its coordinates cannot be read as degrees. Convert it to WGS 84 (EPSG:4326) first.`);
  // The columns are every property any feature has, in the order they are first met, and the
  // feature's own id first when any feature has one.
  let anyId = false;
  for await (const f of features()) {
    if (!f || typeof f !== 'object' || f.type !== 'Feature') continue;
    if (f.id !== undefined && f.id !== null) anyId = true;
    if (f.properties && typeof f.properties === 'object') for (const k of Object.keys(f.properties)) add(k);
    if (sample.length < SAMPLE) sample.push(rowOf(f));
  }
  if (anyId) headers.unshift(FEATURE_ID);
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
  const { headers, sample } = await open(input);
  return resolveColumns(headers, sample, saved);
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
  const { mapping, problems } = resolveColumns(t.headers, t.sample, options.columns);
  for (const p of problems) report(p.kind, p.example);
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
  const seen = new Map();
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
    if (!a.label) { report('generic-row-empty', r.where); continue; }
    const rec = {};
    if (a.id !== undefined) {
      if (seen.has(a.id)) throw new DataError(`The id "${a.id}" is used by more than one ${input.format === 'csv' ? 'row' : 'feature'} (${seen.get(a.id)} and ${r.where}). Each id becomes the web address of a place, so ids must be unique: correct the duplicate, or map another column as the id.`);
      seen.set(a.id, r.where);
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
