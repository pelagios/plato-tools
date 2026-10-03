// Reading an ordinary table of places (a CSV file, or the properties of plain GeoJSON features):
// which column holds what, guessed from the column names and a few of their values, and each row
// read through that mapping into one PLATO attestation.
//
// The mapping is a JSON object, { "column name": field }, where field is one of FIELDS' keys,
// "note" (kept in the attestation's notes as "column: value") or "skip" (not carried over, and
// reported by name). Every column goes to exactly one of these. A field may also be given as an
// object, { "field": "address", "pattern": "https://pleiades.stoa.org/places/{id}" }: a column of a
// gazetteer's ids, from which each place's address is made through the pattern (addresses.js,
// addressFromPattern). resolveColumns gives the fields as strings (`mapping`) and the patterns beside
// them (`patterns`); mappingToSave puts the two back into the one JSON object. A column that is not recognised is
// kept in the notes, never put in `properties`: a property would claim the source said something
// PLATO defines, when all that is known is that a column had that heading. The mapping and the
// reasons are made with no prototype (Object.create(null)), so that a column called "__proto__" or
// "constructor" is a column like any other, and only FIELDS' and OTHER's own keys are fields.
//
// The shapes are those of the spreadsheet tables (src/formats/tables.js, rowToAttestation) wherever
// the tables have one: a latitude and longitude become a location exactly as the locations sheet's
// do, a date column is the date as the source writes it, a start and end the earliest start and
// latest end, a type column a type's label (and its identifier, when it is a web address).
import { isAbsoluteIri } from '../../lib/context.js';
import { placeAddress, addressNote, addressFromPattern, patternProblem, patternId, GAZETTEER_PATTERNS } from './addresses.js';
import { withinNote } from './within.js';
import { parseGridRef, gridRefToWgs84, looksLikeGridRef } from './gridref.js';

/** What each field of the mapping means, and whether one column only may be mapped to it. */
export const FIELDS = {
  name: { single: true, words: "the place's name: its label, and a name the file attests" },
  alternativeNames: { single: false, words: 'other names for the place; several in one cell are separated by ; or |' },
  latitude: { single: true, words: 'latitude, in decimal degrees' },
  longitude: { single: true, words: 'longitude, in decimal degrees' },
  wkt: { single: true, words: 'a point or shape in Well-Known Text (WKT)' },
  geometry: { single: true, words: 'a GeoJSON geometry, written out in the cell' },
  gridref: { single: true, words: 'a grid reference of the Ordnance Survey National Grid (TQ 33760 80560) or the Irish Grid (O 15 34), read as the centre of its square' },
  id: { single: true, words: "the place's own identifier in the file, from which its web address is made" },
  address: { single: true, words: "the place's web address in a gazetteer (Wikidata, Pleiades, GeoNames, the World Historical Gazetteer…): each row is then evidence about that place" },
  type: { single: false, words: 'what kind of place it is; several in one cell are separated by ; or |' },
  language: { single: true, words: 'the language of the name, as a code such as en, la or grc' },
  source: { single: false, words: 'the source the row comes from: a title, or a web address' },
  date: { single: true, words: 'the date as the source writes it' },
  start: { single: true, words: 'the earliest date: a year (such as -0500 or 1066) or an ISO date' },
  end: { single: true, words: 'the latest date: a year (such as -0500 or 1066) or an ISO date' },
  within: { single: false, words: 'a region the place lies in (a parish, a county, a country…), with its level: 1 for the widest, then 2, 3…; given as {"field": "within", "level": 2}' },
  split: { single: false, words: 'several regions in one cell, narrowest first, such as "Rotherhithe, Surrey, England": split on a separator into levels, given as {"field": "split", "separator": ", ", "levels": [3, 2, 1], "firstIsName": true}' },
};
export const OTHER = { note: 'kept in the notes, as "column: value"', skip: 'not carried over; the report says so' };

/**
 * Each kind the reader reports, and how: 'loss' (not carried into PLATO), 'warning' (carried, but
 * worth a look) or 'error'. The words for each are in src/engine/report.js (LOSS_TEXT).
 */
export const GENERIC_KINDS = {
  'generic-column-skipped': 'loss',
  'generic-coordinate-missing': 'loss',
  'generic-coordinate-not-number': 'loss',
  'generic-coordinate-range': 'loss',
  'generic-geometry-collection': 'loss',
  'generic-geometry-invalid': 'loss',
  'generic-wkt-invalid': 'loss',
  'generic-gridref-invalid': 'loss',
  'generic-gridref-disagrees': 'warning',
  'generic-date-invalid': 'loss',
  'generic-language-invalid': 'loss',
  'generic-row-empty': 'loss',
  'generic-row-no-name': 'loss',
  'generic-no-address': 'loss',
  'generic-address-not-web': 'loss',
  'generic-whg-record': 'loss',
  'generic-whg-staging': 'loss',
  'address-not-a-place': 'loss',
  'generic-id-shape': 'loss',
  'generic-same-id-empty': 'loss',
  'generic-feature-key': 'loss',
  'generic-not-feature': 'loss',
  'generic-csv-extra-cells': 'loss',
  'generic-csv-row': 'warning',
  'address-pleiades-part': 'warning',
  'address-web-page': 'warning',
  'generic-csv-duplicate-header': 'warning',
  'generic-no-ids': 'warning',
  'generic-id-empty': 'warning',
  'generic-same-id-label': 'warning',
  'generic-stand-in-base': 'warning',
  'generic-mapping-missing-column': 'warning',
  'generic-mapping-unknown-column': 'warning',
  'generic-mapping': 'error',
  'generic-within-same-level': 'warning',
  'generic-within-no-base': 'warning',
  'generic-split-extra-parts': 'loss',
  'generic-nothing-converted': 'error',
  'generic-features-not-list': 'error',
  'generic-empty': 'warning',
  // A sheet of a workbook read as a table of places (generic.js, openSheet).
  'generic-sheets-not-read': 'warning',
  'generic-sheet-hidden': 'warning',
  'generic-sheet-empty': 'error',
  'generic-sheet-formula-no-value': 'loss',
  'generic-sheet-error-cell': 'loss',
  'workbook-whole': 'warning',
};

/** The name of the column that stands for a GeoJSON feature's own id (its `id` member, not a property). */
export const FEATURE_ID = '(feature id)';

/** A column heading reduced for matching: case, accents, spaces and punctuation do not count. */
export const normaliseHeader = (h) => String(h).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Column headings, normalised, and the field each reads as (item, itemLabel and coord are the
// Wikidata Query Service's). An address column counts only if enough
// of its values are web addresses; a coordinate only if one of its values is a number.
const HEADINGS = {
  name: ['name', 'placename', 'toponym', 'title', 'label', 'placelabel', 'placetitle', 'nametoponym', 'itemlabel'],
  alternativeNames: ['alternativenames', 'alternativename', 'alternatenames', 'alternatename', 'altnames', 'altname', 'names', 'variants', 'variantnames', 'variantname', 'namevariants', 'othernames', 'aliases', 'alias', 'alsoknownas', 'aka'],
  latitude: ['lat', 'latitude', 'y', 'reprlat', 'latdd', 'decimallatitude', 'latwgs84'],
  longitude: ['lon', 'lng', 'long', 'longitude', 'x', 'reprlong', 'reprlon', 'londd', 'longdd', 'decimallongitude', 'lonwgs84', 'longwgs84'],
  id: ['id', 'identifier', 'placeid', 'featureid', 'localid', 'recordid'],
  address: ['uri', 'url', 'iri', 'link', 'placeuri', 'placeurl', 'placeiri', 'wikidata', 'pleiades', 'geonames', 'whg', 'tgn', 'item'],
  type: ['type', 'types', 'featuretype', 'featuretypes', 'placetype', 'placetypes', 'category', 'categories', 'class', 'fclass', 'featureclass', 'featurecode', 'fcode', 'kind'],
  language: ['language', 'lang', 'languagecode', 'langcode', 'namelanguage', 'namelang'],
  source: ['source', 'sources', 'citation', 'citations', 'reference', 'references', 'bibliography', 'ref', 'bibref'],
  date: ['date', 'dates', 'period', 'when', 'datelabel', 'year'],
  start: ['start', 'from', 'startdate', 'begin', 'begindate', 'mindate', 'earliest', 'notbefore', 'datefrom', 'fromdate', 'yearfrom', 'fromyear', 'startyear'],
  end: ['end', 'to', 'enddate', 'maxdate', 'latest', 'notafter', 'dateto', 'todate', 'yearto', 'toyear', 'endyear', 'until'],
  wkt: ['wkt', 'geowkt', 'geometrywkt', 'wktgeometry', 'shapewkt', 'coord', 'coords', 'coordinates'],
  geometry: ['geometry', 'geom', 'geojson', 'thegeom', 'shape'],
  gridref: ['gridref', 'gridrefs', 'gridreference', 'gridreferences', 'ngr', 'osngr', 'osgb', 'osgb36', 'osgrid', 'osgridref', 'osgridreference', 'osref', 'bng', 'britishnationalgrid', 'nationalgrid', 'nationalgridref', 'nationalgridreference', 'irishgrid', 'irishgridref', 'irishgridreference', 'igr'],
};
const BY_HEADING = new Map(Object.entries(HEADINGS).flatMap(([f, hs]) => hs.map((h) => [h, f])));
// A gazetteer's name at the start of a heading (wikidata_uri, pleiades_url, geonames_id) reads as an address column.
// GeoNames' own heading for its id is geonameid (geoname_id), without the s.
const GAZETTEER_PREFIX = /^(wikidata|pleiades|geonames?|whg|tgn|gazetteer)/;
const ADDRESS_SUFFIX = /(uri|url|iri)$/;
// A heading, normalised, that names a gazetteer or a web address: every address heading but "link".
const namesGazetteer = (n) => GAZETTEER_PREFIX.test(n) || ADDRESS_SUFFIX.test(n);
/** The columns whose headings name a gazetteer or a web address (uri, wikidata, geonames_id…), which the page and the command line warn of when none is the address. */
export const gazetteerColumns = (headers, headerText = {}) => headers.filter((h) => h !== FEATURE_ID && namesGazetteer(normaliseHeader(Object.hasOwn(headerText, h) ? headerText[h] : h)));

export const isWebAddress = (s) => typeof s === 'string' && /^https?:\/\/\S+$/i.test(s.trim()) && isAbsoluteIri(s.trim());
// A value that names a place's address: a web address, or a form addresses.js rewrites into one
// (WHG's place:<ns>:<id>). A bare number, or whg:<n>, is neither, and is never expanded.
const namesAddress = (s) => { const p = placeAddress(s); return isWebAddress(p.lost ? p.value : p.iri); };
// What placeAddress (addresses.js) says of an address that must not be carried, as a kind here.
const lostKind = (lost) => (lost === 'address-not-a-place' ? lost : lost === 'whg-staging' ? 'generic-whg-staging' : 'generic-whg-record');
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const isNumber = (s) => NUMBER.test(s);
const FIELD_WORDS = {
  name: "the place's name", alternativeNames: 'other names', latitude: 'latitude', longitude: 'longitude', wkt: 'Well-Known Text', geometry: 'a geometry',
  gridref: 'a grid reference',
  id: 'an identifier', address: "the place's web address", type: 'a type', language: 'a language', source: 'a source', date: 'a date', start: 'a start date', end: 'an end date',
  within: 'a region the place lies in', split: 'several regions in one cell',
};

// ---- containing regions ("within") ------------------------------------------------------------------
// The kind of region a heading names, ranked widest first by World Historical Gazetteer's own ranks
// (whg3's reconciliation.js, ADMIN_RANK: country 0, region 10, county 20, district 30, hundred 40,
// diocese 42, deanery 43, parish 45), so that a district sits above a hundred. The rank only orders
// the guess: the levels are positional (within.js), the "within" columns numbered 1 (the widest) to n.
// A country column is the widest region; it stays a "within" level here (a gazetteer lookup may send
// it as a country filter; that is Krisis's to decide, not the reader's).
const REGION_KINDS = [
  { rank: 0, words: 'a country', test: /^(country|nation)(name|label)?$/ },
  { rank: 10, words: 'a region, state or province', test: /^(region|state|province|land)(name|label)?$/ },
  { rank: 20, words: 'a county, shire or department', test: /^(county|shire|department|departement|oblast)(name|label)?$/ },
  { rank: 30, words: 'a district', test: /^(district|arrondissement)(name|label)?$/ },
  { rank: 40, words: 'a hundred or wapentake', test: /^(hundred|wapentake)(name|label)?$/ },
  { rank: 42, words: 'a diocese', test: /^diocese(name|label)?$/ },
  { rank: 43, words: 'a deanery', test: /^deanery(name|label)?$/ },
  { rank: 45, words: 'a parish, township or commune', test: /^(parish|civilparish|ecclesiasticalparish|township|commune|municipality)(name|label)?$/ },
  // The region the place lies in, of no named kind: the narrowest, after every named kind.
  { rank: 50, words: 'the region the place lies in', test: /^(containedin|within|partof|parent|parentplace|broader|locatedin|isin)(name|label)?$/ },
];
// GeoNames' and gazetteers' administrative levels (admin1, adm2): level 0 is the country, each next
// level one narrower, on the same ranks (adm1 a region, adm2 a county, adm3 a district, adm4 a hundred).
const ADMIN_LEVEL = /^adm(?:in)?([0-4])(name|label)?$/;
/** The kind of region a normalised heading names, as { rank, words }, or undefined. */
function regionKind(n) {
  const a = ADMIN_LEVEL.exec(n);
  if (a) return { rank: Number(a[1]) * 10, words: `administrative level ${a[1]}` };
  return REGION_KINDS.find((k) => k.test.test(n));
}
const isLevel = (l) => Number.isInteger(l) && l >= 1;
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

/** A cell as text: '' for nothing; a number or true/false as written; a list or object as JSON. */
export function cellText(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
/** A cell as a list of values: a JSON list's items, or the text split on ; or |. */
function cellList(v) {
  if (Array.isArray(v)) return v.map(cellText).filter(Boolean);
  return cellText(v).split(/[;|]/).map((s) => s.trim()).filter(Boolean);
}
function geometryLike(s) {
  try { const g = JSON.parse(s); return !!g && typeof g === 'object' && typeof g.type === 'string'; } catch { return false; }
}

const isField = (f) => typeof f === 'string' && (Object.hasOwn(FIELDS, f) || Object.hasOwn(OTHER, f));
const single = (f) => Object.hasOwn(FIELDS, f) && FIELDS[f].single;

// A heading, normalised, that names one of the gazetteers whose addresses are made from ids.
const PATTERN_GAZETTEER = /^(pleiades|geonames?|wikidata)/;
const gazetteerNamed = (n) => { const g = PATTERN_GAZETTEER.exec(n)?.[1]; return g === 'geoname' ? 'geonames' : g; };
// An id of a gazetteer in a value: its ids' shape, or (Pleiades) its path, /places/<n> (patternId).
const fitsGazetteer = (g, v) => GAZETTEER_PATTERNS[g].shape.test(patternId(v, GAZETTEER_PATTERNS[g].pattern));
const GAZETTEER_WORDS = { pleiades: 'Pleiades', geonames: 'GeoNames', wikidata: 'Wikidata' };

/**
 * Guess which column holds what, from the headings and a few rows. Returns { mapping, patterns,
 * suggested, reasons, gazetteer }: the mapping as described at the top of this file (fields as
 * strings), `patterns` (none: a guess never makes an address from an id), and for each column a
 * reason in words, which the page shows beside its guess and the command line prints, and the
 * columns whose headings name a gazetteer (gazetteerColumns). `suggested[column]` is
 * { field: 'address', pattern, gazetteer, fit, sampled } for a column whose heading names Pleiades,
 * GeoNames or Wikidata and at least half of whose sampled values (`fit` of `sampled`) have the shape
 * of that gazetteer's ids, when no column is the address: the column stays a note until the user
 * confirms the pattern, and its reason says so. `headerText` gives, for a column known
 * by its heading and place ("name (column 3)", where two columns share a heading), the heading itself.
 */
export function guessColumns(headers, sampleRows = [], headerText = {}, { ownGeometry = false } = {}) {
  const mapping = Object.create(null), reasons = Object.create(null), taken = new Map();
  const suggested = Object.create(null), levels = Object.create(null), regions = [];
  const values = (h) => sampleRows.map((r) => cellText(r?.[h])).filter(Boolean);
  for (const h of headers) {
    const n = normaliseHeader(Object.hasOwn(headerText, h) ? headerText[h] : h);
    let field = h === FEATURE_ID ? 'id' : BY_HEADING.get(n);
    let reason = h === FEATURE_ID ? "the GeoJSON feature's own id" : field ? `the heading "${h}" reads as ${FIELD_WORDS[field]}` : undefined;
    if (!field && (GAZETTEER_PREFIX.test(n) || ADDRESS_SUFFIX.test(n))) { field = 'address'; reason = `the heading "${h}" reads as a web address`; }
    const vs = values(h);
    const kind = !field && h !== FEATURE_ID ? regionKind(n) : undefined;
    if (kind) {
      // A column of codes (admin1 = 12) is not a region's name: kept in the notes.
      if (vs.length && vs.every(isNumber)) { field = 'note'; reason = `the heading "${h}" reads as ${kind.words}, but its values are numbers, not names, so it is kept in the notes`; }
      else { field = 'within'; reason = `the heading "${h}" reads as ${kind.words}`; regions.push({ h, rank: kind.rank, at: regions.length }); }
    }
    if (field === 'address' || field === 'id') {
      // A column of web addresses is the place's address, whatever it is called (an id column of
      // Pleiades addresses included): at least half of its values must name one, or, when its heading
      // names a gazetteer, one. A stray value then affects only its own row, which becomes a place of
      // its own or is reported (generic.js), where a gazetteer column read as a note would silently
      // make every row one. A column named for an address that holds none is only a note.
      const k = vs.filter(namesAddress).length;
      if (k && (2 * k >= vs.length || (field === 'address' && namesGazetteer(n)))) { field = 'address'; reason = `${reason}, and ${webAddresses(k, vs.length)}`; }
      else if (field === 'address') {
        field = 'note'; reason = vs.length ? `the heading "${h}" reads as a web address, but ${k ? `only ${webAddresses(k, vs.length)}` : `${vs.length === 1 ? 'its one sampled value is not a web address' : `none of its ${vs.length} sampled values is a web address`}`} (http or https), so it is kept in the notes` : `the heading "${h}" reads as a web address, but it is empty in the rows looked at, so it is kept in the notes`;
      }
      // A gazetteer's ids (pleiades_id: 579885): the address can be made from each, once the user
      // confirms the pattern; a bare number is never taken for an address unasked. Web addresses in
      // the column count with the ids, as they are read as addresses, not through the pattern.
      const g = gazetteerNamed(n);
      const fit = g && (field === 'note' || field === 'address') ? vs.filter((v) => fitsGazetteer(g, v)).length : 0;
      if (fit && 2 * (fit + k) >= vs.length) suggested[h] = { field: 'address', pattern: GAZETTEER_PATTERNS[g].pattern, gazetteer: g, fit, sampled: vs.length };
    } else if (!field && n === 'pid') {
      // Pleiades' names.csv and locations.csv give the place each row is about as "pid", its path
      // (/places/579885): at least half of the sampled values must be one for the pattern to be suggested.
      const fit = vs.filter((v) => /^\/places\/\d+$/.test(v)).length;
      if (fit && 2 * fit >= vs.length) { field = 'note'; reason = `the heading "${h}" is Pleiades' for the place a row is about`; suggested[h] = { field: 'address', pattern: GAZETTEER_PATTERNS.pleiades.pattern, gazetteer: 'pleiades', fit, sampled: vs.length }; }
    } else if ((field === 'latitude' || field === 'longitude') && ownGeometry) {
      // GeoJSON features with a geometry of their own: that is the place's location, and a latitude
      // and longitude beside it would give each place a second one.
      reason = `the heading "${h}" reads as ${field}, but the features have a geometry of their own, which is the place's location, so it is kept in the notes`; field = 'note';
    } else if (field === 'latitude' || field === 'longitude') {
      // One number is enough: a stray value that is not one ("north") is then reported, row by row.
      if (!vs.some(isNumber)) { reason = `the heading "${h}" reads as ${field}, but ${vs.length ? 'none of its values is a number in decimal degrees' : 'it is empty in the rows looked at'}, so it is kept in the notes`; field = 'note'; }
    } else if (field === 'wkt') {
      // At least half of its values must be Well-Known Text of a shape on the earth (wktFault): a
      // "coord" column of "48.39,4.52" is not, and neither is Wikidata's Point on the Moon.
      const k = vs.filter((v) => !wktFault(v)).length;
      if (vs.length && (!k || 2 * k < vs.length)) { reason = `the heading "${h}" reads as ${FIELD_WORDS.wkt}, but ${k ? `only ${k}` : 'none'} of its ${vs.length} sampled values ${k === 1 ? 'is' : 'are'} Well-Known Text of a shape on the earth (such as POINT(12.5 41.9)), so it is kept in the notes`; field = 'note'; }
      else if (vs.length) reason = `${reason}, and ${k === vs.length ? `all ${k} of its sampled values are` : `${k} of its ${vs.length} sampled values are`} Well-Known Text`;
    } else if (field === 'geometry') {
      if (!vs.length || !vs.every(geometryLike)) { reason = `the heading "${h}" reads as a geometry, but its values are not GeoJSON geometries, so it is kept in the notes`; field = 'note'; }
    } else if (field === 'gridref') {
      // At least half of its values must be grid references (gridref.js); letters alone count here.
      const k = vs.filter((v) => !parseGridRef(v).error).length;
      if (vs.length && 2 * k < vs.length) { reason = `the heading "${h}" reads as ${FIELD_WORDS.gridref}, but ${k ? `only ${k}` : 'none'} of its ${vs.length} sampled values ${k === 1 ? 'is' : 'are'} a grid reference (such as TQ 33760 80560, or O 15 34), so it is kept in the notes`; field = 'note'; }
    }
    // A column whose heading says nothing, at least half of whose values are grid references with digits.
    if (!field && vs.length && 2 * vs.filter(looksLikeGridRef).length >= vs.length) {
      const k = vs.filter(looksLikeGridRef).length;
      field = 'gridref'; reason = `${k === vs.length ? (k === 1 ? 'its one sampled value is a grid reference' : `all ${k} of its sampled values are grid references`) : `${k} of its ${vs.length} sampled values ${k === 1 ? 'is a grid reference' : 'are grid references'}`} (such as TQ 33760 80560, or O 15 34)`;
    }
    if (field && single(field) && taken.has(field)) { reason = `${reason}, but ${FIELD_WORDS[field]} is already column "${taken.get(field)}", so it is kept in the notes`; field = 'note'; }
    if (!field) { field = 'note'; reason = 'the heading is not one these tools recognise, so it is kept in the notes'; }
    if (single(field)) taken.set(field, h);
    mapping[h] = field; reasons[h] = reason;
  }
  // The containing regions, widest first by the kind their headings name (in the file's order where
  // two are of one kind), numbered 1 to n.
  regions.sort((a, b) => a.rank - b.rank || a.at - b.at).forEach(({ h }, i) => {
    levels[h] = i + 1;
    reasons[h] += regions.length === 1 ? ', at level 1' : `, the ${i === 0 ? 'widest' : i === regions.length - 1 ? 'narrowest' : ordinal(i + 1)} of the ${regions.length} regions, so at level ${i + 1} (1 is the widest)`;
  });
  // A suggestion only when no other column is the address already: one column only can be.
  for (const h of Object.keys(suggested)) if (Object.keys(mapping).some((c) => c !== h && mapping[c] === 'address')) delete suggested[h];
  for (const [h, s] of Object.entries(suggested)) {
    const have = s.fit === s.sampled ? (s.sampled === 1 ? 'its one sampled value has' : `all ${s.sampled} of its sampled values have`) : `${s.fit} of its ${s.sampled} sampled values have`;
    reasons[h] += mapping[h] === 'address'
      ? `; ${have} the form of ${GAZETTEER_WORDS[s.gazetteer]} ids, which are made into web addresses with the pattern ${s.pattern} once you confirm that pattern, and are kept in the notes until then`
      : `; but ${have} the form of ${GAZETTEER_WORDS[s.gazetteer]} ids, so it can be read as the place's web address, made with the pattern ${s.pattern}, once you confirm that pattern`;
  }
  return { mapping, patterns: Object.create(null), levels, splits: Object.create(null), suggested, reasons, gazetteer: gazetteerColumns(headers, headerText) };
}
// How many of a column's sampled values are web addresses: "49 of its 50 sampled values are web addresses".
const webAddresses = (k, n) => (n === 1 ? 'its one sampled value is a web address' : k === n ? `all ${n} of its sampled values are web addresses` : `${k} of its ${n} sampled values ${k === 1 ? 'is a web address' : 'are web addresses'}`);

/**
 * The mapping to use: `saved` (a mapping given, from --columns or the page), checked against the
 * columns there are, else the guess. Returns { mapping, patterns, suggested, reasons, problems,
 * gazetteer } (guessColumns), each problem { kind, example } of a kind in GENERIC_KINDS. A column
 * the saved mapping leaves out, or maps to something that is not a field, or to a pattern that
 * cannot be used (addresses.js, patternProblem: a World Historical Gazetteer pattern among them), is
 * kept in the notes, so that nothing is lost or claimed. With a saved mapping, `suggested` holds the
 * guess's suggestions for the columns it keeps as notes, when it has no address column.
 */
export function resolveColumns(headers, sampleRows, saved, headerText, options) {
  if (saved === undefined || saved === null) return { ...guessColumns(headers, sampleRows, headerText, options), problems: [] };
  const problems = [];
  if (typeof saved !== 'object' || Array.isArray(saved)) {
    problems.push({ kind: 'generic-mapping', example: 'the mapping given is not a JSON object of column names and fields; the guess is used instead' });
    return { ...guessColumns(headers, sampleRows, headerText, options), problems };
  }
  const mapping = Object.create(null), patterns = Object.create(null), reasons = Object.create(null), taken = new Map();
  const levels = Object.create(null), splits = Object.create(null), usedLevels = new Map(), unlevelled = [];
  const values = (h) => (sampleRows || []).map((r) => cellText(r?.[h])).filter(Boolean);
  for (const h of headers) {
    if (!Object.hasOwn(saved, h)) {
      mapping[h] = 'note'; reasons[h] = 'the mapping given does not name this column, so it is kept in the notes';
      problems.push({ kind: 'generic-mapping-missing-column', example: h });
      continue;
    }
    // A field, or { field, pattern }: the pattern only for the address.
    const given = saved[h];
    const entry = given !== null && typeof given === 'object' && !Array.isArray(given);
    const f = entry ? given.field : given, pattern = entry && Object.hasOwn(given, 'pattern') ? given.pattern : undefined;
    if (!isField(f)) {
      mapping[h] = 'note'; reasons[h] = `the mapping given says ${JSON.stringify(f)}, which is not a field, so it is kept in the notes`;
      problems.push({ kind: 'generic-mapping', example: `${h}: ${JSON.stringify(f)} is not one of ${[...Object.keys(FIELDS), ...Object.keys(OTHER)].join(', ')}` });
      continue;
    }
    if (pattern !== undefined) {
      const why = f !== 'address' ? `a pattern makes the place's web address, so it goes with "address", not "${f}"` : patternProblem(pattern);
      if (why) {
        mapping[h] = 'note'; reasons[h] = `the mapping given has a pattern for it that cannot be used (${why}), so it is kept in the notes`;
        problems.push({ kind: 'generic-mapping', example: `${h}: ${why}` });
        continue;
      }
    }
    if (single(f) && taken.has(f)) {
      mapping[h] = 'note'; reasons[h] = `the mapping given also maps column "${taken.get(f)}" to ${f}, which one column only can be, so this one is kept in the notes`;
      problems.push({ kind: 'generic-mapping', example: `${h}: ${f} is already column "${taken.get(f)}"` });
      continue;
    }
    // A level goes with "within"; a separator, levels and firstIsName with "split".
    const misplaced = entry ? Object.keys(given).filter((k) => (k === 'level' && f !== 'within') || ((k === 'separator' || k === 'levels' || k === 'firstIsName') && f !== 'split')) : [];
    const bad = misplaced.length ? `${misplaced.map((k) => `"${k}"`).join(' and ')} ${misplaced.length === 1 ? 'goes' : 'go'} with ${misplaced.includes('level') ? '"within"' : '"split"'}, not "${f}"`
      : f === 'within' && entry && Object.hasOwn(given, 'level') && !isLevel(given.level) ? `the level ${JSON.stringify(given.level)} is not a whole number of 1 or more (1 is the widest)`
        : f === 'split' ? splitProblem(given) : null;
    if (bad) {
      mapping[h] = 'note'; reasons[h] = `the mapping given cannot be used for it (${bad}), so it is kept in the notes`;
      problems.push({ kind: 'generic-mapping', example: `${h}: ${bad}` });
      continue;
    }
    if (f === 'within' && entry && Object.hasOwn(given, 'level')) {
      // Two columns cannot be one level: the second is kept in the notes.
      if (usedLevels.has(given.level)) {
        mapping[h] = 'note'; reasons[h] = `the mapping given puts it at level ${given.level}, which is already the column "${usedLevels.get(given.level)}", so it is kept in the notes`;
        problems.push({ kind: 'generic-within-same-level', example: `${h}: level ${given.level} is already the column "${usedLevels.get(given.level)}"` });
        continue;
      }
      usedLevels.set(given.level, h); levels[h] = given.level;
    } else if (f === 'within') unlevelled.push(h);
    if (f === 'split') {
      const s = { separator: given.separator, levels: given.levels, firstIsName: given.firstIsName === true };
      // No levels given: as many as the most parts a sampled value has, numbered widest (the last part) first.
      if (s.levels === undefined) { const most = Math.max(0, ...values(h).map((v) => splitParts(v, s.separator).length - (s.firstIsName ? 1 : 0))); s.levels = Array.from({ length: most }, (_, i) => most - i); }
      const clash = s.levels.find((l) => usedLevels.has(l));
      if (clash !== undefined) {
        mapping[h] = 'note'; reasons[h] = `the mapping given splits it into level ${clash}, which is already the column "${usedLevels.get(clash)}", so it is kept in the notes`;
        problems.push({ kind: 'generic-within-same-level', example: `${h}: level ${clash} is already the column "${usedLevels.get(clash)}"` });
        continue;
      }
      for (const l of s.levels) usedLevels.set(l, h);
      splits[h] = s;
    }
    if (single(f)) taken.set(f, h);
    mapping[h] = f; reasons[h] = pattern === undefined ? 'as the mapping given says' : `as the mapping given says, with each address made from the column's value through the pattern ${pattern}`;
    if (pattern !== undefined) patterns[h] = pattern;
  }
  // A "within" column given no level: the next level free, in the file's order, after those given.
  for (const h of unlevelled) {
    const l = Math.max(0, ...usedLevels.keys()) + 1;
    usedLevels.set(l, h); levels[h] = l;
    reasons[h] = `as the mapping given says; it gives no level, so it is at level ${l}, the next free (1 is the widest)`;
  }
  for (const k of Object.keys(saved)) if (!headers.includes(k)) problems.push({ kind: 'generic-mapping-unknown-column', example: k });
  const suggested = Object.create(null);
  if (!Object.values(mapping).includes('address')) {
    const guess = guessColumns(headers, sampleRows, headerText, options);
    for (const [h, s] of Object.entries(guess.suggested)) if (mapping[h] === 'note') suggested[h] = s;
  }
  return { mapping, patterns, levels, splits, suggested, reasons, problems, gazetteer: gazetteerColumns(headers, headerText) };
}

/** What is wrong with a "split" entry of a saved mapping, in words, or null when nothing is. */
function splitProblem(given) {
  if (given === null || typeof given !== 'object') return 'a split needs a separator: {"field": "split", "separator": ", ", "levels": [3, 2, 1]}';
  if (typeof given.separator !== 'string' || given.separator === '') return 'a split needs a separator, such as ", "';
  if (given.levels !== undefined && (!Array.isArray(given.levels) || !given.levels.length || !given.levels.every(isLevel))) return `its levels ${JSON.stringify(given.levels)} are not a list of whole numbers of 1 or more, narrowest first, such as [3, 2, 1]`;
  if (given.levels !== undefined && new Set(given.levels).size !== given.levels.length) return `its levels ${JSON.stringify(given.levels)} name one level twice`;
  if (given.firstIsName !== undefined && typeof given.firstIsName !== 'boolean') return 'firstIsName is true or false';
  return null;
}

/**
 * The levels the page's selector offers a "within" column at `level`, given every level in use
 * (`used`, a split's included): 1 to the highest in use, or one for each, whichever is more, so a
 * gapped mapping ({1, 3, 6}) reaches its highest (6) from any column.
 */
export function levelChoices(level, used = []) {
  const top = Math.max(level, ...used, used.length);
  return Array.from({ length: top }, (_, k) => k + 1);
}
/**
 * A mapping and its patterns (resolveColumns) as the one JSON object to save and give back (with
 * --columns, or on the page): each column's field, or { field: 'address', pattern } for a column
 * whose addresses are made through a pattern.
 */
export function mappingToSave(mapping, patterns = {}, levels = {}, splits = {}) {
  const out = Object.create(null);
  for (const [h, f] of Object.entries(mapping)) {
    if (f === 'address' && Object.hasOwn(patterns, h)) out[h] = { field: f, pattern: patterns[h] };
    else if (f === 'within' && Object.hasOwn(levels, h)) out[h] = { field: f, level: levels[h] };
    // No levels (no sampled cell had a part): left out, as --columns refuses an empty list and guesses them again.
    else if (f === 'split' && Object.hasOwn(splits, h)) out[h] = { field: f, separator: splits[h].separator, ...(splits[h].levels.length ? { levels: [...splits[h].levels] } : {}), firstIsName: !!splits[h].firstIsName };
    else out[h] = f;
  }
  return out;
}

// ---- splitting a column into levels -------------------------------------------------------------
// A column such as "Rotherhithe, Surrey, England" (narrowest first, as such columns usually are),
// mapped as { field: 'split', separator, levels, firstIsName }: each row's cell is split on the
// separator, the first part taken as the place's name if firstIsName, and the rest given, narrowest
// first, to the levels (positional, 1 the widest: [3, 2, 1] for parish, county, country). It is a
// transform of the mapping and of each row, made before applyColumns: expandSplits makes, once, a
// mapping in which each part is a column of its own (a "within" column at its level, the name part a
// "name" column), and splitRow fills those columns from each row. Parts beyond the levels given are
// reported (generic-split-extra-parts), naming them. A row with fewer parts leaves the widest levels
// empty for that row.
const PART = '\u0000';   // joins a split column's name and its part's, in a name no file's heading has
/** A cell's parts, split on the separator (spaces around it not counting, unless it is all space), each trimmed. */
function splitParts(v, separator) {
  const text = cellText(v);
  if (!text) return [];
  const sep = separator.trim() || separator;
  return text.split(sep).map((x) => x.trim());
}
/** One cell split: { name, parts: [{ level, value }] (empty parts left out), extra: [the parts beyond the levels] }. */
export function splitCell(v, { separator, levels, firstIsName = false }) {
  const all = splitParts(v, separator);
  const name = firstIsName ? all.shift() : undefined;
  return {
    ...(name ? { name } : {}),
    parts: levels.slice(0, all.length).map((level, i) => ({ level, value: all[i] })).filter((p) => p.value !== ''),
    extra: all.slice(levels.length).filter(Boolean),
  };
}
/**
 * The mapping applyColumns reads, with each split column made into its parts: { mapping, levels, from },
 * `levels` the level of each "within" column (a split's parts included), `from` the column each
 * part came from. The name part is the place's name, or one of its other names when another column
 * (or an earlier split) is the name.
 */
export function expandSplits(mapping, levels = {}, splits = {}) {
  const m = Object.create(null), lv = Object.create(null), from = Object.create(null);
  let named = Object.values(mapping).includes('name');
  for (const [h, f] of Object.entries(mapping)) {
    if (f !== 'split' || !Object.hasOwn(splits, h)) { m[h] = f; if (f === 'within' && Object.hasOwn(levels, h)) lv[h] = levels[h]; continue; }
    const s = splits[h];
    if (s.firstIsName) { const k = h + PART + 'name'; m[k] = named ? 'alternativeNames' : 'name'; named = true; from[k] = h; }
    for (const l of s.levels) { const k = h + PART + l; m[k] = 'within'; lv[k] = l; from[k] = h; }
  }
  return { mapping: m, levels: lv, from };
}
/** A row with each split column's parts as the columns expandSplits makes; parts beyond the levels are reported. */
export function splitRow(row, splits = {}, { report = () => {}, where = '' } = {}) {
  const cols = Object.keys(splits);
  if (!cols.length) return row;
  const out = Object.assign(Object.create(null), row);
  for (const h of cols) {
    const { name, parts, extra } = splitCell(row[h], splits[h]);
    if (name !== undefined) out[h + PART + 'name'] = name;
    for (const p of parts) out[h + PART + p.level] = p.value;
    if (extra.length) report('generic-split-extra-parts', `${where}, ${h}: ${extra.map((x) => `"${x}"`).join(', ')} (${splits[h].levels.length} ${splits[h].levels.length === 1 ? 'level' : 'levels'} given)`);
  }
  return out;
}

// ---- one row through the mapping ------------------------------------------------------------------
const ISO_OR_YEAR = /^-?\d{4,}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2})?Z?)?)?)?$/;
const LANGUAGE = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/;
const GEOJSON_TYPES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']);
// A year of fewer than four digits is padded to four ('921' -> '0921', '-50' -> '-0050'), as the
// LPF reader does; anything else must already be a year of four or more digits or an ISO date.
const pad = (s) => (/^-?\d{1,3}$/.test(s) ? (s.startsWith('-') ? '-' + s.slice(1).padStart(4, '0') : s.padStart(4, '0')) : s);
const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === '' || (Array.isArray(o[k]) && !o[k].length)) delete o[k]; return o; };
const inRange = (lon, lat) => Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;

/**
 * What is wrong with a GeoJSON geometry's coordinates, in words, or null when nothing is (RFC 7946):
 * every position is two or three finite numbers, a longitude from -180 to 180 and a latitude from
 * -90 to 90; a LineString has at least two positions; a Polygon's rings each have at least four
 * and end where they begin; a Multi form is a list of these. { range: true } when the only fault
 * is a position off the earth.
 */
export function geometryFault(type, coordinates) {
  const position = (p, at) => {
    if (!Array.isArray(p) || (p.length !== 2 && p.length !== 3)) return { why: `${at} is ${Array.isArray(p) ? `${p.length} numbers, not two or three` : `not a list of numbers (${cellText(p).slice(0, 40)})`}` };
    if (!p.every((x) => typeof x === 'number' && Number.isFinite(x))) return { why: `${at} is not all numbers (${JSON.stringify(p).slice(0, 60)})` };
    const [lon, lat] = p;
    if (lon < -180 || lon > 180) return { why: `${at} has longitude ${lon}, outside -180 to 180`, range: true };
    if (lat < -90 || lat > 90) return { why: `${at} has latitude ${lat}, outside -90 to 90`, range: true };
    return null;
  };
  const list = (a, at, min, what, each) => {
    if (!Array.isArray(a)) return { why: `${at} is not a list` };
    if (a.length < min) return { why: `${at} has ${a.length} ${what}, fewer than ${min}` };
    for (const [i, x] of a.entries()) { const f = each(x, `${what.replace(/s$/, '')} ${i + 1}${at === 'the geometry' ? '' : ` of ${at}`}`); if (f) return f; }
    return null;
  };
  const line = (a, at) => list(a, at, 2, 'positions', position);
  const ring = (a, at) => list(a, at, 4, 'positions', position)
    || (JSON.stringify(a[0]) !== JSON.stringify(a[a.length - 1]) ? { why: `${at} does not end where it begins, so it is not closed` } : null);
  const polygon = (a, at) => list(a, at, 1, 'rings', ring);
  const top = 'the geometry';
  switch (type) {
    case 'Point': return position(coordinates, 'the point');
    case 'MultiPoint': return list(coordinates, top, 1, 'positions', position);
    case 'LineString': return line(coordinates, top);
    case 'MultiLineString': return list(coordinates, top, 1, 'lines', line);
    case 'Polygon': return polygon(coordinates, top);
    case 'MultiPolygon': return list(coordinates, top, 1, 'polygons', polygon);
    default: return { why: `type ${JSON.stringify(type)}` };
  }
}

/**
 * What is wrong with a cell of Well-Known Text, in words, or null when nothing is: it must be a
 * POINT, MULTIPOINT, LINESTRING, MULTILINESTRING, POLYGON or MULTIPOLYGON (with Z, M or ZM, or
 * EMPTY; after SRID=4326; if EWKT names one; in any case, as Wikidata writes "Point(12.5 41.9)"),
 * of well-formed coordinates on the earth, longitude first, as for GeoJSON (geometryFault, whose
 * `range` it passes on). A GEOMETRYCOLLECTION is refused as a GeoJSON one is; so is a point on
 * another globe (Wikidata writes the globe's address first).
 */
export function wktFault(text) {
  let t = String(text).trim();
  if (/^<[^>]*>/.test(t)) return { why: `it names another globe (${t.match(/^<([^>]*)>/)[1]}), not the earth` };
  const srid = /^SRID=(\d+);/i.exec(t);
  if (srid) { if (srid[1] !== '4326') return { why: `it is in the reference system SRID ${srid[1]}, not WGS 84 longitude and latitude (4326)` }; t = t.slice(srid[0].length); }
  const head = /^([A-Za-z]+)\s*(ZM|Z|M)?\s*/i.exec(t);
  if (!head) return { why: 'it is not Well-Known Text (such as POINT(12.5 41.9))' };
  const type = head[1].toUpperCase(), dims = (head[2] || '').toUpperCase();
  const GEO = { POINT: 'Point', MULTIPOINT: 'MultiPoint', LINESTRING: 'LineString', MULTILINESTRING: 'MultiLineString', POLYGON: 'Polygon', MULTIPOLYGON: 'MultiPolygon' };
  if (type === 'GEOMETRYCOLLECTION') return { why: 'a GEOMETRYCOLLECTION, which PLATO does not take' };
  if (!GEO[type]) return { why: 'it is not Well-Known Text (such as POINT(12.5 41.9))' };
  let rest = t.slice(head[0].length);
  if (/^EMPTY$/i.test(rest)) return { why: `an empty ${type}` };
  // Nested lists of positions, each position two to four numbers separated by spaces.
  let i = 0;
  const bad = () => { throw new Error(); };
  const space = () => { while (i < rest.length && /\s/.test(rest[i])) i++; };
  const number = () => { space(); const m = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(rest.slice(i)); if (!m) bad(); i += m[0].length; return Number(m[0]); };
  const position = () => { const p = [number(), number()]; space(); while (i < rest.length && /[\d+.-]/.test(rest[i])) { p.push(number()); space(); } return p; };
  const list = (item) => {
    space(); if (rest[i] !== '(') bad(); i++;
    const out = [item()];
    for (space(); rest[i] === ','; space()) { i++; out.push(item()); }
    if (rest[i] !== ')') bad(); i++;
    return out;
  };
  // A MULTIPOINT's points may be written with or without brackets of their own.
  const point = () => { space(); if (rest[i] === '(') { i++; const p = position(); space(); if (rest[i] !== ')') bad(); i++; return p; } return position(); };
  let coords;
  try {
    const line = () => list(position), poly = () => list(line);
    coords = { POINT: () => { const l = list(position); if (l.length !== 1) bad(); return l[0]; }, MULTIPOINT: () => list(point), LINESTRING: line, MULTILINESTRING: () => list(line), POLYGON: poly, MULTIPOLYGON: () => list(poly) }[type]();
    space(); if (i !== rest.length) bad();
  } catch { return { why: `its ${type} is not written as Well-Known Text writes one (such as POINT(12.5 41.9), longitude first)` }; }
  // The dimensions said (Z, M, ZM) must be the numbers each position has; only the first two are the place's.
  const want = dims === 'ZM' ? 4 : dims ? 3 : null;
  const positions = [];
  const walk = (c) => (typeof c[0] === 'number' ? positions.push(c) : c.forEach(walk));
  walk(coords);
  if (positions.some((p) => p.length > 4 || (want ? p.length !== want : p.length > 3))) return { why: `a position has ${positions.find((p) => p.length > 4 || (want ? p.length !== want : p.length > 3)).length} numbers${want ? `, where ${dims} means ${want}` : ''}` };
  const flat = (c) => (typeof c[0] === 'number' ? c.slice(0, 2) : c.map(flat));
  return geometryFault(GEO[type], flat(coords));
}

/**
 * A GeoJSON geometry -> PLATO geometries: [] for none, or one with its geojson (and, for a point,
 * its reprPoint, as the LPF reader gives it). A GeometryCollection is refused, as PLATO's schema
 * refuses it, and so is anything that is not a GeoJSON geometry, or whose coordinates are not well
 * formed or not on the earth (geometryFault); each is reported, with why, and the rest of the row
 * is kept.
 */
export function geometryToPlato(g, report = () => {}, where = '') {
  if (g === undefined || g === null) return [];
  if (typeof g !== 'object' || Array.isArray(g)) { report('generic-geometry-invalid', `${where}: ${cellText(g).slice(0, 80)}`); return []; }
  if (g.type === 'GeometryCollection') { report('generic-geometry-collection', where); return []; }
  if (!GEOJSON_TYPES.has(g.type) || !Array.isArray(g.coordinates)) { report('generic-geometry-invalid', `${where}: ${g.type === undefined ? 'no type' : `type ${JSON.stringify(g.type)}`}${GEOJSON_TYPES.has(g.type) ? ' with no coordinates' : ''}`); return []; }
  const fault = geometryFault(g.type, g.coordinates);
  if (fault) { report(fault.range ? 'generic-coordinate-range' : 'generic-geometry-invalid', `${where}: ${g.type}: ${fault.why}`); return []; }
  if (g.type === 'Point') {
    const [lon, lat] = g.coordinates;
    return [{ reprPoint: [lon, lat], geojson: { type: 'Point', coordinates: g.coordinates } }];
  }
  return [{ geojson: { type: g.type, coordinates: g.coordinates } }];
}

/**
 * One row (an object keyed by column) through the mapping. Returns
 *   { label, name, id, address, addressText, addressLost, attestation, skipped }
 * where `attestation` is the row's one PLATO attestation (without `about`), `label` the place's
 * label (the name, else the first other name), `address` the place's web address when the address
 * column holds one (`addressText` what it holds, if it is not; `addressLost` when it held one that must
 * not be carried, which is reported here), and `skipped` the skipped columns
 * that had a value. `where` says which row, for the report; `fileName` is the file, cited as the
 * source when no source column gives one; `geometry` is a GeoJSON feature's own geometry.
 * `idAsNote` keeps the id in the notes, for rows that are attestations about an address.
 * `patterns` (resolveColumns) gives the pattern an address column's ids are made into addresses by;
 * a value that is already a web address is read as one, not through the pattern.
 */
export function applyColumns(row, mapping, { where = '', report = () => {}, fileName = 'the file', geometry, idAsNote = false, patterns = {}, levels = {}, from = {}, withinNote: noteWithin = true } = {}) {
  let name, id, idCol, address, addressFrom, addressText, addressLost = false, language, languageCol, date, start, end, wkt, lat = '', lon = '', geomCell;
  const alternatives = [], types = [], sources = [], notes = [], skipped = [], within = [];
  let gridCell;
  const note = (col, v) => notes.push(`${col}: ${v}`);
  for (const [col, field] of Object.entries(mapping)) {
    const raw = row[col];
    const v = cellText(raw);
    if (v === '') continue;
    switch (field) {
      case 'name': name = v; break;
      case 'alternativeNames': for (const x of cellList(raw)) if (!alternatives.includes(x)) alternatives.push(x); break;
      case 'latitude': lat = v; break;
      case 'longitude': lon = v; break;
      case 'wkt': {
        // Carried as written only when it is Well-Known Text of a shape on the earth (wktFault).
        const f = wktFault(v);
        if (f) report(f.range ? 'generic-coordinate-range' : 'generic-wkt-invalid', `${where}, ${col}: ${f.why} (${v.length > 60 ? v.slice(0, 59) + '…' : v})`);
        else wkt = v;
        break;
      }
      case 'geometry': geomCell = { col, v }; break;
      case 'gridref': gridCell = { col, v }; break;
      case 'id': id = v; idCol = col; break;
      case 'address': {
        // Put into the form `about` should carry (addresses.js): a gazetteer's forms of an address
        // become its one form, WHG's reconciliation ids and entity pages its persistent addresses;
        // one that must not be carried is reported.
        const pattern = Object.hasOwn(patterns, col) ? patterns[col] : undefined;
        if (pattern !== undefined && !/^https?:\/\//i.test(v)) {
          // An id, made into the address through the pattern the user confirmed; one of the wrong
          // shape (whg:<n> always) makes none, and is kept in the notes should the row become a place of its own.
          const p = addressFromPattern(v, pattern);
          if (p.lost === 'shape') { addressLost = true; report('generic-id-shape', `${where}, ${col}: ${v} (the pattern ${pattern})`); note(col, v); }
          else if (p.lost) { addressLost = true; report(lostKind(p.lost), `${where}: ${p.value}`); }
          else if (isWebAddress(p.iri)) {
            address = p.iri.trim(); addressFrom = p.from ? p : undefined;
            notes.push(`Place address made from the value ${v} in the column "${col}" with the pattern ${pattern}`);
            if (p.part) report('address-pleiades-part', `${where}: ${p.iri}`);
            if (p.page) report('address-web-page', `${where}: ${p.iri}`);
          } else { addressText = v; note(col, v); }
          break;
        }
        const p = placeAddress(v);
        if (p.lost) { addressLost = true; report(lostKind(p.lost), `${where}: ${p.value}`); }
        else if (isWebAddress(p.iri)) { address = p.iri.trim(); addressFrom = p.from ? p : undefined; if (p.part) report('address-pleiades-part', `${where}: ${p.iri}`); if (p.page) report('address-web-page', `${where}: ${p.iri}`); }
        else { addressText = v; note(col, v); }   // kept, should the row become a place of its own
        break;
      }
      case 'type': for (const x of cellList(raw)) types.push(isWebAddress(x) ? { identifier: x, label: x } : { label: x }); break;
      case 'language': language = v; languageCol = col; break;
      case 'source': sources.push(isWebAddress(v) ? { '@id': v, title: v, authorityType: 'source' } : { title: v, authorityType: 'source' }); break;
      case 'date': date = v; break;
      case 'start': if (ISO_OR_YEAR.test(pad(v))) start = pad(v); else report('generic-date-invalid', `${where}, ${col}: ${v}`); break;
      case 'end': if (ISO_OR_YEAR.test(pad(v))) end = pad(v); else report('generic-date-invalid', `${where}, ${col}: ${v}`); break;
      case 'skip': skipped.push(col); break;
      // A region the place lies in, at its level (a split column's part names the column it came from).
      case 'within': if (Object.hasOwn(levels, col)) { within.push({ level: levels[col], value: v, column: Object.hasOwn(from, col) ? from[col] : col }); break; } note(col, v); break;
      default: note(col, v);
    }
  }
  // The name, in the language the language column gives; a language with no name to be the language
  // of is kept in the notes rather than lost.
  const names = [];
  if (name) {
    const n = { toponym: name };
    if (language && LANGUAGE.test(language)) n.language = language;
    else if (language) report('generic-language-invalid', `${where}: ${language}`);
    names.push(n);
  } else if (language) note(languageCol, language);
  for (const a of alternatives) if (a !== name) names.push({ toponym: a });
  // A row about an address keeps its id in the notes, since the place is not the file's to name.
  if (idAsNote && address && id !== undefined) note(idCol, id);
  // The regions it lies in, widest first, kept in the notes as the source gives them (PLATO has no
  // place for them yet; the reader's event carries them, within.js).
  // `withinNote` false: the reader writes them as ContainedIn attestations instead (generic.js).
  within.sort((a, b) => a.level - b.level);
  if (within.length && noteWithin) notes.push(withinNote(within, name || alternatives[0]));
  if (address && addressFrom) notes.push(addressNote(addressFrom));

  const geometries = [];
  // A latitude and longitude: a location exactly as the locations sheet makes one, with the WKT beside it.
  if (lat !== '' || lon !== '') {
    if (lat === '' || lon === '') report('generic-coordinate-missing', `${where}: ${lat === '' ? `longitude ${lon} with no latitude` : `latitude ${lat} with no longitude`}`);
    else if (!isNumber(lat) || !isNumber(lon)) report('generic-coordinate-not-number', `${where}: ${lat}, ${lon}`);
    else if (!inRange(Number(lon), Number(lat))) report('generic-coordinate-range', `${where}: latitude ${lat}, longitude ${lon}`);
    else {
      const [x, y] = [Number(lon), Number(lat)];
      geometries.push(clean({ reprPoint: [x, y], geojson: { type: 'Point', coordinates: [x, y] }, wkt }));
      wkt = undefined;
    }
  }
  // A grid reference (gridref.js): the centre of its square in WGS 84, unless the latitude and longitude
  // gave the row a location, which then wins, the reference kept in the notes.
  if (gridCell) {
    const g = gridRefToWgs84(gridCell.v);
    const shown = gridCell.v.length > 60 ? gridCell.v.slice(0, 59) + '…' : gridCell.v;
    if (g.error) report('generic-gridref-invalid', `${where}, ${gridCell.col}: ${g.error} (${shown})`);
    if (geometries.length) {
      note(gridCell.col, gridCell.v);
      const [x, y] = geometries[0].reprPoint;
      const allowed = g.error ? 0 : g.precisionKm + decimalsKm(lat, lon);
      const km = g.error ? 0 : groundKm([x, y], [g.lon, g.lat]);
      if (km > allowed) report('generic-gridref-disagrees', `${where}: the grid reference ${shown} (column "${gridCell.col}") is ${round3(km)} km from latitude ${lat}, longitude ${lon}, more than the ${round3(allowed)} km the two allow together; the latitude and longitude are used`);
    } else if (!g.error) {
      geometries.push(clean({ reprPoint: [g.lon, g.lat], geojson: { type: 'Point', coordinates: [g.lon, g.lat] }, spatialPrecision: g.approximate ? ['approximate'] : undefined, precisionKm: [g.precisionKm], sourceLabel: gridCell.v }));
      notes.push(g.note);
    }
  }
  if (wkt) geometries.push({ wkt });
  if (geomCell) {
    let g;
    try { g = JSON.parse(geomCell.v); } catch { g = geomCell.v; }
    geometries.push(...geometryToPlato(g, report, `${where}, ${geomCell.col}`));
  }
  if (geometry !== undefined) geometries.push(...geometryToPlato(geometry, report, where));

  // The file is the source, and the row its locator, unless a source column names the source.
  const cited = sources.length ? sources.map((s) => ({ source: s })) : [{ source: { title: fileName, authorityType: 'source' }, locator: where }];
  const attestation = clean({
    names, geometries, types,
    timespans: date || start || end ? [clean({ sourceLabel: date, startEarliest: start, endLatest: end })] : undefined,
    sources: cited.map((c) => c.source),
    citations: cited.map((c) => clean({ ...c })),
    notes: notes.join('\n') || undefined,
  });
  return { label: name || alternatives[0], name, id, address, addressText, addressLost, attestation, skipped, ...(within.length ? { within } : {}) };
}

// ---- a grid reference beside a latitude and longitude -----------------------------------------------
const round3 = (x) => Math.round(x * 1000) / 1000;
/** The ground distance in km between two [longitude, latitude] points (haversine, mean radius). */
function groundKm([x1, y1], [x2, y2]) {
  const r = Math.PI / 180, a = Math.sin((y2 - y1) * r / 2) ** 2 + Math.cos(y1 * r) * Math.cos(y2 * r) * Math.sin((x2 - x1) * r / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}
/** How far a latitude and longitude may be from the place, in km, from their decimals: half the last place of each. */
function decimalsKm(lat, lon) {
  const half = (s) => 0.5 * 10 ** -((/\.(\d+)/.exec(s) || ['', ''])[1].length);
  return Math.hypot(half(lat) * 111.32, half(lon) * 111.32 * Math.cos(Number(lat) * Math.PI / 180));
}
