// A table of figures (a census, a return) read as PLATO statistical figures, each a PropertyValue that is
// also a Data Cube observation (PLATO issue #14; docs/statistics.md in PLATO). It is Hermes's table
// reader (generic.js) with more roles for its columns (columns.js: period, dimension, value, figure) and
// a description of the table beside the mapping:
//
//   { "columns": { "County": "name", "Year": "period",
//                  "Occupation": { "field": "dimension", "dimension": "occupation" },
//                  "Sex": { "field": "dimension", "dimension": "sex" },
//                  "Persons": { "field": "value", "measure": "persons" } },
//     "table": { "title": "…", "description": "scope in words", "source": "title or web address",
//                "dimensions": { "occupation": { "total": "All" } } } }
//
// Two shapes, both with one header row. LONG: one row for each cell of the printed table; the dimension
// columns give the figure's coordinates and a "value" column the figure. WIDE: one row for each place and
// period, the categories across; each "figure" column carries its own coordinates ({"occupation":
// "Farmers"}) and a total beside its parts says so with "totalOf". The table's description (`table`) holds
// what is not a column: its title, scope and source, the measure and period when constant, coordinates
// every figure shares ("coordinates": {"sex": "Male"}), a dimension's own web address and codes, and
// which code is the total of a dimension.
//
// What it writes, as the Elenchos and Arithmos tools and the design (docs, PLATO #14) fix it:
//   - attestation-centric, with `dataSets` in the header: one attestation for each source row, about its
//     place, the row as its `locator`; one new place for each place key at the end. A place is its id
//     column's value, or its web address column's, or else its name with the values of every "within"
//     column (so that two parishes of one name in two counties are two places);
//   - each figure an @id of its place's address, "#f-" and 16 hex digits of the SHA-256 of the table, the
//     measure, the period and the coordinates, so that the same figure keeps its address when the rows are
//     reordered or the table is read again; its coordinates under `dimensions` as codes; the measure as the
//     property; `universe` only where the user marked a total (`totalOf` of a wide column; `total` of a
//     dimension's code in a long table), never from a name or a sum;
//   - a printed dash is a figure with no value and sdmx-attribute:obsStatus "nil or not applicable", never
//     a 0; a blank cell is no figure; a cell that is not a plain number (thousands separators are read, a
//     decimal comma is not) is reported and left out. Every cell is counted, and the count must add up:
//     cells = figures + dashes + blanks + cells left out (conservation(), figures-text.js);
//   - a blank cell of a dimension is that dimension's code `unknown`;
//   - the code lists and the declarations of the dimensions and measures, which PLATO JSON has no place
//     for, as a `{ type: 'codes' }` event after the last place: the pipeline writes them to a second
//     N-Triples file beside the output (codesToNTriples).
// Addresses minted under the base address: <base>table/<slug>, <base>dim/<slug>, <base>measure/<slug>,
// <base>code/<dimension>/<slug>, <base>source/<slug>, <base>place/area-<hash> (a place with no id).
//
// The reader reads the rows twice: first to give every code its address (two labels that differ only
// in case or punctuation both take the hash of their label, so that no code's address depends on which
// row met it first) and, where a total is marked in a long table, to know which totals exist; then to write.
import { openTable, sheetIn } from './generic.js';
import { resolveColumns, applyColumns, expandSplits, splitRow, cellText, figuresSpec, GENERIC_KINDS, FIGURE_FIELDS } from './columns.js';
import { FIGURES_KINDS } from './figures-text.js';
import { LOSS_TEXT } from '../report.js';
import { tableIds } from '../../formats/tables.js';
import { sha256 } from '../../lib/sha256.js';
import { iri, literal, tripleNT } from '../../lib/ntriples.js';
import { REF_AREA, REF_PERIOD, OBS_STATUS, QB } from '../../formats/cube.js';
import { RDF } from '../../lib/context.js';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.trim() !== '';
const own = (o, k) => Object.hasOwn(o, k);
const isWeb = (s) => typeof s === 'string' && /^https?:\/\/\S+$/i.test(s.trim());
const CITES_AS_DATA_SOURCE = 'http://purl.org/spar/cito/citesAsDataSource';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#', SKOS = 'http://www.w3.org/2004/02/skos/core#';
/** The code a dimension has for a cell that is blank. */
export const UNKNOWN = 'unknown';
/** The status of a printed dash: a declared absence, never a zero. */
const ABSENT = { slug: 'nil-or-not-applicable', label: 'nil or not applicable' };
/** The marks a cell uses for a figure the table prints as absent: a hyphen, an en dash, an em dash, a figure dash. */
export const DASHES = ['-', '–', '—', '‒'];

/** The mapping's roles that make a table a table of figures: whether this saved mapping (or the mapping's fields) is one. */
export function readsFigures(columns) {
  if (!isObject(columns)) return false;
  const inner = figuresSpec(columns)?.columns ?? columns;
  return Object.values(inner).some((v) => FIGURE_FIELDS.has(typeof v === 'string' ? v : v?.field));
}

/** A label as the last part of an address: lower case, letters and digits, a hyphen between words; '' for none. */
export const slug = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const withHash = (s, label) => `${s || 'x'}-${sha256(String(label)).slice(0, 8)}`;

// ---- cells ----------------------------------------------------------------------------------------
const PLAIN = /^[+-]?\d+(\.\d+)?$/;
// Thousands separators: a comma, a space, a no-break space, a thin space or an apostrophe, the same one throughout.
const GROUPED = /^[+-]?\d{1,3}([,   '’])\d{3}(?:\1\d{3})*(\.\d+)?$/;
/**
 * A cell of a column of figures: { kind: 'blank' }, { kind: 'dash' }, { kind: 'value', value, label }
 * (label: the cell's own text, kept when it is not the number's plain form), or { kind: 'bad' } for
 * anything else. A decimal comma is not guessed at ("1,5" is not a number, "1,500" is fifteen hundred),
 * and a number too large to keep exactly is not one.
 */
export function figureCell(cell, dashes = DASHES) {
  const s = cellText(cell);
  if (s === '') return { kind: 'blank' };
  if (dashes.includes(s)) return { kind: 'dash', label: s };
  if (!PLAIN.test(s) && !GROUPED.test(s)) return { kind: 'bad' };
  const value = Number(s.replace(/[,   '’]/g, ''));
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return { kind: 'bad' };
  return { kind: 'value', value, ...(s === String(value) ? {} : { label: s }) };
}

const pad4 = (y) => (/^-?\d{1,3}$/.test(y) ? (y.startsWith('-') ? '-' + y.slice(1).padStart(4, '0') : y.padStart(4, '0')) : y);
const DAY = /^-?\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, MONTH = /^-?\d{4}-(0[1-9]|1[0-2])$/, YEAR = /^-?\d{1,4}$/;
const SPAN = /^(-?\d{4})\s*(?:-|–|—|\/|to)\s*(-?\d{4})$/;
/**
 * A period as the table gives it: { startEarliest, endLatest, sourceLabel } for a year, a month, an ISO
 * date or two years (1851-1861), the label being the cell's own text; null for anything else. A year
 * stays a year (the Data Cube's refPeriod is then a gYear), a day a day, and a span a span.
 */
export function parsePeriod(cell) {
  const s = cellText(cell);
  if (YEAR.test(s)) { const y = pad4(s); return { startEarliest: y, endLatest: y, sourceLabel: s }; }
  if (DAY.test(s) || MONTH.test(s)) return { startEarliest: s, endLatest: s, sourceLabel: s };
  const m = SPAN.exec(s);
  if (m && Number(m[1]) <= Number(m[2])) return { startEarliest: m[1], endLatest: m[2], sourceLabel: s };
  return null;
}
const yearOf = (d) => /^(-?\d{4})/.exec(d)?.[1];

// ---- the description of the table -------------------------------------------------------------------
const TABLE_KEYS = ['id', 'title', 'description', 'source', 'measure', 'period', 'coordinates', 'dimensions', 'dashes'];
const DIMENSION_KEYS = ['label', 'iri', 'codes', 'total'];
/** The table's description, checked: what is wrong with it is reported (figures-mapping-table) and left out. */
function readTable(given, say) {
  const t = {};
  if (given === undefined) return t;
  if (!isObject(given)) { say('figures-mapping-table', 'the table\'s description must be an object, {"title": "…", "source": "…"}'); return t; }
  for (const k of Object.keys(given)) if (!TABLE_KEYS.includes(k)) say('figures-mapping-table', `"${k}" is not part of a table's description (${TABLE_KEYS.join(', ')})`);
  for (const k of ['id', 'title', 'description', 'source', 'measure']) {
    if (given[k] === undefined) continue;
    if (text(given[k])) t[k] = given[k].trim(); else say('figures-mapping-table', `"${k}" must be text`);
  }
  if (given.period !== undefined) {
    const p = isObject(given.period) ? [given.period.start, given.period.end].filter((x) => x !== undefined).join('-') : given.period;
    const ts = isObject(given.period) && given.period.start !== undefined && given.period.end !== undefined
      ? (parsePeriod(given.period.start) && parsePeriod(given.period.end) ? { startEarliest: parsePeriod(given.period.start).startEarliest, endLatest: parsePeriod(given.period.end).endLatest, sourceLabel: p } : null)
      : parsePeriod(typeof p === 'number' ? String(p) : p);
    if (ts) t.period = ts; else say('figures-mapping-table', `"period" ${JSON.stringify(given.period)} is not a year, an ISO date or two years (1851-1861)`);
  }
  if (given.coordinates !== undefined) {
    if (isObject(given.coordinates) && Object.values(given.coordinates).every((v) => text(v) || typeof v === 'number')) t.coordinates = Object.fromEntries(Object.entries(given.coordinates).map(([d, v]) => [d, String(v)]));
    else say('figures-mapping-table', '"coordinates" must name a code for each dimension, {"sex": "Male"}');
  }
  if (given.dimensions !== undefined) {
    t.dimensions = {};
    if (!isObject(given.dimensions)) say('figures-mapping-table', '"dimensions" must be an object with a key for each dimension named');
    else for (const [d, v] of Object.entries(given.dimensions)) {
      if (!isObject(v)) { say('figures-mapping-table', `the dimension "${d}" must be described by an object, {"total": "All"}`); continue; }
      for (const k of Object.keys(v)) if (!DIMENSION_KEYS.includes(k)) say('figures-mapping-table', `"${k}" is not part of a dimension's description (${DIMENSION_KEYS.join(', ')}), in "${d}"`);
      const o = {};
      if (text(v.label)) o.label = v.label.trim();
      if (v.iri !== undefined) { if (isWeb(v.iri)) o.iri = v.iri.trim(); else say('figures-code-address', `the dimension "${d}": ${JSON.stringify(v.iri)}`); }
      if (v.total !== undefined) { if (text(v.total) || typeof v.total === 'number') o.total = String(v.total); else say('figures-mapping-table', `the total of "${d}" must be the code that is the total, as the table writes it`); }
      if (v.codes !== undefined) {
        o.codes = {};
        if (!isObject(v.codes)) say('figures-mapping-table', `the codes of "${d}" must be an object, {"M": "https://…"}`);
        else for (const [label, a] of Object.entries(v.codes)) { if (isWeb(a)) o.codes[label] = a.trim(); else say('figures-code-address', `the dimension "${d}", ${JSON.stringify(label)}: ${JSON.stringify(a)}`); }
      }
      t.dimensions[d] = o;
    }
  }
  if (given.dashes !== undefined) {
    if (Array.isArray(given.dashes) && given.dashes.every(text)) t.dashes = given.dashes.map((x) => x.trim()); else say('figures-mapping-table', '"dashes" must be a list of the marks the table prints for a figure that is absent, ["-", "n.a."]');
  }
  return t;
}

/**
 * The records of a table of figures: a header (with `dataSets`), an 'attestation' for each row about its
 * place, a 'record' for each new place, and last a 'codes' event with the code lists. `options.columns` is
 * the saved mapping { columns, table } (or the columns alone); `options.base` the base address.
 */
export async function* figuresSource(input, rep, options = {}, defaultBase = 'https://example.org/my-dataset/') {
  const file = input.files[0];
  const KINDS = { ...GENERIC_KINDS, ...FIGURES_KINDS };
  const report = (kind, example) => rep.add(KINDS[kind] || 'loss', kind, LOSS_TEXT[kind] || kind, example);
  const quiet = () => {};
  const empty = () => ({ profile: 'attestation-centric', gazetteer: { title: options.title || `Figures in ${file.name}` }, dataSets: [] });
  if (input.format !== 'csv') { yield { type: 'header', value: empty() }; report('figures-not-csv', file.name); return; }
  const sheet = sheetIn(input, options);
  const t = await openTable(input, sheet);
  const { mapping, patterns, levels, splits, figures, problems, table: given } = resolveColumns(t.headers, t.sample, options.columns, t.headerText, { ownGeometry: t.ownGeometry });
  for (const p of [...(t.headProblems || []), ...problems]) report(p.kind, p.example);
  if (t.empty) { yield { type: 'header', value: empty() }; report('generic-sheet-empty', `"${sheet}" in ${file.name}`); return; }
  const table = readTable(given, report);

  // ---- the plan: what each column is ------------------------------------------------------------------
  const base = options.base || defaultBase;
  const b = base.endsWith('/') || base.endsWith('#') ? base : base + '/';
  const minted = tableIds(base, () => null);
  const placeMapping = Object.create(null);
  for (const h of t.headers) if (!FIGURE_FIELDS.has(mapping[h])) placeMapping[h] = mapping[h];
  const expanded = expandSplits(placeMapping, levels, splits);
  const fields = Object.values(expanded.mapping);
  const byAddress = fields.includes('address'), hasId = fields.includes('id'), hasName = fields.includes('name') || fields.includes('alternativeNames');
  const dashes = [...DASHES, ...(table.dashes || [])];
  const faults = [];
  const dimCols = [], figureCols = [];
  let periodCol;
  for (const h of t.headers) {
    const f = mapping[h], g = figures[h] || {};
    if (f === 'period') periodCol = h;
    else if (f === 'dimension') dimCols.push({ col: h, name: g.dimension ?? h });
    else if (f === 'value') figureCols.push({ col: h, measure: g.measure ?? table.measure ?? h, coords: {}, totalOf: [] });
    else if (f === 'figure') figureCols.push({ col: h, measure: g.measure ?? table.measure ?? h, coords: g.coordinates ?? {}, totalOf: g.totalOf ?? [] });
  }
  if (!figureCols.length) faults.push('no column is a "value" or a "figure", so there are no figures to read');
  if (!byAddress && !hasId && !hasName) faults.push('no column is the places\' id, their web address or their name, so the figures have no place');
  const tableCoords = table.coordinates || {};
  const seenDim = new Set();
  const dimension = (d) => table.dimensions?.[d] || {};
  for (const { name } of dimCols) { if (seenDim.has(name)) faults.push(`two columns are the dimension "${name}"`); seenDim.add(name); }
  for (const d of Object.keys(tableCoords)) if (seenDim.has(d)) faults.push(`the dimension "${d}" is a column and also a coordinate every figure shares`);
  for (const c of figureCols) for (const d of Object.keys(c.coords)) if (seenDim.has(d) || own(tableCoords, d)) faults.push(`the column "${c.col}" gives the coordinate "${d}", which is already a column or a coordinate of the table`);
  // Totals of columns: each part in one total only, of its own measure, with no loop.
  const parent = new Map();
  const byCol = new Map(figureCols.map((c) => [c.col, c]));
  for (const c of figureCols) for (const m of c.totalOf) {
    if (!byCol.has(m) || mapping[m] !== 'figure') faults.push(`the column "${c.col}" is the total of "${m}", which is not a column of figures with coordinates of its own`);
    else if (m === c.col) faults.push(`the column "${m}" is the total of itself`);
    else if (byCol.get(m).measure !== c.measure) faults.push(`the column "${c.col}" is the total of "${m}", which is another measure`);
    else if (parent.has(m)) faults.push(`the column "${m}" is the part of two totals, "${parent.get(m)}" and "${c.col}"`);
    else parent.set(m, c.col);
  }
  for (const c of figureCols) for (let p = parent.get(c.col), n = 0; p !== undefined; p = parent.get(p)) if (p === c.col || ++n > figureCols.length) { faults.push(`the totals of columns loop round at "${c.col}"`); break; }
  // The measures, each a data set; the dimensions of each, in the order they are given.
  const measures = new Map();
  for (const c of figureCols) {
    if (!measures.has(c.measure)) measures.set(c.measure, { label: c.measure, slug: slug(c.measure) || withHash('', c.measure), dims: [], cols: [] });
    measures.get(c.measure).cols.push(c);
  }
  const taken = new Map();
  for (const m of measures.values()) { if (taken.has(m.slug)) faults.push(`the measures "${taken.get(m.slug)}" and "${m.label}" would have one address`); taken.set(m.slug, m.label); }
  for (const m of measures.values()) {
    const add = (d) => { if (!m.dims.includes(d)) m.dims.push(d); };
    for (const d of Object.keys(tableCoords)) add(d);
    for (const { name } of dimCols) add(name);
    for (const c of m.cols) for (const d of Object.keys(c.coords)) add(d);
  }
  const allDims = [...new Set([...measures.values()].flatMap((m) => m.dims))];
  const dimSlug = new Map(allDims.map((d) => [d, slug(d) || withHash('', d)]));
  const dimTaken = new Map();
  for (const d of allDims) { const s = dimSlug.get(d); if (dimTaken.has(s) && dimTaken.get(s) !== d) faults.push(`the dimensions "${dimTaken.get(s)}" and "${d}" would have one address`); dimTaken.set(s, d); }
  for (const d of Object.keys(table.dimensions || {})) if (!allDims.includes(d)) report('figures-mapping-table', `the table describes a dimension "${d}", which no column or coordinate gives`);
  const dimIri = (d) => dimension(d).iri || `${b}dim/${dimSlug.get(d)}`;
  const hasPeriod = !!(periodCol || table.period || (fields.includes('start') && fields.includes('end')));
  const stem = file.name.replace(/\.gz$/i, '').replace(/\.[^.]+$/, '');
  const tableSlug = slug(table.id || table.title || stem) || 'table';
  const several = measures.size > 1;
  for (const m of measures.values()) m.iri = `${b}table/${tableSlug}${several ? '-' + m.slug : ''}`;
  const measureIri = (m) => `${b}measure/${m.slug}`;
  const sourceTitle = table.source || file.name;
  const source = {
    '@id': `${b}source/${isWeb(sourceTitle) ? 'source-' + sha256(sourceTitle).slice(0, 8) : slug(sourceTitle) || 'source'}`,
    title: sourceTitle, authorityType: 'source', ...(isWeb(sourceTitle) ? { uri: sourceTitle.trim() } : {}),
  };
  const title = table.title || `Figures in ${file.name}`;
  const dataSets = [...measures.values()].map((m) => ({
    '@id': m.iri, title: several ? `${title}: ${m.label}` : title, ...(table.description ? { description: table.description } : {}), isPartOf: source['@id'],
    structure: { '@id': `${m.iri}/structure`, components: [{ dimension: REF_AREA }, ...(hasPeriod ? [{ dimension: REF_PERIOD }] : []), ...m.dims.map((d) => ({ dimension: dimIri(d) })), { measure: measureIri(m) }] },
  }));
  yield { type: 'header', value: {
    profile: 'attestation-centric',
    gazetteer: { title: options.title || title, description: `Converted by PLATO tools from a table of figures (${input.container === 'workbook' ? `the sheet "${sheet}" of a workbook` : 'CSV'}), ${file.name}: one attestation for each row, about its place, holding the row's figures as Data Cube observations.` },
    dataSets: faults.length ? [] : dataSets,
  } };
  if (faults.length) { for (const f of faults) report('figures-mapping', f); return; }
  if (!options.base) report('generic-stand-in-base', base);
  if (!hasId && !byAddress) report('figures-names-as-keys', file.name);

  // Which dimensions a column of figures has of its own; the others it is given "unknown" for.
  const ownDims = (c) => new Set([...Object.keys(tableCoords), ...dimCols.map((x) => x.name), ...Object.keys(c.coords)]);
  const filled = new Set();
  for (const m of measures.values()) for (const c of m.cols) for (const d of m.dims) if (!ownDims(c).has(d)) {
    const k = m.label + '\u0001' + d;
    if (!filled.has(k)) { filled.add(k); report('figures-coordinate-filled', `the measure "${m.label}", the dimension "${d}" (the column "${c.col}" has none)`); }
  }

  // ---- reading a row ----------------------------------------------------------------------------------
  // Each row through the place columns (columns.js, applyColumns), then its place, its period and its cells.
  const labelsOf = new Map(allDims.map((d) => [d, new Set()]));
  const unknownIn = new Set([...filled].map((k) => k.split('\u0001')[1]));
  for (const d of allDims) for (const m of measures.values()) if (m.dims.includes(d) && own(tableCoords, d)) labelsOf.get(d).add(tableCoords[d]);
  for (const c of figureCols) for (const [d, v] of Object.entries(c.coords)) labelsOf.get(d).add(String(v));
  const parse = (r, say) => {
    const row = splitRow(r.row, splits, { report: say, where: r.where });
    const a = applyColumns(row, expanded.mapping, { where: r.where, report: say, fileName: file.name, patterns, levels: expanded.levels, from: expanded.from });
    // The place: the web address the row gives, else its id, else its name with the regions it lies in.
    let place = null;
    if (a.address) place = { iri: a.address, existing: true };
    else if (a.id !== undefined) place = { iri: minted.place(a.id), id: a.id, label: a.label ?? a.id };
    else if (a.label) place = { iri: minted.place('area-' + sha256(JSON.stringify([a.label, ...(a.within || []).map((w) => w.value)])).slice(0, 16)), label: a.label };
    // The period: the column's cell, else the start and end columns' (or the date's) timespan, else the table's.
    let ts = a.attestation.timespans?.[0];
    if (periodCol && cellText(row[periodCol]) !== '') {
      const text = cellText(row[periodCol]);
      ts = parsePeriod(text);
      if (!ts) { say('figures-period-invalid', `${r.where}, column "${periodCol}": ${text}`); ts = { sourceLabel: text }; }
    } else if (!ts && table.period) ts = { ...table.period };
    const dims = new Map(dimCols.map(({ col, name }) => { const v = cellText(row[col]); return [name, v === '' ? null : v]; }));
    return { a, place, ts, dims, row };
  };
  // The figures of a row: for each column of figures its cell read, its coordinates, its address. Counted
  // as it goes (`n`), so that every cell is one of a figure, a dash, a blank or one left out.
  const build = (p, r, seen, say, n) => {
    const out = [];
    for (const c of figureCols) {
      n['figure cells']++;
      const cell = figureCell(p.row[c.col], dashes);
      if (cell.kind === 'blank') { n['blank cells']++; continue; }
      if (!p.place) { n['cells left out']++; continue; }
      if (cell.kind === 'bad') { say('figures-cell-not-number', `${r.where}, column "${c.col}": ${cellText(p.row[c.col])}`); n['cells left out']++; continue; }
      const m = measures.get(c.measure);
      const coords = m.dims.map((d) => [d, own(c.coords, d) ? String(c.coords[d]) : p.dims.has(d) ? p.dims.get(d) : own(tableCoords, d) ? tableCoords[d] : null]);
      const period = p.ts ? JSON.stringify([p.ts.startEarliest ?? null, p.ts.endLatest ?? null, p.ts.sourceLabel ?? null]) : '';
      const id = `${p.place.iri}#f-${sha256(JSON.stringify([tableSlug, m.slug, period, coords])).slice(0, 16)}`;
      if (seen.has(id)) { say('figures-duplicate', `${r.where}, column "${c.col}": ${coords.map(([d, v]) => `${d} ${v === null ? UNKNOWN : v}`).join(', ') || 'no coordinates'} (the same as ${seen.get(id)})`); n['cells left out']++; continue; }
      seen.set(id, r.where);
      out.push({ c, m, cell, coords, id });
    }
    return out;
  };
  const totalOfDims = (m) => m.dims.filter((d) => dimension(d).total !== undefined);

  // ---- the first reading: the codes' addresses, and which totals exist --------------------------------
  const existing = [...measures.values()].some((m) => totalOfDims(m).length) ? new Map() : null;
  const scratch = { 'figure cells': 0, 'blank cells': 0, 'cells left out': 0 };
  let counter = 0;
  for await (const r of t.rows()) {
    if (!r.row) continue;
    r.n = ++counter;
    const p = parse(r, quiet);
    for (const [d, v] of p.dims) { if (v === null) unknownIn.add(d); else labelsOf.get(d).add(v); }
    if (existing) build(p, r, existing, quiet, scratch);
  }
  // The addresses of the codes: a label's slug, or with the hash of the label where two labels share a slug.
  const codeIris = new Map();
  for (const d of allDims) {
    const bySlug = new Map();
    for (const label of labelsOf.get(d)) { const s = slug(label) || ''; (bySlug.get(s) || bySlug.set(s, []).get(s)).push(label); }
    const mapLabel = new Map();
    for (const [s, labels] of bySlug) for (const label of labels) mapLabel.set(label, dimension(d).codes?.[label] || `${b}code/${dimSlug.get(d)}/${labels.length > 1 || !s ? withHash(s, label) : s}`);
    codeIris.set(d, mapLabel);
  }
  const codeIri = (d, label) => (label === null ? `${b}code/${dimSlug.get(d)}/${UNKNOWN}` : codeIris.get(d).get(label));

  // ---- the second reading: the attestations ----------------------------------------------------------
  const counts = { 'figure cells': 0, figures: 0, 'declared absences': 0, 'blank cells': 0, 'cells left out': 0 };
  const seen = new Map();
  const places = new Map();
  let sawAbsence = false, rows = 0;
  for await (const r of t.rows()) {
    if (r.notAList || r.notFeature) continue;
    rep.count('rows'); rows++;
    const say = report;
    if (r.problem) say('generic-csv-row', `${r.where}: ${r.problem}`);
    if (r.extra?.length) say('generic-csv-extra-cells', `${r.where}: ${r.extra.join(', ')}`);
    for (const e of r.cellErrors || []) say('generic-sheet-error-cell', `${r.where}, ${e.column.trim() ? `column "${e.column}"` : `column ${e.ref.replace(/\d+$/, '')} (no heading)`}, cell ${e.ref}: ${e.text}`);
    r.n = rows;
    const p = parse(r, say);
    if (!p.place) say('figures-row-no-place', r.where);
    const made = build(p, r, seen, say, counts);
    // The universes: a column's total beside it in the row, or the figure with a marked dimension's total code.
    const idOfCol = new Map(made.map((f) => [f.c.col, f.id]));
    const props = [];
    for (const f of made) {
      const { c, m, cell, coords } = f;
      const prop = {
        '@id': f.id, property: measureIri(m), label: m.label,
        ...(cell.kind === 'value' ? { value: cell.value } : {}),
        dataSet: m.iri,
        dimensions: Object.fromEntries(coords.map(([d, v]) => [dimIri(d), { '@id': codeIri(d, v) }])),
        ...(cell.label !== undefined ? { sourceLabel: cell.label } : {}),
      };
      if (cell.kind === 'dash') { prop.attributes = { [OBS_STATUS]: { '@id': `${b}code/obs-status/${ABSENT.slug}` } }; sawAbsence = true; counts['declared absences']++; } else counts.figures++;
      let universe;
      if (parent.has(c.col)) {
        universe = idOfCol.get(parent.get(c.col));
        if (!universe) say('figures-total-missing', `${r.where}, column "${c.col}": the total, column "${parent.get(c.col)}", has no figure`);
      } else {
        const marked = totalOfDims(m);
        // The last marked dimension in which this figure is not the total: its figure with that dimension's total instead.
        for (let i = marked.length - 1; i >= 0; i--) {
          const d = marked[i], at = coords.findIndex(([x]) => x === d), total = dimension(d).total;
          if (coords[at][1] === total) continue;
          if (coords[at][1] === null) break;
          const up = coords.map(([x, v], j) => (j === at ? [x, total] : [x, v]));
          const period = p.ts ? JSON.stringify([p.ts.startEarliest ?? null, p.ts.endLatest ?? null, p.ts.sourceLabel ?? null]) : '';
          const target = `${p.place.iri}#f-${sha256(JSON.stringify([tableSlug, m.slug, period, up])).slice(0, 16)}`;
          if (existing.has(target)) universe = target;
          else say('figures-total-missing', `${r.where}, column "${c.col}": ${d} ${total}, the total looked for, has no figure for ${coords.filter(([x]) => x !== d).map(([x, v]) => `${x} ${v === null ? UNKNOWN : v}`).join(', ') || 'this place'}`);
          break;
        }
      }
      if (universe) prop.universe = universe;
      props.push(prop);
    }
    if (!p.place) continue;
    if (p.ts?.startEarliest && yearOf(p.ts.startEarliest) !== yearOf(p.ts.endLatest)) say('figures-period-span', `${r.where}: ${p.ts.sourceLabel ?? `${p.ts.startEarliest} to ${p.ts.endLatest}`}`);
    if (!p.ts) say('figures-no-period', r.where);
    if (!props.length) continue;
    const att = { about: p.place.iri, ...p.a.attestation, ...(p.ts ? { timespans: [p.ts] } : {}) };
    if (!fields.includes('source')) {
      att.sources = [source];
      att.citations = [{ source, locator: r.where, citationFunction: CITES_AS_DATA_SOURCE }];
    }
    att.properties = props;
    if (!p.place.existing) {
      const known = places.get(p.place.iri) || places.set(p.place.iri, { label: p.place.label, id: p.place.id, names: new Set() }).get(p.place.iri);
      if (known.names.size < 6) known.names.add(p.place.label);
    }
    yield { type: 'attestation', value: att, n: rows, ...(p.a.within ? { within: p.a.within } : {}) };
  }
  for (const [k, v] of Object.entries(counts)) rep.count(k, v);
  // A skipped column is reported once, by name, if it had a value to lose (generic.js does the same).
  // The new places: one for each place key, labelled with its name.
  for (const [iriOfPlace, p] of places) {
    const names = [...p.names];
    if (p.id !== undefined && names.length > 1) report('generic-same-id-label', `"${p.id}": ${names.join(' / ')}`);
    yield { type: 'record', newEntity: true, value: { '@id': iriOfPlace, label: p.id !== undefined && names.length > 1 ? p.id : names[0], ...(p.id !== undefined ? { entityIdentifier: p.id } : {}), attestations: [] } };
  }
  for (const [d, total] of allDims.map((d) => [d, dimension(d).total]).filter(([, x]) => x !== undefined)) if (!labelsOf.get(d).has(total)) report('figures-total-unmet', `the dimension "${d}", the total "${total}"`);
  if (!rows) report('generic-empty', `${file.name}: no rows`);
  else if (!counts.figures && !counts['declared absences']) report('generic-nothing-converted', `${rows === 1 ? 'The one row did not' : `None of the ${rows.toLocaleString('en-GB')} rows`} become${rows === 1 ? 's' : ''} a figure: ${counts['figure cells'] === counts['blank cells'] ? 'the columns of figures are empty' : 'no place, or no cell that is a number'}`);
  yield { type: 'codes', value: {
    base: b, absence: sawAbsence ? { iri: `${b}code/obs-status/${ABSENT.slug}`, scheme: `${b}code/obs-status`, label: ABSENT.label } : null,
    measures: [...measures.values()].map((m) => ({ iri: measureIri(m), label: m.label })),
    dimensions: allDims.map((d) => {
      const minted = [...codeIris.get(d)].filter(([label, a]) => a.startsWith(`${b}code/${dimSlug.get(d)}/`)).map(([label, a]) => ({ iri: a, label }));
      if (unknownIn.has(d) && !minted.some((c) => c.iri === codeIri(d, null))) minted.push({ iri: codeIri(d, null), label: UNKNOWN });
      return { iri: dimIri(d), label: dimension(d).label || d, ...(minted.length ? { scheme: `${b}code/${dimSlug.get(d)}`, codes: minted } : {}), own: !!dimension(d).iri };
    }),
  } };
}

/**
 * The code lists and declarations of a table of figures (the 'codes' event) as N-Triples text, sorted:
 * each dimension a qb:DimensionProperty with its qb:codeList, each measure a qb:MeasureProperty, each
 * code a skos:Concept with the source's label as skos:prefLabel in its skos:ConceptScheme. PLATO JSON has
 * no place for these, so they are written beside the output (pipeline.js).
 */
export function codesToNTriples(codes) {
  const lines = [];
  const a = (s, p, o) => lines.push(tripleNT(iri(s), iri(p), o));
  const type = (s, cls) => a(s, RDF + 'type', iri(cls));
  const label = (s, p, text) => a(s, p, literal(text));
  for (const m of codes.measures) { type(m.iri, QB + 'MeasureProperty'); label(m.iri, RDFS + 'label', m.label); }
  for (const d of codes.dimensions) {
    // A dimension of a vocabulary of its own (the table's description gave its address) is declared there, unless codes were made for it.
    if (d.own && !d.scheme) continue;
    type(d.iri, QB + 'DimensionProperty'); label(d.iri, RDFS + 'label', d.label);
    if (!d.scheme) continue;
    a(d.iri, QB + 'codeList', iri(d.scheme));
    type(d.scheme, SKOS + 'ConceptScheme'); label(d.scheme, SKOS + 'prefLabel', d.label);
    for (const c of d.codes) {
      type(c.iri, SKOS + 'Concept'); label(c.iri, SKOS + 'prefLabel', c.label);
      a(c.iri, SKOS + 'inScheme', iri(d.scheme)); a(c.iri, SKOS + 'topConceptOf', iri(d.scheme)); a(d.scheme, SKOS + 'hasTopConcept', iri(c.iri));
    }
  }
  if (codes.absence) {
    const x = codes.absence;
    type(x.scheme, SKOS + 'ConceptScheme'); label(x.scheme, SKOS + 'prefLabel', 'observation status');
    type(x.iri, SKOS + 'Concept'); label(x.iri, SKOS + 'prefLabel', x.label);
    a(x.iri, SKOS + 'inScheme', iri(x.scheme)); a(x.iri, SKOS + 'topConceptOf', iri(x.scheme)); a(x.scheme, SKOS + 'hasTopConcept', iri(x.iri));
  }
  return [...new Set(lines)].sort().join('');
}
