// Hermes, place names in a text: reading a model's reply, and finding where in the text each name is.
//
// The same code reads every provider's reply. It is parsed with JSON.parse and nothing else (never
// evaluated, never read as HTML), checked against the reply schema with validators Ajv compiled in
// strict mode (reply-validators.js), and each mention against its own schema, so that one bad mention
// costs only itself.
//
// ALIGNMENT. A model's offsets are hints at most: models count characters badly. The tools find the
// name themselves: every exact occurrence of its text in the chunk; of those, the ones whose context
// agrees with the prefix and suffix the model gave (compared with runs of white space made one
// space); of those, the ones no other mention of this reply has taken (if every one is taken, this
// mention is a repeat, and refused); of those, the one nearest the `start` hint. A prefix or suffix
// given without the space next to the name still agrees. A name that does not occur in the chunk, or
// is not whole characters of it, is refused (`text-not-in-text`, `text-mention-invalid`): only words
// actually in the text are ever suggested, and the reviewer decides whether each is a place. (Words in
// the text may still have been put there by someone, instructions to a model included: being in the
// text says nothing more than that.) The offsets recorded are the tools', in code points of the whole text.
import { reply as validReply, mention as validMention } from './reply-validators.js';
import { KINDS, MAX_NAME, MAX_CONTEXT } from './prompt.js';
import { cpLength, sliceCodePoints } from './chunk.js';

/**
 * Each kind the reader reports, and how: 'error' (a chunk's reply could not be used at all) or
 * 'warning' (a mention was refused, or read otherwise than given). The words for each are in
 * src/engine/report.js (LOSS_TEXT), under the same kind.
 */
export const TEXT_KINDS = {
  'text-reply-not-json': 'error',
  'text-reply-not-mentions': 'error',
  'text-reply-too-large': 'error',
  'text-reply-cut-off': 'error',
  'text-reply-refused': 'error',
  'text-mention-invalid': 'warning',
  'text-mention-too-long': 'warning',
  'text-not-in-text': 'warning',
  'text-mention-repeated': 'warning',
  'text-too-many': 'warning',
  'text-kind-unknown': 'warning',
};

/** Limits of our own: the largest reply read (UTF-16 units), and the most mentions taken from one. */
export const MAX_REPLY = 1_000_000;
export const MAX_MENTIONS = 2000;

const squash = (s) => s.replace(/\s+/g, ' ');
// Whether the text before position i ends with `prefix` (white space compared as one space). Near the
// chunk's start the model may give context from before the chunk: what there is must agree with the end of it.
// The space next to the name is compared trimmed on both sides: a model often gives "then back to"
// for "then back to ".
function prefixAgrees(text, i, prefix) {
  const p = squash(prefix || '').trimEnd();
  if (!p) return false;
  const before = squash(text.slice(Math.max(0, i - 2 * prefix.length - 8), i)).trimEnd();
  if (before.endsWith(p)) return true;
  return i < prefix.length * 2 && before.length > 0 && p.endsWith(before);
}
function suffixAgrees(text, j, suffix) {
  const s = squash(suffix || '').trimStart();
  if (!s) return false;
  const after = squash(text.slice(j, j + 2 * suffix.length + 8)).trimStart();
  if (after.startsWith(s)) return true;
  return text.length - j < suffix.length * 2 && after.length > 0 && s.startsWith(after);
}
// The last `n` code points of a string, and the first.
const lastCps = (s, n) => { const a = Array.from(s); return a.length > n ? a.slice(-n).join('') : s; };
const firstCps = (s, n) => { const a = Array.from(s); return a.length > n ? a.slice(0, n).join('') : s; };

/**
 * A chunk's reply, read and aligned. `reply` is the model's text; `chunk` is { text, start } (start in
 * code points of the whole text). Returns { ok, mentions, counts, examples }:
 *   ok        false when the reply as a whole could not be used (counts then says why);
 *   mentions  [{ start, end, text, kind, kindGiven? }], start and end in code points of the whole text;
 *   counts    { kind: number } for each kind of TEXT_KINDS met;
 *   examples  { kind: string }, the first of each, short, for the report.
 */
export function readReply(reply, chunk) {
  const counts = {}, examples = {};
  const note = (kind, example) => { counts[kind] = (counts[kind] || 0) + 1; if (!(kind in examples) && example !== undefined) examples[kind] = String(example).slice(0, 120); };
  const fail = (kind, example) => { note(kind, example); return { ok: false, mentions: [], counts, examples }; };
  if (typeof reply !== 'string') return fail('text-reply-not-json', typeof reply);
  if (reply.length > MAX_REPLY) return fail('text-reply-too-large', `${reply.length} characters`);
  let data;
  try { data = JSON.parse(reply); } catch (e) { return fail('text-reply-not-json', reply.slice(0, 60)); }
  if (!validReply(data)) return fail('text-reply-not-mentions', validReply.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; '));
  let list = data.mentions;
  if (list.length > MAX_MENTIONS) { for (let i = MAX_MENTIONS; i < list.length; i++) note('text-too-many', `${list.length} given`); list = list.slice(0, MAX_MENTIONS); }

  const text = chunk.text, taken = new Set(), mentions = [];
  for (const m of list) {
    if (!validMention(m)) { note('text-mention-invalid', validMention.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')); continue; }
    if (!m.text.trim()) { note('text-mention-invalid', 'an empty name'); continue; }
    const len = cpLength(m.text);
    if (len > MAX_NAME) { note('text-mention-too-long', `${len} characters`); continue; }
    const prefix = lastCps(m.prefix, MAX_CONTEXT), suffix = firstCps(m.suffix, MAX_CONTEXT);
    // Every occurrence, overlapping ones included.
    const found = [];
    for (let i = text.indexOf(m.text); i >= 0; i = text.indexOf(m.text, i + 1)) found.push(i);
    if (!found.length) { note('text-not-in-text', m.text); continue; }
    const scored = found.map((i) => ({ i, agree: (prefixAgrees(text, i, prefix) ? 1 : 0) + (suffixAgrees(text, i + m.text.length, suffix) ? 1 : 0) }));
    const best = Math.max(...scored.map((x) => x.agree));
    let pool = scored.filter((x) => x.agree === best);
    const free = pool.filter((x) => !taken.has(x.i + ':' + m.text.length));
    if (!free.length) { note('text-mention-repeated', m.text); continue; }
    pool = free;
    for (const x of pool) x.cp = cpLength(text.slice(0, x.i));
    pool.sort((a, b) => Math.abs(a.cp - m.start) - Math.abs(b.cp - m.start) || a.i - b.i);
    const pick = pool[0];
    // Found by UTF-16 search, a name may begin or end inside a character (half of a surrogate pair): it
    // must be exactly the characters of its span.
    if (sliceCodePoints(text, pick.cp, pick.cp + len) !== m.text) { note('text-mention-invalid', `a name that is not whole characters of the text: ${JSON.stringify(m.text)}`); continue; }
    taken.add(pick.i + ':' + m.text.length);
    const start = chunk.start + pick.cp;
    const kind = typeof m.kind === 'string' ? m.kind.trim().toLowerCase() : '';
    const out = { start, end: start + len, text: m.text, kind };
    if (!KINDS.includes(kind)) { note('text-kind-unknown', m.kind); out.kindGiven = String(m.kind).slice(0, 40); out.kind = 'other'; }
    mentions.push(out);
  }
  return { ok: true, mentions, counts, examples };
}

/** Counts added together: { kind: n } + { kind: m }. */
export function addCounts(into, more) {
  for (const [k, n] of Object.entries(more || {})) into[k] = (into[k] || 0) + n;
  return into;
}
