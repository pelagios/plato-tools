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

test('a typed candidate set with something more said of a place it matches is still a candidate set, not a dataset of empty places', async () => {
  const a = await go([file(SET)], 'convert', 'ntriples', { typing: true });
  const nt = outText(a.e, 'candidate-set-judgements.nt')
    + '<https://whgazetteer.org/example/entity/newton-by-the-river> <http://www.w3.org/2000/01/rdf-schema#label> "Newton (by the river)" .\n';
  const b = await go([textFile(nt, 's.nt')], 'convert', 'plato-json');
  const out = JSON.parse(outText(b.e, 's.json'));
  assert.equal(out.profile, 'candidate-set', JSON.stringify(out).slice(0, 200));
  assert.equal(out.candidates.length, 2);
  assert.ok(!b.report.items.some((i) => i.kind === 'candidate-set-not-written'));
});

test('a graph holding a dataset and its candidate set is written as the dataset, and the candidate set is reported, not merged', async () => {
  const r = await go([file(`${PLATO_REPO}/examples/identity-judgements.ttl`)], 'convert', 'plato-json');
  const out = JSON.parse(outText(r.e, 'identity-judgements.json'));
  assert.equal(out.profile, 'place-centric');
  assert.deepEqual(out.gazetteer.candidateSets, ['https://whgazetteer.org/example/candidates/county-survey-2026-09-09']);
  assert.ok(!JSON.stringify(out).includes('"similarityScore"'), 'no candidate is written into the dataset');
  const lost = r.report.items.find((i) => i.kind === 'candidate-set-not-written');
  assert.deepEqual(lost?.examples, ['https://whgazetteer.org/example/candidates/county-survey-2026-09-09']);
  // RDF to RDF too: the dataset is written, and the candidate set's triples are reported as left out.
  const nt = await go([file(`${PLATO_REPO}/examples/identity-judgements.ttl`)], 'convert', 'ntriples');
  assert.ok(!outText(nt.e, 'identity-judgements.nt').includes('similarity_score'), 'no candidate is written');
  assert.deepEqual(nt.report.items.find((i) => i.kind === 'candidate-set-not-written')?.examples, ['https://whgazetteer.org/example/candidates/county-survey-2026-09-09']);
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

// ---- the profile, its wording when absent, the reverse link, and what the lossy formats do -------
import { res } from './engine.js';
import { droppedText, FORMAT_WORDS } from '../src/engine/report.js';
import jsonld from 'jsonld';
import { Json2Rdf } from '../src/formats/json2rdf.js';
import { tripleNT } from '../src/lib/ntriples.js';
import { unzipSync, strFromU8 } from 'fflate';

test('the candidate set profile is loaded, as vendored from PLATO at the pin', () => {
  const vendored = JSON.parse(readFileSync('public/plato/candidate-set.schema.json', 'utf8'));
  assert.deepEqual(vendored, JSON.parse(readFileSync(`${PLATO_REPO}/schemas/candidate-set.schema.json`, 'utf8')));
  assert.deepEqual(res.profiles['candidate-set'], vendored);
  assert.ok(res.profiles['candidate-set'].properties.candidates && res.profiles['candidate-set'].properties.candidateSet);
  // The control: the dataset profiles are not it.
  assert.ok(!res.profiles['place-centric'].properties.candidates);
});

test('a document that is not PLATO is told so in words that name the candidate set, in JSON and in JSON Lines', async () => {
  const json = await detect([textFile(JSON.stringify({ candidateSet: {}, candidates: [] }), 'x.json')]);
  const jsonl = await detect([textFile('{"candidateSet":{}}\n{"candidate":1}\n', 'x.jsonl')]);
  const arr = await detect([textFile('[1]\n2\n', 'x.jsonl')]);
  for (const d of [json, jsonl]) { assert.equal(d.format, null); assert.match(d.reason, /neither a PLATO (document|header) \(.*a candidate set/, d.reason); }
  assert.match(arr.reason, /neither a PLATO header \(of a dataset or a candidate set\)/, arr.reason);
  // The control: with its profile, the same JSON Lines is a candidate set.
  const ok = await detect([textFile('{"profile":"candidate-set","candidateSet":{}}\n{"candidate":1}\n', 'x.jsonl')]);
  assert.deepEqual([ok.format, ok.profile], ['plato-jsonl', 'candidate-set']);
});

const DATASET = `${EX}/attestation-centric-judgements.json`;
const CF = '<https://w3id.org/plato#candidates_for>';
function compiledNT(d) {
  let nt = '';
  const w = new Json2Rdf(res.context, (s, p, o) => { nt += tripleNT(s, p, o); });
  const { spatialEntities, newSpatialEntities, attestations, identityRelations, ...head } = d;
  w.header(head);
  for (const [k, arr] of Object.entries({ spatialEntities, newSpatialEntities, attestations, identityRelations })) for (const r of arr || []) w.record(k, r);
  return nt;
}
test("a dataset's candidateSets are the reverse of plato:candidates_for, exactly as jsonld.js gives them, and come back from RDF", async () => {
  const d = JSON.parse(readFileSync(DATASET, 'utf8'));
  const sets = d.gazetteer.candidateSets;
  assert.ok(Array.isArray(sets) && sets.length > 0, 'the example carries candidateSets');
  const want = sets.map((s) => `<${s}> ${CF} <${d.gazetteer['@id']}> .`).sort();
  const lines = (nt) => nt.split('\n').filter((l) => l.includes(CF)).map((l) => l.trim()).sort();
  const ref = await jsonld.toRDF({ ...d, '@context': res.context['@context'] }, { format: 'application/n-quads', safe: false });
  assert.deepEqual(lines(ref), want);
  assert.deepEqual(lines(compiledNT(d)), want);
  // The control: without candidateSets, neither writes the link.
  const { candidateSets, ...gz } = d.gazetteer;
  assert.deepEqual(lines(compiledNT({ ...d, gazetteer: gz })), []);
  // And back: JSON -> N-Triples -> JSON gives the same candidateSets.
  const a = await go([file(DATASET)], 'convert', 'ntriples');
  const b = await go([textFile(outText(a.e, 'attestation-centric-judgements.nt'), 'j.nt')], 'convert', 'plato-json');
  assert.deepEqual(JSON.parse(outText(b.e, 'j.json')).gazetteer.candidateSets, sets);
});

test("a dataset's candidateSets, written as spreadsheet tables or LPF, are left out and reported in words", async () => {
  const d = JSON.parse(readFileSync(DATASET, 'utf8'));
  const { candidateSets, ...gz } = d.gazetteer;
  for (const target of ['tables', 'lpf', 'lpf-seq']) {
    const r = await go([file(DATASET)], 'convert', target);
    assert.equal(r.report.errors, 0, target);
    const it = r.report.items.find((i) => i.kind === 'dropped:gazetteer.candidateSets');
    assert.ok(it, `${target}: reported`);
    assert.equal(it.message, droppedText('gazetteer.candidateSets', FORMAT_WORDS[target]));
    assert.match(it.message, /^The candidate sets that suggest matches for the gazetteer's places \(candidateSets\)/);
    // What was written, as text: the tables are a zip, so it is unzipped and its CSVs read.
    const text = target === 'tables'
      ? Object.values(unzipSync(new Uint8Array(await new Blob(r.e.outs[r.outputs[0].name]).arrayBuffer()))).map(strFromU8).join('\n')
      : outText(r.e, r.outputs[0].name);
    // The gazetteer's title is there (so the search can find what was written), and its candidate set is not.
    assert.deepEqual([text.includes(d.gazetteer.title), text.includes(candidateSets[0])], [true, false], `${target}: title written, candidate set not`);
    // The control: without them, nothing of the kind is reported.
    const c = await go([textFile(JSON.stringify({ ...d, gazetteer: gz }), 'n.json')], 'convert', target);
    assert.ok(!c.report.items.some((i) => i.kind === 'dropped:gazetteer.candidateSets'), target);
  }
});

test('a candidate set written as spreadsheet tables or LPF is refused in plain words', async () => {
  const words = 'A candidate set cannot be written as spreadsheet tables or Linked Places Format: neither has a place for suggestions made by software, which are claims by no one. Keep it as PLATO JSON or RDF.';
  for (const target of ['tables', 'lpf', 'lpf-seq']) {
    const r = await go([file(SET)], 'convert', target);
    const e = r.report.items.filter((i) => i.severity === 'error');
    assert.deepEqual(e.map((i) => [i.kind, i.message]), [['candidate-set-target', words]], target);
  }
  const ok = await go([file(SET)], 'convert', 'ntriples');
  assert.ok(!ok.report.items.some((i) => i.message === words));
});
