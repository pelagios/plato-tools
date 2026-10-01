// Workbooks (.xlsx, .ods) made for the tests with SheetJS, in memory, from rows given here: nothing
// in them depends on when or where they are made. A date is written as the number a spreadsheet
// keeps (days since 30 December 1899) with a date format, never from a JavaScript Date, which
// SheetJS would write in the local time zone.
import * as XLSX from 'xlsx';

/** A date (and time) cell, as a spreadsheet keeps it. */
export const dateCell = (y, m, d, h = 0, min = 0, z = h || min ? 'yyyy"-"mm"-"dd" "hh":"mm' : 'yyyy"-"mm"-"dd') =>
  ({ t: 'n', v: (Date.UTC(y, m - 1, d, h, min) - Date.UTC(1899, 11, 30)) / 86400000, z });
/** A number cell shown with a number format (as "0.00" shows 51.123456789 as 51.12). */
export const numberCell = (v, z) => ({ t: 'n', v, z });
/** A formula saved with no value (as a program that does not calculate writes it), or with one. */
export const formulaCell = (f, v) => (v === undefined ? { t: 'e', f } : { t: typeof v === 'number' ? 'n' : 's', v, f });

/**
 * The bytes of a workbook: `sheets` is [[name, rows]], each row a list of values or cells (above);
 * `hidden` the names of the sheets to hide (an xlsx file keeps the flag; SheetJS writes none to ODS).
 */
export function workbookBytes(sheets, { type = 'xlsx', hidden = [] } = {}) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(rows.map((r) => r.map((c) => (c && typeof c === 'object' && 'f' in c && !('v' in c) ? null : c))));
    // A formula with no value is put in after: aoa_to_sheet would write a cell with no value as empty.
    rows.forEach((r, i) => r.forEach((c, j) => { if (c && typeof c === 'object' && 'f' in c && !('v' in c)) ws[XLSX.utils.encode_cell({ r: i, c: j })] = { ...c }; }));
    if (rows.length) ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length - 1), c: Math.max(0, ...rows.map((r) => r.length - 1)) } });
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  wb.Workbook = { Sheets: sheets.map(([name]) => ({ Hidden: hidden.includes(name) ? 1 : 0 })) };
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: type, compression: true }));
}
/** A workbook as a File. */
export const workbookFile = (sheets, name = 'mine.xlsx', opts = {}) => new File([workbookBytes(sheets, { type: name.endsWith('.ods') ? 'ods' : 'xlsx', ...opts })], name);
