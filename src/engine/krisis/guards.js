// Krisis: WHG's guards, and an undoable bulk accept of what passes them (Methodos #28).
//
// The World Historical Gazetteer's own client accepts a reconciliation answer's top candidate only
// when all three of its guards pass (whg3 whg/webpack/js/reconciliation.js:5857-6000, as described
// by whg3-d6 on 3 October 2026; this rule SUPERSEDES the one in the first design):
//
//   (the candidate is an exact title match, OR its score is at least the threshold, 90 by default)
//   AND it is not withheld AND there is no tie.
//
// - Withheld. When the candidate has a numeric confidence, it is withheld when that is under 30, and
//   the names are NOT compared. Only when it has none are the names compared: withheld when the best
//   Sørensen–Dice coefficient over the query's forms and the candidate's name and first 20 other
//   names is under 0.45. An exact match with no confidence is never withheld (WHG's candidateResembles
//   returns at once on cand.match). A pair is compared only when both names contain a Latin letter or
//   neither does (WHG's comparableScripts); when no pair could be, the candidate is not withheld.
// - Tie. Another candidate later in the same answer with a score at least the top's, unless it has
//   the same name AND description (an absent one the same as '') as the top, or the top is an exact
//   match and it is not. As WHG's loop does, the look stops at the first later one scoring under the top.
//
// Only the top of an answer can pass (WHG's client looks at no other). Krisis adds one rule of its
// own: a candidate found only by a head-word query (names.js queryVariants) never passes.
//
// The bulk accept adds another (#31, Stephen, 10 October 2026: "skip ties"): a place is never accepted
// in bulk when another of its candidates, looked up under the same constraint, has the passing one's
// title (diceForm) and is not in another country, that is, when two places of that name were found
// where it was looked for. Within a region (contained_in or an area) distance does not count: every
// namesake inside it is one. A query not confined to a region counts only namesakes within the review's
// greatest distance. Titles only, deliberately, never other names: a record whose alternate name is the
// place's title is a different-looking place the guard's own name test already weighs, and counting
// alternates would tie places with every record that once bore their name. WHG's tie lets such a pair
// through when their scores differ, or when their names and descriptions are the same; on the real WHG it
// took the wrong Agden of two in Cheshire, 47 km off. Records of one title within SAME_PLACE_KM of each
// other are one place, as WHG holds one place several times over; one without a point is a namesake.
//
// Nothing here decides on its own. acceptGuarded() is what the page's "Accept the N that pass WHG's
// guards" button calls, on the reviewer's word, and every decision it makes carries its batch, so
// that undoBatch() takes back exactly those still as it left them. Pure: no network, no pipeline.
import { decide, IDENTITY_TYPES, checkReviewer } from './work.js';
import { guardWords } from '../words.js';
import { distanceKm } from './match.js';

export const GUARD_DEFAULTS = { threshold: 90, minConfidence: 30, minDice: 0.45, altNames: 20 };
export const GUARD_RULE = 'whg-guard';
/**
 * Two records of one title within this many kilometres of each other are taken for one place, not
 * namesakes (#31). WHG returns one place several times under one title, a record from each of
 * GeoNames, OpenStreetMap, Wikidata, a parish list and so on: measured on the real WHG on 10 October
 * 2026 (33 Index Villaris rows, unconfined), the namesake rule held back 12 of the 24 places with a
 * passing candidate without this, and 6 with it (the two Adlingtons and two Agdens of Cheshire and
 * Lancashire, 45 and 47 km apart, among them).
 */
export const SAME_PLACE_KM = 2;

// ---- names ---------------------------------------------------------------------------------------------
/** A name as WHG's client compares it: NFD, combining marks U+0300–036F dropped, lower case, other than letters and digits a space. */
export function diceForm(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
const bigrams = (s) => { const out = new Set(); for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2)); return out; };
/**
 * Sørensen–Dice over the SETS of character bigrams of two names (diceForm): 1 when the two are equal,
 * or when every word of the one with fewer words is a word of the other. 0 when either is empty.
 */
export function dice(a, b) {
  const x = diceForm(a), y = diceForm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const [short, long] = x.split(' ').length <= y.split(' ').length ? [x, y] : [y, x];
  const words = new Set(long.split(' '));
  if (short.split(' ').every((w) => words.has(w))) return 1;
  const bx = bigrams(x), by = bigrams(y);
  if (!bx.size || !by.size) return 0;
  let both = 0;
  for (const g of bx) if (by.has(g)) both++;
  return (2 * both) / (bx.size + by.size);
}
/** Whether a name contains a Latin letter (WHG's comparableScripts asks only that of each name). */
export function isLatin(s) {
  return /\p{Script=Latin}/u.test(String(s ?? ''));
}
/**
 * The best Dice of the query's forms against the candidate's name and its first 20 other names,
 * skipping a pair of which one name contains a Latin letter and the other does not; null when no pair could be judged.
 */
export function bestDice(forms, cand, { altNames = GUARD_DEFAULTS.altNames } = {}) {
  const theirs = [cand?.name, ...((cand?.altNames ?? cand?.alt_names ?? []).slice(0, altNames))].filter((n) => typeof n === 'string' && diceForm(n));
  let best = null;
  for (const f of (forms || []).filter((n) => typeof n === 'string' && diceForm(n))) {
    for (const n of theirs) {
      if (isLatin(f) !== isLatin(n)) continue;
      const d = dice(f, n);
      if (best === null || d > best) best = d;
    }
  }
  return best;
}
const hasConfidence = (c) => typeof c?.confidence === 'number' && Number.isFinite(c.confidence);
/** { withheld, dice }: by confidence when it has one (dice null, never consulted); else never when exact; else by Dice. */
export function withheldOf(cand, forms, o = {}) {
  const { minConfidence, minDice } = { ...GUARD_DEFAULTS, ...o };
  if (hasConfidence(cand)) return { withheld: cand.confidence < minConfidence, dice: null };
  if (cand?.match === true) return { withheld: false, dice: null };   // WHG: the service matched the name exactly
  const d = bestDice(forms, cand, o);
  return { withheld: d !== null && d < minDice, dice: d === null ? null : Math.round(d * 1000) / 1000 };
}
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
/** Whether the top of an answer is tied (see the top of this file); `answer` is the whole answer, the top first. */
export function tieOf(answer) {
  const top = answer?.[0];
  if (!top) return false;
  const s = num(top.score);
  if (s === null) return false;
  for (let i = 1; i < answer.length; i++) {
    const x = answer[i];
    if (!(num(x.score) !== null && x.score >= s)) break;   // WHG's loop stops at the first scoring under the top
    if (top.match === true && x.match !== true) continue;
    if (x.name !== top.name || (x.description || '') !== (top.description || '')) return true;
  }
  return false;
}
const strong = (c, threshold) => c?.match === true || (num(c?.score) !== null && c.score >= threshold);

/**
 * WHG's guard for one candidate of one answer (`answer`: the whole list the service gave for one
 * query, `candidate` one of its members as the gazetteer module gives it). options: threshold (90),
 * forms (the names sent for the place: the query, by default), headWord (true: the answer is to a
 * head-word query). Returns { pass, exact, score, confidence, dice, withheld, tie, top, reason } where
 * reason is null when it passes, else 'not-top' | 'head-word' | 'weak' | 'withheld' | 'tie'.
 */
export function guard(candidate, answer, options = {}) {
  const { threshold = GUARD_DEFAULTS.threshold, forms, headWord = false } = options;
  const top = answer?.[0] === candidate;
  const { withheld, dice: d } = withheldOf(candidate, forms ?? [answer?.query ?? answer?.key?.[1]].filter(Boolean), options);
  const tie = top ? tieOf(answer) : null;
  const out = { exact: candidate?.match === true, score: num(candidate?.score), confidence: hasConfidence(candidate) ? candidate.confidence : null, dice: d, withheld, tie, top };
  const reason = !top ? 'not-top' : headWord ? 'head-word' : !strong(candidate, threshold) ? 'weak' : withheld ? 'withheld' : tie ? 'tie' : null;
  return { pass: reason === null, ...out, reason };
}

// ---- on the work file ------------------------------------------------------------------------------------
/**
 * The guard of a candidate in a work file, from what mergeAnswers() stored on it (gazetteer.withheld,
 * .tie, .head_word_only, .answer_rank, its score and match): the same verdict as guard(). A candidate
 * of the other dataset, or one looked up before the guard's figures were stored (an older work file:
 * its tie cannot be known without the whole answer), never passes, with reason 'not-recorded'.
 */
export function guardOf(c, { threshold = GUARD_DEFAULTS.threshold } = {}) {
  const g = c?.gazetteer;
  const base = { exact: g?.match === true, score: num(g?.score), confidence: num(g?.confidence), dice: num(g?.dice), withheld: g?.withheld ?? null, tie: g?.tie ?? null, top: g?.answer_rank === 1 };
  const reason = !g || typeof g.withheld !== 'boolean' ? 'not-recorded'
    : g.answer_rank !== 1 ? 'not-top' : g.head_word_only ? 'head-word'
    : typeof g.tie !== 'boolean' ? 'not-recorded'
    : !strong(g, threshold) ? 'weak' : g.withheld ? 'withheld' : g.tie ? 'tie' : null;
  return { pass: reason === null, ...base, reason };
}
/** The work file's candidates by place (candidate_source), each in the file's order: one pass, so that nothing per place is a search of every candidate. */
function bySource(work) {
  const m = new Map();
  for (const c of work.candidates) { const l = m.get(c.candidate_source); if (l) l.push(c); else m.set(c.candidate_source, [c]); }
  return m;
}
/** The work file's candidates for a place that pass the guard. */
export const passing = (work, iri, o) => work.candidates.filter((c) => c.candidate_source === iri && guardOf(c, o).pass);
/** The places in `order` with a candidate passing the guard first, each group in the order given. */
export function guardsFirst(work, order, o) {
  const by = bySource(work), yes = [], no = [];
  for (const iri of order) ((by.get(iri) || []).some((c) => guardOf(c, o).pass) ? yes : no).push(iri);
  return [...yes, ...no];
}
/** The greatest distance of a candidate's review: its lookup's, else the matching's, else 50 km. */
function maxKmOf(work, c, lookups) {
  const l = c.lookup ? lookups.get(c.lookup) : null;
  return num(l?.parameters?.maxDistanceKm) ?? num(work.match_parameters?.maxDistanceKm) ?? 50;
}
const rowState = (work, iri) => work.places[iri]?.rowState ?? null;
const isFar = (work, c, lookups) => typeof c.distance_km === 'number' && c.distance_km > maxKmOf(work, c, lookups);
const otherCountry = (work, iri, c) => c.ccodes_agree === false || ccodesDisagree(work.places[iri], c);
/** Whether two candidates are one place held twice: both have a point, within SAME_PLACE_KM. */
const samePlace = (a, b) => {
  const p = a.other?.point, q = b.other?.point;
  return Array.isArray(p) && Array.isArray(q) && distanceKm(p, q) <= SAME_PLACE_KM;
};
/** The constraint a candidate's query was sent under (regions.js storedConstraint), null when it had none, undefined when its lookup is not known. */
function constraintOf(lookups, iri, c) {
  const l = lookups.get(c.lookup);
  if (!l) return undefined;
  return l.queries?.[iri]?.constraint ?? null;
}
/** Whether a constraint confines the lookup to a region: its matches (contained_in) or its area. */
const confined = (k) => !!k && k.from != null && (k.kinds || []).some((x) => x === 'contained_in' || x === 'area');
/** Whether two candidates' queries were sent under the same constraint (the relaxing aside, which only says how it came about). */
const sameConstraint = (a, b) => a !== undefined && b !== undefined
  && JSON.stringify(a && { from: a.from, kinds: a.kinds, params: a.params }) === JSON.stringify(b && { from: b.from, kinds: b.kinds, params: b.params });
/**
 * The place's other candidates with c's title, looked up under the same constraint (the same lookup, or
 * another sent as it was), not in another country, and, when the query was not confined to a region,
 * not far: the namesakes found where it was looked for (#31).
 */
function namesakesOf(work, iri, c, mine, lookups) {
  const name = diceForm(c.other?.label);
  if (!name) return [];
  const k = constraintOf(lookups, iri, c), inRegion = confined(k);
  return mine.filter((x) => x !== c && x.gazetteer && diceForm(x.other?.label) === name
    && (x.lookup === c.lookup || sameConstraint(k, constraintOf(lookups, iri, x)))
    && !otherCountry(work, iri, x) && (inRegion || !isFar(work, x, lookups)) && !samePlace(c, x));
}
/** The name of the region the place's query was confined to, or null (not confined, or relaxed out of it): never the region it lies in, which may not be where it was looked for. */
function lookedWithin(work, iri, c, lookups) {
  const k = constraintOf(lookups, iri, c);
  return (confined(k) && work.regions?.[k.from]?.label) || null;
}
/**
 * What acceptGuarded() would do, changing nothing: { accept: [candidate], leftOut: { far, ccodes,
 * total, examples: [{ id, why }] }, several, tied: [{ id, place, count, region }] }. A place is
 * considered when it has no decision yet and is to be reconciled (no row state). Exactly one of its
 * candidates must pass the guard; that one is left out (and counted) when it is further from the
 * place's point than the review's greatest distance, or its countries disagree with the place's own.
 * A place with several passing is counted in `several`, and nothing is accepted for it. A place whose
 * passing candidate has namesakes where it was looked for (namesakesOf) is listed in `tied`, with how
 * many places of that name there are and the region's name, and nothing is accepted for it (#31).
 */
export function planGuarded(work, { threshold = GUARD_DEFAULTS.threshold } = {}) {
  const accept = [], leftOut = { far: 0, ccodes: 0, total: 0, examples: [] };
  const tied = [];
  let several = 0;
  const by = bySource(work), lookups = new Map();
  for (const l of work.lookups || []) if (!lookups.has(l.id)) lookups.set(l.id, l);
  for (const iri of Object.keys(work.places)) {
    if (rowState(work, iri)) continue;
    const mine = by.get(iri) || [];
    if (mine.some((c) => c.decision)) continue;
    const ok = mine.filter((c) => guardOf(c, { threshold }).pass);
    if (ok.length > 1) { several++; continue; }
    if (!ok.length) continue;
    const c = ok[0];
    const far = isFar(work, c, lookups);
    const ccodes = otherCountry(work, iri, c);
    if (far || ccodes) {
      if (far) leftOut.far++; else leftOut.ccodes++;
      leftOut.total++; leftOut.examples.push({ id: c.id, why: far ? 'far' : 'ccodes' });
      continue;
    }
    const namesakes = namesakesOf(work, iri, c, mine, lookups);
    if (namesakes.length) { tied.push({ id: c.id, place: iri, count: namesakes.length + 1, region: lookedWithin(work, iri, c, lookups) }); continue; }
    accept.push(c);
  }
  return { accept, leftOut, several, tied };
}
function ccodesDisagree(place, c) {
  const mine = place?.ccodes, theirs = c.other?.ccodes;
  if (!Array.isArray(mine) || !mine.length || !Array.isArray(theirs) || !theirs.length) return false;
  const up = (x) => String(x).toUpperCase();
  return !theirs.some((t) => mine.map(up).includes(up(t)));
}
/** The next batch's id, never one used before in this work file (batches, or a decision's batch). */
function nextBatch(work) {
  const used = new Set([...(work.batches || []).map((b) => b.id), ...work.candidates.map((c) => c.decision?.batch).filter(Boolean)]);
  let n = 1;
  while (used.has(`b${n}`)) n++;
  return `b${n}`;
}

/**
 * Accept, as the reviewer's own decisions, every place's one candidate that passes WHG's guard
 * (planGuarded). Called only on the reviewer's word (the page's button): nothing calls it by itself,
 * and the command line never does. Each decision is 'match' of `identityType` (closeMatch by default,
 * the reviewer's choice), with a basis naming the guard, `guard` (the figures it passed on) and
 * `batch`. The batch is recorded in work.batches. Returns { batch, accepted, leftOut, several, ties, tied }:
 * `batch` null when nothing passed; `ties` the places left to the reviewer as having namesakes (#31),
 * `tied` how many places of its name each has.
 */
export function acceptGuarded(work, { reviewer, identityType = 'closeMatch', at = new Date().toISOString(), threshold = GUARD_DEFAULTS.threshold } = {}) {
  if (!IDENTITY_TYPES.includes(identityType)) throw new Error(`Not an identity type: ${identityType}`);
  if (reviewer) { checkReviewer(reviewer); work.reviewer = reviewer; }
  const plan = planGuarded(work, { threshold });
  const counts = { far: plan.leftOut.far, ccodes: plan.leftOut.ccodes, total: plan.leftOut.total };
  const ties = plan.tied.length, tied = plan.tied.map((t) => t.count);
  if (!plan.accept.length) return { batch: null, accepted: 0, leftOut: counts, several: plan.several, ties, tied };
  const batch = nextBatch(work);
  for (const c of plan.accept) {
    const v = guardOf(c, { threshold });
    const g = { rule: GUARD_RULE, threshold, exact: v.exact, score: v.score, confidence: v.confidence, dice: v.dice };
    decide(work, c.id, 'match', { identityType, basis: guardWords.basis(g), at });
    Object.assign(c.decision, { guard: g, batch });
  }
  (work.batches ||= []).push({ id: batch, at, identityType, threshold, accepted: plan.accept.length, leftOut: counts });
  return { batch, accepted: plan.accept.length, leftOut: counts, several: plan.several, ties, tied };
}
/**
 * Take back a batch: clear the decisions that still carry it (a decision changed since, or taken back
 * and made again, no longer does, and is kept). Returns how many were cleared.
 */
export function undoBatch(work, batch) {
  let n = 0;
  for (const c of work.candidates) if (c.decision?.batch === batch) { decide(work, c.id, null); n++; }
  const b = (work.batches || []).find((x) => x.id === batch);
  if (b) b.undone = n;
  return n;
}
