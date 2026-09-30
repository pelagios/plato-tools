// W3C Web Annotations, as Recogito writes them, -> PLATO attestation-centric attestations.
//
// Recogito (recogito.pelagios.org, github.com/pelagios/recogito2) and Recogito Studio
// (github.com/recogito) both export annotations as a JSON array of W3C Web Annotations. Where an
// annotation links a passage of a document to a place in a gazetteer, the passage attests the
// place: the place's address is what the attestation is about, the words marked are the name as
// written, and the annotated document, with the passage's position, is the citation. Everything
// else in an annotation is either carried (comments and tags as notes, a tag from a vocabulary as a
// type, who made the link and when) or reported by kind: a mention never linked to a place, a
// person or an event, a link suggested by software and never confirmed, a selector or body with
// no PLATO counterpart. Nothing is dropped silently.
//
// Where the exports are ambiguous the reading is the conservative one, and each choice is stated
// where it is made. The two exports differ as follows (from their serialisers):
//
// Recogito v1 (app/controllers/document/downloads/serializers/annotations/webannotation/):
//   - a place link is a SpecificResource body, purpose "identifying", whose `value` is the place's
//     address (not `source`, as the W3C model would have it). A place or person mention never linked
//     has `value` "PLACE" or "PERSON" (or, in exports before 2020, no value at all); an event is a
//     SpecificResource with value "EVENT" and no purpose. Only places can be linked in v1's editor.
//   - a place link is followed by a Feature body, purpose "georeferencing", with the gazetteer's
//     own geometry for the place: the gazetteer's, not the document's.
//   - the body's verification status (VERIFIED, UNVERIFIED, NOT_IDENTIFIABLE) is NOT written. A
//     link made by named-entity recognition and never touched by a person has no `creator` (v1 sets
//     last_modified_by only when a person saves the body), which is the one sign left of it.
//   - the target's `source` is the document part's address, `label` its title.
// Recogito Studio (recogito-client src/util/export/w3c/w3cExporter.ts):
//   - a place link is a body with purpose "geotagging" whose `value` is a GeoJSON Feature from a
//     gazetteer (Wikidata, WHG, a GeoJSON file, Core Data), its `id` the place's identifier; a
//     geotag with no value is a mention flagged as having no match.
//   - a tag from a vocabulary is a `value` object { label, id }; a free tag a string.
//   - the target's `source` is the Studio project's id, not the document's address.
import { PLATO, isAbsoluteIri } from '../lib/context.js';
import { placeAddress } from '../engine/hermes/addresses.js';

export const ANNO_CONTEXT = /^https?:\/\/www\.w3\.org\/ns\/anno\.jsonld$/;
const ATTESTED = PLATO + 'Attested';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/i;
const MEDIA_FRAGS = /^https?:\/\/www\.w3\.org\/TR\/media-frags\/?$/;
const RFC7111 = /rfc7111/i;

/**
 * Each kind the reader reports, and how it is reported: 'loss' (not carried into PLATO), 'warning'
 * (carried, but worth a look) or 'error' (the annotation could not be read). The words for each
 * are in src/engine/report.js (LOSS_TEXT), under the same kind.
 */
export const ANNOTATION_KINDS = {
  'annotation-no-place': 'loss',
  'annotation-place-unlinked': 'loss',
  'annotation-not-place': 'loss',
  'annotation-unidentified': 'loss',
  'annotation-unverified': 'loss',
  'annotation-place-not-address': 'loss',
  'annotation-gazetteer-copy': 'loss',
  'annotation-body': 'loss',
  'annotation-selector': 'loss',
  'annotation-quote-context': 'loss',
  'annotation-key': 'loss',
  'annotation-creator-not-address': 'loss',
  'annotation-date': 'loss',
  'annotation-whg-record': 'loss',
  'annotation-whg-staging': 'loss',
  'annotation-source-not-address': 'warning',
  'annotation-several-places': 'warning',
  'annotation-verification-unknown': 'warning',
  'annotation-none-linked': 'warning',
  'annotation-more-pages': 'warning',
  'annotation-malformed': 'error',
  // Georeferenced regions (src/formats/regions.js), only when georeferences are given.
  'annotation-region-shape': 'loss',
  'annotation-region-no-georef': 'loss',
  'annotation-region-outside-map': 'loss',
  'annotation-region-ambiguous': 'loss',
  'annotation-region-beyond-control-points': 'loss',
  'annotation-region-not-iiif': 'loss',
  'annotation-region-unplaced': 'loss',
  'annotation-region-image-url': 'warning',
  'annotation-region-crosses-map-edge': 'warning',
  'annotation-region-no-label-evidence': 'warning',
  'annotation-georef-unused': 'warning',
  'annotation-manifest-unused': 'warning',
  'annotation-georef-unreadable': 'error',
};

const isIri = (s) => typeof s === 'string' && s !== '' && isAbsoluteIri(s);
const str = (s) => (typeof s === 'string' && s.trim() !== '' ? s : undefined);
const list = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
/** A purpose or motivation without its oa: prefix, lower-cased. */
const purposes = (b) => list(b.purpose ?? b.motivation).filter((p) => typeof p === 'string').map((p) => p.replace(/^oa:/, '').replace(/^http:\/\/www\.w3\.org\/ns\/oa#/, ''));
/** A label that may be a string or a JSON-LD language map / list: the first string in it. */
const labelText = (l) => (typeof l === 'string' ? l : Array.isArray(l) ? l.map(labelText).find(Boolean) : l && typeof l === 'object' ? labelText(l['@value'] ?? Object.values(l)[0]) : undefined);
/** HTML (Recogito Studio writes rich-text comments as HTML) reduced to its text. */
const htmlText = (s) => s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
/** True for Recogito v1's export, which names itself as the generator; Studio writes none. */
export const isRecogitoV1 = (a) => !!a && typeof a.generator === 'object' && a.generator !== null && a.generator.name === 'Recogito';

// The keys each object's reading uses; every other key present is reported, by name.
const ANNOTATION_KEYS = new Set(['@context', 'id', 'type', 'body', 'bodyValue', 'target', 'creator', 'created', 'modified', 'generator', 'generated']);
// Recogito v1 has at times given its Feature bodies GeoJSON-LD's own @context.
const BODY_KEYS = new Set(['@context', 'type', 'id', 'source', 'value', 'purpose', 'creator', 'created', 'modified', 'note', 'status', 'format', 'language', 'geometry']);
const TARGET_KEYS = new Set(['source', 'type', 'label', 'selector']);

/** A creator (a web address, a name, or an object with id and name) as a PLATO contributor. */
function contributor(c, report) {
  if (c === undefined || c === null) return undefined;
  if (typeof c === 'string') return isIri(c) ? c : str(c) ? { name: c } : undefined;
  if (typeof c !== 'object') return undefined;
  const id = typeof c.id === 'string' ? c.id : typeof c['@id'] === 'string' ? c['@id'] : undefined;
  const name = str(c.name) || str(c.nickname);
  if (id !== undefined && !isIri(id)) report('annotation-creator-not-address', id);
  const out = {};
  if (isIri(id)) out['@id'] = id;
  if (name) out.name = name;
  return Object.keys(out).length ? (Object.keys(out).length === 1 && out['@id'] ? out['@id'] : out) : undefined;
}
function when(v, report, what) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string' && DATE_TIME.test(v)) return v;
  report('annotation-date', `${what}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return undefined;
}

/** Recogito's verification status, where a body states it: 'VERIFIED' | 'UNVERIFIED' | 'NOT_IDENTIFIABLE'. */
const statusOf = (b) => { const s = typeof b.status === 'string' ? b.status : b.status && typeof b.status === 'object' ? b.status.value : undefined; return typeof s === 'string' ? s.toUpperCase() : undefined; };

/**
 * What one body is. Returns { kind, ... } where kind is one of: link (a place's address), unlinked
 * (a place mention with no place), person, event, unidentified, comment, tag, type, transcription,
 * gazetteer (the gazetteer's own data copied in), notAddress (a place identifier that is not a web
 * address), other.
 */
function classify(b, v1) {
  if (typeof b === 'string') return { kind: 'other', what: isIri(b) ? `a body that is only a web address (${b})` : 'a body that is only text' };
  if (!b || typeof b !== 'object') return { kind: 'other', what: 'a body that is not an object' };
  const p = purposes(b);
  const type = typeof b.type === 'string' ? b.type : undefined;
  const has = (x) => p.includes(x);
  // A place link: Recogito v1's "identifying" body, the W3C "linking" or "identifying" purpose, or
  // Recogito Studio's geotag. v1's link and W3C's differ in where the address is: `value` in v1,
  // `source` in the W3C model; either is taken.
  if (has('geotagging')) {
    const f = b.value;
    if (f === undefined || f === null || f === '') return { kind: 'unlinked', what: 'geotag flagged with no match' };
    const id = f && typeof f === 'object' ? (f.id ?? f['@id']) : f;
    const gaz = f && typeof f === 'object' ? [labelText(f.properties?.title), f.geometry ? 'its geometry' : undefined].filter(Boolean).join(', ') : '';
    if (isIri(id)) return { kind: 'link', iri: id, body: b, gazetteer: gaz || undefined };
    return { kind: 'notAddress', value: typeof id === 'string' || typeof id === 'number' ? String(id) : JSON.stringify(f).slice(0, 120), gazetteer: gaz || undefined };
  }
  if (has('identifying') || has('linking')) {
    const src = b.source && typeof b.source === 'object' ? (b.source.id ?? b.source['@id']) : b.source;
    // v1 writes the address as `id` where a body has both a label and an address; elsewhere a
    // body's `id` is the body's own address, not the place's, and is not taken for it.
    const ref = [src, v1 ? b.id : undefined, b.value].find(isIri);
    const status = statusOf(b);
    if (status === 'NOT_IDENTIFIABLE') return { kind: 'unlinked', what: `flagged as not identifiable${ref ? ` (${ref})` : ''}` };
    if (ref) return { kind: 'link', iri: ref, body: b, status };
    if (v1 && b.value === 'PLACE') return { kind: 'unlinked', what: 'PLACE' };
    if (v1 && (b.value === 'PERSON' || b.value === 'EVENT')) return { kind: b.value.toLowerCase() };
    if (b.value === undefined && src === undefined && b.id === undefined) return { kind: 'unidentified' };
    return { kind: 'unidentified', value: typeof b.value === 'string' ? b.value : undefined };
  }
  // Recogito v1 writes an event as a SpecificResource "EVENT" with no purpose.
  if (v1 && type === 'SpecificResource' && !p.length && b.value === 'EVENT') return { kind: 'event' };
  // A Feature with no geometry (v1 writes one where the gazetteer has none) holds nothing.
  if (has('georeferencing') || type === 'Feature') return { kind: 'gazetteer', value: b.geometry ? `geometry ${b.geometry.type || ''}`.trim() : undefined };
  if (has('tagging')) {
    const v = b.value;
    // A tag is a type only when it is the address of a concept in a vocabulary: v1 writes that
    // address as the body's id (and the label as its value), Studio as the value's id.
    const id = v && typeof v === 'object' ? (v.id ?? v['@id']) : v1 && isIri(b.id) ? b.id : b.source;
    const label = v && typeof v === 'object' ? labelText(v.label) : typeof v === 'string' ? v : undefined;
    if (isIri(id)) return { kind: 'type', identifier: id, label: label || id };
    if (typeof v === 'string' && isIri(v)) return { kind: 'type', identifier: v, label: v };
    return label ? { kind: 'tag', text: label } : { kind: 'other', what: 'an empty tag' };
  }
  if (has('transcribing')) return typeof b.value === 'string' && b.value.trim() ? { kind: 'transcription', text: b.value, language: str(b.language) } : { kind: 'other', what: 'an empty transcription' };
  const textual = type === 'TextualBody' || (!type && (!p.length || has('commenting') || has('replying')));
  if (textual && (!p.length || has('commenting') || has('replying') || has('describing') || has('editing') || has('questioning') || has('assessing'))) {
    if (typeof b.value !== 'string' || !b.value.trim()) return { kind: 'other', what: 'an empty comment' };
    return { kind: 'comment', text: /html/i.test(b.format || '') ? htmlText(b.value) : b.value };
  }
  return { kind: 'other', what: [type, p.join(' ')].filter(Boolean).join(', ') || 'a body of no stated kind' };
}

/**
 * The position a selector gives, in words, or undefined; `lost` receives what cannot be said. With
 * `placing` (georeferences were given), an SVG shape is not reported here: AnnotationReader.place
 * reports each one, placed or not, by a region kind.
 */
function selectorWords(s, lost, placing) {
  if (!s || typeof s !== 'object') { lost('annotation-selector', 'a selector that is not an object'); return undefined; }
  const refined = s.refinedBy ? list(s.refinedBy).map((r) => selectorWords(r, lost, placing)).filter(Boolean) : [];
  const withRefined = (w) => [w, ...refined].filter(Boolean).join(', ');
  switch (s.type) {
    case 'TextQuoteSelector':
      return refined.join(', ') || undefined;   // the quote is the name, not a position
    case 'TextPositionSelector':
      return withRefined(Number.isFinite(s.start) && Number.isFinite(s.end) ? `characters ${s.start} to ${s.end}` : undefined);
    case 'DataPositionSelector':
      return withRefined(Number.isFinite(s.start) && Number.isFinite(s.end) ? `bytes ${s.start} to ${s.end}` : undefined);
    case 'XPathSelector':
    case 'CssSelector':
      return withRefined(typeof s.value === 'string' ? `${s.type === 'XPathSelector' ? 'XPath' : 'CSS selector'} ${s.value}` : undefined);
    case 'RangeSelector': {
      // Recogito v1 writes XPaths; Studio writes "path::offset", the offset in characters.
      const part = (x) => {
        if (!x || typeof x !== 'object' || typeof x.value !== 'string') return undefined;
        const [path, off] = x.value.split('::');
        return { path, off: off !== undefined && /^\d+$/.test(off) ? Number(off) : undefined, kind: x.type === 'CssSelector' ? 'CSS selector' : 'XPath' };
      };
      const a = part(s.startSelector), b = part(s.endSelector);
      if (!a || !b) { lost('annotation-selector', 'RangeSelector without a start and an end'); return withRefined(undefined); }
      if (a.path === b.path) return withRefined(`${a.kind} ${a.path}${a.off !== undefined && b.off !== undefined ? `, characters ${a.off} to ${b.off}` : ''}`);
      const one = (x) => `${x.path}${x.off !== undefined ? ` (character ${x.off})` : ''}`;
      return withRefined(`${a.kind} from ${one(a)} to ${one(b)}`);
    }
    case 'FragmentSelector': {
      const v = typeof s.value === 'string' ? s.value : '';
      if (RFC7111.test(s.conformsTo || '')) {
        const m = /^row=(\d+)(?:-(\d+|\*))?$/.exec(v);
        if (m) return withRefined(m[2] ? `rows ${m[1]} to ${m[2]}` : `row ${m[1]}`);
        return withRefined(v ? `table fragment ${v}` : undefined);
      }
      if (MEDIA_FRAGS.test(s.conformsTo || '') || /^(xywh|page|t)=/.test(v)) {
        const out = [];
        for (const kv of v.split('&')) {
          const [k, val = ''] = kv.split('=');
          if (k === 'page') out.push(`page ${val}`);
          else if (k === 'xywh') {
            const m = /^(?:(pixel|percent):)?(-?[\d.]+),(-?[\d.]+),([\d.]+),([\d.]+)$/.exec(val);
            if (!m) { out.push(`region ${val}`); continue; }
            const unit = m[1] === 'percent' ? 'per cent' : 'pixels';
            out.push(Number(m[4]) === 0 && Number(m[5]) === 0 ? `point at x ${m[2]}, y ${m[3]} (${unit})` : `region at x ${m[2]}, y ${m[3]}, ${m[4]} by ${m[5]} ${unit}`);
          } else if (k === 'viewrect') out.push(`viewrect ${val}`);
          else if (k === 't') out.push(`time ${val}`);
          else out.push(kv);
        }
        return withRefined(out.join(', ') || undefined);
      }
      return withRefined(v ? `fragment ${v}${s.conformsTo ? ` (${s.conformsTo})` : ''}` : undefined);
    }
    case 'SvgSelector':
      // The shape itself (SVG markup) has no place in a locator: it is reported, and the locator
      // says only that a shape was drawn.
      if (!placing) lost('annotation-selector', SVG_SHAPE);
      return withRefined('a shape drawn on the image');
    default:
      lost('annotation-selector', String(s.type || 'a selector of no stated type'));
      return withRefined(undefined);
  }
}

const SVG_SHAPE = 'SvgSelector: the shape drawn on the image';
/** One target as { source, label, quotes, locator }. */
function readTarget(t, report, keyLoss, placing) {
  if (typeof t === 'string') return { source: t, quotes: [] };
  if (!t || typeof t !== 'object') return null;
  for (const k of Object.keys(t)) if (!TARGET_KEYS.has(k) && !(k === 'id' && t.source === undefined) && t[k] !== undefined && t[k] !== null) keyLoss(`target.${k}`);
  const src = t.source && typeof t.source === 'object' ? (t.source.id ?? t.source['@id']) : t.source ?? (t.selector === undefined ? t.id ?? t['@id'] : undefined);
  const quotes = [], words = [];
  for (const s of list(t.selector)) {
    if (s && s.type === 'TextQuoteSelector') {
      if (typeof s.exact === 'string' && s.exact.trim()) quotes.push(s.exact);
      if (s.prefix || s.suffix) report('annotation-quote-context', s.exact);
    }
    const w = selectorWords(s, report, placing);
    if (w) words.push(w);
  }
  return { source: typeof src === 'string' ? src : undefined, label: labelText(t.label ?? t.source?.label), quotes, locator: words.join('; ') || undefined };
}

/**
 * Reads annotations one at a time. `report(kind, example)` receives every kind in
 * ANNOTATION_KINDS; `finish()` reports what can be said only of the whole file.
 */
export class AnnotationReader {
  constructor(report) {
    this.report = report;
    this.annotations = 0; this.attestations = 0; this.unknownVerification = 0;
    this.maps = null; this.regions = null;
  }
  /**
   * Georeferenced regions: read the georeference files (and manifests) given with the export, once,
   * so that place() can put the annotations' regions in the world. Until this is called (and when
   * no georeferences are given it never is) nothing of the georeference module's is loaded, and
   * annotation() reads regions as it always has: as locators in words.
   */
  async useGeoreferences(georefs, manifests) {
    // Loaded here, not imported above, so that a page that never meets a georeference never
    // downloads the georeference module (src/engine/georef/), nor Allmaps, which it loads in turn.
    this.regions = await import('./regions.js');
    this.maps = await this.regions.readGeoreferences(georefs, manifests, this.report);
  }
  /** The document header for the attestations: the gazetteer, described from the export. */
  header(first, fileName, collectionLabel) {
    const g = first && typeof first.generator === 'object' && first.generator ? first.generator : null;
    const by = g ? ` made with ${[str(g.name), isIri(g.id) ? g.id : isIri(g.homepage) ? g.homepage : undefined].filter(Boolean).join(', ') || 'unnamed software'}` : '';
    const at = first && typeof first.generated === 'string' ? `, exported ${first.generated}` : '';
    return {
      profile: 'attestation-centric',
      gazetteer: {
        title: str(collectionLabel) || `Place annotations in ${fileName}`,
        description: `Converted by PLATO tools from W3C Web Annotations${by}${at}: one attestation for each link from an annotated passage to a place.`,
      },
    };
  }
  /** One annotation -> its attestations (none, one, or one per place it links to). */
  annotation(a, n) {
    const report = this.report;
    this.annotations++;
    const where = (a && typeof a === 'object' && (a.id ?? a['@id'])) || `annotation ${n}`;
    if (!a || typeof a !== 'object' || Array.isArray(a)) { report('annotation-malformed', `${where}: not an object`); return []; }
    const keyLoss = (k) => report('annotation-key', k);
    // Recogito Studio writes visibility false for a public annotation, which says nothing to lose.
    for (const k of Object.keys(a)) {
      if (ANNOTATION_KEYS.has(k) || a[k] === undefined || a[k] === null || (k === 'visibility' && a[k] === false)) continue;
      keyLoss(['motivation', 'visibility'].includes(k) ? `${k} (${[].concat(a[k]).join(', ')})` : k);
    }
    const v1 = isRecogitoV1(a);
    const bodies = [...list(a.body), ...(typeof a.bodyValue === 'string' ? [{ type: 'TextualBody', value: a.bodyValue }] : [])];
    const read = bodies.map((b) => {
      const c = classify(b, v1);
      if (b && typeof b === 'object') for (const k of Object.keys(b)) if (!BODY_KEYS.has(k) && b[k] !== undefined && b[k] !== null) keyLoss(`body.${k}`);
      return c;
    });
    // A place's address in the form PLATO should carry (src/engine/hermes/addresses.js): WHG's
    // record addresses are rewritten to their persistent form, and an address WHG would answer
    // with the wrong place is not carried over.
    const links = [];
    for (const c of read.filter((c) => c.kind === 'link')) {
      const addr = placeAddress(c.iri);
      if (addr.lost) { report(addr.lost === 'whg-staging' ? 'annotation-whg-staging' : 'annotation-whg-record', `${where}: ${addr.value}`); continue; }
      links.push(addr.from ? { ...c, iri: addr.iri, from: addr.from } : c);
    }
    // Recogito v1 does not write whether a link was confirmed. A link with no creator was made by
    // software (named-entity recognition and gazetteer matching) and never saved by a person:
    // v1 stamps a body's creator whenever a person saves it, confirming included. Such a link is a
    // suggestion, not anyone's assertion, and is left out; an explicit status, where one is
    // written, is honoured whatever the software.
    const unverified = (l) => l.status === 'UNVERIFIED' || (l.status === undefined && v1 && !l.body.creator);
    const kept = links.filter((l) => !unverified(l));
    for (const l of links.filter(unverified)) report('annotation-unverified', `${where}: ${l.iri}`);
    for (const c of read.filter((c) => c.kind === 'notAddress')) report('annotation-place-not-address', `${where}: ${c.value}`);
    for (const c of read) if ((c.kind === 'gazetteer' && c.value) || ((c.kind === 'link' || c.kind === 'notAddress') && c.gazetteer)) report('annotation-gazetteer-copy', c.kind === 'gazetteer' ? c.value : c.gazetteer);
    if (!kept.length) {
      // Nothing for `about`: say why, once per annotation, by the most specific reason.
      if (links.length || read.some((c) => c.kind === 'notAddress' || (c.kind === 'link' && placeAddress(c.iri).lost))) { /* reported above */ }
      else if (read.some((c) => c.kind === 'unlinked')) report('annotation-place-unlinked', `${where}: ${this.quote(a) || read.find((c) => c.kind === 'unlinked').what}`);
      else if (read.some((c) => c.kind === 'person' || c.kind === 'event')) report('annotation-not-place', `${where}: ${read.filter((c) => c.kind === 'person' || c.kind === 'event').map((c) => c.kind).join(', ')}${this.quote(a) ? ` (${this.quote(a)})` : ''}`);
      else if (read.some((c) => c.kind === 'unidentified')) report('annotation-unidentified', `${where}${this.quote(a) ? `: ${this.quote(a)}` : ''}`);
      else report('annotation-no-place', `${where}${read.length ? ` (${[...new Set(read.map((c) => c.kind))].join(', ')})` : ': no body'}`);
      return [];
    }
    const placing = this.maps !== null;
    const targets = list(a.target).map((t) => readTarget(t, report, keyLoss, placing)).filter(Boolean);
    if (!targets.length || targets.some((t) => t.source === undefined)) {
      report('annotation-malformed', `${where}: no target, or a target that does not say what document it is in`);
      // Not placed, so its SVG shapes are reported as they are without georeferences.
      if (placing) for (let i = this.regions.svgRegionCount(a); i > 0; i--) report('annotation-selector', SVG_SHAPE);
      return [];
    }
    // What a place link carries besides the place: the rest of the annotation's bodies.
    for (const c of read) {
      if (c.kind === 'person' || c.kind === 'event') report('annotation-body', `${c.kind} beside a place link`);
      else if (c.kind === 'unlinked') report('annotation-body', `${c.what} beside a place link`);
      else if (c.kind === 'unidentified') report('annotation-body', 'an identifying body that identifies nothing, beside a place link');
      else if (c.kind === 'other') report('annotation-body', c.what);
    }
    const quotes = [...new Set(targets.flatMap((t) => t.quotes))];
    const transcriptions = read.filter((c) => c.kind === 'transcription');
    // The name as written: the words marked in the text; for an image, which has none, what the
    // annotator transcribed. A transcription beside a quote is kept as a note.
    const names = quotes.length ? quotes.map((q) => ({ toponym: q })) : transcriptions.map((t) => ({ toponym: t.text, ...(t.language ? { language: t.language } : {}) }));
    const notes = [];
    if (quotes.length) for (const t of transcriptions) notes.push(`Transcription: ${t.text}`);
    for (const c of read) if (c.kind === 'comment') notes.push(`Comment: ${c.text}`);
    for (const c of read) if (c.kind === 'tag') notes.push(`Tag: ${c.text}`);
    const types = read.filter((c) => c.kind === 'type').map((c) => ({ identifier: c.identifier, label: c.label }));
    const citations = targets.map((t) => {
      let source;
      if (isIri(t.source)) source = { '@id': t.source, title: t.label || t.source, authorityType: 'source' };
      else {
        // Recogito Studio writes its project's id here, which is not the document's address: the
        // source keeps it as its title, and the warning says that documents cannot be told apart.
        report('annotation-source-not-address', t.source);
        source = { title: t.label ? `${t.label} (${t.source})` : `The annotated document (identifier ${t.source})`, authorityType: 'source' };
      }
      return { source, ...(t.locator ? { locator: t.locator } : {}) };
    });
    const id = typeof a.id === 'string' ? a.id : typeof a['@id'] === 'string' ? a['@id'] : undefined;
    const annoIri = isIri(id) ? id : id && UUID.test(id) ? `urn:uuid:${id.toLowerCase()}` : undefined;
    if (kept.length > 1) report('annotation-several-places', `${where}: ${kept.map((l) => l.iri).join(', ')}`);
    if (v1) for (const l of kept) if (l.status === undefined) this.unknownVerification++;
    const out = kept.map((l) => {
      const b = l.body;
      const att = {};
      att.about = l.iri;
      if (names.length) { att.names = names; att.formStatus = ATTESTED; }
      if (types.length) att.types = types;
      att.citations = citations;
      const who = contributor(b.creator ?? a.creator, report);
      if (who !== undefined) att.contributor = who;
      const created = when(b.created ?? a.created, report, 'created'), modified = when(b.modified ?? a.modified, report, 'modified');
      if (created) att.created = created;
      if (modified) att.modified = modified;
      const own = [...notes];
      if (l.from) own.push(`Place address given as ${l.from}`);
      if (typeof b.note === 'string' && b.note.trim()) own.unshift(`Note: ${b.note}`);
      if (kept.length > 1) own.push(`Annotation ${id || where} links this passage to ${kept.length} places: ${kept.map((k) => k.iri).join(', ')}.`);
      // The annotation's address is not the attestation's @id: an annotation can be edited and
      // exported again under the same address, and a published attestation must never change.
      // So it is recorded as where the attestation came from, and the attestation stays unnamed.
      else if (annoIri) own.push(`From annotation ${annoIri}`);
      if (own.length) att.notes = own.join('\n');
      return att;
    });
    this.attestations += out.length;
    return out;
  }
  /**
   * Georeferenced regions: place the regions of an annotation that annotation() made `attestations`
   * of, through the georeferences given to useGeoreferences() (src/formats/regions.js). Adds to each
   * attestation the point, the citations of the map and of the georeference, and the note; reports
   * every region by a region kind. Only called when georeferences were given.
   */
  async place(a, attestations) {
    if (this.maps === null || !attestations.length) return;
    const where = (a.id ?? a['@id']) || 'an annotation';
    const read = [...list(a.body)].map((b) => classify(b, isRecogitoV1(a)));
    const tagged = (is) => read.some((c) => (c.kind === 'tag' && is(c.text)) || (c.kind === 'type' && is(c.label)));
    const { isSymbolTag, isLabelTag, placeRegions } = this.regions;
    const symbol = tagged(isSymbolTag);
    // A label: the label's words (what annotation() takes as the attested name: a quote, else a
    // transcription), or a tag saying so, which Recogito Studio's editor can write where it can
    // write neither of the others.
    const label = tagged(isLabelTag) || attestations.some((att) => Array.isArray(att.names) && att.names.length > 0);
    await placeRegions(a, attestations, { maps: this.maps, where, v1: isRecogitoV1(a), symbol, label }, this.report);
  }
  quote(a) {
    for (const t of list(a.target)) for (const s of list(t && t.selector)) if (s && s.type === 'TextQuoteSelector' && typeof s.exact === 'string') return s.exact;
    for (const b of list(a.body)) if (b && purposes(b).includes('transcribing') && typeof b.value === 'string') return b.value;
    return undefined;
  }
  finish() {
    if (this.maps) for (const m of this.maps) if (!m.used) this.report('annotation-georef-unused', `${[m.g.title, m.g.annotationId].filter(Boolean).join(', ')} (${m.file})`);
    if (this.unknownVerification) this.report('annotation-verification-unknown', `${this.unknownVerification} link${this.unknownVerification === 1 ? '' : 's'}`);
    if (this.annotations && !this.attestations) this.report('annotation-none-linked', `${this.annotations} annotation${this.annotations === 1 ? '' : 's'}`);
  }
}

/**
 * The same, with the regions placed through georeferences ({ georefs, manifests }: Files, as the
 * page and the command line give them): for tests.
 */
export async function annotationsToDocumentPlaced(items, fileName, report = () => {}, { georefs = [], manifests = [] } = {}) {
  const r = new AnnotationReader(report);
  await r.useGeoreferences(georefs, manifests);
  const attestations = [];
  for (const [i, a] of items.entries()) {
    const atts = r.annotation(a, i + 1);
    await r.place(a, atts);
    attestations.push(...atts);
  }
  r.finish();
  return { ...r.header(items[0], fileName), attestations };
}

/** Every attestation of a list of annotations, and the document: for tests and small inputs. */
export function annotationsToDocument(items, fileName, report = () => {}) {
  const r = new AnnotationReader(report);
  const attestations = items.flatMap((a, i) => r.annotation(a, i + 1));
  r.finish();
  return { ...r.header(items[0], fileName), attestations };
}
