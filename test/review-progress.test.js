// Krisis: a review's progress kept in the browser as it is made (src/lib/review-progress.js): the key
// it is kept under, the record and its check on reading back, what is done when a work file is opened
// (put back, offered, or nothing), and the store, in IndexedDB or for the tab as "keep working data"
// says. Every refusal is paired with the same thing done rightly passing, and every absence (nothing
// kept, nothing put back) with a presence beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { readWork, serialiseWork, decide, flag, reviewProgress } from '../src/engine/krisis/work.js';
import { PANEL } from '../src/lib/permission-words.js';
import { REVIEW_KEPT } from '../src/engine/words.js';
import { reviewKey, latestIn, sameWork, decidedOtherwise, recordOf, readRecord, onOpen, progressStore, DB, TAB, MOST } from '../src/lib/review-progress.js';

const A = (s) => `https://example.org/a/${s}`, B = (s) => `https://example.org/b/${s}`;
const hex = (c) => c.repeat(64);
const cand = (id, a, b) => ({ id, candidate_source: A(a), candidate_candidate: B(b), similarity_score: 0.9, distance_km: 1, candidate_status: 'suggested',
  other: { label: b, names: [b], point: null }, decision: null });
/** A review of three places, a candidate each, as a work file holds it, nothing decided. */
const fresh = ({ at = '2026-11-01T10:00:00Z', subject = 'a' } = {}) => readWork(JSON.stringify({
  krisis: 3, generated_at: at, algorithm_version: 'krisis-names 7', match_parameters: {},
  subjects: { title: 'Mine', files: [{ name: 'mine.json', size: 10, sha256: hex(subject) }] },
  others: { title: 'Theirs', files: [{ name: 'theirs.json', size: 20, sha256: hex('b') }] },
  places: Object.fromEntries(['bath', 'bristol', 'wells'].map((p) => [A(p), { label: p, names: [p], point: null }])),
  regions: {}, lookups: [],
  candidates: [cand('c1', 'bath', 'bathe'), cand('c2', 'bristol', 'bristoll'), cand('c3', 'wells', 'welles')],
  reviewer: null, cursor: 0,
}));
/** The same review with its first two places decided, at the times given. */
function decided(times = ['2026-11-02T09:00:00Z', '2026-11-02T09:01:00Z'], work = fresh()) {
  decide(work, 'c1', 'match', { at: times[0] });
  decide(work, 'c2', 'not-this', { at: times[1] });
  return work;
}
const asFile = (work) => readWork(serialiseWork(work));   // as "Save the review" writes it, read again
const AT = new Date('2026-11-02T09:05:00Z');

class Storage {
  constructor({ full = false } = {}) { this.m = new Map(); this.full = full; }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { if (this.full) throw new Error('QuotaExceededError'); this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
const refusing = { open() { throw new Error('refused'); }, deleteDatabase() { throw new Error('refused'); } };
const databases = async (idb) => (await idb.databases()).map((d) => d.name);

test('a review has one key however far it has gone, and another review another', () => {
  const key = reviewKey(fresh());
  assert.match(key, /^[0-9a-f]{64}$/);
  const far = decided(); far.cursor = 2; far.reviewer = { name: 'Ada Reviewer' }; flag(far, 'c3', true);
  assert.equal(reviewKey(far), key, 'decisions, a flag, the cursor and the reviewer are not in the key');
  assert.equal(reviewKey(asFile(far)), key, 'nor is being written and read again');
  assert.notEqual(reviewKey(fresh({ at: '2026-11-01T10:00:01Z' })), key, 'another match of the same files is another review');
  assert.notEqual(reviewKey(fresh({ subject: 'c' })), key, 'so is a match of other files');
});

test('the latest thing a work file records: its making, then its decisions, lookups, batches and Finishes', () => {
  const w = fresh();
  assert.equal(latestIn(w), Date.parse('2026-11-01T10:00:00Z'));
  decided(undefined, w);
  assert.equal(latestIn(w), Date.parse('2026-11-02T09:01:00Z'));
  assert.equal(latestIn({ ...w, finished: [{ at: '2026-11-03T08:00:00Z' }] }), Date.parse('2026-11-03T08:00:00Z'));
  assert.equal(latestIn({ ...w, batches: [{ id: 'b1', at: '2026-11-04T08:00:00Z' }] }), Date.parse('2026-11-04T08:00:00Z'));
  assert.equal(latestIn({ ...w, lookups: [{ started_at: '2026-11-05T08:00:00Z', finished_at: 'not a time' }] }), Date.parse('2026-11-05T08:00:00Z'), 'what is not a time is passed over');
});

test('a record holds the review as "Save the review" would write it, and reads back as it was kept', () => {
  const work = decided();
  const record = recordOf(work, { name: 'mine.krisis.json', cursor: 2, at: AT });
  assert.deepEqual({ ...record, text: null }, { krisisProgress: 1, key: reviewKey(work), name: 'mine.krisis.json', at: '2026-11-02T09:05:00.000Z', reviewed: 2, text: null });
  assert.equal(record.text, serialiseWork({ ...work, cursor: 2 }), 'the work file\'s own text: its format is not changed');
  assert.equal(work.cursor, 0, 'the review itself is not changed by being kept');
  const back = readRecord(JSON.parse(JSON.stringify(record)), record.key);
  assert.equal(back.name, 'mine.krisis.json'); assert.equal(back.at, record.at); assert.equal(back.reviewed, 2);
  assert.deepEqual(back.work, { ...work, cursor: 2 });
  assert.deepEqual(reviewProgress(back.work), { reviewed: 2, total: 3 });
});

test('a record that is not one is not read: not the work file\'s format, another review\'s, kept under another key, with no time', () => {
  const record = recordOf(decided(), { at: AT });
  assert.ok(readRecord(record, record.key), 'control: the record as kept reads');
  const other = recordOf(decided(undefined, fresh({ subject: 'c' })), { at: AT });
  for (const [why, bad] of [
    ['nothing', null], ['a string', 'x'], ['no mark', { ...record, krisisProgress: undefined }],
    ['a text that is not a work file', { ...record, text: '{"krisis":3}' }],
    ['a text that is not JSON', { ...record, text: record.text.slice(0, 40) }],
    ['a decision no review could have written', { ...record, text: record.text.replace('"confirmed"', '"suggested"') }],
    ['another review\'s text under this key', { ...record, text: other.text }],
    ['no time', { ...record, at: 'yesterday' }],
    ['a key that is not one', { ...record, key: 'abc' }],
  ]) assert.equal(readRecord(bad, record.key), null, why);
  assert.equal(readRecord(other, record.key), null, 'another review\'s record is not this key\'s');
  assert.ok(readRecord(other, other.key), 'control: it is its own');
  assert.ok(readRecord(other), 'control: and reads when no key is asked of it');
});

test('opening a work file: what is kept and later than the file is put back; what is not later is offered; the same, or none, does nothing', () => {
  const file = asFile(fresh());
  assert.deepEqual(onOpen(file, null), { action: 'none', record: null }, 'nothing kept');
  const kept = readRecord(recordOf(decided(), { cursor: 2, at: AT }));
  // Kept after everything the file records (it was made on 1 November, and nothing in it decided): put back.
  const put = onOpen(file, kept);
  assert.equal(put.action, 'restore');
  assert.equal(put.record.work.candidates[0].decision.kind, 'match');
  assert.equal(put.record.work.cursor, 2, 'at the place the reviewer was at');
  assert.deepEqual([put.fileReviewed, put.record.reviewed, put.differing], [0, 2, 2]);
  // The file holds exactly what is kept (saved since, the reviewer at another place): nothing to put back, and it is known to be kept.
  const same = onOpen(asFile({ ...decided(), cursor: 1 }), kept);
  assert.equal(same.action, 'none'); assert.equal(same.record, kept);
  // The file records a decision made after what is kept was last changed (made elsewhere, say): the file is shown, what is kept offered.
  const laterFile = asFile(decided(['2026-11-02T09:00:00Z', '2026-11-02T09:30:00Z']));
  decide(laterFile, 'c3', 'match', { at: '2026-11-02T09:31:00Z' });
  const offer = onOpen(laterFile, kept);
  assert.equal(offer.action, 'offer');
  assert.deepEqual([offer.fileReviewed, offer.record.reviewed, offer.differing], [3, 2, 2], 'c2 was decided at another time, and c3 only in the file');
  // Asked for, it is taken.
  assert.equal(onOpen(laterFile, kept, { use: true }).action, 'restore');
  // The review open on the page as its file is chosen (to go back to it as saved, say): the file is shown, and what is
  // kept (the page's own, later than the file) is offered, not put back; asked for, it is taken.
  assert.equal(onOpen(file, kept, { open: true }).action, 'offer');
  assert.equal(onOpen(file, kept, { open: true, use: true }).action, 'restore');
  assert.equal(onOpen(file, kept, { open: false }).action, 'restore', 'control: not open (the page reloaded), it is put back');
  // Another review's record is nothing to this file.
  const other = readRecord(recordOf(decided(undefined, fresh({ subject: 'c' })), { at: AT }));
  assert.deepEqual(onOpen(file, other), { action: 'none', record: null });
});

test('two reviews are the same whichever place each is at, and differ by a decision, a flag or a note', () => {
  const a = decided(), b = decided();
  b.cursor = 2;
  assert.ok(sameWork(a, b));
  assert.equal(decidedOtherwise(a, b), 0);
  flag(b, 'c3', true);
  assert.ok(!sameWork(a, b), 'a flag');
  assert.equal(decidedOtherwise(a, b), 0, 'a flag is not a decision');
  decide(b, 'c1', null);
  assert.equal(decidedOtherwise(a, b), 1, 'a decision taken back');
  assert.equal(decidedOtherwise(a, { ...b, candidates: b.candidates.slice(0, 2) }), 1, 'a candidate there in one only, undecided, is not one');
  assert.equal(decidedOtherwise({ ...a, candidates: a.candidates.slice(1) }, a), 1, 'a decided one is');
});

test('kept between visits: in IndexedDB, read by another tab; nothing in the tab\'s own storage', async () => {
  const idb = new IDBFactory(), session = new Storage();
  const store = progressStore({ indexedDB: idb, session, keep: () => true });
  const record = recordOf(decided(), { name: 'mine.krisis.json', cursor: 1, at: AT });
  assert.equal(await store.get(record.key), null, 'nothing kept yet');
  assert.equal(await store.put(record), 'browser');
  assert.equal(session.length, 0);
  assert.deepEqual(await databases(idb), [DB]);
  const another = progressStore({ indexedDB: idb, session: new Storage(), keep: () => true });
  const back = await another.get(record.key);
  assert.equal(back.name, 'mine.krisis.json'); assert.equal(back.reviewed, 2); assert.equal(back.work.cursor, 1);
  assert.equal(back.work.candidates[0].decision.kind, 'match');
  assert.equal(await another.get(reviewKey(fresh({ subject: 'c' }))), null, 'another review has none');
});

test('a later keeping replaces an earlier one, in the order asked', async () => {
  const store = progressStore({ indexedDB: new IDBFactory(), session: new Storage(), keep: () => true });
  const work = fresh();
  decide(work, 'c1', 'match', { at: '2026-11-02T09:00:00Z' });
  const first = store.put(recordOf(work, { at: new Date('2026-11-02T09:00:01Z') }));
  decide(work, 'c2', 'match', { at: '2026-11-02T09:00:02Z' });
  const second = store.put(recordOf(work, { at: new Date('2026-11-02T09:00:03Z') }));   // asked before the first has landed
  assert.deepEqual(await Promise.all([first, second]), ['browser', 'browser']);
  const back = await store.get(reviewKey(work));
  assert.equal(back.reviewed, 2); assert.equal(back.at, '2026-11-02T09:00:03.000Z');
});

test('with "keep working data" off: for the tab only, and what IndexedDB held is let go', async () => {
  const idb = new IDBFactory(), session = new Storage();
  let keep = true;
  const store = progressStore({ indexedDB: idb, session, keep: () => keep });
  const record = recordOf(decided(), { at: AT });
  assert.equal(await store.put(record), 'browser');
  assert.deepEqual(await databases(idb), [DB], 'control: kept between visits while it is on');
  keep = false;
  await store.forgetKept();
  assert.deepEqual(await databases(idb), [], 'turned off: cleared at once');
  assert.equal(await store.get(record.key), null, 'and not in the tab either: the page keeps the review open again');
  assert.equal(await store.put(record), 'tab');
  assert.deepEqual(await databases(idb), []);
  assert.equal(session.getItem(TAB + record.key) !== null, true);
  // After a reload (the same tab's storage, a new page): there. In another tab: not.
  assert.equal((await progressStore({ indexedDB: idb, session, keep: () => false }).get(record.key)).reviewed, 2);
  assert.equal(await progressStore({ indexedDB: idb, session: new Storage(), keep: () => false }).get(record.key), null);
  // Turned on again, the next keeping is between visits, and the tab's copy goes.
  keep = true;
  assert.equal(await store.put(record), 'browser');
  assert.equal(session.length, 0);
  // A store first used with it off lets go what an earlier visit kept.
  await progressStore({ indexedDB: idb, session: new Storage(), keep: () => false }).get(record.key);
  assert.deepEqual(await databases(idb), []);
});

test('a browser that refuses IndexedDB keeps it for the tab; one that refuses both, for the page alone, and says so', async () => {
  const record = recordOf(decided(), { at: AT });
  const session = new Storage();
  const tabOnly = progressStore({ indexedDB: refusing, session, keep: () => true });
  assert.equal(await tabOnly.put(record), 'tab');
  assert.equal((await progressStore({ indexedDB: refusing, session, keep: () => true }).get(record.key)).reviewed, 2, 'there after a reload');
  for (const ss of [new Storage({ full: true }), null]) {
    const pageOnly = progressStore({ indexedDB: refusing, session: ss, keep: () => true });
    assert.equal(await pageOnly.put(record), 'page');
    assert.equal((await pageOnly.get(record.key)).reviewed, 2, 'held while the page lasts');
    assert.equal(await progressStore({ indexedDB: refusing, session: ss, keep: () => true }).get(record.key), null, 'and not after it');
  }
});

test('what is read back is checked: a record another page of the origin wrote wrongly is not returned', async () => {
  const idb = new IDBFactory(), session = new Storage();
  const record = recordOf(decided(), { at: AT });
  session.setItem(TAB + record.key, JSON.stringify({ ...record, text: '{"krisis":3,"places":{}}' }));
  const store = progressStore({ indexedDB: idb, session, keep: () => false });
  assert.equal(await store.get(record.key), null);
  session.setItem(TAB + record.key, JSON.stringify(record));
  assert.equal((await store.get(record.key)).reviewed, 2, 'control: the record as kept is');
});

test('of the tab\'s and the browser\'s, the one changed later is returned', async () => {
  const idb = new IDBFactory(), session = new Storage();
  const early = recordOf(fresh(), { at: new Date('2026-11-02T08:00:00Z') }), late = recordOf(decided(), { at: AT });
  await progressStore({ indexedDB: idb, session: new Storage(), keep: () => true }).put(late);
  session.setItem(TAB + early.key, JSON.stringify(early));   // left from a time it was off
  assert.equal((await progressStore({ indexedDB: idb, session, keep: () => true }).get(late.key)).reviewed, 2);
  session.setItem(TAB + early.key, JSON.stringify({ ...early, at: '2026-11-02T10:00:00.000Z' }));
  assert.equal((await progressStore({ indexedDB: idb, session, keep: () => true }).get(late.key)).reviewed, 0, 'control: the tab\'s, when it is the later');
});

test('"Clear what is kept" lets one review\'s progress go and leaves another\'s; "Clear them" lets all go, the tab\'s too', async () => {
  for (const keep of [true, false]) {
    const idb = new IDBFactory(), session = new Storage();
    const store = progressStore({ indexedDB: idb, session, keep: () => keep });
    const mine = recordOf(decided(), { at: AT }), other = recordOf(decided(undefined, fresh({ subject: 'c' })), { at: AT });
    await store.put(mine); await store.put(other);
    assert.equal((await store.get(mine.key)).reviewed, 2, 'control: kept');
    await store.forget(mine.key);
    assert.equal(await store.get(mine.key), null);
    assert.equal((await store.get(other.key)).reviewed, 2, 'the other review\'s is left');
    await store.forgetAll();
    assert.deepEqual(await databases(idb), [], 'the database too');
    assert.equal(session.length, 0);
    assert.equal(await store.get(other.key), null);
  }
});

test('the Permissions panel lists the review\'s progress among what "Keep my working data" keeps, with the number of reviews the store keeps, and the line\'s words say where it is kept', () => {
  const note = PANEL.keepWorkNote;
  assert.ok(note.includes('Krisis keeps your progress in a match review as you make it'), note);
  assert.ok(note.includes(`for the ${MOST} reviews you last worked on`), note);
  assert.ok(note.includes('“Clear what is kept”'), note);
  assert.equal(REVIEW_KEPT.clear, 'Clear what is kept', 'the button the panel names');
  assert.match(REVIEW_KEPT.kept('browser'), /kept in this browser as you go.*sent nowhere/);
  assert.match(REVIEW_KEPT.kept('tab'), /kept for this tab only \(your working data is not kept between visits\).*sent nowhere/);
  const said = { at: '2026-11-02T09:05:00.000Z', reviewed: 2, fileReviewed: 0 };
  assert.match(REVIEW_KEPT.restored(said, 'browser'), /^Your progress kept in this browser on .+ has been put back: 2 places reviewed, where the file opened has 0\./);
  assert.match(REVIEW_KEPT.restored({ ...said, reviewed: 1 }, 'tab'), /^Your progress kept for this tab on .+: 1 place reviewed/);
  assert.match(REVIEW_KEPT.offered(said, 'browser'), /^This browser keeps other progress in this review, from .+ not put back unless you ask/);
});

test(`the ${MOST} reviews last changed are kept between visits; the ones changed longest ago are let go`, async () => {
  const store = progressStore({ indexedDB: new IDBFactory(), session: new Storage(), keep: () => true });
  const records = [];
  for (let i = 0; i < MOST + 2; i++) {
    const r = recordOf(decided(undefined, fresh({ at: `2026-10-${String(i + 1).padStart(2, '0')}T10:00:00Z` })), { at: new Date(Date.parse('2026-11-02T09:00:00Z') + i * 60000) });
    records.push(r); await store.put(r);
  }
  assert.equal(await store.get(records[0].key), null);
  assert.equal(await store.get(records[1].key), null);
  for (const r of records.slice(2)) assert.equal((await store.get(r.key)).reviewed, 2, 'the later ones are all there');
  // One of the kept changed again is not one more: nothing else goes.
  await store.put({ ...records[2], at: '2026-11-03T09:00:00.000Z' });
  assert.equal((await store.get(records[3].key)).reviewed, 2);
});
