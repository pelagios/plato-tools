// Adopting a location from a gazetteer match: one act that records two claims, as two attestations
// sharing `created` and the contributor, neither with an @id:
//   1. an identity: this place IS the gazetteer record (Krisis's recordIdentity, an exactMatch citing
//      the gazetteer service), left out when the dataset already says so by an exactMatch not negated;
//   2. a geometry: the place is located where the record says, COPIED from the record's own geometry
//      (newGeometryAttestation), with the record's dates (`when`) carried as the attestation's
//      timespans, citing the service (cito:citesAsEvidence) with the record as the locator, and
//      carrying the UPSTREAM source's licence as an SPDX address when the service gives one.
// The record's address is given verbatim in both notes, so that the two can be paired by their text.
//
// Refused, with nothing recorded: a place without an @id (an identity needs its address); a candidate
// the dataset says is a different place (Krisis changes that); a record whose source does not allow it
// to be passed on (a 451, or `redistributable: false`), which is then consulted, not copied.
//
// What this file takes from Krisis (main): the upstream licence (lookup.js upstreamLicence, never WHG's
// own), the dataset's identities as Krisis reads them (identities.js: currentIdentities, linkState, a
// link winning over a denial), WHG as a source (identity.js gazetteerSource(WHG_SERVICE)) and the
// recording of an identity (recordIdentity). "May not be redistributed" is the licence's own
// `redistributable === false`, tested directly; lookupPage.licenceWarns (words.js) only words the line.
//
// Pure: no page, no network. The page fetches the Feature (createLookup().entity()) and gives this
// place's entry of currentIdentities, which the worker indexes over the whole dataset.
import { recordIdentity, gazetteerSource } from '../krisis/identity.js';
import { upstreamLicence, WHG_SERVICE, distanceKm } from '../krisis/lookup.js';
import { linkState } from '../krisis/identities.js';
import { normaliseWhgIri, namespaceOf, whgIri } from '../gazetteer/whg.js';
import { newGeometryAttestation, checkGeoJSON, DrawError } from './draw.js';
import { reprPointOf } from './geo.js';
import { choraAdoptIdentityNote, choraAdoptGeometryNote, choraConsultedNote, CHORA_ADOPT_TEXT, lookupPage } from '../words.js';

export const CITES_AS_EVIDENCE = 'http://purl.org/spar/cito/citesAsEvidence';
const SPDX = 'https://spdx.org/licenses/';
const isIri = (s) => typeof s === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(s);
/** Whether a place's key is an address (its @id), as adopting needs; Chora keys a place without one as #<n>. */
export const isPlaceIri = isIri;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Dates of a record's that PLATO cannot hold as they are; the message says why, in words. */
export class AdoptError extends Error {
  constructor(message) { super(message); this.name = 'AdoptError'; }
}

/** The role a geometry is given unless the person adopting chooses another: a point stands for the place, an area is its extent. */
export function defaultRole(type) {
  return rolesFor(type)[0];
}
/** The roles offered for a geometry of this type, the default first: a line is a route, or the whole place. */
export function rolesFor(type) {
  if (type === 'Point' || type === 'MultiPoint') return ['RepresentativePoint', 'FeaturePoint'];
  if (type === 'LineString' || type === 'MultiLineString') return ['Itinerary', 'Extent'];
  if (type === 'Polygon' || type === 'MultiPolygon') return ['Extent', 'RepresentativePoint', 'FeaturePoint'];
  return [];
}

// ---- dates ------------------------------------------------------------------------------------------
// LPF's `when` (Linked Places Format 1.2): { timespans: [{ start: {in|earliest|latest}, end: {…} }],
// periods: [{ name, uri }], label, duration }. Each part goes to PLATO's four-date timespan; anything it
// cannot hold as it is refuses the geometry, rather than being dropped or reworded.
const ISO_OR_YEAR = /^-?\d{4,}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2})?Z?)?)?)?$/;
const DURATION = /^-?P(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;
const WHEN_KEYS = new Set(['timespans', 'periods', 'label', 'duration']);
const BOUND_KEYS = new Set(['in', 'earliest', 'latest']);
const cannotHold = (what, k) => new AdoptError(`${what} has "${k}", which PLATO's timespan cannot hold as it is.`);

function bound(b, side, out) {
  if (b === undefined || b === null) return;
  if (!isObject(b)) throw new AdoptError(`The record's ${side} date is not one PLATO can hold.`);
  for (const k of Object.keys(b)) if (!BOUND_KEYS.has(k)) throw cannotHold(`The record's ${side} date`, k);
  const date = (v) => { if (typeof v !== 'string' || !ISO_OR_YEAR.test(v.trim())) throw new AdoptError(`The record's ${side} date "${v}" is not an ISO date or a year of four digits, which PLATO needs.`); return v.trim(); };
  if (b.in !== undefined) { out[side + 'Earliest'] = date(b.in); out[side + 'Latest'] = date(b.in); }
  if (b.earliest !== undefined) out[side + 'Earliest'] = date(b.earliest);
  if (b.latest !== undefined) out[side + 'Latest'] = date(b.latest);
}

/** An LPF `when` as PLATO timespans ([] when it gives none); throws AdoptError for what PLATO cannot hold. */
export function timespansFrom(when) {
  if (when === undefined || when === null) return [];
  if (!isObject(when)) throw new AdoptError("The record's dates are not in a form PLATO can hold.");
  for (const k of Object.keys(when)) if (!WHEN_KEYS.has(k)) throw cannotHold("The record's dates", k);
  let label, duration;
  if (when.label !== undefined) {
    if (typeof when.label !== 'string' || !when.label.trim()) throw new AdoptError("The record's dates have a label that is not text.");
    label = when.label.trim();
  }
  if (when.duration !== undefined) {
    if (typeof when.duration !== 'string' || !DURATION.test(when.duration)) throw new AdoptError(`The record's duration "${when.duration}" is not one PLATO can hold (an xsd:duration, such as P100Y).`);
    duration = when.duration;
  }
  const dated = [];
  for (const t of [].concat(when.timespans ?? [])) {
    if (!isObject(t)) throw new AdoptError("A timespan of the record's is not one PLATO can hold.");
    for (const k of Object.keys(t)) if (k !== 'start' && k !== 'end') throw cannotHold("A timespan of the record's", k);
    const s = {};
    bound(t.start, 'start', s);
    bound(t.end, 'end', s);
    if (Object.keys(s).length) dated.push(s);
  }
  const periods = [].concat(when.periods ?? []).map((p) => {
    if (!isObject(p) || (p.name !== undefined && typeof p.name !== 'string') || (p.uri !== undefined && !isIri(p.uri)) || (!p.name && !p.uri))
      throw new AdoptError("A period of the record's is not one PLATO can hold (a name, a PeriodO address, or both).");
    return { ...(p.name ? { label: p.name } : {}), ...(p.uri ? { periodoUri: p.uri } : {}) };
  });
  // A label and a duration are said of the whole of `when`: of its one timespan, or of one of their own.
  if (label !== undefined || duration !== undefined) {
    const extra = { ...(label !== undefined ? { label } : {}), ...(duration !== undefined ? { duration } : {}) };
    if (dated.length > 1) throw new AdoptError("The record's dates give one label or duration for several timespans, which PLATO cannot say of each.");
    if (dated.length === 1) Object.assign(dated[0], extra); else dated.push(extra);
  }
  return [...dated, ...periods];
}

// ---- geometries ---------------------------------------------------------------------------------------
/**
 * One geometry to adopt: { geojson (checked and rounded by checkGeoJSON, which strips LPF's extras such
 * as `when`), when, timespans }. A GeometryCollection is refused (PLATO does not take one): adopt one of
 * its members. `inheritedWhen` is a collection's, for a member with none of its own. Throws DrawError
 * (the geometry) or AdoptError (its dates), in words.
 */
export function geometryFrom(g, inheritedWhen) {
  if (isObject(g) && g.type === 'GeometryCollection') throw new DrawError('A GeometryCollection is not accepted in PLATO: adopt one of its geometries.');
  const when = isObject(g) && g.when !== undefined ? g.when : inheritedWhen;
  return { geojson: checkGeoJSON(g), when, timespans: timespansFrom(when) };
}

/**
 * The geometries a Feature offers for adoption, in order: a GeometryCollection's members (a nested one
 * flattened), each taking the collection's `when` when it has none of its own. Each is
 * { index, geojson (as the record gives it), when, role (the default), refused?: { kind: 'geometry' |
 * 'when', reason } }: a refused one is shown with its reason and cannot be adopted.
 */
export function featureGeometries(feature) {
  const out = [];
  const visit = (g, when) => {
    if (!isObject(g)) return;
    if (g.type === 'GeometryCollection') { for (const m of g.geometries || []) visit(m, g.when !== undefined ? g.when : when); return; }
    const o = { index: out.length, geojson: g, when: g.when !== undefined ? g.when : when, role: defaultRole(g.type) };
    try { geometryFrom(g, when); } catch (e) { const r = refusal(e); if (!r) throw e; o.refused = r; }
    out.push(o);
  };
  visit(feature?.geometry, undefined);
  return out;
}
const refusal = (e) => (e instanceof AdoptError ? { kind: 'when', reason: e.message } : e instanceof DrawError ? { kind: 'geometry', reason: e.message } : null);

// ---- licence ------------------------------------------------------------------------------------------
// The licence of what is copied is the UPSTREAM source's: Krisis's upstreamLicence (lookup.js), never
// attribution.whg, which covers WHG's own curation layer. Written on the copied geometry's citation as
// an SPDX address, when the service names an SPDX id.
/** The SPDX address of a licence object's id, or null. */
export const spdxUri = (l) => (typeof l?.spdx === 'string' && /^[A-Za-z0-9.+-]+$/.test(l.spdx) ? SPDX + l.spdx : null);
/** WHG's own licence's SPDX id (attribution.whg), for the notes only, or null. */
const whgLicenceOf = (attribution) => { const l = attribution?.whg?.license; return typeof l === 'string' ? l : isObject(l) && typeof l.spdx_id === 'string' ? l.spdx_id : null; };
/** For WHG's own records, place:whg:<dataset>:<id>: the dataset. */
export const datasetOf = (id) => /^place:whg:([^:]+):/.exec(String(id ?? ''))?.[1] ?? null;
/** The id a record has in its upstream source: 2641673 for place:gn:2641673. */
const localIdOf = (id) => /^place:(?:[A-Za-z][\w-]*:)?(.+)$/.exec(String(id ?? ''))?.[1] ?? null;
const isWhgNative = (namespace) => !namespace || namespace === 'whg';

/**
 * What the dataset and the gazetteer say of a candidate, before anything is fetched: for the list, and
 * the first refusals of adoptionAttestations.
 *   identities  this place's entry of Krisis's currentIdentities (linked, exact, denied), or null
 * Returns { record (its w3id, or null), namespace, whgNative, licence (upstreamLicence), linked
 * ('exact' | 'loose' | null), denied, mayCopy (false for a source that may not be redistributed),
 * licenceWarns (lookupPage.licenceWarns: unknown, non-commercial, not redistributable) }.
 * A link wins over a denial (linkState); only an exactMatch is "already linked".
 */
export function candidateStatus(candidate, { identities = null, attribution = null } = {}) {
  const record = normaliseWhgIri(candidate?.iri) || whgIri(candidate?.id) || null;
  const namespace = candidate?.namespace ?? namespaceOf(candidate?.id);
  const whgNative = isWhgNative(namespace);
  const licence = upstreamLicence(attribution, whgNative ? null : namespace, whgNative ? datasetOf(candidate?.id) : null);
  const c = { id: candidate?.id, iri: record };
  const exact = identities && record ? linkState(identities, c, { exact: true }) === 'linked' : false;
  const any = identities && record ? linkState(identities, c) : null;
  return {
    record, namespace: namespace ?? null, whgNative, licence,
    linked: exact ? 'exact' : any === 'linked' ? 'loose' : null,
    denied: any === 'denied',
    // Tested directly, never through licenceWarns (which also covers non-commercial and unknown, which may be copied).
    mayCopy: licence?.redistributable !== false,
    licenceWarns: lookupPage.licenceWarns(licence),
  };
}

// ---- the adoption ---------------------------------------------------------------------------------------
/** WHG, as the source both attestations cite: Krisis's gazetteerSource(WHG_SERVICE), the same as a Krisis identity's. */
export const whgSource = () => gazetteerSource(WHG_SERVICE);

/**
 * The attestations one adoption makes. Arguments:
 *   place          the place record ({ '@id', label, … }); without an @id nothing can be adopted
 *   candidate      the gazetteer candidate (createLookup's: { id, iri, name, namespace, coords, … })
 *   feature        the record as an LPF Feature (entity()), or null when it could not be fetched
 *   fetchError     what entity() threw, if it did: a 451 (kind 'unavailable') copies nothing
 *   geometryIndex  which of featureGeometries(feature) to adopt (may be left out when there is one)
 *   role           what it depicts (draw.js ROLES); default: RepresentativePoint for a point, Extent for an area
 *   basis          why the person adopting holds them to be the same, for the identity
 *   contributor    { name, orcid? }; created: when (an ISO date-time); fetched: when the record was
 *                  fetched (default: created)
 *   attribution    the root attribution of the lookup's answer
 *   identities     this place's entry of Krisis's currentIdentities ({ linked, exact, denied }), or
 *                  null when it has none: an exactMatch already there means "already linked"
 *                  (linkState with exact), a denial "ruled out" (linkState), a link winning over a denial
 * Both cite WHG as Krisis's identities do (gazetteerSource(WHG_SERVICE)).
 * Returns { attestations: [identity?, geometry], notes: [{ kind, text }], refused?: { kind, reason } }.
 * A refusal has no attestations. Throws only for a caller's mistake (no contributor, a bad date).
 */
export function adoptionAttestations({ place, candidate, feature = null, fetchError = null, geometryIndex, role, basis, contributor, created, fetched, attribution, identities = null } = {}) {
  const notes = [];
  const refuse = (kind, reason = CHORA_ADOPT_TEXT[kind]) => ({ attestations: [], notes, refused: { kind, reason } });
  const source = whgSource();
  const subject = place?.['@id'];
  if (!isIri(subject)) return refuse('no-address');
  const st = candidateStatus(candidate, { identities, attribution });
  const record = st.record;
  if (!isIri(record)) return refuse('no-record');
  if (st.denied) return refuse('denied');
  if (fetchError?.kind === 'unavailable' || fetchError?.status === 451 || !st.mayCopy) return refuse('unavailable');
  // The place's own address is the record's: it is that record already, and an identity with itself is no claim.
  const sameAddress = record === subject;

  // Which geometry: one of the Feature's; or, when the record could not be fetched (not a 451), WHG's representative point.
  let chosen, fallback = false;
  try {
    if (feature) {
      const offered = featureGeometries(feature);
      const o = Number.isInteger(geometryIndex) ? offered[geometryIndex] : offered.length === 1 ? offered[0] : null;
      if (!o) return refuse('no-geometry');
      if (o.refused) return refuse(o.refused.kind, o.refused.reason);
      chosen = { ...geometryFrom(o.geojson, o.when), role: role || o.role };
    } else {
      // Only when the record could not be had for a passing reason, and never from a WHG record whose licence cannot be known.
      if (!Array.isArray(candidate.coords) || !fallbackAllowed(fetchError) || (st.whgNative && st.licence === null)) return refuse('no-geometry');
      chosen = { ...geometryFrom({ type: 'Point', coordinates: candidate.coords }), role: role || 'RepresentativePoint' };
      fallback = true;
      notes.push({ kind: 'representative-point-only', text: CHORA_ADOPT_TEXT['representative-point-only'] });
    }
  } catch (e) {
    const r = refusal(e);
    if (!r) throw e;
    return refuse(r.kind, r.reason);
  }

  const linked = st.linked === 'exact' || sameAddress;
  if (sameAddress) notes.push({ kind: 'same-address', text: CHORA_ADOPT_TEXT['same-address'] });
  else if (linked) notes.push({ kind: 'already-linked', text: CHORA_ADOPT_TEXT['already-linked'] });
  else if (st.linked === 'loose') notes.push({ kind: 'loosely-linked', text: CHORA_ADOPT_TEXT['loosely-linked'] });
  notes.push(...licenceNotes(st.licence));
  if (st.whgNative) notes.push({ kind: 'unstable-id', text: CHORA_ADOPT_TEXT['unstable-id'] });

  const licenceUri = spdxUri(st.licence);
  const words = recordWordsOf(candidate, feature, st, attribution);
  const geometry = newGeometryAttestation({
    geojson: chosen.geojson, role: chosen.role, contributor, created,
    citation: { source: licenceUri ? { ...source, licence: licenceUri } : { ...source }, locator: record, citationFunction: CITES_AS_EVIDENCE },
    notes: choraAdoptGeometryNote({ ...words, licence: st.licence?.spdx ?? null, whgLicence: whgLicenceOf(attribution), fetched: fetched ?? (created instanceof Date ? created.toISOString() : created), fallback, linked }),
  });
  if (chosen.timespans.length) geometry.timespans = chosen.timespans;
  if (linked) return { attestations: [geometry], notes };

  const identity = recordIdentity({
    subject, source, reviewer: geometry.contributor, date: geometry.created,
    targets: [{ iri: record, identityType: 'exactMatch', basis }],
    notes: choraAdoptIdentityNote(words),
  });
  return { attestations: [identity, geometry], notes };
}

/** How the notes name a record: its address, name, upstream source and id there. */
function recordWordsOf(candidate, feature, st, attribution) {
  const sourceName = st.whgNative ? attribution?.datasets?.[datasetOf(candidate?.id)]?.name : attribution?.sources?.[st.namespace]?.name;
  return { record: st.record, name: candidate?.name || feature?.properties?.title || null, sourceName: typeof sourceName === 'string' ? sourceName : null,
    namespace: st.whgNative ? null : st.namespace, localId: localIdOf(candidate?.id), dataset: st.whgNative ? datasetOf(candidate?.id) : null };
}

/**
 * Whether a record that could not be fetched may stand in by WHG's representative point: only after a
 * failure that says nothing of the record (no answer, too many requests, the server's own fault, 5xx),
 * never after a refusal (403, 404 and the like) or with no failure given.
 */
export function fallbackAllowed(fetchError) {
  if (!fetchError) return false;
  if (fetchError.kind === 'network' || fetchError.kind === 'rate') return true;
  return Number.isInteger(fetchError.status) && fetchError.status >= 500;
}
/** adoptionAttestations, with anything it throws (a caller's mistake, a check that refuses) given back as a refusal in words. */
export function safeAdoption(args) {
  try { return adoptionAttestations(args); } catch (e) {
    return { attestations: [], notes: [], refused: { kind: 'error', reason: CHORA_ADOPT_TEXT.error(e?.message || String(e)) } };
  }
}
/**
 * The place's links to legacy WHG cluster pages (whgazetteer.org/places/<n>/portal/). A cluster cannot be
 * told apart into records, so these are not counted as links to any candidate; the page says they exist.
 */
export function clusterLinks(identities) {
  const re = /^https?:\/\/(www\.)?whgazetteer\.org\/places\/\d+\/portal\/?$/;
  return [...new Set([...(identities?.linked || [])].filter((x) => typeof x === 'string' && re.test(x)))];
}

/**
 * The neutral licence line for what may be copied: unknown says so; one that warns (lookupPage.licenceWarns:
 * non-commercial; or no derivatives, which bears as much on copying) gets one line, linked. Never a block.
 */
export function licenceNotes(l) {
  if (!l || !l.spdx) return [{ kind: 'licence-unknown', text: CHORA_ADOPT_TEXT['licence-unknown'] }];
  if (lookupPage.licenceWarns(l) || l.derivatives === false) return [{ kind: 'licence-restricted', text: CHORA_ADOPT_TEXT['licence-restricted'](l.spdx), uri: spdxUri(l) }];
  return [];
}

// ---- a record that may not be copied ----------------------------------------------------------------------
/**
 * The parts of a drawing made by hand for a place whose gazetteer record was consulted and not copied
 * (a 451, or a source that may not be redistributed): it cites WHG (cito:citesAsEvidence), with the
 * record as the locator, and no licence (nothing of it is copied); its notes say so, after how it was
 * drawn. `consulted` is consultation(): { record, name, namespace, localId, sourceName }.
 */
export function consultedParts(consulted, drawnNote) {
  return {
    citation: { source: whgSource(), locator: consulted.record, citationFunction: CITES_AS_EVIDENCE },
    notes: `${drawnNote}. ${choraConsultedNote(consulted)}`,
  };
}
/** What a hand-drawing keeps of a record consulted, not copied (no token, no geometry). */
export function consultation(candidate, attribution) {
  const st = candidateStatus(candidate, { attribution });
  return recordWordsOf(candidate, null, st, attribution);
}

// ---- ranking, honestly --------------------------------------------------------------------------------------
const insideBox = ([x, y], [w, s, e, n]) => y >= s && y <= n && (w <= e ? x >= w && x <= e : x >= w || x <= e);
/**
 * A place's geographic reference for ranking candidates, by what the place itself gives (view.js's view):
 * its own current geometries (not denied) → { kind: 'point', points } (a distance is shown); else the
 * places it is related to, or its countries → { kind: 'box', bbox, from: 'related' | 'ccodes' } (inside
 * or outside only); else { kind: 'none' } (the dataset's box is no reference for one place).
 */
export function referenceOf(view) {
  const own = (view?.geometries || []).filter((g) => g.status !== 'denied').map((g) => reprPointOf(g.geojson)).filter(Boolean);
  if (own.length) return { kind: 'point', points: own };
  const fb = view?.fallback;
  if ((fb?.kind === 'related' || fb?.kind === 'ccodes') && Array.isArray(fb.bbox)) return { kind: 'box', bbox: fb.bbox, from: fb.kind };
  return { kind: 'none' };
}
/**
 * Candidates in the order to show them, numbered from 1, never preselected:
 * - with a point: by distance from the nearest of the place's own points, then the gazetteer's order;
 * - with a box: those inside it, then outside, each in the gazetteer's order;
 * - with none: the gazetteer's order, as it gave it.
 * A candidate without coordinates comes last (but with none), and says so. Each:
 * { n, candidate, distanceKm (point only), inArea (box only), noCoords, sameSpelling (WHG's match) }.
 */
export function rankCandidates(reference, candidates) {
  const rows = (candidates || []).map((c, order) => {
    const has = Array.isArray(c.coords);
    const row = { candidate: c, order, noCoords: !has, sameSpelling: c.match === true, distanceKm: null, inArea: null };
    if (has && reference?.kind === 'point') row.distanceKm = Math.round(Math.min(...reference.points.map((p) => distanceKm(p, c.coords))) * 10) / 10;
    if (has && reference?.kind === 'box') row.inArea = insideBox(c.coords, reference.bbox);
    return row;
  });
  const key = reference?.kind === 'point' ? (r) => (r.noCoords ? Infinity : r.distanceKm)
    : reference?.kind === 'box' ? (r) => (r.noCoords ? 2 : r.inArea ? 0 : 1) : () => 0;
  rows.sort((a, b) => key(a) - key(b) || a.order - b.order);
  return rows.map(({ order, ...r }, i) => ({ n: i + 1, ...r }));
}

// ---- what went wrong -----------------------------------------------------------------------------------------
/**
 * A lookup or a record fetch that did not give an answer, in words, and what to offer: `err` is what
 * createLookup threw (GazetteerError, PermissionError) or null; `list` the one query's answer, whose
 * `.unanswered` or `.error` mean "try again", never "nothing found". Returns null when there is nothing
 * wrong, else { kind, text, offer: 'retry' | 'token' | 'tomorrow' | 'permissions' | null }:
 * - a quota 401 keeps the token (it is not wrong) and says try tomorrow;
 * - a refused token offers to give it again, or forget it;
 * - a permission refused points at the Permissions panel.
 * The texts are the module's (cleaned of the token) or ours; none repeats a request.
 */
export function lookupProblem(err, list = null) {
  if (err) {
    if (err.name === 'PermissionError') return { kind: 'permission', text: CHORA_ADOPT_TEXT.problem.permission, offer: 'permissions' };
    const k = err.kind;
    if (k === 'quota') return { kind: 'quota', text: CHORA_ADOPT_TEXT.problem.quota, offer: 'tomorrow' };
    if (k === 'auth') return { kind: 'auth', text: CHORA_ADOPT_TEXT.problem.auth, offer: 'token' };
    if (k === 'unavailable') return { kind: 'unavailable', text: CHORA_ADOPT_TEXT.unavailable, offer: null };
    if (k === 'rate' || k === 'network') return { kind: k, text: CHORA_ADOPT_TEXT.problem[k], offer: 'retry' };
    return { kind: 'server', text: CHORA_ADOPT_TEXT.problem.server, offer: 'retry' };
  }
  if (list?.unanswered || list?.error != null) return { kind: 'unanswered', text: CHORA_ADOPT_TEXT.problem.unanswered, offer: 'retry' };
  return null;
}

// ---- the draft kept until saved ------------------------------------------------------------------------------
/**
 * The adoption as it is kept in the browser (OPFS, beside the drawings: src/chora/drafts.js) until saved:
 * everything adoptionAttestations needs but the contributor, who is asked for when saving. The Feature is
 * cut to the one geometry chosen (with its `when`), and the candidate to what the attestations use; the
 * lookup, and its token, are not in it. `created` is the time of adopting.
 */
export function adoptionDraft({ id, place, candidate, feature, fetchError, geometryIndex, role, basis, attribution, identities, created, fetched }) {
  let one = null;
  if (feature) {
    const o = featureGeometries(feature)[Number.isInteger(geometryIndex) ? geometryIndex : 0];
    if (o) one = { type: 'Feature', properties: { title: feature.properties?.title ?? null }, geometry: o.when !== undefined ? { ...o.geojson, when: o.when } : { ...o.geojson } };
  }
  const st = candidateStatus(candidate, { attribution });
  const keepAttribution = st.whgNative
    ? { whg: attribution?.whg ?? null, datasets: { [datasetOf(candidate.id)]: attribution?.datasets?.[datasetOf(candidate.id)] ?? null } }
    : { whg: attribution?.whg ?? null, sources: { [st.namespace]: attribution?.sources?.[st.namespace] ?? null } };
  return {
    id: String(id), kind: 'adoption', placeId: place['@id'], placeLabel: place.label ?? '',
    candidate: { id: candidate.id, iri: candidate.iri ?? null, name: candidate.name ?? null, namespace: candidate.namespace ?? null, coords: candidate.coords ?? null },
    feature: one, fetchError: fetchError ? { kind: fetchError.kind ?? null, status: fetchError.status ?? null } : null,
    role: role || null, basis: basis || null, attribution: JSON.parse(JSON.stringify(keepAttribution)),
    identities: identities ? { linked: [...(identities.linked || [])], exact: [...(identities.exact || [])], denied: [...(identities.denied || [])] } : null,
    created, fetched: fetched ?? created,
  };
}
/** The attestations of a kept adoption, now that the contributor is known. */
export function draftAttestations(d, contributor) {
  return adoptionAttestations({
    place: { '@id': d.placeId, label: d.placeLabel }, candidate: d.candidate, feature: d.feature, fetchError: d.fetchError, geometryIndex: 0,
    role: d.role || undefined, basis: d.basis || undefined, contributor, created: d.created, fetched: d.fetched, attribution: d.attribution, identities: d.identities,
  });
}
