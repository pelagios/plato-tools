import { PLATO_REPO } from './paths.js';
// A conversion's output gzipped as it is written (options.gzip, --gzip, the page's checkbox): the
// same text as without it, byte for byte once gunzipped, the same bytes every time (level 6, no time
// in the header), and named with .gz. The tables are a zip already: they are not gzipped, and say so.
// The same gzip serves Agora's copy with ids and the site's downloads, each making the bytes it made
// before; its output is one member whose trailer gives the size; and one stopped part-way is removed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Gzip } from 'fflate';
import { res, file, go } from './engine.js';
import { gzipped } from '../src/lib/gzip.js';
import { sizeRead } from '../src/engine/chora/storage.js';
import { NodeHost } from '../src/node/host.js';
import { run } from '../src/engine/pipeline.js';
import { detect } from '../src/engine/input.js';

const EX = `${PLATO_REPO}/schemas/examples`;
const KING_JOHN = `${EX}/place-centric-king-john.json`;
const SURVEY = `${EX}/attestation-centric-survey.json`;   // read through the store
const bytes = (r, name) => Buffer.concat(r.e.outs[name].map((p) => Buffer.from(p)));
const isGzip = (b) => b[0] === 0x1f && b[1] === 0x8b;
const kinds = (r) => r.report.items.map((i) => i.kind);

for (const [path, target, ext] of [[KING_JOHN, 'plato-jsonl', '.jsonl'], [KING_JOHN, 'ntriples', '.nt'], [KING_JOHN, 'lpf', '.geojson'], [SURVEY, 'plato-json', '.json']]) {
  const stem = path.split('/').pop().replace(/\.json$/, '');
  test(`gzipped ${target} from ${stem}: .gz, the plain output once gunzipped, the same bytes twice`, async () => {
    const plain = await go([file(path)], 'convert', target);
    const gz = await go([file(path)], 'convert', target, { gzip: true });
    const again = await go([file(path)], 'convert', target, { gzip: true });
    // Control: without the option, the name and the bytes are plain.
    assert.deepEqual(Object.keys(plain.e.outs), [stem + ext]);
    assert.ok(!isGzip(bytes(plain, stem + ext)));
    assert.deepEqual(Object.keys(gz.e.outs), [stem + ext + '.gz']);
    assert.deepEqual(gz.outputs.map((o) => o.name), [stem + ext + '.gz']);
    const z = bytes(gz, stem + ext + '.gz');
    assert.ok(isGzip(z));
    assert.ok(z.length < bytes(plain, stem + ext).length, 'compressed');
    assert.ok(gunzipSync(z).equals(bytes(plain, stem + ext)), 'the plain output, byte for byte');
    assert.ok(z.equals(bytes(again, stem + ext + '.gz')), 'the same bytes from the same data');
    assert.deepEqual(gz.report, plain.report);
  });
}

test('the tables are a zip already: not gzipped, with a warning', async () => {
  const r = await go([file(KING_JOHN)], 'convert', 'tables', { gzip: true });
  assert.deepEqual(Object.keys(r.e.outs), ['place-centric-king-john-tables.zip']);
  assert.ok(kinds(r).includes('gzip-zip'), JSON.stringify(kinds(r)));
  // Control: not asked for, no warning.
  const c = await go([file(KING_JOHN)], 'convert', 'tables');
  assert.deepEqual(Object.keys(c.e.outs), ['place-centric-king-john-tables.zip']);
  assert.ok(!kinds(c).includes('gzip-zip'));
});

// ---- the command line -----------------------------------------------------------------------------
const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'plato-tools-gzip-')); made.push(d); return d; };

test('--gzip on the command line writes NAME.jsonl.gz, the plain output once gunzipped', () => {
  const plain = scratch(), gz = scratch();
  assert.equal(cli('convert', '--to', 'plato-jsonl', '--out', plain, KING_JOHN).code, 0);
  const r = cli('convert', '--to', 'plato-jsonl', '--gzip', '--out', gz, KING_JOHN);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readdirSync(gz), ['place-centric-king-john.jsonl.gz']);
  assert.ok(gunzipSync(readFileSync(join(gz, 'place-centric-king-john.jsonl.gz'))).equals(readFileSync(join(plain, 'place-centric-king-john.jsonl'))));
  assert.match(cli('--help').out, /--gzip {12}convert: gzip the output/);
});
test('--gzip is for convert: a check given it is refused, as a mistake in the command', () => {
  const r = cli('check', '--gzip', KING_JOHN);
  assert.equal(r.code, 2);
  assert.match(r.err, /--gzip is for convert/);
  // Control: the same check without it passes.
  assert.equal(cli('check', KING_JOHN).code, 0);
});

// ---- one gzip for three callers, each making the bytes it made before ----------------------------
const collect = () => { const parts = []; return { writeBytes: (b) => parts.push(Buffer.from(b)), close: async () => ({}), bytes: () => Buffer.concat(parts) }; };
// What Agora's copy with ids (mint.js) and the site's downloads (site/downloads.js) did before they
// shared src/lib/gzip.js, copied here as they were.
function mintBefore(out) {
  const enc = new TextEncoder();
  const gz = new Gzip({ level: 6, mtime: 0 }, (chunk) => out.writeBytes(chunk));
  let held = '';
  return { write(s) { held += s; if (held.length >= 1 << 16) { gz.push(enc.encode(held)); held = ''; } }, async close() { gz.push(enc.encode(held), true); held = ''; return out.close(); } };
}
function downloadsBefore(out) {
  const enc = new TextEncoder();
  const gz = new Gzip({ level: 6, mtime: 0 }, (chunk) => out.writeBytes(chunk));
  return { write: (s) => gz.push(enc.encode(s)), writeBytes: (b) => gz.push(b), close: async () => { gz.push(new Uint8Array(0), true); return out.close(); } };
}
/** Writes of every size, empty ones and some past 64 KB among them, the same each time for a seed. */
function writes(seed) {
  let x = seed;
  const r = () => (x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  return Array.from({ length: 300 }, (_, i) => (i % 37 === 0 ? '' : `<https://example.org/p/${i}> "Ἑρμῆς ${'é'.repeat(Math.floor(r() * 40))}" .\n`.repeat(1 + Math.floor(r() * (i % 50 === 1 ? 3000 : 30)))));
}
test('the shared gzip makes, byte for byte, what Agora\'s copy and the site\'s downloads made before it', async () => {
  for (const seed of [1, 2, 3]) {
    const text = writes(seed);
    const a = collect(), b = collect(), c = collect(), d = collect();
    const mine = gzipped(a), theirs = mintBefore(b), downloads = gzipped(c, { piece: 0 }), before = downloadsBefore(d);
    for (const s of text) { mine.write(s); theirs.write(s); downloads.write(s); before.write(s); }
    const tail = Buffer.from('bytes, as a zip would be given');
    downloads.writeBytes(tail); before.writeBytes(tail);
    await Promise.all([mine.close(), theirs.close(), downloads.close(), before.close()]);
    assert.ok(text.some((s) => s.length > 1 << 16) && text.includes(''), 'writes past 64 KB, and empty ones');
    assert.ok(a.bytes().equals(b.bytes()), `the copy with ids, seed ${seed}`);
    assert.ok(c.bytes().equals(d.bytes()), `the site's downloads, seed ${seed}`);
    assert.equal(downloads.size, c.bytes().length, 'size is the bytes written');
    assert.equal(gunzipSync(a.bytes()).toString(), text.join(''));
    // Control: the two ways of piecing give different bytes, so each comparison above could fail.
    assert.ok(!a.bytes().equals(c.bytes().subarray(0, a.bytes().length)), 'the pieces change the bytes');
  }
});

test('a gzipped output is one member, whose trailer gives its size, as the storage estimate reads it', async () => {
  const plain = await go([file(KING_JOHN)], 'convert', 'ntriples');
  const gz = await go([file(KING_JOHN)], 'convert', 'ntriples', { gzip: true });
  const p = bytes(plain, 'place-centric-king-john.nt'), z = bytes(gz, 'place-centric-king-john.nt.gz');
  assert.equal(z.readUInt32LE(z.length - 4), p.length, 'ISIZE is the size of the text');
  assert.equal(await sizeRead(new File([z], 'x.nt.gz')), p.length, 'read at its size');
  // Control: two members together are read otherwise, so the estimate does tell them apart.
  assert.notEqual(await sizeRead(new File([z, z], 'x.nt.gz')), p.length);
});

test('a candidate set converted with gzip is gzipped too; a check is not touched by it', async () => {
  const set = `${EX}/candidate-set-judgements.json`;
  const plain = await go([file(set)], 'convert', 'plato-jsonl');
  const gz = await go([file(set)], 'convert', 'plato-jsonl', { gzip: true });
  assert.deepEqual(Object.keys(plain.e.outs), ['candidate-set-judgements.jsonl']);
  assert.deepEqual(Object.keys(gz.e.outs), ['candidate-set-judgements.jsonl.gz']);
  assert.ok(gunzipSync(bytes(gz, 'candidate-set-judgements.jsonl.gz')).equals(bytes(plain, 'candidate-set-judgements.jsonl')));
  const checked = await go([file(KING_JOHN)], 'check', undefined, { gzip: true });
  assert.deepEqual(Object.keys(checked.e.outs), []);
  assert.equal(checked.report.errors, 0);
});

test('a gzipped conversion stopped part-way leaves no file: the gzip cut short is removed', async () => {
  for (const stopAt of [3, Infinity]) {
    const out = scratch();
    const host = new NodeHost({ workDir: out, outDir: out });
    const { env, finish } = host.env(res);
    const ac = new AbortController();
    let seen = 0;
    const r = await run({ input: await detect([file(KING_JOHN)]), action: 'convert', target: 'plato-jsonl', options: { gzip: true, signal: ac.signal, augment: (rec) => { if (++seen === stopAt) ac.abort(); return rec; } } }, env);
    const name = join(out, 'place-centric-king-john.jsonl.gz');
    const begun = existsSync(name);
    finish(!!r.incomplete);
    host.cleanup();
    assert.ok(begun, 'the gzip had been begun');
    if (stopAt === 3) {
      assert.equal(r.aborted, true);
      assert.deepEqual(r.outputs, []);
      assert.equal(existsSync(name), false, 'and is removed');
    } else {
      // Control: not stopped, it is kept, whole.
      assert.equal(r.aborted, undefined);
      assert.deepEqual(r.outputs.map((o) => o.name), ['place-centric-king-john.jsonl.gz']);
      assert.ok(gunzipSync(readFileSync(name)).length > 0);
    }
  }
});
