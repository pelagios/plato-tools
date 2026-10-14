// Tracing a historical map into a new dataset (Chora's "Trace into a new dataset", and Methodos's "Trace a
// historical map"): an empty dataset made from the map (its "seed"), a new place from each feature traced,
// each place's address minted under the base address by the address scheme (src/engine/agora/address.js),
// and one attestation of each feature, with its names, its geometries, its kinds and the map's date.
//
// Chora's own path for a drawing of a place the dataset has (newGeometryAttestation, draw.js) is not
// changed: featureAttestation wraps what it makes, and adds the names, kinds and date. Every rule PLATO
// makes of a geometry is still newGeometryAttestation's. Pure: no DOM, nothing fetched.
import { newGeometryAttestation, DrawError } from './draw.js';
import { scheme, keyProblem, normaliseBase } from '../agora/address.js';

/**
 * What a feature traced from a map is taken to be until the user says otherwise, by its shape (decided
 * per map, editable per feature, and marked as defaulted, as trace.js's TRACED_POINT_DEFAULTS are): a point
 * stands for the place, its position approximate; a line or an area is the feature's extent, approximate
 * (a line is an Itinerary only when it is a route, which the user says).
 */
export const TRACED_DEFAULTS = Object.freeze({
  point: Object.freeze({ role: 'RepresentativePoint', precision: 'approximate' }),
  line: Object.freeze({ role: 'Extent', precision: 'approximate' }),
  area: Object.freeze({ role: 'Extent', precision: 'approximate' }),
});
/** The shape a GeoJSON geometry is, as TRACED_DEFAULTS are keyed: 'point', 'line' or 'area'. */
export const shapeOf = (geojson) => (/Point$/.test(geojson?.type) ? 'point' : /LineString$/.test(geojson?.type) ? 'line' : 'area');

const AAT = 'http://vocab.getty.edu/aat/';
/**
 * The kinds offered for a feature traced, a short fixed list, each a Getty AAT concept (its IRI checked
 * against AAT, 14 October 2026), written as a type { label, identifier }: the identifier is what Krisis's
 * ranking reads (kinds.js placeKinds), the label the word the list shows. Free text is the fallback, a
 * type with a label alone; a kind is never required.
 */
export const KINDS = Object.freeze([
  ['settlement', '300008347'], ['town', '300008375'], ['village', '300008372'], ['hamlet', '300008369'], ['farm', '300000206'],
  ['house', '300005433'], ['manor house', '300005579'], ['church', '300007466'], ['abbey', '300000642'], ['castle', '300006891'],
  ['fort', '300006909'], ['mill', '300264626'], ['windmill', '300006273'], ['bridge', '300007836'], ['road', '300008217'],
  ['river', '300008707'], ['stream', '300008699'], ['lake', '300008680'], ['wood', '300132451'], ['park', '300254248'],
  ['marketplace', '300000250'], ['parish', '300387092'], ['boundary', '300055590'], ['boundary marker', '300420986'],
].map(([label, id]) => Object.freeze({ label, identifier: AAT + id })));

/** A kind as a PLATO type: one of KINDS by its label, else free text as a label alone; null for none. */
export function kindType(kind) {
  const label = typeof kind === 'string' ? kind.trim() : typeof kind?.label === 'string' ? kind.label.trim() : '';
  if (!label) return null;
  const known = KINDS.find((k) => k.label === label.toLowerCase());
  return known ? { label: known.label, identifier: known.identifier } : { label };
}

// The script a language is written in where it is not Latin, by its primary tag: the names a map gives
// in that language may be written so, and the form then asks (decision 3: only then). A tag that names
// its script (grc-Latn) says it itself.
const SCRIPTS = {
  ar: 'Arab', fa: 'Arab', ur: 'Arab', ps: 'Arab', ota: 'Arab', ug: 'Arab', ku: 'Arab', sd: 'Arab', arb: 'Arab',
  he: 'Hebr', yi: 'Hebr', hbo: 'Hebr', lad: 'Hebr', el: 'Grek', grc: 'Grek', gmy: 'Linb', cop: 'Copt',
  ru: 'Cyrl', uk: 'Cyrl', be: 'Cyrl', bg: 'Cyrl', mk: 'Cyrl', sr: 'Cyrl', kk: 'Cyrl', ky: 'Cyrl', mn: 'Cyrl', tg: 'Cyrl', tt: 'Cyrl', ba: 'Cyrl', cv: 'Cyrl', ce: 'Cyrl', cu: 'Cyrs', orv: 'Cyrs',
  zh: 'Hani', cmn: 'Hani', yue: 'Hani', lzh: 'Hani', och: 'Hani', ltc: 'Hani', ja: 'Jpan', ojp: 'Jpan', ko: 'Kore', oko: 'Kore', okm: 'Kore',
  hi: 'Deva', sa: 'Deva', mr: 'Deva', ne: 'Deva', omr: 'Deva', bn: 'Beng', as: 'Beng', pa: 'Guru', gu: 'Gujr', or: 'Orya', ta: 'Taml', te: 'Telu', kn: 'Knda', ml: 'Mlym', si: 'Sinh',
  th: 'Thai', lo: 'Laoo', km: 'Khmr', my: 'Mymr', bo: 'Tibt', xct: 'Tibt', dz: 'Tibt', ka: 'Geor', oge: 'Geor', hy: 'Armn', xcl: 'Armn',
  am: 'Ethi', ti: 'Ethi', gez: 'Ethi', syc: 'Syrc', arc: 'Armi', oar: 'Armi', got: 'Goth', phn: 'Phnx', xpu: 'Phnx', uga: 'Ugar', egy: 'Egyp', akk: 'Xsux', sux: 'Xsux', hit: 'Xsux', peo: 'Xpeo', pal: 'Phli', sog: 'Sogd', otk: 'Orkh', dv: 'Thaa',
};
/** The script a language tag implies when it is not Latin (ISO 15924), or null: Latin, said by the tag, or not known. */
export function scriptOf(language) {
  if (typeof language !== 'string' || !language.trim()) return null;
  const parts = language.trim().split('-');
  const own = parts.slice(1).find((p) => /^[A-Za-z]{4}$/.test(p));
  if (own) { const s = own[0].toUpperCase() + own.slice(1).toLowerCase(); return s === 'Latn' ? null : s; }
  return SCRIPTS[parts[0].toLowerCase()] || null;
}
const LANGUAGE_TAG = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/;

/**
 * A place's address, minted under the base address by the address scheme: <base>place/<short id>, the
 * short id made from its label (or `romanized`, for a label in another script) as letters, digits and
 * hyphens, the first not already in `taken` (a Set of addresses) by a number after it. Throws DrawError
 * when the base is not a web address.
 */
export function mintPlaceId(base, label, taken = new Set(), { romanized } = {}) {
  const sc = scheme(base);
  if (!sc) throw new DrawError('The base address is not a web address (it begins https://), so no place can be given an address under it.');
  const stem = slugOf(label) || slugOf(romanized) || 'place';
  for (let n = 1; ; n++) {
    const key = n === 1 ? stem : `${stem}-${n}`;
    if (keyProblem(key)) continue;
    const iri = sc.place(key);
    if (!taken.has(iri)) return iri;
  }
}
/** Lower-case letters and digits joined by hyphens, accents taken off, at most 48 characters; '' for none. */
export function slugOf(text) {
  return String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
}

/**
 * The map's date, as a PLATO timespan, from what the user gives (pre-filled from the manifest's navDate):
 * a year or an ISO date (1746, 1746-05, 1746-05-01) is the start and the end; text with one year in it
 * ("about 1746") is that year, with two ("1754 to 1761") the first and the last; and the text as written
 * is its sourceLabel. Null for an empty date. A date in text with no year is kept as its sourceLabel alone.
 */
export function mapTimespan(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return null;
  if (/^-?\d{4,}(-\d{2}(-\d{2})?)?$/.test(t)) return { startEarliest: t, endLatest: t, sourceLabel: t };
  const years = [...t.matchAll(/(?<![\d-])(\d{4})(?!\d)/g)].map((m) => m[1]);
  if (!years.length) return { sourceLabel: t };
  const [a, b] = [years[0], years[years.length - 1]].sort();
  return { startEarliest: a, endLatest: b, sourceLabel: t };
}
/** What the map's date field is pre-filled with from a navDate (manifestNavDate): its year when it is 1 January at midnight, else its date. */
export function navDateWords(navDate) {
  if (typeof navDate !== 'string') return '';
  const m = /^(-?\d{4,})-(\d{2})-(\d{2})T00:00(:00(\.0+)?)?(Z|[+-]00:00)?$/.exec(navDate);
  if (m && m[2] === '01' && m[3] === '01') return m[1];
  const d = /^(-?\d{4,}-\d{2}-\d{2})/.exec(navDate);
  return d ? d[1] : '';
}

/**
 * The dataset a tracing begins with: place-centric, no places yet, a draft, its title "Places traced
 * from <the map's title>" (or `title`), its description saying so, under the base address (uriSpace), with
 * the licence given (the map's, by its rights; none when it names none). The map's credit is not here:
 * it is carried in each citation of the map (featureParts, trace.js).
 */
export function seedDataset({ mapTitle, title, licence, base } = {}) {
  const map = typeof mapTitle === 'string' && mapTitle.trim() ? mapTitle.trim() : 'a historical map';
  const b = normaliseBase(base);
  return {
    $schema: 'https://w3id.org/plato/schemas/place-centric.schema.json',
    profile: 'place-centric',
    gazetteer: {
      ...(b ? { '@id': b } : {}),
      title: typeof title === 'string' && title.trim() ? title.trim() : `Places traced from ${map}`,
      description: `The places traced from the georeferenced historical map “${map}” in PLATO tools (Chora), each as it is written and drawn on that map, citing the map and its georeference.`,
      ...(typeof licence === 'string' && /^https?:\/\/\S+$/.test(licence) ? { licence } : {}),
      status: 'draft',
      ...(b ? { uriSpace: b } : {}),
    },
    spatialEntities: [],
  };
}
/** The seed's file name: "traced-" and the map's title, short, then .json. */
export const seedName = (mapTitle) => `traced-${slugOf(mapTitle).slice(0, 40).replace(/-+$/, '') || 'map'}.json`;

/** A new place: its address, its label (a display form, not evidence) and its attestations. */
export const newPlaceRecord = ({ id, label, attestations = [] }) => ({ '@id': id, label, attestations });

function checkName(n, i) {
  const where = `Name ${i + 1}`;
  if (!n || typeof n.toponym !== 'string' || !n.toponym.trim()) throw new DrawError(`${where} is empty: give the name as the map writes it.`);
  const out = { toponym: n.toponym.trim() };
  if (n.language !== undefined && n.language !== null && n.language !== '') {
    if (typeof n.language !== 'string' || !LANGUAGE_TAG.test(n.language.trim())) throw new DrawError(`${where}: “${n.language}” is not a language tag (en, la, grc, fr-x-old…).`);
    out.language = n.language.trim();
  }
  if (n.script) {
    if (!/^[A-Z][a-z]{3}$/.test(n.script)) throw new DrawError(`${where}: “${n.script}” is not a script code of ISO 15924 (Latn, Grek, Arab…).`);
    out.script = n.script;
  }
  if (typeof n.romanized === 'string' && n.romanized.trim()) out.romanized = n.romanized.trim();
  return out;
}
function checkType(t, i) {
  const k = kindType(t);
  if (!k) throw new DrawError(`Kind ${i + 1} is empty.`);
  if (t && typeof t === 'object' && t.identifier !== undefined && t.identifier !== k.identifier) {
    if (typeof t.identifier !== 'string' || !/^https?:\/\/\S+$/.test(t.identifier)) throw new DrawError(`Kind ${i + 1}: its identifier must be a full web address.`);
    return { label: k.label, identifier: t.identifier };
  }
  return k;
}

/**
 * One attestation of a feature traced from a map (decision 4: one per feature): its names, its
 * geometries, its kinds, when (the map's date, by default), the map cited, how it was traced. Made by
 * newGeometryAttestation from the first geometry, with its citations and notes, each further geometry (a
 * label anchor, say) made the same way and taken into it; then the names, kinds and timespan added.
 * - geometries: [{ geojson, role, precision, precisionKm }], at least one;
 * - names: [{ toponym, language?, script?, romanized? }]; types: kinds (kindType's, or { label, identifier? });
 * - timespan: a PLATO timespan (mapTimespan's), or null;
 * - contributor, created, citations, notes: as newGeometryAttestation takes them.
 * Throws DrawError, in words, for anything PLATO would not accept.
 */
export function featureAttestation({ geometries, names = [], types = [], timespan = null, contributor, created, citations, notes } = {}) {
  if (!Array.isArray(geometries) || !geometries.length) throw new DrawError('A feature traced has no geometry: draw it on the map.');
  const [first, ...rest] = geometries;
  const a = newGeometryAttestation({ ...first, contributor, created, citations, notes });
  for (const g of rest) a.geometries.push(newGeometryAttestation({ ...g, contributor, created }).geometries[0]);
  const out = {};
  const ns = (names || []).map(checkName);
  if (ns.length) out.names = ns;
  out.geometries = a.geometries;
  if (timespan && typeof timespan === 'object' && Object.keys(timespan).length) out.timespans = [{ ...timespan }];
  const ts = (types || []).filter((t) => kindType(t)).map(checkType);
  if (ts.length) out.types = ts;
  return { ...out, contributor: a.contributor, created: a.created, ...(a.sources ? { sources: a.sources } : {}), ...(a.citations ? { citations: a.citations } : {}), ...(a.notes ? { notes: a.notes } : {}) };
}
