// Krisis: the kind of a place (Issue #20; WHG place#273, #305, #142, #286), so that a parish prefers a
// parish. 16.6% of 2,200 matches accepted in a CCEd run were not places of the right kind at all
// (Windermere matched a lake, Bicester an airfield): a perfect name score cannot tell a parish from a
// sewage works named after it, and WHG's candidates carry no comparable type.
//
// What a candidate says of its kind is whg.js whgPlaceTypes(): an AAT id from Getty TGN only, and from
// every other source a bare code ("gn:P.PPL", "osm:village", "kain_par:parish", "wikidata:Q3957"). What
// the place says is its own PLATO types (an attestation's types: a table's type column is read into them),
// by address (an AAT concept) or by label ("parish").
//
// Two things are read from either, by the small tables below, made by hand and deliberately short:
// - an AAT id, where one is known: a candidate is of the place's kind when its AAT id is the place's or
//   one of its narrower ones (by the expansions bundled with Scope, scope-data.js; WHG's gateway does not
//   match types hierarchically, its aat_paths being empty, place#142);
// - a facet: settlement, division (administrative or ecclesiastical), water, landform or built. Two
//   kinds conflict only when both facets are known and differ, a settlement and a division excepted (a
//   parish and the village it is named after are commonly one place in the sources these tools serve).
//   A farm or a manor has no facet: a minor name is a farm and a hamlet as often as not.
// Nothing is ever dropped for its kind: a conflicting candidate is ranked lower, said so, and never
// accepted in bulk (guards.js). A code not in the tables is shown as it is, and decides nothing.
import { TYPE_SHORTLIST } from './scope-data.js';

export const FACETS = ['settlement', 'division', 'water', 'landform', 'built'];
/** How a candidate's kind stands to the place's: ranked in this order (lookup.js rankGazetteer). */
export const FIT_RANK = { match: 0, other: 1, unknown: 1, conflict: 2 };

const INHABITED = 'aat:300008347', CITIES = 'aat:300008389', TOWNS = 'aat:300008375', VILLAGES = 'aat:300008372', HAMLETS = 'aat:300008369';
const PARISHES = 'aat:300387092', LAKES = 'aat:300008680', AIRFIELDS = 'aat:300000679', AIRPORTS = 'aat:300000681';
// The facet of an AAT id said outright; an id not here takes the facet of the first root below whose
// bundled expansion holds it. Airports are among WHG's narrower kinds of inhabited places (by ports), and
// are built here.
const AAT_FACET = {
  [INHABITED]: 'settlement', [CITIES]: 'settlement', [TOWNS]: 'settlement', [VILLAGES]: 'settlement', [HAMLETS]: 'settlement',
  'aat:300167671': 'settlement', 'aat:300120599': 'settlement', 'aat:300387200': 'settlement',
  [PARISHES]: 'division', 'aat:300000773': 'division', 'aat:300000792': 'division', 'aat:300000771': 'division', 'aat:300000799': 'division',
  'aat:300232418': 'division', 'aat:300000707': 'division', 'aat:300236112': 'division', 'aat:300387330': 'division', 'aat:300000769': 'division',
  'aat:300008707': 'water', 'aat:300008699': 'water', [LAKES]: 'water', 'aat:300132312': 'water', 'aat:300006075': 'water',
  'aat:300008791': 'landform',
  'aat:300006891': 'built', 'aat:300000641': 'built', [AIRFIELDS]: 'built', [AIRPORTS]: 'built', 'aat:300404093': 'built',
  'aat:300000238': null, 'aat:300000206': null,
};
const FACET_ROOTS = [['aat:300008699', 'water'], ['aat:300008707', 'water'], ['aat:300008791', 'landform'], ['aat:300006891', 'built'],
  ['aat:300000641', 'built'], ['aat:300000771', 'division'], [INHABITED, 'settlement']];
/** Each shortlisted AAT id with its narrower ones (the type itself among them), as Scope bundles them. */
const CLOSURE = new Map(TYPE_SHORTLIST.map((t) => [t.id, new Set([t.id, ...t.narrower])]));
/** Is `b` the AAT kind `a`, or one of its narrower kinds (as far as the bundled expansions know)? */
export const sameOrNarrower = (a, b) => a === b || !!CLOSURE.get(a)?.has(b);
function aatFacet(id) {
  if (Object.hasOwn(AAT_FACET, id)) return AAT_FACET[id];
  for (const [root, facet] of FACET_ROOTS) if (CLOSURE.get(root)?.has(id)) return facet;
  return null;
}

// Words, as sources' codes and datasets' labels give them, in the singular, lower case, a hyphen or an
// underscore as a space: [AAT id or null, facet or null].
const WORDS = {
  'inhabited place': [INHABITED, 'settlement'], settlement: [INHABITED, 'settlement'], 'populated place': [INHABITED, 'settlement'],
  'human settlement': [INHABITED, 'settlement'], city: [CITIES, 'settlement'], town: [TOWNS, 'settlement'], 'market town': [TOWNS, 'settlement'],
  village: [VILLAGES, 'settlement'], hamlet: [HAMLETS, 'settlement'], 'isolated dwelling': [null, 'settlement'], suburb: [null, 'settlement'],
  'deserted settlement': ['aat:300167671', 'settlement'], port: ['aat:300120599', 'settlement'],
  parish: [PARISHES, 'division'], 'ancient parish': [PARISHES, 'division'], 'civil parish': [PARISHES, 'division'],
  'ecclesiastical parish': ['aat:300000773', 'division'], township: ['aat:300000792', 'division'], chapelry: [null, 'division'],
  county: ['aat:300000771', 'division'], diocese: ['aat:300000799', 'division'], hundred: [null, 'division'], wapentake: [null, 'division'],
  administrative: [null, 'division'], 'administrative division': [null, 'division'], 'local government district': [null, 'division'],
  'registration district': [null, 'division'], 'historic county': ['aat:300000771', 'division'], 'extra parochial place': [null, 'division'],
  manor: ['aat:300000238', null], farm: ['aat:300000206', null],
  river: ['aat:300008707', 'water'], stream: ['aat:300008699', 'water'], lake: [LAKES, 'water'],
  island: ['aat:300008791', 'landform'], hill: [null, 'landform'],
  canal: ['aat:300006075', 'water'], bay: [null, 'water'],
  castle: ['aat:300006891', 'built'], monastery: ['aat:300000641', 'built'], abbey: [null, 'built'], building: [null, 'built'],
  church: [null, 'built'], chapel: [null, 'built'], fort: [null, 'built'],
  aerodrome: [AIRFIELDS, 'built'], airfield: [AIRFIELDS, 'built'], airport: [AIRPORTS, 'built'],
};
// Wikidata classes WHG gives as wd candidates' types, for the words above.
const WIKIDATA = {
  Q486972: 'human settlement', Q515: 'city', Q3957: 'town', Q18511725: 'market town', Q532: 'village', Q5084: 'hamlet',
  Q102496: 'parish', Q1115575: 'civil parish', Q23397: 'lake', Q4022: 'river', Q47521: 'stream', Q23442: 'island', Q23413: 'castle',
  Q44613: 'monastery', Q1248784: 'airport',
};
// GeoNames: a feature class gives the facet; a few codes an AAT id (or, a farm, take the facet away).
const GN_CLASS = { P: 'settlement', A: 'division', H: 'water', U: 'water', T: 'landform', S: 'built', R: 'built' };
const GN_CODE = { 'P.PPLQ': ['aat:300167671', 'settlement'], 'H.LK': [LAKES, 'water'], 'H.LKS': [LAKES, 'water'], 'H.STM': ['aat:300008699', 'water'],
  'T.ISL': ['aat:300008791', 'landform'], 'S.AIRF': [AIRFIELDS, 'built'], 'S.AIRP': [AIRPORTS, 'built'], 'S.CSTL': ['aat:300006891', 'built'],
  'S.MSTY': ['aat:300000641', 'built'], 'S.FRM': ['aat:300000206', null], 'S.FRMS': ['aat:300000206', null] };

const norm = (s) => String(s ?? '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
const singulars = (w) => [w, w.replace(/ies$/, 'y'), w.replace(/(s|sh|ch|x)es$/, '$1'), w.replace(/s$/, '')];
/** [aat, facet] for a word or a label, singular or plural ("parishes (religious divisions)" is a parish), or null. */
function word(s) {
  const w = norm(s);
  if (!w) return null;
  for (const x of singulars(w)) if (Object.hasOwn(WORDS, x)) return WORDS[x];
  return null;
}
/** The reconciliation protocol's own type ("Place", WHG's schema address), which every candidate has: not a kind. */
export const isProtocolType = (t) => typeof t === 'string' && /^(place|https?:\/\/whgazetteer\.org\/static\/whg_schema\.jsonld#place)$/i.test(t.trim());

/**
 * A kind of place from one of a candidate's types (whgPlaceTypes(), or another service's type): { id, aat,
 * facet }, aat and facet null when the tables do not know the code. Null for the protocol's own type.
 */
export function kindOf(id) {
  if (typeof id !== 'string' || !id.trim() || isProtocolType(id)) return null;
  const t = id.trim();
  if (/^aat:\d+$/.test(t)) return { id: t, aat: t, facet: aatFacet(t) };
  const m = /^([^:]+):(.+)$/.exec(t);
  let hit = null;
  if (m && m[1] === 'gn') {
    const code = m[2], cls = code.split('.')[0];
    hit = GN_CODE[code] ?? (GN_CLASS[cls] !== undefined ? [/^P\.PPL/.test(code) ? INHABITED : null, GN_CLASS[cls]] : null);
  } else if (m && (m[1] === 'wikidata' || m[1] === 'wd')) hit = WIKIDATA[m[2]] ? word(WIKIDATA[m[2]]) : null;
  else hit = word(m ? m[2] : t);
  return { id: t, aat: hit?.[0] ?? null, facet: hit?.[1] ?? null };
}
const AAT_ADDRESS = /^https?:\/\/vocab\.getty\.edu\/(?:page\/)?aat\/(\d+)\/?$/i;
const WD_ADDRESS = /^https?:\/\/(?:www\.)?wikidata\.org\/(?:wiki|entity)\/(Q\d+)$/i;
/**
 * The place's own kinds, from its record in the work file (or gather()'s): its types' addresses (`typeIds`:
 * an AAT concept's, a Wikidata class's) and their labels (`types`, read as words: "parish", "Villages").
 * Each { id, aat, facet, label }, label the dataset's own word for a kind read from a label, else null. Only
 * kinds the tables know are given, those from addresses first.
 */
export function placeKinds(place) {
  const out = [];
  const add = (k, label) => { if (k && (k.aat || k.facet) && !out.some((x) => x.id === k.id)) out.push({ ...k, label: label ?? null }); };
  const ids = Array.isArray(place?.typeIds) ? place.typeIds : [], labels = Array.isArray(place?.types) ? place.types : [];
  for (const iri of ids) {
    if (typeof iri !== 'string') continue;
    const a = AAT_ADDRESS.exec(iri.trim()), w = WD_ADDRESS.exec(iri.trim());
    if (a) add(kindOf(`aat:${a[1]}`));
    else if (/^aat:\d+$/.test(iri.trim())) add(kindOf(iri.trim()));
    else if (w) add(kindOf(`wikidata:${w[1]}`));
  }
  for (const l of labels) if (typeof l === 'string' && word(l)) { const h = word(l); add({ id: `label:${norm(l)}`, aat: h[0], facet: h[1] }, l); }
  return out;
}
const compatible = (a, b) => a === b || (a === 'settlement' && b === 'division') || (a === 'division' && b === 'settlement');
/**
 * How a candidate's kind stands to the place's: { fit, place, candidate } where fit is
 *   'match'    one of the candidate's kinds is one of the place's, or narrower (by AAT);
 *   'conflict' every pair of the two's kinds has both facets known, and none goes together;
 *   'other'    known on both sides, neither of those;
 *   'unknown'  either side has no kind the tables know.
 * `place` and `candidate` are the kinds that decided it (the first pair, for 'other'), or null.
 */
export function kindFit(place, candidateTypes) {
  const mine = placeKinds(place);
  const theirs = (Array.isArray(candidateTypes) ? candidateTypes : []).map(kindOf).filter((k) => k && (k.aat || k.facet));
  if (!mine.length || !theirs.length) return { fit: 'unknown', place: mine[0] ?? null, candidate: theirs[0] ?? null };
  for (const p of mine) for (const c of theirs) if (p.aat && c.aat && sameOrNarrower(p.aat, c.aat)) return { fit: 'match', place: p, candidate: c };
  const pairs = mine.flatMap((p) => theirs.map((c) => [p, c]));
  const clash = pairs.find(([p, c]) => p.facet && c.facet && !compatible(p.facet, c.facet));
  if (clash && pairs.every(([p, c]) => p.facet && c.facet && !compatible(p.facet, c.facet))) return { fit: 'conflict', place: clash[0], candidate: clash[1] };
  return { fit: 'other', place: mine[0], candidate: theirs[0] };
}
/** The kinds a candidate in the work file says it is: its `other.types`, the protocol's own type left out. */
export const candidateTypes = (c) => (Array.isArray(c?.other?.types) ? c.other.types.filter((t) => typeof t === 'string' && !isProtocolType(t)) : []);
