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

// What a path segment may be for a site on GitHub Pages: characters that need no encoding in a URL
// or a file name on any system. Anything else (a space, '/', '%', a non-Latin letter) is encoded one
// way in the address and another by the server or the unzip, so a page would not be found.
const SAFE = /^[A-Za-z0-9._~-]+$/;
// Release names: the same, and not starting with '.', which a server may hide.
const SAFE_RELEASE = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;

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
  const local = (part, iri) => {
    if (typeof iri !== 'string') return null;
    const pre = b + part + '/';
    if (!iri.startsWith(pre)) return null;
    const rest = iri.slice(pre.length).split('#')[0];
    return rest && !rest.includes('/') ? rest : null;
  };
  return {
    base: b,
    kind,
    // For a w3id base, the path under w3id.org without its slashes at either end: the folder
    // ids/<w3idPath>/ holds the rules for the top name, and a deeper path is a sub-namespace in it.
    w3idPath: kind === 'w3id' ? u.pathname.replace(/^\/|\/$/g, '') : null,
    host: u.host,
    /** The dataset's own address: the base itself. */
    dataset: b,
    place: (id) => b + 'place/' + encodeURIComponent(id),
    source: (id) => b + 'source/' + encodeURIComponent(id),
    release: (name) => b + 'release/' + name,
    download: (file) => b + 'download/' + file,
    /** The last part of a place's or source's address, as written in it (so still encoded); null if the address is not under this base in that part. */
    placeKey: (iri) => local('place', iri),
    sourceKey: (iri) => local('source', iri),
    /** The address of an attestation of a place: a fragment of the place's address. */
    attestation: (placeIri, hash) => placeIri.split('#')[0] + '#a-' + hash,
    /** Where the site keeps a place's or source's files; the key is the last part of its address, as placeKey gives it. */
    files: (part, key) => ({ html: `${part}/${key}/index.html`, jsonld: `${part}/${key}.jsonld`, ttl: `${part}/${key}.ttl`, dir: `${part}/${key}/` }),
  };
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
