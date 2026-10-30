// Hermes, place names in a text: what a run may cost, estimated before anything is sent.
//
// Tokens are estimated from characters, never counted by a provider's own token-counting endpoint,
// which would mean sending the text. The ratio depends on the script (SCRIPT_RATIOS): one token for
// about 3.5 characters of Latin, but nearer one for each character of polytonic Greek or Chinese
// (Stephen's decision of 30 October 2026, Q8 A). Every ratio is an ESTIMATE, rounded towards too many
// tokens, and the real count the provider gives for the first part of a run replaces them for the rest
// (calibrate). Tokens are always shown. Money is shown
// only as "about", with the date the prices were recorded, and only for a model in the table below,
// and not at all once the table is more than PRICE_STALE_DAYS old: prices change, and a stale figure
// is worse than none (the maintainer's decision, 2026-10-01).
//
// This is a table of PRICES, not of models: no model is offered or chosen from it. The models a user
// may choose from are the ones the provider lists for their key (each adapter's listModels).
import { PROMPT, OUTPUT_SCHEMA } from './prompt.js';

export const CHARS_PER_TOKEN = 3.5;
/**
 * Characters (code points) to a token, by script. NOT MEASURED: each is a guess that errs towards
 * too many tokens, and is labelled so. The Latin ratio is the one used before there were others; the
 * rest are for the scripts a text of places is likely to be in, and "other" for any other letters.
 * The ratios belong to a tokenizer, and tokenizers change between model generations: the first part's
 * real count corrects them (calibrate).
 */
export const SCRIPT_RATIOS = Object.freeze({
  latin: Object.freeze({ charsPerToken: CHARS_PER_TOKEN, estimate: true }),
  greek: Object.freeze({ charsPerToken: 1.5, estimate: true }),
  'polytonic-greek': Object.freeze({ charsPerToken: 1, estimate: true }),
  cyrillic: Object.freeze({ charsPerToken: 2, estimate: true }),
  arabic: Object.freeze({ charsPerToken: 2, estimate: true }),
  cjk: Object.freeze({ charsPerToken: 1, estimate: true }),
  other: Object.freeze({ charsPerToken: 1.5, estimate: true }),
});
/** How each script is named in the words of an estimate. */
const SCRIPT_NAMES = { greek: 'Greek', 'polytonic-greek': 'polytonic Greek', cyrillic: 'Cyrillic', arabic: 'Arabic', cjk: 'Chinese, Japanese or Korean', other: 'other scripts' };

// A letter's script; anything else (a digit, a space, punctuation, a mark) goes with the letters around it.
const LETTER_SCRIPTS = [
  ['greek', /\p{Script=Greek}/u], ['cyrillic', /\p{Script=Cyrillic}/u], ['arabic', /\p{Script=Arabic}/u],
  ['cjk', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u], ['latin', /\p{Script=Latin}/u],
];
const LETTER = /\p{L}/u;
// What makes Greek polytonic: the Greek Extended block (U+1F00 to U+1FFF), and the marks that only polytonic
// Greek uses (psili U+0313, dasia U+0314, perispomeni U+0342, ypogegrammeni U+0345), which a decomposed
// text has apart from its letters.
const isPolytonic = (ch) => { const c = ch.codePointAt(0); return (c >= 0x1f00 && c <= 0x1fff) || c === 0x313 || c === 0x314 || c === 0x342 || c === 0x345; };

/**
 * The tokens a text is estimated to take, counted run by run in each script: { tokens, scripts },
 * `scripts` the code points counted in each (a run of Greek is polytonic if any of it is). Not
 * rounded. A mixed text (Latin with a Greek quotation) is counted by what each part is.
 */
export function tokensOf(text) {
  const scripts = {};
  let run = 'latin', runCount = 0, polytonic = false;
  const flush = () => {
    if (!runCount) return;
    const name = run === 'greek' && polytonic ? 'polytonic-greek' : run;
    scripts[name] = (scripts[name] || 0) + runCount;
    runCount = 0; polytonic = false;
  };
  for (const ch of text) {
    if (LETTER.test(ch)) {
      const script = (LETTER_SCRIPTS.find(([, re]) => re.test(ch)) || ['other'])[0];
      if (script !== run) { flush(); run = script; }
    }
    runCount++;
    if (run === 'greek' && isPolytonic(ch)) polytonic = true;
  }
  flush();
  let tokens = 0;
  for (const [name, n] of Object.entries(scripts)) tokens += n / SCRIPT_RATIOS[name].charsPerToken;
  return { tokens, scripts };
}
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
 * One chunk's tokens, estimated: { input, output: { low, high }, scripts }, `scripts` the code points
 * counted in each script (SCRIPT_RATIOS). Output is a range: a text dense with names gives a long
 * list, and a model that thinks before answering spends tokens doing so, more at higher `effort`
 * (THINKING_ALLOWANCE).
 */
export function estimateChunk(chunk, { effort = null } = {}) {
  const { tokens, scripts } = tokensOf(typeof chunk === 'string' ? chunk : chunk.text);
  const text = Math.ceil(tokens);
  const thinking = THINKING_ALLOWANCE[effort ?? 'default'] ?? THINKING_ALLOWANCE.default;
  return { input: Math.ceil(tokens + OVERHEAD_CHARS / CHARS_PER_TOKEN), output: { low: 20 + Math.ceil(text * 0.05), high: 200 + Math.ceil(text * (0.6 + thinking)) }, scripts };
}

/** A whole run's estimate: { characters, chunks, input, output: { low, high }, effort, scripts }. */
export function estimateRun(chunks, { effort = null } = {}) {
  const out = { characters: 0, chunks: chunks.length, input: 0, output: { low: 0, high: 0 }, effort, scripts: {} };
  for (const c of chunks) {
    const e = estimateChunk(c, { effort });
    out.characters += c.text.length; out.input += e.input; out.output.low += e.output.low; out.output.high += e.output.high;
    for (const [k, n] of Object.entries(e.scripts)) out.scripts[k] = (out.scripts[k] || 0) + n;
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
  // Scripts other than Latin are counted at estimated ratios, and it says so: the first part's real count replaces them.
  const others = Object.keys(estimate.scripts || {}).filter((k) => k !== 'latin');
  const note = others.length ? ` Counted at estimated ratios for ${others.map((k) => SCRIPT_NAMES[k]).join(', ')} text, not measured; the real count of the first part replaces them once it is sent.` : '';
  if (cost.usd) return `${t}: about ${usd(cost.usd.low)} to ${usd(cost.usd.high)}, at ${asOf}.${note}`;
  if (cost.why === 'stale') return `${t}. No cost is shown: the ${asOf} are more than ${PRICE_STALE_DAYS} days old.${note}`;
  return `${t}. No cost is shown: there is no price recorded for this model (${asOf}).${note}`;
}

export const needsSecondConfirmation = (estimate, cost) => estimate.chunks > CONFIRM_CHUNKS || (cost?.usd ? cost.usd.high > CONFIRM_USD : false);

/**
 * The estimate for a whole run, corrected by the real count the provider gave for its first part:
 * `first` is { chunk, usage: { input, output } } for the part sent, `chunks` all the parts. The ratios
 * are scaled so that the first part's estimate is what it took (`scale`, from the input tokens only:
 * the output is the model's own); a provider that gave no count leaves the estimate as it was
 * (`source: 'estimate'`). Returns { scale, source: 'first-part' | 'estimate', estimate, cost, ask }:
 * `ask` is true when the corrected run crosses the second confirmation (over CONFIRM_CHUNKS parts or
 * CONFIRM_USD) where the first estimate did not, so that the user is asked again before the next part
 * is sent; a run already confirmed a second time is not asked a third. `before` is { estimate, cost }
 * as first shown. Nothing is sent to count tokens.
 */
export function calibrate(chunks, first, { effort = null, provider, model, now = new Date(), table = PRICES, before } = {}) {
  const guess = estimateChunk(first.chunk, { effort }).input;
  const used = first.usage?.input;
  const known = Number.isFinite(used) && used > 0 && guess > 0;
  const scale = known ? used / guess : 1;
  const raw = estimateRun(chunks, { effort });
  const estimate = known ? { ...raw, input: Math.ceil(raw.input * scale), output: { low: Math.ceil(raw.output.low * scale), high: Math.ceil(raw.output.high * scale) } } : raw;
  const cost = costOf(estimate, provider, model, { now, table });
  const crossedBefore = before ? needsSecondConfirmation(before.estimate, before.cost) : false;
  return { scale, source: known ? 'first-part' : 'estimate', estimate, cost, ask: !crossedBefore && needsSecondConfirmation(estimate, cost) };
}
