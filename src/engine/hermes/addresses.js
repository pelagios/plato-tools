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

// ---- an address made from an id and a pattern ----------------------------------------------------
// A source that gives a place's id rather than its address (a TEI @key such as "pleiades:579885", a
// table's id column) is converted only with a pattern the user confirms, with its placeholder ({id},
// or {key}) exactly once. The id must have the shape the gazetteer's ids have (a pattern of
// GAZETTEER_PATTERNS) or, for a pattern of the user's own, only the characters an address takes
// unescaped; the address made then passes through placeAddress, as any other address does.

/** The gazetteers whose addresses can be made from an id, each with its pattern and the shape of its ids. */
export const GAZETTEER_PATTERNS = {
  pleiades: { pattern: 'https://pleiades.stoa.org/places/{id}', shape: /^\d+$/ },
  geonames: { pattern: 'https://sws.geonames.org/{id}/', shape: /^\d+$/ },
  wikidata: { pattern: 'http://www.wikidata.org/entity/{id}', shape: /^Q\d+$/ },
};
const OWN_ID = /^[A-Za-z0-9._~-]+$/;
const PLACEHOLDER = /\{(?:id|key)\}/g;

/**
 * What is wrong with a pattern, or null: 'placeholder' (not exactly one {id} or {key}), 'not-web'
 * (it does not make a web address), 'whg' (it makes a World Historical Gazetteer address, which is
 * never made from an id: WHG's codes are not its records' addresses).
 */
export function patternProblem(pattern) {
  if (typeof pattern !== 'string' || (pattern.match(PLACEHOLDER) || []).length !== 1) return 'placeholder';
  let url;
  try { url = new URL(pattern.replace(PLACEHOLDER, '0')); } catch { return 'not-web'; }
  if (!/^https?:$/.test(url.protocol) || /\s/.test(pattern)) return 'not-web';
  const host = url.hostname.toLowerCase();
  if (host === 'whgazetteer.org' || host.endsWith('.whgazetteer.org') || (host === 'w3id.org' && /^\/whg(\/|$)/i.test(url.pathname))) return 'whg';
  return null;
}

/**
 * The address a pattern makes from an id: placeAddress's result for it (so { iri }, { iri, from,
 * rules }, { iri, part } or { lost, value }), or { error } where it makes none: the pattern's own
 * problem (patternProblem), 'whg' for an id that is a WHG code ("whg:123"), 'shape' for an id that
 * does not have the shape the pattern takes.
 */
export function addressFromPattern(value, pattern) {
  const problem = patternProblem(pattern);
  if (problem) return { error: problem };
  const id = typeof value === 'string' ? value.trim() : '';
  if (/^whg:/i.test(id)) return { error: 'whg' };
  const known = Object.values(GAZETTEER_PATTERNS).find((g) => g.pattern === pattern.replace(PLACEHOLDER, '{id}'));
  if (!(known ? known.shape : OWN_ID).test(id)) return { error: 'shape' };
  return placeAddress(pattern.replace(PLACEHOLDER, id));
}
