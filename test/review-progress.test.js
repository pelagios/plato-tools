// Krisis: a review's progress kept in the browser as it is made (src/lib/review-progress.js): the key
// it is kept under, the record and its check on reading back, what is done when a work file is opened
// (put back, offered, or nothing), and the store, in IndexedDB or for the tab as "keep working data"
// says. Every refusal is paired with the same thing done rightly passing, and every absence (nothing
// kept, nothing put back) with a presence beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { readWork, readWorkSlowly, serialiseWork, decide, flag, reviewProgress } from '../src/engine/krisis/work.js';
import { PANEL } from '../src/lib/permission-words.js';
import { REVIEW_KEPT } from '../src/engine/words.js';
import { reviewKey, latestIn, sameWork, decidedOtherwise, recordOf, readRecord, onOpen, progressStore, offerable, DB, TAB, MOST,
  jsonPieces, recordSlowly, readRecordSlowly, textOf, PART, PARTS, STORE, DB_VERSION, TAB_MOST, SLOWLY_FROM } from '../src/lib/review-progress.js';

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

test('read back without holding the page: the same record as read at once, the same refusals, and the page given its turns', async () => {
  const record = recordOf(decided(), { at: AT });
  assert.deepEqual(await readRecordSlowly(record, record.key), readRecord(record, record.key), 'a short record, read in one go');
  const other = recordOf(decided(undefined, fresh({ subject: 'c' })), { at: AT });
  for (const [why, bad] of [
    ['nothing', null], ['a string', 'x'], ['no mark', { ...record, krisisProgress: undefined }],
    ['a text that is not a work file', { ...record, text: '{"krisis":3}' }],
    ['a text that is not JSON', { ...record, text: record.text.slice(0, 40) }],
    ['a decision no review could have written', { ...record, text: record.text.replace('"confirmed"', '"suggested"') }],
    ['another review\'s text under this key', { ...record, text: other.text }],
    ['no time', { ...record, at: 'yesterday' }],
    ['a key that is not one', { ...record, key: 'abc' }],
  ]) assert.equal(await readRecordSlowly(bad, record.key), null, why);
  assert.equal(await readRecordSlowly(other, record.key), null, 'another review\'s record is not this key\'s');
  assert.ok(await readRecordSlowly(other, other.key), 'control: it is its own');
  // A large review, kept in parts: turns are given while it is parsed, and while it is checked.
  const w = large(SLOWLY_FROM); w.cursor = 9;
  const slow = await recordSlowly(w, { at: AT, unsaved: true });
  let turns = 0;
  const back = await readRecordSlowly(slow, slow.key, { budget: 0, pause: async () => { turns++; } });
  assert.deepEqual(back, readRecord(slow, slow.key), 'the same record as read at once');
  assert.ok(back.reviewed === SLOWLY_FROM && back.work.cursor === 9 && back.unsaved === true && sameWork(back.work, w), 'which is the review kept');
  // One turn for every 16 places or candidates parsed; one for every 256 checked: the places, the candidates and the candidates again by the reader itself,
  // the candidates by the lookups' check (there is no lookup), the places and the candidates by the workflow fields' check.
  const N = SLOWLY_FROM, parsing = Math.floor((2 * N) / 16), checking = Math.floor((3 * N) / 256) + Math.floor(N / 256) + Math.floor((2 * N) / 256);
  assert.ok(turns >= parsing + checking - 1 && turns <= parsing + checking + 1, `the page was given ${turns} turns: ${parsing} in the parsing and ${checking} in the checking`);
  // A large record whose last candidate is one no review could have written is refused whole, after the turns given on the way to it.
  const last = slow.parts.length - 1, spoiled = { ...slow, parts: slow.parts.map((part, i) => (i === last ? part.replace(/"candidate_status":"confirmed"(?![^]*"candidate_status")/, '"candidate_status":"suggested"') : part)) };
  assert.notEqual(spoiled.parts[last], slow.parts[last], 'control: the last candidate was changed');
  turns = 0;
  assert.equal(await readRecordSlowly(spoiled, slow.key, { budget: 0, pause: async () => { turns++; } }), null);
  assert.equal(readRecord(spoiled, slow.key), null, 'as it is at once');
  assert.ok(turns > parsing, `refused after ${turns} turns`);
});

test('the work file\'s reader in steps reads and refuses as the reader at once does, in the same words', async () => {
  const good = JSON.parse(serialiseWork(decided()));
  assert.deepEqual(await readWorkSlowly(structuredClone(good)), readWork(structuredClone(good)));
  const lookedUp = { ...structuredClone(good), others: null, lookups: [{ id: 'l1', service: { endpoint: 'https://example.org/reconcile', title: 'A gazetteer' }, started_at: '2026-11-01T10:00:00Z',
    queries: Object.fromEntries(Object.keys(good.places).map((iri) => [iri, { state: 'answered', sent: ['x'] }])) }],
    candidates: good.candidates.map((c) => ({ ...c, lookup: 'l1', gazetteer: { service: 'https://example.org/reconcile', score: 90 } })) };
  assert.deepEqual(await readWorkSlowly(structuredClone(lookedUp)), readWork(structuredClone(lookedUp)), 'with a lookup');
  const spoil = [
    (w) => { delete w.krisis; }, (w) => { w.krisis = 99; }, (w) => { w.places['not an address'] = { label: 'x', names: [], point: null }; },
    (w) => { w.candidates[2].similarity_score = 7; }, (w) => { w.candidates[1].id = 'c1'; }, (w) => { w.candidates[0].candidate_status = 'suggested'; },
    (w) => { w.candidates[2].flagged = 'yes'; }, (w) => { w.cursor = -1; }, (w) => { w.candidates = null; },
  ];
  for (const f of spoil) {
    const a = structuredClone(good), b = structuredClone(good);
    f(a); f(b);
    let said = null;
    try { readWork(a); } catch (e) { said = e; }
    assert.ok(said && said.name === 'DataError', `control: the reader at once refuses it (${f})`);
    await assert.rejects(readWorkSlowly(b, { budget: 0, pause: async () => {} }), (e) => e.name === said.name && e.message === said.message, said.message);
  }
  const queries = [(w) => { w.lookups[0].queries['https://example.org/elsewhere'] = { state: 'answered', sent: [] }; }, (w) => { Object.values(w.lookups[0].queries)[1].state = 'lost'; }, (w) => { w.candidates[1].lookup = 'l9'; }];
  for (const f of queries) {
    const a = structuredClone(lookedUp), b = structuredClone(lookedUp);
    f(a); f(b);
    let said = null;
    try { readWork(a); } catch (e) { said = e; }
    assert.ok(said && said.name === 'DataError', `control: the reader at once refuses it (${f})`);
    await assert.rejects(readWorkSlowly(b), (e) => e.message === said.message, said.message);
  }
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

// ---- a large review: written out in pieces, and kept in parts (measured in Chromium by e2e/review_autosave_scale.py) ----
/** A review of `n` places, a candidate each, every one decided, and a lookup with a query for each: large where n is. */
function large(n, { at = '2026-11-01T11:00:00Z' } = {}) {   // another review than fresh(): made at another time
  const names = Array.from({ length: n }, (_, i) => `p${i}`);
  return readWork(JSON.stringify({
    krisis: 3, generated_at: at, algorithm_version: 'krisis-names 7', match_parameters: {},
    subjects: { title: 'Mine', files: [{ name: 'mine.json', size: 10, sha256: hex('a') }] },
    others: { title: 'Theirs', files: [{ name: 'theirs.json', size: 20, sha256: hex('b') }] },
    places: Object.fromEntries(names.map((p) => [A(p), { label: `Place ${p} “quoted” \\ é`, names: [p], point: null }])),
    regions: {}, lookups: [],
    candidates: names.map((p, i) => ({ ...cand(`c${i}`, p, `${p}-there`), candidate_status: 'confirmed', note: 'a note, kept in the review only: '.repeat(4),
      decision: { kind: 'match', decided_at: '2026-11-02T09:00:00Z', identityType: 'exactMatch' } })),
    reviewer: null, cursor: 0,
  }));
}
/** How many rows each store of the database holds. */
async function rows(idb) {
  const db = await new Promise((res, rej) => { const q = idb.open(DB); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  try {
    const count = (name) => new Promise((res, rej) => { const q = db.transaction(name).objectStore(name).count(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    return { version: db.version, reviews: await count(STORE), parts: await count(PARTS) };
  } finally { db.close(); }
}

test('JSON in pieces: joined, the pieces are what JSON.stringify gives, whatever is in it; and of a large value no piece is long', () => {
  const big = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, { n: i, s: 'x'.repeat(40) }]));
  const values = [null, 0, -1.5, 'a "quoted" \\ string é\n', true, [], {}, [1, [2, [3, { a: [] }]]], { a: undefined, b: null, c: [undefined, () => 1, 2], d: { e: undefined } },
    { few: { inner: big }, list: [{ deep: { deeper: big } }] }, Array.from({ length: 700 }, (_, i) => ({ i, t: [i, `${i}`] })), fresh(), decided(), large(300)];
  for (const v of values) assert.equal([...jsonPieces(v)].join(''), JSON.stringify(v), JSON.stringify(v).slice(0, 60));
  // A large review: thousands of pieces, the longest a small share of the whole (one candidate, one place), where the whole at once is one piece.
  const w = large(3000), whole = JSON.stringify(w), pieces = [...jsonPieces(w)];
  assert.ok(whole.length > 1_500_000, `the review is large (${whole.length} characters)`);
  assert.ok(pieces.length > 6000, `in ${pieces.length} pieces`);
  assert.ok(Math.max(...pieces.map((p) => p.length)) < 2000, `the longest piece is ${Math.max(...pieces.map((p) => p.length))} characters`);
  // What is large inside something small is taken apart too: a lookup's queries, one for each place (a list of one lookup, as a work file has it).
  const lookups = { lookups: [{ id: 'l1', queries: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [A(`p${i}`), { state: 'answered', sent: [`p${i}`], found: 1, added: 1 }])) }] };
  const inside = [...jsonPieces(lookups)];
  assert.equal(inside.join(''), JSON.stringify(lookups));
  assert.ok(Math.max(...inside.map((p) => p.length)) < 500 && JSON.stringify(lookups).length > 200_000, 'no piece is the whole lookup');
});

test('a large review written out in pieces: the same review as at once, the page given turns meanwhile; given up when the review changes under it', async () => {
  const w = large(SLOWLY_FROM); w.cursor = 7;
  let turns = 0;
  const slow = await recordSlowly(w, { name: 'large.krisis.json', at: AT, budget: 0, pause: async () => { turns++; } });
  const once = recordOf(w, { name: 'large.krisis.json', at: AT });
  assert.ok(turns > 100, `the page was given ${turns} turns`);
  const but = ({ text, parts, ...rest }) => rest;
  assert.deepEqual(but(slow), but(once), 'the same record but for its text: key, name, time, places reviewed');
  assert.equal(slow.text, undefined);
  assert.ok(slow.parts.length > 1 && slow.parts.every((p) => p.length < PART + 2000), `in ${slow.parts.length} parts of about ${PART} characters`);
  assert.deepEqual(JSON.parse(textOf(slow)), JSON.parse(once.text), 'which joined are the work file');
  assert.ok(textOf(slow).length < once.text.length, 'without the indentation');
  const back = readRecord(slow, once.key);
  assert.ok(sameWork(back.work, w) && back.work.cursor === 7 && back.reviewed === SLOWLY_FROM, 'and it reads back as the review it was made from');
  // With the default pause (a real turn of the page), it is the same.
  assert.deepEqual((await recordSlowly(large(50), { at: AT })).parts.join(''), `${JSON.stringify(large(50))}\n`);
  // The review changes while the page has its turn (a decision undone): nothing is returned, at the first turn after it, not after the whole.
  let after = 0;
  const gone = await recordSlowly(w, { budget: 0, pause: async () => { if (++after === 3) w.candidates[0].decision = null; }, changed: () => w.candidates[0].decision === null });
  assert.equal(gone, null);
  assert.equal(after, 3, 'given up at the turn the review changed in');
  // A cursor that is not one is 0, as in a record made at once.
  assert.equal(readRecord(await recordSlowly(fresh(), { cursor: -3, at: AT })).work.cursor, 0);
});

test('a long record is kept in parts and read back whole; a shorter one after it, a clearing, and the cap leave no part behind', async () => {
  const idb = new IDBFactory(), session = new Storage();
  const store = progressStore({ indexedDB: idb, session, keep: () => true });
  const w = large(SLOWLY_FROM);
  const slow = await recordSlowly(w, { at: AT, budget: 1000 });
  assert.equal(await store.put(slow), 'browser');
  assert.deepEqual(await rows(idb), { version: DB_VERSION, reviews: 1, parts: slow.parts.length });
  const back = await progressStore({ indexedDB: idb, session: new Storage(), keep: () => true }).get(slow.key);
  assert.ok(back && sameWork(back.work, w) && back.reviewed === SLOWLY_FROM && back.at === AT.toISOString(), 'another tab reads it whole');
  assert.equal(session.length, 0);
  // A record made at once whose text is long is kept in parts too (as many as its length asks), and reads back the same; the parts of the one before are gone.
  const once = recordOf(w, { at: new Date(AT.getTime() + 1000) });
  assert.ok(once.text.length > PART);
  await store.put(once);
  assert.deepEqual(await rows(idb), { version: DB_VERSION, reviews: 1, parts: Math.ceil(once.text.length / PART) });
  assert.ok(sameWork((await store.get(once.key)).work, w));
  // All its parts put at once (the page leaving) keeps the same.
  await store.put({ ...slow, at: new Date(AT.getTime() + 2000).toISOString() }, { atOnce: true });
  assert.deepEqual(await rows(idb), { version: DB_VERSION, reviews: 1, parts: slow.parts.length });
  assert.equal((await store.get(slow.key)).at, new Date(AT.getTime() + 2000).toISOString());
  // A part missing (never the store's doing: the record is replaced in one transaction): the record is none, not a review with a hole in it.
  const db = await new Promise((res) => { const q = idb.open(DB); q.onsuccess = () => res(q.result); });
  const kept = await new Promise((res) => { const q = db.transaction(PARTS).objectStore(PARTS).get([slow.key, 1]); q.onsuccess = () => res(q.result); });
  await new Promise((res) => { const t = db.transaction(PARTS, 'readwrite'); t.objectStore(PARTS).delete([slow.key, 1]); t.oncomplete = res; });
  assert.equal(await store.get(slow.key), null);
  await new Promise((res) => { const t = db.transaction(PARTS, 'readwrite'); t.objectStore(PARTS).put(kept, [slow.key, 1]); t.oncomplete = res; });
  db.close();
  assert.equal((await store.get(slow.key)).reviewed, SLOWLY_FROM, 'control: with the part back, it is read');
  // The same review kept short (its text in its own row): no part is left.
  const short = recordOf(decided(undefined, fresh()), { at: AT });
  await store.put({ ...short, key: slow.key });   // a row under the long one's key, as a short record of it would be
  assert.deepEqual(await rows(idb), { version: DB_VERSION, reviews: 1, parts: 0 });
  // Cleared: the long record's row and every part.
  await store.put(slow);
  const other = recordOf(decided(), { at: AT });
  await store.put(other);
  assert.deepEqual(await rows(idb), { version: DB_VERSION, reviews: 2, parts: slow.parts.length });
  await store.forget(slow.key);
  assert.deepEqual(await rows(idb), { version: DB_VERSION, reviews: 1, parts: 0 });
  assert.equal((await store.get(other.key)).reviewed, 2, 'and the other review is as it was');
});

test(`the cap counts reviews, not parts: ${MOST} are kept though one is in many parts, and a long one let go takes its parts with it`, async () => {
  const idb = new IDBFactory();
  const store = progressStore({ indexedDB: idb, session: new Storage(), keep: () => true });
  const long = await recordSlowly(large(SLOWLY_FROM), { at: new Date('2026-11-02T08:00:00Z'), budget: 1000 });
  await store.put(long);
  const records = [];
  for (let i = 0; i < MOST - 1; i++) {
    const r = recordOf(decided(undefined, fresh({ at: `2026-10-${String(i + 1).padStart(2, '0')}T10:00:00Z` })), { at: new Date(Date.parse('2026-11-02T09:00:00Z') + i * 60000) });
    records.push(r); await store.put(r);
  }
  assert.deepEqual(await rows(idb), { version: DB_VERSION, reviews: MOST, parts: long.parts.length }, `${MOST} reviews, the long one's parts not counted among them`);
  assert.equal((await store.get(long.key)).reviewed, SLOWLY_FROM);
  for (const r of records) assert.equal((await store.get(r.key)).reviewed, 2);
  // One more: the one changed longest ago, the long one, is let go, and its parts with it.
  await store.put(recordOf(decided(undefined, fresh({ at: '2026-10-30T10:00:00Z' })), { at: new Date('2026-11-03T09:00:00Z') }));
  assert.deepEqual(await rows(idb), { version: DB_VERSION, reviews: MOST, parts: 0 });
  assert.equal(await store.get(long.key), null);
  assert.equal((await store.get(records[0].key)).reviewed, 2, 'the next oldest is still there');
});

test('a database made before long records were kept in parts (version 1) is taken as it is: what it holds is read, and a long record is then kept in it', async () => {
  const idb = new IDBFactory();
  const record = recordOf(decided(), { at: AT });
  await new Promise((res, rej) => {
    const q = idb.open(DB, 1);
    q.onupgradeneeded = () => q.result.createObjectStore(STORE, { keyPath: 'key' }).createIndex('at', 'at');
    q.onsuccess = () => { const t = q.result.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(record); t.oncomplete = () => { q.result.close(); res(); }; };
    q.onerror = () => rej(q.error);
  });
  const store = progressStore({ indexedDB: idb, session: new Storage(), keep: () => true });
  assert.equal((await store.get(record.key)).reviewed, 2, 'the review kept before is read');
  const long = await recordSlowly(large(SLOWLY_FROM), { at: AT, budget: 1000 });
  assert.equal(await store.put(long), 'browser');
  assert.deepEqual(await rows(idb), { version: DB_VERSION, reviews: 2, parts: long.parts.length });
  assert.equal((await store.get(long.key)).reviewed, SLOWLY_FROM);
});

test('with "keep working data" off, a record longer than any sessionStorage holds is not written out to be refused: it is kept for the page, and said so', async () => {
  const session = new Storage();
  let tried = 0;
  const set = session.setItem.bind(session);
  session.setItem = (k, v) => { tried++; set(k, v); };
  const store = progressStore({ indexedDB: new IDBFactory(), session, keep: () => false });
  const w = fresh(); Object.values(w.places)[0].label = 'x'.repeat(TAB_MOST);
  const long = recordOf(w, { at: AT }), short = recordOf(decided(), { at: AT });
  assert.equal(await store.put(short), 'tab');
  assert.equal(tried, 1, 'control: a record that fits is put in the tab\'s storage');
  assert.equal(await store.put(long), 'page');
  assert.equal(tried, 1, 'the long one was never tried there');
  assert.equal((await store.get(long.key)).work.places[A('bath')].label.length, TAB_MOST, 'and the page holds it');
  // In parts (written out in pieces), a record that fits is kept in the tab as its text, and reads back.
  const parted = await recordSlowly(decided(undefined, fresh({ at: '2026-11-05T10:00:00Z' })), { at: AT });
  assert.equal(await store.put(parted), 'tab');
  assert.equal(typeof JSON.parse(session.getItem(TAB + parted.key)).text, 'string');
  assert.equal((await progressStore({ indexedDB: new IDBFactory(), session, keep: () => false }).get(parted.key)).reviewed, 2);
});

// ---- The offer made as the page opens (19 November 2026): a review begun outside a workflow, kept and never saved ----
test('a record says whether it holds what no file has, and whether it is a workflow\'s; only one that is unsaved and no workflow\'s may be offered', () => {
  const work = decided();
  const plain = recordOf(work, { at: AT });
  assert.equal('unsaved' in plain, false); assert.equal('workflow' in plain, false);
  const unsaved = recordOf(work, { at: AT, unsaved: true }), held = recordOf(work, { at: AT, unsaved: true, workflow: true });
  assert.equal(unsaved.unsaved, true); assert.equal(held.workflow, true);
  assert.equal(offerable(unsaved), true, 'control: unsaved, and no workflow\'s');
  assert.equal(offerable(plain), false, 'saved, or kept before this was recorded');
  assert.equal(offerable(held), false, 'a workflow\'s review');
  for (const bad of [null, 'x', {}, { ...unsaved, krisisProgress: 2 }, { ...unsaved, unsaved: 'yes' }]) assert.equal(offerable(bad), false);
  const back = readRecord(JSON.parse(JSON.stringify(unsaved)), unsaved.key);
  assert.deepEqual([back.unsaved, back.workflow, back.reviewed, back.total], [true, false, 2, 3]);
  assert.deepEqual([readRecord(plain).unsaved, readRecord(held).workflow], [false, true]);
});

test('the review offered as the page opens is the unsaved one changed last; a saved one, a workflow\'s, and one that does not read back are passed over', async () => {
  const idb = new IDBFactory(), session = new Storage();
  const store = progressStore({ indexedDB: idb, session, keep: () => true });
  assert.equal(await store.latestOffer(), null, 'nothing kept, nothing offered');
  const at = (h) => new Date(`2026-11-02T${h}:00:00Z`);
  const a = decided(undefined, fresh({ subject: 'a' })), b = decided(undefined, fresh({ subject: 'c' })), c = decided(undefined, fresh({ subject: 'd' })), d = decided(undefined, fresh({ subject: 'e' }));
  await store.put(recordOf(a, { name: 'a.krisis.json', at: at('09'), unsaved: true }));
  assert.equal((await store.latestOffer()).name, 'a.krisis.json', 'control: the one unsaved review is offered');
  await store.put(recordOf(b, { name: 'b.krisis.json', at: at('10'), unsaved: true }));
  await store.put(recordOf(c, { name: 'saved.krisis.json', at: at('11') }));                                   // saved since: not offered, though later
  await store.put(recordOf(d, { name: 'workflow.krisis.json', at: at('12'), unsaved: true, workflow: true }));   // a workflow's: not offered, though latest
  const offer = await store.latestOffer();
  assert.deepEqual([offer.name, offer.reviewed, offer.total, offer.at], ['b.krisis.json', 2, 3, '2026-11-02T10:00:00.000Z']);
  assert.deepEqual(offer.work, { ...b, cursor: 0 });
  // Saved (kept again as saved), it is no longer offered: the next unsaved one is.
  await store.put(recordOf(b, { name: 'b.krisis.json', at: at('13') }));
  assert.equal((await store.latestOffer()).name, 'a.krisis.json');
  // Discarded, there is none; the saved one and the workflow's are still kept, for their own files.
  await store.forget(reviewKey(a));
  assert.equal(await store.latestOffer(), null);
  assert.ok(await store.get(reviewKey(c))); assert.ok(await store.get(reviewKey(d)));
  // A record another page of the origin wrote wrongly (its text is no work file) is passed over for the next that reads.
  await store.put(recordOf(a, { name: 'a.krisis.json', at: at('14'), unsaved: true }));
  await store.put({ ...recordOf(b, { name: 'bad.krisis.json', at: at('15'), unsaved: true }), text: '{"not":"a review"}' });
  assert.equal((await store.latestOffer()).name, 'a.krisis.json');
});

test('with "keep working data" off nothing is offered, though the tab still holds the review for its own file; where IndexedDB is refused, the tab\'s is offered', async () => {
  const idb = new IDBFactory(), session = new Storage();
  let keep = true;
  const store = progressStore({ indexedDB: idb, session, keep: () => keep });
  const work = decided();
  await store.put(recordOf(work, { at: AT, unsaved: true }));
  assert.ok(await store.latestOffer(), 'control: kept between visits, it is offered');
  keep = false;
  assert.equal(await store.latestOffer(), null, 'not kept between visits: nothing offered');
  assert.deepEqual(await databases(idb), [], 'and what the browser held is let go');
  assert.equal(await store.put(recordOf(work, { at: AT, unsaved: true })), 'tab');
  assert.equal(await store.latestOffer(), null, 'the tab\'s own is not offered either');
  assert.ok(await store.get(reviewKey(work)), 'control: it is there for its own file');
  // IndexedDB refused, working data kept: what the tab holds is what there is to offer.
  const tabOnly = progressStore({ indexedDB: refusing, session: new Storage(), keep: () => true });
  assert.equal(await tabOnly.put(recordOf(work, { name: 'tab.krisis.json', at: AT, unsaved: true })), 'tab');
  assert.equal((await tabOnly.latestOffer()).name, 'tab.krisis.json');
  // Of the tab's and the browser's, the one changed later.
  const both = progressStore({ indexedDB: new IDBFactory(), session: new Storage(), keep: () => true });
  const other = decided(undefined, fresh({ subject: 'c' }));
  await both.put(recordOf(work, { name: 'browser.krisis.json', at: new Date('2026-11-02T10:00:00Z'), unsaved: true }));
  const v = recordOf(other, { name: 'tab.krisis.json', at: new Date('2026-11-02T11:00:00Z'), unsaved: true });
  session.setItem(TAB + v.key, JSON.stringify(v));
  const mixed = progressStore({ indexedDB: idb, session, keep: () => true });
  assert.equal((await mixed.latestOffer()).name, 'tab.krisis.json');
  assert.equal((await both.latestOffer()).name, 'browser.krisis.json');
});

test('the offer\'s words say whose review, when it was left and how far it had gone, and name its three ways on', () => {
  const O = REVIEW_KEPT.offer;
  assert.equal(O.open, 'Open the review kept in this browser');
  assert.match(O.what({ name: 'mine.krisis.json', at: '2026-11-02T09:05:00Z', reviewed: 2, total: 3 }), /^mine\.krisis\.json, as you left it on 2 Nov, \d\d:\d\d: 2 of 3 places reviewed\. No file has these decisions, and they have been sent nowhere\.$/);
  assert.deepEqual([O.later, O.discard], ['Not now', 'Discard it']);
  assert.match(REVIEW_KEPT.reopened({ at: '2026-11-02T09:05:00Z', reviewed: 2 }, 'browser'), /has been put back: 2 places reviewed\. No file has this yet: save the review to have it in one\./);
});

test('a review written out in pieces and kept in parts is offered as one kept whole is, and says the same of itself', async () => {
  const store = progressStore({ indexedDB: new IDBFactory(), session: new Storage(), keep: () => true });
  const work = decided();
  const slow = await recordSlowly(work, { name: 'large.krisis.json', at: AT, unsaved: true });
  assert.ok(Array.isArray(slow.parts) && slow.unsaved === true && !('workflow' in slow));
  assert.equal(offerable(slow), true);
  assert.equal((await recordSlowly(work, { at: AT, unsaved: true, workflow: true })).workflow, true);
  assert.equal('unsaved' in await recordSlowly(work, { at: AT }), false);
  assert.equal(await store.put(slow), 'browser');
  const offer = await store.latestOffer();
  assert.deepEqual([offer.name, offer.reviewed, offer.total, offer.unsaved], ['large.krisis.json', 2, 3, true]);
  assert.deepEqual(offer.work, { ...work, cursor: 0 });
  // Kept again as saved, in parts still: not offered.
  await store.put(await recordSlowly(work, { name: 'large.krisis.json', at: new Date('2026-11-02T10:00:00Z') }));
  assert.equal(await store.latestOffer(), null);
  assert.ok(await store.get(reviewKey(work)), 'control: it is still kept, for its own file');
});
