// Linked Places Format v1 (the v1.2.2 README, with v1.3's fclasses): LPF Feature <-> PLATO record.
//
// LPF is PLATO's single-object-attestation profile, so reading LPF loses almost nothing: each name,
// type, geometry and relation becomes one attestation, carrying its own when and citations. The
// few LPF things PLATO JSON has no slot for are reported as losses, never dropped silently.
// Writing LPF from PLATO is lossy by design (bundling, locators, form status, numeric certainty
// and more have no LPF slot); every loss is reported, with counts.
import { PLATO, isAbsoluteIri } from '../lib/context.js';
import { list, isDenial, isAlternative, qualificationLosses, currentAttestations, isFigure, dropKeys, dropKey, isComputed, isComputedFacet, identityBundleLosses, evidenceSpanLosses, isContainedIn } from './shared.js';

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

// A year of fewer than four digits is padded to four ('921' -> '0921'); longer years (deep time,
// '-12000', since PLATO cf87b78) are kept as they are. A whole-number year is written as a string.
const pad = (s0) => {
  const s = typeof s0 === 'number' && Number.isInteger(s0) ? String(s0) : s0;
  return typeof s === 'string' && /^-?\d{1,3}$/.test(s) ? (s.startsWith('-') ? '-' + s.slice(1).padStart(4, '0') : s.padStart(4, '0')) : s;
};
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
// A position's first two coordinates, or nothing when the coordinates are not a list.
const firstTwo = (c) => (Array.isArray(c) ? c.slice(0, 2) : undefined);
const certaintyWord = (lvl, note) => WORD[lvl] || (note && /LPF certainty: (certain|less-certain|uncertain)/.exec(note)?.[1]) || undefined;

/**
 * A member LPF gives as a list: given as something else, it is not read, and reported to `loss`.
 * LPF has no JSON Schema in these tools to say so, and the record made from it is valid without it.
 */
function many(x, key, loss) {
  // null, like a missing key, is nothing there (LPF writes null where it has no value); anything
  // else that is not a list was something that could not be read.
  if (x === undefined || x === null || Array.isArray(x)) return x || [];
  loss({ kind: 'lpf-not-a-list', value: key });
  return [];
}

/** LPF when -> PLATO timespans; the when's certainty qualifies each of its timespans. */
function whenToPlato(when, loss) {
  if (!when) return {};
  const spans = many(when.timespans, 'when.timespans', loss).map((t) => {
    const end = t.end ?? t.start;   // "if end is omitted, the timespan is interpreted as the interval described by the start"
    return clean({ startEarliest: bound(t.start, 'earliest'), startLatest: bound(t.start, 'latest'), endEarliest: bound(end, 'earliest'), endLatest: bound(end, 'latest') });
  });
  for (const p of many(when.periods, 'when.periods', loss)) spans.push(clean({ label: p.name, periodoUri: expandLpf(p.uri || p['@id']) }));
  if (when.label && spans.length) spans[0].label = spans[0].label ? spans[0].label + '; ' + when.label : when.label;
  if (when.duration) loss({ kind: 'lpf-duration', value: when.duration });
  const c = level(when.certainty);
  if (c.certaintyLevel && spans.length) { for (const t of spans) t.qualification = { certaintyLevel: c.certaintyLevel }; return { timespans: spans }; }
  return { timespans: spans, ...c };
}
function citationsToSources(cits, loss) {
  return many(cits, 'citations', loss).map((c) => clean({
    ...(c['@id'] ? { '@id': expandLpf(c['@id']) } : {}), title: c.label || c['@id'] || 'untitled', authorityType: 'source',
    timespan: c.year !== undefined ? { sourceLabel: String(c.year), startEarliest: pad(String(c.year)), endLatest: pad(String(c.year)) } : undefined,
  }));
}
function attestation(facets, when, cits, loss, extra = {}) {
  const w = whenToPlato(when, loss);
  const certaintyNote = [w.certaintyNote, extra.certaintyNote].filter(Boolean).join('; ') || undefined;
  return clean({ ...facets, timespans: w.timespans, sources: citationsToSources(cits, loss), certaintyLevel: extra.certaintyLevel || w.certaintyLevel, certaintyNote });
}

/** LPF Feature -> PLATO place-centric record. `loss(l)` receives what PLATO JSON cannot hold. */
export function featureToRecord(f, loss = () => {}) {
  const rec = { '@id': f['@id'], label: f.properties?.title, ccodes: many(f.properties?.ccodes, 'properties.ccodes', loss), attestations: [], identityRelations: [] };
  if (rec['@id'] === undefined) delete rec['@id'];
  if (!rec.ccodes?.length) delete rec.ccodes;
  const A = rec.attestations;
  for (const c of many(f.properties?.fclasses, 'properties.fclasses', loss)) A.push({ types: [{ identifier: GN_CLASS + c, label: FCLASS[c] || c }] });
  if (f.when) A.push(attestation({}, f.when, [], loss));
  for (const n of many(f.names, 'names', loss)) A.push(attestation({ names: [clean({ toponym: n.toponym, language: n.lang })] }, n.when, n.citations, loss));
  for (const t of many(f.types, 'types', loss)) {
    const labels = many(t.sourceLabels, 'types.sourceLabels', loss);
    if (labels.length > 1) loss({ kind: 'lpf-extra-source-labels', value: labels.length - 1 });
    A.push(attestation({ types: [clean({ identifier: expandLpf(t.identifier), label: t.label, sourceLabel: labels[0]?.label })] }, t.when, t.citations, loss));
  }
  const geoms = !f.geometry ? [] : f.geometry.type === 'GeometryCollection' ? many(f.geometry.geometries, 'geometry.geometries', loss) : [f.geometry];
  for (const g of geoms) {
    const geom = clean({
      geojson: g.coordinates ? { type: g.type, coordinates: g.coordinates } : undefined,
      wkt: g.geowkt,
      reprPoint: g.type === 'Point' && Array.isArray(g.coordinates) ? g.coordinates.slice(0, 2) : undefined,
    });
    // A geometry's certainty qualifies the geometry itself.
    const gc = level(g.certainty);
    if (gc.certaintyLevel) geom.qualification = { certaintyLevel: gc.certaintyLevel };
    A.push(attestation({ geometries: [geom] }, g.when, g.citations, loss, { certaintyNote: gc.certaintyNote }));
  }
  for (const r of many(f.relations, 'relations', loss)) {
    // gvp:broaderPartitive is the authority plato:ContainedIn declares, and what the writer makes of it
    // (PLATO 1d2cf6e, #23); a gazetteer match's score has no place on a relation, and is reported.
    const type = expandLpf(r.relationType) === GVP_BROADER_PARTITIVE ? PLATO + 'ContainedIn' : expandLpf(r.relationType);
    if (r.whg_match_score !== undefined && r.whg_match_score !== null) loss({ kind: 'lpf-match-score', value: expandLpf(r.relationTo) });
    A.push(attestation({ relations: [clean({ relatesTo: expandLpf(r.relationTo), relationType: type, relationLabel: r.label })] }, r.when, r.citations, loss,
      level(r.certainty)));
  }
  for (const l of many(f.links, 'links', loss)) {
    if (l.type === 'closeMatch' || l.type === 'exactMatch') rec.identityRelations.push({ subject: f['@id'], object: expandLpf(l.identifier), identityType: l.type });
    else if (LINK_PROPERTY[l.type]) A.push({ properties: [{ property: LINK_PROPERTY[l.type], label: l.type, value: expandLpf(l.identifier) }] });
    else loss({ kind: 'lpf-link-type', value: l.type });
  }
  for (const d of many(f.descriptions, 'descriptions', loss)) {
    const a = { properties: [clean({ property: DCT_DESCRIPTION, label: 'description', value: d.value })] };
    if (d.lang) loss({ kind: 'lpf-description-language', value: d.lang });
    const src = d.source || d['@id'];
    if (src) a.sources = [{ '@id': expandLpf(src), title: expandLpf(src), authorityType: 'source' }];
    A.push(a);
  }
  for (const d of many(f.depictions, 'depictions', loss)) {
    A.push({ properties: [clean({ property: FOAF_DEPICTION, label: d.title || 'depiction', value: expandLpf(d['@id']) })] });
    if (d.license) loss({ kind: 'lpf-depiction-licence', value: d.license });
  }
  if (!rec.identityRelations.length) delete rec.identityRelations;
  return rec;
}

// ---- PLATO record -> LPF Feature -------------------------------------------------------------
// What LPF holds of each PLATO object; every other key present is reported (dropKeys), including a
// key PLATO adds after this was written. The keys handled case by case are noted where they are.
const KEEPS = {
  gazetteer: new Set(['@id', 'title', 'licence', 'description', 'version', 'status', 'isVersionOf', 'previousVersion']),   // versions: versionLosses
  spatialEntity: new Set(['@id', 'label', 'ccodes', 'attestations', 'identityRelations']),
  // certaintyNote: kept only as LPF's own certainty word, written by the LPF reader
  // timespanRole: an evidence span is never written as a when (evidenceSpanLosses)
  attestation: new Set(['about', 'names', 'geometries', 'timespans', 'types', 'properties', 'relations', 'sources', 'citations', 'meta', 'certainty', 'certaintyLevel', 'certaintyNote', 'negated', 'occurrenceCount', 'occurrenceContext', 'formStatus', 'computed', 'identities', 'timespanRole']),
  name: new Set(['toponym', 'language', 'sourceLabel', 'qualification']),
  geometry: new Set(['wkt', 'geojson', 'reprPoint', 'bbox', 'role', 'sourceLabel', 'qualification']),   // reprPoint: only without a shape
  timespan: new Set(['startEarliest', 'startLatest', 'endEarliest', 'endLatest', 'label', 'sourceLabel', 'periodoUri', 'qualification']),
  type: new Set(['identifier', 'label', 'sourceLabel', 'qualification']),
  // uri: only where there is no @id; authorityType: only 'source'; timespan: one year (citationYear)
  source: new Set(['@id', 'title', 'uri', 'timespan', 'derivedFrom', 'authorityType']),
  citation: new Set(['source', 'locator', 'attributionStatus', 'citationFunction']),
  relation: new Set(['relatesTo', 'relationType', 'relationLabel']),
  identityRelation: new Set(['subject', 'object', 'identityType', 'certainty', 'basis']),
  // a description, depiction or link: label only as a depiction's title
  propertyValue: new Set(['property', 'value', 'label', 'qualification']),
};
export { KEEPS as LPF_KEEPS };

/** PLATO timespans -> an LPF when; `loss` receives what the when cannot hold. */
function platoToWhen(spans, note, loss = () => {}) {
  const ts = [], periods = [], labels = [];
  let lvl;
  for (const t of list(spans)) {
    dropKeys(t, 'timespan', KEEPS.timespan, loss);
    const start = t.startEarliest === t.startLatest || t.startLatest === undefined ? (t.startEarliest !== undefined ? { in: t.startEarliest } : undefined) : clean({ earliest: t.startEarliest, latest: t.startLatest });
    const end = t.endEarliest === t.endLatest || t.endEarliest === undefined ? (t.endLatest !== undefined ? { in: t.endLatest } : undefined) : clean({ earliest: t.endEarliest, latest: t.endLatest });
    const dated = !!(start || end);
    if (dated) ts.push(clean({ start: start || end, end: start && end && JSON.stringify(start) !== JSON.stringify(end) ? end : undefined }));
    // A PeriodO period is one of the when's periods, dated or not.
    if (t.periodoUri) periods.push(clean({ name: t.label, uri: t.periodoUri }));
    else if (!dated) { if (t.sourceLabel || t.label || t.qualification?.certaintyLevel) loss({ kind: 'lpf-undated', value: t.sourceLabel || t.label || t.qualification.certaintyLevel }); continue; }
    // The when has one label: the date as the source wrote it, and any period's name, joined.
    for (const l of [t.sourceLabel, t.periodoUri ? undefined : t.label]) if (l && !labels.includes(l)) labels.push(l);
    const l = t.qualification?.certaintyLevel;
    if (l && lvl && l !== lvl) dropKey('timespan', 'certaintyLevel', loss);
    lvl = lvl || l;
  }
  if (!ts.length && !periods.length) return undefined;
  return clean({ timespans: ts.length ? ts : undefined, periods: periods.length ? periods : undefined, label: labels.join('; ') || undefined, certainty: certaintyWord(lvl, note) });
}
/** A cited source's date as LPF's one citation year; the rest of the date is reported. */
function citationYear(ts, loss) {
  if (!ts || typeof ts !== 'object') return undefined;
  const year = (d) => (typeof d === 'string' ? /^(-?\d{4,})(?:-|$)/.exec(d)?.[1] : undefined);
  const y = year(ts.startEarliest);
  for (const k of Object.keys(ts)) {
    if (ts[k] === undefined || ts[k] === null) continue;
    if (k === 'startEarliest' && y && y === ts.startEarliest) continue;
    if (k === 'endLatest' && y && ts.endLatest === y) continue;
    if (k === 'qualification' && typeof ts[k] === 'object') { for (const q of Object.keys(ts[k])) if (ts[k][q] !== undefined && ts[k][q] !== null) loss({ kind: 'dropped', key: `source.timespan.qualification.${q}` }); continue; }
    loss({ kind: 'dropped', key: `source.timespan.${k}` });
  }
  return y !== undefined ? Number(y) : undefined;
}
function platoToCitations(a, loss) {
  const out = [];
  const cited = new Map();
  const asObject = (s) => (typeof s === 'string' ? { '@id': s } : s || {});
  const keyOf = (s) => s['@id'] || s.title;
  for (const c of list(a.citations)) cited.set(keyOf(asObject(c.source)), c);
  // Every source the attestation names, in `sources` or only in a citation, once each; where one is
  // named both by address and in full, the fuller description is kept.
  const all = new Map();
  for (const s0 of [...list(a.sources), ...list(a.citations).map((c) => c.source)]) {
    if (!s0) continue;
    const s = asObject(s0), k = keyOf(s), prev = all.get(k);
    if (!prev || Object.keys(s).length > Object.keys(prev).length) all.set(k, s);
  }
  for (const c of list(a.citations)) dropKeys(c, 'citation', KEEPS.citation, loss);
  for (const [k, s] of all) {
    const c = cited.get(k);
    if (c?.attributionStatus) loss({ kind: 'attribution-status' });
    if (c?.citationFunction) loss({ kind: 'citation-function' });
    dropKeys(s, 'source', KEEPS.source, loss);
    if (s.uri && s['@id'] && s.uri !== s['@id']) dropKey('source', 'uri', loss);
    if (s.authorityType && s.authorityType !== 'source') dropKey('source', 'authorityType', loss);
    const year = citationYear(s.timespan, loss);
    if (s.derivedFrom) loss({ kind: 'source-derivation' });
    out.push(clean({ label: [s.title || s['@id'], c?.locator].filter(Boolean).join(', '), year, '@id': s['@id'] || s.uri }));
  }
  return out;
}

/**
 * The FeatureCollection's own members from a PLATO document header. LPF's context maps `@id`,
 * `title` (dct:title), `license` (dct:license) and `descriptions` (dct:description, as on a feature:
 * objects with a `value`); it has no term for a contributor. `loss` receives the rest.
 */
export function collectionHead(gazetteer, loss = () => {}) {
  const g = gazetteer && typeof gazetteer === 'object' ? gazetteer : {};
  dropKeys(g, 'gazetteer', KEEPS.gazetteer, loss);
  return clean({ '@id': g['@id'], title: g.title, license: g.licence, descriptions: g.description ? [{ value: g.description }] : undefined });
}
/**
 * The PLATO gazetteer header from a FeatureCollection's own members (collectionHead's inverse).
 * LPF's license may be prose ("… released under a Creative Commons Attribution-NonCommercial 4.0
 * International License", as DEEP writes it); PLATO's licence must be a web address, so prose is
 * reported to `loss` and not put where an address belongs. An LPF short form (cc:by/4.0/) expands.
 */
export function collectionToGazetteer(fc, fallbackTitle, loss = () => {}) {
  const d = many(fc.descriptions, 'descriptions', loss).map((x) => (typeof x === 'string' ? x : x?.value)).find((x) => typeof x === 'string');
  let licence;
  if (typeof fc.license === 'string' && fc.license.trim()) {
    const x = expandLpf(fc.license.trim());
    if (isAbsoluteIri(x) && !/\s/.test(x)) licence = x; else loss({ kind: 'lpf-licence-text', value: fc.license });
  }
  return clean({ '@id': fc['@id'] || fc.id, title: typeof fc.title === 'string' && fc.title ? fc.title : fallbackTitle, description: d, licence });
}

// ---- regions matched to a gazetteer (PLATO 1d2cf6e, #23) -----------------------------------------
// The dataset says a place is ContainedIn a region minted from its own data; a reviewer's attestation
// says that region is the gazetteer's (an identity, closeMatch or exactMatch), and its promotedFrom
// names the Candidate, in a candidate set published apart, that holds the matching software's score.
// LPF writes the two as one relation, as WHG does: gvp:broaderPartitive, whose relationTo is the
// identity's object, certainty the reviewer's level, whg_match_score the Candidate's score and label
// the region's name. A region assigned by hand (ContainedIn straight at the gazetteer, or at a region
// with no current match) is written as it stands. Where the writer cannot tell (several current
// matches, a score it was not given), it writes no guess and reports it.
const BROADER_PARTITIVE = 'gvp:broaderPartitive', GVP_BROADER_PARTITIVE = LPF_PREFIXES.gvp + 'broaderPartitive';
const SAME_PLACE = new Set(['exactMatch', 'closeMatch']);
/** A record's label, which names a region only where it has no current name attestation (RegionIndex). */
export const regionLabel = (rec) => (typeof rec?.label === 'string' && rec.label) || undefined;

/**
 * What the whole document says of the regions its places are ContainedIn, gathered before any feature
 * is written (a region's match may come anywhere in the file): the attestations bundling identities
 * from each region, reduced to what is needed here, and the region's name; then the scores of the
 * Candidates they were promoted from, from the candidate sets given (setCandidates).
 */
export class RegionIndex {
  constructor() { this.matches = new Map(); this.names = new Map(); this.labels = new Map(); this.targets = new Set(); this.candidates = null; this.cache = new Map(); }
  /** Gather from the attestations of the record `subject`, whose name (regionLabel) is `label`. */
  add(attestations, subject, label) {
    for (const a of list(attestations)) {
      if (!a || typeof a !== 'object') continue;
      for (const r of list(a.relations)) if (r && isContainedIn(r.relationType) && typeof r.relatesTo === 'string') this.targets.add(r.relatesTo);
      if (!Array.isArray(a.identities)) continue;
      const own = new Map();   // region -> this attestation, with that region's identities only
      for (const ir of a.identities) {
        if (!ir || typeof ir !== 'object' || typeof ir.object !== 'string') continue;
        const region = typeof ir.subject === 'string' ? ir.subject : typeof a.about === 'string' ? a.about : subject;
        if (typeof region !== 'string') continue;
        if (!own.has(region)) own.set(region, { '@id': a['@id'], negated: a.negated, certaintyLevel: a.certaintyLevel, identities: [] });
        own.get(region).identities.push({ object: ir.object, identityType: ir.identityType, promotedFrom: ir.promotedFrom });
      }
      for (const [region, stub] of own) (this.matches.get(region) || this.matches.set(region, []).get(region)).push(stub);
    }
    // A name is kept only for a region with a match, so that the index stays small on a large file: one
    // with none is written under its own address, where an LPF reader finds the region's feature.
    if (typeof subject !== 'string' || !this.matches.has(subject)) return;
    if (label) this.labels.set(subject, label);
    // Its name attestations, reduced to what says whether each is current, and the first toponym.
    for (const a of list(attestations)) {
      if (!a || typeof a !== 'object' || (typeof a.about === 'string' && a.about !== subject)) continue;
      const toponym = list(a.names).find((n) => typeof n?.toponym === 'string' && n.toponym)?.toponym;
      if (toponym) (this.names.get(subject) || this.names.set(subject, []).get(subject)).push({ '@id': a['@id'], negated: a.negated, toponym });
    }
  }
  /** Keep only what concerns the regions some place is ContainedIn; returns the Candidates wanted. */
  prune() {
    for (const m of [this.matches, this.names, this.labels]) for (const k of [...m.keys()]) if (!this.targets.has(k)) m.delete(k);
    const wanted = new Set();
    for (const stubs of this.matches.values()) for (const s of stubs) for (const ir of s.identities) if (typeof ir.promotedFrom === 'string') wanted.add(ir.promotedFrom);
    return wanted;
  }
  /**
   * True when attestation `a` of record `id` is a current match whose certainty level the region's
   * gvp:broaderPartitive carries, so that the level is written, not dropped.
   */
  carries(id, a, withdrawn) {
    if (!this.targets.has(id) || typeof a?.['@id'] !== 'string' || !a.certaintyLevel) return false;
    const m = this.resolve(id, withdrawn);
    return !!(m.relationTo && m.from?.has(a['@id']) && m.certaintyLevel === a.certaintyLevel && WORD[a.certaintyLevel]);
  }
  /** The Candidates found in the sets given: @id -> { subject, object, score }; null when none were given. */
  setCandidates(found) { this.candidates = found; this.cache.clear(); }
  /**
   * What the document says of `region` now: { label, relationTo?, certaintyLevel?, score?, several?,
   * noScore?, certaintyDiffers? }. Only the current state counts: an attestation the document
   * withdraws (`withdrawn`, as for every attestation the writer leaves out) or a denial is not a match.
   */
  resolve(region, withdrawn) {
    if (this.cache.has(region)) return this.cache.get(region);
    // WHG's label is the region's name (Surrey), not its display label (Surrey (England)): the toponym of a
    // current name attestation, not denied, first; the record's label only where there is none.
    const named = currentAttestations({ attestations: this.names.get(region) || [] }, withdrawn, () => {}).find((a) => !isDenial(a));
    const out = { label: named?.toponym || this.labels.get(region) };
    const live = currentAttestations({ attestations: this.matches.get(region) || [] }, withdrawn, () => {}).filter((a) => !isDenial(a));
    const same = live.flatMap((a) => a.identities.filter((ir) => SAME_PLACE.has(ir.identityType)).map((ir) => ({ a, ir })));
    const objects = [...new Set(same.map((x) => x.ir.object))];
    if (objects.length > 1) out.several = objects;
    else if (objects.length === 1) {
      out.relationTo = objects[0];
      out.from = new Set(same.map((x) => x.a['@id']).filter((id) => typeof id === 'string'));
      const levels = [...new Set(same.map((x) => x.a.certaintyLevel ?? null))];
      if (levels.length === 1) out.certaintyLevel = levels[0] ?? undefined; else out.certaintyDiffers = true;
      // A score only from a Candidate for this pair (either way round, as promotedFrom allows), and only
      // when every match promoted from one agrees on it; never a score found for another pair.
      const promoted = [...new Set(same.map((x) => x.ir.promotedFrom).filter((p) => typeof p === 'string'))];
      const scores = new Set();
      for (const p of promoted) {
        const c = this.candidates?.get(p);
        const pair = c && ((c.subject === region && c.object === out.relationTo) || (c.subject === out.relationTo && c.object === region));
        if (pair && c.conflict) { out.noScore = p; out.noScoreKind = 'region-match-score-conflict'; break; }
        if (pair && typeof c.score !== 'number') { out.noScore = p; out.noScoreKind = 'region-match-unscored'; break; }
        if (pair) scores.add(c.score); else { out.noScore = p; break; }
      }
      if (!out.noScore && scores.size === 1) out.score = [...scores][0];
      else if (!out.noScore && scores.size > 1) out.noScore = promoted[0];
    }
    this.cache.set(region, out);
    return out;
  }
}

/** One ContainedIn of attestation `a`, as LPF's gvp:broaderPartitive (see RegionIndex above). */
function containment(r, a, when, cits, regions, withdrawn, loss) {
  const m = regions ? regions.resolve(r.relatesTo, withdrawn) : {};
  const own = certaintyWord(a.certaintyLevel, a.certaintyNote);
  const rel = { relationType: BROADER_PARTITIVE, relationTo: r.relatesTo, label: r.relationLabel || m.label, when, citations: cits.length ? cits : undefined, certainty: own };
  if (m.several) loss({ kind: 'region-match-several', value: r.relatesTo });
  if (m.relationTo) {
    rel.relationTo = m.relationTo;
    rel.certainty = certaintyWord(m.certaintyLevel);
    if (m.certaintyLevel && !rel.certainty) loss({ kind: 'certainty-level', value: m.certaintyLevel });
    if (m.certaintyDiffers) loss({ kind: 'region-match-certainty', value: r.relatesTo });
    // The containment's own certainty has no place beside the reviewer's.
    if (own && own !== rel.certainty) loss({ kind: 'region-containment-certainty', value: a['@id'] || r.relatesTo });
    if (m.score !== undefined) rel.whg_match_score = m.score;
    else if (m.noScore) loss({ kind: m.noScoreKind || 'region-match-no-score', value: m.noScore });
  }
  return clean(rel);
}

/**
 * PLATO place-centric record -> LPF Feature; `loss(l)` receives what LPF cannot hold. `withdrawn`
 * (attestation @id -> 'retracted' | 'superseded') is what the rest of the document withdraws or
 * replaces: LPF has no meta-attestations, so it shows the current state and leaves those out.
 * `regions` (a RegionIndex) is what the document says of the regions its places are ContainedIn;
 * without it, a ContainedIn is written as it stands.
 */
export function recordToFeature(rec, idrs = [], loss = () => {}, withdrawn = null, regions = null) {
  const f = { '@id': rec['@id'], type: 'Feature', properties: clean({ title: rec.label, ccodes: rec.ccodes?.length ? rec.ccodes : undefined }), names: [], types: [], relations: [], links: [], descriptions: [], depictions: [] };
  const geoms = [], fclasses = [], whens = [];
  dropKeys(rec, 'spatialEntity', KEEPS.spatialEntity, loss);
  for (const whole of currentAttestations(rec, withdrawn, loss)) {
    // A computed value (plato:computed) is not evidence, and LPF cannot mark one: written, it would
    // read as a source's statement. A computed attestation or facet is left out, and reported.
    if (isComputed(whole)) { loss({ kind: 'computed', value: whole['@id'] || rec['@id'] }); continue; }
    const a = { ...whole };
    for (const k of ['names', 'geometries', 'types', 'properties', 'timespans']) {
      if (!Array.isArray(a[k]) || !a[k].some(isComputedFacet)) continue;
      loss({ kind: 'computed', value: `${whole['@id'] || rec['@id']} (${k})` });
      a[k] = a[k].filter((f) => !isComputedFacet(f));
    }
    // An evidence span (timespanRole EvidenceSpan) dates the documents, not the place: as a when it
    // would date the place, so it is left out, and reported (PLATO 7720890, #20).
    evidenceSpanLosses(a, whole['@id'] || rec['@id'], loss);
    dropKeys(a, 'attestation', KEEPS.attestation, loss);
    // Identities the attestation bundles are never made links: a link states a match on its own, and
    // in a denial they say that two places are not the same (identityBundleLosses).
    const bundled = identityBundleLosses(a, rec['@id'], loss);
    // LPF cannot say that a source denies something: a denial written as LPF would assert what its
    // source says is not so. It is left out, and reported (PLATO cf87b78).
    if (isDenial(a)) { if (!bundled) loss({ kind: 'denial', value: rec['@id'] }); continue; }
    const when = platoToWhen(a.timespans, a.certaintyNote, loss);
    // A note on certainty is kept only as LPF's own certainty word, which the LPF reader writes.
    if (a.certaintyNote && !/^LPF certainty: (certain|less-certain|uncertain)$/.test(a.certaintyNote)) dropKey('attestation', 'certaintyNote', loss);
    const cits = platoToCitations(a, loss);
    const facets = ['names', 'geometries', 'types', 'relations', 'properties'].filter((k) => a[k]?.length);
    if (facets.length > 1) loss({ kind: 'bundled-attestation', value: facets.join('+') });
    if (a.formStatus) loss({ kind: 'form-status', value: a.formStatus.replace(PLATO, '') });
    if (a.occurrenceContext) loss({ kind: 'occurrence-context', value: a.occurrenceContext.replace(PLATO, '') });
    if (a.occurrenceCount !== undefined) loss({ kind: 'occurrence-count' });
    if (a.certainty !== undefined) loss({ kind: 'numeric-certainty' });
    // LPF has certainty on a when, a geometry and a relation only.
    if (a.certaintyLevel && !a.geometries?.length && !a.relations?.length && !regions?.carries(rec['@id'], a, withdrawn)) loss({ kind: 'certainty-level', value: a.certaintyLevel.replace(PLATO, '') });
    else if (a.certaintyLevel && !WORD[a.certaintyLevel]) loss({ kind: 'certainty-level', value: a.certaintyLevel });
    // Alternative readings are written, each as its own claim: that at most one is right is lost,
    // and said so in its own words, since it changes what the output claims.
    if (a.meta) loss(isAlternative(a.meta) ? { kind: 'alternative-readings', value: a['@id'] } : { kind: 'meta-attestation' });
    for (const t of list(a.timespans)) qualificationLosses(t.qualification, ['certaintyLevel'], loss);
    if (!facets.length && when) { whens.push(when); continue; }
    for (const n of list(a.names)) {
      qualificationLosses(n.qualification, [], loss);
      if (n.sourceLabel) loss({ kind: 'source-label' });
      dropKeys(n, 'name', KEEPS.name, loss);
      f.names.push(clean({ toponym: n.toponym, lang: n.language, citations: cits.length ? cits : undefined, when }));
    }
    for (const t of list(a.types)) {
      qualificationLosses(t.qualification, [], loss);
      dropKeys(t, 'type', KEEPS.type, loss);
      if (t.identifier?.startsWith(GN_CLASS)) { fclasses.push(t.identifier.slice(GN_CLASS.length)); continue; }
      f.types.push(clean({ identifier: t.identifier, label: t.label, sourceLabels: t.sourceLabel ? [{ label: t.sourceLabel }] : undefined, when, citations: cits.length ? cits : undefined }));
    }
    for (const g of list(a.geometries)) {
      const gl = g.qualification?.certaintyLevel;
      qualificationLosses(g.qualification, ['certaintyLevel'], loss);
      if (g.sourceLabel) loss({ kind: 'source-label' });
      if (g.role) loss({ kind: 'geometry-role' });
      dropKeys(g, 'geometry', KEEPS.geometry, loss);
      // A representative point beside a shape has no place of its own in a GeoJSON geometry.
      if (g.geojson && g.reprPoint && !(g.geojson.type === 'Point' && JSON.stringify(firstTwo(g.geojson.coordinates)) === JSON.stringify(g.reprPoint))) dropKey('geometry', 'reprPoint', loss);
      const lg = g.geojson ? { ...g.geojson } : g.reprPoint ? { type: 'Point', coordinates: g.reprPoint } : {};
      if (g.bbox) lg.bbox = g.bbox;   // a GeoJSON member, which LPF's context maps
      if (g.wkt) lg.geowkt = g.wkt;
      if (when) lg.when = when;
      if (cits.length) lg.citations = cits;
      const c = certaintyWord(gl || a.certaintyLevel, a.certaintyNote); if (c) lg.certainty = c;
      geoms.push(lg);
    }
    // LPF's relationTo is required: a relation named only by its label (PLATO 7720890, #18: "in the
    // Delta") has no target address, so it is left out whole, and reported once.
    const targeted = [];
    for (const r of list(a.relations)) {
      if (!r || typeof r.relatesTo !== 'string' || !r.relatesTo) { loss({ kind: 'relation-without-target', value: r?.relatedLabel || rec['@id'] }); continue; }
      dropKeys(r, 'relation', KEEPS.relation, loss);
      targeted.push(r);
    }
    for (const r of targeted) f.relations.push(isContainedIn(r.relationType) ? containment(r, a, when, cits, regions, withdrawn, loss) : clean({ relationType: r.relationType, relationTo: r.relatesTo, label: r.relationLabel, when, citations: cits.length ? cits : undefined, certainty: certaintyWord(a.certaintyLevel, a.certaintyNote) }));
    for (const p of list(a.properties)) {
      if (isFigure(p)) { loss({ kind: 'statistical-figure', value: p['@id'] || p.label || p.property }); continue; }
      qualificationLosses(p.qualification, [], loss);
      const lpfKind = p.property === DCT_DESCRIPTION ? 'description' : p.property === FOAF_DEPICTION ? 'depiction' : PROPERTY_LINK[p.property];
      if (!lpfKind) { loss({ kind: 'property-value', value: p.label || p.property }); continue; }
      dropKeys(p, 'propertyValue', KEEPS.propertyValue, loss);
      // A label is a depiction's title; on a description or a link it is only the property's name.
      if (p.label && lpfKind !== 'depiction' && p.label !== lpfKind) dropKey('propertyValue', 'label', loss);
      if (lpfKind === 'description') f.descriptions.push(clean({ value: String(p.value), source: cits[0]?.['@id'] }));
      else if (lpfKind === 'depiction') f.depictions.push(clean({ '@id': String(p.value), title: p.label !== 'depiction' ? p.label : undefined }));
      else f.links.push({ type: lpfKind, identifier: String(p.value) });
    }
  }
  for (const ir of [...list(rec.identityRelations), ...idrs]) {
    dropKeys(ir, 'identityRelation', KEEPS.identityRelation, loss);
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
