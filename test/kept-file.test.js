// The file chosen on the main page, kept for as long as the user wants it (src/lib/kept-file.js;
// Stephen, 12 October 2026): kept whole in OPFS, the latest choice replacing the last, read back only
// as checked, never kept where the browser says it has not room, forgotten on asking, and said in one
// line ("parishes.csv (313 bytes), chosen 12 Oct").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keptFileStore, aboutOf, keptLine, onChange, DIR, ABOUT } from '../src/lib/kept-file.js';
import { fakeOpfs } from './opfs-fake.js';

const ROOMY = async () => ({ quota: 1e9, usage: 0 });
const at = new Date('2026-10-12T09:30:00Z');

test('kept whole, found again by a later page under its own name, and said in one line', async () => {
  const disk = fakeOpfs();
  const f = new File(['name,lat,lon\nAbingdon,51.67,-1.28\n'], 'parishes.csv', { type: 'text/csv' });
  const page1 = keptFileStore({ root: disk.root, estimate: ROOMY });
  assert.equal(await page1.keep([f], at), 'kept');
  const page2 = keptFileStore({ root: disk.root, estimate: ROOMY });
  const about = await page2.about();
  assert.deepEqual(about, { chosen: at.toISOString(), files: [{ name: 'parishes.csv', size: f.size, type: 'text/csv' }] });
  assert.equal(keptLine(about), `parishes.csv (${f.size} bytes), chosen 12 Oct`);
  const [again] = await page2.files();
  assert.equal(again.name, 'parishes.csv');
  assert.equal(await again.text(), await f.text());
  // Chosen again ("Use it"): the same files, nothing kept anew.
  assert.equal(await page2.keep([again]), 'same');
  assert.equal(page2.isKept(again), true);
  assert.equal(page2.isKept(f), false);
});

test('a new choice replaces the old: only the latest is kept, several files together', async () => {
  const disk = fakeOpfs(), s = keptFileStore({ root: disk.root, estimate: ROOMY });
  await s.keep([new File(['old'], 'old.csv')], at);
  await s.keep([new File(['a'], 'a.csv'), new File(['bb'], 'b.csv')], at);
  assert.deepEqual((await s.about()).files.map((f) => f.name), ['a.csv', 'b.csv']);
  assert.deepEqual([...disk.dirs.get(DIR).keys()].sort(), ['0', '1', ABOUT].sort(), 'nothing of the old one is left');
  assert.deepEqual(await Promise.all((await s.files()).map((f) => f.text())), ['a', 'bb']);
});

test('forgotten on asking: nothing left, a later page finds nothing, and listeners are told', async () => {
  const disk = fakeOpfs(), s = keptFileStore({ root: disk.root, estimate: ROOMY });
  let told = 0; const stop = onChange(() => told++);
  await s.keep([new File(['x'], 'x.csv')], at);
  assert.ok(disk.dirs.has(DIR), 'the presence: kept');
  await s.forget();
  stop();
  assert.equal(disk.dirs.has(DIR), false);
  assert.equal(await keptFileStore({ root: disk.root }).about(), null);
  assert.equal(await keptFileStore({ root: disk.root }).files(), null);
  assert.equal(told, 2, 'kept, then forgotten');
});

test('not kept where the browser says it has not room (with a margin), nor when a write fails: and the old choice is no longer kept either', async () => {
  const disk = fakeOpfs();
  const big = new File(['a'.repeat(5000)], 'big.csv');
  await keptFileStore({ root: disk.root, estimate: ROOMY }).keep([new File(['old'], 'old.csv')], at);
  const short = keptFileStore({ root: disk.root, estimate: async () => ({ quota: 2_000_000, usage: 1_500_000 }) });
  assert.equal(await short.keep([big], at), 'short');
  assert.equal(disk.dirs.has(DIR), false, 'nothing written, and the old choice gone: it is not the latest');
  // The control: with room, it is kept.
  assert.equal(await keptFileStore({ root: disk.root, estimate: ROOMY }).keep([big], at), 'kept');
  // A write refused is 'failed', and leaves nothing.
  const broken = fakeOpfs(); const real = await broken.root();
  const root = async () => ({ ...real, getDirectoryHandle: async (n, o) => { const d = await real.getDirectoryHandle(n, o); return { ...d, getFileHandle: async (x, y) => ({ ...(await d.getFileHandle(x, y)), createWritable: async () => { throw new Error('QuotaExceededError'); } }) }; } });
  assert.equal(await keptFileStore({ root, estimate: ROOMY }).keep([big], at), 'failed');
  assert.equal(broken.dirs.has(DIR), false);
});

test('what is read back is checked: a damaged or planted record is not offered, and goes', async () => {
  assert.equal(aboutOf({ kept: 1, chosen: at.toISOString(), files: [{ name: 'a.csv', size: 3 }] })?.files[0].name, 'a.csv');
  for (const bad of [null, [], { kept: 2, chosen: at.toISOString(), files: [{ name: 'a', size: 1 }] }, { kept: 1, chosen: 'yesterday', files: [{ name: 'a', size: 1 }] },
    { kept: 1, chosen: at.toISOString(), files: [] }, { kept: 1, chosen: at.toISOString(), files: [{ name: '../a', size: 1 }] },
    { kept: 1, chosen: at.toISOString(), files: [{ name: 'a‮b', size: 1 }] }, { kept: 1, chosen: at.toISOString(), files: [{ name: 'a', size: -1 }] }])
    assert.equal(aboutOf(bad), null, JSON.stringify(bad));
  // A record whose file is not the size it says: not offered, and let go.
  const disk = fakeOpfs(), s = keptFileStore({ root: disk.root, estimate: ROOMY });
  await s.keep([new File(['abc'], 'a.csv')], at);
  const d = await (await disk.root()).getDirectoryHandle(DIR);
  await new Blob(['abcdef']).stream().pipeTo(await (await d.getFileHandle('0')).createWritable());
  assert.equal(await s.about(), null);
  assert.equal(disk.dirs.has(DIR), false);
});
