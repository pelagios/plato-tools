// PLATO 5e7901c: a supersession or retraction takes effect only while it holds itself, so
// retracting a retraction restores its target, and a chain resolves the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectWithdrawn, resolveWithdrawn } from '../src/formats/shared.js';
import { textFile, go, outText } from './engine.js';

const P = 'https://w3id.org/plato#', W = 'https://example.org/a/';
const retract = (id, target) => ({ '@id': W + id, meta: { targetAttestation: W + target, metaType: P + 'Retracts' }, sources: [{ title: 's' }] });
const status = (atts) => Object.fromEntries([...resolveWithdrawn(collectWithdrawn(atts)).status].map(([k, v]) => [k.slice(W.length), v]));

test('a retraction withdraws its target', () => {
  assert.deepEqual(status([retract('r1', 'a')]), { a: 'retracted' });
});
test('retracting the retraction restores the target', () => {
  assert.deepEqual(status([retract('r1', 'a'), retract('r2', 'r1')]), { r1: 'retracted' });
});
test('a third retraction withdraws the second, so the first holds again and the target is withdrawn', () => {
  assert.deepEqual(status([retract('r1', 'a'), retract('r2', 'r1'), retract('r3', 'r2')]), { a: 'retracted', r2: 'retracted' });
});
test('order in the file does not matter', () => {
  assert.deepEqual(status([retract('r3', 'r2'), retract('r2', 'r1'), retract('r1', 'a')]), { a: 'retracted', r2: 'retracted' });
});
test('a loop of withdrawals is reported, and nothing in it is shown as current', () => {
  const r = resolveWithdrawn(collectWithdrawn([retract('x', 'y'), retract('y', 'x')]));
  assert.deepEqual(r.cycles.sort(), [W + 'x', W + 'y']);
  assert.ok(r.status.has(W + 'x') && r.status.has(W + 'y'), 'both members of the loop are withdrawn');
  // And a target of the loop is withdrawn too, since what withdraws it is never shown as holding.
  const r2 = resolveWithdrawn(collectWithdrawn([retract('x', 'y'), retract('y', 'x'), retract('x2', 'a')]));
  assert.equal(r2.status.get(W + 'a'), 'retracted');
});
test('a supersession that is itself retracted no longer replaces its target', () => {
  const sup = { '@id': W + 's1', meta: { targetAttestation: W + 'a', metaType: P + 'Supersedes' }, sources: [{ title: 's' }] };
  assert.deepEqual(status([sup]), { a: 'superseded' });
  assert.deepEqual(status([sup, retract('r1', 's1')]), { s1: 'retracted' });
});

// End to end: the restored attestation reaches LPF, through the JSON path and through RDF.
const doc = (withUnretract) => ({ profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't', status: 'published' },
  spatialEntities: [{ '@id': 'https://example.org/p/1', label: 'P', attestations: [
    { '@id': W + 'a', geometries: [{ geojson: { type: 'Point', coordinates: [1.5, 52.25] } }], sources: [{ title: 's' }] },
    retract('r1', 'a'),
    ...(withUnretract ? [retract('r2', 'r1')] : []),
  ] }] });
const pointIn = (lpf) => lpf.includes('52.25');
for (const via of ['json', 'rdf']) {
  test(`un-retracted attestation is written to LPF again (via ${via}); retracted, it is not`, async () => {
    for (const [un, want] of [[true, true], [false, false]]) {
      let file = textFile(JSON.stringify(doc(un)), 'w.json');
      if (via === 'rdf') {
        const nt = await go([file], 'convert', 'ntriples');
        file = textFile(outText(nt.e, Object.keys(nt.e.outs)[0]), 'w.nt');
      }
      const r = await go([file], 'convert', 'lpf-seq');
      const out = outText(r.e, Object.keys(r.e.outs)[0]);
      assert.equal(pointIn(out), want, `${via}, un-retracted ${un}: ${out.slice(0, 200)}`);
      assert.equal(r.report.items.some((i) => i.kind === 'retracted'), true, 'the withdrawn retraction or its target is reported');
    }
  });
}
