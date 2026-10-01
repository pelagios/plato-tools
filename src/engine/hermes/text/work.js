// Hermes, place names in a text: the work file (<name>.hermes-text.json), where a model's suggestions
// and a reviewer's decisions are kept until they are finished.
//
// A model's suggestion is software's, not anyone's statement, and a mention with no place linked is
// evidence about nothing, so neither is PLATO: they live here, in the tools' own file, as Krisis's
// work file keeps its candidates. PLATO attestations are made from it (attest.js) only for mentions a
// named reviewer has confirmed AND linked to a place.
//
// What it records of each chunk's result is its provenance: the chunk (index, start, end, SHA-256),
// the provider, the model as asked for and as the provider named it, the prompt's version and digest,
// the settings sent, when, the tokens used, the mentions found (offsets the tools computed), and the
// count of each kind refused. Never the key, never a header, never an address with a query.
//
// The shape, version 1:
//   { hermes_text: 1, created_at, source: { title, uri? }, language?, text: { name, sha256, characters },
//     prompt: { version, sha256 }, schema_version, chunking: { target, overlap },
//     results: [{ chunk: { index, start, end, sha256 }, provider, model, model_returned, prompt_version,
//       prompt_sha256, settings, generated_at, usage: { input, output }, mentions: [{ start, end, text, kind, kindGiven? }],
//       refused: { kind: n } }],
//     review: { reviewer: null | { name, orcid? }, decisions: { <suggestion id>: decision } } }
// A suggestion's id is its span as the model's mention was aligned, "<start>-<end>", and stays its id
// when the reviewer adjusts the span. A decision:
//   { status: 'confirmed' | 'rejected', decided_at, start?, end?, type?, place?, place_from? }
// start and end (code points) only when the reviewer adjusted the span; type only when the reviewer
// confirmed or changed the model's guess at the kind of place; place (an IRI) once linked.
//
// Resuming: a chunk is done for a run when a result has the same chunk (start and SHA-256), provider,
// model and prompt version. Cancelling keeps every result already added.
import { DataError } from '../../input.js';
import { checkReviewer, DATE_TIME, isIri } from '../../krisis/work.js';
import { placeAddress } from '../addresses.js';
import { sha256 } from '../../../lib/sha256.js';
import { PROMPT_VERSION, PROMPT_SHA256, SCHEMA_VERSION, KINDS, isLanguageTag } from './prompt.js';
import { CHUNKING, cpLength, sliceCodePoints, dedupeMentions } from './chunk.js';

export const WORK_VERSION = 1;
export const STATUSES = ['confirmed', 'rejected'];
export const MAX_TYPE = 100;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (n) => Number.isInteger(n) && n >= 0;

function checkSource(source) {
  if (!isObject(source) || typeof source.title !== 'string' || !source.title.trim()) throw new DataError('Give the title of the text, for the citation.');
  if (source.uri !== undefined && !isIri(source.uri)) throw new DataError('The address of the text, if given, must be a web address (an IRI).');
  for (const k of Object.keys(source)) if (k !== 'title' && k !== 'uri') throw new DataError(`The text's source may have a title and an address only, not "${k}".`);
}

/** A new work file for `text` (a string, the decoded text). */
export function newWork({ text, name = 'text.txt', source, language, chunking = CHUNKING, now = new Date().toISOString() } = {}) {
  if (typeof text !== 'string' || !text.length) throw new DataError('There is no text to look in.');
  checkSource(source);
  if (language !== undefined && language !== null && language !== '' && !isLanguageTag(language)) throw new DataError(`"${language}" is not a language tag, such as la, grc or en-GB.`);
  const w = {
    hermes_text: WORK_VERSION,
    created_at: now,
    source: { title: source.title.trim(), ...(source.uri ? { uri: source.uri } : {}) },
    text: { name: String(name), sha256: sha256(text), characters: cpLength(text) },
    prompt: { version: PROMPT_VERSION, sha256: PROMPT_SHA256 },
    schema_version: SCHEMA_VERSION,
    chunking: { target: chunking.target, overlap: chunking.overlap },
    results: [],
    review: { reviewer: null, decisions: {} },
  };
  if (language) w.language = language;
  return w;
}

/** Throws a DataError unless `text` is the text the work file was made from. */
export function checkText(work, text) {
  if (typeof text !== 'string' || sha256(text) !== work.text.sha256) throw new DataError(`This is not the text the work file was made from (${work.text.name}): its SHA-256 differs. Choose that text, unchanged.`);
}

const sameChunk = (r, chunk) => r.chunk.start === chunk.start && r.chunk.sha256 === chunk.sha256;
/** Whether a chunk already has a result from this provider and model, with this prompt. */
export function isDone(work, chunk, provider, model) {
  return work.results.some((r) => sameChunk(r, chunk) && r.provider === provider && r.model === model && r.prompt_version === PROMPT_VERSION);
}

/** Add one chunk's result. `mentions` and `refused` as validate.js's readReply gives them (mentions and counts). */
export function addResult(work, { chunk, provider, model, modelReturned, settings = {}, usage = { input: 0, output: 0 }, mentions, refused = {}, generatedAt = new Date().toISOString() }) {
  const r = {
    chunk: { index: chunk.index, start: chunk.start, end: chunk.end, sha256: chunk.sha256 },
    provider, model, model_returned: modelReturned ?? model,
    prompt_version: PROMPT_VERSION, prompt_sha256: PROMPT_SHA256,
    settings: { ...settings }, generated_at: generatedAt,
    usage: { input: usage.input || 0, output: usage.output || 0 },
    mentions: mentions.map((m) => ({ start: m.start, end: m.end, text: m.text, kind: m.kind, ...(m.kindGiven !== undefined ? { kindGiven: m.kindGiven } : {}) })),
    refused: { ...refused },
  };
  work.results.push(r);
  return r;
}

/**
 * The suggestions to review: every mention of the results of `provider` and `model` (all results if
 * neither is given), each span once (the first result's), in the order of the text:
 * [{ id, start, end, text, kind, kindGiven?, provider, model, model_returned, prompt_version, generated_at }].
 * `repeated` counts the mentions left out as a span already suggested (the overlap of chunks).
 */
export function suggestions(work, { provider, model } = {}) {
  const all = [];
  for (const r of work.results) {
    if ((provider && r.provider !== provider) || (model && r.model !== model)) continue;
    for (const m of r.mentions) all.push({ id: `${m.start}-${m.end}`, ...m, provider: r.provider, model: r.model, model_returned: r.model_returned, prompt_version: r.prompt_version, generated_at: r.generated_at });
  }
  const { kept, repeated } = dedupeMentions(all);
  kept.sort((a, b) => a.start - b.start || a.end - b.end);
  kept.repeated = repeated;
  return kept;
}

/** Name the reviewer (checked as Krisis checks one). */
export function setReviewer(work, reviewer) { work.review.reviewer = checkReviewer(reviewer); return work; }

/**
 * Record the reviewer's decision on suggestion `id` (null takes it back). `text` is the text, to
 * check an adjusted span against.
 *   status   'confirmed' or 'rejected'
 *   start, end  an adjusted span, in code points: it must be in the text and not blank
 *   type     the kind of place as the reviewer confirms or changes it (a label); absent, the model's
 *            guess stays a guess
 *   place    the address of the place it names: put through placeAddress, as every reader's are
 *   placeFrom  how it was found: 'pasted' or 'whg'
 */
export function decide(work, text, id, d, { at = new Date().toISOString() } = {}) {
  if (!suggestions(work).some((s) => s.id === id)) throw new DataError(`There is no suggestion ${id}.`);
  if (d === null) { delete work.review.decisions[id]; return null; }
  if (!isObject(d) || !STATUSES.includes(d.status)) throw new DataError('A decision confirms or rejects a suggestion.');
  const out = { status: d.status, decided_at: at };
  if (!DATE_TIME.test(at)) throw new DataError(`"${at}" is not a date and time as ISO 8601 writes them.`);
  if (d.status === 'confirmed') {
    if (d.start !== undefined || d.end !== undefined) {
      const span = sliceCodePoints(text, d.start, d.end);
      if (span === null || !span.trim()) throw new DataError(`Characters ${d.start} to ${d.end} are not a span of the text with words in it.`);
      if (`${d.start}-${d.end}` !== id) { out.start = d.start; out.end = d.end; }
    }
    if (d.type !== undefined && d.type !== null) {
      if (typeof d.type !== 'string' || !d.type.trim() || d.type.trim().length > MAX_TYPE) throw new DataError(`A type of place is a word or a few (at most ${MAX_TYPE} characters).`);
      out.type = d.type.trim();
    }
    if (d.place !== undefined && d.place !== null) {
      const a = placeAddress(d.place);
      if (a.lost) throw new DataError(`"${d.place}" cannot be the address of a place here (${a.lost === 'whg-staging' ? "it is on WHG's staging copy, not a citation target" : "it is a record's database key in WHG, not a place's address"}).`);
      if (!(typeof a.iri === 'string' && /^https?:\/\//i.test(a.iri) && isIri(a.iri))) throw new DataError(`"${d.place}" is not a place's web address, such as https://pleiades.stoa.org/places/579885.`);
      out.place = a.iri;
      if (d.placeFrom !== undefined) out.place_from = String(d.placeFrom);
    }
  }
  work.review.decisions[id] = out;
  return out;
}

/** How far the review has got: { suggested, decided, confirmed, linked, rejected }. */
export function reviewProgress(work) {
  const ds = Object.values(work.review.decisions);
  return {
    suggested: suggestions(work).length, decided: ds.length,
    confirmed: ds.filter((d) => d.status === 'confirmed').length,
    linked: ds.filter((d) => d.status === 'confirmed' && d.place).length,
    rejected: ds.filter((d) => d.status === 'rejected').length,
  };
}

/** A work file's text. */
export const serialiseWork = (work) => JSON.stringify(work, null, 2) + '\n';

/**
 * Read a work file (its text, or the object), checked: anything no run or review could have written
 * is refused with a DataError saying what.
 */
export function readWork(input) {
  let w;
  try { w = typeof input === 'string' ? JSON.parse(input) : input; } catch (e) { throw new DataError(`This is not a work file of place names in a text: it is not JSON (${e.message}).`); }
  if (!isObject(w) || !Object.hasOwn(w, 'hermes_text')) throw new DataError('This is not a work file of place names in a text: it has no "hermes_text" version.');
  if (w.hermes_text !== WORK_VERSION) throw new DataError(`This work file is of version ${JSON.stringify(w.hermes_text)}, and these tools read version ${WORK_VERSION}.`);
  const bad = (m) => { throw new DataError(`This work file cannot be used: ${m}`); };
  if (typeof w.created_at !== 'string' || !DATE_TIME.test(w.created_at)) bad('it does not say when it was made (created_at).');
  try { checkSource(w.source); } catch (e) { bad(e.message[0].toLowerCase() + e.message.slice(1)); }
  if (w.language !== undefined && !isLanguageTag(w.language)) bad('its language is not a language tag.');
  if (!isObject(w.text) || typeof w.text.name !== 'string' || !/^[0-9a-f]{64}$/.test(w.text.sha256) || !isCount(w.text.characters)) bad('it does not say which text it is of (text: name, sha256, characters).');
  if (!isObject(w.prompt) || typeof w.prompt.version !== 'string' || !/^[0-9a-f]{64}$/.test(w.prompt.sha256)) bad('it does not say which prompt it was made with (prompt).');
  if (!isObject(w.chunking) || !Number.isInteger(w.chunking.target) || !Number.isInteger(w.chunking.overlap)) bad('it does not say how the text was cut (chunking).');
  if (!Array.isArray(w.results)) bad('it has no list of results.');
  for (const [i, r] of w.results.entries()) {
    const where = `result ${i + 1}`;
    if (!isObject(r) || !isObject(r.chunk) || !isCount(r.chunk.start) || !isCount(r.chunk.end) || !/^[0-9a-f]{64}$/.test(r.chunk.sha256)) bad(`${where} does not say which chunk it is of.`);
    if (typeof r.provider !== 'string' || !r.provider || typeof r.model !== 'string' || !r.model) bad(`${where} does not say which provider and model made it.`);
    if (typeof r.prompt_version !== 'string' || typeof r.generated_at !== 'string' || !DATE_TIME.test(r.generated_at)) bad(`${where} does not say when, and with which prompt, it was made.`);
    if (!Array.isArray(r.mentions)) bad(`${where} has no list of mentions.`);
    for (const m of r.mentions) {
      if (!isObject(m) || !isCount(m.start) || !Number.isInteger(m.end) || m.end <= m.start || typeof m.text !== 'string' || !KINDS.includes(m.kind)) bad(`${where} has a mention that is not a span, a name and a kind.`);
      if (m.start < r.chunk.start || m.end > w.text.characters) bad(`${where} has a mention outside its chunk or the text.`);
      if (cpLength(m.text) !== m.end - m.start) bad(`${where} has a mention whose span is not as long as its name.`);
    }
  }
  if (!isObject(w.review) || !isObject(w.review.decisions)) bad('it has no review (review.decisions).');
  if (w.review.reviewer !== null && w.review.reviewer !== undefined) { try { checkReviewer(w.review.reviewer); } catch (e) { bad(e.message[0].toLowerCase() + e.message.slice(1)); } }
  const ids = new Set(suggestions(w).map((s) => s.id));
  for (const [id, d] of Object.entries(w.review.decisions)) {
    if (!ids.has(id)) bad(`a decision is about ${id}, which is not a suggestion of the file.`);
    if (!isObject(d) || !STATUSES.includes(d.status) || typeof d.decided_at !== 'string' || !DATE_TIME.test(d.decided_at)) bad(`the decision on ${id} is not a confirmation or rejection with its date.`);
    if (d.place !== undefined && (d.status !== 'confirmed' || !isIri(d.place) || !/^https?:\/\//i.test(d.place))) bad(`the decision on ${id} links a place that is not an IRI, or links a rejected suggestion.`);
    if ((d.start !== undefined || d.end !== undefined) && !(isCount(d.start) && Number.isInteger(d.end) && d.end > d.start && d.end <= w.text.characters)) bad(`the decision on ${id} adjusts the span to something that is not one.`);
    if (d.type !== undefined && (typeof d.type !== 'string' || !d.type.trim())) bad(`the decision on ${id} has a type that is not a word.`);
  }
  return w;
}
