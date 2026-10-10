// Krisis: which names to compare (blocking). Comparing every name of one dataset with every name of
// the other grows with the product of the two, so the other dataset's names are indexed by their
// trigrams, and a subject's name is compared only with the names found through its RARE trigrams.
//
// A trigram is common when more than BLOCKING.commonShare of the other dataset's names have it (1%),
// and more than BLOCKING.commonFloor (50), so that a small dataset has no common trigrams at all.
// The padded trigrams of a first letter ("  s", " sa") and those of a common word (Saint, San, Kafr,
// Tell) are common in any large gazetteer, and the list of the names that have one is a good part of
// the dataset: those lists are not read. A name is looked up by its trigrams that are not common or,
// when it has fewer than BLOCKING.keys (4) of those, by its rarest trigrams up to that many, so that
// a short name made only of common trigrams ("Ur") is still looked up, and a variant that changes
// the one rare part of a name ("Kaiburg", "Kaiubrg") is still found through the next rarest.
// The keys are spread over the name: one letter changed, added or dropped, or two swapped, breaks
// the trigrams beginning at no more than BLOCKING.spread (4) places in a row, and a name's rarest
// trigrams often all fall in its one unusual stretch ("great shunia": uni, hun, nia, shu; "Great
// Shnuia" has none of them). So when the keys all begin within that many places, the rarest trigram
// beginning further off is added, if it is in no more than BLOCKING.far (10) times as many names as
// make a trigram common (a tenth of a large dataset): in "San Xyz" the only trigram beginning further
// off may be "an ", and when every name is San or Kafr and three letters, adding it compared every
// name with all of them (20,000 with 20,000 did not finish in ten minutes). The bound is 10 and not 5
// because at 5 "Granabad" loses "Grnaabad", whose far keys ("  g", " gr", "aba") are in 6 to 7 times as many.
//
// A name found so is compared when the two share at least BLOCKING.share (40%) of the trigrams of
// the one with fewer, counting all of them, and at least one, or when they begin with the same three
// letters (and so share at least three trigrams), which Jaro-Winkler rewards ("Bruxelles" and
// "Brussels" share 3 of 9); a name exactly the same as the subject's is always compared. (The share
// was 30%: in the scale test, 40% makes a third fewer comparisons of 20,000 names with 20,000, and
// loses one planted variant more, Chapu and Chpau, which share only their first two letters.) So the
// names read for each name are at most 1% of the other dataset for each trigram it is looked up by (a
// name made only of common trigrams reads its four rarest lists, and one more when they fall
// together), where before, every name that shared a first letter or a common word was read.
//
// Names that may differ only by qualifiers (names.js, qualifierScore(): Ongar and Chipping Ongar),
// by the lists of qualifiers chosen (the index's `Q`).
// A subject name finds an other name that is it with qualifiers added through its keys as they are:
// Market Warsop has every trigram of "warsop" but its first, padded one ("  w", common in any large
// dataset, so a key only when the name has no more than four trigrams, and then one of four). The
// other way round it may not: Chipping Ongar may be looked up only by trigrams of "chipping" and
// "g o", when those of "ongar" are common, and miss Ongar. So a subject name with qualifiers is
// looked up by its core too, which finds a name the same as the core (always compared) and those
// alike to it. canReach() bounds the name score, not the score of the cores, so names of which either
// has qualifiers are compared when their cores' lengths can reach the threshold over QUALIFIER_CAP
// (the cores must score that much), if the threshold is at most QUALIFIER_CAP.
//
// Scoring is names.js's, and each word is weighted by its inverse document frequency in the names of
// both datasets, ln(1 + N / df), so that a common word counts for little.
import { normalise, sortWords, trigrams, qualifiers, scored, compileQualifiers, QUALIFIER_CAP, QUALIFIER_RARE } from './names.js';

export const BLOCKING = { share: 0.4, commonShare: 0.01, commonFloor: 50, keys: 4, spread: 4, far: 10 };
export const BLOCKING_RULE = 'The names of the other dataset are indexed by their trigrams (normalised, padded with two spaces before and one after). '
  + `A trigram is common when more than ${BLOCKING.commonShare * 100}% of the other dataset's names have it, and more than ${BLOCKING.commonFloor}. `
  + `A name is looked up by its trigrams that are not common (or, with fewer than ${BLOCKING.keys} of those, by its ${BLOCKING.keys} rarest), `
  + `and, when those keys all begin within ${BLOCKING.spread} places of each other, by the rarest trigram beginning further off too, unless more than ${BLOCKING.far} times as many names as make a trigram common have it; `
  + `each name found is compared if it shares at least ${BLOCKING.share * 100}% of the trigrams of the one with fewer (and at least one), or begins with the same three letters; `
  + 'a name that is exactly the same is always compared; '
  + 'a name with qualifiers is looked up by its core (the name without them) as well as by itself, and names of which either has qualifiers are let through by their cores\' lengths as well as their own.';

/** The index of the other dataset's names; `best(names)` scores a subject place against it. */
export class NameIndex {
  /**
   * `places`: for each other place, its names (as written). `subjectPlaces`: the subjects' names,
   * counted with the others' for the words' weights. `Q`: the lists of qualifiers in use
   * (names.js, compileQualifiers(); by default, the measured English, Welsh and Latin list).
   */
  constructor(places, subjectPlaces = [], Q = compileQualifiers()) {
    this.Q = Q;
    this.ids = new Map();        // trigram → number
    this.names = [];             // { pi, n, t: sorted trigram numbers }
    this.postings = [];          // trigram number → [name number]
    this.exact = new Map();      // normalised name → [name number]
    this.comparisons = 0;
    places.forEach((names, pi) => {
      for (const n of new Set(names.map(normalise))) {
        if (!n) continue;
        const ni = this.names.length, t = [];
        for (const g of trigrams(n)) {
          let id = this.ids.get(g);
          if (id === undefined) { id = this.postings.length; this.ids.set(g, id); this.postings.push([]); }
          this.postings[id].push(ni);
          t.push(id);
        }
        const q = qualifiers(n, Q);
        this.names.push({ pi, n, t: Int32Array.from(t), sorted: sortWords(n), words: n.split(' ').length, q });
        (this.exact.get(n) || this.exact.set(n, []).get(n)).push(ni);
      }
    });
    this.common = Math.max(BLOCKING.commonFloor, Math.ceil(BLOCKING.commonShare * this.names.length));
    // The words' weights: inverse document frequency over the distinct names of both datasets.
    const df = new Map(), seen = new Set();
    for (const list of [...places, ...subjectPlaces]) for (const raw of list) {
      const n = normalise(raw);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      for (const w of new Set(n.split(' '))) df.set(w, (df.get(w) || 0) + 1);
    }
    const N = seen.size;
    const idf = new Map();
    this.weight = (w) => { let v = idf.get(w); if (v === undefined) { v = Math.log(1 + N / (df.get(w) || 1)); idf.set(w, v); } return v; };
    // What a word in QUALIFIER_RARE names weighs: a core weighing this much is never too common (names.js).
    this.weight.rare = Math.log(1 + N / QUALIFIER_RARE);
  }

  /**
   * The numbers of the other names to compare with the normalised name `s`, for scores that must
   * reach `threshold`. `core`: the core of the subject name, when it has qualifiers. `plain`: as if no
   * qualifier lists were in use (the names a matching with --qualifiers none would compare).
   */
  candidates(s, threshold = 0, core = null, plain = false) {
    const all = trigrams(s), known = [], start = new Map();
    // Each known trigram, with where it first begins in the padded name.
    const pad = '  ' + s + ' ';
    for (let i = 0; i + 3 <= pad.length; i++) { const id = this.ids.get(pad.slice(i, i + 3)); if (id !== undefined && !start.has(id)) { start.set(id, i); known.push(id); } }
    known.sort((a, b) => this.postings[a].length - this.postings[b].length || a - b);
    let keys = known.filter((id) => this.postings[id].length <= this.common);
    if (keys.length < BLOCKING.keys) keys = known.slice(0, Math.min(known.length, BLOCKING.keys));
    // One letter changed, added or dropped, or two swapped, breaks the trigrams beginning at no more
    // than four places in a row. If the keys all begin within four such places, one mistake there
    // would lose them all ("Great Shunia", "Great Shnuia"), so the rarest trigram beginning far
    // enough from them is added.
    if (keys.length) {
      let lo = Infinity, hi = -Infinity;
      for (const id of keys) { const p = start.get(id); if (p < lo) lo = p; if (p > hi) hi = p; }
      if (hi - lo < BLOCKING.spread) {
        // Not a trigram of a common word, though ("an " of San Xyz): that would read nearly every name.
        const far = known.find((id) => { const p = start.get(id); return this.postings[id].length <= BLOCKING.far * this.common && Math.max(hi, p) - Math.min(lo, p) >= BLOCKING.spread; });
        if (far !== undefined) keys = [...keys, far];
      }
    }
    // The subject name's trigrams, marked with a new stamp, so that another name's shared ones can be counted.
    const mark = this.mark ||= new Uint32Array(this.postings.length);
    const stamp = this.stamp = (this.stamp || 0) + 1;
    for (const id of known) mark[id] = stamp;
    // The other names that have any of the keys, each once (a reused array says which are listed already).
    const seen = this.seen ||= new Uint8Array(this.names.length), found = [];
    for (const id of keys) { const p = this.postings[id]; for (let i = 0; i < p.length; i++) if (!seen[p[i]]) { seen[p[i]] = 1; found.push(p[i]); } }
    const out = new Set(this.exact.get(s) || []);
    const byQualifier = threshold <= QUALIFIER_CAP && !plain;
    // The trigrams of the name's first three letters ("  b", " br", "bru"), when it has three.
    const words = s.split(' ').length, head = s.length >= 3 && !s.slice(0, 3).includes(' ') ? [0, 1, 2].map((i) => this.ids.get(pad.slice(i, i + 3))) : null;
    for (let j = 0; j < found.length; j++) {
      const ni = found[j]; seen[ni] = 0;
      if (out.has(ni)) continue;
      const o = this.names[ni];
      // Names of the same number of words may differ only in short forms (expandedScore()), which
      // letters and lengths cannot bound.
      // Nor can they bound names that may differ only by qualifiers: their cores must reach threshold / QUALIFIER_CAP.
      if (!canReach(s.length, o.n.length, threshold) && !(words > 1 && o.words === words)
        && !(byQualifier && (core || o.q.units.length) && canReach((core ?? s).length, (o.q.core ?? o.n).length, threshold / QUALIFIER_CAP))) continue;
      const need = Math.max(1, Math.ceil(BLOCKING.share * Math.min(all.size, o.t.length)));
      let n = 0;
      for (let i = 0, t = o.t; i < t.length; i++) if (mark[t[i]] === stamp) n++;
      // Or they begin with the same three letters, which Jaro-Winkler rewards ("Bruxelles", "Brussels").
      if (n >= need || (n >= 3 && head && o.t[0] === head[0] && o.t[1] === head[1] && o.t[2] === head[2])) out.add(ni);
    }
    return out;
  }

  /**
   * The best score of each other place (by number) against any of `names`, the names of one subject
   * place, where it reaches `threshold`. (Below it, the lowering by distinctive words is not worked
   * out: it cannot raise a score.) The map's `rule` holds, for each other place whose best score only
   * the qualifier rule reached the threshold with, the qualifiers that made the difference (their
   * labels: "Chipping", "on thames") and the two names, normalised: { added, names: [subject, other] }.
   */
  best(names, threshold = 0) {
    const best = new Map(), rule = new Map();
    best.rule = rule;
    // Keep a pair's score if it is the best for its place; on a tie, one found without the rule.
    const keep = (pi, score, by) => {
      const was = best.get(pi);
      if (score < threshold || (was !== undefined && (score < was || (score === was && (by || !rule.has(pi)))))) return;
      best.set(pi, score);
      if (by) rule.set(pi, by); else rule.delete(pi);
    };
    const byQualifier = threshold <= QUALIFIER_CAP && !this.Q.none;
    for (const s of new Set(names.map(normalise))) {
      if (!s) continue;
      const ss = sortWords(s), sq = qualifiers(s, this.Q);
      // A name with qualifiers is looked up by its core too (Chipping Ongar by "ongar"), each other name once.
      let found = this.candidates(s, threshold, sq.core), plainFound = null;
      if (byQualifier && sq.units.length) {
        found = new Set(found);
        for (const ni of this.candidates(sq.core, threshold, sq.core)) found.add(ni);
      }
      for (const ni of found) {
        const o = this.names[ni];
        this.comparisons++;
        // Scored as names.js scores any pair (scored()), with the shortcut under the threshold.
        const r = scored(s, o.n, this.weight, sq, o.q, threshold, ss, o.sorted);
        // A common core the rule declined (Market Farm and Farm) is kept only if the pair would be compared
        // with no lists at all: one only the qualifiers brought in (by the core, or the looser length bound)
        // is let go, so that its outcome is as with no lists.
        if (r.common && !(plainFound ??= this.candidates(s, threshold, null, true)).has(ni)) continue;
        keep(o.pi, r.score, r.by && { added: r.by.added, names: [s, o.n] });
      }
    }
    return best;
  }
}

/**
 * Whether names of these lengths can score `threshold` at all. Jaro similarity is at most
 * (1 + shorter / longer + 1) / 3 (every letter of the shorter matched), and Winkler's bonus adds at
 * most a tenth of the rest for each of the first four letters the shorter has; lowering by the
 * distinctive words only lowers. So a name of two letters cannot reach 0.85 with one of more than
 * four, or one of four letters with one of more than sixteen.
 */
export function canReach(a, b, threshold) {
  const short = Math.min(a, b), long = Math.max(a, b);
  if (!short) return false;
  const p = 0.1 * Math.min(4, short);
  const jaro = (2 + short / long) / 3;
  return jaro + p * (1 - jaro) >= threshold - 1e-9;
}
