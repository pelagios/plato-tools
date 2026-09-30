// Identity relations mixed in among the places of a JSON Lines file (DEEP's are) are written after
// the places when the output is one PLATO JSON document: every place stays a place. Before, every
// place after the first identity relation was written inside identityRelations, with a warning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { textFile, go, outText } from './engine.js';

const X = 'https://example.org/';
const place = (id) => ({ '@id': `${X}place/${id}`, label: id, attestations: [{ sources: [{ '@id': X + 'source/s', title: 'S' }], names: [{ toponym: id }] }] });
const idr = (a, b) => ({ subject: `${X}place/${a}`, object: `${X}place/${b}`, identityType: 'closeMatch' });
const lines = (n) => {
  const out = [{ profile: 'place-centric', gazetteer: { title: 't' } }];
  for (let i = 0; i < n; i++) { out.push(place('p' + i)); if (i % 2) out.push(idr('p' + i, 'p' + (i - 1))); }
  return out.map((o) => JSON.stringify(o)).join('\n') + '\n';
};

for (const [what, options] of [['held in memory', {}], ['held in the working database', { heldIdentities: 2 }]]) {
  test(`mixed places and identity relations: every place stays a place (${what})`, async () => {
    const r = await go([textFile(lines(10), 'mixed.jsonl')], 'convert', 'plato-json', options);
    const doc = JSON.parse(outText(r.e, Object.keys(r.e.outs)[0]));
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
