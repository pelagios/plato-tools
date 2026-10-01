// Chora's basemaps (src/chora/basemaps.js): which sites each asks, so that the map's transformRequest
// allows those and no others, and the permission each needs (src/lib/permissions.js) covers every one;
// and what a drawing's note says of the basemap
// it was drawn on. Written for the pre-push review of 30 September 2026: each test failed before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtIn, fromPaste, subjectsOf, originsOf, styleOrigins, drawnOn } from '../src/chora/basemaps.js';
import { originsFor } from '../src/lib/permissions-core.js';
import { choraDrawingNote } from '../src/engine/words.js';

// CARTO's styles (fetched without a key, 30 September 2026) name their sources, glyphs and sprites on
// tiles.basemaps.cartocdn.com, not the style's own host, and their TileJSON the tiles on tiles-a to -d.
const CARTO_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const cartoLike = {
  version: 8,
  sources: { carto: { type: 'vector', url: 'https://tiles.basemaps.cartocdn.com/vector/carto.streets/v1/tiles.json' } },
  glyphs: 'https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf',
  sprite: 'https://tiles.basemaps.cartocdn.com/gl/positron-gl-style/sprite',
  layers: [],
};

test('each built-in basemap names every site it asks, and the one permission it needs covers them all', () => {
  const by = Object.fromEntries(builtIn().map((b) => [b.id, b]));
  for (const id of ['carto-positron', 'carto-voyager', 'carto-dark-matter']) {
    assert.deepEqual(originsOf(by[id]), ['https://basemaps.cartocdn.com', 'https://tiles.basemaps.cartocdn.com',
      'https://tiles-a.basemaps.cartocdn.com', 'https://tiles-b.basemaps.cartocdn.com', 'https://tiles-c.basemaps.cartocdn.com', 'https://tiles-d.basemaps.cartocdn.com'], id);
  }
  for (const id of ['ofm-liberty', 'ofm-bright', 'ofm-positron']) assert.deepEqual(originsOf(by[id]), ['https://tiles.openfreemap.org'], id);
  assert.deepEqual(originsOf(by.osm), ['https://tile.openstreetmap.org']);
  for (const b of builtIn().filter((x) => !x.local)) {
    const subjects = subjectsOf(b);
    assert.equal(subjects.length, 1, b.id);
    assert.deepEqual(originsFor(...subjects[0]), originsOf(b), `${b.id}'s permission covers every site it asks`);
  }
  assert.deepEqual(subjectsOf(by['natural-earth']), [], 'Natural Earth, from this site, needs none');
  // What CARTO's style names is within what CARTO's entry allows: the style's own host alone would not do.
  const named = styleOrigins(cartoLike, CARTO_STYLE);
  assert.deepEqual(named, ['https://tiles.basemaps.cartocdn.com']);
  assert.ok(named.every((o) => originsOf(by['carto-positron']).includes(o)));
  assert.ok(!named.includes(new URL(CARTO_STYLE).origin), 'the control: the style host is not among them');
});

test("a style's sites: its sources (TileJSON, tiles, data), glyphs and sprites, relative ones on the style's own site, each once", () => {
  const style = {
    version: 8,
    sources: {
      v: { type: 'vector', url: 'https://second.example.com/tiles.json' },
      r: { type: 'raster', tiles: ['https://a.tiles.example.net/{z}/{x}/{y}.png', 'https://b.tiles.example.net/{z}/{x}/{y}.png'] },
      g: { type: 'geojson', data: 'lakes.geojson' },
      inline: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      d: { type: 'raster', tiles: ['data:image/png;base64,AAAA'] },
    },
    glyphs: 'https://second.example.com/fonts/{fontstack}/{range}.pbf',
    sprite: [{ id: 'default', url: 'https://sprites.example.org/s' }, { id: 'x', url: './more' }],
    layers: [],
  };
  assert.deepEqual(styleOrigins(style, 'https://first.example.org/styles/style.json'),
    ['https://a.tiles.example.net', 'https://b.tiles.example.net', 'https://first.example.org', 'https://second.example.com', 'https://sprites.example.org']);
  assert.deepEqual(styleOrigins({ version: 8, sources: {}, layers: [] }, 'https://first.example.org/s.json'), [], 'a style that names nothing');
});

test('a pasted basemap asks its own site until its style is read; then every site its style names', () => {
  const b = fromPaste('https://first.example.org/styles/style.json?key=K');
  assert.deepEqual(originsOf(b), ['https://first.example.org']);
  const read = { ...b, origins: ['https://first.example.org', 'https://second.example.com'] };
  assert.deepEqual(originsOf(read), ['https://first.example.org', 'https://second.example.com']);
  assert.deepEqual(subjectsOf(read), [['basemap', 'https://first.example.org'], ['basemap', 'https://second.example.com']], 'one permission for each site');
  assert.ok(!JSON.stringify(subjectsOf(read)).includes('key=K'), 'permissions name sites, not the address and its key');
});

test("a drawing's note names a built-in basemap, never a pasted one's site", () => {
  const p = fromPaste('https://private-tiles.secret-host.example/{z}/{x}/{y}.png?token=T');
  const note = choraDrawingNote({ basemap: drawnOn(p), zoom: 9 });
  assert.equal(note, 'Drawn by hand on a basemap pasted by the contributor at zoom 9 in PLATO tools (Chora)');
  assert.ok(!/secret-host|token/.test(note));
  const s = fromPaste('https://styles.secret-host.example/style.json');
  assert.ok(!choraDrawingNote({ basemap: drawnOn(s) }).includes('secret-host'));
  // The controls: a built-in basemap is named, and Natural Earth as before.
  const by = Object.fromEntries(builtIn().map((b) => [b.id, b]));
  assert.equal(choraDrawingNote({ basemap: drawnOn(by['ofm-liberty']), zoom: 5 }), 'Drawn by hand on the OpenFreeMap Liberty basemap at zoom 5 in PLATO tools (Chora)');
  assert.equal(choraDrawingNote({ basemap: drawnOn(by['natural-earth']) }), 'Drawn by hand on the Natural Earth basemap in PLATO tools (Chora)');
});
