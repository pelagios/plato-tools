// PLATO spreadsheet tables (CSV on the Web): validation, tables -> PLATO records, and
// PLATO records -> tables. Everything is driven by the same csv-metadata.json the PLATO
// repository publishes, so column names, required columns and allowed values cannot drift.
//
// Validation follows the CSVW rules the metadata uses, and is tested against the reference
// implementation (rdf-tabular, strict mode) on the same good and broken tables.
import { PLATO } from '../lib/context.js';
import { isDenial, isAlternative, qualificationLosses, currentAttestations, isFigure, dropKeys, dropKey } from './shared.js';

export const CITO = 'http://purl.org/spar/cito/';

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
    // A CSVW boolean: with a format 'yes|no', the first word is true and the second false.
    if (base === 'boolean') {
      const words = dt && dt.format ? dt.format.split('|') : ['true', 'false', '1', '0'];
      if (!words.includes(v)) return `'${v}' is not ${words.length === 2 ? `${words[0]} or ${words[1]}` : 'true or false'}`;
    }
    if (base === 'anyURI' && !/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(v)) return `'${v}' is not a web address`;
    if (dt && dt.format && base === 'string' && !new RegExp(dt.format).test(v)) {
      const m = dt.format.match(/^\^\(([A-Za-z|]+)\)\$$/);
      return m ? `'${v}' is not one of ${m[1].split('|').join(', ')}` : `'${v}' is not in the expected form`;
    }
  }
  return null;
}

/** A test of whether a value fits a column, by the table definitions: accepts('names', 'citation_function', 'citesAsEvidence'). */
export function cellChecker(meta) {
  const cols = new Map();
  for (const t of tableSchemas(meta)) for (const c of t.columns) cols.set(t.name + '\u0001' + c.titles, c);
  return (sheet, column, value) => { const c = cols.get(sheet + '\u0001' + column); return !c || checkCell(c, String(value)) === null; };
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
// The denied column (plato:negated): 'yes' is a denial and 'no' is not. Any other word is a
// problem the validator reports; read, it counts as a denial, so that a mistyped 'Yes' can never
// turn what a source denies into an assertion.
const denied = (v) => (v === undefined || v === '' ? undefined : !['no', 'false', '0'].includes(String(v).trim().toLowerCase()));

/** One row of an attestation sheet -> one PLATO attestation object. */
export function rowToAttestation(sheet, row, ids) {
  const src = ids.source(row.source_id);
  const citation = clean({ source: src, locator: row.locator, attributionStatus: row.attribution ? PLATO + 'Attribution' + row.attribution : undefined,
    citationFunction: row.citation_function ? CITO + row.citation_function : undefined });
  const a = clean({
    // The date column is the date as the source writes it: plato:source_label since PLATO 9d2c36e.
    timespans: [clean({ sourceLabel: row.date, startEarliest: row.from, endLatest: row.to })],
    sources: [src],
    citations: [citation],
    certainty: num(row.certainty),
    certaintyLevel: row.certainty_level ? PLATO + row.certainty_level : undefined,
    negated: denied(row.denied),
    notes: row.notes,
  });
  if (sheet === 'names') {
    const q = clean({ transcriptionAccuracy: row.transcription_accuracy ? PLATO + 'Transcription' + row.transcription_accuracy : undefined,
      transcriptionCompleteness: row.transcription_completeness ? PLATO + 'Transcription' + row.transcription_completeness : undefined });
    a.names = [clean({ toponym: row.name, language: row.language, script: row.script, romanized: row.romanized, nameType: row.name_type ? row.name_type.split(';') : undefined,
      qualification: Object.keys(q).length ? q : undefined })];
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
        timespan: r.date || r.from || r.to ? clean({ sourceLabel: r.date, startEarliest: r.from, endLatest: r.to }) : undefined,
        derivedFrom: r.derived_from ? b + 'source/' + encodeURIComponent(r.derived_from) : undefined,
      });
    },
  };
}

export { ATTESTATION_SHEETS };

// ---- PLATO records -> table rows (lossy; every loss reported) ----------------------------------
// What the tables hold of each PLATO object; every other key present is reported (dropKeys), including
// a key PLATO adds after this was written. Keys the tables hold only in some cases are checked where
// they are written: a form status only on a name row, a vocabulary value only if it is PLATO's own.
export const TABLE_KEEPS = {
  gazetteer: new Set(['version', 'status', 'isVersionOf', 'previousVersion']),   // reported by versionLosses
  spatialEntity: new Set(['@id', 'label', 'ccodes', 'entityIdentifier', 'attestations', 'identityRelations']),
  attestation: new Set(['about', 'names', 'geometries', 'timespans', 'types', 'properties', 'relations', 'sources', 'citations', 'meta', 'certainty', 'certaintyLevel', 'certaintyNote', 'negated', 'notes', 'occurrenceCount', 'occurrenceContext', 'formStatus']),
  name: new Set(['toponym', 'language', 'script', 'romanized', 'nameType', 'sourceLabel', 'qualification']),
  geometry: new Set(['reprPoint', 'geojson', 'wkt', 'role', 'precisionKm', 'sourceLabel', 'qualification']),
  timespan: new Set(['startEarliest', 'startLatest', 'endEarliest', 'endLatest', 'label', 'sourceLabel', 'qualification']),
  type: new Set(['identifier', 'label', 'sourceLabel', 'qualification']),
  propertyValue: new Set(['property', 'label', 'value', 'unit', 'qualification', 'dataSet', 'dimensions', 'attributes', 'universe']),
  source: new Set(['@id', 'title', 'citation', 'uri', 'timespan', 'derivedFrom', 'authorityType']),
  sourceTimespan: new Set(['startEarliest', 'endLatest', 'sourceLabel', 'label']),
  citation: new Set(['source', 'locator', 'attributionStatus', 'citationFunction']),
  relation: new Set(['relatesTo', 'relationType', 'relationLabel']),
  identityRelation: new Set(['subject', 'object', 'identityType', 'certainty', 'basis', 'source', 'assertedBy', 'promotedFrom']),
};
/** Report what the sources sheet cannot hold of a source: called once, when the source gets its row. */
export function sourceLosses(s, loss) {
  if (!s || typeof s !== 'object') return;
  dropKeys(s, 'source', TABLE_KEEPS.source, loss);
  if (s.authorityType && s.authorityType !== 'source') dropKey('source', 'authorityType', loss);
  const ts = s.timespan;
  if (!ts || typeof ts !== 'object') return;
  for (const k of Object.keys(ts)) {
    if (ts[k] === undefined || ts[k] === null) continue;
    if (k === 'qualification' && typeof ts[k] === 'object') { for (const q of Object.keys(ts[k])) if (ts[k][q] !== undefined && ts[k][q] !== null) loss({ kind: 'dropped', key: `source.timespan.qualification.${q}` }); continue; }
    // The date column holds the date as written, or else a period's name: not both.
    if (!TABLE_KEEPS.sourceTimespan.has(k) || (k === 'label' && ts.sourceLabel && ts.sourceLabel !== ts.label)) loss({ kind: 'dropped', key: `source.timespan.${k}` });
  }
}
const GVP_BROADER_PARTITIVE = 'http://vocab.getty.edu/ontology#broaderPartitive';
const LEVELS = new Set(['Certain', 'LessCertain', 'Uncertain']);   // the tables' certainty_level values
const ACCURACY = new Set(['Accurate', 'Inaccurate', 'False']), COMPLETENESS = new Set(['Complete', 'Reconstructable', 'NonReconstructable']);
const local = (iri, prefix) => (iri && iri.startsWith(prefix) ? iri.slice(prefix.length) : null);
/** GeoJSON geometry -> WKT, for the locations sheet's wkt column. */
export function geojsonToWkt(g) {
  const pt = (c) => c.slice(0, 2).join(' ');
  const ring = (r) => '(' + r.map(pt).join(', ') + ')';
  switch (g.type) {
    case 'Point': return `POINT(${pt(g.coordinates)})`;
    case 'MultiPoint': return `MULTIPOINT(${g.coordinates.map((c) => '(' + pt(c) + ')').join(', ')})`;
    case 'LineString': return `LINESTRING${ring(g.coordinates)}`;
    case 'MultiLineString': return `MULTILINESTRING(${g.coordinates.map(ring).join(', ')})`;
    case 'Polygon': return `POLYGON(${g.coordinates.map(ring).join(', ')})`;
    case 'MultiPolygon': return `MULTIPOLYGON(${g.coordinates.map((p) => '(' + p.map(ring).join(', ') + ')').join(', ')})`;
    default: return null;
  }
}
function representativePoint(g) {
  if (!g) return null;
  if (g.type === 'Point') return g.coordinates.slice(0, 2);
  const flat = []; const walk = (c) => (typeof c[0] === 'number' ? flat.push(c) : c.forEach(walk));
  walk(g.coordinates || []);
  if (!flat.length) return null;
  const xs = flat.map((c) => c[0]), ys = flat.map((c) => c[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

/**
 * One PLATO record -> rows for each sheet. `ids.place(iri, label)` and `ids.source(obj)` return
 * short table ids (registering rows for places and sources as needed); `loss(l)` receives what
 * the tables cannot hold. The tables cannot express meta-attestations, so they show the current
 * state: an attestation in `withdrawn` (@id -> 'retracted' | 'superseded'), or withdrawn within
 * the record, gets no row.
 */
export function recordToRows(rec, ids, loss = () => {}, accepts = () => true, withdrawn = null) {
  const rows = { places: [], names: [], locations: [], types: [], relations: [], properties: [], identities: [] };
  const pid = ids.place(rec['@id'], rec.label, true, rec.ccodes, rec.entityIdentifier);
  dropKeys(rec, 'spatialEntity', TABLE_KEEPS.spatialEntity, loss);
  for (const a of currentAttestations(rec, withdrawn, loss)) {
    dropKeys(a, 'attestation', TABLE_KEEPS.attestation, loss);
    const facets = ['names', 'geometries', 'types', 'relations', 'properties'].filter((k) => a[k]?.length);
    // A row states one thing, and its denied column denies that one thing. A denial of several
    // things together ("no market and no fair here") split into rows would deny each of them on its
    // own, which the source did not say; so it is left out whole, and reported.
    const deny = isDenial(a);
    if (deny && facets.reduce((n, k) => n + a[k].length, 0) > 1) { loss({ kind: 'denial-bundled', value: rec['@id'] }); continue; }
    if (facets.length > 1) loss({ kind: 'bundled-attestation', value: facets.join('+') });
    if (!facets.length) { loss({ kind: 'attestation-without-facet' }); continue; }
    const spans = a.timespans || [];
    if (spans.length > 1) loss({ kind: 'extra-timespans', value: spans.length - 1 });
    const t = spans[0] || {};
    qualificationLosses(t.qualification, [], loss);
    dropKeys(t, 'timespan', TABLE_KEEPS.timespan, loss);
    if ((t.startLatest && t.startLatest !== t.startEarliest) || (t.endEarliest && t.endEarliest !== t.endLatest)) loss({ kind: 'four-date-bounds' });
    const srcs = [...(a.sources || []), ...(a.citations || []).map((c) => c.source)].filter(Boolean);
    const unique = [...new Map(srcs.map((s) => [typeof s === 'string' ? s : s['@id'] || s.title, s])).values()];
    if (unique.length > 1) loss({ kind: 'extra-sources', value: unique.length - 1 });
    const src = unique[0] || null;
    if (!src) loss({ kind: 'attestation-without-source' });
    const sid = ids.source(src);
    const cit = (a.citations || []).find((c) => !src || c.source === src || (c.source?.['@id'] && c.source['@id'] === (src['@id'] || src))) || {};
    for (const c of a.citations || []) dropKeys(c, 'citation', TABLE_KEEPS.citation, loss);
    if (t.sourceLabel && t.label && t.sourceLabel !== t.label) loss({ kind: 'period-label', value: t.label });
    const date = t.sourceLabel || t.label || (t.startEarliest || t.endLatest ? [t.startEarliest, t.endLatest].filter(Boolean).join('-') : 'undated');
    const notes = [a.notes, a.certaintyNote && `Certainty: ${a.certaintyNote}`].filter(Boolean).join(' ') || '';
    // Why the source is cited: a CiTO property, written by its local name (citesAsEvidence).
    let citationFunction = local(cit.citationFunction, CITO) || '';
    if (cit.citationFunction && (!citationFunction || !accepts('names', 'citation_function', citationFunction))) { loss({ kind: 'citation-function-not-cito', value: cit.citationFunction }); citationFunction = ''; }
    // How the attribution was made: PLATO's own words (Inferred, for "ibid."), or it is reported.
    let attribution = local(cit.attributionStatus, PLATO + 'Attribution') || '';
    if (cit.attributionStatus && (!attribution || !accepts('names', 'attribution', attribution))) { dropKey('citation', 'attributionStatus', loss); attribution = ''; }
    const common = { place_id: pid, date, from: t.startEarliest || '', to: t.endLatest || '', source_id: sid, locator: cit.locator || '',
      attribution, citation_function: citationFunction, certainty: a.certainty ?? '',
      certainty_level: LEVELS.has(local(a.certaintyLevel, PLATO)) ? local(a.certaintyLevel, PLATO) : '',
      denied: deny ? 'yes' : a.negated === false ? 'no' : '', notes };
    if (a.certaintyLevel && !common.certainty_level) loss({ kind: 'certainty-level', value: a.certaintyLevel });
    if (a.meta) loss(isAlternative(a.meta) ? { kind: 'alternative-readings', value: a['@id'] } : { kind: 'meta-attestation' });
    // A form status, occurrence context and count go on name rows, as PLATO's own words.
    const vocab = (k, col) => { const w = local(a[k], PLATO); if (a[k] && (!w || !accepts('names', col, w))) { dropKey('attestation', k, loss); return ''; } return w || ''; };
    const formStatus = vocab('formStatus', 'form_status'), occurrenceContext = vocab('occurrenceContext', 'occurrence_context');
    if (!a.names?.length) for (const k of ['formStatus', 'occurrenceContext', 'occurrenceCount']) if (a[k] !== undefined && a[k] !== null && (k === 'occurrenceCount' || local(a[k], PLATO))) dropKey('attestation', k, loss);
    for (const n of a.names || []) {
      dropKeys(n, 'name', TABLE_KEEPS.name, loss);
      const q = n.qualification || {};
      qualificationLosses(q, ['transcriptionAccuracy', 'transcriptionCompleteness'], loss);
      if (n.sourceLabel) loss({ kind: 'source-label' });
      // How well the name was read: the names sheet holds PLATO's own judgements, by their words.
      const judged = (iri, words) => { const w = local(iri, PLATO + 'Transcription'); if (iri && !words.has(w)) loss({ kind: 'transcription-value', value: iri }); return words.has(w) ? w : ''; };
      rows.names.push({ place_id: pid, name: n.toponym, language: n.language || '', script: n.script || '', romanized: n.romanized || '',
        name_type: (n.nameType || []).join(';'), form_status: formStatus, occurrence_context: occurrenceContext,
        occurrence_count: a.occurrenceCount ?? '', transcription_accuracy: judged(q.transcriptionAccuracy, ACCURACY),
        transcription_completeness: judged(q.transcriptionCompleteness, COMPLETENESS), ...common, place_id: pid });
    }
    for (const g of a.geometries || []) {
      let p = g.reprPoint || (g.geojson?.type === 'Point' ? g.geojson.coordinates : null);
      if (!p) { p = representativePoint(g.geojson); if (p) loss({ kind: 'point-derived-from-shape' }); }
      if (!p) { loss({ kind: 'geometry-without-coordinates' }); continue; }
      qualificationLosses(g.qualification, [], loss);
      if (g.sourceLabel) loss({ kind: 'source-label' });
      dropKeys(g, 'geometry', TABLE_KEEPS.geometry, loss);
      // A GeoJSON point beside a different representative point has no column of its own.
      if (g.reprPoint && g.geojson?.type === 'Point' && JSON.stringify(g.geojson.coordinates?.slice(0, 2)) !== JSON.stringify(g.reprPoint.slice(0, 2))) dropKey('geometry', 'geojson', loss);
      if ((g.precisionKm || []).length > 1) dropKey('geometry', 'precisionKm', loss);
      let role = local(g.role, PLATO) || '';
      if (g.role && (!role || !accepts('locations', 'geometry_role', role))) { dropKey('geometry', 'role', loss); role = ''; }
      rows.locations.push({ place_id: pid, latitude: p[1], longitude: p[0],
        wkt: g.wkt || (g.geojson && g.geojson.type !== 'Point' ? geojsonToWkt(g.geojson) || '' : ''),
        geometry_role: role, precision_km: (g.precisionKm || [])[0] ?? '', ...common });
    }
    for (const ty of a.types || []) {
      qualificationLosses(ty.qualification, [], loss);
      dropKeys(ty, 'type', TABLE_KEEPS.type, loss);
      if (ty.label && ty.sourceLabel && ty.sourceLabel !== ty.label) loss({ kind: 'source-label' });
    }
    for (const pv of a.properties || []) if (!isFigure(pv)) { qualificationLosses(pv.qualification, [], loss); dropKeys(pv, 'propertyValue', TABLE_KEEPS.propertyValue, loss); }
    for (const ty of a.types || []) rows.types.push({ place_id: pid, type_label: ty.label || ty.sourceLabel || '', type_uri: ty.identifier || '', ...common });
    for (const r of a.relations || []) {
      dropKeys(r, 'relation', TABLE_KEEPS.relation, loss);
      let rt = local(r.relationType, PLATO);
      if (!rt && r.relationType === GVP_BROADER_PARTITIVE) rt = 'ContainedIn';   // the alignment plato:ContainedIn declares
      if (!rt) { loss({ kind: 'relation-type-not-in-plato', value: r.relationType }); continue; }
      if (r.relationLabel) loss({ kind: 'relation-label' });
      rows.relations.push({ place_id: pid, relation_type: rt, related_place_id: ids.place(r.relatesTo, null, false), ...common });
    }
    // A statistical figure keeps its own CSVW description (PLATO issue #14, decision 4): the
    // properties sheet has no columns for its table or coordinates, and without them it says something false.
    for (const pv of a.properties || []) if (isFigure(pv)) loss({ kind: 'statistical-figure', value: pv['@id'] || pv.label || pv.property });
    for (const pv of (a.properties || []).filter((x) => !isFigure(x))) rows.properties.push({ place_id: pid, property_uri: pv.property, property_label: pv.label || '',
      value: typeof pv.value === 'object' ? JSON.stringify(pv.value) : pv.value, unit_uri: pv.unit || '', ...common });
  }
  // Nested under its place, a relation may leave out its subject (PLATO eb8065a): it is the place.
  for (const ir of rec.identityRelations || []) rows.identities.push(identityRow(ir, ids, loss, ir.subject || rec['@id']));
  return rows;
}
export function identityRow(ir, ids, loss = () => {}, subject = ir.subject) {
  dropKeys(ir, 'identityRelation', TABLE_KEEPS.identityRelation, loss);
  if (ir.assertedBy || ir.promotedFrom) loss({ kind: 'identity-provenance' });
  if (!ir.identityType) loss({ kind: 'identity-type-missing' });
  return { place_id: ids.place(subject, null, false), same_as: ir.object, match_type: ir.identityType || '', certainty: ir.certainty ?? '',
    basis: ir.basis || '', source_id: ir.source ? ids.source(ir.source) : '' };
}
