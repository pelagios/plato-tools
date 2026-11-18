// One flat table of a PLATO dataset: one row for each place, to open in a spreadsheet. The ten
// spreadsheet tables (tables.js) hold a place's names, locations and matches in sheets of their own,
// which a reader must join; this is the summary a scholar asks for instead: what their own table said
// of each place, and what became of it (its match, its location and where that came from).
//
// It is a summary, not a format to read back: it holds one location, one pair of dates and the
// matches of each place, and says in the report what it leaves out. Everything in it is what the
// dataset records, and nothing more. In particular a dataset records the matches made, never the
// places a reviewer skipped, or looked up and found nothing for (those are in the review's work file
// alone), so a place with no match says only that: "no match recorded".
import Papa from 'papaparse';
import { list, isDenial, isComputed, isComputedFacet, currentAttestations, acceptedMatches, identityBundleLosses, datesTheEvidence, isContainedIn } from './shared.js';
import { geojsonToWkt } from './tables.js';
import { reprPointOf } from '../engine/chora/geo.js';
import { AUTHORITIES, authorityOf } from '../engine/hermes/addresses.js';

/** The columns before a table's own (those its notes keep), and those after them. */
export const FLAT_BEFORE = ['place_id', 'label', 'alternative_names', 'kind'];
export const FLAT_AFTER = ['notes', 'start', 'end', 'match_status', 'match_id', 'matches_count', 'match_source', 'match_given_by', 'lat', 'lon', 'geometry_wkt', 'geometry_note', 'source', 'is_region'];
/** What match_status says, by the kind of match the dataset records; NO_MATCH where it records none. */
export const MATCH_STATUS = { exactMatch: 'same place (exact match)', closeMatch: 'much the same place (close match)', related: 'a related place' };
export const MATCH_UNSPECIFIED = 'a match, its kind not stated';
export const NO_MATCH = 'no match recorded';
/** Between the matches of a place with several (an address may hold a semicolon, so it is spaced). */
export const MATCH_SEPARATOR = ' ; ';
/** At most this many columns are made from the notes; a heading beyond them stays in `notes`, as "heading: value". */
export const NOTE_COLUMNS = 50;
/** The byte-order mark Excel needs to read a CSV file as UTF-8 (without it, accents are garbled). */
export const BOM = '﻿';

const CITES_AS_EVIDENCE = 'http://purl.org/spar/cito/citesAsEvidence';
const CITES_FOR_INFORMATION = 'http://purl.org/spar/cito/citesForInformation';
const SPDX = 'https://spdx.org/licenses/';
const STRENGTH = ['exactMatch', 'closeMatch', 'related'];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const unique = (xs) => [...new Set(xs.filter((x) => x !== '' && x !== undefined && x !== null))];
// exactMatch, however it is written (skos:exactMatch, a full address).
const kindOf = (identityType) => text(identityType).split(/[#/:]/).pop();
const strength = (k) => { const i = STRENGTH.indexOf(k); return i < 0 ? STRENGTH.length : i; };
const nameOf = (c) => (typeof c === 'string' ? c.trim() : isObject(c) && typeof c.name === 'string' ? c.name.trim() : '');
const point = (p) => (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [p[0], p[1]] : null);
const round6 = (n) => Math.round(n * 1e6) / 1e6;

/** The gazetteer a matched record is in, from its address: its name where these tools know it, else its host. */
export function matchSource(iri) {
  const a = authorityOf(iri);
  if (a.rank < AUTHORITIES.length) return AUTHORITIES[a.rank].name;
  return /^[a-z][a-z0-9+.-]*:/i.test(text(iri)) ? a.key : '';
}

/**
 * Who a match is given by, from what its attestation records: its contributor is a reviewer (in a
 * bulk accept when the basis says so, the words of GUARD_TEXT.basis); with none, the table when the
 * basis says the table gave it (matchBasis, hermes/columns.js), else nobody the dataset names.
 */
export function givenBy(ir, a) {
  const who = a && a.contributor !== undefined && a.contributor !== null ? nameOf(a.contributor) || '(not named)' : null;
  const basis = text(ir && ir.basis);
  if (who !== null) return /^Accepted in bulk\b/.test(basis) ? `bulk accept by ${who}` : `the reviewer ${who}`;
  return /^Given by the table\b/.test(basis) ? 'the table' : 'the dataset (no reviewer recorded)';
}

// A line of the notes that begins a column of the table's: "heading: value" (hermes/columns.js keeps
// each column it has no field for so). A web address alone (https://…) is not one: no space follows.
const HEADING = /^([^:\n]{1,60}):(?: (.*))?$/;
/**
 * The notes of one of the table's own attestations, as { columns: [[heading, value]…], rest }: each
 * line "heading: value" a column, a line that is not one the rest of the value above it (a cell of
 * several lines), and what comes before the first heading the `rest`, which stays in `notes`.
 */
export function splitNotes(notes) {
  const columns = [], rest = [];
  for (const line of String(notes).split('\n')) {
    const m = HEADING.exec(line);
    if (m && m[1].trim()) columns.push([m[1].trim(), m[2] || '']);
    else if (columns.length) columns[columns.length - 1][1] += '\n' + line;
    else rest.push(line);
  }
  return { columns, rest: rest.join('\n').trim() };
}

/** The licence a citation's source gives, as its SPDX id where it is an SPDX address. */
function licenceOf(citation) {
  const l = isObject(citation?.source) ? citation.source.licence : null;
  if (typeof l !== 'string' || !l) return 'licence not stated';
  return `licence ${l.startsWith(SPDX) ? l.slice(SPDX.length) : l}`;
}
/**
 * Where a location comes from, from its attestation: with no contributor it is the table's own; with
 * one, copied from a gazetteer's record when it cites the record as evidence (Chora's adoption:
 * the record is the citation's locator, the licence its source's), else drawn (its notes say so) or
 * added by that person.
 */
export function geometryOrigin(a) {
  if (!a || a.contributor === undefined || a.contributor === null) return 'own to the table';
  const who = nameOf(a.contributor) || '(not named)';
  const cites = (f) => list(a.citations).find((c) => isObject(c) && c.citationFunction === f && typeof c.locator === 'string' && c.locator);
  const copied = cites(CITES_AS_EVIDENCE);
  if (copied) return `copied from ${copied.locator} (${licenceOf(copied)}) by ${who}`;
  const consulted = cites(CITES_FOR_INFORMATION);
  const drawn = /^Drawn\b/.test(text(a.notes));
  return `${drawn ? 'drawn' : 'added'} by ${who}${drawn ? '' : ' (not from the table)'}${consulted ? `, consulting ${consulted.locator}` : ''}`;
}

/** A place's location for the row: lat, lon, the shape as WKT, and what the point is where it is not the location itself. */
function located(g) {
  const out = { lat: '', lon: '', wkt: '', point: '' };
  const gj = isObject(g.geojson) ? g.geojson : null;
  const own = gj && gj.type === 'Point' ? point(gj.coordinates) : null;
  if (own) { out.lon = own[0]; out.lat = own[1]; return out; }
  let wkt = null;
  if (gj) { try { wkt = geojsonToWkt(gj); } catch { wkt = null; } }
  out.wkt = wkt || text(g.wkt);
  let p = point(g.reprPoint);
  if (p) { if (out.wkt) out.point = 'lat and lon are the representative point the dataset records for the shape'; }
  else if (gj) {
    // A representative point is worked out only by Chora's own rule (geo.js, reprPointOf), and said to be.
    try { p = point(reprPointOf(gj)); } catch { p = null; }
    if (p) { p = p.map(round6); out.point = 'lat and lon are a representative point worked out from the shape by PLATO tools'; }
  }
  if (p) { out.lon = p[0]; out.lat = p[1]; }
  return out;
}

const sourceWords = (s) => (typeof s === 'string' ? s : isObject(s) ? text(s.citation) || text(s.title) || text(s['@id']) : '');

/**
 * The flat table of a dataset, made as its records pass: record(ev) for each place, identity(ir) for
 * each identity relation given on its own (after the places, as DEEP's are), then table() or csv().
 *   loss(l)              what the table does not carry ({ kind, value }), as the other writers report it
 *   note(kind, value, n) what a reader should know of it, that is no loss
 *   withdrawn            the document's withdrawn attestations (shared.js), or null
 * It holds a row for each place until the end: which places are regions, and the matches listed
 * after the places, are known only then.
 */
export class FlatTable {
  constructor({ loss = () => {}, note = () => {}, withdrawn = null } = {}) {
    this.loss = loss; this.note = note; this.withdrawn = withdrawn;
    this.rows = []; this.byId = new Map(); this.matches = new Map(); this.regions = new Set(); this.headings = [];
  }
  match(subject, ir, a) {
    if (typeof subject !== 'string' || !isObject(ir) || typeof ir.object !== 'string' || !ir.object) return;
    (this.matches.get(subject) || this.matches.set(subject, []).get(subject)).push({ ir, a });
  }
  /** An identity relation given on its own: nobody is recorded as having made it. */
  identity(ir) { if (isObject(ir)) this.match(ir.subject, ir, null); }
  record(ev) {
    const rec = ev && ev.value;
    if (!isObject(rec)) return;
    const { loss } = this;
    const id = typeof rec['@id'] === 'string' && rec['@id'] ? rec['@id'] : null;
    const where = id || text(rec.label) || '(a place with no address)';
    // The table's own id where the place's address is made from it; else the address.
    let tail = id || '';
    try { tail = decodeURIComponent(tail); } catch { /* kept as written */ }
    const own = typeof rec.entityIdentifier === 'string' && rec.entityIdentifier && (!id || tail.endsWith(rec.entityIdentifier)) ? rec.entityIdentifier : null;
    const names = [], kinds = [], sources = [], notes = [], columns = new Map(), spans = [], places = [];
    for (const a of currentAttestations(rec, this.withdrawn, loss)) {
      if (!isObject(a)) continue;
      if (isComputed(a)) { loss({ kind: 'computed', value: a['@id'] || where }); continue; }
      const accepted = acceptedMatches(a, id);
      for (const m of accepted) this.match(m.subject, m.ir, a);
      const bundled = identityBundleLosses(a, where, loss, accepted.length);
      // What a source denies has no column here: written, it would say the opposite.
      if (isDenial(a)) { if (!bundled) loss({ kind: 'flat-denied', value: a['@id'] || where }); continue; }
      const facet = (k) => list(a[k]).filter((f) => isObject(f) && !isComputedFacet(f));
      const geometries = facet('geometries'), toponyms = facet('names'), types = facet('types');
      for (const n of toponyms) names.push(text(n.toponym));
      for (const t of types) kinds.push(text(t.label) || text(t.sourceLabel) || text(t.identifier));
      for (const g of geometries) places.push({ g, a });
      for (const r of list(a.relations)) if (isObject(r) && isContainedIn(r.relationType) && typeof r.relatesTo === 'string') this.regions.add(r.relatesTo);
      for (const k of ['relations', 'properties']) if (list(a[k]).length) loss({ kind: 'flat-facet-not-carried', value: `${where}: ${k}` });
      // The place's own evidence: not a match, and not a location a person added (whose dates and
      // source are the location's, said in geometry_note).
      const added = a.contributor !== undefined && a.contributor !== null && geometries.length && !toponyms.length && !types.length;
      const evidence = !bundled && !added;
      if (evidence) {
        if (datesTheEvidence(a)) { if (list(a.timespans).length) loss({ kind: 'evidence-span', value: a['@id'] || where }); }
        else for (const t of facet('timespans')) spans.push(t);
        for (const s of [...list(a.sources), ...list(a.citations).map((c) => (isObject(c) ? c.source : null))]) sources.push(sourceWords(s));
      }
      if (typeof a.notes !== 'string' || !a.notes.trim()) continue;
      // The table's own notes are its columns; a reviewer's, or a tool's, stay as they were written.
      const split = (a.contributor === undefined || a.contributor === null) && !bundled ? splitNotes(a.notes) : { columns: [], rest: a.notes.trim() };
      if (split.rest) notes.push(split.rest);
      for (const [h, v] of split.columns) {
        if (!columns.has(h) && !this.headings.includes(h)) {
          if (this.headings.length >= NOTE_COLUMNS) { notes.push(`${h}: ${v}`); continue; }
          this.headings.push(h);
        }
        columns.set(h, unique([...(columns.get(h) || []), v]));
      }
    }
    for (const ir of list(rec.identityRelations)) if (isObject(ir)) this.match(typeof ir.subject === 'string' && ir.subject ? ir.subject : id, ir, null);

    const row = { place_id: own || id || '', label: text(rec.label), kind: unique(kinds).join('; '), notes: unique(notes).join('\n'), source: unique(sources).join('; ') };
    row.alternative_names = unique(names).filter((n) => n !== row.label).join('; ');
    row.columns = new Map([...columns].map(([h, vs]) => [h, vs.join('; ')]));
    // The dates of the first dated attestation, as the dataset writes them.
    const t = spans[0];
    if (t) {
      row.start = text(t.startEarliest) || text(t.startLatest); row.end = text(t.endLatest) || text(t.endEarliest);
      if ((t.startLatest && t.startEarliest && t.startLatest !== t.startEarliest) || (t.endEarliest && t.endLatest && t.endEarliest !== t.endLatest)) loss({ kind: 'four-date-bounds' });
      if (!row.start && !row.end) loss({ kind: 'flat-date-in-words', value: `${where}: ${text(t.sourceLabel) || text(t.label) || 'a date with no years'}` });
      if (new Set(spans.map((s) => JSON.stringify(s))).size > 1) loss({ kind: 'flat-more-dates', value: where });
    }
    // The first location the dataset gives the place, and where it came from.
    if (places.length) {
      const { g, a } = places[0];
      const l = located(g);
      Object.assign(row, { lat: l.lat, lon: l.lon, geometry_wkt: l.wkt });
      const more = places.length - 1;
      row.geometry_note = [geometryOrigin(a), l.point, more ? `${more} more location${more === 1 ? '' : 's'} of this place in the dataset ${more === 1 ? 'is' : 'are'} not shown` : ''].filter(Boolean).join('; ');
      if (more) loss({ kind: 'flat-more-locations', value: where });
      if (l.lat === '' && !l.wkt) loss({ kind: 'geometry-without-coordinates' });
    }
    row.region = !!ev.region;
    row.id = id;
    if (id && !this.byId.has(id)) this.byId.set(id, row);
    this.rows.push(row);
  }
  /** { header, rows }: the header, and each row as cells in its order, once every record has been read. */
  table() {
    const { loss, note } = this;
    const fixed = new Set([...FLAT_BEFORE, ...FLAT_AFTER]);
    // A column of the table's that is named as one of these is told apart, never merged with it.
    const taken = new Set(this.headings.filter((h) => !fixed.has(h)));
    const named = this.headings.map((h) => { if (!fixed.has(h)) return h; let n = `${h} (note)`; while (taken.has(n)) n += ' (note)'; taken.add(n); return n; });
    const header = [...FLAT_BEFORE, ...named, ...FLAT_AFTER];
    let unmatched = 0;
    for (const [subject, ms] of this.matches) if (!this.byId.has(subject)) for (const m of ms) loss({ kind: 'flat-match-without-place', value: `${subject} ${m.ir.object}` });
    const rows = this.rows.map((row) => {
      // The matches of one place, each record once (its strongest match), the strongest first.
      const byObject = new Map();
      for (const m of (row.id && this.byId.get(row.id) === row && this.matches.get(row.id)) || []) {
        const k = kindOf(m.ir.identityType), had = byObject.get(m.ir.object);
        const by = givenBy(m.ir, m.a);
        if (!had) byObject.set(m.ir.object, { object: m.ir.object, kind: k, by: [by] });
        else { had.by.push(by); if (strength(k) < strength(had.kind)) had.kind = k; }
      }
      const ms = [...byObject.values()].sort((a, b) => strength(a.kind) - strength(b.kind));
      if (!ms.length) unmatched++;
      const cells = {
        ...row,
        match_status: ms.length ? MATCH_STATUS[ms[0].kind] || MATCH_UNSPECIFIED : NO_MATCH,
        match_id: ms.map((m) => m.object).join(MATCH_SEPARATOR),
        matches_count: ms.length,
        match_source: ms.map((m) => matchSource(m.object)).join(MATCH_SEPARATOR),
        match_given_by: unique(ms.flatMap((m) => m.by)).join(MATCH_SEPARATOR),
        is_region: row.region || (row.id && this.regions.has(row.id)) ? 'yes' : '',
      };
      return [...FLAT_BEFORE.map((h) => cells[h]), ...this.headings.map((h) => row.columns.get(h)), ...FLAT_AFTER.map((h) => cells[h])].map((c) => (c === undefined || c === null ? '' : String(c)));
    });
    note('flat-summary');
    if (unmatched) note('flat-no-match-recorded', undefined, unmatched);
    if (named.length) note('flat-notes-columns', named.join(', '));
    return { header, rows };
  }
  /**
   * The table as CSV text for a spreadsheet: UTF-8 with a byte-order mark, so that Excel reads the
   * accents; CRLF between rows (RFC 4180); and a cell a spreadsheet would run as a formula (one that
   * begins = or @, or + or - before anything but a number) given a leading apostrophe, and counted.
   */
  csv() {
    const { header, rows } = this.table();
    let guarded = 0, example;
    const safe = (c) => { if (!/^[=@\t\r]|^[+-](?![\d.])/.test(c)) return c; guarded++; example ??= c.slice(0, 60); return "'" + c; };
    const data = rows.map((r) => r.map(safe));
    if (guarded) this.note('flat-formula-guard', example, guarded);
    return { text: BOM + Papa.unparse({ fields: header, data }, { newline: '\r\n' }) + '\r\n', rows: rows.length, columns: header.length };
  }
}
