// Agora's address scheme: the one place that says where everything a published dataset holds lives,
// on the web and in the site that serves it. The FAIR report, the minting of attestation addresses,
// the site and the w3id rules all ask this module, so the addresses in the data, the files on the
// site and the redirects cannot drift apart.
//
// Under the dataset's base address (its uriSpace, the about sheet's base_uri), always ending in '/':
//   <base>                      the dataset itself, and its landing page
//   <base>place/<id>            a place            site: place/<id>/index.html, place/<id>.jsonld, place/<id>.ttl
//   <base>source/<id>           a source           site: source/<id>/index.html, source/<id>.jsonld, source/<id>.ttl
//   <base>place/<id>#a-<hash>   an attestation     on its place's page (a fragment needs no file or rule)
//   <base>release/<name>        a frozen release   its files: <base>release/<name>/<file>
//   <base>download/<file>       the latest dataset as downloads
// This is how PLATO tools makes addresses from spreadsheet tables (tableIds in formats/tables.js),
// which PLATO makes normative.

export const PARTS = { place: 'place', source: 'source', release: 'release', download: 'download' };

// The files at the site's root, which the w3id rules send the dataset's own address to, by format.
// The downloads are the latest dataset whole, in download/ (their names end in these suffixes, after
// the dataset's short name).
export const SITE = {
  landing: 'index.html',            // the dataset's landing page, for people
  description: 'index.jsonld',      // the dataset's description (the gazetteer header), for machines
  descriptionTtl: 'index.ttl',      // the same in Turtle, when the site has Turtle
  notFound: '404.html',
  downloads: { jsonl: '.jsonl.gz', ntriples: '.nt.gz', tables: '-tables.zip' },
};

// What a path segment may be for a site on GitHub Pages: characters that need no encoding in a URL
// or a file name on any system. Anything else (a space, '/', '%', a non-Latin letter) is encoded one
// way in the address and another by the server or the unzip, so a page would not be found.
const SAFE = /^[A-Za-z0-9._~-]+$/;
// Release names: the same, and not starting with '.', which a server may hide.
const SAFE_RELEASE = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;

// An id as the last part of an address, as PLATO says: every character other than RFC 3986's
// unreserved ones (letters, digits, - . _ ~) percent-encoded as UTF-8. encodeURIComponent leaves
// ! ' ( ) * as they are, which the tables' own URI templates (RFC 6570) encode. Here, and not in
// formats/tables.js (which imports it, and still exports it), so that the scheme and the tables
// encode one way: they once differed on those five characters, and a place's address did not match.
export const encodeId = (id) => encodeURIComponent(id).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// A GitHub repository, OWNER/NAME: the owner a user or organisation name, the name letters, digits
// and . _ -. The site's workflow and the w3id rules both take one, and must refuse the same.
export const REPO = /^([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})$/;

/** A DOI as given (bare, doi:…, or its https://doi.org/ address) -> the bare DOI. */
export const doiOf = (d) => String(d).trim().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:)/i, '');
// What a bare DOI is: the directory 10, a registrant's prefix of digits, '/', and a suffix without
// spaces. Anything else put into the deposit files or the landing page would name nothing.
const DOI = /^10\.\d{4,9}\/\S+$/;
/** Whether a DOI, as given, is one once doiOf() has made it bare. */
export const doiOk = (d) => DOI.test(doiOf(d));

/**
 * Why there is no base address to publish under: 'base-is-fragment' for one that ends in '#' (PLATO
 * allows it for spreadsheet tables, but every place would then be a fragment of one document, which
 * a static site cannot serve as pages of their own nor w3id redirect one by one: a server never sees
 * what follows '#'), otherwise 'no-base'. Asked only when scheme() gave null.
 */
export function noBaseKind(base) {
  return typeof base === 'string' && base.endsWith('#') && normaliseBase(base.slice(0, -1)) ? 'base-is-fragment' : 'no-base';
}

/** A base address as the scheme uses it: with its closing '/'. Null for one that is not an http(s) URL. */
export function normaliseBase(base) {
  if (typeof base !== 'string' || !/^https?:\/\/[^/?#\s]+(\/[^?#\s]*)?$/.test(base)) return null;
  return base.endsWith('/') ? base : base + '/';
}

// What kind of host a base address is on decides how long its addresses can be trusted to last.
const EXAMPLE_HOSTS = /(^|\.)(example\.(org|com|net)|whgazetteer\.org)$/;
/**
 * The kind of a base address:
 *  'w3id'      https://w3id.org/<name>/…, a permanent redirect service: its rules are generated here;
 *  'github.io' a GitHub Pages address, which changes with the repository's owner or name;
 *  'local'     localhost or a private address: not reachable by anyone else;
 *  'example'   a stand-in (example.org, or PLATO's examples under whgazetteer.org/example/);
 *  'custom'    any other domain: as permanent as its owner keeps it.
 */
export function baseKind(base) {
  const b = normaliseBase(base);
  if (!b) return 'none';
  const u = new URL(b);
  const host = u.hostname.toLowerCase();
  if (host === 'w3id.org' && u.pathname.length > 1) return 'w3id';
  if (host.endsWith('.github.io') || host === 'github.io') return 'github.io';
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/.test(host)) return 'local';
  if (EXAMPLE_HOSTS.test(host) && (host !== 'whgazetteer.org' || u.pathname.startsWith('/example/'))) return 'example';
  return 'custom';
}

/**
 * The scheme for one dataset. `base` is its uriSpace (or the base given for this run). Returns null
 * when there is no usable base; the report says why.
 */
export function scheme(base) {
  const b = normaliseBase(base);
  if (!b) return null;
  const kind = baseKind(b);
  const u = new URL(b);
  const sc = {
    base: b,
    kind,
    // For a w3id base, the path under w3id.org without its slashes at either end: the folder
    // ids/<w3idPath>/ holds the rules for the top name, and a deeper path is a sub-namespace in it.
    w3idPath: kind === 'w3id' ? u.pathname.replace(/^\/|\/$/g, '') : null,
    host: u.host,
    // The dataset's short name, for the names of its downloads: the last part of the base's path
    // (whg-epns for https://w3id.org/whg-epns/), or its host without dots when it has no path.
    stem: u.pathname.split('/').filter(Boolean).pop() || u.hostname.replace(/\./g, '-'),
    /** The dataset's own address: the base itself. */
    dataset: b,
    place: (id) => b + 'place/' + encodeId(id),
    source: (id) => b + 'source/' + encodeId(id),
    release: (name) => b + 'release/' + name,
    download: (file) => b + 'download/' + file,
    /**
     * The last part of a place's or source's address, as written in it: the key the site's files and
     * the w3id rules are named by. Null if the address is not one they can serve (servable says why).
     */
    placeKey: (iri) => servable(sc, 'place', iri).key ?? null,
    sourceKey: (iri) => servable(sc, 'source', iri).key ?? null,
    /** The address of an attestation of a place: a fragment of the place's address. */
    attestation: (placeIri, hash) => placeIri.split('#')[0] + '#a-' + hash,
    /** Where the site keeps a place's or source's files; the key is the last part of its address, as placeKey gives it. */
    files: (part, key) => ({ html: `${part}/${key}/index.html`, jsonld: `${part}/${key}.jsonld`, ttl: `${part}/${key}.ttl`, dir: `${part}/${key}/` }),
  };
  return sc;
}

/**
 * Why a key (the last part of an address) cannot be served from a static site, or null if it can.
 * Case matters too: two keys that differ only in case are one file on macOS and Windows, which
 * sameCase() finds across a whole dataset.
 */
export function keyProblem(key) {
  if (!key) return 'is empty';
  if (!SAFE.test(key)) return 'has characters other than letters, digits and . _ ~ - (it would be encoded differently by the address and by the file system)';
  if (key === '.' || key === '..') return 'is . or .., which a file system reads as a folder';
  if (key.startsWith('.')) return "starts with '.', which web servers may hide";
  return null;
}
export const releaseProblem = (name) => (typeof name !== 'string' || !SAFE_RELEASE.test(name) ? "a release name must be letters, digits and . _ ~ -, not starting with '.'" : null);

/**
 * Keys that are the same but for case, found as keys are added: add() returns the key it collides
 * with, or null. Holds one lower-cased string per key, which is small beside a site's files.
 */
export function caseGuard() {
  const seen = new Map();
  return {
    add(part, key) {
      const k = part + '/' + key.toLowerCase();
      const had = seen.get(k);
      if (had === undefined) { seen.set(k, key); return null; }
      return had === key ? null : had;
    },
  };
}

// ---- which addresses the site and the w3id rules can serve -----------------------------------------
//
// One rule, asked by the FAIR report, the site and the w3id rules alike, so that the three sort every
// address the same way: they once did it three ways, and an address one of them served another
// refused (Round 5).

// The suffixes that name one representation of a place or source (<part>/<key>.jsonld, .ttl, and the
// page). A key that itself ends in one is read by the w3id rules as another key's file in that format,
// and on the site its files would stand beside that key's (place/london.html/ by place/london.html.jsonld).
export const SUFFIXES = ['jsonld', 'ttl', 'html'];
const SUFFIX = new RegExp(`\\.(${SUFFIXES.join('|')})$`, 'i');
export const SUFFIX_PROBLEM = `ends in .${SUFFIXES.join(', .')}, which the w3id rules read as a request for another address's file in that format`;

/**
 * Whether a place's or source's address (`part` 'place' or 'source') can be served by the site and
 * the w3id rules of the scheme `sc`: { key } if it can, the last part of the address as written in it
 * (so still encoded, and without any '#' fragment, which a server never sees); otherwise
 * { problem, why }, the problem one of
 *   'outside'    not under the base at all: another dataset's, or a mistake;
 *   'elsewhere'  under the base but not under <base><part>/ (DEEP's places, a volume/12, an agent/…):
 *                the rules have no pattern for it and the site no folder, so it is served nowhere
 *                (decision A1: site and w3id serve place/<id> and source/<id> only);
 *   'key'        under <base><part>/, but what follows cannot be one file's name: it has more than one
 *                part, or characters a URL and a file system encode differently (keyProblem), or it
 *                ends in a suffix the rules read as a format (SUFFIXES). `suffix` is set for the last.
 */
export function servable(sc, part, iri) {
  if (typeof iri !== 'string' || !iri.startsWith(sc.base)) return { problem: 'outside', why: `is not under ${sc.base}` };
  const pre = sc.base + part + '/';
  if (!iri.startsWith(pre)) return { problem: 'elsewhere', why: `is not under ${pre}` };
  const rest = iri.slice(pre.length).split('#')[0];
  if (rest.includes('/')) return { problem: 'key', why: 'has more than one part' };
  const why = keyProblem(rest);
  if (why) return { problem: 'key', why };
  if (SUFFIX.test(rest)) return { problem: 'key', why: SUFFIX_PROBLEM, suffix: true };
  return { key: rest };
}

/**
 * servable() across a whole dataset: each address is judged once (a repeat, or the same address with
 * another fragment, comes back with seen: true, so a part counts it once), and two keys that differ
 * only in case collide ({ problem: 'case', other }, `other` the address met first), since they are one
 * file on macOS and Windows. Holds one entry per address met, which is small beside a site's files.
 */
export function servability(sc) {
  const guard = caseGuard();
  const met = new Map();
  return {
    check(part, iri) {
      const addr = typeof iri === 'string' ? iri.split('#')[0] : null;
      const memo = part + ' ' + addr;
      const had = addr !== null && met.get(memo);
      if (had) return { ...had, seen: true };
      let r = servable(sc, part, iri);
      if (r.key) {
        const other = guard.add(part, r.key);
        if (other) r = { problem: 'case', other: sc.base + part + '/' + other, why: 'differs only in capital letters from another address' };
      }
      if (addr !== null) met.set(memo, r);
      return r;
    },
  };
}

/** How one address's problem is named in a finding's example, in every part alike. */
export function unservableExample(iri, r) {
  const addr = typeof iri === 'string' ? iri.split('#')[0] : String(iri);
  if (r.problem === 'case') return `${r.other} and ${addr}: they differ only in capital letters`;
  if (r.problem === 'key') return `${addr}: its last part ${r.why}`;
  return addr;
}

/**
 * Every source an attestation names, as it names it (an address, or an object describing it): among
 * its sources, as the source of each citation, and what each of those is derived from, however deep
 * (to a limit, against a loop). The report, the site and the w3id rules all find sources this way.
 */
export function* sourcesOf(att) {
  if (!att || typeof att !== 'object') return;
  function* walk(s, depth) {
    if (!s || depth > 20) return;
    yield s;
    if (typeof s === 'object') for (const d of [].concat(s.derivedFrom || [])) yield* walk(d, depth + 1);
  }
  for (const s of [].concat(att.sources || [])) yield* walk(s, 0);
  for (const c of [].concat(att.citations || [])) if (c && typeof c === 'object') yield* walk(c.source, 0);
}
