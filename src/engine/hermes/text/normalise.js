// Hermes, place names in a text: the text as a model is sent it, and a map back to the text as given
// (Stephen's decision of 30 October 2026, Q7 B).
//
// A model answers in composed characters (NFC) and with line feeds. A file may be decomposed (NFD:
// macOS, some OCR, much polytonic Greek) and have CRLF line ends. Matching "Ἀθήναις" against the same
// word in NFD fails character for character, and normalising the text for good would make every
// offset the tools record wrong for the file the user has. So the model is sent the composed text, a
// name is matched in it, and its span is mapped back to the characters of the text AS GIVEN: offsets
// stay code points of that text, as W3C's TextPositionSelector counts, and what the locator points at
// is the name, in the form the file has it. NFKC is never used: it would change the characters.
//
// The text is cut into segments, each a character with the marks that follow it (a starter and its
// non-starters, or a CR LF); a segment is normalised by itself, and a span can be mapped only if it
// begins and ends between segments. A name that begins or ends inside a composed character (the
// "x" of x + combining acute, which has no composed form) is not a span, and is refused by the reader.
// The segments are checked: put together they must be exactly what NFC gives the whole text with its
// CRLF made LF; if they are not, the whole text is one segment (`coarse`), and only a span of all of
// it maps, so nothing is ever mapped wrongly.

// A code point that goes with the one before it: a mark (combining marks, spacing or not), the vowel
// and final jamo of a Hangul syllable written as conjoining jamo, and the LF of a CR LF.
const MARK = /^\p{M}$/u;
const JAMO_TAIL = /^[\u1161-\u11ff\ud7b0-\ud7ff]$/;
const JOINERS = /[\p{M}\u1161-\u11ff\ud7b0-\ud7ff]/u;
export const continues = (cp, prev) => MARK.test(cp) || JAMO_TAIL.test(cp) || (cp === '\n' && prev === '\r');

const fold = (segment) => (segment === '\r\n' ? '\n' : segment.normalize('NFC'));

/**
 * The text as a model is sent it, with a map back: { text, identity, coarse?, toOriginal(a, b) }.
 * `text` is the composed text with CRLF made LF; `identity` is true when that is the text as it was
 * (then every span maps as it is: it has no combining mark or jamo, which a name could end inside); `toOriginal(a, b)` takes a span of `text` in code points and gives
 * the span of the text as given, [start, end], or null when the span begins or ends inside a
 * character. `continues` (for tests) is the rule that joins a code point to the one before it.
 */
export function normalised(given, { continues: joins = continues } = {}) {
  const folded = given.replace(/\r\n/g, '\n').normalize('NFC');
  // Nothing to compose or fold, and no mark or jamo that could join a character: every span is a span.
  if (folded === given && !JOINERS.test(given)) return { text: given, identity: true, toOriginal: (a, b) => (b > a && a >= 0 ? [a, b] : null) };
  const cps = Array.from(given);
  const segments = [];
  for (let i = 0; i < cps.length; i++) {
    if (i && joins(cps[i], cps[i - 1])) segments[segments.length - 1] += cps[i];
    else segments.push(cps[i]);
  }
  let parts = segments.map(fold);
  let coarse = false;
  if (parts.join('') !== folded) { parts = [folded]; segments.splice(0, segments.length, given); coarse = true; }
  // Where each segment begins and ends, in code points of the text as given and of the composed text.
  const fromStart = new Map(), toEnd = new Map();
  let o = 0, n = 0;
  segments.forEach((s, k) => {
    const oLen = Array.from(s).length, nLen = Array.from(parts[k]).length;
    fromStart.set(n, o);
    toEnd.set(n + nLen, o + oLen);
    o += oLen; n += nLen;
  });
  return {
    text: folded, identity: false, ...(coarse ? { coarse } : {}),
    toOriginal(a, b) {
      if (!(b > a) || !fromStart.has(a) || !toEnd.has(b)) return null;
      return [fromStart.get(a), toEnd.get(b)];
    },
  };
}

/**
 * A chunk as the model is sent it: the chunk itself when its text is already composed with line feeds,
 * else the same chunk with `text` the composed text, `given` the text as given and `map` the way back.
 */
export function forModel(chunk) {
  const n = normalised(chunk.text);
  return n.identity ? chunk : { ...chunk, text: n.text, given: chunk.text, map: n };
}
