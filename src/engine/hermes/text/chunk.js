// Hermes, place names in a text: cutting a text into chunks a language model is sent one at a time.
//
// A chunk ends at a paragraph break where it can, else at the end of a sentence, else after a space,
// and only failing all three at its greatest length (never between the two halves of a surrogate
// pair). Each chunk after the first begins up to `overlap` characters before the one before it ended,
// at the start of a sentence (else of a word) inside that stretch, so that a name cut by one chunk's
// end is whole in the next. A mention found twice in the overlap is kept once: by its absolute span
// (dedupeMentions).
//
// Offsets. Every position the tools record (a chunk's `start` and `end`, a mention's) counts Unicode
// code points of the decoded text from 0, as W3C's TextPositionSelector counts, `end` being the
// position after the last character. JavaScript's own string indices count UTF-16 units, which differ
// from code points after any character outside the Basic Multilingual Plane; those are used only
// inside this module (a chunk's `from` and `to`), and never written anywhere.
import { sha256 } from '../../../lib/sha256.js';

/** The chunking used unless a work file says otherwise. Lengths are in UTF-16 units of the text. */
export const CHUNKING = Object.freeze({ target: 8000, overlap: 300 });

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

/** The number of code points in a string. */
export function cpLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) { n++; if (isHigh(s.charCodeAt(i)) && isLow(s.charCodeAt(i + 1))) i++; }
  return n;
}

/** The UTF-16 index of code point `cp` in `s` (s.length if it is the end, -1 if beyond it). */
export function cpToIndex(s, cp) {
  let i = 0;
  for (let n = 0; n < cp; n++) {
    if (i >= s.length) return -1;
    i += isHigh(s.charCodeAt(i)) && isLow(s.charCodeAt(i + 1)) ? 2 : 1;
  }
  return i <= s.length ? i : -1;
}

/** The characters of `text` from code point `start` to `end` (end not included), or null if that is not a span of it. */
export function sliceCodePoints(text, start, end) {
  if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start)) return null;
  const a = cpToIndex(text, start);
  if (a < 0) return null;
  const b = cpToIndex(text.slice(a), end - start);
  return b < 0 ? null : text.slice(a, a + b);
}

// Never cut between the two halves of a surrogate pair: move back by one.
const whole = (s, i) => (i > 0 && i < s.length && isLow(s.charCodeAt(i)) && isHigh(s.charCodeAt(i - 1)) ? i - 1 : i);

// Where a chunk may end, best first: after a blank line, after the end of a sentence (and the space
// after it), after a space.
const PARAGRAPH = /\n[ \t\r\f\v]*\n\s*/g;
const SENTENCE = /[.!?…。！？;:][)\]"'’”»]*\s+/g;
const SPACE = /\s+/g;

function lastEnd(re, text, lo, hi) {
  re.lastIndex = 0;
  const part = text.slice(lo, hi);
  let at = -1, m;
  while ((m = re.exec(part))) { const e = m.index + m[0].length; if (e > 0) at = lo + e; if (m[0].length === 0) re.lastIndex++; }
  return at;
}
function firstEnd(re, text, lo, hi) {
  re.lastIndex = 0;
  const m = re.exec(text.slice(lo, hi));
  return m ? lo + m.index + m[0].length : -1;
}

/**
 * Where to cut `text` between UTF-16 positions lo and hi (both possible): the last paragraph break,
 * else sentence end, else space, in that stretch; else hi itself (moved off a surrogate pair).
 */
export function breakBetween(text, lo, hi) {
  for (const re of [PARAGRAPH, SENTENCE, SPACE]) { const at = lastEnd(re, text, lo, hi); if (at > lo && at <= hi) return at; }
  const at = whole(text, hi);
  return at > lo ? at : hi;
}

/**
 * The chunks of `text`: [{ index, start, end, text, sha256, from, to }], `start` and `end` in code points
 * of the whole text, `from` and `to` its UTF-16 indices (not to be recorded), `sha256` of the chunk's
 * text. An empty text has none.
 */
export function chunkText(text, { target = CHUNKING.target, overlap = CHUNKING.overlap } = {}) {
  if (typeof text !== 'string') throw new TypeError('chunkText: the text must be a string.');
  if (!(Number.isInteger(target) && target >= 200)) throw new RangeError('chunkText: target must be a whole number of at least 200 characters.');
  if (!(Number.isInteger(overlap) && overlap >= 0 && overlap <= target / 4)) throw new RangeError('chunkText: overlap must be a whole number from 0 to a quarter of the target.');
  const out = [];
  // Code points counted so far, up to UTF-16 position `at`: chunks begin in order, so counting goes forward only.
  let at = 0, cps = 0;
  const cpAt = (pos) => { cps += cpLength(text.slice(at, pos)); at = pos; return cps; };
  let s = 0;
  while (s < text.length) {
    const e = text.length - s <= target ? text.length : breakBetween(text, s + Math.floor(target / 2), s + target);
    const body = text.slice(s, e), start = cpAt(s);
    out.push({ index: out.length, start, end: start + cpLength(body), text: body, sha256: sha256(body), from: s, to: e });
    if (e >= text.length) break;
    let next = e;
    if (overlap > 0) {
      const lo = Math.max(s + 1, e - overlap);
      const found = [SENTENCE, SPACE].map((re) => firstEnd(re, text, lo, e)).find((x) => x > lo - 1 && x < e);
      next = found ?? whole(text, lo);
    }
    s = next > s ? next : e;
  }
  return out;
}

/**
 * A text cut in two near its middle, at the best break there (as chunkText cuts): for a chunk whose
 * reply was cut off. Returns the two parts as chunks (`start` in code points of the whole text), or
 * null when it is too short to cut.
 */
export function halve(chunk, { min = 200 } = {}) {
  const t = chunk.text;
  if (t.length < 2 * min) return null;
  const mid = Math.floor(t.length / 2);
  const cut = breakBetween(t, Math.max(1, mid - Math.floor(mid / 2)), mid + Math.floor(mid / 2));
  if (!(cut > 0 && cut < t.length)) return null;
  const a = t.slice(0, cut), b = t.slice(cut), aEnd = chunk.start + cpLength(a);
  return [
    { ...chunk, start: chunk.start, end: aEnd, text: a, sha256: sha256(a), part: true },
    { ...chunk, start: aEnd, end: chunk.end, text: b, sha256: sha256(b), part: true },
  ];
}

/**
 * Mentions (each with absolute `start` and `end`) with every repeat of a span left out: the first of
 * each span is kept. Returns { kept, repeated } (the number left out).
 */
export function dedupeMentions(mentions) {
  const seen = new Set(), kept = [];
  let repeated = 0;
  for (const m of mentions) {
    const k = m.start + ':' + m.end;
    if (seen.has(k)) { repeated++; continue; }
    seen.add(k); kept.push(m);
  }
  return { kept, repeated };
}
