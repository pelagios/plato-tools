// Agora, part 'mint': a copy of the dataset in which every attestation has a permanent web address
// (@id), so that it can be cited, and retracted or replaced by a later one (plato:Retracts,
// plato:Supersedes), which can only point at something with an address. The copy is PLATO JSON
// Lines, place-centric, as the converter writes it: a header line, then one place per line.
//
// An address is a fragment of its place's: <place>#a-<hash>, where the hash is of what the
// attestation SAYS (address.js; the maintainer's decision D2). So the same data minted twice, from
// the same spreadsheet tables or with its rows in another order, gives the same addresses, which is
// the point: tables have no column for an attestation's address, and a dataset kept as tables is
// minted afresh for every release.
//
// Rules, in the order they apply to each attestation:
//   1. An address it has is never changed (not even one this part would not have made).
//   2. The address the previous release gave an attestation saying exactly the same, of the same
//      place, is inherited: an address made by other means, or before the dataset changed, lasts.
//   3. Otherwise it is minted from the hash. Attestations of one place that say exactly the same
//      (twins) are told apart by a counter in file order: the first has the bare hash, the next -2,
//      then -3. Two that say different things but whose hashes begin alike (8 hex digits: about one
//      pair in four thousand million within one place) both get 12 digits, or 16, until they differ,
//      whatever order they come in. An address already in use in the dataset is never given again:
//      the next counter is taken.
//
// THE HASH, version 1 (the 'a-' prefix). Addresses must be reproducible for ever, so exactly:
//   text = <place IRI> + "\n" + the attestation's lines joined by "\n"
//   hash = the first 8 (or 12, 16 …) hex digits, lower case, of SHA-256 of text as UTF-8.
// The lines are what the version check compares (attestationLines in compare.js): the attestation
// is turned into RDF with PLATO's JSON-LD context (Json2Rdf), and each of its own statements is one
// line, "<predicate IRI, bare> <object as N-Triples>", where an object with no address of its own (a
// name, a date, a citation) is written out in place as "[" + its own lines, sorted, joined by " ; "
// + "]", and one met again inside itself as "_:loop". The lines are sorted by UTF-16 code unit
// (JavaScript's sort()). The attestation's own address is not in them, and no blank node label
// ever is. A different form would be a new version, with a new prefix, and the addresses already
// minted would stay as they are (rule 1). If the form changed by accident (a change to the context
// or to Json2Rdf), inheritance would miss, new addresses would be minted, and the version check
// against the previous release would refuse: the change cannot pass unnoticed.
//
// What minting cannot change: an attestation's lines never name another attestation that has no
// address, because PLATO JSON can point at an attestation only by its address (a meta-attestation's
// targetAttestation is an IRI). So giving one attestation an address changes what no other says,
// and the order in which attestations are minted does not matter: a retraction points at an
// attestation that has an address already, which is kept, and the retraction's own hash includes it.
//
// With a previous release, the dataset with its addresses is compared with it by the version check
// before anything is written (E1): if the check finds the append-only rule broken (a published
// attestation deleted or changed), nothing is written, and the report says to withdraw what should
// go (plato:Retracts or plato:Supersedes) rather than delete it.
//
// At any size: nothing is held in memory but one record and the attestations of one place. The
// records, the digest of what each attestation says and the previous release's addresses all go into
// a working database; the addresses are given place by place from it, and the copy is written from
// it, so the dataset is read only once (and the previous release twice: once for its addresses, once
// by the version check, which reads the copy from the database too). The working database holds
// about as much as the copy written.
import { compare, attestationLines } from '../compare.js';
import { sha256 } from '../../lib/sha256.js';

export const TEXT = {
  'place-outside-base': "An attestation is about a place whose web address is not under the dataset's base address (<base>place/<id>), so it cannot be given an address as a part of its place's, and is left without one. Give the place an address under the base, or give the base its places are under. The example names the place.",
  'previous-not-read': 'The previous release could not be read to the end, so the addresses it gave could not be kept, and nothing was written.',
  'against-previous': 'Compared with the previous release (the earlier version), the dataset with its addresses (the later one): ',
};

// A stand-in address for an attestation without one while it is turned into RDF, so that what it
// says can be matched back to it. Its own address is not among its lines, so it changes nothing.
const TEMP = 'urn:x-plato-tools-mint:';
// How many hex digits a hash starts with, and how many more each time two differ too late.
const FIRST = 8, MORE = 4, WHOLE = 64;
// How an attestation got its address (att.how).
const INHERITED = 1, MINTED = 2;
const hasId = (a) => a && typeof a === 'object' && typeof a['@id'] === 'string' && a['@id'] !== '';
const n = (x) => x.toLocaleString('en-GB');

/** The name of the copy: the dataset's own name without its extension, then -with-ids.jsonl. */
export const outputName = (name) => String(name || 'dataset').replace(/\/+$/, '').replace(/\.gz$/i, '').replace(/\.[^./]+$/, '') + '-with-ids.jsonl';

/**
 * The working database. rec: each record (a place or an identity relation) as read, in file order.
 * att: each attestation of a place, by record and position: its place, the digest of what it says,
 * the address it has, and the one it is given. ids: every address in use, so none is given twice.
 * prev: the previous release's addresses, by place and digest, numbered in file order.
 */
function tables(db) {
  db.exec(`CREATE TABLE rec(r INTEGER PRIMARY KEY, line TEXT NOT NULL);
    CREATE TABLE att(r INTEGER NOT NULL, i INTEGER NOT NULL, place TEXT, d TEXT NOT NULL, id TEXT, given TEXT, how INTEGER, PRIMARY KEY(r, i)) WITHOUT ROWID;
    CREATE TABLE ids(id TEXT PRIMARY KEY) WITHOUT ROWID;
    CREATE TABLE prev(place TEXT NOT NULL, d TEXT NOT NULL, n INTEGER NOT NULL, id TEXT NOT NULL, PRIMARY KEY(place, d, n)) WITHOUT ROWID;`);
}

/**
 * A sink for run() that hands `each(record, digests, ev)` every place with the digest of what each
 * of its attestations says (by position; null where one could not be read), and `other(ev)`
 * everything else. Exported for the tests, which hash by hand to see the form above kept.
 */
export function digester(context, hash, each, other = () => {}) {
  let found = null;
  const lines = attestationLines(context, (id, ls) => { if (found) found.set(id, ls); });
  return {
    header(head) { lines.header(head); },
    event(ev) {
      const rec = ev.type === 'record' ? ev.value : null;
      if (!rec || !Array.isArray(rec.attestations)) { other(ev); return; }
      const place = typeof rec['@id'] === 'string' ? rec['@id'] : '';
      const shown = rec.attestations.map((a, i) => (a && typeof a === 'object' && !hasId(a) ? { ...a, '@id': TEMP + i } : a));
      found = new Map();
      lines.event({ ...ev, value: { ...rec, attestations: shown } });
      const digests = shown.map((a) => {
        const ls = a && typeof a === 'object' ? found.get(a['@id']) : null;
        return ls ? hash(place + '\n' + ls.join('\n')) : null;
      });
      found = null;
      each(rec, digests, ev);
    },
    async close() {},
  };
}

export function create(ctx) {
  const { rep, options } = ctx;
  const hash = options.hash || sha256;   // the tests put a hash that collides here
  const name = () => outputName(options.name || ctx.input.files[0].name);
  let db = null, ins = null, recs = 0, header = null;
  const counts = { minted: 0, kept: 0, inherited: 0, twins: 0, lengthened: 0, outside: 0 };

  /** The copy, line by line: the header, then each record with the addresses given. */
  function* copy() {
    yield JSON.stringify({ $schema: 'https://w3id.org/plato/schemas/place-centric.schema.json', ...header, profile: 'place-centric' }) + '\n';
    const q = db.prepare('SELECT r, line FROM rec ORDER BY r');
    const a = db.prepare('SELECT i, given FROM att WHERE r=? AND id IS NULL AND given IS NOT NULL ORDER BY i');
    try {
      while (q.step()) {
        const line = q.get(1);
        let rec = null;
        a.bind([q.get(0)]);
        while (a.step()) {
          rec ||= JSON.parse(line);
          const i = a.get(0);
          // The address first, where a reader looks for it; the rest as it was.
          rec.attestations[i] = { '@id': a.get(1), ...rec.attestations[i] };
        }
        a.reset();
        yield (rec ? JSON.stringify(rec) : line) + '\n';
      }
    } finally { q.finalize(); a.finalize(); }
  }

  /** The copy as a file the version check can read, made from the working database as it is read. */
  function copyFile() {
    const enc = new TextEncoder();
    return {
      name: name(),
      // Only the first two bytes are sliced, to see whether the file is compressed: it is not.
      slice: () => new Blob([]),
      stream() {
        const it = copy();
        return new ReadableStream({
          pull(c) {
            let s = '';
            while (s.length < 1 << 16) { const x = it.next(); if (x.done) break; s += x.value; }
            if (s) c.enqueue(enc.encode(s)); else c.close();
          },
          cancel() { it.return(); },
        });
      },
    };
  }

  /** Give every attestation without an address one, place by place (the rules above). */
  function assign() {
    db.exec('CREATE INDEX att_place ON att(place, r, i)');
    const upd = db.prepare('UPDATE att SET given=?, how=? WHERE r=? AND i=?');
    const use = db.prepare('INSERT OR IGNORE INTO ids(id) VALUES (?)');
    const taken = db.prepare('SELECT 1 FROM ids WHERE id=?');
    const prev = db.prepare('SELECT id FROM prev WHERE place=? AND d=? ORDER BY n');
    const q = db.prepare('SELECT r, i, place, d, id FROM att ORDER BY place, r, i');
    const isTaken = (id) => { taken.bind([id]); const t = taken.step(); taken.reset(); return t; };
    const give = (g, id, how) => { upd.bind([id, how, g.r, g.i]).stepReset(); use.bind([id]).stepReset(); g.given = id; };
    const place = (group) => {
      const at = group[0].place;
      // One whose statements could not be made (the check reports why) has nothing to hash.
      const open = group.filter((g) => !g.id && g.d);
      // Rule 2: the previous release's address for what is said the same, each given once.
      for (const g of open) {
        prev.bind([at, g.d]);
        while (prev.step()) { const id = prev.get(0); if (!isTaken(id)) { give(g, id, INHERITED); counts.inherited++; break; } }
        prev.reset();
      }
      const rest = open.filter((g) => !g.given);
      if (!rest.length) return;
      if (!at || !ctx.scheme.placeKey(at)) {
        counts.outside += rest.length;
        rep.add('error', 'place-outside-base', TEXT['place-outside-base'], at || '(a place with no address)', rest.length);
        return;
      }
      // Rule 3: as many digits as it takes to tell this digest from every other of the place's.
      const digests = [...new Set(group.map((g) => g.d).filter(Boolean))];
      for (const g of rest) {
        let len = FIRST;
        while (len < WHOLE && digests.some((d) => d !== g.d && d.slice(0, len) === g.d.slice(0, len))) len += MORE;
        if (len > FIRST) counts.lengthened++;
        const bare = ctx.scheme.attestation(at, g.d.slice(0, len));
        let id = bare, k = 1;
        while (isTaken(id)) id = `${bare}-${++k}`;
        if (k > 1) counts.twins++;
        give(g, id, MINTED);
        counts.minted++;
      }
    };
    db.exec('BEGIN');
    try {
      let group = [];
      while (q.step()) {
        const row = { r: q.get(0), i: q.get(1), place: q.get(2), d: q.get(3), id: q.get(4) };
        if (group.length && row.place !== group[0].place) { place(group); group = []; }
        group.push(row);
      }
      if (group.length) place(group);
    } finally { for (const s of [upd, use, taken, prev, q]) s.finalize(); db.exec('COMMIT'); }
  }

  /** The version check between the previous release and the copy. True if the copy may be written. */
  async function gate() {
    const later = { format: 'plato-jsonl', profile: 'place-centric', files: [copyFile()] };
    const r = await compare({ earlier: ctx.previous, later, options: { base: options.base } }, ctx.env);
    for (const i of r.report.items) {
      const message = TEXT['against-previous'] + i.message;
      rep.add(i.severity, i.kind, message, i.examples[0], i.count);
      for (const e of i.examples.slice(1)) rep.add(i.severity, i.kind, message, e, 0);
      for (const x of i.explained || []) rep.explain(i.kind, x.example, x.earlier, x.later);
    }
    rep.counts.previous = r.report.counts;
    return !r.incomplete && r.report.errors === 0;
  }

  return {
    async prepare() {
      db = await ctx.env.openDb();
      tables(db);
      if (!ctx.previous) return;
      // The addresses the previous release gave, by place and by what each attestation says. Twins
      // there are numbered in file order, so that they are inherited in the same order.
      const put = db.prepare('INSERT OR IGNORE INTO prev(place, d, n, id) VALUES (?,?,?,?)');
      let k = 0;
      db.exec('BEGIN');
      const r = await ctx.read(digester(ctx.env.resources.context, hash, (rec, digests) => {
        if (typeof rec['@id'] !== 'string') return;
        rec.attestations.forEach((a, i) => { if (hasId(a) && digests[i]) put.bind([rec['@id'], digests[i], ++k, a['@id']]).stepReset(); });
      }), ctx.previous);
      put.finalize();
      db.exec('COMMIT');
      if (r.incomplete) {
        rep.error('previous-not-read', TEXT['previous-not-read'], r.report.items.find((x) => x.kind === 'unreadable')?.examples[0]);
        db.close();
        return { incomplete: true };
      }
    },
    header(head) {
      header = head;
      // Without a base nothing can be minted; finish() says so (ctx.blocked()).
      if (!ctx.scheme) return;
      ins = {
        rec: db.prepare('INSERT INTO rec(r, line) VALUES (?,?)'),
        att: db.prepare('INSERT INTO att(r, i, place, d, id) VALUES (?,?,?,?,?)'),
        id: db.prepare('INSERT OR IGNORE INTO ids(id) VALUES (?)'),
      };
      ins.sink = digester(ctx.env.resources.context, hash, (rec, digests, ev) => {
        const r = ++recs;
        ins.rec.bind([r, JSON.stringify(ev.value)]).stepReset();
        const at = typeof rec['@id'] === 'string' ? rec['@id'] : null;
        rec.attestations.forEach((a, i) => {
          // One that is not an object is the check's to report; it cannot be given an address.
          if (!a || typeof a !== 'object') return;
          const id = hasId(a) ? a['@id'] : null;
          if (id) { ins.id.bind([id]).stepReset(); counts.kept++; }
          ins.att.bind([r, i, at, digests[i] || '', id]).stepReset();
        });
      }, (ev) => {
        // An attestation-centric document's attestations never come this way: they are regrouped
        // by place before they are handed over (pipeline.js).
        if (ev.type === 'attestation') return;
        ins.rec.bind([++recs, JSON.stringify(ev.value)]).stepReset();
      });
      db.exec('BEGIN');
      ins.sink.header(head);
    },
    event(ev) { if (ins) ins.sink.event(ev); },
    async close() {
      if (!ins) return;
      for (const k of ['rec', 'att', 'id']) ins[k].finalize();
      db.exec('COMMIT');
    },
    async finish() {
      try {
        if (ctx.blocked()) return;
        assign();
        Object.assign(rep.counts, counts);
        const gave = counts.minted + counts.inherited;
        const said = `Gave ${n(gave)} attestation${gave === 1 ? '' : 's'} addresses; ${n(counts.kept)} already had them; ${n(counts.inherited)} kept from the previous release.`;
        if (ctx.previous && !(await gate())) {
          rep.counts.said = [said, 'Nothing was written: with these addresses, the dataset would break the append-only rule against the previous release. Withdraw what should go (plato:Retracts or plato:Supersedes); do not delete it.'];
          return;
        }
        rep.counts.said = [said];
        const out = await ctx.env.output(name());
        for (const s of copy()) out.write(s);
        ctx.done(await out.close());
      } finally {
        try { db.close(); } catch { /* closed already */ }
      }
    },
  };
}
