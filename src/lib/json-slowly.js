// JSON read without holding the page. JSON.parse reads a text at once: of a review of 50,000 decisions as this browser
// keeps it (69 million characters; src/lib/review-progress.js) that held the page for 0.2 s. Here the text is read in
// steps: whatever is short (a value of at most WHOLE characters: a candidate, a place) is given to JSON.parse as it
// is, and only what is longer (the work file, its list of candidates, its places, a lookup's queries) is taken apart
// here, member by member, with a step between. What is read is what JSON.parse reads, and what JSON.parse refuses is
// refused: every value is parsed by it, and the brackets, commas and colons between them are read strictly here.
// There is no request in this file, and nothing of the page: it is the same in Node.

/** A value of at most this many characters is parsed at once. */
export const WHOLE = 65536;
const clock = () => (globalThis.performance ? globalThis.performance.now() : Date.now());
const breathe = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const QUOTE = 34, COMMA = 44, COLON = 58, OPEN_LIST = 91, BACKSLASH = 92, CLOSE_LIST = 93, OPEN_OBJECT = 123, CLOSE_OBJECT = 125;
const isSpace = (c) => c === 32 || c === 10 || c === 13 || c === 9;

/**
 * The reading of `text` as steps: a generator that yields when it has read for `budget` milliseconds since it was last
 * taken up, and returns the value. A SyntaxError where the text is not JSON. `whole`: the longest value parsed at once.
 */
export function* parseSteps(text, { budget = 8, whole = WHOLE, now = clock } = {}) {
  let since = now(), n = 0;
  const fail = (i) => { throw new SyntaxError(`This is not JSON (at character ${i}).`); };
  const space = (i) => { while (isSpace(text.charCodeAt(i))) i++; return i; };
  /** Past the string that begins at i. */
  const stringEnd = (i) => {
    for (let j = i + 1; ;) {
      j = text.indexOf('"', j);
      if (j < 0) fail(i);
      let b = j - 1;
      while (text.charCodeAt(b) === BACKSLASH) b--;
      if ((j - 1 - b) % 2 === 0) return j + 1;   // not escaped: an even number of backslashes before it
      j++;
    }
  };
  /** Past the value that begins at i; -1 for a list or an object longer than `whole` (it is taken apart, not measured). */
  const end = (i) => {
    const first = text.charCodeAt(i);
    if (first === QUOTE) return stringEnd(i);
    if (first !== OPEN_OBJECT && first !== OPEN_LIST) {
      let j = i;
      for (let c = text.charCodeAt(j); j < text.length && c !== COMMA && c !== CLOSE_LIST && c !== CLOSE_OBJECT && !isSpace(c); c = text.charCodeAt(++j));
      return j;
    }
    const limit = i + whole;
    for (let j = i, depth = 0; j < text.length;) {
      if (j > limit) return -1;
      const c = text.charCodeAt(j);
      if (c === QUOTE) { j = stringEnd(j); continue; }
      if (c === OPEN_OBJECT || c === OPEN_LIST) depth++;
      else if ((c === CLOSE_OBJECT || c === CLOSE_LIST) && --depth === 0) return j + 1;
      j++;
    }
    return fail(i);
  };
  /** The list or object that begins at i, member by member: [value, past it]. */
  function* apart(i) {
    const list = text.charCodeAt(i) === OPEN_LIST, close = list ? CLOSE_LIST : CLOSE_OBJECT, out = list ? [] : {};
    let j = space(i + 1);
    if (text.charCodeAt(j) === close) return [out, j + 1];
    for (;;) {
      let key;
      if (!list) {
        if (text.charCodeAt(j) !== QUOTE) fail(j);
        const k = stringEnd(j);
        key = JSON.parse(text.slice(j, k));
        j = space(k);
        if (text.charCodeAt(j) !== COLON) fail(j);
        j = space(j + 1);
      }
      if (j >= text.length) fail(j);
      const e = end(j);
      let v;
      if (e < 0) [v, j] = yield* apart(j);
      else { v = JSON.parse(text.slice(j, e)); j = e; }
      if (list) out.push(v);
      // As JSON.parse has it: a member named __proto__ is a member, never the object's prototype.
      else if (key === '__proto__') Object.defineProperty(out, key, { value: v, writable: true, enumerable: true, configurable: true });
      else out[key] = v;
      j = space(j);
      const c = text.charCodeAt(j);
      if (c === close) return [out, j + 1];
      if (c !== COMMA) fail(j);
      j = space(j + 1);
      if (++n % 16 === 0 && now() - since >= budget) { yield; since = now(); }
    }
  }
  if (typeof text !== 'string') fail(0);
  const i = space(0);
  if (i >= text.length) fail(i);
  const e = end(i);
  let value, j;
  if (e < 0) [value, j] = yield* apart(i);
  else { value = JSON.parse(text.slice(i, e)); j = e; }
  if (space(j) !== text.length) fail(space(j));
  return value;
}

/** `text` read as JSON.parse reads it, the page given a turn (`pause`) after every `budget` milliseconds of reading. */
export async function parseSlowly(text, { budget = 8, pause = breathe, whole = WHOLE } = {}) {
  const steps = parseSteps(text, { budget, whole });
  for (;;) {
    const s = steps.next();
    if (s.done) return s.value;
    await pause();
  }
}
