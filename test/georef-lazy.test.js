// The Allmaps libraries are loaded only when a georeference is used. In a file of its own, so
// that it runs in a fresh process (node --test runs each file separately) and no other test has
// loaded them first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as georef from '../src/engine/georef/index.js';

const DIR = 'src/engine/georef/';

test('no module of src/engine/georef/ imports Allmaps statically; index.js imports it dynamically', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.includes('index.js'));
  for (const f of files) {
    const src = readFileSync(DIR + f, 'utf8');
    assert.doesNotMatch(src, /(^|\n)\s*(import|export)\b[^;]*?from\s*['"]@allmaps\//, `${f} imports Allmaps statically`);
  }
  // Control: the search finds the dynamic imports it is meant to allow.
  const index = readFileSync(DIR + 'index.js', 'utf8');
  assert.match(index, /import\('@allmaps\/annotation'\)/);
  assert.match(index, /import\('@allmaps\/transform'\)/);
  // And the static-import pattern does match a static import.
  assert.match("import { x } from '@allmaps/transform';", /(^|\n)\s*(import|export)\b[^;]*?from\s*['"]@allmaps\//);
});

test('importing index.js loads nothing from Allmaps; the synchronous functions load nothing; the first georeference loads it once', async () => {
  assert.equal(georef.allmapsImportCount(), 0);
  const record = {
    direction: 'toWorld', transformation: 'polynomial', gcps: 3, annotationId: 'https://example.org/a',
    manifestId: null, canvasId: 'https://example.org/c', imageServiceId: 'https://example.org/i', space: 'image', title: null,
    software: georef.SOFTWARE,
  };
  georef.georefNote(record);
  georef.georefCitation(record);
  const g = { canvasId: 'https://example.org/c', imageServiceId: 'https://example.org/i', image: { width: 10, height: 10 }, canvas: null, mask: null };
  georef.matchesTarget(g, 'https://example.org/c');
  georef.containsRegion(g, { xywh: '1,1,2,2' }, { space: 'image' });
  assert.equal(georef.allmapsImportCount(), 0, 'still nothing loaded');
  // Control: using a georeference does load it (so the counter can move), and only once.
  const annotation = JSON.parse(readFileSync('test/fixtures/georef/bpl-rocque-annotation.json', 'utf8'));
  const loaded = await georef.readGeoreference(annotation);
  assert.equal(georef.allmapsImportCount(), 1);
  await georef.toWorld(loaded, { type: 'Point', coordinates: [5000, 4000] }, { space: 'image' });
  assert.equal(georef.allmapsImportCount(), 1);
});
