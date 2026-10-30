// Hermes, place names in a text: the user's agreement to a run, and a ceiling on what it may cost. Pure:
// no page, no network, no storage, and not the permissions module (a permission says a SITE may be asked;
// this is the agreement to ONE RUN, with the text, the service, the estimate and the ceiling named).
//
// - A ceiling, $2 unless the user changes it (parseCeiling), is HARD in two places. Before anything is
//   sent, assessRun compares the run's worst case (the high end of the estimate, prices.js) with it, and
//   a run that could pass it is blocked, with words, until the ceiling is raised or less is sent. While
//   the run goes, limitProvider adds up what the provider reports was spent and sends no part whose
//   worst case would take the total over it: an estimate is a guess, the ceiling is not.
// - A ceiling is a promise about money, so it needs a price. For a service elsewhere with no price in the
//   table (a model it does not have, a table more than PRICE_STALE_DAYS old, any OpenAI-compatible
//   server) the run is blocked: "the ceiling cannot be kept". A server on this computer is not charged,
//   so it is not held to one.
// - A consent (giveConsent) is a frozen record of what was agreed to; limitProvider sends nothing
//   without one for this provider, this site and this model, nor once it is withdrawn, nor while
//   `permitted()` (the page's: the permission still allowed, the key still held) says no.
// - The words (consentWords) name the service, show the estimate, the ceiling, and that the provider's
//   terms apply to the text. They never say what the provider does with it: that is not known here.
import { estimateWords, costOf, priceOf, needsSecondConfirmation } from './prices.js';

export const DEFAULT_CEILING_USD = 2;
/** A ceiling above this is taken for a typing slip. */
export const MAX_CEILING_USD = 1000;

/** Why an agreement was not given or no longer holds. `kind`: no-consent | withdrawn | mismatch | over-ceiling | no-price | second-confirmation | ceiling. */
export class ConsentError extends Error {
  constructor(message, { kind } = {}) { super(message); this.name = 'ConsentError'; this.kind = kind; }
}
/** A part that could take the run over its ceiling was not sent. Everything finished before it is kept. */
export class CeilingError extends ConsentError {
  constructor(message) { super(message, { kind: 'ceiling' }); this.name = 'CeilingError'; }
}

const money = (n) => '$' + n.toFixed(2);
const count = (n) => n.toLocaleString('en-GB');
/** Whether an origin is this computer's own (the only plain-http site a permission allows). */
export const isThisComputer = (origin) => /^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]+)?$/.test(String(origin));

/**
 * A ceiling as the user typed it (a number, or text such as "3.50" or "$3.50"): { ok: true, usd } to the
 * cent, or { ok: false, why }.
 */
export function parseCeiling(v) {
  const no = { ok: false, why: `The ceiling must be a sum of money in dollars, more than nothing and at most ${money(MAX_CEILING_USD)}, such as 2 or 3.50.` };
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\s*\$?\s*\d+(\.\d+)?\s*$/.test(v)) n = Number(v.replace(/[$\s]/g, ''));
  else return no;
  if (!Number.isFinite(n)) return no;
  const usd = Math.round((n + Number.EPSILON) * 100) / 100;
  return usd >= 0.01 && usd <= MAX_CEILING_USD ? { ok: true, usd } : no;
}

/**
 * A run assessed before anything is sent: { provider, model, origin, local, cost, ceilingUsd, second,
 * blocked: null | 'over-ceiling' | 'no-price', words: [why, when blocked] }. `estimate` is estimateRun's;
 * `provider` is the price table's name for the service (anthropic). Throws a TypeError for a ceiling that
 * is not a sum of money.
 */
export function assessRun({ provider, model, origin, estimate, ceilingUsd = DEFAULT_CEILING_USD, now = new Date(), table }) {
  const c = parseCeiling(ceilingUsd);
  if (!c.ok) throw new TypeError(c.why);
  const local = isThisComputer(origin);
  const cost = local ? null : costOf(estimate, provider, model, { now, table });
  const out = { provider, model, origin, local, cost, ceilingUsd: c.usd, second: needsSecondConfirmation(estimate, cost), blocked: null, words: [] };
  if (local) return out;
  if (!cost.usd) {
    out.blocked = 'no-price';
    out.words = [estimateWords(estimate, cost), 'The ceiling cannot be kept without a price, so nothing is sent to a service that may charge for it.'];
  } else if (cost.usd.high > c.usd) {
    out.blocked = 'over-ceiling';
    out.words = [`This run could cost up to ${money(cost.usd.high)}, over the ceiling of ${money(c.usd)}: raise the ceiling, or send less of the text.`];
  }
  return out;
}

/**
 * What the page asks before sending, as lines: the question naming the service and the amount of text,
 * the estimate, the ceiling, and whose terms apply. A blocked run says why instead of the ceiling and terms.
 */
export function consentWords({ name, origin, estimate, assessment }) {
  const host = String(origin).replace(/^https?:\/\//, '');
  const head = `Send this text (${count(estimate.characters)} characters, ${count(estimate.chunks)} ${estimate.chunks === 1 ? 'part' : 'parts'}) to ${name} (${host})?`;
  if (assessment.local) {
    const t = `About ${count(estimate.input)} tokens in and ${count(estimate.output.low)} to ${count(estimate.output.high)} out, for ${count(estimate.chunks)} ${estimate.chunks === 1 ? 'part' : 'parts'} of the text.`;
    return [head, t, 'The server is on this computer: the text does not leave it, and nothing is charged.'];
  }
  if (assessment.blocked) return [head, estimateWords(estimate, assessment.cost), ...assessment.words.filter((w) => w !== estimateWords(estimate, assessment.cost))];
  return [
    head,
    estimateWords(estimate, assessment.cost),
    `The most this run may cost is ${money(assessment.ceilingUsd)}: no part is sent that could take it over.`,
    `${name}’s terms apply to the text you send it. What it does with the text, keeping it or learning from it, is something these tools do not know.`,
  ];
}

/**
 * The record of what the user agreed to: { provider, model, origin, parts, characters, ceilingUsd, at },
 * frozen. Only for a run that is not blocked, assessed for this very service and model; one that needs a
 * second confirmation (200 parts, or more than $5 at worst) also needs `confirmedAgain`.
 */
export function giveConsent({ provider, model, origin, estimate, assessment, confirmedAgain = false, now = () => new Date().toISOString() }) {
  if (!assessment || assessment.provider !== provider || assessment.model !== model || assessment.origin !== origin) throw new ConsentError('That agreement was assessed for another service or model.', { kind: 'mismatch' });
  if (assessment.blocked) throw new ConsentError(assessment.blocked === 'over-ceiling' ? 'The run could cost more than the ceiling.' : 'The ceiling cannot be kept without a price.', { kind: assessment.blocked });
  if (assessment.second && !confirmedAgain) throw new ConsentError('A run this large must be confirmed a second time.', { kind: 'second-confirmation' });
  return Object.freeze({ provider, model, origin, parts: estimate.chunks, characters: estimate.characters, ceilingUsd: assessment.ceilingUsd, at: now() });
}

/** What a reply cost, from the tokens the provider says it used; 0 where there is no price (a server on this computer). */
const spentOn = (usage, provider, model, table) => {
  const p = priceOf(provider, model, table);
  return p ? ((usage?.input || 0) * p.input + (usage?.output || 0) * p.output) / 1e6 : 0;
};

/**
 * A provider (an adapter) that sends only what the user agreed to: the same adapter to the engine
 * (id, name, origins, listModels, estimate, effort, thinking), whose extract() first checks the
 * agreement and the ceiling, and then adds what was spent. `permitted()`, if given, is asked before every
 * part: false means the permission was withdrawn or the key forgotten, and nothing more is sent.
 * Also: `spent()`, `ceilingUsd`, `withdraw()`.
 */
export function limitProvider(provider, consent, { now = new Date(), permitted, table } = {}) {
  if (!consent) throw new ConsentError('Nothing is sent to a language-model service until the user has agreed to this run.', { kind: 'no-consent' });
  let spent = 0, withdrawn = false;
  const local = isThisComputer(consent.origin);
  const refuse = (message, kind) => { throw new ConsentError(message, { kind }); };
  return {
    ...provider,
    ceilingUsd: consent.ceilingUsd,
    spent: () => spent,
    withdraw() { withdrawn = true; },
    async extract(chunk, opts = {}) {
      if (withdrawn || (permitted && !permitted())) refuse('The agreement to send the text was withdrawn, or the permission or the key is no longer held, so nothing more was sent.', 'withdrawn');
      if (provider.id !== consent.provider || provider.origins?.[0] !== consent.origin || opts.model !== consent.model) refuse('The agreement was made for another service or model, so nothing was sent.', 'mismatch');
      if (!local) {
        const worst = costOf(provider.estimate(chunk), consent.provider, consent.model, { now, table });
        if (!worst.usd) refuse('There is no price for this model, so the ceiling cannot be kept, and nothing more was sent.', 'no-price');
        if (spent + worst.usd.high > consent.ceilingUsd) throw new CeilingError(`The next part could take the run over its ceiling of ${money(consent.ceilingUsd)} (${money(spent)} spent so far), so it was not sent. What was found before is kept; raise the ceiling to go on.`);
      }
      const r = await provider.extract(chunk, opts);
      if (!local) spent += spentOn(r.usage, consent.provider, consent.model, table);
      return r;
    },
  };
}
