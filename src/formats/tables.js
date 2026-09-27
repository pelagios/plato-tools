// PLATO spreadsheet tables (CSV on the Web): validation, tables -> PLATO records, and
// PLATO records -> tables. Everything is driven by the same csv-metadata.json the PLATO
// repository publishes, so column names, required columns and allowed values cannot drift.
//
// Validation follows the CSVW rules the metadata uses, and is tested against the reference
// implementation (rdf-tabular, strict mode) on the same good and broken tables.
import { PLATO } from '../lib/context.js';

const NUM = { decimal: true, integer: true, nonNegativeInteger: true, double: true, float: true };

export function tableSchemas(meta) {
  return meta.tables.map((t) => ({
    url: t.url, name: t.url.replace(/\.csv$/, ''),
    columns: t.tableSchema.columns.filter((c) => !c.virtual),
    primaryKey: t.tableSchema.primaryKey || null,
    foreignKeys: (t.tableSchema.foreignKeys || []).map((f) => ({ column: f.columnReference, table: f.reference.resource.replace(/\.csv$/, ''), target: f.reference.columnReference })),
  }));
}

/** Check one cell against its column; returns an error message or null. */
export function checkCell(col, raw) {
  const values = col.separator ? (raw === '' ? [] : raw.split(col.separator)) : [raw];
  if (raw === '') return col.required ? 'is required' : null;
  const dt = col.datatype;
  for (const v of values) {
    const base = typeof dt === 'string' ? dt : dt && dt.base;
    if (base && NUM[base]) {
      if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(v.trim())) return `'${v}' is not a number`;
      const n = Number(v);
      if ((base === 'nonNegativeInteger' || base === 'integer') && !Number.isInteger(n)) return `'${v}' is not a whole number`;
      if (base === 'nonNegativeInteger' && n < 0) return `'${v}' is negative`;
      if (dt && dt.minInclusive !== undefined && n < dt.minInclusive) return `${v} is below ${dt.minInclusive}`;
      if (dt && dt.maxInclusive !== undefined && n > dt.maxInclusive) return `${v} is above ${dt.maxInclusive}`;
    }
    if (base === 'anyURI' && !/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(v)) return `'${v}' is not a web address`;
    if (dt && dt.format && base === 'string' && !new RegExp(dt.format).test(v)) {
      const m = dt.format.match(/^\^\(([A-Za-z|]+)\)\$$/);
      return m ? `'${v}' is not one of ${m[1].split('|').join(', ')}` : `'${v}' is not in the expected form`;
    }
  }
  return null;
}

/**
 * Validate a set of tables. `rows(tableName)` yields row objects keyed by header, with `header`
 * available as rowsHeader(tableName). Keys (primary and foreign) are checked through `keys`, a
 * set-like store, so the check works at any size. Returns nothing; reports through `issue`.
 */
export async function validateTables(meta, { header, rows, keys, issue }) {
  const schemas = tableSchemas(meta);
  for (const t of schemas) {
    const h = await header(t.name);
    if (h === null) { issue({ table: t.url, message: 'is missing: keep every sheet, even an empty one' }); continue; }
    const want = t.columns.map((c) => c.titles);
    if (h.join('\u0001') !== want.join('\u0001')) issue({ table: t.url, message: `has columns ${JSON.stringify(h)}; expected ${JSON.stringify(want)}` });
  }
  for (const t of schemas) {
    if ((await header(t.name)) === null) continue;
    let n = 0;
    for await (const row of rows(t.name)) {
      n++;
      for (const c of t.columns) {
        const err = checkCell(c, row[c.titles] ?? '');
        if (err) issue({ table: t.url, row: n, column: c.titles, message: err });
      }
      if (t.primaryKey) {
        const k = row[t.primaryKey];
        if (k && !(await keys.add(t.name, k))) issue({ table: t.url, row: n, column: t.primaryKey, message: `'${k}' is used by an earlier row` });
      }
    }
  }
  for (const t of schemas) {
    if (!t.foreignKeys.length || (await header(t.name)) === null) continue;
    let n = 0;
    for await (const row of rows(t.name)) {
      n++;
      for (const fk of t.foreignKeys) {
        const v = row[fk.column];
        if (v && !(await keys.has(fk.table, v))) issue({ table: t.url, row: n, column: fk.column, message: `'${v}' is not a ${fk.target} in ${fk.table}.csv` });
      }
    }
  }
}

const ATTESTATION_SHEETS = ['names', 'locations', 'types', 'relations', 'properties'];
const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === '' || (Array.isArray(o[k]) && !o[k].length)) delete o[k]; return o; };
const num = (v) => (v === '' || v === undefined ? undefined : Number(v));

/** One row of an attestation sheet -> one PLATO attestation object. */
export function rowToAttestation(sheet, row, ids) {
  const src = ids.source(row.source_id);
  const citation = clean({ source: src, locator: row.locator, attributionStatus: row.attribution ? PLATO + 'Attribution' + row.attribution : undefined });
  const a = clean({
    timespans: [clean({ label: row.date, startEarliest: row.from, endLatest: row.to })],
    sources: [src],
    citations: [citation],
    certainty: num(row.certainty),
    notes: row.notes,
  });
  if (sheet === 'names') {
    a.names = [clean({ toponym: row.name, language: row.language, script: row.script, romanized: row.romanized, nameType: row.name_type ? row.name_type.split(';') : undefined })];
    if (row.form_status) a.formStatus = PLATO + row.form_status;
    if (row.occurrence_context) a.occurrenceContext = PLATO + row.occurrence_context;
    if (row.occurrence_count) a.occurrenceCount = num(row.occurrence_count);
  } else if (sheet === 'locations') {
    const lat = num(row.latitude), lon = num(row.longitude);
    a.geometries = [clean({
      reprPoint: [lon, lat],
      geojson: { type: 'Point', coordinates: [lon, lat] },
      wkt: row.wkt, role: row.geometry_role ? PLATO + row.geometry_role : undefined,
      precisionKm: row.precision_km ? [num(row.precision_km)] : undefined,
    })];
  } else if (sheet === 'types') {
    a.types = [clean({ identifier: row.type_uri, label: row.type_label })];
  } else if (sheet === 'relations') {
    a.relations = [clean({ relatesTo: ids.place(row.related_place_id), relationType: PLATO + row.relation_type })];
  } else if (sheet === 'properties') {
    const v = row.value !== '' && !Number.isNaN(Number(row.value)) ? Number(row.value) : row.value;
    a.properties = [clean({ property: row.property_uri, label: row.property_label, value: v, unit: row.unit_uri })];
  }
  return a;
}

/** Identifier minting for tables: a base address the user chooses, plus the table's own ids. */
export function tableIds(base, sourcesById) {
  const b = base.endsWith('/') || base.endsWith('#') ? base : base + '/';
  return {
    place: (id) => b + 'place/' + encodeURIComponent(id),
    sourceIri: (id) => b + 'source/' + encodeURIComponent(id),
    source(id) {
      const r = sourcesById(id);
      if (!r) return b + 'source/' + encodeURIComponent(id);
      return clean({
        '@id': b + 'source/' + encodeURIComponent(id), title: r.title, citation: r.citation, uri: r.uri, authorityType: 'source',
        timespan: r.date || r.from || r.to ? clean({ label: r.date, startEarliest: r.from, endLatest: r.to }) : undefined,
        derivedFrom: r.derived_from ? b + 'source/' + encodeURIComponent(r.derived_from) : undefined,
      });
    },
  };
}

export { ATTESTATION_SHEETS };
