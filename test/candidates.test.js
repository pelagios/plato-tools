import { PLATO_REPO } from './paths.js';
// A candidate set (PLATO 53c5a40): the matches software suggested for a dataset's places, published
// apart from the dataset. The tools recognise one as a PLATO document, check it against its own
// profile, and convert it to PLATO JSON, JSON Lines and RDF and back; the tables and Linked Places
// Format refuse it (test/keys.test.js), and a graph holding a dataset and a candidate set is written as
// the dataset, with the candidate set reported as not written, never merged into it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { go, file, textFile, outText, env } from './engine.js';
import { detect } from '../src/engine/input.js';
import { run } from '../src/engine/pipeline.js';

const EX = `${PLATO_REPO}/schemas/examples`;
const SET = `${EX}/candidate-set-judgements.json`;
const doc = () => JSON.parse(readFileSync(SET, 'utf8'));
const kinds = (r, sev) => r.report.items.filter((i) => i.severity === sev).map((i) => i.kind);

test('a candidate set is recognised as PLATO JSON and as JSON Lines, and checks clean', async () => {
  const r = await go([file(SET)], 'check');
  assert.deepEqual([r.input.format, r.input.profile], ['plato-json', 'candidate-set']);
  assert.deepEqual([r.report.errors, r.report.counts], [0, { candidates: 2 }]);
  const { candidates, ...head } = doc();
  const jsonl = [head, ...candidates].map((x) => JSON.stringify(x)).join('\n') + '\n';
  const l = await go([textFile(jsonl, 's.jsonl')], 'check');
  assert.deepEqual([l.input.format, l.input.profile, l.report.errors, l.report.counts], ['plato-jsonl', 'candidate-set', 0, { candidates: 2 }]);
});

test('a candidate set is checked against its profile: a status other than suggested, and a header without its dataset, are errors', async () => {
  const bad = doc();
  bad.candidates[1].status = 'confirmed';
  delete bad.candidateSet.candidatesFor;
  const r = await go([textFile(JSON.stringify(bad), 's.json')], 'check');
  const schema = r.report.items.filter((i) => i.kind === 'schema');
  assert.equal(schema.length, 2, JSON.stringify(schema));
  assert.ok(schema.some((i) => /header/.test(i.message) && /candidatesFor/.test(i.message)), JSON.stringify(schema));
  assert.ok(schema.some((i) => /suggested/.test(i.message)), JSON.stringify(schema));
});

test('JSON -> N-Triples -> PLATO JSON gives the candidate set back, typed or not', async () => {
  for (const typing of [false, true]) {
    const a = await go([file(SET)], 'convert', 'ntriples', { typing });
    const b = await go([textFile(outText(a.e, 'candidate-set-judgements.nt'), 's.nt')], 'convert', 'plato-json');
    assert.deepEqual([kinds(b, 'error'), kinds(b, 'loss')], [[], []], `typing ${typing}`);
    assert.deepEqual(JSON.parse(outText(b.e, 's.json')), doc(), `typing ${typing}`);
  }
});

test('a graph holding a dataset and its candidate set is written as the dataset, and the candidate set is reported, not merged', async () => {
  const r = await go([file(`${PLATO_REPO}/examples/identity-judgements.ttl`)], 'convert', 'plato-json');
  const out = JSON.parse(outText(r.e, 'identity-judgements.json'));
  assert.equal(out.profile, 'place-centric');
  assert.deepEqual(out.gazetteer.candidateSets, ['https://whgazetteer.org/example/candidates/county-survey-2026-09-09']);
  assert.ok(!JSON.stringify(out).includes('"similarityScore"'), 'no candidate is written into the dataset');
  const lost = r.report.items.find((i) => i.kind === 'candidate-set-not-written');
  assert.deepEqual(lost?.examples, ['https://whgazetteer.org/example/candidates/county-survey-2026-09-09']);
  // The control: the dataset's own JSON, with no candidate set in it, reports none.
  const plain = await go([file(`${EX}/attestation-centric-judgements.json`)], 'convert', 'plato-json');
  assert.deepEqual(kinds(plain, 'loss'), []);
});

test('a tool that reads a dataset\'s records refuses a candidate set in words, and does not throw', async () => {
  const seen = [];
  const sink = { header: (h) => seen.push(h), event: (ev) => seen.push(ev), close: async () => {} };
  const input = await detect([file(SET)]);
  const r = await run({ input, action: 'check', options: { sink } }, env());
  assert.deepEqual([r.incomplete, kinds(r, 'error'), seen], [true, ['candidate-set-not-a-dataset'], []]);
  // The control: a dataset is given to the same sink.
  const d = await run({ input: await detect([file(`${EX}/attestation-centric-judgements.json`)]), action: 'check', options: { sink } }, env());
  assert.equal(d.report.errors, 0);
  assert.ok(seen.length > 0);
});
