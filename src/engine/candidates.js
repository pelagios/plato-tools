// Elenchos (check): what no JSON Schema can see in candidate sets (PLATO 05cf78a; the candidate set
// specification's section 13.3). The schema checks each candidate alone; these rules compare
// candidates with each other within a set, across the candidate sets given together, and with the
// dataset the sets were made for. Each rule returns findings, { severity, kind, example }; the words
// for each kind are CANDIDATE_CHECK_TEXT's (report.js), and the pipeline (runCandidateChecks) reports
// them. Ported from the specification's prototype (elenchos.py, tested by neg.py), rule for rule.
//
// A candidate's @id (section 5): its candidate set's IRI without any fragment, "#c-", and the first 8
// hex digits (or 12, 16 … where 8 would begin like another candidate's hash) of the SHA-256 of
//   JSON.stringify([subject, object, algorithmVersion, matchParameters ?? ''])
// which is that array in the JSON Canonicalization Scheme (RFC 8785), hashed as UTF-8 with no
// Unicode normalisation. generatedAt, similarityScore and status are not hashed: the four inputs are
// what make one candidate the same as another.
import { sha256 } from '../lib/sha256.js';

const FIRST = 8, MORE = 4;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** The four inputs that make a candidate what it is. */
export const candidateInputs = (c) => [c.subject, c.object, c.algorithmVersion, c.matchParameters ?? ''];
/** The text a candidate's @id is the hash of. */
export const candidateText = (c) => JSON.stringify(candidateInputs(c));
const sameKey = (c) => candidateText(c);
/** An IRI without its fragment. */
const noFragment = (iri) => String(iri).split('#')[0];
/**
 * Where a candidate set's IRI sits: the IRI without its fragment, up to its last '/'. A producer's series
 * of sets shares it (…/candidates/run-2026-09-09, …/candidates/run-2026-10-01), and only sets under
 * one base are compared for distinct hashes: the minter was given its own earlier sets, not another
 * producer's.
 */
export const setBase = (iri) => noFragment(iri).replace(/[^/]*$/, '');
// The form of a candidate's @id the schema allows (its pattern): the id rules below read only these,
// and leave the rest to the schema's refusal, which is worded for a person (explainSchema).
const ID = /^(.*)#c-((?:[0-9a-f]{4}){2,})$/;
// What a candidate says, beyond its @id: two copies of one set that disagree in any of these are a
// frozen set changed.
const DESCRIBED = ['subject', 'object', 'algorithmVersion', 'matchParameters', 'similarityScore', 'generatedAt', 'status'];

/**
 * A candidate set as these rules read it: its IRI, issue date, the dataset it is for, and its
 * candidates, each kept with only what the rules read.
 */
export function slimSet(header, candidates, label) {
  const h = isObject(header?.candidateSet) ? header.candidateSet : {};
  return { id: typeof h['@id'] === 'string' ? h['@id'] : undefined, issued: typeof h.issued === 'string' ? h.issued : '', candidatesFor: h.candidatesFor, label,
    candidates: candidates.filter(isObject).map((c) => Object.fromEntries(['@id', ...DESCRIBED].filter((k) => k in c).map((k) => [k, c[k]]))) };
}

/**
 * Within one set: an @id given twice (duplicate-id); one candidate listed twice, under two ids
 * (same-candidate-twice: list it once); an @id not under its set's IRI (id-not-under-set), which
 * refuses the withdrawn <subject IRI>#c- form too; an @id whose hex is not its hash's beginning
 * (id-not-minted, a warning, naming the prefix it should have); a candidate matching a place with
 * itself (subject-is-object, a warning).
 */
export function checkSet(set) {
  const out = [], seen = new Set(), same = new Map();
  for (const c of set.candidates) {
    const id = c['@id'];
    if (typeof id === 'string') {
      if (seen.has(id)) out.push({ severity: 'error', kind: 'duplicate-id', example: id });
      seen.add(id);
    }
    const k = sameKey(c), label = typeof id === 'string' ? id : candidateText(c);
    if (same.has(k)) out.push({ severity: 'error', kind: 'same-candidate-twice', example: `${label}: the same as ${same.get(k)}` });
    else same.set(k, label);
    const m = typeof id === 'string' && ID.exec(id);
    if (m && set.id !== undefined) {
      if (noFragment(m[1]) !== noFragment(set.id)) out.push({ severity: 'error', kind: 'id-not-under-set', example: `${id}: the candidate set is ${noFragment(set.id)}` });
      else {
        const hash = sha256(candidateText(c));
        if (!hash.startsWith(m[2])) out.push({ severity: 'warning', kind: 'id-not-minted', example: `${id}: its hash begins ${hash.slice(0, m[2].length)}` });
      }
    }
    if (c.subject !== undefined && c.subject === c.object) out.push({ severity: 'warning', kind: 'subject-is-object', example: label });
  }
  return out;
}

/**
 * Across the candidate sets given, earliest issued first (ties: in the order given).
 * - already-published (error): a candidate (the same four inputs) that an earlier set published; a
 *   new set leaves it out.
 * - described-differently (error): one @id described two ways. Ids are under their set's IRI, so this
 *   can only be two copies of one set (the same set @id) that disagree; a set is frozen. The same set
 *   given twice, identically, is not reported.
 * - not-distinct (warning): a candidate's hex does not differ from every other candidate's hash in its
 *   set and in the earlier sets under the same base (section 5). A warning, since only the minter knew
 *   which earlier sets it was given.
 */
export function checkAcross(sets) {
  const out = [], first = new Map(), published = new Map(), digests = new Map();
  const order = sets.map((s, n) => n).sort((a, b) => (sets[a].issued < sets[b].issued ? -1 : sets[a].issued > sets[b].issued ? 1 : a - b));
  order.forEach((n, at) => {
    const set = sets[n], S = set.id;
    const copyOfEarlier = order.slice(0, at).some((m) => sets[m].id === S);
    for (const c of set.candidates) {
      const id = c['@id'];
      if (typeof id === 'string') {
        // An id given twice within one set is duplicate-id (checkSet); here, two sets that describe it.
        const was = first.get(id);
        if (was && was.n !== n) {
          const diff = DESCRIBED.filter((k) => JSON.stringify(was.c[k]) !== JSON.stringify(c[k]));
          if (diff.length) out.push({ severity: 'error', kind: 'described-differently', example: `${id}: ${diff.join(', ')}` });
        } else if (!was) first.set(id, { c, n });
      }
      const k = sameKey(c), p = published.get(k);
      if (p && p.set !== S && !copyOfEarlier) out.push({ severity: 'error', kind: 'already-published', example: `${typeof id === 'string' ? id : candidateText(c)}: first published as ${p.id}` });
      if (!p) published.set(k, { set: S, id });
    }
    if (copyOfEarlier || S === undefined) return;
    const base = setBase(S), earlier = digests.get(base) || [];
    const mine = set.candidates.map((c) => ({ c, m: typeof c['@id'] === 'string' && ID.exec(c['@id']), h: sha256(candidateText(c)) }));
    const pool = [...earlier, ...mine.map((x) => x.h)];
    for (const { c, m, h } of mine) if (m && pool.some((o) => o !== h && o.startsWith(m[2]))) out.push({ severity: 'warning', kind: 'not-distinct', example: c['@id'] });
    digests.set(base, [...earlier, ...mine.map((x) => x.h)]);
  });
  return out;
}

/**
 * Both ends of the link between a dataset and its candidate sets agree:
 * - ends-disagree (error): a set the dataset lists in candidateSets, given, whose candidatesFor is not
 *   the dataset's @id;
 * - set-not-listed (warning): a set given whose candidatesFor is this dataset, which the dataset's
 *   candidateSets (where it has the key) does not list.
 */
export function checkEnds(gazetteer, sets) {
  const D = gazetteer?.['@id'], listed = Array.isArray(gazetteer?.candidateSets) ? gazetteer.candidateSets : null;
  const out = [], byId = new Map();
  for (const s of sets) if (s.id !== undefined && !byId.has(s.id)) byId.set(s.id, s);
  for (const i of listed || []) {
    const s = byId.get(i);
    if (s && s.candidatesFor !== D) out.push({ severity: 'error', kind: 'ends-disagree', example: `${i}: made for ${s.candidatesFor ?? 'no dataset'}, not ${D ?? 'this dataset, which has no @id'}` });
  }
  if (listed) for (const [i, s] of byId) if (D !== undefined && s.candidatesFor === D && !listed.includes(i)) out.push({ severity: 'warning', kind: 'set-not-listed', example: i });
  return out;
}

/** The candidates of the sets given, by @id, for the identity relations that answer them. */
export function candidateIndex(sets) {
  const index = new Map();
  for (const s of sets) for (const c of s.candidates) if (typeof c['@id'] === 'string' && !index.has(c['@id'])) index.set(c['@id'], c);
  return index;
}

/**
 * Each identity relation that answers a candidate (promotedFrom) in a record, with the subject it is
 * about: its own, else its attestation's `about`, else its place's @id.
 */
export function* answers(value, about) {
  if (Array.isArray(value)) { for (const v of value) yield* answers(v, about); return; }
  if (!isObject(value)) return;
  if (typeof value.promotedFrom === 'string') yield { promotedFrom: value.promotedFrom, subject: value.subject ?? about, object: value.object, id: value['@id'] };
  const here = typeof value.about === 'string' ? value.about : (value.attestations || value.identityRelations) && typeof value['@id'] === 'string' ? value['@id'] : about;
  for (const [k, v] of Object.entries(value)) if (k !== 'promotedFrom' && (Array.isArray(v) || isObject(v))) yield* answers(v, here);
}

/**
 * One answer, against the candidates given: promotedFrom naming no candidate in them
 * (promoted-from-unresolved, a warning), or naming one whose pair is not the relation's, in either
 * order (promoted-from-other-pair, a warning).
 */
export function checkAnswer(a, index) {
  const who = `${a.id ?? `${a.subject ?? '?'} to ${a.object ?? '?'}`}`;
  const c = index.get(a.promotedFrom);
  if (!c) return { severity: 'warning', kind: 'promoted-from-unresolved', example: `${who}: ${a.promotedFrom}` };
  const pair = (x, y) => (x === c.subject && y === c.object) || (x === c.object && y === c.subject);
  if (!pair(a.subject, a.object)) return { severity: 'warning', kind: 'promoted-from-other-pair', example: `${who}: ${a.promotedFrom} matches ${c.subject} with ${c.object}` };
  return null;
}
