// The page's queue to the worker (src/chora/queue.js): one command at a time, in order, and of the
// searches typed while the worker is busy only the latest is sent, so that a place chosen after them
// is not kept waiting behind searches nobody will see. The control: commands not marked as searches
// are each sent, whatever follows them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialQueue } from '../src/chora/queue.js';

function worker() {
  const sent = [], waiting = [];
  const send = (msg) => { sent.push(msg); return new Promise((resolve) => waiting.push(() => resolve({ reply: msg }))); };
  const answer = async () => { while (waiting.length) { waiting.shift()(); await new Promise((r) => setTimeout(r, 0)); } };
  return { sent, send, answer };
}

test('searches typed while the worker is busy: only the latest is sent, and a place chosen meanwhile is', async () => {
  const w = worker(), request = serialQueue(w.send);
  const busy = request({ cmd: 'chora-load' });
  const a = request({ cmd: 'chora-search', q: 'a' }, { latestOf: 'search' });
  const ab = request({ cmd: 'chora-search', q: 'ab' }, { latestOf: 'search' });
  const place = request({ cmd: 'chora-place', id: 'x' });
  const abc = request({ cmd: 'chora-search', q: 'abc' }, { latestOf: 'search' });
  await w.answer(); await w.answer();
  assert.deepEqual(w.sent.map((m) => m.q ?? m.cmd), ['chora-load', 'chora-place', 'abc']);
  assert.equal(await a, null, 'a search overtaken before it was sent is never sent, and says so');
  assert.equal(await ab, null);
  assert.deepEqual(await abc, { reply: { cmd: 'chora-search', q: 'abc' } });
  assert.deepEqual(await place, { reply: { cmd: 'chora-place', id: 'x' } });
  assert.deepEqual(await busy, { reply: { cmd: 'chora-load' } });
});

test('a search already sent is answered; and without latestOf, every command is sent in order', async () => {
  const w = worker(), request = serialQueue(w.send);
  const first = request({ cmd: 'chora-search', q: 'a' }, { latestOf: 'search' });
  await new Promise((r) => setTimeout(r, 0));   // sent now: the worker has it
  const second = request({ cmd: 'chora-search', q: 'ab' }, { latestOf: 'search' });
  await w.answer(); await w.answer();
  assert.deepEqual(w.sent.map((m) => m.q), ['a', 'ab']);
  assert.deepEqual(await first, { reply: { cmd: 'chora-search', q: 'a' } });
  assert.deepEqual(await second, { reply: { cmd: 'chora-search', q: 'ab' } });
  const v = worker(), plain = serialQueue(v.send);
  const all = ['a', 'ab', 'abc'].map((q) => plain({ cmd: 'chora-search', q }));
  await v.answer(); await v.answer(); await v.answer();
  assert.deepEqual(v.sent.map((m) => m.q), ['a', 'ab', 'abc']);
  assert.deepEqual((await Promise.all(all)).map((r) => r.reply.q), ['a', 'ab', 'abc']);
});

test('a command that fails does not stop the queue', async () => {
  let n = 0;
  const request = serialQueue(async (msg) => { if (n++ === 0) throw new Error('no'); return msg; });
  await assert.rejects(request({ cmd: 'x' }), /no/);
  assert.deepEqual(await request({ cmd: 'y' }), { cmd: 'y' });
});
