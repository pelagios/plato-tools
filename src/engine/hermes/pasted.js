// A pasted list of names (the page's "Paste a list of names, one per line"): made into a CSV file of
// two columns, "id" and "name", handed in as a dropped file is, so that it goes through the usual
// detection and matching of columns (the headings read as the place's id and name). The command line
// reads files, so it has no equivalent: a list saved as a file with those headings is the same thing.
//
// The id: a short one made from the name, as a place traced from a map is given one (src/engine/chora/seed.js,
// slugOf, Stephen's decision of 14 October 2026 for names typed in the tools), unique within the list by a number
// after it ("newton", "newton-2"); "place" for a name with no Latin letter or digit. A table of the user's own
// with no id column still gives its places none (Hermes's decision D2: no row numbers, no slugs for a table's
// rows); a list typed here has no ids of its own to keep, and without them its places could not be looked up
// in a gazetteer or matched (a match is recorded against a place's address), as "Make an open map" and Map your
// data both do from a pasted list. Under the base address each place is <base>place/<id>.
import { slugOf } from '../chora/seed.js';

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
    const stem = slugOf(n) || 'place';
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
