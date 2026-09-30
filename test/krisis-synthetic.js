// Krisis: synthetic place names for the tests and the scale script of matching (test/krisis.test.js,
// e2e/match_scale.mjs). Made up, and made to be awkward: half the names begin with one of a few
// common words (Saint, San, Kafr, Tell, Upper, East, …), as gazetteers' names do, so that a matcher
// that compares every name sharing a common word, or a first letter, shows it in its time. Some of
// the other dataset's names are variants of the subjects' (an accent, a doubled or dropped letter, a
// changed vowel, two letters swapped, the words reordered, Saint written St): those are the pairs a
// matcher must find. Deterministic: the same seed gives the same names.

/** A small fast random number generator (mulberry32), from 0 to 1. */
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PREFIXES = ['Saint', 'San', 'Santa', 'Sainte', 'Kafr', 'Tell', 'Tel', 'Khirbet', 'Deir', 'Beit', 'Ain', 'Wadi', 'Jebel',
  'Upper', 'Lower', 'East', 'West', 'North', 'South', 'Great', 'Little', 'Bir', 'Nahr', 'El', 'Al', 'New', 'Old', 'Fort', 'Mount', 'Port'];
const ONSETS = ['b', 'br', 'c', 'ch', 'd', 'f', 'g', 'gr', 'h', 'j', 'k', 'kh', 'l', 'm', 'n', 'p', 'r', 's', 'sh', 't', 'th', 'v', 'w', 'z', ''];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ai', 'ou', 'ea'];
const CODAS = ['', '', '', 'n', 'r', 'l', 's', 'm', 'k'];
const SUFFIXES = ['', '', '', '', 'ton', 'ham', 'ford', 'bury', 'ville', 'burg', 'heim', 'abad', 'pur', 'stan', 'ia'];

const cap = (s) => s[0].toUpperCase() + s.slice(1);
function word(r) {
  const n = 1 + Math.floor(r() * 3);
  let w = '';
  for (let i = 0; i < n; i++) w += ONSETS[Math.floor(r() * ONSETS.length)] + VOWELS[Math.floor(r() * VOWELS.length)] + CODAS[Math.floor(r() * CODAS.length)];
  w += SUFFIXES[Math.floor(r() * SUFFIXES.length)];
  return w.length < 2 ? w + 'a' : w;
}
/** One made-up place name. */
export function name(r) {
  const core = cap(word(r));
  const x = r();
  if (x < 0.5) return `${PREFIXES[Math.floor(r() * PREFIXES.length)]} ${core}`;
  if (x < 0.6) return `${core} ${cap(word(r))}`;
  return core;
}

const ACCENT = { a: 'á', e: 'é', i: 'í', o: 'ö', u: 'ü' };
/** A variant of a name as another dataset might spell it. */
export function variant(n, r) {
  const words = n.split(' '), last = words.length - 1, w = words[last];
  const pick = (from, to) => from + Math.floor(r() * Math.max(1, to - from));
  const set = (s) => { words[last] = s; return words.join(' '); };
  switch (Math.floor(r() * 8)) {
    case 0: { const i = [...w].findIndex((c, k) => k > 0 && ACCENT[c]); return i < 0 ? set(w + 'e') : set(w.slice(0, i) + ACCENT[w[i]] + w.slice(i + 1)); }
    case 1: { const i = pick(1, w.length); return set(w.slice(0, i) + w[i - 1] + w.slice(i)); }   // a letter doubled
    case 2: { if (w.length < 5) return set(w + w.at(-1)); const i = pick(1, w.length - 1); return set(w.slice(0, i) + w.slice(i + 1)); }   // a letter dropped
    case 3: { const i = [...w].findIndex((c, k) => k > 0 && 'aeiou'.includes(c)); return i < 0 ? set(w + 'a') : set(w.slice(0, i) + (w[i] === 'e' ? 'a' : 'e') + w.slice(i + 1)); }
    case 4: { if (w.length < 5) return set(w + 'h'); const i = pick(2, w.length - 2); return set(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2)); }   // two letters swapped
    case 5: return words.length > 1 ? [...words.slice(1), words[0]].join(' ') : n.toUpperCase();
    case 6: return words[0] === 'Saint' ? ['St', ...words.slice(1)].join(' ') : words.join('-');
    default: return n.toLowerCase();
  }
}

/**
 * Two lists of names: `n` subjects, and `m` others of which `planted` are variants of subjects.
 * Returns { subjects: [name], others: [name], pairs: [[subject index, other index]] }.
 */
export function syntheticNames({ n, m = n, planted = Math.floor(Math.min(n, m) / 10), seed = 1 }) {
  const r = random(seed);
  const subjects = Array.from({ length: n }, () => name(r));
  const others = [], pairs = [];
  for (let j = 0; j < m; j++) {
    if (j < planted) { const i = Math.floor(r() * n); pairs.push([i, j]); others.push(variant(subjects[i], r)); }
    else others.push(name(r));
  }
  return { subjects, others, pairs };
}
