import { PLATO_REPO } from './paths.js';
// The command line (bin/plato-tools.mjs), run as a user runs it: a separate process, files on
// disk, exit status and output read back. Conversions are compared with what the engine gives
// through the in-memory test path (test/engine.js), so the command line is shown to add nothing
// and lose nothing on the way to disk.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import * as XLSX from 'xlsx';
import { file, go } from './engine.js';

const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const jsonLines = (out) => out.trim().split('\n').map((l) => JSON.parse(l));
const made = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'plato-tools-cli-test-')); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const EX = `${PLATO_REPO}/schemas/examples`;
const TABLES = `${PLATO_REPO}/schemas/tables/examples`;
const DEFAULT_BASE = 'https://example.org/my-dataset/';

/** The customs tables in a directory of their own, with names.csv citing a place that does not exist. */
function brokenTables() {
  const dir = join(scratch(), 'broken');
  mkdirSync(dir);
  for (const f of readdirSync(`${TABLES}/customs`)) copyFileSync(`${TABLES}/customs/${f}`, join(dir, f));
  const names = readFileSync(join(dir, 'names.csv'), 'utf8');
  assert.match(names, /\nbristol,/, 'the fixture has the row to break');
  writeFileSync(join(dir, 'names.csv'), names.replace('\nbristol,', '\nnowhere,'));
  return dir;
}
const brokenNt = () => { const p = join(scratch(), 'broken.nt'); writeFileSync(p, '<https://x.org/a> <https://w3id.org/plato#notes> "fine" .\n<https://x.org/a> <https://w3id.org/plato#notes "broken .\n'); return p; };

// ---- check: exit status and the report ------------------------------------------------------------
test('check: good tables exit 0, with the summary in the words the page uses', () => {
  const r = cli('check', `${TABLES}/customs`);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /customs\/: PLATO spreadsheet tables/);
  assert.match(r.out, /\n {2}No problems found\. Read 2 places, 4 attestations\.\n/);
  assert.match(r.out, /\nChecked 1 input: 1 without problems, 0 with problems\.\n$/);
});
test('control: tables with an unknown place_id exit 1, and the problem is reported with where it is', () => {
  const r = cli('check', brokenTables());
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /\n {2}1 problem found\. Read 2 places/);
  assert.match(r.out, /Problems\. These must be fixed for the data to be valid PLATO\.\n {4}× 1 {2}names\.csv, column place_id: '…' is not a place_id in places\.csv\n/);
  assert.match(r.out, /\n {8}names\.csv row 2 place_id: 'nowhere' is not a place_id in places\.csv\n/);
  assert.match(r.out, /1 with problems \(1 problem in all\)/);
});
test('control: a broken N-Triples line exits 1, with its line number', () => {
  const r = cli('check', brokenNt());
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /broken\.nt: RDF \(N-Triples\)/);
  assert.match(r.out, /× 1 {2}A line is not valid N-Triples\n {8}line 2: /);
});
test('control: a JSON document cut short exits 1, not 0', () => {
  const p = join(scratch(), 'cut.json');
  writeFileSync(p, readFileSync(`${EX}/place-centric-constantinople.json`, 'utf8').slice(0, 1500));
  const r = cli('check', p);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /The file could not be read to the end.*\n.*stops before it is complete/);
});
test('check: several inputs in one run, each reported, then the total; any problem makes it 1', () => {
  const r = cli('check', `${TABLES}/customs`, brokenTables(), `${EX}/place-centric-constantinople.json`);
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal((r.out.match(/^\S.*: (PLATO spreadsheet tables|a PLATO JSON document)/gm) || []).length, 3, r.out);
  assert.match(r.out, /\nChecked 3 inputs: 2 without problems, 1 with problems \(1 problem in all\)\.\n$/);
});
test('check: an input that cannot be read makes it 2, and the others are still checked', () => {
  const r = cli('check', `${TABLES}/customs`, join(scratch(), 'no-such-file.nt'), `${PLATO_REPO}/README.md`);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /no-such-file\.nt\n {2}Could not be checked: There is no such file or directory\./);
  assert.match(r.out, /README\.md\n {2}Could not be checked: The format of this file could not be recognised\./);
  assert.match(r.out, /No problems found\. Read 2 places/);
  assert.match(r.out, /Checked 3 inputs: 1 without problems, 0 with problems, 2 could not be checked\./);
});
test('usage problems exit 2, with a message on stderr and nothing on stdout', () => {
  for (const args of [[], ['frobnicate', 'x'], ['check'], ['check', '--no-such-flag', 'x'], ['convert', 'x.nt'], ['convert', '--to', 'pdf', 'x.nt'], ['check', '--to', 'lpf', 'x.nt']]) {
    const r = cli(...args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}${r.err}`);
    assert.equal(r.out, '', args.join(' '));
    assert.match(r.err, /^plato-tools: .+\nRun "plato-tools --help"/, args.join(' '));
  }
  const h = cli('--help');
  assert.equal(h.code, 0);
  for (const t of ['plato-jsonl', 'plato-json', 'ntriples', 'tables', 'lpf-seq', 'lpf']) assert.match(h.out, new RegExp(`\\n  ${t} +\\S`), t);
});

// ---- --json -------------------------------------------------------------------------------------
test('--json: one object per input, then the total, and the report is the engine\'s own', async () => {
  const broken = brokenTables();
  const r = cli('check', '--json', broken, `${TABLES}/customs`, join(scratch(), 'missing.jsonl'));
  assert.equal(r.code, 2, r.out + r.err);
  const lines = jsonLines(r.out);
  assert.deepEqual(lines.map((l) => [l.type, l.status]), [['input', 'problems'], ['input', 'ok'], ['input', 'failed'], ['total', undefined]]);
  const [bad, good, missing, total] = lines;
  assert.equal(bad.format, 'tables'); assert.equal(bad.files.length, 8); assert.equal(bad.errors, 1);
  const engine = await go(readdirSync(broken).map((f) => file(join(broken, f))), 'check', undefined, { base: DEFAULT_BASE, typing: true, name: 'broken' });
  assert.deepEqual(bad.items, engine.report.items);
  assert.deepEqual(bad.counts, engine.report.counts);
  assert.equal(good.errors, 0); assert.equal(good.counts.places, 2);
  assert.match(missing.message, /no such file/);
  assert.deepEqual({ ...total, outputBytes: undefined }, { type: 'total', action: 'check', target: null, inputs: 3, ok: 1, problems: 1, failed: 1, errors: 1, outputs: 0, outputBytes: undefined, exitCode: 2 });
});

// ---- grouping ------------------------------------------------------------------------------------
test('CSV files named one by one are one set of tables per directory', () => {
  const names = (d) => readdirSync(`${TABLES}/${d}`).filter((f) => f.endsWith('.csv')).map((f) => `${TABLES}/${d}/${f}`);
  const r = cli('check', '--json', ...names('customs'), ...names('survey'));
  assert.equal(r.code, 0, r.out + r.err);
  const lines = jsonLines(r.out).filter((l) => l.type === 'input');
  assert.deepEqual(lines.map((l) => [l.files.length, l.counts.places]), [[8, 2], [8, 3]]);
});
test('a workbook, and the zip the command line writes, are each one set of tables', () => {
  const dir = scratch();
  const wb = XLSX.utils.book_new();
  for (const f of readdirSync(`${TABLES}/customs`)) XLSX.utils.book_append_sheet(wb, XLSX.read(readFileSync(`${TABLES}/customs/${f}`, 'utf8'), { type: 'string', raw: true }).Sheets.Sheet1, f.replace('.csv', ''));
  writeFileSync(join(dir, 'customs.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  const c = cli('convert', '--to', 'tables', '--out', dir, `${TABLES}/customs`);
  assert.equal(c.code, 0, c.out + c.err);
  const r = cli('check', '--json', join(dir, 'customs.xlsx'), join(dir, 'customs-tables.zip'));
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(jsonLines(r.out).filter((l) => l.type === 'input').map((l) => [l.format, l.counts.places]), [['tables', 2], ['tables', 2]]);
});

// ---- convert: what reaches the disk is what the engine produces -----------------------------------
const bytesOf = (parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p))));
const zipContents = (buf) => Object.fromEntries(Object.entries(unzipSync(new Uint8Array(buf))).map(([k, v]) => [k, strFromU8(v)]));
const CASES = [
  // [what, CLI arguments, the files the engine is given, engine options, target]
  ['tables -> JSON Lines, with --base', [`${TABLES}/customs`, '--base', 'https://example.org/customs/'], () => readdirSync(`${TABLES}/customs`).map((f) => file(`${TABLES}/customs/${f}`)), { base: 'https://example.org/customs/', name: 'customs' }, 'plato-jsonl'],
  ['tables -> tables (a zip)', [`${TABLES}/survey`], () => readdirSync(`${TABLES}/survey`).map((f) => file(`${TABLES}/survey/${f}`)), { name: 'survey' }, 'tables'],
  ['place-centric JSON -> N-Triples, typed by default', [`${EX}/place-centric-constantinople.json`], () => [file(`${EX}/place-centric-constantinople.json`)], { typing: true }, 'ntriples'],
  ['place-centric JSON -> N-Triples, --no-typing', [`${EX}/place-centric-constantinople.json`, '--no-typing'], () => [file(`${EX}/place-centric-constantinople.json`)], { typing: false }, 'ntriples'],
  ['place-centric JSON -> LPF', [`${EX}/place-centric-constantinople.json`], () => [file(`${EX}/place-centric-constantinople.json`)], {}, 'lpf'],
  ['attestation-centric JSON -> JSON document (through the store)', [`${EX}/attestation-centric-customs.json`], () => [file(`${EX}/attestation-centric-customs.json`)], {}, 'plato-json'],
  ['Turtle -> JSON Lines (through the store)', [`${PLATO_REPO}/examples/survey-attestations.ttl`], () => [file(`${PLATO_REPO}/examples/survey-attestations.ttl`)], {}, 'plato-jsonl'],
  ['LPF -> LPF sequence', ['test/fixtures/lpf-sample-v1.2.2.geojson'], () => [file('test/fixtures/lpf-sample-v1.2.2.geojson')], {}, 'lpf-seq'],
];
for (const [what, args, files, options, target] of CASES) {
  test(`convert writes to disk exactly what the engine produces: ${what}`, async () => {
    const out = scratch();
    const r = cli('convert', '--to', target, '--out', out, '--json', ...args);
    assert.equal(r.code, 0, r.out + r.err);
    const [line] = jsonLines(r.out);
    const engine = await go(files(), 'convert', target, { base: DEFAULT_BASE, typing: true, ...options });
    const names = Object.keys(engine.e.outs);
    assert.equal(names.length, 1);
    assert.deepEqual(readdirSync(out), names, 'the same output, under the same name');
    assert.deepEqual(line.outputs, [{ path: join(out, names[0]), size: readFileSync(join(out, names[0])).length }]);
    const disk = readFileSync(join(out, names[0])), mem = bytesOf(engine.e.outs[names[0]]);
    assert.ok(mem.length > 100, `the engine wrote ${mem.length} bytes`);
    // A zip records when it was made, so zips are compared by what they hold.
    if (target === 'tables') assert.deepEqual(zipContents(disk), zipContents(mem));
    else assert.ok(disk.equals(mem), `${names[0]}: ${disk.length} bytes on disk, ${mem.length} from the engine`);
    assert.deepEqual(line.items, engine.report.items);
  });
}
test('the typing flag reaches the engine: typed and untyped N-Triples differ', () => {
  const a = scratch(), b = scratch();
  assert.equal(cli('convert', '--to', 'ntriples', '--out', a, `${EX}/place-centric-constantinople.json`).code, 0);
  assert.equal(cli('convert', '--to', 'ntriples', '--out', b, '--no-typing', `${EX}/place-centric-constantinople.json`).code, 0);
  const typed = readFileSync(join(a, 'place-centric-constantinople.nt'), 'utf8'), plain = readFileSync(join(b, 'place-centric-constantinople.nt'), 'utf8');
  assert.ok(typed.split('\n').length > plain.split('\n').length, `${typed.split('\n').length} typed lines, ${plain.split('\n').length} untyped`);
});

test('convert never replaces an existing file unasked (exit 2, file untouched); --overwrite replaces it', () => {
  const out = scratch();
  const target = join(out, 'place-centric-constantinople.jsonl');
  writeFileSync(target, 'mine\n');
  const r = cli('convert', '--to', 'plato-jsonl', '--out', out, `${EX}/place-centric-constantinople.json`);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /already exists; give --overwrite to replace it/);
  assert.equal(readFileSync(target, 'utf8'), 'mine\n');
  const o = cli('convert', '--to', 'plato-jsonl', '--out', out, '--overwrite', `${EX}/place-centric-constantinople.json`);
  assert.equal(o.code, 0, o.out + o.err);
  assert.match(readFileSync(target, 'utf8'), /^\{"\$schema"/);
});
test('a conversion that fails part-way leaves no partial output behind', () => {
  const out = scratch(), p = join(scratch(), 'cut.json');
  writeFileSync(p, readFileSync(`${EX}/place-centric-constantinople.json`, 'utf8').slice(0, 1500));
  const r = cli('convert', '--to', 'plato-jsonl', '--out', out, p);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /Nothing was written: .*cut\.jsonl was removed, being incomplete\./);
  assert.deepEqual(readdirSync(out), []);
});

// ---- the working database ---------------------------------------------------------------------------
test('RDF goes through a database file on disk in --work-dir, which is removed afterwards', () => {
  const work = scratch();
  const r = cli('check', '--json', '--work-dir', work, `${PLATO_REPO}/examples/survey-attestations.ttl`, `${EX}/place-centric-constantinople.json`);
  assert.equal(r.code, 0, r.out + r.err);
  const [rdf, json] = jsonLines(r.out);
  assert.ok(rdf.storeBytes > 4096, `the store was a file of ${rdf.storeBytes} bytes`);
  assert.equal(json.storeBytes, null, 'place-centric JSON streams straight through');
  assert.deepEqual(readdirSync(work), [], 'nothing is left in the work directory');
  // And it really is the directory used: where no directory can be made, RDF cannot be checked.
  const blocked = join(scratch(), 'a-file');
  writeFileSync(blocked, '');
  const b = cli('check', '--json', '--work-dir', join(blocked, 'sub'), `${PLATO_REPO}/examples/survey-attestations.ttl`, `${EX}/place-centric-constantinople.json`);
  assert.equal(b.code, 2, b.out + b.err);
  assert.deepEqual(jsonLines(b.out).map((l) => l.status), ['failed', 'ok', undefined]);
});
