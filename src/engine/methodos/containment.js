// Methodos: what the region review hands on, and what records it (PLATO #23, option B), checked in
// words. Light (no pipeline): the page (src/methodos/page.js) asks these before it counts an
// interactive step or a Finish run as the step's, and the adapters (adapters.js) before they run.
import { DataError } from '../input.js';
import { isIri } from '../krisis/work.js';
import { regionProgress } from '../krisis/regions.js';
import { CONTAINED_IN } from '../hermes/within.js';

/** Whether every region of a review is settled: its progress, or a DataError in words (none at all, or which levels are open). */
export function regionsSettled(work) {
  const p = regionProgress(work);
  if (!p.total) throw new DataError('The review has no regions to identify: begin the region review ("Review the regions level by level", in step 5) on the dataset the table was converted to under a base address, whose places lie in regions.');
  const open = p.levels.filter((l) => l.settled < l.total);
  if (open.length) throw new DataError(`${p.total - p.settled} of the ${p.total} regions are not settled yet (${open.map((l) => `level ${l.level}: ${l.total - l.settled} of ${l.total}`).join('; ')}): decide each one, or say it has no match, and the step is done.`);
  return p;
}
/** The references among `refs` whose file the review was not made of (by SHA-256), by name. */
export const notReviewed = (work, refs) => refs.filter((r) => !(work.subjects?.files || []).some((f) => f.sha256 === r.sha256)).map((r) => r.name);

/**
 * What stands in the way of recording a region review as PLATO #23, option B asks, in words, or null:
 * no regions; a region with no address of its own (the table was converted without a base address, so
 * no claim can be made about it); and, once `exported` is asked for, a decision that does not yet name
 * the candidate it answers (the review's candidates not exported), so that its identity could carry no
 * promotedFrom. The page asks this before its Finish run counts as the step; the adapter exports first.
 */
export function relateProblem(work, { exported = true } = {}) {
  const keys = Object.keys(work.regions || {});
  if (!keys.length) return 'The review has no regions, so there is no region to record a place in: identify the regions first (the step before).';
  const bare = keys.filter((k) => !isIri(k));
  if (bare.length) return `${bare.length} of the ${keys.length} regions have no web address of their own (the table was converted without a base address), so nothing can be recorded about them: convert the table again with a base address in Options, and identify its regions.`;
  if (exported) {
    const unnamed = work.candidates.filter((c) => c.decision && c.decision.kind !== 'not-this' && !c.iri).length;
    if (unnamed) return `${unnamed} ${unnamed === 1 ? 'decision does' : 'decisions do'} not name the candidate ${unnamed === 1 ? 'it answers' : 'they answer'} yet: export the suggestions first ("Export the suggestions as a candidate set", under the review), so that each identity records it (promotedFrom).`;
  }
  return null;
}
/** A base address as a dataset's own address: with its trailing slash, or null if it is not a web address. */
export function datasetAddress(base) {
  if (typeof base !== 'string' || !/^https?:\/\/\S+$/.test(base.trim())) return null;
  return base.trim().endsWith('/') ? base.trim() : `${base.trim()}/`;
}
/**
 * What a dataset written by the relate step holds of PLATO #23, option B: the places ContainedIn a
 * region of the review (the source's half, Hermes's), and each matched region's identities (the
 * reviewer's half) with the candidate each answers. { containedIn, regions, identities, promoted, missing }:
 * `missing`, the matched regions with no identity written, or one without promotedFrom.
 */
export function containment(doc, work) {
  const ents = new Map((doc?.spatialEntities || []).map((e) => [e['@id'], e]));
  const regions = new Set(Object.keys(work.regions || {}));
  let containedIn = 0, identities = 0, promoted = 0;
  for (const e of ents.values()) {
    if (regions.has(e['@id'])) continue;
    if ((e.attestations || []).some((a) => (a.relations || []).some((r) => r.relationType === CONTAINED_IN && regions.has(r.relatesTo)))) containedIn++;
  }
  const missing = [];
  for (const [k, r] of Object.entries(work.regions || {})) {
    if (r.outcome !== 'matched') continue;
    const ids = (ents.get(k)?.attestations || []).flatMap((a) => a.identities || []).filter((i) => i.subject === k);
    identities += ids.length; promoted += ids.filter((i) => isIri(i.promotedFrom)).length;
    if (!ids.length || ids.some((i) => !isIri(i.promotedFrom))) missing.push(k);
  }
  return { containedIn, regions: regions.size, identities, promoted, missing };
}

/**
 * Whether a step writes its input out in the format it already has (Stephen, 4 October 2026): a
 * conversion whose workflow-given format (`options.target`, as the interview set it) is the input's
 * own (`target`, the input's format as a target key). Such a step is done by downloading the file
 * as it is, never by converting it into itself, which the page does not offer.
 */
export const writesItself = (step, target) => !!step && step.op === 'convert' && typeof step.options?.target === 'string' && !!target && step.options.target === target;

/**
 * Words for a review whose saved address (work.subjects.uri) was taken from a base address when its
 * candidates were exported (subjects.uriFrom 'base': a dataset with no address of its own) and is not
 * the base address now in Options, or null: Finish writes for the review's address, so a base address
 * changed since is said, not acted on. A dataset's own @id is never compared with a base address.
 */
export function baseDiffers(work, base) {
  const saved = work?.subjects?.uri, now = datasetAddress(base);
  if (work?.subjects?.uriFrom !== 'base' || typeof saved !== 'string' || !saved || !now || saved === now) return null;
  return `The base address in Options (${now}) is not the one this review was saved with (${saved}): Finish writes the attestations for ${saved}, the address its candidates were exported for. Set Options back to it if your places keep that address.`;
}
