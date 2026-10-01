// Hermes, place names in a text: Anthropic's Messages API, called from the browser (or Node) with the
// user's own key. Plain requests, not Anthropic's SDK: every request must go through the fetch the
// page is given (the permissions module's), which the SDK would not use.
//
// - The key goes in the x-api-key header, and nowhere else.
// - `anthropic-dangerous-direct-browser-access: true` is what lets a page call the API: without it the
//   preflight is refused (checked 2026-10-01). It is sent from Node too, where it changes nothing.
// - The reply's shape is set by `output_config.format` (a JSON schema; `output_format` is deprecated).
// - No sampling settings (temperature, top_p, top_k): the current models refuse any but their own
//   defaults with a 400 (Claude Sonnet 5.5 a non-default value; Opus 5.5, Opus 5 and others any at
//   all), so none is ever sent, and the work file records that none was.
// - Effort (`output_config.effort`) is LOW by default for extraction: it is the documented control of
//   how many tokens a model spends, thinking (billed as output) included, and at low a model "skips
//   thinking on most simple requests" (https://platform.claude.com/docs/en/build-with-claude/effort,
//   and .../prompt-engineering/prompting-claude-sonnet-5-5#calibrate-effort, read 2026-10-01).
//   Finding names written in a text needs little working out. `effort: null` sends none, for the
//   model's own default (Claude Haiku 4.5 takes no effort at all, and refuses one with a 400).
//   `thinking: 'between_tools'` turns up-front thinking off altogether: Claude Sonnet 5.5 only, at
//   high effort or below; sent only when asked for, since no model list is kept here to know which
//   model takes it. What was sent is recorded with each result. At low effort with structured output
//   a model may now and then think until max_tokens (the Sonnet 5.5 guide says so): such a reply is
//   cut off, never read, and its chunk is halved and sent again (run.js).
// - No model is chosen here: listModels() asks the provider which there are, and the user chooses one.
import { send, LlmError } from './request.js';
import { systemPrompt, OUTPUT_SCHEMA } from '../prompt.js';
import { estimateChunk } from '../prices.js';

export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
const VERSION = '2023-06-01';
/** Room for the reply, and for the thinking the current models do before it. */
export const ANTHROPIC_MAX_TOKENS = 16000;
/** The effort levels the API takes (output_config.effort), and the one extraction uses unless told otherwise. */
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const DEFAULT_EFFORT = 'low';

/**
 * An adapter: { id, origins, listModels({ signal }), estimate(chunk), extract(chunk, { model, signal, language }) }.
 * `fetch` is required (the permissions module's in the page); `key` is the user's key.
 */
export function anthropic({ key, fetch, route = { cat: 'llm', subj: 'anthropic' }, maxTokens = ANTHROPIC_MAX_TOKENS, effort = DEFAULT_EFFORT, thinking = null, timeoutMs, maxTries, sleep } = {}) {
  if (effort !== null && !EFFORTS.includes(effort)) throw new TypeError(`anthropic: effort is one of ${EFFORTS.join(', ')}, or null for the model's own default.`);
  if (thinking !== null && thinking !== 'between_tools') throw new TypeError("anthropic: thinking is null (the model's own) or 'between_tools' (up-front thinking off; Claude Sonnet 5.5 only).");
  if (thinking === 'between_tools' && (effort === null || !['low', 'medium', 'high'].includes(effort))) throw new TypeError("anthropic: 'between_tools' is taken only at low, medium or high effort.");
  if (typeof fetch !== 'function') throw new TypeError('anthropic: give the fetch to use (in the page, the permissions module\'s).');
  if (typeof key !== 'string' || !key.trim()) throw new TypeError('anthropic: give the key.');
  const k = key.trim();
  const headers = (post) => ({
    'x-api-key': k,
    'anthropic-version': VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
    ...(post ? { 'content-type': 'application/json' } : {}),
  });
  const common = { fetch, route, timeoutMs, maxTries, sleep, keys: [k], who: 'Anthropic' };

  return {
    id: 'anthropic',
    name: 'Anthropic',
    origins: [ANTHROPIC_ORIGIN],

    /** The models the key may use, as Anthropic lists them: [{ id, name, created }], newest first as given. */
    async listModels({ signal } = {}) {
      const out = [];
      let after = null;
      for (let page = 0; page < 20; page++) {
        const q = new URLSearchParams({ limit: '100', ...(after ? { after_id: after } : {}) });
        const j = await send({ ...common, url: `${ANTHROPIC_ORIGIN}/v1/models?${q}`, init: { method: 'GET', headers: headers(false) }, signal });
        for (const m of Array.isArray(j?.data) ? j.data : []) if (m && typeof m.id === 'string') out.push({ id: m.id, name: typeof m.display_name === 'string' ? m.display_name : m.id, created: typeof m.created_at === 'string' ? m.created_at : null });
        if (!j?.has_more || typeof j.last_id !== 'string') break;
        after = j.last_id;
      }
      return out;
    },

    /** The effort and thinking this adapter sends, for the estimate and the record. */
    effort, thinking,
    estimate: (chunk) => estimateChunk(chunk, { effort }),

    /**
     * One chunk's reply: { reply (the model's text), truncated, usage: { input, output }, model (as the
     * provider names it), settings (what was sent besides the text) }. Throws LlmError.
     */
    async extract(chunk, { model, signal, language } = {}) {
      if (typeof model !== 'string' || !model) throw new TypeError('anthropic: choose a model; there is no default.');
      const body = {
        model,
        max_tokens: maxTokens,
        system: systemPrompt({ language }),
        messages: [{ role: 'user', content: chunk.text }],
        output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA }, ...(effort ? { effort } : {}) },
        ...(thinking ? { thinking: { type: thinking } } : {}),
      };
      const j = await send({ ...common, url: `${ANTHROPIC_ORIGIN}/v1/messages`, init: { method: 'POST', headers: headers(true), body: JSON.stringify(body) }, signal });
      if (j?.stop_reason === 'refusal') throw new LlmError(`Anthropic's model declined to answer${j?.stop_details?.category ? ` (${String(j.stop_details.category).slice(0, 40)})` : ''}.`, { kind: 'refused' });
      const reply = (Array.isArray(j?.content) ? j.content : []).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
      return {
        reply,
        truncated: j?.stop_reason === 'max_tokens',
        usage: { input: Number(j?.usage?.input_tokens) || 0, output: Number(j?.usage?.output_tokens) || 0 },
        model: typeof j?.model === 'string' ? j.model : model,
        settings: { max_tokens: maxTokens, effort: effort ?? "the model's default", thinking: thinking ?? "the model's default", sampling: 'provider defaults (none sent)' },
      };
    },
  };
}
