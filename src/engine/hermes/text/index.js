// Hermes, place names in a text: the engine's pure parts, shared by the page and the command line.
// The page makes every request through the permissions module's fetch, which it gives the adapters;
// nothing here fetches on its own, keeps a key, or touches a page.
export { CHUNKING, chunkText, halve, dedupeMentions, cpLength, cpToIndex, sliceCodePoints, breakBetween } from './chunk.js';
export { PROMPT, PROMPT_VERSION, PROMPT_SHA256, SCHEMA_VERSION, OUTPUT_SCHEMA, KINDS, MAX_NAME, MAX_CONTEXT, systemPrompt, isLanguageTag } from './prompt.js';
export { readReply, addCounts, TEXT_KINDS, MAX_REPLY, MAX_MENTIONS } from './validate.js';
export { redact, clip } from './redact.js';
export { PRICES, PRICE_STALE_DAYS, CHARS_PER_TOKEN, CONFIRM_CHUNKS, CONFIRM_USD, estimateChunk, estimateRun, estimateWords, THINKING_ALLOWANCE, priceOf, costOf, needsSecondConfirmation } from './prices.js';
export { WORK_VERSION, TYPE_KINDS, newWork, readWork, serialiseWork, checkText, isDone, addResult, suggestions, setReviewer, decide, reviewProgress } from './work.js';
export { attestationsFrom, attestationsDocument, sourceOf, locatorOf, unlinkedCsv } from './attest.js';
export { runExtraction, extractChunk, MIN_HALF } from './run.js';
export { LlmError, send } from './providers/request.js';
export { anthropic, ANTHROPIC_ORIGIN, EFFORTS, DEFAULT_EFFORT } from './providers/anthropic.js';
export { openaiCompatible } from './providers/openai-compatible.js';
