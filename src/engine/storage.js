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
// the text at a million places (2.8 GB).
//
// The database's factor grows with the dataset (2.44 to 2.74 for five times the places), so 3 would be
// passed not far beyond a million. Allowed: 4 for the database, room for that growth to go on at the
// same rate for two more fivefold steps (to 25 million places), or, were it to grow in step with the
// places (0.3 for each 800,000), to about 4 million, past what a page is likely to be given; 8 for the
// output, which did not grow. 12 in all, a quarter over the peak at a million places.
//
// These were measured with the working database's files let go between runs (worker.js, runEnv).
// Where letting go fails (pauseVfs refuses while a database is still open), the space the last run's
// access handles took is still counted, and the earlier peaks apply: a conversion of 200,000 places
// after a check of them peaked at 675 MB, against 401 MB let go, and so may need well over this.
const TABLES_DATABASE = 4, TABLES_OUTPUT = 8;

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
