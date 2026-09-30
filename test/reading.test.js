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
