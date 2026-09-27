// Linked Places Format v1 (the v1.2.2 README, with v1.3's fclasses): LPF Feature <-> PLATO record.
//
// LPF is PLATO's single-object-attestation profile, so reading LPF loses almost nothing: each name,
// type, geometry and relation becomes one attestation, carrying its own when and citations. The
// few LPF things PLATO JSON has no slot for are reported as losses, never dropped silently.
// Writing LPF from PLATO is lossy by design (bundling, locators, form status, numeric certainty
// and more have no LPF slot); every loss is reported, with counts.
import { PLATO } from '../lib/context.js';

// The README's alias table, plus the vocabulary prefixes its own examples use.
export const LPF_PREFIXES = {
  bnf: 'https://data.bnf.fr/', cerl: 'https://data.cerl.org/thesaurus/', dbp: 'http://dbpedia.org/resource/',
  gn: 'http://www.geonames.org/', gnd: 'http://d-nb.info/gnd/', gov: 'http://gov.genealogy.net/',
  loc: 'http://id.loc.gov/authorities/subjects/', pl: 'https://pleiades.stoa.org/places/', tgn: 'http://vocab.getty.edu/page/tgn/',
  viaf: 'http://viaf.org/viaf/', wd: 'https://www.wikidata.org/wiki/', wp: 'https://wikipedia.org/wiki/',
  aat: 'http://vocab.getty.edu/aat/', gvp: 'http://vocab.getty.edu/ontology#', periodo: 'http://n2t.net/ark:/99152/',
  cc: 'https://creativecommons.org/licenses/',
};
export const expandLpf = (v) => {
  if (typeof v !== 'string') return v;
  const m = v.match(/^([a-z]+):(?!\/\/)(.*)$/);
  return m && LPF_PREFIXES[m[1]] ? LPF_PREFIXES[m[1]] + m[2] : v;
};
const FCLASS = { A: 'Administrative entities', H: 'Water bodies', L: 'Regions, landscape areas', P: 'Populated places', R: 'Roads, routes, rail', S: 'Sites', T: 'Terrestrial landforms' };
const GN_CLASS = 'http://www.geonames.org/ontology#';
const DCT_DESCRIPTION = 'http://purl.org/dc/terms/description', FOAF_DEPICTION = 'http://xmlns.com/foaf/0.1/depiction';
const LINK_PROPERTY = { primaryTopicOf: 'http://xmlns.com/foaf/0.1/isPrimaryTopicOf', subjectOf: 'http://purl.org/dc/terms/isReferencedBy', seeAlso: 'http://www.w3.org/2000/01/rdf-schema#seeAlso' };
const PROPERTY_LINK = Object.fromEntries(Object.entries(LINK_PROPERTY).map(([k, v]) => [v, k]));

const pad = (s) => (typeof s === 'string' && /^-?\d{1,3}$/.test(s) ? (s.startsWith('-') ? '-' + s.slice(1).padStart(4, '0') : s.padStart(4, '0')) : s);
const bound = (b, which) => (b === undefined ? undefined : typeof b === 'string' ? pad(b) : pad(b.in ?? b[which]));
const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined || (Array.isArray(o[k]) && !o[k].length)) delete o[k]; return o; };

// LPF's three certainty words are PLATO's three CertaintyLevels (since PLATO 9d2c36e), so they
// round-trip as words; no number is invented for them.
const LEVEL = { certain: PLATO + 'Certain', 'less-certain': PLATO + 'LessCertain', uncertain: PLATO + 'Uncertain' };
const WORD = Object.fromEntries(Object.entries(LEVEL).map(([w, l]) => [l, w]));
/** An LPF certainty word -> { certaintyLevel } or, for a word outside LPF's three, a note. */
function level(word) {
  if (!word) return {};
  return LEVEL[word] ? { certaintyLevel: LEVEL[word] } : { certaintyNote: `LPF certainty: ${word}` };
}
/** A PLATO certainty level (or a note written by an earlier version of these tools) -> an LPF word. */
const certaintyWord = (lvl, note) => WORD[lvl] || (note && /LPF certainty: (certain|less-certain|uncertain)/.exec(note)?.[1]) || undefined;

/** LPF when -> PLATO timespans; the when's certainty qualifies each of its timespans. */
function whenToPlato(when, loss) {
  if (!when) return {};
  const spans = (when.timespans || []).map((t) => {
    const end = t.end ?? t.start;   // "if end is omitted, the timespan is interpreted as the interval described by the start"
    return clean({ startEarliest: bound(t.start, 'earliest'), startLatest: bound(t.start, 'latest'), endEarliest: bound(end, 'earliest'), endLatest: bound(end, 'latest') });
  });
  for (const p of when.periods || []) spans.push(clean({ label: p.name, periodoUri: expandLpf(p.uri || p['@id']) }));
  if (when.label && spans.length) spans[0].label = spans[0].label ? spans[0].label + '; ' + when.label : when.label;
  if (when.duration) loss({ kind: 'lpf-duration', value: when.duration });
  const c = level(when.certainty);
  if (c.certaintyLevel && spans.length) { for (const t of spans) t.qualification = { certaintyLevel: c.certaintyLevel }; return { timespans: spans }; }
  return { timespans: spans, ...c };
}
function citationsToSources(cits) {
  return (cits || []).map((c) => clean({
    ...(c['@id'] ? { '@id': expandLpf(c['@id']) } : {}), title: c.label || c['@id'] || 'untitled', authorityType: 'source',
    timespan: c.year !== undefined ? { sourceLabel: String(c.year), startEarliest: pad(String(c.year)), endLatest: pad(String(c.year)) } : undefined,
  }));
}
function attestation(facets, when, cits, loss, extra = {}) {
  const w = whenToPlato(when, loss);
  const certaintyNote = [w.certaintyNote, extra.certaintyNote].filter(Boolean).join('; ') || undefined;
  return clean({ ...facets, timespans: w.timespans, sources: citationsToSources(cits), certaintyLevel: extra.certaintyLevel || w.certaintyLevel, certaintyNote });
}

/** LPF Feature -> PLATO place-centric record. `loss(l)` receives what PLATO JSON cannot hold. */
export function featureToRecord(f, loss = () => {}) {
  const rec = { '@id': f['@id'], label: f.properties?.title, ccodes: f.properties?.ccodes, attestations: [], identityRelations: [] };
  if (rec['@id'] === undefined) delete rec['@id'];
  if (!rec.ccodes?.length) delete rec.ccodes;
  const A = rec.attestations;
  for (const c of f.properties?.fclasses || []) A.push({ types: [{ identifier: GN_CLASS + c, label: FCLASS[c] || c }] });
  if (f.when) A.push(attestation({}, f.when, [], loss));
  for (const n of f.names || []) A.push(attestation({ names: [clean({ toponym: n.toponym, language: n.lang })] }, n.when, n.citations, loss));
  for (const t of f.types || []) {
    if ((t.sourceLabels || []).length > 1) loss({ kind: 'lpf-extra-source-labels', value: t.sourceLabels.length - 1 });
    A.push(attestation({ types: [clean({ identifier: expandLpf(t.identifier), label: t.label, sourceLabel: t.sourceLabels?.[0]?.label })] }, t.when, t.citations, loss));
  }
  const geoms = !f.geometry ? [] : f.geometry.type === 'GeometryCollection' ? f.geometry.geometries || [] : [f.geometry];
  for (const g of geoms) {
    const geom = clean({
      geojson: g.coordinates ? { type: g.type, coordinates: g.coordinates } : undefined,
      wkt: g.geowkt,
      reprPoint: g.type === 'Point' && g.coordinates ? g.coordinates.slice(0, 2) : undefined,
    });
    // A geometry's certainty qualifies the geometry itself.
    const gc = level(g.certainty);
    if (gc.certaintyLevel) geom.qualification = { certaintyLevel: gc.certaintyLevel };
    A.push(attestation({ geometries: [geom] }, g.when, g.citations, loss, { certaintyNote: gc.certaintyNote }));
  }
  for (const r of f.relations || []) {
    A.push(attestation({ relations: [clean({ relatesTo: expandLpf(r.relationTo), relationType: expandLpf(r.relationType), relationLabel: r.label })] }, r.when, r.citations, loss,
      level(r.certainty)));
  }
  for (const l of f.links || []) {
    if (l.type === 'closeMatch' || l.type === 'exactMatch') rec.identityRelations.push({ subject: f['@id'], object: expandLpf(l.identifier), identityType: l.type });
    else if (LINK_PROPERTY[l.type]) A.push({ properties: [{ property: LINK_PROPERTY[l.type], label: l.type, value: expandLpf(l.identifier) }] });
    else loss({ kind: 'lpf-link-type', value: l.type });
  }
  for (const d of f.descriptions || []) {
    const a = { properties: [clean({ property: DCT_DESCRIPTION, label: 'description', value: d.value })] };
    if (d.lang) loss({ kind: 'lpf-description-language', value: d.lang });
    const src = d.source || d['@id'];
    if (src) a.sources = [{ '@id': expandLpf(src), title: expandLpf(src), authorityType: 'source' }];
    A.push(a);
  }
  for (const d of f.depictions || []) {
    A.push({ properties: [clean({ property: FOAF_DEPICTION, label: d.title || 'depiction', value: expandLpf(d['@id']) })] });
    if (d.license) loss({ kind: 'lpf-depiction-licence', value: d.license });
  }
  if (!rec.identityRelations.length) delete rec.identityRelations;
  return rec;
}

// ---- PLATO record -> LPF Feature -------------------------------------------------------------
function platoToWhen(spans, note) {
  const ts = [], periods = [];
  let label;
  for (const t of spans || []) {
    if (t.periodoUri && !t.startEarliest && !t.endLatest) { periods.push(clean({ name: t.label, uri: t.periodoUri })); continue; }
    const start = t.startEarliest === t.startLatest || t.startLatest === undefined ? (t.startEarliest !== undefined ? { in: t.startEarliest } : undefined) : clean({ earliest: t.startEarliest, latest: t.startLatest });
    const end = t.endEarliest === t.endLatest || t.endEarliest === undefined ? (t.endLatest !== undefined ? { in: t.endLatest } : undefined) : clean({ earliest: t.endEarliest, latest: t.endLatest });
    if (start || end) ts.push(clean({ start: start || end, end: start && end && JSON.stringify(start) !== JSON.stringify(end) ? end : undefined }));
    // The date as the source wrote it, or else a period's name, is the when's label.
    if ((t.sourceLabel || t.label) && !label) label = t.sourceLabel || t.label;
  }
  if (!ts.length && !periods.length) return undefined;
  const lvl = (spans || []).map((t) => t.qualification?.certaintyLevel).find(Boolean);
  return clean({ timespans: ts.length ? ts : undefined, periods: periods.length ? periods : undefined, label, certainty: certaintyWord(lvl, note) });
}
function platoToCitations(a, loss) {
  const out = [];
  const cited = new Map();
  for (const c of a.citations || []) {
    const s = typeof c.source === 'string' ? { '@id': c.source } : c.source || {};
    const key = s['@id'] || s.title;
    cited.set(key, c);
  }
  for (const s0 of a.sources || []) {
    const s = typeof s0 === 'string' ? { '@id': s0 } : s0;
    const c = cited.get(s['@id'] || s.title);
    if (c?.attributionStatus) loss({ kind: 'attribution-status' });
    const year = s.timespan?.startEarliest && /^-?\d{4}$/.test(s.timespan.startEarliest) ? Number(s.timespan.startEarliest) : undefined;
    if (s.derivedFrom) loss({ kind: 'source-derivation' });
    out.push(clean({ label: [s.title || s['@id'], c?.locator].filter(Boolean).join(', '), year, '@id': s['@id'] || s.uri }));
  }
  return out;
}

/** PLATO place-centric record -> LPF Feature; `loss(l)` receives what LPF cannot hold. */
export function recordToFeature(rec, idrs = [], loss = () => {}) {
  const f = { '@id': rec['@id'], type: 'Feature', properties: clean({ title: rec.label, ccodes: rec.ccodes?.length ? rec.ccodes : undefined }), names: [], types: [], relations: [], links: [], descriptions: [], depictions: [] };
  const geoms = [], fclasses = [], whens = [];
  for (const a of rec.attestations || []) {
    const when = platoToWhen(a.timespans, a.certaintyNote);
    const cits = platoToCitations(a, loss);
    const facets = ['names', 'geometries', 'types', 'relations', 'properties'].filter((k) => a[k]?.length);
    if (facets.length > 1) loss({ kind: 'bundled-attestation', value: facets.join('+') });
    if (a.formStatus) loss({ kind: 'form-status', value: a.formStatus.replace(PLATO, '') });
    if (a.occurrenceContext) loss({ kind: 'occurrence-context', value: a.occurrenceContext.replace(PLATO, '') });
    if (a.occurrenceCount !== undefined) loss({ kind: 'occurrence-count' });
    if (a.certainty !== undefined) loss({ kind: 'numeric-certainty' });
    // LPF has certainty on a when, a geometry and a relation only.
    if (a.certaintyLevel && !a.geometries?.length && !a.relations?.length) loss({ kind: 'certainty-level', value: a.certaintyLevel.replace(PLATO, '') });
    else if (a.certaintyLevel && !WORD[a.certaintyLevel]) loss({ kind: 'certainty-level', value: a.certaintyLevel });
    if (a.meta) loss({ kind: 'meta-attestation' });
    if (!facets.length && when) { whens.push(when); continue; }
    for (const n of a.names || []) {
      if (n.qualification) loss({ kind: 'qualification' });
      if (n.sourceLabel) loss({ kind: 'source-label' });
      f.names.push(clean({ toponym: n.toponym, lang: n.language, citations: cits.length ? cits : undefined, when }));
    }
    for (const t of a.types || []) {
      if (t.identifier?.startsWith(GN_CLASS)) { fclasses.push(t.identifier.slice(GN_CLASS.length)); continue; }
      f.types.push(clean({ identifier: t.identifier, label: t.label, sourceLabels: t.sourceLabel ? [{ label: t.sourceLabel }] : undefined, when, citations: cits.length ? cits : undefined }));
    }
    for (const g of a.geometries || []) {
      const { certaintyLevel: gl, ...otherQual } = g.qualification || {};
      if (Object.keys(otherQual).length) loss({ kind: 'qualification' });
      if (g.sourceLabel) loss({ kind: 'source-label' });
      if (g.role) loss({ kind: 'geometry-role' });
      const lg = g.geojson ? { ...g.geojson } : g.reprPoint ? { type: 'Point', coordinates: g.reprPoint } : {};
      if (g.wkt) lg.geowkt = g.wkt;
      if (when) lg.when = when;
      if (cits.length) lg.citations = cits;
      const c = certaintyWord(gl || a.certaintyLevel, a.certaintyNote); if (c) lg.certainty = c;
      geoms.push(lg);
    }
    for (const r of a.relations || []) f.relations.push(clean({ relationType: r.relationType, relationTo: r.relatesTo, label: r.relationLabel, when, citations: cits.length ? cits : undefined, certainty: certaintyWord(a.certaintyLevel, a.certaintyNote) }));
    for (const p of a.properties || []) {
      if (p.property === DCT_DESCRIPTION) f.descriptions.push(clean({ value: String(p.value), source: cits[0]?.['@id'] }));
      else if (p.property === FOAF_DEPICTION) f.depictions.push(clean({ '@id': String(p.value), title: p.label !== 'depiction' ? p.label : undefined }));
      else if (PROPERTY_LINK[p.property]) f.links.push({ type: PROPERTY_LINK[p.property], identifier: String(p.value) });
      else loss({ kind: 'property-value', value: p.label || p.property });
    }
  }
  for (const ir of [...(rec.identityRelations || []), ...idrs]) {
    if (ir.identityType === 'exactMatch' || ir.identityType === 'closeMatch') f.links.push({ type: ir.identityType, identifier: ir.object });
    else { f.links.push({ type: 'closeMatch', identifier: ir.object }); loss({ kind: 'identity-type', value: ir.identityType }); }
    if (ir.certainty !== undefined || ir.basis) loss({ kind: 'identity-certainty-or-basis' });
  }
  if (fclasses.length) f.properties.fclasses = [...new Set(fclasses)];
  else loss({ kind: 'lpf-fclasses-missing' });
  if (whens.length) f.when = whens.length === 1 ? whens[0] : { timespans: whens.flatMap((w) => w.timespans || []), periods: whens.flatMap((w) => w.periods || []) };
  f.geometry = !geoms.length ? null : geoms.length === 1 ? geoms[0] : { type: 'GeometryCollection', geometries: geoms };
  for (const k of ['names', 'types', 'relations', 'links', 'descriptions', 'depictions']) if (!f[k].length) delete f[k];
  return f;
}
