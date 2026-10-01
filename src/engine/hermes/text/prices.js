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
 * US dollars per million tokens, input and output, by provider and model, as recorded on `checkedOn`
 * from `source`. A model the provider names with a date after it (claude-haiku-4-5-20251001) is
 * priced as the model without it.
 */
export const PRICES = Object.freeze({
  checkedOn: '2026-09-25',
  source: "Anthropic's table of current models and prices (platform.claude.com, as cached by Claude Code's API reference on 2026-09-25); to be checked against https://platform.claude.com/docs/en/about-claude/pricing",
  usdPerMillion: {
    anthropic: {
      'claude-fable-5-1': { input: 10, output: 50 },
      'claude-fable-5': { input: 10, output: 50 },
      'claude-opus-5-5': { input: 4, output: 20 },
      'claude-opus-5': { input: 5, output: 25 },
      'claude-opus-4-8': { input: 5, output: 25 },
      'claude-sonnet-5-5': { input: 2, output: 10 },
      'claude-sonnet-5': { input: 2, output: 10 },
      'claude-sonnet-4-6': { input: 3, output: 15 },
      'claude-haiku-4-5': { input: 1, output: 5 },
    },
  },
});

// What is sent with every chunk besides its text: the prompt and the schema.
const OVERHEAD_CHARS = PROMPT.length + JSON.stringify(OUTPUT_SCHEMA).length + 60;

/**
 * One chunk's tokens, estimated: { input, output: { low, high } }. Output is a range: a text dense with
 * names gives a long list, and a model that thinks before answering spends tokens doing so.
 */
export function estimateChunk(chunk) {
  const chars = typeof chunk === 'string' ? chunk.length : chunk.text.length;
  const text = Math.ceil(chars / CHARS_PER_TOKEN);
  return { input: Math.ceil((chars + OVERHEAD_CHARS) / CHARS_PER_TOKEN), output: { low: 20 + Math.ceil(text * 0.05), high: 200 + text } };
}

/** A whole run's estimate: { characters, chunks, input, output: { low, high } }. */
export function estimateRun(chunks) {
  const out = { characters: 0, chunks: chunks.length, input: 0, output: { low: 0, high: 0 } };
  for (const c of chunks) {
    const e = estimateChunk(c);
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
export const needsSecondConfirmation = (estimate, cost) => estimate.chunks > CONFIRM_CHUNKS || (cost?.usd ? cost.usd.high > CONFIRM_USD : false);
