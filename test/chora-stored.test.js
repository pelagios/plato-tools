// What Chora keeps in this browser is checked again when it is read, since any page of the site's origin
// can write it (DEVELOPERS.md, "The shared origin"; the security audit of 1 October 2026, L3 and the
// hand-off): who was remembered (src/chora/contributor.js), and how long files handed over from the
// main page are usable (src/chora/handoff.js).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { load, remember, orcidUri } from '../src/chora/contributor.js';
import { isFresh, FRESH } from '../src/chora/handoff.js';

class Store { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }
beforeEach(() => { globalThis.localStorage = new Store(); });

test('a remembered ORCID that is not one (planted, or mistyped by an older page) is dropped on load; one that is one is kept, in full', () => {
  for (const bad of ['javascript:alert(1)', 'https://orcid.org/0000-0002-1825-0098', 'https://evil.example.org/0000-0002-1825-0097', 42, '']) {
    localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test', orcid: bad }));
    assert.deepEqual(load(), { name: 'Ada Test' }, `dropped: ${JSON.stringify(bad)}`);
  }
  // The controls: a right iD, as the address or as the digits alone, is kept as the address; other keys are not carried.
  localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test', orcid: '0000-0002-1825-0097', role: 'admin' }));
  assert.deepEqual(load(), { name: 'Ada Test', orcid: 'https://orcid.org/0000-0002-1825-0097' });
  remember({ name: 'Ada Test', orcid: orcidUri('https://orcid.org/0000-0002-1825-0097') });
  assert.deepEqual(load(), { name: 'Ada Test', orcid: 'https://orcid.org/0000-0002-1825-0097' });
  // No name: nothing, whatever else is there.
  localStorage.setItem('chora-contributor', JSON.stringify({ orcid: 'https://orcid.org/0000-0002-1825-0097' }));
  assert.equal(load(), null);
  localStorage.setItem('chora-contributor', '[1, 2]');
  assert.equal(load(), null);
});

test('files handed over are usable for two minutes, not five, and never from the future', () => {
  const now = 1_800_000_000_000;
  assert.equal(FRESH, 2 * 60 * 1000);
  assert.equal(isFresh({ at: now - 1000 }, now), true);
  assert.equal(isFresh({ at: now - FRESH + 1 }, now), true);
  assert.equal(isFresh({ at: now - FRESH }, now), false);
  assert.equal(isFresh({ at: now - 5 * 60 * 1000 + 1 }, now), false, 'what the old limit allowed');
  assert.equal(isFresh({ at: now + 60_000 }, now), false, 'a time stamp from the future is not fresh');
  assert.equal(isFresh({ at: 'yesterday' }, now), false);
  assert.equal(isFresh({}, now), false);
  assert.equal(isFresh(null, now), false);
});
