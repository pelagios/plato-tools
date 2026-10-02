// The one way Chora fetches a historical map's documents (a georeference, a manifest, an image's
// information, and Allmaps' answers): through the toolbox's permissions (src/lib/permissions.js
// `fetch`), under the permission the address belongs to (`subjectOf`): Allmaps' annotation server is
// `allmaps:allmaps`, any other site `iiif:<its site>`. That fetch asks only a site allowed and in this
// load's policy, sends no credentials, and follows no redirect at all: a server that answers with
// one is refused ('moved'), since the page cannot see where it points (an opaque redirect).
//
// So redirects are avoided here, before asking, where the measurements of 1 October 2026 found them
// (DEVELOPERS.md, Permissions: the table of redirects): an http address is asked over https (every
// server measured redirected http to https, same host and path); an image's information is asked at
// {id}/info.json with no trailing slash (an id alone, or with a slash, was redirected there); and
// Allmaps is asked at /images/<id of the image service>, computed here (its ?url= answers with a
// redirect to that address). What still forwards (an ARK resolver, which sends the request to
// another host) is refused in words that ask the user to open it in a new tab and paste the address
// it ends at: FORWARDS, said beside the address offered as a link (the user's own navigation).
//
// The tiles of a map are NOT fetched here: they are fetched in Allmaps' workers, where no page code
// can see them. The page's Content Security Policy is what holds those (DEVELOPERS.md, Chora).
import * as permissions from '../lib/permissions.js';
import { allmapsLookupUrl, normaliseId } from '../engine/georef/index.js';

export const ALLMAPS_ANNOTATIONS = 'https://annotations.allmaps.org';
export const ALLMAPS_EDITOR = 'https://editor.allmaps.org';

/** What is said of an address that forwards to another (c2's decision, 1 October 2026): no host is named, since none can be read. */
export const FORWARDS = 'This address forwards to another one, which PLATO tools does not follow. Open it in a new tab, and paste the address it ends at.';

/** Why a document was not used: kind is address | permission | moved | status | not-json (and a PermissionError's own kinds). */
export class RemoteError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.name = 'RemoteError'; this.kind = kind; Object.assign(this, extra); }
}

const LOCAL = /^(localhost|127\.0\.0\.1)$/;
/**
 * The address to ask: an http address made https, unless it is this computer's (which may be
 * asked over http, as the permissions allow). Anything that is not an http(s) address is returned
 * as it is, for the caller to refuse.
 */
export function upgrade(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return url; }
  if (u.protocol === 'http:' && !LOCAL.test(u.hostname)) { u.protocol = 'https:'; return u.href; }
  return typeof url === 'string' ? url.trim() : url;
}

/** The permission an address is asked under: ['allmaps', 'allmaps'], ['iiif', <its site>], or null. */
export function subjectOf(url) {
  const o = permissions.originOf(upgrade(url));
  if (!o) return null;
  if (o === ALLMAPS_ANNOTATIONS) return ['allmaps', 'allmaps'];
  return permissions.parse('iiif', o) ? ['iiif', o] : null;
}
/** The 'cat:subj' key of the permission an address is asked under, or null. */
export const keyOfUrl = (url) => { const s = subjectOf(url); return s ? `${s[0]}:${s[1]}` : null; };

/** Where an image's information is asked for: {id}/info.json, the id with no trailing slash, over https. */
export const infoUrl = (serviceId) => `${normaliseId(upgrade(serviceId))}/info.json`;

/**
 * Allmaps' addresses for the georeferences of an image: /images/<the first 16 hex digits of sha1 of
 * the image service's id>, as Allmaps computes them, for the id as written and, if it differs, the
 * id over https. Never ?url=, which Allmaps answers by sending the request to that address.
 */
export async function allmapsImageUrls(serviceId) {
  const ids = [...new Set([serviceId, upgrade(serviceId)].filter((x) => typeof x === 'string' && x))];
  return [...new Set(await Promise.all(ids.map((id) => allmapsLookupUrl(id))))];
}

/**
 * Fetch JSON from `url` under its permission. Throws RemoteError: 'address' (not a site that can be
 * a permission), 'moved' (it answered with a redirect: FORWARDS, with `url`, the address to open),
 * 'status' (it answered, but not with a document: `status`), 'not-json'; or the PermissionError of
 * the module (undecided, never, reload, unprotected, network), which names the site only. Never the
 * module's 'insecure' or 'address': an http address is asked over https (upgrade), and under its own
 * site. A 404 is 'status' with status 404, which a caller may take as "none there".
 */
export async function fetchJson(url, { fetch = permissions.fetch } = {}) {
  const asked = upgrade(url);
  const s = subjectOf(asked);
  if (!s) throw new RemoteError('address', `${String(url)} is not a web address that a permission can cover (only https, or http on this computer).`, { url: asked });
  let r;
  try { r = await fetch(asked, { cat: s[0], subj: s[1], mode: 'cors' }); } catch (e) {
    if (e?.name === 'PermissionError' && e.kind === 'moved') throw new RemoteError('moved', FORWARDS, { url: asked, origin: e.origin, subject: s });
    if (e?.name === 'PermissionError') { e.url = asked; e.subject = s; }
    throw e;
  }
  const site = permissions.originOf(asked);
  if (!r.ok) throw new RemoteError('status', `${site} answered ${r.status}${r.status === 404 ? ' (not found)' : ''}.`, { url: asked, origin: site, status: r.status, subject: s });
  try { return await r.json(); } catch { throw new RemoteError('not-json', `${site} did not answer with JSON.`, { url: asked, origin: site, subject: s }); }
}
