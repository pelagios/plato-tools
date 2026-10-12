// The file chosen on the main page, kept for as long as the user wants it (src/lib/kept-file.js;
// Stephen, 12 October 2026): kept whole in OPFS, each choice in a folder of its own that replaces the
// last only once it is whole, read back only as checked, never kept where the browser says it has not
// room or once the setting is off, forgotten on asking (never overtaken by a keep in flight), and said
// in one line ("parishes.csv (313 bytes), chosen 12 Oct").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keptFileStore, aboutOf, keptLine, sameAbout, onChange, PREFIX, ABOUT } from '../src/lib/kept-file.js';
import { fakeOpfs } from './opfs-fake.js';

const ROOMY = async () => ({ quota: 1e9, usage: 0 });
const at = new Date('2026-10-12T09:30:00Z');
const folders = (disk) => [...disk.dirs.keys()].filter((n) => n.startsWith(PREFIX));

test('kept whole, found again by a later page under its own name, and said in one line', async () => {
  const disk = fakeOpfs();
  const f = new File(['name,lat,lon\nAbingdon,51.67,-1.28\n'], 'parishes.csv', { type: 'text/csv' });
  const page1 = keptFileStore({ root: disk.root, estimate: ROOMY });
  assert.equal(await page1.keep([f], at), 'kept');
  const page2 = keptFileStore({ root: disk.root, estimate: ROOMY });
  const about = await page2.about();
  assert.deepEqual(about, { chosen: at.toISOString(), files: [{ name: 'parishes.csv', size: f.size, type: 'text/csv' }] });
  assert.equal(keptLine(about), `parishes.csv (${f.size} bytes), chosen 12 Oct`);
  const list = await page2.files();
  assert.equal(list[0].name, 'parishes.csv');
  assert.equal(await list[0].text(), await f.text());
  assert.ok(sameAbout(list.about, about));
  // Chosen again ("Use it"): the same files, nothing kept anew.
  assert.equal(await page2.keep([list[0]]), 'same');
  assert.equal(page2.isKept(list[0]), true);
  assert.equal(page2.isKept(f), false);
});

test('a new choice replaces the old once it is whole: only the latest is kept, several files together', async () => {
  const disk = fakeOpfs(), s = keptFileStore({ root: disk.root, estimate: ROOMY });
  await s.keep([new File(['old'], 'old.csv')], at);
  await s.keep([new File(['a'], 'a.csv'), new File(['bb'], 'b.csv')], new Date(at.getTime() + 1000));
  assert.deepEqual((await s.about()).files.map((f) => f.name), ['a.csv', 'b.csv']);
  assert.equal(folders(disk).length, 1, 'nothing of the old one is left');
  assert.deepEqual([...disk.dirs.get(folders(disk)[0]).keys()].sort(), ['0', '1', ABOUT].sort());
  assert.deepEqual(await Promise.all((await s.files()).map((f) => f.text())), ['a', 'bb']);
});

// A stream that gives its bytes only when `release()` is called: a write held in flight.
function slowFile(text, name) {
  let release; const gate = new Promise((r) => { release = r; });
  const f = new File([text], name);
  const g = { name, size: f.size, type: '', stream: () => new ReadableStream({ async pull(ctl) { await gate; ctl.enqueue(new TextEncoder().encode(text)); ctl.close(); } }) };
  return { file: g, release };
}

test('while a new choice is written the last stays kept; a page reading meanwhile finds the last, whole', async () => {
  const disk = fakeOpfs(), s = keptFileStore({ root: disk.root, estimate: ROOMY });
  await s.keep([new File(['old'], 'old.csv')], at);
  const slow = slowFile('new', 'new.csv');
  const writing = s.keep([slow.file], new Date(at.getTime() + 1000));
  await new Promise((r) => setTimeout(r, 20));
  // As the way to Chora taken now finds it: the old choice, whole (the new folder is not yet one).
  const meanwhile = await keptFileStore({ root: disk.root }).about();
  assert.deepEqual(meanwhile?.files.map((f) => f.name), ['old.csv']);
  slow.release();
  assert.equal(await writing, 'kept');
  assert.deepEqual((await s.about()).files.map((f) => f.name), ['new.csv']);
  assert.equal(folders(disk).length, 1);
});

test('the setting turned off while a choice is written: nothing is kept, and the result is not "kept"', async () => {
  const disk = fakeOpfs();
  let on = true;
  const s = keptFileStore({ root: disk.root, estimate: ROOMY, keep: () => on });
  await s.keep([new File(['old'], 'old.csv')], at);
  const slow = slowFile('new', 'new.csv');
  const writing = s.keep([slow.file], new Date(at.getTime() + 1000));
  await new Promise((r) => setTimeout(r, 20));
  on = false;                            // turned off mid-write
  slow.release();
  assert.equal(await writing, 'off');
  assert.deepEqual(folders(disk), [], 'neither the new choice nor the old is kept');
  assert.equal(await s.about(), null);
  // The control: left on, the same write is kept.
  on = true;
  const slow2 = slowFile('new', 'new.csv');
  const w2 = s.keep([slow2.file], at); slow2.release();
  assert.equal(await w2, 'kept');
});

test('"Forget it" waits for a keep in flight, and is never overtaken by it: nothing is left', async () => {
  const disk = fakeOpfs(), s = keptFileStore({ root: disk.root, estimate: ROOMY });
  const slow = slowFile('x', 'x.csv');
  const writing = s.keep([slow.file], at);
  await new Promise((r) => setTimeout(r, 20));
  const forgetting = keptFileStore({ root: disk.root }).forget();   // another store in the page (the panel's)
  slow.release();
  assert.equal(await writing, 'kept');
  await forgetting;
  assert.deepEqual(folders(disk), []);
});

test('forgotten on asking: nothing left, a later page finds nothing, and listeners are told', async () => {
  const disk = fakeOpfs(), s = keptFileStore({ root: disk.root, estimate: ROOMY });
  let told = 0; const stop = onChange(() => told++);
  await s.keep([new File(['x'], 'x.csv')], at);
  assert.equal(folders(disk).length, 1, 'the presence: kept');
  await s.forget();
  stop();
  assert.deepEqual(folders(disk), []);
  assert.equal(await keptFileStore({ root: disk.root }).about(), null);
  assert.equal(await keptFileStore({ root: disk.root }).files(), null);
  assert.ok(told >= 2, 'kept, then forgotten');
});

test('not kept where the browser says it has not room (with a margin), nor when a write fails: and the old choice is no longer kept either', async () => {
  const disk = fakeOpfs();
  const big = new File(['a'.repeat(5000)], 'big.csv');
  await keptFileStore({ root: disk.root, estimate: ROOMY }).keep([new File(['old'], 'old.csv')], at);
  const short = keptFileStore({ root: disk.root, estimate: async () => ({ quota: 2_000_000, usage: 1_500_000 }) });
  assert.equal(await short.keep([big], at), 'short');
  assert.deepEqual(folders(disk), [], 'nothing written, and the old choice gone: it is not the latest');
  assert.equal(await keptFileStore({ root: disk.root, estimate: ROOMY }).keep([big], at), 'kept', 'the control: with room, it is kept');
  const broken = fakeOpfs(); const real = await broken.root();
  const root = async () => ({ ...real, entries: real.entries.bind(real), getDirectoryHandle: async (n, o) => { const d = await real.getDirectoryHandle(n, o); return { ...d, getFileHandle: async (x, y) => ({ ...(await d.getFileHandle(x, y)), createWritable: async () => { throw new Error('QuotaExceededError'); } }) }; } });
  assert.equal(await keptFileStore({ root, estimate: ROOMY }).keep([big], at), 'failed');
  assert.deepEqual(folders(broken), []);
});

test('what is read back is checked: names, sizes and media types; a damaged, planted or unfinished copy is not offered, and goes', async () => {
  const ok = (files) => ({ kept: 1, chosen: at.toISOString(), files });
  assert.equal(aboutOf(ok([{ name: 'a.csv', size: 3, type: 'text/csv' }]))?.files[0].type, 'text/csv');
  assert.equal(aboutOf(ok([{ name: 'a.csv', size: 3, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }]))?.files.length, 1);
  for (const bad of [null, [], { ...ok([{ name: 'a', size: 1 }]), kept: 2 }, { ...ok([{ name: 'a', size: 1 }]), chosen: 'yesterday' }, ok([]),
    ok([{ name: '../a', size: 1 }]), ok([{ name: 'a‮b', size: 1 }]), ok([{ name: 'a', size: -1 }]),
    ok([{ name: 'a', size: 1, type: 'text/html; charset=x"<script>' }]), ok([{ name: 'a', size: 1, type: 'x'.repeat(60) + '/' + 'y'.repeat(60) }]), ok([{ name: 'a', size: 1, type: 'notatype' }])])
    assert.equal(aboutOf(bad), null, JSON.stringify(bad));
  // A record whose file is not the size it says: not offered, and let go.
  const disk = fakeOpfs(), s = keptFileStore({ root: disk.root, estimate: ROOMY });
  await s.keep([new File(['abc'], 'a.csv')], at);
  const d = await (await disk.root()).getDirectoryHandle(folders(disk)[0]);
  await new Blob(['abcdef']).stream().pipeTo(await (await d.getFileHandle('0')).createWritable());
  assert.equal(await s.about(), null);
  assert.deepEqual(folders(disk), []);
  // A folder never finished (no about.json), from long ago: swept on reading; a whole one beside it is kept.
  await s.keep([new File(['z'], 'z.csv')], at);
  await (await disk.root()).getDirectoryHandle(`${PREFIX}00000001-0001`, { create: true });
  assert.deepEqual((await s.about()).files.map((f) => f.name), ['z.csv']);
  assert.equal(folders(disk).length, 1);
});

test('two tabs: an offer of one choice is not the account of another', () => {
  const a = { chosen: at.toISOString(), files: [{ name: 'a.csv', size: 1, type: '' }] };
  assert.ok(sameAbout(a, { ...a }));
  assert.ok(!sameAbout(a, { ...a, chosen: new Date(at.getTime() + 1).toISOString() }));
  assert.ok(!sameAbout(a, { ...a, files: [{ name: 'b.csv', size: 1, type: '' }] }));
  assert.ok(!sameAbout(a, null));
});
