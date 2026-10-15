// The shaded relief over Natural Earth, in Chora (#37; src/engine/chora/relief.js has what it is and how it is
// toned). One file on this site, basemap/relief.pmtiles, read by HTTP range requests with pmtiles 4.3.0 (verified
// against this file), a tile at a time; each tile toned (toneRelief) into shade and light over transparency, and
// given to MapLibre as a PNG through a protocol of its own (plato-relief://z/x/y), so that the map draws exactly
// the tiles a map made from Chora's view embeds. Nothing is asked of any other site: the file is the page's own
// (the permissions' transformRequest lets this protocol through for that reason, and only it).
//
// The file is not in the repository (322 MB): the Pages workflow puts it in the site from a GitHub release asset.
// Where it is not there (a local build, or before that release exists), the relief says it is not available.
import { PMTiles } from 'pmtiles';
import { RELIEF, toneRelief } from '../engine/chora/relief.js';

export { RELIEF };
export const PROTOCOL = 'plato-relief';
export const SOURCE = 'chora-relief', LAYER = 'chora-relief';
/** The relief file's address: this site's, beside the basemap's style. */
export const reliefUrl = () => new URL(RELIEF.path, document.baseURI).href;

let archive = null, checked = null;
const pm = () => (archive ??= new PMTiles(reliefUrl()));
/**
 * Whether the relief can be shown: { ok: true } once the file's header has been read and is the relief's (WebP
 * tiles), else { ok: false, why }, in words. Asked once a load; a failure is asked again the next time.
 */
export function available() {
  checked ??= (async () => {
    // Its first seven bytes first: a host may answer an address it has nothing at with a page of its own (a
    // development server's index page, with 200), which is "not on this site", as a 404 is.
    let r;
    try { r = await fetch(reliefUrl(), { headers: { Range: 'bytes=0-6' }, cache: 'no-cache' }); } catch (e) { return { ok: false, why: `the relief file could not be read (${String(e?.message || e).slice(0, 120)})` }; }
    // Read through the body's first bytes only, and let the rest go: a host that ignores the range (200, the whole
    // file) would otherwise have the browser pull in all 322 MB here.
    let head = '';
    if (r.ok && r.body) {
      const reader = r.body.getReader(), got = [];
      let n = 0;
      try { while (n < 7) { const { done, value } = await reader.read(); if (done) break; got.push(value); n += value.length; } }
      finally { reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(n); let at = 0;
      for (const v of got) { bytes.set(v, at); at += v.length; }
      head = new TextDecoder().decode(bytes.slice(0, 7));
    }
    if (head !== 'PMTiles') return { ok: false, why: 'the relief file is not on this site' };
    try {
      const h = await pm().getHeader();
      if (h.tileType !== 4) return { ok: false, why: 'the file at the relief\'s address on this site is not the relief' };
      return { ok: true, header: { minZoom: h.minZoom, maxZoom: h.maxZoom, bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat] } };
    } catch (e) { return { ok: false, why: `the relief file could not be read (${String(e?.message || e).split('\n')[0].slice(0, 120)})` }; }
  })().then((a) => { if (!a.ok) { checked = null; archive = null; } return a; });
  return checked;
}

// A tile the file does not have: transparent.
const EMPTY = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
/**
 * The toned tile z/x/y as an ImageBitmap-ready canvas's pixels: { png: Uint8Array } or null where the file has none.
 * Shared by the map (through the protocol) and the export (src/chora/export-ui.js), so that both draw the same.
 */
export async function tonedTile(z, x, y, signal) {
  const t = await pm().getZxy(z, x, y, signal);
  if (!t?.data) return null;
  const bmp = await createImageBitmap(new Blob([t.data], { type: 'image/webp' }));
  const c = new OffscreenCanvas(bmp.width, bmp.height), ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0); bmp.close();
  const img = ctx.getImageData(0, 0, c.width, c.height);
  toneRelief(img.data);
  ctx.putImageData(img, 0, 0);
  return { png: new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()), canvas: c };
}

let registered = false;
/** The protocol, added to MapLibre once. */
export function register(maplibregl) {
  if (registered) return;
  registered = true;
  maplibregl.addProtocol(PROTOCOL, async (params, abort) => {
    const m = /^plato-relief:\/\/(\d+)\/(\d+)\/(\d+)$/.exec(params.url);
    if (!m) throw new Error(`Not a relief tile: ${params.url}`);
    const t = await tonedTile(+m[1], +m[2], +m[3], abort?.signal);
    return { data: (t?.png || EMPTY).buffer };
  });
}

/**
 * The relief on the map `map` (a MapLibre map showing Natural Earth): its source and layer, below the first of
 * `before` that the style has (Natural Earth's rivers, so that water and borders are drawn over it), or below
 * Chora's own layers. Added once; removed by remove().
 */
export function add(map, { before = ['rivers', 'lakes', 'chora-overview-clusters'] } = {}) {
  if (map.getSource(SOURCE)) return;
  map.addSource(SOURCE, { type: 'raster', tiles: [`${PROTOCOL}://{z}/{x}/{y}`], tileSize: 256, minzoom: RELIEF.minzoom, maxzoom: RELIEF.maxzoom, bounds: RELIEF.bounds, attribution: RELIEF.attribution });
  map.addLayer({ id: LAYER, type: 'raster', source: SOURCE, paint: { 'raster-resampling': 'linear', 'raster-fade-duration': 0 } }, before.find((id) => map.getLayer(id)));
}
export function remove(map) {
  if (map.getLayer(LAYER)) map.removeLayer(LAYER);
  if (map.getSource(SOURCE)) map.removeSource(SOURCE);
}
