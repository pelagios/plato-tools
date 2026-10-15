// Making an open map from Chora's view (#37): the pure engine in src/engine/chora/export/. The projections are
// held to MapLibre's own (its MercatorCoordinate, the arithmetic map.project() does on a view with no tilt);
// clipping, label placement, the licence and the Commons page to tables and cases written out here; the SVG to
// a golden file (test/fixtures/chora/export/), made from a fixed map and read through by hand when it was
// first written: a change to it is a change to what the tools write, to be looked at, not regenerated unseen
// (UPDATE_GOLDEN=1 writes it again). Each check here was seen to fail with its subject broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { zlibSync } from 'fflate';
import { SaxesParser } from 'saxes';
import { MercatorCoordinate } from 'maplibre-gl';
import { mercator, equirectangular, exportView, projectionOf, TILE } from '../src/engine/chora/export/project.js';
import { clipLine, clipRing, thin, overlaps } from '../src/engine/chora/export/clip.js';
import { placeLabels, estimate, labelText, nameChoices, languagesOf, POSITIONS } from '../src/engine/chora/export/labels.js';
import { svgDocument, el, settingsIn, num } from '../src/engine/chora/export/svg.js';
import { composeMap, neLayers, NE_PLAIN } from '../src/engine/chora/export/compose.js';
import { styleNodes, colour } from '../src/engine/chora/export/vector.js';
import { scaleOf, niceLength } from '../src/engine/chora/export/furniture.js';
import { composeLicence, MAP_LICENCES, OWN_DEFAULT, suggestedStatement } from '../src/engine/chora/export/licence.js';
import { filePage, uploadUrl, authorWords, commonsName, MAX_LINK } from '../src/engine/chora/export/commons.js';
import { withMeta, readPng, chunksOf, crc32 } from '../src/engine/chora/export/png-meta.js';
import { markShapes } from '../src/engine/chora/marks.js';
import { rightsOf } from '../src/engine/chora/rights.js';
import { keyRows } from '../src/chora/vague.js';
import { NE_STYLE, DATA, LAND, goldenMap, solidPng } from './chora-export-fixture.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---- Projections ---------------------------------------------------------------------------------

// What MapLibre's map.project() gives on a view with no tilt or turn: the place's Mercator coordinate less the
// centre's, times the world's size (512 × 2^zoom), plus half the view. MercatorCoordinate is MapLibre's own.
function maplibreProject(view, lngLat) {
  const world = TILE * 2 ** view.zoom, c = MercatorCoordinate.fromLngLat(view.center), p = MercatorCoordinate.fromLngLat(lngLat);
  return [(p.x - c.x) * world + view.width / 2, (p.y - c.y) * world + view.height / 2];
}
const VIEWS = [
  { center: [23.7, 37.98], zoom: 6.3, width: 1100, height: 760 },      // the Aegean
  { center: [-3.2, 55.95], zoom: 9.75, width: 900, height: 600 },      // Edinburgh, further north
  { center: [12.5, 41.9], zoom: 3.1, width: 1400, height: 900 },       // the Mediterranean
  { center: [0, 0], zoom: 0, width: 512, height: 512 },                // the whole world
];
const PLACES = [[23.72, 37.97], [22.0, 39.5], [-3.19, 55.95], [12.49, 41.89], [26.0, 35.3], [-170, 10], [179.9, -12]];

test('Web Mercator projects every place where MapLibre would draw it, on four fixed views, and back', () => {
  let checked = 0;
  for (const view of VIEWS) {
    const m = mercator(view);
    for (const p of PLACES) {
      const [x, y] = m.project(p), [mx, my] = maplibreProject(view, p);
      const world = TILE * 2 ** view.zoom;
      // On the copy of the world nearest the centre (MapLibre's own map.project gives the one the view is on).
      const dx = ((x - mx) % world + world) % world;
      assert.ok(near(Math.min(dx, world - dx), 0, 1e-6) && near(y, my, 1e-6), `${JSON.stringify(view.center)} z${view.zoom} ${p}: ${x},${y} vs ${mx},${my}`);
      const [lon, lat] = m.unproject([x, y]);
      assert.ok(near(((lon - p[0] + 540) % 360) - 180, 0, 1e-7) && near(lat, p[1], 1e-7), `back: ${lon},${lat} vs ${p}`);
      checked++;
    }
  }
  assert.equal(checked, VIEWS.length * PLACES.length);
  // The world view's corners are the world's: the control that the arithmetic is the projection's, not a copy of the test's.
  const w = mercator(VIEWS[3]);
  assert.deepEqual(w.project([0, 0]).map((v) => Math.round(v)), [256, 256]);
  assert.ok(near(w.bounds[0], -180, 1e-9) && near(w.bounds[2], 180, 1e-9) && near(w.bounds[3], 85.0511, 1e-4), w.bounds.join());
});

test('a map made wider covers the same ground: its zoom raised by the ratio, its corners the view\'s', () => {
  const v = VIEWS[0], e = exportView(v, 2200);
  assert.equal(e.width, 2200); assert.equal(e.height, 1520); assert.ok(near(e.zoom, v.zoom + 1, 1e-12));
  const a = mercator(v).bounds, b = mercator(e).bounds;
  a.forEach((x, i) => assert.ok(near(x, b[i], 1e-9), `${a} vs ${b}`));
});

test('equirectangular: the same bounds, longitude and latitude each in proportion, true to scale on its middle parallel', () => {
  const v = VIEWS[0], m = mercator(v), q = equirectangular(v);
  assert.deepEqual(q.bounds, m.bounds);
  const [w, s, e, n] = q.bounds;
  assert.deepEqual(q.project([w, n]).map((x) => Math.round(x * 1e6) / 1e6), [0, 0]);
  assert.deepEqual(q.project([e, s]).map((x) => Math.round(x)), [q.width, q.height]);
  // In proportion: the middle of the bounds is the middle of the map (in Mercator it is not: the control).
  const mid = q.project([(w + e) / 2, (s + n) / 2]);
  assert.ok(near(mid[0], q.width / 2, 1e-6) && near(mid[1], q.height / 2, 1e-6), mid.join());
  assert.ok(!near(m.project([(w + e) / 2, (s + n) / 2])[1], m.height / 2, 0.5), 'Mercator is not in proportion in latitude');
  // True to scale on the middle parallel: a pixel is as long east-west as north-south there.
  assert.ok(near(q.metresPerPixel(q.standard), q.metresPerPixelY, q.metresPerPixelY / q.height), `${q.metresPerPixel(q.standard)} vs ${q.metresPerPixelY}`);   // to the height's rounding
  assert.throws(() => projectionOf('mollweide', v), /not a projection/);
});

// ---- Clipping ------------------------------------------------------------------------------------

test('clipping: a line cut where it leaves the map and starts again where it comes back; an area cut to the map; nothing of what is outside', () => {
  const box = [0, 0, 100, 100];
  const pieces = clipLine([[-50, 50], [50, 50], [150, 50], [150, 80], [50, 80]], box);
  assert.deepEqual(pieces, [[[0, 50], [50, 50], [100, 50]], [[100, 80], [50, 80]]]);
  assert.deepEqual(clipLine([[10, 10], [90, 90]], box), [[[10, 10], [90, 90]]], 'a line inside comes back whole');
  assert.deepEqual(clipLine([[50, 50], [150, 50], [50, 50]], box), [[[50, 50], [100, 50]], [[100, 50], [50, 50]]], 'out and back at the same point: two pieces, not one');
  assert.deepEqual(clipLine([[-10, -10], [-20, 50]], box), [], 'one outside, as nothing');
  const ring = clipRing([[-50, -50], [50, -50], [50, 50], [-50, 50], [-50, -50]], box);
  assert.deepEqual(ring, [[0, 0], [50, 0], [50, 50], [0, 50], [0, 0]]);
  assert.equal(clipRing([[200, 200], [300, 200], [300, 300], [200, 200]], box), null);
  // Thinning keeps the ends, and drops what is closer than the tolerance.
  assert.deepEqual(thin([[0, 0], [0.1, 0], [0.2, 0], [5, 0], [5.1, 0]], 0.3), [[0, 0], [5, 0], [5.1, 0]]);
});

// ---- Labels --------------------------------------------------------------------------------------

const CLUSTER = Array.from({ length: 14 }, (_, i) => ({ id: `p${i}`, text: ['Athenae', 'Piraeus', 'Eleusis', 'Megara', 'Salamis', 'Aegina', 'Marathon', 'Thebae', 'Plataeae', 'Corinthus', 'Sicyon', 'Argos', 'Mycenae', 'Tiryns'][i],
  x: 300 + (i % 4) * 46 + (i * 7) % 13, y: 220 + Math.floor(i / 4) * 34 + (i * 11) % 9, size: 13, r: 4, cls: 'settlement' }));
test('labels are placed the same way each time, never overlapping one another, a mark or the furniture, and inside the map', () => {
  const dots = CLUSTER.map((c) => [c.x - 5, c.y - 5, c.x + 5, c.y + 5]);
  const furniture = [[0, 520, 260, 600]];
  const opts = { obstacles: [...dots, ...furniture], bounds: [800, 600], measure: estimate };
  const a = placeLabels(CLUSTER, opts), b = placeLabels(CLUSTER.map((c) => ({ ...c })), opts);
  assert.deepEqual(a, b, 'deterministic');
  assert.equal(a.length, CLUSTER.length);
  const free = a.filter((l) => !l.overlaps);
  assert.ok(free.length >= 10,`${free.length} of ${a.length} placed without overlap`);
  for (const l of free) {
    for (const o of free) if (o !== l) assert.ok(!overlaps(l.box, o.box), `${l.id} and ${o.id} overlap`);
    for (const d of [...dots, ...furniture]) assert.ok(!overlaps(l.box, d), `${l.id} over a mark or the furniture`);
    assert.ok(l.box[0] >= 0 && l.box[1] >= 0 && l.box[2] <= 800 && l.box[3] <= 600, `${l.id} outside the map`);
  }
  // The first is where a cartographer puts it first: to the upper right of its point.
  assert.equal(a[0].position, POSITIONS[0]);
  // A label dragged keeps its place, and the others move round it; a hidden one is not drawn.
  const moved = placeLabels(CLUSTER.map((c, i) => (i === 1 ? { ...c, offset: [-60, 20] } : i === 2 ? { ...c, hidden: true } : c)), opts);
  const p1 = moved.find((l) => l.id === 'p1');
  assert.equal(p1.position, 'dragged'); assert.equal(p1.box[0], CLUSTER[1].x - 60); assert.equal(p1.box[1], CLUSTER[1].y + 20);
  assert.ok(!moved.some((l) => l.id === 'p2'));
  assert.ok(moved.filter((l) => !l.overlaps && l.id !== 'p1').every((l) => !overlaps(l.box, p1.box)));
  // A region in spaced capitals, water in italic, a note on a second, smaller line.
  const [r] = placeLabels([{ id: 'r', text: 'Attica', x: 400, y: 300, size: 14, cls: 'region', area: true, note: 'the land of Athens' }], { bounds: [800, 600], measure: estimate });
  assert.equal(r.position, 'centre'); assert.equal(r.lines[0].text, 'ATTICA'); assert.ok(r.lines[0].spacing > 0);
  assert.equal(r.lines.length, 2); assert.ok(r.lines[1].size < r.lines[0].size && r.lines[1].y > r.lines[0].y);
});

test('a label\'s name: the preferred label, or a name attested for it, or the whole map\'s rule of a language where attested', () => {
  const place = { label: 'Athens', names: [
    { toponym: 'Ἀθῆναι', language: 'grc', script: 'Grek' }, { toponym: 'Athenae', language: 'la', script: 'Latn' },
    { toponym: 'Athenae', language: 'la', script: 'Latn' }, { toponym: 'Setines', language: 'it', status: 'denied' }] };
  const c = nameChoices(place);
  assert.deepEqual(c.map((x) => x.text), ['Athens', 'Ἀθῆναι', 'Athenae'], 'each name once, the denied one not offered');
  assert.equal(labelText(place), 'Athens');
  assert.equal(labelText(place, { rule: { language: 'la' } }), 'Athenae');
  assert.equal(labelText(place, { rule: { language: 'la' }, chosen: c[1].key }), 'Ἀθῆναι', 'its own choice over the rule');
  assert.equal(labelText({ label: 'Eleusis', names: [] }, { rule: { language: 'la' } }), 'Eleusis', 'else the preferred label');
  assert.deepEqual(languagesOf([place, { names: [{ toponym: 'x', language: 'en' }] }]), ['en', 'grc', 'la']);
});

// ---- Natural Earth as vectors, and the whole map ------------------------------------------------

test('Natural Earth\'s style read layer by layer: filters and paint evaluated at the screen\'s zoom, as MapLibre evaluates them', () => {
  const view = VIEWS[0], proj = mercator(view);
  const r = styleNodes(NE_STYLE, DATA, proj, { zoom: view.zoom, only: NE_PLAIN });
  assert.deepEqual(r.drawn, ['ocean', 'land', 'rivers'], 'the plain layers that have anything to draw');
  const svg = r.nodes.map((n) => JSON.stringify(n)).join('');
  assert.ok(svg.includes('#d5e3ea') && svg.includes('#f4f2ec') && svg.includes('#a9c4d4'), 'the style\'s own colours');
  // The river's width at zoom 6.3: interpolated between 0.9 (at 5) and 1.6 (at 9).
  const river = r.nodes.find((n) => n.attrs.id === 'ne-rivers').children;
  assert.equal(river.length, 1, 'the river shown at this zoom, not the one shown from zoom 12');
  assert.ok(near(river[0].attrs['stroke-width'], 0.9 + (0.7 * 1.3) / 4, 1e-9), String(river[0].attrs['stroke-width']));
  assert.deepEqual(colour('rgba(10,20,30,0.5)'), { color: '#0a141e', opacity: 0.5 });
  // The modern layers only when asked.
  assert.ok(!neLayers(NE_STYLE).includes('boundaries') && neLayers(NE_STYLE, { modern: true }).includes('boundaries'));
});

function parseSvg(text) {
  const p = new SaxesParser({ xmlns: true });
  const counts = {}, ids = [], texts = [];
  let err = null, inText = 0;
  p.on('error', (e) => { err = e; });
  p.on('opentag', (t) => { counts[t.local] = (counts[t.local] || 0) + 1; if (t.attributes.id) ids.push(t.attributes.id.value); if (t.local === 'tspan') inText++; });
  p.on('closetag', (t) => { if (t.local === 'tspan') inText--; });
  p.on('text', (t) => { if (inText) texts.push(t); });
  p.write(text).close();
  if (err) throw err;
  return { counts, ids, texts };
}

test('the SVG: well formed, its layers Inkscape\'s, its labels text in the font stack, its settings kept so that it can be made again; held to its golden file', () => {
  const r = goldenMap();
  const parsed = parseSvg(r.svg);
  assert.equal(r.width, 800); assert.equal(r.height, 560);
  assert.match(r.svg, /<svg xmlns="http:\/\/www.w3.org\/2000\/svg"[^>]* width="800" height="560" viewBox="0 0 800 560" xml:lang="en">/);
  for (const id of ['background', 'places', 'labels', 'furniture', 'scale-bar', 'attribution', 'inset', 'north-arrow', 'key', 'precision-marks', 'uncertainty']) assert.ok(parsed.ids.includes(id), `${id} among ${parsed.ids.join(', ')}`);
  assert.deepEqual(parsed.texts.filter((t) => ['Ἀθῆναι', 'Eleusis', 'ATTICA', 'Saronicus Sinus', 'the Mysteries'].includes(t)).sort(), ['ATTICA', 'Eleusis', 'Saronicus Sinus', 'the Mysteries', 'Ἀθῆναι']);
  assert.match(r.svg, /font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif"/);
  assert.ok(!/@font-face|woff2/.test(r.svg), 'no web font in the file for Commons');
  assert.match(r.svg, /<text [^>]*font-style="italic"/, 'water in italic');
  assert.equal(r.rasterInSvg, false, 'Natural Earth alone: true vectors, no picture');
  assert.deepEqual(settingsIn(r.svg), { version: 1, view: { center: [23.4, 38.2], zoom: 6 }, labels: { p1: { offset: [1, 2] } } });
  assert.equal(r.overlapping, 0);
  assert.match(r.scale.words, /^at latitude 38° N$/);
  const golden = 'test/fixtures/chora/export/golden.svg';
  if (process.env.UPDATE_GOLDEN || !existsSync(golden)) { mkdirSync('test/fixtures/chora/export', { recursive: true }); writeFileSync(golden, r.svg); }
  assert.equal(r.svg, readFileSync(golden, 'utf8'), 'the golden SVG: look at the change, then UPDATE_GOLDEN=1');
  // The fonts inlined for the PNG, and nothing else changed by them.
  const withFonts = goldenMap({ fonts: '@font-face { font-family: "Noto Sans"; src: url(data:font/woff2;base64,AAAA) format("woff2"); }' });
  assert.match(withFonts.svg, /<style type="text\/css">\s*<!\[CDATA\[@font-face/);
  assert.equal(withFonts.svg.replace(/\s*<defs>\s*<style[\s\S]*?<\/style>\s*<\/defs>/, ''), r.svg);
});

test('a picture background is embedded, and the file says it is mostly a picture; a historical map placed by its matrix and clipped by its mask', () => {
  const r = goldenMap({ background: { kind: 'image', href: 'data:image/png;base64,iVBORw0KGgo=', name: 'Ancient World (CAWM)' },
    historical: { name: 'A map', href: 'data:image/jpeg;base64,/9j/', opacity: 0.8, affine: { matrix: [0.5, 0, 0, 0.5, 10, 20], width: 1000, height: 800, mask: [[0, 0], [1000, 0], [1000, 800]] } } });
  assert.equal(r.rasterInSvg, true);
  assert.match(r.svg, /<image x="0" y="0" width="800" height="560" preserveAspectRatio="none" xlink:href="data:image\/png;base64,iVBORw0KGgo="\/>/);
  assert.match(r.svg, /<clipPath id="historical-mask" clipPathUnits="userSpaceOnUse">\s*<path transform="matrix\(0.5 0 0 0.5 10 20\)" d="M0 0L1000 0L1000 800Z"\/>/);
  assert.match(r.svg, /<g clip-path="url\(#historical-mask\)" opacity="0.8">\s*<image transform="matrix\(0.5 0 0 0.5 10 20\)" x="0" y="0" width="1000" height="800"/);
  parseSvg(r.svg);
});

test('the scale bar: a round length, said to be true at the latitude of the map\'s middle, the variation said where it is over a tenth', () => {
  assert.deepEqual([niceLength(73_000), niceLength(1999), niceLength(5), niceLength(0)], [50_000, 1000, 5, 0]);
  const small = scaleOf(mercator(VIEWS[0]));
  assert.match(small.words, /^at latitude 38° N$/); assert.ok(small.varies < 0.1, String(small.varies));
  const wide = scaleOf(mercator(VIEWS[2]));
  assert.match(wide.words, /^at latitude \d+° N; the scale varies by \d+% from the top of the map to the bottom$/); assert.ok(wide.varies > 0.1);
  // Equirectangular: true on its middle parallel.
  const q = equirectangular(VIEWS[2]);
  assert.match(scaleOf(q).words, new RegExp(`^at latitude ${Math.round(q.standard)}° N`));
});

// ---- The licence ---------------------------------------------------------------------------------

const PD = { iri: 'https://creativecommons.org/publicdomain/mark/1.0/', credit: 'Natural Earth' };
const NE = { name: 'Natural Earth', role: 'background', licence: PD, templates: ['{{Natural Earth}}'] };
const RELIEF = { name: 'the shaded relief', role: 'relief', licence: { iri: PD.iri, credit: 'NASA SRTM; USGS GMTED2010' }, templates: ['{{PD-USGov-NASA-SRTM}}', '{{PD-USGov-USGS}}'] };
const CAWM = { name: 'Ancient World (CAWM)', role: 'background', licence: { iri: 'https://creativecommons.org/licenses/by/4.0/', credit: 'CAWM' } };
const DARE = { name: 'Roman Empire (DARE)', role: 'background', licence: { iri: 'https://creativecommons.org/licenses/by-sa/3.0/', credit: 'DARE' } };
const OSM = { name: 'OpenStreetMap', role: 'background', licence: { iri: 'https://creativecommons.org/licenses/by-sa/2.0/', credit: '© OpenStreetMap contributors' }, data: { iri: 'https://opendatacommons.org/licenses/odbl/', credit: 'OpenStreetMap contributors' } };
const OFM = { name: 'OpenFreeMap Liberty', role: 'background', licence: { iri: 'https://creativecommons.org/licenses/by/4.0/', credit: '© OpenMapTiles © OpenStreetMap contributors' }, data: { iri: 'https://opendatacommons.org/licenses/odbl/1-0/' } };
const CARTO = { name: 'CARTO Positron', role: 'background', refused: "CARTO's basemaps are under CARTO's commercial terms" };
const PASTED = { name: 'Your tiles from tiles.example.org', role: 'background', licence: null };
const placeWith = (licence, label = 'Athens') => ({ label, attestations: [{ sources: [{ title: 'A gazetteer', licence }] }] });
const PLEIADES = placeWith('https://spdx.org/licenses/CC-BY-3.0');
const map = (r) => ({ ok: r.ok, licence: r.licence.label, refused: r.refused.map((x) => x.name), templates: r.templates });
const CASES = [
  ['Natural Earth and relief, own CC BY: CC BY 4.0', { parts: [NE, RELIEF] }, { ok: true, licence: 'CC BY 4.0', refused: [], templates: ['{{Natural Earth}}', '{{PD-USGov-NASA-SRTM}}', '{{PD-USGov-USGS}}'] }],
  ['Natural Earth, own CC0: stays CC0', { own: MAP_LICENCES[0].iri, parts: [NE] }, { ok: true, licence: 'CC0 1.0', refused: [], templates: ['{{Natural Earth}}'] }],
  ['CAWM, own CC0: raised to CC BY (credit asked)', { own: MAP_LICENCES[0].iri, parts: [CAWM] }, { ok: true, licence: 'CC BY 4.0', refused: [], templates: [] }],
  ['DARE: share-alike raises the map to CC BY-SA 4.0', { parts: [DARE] }, { ok: true, licence: 'CC BY-SA 4.0', refused: [], templates: [] }],
  ['OpenStreetMap: CC BY-SA, ODbL beside', { parts: [OSM] }, { ok: true, licence: 'CC BY-SA 4.0', refused: [], templates: ['{{ODbL OpenStreetMap}}'] }],
  ['OpenFreeMap: CC BY, ODbL beside, not raised by the data', { parts: [OFM] }, { ok: true, licence: 'CC BY 4.0', refused: [], templates: ['{{ODbL OpenStreetMap}}'] }],
  ['CARTO: refused', { parts: [CARTO] }, { ok: false, licence: 'CC BY 4.0', refused: ['CARTO Positron'], templates: [] }],
  ['a pasted background: refused, its licence unknown', { parts: [PASTED] }, { ok: false, licence: 'CC BY 4.0', refused: ['Your tiles from tiles.example.org'], templates: [] }],
  ['a place from Pleiades (CC BY 3.0): CC BY 4.0', { parts: [NE], places: [PLEIADES] }, { ok: true, licence: 'CC BY 4.0', refused: [], templates: ['{{Natural Earth}}'] }],
  ['a place from an NC source: refused, named', { parts: [NE], places: [placeWith('https://creativecommons.org/licenses/by-nc/4.0/')] }, { ok: false, licence: 'CC BY 4.0', refused: ['A gazetteer, cited for Athens'], templates: ['{{Natural Earth}}'] }],
  ['a place from an ND source: refused', { parts: [NE], places: [placeWith('https://creativecommons.org/licenses/by-nd/4.0/')] }, { ok: false, licence: 'CC BY 4.0', refused: ['A gazetteer, cited for Athens'], templates: ['{{Natural Earth}}'] }],
  ['a place from a source of unknown licence: refused', { parts: [NE], places: [placeWith('https://example.org/my-licence')] }, { ok: false, licence: 'CC BY 4.0', refused: ['A gazetteer, cited for Athens'], templates: ['{{Natural Earth}}'] }],
  ['a place from OpenStreetMap through WHG (ODbL): not raised, ODbL beside', { parts: [NE], places: [placeWith('https://spdx.org/licenses/ODbL-1.0')] }, { ok: true, licence: 'CC BY 4.0', refused: [], templates: ['{{Natural Earth}}', '{{ODbL OpenStreetMap}}'] }],
  ['a place from a CC BY-SA source raises the map', { parts: [NE], places: [placeWith('https://creativecommons.org/licenses/by-sa/4.0/')] }, { ok: true, licence: 'CC BY-SA 4.0', refused: [], templates: ['{{Natural Earth}}'] }],
];
for (const [name, input, want] of CASES) test(`licence: ${name}`, () => assert.deepEqual(map(composeLicence(input)), want));

test('licence: a historical map with no clear rights is refused until the user states them, and then carries their statement', () => {
  const unclear = rightsOf({ manifest: { label: { en: ['A plan'] } }, annotation: { id: 'https://annotations.allmaps.org/maps/abc' } });
  assert.equal(unclear.free, null);
  const hist = { name: '“A plan”', role: 'historical', rights: unclear };
  const before = composeLicence({ parts: [NE, hist] });
  assert.equal(before.ok, false); assert.match(before.refused[0].why, /not clear.*say what they are/);
  const stated = composeLicence({ parts: [NE, { ...hist, statement: 'PD-Art|PD-old-100', statedBy: 'Ada Lovelace' }] });
  assert.equal(stated.ok, true); assert.ok(stated.templates.includes('{{PD-Art|PD-old-100}}'));
  assert.match(stated.statements[0], /stated by Ada Lovelace: A faithful photograph/);
  // The manifest's own licence, NC: stated as it is, and so refused for being NC.
  const nc = rightsOf({ manifest: { rights: 'https://creativecommons.org/licenses/by-nc-sa/3.0/' }, annotation: { id: 'https://annotations.allmaps.org/maps/abc' } });
  const asGiven = composeLicence({ parts: [{ name: 'Rumsey', role: 'historical', rights: nc, statement: 'manifest' }] });
  assert.equal(asGiven.ok, false); assert.match(asGiven.refused[0].why, /no commercial use/);
  // A free map needs no statement; Allmaps' georeference is CC0.
  const free = rightsOf({ manifest: { rights: 'https://creativecommons.org/publicdomain/mark/1.0/' }, annotation: { id: 'https://annotations.allmaps.org/maps/abc' } });
  assert.equal(composeLicence({ parts: [{ name: 'Free', role: 'historical', rights: free }] }).ok, true);
  assert.equal(suggestedStatement(1746, 2026), 'PD-Art|PD-old-100'); assert.equal(suggestedStatement(1950, 2026), null); assert.equal(suggestedStatement(NaN, 2026), null);
});

// ---- The Commons page ----------------------------------------------------------------------------

const PAGE_MAP = {
  title: 'Attica in antiquity', description: 'Places of ancient Attica.', lang: 'en', legend: 'Red dots: places; dotted circles: how far each may be from its point.',
  author: { name: 'Ada Lovelace', orcid: '0000-0002-1825-0097' }, date: '2026-10-15', projection: 'mercator', bounds: [22.9, 37.5, 24.4, 38.7],
  scaleWords: 'scale bar, true at latitude 38° N', sources: ['Made with PLATO tools, https://pelagios.org/plato-tools/', 'Places: Pleiades, https://pleiades.stoa.org/places/579885'],
  residuals: [], warp: null, licence: composeLicence({ parts: [NE, RELIEF] }), format: 'svg', rasterInSvg: false, otherVersions: ['Attica in antiquity.png'],
};
test('the Commons page: the {{Map}} template filled, the author by name and ORCID iD, never an email address; held to its words', () => {
  const page = filePage(PAGE_MAP);
  assert.equal(page, `{{Map
 |title = {{en|1=Attica in antiquity}}
 |description = {{en|1=Places of ancient Attica.}}
 |legend = {{en|1=Red dots: places; dotted circles: how far each may be from its point.}}
 |author = [https://orcid.org/0000-0002-1825-0097 Ada Lovelace] (ORCID 0000-0002-1825-0097)
 |date = 2026-10-15
 |map date =
 |projection = Web Mercator (EPSG:3857)
 |scale = scale bar, true at latitude 38° N
 |latitude = 37.50°N to 38.70°N
 |longitude = 22.90°E to 24.40°E
 |source = Made with PLATO tools, https://pelagios.org/plato-tools/; Places: Pleiades, https://pleiades.stoa.org/places/579885
 |warp status =
 |warp url =
 |permission = The map can be shared under CC BY 4.0.
 |other versions = [[:File:Attica in antiquity.png]]
}}

=={{int:license-header}}==
{{self|cc-by-4.0}}
{{Natural Earth}}
{{PD-USGov-NASA-SRTM}}
{{PD-USGov-USGS}}
`);
  assert.ok(!/@/.test(page), 'no address with @ in it');
  assert.equal(authorWords({ name: 'ada@example.org' }), 'Unknown author', 'a name that is an email address is not written');
  assert.match(filePage({ ...PAGE_MAP, format: 'svg', rasterInSvg: true }), /\{\{SVG with raster elements\}\}\n$/);
  assert.ok(!filePage(PAGE_MAP, { forUpload: true }).includes('{{self|'), 'the upload form adds the licence itself');
  // The link: Special:Upload with the name, the description and the licence; none when too long, or not for Commons.
  const url = new URL(uploadUrl(PAGE_MAP, 'Attica in antiquity.svg'));
  assert.equal(url.origin + url.pathname, 'https://commons.wikimedia.org/wiki/Special:Upload');
  assert.equal(url.searchParams.get('wpDestFile'), 'Attica in antiquity.svg');
  assert.equal(url.searchParams.get('wpLicense'), 'self|cc-by-4.0');
  assert.equal(url.searchParams.get('wpUploadDescription'), filePage(PAGE_MAP, { forUpload: true }));
  assert.equal(uploadUrl({ ...PAGE_MAP, description: 'x'.repeat(MAX_LINK) }, 'a.svg'), null);
  assert.equal(uploadUrl({ ...PAGE_MAP, licence: composeLicence({ parts: [CARTO] }) }, 'a.svg'), null);
  assert.equal(commonsName('Attica: places [ancient] / 1', 'svg'), 'Attica places ancient 1.svg');
});

// ---- The PNG's own words -----------------------------------------------------------------------

test('the PNG carries its resolution (pHYs) and its words (tEXt, or iTXt for Greek), read back as written, and its image untouched', () => {
  const png = solidPng(3, 2);
  const settings = JSON.stringify({ version: 1, title: 'Ἀττική' });
  const out = withMeta(png, { dpi: 150, text: { Title: 'Attica', Author: 'Ada Lovelace', Description: 'Ἀθῆναι and its harbour', Copyright: 'CC BY 4.0', 'plato-tools:map': settings } });
  const r = readPng(out);
  assert.deepEqual([r.width, r.height, r.dpi], [3, 2, 150]);
  assert.deepEqual(r.text, { Title: 'Attica', Author: 'Ada Lovelace', Description: 'Ἀθῆναι and its harbour', Copyright: 'CC BY 4.0', 'plato-tools:map': settings });
  const types = chunksOf(out).map((c) => c.type);
  assert.deepEqual(types, ['IHDR', 'pHYs', 'tEXt', 'tEXt', 'iTXt', 'tEXt', 'iTXt', 'IDAT', 'IEND']);
  // The image's own chunk is the same bytes.
  assert.deepEqual(chunksOf(out).find((c) => c.type === 'IDAT').data, chunksOf(png).find((c) => c.type === 'IDAT').data);
  // Written again, replaced, not added to.
  const again = withMeta(out, { dpi: 300, text: { Title: 'Attica again' } });
  assert.equal(readPng(again).dpi, 300); assert.equal(readPng(again).text.Title, 'Attica again');
  assert.equal(chunksOf(again).filter((c) => c.type === 'pHYs').length, 1);
  // A damaged chunk is said, not read.
  const bad = Uint8Array.from(out); bad[40] ^= 0xff;
  assert.throws(() => readPng(bad), /damaged|not a PNG/);
  assert.throws(() => readPng(new Uint8Array([1, 2, 3])), /not a PNG/);
});

test('every mark is one list of shapes, for the canvas and the SVG alike', () => {
  for (const p of ['exact', 'approximate', 'uncertain', 'historical_approximate']) assert.ok(markShapes(p)?.length, p);
  assert.equal(markShapes('roughly'), null);
});
