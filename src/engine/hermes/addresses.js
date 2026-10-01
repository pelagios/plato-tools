// A place's address as a reader finds it, put into the form PLATO's `about` should carry.
//
// Two sets of rules, each named, and versioned together as ADDRESS_RULES (DEVELOPERS.md has the
// table; change a rule and the version changes with it, as earlier conversions then differ):
//   - canonicalAddress: the gazetteers' own forms of one address (Pleiades, GeoNames, Wikidata)
//     become the one each gazetteer gives as its place's address.
//   - World Historical Gazetteer forms. The facts come from WHG's own code
// and live probes (branch production at d6bda6fb8, checked 30 September 2026):
//   - The persistent address of one source record is https://w3id.org/whg/id/place:<ns>:<id>.
//     Reconciliation's ids ("place:gn:2988507") and the entity pages
//     (https://whgazetteer.org/entity/place:gn:2988507/api) name the same record.
//   - https://whgazetteer.org/places/<whg_id>/portal/ names a legacy union cluster, not a record.
//     whg_ids run from 12,345,678; there is no ns:id form for them, so they are kept as they are.
//   - The same path with a number below that range is a dataset record's database key in a
//     whg_id's place: Recogito Studio writes these for some search hits, and WHG answers them with
//     the wrong place or an error. Such an address is not carried over.
//   - dev.whgazetteer.org is a staging copy with its own database, not a citation target.
//   - "whg:<n>" is ambiguous (Recogito's display code for a cluster, reconciliation's database
//     key) and is not an address at all; callers already refuse it as not a web address.

/** The version of the rules below, named in every note that says an address was rewritten. */
export const ADDRESS_RULES = 'hermes-addresses 1';

// ---- canonical addresses ------------------------------------------------------------------------
// Pleiades: https://pleiades.stoa.org/places/<n>. GeoNames: https://sws.geonames.org/<n>/ (its RDF's
// address, slash included). Wikidata: http://www.wikidata.org/entity/Q<n> (its RDF's address, http).
const PLEIADES = /^(https?):\/\/pleiades\.stoa\.org\/places\/(\d+)(\/?)$/i;
// Part of a Pleiades place's record: a location or a name (/places/<n>/<slug>), a format (/json),
// or the place in Pleiades' own data (#this). Kept as given.
const PLEIADES_PART = /^https?:\/\/pleiades\.stoa\.org\/places\/\d+(?:\/?#this|\/[^/?#\s]+(?:\/[^?#\s]*)?)$/i;
const GEONAMES_PAGE = /^https?:\/\/(?:www\.)?geonames\.org\/(\d+)(?:\/[^?#\s]*)?$/i;
const GEONAMES_SWS = /^(https?):\/\/sws\.geonames\.org\/(\d+)(\/?)$/i;
const WIKIDATA_PAGE = /^https?:\/\/(?:www\.)?wikidata\.org\/wiki\/(Q\d+)$/;
const WIKIDATA_HTTPS = /^https:\/\/www\.wikidata\.org\/entity\/(Q\d+)$/;

/**
 * A gazetteer's address in the one form that gazetteer gives it: { iri, rules } when rewritten
 * (`rules` names the rules applied, in the order of DEVELOPERS.md's table), { iri, part } for part of
 * a Pleiades place's record, kept as given ('this' for #this, else 'part'), and { iri } for anything
 * else, unchanged. `value` is taken as given (placeAddress trims it first).
 */
export function canonicalAddress(value) {
  if (typeof value !== 'string') return { iri: value };
  let m;
  if ((m = PLEIADES.exec(value))) {
    const rules = [];
    if (m[1].toLowerCase() === 'http') rules.push('pleiades-https');
    if (m[3]) rules.push('pleiades-slash');
    return rules.length ? { iri: `https://pleiades.stoa.org/places/${m[2]}`, rules } : { iri: value };
  }
  if (PLEIADES_PART.test(value)) return { iri: value, part: /#this$/i.test(value) ? 'this' : 'part' };
  if ((m = GEONAMES_PAGE.exec(value))) return { iri: `https://sws.geonames.org/${m[1]}/`, rules: ['geonames-page'] };
  if ((m = GEONAMES_SWS.exec(value))) {
    if (m[1].toLowerCase() === 'http') return { iri: `https://sws.geonames.org/${m[2]}/`, rules: ['geonames-sws-https'] };
    return m[3] ? { iri: value } : { iri: `https://sws.geonames.org/${m[2]}/`, rules: ['geonames-https'] };
  }
  if ((m = WIKIDATA_PAGE.exec(value))) return { iri: `http://www.wikidata.org/entity/${m[1]}`, rules: ['wikidata-page'] };
  if ((m = WIKIDATA_HTTPS.exec(value))) return { iri: `http://www.wikidata.org/entity/${m[1]}`, rules: ['wikidata-https'] };
  return { iri: value };
}

/** The note on a record whose address was rewritten: what the source wrote, and by which rules. */
export function addressNote({ from, rules = [] }) {
  return `Place address given as ${from} (${rules.length > 1 ? 'rules' : 'rule'} ${rules.join(' and ')}, ${ADDRESS_RULES})`;
}

// ---- World Historical Gazetteer -----------------------------------------------------------------
const W3ID = 'https://w3id.org/whg/id/';
const FIRST_WHG_ID = 12345678;
const CURIE = /^place:[a-z][a-z0-9_]*:\S+$/i;
const ENTITY = /^https?:\/\/(?:www\.)?whgazetteer\.org\/entity\/(place:[a-z][a-z0-9_]*:[^/?#\s]+)(?:\/(?:api\/?)?)?$/i;
const PORTAL = /^https?:\/\/(?:www\.)?whgazetteer\.org\/places\/(\d+)\/portal\/?$/i;
const STAGING = /^https?:\/\/dev\.whgazetteer\.org\//i;

/**
 * The address to carry for a place identifier, as { iri } when it is usable as it stands, { iri,
 * from, rules } when it was rewritten (`from` is what the source wrote, `rules` the rules applied:
 * addressNote words them), { iri, part } for part of a Pleiades place's record, carried as given and
 * to be reported (address-pleiades-part), or { lost, value } when it must not be carried over, `lost`
 * naming why ('whg-portal-record' | 'whg-staging'). Anything else passes through unchanged as
 * { iri: value }, for the caller's own checks. The canonical rules come first, then WHG's; no
 * address matches both.
 */
export function placeAddress(value) {
  if (typeof value !== 'string') return { iri: value };
  const v = value.trim();
  const c = canonicalAddress(v);
  if (c.part) return { iri: v, part: c.part };
  if (c.rules) return { iri: c.iri, from: v, rules: c.rules };
  if (CURIE.test(v)) return { iri: W3ID + v, from: v, rules: ['whg-record-id'] };
  const e = ENTITY.exec(v);
  if (e) return { iri: W3ID + e[1], from: v, rules: ['whg-entity-page'] };
  const p = PORTAL.exec(v);
  if (p && Number(p[1]) < FIRST_WHG_ID) return { lost: 'whg-portal-record', value: v };
  if (STAGING.test(v)) return { lost: 'whg-staging', value: v };
  return { iri: v };
}

// ---- addresses made from ids, through a pattern -------------------------------------------------
// A source that gives a place's id rather than its address (a TEI @key such as "pleiades:579885", a
// table's id column) is converted only through a pattern the user confirms, "…{id}…" ("{key}" in
// TEI's words), whose placeholder appears exactly once and is replaced by the id. The id must have
// the shape the gazetteer's ids have (a pattern of GAZETTEER_PATTERNS: a Pleiades id is digits) or,
// for a pattern of the user's own, only the characters an address takes unescaped (PATTERN_SHAPE);
// the address made then passes through placeAddress, as any other address does.

/** The three gazetteers whose addresses are made from their ids: each pattern, and the shape its ids have. */
export const GAZETTEER_PATTERNS = {
  pleiades: { pattern: 'https://pleiades.stoa.org/places/{id}', shape: /^\d+$/ },
  geonames: { pattern: 'https://sws.geonames.org/{id}/', shape: /^\d+$/ },
  wikidata: { pattern: 'http://www.wikidata.org/entity/{id}', shape: /^Q\d+$/ },
};
/** The ids a pattern of the user's own takes. */
export const PATTERN_SHAPE = /^[A-Za-z0-9._~-]+$/;
const PLACEHOLDER = /\{(?:id|key)\}/g;
// The World Historical Gazetteer's addresses are never made from an id (a whg:<n> or a number is
// ambiguous: see the top of this file).
const WHG_HOST = /^https?:\/\/(?:[^/?#@]*\.)?whgazetteer\.org(?:[/:?#]|$)|^https?:\/\/w3id\.org\/whg(?:[/?#]|$)/i;

/** The shape a pattern's ids must have: the gazetteer's, for one of GAZETTEER_PATTERNS ({id} or {key}), else PATTERN_SHAPE. */
export function patternShape(pattern) {
  const p = typeof pattern === 'string' ? pattern.trim().replace(PLACEHOLDER, '{id}') : pattern;
  for (const g of Object.values(GAZETTEER_PATTERNS)) if (g.pattern === p) return g.shape;
  return PATTERN_SHAPE;
}

/** Whether a pattern's placeholder stands before the end of its address's host (in the scheme, or in the host itself). */
function idBeforeHost(p) {
  const i = p.search(PLACEHOLDER);
  return i >= 0 && !/^https?:\/\/[^/?#]+[/?#]/i.test(p.slice(0, i));
}

/**
 * What is wrong with a pattern, as a code, or null: 'placeholder' (not text, or not exactly one {id}
 * or {key}), 'not-web' (it does not make a web address, or has a space, or its placeholder is not
 * after the whole of the address's scheme and host), 'whg' (it makes a World
 * Historical Gazetteer address, which is never made from an id: WHG's codes are not its records'
 * addresses). patternProblem gives the same in words.
 */
export function patternFault(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim() || (pattern.match(PLACEHOLDER) || []).length !== 1) return 'placeholder';
  const p = pattern.trim();
  // Everything before the placeholder must be a whole scheme and host, so that no id can change the
  // host (https://{id}/… with the id whgazetteer.org would make a WHG address).
  if (idBeforeHost(p)) return 'not-web';
  const sample = p.replace(PLACEHOLDER, '1');
  let url;
  try { url = new URL(sample); } catch { return 'not-web'; }
  if (!/^https?:$/.test(url.protocol) || /\s/.test(sample) || !/^https?:\/\/[^\s/?#]+\S*$/i.test(sample)) return 'not-web';
  const host = url.hostname.toLowerCase();
  if (WHG_HOST.test(sample) || host === 'whgazetteer.org' || host.endsWith('.whgazetteer.org') || (host === 'w3id.org' && /^\/whg(\/|$)/i.test(url.pathname))) return 'whg';
  return null;
}

/**
 * What is wrong with a pattern, in words, or null when nothing is: it must be text with its
 * placeholder ({id}, or {key}) exactly once, make a web address, and not be one of the World
 * Historical Gazetteer's. The same verdicts as patternFault.
 */
export function patternProblem(pattern) {
  const fault = patternFault(pattern);
  if (!fault) return null;
  if (typeof pattern !== 'string' || !pattern.trim()) return 'the pattern is not text';
  if (fault === 'placeholder') {
    const n = (pattern.match(PLACEHOLDER) || []).length;
    return `the pattern ${pattern} has ${n ? 'more than one' : 'no'} {id} in it, where it needs one, which the id replaces`;
  }
  if (fault === 'not-web') return idBeforeHost(pattern.trim()) && /^https?:\/\//i.test(pattern.trim())
    ? `the pattern ${pattern} puts the id in the address's host: the id must come after the address's host`
    : `the pattern ${pattern} does not make a web address (http or https)`;
  return `the pattern ${pattern} is the World Historical Gazetteer's, whose addresses are never made from an id (a number, or whg: and a number, names no one record)`;
}

/**
 * The address made from an id through a pattern: placeAddress's result for the address made (so
 * { iri }, { iri, from, rules }, { iri, part } or { lost, value }: a gazetteer's other forms become
 * its one form), or { lost: 'shape', value } when the id does not have `shape` (patternShape(pattern)
 * when none is given). whg:<n> never has a shape. A pattern that cannot be used gives
 * { error: patternFault(pattern) }; callers are expected to have refused it already.
 */
export function addressFromPattern(value, pattern, { shape } = {}) {
  const fault = patternFault(pattern);
  if (fault) return { error: fault };
  const v = typeof value === 'string' ? value.trim() : String(value ?? '');
  const s = shape || patternShape(pattern);
  if (/^whg:/i.test(v) || !s.test(v)) return { lost: 'shape', value: v };
  return placeAddress(pattern.trim().replace(PLACEHOLDER, v));
}
