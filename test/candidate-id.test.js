// One minting of a candidate's address (src/engine/candidate-id.js), shared by Krisis, which mints
// (krisis/candidates.js), and Elenchos, which checks (candidates.js): both give PLATO's own example ids.
import { PLATO_REPO } from './paths.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { candidateText, candidateHash } from '../src/engine/candidate-id.js';
import { hashText, candidateHash as krisisHash } from '../src/engine/krisis/candidates.js';
import { candidateText as elenchosText } from '../src/engine/candidates.js';

const EX = `${PLATO_REPO}/schemas/examples`;

test('Krisis and Elenchos take a candidate\'s hash text and hash from the one function', () => {
  assert.equal(hashText, candidateText);
  assert.equal(elenchosText, candidateText);
  assert.equal(krisisHash, candidateHash);
});

test("the one function gives the ids of PLATO's candidate-set-regions example (#c-f129572e, #c-95321738)", () => {
  const ex = JSON.parse(readFileSync(`${EX}/candidate-set-regions.json`, 'utf8'));
  // By name, so that the loop below cannot pass over an empty list.
  assert.deepEqual(ex.candidates.map((c) => c['@id'].split('#')[1]).sort(), ['c-95321738', 'c-f129572e']);
  for (const c of ex.candidates) {
    const text = candidateText(c);
    assert.equal(candidateHash(text), createHash('sha256').update(text, 'utf8').digest('hex'));
    assert.equal(c['@id'], `${ex.candidateSet['@id']}#c-${candidateHash(text).slice(0, 8)}`);
  }
  // And a candidate changed in one of its four inputs is another candidate, with another id.
  const [c] = ex.candidates;
  assert.notEqual(candidateHash(candidateText({ ...c, algorithmVersion: `${c.algorithmVersion} ` })).slice(0, 8), c['@id'].split('#c-')[1]);
});

test("the one function gives the ids of PLATO's candidate-set-judgements example (#c-1ec753bb, #c-8ed2901c)", () => {
  const ex = JSON.parse(readFileSync(`${EX}/candidate-set-judgements.json`, 'utf8'));
  assert.deepEqual(ex.candidates.map((c) => c['@id'].split('#')[1]).sort(), ['c-1ec753bb', 'c-8ed2901c']);
  for (const c of ex.candidates) assert.equal(c['@id'], `${ex.candidateSet['@id']}#c-${candidateHash(candidateText(c)).slice(0, 8)}`);
});
