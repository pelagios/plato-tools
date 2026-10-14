// What may be done with a georeferenced historical map and what is traced from it: one reading of its
// rights, for every tool that shows or traces such a map (Chora's historical maps, tracing a map into a
// new dataset, and a later "Make an open map"). The map's credit and licence are read from its manifest
// (attributionOf), the georeference's own licence from the annotation (annotationLicenceOf: Allmaps'
// annotations are CC0), and the two are given one verdict (rightsOf): free to reuse, not, or not known.
// Text only: a IIIF value may hold a little HTML, which is read as its words, never as markup; and only
// a licence, and only an http(s) one, is ever an address. Pure: no DOM, nothing fetched.
import { labelText } from '../georef/iiif.js';

/**
 * What the collection says of the map's use, where its manifest says nothing: by the site the map is
 * on. David Rumsey's manifests carry a credit but no licence; the licence is on its site.
 */
export const HOSTS = [
  {
    hosts: ['www.davidrumsey.com', 'davidrumsey.com'],
    credit: 'David Rumsey Map Collection, David Rumsey Map Center, Stanford University Libraries',
    licence: 'https://creativecommons.org/licenses/by-nc-sa/3.0/', licenceLabel: 'CC BY-NC-SA 3.0',
  },
];
const LICENCE_LABELS = [
  [/creativecommons\.org\/publicdomain\/zero\//, 'CC0'], [/creativecommons\.org\/publicdomain\/mark\//, 'Public Domain Mark'],
  [/creativecommons\.org\/licenses\/([a-z-]+)\/(\d\.\d)/, (m) => `CC ${m[1].toUpperCase()} ${m[2]}`],
  [/rightsstatements\.org\/vocab\/([A-Za-z-]+)\//, (m) => `RightsStatements.org ${m[1]}`],
];
/** Text only: a IIIF value may hold a little HTML, which is shown as its words, never as markup. */
function text(v) {
  const t = labelText(v);
  return t ? t.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim() || null : null;
}
const httpUri = (u) => (typeof u === 'string' && /^https?:\/\/\S+$/.test(u.trim()) ? u.trim() : null);
/** A licence's short name (CC BY 4.0, CC0, Public Domain Mark, a RightsStatements.org statement), or null. */
export function labelOfLicence(uri) {
  for (const [re, label] of LICENCE_LABELS) { const m = re.exec(uri || ''); if (m) return typeof label === 'function' ? label(m) : label; }
  return null;
}
/**
 * The credit and licence of a map: { credit, licence, licenceLabel, nonCommercial, from } from the
 * manifest (Presentation 3 requiredStatement and rights; 2 attribution and license), else from HOSTS
 * by the manifest's or the image's site. Text only; only a licence, and only an http(s) one, is ever
 * an address (the manifest's logo, thumbnail, rendering, homepage and seeAlso are never used).
 */
export function attributionOf(manifest, serviceId) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  let credit = null;
  if (m.requiredStatement) credit = text(m.requiredStatement.value) || text(m.requiredStatement.label);
  if (!credit && m.attribution !== undefined) credit = text(m.attribution);
  let licence = httpUri(m.rights) || [].concat(m.license ?? []).map(httpUri).find(Boolean) || null;
  let from = credit || licence ? 'manifest' : null;
  const hosts = [m.id ?? m['@id'], serviceId].map((u) => { try { return new URL(u).hostname; } catch { return null; } }).filter(Boolean);
  const known = HOSTS.find((h) => h.hosts.some((x) => hosts.includes(x)));
  if (known) {
    if (!credit) { credit = known.credit; from = 'table'; }
    if (!licence) { licence = known.licence; from = from === 'manifest' ? 'manifest and table' : 'table'; }
  }
  const licenceLabel = licence ? (known && licence === known.licence ? known.licenceLabel : labelOfLicence(licence)) : null;
  return { credit, licence, licenceLabel, nonCommercial: !!licence && /\/licenses\/by-nc/.test(licence), from };
}

/** CC0, the licence of every georeference Allmaps' annotation server holds (its terms of use). */
export const CC0 = 'https://creativecommons.org/publicdomain/zero/1.0/';
const ALLMAPS = /^https:\/\/annotations\.allmaps\.org\//;
/**
 * The georeference's own licence: { licence, licenceLabel, from }, from the annotation's `rights` (an
 * http(s) address) where it gives one ('annotation'), else CC0 for an annotation on Allmaps' server
 * ('allmaps'); { licence: null, … from: null } when neither says. `annotationId` is the annotation's id,
 * for one whose text is not at hand.
 */
export function annotationLicenceOf(annotation, annotationId = null) {
  const a = annotation && typeof annotation === 'object' ? annotation : {};
  const own = httpUri(a.rights);
  if (own) return { licence: own, licenceLabel: labelOfLicence(own), from: 'annotation' };
  const id = typeof (a.id ?? a['@id']) === 'string' ? a.id ?? a['@id'] : annotationId;
  if (typeof id === 'string' && ALLMAPS.test(id)) return { licence: CC0, licenceLabel: 'CC0', from: 'allmaps' };
  return { licence: null, licenceLabel: null, from: null };
}

/**
 * Whether a licence lets what is made from the work be reused by anyone, for any purpose: true for the
 * public domain (the Public Domain Mark, CC0, RightsStatements.org's NoC-US and NKC) and the Creative
 * Commons licences that allow commercial use and changes (BY, BY-SA); false for those that do not (NC,
 * ND, In Copyright); null for a licence these tools do not know, or none.
 */
export function freeToReuse(licence) {
  const l = typeof licence === 'string' ? licence : '';
  if (/creativecommons\.org\/publicdomain\/(zero|mark)\//.test(l) || /rightsstatements\.org\/vocab\/(NoC-US|NKC)\//.test(l)) return true;
  if (/creativecommons\.org\/licenses\/[a-z-]*(nc|nd)[a-z-]*\//.test(l) || /rightsstatements\.org\/vocab\/(InC|NoC-CR|NoC-NC|NoC-OKLR)/.test(l)) return false;
  if (/creativecommons\.org\/licenses\/(by|by-sa)\//.test(l)) return true;
  return null;
}

/**
 * The one reading of the rights of a georeferenced map, and of what is traced from it: { map:
 * attributionOf's, georeference: annotationLicenceOf's, free: true | false | null, words }. `free` is true
 * when both the map's licence and the georeference's let anyone reuse what is made from them, false when
 * either does not, null when either is not known (a manifest that names no licence). `words` say it
 * plainly, for the page.
 */
export function rightsOf({ manifest = null, serviceId = null, annotation = null, annotationId = null } = {}) {
  const map = attributionOf(manifest, serviceId);
  const georeference = annotationLicenceOf(annotation, annotationId);
  const m = freeToReuse(map.licence), g = freeToReuse(georeference.licence);
  const free = m === false || g === false ? false : m === true && g === true ? true : null;
  const named = (x, what) => (x.licence ? `${what} is licensed ${x.licenceLabel || x.licence}` : `${what} names no licence`);
  // A credit that says the map is free in words ("Public Domain", "No known restrictions") is not a licence: said so.
  const inWords = !map.licence && map.credit && /public domain|no known (copyright )?restrictions/i.test(map.credit);
  if (free === null && inWords) {
    return { map, georeference, free, words: `Not known to be free to reuse: the map's credit says “${map.credit}”, which is not a licence, and ${named(georeference, 'its georeference')}. Check the holder's terms before you publish what you trace from it.` };
  }
  const words = free === true ? `Free to reuse: ${named(map, 'the map')}, and ${named(georeference, 'its georeference')}.`
    : free === false ? `Not free to reuse as it is: ${named(map, 'the map')}, and ${named(georeference, 'its georeference')}. This may bear on how what you trace from it can be reused.`
    : `Not known to be free to reuse: ${named(map, 'the map')}, and ${named(georeference, 'its georeference')}. Check the holder's terms before you publish what you trace from it.`;
  return { map, georeference, free, words };
}
