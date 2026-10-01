// Historical maps over Chora's basemap: a IIIF image placed in the world by a IIIF Georeference
// Annotation, drawn by Allmaps' renderer (@allmaps/maplibre, loaded only when a map is first shown).
//
// How a map gets onto the page, one step at a time, each step asking only sites the user has agreed to
// (src/chora/consent.js, through the guard in src/chora/fetchguard.js):
// 1. parseInput: what was pasted. A georeference (its JSON, or its address), an Allmaps address or
//    map id, a IIIF manifest's address, or an image's (its service, info.json, or a picture of it).
// 2. resolve: the georeference, and the manifest it names when there is one (for the canvas's size,
//    which a citation of a region of the canvas needs). Every site this needs is asked about at once,
//    before anything is fetched; a manifest's images are known only once it is read, so a manifest is
//    one step and its images the next. With no georeference, nothing is looked for unless the user
//    presses "Look for a georeference" (lookup: Allmaps, by the image's address), and otherwise the
//    user is pointed to the Allmaps Editor, and asked to paste the georeference back.
// 3. admit: the georeference read (src/engine/georef/), then the image's information (info.json)
//    fetched here, refusing any redirect, and refused unless the id it gives is exactly the image the
//    georeference names: the renderer builds the tiles' addresses from that id, so an id elsewhere
//    would send every tile request elsewhere. It is then given to the renderer (addImageInfos), which
//    so makes no request for it of its own, and the georeference after it.
// 4. The renderer's tile workers fetch the tiles. No page code can see those requests: the page's
//    Content Security Policy is what keeps them to the image's site (src/chora/csp-head.js), and
//    maps are refused altogether unless the startup canary found the policy enforced in such workers.
//
// The renderer takes the annotation's transformation type but not a polynomial's order, so after
// adding a map its transformation is set again from the georeference (allmapsTransformationName):
// otherwise an order-2 or order-3 map would be drawn at order 1, and traced at its own order.
//
// Maps shown are kept on the origin private file system (chora-overlays/, one file each) and shown
// again on the next load, admitted afresh (so a site forgotten is asked about again).
import { readGeoreference, allmapsLookupUrl } from '../engine/georef/index.js';
import { normaliseId, manifestCanvases, labelText, parseImageRequest, partOfCanvases } from '../engine/georef/iiif.js';
import { DataError } from '../engine/input.js';
import { originOf } from './consent.js';

export const ALLMAPS_ANNOTATIONS = 'https://annotations.allmaps.org';
export const ALLMAPS_EDITOR = 'https://editor.allmaps.org';

/**
 * The sites a step needs agreed to, of one kind, before it can go on. `fetch`, when the step is to
 * fetch a georeference from that address (not to look for one), is the address, for the notice.
 */
export class NeedConsent extends Error {
  constructor(origins, kind, name, { fetch } = {}) {
    super(`${origins.join(', ')} must be agreed to (${kind}) first.`);
    this.name = 'NeedConsent'; this.origins = origins; this.kind = kind; this.mapName = name;
    if (fetch) this.fetch = fetch;
  }
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

/**
 * The name of the renderer's transformation for a georeference (g or a record), as
 * setMapTransformationType takes it.
 * LOCAL STAND-IN, TO BE REPLACED: src/engine/georef/ is to export allmapsTransformationName(g)
 * (Hermes, branch hermes-georef-2); until it is merged here, this gives the same names. Do not use
 * @allmaps/transform's typeAndOrderToTransformationType for this: it maps order 2 to polynomial1.
 */
export function allmapsTransformationName(g) {
  const NAMES = { polynomial: 'polynomial1', polynomial1: 'polynomial1', polynomial2: 'polynomial2', polynomial3: 'polynomial3', thinPlateSpline: 'thinPlateSpline', projective: 'projective', helmert: 'helmert', straight: 'straight', linear: 'linear' };
  const t = g && g.transformation;
  if (typeof t !== 'string' || !Object.hasOwn(NAMES, t)) throw new TypeError(`The georeference names no known transformation (${JSON.stringify(t ?? null)}).`);
  return NAMES[t];
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
  if (u.origin === ALLMAPS_ANNOTATIONS) return { kind: 'annotation-url', url: u.href };
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

/** The kind of consent a georeference's address needs: Allmaps' own server, or any other. */
export const annotationKind = (url) => (originOf(url) === ALLMAPS_ANNOTATIONS ? 'allmaps' : 'iiif');

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
 * Follow what was pasted to a georeference (and its manifest), fetching through `guard` (fetchguard's
 * createGuard) only from sites agreed to. `consented(origin, kind)` says which are. Returns
 * - { annotation, manifest, manifestUrl, fetchedAt, notes } ready for admit(); fetchedAt is when the
 *   georeference was fetched (an ISO date-time), or null when it was pasted;
 * - or { services, manifest, manifestUrl, title }: a map with no georeference given, to look for one.
 * Throws NeedConsent for the sites a step needs first (all of them at once, as far as they are known),
 * GuardError when a fetch fails, DataError when what was found is not what it should be.
 */
export async function resolve(parsed, { guard, consented, now = () => new Date().toISOString() }) {
  const need = (sites, kind, name) => {
    const missing = [...new Set(sites.filter(Boolean))].filter((o) => !consented(o, kind));
    if (missing.length) throw new NeedConsent(missing, kind, name);
  };
  if (parsed.kind === 'error') throw new DataError(parsed.message);
  if (parsed.kind === 'url') {
    need([originOf(parsed.url)], 'iiif');
    const doc = await guard.json(parsed.url, 'iiif');
    if (isAnnotation(doc)) return resolve({ kind: 'annotation', annotation: doc, fetchedAt: now(), url: parsed.url }, { guard, consented, now });
    if (isManifest(doc)) return resolve({ kind: 'manifest-json', manifest: doc, url: parsed.url }, { guard, consented, now });
    if (isImageInfo(doc)) return resolve({ kind: 'service', serviceId: normaliseId(doc.id || doc['@id'] || parsed.url) }, { guard, consented, now });
    throw new DataError(`${parsed.url} is not a georeference, a IIIF manifest, or an image's information.`);
  }
  if (parsed.kind === 'annotation-url') {
    const kind = annotationKind(parsed.url);
    const site = originOf(parsed.url);
    // Fetching this georeference, not looking for one: the notice says so.
    if (!consented(site, kind)) throw new NeedConsent([site], kind, undefined, { fetch: parsed.url });
    const annotation = await guard.json(parsed.url, kind);
    if (!isAnnotation(annotation)) throw new DataError(`${parsed.url} is not a georeference (a IIIF Georeference Annotation).`);
    return resolve({ kind: 'annotation', annotation, fetchedAt: now(), url: parsed.url }, { guard, consented, now });
  }
  if (parsed.kind === 'annotation') {
    // A page of several: one is chosen first (nothing is fetched until then), and that one alone goes on.
    if (itemsOf(parsed.annotation).length > 1) {
      if (parsed.index === undefined || parsed.index === null) {
        throw new NeedChoice(parsed.annotation, { fetchedAt: parsed.fetchedAt || null, url: parsed.url || null, manifest: parsed.manifest || null });
      }
      const item = itemsOf(parsed.annotation)[parsed.index];
      if (!item) throw new DataError(`The georeference has no map ${parsed.index + 1} to choose.`);
      return resolve({ ...parsed, annotation: item, index: undefined }, { guard, consented, now });
    }
    const { service, manifest } = namedIn(parsed.annotation);
    if (!service) throw new DataError('The georeference names no image.');
    // The image's site and the manifest's, asked about together.
    need([originOf(service), manifest && originOf(manifest)], 'iiif');
    const notes = [];
    let m = parsed.manifest || null;
    if (!m && manifest) {
      try { m = await guard.json(manifest, 'iiif'); if (!isManifest(m)) { m = null; notes.push(`${manifest} is not a IIIF manifest, so the canvas's size is not known.`); } }
      catch (e) { notes.push(`The manifest ${manifest} could not be read (${e.message}), so the canvas's size is not known: a region traced is cited on the image instead.`); }
    }
    return { annotation: parsed.annotation, manifest: m, manifestUrl: manifest, fetchedAt: parsed.fetchedAt || null, notes };
  }
  if (parsed.kind === 'manifest') {
    need([originOf(parsed.url)], 'iiif');
    const m = await guard.json(parsed.url, 'iiif');
    if (!isManifest(m)) throw new DataError(`${parsed.url} is not a IIIF manifest.`);
    return resolve({ kind: 'manifest-json', manifest: m, url: parsed.url }, { guard, consented, now });
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
 * georeference", and agreed to Allmaps): first by the image's Allmaps id (/images/<id>), then by
 * its address (?url=). Returns { annotation, fetchedAt, url } or null when Allmaps has none.
 */
export async function lookup(services, { guard, consented, now = () => new Date().toISOString() }) {
  if (!consented(ALLMAPS_ANNOTATIONS, 'allmaps')) throw new NeedConsent([ALLMAPS_ANNOTATIONS], 'allmaps');
  const found = async (url) => {
    try {
      const a = await guard.json(url, 'allmaps');
      const items = typeOf(a) === 'AnnotationPage' ? a.items || [] : [a];
      return isAnnotation(a) && items.length ? { annotation: a, fetchedAt: now(), url } : null;
    } catch (e) { if (e.kind === 'status' && e.status === 404) return null; throw e; }
  };
  for (const s of services) { const r = await found(await allmapsLookupUrl(s)); if (r) return r; }
  for (const s of services) { const r = await found(`${ALLMAPS_ANNOTATIONS}/?url=${encodeURIComponent(s)}`); if (r) return r; }
  return null;
}

/** Allmaps' Editor for a map: the address given to it is sent to Allmaps when the link is followed. */
export const editorUrl = (manifestUrl, serviceId) => `${ALLMAPS_EDITOR}/images?url=${encodeURIComponent(manifestUrl || `${serviceId}/info.json`)}`;

// ---- 3. Admission --------------------------------------------------------------------------------

/** The one annotation of a page that g was read from (the renderer is given that one only). */
function itemOf(annotation, g) {
  if (typeOf(annotation) !== 'AnnotationPage') return annotation;
  const items = annotation.items || [];
  return items.find((a) => normaliseId(a?.id ?? a?.['@id']) === normaliseId(g.annotationId)) || items[0];
}

/**
 * The georeference as the renderer is to be given it: naming its image by the id the image information
 * gives, exactly. Admission compares the two normalised (a trailing slash is the same image), but the
 * renderer looks the information it was given up by the id as written, and fetches it again itself
 * when the two differ. A copy; what was given is not changed.
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

/**
 * Read a georeference, check it may be shown, and fetch its image's information: everything the
 * renderer is to be given, or an error in words. `resolved` is what resolve() gave;
 * `canary` whether the policy was found enforced. Returns { g, item, info, manifest, fetchedAt,
 * title, attribution, notes }. Throws DataError (in words), NeedConsent, or GuardError.
 */
export async function admit(resolved, { guard, consented, canary }) {
  if (!canary) throw new DataError(REFUSED);
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
  const origin = originOf(g.imageServiceId);
  if (!origin) throw new DataError(`The georeference's image, ${g.imageServiceId}, is not at a web address.`);
  if (!consented(origin, 'iiif')) throw new NeedConsent([origin], 'iiif', g.title);
  const infoUrl = `${normaliseId(g.imageServiceId)}/info.json`;
  const info = await guard.json(infoUrl, 'iiif', { redirect: 'error' });
  const infoId = info && (info.id ?? info['@id']);
  if (normaliseId(infoId) !== normaliseId(g.imageServiceId)) {
    throw new DataError(`The image server says the image is at ${infoId ?? '(no address)'}, not at ${g.imageServiceId}, where the georeference places it. The map was not shown: its image would have been asked for there.`);
  }
  return {
    g, item: withImageId(itemOf(resolved.annotation, g), infoId), info, manifest, manifestUrl: resolved.manifestUrl || null, fetchedAt: resolved.fetchedAt || null,
    title: g.title || labelText(manifest?.label) || 'A map with no title', attribution: attributionOf(manifest, g.imageServiceId), notes,
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

// ---- Keeping the maps shown --------------------------------------------------------------------

const DIR = 'chora-overlays';
async function dir() { return (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true }); }
/** A file name for a map: a hash of its georeference's id (or its image's). */
export async function keyOf(g) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(g.annotationId || g.imageServiceId)));
  return [...d.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** Keep a map shown: { key, item, manifest, manifestUrl, fetchedAt, opacity, visible, added }. */
export async function keep(entry) {
  const w = await (await (await dir()).getFileHandle(`${entry.key}.json`, { create: true })).createWritable();
  await w.write(JSON.stringify({ version: 1, ...entry }));
  await w.close();
}
export async function letGo(key) { try { await (await dir()).removeEntry(`${key}.json`); } catch {} }
/** The maps kept, oldest first. */
export async function kept() {
  const out = [];
  try {
    for await (const h of (await dir()).values()) {
      try { const e = JSON.parse(await (await h.getFile()).text()); if (e?.version === 1 && e.item) out.push(e); } catch {}
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
    // The renderer's parser takes the motivation only as the string (as georef's reader notes).
    const item = typeof e.item.motivation === 'string' ? e.item : { ...e.item, motivation: 'georeferencing' };
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
      entries.push(e);
      if (!layer) await attach(); else show(e);
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
