// The basemaps Chora offers (decision D1). The default is Natural Earth, served from this site, so
// that by default nothing leaves the browser. Every other basemap is fetched from its provider, who
// then sees which part of the world is being looked at (never the files: those stay in the tab). So
// each is used only once its provider is allowed in Permissions (src/lib/permissions.js): a built-in
// one's as basemap:<provider> (openfreemap, osm, carto, each with every site it asks, in the
// permissions' REGISTRY), a pasted one's as basemap:<site> for each site it asks.
//
// Kept in this browser: which basemap was chosen last (localStorage 'chora-basemap'), and any pasted
// basemap ('chora-basemaps'), keys and all. A pasted address is sent to nowhere but its own provider.
import { PASTED_BASEMAP } from '../engine/words.js';
import * as permissions from '../lib/permissions.js';

// CARTO's vector basemaps need an API key, scoped by referrer to the published site (so it never
// works from localhost). It is given at build time as VITE_CARTO_API_KEY, never written in a file
// here; without it the three CARTO entries are shown, disabled. (The form of a keyed CARTO style
// address is to be confirmed with the key: this assumes the key as a query parameter.)
const CARTO_KEY = import.meta.env?.VITE_CARTO_API_KEY || '';

const NE_STYLE = './basemap/style.json';
const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/**
 * Each basemap: {id, name, group, kind: 'style' | 'raster', url (a style address) or tiles (a tile
 * template), provider (its permission's id) or origins (a pasted one's sites), attribution?,
 * disabled?: reason}. `local` marks the one served from this site. A style's sources, glyphs and
 * sprites may be on sites other than the style's own, and a TileJSON's tiles on others again, so each
 * provider in the permissions' REGISTRY lists them all, as found in its styles and TileJSON (fetched,
 * without a key, on 30 September 2026).
 */
export function builtIn() {
  const carto = (name, label) => ({
    id: `carto-${name}`, name: `CARTO ${label}`, group: 'CARTO', kind: 'style', provider: 'carto',
    url: `https://basemaps.cartocdn.com/gl/${name}-gl-style/style.json${CARTO_KEY ? `?api_key=${encodeURIComponent(CARTO_KEY)}` : ''}`,
    disabled: CARTO_KEY ? null : 'needs an API key: not yet configured',
  });
  const ofm = (name, label) => ({ id: `ofm-${name}`, name: `OpenFreeMap ${label}`, group: 'OpenFreeMap', kind: 'style', provider: 'openfreemap', url: `https://tiles.openfreemap.org/styles/${name}` });
  return [
    { id: 'natural-earth', name: 'Natural Earth (this site)', group: 'This site', kind: 'style', url: NE_STYLE, local: true },
    ofm('liberty', 'Liberty'), ofm('bright', 'Bright'), ofm('positron', 'Positron'),
    { id: 'osm', name: 'OpenStreetMap standard', group: 'OpenStreetMap', kind: 'raster', provider: 'osm', tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: OSM_ATTRIBUTION, maxzoom: 19 },
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
  try { return new URL((b.url || b.tiles).replace(/[{}]/g, '_'), globalThis.location?.href).origin; } catch { return null; }
}

/**
 * Every site a basemap asks: a built-in one's provider's (the permissions' REGISTRY); a pasted one's own
 * site, and, once its style has been read, every site the style names (styleOrigins, kept on it as
 * `origins`); this site for Natural Earth.
 */
export function originsOf(b) {
  if (!b || b.local) return [location.origin];
  if (b.provider) return permissions.originsFor('basemap', b.provider);
  return Array.isArray(b.origins) && b.origins.length ? b.origins : [originOf(b)].filter(Boolean);
}
/** The permissions a basemap needs, as [category, subject] pairs: none for Natural Earth. */
export function subjectsOf(b) {
  if (!b || b.local) return [];
  if (b.provider) return [['basemap', b.provider]];
  return originsOf(b).filter(permissions.isOrigin).map((o) => ['basemap', o]);
}
/** Whether a basemap may be used now: every permission it needs allowed, and in this load's policy. */
export const permitted = (b) => !!b && (b.local || (subjectsOf(b).length > 0 && subjectsOf(b).every(([c, s]) => permissions.allowed(c, s))));
/** Whether any permission it needs is set to Never: then it is not offered. */
export const refused = (b) => subjectsOf(b).some(([c, s]) => permissions.state(c, s) === 'never');

/**
 * The sites a style names (its sources' TileJSON, tiles and data, its glyphs and sprites), each once,
 * in order; a relative address is on the style's own site, `base`. Not those a TileJSON names in turn.
 */
export function styleOrigins(style, base) {
  const s = resolveStyle(style, base), urls = [];
  for (const src of Object.values(s.sources || {})) {
    if (typeof src?.data === 'string') urls.push(src.data);
    if (typeof src?.url === 'string') urls.push(src.url);
    if (Array.isArray(src?.tiles)) urls.push(...src.tiles);
  }
  urls.push(s.glyphs, ...[].concat(s.sprite || []).map((x) => (typeof x === 'string' ? x : x?.url)));
  const out = new Set();
  for (const u of urls) {
    if (typeof u !== 'string' || /^(data|blob):/i.test(u)) continue;
    try { out.add(new URL(u.replace(/[{}]/g, '_')).origin); } catch {}
  }
  return [...out].filter((o) => o !== 'null').sort();
}

/** The basemap chosen last in this browser, whether or not it may be used yet. */
export const wanted = () => byId(get('chora-basemap', 'natural-earth'));
/** The basemap to show: the one chosen last, if it is on offer and permitted, else Natural Earth. */
export function current() {
  const b = wanted();
  return b && !b.disabled && permitted(b) ? b : byId('natural-earth');
}
export const choose = (b) => put('chora-basemap', b.id);

/** What a drawing's note says it was drawn on: a built-in basemap's name; never a pasted one's site. */
export const drawnOn = (b) => (!b || b.local ? 'Natural Earth' : b.group === 'Pasted' ? PASTED_BASEMAP : b.name);

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
 * its tiles is asked of the provider; a pasted style is fetched here too, through the permissions'
 * fetch, so that the sites it names can be found (styleOrigins) before MapLibre asks any of them; a
 * built-in one is given by its address, for MapLibre to fetch (through the map's transformRequest).
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
  if (b.group === 'Pasted') {
    const r = await permissions.fetch(b.url, { cat: 'basemap', subj: originOf(b) });
    if (!r.ok) throw new Error(`its style could not be read (${r.status})`);
    let style;
    try { style = await r.json(); } catch { throw new Error('its address is not that of a style'); }
    if (!style || typeof style !== 'object' || style.version !== 8) throw new Error('its address is not that of a style');
    return resolveStyle(style, b.url);
  }
  return b.url;
}
