// A pasted list of names (the page's "Paste a list of names, one per line"): made into a CSV file of
// two columns, "id" and "name", handed in as a dropped file is, so that it goes through the usual
// detection and matching of columns (the headings read as the place's id and name). The command line
// reads files, so it has no equivalent: a list saved as a file with those headings is the same thing.
//
// The id: a short one made from the name, as a place traced from a map is given one (src/engine/chora/seed.js,
// slugOf, Stephen's decision of 14 October 2026 for names typed in the tools), unique within the list by a number
// after it ("newton", "newton-2"). Greek (polytonic included, its diacritics stripped) and Cyrillic are put into
// Latin letters for the id alone (Stephen, 15 October 2026: Ἀθῆναι gives "athenai", Москва "moskva"); the name stays
// as written. "place" for a name with nothing an id can be made of. A table of the user's own
// with no id column still gives its places none (Hermes's decision D2: no row numbers, no slugs for a table's
// rows); a list typed here has no ids of its own to keep, and without them its places could not be looked up
// in a gazetteer or matched (a match is recorded against a place's address), as "Make an open map" and Map your
// data both do from a pasted list. Under the base address each place is <base>place/<id>.
import { slugOf } from '../chora/seed.js';

// Greek and Cyrillic letters in Latin ones (and the few Latin letters whose mark does not come off), one simple scheme each (an id, not a scholarly transliteration).
const LATIN = Object.fromEntries([
  ...'α a β b γ g δ d ε e ζ z η e θ th ι i κ k λ l μ m ν n ξ x ο o π p ρ r σ s ς s τ t υ y φ ph χ ch ψ ps ω o ϝ w ϙ q ϲ s'.match(/\S+ \S+/g),
  ...'а a б b в v г g д d е e ё e ж zh з z и i й i к k л l м m н n о o п p р r с s т t у u ф f х kh ц ts ч ch ш sh щ shch ы y э e ю iu я ia і i ї i є ie ґ g ў u ј j џ dz ђ dj ћ c љ lj њ nj'.match(/\S+ \S+/g),
  // Latin letters whose mark is part of the letter, so that decomposing them leaves nothing to strip.
  ...'ł l ø o đ d ß ss æ ae œ oe þ th ð d ı i ħ h ŧ t'.match(/\S+ \S+/g),
].map((pair) => pair.split(' ')));
/** A name in Latin letters, for its id only: lower case, diacritics stripped, Greek and Cyrillic transliterated. */
export function latinForId(name) {
  return [...String(name ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()].map((c) => (c === 'ъ' || c === 'ь' ? '' : LATIN[c] ?? c)).join('');
}

/** The name the pasted list's file is given, as a dropped file has one. */
export const PASTED_FILE_NAME = 'pasted-list.csv';

// Every cell quoted, so that a name holding a comma, a semicolon, a tab or a quote is one cell, and
// the CSV reader cannot take any of them for the separator.
const cell = (s) => `"${s.replace(/"/g, '""')}"`;

/**
 * The CSV text for a pasted list: the headings "id" and "name", then one row for each line that is not
 * blank, trimmed, in the order given, its id made from its name; null when there is no name at all.
 */
export function pastedListCsv(text) {
  const names = String(text ?? '').split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  if (!names.length) return null;
  const taken = new Set();
  const rows = names.map((n) => {
    const stem = slugOf(latinForId(n)) || 'place';
    let id = stem;
    for (let k = 2; taken.has(id); k++) id = `${stem}-${k}`;
    taken.add(id);
    return `${cell(id)},${cell(n)}`;
  });
  return `id,name\n${rows.join('\n')}\n`;
}

/** The pasted list as a File, named PASTED_FILE_NAME, or null when there is no name in it. */
export function pastedListFile(text) {
  const csv = pastedListCsv(text);
  return csv === null ? null : new File([csv], PASTED_FILE_NAME, { type: 'text/csv' });
}
