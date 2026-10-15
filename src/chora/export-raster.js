// The pictures in a map made from Chora's view (#37), made in the page: a raster background's tiles (CAWM, DARE,
// OpenStreetMap) and the shaded relief, stitched at the map's size within the tile budget (export/tiles.js); a
// style (OpenFreeMap) or a georeferenced map whose warp is not affine, drawn by an offscreen MapLibre map of the
// map's size; and a georeferenced map's image, fetched once from its IIIF server at the size the map needs, for
// the affine embed. A picture is made in Web Mercator, and remapped row by row for the equirectangular projection.
// Every request goes through the permissions' fetch or MapLibre's guard: nothing is asked of a site not allowed.
import * as maplibregl from 'maplibre-gl';
import { mercator, equirectangular, exportView } from '../engine/chora/export/project.js';
import { tilePlan, tileUrl, rowSources } from '../engine/chora/export/tiles.js';
import * as permissions from '../lib/permissions.js';
import * as relief from './relief.js';
import * as ov from './overlays.js';

const canvas = (w, h) => Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) });
/** A canvas as a PNG data: address, for the SVG to carry. */
export const dataUrl = (c) => c.toDataURL('image/png');
/** A blob as a data: address. */
export const blobUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });

/** The Mercator picture of a plan's tiles (tilePlan), each from getImage(tile) (an image, a bitmap or a canvas, or null for none). */
async function stitch(merc, plan, getImage, signal) {
  const c = canvas(merc.width, merc.height), ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  let drawn = 0, failed = 0;
  // A few at a time, in order.
  for (let i = 0; i < plan.tiles.length; i += 8) {
    if (signal?.aborted) throw new DOMException('The map was not made', 'AbortError');
    const got = await Promise.all(plan.tiles.slice(i, i + 8).map((t) => getImage(t).then((img) => [t, img], () => [t, undefined])));
    for (const [t, img] of got) {
      if (img === undefined) { failed++; continue; }
      if (!img) continue;
      ctx.drawImage(img, t.left, t.top, t.size, t.size); drawn++;
      img.close?.();
    }
  }
  return { canvas: c, drawn, failed };
}
/** A Web Mercator picture remapped to the equirectangular projection of the same view: row by row. */
export function toEquirectangular(src, merc, equi) {
  const rows = rowSources(merc, equi), c = canvas(equi.width, equi.height), ctx = c.getContext('2d');
  for (let y = 0; y < equi.height; y++) ctx.drawImage(src, 0, Math.min(src.height - 1, Math.max(0, Math.floor(rows[y]))), src.width, 1, 0, y, equi.width, 1);
  return c;
}
/** The view as a map made from it, in both projections. */
function projections(view, width) {
  const v = exportView(view, width);
  return { v, merc: mercator(v), equi: equirectangular(v) };
}
/** A picture made in Web Mercator, in the projection asked for, as a data: address with what was done. */
function finish(c, { merc, equi }, projection, extra) {
  return { href: dataUrl(projection === 'equirectangular' ? toEquirectangular(c, merc, equi) : c), ...extra };
}

/**
 * A raster basemap's picture (basemaps.js, kind raster, from a provider of the permissions' REGISTRY): its tiles
 * through the permissions' fetch, at most TILE_BUDGET, as fine as its maxzoom allows. { href, z, coarser,
 * tiles, failed } or throws, in words, when none could be read (its site does not let other sites read them).
 */
export async function rasterBackground(b, view, width, projection, { signal } = {}) {
  const p = projections(view, width);
  const plan = tilePlan(p.merc, { minzoom: b.minzoom || 0, maxzoom: b.maxzoom || 19 });
  if (plan.tooMany) throw new Error(`the view is too wide for ${b.name}'s tiles: even its coarsest would be ${plan.count} tiles, more than the ${plan.tiles.length || 400} a map may fetch`);
  const subject = b.provider ? ['basemap', b.provider] : null;
  const s = await stitch(p.merc, plan, async (t) => {
    const r = await permissions.fetch(tileUrl(b.tiles, t), { cat: subject[0], subj: subject[1] });
    if (!r.ok) return null;
    return createImageBitmap(await r.blob());
  }, signal);
  if (!s.drawn) throw new Error(`none of ${b.name}'s tiles could be read for the picture${s.failed ? ' (its site may not let another site read them)' : ''}`);
  return finish(s.canvas, p, projection, { z: plan.z, coarser: plan.coarser, tiles: plan.tiles.length, failed: s.failed });
}

/** The shaded relief's picture: its toned tiles (relief.js), as the map shows them, at most TILE_BUDGET. */
export async function reliefPicture(view, width, projection, { signal } = {}) {
  const p = projections(view, width);
  const plan = tilePlan(p.merc, { minzoom: relief.RELIEF.minzoom, maxzoom: relief.RELIEF.maxzoom });
  if (plan.tooMany) return null;
  const s = await stitch(p.merc, plan, async (t) => (await relief.tonedTile(t.z, t.x, t.y, signal))?.canvas || null, signal);
  return finish(s.canvas, p, projection, { z: plan.z, coarser: plan.coarser, tiles: plan.tiles.length });
}

let limit = null;
/** The largest canvas this browser's graphics draw, in pixels each way (WebGL's renderbuffer and viewport limits). */
export function gpuLimit() {
  if (limit) return limit;
  try {
    const gl = canvas(1, 1).getContext('webgl2') || canvas(1, 1).getContext('webgl');
    const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    limit = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_TEXTURE_SIZE), dims[0], dims[1]);
  } catch { limit = 4096; }
  return limit;
}

/**
 * A picture drawn by an offscreen MapLibre map of the map's size, at the view: `style` (an address or an object),
 * and `then(map)` to add what it draws (a georeferenced map's layer). Its requests go through MapLibre's guard
 * with `subjects` (the permissions it needs). Its canvas is at most gpuLimit() each way (MapLibre's maxCanvasSize),
 * drawn larger where the map is larger, and that is said ({ limited }). Waits for the map to be idle.
 */
export async function renderOffscreen(style, view, width, projection, { subjects = [], then = null, timeout = 90_000 } = {}) {
  const p = projections(view, width);
  const max = gpuLimit();
  const div = document.createElement('div');
  div.style.cssText = `position:fixed;left:${-p.merc.width - 50}px;top:0;width:${p.merc.width}px;height:${p.merc.height}px;pointer-events:none`;
  div.setAttribute('aria-hidden', 'true');
  document.body.append(div);
  const map = new maplibregl.Map({ container: div, style, center: p.v.center, zoom: p.v.zoom, pixelRatio: 1, interactive: false, attributionControl: false,
    canvasContextAttributes: { preserveDrawingBuffer: true }, fadeDuration: 0, maxCanvasSize: [max, max], transformRequest: permissions.transformRequest(() => subjects) });
  try {
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('the picture was not drawn in time')), timeout); map.once('load', () => { clearTimeout(t); res(); }); map.once('error', (e) => { if (!map.loaded()) { clearTimeout(t); rej(e.error || new Error('the picture could not be drawn')); } }); });
    if (then) await then(map);
    await new Promise((res) => { const t = setTimeout(res, timeout); const done = () => { if (map.loaded() && map.areTilesLoaded()) { clearTimeout(t); res(); } else map.once('idle', done); }; map.once('idle', done); map.triggerRepaint(); });
    const c = map.getCanvas();
    // The canvas is limited to what the graphics draw: copied at the map's size (larger, where it was limited).
    const out = canvas(p.merc.width, p.merc.height);
    out.getContext('2d').drawImage(c, 0, 0, out.width, out.height);
    return finish(out, p, projection, { limited: c.width < p.merc.width ? c.width : null, max });
  } finally { map.remove(); div.remove(); }
}

/** A georeferenced map (overlays.js admitted entry) drawn alone by an offscreen map, warped as Chora shows it. */
export function historicalRendered(entry, view, width, projection) {
  const host = new URL(entry.info.id ?? entry.info['@id']).origin;
  return renderOffscreen({ version: 8, sources: {}, layers: [{ id: 'blank', type: 'background', paint: { 'background-color': 'rgba(0,0,0,0)' } }] }, view, width, projection, {
    subjects: [['iiif', host]],
    then: async (map) => {
      // The layer manager wants Chora's first layer to put the map under: an empty one stands for it here.
      map.addSource('chora-overview', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'chora-overview-clusters', type: 'circle', source: 'chora-overview' });
      const lm = ov.createLayerManager(map, {});
      await lm.attach();
      await lm.add({ ...entry, key: `export-${entry.key}`, opacity: 1, visible: true });
      await new Promise((res) => { const t = setTimeout(res, 60_000); map.on('allrequestedtilesloaded', () => { clearTimeout(t); res(); }); });
    },
  });
}

/**
 * A georeferenced map's image at the size the map needs (at most `cap` pixels wide, never wider than the image),
 * from its IIIF image server through the permissions' fetch: { href, width (of the image fetched), full: { width,
 * height } (the image's own pixels, the space its georeference and mask are in) }.
 */
export async function iiifImage(entry, wantWidth, { cap = 4000 } = {}) {
  const id = String(entry.info.id ?? entry.info['@id']).replace(/\/$/, '');
  const full = { width: entry.g.image.width, height: entry.g.image.height };
  const w = Math.max(1, Math.min(full.width, cap, Math.ceil(wantWidth)));
  const url = `${id}/full/${w},/0/default.jpg`;
  const r = await permissions.fetch(url, { cat: 'iiif', subj: new URL(url).origin });
  if (!r.ok) throw new Error(`its image could not be fetched from ${new URL(url).origin} (${r.status})`);
  return { href: await blobUrl(await r.blob()), width: w, full };
}
