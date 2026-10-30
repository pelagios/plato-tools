// Shared by the tests of Hermes's place names in a text, phase 2 (hermes-text-*.test.js): a scripted
// provider, and a model that answers as an honest one would, in composed (NFC) characters.
import * as T from '../src/engine/hermes/text/index.js';

export const NOW = '2026-10-01T12:00:00Z';
export const REVIEWER = { name: 'Ada Lovelace', orcid: 'https://orcid.org/0000-0002-1825-0097' };
export const SOURCE = { title: 'A test itinerary', uri: 'https://example.org/texts/itinerary' };

/**
 * A model's reply to `chunk`: every occurrence of each name (given in NFC, as models write) in the
 * chunk's text as the model was sent it, with its context.
 */
export function honest(chunk, names, { kind = 'settlement' } = {}) {
  const out = [];
  for (const n of names) {
    for (let i = chunk.text.indexOf(n); i >= 0; i = chunk.text.indexOf(n, i + 1)) {
      out.push({ text: n, prefix: Array.from(chunk.text.slice(0, i)).slice(-30).join(''), suffix: Array.from(chunk.text.slice(i + n.length)).slice(0, 30).join(''), start: T.cpLength(chunk.text.slice(0, i)), kind });
    }
  }
  return { mentions: out };
}

/** A fake provider: `script(chunk, n)` gives { reply (object or string), truncated?, usage? } for call n. */
export function fake(script, { id = 'fake' } = {}) {
  const calls = [];
  return {
    id, name: 'Fake', origins: [], calls,
    estimate: T.estimateChunk,
    async extract(chunk, { model, signal } = {}) {
      calls.push({ chunk, model });
      if (signal?.aborted) throw signal.reason;
      const r = await script(chunk, calls.length, signal);
      return { reply: typeof r.reply === 'string' ? r.reply : JSON.stringify(r.reply), truncated: !!r.truncated, usage: r.usage ?? { input: 100, output: 10 }, model: model + '-20261001', settings: { temperature: 0 } };
    },
  };
}

/** A new work file for `text`, run once with a model that finds `names` (NFC). */
export async function found(text, names, { source = SOURCE, language, model = 'claude-x', kind } = {}) {
  const work = T.newWork({ text, source, language, now: NOW });
  const provider = fake((c) => ({ reply: honest(c, names, kind ? { kind } : {}) }));
  const run = await T.runExtraction({ work, text, provider, model, now: () => NOW });
  return { work, run, provider };
}
