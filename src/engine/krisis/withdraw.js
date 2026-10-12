// Krisis: a decision changed after its answer was written withdraws that answer, in the same run.
//
// PLATO's rules, which this follows exactly:
// - plato:Gazetteer (ontology.ttl): once published, "an attestation is never deleted or changed". "A
//   correction is a new attestation with a meta-attestation (plato:Supersedes, plato:Contradicts), and
//   a withdrawal is a meta-attestation of type plato:Retracts. Each carries plato:created." And "every
//   attestation in a published Gazetteer should have a permanent IRI of its own, since a correction or
//   withdrawal must point to its target".
// - plato:Retracts: "The target attestation is withdrawn: it no longer holds ... For a claim its maker
//   takes back". plato:Supersedes: "Replaces the target attestation with newer information." So a
//   supersession is the replacing attestation itself, carrying `meta` (one target: the JSON Schema's
//   `meta` is one object), and a retraction is an attestation of its own that says nothing else, as in
//   PLATO's examples (identity-judgements.ttl, Act 2; place-centric-judgements.json, the bad import).
// - The candidate set specification, 2.3 and 13.5: an answer is never edited, so a changed answer is a
//   new attestation, and the old one "stays live until it is retracted or superseded"; a new "no"
//   beside a live "yes" reads "answered both ways". "Whoever records the change must withdraw the
//   earlier answer in the same act." "The same decision made again writes nothing new. A change from
//   match/distinct to not-this retracts the earlier answer and writes nothing else."
//
// What is an earlier answer of this review: an attestation of the dataset, still current (not
// retracted or superseded anywhere in it), about a place of the review, bundling identity relations
// from that place only, made by the same contributor (Retracts is for "a claim its maker takes back":
// another's answer is never withdrawn here), to at least one of the places the review suggested for
// it. What the review now says of each such place is its decision; a candidate with no decision (never
// made, or taken back) says nothing, and an answer about it alone is kept.
//
// Which withdrawal (the rule, per place):
//   - an answer that says what the review now says (the same places, types, bases, certainties and
//     candidates, yes or no): kept, and the new one not written;
//   - an acceptance replaced by an acceptance (A then B; A then A and B; a basis corrected): the new
//     one supersedes it;
//   - a denial replaced by a denial of the same pair (its basis corrected): the new one supersedes it;
//   - anything else (accepted then rejected, rejected then accepted, either then "not this one"): the
//     earlier answer is retracted, and the new answer, if any, written beside the retraction. An
//     acceptance never supersedes a denial, nor a denial an acceptance: "that was wrong" is not
//     "replaced by this", and PLATO's own worked example of a match found wrong (Act 2) retracts it.
//
// Addresses. A withdrawal points at its target's @id, so every attestation Krisis writes is given one,
// in Agora's form and by Agora's rule (agora/mint.js, mintAddress and the digest of what it says):
// <place>#a-<hash>. Agora's minting keeps any address an attestation has, and would itself have made
// the same, so publishing a review's output with Agora changes none of them. Only a place under the
// dataset's base address is given addresses (the base given for tables, else the dataset's uriSpace,
// else the folder of its own address, as a candidate set's base is found): a place under another's
// address is not ours to mint in, as Agora refuses it too. An earlier answer with no address of its own
// (one written before Krisis gave them) is given its address when it must be withdrawn, in the
// dataset written; the attestations-only output cannot give it one, and refuses.
import { jcs } from '../../formats/json2rdf.js';
import { PLATO } from '../../lib/context.js';
import { sha256 } from '../../lib/sha256.js';
import { digester, mintAddress } from '../agora/mint.js';
import { normaliseBase } from '../agora/address.js';
import { defaultBase } from './candidates.js';
import { KRISIS_WITHDRAW } from '../words.js';

export const RETRACTS = PLATO + 'Retracts', SUPERSEDES = PLATO + 'Supersedes';
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const hasId = (a) => isObject(a) && typeof a['@id'] === 'string' && a['@id'] !== '';
const ORCID = /(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\s*$/;
const orcidOf = (o) => (typeof o === 'string' ? ORCID.exec(o)?.[1] ?? o.trim() : null);

/**
 * Whether a contributor as an attestation gives it (an IRI or { @id?, name?, orcid? }) is `reviewer`
 * ({ name, orcid? }): by ORCID when both give one, else by name.
 */
export function sameContributor(c, reviewer) {
  if (!reviewer) return false;
  if (typeof c === 'string') return !!reviewer.orcid && orcidOf(c) === orcidOf(reviewer.orcid);
  if (!isObject(c)) return false;
  if (c.orcid && reviewer.orcid) return orcidOf(c.orcid) === orcidOf(reviewer.orcid);
  return typeof c.name === 'string' && typeof reviewer.name === 'string' && c.name.trim() === reviewer.name.trim();
}
/** Who made an attestation, as one key (the version check's answered-both-ways): an ORCID, else an address, else a name. */
export function contributorKey(c) {
  if (typeof c === 'string') return c;
  if (!isObject(c)) return '';
  return (c.orcid && orcidOf(c.orcid)) || (typeof c['@id'] === 'string' && c['@id']) || (typeof c.name === 'string' && c.name.trim()) || '';
}

const relationSig = (r) => jcs([r.object ?? null, r.identityType ?? null, r.basis ?? null, r.certainty ?? null, r.promotedFrom ?? null]);
/** What an answer says, as one text: yes or no, and each relation, whatever their order. */
export const answerSig = (a) => jcs([!!a.negated, (a.identities || []).map(relationSig).sort()]);

/** The base address a place must be under to be given attestation addresses here (see above), or null. */
export function baseFor({ base, header, work }) {
  const g = isObject(header?.gazetteer) ? header.gazetteer : {};
  const given = normaliseBase(base) || normaliseBase(g.uriSpace);
  if (given) return given;
  const own = typeof g['@id'] === 'string' ? g['@id'] : work?.subjects?.uri;
  return typeof own === 'string' && /^https?:\/\//.test(own) ? defaultBase(own) : null;
}

/** The digest of what each of `attestations` says, as Agora's minting takes it, about `place`. */
export function digestsOf(context, place, attestations, header = {}) {
  let out = [];
  const s = digester(context, sha256, (rec, digests) => { out = digests; });
  s.header(isObject(header) ? header : {});
  s.event({ type: 'record', value: { '@id': place, attestations } });
  return out;
}

/**
 * A collector for the earlier answers, as a sink for run(): the attestations of the places in
 * `places` (a Set of addresses), and every withdrawal in the dataset, wherever it is, so that what is
 * current can be resolved as the rest of the tools resolve it (formats/shared.js).
 */
export function earlierCollector(places, collectWithdrawn) {
  const atts = new Map(), withdrawals = new Map();
  let header = null;
  const keep = (place, list) => { if (places.has(place)) (atts.get(place) || atts.set(place, []).get(place)).push(...list); };
  return {
    atts, withdrawals, get header() { return header; },
    sink: {
      header(h) { header = h; },
      event(ev) {
        const v = ev.value;
        if (ev.type === 'record' && isObject(v) && Array.isArray(v.attestations)) {
          collectWithdrawn(v.attestations, withdrawals);
          keep(v['@id'], v.attestations.filter(isObject));
        } else if (ev.type === 'attestation' && isObject(v)) {
          collectWithdrawn([v], withdrawals);
          keep(v.about, [v]);
        }
      },
      async close() {},
    },
  };
}

const latest = (dates) => dates.filter(Boolean).sort().at(-1);
const objectsOf = (a) => (a.identities || []).map((r) => r.object);
const sourceSig = (a) => jcs(a.citations?.[0]?.source ?? a.sources?.[0] ?? null);

/**
 * The review's new answers, set against the earlier answers the dataset holds.
 *   work       the work file (its candidates and decisions)
 *   made       [{ subject, attestation }] as attestationsFrom() makes them (left-out places removed)
 *   earlier    Map<place, attestations[]> of the dataset as read (earlierCollector), or null when the
 *              dataset was not read (then nothing is withdrawn, and only the addresses are given)
 *   withdrawn  the whole dataset's resolveWithdrawn().status
 *   reviewer   { name, orcid? }; date: the date given for every attestation, if any
 *   base       the base address (baseFor()); context: the JSON-LD context; header: the dataset's header
 *   canAddress whether an earlier answer without an address may be given one (the dataset output)
 * Returns { write: [{ subject, attestation }], give: Map<place, [{ text, id }]> (earlier answers given
 * an address: the JCS text of the attestation as read, and the address), counts: { unchanged,
 * retracted, superseded, kept, addressed, unaddressed }, problems: [{ severity, kind, example }] }.
 * Pure. Every attestation in `write` has its @id when its place is under the base.
 */
export function reconcile({ work, made, earlier, withdrawn = new Map(), reviewer, date, base, context, header, canAddress = true }) {
  const counts = { unchanged: 0, retracted: 0, superseded: 0, kept: 0, addressed: 0, unaddressed: 0 };
  const problems = [], give = new Map(), retractions = [], dropped = new Set();
  const contributor = { name: reviewer.name.trim(), ...(reviewer.orcid ? { orcid: reviewer.orcid } : {}) };
  // The places whose answers may have changed: those of the review that have a decision, and those of the new answers.
  const places = new Set(made.map((m) => m.subject));
  for (const c of work.candidates) if (c.decision && Object.hasOwn(work.places, c.candidate_source)) places.add(c.candidate_source);
  const targets = new Map();   // an earlier answer to withdraw -> its place, for its address
  for (const P of earlier ? places : []) {
    const cands = new Map(work.candidates.filter((c) => c.candidate_source === P).map((c) => [c.candidate_candidate, c]));
    const live = (earlier.get(P) || []).filter((a) => Array.isArray(a.identities) && a.identities.length
      && !(hasId(a) && withdrawn.has(a['@id'])) && sameContributor(a.contributor, reviewer)
      && a.identities.every((r) => isObject(r) && (r.subject ?? P) === P) && a.identities.some((r) => cands.has(r.object)));
    const here = made.filter((m) => m.subject === P);
    // What the review now says of each place: the relation it writes, yes or no; none for "not this one".
    const now = new Map();
    for (const m of here) for (const r of m.attestation.identities) now.set(r.object, { negated: !!m.attestation.negated, sig: relationSig(r) });
    // 1. Said already, the same: kept, and not written again.
    const used = new Set();
    for (const m of here) {
      const e = live.find((x) => !used.has(x) && answerSig(x) === answerSig(m.attestation));
      if (e) { used.add(e); dropped.add(m); counts.unchanged++; }
    }
    const fresh = here.filter((m) => !dropped.has(m));
    const accepting = fresh.filter((m) => !m.attestation.negated), denying = fresh.filter((m) => m.attestation.negated);
    // 2. Which of the rest the review now contradicts, or replaces.
    const affected = [];
    for (const e of live.filter((x) => !used.has(x))) {
      const changed = e.identities.some((r) => {
        if (!cands.get(r.object)?.decision) return false;
        const n = now.get(r.object);
        return !n || n.negated !== !!e.negated || n.sig !== relationSig(r) || (!e.negated && accepting.some((m) => objectsOf(m.attestation).includes(r.object)));
      });
      if (!changed) { counts.kept++; continue; }
      const others = e.identities.filter((r) => !cands.has(r.object)).map((r) => r.object);
      if (others.length) { problems.push({ severity: 'error', kind: 'answer-bundles-others', example: `${e['@id'] || P}: ${others.join(', ')}` }); continue; }
      const undecided = e.identities.filter((r) => !cands.get(r.object)?.decision).map((r) => r.object);
      if (undecided.length) problems.push({ severity: 'warning', kind: 'withdrawn-with-undecided', example: `${P}: ${undecided.join(', ')}` });
      if (!hasId(e) && !(canAddress && base && P.startsWith(base))) { problems.push({ severity: 'error', kind: canAddress ? 'answer-unaddressable' : 'answer-unaddressed', example: P }); continue; }
      affected.push(e);
    }
    // 3. Each affected answer superseded by a new one of the same kind (one target each), else retracted.
    const taken = new Set();
    for (const e of affected) {
      targets.set(e, P);
      const n = e.negated
        ? denying.find((m) => !taken.has(m) && objectsOf(m.attestation)[0] === objectsOf(e)[0])
        : (accepting.find((m) => !taken.has(m) && sourceSig(m.attestation) === sourceSig(e)) || accepting.find((m) => !taken.has(m)));
      const when = date || latest(e.identities.map((r) => cands.get(r.object)?.decision?.decided_at));
      if (n) { taken.add(n); n.supersedes = e; counts.superseded++; continue; }
      retractions.push({ subject: P, target: e, attestation: { contributor, created: when,
        ...(Array.isArray(e.citations) ? { citations: e.citations } : Array.isArray(e.sources) ? { sources: e.sources } : {}),
        notes: KRISIS_WITHDRAW.retractNote } });
      counts.retracted++;
    }
  }
  const write = made.filter((m) => !dropped.has(m));

  // Addresses: the earlier answers withdrawn first (what withdraws them names them), then what is written.
  const perPlace = new Map();
  const placeOf = (P) => {
    if (perPlace.has(P)) return perPlace.get(P);
    const atts = earlier?.get(P) || [];
    const digests = digestsOf(context, P, atts, header);
    const st = { atts, digests: digests.filter(Boolean), byAtt: new Map(atts.map((a, i) => [a, digests[i]])), ids: new Set(atts.filter(hasId).map((a) => a['@id'])) };
    perPlace.set(P, st);
    return st;
  };
  const mint = (P, att) => {
    const st = placeOf(P);
    const d = st.byAtt.get(att) ?? digestsOf(context, P, [att], header)[0];
    if (!d) return null;
    if (!st.digests.includes(d)) st.digests.push(d);
    const { id } = mintAddress(P, d, st.digests, (x) => st.ids.has(x));
    st.ids.add(id);
    return id;
  };
  const idOf = new Map();
  for (const [e, P] of targets) {
    if (hasId(e)) { idOf.set(e, e['@id']); continue; }
    const id = mint(P, e);
    idOf.set(e, id);
    (give.get(P) || give.set(P, []).get(P)).push({ text: jcs(e), id });
    counts.addressed++;
  }
  const out = [];
  for (const m of write) {
    const { supersedes, ...item } = m;
    const attestation = supersedes ? { ...m.attestation, meta: { targetAttestation: idOf.get(supersedes), metaType: SUPERSEDES } } : m.attestation;
    out.push({ ...item, attestation });
  }
  for (const r of retractions) out.push({ subject: r.subject, attestation: { meta: { targetAttestation: idOf.get(r.target), metaType: RETRACTS }, ...r.attestation } });
  // Every attestation written is given its address, under the base only.
  for (const m of out) {
    if (!(base && m.subject.startsWith(base))) { counts.unaddressed++; continue; }
    const id = mint(m.subject, m.attestation);
    if (id) m.attestation = { '@id': id, ...m.attestation };
  }
  return { write: out, give, counts, problems };
}
