// Chora's map: MapLibre GL JS, with the dataset's places over a basemap, the chosen place drawn by
// the status of each attestation, and Terra Draw for drawing new ones.
//
// The guard. Every request MapLibre makes goes through transformRequest, which refuses any address
// not on this site or on the site of the basemap the user has agreed to. A Content Security Policy
// would do this better, but a policy in a <meta> tag cannot be widened once the page is running, and
// a pasted basemap may be on any site; so it is done here, and each refusal is counted
// (window.__chora.blocked) and named (blockedOrigins), for the page and its tests.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre's own worker, bundled by Vite with what it imports, and served from this site.
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { TerraDraw, TerraDrawPointMode, TerraDrawLineStringMode, TerraDrawPolygonMode, TerraDrawSelectMode } from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';

maplibregl.setWorkerUrl(mapWorkerUrl);

// Colours of the statuses, the same in the card (styles.css) and on the map.
export const STATUS_COLOURS = { asserted: '#2757dd', reported: '#7a4fc9', tentative: '#b7791f', doubted: '#6b7280', denied: '#c0392b' };
const status = (fallback) => ['match', ['get', 'status'], ...Object.entries(STATUS_COLOURS).flat(), fallback];
const EMPTY = { type: 'FeatureCollection', features: [] };

// An address may carry a basemap's key, in its query string (CARTO's api_key) or in its path (a pasted
// one's): nothing of it but its site is written to the console.
const redact = (s) => String(s).replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]*/gi, (u) => { try { return `${new URL(u).origin}/…`; } catch { return '…'; } });
/** What a map error was about, in general terms, for the console: a tile, a source's data, or the style. */
const kindOf = (e) => (e?.tile ? 'a tile' : e?.sourceId ? 'a source' : 'the style or its glyphs and sprites');

/**
 * The map in `container`. `state` is window.__chora: blocked, blockedOrigins and mapReadyCount are
 * kept up to date on it. `onPlaceClick(id)` is called when a place on the map is clicked, and
 * `onStyleError(why)` when a basemap's style (not a tile of it) cannot be loaded.
 */
export function createMap(container, { state, onPlaceClick, onStyleError }) {
  const allowed = new Set([location.origin]);
  state.blocked = 0; state.blockedOrigins = [];
  // The guard: MapLibre's requests, and the page's own fetch of a pasted style, pass through it.
  function guard(url) {
    let origin;
    try { origin = new URL(url, location.href).origin; } catch { origin = 'null'; }
    if (/^(data|blob):/.test(url) || allowed.has(origin)) return url;
    state.blocked++;
    if (!state.blockedOrigins.includes(origin)) state.blockedOrigins.push(origin);
    throw new Error(`Chora refused a request to ${origin}: it is not this site, nor the basemap's.`);
  }
  const map = new maplibregl.Map({
    container, style: { version: 8, sources: {}, layers: [{ id: 'blank', type: 'background', paint: { 'background-color': '#dde3ea' } }] },
    center: [10, 30], zoom: 1.2, attributionControl: { compact: false }, maplibreLogo: false,
    transformRequest: (url) => ({ url: guard(url) }),
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl(), 'bottom-left');
  map.on('idle', () => { state.mapReadyCount = (state.mapReadyCount || 0) + 1; });
  // A style being loaded that fails (it is not there, or not a style) never fires style.load: the map
  // is left with nothing on it, and nothing to draw on. An error with no source or tile is the style's.
  let styleLoading = false;
  map.on('error', (e) => {
    const why = redact(e?.error?.message || e?.error || 'unknown error');
    if (styleLoading && !e?.sourceId && !e?.tile) { styleLoading = false; onStyleError?.(why); }
    // A refused request surfaces as an error event; it has been counted, and is not a fault.
    if (!/Chora refused/.test(why)) console.warn(`Map, ${kindOf(e)}:`, why);
  });

  // What Chora draws, kept here so that it can be put back when the basemap (the style) changes.
  const data = { overview: EMPTY, place: EMPTY, context: EMPTY };
  let draw = null, drawHandlers = {}, drawnKeep = [];

  function addOwnLayers() {
    map.addSource('chora-overview', { type: 'geojson', data: data.overview, cluster: true, clusterRadius: 36, clusterMaxZoom: 11 });
    map.addSource('chora-context', { type: 'geojson', data: data.context });
    map.addSource('chora-place', { type: 'geojson', data: data.place });
    const add = (l) => map.addLayer(l);
    add({ id: 'chora-overview-clusters', type: 'circle', source: 'chora-overview', filter: ['has', 'point_count'],
      paint: { 'circle-color': '#1f45b8', 'circle-opacity': 0.35, 'circle-stroke-color': '#1f45b8', 'circle-stroke-width': 1,
        'circle-radius': ['step', ['get', 'point_count'], 7, 10, 10, 100, 14, 1000, 19] } });
    add({ id: 'chora-overview-points', type: 'circle', source: 'chora-overview', filter: ['!', ['has', 'point_count']],
      paint: { 'circle-color': '#1f45b8', 'circle-radius': 4, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 } });
    // Context for a place with no location of its own: the places it is related to, and the box of its country.
    add({ id: 'chora-context-area', type: 'line', source: 'chora-context', filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
      paint: { 'line-color': '#b7791f', 'line-width': 2, 'line-dasharray': [3, 2] } });
    add({ id: 'chora-context-points', type: 'circle', source: 'chora-context', filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-color': '#f3c969', 'circle-radius': 6, 'circle-stroke-color': '#8a6d1f', 'circle-stroke-width': 1.5 } });
    // The chosen place: each geometry in the colour of its attestation's status; asserted ones solid,
    // the others dashed, and a denied one (where the place is NOT) faint.
    const faint = ['case', ['==', ['get', 'status'], 'denied'], 0.35, 1];
    add({ id: 'chora-place-fill', type: 'fill', source: 'chora-place', filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
      paint: { 'fill-color': status('#2757dd'), 'fill-opacity': ['case', ['==', ['get', 'status'], 'asserted'], 0.18, 0.08] } });
    add({ id: 'chora-place-line', type: 'line', source: 'chora-place', filter: ['all', ['!', ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false]], ['==', ['get', 'status'], 'asserted']],
      paint: { 'line-color': status('#2757dd'), 'line-width': 2.5 } });
    add({ id: 'chora-place-line-dashed', type: 'line', source: 'chora-place', filter: ['all', ['!', ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false]], ['!=', ['get', 'status'], 'asserted']],
      paint: { 'line-color': status('#2757dd'), 'line-width': 2.5, 'line-dasharray': [2, 2], 'line-opacity': faint } });
    add({ id: 'chora-place-points', type: 'circle', source: 'chora-place', filter: ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
      paint: { 'circle-color': ['case', ['==', ['get', 'status'], 'asserted'], status('#2757dd'), '#ffffff'], 'circle-radius': 7,
        'circle-stroke-color': status('#2757dd'), 'circle-stroke-width': 2.5, 'circle-opacity': faint, 'circle-stroke-opacity': faint } });
  }

  const pointer = (on) => () => { map.getCanvas().style.cursor = on && !drawing() ? 'pointer' : ''; };
  for (const id of ['chora-overview-points', 'chora-overview-clusters']) { map.on('mouseenter', id, pointer(true)); map.on('mouseleave', id, pointer(false)); }
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
  map.on('mousemove', 'chora-overview-points', (e) => { if (!drawing()) popup.setLngLat(e.lngLat).setText(e.features[0].properties.label || '').addTo(map); });
  map.on('mouseleave', 'chora-overview-points', () => popup.remove());
  map.on('click', 'chora-overview-points', (e) => { if (!drawing()) onPlaceClick(e.features[0].properties.id); });
  map.on('click', 'chora-overview-clusters', async (e) => {
    if (drawing()) return;
    const f = e.features[0];
    const zoom = await map.getSource('chora-overview').getClusterExpansionZoom(f.properties.cluster_id);
    map.easeTo({ center: f.geometry.coordinates, zoom });
  });

  // Drawing. Terra Draw keeps its own layers; they go when the style changes, so the drawings are
  // taken out first and put back after.
  function startDraw() {
    draw = new TerraDraw({
      adapter: new TerraDrawMapLibreGLAdapter({ map }),
      modes: [new TerraDrawPointMode(), new TerraDrawLineStringMode(), new TerraDrawPolygonMode(),
        new TerraDrawSelectMode({ flags: Object.fromEntries(['point', 'linestring', 'polygon'].map((m) => [m, { feature: { draggable: true, coordinates: m === 'point' ? undefined : { midpoints: true, draggable: true, deletable: true } } }])) })],
    });
    draw.start();
    for (const [ev, fn] of Object.entries(drawHandlers)) draw.on(ev, fn);
    if (drawnKeep.length) draw.addFeatures(drawnKeep);
    drawnKeep = [];
  }
  const drawing = () => draw && !['static', 'select'].includes(draw.getMode());

  let styleVersion = 0;
  map.on('style.load', () => {
    styleLoading = false;
    addOwnLayers();
    startDraw();
    styleVersion++;
  });

  return {
    map,
    /** Allow requests to these origins (besides this site's), and no others. */
    allow(origins) { allowed.clear(); allowed.add(location.origin); for (const o of origins) if (o) allowed.add(o); },
    /** The address, if the guard lets it through; else the refusal is counted, and thrown. */
    guard,
    /** Change the basemap: `style` is a style object or address. What Chora draws is kept. */
    setStyle(style) {
      if (draw) {
        // Stopping clears Terra Draw's store; that is not the user deleting anything, so nobody is told.
        drawnKeep = draw.getSnapshot();
        for (const [ev, fn] of Object.entries(drawHandlers)) draw.off(ev, fn);
        try { draw.stop(); } catch {}
        draw = null;
      }
      styleLoading = true;
      map.setStyle(style, { diff: false });
    },
    get styleVersion() { return styleVersion; },
    setOverview(fc) { data.overview = fc || EMPTY; map.getSource('chora-overview')?.setData(data.overview); },
    setPlace(fc) { data.place = fc || EMPTY; map.getSource('chora-place')?.setData(data.place); },
    setContext(fc) { data.context = fc || EMPTY; map.getSource('chora-context')?.setData(data.context); },
    fit(bbox, maxZoom = 9) {
      if (!bbox) return;
      // A box across the antimeridian (Russia, Fiji) has its west east of its east.
      const [w, s, e0, n] = bbox, e = e0 < w ? e0 + 360 : e0;
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      map.fitBounds([[w, s], [e, n]], { padding: 48, maxZoom, duration: reduce ? 0 : 700 });
    },
    // Drawing, for app.js.
    onDraw(handlers) { drawHandlers = handlers; if (draw) for (const [ev, fn] of Object.entries(handlers)) draw.on(ev, fn); },
    get draw() { return draw; },
    setMode(mode) { if (draw) draw.setMode(mode); container.classList.toggle('drawing', !['static', 'select'].includes(mode)); },
    /** Show these drafts (and only these) as editable drawings. */
    showDrafts(drafts) {
      const features = drafts.map((d) => ({ type: 'Feature', id: d.id, geometry: d.geojson, properties: { mode: MODE_OF[d.geojson.type] } }));
      if (!draw) { drawnKeep = features; return; }
      if (draw.getMode() === 'select') draw.setMode('static');
      draw.clear();
      if (features.length) draw.addFeatures(features);
    },
    zoom: () => map.getZoom(),
  };
}
const MODE_OF = { Point: 'point', LineString: 'linestring', Polygon: 'polygon' };

/** A FeatureCollection of a place view's geometries, for the map; each carries its status. */
export function placeFeatures(view) {
  return { type: 'FeatureCollection', features: (view?.geometries || []).map((g, i) => ({ type: 'Feature', id: i, geometry: g.geojson, properties: { status: g.status, role: g.role || '' } })) };
}
/**
 * What to show around a place with no location of its own: the places it is related to, and the
 * outlines of its countries (`countries`: Natural Earth features of those countries, from this site),
 * or, for a country Natural Earth does not outline, its box.
 */
export function contextFeatures(view, countries = [], ccodeBoxes = []) {
  const features = [];
  if (view?.geometries?.length) return { type: 'FeatureCollection', features };
  for (const r of view?.relations || []) if (r.related?.geometry) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: r.related.geometry }, properties: { label: r.related.label || '' } });
  if (view?.fallback?.kind === 'ccodes') {
    const outlined = new Set();
    for (const f of countries) { features.push({ type: 'Feature', geometry: f.geometry, properties: { label: f.properties.iso } }); outlined.add(f.properties.iso); }
    for (const [code, [w, s, e0, n]] of ccodeBoxes) if (!outlined.has(code)) {
      const e = e0 < w ? e0 + 360 : e0;
      features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }, properties: { label: code } });
    }
  }
  return { type: 'FeatureCollection', features };
}
