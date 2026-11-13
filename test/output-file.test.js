// A run's output file in the browser (src/engine/output-file.js): every write is checked. With the browser's
// allowance used up, a write throws or writes short; trusted, the output was cut short and the run said "No
// problems found" (the robustness review of November 2026, R-01: 30,000 rows under a 6 MB allowance). The
// handle here is a fake of FileSystemSyncAccessHandle with room for `room` bytes; the browser check
// (e2e/app_test.py, page_shell_checks) holds the page to it in Chromium with the origin's quota lowered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { output, noRoomError } from '../src/engine/output-file.js';
import { NO_ROOM, noRoom } from '../src/engine/words.js';
import { run } from '../src/engine/pipeline.js';
import { detect } from '../src/engine/input.js';
import { env, textFile } from './engine.js';

function disk({ room = Infinity, full = 'short' } = {}) {
  const files = new Map(), log = [];
  const dir = {
    async getFileHandle(name) {
      files.set(name, new Uint8Array(0));
      return { async createSyncAccessHandle() {
        let open = true;
        return {
          truncate(n) { files.set(name, files.get(name).slice(0, n)); },
          write(bytes, { at }) {
            if (!open) throw new Error('closed');
            const fits = Math.max(0, Math.min(bytes.byteLength, room - at));
            if (fits < bytes.byteLength && full === 'throws') throw Object.assign(new Error('exceeded'), { name: 'QuotaExceededError' });
            const was = files.get(name), now = new Uint8Array(Math.max(was.length, at + fits));
            now.set(was); now.set(bytes.subarray(0, fits), at); files.set(name, now);
            return fits;
          },
          flush() {}, getSize: () => files.get(name).length,
          close() { open = false; log.push(`closed ${name}`); },
        };
      } };
    },
    async removeEntry(name) { if (!files.delete(name)) throw Object.assign(new Error('nf'), { name: 'NotFoundError' }); log.push(`removed ${name}`); },
  };
  return { dir, files, log };
}
const later = () => new Promise((r) => setTimeout(r, 0));

test('with room, what is written is on disk whole, and the size said is its size', async () => {
  const d = disk();
  const o = await output(d.dir, 'out.json');
  o.write('{"a":"é"}'); o.writeBytes(new Uint8Array([10]));
  assert.deepEqual(await o.close(), { name: 'out.json', size: 11 });
  assert.equal(new TextDecoder().decode(d.files.get('out.json')), '{"a":"é"}\n');
  assert.deepEqual(d.log, ['closed out.json']);
});

for (const full of ['short', 'throws']) {
  test(`a write the browser has no room for (it ${full === 'short' ? 'writes fewer bytes than given' : 'throws QuotaExceededError'}) ends the output: an error the page says plainly, and no cut file left`, async () => {
    const d = disk({ room: 25, full });
    const o = await output(d.dir, 'out.jsonl');
    o.write('0123456789'); o.write('0123456789');
    let e = null;
    try { o.write('0123456789'); } catch (x) { e = x; }
    assert.ok(e, 'the third write, which does not fit, throws');
    assert.equal(e.kind, 'no-room'); assert.equal(e.message, NO_ROOM); assert.equal(noRoom(e.message), true);
    // Nothing after it is written, and closing does not answer with a size: the run cannot offer the file.
    assert.throws(() => o.write('x'), (x) => x === e);
    assert.throws(() => o.writeBytes(new Uint8Array(1)), (x) => x === e);
    await assert.rejects(() => o.close(), (x) => x === e);
    await later();
    assert.equal(d.files.has('out.jsonl'), false, 'the part written is removed');
    assert.deepEqual(d.log, ['closed out.jsonl', 'removed out.jsonl'], 'closed before it is removed, and once');
  });
}

test('a file shorter on disk than what was written is not offered either', async () => {
  const d = disk();
  const o = await output(d.dir, 'out.nt');
  o.write('0123456789');
  d.files.set('out.nt', d.files.get('out.nt').slice(0, 4));   // cut behind the writer's back
  await assert.rejects(() => o.close(), (x) => x.kind === 'no-room');
  await later();
  assert.equal(d.files.has('out.nt'), false);
});

// The run itself: a record that cannot be written is, for any other reason, left out and reported, and the rest is
// converted. No room is not that: every record after it would fail the same way (and did, some sixty a second, the
// run never ending), so it ends the run at once, as its error, for the page to say.
for (const target of ['plato-jsonl', 'plato-json', 'ntriples', 'lpf', 'tables']) {
  test(`a conversion (${target}) whose output has no room left ends with that error, not with a report of records left out`, async () => {
    const rows = ['id,name,latitude,longitude'];
    for (let i = 0; i < 400; i++) rows.push(`p${i},Place ${i},${50 + i / 1000},${-1 - i / 1000}`);
    const input = await detect([textFile(rows.join('\n') + '\n', 'places.csv')]);
    const run1 = async (room) => {
      const d = disk({ room }), e = env();
      const r = await run({ input, action: 'convert', target, options: { base: 'https://example.org/p/' } }, { ...e, output: (name) => output(d.dir, name) });
      return { r, d };
    };
    // The presence first: with room, it is converted and its output is whole.
    const { r, d } = await run1(Infinity);
    assert.equal(r.report.errors, 0, JSON.stringify(r.report.items).slice(0, 300));
    assert.equal(r.outputs.length, 1); assert.equal(d.files.get(r.outputs[0].name).length, r.outputs[0].size);
    assert.ok(r.outputs[0].size > 2000);
    await assert.rejects(() => run1(r.outputs[0].size >> 1), (x) => x.kind === 'no-room' && x.message === NO_ROOM);
  });
}

test('the error carries the browser\'s own as its cause, and is not a DataError (a run does not report it as a problem in the data)', () => {
  const cause = new Error('quota');
  const e = noRoomError('f', cause);
  assert.equal(e.cause, cause); assert.equal(e.file, 'f'); assert.notEqual(e.name, 'DataError');
});
