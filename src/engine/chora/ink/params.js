// The tracing's defaults and its error in words: what the page and the worker both need, and nothing heavy.
import { EPSILON } from './simplify.js';

export const DEFAULTS = {
  area: { tolerance: 12, bridge: 0, dropSmallHoles: true, detail: EPSILON },
  line: { colour: false, tolerance: 12, band: [0.5, 2], jumps: true, detail: EPSILON, seedRadius: 6 },
};

/** Why nothing could be proposed, in words (the page shows the message). `kind` says what, for the page. */
export class InkError extends Error {
  constructor(message, kind) { super(message); this.name = 'InkError'; this.kind = kind; }
}
