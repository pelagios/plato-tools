// How much of the browser's storage a run may need, for the page's warning (src/app.js,
// storageCheck): an estimate, generous on purpose, made before the action is chosen.
//
// Most inputs need room for a working database and an output about the size of the input, or, gzipped,
// of the input decompressed (taken as ten times it). The spreadsheet tables need more: their working
// database (TableStore) was twice the size of the tables' text, measured on generated tables of
// 200,000 and 1,000,000 places of short rows, and the pool of database files on the origin private
// file system does not shrink, so a tenth more is allowed; their output is larger than they are, since
// each attestation carries its source in full (PLATO JSON Lines was seven times the tables' text).
const TABLES_DATABASE = 2 * 1.1, TABLES_OUTPUT = 7;

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
