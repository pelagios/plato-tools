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
//
// A name found so is compared when the two share at least BLOCKING.share (40%) of the trigrams of
// the one with fewer, counting all of them, and at least one; a name exactly the same as the
// subject's is always compared. (It was 30%: in the scale test, 40% makes 40% fewer comparisons of
// 20,000 names with 20,000, and finds 1,965 of the 1,973 planted variants that score over the
// threshold, where 30% finds 1,969.) So the names read for each name are at most 1% of the other
// dataset for each trigram it is looked up by (a name made only of common trigrams reads its four
// rarest lists), where before, every name that shared a first letter or a common word was read.
//
// Scoring is names.js's, and each word is weighted by its inverse document frequency in the names of
// both datasets, ln(1 + N / df), so that a common word counts for little.
import { normalise, nameScore, distinctive, sortWords, trigrams } from './names.js';

export const BLOCKING = { share: 0.4, commonShare: 0.01, commonFloor: 50, keys: 4 };
export const BLOCKING_RULE = 'The names of the other dataset are indexed by their trigrams (normalised, padded with two spaces before and one after). '
  + `A trigram is common when more than ${BLOCKING.commonShare * 100}% of the other dataset's names have it, and more than ${BLOCKING.commonFloor}. `
  + `A name is looked up by its trigrams that are not common (or, with fewer than ${BLOCKING.keys} of those, by its ${BLOCKING.keys} rarest), `
  + `and compared with each name found that shares at least ${BLOCKING.share * 100}% of the trigrams of the one with fewer (and at least one); `
  + 'a name that is exactly the same is always compared.';

/** The index of the other dataset's names; `best(names)` scores a subject place against it. */
export class NameIndex {
  /**
   * `places`: for each other place, its names (as written). `subjectPlaces`: the subjects' names,
   * counted with the others' for the words' weights.
   */
  constructor(places, subjectPlaces = []) {
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
        this.names.push({ pi, n, t: Int32Array.from(t), sorted: sortWords(n) });
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
  }

  /** The numbers of the other names to compare with the normalised name `s`, for scores that must reach `threshold`. */
  candidates(s, threshold = 0) {
    const all = trigrams(s), known = [];
    for (const g of all) { const id = this.ids.get(g); if (id !== undefined) known.push(id); }
    known.sort((a, b) => this.postings[a].length - this.postings[b].length || a - b);
    let keys = known.filter((id) => this.postings[id].length <= this.common);
    if (keys.length < BLOCKING.keys) keys = known.slice(0, Math.min(known.length, BLOCKING.keys));
    // The subject name's trigrams, marked with a new stamp, so that another name's shared ones can be counted.
    const mark = this.mark ||= new Uint32Array(this.postings.length);
    const stamp = this.stamp = (this.stamp || 0) + 1;
    for (const id of known) mark[id] = stamp;
    // The other names that have any of the keys, each once (a reused array says which are listed already).
    const seen = this.seen ||= new Uint8Array(this.names.length), found = [];
    for (const id of keys) { const p = this.postings[id]; for (let i = 0; i < p.length; i++) if (!seen[p[i]]) { seen[p[i]] = 1; found.push(p[i]); } }
    const out = new Set(this.exact.get(s) || []);
    for (let j = 0; j < found.length; j++) {
      const ni = found[j]; seen[ni] = 0;
      if (out.has(ni)) continue;
      const o = this.names[ni];
      if (!canReach(s.length, o.n.length, threshold)) continue;
      const need = Math.max(1, Math.ceil(BLOCKING.share * Math.min(all.size, o.t.length)));
      let n = 0;
      for (let i = 0, t = o.t; i < t.length; i++) if (mark[t[i]] === stamp) n++;
      if (n >= need) out.add(ni);
    }
    return out;
  }

  /**
   * The best score of each other place (by number) against any of `names`, the names of one subject
   * place, where it reaches `threshold`. (Below it, the lowering by distinctive words is not worked
   * out: it cannot raise a score.)
   */
  best(names, threshold = 0) {
    const best = new Map();
    for (const s of new Set(names.map(normalise))) {
      if (!s) continue;
      const ss = sortWords(s);
      for (const ni of this.candidates(s, threshold)) {
        const o = this.names[ni];
        this.comparisons++;
        let score = nameScore(s, o.n, ss, o.sorted);
        if (score < threshold) continue;
        if (score < 1) { const d = distinctive(s, o.n, this.weight); if (d !== null && d < score) score = d; }
        if (score >= threshold && score > (best.get(o.pi) ?? -1)) best.set(o.pi, score);
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
