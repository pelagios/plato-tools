import { PLATO_REPO } from './paths.js';
// The spreadsheet tables, streamed (src/engine/pipeline.js, tablesSource; src/formats/csv.js;
// TableStore in src/lib/store.js): rows exactly as Papa.parse with header: true made them, however
// the text comes in chunks; each place with its own rows, in order; a sheet that cannot be read
// reported on its own; and, with SCALE=1, a million places in 512 MB of heap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync, openSync, writeSync, readSync, closeSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Papa from 'papaparse';
import { zipSync, strToU8 } from 'fflate';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { go, outText } from './engine.js';
import { csvRecords, papaRecords, papaRow } from '../src/formats/csv.js';
import { TableStore, openSqlite } from '../src/lib/store.js';
import { storageNeed } from '../src/engine/storage.js';
import { detect } from '../src/engine/input.js';
import { openNodeSqlite } from '../src/node/sqlite.js';

const EX = `${PLATO_REPO}/schemas/tables/examples`;
const sheetsOf = (dir) => Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.csv')).map((f) => [f, readFileSync(`${dir}/${f}`, 'utf8')]));
const filesOf = (sheets) => Object.entries(sheets).map(([f, t]) => new File([t], f));
const records = (r, name) => outText(r.e, name).trim().split('\n').slice(1).map((l) => JSON.parse(l));
async function* inChunks(text, size) { for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size); }

// ---- rows as Papa made them --------------------------------------------------------------------
test('a sheet streamed in chunks of any size gives exactly the header and rows Papa.parse gives with header: true', async () => {
  const texts = {
    'repeated headings': 'a,b,b,b_1,b\n1,2,3,4,5\n',
    'a blank first line, then repeated headings (not renamed: the later one wins)': '\na,b,b\n1,2,3\n',
    'a first line of empty cells': ',,\na,b\n1,2\n',
    'a byte-order mark on a heading': 'a,﻿b\n1,2\n',
    'short and long rows': 'a,b,c\n1\n1,2,3,4,5\n\n  ,  \n6,7,8\n',
    'a heading __proto__': 'a,__proto__\n1,2\n',
    'empty': '',
    'only blank lines': '\n\n \n',
    'CRLF and a quoted line break': 'a,b\r\n"x\r\ny",2\r\n3,"q ""z"" q"\r\n',
    'semicolons': 'a;b\n1;"2;3"\n',
  };
  let compared = 0;
  for (const [what, text] of Object.entries(texts)) {
    const papa = Papa.parse(text, { header: true, skipEmptyLines: 'greedy' });
    for (const size of [1, 2, 3, 7, 1024]) {
      let fields = null;
      const rows = [];
      for await (const cells of papaRecords(csvRecords(inChunks(text, size), { keepBlank: true }), (f) => { fields = f; })) rows.push(papaRow(fields, cells));
      assert.deepEqual(fields, papa.meta.fields, `${what}: header, in chunks of ${size}`);
      assert.deepEqual(rows, papa.data, `${what}: rows, in chunks of ${size}`);
      compared++;
    }
  }
  assert.equal(compared, 50);
  // The renaming is Papa's: b, b_2 (b_1 being taken), b_1, b_3.
  assert.deepEqual(Papa.parse(texts['repeated headings'], { header: true }).meta.fields, ['a', 'b', 'b_2', 'b_1', 'b_3']);
});

// ---- in chunks of 1 KB -----------------------------------------------------------------------------
/** A file whose stream gives `size` bytes at a time, counting what it gave. */
class Chunked extends File {
  constructor(bytes, name, size) { super([bytes], name); this.bytes = bytes; this.size_ = size; this.chunks = 0; }
  stream() {
    let at = 0;
    return new ReadableStream({ pull: (c) => { if (at >= this.bytes.length) return c.close(); c.enqueue(this.bytes.subarray(at, at + this.size_)); at += this.size_; this.chunks++; } });
  }
}
test('tables whose sheets arrive 1 KB at a time, rows straddling the chunks, read as they do whole, with an issue past a boundary placed', async () => {
  const sheets = sheetsOf(`${EX}/survey`);
  // Enough rows for names.csv to run to many kilobytes, one of them broken (a date that is required, empty) far in.
  const [head, ...rows] = sheets['names.csv'].trimEnd().split('\n');
  const many = Array.from({ length: 150 }, (_, i) => rows[i % rows.length].replace(/^(\w+),([^,]*),/, `$1,$2 ${i},`));
  const bad = 127;
  const cells = Papa.parse(many[bad]).data[0];
  cells[head.split(',').indexOf('date')] = '';
  many[bad] = Papa.unparse([cells]);
  const text = [head, ...many].join('\n') + '\n';
  const bytes = new TextEncoder().encode(text);
  assert.ok(bytes.length > 10 * 1024, `names.csv is ${bytes.length} bytes`);
  // A row straddles a boundary: some multiple of 1024 falls inside a row, not just after a line break.
  const straddled = [];
  for (let k = 1024; k < bytes.length; k += 1024) if (bytes[k - 1] !== 0x0a) straddled.push(k);
  assert.ok(straddled.length >= 5, `boundaries inside rows: ${straddled}`);
  // The broken row itself lies past the first boundaries, and past the first 64 KB guess is not needed.
  const badAt = new TextEncoder().encode([head, ...many.slice(0, bad)].join('\n') + '\n').length;
  assert.ok(badAt > 8 * 1024, `the broken row starts at byte ${badAt}`);

  const chunked = new Chunked(bytes, 'names.csv', 1024);
  const whole = new File([bytes], 'names.csv');
  const others = filesOf(Object.fromEntries(Object.entries(sheets).filter(([f]) => f !== 'names.csv')));
  const a = await go([...others, chunked], 'convert', 'plato-jsonl');
  const b = await go([...others, whole], 'convert', 'plato-jsonl');
  assert.ok(chunked.chunks >= Math.ceil(bytes.length / 1024), `the sheet came in ${chunked.chunks} chunks`);
  assert.deepEqual(a.report, b.report);
  const out = Object.keys(a.e.outs)[0];
  assert.ok(outText(a.e, out).length > 10000, out);
  assert.equal(outText(a.e, out), outText(b.e, out));
  // The issue is found, at the row of the sheet it is in (the header being row 1).
  const issue = a.report.items.find((i) => i.kind === 'table' && /column date: is required/.test(i.message));
  assert.ok(issue, JSON.stringify(a.report.items));
  assert.deepEqual(issue.examples, [`names.csv row ${bad + 2} date: is required`]);
  const toponyms = records(a, out).flatMap((r) => r.attestations.filter((x) => x.names).map((x) => x.names[0].toponym));
  assert.equal(toponyms.length, 150, 'every row read, none merged or split');
  assert.deepEqual(toponyms.map((t) => +t.split(' ').pop()).sort((x, y) => x - y), Array.from({ length: 150 }, (_, i) => i));
});

// ---- order ---------------------------------------------------------------------------------------
const tiny = (over) => {
  const s = sheetsOf(`${EX}/survey`);
  for (const f of ['names.csv', 'locations.csv', 'types.csv', 'relations.csv', 'connections.csv', 'properties.csv', 'identities.csv']) s[f] = s[f].split('\n')[0] + '\n';
  return { ...s, ...over };
};
const NAMES = 'place_id,name,language,script,romanized,name_type,form_status,occurrence_context,occurrence_count,transcription_accuracy,transcription_completeness,date,from,to,source_id,locator,attribution,citation_function,certainty,certainty_level,denied,stance,notes\n';
const LOCS = 'place_id,latitude,longitude,wkt,geometry_role,precision_km,date,from,to,source_id,locator,attribution,citation_function,certainty,certainty_level,denied,stance,notes\n';
const IDS = 'place_id,same_as,match_type,certainty,basis,source_id\n';
const name = (p, n) => `${p},${n},,,,,,,,,,1086,1086,1086,domesday,,,,,,,,\n`;
const loc = (p, lat) => `${p},${lat},0.1,,,,1086,1086,1086,domesday,,,,,,,,\n`;
test('each place has its own rows, sheet by sheet in the order of the sheets, each sheet in its own order, however they interleave', async () => {
  const r = await go(filesOf(tiny({
    'places.csv': 'place_id,label,country_codes\nzeta,Zeta,GB\nalpha,Alpha,GB\nmid,Mid,GB\n',
    'locations.csv': LOCS + loc('alpha', 51) + loc('zeta', 52) + loc('alpha', 50),
    'names.csv': NAMES + name('alpha', 'A2') + name('zeta', 'Z1') + name('mid', 'M1') + name('alpha', 'A1') + name('zeta', 'Z2') + name('alpha', 'A3'),
    'identities.csv': IDS + 'zeta,https://example.org/z2,closeMatch,,,\nalpha,https://example.org/a1,exactMatch,,,\nzeta,https://example.org/z1,exactMatch,,,\n',
  })), 'convert', 'plato-jsonl');
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  const recs = records(r, 'about.jsonl');
  const shape = (rec) => [rec.entityIdentifier, rec.attestations.map((a) => a.names?.[0].toponym || `@${a.geometries[0].reprPoint[1]}`), (rec.identityRelations || []).map((i) => i.object.split('/').pop())];
  assert.deepEqual(recs.map(shape), [
    ['zeta', ['Z1', 'Z2', '@52'], ['z2', 'z1']],
    ['alpha', ['A2', 'A1', 'A3', '@51', '@50'], ['a1']],
    ['mid', ['M1'], []],
  ]);
});
test('a place_id given to two places gives each of them every row with it, as before', async () => {
  const r = await go(filesOf(tiny({
    'places.csv': 'place_id,label,country_codes\ntwice,First,GB\nonce,Once,GB\ntwice,Second,GB\n',
    'names.csv': NAMES + name('twice', 'T1') + name('once', 'O1') + name('twice', 'T2'),
    'identities.csv': IDS + 'twice,https://example.org/t,exactMatch,,,\n',
  })), 'convert', 'plato-jsonl');
  const recs = records(r, 'about.jsonl');
  assert.deepEqual(recs.map((x) => [x.label, x.attestations.map((a) => a.names[0].toponym), x.identityRelations?.length || 0]),
    [['First', ['T1', 'T2'], 1], ['Once', ['O1'], 0], ['Second', ['T1', 'T2'], 1]]);
  assert.deepEqual(recs[0].attestations, recs[2].attestations);
  assert.ok(r.report.items.some((i) => i.kind === 'table' && /place_id: '…' is used by an earlier row/.test(i.message)), 'and it is reported');
});
test('the join of places and their rows walks the rows in order with no sort, in SQLite WebAssembly and in Node', async () => {
  for (const db of [await openSqlite(sqlite3InitModule, { memory: true }), openNodeSqlite(join(mkdtempSync(join(tmpdir(), 'plato-join-')), 'j.sqlite3'))]) {
    const s = new TableStore(db);
    s.add(1, 1, 'p', ['p']); s.add(3, 1, 'p', ['n']);
    s.index();
    const plan = [];
    const q = db.prepare('EXPLAIN QUERY PLAN ' + TableStore.JOIN);
    q.bind([3, 1, 2]);
    while (q.step()) plan.push(q.get(3));
    q.finalize();
    assert.ok(plan.some((p) => /USING INDEX r_k/.test(p)), plan.join('; '));
    assert.ok(!plan.some((p) => /TEMP B-TREE/.test(p)), `sorted: ${plan.join('; ')}`);
    // The control: ordered by the place's row number instead, SQLite must sort.
    const sorted = [];
    const q2 = db.prepare('EXPLAIN QUERY PLAN ' + TableStore.JOIN.replace('ORDER BY p.rowid', 'ORDER BY p.n'));
    q2.bind([3, 1, 2]);
    while (q2.step()) sorted.push(q2.get(3));
    q2.finalize();
    assert.ok(sorted.some((p) => /TEMP B-TREE/.test(p)), `control: ${sorted.join('; ')}`);
    assert.deepEqual([...s.joined(1, 1, 3)], [[1, ['p'], 3, ['n']]]);
    s.close();
  }
});
test('a row of cells comes back from the database as it went in, whatever is in its cells, in SQLite WebAssembly and in Node', async () => {
  const rows = [['a', '', 'c'], [''], ['\ufeffbom first', 'x'], ['unit\u001fseparator', ''], ['"quoted", with comma', 'line\nbreak', '[', '\u001f']];
  for (const db of [await openSqlite(sqlite3InitModule, { memory: true }), openNodeSqlite(join(mkdtempSync(join(tmpdir(), 'plato-cells-')), 'c.sqlite3'))]) {
    const s = new TableStore(db);
    rows.forEach((r, i) => s.add(1, i + 1, 'k', r));
    assert.deepEqual([...s.rows(1, s.mark())], rows);
    s.index();
    assert.deepEqual(s.lookup(1, 'k'), rows.at(-1));
    s.close();
  }
});
test('the keys the validator has seen are kept in the database: new once, and bound as strings', async () => {
  const s = new TableStore(await openSqlite(sqlite3InitModule, { memory: true }));
  assert.equal(s.keyAdd('places', 'a'), true);
  assert.equal(s.keyAdd('places', 'a'), false);
  assert.equal(s.keyAdd('sources', 'a'), true, 'another table');
  assert.equal(s.keyAdd('places', '1'), true);
  assert.equal(s.keyAdd('places', '01'), true, 'not the number 1');
  assert.equal(s.keyHas('places', '01'), true);
  assert.equal(s.keyHas('places', 'b'), false);
  s.close();
});

// ---- a sheet that cannot be read --------------------------------------------------------------------
test('a sheet that cannot be read is an error of its own, the other sheets are still checked, and nothing is written', async () => {
  const s = sheetsOf(`${EX}/survey`);
  const broken = { ...s, 'names.csv': s['names.csv'].replace('\ncambridge,Grantanbrycg,', '\ncambridge,"Grant"anbrycg,'),
    'types.csv': s['types.csv'].replace('bunsty,hundred,', 'bunsty,,') };   // a required cell, empty: an ordinary issue
  for (const files of [filesOf(broken), [new File([zipSync(Object.fromEntries(Object.entries(broken).map(([f, t]) => [f, strToU8(t)])))], 'survey.zip')]]) {
    const r = await go(files, 'convert', 'plato-jsonl');
    const items = r.report.items.map((i) => `${i.kind}: ${i.message}`);
    assert.ok(items.includes('table: names.csv cannot be read, so it is not checked, and nothing is converted; the other sheets are checked'), items.join('\n'));
    assert.match(r.report.items.find((i) => /^names\.csv cannot/.test(i.message)).examples[0], /^names\.csv( in survey\.zip)?: The CSV file has a stray quotation mark .* near line 2,/);
    assert.ok(items.includes('table: types.csv, column type_label: is required'), `the other sheets are checked: ${items.join('\n')}`);
    assert.ok(!items.some((i) => /unreadable/.test(i)), 'not the whole input');
    assert.equal(r.incomplete, true);
    assert.deepEqual(r.outputs, []);
  }
  // The control: the same tables with the quotation mark doubled read, and are written.
  const ok = await go(filesOf({ ...broken, 'names.csv': s['names.csv'] }), 'convert', 'plato-jsonl');
  assert.ok(!ok.incomplete);
  assert.equal(ok.outputs.length, 1);
});
test('a sheet in a zip that is damaged is unreadable on its own; a zip with no central directory is refused whole', async () => {
  const s = sheetsOf(`${EX}/survey`);
  const zip = zipSync(Object.fromEntries(Object.entries(s).map(([f, t]) => [f, strToU8(t)])), { level: 9 });
  // Corrupt the middle of names.csv's compressed bytes: the central directory still lists it.
  const at = Buffer.from(zip).indexOf(Buffer.from('names.csv')) + 'names.csv'.length + 40;
  const bad = zip.slice(); bad[at] ^= 0xff; bad[at + 1] ^= 0xff;
  const r = await go([new File([bad], 'survey.zip')], 'check');
  const e = r.report.items.find((i) => /^names\.csv cannot be read/.test(i.message));
  assert.ok(e, JSON.stringify(r.report.items));
  assert.match(e.examples[0], /^names\.csv in survey\.zip is damaged|^names\.csv in survey\.zip.*not encoded as UTF-8|^names\.csv in survey\.zip: /);
  assert.equal(r.incomplete, true);
  const good = await go([new File([zip], 'survey.zip')], 'check');
  assert.equal(good.report.errors, 0, 'control');
  // No central directory at all: the whole input is unreadable.
  const cut = await go([new File([zip.slice(0, zip.length - 30)], 'survey.zip')], 'check');
  assert.equal(cut.incomplete, true);
  assert.match(cut.report.items.find((i) => i.kind === 'unreadable')?.examples[0] || '', /The zip is damaged or incomplete/);
});

// ---- the page's storage estimate -------------------------------------------------------------------
test('the storage the page asks for allows for the tables\' working database and output, from the size of their text', async () => {
  const s = sheetsOf(`${EX}/survey`);
  const text = Object.values(s).reduce((n, t) => n + Buffer.byteLength(t), 0);
  const zip = new File([zipSync(Object.fromEntries(Object.entries(s).map(([f, t]) => [f, strToU8(t)])), { level: 9 })], 'survey.zip');
  const z = await detect([zip]);
  assert.equal(z.textBytes, text, 'the sheets\' size, from the central directory');
  assert.notEqual(zip.size, text, 'the zip is not the size of its text');
  assert.equal(storageNeed(z, [zip]), text * (2.2 + 7));
  const csvs = filesOf(s);
  assert.equal(storageNeed(await detect(csvs), csvs), text * (2.2 + 7));
  // The control: any other input, as before, four times its size (forty, gzipped).
  const jsonl = [new File(['{"profile":"place-centric"}\n'], 'x.jsonl')];
  assert.equal(storageNeed(await detect(jsonl), jsonl), jsonl[0].size * 4);
});

// ---- at scale (SCALE=1) -------------------------------------------------------------------------------
// Generated tables of 200,000 and 1,000,000 places, each with two names, a location, a type and an
// identity (six rows a place), the rows of each sheet in an order other than the places'. Converted
// to PLATO JSON Lines by the command line with 512 MB of heap: it must succeed, and its peak resident
// memory stay under 600 MB.
function writeTables(dir, n) {
  const meta = JSON.parse(readFileSync('public/plato/csv-metadata.json', 'utf8'));
  const columns = Object.fromEntries(meta.tables.map((t) => [t.url.replace(/\.csv$/, ''), t.tableSchema.columns.filter((c) => !c.virtual).map((c) => c.titles)]));
  // Each sheet with its own header, and each row from an object by column (no value has a comma).
  const sheet = (name, row, count) => {
    const fd = openSync(join(dir, name + '.csv'), 'w');
    let buf = columns[name].join(',') + '\n';
    for (let i = 0; i < count; i++) { const o = row(i); buf += columns[name].map((c) => o[c] ?? '').join(',') + '\n'; if (buf.length > 1 << 20) { writeSync(fd, buf); buf = ''; } }
    writeSync(fd, buf); closeSync(fd);
  };
  const S = 1000;
  // A permutation of the places, so that no sheet is in the places' order.
  const perm = (i) => (i * 7919) % n;
  const cited = (p) => ({ date: '1086', from: '1086', to: '1086', source_id: `s${p % S}` });
  sheet('about', () => ({ title: 'Scale test', licence: 'https://creativecommons.org/licenses/by/4.0/', status: 'draft', base_uri: 'https://example.org/scale/' }), 1);
  sheet('sources', (i) => ({ source_id: `s${i}`, title: `Source ${i}`, date: 'undated' }), S);
  sheet('places', (i) => ({ place_id: `p${i}`, label: `Place ${i}`, country_codes: 'GB' }), n);
  sheet('names', (i) => { const p = perm(i >> 1); return { place_id: `p${p}`, name: `Name ${p} ${i & 1 ? 'b' : 'a'}`, ...cited(p) }; }, 2 * n);
  sheet('locations', (i) => { const p = perm(n - 1 - i); return { place_id: `p${p}`, latitude: (p % 180) - 89.5, longitude: (p % 360) - 179.5, ...cited(p) }; }, n);
  sheet('types', (i) => { const p = perm(i); return { place_id: `p${p}`, type_label: 'settlement', ...cited(p) }; }, n);
  sheet('identities', (i) => ({ place_id: `p${perm(i)}`, same_as: `https://example.org/other/${perm(i)}`, match_type: 'closeMatch' }), n);
  for (const empty of ['relations', 'connections', 'properties']) sheet(empty, () => ({}), 0);
}
for (const n of [200000, 1000000]) {
  test(`at scale: ${n.toLocaleString('en-GB')} places of spreadsheet tables convert in 512 MB of heap`, { skip: process.env.SCALE ? false : 'set SCALE=1 to run', timeout: 3600000 }, () => {
    const root = mkdtempSync(join(process.env.SCALE_DIR || tmpdir(), 'plato-scale-'));
    const dir = join(root, 'tables'), out = join(root, 'out'), work = join(root, 'work');
    for (const d of [dir, out, work]) mkdirSync(d);
    try {
      writeTables(dir, n);
      assert.equal(readdirSync(dir).length, 10);
      const text = readdirSync(dir).reduce((s, f) => s + statSync(join(dir, f)).size, 0);
      const r = spawnSync('/usr/bin/time', ['-f', 'RSS %M KB, %e s', process.execPath, '--max-old-space-size=512', 'bin/plato-tools.mjs', 'convert', '--to', 'plato-jsonl', '--json', '--out', out, '--work-dir', work, dir], { encoding: 'utf8', maxBuffer: 1 << 26 });
      const res = JSON.parse(r.stdout.trim().split('\n').find((l) => l.includes('"type":"input"')));
      const [, rss, secs] = /RSS (\d+) KB, ([\d.]+) s/.exec(r.stderr) || [];
      const outBytes = readdirSync(out).reduce((s, f) => s + statSync(join(out, f)).size, 0);
      console.log(`SCALE ${n} places: ${secs} s, peak RSS ${Math.round(rss / 1024)} MB, tables ${Math.round(text / 1e6)} MB, working database ${Math.round(res.storeBytes / 1e6)} MB, output ${Math.round(outBytes / 1e6)} MB`);
      assert.equal(r.status, 0, r.stderr.slice(-2000));
      assert.equal(res.status, 'ok', JSON.stringify(res).slice(0, 2000));
      assert.equal(res.errors, 0, JSON.stringify(res.items).slice(0, 2000));
      assert.equal(res.counts.places, n);
      assert.equal(res.counts.attestations, 4 * n);
      assert.ok(+rss / 1024 < 600, `peak RSS ${Math.round(rss / 1024)} MB`);
      // The first record is the first place, with its own rows.
      const fd = openSync(join(out, readdirSync(out)[0]), 'r'), head = Buffer.alloc(65536);
      const got = readSync(fd, head, 0, head.length, 0); closeSync(fd);
      const first = JSON.parse(head.subarray(0, got).toString('utf8').split('\n')[1]);
      assert.equal(first.entityIdentifier, 'p0');
      assert.deepEqual(first.attestations.map((a) => a.names?.[0].toponym || a.types?.[0].label || 'location'), ['Name 0 a', 'Name 0 b', 'location', 'settlement']);
      assert.equal(first.identityRelations[0].object, 'https://example.org/other/0');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
