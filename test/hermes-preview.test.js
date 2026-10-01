// The preview (src/engine/hermes/preview.js): the first records of a table of places, a TEI edition or
// a Recogito export, read by the reader a run uses, and nothing written. Every test that asserts an
// absence asserts, in the same test, a presence it could have missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detect, DataError } from '../src/engine/input.js';
import { sourceFor, run } from '../src/engine/pipeline.js';
import { Report } from '../src/engine/report.js';
import { preview, previewLine, PREVIEW_LIMIT } from '../src/engine/hermes/preview.js';
import { PREVIEW_WORDS } from '../src/engine/words.js';
import { res, file, textFile, env } from './engine.js';

const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const FIX = 'test/fixtures';

/** An env whose output and database are watched: { env, calls }. */
function watchedEnv() {
  const e = env(), calls = { output: 0, openDb: 0 };
  const output = e.output, openDb = e.openDb;
  e.output = (...a) => { calls.output++; return output(...a); };
  e.openDb = (...a) => { calls.openDb++; return openDb(...a); };
  return { env: e, calls };
}
/** The record and attestation events a full run's reader gives, every one (the reader drained to its end). */
async function allEvents(input, options = {}) {
  const out = [];
  for await (const ev of sourceFor(input, env(), new Report(), options, 'check')) if (ev.type === 'record' || ev.type === 'attestation' || ev.type === 'idr') out.push(ev);
  return out;
}
/**
 * A file that counts what is read of it, and says of each stream opened on it whether it was read
 * to its end or cancelled: { streams: [{ bytes, done, cancelled }], bytes() }. It is read 64 KB at a
 * time, as a browser reads a file (Node gives a Blob made from one string in one piece).
 */
const PIECE = 65536;
class Watched extends File {
  constructor(parts, name) { super(parts, name); this.streams = []; }
  bytes() { return this.streams.reduce((n, s) => n + s.bytes, 0); }
  stream() {
    const inner = super.stream().getReader(), rec = { bytes: 0, done: false, cancelled: false };
    let rest = new Uint8Array(0);
    this.streams.push(rec);
    return new ReadableStream({
      async pull(c) {
        if (!rest.length) { const r = await inner.read(); if (r.done) { rec.done = true; c.close(); return; } rest = r.value; }
        const piece = rest.subarray(0, PIECE); rest = rest.subarray(PIECE);
        rec.bytes += piece.length; c.enqueue(piece);
      },
      cancel(reason) { rec.cancelled = true; return inner.cancel(reason); },
    }, { highWaterMark: 0 });
  }
}
const watched = (path, name) => new Watched([readFileSync(path)], name || path.split('/').pop());
const settle = () => new Promise((r) => setTimeout(r, 20));

// ---- the preview's records are the first a run reads ------------------------------------------------
const CASES = [
  ['a CSV file', `${FIX}/generic/pleiades-places-subset.csv`, 3, {}],
  ['plain GeoJSON', `${FIX}/generic/plain.geojson`, 2, {}],
  ['a TEI edition', `${FIX}/tei/pointers-constructed.xml`, 2, {}],
  ['W3C Web Annotations', `${FIX}/annotations/recogito-v1-pliny-text.jsonld`, 4, {}],
];
for (const [what, path, n, options] of CASES) {
  test(`the preview of ${what} gives the first ${n} events a full run's reader gives`, async () => {
    const input = await detect([file(path)]);
    const all = await allEvents(input, options);
    assert.ok(all.length > n, `${what}: the fixture has more than ${n} records (${all.length})`);
    const p = await preview({ input: await detect([file(path)]), options, limit: n }, env());
    assert.equal(p.items.length, n);
    assert.deepEqual(p.items, all.slice(0, n));
    // The control: the comparison can fail (the next window of events is not the preview's), and the
    // preview says it stopped, why, and that the total is not known.
    assert.notDeepEqual(p.items, all.slice(1, n + 1));
    assert.equal(p.complete, false);
    assert.equal(p.total, null);
    assert.match(p.why, /Reading stopped after the first \d+ record/);
    assert.equal(p.report.items.find((i) => i.kind === 'preview-partial').severity, 'warning');
    assert.match(previewLine(p), new RegExp(`^the first ${n} records read; the rest not read; nothing checked or written$`));
    assert.ok(p.header && typeof p.header === 'object', 'the header is given');
  });
}
test('a preview of all there is is complete, with the total, and no notice that it is partial', async () => {
  const path = `${FIX}/generic/plain.geojson`;
  const all = await allEvents(await detect([file(path)]));
  const p = await preview({ input: await detect([file(path)]), limit: 50 }, env());
  assert.deepEqual(p.items, all);
  assert.equal(p.complete, true);
  assert.equal(p.total, all.length);
  assert.equal(p.why, null);
  assert.equal(previewLine(p), `first ${all.length} of ${all.length} records; nothing checked or written`);
  assert.ok(!p.report.items.some((i) => i.kind === 'preview-partial'));
  // The control: a smaller limit, on the same file, is partial and says so.
  const part = await preview({ input: await detect([file(path)]), limit: 1 }, env());
  assert.ok(part.report.items.some((i) => i.kind === 'preview-partial'));
  assert.equal(PREVIEW_LIMIT, 10);
});

// ---- reading stops early, and lets go of the file ---------------------------------------------------
test('on a large CSV file, a preview reads far fewer rows and bytes than the file holds; a full read reads them all', async () => {
  const rows = 200000;
  let text = 'name,id,latitude,longitude\n';
  for (let i = 0; i < rows; i++) text += `Place ${i},p${i},51.${i % 1000},-1.${i % 1000}\n`;
  const big = new Watched([text], 'big.csv');
  const input = await detect([big]);
  const before = big.bytes();
  const p = await preview({ input, limit: 10 }, env());
  await settle();
  assert.equal(p.items.length, 10);
  assert.ok(p.read.rows <= 11, `rows read: ${p.read.rows}`);
  const read = big.bytes() - before;
  assert.ok(read < big.size / 20, `${read} bytes read of ${big.size}`);
  // Every stream opened on the file was let go: read to its end or cancelled, none left open.
  assert.ok(big.streams.every((s) => s.done || s.cancelled), JSON.stringify(big.streams));
  assert.ok(big.streams.some((s) => s.cancelled));
  // The control: the counter counts a whole read as whole.
  const mark = big.bytes();
  const all = await allEvents(input);
  assert.equal(all.length, rows);
  assert.ok(big.bytes() - mark >= big.size, `${big.bytes() - mark} bytes for a full read of ${big.size}`);
});
// Each format made large (several 64 KB pieces), its first records at the start.
const FILLER = `<p>${'Nothing of note here. '.repeat(40)}</p>\n`.repeat(300);
const LARGE = {
  'a CSV file': () => new Watched(['name,id,latitude,longitude\n' + Array.from({ length: 20000 }, (_, i) => `Place ${i},p${i},51.5,-1.5`).join('\n')], 'large.csv'),
  'plain GeoJSON': () => new Watched([JSON.stringify({ type: 'FeatureCollection', features: Array.from({ length: 5000 }, (_, i) => ({ type: 'Feature', id: `p${i}`, properties: { name: `Place ${i}` }, geometry: { type: 'Point', coordinates: [-1.5, 51.5] } })) })], 'large.geojson'),
  'a TEI edition': () => new Watched([readFileSync(`${FIX}/tei/pointers-constructed.xml`, 'utf8').replace('</body>', `${FILLER}</body>`)], 'large.xml'),
  'W3C Web Annotations': () => { const a = JSON.parse(readFileSync(`${FIX}/annotations/recogito-v1-pliny-text.jsonld`, 'utf8')); return new Watched([JSON.stringify(Array.from({ length: 20 }, () => a).flat())], 'large.jsonld'); },
};
for (const [what, make] of Object.entries(LARGE)) {
  test(`a preview of ${what} that stops early lets go of every stream it opened, and reads only part of it`, async () => {
    const f = make();
    assert.ok(f.size > 4 * PIECE, `${what}: ${f.size} bytes`);
    const input = await detect([f]);
    const p = await preview({ input, limit: 2 }, env());
    await settle();
    assert.equal(p.complete, false);
    assert.equal(p.items.length, 2);
    // Every stream opened on the file was let go: read to its end, or cancelled.
    assert.ok(f.streams.length > 0);
    assert.ok(f.streams.every((s) => s.done || s.cancelled), `${what}: ${JSON.stringify(f.streams)}`);
    // The control: at least one was cancelled, part-way (GeoJSON's columns are found by one whole reading, its rows by another, stopped).
    assert.ok(f.streams.some((s) => s.cancelled && s.bytes < f.size), `${what}: ${JSON.stringify(f.streams)}`);
  });
}

// ---- nothing is written -----------------------------------------------------------------------------
test('a preview never asks for an output or a database; a conversion of the same file does', async () => {
  for (const path of [`${FIX}/generic/pleiades-places-subset.csv`, `${FIX}/annotations/recogito-v1-pliny-text.jsonld`, `${FIX}/tei/pointers-constructed.xml`]) {
    const { env: e, calls } = watchedEnv();
    const p = await preview({ input: await detect([file(path)]), limit: 2 }, e);
    assert.equal(p.items.length, 2, path);
    assert.deepEqual(calls, { output: 0, openDb: 0 }, path);
    // The control: the watch sees a conversion's output.
    const c = watchedEnv();
    await run({ input: await detect([file(path)]), action: 'convert', target: 'plato-jsonl', options: {} }, c.env);
    assert.ok(c.calls.output > 0, path);
  }
});

// ---- what is refused --------------------------------------------------------------------------------
test('the spreadsheet tables, and every format but the four, are refused plainly; a table of places is previewed', async () => {
  const dir = `${FIX}/tables-judgements`;
  const tables = await detect(readdirSync(dir).filter((f) => f.endsWith('.csv')).map((f) => file(`${dir}/${f}`)));
  assert.equal(tables.format, 'tables');
  const { env: e, calls } = watchedEnv();
  await assert.rejects(preview({ input: tables }, e), (err) => err instanceof DataError && /is not previewed/.test(err.message) && /PLATO spreadsheet tables/.test(err.message));
  assert.equal(calls.openDb, 0);
  const jsonl = await detect([textFile('{"profile":"place-centric","gazetteer":{"title":"x"}}\n', 'x.jsonl')]);
  await assert.rejects(preview({ input: jsonl }, env()), /PLATO JSON Lines.*is not previewed/);
  await assert.rejects(preview({ input: await detect([file(`${FIX}/generic/plain.geojson`)]), limit: 0 }, env()), /at least 1/);
  // The control: a table of places is previewed.
  const p = await preview({ input: await detect([file(`${FIX}/generic/with-ids.csv`)]), limit: 1 }, env());
  assert.equal(p.items.length, 1);
  assert.equal(p.profile, 'place-centric');
});

// ---- why a TEI preview is partial ---------------------------------------------------------------------
const tei = (list, back) => `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt><title>Held</title></titleStmt>
<publicationStmt><idno type="URI">https://example.org/editions/held</idno></publicationStmt><sourceDesc><p>Constructed.</p></sourceDesc></fileDesc>
${list ? `<profileDesc><settingDesc>${LIST}</settingDesc></profileDesc>` : ''}</teiHeader>
<text><body><ab>
<placeName ref="#a">Athenae</placeName> <placeName ref="#b">Thebae</placeName> <placeName ref="#c">Corinthus</placeName>
<placeName ref="https://pleiades.stoa.org/places/570182">Corinthus</placeName>
<placeName ref="https://pleiades.stoa.org/places/541138">Thebae</placeName>
<placeName ref="https://pleiades.stoa.org/places/579885">Athenae</placeName>
<placeName ref="https://pleiades.stoa.org/places/570685">Megara</placeName>
</ab>${FILLER}</body>${back ? `<back>${LIST}</back>` : ''}</text></TEI>
`;
const LIST = '<listPlace><place xml:id="a"><idno>https://pleiades.stoa.org/places/579885</idno></place><place xml:id="b"><idno>https://pleiades.stoa.org/places/541138</idno></place><place xml:id="c"><idno>https://pleiades.stoa.org/places/570182</idno></place></listPlace>';
test('a TEI edition whose first place names wait for a <place> later in the file says so, and why the preview is partial', async () => {
  // Read 64 KB at a time, as a browser or the command line reads it, so that the list of places at the end is not yet read.
  const later = new Watched([tei(false, true)], 'held.xml');
  const p = await preview({ input: await detect([later]), limit: 2 }, env());
  assert.equal(p.complete, false);
  // The first two given are the names with web addresses of their own: the first three wait.
  assert.deepEqual(p.items.map((ev) => ev.value.names[0].toponym), ['Corinthus', 'Thebae']);
  assert.deepEqual(p.items.map((ev) => ev.value.about), ['https://pleiades.stoa.org/places/570182', 'https://pleiades.stoa.org/places/541138']);
  assert.match(p.why, /3 place names read so far point to a <place> later in the file/);
  assert.equal(p.report.items.find((i) => i.kind === 'preview-partial').examples[0], p.why);
  // And they are the first two a run's reader gives.
  assert.deepEqual(p.items, (await allEvents(await detect([new Watched([tei(false, true)], 'held.xml')]))).slice(0, 2));
  // The control: with the list of places in the header, nothing waits, the first names come first, and nothing is said of waiting.
  const first = await preview({ input: await detect([new Watched([tei(true, false)], 'listed.xml')]), limit: 2 }, env());
  assert.equal(first.complete, false);
  assert.deepEqual(first.items.map((ev) => ev.value.about), ['https://pleiades.stoa.org/places/579885', 'https://pleiades.stoa.org/places/541138']);
  assert.match(first.why, /Reading stopped/);
  assert.doesNotMatch(first.why, /point to a <place>/);
});
test('rows with the same id: a partial preview says the places made at the end are not shown; a whole one shows them', async () => {
  const csv = 'name,id\nOxford,ox\nOxenford,ox\nBath,ba\n';
  const part = await preview({ input: await detect([textFile(csv, 'same.csv')]), options: { sameId: true }, limit: 2 }, env());
  assert.equal(part.profile, 'attestation-centric');
  assert.equal(part.items.length, 2);
  assert.ok(part.items.every((ev) => ev.type === 'attestation'));
  assert.ok(part.why.includes(PREVIEW_WORDS.sameId));
  assert.ok(part.why.includes(PREVIEW_WORDS.regrouped));
  // The control: read whole, the places made at the end are among the items, and nothing is said.
  const whole = await preview({ input: await detect([textFile(csv, 'same.csv')]), options: { sameId: true }, limit: 50 }, env());
  assert.equal(whole.complete, true);
  assert.deepEqual(whole.items.filter((ev) => ev.newEntity).map((ev) => ev.value.entityIdentifier), ['ox', 'ba']);
  assert.equal(whole.why, null);
});
test('each record is checked against the schema as it is read, and a problem is reported', async () => {
  // A place-centric row with a name and no evidence passes; a row with a latitude out of range is reported by the reader.
  const p = await preview({ input: await detect([textFile('name,latitude,longitude\nOxford,51.75,-1.25\nNowhere,951,0\n', 'odd.csv')]), limit: 5 }, env());
  assert.equal(p.items.length, 2);
  assert.ok(p.report.items.length > 0, JSON.stringify(p.report.items));
  // The control: a clean file reports nothing but that it is a preview (it is complete, so not even that).
  const clean = await preview({ input: await detect([textFile('name,id,latitude,longitude\nOxford,ox,51.75,-1.25\n', 'clean.csv')]), options: { base: 'https://example.org/places/' }, limit: 5 }, env());
  assert.deepEqual(clean.report.items, []);
  assert.equal(clean.items.length, 1);
});

test('the losses so far are those of the records shown, not of the one read past the limit to know there is more', async () => {
  const csv = 'name,id,start\nOxford,ox,1066\nBath,ba,c. 75\n';
  const one = await preview({ input: await detect([textFile(csv, 'dates.csv')]), options: { base: 'https://example.org/p/' }, limit: 1 }, env());
  assert.equal(one.items.length, 1);
  assert.equal(one.read.rows, 2);   // the second row was read, to know there is more
  assert.ok(one.report.items.some((i) => i.kind === 'preview-partial'));
  assert.ok(!one.report.items.some((i) => /row 3/.test(i.examples.join(' '))), JSON.stringify(one.report.items));
  // The control: shown, the second row's loss is reported.
  const two = await preview({ input: await detect([textFile(csv, 'dates.csv')]), options: { base: 'https://example.org/p/' }, limit: 2 }, env());
  assert.ok(two.report.items.some((i) => i.examples.includes('row 3, start: c. 75')), JSON.stringify(two.report.items));
});

// ---- the command line ---------------------------------------------------------------------------------
test('plato-tools preview: JSON Lines to stdout and the losses to stderr, or both with --json; its exit codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plato-tools-preview-'));
  const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  try {
    const csv = join(dir, 'places.csv');
    writeFileSync(csv, 'name,id,latitude,longitude,colour\n' + Array.from({ length: 30 }, (_, i) => `Place ${i},p${i},51.${i},-1.${i},red`).join('\n') + '\n');
    const plain = cli('preview', csv);
    assert.equal(plain.code, 0, plain.err);
    const lines = plain.out.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 10);
    assert.equal(lines[0].label, 'Place 0');
    assert.match(plain.err, /the first 10 records read; the rest not read; nothing checked or written/);
    assert.match(plain.err, /Reading stopped after the first 10 records/);
    assert.match(plain.err, /Losses so far/);
    assert.ok(!existsAny(dir, /\.jsonl$/), 'nothing written');
    const two = cli('preview', '--limit', '2', '--json', csv);
    assert.equal(two.code, 0, two.err);
    assert.equal(two.err, '');
    const j = JSON.parse(two.out);
    assert.equal(j.type, 'preview');
    assert.equal(j.items.length, 2);
    assert.equal(j.complete, false);
    assert.equal(j.line, 'the first 2 records read; the rest not read; nothing checked or written');
    assert.ok(j.report.items.some((i) => i.kind === 'preview-partial'));
    assert.equal(j.exitCode, 0);
    const all = cli('preview', '--limit', '100', '--json', csv);
    assert.equal(JSON.parse(all.out).line, 'first 30 of 30 records; nothing checked or written');
    // Usage errors (2): a bad --limit, --limit elsewhere, two inputs, a format not previewed, an option preview does not take.
    for (const [args, re] of [[['--limit', '0', csv], /--limit/], [['--limit', 'ten', csv], /--limit/], [[csv, `${FIX}/generic/plain.geojson`], /one input/], [['--to', 'lpf', csv], /--to/]]) {
      const r = cli('preview', ...args);
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.err}`);
      assert.match(r.err, re);
      assert.equal(r.out, '');
    }
    const elsewhere = cli('check', '--limit', '2', csv);
    assert.equal(elsewhere.code, 2);
    assert.match(elsewhere.err, /--limit is for preview/);
    const nt = join(dir, 'x.nt');
    writeFileSync(nt, '<https://example.org/a> <http://www.w3.org/2000/01/rdf-schema#label> "a" .\n');
    const refused = cli('preview', nt);
    assert.equal(refused.code, 2);
    assert.match(refused.err, /RDF \(N-Triples\), which is not previewed/);
    // Problems in what was read (1): a table none of whose rows becomes a place, read to its end.
    const nameless = join(dir, 'nameless.csv');
    writeFileSync(nameless, 'colour,size\nred,1\nblue,2\n');
    const bad = cli('preview', nameless);
    assert.equal(bad.code, 1, bad.err);
    assert.equal(bad.out, '');
    assert.match(bad.err, /first 0 of 0 records; nothing checked or written/);
    assert.match(bad.err, /Problems\./);
    // A TEI edition with a reading option: its first record.
    const tei = join(dir, 'held.xml');
    writeFileSync(tei, readFileSync(`${FIX}/tei/pointers-constructed.xml`));
    const t = cli('preview', '--limit', '1', '--list-places', tei);
    assert.equal(t.code, 0, t.err);
    assert.equal(t.out.trim().split('\n').length, 1);
    // The control for the usage errors: the same command, rightly given, succeeds (above), and check still runs.
    assert.equal(cli('check', csv).code, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
const existsAny = (dir, re) => readdirSync(dir).some((f) => re.test(f));
