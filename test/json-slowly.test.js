// JSON read without holding the page (src/lib/json-slowly.js): what it reads is what JSON.parse reads, whatever is in
// the text and however small the pieces it is taken apart in; what JSON.parse refuses it refuses; and the page is
// given its turns. Every refusal has the same text, mended, read beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSteps, parseSlowly, WHOLE } from '../src/lib/json-slowly.js';

/** Read to the end with no turn given: the value, and how many steps it was read in. */
function read(text, opts) {
  const steps = parseSteps(text, opts);
  for (let n = 0; ; n++) { const s = steps.next(); if (s.done) return { value: s.value, steps: n }; }
}
const VALUES = [
  null, true, false, 0, -1.5e-7, 12345678901234567890, '', 'a "quoted" \\ word', 'ends with a backslash \\', '\\"', 'é ☃   😀', [], {}, [[]], [{}], { a: {} },
  { '': 1, 'a b': [1, 2, { c: null }], '"': '"', '\\': '\\\\', '{': '}', '[': ']', ',': ':' },
  [1, 'two', [3, [4, [5, { six: [7] }]]], { 10: 'ten', 2: 'two', b: 'b', a: 'a' }],
  { places: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`https://example.org/p/${i}`, { label: `Place ${i}`, names: [`Place ${i}`, 'x'.repeat(i)], point: i % 2 ? [i / 7, -i] : null }])),
    candidates: Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, score: i / 60, decision: i % 3 ? { kind: 'match', basis: 'said "so" \\ there' } : null })) },
];

test('what is read is what JSON.parse reads: every kind of value, written tightly and with spaces, taken apart at every size', () => {
  let apart = 0;
  for (const v of VALUES) for (const indent of [undefined, 2, '\t']) {
    const text = JSON.stringify(v, null, indent);
    for (const whole of [0, 1, 7, 50, WHOLE]) {
      const got = read(text, { whole, budget: 0 });
      assert.deepEqual(got.value, JSON.parse(text), `${text.slice(0, 60)} (whole ${whole})`);
      assert.equal(JSON.stringify(got.value), JSON.stringify(JSON.parse(text)), 'and its members in the same order');
      apart += got.steps;
    }
    assert.deepEqual(read(` \n\t${text}\r\n `).value, v === undefined ? undefined : JSON.parse(text), 'with space around it');
  }
  assert.ok(apart > 100, `the values were taken apart (${apart} steps), not handed whole to JSON.parse`);
});

test('what JSON.parse refuses is refused, and the same text mended is read', () => {
  const BAD = ['', ' ', '{', '[', '}', ']', '[1,]', '[,1]', '[1 2]', '{"a":1,}', '{,"a":1}', '{"a" 1}', '{"a":}', '{a:1}', "{'a':1}", '{"a":1 "b":2}', '[1]]', '{}{}', '1,2', '[1],', '"open', '["open]', '{"a":"b}',
    '[01]', '[1.]', '[+1]', '[NaN]', '[undefined]', '[tru]', '["a\\x"]', '["tab\there"]', '{"a":[1,{"b":]}]}', '[[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20}', '{"a":1]', '[1,2,3 // no\n]', '﻿[1]', '[1] '];
  for (const text of BAD) {
    assert.throws(() => JSON.parse(text), SyntaxError, `the control: JSON.parse refuses ${JSON.stringify(text)}`);
    for (const whole of [0, 3, WHOLE]) assert.throws(() => read(text, { whole }), SyntaxError, `${JSON.stringify(text)} (whole ${whole})`);
  }
  for (const text of ['{}', '[1]', '[1, 2]', '{"a":1}', '{"a":[1,{"b":[]}]}', '"closed"', '["tab\\there"]', '[1]\n']) {
    for (const whole of [0, 3, WHOLE]) assert.deepEqual(read(text, { whole }).value, JSON.parse(text), text);
  }
  assert.throws(() => read(undefined), SyntaxError, 'and what is not text at all');
});

test('every cut of a text short, and every one character changed, is read or refused as JSON.parse reads or refuses it', () => {
  const text = JSON.stringify({ a: [1, 'x"y\\', { b: null, c: [true, false, -2.5e3] }], 'd e': {}, f: '\\\\' });
  const same = (t) => {
    let want, threw = false;
    try { want = JSON.parse(t); } catch { threw = true; }
    for (const whole of [0, 5, WHOLE]) {
      if (threw) assert.throws(() => read(t, { whole }), SyntaxError, `${t} (whole ${whole})`);
      else assert.deepEqual(read(t, { whole }).value, want, `${t} (whole ${whole})`);
    }
    return threw;
  };
  let refused = 0, readAll = 0;
  for (let i = 0; i <= text.length; i++) same(text.slice(0, i)) ? refused++ : readAll++;
  for (let i = 0; i < text.length; i++) for (const c of ['"', '\\', ',', ':', '{', '}', '[', ']', ' ', '1', 'x']) same(text.slice(0, i) + c + text.slice(i + 1)) ? refused++ : readAll++;
  assert.ok(refused > 300 && readAll > 30, `${refused} refused and ${readAll} read: both were met`);
});

test('a member named __proto__ is a member, as JSON.parse has it, and never the prototype of what is read', () => {
  const text = '{"__proto__":{"polluted":true},"list":[{"__proto__":1,"x":2}]}';
  for (const whole of [0, WHOLE]) {
    const v = read(text, { whole }).value;
    assert.deepEqual(Object.keys(v), ['__proto__', 'list']);
    assert.equal(Object.getPrototypeOf(v), Object.prototype);
    assert.equal(v.polluted, undefined);
    assert.deepEqual(v, JSON.parse(text));
  }
  assert.equal({}.polluted, undefined);
});

test('a long text is read in steps, a turn given after every budget of reading; a short one, or with time in hand, in none', async () => {
  const big = JSON.stringify({ candidates: Array.from({ length: 5000 }, (_, i) => ({ id: `c${i}`, names: ['a', 'b'], decision: { kind: 'match' } })) });
  assert.ok(big.length > WHOLE * 2);
  let t = 0;
  const ticking = read(big, { budget: 8, now: () => (t += 1) });   // a clock that goes on 1 ms each time it is read
  assert.deepEqual(ticking.value, JSON.parse(big));
  assert.ok(ticking.steps > 20 && ticking.steps < 5000 / 16 + 2, `read in ${ticking.steps} steps`);
  assert.equal(read(big, { now: () => 0 }).steps, 0, 'no step while there is time in hand');
  assert.equal(read('{"a":[1,2,3]}', { budget: 0 }).steps, 0, 'a short text is parsed at once');
  let turns = 0;
  assert.deepEqual(await parseSlowly(big, { budget: 0, pause: async () => { turns++; } }), JSON.parse(big));
  assert.ok(turns > 100, `the page was given ${turns} turns`);
  assert.deepEqual(await parseSlowly('[1,{"a":null}]'), [1, { a: null }], 'with the default pause, a real turn');
  await assert.rejects(parseSlowly(`${big.slice(0, -2)}`, { budget: 0, pause: async () => {} }), SyntaxError, 'a long text cut short is refused at its end');
});
