// Krisis: the work file, where a match review keeps its suggestions and the reviewer's decisions
// until they are finished. PLATO itself is not changed for this (PLATO has plato:Candidate, but a
// dataset holds what people say, not what software suggests), so the file is the tools' own; its
// candidate fields are named after plato:Candidate's properties so that the two read alike.
//
// Kept light (no pipeline, no schema library) so that the page can read and write it directly.
//
// The shape, version 1 (test/krisis.test.js holds an example of each part):
//   { krisis: 1, generated_at, algorithm_version, match_parameters: { threshold, maxDistanceKm, topK, base?, columns?, blocking, scoring },
//     subjects: { title, uri?, titleFrom?, files: [{ name, size, sha256 }] }, others: { title, uri?, titleFrom?, files },
//     (titleFrom: 'gazetteer', 'given' by the person matching, or 'file-name' when neither gave one)
//     places: { <subject place IRI>: { label, names, point: [lon, lat] | null, ccodes?, types? } },
//     candidates: [{ id, candidate_source, candidate_candidate, similarity_score, distance_km: number | null,
//       candidate_status: 'suggested' | 'confirmed' | 'rejected', generated_at?, algorithm_version?, match_parameters?,
//       other: { label, names, point, source: { title, uri? }, ccodes?, types? },
//       decision: null | { kind: 'match' | 'not-this' | 'distinct', identityType, basis?, decided_at } }],
//     reviewer: null | { name, orcid? }, cursor,
//     candidate_sets?: [{ '@id', issued, previous: [earlier set IRIs] }] }   (each export, the latest last; candidates.js)
//   and, once exported, each candidate's iri: its address in the latest set, or in the earlier set that published it.
// A candidate's own generated_at, algorithm_version and match_parameters, where given, override the
// file's: a later source of suggestions (a gazetteer's reconciliation service) fits the same record.
//
// Version 2 (Krisis: gazetteer lookup) adds, to the above: `others` may be null (places looked up
// in a gazetteer without a local match); `places` may hold places without candidates (those looked
// up and not found); `lookups: [{ id, service: { endpoint, title, uri? }, started_at, finished_at,
// algorithm_version, parameters, attribution, counts, stopped, queries: { <subject place IRI>:
// { state: 'pending' | 'answered' | 'unanswered' | 'stopped', sent: [name…], found?, added?,
// refused?, error?, suspect?, scopeNotApplied? } } }]` (see lookup.js); and a candidate from a lookup carries `lookup` (its id) and
// `gazetteer: { service, id, score, confidence, match, answer_rank, description, namespace, query }`,
// the service's own figures, kept apart from Krisis's similarity_score. `attribution` is the
// service's, verbatim (a null stays null). readWork reads version 1 and gives it back as version 2.
//
// Krisis × Methodos (#28) adds OPTIONAL fields to version 2 (a file without them reads as before, and
// one with them is still version 2; see checkMethodos): a place's `rowState: 'filter' | 'exclude'`
// (none: reconcile); a candidate's `flagged: true` and `note` (text, kept in the work file only, never
// written to the dataset); in a looked-up candidate's `gazetteer`, what WHG's guard needs (guards.js):
// `dice` (number | null), `withheld` (boolean), `tie` (boolean, or null when it was not the top of its
// answer), `head_word_only: true`, `how` (the form of the name that found it, names.js queryVariants,
// when not the name as given); a decision's `guard` ({ rule, threshold, exact, score, confidence, dice })
// and `batch` ('b1', …) when the bulk accept made it; a lookup query's `variants: [{ text, how }]`
// (aligned with `sent`) and a lookup's `parameters.variants`; and `batches: [{ id, at, identityType,
// threshold, accepted, leftOut: { far, ccodes, total }, undone? }]`.
import { DataError } from '../input.js';
import { fileSha256 } from './digest.js';
import { isWhg, WHG_ENDPOINT } from '../gazetteer/index.js';

/**
 * A reconciliation service's address as the work file records it: any of WHG's (www, a trailing slash)
 * as its one, WHG_ENDPOINT, so that two lookups of WHG are of one service; another's as given.
 */
export const canonicalEndpoint = (endpoint) => (isWhg(endpoint) ? WHG_ENDPOINT : endpoint);

// The problems of a dataset's own that stop part of it being read (the kinds the version check's
// NOT_READ in compare.js lists): a matching, or a dataset finished, is then of less than the whole.
export const NOT_READ_KINDS = ['json-syntax', 'rdf-syntax', 'record-failed', 'late-header', 'not-a-list', 'lpf-v2', 'lpf-not-a-feature', 'jsonl-not-an-object'];
export const WORK_VERSION = 2;
/** A candidate's IRI as the candidate set profile's pattern has it (candidates.js mints them). */
export const CANDIDATE_IRI = /#c-(?:[0-9a-f]{4}){2,}$/;
export const IDENTITY_TYPES = ['exactMatch', 'closeMatch', 'related'];
export const DECISIONS = ['match', 'not-this', 'distinct'];
const STATUS_OF = { match: 'confirmed', 'not-this': 'rejected', distinct: 'rejected' };
const ORCID = /^https:\/\/orcid\.org\/\d{4}-\d{4}-\d{4}-\d{3}[0-9X]$/;
/** An ISO date-time, as an attestation's `created` must be (identity.js). */
export const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
/** An IRI, as a place's address must be (identity.js). */
export const isIri = (s) => typeof s === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(s);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPoint = (p) => p === null || (Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'number' && Number.isFinite(x)));
const isNames = (n) => Array.isArray(n) && n.every((x) => typeof x === 'string');

/** A reviewer as PLATO's contributorObject has one: a name, and an ORCID if given. Throws DataError otherwise. */
export function checkReviewer(r, where = 'The reviewer') {
  if (!isObject(r) || typeof r.name !== 'string' || !r.name.trim()) throw new DataError(`${where} must have a name.`);
  if (r.orcid !== undefined && (typeof r.orcid !== 'string' || !ORCID.test(r.orcid))) throw new DataError(`${where}'s ORCID must be written in full, as https://orcid.org/0000-0000-0000-0000.`);
  for (const k of Object.keys(r)) if (k !== 'name' && k !== 'orcid') throw new DataError(`${where} may have a name and an ORCID only, not "${k}".`);
  return r;
}

/** Matching's options, and their defaults. */
export const MATCH_DEFAULTS = { threshold: 0.85, maxDistanceKm: 50, topK: 5 };
/**
 * Matching's options, as numbers, with the defaults for those not given; a DataError saying which is
 * wrong otherwise. Here, not in match.js, so that the page checks them by the same rule before it
 * asks for the other dataset.
 */
export function checkMatchOptions(o = {}) {
  const t = { ...MATCH_DEFAULTS };
  for (const k of Object.keys(MATCH_DEFAULTS)) if (o[k] !== undefined && o[k] !== null && o[k] !== '') t[k] = Number(o[k]);
  if (!(t.threshold > 0 && t.threshold <= 1)) throw new DataError(`The threshold must be above 0 and at most 1, not ${o.threshold}.`);
  if (!(t.maxDistanceKm >= 0)) throw new DataError(`The greatest distance must be a number of kilometres, not ${o.maxDistanceKm}.`);
  if (!(Number.isInteger(t.topK) && t.topK >= 1)) throw new DataError(`The number of suggestions per place must be a whole number from 1, not ${o.topK}.`);
  return t;
}

/**
 * A mapping of a table's columns, as a work file keeps it (match_parameters.columns): one object, not a
 * list, each column given the name of a field, or a column made into web addresses through a pattern
 * { field, pattern } (Hermes's object form). True if it is one. The command line and match() check
 * a mapping by this rule before anything is written, so that no work file holds one readWork refuses.
 */
// Also a region the place lies in at its level, { field: 'within', level }, and a column split into
// levels, { field: 'split', separator, levels, firstIsName } (Hermes, columns.js; within.js).
const isLevel = (l) => Number.isInteger(l) && l >= 1;
const isColumn = (f) => typeof f === 'string' || (isObject(f) && typeof f.field === 'string' && (
  (Object.keys(f).length === 2 && typeof f.pattern === 'string')
  || (f.field === 'within' && Object.keys(f).length === 2 && isLevel(f.level))
  || (f.field === 'split' && Object.keys(f).every((k) => ['field', 'separator', 'levels', 'firstIsName'].includes(k)) && typeof f.separator === 'string' && f.separator !== ''
    && (f.levels === undefined || (Array.isArray(f.levels) && f.levels.length > 0 && f.levels.every(isLevel))) && (f.firstIsName === undefined || typeof f.firstIsName === 'boolean'))));
export const isColumns = (c) => isObject(c) && Object.values(c).every(isColumn);

/** Where a dataset's title in a work file came from: its gazetteer, the person matching, or (neither given) its file's name. */
export const TITLE_FROM = ['gazetteer', 'given', 'file-name'];

function checkSide(side, word) {
  if (!isObject(side) || typeof side.title !== 'string') throw new DataError(`It does not say which dataset held the ${word} (${word}.title).`);
  if (side.uri !== undefined && typeof side.uri !== 'string') throw new DataError(`The ${word} dataset's address (${word}.uri) must be a web address.`);
  if (side.titleFrom !== undefined && !TITLE_FROM.includes(side.titleFrom)) throw new DataError(`It does not say where the ${word} dataset's title came from as these tools write it (${word}.titleFrom: ${TITLE_FROM.join(', ')}).`);
  if (!Array.isArray(side.files) || !side.files.every((f) => isObject(f) && typeof f.name === 'string' && Number.isInteger(f.size) && /^[0-9a-f]{64}$/.test(f.sha256)))
    throw new DataError(`The ${word} files are not listed as a name, a size and a SHA-256 digest each (${word}.files).`);
}

/**
 * Read a work file: its text, parsed and checked. A file that is not one, or that says something no
 * review could have written (a decision that disagrees with its candidate's status, a candidate for
 * a place the file does not list, a score outside 0 to 1), is refused with a DataError saying where.
 */
export function readWork(text) {
  let w;
  try { w = typeof text === 'string' ? JSON.parse(text) : text; }
  catch (e) { throw new DataError(`This is not a Krisis work file: it is not JSON (${e.message}).`); }
  if (!isObject(w) || !Object.hasOwn(w, 'krisis')) throw new DataError('This is not a Krisis work file: it has no "krisis" version.');
  if (w.krisis !== WORK_VERSION && !READS.includes(w.krisis)) throw new DataError(`This work file is of version ${JSON.stringify(w.krisis)}, and these tools read version ${WORK_VERSION}${typeof w.krisis === 'number' && w.krisis > WORK_VERSION ? ': it was made by a later version of the tools' : ''}.`);
  const bad = (m) => { throw new DataError(`This work file cannot be used: ${m}`); };
  if (typeof w.generated_at !== 'string' || typeof w.algorithm_version !== 'string') bad('it does not say when and how its suggestions were made (generated_at, algorithm_version).');
  if (!isObject(w.match_parameters)) bad('it does not give the parameters its suggestions were made with (match_parameters).');
  const cols = w.match_parameters.columns;
  if (cols !== undefined && !isColumns(cols)) bad('the mapping of its dataset\'s columns (match_parameters.columns) is not one: it must be {"column name": "field"}, or {"field": "address", "pattern": "…{id}…"} for a column.');
  try { checkSide(w.subjects, 'subjects'); if (!(w.krisis >= 2 && w.others === null)) checkSide(w.others, 'others'); } catch (e) { bad(e.message[0].toLowerCase() + e.message.slice(1)); }
  if (!isObject(w.places)) bad('it lists no places (places).');
  for (const [iri, p] of Object.entries(w.places)) {
    if (!isIri(iri)) bad(`a place is listed by "${iri}", which is not a web address (an IRI).`);
    if (!isObject(p) || typeof p.label !== 'string' || !isNames(p.names) || !isPoint(p.point ?? null)) bad(`the place ${iri} is not given as a label, names and a point.`);
  }
  if (!Array.isArray(w.candidates)) bad('it has no list of candidates (candidates).');
  const ids = new Set(), pairs = new Set();
  for (const c of w.candidates) {
    const where = isObject(c) && typeof c.id === 'string' ? `candidate ${c.id}` : 'a candidate';
    if (!isObject(c) || typeof c.id !== 'string' || !c.id) bad('a candidate has no id.');
    if (ids.has(c.id)) bad(`two candidates have the id ${c.id}.`);
    ids.add(c.id);
    if (typeof c.candidate_source !== 'string' || !Object.hasOwn(w.places, c.candidate_source)) bad(`${where} is for a place the file does not list (${c.candidate_source}).`);
    if (typeof c.candidate_candidate !== 'string' || !c.candidate_candidate) bad(`${where} does not say which place it suggests (candidate_candidate).`);
    if (!isIri(c.candidate_candidate)) bad(`${where} suggests "${c.candidate_candidate}", which is not a web address (an IRI).`);
    if (c.candidate_candidate === c.candidate_source) bad(`${where} suggests that a place is the same as itself.`);
    const pair = c.candidate_source + '\n' + c.candidate_candidate;
    if (pairs.has(pair)) bad(`${where} suggests the same place for the same place as another candidate (${c.candidate_candidate} for ${c.candidate_source}).`);
    pairs.add(pair);
    if (typeof c.similarity_score !== 'number' || !(c.similarity_score >= 0 && c.similarity_score <= 1)) bad(`${where} has a score that is not between 0 and 1.`);
    if (c.distance_km !== undefined && c.distance_km !== null && !(typeof c.distance_km === 'number' && c.distance_km >= 0)) bad(`${where} has a distance that is not a number of kilometres.`);
    if (!isObject(c.other) || typeof c.other.label !== 'string' || !isNames(c.other.names) || !isPoint(c.other.point ?? null)) bad(`${where} does not describe the place it suggests (other).`);
    if (!['suggested', 'confirmed', 'rejected'].includes(c.candidate_status)) bad(`${where} has a status that is not suggested, confirmed or rejected.`);
    // Its address in the candidate set last exported (candidates.js), or in an earlier set that published it.
    if (c.iri !== undefined && !(isIri(c.iri) && CANDIDATE_IRI.test(c.iri))) bad(`${where} has an address in a candidate set (iri) that is not one: a web address ending in #c- and 8, 12, 16 … lower-case hex digits.`);
    const d = c.decision ?? null;
    if (d === null) { if (c.candidate_status !== 'suggested') bad(`${where} is ${c.candidate_status}, but no decision is recorded.`); continue; }
    if (!isObject(d) || !DECISIONS.includes(d.kind)) bad(`${where} has a decision that is not match, not-this or distinct.`);
    if (STATUS_OF[d.kind] !== c.candidate_status) bad(`${where} is ${c.candidate_status}, which disagrees with its decision (${d.kind}).`);
    if (typeof d.decided_at !== 'string') bad(`${where} does not say when it was decided.`);
    if (!DATE_TIME.test(d.decided_at)) bad(`${where} says it was decided "${d.decided_at}", which is not a date and time as ISO 8601 writes them (such as 2026-09-30T12:00:00Z).`);
    if (d.kind !== 'not-this' && !IDENTITY_TYPES.includes(d.identityType)) bad(`${where} does not say what kind of match it is (identityType).`);
    if (d.kind === 'distinct' && d.identityType !== 'exactMatch') bad(`${where} says two places are different, which PLATO records only of an exact match.`);
    if (d.kind === 'distinct' && !(typeof d.basis === 'string' && d.basis.trim())) bad(`${where} says two places are different without saying why (basis).`);
  }
  // The candidate sets exported from this review, last the latest: each with the earlier sets it was exported against.
  if (w.candidate_sets !== undefined && !(Array.isArray(w.candidate_sets) && w.candidate_sets.every((x) => isObject(x) && isIri(x['@id']) && !x['@id'].includes('#')
    && typeof x.issued === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.issued) && Array.isArray(x.previous) && x.previous.every(isIri)))) bad('the candidate sets exported from it (candidate_sets) are not listed as an address, a date of issue and the earlier sets each.');
  if (w.reviewer !== undefined && w.reviewer !== null) { try { checkReviewer(w.reviewer); } catch (e) { bad(e.message[0].toLowerCase() + e.message.slice(1)); } }
  if (w.cursor !== undefined && !(Number.isInteger(w.cursor) && w.cursor >= 0)) bad('its place in the review (cursor) is not a count.');
  checkLookups(w, bad);
  checkMethodos(w, bad);
  // WHG by its one address (canonicalEndpoint), however a file wrote it; nothing given is changed in place.
  const lookups = (w.lookups ?? []).map((l) => (canonicalEndpoint(l.service.endpoint) === l.service.endpoint ? l : { ...l, service: { ...l.service, endpoint: canonicalEndpoint(l.service.endpoint) } }));
  const candidates = w.candidates.map((c) => (typeof c.gazetteer?.service === 'string' && canonicalEndpoint(c.gazetteer.service) !== c.gazetteer.service ? { ...c, gazetteer: { ...c.gazetteer, service: canonicalEndpoint(c.gazetteer.service) } } : c));
  return { reviewer: null, cursor: 0, ...w, krisis: WORK_VERSION, candidates, lookups };
}

// ---- Krisis: gazetteer lookup (work file version 2) --------------------------------------------------
/** The versions readWork reads; an earlier one is given back as the current. */
const READS = [1, 2];
export const QUERY_STATES = ['pending', 'answered', 'unanswered', 'stopped'];
/** What version 2 adds, checked: the lookups, and the candidates that come from them. */
function checkLookups(w, bad) {
  if (w.krisis < 2) { if (w.lookups !== undefined) bad('it is of version 1, which has no lookups.'); return; }
  if (!Array.isArray(w.lookups)) bad('it has no list of lookups (lookups).');
  const ids = new Set();
  for (const l of w.lookups) {
    if (!isObject(l) || typeof l.id !== 'string' || !l.id) bad('a lookup has no id.');
    if (ids.has(l.id)) bad(`two lookups have the id ${l.id}.`);
    ids.add(l.id);
    if (!isObject(l.service) || typeof l.service.endpoint !== 'string' || typeof l.service.title !== 'string') bad(`lookup ${l.id} does not say which service it asked (service).`);
    if (typeof l.started_at !== 'string' || !DATE_TIME.test(l.started_at)) bad(`lookup ${l.id} does not say when it began (started_at).`);
    if (l.attribution !== null && l.attribution !== undefined && !isObject(l.attribution)) bad(`lookup ${l.id} has an attribution that is not an object.`);
    if (!isObject(l.queries)) bad(`lookup ${l.id} does not list the places it looked up (queries).`);
    for (const [iri, q] of Object.entries(l.queries)) {
      if (!Object.hasOwn(w.places, iri)) bad(`lookup ${l.id} looked up a place the file does not list (${iri}).`);
      if (!isObject(q) || !QUERY_STATES.includes(q.state)) bad(`lookup ${l.id} has a place whose state is not pending, answered, unanswered or stopped (${iri}).`);
      if (!isNames(q.sent)) bad(`lookup ${l.id} does not say what it sent for ${iri}.`);
    }
  }
  for (const c of w.candidates) {
    if (c.lookup === undefined || c.lookup === null) { if (w.others === null) bad(`candidate ${c.id} comes from a local match, but the file names no other dataset.`); continue; }
    if (!ids.has(c.lookup)) bad(`candidate ${c.id} names a lookup the file does not have (${c.lookup}).`);
    if (!isObject(c.gazetteer)) bad(`candidate ${c.id} comes from a lookup but has no gazetteer figures (gazetteer).`);
  }
}

// ---- Krisis × Methodos (#28): optional fields of version 2 ------------------------------------------------
export const ROW_STATES = ['filter', 'exclude'];
const BATCH = /^b[1-9]\d*$/;
/** The optional fields Methodos adds, checked when present (see the top of this file). */
function checkMethodos(w, bad) {
  for (const [iri, p] of Object.entries(w.places)) if (p.rowState !== undefined && p.rowState !== null && !ROW_STATES.includes(p.rowState)) bad(`the place ${iri} has a row state that is not filter or exclude (rowState).`);
  for (const c of w.candidates) {
    if (c.flagged !== undefined && typeof c.flagged !== 'boolean') bad(`candidate ${c.id} has a flag that is not true or false (flagged).`);
    if (c.note !== undefined && typeof c.note !== 'string') bad(`candidate ${c.id} has a note that is not text (note).`);
    const g = c.gazetteer;
    if (isObject(g)) {
      if (g.withheld !== undefined && typeof g.withheld !== 'boolean') bad(`candidate ${c.id} does not say whether WHG's guard withholds it as true or false (gazetteer.withheld).`);
      if (g.tie !== undefined && g.tie !== null && typeof g.tie !== 'boolean') bad(`candidate ${c.id} does not say whether it is tied as true, false or null (gazetteer.tie).`);
      if (g.dice !== undefined && g.dice !== null && !(typeof g.dice === 'number' && g.dice >= 0 && g.dice <= 1)) bad(`candidate ${c.id} has a Dice coefficient that is not between 0 and 1 (gazetteer.dice).`);
    }
    const d = c.decision;
    if (isObject(d)) {
      if (d.batch !== undefined && !(typeof d.batch === 'string' && BATCH.test(d.batch))) bad(`candidate ${c.id} names a batch that is not b1, b2, … (decision.batch).`);
      if (d.guard !== undefined && !(isObject(d.guard) && typeof d.guard.rule === 'string')) bad(`candidate ${c.id} has a guard that does not name its rule (decision.guard).`);
      if (d.batch !== undefined && d.kind !== 'match') bad(`candidate ${c.id} is in a batch of the bulk accept, which only accepts, but is ${d.kind}.`);
    }
  }
  if (w.batches !== undefined && !(Array.isArray(w.batches) && w.batches.every((b) => isObject(b) && typeof b.id === 'string' && BATCH.test(b.id)))) bad('its batches of the bulk accept are not listed as b1, b2, … (batches).');
  for (const l of w.lookups || []) for (const [iri, q] of Object.entries(l.queries || {})) {
    if (q.variants !== undefined && !(Array.isArray(q.variants) && q.variants.length === q.sent.length && q.variants.every((v, i) => isObject(v) && v.text === q.sent[i] && typeof v.how === 'string')))
      bad(`lookup ${l.id} records forms of the names of ${iri} that are not what it sent (variants).`);
  }
}
const candidateOf = (work, id) => { const c = work.candidates.find((x) => x.id === id); if (!c) throw new Error(`No candidate ${id}`); return c; };
/** Flag a candidate for a second look (on: true), or take the flag away. */
export function flag(work, candidateId, on) {
  const c = candidateOf(work, candidateId);
  if (on) c.flagged = true; else delete c.flagged;
  return c;
}
/** The reviewer's note on a candidate, kept in the work file only (never written to the dataset); empty text takes it away. */
export function noteOn(work, candidateId, text) {
  const c = candidateOf(work, candidateId), t = typeof text === 'string' ? text.trim() : '';
  if (t) c.note = t; else delete c.note;
  return c;
}
/**
 * A place's row state: 'filter' (kept without reconciling: never looked up, still written), 'exclude'
 * (left out of the dataset finishing writes, which the version check is told to expect), or null
 * (reconcile, as every place is by default).
 */
export function setRowState(work, placeKey, state) {
  if (!Object.hasOwn(work.places, placeKey)) throw new Error(`No place ${placeKey}`);
  if (state !== null && !ROW_STATES.includes(state)) throw new Error(`Not a row state: ${state}`);
  if (state) work.places[placeKey].rowState = state; else delete work.places[placeKey].rowState;
  return work.places[placeKey];
}
/** The places the reviewer leaves out of the dataset (row state 'exclude'), in review order. */
export const excludedPlaces = (work) => Object.keys(work.places).filter((iri) => work.places[iri].rowState === 'exclude');

/** A work file's text. */
export function serialiseWork(work) { return JSON.stringify(work, null, 2) + '\n'; }

/**
 * Record the reviewer's decision on one candidate, and set its status to agree: 'match' confirms it;
 * 'not-this' (a quick no, nothing written to the dataset) and 'distinct' (the two are different
 * places, which is written, and needs a basis) reject it; null takes a decision back.
 */
export function decide(work, candidateId, kind, { identityType = 'exactMatch', basis, at = new Date().toISOString() } = {}) {
  const c = work.candidates.find((x) => x.id === candidateId);
  if (!c) throw new Error(`No candidate ${candidateId}`);
  if (kind === null) { c.decision = null; c.candidate_status = 'suggested'; return c; }
  if (!DECISIONS.includes(kind)) throw new Error(`Not a decision: ${kind}`);
  if (kind === 'distinct' && !(typeof basis === 'string' && basis.trim())) throw new Error('Saying that two places are different needs a basis.');
  if (kind !== 'not-this' && !IDENTITY_TYPES.includes(identityType)) throw new Error(`Not an identity type: ${identityType}`);
  const d = { kind, decided_at: at };
  if (kind === 'match') d.identityType = identityType;
  if (kind === 'distinct') d.identityType = 'exactMatch';
  if (kind !== 'not-this' && typeof basis === 'string' && basis.trim()) d.basis = basis.trim();
  c.decision = d; c.candidate_status = STATUS_OF[kind];
  return c;
}

/** The subject places under review, in order (the cursor counts along this list). */
export const reviewPlaces = (work) => Object.keys(work.places);
/** One subject place's candidates, best first. */
export const candidatesOf = (work, iri) => {
  const mine = work.candidates.filter((c) => c.candidate_source === iri);
  const local = mine.filter((c) => !c.lookup).sort((a, b) => b.similarity_score - a.similarity_score || (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));
  // Krisis: gazetteer lookup. A lookup's candidates keep the order lookup.js ranked them in (distance first), after the local ones.
  return [...local, ...mine.filter((c) => c.lookup)];
};
/** A place is reviewed once any of its candidates has a decision. */
export const isReviewed = (work, iri) => work.candidates.some((c) => c.candidate_source === iri && c.decision);
export function reviewProgress(work) {
  const decided = new Set(work.candidates.filter((c) => c.decision).map((c) => c.candidate_source));
  return { reviewed: decided.size, total: Object.keys(work.places).length };
}

/** Each file's name, size and SHA-256, read as a stream. */
export async function fileRecords(files) {
  const out = [];
  for (const f of files) out.push({ name: f.name, size: f.size, sha256: await fileSha256(f) });
  return out;
}
/**
 * Whether `files` are the ones a side of the work file (work.subjects, work.others) was made from:
 * the names of the recorded files no file given matches, and of the files given that match none.
 * Empty when they are the same.
 */
export async function filesDiffer(side, files) {
  const now = await fileRecords(files);
  const left = [...now];
  const missing = [];
  for (const f of side.files) {
    const i = left.findIndex((x) => x.sha256 === f.sha256 && x.size === f.size);
    if (i >= 0) left.splice(i, 1); else missing.push(f.name);
  }
  return [...missing, ...left.map((f) => f.name)];
}
