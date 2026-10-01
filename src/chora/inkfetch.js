// The tiles a trace reads, fetched by the page through Chora's remote fetch (src/chora/remote.js
// fetchImage, over the permissions module's fetch): only from the map's image server, under its
// `iiif:<site>` permission, allowed and in this load's policy, with no credentials, following no
// redirect, and asking no new site. Two at a time; a 429 (too many requests) is waited out, as
// Retry-After says when the server lets the page read it, else for a second and then longer; anything
// else refused is said in words. Each tile is decoded as it is (createImageBitmap with no colour-space
// conversion and no premultiplied alpha: the pixels are the image's own) and handed to the worker,
// which keeps it.
//
// The fetched files are kept here too (a few dozen megabytes, the oldest let go first), so that a trace
// again over the same part of the map asks the server for nothing. They are let go for a site as soon
// as its permission is no longer allowed (`prune`, called on every change of the permissions), so a
// trace cannot go on from what a permission withdrawn had fetched.
import { fetchImage, RemoteError } from './remote.js';

export const CONCURRENCY = 2;
export const MAX_RETRIES = 4;
export const CACHE_BYTES = 48 * 1024 * 1024;

/** Why tiles could not be had, in words; kind is 'cors' | 'auth' | 'status' | 'busy' | 'moved' | 'permission' | 'cancelled' | 'other'. */
export class TileError extends Error {
  constructor(message, kind, extra = {}) { super(message); this.name = 'TileError'; this.kind = kind; Object.assign(this, extra); }
}

const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };
const isPermissionError = (e) => e?.name === 'PermissionError';

/** The words for a tile not had: from remote.js's RemoteError, the permissions' PermissionError, or anything else. */
export function tileErrorOf(e, url) {
  if (e instanceof TileError) return e;
  const site = originOf(url) || 'the map\'s server';
  if (e instanceof RemoteError && e.kind === 'status') {
    if (e.status === 401 || e.status === 403) return new TileError(`${site} refused to give the map's pixels for tracing (${e.status}). Maps that need a login (IIIF Auth) cannot be traced here; draw by hand instead.`, 'auth', { status: e.status });
    if (e.status === 429) return new TileError(`${site} is asking the page to slow down (429), and went on refusing; try again in a minute, or draw by hand.`, 'busy', { status: 429 });
    return new TileError(`${site} could not give part of the map for tracing (it answered ${e.status}).`, 'status', { status: e.status });
  }
  if (isPermissionError(e) && e.kind === 'network') {
    // The browser says no more than that the fetch failed: no answer, or one the server does not let other sites read.
    return new TileError(`${site} did not let this page read the map's pixels (it allows no other site to read them: CORS), or did not answer, so the map cannot be traced here; draw by hand instead.`, 'cors');
  }
  if (isPermissionError(e) && e.kind === 'moved') return new TileError(`${site} answered a request for part of the map by sending it elsewhere, which PLATO tools does not follow, so the map cannot be traced here; draw by hand instead.`, 'moved');
  // Not allowed (undecided, never, reload) or not protected: the module's own words, which name the site only.
  if (isPermissionError(e)) return new TileError(e.message, 'permission', { permission: e.kind });
  if (e instanceof RemoteError) return new TileError(e.message, 'other');
  return new TileError(`Part of the map could not be read for tracing (${e?.message || e}).`, 'other');
}

/** Seconds to wait before asking again after a 429: Retry-After (seconds, or a date), else 1, 2, 4… */
export function waitAfter(retryAfter, attempt, now = Date.now()) {
  if (retryAfter != null && retryAfter !== '') {
    const n = Number(retryAfter);
    if (Number.isFinite(n) && n >= 0) return Math.min(n, 30);
    const t = Date.parse(retryAfter);
    if (Number.isFinite(t)) return Math.min(30, Math.max(0, (t - now) / 1000));
  }
  return Math.min(8, 2 ** attempt);
}

/**
 * A fetcher of tiles: `fetch(url)` -> Blob (remote.js fetchImage, by default), `decode(blob)` ->
 * ImageBitmap (createImageBitmap with the options above, by default), `sleep(ms)`, and `allowed(origin)`,
 * whether a site's tiles may still be kept (its `iiif` permission allowed). fetch(urls, { isCurrent,
 * origin }) resolves [{ url, bitmap }] in the order asked, or rejects with a TileError (kind 'cancelled'
 * once isCurrent() is false; any url not on `origin` is refused before anything is asked). prune() lets
 * go of every tile kept from a site no longer allowed, and returns those sites; forget(origin) one site's.
 */
export function createTileFetcher({ fetch = fetchImage, decode = defaultDecode, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), cacheBytes = CACHE_BYTES, allowed = () => true } = {}) {
  const cache = new Map();   // url -> Blob, oldest first
  let bytes = 0;
  const stats = { requests: 0, fromCache: 0, retries: 0, inFlight: 0, maxInFlight: 0 };
  const remember = (url, blob) => {
    if (cache.has(url)) return;
    cache.set(url, blob); bytes += blob.size || 0;
    for (const [k, b] of cache) { if (bytes <= cacheBytes) break; cache.delete(k); bytes -= b.size || 0; }
  };
  function forget(origin) {
    for (const [k, b] of cache) if (originOf(k) === origin) { cache.delete(k); bytes -= b.size || 0; }
  }
  async function one(url, isCurrent) {
    if (cache.has(url)) {
      const b = cache.get(url); cache.delete(url); cache.set(url, b);   // the most recently used, last
      stats.fromCache++;
      return decode(b);
    }
    for (let attempt = 0; ; attempt++) {
      if (!isCurrent()) throw new TileError('Cancelled.', 'cancelled');
      stats.inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight); stats.requests++;
      try {
        const blob = await fetch(url);
        // Kept only while its site is allowed: a permission withdrawn while the tile was on its way keeps nothing.
        if (allowed(originOf(url))) remember(url, blob);
        return await decode(blob);
      } catch (e) {
        if (e instanceof RemoteError && e.kind === 'status' && e.status === 429 && attempt < MAX_RETRIES) {
          stats.retries++;
          await sleep(waitAfter(e.retryAfter, attempt) * 1000);
          continue;
        }
        throw tileErrorOf(e, url);
      } finally { stats.inFlight--; }
    }
  }
  return {
    stats,
    has: (url) => cache.has(url),
    get size() { return cache.size; },
    forget,
    prune() {
      const gone = [...new Set([...cache.keys()].map(originOf))].filter((o) => !allowed(o));
      for (const o of gone) forget(o);
      return gone;
    },
    async fetch(urls, { isCurrent = () => true, origin = null } = {}) {
      // Only the map's own image server: a tile address anywhere else is refused before anything is asked.
      if (origin) {
        const away = urls.find((u) => originOf(u) !== origin);
        if (away) throw new TileError(`A tile of the map is not on its image server (${origin}), so nothing was asked for.`, 'other');
      }
      const out = new Array(urls.length);
      let next = 0, failed = null;
      const lane = async () => {
        while (next < urls.length && !failed) {
          const k = next++;
          try { out[k] = { url: urls[k], bitmap: await one(urls[k], isCurrent) }; } catch (e) { failed ??= e; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, lane));
      if (failed) { for (const t of out) try { t?.bitmap?.close?.(); } catch {} throw failed; }
      return out;
    },
  };
}

function defaultDecode(blob) {
  return createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
}
