// Krisis: how alike two place names are. Pure, and hand-written, so that the page and the command
// line score alike and nothing is added to the tools' dependencies.
//
// A name is first normalised: decomposed (NFKD), its combining marks dropped (so é is e, and
// Ōsaka is osaka), a few letters that do not decompose spelt out (ß is ss, æ is ae, ø is o, ł is l),
// lower-cased, and everything that is not a letter or a digit made a space. Two names are then
// compared by Jaro-Winkler similarity, and again with their words in alphabetical order (so that
// "Newton Upper" and "Upper Newton" agree); the higher of the two is the name score, from 0 to 1.
//
// Names that share a word are then held to the words they do not share (distinctive()): Jaro-Winkler
// rewards a shared beginning, so "Saint Martin" and "Saint Maurice", or "East Ham" and "West Ham",
// score over 0.9 on letters alone, though all they have in common is a word that tells nothing, or
// the difference is the whole point. The words both names have (a word also counts as shared with
// its known short form, SHORT_FORMS: St and Saint, Mt and Mount, on and upon) are set aside, and what
// is left of each name is compared. If what is left is alike (at least DISTINCT_GATE, or one letter
// added, dropped, changed or two swapped: Kafr Cal and Kafr Cel, though a word of three letters
// with one changed scores only about 0.8, so such a pair is suggested only if the words shared weigh
// enough, and not when they are common), the score is
// the shared words' share of the weight plus the rest's likeness over the remaining weight; if not,
// only the shared words' share. Words are weighted by how rare they are in the two datasets
// (inverse document frequency, given by the matcher), so a common word such as Saint or Tell
// counts for little. The score is never raised by this, only lowered. The one case that raises a
// score is two names whose words are all shared, some only as a known short form (Mt Pleasant and
// Mount Pleasant, St Zan and Saint Zan): the letters of St and Saint differ and would count against a pair
// that differs in nothing else, so such names are scored again with each short form written out in
// full, and the higher score is kept (expandedScore()).
// Trigrams of the normalised name are what matching blocks on (blocking.js).

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

/** A normalised name with its words in alphabetical order. */
export const sortWords = (s) => (s.includes(' ') ? s.split(' ').sort().join(' ') : s);

/** What the distinctive words of two names must reach for their likeness to count. */
export const DISTINCT_GATE = 0.85;

/** How alike two names are, from 0 to 1 (see the top of this file). `weight` as for similarityNormalised(). */
export function similarity(a, b, weight) {
  const x = normalise(a), y = normalise(b);
  return similarityNormalised(x, y, weight);
}
/** Jaro-Winkler of two normalised names, as written or with their words sorted (xs, ys, if known), whichever is higher. */
export function nameScore(x, y, xs = sortWords(x), ys = sortWords(y)) {
  if (!x || !y) return 0;
  const plain = jaroWinkler(x, y);
  if (plain === 1 || (xs === x && ys === y)) return plain;
  return Math.max(plain, jaroWinkler(xs, ys));
}
/**
 * similarity() of names already normalised: nameScore(), lowered by distinctive() when the names
 * share a word. `weight(word)` is how much a word counts (the matcher gives its inverse document
 * frequency in the two datasets); by default every word counts alike.
 */
export function similarityNormalised(x, y, weight) {
  const base = nameScore(x, y);
  if (base === 0 || base === 1) return base;
  const e = expandedScore(x, y);
  if (e !== null) return Math.max(base, e);
  const d = distinctive(x, y, weight);
  return d === null ? base : Math.min(base, d);
}

/**
 * The known short forms, and only these: St and Saint, Ste and Sainte, Mt and Mount, Ft and Fort, Pt
 * and Port, on and upon. A word counts as shared with its short form, and names alike but for them
 * are scored with them written out (expandedScore()). Until krisis-names 4 any contraction counted
 * (letters in order, ending alike): that scored Dry Hill as Danebury Hill, Great Bow as Great Baddow
 * and By Park as Cornbury Park at 1.
 */
export const SHORT_FORMS = new Map([['st', 'saint'], ['ste', 'sainte'], ['mt', 'mount'], ['ft', 'fort'], ['pt', 'port'], ['on', 'upon']]);
const sameWord = (a, b) => a === b || SHORT_FORMS.get(a) === b || SHORT_FORMS.get(b) === a;

/**
 * The words two normalised names share, and those left of each: `shared` (a word and its short form
 * counted once, as the long form), `restX`, `restY`, and `long`, the long form of each short form used.
 */
function alignWords(wx, wy) {
  const restY = [...wy], restX = [], shared = [], long = new Map();
  for (const w of wx) { const i = restY.indexOf(w); if (i >= 0) { shared.push(w); restY.splice(i, 1); } else restX.push(w); }
  for (let k = restX.length - 1; k >= 0; k--) {
    const i = restY.findIndex((v) => sameWord(restX[k], v));
    if (i >= 0) {
      const [a, b] = restX[k].length > restY[i].length ? [restY[i], restX[k]] : [restX[k], restY[i]];
      shared.push(b); long.set(a, b); restY.splice(i, 1); restX.splice(k, 1);
    }
  }
  return { shared, restX, restY, long };
}

/**
 * When every word of two normalised names is shared, some only as a known short form (St Zan and
 * Saint Zan, Mt Pleasant and Mount Pleasant: SHORT_FORMS, so not Dry for Danebury or Cal for Carl),
 * the name score of the two with each short form written out in full; otherwise null. The letters of "St" and "Saint" differ, and would otherwise count against
 * the pair; so this is the one case where the score is raised (the higher of this and the name score).
 */
export function expandedScore(x, y) {
  if (!x.includes(' ') && !y.includes(' ')) return null;
  if (Math.abs(x.length - y.length) < 2) return null; // each short form is at least two letters shorter than its word
  const wx = x.split(' '), wy = y.split(' ');
  if (wx.length !== wy.length) return null;
  const { restX, restY, long } = alignWords(wx, wy);
  if (restX.length || restY.length || !long.size) return null;
  const full = (ws) => ws.map((w) => long.get(w) ?? w).join(' ');
  return nameScore(full(wx), full(wy));
}

/**
 * The score of two normalised names on their distinctive words, or null when it does not apply
 * (they share no word, or every word of one of them is shared). See the top of this file.
 */
export function distinctive(x, y, weight = () => 1) {
  const wx = x.split(' '), wy = y.split(' ');
  if (wx.length < 2 && wy.length < 2) return null;
  const { shared, restX, restY } = alignWords(wx, wy);
  if (!shared.length || !restX.length || !restY.length) return null;
  const sum = (ws) => ws.reduce((n, w) => n + weight(w), 0);
  const s = sum(shared), share = s / (s + sum(restX) + sum(restY));
  const a = restX.join(' '), b = restY.join(' '), rest = nameScore(a, b);
  return rest >= DISTINCT_GATE || oneEdit(a, b) ? share + (1 - share) * rest : share;
}

/** Whether two strings are one edit apart: a letter added, dropped or changed, or two next to each other swapped. */
export function oneEdit(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** The trigrams of a normalised name, padded so that its first and last letters count: "  n", " ne", …, "on ". */
export function trigrams(normalised) {
  const s = '  ' + normalised + ' ', out = new Set();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}
