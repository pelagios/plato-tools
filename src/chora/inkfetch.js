// The tiles a trace reads, fetched by the page through the guard (src/chora/fetchguard.js): only from the
// map's image server, which the user has agreed to and the page's policy names, as kind 'iiif', with no
// credentials, and no new site. Two at a time; a 429 (too many requests) is waited out, as Retry-After
// says when the server lets the page read it, else for a second and then longer; anything else refused
// is said in words. Each tile is decoded as it is (createImageBitmap with no colour-space conversion and
// no premultiplied alpha: the pixels are the image's own) and handed to the worker, which keeps it.
//
// The fetched files are kept here too (a few dozen megabytes, the oldest let go first), so that a trace
// again over the same part of the map asks the server for nothing.
import { GuardError } from './fetchguard.js';

export const CONCURRENCY = 2;
export const MAX_RETRIES = 4;
export const CACHE_BYTES = 48 * 1024 * 1024;

/** Why tiles could not be had, in words; kind is 'cors' | 'auth' | 'status' | 'busy' | 'cancelled' | 'other'. */
export class TileError extends Error {
  constructor(message, kind, extra = {}) { super(message); this.name = 'TileError'; this.kind = kind; Object.assign(this, extra); }
}

/** The words for a tile not had. */
export function tileErrorOf(e, url) {
  if (e instanceof TileError) return e;
  const site = (() => { try { return new URL(url).origin; } catch { return 'the map\'s server'; } })();
  if (e instanceof GuardError && e.kind === 'status' && (e.status === 401 || e.status === 403)) {
    return new TileError(`${site} refused to give the map's pixels for tracing (${e.status}). Maps that need a login (IIIF Auth) cannot be traced here; draw by hand instead.`, 'auth', { status: e.status });
  }
  if (e instanceof GuardError && e.kind === 'status' && e.status === 429) return new TileError(`${site} is asking the page to slow down (429), and went on refusing; try again in a minute, or draw by hand.`, 'busy', { status: 429 });
  if (e instanceof GuardError && e.kind === 'status') return new TileError(`${site} could not give part of the map for tracing (it answered ${e.status}).`, 'status', { status: e.status });
  if (e instanceof GuardError && e.kind === 'network') return new TileError(`${site} does not let this page read the map's pixels (it allows no other site to read them: CORS), so the map cannot be traced here; draw by hand instead.`, 'cors');
  if (e instanceof GuardError) return new TileError(e.message, e.kind);
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
 * A fetcher of tiles: `guard` (createGuard's), `decode(blob)` -> ImageBitmap (createImageBitmap with
 * the options above, by default), `sleep(ms)`. fetch(urls, { isCurrent, origin }) resolves [{ url, bitmap }]
 * in the order asked, or rejects with a TileError (kind 'cancelled' once isCurrent() is false; any url not
 * on `origin` is refused before anything is asked).
 */
export function createTileFetcher({ guard, decode = defaultDecode, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), cacheBytes = CACHE_BYTES } = {}) {
  const cache = new Map();   // url -> Blob, oldest first
  let bytes = 0;
  const stats = { requests: 0, fromCache: 0, retries: 0, inFlight: 0, maxInFlight: 0 };
  const remember = (url, blob) => {
    if (cache.has(url)) return;
    cache.set(url, blob); bytes += blob.size || 0;
    for (const [k, b] of cache) { if (bytes <= cacheBytes) break; cache.delete(k); bytes -= b.size || 0; }
  };
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
        const r = await guard.fetch(url, 'iiif');
        const blob = await r.blob();
        remember(url, blob);
        return await decode(blob);
      } catch (e) {
        if (e instanceof GuardError && e.kind === 'status' && e.status === 429 && attempt < MAX_RETRIES) {
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
    async fetch(urls, { isCurrent = () => true, origin = null } = {}) {
      // Only the map's own image server: a tile address anywhere else is refused before anything is asked.
      if (origin) {
        const away = urls.find((u) => { try { return new URL(u).origin !== origin; } catch { return true; } });
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
