// A workbook's cells are read as stored, not as their number formats show them. Before, a
// coordinate formatted 0.00 lost its digits, a General number was cut to 11 significant digits, a
// percentage became "95%" and a date "7/1/20" (m/d/yy). The time zone is set to London's, and the
// dates are in summer, so a date read as local midnight and written with toISOString would be the
// day before.
process.env.TZ = 'Europe/London';
import { PLATO_REPO } from './paths.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { go, outText } from './engine.js';
import { workbookSheetCsv, numberText, dateText } from '../src/engine/pipeline.js';

const CUSTOMS = `${PLATO_REPO}/schemas/tables/examples/customs`;
const errors = (r) => r.report.items.filter((i) => i.severity === 'error');
const utc = (...a) => new Date(Date.UTC(...a));

/** The customs example as a workbook, with typed and formatted cells put into its first rows. */
function workbook(bookType, fromCell = { t: 'd', v: utc(2020, 6, 1), z: 'm/d/yy' }) {
  const wb = XLSX.utils.book_new();
  for (const f of readdirSync(CUSTOMS)) {
    const ws = XLSX.read(readFileSync(`${CUSTOMS}/${f}`, 'utf8'), { type: 'string', raw: true }).Sheets.Sheet1;
    XLSX.utils.book_append_sheet(wb, ws, f.replace('.csv', ''));
  }
  const set = (sheet, ref, cell) => { wb.Sheets[sheet][ref] = cell; };
  // locations, bristol: a latitude formatted 0.00, a longitude in General with 15 significant digits.
  set('locations', 'B2', { t: 'n', v: 51.4552345678912, z: '0.00' });
  set('locations', 'C2', { t: 'n', v: -0.123456789012345 });
  // names, Bristowe: a name of digits typed as text, a whole number formatted 0.00, a certainty as a
  // percentage, a date at midnight (from) and the next day (to), a date and time (date), and an
  // amount of money (notes).
  set('names', 'B2', { t: 's', v: '007', z: '@' });
  set('names', 'I2', { t: 'n', v: 42, z: '0.00' });
  set('names', 'S2', { t: 'n', v: 0.95, z: '0%' });
  set('names', 'M2', fromCell);
  set('names', 'N2', { t: 'd', v: utc(2020, 6, 2), z: 'm/d/yy' });
  set('names', 'L2', { t: 'd', v: utc(2021, 4, 4, 13, 45, 30) });
  set('names', 'W2', { t: 'n', v: 1234.5678, z: '"£"#,##0.00' });
  return XLSX.write(wb, { type: 'array', bookType, cellDates: true });
}

for (const bookType of ['xlsx', 'ods']) {
  const bytes = workbook(bookType);

  test(`${bookType}: a sheet's CSV holds each cell's value as stored`, () => {
    const [, bristol] = workbookSheetCsv(XLSX, bytes, 'locations').split('\n');
    assert.match(bristol, /^bristol,51\.4552345678912,-0\.123456789012345,/);
    const [, row] = workbookSheetCsv(XLSX, bytes, 'names').split('\n');
    assert.match(row, /^bristol,007,/);
    assert.match(row, /,42,(?:[^,]*,){2}2021-05-04T13:45:30,2020-07-01,2020-07-02,/);
    assert.match(row, /,0\.95,(?:[^,]*,){3}1234\.5678$/);
  });

  test(`${bookType}: the PLATO values keep the full number, the text as typed, and ISO dates`, async () => {
    const r = await go([new File([bytes], `customs.${bookType}`)], 'convert', 'plato-jsonl', { base: 'https://example.org/customs/' });
    assert.deepEqual(errors(r), []);
    const recs = outText(r.e, Object.keys(r.e.outs)[0]).trim().split('\n').slice(1).map((l) => JSON.parse(l));
    const atts = recs.flatMap((p) => p.attestations || []);
    const located = atts.find((a) => JSON.stringify(a).includes('51.4552345678912'));
    assert.ok(located, 'the latitude has all its digits');
    assert.ok(JSON.stringify(located).includes('-0.123456789012345'), JSON.stringify(located));
    const named = atts.find((a) => a.names?.[0]?.toponym === '007');
    assert.ok(named, 'the name typed as text 007 is 007');
    assert.deepEqual(named.timespans, [{ sourceLabel: '2021-05-04T13:45:30', startEarliest: '2020-07-01', endLatest: '2020-07-02' }]);
    assert.equal(named.occurrenceCount, 42);
    assert.equal(named.certainty, 0.95);
    assert.equal(named.notes, '1234.5678');
  });
}

// A date with a time of day in a column that takes a date alone (from, to): the date is kept, the
// time dropped, and a warning names the cell, so that the user checks the date (a time zone can
// have moved it a day). Here from has a time of day, to is at midnight, and date (free text) has a
// time of day it keeps.
const timed = workbook('xlsx', { t: 'd', v: utc(2020, 6, 1, 9, 30) });
const dateTimes = (r) => r.report.items.filter((i) => i.kind === 'workbook-date-time');

for (const bookType of ['xlsx', 'ods']) {
  const bytes = workbook(bookType, { t: 'd', v: utc(2020, 6, 1, 9, 30) });
  test(`${bookType}: a time of day in from gives the date, and a warning naming the cell`, async () => {
    const r = await go([new File([bytes], `customs.${bookType}`)], 'convert', 'plato-jsonl', { base: 'https://example.org/customs/' });
    assert.deepEqual(errors(r), []);
    const w = dateTimes(r);
    assert.equal(w.length, 1, JSON.stringify(r.report.items));
    assert.equal(w[0].severity, 'warning');
    assert.equal(w[0].count, 1);
    assert.deepEqual(w[0].examples, ['names row 2, from: 2020-07-01 09:30 was read as the date 2020-07-01; check the date.']);
    assert.match(w[0].message, /check each date/);
    const atts = outText(r.e, Object.keys(r.e.outs)[0]).trim().split('\n').slice(1).flatMap((l) => JSON.parse(l).attestations || []);
    const named = atts.find((a) => a.names?.[0]?.toponym === '007');
    assert.deepEqual(named.timespans, [{ sourceLabel: '2021-05-04T13:45:30', startEarliest: '2020-07-01', endLatest: '2020-07-02' }]);
  });
}

test('a date at midnight in to gives the date and no warning; nor does a time of day in date, which takes any text', async () => {
  const r = await go([new File([timed], 'customs.xlsx')], 'check');
  const w = dateTimes(r);
  // The warning is there (for from), so that its naming no other cell says something.
  assert.equal(w.length, 1, JSON.stringify(r.report.items));
  assert.equal(w[0].count, 1);
  assert.ok(w[0].examples.every((e) => /^names row 2, from: /.test(e)), JSON.stringify(w[0].examples));
  assert.ok(!w[0].examples.some((e) => /, (to|date): /.test(e)));
});

test('workbookSheetCsv drops the time only in the columns it is given, and says where', () => {
  const told = [];
  const csv = workbookSheetCsv(XLSX, timed, 'names', { dateOnly: new Set(['from', 'to']), timeDropped: (...a) => told.push(a) });
  assert.match(csv.split('\n')[1], /,2021-05-04T13:45:30,2020-07-01,2020-07-02,/);
  assert.deepEqual(told, [[2, 'from', '2020-07-01 09:30', '2020-07-01']]);
  assert.match(workbookSheetCsv(XLSX, timed, 'names').split('\n')[1], /,2021-05-04T13:45:30,2020-07-01T09:30:00,2020-07-02,/);
});

test('numberText is the shortest round-trip form, never an exponent', () => {
  assert.equal(numberText(23.72754321987), '23.72754321987');
  assert.equal(numberText(42), '42');
  assert.equal(numberText(-0.123456789012345), '-0.123456789012345');
  assert.equal(numberText(1e-7), '0.0000001');
  assert.equal(numberText(-1.5e-7), '-0.00000015');
  assert.equal(numberText(1e21), '1000000000000000000000');
  assert.equal(numberText(1.25e22), '12500000000000000000000');
  for (const n of [1e-7, -1.5e-7, 1.234e-9, 1e21, 1.25e22]) assert.equal(Number(numberText(n)), n);
});

test('dateText: a date at midnight, a date and time, a time of day', () => {
  assert.equal(dateText(utc(1900, 2, 1)), '1900-03-01');
  assert.equal(dateText(utc(2020, 6, 1), 'd/m/yyyy'), '2020-07-01');
  assert.equal(dateText(utc(2021, 4, 4, 13, 45, 30)), '2021-05-04T13:45:30');
  assert.equal(dateText(utc(2021, 4, 4, 13, 45, 30, 250)), '2021-05-04T13:45:30.250');
  assert.equal(dateText(utc(1899, 11, 31, 13, 45), 'hh:mm'), '13:45:00');
  assert.equal(dateText(utc(1899, 11, 31, 13, 45), 'hh"h"mm'), '13:45:00');
  assert.equal(dateText(utc(2021, 4, 4), '[$-409]d mmm yyyy'), '2021-05-04');
});
