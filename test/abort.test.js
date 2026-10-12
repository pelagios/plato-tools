import { PLATO_REPO } from './paths.js';
// A caller may stop a run (options.signal, an AbortSignal): it ends at the next record, cleanly, as
// a file cut short does: no outputs, what it had begun closed and, on the command line's host,
// removed, its working database closed, and a report that says it was stopped. Each stop has a
// control, the same run not stopped, that writes its output and keeps it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { res, file, go } from './engine.js';
import { run, Aborted } from '../src/engine/pipeline.js';
import { compare } from '../src/engine/compare.js';
import { detect } from '../src/engine/input.js';
import { NodeHost } from '../src/node/host.js';
import { env as memEnv } from './engine.js';

const EX = `${PLATO_REPO}/schemas/examples`;
const KING_JOHN = `${EX}/place-centric-king-john.json`;      // 19 places, read as they stream
const SURVEY = `${EX}/attestation-centric-survey.json`;      // read through the store
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const kinds = (r) => r.report.items.map((i) => i.kind);

/** An augment that aborts the run once it has seen `n` records, counting what it saw. */
function stopAfter(n) {
  const ac = new AbortController(), seen = [];
  return { seen, signal: ac.signal, augment: (rec) => { seen.push(rec['@id']); if (seen.length === n) ac.abort(); return rec; } };
}

/** One conversion on the command line's host, writing to a folder of its own. */
async function onDisk(path, options) {
  const out = mkdtempSync(join(tmpdir(), 'plato-tools-abort-')); made.push(out);
  const host = new NodeHost({ workDir: out, outDir: out });
  const { env, finish } = host.env(res);
  const dbs = [], openDb = env.openDb;
  env.openDb = async (o) => { const db = await openDb(o); dbs.push(db); return db; };
  const r = await run({ input: await detect([file(path)]), action: 'convert', target: 'plato-jsonl', options }, env);
  const name = path.split('/').pop().replace(/\.json$/, '.jsonl');
  const begun = existsSync(join(out, name));
  const closedByRun = dbs.map((db) => db.closed);
  const done = finish(!!r.incomplete);
  host.cleanup();
  return { r, begun, kept: existsSync(join(out, name)), removed: done.removed, dbs: dbs.length, closedByRun };
}

for (const [label, path, n] of [['as it streams', KING_JOHN, 3], ['through the store', SURVEY, 1]]) {
  test(`a run stopped part-way, read ${label}, writes nothing, removes what it began and says it was stopped`, async () => {
    const s = stopAfter(n);
    const d = await onDisk(path, { signal: s.signal, augment: s.augment });
    assert.equal(d.r.aborted, true);
    assert.equal(d.r.incomplete, true);
    assert.deepEqual(d.r.outputs, []);
    assert.equal(s.seen.length, n, 'stopped at the next record, not at the end');
    assert.ok(kinds(d.r).includes('stopped'), JSON.stringify(kinds(d.r)));
    assert.ok(/^Stopped before the end/.test(d.r.report.items.find((i) => i.kind === 'stopped').message));
    assert.ok(d.begun, 'the output had been begun');
    assert.equal(d.kept, false, 'and is removed');
    assert.equal(d.removed.length, 1);
    if (path === SURVEY) assert.deepEqual(d.closedByRun, [true], 'the store is closed by the run itself');
  });
  test(`control: the same run not stopped, read ${label}, writes its output and keeps it`, async () => {
    const s = stopAfter(Infinity);
    const d = await onDisk(path, { signal: s.signal, augment: s.augment });
    assert.equal(d.r.aborted, undefined);
    assert.equal(d.r.incomplete, undefined);
    assert.equal(d.r.outputs.length, 1);
    assert.ok(s.seen.length > n, `${s.seen.length} records`);
    assert.ok(!kinds(d.r).includes('stopped'));
    assert.ok(d.kept);
    assert.deepEqual(d.removed, []);
    if (path === SURVEY) assert.deepEqual(d.closedByRun, [true]);
  });
}

test('an Aborted thrown by the augment or by the writer stops the run; it is not a record that failed', async () => {
  const fromAugment = await go([file(KING_JOHN)], 'convert', 'plato-jsonl', { augment: () => { throw new Aborted(); } });
  assert.equal(fromAugment.aborted, true);
  assert.ok(!kinds(fromAugment).includes('record-failed'), JSON.stringify(kinds(fromAugment)));
  let events = 0;
  const sink = { header() {}, event() { if (++events === 2) throw new Aborted(); }, close() {} };
  const fromWriter = await go([file(KING_JOHN)], 'check', undefined, { sink });
  assert.equal(fromWriter.aborted, true);
  assert.equal(events, 2);
  assert.ok(!kinds(fromWriter).includes('record-failed'), JSON.stringify(kinds(fromWriter)));
});
test('control: any other error from the writer is a record that failed, and the run goes on', async () => {
  let events = 0;
  const sink = { header() {}, event() { if (++events === 2) throw new Error('no room'); }, close() {} };
  const r = await go([file(KING_JOHN)], 'check', undefined, { sink });
  assert.equal(r.aborted, undefined);
  assert.ok(kinds(r).includes('record-failed'));
  assert.equal(events, 19);
});

test('a version check stopped part-way says it was stopped, not that a version could not be read', async () => {
  const ac = new AbortController(); ac.abort();
  const r = await compare({ earlier: await detect([file(KING_JOHN)]), later: await detect([file(KING_JOHN)]), options: { signal: ac.signal } }, memEnv());
  assert.equal(r.aborted, true);
  assert.deepEqual(kinds(r), ['stopped']);
  // Control: not stopped, it compares.
  const c = await compare({ earlier: await detect([file(KING_JOHN)]), later: await detect([file(KING_JOHN)]) }, memEnv());
  assert.equal(c.aborted, undefined);
  assert.equal(c.report.errors, 0);
});

test('a version check stopped while it reads the later version stops there, having read the earlier whole', async () => {
  const ac = new AbortController(), phases = [];
  const env = { ...memEnv(), progress: (p) => { phases.push(`${p.version}:${p.phase}`); if (p.version === 'later' && p.phase === 'reading') ac.abort(); } };
  const r = await compare({ earlier: await detect([file(KING_JOHN)]), later: await detect([file(KING_JOHN)]), options: { signal: ac.signal } }, env);
  assert.equal(r.aborted, true);
  assert.deepEqual(kinds(r), ['stopped']);
  assert.ok(phases.includes('earlier:read') && phases.includes('later:reading'), phases.join(' '));
  assert.ok(!phases.includes('later:read'), 'the later version was not read to the end');
});

// The other loops over the records: the rows of a spreadsheet's sheets as they are loaded, and the
// places of RDF read back from the store. Each stopped is said so; its control is not stopped.
const TABLES = `${PLATO_REPO}/schemas/tables/examples/king-john`;
const tables = () => readdirSync(TABLES).map((f) => file(`${TABLES}/${f}`));
test('a conversion of spreadsheet tables stopped as its sheets load writes nothing, and closes its working database', async () => {
  for (const stopping of [true, false]) {
    const ac = new AbortController(), dbs = [];
    if (stopping) ac.abort();
    const e = memEnv(), openDb = e.openDb, phases = new Set();
    e.openDb = async (o) => { const db = await openDb(o); dbs.push(db); return db; };
    e.progress = (p) => phases.add(p.phase);
    const r = await run({ input: await detect(tables()), action: 'convert', target: 'plato-jsonl', options: { signal: ac.signal } }, e);
    assert.ok(dbs.length >= 1, 'the sheets were loaded into a working database');
    assert.ok(dbs.every((db) => !db.isOpen()), 'and it is closed');
    if (stopping) {
      assert.equal(r.aborted, true);
      assert.deepEqual(kinds(r), ['stopped']);
      assert.deepEqual(r.outputs, []);
      assert.ok(!phases.has('checking'), 'stopped while loading, before the sheets were checked');
    } else {
      assert.equal(r.aborted, undefined);
      assert.ok(phases.has('checking'));
      assert.equal(r.outputs.length, 1);
      assert.ok(r.report.counts.places > 1);
    }
  }
});
test('a conversion from RDF stopped as its places are read back from the store stops at the next place', async () => {
  const nt = await go([file(KING_JOHN)], 'convert', 'ntriples');
  const text = nt.e.outs['place-centric-king-john.nt'].join('');
  for (const stopAt of [2, Infinity]) {
    const s = stopAfter(stopAt);
    const r = await go([new File([text], 'king-john.nt')], 'convert', 'plato-jsonl', { signal: s.signal, augment: s.augment });
    if (stopAt === 2) {
      assert.equal(r.aborted, true);
      assert.equal(s.seen.length, 2, 'stopped at the next place');
      assert.ok(r.report.counts.triples > 0, 'after the store was loaded');
    } else {
      assert.equal(r.aborted, undefined);
      assert.equal(s.seen.length, 19);
    }
  }
});
