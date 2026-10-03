// A pasted list of names (the page's "Paste a list of names, one per line"): made into a CSV file of
// one column headed "name", handed in as a dropped file is, so that it goes through the usual
// detection and matching of columns (the heading reads as the place's name). The command line reads
// files, so it has no equivalent: a list saved as a file with the heading "name" is the same thing.

/** The name the pasted list's file is given, as a dropped file has one. */
export const PASTED_FILE_NAME = 'pasted-list.csv';

// Every cell quoted, so that a name holding a comma, a semicolon, a tab or a quote is one cell, and
// the CSV reader cannot take any of them for the separator.
const cell = (s) => `"${s.replace(/"/g, '""')}"`;

/**
 * The CSV text for a pasted list: the heading "name", then one row for each line that is not blank,
 * trimmed, in the order given; null when there is no name at all.
 */
export function pastedListCsv(text) {
  const names = String(text ?? '').split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  if (!names.length) return null;
  return `name\n${names.map(cell).join('\n')}\n`;
}

/** The pasted list as a File, named PASTED_FILE_NAME, or null when there is no name in it. */
export function pastedListFile(text) {
  const csv = pastedListCsv(text);
  return csv === null ? null : new File([csv], PASTED_FILE_NAME, { type: 'text/csv' });
}
