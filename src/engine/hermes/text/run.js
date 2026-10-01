// Hermes, place names in a text: a run, sending the chunks of a text to a provider one at a time and
// keeping each chunk's result in the work file as it comes.
//
// - One chunk at a time; progress after each.
// - RESUMING: a chunk that already has a result from this provider and model, with this prompt, is
//   not sent again (work.js, isDone).
// - CANCELLING: the signal aborts the request in flight; every chunk finished before stays in the
//   work file, and the run returns { cancelled: true }.
// - A reply cut off (max tokens) is never read in part: the chunk is cut in two near its middle, at a
//   break (chunk.js, halve), and each half is sent; a half that is cut off too is halved again, down
//   to MIN_HALF characters, below which the chunk is reported as failed.
// - A reply that cannot be used (not JSON, not a list of mentions) leaves the chunk without a result,
//   reported, so that resuming tries it again.
// - A provider's refusal of the request (the key, a model that does not exist, a permission not
//   given) stops the run: the next chunk would be refused alike. The error is passed on as it is.
import { chunkText, halve } from './chunk.js';
import { readReply, addCounts } from './validate.js';
import { checkText, isDone, addResult } from './work.js';
import { LlmError } from './providers/request.js';

export const MIN_HALF = 500;

/**
 * Run `provider` (an adapter) with `model` over the text of `work`. Returns
 * { done, skipped, failed: [{ index, kind, example }], cancelled, stopped (an error) | null, usage, counts }.
 * `maxChunks` refuses a run with more chunks to send than that, before anything is sent.
 * `onProgress({ index, of, done, skipped })` after each chunk.
 */
export async function runExtraction({ work, text, provider, model, signal, onProgress, maxChunks, now = () => new Date().toISOString() }) {
  checkText(work, text);
  if (typeof model !== 'string' || !model) throw new TypeError('runExtraction: choose a model; there is no default.');
  const chunks = chunkText(text, work.chunking);
  const pending = chunks.filter((c) => !isDone(work, c, provider.id, model));
  const out = { done: 0, skipped: chunks.length - pending.length, failed: [], cancelled: false, stopped: null, usage: { input: 0, output: 0 }, counts: {}, of: chunks.length };
  if (maxChunks !== undefined && pending.length > maxChunks) {
    out.stopped = new RangeError(`This run would send ${pending.length} chunks, more than the ${maxChunks} allowed.`);
    return out;
  }
  for (const chunk of pending) {
    if (signal?.aborted) { out.cancelled = true; break; }
    let got;
    try {
      got = await extractChunk(provider, chunk, { model, signal, language: work.language });
    } catch (e) {
      if (signal?.aborted) { out.cancelled = true; break; }
      if (e instanceof LlmError && e.kind === 'refused') { out.failed.push({ index: chunk.index, kind: 'text-reply-refused', example: e.message }); addCounts(out.counts, { 'text-reply-refused': 1 }); continue; }
      out.stopped = e;
      break;
    }
    out.usage.input += got.usage.input; out.usage.output += got.usage.output;
    addCounts(out.counts, got.counts);
    if (got.failed) { out.failed.push({ index: chunk.index, kind: got.failed, example: got.example }); continue; }
    addResult(work, { chunk, provider: provider.id, model, modelReturned: got.model, settings: got.settings, usage: got.usage, mentions: got.mentions, refused: got.counts, generatedAt: now() });
    out.done++;
    onProgress?.({ index: chunk.index, of: chunks.length, done: out.done, skipped: out.skipped });
  }
  return out;
}

/**
 * One chunk (or part of one), read and aligned: { mentions, counts, usage, model, settings } or, when it
 * could not be used, the same with `failed` (a TEXT_KINDS kind) and `example`. Halves a chunk whose
 * reply was cut off.
 */
export async function extractChunk(provider, chunk, { model, signal, language }) {
  const r = await provider.extract(chunk, { model, signal, language });
  const usage = { input: r.usage?.input || 0, output: r.usage?.output || 0 };
  if (r.truncated) {
    const parts = halve(chunk, { min: MIN_HALF / 2 });
    const counts = { 'text-reply-cut-off': 1 };
    if (!parts || chunk.text.length < MIN_HALF) return { failed: 'text-reply-cut-off', example: `a reply to ${chunk.text.length} characters`, mentions: [], counts, usage, model: r.model, settings: r.settings };
    const mentions = [];
    for (const p of parts) {
      const g = await extractChunk(provider, p, { model, signal, language });
      usage.input += g.usage.input; usage.output += g.usage.output;
      addCounts(counts, g.counts);
      if (g.failed) return { ...g, counts, usage };
      mentions.push(...g.mentions);
    }
    return { mentions, counts, usage, model: r.model, settings: { ...r.settings, halved: true } };
  }
  const read = readReply(r.reply, chunk);
  if (!read.ok) { const kind = Object.keys(read.counts)[0]; return { failed: kind, example: read.examples[kind], mentions: [], counts: read.counts, usage, model: r.model, settings: r.settings }; }
  return { mentions: read.mentions, counts: read.counts, usage, model: r.model, settings: r.settings };
}
