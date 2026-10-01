// A large table read with options.sameId (src/engine/hermes/generic.js): 200,000 rows, two for each
// id, through run() and the store; and what the reader itself keeps while it reads, which must be
// each id and its names, never a row. Kept in a file of its own, as it takes a minute or more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { detect } from '../src/engine/input.js';
import { Report } from '../src/engine/report.js';
import { genericSource } from '../src/engine/hermes/generic.js';
import { textFile, go } from './engine.js';

const ROWS = 200_000;
/** A CSV of `rows` rows, two for each id, each row with a note of `noteLength` characters. */
function table(rows, noteLength = 0) {
  const parts = [`id,name,lat,lon${noteLength ? ',remark' : ''}\n`];
  for (let i = 0; i < rows; i++) {
    const id = i >> 1;
    parts.push(`p${id},Place ${id},${(i % 80) + 0.5},${(i % 170) + 0.5}${noteLength ? `,${String(i).padEnd(noteLength, 'x')}` : ''}\n`);
  }
  return textFile(parts.join(''), 'big.csv');
}

test(`through the engine: ${ROWS.toLocaleString('en-GB')} rows, two for each id, become ${(ROWS / 2).toLocaleString('en-GB')} places through the store`, { timeout: 600_000 }, async (t) => {
  const started = Date.now();
  const r = await go([table(ROWS)], 'check', undefined, { sameId: true });
  const peakMB = Math.round(process.resourceUsage().maxRSS / 1024);
  t.diagnostic(`${ROWS} rows in ${Date.now() - started} ms; peak RSS ${peakMB} MB (the in-memory store of the tests included)`);
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items.filter((i) => i.severity === 'error').slice(0, 3)));
  assert.deepEqual([r.report.counts.rows, r.report.counts.places, r.report.counts.attestations], [ROWS, ROWS / 2, ROWS]);
  assert.ok(!r.report.items.some((i) => i.kind === 'generic-same-id-label'), 'the names of each id agree');
  assert.ok(r.report.items.some((i) => i.kind === 'generic-stand-in-base'), 'control: the report was read');
  assert.ok(peakMB < 2048, `peak RSS ${peakMB} MB`);
});

test('the reader keeps each id and its names while it reads, never a row', { timeout: 300_000 }, async (t) => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');
  // The heap the reader holds once every row is read (its first place is yielded after the last row).
  // Measured at about 29 MB for 100,000 ids, with plain rows or long ones; holding the rows as well
  // measured about 125 MB.
  const held = async (f) => {
    const input = await detect([f]);
    gc(); const before = process.memoryUsage().heapUsed;
    let after, rows = 0;
    for await (const ev of genericSource(input, new Report(), { sameId: true })) {
      if (ev.type === 'attestation') rows++;
      else if (ev.type === 'record' && after === undefined) { gc(); after = process.memoryUsage().heapUsed; }
    }
    assert.equal(rows, ROWS);
    return (after - before) / 1e6;
  };
  const thin = await held(table(ROWS));
  const fat = await held(table(ROWS, 400));
  t.diagnostic(`held once every row was read: ${thin.toFixed(1)} MB for plain rows, ${fat.toFixed(1)} MB for rows with a 400-character note (${ROWS / 2} ids)`);
  for (const [what, mb] of [['plain rows', thin], ['rows with a long note', fat]]) {
    assert.ok(mb < 60, `${what}: ${mb.toFixed(1)} MB held for ${ROWS / 2} ids`);
    assert.ok(mb > 1, `control (${what}): the ids are held, and the measure sees them`);
  }
});
