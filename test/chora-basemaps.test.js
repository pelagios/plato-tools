// Chora's basemaps (src/chora/basemaps.js): which sites each asks, so that the map's transformRequest
// allows those and no others, and the permission each needs (src/lib/permissions.js) covers every one;
// and what a drawing's note says of the basemap
// it was drawn on. Written for the pre-push review of 30 September 2026: each test failed before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtIn, fromPaste, subjectsOf, originsOf, styleOrigins, drawnOn, current, automatic, permitted, pasted, sameBasemap } from '../src/chora/basemaps.js';
import { originsFor, policyFor } from '../src/lib/permissions-core.js';
import * as permissions from '../src/lib/permissions.js';
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

// What any page of the site's origin can write into this browser: a grant marked as added by the user, a
// pasted basemap and the choice of it (the security audit of 1 October 2026, H2). None of it may put the
// basemap on the map at load: only a click in this load does; a provider of the REGISTRY loads as before.
test('a pasted basemap remembered as the choice, allowed and in the policy, is not current at load, only once chosen in this load; a registry provider is', () => {
  class Store { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }
  const INJECTED = 'https://injected.example.org', OSM = 'https://tile.openstreetmap.org';
  const pasted = fromPaste(`${INJECTED}/{z}/{x}/{y}.png`);   // as a sibling would have to write it: the id is the address's own
  globalThis.localStorage = new Store(); globalThis.sessionStorage = new Store();
  globalThis.__platoCsp = { policy: policyFor([INJECTED, OSM]), origins: [INJECTED, OSM] };
  permissions.resetForTests();
  localStorage.setItem('plato-tools.permissions', JSON.stringify({ version: 1, grants: {
    [`basemap:${INJECTED}`]: { state: 'allowed', at: '2026-10-01T09:00:00Z', added: true }, 'basemap:osm': { state: 'allowed' } } }));
  localStorage.setItem('chora-basemaps', JSON.stringify([pasted]));
  localStorage.setItem('chora-basemap', JSON.stringify(pasted.id));
  assert.equal(permitted(pasted), true, 'the grant is in force: nothing but the rule below keeps it off the map');
  assert.equal(automatic(pasted), false);
  assert.equal(current().id, 'natural-earth', 'not at load');
  assert.equal(current({ chosen: { ...pasted, id: 'pasted-other' } }).id, 'natural-earth', 'not for another basemap chosen');
  assert.equal(current({ chosen: pasted }).id, pasted.id, 'once chosen in this load');
  // The id alone is not enough: the same id re-pointed at another address in storage is not the one chosen (Fable, 2 October 2026).
  localStorage.setItem('chora-basemaps', JSON.stringify([{ ...pasted, tiles: 'https://attacker.example.net/{z}/{x}/{y}.png' }]));
  localStorage.setItem('plato-tools.permissions', JSON.stringify({ version: 1, grants: {
    [`basemap:${INJECTED}`]: { state: 'allowed', added: true }, 'basemap:https://attacker.example.net': { state: 'allowed', added: true }, 'basemap:osm': { state: 'allowed' } } }));
  globalThis.__platoCsp = { policy: policyFor([INJECTED, OSM, 'https://attacker.example.net']), origins: [INJECTED, OSM, 'https://attacker.example.net'] };
  assert.equal(sameBasemap(pasted, { ...pasted, tiles: 'https://attacker.example.net/{z}/{x}/{y}.png' }), false);
  assert.equal(current({ chosen: pasted }).id, 'natural-earth', 're-pointed: not used (the entry is not even read: its id is another address\'s)');
  localStorage.setItem('chora-basemaps', JSON.stringify([pasted]));
  assert.equal(current({ chosen: pasted }).id, pasted.id, 'the control: as chosen, used');
  // The controls: a provider of the REGISTRY is automatic and current at load, as is Natural Earth.
  localStorage.setItem('chora-basemap', JSON.stringify('osm'));
  assert.equal(automatic(builtIn().find((b) => b.id === 'osm')), true);
  assert.equal(current().id, 'osm');
  localStorage.setItem('chora-basemap', JSON.stringify('natural-earth'));
  assert.equal(current().id, 'natural-earth');
  delete globalThis.localStorage; delete globalThis.sessionStorage; delete globalThis.__platoCsp;
});

// A pasted basemap is rebuilt from its address alone when read: fields a sibling page could write
// into storage to pass it off as this site's or a provider's (automatic at load) are not read.
test('a stored pasted basemap is read from its address alone: local, provider, group and name from storage count for nothing', () => {
  class Store { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }
  globalThis.localStorage = new Store(); globalThis.sessionStorage = new Store();
  globalThis.__platoCsp = { policy: policyFor([]), origins: [] };
  permissions.resetForTests();
  const a = fromPaste('https://attacker.example.net/style.json'), b = fromPaste('https://attacker.example.net/{z}/{x}/{y}.png');
  localStorage.setItem('chora-basemaps', JSON.stringify([
    { id: a.id, name: 'Natural Earth (this site)', group: 'This site', kind: 'style', url: 'https://attacker.example.net/style.json', local: true },
    { id: b.id, name: 'OpenStreetMap standard', group: 'OpenStreetMap', kind: 'raster', tiles: 'https://attacker.example.net/{z}/{x}/{y}.png', provider: 'osm', origins: ['https://attacker.example.net', '*', 'javascript:x'] },
    { id: 'natural-earth', kind: 'style', url: 'https://attacker.example.net/ne.json' },
    { id: 'pasted-other', kind: 'style', url: 'https://attacker.example.net/style.json' },
    { id: fromPaste('http://plain.example.net/style.json')?.id || 'pasted-c', kind: 'style', url: 'http://plain.example.net/style.json' },
    { id: 'pasted-d', kind: 'style' },
    'not an object', null,
  ]));
  const got = pasted();
  assert.deepEqual(got.map((x) => x.id), [a.id, b.id], 'an id not the address\'s own, a plain-http address, no address, and non-objects are dropped');
  for (const b of got) {
    assert.equal(b.group, 'Pasted'); assert.equal(b.local, undefined); assert.equal(b.provider, undefined);
    assert.equal(automatic(b), false, `${b.id} is not automatic`);
    assert.equal(permitted(b), false, `${b.id} needs its site allowed`);
  }
  assert.deepEqual(got[0], { id: a.id, name: 'Your style from attacker.example.net', group: 'Pasted', kind: 'style', url: 'https://attacker.example.net/style.json' });
  assert.equal(got[1].name, 'Your tiles from attacker.example.net'); assert.equal(got[1].kind, 'raster');
  assert.equal(got[1].origins, undefined, 'a tile template names no further sites: none carried');
  localStorage.setItem('chora-basemaps', JSON.stringify([{ ...a, origins: ['https://attacker.example.net', '*', 'javascript:x'] }]));
  assert.deepEqual(pasted()[0].origins, ['https://attacker.example.net'], 'for a style, only plain sites are kept as the sites it names');
  // The control: what fromPaste makes, kept and read back, is itself.
  const mine = fromPaste('https://tiles.example.org/{z}/{x}/{y}.png');
  localStorage.setItem('chora-basemaps', JSON.stringify([mine]));
  assert.deepEqual(pasted(), [mine]);
  assert.equal(current().id, 'natural-earth');
  delete globalThis.localStorage; delete globalThis.sessionStorage; delete globalThis.__platoCsp;
});
