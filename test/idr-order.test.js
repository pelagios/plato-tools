// Identity relations mixed in among the places of a JSON Lines file (DEEP's are) are written after
// the places when the output is one PLATO JSON document: every place stays a place. Before, every
// place after the first identity relation was written inside identityRelations, with a warning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { textFile, go, outText, env as testEnv } from './engine.js';
import { run } from '../src/engine/pipeline.js';
import { detect } from '../src/engine/input.js';

const X = 'https://example.org/';
const place = (id) => ({ '@id': `${X}place/${id}`, label: id, attestations: [{ sources: [{ '@id': X + 'source/s', title: 'S' }], names: [{ toponym: id }] }] });
const idr = (a, b) => ({ subject: `${X}place/${a}`, object: `${X}place/${b}`, identityType: 'closeMatch' });
const lines = (n) => {
  const out = [{ profile: 'place-centric', gazetteer: { title: 't' } }];
  for (let i = 0; i < n; i++) { out.push(place('p' + i)); if (i % 2) out.push(idr('p' + i, 'p' + (i - 1))); }
  return out.map((o) => JSON.stringify(o)).join('\n') + '\n';
};

// The ten lines converted with env.openDb wrapped by openDb(base, ...args), base being the test's own.
async function goWith(openDb, options) {
  const e = testEnv();
  const base = e.openDb;
  e.openDb = (...a) => openDb(base, ...a);
  const r = await run({ input: await detect([textFile(lines(10), 'mixed.jsonl')]), action: 'convert', target: 'plato-json', options }, e);
  return { r, doc: JSON.parse(outText(e, Object.keys(e.outs)[0])) };
}

// Each case proves which way it went: the database case opened one (else it tests memory twice), and
// the memory case, its control, did not.
for (const [what, options, opened] of [['held in memory', {}, 0], ['held in the working database', { heldIdentities: 2 }, 1]]) {
  test(`mixed places and identity relations: every place stays a place (${what})`, async () => {
    let calls = 0;
    const { r, doc } = await goWith((base, ...a) => { calls++; return base(...a); }, options);
    assert.equal(calls, opened, `env.openDb was called ${calls} times`);
    assert.equal(doc.spatialEntities.length, 10);
    assert.equal(doc.identityRelations.length, 5);
    assert.ok(doc.identityRelations.every((x) => x.subject && !x.attestations));   // no place among them
    assert.deepEqual(doc.identityRelations.map((x) => x.subject), [1, 3, 5, 7, 9].map((i) => `${X}place/p${i}`));   // in their order
    assert.ok(!r.report.items.some((i) => i.kind === 'order'));
    // And the document checks clean, with the same counts as the lines it came from.
    const back = await go([textFile(JSON.stringify(doc), 'back.json')], 'check');
    assert.equal(back.report.errors, 0);
    assert.equal(back.report.counts.places, 10);
    assert.equal(back.report.counts['identity relations'], 5);
  });
}

test('with no identity relations the document has no identityRelations key', async () => {
  const text = [{ profile: 'place-centric', gazetteer: { title: 't' } }, place('a')].map((o) => JSON.stringify(o)).join('\n');
  const r = await go([textFile(text, 'plain.jsonl')], 'convert', 'plato-json');
  const doc = JSON.parse(outText(r.e, Object.keys(r.e.outs)[0]));
  assert.equal(doc.spatialEntities.length, 1);
  assert.equal(doc.identityRelations, undefined);
});

// ---- when the working database cannot be had --------------------------------------------------------
// Held in memory up to options.heldIdentities, then in a database from env.openDb(). Where that fails
// (it cannot be opened, given its table, or written to), the run is not broken by a TypeError at
// close(), and every identity relation not in the output is reported, by count.
const lostItem = (r) => r.report.items.find((i) => i.kind === 'identity-relations-lost');
const failing = {
  'it cannot be opened': async () => { throw new Error('no room'); },
  'its insert cannot be prepared': async (base) => { const db = await base(); const p = db.prepare.bind(db); db.prepare = (sql) => (/INSERT/.test(sql) ? (() => { throw new Error('no insert'); })() : p(sql)); return db; },
};
for (const [what, openDb] of Object.entries(failing)) {
  test(`identity relations that cannot be held in the database are reported lost, by count (${what})`, async () => {
    const { r, doc } = await goWith(openDb, { heldIdentities: 2 });
    assert.equal(doc.spatialEntities.length, 10);
    assert.equal(doc.identityRelations.length, 2, 'the two held in memory are still written');
    const item = lostItem(r);
    assert.ok(item, JSON.stringify(r.report.items));
    assert.equal(item.severity, 'error');
    assert.match(item.message, /3 of the 5 identity relations are not in the output/);
    assert.ok(!r.report.items.some((i) => /TypeError|Cannot read/.test(JSON.stringify(i))), JSON.stringify(r.report.items));
  });
}
test('identity relations written to the database and then lost there are all counted', async () => {
  // The database opens and takes the first three, then refuses: none of the five is in the output.
  let n = 0;
  const { r, doc } = await goWith(async (base) => {
    const db = await base(); const p = db.prepare.bind(db);
    db.prepare = (sql) => { const st = p(sql); if (/INSERT/.test(sql)) { const s = st.stepReset.bind(st); st.stepReset = () => { if (++n > 3) throw new Error('disk full'); return s(); }; } return st; };
    return db;
  }, { heldIdentities: 2 });
  assert.equal(doc.spatialEntities.length, 10);
  assert.equal(doc.identityRelations.length, 0);
  assert.match(lostItem(r).message, /5 of the 5 /);
  assert.deepEqual(lostItem(r).examples, ['disk full']);
});
test('control: with a working database nothing is reported lost', async () => {
  const { r, doc } = await goWith((base) => base(), { heldIdentities: 2 });
  assert.equal(doc.identityRelations.length, 5);
  assert.equal(lostItem(r), undefined);
  assert.equal(r.report.errors, 0);
});
