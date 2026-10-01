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
// - No model is chosen here: listModels() asks the provider which there are, and the user chooses one.
import { send, LlmError } from './request.js';
import { systemPrompt, OUTPUT_SCHEMA } from '../prompt.js';
import { estimateChunk } from '../prices.js';

export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
const VERSION = '2023-06-01';
/** Room for the reply, and for the thinking the current models do before it. */
export const ANTHROPIC_MAX_TOKENS = 16000;

/**
 * An adapter: { id, origins, listModels({ signal }), estimate(chunk), extract(chunk, { model, signal, language }) }.
 * `fetch` is required (the permissions module's in the page); `key` is the user's key.
 */
export function anthropic({ key, fetch, route = { cat: 'llm', subj: 'anthropic' }, maxTokens = ANTHROPIC_MAX_TOKENS, timeoutMs, maxTries, sleep } = {}) {
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

    estimate: (chunk) => estimateChunk(chunk),

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
        output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      };
      const j = await send({ ...common, url: `${ANTHROPIC_ORIGIN}/v1/messages`, init: { method: 'POST', headers: headers(true), body: JSON.stringify(body) }, signal });
      if (j?.stop_reason === 'refusal') throw new LlmError(`Anthropic's model declined to answer${j?.stop_details?.category ? ` (${String(j.stop_details.category).slice(0, 40)})` : ''}.`, { kind: 'refused' });
      const reply = (Array.isArray(j?.content) ? j.content : []).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
      return {
        reply,
        truncated: j?.stop_reason === 'max_tokens',
        usage: { input: Number(j?.usage?.input_tokens) || 0, output: Number(j?.usage?.output_tokens) || 0 },
        model: typeof j?.model === 'string' ? j.model : model,
        settings: { max_tokens: maxTokens, sampling: 'provider defaults (none sent)' },
      };
    },
  };
}
