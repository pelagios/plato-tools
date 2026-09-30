// The basemaps Chora offers (decision D1). The default is Natural Earth, served from this site, so
// that by default nothing leaves the browser. Every other basemap is fetched from its provider, who
// then sees which part of the world is being looked at (never the files: those stay in the tab). So
// each is used only after a notice naming the provider's address, and map.js refuses any request to
// another site unless the basemap chosen is served from it.
//
// Choices are remembered in this browser only: which basemap (localStorage 'chora-basemap'), which
// providers were agreed to ('chora-basemap-consent'), and any pasted basemap ('chora-basemaps'),
// keys and all. A pasted address is sent to nowhere but its own provider.

// CARTO's vector basemaps need an API key, scoped by referrer to the published site (so it never
// works from localhost). It is given at build time as VITE_CARTO_API_KEY, never written in a file
// here; without it the three CARTO entries are shown, disabled. (The form of a keyed CARTO style
// address is to be confirmed with the key: this assumes the key as a query parameter.)
const CARTO_KEY = import.meta.env?.VITE_CARTO_API_KEY || '';

const NE_STYLE = './basemap/style.json';
const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/**
 * Each basemap: {id, name, group, kind: 'style' | 'raster', url (a style address) or tiles (a tile
 * template), attribution?, disabled?: reason}. `local` marks the one served from this site.
 */
export function builtIn() {
  const carto = (name, label) => ({
    id: `carto-${name}`, name: `CARTO ${label}`, group: 'CARTO', kind: 'style',
    url: `https://basemaps.cartocdn.com/gl/${name}-gl-style/style.json${CARTO_KEY ? `?api_key=${encodeURIComponent(CARTO_KEY)}` : ''}`,
    disabled: CARTO_KEY ? null : 'needs an API key: not yet configured',
  });
  const ofm = (name, label) => ({ id: `ofm-${name}`, name: `OpenFreeMap ${label}`, group: 'OpenFreeMap', kind: 'style', url: `https://tiles.openfreemap.org/styles/${name}` });
  return [
    { id: 'natural-earth', name: 'Natural Earth (this site)', group: 'This site', kind: 'style', url: NE_STYLE, local: true },
    ofm('liberty', 'Liberty'), ofm('bright', 'Bright'), ofm('positron', 'Positron'),
    { id: 'osm', name: 'OpenStreetMap standard', group: 'OpenStreetMap', kind: 'raster', tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: OSM_ATTRIBUTION, maxzoom: 19 },
    carto('positron', 'Positron'), carto('voyager', 'Voyager'), carto('dark-matter', 'Dark Matter'),
  ];
}

const get = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

/** The basemaps pasted in this browser. */
export const pasted = () => get('chora-basemaps', []).filter((b) => b && b.id && (b.url || b.tiles));
/** Every basemap on offer: the built-in ones, then those pasted here. */
export const all = () => [...builtIn(), ...pasted()];
export const byId = (id) => all().find((b) => b.id === id) || null;

/**
 * A basemap from a pasted address: a raster tile template if it has {z}, {x} and {y} in it, else the
 * address of a MapLibre style. Null, with no error, when it is not an https address at all.
 */
export function fromPaste(text) {
  const s = String(text).trim();
  let u;
  try { u = new URL(s.replace(/[{}]/g, '_')); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const raster = /\{z\}/.test(s) && /\{x\}/.test(s) && /\{y\}/.test(s);
  const id = 'pasted-' + [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);
  return raster ? { id, name: `Your tiles from ${u.host}`, group: 'Pasted', kind: 'raster', tiles: s, attribution: `Tiles from ${u.host}` }
    : { id, name: `Your style from ${u.host}`, group: 'Pasted', kind: 'style', url: s };
}
export function addPasted(b) { put('chora-basemaps', [...pasted().filter((x) => x.id !== b.id), b]); }
export function removePasted(id) { put('chora-basemaps', pasted().filter((x) => x.id !== id)); }

/** The site a basemap's requests go to: its style's or its tiles' origin; this site's for Natural Earth. */
export function originOf(b) {
  if (!b || b.local) return location.origin;
  try { return new URL((b.url || b.tiles).replace(/[{}]/g, '_'), location.href).origin; } catch { return null; }
}

/** The basemap chosen last in this browser, if it is still on offer (and consented to), else Natural Earth. */
export function current() {
  const b = byId(get('chora-basemap', 'natural-earth'));
  return b && !b.disabled && (b.local || consented(originOf(b))) ? b : byId('natural-earth');
}
export const choose = (b) => put('chora-basemap', b.id);
export const consented = (origin) => get('chora-basemap-consent', []).includes(origin);
export const consent = (origin) => put('chora-basemap-consent', [...new Set([...get('chora-basemap-consent', []), origin])]);

/** The notice shown before a basemap from another site is first used. */
export function notice(b) {
  return `${b.name} is served by ${originOf(b)}. Using it, the map asks that site for the part of the world you are looking at, so the provider sees where you look (and your address on the internet, as any website does). It sees nothing of your data, which stays in this tab.`;
}

// A style's addresses, made absolute against the style's own address. Natural Earth's style writes
// each as {base}/..., {base} standing for its folder (public/basemap/README.md); a plain relative
// address is resolved the same way, as MapLibre would otherwise resolve it against the page, not the
// style. URL() escapes the braces of a template ({z}, {fontstack}), so they are put back.
function absolute(u, base) {
  if (typeof u !== 'string') return u;
  // {base} by plain replacement: URL() would escape the braces of {fontstack} and {range}.
  if (u.startsWith('{base}/')) return new URL('.', base).href.replace(/\/$/, '') + u.slice('{base}'.length);
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  return new URL(u, base).href.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
}
export function resolveStyle(style, base) {
  const s = structuredClone(style);
  for (const src of Object.values(s.sources || {})) {
    if (typeof src.data === 'string') src.data = absolute(src.data, base);
    if (src.url) src.url = absolute(src.url, base);
    if (Array.isArray(src.tiles)) src.tiles = src.tiles.map((t) => absolute(t, base));
  }
  if (s.glyphs) s.glyphs = absolute(s.glyphs, base);
  if (typeof s.sprite === 'string') s.sprite = absolute(s.sprite, base);
  else if (Array.isArray(s.sprite)) s.sprite = s.sprite.map((x) => ({ ...x, url: absolute(x.url, base) }));
  return s;
}

/**
 * The style to give MapLibre for a basemap. Natural Earth's is fetched here, from this site, and its
 * addresses made absolute; a raster basemap is wrapped in a style of one layer, so that nothing but
 * its tiles is asked of the provider; another style is given by its address,
 * for MapLibre to fetch (through map.js's guard).
 */
export async function styleFor(b) {
  if (b.local) {
    const url = new URL(b.url, location.href).href;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`The Natural Earth basemap could not be read (${r.status})`);
    return resolveStyle(await r.json(), url);
  }
  if (b.kind === 'raster') {
    return {
      version: 8,
      sources: { basemap: { type: 'raster', tiles: [b.tiles], tileSize: 256, maxzoom: b.maxzoom || 19, attribution: b.attribution || '' } },
      layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
    };
  }
  return b.url;
}
