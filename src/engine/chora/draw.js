// A drawing on Chora's map, made into what it adds to the dataset: one NEW attestation of one
// geometry, never a change to an existing one (PLATO's append-only rule). It has no @id: whoever
// publishes the dataset gives it one. PLATO has no term for how a geometry was drawn, or on what
// map, so that goes in its notes (choraDrawingNote in src/engine/words.js).
//
// A geometry PLATO does not accept (a GeometryCollection, a ring that does not close) is refused
// here, before it can reach a draft or the dataset; save() checks every addition against the
// pinned JSON Schema again (checkAddition in save.js), since a draft may have been made by an older
// page. This module imports nothing heavy, so the page can use it on its own thread.
import { PLATO } from '../../lib/context.js';
import { GEOMETRY_TYPES, bboxOf, reprPointOf } from './geo.js';

/** A drawing that cannot become a PLATO geometry attestation; the message says why, in plain words. */
export class DrawError extends Error {
  constructor(message) { super(message); this.name = 'DrawError'; }
}

/** What a geometry depicts (plato:GeometryRole): the roles PLATO defines, by their short names. */
export const ROLES = ['Extent', 'FeaturePoint', 'RepresentativePoint', 'LabelAnchor', 'Itinerary'];
/** How well the location is known (spatialPrecision), as the schema enumerates it. */
export const PRECISIONS = ['exact', 'approximate', 'uncertain', 'historical_approximate'];
const ORCID = /^https:\/\/orcid\.org\/\d{4}-\d{4}-\d{4}-\d{3}[0-9X]$/;
const isAbsolute = (s) => typeof s === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(s);

// Seven decimal places of a degree is about a centimetre: finer than any drawing by hand, and short
// enough that every number survives RDF and back exactly (DEVELOPERS.md, Numbers).
const round = (x) => Math.round(x * 1e7) / 1e7;
function position(p, where) {
  if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new DrawError(`${where} is not a position (longitude, latitude).`);
  if (p[0] < -180 || p[0] > 180 || p[1] < -90 || p[1] > 90) throw new DrawError(`${where} is off the map: longitude must be between -180 and 180, latitude between -90 and 90.`);
  return [round(p[0]), round(p[1])];
}
const list = (c, where, min) => { if (!Array.isArray(c) || c.length < min) throw new DrawError(`${where} needs at least ${min} ${min === 1 ? 'part' : 'parts'}.`); return c; };
const line = (c, where) => list(c, where, 2).map((p, i) => position(p, `${where}, point ${i + 1},`));
function ring(c, where) {
  const r = list(c, where, 4).map((p, i) => position(p, `${where}, point ${i + 1},`));
  const [a, b] = [r[0], r[r.length - 1]];
  if (a[0] !== b[0] || a[1] !== b[1]) throw new DrawError(`${where} does not close: its last point must be its first.`);
  return r;
}
const polygon = (c, where) => list(c, where, 1).map((r, i) => ring(r, i ? `${where}, hole ${i}` : where));

/** The geometry's coordinates, checked for its type and rounded; throws DrawError otherwise. */
export function checkGeoJSON(geojson) {
  if (!geojson || typeof geojson !== 'object') throw new DrawError('There is no geometry.');
  if (geojson.type === 'GeometryCollection') throw new DrawError('A GeometryCollection is not accepted in PLATO: record each geometry separately, as its own drawing.');
  if (!GEOMETRY_TYPES.includes(geojson.type)) throw new DrawError(`A ${String(geojson.type)} is not a geometry PLATO accepts: draw a point, a line or an area.`);
  const c = geojson.coordinates;
  const coordinates = geojson.type === 'Point' ? position(c, 'The point')
    : geojson.type === 'MultiPoint' ? list(c, 'The points', 1).map((p, i) => position(p, `Point ${i + 1}`))
    : geojson.type === 'LineString' ? line(c, 'The line')
    : geojson.type === 'MultiLineString' ? list(c, 'The lines', 1).map((l, i) => line(l, `Line ${i + 1}`))
    : geojson.type === 'Polygon' ? polygon(c, 'The area')
    : list(c, 'The areas', 1).map((p, i) => polygon(p, `Area ${i + 1}`));
  return { type: geojson.type, coordinates };
}

/** A role by its short name (Extent), with the plato: prefix, or in full; throws for anything else. */
export function roleIri(role) {
  if (role === undefined || role === null || role === '') return undefined;
  const short = String(role).replace(/^plato:/, '').replace(PLATO, '');
  if (ROLES.includes(short)) return PLATO + short;
  if (isAbsolute(role) && !String(role).startsWith('plato:')) return role;
  throw new DrawError(`${role} is not a geometry role: use one of ${ROLES.join(', ')}, or the full address of a role a vocabulary defines.`);
}

function contributorOf(c) {
  if (typeof c === 'string') { if (isAbsolute(c)) return c; throw new DrawError('A contributor given as text must be a full web address; otherwise give a name.'); }
  if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !c.name.trim()) throw new DrawError('Who made the drawing is not known: give a name before saving.');
  const out = { name: c.name.trim() };
  if (c.orcid) {
    const o = String(c.orcid).trim();
    const full = /^\d{4}-\d{4}-\d{4}-\d{3}[0-9X]$/.test(o) ? 'https://orcid.org/' + o : o;
    if (!ORCID.test(full)) throw new DrawError('The ORCID iD must be written in full, as https://orcid.org/0000-0002-1825-0097.');
    out.orcid = full;
  }
  return out;
}

/**
 * One drawing as a new PLATO attestation: { geometries: [one], contributor, created, sources?,
 * citations?, notes }.
 * - geojson: a Point, MultiPoint, LineString, MultiLineString, Polygon or MultiPolygon;
 * - role: what it depicts (ROLES, by short name or in full); precision: how well it is known
 *   (PRECISIONS); precisionKm: an uncertainty radius;
 * - contributor: { name, orcid? } or an address; created: when (an ISO date-time, or a Date);
 * - source (a source object, or an address, which becomes a citation) and citation ({ source,
 *   locator, … }): optional;
 * - notes: how it was drawn, and on what map.
 * Throws DrawError, in words, for anything PLATO would not accept.
 */
export function newGeometryAttestation({ geojson, role, precision, precisionKm, contributor, created, source, citation, notes } = {}) {
  const g = checkGeoJSON(geojson);
  const geometry = { geojson: g, reprPoint: reprPointOf(g).map(round) };
  if (g.type !== 'Point') geometry.bbox = bboxOf(g);
  const r = roleIri(role);
  if (r) geometry.role = r;
  if (precision !== undefined && precision !== null && precision !== '') {
    if (!PRECISIONS.includes(precision)) throw new DrawError(`${precision} is not a precision PLATO knows: use one of ${PRECISIONS.join(', ')}.`);
    geometry.spatialPrecision = [precision];
  }
  if (precisionKm !== undefined && precisionKm !== null && precisionKm !== '') {
    if (!Number.isFinite(+precisionKm) || +precisionKm < 0) throw new DrawError('The uncertainty radius must be a distance in kilometres, not below 0.');
    geometry.precisionKm = [+precisionKm];
  }
  const when = created instanceof Date ? created.toISOString() : created;
  if (typeof when !== 'string' || Number.isNaN(Date.parse(when)) || !/T\d{2}:\d{2}/.test(when)) throw new DrawError('When the drawing was made must be a date and time.');
  const a = { geometries: [geometry], contributor: contributorOf(contributor), created: when };
  // PLATO's `sources` holds source objects (with a title); a source known only by its address is
  // cited instead, which the schema allows either way.
  if (source && typeof source === 'object') a.sources = [source];
  const citations = [...(source && typeof source !== 'object' ? [{ source }] : []), ...(citation ? [citation] : [])];
  if (citations.length) a.citations = citations;
  if (typeof notes === 'string' && notes.trim()) a.notes = notes.trim();
  return a;
}
