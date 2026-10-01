// The page's queue to the worker (src/chora/queue.js): one command at a time, in order, and of the
// searches typed while the worker is busy only the latest is sent, so that a place chosen after them
// is not kept waiting behind searches nobody will see. The control: commands not marked as searches
// are each sent, whatever follows them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialQueue, pageRequest, answers } from '../src/chora/queue.js';

function worker() {
  const sent = [], waiting = [];
  const send = (msg) => { sent.push(msg); return new Promise((resolve) => waiting.push(() => resolve({ reply: msg }))); };
  // Waits a turn first, so that a command asked for just now has been sent.
  const answer = async () => { await new Promise((r) => setTimeout(r, 0)); while (waiting.length) { waiting.shift()(); await new Promise((r) => setTimeout(r, 0)); } };
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

// Next and Previous: which page to ask for depends on the page shown, and the page shown on the reply
// to the command before. A command given as a function is made when it is sent, not when it is asked
// for, so it sees what the reply before it did. Here as the page does it: an async function that
// awaits the reply and then records where the list is.
function pager(w, { latestOf } = {}) {
  const request = serialQueue(w.send);
  const at = { after: 0, next: 0, shown: [] };
  async function next() {
    const r = await request(() => ({ cmd: 'chora-search', q: 'x', after: at.next }), { latestOf });
    if (!r) return;
    at.after = r.reply.after; at.next = r.reply.after + 50; at.shown.push(r.reply.after);
  }
  return { at, next };
}

test('a command given as a function is made when it is sent: Next twice goes on two pages, not one twice', async () => {
  const w = worker(), p = pager(w);
  const one = p.next(), two = p.next();    // two clicks before the first is answered
  await w.answer(); await w.answer(); await one; await two;
  assert.deepEqual(w.sent.map((m) => m.after), [0, 50], 'the second is asked for from where the first left the list');
  assert.deepEqual(p.at.shown, [0, 50]);
  // The control: the same two clicks with the page worked out when asked, as before, ask for one page twice.
  const v = worker(), request = serialQueue(v.send), at = { next: 0 };
  const asked = [0, 1].map(() => request({ cmd: 'chora-search', after: at.next }).then((r) => { at.next = r.reply.after + 50; }));
  await v.answer(); await v.answer(); await Promise.all(asked);
  assert.deepEqual(v.sent.map((m) => m.after), [0, 0]);
});

test('a command given as a function and passed over by a later one is never made', async () => {
  const w = worker(), request = serialQueue(w.send), made = [];
  const busy = request({ cmd: 'chora-load' });
  const a = request(() => { made.push('a'); return { cmd: 'chora-search', q: 'a' }; }, { latestOf: 'search' });
  const b = request(() => { made.push('b'); return { cmd: 'chora-search', q: 'b' }; }, { latestOf: 'search' });
  await w.answer(); await w.answer();
  assert.deepEqual(made, ['b']);
  assert.equal(await a, null);
  assert.deepEqual(await b, { reply: { cmd: 'chora-search', q: 'b' } });
  await busy;
});

test('a command given as a function that makes nothing (null) is not sent, and resolves to null; the queue goes on', { timeout: 5000 }, async () => {
  const w = worker(), request = serialQueue(w.send);
  const none = request(() => null);
  const after = request({ cmd: 'chora-place', id: 'x' });
  await w.answer();
  assert.equal(await none, null);
  assert.deepEqual(w.sent, [{ cmd: 'chora-place', id: 'x' }], 'nothing was sent for it; the command after it was');
  assert.deepEqual(await after, { reply: { cmd: 'chora-place', id: 'x' } });
});

// The page's list as app.js's search() keeps it: the query in the box, the query last searched for
// (set when typing settles), and where its pages begin. Next and Previous capture the query when
// clicked; the search box's new query is sent as the latest of its kind.
function list(send) {
  const request = serialQueue(send);
  const ui = { box: 'a', query: 'a', starts: [0], nextAfter: 50, shown: [] };
  async function search(to) {
    const asked = ui.query;
    let req = null;
    const r = await request(() => {
      req = pageRequest(to, { asked, box: ui.box, starts: ui.starts, nextAfter: ui.nextAfter });
      return req && { cmd: 'chora-search', q: req.q, after: req.pages[req.pages.length - 1] };
    }, to === 'first' ? { latestOf: 'search' } : undefined);
    if (!r || !answers(r.reply, req.q, ui.box)) return;
    ui.starts = req.pages; ui.nextAfter = r.reply.after + 50; ui.shown.push([r.reply.q, r.reply.after]);
  }
  const type = (q) => { ui.box = q; };
  const settle = () => { ui.query = ui.box.trim(); return search('first'); };
  return { ui, search, type, settle };
}

test('Next clicked, then a new query typed before Next is sent: Next sends nothing, and the new query its first page', { timeout: 5000 }, async () => {
  const w = worker(), l = list(w.send);
  const next = l.search('next');      // clicked for "a", page 2 ...
  l.type('b');                        // ... then "b" typed, and typing settles before Next is sent
  const first = l.settle();
  await w.answer(); await w.answer(); await next; await first;
  assert.deepEqual(w.sent.map((m) => [m.q, m.after]), [['b', 0]], 'no page 2 of "b" asked for from where the list of "a" was');
  assert.deepEqual(l.ui.shown, [['b', 0]]);
  assert.deepEqual(l.ui.starts, [0]);
  // The control: Next with the box unchanged is sent, from where the list is.
  const v = worker(), c = list(v.send);
  const n2 = c.search('next');
  await v.answer(); await n2;
  assert.deepEqual(v.sent.map((m) => [m.q, m.after]), [['a', 50]]);
  assert.deepEqual(c.ui.shown, [['a', 50]]);
});

test('the query in the box folded as the search folds it: Next is still sent when only case or accents differ', { timeout: 5000 }, async () => {
  const w = worker(), l = list(w.send);
  l.ui.query = 'Áb'; l.type('ab ');
  const next = l.search('next');
  await w.answer(); await next;
  assert.deepEqual(w.sent.map((m) => [m.q, m.after]), [['Áb', 50]]);
  assert.equal(l.ui.shown.length, 1);
});

test('a reply whose q is not the q its request was made for is not shown, even if the box holds that q', { timeout: 5000 }, async () => {
  // A worker that answers every search with the query "b".
  const sent = [], send = (msg) => { sent.push(msg); return Promise.resolve({ reply: { ...msg, q: 'b' } }); };
  const l = list(send);
  l.ui.box = 'b';            // the box holds "b", and the request was made for "a" (pageRequest refuses it)
  assert.equal(pageRequest('next', { asked: 'a', box: 'b', starts: [0], nextAfter: 50 }), null);
  assert.equal(answers({ q: 'b' }, 'a', 'b'), false, 'made for "a", answered for "b": not shown');
  assert.equal(answers({ q: 'a' }, 'a', 'b'), false, 'answered for "a", the box now "b": not shown');
  assert.equal(answers({ q: 'A' }, 'á', ' a'), true, 'the same query folded: shown');
  l.ui.box = 'a';
  await l.search('first');
  assert.deepEqual(sent.map((m) => m.q), ['a']);
  assert.deepEqual(l.ui.shown, [], 'the reply said "b" to a request for "a"');
});

test('pageRequest: which page each of first, next and previous asks for', () => {
  const at = { asked: 'a', box: 'a', starts: [0, 50], nextAfter: 100 };
  assert.deepEqual(pageRequest('first', at), { q: 'a', pages: [0] });
  assert.deepEqual(pageRequest('next', at), { q: 'a', pages: [0, 50, 100] });
  assert.deepEqual(pageRequest('prev', at), { q: 'a', pages: [0] });
  assert.deepEqual(pageRequest('next', { ...at, nextAfter: null }), { q: 'a', pages: [0, 50] });
  assert.deepEqual(pageRequest('prev', { ...at, starts: [0] }), { q: 'a', pages: [0] });
  // A new query is sent whatever the box holds now: the latest of them is the one that counts.
  assert.deepEqual(pageRequest('first', { ...at, box: 'zz' }), { q: 'a', pages: [0] });
  assert.equal(pageRequest('prev', { ...at, box: 'zz' }), null);
});
