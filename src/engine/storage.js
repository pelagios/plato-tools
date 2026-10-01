// How much of the browser's storage a run may need, for the page's warning (src/app.js,
// storageCheck): an estimate, generous on purpose, made before the action is chosen.
//
// Most inputs need room for a working database and an output about the size of the input, or, gzipped,
// of the input decompressed (taken as ten times it). The spreadsheet tables need more, measured in the
// page (headless Chromium, navigator.storage.estimate, generated tables of short rows; 1 October 2026).
// Their working database (TableStore) is twice the size of the tables' text on disk, but the browser
// counts more of it against the quota while it is open, since an access handle is given room ahead of
// its writes: 2.44 times the text at 200,000 places (58 MB of text), 2.74 times at 1,000,000 (296 MB).
// Their output is larger than they are, since each attestation carries its source in full: PLATO JSON
// Lines was 6.88 and 6.78 times the text. A conversion holds both at its end, so its peak was 9.5 times
// the text at a million places (2.8 GB). Allowed: 3 and 8 times, 11 in all, a sixth over that peak.
const TABLES_DATABASE = 3, TABLES_OUTPUT = 8;

/**
 * The bytes a run on `files` (as detected: `input`) may need. The tables' text is the size of the
 * sheets in a zip as its central directory gives it (input.textBytes), else of the files themselves;
 * a workbook, or a gzipped sheet, is taken as ten times its size.
 */
export function storageNeed(input, files) {
  const size = files.reduce((n, f) => n + f.size, 0);
  const gz = files.some((f) => /\.gz$/i.test(f.name));
  if (input?.format !== 'tables') return size * (gz ? 40 : 4);
  const text = input.textBytes ?? size * (input.container === 'workbook' || gz ? 10 : 1);
  return text * (TABLES_DATABASE + TABLES_OUTPUT);
}
