// What is particular to the World Historical Gazetteer, kept apart from the protocol (index.js), which
// any W3C reconciliation service (version 0.2) speaks. EVERY assumption the lookup makes about WHG is
// listed here, and the code that rests on one is in this file, so that a correction is made in one
// place.
//
// VERIFIED means: read in WHG's production code (whg3 at d6bda6fb8) and, where it can be seen without
// a token, probed live, 30 September 2026. OPEN means not yet established.
//
// A1 VERIFIED. Endpoint: POST https://whgazetteer.org/reconcile, for queries and for extend alike.
//    A record by itself: GET https://whgazetteer.org/entity/<id>/api, which answers a Linked Places
//    Format Feature (A10).
// A2 VERIFIED. Token: `Authorization: Bearer <token>`; without one, a POST gets 401. WHG also takes
//    the token as a query parameter; these tools never send it so, as an address ends up in logs,
//    histories and error messages.
// A3 VERIFIED. Limits. At most 50 queries a POST: more is refused with 400 and nothing is processed.
//    600 queries a minute per user, in a fixed window, counting QUERIES, not requests; beyond it,
//    429 with Retry-After. 5,000 REQUESTS a day; spent, it is a 401 whose detail is "Daily API limit
//    (5000 calls) exceeded" (kind 'quota', told from a refused token by that text; so that a
//    rewording is not taken for a refused token, a 401 or 403 whose detail says "limit" with
//    "exceed" or "quota" is taken for it too). A query's default `limit` is 100 candidates, so these
//    tools send one of their own. ONE request in flight, for the whole site has only 16 slots and
//    WHG fans each batch out itself: one per page or worker (a shared lookup per endpoint), and one
//    across tabs (a Web Lock per site), not merely one per lookup.
// A4 VERIFIED. Every query in one POST must share a `type`, or the request gets 400. VERIFIED (whg3
//    production, 2026-09-30): only place and period are types; any other is a 400 for the whole
//    batch, so it is refused here before anything is sent. "Place", "place" and
//    https://whgazetteer.org/static/whg_schema.jsonld#Place are one type (WHG reads the part after
//    the last '#', in lower case), so batches are made by that. A type is ALWAYS sent, Place when
//    none is given: a batch whose queries have no text and no type is taken for OpenRefine's type
//    guessing, answered with dummies, and its filters ignored, which breaks a search by area alone.
// A5 VERIFIED. Encoding: a JSON body `{"queries": {...}}` / `{"extend": {...}}`, as WHG documents.
//    Form-encoded `queries=` (the W3C protocol's) is accepted too, but WHG decodes a form-encoded
//    `extend` twice (Django, then unquote_plus), turning a `+` into a space, so JSON is the default.
// A6 VERIFIED. User-Agent: a bot filter refuses an agent containing any of BLOCKED_AGENTS (a valid
//    token exempts the request, but an anonymous entity request has none). CORS allows the
//    `authorization` and `User-Agent` request headers, but EXPOSES only Content-Length and
//    Content-Range: a page cannot read Retry-After, so in the browser a 429 or 503 always waits by
//    the lookup's own backoff. Browsers may also not send a User-Agent a page sets.
// A7 VERIFIED. A candidate is {id, name, score, match, description ("Country: XX, YY"), type
//    [{id, name}], ccodes (ISO 3166-1 alpha-2, often []), repr_point ([lon, lat] or null), has_geom
//    (a POLYGON exists), namespace, alt_names, confidence, place_types, wikipedia}. It carries no
//    geometry and no dates: for those, the entity (A10). `score` is relative within one response (the
//    top candidate is always about 100); `confidence` (0 to 100, the name match only) can be compared
//    across queries, but is present only for gateway candidates in fuzzy or phonetic mode.
// A8 VERIFIED. An id is "place:<namespace>:<local id>"; its persistent address is
//    https://w3id.org/whg/id/<id> (normaliseWhgIri for the other forms). A legacy cluster address,
//    https://whgazetteer.org/places/<n>/portal/, is a different thing and is left as it is.
// A9 VERIFIED. Beside `result`, a query's object may carry `error` (the query was refused, inside a
//    200: its empty result is NOT "no match"), `gateway` (the upstream search did not answer: the same)
//    and `scope` (whether a contained_in region was applied). At the root, beside the query keys:
//    `attribution` (the licences of the sources searched; a permits_commercial or no_derivatives of
//    null means unknown, never false) and, rarely, `messages`.
// A10 VERIFIED. The entity endpoint is anonymous for authority namespaces (gn, tgn, wd, osm, …),
//    throttled to 60 requests a minute per IP address. 451 means the source does not allow WHG to
//    pass its records on (body {detail, namespace, source}; kind 'unavailable'); 503 with
//    Retry-After: 30 is to be tried again. A token is sent only when one is configured, and never
//    for an authority namespace: only for WHG's own records (place:whg:…, and place:<number>, which
//    these tools take to be WHG's own too).
//    A page can read it from another origin: a GET of /entity/place:gn:2988507/api with Origin
//    https://pelagios.org answered 200 with Access-Control-Allow-Origin: * (probed 2026-09-30).
// A11 VERIFIED except where marked. Data extension (`extend`; properties at GET
//    /reconcile/properties) answers {meta: [{id, name}], rows: {<id as sent>: {<property>:
//    [{str: …}, …]}}}. whg:geometry_centroid is a string "lat, lng", LATITUDE FIRST; countries are
//    whg:countries_codes, one {str: "GB"} per code; a list of objects comes as ONE {str} holding the
//    list as JSON text. A WHG-native place may have no centroid while its GeoNames or OSM siblings do.
//    OPEN: whether whg:geometry_geojson gives full polygons for authority records, and the shape of
//    an extend row for ids answered by WHG's upstream gateway rather than its own database.

export const WHG_ENDPOINT = 'https://whgazetteer.org/reconcile';
/** Queries per POST (A3). */
export const WHG_BATCH_LIMIT = 50;
/** Candidates asked for when a query does not say (A3): WHG's own default would be 100. */
export const WHG_DEFAULT_LIMIT = 10;
/** Queries a minute, per user (A3), and entity requests a minute, per address (A10). */
export const WHG_QUERY_RATE = { limit: 600, windowMs: 60_000 };
export const WHG_ENTITY_RATE = { limit: 60, windowMs: 60_000 };
/** How a request body is written (A5). */
export const WHG_ENCODING = 'json';
/** What WHG's bot filter refuses in a User-Agent (A6). */
export const BLOCKED_AGENTS = ['curl', 'python-requests', 'Go-http-client', 'node-fetch', 'Wget', 'libwww-perl', 'Scrapy', 'ClaudeBot', 'GPTBot', 'Baidu'];

/** Would WHG's bot filter refuse this User-Agent (A6)? */
export const isBlockedAgent = (ua) => BLOCKED_AGENTS.some((b) => String(ua).toLowerCase().includes(b.toLowerCase()));

/** Is a 401's or 403's detail a spent allowance rather than a refused token (A3)? */
export function isQuotaSpent(detail) {
  const d = String(detail ?? '');
  return /daily api limit/i.test(d) || (/limit/i.test(d) && /exceed|quota/i.test(d));
}

const WHG_TYPES = { place: 'Place', period: 'Period' };
/**
 * The type WHG is sent for a query's type (A4): 'Place' or 'Period', from any of their forms, and
 * 'Place' when none is given. Any other is a TypeError, for WHG would refuse the whole batch.
 */
export function whgQueryType(type) {
  if (type == null || type === '') return 'Place';
  const t = typeof type === 'string' ? WHG_TYPES[type.slice(type.lastIndexOf('#') + 1).trim().toLowerCase()] : undefined;
  if (!t) throw new TypeError(`WHG has no type ${JSON.stringify(type)}: only Place and Period`);
  return t;
}

/**
 * What a query's answer says beyond its candidates (A9): `error` when it was refused, `unanswered`
 * when it was refused, not searched for or left out, and the `scope` applied, if any.
 */
export function answerStatus(obj) {
  const ok = obj !== null && typeof obj === 'object' && Array.isArray(obj.result);
  const error = ok && obj.error != null ? (typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error)) : null;
  return { unanswered: !ok || Boolean(obj.gateway) || error != null, error, scope: ok && obj.scope ? obj.scope : null };
}

/**
 * The root `attribution` of several answers as one (A9): each source or dataset once. Values are kept
 * as sent: a null permits_commercial or no_derivatives stays null (unknown), never becomes false.
 */
export function mergeAttribution(into, attribution) {
  if (!attribution || typeof attribution !== 'object') return into;
  const out = into ?? {};
  for (const [k, v] of Object.entries(attribution)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') Object.assign(out[k], v);
    else out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : v;
  }
  return out;
}

/** Is this the WHG service? Its identifiers and extension values are read by WHG's rules if so. */
export function isWhg(endpoint) {
  try { return /(^|\.)whgazetteer\.org$/.test(new URL(endpoint).hostname); } catch { return false; }
}

const W3ID = 'https://w3id.org/whg/id/';
/** A candidate's persistent address (A8): https://w3id.org/whg/id/{id}, where id is e.g. place:gn:745044. */
export function whgIri(id) {
  return typeof id === 'string' && /^(place|period):\S+$/.test(id) ? W3ID + id : null;
}

/**
 * A WHG address in its persistent form (A8): https://whgazetteer.org/entity/place:X/api (or without
 * /api) becomes https://w3id.org/whg/id/place:X. Anything else, a legacy cluster address
 * (/places/<n>/portal/) and a bare number included, is given back unchanged.
 */
export function normaliseWhgIri(s) {
  if (typeof s !== 'string') return s;
  const m = /^https?:\/\/(?:www\.)?whgazetteer\.org\/entity\/((?:place|period):[^/?#\s]+)(?:\/api)?\/?(?:[?#].*)?$/.exec(s.trim());
  return m ? W3ID + decodeURIComponent(m[1]) : s;
}

/** An id from a candidate id or any of its addresses (A8), or null. */
function entityId(idOrIri) {
  const s = normaliseWhgIri(String(idOrIri ?? '').trim());
  const id = s.startsWith(W3ID) ? s.slice(W3ID.length) : s;
  return /^(place|period):[^/?#\s]+$/.test(id) ? id : null;
}

/** The namespace of a candidate id, "gn" for place:gn:745044, or null for WHG's own place:<number>. */
export function namespaceOf(id) {
  const m = /^(?:place|period):([A-Za-z][\w-]*):/.exec(String(id ?? ''));
  return m ? m[1] : null;
}

/**
 * Where a record is fetched from (A1, A10), and whether a configured token may go with it: only for
 * WHG's own records, never for an authority namespace.
 */
export function entityRequest(idOrIri, endpoint) {
  const id = entityId(idOrIri);
  if (!id) return null;
  const path = id.split(':').map(encodeURIComponent).join(':');
  const ns = namespaceOf(id);
  return { id, url: new URL(`/entity/${path}/api`, endpoint).href, tokenAllowed: ns === null || ns === 'whg' };
}

const isLon = (x) => typeof x === 'number' && Number.isFinite(x) && x >= -180 && x <= 180;
const isLat = (x) => typeof x === 'number' && Number.isFinite(x) && x >= -90 && x <= 90;

/** [lon, lat] from a candidate's repr_point (A7), or null. */
export function reprPoint(candidate) {
  const p = candidate?.repr_point;
  return Array.isArray(p) && p.length >= 2 && isLon(p[0]) && isLat(p[1]) ? [p[0], p[1]] : null;
}

const CCODE = /^[A-Za-z]{2}$/;
/**
 * A candidate's country codes (A7), upper case, or null when it gives none. From `ccodes`, else from a
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

/** [lon, lat] from a whg:geometry_centroid value (A11), "lat, lng" (latitude first), or null. */
export function parseCentroid(text) {
  if (typeof text !== 'string') return null;
  const m = /^\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s*,\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s*$/i.exec(text);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  return isLon(lon) && isLat(lat) ? [lon, lat] : null;
}

const GEOJSON_TYPES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection']);
/**
 * GeoJSON geometries from the values of whg:geometry_geojson (A11): each value may be a geometry, a list
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
