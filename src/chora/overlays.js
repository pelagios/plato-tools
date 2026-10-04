// Historical maps over Chora's basemap: a IIIF image placed in the world by a IIIF Georeference
// Annotation, drawn by Allmaps' renderer (@allmaps/maplibre, loaded only when a map is first shown).
//
// How a map gets onto the page, one step at a time, each step asking only sites whose permission is
// allowed (src/lib/permissions.js: iiif:<site> for a map's servers, allmaps:allmaps for Allmaps), every
// document fetched through src/chora/remote.js:
// 1. parseInput: what was pasted. A georeference (its JSON, or its address), an Allmaps address or
//    map id, a IIIF manifest's address, or an image's (its service, info.json, or a picture of it).
// 2. resolve: the georeference, and the manifest it names when there is one (for the canvas's size,
//    which a citation of a region of the canvas needs). Every permission this needs is named at once
//    (NeedPermission), before anything is fetched; a manifest's images are known only once it is
//    read, so a manifest is one step and its images the next. With no georeference, nothing is looked
//    for unless the user presses "Look for a georeference" (lookup: Allmaps, by the image's id), and
//    otherwise the user may georeference it in the Allmaps Editor and paste the georeference back.
// 3. admit: the georeference read (src/engine/georef/), then the image's information (info.json)
//    fetched here (no redirect is ever followed), and refused unless the id it gives is exactly the image the
//    georeference names: the renderer builds the tiles' addresses from that id, so an id elsewhere
//    would send every tile request elsewhere. It is then given to the renderer (addImageInfos), which
//    so makes no request for it of its own, and the georeference after it.
// 4. The renderer's tile workers (made from blob:, so under the page's policy) fetch the tiles. No
//    page code can see those requests: the page's Content Security Policy (src/lib/csp-head.js) is what
//    keeps them to the image's site, redirects included, and maps are refused altogether unless the
//    permissions' canary found the policy enforced (permissions.enforced()).
//
// The renderer takes the annotation's transformation type but not a polynomial's order, so after
// adding a map its transformation is set again from the georeference (georef's allmapsTransformationName):
// otherwise an order-2 or order-3 map would be drawn at order 1, and traced at its own order.
//
// Maps shown are kept on the origin private file system (chora-overlays/, one file each) and shown
// again on the next load, admitted afresh (so a permission withdrawn is needed again).
import { readGeoreference, allmapsTransformationName, normaliseId, manifestCanvases, labelText, parseImageRequest, partOfCanvases } from '../engine/georef/index.js';
import { DataError } from '../engine/input.js';
import { ALLMAPS_ANNOTATIONS, ALLMAPS_EDITOR, RemoteError, subjectOf, upgrade, infoUrl, allmapsImageUrls } from './remote.js';

export { ALLMAPS_ANNOTATIONS, ALLMAPS_EDITOR, allmapsTransformationName };

/**
 * The permissions a step needs before it can go on, each [category, subject], all of those not yet
 * allowed named at once (so that one reload brings them all). `fetch`, when the step is to fetch a
 * georeference from that address (not to look for one).
 */
export class NeedPermission extends Error {
  constructor(subjects, { name, fetch, maps } = {}) {
    super(`${subjects.map((s) => s.join(':')).join(', ')} must be allowed in Permissions first.`);
    this.name = 'NeedPermission'; this.subjects = subjects; this.mapName = name;
    if (fetch) this.fetch = fetch;
    if (maps) this.maps = maps;
  }
}
/** The permission of each address, or a RemoteError ('address') for one that cannot have one. */
function subjectsOf(urls) {
  const out = [];
  for (const u of urls.filter(Boolean)) {
    const s = subjectOf(u);
    if (!s) throw new RemoteError('address', `${u} is not at a site that can be allowed in Permissions (only a plain https address, such as https://example.org, can be), so it was not asked.`, { url: u });
    if (!out.some((x) => x[0] === s[0] && x[1] === s[1])) out.push(s);
  }
  return out;
}

/**
 * A page of several georeferences (Allmaps' /images/<id> often holds several of one image): the user
 * chooses one. `choices` [{ index, id, label, modified, gcps }], `defaultIndex` the most recently
 * changed; `annotation`, `fetchedAt` and `url` are what was fetched, so that nothing is fetched again.
 */
export class NeedChoice extends Error {
  constructor(annotation, { fetchedAt = null, url = null, manifest = null } = {}) {
    const choices = choicesOf(annotation);
    super(`The georeference holds ${choices.length} georeferences of the map: choose one.`);
    this.name = 'NeedChoice'; this.annotation = annotation; this.choices = choices; this.defaultIndex = newestChoice(choices);
    this.fetchedAt = fetchedAt; this.url = url; this.manifest = manifest;
  }
}
const itemsOf = (a) => (typeOf(a) === 'AnnotationPage' ? (Array.isArray(a.items) ? a.items : []) : [a]);
/** Each georeference of a page, as the choice shows it: { index, id, label, modified, gcps }. */
export function choicesOf(annotation) {
  return itemsOf(annotation).map((item, index) => {
    const source = item?.target?.source || {};
    const canvas = partOfCanvases(source)[0];
    const label = labelText(item?.label) || (canvas && labelText(canvas.label)) || null;
    const when = [item?.modified, item?.created].find((d) => typeof d === 'string' && !Number.isNaN(Date.parse(d))) || null;
    const gcps = Array.isArray(item?.body?.features) ? item.body.features.length : null;
    return { index, id: item?.id ?? item?.['@id'] ?? null, label, modified: when, gcps };
  });
}
/** The index of the most recently changed (the first, when none says when; a date beats none). */
export function newestChoice(choices) {
  let best = choices[0]?.index ?? 0, at = -Infinity;
  for (const c of choices) { const t = c.modified ? Date.parse(c.modified) : NaN; if (Number.isFinite(t) && t > at) { at = t; best = c.index; } }
  return best;
}

// ---- 1. What was pasted --------------------------------------------------------------------------

const typeOf = (o) => (o && typeof o === 'object' ? o.type ?? o['@type'] : undefined);
const isAnnotation = (o) => ['Annotation', 'AnnotationPage'].includes(typeOf(o));
const isManifest = (o) => ['Manifest', 'sc:Manifest'].includes(typeOf(o));
const isImageInfo = (o) => !!o && typeof o === 'object' && (/^ImageService[23]$/.test(String(o.type || '')) || o.protocol === 'http://iiif.io/api/image' || /iiif\.io\/api\/image\//.test(JSON.stringify(o['@context'] || '')));

/**
 * What the user pasted: { kind, … } with kind
 * - 'annotation' { annotation }: a georeference given as JSON (an Annotation or AnnotationPage);
 * - 'manifest-json' { manifest }: a IIIF manifest given as JSON;
 * - 'annotation-url' { url }: the address of a georeference (Allmaps' annotation server, any address
 *   with a map id, or one given to Allmaps' viewer);
 * - 'manifest' { url }: a manifest's address;
 * - 'service' { serviceId }: an image service (its address, its info.json, or a picture of it);
 * - 'allmaps-image' { serviceId }: Allmaps' ?url= address for an image (its id or info.json), which
 *   Allmaps answers by forwarding: asked instead where it forwards to, /images/<id>, as lookup asks;
 * - 'url' { url }: an address that is none of those by its look: fetched, and read for what it is;
 * - 'error' { message }.
 */
export function parseInput(text) {
  const s = String(text ?? '').trim();
  if (!s) return { kind: 'error', message: 'Paste a georeference, or the address of a map.' };
  if (s.startsWith('{') || s.startsWith('[')) {
    let o;
    try { o = JSON.parse(s); } catch (e) { return { kind: 'error', message: `That is not well-formed JSON (${String(e.message).split('\n')[0]}).` }; }
    if (isAnnotation(o)) return { kind: 'annotation', annotation: o };
    if (isManifest(o)) return { kind: 'manifest-json', manifest: o };
    if (isImageInfo(o) && (o.id || o['@id'])) return { kind: 'service', serviceId: normaliseId(o.id || o['@id']) };
    return { kind: 'error', message: 'That JSON is not a georeference (a IIIF Georeference Annotation), a IIIF manifest, or an image\'s information.' };
  }
  if (/^[0-9a-f]{16}$/i.test(s)) return { kind: 'annotation-url', url: `${ALLMAPS_ANNOTATIONS}/maps/${s.toLowerCase()}` };
  let u;
  try { u = new URL(s); } catch { return { kind: 'error', message: 'That is neither JSON nor a web address.' }; }
  if (!/^https?:$/.test(u.protocol)) return { kind: 'error', message: 'Only http and https addresses can be used.' };
  // Asked over https (an http address is redirected there by every server measured), but for this computer's.
  u = new URL(upgrade(u.href));
  if (u.origin === ALLMAPS_ANNOTATIONS) {
    // ?url= of an image forwards to /images/<id>, computed here; of anything else, it is fetched as it is (and refused as forwarding).
    const inner = u.pathname === '/' && u.searchParams.get('url') ? parseInput(u.searchParams.get('url')) : null;
    if (inner?.kind === 'allmaps-image') return inner;
    if (inner?.kind === 'service') return { kind: 'allmaps-image', serviceId: inner.serviceId };
    if (inner?.kind === 'url') return { kind: 'allmaps-image', serviceId: normaliseId(inner.url) };
    return { kind: 'annotation-url', url: u.href };
  }
  // Allmaps' viewer and editor take the map's address in ?url=.
  if (/^(viewer|editor)\.allmaps\.org$/.test(u.hostname) && u.searchParams.get('url')) {
    const inner = parseInput(u.searchParams.get('url'));
    return inner.kind === 'url' && u.hostname.startsWith('viewer') ? { kind: 'annotation-url', url: inner.url } : inner;
  }
  if (/\/info\.json$/.test(u.pathname)) return { kind: 'service', serviceId: normaliseId(u.origin + u.pathname) };
  const picture = parseImageRequest(u.origin + u.pathname);
  if (picture) return { kind: 'service', serviceId: picture.service };
  if (/manifest(\.json)?$/i.test(u.pathname) || /\/manifests?\//i.test(u.pathname)) return { kind: 'manifest', url: u.href };
  return { kind: 'url', url: u.href };
}

// ---- 2. The georeference and its manifest --------------------------------------------------------

/** The image service and manifest a georeference names (its first map's). */
export function namedIn(annotation) {
  const items = typeOf(annotation) === 'AnnotationPage' ? (annotation.items || []) : [annotation];
  const first = items.find((a) => a && a.target) || {};
  const source = first.target?.source || (typeof first.target === 'string' ? { id: first.target } : {});
  const service = normaliseId(source.id || source['@id']);
  const manifest = partOfCanvases(source).map((p) => p.manifestId).find(Boolean) || null;
  return { service: service || null, manifest };
}

/**
 * Follow what was pasted to a georeference (and its manifest), fetching with `fetchJson`
 * (src/chora/remote.js) only under permissions `allowed(cat, subj)` says may be asked now (allowed, and
 * in this load's policy); `state(cat, subj)` says which are set to Never. Returns
 * - { annotation, manifest, manifestUrl, fetchedAt, notes } ready for admit(); fetchedAt is when the
 *   georeference was fetched (an ISO date-time), or null when it was pasted;
 * - or { services, manifest, manifestUrl, title }: a map with no georeference given, to look for one.
 * Throws NeedPermission for the permissions a step needs first (all of them at once, as far as they
 * are known), NeedChoice for a page of several georeferences, RemoteError or the permissions'
 * PermissionError when a fetch fails, DataError when what was found is not what it should be.
 */
export async function resolve(parsed, deps) {
  const { fetchJson, allowed, state = () => 'undecided', now = () => new Date().toISOString() } = deps;
  const need = (urls, opts) => {
    const missing = subjectsOf(urls).filter(([c, sj]) => !allowed(c, sj));
    if (missing.length) throw new NeedPermission(missing, opts);
  };
  if (parsed.kind === 'error') throw new DataError(parsed.message);
  if (parsed.kind === 'url') {
    need([parsed.url]);
    let doc;
    try { doc = await fetchJson(parsed.url); } catch (e) {
      // An image's id alone is answered with a redirect to its information (measured): asked there instead, once.
      if (!(e instanceof RemoteError && e.kind === 'moved')) throw e;
      try { doc = await fetchJson(infoUrl(parsed.url)); } catch { throw e; }
      if (!isImageInfo(doc)) throw e;
    }
    if (isAnnotation(doc)) return resolve({ kind: 'annotation', annotation: doc, fetchedAt: now(), url: parsed.url }, deps);
    if (isManifest(doc)) return resolve({ kind: 'manifest-json', manifest: doc, url: parsed.url }, deps);
    if (isImageInfo(doc)) return resolve({ kind: 'service', serviceId: normaliseId(doc.id || doc['@id'] || parsed.url) }, deps);
    throw new DataError(`${parsed.url} is not a georeference, a IIIF manifest, or an image's information.`);
  }
  if (parsed.kind === 'annotation-url') {
    // Fetching this georeference, not looking for one.
    need([parsed.url], { fetch: parsed.url });
    const annotation = await fetchJson(parsed.url);
    if (!isAnnotation(annotation)) throw new DataError(`${parsed.url} is not a georeference (a IIIF Georeference Annotation).`);
    return resolve({ kind: 'annotation', annotation, fetchedAt: now(), url: parsed.url }, deps);
  }
  if (parsed.kind === 'allmaps-image') {
    // Asked as "Look for a georeference" asks, under Allmaps' permission.
    const found = await lookup([parsed.serviceId], deps);
    if (!found) throw new DataError(`Allmaps has no georeference of the image ${parsed.serviceId}.`);
    return resolve({ kind: 'annotation', annotation: found.annotation, fetchedAt: found.fetchedAt, url: found.url }, deps);
  }
  if (parsed.kind === 'annotation') {
    // A page of several: one is chosen first (nothing is fetched until then), and that one alone goes on.
    if (itemsOf(parsed.annotation).length > 1) {
      if (parsed.index === undefined || parsed.index === null) {
        throw new NeedChoice(parsed.annotation, { fetchedAt: parsed.fetchedAt || null, url: parsed.url || null, manifest: parsed.manifest || null });
      }
      const item = itemsOf(parsed.annotation)[parsed.index];
      if (!item) throw new DataError(`The georeference has no map ${parsed.index + 1} to choose.`);
      return resolve({ ...parsed, annotation: item, index: undefined }, deps);
    }
    const { service, manifest } = namedIn(parsed.annotation);
    if (!service) throw new DataError('The georeference names no image.');
    const notes = [];
    // The manifest is read for the canvas's size only: one whose site is set to Never is done without.
    const mSubject = manifest && !parsed.manifest ? subjectOf(manifest) : null;
    const readManifest = !!mSubject && state(mSubject[0], mSubject[1]) !== 'never';
    if (manifest && !parsed.manifest && !readManifest) notes.push(`The manifest ${manifest} was not read${mSubject ? ' (its site is set to Never in Permissions)' : ''}, so the canvas's size is not known: a region traced is cited on the image.`);
    // The image's site and the manifest's, asked about together.
    need([service, readManifest && manifest], { name: labelText(parsed.annotation.label) });
    let m = parsed.manifest || null;
    if (!m && readManifest) {
      try { m = await fetchJson(manifest); if (!isManifest(m)) { m = null; notes.push(`${manifest} is not a IIIF manifest, so the canvas's size is not known.`); } }
      catch (e) { notes.push(`The manifest ${manifest} could not be read (${e.message}), so the canvas's size is not known: a region traced is cited on the image instead.`); }
    }
    return { annotation: parsed.annotation, manifest: m, manifestUrl: manifest, fetchedAt: parsed.fetchedAt || null, notes };
  }
  if (parsed.kind === 'manifest') {
    need([parsed.url]);
    const m = await fetchJson(parsed.url);
    if (!isManifest(m)) throw new DataError(`${parsed.url} is not a IIIF manifest.`);
    return resolve({ kind: 'manifest-json', manifest: m, url: parsed.url }, deps);
  }
  if (parsed.kind === 'manifest-json') {
    const services = [...new Set(manifestCanvases(parsed.manifest).flatMap((c) => c.services))];
    if (!services.length) throw new DataError('The manifest shows no IIIF image, so there is nothing to place on the map.');
    return { services, manifest: parsed.manifest, manifestUrl: parsed.url || parsed.manifest.id || parsed.manifest['@id'] || null, title: labelText(parsed.manifest.label) || null };
  }
  if (parsed.kind === 'service') return { services: [parsed.serviceId], manifest: null, manifestUrl: null, title: null };
  throw new DataError('Nothing to show.');
}

/**
 * Ask Allmaps for a georeference of these images (only when the user has pressed "Look for a
 * georeference", and allmaps:allmaps is allowed): at /images/<the image's Allmaps id> (remote.js
 * allmapsImageUrls), never by ?url=. Returns { annotation, fetchedAt, url } or null when Allmaps has none.
 */
export async function lookup(services, { fetchJson, allowed, now = () => new Date().toISOString() }) {
  if (!allowed('allmaps', 'allmaps')) throw new NeedPermission([['allmaps', 'allmaps']]);
  for (const s of services) {
    for (const url of await allmapsImageUrls(s)) {
      let a;
      try { a = await fetchJson(url); } catch (e) { if (e instanceof RemoteError && e.kind === 'status' && e.status === 404) continue; throw e; }
      const items = typeOf(a) === 'AnnotationPage' ? a.items || [] : [a];
      if (isAnnotation(a) && items.length) return { annotation: a, fetchedAt: now(), url };
    }
  }
  return null;
}

/** Allmaps' Editor for a map: the address given to it is sent to Allmaps when the link is followed. */
// The Allmaps Editor link (Stephen, 2026-10-01): always offered, unless Allmaps is set to Never, and
// its words say what following it sends. Following it is the user's own act, not a request of the
// page's, so it needs no permission; Never is taken as "nothing of mine to Allmaps", and hides it.
export const editorLinkShown = (state) => state !== 'never';
export const EDITOR_LINK_TEXT = "Open in the Allmaps Editor ↗ (sends this map's address)";
export const editorUrl = (manifestUrl, serviceId) => `${ALLMAPS_EDITOR}/images?url=${encodeURIComponent(manifestUrl ? upgrade(manifestUrl) : infoUrl(serviceId))}`;

// ---- 3. Admission --------------------------------------------------------------------------------

/** The one annotation of a page that g was read from (the renderer is given that one only). */
function itemOf(annotation, g) {
  if (typeOf(annotation) !== 'AnnotationPage') return annotation;
  const items = annotation.items || [];
  return items.find((a) => normaliseId(a?.id ?? a?.['@id']) === normaliseId(g.annotationId)) || items[0];
}

/**
 * The georeference as the renderer is to be given it: naming its image by the id the image information
 * is given under, exactly. Admission compares the two normalised (a trailing slash is the same image),
 * but the renderer looks the information it was given up by the id as written, and fetches it again
 * itself when the two differ. A copy; what was given is not changed. Only the renderer is given this
 * copy (createLayerManager's show()): what is kept, and so read again on the next load, cited and keyed,
 * is the georeference as written.
 */
function withImageId(item, infoId) {
  const source = item?.target?.source;
  if (!source || typeof source !== 'object' || typeof infoId !== 'string') return item;
  const key = 'id' in source || !('@id' in source) ? 'id' : '@id';
  if (source[key] === infoId) return item;
  return { ...item, target: { ...item.target, source: { ...source, [key]: infoId } } };
}

/** The words shown when historical maps cannot be shown safely in this browser. */
export const REFUSED = 'Historical maps cannot be shown in this browser: the page could not confirm that its protection stops a map\'s image server from sending your requests on to other sites. Nothing was asked of the map\'s server.';

/** The image information as the renderer is given it: under `id` (its own id, over https), a copy. */
function infoUnder(info, id) {
  const key = 'id' in info || !('@id' in info) ? 'id' : '@id';
  return info[key] === id ? info : { ...info, [key]: id };
}

/**
 * Read a georeference, check it may be shown, and fetch its image's information: everything the
 * renderer is to be given, or an error in words. `resolved` is what resolve() gave; `enforced`
 * whether the page's policy was shown to be enforced (permissions.enforced()). Returns { g, item,
 * info, manifest, fetchedAt, title, attribution, notes, subject }. Throws DataError (in words),
 * NeedPermission, NeedChoice, RemoteError or PermissionError.
 */
export async function admit(resolved, { fetchJson, allowed, enforced }) {
  if (!enforced) throw new DataError(REFUSED);
  if (itemsOf(resolved.annotation).length > 1) throw new NeedChoice(resolved.annotation, { fetchedAt: resolved.fetchedAt || null, manifest: resolved.manifest || null });
  const notes = [...(resolved.notes || [])];
  let g, manifest = resolved.manifest || null;
  try { g = await readGeoreference(resolved.annotation, manifest ? { manifest } : {}); } catch (e) {
    if (!manifest || !(e instanceof DataError)) throw e;
    // A manifest that does not hold the georeferenced canvas is not used; the map is shown without it.
    g = await readGeoreference(resolved.annotation);
    notes.push(`The manifest does not match the georeference (${e.message}), so it was not used: a region traced is cited on the image.`);
    manifest = null;
  }
  const [subject] = subjectsOf([g.imageServiceId]);
  if (!allowed(subject[0], subject[1])) throw new NeedPermission([subject], { name: g.title });
  const info = await fetchJson(infoUrl(g.imageServiceId));
  const infoId = info && typeof info === 'object' ? info.id ?? info['@id'] : undefined;
  // The same image, over https as it is asked for: exactly, not merely the same site.
  if (typeof infoId !== 'string' || normaliseId(upgrade(infoId)) !== normaliseId(upgrade(g.imageServiceId))) {
    throw new DataError(`The image server says the image is at ${infoId ?? '(no address)'}, not at ${g.imageServiceId}, where the georeference places it. The map was not shown: its image would have been asked for there.`);
  }
  const id = upgrade(infoId);
  return {
    // The georeference as written: the renderer is given it under the image's id (show(), withImageId).
    g, item: itemOf(resolved.annotation, g), info: infoUnder(info, id), manifest, manifestUrl: resolved.manifestUrl || null, fetchedAt: resolved.fetchedAt || null,
    title: g.title || labelText(manifest?.label) || 'A map with no title', attribution: attributionOf(manifest, g.imageServiceId), notes, subject,
  };
}

// ---- Attribution -------------------------------------------------------------------------------

/**
 * What the collection says of the map's use, where its manifest says nothing: by the site the map is
 * on. David Rumsey's manifests carry a credit but no licence; the licence is on its site.
 */
export const HOSTS = [
  {
    hosts: ['www.davidrumsey.com', 'davidrumsey.com'],
    credit: 'David Rumsey Map Collection, David Rumsey Map Center, Stanford University Libraries',
    licence: 'https://creativecommons.org/licenses/by-nc-sa/3.0/', licenceLabel: 'CC BY-NC-SA 3.0',
  },
];
const LICENCE_LABELS = [
  [/creativecommons\.org\/publicdomain\/zero\//, 'CC0'], [/creativecommons\.org\/publicdomain\/mark\//, 'Public Domain Mark'],
  [/creativecommons\.org\/licenses\/([a-z-]+)\/(\d\.\d)/, (m) => `CC ${m[1].toUpperCase()} ${m[2]}`],
  [/rightsstatements\.org\/vocab\/([A-Za-z-]+)\//, (m) => `RightsStatements.org ${m[1]}`],
];
/** Text only: a IIIF value may hold a little HTML, which is shown as its words, never as markup. */
function text(v) {
  const t = labelText(v);
  return t ? t.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim() || null : null;
}
const httpUri = (u) => (typeof u === 'string' && /^https?:\/\/\S+$/.test(u.trim()) ? u.trim() : null);
function labelOfLicence(uri) {
  for (const [re, label] of LICENCE_LABELS) { const m = re.exec(uri || ''); if (m) return typeof label === 'function' ? label(m) : label; }
  return null;
}
/**
 * The credit and licence of a map: { credit, licence, licenceLabel, nonCommercial, from } from the
 * manifest (Presentation 3 requiredStatement and rights; 2 attribution and license), else from HOSTS
 * by the manifest's or the image's site. Text only; only a licence, and only an http(s) one, is ever
 * an address (the manifest's logo, thumbnail, rendering, homepage and seeAlso are never used).
 */
export function attributionOf(manifest, serviceId) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  let credit = null;
  if (m.requiredStatement) credit = text(m.requiredStatement.value) || text(m.requiredStatement.label);
  if (!credit && m.attribution !== undefined) credit = text(m.attribution);
  let licence = httpUri(m.rights) || [].concat(m.license ?? []).map(httpUri).find(Boolean) || null;
  let from = credit || licence ? 'manifest' : null;
  const hosts = [m.id ?? m['@id'], serviceId].map((u) => { try { return new URL(u).hostname; } catch { return null; } }).filter(Boolean);
  const known = HOSTS.find((h) => h.hosts.some((x) => hosts.includes(x)));
  if (known) {
    if (!credit) { credit = known.credit; from = 'table'; }
    if (!licence) { licence = known.licence; from = from === 'manifest' ? 'manifest and table' : 'table'; }
  }
  const licenceLabel = licence ? (known && licence === known.licence ? known.licenceLabel : labelOfLicence(licence)) : null;
  return { credit, licence, licenceLabel, nonCommercial: !!licence && /\/licenses\/by-nc/.test(licence), from };
}
/** The one neutral line shown for a non-commercial licence (the licence itself is linked where it is shown). */
export const nonCommercialLine = (a) => `The map image is licensed ${a.licenceLabel || 'for non-commercial use'}; this may bear on how what you trace from it can be reused.`;

/**
 * What the maps wait on (app.js's mapNeed), from its two parts, which can wait at once: the map pasted
 * (`pasted`: { subjects, pending, maps }, pending what to add once they are allowed) and the maps kept
 * (`kept`: { subjects, maps }). `part` replaces one of them ({ pasted } or { kept }, null to let it go),
 * and the other stays: the maps kept never take the place of a map pasted, nor it theirs. Returns
 * { subjects: each of both once, a line each; pending: the map pasted's, else { readmit: true };
 * maps; pasted; kept }, or null when nothing waits.
 */
export function withNeed(need, part) {
  const pasted = 'pasted' in part ? part.pasted : need?.pasted ?? null;
  const kept = 'kept' in part ? part.kept : need?.kept ?? null;
  if (!pasted && !kept) return null;
  const subjects = [];
  for (const sj of [...(pasted?.subjects || []), ...(kept?.subjects || [])]) if (!subjects.some((x) => x[0] === sj[0] && x[1] === sj[1])) subjects.push(sj);
  return { subjects, pending: pasted ? pasted.pending : { readmit: true }, maps: (pasted ? pasted.maps || 1 : 0) + (kept ? kept.maps || 1 : 0), pasted, kept };
}
/** What a reload for a permission hands over of what waits: the map pasted, to add after it, and whether maps kept wait too. */
export const reloadHandOver = (need) => ({ pending: need?.pasted?.pending || null, readmit: !!need?.kept });

/**
 * Whether a map pasted (not one kept) that waits on permissions (app.js's mapNeed, or one part of it:
 * { subjects, pending }) now waits on one of its own set to Never (`state(category, subject)`), so that
 * the page says why it is not shown. The maps kept's permissions say nothing of it.
 */
export function waitRefused(need, state) {
  const p = need && 'pasted' in need ? need.pasted : need;
  if (!p || p.pending?.readmit || p.pending?.kept) return false;
  return p.subjects.some(([c, s]) => state(c, s) === 'never');
}

// ---- Keeping the maps shown --------------------------------------------------------------------

// A map's record is written in turn with every other write of it (one queue per map, so a later write
// never lands under an earlier one, and a map let go is not written back), from the record held here
// (`records`), never from a read of the folder first. A change of what is shown (keepShown: Show
// ticked, the opacity moved) is also noted at once, synchronously, in sessionStorage (NOTE), and the
// note let go once the record holding it is on disk: a file is written only when its writable closes,
// so a reload within those milliseconds would otherwise find the map as it was (hidden, say). kept()
// reads a note over its record. sessionStorage is this tab's, and lasts through a reload, not a visit.
const DIR = 'chora-overlays';
const NOTE = 'chora-overlays-shown';
async function dir() { return (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true }); }
/** A file name for a map: a hash of its georeference's id (or its image's). */
export async function keyOf(g) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(g.annotationId || g.imageServiceId)));
  return [...d.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const records = new Map();   // key → the record as last kept or read (written from here)
const queues = new Map();    // key → the writes of that map, in turn
let writing = 0;
/** How many writes of the maps kept are not yet on disk (for tests to wait on, like app.js's draftWrites). */
export const writesPending = () => writing;
/** Resolves once every write of the maps kept queued so far is done (before a reload for a permission). */
export const keptWritten = () => Promise.all([...queues.values()]);
function inTurn(key, job) {
  writing++;
  // Counted down before the caller's await resumes, so that writesPending() is current after it.
  const run = (queues.get(key) || Promise.resolve()).then(job).finally(() => { writing--; if (queues.get(key) === settled) queues.delete(key); });
  const settled = run.catch(() => {});
  queues.set(key, settled);
  return run;
}
function notes() { try { const n = JSON.parse(sessionStorage.getItem(NOTE) || '{}'); return n && typeof n === 'object' && !Array.isArray(n) ? n : {}; } catch { return {}; } }
function setNote(key, shown) {
  try {
    const n = notes();
    if (shown) n[key] = shown; else delete n[key];
    if (Object.keys(n).length) sessionStorage.setItem(NOTE, JSON.stringify(n)); else sessionStorage.removeItem(NOTE);
  } catch { /* storage refused: the write alone keeps it */ }
}
const shownOf = (x) => ({ opacity: x.opacity, visible: x.visible });
async function write(rec) {
  const w = await (await (await dir()).getFileHandle(`${rec.key}.json`, { create: true })).createWritable();
  await w.write(JSON.stringify(rec));
  await w.close();
}
// Writes the map's record as it is now (the latest change, however many were queued), then lets its note go
// if what was written is what the note says.
function writeLatest(key) {
  return inTurn(key, async () => {
    const rec = records.get(key);
    if (!rec) return;   // let go meanwhile
    await write(rec);
    const n = notes()[key];
    if (n && n.opacity === rec.opacity && n.visible === rec.visible) setNote(key, null);
  });
}
/** Keep a map shown: { key, item, manifest, manifestUrl, fetchedAt, opacity, visible, added }. */
export function keep(entry) {
  records.set(entry.key, { version: 1, ...entry });
  return writeLatest(entry.key);
}
/**
 * A kept map's opacity and whether it is shown, changed: noted at once (it is what a reload finds),
 * and its record written in turn. A map not kept (let go, or never kept) is not written.
 */
export function keepShown(key, shown) {
  const rec = records.get(key);
  if (!rec) return Promise.resolve();
  records.set(key, { ...rec, ...shownOf(shown) });
  setNote(key, shownOf(shown));
  return writeLatest(key);
}
export function letGo(key) {
  records.delete(key); setNote(key, null);
  return inTurn(key, async () => { try { await (await dir()).removeEntry(`${key}.json`); } catch {} });
}
/** Let every map kept go, and its notes (the user keeps no working data between visits). */
export async function forgetKept() {
  await keptWritten();
  records.clear();
  try { sessionStorage.removeItem(NOTE); } catch {}
  try { await (await navigator.storage.getDirectory()).removeEntry(DIR, { recursive: true }); } catch { /* none kept */ }
}
/** The maps kept, oldest first, each as last shown (a note read over its record). */
export async function kept() {
  const out = [], n = notes();
  try {
    for await (const h of (await dir()).values()) {
      try {
        const e = JSON.parse(await (await h.getFile()).text());
        if (e?.version !== 1 || !e.item) continue;
        if (queues.has(e.key) && !records.has(e.key)) continue;   // being let go
        const note = n[e.key];
        const latest = queues.has(e.key) && records.has(e.key) ? records.get(e.key)   // being written: what is being written
          : note ? { ...e, ...shownOf(note) } : e;
        records.set(e.key, latest);
        out.push({ ...latest });
      } catch {}
    }
  } catch {}
  return out.sort((a, b) => String(a.added).localeCompare(String(b.added)));
}

// ---- 4. The renderer ---------------------------------------------------------------------------

let renderer = null;
/** @allmaps/maplibre, loaded the first time a map is shown. */
export function loadRenderer() {
  renderer ??= import('@allmaps/maplibre').catch((e) => { renderer = null; throw e; });
  return renderer;
}

/**
 * The historical maps on the MapLibre map `map`: one Allmaps layer, below Chora's own layers
 * (`beforeId`) and above the basemap. A change of basemap (a new style) removes every layer, so
 * attach() is called on each style.load, and puts the maps shown back into a new layer from what was
 * admitted (nothing is fetched again). `onEvent(type, event)` hears the renderer's events.
 */
export function createLayerManager(map, { beforeId = 'chora-overview-clusters', layerId = 'chora-historical-maps', onEvent, Layer: given } = {}) {
  let layer = null, Layer = given || null, attaching = null;
  const entries = [];   // admitted maps: admit()'s result, with key, mapId, opacity, visible
  const EVENTS = ['warpedmapadded', 'imageinfofetcherror', 'tilefetcherror', 'firstmaptileloaded', 'allrequestedtilesloaded', 'maptileloaded', 'error'];
  for (const t of EVENTS) map.on(t, (e) => onEvent?.(t, e));
  function show(e) {
    layer.addImageInfos([e.info]);
    // Naming the image by the id its information was just given under (admit()'s, exactly).
    const named = withImageId(e.item, e.info.id ?? e.info['@id']);
    // The renderer's parser takes the motivation only as the string (as georef's reader notes).
    const item = typeof named.motivation === 'string' ? named : { ...named, motivation: 'georeferencing' };
    // One result per map of the annotation: { ok, mapId } or { ok: false, error } (render 1.0.0-beta.84).
    const [r] = layer.addGeoreferenceAnnotation(item);
    if (!r?.ok || typeof r.mapId !== 'string') throw new Error(`The renderer could not show the map (${r?.error?.message || 'no map in the georeference'}).`);
    e.mapId = r.mapId;
    // Drawn with the georeference's own transformation, order and all (see the head of this file).
    layer.setMapTransformationType(e.mapId, allmapsTransformationName(e.g));
    layer.setMapOptions(e.mapId, { opacity: e.opacity, visible: e.visible });
  }
  async function attach() {
    layer = null;
    if (!entries.length) return;
    Layer ??= (await loadRenderer()).WarpedMapLayer;
    // Chora's own layers are there once a style has loaded (map.isStyleLoaded() is false while any
    // source is still loading, which is not what matters here).
    if (layer || !map.getLayer(beforeId)) return;
    // Put there already in this style (by add(), before the style's own attach): replaced, not added twice.
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    layer = new Layer({ layerId });
    map.addLayer(layer, map.getLayer(beforeId) ? beforeId : undefined);
    for (const e of entries) { try { show(e); } catch (err) { e.error = err.message; } }
  }
  const api = {
    get layer() { return layer; },
    get entries() { return entries; },
    /** Called on every style.load. */
    attach() { attaching = attach(); return attaching; },
    /** Show an admitted map (admit()'s result with key, opacity, visible). */
    async add(e) {
      // A new style (a new basemap) takes the layer away before its style.load attaches a new one: the
      // layer is then put back, with this map in it, rather than the map given to the layer taken away.
      if (!layer || !map.getLayer(layerId)) { entries.push(e); await attach(); return e; }
      show(e);   // a map the renderer refuses throws, and is not among those shown
      entries.push(e);
      return e;
    },
    remove(key) {
      const i = entries.findIndex((e) => e.key === key);
      if (i < 0) return false;
      const [e] = entries.splice(i, 1);
      try { if (layer && e.mapId) layer.removeGeoreferencedMapById(e.mapId); } catch {}
      return true;
    },
    set(key, options) {
      const e = entries.find((x) => x.key === key);
      if (!e) return;
      Object.assign(e, options);
      if (layer && e.mapId) layer.setMapOptions(e.mapId, { opacity: e.opacity, visible: e.visible });
    },
    /** The maps, topmost first (the renderer's z-order). */
    ordered() {
      if (!layer) return [...entries].reverse();
      return [...entries].sort((a, b) => (layer.getMapZIndex(b.mapId) ?? 0) - (layer.getMapZIndex(a.mapId) ?? 0));
    },
    /** [[west, south], [east, north]] of a map, for fitting the view to it. */
    bounds(key) {
      const e = entries.find((x) => x.key === key);
      return e && layer && e.mapId ? layer.getMapsBounds([e.mapId]) : null;
    },
  };
  return api;
}
