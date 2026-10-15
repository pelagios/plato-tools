// Licences that travel with a contribution (Issue #24, WHG place#158): whether what a dataset holds
// under a licence of its own may sit under the dataset's licence. An attestation's licence is that of
// the source it cites (PLATO's source `licence`, an address): Chora writes the UPSTREAM source's licence
// on a geometry adopted from a gazetteer, as https://spdx.org/licenses/<id> (src/engine/chora/adopt.js),
// and a map's licence on a drawing traced from it (src/engine/chora/trace.js).
//
// This is a small table of the open licences a gazetteer's data is commonly given, by SPDX id, and of
// the four terms that decide whether one can be held under another: credit (BY), no commercial use
// (NC), no adaptations (ND) and share-alike (SA). It reads the licences' terms; it is not legal advice,
// and the report says so. A licence not in the table is 'unknown', never guessed at. The same table is
// the one the report's FAIR check and the deposit files know a dataset's own licence by (fair.js
// recogniseLicence), so that one report has one meaning of "a licence these tools know".

/**
 * Each licence's terms: `by` credit must be given; `nc` no commercial use; `nd` no adaptations; `sa`
 * what is made from it must carry the same licence, named by its family (the id without its version),
 * with `version` for the rule that a later version of the same family will do. `pd`: no conditions at
 * all (a public domain dedication or mark). `name` is the licence's own full name, which DataCite is given.
 */
const TERMS = new Map();
const add = (id, name, t) => TERMS.set(id.toLowerCase(), Object.freeze({ id, name, by: false, nc: false, nd: false, sa: null, pd: false, version: null, ...t }));
// Creative Commons 2.0 to 4.0 (each of these lets an adaptation be shared under a later version of the
// same licence, so a later version of a share-alike licence will do; 1.0 did not, and is not here).
const CC_KINDS = ['by', 'by-sa', 'by-nd', 'by-nc', 'by-nc-sa', 'by-nc-nd'];
const CC_WORDS = { sa: '-ShareAlike', nd: '-NoDerivatives', nc: '-NonCommercial' };
const CC_SCOPE = { '2.0': 'Generic', '2.5': 'Generic', '3.0': 'Unported', '4.0': 'International' };
for (const v of Object.keys(CC_SCOPE)) {
  for (const k of CC_KINDS) {
    const parts = k.split('-'), family = `CC-${k.toUpperCase()}`;
    // Before 4.0, ND is "NoDerivs" in the licences' names.
    const words = parts.slice(1).map((p) => (p === 'nd' && v !== '4.0' ? '-NoDerivs' : CC_WORDS[p])).join('');
    add(`${family}-${v}`, `Creative Commons Attribution${words} ${v} ${CC_SCOPE[v]}`,
      { by: true, nc: parts.includes('nc'), nd: parts.includes('nd'), sa: parts.includes('sa') ? family : null, version: v });
  }
}
add('CC0-1.0', 'Creative Commons Zero v1.0 Universal', { pd: true });
add('CC-PDM-1.0', 'Creative Commons Public Domain Mark 1.0 Universal', { pd: true });   // PLATO's schema's example
add('PDDL-1.0', 'Open Data Commons Public Domain Dedication & License 1.0', { pd: true });
add('ODC-By-1.0', 'Open Data Commons Attribution License v1.0', { by: true });
add('ODbL-1.0', 'Open Data Commons Open Database License v1.0', { by: true, sa: 'ODbL', version: '1.0' });
add('OGL-UK-3.0', 'Open Government Licence v3.0', { by: true });   // the UK's (Ordnance Survey's open data)

/** Every licence the table knows, by SPDX id, for the documentation and the tests. */
export const KNOWN_LICENCES = Object.freeze([...TERMS.values()].map((t) => t.id));

const byId = (id) => TERMS.get(String(id).toLowerCase()) || null;

/**
 * A licence's address as these tools compare it: lower case, without the scheme, 'www.', a query or
 * fragment, a closing '/', 'legalcode' (and its language) or 'deed.<locale>' (deed.en, deed.pt_BR).
 * Null for anything not an http(s) address. Shared with fair.js's recogniseLicence.
 */
export function licenceKey(uri) {
  if (typeof uri !== 'string' || !/^https?:\/\//i.test(uri.trim())) return null;
  return uri.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '')
    .replace(/\/(legalcode(\.[a-z_-]+)?|deed\.[a-z_-]+)$/, '').replace(/\/+$/, '');
}

/**
 * A licence, as an address or an SPDX id, as { id, name, ...terms } from the table, with `port` (the
 * country's code) for a Creative Commons licence ported to one country's law, which has the terms of
 * the licence it ports and is read as that; or null when it is not one these tools know. Read:
 * https://spdx.org/licenses/<id> (with or without .html or .json); a Creative Commons address of
 * version 2.0 to 4.0, CC0 and the Public Domain Mark; the Open Data Commons addresses (ODbL, ODC-By and
 * PDDL, with or without the version, of which there is only 1.0); the Open Government Licence v3.0's
 * address at the National Archives; a bare SPDX id.
 */
export function licenceTerms(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const key = licenceKey(value);
  if (key === null) return byId(value.trim());
  let m = /^spdx\.org\/licenses\/([^/]+?)(?:\.html|\.json)?$/.exec(key);
  if (m) return byId(m[1]);
  m = /^creativecommons\.org\/licenses\/(by(?:-nc)?(?:-sa|-nd)?)\/(\d\.\d)(?:\/([a-z-]+))?$/.exec(key);
  if (m) { const t = byId(`CC-${m[1].toUpperCase()}-${m[2]}`); return t && m[3] ? { ...t, port: m[3] } : t; }
  if (key === 'creativecommons.org/publicdomain/zero/1.0') return byId('CC0-1.0');
  if (key === 'creativecommons.org/publicdomain/mark/1.0') return byId('CC-PDM-1.0');
  m = /^opendatacommons\.org\/licenses\/(odbl|by|pddl)(?:\/1[-.]0)?$/.exec(key);
  if (m) return byId({ odbl: 'ODbL-1.0', by: 'ODC-By-1.0', pddl: 'PDDL-1.0' }[m[1]]);
  if (/^nationalarchives\.gov\.uk\/doc\/open-government-licence\/version\/3$/.test(key)) return byId('OGL-UK-3.0');
  return null;
}

/**
 * A rights statement (rightsstatements.org), which says what is known of a work's copyright (In
 * Copyright, No Copyright - United States, …) and is not a licence: it grants nothing. Its short form
 * ('InC 1.0'), or null for anything else.
 */
export function rightsStatement(value) {
  if (typeof value !== 'string') return null;
  const m = /^https?:\/\/(?:www\.)?rightsstatements\.org\/(?:vocab|page)\/([A-Za-z-]+)\/(\d\.\d)\/?(?:[?#].*)?$/.exec(value.trim());
  return m ? `${m[1]} ${m[2]}` : null;
}

/**
 * Why something under licence `contained` may not sit under the dataset's licence `dataset` (both
 * from licenceTerms), as a list of reasons, empty when nothing is found:
 *   'nc'           it is for non-commercial use only, and the dataset's licence allows commercial use;
 *   'nd'           it may not be adapted (a copy into another dataset, changed on the way, may be one),
 *                  whatever the dataset's licence, its own included: a dataset under the same ND licence
 *                  still holds a copy that may have been changed;
 *   'sa'           it is share-alike, and the dataset's licence is not the same one (or a later version);
 *   'attribution'  it asks for credit, and the dataset is in the public domain, which asks for none.
 * Under the same licence, only ND is a reason. A dataset under a stricter licence than what it holds
 * (CC BY data in a CC BY-NC dataset) is no reason either: the dataset asks more than the source does.
 */
export function licenceReasons(contained, dataset) {
  if (!contained || !dataset) return [];
  const same = contained.id === dataset.id;
  const out = [];
  if (!same && contained.nc && !dataset.nc) out.push('nc');
  if (contained.nd) out.push('nd');
  if (!same && contained.sa && !(dataset.sa === contained.sa && Number(dataset.version) >= Number(contained.version))) out.push('sa');
  if (!same && contained.by && dataset.pd) out.push('attribution');
  return out;
}

// ---- in a dataset ------------------------------------------------------------------------------

const CITES_FOR_INFORMATION = 'http://purl.org/spar/cito/citesForInformation';
const CITES_AS_EVIDENCE = 'http://purl.org/spar/cito/citesAsEvidence';
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/**
 * The sources an attestation takes something from, each as { source, copied }: those in `sources`,
 * and those its citations cite, except a citation for information only (cito:citesForInformation,
 * Chora's record consulted but not copied). `copied` is a geometry cited as evidence from a source that
 * is a dataset (what Chora's adoption writes). The source a source was derived from is not read: its
 * licence is the original's, not that of the copy cited.
 */
export function sourcesTaken(a) {
  const out = [];
  for (const s of list(a.sources)) if (isObject(s)) out.push({ source: s, copied: false });
  const geometry = list(a.geometries).length > 0;
  for (const c of list(a.citations)) {
    if (!isObject(c) || !isObject(c.source) || c.citationFunction === CITES_FOR_INFORMATION) continue;
    out.push({ source: c.source, copied: geometry && c.citationFunction === CITES_AS_EVIDENCE && c.source.authorityType === 'dataset' });
  }
  return out;
}

/**
 * What an attestation's own licences say against the dataset's: { licensed, reasons } where
 * `licensed` is whether any source it takes from names a licence (or is a copy that should), and
 * `reasons` maps each reason (licenceReasons, 'rights-statement' or 'unknown') to the first licence
 * that gave it, as { licence (an SPDX id, a rights statement's short form, or the value as written),
 * source (its title) }. `dataset` is licenceTerms of the dataset's licence, or null when that is not
 * known: then only whether the attestation is licensed is said, and no reason.
 */
export function attestationLicences(a, dataset) {
  const reasons = new Map();
  let licensed = false;
  if (!isObject(a)) return { licensed, reasons };
  for (const { source, copied } of sourcesTaken(a)) {
    const given = typeof source.licence === 'string' && source.licence.trim() ? source.licence.trim() : null;
    if (!given && !copied) continue;
    licensed = true;
    if (!dataset) continue;
    const title = typeof source.title === 'string' ? source.title : '';
    const note = (r, licence) => { if (!reasons.has(r)) reasons.set(r, { licence, source: title }); };
    const statement = given ? rightsStatement(given) : null;
    if (statement) { note('rights-statement', `rights statement ${statement}`); continue; }
    const terms = given ? licenceTerms(given) : null;
    if (!terms) { note('unknown', given || 'none given'); continue; }
    for (const r of licenceReasons(terms, dataset)) note(r, terms.id);
  }
  return { licensed, reasons };
}
