// The engine: read any supported input as one stream of PLATO records (or triples), and write it
// out in any supported format, or check it. It is given its storage and outputs by its host
// (src/engine/worker.js in the browser, test/pipeline.test.js in Node), so the same code runs in
// both. Inputs that must be gathered before they can be written (RDF, attestation-centric JSON)
// go through the on-disk triple store; everything else streams straight through.
import { Parser } from 'n3';
import Papa from 'papaparse';
import Ajv2020 from 'ajv/dist/2020.js';
import { addPlatoFormats, strictFormatLogger } from '../lib/formats.js';
import { Json2Rdf } from '../formats/json2rdf.js';
import { Rdf2Json } from '../formats/rdf2json.js';
import { tripleNT } from '../lib/ntriples.js';
import { TripleStore, TableStore } from '../lib/store.js';
import { PLATO, RDF } from '../lib/context.js';
import { featureToRecord, recordToFeature, collectionHead, collectionToGazetteer } from '../formats/lpf.js';
import { list, collectWithdrawn, resolveWithdrawn, addWithdrawal, versionLosses, tableLosses, relationTypeLosses, collectMembership, membershipCycles } from '../formats/shared.js';
import { CubeExport, CUBE_TEXT } from '../formats/cube.js';
import { validateTables, checkTableRules, checkAboutRules, aboutToGazetteer, gazetteerToAbout, rowToAttestation, tableIds, recordToRows, settleRelatedPlaces, identityRow, ATTESTATION_SHEETS, tableSchemas, cellChecker, sourceLosses } from '../formats/tables.js';
import { AnnotationReader, ANNOTATION_KINDS } from '../formats/annotations.js';
import { teiSource } from './hermes/tei.js';
import { genericSource, genericProfile } from './hermes/generic.js';
import { lineChunks, lines, jsonDocument, annotationItems, TABLE_SHEETS, DataError, sheetOf, zipEntries, zipEntryText } from './input.js';
import { csvRecords, textChunks, papaRecords, papaRow } from '../formats/csv.js';
import { Report, LOSS_TEXT, droppedText, FORMAT_WORDS, WORKBOOK_TEXT, dateTimeWords } from './report.js';

export const TARGETS = {
  'plato-jsonl': { label: 'PLATO JSON Lines (.jsonl): one place per line', ext: '.jsonl' },
  'plato-json': { label: 'PLATO JSON document (.json), place-centric', ext: '.json' },
  ntriples: { label: 'RDF, N-Triples (.nt)', ext: '.nt' },
  tables: { label: 'PLATO spreadsheet tables (.zip of ten CSV files)', ext: '.zip' },
  'lpf-seq': { label: 'Linked Places Format v1, GeoJSON sequence (.geojsonl): one feature per line', ext: '.geojsonl' },
  lpf: { label: 'Linked Places Format v1, FeatureCollection (.geojson)', ext: '.geojson' },
};
const TYPE = RDF + 'type';
// The base address for the places and sources of spreadsheet tables when neither the conversion
// (--base, the page's field) nor the about sheet's base_uri gives one: a stand-in, not a permanent one.
export const DEFAULT_TABLE_BASE = 'https://example.org/my-dataset/';

// ---- resources ------------------------------------------------------------------------------------
export function prepare(res) {
  // An unknown format is refused, not ignored: ignored, it would check nothing (see src/lib/formats.js).
  const ajv = addPlatoFormats(new Ajv2020({ strict: false, allErrors: true, logger: strictFormatLogger }));
  ajv.addSchema(res.core, 'https://w3id.org/plato/schemas/plato.schema.json');
  for (const p of Object.values(res.profiles)) ajv.addSchema(p);
  const v = {};
  for (const [name, p] of Object.entries(res.profiles)) {
    const arrays = new Set(['spatialEntities', 'newSpatialEntities', 'attestations', 'identityRelations', 'candidates']);
    const headSchema = { ...p, $id: p.$id.replace('.schema.json', '.header.schema.json'), required: (p.required || []).filter((k) => !arrays.has(k)),
      properties: Object.fromEntries(Object.entries(p.properties).filter(([k]) => !arrays.has(k))) };
    v[name] = {
      header: ajv.compile(headSchema),
      entity: p.properties.spatialEntities ? ajv.getSchema(p.$id + '#/properties/spatialEntities/items') : null,
      newEntity: p.properties.newSpatialEntities ? ajv.getSchema(p.$id + '#/properties/newSpatialEntities/items') : null,
      attestation: p.properties.attestations ? ajv.getSchema(p.$id + '#/properties/attestations/items') : null,
      candidate: p.properties.candidates ? ajv.getSchema(p.$id + '#/properties/candidates/items') : null,
      identity: ajv.getSchema('https://w3id.org/plato/schemas/plato.schema.json#/$defs/identityRelation'),
    };
  }
  return { ...res, validators: v };
}
// Which schema error to show. With allErrors, a value that fails a oneOf (a source that may be a
// URI or an object) yields one error per branch, then the oneOf's own: shown in that order, an
// object source without a title read "must be string" and sent the reader after the wrong fix.
// An error about the content of a value (a missing title, a malformed address) says what to
// change, so it comes before one saying the value is of another type, and those before the
// bare "must match exactly one schema".
const RANK = { oneOf: 2, anyOf: 2, not: 2, if: 2, type: 1 };
const pick = (errs) => [...(errs || [])].sort((a, b) => (RANK[a.keyword] || 0) - (RANK[b.keyword] || 0));
const ajvMessage = (errs) => pick(errs).slice(0, 1).map((e) => `${e.instancePath || '(record)'} ${e.message}${e.params?.additionalProperty ? `: ${e.params.additionalProperty}` : ''}`).join('; ');
/** The first schema error in plain words, with the spreadsheet column where that helps. */
export function explainSchema(errs, fromTables) {
  const e = pick(errs)[0];
  if (!e) return 'does not match the PLATO JSON Schema';
  const at = e.instancePath || '';
  const col = (c) => (fromTables ? ` In the spreadsheets, fill in ${c}.` : '');
  // How many anchors relativeTo has (PLATO 7720890, #19): a qualification's conditional rules, whose
  // raw words ("relativeTo must NOT be valid") say nothing. A bearing or distance is ruled out with
  // `not`; Between X and Y's two anchors by type, minItems, maxItems or required.
  const anchors = (errs || []).find((x) => /\/then\/(properties\/relativeTo|required)/.test(x.schemaPath || '')
    && (/qualification\/relativeTo$/.test(x.instancePath || '') || (x.keyword === 'required' && x.params?.missingProperty === 'relativeTo' && /qualification$/.test(x.instancePath || ''))));
  if (anchors) return anchors.keyword === 'not' ? 'A bearing or distance needs a single anchor: relativeTo gives one place, not a list.' : 'Between X and Y needs exactly two anchors: relativeTo gives a list of the two places, in either order.';
  if (e.keyword === 'required') {
    const p = e.params.missingProperty;
    if (p === 'identifier' && /types\/\d+$/.test(at)) return 'A type has no identifier: PLATO JSON requires the web address of the concept in a published vocabulary.' + col('type_uri');
    if (p === 'label') return 'A place has no label.' + col('label');
    if (p === 'toponym') return 'A name has no spelling (toponym).' + col('name');
    if (p === 'identityType') return 'An identity match does not say what kind of match it is (exactMatch, closeMatch, related, or unspecified if the source does not say): PLATO JSON requires it.' + col('match_type');
    if (p === 'title') return 'A source has no title.' + col('title');
    // A relation gives relatesTo, or relatedLabel alone (PLATO 7720890, #18): with neither, each is reported missing.
    if ((p === 'relatesTo' || p === 'relatedLabel') && /relations\/\d+$/.test(at)) return 'A relation names no target: give relatesTo, or relatedLabel alone where there is no address.' + col('related_place_id or related_uri, or related_label alone');
    // PLATO issue #14: a value is required unless the figure's attributes give obsStatus.
    if (p === 'value' && /properties\/\d+$/.test(at)) return 'A property value has no value. Give it, or, for a figure that has none (a printed dash), say why with sdmx-attribute:obsStatus in its attributes; a dash is never written as 0.';
    return `Something required is missing: ${p}.`;
  }
  if (e.keyword === 'minItems' && /attestations$/.test(at)) return 'A place has no evidence about it: PLATO JSON needs at least one attestation per place.' + (fromTables ? ' Give it at least one row in names, locations, types, relations or properties.' : '');
  if (e.keyword === 'additionalProperties') return `A key PLATO does not define: ${e.params.additionalProperty}.`;
  if (e.keyword === 'format' && ['uri', 'iri', 'iri-reference'].includes(e.params.format)) return 'A value that must be a full web address is not one.';
  if (e.keyword === 'enum') return `A value is not one of those allowed: ${(e.params.allowedValues || []).join(', ')}.`;
  if (e.keyword === 'not' && /attestations\/\d+$/.test(at)) return 'An attestation nested under its place also says what it is about; in place-centric JSON that is implied, and must be left out.';
  return 'does not match the PLATO JSON Schema: ' + ajvMessage(errs).replace(/"[^"]*"/g, '…');
}

// ---- sources: every input becomes a stream of events ------------------------------------------
// { type: 'header', value } | { type: 'record', value } | { type: 'attestation', value } | { type: 'idr', value } | { type: 'triple', s, p, o }

async function* platoJsonl(file, rep) {
  let first = true;
  for await (const { line, n } of lines(file)) {
    let v;
    try { v = JSON.parse(line); } catch (e) { rep.error('json-syntax', 'A line is not valid JSON', `line ${n}: ${e.message}`); continue; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) { rep.error('jsonl-not-an-object', 'A line is not a JSON object, so it is neither a place, an attestation nor an identity relation, and is not read', `line ${n}: ${line.slice(0, 80)}`); continue; }
    if (first) { first = false; if (v.profile) { yield { type: 'header', value: v }; continue; } yield { type: 'header', value: { profile: 'place-centric', gazetteer: { title: file.name } } }; }
    if (v.subject && v.object && v.identityType !== undefined) yield { type: 'idr', value: v, n };
    else if (v.about !== undefined && !v.label && !v.attestations) yield { type: 'attestation', value: v, n };
    else yield { type: 'record', value: v, n };
  }
}
async function* platoJson(file) {
  // dataSets (PLATO issue #14) are the document's statistical tables, and relationTypes (PLATO 0.6.0) the
  // relation types it declares: both part of its header.
  const keys = ['gazetteer', 'profile', '$schema', 'dataSets', 'relationTypes'];
  const head = {};
  for await (const { path, value } of jsonDocument(file, { arrays: ['spatialEntities', 'newSpatialEntities', 'attestations', 'identityRelations'], keys, onlyKeys: true })) head[path] = value;
  if (!('gazetteer' in head)) for await (const { path, value } of jsonDocument(file, { keys })) head[path] = value;   // header after the arrays: rare
  yield { type: 'header', value: head };
  let n = 0;
  for await (const { path, value, notAList } of jsonDocument(file, { arrays: ['spatialEntities', 'newSpatialEntities', 'attestations', 'identityRelations'], keys: ['dataSets', 'relationTypes'] })) {
    if (notAList) { yield { type: 'not-a-list', key: path, shape: notAList }; continue; }
    // The header is read before the records, so dataSets or relationTypes written after them are met only now.
    if (path === 'dataSets' || path === 'relationTypes') { if (!(path in head)) yield { type: 'late-header', key: path }; continue; }
    n++;
    if (path === 'identityRelations') yield { type: 'idr', value, n };
    else if (path === 'attestations') yield { type: 'attestation', value, n };
    else yield { type: 'record', value, n, newEntity: path === 'newSpatialEntities' };
  }
}
// The FeatureCollection's own members that PLATO's gazetteer header holds (collectionToGazetteer).
const LPF_HEAD = ['@id', 'id', 'title', 'license', 'descriptions'];
const notAListText = (key, shape) => `The document's ${key} is ${shape}, not a list, so it is not read as one.`;
async function* lpfSource(file, seq, rep) {
  let head = {};
  if (seq) {
    // A GeoJSON sequence may open with the collection's own line, as these tools write it.
    for await (const { line } of lines(file)) { try { const v = JSON.parse(line); if (v && v.type === 'FeatureCollection') head = v; } catch { /* reported below */ } break; }
  } else for await (const { path, value } of jsonDocument(file, { arrays: ['features'], keys: LPF_HEAD, onlyKeys: true })) head[path] = value;
  const loss = (l) => rep.loss(l.kind, LOSS_TEXT[l.kind] || l.kind, l.value);
  yield { type: 'header', value: { profile: 'place-centric', gazetteer: collectionToGazetteer(head, file.name, loss) } };
  const each = seq ? (async function* () {
    let first = true;
    for await (const { line, n } of lines(file)) {
      let v;
      try { v = JSON.parse(line); } catch (e) { first = false; rep.error('json-syntax', 'A line is not valid JSON', `line ${n}: ${e.message}`); continue; }
      if (v && v.type === 'Feature') yield { v, n };
      // The collection's own line, first, is the header read above; anything else is not read.
      else if (!(first && v && v.type === 'FeatureCollection')) rep.error('lpf-not-a-feature', 'A line of the GeoJSON sequence is not an LPF feature (its type is not "Feature"), so it is not read', `line ${n}`);
      first = false;
    }
  })()
    : (async function* () {
      let n = 0;
      for await (const { path, value, notAList } of jsonDocument(file, { arrays: ['features'] })) {
        if (notAList) { rep.error('not-a-list', notAListText(path, notAList), path); continue; }
        yield { v: value, n: ++n };
      }
    })();
  for await (const { v, n } of each) {
    if (!v['@id']) rep.warning('lpf-no-id', 'An LPF feature has no @id', `feature ${n}`);
    if (!v.properties?.title) rep.warning('lpf-no-title', 'An LPF feature has no properties.title', v['@id'] || `feature ${n}`);
    if (!v.names?.length) rep.warning('lpf-no-names', 'An LPF feature has no names (LPF requires at least one)', v['@id'] || `feature ${n}`);
    yield { type: 'record', value: featureToRecord(v, loss), n };
  }
}
// W3C Web Annotations (Recogito's export): each annotation that links a passage to a place becomes
// an attestation-centric attestation about that place (src/formats/annotations.js). The header is
// written from the first annotation, so it waits for it; every kind the reader reports goes to the
// report with the severity ANNOTATION_KINDS gives it. With georeferences (input.georefs, and the
// maps' manifests, input.manifests: dropped with the export, or --georef and --manifest), each
// annotation's regions are placed in the world (src/formats/regions.js); without them, nothing of
// the georeference module is loaded and the annotations are read as before.
async function* annotationSource(input, rep) {
  const file = input.files[0];
  const reader = new AnnotationReader((kind, example) => rep.add(ANNOTATION_KINDS[kind] || 'loss', kind, LOSS_TEXT[kind] || kind, example));
  const placing = input.georefs?.length > 0;
  if (placing) await reader.useGeoreferences(input.georefs, input.manifests || []);
  else for (const m of input.manifests || []) rep.add(ANNOTATION_KINDS['annotation-manifest-unused'], 'annotation-manifest-unused', LOSS_TEXT['annotation-manifest-unused'], m.name);
  const items = input.shape === 'jsonl' ? (async function* () {
    for await (const { line, n } of lines(file)) {
      try { yield { annotation: JSON.parse(line) }; } catch (e) { rep.error('json-syntax', 'A line is not valid JSON', `line ${n}: ${e.message}`); }
    }
  })() : annotationItems(file, input.shape);
  let label, headed = false, n = 0;
  for await (const it of items) {
    if ('label' in it) { label = it.label; continue; }
    if ('next' in it) { rep.warning('annotation-more-pages', LOSS_TEXT['annotation-more-pages'], it.next); continue; }
    if (!headed) { headed = true; yield { type: 'header', value: reader.header(it.annotation, file.name, label) }; }
    n++; rep.count('annotations');
    const attestations = reader.annotation(it.annotation, n);
    if (placing) await reader.place(it.annotation, attestations);
    for (const a of attestations) yield { type: 'attestation', value: a, n };
  }
  if (!headed) yield { type: 'header', value: reader.header(null, file.name, label) };
  reader.finish();
}
async function* rdfSource(file, format, rep) {
  if (format === 'turtle') {
    // N3 accepts any object with on('data') / on('end') as a stream; this shim feeds it chunks.
    const handlers = {}; const quads = []; let finished = false, failure = null, read = 0;
    const input = { on: (ev, fn) => { handlers[ev] = fn; return input; } };
    new Parser({ format: 'text/turtle' }).parse(input, (err, q) => { if (err) failure = err; else if (q) quads.push(q); else finished = true; });
    // Turtle cannot be read on past a syntax error, as N-Triples can line by line: what was parsed
    // before it is read, and the run stops there, incomplete, so no partial output is kept.
    const broken = () => new DataError(`The Turtle cannot be parsed past a syntax error, so the file cannot be read to the end; the ${read} statements before it were read (${String(failure.message).split('\n')[0]}).`);
    for await (const chunk of lineChunks(file)) {
      handlers.data(chunk);
      while (quads.length) { const q = quads.shift(); read++; yield { type: 'triple', s: q.subject, p: q.predicate, o: q.object }; }
      if (failure) throw broken();
    }
    handlers.end();
    while (quads.length) { const q = quads.shift(); read++; yield { type: 'triple', s: q.subject, p: q.predicate, o: q.object }; }
    if (failure) throw broken();
    return;
  }
  const fmt = format === 'nquads' ? 'N-Quads' : 'N-Triples';
  let lineNo = 0;
  for await (const chunk of lineChunks(file)) {
    let quads;
    try { quads = new Parser({ format: fmt, blankNodePrefix: '' }).parse(chunk); }
    catch (e) {
      // Report the failing line precisely, then carry on line by line within this chunk.
      quads = [];
      for (const [i, l] of chunk.split('\n').entries()) {
        if (!l.trim()) continue;
        try { quads.push(...new Parser({ format: fmt, blankNodePrefix: '' }).parse(l + '\n')); }
        catch (e2) { rep.error('rdf-syntax', 'A line is not valid ' + fmt, `line ${lineNo + i + 1}: ${e2.message.split('\n')[0]}`); }
      }
    }
    lineNo += (chunk.match(/\n/g) || []).length;
    for (const q of quads) yield { type: 'triple', s: q.subject, p: q.predicate, o: q.object };
  }
}

// ---- tables: sheets from CSV files, a zip or a workbook -----------------------------------------
// The sheets stream into a working database (TableStore), one row at a time, so that a set of tables
// of any size is checked and converted in bounded memory: validated by scans of it, and read back
// one place at a time, with its attestations, in one streaming join. Each row is the object
// Papa.parse(text, { header: true }) made of it when the sheets were read whole (src/formats/csv.js),
// so streaming changes nothing a conversion writes or a check reports.
const SHEET_NO = Object.fromEntries(TABLE_SHEETS.map((s, i) => [s, i]));
// The attestation sheets, then identities, are numbered in the order a place's record lists them,
// identities last: the streaming join reads the sheets from FIRST_JOINED to the end.
const FIRST_JOINED = SHEET_NO[ATTESTATION_SHEETS[0]];
if (ATTESTATION_SHEETS.some((s, i) => SHEET_NO[s] !== FIRST_JOINED + i) || SHEET_NO.identities !== FIRST_JOINED + ATTESTATION_SHEETS.length || SHEET_NO.identities !== TABLE_SHEETS.length - 1) throw new Error('the sheets are not numbered in the order a record lists them');
// What a row is looked up by: a source by its source_id, as given (a source with none is found by
// none); a row of any other sheet by its place_id, when it has one.
const rowKey = (sheet, row) => (sheet === 'sources' ? row.source_id : sheet === 'about' || !row.place_id ? undefined : row.place_id);
const WORKBOOK_WHOLE = 50 * 2 ** 20;
// Where in a record a source is cited: an attestation's sources, an identity relation's source.
const SOURCE_AT = /\/(sources\/\d+|source)(\/|$)/;

/**
 * A number as the shortest text that reads back as the same number (JavaScript's String(n)), but
 * never in exponent form, which a CSVW decimal does not allow: 1e-7 is 0.0000001.
 */
export function numberText(n) {
  const s = String(n);
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const digits = m[2] + (m[3] || ''), exp = Number(m[4]);
  return m[1] + (exp < 0 ? `0.${'0'.repeat(-exp - 1)}${digits}` : digits + '0'.repeat(exp - digits.length + 1));
}

/**
 * A date cell's value as ISO 8601. The workbook is read with UTC: true, so the Date's UTC fields are
 * the date and time as stored, whatever the time zone of the machine. Midnight is a date
 * (YYYY-MM-DD, the form the tables' from and to take); any other time is a date and time with no
 * zone (YYYY-MM-DDThh:mm:ss, with the seconds' fraction only if there is one), as the workbook gives
 * none. A cell whose number format shows no day nor year is a time of day (hh:mm:ss).
 */
export function dateText(d, format) {
  const iso = d.toISOString(), t = iso.indexOf('T');
  const time = iso.slice(t + 1, -1).replace(/\.000$/, '');
  if (format && !/[dy]/i.test(format.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''))) return time;
  return time === '00:00:00' ? iso.slice(0, t) : `${iso.slice(0, t)}T${time}`;
}

/**
 * The columns of each sheet that take a date alone (YYYY-MM-DD, or a year), by sheet name: those
 * whose format in the table definitions accepts a date and refuses a date with a time of day.
 */
export function dateOnlyColumns(csvMeta) {
  const out = new Map();
  for (const t of csvMeta.tables) {
    const cols = t.tableSchema.columns.filter((c) => {
      const f = c.datatype?.format;
      if (typeof f !== 'string') return false;
      try { const re = new RegExp(f); return re.test('2020-07-01') && !re.test('2020-07-01T09:30:00'); } catch { return false; }
    }).map((c) => c.name);
    if (cols.length) out.set(t.url.replace(/\.csv$/, ''), new Set(cols));
  }
  return out;
}

/**
 * One sheet of a workbook (.xlsx or .ods, both read by SheetJS) as CSV text, each cell's value as
 * stored, not as its number format shows it: a coordinate formatted 0.00 keeps all its digits, a
 * percentage or an amount of money is the number itself (0.256, not 25.60%), and a date is ISO 8601,
 * not the m/d/yy of a format. A text cell is its text as typed, so 007 stays 007. In a column of
 * dateOnly (names from the header row, as a CSV file's are matched), a date with a time of day is
 * written as the date alone, and timeDropped(row, column, given, date) is told of it, row being the
 * row of the sheet (the header is row 1).
 */
export function workbookSheetCsv(XLSX, data, name, { dateOnly, timeDropped } = {}) {
  const wb = XLSX.read(data, { type: 'array', dense: true, cellDates: true, cellNF: true, UTC: true, sheets: name });
  const ws = wb.Sheets[name];
  const rows = ws['!data'] || [];
  // The header is the first row with anything in it, as sheet_to_csv leaves out blank rows.
  const header = rows.find((r) => r && r.some((c) => c && c.v !== undefined && c.v !== ''));
  const dateCol = (header || []).map((c) => !!(dateOnly && c && dateOnly.has(String(c.v).trim().toLowerCase())));
  rows.forEach((row, r) => (row || []).forEach((cell, c) => {
    if (!cell) return;
    if (cell.t === 'n' && typeof cell.v === 'number') cell.w = numberText(cell.v);
    else if (cell.t === 'd' && cell.v instanceof Date && !isNaN(cell.v)) {
      cell.w = dateText(cell.v, cell.z);
      if (row !== header && dateCol[c] && cell.w.includes('T')) {
        const date = cell.w.slice(0, cell.w.indexOf('T'));
        timeDropped?.(r + 1, String(header[c].v).trim(), cell.w.replace('T', ' ').replace(/:00$/, ''), date);
        cell.w = date;
      }
    }
  }));
  // Each number and date is written as the text set above (sheet_to_csv writes a cell's w).
  return XLSX.utils.sheet_to_csv(ws, { blankrows: false, rawNumbers: false }).replace(/^﻿/, '');
}

/** The sheets of the input, each { label, chunks() }: the last of several files for one sheet wins. */
async function tableSheetsOf(input, env, rep) {
  const sheets = new Map();
  if (input.container === 'csv') {
    // A sheet's text is UTF-8, strictly (input.js, textStream), as every other input's is; a sheet
    // compressed with gzip (places.csv.gz) is decompressed first, as every other input is.
    for (const f of input.files) { const b = sheetOf(f.name); if (b) sheets.set(b, { label: f.name, chunks: () => textChunks(f) }); }
  } else if (input.container === 'zip') {
    // The zip is read from its central directory, entry by entry, as each sheet is loaded. Where two
    // entries have one name, the later is read, in the place of the first, as unzipping them did.
    const file = input.files[0];
    const named = new Map();
    for (const e of await zipEntries(file)) if (e.name.toLowerCase().endsWith('.csv') && sheetOf(e.name)) named.set(e.name, e);
    for (const [name, e] of named) {
      const label = `${name} in ${file.name}`;
      sheets.set(sheetOf(name), { label, chunks: async function* () { yield* textChunks(await zipEntryText(file, e, label)); } });
    }
  } else {
    // A workbook can only be read whole (SheetJS), so it is read once for its sheets' names, then once
    // for each sheet, which is made into CSV text and read as a CSV file is.
    const XLSX = env.xlsx;
    const file = input.files[0];
    if (file.size > WORKBOOK_WHOLE) rep.warning('workbook-whole', 'A workbook is read whole into memory, one sheet at a time, so a very large one may not fit: save each sheet as CSV (UTF-8) and choose the CSV files, or a zip of them, which are read a row at a time', `${file.name}: ${(file.size / 2 ** 20).toFixed(0)} MB`);
    const data = new Uint8Array(await file.arrayBuffer());
    const damaged = (e) => new DataError(`The workbook is damaged or incomplete, so its sheets cannot be read (${String(e && e.message || e)}).`);
    let names;
    try { names = XLSX.read(data, { type: 'array', bookSheets: true }).SheetNames; }
    catch (e) { throw damaged(e); }
    for (const name of names) {
      if (!TABLE_SHEETS.includes(name.toLowerCase())) continue;
      const dateOnly = dateOnlyColumns(env.csvMeta).get(sheetOf(name));
      const timeDropped = (row, column, given, date) => rep.warning('workbook-date-time', WORKBOOK_TEXT['workbook-date-time'], dateTimeWords(name, row, column, given, date));
      sheets.set(sheetOf(name), { label: `${name} in ${file.name}`, chunks: async function* () {
        let csv;
        try { csv = workbookSheetCsv(XLSX, data, name, { dateOnly, timeDropped }); }
        catch (e) { throw damaged(e); }
        yield csv;
      } });
    }
  }
  return sheets;
}

/**
 * Load each sheet into the store: { fields, first, last, count } by sheet, or { unreadable } for a
 * sheet whose text stops it (not UTF-8, a quotation mark out of place, a damaged entry in the zip),
 * which is reported, and taken out, and the other sheets read.
 */
async function loadSheets(sheets, store, rep, progress, action) {
  const loaded = new Map();
  let rows = 0;
  for (const [sheet, { label, chunks }] of sheets) {
    const before = store.mark(), no = SHEET_NO[sheet];
    let fields = null, n = 0;
    try {
      for await (const cells of papaRecords(csvRecords(chunks(), { keepBlank: true }), (f) => { fields = f; })) {
        store.add(no, ++n, rowKey(sheet, papaRow(fields, cells)), cells);
        if (++rows % 50000 === 0) progress({ phase: 'loading', rows });
      }
      loaded.set(sheet, { fields, first: before + 1, last: store.mark(), count: n });
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      store.drop(before);
      loaded.set(sheet, { unreadable: true });
      // Where it stopped is a line of the file (the validator's rows are rows of the sheet, its
      // header row 1, and blank rows not counted).
      rep.error('table', `${sheet}.csv cannot be read, so it is not checked${action === 'convert' ? ', and nothing is converted' : ''}; the other sheets are checked`, e.message.startsWith(label) ? e.message : `${label}: ${e.message}`);
    }
  }
  return loaded;
}

/** The table definitions without the sheets that could not be read, nor the references to them. */
function readableMeta(meta, loaded) {
  const out = (url) => loaded.get(url.replace(/\.csv$/, ''))?.unreadable;
  if (!meta.tables.some((t) => out(t.url))) return meta;
  return { ...meta, tables: meta.tables.filter((t) => !out(t.url)).map((t) => ({ ...t, tableSchema: { ...t.tableSchema,
    ...(t.tableSchema.foreignKeys ? { foreignKeys: t.tableSchema.foreignKeys.filter((f) => !out(f.reference.resource)) } : {}) } })) };
}

async function* tablesSource(input, env, rep, options, action) {
  const t0 = Date.now();
  const progress = (p) => env.progress?.({ ...p, elapsedMs: Date.now() - t0 });
  const sheets = await tableSheetsOf(input, env, rep);
  const store = new TableStore(await env.openDb({ store: true }));
  try {
    const loaded = await loadSheets(sheets, store, rep, progress, action);
    const known = (n) => !!loaded.get(n) && !loaded.get(n).unreadable;
    // The checks are scans of the sheets, which at a million places take minutes: each 50,000 rows
    // scanned, of any sheet, is reported, so that the page does not sit on the last of the loading.
    let scanned = 0;
    const rows = (n) => { if (!known(n)) return []; const m = loaded.get(n); return (function* () {
      for (const cells of store.rows(m.first, m.last)) { if (++scanned % 50000 === 0) progress({ phase: 'checking', rows: scanned }); yield papaRow(m.fields, cells); }
    })(); };
    progress({ phase: 'checking' });
    await validateTables(readableMeta(env.csvMeta, loaded), {
      header: async (n) => (known(n) ? loaded.get(n).fields : null),
      rows,
      keys: { add: async (t, k) => store.keyAdd(t, k), has: async (t, k) => store.keyHas(t, k) },
      issue: (i) => rep.error('table', `${i.table}${i.column ? `, column ${i.column}` : ''}: ${i.message.replace(/'[^']*'/, "'…'")}`, `${i.table}${i.row ? ` row ${i.row + 1}` : ''}${i.column ? ` ${i.column}` : ''}: ${i.message}`),
    });
    // PLATO's own rules for the tables, beyond what CSVW can state (and rdf-tabular checks).
    const where = (i) => `${i.table}${i.row ? ` row ${i.row + 1}` : ''}${i.column ? ` ${i.column}` : ''}: ${i.detail || i.message}`;
    const said = (i) => `${i.table}${i.column ? `, column ${i.column}` : ''}: ${i.message}`;
    const rules = { issue: (i) => rep.error('table', said(i), where(i)), warn: (i) => rep.warning('table', said(i), where(i)) };
    checkTableRules(rows, rules);
    // The about sheet: one row describing the dataset, which becomes the document's gazetteer. The base
    // for the places' and sources' addresses is the one given for this conversion, else its base_uri.
    // Only its first row is read, and how many there are.
    let aboutRows = null;
    if (known('about')) { const it = rows('about'), first = it.next().value; it.return(); aboutRows = new Array(loaded.get('about').count); if (first) aboutRows[0] = first; }
    checkAboutRules(aboutRows, rules, { base: options.base });
    const about = (aboutRows && aboutRows[0]) || {};
    const base = options.base || about.base_uri || DEFAULT_TABLE_BASE;
    yield { type: 'header', value: { profile: 'place-centric', gazetteer: aboutToGazetteer(about, base, options.title || 'Converted from PLATO spreadsheet tables') } };

    progress({ phase: 'indexing' });
    store.index();
    // A source by its source_id, the last row that has it (as a Map of the sheet kept it), with the
    // rows looked up lately kept: the built source is made afresh each time, as it always was.
    const cache = new Map();
    const sourceRow = (id) => {
      if (cache.has(id)) { const r = cache.get(id); cache.delete(id); cache.set(id, r); return r; }
      const cells = known('sources') ? store.lookup(SHEET_NO.sources, id) : null;
      const r = cells ? papaRow(loaded.get('sources').fields, cells) : undefined;
      cache.set(id, r);
      if (cache.size > 4096) cache.delete(cache.keys().next().value);
      return r;
    };
    const ids = tableIds(base, sourceRow);
    // Without sources.csv, each source is cited by its address alone, which the schema rejects in a
    // record: that follows from the sheet, which is reported, and not from the record.
    const sourcesUnread = !!loaded.get('sources')?.unreadable;
    let n = 0;
    // place_id reaches the data as the record's own identifier (plato:entity_identifier), as the
    // table definitions write it, not only as the tail of the minted address.
    const record = (p, atts, idrs) => {
      const rec = { '@id': ids.place(p.place_id), label: p.label, entityIdentifier: p.place_id, attestations: atts };
      if (p.country_codes) rec.ccodes = p.country_codes.split(';');
      for (const r of idrs) {
        (rec.identityRelations ||= []).push(Object.fromEntries(Object.entries({
          subject: rec['@id'], object: r.same_as, identityType: r.match_type || undefined, certainty: r.certainty !== '' ? Number(r.certainty) : undefined,
          basis: r.basis || undefined, source: r.source_id ? ids.source(r.source_id) : undefined }).filter(([, v]) => v !== undefined)));
      }
      return { type: 'record', value: rec, n: ++n, ...(sourcesUnread ? { sourcesUnread } : {}) };
    };
    // Each place, in the order of the places sheet, with the rows of the attestation sheets (in
    // ATTESTATION_SHEETS order, each in its own order) and of identities that give its place_id. A
    // place_id given to two places gives both of them all of its rows.
    if (known('places')) {
      const P = loaded.get('places');
      let cur = null;
      for (const [rowid, pcells, sheet, cells] of store.joined(P.first, P.last, FIRST_JOINED)) {
        if (!cur || cur.rowid !== rowid) {
          if (cur) yield record(cur.p, cur.atts, cur.idrs);
          cur = { rowid, p: papaRow(P.fields, pcells), atts: [], idrs: [] };
        }
        if (sheet === null) continue;
        const name = TABLE_SHEETS[sheet], row = papaRow(loaded.get(name).fields, cells);
        if (name === 'identities') cur.idrs.push(row); else cur.atts.push(rowToAttestation(name, row, ids));
      }
      if (cur) yield record(cur.p, cur.atts, cur.idrs);
    }
    // Without a sheet, the records are knowingly short: the run is incomplete, and writes nothing.
    if ([...loaded.values()].some((m) => m.unreadable)) yield { type: 'short' };
  } finally { store.close(); }
}

// ---- sinks -------------------------------------------------------------------------------------
class TextSink {
  constructor(out) { this.out = out; this.buf = []; this.len = 0; }
  write(s) { this.buf.push(s); this.len += s.length; if (this.len > 1 << 20) this.flush(); }
  flush() { if (this.buf.length) { this.out.write(this.buf.join('')); this.buf = []; this.len = 0; } }
  async close() { this.flush(); return this.out.close(); }
}

// ---- the run -------------------------------------------------------------------------------------
/**
 * Check or convert one input. A file whose content stops the reader part-way (JSON cut short or
 * not well formed, damaged compression, a broken zip) is a problem in the data, so it ends in a
 * report like any other, with what was read before it and no outputs: only a failure of the tools
 * themselves is thrown.
 */
export async function run(job, env) {
  const rep = new Report();
  // Every output the run opens and has not closed. A run that stops part-way closes them, recording
  // none as an output, so that a host can remove them: in the browser an output left open keeps its
  // file's access handle, and the half-written file cannot be removed.
  const open = new Set();
  const output = async (...a) => {
    const o = await env.output(...a), close = o.close;
    open.add(o);
    o.close = async (...b) => { open.delete(o); return close.apply(o, b); };
    return o;
  };
  try { return await runChecked(job, { ...env, output }, rep); }
  catch (e) {
    for (const o of open) { try { await o.close(); } catch { /* closed as far as it can be */ } }
    if (!(e instanceof DataError)) throw e;
    rep.error('unreadable', 'The file could not be read to the end, so only the part before the problem was checked', e.message);
    return { report: rep.toJSON(), outputs: [], incomplete: true };
  }
}
async function runChecked({ input, action, target, options = {} }, env, rep) {
  // options.augment(record) -> record: a caller's change to each place-centric record on its way to
  // the writer or sink (another tool appending its attestations to the places they are about), after
  // the record has been checked and counted as read. Its additions are the caller's to check.
  const augmented = (ev) => (options.augment && ev.type === 'record' ? { ...ev, value: options.augment(ev.value) } : ev);
  const res = env.resources;
  const progress = env.progress || (() => {});
  const t0 = Date.now();
  let lastBeat = 0;
  const beat = (phase, extra = {}) => { const now = Date.now(); if (now - lastBeat > 250 || extra.force) { lastBeat = now; progress({ phase, ...rep.counts, elapsedMs: now - t0, ...extra }); } };

  const source = input.format === 'plato-jsonl' ? platoJsonl(input.files[0], rep)
    : input.format === 'plato-json' ? platoJson(input.files[0])
    : input.format === 'lpf' || input.format === 'lpf-seq' ? lpfSource(input.files[0], input.format === 'lpf-seq', rep)
    : input.format === 'tables' ? tablesSource(input, env, rep, options, action)
    : input.format === 'w3c-annotations' ? annotationSource(input, rep)
    : input.format === 'tei' ? teiSource(input, rep, options)
    : input.format === 'csv' || input.format === 'geojson' ? genericSource(input, rep, options, DEFAULT_TABLE_BASE)
    : ['ntriples', 'nquads', 'turtle'].includes(input.format) ? rdfSource(input.files[0], input.format, rep) : null;
  if (!source) throw new Error(`Unsupported input: ${input.format}`);
  if ((input.format === 'lpf' || input.format === 'lpf-seq') && input.lpfVersion === 2) {
    rep.error('lpf-v2', 'Linked Places Format v2 is not yet specified, so it cannot be read. It will be supported once the specification is published.');
    return { report: rep.toJSON(), outputs: [] };
  }
  const isRdf = ['ntriples', 'nquads', 'turtle'].includes(input.format);
  // Annotations and TEI become attestation-centric attestations, which are gathered by place like
  // any others. A CSV or GeoJSON is either, by its column matching: the file is read (and kept) first.
  const generic = input.format === 'csv' || input.format === 'geojson' ? await genericProfile(input, options) : null;
  const needsStore = isRdf || input.profile === 'attestation-centric' || input.format === 'w3c-annotations' || input.format === 'tei' || generic === 'attestation-centric';
  const typing = options.typing ? { types: res.types, typedBounds: true, wktPoints: true } : {};
  const profileName = input.profile || generic || (input.format === 'w3c-annotations' || input.format === 'tei' ? 'attestation-centric' : 'place-centric');
  const V = res.validators[profileName] || res.validators['place-centric'];

  // Where the records go: a writer for the target, or nothing when checking.
  const outputs = [];
  let writer = null;
  const idrsBySubject = new Map();
  const lpfTarget = target === 'lpf' || target === 'lpf-seq';
  // LPF and the tables have no meta-attestations, so they show the current state (see
  // src/formats/shared.js): what the document retracts or supersedes is left out, and reported.
  const currentOnly = action === 'convert' && (lpfTarget || target === 'tables');
  let withdrawn = null;
  // A candidate set (PLATO 53c5a40) is read and written apart from a dataset (runCandidateSet, below).
  const candidateSet = input.profile === 'candidate-set';
  if (currentOnly && !needsStore && !candidateSet && input.format.startsWith('plato')) {
    // One pass first, because a retraction can come anywhere in the file, even after what it
    // withdraws, and under another place. DEEP-style files also list identity relations after
    // every place, and LPF needs them on the feature.
    withdrawn = new Map();
    const again = input.format === 'plato-jsonl' ? platoJsonl(input.files[0], new Report()) : platoJson(input.files[0]);
    for await (const ev of again) {
      if (ev.type === 'idr') { if (lpfTarget) (idrsBySubject.get(ev.value.subject) || idrsBySubject.set(ev.value.subject, []).get(ev.value.subject)).push(ev.value); }
      else if (ev.type === 'record') collectWithdrawn(ev.value?.attestations, withdrawn);
      else if (ev.type === 'attestation') collectWithdrawn([ev.value], withdrawn);
    }
    withdrawn = resolved(withdrawn, rep);
  }
  if (action === 'convert' && options.cube && target !== 'ntriples') rep.warning('cube-not-ntriples', 'The Data Cube export applies to N-Triples output only, so it is not made here.');
  // RDF may hold a dataset or a candidate set, which are written by different writers: its writer is
  // made once the graph has been read and it is known which.
  const writerFor = () => makeWriter(target, env, rep, { ...options, idrsBySubject, withdrawn }, typing, outputs, input);
  if (action === 'convert' && !isRdf && !candidateSet) writer = await writerFor();
  // The version check (src/engine/compare.js) reads the records itself, as a writer is given them:
  // every input then reaches it as place-centric records, whatever format it came in.
  else if (options.sink) writer = options.sink;

  // Checking (and writing) records as they stream past.
  // Memberships of routes, itineraries and networks, to find one that contains itself (PLATO 0.6.0).
  const membership = new Map();
  const checkRecord = (ev) => {
    if (ev.type === 'record' && ev.value) collectMembership(ev.value.attestations, ev.value['@id'], membership);
    else if (ev.type === 'attestation' && ev.value) collectMembership([ev.value], null, membership);
    const f = ev.newEntity ? V.newEntity : ev.type === 'record' ? V.entity : ev.type === 'attestation' ? V.attestation : V.identity;
    if (f && !f(ev.value)) {
      // A source cited by its address alone because sources.csv could not be read (tablesSource) is
      // not the record's fault: the errors at its sources are left out, and the record's own reported.
      const errs = ev.sourcesUnread ? f.errors.filter((e) => !SOURCE_AT.test(e.instancePath || '')) : f.errors;
      if (errs.length) rep.error('schema', explainSchema(errs, input.format === 'tables'), `${ev.value?.['@id'] || ev.value?.subject || `item ${ev.n}`}: ${ajvMessage(errs)}`);
    }
    // A nested identity relation may leave out its subject, which is then its place; if it gives
    // one, it must be that place, or in RDF it has two subjects. A schema cannot say this.
    if (ev.type === 'record' && ev.value && Array.isArray(ev.value.identityRelations)) {
      for (const ir of ev.value.identityRelations) {
        if (ir && ir.subject !== undefined && ev.value['@id'] !== undefined && ir.subject !== ev.value['@id'])
          rep.error('identity-subject-mismatch', 'An identity relation nested under a place names a different place as its subject; leave the subject out, or move the relation to the place it is about', `${ev.value['@id']}: ${ir.subject}`);
      }
    }
  };
  // What the JSON-to-RDF converter could not use, in words. Every kind it can raise is named here.
  const rdfBound = action === 'convert' && (target === 'ntriples' || needsStore);
  const jsonIssue = (i) => {
    if (i.kind === 'record-failed') return rep.error('record-failed', 'A record could not be converted to RDF and is left out; the rest of the file was still checked', `${i.value}: ${i.error}`);
    if (i.kind === 'null-value') return rep.warning('null-value', `An empty value (null) is left out of RDF (${i.where})`, i.where);
    if (i.kind === 'unconvertible') return rep.warning('unconvertible', `A value of the wrong kind cannot be turned into RDF and is left out (${i.where})`, i.value);
    // A value the context reads as an address that is not one (a contributor given by name, which the
    // schema allows) is lost wherever the output is RDF or is made through it: a loss, not a warning.
    if (i.kind === 'relative-iri') return (rdfBound ? rep.loss : rep.warning).call(rep, i.kind, `A value that must be a full web address in RDF is not one, so it is dropped in RDF (${i.where}): PLATO's context reads it as an address. Give a web address, not a name.`, i.value);
    if (i.kind === 'not-in-rdf') return rep.warning(i.kind, `${LOSS_TEXT['not-in-rdf']} (${i.key})`, i.key);
    return rep.warning(i.kind, `A key PLATO does not define is dropped: ${i.value}`, i.value);
  };
  const dry = new Json2Rdf(res.context, () => {}, { onIssue: jsonIssue });
  const notAList = (ev) => rep.error('not-a-list', notAListText(ev.key, ev.shape), ev.key);
  if (candidateSet) {
    const refused = refuseCandidateSet({ action, target, options }, rep);
    if (refused) return refused;
    const w = action === 'convert' ? await candidateSetWriter(target, env, rep, typing, outputs, input, options) : null;
    await runCandidateSet(candidateSetSource(input, rep), { V, rep, writer: w, dry, notAList });
    return { report: rep.toJSON(), outputs };
  }
  const lateHeader = (ev) => rep.error('late-header', `The document's ${ev.key} come after its records. These tools read a document's header before its records, so ${ev.key} must come before spatialEntities or attestations; as the file is, they are not read at all.`, ev.key);

  // A reader that read on past part of its input it could not read (a sheet of the tables) says so.
  let short = false;
  if (!needsStore) {
    let header = null;
    for await (const ev of source) {
      if (ev.type === 'late-header') { lateHeader(ev); continue; }
      if (ev.type === 'not-a-list') { notAList(ev); continue; }
      if (ev.type === 'short') { short = true; continue; }
      if (ev.type === 'header') {
        header = ev.value;
        if (input.format.startsWith('plato') && !V.header(header)) rep.error('schema', `The document header does not match the PLATO JSON Schema: ${ajvMessage(V.header.errors)}`);
        dry.header(header);
        writer && writer.header(header);
        continue;
      }
      if (input.format.startsWith('plato') || input.format === 'lpf' || input.format === 'lpf-seq' || input.format === 'tables' || generic) checkRecord(ev);
      if (ev.type === 'record') { rep.count('places'); rep.count('attestations', list(ev.value?.attestations).length); dry.record(ev.newEntity ? 'newSpatialEntities' : 'spatialEntities', ev.value); }
      // Only attestation-centric input is read through the store and regrouped by place; here the
      // header said place-centric, which has no attestation on its own, and no schema to check one by.
      else if (ev.type === 'attestation') { rep.count('attestations'); rep.error('schema', 'An attestation is given on its own (it says what it is about), but the document is place-centric, where every attestation goes under its place. Put it under its place, or give the document the attestation-centric profile.', `${input.format === 'plato-jsonl' ? 'line' : 'attestation'} ${ev.n}${ev.value?.['@id'] ? `: ${ev.value['@id']}` : ''}`); }
      else if (ev.type === 'idr') { rep.count('identity relations'); dry.record('identityRelations', ev.value); }
      if (writer) {
        try { await writer.event(augmented(ev)); }
        catch (e) { rep.error('record-failed', 'A record could not be written and is left out of the output; the rest of the file was still converted', `${ev.value?.['@id'] || `item ${ev.n}`}: ${e && e.message || e}`); }
      }
      beat('reading');
    }
  } else {
    // Gather everything in the on-disk store first, then read it back one place at a time.
    const store = new TripleStore(await env.openDb({ store: true }));
    // Here the store's converter is the only one that sees the records, so it reports.
    const w = new Json2Rdf(res.context, (s, p, o) => store.add(s, p, o), { onIssue: jsonIssue });
    let header = null, batch = 0;
    store.beginBatch();
    for await (const ev of source) {
      if (ev.type === 'triple') { store.add(ev.s, ev.p, ev.o); if (++batch % 50000 === 0) { store.endBatch(); store.beginBatch(); beat('loading', { triples: store.count }); } continue; }
      if (ev.type === 'late-header') { lateHeader(ev); continue; }
      if (ev.type === 'not-a-list') { notAList(ev); continue; }
      if (ev.type === 'header') { header = ev.value; w.header(header); dry.header(header); if (!V.header(header)) rep.error('schema', `The document header does not match the PLATO JSON Schema: ${ajvMessage(V.header.errors)}`); continue; }
      checkRecord(ev);
      w.record(ev.type === 'idr' ? 'identityRelations' : ev.type === 'attestation' ? 'attestations' : ev.newEntity ? 'newSpatialEntities' : 'spatialEntities', ev.value);
      if (++batch % 5000 === 0) { store.endBatch(); store.beginBatch(); beat('loading', { triples: store.count }); }
    }
    store.endBatch();
    rep.count('triples', store.count);
    beat('indexing', { triples: store.count, force: true });
    store.index();
    if (isRdf) checkGraph(store, res, rep);
    // A node with several different values where PLATO JSON holds one: the others are not carried
    // over, so it is a loss, counted once per distinct value dropped. The same node is met again
    // wherever it is cited (a source in thousands of records), and counting each meeting made
    // Pleiades' 35,294 dropped values read as 265 million. Each node and key is shown once.
    const seenValue = new Set(), seenNode = new Set(), CAP = 2_000_000;
    const multipleValues = (i) => {
      const nk = i.node + '\u0001' + i.key, vk = nk + '\u0001' + (i.value ?? '');
      if (seenValue.has(vk)) return;
      if (seenValue.size < CAP) seenValue.add(vk);
      const first = !seenNode.has(nk);
      if (first && seenNode.size < CAP) seenNode.add(nk);
      rep.loss('multiple-values', `A value that PLATO JSON holds once has several different values here; the first is kept and the others are left out (${i.key})`, first ? i.node : undefined);
    };
    const r2j = new Rdf2Json({ context: res.context, core: res.core, profile: res.profiles['place-centric'], candidateProfile: res.profiles['candidate-set'], types: res.types }, store, {
      withdrawn: currentOnly ? withdrawnInStore(store, rep) : null,
      onLoss: (l) => rep.loss(l.kind, `${LOSS_TEXT[l.kind] || l.kind}`, l.predicate || l.value),
      onIssue: (i) => (i.kind === 'multiple-values' ? multipleValues(i) : rep.warning(i.kind, ISSUE_TEXT[i.kind] || i.kind, i.kind === 'figure-undeclared' ? i.key : i.node)),
    });
    const docs = [...store.subjects(TYPE, PLATO + 'Gazetteer')];
    const docId = docs[0] || firstSubjectWith(store, PLATO + 'contains_entity') || firstSubjectWith(store, PLATO + 'contains_attestation');
    // Candidate sets (PLATO 53c5a40), and candidates in none. A graph with no dataset in it (no
    // gazetteer, place, attestation or identity relation) and a candidate set is written as that
    // candidate set; otherwise the dataset is written, and the candidates are reported as not written,
    // never merged into it.
    const sets = [...new Set([...store.subjects(TYPE, PLATO + 'CandidateSet'), ...distinctSubjectsWith(store, PLATO + 'contains_candidate')])];
    // What makes a dataset is a gazetteer with something said of it beyond its type, an attestation or an
    // identity relation. Typed N-Triples type the dataset a candidate set is for as plato:Gazetteer (the
    // range of candidates_for), and a candidate's two places as plato:SpatialEntity (the range of
    // candidate_source and candidate_candidate); a place described a little more (a label added to a
    // candidate set's graph) is still a place the candidates name, not a dataset of empty places.
    const described = (id) => store.out(id).some((t) => t.p !== TYPE);
    const isDataset = !!(docs.some(described) || firstSubjectWith(store, PLATO + 'contains_entity') || firstSubjectWith(store, PLATO + 'contains_attestation')
      || firstSubjectWith(store, PLATO + 'attests_about') || store.subjects(TYPE, PLATO + 'Attestation').next().value
      || store.subjects(TYPE, PLATO + 'IdentityRelation').next().value || firstSubjectWith(store, PLATO + 'identity_subject'));
    const looseCandidates = (keep) => [...new Set([...store.subjects(TYPE, PLATO + 'Candidate'), ...distinctSubjectsWith(store, PLATO + 'candidate_source')])].filter((c) => !keep.has(c));
    const notWritten = (v) => rep.loss('candidate-set-not-written', LOSS_TEXT['candidate-set-not-written'], v);
    if (!isDataset && (sets.length || looseCandidates(new Set()).length)) {
      const refused = refuseCandidateSet({ action, target, options }, rep);
      if (refused) { store.close(); return refused; }
      const setId = sets[0];
      const ids = setId ? [...objectsOf(store, setId, PLATO + 'contains_candidate')] : looseCandidates(new Set());
      for (const other of sets.slice(1)) notWritten(other);
      if (setId) for (const c of looseCandidates(new Set(ids))) notWritten(c);
      const w = action === 'convert' ? await candidateSetWriter(target, env, rep, typing, outputs, input, options) : null;
      const events = (function* () {
        yield { type: 'header', value: setId ? { $schema: CANDIDATE_SET_SCHEMA, ...r2j.candidateSetHeader(setId) } : { $schema: CANDIDATE_SET_SCHEMA, profile: 'candidate-set', candidateSet: {} } };
        let n = 0;
        for (const c of ids) yield { type: 'candidate', value: r2j.candidate(c), n: ++n };
      })();
      await runCandidateSet(events, { V: res.validators['candidate-set'], rep, writer: w, dry: null, notAList });
      store.close();
      return { report: rep.toJSON(), outputs };
    }
    for (const set of sets) notWritten(set);
    for (const c of looseCandidates(new Set(sets.flatMap((x) => [...objectsOf(store, x, PLATO + 'contains_candidate')])))) notWritten(c);
    if (action === 'convert' && isRdf) writer = await writerFor();
    const head = docId ? { $schema: 'https://w3id.org/plato/schemas/place-centric.schema.json', ...r2j.header(docId) } : { profile: 'place-centric', gazetteer: { title: input.files[0].name } };
    head.profile = 'place-centric';
    writer && writer.header(head);
    // Without a document node, every identity relation is one of the document's own, except those an
    // attestation bundles (plato:attests_identity), which are read under their attestation.
    const idrIds = docId ? [...objectsOf(store, docId, PLATO + 'contains_identity_relation')]
      : [...store.subjects(TYPE, PLATO + 'IdentityRelation')].filter((i) => !store.in(PLATO + 'attests_identity', i).length);
    if (target === 'lpf' || target === 'lpf-seq') for (const i of idrIds) { const v = r2j.identityRelation(i); (idrsBySubject.get(v.subject) || idrsBySubject.set(v.subject, []).get(v.subject)).push(v); }
    // The places the document lists, then any other place its attestations are about: an
    // attestation-centric document's attestations are about existing places, which it need not list
    // (only its newSpatialEntities are), and they were once left out whenever it listed any.
    const entities = docId && firstSubjectWith(store, PLATO + 'contains_entity') ? listedThenOthers(store, docId) : distinctEntities(store);
    let n = 0;
    for (const e of entities) {
      const rec = r2j.entity(e);
      if (!rec.label) { rec.label = e; rep.warning('no-label', 'A place has no label; its identifier is used as its label', e); }
      n++; rep.count('places'); rep.count('attestations', rec.attestations?.length || 0);
      if (isRdf && !V.entity(rec)) rep.error('schema', explainSchema(V.entity.errors, false), `${e}: ${ajvMessage(V.entity.errors)}`);
      collectMembership(rec.attestations, rec['@id'], membership);
      if (writer) await writer.event(augmented({ type: 'record', value: rec, n }));
      beat('writing', { places: n });
    }
    for (const i of idrIds) { rep.count('identity relations'); if (writer) await writer.event({ type: 'idr', value: r2j.identityRelation(i) }); }
    store.close();
  }
  for (const c of membershipCycles(membership)) rep.error('membership-cycle', 'A route, itinerary or network is, through its members, a member of itself (MemberOf, followed round, comes back to where it started)', c);
  if (writer) await writer.close();
  progress({ phase: 'done', ...rep.counts, elapsedMs: Date.now() - t0 });
  // A writer whose output is knowingly short (identity relations it held back and lost), or a reader
  // that could not read part of its input (a sheet of the tables), ends the run incomplete, as a file
  // cut short does: no outputs, and a host removes what was written.
  if (writer?.incomplete || short) return { report: rep.toJSON(), outputs: [], incomplete: true };
  return { report: rep.toJSON(), outputs };
}
/** Resolve a document's withdrawals, reporting any loop of them as an error in the data. */
function resolved(edges, rep) {
  const { status, cycles } = resolveWithdrawn(edges);
  for (const c of cycles) rep.error('withdrawal-cycle', 'Attestations withdraw one another in a loop (a retraction or supersession that, followed round, withdraws itself), so none of them is shown as current', c);
  return status;
}
/** What the graph retracts or supersedes, resolved: node key -> 'retracted' | 'superseded'. */
function withdrawnInStore(store, rep) {
  const edges = new Map();
  for (const [type, kind] of [[PLATO + 'Supersedes', 'superseded'], [PLATO + 'Retracts', 'retracted']]) {
    for (const s of store.subjects(PLATO + 'has_meta_type', type)) {
      for (const o of store.objects(s, PLATO + 'meta_attestation_about')) if (o.termType !== 'Literal') addWithdrawal(edges, o.termType === 'BlankNode' ? '_:' + o.value : o.value, s, kind);
    }
  }
  return resolved(edges, rep);
}
// What RDF -> JSON says about statistical figures and tables (PLATO issue #14).
const ISSUE_TEXT = {
  'figure-undeclared': "A statement on a statistical figure that its table's structure does not declare, and that is not typed or named as an attribute, is read as one of the figure's coordinates (dimensions). The graph is the same either way.",
  'table-without-address': 'A statistical table has no web address; PLATO JSON requires one for each table in dataSets.',
  'structure-without-address': "A table's structure has no web address; PLATO JSON requires one for a structure whose components are listed.",
  'component-several': "A component of a table's structure names more than one dimension, measure or attribute; PLATO JSON gives each its own component.",
};
function* distinctSubjectsWith(store, p) {
  const i = store.pid.get(p); if (i === undefined) return;
  const q = store.db.prepare('SELECT DISTINCT s FROM t WHERE p=?');
  try { q.bind([i]); while (q.step()) yield q.get(0); } finally { q.finalize(); }
}
function firstSubjectWith(store, p) {
  const q = store.db.prepare('SELECT s FROM t WHERE p=? LIMIT 1');
  try { const i = store.pid.get(p); if (i === undefined) return null; q.bind([i]); return q.step() ? q.get(0) : null; } finally { q.finalize(); }
}
function* objectsOf(store, s, p) {
  const i = store.pid.get(p); if (i === undefined) return;
  const q = store.db.prepare('SELECT o FROM t WHERE s=? AND p=?');
  try { q.bind([s, i]); while (q.step()) yield q.get(0); } finally { q.finalize(); }
}
function* listedThenOthers(store, docId) {
  yield* objectsOf(store, docId, PLATO + 'contains_entity');
  const ce = store.pid.get(PLATO + 'contains_entity'), ab = store.pid.get(PLATO + 'attests_about');
  if (ab === undefined) return;
  const q = store.db.prepare('SELECT DISTINCT o FROM t WHERE p=? AND k<2 AND o NOT IN (SELECT o FROM t WHERE s=? AND p=?)');
  try { q.bind([ab, docId, ce]); while (q.step()) yield q.get(0); } finally { q.finalize(); }
}
function* distinctEntities(store) {
  const tp = store.pid.get(TYPE), ab = store.pid.get(PLATO + 'attests_about');
  const q = store.db.prepare(`SELECT DISTINCT e FROM (SELECT s AS e FROM t WHERE p=? AND o=? UNION SELECT o AS e FROM t WHERE p=? AND k<2)`);
  try { q.bind([tp ?? -1, PLATO + 'SpatialEntity', ab ?? -1]); while (q.step()) yield q.get(0); } finally { q.finalize(); }
}
/** Graph-level checks an RDF input gets: every PLATO term it uses is declared, and every attestation says what it is about. */
function checkGraph(store, res, rep) {
  for (const p of store.pname) if (p.startsWith(PLATO) && !res.terms.has(p)) rep.error('undeclared-term', 'A predicate in the PLATO namespace is not declared in the ontology', p);
  const q = store.db.prepare('SELECT DISTINCT o FROM t WHERE k=0 AND o LIKE ?');
  try { q.bind([PLATO + '%']); while (q.step()) { const o = q.get(0); if (!res.terms.has(o)) rep.error('undeclared-term', 'A class or concept in the PLATO namespace is not declared in the ontology', o); } } finally { q.finalize(); }
  // A meta-attestation (plato:meta_attestation_about) need not say what it is about: the attestation
  // it comments on does (PLATO 238d15f; examples/relation.ttl's karakorum-dispute).
  const tp = store.pid.get(TYPE), ab = store.pid.get(PLATO + 'attests_about'), mab = store.pid.get(PLATO + 'meta_attestation_about');
  if (tp !== undefined) {
    const c = store.db.prepare('SELECT s FROM t WHERE p=? AND o=? AND s NOT IN (SELECT s FROM t WHERE p=?) AND s NOT IN (SELECT s FROM t WHERE p=?) LIMIT 5');
    try { c.bind([tp, PLATO + 'Attestation', ab ?? -1, mab ?? -1]); while (c.step()) rep.error('attestation-without-subject', 'An attestation does not say what it is about (plato:attests_about)', c.get(0)); } finally { c.finalize(); }
  }
}

// ---- candidate sets (PLATO 53c5a40) -------------------------------------------------------------------
// The matches one run of matching software suggested for a dataset's places, published apart from the
// dataset: a header (profile, candidateSet) and its candidates. Read from PLATO JSON or JSON Lines (one
// candidate a line, after the header) or from RDF; checked against the candidate set's profile; written
// as PLATO JSON, JSON Lines or N-Triples. The tables and Linked Places Format have no place for it.
const CANDIDATE_SET_SCHEMA = 'https://w3id.org/plato/schemas/candidate-set.schema.json';
export const CANDIDATE_SET_TEXT = {
  'candidate-set-target': 'A candidate set cannot be written as spreadsheet tables or Linked Places Format: neither has a place for suggestions made by software, which are claims by no one. Keep it as PLATO JSON or RDF.',
  'candidate-set-not-a-dataset': 'This is a candidate set, not a dataset: it holds matches suggested by software, and no places, attestations or identity relations, which are what this tool reads. A candidate set can be checked, and converted to PLATO JSON or RDF, on its own.',
};
/**
 * A run on a candidate set that cannot go ahead, else null: a target that cannot hold one, or a tool
 * that reads a dataset's records through options.sink (the version check, match review, Chora).
 */
function refuseCandidateSet({ action, target, options }, rep) {
  const kind = options.sink ? 'candidate-set-not-a-dataset' : action === 'convert' && (target === 'tables' || target === 'lpf' || target === 'lpf-seq') ? 'candidate-set-target' : null;
  if (!kind) return null;
  rep.error(kind, CANDIDATE_SET_TEXT[kind]);
  return { report: rep.toJSON(), outputs: [], incomplete: true };
}
async function* candidateSetSource(input, rep) {
  const file = input.files[0];
  if (input.format === 'plato-jsonl') {
    let first = true, n = 0;
    for await (const { line, n: at } of lines(file)) {
      let v;
      try { v = JSON.parse(line); } catch (e) { rep.error('json-syntax', 'A line is not valid JSON', `line ${at}: ${e.message}`); continue; }
      if (!v || typeof v !== 'object' || Array.isArray(v)) { rep.error('jsonl-not-an-object', 'A line is not a JSON object, so it is neither the header nor a candidate, and is not read', `line ${at}: ${line.slice(0, 80)}`); continue; }
      if (first) { first = false; yield { type: 'header', value: v }; continue; }
      yield { type: 'candidate', value: v, n: ++n };
    }
    return;
  }
  const keys = ['$schema', '@context', 'profile', 'candidateSet'];
  const head = {};
  for await (const { path, value } of jsonDocument(file, { arrays: ['candidates'], keys, onlyKeys: true })) head[path] = value;
  if (!('candidateSet' in head)) for await (const { path, value } of jsonDocument(file, { keys })) head[path] = value;   // after the candidates: rare
  yield { type: 'header', value: head };
  let n = 0;
  for await (const { path, value, notAList } of jsonDocument(file, { arrays: ['candidates'] })) {
    if (notAList) { yield { type: 'not-a-list', key: path, shape: notAList }; continue; }
    yield { type: 'candidate', value, n: ++n };
  }
}
/** Check each event of a candidate set against its profile, and write it if there is a writer. */
async function runCandidateSet(events, { V, rep, writer, dry, notAList }) {
  for await (const ev of events) {
    if (ev.type === 'not-a-list') { notAList(ev); continue; }
    if (ev.type === 'header') {
      if (!V.header(ev.value)) rep.error('schema', `The document header does not match the PLATO JSON Schema: ${ajvMessage(V.header.errors)}`);
      if (dry) dry.header(ev.value);
      if (writer) writer.header(ev.value);
      continue;
    }
    rep.count('candidates');
    if (!V.candidate(ev.value)) rep.error('schema', explainSchema(V.candidate.errors, false), `${ev.value?.['@id'] || `candidate ${ev.n}`}: ${ajvMessage(V.candidate.errors)}`);
    if (dry) dry.record('candidates', ev.value);
    if (writer) {
      try { writer.candidate(ev.value); }
      catch (e) { rep.error('record-failed', 'A record could not be written and is left out of the output; the rest of the file was still converted', `${ev.value?.['@id'] || `candidate ${ev.n}`}: ${e && e.message || e}`); }
    }
  }
  if (writer) await writer.close();
}
async function candidateSetWriter(target, env, rep, typing, outputs, input, options) {
  const stem = (options.name || input.files[0].name).replace(/\.(gz)$/i, '').replace(/\.[^.]+$/, '');
  const sink = new TextSink(await env.output(stem + TARGETS[target].ext));
  if (target === 'ntriples') {
    let triples = 0;
    const w = new Json2Rdf(env.resources.context, (s, p, o) => { triples++; sink.write(tripleNT(s, p, o)); }, { ...typing, onIssue: () => {} });
    return {
      header(h) { w.header(h); },
      candidate(c) { w.record('candidates', c); },
      async close() { rep.count('triples written', triples); outputs.push(await sink.close()); },
    };
  }
  const lines = target === 'plato-jsonl';
  let first = true;
  return {
    header(h) {
      const head = { $schema: CANDIDATE_SET_SCHEMA, ...h, profile: 'candidate-set' };
      const s = JSON.stringify(head);
      sink.write(lines ? s + '\n' : s.slice(0, -1) + (s.length > 2 ? ',' : '') + '"candidates":[');
    },
    candidate(c) { sink.write(lines ? JSON.stringify(c) + '\n' : (first ? '' : ',') + JSON.stringify(c)); first = false; },
    async close() { if (!lines) sink.write(']}'); outputs.push(await sink.close()); },
  };
}

// ---- writers ---------------------------------------------------------------------------------
async function makeWriter(target, env, rep, options, typing, outputs, input) {
  const stem = (options.name || input.files[0].name).replace(/\.(gz)$/i, '').replace(/\.[^.]+$/, '');
  const open = async (ext) => { const o = await env.output(stem + ext); return new TextSink(o); };
  // A key the target has no place for is reported by its own name, one line per key (report.js).
  const loss = (l) => (l.kind === 'dropped' ? rep.loss(`dropped:${l.key}`, droppedText(l.key, FORMAT_WORDS[target]), l.value) : rep.loss(l.kind, LOSS_TEXT[l.kind] || l.kind, l.value));
  if (target === 'plato-jsonl' || target === 'plato-json') {
    const sink = await open(TARGETS[target].ext);
    let started = false;
    // A document holds its places, then its identity relations; a JSON Lines file may mix them (DEEP
    // does). Identity relations are held back and written after the last place, never with places
    // inside them: in memory up to a limit, then in a working database, so that any number can wait.
    const HELD = options.heldIdentities || 10000;   // the tests set it low, to reach the database
    let held = [], heldDb = null, heldIns = null, heldCount = 0, heldFailed = null, incomplete = false;
    // Where the working database cannot be had (opened, given its table, or written to), those still
    // held in memory are written and every other is lost, including any already moved into the database
    // before a write to it failed: reported once, with a count at close(), never a TypeError and never
    // silently. The output is then knowingly short, so the run is incomplete and a host removes it.
    const holdingFailed = (e) => {
      heldFailed = e && e.message || String(e);
      if (heldDb) { try { heldDb.close(); } catch { /* closed already */ } }
      heldDb = null; heldIns = null;
    };
    const hold = async (line) => {
      heldCount++;
      if (heldFailed) return;
      if (!heldDb && held.length < HELD) { held.push(line); return; }
      try {
        if (!heldDb) {
          heldDb = await env.openDb();
          heldDb.exec('CREATE TABLE held(n INTEGER PRIMARY KEY, line TEXT NOT NULL)');
          heldIns = heldDb.prepare('INSERT INTO held(line) VALUES (?)');
          heldDb.exec('BEGIN');
          for (const l of held) heldIns.bind([l]).stepReset();
          held = [];
        }
        heldIns.bind([line]).stepReset();
      } catch (e) { holdingFailed(e); }
    };
    return {
      get incomplete() { return incomplete; },
      header(h) {
        const head = { $schema: 'https://w3id.org/plato/schemas/place-centric.schema.json', ...h, profile: 'place-centric' };
        if (target === 'plato-jsonl') sink.write(JSON.stringify(head) + '\n');
        else { const s = JSON.stringify(head); sink.write(s.slice(0, -1) + (s.length > 2 ? ',' : '') + '"spatialEntities":['); }
      },
      event(ev) {
        // Attestation-centric input reaches here regrouped by place, through the store; one on its own
        // is in input that said it was place-centric, and has no place to go.
        if (ev.type === 'attestation') { loss({ kind: 'attestation-centric', value: ev.value?.['@id'] || `item ${ev.n}` }); return; }
        const line = JSON.stringify(ev.value);
        if (target === 'plato-jsonl') { sink.write(line + '\n'); return; }
        if (ev.type === 'idr') return hold(line);
        sink.write((started ? ',' : '') + line); started = true;
      },
      async close() {
        if (target === 'plato-json') {
          sink.write(']');
          if (heldCount) {
            sink.write(',"identityRelations":[');
            let first = true;
            const put = (l) => { sink.write((first ? '' : ',') + l); first = false; };
            let written = 0;
            if (heldDb && heldIns) {
              try {
                heldIns.finalize(); heldDb.exec('COMMIT');
                const q = heldDb.prepare('SELECT line FROM held ORDER BY n');
                try { while (q.step()) { put(q.get(0)); written++; } } finally { q.finalize(); }
              } catch (e) { heldFailed = heldFailed || (e && e.message || String(e)); }
              try { heldDb.close(); } catch { /* closed already */ }
            } else for (const l of held) { put(l); written++; }
            sink.write(']');
            const lost = heldCount - written;
            if (lost) { incomplete = true; rep.error('identity-relations-lost', `Identity relations are held back to be written after the last place, in a working database once there are many; it could not be used, so ${lost} of the ${heldCount} identity relations are not in the output`, heldFailed); }
          }
          sink.write('}');
        }
        outputs.push(await sink.close());
      },
    };
  }
  if (target === 'ntriples') {
    const sink = await open('.nt');
    let triples = 0, buf = null;
    const write = (s, p, o) => { triples++; sink.write(tripleNT(s, p, o)); };
    const wrapped = new Json2Rdf(env.resources.context, (s, p, o) => { write(s, p, o); if (buf) buf.push([s, p, o]); }, { ...typing, onIssue: () => {} });
    // The Data Cube export (PLATO issue #14): the plain graph, and after each header and
    // record the statements Data Cube expects that PLATO does not write (src/formats/cube.js).
    const cube = options.cube ? new CubeExport(write, (kind, example) => rep.warning(kind, CUBE_TEXT[kind] || kind, example)) : null;
    return {
      header(h) { buf = cube && []; const doc = wrapped.header(h); if (cube) cube.header(buf, doc); buf = null; },
      event(ev) {
        buf = cube && [];
        wrapped.record(ev.type === 'idr' ? 'identityRelations' : ev.type === 'attestation' ? 'attestations' : ev.newEntity ? 'newSpatialEntities' : 'spatialEntities', ev.value);
        if (cube) cube.record(buf);
        buf = null;
      },
      async close() { if (cube) { cube.finish(); rep.count('observations', cube.observations); } rep.count('triples written', triples); outputs.push(await sink.close()); },
    };
  }
  if (target === 'lpf' || target === 'lpf-seq') {
    const sink = await open(TARGETS[target].ext);
    let first = true;
    const placed = new Set();   // the places written, so that an identity match with none is reported
    return {
      header(h) {
        versionLosses(h.gazetteer, loss); tableLosses(h, loss); relationTypeLosses(h, loss);
        const { '@id': id, ...own } = collectionHead(h.gazetteer, loss);
        const head = { type: 'FeatureCollection', '@context': 'https://raw.githubusercontent.com/LinkedPasts/linked-places-format/main/linkedplaces-context-v1.1.jsonld', ...(id ? { '@id': id } : {}), ...own };
        if (target === 'lpf-seq') sink.write(JSON.stringify(head) + '\n'); else { const s = JSON.stringify(head); sink.write(s.slice(0, -1) + ',"features":['); }
      },
      event(ev) {
        if (ev.type === 'attestation') loss({ kind: 'attestation-centric', value: ev.value?.['@id'] || `item ${ev.n}` });
        if (ev.type !== 'record') return;
        placed.add(ev.value['@id']);
        const f = recordToFeature(ev.value, options.idrsBySubject.get(ev.value['@id']) || [], loss, options.withdrawn);
        sink.write(target === 'lpf-seq' ? JSON.stringify(f) + '\n' : (first ? '' : ',') + JSON.stringify(f)); first = false;
      },
      async close() {
        // An identity match goes on its place's feature; one whose place is not in the file has none.
        for (const [subject, list] of options.idrsBySubject) if (!placed.has(subject)) for (const ir of list) loss({ kind: 'identity-without-place', value: `${subject} ${ir.object}` });
        if (target === 'lpf') sink.write(']}'); outputs.push(await sink.close());
      },
    };
  }
  if (target === 'tables') return tablesWriter(env, rep, options, outputs, stem, loss);
  throw new Error(`Unknown target: ${target}`);
}

function tablesWriter(env, rep, options, outputs, stem, loss) {
  const schemas = tableSchemas(env.csvMeta);
  const header = Object.fromEntries(schemas.map((t) => [t.name, t.columns.map((c) => c.titles)]));
  const buffers = Object.fromEntries(schemas.map((t) => [t.name, []]));
  const places = new Map(), sources = new Map(), usedIds = new Set();
  const accepts = cellChecker(env.csvMeta);
  // Reading the tables back mints each place's and source's address from a base address and its id:
  // an address that is not the one it would mint is lost. The base is the one the reader will use: the
  // one given for this conversion, else the gazetteer's uriSpace (the about sheet's base_uri, set in
  // header(), which comes before any record), else the reader's default.
  let minted = tableIds(options.base || DEFAULT_TABLE_BASE, () => null);
  let about = null;
  const shortId = (iri, fallback) => {
    let s = (iri || fallback || 'x').replace(/[#/]+$/, '').split(/[#/]/).pop() || fallback || 'x';
    // A %-escape that is not UTF-8 (%E0%A4 alone) cannot be decoded: the part is kept as written.
    try { s = decodeURIComponent(s); } catch { /* kept as written */ }
    s = s.replace(/\s+/g, '-');
    let id = s, k = 2; while (usedIds.has(id)) id = `${s}-${k++}`;
    usedIds.add(id); return id;
  };
  const ids = {
    place(iri, label, own, ccodes, entityIdentifier) {
      // A place without an address is a place of its own, not one with every other place that has
      // none: each gets its own row and place_id, and reading back gives it an address it did not have.
      if (!iri) { loss({ kind: 'place-without-address', value: label || entityIdentifier || '(no label)' }); iri = {}; }
      let p = places.get(iri);
      // A record's own identifier (from a place_id, say) is its place_id again, so tables round-trip.
      if (!p) {
        p = { place_id: entityIdentifier && !usedIds.has(entityIdentifier) ? (usedIds.add(entityIdentifier), entityIdentifier) : shortId(typeof iri === 'string' ? iri : undefined, 'place'), label: label || (typeof iri === 'string' ? iri : 'place'), country_codes: '', own };
        places.set(iri, p);
        if (typeof iri === 'string' && iri !== minted.place(p.place_id)) loss({ kind: 'place-address', value: iri });
      }
      if (own) { p.own = true; if (label) p.label = label; if (list(ccodes).length) p.country_codes = ccodes.join(';'); }
      return p.place_id;
    },
    source(src) {
      if (!src) { if (!sources.has('')) sources.set('', { source_id: 'none', title: 'No source given', citation: '', uri: '', date: 'undated', from: '', to: '', derived_from: '', licence: '' }); return 'none'; }
      const s = typeof src === 'string' ? { '@id': src } : src;
      const key = s['@id'] || JSON.stringify([s.title, s.citation, s.uri]);
      let r = sources.get(key);
      if (!r) {
        const ts = s.timespan || {};
        r = { source_id: shortId(s['@id'], 'source'), title: s.title || s['@id'], citation: s.citation || '', uri: s.uri || '', date: ts.sourceLabel || ts.label || (ts.startEarliest ? [ts.startEarliest, ts.endLatest].filter(Boolean).join('-') : 'undated'),
          from: ts.startEarliest || '', to: ts.endLatest || '', derived_from: '', licence: typeof s.licence === 'string' ? s.licence : '' };
        sources.set(key, r);
        sourceLosses(s, loss);
        if (s['@id'] && s['@id'] !== minted.sourceIri(r.source_id)) loss({ kind: 'source-address', value: s['@id'] });
        if (s.derivedFrom) r.derived_from = this.source(s.derivedFrom);
      }
      return r.source_id;
    },
  };
  return {
    // The gazetteer is the about sheet's one row; what it has no column for is reported.
    header(h) {
      tableLosses(h, loss); relationTypeLosses(h, loss);
      about = gazetteerToAbout(h.gazetteer, loss, accepts);
      if (!options.base && about.base_uri) minted = tableIds(about.base_uri, () => null);
    },
    event(ev) {
      if (ev.type === 'record') { const rows = recordToRows(ev.value, ids, loss, accepts, options.withdrawn); for (const [k, v] of Object.entries(rows)) buffers[k]?.push(...v); }
      else if (ev.type === 'idr') buffers.identities.push(identityRow(ev.value, ids, loss));
      else if (ev.type === 'attestation') loss({ kind: 'attestation-centric', value: ev.value?.['@id'] || `item ${ev.n}` });
    },
    async close() {
      settleRelatedPlaces(buffers.relations, (iri) => { const p = places.get(iri); return p && p.own ? p.place_id : null; });
      buffers.places = [...places.values()].map(({ own, ...r }) => r);
      buffers.sources = [...sources.values()];
      buffers.about = [about || gazetteerToAbout({}, loss, accepts)];
      const files = {};
      for (const t of schemas) files[t.url] = Papa.unparse({ fields: header[t.name], data: buffers[t.name].map((r) => header[t.name].map((h) => (r[h] === undefined || r[h] === null ? '' : String(r[h])))) }, { newline: '\n' }) + '\n';
      const { zipSync, strToU8 } = await import('fflate');
      const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
      const o = await env.output(stem + '-tables.zip', true);
      o.writeBytes(zip);
      outputs.push(await o.close());
      rep.count('table rows', Object.values(buffers).reduce((n, b) => n + b.length, 0));
    },
  };
}
