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
//   { hermes_text: 1, created_at, source: { title, uri?, rights? }, language?, text: { name, sha256, characters, bom?, content? },
//     prompt: { version, sha256 }, schema_version, chunking: { target, overlap },
//     results: [{ chunk: { index, start, end, sha256 }, provider, model, model_returned, prompt_version,
//       prompt_sha256, settings, generated_at, usage: { input, output }, mentions: [{ start, end, text, kind, kindGiven? }],
//       refused: { kind: n } }],
//     review: { reviewer: null | { name, orcid? }, decisions: { <suggestion id>: decision } },
//     context?: { rights, of: { <suggestion id>: { start, end, before, after } } } }   (a copy for sharing, see below)
// `text.bom`: the file began with a UTF-8 byte order mark, not a character of the text and not counted in
// any offset. The text is the text as given (a decomposed or CRLF file stays so): the model is sent a
// composed copy and what it finds is mapped back (normalise.js), so every offset is true to the file.
// A suggestion's id is its span as the model's mention was aligned, "<start>-<end>", and stays its id
// when the reviewer adjusts the span. A decision:
//   { status: 'confirmed' | 'rejected', decided_at, start?, end?, type?, place?, place_from?, separate? }
// start and end (code points) only when the reviewer adjusted the span; type only when the reviewer
// confirmed or changed the model's guess at the kind of place; place (an IRI) once linked.
//
// A reviewer may add a name the model missed (addMention): a result of provider "reviewer", model
// "reviewer", with the one name in it, the reviewer who marked it, and no usage (nothing was sent). It is
// a suggestion like any other to decide on, and its attestation says the contributor added it.
// A decision may also say `separate: true` of a confirmed name: this occurrence is a different place
// from the others of its spelling (dataset.js makes one place for each spelling otherwise).
//
// The text itself is kept in the file (`text.content`, checked to hash to `text.sha256`), so that the
// review can be read again without choosing the file; a copy for sharing (withoutText) leaves it out and
// carries instead, in `context`, the passage around each name, quoted, with the text's rights statement
// (`source.rights`, or a plain saying that none was given). Neither a project file nor a WHG save holds
// the text (src/engine/methodos/project.js).
//
// Resuming: a chunk is done for a run when a result has the same chunk (start and SHA-256), provider,
// model and prompt version. Cancelling keeps every result already added.
import { DataError } from '../../input.js';
import { checkReviewer, DATE_TIME, isIri } from '../../krisis/work.js';
import { placeAddress } from '../addresses.js';
import { sha256 } from '../../../lib/sha256.js';
import { PROMPT_VERSION, PROMPT_SHA256, SCHEMA_VERSION, KINDS, isLanguageTag } from './prompt.js';
import { CHUNKING, cpLength, sliceCodePoints, dedupeMentions, isWellFormed } from './chunk.js';
import { MAX_NAME } from './prompt.js';
import { TEXT_WORDS } from '../../words.js';

export const WORK_VERSION = 1;
export const STATUSES = ['confirmed', 'rejected'];
/** The provider (and model) of a name a reviewer added. */
export const REVIEWER_PROVIDER = 'reviewer';
/** How many characters (code points) of the text are quoted before and after a name in a copy for sharing. */
export const CONTEXT_CHARACTERS = 60;
const MAX_RIGHTS = 1000;
const MAX_QUOTED = 400;
/**
 * The types a reviewer may confirm: the engine's fixed kinds, chosen from a list and never typed, and
 * written as a label with no vocabulary term for now (the maintainer's decision, 2026-10-01). Not
 * "other", which says no more than leaving the type out.
 */
export const TYPE_KINDS = Object.freeze(KINDS.filter((k) => k !== 'other'));

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (n) => Number.isInteger(n) && n >= 0;
/** How a linked place was found. */
export const PLACE_FROM = Object.freeze(['pasted', 'whg']);
// A model's name as a provider gives it (claude-sonnet-5-5-20261001, llama3.1:8b, org/model).
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

function checkSource(source) {
  if (!isObject(source) || typeof source.title !== 'string' || !source.title.trim()) throw new DataError('Give the title of the text, for the citation.');
  if (source.uri !== undefined && !isIri(source.uri)) throw new DataError('The address of the text, if given, must be a web address (an IRI).');
  if (source.rights !== undefined && !(typeof source.rights === 'string' && source.rights.trim() && source.rights.length <= MAX_RIGHTS)) throw new DataError(`The rights statement of the text, if given, must be words of at most ${MAX_RIGHTS} characters.`);
  for (const k of Object.keys(source)) if (!['title', 'uri', 'rights'].includes(k)) throw new DataError(`The text's source may have a title, an address and a rights statement only, not "${k}".`);
}

/**
 * A new work file for `text` (a string, the decoded text: decode.js). `bom`: the file began with a UTF-8
 * byte order mark, which is not in `text` and is not counted in the offsets. The text is kept in the file
 * unless `keepText` is false.
 */
export function newWork({ text, name = 'text.txt', source, language, bom = false, keepText: keep = true, chunking = CHUNKING, now = new Date().toISOString() } = {}) {
  if (typeof text !== 'string' || !text.length) throw new DataError('There is no text to look in.');
  // A blank rights statement is none; anything else is checked.
  if (source && typeof source.rights === 'string' && !source.rights.trim()) source = { ...source, rights: undefined };
  checkSource(source);
  if (language !== undefined && language !== null && language !== '' && !isLanguageTag(language)) throw new DataError(`"${language}" is not a language tag, such as la, grc or en-GB.`);
  const w = {
    hermes_text: WORK_VERSION,
    created_at: now,
    source: { title: source.title.trim(), ...(source.uri ? { uri: source.uri } : {}), ...(source.rights ? { rights: source.rights.trim() } : {}) },
    text: { name: String(name), sha256: sha256(text), characters: cpLength(text), ...(bom ? { bom: true } : {}), ...(keep ? { content: text } : {}) },
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
    provider, model, model_returned: typeof modelReturned === 'string' && MODEL_ID.test(modelReturned) ? modelReturned : model,
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
 * [{ id, start, end, text, kind, kindGiven?, added?, provider, model, model_returned, prompt_version, generated_at }];
 * `added` is true of a name the reviewer added (addMention), which is always in the list.
 * `repeated` counts the mentions left out as a span already suggested (the overlap of chunks).
 */
export function suggestions(work, { provider, model } = {}) {
  const all = [];
  for (const r of work.results) {
    // A name the reviewer added is the reviewer's, whichever model is asked for.
    const added = r.provider === REVIEWER_PROVIDER;
    if (!added && ((provider && r.provider !== provider) || (model && r.model !== model))) continue;
    for (const m of r.mentions) all.push({ id: `${m.start}-${m.end}`, ...m, ...(added ? { added: true } : {}), provider: r.provider, model: r.model, model_returned: r.model_returned, prompt_version: r.prompt_version, generated_at: r.generated_at });
  }
  const { kept, repeated } = dedupeMentions(all);
  kept.sort((a, b) => a.start - b.start || a.end - b.end);
  kept.repeated = repeated;
  return kept;
}

/** Name the reviewer (checked as Krisis checks one). */
export function setReviewer(work, reviewer) { work.review.reviewer = checkReviewer(reviewer); return work; }

/**
 * The reviewer adds a name the model missed (Stephen, 30 October 2026, Q9 A): the span `start` to `end`
 * (code points) of `text` becomes a suggestion of provider "reviewer", for the reviewer to decide on as
 * any other. A person's statement, not a model's: it needs the reviewer named (setReviewer), says so in
 * its attestation's note, guesses no kind of place, and records no usage, as nothing was sent. Returns
 * the suggestion's id. Throws a DataError for a span not in the text, blank or too long to be a name,
 * or a span already suggested (decide on that one).
 */
export function addMention(work, text, { start, end } = {}, { at = new Date().toISOString() } = {}) {
  checkText(work, text);
  if (!work.review.reviewer) throw new DataError('Name the reviewer before adding a name: it is the reviewer\'s statement that these words are a place name, and the file records who made it.');
  if (!DATE_TIME.test(at)) throw new DataError(`"${at}" is not a date and time as ISO 8601 writes them.`);
  if (end - start > MAX_NAME) throw new DataError(`Characters ${start} to ${end} are longer than any place name (more than ${MAX_NAME} characters).`);
  const name = sliceCodePoints(text, start, end);
  if (name === null || !name.trim()) throw new DataError(`Characters ${start} to ${end} are not a span of the text with words in it.`);
  const id = `${start}-${end}`;
  if (suggestions(work).some((s) => s.id === id)) throw new DataError(`Characters ${start} to ${end} (${name.length > 40 ? name.slice(0, 40) + '…' : name}) are already suggested: decide on that suggestion.`);
  work.results.push({
    chunk: { index: 0, start: 0, end: work.text.characters, sha256: work.text.sha256 },
    provider: REVIEWER_PROVIDER, model: REVIEWER_PROVIDER, model_returned: REVIEWER_PROVIDER, prompt_version: REVIEWER_PROVIDER,
    settings: {}, generated_at: at, usage: { input: 0, output: 0 },
    mentions: [{ start, end, text: name, kind: 'other' }], refused: {},
    reviewer: { ...work.review.reviewer },
  });
  return id;
}

/**
 * Record the reviewer's decision on suggestion `id` (null takes it back). `text` is the text, to
 * check an adjusted span against.
 *   status   'confirmed' or 'rejected'
 *   start, end  an adjusted span, in code points: it must be in the text and not blank
 *   type     the kind of place as the reviewer confirms or changes it (a label); absent, the model's
 *            guess stays a guess
 *   place    the address of the place it names: put through placeAddress, as every reader's are
 *   placeFrom  how it was found: 'pasted' or 'whg'
 *   separate   true: this occurrence is a different place from the others of its spelling (a confirmed
 *              name only; dataset.js)
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
      if (!TYPE_KINDS.includes(d.type)) throw new DataError(`The type of place is chosen from ${TYPE_KINDS.join(', ')}; "${String(d.type).slice(0, 40)}" is not one of them. To record no type, leave it out.`);
      out.type = d.type;
    }
    if (d.place !== undefined && d.place !== null) {
      const a = placeAddress(d.place);
      if (a.lost) throw new DataError(`"${d.place}" cannot be the address of a place here (${a.lost === 'whg-staging' ? "it is on WHG's staging copy, not a citation target" : "it is a record's database key in WHG, not a place's address"}).`);
      if (!(typeof a.iri === 'string' && /^https?:\/\//i.test(a.iri) && isIri(a.iri))) throw new DataError(`"${d.place}" is not a place's web address, such as https://pleiades.stoa.org/places/579885.`);
      out.place = a.iri;
      if (d.placeFrom !== undefined) {
        if (!PLACE_FROM.includes(d.placeFrom)) throw new DataError(`How the place was found is one of ${PLACE_FROM.join(', ')}.`);
        out.place_from = d.placeFrom;
      }
    }
    if (d.separate !== undefined) {
      if (typeof d.separate !== 'boolean') throw new DataError('Whether a name is a different place from the others of its spelling is true or false.');
      if (d.separate) out.separate = true;
    }
  }
  work.review.decisions[id] = out;
  return out;
}

/** How far the review has got: { suggested, decided, confirmed, linked, rejected, added } (added: names the reviewer added by hand). */
export function reviewProgress(work) {
  const ds = Object.values(work.review.decisions);
  return {
    suggested: suggestions(work).length, decided: ds.length, added: suggestions(work).filter((x) => x.added).length,
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
  if (w.text.bom !== undefined && w.text.bom !== true) bad('it notes a byte order mark as something other than true.');
  if (w.text.content !== undefined && !(typeof w.text.content === 'string' && cpLength(w.text.content) === w.text.characters && sha256(w.text.content) === w.text.sha256)) bad('the text kept in it is not the text it says it is of (text.sha256).');
  if (!isObject(w.prompt) || typeof w.prompt.version !== 'string' || !/^[0-9a-f]{64}$/.test(w.prompt.sha256)) bad('it does not say which prompt it was made with (prompt).');
  if (!isObject(w.chunking) || !Number.isInteger(w.chunking.target) || !Number.isInteger(w.chunking.overlap)) bad('it does not say how the text was cut (chunking).');
  if (!Array.isArray(w.results)) bad('it has no list of results.');
  for (const [i, r] of w.results.entries()) {
    const where = `result ${i + 1}`;
    if (!isObject(r) || !isObject(r.chunk) || !isCount(r.chunk.start) || !isCount(r.chunk.end) || !/^[0-9a-f]{64}$/.test(r.chunk.sha256)) bad(`${where} does not say which chunk it is of.`);
    if (typeof r.provider !== 'string' || !r.provider || typeof r.model !== 'string' || !r.model) bad(`${where} does not say which provider and model made it.`);
    if (r.model_returned !== undefined && !(typeof r.model_returned === 'string' && MODEL_ID.test(r.model_returned))) bad(`${where} names the model that answered with something that is not a model's name.`);
    if (typeof r.prompt_version !== 'string' || typeof r.generated_at !== 'string' || !DATE_TIME.test(r.generated_at)) bad(`${where} does not say when, and with which prompt, it was made.`);
    if (!Array.isArray(r.mentions)) bad(`${where} has no list of mentions.`);
    if (r.provider === REVIEWER_PROVIDER) {
      // A reviewer's result (addMention): one name, the whole text as its chunk, no model, nothing sent.
      if (r.model !== REVIEWER_PROVIDER || r.prompt_version !== REVIEWER_PROVIDER || (r.model_returned !== undefined && r.model_returned !== REVIEWER_PROVIDER)) bad(`${where} is a reviewer's result with a model or a prompt, which a reviewer's has none of.`);
      if (r.mentions.length !== 1) bad(`${where} is a reviewer's result, which holds one name.`);
      if (!isObject(r.reviewer)) bad(`${where} is a reviewer's result that names no reviewer.`);
      try { checkReviewer(r.reviewer); } catch (e) { bad(`${where}: ${e.message[0].toLowerCase() + e.message.slice(1)}`); }
      if (r.chunk.index !== 0 || r.chunk.start !== 0 || r.chunk.end !== w.text.characters || r.chunk.sha256 !== w.text.sha256) bad(`${where} is a reviewer's result whose chunk is not the whole text.`);
      if (r.usage && (r.usage.input || r.usage.output)) bad(`${where} is a reviewer's result that sent nothing to any model, so it has no usage.`);
    }
    for (const m of r.mentions) {
      if (!isObject(m) || !isCount(m.start) || !Number.isInteger(m.end) || m.end <= m.start || typeof m.text !== 'string' || !KINDS.includes(m.kind)) bad(`${where} has a mention that is not a span, a name and a kind.`);
      if (m.start < r.chunk.start || m.end > r.chunk.end || m.end > w.text.characters) bad(`${where} has a mention outside its chunk or the text.`);
      if (cpLength(m.text) !== m.end - m.start) bad(`${where} has a mention whose span is not as long as its name.`);
      if (!isWellFormed(m.text)) bad(`${where} has a mention whose name is not whole characters.`);
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
    if (d.type !== undefined && !TYPE_KINDS.includes(d.type)) bad(`the decision on ${id} has a type that is not one of ${TYPE_KINDS.join(', ')}.`);
    if (d.separate !== undefined && !(d.separate === true && d.status === 'confirmed')) bad(`the decision on ${id} says separate of something other than a confirmed name, or as something other than true.`);
    if (d.place_from !== undefined && !(d.place !== undefined && PLACE_FROM.includes(d.place_from))) bad(`the decision on ${id} says how its place was found as something other than ${PLACE_FROM.join(' or ')}, or has no place.`);
  }
  if (w.context !== undefined) {
    if (!isObject(w.context) || typeof w.context.rights !== 'string' || !w.context.rights.trim() || w.context.rights.length > MAX_RIGHTS) bad('its quoted context has no rights statement for the text.');
    if (!isObject(w.context.of)) bad('its quoted context has no list of names.');
    for (const [id, c] of Object.entries(w.context.of)) {
      if (!ids.has(id) || !isObject(c) || !isCount(c.start) || !Number.isInteger(c.end) || c.end <= c.start || c.end > w.text.characters
        || typeof c.before !== 'string' || typeof c.after !== 'string' || cpLength(c.before) > CONTEXT_CHARACTERS || cpLength(c.after) > CONTEXT_CHARACTERS
        || c.before.length > MAX_QUOTED || c.after.length > MAX_QUOTED || !isWellFormed(c.before) || !isWellFormed(c.after)) bad(`the quoted context of ${id} is not words around a name of the file.`);
    }
  }
  return w;
}

/** The text kept in a work file, or null when it was not kept (or this is a copy for sharing). */
export const textOf = (work) => (typeof work.text.content === 'string' ? work.text.content : null);

/** A copy of the work file with `text` kept in it (checked to be its text), and no quoted context: the text is there to be quoted. */
export function keepText(work, text) {
  checkText(work, text);
  const w = structuredClone(work);
  w.text.content = text;
  delete w.context;
  return w;
}

/**
 * A copy of the work file for sharing (a project, a WHG save): without the text, which may be someone
 * else's and is not the tools' to hand on, and with in its place, in `context`, the passage around each
 * name the file holds, CONTEXT_CHARACTERS code points either side, quoted, beside the text's rights
 * statement (or the plain saying that none was given), so that the review can still be read. `text` is
 * the text, if the file has not kept it. Each name is quoted at the span the reviewer settled on.
 */
export function withoutText(work, text = textOf(work)) {
  if (text === null) throw new DataError('Give the text: this work file has not kept it, and the quoted contexts are cut from it.');
  checkText(work, text);
  const w = structuredClone(work);
  delete w.text.content;
  const of = {};
  for (const s of suggestions(work)) {
    const d = work.review.decisions[s.id];
    const start = d?.start ?? s.start, end = d?.end ?? s.end;
    const from = Math.max(0, start - CONTEXT_CHARACTERS);
    of[s.id] = { start, end, before: sliceCodePoints(text, from, start) ?? '', after: sliceCodePoints(text, end, Math.min(work.text.characters, end + CONTEXT_CHARACTERS)) ?? '' };
  }
  w.context = { rights: work.source.rights || TEXT_WORDS.noRights, of };
  return w;
}
