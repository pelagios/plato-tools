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
//    across tabs (a Web Lock per site, 'plato-tools:gazetteer:whgazetteer.org' with or without
//    www.), not merely one per lookup. The 600 a minute is one allowance for every tab and worker of
//    an origin where there are Web Locks and IndexedDB (the pacer's ledger is kept there and used
//    only holding the lock); in Node, and anywhere without IndexedDB, it is per lookup. Other
//    origins and other programs with the same token are not counted: a 429 is still handled.
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
// A12 BUILT, NOT YET LIVE (place#323, built 10 October 2026, as WHG's session reported it). A query's
//    `area_only: true` keeps only candidates with at least one areal geometry, by the same test as
//    `has_geom` and containment: a filter, not a ranking, so `limit` still asks for that many areas.
//    Candidates come from the top 200 name matches only, and WHG's legacy index (which has no shape
//    flag) is not searched. A point-only record (a GeoNames town) cannot scope a lookup within it:
//    WHG then refuses the scoped query (scope.applied false), so a region is matched to areas only.
// A13 BUILT, NOT YET LIVE (place#324, as A12). A query's `lang`, an ISO 639-1 or 639-3 code, shapes
//    WHG's own embedding of the name (its name model, Symphonym); WHG takes anything not two or three
//    letters for "und" (undetermined), never an error. There is no other way to state a language, so
//    these tools send one only when it is known, and never "und".

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

// Language codes (A13). A three-letter code of a language that also has a two-letter one (ISO 639-2/T
// and /B, 639-3) is sent as the two-letter one, eng as en, ger and deu as de: from pycountry 24.6.1's
// ISO 639-3 table, all 204 such codes.
const TO_639_1 = new Map((
  'aar:aa abk:ab afr:af aka:ak alb:sq amh:am ara:ar arg:an arm:hy asm:as ava:av ave:ae aym:ay aze:az bak:ba ' +
  'bam:bm baq:eu bel:be ben:bn bis:bi bod:bo bos:bs bre:br bul:bg bur:my cat:ca ces:cs cha:ch che:ce chi:zh ' +
  'chu:cu chv:cv cor:kw cos:co cre:cr cym:cy cze:cs dan:da deu:de div:dv dut:nl dzo:dz ell:el eng:en epo:eo ' +
  'est:et eus:eu ewe:ee fao:fo fas:fa fij:fj fin:fi fra:fr fre:fr fry:fy ful:ff geo:ka ger:de gla:gd gle:ga ' +
  'glg:gl glv:gv gre:el grn:gn guj:gu hat:ht hau:ha hbs:sh heb:he her:hz hin:hi hmo:ho hrv:hr hun:hu hye:hy ' +
  'ibo:ig ice:is ido:io iii:ii iku:iu ile:ie ina:ia ind:id ipk:ik isl:is ita:it jav:jv jpn:ja kal:kl kan:kn ' +
  'kas:ks kat:ka kau:kr kaz:kk khm:km kik:ki kin:rw kir:ky kom:kv kon:kg kor:ko kua:kj kur:ku lao:lo lat:la ' +
  'lav:lv lim:li lin:ln lit:lt ltz:lb lub:lu lug:lg mac:mk mah:mh mal:ml mao:mi mar:mr may:ms mkd:mk mlg:mg ' +
  'mlt:mt mon:mn mri:mi msa:ms mya:my nau:na nav:nv nbl:nr nde:nd ndo:ng nep:ne nld:nl nno:nn nob:nb nor:no ' +
  'nya:ny oci:oc oji:oj ori:or orm:om oss:os pan:pa per:fa pli:pi pol:pl por:pt pus:ps que:qu roh:rm ron:ro ' +
  'rum:ro run:rn rus:ru sag:sg san:sa sin:si slk:sk slo:sk slv:sl sme:se smo:sm sna:sn snd:sd som:so sot:st ' +
  'spa:es sqi:sq srd:sc srp:sr ssw:ss sun:su swa:sw swe:sv tah:ty tam:ta tat:tt tel:te tgk:tg tgl:tl tha:th ' +
  'tib:bo tir:ti ton:to tsn:tn tso:ts tuk:tk tur:tr twi:tw uig:ug ukr:uk urd:ur uzb:uz ven:ve vie:vi vol:vo ' +
  'wel:cy wln:wa wol:wo xho:xh yid:yi yor:yo zha:za zho:zh zul:zu '
  ).trim().split(' ').map((p) => p.split(':')));
const COLLECTIVE = new Set((
  'aav afa alg alv apa aqa aql art ath auf aus awd azc bad bai bat ber bh bih bnt btk cai cau cba ccn ccs ' +
  'cdc cdd cel cmc cpe cpf cpp crp csu cus day dmn dra egx esx euq fiu fox gem gme gmq gmw grk hmx hok hyx ' +
  'iir ijo inc ine ira iro itc jpx kar kdo khi kro map mkh mno mun myn nah nai ngf nic nub omq omv oto paa ' +
  'phi plf poz pqe pqw pra qwe roa sai sal sdv sem sgn sio sit sla smi son sqj ssa syd tai tbq trk tup tut ' +
  'tuw urj wak wen xgn xnd ypk zhx zle zls zlw znd '
  ).trim().split(' '));
// ISO 639-2 and 639-5 collective codes (families and groups: art, cel, sgn, and bh among two-letter
// ones) name no one language, and are not sent.
// Tags that are not one language: "und" undetermined, "mis" uncoded, "mul" several, "zxx" no linguistic
// content. A name tagged und or mis is taken as untagged; one tagged mul or zxx is sent with no language.
const NO_LANGUAGE = new Set(['und', 'mul', 'mis', 'zxx']);
const UNTAGGED = new Set(['und', 'mis']);
// BCP 47's grandfathered tags (RFC 5646, 2.2.8), irregular and regular: none is read as a language.
const GRANDFATHERED = new Set(['en-gb-oed', 'i-ami', 'i-bnn', 'i-default', 'i-enochian', 'i-hak', 'i-klingon', 'i-lux', 'i-mingo',
  'i-navajo', 'i-pwn', 'i-tao', 'i-tay', 'i-tsu', 'sgn-be-fr', 'sgn-be-nl', 'sgn-ch-de', 'art-lojban', 'cel-gaulish', 'no-bok',
  'no-nyn', 'zh-guoyu', 'zh-hakka', 'zh-min', 'zh-min-nan', 'zh-xiang']);
/**
 * The code WHG is sent for a language tag (A13), or null when it names no one language and nothing is
 * sent. Only the tag's primary subtag is read, in lower case: its script and region are left out,
 * "en" for "en-GB" and "la" for "la-Latn", for WHG takes a bare code. A three-letter code with a
 * two-letter equivalent is sent as that (eng as en). A collective code, a grandfathered tag, und, mis,
 * mul, zxx and anything not two or three letters give null.
 */
export function whgLang(tag) {
  if (typeof tag !== 'string') return null;
  const t = tag.trim().toLowerCase().replace(/_/g, '-');
  if (GRANDFATHERED.has(t)) return null;
  const primary = t.split('-')[0];
  if (!/^[a-z]{2,3}$/.test(primary) || NO_LANGUAGE.has(primary) || COLLECTIVE.has(primary)) return null;
  return TO_639_1.get(primary) ?? primary;
}
/**
 * What a name's own tag says of its language (A13): 'untagged' when it has none, or says und or mis
 * (the dataset's language may then stand in), 'none' when it says mul or zxx (sent with no language),
 * else the code whgLang() gives; a tag that names no one language otherwise counts as untagged.
 */
export function nameLang(tag) {
  if (typeof tag !== 'string' || !tag.trim()) return 'untagged';
  const primary = tag.trim().toLowerCase().replace(/_/g, '-').split('-')[0];
  if (UNTAGGED.has(primary)) return 'untagged';
  if (NO_LANGUAGE.has(primary)) return 'none';
  return whgLang(tag) ?? 'untagged';
}

/** The type sent when a query gives none (A4). */
export const WHG_PLACE_TYPE = 'Place';
const WHG_TYPES = { place: WHG_PLACE_TYPE, period: 'Period' };
/**
 * The type WHG is sent for a query's type (A4): 'Place' or 'Period', from any of their forms, and
 * 'Place' when none is given. Any other is a TypeError, for WHG would refuse the whole batch.
 */
export function whgQueryType(type) {
  if (type == null || type === '') return WHG_PLACE_TYPE;
  const t = typeof type === 'string' ? WHG_TYPES[type.slice(type.lastIndexOf('#') + 1).trim().toLowerCase()] : undefined;
  if (!t) throw new TypeError(`WHG has no type ${JSON.stringify(type)}: a query's type must be a string, 'Place' or 'Period' (or its schema address)`);
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
/** The characters of a WHG id after its kind ("gn:745044"): up to a slash, query, fragment or space. */
const ID_CHARS = '[^/?#\\s]+';
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
  const m = new RegExp(`^https?://(?:www\\.)?whgazetteer\\.org/entity/((?:place|period):${ID_CHARS})(?:/api)?/?(?:[?#].*)?$`).exec(s.trim());
  return m ? W3ID + decodeURIComponent(m[1]) : s;
}

/** An id from a candidate id or any of its addresses (A8), or null. */
function entityId(idOrIri) {
  const s = normaliseWhgIri(String(idOrIri ?? '').trim());
  const id = s.startsWith(W3ID) ? s.slice(W3ID.length) : s;
  return new RegExp(`^(place|period):${ID_CHARS}$`).test(id) ? id : null;
}
/**
 * The bare id of a WHG place address, as contained_in takes it ("gn:2644974"): from its persistent form
 * or a legacy entity URL, a last "/" and any query or fragment left out. Null for anything else.
 */
export function whgPlaceId(iri) {
  const m = new RegExp(`^${W3ID.replace(/[.]/g, '\\.')}place:(${ID_CHARS})/?(?:[?#].*)?$`).exec(normaliseWhgIri(String(iri ?? '').trim()));
  return m ? decodeURIComponent(m[1]) : null;
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
