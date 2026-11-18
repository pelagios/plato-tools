// The locations of the places a review matched, taken together, in one go (the workflow's step after the
// one that records the decisions). Accepting a match records only that the place IS the record; where the
// record is, is copied here, as one geometry attestation for each place, citing the gazetteer with the record
// as the locator, as an adoption in Chora does (adopt.js), and carrying the UPSTREAM source's licence.
//
// What it takes, and why:
//   the dataset   as the decisions were recorded in it: which places have a location already, and which
//                 matches it records as a review's (an identity WITH a contributor: a match a table gave in a
//                 column of its own has none, and is not this review's to locate by);
//   the review    its work file: the accepted matches, each candidate's point as the gazetteer answered it
//                 (candidate.other.point, kept from the lookup: NO request is made here), and the lookup's
//                 `attribution`, the only place the sources' licences are kept (work.js, lookups[].attribution).
//                 Without the review every licence would read as not stated.
//
// What it never does:
//   - change how a place and a record are matched: only a geometry attestation is written, never an identity
//     (an adoption in Chora adds an exactMatch where the link is not exact, adopt.js: a close match stays close here);
//   - copy from a source that says it may not be passed on (`redistributable === false`);
//   - copy from a source whose licence is not stated, unless the person says so for this batch
//     (`allowUnknown`), which is then written into the note of each such location, with their name;
//   - choose among several possible locations: a place matched to several records that each have one, or a
//     record with several geometries and no single point among them, is left for the person, and counted;
//   - add to a place that has a location already.
// Every matched place is in exactly one count (counts.matched is their sum).
//
// plan() is pure. locate() reads the dataset, plans, and (unless `planOnly`) writes the dataset with the
// locations added, through Chora's save (save.js): nothing else in it changes, shown by the version check.
import { Report } from '../report.js';
import { DataError } from '../input.js';
import { run, stoppable } from '../pipeline.js';
import { readWork, checkReviewer, DATE_TIME } from '../krisis/work.js';
import { isWhg } from '../gazetteer/index.js';
import { normaliseWhgIri } from '../gazetteer/whg.js';
import { candidateStatus, featureGeometries, geometryFrom, spdxUri, whgSource, whgLicenceOf, recordWordsOf, AdoptError, CITES_AS_EVIDENCE } from './adopt.js';
import { newGeometryAttestation, DrawError } from './draw.js';
import { save, savedName } from './save.js';
import { keyer } from './store.js';
import { locateGeometryNote, locateWords, LOCATE_TEXT, choraSavedFormat } from '../words.js';

/** The word in the name of the dataset written: <stem>.located.json. */
export const LOCATED_WORD = 'located';
/** The counts of a plan, in the order they are said. */
export const COUNTS = ['use', 'located', 'noLocation', 'unknownLicence', 'notRedistributable', 'leftForYou', 'notRecorded'];
const COUNT_OF = { use: 'use', located: 'located', 'no-location': 'noLocation', 'unknown-licence': 'unknownLicence', 'not-redistributable': 'notRedistributable',
  'several-matches': 'leftForYou', 'several-locations': 'leftForYou', 'bad-location': 'leftForYou', related: 'leftForYou', 'no-record': 'leftForYou',
  'not-recorded': 'notRecorded', 'not-in-dataset': 'notRecorded' };

const same = (iri) => normaliseWhgIri(iri) || iri;
const isPoint = (p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * The matches a review accepted from the gazetteer, by place: Map(place address -> [candidate]). Only a
 * decision of the review's ("Same place": decision.kind 'match') on a candidate a lookup of the World
 * Historical Gazetteer found, for a place (not a region) the reviewer did not leave out.
 */
export function acceptedMatches(work) {
  const out = new Map();
  for (const c of work.candidates || []) {
    if (c.decision?.kind !== 'match' || !Object.hasOwn(work.places, c.candidate_source)) continue;
    if (work.places[c.candidate_source].rowState === 'exclude') continue;
    if (c.lookup === undefined || c.lookup === null || !isWhg(c.gazetteer?.service)) continue;
    (out.get(c.candidate_source) || out.set(c.candidate_source, []).get(c.candidate_source)).push(c);
  }
  return out;
}

/**
 * What one accepted match offers: { candidate, record, st (adopt.js candidateStatus), attribution, answered,
 * kind, geometry? }. `kind` is 'ok', or why it cannot be used as it is: 'related', 'no-record',
 * 'not-redistributable' (said before its location is looked at), 'no-location', 'several-locations',
 * 'bad-location', 'unknown-licence'. `features` may give the record itself (an LPF Feature, by the record's id
 * or address), read by the caller; without it the location is the point the gazetteer answered with.
 */
function assess(work, c, features) {
  const lookup = (work.lookups || []).find((l) => l.id === c.lookup) || null;
  const attribution = lookup?.attribution ?? null;
  const candidate = { id: c.gazetteer?.id, iri: c.candidate_candidate, namespace: c.gazetteer?.namespace ?? undefined, name: c.other?.label ?? null, coords: c.other?.point ?? null };
  const st = candidateStatus(candidate, { attribution });
  const a = { candidate, record: st.record, st, attribution, identityType: c.decision.identityType, answered: lookup?.finished_at || lookup?.started_at || c.generated_at || null, from: c.id };
  if (c.decision.identityType === 'related') return { ...a, kind: 'related' };
  if (!st.record) return { ...a, kind: 'no-record' };
  if (!st.mayCopy) return { ...a, kind: 'not-redistributable' };
  const feature = features?.[candidate.id] ?? features?.[st.record] ?? null;
  let geometry = null;
  try {
    if (feature) {
      const offered = featureGeometries(feature);
      if (!offered.length) return { ...a, kind: 'no-location' };
      // One geometry is the record's location. Of several, the one point among them stands for the place;
      // none, or more than one, and nothing here chooses.
      const points = offered.filter((o) => o.geojson?.type === 'Point');
      const o = offered.length === 1 ? offered[0] : points.length === 1 ? points[0] : null;
      if (!o) return { ...a, kind: 'several-locations' };
      if (o.refused) return { ...a, kind: 'bad-location', reason: o.refused.reason };
      geometry = { ...geometryFrom(o.geojson, o.when), role: o.role, fromRecord: true };
    } else {
      if (!isPoint(candidate.coords)) return { ...a, kind: 'no-location' };
      geometry = { ...geometryFrom({ type: 'Point', coordinates: candidate.coords }), role: 'RepresentativePoint', fromRecord: false };
    }
  } catch (e) {
    if (!(e instanceof DrawError) && !(e instanceof AdoptError)) throw e;
    return { ...a, kind: 'bad-location', reason: e.message };
  }
  if (!st.licence || !st.licence.spdx) return { ...a, kind: 'unknown-licence', geometry };
  return { ...a, kind: 'ok', geometry };
}

/** One place's part of a plan, from what its accepted matches offer. */
function decide(fact, offers, allowUnknown) {
  if (!fact) return { status: 'not-in-dataset' };
  if (fact.located) return { status: 'located' };
  // Only a match this dataset records as a review's: an identity with a contributor (a table's own has none).
  const recorded = offers.filter((o) => o.record && fact.reviewed.has(same(o.record)));
  if (!recorded.length) return { status: 'not-recorded' };
  const pick = (list, unknown) => (list.length === 1 ? { status: 'use', offer: list[0], unknown } : { status: 'several-matches' });
  const ok = recorded.filter((o) => o.kind === 'ok');
  if (ok.length) return pick(ok, false);
  // A source with a licence is used first; one without, only when there is no other, and only if allowed.
  const unknown = recorded.filter((o) => o.kind === 'unknown-licence');
  if (unknown.length) return allowUnknown ? pick(unknown, true) : { status: 'unknown-licence' };
  for (const k of ['several-locations', 'bad-location', 'not-redistributable', 'no-location', 'related', 'no-record']) {
    const o = recorded.find((x) => x.kind === k);
    if (o) return { status: k, ...(o.reason ? { reason: o.reason } : {}) };
  }
  return { status: 'no-location' };
}

/**
 * What taking the matched places' locations would do, before anything is done.
 *   work    a review's work file, as readWork() gives it
 *   facts   Map(place address -> { located, reviewed: Set(record addresses) }) of the dataset (placeFacts)
 *   allowUnknown   use a source whose licence is not stated (the person's choice, for this batch)
 *   features       optionally, records read by the caller, by id or address (LPF Features)
 * Returns { counts: { matched, use, located, noLocation, unknownLicence, notRedistributable, leftForYou,
 * notRecorded }, places: [{ id, label, status, count, record?, reason?, unknown?, offer? }] } in the review's order.
 */
export function plan({ work, facts, allowUnknown = false, features = null }) {
  const counts = Object.fromEntries(['matched', ...COUNTS].map((k) => [k, 0]));
  const places = [];
  for (const [id, cands] of acceptedMatches(work)) {
    const offers = cands.map((c) => assess(work, c, features));
    const d = decide(facts.get(id) || null, offers, allowUnknown);
    const count = COUNT_OF[d.status];
    counts.matched++; counts[count]++;
    places.push({ id, label: work.places[id].label, count, ...d, ...(d.offer ? { record: d.offer.record } : {}) });
  }
  return { counts, places };
}

/** The same plan without what only the engine uses (each place's offer), for a page to show. */
const shown = (p) => ({ counts: p.counts, places: p.places.map(({ offer, ...x }) => x) });

/**
 * The geometry attestations of a plan's places to use: [{ placeId, attestation }], each citing the gazetteer
 * with the record as the locator and the upstream source's licence, as an adoption does. No identity is made.
 * `contributor` is who took them ({ name, orcid? }); `created` when (an ISO date-time); `batch` names the one go.
 */
export function locationAttestations(p, { contributor, created, batch }) {
  const out = [];
  for (const place of p.places) {
    if (place.status !== 'use') continue;
    const o = place.offer, licenceUri = spdxUri(o.st.licence), source = whgSource();
    const attestation = newGeometryAttestation({
      geojson: o.geometry.geojson, role: o.geometry.role, contributor, created,
      citation: { source: licenceUri ? { ...source, licence: licenceUri } : { ...source }, locator: o.record, citationFunction: CITES_AS_EVIDENCE },
      notes: locateGeometryNote({ ...recordWordsOf(o.candidate, null, o.st, o.attribution), licence: o.st.licence?.spdx ?? null, whgLicence: whgLicenceOf(o.attribution),
        answered: o.answered ?? created, fromRecord: o.geometry.fromRecord, identityType: o.identityType, batch, unknownBy: place.unknown ? contributor.name.trim() : null }),
    });
    if (o.geometry.timespans?.length) attestation.timespans = o.geometry.timespans;
    out.push({ placeId: place.id, attestation });
  }
  return out;
}

/**
 * What a dataset says of the places asked about (`ids`, a Set), read once: Map(address -> { located,
 * reviewed }). `located`: an attestation not negated gives a geometry. `reviewed`: the records an identity
 * attestation not negated, with a contributor, says the place is (a review's; a table's own matches have none).
 * Returns { facts, report, incomplete }.
 */
export async function placeFacts(subjects, ids, env, { signal } = {}) {
  const facts = new Map(), keyOf = keyer();
  const sink = { header() {}, event(ev) {
    if (ev.type !== 'record') return;
    const k = keyOf(ev.value);
    if (k === null || !ids.has(k) || facts.has(k)) return;   // a place given twice: the first, as Chora shows it
    const f = { located: false, reviewed: new Set() };
    for (const a of Array.isArray(ev.value.attestations) ? ev.value.attestations : []) {
      if (!a || typeof a !== 'object' || a.negated) continue;
      if (Array.isArray(a.geometries) && a.geometries.length) f.located = true;
      if (a.contributor && Array.isArray(a.identities)) for (const i of a.identities) if (typeof i?.object === 'string') f.reviewed.add(same(i.object));
    }
    facts.set(k, f);
  }, async close() {} };
  const r = await run({ input: subjects, action: 'check', options: { sink, signal } }, { ...env, progress: () => {} });
  return { facts, report: r.report, incomplete: !!r.incomplete };
}

/**
 * Take the matched places' locations into the dataset. `subjects` is the dataset the decisions were recorded
 * in (as detect() describes it), `work` the review's work file (an object or its text). options:
 *   planOnly      say what would be done (the counts), and write nothing;
 *   allowUnknown  use sources whose licence is not stated too: the person's choice for this batch, written
 *                 into the note of each such location with their name;
 *   contributor   who takes them ({ name, orcid? }; else the review's reviewer): each location records it;
 *   created       when (an ISO date-time; now by default); batch: the name of this go (by default, `created`);
 *   features      records read by the caller, by id or address (none is fetched here);
 *   reopen, discard   as save() takes them: the file written, read back for the version check, and removed if refused.
 * Returns { report, outputs, plan: { counts, places }, withUnknown: counts with such sources used, batch?, incomplete? }.
 * `outputs` is empty when nothing was written (planOnly, or no location to use: the dataset is as it was).
 */
export async function locate({ subjects, work, options = {} }, env) {
  return stoppable(options.signal, env, (e) => locating({ subjects, work, options }, e));
}
async function locating({ subjects, work, options }, env) {
  const rep = new Report();
  const fail = (more = {}) => ({ report: rep.toJSON(), outputs: [], plan: null, withUnknown: null, incomplete: true, ...more });
  let w;
  try { w = typeof work === 'string' ? readWork(work) : readWork(JSON.parse(JSON.stringify(work))); }
  catch (e) { if (!(e instanceof DataError)) throw e; rep.error('locate-work-unreadable', LOCATE_TEXT['work-unreadable'], e.message); return fail(); }
  const ids = new Set(acceptedMatches(w).keys());
  const read = await placeFacts(subjects, ids, env, { signal: options.signal });
  if (read.incomplete) { rep.error('locate-dataset-not-read', LOCATE_TEXT['dataset-not-read'], read.report.items.find((i) => i.severity === 'error')?.message); return fail(); }
  const allowUnknown = options.allowUnknown === true;
  const p = plan({ work: w, facts: read.facts, allowUnknown, features: options.features || null });
  const withUnknown = allowUnknown ? p.counts : plan({ work: w, facts: read.facts, allowUnknown: true, features: options.features || null }).counts;
  rep.counts = { ...p.counts };
  for (const k of COUNTS.filter((x) => x !== 'use')) {
    for (const x of p.places.filter((y) => y.count === k)) rep.add('warning', `locate-${x.status}`, LOCATE_TEXT[k], `${x.label || x.id}${LOCATE_TEXT.why[x.status] ? `: ${LOCATE_TEXT.why[x.status]}` : ''}${x.reason ? ` (${x.reason})` : ''}`);
  }
  const result = { plan: shown(p), withUnknown, words: locateWords(p.counts) };
  if (options.planOnly) return { report: rep.toJSON(), outputs: [], ...result };
  if (!p.counts.use) { rep.warning('locate-nothing', LOCATE_TEXT.nothing); return { report: rep.toJSON(), outputs: [], ...result }; }

  const contributor = options.contributor || w.reviewer;
  if (!contributor) { rep.error('locate-no-name', LOCATE_TEXT['no-name']); return fail(result); }
  try { checkReviewer(contributor, 'Whoever takes the locations'); } catch (e) { if (!(e instanceof DataError)) throw e; rep.error('locate-bad-name', LOCATE_TEXT['bad-name'], e.message); return fail(result); }
  const created = options.created instanceof Date ? options.created.toISOString() : options.created || new Date().toISOString();
  if (!DATE_TIME.test(created)) throw new Error('locate: created must be an ISO date-time, such as 2026-11-18T12:00:00Z.');
  const batch = options.batch || created;
  const additions = locationAttestations(p, { contributor, created, batch });
  const s = await save(subjects, additions, env, { word: LOCATED_WORD, reopen: options.reopen, discard: options.discard, name: options.name });
  const kept = !s.incomplete && !s.report.errors && s.mneme?.passed === true;
  if (!kept) {
    // Written and refused: never offered, and removed where the host can remove it.
    for (const o of s.outputs || []) { try { await options.discard?.(o); } catch { /* gone already */ } }
    for (const i of (s.report?.items || []).filter((x) => x.severity === 'error')) rep.add('error', i.kind, i.message, i.examples?.[0], i.count);
    if (!s.incomplete && !s.report.errors) rep.error('locate-not-kept', LOCATE_TEXT['not-kept'], (s.mneme?.reasons || []).join('; ') || undefined);
    return fail(result);
  }
  const unknown = p.places.filter((x) => x.status === 'use' && x.unknown).length;
  rep.counts.attestationsAdded = additions.length;
  return { report: rep.toJSON(), outputs: s.outputs, ...result,
    batch: { id: batch, at: created, contributor: { name: contributor.name.trim(), ...(contributor.orcid ? { orcid: contributor.orcid } : {}) }, allowUnknown, used: additions.map((a) => a.placeId), unknown, counts: p.counts } };
}

/** The name locate() writes for a dataset called `name` (the dataset's own format kept: save.js). */
export const locatedName = (input, name) => savedName(name || input.name || input.files[0].name, choraSavedFormat(input).target, LOCATED_WORD);
