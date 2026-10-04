// The historical maps Chora keeps between visits (src/chora/overlays.js, chora-overlays/ on the origin
// private file system): a change of what is shown (Show ticked, the opacity moved) must survive a
// reload made straight after it, while the record's write is still in flight. A file on the origin
// private file system is written only when its writable closes, so here a fake one whose close can
// be held stands for the milliseconds between the tick and the write, and a reload is a fresh copy
// of the module (its memory gone) over the same disk and the same tab's sessionStorage.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

class Store { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }
const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });

// The disk: { dirName: Map(fileName → text) }. hold: a close() made while it is set never finishes
// (the page went first), and nothing it wrote reaches the disk.
function fakeDisk() {
  const dirs = new Map();
  const disk = { dirs, hold: false, file: (name) => dirs.get('chora-overlays')?.get(name) ?? null };
  const dirHandle = (files) => ({
    async getFileHandle(name, { create } = {}) {
      if (!files.has(name)) { if (!create) throw notFound(); files.set(name, ''); }
      return {
        async getFile() { const t = files.get(name); if (t === undefined) throw notFound(); return { text: async () => t }; },
        async createWritable() {
          let buf = '';
          return { async write(s) { buf += s; }, close() { return disk.hold ? new Promise(() => {}) : (files.set(name, buf), Promise.resolve()); } };
        },
      };
    },
    async removeEntry(name) { if (!files.delete(name)) throw notFound(); },
    async *values() { for (const name of [...files.keys()]) yield await this.getFileHandle(name); },
  });
  const root = {
    async getDirectoryHandle(name, { create } = {}) {
      if (!dirs.has(name)) { if (!create) throw notFound(); dirs.set(name, new Map()); }
      return dirHandle(dirs.get(name));
    },
    async removeEntry(name) { if (!dirs.delete(name)) throw notFound(); },
  };
  return { disk, root };
}

let disk, loads = 0;
beforeEach(() => {
  const f = fakeDisk(); disk = f.disk;
  Object.defineProperty(globalThis.navigator, 'storage', { value: { getDirectory: async () => f.root }, configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: new Store(), configurable: true, writable: true });
});
// A page load: a fresh copy of the module, nothing of the last load's memory.
const load = () => import(`../src/chora/overlays.js?load=${++loads}`);
const RECORD = { key: 'k1', item: { type: 'Annotation', id: 'https://example.org/a' }, manifest: null, manifestUrl: null, fetchedAt: '2026-10-04T00:00:00Z', opacity: 1, visible: false, added: '2026-10-04T00:00:00Z' };
const onDisk = (key) => { const t = disk.file(`${key}.json`); return t === null ? null : JSON.parse(t); };

test('a map ticked Show and the page reloaded at once, before the record is on disk, comes back shown (and at the opacity set)', async () => {
  const first = await load();
  await first.keep(RECORD);
  assert.equal(onDisk('k1').visible, false, 'kept hidden to begin with');
  disk.hold = true;                     // the page goes before this write closes
  first.keepShown('k1', { visible: true, opacity: 0.6 });
  assert.equal(first.writesPending(), 1, 'the write is in flight, and counted');
  const next = await load();            // the reload
  disk.hold = false;
  // The case is real: the write never reached the disk, which still says hidden.
  assert.equal(onDisk('k1').visible, false, 'the write was lost with the page');
  const [k] = await next.kept();
  assert.equal(k?.key, 'k1', 'the map is kept');
  assert.equal(k.visible, true, 'and comes back shown');
  assert.equal(k.opacity, 0.6);
});

test('control: the same reload with only the disk to go by (no note, as before the fix) brings the map back hidden', async () => {
  const first = await load();
  await first.keep(RECORD);
  disk.hold = true;
  first.keepShown('k1', { visible: true, opacity: 0.6 });
  sessionStorage.removeItem('chora-overlays-shown');   // the note taken away: the disk alone
  const next = await load();
  disk.hold = false;
  const [k] = await next.kept();
  assert.equal(k?.key, 'k1', 'the map is kept');
  assert.equal(k.visible, false, 'without the note, the lost write brings it back hidden');
});

test('changes made in quick succession are written in turn, the last one last, and the note goes once the disk holds it', async () => {
  const ov = await load();
  ov.keep(RECORD);
  ov.keepShown('k1', { visible: true, opacity: 1 });
  ov.keepShown('k1', { visible: true, opacity: 0.4 });
  ov.keepShown('k1', { visible: false, opacity: 0.3 });
  assert.ok(sessionStorage.getItem('chora-overlays-shown'), 'noted at once, before any write');
  await ov.keptWritten();
  assert.deepEqual([onDisk('k1').visible, onDisk('k1').opacity], [false, 0.3], 'the last change is what the disk holds');
  assert.deepEqual(onDisk('k1').item, RECORD.item, 'with the rest of the record as kept');
  assert.equal(ov.writesPending(), 0);
  assert.equal(sessionStorage.getItem('chora-overlays-shown'), null, 'the note let go');
});

test('a map let go while a change of it is still being written is not written back', async () => {
  const ov = await load();
  await ov.keep(RECORD);
  assert.ok(onDisk('k1'), 'kept, to begin with');
  ov.keepShown('k1', { visible: true, opacity: 1 });
  ov.letGo('k1');
  ov.keepShown('k1', { visible: false, opacity: 1 });   // too late: nothing to write
  await ov.keptWritten();
  assert.equal(onDisk('k1'), null, 'gone from the disk');
  assert.deepEqual(await ov.kept(), []);
  assert.equal(sessionStorage.getItem('chora-overlays-shown'), null);
});

test('a note left by a reload is written to the record when the map is shown again, and then let go', async () => {
  const first = await load();
  await first.keep(RECORD);
  disk.hold = true; first.keepShown('k1', { visible: true, opacity: 0.6 });
  const next = await load(); disk.hold = false;
  const [k] = await next.kept();
  await next.keep(k);                   // as app.js's showMap does for a map kept
  assert.deepEqual([onDisk('k1').visible, onDisk('k1').opacity], [true, 0.6]);
  assert.equal(sessionStorage.getItem('chora-overlays-shown'), null);
});

test('forgetKept lets every map kept go, and the notes with them', async () => {
  const ov = await load();
  await ov.keep(RECORD);
  disk.hold = true; ov.keepShown('k1', { visible: true, opacity: 1 });
  const next = await load(); disk.hold = false;
  assert.ok(sessionStorage.getItem('chora-overlays-shown') && onDisk('k1'), 'a map kept and a note, to begin with');
  await next.forgetKept();
  assert.equal(disk.dirs.has('chora-overlays'), false);
  assert.equal(sessionStorage.getItem('chora-overlays-shown'), null);
  assert.deepEqual(await next.kept(), []);
});
