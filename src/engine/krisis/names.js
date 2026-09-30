// Krisis: how alike two place names are. Pure, and hand-written, so that the page and the command
// line score alike and nothing is added to the tools' dependencies.
//
// A name is first normalised: decomposed (NFKD), its combining marks dropped (so é is e, and
// Ōsaka is osaka), a few letters that do not decompose spelt out (ß is ss, æ is ae, ø is o, ł is l),
// lower-cased, and everything that is not a letter or a digit made a space. Two names are then
// compared by Jaro-Winkler similarity, and again with their words in alphabetical order (so that
// "Newton Upper" and "Upper Newton" agree); the higher of the two is the score, from 0 to 1.
// Trigrams of the normalised name are what matching blocks on: two names are only compared when
// they share enough of them.

const SPELT = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i', ŋ: 'ng', ħ: 'h' };

/** A name as it is compared: "Sainte-Mère-Église" becomes "sainte mere eglise". */
export function normalise(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[ßæœøłđðþıŋħ]/g, (c) => SPELT[c])
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The Jaro-Winkler similarity of two strings (already normalised), from 0 to 1. */
export function jaroWinkler(a, b) {
  if (a === b) return a.length ? 1 : 0;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const window = Math.max(0, (Math.max(la, lb) >> 1) - 1);
  const ma = new Uint8Array(la), mb = new Uint8Array(lb);
  let m = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - window), hi = Math.min(lb - 1, i + window);
    for (let j = lo; j <= hi; j++) if (!mb[j] && a[i] === b[j]) { ma[i] = mb[j] = 1; m++; break; }
  }
  if (!m) return 0;
  let t = 0;
  for (let i = 0, j = 0; i < la; i++) {
    if (!ma[i]) continue;
    while (!mb[j]) j++;
    if (a[i] !== b[j]) t++;
    j++;
  }
  const jaro = (m / la + m / lb + (m - t / 2) / m) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < la && prefix < lb && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

const sorted = (s) => s.split(' ').sort().join(' ');

/** How alike two names are, from 0 to 1: the better of Jaro-Winkler as written and with the words sorted. */
export function similarity(a, b) {
  const x = normalise(a), y = normalise(b);
  return similarityNormalised(x, y);
}
/** similarity() of names already normalised. */
export function similarityNormalised(x, y) {
  if (!x || !y) return 0;
  const plain = jaroWinkler(x, y);
  if (plain === 1 || (!x.includes(' ') && !y.includes(' '))) return plain;
  return Math.max(plain, jaroWinkler(sorted(x), sorted(y)));
}

/** The trigrams of a normalised name, padded so that its first and last letters count: "  n", " ne", …, "on ". */
export function trigrams(normalised) {
  const s = '  ' + normalised + ' ', out = new Set();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}
