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

/** True when a meta-attestation marks alternative readings of one piece of evidence (plato:AlternativeTo). */
export const isAlternative = (meta) => [].concat(meta || []).some((m) => m && m.metaType === PLATO + 'AlternativeTo');

const TRANSCRIPTION = ['transcriptionAccuracy', 'transcriptionCompleteness'];
/** Report what a facet's qualification holds beyond the keys the target format keeps. */
export function qualificationLosses(q, kept, loss) {
  if (!q || typeof q !== 'object') return;
  const rest = Object.keys(q).filter((k) => !kept.includes(k) && q[k] !== undefined && q[k] !== null);
  if (rest.some((k) => TRANSCRIPTION.includes(k))) loss({ kind: 'transcription-judgement' });
  if (rest.some((k) => !TRANSCRIPTION.includes(k))) loss({ kind: 'qualification' });
}
