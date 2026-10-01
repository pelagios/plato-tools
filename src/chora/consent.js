// The sites the user has agreed that Chora may ask for things, kept in this browser only
// (localStorage 'chora-consent': a list of {origin, kind}). Three kinds, each with its notice:
// - basemap: a basemap's provider, which sees where on the map you look;
// - iiif: a historical map's servers (its image server, and the manifest's site), which see which
//   map you view and which parts of it;
// - allmaps: Allmaps' annotation server (annotations.allmaps.org), asked only when "Look for a
//   georeference" is pressed, which learns which map was looked for.
// A consent is for its kind. The page's Content Security Policy is written from this record at load
// (src/chora/csp-head.js reads the same key, and must be kept in step with it): so a site agreed to
// is reachable from the next load, and one forgotten is unreachable from the next load.
//
// Before there were kinds, basemap consents were a list of origins under 'chora-basemap-consent':
// they are carried over as basemap consents the first time the record is read, and the old key let go.
const KEY = 'chora-consent', LEGACY = 'chora-basemap-consent';
export const KINDS = ['basemap', 'iiif', 'allmaps'];
// The same rule as the policy's (csp-head.js): a plain http(s) origin, in lower case.
const ORIGIN = /^https?:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/;

const store = (st) => st ?? globalThis.localStorage;
function read(st, key) { try { const v = JSON.parse(store(st).getItem(key)); return Array.isArray(v) ? v : []; } catch { return []; } }
function write(st, list) { try { store(st).setItem(KEY, JSON.stringify(list)); } catch {} }

/** The site of an address (its origin), or null. */
export function originOf(url) {
  try { const u = new URL(String(url)); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; }
}
export const isOrigin = (o) => typeof o === 'string' && ORIGIN.test(o);

/** Every consent: [{origin, kind}], each once. Carries the old basemap consents over, once. */
export function list(st) {
  const out = [];
  const add = (origin, kind) => { if (isOrigin(origin) && KINDS.includes(kind) && !out.some((c) => c.origin === origin && c.kind === kind)) out.push({ origin, kind }); };
  for (const c of read(st, KEY)) if (c && typeof c === 'object') add(c.origin, c.kind);
  const legacy = read(st, LEGACY);
  let had = false;
  try { had = store(st).getItem(LEGACY) !== null; } catch {}
  if (had) {
    for (const o of legacy) add(o, 'basemap');
    write(st, out);
    try { store(st).removeItem(LEGACY); } catch {}
  }
  return out;
}
export const consented = (origin, kind, st) => list(st).some((c) => c.origin === origin && c.kind === kind);
/** Every site agreed to, of any kind. */
export const origins = (st) => [...new Set(list(st).map((c) => c.origin))];

/** Agree to these sites for this kind. Throws for anything that is not a plain site, or a kind unknown. */
export function grant(sites, kind, st) {
  if (!KINDS.includes(kind)) throw new TypeError(`${kind} is not a kind of consent (${KINDS.join(', ')})`);
  for (const o of sites) if (!isOrigin(o)) throw new TypeError(`${JSON.stringify(o)} is not a site (an origin such as https://example.org)`);
  const all = list(st);
  for (const o of sites) if (!all.some((c) => c.origin === o && c.kind === kind)) all.push({ origin: o, kind });
  write(st, all);
}
/** Forget every site agreed to, of every kind (the old record too). */
export function forget(st) {
  try { store(st).removeItem(KEY); store(st).removeItem(LEGACY); } catch {}
}

const named = (sites) => (sites.length === 1 ? sites[0] : `${sites.slice(0, -1).join(', ')} and ${sites[sites.length - 1]}`);
const END = 'It sees nothing of your data, which stays in this tab.';
/**
 * The notice shown before a kind of site is first asked for anything: `origins` are the sites not yet
 * agreed to; `name`, what they serve (a basemap's name, a map's title), when known; `fetch`, for
 * Allmaps, the address of the georeference to be fetched (else Allmaps is to be asked to look for one);
 * `maps`, for historical maps, how many are asked about together (the maps kept from last time).
 */
export function notice(kind, { origins: sites = [], name, fetch, maps } = {}) {
  const those = sites.length === 1 ? 'that site' : 'those sites';
  if (kind === 'basemap') {
    return `${name || 'This basemap'} is served by ${named(sites)}. Using it, the map asks ${those} for the part of the world you are looking at, so the provider sees where you look (and your address on the internet, as any website does). ${END}`;
  }
  if (kind === 'iiif' && maps > 1) {
    return `The ${maps} historical maps you had shown are served by ${named(sites)}. Showing them, the page asks ${those} for the maps' descriptions and for the parts of the images you look at, so the providers see which maps you view, and where (and your address on the internet, as any website does). ${END}`;
  }
  if (kind === 'iiif') {
    return `${name ? `The historical map “${name}”` : 'This historical map'} is served by ${named(sites)}. Showing it, the page asks ${those} for the map's description and for the parts of the image you look at, so the provider sees which map you view, and where (and your address on the internet, as any website does). ${END}`;
  }
  if (kind === 'allmaps' && fetch) {
    return `Showing this map fetches its georeference from Allmaps (${named(sites)}), at ${fetch}, so Allmaps sees that it was fetched (and your address on the internet, as any website does). ${END}`;
  }
  if (kind === 'allmaps') {
    return `Looking for a georeference sends the address of the map's image to Allmaps (${named(sites)}), which then knows that this map was looked for (and your address on the internet, as any website does). ${END}`;
  }
  throw new TypeError(`${kind} is not a kind of consent`);
}
