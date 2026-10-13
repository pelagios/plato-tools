// Chora is mounted into the main page (src/chora/app.js, mountChora), so every id it makes must be its
// own: each starts with `chora-` (the adoption panel's, src/chora/adopt-ui.js, with `adopt-`), and none is
// an id of the page it is mounted in (index.html and what the page's own scripts add to it). Read from the
// sources, so that an id added anywhere in them is held to it; the control: the scan finds the ids it must
// on both sides (the map, the save button, the adoption's search box; the page's file input and Scope's
// editor), so that an empty result could not pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
/**
 * The ids a source writes: in markup (id="…"), and set from script (.id = '…'; with `props`, { id: '…' },
 * as the main page's element helpers take them). Ids made of `${…}` are left out.
 */
const idsIn = (s, props = false) => [...s.matchAll(/\bid="([^"$]+)"/g), ...s.matchAll(/\.id = '([^']+)'/g), ...(props ? s.matchAll(/\bid: '([^']+)'/g) : [])].map((m) => m[1]);

test('every id Chora makes is its own: chora- (or adopt-, the adoption panel\'s), and none is the main page\'s', () => {
  const dir = new URL('../src/chora/', import.meta.url);
  const mine = readdirSync(dir).filter((f) => f.endsWith('.js')).flatMap((f) => idsIn(readFileSync(new URL(f, dir), 'utf8')).map((id) => [f, id]));
  const ids = mine.map(([, id]) => id);
  for (const id of ['chora-map', 'chora-save', 'chora-q', 'chora-phase', 'adopt-q']) assert.ok(ids.includes(id), `the scan finds ${id}`);
  // The timeline's hatching (card.js) is an SVG <pattern>'s, made unique by its kind.
  const own = (id) => id.startsWith('chora-') || id.startsWith('adopt-') || id.startsWith('tl-hatch-');
  assert.deepEqual(mine.filter(([, id]) => !own(id)), []);
  // The page's: its markup, and what its own scripts add to it (src/*.js, src/lib/, src/methodos/, src/krisis/).
  const scripts = ['../src/', '../src/lib/', '../src/methodos/', '../src/krisis/']
    .flatMap((d) => readdirSync(new URL(d, import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => read(d + f)));
  const page = new Set([...idsIn(read('../index.html')), ...scripts.flatMap((s) => idsIn(s, true))]);
  for (const id of ['chora', 'chora-root', 'picker', 'scope-editor-h']) assert.ok(page.has(id), `the page's ids are read: ${id}`);
  assert.deepEqual(ids.filter((id) => page.has(id)), []);
});
