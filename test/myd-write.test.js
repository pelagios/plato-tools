import { PLATO_REPO } from './paths.js';
// Map your data, "write" (Stephen's ruling of 13 November 2026, D3): the matches a review accepts go
// out in Linked Places Format as links and in the spreadsheet tables as rows of the identities sheet,
// exactMatch where the review recorded one and closeMatch otherwise, one for each identity of a
// bundle, with the candidate's score on the link where the candidate set is given. A denial does not.
// test/fixtures/myd/rich.krisis-dataset.chora.json is the rich review's own dataset, unchanged: ten
// matches, of which LPF had no link and the identities sheet no row. Every test that asserts an
// absence asserts, in the same test, a presence it could have missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import Papa from 'papaparse';
import { detect } from '../src/engine/input.js';
import { file, textFile, outText, go } from './engine.js';

const FX = 'test/fixtures/myd/';
const fx = (name) => file(FX + name);

// ---- D3: accepted matches, written out -----------------------------------------------------------
const RICH = () => fx('rich.krisis-dataset.chora.json');
const loss = (r, kind) => r.report.items.find((i) => i.severity === 'loss' && i.kind === kind);
const sheet = (r, name) => Papa.parse(strFromU8(unzipSync(r.e.outs[Object.keys(r.e.outs)[0]][0])[name]), { header: true, skipEmptyLines: true }).data;
const features = (r) => JSON.parse(outText(r.e, Object.keys(r.e.outs)[0])).features;
const S = { '@id': 'https://example.org/source/s', title: 'S' };
const P = 'https://example.org/place/p', Q = 'https://example.org/place/q', X = 'https://example.org/place/x';
const doc = (...attestations) => ({ profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' },
  spatialEntities: [{ '@id': P, label: 'P', attestations: [{ names: [{ toponym: 'P' }], sources: [S] }, ...attestations] },
    { '@id': Q, label: 'Q', attestations: [{ names: [{ toponym: 'Q' }], sources: [S] }] }] });
const match = (identities, extra = {}) => ({ '@id': 'https://example.org/att/m', identities, sources: [S], ...extra });

test('D3: the review\'s dataset written as Linked Places Format has its 10 matches as links, exactMatch where the review said so', async () => {
  const d = JSON.parse(readFileSync(FX + 'rich.krisis-dataset.chora.json', 'utf8'));
  const accepted = d.spatialEntities.flatMap((e) => e.attestations.flatMap((a) => (a.identities || []).map((i) => [e['@id'], i.identityType, i.object])));
  assert.equal(accepted.length, 10, 'the fixture holds the ten matches of the review');
  const r = await go([RICH()], 'convert', 'lpf');
  assert.equal(r.report.errors, 0);
  const links = features(r).flatMap((f) => (f.links || []).map((l) => [f['@id'], l.type, l.identifier]));
  assert.deepEqual(links, accepted);
  assert.equal(links.filter((l) => l[1] === 'exactMatch').length, 1);
  assert.equal(links.filter((l) => l[1] === 'closeMatch').length, 9);
  // What a link cannot say is reported, once for each attestation; nothing is said to be left out.
  assert.equal(loss(r, 'identity-provenance')?.count, 10);
  assert.equal(loss(r, 'identity-bundle'), undefined);
});

test('D3: the same dataset written as tables has its 10 matches as rows of the identities sheet', async () => {
  const r = await go([RICH()], 'convert', 'tables');
  assert.equal(r.report.errors, 0);
  const rows = sheet(r, 'identities.csv');
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.find((x) => x.place_id === 'p5'), { place_id: 'p5', same_as: 'https://w3id.org/whg/id/place:gn:9000010', match_type: 'exactMatch', certainty: '', basis: '', source_id: 'whgazetteer.org' });
  assert.equal(rows.filter((x) => x.match_type === 'closeMatch').length, 9);
  assert.ok(sheet(r, 'sources.csv').some((s) => s.source_id === 'whgazetteer.org'), 'the source each row cites is in the sources sheet');
  assert.equal(loss(r, 'identity-provenance')?.count, 10);
  assert.equal(loss(r, 'identity-bundle'), undefined);
});

for (const target of ['lpf', 'tables']) {
  const written = (r) => (target === 'lpf' ? features(r).flatMap((f) => (f.links || []).map((l) => [l.type, l.identifier])) : sheet(r, 'identities.csv').map((x) => [x.match_type, x.same_as]));
  test(`D3, ${target}: a denial gives no match and is still reported as one; an accepted match beside it is written`, async () => {
    const denied = await go([textFile(JSON.stringify(doc(match([{ subject: P, object: Q, identityType: 'exactMatch' }], { negated: true }))), 'd.json')], 'convert', target);
    assert.deepEqual(written(denied), []);
    assert.equal(loss(denied, 'identity-denied')?.count, 1);
    assert.equal(loss(denied, 'identity-provenance'), undefined);
    // Control: the same attestation, not denied, is the match; so the search above could have found one.
    const accepted = await go([textFile(JSON.stringify(doc(match([{ subject: P, object: Q, identityType: 'exactMatch' }]))), 'a.json')], 'convert', target);
    assert.deepEqual(written(accepted), [['exactMatch', Q]]);
    assert.equal(loss(accepted, 'identity-denied'), undefined);
    assert.equal(loss(accepted, 'identity-provenance')?.count, 1);
  });
  test(`D3, ${target}: an attestation of two identities gives one match for each`, async () => {
    const r = await go([textFile(JSON.stringify(doc(match([{ subject: P, object: Q, identityType: 'closeMatch' }, { subject: P, object: X, identityType: 'exactMatch' }]))), 'b.json')], 'convert', target);
    assert.deepEqual(written(r), [['closeMatch', Q], ['exactMatch', X]]);
    assert.equal(loss(r, 'identity-provenance')?.count, 1, 'once for the attestation');
    assert.deepEqual(loss(r, 'identity-provenance').examples, ['https://example.org/att/m']);
    assert.equal(loss(r, 'identity-bundle'), undefined);
  });
}

test('D3: a link carries its candidate\'s score when the candidate set is given, and none when it is not', async () => {
  const EX = `${PLATO_REPO}/schemas/examples`, W = 'https://whgazetteer.org/example/';
  const SURREY = `${W}entity/region/england/surrey`, WHG_SURREY = `${W}whg/place/surrey`;
  const dataset = textFile(readFileSync(`${EX}/place-centric-regions.json`, 'utf8'), 'd.json');
  const set = await detect([textFile(readFileSync(`${EX}/candidate-set-regions.json`, 'utf8'), 'set.json')]);
  const surrey = (r) => features(r).find((f) => f['@id'] === SURREY);
  const withSet = await go([dataset], 'convert', 'lpf', { candidates: [set] });
  assert.deepEqual(surrey(withSet).links, [{ type: 'closeMatch', identifier: WHG_SURREY, whg_match_score: 93 }]);
  // Control: without the set the match is still a link, with no score guessed.
  const without = await go([dataset], 'convert', 'lpf');
  assert.deepEqual(surrey(without).links, [{ type: 'closeMatch', identifier: WHG_SURREY }]);
});
