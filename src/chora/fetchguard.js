// The one way Chora fetches a historical map's documents (its annotation, its manifest, its image
// information, and Allmaps' answers): only from a site the user has agreed to for that kind of
// request (src/chora/consent.js), and only once that site is in the page's Content Security Policy
// (src/chora/csp.js), never with credentials. What it refuses it counts, and names, on `state`
// (iiifBlocked, iiifBlockedOrigins); what it asks, it counts (iiifRequests).
//
// Redirects: with { redirect: 'error' } any redirect is refused (image information is fetched so,
// since a map's tiles are built from where it says the image is). Otherwise a redirect is followed,
// but a document that ends up on another site is refused, even a site agreed to: what was agreed to
// was this site's document. (The policy stops a hop to a site not agreed to before it is made.)
//
// The tiles of a map are NOT fetched here: they are fetched in Allmaps' workers, where no page code can
// see them. The policy is what guards those (see DEVELOPERS.md, Chora).

/** Why a document was not fetched: kind is consent | reload | redirect | moved | status | network | not-json. */
export class GuardError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.name = 'GuardError'; this.kind = kind; Object.assign(this, extra); }
}

const originOf = (url) => { try { const u = new URL(String(url)); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; } };

/**
 * A guard over `fetch`. consented(origin, kind) and inPolicy(origin) say what may be asked.
 * Returns { fetch(url, kind, options) -> Response, json(url, kind, options) -> parsed JSON }.
 */
export function createGuard({ state, consented, inPolicy, fetch = globalThis.fetch.bind(globalThis) }) {
  state.iiifRequests ??= 0; state.iiifBlocked ??= 0; state.iiifBlockedOrigins ??= [];
  async function guarded(url, kind, { redirect = 'follow' } = {}) {
    const origin = originOf(url);
    if (!origin) throw new GuardError('consent', `${url} is not a web address this page may ask.`, { origin: null });
    if (!consented(origin, kind)) {
      state.iiifBlocked++;
      if (!state.iiifBlockedOrigins.includes(origin)) state.iiifBlockedOrigins.push(origin);
      throw new GuardError('consent', `${origin} has not been agreed to.`, { origin });
    }
    if (!inPolicy(origin)) throw new GuardError('reload', `${origin} was agreed to after this page loaded; it can be reached after a reload.`, { origin });
    state.iiifRequests++;
    let r;
    try { r = await fetch(url, { redirect, credentials: 'omit', mode: 'cors' }); } catch (e) {
      if (redirect === 'error') throw new GuardError('redirect', `${url} did not answer, or answered by sending the request elsewhere, which is not accepted for this.`, { origin });
      throw new GuardError('network', `${url} could not be reached (${e?.message || e}); the server may not allow other sites to read it (CORS).`, { origin });
    }
    const landed = originOf(r.url || url);
    if (landed && landed !== origin) throw new GuardError('moved', `${url} sent the request on to ${landed}, another site, so its answer was not used.`, { origin, landed });
    if (!r.ok) throw new GuardError('status', `${url} answered ${r.status}.`, { origin, status: r.status });
    return r;
  }
  return {
    fetch: guarded,
    async json(url, kind, options) {
      const r = await guarded(url, kind, options);
      try { return await r.json(); } catch { throw new GuardError('not-json', `${url} did not answer with JSON.`, { origin: originOf(url) }); }
    },
  };
}
