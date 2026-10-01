// Reading files in chunks of the size a browser or DecompressionStream hands over, so that what a
// small test file read in one chunk never shows (a line split across chunks, a first line longer
// than a chunk) is tested at a size that runs in a moment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, strToU8 } from 'fflate';
import { detect, lines } from '../src/engine/input.js';
import { go, env } from './engine.js';
import { compare } from '../src/engine/compare.js';
import { randomBytes } from 'node:crypto';
import { Tokenizer, TokenizerError } from '../src/vendor/streamparser-json/index.js';

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
/** A File-like like chunked(), whose stream is pulled chunk by chunk and counts the bytes it hands over. */
function counted(bytes, name, size = 16384) {
  if (typeof bytes === 'string') bytes = strToU8(bytes);
  const f = chunked(bytes, name, size);
  f.read = 0;
  f.stream = () => { let i = 0; return new ReadableStream({ pull(c) { if (i >= bytes.length) { c.close(); return; } const b = bytes.slice(i, i + size); i += size; f.read += b.length; c.enqueue(b); } }); };
  return f;
}
test('detecting a PLATO JSON document stops reading once its profile is found', async () => {
  const many = Array.from({ length: 40_000 }, (_, i) => ({ ...JSON.parse(onePlace), '@id': `https://example.org/p${i}` }));
  const doc = JSON.stringify({ profile: 'place-centric', gazetteer: { title: 'T' }, spatialEntities: many });
  assert.ok(doc.length > 2 ** 21, 'the document is megabytes long');
  const f = counted(doc, 'big.json');
  assert.equal((await detect([f])).format, 'plato-json');
  // Detection read the start (64 KB and a little the pipes read ahead), never the whole.
  assert.ok(f.read < 2 ** 18, `read ${f.read} of ${doc.length}`);
  // Control that the count counts: a profile after a long gazetteer is still found, and to find it takes reading past the gazetteer.
  const late = counted(JSON.stringify({ gazetteer: { title: 'T', description: 'd'.repeat(600_000) }, profile: 'place-centric', spatialEntities: many }), 'late.json');
  assert.equal((await detect([late])).profile, 'place-centric');
  assert.ok(late.read > 600_000 && late.read < 600_000 + 2 ** 18, `read ${late.read}`);
});
test('a gzipped JSON Lines file damaged within its long first line says so, not that the line is not JSON', async () => {
  // Hex text compresses to about half: cut the gzip at 300 KB and well over 64 KB of the line has come through.
  const line = JSON.stringify({ profile: 'place-centric', gazetteer: { title: 'T', description: randomBytes(500_000).toString('hex') } });
  const gz = gzipSync(strToU8(line + '\n' + onePlace + '\n'));
  const d = await detect([chunked(gz.slice(0, 300_000), 'cut.jsonl.gz')]);
  assert.equal(d.format, null);
  assert.match(d.reason, /stops, or is damaged, part-way through/);
  assert.doesNotMatch(d.reason, /not valid JSON/);
  // Control: whole, the same file is detected.
  assert.equal((await detect([chunked(gz, 'whole.jsonl.gz')])).format, 'plato-jsonl');
});
test('detection lets a fault of its own through, and stands on what it found before a document breaks', async () => {
  const doc = JSON.stringify({ gazetteer: { title: 'T' }, profile: 'place-centric', spatialEntities: [JSON.parse(onePlace)] });
  const write = Tokenizer.prototype.write;
  try {
    Tokenizer.prototype.write = function () { throw new TypeError('a fault in the tools'); };
    await assert.rejects(detect([chunked(doc, 'x.json')]), /a fault in the tools/);
    // Control: a document that breaks (the parser's own error) is still detected by what came before.
    Tokenizer.prototype.write = function () { throw new TokenizerError('Unexpected "x"'); };
    assert.equal((await detect([chunked(doc, 'x.json')])).format, 'plato-json');
  } finally { Tokenizer.prototype.write = write; }
});

// ---- what a line holds ------------------------------------------------------------------------
test('a line of PLATO JSON Lines that is not an object is an error with its line, and the rest is read', async () => {
  const head = JSON.stringify({ profile: 'place-centric', gazetteer: { title: 'T' } });
  for (const bad of ['null', '5', '"x"', '[1]', 'true']) {
    const f = chunked([head, bad, onePlace].join('\n') + '\n', 'x.jsonl');
    for (const [action, target] of [['check'], ['convert', 'plato-jsonl'], ['convert', 'ntriples'], ['convert', 'lpf'], ['convert', 'tables']]) {
      const r = await go([f], action, target);
      const e = errors(r).filter((i) => i.kind === 'jsonl-not-an-object');
      assert.equal(e.length, 1, `${bad} ${target}: ${JSON.stringify(errors(r))}`);
      assert.match(e[0].examples[0], /^line 2: /);
      // Presence beside the absence: the place after the bad line is read.
      assert.equal(r.report.counts.places, 1, `${bad} ${target}`);
    }
  }
});

test('a line of an LPF sequence that is not a Feature is reported, not dropped in silence', async () => {
  const fc = JSON.stringify({ type: 'FeatureCollection', '@context': 'https://raw.githubusercontent.com/LinkedPasts/linked-places-format/main/linkedplaces-context-v1.1.jsonld', title: 'T' });
  const feature = (i) => JSON.stringify({ '@id': `https://example.org/f${i}`, type: 'Feature', properties: { title: `F${i}` }, names: [{ toponym: `F${i}` }] });
  const f = chunked([fc, feature(1), JSON.stringify({ type: 'Point', coordinates: [0, 0] }), 'null', feature(2)].join('\n') + '\n', 'x.geojsonl');
  assert.equal((await detect([f])).format, 'lpf-seq');
  const r = await go([f], 'check');
  const e = errors(r).filter((i) => i.kind === 'lpf-not-a-feature');
  assert.equal(e.length, 1, JSON.stringify(errors(r)));
  assert.deepEqual(e[0].examples, ['line 3', 'line 4']);
  // The collection's own first line is its header, not a feature out of place; the features are read.
  assert.equal(errors(r).length, 1, JSON.stringify(errors(r)));
  assert.equal(r.report.counts.places, 2);
});
test('a version with a line that is not a Feature is not read whole, so the version check cannot pass it', async () => {
  const fc = JSON.stringify({ type: 'FeatureCollection', title: 'T' });
  const feature = JSON.stringify({ '@id': 'https://example.org/f1', type: 'Feature', properties: { title: 'F1' }, names: [{ toponym: 'F1' }] });
  const cmp = async (text) => (await compare({ earlier: await detect([chunked(fc + '\n' + feature + '\n', 'a.geojsonl')]), later: await detect([chunked(text, 'b.geojsonl')]) }, env())).report;
  const bad = await cmp(fc + '\n' + feature + '\n' + JSON.stringify({ type: 'feature', properties: { title: 'F2' } }) + '\n');
  assert.ok(bad.items.some((i) => i.kind === 'version-not-read'), JSON.stringify(bad.items.map((i) => i.kind)));
  // Control: the same version without the line is read whole.
  const good = await cmp(fc + '\n' + feature + '\n');
  assert.ok(!good.items.some((i) => i.kind === 'version-not-read'), JSON.stringify(good.items.map((i) => i.kind)));
});

// ---- Turtle that breaks part-way ----------------------------------------------------------------
const TTL = `@prefix plato: <https://w3id.org/plato#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<https://x.org/p> rdfs:label "Place" ; a plato:SpatialEntity .
<https://x.org/a> plato:attests_about <https://x.org/p> ; plato:notes "n" .
<https://x.org/r> rdfs:label "R" broken here .
<https://x.org/s> rdfs:label "S" .
`;
test('Turtle with a syntax error part-way is not read to the end: the run is incomplete, with no output, and says where', async () => {
  for (const f of [chunked(TTL, 'bad.ttl'), chunked(TTL, 'bad.ttl', 64)]) {
    const r = await go([f], 'convert', 'plato-jsonl');
    assert.equal(r.incomplete, true);
    assert.deepEqual(r.outputs, []);
    const e = errors(r).find((i) => i.kind === 'unreadable');
    assert.ok(e, JSON.stringify(errors(r)));
    assert.match(e.examples[0], /line 5/);
    // What came before the break was read: its four statements.
    assert.match(e.examples[0], /the 4 statements before it were read/);
  }
  // Control: without the broken line, the same file converts, complete.
  const good = await go([chunked(TTL.replace(/.*broken.*\n/, ''), 'good.ttl')], 'convert', 'plato-jsonl');
  assert.ok(!good.incomplete);
  assert.deepEqual(errors(good), []);
  assert.equal(good.outputs.length, 1);
  assert.equal(good.report.counts.triples, 5);
});

// ---- an attestation on its own in a place-centric file ---------------------------------------------
const loose = { '@id': 'https://example.org/a/loose', about: 'https://example.org/p', names: [{ toponym: 'Loose' }] };
const placeCentricWithLoose = () => chunked([JSON.stringify({ profile: 'place-centric', gazetteer: { title: 'T' } }), onePlace, JSON.stringify(loose)].join('\n') + '\n', 'loose.jsonl');
test('an attestation on its own line of place-centric JSON Lines is a schema error, and counted', async () => {
  const r = await go([placeCentricWithLoose()], 'check');
  const e = errors(r).filter((i) => i.kind === 'schema');
  assert.equal(e.length, 1, JSON.stringify(errors(r)));
  assert.match(e[0].message, /place-centric/);
  assert.match(e[0].examples[0], /line 3/);
  assert.equal(r.report.counts.attestations, 2);
  // Control: the same attestation under its place is no error.
  const nested = chunked([JSON.stringify({ profile: 'place-centric', gazetteer: { title: 'T' } }), JSON.stringify({ ...JSON.parse(onePlace), attestations: [{ names: [{ toponym: 'P' }] }, { '@id': loose['@id'], names: loose.names }] })].join('\n') + '\n', 'nested.jsonl');
  const ok = await go([nested], 'check');
  assert.deepEqual(errors(ok), []);
  assert.equal(ok.report.counts.attestations, 2);
});
test('an attestation on its own in a place-centric document is a schema error too', async () => {
  const doc = { profile: 'place-centric', gazetteer: { title: 'T' }, spatialEntities: [JSON.parse(onePlace)], attestations: [loose] };
  const r = await go([chunked(JSON.stringify(doc), 'loose.json')], 'check');
  assert.equal(errors(r).filter((i) => i.kind === 'schema' && /place-centric/.test(i.message)).length, 1, JSON.stringify(errors(r)));
});
test('every writer says truly what becomes of an attestation on its own in place-centric input', async () => {
  for (const target of ['plato-jsonl', 'plato-json', 'lpf', 'lpf-seq', 'tables']) {
    const r = await go([placeCentricWithLoose()], 'convert', target);
    const lost = r.report.items.find((i) => i.kind === 'attestation-centric');
    assert.equal(lost?.severity, 'loss', `${target}: ${JSON.stringify(r.report.items)}`);
    assert.match(lost.message, /left out/, target);
    assert.deepEqual(lost.examples, ['https://example.org/a/loose'], target);
    assert.ok(!r.report.items.some((i) => /regrouped/.test(i.message)), `${target}: nothing was regrouped`);
  }
  // N-Triples carries it, and so reports no loss: control that the loss is not reported regardless.
  const r = await go([placeCentricWithLoose()], 'convert', 'ntriples');
  assert.ok(!r.report.items.some((i) => i.kind === 'attestation-centric' && i.severity === 'loss'));
  assert.match(r.e.outs['loose.nt'].join(''), /<https:\/\/example.org\/a\/loose> <https:\/\/w3id.org\/plato#attests_about> <https:\/\/example.org\/p>/);
});

// ---- a run stopped part-way closes what it opened ------------------------------------------------
// A DataError part-way (a gzip cut short) ends the run with no outputs; the writer's output must still
// be closed, or a host cannot remove it (in the browser an open OPFS access handle keeps the file).
test('a conversion stopped part-way by a gzip cut short closes its output and records none', async () => {
  const X = 'https://example.org/';
  const rows = [{ profile: 'place-centric', gazetteer: { title: 't' } }];
  for (let i = 0; i < 3000; i++) rows.push({ '@id': `${X}place/p${i}`, label: 'p' + i, attestations: [{ sources: [{ '@id': X + 'source/s', title: 'S' }], names: [{ toponym: 'p' + i }] }] });
  const gz = gzipSync(strToU8(rows.map((o) => JSON.stringify(o)).join('\n') + '\n'));
  const convert = async (bytes) => {
    const e = env(); const base = e.output; let opened = 0, closed = 0;
    e.output = async (...a) => { const o = await base(...a); opened++; const c = o.close; o.close = async () => { closed++; return c(); }; return o; };
    const { run } = await import('../src/engine/pipeline.js');
    const r = await run({ input: await detect([chunked(bytes, 'places.jsonl.gz')]), action: 'convert', target: 'plato-jsonl' }, e);
    return { r, opened, closed };
  };
  // Control: the whole file opens one output, closes it, and records it.
  const whole = await convert(gz);
  assert.ok(!whole.r.incomplete);
  assert.deepEqual([whole.opened, whole.closed, whole.r.outputs.length], [1, 1, 1]);
  const cut = await convert(gz.slice(0, Math.floor(gz.length / 2)));
  assert.equal(cut.r.incomplete, true, JSON.stringify(cut.r.report.items));
  assert.ok(cut.r.report.items.some((i) => i.kind === 'unreadable'));
  assert.equal(cut.opened, 1, 'the output was opened before the reader stopped');
  assert.equal(cut.closed, 1, 'and is closed although the run stopped');
  assert.deepEqual(cut.r.outputs, []);
});
