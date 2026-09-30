// The WHG token's keeper for the page (src/lib/whg-token.js), shared by Krisis and Chora: kept in this
// tab only (sessionStorage), with memory where storage is refused; never in localStorage; forget()
// clears both. Node has no Web Storage, so each test gives the module a stand-in, and each absence is
// checked beside a presence found by the same look.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as whgToken from '../src/lib/whg-token.js';

const KEY = 'plato-tools.whg-token';
function storage({ refuse = false } = {}) {
  const m = new Map();
  const no = () => { if (refuse) throw new DOMException('refused', 'SecurityError'); };
  return { m, getItem: (k) => { no(); return m.has(k) ? m.get(k) : null; }, setItem: (k, v) => { no(); m.set(k, String(v)); }, removeItem: (k) => { no(); m.delete(k); } };
}
beforeEach(() => {
  globalThis.sessionStorage = storage();
  globalThis.localStorage = storage();
  whgToken.forget();
});

test('a token is kept in sessionStorage, never localStorage, and forget() clears it and memory', () => {
  whgToken.set('  tok-123  ');
  assert.equal(whgToken.get(), 'tok-123');
  assert.equal(sessionStorage.m.get(KEY), 'tok-123', 'control: the look finds it where it is kept');
  assert.equal(localStorage.m.has(KEY), false);
  whgToken.forget();
  assert.equal(whgToken.get(), null);
  assert.equal(sessionStorage.m.has(KEY), false);
});
test('forget() also clears a token some other version left in localStorage', () => {
  localStorage.m.set(KEY, 'old');
  whgToken.forget();
  assert.equal(localStorage.m.has(KEY), false);
});
test('where storage is refused, the token is kept in memory, and forget() clears it', () => {
  globalThis.sessionStorage = storage({ refuse: true });
  globalThis.localStorage = storage({ refuse: true });
  whgToken.set('tok-mem');
  assert.equal(whgToken.get(), 'tok-mem');
  whgToken.forget();
  assert.equal(whgToken.get(), null);
});
test('an empty token is the same as forgetting it', () => {
  whgToken.set('tok');
  whgToken.set('   ');
  assert.equal(whgToken.get(), null);
});
test('onChange says whether there is a token, never what it is, and can be stopped', () => {
  const heard = [];
  const stop = whgToken.onChange((...args) => heard.push(args));
  whgToken.set('tok-secret');
  whgToken.forget();
  stop();
  whgToken.set('tok-again');
  assert.deepEqual(heard, [[true], [false]]);
  assert.ok(!JSON.stringify(heard).includes('tok-'), 'no listener is given the token');
});
