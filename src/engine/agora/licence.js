// Licences that travel with a contribution (Issue #24, WHG place#158): whether what a dataset holds
// under a licence of its own may sit under the dataset's licence. An attestation's licence is that of
// the source it cites (PLATO's source `licence`, an address): Chora writes the UPSTREAM source's licence
// on a geometry adopted from a gazetteer, as https://spdx.org/licenses/<id> (src/engine/chora/adopt.js).
//
// This is a small table of the open licences a gazetteer's data is commonly given, by SPDX id, and of
// the four terms that decide whether one can be held under another: credit (BY), no commercial use
// (NC), no adaptations (ND) and share-alike (SA). It reads the licences' terms; it is not legal advice,
// and the report says so. A licence not in the table is 'unknown', never guessed at.

/**
 * Each licence's terms: `by` credit must be given; `nc` no commercial use; `nd` no adaptations; `sa`
 * what is made from it must carry the same licence, named by its family (the id without its version),
 * with `version` for the rule that a later version of the same family will do. `pd`: no conditions at
 * all (a public domain dedication or mark).
 */
const TERMS = new Map();
const add = (id, t) => TERMS.set(id.toLowerCase(), Object.freeze({ id, by: false, nc: false, nd: false, sa: null, pd: false, version: null, ...t }));
// Creative Commons 2.0 to 4.0 (each of these lets an adaptation be shared under a later version of the
// same licence, so a later version of a share-alike licence will do; 1.0 did not, and is not here).
const CC_KINDS = ['by', 'by-sa', 'by-nd', 'by-nc', 'by-nc-sa', 'by-nc-nd'];
const CC_VERSIONS = ['2.0', '2.5', '3.0', '4.0'];
for (const v of CC_VERSIONS) {
  for (const k of CC_KINDS) {
    const parts = k.split('-'), family = `CC-${k.toUpperCase()}`;
    add(`${family}-${v}`, { by: true, nc: parts.includes('nc'), nd: parts.includes('nd'), sa: parts.includes('sa') ? family : null, version: v });
  }
}
add('CC0-1.0', { pd: true });
add('CC-PDM-1.0', { pd: true });      // the Public Domain Mark, which PLATO's schema gives as its example
add('PDDL-1.0', { pd: true });
add('ODC-By-1.0', { by: true });
add('ODbL-1.0', { by: true, sa: 'ODbL', version: '1.0' });
add('OGL-UK-3.0', { by: true });      // the UK's Open Government Licence (Ordnance Survey's open data)

/** Every licence the table knows, by SPDX id, for the documentation and the tests. */
export const KNOWN_LICENCES = Object.freeze([...TERMS.values()].map((t) => t.id));

const byId = (id) => TERMS.get(String(id).toLowerCase()) || null;

/**
 * A licence, as an address or an SPDX id, as { id, ...terms } from the table, or null when it is not
 * one these tools know. Read: https://spdx.org/licenses/<id> (with or without .html or .json); a
 * Creative Commons address of version 2.0 to 4.0 (a port to one country, such as by/3.0/de, has the
 * terms of the licence it ports and is read as that), CC0 and the Public Domain Mark; the Open Data
 * Commons addresses (ODbL, ODC-By, PDDL); a bare SPDX id. 'www.', a closing '/', 'legalcode' and
 * 'deed.<lang>' are taken off first, as recogniseLicence (fair.js) takes them off.
 */
export function licenceTerms(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim();
  if (!/^https?:\/\//i.test(v)) return byId(v);
  const key = v.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '')
    .replace(/\/(legalcode(\.[a-z-]+)?|deed\.[a-z-]+)$/, '').replace(/\/+$/, '');
  let m = /^spdx\.org\/licenses\/([^/]+?)(?:\.html|\.json)?$/.exec(key);
  if (m) return byId(m[1]);
  m = /^creativecommons\.org\/licenses\/(by(?:-nc)?(?:-sa|-nd)?)\/(\d\.\d)(?:\/[a-z-]+)?$/.exec(key);
  if (m) return byId(`CC-${m[1].toUpperCase()}-${m[2]}`);
  if (key === 'creativecommons.org/publicdomain/zero/1.0') return byId('CC0-1.0');
  if (key === 'creativecommons.org/publicdomain/mark/1.0') return byId('CC-PDM-1.0');
  m = /^opendatacommons\.org\/licenses\/(odbl|by|pddl)\/1[-.]0$/.exec(key);
  if (m) return byId({ odbl: 'ODbL-1.0', by: 'ODC-By-1.0', pddl: 'PDDL-1.0' }[m[1]]);
  return null;
}

/**
 * Why something under licence `contained` may not sit under the dataset's licence `dataset` (both
 * from licenceTerms), as a list of reasons, empty when nothing is found:
 *   'nc'           it is for non-commercial use only, and the dataset's licence allows commercial use;
 *   'nd'           it may not be adapted (a copy into another dataset, changed on the way, may be one);
 *   'sa'           it is share-alike, and the dataset's licence is not the same one (or a later version);
 *   'attribution'  it asks for credit, and the dataset is in the public domain, which asks for none.
 * The same licence is never a reason. A dataset under a stricter licence than what it holds (CC BY
 * data in a CC BY-NC dataset) is no reason either: the dataset asks more than the source does.
 */
export function licenceReasons(contained, dataset) {
  if (!contained || !dataset || contained.id === dataset.id) return [];
  const out = [];
  if (contained.nc && !dataset.nc) out.push('nc');
  if (contained.nd) out.push('nd');
  if (contained.sa && !(dataset.sa === contained.sa && Number(dataset.version) >= Number(contained.version))) out.push('sa');
  if (contained.by && dataset.pd) out.push('attribution');
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
function sourcesTaken(a) {
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
 * `reasons` maps each reason (licenceReasons, or 'unknown') to the first licence that gave it, as
 * { licence (an SPDX id, or the value as written), source (its title) }. `dataset` is licenceTerms of
 * the dataset's licence, or null when that is not known: then only whether the attestation is
 * licensed is said, and no reason.
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
    const terms = given ? licenceTerms(given) : null;
    if (!terms) { if (!reasons.has('unknown')) reasons.set('unknown', { licence: given || 'none given', source: title }); continue; }
    for (const r of licenceReasons(terms, dataset)) if (!reasons.has(r)) reasons.set(r, { licence: terms.id, source: title });
  }
  return { licensed, reasons };
}
