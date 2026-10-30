// Hermes, place names in a text: the text is kept in the work file but never in a project that is shared
// or saved to WHG (Stephen's defaults of 30 October 2026: "text kept in the work file but not in shared/
// WHG-saved projects, quoted context carries the text's rights"). A text may be someone else's, and a
// project goes to colleagues and to WHG's servers. The work file is left out of a project as a file
// (listed in `left`, so that whoever opens it knows), and a work file with the text in it is refused as
// the review open; the copy for sharing (work.js, withoutText) is accepted.
//
// Every absence is beside a presence: the sentinel is in the work file, and in the project's other parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { RECIPES, runner, recordOf, refsOf } from '../src/engine/methodos/index.js';
import { writeProject, ProjectError } from '../src/engine/methodos/project.js';
import { fitProject } from '../src/engine/workbench.js';
import * as T from '../src/engine/hermes/text/index.js';
import { found, REVIEWER, SOURCE } from './hermes-text-helpers.js';

const NOW = new Date('2026-10-30T10:00:00Z');
const SENTINEL = 'A-PASSAGE-OF-A-TEXT-THAT-IS-NOT-OURS-TO-SHARE';
const TEXT = `He came from Ostia to Roma. ${'And so on. '.repeat(30)}${SENTINEL}.`;
const file = (text, name) => new File([text], name, { type: 'application/json' });

async function project() {
  const { work } = await found(TEXT, ['Ostia', 'Roma'], { source: { ...SOURCE, rights: 'Public domain.' } });
  T.setReviewer(work, REVIEWER);
  const workFile = file(T.serialiseWork(work), 'itinerary.hermes-text.json');
  assert.equal(await workFile.text().then((t) => t.includes(SENTINEL)), true, 'the work file keeps the text');
  const [textRef] = await refsOf([workFile], 'work.hermes-text');
  const dataset = file(JSON.stringify({ profile: 'place-centric', spatialEntities: [{ '@id': 'https://example.org/p/1' }] }), 'places.json');
  const [dataRef] = await refsOf([dataset], 'dataset');
  const table = file('id,name\n1,Roma\n', 'places.csv');
  const [tableRef] = await refsOf([table], 'files');
  let s = runner.start(RECIPES['map-your-data'], { 'has-regions': false, 'will-draw': false, 'will-publish': false, target: 'plato-json' }, { files: [tableRef] });
  const record = recordOf({ ...s, id: 'map-your-data-t1', scope: { where: { countries: [] }, types: [], sources: [] } }, { name: 'A text', now: NOW });
  // The workflow names both files as outputs of a step (the work file of a text, and a dataset).
  record.steps[0].outputs = { work: [textRef], dataset: [dataRef] };
  return { record, work, workFile, dataset, textRef, dataRef, tableRef, table, files: [{ ref: textRef, blob: workFile }, { ref: dataRef, blob: dataset }, { ref: tableRef, blob: table }] };
}
const written = async (opts) => {
  const chunks = [];
  const r = await writeProject({ tools: { version: 'test', commit: null }, now: NOW, ...opts }, async (c) => { chunks.push(c); });
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0; for (const c of chunks) { bytes.set(c, at); at += c.length; }
  return { bytes, manifest: r.manifest };
};
const everything = (bytes) => Object.values(unzipSync(bytes)).map((b) => strFromU8(b)).join('\n');

test('a project leaves the work file with the text out, and says so; the other files go in', async () => {
  const p = await project();
  const { bytes, manifest } = await written({ record: p.record, files: p.files });
  const shas = manifest.parts.map((x) => x.sha256);
  assert.equal(shas.includes(p.dataRef.sha256), true, 'the dataset is in it');
  assert.equal(shas.includes(p.tableRef.sha256), true, 'and the table');
  assert.equal(shas.includes(p.textRef.sha256), false, 'the work file with the text is not');
  assert.deepEqual(manifest.left.map((x) => [x.name, x.sha256, x.why]), [['itinerary.hermes-text.json', p.textRef.sha256, 'left-out']]);
  assert.equal(everything(bytes).includes(SENTINEL), false, 'the text is nowhere in the zip');
  assert.equal(everything(bytes).includes('Ostia'), false, 'nor the names, which were in the work file only');
  assert.equal(everything(bytes).includes('Roma'), true, 'control: the table\'s own words are');
});

test('saved to WHG, the same: the work file with the text is left out of the project that is fitted to the Workbench', async () => {
  const p = await project();
  const fit = await fitProject({ record: p.record, files: p.files, tools: { version: 'test', commit: null }, now: NOW });
  assert.equal(everything(fit.bytes).includes(SENTINEL), false);
  assert.deepEqual(fit.tooLarge, [], 'it was not left out for its size');
  const manifest = JSON.parse(strFromU8(unzipSync(fit.bytes)['manifest.json']));
  assert.deepEqual(manifest.left.map((x) => [x.sha256, x.why]), [[p.textRef.sha256, 'left-out']], 'named as left out');
  const names = Object.keys(unzipSync(fit.bytes));
  assert.equal(names.some((n) => n === `files/${p.dataRef.sha256}`), true, 'control: the dataset is in it');
  assert.equal(names.some((n) => n === `files/${p.textRef.sha256}`), false);
});

test('a work file with the text in it is refused as the review open; the copy for sharing is taken', async () => {
  const p = await project();
  const files = [{ ref: p.dataRef, blob: p.dataset }, { ref: p.tableRef, blob: p.table }];
  const withText = T.serialiseWork(p.work);
  await assert.rejects(written({ record: p.record, files, review: { name: 'itinerary.hermes-text.json', text: withText } }),
    (e) => e instanceof ProjectError && /itinerary\.hermes-text\.json.* holds the text itself/.test(e.message) && /without its text/.test(e.message));
  const shared = T.serialiseWork(T.withoutText(p.work));
  const { bytes, manifest } = await written({ record: p.record, files, review: { name: 'itinerary.hermes-text.json', text: shared } });
  assert.equal(manifest.parts.some((x) => x.role === 'review'), true, 'the copy is the review');
  assert.equal(everything(bytes).includes(SENTINEL), false, 'and the text is not in it');
  assert.equal(everything(bytes).includes('Public domain.'), true, 'but the rights statement it carries is');
  // A work file that kept no text is no different.
  const off = JSON.parse(withText); delete off.text.content;
  assert.ok((await written({ record: p.record, files, review: { name: 'a.hermes-text.json', text: JSON.stringify(off) } })).bytes.length > 0);
  // A review that is not a work file of a text is not looked into.
  assert.ok((await written({ record: p.record, files, review: { name: 'a.krisis.json', text: JSON.stringify({ krisis: 3, text: { content: 'x' } }) } })).bytes.length > 0);
});
