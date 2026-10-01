// The pure core of the toolbox's permissions: what a permission is, which sites each one lets the
// tools ask, and the Content Security Policy that follows from a set of them. No storage, no page, no
// imports, so that the command line can use it and so that the build can put it, as it is, into the
// first script of each page's <head> (scripts/vite-csp.mjs strips the word `export` and wraps it):
// keep it free of imports and of `export { … }` lists, and write nothing here that needs a page.
//
// A permission is (category, subject). The category is what the site learns:
// - basemap: a basemap's provider (a REGISTRY id, or the site of a basemap you pasted), which sees
//   which part of the world you look at;
// - iiif: a historical map's server (a site), which sees which map you view, and where;
// - allmaps: Allmaps' annotation service (a REGISTRY id), which learns which map was looked for;
// - gazetteer: a gazetteer's service (the REGISTRY's whg, or another service's site), which sees
//   the names you look up;
// - linked: a site a dataset links to (a site), which sees which of its pages you open.
// Its state is 'allowed', 'never', or, when nothing is recorded, 'undecided'.

/** The categories, each with whether a subject may be a site (an origin) rather than a REGISTRY id. */
export const CATEGORIES = {
  basemap: { sites: true },
  iiif: { sites: true },
  allmaps: { sites: false },
  gazetteer: { sites: true },
  linked: { sites: true },
};

/**
 * The services the tools know by name, by category: each declares EVERY site it asks (a style's
 * glyphs, sprites and tiles may be on sites other than its own: CARTO's are on six). Their names, for
 * people, are in permission-words.js.
 */
export const REGISTRY = {
  basemap: {
    openfreemap: { origins: ['https://tiles.openfreemap.org'] },
    osm: { origins: ['https://tile.openstreetmap.org'] },
    carto: { origins: ['https://basemaps.cartocdn.com', 'https://tiles.basemaps.cartocdn.com', 'https://tiles-a.basemaps.cartocdn.com', 'https://tiles-b.basemaps.cartocdn.com', 'https://tiles-c.basemaps.cartocdn.com', 'https://tiles-d.basemaps.cartocdn.com'] },
  },
  iiif: {},
  allmaps: { allmaps: { origins: ['https://annotations.allmaps.org'] } },
  gazetteer: { whg: { origins: ['https://whgazetteer.org', 'https://www.whgazetteer.org'] } },
  linked: {},
};

export const STATES = ['allowed', 'never'];

// A plain http(s) origin, in lower case, with nothing after it: no path, no space, no quote, no
// semicolon, no wildcard. Only such a string ever reaches the policy, so nothing kept in storage can
// add a directive or widen one.
export const ORIGIN = /^https?:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/;
const ID = /^[a-z][a-z0-9-]{0,40}$/;

export function isOrigin(o) { return typeof o === 'string' && ORIGIN.test(o); }

/** The site (origin) of an http(s) address, or null. */
export function originOf(url) {
  try { const u = new URL(String(url)); return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null; } catch (e) { return null; }
}

/** The key a permission is kept under: 'category:subject'. */
export function keyOf(cat, subj) { return cat + ':' + subj; }

/** {cat, subj} from a key, or from a category and a subject; null for anything not a permission. */
export function parse(catOrKey, subj) {
  let cat = catOrKey;
  if (subj === undefined) {
    if (typeof catOrKey !== 'string') return null;
    const i = catOrKey.indexOf(':');
    if (i < 0) return null;
    cat = catOrKey.slice(0, i); subj = catOrKey.slice(i + 1);
  }
  if (typeof cat !== 'string' || typeof subj !== 'string' || !Object.prototype.hasOwnProperty.call(CATEGORIES, cat)) return null;
  if (ID.test(subj) && Object.prototype.hasOwnProperty.call(REGISTRY[cat], subj)) return { cat: cat, subj: subj };
  if (CATEGORIES[cat].sites && isOrigin(subj)) return { cat: cat, subj: subj };
  return null;
}

/** Every site a permission lets the tools ask; [] for anything not a permission. */
export function originsFor(cat, subj) {
  const p = parse(cat, subj);
  if (!p) return [];
  return isOrigin(p.subj) ? [p.subj] : REGISTRY[p.cat][p.subj].origins.slice();
}

/**
 * Grants as kept ({key: {state, at, added}}), cleaned: an entry that is not a permission, or whose
 * state is not one of STATES, is dropped, whatever put it there.
 */
export function normalise(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of Object.keys(raw)) {
    const g = raw[key], p = parse(key);
    if (!p || !g || typeof g !== 'object' || STATES.indexOf(g.state) < 0) continue;
    const clean = { state: g.state };
    if (typeof g.at === 'string' && g.at.length <= 40) clean.at = g.at;
    if (g.added === true) clean.added = true;
    out[keyOf(p.cat, p.subj)] = clean;
  }
  return out;
}

/**
 * A permission's state: 'allowed', 'never' or 'undecided'. `tab` is the keys allowed for this tab
 * only. Never beats allowing for the tab: a site refused for good stays refused.
 */
export function check(grants, cat, subj, tab) {
  const p = parse(cat, subj);
  if (!p) return 'undecided';
  const k = keyOf(p.cat, p.subj), g = grants && Object.prototype.hasOwnProperty.call(grants, k) ? grants[k] : null;
  if (g && g.state === 'never') return 'never';
  if (g && g.state === 'allowed') return 'allowed';
  if (tab && tab.indexOf(k) >= 0) return 'allowed';
  return 'undecided';
}

/** Every site the allowed permissions name, each once, sorted: what the policy lets the page reach. */
export function allowedOrigins(grants, tab) {
  const keys = Object.keys(grants || {}).concat(tab || []), out = [];
  for (const k of keys) {
    const p = parse(k);
    if (!p || check(grants, p.cat, p.subj, tab) !== 'allowed') continue;
    for (const o of originsFor(p.cat, p.subj)) if (isOrigin(o) && out.indexOf(o) < 0) out.push(o);
  }
  return out.sort();
}

/**
 * The Content Security Policy for these sites (each checked again here). The page and the workers
 * it makes from a blob: may connect to, and show images from, this site and these only.
 */
export function policyFor(origins) {
  const ok = (origins || []).filter(isOrigin);
  const sites = ok.length ? ' ' + ok.join(' ') : '';
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:" + sites,
    "connect-src 'self' blob:" + sites,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * Chora's basemap consents from before there were permissions (a list of origins under
 * 'chora-basemap-consent'), as grants: a provider of the REGISTRY whose every site is in the list
 * becomes basemap:<id>; every other site in it, basemap:<site>, as a pasted basemap's. Grants already
 * made are not changed. Returns new grants; the caller removes the old key.
 */
export function migrateBasemapConsent(grants, legacy, now) {
  const out = Object.assign({}, grants || {});
  const list = (Array.isArray(legacy) ? legacy : []).filter(isOrigin);
  const used = [];
  const at = now || new Date().toISOString();
  for (const id of Object.keys(REGISTRY.basemap)) {
    const os = REGISTRY.basemap[id].origins;
    if (os.every((o) => list.indexOf(o) >= 0)) {
      if (!out[keyOf('basemap', id)]) out[keyOf('basemap', id)] = { state: 'allowed', at: at };
      used.push.apply(used, os);
    }
  }
  for (const o of list) {
    if (used.indexOf(o) >= 0 || out[keyOf('basemap', o)]) continue;
    out[keyOf('basemap', o)] = { state: 'allowed', at: at, added: true };
  }
  return out;
}

/**
 * The command line has no settings: the flag is the consent. `gazetteer` (from --gazetteer, a REGISTRY
 * id or a service's address) and `allowHost` (from each --allow-host, a site) become grants for that
 * run alone, to be read with check(). A value that is not a site or a known service is returned in
 * `refused`, for the command to report.
 */
export function fromFlags(flags) {
  const grants = {}, refused = [];
  const f = flags || {};
  for (const g of [].concat(f.gazetteer || [])) {
    const s = String(g);
    const p = parse('gazetteer', s) || parse('gazetteer', originOf(s) || '');
    if (p) grants[keyOf(p.cat, p.subj)] = { state: 'allowed' }; else refused.push(s);
  }
  for (const h of [].concat(f.allowHost || [])) {
    const s = String(h), o = isOrigin(s) ? s : originOf(s);
    if (!o) { refused.push(s); continue; }
    for (const cat of ['iiif', 'linked']) grants[keyOf(cat, o)] = { state: 'allowed' };
  }
  return { grants: grants, refused: refused };
}
