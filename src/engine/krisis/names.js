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
//
// A name may differ from another only by QUALIFIERS (qualifierScore(), new in krisis-names 6, the
// lists chosen per language in krisis-names 7): Chipping Ongar and Ongar, Market Warsop and Warsop,
// Abingdon and Abingdon-on-Thames. Letters score these low when the qualifier is in front (Chipping
// Ongar and Ongar 0.514), and the distinctive words cannot help, as all the words of one are shared.
// A qualifier is a word or phrase on one of the lists chosen (qualifiers.js; by default the measured
// English, Welsh and Latin list: Chipping and Market in front, Regis
// behind, and "on", "upon", "under", "next", "juxta" or "super" and a river or short phrase at the
// end): only words that RARELY mark a separate place, so not Old (Old Windsor is not Windsor), Long,
// High, Great or Little (Great and Little Marlow are two places). When one name is the other's core
// with qualifiers added, and the other's qualifiers are all among them (Ongar, or Chipping Ongar
// against Chipping Ongar on Roding), the pair scores QUALIFIER_CAP (0.88), unless letters alone
// score it higher: the rule only ever raises a score, never lowers one (Abingdon and
// Abingdon-on-Thames keep their 0.889), so a pair letters would find is found with qualifiers on too.
// The rule itself raises no further than the cap: a qualifier is still a difference. The cores must be the same (score 1: the same words, but for their order or a short
// form): in a trial on real data, a core respelt raised only wrong pairs (Bradfield and Great
// Bardfield, near 0.85 as 0.88 times their cores' 0.966). A pair whose cores differ keeps the score
// as above. When each name has a qualifier the other has not (Chipping Ongar
// and Market Ongar), this does not apply, and they score as above, low. And a
// common core is not evidence of a place: when a qualifier word added (a phrase counted by its
// joining word) weighs more than the core's words, the rule does not raise the pair, which keeps the
// score letters give it: in a gazetteer where Farm is in more names than Market, Market Farm is not
// raised to Farm. It never lowers one either: until the held-out check of 10 October 2026 the pair
// scored the core's share of the weight if lower, and lost real pairs that letters find (Newton and
// Newton Regis, 0.9; Sutton and Sutton-under-Brailes). A core whose words are in no more names than
// rareNames(N) (the larger of QUALIFIER_RARE, 5, and QUALIFIER_RARE_SHARE, 0.1%, of the N distinct
// names) is never common: in a small dataset Market is rare too.
// Trigrams of the normalised name are what matching blocks on (blocking.js).

import { QUALIFIER_LISTS, DEFAULT_QUALIFIER_LISTS, qualifierIds } from './qualifiers.js';

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

/**
 * How alike two names are, from 0 to 1 (see the top of this file). `weight` and `Q` as for
 * similarityNormalised(): by default letters only, no qualifier lists, as before krisis-names 6.
 */
export function similarity(a, b, weight, Q) {
  const x = normalise(a), y = normalise(b);
  return similarityNormalised(x, y, weight, Q);
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
 * frequency in the two datasets); by default every word counts alike. `Q`: the lists of qualifiers
 * in use (compileQualifiers()); by default NONE, letters only, so that a caller that chose no lists
 * (the WHG lookup's ranking, `--qualifiers none`) never gets the rule by accident. Matching passes
 * the lists chosen.
 */
export function similarityNormalised(x, y, weight, Q = compileQualifiers([])) {
  return scored(x, y, weight, qualifiers(x, Q), qualifiers(y, Q)).score;
}
/**
 * How two normalised names score: the one implementation, which similarityNormalised() and matching
 * (blocking.js, NameIndex.best()) both call. `qx`, `qy`: the names' qualifiers() by the lists in use;
 * `xs`, `ys`: the names with their words sorted, if known. Letters (nameScore()), raised by short
 * forms written out (expandedScore()), else lowered by the distinctive words (distinctive()); then
 * raised by the qualifier rule (qualifierScore()), to QUALIFIER_CAP at most. The rule only ever raises
 * a score: a pair letters alone score higher keeps that score, and a pair whose core is common is not
 * raised, never lowered (Newton and Newton Regis keep their 0.9). `threshold`: the shortcut matching
 * takes, not working out the lowering by the distinctive words of a pair already under it (lowering
 * cannot raise it); so a score under `threshold` is only an upper bound, and with 0 it is exact.
 * Returns { score, by, common }: `by`, when only the rule took the pair to `threshold`, { added: the
 * labels of the qualifiers that made the difference }; `common`, when the rule declined a common core.
 */
export function scored(x, y, weight, qx, qy, threshold = 0, xs = sortWords(x), ys = sortWords(y)) {
  const base = nameScore(x, y, xs, ys);
  if (base === 1) return { score: 1, by: null, common: false };
  let plain = base;
  const e = base === 0 ? null : expandedScore(x, y);
  if (e !== null) plain = Math.max(base, e);
  else if (base > 0 && base >= threshold) { const d = distinctive(x, y, weight); if (d !== null && d < plain) plain = d; }
  const q = qx.units.length || qy.units.length ? qualifierScore(x, y, weight, qx, qy) : null;
  if (q === null || q.common) return { score: plain, by: null, common: !!q?.common };
  const raised = Math.min(QUALIFIER_CAP, q.score);
  return { score: Math.max(plain, raised), by: plain < threshold && raised >= threshold ? { added: q.added } : null, common: false };
}
/** similarityNormalised() but for qualifiers: the name score, raised by short forms or lowered by the distinctive words. */
function plainScore(x, y, weight) {
  const base = nameScore(x, y);
  if (base === 0 || base === 1) return base;
  const e = expandedScore(x, y);
  if (e !== null) return Math.max(base, e);
  const d = distinctive(x, y, weight);
  return d === null ? base : Math.min(base, d);
}

/** What a pair of names that differ only by a qualifier scores, and the most a pair that differs by one can. */
export const QUALIFIER_CAP = 0.88;
/**
 * A core whose words are in no more than rareNames(N) of the N distinct names of both datasets is never
 * too common to stand for a place (the matcher gives its weight as `weight.rare`): in a small dataset a
 * qualifier is rare too, and Market, in one name, would outweigh Ongar, in two. The bound grows with N:
 * a fixed 50 (until 10 October 2026) made every core rare in a dataset of a few hundred names, so that
 * Market Farm was raised to Farm with Farm in 31 of 120. 0.1% of N is 50 at about the size of the
 * held-out pair the rule was measured on (Index Villaris and Wikidata, 56,585 names: 57), and the floor
 * of 5 keeps Chipping Ongar and Ongar (Ongar in two names) in a small one.
 */
export const QUALIFIER_RARE = 5;
export const QUALIFIER_RARE_SHARE = 0.001;
export const rareNames = (N) => Math.max(QUALIFIER_RARE, QUALIFIER_RARE_SHARE * N);

const compiled = new Map();
/**
 * The lists of qualifiers of `ids` (qualifiers.js; by default DEFAULT_QUALIFIER_LISTS, the measured
 * English, Welsh and Latin list), made ready for qualifiers(): { ids, front: [[normalised words], …]
 * longest first, back: Set, phrases: [RegExp], same, words: Set (every word in front or behind),
 * label: Map (normalised → as the list writes it), none }. A DataError for an id that is not a list's.
 */
export function compileQualifiers(ids = DEFAULT_QUALIFIER_LISTS) {
  const key = ids.join(',');
  let q = compiled.get(key);
  if (q) return q;
  const lists = qualifierIds(ids).map((id) => QUALIFIER_LISTS.find((l) => l.id === id));
  const label = new Map(), front = [], back = new Set(), words = new Set(), phrases = [], same = {};
  for (const l of lists) {
    for (const f of l.front) { const n = normalise(f); label.set(n, f); front.push(n.split(' ')); for (const w of n.split(' ')) words.add(w); }
    for (const b of l.behind) { const n = normalise(b); label.set(n, b); back.add(n); words.add(n); }
    for (const p of l.phrases) phrases.push(new RegExp(p, 'u'));
    Object.assign(same, l.same);
  }
  front.sort((a, b) => b.length - a.length);
  q = Object.freeze({ ids: lists.map((l) => l.id), front, back, phrases, same, words, label, none: !front.length && !back.size && !phrases.length });
  compiled.set(key, q);
  return q;
}
const NONE = Object.freeze({ units: Object.freeze([]) });

/**
 * A normalised name's qualifiers and its core, by the lists `Q` (compileQualifiers()): { core (words),
 * units (each qualifier, as its usual spelling: "chipping", "on thames"), words (for each unit, the
 * words that weigh: a phrase by its joining word), labels (each unit as the list writes it, or a
 * phrase as normalised: "Chipping", "upon avon") }, or { units: [] } when it has none. The core keeps
 * at least one word that is not a qualifier, so a name with none ("Market") has no qualifiers.
 */
export function qualifiers(x, Q = compileQualifiers()) {
  if (Q.none) return NONE;
  const w = x.split(' ');
  if (w.length < 2) return NONE;
  const units = [], words = [], labels = [];
  let lo = 0, hi = w.length;
  const coreLeft = (a, b) => { for (let k = a; k < b; k++) if (!Q.words.has(w[k])) return true; return false; };
  // In front: the longest qualifier that leaves a core, again and again.
  for (let more = true; more;) {
    more = false;
    for (const q of Q.front) {
      if (lo + q.length < hi && q.every((v, k) => w[lo + k] === v) && coreLeft(lo + q.length, hi)) {
        const n = q.join(' ');
        units.push(n); words.push(n); labels.push(Q.label.get(n) ?? n); lo += q.length; more = true; break;
      }
    }
  }
  // At the end: a phrase (the first of the lists' to match what is left whole and leave a core), then words behind.
  if (Q.phrases.length && hi - lo > 1) {
    const rest = w.slice(lo, hi).join(' ');
    for (const re of Q.phrases) {
      const g = re.exec(rest)?.groups;
      if (!g || !g.core || !g.join || !g.tail) continue;
      const k = lo + g.core.split(' ').length;
      if (!coreLeft(lo, k)) continue;
      units.push((Q.same[g.join] ?? g.join) + ' ' + g.tail); words.push(g.join); labels.push(g.join + ' ' + g.tail); hi = k;
      break;
    }
  }
  while (hi - lo > 1 && Q.back.has(w[hi - 1]) && coreLeft(lo, hi - 1)) { units.push(w[hi - 1]); words.push(w[hi - 1]); labels.push(Q.label.get(w[hi - 1]) ?? w[hi - 1]); hi--; }
  return units.length ? { core: w.slice(lo, hi).join(' '), units, words, labels } : NONE;
}

/**
 * How two normalised names that differ by qualifiers score (see the top of this file): { score:
 * QUALIFIER_CAP when their cores are the same, else 0, common: false, added: the labels of the
 * qualifiers one has and the other has not }, the higher of which and the score without it is kept
 * (the rule only raises); or, when a qualifier word added weighs more than the core, { score: the core's
 * share of the weight, common: true }, when the rule does not raise the pair at all; or null when it does not apply
 * (neither has a qualifier the other has not, or each has one the other has not). `weight` as for
 * similarityNormalised(); `qx`, `qy`, the names' qualifiers() (by default, by the default lists).
 */
export function qualifierScore(x, y, weight = () => 1, qx = qualifiers(x), qy = qualifiers(y)) {
  if (!qx.units.length && !qy.units.length) return null;
  const xAdds = qx.units.filter((u) => !qy.units.includes(u)), yAdds = qy.units.filter((u) => !qx.units.includes(u));
  if (xAdds.length && yAdds.length) return null; // Chipping and Market: each has its own
  if (!xAdds.length && !yAdds.length) return null; // the same qualifiers: scored as any other names
  const [more, fewer] = xAdds.length ? [qx, qy] : [qy, qx];
  const fewerCore = fewer.units.length ? fewer.core : (more === qx ? y : x);
  // The core of the name with fewer qualifiers must weigh at least as much as each qualifier word
  // added, unless it is rare in itself (weight.rare: the weight of a word in rareNames(N) names).
  let coreWeight = 0, addedWeight = 0, common = false;
  const added = [];
  for (const v of fewerCore.split(' ')) coreWeight += weight(v);
  for (let i = 0; i < more.units.length; i++) {
    if (fewer.units.includes(more.units[i])) continue;
    added.push(more.labels[i]);
    for (const v of more.words[i].split(' ')) { const wv = weight(v); addedWeight += wv; if (wv > coreWeight) common = true; }
  }
  if (common && coreWeight >= (weight.rare ?? Infinity)) common = false;
  if (common) return { score: coreWeight / (coreWeight + addedWeight), common };
  return { score: more.core === fewerCore || plainScore(more.core, fewerCore, weight) === 1 ? QUALIFIER_CAP : 0, common, added };
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

// ---- Krisis × Methodos (#28): query variants -----------------------------------------------------------
// Forms of a name to send a gazetteer, each as a query of its own, opt-in (the lookup's `variants`). WHG's
// gateway already derives forms of its own (head word, inversion, brackets: derived_forms in its answer);
// these are the client's, as WHG's own client sends them, and nothing is de-duplicated against the
// gateway's. A candidate found only by the head word never passes WHG's guards (guards.js).
/** The words after a comma that are put back in front ("Melford, Long" → "Long Melford"); any other is not ("Rotherhithe, Surrey"). */
export const INVERSION_QUALIFIERS = ['long', 'great', 'little', 'upper', 'lower', 'nether', 'old', 'new', 'north', 'south', 'east', 'west',
  'north east', 'north west', 'south east', 'south west', 'market', 'saint', 'st', 'st.', 'sainte', 'ste', 'ste.', 'much', 'high', 'low', 'middle', 'over', 'church', 'king\'s', 'kings', 'bishop\'s', 'bishops'];
/** The qualifiers a head word is found by dropping (not Saint, which is part of a name: St Albans is not "Albans"). */
const HEAD_QUALIFIERS = new Set(['long', 'great', 'little', 'upper', 'lower', 'nether', 'old', 'new', 'north', 'south', 'east', 'west', 'market', 'much', 'high', 'low', 'middle', 'over']);
export const MAX_VARIANTS = 10;
const squash = (s) => s.replace(/\s+/g, ' ').replace(/ ,/g, ',').trim();
/**
 * A name's forms to send, the name itself first: [{ text, how }], how 'given' | 'brackets' (brackets
 * and what is in them removed) | 'alternative' ("X, or Y" and "X or Y": each) | 'inverted' ("Melford,
 * Long" → "Long Melford", only for a qualifier in INVERSION_QUALIFIERS) | 'head-word' (the name
 * without its qualifiers, last). Each text once (ignoring case), at most MAX_VARIANTS.
 */
export function queryVariants(name) {
  const given = squash(String(name ?? ''));
  if (!given) return [];
  const out = [], seen = new Set();
  const add = (text, how) => { const t = squash(text); const k = t.toLowerCase(); if (t && !seen.has(k)) { seen.add(k); out.push({ text: t, how }); } };
  add(given, 'given');
  const unbracketed = squash(given.replace(/\s*[([{][^()[\]{}]*[)\]}]\s*/g, ' '));
  if (unbracketed !== given) add(unbracketed, 'brackets');
  const alternatives = unbracketed.split(/\s*,?\s+or\s+/).map(squash).filter(Boolean);
  if (alternatives.length > 1) for (const a of alternatives) add(a, 'alternative');
  const forms = alternatives.length > 1 ? alternatives : [unbracketed];
  const inverted = [];
  for (const f of forms) {
    const m = /^([^,]+),\s*([^,]+)$/.exec(f);
    if (m && INVERSION_QUALIFIERS.includes(m[2].trim().toLowerCase())) { const t = `${m[2].trim()} ${m[1].trim()}`; inverted.push(t); add(t, 'inverted'); }
  }
  // The head word, last: each form without its leading or trailing qualifiers, when that leaves a word.
  for (const f of [...forms.map((f) => (/,/.test(f) ? null : f)).filter(Boolean), ...inverted]) {
    const words = f.split(' ');
    let i = 0, j = words.length;
    while (i < j - 1 && HEAD_QUALIFIERS.has(words[i].toLowerCase())) i++;
    while (j - 1 > i && HEAD_QUALIFIERS.has(words[j - 1].toLowerCase())) j--;
    if (i > 0 || j < words.length) add(words.slice(i, j).join(' '), 'head-word');
  }
  return out.slice(0, MAX_VARIANTS);
}
