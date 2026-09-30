// What is particular to the World Historical Gazetteer's reconciliation service, kept apart from the
// protocol (index.js), which any W3C reconciliation service (version 0.2) speaks. EVERY assumption the
// lookup makes about WHG is listed here, and the code that rests on one is in this file, so that a
// correction is made in one place.
//
// Sources, 30 September 2026: WHG's service manifest (GET https://whgazetteer.org/reconcile, which
// needs no token), its API documentation (docs.whgazetteer.org, "Reconciliation Service API") and its
// source (github.com/WorldHistoricalGazetteer/whg3, api/reconcile.py and api/reconcile_helpers.py).
// None of it was checked against an authenticated answer, so each reader below takes what it finds
// and gives null for anything else, rather than trusting a shape.
//
// A1 Endpoint: POST https://whgazetteer.org/reconcile, for queries and for extend alike. [manifest]
// A2 Token: `Authorization: Bearer <token>`; without one, 401. The manifest also offers the token as
//    a query parameter (`authentication.in: "query"`), and the docs call that "the simplest way":
//    these tools never send it so, as an address ends up in logs, histories and error messages.
//    [docs, source]
// A3 Batch: at most 50 queries a request (the manifest's `batch_size`); more is refused with 400
//    and nothing is processed. [manifest, docs, source] The rate limit counts queries (600 a minute,
//    then 429 with Retry-After in seconds); the daily quota counts requests (5,000; spent, it is a
//    401 "Daily API limit … exceeded"). One request in flight is enough: WHG fans each batch out
//    itself. [docs, source]
// A4 Encoding: a JSON body `{"queries": {...}}` / `{"extend": {...}}` with Content-Type
//    application/json, as WHG documents; form-encoded `queries=` (the W3C protocol's, OpenRefine's)
//    is accepted too, but WHG decodes a form-encoded `extend` twice (Django, then unquote_plus),
//    turning a `+` in it into a space, so JSON is the default. [docs, source]
// A5 User-Agent: WHG's bot filter refuses some agents (curl's default gets 403 "Bot access denied",
//    which is NOT an answer about the token), and its docs ask for one that names the client and a
//    way to reach it. The manifest's CORS headers allow `User-Agent` and `authorization`. Browsers
//    may not send a User-Agent a page sets. [docs, live headers]
// A6 A candidate is {id, name, score (0 to 100, relative within one query), match, description
//    ("Country: XX, YY"), type [{id, name}], ccodes (ISO 3166-1 alpha-2, often []), repr_point
//    ([lon, lat] or null), has_geom (a POLYGON exists), namespace, alt_names, confidence (absent
//    when not measured), place_types, wikipedia}. [docs, source: make_candidate]
// A7 An id is "place:<namespace>:<local id>" or "place:<number>"; its persistent address is
//    https://w3id.org/whg/id/<id>. [docs]
// A8 Beside `result`, a query's object may carry `gateway` (present only when the upstream search did
//    not answer: an empty result beside it is NOT evidence that nothing matched) and `scope` (whether
//    a contained_in region was applied; `applied: false` with an empty result means the region could
//    not be applied). At the root, beside the query keys: `attribution`, and rarely `messages`.
//    [docs, source]
// A9 Data extension is supported (the manifest's `extend`; properties at GET /reconcile/properties).
//    Answer: {meta: [{id, name}], rows: {<id as sent>: {<property>: [{str: …}, …]}}}. Geometry:
//    whg:geometry_centroid (each value a string "lat, lng", LATITUDE FIRST), whg:geometry_geojson,
//    whg:geometry_wkt, whg:geometry_bbox; countries: whg:countries_codes (one {str: "GB"} per code).
//    A value that is a list of objects comes as ONE {str} holding the list as JSON text (wrap_value).
//    Ids answered by WHG's upstream gateway (not its own database) may come back in another shape,
//    which the source does not show. A WHG-native place (place:NNN) may have no centroid while its
//    GeoNames or OSM siblings in the same result do. [docs, source]

export const WHG_ENDPOINT = 'https://whgazetteer.org/reconcile';
/** WHG's own limit of queries per request (A3). */
export const WHG_BATCH_LIMIT = 50;
/** How a request body is written (A4). */
export const WHG_ENCODING = 'json';

/**
 * What a query's answer says beyond its candidates (A8): `unanswered` when the service could not
 * search for it (or left it out), and the `scope` it applied, if any.
 */
export function answerStatus(obj) {
  const ok = obj !== null && typeof obj === 'object' && Array.isArray(obj.result);
  return { unanswered: !ok || Boolean(obj.gateway), scope: ok && obj.scope ? obj.scope : null };
}

/** Is this the WHG service? Its identifiers and extension values are read by WHG's rules if so. */
export function isWhg(endpoint) {
  try { return /(^|\.)whgazetteer\.org$/.test(new URL(endpoint).hostname); } catch { return false; }
}

/** A candidate's persistent address (A7): https://w3id.org/whg/id/{id}, where id is e.g. place:gn:745044. */
export function whgIri(id) {
  return typeof id === 'string' && /^(place|period):\S+$/.test(id) ? 'https://w3id.org/whg/id/' + id : null;
}

const isLon = (x) => typeof x === 'number' && Number.isFinite(x) && x >= -180 && x <= 180;
const isLat = (x) => typeof x === 'number' && Number.isFinite(x) && x >= -90 && x <= 90;

/** [lon, lat] from a candidate's repr_point (A6), or null. */
export function reprPoint(candidate) {
  const p = candidate?.repr_point;
  return Array.isArray(p) && p.length >= 2 && isLon(p[0]) && isLat(p[1]) ? [p[0], p[1]] : null;
}

const CCODE = /^[A-Za-z]{2}$/;
/**
 * A candidate's country codes (A6), upper case, or null when it gives none. From `ccodes`, else from a
 * description of the form "Country: GB, IE" (which WHG builds from the same codes).
 */
export function candidateCcodes(candidate) {
  let codes = Array.isArray(candidate?.ccodes) ? candidate.ccodes : null;
  if (!codes && typeof candidate?.description === 'string') {
    const m = /^Countr(?:y|ies):\s*(.*)$/.exec(candidate.description.trim());
    if (m) codes = m[1].split(/[\s,;]+/);
  }
  const out = (codes || []).filter((c) => typeof c === 'string' && CCODE.test(c)).map((c) => c.toUpperCase());
  return out.length ? [...new Set(out)] : null;
}

/** [lon, lat] from a whg:geometry_centroid value (A9), "lat, lng" (latitude first), or null. */
export function parseCentroid(text) {
  if (typeof text !== 'string') return null;
  const m = /^\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s*,\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s*$/i.exec(text);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  return isLon(lon) && isLat(lat) ? [lon, lat] : null;
}

const GEOJSON_TYPES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection']);
/**
 * GeoJSON geometries from the values of whg:geometry_geojson (A9): each value may be a geometry, a list
 * of them, or either as JSON text (WHG sends the list as one JSON string). Anything else is dropped.
 */
export function parseGeojsonValues(values) {
  const out = [];
  const take = (v) => {
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return; } }
    if (Array.isArray(v)) { v.forEach(take); return; }
    if (v && typeof v === 'object' && GEOJSON_TYPES.has(v.type)) out.push(v);
  };
  (Array.isArray(values) ? values : [values]).forEach(take);
  return out;
}
