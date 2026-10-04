// Krisis: what the page shows of a region review (Methodos #28, stages 3 and 4), worked out from the
// work file alone: the levels and how far each has come, where a region lies, what it was (or will be)
// looked up within, the notes that go with that, the ways of relaxing it and what each would send, and
// what a change to a settled region would clear. Pure: nothing here sends anything, touches the page,
// or changes the work file it is given (a change is tried on a copy). src/app.js draws it and runs
// the lookups (lookup.js runLevel and runPlaces, as the command line's `lookup --levels` does).
import {
  regionNodes, levelsOf, ancestorsOf, matchesOf, constraintFor, RELAX_ORDER, lastQueryOf, placeState, selectLevel, areaIds, CERTAINTY_LEVELS,
} from '../engine/krisis/regions.js';
import { CERTAINTIES } from '../engine/krisis/work.js';
import { planQueries } from '../engine/krisis/lookup.js';
import { REGION_PAGE as RP } from '../engine/words.js';

const isRegion = (work, key) => Object.hasOwn(work.regions || {}, key);
/**
 * How certain the reviewer is of a match, as the page offers it beside "This one means": PLATO's
 * certainty levels (work.js CERTAINTIES, written as CERTAINTY_LEVELS), each { value, text, iri }.
 * CERTAINTY_DEFAULT is the level PLATO's worked example of a region review gives (#Certain).
 */
export const certaintyChoices = () => CERTAINTIES.map((value) => ({ value, text: RP.certainty[value], iri: CERTAINTY_LEVELS[value] }));
export const CERTAINTY_DEFAULT = 'certain';
/** The options a match on the page is decided with (regions.js decideRegion): what the reviewer chose of each. */
export const regionMatchOptions = ({ identityType, certainty = CERTAINTY_DEFAULT }) => ({ identityType, certainty });

/** A region's own name ("Suffolk"), not its label with the regions above ("Suffolk (England)"). */
export const nameOf = (work, key) => (isRegion(work, key) ? work.regions[key].names?.[0] ?? work.regions[key].label : key);

/** The names of the levels, from the matching of columns ({ heading: level }): { level: heading }. */
export function levelNames(levels = {}) {
  const out = {};
  for (const [h, l] of Object.entries(levels || {})) if (!Object.hasOwn(out, l)) out[l] = String(h).split('\u0000')[0];
  return out;
}
export const levelLabel = (level, names = {}) => (Object.hasOwn(names, level) ? names[level] : RP.level(level));

/**
 * The navigator: one entry per level, widest first, then the places: { level ('places' for the
 * places), name, settled, total, locked, ready, review, text } ("Country 1/1 settled", "County 12/15",
 * "Parish locked", "Places 0/340").
 */
export function navigator(work, names = {}) {
  const levels = new Map();
  for (const n of regionNodes(work)) {
    if (!levels.has(n.level)) levels.set(n.level, { level: n.level, name: levelLabel(n.level, names), settled: 0, total: 0, locked: 0, ready: 0, review: 0 });
    const l = levels.get(n.level); l.total++; l[n.state]++;
  }
  const out = [...levels.values()].sort((a, b) => a.level - b.level).map((l) => ({ ...l,
    text: l.settled === l.total ? RP.nav.settled(l.name, l.settled, l.total) : l.locked === l.total ? RP.nav.locked(l.name) : RP.nav.open(l.name, l.settled, l.total) }));
  const states = Object.keys(work.places).map((iri) => placeState(work, iri));
  const count = (s) => states.filter((x) => x === s).length;
  out.push({ level: 'places', name: 'places', settled: count('settled'), total: states.length, locked: count('locked'), ready: count('ready'), review: count('review'), text: RP.nav.places(count('settled'), states.length) });
  return out;
}

/**
 * The level to show first: the widest with a region still to settle that is not waiting for the
 * region above, else the places. (The command line, without --level, looks up the widest level with a
 * region READY, else the places: nextTarget.)
 */
export function firstOpen(work) {
  const nodes = regionNodes(work);
  return levelsOf(work).find((l) => nodes.some((n) => n.level === l && (n.state === 'ready' || n.state === 'review'))) ?? 'places';
}
/** What `plato-tools lookup --levels` with no --level looks up: the widest level with a region ready, else the places. */
export const nextTarget = (work) => levelsOf(work).find((l) => selectLevel(work, l).length) ?? 'places';

/** Where a region (or a place) lies: "in England › Suffolk". */
export const chainOf = (work, key) => RP.chain(ancestorsOf(work, key).reverse().map((k) => nameOf(work, k)));
/** The names of the regions a place lies in, widest first. */
export const placeChain = (work, iri) => ancestorsOf(work, iri).reverse().map((k) => nameOf(work, k));

/** The query a key was last looked up with, if it still stands (not made stale by a change above it, nor stopped before it was sent). */
function standing(work, key) {
  const q = lastQueryOf(work, key);
  return q && q.constraint && !q.stale && (q.state === 'answered' || q.state === 'unanswered') ? q : null;
}
/** The constraint shown for a key: the one it was looked up under, if that still stands; else the one it would be looked up under now. */
export function shownConstraint(work, key, { relax } = {}) {
  const q = standing(work, key);
  return q ? { looked: true, c: q.constraint, q } : { looked: false, c: constraintFor(work, key, { relax }), q: null };
}
/** The constraint in words: "Looked up within Suffolk (gn:2636561) and in GB." */
export function constraintLine(work, key, opts = {}) {
  const { looked, c } = shownConstraint(work, key, opts);
  const from = c.needsArea ?? c.from ?? null;
  return RP.constraint({ looked, kinds: c.kinds || [], name: from ? nameOf(work, from) : null, ids: c.params?.contained_in || [], countries: c.params?.countries || [],
    radius: c.params?.radius, needsArea: !!c.needsArea, noArea: c.noArea ?? null, relaxed: c.relaxed ?? null, from: c.from ?? null, unconstrained: c.relaxed === 'unconstrained' });
}

/**
 * The notes that go with a key's constraint and answer, in words, where they apply: { kind, text }.
 * 'failed-closed' (WHG could not apply the filter, so answered nothing: never "no match"),
 * 'unanswered' (a region WHG did not answer), 'approximate' (WHG applied it by the cells of its grid),
 * 'uncoded' (countries are sent, so a candidate with none recorded cannot pass), and for a region
 * matched to several records, 'union' (what lies within it is looked up within the union of their areas).
 */
export function notesOf(work, key) {
  const out = [];
  const { looked, c, q } = shownConstraint(work, key);
  const from = c.from ? nameOf(work, c.from) : null;
  if (looked && q.failedClosed) out.push({ kind: 'failed-closed', text: RP.failedClosed(from ?? RP.ancestorAny) });
  else if (looked && q.state === 'unanswered' && isRegion(work, key)) out.push({ kind: 'unanswered', text: RP.unanswered });
  if (looked && q.scope?.approximate) out.push({ kind: 'approximate', text: RP.approximate(from ?? RP.ancestorAny) });
  if ((c.kinds || []).includes('countries')) out.push({ kind: 'uncoded', text: RP.uncoded });
  const n = isRegion(work, key) ? matchesOf(work, key).length : 0;
  if (n > 1) out.push({ kind: 'union', text: RP.union(n) });
  return out;
}

const sig = (c) => JSON.stringify([c.from ?? null, c.kinds, c.params, c.needsArea ?? null, c.noArea ?? null]);
/**
 * The steps of relaxing worth offering for these keys (the regions or places to ask again), in
 * RELAX_ORDER: a step is offered when it changes what at least one of them would be asked with,
 * beyond the step before it ('ancestor' only where a region further up is matched and gives a
 * constraint). Each is { relax, text }; the 'ancestor' step's text is ancestorText's.
 */
export function relaxOptions(work, keys) {
  const out = [];
  let prev = new Map(keys.map((k) => [k, sig(constraintFor(work, k))]));
  for (const step of RELAX_ORDER) {
    const now = new Map(keys.map((k) => [k, constraintFor(work, k, { relax: step })]));
    const changes = keys.some((k) => sig(now.get(k)) !== prev.get(k));
    if (step === 'ancestor') {
      const text = ancestorText(work, keys.map((k) => now.get(k)));
      if (changes && text) out.push({ relax: step, text });
      if (!text) continue;   // no region further up gives a constraint: the next step (no constraint) is measured against the one before this
    } else if (changes) out.push({ relax: step, text: RP.relax[step] });
    prev = new Map([...now].map(([k, c]) => [k, sig(c)]));
  }
  return out;
}

/**
 * The words of the 'ancestor' step, from the constraints it builds (constraintFor with relax
 * 'ancestor'), so that they say exactly what is sent: "Within England instead" where the region
 * further up is sent by its ids (contained_in), "Within the area around England instead" where its
 * area is, "In GB instead" where only its countries are; null when none of them is constrained.
 */
export function ancestorText(work, constraints) {
  const formOf = (c) => (c.kinds.includes('contained_in') ? 'ids' : c.kinds.includes('area') || c.needsArea ? 'area' : c.kinds.includes('countries') ? 'countries' : null);
  const built = constraints.filter((c) => c.from !== null && c.from !== undefined && formOf(c));
  if (!built.length) return null;
  const forms = new Set(built.map(formOf)), ups = new Set(built.map((c) => c.from));
  if (forms.size > 1) return RP.relaxAncestor.mixed;
  const name = ups.size === 1 ? nameOf(work, built[0].from) : RP.ancestorAny, form = [...forms][0];
  if (form === 'ids') return RP.relax.ancestor(name);
  if (form === 'area') return RP.relaxAncestor.area(name);
  const countries = new Set(built.map((c) => c.params.countries.join(', ')));
  return countries.size === 1 ? RP.relaxAncestor.countries([...countries][0]) : RP.relaxAncestor.mixed;
}

/**
 * The id of a region's heading on the page, for aria-labelledby: "rh-" and a short hash of its key
 * (FNV-1a, base 36), since a key (a containerKey without a base address) can hold spaces and quotes.
 * The key itself goes in data-rkey.
 */
export function regionDomId(key) {
  let h = 0x811c9dc5;
  for (const ch of String(key)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return `rh-${h.toString(36)}`;
}

/** A key as runLevel and runPlaces send it: its names, and its constraint's params. */
function pseudo(work, key, c, place = null) {
  const base = place ?? (isRegion(work, key) ? { iri: key, label: work.regions[key].names[0], names: work.regions[key].names, point: null } : { iri: key, ...work.places[key] });
  return { ...base, ...(Object.keys(c.params).length ? { params: c.params } : {}) };
}
/**
 * What asking for these keys would send, planned as runLookup plans it (planQueries, in requests of
 * `batchSize`): { queries, requests, fetches } (fetches: the records fetched first for an area).
 */
export function costOf(work, keys, { relax, unconstrained = false, batchSize = 25, places = null } = {}) {
  const byIri = places ? new Map(places.map((p) => [p.iri, p])) : null;
  const areas = new Set();
  const list = keys.map((k) => {
    const c = unconstrained ? { from: null, kinds: [], params: {} } : constraintFor(work, k, { relax });
    if (c.needsArea) areas.add(c.needsArea);
    return pseudo(work, k, c, byIri?.get(k) ?? null);
  });
  const p = planQueries(list, { batchSize }).preview;
  return { queries: p.queries, requests: p.requests, fetches: [...areas].reduce((n, k) => n + areaIds(work, k).length, 0) };
}

/** The regions of a level, with what the page shows of each. */
export function levelRegions(work, level) {
  return regionNodes(work).filter((n) => n.level === level);
}
/** The keys of a level that can be asked again (looked up, or ready, and not settled): what the level's relax buttons ask for. */
export const unsettledOf = (work, level) => levelRegions(work, level).filter((n) => n.state === 'ready' || n.state === 'review').map((n) => n.key);

/**
 * The places runPlaces would look up, chosen as it chooses them: those whose regions are settled,
 * ready (or, with `only`, looked up already); with `unconstrained`, those still locked too.
 */
export function placesToLook(work, { places = null, unconstrained = false, only } = {}) {
  const list = places ? places : Object.entries(work.places).map(([iri, p]) => ({ iri, ...p }));
  const keep = only ? new Set(only) : null;
  return list.filter((p) => {
    if (keep && !keep.has(p.iri)) return false;
    const s = placeState(work, p.iri, Object.hasOwn(work.places, p.iri) ? work.places[p.iri] : p);
    return s === 'locked' ? unconstrained : s === 'ready' || (keep && s === 'review');
  }).map((p) => p.iri);
}
/** The places waiting for their regions, each with the widest region of its chain not yet settled: [{ iri, label, region }]. */
export function lockedPlaces(work) {
  const out = [];
  for (const [iri, p] of Object.entries(work.places)) {
    if (placeState(work, iri) !== 'locked') continue;
    const region = ancestorsOf(work, iri).reverse().find((k) => work.regions[k].outcome === null);
    out.push({ iri, label: p.label || iri, region });
  }
  return out;
}

/**
 * What a change to a region would clear, tried on a copy of the work file: `act(copy)` makes the
 * change (regions.js decideRegion or settleRegion) and returns the snapshot it gives, or null. Returns
 * the snapshot's counts ({ regions, places, decisions, candidates }), or null when it clears nothing.
 * Throws what the change throws (a region with a match cannot be settled with none, say).
 */
export function wouldClear(work, act) {
  const snap = act(structuredClone(work));
  return snap && (snap.counts.decisions || snap.counts.candidates) ? { ...snap.counts } : null;
}
/** What a region's own review was before a change, so that Undo can put the change itself back as well as what it cleared. */
export function priorOf(work, key) {
  return { outcome: work.regions[key].outcome, decisions: work.candidates.filter((c) => c.candidate_source === key).map((c) => ({ id: c.id, decision: structuredClone(c.decision), status: c.candidate_status })) };
}
/** Put a region's own review back as priorOf() kept it. */
export function restorePrior(work, key, prior) {
  work.regions[key].outcome = prior.outcome;
  for (const p of prior.decisions) {
    const c = work.candidates.find((x) => x.id === p.id);
    if (c) { c.decision = structuredClone(p.decision); c.candidate_status = p.status; }
  }
  return work;
}
