// Krisis: a review's suggestions published as a PLATO candidate set (PLATO 05cf78a,
// schemas/candidate-set.schema.json; the candidate set specification, sections 5 and 13.5).
//
// The work file keeps the suggestions in its own snake_case fields, with the reviewer's decisions; a
// candidate set is what the software suggested, as it suggested it, published apart from the dataset
// so that the dataset's identity relations can point at the suggestion they answer (promotedFrom).
// A candidate is a claim by no one, frozen once its set is published: its status is always
// 'suggested', and what became of it is read from the attestations that answer it.
//
// The set's own IRI comes first, since every candidate's IRI is minted under it:
//   <base>candidates/<issued>-<first 8 hex of SHA-256 of JCS([the candidates' hash texts, sorted])>
// unless one is given. Then each candidate's IRI is <set IRI>#c-<hash>, where
//   text = JCS([subject, object, algorithmVersion, matchParameters or ""])   (RFC 8785)
//   hash = lower-case hex of SHA-256(UTF-8(text)), no Unicode normalisation
// with 8 digits, or 12, 16 … : the shortest prefix, in steps of 4, that differs from the hash of every
// other candidate in this set and in the earlier sets given. A candidate whose four inputs are those
// of one an earlier set published is left out, and counted: it keeps the one IRI it was given there.
// The score and the time are not hashed, so a rerun that scores an old pair differently changes
// nothing: the first score stands.
//
// Kept light (no pipeline, no schema library), like work.js, so that the page can export directly.
import { candidateText, candidateHash } from '../candidate-id.js';
import { DataError } from '../input.js';
import { isIri, CANDIDATE_IRI } from './work.js';
export { CANDIDATE_IRI };
import { KRISIS_CANDIDATES } from '../words.js';
import { jcs } from '../../formats/json2rdf.js';
export { jcs };

export const CANDIDATE_SET_SCHEMA = 'https://w3id.org/plato/schemas/candidate-set.schema.json';
const FIRST = 8, MORE = 4, WHOLE = 64;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Strings compared by Unicode code point (JavaScript's sort() compares UTF-16 code units). */
export function byCodePoint(a, b) {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) { const d = x[i].codePointAt(0) - y[i].codePointAt(0); if (d) return d; }
  return x.length - y.length;
}

/** The text a candidate's hash is taken of, and its full hash: the tools' one minting (candidate-id.js), which Elenchos checks by. */
export const hashText = candidateText;
export { candidateHash };
/** The IRI a set's candidates are minted under: the set's own, without any fragment. */
export const setIriOf = (setIri) => setIri.split('#')[0];

/**
 * How many hex digits each of `hashes` (the new candidates' full hashes) takes: the shortest prefix,
 * from 8 in steps of 4, that differs from every other hash of this set and of `earlier` (the earlier
 * sets' hashes, which are never minted again). The same hash twice is the same candidate, and an error.
 */
export function prefixLengths(hashes, earlier = []) {
  const all = [...hashes, ...earlier];
  return hashes.map((h, i) => {
    let n = FIRST;
    while (n < WHOLE && all.some((d, j) => j !== i && d.slice(0, n) === h.slice(0, n))) n += MORE;
    if (all.some((d, j) => j !== i && d === h)) throw new DataError(KRISIS_CANDIDATES.sameHash(h));
    return n;
  });
}

/** The base proposed for a set, from the address of the dataset it is for: that address's folder (https://ex.org/data/gaz -> https://ex.org/data/). */
export function defaultBase(candidatesFor) {
  const bare = candidatesFor.split('#')[0].split('?')[0];
  const cut = bare.lastIndexOf('/');
  return cut > bare.indexOf('//') + 1 ? bare.slice(0, cut + 1) : bare + '/';
}
/** A set's proposed IRI: <base>candidates/<issued>-<8 hex of the JCS array of its candidates' hash texts, sorted by code point>. */
export function proposeSetIri(base, issued, texts, hash = candidateHash) {
  const b = base.endsWith('/') ? base : base + '/';
  return `${b}candidates/${issued}-${hash(jcs([...texts].sort(byCodePoint))).slice(0, FIRST)}`;
}

/** A candidate in the work file, as the candidate set gives it (without @id): the candidate's own fields, else the file's. */
export function asCandidate(work, c) {
  const mp = c.match_parameters ?? work.match_parameters;
  return {
    subject: c.candidate_source,
    object: c.candidate_candidate,
    similarityScore: c.similarity_score,
    algorithmVersion: c.algorithm_version || work.algorithm_version,
    ...(mp === undefined || mp === null || mp === '' ? {} : { matchParameters: typeof mp === 'string' ? mp : jcs(mp) }),
    generatedAt: c.generated_at || work.generated_at,
    status: 'suggested',
  };
}

/** A candidate set given (its object or text), checked enough to mint against and point into; a DataError in words otherwise. */
export function readCandidateSet(set, where = 'An earlier candidate set') {
  let d = set;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { throw new DataError(`${where} is not JSON (${e.message}).`); } }
  const id = d?.candidateSet?.['@id'];
  if (!d || d.profile !== 'candidate-set' || typeof id !== 'string' || !isIri(id) || !Array.isArray(d.candidates)) throw new DataError(KRISIS_CANDIDATES.notASet(where));
  for (const c of d.candidates) {
    if (!c || typeof c['@id'] !== 'string' || typeof c.subject !== 'string' || typeof c.object !== 'string' || typeof c.algorithmVersion !== 'string')
      throw new DataError(KRISIS_CANDIDATES.notASet(where));
  }
  return d;
}

/**
 * Export a review's suggestions as a candidate set.
 *   work      the work file's object (not changed: the result carries a changed copy)
 *   options   setIri (the set's IRI, else proposed under `base`), base (else the folder of the
 *             subjects' dataset address), issued (YYYY-MM-DD, else today), previousSets (the earlier
 *             candidate sets, objects or text: their candidates are left out, and minted against),
 *             title, description, licence, creator (else the reviewer, if any); hash (tests only).
 * Returns { set, work, report, setIri, leftOut }: `set` is the candidate set document, or null when
 * every candidate was left out (nothing to issue); `work` the work file with each candidate's IRI
 * stored in `iri` (the earlier set's for one left out) and the set recorded in `candidate_sets`.
 * Throws DataError, in words, for what cannot be exported.
 */
export function exportCandidates(work, options = {}) {
  const K = KRISIS_CANDIDATES;
  const hash = options.hash || candidateHash;
  const w = JSON.parse(JSON.stringify(work));
  const candidatesFor = w.subjects?.uri;
  if (!isIri(candidatesFor)) throw new DataError(K.noDatasetIri);
  if (!w.candidates?.length) throw new DataError(K.noCandidates);
  const issued = options.issued || new Date().toISOString().slice(0, 10);
  if (!DATE.test(issued)) throw new DataError(K.badIssued(issued));
  const previous = (options.previousSets || []).map((s, i) => readCandidateSet(s, K.earlierSetN(i + 1)));
  // The earlier sets an earlier export of this review was made against were published: without them,
  // their candidates would be published again, and a newcomer could fail to lengthen against them.
  const given = new Set(previous.map((s) => setIriOf(s.candidateSet['@id'])));
  const last = (w.candidate_sets || []).at(-1);
  const missing = (last?.previous || []).filter((iri) => !given.has(iri));
  if (missing.length) throw new DataError(K.previousNotGiven(missing));
  for (const s of previous) if (s.candidateSet.candidatesFor !== candidatesFor) throw new DataError(K.earlierForAnother(s.candidateSet['@id'], s.candidateSet.candidatesFor, candidatesFor));

  const items = [];
  // The earlier sets' candidates, by hash text: what is published already, and the hashes to differ from.
  const published = new Map();
  for (const s of previous) for (const c of s.candidates) {
    const t = hashText(c);
    if (!published.has(t)) published.set(t, c['@id']);
  }
  const earlierHashes = [...published.keys()].map(hash);
  const rows = w.candidates.map((c) => { const out = asCandidate(w, c); return { c, out, text: hashText(out) }; });
  for (const r of rows) {
    if (typeof r.out.algorithmVersion !== 'string' || !r.out.algorithmVersion) throw new DataError(K.noAlgorithm(r.c.id));
    if (typeof r.out.generatedAt !== 'string') throw new DataError(K.noGeneratedAt(r.c.id));
  }
  const fresh = rows.filter((r) => !published.has(r.text));
  const leftOut = rows.length - fresh.length;
  for (const r of rows) if (published.has(r.text)) r.c.iri = published.get(r.text);

  let setIri = options.setIri;
  if (setIri !== undefined && !isIri(setIri)) throw new DataError(K.badSetIri(setIri));
  if (setIri) setIri = setIriOf(setIri);
  const report = { counts: { candidates: fresh.length, leftOut }, errors: 0, items };
  if (!fresh.length) {
    items.push({ severity: 'warning', kind: 'all-left-out', message: K.allLeftOut(leftOut), count: 1, examples: [] });
    return { set: null, work: w, report, setIri: null, leftOut };
  }
  if (!setIri) setIri = proposeSetIri(options.base || defaultBase(candidatesFor), issued, fresh.map((r) => r.text), hash);
  if (given.has(setIri)) throw new DataError(K.setIriTaken(setIri));
  // An earlier export of this review, not given now: if it was published, its candidates are published twice.
  if (last && last['@id'] !== setIri && !given.has(last['@id'])) items.push({ severity: 'warning', kind: 'earlier-export-not-given', message: K.earlierExportNotGiven, count: 1, examples: [last['@id']] });
  const hashes = fresh.map((r) => hash(r.text));
  const lengths = prefixLengths(hashes, earlierHashes);
  fresh.forEach((r, i) => { r.c.iri = `${setIri}#c-${hashes[i].slice(0, lengths[i])}`; });
  const lengthened = lengths.filter((n) => n > FIRST).length;
  report.counts.lengthened = lengthened;
  items.push({ severity: 'loss', kind: 'work-file-only', message: K.workFileOnly, count: 1, examples: [] });

  const reviewer = w.reviewer;
  // What the suggestions were sought in: the other dataset, or (a review by gazetteer lookup only, whose `others` is null) the gazetteers looked up.
  const othersTitle = w.others?.title ?? K.gazetteers([...new Set((w.lookups || []).map((l) => l.service?.title || l.service?.endpoint).filter(Boolean))]);
  const creator = options.creator || (reviewer?.name ? [{ ...(reviewer.orcid ? { '@id': reviewer.orcid } : {}), name: reviewer.name }] : undefined);
  const set = {
    $schema: CANDIDATE_SET_SCHEMA,
    profile: 'candidate-set',
    candidateSet: {
      '@id': setIri,
      title: options.title || K.title(w.subjects.title, othersTitle, issued),
      description: options.description || K.description(w.subjects.title, othersTitle, [...new Set(rows.map((r) => r.out.algorithmVersion))].join(', ')),
      ...(creator ? { creator } : {}),
      ...(options.licence ? { licence: options.licence } : {}),
      issued,
      candidatesFor,
    },
    candidates: fresh.map((r) => ({ '@id': r.c.iri, ...r.out })),
  };
  w.candidate_sets = [...(w.candidate_sets || []), { '@id': setIri, issued, previous: [...given] }];
  return { set, work: w, report, setIri, leftOut };
}

/** A candidate set's text, as the tools write JSON. */
export const serialiseCandidateSet = (set) => JSON.stringify(set, null, 2) + '\n';
