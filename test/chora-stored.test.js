// What Chora keeps in this browser is checked again when it is read, since any page of the site's origin
// can write it (DEVELOPERS.md, "The shared origin"; the security audit of 1 October 2026, L3 and the
// hand-off of before): who was remembered (src/chora/contributor.js), and what it keeps across the page's
// reload for a permission, how long and how often it is used (src/chora/resume.js).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { load, remember, orcidUri } from '../src/chora/contributor.js';
import { isFresh, FRESH, keepForReload, takeResume } from '../src/chora/resume.js';

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

test('what is kept across a reload is usable for two minutes, not five, and never from the future', () => {
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

// The reload for a permission (src/chora/resume.js): what Chora shows is kept, taken once, read and
// deleted in one transaction; a stale one is not used; and what the page split of before left in the same
// store (the hand-off to Chora's own page, the hand-back from it, the stamp of a round trip) goes with it.
const raw = () => new Promise((resolve, reject) => {
  const q = indexedDB.open('plato-tools-chora', 1);
  q.onupgradeneeded = () => q.result.createObjectStore('kv');
  q.onsuccess = () => { const db = q.result, r = db.transaction('kv').objectStore('kv').getAllKeys(); r.onsuccess = () => { db.close(); resolve(r.result); }; r.onerror = () => reject(r.error); };
  q.onerror = () => reject(q.error);
});
const put = (key, value) => new Promise((resolve, reject) => {
  const q = indexedDB.open('plato-tools-chora', 1);
  q.onupgradeneeded = () => q.result.createObjectStore('kv');
  q.onsuccess = () => { const db = q.result, t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(value, key); t.oncomplete = () => { db.close(); resolve(); }; t.onerror = () => reject(t.error); };
  q.onerror = () => reject(q.error);
});
test('what Chora keeps across a reload is taken once, a stale one is not used, and what the page split left goes with it', async () => {
  globalThis.indexedDB = new IDBFactory();
  const f = new File(['{"places":[]}'], 'mine.json');
  assert.equal(await keepForReload({ files: [f], placeId: 'p1' }), true);
  const got = await takeResume();
  assert.deepEqual([got.files.map((x) => x.name), got.placeId], [['mine.json'], 'p1']);
  assert.equal(await takeResume(), null, 'never twice');
  assert.deepEqual(await raw(), []);
  // Stale: not used, and gone.
  await keepForReload({ files: [f] });
  assert.equal(await takeResume(Date.now() + FRESH + 1), null);
  assert.deepEqual(await raw(), []);
  // The page split's records (the presence first: they are there), let go at the next start.
  for (const k of ['chora-handoff', 'chora-handback', 'chora-handoff-alive']) await put(k, { at: Date.now() });
  assert.deepEqual((await raw()).sort(), ['chora-handback', 'chora-handoff', 'chora-handoff-alive']);
  assert.equal(await takeResume(), null);
  assert.deepEqual(await raw(), []);
});
