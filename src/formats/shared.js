// Rules the lossy writers (Linked Places Format, the spreadsheet tables) share, so that each is
// stated once.
import { PLATO } from '../lib/context.js';

/**
 * True when an attestation records a denial (plato:negated, PLATO cf87b78): the source states that
 * what it bundles is not so. A writer whose format cannot say "not" must leave such an attestation
 * out and report it: written at all, it says the opposite of its source. Anything but absent or
 * false counts as a denial, so that a malformed flag ("true", "yes") errs towards leaving a
 * statement out, never towards asserting what the source denies.
 */
/**
 * A list, or nothing: what the JSON Schema says is an array but is given as something else (an
 * object, a string, a number, true, null) is read as holding nothing. The Check reports the wrong
 * shape (the schema says what each list is); a writer must not stop on it (DEVELOPERS.md, errors).
 */
export const list = (x) => (Array.isArray(x) ? x : []);

export const isDenial = (a) => a.negated !== undefined && a.negated !== null && a.negated !== false;

// A meta type may be written in full or with the context's plato: prefix, which expands to it.
const metaType = (m) => (m && typeof m.metaType === 'string' && m.metaType.startsWith('plato:') ? PLATO + m.metaType.slice(6) : m && m.metaType);

/** True when a meta-attestation marks alternative readings of one piece of evidence (plato:AlternativeTo). */
export const isAlternative = (meta) => [].concat(meta || []).some((m) => metaType(m) === PLATO + 'AlternativeTo');

// ---- the current state (PLATO e96d90d) ------------------------------------------------------------
// A published gazetteer is append-only: a claim is never deleted, only withdrawn (plato:Retracts) or
// replaced (plato:Supersedes) by a later attestation that points at it. A format with no
// meta-attestations (LPF, the spreadsheet tables) can show only the current state, so it must leave
// out every attestation that is the target of either: written there, a withdrawn claim would read as
// current, with nothing to say otherwise. PLATO JSON and RDF keep both, and the meta-attestation.
const WITHDRAWING = new Map([[PLATO + 'Retracts', 'retracted'], [PLATO + 'Supersedes', 'superseded']]);

/**
 * Add to `into` (target @id -> [{ by, kind }]) every Retracts or Supersedes meta-attestation among
 * `attestations`: which attestation withdraws which, and how. `by` is the withdrawing attestation's
 * @id, or null when it has none (it can then never be withdrawn itself). Resolve with
 * resolveWithdrawn(): whether a target is withdrawn depends on whether its withdrawer still holds.
 */
export function collectWithdrawn(attestations, into = new Map()) {
  for (const a of list(attestations)) {
    if (!a || typeof a !== 'object') continue;
    for (const m of [].concat(a.meta || [])) {
      const kind = WITHDRAWING.get(metaType(m));
      if (!kind || typeof m.targetAttestation !== 'string') continue;
      addWithdrawal(into, m.targetAttestation, typeof a['@id'] === 'string' ? a['@id'] : null, kind);
    }
  }
  return into;
}
export function addWithdrawal(edges, target, by, kind) {
  (edges.get(target) || edges.set(target, []).get(target)).push({ by, kind });
  return edges;
}

/**
 * Which targets are withdrawn in the current state (PLATO 5e7901c): a supersession or retraction
 * takes effect only while it holds itself, so retracting a retraction restores its target, and a
 * chain resolves the same way. Returns { status: target -> 'retracted' | 'superseded', cycles },
 * where a target withdrawn by a holding retraction counts as retracted (the stronger statement),
 * and `cycles` lists attestations caught in a loop of withdrawals, an error in the data; within a
 * loop every withdrawal is taken to hold, so nothing in it is shown as current.
 */
export function resolveWithdrawn(edges) {
  // First the loops: follow each target to whatever withdraws it; any attestation reached again
  // while its own path is still open is in a loop, and so is everything on the path back to it.
  const inLoop = new Set(), done = new Set(), onPath = [];
  const visit = (id) => {
    if (id === null || done.has(id)) return;
    const at = onPath.indexOf(id);
    if (at >= 0) { for (const x of onPath.slice(at)) inLoop.add(x); return; }
    onPath.push(id);
    for (const e of edges.get(id) || []) visit(e.by);
    onPath.pop(); done.add(id);
  };
  for (const t of edges.keys()) visit(t);
  // Then each target holds unless something that holds withdraws it; a loop's members never hold.
  const status = new Map(), memo = new Map();
  const kindOf = (id) => { let k = null; for (const e of edges.get(id) || []) { k = k === 'retracted' ? k : e.kind; } return k; };
  const holds = (id) => {
    if (id === null) return true;
    if (memo.has(id)) return memo.get(id);
    let kind = inLoop.has(id) ? kindOf(id) : null;
    if (!kind) for (const e of edges.get(id) || []) if (holds(e.by)) { kind = kind === 'retracted' ? kind : e.kind; if (kind === 'retracted') break; }
    memo.set(id, !kind);
    if (kind) status.set(id, kind);
    return !kind;
  };
  for (const t of edges.keys()) holds(t);
  return { status, cycles: [...inLoop] };
}

/**
 * The attestations of `rec` that belong to the current state. `withdrawn` holds what the rest of the
 * document withdraws or replaces (a retraction may sit under another place, or come later in the
 * file); the record's own retractions are found here too, so a writer called on one record alone is
 * safe. Each attestation left out is reported, as 'retracted' or 'superseded'.
 */
export function currentAttestations(rec, withdrawn, loss) {
  const atts = list(rec.attestations);
  // `withdrawn` is the whole document's resolution (resolveWithdrawn().status); without it, this
  // record's own withdrawals are resolved here.
  const status = withdrawn || resolveWithdrawn(collectWithdrawn(atts)).status;
  if (!status.size) return atts;
  return atts.filter((a) => {
    const id = a && a['@id'];
    const kind = typeof id === 'string' && status.get(id);
    if (!kind) return true;
    loss({ kind, value: id });
    return false;
  });
}

const TRANSCRIPTION = ['transcriptionAccuracy', 'transcriptionCompleteness'];
/** Report what a facet's qualification holds beyond the keys the target format keeps. */
export function qualificationLosses(q, kept, loss) {
  if (!q || typeof q !== 'object') return;
  // computed is not a loss here: the writers leave a computed facet out whole (isComputedFacet).
  const rest = Object.keys(q).filter((k) => !kept.includes(k) && k !== 'computed' && q[k] !== undefined && q[k] !== null);
  if (rest.some((k) => TRANSCRIPTION.includes(k))) loss({ kind: 'transcription-judgement' });
  if (rest.some((k) => !TRANSCRIPTION.includes(k))) loss({ kind: 'qualification' });
}

// A gazetteer's version (PLATO e96d90d): dcat:version, plato:gazetteer_status, dcat:isVersionOf and
// dcat:previousVersion. LPF v1 defines no collection-level term for any of them (its context maps
// only title and license there), and the tables have no sheet for the gazetteer at all.
const VERSION_KEYS = ['version', 'status', 'isVersionOf', 'previousVersion'];
/** Report each version key of a gazetteer header that the target cannot hold. */
export function versionLosses(gazetteer, loss) {
  if (!gazetteer || typeof gazetteer !== 'object') return;
  for (const k of VERSION_KEYS) if (gazetteer[k] !== undefined && gazetteer[k] !== null) loss({ kind: 'gazetteer-version', value: k });
}

// ---- statistical figures (PLATO issue #14) ----------------------------------------------------------
/**
 * True when a property value is a figure from a statistical table, or carries what one does: a table
 * (dataSet), coordinates (dimensions), facts about the figure (attributes) or a denominator
 * (universe). LPF and the spreadsheet tables have no place for any of these, and written without
 * them the figure would be stated of the place as a whole: the county would "have" the number of its
 * male agricultural labourers as its persons. So these writers leave such a figure out, and report it.
 */
export const isFigure = (pv) => !!pv && typeof pv === 'object' && ['dataSet', 'dimensions', 'attributes', 'universe'].some((k) => pv[k] !== undefined && pv[k] !== null);
/** Report the header's statistical tables where the target has no place for them. */
/** Report the header's own relation types (PLATO 0.6.0) where the target cannot declare them. */
export function relationTypeLosses(head, loss) { if (head && Array.isArray(head.relationTypes) && head.relationTypes.length) loss({ kind: 'relation-types', value: head.relationTypes.length }); }
export function tableLosses(head, loss) { if (head && Array.isArray(head.dataSets) && head.dataSets.length) loss({ kind: 'statistical-tables', value: head.dataSets.length }); }

// ---- keys a writer has no place for ---------------------------------------------------------------
/**
 * Report each key of `obj` that the writer neither carries nor reports in words of its own, so that
 * nothing is dropped silently: not the keys known today, and not a key PLATO adds later, which
 * reaches here before any writer knows it. `where` names the kind of object ('name', 'source') and
 * `keeps` the keys the writer handles; each other key present is reported as `where.key`, which
 * src/engine/report.js turns into words (droppedText).
 */
export function dropKeys(obj, where, keeps, loss) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const k of Object.keys(obj)) if (!keeps.has(k) && obj[k] !== undefined && obj[k] !== null) loss({ kind: 'dropped', key: `${where}.${k}` });
}
/** Report one key as dropped, where the writer decides that case by case. */
export const dropKey = (where, key, loss) => loss({ kind: 'dropped', key: `${where}.${key}` });

// ---- identities an attestation bundles (plato:attests_identity, PLATO 238d15f) -------------------
/**
 * Report the identity relations attestation `a` bundles, which a format without attestations of
 * identity (LPF, the spreadsheet tables) cannot hold. They are never written as standalone identity
 * matches (LPF links, identities rows): those would lose the provenance the attestation gives them
 * together, and could no longer be withdrawn together. In a denial (plato:negated) they say that two
 * entities are NOT the same: written as a match, that would say the opposite, so the words say so.
 * Returns true when there were any.
 */
export function identityBundleLosses(a, where, loss) {
  if (!a || !Array.isArray(a.identities) || !a.identities.length) return false;
  loss({ kind: isDenial(a) ? 'identity-denied' : 'identity-bundle', value: a['@id'] || where });
  return true;
}

// ---- routes, itineraries and networks (PLATO 0.6.0) ----------------------------------------------
const plato = (iri) => (typeof iri === 'string' && iri.startsWith('plato:') ? PLATO + iri.slice(6) : iri);
/** True when a relation type is plato:MemberOf, written in full or with the context's prefix. */
export const isMemberOf = (rt) => plato(rt) === PLATO + 'MemberOf';
/** True when a relation type is plato:ContainedIn, written in full or with the context's prefix. */
export const isContainedIn = (rt) => plato(rt) === PLATO + 'ContainedIn';

/**
 * Add to `into` (member -> Set of wholes) each plato:MemberOf that `rec`'s attestations state: the
 * member is the attestation's subject (its `about`, or the record it is nested under), the whole is
 * the relation's target. Used to find a route that is, through its members, a member of itself.
 */
export function collectMembership(attestations, subject, into = new Map()) {
  for (const a of list(attestations)) {
    if (!a || typeof a !== 'object') continue;
    const member = typeof a.about === 'string' ? a.about : subject;
    for (const r of list(a.relations)) {
      if (!r || !isMemberOf(r.relationType) || typeof r.relatesTo !== 'string' || typeof member !== 'string') continue;
      (into.get(member) || into.set(member, new Set()).get(member)).add(r.relatesTo);
    }
  }
  return into;
}
/** The entities caught in a loop of memberships: a route that, followed up, contains itself. */
export function membershipCycles(edges) {
  const inLoop = new Set(), done = new Set(), onPath = [];
  const visit = (id) => {
    if (done.has(id)) return;
    const at = onPath.indexOf(id);
    if (at >= 0) { for (const x of onPath.slice(at)) inLoop.add(x); return; }
    onPath.push(id);
    for (const w of edges.get(id) || []) visit(w);
    onPath.pop(); done.add(id);
  };
  for (const id of edges.keys()) visit(id);
  return [...inLoop];
}

// ---- computed values (plato:computed, PLATO 0.6.0) -----------------------------------------------
/**
 * True when a value was worked out by software rather than taken from a source: an itinerary's
 * span from its stops. It is not evidence, so a writer whose format cannot mark it (LPF, the
 * spreadsheet tables) must leave it out and report it: written there, it would read as a source's
 * statement. As with a denial, anything but absent or false counts, so a malformed flag errs
 * towards leaving a value out.
 */
export const isComputed = (x) => !!x && typeof x === 'object' && x.computed !== undefined && x.computed !== null && x.computed !== false;
/** A facet is computed when its qualification says so. */
export const isComputedFacet = (f) => !!f && typeof f === 'object' && isComputed(f.qualification);

// ---- what an attestation's timespans date (plato:timespan_role, PLATO 7720890, #20) --------------
/**
 * True when an attestation's timespans date something other than what it records: the span of the
 * evidence (plato:EvidenceSpan, the earliest and latest documents that mention the place), not the
 * dates of the place. Only plato:WhenTrue, the default, dates the place; as with a denial, any other
 * value errs towards leaving the dates out.
 */
export const datesTheEvidence = (a) => {
  const r = a && a.timespanRole;
  if (r === undefined || r === null) return false;
  return !(r === PLATO + 'WhenTrue' || r === 'plato:WhenTrue');
};
/**
 * A writer whose dates are the place's dates (LPF's when, the tables' date columns) cannot carry an
 * evidence span: it takes `a` (a copy of the attestation) without its timespans, and reports the loss.
 * True when it did.
 */
export function evidenceSpanLosses(a, id, loss) {
  if (!datesTheEvidence(a)) return false;
  // A role with no timespans dates nothing, but is still not carried.
  if (!list(a.timespans).length) { dropKey('attestation', 'timespanRole', loss); return false; }
  loss({ kind: 'evidence-span', value: id });
  a.timespans = [];
  return true;
}
