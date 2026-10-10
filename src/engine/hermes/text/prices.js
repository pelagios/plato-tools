// Hermes, place names in a text: what a run may cost, estimated before anything is sent.
//
// Tokens are estimated from characters (one token for about 3.5), never counted by a provider's own
// token-counting endpoint, which would mean sending the text. Tokens are always shown. Money is shown
// only as "about", with the date the prices were recorded, and only for a model in the table below,
// and not at all once the table is more than PRICE_STALE_DAYS old: prices change, and a stale figure
// is worse than none (the maintainer's decision, 2026-10-01).
//
// This is a table of PRICES, not of models: no model is offered or chosen from it. The models a user
// may choose from are the ones the provider lists for their key (each adapter's listModels).
import { PROMPT, OUTPUT_SCHEMA } from './prompt.js';

export const CHARS_PER_TOKEN = 3.5;
export const PRICE_STALE_DAYS = 90;
/** Over either, the user is asked a second time before a run starts. */
export const CONFIRM_CHUNKS = 200;
export const CONFIRM_USD = 5;

/**
 * US dollars per million tokens, input and output, by provider and model, as read on `checkedOn` from
 * `source` (the provider's own pricing page; base rates, no batch, cache or regional pricing). A model
 * the provider names with a date after it (claude-haiku-4-5-20251001) is priced as the model without
 * it. `verified` is { source, on }: the page read and the day it was read, or null for a table not
 * read from the live page; a table counts as verified only when `on` is `checkedOn`.
 */
export const PRICES = Object.freeze({
  checkedOn: '2026-10-10',
  // Where and when each price was read, so that "verified" can be checked. Claude Haiku 5.5's row, as
  // the page gives it: "Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | ... |
  // $0.50 / MTok" and "Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | ... |
  // $2.50 / MTok"; the claude-api reference (cached 2026-10-06) agrees.
  verified: Object.freeze({ source: 'https://platform.claude.com/docs/en/about-claude/pricing', on: '2026-10-10' }),
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  usdPerMillion: {
    anthropic: {
      'claude-fable-5-1': { input: 10, output: 50 },
      'claude-fable-5': { input: 10, output: 50 },
      'claude-opus-5-5': { input: 4, output: 20 },
      'claude-opus-5': { input: 5, output: 25 },
      'claude-opus-4-8': { input: 5, output: 25 },
      'claude-opus-4-7': { input: 5, output: 25 },
      'claude-opus-4-6': { input: 5, output: 25 },
      'claude-opus-4-5': { input: 5, output: 25 },
      'claude-sonnet-5-5': { input: 2, output: 10 },
      'claude-sonnet-5': { input: 2, output: 10 },
      'claude-sonnet-4-6': { input: 3, output: 15 },
      'claude-sonnet-4-5': { input: 3, output: 15 },
      // Claude Haiku 5.5's prices for a prompt up to 100,000 tokens; one over pays $0.50 and $2.50. A chunk
      // (about 8,000 characters, with the prompt) is far below that, so the lower prices are the ones paid.
      'claude-haiku-5-5': { input: 0.1, output: 0.5 },
      'claude-haiku-4-5': { input: 1, output: 5 },
    },
  },
});

/**
 * How much a model's thinking may add to its output, as a share of the chunk's own tokens, by the
 * effort asked for (null: the model's own default, taken as high). A guess, for the top of the range:
 * thinking is billed as output, and lower effort means less of it.
 */
export const THINKING_ALLOWANCE = Object.freeze({ low: 0.25, medium: 0.6, high: 1.0, xhigh: 2.0, max: 3.0, default: 1.0 });

// What is sent with every chunk besides its text: the prompt and the schema.
const OVERHEAD_CHARS = PROMPT.length + JSON.stringify(OUTPUT_SCHEMA).length + 60;

/**
 * One chunk's tokens, estimated: { input, output: { low, high } }. Output is a range: a text dense with
 * names gives a long list, and a model that thinks before answering spends tokens doing so, more at
 * higher `effort` (THINKING_ALLOWANCE).
 */
export function estimateChunk(chunk, { effort = null } = {}) {
  const chars = typeof chunk === 'string' ? chunk.length : chunk.text.length;
  const text = Math.ceil(chars / CHARS_PER_TOKEN);
  const thinking = THINKING_ALLOWANCE[effort ?? 'default'] ?? THINKING_ALLOWANCE.default;
  return { input: Math.ceil((chars + OVERHEAD_CHARS) / CHARS_PER_TOKEN), output: { low: 20 + Math.ceil(text * 0.05), high: 200 + Math.ceil(text * (0.6 + thinking)) } };
}

/** A whole run's estimate: { characters, chunks, input, output: { low, high }, effort }. */
export function estimateRun(chunks, { effort = null } = {}) {
  const out = { characters: 0, chunks: chunks.length, input: 0, output: { low: 0, high: 0 }, effort };
  for (const c of chunks) {
    const e = estimateChunk(c, { effort });
    out.characters += c.text.length; out.input += e.input; out.output.low += e.output.low; out.output.high += e.output.high;
  }
  return out;
}

const DAY = 86_400_000;
/** The prices of a model, or null when the table has none for it. */
export function priceOf(provider, model, table = PRICES) {
  const p = table.usdPerMillion?.[provider];
  if (!p || typeof model !== 'string') return null;
  return Object.hasOwn(p, model) ? p[model] : Object.hasOwn(p, model.replace(/-\d{8}$/, '')) ? p[model.replace(/-\d{8}$/, '')] : null;
}

/**
 * The cost of an estimate, or why there is none: { usd: { low, high }, pricesOf } or
 * { usd: null, why: 'unknown-model' | 'stale', pricesOf }. `now` is a Date (for tests).
 */
export function costOf(estimate, provider, model, { now = new Date(), table = PRICES } = {}) {
  const pricesOf = table.checkedOn;
  if ((now.getTime() - Date.parse(pricesOf + 'T00:00:00Z')) / DAY > PRICE_STALE_DAYS) return { usd: null, why: 'stale', pricesOf };
  const p = priceOf(provider, model, table);
  if (!p) return { usd: null, why: 'unknown-model', pricesOf };
  const usd = (inp, outp) => (inp * p.input + outp * p.output) / 1e6;
  return { usd: { low: usd(estimate.input, estimate.output.low), high: usd(estimate.input, estimate.output.high) }, pricesOf };
}

/** Whether a run is large enough that the user must confirm it a second time. */
const usd = (n) => (n < 0.01 ? 'under $0.01' : '$' + (n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString('en-GB')));
const tokens = (n) => n.toLocaleString('en-GB');
/**
 * The estimate in words, as the page and the command line show it. It always names the date of the
 * prices, whether or not money is shown.
 */
export function estimateWords(estimate, cost) {
  const t = `About ${tokens(estimate.input)} tokens in and ${tokens(estimate.output.low)} to ${tokens(estimate.output.high)} out, for ${tokens(estimate.chunks)} ${estimate.chunks === 1 ? 'part' : 'parts'} of the text`;
  const asOf = `prices as of ${cost.pricesOf}${PRICES.verified?.on === PRICES.checkedOn ? '' : ', not checked against the provider\'s page'}`;
  if (cost.usd) return `${t}: about ${usd(cost.usd.low)} to ${usd(cost.usd.high)}, at ${asOf}.`;
  if (cost.why === 'stale') return `${t}. No cost is shown: the ${asOf} are more than ${PRICE_STALE_DAYS} days old.`;
  return `${t}. No cost is shown: there is no price recorded for this model (${asOf}).`;
}

export const needsSecondConfirmation = (estimate, cost) => estimate.chunks > CONFIRM_CHUNKS || (cost?.usd ? cost.usd.high > CONFIRM_USD : false);
