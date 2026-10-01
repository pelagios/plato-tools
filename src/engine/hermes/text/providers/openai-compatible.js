// Hermes, place names in a text: any service that speaks OpenAI's Chat Completions API, at an
// address the user gives: Ollama on this computer (http://localhost:11434), or another such server.
// (OpenAI itself is to have an adapter of its own for its Responses API, in phase 2.)
//
// - The key, where the service needs one, goes in the Authorization header, and nowhere else.
// - The reply's shape is set by `response_format` (json_schema, strict), which Ollama follows; a
//   server that does not still has its reply checked by the same code as any other.
// - `temperature` 0 and, if given, a `seed`, for results as repeatable as the server makes them; both
//   are recorded with each result. A server that refuses either can be given `temperature: null`.
// - No model is chosen here: listModels() asks the server which it has (GET /v1/models).
import { send, LlmError } from './request.js';
import { systemPrompt, OUTPUT_SCHEMA } from '../prompt.js';
import { estimateChunk } from '../prices.js';
import { isOrigin } from '../../../../lib/permissions-core.js';

/**
 * An adapter for the service at `base`, a site (https, or http for localhost and 127.0.0.1 only):
 * { id, origins, listModels({ signal }), estimate(chunk), extract(chunk, { model, signal, language }) }.
 * `fetch` is required (the permissions module's in the page); `key` is optional.
 */
export function openaiCompatible({ base, key = null, fetch, route, id = 'openai-compatible', name, temperature = 0, seed, maxTokens, timeoutMs, maxTries, sleep } = {}) {
  if (typeof fetch !== 'function') throw new TypeError('openaiCompatible: give the fetch to use (in the page, the permissions module\'s).');
  if (!isOrigin(base)) throw new TypeError('openaiCompatible: the service must be given as a site, such as http://localhost:11434 or https://example.org, with nothing after it.');
  if (key !== null && (typeof key !== 'string' || !key.trim())) throw new TypeError('openaiCompatible: a key, if given, must be text.');
  if (seed !== undefined && !Number.isInteger(seed)) throw new TypeError('openaiCompatible: a seed must be a whole number.');
  const k = key ? key.trim() : null;
  const headers = (post) => ({
    Accept: 'application/json',
    ...(k ? { Authorization: 'Bearer ' + k } : {}),
    ...(post ? { 'Content-Type': 'application/json' } : {}),
  });
  const who = name || `The service at ${base}`;
  const common = { fetch, route: route ?? { cat: 'llm', subj: base }, timeoutMs, maxTries, sleep, keys: k ? [k] : [], who };

  return {
    id,
    name: name || base,
    origins: [base],

    /** The models the service offers: [{ id, name, created }]. */
    async listModels({ signal } = {}) {
      const j = await send({ ...common, url: `${base}/v1/models`, init: { method: 'GET', headers: headers(false) }, signal });
      return (Array.isArray(j?.data) ? j.data : []).filter((m) => m && typeof m.id === 'string')
        .map((m) => ({ id: m.id, name: m.id, created: Number.isFinite(m.created) ? new Date(m.created * 1000).toISOString() : null }));
    },

    estimate: (chunk) => estimateChunk(chunk),

    /** One chunk's reply, as anthropic.js gives it. Throws LlmError. */
    async extract(chunk, { model, signal, language } = {}) {
      if (typeof model !== 'string' || !model) throw new TypeError('openaiCompatible: choose a model; there is no default.');
      const settings = {};
      if (temperature !== null && temperature !== undefined) settings.temperature = temperature;
      if (seed !== undefined) settings.seed = seed;
      if (maxTokens !== undefined) settings.max_tokens = maxTokens;
      const body = {
        model,
        messages: [{ role: 'system', content: systemPrompt({ language }) }, { role: 'user', content: chunk.text }],
        response_format: { type: 'json_schema', json_schema: { name: 'place_mentions', strict: true, schema: OUTPUT_SCHEMA } },
        ...settings,
      };
      const j = await send({ ...common, url: `${base}/v1/chat/completions`, init: { method: 'POST', headers: headers(true), body: JSON.stringify(body) }, signal });
      const choice = Array.isArray(j?.choices) ? j.choices[0] : null;
      if (choice?.finish_reason === 'content_filter' || (typeof choice?.message?.refusal === 'string' && choice.message.refusal)) throw new LlmError(`${who}'s model declined to answer.`, { kind: 'refused' });
      return {
        reply: typeof choice?.message?.content === 'string' ? choice.message.content : '',
        truncated: choice?.finish_reason === 'length',
        usage: { input: Number(j?.usage?.prompt_tokens) || 0, output: Number(j?.usage?.completion_tokens) || 0 },
        model: typeof j?.model === 'string' ? j.model : model,
        settings,
      };
    },
  };
}
