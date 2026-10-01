// CSV, read as a stream: the text of a file in chunks, and the records of that text one row of cells
// at a time, as Papa reads them. Shared by Hermes' tables of places (src/engine/hermes/generic.js)
// and the PLATO spreadsheet tables (src/engine/pipeline.js, tablesSource), so that both read a CSV
// file the same way, and neither ever holds one whole.
import Papa from 'papaparse';
import { textStream, DataError } from '../engine/input.js';

/**
 * The text of a file (or of a stream of text already decoded) in chunks, decompressed and decoded,
 * without its byte-order mark; a break in the bytes is a DataError.
 */
export async function* textChunks(source) {
  const reader = (source instanceof ReadableStream ? source : await textStream(source)).getReader();
  let first = true;
  try {
    for (;;) {
      let r;
      try { r = await reader.read(); }
      catch (e) { throw e instanceof DataError ? e : new DataError(`The file stops, or is damaged, part-way through, so it cannot be read to the end (${String(e && (e.message || e.name) || e).split('\n')[0]}).`); }
      if (r.done) break;
      let t = r.value;
      if (first && t) { t = t.replace(/^﻿/, ''); first = false; }
      if (t) yield t;
    }
  } finally { reader.cancel().catch(() => {}); }
}

/** A row whose cells are all empty, or only spaces (Papa's skipEmptyLines 'greedy'). */
export const isBlank = (cells) => cells.every((c) => c.trim() === '');

/**
 * The records of CSV text given in chunks, one array of cells at a time, as Papa reads them, with
 * the rows whose cells are all empty left out (as Papa's skipEmptyLines 'greedy'), unless
 * `keepBlank`. Nothing is held but the chunk being read and the row it breaks off in, so a file of
 * any size streams. The delimiter is `delimiter`, else guessed (as Papa guesses it) from the start
 * of the text.
 *
 * A quotation mark out of place moves where Papa thinks a row ends: rows are merged into one cell,
 * or split, and nothing read after it can be trusted to be the row it seems. It stops the file with
 * a DataError naming the line, found from where in the text it is. Papa's chunk parser reports no
 * other kind of error (its delimiter and field-count errors are Papa.parse's, which this does not
 * use); one it came to report would stop the file too, never be dropped.
 */
export async function* csvRecords(chunks, { delimiter, keepBlank = false } = {}) {
  const it = chunks[Symbol.asyncIterator]();
  let buf = '', done = false;
  // Enough of the start to guess the delimiter and the line break from, as Papa guesses them from its
  // first rows: ten lines, or 64 KB, or the whole file.
  const lineCount = (t) => { let k = 0, i = -1; while ((i = t.indexOf('\n', i + 1)) !== -1 && k < 11) k++; return k; };
  while (!done && buf.length < 65536 && lineCount(buf) < 11) { const r = await it.next(); if (r.done) done = true; else buf += r.value; }
  const guess = Papa.parse(buf.slice(0, 65536), { preview: 10, skipEmptyLines: 'greedy', ...(delimiter ? { delimiter } : {}) }).meta;
  const newline = guess.linebreak || '\n';
  const parser = new Papa.Parser({ delimiter: delimiter || guess.delimiter || ',', newline });
  const count = (s, to) => { let n = 0, i = -1; while ((i = s.indexOf(newline, i + 1)) !== -1 && i < to) n++; return n; };
  let lines = 0;   // line breaks before the start of `buf`
  for (;;) {
    // Papa's own streaming: every row but the last, which may go on in the next chunk, is read.
    const last = done;
    const res = parser.parse(buf, 0, !last);
    const cursor = last ? buf.length : res.meta.cursor;
    for (const e of res.errors) {
      // An error in the row left for the next chunk is Papa's view of half a row: it is read again whole.
      if (!last && Number.isInteger(e.index) && e.index >= cursor) continue;
      const line = Number.isInteger(e.index) ? lines + count(buf, e.index) + 1 : undefined;
      if (e.type === 'Quotes') {
        throw new DataError(`The CSV file has ${e.code === 'MissingQuotes' ? 'a quotation mark that opens a cell and is never closed' : 'a stray quotation mark in a quoted cell (a quotation mark inside a quoted cell is written twice: "")'}${line ? ` near line ${line}` : ''}, so where its rows begin and end cannot be told. Correct the quotation marks and try again.`);
      }
      throw new DataError(`The CSV file cannot be read${line ? ` near line ${line}` : ''} (${e.message}).`);
    }
    for (const cells of res.data) if (keepBlank || !isBlank(cells)) yield cells;
    if (last) return;
    lines += count(buf, cursor);
    buf = buf.slice(cursor);
    const r = await it.next();
    if (r.done) done = true; else buf += r.value;
  }
}

// ---- rows as Papa.parse(text, { header: true, skipEmptyLines: 'greedy' }) makes them ------------
// The spreadsheet tables were read whole by Papa with header: true, and their rows are still the
// objects it made, exactly, so that streaming them changes nothing a conversion writes or a check
// reports. Papa's rules, from papaparse 5.7.0:
//   - the first row of the text, blank or not, has its headings renamed where one repeats (b, b_1,
//     b_2, skipping a name already in the row) and a byte-order mark taken off each; only then are
//     blank rows dropped, so a header after a blank first line is taken as it is, repeats and all;
//   - the header is the first row left; a file with none has the header [];
//   - a row's cells go under their headings, in order, a later repeat overwriting an earlier one;
//     a cell past the last heading goes into the list __parsed_extra; a heading with no cell is
//     left out (undefined, not '');
//   - the row is a plain object, so a heading "__proto__" sets nothing.

/** Papa's renaming of the first row's headings (papaparse 5.7.0, returnable()). */
export function papaFirstRow(cells) {
  const result = cells.slice();
  const headerCount = Object.create(null);
  const usedHeaders = new Set(result);
  for (let i = 0; i < result.length; i++) {
    const header = typeof result[i] === 'string' && result[i].charCodeAt(0) === 0xfeff ? result[i].slice(1) : result[i];
    if (!headerCount[header]) { headerCount[header] = 1; result[i] = header; }
    else {
      let newHeader, suffixCount = headerCount[header];
      do { newHeader = `${header}_${suffixCount}`; suffixCount++; } while (usedHeaders.has(newHeader));
      usedHeaders.add(newHeader);
      result[i] = newHeader;
      headerCount[header]++;
    }
    usedHeaders.add(header);
  }
  return result;
}

/** A row of cells as the object Papa's header: true makes of it. */
export function papaRow(fields, cells) {
  const row = {};
  for (let j = 0; j < cells.length; j++) {
    const field = j >= fields.length ? '__parsed_extra' : fields[j];
    // Papa puts the cells beyond the header into an array, __parsed_extra, and the cell under a
    // heading of that name too (its field is that name, so row[field] || [], then push): the
    // heading's cell is the array's first, and the cells beyond the header follow it.
    if (field === '__parsed_extra') {
      if (!Array.isArray(row.__parsed_extra)) row.__parsed_extra = [];
      row.__parsed_extra.push(cells[j]);
    }
    else row[field] = cells[j];
  }
  return row;
}

/**
 * The header and the rows of CSV records (from csvRecords with keepBlank) as Papa.parse with
 * header: true and skipEmptyLines: 'greedy' gives them: calls onHeader(fields) once (with [] for a
 * text with no rows), then yields each row's cells, for papaRow.
 */
export async function* papaRecords(records, onHeader) {
  let first = true, fields = null;
  for await (let cells of records) {
    if (first) { cells = papaFirstRow(cells); first = false; }
    if (isBlank(cells)) continue;
    if (!fields) { fields = cells; onHeader(fields); continue; }
    yield cells;
  }
  if (!fields) onHeader([]);
}
