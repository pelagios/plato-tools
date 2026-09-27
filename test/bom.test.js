// U+FEFF inside a string is data (Pleiades place 585129 has one leading an attested form). The
// streaming JSON parser decoded each run of string bytes with a fresh TextDecoder that strips a
// leading BOM, so a U+FEFF was lost wherever a run happened to start with it: at a string's
// start, after an escape sequence, or at a chunk boundary. Patched in patches/ (ignoreBOM: true).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textFile, go, outText } from './engine.js';

const FORMS = ['﻿Lead', 'Trail﻿', 'Mid﻿dle', 'after\\nescape﻿x'.replace('\\n', '\n'), '﻿'.repeat(3) + 'many'];
const doc = { profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' },
  spatialEntities: [{ '@id': 'https://example.org/p/1', label: 'P', attestations: FORMS.map((toponym) => ({ names: [{ toponym }], sources: [{ title: 's' }] })) }] };
const toponyms = (jsonl) => jsonl.trim().split('\n').slice(1).flatMap((l) => JSON.parse(l).attestations.flatMap((a) => a.names.map((n) => n.toponym))).sort();

test('U+FEFF in a string survives JSON -> N-Triples -> JSON Lines, wherever it falls', async () => {
  const a = await go([textFile(JSON.stringify(doc), 'bom.json')], 'convert', 'ntriples');
  const nt = outText(a.e, Object.keys(a.e.outs)[0]);
  assert.equal((nt.match(/﻿/g) || []).length, 7, 'every U+FEFF reaches the N-Triples');
  const b = await go([textFile(nt, 'bom.nt')], 'convert', 'plato-jsonl');
  assert.deepEqual(toponyms(outText(b.e, Object.keys(b.e.outs)[0])), [...FORMS].sort());
});
test('control: the round trip notices a lost U+FEFF', async () => {
  const b = await go([textFile(JSON.stringify(doc).replace('﻿Lead', 'Lead'), 'nobom.json')], 'convert', 'plato-jsonl');
  assert.notDeepEqual(toponyms(outText(b.e, Object.keys(b.e.outs)[0])), [...FORMS].sort());
});
