// The fixed map the tests of making an open map (#37) hold the engine to: Natural Earth's style over a little
// land and a river, four places of Attica (a point known exactly, one approximately with a circle of 12 km, an
// area, a sea named), with every piece of furniture. Shared by test/chora-export.test.js (its golden SVG) and
// test/chora-export-rsvg.test.js (drawn by Commons' renderer).
import { readFileSync } from 'node:fs';
import { zlibSync } from 'fflate';
import { composeMap, neLayers } from '../src/engine/chora/export/compose.js';
import { estimate } from '../src/engine/chora/export/labels.js';
import { OWN_DEFAULT } from '../src/engine/chora/export/licence.js';
import { crc32 } from '../src/engine/chora/export/png-meta.js';
import { keyRows } from '../src/chora/vague.js';

export const NE_STYLE = JSON.parse(readFileSync('public/basemap/style.json', 'utf8'));
export const LAND = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[20, 35], [26, 35], [26, 41], [20, 41], [20, 35]]] } }] };
const RIVERS = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { name: 'Achelous', min_zoom: 3 }, geometry: { type: 'LineString', coordinates: [[21.2, 39.6], [21.3, 38.4]] } },
  { type: 'Feature', properties: { name: 'Hidden', min_zoom: 12 }, geometry: { type: 'LineString', coordinates: [[22, 39], [22.5, 38.5]] } }] };
export const DATA = { land: LAND, rivers: RIVERS, lakes: { type: 'FeatureCollection', features: [] }, countries: LAND, boundaries: { type: 'FeatureCollection', features: [] } };
const measure = estimate;
export function goldenMap(over = {}) {
  return composeMap({
    view: { center: [23.4, 38.2], zoom: 6, width: 800, height: 560 }, width: 800, projection: 'mercator',
    background: { kind: 'vector', style: NE_STYLE, data: DATA, layers: neLayers(NE_STYLE) },
    places: [
      { id: 'https://pleiades.stoa.org/places/579885', text: 'Ἀθῆναι', cls: 'settlement', point: [23.72, 37.97], geometries: [{ geojson: { type: 'Point', coordinates: [23.72, 37.97] }, precision: 'exact', precisionKm: null }] },
      { id: 'https://example.org/p/eleusis', text: 'Eleusis', note: 'the Mysteries', point: [23.54, 38.04], geometries: [{ geojson: { type: 'Point', coordinates: [23.54, 38.04] }, precision: 'approximate', precisionKm: 12 }] },
      { id: 'https://example.org/p/attica', text: 'Attica', cls: 'region', point: [23.8, 38.3], geometries: [{ geojson: { type: 'Polygon', coordinates: [[[23.3, 37.7], [24.1, 37.7], [24.1, 38.6], [23.3, 38.6], [23.3, 37.7]]] } }] },
      { id: 'https://example.org/p/saronic', text: 'Saronicus Sinus', cls: 'water', point: [23.4, 37.7], geometries: [] },
    ],
    marks: true, keyRows: keyRows(),
    furniture: { north: true, inset: LAND.features, title: 'Attica', attribution: ['Map: Ada Lovelace, CC BY 4.0, made with PLATO tools', 'Modern coastline: Natural Earth, 50m (public domain)'] },
    lang: 'en', title: 'Attica', desc: 'Places of Attica', settings: { version: 1, view: { center: [23.4, 38.2], zoom: 6 }, labels: { p1: { offset: [1, 2] } } },
    dc: { title: 'Attica', creator: 'Ada Lovelace', rights: OWN_DEFAULT, date: '2026-10-15' }, measure, ...over,
  });
}

/** A PNG of w × h pixels of one colour, made here (IHDR, one IDAT, IEND). */
export function solidPng(w, h, [r, g, b, a] = [200, 100, 50, 255]) {
  const row = [0, ...Array.from({ length: w }, () => [r, g, b, a]).flat()];
  const raw = Uint8Array.from(Array.from({ length: h }, () => row).flat());
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type, data) => { const body = Uint8Array.from([...type].map((c) => c.charCodeAt(0)).concat([...data])); return [...u32(data.length), ...body, ...u32(crc32(body))]; };
  return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', [...u32(w), ...u32(h), 8, 6, 0, 0, 0]), ...chunk('IDAT', zlibSync(raw)), ...chunk('IEND', [])]);
}
