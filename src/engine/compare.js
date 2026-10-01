// The version check: given two versions of a dataset, confirm PLATO's append-only rule. Once a
// gazetteer's status is 'published' its attestations are never deleted or changed; a correction is a
// new attestation that retracts or replaces the old one (plato:Retracts, plato:Supersedes), which
// stays (see plato:Gazetteer in the ontology).
//
// Each version is read by the engine that checks and converts (run() in pipeline.js), which hands
// every input over as place-centric records, whatever format it came in. Each record is turned into
// its RDF statements, and what is compared is what each attestation SAYS, not how the file writes it:
// the order of keys, a source written out in full or cited by its address, JSON or RDF make no
// difference. An attestation's content is its own statements and those of the nodes under it that
// have no address of their own (its names, dates, citations). A node with an address (a source, a
// place, a shared name) is only referred to: what the dataset says about it is compared separately.
// There the kind of thing decides. A name, location, date, type, property or citation that an
// earlier attestation points to is part of what that attestation says, address or no, so losing a
// statement about it breaks the rule as changing the attestation would. A place or a source may be
// corrected and enriched (plato:Gazetteer says so), so a change to one is a warning.
//
// When something has changed, both versions are read once more, for the few examples the report
// shows, to say WHAT changed: the statements found in one version only.
//
// A candidate set (PLATO 05cf78a) is compared the same way, candidate by candidate, but it is frozen
// as a whole once issued: its address is minted from its candidates' texts, so no candidate is
// changed, deleted or added, whatever became of it (what became of it is read from the attestations
// that answer it, never from its status), and its date of issue and its dataset do not change. New
// suggestions go in a new set, under a new address, so two sets under different addresses are not
// compared, nor a set with a dataset.
//
// Nothing is held in memory but the record in hand: a digest of each attestation goes into a working
// database, where the two versions are compared, so the check runs at any size, like the rest.
import { run } from './pipeline.js';
import { Report } from './report.js';
import { Json2Rdf, jcs } from '../formats/json2rdf.js';
import { termNT } from '../lib/ntriples.js';
import { PLATO } from '../lib/context.js';
import { collectWithdrawn, resolveWithdrawn } from '../formats/shared.js';
import { sha256 } from '../lib/sha256.js';

const ABOUT = PLATO + 'attests_about', META_ABOUT = PLATO + 'meta_attestation_about', CREATED = PLATO + 'created';
const CANDIDATE_SOURCE = PLATO + 'candidate_source', CANDIDATES_FOR = PLATO + 'candidates_for';
const IDENTITY_SUBJECT = PLATO + 'identity_subject', ATTESTS_IDENTITY = PLATO + 'attests_identity', HAS_CITATION = PLATO + 'has_citation';
// What an attestation bundles: its facets (plato:attests_name, attests_geometry, …) and its citations.
const isFacetLink = (p) => p === HAS_CITATION || (p.startsWith(PLATO + 'attests_') && p !== ABOUT);
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const EARLIER = 0, LATER = 1, ATTESTATION = 0, IDENTITY = 1, CANDIDATE = 2;
const KIND_NAMES = ['attestation', 'identity', 'candidate'];
const nodeKey = (t) => (t.termType === 'BlankNode' ? '_:' + t.value : t.value);
const isBlank = (key) => key.startsWith('_:');
// 128 bits of SHA-256: the digests guard against accident, not attack, and half the length halves
// the working database.
const digest = (text) => sha256(text).slice(0, 32);

// A problem of a version's own that stops part of it being read: the comparison is then of less
// than the whole, so it cannot pass. Other problems (a record the JSON Schema rejects) are the
// check's to list; the record was still read.
export const NOT_READ = new Set(['json-syntax', 'rdf-syntax', 'record-failed', 'late-header', 'not-a-list', 'lpf-v2', 'lpf-not-a-feature', 'jsonl-not-an-object']);
// What a version holds that has no place in PLATO's RDF: it is not among the statements compared.
const NOT_IN_RDF = new Set(['unmapped-key', 'relative-iri', 'unconvertible', 'not-in-rdf']);
// How many changed things of each kind are explained: as many as a report shows examples of.
const EXPLAINED = 5;

const TEXT = {
  'attestation-removed': 'An attestation of the earlier version is not in the later one. A published attestation is never deleted: put it back, and withdraw it with a new attestation that retracts it (plato:Retracts) or replaces it (plato:Supersedes).',
  'attestation-changed': 'An attestation of the earlier version says something different in the later one. A published attestation is never changed: put it back as it was, and record the correction as a new attestation that replaces it (plato:Supersedes).',
  'attestation-readdressed': 'An attestation of the earlier version is in the later one, saying the same, but without its web address (@id), or under another. Its address is how later attestations point to it, to replace or withdraw it: give it back its address.',
  'attestation-gone': 'An attestation of the earlier version that has no web address of its own (@id) is not in the later one as it was: it was deleted, or changed. Put it back as it was. Without an address the two cannot be told apart, and nothing can retract or replace it; the example names the place it is about.',
  'candidate-removed': 'A candidate of the earlier version of this candidate set is not in the later one. A published candidate is never deleted: identity relations answer it by its address (promotedFrom), and must keep their meaning. Put it back as it was; a new run of the software is a new candidate set.',
  'candidate-changed': 'A candidate of the earlier version of this candidate set says something different in the later one: its places, score, software, settings, time or status. A published candidate is never changed, whatever became of it: that is read from the attestations that answer it, not from the candidate. Put it back as it was; a new run of the software is a new candidate set.',
  'candidate-readdressed': 'A candidate of the earlier version of this candidate set is in the later one, saying the same, but without its web address (@id), or under another. Identity relations answer a candidate by its address (promotedFrom): give it back its address.',
  'candidate-gone': 'A candidate of the earlier version of this candidate set that has no web address of its own (@id) is not in the later one as it was: it was deleted, or changed. Put it back as it was.',
  'candidate-added': 'The later copy of this candidate set has a candidate the earlier one does not. A candidate set is frozen as a whole once issued (its address is made from its candidates), so nothing is added to it: new suggestions belong in a new candidate set, under a new address, which leaves out the candidates already published.',
  'different-kinds': 'One file is a dataset and the other a candidate set, so they are not two versions of one thing and were not compared. Give two versions of one dataset, or two copies of one candidate set.',
  'different-candidate-set': 'The two files are different candidate sets (their addresses, @id, differ), not two versions of one, so they were not compared. A candidate set is never revised: a later run of the software is a new set, under a new address, which leaves out every candidate an earlier set published.',
  'candidate-set-issued-changed': 'The two copies of this candidate set give different dates of issue (issued). A candidate set is frozen as a whole once issued, its date of issue with it: put the date back as it was.',
  'candidate-set-for-changed': 'The two copies of this candidate set say they were made for different datasets (candidatesFor). A candidate set is frozen as a whole once issued, the dataset it was made for with it: put it back as it was. Suggestions for another dataset belong in a new candidate set.',
  'candidate-set-described-changed': 'The two copies of this candidate set describe it differently (its title, description, creator or licence). This is allowed: a description may be corrected, as an Authority\'s may, and the candidates are what is frozen.',
  'candidate-set-unlisted': "A candidate set the earlier version lists (candidateSets) is not listed in the later one. The list is the dataset's description of itself, not an attestation, so this does not break the rule; but the dataset's identity relations may still answer candidates in that set (promotedFrom), and a reader can no longer find it from here.",
  'nothing-to-compare-candidates': 'The earlier version holds no candidates, so there was nothing for the later one to have kept, and nothing was tested.',
  'identity-removed': 'An identity match of the earlier version is not in the later one. The append-only rule is about attestations, so this does not break it, but the match has gone with no record of why.',
  'identity-changed': 'An identity match of the earlier version says something different in the later one. The append-only rule is about attestations, so this does not break it, but nothing records the change.',
  'identity-gone': 'An identity match of the earlier version that has no web address of its own (@id) is not in the later one as it was: it was removed, or changed. The append-only rule is about attestations, so this does not break it; the example names the place it is about.',
  'facet-changed': 'A name, location, date, type, property or citation that attestations of the earlier version point to by its web address does not say in the later version all that it said. It is part of what those attestations say, so they have changed, though nothing in them has. Put it back as it was, and record the correction as a new attestation, with a name (or date, or location) of its own, that replaces the old one (plato:Supersedes).',
  'facet-removed': 'A name, location, date, type, property or citation that attestations of the earlier version point to by its web address is not described in the later version at all. It is part of what those attestations say, so they have changed, though nothing in them has. Put it back as it was.',
  'facet-added-to': 'A name, location, date, type, property or citation that attestations of the earlier version point to by its web address has more said of it in the later version. What those attestations said still holds, but they now say more than was published.',
  'description-removed': 'A place, a source or something else the earlier version describes under a web address of its own is not described in the later one. Places and sources may be corrected, so this does not break the rule, but the dataset no longer says what it is.',
  'description-changed': 'A place, a source or something else with a web address of its own is described differently: what the earlier version says of it is not all in the later one. Places and sources may be corrected, so this does not break the rule.',
  'not-compared': 'has something that cannot be written as PLATO RDF, which is what is compared, so a difference there would not be seen',
  'added-without-created': 'An attestation added in the later version does not say when it was made (created). Without that, the state of the dataset at an earlier moment cannot be worked out from the data alone.',
  'earlier-unidentified': 'Attestations of the earlier version have no web address of their own (@id). They were compared by what they say, which cannot tell one that was changed from one deleted and another added, and no later attestation can retract or replace them. Give published attestations addresses.',
  'earlier-not-published': "The earlier version does not say that it is published (status), so the append-only rule does not bind it yet. What would break the rule is listed here as warnings.",
  'later-not-published': 'The earlier version is published, but the later one does not say that it is (status). Published is published: a later version is published too.',
  'previous-version-differs': "The later version names another version as the one before it (previousVersion), not the earlier file's. If versions came between them, this comparison still holds: the rule runs through them all.",
  'different-gazetteer': 'The two files say they are versions of different gazetteers (isVersionOf).',
  'same-version': 'Both files give the same version. A changed dataset needs a new one, or a citation of the version no longer says which state was meant.',
  'nothing-to-compare': 'The earlier version holds no attestations, so there was nothing for the later one to have kept, and nothing was tested.',
};

// The comparison's queries. Each looks up, for every row of one version, its counterpart in the other,
// so each inner lookup must go by an index on more than the version, or the comparison takes time
// by the square of the data: SQLite once chose the index on addresses for a lookup by digest, and
// each of DEEP's identity matches then read every row of the other version. INDEXED BY says which
// index is meant, and test/compare.test.js reads SQLite's plan for each query.
export const QUERIES = {
  // Those with an address: is it in the later version, does it say the same there, does the later
  // version say anything else under that address, and is what it said there without it? (The same address twice, once unchanged
  // and once saying something new, is one node in RDF: a changed attestation.)
  addressed: `SELECT o.k, o.id,
      EXISTS(SELECT 1 FROM a n INDEXED BY ai WHERE n.v=1 AND n.id=o.id),
      EXISTS(SELECT 1 FROM a n INDEXED BY ai WHERE n.v=1 AND n.id=o.id AND n.h=o.h),
      EXISTS(SELECT 1 FROM a n INDEXED BY ai WHERE n.v=1 AND n.id=o.id AND NOT EXISTS(SELECT 1 FROM a x INDEXED BY ai WHERE x.v=0 AND x.id=n.id AND x.h=n.h)),
      EXISTS(SELECT 1 FROM a n INDEXED BY ah WHERE n.v=1 AND n.h=o.h AND (n.id IS NULL OR n.id<>o.id))
    FROM a o INDEXED BY ai WHERE o.v=0 AND o.id IS NOT NULL ORDER BY o.id`,
  // Those without, by what they say: how many there were, and how many saying the same the later
  // version has, not counting those under an address the earlier version already had.
  unaddressed: `SELECT o.k, COUNT(*), MIN(o.about),
      (SELECT COUNT(*) FROM a n INDEXED BY ah WHERE n.v=1 AND n.h=o.h AND (n.id IS NULL OR NOT EXISTS(SELECT 1 FROM a x INDEXED BY ai WHERE x.v=0 AND x.id=n.id)))
    FROM a o WHERE o.v=0 AND o.id IS NULL GROUP BY o.h, o.k`,
  // Attestations the later version adds that do not say when they were made. One that the earlier
  // version had without an address, and the later gives one, is not added.
  addedUndated: `SELECT n.id, n.about FROM a n WHERE n.v=1 AND n.k=0 AND n.c=0 AND
      CASE WHEN n.id IS NOT NULL THEN NOT EXISTS(SELECT 1 FROM a o INDEXED BY ai WHERE o.v=0 AND o.id=n.id)
             AND NOT EXISTS(SELECT 1 FROM a o INDEXED BY ah WHERE o.v=0 AND o.h=n.h AND o.id IS NULL)
           ELSE NOT EXISTS(SELECT 1 FROM a o INDEXED BY ah WHERE o.v=0 AND o.h=n.h) END`,
  // Things with addresses of their own: what the earlier version says of each that the later does
  // not; whether the later describes it at all; and whether an attestation points to it as a facet,
  // in the earlier version and in the later.
  described: `SELECT o.s, EXISTS(SELECT 1 FROM n x WHERE x.v=1 AND x.s=o.s), EXISTS(SELECT 1 FROM f WHERE f.v=0 AND f.s=o.s), EXISTS(SELECT 1 FROM f WHERE f.v=1 AND f.s=o.s)
    FROM n o WHERE o.v=0 AND NOT EXISTS(SELECT 1 FROM n x WHERE x.v=1 AND x.s=o.s AND x.h=o.h) GROUP BY o.s`,
  // Facets the earlier version describes, of which the later says something the earlier did not.
  // Facets the earlier version describes, of which the later says something the earlier did not,
  // and nothing less: one that also lost a statement has changed, which is reported as such.
  facetsAddedTo: `SELECT f.s FROM f WHERE f.v=0 AND EXISTS(SELECT 1 FROM n o WHERE o.v=0 AND o.s=f.s)
      AND EXISTS(SELECT 1 FROM n x WHERE x.v=1 AND x.s=f.s AND NOT EXISTS(SELECT 1 FROM n o WHERE o.v=0 AND o.s=x.s AND o.h=x.h))
      AND NOT EXISTS(SELECT 1 FROM n o WHERE o.v=0 AND o.s=f.s AND NOT EXISTS(SELECT 1 FROM n x WHERE x.v=1 AND x.s=o.s AND x.h=o.h))`,
  withAddress: 'SELECT 1 FROM a INDEXED BY ai WHERE v=0 AND id=? LIMIT 1',
  // Candidates the later copy of a candidate set has and the earlier does not: neither under its
  // address nor saying the same (one saying the same under another address is readdressed, which is
  // reported as such).
  addedCandidates: `SELECT n.id, n.about FROM a n WHERE n.v=1 AND n.k=2 AND
      NOT EXISTS(SELECT 1 FROM a o INDEXED BY ah WHERE o.v=0 AND o.h=n.h) AND
      (n.id IS NULL OR NOT EXISTS(SELECT 1 FROM a o INDEXED BY ai WHERE o.v=0 AND o.id=n.id))`,
};

// A statement as the report shows it: the well-known namespaces by their prefixes, and not so long
// that one citation fills the screen.
const PREFIXES = [[PLATO, 'plato:'], ['http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'rdf:'], ['http://www.w3.org/2000/01/rdf-schema#', 'rdfs:'], ['http://www.w3.org/2001/XMLSchema#', 'xsd:'],
  ['http://purl.org/dc/terms/', 'dcterms:'], ['http://www.w3.org/ns/prov#', 'prov:'], ['http://www.w3.org/2004/02/skos/core#', 'skos:'], ['http://purl.org/spar/cito/', 'cito:']];
const SHOWN = 600;
function plain(line) {
  let s = line;
  for (const [iri, prefix] of PREFIXES) s = s.replaceAll(`<${iri}`, '<' + prefix).replaceAll(iri, prefix);
  s = s.replace(/<((?:plato|rdf|rdfs|xsd|dcterms|prov|skos|cito):[^<>\s]*)>/g, '$1');
  return s.length > SHOWN ? s.slice(0, SHOWN) + ' …' : s;
}

/** The working database: one row per attestation or identity match, one per statement about a named thing. */
export class Ledger {
  constructor(db) {
    this.db = db;
    Ledger.tables(db);
    this.insItem = db.prepare('INSERT INTO a(v,k,id,about,h,c) VALUES (?,?,?,?,?,?)');
    this.insStatement = db.prepare('INSERT OR IGNORE INTO n(v,s,h) VALUES (?,?,?)');
    this.insFacet = db.prepare('INSERT OR IGNORE INTO f(v,s) VALUES (?,?)');
  }
  static tables(db) {
    // v: which version; k: attestation or identity match; id: its address, if it has one; about: the
    // place it is about; h: the digest of what it says; c: whether it says when it was made.
    db.exec('CREATE TABLE a(v INTEGER NOT NULL, k INTEGER NOT NULL, id TEXT, about TEXT, h TEXT NOT NULL, c INTEGER NOT NULL)');
    db.exec('CREATE TABLE n(v INTEGER NOT NULL, s TEXT NOT NULL, h TEXT NOT NULL, PRIMARY KEY(v, s, h)) WITHOUT ROWID');
    // The addresses each version's attestations point to as facets.
    db.exec('CREATE TABLE f(v INTEGER NOT NULL, s TEXT NOT NULL, PRIMARY KEY(v, s)) WITHOUT ROWID');
  }
  static indexes(db) {
    db.exec('CREATE INDEX ai ON a(v, id, h)');
    db.exec('CREATE INDEX ah ON a(v, h)');
  }
  /** What reader() writes one version to: a digest of each thing's statements, not the statements. */
  sink(v) {
    return {
      item: (kind, id, about, lines, created) => this.insItem.bind([v, kind, id, about, digest(lines.join('\n')), created ? 1 : 0]).stepReset(),
      statement: (s, line) => this.insStatement.bind([v, s, digest(line)]).stepReset(),
      facet: (s) => this.insFacet.bind([v, s]).stepReset(),
    };
  }
  /** No more rows: build the indexes the comparison reads by. */
  index() {
    this.insItem.finalize(); this.insStatement.finalize(); this.insFacet.finalize();
    Ledger.indexes(this.db);
  }
  *rows(sql, params = []) {
    const q = this.db.prepare(sql);
    try { if (params.length) q.bind(params); while (q.step()) yield q; } finally { q.finalize(); }
  }
  one(sql, params = []) { for (const q of this.rows(sql, params)) return q.get(0); return null; }
}

/**
 * What the pipeline writes one version's records to (its options.sink): each record becomes RDF
 * statements, and `out` is given each attestation and identity match with what it says
 * (out.item), each statement about anything else with an address (out.statement), and each address
 * an attestation points to as a facet (out.facet).
 */
function reader(context, out, side = { withdrawals: new Map() }) {
  let triples = [], doc = null;
  const j2r = new Json2Rdf(context, (s, p, o) => triples.push(s, p, o));
  const take = () => {
    // This record's statements, and only these: whatever happens below, none is left for the next.
    const batch = triples; triples = [];
    const by = new Map(), bundled = new Set(), docKey = doc && nodeKey(doc);
    for (let i = 0; i < batch.length; i += 3) {
      const k = nodeKey(batch[i]), p = batch[i + 1].value, o = batch[i + 2];
      // A place read with no label is given its address as a stand-in (pipeline.js), which is not a
      // statement of the data's, so it is not compared.
      if (p === RDFS_LABEL && o.termType === 'Literal' && o.value === batch[i].value) continue;
      // A dataset lists its candidate sets (gazetteer.candidateSets) by the reverse of
      // plato:candidates_for, so the statement is the set's, naming this version's own address: it
      // changes from version to version by design, like the rest of the dataset's description.
      if (p === CANDIDATES_FOR && docKey !== null && nodeKey(o) === docKey) continue;
      (by.get(k) || by.set(k, []).get(k)).push([p, o]);
      // An identity match an attestation bundles is part of what that attestation says.
      if (p === ATTESTS_IDENTITY && o.termType !== 'Literal') bundled.add(nodeKey(o));
    }
    // What a node says: its statements, sorted, with each node that has no address written out in
    // place, and each that has one named by it. Blank node labels, which differ from file to file,
    // never appear.
    const open = [];
    const term = (o) => {
      if (o.termType !== 'BlankNode') return termNT(o);
      const k = '_:' + o.value;
      if (open.includes(k)) return '_:loop';
      open.push(k);
      const text = '[' + said(k).join(' ; ') + ']';
      open.pop();
      return text;
    };
    const said = (k) => (by.get(k) || []).map(([p, o]) => p + ' ' + term(o)).sort();
    for (const [k, list] of by) {
      // The gazetteer's own description (its title, version, what it contains) changes from version
      // to version by design.
      if (k === docKey) continue;
      const about = list.find(([p]) => p === ABOUT), meta = list.find(([p]) => p === META_ABOUT);
      const subject = list.find(([p]) => p === IDENTITY_SUBJECT), source = list.find(([p]) => p === CANDIDATE_SOURCE);
      const kind = about || meta ? ATTESTATION : source ? CANDIDATE : subject && !bundled.has(k) ? IDENTITY : null;
      if (kind === null) {
        if (!isBlank(k)) for (const [p, o] of list) out.statement(k, p + ' ' + term(o));
        continue;
      }
      const of = nodeKey((about || meta || source || subject)[1]);
      open.push(k);
      out.item(kind, isBlank(k) ? null : k, isBlank(of) ? null : of, said(k), list.some(([p]) => p === CREATED));
      open.pop();
      if (kind === ATTESTATION) for (const [p, o] of list) if (o.termType === 'NamedNode' && isFacetLink(p)) out.facet(o.value);
    }
  };
  return {
    header(head) {
      // A dataset is described by its gazetteer, a candidate set by its candidateSet.
      side.kind = head && head.profile === 'candidate-set' ? 'candidate-set' : 'dataset';
      const own = head && (side.kind === 'candidate-set' ? head.candidateSet : head.gazetteer);
      side.gazetteer = (own && typeof own === 'object' && !Array.isArray(own) && own) || {};
      doc = j2r.header(head);
      take();
    },
    event(ev) {
      const atts = ev.type === 'attestation' ? [ev.value] : ev.type === 'record' && ev.value && Array.isArray(ev.value.attestations) ? ev.value.attestations : [];
      collectWithdrawn(atts, side.withdrawals);
      j2r.record(ev.type === 'idr' ? 'identityRelations' : ev.type === 'attestation' ? 'attestations' : ev.newEntity ? 'newSpatialEntities' : 'spatialEntities', ev.value);
      take();
    },
    // One candidate of a candidate set (the pipeline gives a sink with this method a candidate set).
    candidate(c) {
      j2r.record('candidates', c);
      take();
    },
    async close() {},
  };
}

/**
 * What each attestation says, as the version check compares it, for Agora's minting of attestation
 * addresses (agora/mint.js), which hashes it: a sink like reader()'s, which calls out(id, lines)
 * for every attestation of the records it is given, with its address (null for one without) and
 * its statements as reader() writes them, sorted.
 */
export function attestationLines(context, out) {
  return reader(context, { item: (kind, id, about, lines) => { if (kind === ATTESTATION) out(id, lines); }, statement: () => {}, facet: () => {} });
}

/**
 * Compare two versions of a dataset. `earlier` and `later` are inputs as detect() describes them.
 * Returns { report, outputs: [] }, the report in the shape run() gives, with `incomplete` set when a
 * version could not be read to the end, so that nothing was compared.
 */
export async function compare({ earlier, later, options = {} }, env) {
  const rep = new Report();
  const t0 = Date.now();
  const progress = env.progress || (() => {});
  const db = await env.openDb();
  try {
    const ledger = new Ledger(db);
    const sides = [];
    for (const [v, input, word] of [[EARLIER, earlier, 'earlier'], [LATER, later, 'later']]) {
      const side = { kind: null, gazetteer: {}, withdrawals: new Map() };
      db.exec('BEGIN');
      const r = await run({ input, action: 'check', options: { ...options, sink: reader(env.resources.context, ledger.sink(v), side) } },
        { ...env, progress: (p) => progress({ ...p, version: word, phase: p.phase === 'done' ? 'read' : p.phase }) });
      db.exec('COMMIT');
      if (r.incomplete) {
        rep.error('unreadable', `The ${word} version could not be read to the end, so the two versions were not compared`, r.report.items.find((i) => i.kind === 'unreadable')?.examples[0]);
        return { report: rep.toJSON(), outputs: [], incomplete: true };
      }
      let others = 0;
      for (const i of r.report.items) {
        // A key PLATO does not define, a name where RDF needs an address: no statement is made of it.
        if (NOT_IN_RDF.has(i.kind)) { rep.add('warning', 'not-compared', `The ${word} version ${TEXT['not-compared']}: ${i.message}`, i.examples[0], i.count); continue; }
        if (i.severity !== 'error') continue;
        if (NOT_READ.has(i.kind)) rep.add('error', 'version-not-read', `Part of the ${word} version could not be read, so the comparison is not of the whole of it: ${i.message}`, i.examples[0], i.count);
        else others += i.count;
      }
      if (others) rep.add('warning', 'version-has-problems', `The ${word} version has problems of its own, which a comparison does not list. Check it by itself to see them.`, undefined, others);
      sides.push(side);
    }
    const [old, neu] = sides.map((s) => s.gazetteer);
    // Two versions of one thing: a dataset and a candidate set are not, nor two candidate sets.
    const refuse = (kind, example) => { rep.error(kind, TEXT[kind], example); return { report: rep.toJSON(), outputs: [], incomplete: true }; };
    if (sides[EARLIER].kind !== sides[LATER].kind) return refuse('different-kinds', `the earlier version is a ${sides[EARLIER].kind === 'candidate-set' ? 'candidate set' : 'dataset'}, the later a ${sides[LATER].kind === 'candidate-set' ? 'candidate set' : 'dataset'}`);
    const isSet = sides[EARLIER].kind === 'candidate-set';
    if (isSet && old['@id'] !== neu['@id']) return refuse('different-candidate-set', `${old['@id'] ?? 'no @id'} and ${neu['@id'] ?? 'no @id'}`);
    progress({ phase: 'comparing', elapsedMs: Date.now() - t0 });
    ledger.index();
    db.exec('BEGIN');
    // What the comparison is of: a dataset's attestations, or a candidate set's candidates.
    const OF = isSet ? CANDIDATE : ATTESTATION;

    // The rule binds from publication. Before it, what would break it is worth knowing, not wrong.
    // A candidate set has no status: it is published when it is issued, and frozen from then on.
    const published = isSet || old.status === 'published';
    const breach = published ? 'error' : 'warning';
    if (isSet) {
      // Frozen as a whole: its date of issue and its dataset with its candidates. Its description
      // (title, description, creator, licence) may be corrected, and a correction is reported.
      if (old.issued !== neu.issued) rep.error('candidate-set-issued-changed', TEXT['candidate-set-issued-changed'], `${old.issued ?? 'none'}, then ${neu.issued ?? 'none'}`);
      if (old.candidatesFor !== neu.candidatesFor) rep.error('candidate-set-for-changed', TEXT['candidate-set-for-changed'], `${old.candidatesFor ?? 'none'}, then ${neu.candidatesFor ?? 'none'}`);
      const described = ['title', 'description', 'creator', 'licence'].filter((k) => jcs(old[k] ?? null) !== jcs(neu[k] ?? null));
      if (described.length) rep.warning('candidate-set-described-changed', TEXT['candidate-set-described-changed'], described.join(', '));
    } else if (!published) rep.warning('earlier-not-published', TEXT['earlier-not-published'], old.status === undefined ? undefined : String(old.status));
    else if (neu.status !== 'published') rep.warning('later-not-published', TEXT['later-not-published'], neu.status === undefined ? undefined : String(neu.status));
    // A dataset's list of its candidate sets is its description of itself: a set added to it is
    // news, not a breach; one gone from it is reported, as a place no longer described is.
    if (!isSet) {
      const listed = (g) => (Array.isArray(g.candidateSets) ? g.candidateSets : []).filter((x) => typeof x === 'string');
      const now = new Set(listed(neu));
      for (const set of listed(old)) if (!now.has(set)) rep.warning('candidate-set-unlisted', TEXT['candidate-set-unlisted'], set);
    }
    if (typeof neu.previousVersion === 'string' && typeof old['@id'] === 'string' && neu.previousVersion !== old['@id']) rep.warning('previous-version-differs', TEXT['previous-version-differs'], `${neu.previousVersion}, not ${old['@id']}`);
    if (typeof old.isVersionOf === 'string' && typeof neu.isVersionOf === 'string' && old.isVersionOf !== neu.isVersionOf) rep.warning('different-gazetteer', TEXT['different-gazetteer'], `${old.isVersionOf} and ${neu.isVersionOf}`);
    if (old.version !== undefined && old.version !== null && old.version === neu.version) rep.warning('same-version', TEXT['same-version'], String(old.version));

    const count = (v, k = OF) => ledger.one('SELECT COUNT(*) FROM a WHERE v=? AND k=?', [v, k]);
    const had = count(EARLIER), has = count(LATER);
    if (!had) rep.error(isSet ? 'nothing-to-compare-candidates' : 'nothing-to-compare', TEXT[isSet ? 'nothing-to-compare-candidates' : 'nothing-to-compare']);
    let lost = 0, changed = 0;
    // The first few changed things of each kind, to be looked at again for what changed in them.
    const toExplain = new Map();
    const explainLater = (name, address) => { const l = toExplain.get(name) || toExplain.set(name, []).get(name); if (l.length < EXPLAINED) l.push(address); };
    const found = (kind, what, example, n = 1) => {
      const name = `${KIND_NAMES[kind]}-${what}`;
      rep.add(kind === IDENTITY ? 'warning' : breach, name, TEXT[name], example, n);
      if (kind === OF) { if (what === 'changed') changed += n; else lost += n; }
      if (what === 'changed') explainLater(name, example);
    };
    // Those with an address: each must be in the later version under it, saying what it said and
    // nothing else. An address the earlier version uses twice is reported once.
    let last = null;
    for (const q of ledger.rows(QUERIES.addressed)) {
      if (q.get(1) === last) continue;
      if (!q.get(2) && q.get(5) && q.get(0) !== IDENTITY) { const name = `${KIND_NAMES[q.get(0)]}-readdressed`; rep.add(breach, name, TEXT[name], (last = q.get(1))); if (q.get(0) === OF) changed++; }
      else if (!q.get(2)) found(q.get(0), 'removed', (last = q.get(1)));
      else if (!q.get(3) || q.get(4)) found(q.get(0), 'changed', (last = q.get(1)));
    }
    // Those without: as many saying the same must be in the later version, not counting those that
    // are there under an address the earlier version already had (they are accounted for above).
    for (const q of ledger.rows(QUERIES.unaddressed)) {
      const missing = q.get(1) - q.get(3);
      if (missing > 0) found(q.get(0), 'gone', q.get(2) ?? undefined, missing);
    }
    // A candidate set is frozen as a whole: a candidate added is a breach, named by its address.
    if (isSet) for (const q of ledger.rows(QUERIES.addedCandidates)) {
      rep.error('candidate-added', TEXT['candidate-added'], q.get(0) ?? (q.get(1) ? `a candidate for ${q.get(1)}` : undefined));
    }
    const unidentified = ledger.one('SELECT COUNT(*) FROM a WHERE v=0 AND k=0 AND id IS NULL');
    if (unidentified) rep.add('warning', 'earlier-unidentified', TEXT['earlier-unidentified'], undefined, unidentified);

    // What the later version adds: each should say when it was made.
    for (const q of ledger.rows(QUERIES.addedUndated)) {
      rep.warning('added-without-created', TEXT['added-without-created'], q.get(0) ?? (q.get(1) ? `an attestation about ${q.get(1)}` : undefined));
    }
    // And what it withdraws or replaces of the earlier version, the way the rule asks.
    // Only what was still current in the earlier version counts: a retraction it already held is not news.
    let retracted = 0, superseded = 0;
    const before = resolveWithdrawn(sides[EARLIER].withdrawals).status;
    for (const [target, kind] of resolveWithdrawn(sides[LATER].withdrawals).status) {
      if (before.has(target) || ledger.one(QUERIES.withAddress, [target]) === null) continue;
      if (kind === 'retracted') retracted++; else superseded++;
    }

    // Things with addresses of their own. One an earlier attestation points to as a facet is part of
    // what that attestation says; a place or a source may be corrected.
    for (const q of ledger.rows(QUERIES.described)) {
      // A facet no attestation of the later version points to went with the attestations that did,
      // whose deletion or change is reported already: reported again, one deletion would count twice.
      if (q.get(2) && !q.get(1) && !q.get(3)) continue;
      const kind = `${q.get(2) ? 'facet' : 'description'}-${q.get(1) ? 'changed' : 'removed'}`;
      rep.add(q.get(2) ? breach : 'warning', kind, TEXT[kind], q.get(0));
      if (q.get(1)) explainLater(kind, q.get(0));
    }
    for (const q of ledger.rows(QUERIES.facetsAddedTo)) { rep.warning('facet-added-to', TEXT['facet-added-to'], q.get(0)); explainLater('facet-added-to', q.get(0)); }
    db.exec('COMMIT');

    // What changed, for the examples: both versions are read again, keeping the statements of those
    // few things only, and each is shown with what one version says of it and the other does not.
    if (toExplain.size) {
      const wanted = new Set([...toExplain.values()].flat());
      const says = [new Map(), new Map()];
      for (const [v, input, word] of [[EARLIER, earlier, 'earlier'], [LATER, later, 'later']]) {
        const keep = (address, lines) => { if (!wanted.has(address)) return; const s = says[v].get(address) || says[v].set(address, new Set()).get(address); for (const l of lines) s.add(l); };
        await run({ input, action: 'check', options: { ...options, sink: reader(env.resources.context, { item: (kind, id, about, lines) => keep(id, lines), statement: (s, line) => keep(s, [line]), facet: () => {} }) } },
          { ...env, progress: (p) => progress({ ...p, version: word, again: true, phase: p.phase === 'done' ? 'read' : p.phase }) });
      }
      for (const [kind, addresses] of toExplain) for (const address of addresses) {
        const was = says[EARLIER].get(address) || new Set(), is = says[LATER].get(address) || new Set();
        rep.explain(kind, address, [...was].filter((l) => !is.has(l)).sort().map(plain), [...is].filter((l) => !was.has(l)).sort().map(plain));
      }
    }

    rep.counts = { ...(isSet ? { of: 'candidates' } : {}), earlier: had, later: has, unchanged: Math.max(0, had - lost - changed), changed, lost, added: Math.max(0, has - (had - lost)), retracted, superseded };
    progress({ phase: 'done', elapsedMs: Date.now() - t0 });
    return { report: rep.toJSON(), outputs: [], versions: { earlier: old, later: neu } };
  } finally {
    try { db.close(); } catch { /* closed already */ }
  }
}
