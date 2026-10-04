// A test hook for Methodos's saving and resuming (phase 2), for e2e/app_test.py only. It is not part
// of the site: the harness bundles it from src/ with Vite when it runs (e2e/methodos-hook.mjs) and serves it to
// the page through Playwright's routing, so that no visitor can load it. The page has no Methodos panel
// yet (phase 3); until it has, the browser checks drive the store and the record through this, in the
// page's own origin, with its own IndexedDB, sessionStorage and "keep working data" choice. On a page
// that is not the tools' (the harness's --prove-it-fails), it does nothing.
import { RECIPES } from '../src/engine/methodos/recipes/index.js';
import * as runner from '../src/engine/methodos/runner.js';
import { refsOf } from '../src/engine/methodos/handoffs.js';
import { reconcile, checkChosen } from '../src/engine/methodos/record.js';
import { workflowStore, DB, STORE } from '../src/methodos/store.js';
import { give, refOf, KEY as HANDBACK } from '../src/chora/handback.js';
import { tx as choraTx } from '../src/chora/handoff.js';

if (window.__plato) {
  const store = workflowStore();
  const PUBLISH = RECIPES['publish-a-dataset'];
  const ref = (type, name) => ({ type, name, size: 1, sha256: 'b'.repeat(64) });
  const summary = (s) => ({ status: s.status, at: (s.steps.find((x) => x.state !== 'done' && x.state !== 'skipped') || {}).id || null, states: s.steps.map((x) => x.state) });
  const keys = () => new Promise((resolve) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => { const db = req.result, g = db.transaction(STORE).objectStore(STORE).getAllKeys(); g.onsuccess = () => { db.close(); resolve(g.result); }; g.onerror = () => { db.close(); resolve(['error: ' + g.error]); }; };
    req.onerror = () => resolve(['error: ' + req.error]);
  });
  window.__methodos_e2e = {
    // Begin Publish a dataset with a file of `text`, and take it to the FAIR report, which stops on a
    // problem in the data; saved at each step boundary, as the page will.
    async begin(text, name) {
      const files = await refsOf([new File([text], 'p.json')], 'files');
      let { record: s } = await store.save(runner.start(PUBLISH, {}, { files }), { name });
      s = runner.complete(runner.next(s), 'check', {}); await store.save(s);
      s = runner.complete(runner.next(s), 'mint', { dataset: [ref('dataset', 'p.minted.json')] }); await store.save(s);
      s = runner.stop(runner.next(s), 'report', { words: 'Give the dataset a licence.' });
      const { kept } = await store.save(s);
      return { id: s.id, kept, ...summary(s) };
    },
    async resume(id) {
      const rec = await store.load(id);
      if (!rec) return { action: 'none' };
      const r = reconcile(rec, RECIPES[rec.recipe.key]);
      return { action: r.action, words: r.words, ...(r.state ? summary(r.state) : {}) };
    },
    async chosen(id, text) {
      const rec = await store.load(id);
      if (!rec) return 'no record';
      try { await checkChosen(rec, { files: [new File([text], 'p.json')] }); return 'ok'; } catch (e) { return e.message; }
    },
    list: async () => (await store.list()).map((r) => r.id),
    // Map your data, taken to its step "place" (drawing in Chora), and kept: its id.
    async placeAt(name) {
      const MAP = RECIPES['map-your-data'];
      const files = await refsOf([new File(['name,lat,lon\nAbingdon,51.67,-1.28\n'], 'places.csv')], 'files');
      let s = runner.start(MAP, { 'has-regions': false, 'will-draw': true, 'will-publish': false, target: 'lpf' }, { files });
      for (const [id, out] of [['columns', { mapping: [ref('mapping', 'columns.json')] }], ['check', {}], ['dataset', { dataset: [ref('dataset', 'places.json')] }],
        ['lookup', { work: [ref('work.krisis', 'places.krisis.json')] }], ['review', { work: [ref('work.krisis', 'places.krisis.json')] }], ['apply', { dataset: [ref('dataset', 'applied.json')] }]])
        s = runner.complete(runner.next(s), id, out);
      const { record } = await store.save({ ...s, id: `e2e-${Date.now().toString(36)}` }, { name });
      return record.id;
    },
    // Chora's hand-back of a file of `text` called `name`, for workflow `id`, as Chora gives it on saving.
    giveBack: async (id, text, name) => !!(await give(id, await refOf(new File([text], name)))),
    // Whether a hand-back is kept (it is taken, and so let go, only on the user's click).
    handbackKept: async () => { try { return (await choraTx('readonly', (st) => st.get(HANDBACK))) !== undefined; } catch (e) { return 'error: ' + e.message; } },
    keys,
  };
}
