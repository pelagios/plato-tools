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
// Pure: no page, no network. The page fetches the Feature (createLookup().entity()), indexes the
// dataset's identities (Krisis's currentIdentities) and passes Krisis's gazetteerSource(WHG_SERVICE) as
// `source`; none of these is decided here.
import { recordIdentity } from '../krisis/identity.js';
import { normaliseWhgIri, namespaceOf, whgIri } from '../gazetteer/whg.js';
import { newGeometryAttestation, checkGeoJSON, DrawError } from './draw.js';
import { choraAdoptIdentityNote, choraAdoptGeometryNote, CHORA_ADOPT_TEXT } from '../words.js';

export const CITES_AS_EVIDENCE = 'http://purl.org/spar/cito/citesAsEvidence';
const SPDX = 'https://spdx.org/licenses/';
const isIri = (s) => typeof s === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(s);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Dates of a record's that PLATO cannot hold as they are; the message says why, in words. */
export class AdoptError extends Error {
  constructor(message) { super(message); this.name = 'AdoptError'; }
}

/** The role a geometry is given unless the person adopting chooses another: a point stands for the place, an area is its extent. */
export function defaultRole(type) {
  return type === 'Point' || type === 'MultiPoint' ? 'RepresentativePoint' : type === 'Polygon' || type === 'MultiPolygon' ? 'Extent' : undefined;
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
const spdxOf = (l) => (typeof l === 'string' ? l : isObject(l) && typeof l.spdx_id === 'string' ? l.spdx_id : null);
/**
 * The licence the gazetteer's attribution gives for the record's UPSTREAM source: for an authority's
 * record, attribution.sources[namespace]; for WHG's own (namespace whg, or none), its dataset's in
 * attribution.datasets. Never attribution.whg, which is WHG's own curation layer, not the source's.
 * { spdx, uri, commercial, derivatives, redistributable, name } (each null when not stated), or null
 * when nothing is said. `redistributable` is false only when the service says false.
 */
export function upstreamLicence(attribution, namespace, dataset) {
  const entry = namespace && namespace !== 'whg' ? attribution?.sources?.[namespace] : dataset != null ? attribution?.datasets?.[dataset] : null;
  if (!isObject(entry)) return null;
  const l = entry.license, spdx = spdxOf(l);
  const yes = (v) => (v === true || v === false ? v : null);
  const redistributable = yes(entry.redistributable);
  if (!spdx && redistributable !== false) return null;
  return {
    spdx,
    uri: spdx && /^[A-Za-z0-9.+-]+$/.test(spdx) ? SPDX + spdx : null,
    commercial: isObject(l) ? yes(l.permits_commercial) : null,
    derivatives: isObject(l) ? (l.no_derivatives === true ? false : l.no_derivatives === false ? true : null) : null,
    redistributable,
    name: typeof entry.name === 'string' ? entry.name : null,
  };
}
/** For WHG's own records, place:whg:<dataset>:<id>: the dataset. */
const datasetOf = (id) => /^place:whg:([^:]+):/.exec(String(id ?? ''))?.[1] ?? null;
/** The id a record has in its upstream source: 2641673 for place:gn:2641673. */
const localIdOf = (id) => /^place:(?:[A-Za-z][\w-]*:)?(.+)$/.exec(String(id ?? ''))?.[1] ?? null;

// ---- the adoption ---------------------------------------------------------------------------------------
const holds = (list, iri) => {
  for (const x of list || []) if (x === iri || normaliseWhgIri(x) === iri) return true;
  return false;
};

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
 *   existing       this place's identities, as Krisis's currentIdentities gives them: { linked, denied,
 *                  exact } (sets or lists of IRIs). `exact` holds those linked by an exactMatch not
 *                  negated: only these mean "already linked". Without it, no link is taken as exact.
 *   source         the service as a PLATO source: Krisis's gazetteerSource(WHG_SERVICE)
 * Returns { attestations: [identity?, geometry], notes: [{ kind, text }], refused?: { kind, reason } }.
 * A refusal has no attestations. Throws only for a caller's mistake (no source, no contributor, a bad date).
 */
export function adoptionAttestations({ place, candidate, feature = null, fetchError = null, geometryIndex, role, basis, contributor, created, fetched, attribution, existing, source } = {}) {
  const notes = [];
  const refuse = (kind, reason = CHORA_ADOPT_TEXT[kind]) => ({ attestations: [], notes, refused: { kind, reason } });
  if (!isObject(source) || typeof source.title !== 'string') throw new Error('adoptionAttestations: give the service as a PLATO source (gazetteerSource(WHG_SERVICE)).');
  const subject = place?.['@id'];
  if (!isIri(subject)) return refuse('no-address');
  const record = normaliseWhgIri(candidate?.iri) || whgIri(candidate?.id);
  if (!isIri(record)) return refuse('no-record');
  if (holds(existing?.denied, record)) return refuse('denied');

  const namespace = candidate.namespace ?? namespaceOf(candidate.id);
  const whgNative = !namespace || namespace === 'whg';
  const licence = upstreamLicence(attribution, namespace, whgNative ? datasetOf(candidate.id) : null);
  if (fetchError?.kind === 'unavailable' || fetchError?.status === 451 || licence?.redistributable === false) return refuse('unavailable');

  // Which geometry: one of the Feature's; or, when the record could not be fetched (not a 451), WHG's representative point.
  let chosen, fallback = false;
  try {
    if (feature) {
      const offered = featureGeometries(feature);
      const o = Number.isInteger(geometryIndex) ? offered[geometryIndex] : offered.length === 1 ? offered[0] : null;
      if (!o) return refuse('no-geometry');
      if (o.refused) return refuse(o.refused.kind, o.refused.reason);
      chosen = { ...geometryFrom(o.geojson, o.when), role: role ?? o.role };
    } else {
      if (!Array.isArray(candidate.coords)) return refuse('no-geometry');
      chosen = { ...geometryFrom({ type: 'Point', coordinates: candidate.coords }), role: role ?? 'RepresentativePoint' };
      fallback = true;
      notes.push({ kind: 'representative-point-only', text: CHORA_ADOPT_TEXT['representative-point-only'] });
    }
  } catch (e) {
    const r = refusal(e);
    if (!r) throw e;
    return refuse(r.kind, r.reason);
  }

  const linked = holds(existing?.exact, record);
  if (linked) notes.push({ kind: 'already-linked', text: CHORA_ADOPT_TEXT['already-linked'] });
  else if (holds(existing?.linked, record)) notes.push({ kind: 'loosely-linked', text: CHORA_ADOPT_TEXT['loosely-linked'] });
  if (!licence?.spdx) notes.push({ kind: 'licence-unknown', text: CHORA_ADOPT_TEXT['licence-unknown'] });
  else if (licence.commercial === false || licence.derivatives === false || /-(NC|ND)(-|$)/i.test(licence.spdx)) notes.push({ kind: 'licence-restricted', text: CHORA_ADOPT_TEXT['licence-restricted'](licence.spdx), uri: licence.uri });
  if (whgNative) notes.push({ kind: 'unstable-id', text: CHORA_ADOPT_TEXT['unstable-id'] });

  const words = { record, name: candidate.name || feature?.properties?.title || null, sourceName: licence?.name ?? null, namespace: whgNative ? null : namespace, localId: localIdOf(candidate.id) };
  const geometry = newGeometryAttestation({
    geojson: chosen.geojson, role: chosen.role, contributor, created,
    citation: { source: licence?.uri ? { ...source, licence: licence.uri } : { ...source }, locator: record, citationFunction: CITES_AS_EVIDENCE },
    notes: choraAdoptGeometryNote({ ...words, licence: licence?.spdx ?? null, whgLicence: spdxOf(attribution?.whg?.license), fetched: fetched ?? (created instanceof Date ? created.toISOString() : created), fallback, linked }),
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
