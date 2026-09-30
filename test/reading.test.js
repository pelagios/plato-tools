// Reading files in chunks of the size a browser or DecompressionStream hands over, so that what a
// small test file read in one chunk never shows (a line split across chunks, a first line longer
// than a chunk) is tested at a size that runs in a moment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, strToU8 } from 'fflate';
import { detect, lines } from '../src/engine/input.js';
import { go } from './engine.js';

/** A File-like whose stream() yields `size`-byte chunks, as a large file's does. */
export function chunked(bytes, name, size = 16384) {
  if (typeof bytes === 'string') bytes = strToU8(bytes);
  return {
    name, size: bytes.length,
    slice: (a, b) => new Blob([bytes.slice(a, b)]),
    arrayBuffer: async () => bytes.slice().buffer,
    text: async () => new TextDecoder().decode(bytes),
    stream: () => new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size)); c.close(); } }),
  };
}
const errors = (r) => r.report.items.filter((i) => i.severity === 'error');

test('line numbers do not drift across chunk boundaries: a bad line 300 is reported as line 300', async () => {
  const header = JSON.stringify({ profile: 'place-centric', gazetteer: { title: 'T' } });
  const place = (i) => JSON.stringify({ '@id': `https://example.org/p${i}`, label: `P${i}`, attestations: [{ names: [{ toponym: `P${i}` }], notes: 'x'.repeat(200) }] });
  const rows = [header]; for (let i = 2; i <= 400; i++) rows.push(i === 300 ? '{not json' : place(i));
  const text = rows.join('\n') + '\n';
  const f = chunked(text, 'drift.jsonl');
  assert.ok(text.length > 5 * 16384, 'the file spans several chunks');
  // Presence and absence in one call: every line number is its own, the bad one included.
  const seen = []; for await (const { line, n } of lines(f)) seen.push([n, line]);
  assert.deepEqual(seen.map(([n]) => n), rows.map((_, i) => i + 1));
  const r = await go([f], 'check');
  const syntax = errors(r).filter((e) => e.kind === 'json-syntax');
  assert.equal(syntax.length, 1);
  assert.match(syntax[0].examples[0], /^line 300: /);
  assert.equal(r.report.counts.places, 398);
});

// ---- detection reads as far as it needs to ------------------------------------------------------
const longHeader = (extra = {}) => JSON.stringify({ profile: 'place-centric', gazetteer: { title: 'T', description: 'd'.repeat(200_000) }, ...extra });
const onePlace = JSON.stringify({ '@id': 'https://example.org/p', label: 'P', attestations: [{ names: [{ toponym: 'P' }] }] });

test('a JSON Lines file whose first line is longer than a chunk is detected, gzipped or not', async () => {
  const text = longHeader() + '\n' + onePlace + '\n';
  for (const f of [chunked(gzipSync(strToU8(text)), 'long.jsonl.gz'), chunked(text, 'long.jsonl')]) {
    const d = await detect([f]);
    assert.equal(d.format, 'plato-jsonl', `${f.name}: ${d.reason}`);
    assert.equal(d.profile, 'place-centric');
    const r = await go([f], 'check');
    assert.deepEqual(errors(r), []);
    assert.equal(r.report.counts.places, 1);
  }
  // Control: a short first line was always detected, and still is.
  assert.equal((await detect([chunked(JSON.stringify({ profile: 'place-centric', gazetteer: { title: 'T' } }) + '\n' + onePlace + '\n', 'short.jsonl')])).format, 'plato-jsonl');
});
test('a JSON Lines first line that is not JSON, or not an object, is a reason, never a fault', async () => {
  for (const [first, why] of [['{"profile": ', /not valid JSON/], ['null', /not a JSON object/], ['5', /not a JSON object/], ['[1,2]', /not a JSON object/]]) {
    const d = await detect([chunked(first + '\n' + onePlace + '\n', 'x.jsonl')]);
    assert.equal(d.format, null, first);
    assert.match(d.reason, why, first);
  }
});
test('a JSON Lines first line longer than detection reads is refused with a reason that says so', async () => {
  const d = await detect([chunked(gzipSync(strToU8(JSON.stringify({ profile: 'place-centric', gazetteer: { title: 'x'.repeat(17 * 2 ** 20) } }) + '\n')), 'huge.jsonl.gz', 65536)]);
  assert.equal(d.format, null);
  assert.match(d.reason, /first line .* longer than 16 MB/);
});
test('a PLATO JSON document whose profile comes after a long gazetteer is detected', async () => {
  const doc = (profile) => JSON.stringify({ gazetteer: { title: 'T', description: 'd'.repeat(200_000) }, ...profile, spatialEntities: [JSON.parse(onePlace)] });
  for (const f of [chunked(doc({ profile: 'place-centric' }), 'late.json'), chunked(gzipSync(strToU8(doc({ profile: 'place-centric' }))), 'late.json.gz')]) {
    const d = await detect([f]);
    assert.equal(d.format, 'plato-json', `${f.name}: ${d.reason}`);
    assert.equal(d.profile, 'place-centric');
    const r = await go([f], 'check');
    assert.deepEqual(errors(r), []);
    assert.equal(r.report.counts.places, 1);
  }
  // Control: without a profile anywhere, it is not PLATO JSON.
  assert.equal((await detect([chunked(doc({}), 'none.json')])).format, null);
  // A profile only nested inside a place is not the document's: control that the scan is at the top level.
  const nested = JSON.stringify({ gazetteer: { title: 'T', description: 'd'.repeat(200_000) }, spatialEntities: [{ ...JSON.parse(onePlace), profile: 'place-centric' }] });
  assert.equal((await detect([chunked(nested, 'nested.json')])).format, null);
});
test('an LPF FeatureCollection whose type comes after a long member is detected', async () => {
  const fc = JSON.stringify({ title: 't'.repeat(200_000), type: 'FeatureCollection', '@context': 'https://raw.githubusercontent.com/LinkedPasts/linked-places-format/main/linkedplaces-context-v1.1.jsonld', features: [] });
  const d = await detect([chunked(fc, 'late.geojson')]);
  assert.equal(d.format, 'lpf', d.reason);
  assert.equal(d.lpfVersion, 1);
});
