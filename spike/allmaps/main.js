// Spike: can @allmaps/maplibre's requests be routed through a page-side guard? Throwaway; not
// wired into chora.html. Driven by run_spike.py, which reads window.__spike.
//
// ?case=  plain     the layer as it comes: it fetches info.json and tiles itself
//         fetchfn   a fetchFn option that records every call and then fetches
//         imageinfos  the page fetches info.json itself (?by=guard) and gives it to the layer
//                   with addImageInfos, before addGeoreferenceAnnotation
//         foreign   the annotation names a service on A whose info.json gives an id on B
//         redirect  info.json on A is honest; A answers every tile with 302 to B
//         v3        the Image API 3 info.json
// &a=PORT&b=PORT    the two fixture origins (http://127.0.0.1:PORT)
import * as maplibregl from 'maplibre-gl';
import { WarpedMapLayer } from '@allmaps/maplibre';
import annotation from '../../test/fixtures/chora-iiif/annotation.json';

const q = new URLSearchParams(location.search);
const kase = q.get('case') || 'plain';
const A = `http://127.0.0.1:${q.get('a')}`;
// &guard=csp  a <meta> Content-Security-Policy allowing connections only to this site and origin A,
//             inserted before the map exists
// &guard=sw   the Service Worker in sw.js, controlling the page before the map exists
const guard = q.get('guard');
if (guard === 'csp') {
  const meta = document.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = `connect-src 'self' ws://${location.host} ${A}`;
  document.head.prepend(meta);
}
const swSeen = [];
if (guard === 'sw') {
  navigator.serviceWorker.addEventListener('message', (e) => swSeen.push(e.data));
  await navigator.serviceWorker.register('./sw.js', { scope: './' });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  }
}
const SERVICE = {
  plain: `${A}/iiif/grid`, fetchfn: `${A}/iiif/grid`, imageinfos: `${A}/iiif/grid`,
  foreign: `${A}/iiif/foreign`, redirect: `${A}/iiif/redirect`, v3: `${A}/iiif3/grid`,
}[kase];

const S = (window.__spike = {
  case: kase, service: SERVICE, events: [], fetchFnCalls: [], errors: [], done: false,
  consoleErrors: [], pixel: null, mapIds: [], guard, swSeen, controlled: !!navigator.serviceWorker?.controller,
});
const origError = console.error;
console.error = (...args) => { S.consoleErrors.push(args.map(String).join(' ').slice(0, 300)); origError(...args); };
window.addEventListener('error', (e) => S.errors.push(String(e.message)));
document.addEventListener('securitypolicyviolation', (e) => (S.cspViolations ||= []).push({ blocked: e.blockedURI, directive: e.effectiveDirective }));
window.addEventListener('unhandledrejection', (e) => S.errors.push(String(e.reason?.message ?? e.reason)));

const ann = structuredClone(annotation);
ann.target.source.id = SERVICE;
if (kase === 'v3') ann.target.source.type = 'ImageService3';

const map = new maplibregl.Map({
  container: 'map',
  style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#00ff00' } }] },
  center: [0.125, 52.205], zoom: 12.5, attributionControl: false,
  canvasContextAttributes: { preserveDrawingBuffer: true },
});
window.__map = map;

const options = { layerId: 'warped' };
if (kase === 'fetchfn') {
  options.fetchFn = (input, init) => {
    S.fetchFnCalls.push(String(input instanceof Request ? input.url : input));
    return fetch(input, init);
  };
}
const layer = new WarpedMapLayer(options);
window.__layer = layer;

for (const type of ['imageinfosadded', 'warpedmapadded', 'imageloaded', 'imageinfofetcherror', 'tilefetcherror',
  'maptileloaded', 'firstmaptileloaded', 'allrequestedtilesloaded', 'error']) {
  map.on(type, (e) => S.events.push({ type, t: Math.round(performance.now()), tileUrl: e.tileUrl, error: e.error ? String(e.error.message ?? e.error) : undefined }));
}

map.on('load', async () => {
  map.addLayer(layer);
  try {
    if (kase === 'imageinfos') {
      const r = await fetch(`${SERVICE}/info.json?by=guard`);
      const info = await r.json();
      S.guardFetched = { url: r.url, redirected: r.redirected, id: info['@id'] ?? info.id };
      S.imageInfosResult = layer.addImageInfos([info]);
    }
    S.addResult = layer.addGeoreferenceAnnotation(ann);
    S.mapIds = layer.getMapIds();
  } catch (e) {
    S.errors.push(String(e.message ?? e));
  }
  // Settle: the tiles, or a bounded wait.
  const t0 = performance.now();
  await new Promise((r) => {
    const tick = () => {
      const ev = S.events.map((e) => e.type);
      if (ev.includes('allrequestedtilesloaded') || performance.now() - t0 > 8000) return r();
      setTimeout(tick, 100);
    };
    tick();
  });
  await new Promise((r) => setTimeout(r, 1500)); // let stragglers (redirects, retries) arrive
  map.triggerRepaint();
  await new Promise((r) => map.once('idle', r));
  // What is drawn at the centre: the background is pure green; the grid image is cream.
  const gl = map.getCanvas().getContext('webgl2');
  const px = new Uint8Array(4);
  gl.readPixels(Math.floor(gl.drawingBufferWidth / 2) + 20, Math.floor(gl.drawingBufferHeight / 2) + 20, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  S.pixel = Array.from(px);
  S.done = true;
});
