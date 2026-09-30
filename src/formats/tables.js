// PLATO spreadsheet tables (CSV on the Web): validation, tables -> PLATO records, and
// PLATO records -> tables. Everything is driven by the same csv-metadata.json the PLATO
// repository publishes, so column names, required columns and allowed values cannot drift.
//
// Validation follows the CSVW rules the metadata uses, and is tested against the reference
// implementation (rdf-tabular, strict mode) on the same good and broken tables.
import { PLATO } from '../lib/context.js';
import { list, isDenial, isAlternative, qualificationLosses, currentAttestations, isFigure, dropKeys, dropKey, isComputed, isComputedFacet, identityBundleLosses } from './shared.js';

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
    // An xsd:duration (PLATO 0.6.0): P, then at least one of years, months, days, hours, minutes, seconds; no weeks.
    if (base === 'duration' && !/^-?P(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/.test(v)) return `'${v}' is not a duration (write six weeks as P42D)`;
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

const ATTESTATION_SHEETS = ['names', 'locations', 'types', 'relations', 'connections', 'properties'];
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
    timespans: [clean({ sourceLabel: row.date, startEarliest: row.from, endLatest: row.to, duration: row.duration })],   // duration: relations only
    sources: [src],
    citations: [citation],
    certainty: num(row.certainty),
    certaintyLevel: row.certainty_level ? PLATO + row.certainty_level : undefined,
    negated: denied(row.denied),
    // How firmly the source itself says it (plato:source_stance): the tables write the concept's suffix.
    sourceStance: row.stance ? PLATO + 'Stance' + row.stance : undefined,
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
    // The vocabulary the type comes from, and the version used (PLATO 45e4eed).
    a.types = [clean({ identifier: row.type_uri, scheme: row.type_scheme, schemeVersion: row.type_scheme_version, label: row.type_label })];
  } else if (sheet === 'relations') {
    // The target is a place in the places sheet, or something described elsewhere, by its address
    // (PLATO 0.6.0): a person, an object or an event, named by related_label.
    a.relations = [clean({ relatesTo: row.related_place_id ? ids.place(row.related_place_id) : row.related_uri || undefined,
      relatedLabel: row.related_label, relationType: PLATO + row.relation_type })];
    if (row.sequence !== undefined && row.sequence !== '') a.sequence = num(row.sequence);
  } else if (sheet === 'connections') {
    // One link and one figure about it: a single attestation, so the figure is about the connection.
    a.relations = [{ relatesTo: ids.place(row.related_place_id), relationType: PLATO + row.relation_type }];
    a.properties = [propertyValue(row)];
  } else if (sheet === 'properties') {
    a.properties = [propertyValue(row)];
  }
  return a;
}

function propertyValue(row) {
  const v = row.value !== '' && !Number.isNaN(Number(row.value)) ? Number(row.value) : row.value;
  return clean({ property: row.property_uri, label: row.property_label, value: v, unit: row.unit_uri });
}

/**
 * PLATO's rules for the tables that CSVW cannot state, so rdf-tabular does not check them: a relations
 * row names exactly one target, a place or an address; an address has a name to show it by; and no
 * route, itinerary or network is, through its members, a member of itself. Reports through `issue`
 * (errors) and `warn`.
 */
export function checkTableRules(rows, { issue, warn }) {
  const member = new Map();
  let n = 0;
  for (const r of rows('relations')) {
    n++;
    const place = !!r.related_place_id, uri = !!r.related_uri;
    if (place === uri) issue({ table: 'relations.csv', row: n, column: 'related_place_id', message: place ? 'gives both a related place and a related_uri: fill in one of them' : 'gives no related place: fill in related_place_id or related_uri' });
    if (uri && !r.related_label) warn({ table: 'relations.csv', row: n, column: 'related_label', message: 'has a related_uri but no related_label to show it by' });
    if (r.sequence && r.relation_type !== 'MemberOf') warn({ table: 'relations.csv', row: n, column: 'sequence', message: `gives a sequence on a ${r.relation_type} row; a sequence orders the members of a route (MemberOf)` });
    if (r.relation_type === 'MemberOf' && place) (member.get(r.place_id) || member.set(r.place_id, new Set()).get(r.place_id)).add(r.related_place_id);
  }
  return member;
}

// ---- the about sheet: the dataset described (PLATO's FAIR metadata) -----------------------------
// One row: the gazetteer header of the document the tables make. Lists are ';'-separated in a cell.
const parts = (v) => (v ? String(v).split(';').map((x) => x.trim()).filter(Boolean) : []);
const withSlash = (b) => (b.endsWith('/') || b.endsWith('#') ? b : b + '/');
// An id as the last part of an address, as PLATO says: every character other than RFC 3986's
// unreserved ones (letters, digits, - . _ ~) percent-encoded as UTF-8. encodeURIComponent leaves
// ! ' ( ) * as they are, which the tables' own URI templates (RFC 6570) encode.
export const encodeId = (id) => encodeURIComponent(id).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * The about row -> the document's gazetteer. `base` is the address the places and sources are made
 * under; it is the gazetteer's own address when the row gives no dataset_uri, as before the sheet.
 * Addresses in creator become {"@id"} and names in creator_name {"name"}: the tables hold each author
 * as one or the other, since a cell cannot pair them.
 */
export function aboutToGazetteer(row, base, fallbackTitle) {
  return clean({
    '@id': row.dataset_uri || withSlash(base), title: row.title || fallbackTitle, description: row.description, contributor: row.contributor,
    creator: [...parts(row.creator).map((id) => ({ '@id': id })), ...parts(row.creator_name).map((name) => ({ name }))],
    licence: row.licence, version: row.version, status: row.status,
    keywords: parts(row.keywords), spatial: parts(row.spatial),
    temporal: row.temporal_from || row.temporal_to ? clean({ startDate: row.temporal_from, endDate: row.temporal_to }) : undefined,
    landingPage: row.landing_page, uriSpace: row.base_uri,
  });
}

/**
 * PLATO's rules for the about sheet that CSVW cannot state: exactly one row; a licence once the
 * dataset is published (and a warning without one before); and a base_uri, without which the
 * addresses the tools make are not permanent. `rows` is null when the sheet is missing, which
 * validateTables reports. `base` is a base given for this conversion (--base), which wins.
 */
export function checkAboutRules(rows, { issue, warn }, { base } = {}) {
  if (!rows) return;
  if (!rows.length) { issue({ table: 'about.csv', message: 'has no row: give one row describing the dataset, with at least its title' }); return; }
  if (rows.length > 1) issue({ table: 'about.csv', row: 2, message: 'has more than one row: it describes the dataset as a whole, in exactly one row', detail: `has ${rows.length} rows; it describes the dataset as a whole, in exactly one row` });
  const r = rows[0];
  if (!r.licence && r.status === 'published') issue({ table: 'about.csv', row: 1, column: 'licence', message: "is empty, but status is 'published': a published dataset must state its licence" });
  else if (!r.licence) warn({ table: 'about.csv', row: 1, column: 'licence', message: "is empty: say under what licence others may reuse the dataset (it is required once status is 'published')" });
  if (!r.base_uri) warn({ table: 'about.csv', row: 1, column: 'base_uri', message: base
    ? 'is empty, so the addresses of places and sources are made from the base given for this conversion, which the tables do not record: they will not be permanent unless the same base is given every time; give it as base_uri'
    : 'is empty, so the addresses of places and sources are made from a stand-in base and will not be permanent: give a base address you control' });
  else if (base && withSlash(base) !== withSlash(r.base_uri)) warn({ table: 'about.csv', row: 1, column: 'base_uri', message: 'differs from the base given for this conversion, which is used instead: the addresses of places and sources are not the ones the tables declare',
    detail: `is ${r.base_uri}, but ${base} was given for this conversion and is used instead` });
}

/**
 * The document's gazetteer -> the about row (aboutToGazetteer's inverse). A value its column cannot
 * hold (a contributor named in words, a list item containing ';') is left out and reported, and so
 * is every key the sheet has no column for (dropKeys). An author with both an address and a name
 * keeps the address, as the creator column holds one or the other.
 */
export function gazetteerToAbout(g, loss = () => {}, accepts = () => true) {
  g = g && typeof g === 'object' && !Array.isArray(g) ? g : {};
  dropKeys(g, 'gazetteer', TABLE_KEEPS.gazetteer, loss);
  const bad = (key, v) => loss({ kind: 'about-value', value: `${key}: ${typeof v === 'string' ? v : JSON.stringify(v)}` });
  const cell = (key, col, v) => {
    if (v === undefined || v === null || v === '') return '';
    if ((typeof v === 'string' || typeof v === 'number') && !String(v).includes('\n') && accepts('about', col, String(v))) return String(v);
    bad(key, v); return '';
  };
  const column = (key, col, vs) => (Array.isArray(vs) ? vs : vs === undefined || vs === null ? [] : [vs])
    .filter((v) => { const ok = typeof v === 'string' && v.trim() !== '' && !v.includes(';') && v === v.trim() && accepts('about', col, v); if (!ok && v !== null && v !== undefined) bad(key, v); return ok; }).join(';');
  const addresses = [], names = [];
  for (const c of Array.isArray(g.creator) ? g.creator : g.creator === undefined || g.creator === null ? [] : [g.creator]) {
    if (c && typeof c === 'object' && typeof c['@id'] === 'string') {
      addresses.push(c['@id']);
      if (c.name !== undefined && c.name !== null) loss({ kind: 'creator-name', value: `${c['@id']}: ${c.name}` });
    } else if (c && typeof c === 'object' && typeof c.name === 'string') names.push(c.name);
    else bad('creator', c);
  }
  const t = g.temporal && typeof g.temporal === 'object' ? g.temporal : {};
  if (g.temporal !== undefined && g.temporal !== null && typeof g.temporal !== 'object') bad('temporal', g.temporal);
  dropKeys(t, 'temporal', new Set(['startDate', 'endDate']), loss);
  return {
    title: cell('title', 'title', g.title), description: cell('description', 'description', g.description),
    creator: column('creator', 'creator', addresses), creator_name: column('creator', 'creator_name', names),
    contributor: cell('contributor', 'contributor', g.contributor), licence: cell('licence', 'licence', g.licence),
    version: cell('version', 'version', g.version), status: cell('status', 'status', g.status),
    keywords: column('keywords', 'keywords', g.keywords), spatial: column('spatial', 'spatial', g.spatial),
    temporal_from: cell('temporal.startDate', 'temporal_from', t.startDate), temporal_to: cell('temporal.endDate', 'temporal_to', t.endDate),
    landing_page: cell('landingPage', 'landing_page', g.landingPage), dataset_uri: cell('@id', 'dataset_uri', g['@id']),
    base_uri: cell('uriSpace', 'base_uri', g.uriSpace),
  };
}

/** Identifier minting for tables: a base address the user chooses, plus the table's own ids. */
export function tableIds(base, sourcesById) {
  const b = base.endsWith('/') || base.endsWith('#') ? base : base + '/';
  return {
    place: (id) => b + 'place/' + encodeId(id),
    sourceIri: (id) => b + 'source/' + encodeId(id),
    source(id, seen = new Set()) {
      const r = sourcesById(id);
      if (!r) return b + 'source/' + encodeId(id);
      // The source it derives from is written in full, as PLATO JSON allows, so that a source cited only
      // as another's original keeps its title and citation; a loop of derivations stops at an address.
      seen.add(id);
      const from = !r.derived_from ? undefined : seen.has(r.derived_from) || !sourcesById(r.derived_from)
        ? b + 'source/' + encodeId(r.derived_from) : this.source(r.derived_from, seen);
      return clean({
        '@id': b + 'source/' + encodeId(id), title: r.title, citation: r.citation, uri: r.uri, authorityType: 'source',
        timespan: r.date || r.from || r.to ? clean({ sourceLabel: r.date, startEarliest: r.from, endLatest: r.to }) : undefined,
        derivedFrom: from,
        licence: r.licence,
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
  // The about sheet (gazetteerToAbout); isVersionOf and previousVersion have no column, so are reported.
  gazetteer: new Set(['@id', 'title', 'description', 'contributor', 'creator', 'licence', 'version', 'status', 'keywords', 'spatial', 'temporal', 'landingPage', 'uriSpace']),
  spatialEntity: new Set(['@id', 'label', 'ccodes', 'entityIdentifier', 'attestations', 'identityRelations']),
  attestation: new Set(['about', 'names', 'geometries', 'timespans', 'types', 'properties', 'relations', 'sources', 'citations', 'meta', 'certainty', 'certaintyLevel', 'certaintyNote', 'negated', 'sourceStance', 'notes', 'occurrenceCount', 'occurrenceContext', 'formStatus', 'sequence', 'computed', 'identities']),
  name: new Set(['toponym', 'language', 'script', 'romanized', 'nameType', 'sourceLabel', 'qualification']),
  geometry: new Set(['reprPoint', 'geojson', 'wkt', 'role', 'precisionKm', 'sourceLabel', 'qualification']),
  timespan: new Set(['startEarliest', 'startLatest', 'endEarliest', 'endLatest', 'label', 'sourceLabel', 'qualification', 'duration']),
  type: new Set(['identifier', 'scheme', 'schemeVersion', 'label', 'sourceLabel', 'qualification']),
  propertyValue: new Set(['property', 'label', 'value', 'unit', 'qualification', 'dataSet', 'dimensions', 'attributes', 'universe']),
  source: new Set(['@id', 'title', 'citation', 'uri', 'timespan', 'derivedFrom', 'licence', 'authorityType']),
  sourceTimespan: new Set(['startEarliest', 'endLatest', 'sourceLabel', 'label']),
  citation: new Set(['source', 'locator', 'attributionStatus', 'citationFunction']),
  relation: new Set(['relatesTo', 'relatedLabel', 'relationType', 'relationLabel']),
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
// PLATO's relations to people, objects and events, and to images and records about a place (DepictedIn,
// SubjectOf): their target is described elsewhere, not a place, so it goes to related_uri.
const EXTERNAL = new Set(['BirthplaceOf', 'DeathplaceOf', 'ResidenceOf', 'FindspotOf', 'SettingOf', 'WorkplaceOf', 'DepictedIn', 'SubjectOf']);
const LEVELS = new Set(['Certain', 'LessCertain', 'Uncertain']);   // the tables' certainty_level values
const ACCURACY = new Set(['Accurate', 'Inaccurate', 'False']), COMPLETENESS = new Set(['Complete', 'Reconstructable', 'NonReconstructable']);
// A position's first two coordinates, or nothing when the coordinates are not a list.
const firstTwo = (c) => (Array.isArray(c) ? c.slice(0, 2) : undefined);
const local = (iri, prefix) => (iri && iri.startsWith(prefix) ? iri.slice(prefix.length) : null);
/** GeoJSON geometry -> WKT, for the locations sheet's wkt column. */
export function geojsonToWkt(g) {
  const pt = (c) => c.slice(0, 2).join(' ');
  const ring = (r) => '(' + r.map(pt).join(', ') + ')';
  if (!Array.isArray(g.coordinates)) return null;   // a GeometryCollection, or coordinates that are not a list
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
  if (g.type === 'Point') return Array.isArray(g.coordinates) ? g.coordinates.slice(0, 2) : null;
  const flat = []; const walk = (c) => (typeof c?.[0] === 'number' ? flat.push(c) : list(c).forEach(walk));
  walk(g.coordinates);
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
  const rows = { places: [], names: [], locations: [], types: [], relations: [], connections: [], properties: [], identities: [] };
  const pid = ids.place(rec['@id'], rec.label, true, rec.ccodes, rec.entityIdentifier);
  dropKeys(rec, 'spatialEntity', TABLE_KEEPS.spatialEntity, loss);
  for (const whole of currentAttestations(rec, withdrawn, loss)) {
    // A computed value (plato:computed) is not evidence, and a row in the tables states evidence: a
    // computed attestation or facet is left out, and reported, never written as a source's statement.
    if (isComputed(whole)) { loss({ kind: 'computed', value: whole['@id'] || rec['@id'] }); continue; }
    const a = { ...whole };
    for (const k of ['names', 'geometries', 'types', 'properties', 'timespans']) {
      if (!Array.isArray(a[k]) || !a[k].some(isComputedFacet)) continue;
      loss({ kind: 'computed', value: `${whole['@id'] || rec['@id']} (${k})` });
      a[k] = a[k].filter((f) => !isComputedFacet(f));
    }
    dropKeys(a, 'attestation', TABLE_KEEPS.attestation, loss);
    // A connection with figures about it goes to the connections sheet, one row for each figure; a
    // relations row and a properties row would state the figure of the place, not of the connection.
    const rt0 = a.relations?.length === 1 ? local(a.relations[0].relationType, PLATO) : null;
    const connection = !!rt0 && accepts('connections', 'relation_type', rt0) && list(a.properties).some((pv) => !isFigure(pv));
    const facets = ['names', 'geometries', 'types', connection ? null : 'relations', 'properties'].filter((k) => k && a[k]?.length);
    if (a.sequence !== undefined && a.sequence !== null && (!a.relations?.length || connection)) dropKey('attestation', 'sequence', loss);
    // A row states one thing, and its denied column denies that one thing. A denial of several
    // things together ("no market and no fair here") split into rows would deny each of them on its
    // own, which the source did not say; so it is left out whole, and reported.
    const deny = isDenial(a);
    // Identities the attestation bundles have no row: the identities sheet states a match on its own
    // (identityBundleLosses). A denial that bundles them denies them with its facets, so nothing of
    // it can be written: its facets alone would be denied on their own.
    const bundled = identityBundleLosses(a, rec['@id'], loss);
    if (deny && bundled) continue;
    if (deny && facets.reduce((n, k) => n + a[k].length, 0) > 1) { loss({ kind: 'denial-bundled', value: rec['@id'] }); continue; }
    if (facets.length > 1) loss({ kind: 'bundled-attestation', value: facets.join('+') });
    if (!facets.length) { if (!bundled) loss({ kind: 'attestation-without-facet' }); continue; }
    const spans = list(a.timespans);
    if (spans.length > 1) loss({ kind: 'extra-timespans', value: spans.length - 1 });
    const t = spans[0] || {};
    qualificationLosses(t.qualification, [], loss);
    dropKeys(t, 'timespan', TABLE_KEEPS.timespan, loss);
    if ((t.startLatest && t.startLatest !== t.startEarliest) || (t.endEarliest && t.endEarliest !== t.endLatest)) loss({ kind: 'four-date-bounds' });
    // Only the relations sheet has a duration column: a stay at a stop on a journey.
    if (t.duration && (!a.relations?.length || connection)) dropKey('timespan', 'duration', loss);
    const srcs = [...list(a.sources), ...list(a.citations).map((c) => c.source)].filter(Boolean);
    const unique = [...new Map(srcs.map((s) => [typeof s === 'string' ? s : s['@id'] || s.title, s])).values()];
    if (unique.length > 1) loss({ kind: 'extra-sources', value: unique.length - 1 });
    const src = unique[0] || null;
    if (!src) loss({ kind: 'attestation-without-source' });
    const sid = ids.source(src);
    const cit = list(a.citations).find((c) => !src || c.source === src || (c.source?.['@id'] && c.source['@id'] === (src['@id'] || src))) || {};
    for (const c of list(a.citations)) dropKeys(c, 'citation', TABLE_KEEPS.citation, loss);
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
      denied: deny ? 'yes' : a.negated === false ? 'no' : '', stance: '', notes };
    if (a.certaintyLevel && !common.certainty_level) loss({ kind: 'certainty-level', value: a.certaintyLevel });
    // The source's own stance: PLATO's own words (Reported, Tentative, Doubted, Asserted), or it is reported.
    const stance = local(a.sourceStance, PLATO + 'Stance');
    if (a.sourceStance) { if (stance && accepts('names', 'stance', stance)) common.stance = stance; else dropKey('attestation', 'sourceStance', loss); }
    if (a.meta) loss(isAlternative(a.meta) ? { kind: 'alternative-readings', value: a['@id'] } : { kind: 'meta-attestation' });
    // A form status, occurrence context and count go on name rows, as PLATO's own words.
    const vocab = (k, col) => { const w = local(a[k], PLATO); if (a[k] && (!w || !accepts('names', col, w))) { dropKey('attestation', k, loss); return ''; } return w || ''; };
    const formStatus = vocab('formStatus', 'form_status'), occurrenceContext = vocab('occurrenceContext', 'occurrence_context');
    if (!a.names?.length) for (const k of ['formStatus', 'occurrenceContext', 'occurrenceCount']) if (a[k] !== undefined && a[k] !== null && (k === 'occurrenceCount' || local(a[k], PLATO))) dropKey('attestation', k, loss);
    for (const n of list(a.names)) {
      dropKeys(n, 'name', TABLE_KEEPS.name, loss);
      const q = n.qualification || {};
      qualificationLosses(q, ['transcriptionAccuracy', 'transcriptionCompleteness'], loss);
      if (n.sourceLabel) loss({ kind: 'source-label' });
      // How well the name was read: the names sheet holds PLATO's own judgements, by their words.
      const judged = (iri, words) => { const w = local(iri, PLATO + 'Transcription'); if (iri && !words.has(w)) loss({ kind: 'transcription-value', value: iri }); return words.has(w) ? w : ''; };
      rows.names.push({ place_id: pid, name: n.toponym, language: n.language || '', script: n.script || '', romanized: n.romanized || '',
        name_type: list(n.nameType).join(';'), form_status: formStatus, occurrence_context: occurrenceContext,
        occurrence_count: a.occurrenceCount ?? '', transcription_accuracy: judged(q.transcriptionAccuracy, ACCURACY),
        transcription_completeness: judged(q.transcriptionCompleteness, COMPLETENESS), ...common, place_id: pid });
    }
    for (const g of list(a.geometries)) {
      let p = g.reprPoint || (g.geojson?.type === 'Point' ? g.geojson.coordinates : null);
      if (!p) { p = representativePoint(g.geojson); if (p) loss({ kind: 'point-derived-from-shape' }); }
      if (!p) { loss({ kind: 'geometry-without-coordinates' }); continue; }
      qualificationLosses(g.qualification, [], loss);
      if (g.sourceLabel) loss({ kind: 'source-label' });
      dropKeys(g, 'geometry', TABLE_KEEPS.geometry, loss);
      // A GeoJSON point beside a different representative point has no column of its own.
      if (g.reprPoint && g.geojson?.type === 'Point' && JSON.stringify(firstTwo(g.geojson.coordinates)) !== JSON.stringify(firstTwo(g.reprPoint))) dropKey('geometry', 'geojson', loss);
      if (list(g.precisionKm).length > 1) dropKey('geometry', 'precisionKm', loss);
      let role = local(g.role, PLATO) || '';
      if (g.role && (!role || !accepts('locations', 'geometry_role', role))) { dropKey('geometry', 'role', loss); role = ''; }
      rows.locations.push({ place_id: pid, latitude: p[1], longitude: p[0],
        wkt: g.wkt || (g.geojson && g.geojson.type !== 'Point' ? geojsonToWkt(g.geojson) || '' : ''),
        geometry_role: role, precision_km: list(g.precisionKm)[0] ?? '', ...common });
    }
    for (const ty of list(a.types)) {
      qualificationLosses(ty.qualification, [], loss);
      dropKeys(ty, 'type', TABLE_KEEPS.type, loss);
      if (ty.label && ty.sourceLabel && ty.sourceLabel !== ty.label) loss({ kind: 'source-label' });
    }
    for (const pv of list(a.properties)) if (!isFigure(pv)) { qualificationLosses(pv.qualification, [], loss); dropKeys(pv, 'propertyValue', TABLE_KEEPS.propertyValue, loss); }
    for (const ty of list(a.types)) rows.types.push({ place_id: pid, type_label: ty.label || ty.sourceLabel || '', type_uri: ty.identifier || '',
      type_scheme: ty.scheme || '', type_scheme_version: ty.schemeVersion ?? '', ...common });
    for (const r of list(a.relations)) {
      dropKeys(r, 'relation', TABLE_KEEPS.relation, loss);
      let rt = local(r.relationType, PLATO);
      if (!rt && r.relationType === GVP_BROADER_PARTITIVE) rt = 'ContainedIn';   // the alignment plato:ContainedIn declares
      if (!rt || !accepts('relations', 'relation_type', rt)) { loss({ kind: 'relation-type-not-in-plato', value: r.relationType }); continue; }
      if (r.relationLabel) loss({ kind: 'relation-label' });
      if (connection) {
        for (const pv of a.properties.filter((x) => !isFigure(x))) rows.connections.push({ place_id: pid, relation_type: rt, related_place_id: ids.place(r.relatesTo, null, false),
          property_uri: pv.property, property_label: pv.label || '', value: typeof pv.value === 'object' ? JSON.stringify(pv.value) : pv.value, unit_uri: pv.unit || '', ...common });
        continue;
      }
      // A target named by related_label, or related by a relation to people, objects or events, is
      // not a place in the places sheet: it goes to related_uri, and gets no row of its own.
      const external = !!r.relatedLabel || EXTERNAL.has(rt);
      rows.relations.push({ place_id: pid, relation_type: rt, related_place_id: external ? '' : ids.place(r.relatesTo, null, false),
        related_uri: external ? r.relatesTo : '', related_label: external ? r.relatedLabel || '' : '', sequence: a.sequence ?? '', duration: t.duration || '', ...common });
    }
    // A statistical figure keeps its own CSVW description (PLATO issue #14, decision 4): the
    // properties sheet has no columns for its table or coordinates, and without them it says something false.
    for (const pv of list(a.properties)) if (isFigure(pv)) loss({ kind: 'statistical-figure', value: pv['@id'] || pv.label || pv.property });
    if (!connection) for (const pv of list(a.properties).filter((x) => !isFigure(x))) rows.properties.push({ place_id: pid, property_uri: pv.property, property_label: pv.label || '',
      value: typeof pv.value === 'object' ? JSON.stringify(pv.value) : pv.value, unit_uri: pv.unit || '', ...common });
  }
  // Nested under its place, a relation may leave out its subject (PLATO eb8065a): it is the place.
  for (const ir of list(rec.identityRelations)) rows.identities.push(identityRow(ir, ids, loss, ir.subject || rec['@id']));
  return rows;
}
export function identityRow(ir, ids, loss = () => {}, subject = ir.subject) {
  dropKeys(ir, 'identityRelation', TABLE_KEEPS.identityRelation, loss);
  if (ir.assertedBy || ir.promotedFrom) loss({ kind: 'identity-provenance' });
  if (!ir.identityType) loss({ kind: 'identity-type-missing' });
  return { place_id: ids.place(subject, null, false), same_as: ir.object, match_type: ir.identityType || '', certainty: ir.certainty ?? '',
    basis: ir.basis || '', source_id: ir.source ? ids.source(ir.source) : '' };
}
