// Krisis: Wikidata items for the places no gazetteer knows (Issue #36; plan #34, item 9; Stephen's decisions
// of 15 October 2026). After a review, the places left with no match are searched in Wikidata once more
// (wikidata-search.js: by name, and near the point), and the hits go through the ordinary review. For those
// still with no match, a QuickStatements batch is written (v1 text, which the user runs in QuickStatements
// with their own Wikidata account: these tools never write to Wikidata), and once the items exist their
// Q-ids come back (pasted, or read from the user's own new items), are checked against the batch (the
// label, the point within VERIFY_KM, our reference on the item) and recorded as decisions in the work
// file, which Finish writes as identity attestations like any other (identity.js, apply.js).
//
// Everything of it lives in the work file, under `mint` (checkMint, below): the consent statement, the
// options, each item's description and kind as edited, the batches written and the Q-ids recorded.
//
// Kept light (no pipeline): the page runs it on its main thread, beside the lookup. The dataset's records
// (the names with their languages, the points, the dates, the sources cited) are read by the worker or the
// command line through mintCollector(), a sink for run(), and handed over.
//
// The licence gate (D3). Wikidata is CC0. A dataset in the public domain (CC0, the Public Domain Mark,
// PDDL) passes; one asking credit or share-alike (CC BY, BY-SA, ODbL, ODC-By, the OGL) needs the user's
// statement, CONSENT, recorded with the date; no commercial use, no adaptations, a rights statement, no
// licence or one these tools do not know is refused. Per statement, an attestation whose cited source is
// not free (attestationLicences against CC0) contributes nothing to the item, and the plan says so.
//
// What is written (D5, D6, D10): a label and aliases per language, a description (D7, editable), P31 from
// the place's kind (kinds.js; a Wikidata class the dataset names is used as it is), P625 from the point
// (as many decimals as its precision allows), P17 from the country codes (src/vendor/iso-countries.json)
// and P131 only from a region of the region review matched to a Wikidata item. No date property: the
// attested years go into the description. Every statement carries a reference, S854 to the place's own
// address and S813 the date, and every CREATE a comment naming the dataset and the place. At most
// MAX_ITEMS a batch (D8).
import { placeKinds } from './kinds.js';
import { isIri, DATE_TIME, checkReviewer } from './work.js';
import { whgIdOf, linkState } from './identities.js';
import { distanceKm, LOOKUP_DEFAULTS } from './lookup.js';
import { matchesOf } from './regions.js';
import { licenceTerms, rightsStatement, attestationLicences } from '../agora/licence.js';
import { collectWithdrawn, resolveWithdrawn } from '../../formats/shared.js';
import ISO from '../../vendor/iso-countries.json' with { type: 'json' };
export { QID, CONSENT, STATEMENTS, DEFAULT_STATEMENTS, MINT_VERSION, wdLang, checkMint } from './mint-section.js';
import { QID, CONSENT, STATEMENTS, DEFAULT_STATEMENTS, MINT_VERSION, wdLang } from './mint-section.js';

export const ALGORITHM = 'krisis-wikidata 1';
/** Wikidata as a lookup's service (lookup.js serviceOf): the API's address, its title, its site. */
export const WIKIDATA_SERVICE = Object.freeze({ endpoint: 'https://www.wikidata.org/w/api.php', title: 'Wikidata', uri: 'https://www.wikidata.org/' });
/** The permission every request to Wikidata is made under (src/lib/permissions-core.js REGISTRY.gazetteer.wikidata). */
export const WIKIDATA_PERMISSION = 'wikidata';
/** An item's address, as Wikidata's own data gives it (hermes/addresses.js canonicalAddress). */
export const ENTITY = 'http://www.wikidata.org/entity/';
export const entityIri = (qid) => ENTITY + qid;
/** The most items one batch holds (D8): above it, Wikidata's bot approval and WikiProject Historical Place are pointed to. */
export const MAX_ITEMS = 250;
/** A new item's point must be within this of the place's for its Q-id to be recorded (D4). */
export const VERIFY_KM = 1;
/** What Wikidata's data is under, which the per-statement check reads each cited source against. */
export const CC0 = 'https://creativecommons.org/publicdomain/zero/1.0/';
export const QUICKSTATEMENTS = 'https://quickstatements.toolforge.org/';
export const BOT_REQUESTS = 'https://www.wikidata.org/wiki/Wikidata:Requests_for_permissions/Bot';
export const WIKIPROJECT = 'https://www.wikidata.org/wiki/Wikidata:WikiProject_Historical_Place';
export const EDIT_GROUPS = 'https://editgroups.toolforge.org/';

// ---- the kind of place as a Wikidata class (P31) --------------------------------------------------------
/**
 * The classes an item may be an instance of, each with the word the description uses (Wikidata's own English label
 * for the class): kinds.js's WIKIDATA table the other way round (what WHG gives as wd candidates' classes), with the
 * AAT concepts Krisis knows for the same kinds (kinds.js WORDS), and Q22674925, labelled "former populated place" on
 * Wikidata, for a deserted one. Q486972, human settlement, is the class of any settlement whose kind is not one of
 * these. Nothing here is guessed: a kind not in the table is the user's to choose, or the place is left out.
 */
export const CLASSES = Object.freeze([
  { qid: 'Q486972', word: 'human settlement', aat: ['aat:300008347'], words: ['inhabited place', 'settlement', 'populated place', 'human settlement'] },
  { qid: 'Q515', word: 'city', aat: ['aat:300008389'], words: ['city'] },
  { qid: 'Q3957', word: 'town', aat: ['aat:300008375'], words: ['town'] },
  { qid: 'Q18511725', word: 'market town', aat: [], words: ['market town'] },
  { qid: 'Q532', word: 'village', aat: ['aat:300008372'], words: ['village'] },
  { qid: 'Q5084', word: 'hamlet', aat: ['aat:300008369'], words: ['hamlet'] },
  { qid: 'Q22674925', word: 'former populated place', aat: ['aat:300167671'], words: ['deserted settlement', 'deserted village', 'former settlement', 'former populated place', 'abandoned village', 'lost village'] },
  { qid: 'Q102496', word: 'parish', aat: ['aat:300387092', 'aat:300000773'], words: ['parish', 'ancient parish', 'ecclesiastical parish'] },
  { qid: 'Q1115575', word: 'civil parish', aat: [], words: ['civil parish'] },
  { qid: 'Q23397', word: 'lake', aat: ['aat:300008680'], words: ['lake'] },
  { qid: 'Q4022', word: 'river', aat: ['aat:300008707'], words: ['river'] },
  { qid: 'Q47521', word: 'stream', aat: ['aat:300008699'], words: ['stream'] },
  { qid: 'Q23442', word: 'island', aat: ['aat:300008791'], words: ['island'] },
  { qid: 'Q23413', word: 'castle', aat: ['aat:300006891'], words: ['castle'] },
  { qid: 'Q44613', word: 'monastery', aat: ['aat:300000641'], words: ['monastery'] },
  { qid: 'Q1248784', word: 'airport', aat: ['aat:300000681'], words: ['airport'] },
]);
const CLASS_BY_QID = new Map(CLASSES.map((c) => [c.qid, c]));
const CLASS_BY_AAT = new Map(CLASSES.flatMap((c) => c.aat.map((a) => [a, c])));
const CLASS_BY_WORD = new Map(CLASSES.flatMap((c) => c.words.map((w) => [w, c])));
const WD_ADDRESS = /^https?:\/\/(?:www\.)?wikidata\.org\/(?:wiki|entity)\/(Q\d+)$/i;
const norm = (s) => String(s ?? '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
const singular = (w) => [w, w.replace(/ies$/, 'y'), w.replace(/(s|sh|ch|x)es$/, '$1'), w.replace(/s$/, '')];
/** The class of a word the dataset uses for a kind ("Villages", "deserted-settlement"), or null. */
export function classOfWord(label) {
  for (const w of singular(norm(label))) if (CLASS_BY_WORD.has(w)) return CLASS_BY_WORD.get(w);
  return null;
}
/**
 * The class (P31) of a place from what it says of its kind (kinds.js placeKinds: its types' addresses and labels),
 * as { qid, word, how }: a Wikidata class the dataset itself names ('dataset-class', any Q-id, the word the class's if
 * known), an AAT concept or a word the table knows ('kind'), a settlement of no listed kind ('facet': Q486972), or
 * null when nothing is known: then the kind is the user's to choose (`chosen`, a Q-id of CLASSES), else none.
 */
export function classOf(place, chosen = null) {
  if (chosen) { const c = CLASS_BY_QID.get(chosen); return c ? { qid: c.qid, word: c.word, how: 'chosen' } : null; }
  // A Wikidata class the dataset names (a type's identifier, kinds.js reads the same address): used as it is, whatever it is.
  for (const t of Array.isArray(place?.typeIds) ? place.typeIds : []) {
    const m = typeof t === 'string' ? WD_ADDRESS.exec(t.trim()) : null;
    if (m) return { qid: m[1], word: CLASS_BY_QID.get(m[1])?.word ?? classOfWord((place.types || [])[0])?.word ?? null, how: 'dataset-class' };
  }
  const kinds = placeKinds(place);
  for (const k of kinds) {
    const c = (k.aat && CLASS_BY_AAT.get(k.aat)) || (k.label && classOfWord(k.label));
    if (c) return { qid: c.qid, word: c.word, how: 'kind' };
  }
  // A label the kinds tables know as a word of their own but not as an AAT concept (a "deserted village" is a settlement).
  for (const t of Array.isArray(place?.types) ? place.types : []) { const c = classOfWord(t); if (c) return { qid: c.qid, word: c.word, how: 'kind' }; }
  if (kinds.some((k) => k.facet === 'settlement')) return { qid: 'Q486972', word: 'human settlement', how: 'facet' };
  return null;
}

/**
 * The Wikidata language code a name's tag gives (mint-section.js wdLang: the language, with a script variant Wikidata has,
 * such as sr-latn), `fallback` (the dataset's language) for a name with no tag, or 'unsupported' for a tag Wikidata has
 * no code for: a transliteration's (grc-Latn, a romanised Greek name), which must not go on the language's own slot.
 */
export function wdLangOf(tag, fallback = null) {
  const t = typeof tag === 'string' ? tag.trim() : '';
  if (!t) return wdLang(fallback) ?? null;
  return wdLang(t) ?? 'unsupported';
}

// ---- countries -------------------------------------------------------------------------------------------
/** The item of an ISO 3166-1 alpha-2 code (src/vendor/iso-countries.json), { qid, name }, or null. */
export function countryOf(code) {
  const c = typeof code === 'string' ? code.trim().toUpperCase() : '';
  return Object.hasOwn(ISO, c) ? { qid: ISO[c].q, name: ISO[c].name } : null;
}
const CODE_OF_QID = new Map(Object.entries(ISO).map(([code, v]) => [v.q, code]));
// The countries whose names take "the" in a description, as Wikidata's own descriptions write them ("village in the
// United Kingdom"): a small table by code; a name the table already begins with "The" (the Bahamas, the Gambia) is lowered.
const THE = new Set(['GB', 'NL', 'US', 'AE', 'PH', 'CF', 'CD', 'CG', 'DO', 'MV', 'MH', 'SB', 'KM', 'SC', 'FM', 'IM', 'FO', 'CK', 'VG', 'VI', 'KY', 'TC', 'FK', 'MP', 'PN', 'IO', 'TF', 'CZ', 'GS', 'UM', 'BQ']);
/** A country's name as a description says it after "in": with "the" where Wikidata's descriptions have it; null for a code not known. */
export function countryWords(code) {
  const c = countryOf(code);
  if (!c) return null;
  const k = String(code).trim().toUpperCase();
  if (/^The /.test(c.name)) return 'the ' + c.name.slice(4);
  return THE.has(k) ? `the ${c.name}` : c.name;
}
/** The code of a country's item, or null: for reading a found item's country (P17) as the dataset writes one. */
export const codeOfCountry = (qid) => CODE_OF_QID.get(qid) ?? null;

// ---- the dataset's records, read for the plan -----------------------------------------------------------
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const CC0_TERMS = licenceTerms(CC0);
/** A year from an isoOrYear ('1296', '1296-05-01', '-0500'), or null. */
const yearOf = (v) => { const m = /^(-?\d{1,6})/.exec(String(v ?? '').trim()); return m ? Number(m[1]) : null; };
/**
 * A sink for run() that keeps, for each place in `places` (a Set of IRIs, or null for every place), what an
 * item is made from: the header's gazetteer, and the place's label, country codes and attestations that
 * are not denials and not withdrawn, each as { id, names: [{ toponym, language, romanized }], points:
 * [{ point: [lon, lat], precisionKm }], years: [first, last] | null, types: [{ identifier, label }],
 * cited (it cites a source, or carries one), free (every source it takes from is free to copy: attestationLicences
 * against CC0 finds no reason), why (the first reason it is not) }. `result()` gives { gazetteer, records: Map }.
 */
export function mintCollector(places = null) {
  const recs = new Map(), withdrawals = new Map();
  let gazetteer = null;
  return {
    sink: {
      header(h) { gazetteer = isObject(h?.gazetteer) ? h.gazetteer : {}; },
      event(ev) {
        const rec = ev.type === 'record' ? ev.value : null;
        const iri = rec?.['@id'];
        if (!isObject(rec) || typeof iri !== 'string' || (places && !places.has(iri))) return;
        collectWithdrawn(rec.attestations, withdrawals);
        const r = recs.get(iri) || recs.set(iri, { iri, label: typeof rec.label === 'string' ? rec.label : null, ccodes: list(rec.ccodes).filter((c) => typeof c === 'string'), attestations: [] }).get(iri);
        for (const a of list(rec.attestations)) {
          if (!isObject(a) || a.negated) continue;
          const { reasons } = attestationLicences(a, CC0_TERMS);
          const why = reasons.size ? [...reasons.entries()][0] : null;
          const years = list(a.timespans).flatMap((t) => (isObject(t) ? [t.startEarliest, t.startLatest, t.endEarliest, t.endLatest].map(yearOf) : [])).filter((y) => y !== null);
          r.attestations.push({
            id: typeof a['@id'] === 'string' ? a['@id'] : null,
            names: list(a.names).filter(isObject).map((n) => ({ toponym: typeof n.toponym === 'string' ? n.toponym : null, language: typeof n.language === 'string' ? n.language : null, romanized: typeof n.romanized === 'string' ? n.romanized : null })),
            points: list(a.geometries).filter(isObject).map((g) => ({ point: pointOf(g), precisionKm: typeof g.precisionKm === 'number' && g.precisionKm > 0 ? g.precisionKm : null })).filter((p) => p.point),
            years: years.length ? [Math.min(...years), Math.max(...years)] : null,
            types: list(a.types).filter(isObject).map((t) => ({ identifier: typeof t.identifier === 'string' ? t.identifier : null, label: typeof t.label === 'string' ? t.label : null })),
            cited: list(a.citations).some((c) => isObject(c) && c.source) || list(a.sources).some(Boolean),
            free: !why, why: why ? `${why[0]}: ${why[1].licence}${why[1].source ? ` (${why[1].source})` : ''}` : null,
          });
        }
      },
      async close() {},
    },
    /** What was read, with the withdrawn attestations taken out (as identities.js takes them out of a dataset's identities). */
    result() {
      const gone = resolveWithdrawn(withdrawals).status;
      for (const r of recs.values()) r.attestations = r.attestations.filter((a) => !(a.id && gone.has(a.id)));
      return { gazetteer: gazetteer || {}, records: recs };
    },
  };
}
/** A geometry's point, [lon, lat]: its reprPoint, else a Point's coordinates; null for anything else. */
function pointOf(g) {
  const ok = (p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'number' && Number.isFinite(x)) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
  if (ok(g.reprPoint)) return g.reprPoint;
  if (g.geojson?.type === 'Point' && ok(g.geojson.coordinates)) return g.geojson.coordinates;
  return null;
}

// ---- the licence gate (D3) --------------------------------------------------------------------------------
/**
 * Whether the dataset's licence lets its statements go to Wikidata (CC0): { kind: 'free' | 'consent' | 'refused',
 * licence (the SPDX id, or what was given), why }. Free: the public domain (CC0, the Public Domain Mark, PDDL).
 * Consent: a licence that asks credit or share-alike (CC BY, CC BY-SA, ODbL, ODC-By, the OGL), where the user
 * states CONSENT. Refused: no commercial use, no adaptations, a rights statement, no licence, or one not known.
 */
export function mintGate(gazetteer) {
  const given = typeof gazetteer?.licence === 'string' ? gazetteer.licence.trim() : '';
  if (!given) return { kind: 'refused', licence: null, why: 'no-licence' };
  const st = rightsStatement(given);
  if (st) return { kind: 'refused', licence: `rights statement ${st}`, why: 'rights-statement' };
  const t = licenceTerms(given);
  if (!t) return { kind: 'refused', licence: given, why: 'unknown' };
  if (t.nc) return { kind: 'refused', licence: t.id, why: 'nc' };
  if (t.nd) return { kind: 'refused', licence: t.id, why: 'nd' };
  if (t.pd) return { kind: 'free', licence: t.id, why: null };
  return { kind: 'consent', licence: t.id, why: t.sa ? 'sa' : 'by' };
}
/** The consent statement as the work file records it: the words, who made it (a reviewer, never an address with @ in it), when, under which licence. */
export function consentRecord({ by, at = new Date().toISOString(), licence } = {}) {
  checkReviewer(by, 'The person consenting');
  if (/@/.test(by.name)) throw new TypeError('The person consenting is named by an address with @ in it, which is never written into a work file or a batch: give a name.');
  if (!DATE_TIME.test(at)) throw new TypeError(`consentRecord: at must be an ISO date-time, not ${at}`);
  return { statement: CONSENT, by: { name: by.name.trim(), ...(by.orcid ? { orcid: by.orcid } : {}) }, at, licence: licence ?? null };
}

// ---- which places (D2, D6, D8) ----------------------------------------------------------------------------
const HTTP = /^https?:\/\/\S+$/;
const isWikidataService = (s) => { try { return /^(www\.)?wikidata\.org$/.test(new URL(s?.endpoint).hostname); } catch { return false; } };
/** The Wikidata lookups of a work file (the searches before minting, and the Q-ids recorded), in order. */
export const wikidataLookups = (work) => (work?.lookups || []).filter((l) => isWikidataService(l.service) && !l.parameters?.minted);
/** The latest Wikidata search's state for a place: 'answered', 'unanswered', 'stopped', 'pending', or null when never searched. */
export function searchState(work, iri) {
  let found = null;
  for (const l of wikidataLookups(work)) if (Object.hasOwn(l.queries, iri)) found = l.queries[iri].state;
  return found;
}
/** The regions above a place, nearest first (work.places[iri].within, then each region's within). */
function regionsAbove(work, iri) {
  const out = [];
  let key = work.places?.[iri]?.within;
  while (typeof key === 'string' && Object.hasOwn(work.regions || {}, key) && !out.includes(key)) { out.push(key); key = work.regions[key].within; }
  return out;
}
/**
 * The nearest region above the place that the region review matched to a Wikidata item (D6: P131 comes from
 * nothing else): { key, label, qid }, or null. A region matched to GeoNames or TGN gives no Q-id, and the region
 * above it is tried.
 */
export function regionItem(work, iri) {
  for (const key of regionsAbove(work, iri)) {
    const r = work.regions[key];
    if (r.outcome !== 'matched') continue;
    for (const c of matchesOf(work, key)) {
      // A WHG record from Wikidata (place:wd:Qn, by its w3id or Wikidata's own address), or a Wikidata search's own hit.
      const viaWhg = /^place:wd:(Q\d+)$/.exec(whgIdOf(c.candidate_candidate) || '');
      const qid = viaWhg ? viaWhg[1] : isWikidataService({ endpoint: c.gazetteer?.service }) && QID.test(c.gazetteer?.id || '') ? c.gazetteer.id : null;
      if (qid) return { key, label: r.label, qid };
    }
  }
  return null;
}
/** The nearest region above the place, matched or not, for the description: its label, or null. */
export function regionLabel(work, iri) { const k = regionsAbove(work, iri)[0]; return k ? work.regions[k].label ?? null : null; }
export const LEFT_OUT = ['rowState', 'matched', 'minted', 'linked', 'undecided', 'notSearched', 'unanswered', 'noPoint', 'noAddress', 'outsideBase', 'noSource', 'noName', 'excluded'];
/**
 * The places an item may be made for, and those left out, by reason (LEFT_OUT, each a list of IRIs):
 *   `places`   gather()'s places (with the links the dataset states), else the work file's;
 *   `records`  mintCollector()'s records, when read (then a place with no attestation citing a source is left out);
 *   `base`     the dataset's base address, when known: a place not under it has no address the dataset will serve.
 * A place qualifies when it is reviewed (no candidate undecided) and matched to nothing (no 'match' decision, so every
 * candidate is not-this or distinct, or it has none), linked by the dataset to no gazetteer's record, searched in
 * Wikidata and answered, and has a point, or a region matched to a Wikidata item in its place (D6); its address is a
 * web address; and it is not kept out of the review (rowState) or out of minting (mint.items[iri].excluded).
 * `whgNotSearched` counts the qualifying places never looked up in any other gazetteer: said, not a reason.
 */
export function qualifying(work, places = null, { records = null, base = null } = {}) {
  const all = places ? places : Object.entries(work.places || {}).map(([iri, p]) => ({ iri, ...p }));
  const out = { ready: [], leftOut: Object.fromEntries(LEFT_OUT.map((k) => [k, []])), whgNotSearched: 0 };
  const cands = work.candidates || [];
  const others = (work.lookups || []).filter((l) => !isWikidataService(l.service));
  for (const p of all) {
    const iri = p.iri, rec = work.places?.[iri] || p;
    const leave = (why) => out.leftOut[why].push(iri);
    const rs = rec.rowState ?? p.rowState;
    if (rs === 'filter' || rs === 'exclude') { leave('rowState'); continue; }
    if (work.mint?.items?.[iri]?.excluded) { leave('excluded'); continue; }
    // Already given an item (its Q-id recorded, mint.qids): never minted twice, whatever its decisions say since; the way
    // back is to take the record out (unrecordMinted), which the panel offers.
    if (work.mint?.qids?.[iri]) { leave('minted'); continue; }
    const mine = cands.filter((c) => c.candidate_source === iri);
    if (mine.some((c) => c.decision?.kind === 'match')) { leave('matched'); continue; }
    if (whgIdOf(iri) || [...(p.identities?.linked || [])].some((x) => whgIdOf(x))) { leave('linked'); continue; }
    if (mine.some((c) => !c.decision)) { leave('undecided'); continue; }
    const st = searchState(work, iri);
    if (st === null) { leave('notSearched'); continue; }
    if (st !== 'answered') { leave('unanswered'); continue; }
    if (!HTTP.test(iri)) { leave('noAddress'); continue; }
    if (base && !iri.startsWith(base)) { leave('outsideBase'); continue; }
    if (!(rec.label || p.label) && !(rec.names || p.names || []).length) { leave('noName'); continue; }
    if (!Array.isArray(rec.point ?? p.point) && !regionItem(work, iri)) { leave('noPoint'); continue; }
    if (records) { const r = records.get(iri); if (!r || !r.attestations.some((a) => a.cited)) { leave('noSource'); continue; } }
    if (!others.some((l) => Object.hasOwn(l.queries, iri))) out.whgNotSearched++;
    out.ready.push(iri);
  }
  return out;
}

// ---- the plan: one item per place -------------------------------------------------------------------------
/** How many decimals a coordinate keeps for a precision in kilometres (0.01° is about 1.1 km): none given, 6. */
export function decimalsFor(precisionKm) {
  if (!(typeof precisionKm === 'number' && precisionKm > 0)) return 6;
  return Math.max(0, Math.min(6, Math.ceil(Math.log10(111 / precisionKm))));
}
const round = (x, d) => Number(x.toFixed(d));
// A text as a QuickStatements string: the outer quotes are its (the V1 parser takes the first and the last, so a quote
// inside is written as it is); a tab or a newline, which would end the command, is a space, and planItems warns of it.
const q = (s) => `"${String(s).replace(/[\t\r\n]+/g, ' ').trim()}"`;
/** An address as a QuickStatements string, never altered (an address has no tab or newline, and is cited exactly). */
const qUrl = (s) => `"${String(s)}"`;
/** A description as Help:Description asks: lower case to begin, no full stop to end, one space between words. */
export const tidyDescription = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().replace(/\.+$/, '').replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase());
const wordCount = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);
/** The description prefilled (D7): "<kind> in <region>, <country>, attested <first>–<last>", from what is known. */
export function describe({ kindWord, region, country, years }) {
  const where = [region, country].filter(Boolean).join(', ');
  const when = years ? `attested ${years[0] === years[1] ? years[0] : `${years[0]}–${years[1]}`}` : '';
  const head = `${kindWord || 'place'}${where ? ` in ${where}` : ''}`;
  return tidyDescription(when ? `${head}, ${when}` : head);
}
/**
 * The items a batch would make, one per qualifying place, each with everything the batch writes and the warnings
 * about it. `work` (with `mint.items` edits), `places` (gather()'s, else the work file's), `records`
 * (mintCollector()'s result: { gazetteer, records }), options: statements (STATEMENTS on or off; DEFAULT_STATEMENTS),
 * lang (the dataset's language code for a name without one, else null), base, only (IRIs: just these).
 * Returns { items: [{ iri, label, labels: { lang: text }, aliases: { lang: [text] }, description, class, point, decimals,
 * country, region, years, leftOut: [{ attestation, why }], warnings: [kind…] }], left: qualifying()'s leftOut with
 * 'noKind' (no class known or chosen), 'noLanguage' (no name with a language, and none given) and 'notFree' (no name free to copy) added, gate (mintGate), statements, count }.
 */
export function planItems({ work, places = null, records = null, options = {} } = {}) {
  const statements = { ...DEFAULT_STATEMENTS, ...(options.statements || {}) };
  const recs = records?.records ?? null, gazetteer = records?.gazetteer ?? null;
  const gate = gazetteer ? mintGate(gazetteer) : null;
  const sel = qualifying(work, places, { records: recs, base: options.base ?? null });
  const left = { ...sel.leftOut, noKind: [], noLanguage: [], notFree: [] };
  const byIri = new Map((places || []).map((p) => [p.iri, p]));
  const items = [];
  for (const iri of sel.ready) {
    if (options.only && !options.only.includes(iri)) continue;
    if (work.mint?.qids?.[iri]) { left.minted.push(iri); continue; }   // the same guard as qualifying's, should a caller give a ready list of its own
    const place = { iri, ...(byIri.get(iri) || {}), ...(work.places?.[iri] || {}) };
    const edits = work.mint?.items?.[iri] || {};
    const warnings = [], leftOut = [];
    const rec = recs?.get(iri) || null;
    // Names by language: from the records (each name's own tag) where read, else the work file's names under the dataset's language.
    const labels = {}, aliases = {};
    const put = (text, tag, { romanised = false } = {}) => {
      const t = typeof text === 'string' ? text.trim() : '';
      if (!t) return;
      // A romanised form is in no language of its own: it goes under the dataset's language, else is left out and said.
      const l = romanised ? (wdLang(options.lang) ?? null) : wdLangOf(tag, options.lang);
      if (romanised && !l) { if (!warnings.includes('romanised-no-language')) warnings.push('romanised-no-language'); return; }
      if (l === 'unsupported') { if (!warnings.includes('language-unsupported')) warnings.push('language-unsupported'); return; }
      const lang = l;
      if (!lang) { if (!warnings.includes('no-language')) warnings.push('no-language'); return; }
      if (!labels[lang]) { labels[lang] = t; return; }
      if (labels[lang].toLowerCase() === t.toLowerCase()) return;
      (aliases[lang] ||= []).some((a) => a.toLowerCase() === t.toLowerCase()) || aliases[lang].push(t);
    };
    const free = rec ? rec.attestations.filter((a) => a.free) : null;
    if (rec) for (const a of rec.attestations) if (!a.free) leftOut.push({ attestation: a.id, why: a.why });
    if (rec) {
      // The place's label first, in its own language (the first name that is it), so that it is the label.
      const own = free.flatMap((a) => a.names).find((n) => n.toponym && place.label && n.toponym.trim() === place.label.trim());
      if (own) put(own.toponym, own.language);
      for (const a of free) for (const n of a.names) { put(n.toponym, n.language); put(n.romanized, null, { romanised: true }); }
    } else for (const n of [place.label, ...(place.names || [])]) put(n, place.langs?.[String(n).trim().toLowerCase()] ?? null);
    // The class first (the user's to choose), then the names: none with a language is no label, none free is no item.
    const cls = classOf(place, edits.kind ?? null);
    if (!cls) { left.noKind.push(iri); continue; }
    if (!Object.keys(labels).length) { left[warnings.includes('no-language') ? 'noLanguage' : 'notFree'].push(iri); continue; }
    // The point: the work file's (gather's representative point), or the first free attestation's, with its precision.
    let point = null, decimals = 6;
    if (rec) {
      const p = free.flatMap((a) => a.points)[0];
      if (p) { point = p.point; decimals = decimalsFor(p.precisionKm); }
      else if (rec.attestations.some((a) => a.points.length)) warnings.push('point-not-free');
    } else if (Array.isArray(place.point)) point = place.point;
    const region = regionItem(work, iri), regionWords = regionLabel(work, iri);
    if (!point && !region) { left.noPoint.push(iri); continue; }
    const codes = place.ccodes || rec?.ccodes || [];
    const country = codes.map(countryOf).find(Boolean) || null;
    if (codes.length && !country) warnings.push('country-unknown');
    const countryName = codes.map(countryWords).find(Boolean) || null;
    const years = rec ? (() => { const ys = free.map((a) => a.years).filter(Boolean); return ys.length ? [Math.min(...ys.map((y) => y[0])), Math.max(...ys.map((y) => y[1]))] : null; })() : null;
    const prefilled = describe({ kindWord: cls.word, region: regionWords, country: countryName, years });
    const description = typeof edits.description === 'string' && edits.description.trim() ? tidyDescription(edits.description) : prefilled;
    const n = wordCount(description);
    if (n < 2 || n > 12) warnings.push('description-length');
    // A tab or a newline in a text would end the command: written as a space (q), and said.
    if ([...Object.values(labels), ...Object.values(aliases).flat(), description].some((t) => /[\t\r\n]/.test(t))) warnings.push('whitespace-replaced');
    if (point && Math.abs(point[1]) > 90) warnings.push('point-out-of-range');
    items.push({ iri, label: labels[options.lang] ?? Object.values(labels)[0], labels, aliases, description, prefilled, class: cls, point: point ? [round(point[0], decimals), round(point[1], decimals)] : null, decimals,
      country, region, years, leftOut, warnings });
  }
  const count = { items: items.length, statements: items.reduce((n, it) => n + statementCount(it, statements), 0) };
  return { items, left, gate, statements, count, whgNotSearched: sel.whgNotSearched };
}
/** How many lines an item's commands make, the CREATE apart (the volume shown before the file is offered). */
function statementCount(it, st) {
  let n = 0;
  if (st.labels) n += Object.keys(it.labels).length;
  if (st.aliases) n += Object.values(it.aliases).reduce((k, a) => k + a.length, 0);
  if (st.description) n += 1;
  if (st.p31) n += 1;
  if (st.p625 && it.point) n += 1;
  if (st.p17 && it.country) n += 1;
  if (st.p131 && it.region) n += 1;
  return n;
}

// ---- the batch: QuickStatements v1 text (D10) ------------------------------------------------------------
/** A QuickStatements time value for a date: +YYYY-MM-DDT00:00:00Z/11 (precision day). */
export const qsDate = (date) => { const d = /^(\d{4}-\d{2}-\d{2})/.exec(String(date)); if (!d) throw new TypeError(`Not a date: ${date}`); return `+${d[1]}T00:00:00Z/11`; };
/** A comment's text as /* … *\/ takes it: without what would end it, on one line, and never an address with @ in it. */
const commentText = (s) => String(s ?? '').replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim();
/**
 * The batch as QuickStatements v1 commands: for each item, CREATE with a comment naming the dataset and the place,
 * then LAST with the labels (Lxx), the aliases (Axx), the description (Dxx) and, each with a reference to the place's
 * address (S854) and the date (S813), P31, P625, P17 and P131, those switched on (`statements`) and known. The
 * dataset's title goes into the comment unless it has an address with @ in it (never written); `date` is the day
 * the references say the address was consulted. The text is \t-separated, one command a line, ending in a newline.
 */
export function quickStatementsV1(items, { date, title = null, statements = DEFAULT_STATEMENTS } = {}) {
  const st = { ...DEFAULT_STATEMENTS, ...statements };
  const when = qsDate(date);
  const lines = [];
  const named = title && !/@/.test(title) ? commentText(title) : null;
  for (const it of items) {
    lines.push(`CREATE /* PLATO tools: ${named ? `${named}; ` : ''}${commentText(it.iri)} */`);
    const ref = `\tS854\t${qUrl(it.iri)}\tS813\t${when}`;
    if (st.labels) for (const [lang, text] of Object.entries(it.labels)) lines.push(`LAST\tL${lang}\t${q(text)}`);
    if (st.aliases) for (const [lang, list] of Object.entries(it.aliases)) for (const a of list) lines.push(`LAST\tA${lang}\t${q(a)}`);
    // The description is English by construction (describe), whatever the labels' languages: always Den.
    if (st.description && it.description) lines.push(`LAST\tDen\t${q(it.description)}`);
    if (st.p31 && it.class) lines.push(`LAST\tP31\t${it.class.qid}${ref}`);
    if (st.p625 && it.point) lines.push(`LAST\tP625\t@${it.point[1]}/${it.point[0]}${ref}`);
    if (st.p17 && it.country) lines.push(`LAST\tP17\t${it.country.qid}${ref}`);
    if (st.p131 && it.region) lines.push(`LAST\tP131\t${it.region.qid}${ref}`);
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}
/** The name of the batch's file: the review's stem, then .wikidata.qs.txt. */
export const batchName = (stem) => `${String(stem || 'review').replace(/\.krisis\.json$/i, '').replace(/\.json$/i, '')}.wikidata.qs.txt`;

// ---- the work file's mint section ---------------------------------------------------------------------------
/** The work file's mint section as it stands, made if absent. */
export function mintOf(work) {
  if (!isObject(work.mint)) work.mint = { version: MINT_VERSION, consent: null, options: { statements: { ...DEFAULT_STATEMENTS }, lang: null }, items: {}, batches: [], qids: {} };
  return work.mint;
}
/**
 * A batch written, recorded in the work file: its id (q1, q2, …), when, the places in it (the items' order), the
 * file's name and SHA-256, the statements it carried and the count. Returns the record.
 */
export function recordBatch(work, { items, name, sha256, at = new Date().toISOString(), statements }) {
  const m = mintOf(work);
  let n = m.batches.length + 1;
  while (m.batches.some((b) => b.id === `q${n}`)) n++;
  const b = { id: `q${n}`, at, places: items.map((it) => it.iri), name, sha256, statements: { ...DEFAULT_STATEMENTS, ...(statements || {}) }, items: items.length };
  m.batches.push(b);
  return b;
}

// ---- the Q-ids back (D4) -----------------------------------------------------------------------------------
/** The Q-ids in a pasted text (plain ids, a QuickStatements table, a batch report, item addresses), each once, in order. */
export function readPastedQids(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/\bQ[1-9]\d*\b/g)) if (!out.includes(m[0])) out.push(m[0]);
  return out;
}
/** A claim's value as { latitude, longitude }, for P625, or null. */
const coordOf = (claim) => { const v = claim?.mainsnak?.datavalue?.value; return v && typeof v.latitude === 'number' && typeof v.longitude === 'number' ? v : null; };
/** The reference URLs (P854) an entity's claims carry, each once. */
export function referenceUrls(entity) {
  const out = new Set();
  for (const claims of Object.values(entity?.claims || {})) for (const c of list(claims)) for (const r of list(c.references)) for (const s of list(r?.snaks?.P854)) if (typeof s?.datavalue?.value === 'string') out.add(s.datavalue.value);
  return [...out];
}
/** An entity's labels and aliases, as texts (every language). */
export function entityNames(entity) {
  const labels = Object.values(entity?.labels || {}).map((l) => l?.value).filter((v) => typeof v === 'string');
  const aliases = Object.values(entity?.aliases || {}).flat().map((a) => a?.value).filter((v) => typeof v === 'string');
  return { labels, aliases };
}
/** An entity's point from P625, [lon, lat], or null. */
export function entityPoint(entity) {
  for (const c of list(entity?.claims?.P625)) { const v = coordOf(c); if (v) return [v.longitude, v.latitude]; }
  return null;
}
/**
 * Whether an item is the one a batch row made (D4): its label in some language equals one of the item's labels
 * (the row's), its point (P625) within VERIFY_KM of the row's (where the row has one), and the row's reference on it
 * (a P854 reference URL that is the place's address). Returns { ok, label, distanceKm, reference }: each check's
 * finding, so that the page can say which failed. `entity` is wbgetentities' entity (labels, aliases, claims).
 */
export function verifyItem(entity, item) {
  const { labels } = entityNames(entity);
  const ours = Object.values(item.labels || {}).map((s) => s.trim());
  const label = labels.some((l) => ours.includes(l.trim()));
  const p = entityPoint(entity);
  const d = item.point && p ? Math.round(distanceKm(item.point, p) * 1000) / 1000 : null;
  const near = !item.point ? null : d !== null && d <= VERIFY_KM;
  const reference = referenceUrls(entity).includes(item.iri);
  return { ok: label && reference && near !== false, label, distanceKm: d, near, reference };
}
/**
 * Each entity matched to the batch row whose address it carries as a reference (the strong key), then verified
 * (verifyItem). `entities` is { Qn: entity }, `items` the batch's items (planItems'). Returns { matched: [{ qid, iri,
 * verified }], unmatched: [qid] (an item of the user's that carries no address of the batch), twice: [{ iri, qids }]
 * (two items for one place: neither is taken) }.
 */
export function matchItems(entities, items) {
  const byIri = new Map(items.map((it) => [it.iri, it]));
  const found = new Map();
  const unmatched = [];
  for (const [qid, e] of Object.entries(entities || {})) {
    if (!QID.test(qid) || !e || e.missing !== undefined) continue;
    const iri = referenceUrls(e).find((u) => byIri.has(u));
    if (!iri) { unmatched.push(qid); continue; }
    (found.get(iri) || found.set(iri, []).get(iri)).push(qid);
  }
  const matched = [], twice = [];
  for (const [iri, qids] of found) {
    if (qids.length > 1) { twice.push({ iri, qids }); continue; }
    matched.push({ qid: qids[0], iri, verified: verifyItem(entities[qids[0]], byIri.get(iri)) });
  }
  return { matched, unmatched, twice };
}
/**
 * Pasted Q-ids set against the batch's rows in order (the first id the first row, …), each still to be verified
 * (verifyItem, by the page or the command line, read from Wikidata): [{ qid, iri }], and the ids beyond the rows, or
 * rows beyond the ids, counted. A pasted id is never recorded unverified (D4).
 */
export function pairPasted(qids, items) {
  const n = Math.min(qids.length, items.length);
  return { pairs: Array.from({ length: n }, (_, i) => ({ qid: qids[i], iri: items[i].iri })), extraQids: Math.max(0, qids.length - items.length), rowsLeft: Math.max(0, items.length - qids.length) };
}
/** The Wikidata lookup record that holds the Q-ids recorded (minted: true), made once. */
function mintedLookup(work, now) {
  let l = (work.lookups || []).find((x) => isWikidataService(x.service) && x.parameters?.minted === true);
  if (l) return l;
  let n = work.lookups.length + 1;
  while (work.lookups.some((x) => x.id === `l${n}`)) n++;
  l = { id: `l${n}`, service: { ...WIKIDATA_SERVICE }, started_at: now, finished_at: now, algorithm_version: ALGORITHM, parameters: { minted: true },
    attribution: wikidataAttribution(), counts: { places: 0, queries: 0, requests: 0, answered: 0, notFound: 0, unanswered: 0, stopped: 0, found: 0, added: 0, far: 0, skipped: {} }, stopped: null, queries: {} };
  work.lookups.push(l);
  return l;
}
/** What Wikidata's data is under, as a lookup's attribution says a source's licence (whg.js whgLicence reads it). */
export const wikidataAttribution = () => ({ sources: { wd: { license: { spdx_id: 'CC0-1.0', permits_commercial: true, no_derivatives: false }, redistributable: true } } });
/**
 * A verified Q-id recorded in the work file as the reviewer's decision: a candidate for the item (its address in
 * Wikidata's entity form), under the lookup that holds the Q-ids, decided 'match' as an exactMatch with a basis naming
 * the batch, so that Finish writes the identity like any other (identity.js, apply.js). `how` is 'pasted' or
 * 'contribs'; `verified` verifyItem()'s finding, which must be ok. Returns the candidate. A place already matched to
 * that item keeps its decision.
 */
export function recordMinted(work, iri, qid, { batch, reviewer, how, verified, at = new Date().toISOString(), label = null, point = null } = {}) {
  if (!Object.hasOwn(work.places, iri)) throw new Error(`recordMinted: ${iri} is not a place of the review`);
  if (!QID.test(qid)) throw new TypeError(`recordMinted: ${qid} is not a Q-id`);
  if (!verified?.ok) throw new Error(`recordMinted: ${qid} was not verified as the item made for ${iri}, so it is not recorded`);
  if (!['pasted', 'contribs'].includes(how)) throw new TypeError(`recordMinted: how must be pasted or contribs, not ${how}`);
  checkReviewer(reviewer, 'recordMinted: the reviewer');
  if (/@/.test(reviewer.name)) throw new TypeError('recordMinted: the reviewer is named by an address with @ in it, which is never written: give a name.');
  const l = mintedLookup(work, at);
  const target = entityIri(qid);
  let c = work.candidates.find((x) => x.candidate_source === iri && x.candidate_candidate === target);
  const basis = `Created in Wikidata from this record (QuickStatements batch ${batch?.id || '?'} of ${batch?.at ? batch.at.slice(0, 10) : 'unknown date'}, run by the reviewer), and checked: the label, the point within ${VERIFY_KM} km, and the reference to this place's address.`;
  if (!c) {
    let n = work.candidates.filter((x) => x.lookup === l.id).length, id;
    do id = `${l.id}-${++n}`; while (work.candidates.some((x) => x.id === id));
    const place = work.places[iri];
    c = { id, candidate_source: iri, candidate_candidate: target, similarity_score: 1, distance_km: verified.distanceKm ?? null, candidate_status: 'suggested', generated_at: at, algorithm_version: ALGORITHM, lookup: l.id,
      ccodes_agree: null, other: { label: label || place.label, names: [label || place.label], point: point ?? place.point ?? null, source: { title: WIKIDATA_SERVICE.title, uri: WIKIDATA_SERVICE.uri } },
      gazetteer: { service: WIKIDATA_SERVICE.endpoint, id: qid, score: null, confidence: null, match: false, answer_rank: 1, description: 'an item made from this record', namespace: 'wd', query: null, withheld: true, tie: null, dice: null },
      decision: null };
    work.candidates.push(c);
    l.counts.added++; l.counts.found++;
  }
  l.queries[iri] = { state: 'answered', sent: [], found: 1, added: 1, minted: qid };
  l.counts.places = Object.keys(l.queries).length; l.counts.answered = l.counts.places;
  if (c.decision?.kind !== 'match') { c.decision = { kind: 'match', identityType: 'exactMatch', basis, decided_at: at }; c.candidate_status = 'confirmed'; }
  mintOf(work).qids[iri] = { qid, how, batch: batch?.id ?? null, at, verified: { label: verified.label, distanceKm: verified.distanceKm, reference: verified.reference } };
  if (!work.reviewer) work.reviewer = { name: reviewer.name.trim(), ...(reviewer.orcid ? { orcid: reviewer.orcid } : {}) };
  return c;
}

/**
 * A recorded Q-id taken out again (the way back from 'minted'): the record goes from mint.qids, the candidate's decision
 * is cleared (it stays, suggested, for the reviewer to decide again or leave), and the lookup's query for the place goes.
 * Returns the Q-id taken out, or null when none was recorded. The dataset is not touched: an identity already written
 * by Finish is withdrawn there by a changed decision, as any answer is (withdraw.js).
 */
export function unrecordMinted(work, iri) {
  const r = work.mint?.qids?.[iri];
  if (!r) return null;
  delete work.mint.qids[iri];
  const l = (work.lookups || []).find((x) => isWikidataService(x.service) && x.parameters?.minted === true);
  if (l) { delete l.queries[iri]; l.counts.places = Object.keys(l.queries).length; l.counts.answered = l.counts.places; }
  const c = work.candidates.find((x) => x.candidate_source === iri && x.candidate_candidate === entityIri(r.qid) && x.lookup === l?.id);
  if (c) { c.decision = null; c.candidate_status = 'suggested'; }
  return r.qid;
}
/** Whether a consent recorded still fits the dataset's licence as the gate reads it now: given again when the licence changed (D3). */
export const consentFits = (consent, gate) => !!consent && !!gate && consent.licence === gate.licence;

// ---- Wikidata's API: the requests, and its answers as the gazetteer module's candidates -----------------------
export const API = WIKIDATA_SERVICE.endpoint;
const params = (o) => new URLSearchParams({ format: 'json', origin: '*', ...o }).toString();
/** wbsearchentities for a name in a language (the fallback languages too, unless strict). */
export const searchUrl = (text, lang, { limit = 10 } = {}) => `${API}?${params({ action: 'wbsearchentities', search: text, language: lang, type: 'item', limit: String(Math.min(50, Math.max(1, limit))) })}`;
/** CirrusSearch for items with a point within `km` of [lon, lat] (nearcoord: and haswbstatement:P625, both measured on wikidata.org, 15 October 2026). */
export const nearUrl = ([lon, lat], km, { limit = 10 } = {}) => `${API}?${params({ action: 'query', list: 'search', srsearch: `nearcoord:${Math.round(km * 10) / 10}km,${lat},${lon} haswbstatement:P625`, srnamespace: '0', srlimit: String(Math.min(50, Math.max(1, limit))) })}`;
/** wbgetentities for up to 50 ids: labels, descriptions, aliases and claims. */
export const entitiesUrl = (ids) => `${API}?${params({ action: 'wbgetentities', ids: ids.slice(0, 50).join('|'), props: 'labels|descriptions|aliases|claims' })}`;
/** The user's own new items since `since` (ISO date-time), oldest first, 500 at a time (ucshow=new: page creations; namespace 0: items). */
export const contribsUrl = (user, since, { uccontinue = null } = {}) => `${API}?${params({ action: 'query', list: 'usercontribs', ucuser: user, ucshow: 'new', ucnamespace: '0', ucstart: since, ucdir: 'newer', ucprop: 'title|timestamp|comment', uclimit: '500', ...(uccontinue ? { uccontinue } : {}) })}`;
/**
 * An entity (wbgetentities') as the gazetteer module's Candidate (gazetteer/index.js), so that mergeAnswers() keeps
 * it as any lookup's: its id the Q-id, its address the entity form, its name the label in `lang` (else English, else
 * any), the other labels and aliases its other names, its description, its classes (P31) as "wikidata:Qn" (kinds.js
 * reads them), its point (P625), its country (P17) as a code where the table knows it. `score` and `confidence` are
 * null and `match` false: Wikidata ranks nothing, and no hit is ever accepted in bulk (guards.js): the reviewer decides.
 */
export function entityCandidate(entity, { lang = null, foundBy = 'name' } = {}) {
  const id = entity?.id;
  if (!QID.test(id || '')) return null;
  const labels = entity.labels || {}, pick = (l) => labels[l]?.value;
  const name = (lang && pick(lang)) || pick('en') || Object.values(labels)[0]?.value || id;
  const others = [...Object.values(labels).map((l) => l?.value), ...Object.values(entity.aliases || {}).flat().map((a) => a?.value)].filter((v) => typeof v === 'string' && v && v !== name);
  const desc = entity.descriptions?.[lang || 'en']?.value || entity.descriptions?.en?.value || Object.values(entity.descriptions || {})[0]?.value || null;
  const classes = list(entity.claims?.P31).map((c) => c?.mainsnak?.datavalue?.value?.id).filter((x) => typeof x === 'string' && QID.test(x));
  const countries = list(entity.claims?.P17).map((c) => codeOfCountry(c?.mainsnak?.datavalue?.value?.id)).filter(Boolean);
  const point = entityPoint(entity);
  return {
    id, iri: entityIri(id), name, description: foundBy === 'near' ? `found near the place's point${desc ? `; ${desc}` : ''}` : desc,
    score: null, match: false, confidence: null, namespace: 'wd', altNames: [...new Set(others)], hasGeom: !!point,
    types: classes.map((c) => ({ id: `wikidata:${c}`, name: `wikidata:${c}` })), coords: point, ccodes: countries.length ? countries : null,
    raw: { id, found_by: foundBy },
  };
}
