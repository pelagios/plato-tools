// The page's worker (src/engine/worker.js) refuses a file it cannot read as a dataset before it
// opens anything, as a finding in the report, with the file's own reason: a IIIF Georeference
// Annotation is recognised (format 'georef') and refused by readable(), never handed to a part to
// fail in, which would be shown as something gone wrong in the tools.
//
// The worker is run in Node with `self` and `postMessage` stood in for: a refusal posts its finding
// before the worker opens its databases, which Node could not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { file } from './engine.js';

const posted = [];
globalThis.self = globalThis.self || {};
globalThis.postMessage = (m) => posted.push(m);
await import('../src/engine/worker.js');
const send = async (data) => { posted.length = 0; await self.onmessage({ data }); return posted.slice(); };

const GEOREF = 'test/fixtures/hermes-detect/loc-chesapeake-annotationpage.json';
const DATASET = 'test/fixtures/annotations/recogito-studio-constructed.json';
const finding = (m) => m.report?.items?.find((i) => i.kind === 'not-recognised');

test('publish: a IIIF Georeference Annotation as the dataset is refused with its reason, as a finding', async () => {
  const [m, ...rest] = await send({ cmd: 'publish', part: 'report', files: [file(GEOREF)] });
  assert.deepEqual(rest, []);
  assert.equal(m.type, 'done', `not a finding: ${JSON.stringify(m)}`);
  assert.equal(m.incomplete, true);
  const f = finding(m);
  assert.equal(f?.message, 'The dataset was not recognised as data these tools read, so nothing was done');
  assert.match(f.examples[0], /IIIF Georeference Annotation/);
});

test('publish: a IIIF Georeference Annotation as the previous release is refused the same way', async () => {
  const [m] = await send({ cmd: 'publish', part: 'mint', files: [file(DATASET)], previous: [file(GEOREF)] });
  assert.equal(m.type, 'done', `not a finding: ${JSON.stringify(m)}`);
  assert.equal(finding(m)?.message, 'The previous release was not recognised as data these tools read, so nothing was done');
  assert.match(finding(m).examples[0], /IIIF Georeference Annotation/);
});

test('match: a IIIF Georeference Annotation as the other dataset is refused with its reason (control for the same pattern)', async () => {
  const [m] = await send({ cmd: 'match', subjects: [file(DATASET)], others: [file(GEOREF)] });
  assert.equal(m.type, 'done', `not a finding: ${JSON.stringify(m)}`);
  assert.match(finding(m)?.message, /^The other dataset was not recognised/);
  assert.match(finding(m).examples[0], /IIIF Georeference Annotation/);
});

test('control: a readable dataset is not refused, but goes on to be run', async () => {
  const msgs = await send({ cmd: 'publish', part: 'report', files: [file(DATASET)] });
  assert.ok(msgs.length > 0, 'something was posted');
  assert.ok(!msgs.some(finding), `refused: ${JSON.stringify(msgs)}`);
});
