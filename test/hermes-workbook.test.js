// A researcher's own workbook (.xlsx, .ods) is a table of places, read through the matching of its
// columns, one sheet at a time (src/engine/input.js workbookSheets, src/engine/hermes/generic.js
// openSheet); a workbook of PLATO's sheets is still the spreadsheet tables. The workbooks are made
// here, in memory (test/workbooks.js). Every test that asserts an absence asserts, in the same test,
// a presence it could have missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { detect, DataError } from '../src/engine/input.js';
import { Report, LOSS_TEXT } from '../src/engine/report.js';
import { genericSource, columnsOf, withSheet, sheetCellText } from '../src/engine/hermes/generic.js';
import { GENERIC_KINDS } from '../src/engine/hermes/columns.js';
import { formatName } from '../src/engine/words.js';
import { go } from './engine.js';
import { workbookBytes, workbookFile, dateCell, numberCell, formulaCell } from './workbooks.js';

const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const TABLES = 'test/fixtures/tables-judgements';

/** Read an input through the generic reader: { input, records, items, kinds, of(kind) }. */
async function readAll(f, options = {}) {
  const input = await detect([f]);
  const rep = new Report();
  const records = [];
  for await (const ev of genericSource(input, rep, options)) if (ev.type === 'record' || ev.type === 'attestation') records.push(ev.value);
  const { items } = rep.toJSON();
  return { input, records, items, kinds: new Set(items.map((i) => i.kind)), of: (k) => items.find((i) => i.kind === k) };
}
const PLACES = [['name', 'id', 'latitude', 'longitude'], ['Oxford', 'ox', 51.75, -1.25], ['Bath', 'ba', 51.38, -2.36]];
const OTHER = [['name', 'id'], ['Wells', 'we'], ['Ely', 'el'], ['York', 'yo']];
const labels = (r) => r.records.map((x) => x.label);

// ---- detection ----------------------------------------------------------------------------------------
test('a workbook of its own is a table of places, its first sheet read; one of PLATO\'s sheets is the tables', async () => {
  for (const name of ['mine.xlsx', 'mine.ods']) {
    const input = await detect([workbookFile([['Places I found', PLACES], ['Others', OTHER]], name)]);
    assert.equal(input.format, 'csv', name);
    assert.equal(input.container, 'workbook');
    assert.deepEqual(input.sheets.map((s) => s.name), ['Places I found', 'Others']);
    assert.equal(input.sheet, 'Places I found');
    assert.match(formatName(input), /the sheet “Places I found” of a workbook/);
  }
  // The control: PLATO's own sheets in a workbook are the tables, as before.
  const wb = XLSX.utils.book_new();
  for (const f of readdirSync(TABLES).filter((x) => x.endsWith('.csv'))) XLSX.utils.book_append_sheet(wb, XLSX.read(readFileSync(`${TABLES}/${f}`, 'utf8'), { type: 'string', raw: true }).Sheets.Sheet1, f.replace('.csv', ''));
  for (const type of ['xlsx', 'ods']) {
    const tables = await detect([new File([XLSX.write(wb, { type: 'array', bookType: type })], `judgements.${type}`)]);
    assert.equal(tables.format, 'tables', type);
    assert.equal(tables.container, 'workbook');
  }
});
test('a lone "places" sheet is the tables when it begins with place_id, and a table of places when it does not', async () => {
  for (const name of ['lone.xlsx', 'lone.ods']) {
    const tables = await detect([workbookFile([['places', [['place_id', 'label'], ['ox', 'Oxford']]], ['Notes', [['x']]]], name)]);
    assert.equal(tables.format, 'tables', name);
    const own = await detect([workbookFile([['places', [['name', 'latitude'], ['Oxford', 51.75]]], ['Notes', [['x']]]], name)]);
    assert.equal(own.format, 'csv', name);
    assert.equal(own.sheet, 'places');
    // Named after a sheet in another case, as the tables reader takes it: the same rule.
    assert.equal((await detect([workbookFile([['Places', [['place_id', 'label'], ['ox', 'Oxford']]]], name)])).format, 'tables', name);
  }
  // Two sheets named after PLATO's are the tables, whatever they begin with (the tables reader then says what is wrong).
  assert.equal((await detect([workbookFile([['places', [['name']]], ['names', [['name']]]])])).format, 'tables');
});

// ---- reading ----------------------------------------------------------------------------------------
test('the first sheet is read and the others are named; --sheet (options.sheet) reads another', async () => {
  for (const name of ['mine.xlsx', 'mine.ods']) {
    const f = workbookFile([['Places I found', PLACES], ['Others', OTHER]], name);
    const first = await readAll(f);
    assert.deepEqual(labels(first), ['Oxford', 'Bath'], name);
    assert.equal(first.of('generic-sheets-not-read').severity, 'warning');
    assert.deepEqual(first.of('generic-sheets-not-read').examples, [`${name}: read "Places I found"; not read "Others"`]);
    const other = await readAll(f, { sheet: 'Others' });
    assert.deepEqual(labels(other), ['Wells', 'Ely', 'York'], name);
    assert.deepEqual(other.of('generic-sheets-not-read').examples, [`${name}: read "Others"; not read "Places I found"`]);
    assert.equal(other.records[0].attestations[0].citations[0].locator, 'row 2');
  }
  // The control: a workbook of one sheet has none not read, and is still read.
  const one = await readAll(workbookFile([['Places', PLACES.map((r) => r.slice(0, 2))]], 'one.xlsx'));
  assert.deepEqual(labels(one), ['Oxford', 'Bath']);
  assert.ok(!one.kinds.has('generic-sheets-not-read'));
  assert.ok(one.kinds.has('generic-stand-in-base'));
});
test('a sheet the workbook does not have is refused, naming the sheets it has', async () => {
  const input = await detect([workbookFile([['A', PLACES], ['B', OTHER]])]);
  assert.throws(() => withSheet(input, 'C'), (e) => e instanceof DataError && e.message === 'The workbook has no sheet "C"; its sheets are "A", "B".');
  assert.equal(withSheet(input, 'B').sheet, 'B');
  // A run given it reports it, and reads nothing.
  const r = await go([workbookFile([['A', PLACES], ['B', OTHER]])], 'check', undefined, { sheet: 'C' });
  assert.ok(r.incomplete);
  assert.match(r.report.items.find((i) => i.kind === 'unreadable').examples[0], /no sheet "C"; its sheets are "A", "B"/);
  const ok = await go([workbookFile([['A', PLACES], ['B', OTHER]])], 'check', undefined, { sheet: 'B' });
  assert.ok(!ok.incomplete);
  assert.equal(ok.report.counts.places, 3);
});
test('a coordinate formatted "0.00" keeps every digit it has', async () => {
  const lat = 51.123456789012345, lon = -1.2345678901234567;
  const f = workbookFile([['Places', [['name', 'latitude', 'longitude'], ['Oxford', numberCell(lat, '0.00'), numberCell(lon, '0.00')]]]]);
  const r = await readAll(f);
  assert.deepEqual(r.records[0].attestations[0].geometries[0].geojson.coordinates, [lon, lat]);
  // The control: the workbook shows the cell as 51.12, which is what reading it as displayed would give.
  const ws = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' }).Sheets.Places;
  assert.equal(ws.B2.w, '51.12');
  assert.match(XLSX.utils.sheet_to_csv(ws, { rawNumbers: false }), /Oxford,51\.12,-1\.23/);
});
test('a date cell is an ISO date, and a date with a time keeps its time, in any time zone', async () => {
  const sheets = [['Places', [['name', 'date', 'seen'], ['Oxford', dateCell(1990, 5, 6), dateCell(1990, 5, 6, 10, 30)], ['Bath', dateCell(1950, 12, 31), dateCell(2001, 1, 1, 0, 1)]]]];
  for (const name of ['dates.xlsx', 'dates.ods']) {
    const { sample } = await columnsOf(await detect([workbookFile(sheets, name)]));
    assert.deepEqual(sample.map((r) => [r.date, r.seen]), [['1990-05-06', '1990-05-06T10:30:00'], ['1950-12-31', '2001-01-01T00:01:00']], name);
    const r = await readAll(workbookFile(sheets, name));
    assert.deepEqual(r.records[0].attestations[0].timespans, [{ sourceLabel: '1990-05-06' }]);
  }
  // Read again in time zones east and west of Greenwich, and in London in summer time: a reading in
  // local time would put midnight on 6 May 1990 on the 5th in London (UTC+1) and New York.
  const dir = mkdtempSync(join(tmpdir(), 'plato-tools-workbook-'));
  try {
    writeFileSync(join(dir, 'dates.xlsx'), workbookBytes(sheets));
    const script = `import { detect } from ${JSON.stringify(new URL('../src/engine/input.js', import.meta.url).href)};
      import { columnsOf } from ${JSON.stringify(new URL('../src/engine/hermes/generic.js', import.meta.url).href)};
      import { readFileSync } from 'node:fs';
      const { sample } = await columnsOf(await detect([new File([readFileSync(${JSON.stringify(join(dir, 'dates.xlsx'))})], 'dates.xlsx')]));
      process.stdout.write(JSON.stringify([new Date(1990, 4, 6).getTimezoneOffset(), sample.map((r) => [r.date, r.seen])]));`;
    const offsets = new Set();
    for (const TZ of ['Europe/London', 'America/New_York', 'Asia/Tokyo']) {
      const c = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ } });
      assert.equal(c.status, 0, c.stderr);
      const [offset, got] = JSON.parse(c.stdout);
      offsets.add(offset);
      assert.deepEqual(got, [['1990-05-06', '1990-05-06T10:30:00'], ['1950-12-31', '2001-01-01T00:01:00']], TZ);
    }
    // The control: the time zones were in force (London was an hour ahead of UTC that day).
    assert.ok(offsets.has(-60) && offsets.size === 3, [...offsets].join());
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(sheetCellText(new Date(Date.UTC(1990, 4, 6))), '1990-05-06');
  assert.equal(sheetCellText(true), 'TRUE');
});
test('a hidden sheet of an xlsx workbook is reported, and not read unless chosen', async () => {
  const f = workbookFile([['Old', OTHER], ['Places', PLACES]], 'hidden.xlsx', { hidden: ['Old'] });
  const input = await detect([f]);
  assert.deepEqual(input.sheets, [{ name: 'Old', hidden: true }, { name: 'Places', hidden: false }]);
  assert.equal(input.sheet, 'Places');
  const r = await readAll(f);
  assert.deepEqual(labels(r), ['Oxford', 'Bath']);
  assert.equal(r.of('generic-sheet-hidden').severity, 'warning');
  assert.deepEqual(r.of('generic-sheet-hidden').examples, ['"Old" in hidden.xlsx, not read']);
  const chosen = await readAll(f, { sheet: 'Old' });
  assert.deepEqual(chosen.of('generic-sheet-hidden').examples, ['"Old" in hidden.xlsx, the sheet read']);
  // The control: nothing hidden, nothing reported, while the sheet not read still is.
  const plain = await readAll(workbookFile([['Old', OTHER], ['Places', PLACES]], 'plain.xlsx'));
  assert.deepEqual(labels(plain), ['Wells', 'Ely', 'York']);
  assert.ok(plain.kinds.has('generic-sheets-not-read'));
  assert.ok(!plain.kinds.has('generic-sheet-hidden'));
  assert.match(LOSS_TEXT['generic-sheet-hidden'], /ODS workbook's are not marked as hidden/);
});
test('a formula saved without its value is reported as a loss; one with its value is read', async () => {
  const f = workbookFile([['Places', [['name', 'latitude', 'longitude', 'note'], ['Oxford', 51.75, -1.25, formulaCell('B2*2')], ['Bath', 51.38, -2.36, formulaCell('B3*2', 102.76)]]]]);
  const r = await readAll(f);
  assert.equal(GENERIC_KINDS['generic-sheet-formula-no-value'], 'loss');
  assert.deepEqual(r.of('generic-sheet-formula-no-value').examples, ['cell D2 of "Places", column "note": =B2*2']);
  assert.equal(r.of('generic-sheet-formula-no-value').count, 1);
  // The control: the formula with its value is carried, as the value.
  assert.equal(r.records[1].attestations[0].notes, 'note: 102.76');
  assert.equal(r.records[0].attestations[0].notes, undefined);
});
test('an empty sheet is an error, and its columns cannot be read', async () => {
  const f = workbookFile([['Places', PLACES], ['Empty', []]]);
  const r = await readAll(f, { sheet: 'Empty' });
  assert.equal(r.of('generic-sheet-empty').severity, 'error');
  assert.deepEqual(r.records, []);
  await assert.rejects(columnsOf(withSheet(await detect([f]), 'Empty')), /holds nothing.*the sheet "Empty"/);
  // The control: its other sheet is read.
  assert.deepEqual(labels(await readAll(f)), ['Oxford', 'Bath']);
  assert.equal((await readAll(f)).of('generic-sheet-empty'), undefined);
});

// ---- the command line ---------------------------------------------------------------------------------
test('the command line reads the sheet --sheet names, says which in the guess, and refuses one the workbook lacks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plato-tools-workbook-'));
  const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  try {
    const p = join(dir, 'mine.xlsx');
    writeFileSync(p, workbookBytes([['Places', PLACES], ['Others', OTHER]]));
    const first = cli('check', p);
    assert.equal(first.code, 0, first.out + first.err);
    assert.match(first.out, /the sheet “Places” of a workbook/);
    assert.match(first.out, /Columns of the sheet "Places" read as .*another sheet with --sheet NAME/);
    assert.match(first.out, /2 places/);
    const other = cli('check', '--json', '--sheet', 'Others', p);
    assert.equal(other.code, 0, other.out + other.err);
    const line = JSON.parse(other.out.split('\n')[0]);
    assert.equal(line.sheet, 'Others');
    assert.equal(line.counts.places, 3);
    assert.deepEqual(line.sheets, ['Places', 'Others']);
    const wrong = cli('check', '--sheet', 'Elsewhere', p);
    assert.equal(wrong.code, 2);
    assert.match(wrong.err, /no sheet "Elsewhere"; its sheets are "Places", "Others"/);
    const csv = join(dir, 'mine.csv');
    writeFileSync(csv, 'name\nOxford\n');
    const notBook = cli('check', '--sheet', 'Places', csv);
    assert.equal(notBook.code, 2);
    assert.match(notBook.err, /--sheet is for a workbook/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
