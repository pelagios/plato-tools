// Krisis: the work file, where a match review keeps its suggestions and the reviewer's decisions
// until they are finished. PLATO itself is not changed for this (PLATO has plato:Candidate, but a
// dataset holds what people say, not what software suggests), so the file is the tools' own; its
// candidate fields are named after plato:Candidate's properties so that the two read alike.
//
// Kept light (no pipeline, no schema library) so that the page can read and write it directly.
//
// The shape, version 1 (test/krisis.test.js holds an example of each part):
//   { krisis: 1, generated_at, algorithm_version, match_parameters: { threshold, maxDistanceKm, topK, base?, blocking, scoring },
//     subjects: { title, uri?, titleFrom?, files: [{ name, size, sha256 }] }, others: { title, uri?, titleFrom?, files },
//     (titleFrom: 'gazetteer', 'given' by the person matching, or 'file-name' when neither gave one)
//     places: { <subject place IRI>: { label, names, point: [lon, lat] | null, ccodes?, types? } },
//     candidates: [{ id, candidate_source, candidate_candidate, similarity_score, distance_km: number | null,
//       candidate_status: 'suggested' | 'confirmed' | 'rejected', generated_at?, algorithm_version?, match_parameters?,
//       other: { label, names, point, source: { title, uri? }, ccodes?, types? },
//       decision: null | { kind: 'match' | 'not-this' | 'distinct', identityType, basis?, decided_at } }],
//     reviewer: null | { name, orcid? }, cursor }
// A candidate's own generated_at, algorithm_version and match_parameters, where given, override the
// file's: a later source of suggestions (a gazetteer's reconciliation service) fits the same record.
import { DataError } from '../input.js';
import { fileSha256 } from './digest.js';

export const WORK_VERSION = 1;
// The problems of a dataset's own that stop part of it being read (the kinds the version check's
// NOT_READ in compare.js lists): a matching, or a dataset finished, is then of less than the whole.
export const NOT_READ_KINDS = ['json-syntax', 'rdf-syntax', 'record-failed', 'late-header', 'not-a-list', 'lpf-v2', 'lpf-not-a-feature', 'jsonl-not-an-object'];
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
  if (w.krisis !== WORK_VERSION) throw new DataError(`This work file is of version ${JSON.stringify(w.krisis)}, and these tools read version ${WORK_VERSION}${typeof w.krisis === 'number' && w.krisis > WORK_VERSION ? ': it was made by a later version of the tools' : ''}.`);
  const bad = (m) => { throw new DataError(`This work file cannot be used: ${m}`); };
  if (typeof w.generated_at !== 'string' || typeof w.algorithm_version !== 'string') bad('it does not say when and how its suggestions were made (generated_at, algorithm_version).');
  if (!isObject(w.match_parameters)) bad('it does not give the parameters its suggestions were made with (match_parameters).');
  try { checkSide(w.subjects, 'subjects'); checkSide(w.others, 'others'); } catch (e) { bad(e.message[0].toLowerCase() + e.message.slice(1)); }
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
  if (w.reviewer !== undefined && w.reviewer !== null) { try { checkReviewer(w.reviewer); } catch (e) { bad(e.message[0].toLowerCase() + e.message.slice(1)); } }
  if (w.cursor !== undefined && !(Number.isInteger(w.cursor) && w.cursor >= 0)) bad('its place in the review (cursor) is not a count.');
  return { reviewer: null, cursor: 0, ...w };
}

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
export const candidatesOf = (work, iri) => work.candidates.filter((c) => c.candidate_source === iri).sort((a, b) => b.similarity_score - a.similarity_score || (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));
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
