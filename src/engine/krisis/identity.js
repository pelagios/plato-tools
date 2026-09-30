// Krisis: a reviewer's decision that places are, or are not, the same, as a PLATO attestation.
//
// PLATO records identity as a claim like any other: an attestation that bundles identity relations
// (plato:attests_identity), with who made it (contributor), when (created) and on what evidence
// (citations). Accepting the matches of one place in one act is ONE attestation bundling a relation
// from that place to each place accepted, so that they share their provenance and are withdrawn
// together; a consumer may chain exactMatch relations within one attestation, never across. Saying
// that two places are NOT the same is an attestation that is negated and bundles exactly one
// exactMatch. No identity is canonical and nothing is merged.
//
// The attestation is given no @id: whatever saves it mints one (<place IRI>#a-<8 hex>), and these
// tools never mint one in that form. It is given no promotedFrom either: the suggestion it came
// from lives only in the work file, which is not published.
//
// recordIdentity is shared with the Chora session (gazetteer reconciliation); its signature is agreed.
import { checkReviewer, DATE_TIME, isIri } from './work.js';
import { krisisNote, krisisLookupNote } from '../words.js';

const TYPES = new Set(['exactMatch', 'closeMatch', 'related', 'unspecified']);

/**
 * One attestation recording identity relations from `subject` to each of `targets`.
 *   subject   the IRI of the place the attestation is about
 *   targets   [{ iri, label?, identityType = 'exactMatch', certainty?, basis? }] (label is for the
 *             caller's display only: an identity relation has no place for it)
 *   source    what the judgement rests on: a PLATO source object ({ title, '@id'?, uri?, authorityType? })
 *             or a source's IRI; cited as the attestation's citation. Optional.
 *   reviewer  { name, orcid? }, PLATO's contributorObject
 *   date      when the judgement was made, an ISO date-time (created)
 *   negated   true: the places are NOT the same. Then there must be exactly one target, an exactMatch.
 *   notes     optional free text
 * Pure: throws on anything it cannot record, and returns the attestation, with no @id.
 */
export function recordIdentity({ subject, targets, source, reviewer, date, negated = false, notes } = {}) {
  if (!isIri(subject)) throw new Error('recordIdentity: the subject must be the IRI of a place.');
  if (!Array.isArray(targets) || !targets.length) throw new Error('recordIdentity: give at least one target.');
  if (!(typeof date === 'string' && DATE_TIME.test(date))) throw new Error('recordIdentity: date must be an ISO date-time, such as 2026-09-30T12:00:00Z.');
  checkReviewer(reviewer, 'recordIdentity: the reviewer');
  const seen = new Set();
  const identities = targets.map((t) => {
    if (!t || !isIri(t.iri)) throw new Error('recordIdentity: each target must have the IRI of a place.');
    if (t.iri === subject) throw new Error('recordIdentity: a place cannot be matched with itself.');
    if (seen.has(t.iri)) throw new Error(`recordIdentity: ${t.iri} is a target twice.`);
    seen.add(t.iri);
    const identityType = t.identityType ?? 'exactMatch';
    if (!TYPES.has(identityType)) throw new Error(`recordIdentity: ${identityType} is not an identity type.`);
    const r = { subject, object: t.iri, identityType };
    if (t.certainty !== undefined) {
      if (!(typeof t.certainty === 'number' && t.certainty >= 0 && t.certainty <= 1)) throw new Error('recordIdentity: certainty must be between 0 and 1.');
      r.certainty = t.certainty;
    }
    if (typeof t.basis === 'string' && t.basis.trim()) r.basis = t.basis.trim();
    return r;
  });
  if (negated && (identities.length !== 1 || identities[0].identityType !== 'exactMatch'))
    throw new Error('recordIdentity: saying that places are not the same (negated) takes exactly one target, an exactMatch.');
  const contributor = { name: reviewer.name.trim(), ...(reviewer.orcid ? { orcid: reviewer.orcid } : {}) };
  const a = { contributor, created: date, identities };
  if (negated) a.negated = true;
  if (source !== undefined && source !== null) {
    if (typeof source === 'string') { if (!isIri(source)) throw new Error('recordIdentity: a source given as a string must be its IRI.'); }
    else if (typeof source !== 'object' || typeof source.title !== 'string') throw new Error('recordIdentity: a source must have a title, or be an IRI.');
    a.citations = [{ source }];
  }
  if (typeof notes === 'string' && notes.trim()) a.notes = notes.trim();
  return a;
}

/** The dataset of the other places, as a PLATO source: what a local review's judgements rest on. */
export function datasetSource(side) {
  const s = { title: side.title || 'Untitled dataset', authorityType: 'dataset' };
  if (isIri(side.uri)) s['@id'] = side.uri;
  return s;
}

const latest = (dates) => dates.filter(Boolean).sort().at(-1);

/**
 * The attestations a review's decisions make: one for each subject place with any 'match' decision,
 * bundling a relation to each place accepted, and one for each 'distinct' decision, negated. A
 * 'not-this' decision makes nothing. Each is dated when its last decision was made, unless `date`
 * is given. `reviewer` defaults to the work file's, `source` to the dataset of the other places.
 * `source` is what the judgements on the other dataset's candidates cite; one on a candidate looked
 * up in a gazetteer cites the gazetteer whatever `source` says (one attestation per source).
 * Returns [{ subject, attestation }], in the order of the review.
 */
export function attestationsFrom(work, { reviewer = work.reviewer, source, date } = {}) {
  if (!reviewer) throw new Error('attestationsFrom: the review has no reviewer.');
  const out = [];
  const algorithm = (c) => c.algorithm_version || work.algorithm_version;
  // `source` stands for the other dataset only: a candidate looked up in a gazetteer always cites the gazetteer.
  const sourceOf = (c) => (lookupOf(work, c) || !source ? candidateSource(work, c) : source);
  for (const subject of Object.keys(work.places)) {
    const decided = work.candidates.filter((c) => c.candidate_source === subject && c.decision);
    // One attestation per source (Krisis: gazetteer lookup): matches from the other dataset and from a gazetteer are cited apart.
    for (const { src, of: matches } of bySource(decided.filter((c) => c.decision.kind === 'match'), sourceOf)) {
      out.push({ subject, attestation: recordIdentity({
        subject, reviewer, source: src, date: date || latest(matches.map((c) => c.decision.decided_at)),
        targets: matches.map((c) => ({ iri: c.candidate_candidate, label: c.other.label, identityType: c.decision.identityType, basis: c.decision.basis })),
        notes: noteOf(work, 'match', matches[0], [...new Set(matches.map(algorithm))].join(', ')),
      }) });
    }
    for (const c of decided.filter((x) => x.decision.kind === 'distinct')) {
      out.push({ subject, attestation: recordIdentity({
        subject, reviewer, source: sourceOf(c), date: date || c.decision.decided_at, negated: true,
        targets: [{ iri: c.candidate_candidate, label: c.other.label, identityType: 'exactMatch', basis: c.decision.basis }],
        notes: noteOf(work, 'distinct', c, algorithm(c)),
      }) });
    }
  }
  return out;
}

// ---- Krisis: gazetteer lookup -------------------------------------------------------------------------
/**
 * A gazetteer's reconciliation service as a PLATO source, which a judgement on one of its candidates
 * cites: `service` is a lookup's ({ endpoint, title, uri? }, lookup.js). Its licence is not written
 * here or anywhere in an attestation: the work file keeps it (lookups[].attribution).
 */
export function gazetteerSource(service) {
  const s = { title: service?.title || service?.endpoint || 'Gazetteer', authorityType: 'dataset' };
  if (isIri(service?.uri)) s['@id'] = service.uri;
  return s;
}
const lookupOf = (work, c) => (c.lookup ? (work.lookups || []).find((l) => l.id === c.lookup) : null);
/** What a judgement on candidate `c` rests on: the gazetteer it was looked up in, else the other dataset. */
export function candidateSource(work, c) {
  const l = lookupOf(work, c);
  if (l) return gazetteerSource(l.service);
  return datasetSource(work.others || c.other?.source || {});
}
/** Candidates grouped by the source they cite, in order of first appearance. */
function bySource(cands, sourceOf) {
  const groups = new Map();
  for (const c of cands) {
    const src = sourceOf(c), key = typeof src === 'string' ? src : JSON.stringify(src);
    (groups.get(key) || groups.set(key, { src, of: [] }).get(key)).of.push(c);
  }
  return [...groups.values()];
}
const noteOf = (work, kind, c, algorithm) => {
  const l = lookupOf(work, c);
  return l ? krisisLookupNote(kind, l.service.title, algorithm) : krisisNote(kind, algorithm);
};
