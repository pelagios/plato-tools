// Making an open map (#37): the tiles a picture background is made of, within the budget and in their places;
// the rows an equirectangular picture takes from a Mercator one; the places in view, capped; each place as the
// export reads it from its record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mercator, equirectangular, exportView, mercX, mercY } from '../src/engine/chora/export/project.js';
import { tilePlan, rowSources, tileUrl, TILE_BUDGET } from '../src/engine/chora/export/tiles.js';
import { inView, exportPlace, labelClassOf, recordSites, PLACE_CAP } from '../src/engine/chora/export/places.js';
import { attestationLicences, licenceTerms } from '../src/engine/agora/licence.js';

const VIEW = { center: [23.7, 37.98], zoom: 6.3, width: 1100, height: 760 };

test('a picture\'s tiles: as fine as the map asks, up to the provider\'s zoom, within the budget, covering the map, each where its corner projects', () => {
  const merc = mercator(exportView(VIEW, 2200));
  const p = tilePlan(merc, { maxzoom: 11 });
  assert.equal(p.z, Math.ceil(p.ideal - 1e-9)); assert.equal(p.coarser, false); assert.ok(p.tiles.length <= TILE_BUDGET && p.tiles.length > 4, String(p.tiles.length));
  // Covering: every corner of the map is inside some tile.
  for (const [x, y] of [[0, 0], [merc.width - 1, 0], [0, merc.height - 1], [merc.width - 1, merc.height - 1]]) {
    assert.ok(p.tiles.some((t) => x >= t.left && x < t.left + t.size && y >= t.top && y < t.top + t.size), `${x},${y}`);
  }
  // A tile is where its own corner projects.
  const t = p.tiles[3], n = 2 ** t.z;
  const lon = (t.x / n) * 360 - 180, lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * t.y) / n))) * 180) / Math.PI;
  const [x, y] = merc.project([lon, lat]);
  assert.ok(Math.abs(x - t.left) < 1e-6 && Math.abs(y - t.top) < 1e-6, `${x},${y} vs ${t.left},${t.top}`);
  assert.equal(tileUrl('https://t.example.org/{z}/{x}/{y}.png', t), `https://t.example.org/${t.z}/${t.x}/${t.y}.png`);
  // The provider's own greatest zoom: no finer.
  assert.equal(tilePlan(merc, { maxzoom: 5 }).z, 5);
  // Over the budget: a coarser zoom, and said so; never below the provider's least.
  const small = tilePlan(merc, { maxzoom: 11, budget: 6 });
  assert.equal(small.coarser, true); assert.ok(small.tiles.length <= 6 && small.z < p.z);
  const none = tilePlan(merc, { minzoom: 9, maxzoom: 11, budget: 6 });
  assert.equal(none.tooMany, true); assert.deepEqual(none.tiles, []);
});

test('equirectangular from Mercator: each row taken from the row of its own latitude, so the middle row is not the middle', () => {
  const v = exportView(VIEW, 1100), merc = mercator(v), equi = equirectangular(v);
  const rows = rowSources(merc, equi);
  assert.equal(rows.length, equi.height);
  assert.ok(rows[0] >= 0 && rows[0] < 2 && rows[rows.length - 1] > merc.height - 2 && rows[rows.length - 1] <= merc.height, `${rows[0]} … ${rows[rows.length - 1]}`);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i] > rows[i - 1]);
  const mid = rows[Math.floor(equi.height / 2)];
  assert.ok(Math.abs(mid - merc.height / 2) > 2, 'Mercator stretches the north: the middle latitude is above the middle row');
  const [, s, , n] = equi.bounds;
  assert.ok(Math.abs(mid - merc.project([0, (s + n) / 2])[1]) < (merc.height / equi.height) * 2);
});

const overview = { type: 'FeatureCollection', features: [[23.7, 37.98, 'a'], [10, 10, 'b'], [24.1, 38.2, 'c'], [179.5, 0, 'd'], [-179.5, 0, 'e']].map(([x, y, id]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: { id, label: id } })) };
test('the places in view, in the dataset\'s order, capped with how many there were; across 180° too', () => {
  assert.deepEqual(inView(overview, [20, 35, 26, 40]), { ids: ['a', 'c'], total: 2, capped: false });
  assert.deepEqual(inView(overview, [20, 35, 26, 40], 1), { ids: ['a'], total: 2, capped: true });
  assert.deepEqual(inView(overview, [179, -5, -179, 5]).ids, ['d', 'e']);
  assert.equal(PLACE_CAP, 200);
});

test('a place as the export reads it: no denied or withdrawn location, its names, its point, its class, its records, and its sources for the licence', () => {
  const rec = { '@id': 'https://example.org/p/1', label: 'Piraeus', attestations: [
    { '@id': 'https://example.org/a/1', names: [{ toponym: 'Πειραιεύς', language: 'grc' }], geometries: [{ geojson: { type: 'Point', coordinates: [23.64, 37.94] }, spatialPrecision: ['approximate'], precisionKm: [3] }],
      sources: [{ title: 'Pleiades', licence: 'https://creativecommons.org/licenses/by/3.0/' }], types: [{ label: 'port' }] },
    { '@id': 'https://example.org/a/2', negated: true, geometries: [{ geojson: { type: 'Point', coordinates: [30, 30] } }] },
    { '@id': 'https://example.org/a/3', geometries: [{ geojson: { type: 'Point', coordinates: [40, 40] } }], sources: [{ title: 'Withdrawn source', licence: 'https://example.org/unknown' }] },
  ] };
  const p = exportPlace(rec, { id: rec['@id'], withdrawn: new Map([['https://example.org/a/3', 'retracted']]), brief: { reprPoint: [23.64, 37.94] }, identities: { exact: ['https://pleiades.stoa.org/places/580048'], linked: [] } });
  assert.deepEqual(p.geometries.map((g) => g.geojson.coordinates), [[23.64, 37.94]], 'not the denied one, nor the withdrawn one');
  assert.deepEqual(p.geometries[0].precision, 'approximate'); assert.equal(p.geometries[0].precisionKm, 3);
  assert.deepEqual(p.names, [{ toponym: 'Πειραιεύς', language: 'grc', script: null, romanized: null }]);
  assert.deepEqual(p.point, [23.64, 37.94]); assert.equal(p.cls, 'settlement');
  assert.deepEqual(p.records, ['https://pleiades.stoa.org/places/580048']);
  // The sources as the licence reads them: Pleiades's CC BY 3.0 asks credit of a CC0 map; the withdrawn one's not read.
  const reasons = p.licensing.flatMap((a) => [...attestationLicences(a, licenceTerms('https://creativecommons.org/publicdomain/zero/1.0/')).reasons.keys()]);
  assert.deepEqual(reasons, ['attribution']);
  assert.equal(p.licensing.length, 2);
  assert.deepEqual([labelClassOf(['sea']), labelClassOf(['Roman province']), labelClassOf(['settlement'])], ['water', 'region', 'settlement']);
  assert.deepEqual(recordSites([p, { records: ['https://w3id.org/whg/id/place:pl:1', 'https://pleiades.stoa.org/places/1', 'https://example.org/gaz/7'] }]),
    [{ site: 'Pleiades', count: 2 }, { site: 'example.org', count: 1 }, { site: 'World Historical Gazetteer', count: 1 }]);
});
