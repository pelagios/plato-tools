// The finer coast under the shaded relief (#39): at zoom 7 and closer Natural Earth's 50m coast is coarser than the
// relief, so the relief showed in the sea. public/basemap/coast-fine.geojson (scripts/build-basemap.mjs: Natural Earth's
// 10m land, public domain, clipped to the relief's bounds) is drawn with the relief on, the sea over the relief. Each
// check was seen to fail with its subject broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { composeMap, neLayers } from '../src/engine/chora/export/compose.js';
import { RELIEF, COAST, coastStyle, coastColours } from '../src/engine/chora/relief.js';
import { estimate } from '../src/engine/chora/export/labels.js';
import { NE_STYLE, DATA } from './chora-export-fixture.js';

const COASTLINE = JSON.parse(readFileSync('public/basemap/coast-fine.geojson', 'utf8'));
const LAND50 = JSON.parse(readFileSync('public/basemap/land.geojson', 'utf8'));
const ringIn = (pt, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c; } return c; };
const inside = (pt, fc, part) => fc.features.some((f) => (!part || f.properties.part === part)
  && (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).some((rings) => rings.reduce((a, r) => (ringIn(pt, r) ? !a : a), false)));

test('the finer coast: Natural Earth 10m land and the sea, within the relief\'s bounds, where the 50m coast and the sea differ', () => {
  assert.equal(COAST.path, 'basemap/coast-fine.geojson'); assert.equal(COAST.minzoom, 7);
  const parts = COASTLINE.features.map((f) => f.properties.part);
  assert.equal(parts.filter((x) => x === 'sea').length, 1, 'one sea feature'); assert.ok(parts.filter((x) => x === 'land').length > 1 && parts.every((x) => x === 'land' || x === 'sea'), 'land in pieces');
  const [w, s, e, n] = RELIEF.bounds;
  const flat = COASTLINE.features.flatMap((f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).flat(2));
  // flat is a list of [x, y] pairs (rings flattened to depth 2).
  assert.ok(flat.length > 100000, `the 10m coast is detailed (${flat.length} vertices)`);
  assert.ok(flat.every(([x, y]) => x >= w && x <= e && y >= s && y <= n), 'within the relief\'s bounds');
  // Athens is land and the Saronic Gulf sea, in the finer coast.
  assert.equal(inside([23.72, 37.97], COASTLINE, 'land'), true); assert.equal(inside([23.72, 37.97], COASTLINE, 'sea'), false);
  assert.equal(inside([23.4, 37.7], COASTLINE, 'sea'), true); assert.equal(inside([23.4, 37.7], COASTLINE, 'land'), false);
  // The reason for it: a point the 50m land has as land (the strait off Corfu) that the finer coast has as sea. Both are
  // asserted, so a finer coast that is no different, or a 50m land that has changed, fails here.
  assert.equal(inside([20, 39.8], LAND50), true, 'the 50m land has it as land');
  assert.equal(inside([20, 39.8], COASTLINE, 'sea'), true, 'the finer coast has it as sea');
});

test('the finer coast\'s colours are the style\'s own land and ocean', () => {
  assert.deepEqual(coastColours(NE_STYLE), { land: '#f4f2ec', sea: '#d5e3ea' });
  const st = coastStyle(NE_STYLE);
  assert.deepEqual(st.layers.map((l) => l.id), ['coast-land', 'coast-sea']);
  assert.equal(st.layers[1].paint['fill-color'], NE_STYLE.layers.find((l) => l.id === 'ocean').paint['background-color']);
  assert.deepEqual(coastColours({ layers: [] }), { land: '#f4f2ec', sea: '#d5e3ea' }, 'the defaults when a style has neither');
});

const SMALL = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { part: 'land' }, geometry: { type: 'Polygon', coordinates: [[[20.5, 38.5], [21.5, 38.5], [21.5, 39.5], [20.5, 39.5], [20.5, 38.5]]] } },
  { type: 'Feature', properties: { part: 'sea' }, geometry: { type: 'Polygon', coordinates: [[[19, 37], [23, 37], [23, 41], [19, 41], [19, 37]], [[20.5, 38.5], [20.5, 39.5], [21.5, 39.5], [21.5, 38.5], [20.5, 38.5]]] } }] };
const RELIEF_PNG = { href: 'data:image/png;base64,iVBORw0KGgo=' };
const map = (over) => composeMap({
  view: { center: [21.25, 39], zoom: 8, width: 600, height: 400 }, width: 600, projection: 'mercator',
  background: { kind: 'vector', style: NE_STYLE, data: DATA, layers: neLayers(NE_STYLE, { modern: true }) },
  places: [], furniture: { north: false, inset: null, title: '', attribution: [] }, measure: estimate, title: 't', lang: 'en', settings: {}, dc: {}, ...over,
});
const ids = (svg) => [...svg.matchAll(/<g id="([^"]+)"/g)].map((m) => m[1]);

test('a map with the relief at zoom 8 draws the finer land under the country tint, the relief, the finer sea over it, then the rivers: the screen\'s order', () => {
  const svg = map({ relief: RELIEF_PNG, coast: SMALL }).svg;
  const g = ids(svg);
  const at = (id) => g.indexOf(id);
  for (const id of ['ne-coast-land', 'ne-country-tint', 'relief', 'ne-coast-sea', 'ne-rivers']) assert.ok(at(id) >= 0, `${id} is in the file (${g.join(' ')})`);
  assert.ok(at('ne-land') < at('ne-coast-land') && at('ne-coast-land') < at('ne-country-tint') && at('ne-country-tint') < at('relief')
    && at('relief') < at('ne-coast-sea') && at('ne-coast-sea') < at('ne-rivers'), g.join(' '));
  // The sea is a path with a hole for the land (two rings), in the ocean's colour.
  const sea = svg.split('id="ne-coast-sea"')[1].split('</g>')[0];
  assert.match(sea, /fill="#d5e3ea"/); assert.equal((sea.match(/M/g) || []).length, 2, 'two rings: the sea\'s edge and the land\'s');
});

test('without the relief, below zoom 7, or without the coast, the finer coast is not drawn and the background is whole', () => {
  const base = map({ relief: RELIEF_PNG, coast: SMALL });
  assert.ok(ids(base.svg).includes('ne-coast-sea'), 'control: it is drawn when all three hold');
  for (const [name, over] of [['no relief', { relief: null, coast: SMALL }], ['zoom 6', { relief: RELIEF_PNG, coast: SMALL, view: { center: [21.25, 39], zoom: 6, width: 600, height: 400 } }], ['no coast', { relief: RELIEF_PNG, coast: null }]]) {
    const g = ids(map(over).svg);
    assert.ok(!g.some((x) => x.includes('coast')), name);
    assert.ok(g.includes('ne-land'), `${name}: Natural Earth is drawn (control)`);
    assert.ok(!g.includes('background-overlay'), name);
  }
});
