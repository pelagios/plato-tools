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
  for (const a of attestations || []) {
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
  const atts = rec.attestations || [];
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
  const rest = Object.keys(q).filter((k) => !kept.includes(k) && q[k] !== undefined && q[k] !== null);
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

// ---- statistical figures (PLATO draft, issue #14) ---------------------------------------------------
/**
 * True when a property value is a figure from a statistical table, or carries what one does: a table
 * (dataSet), coordinates (dimensions), facts about the figure (attributes) or a denominator
 * (universe). LPF and the spreadsheet tables have no place for any of these, and written without
 * them the figure would be stated of the place as a whole: the county would "have" the number of its
 * male agricultural labourers as its persons. So these writers leave such a figure out, and report it.
 */
export const isFigure = (pv) => !!pv && typeof pv === 'object' && ['dataSet', 'dimensions', 'attributes', 'universe'].some((k) => pv[k] !== undefined && pv[k] !== null);
/** Report the header's statistical tables where the target has no place for them. */
export function tableLosses(head, loss) { if (head && Array.isArray(head.dataSets) && head.dataSets.length) loss({ kind: 'statistical-tables', value: head.dataSets.length }); }
