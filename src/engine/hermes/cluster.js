// Hermes: grouping variant spellings of the same name before lookup (Methodos #28, stage 1), as
// OpenRefine's key-collision clustering does. Pure, and hand-written, so that the page and the
// command line group alike and nothing is added to the tools' dependencies.
//
// - Proposing. clusterValues(values, { method }) gives each value a key, and the values that share a
//   key are a cluster. Only clusters of two or more distinct values are kept. Nothing is applied by
//   proposing: the page shows each cluster unticked, and the command line prints them as JSON.
// - The keys:
//     'fingerprint' (the default): OpenRefine's fingerprint keyer. The value trimmed, lower-cased, its
//       accents dropped (NFKD, combining marks removed; a few letters that do not decompose spelt out:
//       ß ss, æ ae, ø o, ł l…), its punctuation, symbols and control characters removed (removed, not
//       made a space, as OpenRefine does: "St.Albans" is "stalbans"), split on whitespace, the words
//       de-duplicated and sorted, and joined with a space. Case, accents, punctuation and word order
//       do not count: "Rotherhithe", "ROTHERHITHE." and "Rotherhithe " share a key, "Newton, Upper"
//       and "Upper Newton" too.
//     'ngram-fingerprint': OpenRefine's n-gram fingerprint keyer, n = 2. The value lower-cased, its
//       accents dropped, its punctuation, control characters and whitespace removed, cut into every
//       run of two letters, which are de-duplicated, sorted and joined with nothing. It joins
//       spellings that differ in spacing, or by a letter whose pairs the name already has
//       ("Rother hithe", "Rotherhith" and "Rotherhithe"); it also joins some that are not alike at
//       all, as OpenRefine warns, which is why nothing is ever applied unticked. A value shorter than
//       two letters is its own key.
//     'phonetic': Cologne phonetics (Kölner Phonetik, Hans Joachim Postel, 1969), applied word by word
//       to the fingerprint's words, each word's code kept whole (not cut to four, as Soundex is), and
//       the codes de-duplicated and sorted as the fingerprint's words are. Written here from the
//       published rules (the table in Postel's article, as Wikipedia's article on it gives it), not
//       ported from any code, so no licence but the tools' own applies. Chosen over Soundex, which
//       cuts every word to its first letter and three digits, so that names differing only further
//       on collide ("Bradford" and "Bradfield" are both B631; here 172372 and 172352), and over
//       Double Metaphone, whose hundreds of English rules are too many to write and test well here.
//       Its rules were made for German; after the accents are dropped they serve English and the
//       other languages written in the Latin alphabet passably, being coarse (every vowel after the
//       first letter counts for nothing; d and t, f, v and w, g, k and q are each one sound), so it
//       is for names that sound alike and are spelt differently, and it groups the most, wrongly
//       too ("Rotherhithe" and "Redruth" are both 7272). A digit is kept as itself (so "Newton 2" and
//       "Newton 3" stay apart), and a word with no Latin letter at all (Greek, Arabic, Chinese…) is
//       kept as it is, never coded to nothing. A digit inside a word with a Latin letter is coded as
//       the letters are, so a digit repeated there is one, as any run of one code is ("A22" and "A2"
//       share a code); a word of digits alone is kept whole ("22" and "2" do not).
// - suggested is the most frequent member (a tie: the one met first), for the spelling to look up
//   with; the page lets the user type another. Members are listed most frequent first (a tie: in the
//   order met), and clusters by how many values they hold (then by key), so the output is the same
//   for the same values, whatever the order of the Map.
// - Applying. Only groups the user confirmed (ticked) are ever applied, and they never change the
//   source's spellings: lookupSpellings(clusters) gives, for each row, the lookup spelling of each
//   grouped column, which the reader (generic.js) carries BESIDE the record, as event.lookupName (the
//   name column) and event.lookupValues[column] (any grouped column), and records in the attestation's
//   notes ("Grouped for lookup with: … (spelling chosen: …)"). The PLATO names keep the source's
//   spelling.
// - Saving. The confirmed groups are saved as { "<column>": { "method": "fingerprint", "groups":
//   [{ "chosen": "Rotherhithe", "members": ["Rotherhith", "ROTHERHITHE"] }] } }, under the key
//   "clusters" of a saved matching that is then { "columns": {mapping}, "clusters": {…} }
//   (matchingToSave). Not inside the mapping: any text can be a column's heading, a "__clusters"
//   column included, so no key there is safe; the "columns" envelope is one savedColumns (generic.js)
//   already reads as options, never as a mapping. --clusters FILE takes that file, or the clusters
//   alone.
import { DataError } from '../input.js';
import { CLUSTER_WORDS } from '../words.js';

export const CLUSTER_METHODS = ['fingerprint', 'ngram-fingerprint', 'phonetic'];
export const DEFAULT_METHOD = 'fingerprint';

// Letters that do not decompose under NFKD, spelt out, as Krisis's names.js does.
const SPELT = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i', ŋ: 'ng', ħ: 'h' };
const fold = (s) => s.normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[ßæœøłđðþıŋħ]/g, (c) => SPELT[c]);
// Punctuation, symbols and control characters (whitespace apart, which divides the words).
const PUNCT = /[\p{P}\p{S}]|(?![\t\n\v\f\r])\p{Cc}/gu;

/** OpenRefine's fingerprint of a value: "  Upper  Newton, " and "newton upper" are both "newton upper". */
export function fingerprint(value) {
  const s = fold(String(value ?? '').trim().toLowerCase()).replace(PUNCT, '');
  const words = s.split(/\s+/).filter(Boolean);
  return [...new Set(words)].sort().join(' ');
}

/** OpenRefine's n-gram fingerprint of a value (n = 2): "Paris" is "arispari"; a value shorter than n is itself. */
export function ngramFingerprint(value, n = 2) {
  const s = fold(String(value ?? '').toLowerCase()).replace(PUNCT, '').replace(/\s+/g, '');
  if (s.length < n) return s;
  const grams = new Set();
  for (let i = 0; i + n <= s.length; i++) grams.add(s.slice(i, i + n));
  return [...grams].sort().join('');
}

// ---- Cologne phonetics ----------------------------------------------------------------------------
const VOWELS = new Set('aeijouy');
/**
 * The Cologne phonetic code of one word: its letters a-z coded by Postel's rules, h dropped, runs of
 * one code made one, then every 0 but a first removed. A digit is kept as itself (it codes no sound);
 * "Müller-Lüdenscheidt" is 65752682, "Wikipedia" 3412.
 */
export function cologne(word) {
  const s = fold(String(word ?? '').toLowerCase());
  const codes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i], prev = s[i - 1] || '', next = s[i + 1] || '';
    let code;
    if (VOWELS.has(c)) code = '0';
    else if (c === 'h') code = '';            // no code, and it does not break a run
    else if (c === 'b') code = '1';
    else if (c === 'p') code = next === 'h' ? '3' : '1';
    else if (c === 'd' || c === 't') code = 'csz'.includes(next) && next ? '8' : '2';
    else if (c === 'f' || c === 'v' || c === 'w') code = '3';
    else if (c === 'g' || c === 'k' || c === 'q') code = '4';
    else if (c === 'c') {
      // At the start: 4 before a, h, k, l, o, q, r, u, x, else 8. Elsewhere: 8 after s or z; else 4
      // before a, h, k, o, q, u, x; else 8.
      if (i === 0 || !/[a-z]/.test(prev)) code = next && 'ahkloqrux'.includes(next) ? '4' : '8';
      else if (prev === 's' || prev === 'z') code = '8';
      else code = next && 'ahkoqux'.includes(next) ? '4' : '8';
    } else if (c === 'x') code = prev && 'ckq'.includes(prev) ? '8' : '48';
    else if (c === 'l') code = '5';
    else if (c === 'm' || c === 'n') code = '6';
    else if (c === 'r') code = '7';
    else if (c === 's' || c === 'z') code = '8';
    else if (/\p{N}/u.test(c)) code = `#${c}`;   // a digit: itself, marked so that it is no letter's code
    else code = '';                            // anything else codes nothing
    if (code) codes.push(code);
  }
  // Runs of one code become one (a code of two digits, x's 48, counts as its digits).
  const flat = codes.flatMap((x) => (x.startsWith('#') ? [x] : [...x]));
  const out = [];
  for (const x of flat) if (out[out.length - 1] !== x) out.push(x);
  return out.filter((x, i) => x !== '0' || i === 0).map((x) => (x.startsWith('#') ? x.slice(1) : x)).join('');
}

/** The phonetic key of a value: each of its fingerprint's words by Cologne phonetics, de-duplicated and sorted. */
export function phoneticKey(value) {
  const words = fingerprint(value).split(' ').filter(Boolean);
  // A word with no Latin letter is kept as it is: its code would be nothing, and every such word would collide.
  const codes = words.map((w) => (/[a-z]/.test(w) ? cologne(w) || w : w));
  return [...new Set(codes)].sort().join(' ');
}

const KEYERS = { fingerprint, 'ngram-fingerprint': (v) => ngramFingerprint(v, 2), phonetic: phoneticKey };
/** The key a method gives a value. An unknown method is a DataError naming the methods. */
export function clusterKey(value, method = DEFAULT_METHOD) {
  return keyer(method)(value);
}
function keyer(method) {
  if (!Object.hasOwn(KEYERS, method)) throw new DataError(CLUSTER_WORDS.unknownMethod(method, CLUSTER_METHODS));
  return KEYERS[method];
}

/**
 * Values counted for clustering, one at a time (a large file's column is streamed into it): only the
 * distinct values and their counts are held, in a Map. add(value) counts a value (an empty one, or
 * one of spaces only, is not counted); clusters() gives the clusters (clusterValues).
 */
export function clusterCounter({ method = DEFAULT_METHOD } = {}) {
  const key = keyer(method);
  const counts = new Map();   // value -> count, in the order first met
  return {
    method,
    add(value) {
      if (value === undefined || value === null) return;
      const v = String(value);
      if (!v.trim()) return;
      counts.set(v, (counts.get(v) || 0) + 1);
    },
    get distinct() { return counts.size; },
    clusters() {
      const byKey = new Map();
      let order = 0;
      for (const [value, count] of counts) {
        const k = key(value);
        if (!k) continue;   // a value of punctuation only has no key to share
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push({ value, count, first: order++ });
      }
      const out = [];
      for (const [k, members] of byKey) {
        if (members.length < 2) continue;
        members.sort((a, b) => b.count - a.count || a.first - b.first);
        out.push({ key: k, members: members.map(({ value, count }) => ({ value, count })), suggested: members[0].value, rows: members.reduce((n, m) => n + m.count, 0) });
      }
      out.sort((a, b) => b.rows - a.rows || b.members.length - a.members.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return out.map(({ key: k, members, suggested }) => ({ key: k, members, suggested }));
    },
  };
}

/**
 * Group variant spellings: the clusters of `values` (any iterable of strings: a column's cells, a
 * level of containing regions, a pasted list) under a method's key, [{ key, members: [{ value, count }],
 * suggested }], each with two or more distinct members. Deterministic: the same values give the same
 * clusters in the same order.
 */
export function clusterValues(values, { method = DEFAULT_METHOD } = {}) {
  const c = clusterCounter({ method });
  for (const v of values) c.add(v);
  return c.clusters();
}

// ---- confirmed groups: saving, loading, applying ----------------------------------------------------
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
/**
 * One column's entry in a saved mapping, told exactly by its shape: a field's name, or { field } or
 * { field, pattern } with strings and no other key (columns.js, mappingToSave). Any other object is
 * not an entry: a mapping ({ "field": "note", … }, for a table with a column headed "field"), the
 * groups of spellings, or a run's options.
 */
export function isMappingEntry(v) {
  if (typeof v === 'string') return true;
  if (!isObject(v) || typeof v.field !== 'string') return false;
  return Object.keys(v).every((k) => k === 'field' || (k === 'pattern' && typeof v.pattern === 'string'));
}
/**
 * A saved matching that holds more than the mapping: { columns: {mapping}, clusters: {groups} }, as
 * matchingToSave writes it (only ever with groups), never a mapping alone. A mapping with columns
 * headed "columns" and "clusters" has an entry for each (isMappingEntry), never two objects that are not.
 */
export function isMatchingEnvelope(x) {
  return isObject(x) && isObject(x.columns) && isObject(x.clusters) && !(isMappingEntry(x.columns) && isMappingEntry(x.clusters));
}
/** A saved matching as the mapping and the confirmed groups it holds: { columns, clusters } (clusters undefined when none). */
export function splitMatching(saved) {
  if (!isMatchingEnvelope(saved)) return { columns: saved, clusters: undefined };
  return { columns: saved.columns, clusters: Object.hasOwn(saved, 'clusters') ? saved.clusters : undefined };
}
/**
 * The groups the user confirmed, from the clusters shown: `shown` is [{ ticked, chosen, members }]
 * (members as values, or as { value }), and only the ticked ones, with a chosen spelling, are kept.
 * Gives { "<column>": { method, groups } }, or {} when none is ticked; merged over `others`, the
 * groups already confirmed for other columns (a column's groups are replaced whole).
 */
export function confirmedGroups(column, method, shown, others = {}) {
  const out = Object.create(null);
  for (const [c, g] of Object.entries(others || {})) if (c !== column) out[c] = g;
  const groups = (shown || []).filter((g) => g && g.ticked === true && typeof g.chosen === 'string' && g.chosen.trim())
    .map((g) => ({ chosen: g.chosen.trim(), members: g.members.map((m) => (typeof m === 'string' ? m : m.value)) }));
  if (groups.length) out[column] = { method, groups };
  return out;
}
/** What to save: the mapping alone while no group is confirmed (as before), else { columns, clusters }. */
export function matchingToSave(mapping, clusters) {
  return clusters && Object.keys(clusters).length ? { columns: mapping, clusters } : mapping;
}
/**
 * The confirmed groups in a file given with --clusters (or loaded on the page): a saved matching
 * ({ columns, clusters }), { clusters }, or the clusters alone, { "<column>": { method, groups } }.
 */
export function clustersInFile(json) {
  if (isMatchingEnvelope(json)) return json.clusters ?? {};
  // { clusters: {…} }, unless "clusters" is a column whose own groups these are.
  if (isObject(json) && Object.keys(json).length === 1 && isObject(json.clusters) && !Array.isArray(json.clusters.groups)) return json.clusters;
  return json;
}

/**
 * The confirmed groups, checked: { "<column>": { method, groups: [{ chosen, members }] } }, each
 * chosen spelling a non-empty string, each member a string, and no member in two groups of one
 * column (which spelling it would be looked up by could not be told). Anything else is a DataError
 * saying what. A copy, with no prototype, so that a column called "__proto__" is a column.
 */
export function checkClusters(given) {
  const W = CLUSTER_WORDS;
  if (given === undefined || given === null) return Object.create(null);
  if (!isObject(given)) throw new DataError(W.notAnObject);
  const out = Object.create(null);
  for (const [column, c] of Object.entries(given)) {
    if (!isObject(c) || !Array.isArray(c.groups)) throw new DataError(W.columnShape(column));
    const method = c.method === undefined ? DEFAULT_METHOD : c.method;
    if (!CLUSTER_METHODS.includes(method)) throw new DataError(W.unknownMethod(method, CLUSTER_METHODS));
    const seen = new Map();
    const groups = c.groups.map((g, i) => {
      if (!isObject(g) || typeof g.chosen !== 'string' || !g.chosen.trim() || !Array.isArray(g.members) || !g.members.length || !g.members.every((m) => typeof m === 'string'))
        throw new DataError(W.groupShape(column, i + 1));
      for (const m of g.members) {
        const k = m.trim();
        if (seen.has(k) && seen.get(k) !== i) throw new DataError(W.memberTwice(column, m));
        seen.set(k, i);
      }
      return { chosen: g.chosen.trim(), members: [...new Set(g.members)] };
    });
    out[column] = { method, groups };
  }
  return out;
}

/**
 * How confirmed groups apply to rows: { columns, apply(row, attestation, nameColumn) }. apply looks
 * each grouped column's cell up (trimmed, as the reader trims a cell) and, for a member of a group,
 * adds the note to the attestation (its `notes`, a line of its own) and gives { lookupValues:
 * { column: chosen }, lookupName? } (lookupName when the column is `nameColumn`); for a row with no
 * grouped value, null. The source's cell, and so the PLATO name, is never changed.
 */
export function lookupSpellings(clusters) {
  const checked = checkClusters(clusters);
  const W = CLUSTER_WORDS;
  // Each column's members (trimmed) -> { chosen, members }.
  const byColumn = new Map();
  for (const [column, { groups }] of Object.entries(checked)) {
    const m = new Map();
    for (const g of groups) for (const v of g.members) m.set(v.trim(), g);
    byColumn.set(column, m);
  }
  return {
    columns: [...byColumn.keys()],
    apply(row, attestation, nameColumn) {
      let out = null;
      for (const [column, members] of byColumn) {
        const raw = row?.[column];
        if (raw === undefined || raw === null) continue;
        const v = typeof raw === 'string' ? raw.trim() : String(raw);
        const g = members.get(v);
        if (!g) continue;
        out ||= { lookupValues: Object.create(null) };
        out.lookupValues[column] = g.chosen;
        const name = column === nameColumn;
        if (name) out.lookupName = g.chosen;
        const others = g.members.map((x) => x.trim()).filter((x, i, a) => x !== v && a.indexOf(x) === i);
        const note = W.note(others.length ? others : [v], g.chosen, name ? null : column);
        if (attestation) attestation.notes = attestation.notes ? `${attestation.notes}\n${note}` : note;
      }
      return out;
    },
  };
}
