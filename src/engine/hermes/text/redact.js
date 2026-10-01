// Hermes, place names in a text: keeping a provider's key out of anything the tools say or write.
//
// A key goes to its provider in a request header and nowhere else. What comes back may hold it, or a
// part of it: OpenAI echoes the start and end of a refused key in its 401. So any text that came from
// a request or its answer (an error's message, a provider's detail) passes through redact() before it
// is shown, logged, or put on an error, and is cut short only afterwards, so that no part of a key is
// left at the cut.

const REMOVED = '[key removed]';
// Shapes of keys, whosever they are: OpenAI's and Anthropic's (sk-…, sk-ant-…, sk-proj-…), Google's
// (AIza…), and a bearer token or key header written out.
const PATTERNS = [
  /sk-[A-Za-z0-9_*.-]{4,}/g,
  /AIza[0-9A-Za-z_-]{10,}/g,
  /\b(Bearer|x-api-key:?|x-goog-api-key:?|api[_-]?key[=:]?)\s*[^\s"',;]{6,}/gi,
];
// A run of this many characters of a key, found anywhere, is taken for a piece of it.
const PIECE = 8;

/**
 * `text` with every key in `keys` removed, every run of PIECE or more of a key's characters (a key
 * echoed in part), and anything shaped like a key. Never throws; always returns a string.
 */
export function redact(text, keys = []) {
  let s = typeof text === 'string' ? text : String(text ?? '');
  const ks = [].concat(keys || []).filter((k) => typeof k === 'string' && k.length >= 4);
  for (const k of ks) s = s.split(k).join(REMOVED);
  if (ks.some((k) => k.length >= PIECE)) {
    s = s.replace(/[^\s"',;()[\]{}<>]{8,}/g, (w) => {
      for (let i = 0; i + PIECE <= w.length; i++) { const piece = w.slice(i, i + PIECE); if (ks.some((k) => k.includes(piece))) return REMOVED; }
      return w;
    });
  }
  for (const re of PATTERNS) s = s.replace(re, REMOVED);
  return s;
}

/** Cut after redacting: at most `n` characters. */
export const clip = (text, n = 200) => (text.length > n ? text.slice(0, n) + '…' : text);
