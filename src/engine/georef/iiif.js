// IIIF Presentation 2 and 3 manifests, read only as far as georeferencing needs: which canvas
// shows which image, and how big each canvas is. Nothing here fetches anything.

/** An identifier with a trailing "/info.json" and a trailing slash taken off, for comparison. */
export function normaliseId(id) {
  if (typeof id !== 'string') return undefined;
  return id.trim().replace(/\/info\.json$/, '').replace(/\/+$/, '');
}
const idOf = (o) => (o && typeof o === 'object' ? o.id ?? o['@id'] : typeof o === 'string' ? o : undefined);
const asArray = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

/** The text of a IIIF label: a v2 string, array or { "@value" }, or a v3 language map. */
export function labelText(label) {
  if (label === undefined || label === null) return undefined;
  if (typeof label === 'string') return label.trim() || undefined;
  if (Array.isArray(label)) {
    for (const l of label) { const t = labelText(l); if (t) return t; }
    return undefined;
  }
  if (typeof label === 'object') {
    if ('@value' in label) return labelText(label['@value']);
    const keys = Object.keys(label);
    const order = ['en', 'en-GB', 'en-US', 'none', ...keys];
    for (const k of order) if (k in label) { const t = labelText(label[k]); if (t) return t; }
  }
  return undefined;
}

/** The image service ids of one body or resource: its service(s), and a Choice's items. */
function serviceIds(resource) {
  const out = [];
  for (const r of asArray(resource)) {
    if (!r || typeof r !== 'object') continue;
    for (const s of asArray(r.service)) { const id = normaliseId(idOf(s)); if (id) out.push(id); }
    if (Array.isArray(r.items)) out.push(...serviceIds(r.items)); // v3 Choice
    if (Array.isArray(r.item)) out.push(...serviceIds(r.item)); // v2 oa:Choice default/item
    if (r.default) out.push(...serviceIds(r.default));
  }
  return out;
}

/**
 * The canvases of a manifest: [{ id, width, height, label, services: [image service id] }].
 * v2: sequences[].canvases[].images[].resource.service; v3: items[] (Canvas) .items[]
 * (AnnotationPage) .items[] (painting Annotation) .body.service.
 */
export function manifestCanvases(manifest) {
  const canvases = [];
  const v2 = Array.isArray(manifest.sequences);
  const raw = v2
    ? manifest.sequences.flatMap((s) => asArray(s && s.canvases))
    : asArray(manifest.items).filter((c) => c && (c.type === 'Canvas' || c['@type'] === 'sc:Canvas' || c.items));
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const services = v2
      ? asArray(c.images).flatMap((a) => serviceIds(a && a.resource))
      : asArray(c.items).flatMap((page) => asArray(page && page.items))
        .filter((a) => a && (a.motivation === undefined || asArray(a.motivation).includes('painting')))
        .flatMap((a) => serviceIds(a.body));
    canvases.push({ id: idOf(c), width: c.width, height: c.height, label: labelText(c.label), services });
  }
  return canvases;
}

/** The canvases and manifests an Allmaps annotation's image says it is part of. */
export function partOfCanvases(resource) {
  const out = [];
  for (const p of asArray(resource && resource.partOf)) {
    if (!p || p.type !== 'Canvas') continue;
    const manifest = asArray(p.partOf).find((m) => m && m.type === 'Manifest');
    out.push({ id: idOf(p), label: labelText(p.label), manifestId: idOf(manifest), manifestLabel: labelText(manifest && manifest.label) });
  }
  return out;
}

export const manifestId = (manifest) => idOf(manifest);
