// How well a location is known, on Chora's map (Issue #16): the circle of precisionKm, measured on the
// ground and on the screen at several latitudes and zooms; the marks of spatialPrecision, one shape per
// value PLATO defines; the key; and the card's words. Pure: no page, no map. Every absence asserted here
// has a presence beside it, so that none of these checks could pass by drawing nothing.
import { PLATO_REPO } from './paths.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { circleAround, EARTH_KM } from '../src/engine/chora/geo.js';
import { viewPlace } from '../src/engine/chora/view.js';
import { PRECISIONS, PRECISION_WORDS, drawMark, vagueFeatures, keyRows, isPrecision } from '../src/chora/vague.js';
import { geometryItem, precisionWords } from '../src/chora/card.js';

const RAD = Math.PI / 180;
// The great-circle distance by the haversine formula, worked independently of circleAround's own.
function haversineKm([lon1, lat1], [lon2, lat2]) {
  const a = Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(a));
}
// Web Mercator, as MapLibre draws it: a world 512 pixels wide at zoom 0.
const mercator = ([lon, lat], z) => {
  const w = 512 * 2 ** z;
  return [((lon + 180) / 360) * w, (w / 2) * (1 - Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) / Math.PI)];
};
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/chora/place-centric-vagueness.json', import.meta.url)));
const viewOf = (slug) => viewPlace(FIXTURE.spatialEntities.find((p) => p['@id'].endsWith(`/${slug}`)));

test('a circle of precisionKm: every point of it that many km from its centre on the ground, at the equator, 30°, 60° and 80°, north and south', () => {
  for (const lat of [0, 30, 60, 80, -45, -80]) for (const km of [0.01, 1, 25, 500]) {
    const c = circleAround([12.5, lat], km);
    const ring = c.coordinates[0];
    assert.equal(c.type, 'Polygon');
    assert.equal(ring.length, 65, '64 points and the first again');
    assert.deepEqual(ring[64], ring[0], 'closed');
    for (const p of ring) assert.ok(Math.abs(haversineKm([12.5, lat], p) - km) / km < 1e-9, `${km} km at ${lat}°: ${haversineKm([12.5, lat], p)}`);
    // The first point is due north, by km/R radians of latitude.
    assert.ok(Math.abs(ring[0][1] - lat - (km / EARTH_KM) / RAD) < 1e-9 && Math.abs(ring[0][0] - 12.5) < 1e-9, `north at ${lat}°`);
  }
});

test('on the screen the circle is as many pixels across as its km at that latitude and zoom: twice as large a zoom up, and larger toward a pole', () => {
  // The radius in pixels a correct circle has: km / R radians of latitude, which Mercator stretches by
  // sec(latitude), in a world 512 × 2^z pixels round.
  const want = (km, lat, z) => (km / EARTH_KM / Math.cos(lat * RAD)) * (512 * 2 ** z) / (2 * Math.PI);
  const radii = {};
  for (const lat of [0, 30, 60]) for (const z of [6, 9]) {
    const centre = [10, lat], ring = circleAround(centre, 25).coordinates[0];
    const [cx, cy] = mercator(centre, z);
    // North (point 0), east (16), south (32) and west (48).
    const r = [0, 16, 32, 48].map((i) => { const [x, y] = mercator(ring[i], z); return Math.hypot(x - cx, y - cy); });
    for (const x of r) assert.ok(Math.abs(x / want(25, lat, z) - 1) < 0.01, `25 km at ${lat}°, zoom ${z}: ${x} px, wanted ${want(25, lat, z)}`);
    radii[`${lat}/${z}`] = r[1];
  }
  // A fixed radius in pixels would fail both of these.
  assert.ok(Math.abs(radii['30/9'] / radii['30/6'] - 8) < 0.01, 'three zooms up, eight times as large');
  assert.ok(Math.abs(radii['60/6'] / radii['0/6'] - 2) < 0.01, 'at 60° twice as large as at the equator, as Mercator draws the ground there');
});

test('a circle across the antimeridian runs on past 180 without a jump; one around a pole is closed through it', () => {
  const ring = circleAround([179.9, -17], 50).coordinates[0];
  for (let i = 1; i < ring.length; i++) assert.ok(Math.abs(ring[i][0] - ring[i - 1][0]) < 5, `no jump at ${i}`);
  assert.ok(ring.some((p) => p[0] > 180) && ring.some((p) => p[0] < 180), 'both sides of 180');
  for (const p of ring) assert.ok(Math.abs(haversineKm([179.9, -17], p) - 50) < 1e-6);
  // An ordinary circle has no pole in it, and an arctic one does.
  assert.ok(!circleAround([0, 60], 500).coordinates[0].some((p) => Math.abs(p[1]) === 90));
  const arctic = circleAround([0, 89], 500).coordinates[0];
  assert.ok(arctic.filter((p) => p[1] === 90).length === 2, 'two points at the north pole');
  assert.deepEqual(arctic[arctic.length - 1], arctic[0]);
  const antarctic = circleAround([0, -88], 400).coordinates[0];
  assert.ok(antarctic.filter((p) => p[1] === -90).length === 2, 'two at the south pole');
});

test('no circle for a radius that is not a number above 0, or no centre', () => {
  assert.ok(circleAround([0, 0], 1), 'the control: 1 km draws');
  for (const km of [0, -1, NaN, Infinity, null, '5']) assert.equal(circleAround([0, 0], km), null, String(km));
  for (const c of [null, [0], ['a', 1], [NaN, 0]]) assert.equal(circleAround(c, 5), null, JSON.stringify(c));
});

test('vagueFeatures: a mark for each precision said, on its point or a line\'s middle; a circle only around a point with precisionKm', () => {
  const of = (slug) => vagueFeatures(viewOf(slug)).features;
  const marks = (fs) => fs.filter((f) => f.geometry.type === 'Point'), circles = (fs) => fs.filter((f) => f.geometry.type === 'Polygon');
  // Exact, no radius: its mark, and no circle.
  const exact = of('surveyed-cross');
  assert.deepEqual(marks(exact).map((f) => [f.properties.precision, f.geometry.coordinates]), [['exact', [-1.2577, 51.752]]]);
  assert.equal(circles(exact).length, 0);
  // Each of the others with a radius: its mark, and a circle of its km around the point.
  for (const [slug, p, km] of [['roughly-north', 'approximate', 25], ['one-of-several', 'uncertain', 5], ['old-ford', 'historical_approximate', 2]]) {
    const fs = of(slug);
    assert.deepEqual(marks(fs).map((f) => f.properties.precision), [p], slug);
    assert.equal(circles(fs).length, 1, slug);
    const [c] = circles(fs), centre = marks(fs)[0].geometry.coordinates;
    assert.equal(c.properties.km, km);
    assert.ok(Math.abs(haversineKm(centre, c.geometry.coordinates[0][7]) - km) < 1e-9);
  }
  // A line: its mark half way along it, and no circle (its precisionKm would be its boundary's).
  const road = of('vague-road');
  assert.equal(marks(road).length, 1); assert.equal(circles(road).length, 0);
  assert.equal(marks(road)[0].properties.precision, 'approximate');
  // Not said: nothing at all, beside a place that has something.
  assert.deepEqual(of('unsaid-well'), []);
  // Every precision in the file is marked, once each place.
  assert.deepEqual(FIXTURE.spatialEntities.flatMap((p) => marks(vagueFeatures(viewPlace(p)).features).map((f) => f.properties.precision)).sort(),
    ['approximate', 'approximate', 'exact', 'historical_approximate', 'uncertain']);
  // A MultiPoint: a mark and a circle at each point; a polygon with a radius, its mark and no circle;
  // a status carried (a denied one is drawn faint by the map); a precision PLATO does not define, no mark.
  const v = { geometries: [
    { geojson: { type: 'MultiPoint', coordinates: [[0, 0], [1, 1]] }, precision: 'uncertain', precisionKm: 3, status: 'denied' },
    { geojson: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] }, precision: 'exact', precisionKm: 1, status: 'asserted' },
    { geojson: { type: 'Point', coordinates: [5, 5] }, precision: 'roughly', precisionKm: null, status: 'asserted' },
  ] };
  const fs = vagueFeatures(v).features;
  assert.deepEqual(marks(fs).map((f) => [f.properties.precision, f.properties.status, f.geometry.coordinates]),
    [['uncertain', 'denied', [0, 0]], ['uncertain', 'denied', [1, 1]], ['exact', 'asserted', [1, 1]]]);
  assert.deepEqual(circles(fs).map((f) => [f.properties.status, f.properties.km]), [['denied', 3], ['denied', 3]]);
  assert.deepEqual(vagueFeatures(null).features, []);
});

// A 2D context that records what is drawn, to compare the marks without a canvas.
function recorder() {
  const ops = [];
  return new Proxy({ ops }, {
    get(t, k) { if (k === 'ops') return ops; return (...a) => { ops.push([k, ...a.map((x) => (typeof x === 'number' ? +x.toFixed(2) : x))]); }; },
    set(t, k, v) { ops.push([`=${String(k)}`, v]); return true; },
  });
}
test('each precision PLATO defines has a mark of its own, drawn by its shape, with no colour but ink and its white casing', () => {
  const schema = JSON.parse(readFileSync(`${PLATO_REPO}/schemas/plato.schema.json`, 'utf8'));
  const find = (o) => (o && typeof o === 'object' ? (o.spatialPrecision?.items?.enum || Object.values(o).map(find).find(Boolean)) : null);
  const plato = find(schema);
  assert.ok(Array.isArray(plato) && plato.length >= 4, 'the schema\'s values found');
  assert.deepEqual([...PRECISIONS].sort(), [...plato].sort(), 'every value the pinned schema defines, and only those');
  const drawn = {};
  for (const p of plato) {
    const ctx = recorder();
    assert.equal(drawMark(ctx, p), true, p);
    assert.ok(ctx.ops.some(([k]) => k === 'stroke'), `${p} draws`);
    const colours = new Set(ctx.ops.filter(([k]) => k === '=strokeStyle' || k === '=fillStyle').map(([, v]) => v));
    assert.deepEqual([...colours].sort(), ['#1b1f24', '#ffffff'], `${p}: ink and casing only`);
    drawn[p] = JSON.stringify(ctx.ops);
  }
  assert.equal(new Set(Object.values(drawn)).size, plato.length, 'no two alike');
  for (const bad of ['roughly', 'constructor', '', null, 5]) { const ctx = recorder(); assert.equal(drawMark(ctx, bad), false); assert.equal(ctx.ops.length, 0, String(bad)); }
  assert.equal(isPrecision('toString'), false);
});

test('the key names every precision in words, then the circle and no mark', () => {
  const rows = keyRows();
  assert.deepEqual(rows.map((r) => r.key), [...PRECISIONS, 'circle', 'none']);
  for (const r of rows) assert.ok(r.name && r.gloss, r.key);
  assert.equal(rows.find((r) => r.key === 'historical_approximate').name, 'Historical approximate');
});

test('the card names the precision in words, with PLATO\'s gloss, and how far out it may be', () => {
  const g = (o) => ({ geojson: { type: 'Point' }, role: null, precision: null, precisionKm: null, timespan: null, status: 'asserted', ...o });
  assert.equal(precisionWords(g({ precision: 'approximate', precisionKm: 25 })), ', approximate <span class="muted">(estimated from maps or descriptions)</span>, to within 25 km');
  assert.equal(precisionWords(g({ precision: 'exact', precisionKm: 0.01 })), ', exact <span class="muted">(surveyed, or by GPS)</span>, to within 10 m');
  assert.equal(precisionWords(g({ precision: 'uncertain' })), ', uncertain <span class="muted">(one of several possible locations)</span>');
  assert.match(precisionWords(g({ precision: 'historical_approximate' })), /^, historical approximate <span class="muted">\(from historical sources, imprecise by nature\)<\/span>$/);
  // A value PLATO does not define, as written, and never as markup; nothing said, nothing written.
  assert.equal(precisionWords(g({ precision: 'more_or_less_<b>' })), ', more or less &lt;b&gt;');
  assert.equal(precisionWords(g({})), '');
  // From the view, through the card's line for the location.
  assert.match(geometryItem(viewOf('old-ford').geometries[0]), /^Point, historical approximate <span class="muted">\(from historical sources, imprecise by nature\)<\/span>, to within 2 km$/);
  assert.equal(geometryItem(viewOf('unsaid-well').geometries[0]), 'Point');
  for (const p of PRECISIONS) assert.ok(PRECISION_WORDS[p], p);
});
