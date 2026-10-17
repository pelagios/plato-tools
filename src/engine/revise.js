// Mneme, revising: a new version of a published dataset, edited freely since its release (names
// corrected, attestations deleted, places added or dropped), made into one that keeps PLATO's rule
// that a published attestation is never deleted or changed (plato:Gazetteer; the version check in
// compare.js finds what breaks it). The version check says, in words, what to withdraw instead;
// this writes those withdrawals (plan #34, item 10; Issue #23; Stephen's decisions of 17 October 2026):
//
//   - an attestation the new version deleted is put back, and retracted: an attestation of its own
//     with meta plato:Retracts, made by the reviewer, as Krisis writes one (krisis/withdraw.js; D6);
//   - one it changed is put back as it was, and the new form written beside it with meta
//     plato:Supersedes pointing at it (D1);
//   - a place dropped whole comes back with every attestation retracted, a tombstone (D3), so that
//     its address keeps resolving;
//   - an address lost (the same attestation without it, or under another) is given back; one the
//     tables never had is inherited by what the attestation says, as minting inherits it (rule 2 of
//     agora/mint.js), twins in file order;
//   - an attestation added gets an address of its own, and a `created` if it has none;
//   - the header is made a release's: status published, and, with a release name, @id, version,
//     previousVersion and isVersionOf (D5), said in the report.
//
// Where the new version has no addresses at all (the spreadsheet tables, minted afresh for every
// release), a deleted attestation is paired with an added one of the same kind (the same facets,
// citing the same source) only when the pairing is sure: exactly one of each in the place (D2);
// then the added one supersedes the deleted one. Otherwise nothing is guessed: retract, and add.
//
// Supersedes needs care (resolveWithdrawn in formats/shared.js, PLATO 5e7901c): a withdrawal takes
// effect only while the withdrawing attestation itself holds. A superseded by B, then B superseded
// by C in the next release, leaves A current again. So when the attestation being withdrawn is
// itself a superseder, its target is retracted too, down the chain (chain-closed, each named),
// and the output is read back for revivals before it is handed on. A retraction that the new
// version deleted or changed is put back and left holding: a withdrawal is never undone by
// deleting it (PLATO's way is to retract the retraction).
//
// A facet with an address of its own (a shared name, a dated location) that the new version changed
// or no longer describes is refused in words (D4, version 1): the attestation that points to it was
// not changed, but what it says was. Identity relations outside attestations and the descriptions
// of places and sources may be corrected, and are left as the new version has them.
//
// What is written is checked before it is handed on, as Krisis's finishing checks its output
// (checkAppendOnly): read back for its withdrawals (nothing the previous release withdrew current
// again; every withdrawal planned in it), then by the version check itself (nothing of the previous
// release missing or changed; its counts of what is retracted, replaced and added the revision's
// own). A failure there is a fault in the tools, and nothing is written.
//
// At any size: the previous release goes into a working database (each record, to put it back; each
// attestation's address and the digest of what it says); the new version is read once by the
// pipeline, place by place, and written as place-centric PLATO JSON by its own writer, held as Blob
// parts until the checks have read it back, as Krisis holds its output.
import { run, halt, Aborted, stoppable } from './pipeline.js';
import { compare } from './compare.js';
import { Report } from './report.js';
import { detect, DataError } from './input.js';
import { jcs } from '../formats/json2rdf.js';
import { PLATO } from '../lib/context.js';
import { sha256 } from '../lib/sha256.js';
import { collectWithdrawn, resolveWithdrawn, list } from '../formats/shared.js';
import { digester, mintAddress, TEXT as MINT_TEXT } from './agora/mint.js';
import { normaliseBase } from './agora/address.js';
import { baseFor, RETRACTS, digestsOf } from './krisis/withdraw.js';
import { checkReviewer, NOT_READ_KINDS } from './krisis/work.js';
import { fileSha256 } from './krisis/digest.js';
import { formatName } from './words.js';

export const SUPERSEDES = PLATO + 'Supersedes';
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const hasId = (a) => isObject(a) && typeof a['@id'] === 'string' && a['@id'] !== '';
const n = (x) => (x || 0).toLocaleString('en-GB');
const plural = (k, one, many = one + 's') => `${n(k)} ${k === 1 ? one : many}`;
// A meta type, written in full or with the context's plato: prefix.
const metaType = (m) => (isObject(m) && typeof m.metaType === 'string' ? (m.metaType.startsWith('plato:') ? PLATO + m.metaType.slice(6) : m.metaType) : null);
/** The withdrawal an attestation's meta makes, if any: { kind: 'retracted' | 'superseded', target }. */
export function withdrawalOf(a) {
  for (const m of [].concat(a?.meta || [])) {
    const t = metaType(m);
    if ((t === RETRACTS || t === SUPERSEDES) && typeof m.targetAttestation === 'string') return { kind: t === RETRACTS ? 'retracted' : 'superseded', target: m.targetAttestation };
  }
  return null;
}

export const TEXT = {
  'no-reviewer': 'The revision does not say who makes it: give the maintainer\'s name (the reviewer\'s, under Krisis\'s review), which each retraction records as its contributor: a Gazetteer retracts the attestations it made, and a maintainer signs for it. Nothing was written.',
  'bad-reviewer': 'The reviewer cannot be recorded as PLATO records a contributor, so nothing was written',
  'previous-not-read': 'The previous release could not be read to the end, so nothing was written.',
  'previous-unaddressed': 'Attestations of the previous release have no web address of their own (@id), so nothing can retract or replace them. Give the copy with addresses that the site was made from (<name>-with-ids.jsonl, which minting wrote), not the working copy before minting. Nothing was written.',
  'previous-has-problems': 'The previous release has problems of its own, which revising does not list. Check it by itself to see them.',
  'previous-no-places': 'The previous release holds no attestations, so there is nothing for the new version to have kept, and nothing to revise against. Nothing was written.',
  'earlier-not-published': 'The previous release does not say that it is published (status), so the append-only rule does not bind it yet; the new version is revised against it all the same.',
  'later-not-published': 'The new version does not say that it is published (status): published is published, so the revised dataset says it is.',
  'same-release': 'The release name given is the previous release\'s version: a changed dataset needs a new one, or a citation of the version no longer says which state was meant. Nothing was written.',
  'same-release-header': 'The new version\'s header still names the previous release (its @id or its version), and no release name was given to replace it: a changed dataset needs a new one, or a citation of the version no longer says which state was meant. Give the release a name (Release name under Options; --release). Nothing was written.',
  'base-differs': 'The two versions put their places under different base addresses, so every place of the previous release would read as dropped and every place of the new version as new: nothing was written. Give the base address the previous release used (its uriSpace), or give the new version its places under it. The example names the two.',
  'no-base': 'The new version does not say under what address its places are published (uriSpace), and no base address was given, so no address can be made for what is written: give the base address. Nothing was written.',
  'dataset-not-read': 'The new version could not be read to the end, so nothing was written',
  'dataset-has-problems': 'The new version has problems of its own, which revising does not list or change. The revised dataset was still written; check it by itself to see them.',
  'dataset-now-plato-json': (format) => `The new version is ${format}; the revised dataset is a PLATO JSON document (place-centric), whatever format it came in. What PLATO JSON has no place for is listed below, if anything.`,
  'address-moved': 'An attestation of the new version has the address (@id) that the previous release gave an attestation of another place. An address is never moved: give it back to that place, or take it off this attestation. Nothing was written; the example names the address.',
  'address-twice': 'The new version uses one address (@id) for two attestations. The one that says what the previous release said under it keeps it, and the other is written as replacing it (plato:Supersedes); where neither says the same, the first replaces it and the second is added under an address of its own.',
  'cannot-withdraw-outside-base': 'An attestation the new version deleted is about a place whose address is not under the base address, so no address can be made for its retraction, and it was not written. Give the place an address under the base, or put the attestation back. Nothing was written; the example names the place.',
  'cannot-close-chain': 'An attestation withdrawn here had itself replaced one of another place, which the revision had already written, so the earlier one could not be retracted with it and would become current again. This is a limit of the tools: put the attestation back as it was, and withdraw it by hand under the other place. Nothing was written.',
  'facet-changed': 'A name, location, date, type, property or citation that attestations of the previous release point to by its web address says something different in the new version, or is no longer described. Those attestations were not changed, but what they say was, and this revision does not repair that: put it back as it was, and record the correction as a new one (a name, a date, a location) under a new address, in a new attestation that replaces the old one (plato:Supersedes). Nothing was written; the example names it.',
  superseded: 'An attestation of the previous release says something different in the new version: it is put back as it was, and the new form is written beside it, replacing it (plato:Supersedes). The example names the attestation replaced.',
  retracted: 'An attestation of the previous release is not in the new version: it is put back as it was, and withdrawn by a new attestation that retracts it (plato:Retracts), signed by the maintainer for the Gazetteer. The example names it.',
  paired: 'An attestation of the previous release is not in the new version, and one of the same kind, citing the same source, was added to the same place in its stead, with nothing else of that kind deleted or added there: the deleted one is put back, and the added one replaces it (plato:Supersedes). The example names the one replaced, and its place.',
  tombstone: 'A place of the previous release is not in the new version: it is put back as it was, with every current attestation retracted (plato:Retracts), so that its address keeps resolving. The example names the place.',
  'chain-closed': 'An attestation withdrawn here had itself replaced an earlier one (plato:Supersedes). A replacement takes effect only while it holds, so the earlier one would have become current again: it is retracted too. The example names it.',
  'withdrawal-kept': 'A retraction of the previous release (plato:Retracts) is not in the new version as it was. A withdrawal is never undone by deleting or changing it: it is put back as it was, and still holds (a changed form is added beside it). To restore what it withdrew, retract the retraction itself with a new attestation (restored, below). The example names it.',
  restored: 'An attestation the previous release had withdrawn is current again: the new version retracts the retraction (PLATO\'s way to restore), and that stands. The example names the attestation restored.',
  'not-all-addressed': 'An attestation of the dataset written has no web address of its own (@id), where a release carries one on every attestation, which is a fault in the tools (please report it); nothing was written. The example names its place.',
  'readdressed-restored': 'An attestation of the previous release is in the new version saying the same, but without its web address, or under another: its address is given back. The example names it.',
  inherited: 'Attestations of the new version without an address were given the address the previous release gave an attestation of the same place saying exactly the same, as minting inherits them. One the previous release had withdrawn is not inherited: a row deleted in one release and put back in the next is a new attestation, under an address of its own.',
  'created-stamped': 'An attestation added in the new version, or written as the new form of a changed one, did not say when it was made (created): it is dated with this revision, so that the state of the dataset at an earlier moment can be worked out. The example names its place.',
  'already-withdrawn': 'An attestation of the previous release that the release had already withdrawn is not in the new version: it is put back as it was, and nothing more, since it is withdrawn already.',
  'withdrawn-by-you': 'An attestation of the previous release is not in the new version, which withdraws it by hand (an attestation with plato:Retracts or plato:Supersedes pointing at it): it is put back as it was, and your withdrawal stands.',
  'attestations-unaddressed': 'Attestations added in the new version are about a place whose address is not under the base address, so they could not be given addresses of their own (as minting would give them none), and a release carries an address on every attestation. Give the place an address under the base, or give the base its places are under. Nothing was written; the example names the place.',
  'release-written': 'The header names the release: its address (@id, <base>release/<name>), its version (the release name), the previous version (the previous release\'s address) and the dataset it is a version of (isVersionOf, the base). Put them in the dataset too.',
  'nothing-revised': 'The new version says exactly what the previous release says: nothing was withdrawn, replaced or added. The revised dataset is written all the same, with its header made a release\'s.',
  'not-append-only': 'The version check found that the revised dataset does not keep all of the previous release, which is a fault in the tools (please report it); nothing was written.',
  'not-checked': 'The revised dataset could not be checked with the version check, so nothing was written',
  'not-all-withdrawn': (want, got) => `The revision withdraws ${want}, but the dataset written is found to withdraw ${got}, which is a fault in the tools (please report it); nothing was written.`,
  'not-all-added': (want, got) => `The revision adds ${plural(want, 'attestation')}, but the dataset written is found to add ${plural(got, 'attestation')}, which is a fault in the tools (please report it); nothing was written.`,
  revived: 'An attestation the previous release had withdrawn is current again in the dataset written, which is a fault in the tools (please report it); nothing was written. The example names it.',
  'not-valid': 'An attestation made by the revision does not match the PLATO JSON Schema, which is a fault in the tools; please report it',
};
const NOTE = {
  retracted: 'Withdrawn in a new release by the Gazetteer, the maintainer signing: the attestation was deleted from the working copy (PLATO tools, Mneme).',
  tombstone: 'Withdrawn in a new release by the Gazetteer, the maintainer signing: the place was dropped from the working copy (PLATO tools, Mneme).',
  chain: 'Retracted with the attestation that replaced it, so that it does not become current again now that the replacement no longer holds (PLATO tools, Mneme).',
};
// What the version check reports that a dataset revised here cannot have: the revision put everything
// back. A facet changed is the one limit, refused in words (D4).
const CHANGED = new Set(['attestation-removed', 'attestation-changed', 'attestation-gone', 'attestation-readdressed']);
const FACET = new Set(['facet-changed', 'facet-removed']);
// Said already, in this revision's own words.
const SAID = new Set(['earlier-not-published', 'later-not-published', 'version-has-problems', 'nothing-to-compare', 'previous-version-differs']);
const NOT_READ = new Set(['unreadable', ...NOT_READ_KINDS]);
// The facets an attestation may bundle: what tells one kind of attestation from another (D2).
const FACETS = ['names', 'geometries', 'timespans', 'types', 'properties', 'relations', 'identities'];

/**
 * The base address a version's places are under: the one given, else the header's uriSpace, else what it says it is
 * a version of (isVersionOf: a release's own address is <base>release/<name>, whose folder is not the base, as DEEP's
 * is), else the folder of its address (krisis/withdraw.js baseFor). Null when none can be told.
 */
export function baseOf(header, given) {
  const g = isObject(header?.gazetteer) ? header.gazetteer : {};
  return normaliseBase(given) || normaliseBase(g.uriSpace) || normaliseBase(g.isVersionOf) || baseFor({ header });
}
/** The name of the output: the new version's own name without its extension, then -revised.json. */
export const outputName = (name) => String(name || 'dataset').replace(/\.gz$/i, '').replace(/\.[^./]+$/, '') + '-revised.json';

/**
 * Revise the new version of a published dataset (`later`, an input as detect() describes it) against
 * its previous release (`earlier`, the copy with addresses that the site was made from), so that
 * nothing published is deleted or changed: see the top of this file. options: reviewer ({ name,
 * orcid? }, who signs the retractions; required), release (the name of the release being made), base
 * (the base address, instead of the new version's uriSpace), date (what every attestation written
 * is dated; else now), columns (a table of places: the mapping of its columns), name (the stem of
 * the output's name), signal (stops it at the next record), tamper (the tests only: see below). Returns { report, outputs, revisedAs?,
 * gazetteer? }, with `incomplete` when nothing could be written, in the shape Krisis's apply() returns.
 */
export async function revise({ earlier, later, options = {} }, env) {
  return stoppable(options.signal, env, (e) => revising({ earlier, later, options }, e));
}

async function revising({ earlier, later, options }, env) {
  const rep = new Report();
  const progress = env.progress || (() => {});
  const t0 = Date.now();
  const fail = () => ({ report: rep.toJSON(), outputs: [], incomplete: true });
  const reviewer = options.reviewer;
  if (!reviewer) { rep.error('no-reviewer', TEXT['no-reviewer']); return fail(); }
  try { checkReviewer(reviewer); } catch (e) { if (!(e instanceof DataError)) throw e; rep.error('bad-reviewer', TEXT['bad-reviewer'], e.message); return fail(); }
  if (!later?.format) { rep.error('dataset-not-read', TEXT['dataset-not-read'], later?.reason); return fail(); }
  if (!earlier?.format) { rep.error('previous-not-read', TEXT['previous-not-read'], earlier?.reason); return fail(); }
  const contributor = { name: reviewer.name.trim(), ...(reviewer.orcid ? { orcid: reviewer.orcid } : {}) };
  const date = options.date || new Date().toISOString();
  const release = typeof options.release === 'string' && options.release.trim() ? options.release.trim() : null;
  const context = env.resources.context;
  const db = await env.openDb();
  const statements = [];
  const prepare = (sql) => { const s = db.prepare(sql); statements.push(s); return s; };
  try {
    // ---- 1. The previous release, into the working database --------------------------------------
    db.exec(`CREATE TABLE prevrec(place TEXT PRIMARY KEY, json TEXT NOT NULL, met INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
      CREATE TABLE prev(place TEXT NOT NULL, i INTEGER NOT NULL, id TEXT NOT NULL, d TEXT NOT NULL, PRIMARY KEY(place, i)) WITHOUT ROWID;`);
    const prev = { header: null, withdrawals: new Map(), atts: 0, unaddressed: 0 };
    {
      const putRec = prepare('INSERT OR REPLACE INTO prevrec(place, json) VALUES (?,?)');
      const delAtts = prepare('DELETE FROM prev WHERE place=?');
      const putAtt = prepare('INSERT INTO prev(place, i, id, d) VALUES (?,?,?,?)');
      db.exec('BEGIN');
      const sink = digester(context, sha256, (rec, digests) => {
        if (typeof rec['@id'] !== 'string') return;
        const place = rec['@id'];
        collectWithdrawn(rec.attestations, prev.withdrawals);
        // The same place twice: the last copy is the one put back.
        putRec.bind([place, JSON.stringify(rec)]).stepReset();
        delAtts.bind([place]).stepReset();
        rec.attestations.forEach((a, i) => {
          if (!isObject(a)) return;
          prev.atts++;
          if (!hasId(a) || !digests[i]) { prev.unaddressed++; return; }
          putAtt.bind([place, i, a['@id'], digests[i]]).stepReset();
        });
      }, (ev) => { if (ev.type === 'attestation') { prev.atts++; prev.unaddressed++; } });
      const own = sink.header.bind(sink);
      sink.header = (h) => { prev.header = h || {}; own(h); };
      const r = await run({ input: earlier, action: 'check', options: { signal: options.signal, sink } }, { ...env, progress: (p) => progress({ ...p, version: 'earlier', phase: p.phase === 'done' ? 'read' : p.phase }) });
      db.exec('COMMIT');
      if (r.aborted) throw new Aborted();
      if (r.incomplete) { rep.error('previous-not-read', TEXT['previous-not-read'], r.report.items.find((i) => i.kind === 'unreadable')?.examples[0]); return fail(); }
      const problems = r.report.items.filter((i) => i.severity === 'error').reduce((t, i) => t + i.count, 0);
      if (problems) rep.add('warning', 'previous-has-problems', TEXT['previous-has-problems'], undefined, problems);
    }
    db.exec('CREATE INDEX prev_id ON prev(id); CREATE INDEX prev_d ON prev(place, d, i)');
    const prevG = isObject(prev.header?.gazetteer) ? prev.header.gazetteer : {};
    if (!prev.atts) { rep.error('previous-no-places', TEXT['previous-no-places']); return fail(); }
    if (prev.unaddressed) { rep.add('error', 'previous-unaddressed', TEXT['previous-unaddressed'], undefined, prev.unaddressed); return fail(); }
    if (prevG.status !== 'published') rep.warning('earlier-not-published', TEXT['earlier-not-published'], prevG.status === undefined ? undefined : String(prevG.status));
    if (release && prevG.version !== undefined && prevG.version !== null && String(prevG.version) === release) { rep.error('same-release', TEXT['same-release'], release); return fail(); }
    const sameHeader = (g) => (!release && ((typeof g['@id'] === 'string' && g['@id'] === prevG['@id']) || (g.version !== undefined && g.version !== null && prevG.version !== undefined && prevG.version !== null && String(g.version) === String(prevG.version))));
    const prevStatus = resolveWithdrawn(prev.withdrawals).status;
    const prevBase = baseOf(prev.header);

    // ---- 2. The new version: its header first, then place by place, written as it is read ----------
    // The header alone, by a reading stopped as soon as it has been given (the writer's output is batched,
    // so the header could not be read off the output before the first place): the base address every
    // address written goes under, and what the two versions' bases say.
    const header = { seen: false, head: {}, gazetteer: null };
    {
      const stopper = new AbortController();
      const r = await run({ input: later, action: 'check', options: { base: options.base, columns: options.columns, signal: options.signal ? AbortSignal.any([options.signal, stopper.signal]) : stopper.signal,
        sink: { header(h) { header.head = h || {}; header.seen = true; stopper.abort(); }, event() {}, async close() {} } } }, { ...env, progress: () => {} });
      if (options.signal?.aborted) throw new Aborted();
      if (!header.seen) { rep.error('dataset-not-read', TEXT['dataset-not-read'], r.report.items.find((i) => i.kind === 'unreadable')?.examples[0]); return fail(); }
    }
    {
      // Without a release name, the header stays the new version's: one that still names the previous release (the
      // -with-ids copy edited, its header untouched) is refused as the same release name would be.
      const g = isObject(header.head.gazetteer) ? header.head.gazetteer : {};
      if (sameHeader(g)) { rep.error('same-release-header', TEXT['same-release-header'], typeof g['@id'] === 'string' && g['@id'] === prevG['@id'] ? g['@id'] : String(g.version)); return fail(); }
    }
    const base = baseOf(header.head, options.base);
    if (!base) { rep.error('no-base', TEXT['no-base']); return fail(); }
    if (prevBase && prevBase !== base) { rep.error('base-differs', TEXT['base-differs'], `${prevBase} and ${base}`); return fail(); }
    const counts = { kept: 0, inherited: 0, changed: 0, removed: 0, paired: 0, added: 0, readdressed: 0, tombstones: 0, chainClosed: 0, alreadyWithdrawn: 0, withdrawnByYou: 0, stamped: 0, unaddressed: 0, places: 0, placesAdded: 0 };
    // Named in the release report written beside the dataset: every chain closed (the attestation retracted), every tombstone (the place).
    const named = { chainsClosed: [], tombstones: [] };
    // What this revision itself withdraws, by target: 'retracted' or 'superseded', for the checks below.
    const ours = new Map();
    let written = 0;   // attestations in the output
    let refused = null;
    // A refusal met while the new version is read (an address moved from another place) stops the reading
    // through a signal of this revision's own, beside the caller's.
    const ctl = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, ctl.signal]) : ctl.signal;
    const refuse = (kind, example) => { if (!refused) refused = { kind, example }; ctl.abort(); };
    const V = env.resources.validators?.['place-centric']?.entity;
    const valid = (place, a) => { if (V && !V({ '@id': place, label: place, attestations: [a] })) rep.error('not-valid', TEXT['not-valid'], `${place}: ${V.errors.map((e) => `${e.instancePath} ${e.message}`).join('; ')}`); };
    // Retractions owed to places not yet written (a chain that crosses places), by place.
    const owed = new Map();
    const streamed = new Set();
    const prevIdsOf = prepare('SELECT i, id, d FROM prev WHERE place=? ORDER BY i');
    const prevRecOf = prepare('SELECT json FROM prevrec WHERE place=?');
    const placeOfId = prepare('SELECT place FROM prev WHERE id=? LIMIT 1');
    const markMet = prepare('UPDATE prevrec SET met=1 WHERE place=?');
    const rowsOf = (place) => { const rows = []; prevIdsOf.bind([place]); while (prevIdsOf.step()) rows.push({ i: prevIdsOf.get(0), id: prevIdsOf.get(1), d: prevIdsOf.get(2) }); prevIdsOf.reset(); return rows; };
    const recOf = (place) => { prevRecOf.bind([place]); const j = prevRecOf.step() ? prevRecOf.get(0) : null; prevRecOf.reset(); return j ? JSON.parse(j) : null; };
    const placeOf = (id) => { placeOfId.bind([id]); const p = placeOfId.step() ? placeOfId.get(0) : null; placeOfId.reset(); return p; };
    const under = (P) => P.startsWith(base);
    const withdrawn = (target, kind) => { if (!prevStatus.has(target)) ours.set(target, kind === 'retracted' || ours.get(target) === 'retracted' ? 'retracted' : 'superseded'); };

    /**
     * One place: its record in the new version (`rec`, or null for a tombstone), set against the previous
     * release's record of it (`old`, or null for a place added). Returns the record to write.
     */
    function revisePlace(P, rec, old) {
      const rows = old ? rowsOf(P) : [];
      const oldAtts = old ? list(old.attestations) : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const atts = rec ? list(rec.attestations).filter(isObject) : [];
      const digests = rec ? digestsOf(context, P, atts, header.head) : [];
      const taken = new Set();
      // The withdrawals this place's new attestations make by hand, by target: the attestations that make each. One
      // holds unless it is the previous release's own, kept as it was (its address and digest), and withdrawn: a new
      // form keeps a meta it was copied with, and holds under its new address.
      const closers = new Map();
      atts.forEach((a, j) => { const w = withdrawalOf(a); if (w) (closers.get(w.target) || closers.set(w.target, []).get(w.target)).push({ a, j }); });
      const keptAsIs = ({ a, j }) => hasId(a) && byId.has(a['@id']) && digests[j] === byId.get(a['@id']).d;
      const holdsNow = (x) => !(keptAsIs(x) && (prevStatus.has(x.a['@id']) || withdrawnNow.has(x.a['@id'])));
      const out = [];          // [{ a, how }] in the order written: kept, old (put back), new, retraction
      const retractions = [];  // [{ target, note }]
      const withdrawnNow = new Set();   // targets this revision withdraws in this place
      const kindOf = (a) => jcs([FACETS.filter((k) => list(a[k]).length), [...new Set([...list(a.citations).map((c) => (isObject(c) ? c.source : c)), ...list(a.sources)].map((s) => (typeof s === 'string' ? s : isObject(s) ? s['@id'] ?? s.title ?? null : null)).filter(Boolean))].sort()]);
      const stamp = (a) => { if (a.created === undefined || a.created === null) { counts.stamped++; rep.warning('created-stamped', TEXT['created-stamped'], P); return { ...a, created: date }; } return a; };
      const without = (a) => { const { '@id': _, ...rest } = a; void _; return rest; };
      /** Retract `target` (an attestation of the previous release) by a new attestation, once. */
      const retract = (target, note) => {
        if (withdrawnNow.has(target)) return;
        withdrawnNow.add(target);
        retractions.push({ target, note });
        withdrawn(target, 'retracted');
      };
      /** The chain: `x` (an attestation of the previous release) is withdrawn here; what it replaced must not come back. */
      const closeChain = (x, by) => {
        const w = withdrawalOf(x);
        if (!w || w.kind !== 'superseded') return;
        const T = w.target;
        if (withdrawnNow.has(T)) return;
        // Withdrawn by hand, or by the new form, by something that still holds: nothing to do.
        if ((closers.get(T) || []).some(holdsNow)) return;
        if (byId.has(T)) {
          retract(T, NOTE.chain); counts.chainClosed++; named.chainsClosed.push(T); rep.warning('chain-closed', TEXT['chain-closed'], T);
          closeChain(oldAtts[byId.get(T).i], T);
          return;
        }
        const elsewhere = placeOf(T);
        if (!elsewhere) return;   // not in the previous release: nothing published revives
        if (streamed.has(elsewhere)) { refuse('cannot-close-chain', `${by} replaced ${T}`); return; }
        (owed.get(elsewhere) || owed.set(elsewhere, []).get(elsewhere)).push(T);
      };
      /** The old form back under its address (once), and its chain closed with it. */
      const putBack = (r) => { if (taken.has(r.id)) return; taken.add(r.id); out.push({ a: oldAtts[r.i], how: 'old' }); };
      const supersede = (a, r) => {
        out.push({ a: stamp({ ...without(a), meta: { targetAttestation: r.id, metaType: SUPERSEDES } }), how: 'new' });
        withdrawnNow.add(r.id); withdrawn(r.id, 'superseded');
        counts.changed++; rep.warning('superseded', TEXT.superseded, r.id);
        closeChain(oldAtts[r.i], r.id);
      };
      // An address used twice in the new version: the one that says what the previous release said under it keeps it, else the first.
      const idCount = new Map();
      for (const a of atts) if (hasId(a)) idCount.set(a['@id'], (idCount.get(a['@id']) || 0) + 1);
      const keeper = new Map();
      for (const [id, k] of idCount) {
        if (k < 2) continue;
        rep.warning('address-twice', TEXT['address-twice'], id);
        const r = byId.get(id);
        let at = r ? atts.findIndex((a, i) => a['@id'] === id && digests[i] === r.d) : -1;
        if (at < 0) at = atts.findIndex((a) => a['@id'] === id);
        keeper.set(id, at);
      }
      const added = [];   // indexes into `out` of attestations added plain (for the pairing)
      atts.forEach((a0, j) => {
        let a = a0;
        const d = digests[j];
        let id = hasId(a) ? a['@id'] : null;
        if (id !== null && keeper.has(id) && keeper.get(id) !== j) {
          // The second use of an address the previous release knows: the keeper is the original, and
          // this one replaces it; else the keeper replaced it already, and this one is added.
          const r = byId.get(id);
          if (r && digests[keeper.get(id)] === r.d && !withdrawalOf(a)) { supersede(a, r); return; }
          a = without(a); id = null;
        }
        const r = id !== null ? byId.get(id) : null;
        if (r && d === r.d) { taken.add(id); counts.kept++; out.push({ a, how: 'kept' }); return; }
        if (r) {
          // Changed: the old form back under its address, the new form beside it, replacing it.
          const old = oldAtts[r.i];
          putBack(r);
          if (withdrawalOf(old)?.kind === 'retracted') {
            // A retraction changed: it is put back and holds; the changed form is added on its own.
            rep.warning('withdrawal-kept', TEXT['withdrawal-kept'], id);
            out.push({ a: stamp(without(a)), how: 'new' }); counts.added++;
            return;
          }
          if (withdrawalOf(a)) {
            // The new form withdraws something of its own (an attestation's meta is one object): the old is retracted beside it.
            out.push({ a: stamp(without(a)), how: 'new' }); counts.added++;
            retract(id, NOTE.retracted); counts.removed++; rep.warning('retracted', TEXT.retracted, id);
            closeChain(old, id);
            return;
          }
          supersede(a, r);
          return;
        }
        if (id !== null && placeOf(id)) { refuse('address-moved', id); return; }
        // No address the previous release knows: by what it says, the first untaken twin in file order.
        // Not one the previous release withdrew: a row deleted in one release and put back in the next is new (its
        // retracted twin is put back, dead, below), and is minted afresh, told from the twin by Agora's counter.
        const twin = rows.find((x) => !taken.has(x.id) && x.d === d && !prevStatus.has(x.id));
        if (twin) {
          taken.add(twin.id);
          if (id !== null) { counts.readdressed++; rep.warning('readdressed-restored', TEXT['readdressed-restored'], twin.id); }
          else counts.inherited++;
          out.push({ a: { '@id': twin.id, ...without(a) }, how: 'kept' });
          return;
        }
        // Added (an address of the user's own is kept, as minting keeps any).
        out.push({ a: stamp(a), how: 'new' }); counts.added++;
        if (!withdrawalOf(a)) added.push(out.length - 1);
      });
      // What the previous release had of this place that the new version has not.
      const removed = [];
      for (const r of rows) {
        if (taken.has(r.id)) continue;
        const old = oldAtts[r.i];
        putBack(r);
        if (withdrawnNow.has(r.id)) continue;   // retracted already, by a chain
        if (prevStatus.has(r.id)) { counts.alreadyWithdrawn++; rep.warning('already-withdrawn', TEXT['already-withdrawn'], r.id); continue; }
        if ((closers.get(r.id) || []).some(holdsNow)) { counts.withdrawnByYou++; rep.warning('withdrawn-by-you', TEXT['withdrawn-by-you'], r.id); closeChain(old, r.id); continue; }
        if (withdrawalOf(old)?.kind === 'retracted') { rep.warning('withdrawal-kept', TEXT['withdrawal-kept'], r.id); continue; }
        if (!rec) { retract(r.id, NOTE.tombstone); closeChain(old, r.id); continue; }   // a tombstone: every claim retracted; a retraction stays, holding
        removed.push({ r, old });
      }
      // The pairing (D2): exactly one deleted and exactly one added of a kind, citing the same source, and only where the
      // new version has no addresses at all for this place (the tables case, minted afresh each release): a version that
      // carries addresses says what it deleted and what it added, and nothing is guessed there.
      const tables = !atts.some(hasId);
      const byKind = new Map();
      for (const x of removed) { const k = kindOf(x.old); (byKind.get(k) || byKind.set(k, { gone: [], came: [] }).get(k)).gone.push(x); }
      for (const at of added) { const k = kindOf(out[at].a); (byKind.get(k) || byKind.set(k, { gone: [], came: [] }).get(k)).came.push(at); }
      for (const { gone, came } of byKind.values()) {
        if (tables && gone.length === 1 && came.length === 1) {
          const [x] = gone, at = came[0];
          out[at].a = { ...out[at].a, meta: { targetAttestation: x.r.id, metaType: SUPERSEDES } };
          withdrawnNow.add(x.r.id); withdrawn(x.r.id, 'superseded');
          counts.paired++; rep.warning('paired', TEXT.paired, `${x.r.id} (${P})`);
          closeChain(x.old, x.r.id);
          continue;
        }
        for (const x of gone) { retract(x.r.id, NOTE.retracted); counts.removed++; rep.warning('retracted', TEXT.retracted, x.r.id); closeChain(x.old, x.r.id); }
      }
      // Retractions owed to this place by chains from places written before it.
      for (const T of owed.get(P) || []) if (byId.has(T) && !withdrawnNow.has(T)) { retract(T, NOTE.chain); counts.chainClosed++; named.chainsClosed.push(T); rep.warning('chain-closed', TEXT['chain-closed'], T); closeChain(oldAtts[byId.get(T).i], T); }
      owed.delete(P);
      if (!rec) { counts.tombstones++; named.tombstones.push(P); rep.warning('tombstone', TEXT.tombstone, P); }
      // The retractions, each an attestation of its own.
      for (const { target, note } of retractions) out.push({ a: { meta: { targetAttestation: target, metaType: RETRACTS }, contributor, created: date, notes: note }, how: 'retraction' });
      // Addresses, under the base only: every digest of the place known first, then each new one minted
      // against them all, the retractions last (each holds its target), as Krisis does.
      const ids = new Set([...rows.map((r) => r.id), ...out.filter((x) => hasId(x.a)).map((x) => x.a['@id'])]);
      const need = out.filter((x) => (x.how === 'new' || x.how === 'retraction') && !hasId(x.a));
      if (need.length && !under(P)) {
        // A release carries an address on every attestation (Stephen, 17 October 2026): one that cannot be given one is refused.
        if (need.some((x) => x.how === 'retraction')) refuse('cannot-withdraw-outside-base', P); else refuse('attestations-unaddressed', P);
        counts.unaddressed += need.length;
      } else if (need.length) {
        const all = [...rows.map((r) => r.d), ...digests.filter(Boolean)];
        const mint = (x) => {
          const [d] = digestsOf(context, P, [x.a], header.head);
          if (!d) return;
          if (!all.includes(d)) all.push(d);
          const { id } = mintAddress(P, d, all, (c) => ids.has(c));
          ids.add(id);
          x.a = { '@id': id, ...x.a };
        };
        for (const x of need) if (x.how === 'new') mint(x);
        for (const x of need) if (x.how === 'retraction') mint(x);
      }
      for (const x of out) if (x.how === 'retraction' || (x.how === 'new' && x.a.meta)) valid(P, x.a);
      written += out.length;
      return { ...(rec || old), attestations: out.map((x) => x.a) };
    };

    // options.tamper (the tests only): each record written is given to it, and what it returns is written instead
    // (a retraction dropped, an attestation of a tombstone lost), so that the checks below are shown catching a writer gone wrong.
    const tamper = typeof options.tamper === 'function' ? options.tamper : (rec) => rec;
    const augment = (rec) => {
      if (refused || !isObject(rec) || typeof rec['@id'] !== 'string') return rec;
      const P = rec['@id'];
      counts.places++;
      const old = recOf(P);
      if (old) markMet.bind([P]).stepReset(); else counts.placesAdded++;
      if (streamed.has(P)) { written += list(rec.attestations).filter(isObject).length; return rec; }   // the same place twice in the new version: the first copy is revised
      streamed.add(P);
      return tamper(revisePlace(P, rec, old));
    };
    // The places of the previous release the new version has not: each a tombstone, after the records read.
    function* tombstones() {
      if (refused) return;
      const q = db.prepare('SELECT place FROM prevrec WHERE met=0 ORDER BY place');
      const places = [];
      try { while (q.step()) places.push(q.get(0)); } finally { q.finalize(); }
      for (const P of places) { halt(signal); streamed.add(P); yield tamper(revisePlace(P, null, recOf(P))); }
    }
    // The header, made a release's, as the writer writes it.
    const edit = (head) => {
      const g = { ...(isObject(head.gazetteer) ? head.gazetteer : {}) };
      if (options.base && normaliseBase(g.uriSpace) !== base) { rep.warning('base-written', MINT_TEXT['base-written'], `${base}${g.uriSpace ? `, not ${g.uriSpace}` : ''}`); g.uriSpace = base; }
      if (g.status !== 'published') { rep.warning('later-not-published', TEXT['later-not-published'], g.status === undefined ? undefined : String(g.status)); g.status = 'published'; }
      if (release) {
        g['@id'] = `${base}release/${release}`; g.isVersionOf = base; g.version = release;
        if (typeof prevG['@id'] === 'string') g.previousVersion = prevG['@id'];
        rep.warning('release-written', TEXT['release-written'], g['@id']);
      }
      const sets = [...new Set([...list(prevG.candidateSets), ...list(g.candidateSets)].filter((s) => typeof s === 'string'))];
      if (sets.length) g.candidateSets = sets;
      header.gazetteer = g;
      return { ...head, gazetteer: g };
    };
    const name = outputName(options.name || later.files[0].name);
    const kept = new Map();
    progress({ phase: 'revising', elapsedMs: Date.now() - t0 });
    const r = await run({ input: later, action: 'convert', target: 'plato-json', options: { name, base: options.base, columns: options.columns, augment, extraRecords: tombstones, signal } },
      rewritingHeader(teeing(env, kept), name, edit));
    if (refused) { rep.error(refused.kind, TEXT[refused.kind], refused.example); return fail(); }
    if (r.aborted) throw new Aborted();
    if (!header.gazetteer) { rep.error('dataset-not-read', `${TEXT['dataset-not-read']}: its header was not written`); return fail(); }
    let own = 0;
    for (const i of r.report.items) {
      if (NOT_READ.has(i.kind)) rep.add('error', 'dataset-not-read', `${TEXT['dataset-not-read']}: ${i.message}`, i.examples[0], i.count);
      else if (i.severity === 'error') own += i.count;
      else rep.add(i.severity, i.kind, i.message, i.examples[0], i.count);
    }
    if (own) rep.add('warning', 'dataset-has-problems', TEXT['dataset-has-problems'], undefined, own);
    if (later.format !== 'plato-json' || later.profile === 'attestation-centric') rep.warning('dataset-now-plato-json', TEXT['dataset-now-plato-json'](formatName(later)), name);
    if (counts.inherited) rep.add('warning', 'inherited', TEXT.inherited, undefined, counts.inherited);
    const parts = kept.get(name);
    if (r.incomplete || !parts || rep.toJSON().errors) return fail();
    const addedAll = written - prev.atts;
    rep.counts = { ...counts, attestations: written, previous: prev.atts, addedAll };

    // ---- 3. Checked before it is handed on ----------------------------------------------------------
    progress({ phase: 'checking', elapsedMs: Date.now() - t0 });
    const file = new File(parts, name);
    const output = await detect([file]);
    // Read back for its withdrawals: nothing the previous release withdrew current again, and every one this revision planned in it.
    const read = { edges: new Map(), atts: 0, unaddressed: [] };
    const back = await run({ input: output, action: 'check', options: { signal: options.signal, sink: { header() {}, event(ev) {
      const atts = ev.type === 'record' ? list(ev.value?.attestations) : ev.type === 'attestation' ? [ev.value] : [];
      const objects = atts.filter(isObject);
      read.atts += objects.length; collectWithdrawn(atts, read.edges);
      // Every attestation written carries an address (one whose statements could not be made got no digest, and no address).
      if (objects.some((a) => !hasId(a)) && read.unaddressed.length < 5) read.unaddressed.push(ev.type === 'record' ? ev.value['@id'] : ev.value.about);
    }, async close() {} } } }, { ...env, progress: () => {} });
    for (const where of read.unaddressed) rep.error('not-all-addressed', TEXT['not-all-addressed'], where);
    if (back.aborted) throw new Aborted();
    if (back.incomplete) { rep.error('not-checked', TEXT['not-checked']); return fail(); }
    const after = resolveWithdrawn(read.edges).status;
    // Nothing the previous release withdrew is current again, unless the new version restored it PLATO's way: every
    // withdrawal of it is itself withdrawn now, by an attestation the new version adds (restored, said); else a fault.
    for (const [target] of prevStatus) {
      if (after.has(target)) continue;
      // Restored: each withdrawer RETRACTED by an attestation the new version adds; a withdrawer merely replaced is the chain hazard, a revival.
      const restored = (prev.withdrawals.get(target) || []).every((e) => e.by !== null && after.get(e.by) === 'retracted' && (read.edges.get(e.by) || []).some((x) => x.kind === 'retracted' && (x.by === null || !placeOf(x.by))));
      if (restored) rep.warning('restored', TEXT.restored, target); else rep.error('revived', TEXT.revived, target);
    }
    for (const [target, kind] of ours) if (!after.has(target) || (kind === 'retracted' && after.get(target) !== 'retracted')) rep.error('not-all-withdrawn', TEXT['not-all-withdrawn'](`${target} (${kind})`, after.get(target) ? `it ${after.get(target)}` : 'it not at all'));
    // What is newly withdrawn in the output, by the output's own resolution: the counts the version check must find.
    const got = { retracted: 0, superseded: 0 };
    for (const [target, kind] of after) if (!prevStatus.has(target) && placeOf(target)) got[kind]++;
    if (read.atts !== written) rep.error('not-all-added', TEXT['not-all-added'](addedAll, read.atts - prev.atts));
    if (rep.toJSON().errors) return fail();
    Object.assign(rep.counts, got);
    if (!got.retracted && !got.superseded && !addedAll) rep.warning('nothing-revised', TEXT['nothing-revised']);
    // The version check, as a user would run it: the previous release the earlier version, the output the later.
    const c = await compare({ earlier, later: output, options: { signal: options.signal } }, { ...env, progress: (p) => progress({ ...p, phase: 'checking', elapsedMs: Date.now() - t0 }) });
    if (c.aborted) throw new Aborted();
    for (const i of c.report.items) {
      if (i.kind === 'answered-both-ways') rep.add('error', i.kind, i.message, i.examples[0], i.count);   // passed through as the error it is: a decision changed is Krisis's to withdraw
      else if (CHANGED.has(i.kind)) { rep.add('error', 'not-append-only', `${TEXT['not-append-only']} ${i.message}`, i.examples[0], i.count); for (const x of i.explained || []) rep.explain('not-append-only', x.example, x.earlier, x.later); }
      else if (FACET.has(i.kind) && i.severity === 'error') { rep.add('error', 'facet-changed', TEXT['facet-changed'], i.examples[0], i.count); for (const x of i.explained || []) rep.explain('facet-changed', x.example, x.earlier, x.later); }
      else if (i.kind === 'unreadable' || i.kind === 'version-not-read') rep.add('error', 'not-checked', `${TEXT['not-checked']}: ${i.message}`, i.examples[0], i.count);
      else if (!SAID.has(i.kind)) rep.add(i.severity === 'error' ? 'error' : 'warning', i.kind, i.message, i.examples[0], i.count);
    }
    const k = c.report.counts;
    if (k.earlier === undefined) rep.error('not-checked', TEXT['not-checked']);
    else {
      rep.counts.versionCheck = { earlier: k.earlier, later: k.later, unchanged: k.unchanged, changed: k.changed, lost: k.lost, added: k.added, retracted: k.retracted, superseded: k.superseded };
      if (k.added !== addedAll) rep.error('not-all-added', TEXT['not-all-added'](addedAll, k.added));
      if (k.retracted !== got.retracted || k.superseded !== got.superseded) rep.error('not-all-withdrawn', TEXT['not-all-withdrawn'](saidWithdrawn(got), saidWithdrawn({ retracted: k.retracted, superseded: k.superseded })));
    }
    const sha = await fileSha256(file);
    kept.clear();
    if (rep.toJSON().errors) return fail();
    rep.counts.said = [summaryLine(rep.counts)];
    // The release report (Stephen, 17 October 2026): a small machine-readable account beside the dataset, for a
    // cross-check (the report in words stays): the counts by category, and the address of every chain closed
    // and every tombstone. Written only once the checks above have passed, as the dataset is.
    const account = releaseReport({ name, sha, prevG, gazetteer: header.gazetteer, contributor, date, counts: rep.counts, named, versionCheck: rep.counts.versionCheck });
    const ro = await env.output(reportName(name));
    ro.write(JSON.stringify(account, null, 2) + '\n');
    const reportOut = await ro.close();
    progress({ phase: 'done', elapsedMs: Date.now() - t0 });
    return { report: rep.toJSON(), outputs: [...r.outputs, reportOut], revisedAs: { output: name, sha256: sha }, gazetteer: header.gazetteer, account };
  } finally {
    for (const s of statements) { try { s.finalize(); } catch { /* finalized already */ } }
    try { db.close(); } catch { /* closed already */ }
  }
}

/** The name of the release report beside the dataset: the new version's stem, then .release.json. */
export const reportName = (revised) => revised.replace(/-revised\.json$/, '') + '.release.json';
/**
 * The release report, as a plain object: what the revision did, by category (unchanged, new, superseded, retracted,
 * tombstoned places; the chains closed), the address of every chain closed and every tombstone, the versions, who
 * signed the retractions (the reviewer, as the dataset's maintainer) and when, and the version check's counts.
 */
export function releaseReport({ name, sha, prevG, gazetteer, contributor, date, counts, named, versionCheck }) {
  const g = gazetteer || {};
  return {
    format: 'plato-tools-release', version: 1,
    revised: { file: name, sha256: sha },
    previous: { '@id': prevG['@id'] ?? null, version: prevG.version ?? null },
    release: { '@id': g['@id'] ?? null, version: g.version ?? null, previousVersion: g.previousVersion ?? null, isVersionOf: g.isVersionOf ?? null },
    maintainer: contributor, date,
    counts: { unchanged: (counts.kept || 0) + (counts.inherited || 0), new: counts.added || 0, superseded: counts.superseded || 0, retracted: counts.retracted || 0, tombstones: counts.tombstones || 0, chainsClosed: counts.chainClosed || 0,
      places: counts.places || 0, placesAdded: counts.placesAdded || 0, attestations: counts.attestations || 0, previousAttestations: counts.previous || 0 },
    chainsClosed: [...named.chainsClosed], tombstones: [...named.tombstones],
    ...(versionCheck ? { versionCheck } : {}),
  };
}
const saidWithdrawn = (w) => [w.retracted ? plural(w.retracted, 'retraction') : '', w.superseded ? plural(w.superseded, 'replacement') : ''].filter(Boolean).join(' and ') || 'nothing';
/** One line that sums the revision up, as the page and the command line show it. */
export function summaryLine(c) {
  const parts = [`Kept ${plural((c.kept || 0) + (c.inherited || 0), 'attestation')}`];
  const withdrew = [c.superseded ? `superseded ${n(c.superseded)}` : '', c.retracted ? `retracted ${n(c.retracted)}` : ''].filter(Boolean).join(' and ');
  if (withdrew) parts.push(`${withdrew}${c.tombstones ? ` (${plural(c.tombstones, 'place')} withdrawn whole)` : ''}`);
  if (c.added) parts.push(`${n(c.added)} added${c.placesAdded ? ` (${plural(c.placesAdded, 'new place')})` : ''}`);
  return parts.join('; ') + '.';
}

/**
 * env, with each output also kept as Blob parts, so that the file can be read again for the checks
 * (env has no way to read an output back). The whole output is held until the checks are done.
 */
function teeing(env, kept) {
  return { ...env, output: async (name, binary) => {
    const o = await env.output(name, binary);
    const parts = [];
    return {
      write: (s) => { parts.push(new Blob([s])); o.write(s); },
      writeBytes: (b) => { parts.push(new Blob([b])); o.writeBytes(b); },
      close: async () => { const r = await o.close(); kept.set(name, parts); return r; },
    };
  } };
}

/**
 * env, with the header of the output `name` (the place-centric PLATO JSON the pipeline writes: the
 * header, then "spatialEntities":[, in its first writes) given to `edit(head) -> head` once it is
 * complete, and written as edited. The text is held until then, so `edit` runs before any record.
 */
function rewritingHeader(env, name, edit) {
  return { ...env, output: async (n, binary) => {
    const o = await env.output(n, binary);
    if (n !== name) return o;
    let held = '', done = false;
    return {
      write: (s) => {
        if (done) return o.write(s);
        held += s;
        const head = headerOf(held);
        if (head === null) return;
        done = true;
        const text = JSON.stringify(edit(head.head));
        o.write(text.slice(0, -1) + ',' + held.slice(head.at));
      },
      writeBytes: (b) => o.writeBytes(b),
      close: async () => { if (!done && held) o.write(held); return o.close(); },
    };
  } };
}
/** The header of place-centric PLATO JSON text, once it is all there: { head, at } (`at` where "spatialEntities":[ begins), or null. */
export function headerOf(text) {
  const KEY = '"spatialEntities":[';
  for (let at = text.indexOf(KEY); at > 0; at = text.indexOf(KEY, at + 1)) {
    if (text[at - 1] !== ',') continue;
    let head;
    // The first place where what comes before closes as one object is the header's end: the key met
    // inside a header value would leave it open.
    try { head = JSON.parse(text.slice(0, at - 1) + '}'); } catch { continue; }
    return { head, at };
  }
  return null;
}
