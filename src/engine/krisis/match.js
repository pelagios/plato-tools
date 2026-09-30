// Krisis: find the places of one dataset (the subjects) that may be the same as places of another
// (the others), for a person to review. Nothing here decides anything: it suggests, and writes the
// suggestions to a work file (src/engine/krisis/work.js), where the reviewer's decisions are kept.
//
// Each dataset is read by the engine that checks and converts (run() in pipeline.js, with
// options.sink, as the version check reads), so every input format reaches the matcher as
// place-centric records. Of each place only what matching needs is kept: its address, label and
// names, one representative point, its country codes and types, and the identity relations the
// dataset already states. Names are compared as src/engine/krisis/names.js says; two names are only
// compared when they share enough trigrams, found through the rarer ones (blocking.js), so the work
// grows with the pairs of names that share something uncommon, not with the product of the datasets.
//
// A pair is suggested when its best name score reaches the threshold, the two are not further apart
// than the greatest distance (when both have a point), and the datasets do not already link them,
// or say that they are different places. Each subject place keeps its best few,
// those near it before those with no point.
import { run } from '../pipeline.js';
import { Report } from '../report.js';
import { collectWithdrawn, resolveWithdrawn, currentAttestations } from '../../formats/shared.js';
import { DISTINCT_GATE } from './names.js';
import { NameIndex, BLOCKING, BLOCKING_RULE } from './blocking.js';
import { WORK_VERSION, MATCH_DEFAULTS, fileRecords, serialiseWork, checkReviewer, checkMatchOptions } from './work.js';
import { KRISIS_TEXT } from '../words.js';

export const ALGORITHM = 'krisis-names 4';
export const DEFAULTS = MATCH_DEFAULTS;
export { BLOCKING };
export const SCORING = 'Each name of a place (its label and every toponym and romanised form) is normalised: '
  + 'decomposed (NFKD), combining marks removed, ß æ œ ø ł đ ð þ ı spelt out, lower-cased, and everything but letters and digits made a space. '
  + 'Two names score their Jaro-Winkler similarity (prefix scale 0.1, up to four letters), or, if higher, that of their words sorted alphabetically. '
  + 'Names that share a word are held to the words they do not share: a word also counts as shared with its known short form, and only these: St and Saint, Ste and Sainte, Mt and Mount, Ft and Fort, Pt and Port, on and upon. '
  + 'Each word weighs its inverse document frequency in the names of both datasets, ln(1 + N / df). If the words left of each name score at least '
  + `${DISTINCT_GATE} (as above), or are one letter added, dropped, changed or two swapped apart, the pair scores the shared words' share of the weight of all the words of the two (a shared word counted once), plus the rest's score times the remaining share; `
  + "otherwise the shared words' share alone. The lower of this and the name score is the score. "
  + 'A distinctive word of three letters with one letter changed scores 0.78 to 0.82 on its letters, so such a pair reaches 0.85 only when the words it shares weigh from a sixth to a third of all its words: '
  + 'for words of three letters one letter is already the limit, and a common shared word takes the pair under it (Kafr Cal and Kafr Cel score 0.87 with every word weighed alike, and under 0.85 where Kafr is common). '
  + 'The one exception that raises a score: two names whose words are all shared, some only as a known short form (as above: St and Saint, Mt and Mount), '
  + 'are scored again with each short form written out in full, and the higher score is kept. '
  + 'Two places score the best of any pair of their names, over the pairs blocking allows (see blocking). '
  + "A place's point is the first Point geometry of its attestations, else the centre of the first bounding box, else none, passing over attestations that are negated or withdrawn (retracted or superseded); "
  + 'a pair whose points are further apart than maxDistanceKm (great-circle distance) is dropped, and a pair without two points is kept, with no distance. '
  + 'Pairs that either dataset already links by an identity relation, or says are different places, are not suggested. '
  + 'Each subject place keeps its topK best: when it has a point, first the places within maxDistanceKm of it, and then, in the places left, those with no point; '
  + 'each group by score, then distance.';

// A problem of a dataset's own that stops part of it being read: the matching is then of less than the whole.
const NOT_READ = new Set(['json-syntax', 'rdf-syntax', 'record-failed', 'late-header', 'lpf-v2']);
const TEXT = {
  'no-address': (word) => `A place in the ${word} has no web address (@id), so it cannot be matched: an identity relation needs the addresses of both places. Give it one.`,
  'no-places': (word) => `The ${word} hold no places with web addresses, so nothing was matched.`,
  unreadable: (word) => `The ${word} could not be read to the end, so nothing was matched`,
  'not-read': (word, m) => `Part of the ${word} could not be read, so the matching is not of the whole of them: ${m}`,
  problems: (word) => `The ${word} have problems of their own, which matching does not list. Check them by themselves to see them.`,
};
const words = (side) => (side === 'subjects' ? 'places to match' : 'places of the other dataset');

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const okPoint = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

/** The great-circle distance between two [lon, lat] points, in kilometres. */
export function distanceKm([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function coordsBox(c, box = [Infinity, Infinity, -Infinity, -Infinity]) {
  if (Array.isArray(c) && typeof c[0] === 'number') {
    if (okPoint(c)) { box[0] = Math.min(box[0], c[0]); box[1] = Math.min(box[1], c[1]); box[2] = Math.max(box[2], c[0]); box[3] = Math.max(box[3], c[1]); }
  } else if (Array.isArray(c)) for (const x of c) coordsBox(x, box);
  return box;
}
const centre = (b) => (b && b.length === 4 && b.every(Number.isFinite) && b[0] <= b[2] && b[1] <= b[3] ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null);
/** A geometry's point (reprPoint, a GeoJSON Point, or a WKT POINT), else null. */
function pointOf(g) {
  if (okPoint(g.reprPoint)) return [g.reprPoint[0], g.reprPoint[1]];
  if (g.geojson?.type === 'Point' && okPoint(g.geojson.coordinates)) return [g.geojson.coordinates[0], g.geojson.coordinates[1]];
  const m = typeof g.wkt === 'string' && /^\s*POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)\s*$/i.exec(g.wkt);
  return m && okPoint([+m[1], +m[2]]) ? [+m[1], +m[2]] : null;
}
/**
 * The points a place's attestations give, in order, as { att (the attestation's @id, or null),
 * point, exact (false for the centre of a bounding box) }. A negated attestation ("not here") gives
 * none, nor one that the record itself withdraws (plato:Retracts, plato:Supersedes): a bad import
 * at 0°, 0° that was retracted is not where the place is. Withdrawals made elsewhere in the dataset
 * are applied by pickPoint().
 */
function attestationPoints(record) {
  const out = [];
  for (const a of currentAttestations(record, null, () => {})) {
    if (!a || typeof a !== 'object' || a.negated) continue;
    const att = typeof a['@id'] === 'string' ? a['@id'] : null;
    for (const g of Array.isArray(a.geometries) ? a.geometries : []) {
      if (!g || typeof g !== 'object') continue;
      const p = pointOf(g);
      if (p) { out.push({ att, point: p, exact: true }); continue; }
      const c = centre(g.bbox) || (g.geojson ? centre(coordsBox(g.geojson.coordinates)) : null);
      if (c) out.push({ att, point: c, exact: false });
    }
  }
  return out;
}
/** The first point of `points` not withdrawn (`withdrawn`: @id -> kind), else the first box centre, else null. */
function pickPoint(points, withdrawn = null) {
  const current = withdrawn && withdrawn.size ? points.filter((p) => !(p.att && withdrawn.has(p.att))) : points;
  return (current.find((p) => p.exact) || current[0])?.point ?? null;
}
/**
 * A place's representative point: the first Point of its current attestations, else the centre of
 * the first bounding box, else null. Negated and withdrawn attestations are passed over; `withdrawn`
 * (@id -> kind, resolveWithdrawn().status) adds what the rest of the dataset withdraws.
 */
export function representativePoint(record, withdrawn = null) {
  return pickPoint(attestationPoints(record), withdrawn);
}

/** What the pipeline writes one dataset's records to: the places, and the identity links it states. */
function reader(side, rep, word, standIns = new Set()) {
  const link = (a, b, negated, att) => { if (typeof a === 'string' && typeof b === 'string' && a !== b) side.links.push({ a, b, negated, att }); };
  const record = (rec) => {
    const iri = rec['@id'];
    if (typeof iri !== 'string' || !iri) { rep.add('error', 'no-address', TEXT['no-address'](words(word)), rec.label ?? undefined); side.unaddressed++; return; }
    const names = [], seen = new Set();
    const add = (n) => { if (typeof n !== 'string' || !n.trim() || seen.has(n)) return; seen.add(n); names.push(n); };
    add(rec.label);
    const types = new Set();
    for (const a of rec.attestations || []) {
      if (!a || typeof a !== 'object') continue;
      if (!a.negated) for (const n of a.names || []) { add(n?.toponym); add(n?.romanized); }
      if (!a.negated) for (const t of a.types || []) if (t && typeof t.label === 'string' && types.size < 5) types.add(t.label);
      for (const r of a.identities || []) link(r?.subject ?? iri, r?.object, !!a.negated, typeof a['@id'] === 'string' ? a['@id'] : null);
    }
    collectWithdrawn(rec.attestations, side.withdrawals);
    for (const r of rec.identityRelations || []) link(r?.subject ?? iri, r?.object, false, null);
    // The point is picked once the whole dataset's withdrawals are known (readSide()).
    const p = { label: typeof rec.label === 'string' ? rec.label : iri, names, point: null, points: attestationPoints(rec) };
    if (Array.isArray(rec.ccodes) && rec.ccodes.length) p.ccodes = rec.ccodes.filter((c) => typeof c === 'string');
    if (types.size) p.types = [...types];
    if (!side.places.has(iri)) side.places.set(iri, p);
    else { const q = side.places.get(iri); for (const n of names) if (!q.names.includes(n)) q.names.push(n); q.points.push(...p.points); }
  };
  return {
    header(head) {
      const g = (head && typeof head.gazetteer === 'object' && head.gazetteer) || {};
      // A title the reader made up for a dataset that gives none (an LPF FeatureCollection with no
      // title is given its file's name) is a stand-in, as the file's name is.
      if (typeof g.title === 'string' && g.title && !standIns.has(g.title)) { side.title = g.title; side.titleFrom = 'gazetteer'; }
      if (typeof g['@id'] === 'string') side.uri = g['@id'];
    },
    event(ev) {
      if (ev.type === 'record' && ev.value) record(ev.value);
      else if (ev.type === 'idr' && ev.value) link(ev.value.subject, ev.value.object, false, null);
    },
    async close() {},
  };
}

/**
 * The titles the engine's readers give a dataset that has none of its own (pipeline.js, and the
 * readers in src/formats/): its file's name, "Place annotations in <file>" for Web Annotations, and
 * the tables' default. Such a title is not the dataset's, and is no better than the file's name.
 */
const TABLES_TITLE = 'Converted from PLATO spreadsheet tables';
function standInTitles(input) {
  const out = new Set([TABLES_TITLE]);
  for (const f of input.files || []) if (f?.name) { out.add(f.name); out.add(`Place annotations in ${f.name}`); }
  return out;
}

async function readSide(input, word, options, env, rep, progress) {
  const side = { title: input.files[0]?.name || 'Untitled dataset', titleFrom: 'file-name', uri: undefined, places: new Map(), links: [], withdrawals: new Map(), unaddressed: 0 };
  const r = await run({ input, action: 'check', options: { base: options.base, sink: reader(side, rep, word, standInTitles(input)) } },
    { ...env, progress: (p) => progress({ ...p, dataset: word, phase: p.phase === 'done' ? 'read' : p.phase }) });
  if (r.incomplete) return { side, failed: r.report.items.find((i) => i.kind === 'unreadable')?.examples[0] };
  let others = 0;
  for (const i of r.report.items) {
    if (i.severity !== 'error') continue;
    if (NOT_READ.has(i.kind)) rep.add('error', 'dataset-not-read', TEXT['not-read'](words(word), i.message), i.examples[0], i.count);
    else others += i.count;
  }
  if (others) rep.add('warning', 'dataset-has-problems', TEXT.problems(words(word)), undefined, others);
  // A link an attestation made that a later one withdrew (retracted, or replaced) no longer holds.
  const withdrawn = resolveWithdrawn(side.withdrawals).status;
  side.links = side.links.filter((l) => !(l.att && withdrawn.has(l.att)));
  // And a point an attestation gave that a later one withdrew is not where the place is.
  for (const p of side.places.values()) { p.point = pickPoint(p.points, withdrawn); delete p.points; }
  side.files = await fileRecords(input.files);
  return { side };
}

const pairKey = (a, b) => (a < b ? a + '\n' + b : b + '\n' + a);
const sideRecord = (s) => ({ title: s.title, titleFrom: s.titleFrom, ...(s.uri ? { uri: s.uri } : {}), files: s.files });

/**
 * Match two datasets. `subjects` and `others` are inputs as detect() describes them; options:
 * threshold (0.85), maxDistanceKm (50), topK (5), base (for spreadsheet tables), name (the stem of
 * the work file's name), othersTitle (the other dataset's title, which the attestations cite, when
 * its file gives none or another is wanted), now (the time to stamp, for tests). Returns { report, outputs, work }, the
 * report in the shape run() gives, with `incomplete` set when a dataset could not be read to the end.
 */
export async function match({ subjects, others, options = {} }, env) {
  const rep = new Report();
  const t0 = Date.now();
  const progress = env.progress || (() => {});
  const params = checkMatchOptions(options);
  if (options.reviewer) checkReviewer(options.reviewer);
  const sides = {};
  for (const [word, input] of [['subjects', subjects], ['others', others]]) {
    const { side, failed } = await readSide(input, word, options, env, rep, progress);
    if (failed !== undefined || !side.files) {
      rep.error('unreadable', TEXT.unreadable(words(word)), failed);
      return { report: rep.toJSON(), outputs: [], work: null, incomplete: true };
    }
    sides[word] = side;
  }
  const S = sides.subjects, O = sides.others;
  // The other dataset is the source each attestation of the review cites, by its title: one given
  // is used; a file's name, when the dataset gives no title, is only a stand-in, and is warned of.
  const given = typeof options.othersTitle === 'string' ? options.othersTitle.trim() : '';
  if (given) { O.title = given; O.titleFrom = 'given'; }
  else if (O.titleFrom === 'file-name') rep.warning('others-title-is-file-name', KRISIS_TEXT.othersTitleIsFileName(O.title));
  for (const [word, side] of [['subjects', S], ['others', O]]) if (!side.places.size) rep.error('no-places', TEXT['no-places'](words(word)));

  // What the datasets already say: pairs linked by an identity relation, and pairs said to differ.
  const linked = new Set(), different = new Set();
  for (const l of [...S.links, ...O.links]) (l.negated ? different : linked).add(pairKey(l.a, l.b));

  // The index: each normalised name of the other places, by its trigrams (blocking.js).
  const otherIris = [...O.places.keys()];
  const index = new NameIndex(otherIris.map((iri) => O.places.get(iri).names), [...S.places.values()].map((p) => p.names));

  const generated_at = options.now || new Date().toISOString();
  const counts = { subjects: S.places.size, others: O.places.size, candidates: 0, suggestedFor: 0, linked: 0, judgedDifferent: 0, tooFar: 0, unaddressed: S.unaddressed + O.unaddressed, comparisons: 0 };
  const places = {}, candidates = [], emitted = new Set(), linkedSeen = new Set(), differentSeen = new Set();
  const source = { title: O.title, ...(O.uri ? { uri: O.uri } : {}) };
  let i = 0, lastBeat = 0;
  for (const [iri, sp] of S.places) {
    i++;
    const now = Date.now();
    if (now - lastBeat > 250) { lastBeat = now; progress({ phase: 'matching', places: i, elapsedMs: now - t0 }); }
    // The best score of each other place against any name of this one, over the pairs blocking allows.
    const best = index.best(sp.names, params.threshold);
    const found = [];
    for (const [pi, score] of best) {
      const oiri = otherIris[pi];
      if (oiri === iri) continue;
      const key = pairKey(iri, oiri);
      // A dataset matched with itself, or two that share places: each pair is suggested once.
      if (emitted.has(key)) continue;
      if (linked.has(key)) { if (!linkedSeen.has(key)) { linkedSeen.add(key); counts.linked++; } continue; }
      if (different.has(key)) { if (!differentSeen.has(key)) { differentSeen.add(key); counts.judgedDifferent++; } continue; }
      const op = O.places.get(oiri);
      let distance_km = null;
      if (sp.point && op.point) {
        const d = distanceKm(sp.point, op.point);
        if (d > params.maxDistanceKm) { counts.tooFar++; continue; }
        distance_km = round(d, 1);
      }
      found.push({ oiri, op, score: round(score, 3), distance_km });
    }
    // When the subject has a point, the places near it come first, and those with no point take only
    // the places left: otherwise namesakes with no point, at 1, crowd out a variant 4 km away. Then by
    // score, then distance.
    const unplaced = (f) => (sp.point && f.distance_km === null ? 1 : 0);
    found.sort((a, b) => unplaced(a) - unplaced(b) || b.score - a.score || (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity) || (a.oiri < b.oiri ? -1 : 1));
    const kept = found.slice(0, params.topK);
    if (!kept.length) continue;
    places[iri] = sp;
    counts.suggestedFor++;
    for (const f of kept) {
      emitted.add(pairKey(iri, f.oiri));
      candidates.push({
        id: `c${candidates.length + 1}`, candidate_source: iri, candidate_candidate: f.oiri,
        similarity_score: f.score, distance_km: f.distance_km, candidate_status: 'suggested',
        other: { label: f.op.label, names: f.op.names, point: f.op.point, source, ...(f.op.ccodes ? { ccodes: f.op.ccodes } : {}), ...(f.op.types ? { types: f.op.types } : {}) },
        decision: null,
      });
    }
  }
  counts.candidates = candidates.length;
  counts.comparisons = index.comparisons;
  rep.counts = counts;

  const work = {
    krisis: WORK_VERSION, generated_at, algorithm_version: ALGORITHM,
    match_parameters: { ...params, ...(options.base ? { base: options.base } : {}), blocking: { ...BLOCKING, rule: BLOCKING_RULE }, scoring: SCORING },
    subjects: sideRecord(S), others: sideRecord(O),
    places, candidates, reviewer: options.reviewer || null, cursor: 0,
  };
  const outputs = [];
  const stem = (options.name || subjects.files[0].name).replace(/\.(gz)$/i, '').replace(/\.[^.]+$/, '');
  const o = await env.output(stem + '.krisis.json');
  o.write(serialiseWork(work));
  outputs.push(await o.close());
  progress({ phase: 'done', places: i, elapsedMs: Date.now() - t0 });
  return { report: rep.toJSON(), outputs, work };
}
